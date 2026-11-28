// NEURO intelligence layer: daily priorities, cross-domain briefing, operating modes, Islamic Mode, learning consent,
// what Freya learned, futures (outcome simulation), Vault trajectory, trainer, communication coach, finance saver.
// Real data only: every item carries its evidence; when data is missing we say so instead of inventing it.
const { db, getProfile, setProfile, london, clip } = require('./_db');
const { lifeState, dayStr, DONE } = require('./_life');

const jp = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const gen = (...a) => require('./_sections').gen(...a);
const S = d => ({ type: 'STRING', description: d });
const ARR = (items, d) => ({ type: 'ARRAY', items, description: d });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required: required || Object.keys(properties) });
const LMH = d => ({ type: 'STRING', enum: ['low', 'medium', 'high'], description: d });
const r1 = n => Math.round(n * 10) / 10;

// ---------------- Preferences: Islamic Mode, learning windows, mode ----------------
const MODES = ['available', 'focus', 'private', 'salah', 'standby', 'emergency', 'sleep'];
const LEARN_DEFAULT = { conversations: false, checkins: false, checkin_time: '21:00', sleep: false };

// The owner already uses deen features: until he explicitly chooses, Islamic Mode stays ON for him (never silently disabled).
// A general user with no deen setup defaults to OFF.
function islamicOn(p) { return p.neuro_islamic_mode != null ? p.neuro_islamic_mode === 'true' : !!(p.mosque_slug || p.mosque_name); }
function modeOf(p) {
  const m = jp(p.neuro_mode, null);
  if (m && MODES.includes(m.mode) && (!m.until || new Date(m.until) > new Date())) return m;
  return { mode: 'available', until: null };
}
function learning(p) { return { ...LEARN_DEFAULT, ...jp(p.neuro_learning, {}) }; }

async function preferences() {
  const p = await getProfile();
  return { islamicMode: islamicOn(p), configured: p.neuro_islamic_mode != null, learning: learning(p), mode: modeOf(p), guest: guestState(p) };
}

async function setLearning(b) {
  const p = await getProfile(), cur = learning(p), next = { ...cur };
  for (const k of ['conversations', 'checkins', 'sleep']) if (typeof b[k] === 'boolean') next[k] = b[k];
  if (typeof b.checkin_time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.checkin_time)) next.checkin_time = b.checkin_time;
  await setProfile('neuro_learning', JSON.stringify(next));
  return { ok: true, learning: next };
}

async function setMode(b) {
  const mode = String(b.mode || '');
  if (!MODES.includes(mode)) return { ok: false, error: 'Unknown mode' };
  const mins = Math.max(5, Math.min(720, +b.minutes || (mode === 'sleep' ? 480 : mode === 'focus' ? 90 : 60)));
  const until = mode === 'available' ? null : new Date(Date.now() + mins * 60e3).toISOString();
  await setProfile('neuro_mode', JSON.stringify({ mode, until, set_at: new Date().toISOString() }));
  // Private keeps using the existing private-mode machinery (prompt + nudges already respect it).
  const { setPrivate } = require('./_life');
  if (mode === 'private') await setPrivate(true, mins);
  else if (mode === 'available') { const p = await getProfile(); if (p.private_until && new Date(p.private_until) > new Date()) await setPrivate(false); }
  const out = { ok: true, mode, until };
  if (mode === 'emergency') out.contacts = await db('emergency_contacts?select=name,phone,relation&order=id.asc').catch(() => []);
  return out;
}
// Used by push: which notifications may get through right now.
function holdsPush(p, priority) {
  const m = modeOf(p).mode;
  if (priority === 'critical') return false;
  return ['focus', 'sleep', 'standby'].includes(m); // private/salah keep their existing rules
}

// ---------------- Guest session (owner-granted) ----------------
function guestState(p) { const g = jp(p.neuro_guest, null); return g && new Date(g.until) > new Date() ? g : null; }
async function setGuest(b) {
  if (!b.on) { await setProfile('neuro_guest', ''); return { ok: true, guest: null }; }
  const mins = Math.max(5, Math.min(60, +b.minutes || 15));
  const g = { name: clip(String(b.name || 'a guest'), 40), until: new Date(Date.now() + mins * 60e3).toISOString() };
  await setProfile('neuro_guest', JSON.stringify(g));
  return { ok: true, guest: g };
}

// ---------------- Daily priorities (row per priority: no read-modify-write races, history kept) ----------------
async function migrateLegacyGoals(p, date) {
  const legacy = jp(p.neuro_goals, []);
  if (!Array.isArray(legacy) || !legacy.length) return;
  const rows = legacy.filter(g => g && g.title && g.date).map(g => ({ day: g.date, title: String(g.title).slice(0, 180), done: !!g.done }));
  if (rows.length) await db('neuro_priorities', { method: 'POST', body: rows });
  await setProfile('neuro_goals', ''); // moved, not lost
}
async function priorities(day) {
  return db(`neuro_priorities?select=id,day,title,done,updated_at&day=eq.${day}&order=id.asc`);
}
async function goal(b) {
  const date = london().date;
  if (b.id) {
    const id = +b.id; if (!id) return { ok: false, error: 'bad id' };
    if (b.remove) { await db(`neuro_priorities?id=eq.${id}`, { method: 'DELETE' }); return { ok: true, goals: await priorities(date) }; }
    const patch = { updated_at: new Date().toISOString() };
    if (typeof b.done === 'boolean') patch.done = b.done; // done or reopen
    if (typeof b.title === 'string' && b.title.trim()) patch.title = b.title.trim().slice(0, 180);
    await db(`neuro_priorities?id=eq.${id}`, { method: 'PATCH', body: patch });
    return { ok: true, goals: await priorities(date) };
  }
  const title = String(b.title || '').trim().slice(0, 180);
  if (!title) return { ok: false, error: 'Enter a priority' };
  const cur = await priorities(date);
  if (b.done === true) { const g = cur.find(x => x.title === title); if (!g) return { ok: false, error: 'Priority not found' }; return goal({ id: g.id, done: true }); }
  if (cur.some(x => x.title === title)) return { ok: true, goals: cur };
  if (cur.length >= 5) return { ok: false, error: 'Maximum five daily priorities' };
  await db('neuro_priorities', { method: 'POST', body: { day: date, title } });
  return { ok: true, goals: await priorities(date) };
}

async function daily() {
  const s = await lifeState(), p = s.profile, date = london().date;
  await migrateLegacyGoals(p, date).catch(() => {});
  const [goals, recent] = await Promise.all([priorities(date), db(`neuro_priorities?select=day,title,done&day=gte.${dayStr(date, -6)}&day=lt.${date}&order=day.desc`).catch(() => [])]);
  const habits = s.habits.filter(h => h.kind !== 'prayer' || islamicOn(p));
  return {
    date, private: !!s.private.on, mode: modeOf(p),
    goals: goals.map(g => ({ id: g.id, title: g.title, done: g.done, date })),
    history: recent,
    habits: habits.map(h => ({ name: h.name, today: h.today, streak: h.streak })),
    insights: s.private.on ? [] : habits.filter(h => !h.today && h.streak >= 3).slice(0, 3).map(h => ({ text: 'Protect your ' + h.name + ' streak today.', evidence: h.streak + ' consecutive logged days', source: 'habit records' }))
  };
}

// ---------------- Cross-domain briefing ----------------
async function briefing() {
  const s = await lifeState(), p = s.profile, date = london().date, isl = islamicOn(p), mode = modeOf(p);
  if (s.private.on || mode.mode === 'private') return { date, private: true, items: [], links: [], mode };
  const items = [], links = [];
  const add = (domain, text, evidence, level = 'info') => items.push({ domain, text, evidence, level });
  if (isl && s.schedule && s.schedule.next) {
    const n = s.schedule.next, done = s.habits.filter(h => h.kind === 'prayer' && DONE.includes(h.today)).length;
    add('deen', `Next: ${n.prayer[0].toUpperCase() + n.prayer.slice(1)} ${n.iqamah ? 'jama\'ah ' + n.iqamah : n.adhan} (${n.day}).`, `${done}/5 prayers verified today · ${s.schedule.mosque || 'calculated times'}`);
  }
  const startOfDay = new Date(date + 'T00:00:00Z'), now = new Date();
  const evs = await db(`calendar_events?select=summary,start_at,end_at,all_day&busy=eq.true&start_at=gte.${new Date(startOfDay - 36e5).toISOString()}&start_at=lt.${new Date(+startOfDay + 30 * 36e5).toISOString()}&order=start_at.asc&limit=20`).catch(() => []);
  const upcoming = evs.filter(e => new Date(e.end_at) > now);
  if (upcoming.length) add('work', `${upcoming.length} commitment${upcoming.length > 1 ? 's' : ''} left today; next "${upcoming[0].summary}" at ${new Date(upcoming[0].start_at).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })}.`, 'Google Calendar');
  else if (s.google.connected) add('work', 'Nothing else on your calendar today.', 'Google Calendar');
  let money = null;
  try { const M = require('./_money'); if (M.configured()) { money = await M.summary(); } } catch (e) { money = null; }
  if (money && money.balances) {
    const due = (money.upcoming || []).filter(u => u.due && u.due <= dayStr(date, 3));
    const pace = money.this_month && money.this_month.usual_spend_to_date ? money.this_month.spent - money.this_month.usual_spend_to_date : null;
    add('finance', due.length ? `${due.length} bill${due.length > 1 ? 's' : ''} due within 3 days (${due.slice(0, 3).map(u => u.name).join(', ')}).` : 'No bills due in the next 3 days.', `bank data as of ${money.as_of ? new Date(money.as_of).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'unknown'}`, due.length ? 'watch' : 'info');
    if (pace != null && Math.abs(pace) >= 25) add('finance', pace > 0 ? `Spending is £${Math.round(pace)} ahead of your usual pace this month.` : `Spending is £${Math.round(-pace)} under your usual pace this month.`, `usual spend to date £${Math.round(money.this_month.usual_spend_to_date)} vs £${Math.round(money.this_month.spent)}`, pace > 0 ? 'watch' : 'good');
  }
  const ph = await db(`phone_days?select=day,screen_min,late_min,steps&day=gte.${dayStr(date, -7)}&order=day.desc`).catch(() => []);
  const y = ph.find(d => d.day === dayStr(date, -1));
  if (y) {
    if (y.steps != null) add('physical', `Yesterday: ${y.steps.toLocaleString('en-GB')} steps.`, 'phone awareness');
    if (y.late_min != null && y.late_min >= 45) { add('mind', `${y.late_min} min on your phone late last night.`, 'phone awareness', 'watch'); if (upcoming.length >= 3) links.push({ text: 'Late screen time last night and a full day today: protect your focus blocks and keep replies short.', evidence: `${y.late_min} late minutes · ${upcoming.length} commitments` }); }
  }
  const sl = await db('neuro_sleep?select=started_at,ended_at,summary,tiredness&order=started_at.desc&limit=1').catch(() => []);
  if (sl[0] && sl[0].ended_at && new Date(sl[0].ended_at) > new Date(Date.now() - 18 * 36e5)) {
    const h = r1((new Date(sl[0].ended_at) - new Date(sl[0].started_at)) / 36e5), sm = sl[0].summary || {};
    add('physical', `Sleep Focus session: ${h}h recorded${sm.loud_events != null ? `, ${sm.loud_events} loud sound events` : ''}.`, 'Sleep Focus (session length, not proven sleep)');
    if (h < 6 && upcoming.length >= 2) links.push({ text: 'Short night before a busy day: take the hardest task first, keep caffeine before 2pm.', evidence: `${h}h session · ${upcoming.length} commitments` });
  }
  const habits = s.habits.filter(h => h.kind !== 'prayer');
  const at = habits.filter(h => !h.today && h.streak >= 3);
  if (at.length) add('mind', `Streak at risk: ${at.map(h => h.name).join(', ')}.`, at.map(h => `${h.name} ${h.streak} days`).join(' · '), 'watch');
  const pend = await db(`neuro_actions?select=id&status=eq.pending&expires_at=gt.${new Date().toISOString()}`).catch(() => []);
  if (pend.length) add('assistant', `${pend.length} action${pend.length > 1 ? 's' : ''} waiting for your approval.`, 'action ledger', 'watch');
  if (money && money.balances && money.this_month && money.this_month.usual_spend_to_date && money.this_month.spent > money.this_month.usual_spend_to_date * 1.2 && y && y.late_min >= 45)
    links.push({ text: 'Spending running hot and late nights: tired evenings are when impulse spends happen. Set a no-spend evening.', evidence: 'finance pace + phone late minutes' });
  return { date, private: false, mode, items, links, sources: { calendar: s.google.connected, bank: !!(money && money.balances), phone: ph.length > 0, sleep: sl.length > 0 } };
}

// ---------------- Worldwide salah times ----------------
function salahTimes(q) {
  const { calcTimes } = require('./_prayer');
  const lat = +q.lat, lng = +q.lng, tz = String(q.tz || 'UTC');
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 66 || Math.abs(lng) > 180) return { ok: false, error: 'Valid location needed (latitudes beyond 66° need a manual method).' };
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); } catch (e) { return { ok: false, error: 'Unknown time zone' }; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const t = calcTimes(+parts.year, +parts.month, +parts.day, lat, lng, tz);
  return { ok: true, date: `${parts.year}-${parts.month}-${parts.day}`, tz, lat: r1(lat), lng: r1(lng), times: t, method: 'calculated (astronomical, Hanafi Asr); your local masjid timetable may differ' };
}

// ---------------- What Freya learned ----------------
async function observations() {
  const rows = await db('neuro_observations?select=id,domain,text,evidence,confidence,source,status,created_at,updated_at&status=neq.dismissed&order=created_at.desc&limit=100');
  return { observations: rows };
}
async function observationEdit(b) {
  const id = +b.id; if (!id) return { ok: false, error: 'bad id' };
  if (b.remove) { await db(`neuro_observations?id=eq.${id}`, { method: 'DELETE' }); return { ok: true, removed: id }; }
  const text = clip(String(b.text || ''), 400).trim(); if (!text) return { ok: false, error: 'Empty' };
  await db(`neuro_observations?id=eq.${id}`, { method: 'PATCH', body: { text, status: 'corrected', confidence: 'high', source: 'corrected by you', updated_at: new Date().toISOString() } });
  return { ok: true };
}
const LEARN_SCHEMA = OBJ({ observations: ARR(OBJ({ domain: { type: 'STRING', enum: ['mood', 'stress', 'confidence', 'communication', 'sleep', 'self_worth', 'routine', 'other'] }, text: S('one specific, non-diagnostic observation about Eesah, phrased as a pattern, max 25 words'), evidence: S('the short quote or behaviour from HIS OWN words it rests on'), confidence: LMH('how well supported') }), 'max 3; empty if nothing is genuinely supported') });
// Called from the conversation digest ONLY when he switched on "learn from our conversations". His own words only, no raw audio exists.
async function learnFromTurns(turns, opts = {}) {
  const p = opts.profile || await getProfile();
  if (!learning(p).conversations) return 0;
  const mine = turns.filter(t => t.role === 'user' && t.mode !== 'guest' && String(t.text || '').length > 3);
  if (mine.length < 3) return 0;
  const known = await db('neuro_observations?select=text&order=created_at.desc&limit=60').catch(() => []);
  const r = await gen([{ text: `From Eesah's OWN words below (one side of conversations with his assistant), note at most 3 gentle, evidence-backed patterns about mood, stress, confidence, communication, sleep, self-worth or routine. Never diagnose (no "anxiety disorder", "depression"), never guess intentions, no other people's private details. Skip anything already known.\nALREADY KNOWN:\n${known.map(k => '- ' + k.text).join('\n')}\nHIS WORDS:\n${mine.map(t => '- ' + t.text).join('\n').slice(-12000)}` }], LEARN_SCHEMA, { models: ['gemini-flash-lite-latest', 'gemini-flash-latest'], temperature: 0.2 }).catch(() => null);
  let n = 0;
  for (const o of (r && r.observations || []).slice(0, 3)) {
    if (!o.text) continue;
    await db('neuro_observations', { method: 'POST', body: { domain: o.domain || 'other', text: clip(o.text, 300), evidence: clip(o.evidence || '', 300), confidence: ['low', 'medium', 'high'].includes(o.confidence) ? o.confidence : 'low', source: 'your conversations with Freya' } }).catch(() => {}); n++;
  }
  return n;
}
async function addObservation(b, source) {
  const text = clip(String(b.text || ''), 300).trim(); if (!text) return { ok: false };
  await db('neuro_observations', { method: 'POST', body: { domain: String(b.domain || 'other').slice(0, 30), text, evidence: clip(String(b.evidence || ''), 300), confidence: ['low', 'medium', 'high'].includes(b.confidence) ? b.confidence : 'low', source } });
  return { ok: true };
}

// ---------------- Sleep Focus (derived summaries only) ----------------
async function sleepSave(b) {
  const p = await getProfile();
  if (!learning(p).sleep) return { ok: false, error: 'Sleep Focus is switched off in Learning settings.' };
  const st = new Date(b.started_at), en = new Date(b.ended_at);
  if (!(st < en) || en - st > 16 * 36e5) return { ok: false, error: 'Bad session times' };
  const sm = b.summary || {}, num = (x, max) => Math.max(0, Math.min(max, Math.round(+x || 0)));
  const summary = { minutes: num((en - st) / 6e4, 960), loud_events: num(sm.loud_events, 5000), snore_like_min: num(sm.snore_like_min, 960), quiet_pct: num(sm.quiet_pct, 100), interrupted: !!sm.interrupted, note: 'Derived on your phone from sound levels. No audio was recorded or uploaded. Session length is not proven sleep; this is not a medical assessment.' };
  await db('neuro_sleep', { method: 'POST', body: { started_at: st.toISOString(), ended_at: en.toISOString(), summary, tiredness: b.tiredness != null ? num(b.tiredness, 10) : null } });
  return { ok: true, summary };
}
async function sleepList() { return { sessions: await db('neuro_sleep?select=id,started_at,ended_at,summary,tiredness&order=started_at.desc&limit=14') }; }
async function sleepDelete(id) { if (!/^[0-9a-f-]{36}$/.test(String(id))) return { ok: false }; await db(`neuro_sleep?id=eq.${id}`, { method: 'DELETE' }); return { ok: true }; }

// ---------------- Vault: improvement or downfall ----------------
async function trajectory() {
  const date = london().date, a0 = dayStr(date, -6), b0 = dayStr(date, -13), b1 = dayStr(date, -7);
  const p = await getProfile(), isl = islamicOn(p);
  const [habits, logs, ph, sleep] = await Promise.all([
    db('habits?select=id,name,kind&active=eq.true'),
    db(`habit_logs?select=habit_id,day,status,evidence&day=gte.${b0}`),
    db(`phone_days?select=day,screen_min,late_min,steps&day=gte.${b0}`).catch(() => []),
    db(`neuro_sleep?select=started_at,ended_at&started_at=gte.${b0}T00:00:00Z`).catch(() => [])
  ]);
  const good = [], bad = [], steady = [], stale = [];
  const cmp = (label, cur, prev, unit, higherBetter, evidence) => {
    if (cur == null || prev == null) return;
    const d = cur - prev, pct = prev ? Math.round(d / prev * 100) : null;
    const item = { label, now: r1(cur), before: r1(prev), unit, change: pct != null ? pct + '%' : (d > 0 ? '+' : '') + r1(d), evidence };
    if (Math.abs(d) < Math.max(0.05 * Math.abs(prev), 0.5)) steady.push(item);
    else ((d > 0) === higherBetter ? good : bad).push(item);
  };
  const inRange = (d, from, to) => d >= from && d <= to;
  const rate = (ids, from, to) => { const days = 7, done = logs.filter(l => ids.includes(l.habit_id) && inRange(l.day, from, to) && DONE.includes(l.status)).length; return ids.length ? done / (ids.length * days) * 100 : null; };
  const hab = habits.filter(h => h.kind !== 'prayer').map(h => h.id), pr = habits.filter(h => h.kind === 'prayer').map(h => h.id);
  if (hab.length) cmp('Habits kept', rate(hab, a0, date), rate(hab, b0, b1), '%', true, `${hab.length} habits, last 7 days vs the 7 before`);
  if (isl && pr.length) {
    const cnt = (f, t) => logs.filter(l => pr.includes(l.habit_id) && inRange(l.day, f, t) && DONE.includes(l.status)).length;
    cmp('Salah logged', cnt(a0, date), cnt(b0, b1), 'of 35', true, 'prayer tracker (verified logs count)');
  }
  const avg = (f, t, k) => { const v = ph.filter(d => inRange(d.day, f, t) && d[k] != null).map(d => d[k]); return v.length >= 3 ? v.reduce((x, y) => x + y, 0) / v.length : null; };
  cmp('Daily steps', avg(a0, date, 'steps'), avg(b0, b1, 'steps'), 'steps/day', true, 'phone awareness');
  cmp('Screen time', avg(a0, date, 'screen_min'), avg(b0, b1, 'screen_min'), 'min/day', false, 'phone awareness');
  cmp('Late-night phone', avg(a0, date, 'late_min'), avg(b0, b1, 'late_min'), 'min/night', false, 'phone awareness');
  try {
    const M = require('./_money');
    if (M.configured()) {
      const d = await M.load(3);
      const latest = d.txs.length ? d.txs[d.txs.length - 1].date : null;
      // If the bank feed hasn't delivered recent transactions, this week would look like near-zero spending: leave it out.
      if (!latest || latest < dayStr(date, -3)) { stale.push({ label: 'Spending', reason: latest ? 'bank data stops at ' + latest : 'no bank data yet' }); throw 0; }
      const s1 = M.spending(d, 'last_7_days'), prevTo = dayStr(date, -7), prev = d.txs.filter(t => t.date >= b0 && t.date <= prevTo && !t.is_transfer && t.amount < 0 && !M.NON_SPEND.includes(t.category)).reduce((s, t) => s - t.amount, 0);
      cmp('Spending', s1.total_spent, prev, '£/week', false, 'bank transactions (read-only)');
    }
  } catch (e) {}
  const sl = (f, t) => { const v = sleep.filter(x => x.ended_at && inRange(x.started_at.slice(0, 10), f, t)).map(x => (new Date(x.ended_at) - new Date(x.started_at)) / 36e5); return v.length >= 2 ? v.reduce((x, y) => x + y, 0) / v.length : null; };
  cmp('Sleep Focus session length', sl(a0, date), sl(b0, b1), 'h/night', true, 'Sleep Focus (session length, not proven sleep)');
  const total = good.length + bad.length + steady.length;
  const verdict = total < 2 ? 'Not enough data yet' : good.length > bad.length ? 'Improvement' : bad.length > good.length ? 'Downfall' : 'Holding steady';
  return { period: { now: `${a0} to ${date}`, before: `${b0} to ${b1}`, now_from: a0, now_to: date, before_from: b0, before_to: b1 }, verdict, score: good.length - bad.length, good, bad, steady, stale, measured: total, note: 'Compares your last 7 days with the 7 before, from your own records only. Missing sources are left out, not guessed.' };
}

// ---------------- Futures (Doctor Strange outcome simulation, evidence-based) ----------------
const FUT_SCHEMA = OBJ({
  framing: S('one line restating the decision'),
  routes: ARR(OBJ({
    name: S('short route name'), summary: S('what he would do, 1-2 sentences'),
    risk: LMH('downside risk'), reward: LMH('upside if it works'), likelihood: LMH('chance it works for HIM given the evidence'),
    upside: S('best realistic outcome'), downside: S('worst realistic outcome'), first_step: S('the first concrete step'),
    evidence: ARR(S('a fact taken ONLY from HIS DATA below'), '1-4 items; empty if none'),
    assumptions: ARR(S('assumption not proven by his data'), '1-3'),
    money: OBJ({ applies: { type: 'BOOLEAN' }, monthly_change: { type: 'NUMBER', description: '+ = extra money kept per month, - = extra cost; 0 if n/a' }, cuts: ARR(OBJ({ category: S('his spending category name exactly as listed'), percent: { type: 'NUMBER' } }), 'spending cuts; empty if none') }, ['applies', 'monthly_change', 'cuts'])
  }), '3-5 genuinely different routes, including the do-nothing route'),
  recommended: S('name of the route you recommend'), why: S('why, in 2 sentences, citing his evidence'),
  unknowns: ARR(S('what we do not know that matters'), '1-4'), would_change: S('what evidence would change the recommendation')
});
async function futures(b) {
  const question = clip(String(b.question || ''), 600).trim();
  if (question.length < 6) return { ok: false, error: 'Tell Freya the decision you are weighing.' };
  const s = await lifeState(), p = s.profile;
  const ctx = [];
  ctx.push('Habits: ' + s.habits.map(h => `${h.name} streak ${h.streak}, ${h.last7}/7 last week`).join('; '));
  let d = null, M = null;
  try { M = require('./_money'); if (M.configured()) { d = await M.load(); const a = M.analyse(d); ctx.push(`Money (read-only): balance £${Math.round(a.balances.total)}; usual monthly income £${Math.round(a.usual.monthly_income)}, spend £${Math.round(a.usual.monthly_spend)}, net £${Math.round(a.usual.monthly_net)}; categories: ${a.usual.by_category.slice(0, 10).map(c => `${c.category} £${Math.round(c.monthly)}/mo`).join(', ')}; bills soon: ${(a.upcoming || []).slice(0, 5).map(u => u.name + ' £' + Math.round(u.amount)).join(', ') || 'none'}${a.goal ? '; savings goal ' + a.goal.label : ''}.`); } } catch (e) { d = null; }
  const evs = await db(`calendar_events?select=summary,start_at&busy=eq.true&start_at=gte.${new Date().toISOString()}&order=start_at.asc&limit=12`).catch(() => []);
  if (evs.length) ctx.push('Upcoming calendar: ' + evs.map(e => `${new Date(e.start_at).toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric' })} ${e.summary}`).join('; '));
  const mems = await db('memories?select=category,content&order=created_at.desc&limit=40').catch(() => []);
  if (mems.length) ctx.push('What he has told Freya: ' + mems.map(m => `[${m.category}] ${m.content}`).join(' | ').slice(0, 5000));
  const obs = await db('neuro_observations?select=text,confidence&status=neq.dismissed&order=created_at.desc&limit=15').catch(() => []);
  if (obs.length) ctx.push('Observed patterns: ' + obs.map(o => `${o.text} (${o.confidence})`).join(' | '));
  if (p.life_plan) ctx.push('His life plan: ' + String(p.life_plan).slice(0, 2000));
  const r = await gen([{ text: `You are Freya's outcome simulation engine (the "Doctor Strange" view: look across possible futures, then pick the one route that wins). Be honest: this is scenario modelling, not prediction. Use ONLY the facts in HIS DATA as evidence; anything else is an assumption. Weigh risk against reward realistically, include the do-nothing route, and be direct if a route is a bad idea. No financial products, trading or investment advice; finance stays read-only.\nDECISION: ${question}\nHIS DATA:\n${ctx.join('\n')}` }], FUT_SCHEMA, { models: ['gemini-flash-latest', 'gemini-flash-lite-latest'], timeout: 40000, temperature: 0.4 });
  let simulated = 0;
  for (const rt of r.routes || []) {
    if (!(d && M && rt.money && rt.money.applies)) continue;
    const sc = { months: 6, runs: 3000, monthly_change: +rt.money.monthly_change || 0, cuts: (rt.money.cuts || []).filter(c => c.category && +c.percent > 0) };
    const sim = M.simulate(d, sc);
    if (!sim.error) { rt.simulation = { runs: sc.runs, months: 6, p_never_below_zero: sim.p_never_below_zero, expected_savings: sim.expected_savings, end_median: sim.end_balance && sim.end_balance.median, end_p10: sim.end_balance && sim.end_balance.p10, end_p90: sim.end_balance && sim.end_balance.p90 }; simulated += sc.runs; }
  }
  const result = { ...r, question, simulated_futures: simulated, routes_considered: (r.routes || []).length, data_used: { money: !!d, calendar: evs.length > 0, memories: mems.length, observations: obs.length }, disclaimer: 'Scenario modelling from your own data, not a prediction. Money simulations replay your real past months (Monte Carlo).' };
  const row = await db('neuro_futures', { method: 'POST', prefer: 'return=representation', body: { question, result } }).catch(() => null);
  return { ok: true, id: row && row[0] && row[0].id, ...result };
}
async function futuresList() { return { runs: await db('neuro_futures?select=id,question,result,chosen,outcome,created_at&order=created_at.desc&limit=10') }; }
async function futuresChoose(b) {
  if (!/^[0-9a-f-]{36}$/.test(String(b.id))) return { ok: false };
  const patch = {}; if (b.chosen) patch.chosen = clip(String(b.chosen), 120); if (b.outcome) patch.outcome = clip(String(b.outcome), 600);
  await db(`neuro_futures?id=eq.${b.id}`, { method: 'PATCH', body: patch }); return { ok: true };
}

// ---------------- Physical: personal trainer ----------------
const PLAN_SCHEMA = OBJ({
  goal: S('his training goal in one line'), level: S('estimated level and why (from evidence)'),
  week: ARR(OBJ({ day: S('Mon..Sun'), focus: S('e.g. Upper strength / Zone 2 walk / Rest'), minutes: { type: 'NUMBER' }, exercises: ARR(OBJ({ name: S('exercise'), sets: S('e.g. 3'), reps: S('e.g. 8-10 or 20 min'), notes: S('cue or progression, short') }), '0-6') }), '7 days'),
  nutrition: ARR(S('specific, simple nutrition action'), '3-5'), recovery: ARR(S('recovery/sleep action'), '2-4'),
  progression: S('how to progress next week'), evidence: ARR(S('fact from his data used'), '0-5'), caution: S('safety note; no medical diagnosis')
});
async function trainerPlan(b) {
  const p = await getProfile();
  const sec = await db('sections?select=status,config,answers&key=eq.body').catch(() => []);
  const mets = await db('section_metrics?select=key,value,unit,at&section=eq.body&order=at.desc&limit=30').catch(() => []);
  const ph = await db(`phone_days?select=day,steps&order=day.desc&limit=14`).catch(() => []);
  const log = jp(p.neuro_trainer_log, []);
  const ctx = [sec[0] && sec[0].config ? 'Body space: ' + JSON.stringify({ headline: sec[0].config.headline, goals: sec[0].config.goals, tone: sec[0].config.tone }).slice(0, 2500) : 'No Body space set up yet.',
    mets.length ? 'Body metrics: ' + mets.map(m => `${m.key} ${m.value}${m.unit || ''} (${String(m.at).slice(0, 10)})`).join('; ') : 'No body metrics logged.',
    ph.length ? 'Steps: ' + ph.map(d => `${d.day} ${d.steps}`).join(', ') : 'No step data.',
    log.length ? 'Recent workouts he logged: ' + log.slice(0, 12).map(l => `${l.day} ${l.focus} ${l.done ? 'done' : 'skipped'}${l.note ? ' (' + l.note + ')' : ''}`).join('; ') : 'No workouts logged yet.',
    b.request ? 'His request: ' + clip(String(b.request), 400) : ''];
  const isl = islamicOn(p);
  const plan = await gen([{ text: `You are his all-in-one personal trainer: strength, cardio, mobility, nutrition and recovery. Build a realistic 7-day plan that fits a busy working adult${isl ? ' who prays five times a day (keep sessions out of prayer times, light sessions on fasting days if he fasts)' : ''}. Progressive, safe, home or gym friendly, no supplements pushing, no medical claims. Base it on the evidence; where data is missing, choose conservative defaults and say so.\n${ctx.join('\n')}` }], PLAN_SCHEMA, { models: ['gemini-flash-latest', 'gemini-flash-lite-latest'], timeout: 40000, temperature: 0.4 });
  plan.created_at = new Date().toISOString();
  await setProfile('neuro_trainer_plan', JSON.stringify(plan));
  return { ok: true, plan };
}
async function trainer() {
  const p = await getProfile();
  return { plan: jp(p.neuro_trainer_plan, null), log: jp(p.neuro_trainer_log, []).slice(0, 30) };
}
async function trainerLog(b) {
  const p = await getProfile(), log = jp(p.neuro_trainer_log, []);
  const e = { day: london().date, focus: clip(String(b.focus || 'Workout'), 80), done: b.done !== false, note: clip(String(b.note || ''), 200), at: new Date().toISOString() };
  log.unshift(e);
  await setProfile('neuro_trainer_log', JSON.stringify(log.slice(0, 120)));
  return { ok: true, entry: e };
}

// ---------------- Connect: communication coach ----------------
const COMM_SCHEMA = OBJ({
  summary: S('2 sentences on how HE communicates in this conversation'),
  tone: S('his overall tone in a few words'),
  strengths: ARR(S('specific strength with a short quote'), '1-3'),
  flaws: ARR(OBJ({ pattern: S('the communication flaw'), quote: S('his exact words showing it (short)'), why: S('why it hurts the conversation'), better: S('a rewritten, better version') }), '0-5, most important first'),
  confidence: S('what his wording says about speaking confidence (no diagnosis)'),
  practice: ARR(OBJ({ title: S('short practice scenario'), brief: S('what to practise and the other person\'s role') }), '2-3 roleplay scenarios for voice practice')
});
async function connectAnalyse(b) {
  const text = String(b.text || '').slice(0, 30000).trim();
  if (text.length < 40) return { ok: false, error: 'Paste or share a longer conversation (at least a few messages).' };
  const me = clip(String(b.me || 'Eesah'), 60);
  const r = await gen([{ text: `Coach Eesah on his communication. The chat below is pasted or exported (e.g. WhatsApp). His name in it is "${me}". Analyse ONLY his messages for flaws (clarity, tone, defensiveness, over-explaining, vagueness, conflict avoidance, apology habits, assertiveness) and give rewrites. The other people's messages are context only: do not profile or judge them, do not repeat their personal details. Be honest and specific, not harsh.\nCHAT:\n${text}` }], COMM_SCHEMA, { models: ['gemini-flash-latest', 'gemini-flash-lite-latest'], timeout: 40000, temperature: 0.3 });
  const keep = { ...r, analysed_at: new Date().toISOString(), chars: text.length };
  await setProfile('neuro_connect_last', JSON.stringify(keep)); // the derived coaching only; the pasted chat is not stored
  const p = await getProfile();
  if (learning(p).conversations && r.flaws && r.flaws[0]) await addObservation({ domain: 'communication', text: r.flaws[0].pattern, evidence: '"' + clip(r.flaws[0].quote || '', 200) + '" (chat you shared)', confidence: 'medium' }, 'chat you shared with Connect').catch(() => {});
  return { ok: true, ...keep };
}
async function connectLast() { const p = await getProfile(); return { last: jp(p.neuro_connect_last, null) }; }

// ---------------- Finance: saver and accountant (read-only) ----------------
async function finance() {
  const M = require('./_money');
  if (!M.configured()) return { connected: false };
  const d = await M.load(); const a = M.analyse(d);
  let best = null; try { best = M.bestPath(d, 6); } catch (e) {}
  const subs = (a.recurring || []).filter(x => /subscri/i.test(x.category || '') || x.type === 'subscription').slice(0, 12);
  const latest = d.txs.length ? d.txs[d.txs.length - 1].date : null, prof = await getProfile().catch(() => ({}));
  let err = null; try { err = prof.money_last_error ? JSON.parse(prof.money_last_error) : null; } catch (e) {}
  return { connected: true, as_of: a.as_of, latest_tx: latest, feed_stale: !latest || latest < london().date.slice(0, 10) && (Date.parse(london().date) - Date.parse(latest)) > 3 * 864e5, feed_error: err && err.error ? 'Bank sync problem since ' + String(err.at).slice(0, 10) : null, balance: a.balances.total, this_month: a.this_month, usual: a.usual, upcoming: (a.upcoming || []).slice(0, 8), insights: (a.insights || []).slice(0, 6), goal: a.goal, savers: best, subscriptions: subs, recurring_count: (a.recurring || []).length, jibreel: { status: 'concept', note: 'Jibreel (future fund idea) is planned only. No trading, investing or money movement is built or allowed.' } };
}

async function contacts() { return { contacts: await db('emergency_contacts?select=name,phone,relation&order=id.asc').catch(() => []) }; }

module.exports = { contacts, MODES, islamicOn, modeOf, learning, preferences, setLearning, setMode, holdsPush, guestState, setGuest, daily, goal, briefing, salahTimes, observations, observationEdit, learnFromTurns, addObservation, sleepSave, sleepList, sleepDelete, trajectory, futures, futuresList, futuresChoose, trainerPlan, trainer, trainerLog, connectAnalyse, connectLast, finance };
