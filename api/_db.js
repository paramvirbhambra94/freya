// Server-only Supabase access via the secret (service role) key. Never sent to the client.
const URL_ = process.env.SUPABASE_URL || 'https://pdsnpaaphzgcdxzkmdag.supabase.co';
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const configured = () => !!KEY;

// ---------------- Multi-user isolation (RLS-style, enforced here because access is server-only) ----------------
// Every request runs inside a user context (see _auth.withUser). Every read/write to a per-user table is scoped to
// that user's id: filters are appended to GET/PATCH/DELETE, user_id is forced on POST rows, upsert conflict targets
// are prefixed with user_id (so a clash with another user's row errors instead of overwriting it), and user_id can
// never be changed by a PATCH. No context = refused (fail closed). Cron runs explicitly as the owner.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const OWNER_ID = 'e35a0000-0000-4000-8000-000000000001';
const SCOPED = new Set(['profile', 'memories', 'onboarding_answers', 'pledges', 'emergency_contacts', 'habits', 'habit_logs',
  'convo_sessions', 'convo_turns', 'sections', 'section_items', 'section_insights', 'section_metrics', 'push_subscriptions',
  'notifications_sent', 'neuro_actions', 'neuro_futures', 'neuro_observations', 'neuro_priorities', 'neuro_sleep', 'voice_usage',
  // owner-only integrations (also gated in code; scoped anyway)
  'calendar_events', 'meeting_notes', 'bank_accounts', 'bank_transactions', 'balance_history', 'merchant_rules', 'money_patterns',
  'money_predictions', 'day_signals', 'phone_days', 'phone_events']);
const GLOBAL = new Set(['app_secrets', 'prayer_cache', 'app_users', 'invites', 'passkeys']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const current = () => als.getStore() || null;
const runAs = (user, fn) => als.run(user, fn);
const ownerCtx = () => ({ uid: OWNER_ID, owner: true, role: 'owner', name: 'Eesah', first: 'Eesah' });
function uid() { const c = current(); if (!c || !c.uid || !UUID.test(c.uid)) throw Object.assign(new Error('no_user_context'), { status: 401 }); return c.uid; }
const isOwner = () => { const c = current(); return !!(c && c.uid === OWNER_ID && c.owner); };
function assertOwner(what) { if (!isOwner()) throw Object.assign(new Error('owner_only' + (what ? ':' + what : '')), { status: 403, ownerOnly: true }); }
function scope(path, method, body, prefer) {
  const qi = path.indexOf('?'), table = qi < 0 ? path : path.slice(0, qi);
  if (GLOBAL.has(table)) return { path, body };
  if (!SCOPED.has(table)) throw new Error('unscoped_table_' + table); // new tables must be classified
  const id = uid();
  let q = qi < 0 ? '' : path.slice(qi + 1);
  if (method === 'POST') {
    const rows = (Array.isArray(body) ? body : [body]).map(r => ({ ...r, user_id: id }));
    body = Array.isArray(body) ? rows : rows[0];
    const params = new URLSearchParams(q), oc = params.get('on_conflict');
    if (oc) params.set('on_conflict', ['user_id'].concat(oc.split(',').filter(c => c && c !== 'user_id')).join(','));
    else if (/resolution=/.test(prefer || '')) throw new Error('upsert_needs_on_conflict_' + table);
    q = params.toString().replace(/%2C/g, ',');
  } else {
    if (method === 'PATCH' && body && typeof body === 'object') { body = { ...body }; delete body.user_id; }
    q = (q ? q + '&' : '') + 'user_id=eq.' + id;
  }
  return { path: table + (q ? '?' + q : ''), body };
}

async function db(path, { method = 'GET', body, prefer } = {}) {
  if (!KEY) throw new Error('memory_not_configured');
  ({ path, body } = scope(path, method, body, prefer));
  const headers = { apikey: KEY, 'content-type': 'application/json' };
  if (KEY.startsWith('eyJ')) headers.authorization = 'Bearer ' + KEY; // legacy service_role JWT
  if (prefer) headers.prefer = prefer;
  const r = await fetch(`${URL_}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error('db_error_' + r.status + ': ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

// Supabase Storage (private buckets) with the same server-only key.
async function storage(path, { method = 'GET', body, json = true, headers: extra = {} } = {}) {
  if (!KEY) throw new Error('memory_not_configured');
  // Isolation: object paths (and bulk sign/delete lists) must sit inside the caller's own prefix.
  const m = String(path).match(/^object\/(?:upload\/sign\/|sign\/)?[\w-]+\/?(.*)$/);
  const paths = [].concat(m && m[1] ? [decodeURIComponent(m[1])] : [], body && Array.isArray(body.prefixes) ? body.prefixes : [], body && Array.isArray(body.paths) ? body.paths : []);
  if (paths.some(x => !storageAllowed(x))) throw Object.assign(new Error('storage_forbidden'), { status: 403 });
  const headers = { apikey: KEY, ...extra };
  if (KEY.startsWith('eyJ')) headers.authorization = 'Bearer ' + KEY;
  let payload = body;
  if (body && json && !(body instanceof Uint8Array)) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${URL_}/storage/v1/${path}`, { method, headers, body: payload });
  if (!r.ok) throw new Error('storage_error_' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r;
}
const SUPABASE_URL = URL_;

// Storage objects for non-owner users live under u/<uid>/ (the owner's existing paths are unchanged).
function storagePrefix() { return isOwner() ? '' : 'u/' + uid() + '/'; }
function storageAllowed(p) { const pre = storagePrefix(); return pre ? String(p || '').startsWith(pre) : !String(p || '').startsWith('u/'); }

async function getProfile() {
  const rows = await db('profile?select=key,value');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
const setProfile = (key, value) => db('profile?on_conflict=key', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { key, value, updated_at: new Date().toISOString() } });

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

// Server-only secrets (session key, VAPID keys, cron secret) live in app_secrets, generated on first use.
const secretCache = {};
async function getSecret(key, gen) {
  if (secretCache[key]) return secretCache[key];
  let rows = await db(`app_secrets?select=value&key=eq.${encodeURIComponent(key)}`);
  if (!rows.length && gen) {
    await db('app_secrets?on_conflict=key', { method: 'POST', prefer: 'resolution=ignore-duplicates', body: { key, value: await gen() } });
    rows = await db(`app_secrets?select=value&key=eq.${encodeURIComponent(key)}`);
  }
  if (!rows.length) throw new Error('secret_missing_' + key);
  return (secretCache[key] = rows[0].value);
}
const setSecret = (key, value) => { delete secretCache[key]; return db('app_secrets?on_conflict=key', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { key, value } }); };

// Current time in the owner's zone
function london(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, y: +p.year, m: +p.month, d: +p.day, hm: `${p.hour}:${p.minute}`, min: (+p.hour) * 60 + (+p.minute), weekday: p.weekday };
}

module.exports = { als, OWNER_ID, current, runAs, ownerCtx, uid, isOwner, assertOwner, storagePrefix, storageAllowed, _scope: scope, db, storage, SUPABASE_URL, configured, getProfile, setProfile, readBody, clip, getSecret, setSecret, london };
