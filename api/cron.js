// Called every 5 minutes by Supabase pg_cron (pg_net) with a shared secret. Sends prayer nudges, check-ins and the morning brief.
const crypto = require('crypto');
const { db, configured, getSecret } = require('./_db');
const { lifeState, sendPush, DONE } = require('./_life');
const { toMin, NAMES } = require('./_prayer');
const G = require('./_google');
const label = n => n[0].toUpperCase() + n.slice(1);

async function claim(key) {
  const r = await db('notifications_sent?on_conflict=key', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation', body: { key } });
  return Array.isArray(r) && r.length > 0;
}
const unclaim = key => db(`notifications_sent?key=eq.${encodeURIComponent(key)}`, { method: 'DELETE' });

let pendingDebriefs = [];
// Finished meetings in the last 4 hours: read Meet notes/transcripts into memory, queue debrief offers.
async function afterMeetings(s) {
  pendingDebriefs = [];
  const done = [], now = Date.now();
  const evs = await db(`calendar_events?select=id,summary,start_at,end_at,meet_link,attendees,attachments,notes_status,debrief_status&all_day=eq.false&busy=eq.true&end_at=lte.${new Date(now).toISOString()}&end_at=gte.${new Date(now - 4 * 36e5).toISOString()}`);
  for (const ev of evs) {
    if (!(ev.attendees > 0 || ev.meet_link)) continue;
    if (ev.meet_link && !ev.notes_status) {
      let fileId = null; try { fileId = await G.findMeetingNotes(ev); } catch (e) {}
      if (fileId) {
        try {
          const f = await G.readFile(fileId, 40000);
          const sum = await G.summariseNotes(ev.summary, f.text);
          const line = `Meeting "${ev.summary}" (${G.ukDay(ev.start_at)}): ${sum.summary}` + (sum.decisions.length ? ` Decisions: ${sum.decisions.join('; ')}.` : '') + (sum.follow_ups.length ? ` Follow-ups: ${sum.follow_ups.join('; ')}.` : '');
          await db('meeting_notes?on_conflict=event_id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { event_id: ev.id, title: ev.summary, summary: line.slice(0, 4000), source_file: f.name } });
          await db('memories', { method: 'POST', body: { category: 'work', content: line.slice(0, 2000), source: 'meeting_notes' } });
          await db(`calendar_events?id=eq.${encodeURIComponent(ev.id)}`, { method: 'PATCH', body: { notes_status: 'saved' } });
          ev.notes_status = 'saved'; done.push('notes:' + ev.id);
        } catch (e) { done.push('notes_failed'); }
      } else if (now - new Date(ev.end_at) > 2 * 36e5) {
        await db(`calendar_events?id=eq.${encodeURIComponent(ev.id)}`, { method: 'PATCH', body: { notes_status: 'none' } }); ev.notes_status = 'none';
      }
    }
    const ready = !ev.meet_link || ev.notes_status; // Meet calls wait for notes (up to 2h)
    if (!ev.debrief_status && ready && now - new Date(ev.end_at) > 5 * 6e4) pendingDebriefs.push({ id: ev.id, summary: ev.summary, notes: ev.notes_status === 'saved' });
  }
  return done;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ error: 'not configured' });
  const given = String(req.headers['x-cron-secret'] || '');
  const want = await getSecret('cron_secret');
  if (given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return res.status(401).json({ error: 'locked' });
  const out = [];
  try {
    const s = await lifeState();
    // Google: refresh calendar cache, then handle finished meetings (Meet notes -> memory, debrief offers)
    const meet = [];
    if (s.google.connected) {
      try { await G.syncCalendar(); meet.push('calendar'); } catch (e) { meet.push('calendar_failed'); }
      try { meet.push(...await afterMeetings(s)); } catch (e) { meet.push('meetings_failed'); }
    }
    const subs = await db('push_subscriptions?select=endpoint');
    if (!subs.length || !s.schedule) return res.status(200).json({ ok: true, google: meet, skipped: !subs.length ? 'no subscriptions' : 'no schedule' });
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
    // Meeting debrief offers (quiet, low priority)
    for (const ev of pendingDebriefs) {
      if (s.private.on) break;
      await send(`debrief:${ev.id}`, { title: ev.summary, body: ev.notes ? 'Meeting notes saved. Want a quick debrief?' : 'How did it go? Tap for a two-minute debrief.', priority: 'low', url: `/?debrief=${encodeURIComponent(ev.id)}`, tag: 'debrief' });
      if (out.includes(`debrief:${ev.id}`)) await db(`calendar_events?id=eq.${encodeURIComponent(ev.id)}`, { method: 'PATCH', body: { debrief_status: 'offered' } });
    }
    return res.status(200).json({ ok: true, sent: out, google: meet });
  } catch (e) { return res.status(500).json({ error: 'cron failed' }); }
};
