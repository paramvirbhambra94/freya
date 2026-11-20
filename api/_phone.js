// Phone awareness (Part 1): daily usage/activity/notification summaries from the Android app.
// Metadata only (apps, minutes, counts, steps). No message text is ever stored.
const { db, getProfile, setProfile, clip, london } = require('./_db');
const { getSchedule, toMin } = require('./_prayer');

const int = (v, max = 1e7) => { const n = Math.round(+v); return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0; };
const apps = (a, n = 15) => (Array.isArray(a) ? a : []).slice(0, n).map(x => ({
  app: clip(x.app, 120), label: clip(x.label, 60), min: int(x.min, 1440), sessions: int(x.sessions, 5000), work: !!x.work,
  cats: x.cats && typeof x.cats === 'object' ? Object.fromEntries(Object.entries(x.cats).slice(0, 8).map(([k, v]) => [clip(k, 20), int(v, 1e5)])) : undefined,
  n: x.n != null ? int(x.n, 1e5) : undefined, clicks: x.clicks != null ? int(x.clicks, 1e5) : undefined, avg_resp_s: x.avg_resp_s != null ? int(x.avg_resp_s, 864e3) : undefined
}));

async function upload(b) {
  const days = (Array.isArray(b.days) ? b.days : []).slice(0, 3).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.day || ''));
  if (days.length) {
    for (const row of days.map(d => ({
      day: d.day, screen_min: int(d.screen_min, 1440), unlocks: int(d.unlocks, 5000), late_min: int(d.late_min, 1440),
      steps: d.steps == null ? null : int(d.steps, 2e5), sedentary_max_min: d.sedentary_max_min == null ? null : int(d.sedentary_max_min, 1440),
      notif_count: int(d.notif_count, 1e5), top_apps: apps(d.top_apps), notif_by_app: apps(d.notif_by_app),
      longest_session: d.longest_session ? { label: clip(d.longest_session.label, 60), min: int(d.longest_session.min, 1440) } : null,
      hourly: Array.isArray(d.hourly) && d.hourly.length === 24 ? d.hourly.map(v => int(v, 60)) : null,
      final: !!d.final, updated_at: new Date().toISOString()
    }))) {
      // Only send what the phone actually measured, so a missing reading never wipes a stored one.
      for (const k of ['steps', 'sedentary_max_min', 'longest_session', 'hourly']) if (row[k] == null) delete row[k];
      const d0 = days.find(x => x.day === row.day);
      if (d0.screen_min == null) { delete row.screen_min; delete row.unlocks; delete row.late_min; delete row.top_apps; }
      if (d0.notif_count == null) { delete row.notif_count; delete row.notif_by_app; }
      await db('phone_days?on_conflict=day', { method: 'POST', prefer: 'resolution=merge-duplicates', body: row });
    }
  }
  const ev = (Array.isArray(b.events) ? b.events : []).slice(0, 50).map(e => ({
    at: new Date(+e.at || Date.now()).toISOString(), kind: clip(e.kind, 30), rule: clip(e.rule, 30) || null, app: clip(e.app, 120) || null,
    detail: e.detail && typeof e.detail === 'object' ? JSON.parse(clip(JSON.stringify(e.detail), 500) || '{}') : null
  })).filter(e => e.kind);
  if (ev.length) await db('phone_events', { method: 'POST', body: ev }).catch(() => {});
  return { ok: true, quiet: await quietWindows().catch(() => []) };
}

// Times the phone must not nudge: salah windows (adhan -> iqamah + buffer, Jumu'ah), manual stand-down, meetings. Next ~30h.
async function quietWindows() {
  const profile = await getProfile();
  const s = await getSchedule(profile);
  const out = [];
  const base = Date.parse(s.now.date + 'T00:00:00Z'); // UK midnight in UTC terms, corrected below
  const offset = (() => { const d = new Date(); const uk = london(d); return (uk.min - (d.getUTCHours() * 60 + d.getUTCMinutes()) + 1440 * 2) % 1440; })(); // 0 or 60
  const at = (dayIdx, m) => new Date(base + (dayIdx * 1440 + m - (offset > 720 ? offset - 1440 : offset)) * 60e3).toISOString();
  const after = +(profile.private_after_iqamah_min || 15);
  [s.today, s.tomorrow].forEach((d, i) => {
    if (!d) return;
    for (const [n, p] of Object.entries(d.prayers)) {
      const a = toMin(p.adhan), q = p.iqamah ? toMin(p.iqamah) : a + 10;
      const end = (n === 'dhuhr' && d.jumuah && d.jumuah.length) ? toMin(d.jumuah[d.jumuah.length - 1]) + 30 : q + after;
      out.push({ from: at(i, a), to: at(i, end), why: 'salah' });
    }
  });
  if (profile.private_until && new Date(profile.private_until) > new Date()) out.push({ from: new Date().toISOString(), to: profile.private_until, why: 'private' });
  if (profile.google_status === 'connected') {
    const now = new Date().toISOString(), soon = new Date(Date.now() + 30 * 36e5).toISOString();
    const ev = await db(`calendar_events?select=start_at,end_at&all_day=eq.false&busy=eq.true&end_at=gt.${now}&start_at=lt.${soon}&order=start_at.asc&limit=30`).catch(() => []);
    ev.forEach(e => out.push({ from: e.start_at, to: e.end_at, why: 'meeting' }));
  }
  return out;
}

const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

// Baselines + patterns. Patterns follow the "get to know him gradually" rule: one candidate at a time, as a question.
async function view(profile) {
  profile = profile || await getProfile();
  const rows = await db('phone_days?select=*&order=day.desc&limit=28');
  if (!rows.length) return null;
  const today = london().date;
  const full = rows.filter(r => r.day !== today);
  const last7 = full.slice(0, 7);
  const appMin = {};
  full.slice(0, 14).forEach(r => (r.top_apps || []).forEach(a => { if (!a.work) { const k = a.label || a.app; appMin[k] = (appMin[k] || 0) + a.min; } }));
  const days14 = Math.min(14, full.length) || 1;
  const sinks = Object.entries(appMin).map(([k, v]) => ({ app: k, avg_min: Math.round(v / days14) })).sort((a, b) => b.avg_min - a.avg_min).slice(0, 3);
  const stepDays = last7.filter(r => r.steps != null && r.steps > 0);
  const base = {
    data_days: full.length,
    avg_screen_min: last7.length ? Math.round(avg(last7.map(r => r.screen_min))) : null,
    avg_unlocks: last7.length ? Math.round(avg(last7.map(r => r.unlocks))) : null,
    late_nights_last7: last7.filter(r => r.late_min >= 20).length,
    avg_steps: stepDays.length ? Math.round(avg(stepDays.map(r => r.steps))) : null,
    long_sits_last7: last7.filter(r => (r.sedentary_max_min || 0) >= 150).length,
    time_sinks: sinks
  };
  const pats = [];
  if (full.length >= 7) {
    if (base.late_nights_last7 >= 3) pats.push({ id: 'late_scroll', say: `He seems to be on his phone after midnight most nights (${base.late_nights_last7} of the last 7). Ask whether late-night scrolling is affecting his Fajr or sleep.` });
    sinks.filter(s => s.avg_min >= 60).slice(0, 2).forEach(s => pats.push({ id: 'sink_' + s.app.toLowerCase().replace(/[^a-z0-9]+/g, '_'), say: `${s.app} takes about ${Math.round(s.avg_min / 6) / 10} hours of his day on average. Ask whether that feels like time well spent.` }));
    if (base.avg_steps != null && stepDays.length >= 5 && base.avg_steps < 5000) pats.push({ id: 'low_steps', say: `He averages roughly ${Math.round(base.avg_steps / 500) * 500} steps a day. Ask if he'd like a small daily walking target.` });
    if (base.long_sits_last7 >= 3) pats.push({ id: 'long_sits', say: `He often sits still for 2.5+ hours in the daytime (${base.long_sits_last7} of the last 7 days). Ask whether short movement breaks would help.` });
  }
  let known = []; try { known = JSON.parse(profile.phone_known || '[]'); } catch (e) {}
  const lastRaise = profile.phone_last_raise ? Date.parse(profile.phone_last_raise) : 0;
  const fresh = pats.filter(p => !known.some(k => k.id === p.id));
  const candidate = profile.onboarding_status === 'complete' && Date.now() - lastRaise > 3 * 864e5 ? fresh[0] || null : null;
  const t = rows[0].day === today ? rows[0] : null;
  return { baseline: base, today: t ? summary(t) : null, yesterday: full[0] ? summary(full[0]) : null, known, candidate };
}
function summary(r) {
  return { day: r.day, screen_min: r.screen_min, unlocks: r.unlocks, late_min: r.late_min, steps: r.steps, longest_sit_min: r.sedentary_max_min,
    notifications: r.notif_count, top_apps: (r.top_apps || []).slice(0, 5).map(a => `${a.label || a.app}${a.work ? ' (work)' : ''} ${a.min}m`),
    noisiest: (r.notif_by_app || []).slice(0, 3).map(a => `${a.label || a.app} ${a.n}`), longest_session: r.longest_session };
}
async function week() {
  const rows = await db('phone_days?select=*&order=day.desc&limit=15');
  const today = london().date;
  const full = rows.filter(r => r.day !== today);
  const a = full.slice(0, 7), b = full.slice(7, 14);
  const agg = xs => xs.length ? { days: xs.length, avg_screen_min: Math.round(avg(xs.map(r => r.screen_min))), avg_steps: (s => s.length ? Math.round(avg(s)) : null)(xs.filter(r => r.steps).map(r => r.steps)), late_nights: xs.filter(r => r.late_min >= 20).length, long_sits: xs.filter(r => (r.sedentary_max_min || 0) >= 150).length } : null;
  const ev = await db(`phone_events?select=kind,rule&at=gte.${new Date(Date.now() - 7 * 864e5).toISOString()}`).catch(() => []);
  const nudges = ev.filter(e => e.kind === 'nudge').length, ignored = ev.filter(e => e.kind === 'nudge_not_now' || e.kind === 'nudge_work').length;
  return { this_week: agg(a), last_week: agg(b), nudges_sent: nudges, nudges_pushed_back: ignored, best_day: a.slice().sort((x, y) => x.screen_min - y.screen_min)[0]?.day || null };
}
async function note(id, answer) {
  const profile = await getProfile();
  let known = []; try { known = JSON.parse(profile.phone_known || '[]'); } catch (e) {}
  const v = await view(profile).catch(() => null);
  const say = v && v.candidate && v.candidate.id === id ? v.candidate.say : clip(id, 60);
  known = known.filter(k => k.id !== id).concat({ id: clip(id, 60), say: clip(say, 200), his_answer: clip(answer, 200) }).slice(-20);
  await setProfile('phone_known', JSON.stringify(known));
  await setProfile('phone_last_raise', new Date().toISOString());
  return { ok: true };
}
module.exports = { upload, view, week, note, quietWindows };
