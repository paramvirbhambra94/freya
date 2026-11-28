// Sessions: HMAC-signed httpOnly cookie. Secret lives in Supabase app_secrets.
// The owner's existing cookie ({sub:'owner'}) keeps working unchanged. Invited users get {sub:'user', uid}.
const crypto = require('crypto');
const { getSecret, configured, db, runAs, OWNER_ID, ownerCtx, current } = require('./_db');

const RP_ID = 'freya-black.vercel.app';
// The Android app (signed with the FREYA release key) may present its own origin for passkeys.
const ORIGINS = ['https://freya-black.vercel.app', 'https://freya-paramvirbhambra94-6690s-projects.vercel.app', 'android:apk-key-hash:zuwYaInJFaFgMILw_KXNjUW19lCzi9azkc_nbcc_lt0'];
const SESSION_DAYS = 180;

const b64u = b => Buffer.from(b).toString('base64url');
const sessionKey = () => getSecret('session_secret', () => crypto.randomBytes(32).toString('hex'));

async function sign(obj) {
  const body = b64u(JSON.stringify(obj));
  const mac = crypto.createHmac('sha256', await sessionKey()).update(body).digest('base64url');
  return body + '.' + mac;
}
async function unsign(tok) {
  if (!tok || tok.indexOf('.') < 0) return null;
  const [body, mac] = tok.split('.');
  const want = crypto.createHmac('sha256', await sessionKey()).update(body).digest('base64url');
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try { const o = JSON.parse(Buffer.from(body, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch (e) { return null; }
}
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => { try { return [k, decodeURIComponent(v.join('='))]; } catch (e) { return [k, '']; } }));
}
function setCookie(res, name, value, maxAgeSec) {
  const c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}
// uid omitted or the owner's id -> the owner's classic cookie (unchanged format).
async function startSession(res, uid) {
  const claims = !uid || uid === OWNER_ID ? { sub: 'owner' } : { sub: 'user', uid };
  setCookie(res, 'freya_s', await sign({ ...claims, exp: Date.now() + SESSION_DAYS * 864e5 }), SESSION_DAYS * 86400);
}

// Active users are re-checked (revocation takes effect within ~20s on a warm instance, immediately on a cold one).
const userCache = new Map();
async function loadUser(id) {
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < 20e3) return hit.u;
  const rows = await db(`app_users?select=id,name,role,status,voice_cap_min&id=eq.${encodeURIComponent(id)}`);
  const u = rows[0] && rows[0].status === 'active' ? rows[0] : null;
  userCache.set(id, { u, at: Date.now() });
  return u;
}
const firstName = n => String(n || '').trim().split(/\s+/)[0] || 'there';
// Resolve the signed-in user from the cookie (null if none / revoked).
async function resolveUser(req) {
  if (!configured()) return null;
  try {
    const s = await unsign(cookies(req).freya_s);
    if (!s) return null;
    if (s.sub === 'owner') return ownerCtx();
    if (s.sub === 'user' && typeof s.uid === 'string' && s.uid !== OWNER_ID) {
      const u = await loadUser(s.uid);
      if (!u || u.role === 'owner') return null;
      return { uid: u.id, owner: false, role: u.role, name: u.name, first: firstName(u.name), voiceCapMin: u.voice_cap_min };
    }
  } catch (e) {}
  return null;
}
// Wrap every API handler: the user context (or none) is set before the handler runs, so every db() call is scoped.
function withUser(handler) {
  const wrapped = async (req, res) => {
    const u = await resolveUser(req);
    return runAs(u || { anon: true }, () => handler(req, res));
  };
  return wrapped;
}
async function isAuthed() { const c = current(); return !!(c && c.uid); }
// Use at the top of every protected handler: if (!(await requireAuth(req, res))) return;
async function requireAuth(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) { res.status(503).json({ error: 'Memory not set up yet' }); return false; }
  if (await isAuthed(req)) return true;
  res.status(401).json({ error: 'locked' });
  return false;
}
// Owner-only endpoints: non-owner users get a plain 403.
async function requireOwner(req, res) {
  if (!(await requireAuth(req, res))) return false;
  const c = current();
  if (c && c.owner) return true;
  res.status(403).json({ error: 'Not available on this account.' });
  return false;
}
module.exports = { RP_ID, ORIGINS, sign, unsign, cookies, setCookie, startSession, isAuthed, requireAuth, requireOwner, withUser, resolveUser, firstName, _userCache: userCache };
