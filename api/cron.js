// Called every 5 minutes by Supabase pg_cron (pg_net) with a shared secret. Sends prayer nudges, check-ins and the morning brief.
const crypto = require('crypto');
const { db, configured, getSecret } = require('./_db');
const { lifeState, sendPush, DONE } = require('./_life');
const { toMin, NAMES } = require('./_prayer');
const G = require('./_google');
const M = require('./_money');
const PL = require('./_patterns');
const SEC = require('./_sections');
const CV = require('./_convo');
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
  // Every-minute poke while a growth section is building (pg_cron job freya-sections-build): sections only.
  if (req.query && req.query.only === 'sections') { try { return res.status(200).json({ ok: true, sections: await SEC.tick(claim) }); } catch (e) { return res.status(500).json({ error: 'sections failed' }); } }
  // Connect-speed probe (no data returned): how long building her session context takes, phase by phase.
  if (req.query && req.query.only === 'timing') { const T = {}, t0 = Date.now(); const tk = require('./token'); const ctx = await tk.loadContext(T); T.total = Date.now() - t0; const t1 = Date.now(); const p = tk.persona({ ...ctx, mode: 'companion' }); T.persona_ms = Date.now() - t1; T.persona_chars = p.length; T.region = process.env.VERCEL_REGION || null; return res.status(200).json({ ok: true, timing: T }); }
  if (req.query && req.query.only === 'convo') { try { return res.status(200).json({ ok: true, convo: await CV.digest({ limit: 2, quietMin: +req.query.quiet >= 0 ? +req.query.quiet : 10 }) }); } catch (e) { return res.status(500).json({ error: 'convo failed' }); } }
  // Money first: it is time-boxed by Lunch Flow, and running it after the section builds was overrunning the 60 s budget.
  let money = null;
  if (M.configured()) { try { money = await M.sync(); } catch (e) { money = { error: 'sync_failed' }; } }
  let sections = null;
  try { const t = new Date(); const lw = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(t); const wd = lw.find(p => p.type === 'weekday').value, hr = +lw.find(p => p.type === 'hour').value;
    sections = await SEC.tick(claim, { weeklyNow: wd === 'Mon' && hr >= 4 }); } catch (e) { sections = { error: true }; }
  // Conversation memory: digest one quiet conversation per tick (facts + rolling summary), prune old turns daily.
  let convo = null;
  try { convo = await CV.digest({ limit: 1 }); await CV.prune(claim); } catch (e) { convo = 'error'; }
  try {
    const s = await lifeState();
    // Google: refresh calendar cache, then handle finished meetings (Meet notes -> memory, debrief offers)
    const meet = [];
    if (s.google.connected) {
      try { await G.syncCalendar(); meet.push('calendar'); } catch (e) { meet.push('calendar_failed'); }
      try { meet.push(...await afterMeetings(s)); } catch (e) { meet.push('meetings_failed'); }
    }
    // Money: Lunch Flow sync at most every 6 hours (sync() decides).
    // Pattern learning: daily signals (calendar load, habits, prayers) and the weekly re-learn (Monday from 04:00 UK).
    let learn = null;
    if (M.configured() && !(money && money.new_tx != null)) {
      const lt = require('./_db').london();
      if (lt.min % 30 < 5) await PL.recordSignals(s);
      if ((lt.weekday === 'Mon' && lt.min >= 240) || !s.profile.money_learned_week) { try { learn = await PL.weekly(); } catch (e) { learn = { error: 'learn_failed' }; } }
    }
    const subs = await db('push_subscriptions?select=endpoint');
    if (!subs.length || !s.schedule) return res.status(200).json({ ok: true, google: meet, money, learn: learn && (learn.error || learn.skipped || 'ok'), skipped: !subs.length ? 'no subscriptions' : 'no schedule' });
    const now = s.schedule.now, today = s.schedule.today, manual = !!s.private.manualUntil;
    const prayerHabit = n => s.habits.find(h => h.kind === 'prayer' && h.name.toLowerCase() === n);
    const salahNow = !!s.salahMode; // praying in front of the camera: nothing may buzz him
    const send = async (key, msg) => { if (salahNow) { out.push('held:' + key); return; } if (msg.url === '/' && /\?\s*$/.test(msg.body || '')) msg = { ...msg, url: '/?ask=' + encodeURIComponent(String(msg.body).slice(0, 300)) }; if (await claim(key)) { const n = await sendPush(msg); if (!n) await unclaim(key); else out.push(key); } };

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
        await send(`checkin:${now.date}:${n}`, { title: `${label(n)}?`, body: `Did you pray ${label(n)}? Open Freya to show me (pray with me on camera, or a masjid photo).`, priority: 'low', url: `/?log=${n}`, tag: 'checkin-' + n });
      }
    }
    // Morning brief
    if (!s.private.on && now.min >= toMin(s.briefTime) && now.min < 12 * 60) {
      await send(`brief:${now.date}`, { title: 'Morning, Eesah', body: "Your day's ready. Open me and I'll walk you through it.", priority: 'high', url: '/?brief=1', tag: 'brief' });
    }
    // Housekeeping: old dedupe keys
    if (now.min < 10) await db(`notifications_sent?sent_at=lt.${new Date(Date.now() - 7 * 864e5).toISOString()}`, { method: 'DELETE' });
    // NEURO learning window: a short evening check-in, only if he switched it on (Learning settings).
    try {
      const NE = require('./_neuro'), L = NE.learning(s.profile), cm = toMin(L.checkin_time);
      if (L.checkins && !s.private.on && now.min >= cm && now.min < cm + 60) await send(`checkin:${now.date}`, { title: 'Two minutes, Eesah?', body: 'Quick check-in: energy, mood, one win, one thing on your mind.', priority: 'low', url: '/?checkin=1', tag: 'checkin' });
    } catch (e) { out.push('checkin_failed'); }
    // Meeting debrief offers (quiet, low priority)
    for (const ev of pendingDebriefs) {
      if (s.private.on) break;
      await send(`debrief:${ev.id}`, { title: ev.summary, body: ev.notes ? 'Meeting notes saved. Want a quick debrief?' : 'How did it go? Tap for a two-minute debrief.', priority: 'low', url: `/?debrief=${encodeURIComponent(ev.id)}`, tag: 'debrief' });
      if (out.includes(`debrief:${ev.id}`)) await db(`calendar_events?id=eq.${encodeURIComponent(ev.id)}`, { method: 'PATCH', body: { debrief_status: 'offered' } });
    }
    // Money alerts: checked every 30 minutes. High: low balance / bill risk / reconnect / consent renewal. Low: Sunday-evening weekly summary.
    if (M.configured() && (now.min % 30 < 5 || (money && money.new_tx != null))) {
      try {
        const d = await M.load(), a = M.analyse(d);
        const daytime = now.min >= 8 * 60 && now.min < 21 * 60; // never buzz him about money at night
        if (d.accounts.length && !s.private.on && daytime) {
          const bucket = k => k === 'low_balance' ? 'b' + Math.floor(Date.parse(now.date) / (3 * 864e5)) : now.date; // low balance: at most every 3 days
          for (const i of a.insights.filter(i => i.level === 'high')) await send(`money:${i.kind}:${bucket(i.kind)}`, { title: i.kind === 'reconnect' ? 'Bank link needs you' : 'Money heads-up', body: i.text, priority: 'high', url: '/?money=1', tag: 'money-' + i.kind });
          for (const r of a.renewals) if (r.status === 'ACTIVE' && r.days_left != null && r.days_left <= 7) await send(`money:renew:${r.connection_id}:${r.renew_by}:${r.days_left <= 1 ? 'last' : 'week'}`, { title: 'Renew bank access', body: `${r.institution} access in Lunch Flow runs out around ${r.renew_by}. Open Lunch Flow and tap reconnect (takes a minute).`, priority: 'high', url: '/?money=1', tag: 'money-renew' });
          // Drift watch vs the chosen best path: early, at most one a day, only once she's past onboarding.
          if (s.profile.onboarding_status === 'complete') { const dr = await PL.driftCheck(d).catch(() => null); if (dr && dr.drifting) await send(`money:drift:${now.date}`, { title: 'Off the winning path', body: dr.text, priority: 'high', url: '/?money=1', tag: 'money-drift' }); }
          if (now.weekday === 'Sun' && now.min >= 18 * 60) {
            const w = M.spending(d, 'last_7_days'), top = w.by_category[0];
            await send(`money:week:${now.date}`, { title: 'Your week in money', body: `${M.gbp(w.total_spent)} spent this week${top ? `, most on ${top.category.toLowerCase()} (${M.gbp(top.spent)})` : ''}. Tap for the full picture.`, priority: 'low', url: '/?money=1', tag: 'money-week' });
          }
        }
      } catch (e) { out.push('money_alerts_failed'); }
    }
    return res.status(200).json({ ok: true, sent: out, sections, convo, google: meet, money, learn: learn && (learn.error || learn.skipped || 'ok') });
  } catch (e) { return res.status(500).json({ error: 'cron failed' }); }
};
