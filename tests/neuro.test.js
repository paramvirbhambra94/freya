// Unit/integration tests for the NEURO server layer against an in-memory PostgREST + Gemini stub.
// Run: node --test tests/
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test'; process.env.GEMINI_API_KEY = 'test';
process.env.LUNCHFLOW_API_KEY = '';
const test = require('node:test'), assert = require('node:assert');
const { makeMock } = require('./pgmock');
const mock = makeMock(); global.fetch = mock;
const AUTH = require('../api/_authority');
const N = require('../api/_neuro');
const { london, als, ownerCtx } = require('../api/_db');
als.enterWith(ownerCtx()); // these tests exercise the owner's account (multi-user scoping is covered in isolation.int.js)
const T = mock.tables;
const reset = () => { for (const k of Object.keys(T)) delete T[k]; T.profile = []; T.habits = []; T.habit_logs = []; };

test('authority: never/blocked kinds are denied and ledgered, unknown denied by default', async () => {
  reset();
  const pay = await AUTH.propose({ kind: 'payment', params: { amount: 10 } });
  assert.equal(pay.ok, false); assert.equal(pay.status, 'denied'); assert.match(pay.error, /read-only/);
  const call = await AUTH.propose({ kind: 'call_screen', params: {} });
  assert.equal(call.authority, 'blocked');
  const unk = await AUTH.propose({ kind: 'transfer_everything', params: {} });
  assert.equal(unk.status, 'denied');
  assert.equal(T.neuro_actions.filter(a => a.status === 'denied').length, 2);
});

test('authority: approval binds exact params, runs once, no replay, no tampering, expiry', async () => {
  reset();
  const p = await AUTH.propose({ kind: 'email_send', params: { to: 'jay@example.com', subject: 'Hi', body: 'Notes attached' }, why: 'he asked' });
  assert.ok(p.ok && p.needs_approval && p.hash);
  let runs = 0; const exec = async () => { runs++; return { sent: true }; };
  const bad = await AUTH.approve(p.id, 'deadbeef', exec);
  assert.equal(bad.ok, false); assert.equal(runs, 0);
  T.neuro_actions.find(a => a.id === p.id).params.body = 'Send me £500'; // tampered after proposal
  const tam = await AUTH.approve(p.id, p.hash, exec);
  assert.equal(tam.ok, false); assert.equal(runs, 0);
  T.neuro_actions.find(a => a.id === p.id).params.body = 'Notes attached';
  const ok = await AUTH.approve(p.id, p.hash, exec);
  assert.equal(ok.ok, true); assert.equal(runs, 1);
  const again = await AUTH.approve(p.id, p.hash, exec);
  assert.equal(again.ok, false); assert.equal(runs, 1, 'replay must not execute twice');
  assert.equal(T.neuro_actions.find(a => a.id === p.id).status, 'executed');
  const q = await AUTH.propose({ kind: 'message', params: { channel: 'whatsapp', phone: '+44 7700 900000', text: 'Running 10 min late' } });
  T.neuro_actions.find(a => a.id === q.id).expires_at = new Date(Date.now() - 1000).toISOString();
  const exp = await AUTH.approve(q.id, q.hash, exec);
  assert.equal(exp.ok, false); assert.match(exp.error, /expired/); assert.equal(runs, 1);
});

test('authority: concurrent double-approve executes once', async () => {
  reset();
  const p = await AUTH.propose({ kind: 'message', params: { channel: 'sms', phone: '07700900000', text: 'hello' } });
  let runs = 0; const exec = async () => { runs++; await new Promise(r => setTimeout(r, 20)); return { handoff: true }; };
  const [a, b] = await Promise.all([AUTH.approve(p.id, p.hash, exec), AUTH.approve(p.id, p.hash, exec)]);
  assert.equal(runs, 1); assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
});

test('authority: message executes as a hand-off link only (nothing sent automatically); bad email rejected', async () => {
  reset();
  const p = await AUTH.propose({ kind: 'message', params: { channel: 'whatsapp', phone: '+447700900000', text: 'On my way' } });
  const r = await AUTH.approve(p.id, p.hash);
  assert.equal(r.ok, true); assert.equal(r.result.handoff, true); assert.match(r.result.url, /^https:\/\/wa\.me\/447700900000\?text=On%20my%20way$/);
  await assert.rejects(() => AUTH.propose({ kind: 'email_send', params: { to: 'not-an-email', body: 'x' } }), /valid email/);
});

test('priorities: row storage keeps history, done/reopen/edit/remove, max five', async () => {
  reset();
  const today = london().date;
  T.neuro_priorities = [{ id: 100, day: '2026-01-01', title: 'old', done: true }];
  for (const t of ['a', 'b', 'c', 'd', 'e']) assert.equal((await N.goal({ title: t })).ok, true);
  assert.equal((await N.goal({ title: 'f' })).ok, false);
  const g = T.neuro_priorities.find(x => x.title === 'a');
  await N.goal({ id: g.id, done: true }); assert.equal(T.neuro_priorities.find(x => x.id === g.id).done, true);
  await N.goal({ id: g.id, done: false }); assert.equal(T.neuro_priorities.find(x => x.id === g.id).done, false);
  await N.goal({ id: g.id, title: 'a2' }); assert.equal(T.neuro_priorities.find(x => x.id === g.id).title, 'a2');
  await N.goal({ id: g.id, remove: true }); assert.equal(T.neuro_priorities.filter(x => x.day === today).length, 4);
  assert.ok(T.neuro_priorities.find(x => x.id === 100), 'earlier days are kept');
});

test('priorities: legacy profile JSON migrates once without loss', async () => {
  reset();
  const today = london().date;
  T.profile.push({ key: 'neuro_goals', value: JSON.stringify([{ title: 'legacy one', date: today, done: false }]) });
  const d = await N.daily();
  assert.ok(d.goals.some(g => g.title === 'legacy one'));
  assert.equal(T.profile.find(p => p.key === 'neuro_goals').value, '');
});

test('islamic mode: owner with a mosque stays ON until he chooses; general user OFF', () => {
  assert.equal(N.islamicOn({ mosque_slug: 'al-furqan' }), true);
  assert.equal(N.islamicOn({}), false);
  assert.equal(N.islamicOn({ mosque_slug: 'x', neuro_islamic_mode: 'false' }), false);
});

test('modes: focus/sleep/standby hold non-critical pushes; private/salah keep existing rules; expiry', async () => {
  reset();
  const until = new Date(Date.now() + 36e5).toISOString();
  assert.equal(N.holdsPush({ neuro_mode: JSON.stringify({ mode: 'focus', until }) }, 'high'), true);
  assert.equal(N.holdsPush({ neuro_mode: JSON.stringify({ mode: 'focus', until }) }, 'critical'), false);
  assert.equal(N.holdsPush({ neuro_mode: JSON.stringify({ mode: 'private', until }) }, 'high'), false);
  assert.equal(N.holdsPush({ neuro_mode: JSON.stringify({ mode: 'sleep', until: new Date(Date.now() - 1).toISOString() }) }, 'high'), false);
  T.emergency_contacts = [{ id: 1, name: 'Mum', phone: '+447700900000', relation: 'mother' }];
  const r = await N.setMode({ mode: 'emergency' });
  assert.equal(r.contacts[0].name, 'Mum');
  assert.equal((await N.setMode({ mode: 'nonsense' })).ok, false);
});

test('salah times: worldwide calculation with local time zone; rejects bad input', () => {
  const mk = N.salahTimes({ lat: 21.4225, lng: 39.8262, tz: 'Asia/Riyadh' });
  assert.equal(mk.ok, true); assert.match(mk.times.fajr, /^0[3-6]:\d\d$/); assert.match(mk.times.maghrib, /^1[6-9]:\d\d$/);
  const ny = N.salahTimes({ lat: 40.71, lng: -74.0, tz: 'America/New_York' });
  assert.equal(ny.ok, true); assert.match(ny.times.dhuhr, /^1[12]:\d\d$/);
  assert.equal(N.salahTimes({ lat: 'x', lng: 1, tz: 'UTC' }).ok, false);
  assert.equal(N.salahTimes({ lat: 1, lng: 1, tz: 'Mars/Base' }).ok, false);
});

test('learning: nothing is derived unless he opted in; derived observations are editable/deletable', async () => {
  reset();
  const turns = [1, 2, 3, 4].map(i => ({ role: 'user', text: 'I am stressed about Monday calls again ' + i }));
  mock.geminiReply = () => ({ observations: [{ domain: 'stress', text: 'Gets tense before Monday calls', evidence: 'stressed about Monday calls', confidence: 'medium' }] });
  assert.equal(await N.learnFromTurns(turns), 0);
  T.profile.push({ key: 'neuro_learning', value: JSON.stringify({ conversations: true }) });
  assert.equal(await N.learnFromTurns(turns), 1);
  const o = T.neuro_observations[0];
  await N.observationEdit({ id: o.id, text: 'Only some Mondays' });
  assert.equal(T.neuro_observations[0].status, 'corrected');
  await N.observationEdit({ id: o.id, remove: true });
  assert.equal(T.neuro_observations.length, 0);
  assert.equal(await N.learnFromTurns(turns.map(t => ({ ...t, mode: 'guest' }))), 0, 'guest words never feed learning');
});

test('sleep focus: refused without consent; stores derived summary only, clamps values', async () => {
  reset();
  const st = new Date(Date.now() - 7 * 36e5).toISOString(), en = new Date().toISOString();
  assert.equal((await N.sleepSave({ started_at: st, ended_at: en, summary: {} })).ok, false);
  T.profile.push({ key: 'neuro_learning', value: JSON.stringify({ sleep: true }) });
  const r = await N.sleepSave({ started_at: st, ended_at: en, summary: { loud_events: 12, snore_like_min: 99999, quiet_pct: 140, audio: 'AAAA' }, tiredness: 6 });
  assert.equal(r.ok, true); assert.equal(r.summary.snore_like_min, 960); assert.equal(r.summary.quiet_pct, 100);
  assert.equal(JSON.stringify(T.neuro_sleep[0]).includes('AAAA'), false, 'no audio stored');
});

test('trajectory: compares last 7 days with the 7 before from real logs; honest when data is thin', async () => {
  reset();
  const today = london().date, day = k => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
  assert.equal((await N.trajectory()).verdict, 'Not enough data yet');
  T.habits = [{ id: 1, name: 'Gym', kind: 'habit', active: true }, { id: 2, name: 'Fajr', kind: 'prayer', active: true }];
  T.profile.push({ key: 'mosque_slug', value: 'x' });
  for (let k = 0; k > -7; k--) { T.habit_logs.push({ habit_id: 1, day: day(k), status: 'done' }); T.habit_logs.push({ habit_id: 2, day: day(k), status: 'prayed' }); }
  for (let k = -7; k > -10; k--) T.habit_logs.push({ habit_id: 1, day: day(k), status: 'done' });
  T.phone_days = [];
  for (let k = 0; k > -7; k--) T.phone_days.push({ day: day(k), screen_min: 300, late_min: 60, steps: 4000 });
  for (let k = -7; k > -14; k--) T.phone_days.push({ day: day(k), screen_min: 200, late_min: 20, steps: 8000 });
  const t = await N.trajectory();
  assert.ok(t.good.some(x => x.label === 'Habits kept'));
  assert.ok(t.good.some(x => x.label === 'Salah logged'));
  assert.ok(t.bad.some(x => x.label === 'Screen time') && t.bad.some(x => x.label === 'Daily steps'));
  assert.equal(t.verdict, 'Downfall');
});

test('futures: evidence-only prompt, structured routes, stored for later outcome checks', async () => {
  reset();
  T.memories = [{ category: 'money', content: 'Wants £1,200 saved by June' }];
  mock.geminiReply = () => ({ framing: 'x', routes: [{ name: 'Steady', summary: 's', risk: 'low', reward: 'medium', likelihood: 'high', upside: 'u', downside: 'd', first_step: 'f', evidence: ['Wants £1,200 saved by June'], assumptions: ['a'], money: { applies: false, monthly_change: 0, cuts: [] } }, { name: 'Nothing', summary: 's', risk: 'high', reward: 'low', likelihood: 'low', upside: 'u', downside: 'd', first_step: 'f', evidence: [], assumptions: ['a'], money: { applies: false, monthly_change: 0, cuts: [] } }], recommended: 'Steady', why: 'w', unknowns: ['u'], would_change: 'w' });
  const r = await N.futures({ question: 'Should I save £1,200 by June?' });
  assert.equal(r.ok, true); assert.equal(r.routes_considered, 2); assert.equal(r.simulated_futures, 0, 'no bank = no fake simulation numbers');
  assert.equal(T.neuro_futures.length, 1);
  const prompt = mock.gemini[mock.gemini.length - 1].contents[0].parts[0].text;
  assert.match(prompt, /Use ONLY the facts in HIS DATA as evidence/); assert.match(prompt, /Wants £1,200 saved by June/);
  assert.equal((await N.futures({ question: 'hm' })).ok, false);
});

test('guest: time-limited state', async () => {
  reset();
  const g = await N.setGuest({ on: true, name: 'Sam', minutes: 999 });
  assert.ok(new Date(g.guest.until) - Date.now() <= 60 * 60e3 + 1000, 'capped at 60 minutes');
  const p = Object.fromEntries(T.profile.map(r => [r.key, r.value]));
  assert.equal(N.guestState(p).name, 'Sam');
  await N.setGuest({ on: false });
  assert.equal(N.guestState(Object.fromEntries(T.profile.map(r => [r.key, r.value]))), null);
});

test('persona: owner-only + screen awareness + approvals; neuro_* keys never dumped raw; guest persona has no personal data', () => {
  const tk = require('../api/token');
  const p = tk.persona({ mode: 'companion', profile: { name: 'Eesah', neuro_connect_last: 'SECRET-COACHING', neuro_mode: '{"mode":"focus"}', mosque_slug: 'x' }, memories: [] });
  assert.match(p, /YOU ANSWER ONLY TO EESAH/); assert.match(p, /SCREEN AWARENESS/); assert.match(p, /propose_action/); assert.match(p, /run_futures/);
  assert.equal(p.includes('SECRET-COACHING'), false);
  assert.ok(tk.LIFE_TOOLS.some(t => t.name === 'propose_action') && tk.LIFE_TOOLS.some(t => t.name === 'run_futures'));
});
