// Multi-user isolation integration test against a REAL PostgREST + Postgres with the production schema
// (see tests/local-stack.md). Seeds owner rows marked OWNER_*, then a tester is invited, registers a real
// (software) passkey, and calls every endpoint and action. Asserts: the tester never receives an owner row or
// marker, no owner row changes, owner-only integrations are refused, the tester's Gemini prompts contain none of
// the owner's context, storage paths stay in the tester's prefix, the voice cap holds, revocation locks them out,
// and the owner keeps working with his existing cookie.
// Run: FREYA_IT=1 SUPABASE_URL=http://127.0.0.1:3001 SUPABASE_SECRET_KEY=sb_secret_local GEMINI_API_KEY=test node tests/isolation.int.js
const assert = require('assert');
const { makeAuthenticator } = require('./webauthn-soft');
if (!process.env.FREYA_IT) { console.log('skip (set FREYA_IT=1 with a local stack)'); process.exit(0); }
const BASE = process.env.SUPABASE_URL;
const RUN = Date.now().toString(36);
const OWNER = 'e35a0000-0000-4000-8000-000000000001';
const MARK = /OWNER_|owner@jse/; // owner content markers (ids like owner-session-0001 are re-used by the tester on purpose, in its own rows)
const PERSONAL = /Eesah|Paramvir|\bJSE\b|Tyseley|Al Furqan|MahmudSabir|Monzo/;

// ---- network stubs: Gemini (records prompts by user), everything else passes through ----
const realFetch = globalThis.fetch; const gemini = [];
const DB = require('../api/_db');
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('generativelanguage.googleapis.com')) {
    const c = DB.current(); gemini.push({ uid: c && c.uid, body: String(opts.body || '') });
    if (u.includes('auth_tokens')) return new Response(JSON.stringify({ name: 'auth_tokens/test' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (/mawaqit|oauth2|googleapis|lunchflow/.test(u)) throw new Error('blocked external call in test: ' + u);
  return realFetch(url, opts);
};
const H = {
  auth: require('../api/auth/[action].js'), state: require('../api/state.js'), memory: require('../api/memory.js'), token: require('../api/token.js'),
  onboarding: require('../api/onboarding.js'), prayers: require('../api/prayers.js'), push: require('../api/push.js'), google: require('../api/google/[action].js'), money: require('../api/money/[action].js')
};
async function call(name, { method = 'GET', query = {}, body, cookie = '' } = {}) {
  const req = { method, query, headers: { cookie }, body };
  let status = 200, out = null; const headers = {};
  const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, getHeader: k => headers[k.toLowerCase()], status(c) { status = c; return res; }, json(j) { out = j; return res; }, send(t) { out = t; return res; }, end() { return res; } };
  await H[name](req, res);
  const set = [].concat(headers['set-cookie'] || []);
  return { status, body: out, set, text: typeof out === 'string' ? out : JSON.stringify(out) };
}
const jar = () => { const c = {}; return { add(set) { for (const s of set) { const [kv] = s.split(';'); const i = kv.indexOf('='); c[kv.slice(0, i)] = kv.slice(i + 1); } }, get: () => Object.entries(c).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ') }; };
const pg = async (path, opts = {}) => { const r = await realFetch(BASE + '/rest/v1/' + path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json', prefer: opts.prefer || '' }, body: opts.body ? JSON.stringify(opts.body) : undefined }); const t = await r.text(); return t ? JSON.parse(t) : null; };
const TABLES = ['profile', 'memories', 'onboarding_answers', 'pledges', 'emergency_contacts', 'habits', 'habit_logs', 'convo_sessions', 'convo_turns', 'sections', 'section_items', 'section_insights', 'section_metrics', 'push_subscriptions', 'notifications_sent', 'neuro_actions', 'neuro_futures', 'neuro_observations', 'neuro_priorities', 'neuro_sleep', 'calendar_events', 'meeting_notes', 'bank_accounts', 'bank_transactions', 'balance_history', 'merchant_rules', 'money_patterns', 'money_predictions', 'day_signals', 'phone_days', 'phone_events', 'passkeys'];
const ownerSnapshot = async () => { const o = {}; for (const t of TABLES) { const rows = await pg(`${t}?user_id=eq.${OWNER}`); o[t] = JSON.stringify(rows.map(r => { const x = { ...r }; if (t === 'passkeys') { delete x.last_used_at; delete x.counter; } return x; }).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)); } return o; };

(async () => {
  const results = []; const ok = (name, cond, extra) => { results.push([cond ? 'PASS' : 'FAIL', name, extra || '']); if (!cond) process.exitCode = 1; };
  const { sign } = require('../api/_auth');
  const ownerCookie = 'freya_s=' + encodeURIComponent(await sign({ sub: 'owner', exp: Date.now() + 864e5 }));

  // ---- owner: existing cookie keeps working; invite Rome ----
  let r = await call('auth', { query: { action: 'status' }, cookie: ownerCookie });
  ok('owner: existing cookie still signed in, recognised as owner', r.body.authed && r.body.user.owner === true, r.text);
  r = await call('auth', { method: 'POST', query: { action: 'invite-create' }, body: { name: 'Rome Gilkes' }, cookie: ownerCookie });
  ok('owner: invite created with link + expiry', r.body.ok && /\/\?invite=[\w-]{30,}$/.test(r.body.link) && r.body.expires_at, r.text);
  const token = r.body.link.split('invite=')[1];
  const before = await ownerSnapshot();

  // ---- tester joins ----
  const T = jar(); const auth = makeAuthenticator();
  r = await call('auth', { query: { action: 'invite', t: token } });
  ok('invite link: public info is name + expiry only', r.body.valid && r.body.first === 'Rome' && Object.keys(r.body).sort().join() === 'expires_at,first,name,valid', r.text);
  r = await call('auth', { method: 'POST', query: { action: 'invite-options' }, body: { t: token } }); T.add(r.set);
  ok('invite: registration options issued', !!r.body.challenge && r.body.rp.id === 'freya-black.vercel.app', r.text);
  r = await call('auth', { method: 'POST', query: { action: 'invite-verify' }, body: { t: token, response: auth.create(r.body) }, cookie: T.get() }); T.add(r.set);
  ok('invite: passkey verified, account created, signed in', r.body.ok === true, r.text);
  r = await call('auth', { query: { action: 'status' }, cookie: T.get() });
  ok('tester: signed in as Rome, not owner', r.body.authed && r.body.user.first === 'Rome' && r.body.user.owner === false, r.text);
  const testerRow = (await pg('app_users?name=eq.Rome%20Gilkes&select=id&order=created_at.desc&limit=1'))[0]; if (!testerRow) { for (const x of results) console.log(x[0], x[1], x[2]); throw new Error('tester not created'); } const testerId = testerRow.id;
  const again = await call('auth', { method: 'POST', query: { action: 'invite-options' }, body: { t: token } });
  ok('invite: single use (second redemption refused)', again.status === 410, again.text);
  const forged = await call('auth', { method: 'POST', query: { action: 'invite-options' }, body: { t: 'x'.repeat(32) } });
  ok('invite: unknown token refused', forged.status === 410);

  // A ready Body section for the tester so upload paths get exercised.
  await pg('sections', { method: 'POST', body: [{ user_id: testerId, key: 'vault', status: 'ready', config: { headline: 'Rome vault' } }, { user_id: testerId, key: 'body', status: 'ready', config: { headline: 'Rome body', goals: [{ title: 'Run 5k' }], metrics: [{ key: 'weight_kg', label: 'Weight', unit: 'kg' }] } }] }).catch(() => {});

  // ---- tester battery: every endpoint/action ----
  const tc = T.get(); const seen = [];
  const t = async (name, opts) => { const x = await call(name, { ...opts, cookie: tc }); seen.push([name, opts, x]); return x; };
  const S = (action, b = {}) => t('state', { method: 'POST', body: { action, ...b } });
  const owners = { action: (await pg(`neuro_actions?user_id=eq.${OWNER}&select=id`))[0].id, item: '11111111-2222-4333-8444-555555555555', sleep: (await pg(`neuro_sleep?user_id=eq.${OWNER}&select=id`))[0].id, obs: (await pg(`neuro_observations?user_id=eq.${OWNER}&select=id`))[0].id, prio: (await pg(`neuro_priorities?user_id=eq.${OWNER}&select=id`))[0].id };
  await t('state', {});
  for (const v of ['daily', 'preferences', 'briefing', 'learned', 'trajectory', 'futures', 'trainer', 'connect', 'finance', 'contacts', 'sleep', 'actions']) await t('state', { query: { neuro: v } });
  await t('state', { query: { neuro: 'salah_times', lat: '51.5', lng: '-0.1', tz: 'Europe/London' } });
  for (const v of ['all', 'thumbs', 'events', 'photos', 'body', 'mind', 'work', 'connections', 'vault']) await t('state', { query: { sec: v } });
  await t('state', { query: { sec: 'insights', section: 'body' } }); await t('state', { query: { sec: 'uploads', section: 'body' } });
  const ph = await t('state', { query: { phone: 'today' } }); ok('owner-only: phone awareness refused (GET)', ph.status === 403);
  for (const [a, b] of [['neuro_goal', { title: 'Rome goal' }], ['neuro_goal', { id: owners.prio, done: true }], ['neuro_goal', { id: owners.prio, remove: true }], ['neuro_islamic_mode', { enabled: true }], ['neuro_learning', { conversations: true }], ['neuro_mode', { mode: 'focus', minutes: 30 }], ['neuro_guest', { name: 'Guest', minutes: 10 }],
    ['neuro_observe', { domain: 'mood', text: 'Rome obs' }], ['neuro_learned', { id: owners.obs, text: 'hijack' }], ['neuro_learned', { id: owners.obs, remove: true }], ['neuro_futures', { question: 'Should I?' }], ['neuro_futures_choose', { id: owners.action, route: 'x' }],
    ['neuro_trainer_plan', { request: 'strength' }], ['neuro_trainer_log', { focus: 'x', done: true }], ['neuro_connect', { text: 'ME: hi\nTHEM: hey' }], ['neuro_sleep', { started_at: new Date(Date.now() - 36e5).toISOString(), ended_at: new Date().toISOString() }], ['neuro_sleep_delete', { id: owners.sleep }],
    ['action_propose', { kind: 'message', params: { text: 'hi', phone: '+44' } }], ['action_propose', { kind: 'email_send', params: { to: 'a@b.co', subject: 's', body: 'b' } }], ['action_approve', { id: owners.action, hash: 'h' }], ['action_deny', { id: owners.action }],
    ['log', { name: 'Gym' }], ['log', { name: 'Fajr' }], ['prayer_log', { kind: 'masjid', prayer: 'fajr' }], ['prayer_missed', { prayer: 'fajr' }], ['salah_mode', { on: false }], ['add_habit', { name: 'Gym' }], ['add_habit', { name: 'Read' }], ['private', { on: true, minutes: 5 }], ['brief_time', { time: '08:00' }],
    ['sec_answers', { section: 'body', answers: [{ a: 'fit' }] }], ['sec_upload_url', { section: 'vault', kind: 'photo', mime: 'image/jpeg', bytes: 1000 }], ['sec_uploaded', { section: 'body', id: owners.item }], ['sec_text', { section: 'vault', text: 'note' }], ['sec_metric', { section: 'body', key: 'weight_kg', value: 80 }],
    ['sec_compare', {}], ['sec_sharpen', { section: 'body' }], ['sec_prep', { what: 'call' }], ['sec_search', { q: 'OWNER' }], ['sec_ask', { section: 'body', q: 'how am I doing' }], ['sec_answer', { section: 'body', id: 1, answer: 'x' }], ['sec_dismiss', { section: 'body', id: 1 }], ['sec_from_chat', { section: 'body', text: 'x' }], ['sec_setting', { section: 'body', thumbs: false }], ['sec_wipe', { section: 'body' }], ['sec_wipe', { section: 'vault', item: owners.item }]]) await S(a, b);
  const pu = await S('phone_upload', { day: '2026-11-28' }); ok('owner-only: phone upload refused', pu.status === 403);
  const pn = await S('phone_note', { id: 'x' }); ok('owner-only: phone note refused', pn.status === 403);
  await t('memory', { method: 'POST', body: { content: 'Rome likes tea', category: 'preferences' } });
  for (const b of [{ action: 'turns', session: 'rome-session-' + RUN + '', turns: [{ cid: 'rome-cid-' + RUN, role: 'user', text: 'hello' }] }, { action: 'turns', session: 'owner-session-0001', turns: [{ cid: 'owner-cid-1', role: 'user', text: 'hijack' }] }, { action: 'recall', q: 'OWNER' }, { action: 'history' }, { action: 'seen', session: 'rome-session-' + RUN + '', kind: 'photo', frames: [] }, { action: 'answer', text: 'x' }]) await t('memory', { method: 'POST', body: b });
  await t('onboarding', {}); for (const b of [{ action: 'start' }, { action: 'answer', topic: 'goals', answer: 'Rome answer' }, { action: 'plan', plan: { headline: 'Rome plan' } }, { action: 'pledge', text: 'I pledge', signature_png: 'data:image/png;base64,AAAA', contacts: [] }]) await t('onboarding', { method: 'POST', body: b });
  await t('prayers', {}); await t('prayers', { method: 'POST', body: { action: 'travel', lat: 51.5, lng: -0.12, label: 'London' } });
  await t('push', {}); await t('push', { method: 'POST', body: { action: 'subscribe', sub: { endpoint: 'https://push.example/rome-' + RUN + '' } } }); await t('push', { method: 'POST', body: { action: 'subscribe', sub: { endpoint: 'https://push.example/owner' } } }); await t('push', { method: 'POST', body: { action: 'test' } });
  const tk = await t('token', { query: {} }); ok('tester: voice token minted (under cap)', tk.status === 200 && tk.body.token, tk.text);
  for (const a of ['status', 'calendar', 'mail_unread', 'draft', 'disconnect', 'start']) { const g = await t('google', { query: { action: a } }); ok('owner-only: google ' + a + ' refused', g.status === 403, g.text); }
  for (const a of ['summary', 'balances', 'sync', 'spending']) { const g = await t('money', { query: { action: a } }); ok('owner-only: money ' + a + ' refused', g.status === 403, g.text); }
  for (const a of ['users']) { const g = await t('auth', { query: { action: a } }); ok('owner-only: admin ' + a + ' refused', g.status === 403); }
  for (const a of ['invite-create', 'user-revoke', 'invite-revoke']) { const g = await t('auth', { method: 'POST', query: { action: a }, body: { name: 'x', id: OWNER } }); ok('owner-only: admin ' + a + ' refused', g.status === 403); }

  if (process.env.FREYA_VERBOSE) for (const [n, o, x] of seen) console.log('   ', x.status, n, JSON.stringify(o.query && Object.keys(o.query).length ? o.query : o.body || {}).slice(0, 70), '->', x.text.slice(0, 110));
  const leaks = seen.filter(([, , x]) => MARK.test(x.text));
  ok(`tester: no owner data in any of ${seen.length} responses`, !leaks.length, leaks.map(([n, o, x]) => n + ' ' + JSON.stringify(o).slice(0, 80) + ' -> ' + x.text.slice(0, 160)).join('\n'));
  const fp = (x) => x.uid === testerId;
  const tg = gemini.filter(fp);
  const glk = tg.filter(g => MARK.test(g.body) || PERSONAL.test(g.body));
  ok(`tester: ${tg.length} Gemini prompts contain none of the owner's data or personal context`, tg.length > 0 && !glk.length, glk.map(g => (g.body.match(/.{0,80}(OWNER_\w+|Eesah|JSE|Tyseley|Paramvir|Monzo).{0,80}/) || [''])[0]).join('\n'));
  ok('tester: no Gemini call ran without a user context', gemini.every(g => g.uid));
  const after = await ownerSnapshot();
  const changed = TABLES.filter(x => before[x] !== after[x]);
  ok('owner: no owner row changed by anything the tester did', !changed.length, changed.join(', '));
  const slog = await (await realFetch(BASE + '/__log')).json();
  const badPaths = slog.filter(l => !l.includes('u/' + testerId + '/') && !/^POST object\/sign\/growth \{"expiresIn":3600,"paths":\[\]\}/.test(l));
  ok(`tester: ${slog.length} storage calls all inside u/<tester>/`, !badPaths.length, badPaths.join('\n'));
  const mine = await pg(`memories?user_id=eq.${testerId}&select=content`);
  ok('tester: own writes land in own rows', mine.some(m => m.content === 'Rome likes tea'));

  // ---- voice cap ----
  let tick; for (let i = 0; i < 25; i++) tick = await t('memory', { method: 'POST', body: { action: 'voice_tick', seconds: 75 } });
  ok('cost guard: heartbeat reports over cap after 30 min', tick.body.over === true, tick.text);
  const capped = await t('token', { query: {} }); ok('cost guard: no voice token once the daily cap is used', capped.status === 429 && capped.body.voice_cap, capped.text);
  const ownerTok = await call('token', { query: {}, cookie: ownerCookie }); ok('owner: voice never capped', ownerTok.status === 200, ownerTok.text);
  const ownerPersona = gemini.filter(g => g.uid === OWNER && g.body.includes('auth_tokens') === false).length >= 0 && gemini.filter(g => g.uid === OWNER).some(g => /Eesah/.test(g.body));
  ok("owner: Freya still gets Eesah's own context", ownerPersona);

  // ---- tester sign-in with passkey, then revocation ----
  const L = jar();
  r = await call('auth', { method: 'POST', query: { action: 'login-options' }, body: {} }); L.add(r.set);
  r = await call('auth', { method: 'POST', query: { action: 'login-verify' }, body: { response: auth.get(r.body) }, cookie: L.get() }); L.add(r.set);
  ok('tester: passkey sign-in works', r.body.ok === true, r.text);
  r = await call('auth', { query: { action: 'status' }, cookie: L.get() }); ok('tester: sign-in lands in own account', r.body.user && r.body.user.first === 'Rome' && !r.body.user.owner);
  const ul = await call('auth', { query: { action: 'users' }, cookie: ownerCookie });
  ok('owner admin: users list shows Rome with a passkey', ul.body.users.some(u => u.id === testerId && u.passkeys === 1), ul.text);
  await call('auth', { method: 'POST', query: { action: 'user-revoke' }, body: { id: testerId }, cookie: ownerCookie });
  r = await call('state', { cookie: L.get() }); ok('revoke: tester session locked out immediately', r.status === 401, r.text);
  r = await call('auth', { method: 'POST', query: { action: 'login-options' }, body: {} }); const L2 = jar(); L2.add(r.set);
  r = await call('auth', { method: 'POST', query: { action: 'login-verify' }, body: { response: auth.get(r.body) }, cookie: L2.get() });
  ok('revoke: tester cannot sign in again', r.status === 403, r.text);
  r = await call('state', { cookie: ownerCookie }); ok('owner: still works after all of it', r.status === 200 && r.body.habits && r.body.habits.some(h => h.name === 'Fajr'), r.text.slice(0, 200));
  await call('auth', { method: 'POST', query: { action: 'user-restore' }, body: { id: testerId }, cookie: ownerCookie });

  for (const x of results) console.log(x[0], x[1], x[0] === 'FAIL' ? '\n   ' + String(x[2]).slice(0, 1500) : '');
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
})().catch(e => { console.error(e); process.exit(1); });
