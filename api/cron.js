// Called every 5 minutes by Supabase pg_cron (pg_net) with a shared secret. Sends prayer nudges, check-ins and the morning brief.
const crypto = require('crypto');
const { db, configured, getSecret } = require('./_db');
const { lifeState, sendPush, DONE } = require('./_life');
const { toMin, NAMES } = require('./_prayer');
const label = n => n[0].toUpperCase() + n.slice(1);

async function claim(key) {
  const r = await db('notifications_sent?on_conflict=key', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation', body: { key } });
  return Array.isArray(r) && r.length > 0;
}
const unclaim = key => db(`notifications_sent?key=eq.${encodeURIComponent(key)}`, { method: 'DELETE' });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ error: 'not configured' });
  const given = String(req.headers['x-cron-secret'] || '');
  const want = await getSecret('cron_secret');
  if (given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return res.status(401).json({ error: 'locked' });
  const out = [];
  try {
    const s = await lifeState();
    const subs = await db('push_subscriptions?select=endpoint');
    if (!subs.length || !s.schedule) return res.status(200).json({ ok: true, skipped: !subs.length ? 'no subscriptions' : 'no schedule' });
    const now = s.schedule.now, today = s.schedule.today, manual = !!s.private.manualUntil;
    const prayerHabit = n => s.habits.find(h => h.kind === 'prayer' && h.name.toLowerCase() === n);
    const send = async (key, msg) => { if (await claim(key)) { const n = await sendPush(msg); if (!n) await unclaim(key); else out.push(key); } };

    for (const [i, n] of NAMES.entries()) {
      const p = today.prayers[n], a = toMin(p.adhan), q = p.iqamah ? toMin(p.iqamah) : a + 10;
      const logged = DONE.includes((prayerHabit(n) || {}).today);
      const nextA = i < 4 ? toMin(today.prayers[NAMES[i + 1]].adhan) : 24 * 60;
      const isJumuah = n === 'dhuhr' && today.jumuah && today.jumuah.length;
      // Gentle nudge as the adhan goes, before jama'ah (never during). Not while he's told her to stand down.
      if (!manual && !logged && now.min >= a && now.min < q) {
        const body = isJumuah ? `Jumu'ah today at ${today.jumuah.join(' and ')}.` : (p.iqamah ? `Jama'ah at ${p.iqamah}. ${q - now.min} minutes.` : `${label(n)} time has started.`);
        await send(`nudge:${now.date}:${n}`, { title: isJumuah ? "Jumu'ah" : label(n), body, priority: 'high', url: '/', tag: 'prayer' });
      }
      // Quiet check-in after the prayer window, so streaks stay honest.
      if (!s.private.on && !logged && now.min >= q + 45 && now.min < nextA) {
        await send(`checkin:${now.date}:${n}`, { title: `${label(n)}?`, body: `Did you pray ${label(n)}? Tap to log it.`, priority: 'low', url: `/?log=${n}`, tag: 'checkin-' + n });
      }
    }
    // Morning brief
    if (!s.private.on && now.min >= toMin(s.briefTime) && now.min < 12 * 60) {
      await send(`brief:${now.date}`, { title: 'Morning, Eesah', body: "Your day's ready. Open me and I'll walk you through it.", priority: 'high', url: '/?brief=1', tag: 'brief' });
    }
    // Housekeeping: old dedupe keys
    if (now.min < 10) await db(`notifications_sent?sent_at=lt.${new Date(Date.now() - 7 * 864e5).toISOString()}`, { method: 'DELETE' });
    return res.status(200).json({ ok: true, sent: out });
  } catch (e) { return res.status(500).json({ error: 'cron failed' }); }
};
