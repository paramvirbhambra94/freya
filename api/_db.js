// Server-only Supabase access via the secret (service role) key. Never sent to the client.
const URL_ = process.env.SUPABASE_URL || 'https://pdsnpaaphzgcdxzkmdag.supabase.co';
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const configured = () => !!KEY;

async function db(path, { method = 'GET', body, prefer } = {}) {
  if (!KEY) throw new Error('memory_not_configured');
  const headers = { apikey: KEY, 'content-type': 'application/json' };
  if (KEY.startsWith('eyJ')) headers.authorization = 'Bearer ' + KEY; // legacy service_role JWT
  if (prefer) headers.prefer = prefer;
  const r = await fetch(`${URL_}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error('db_error_' + r.status + ': ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

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

module.exports = { db, configured, getProfile, setProfile, readBody, clip };
