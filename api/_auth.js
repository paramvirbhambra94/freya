// Single-owner session: HMAC-signed httpOnly cookie. Secret lives in Supabase app_secrets.
const crypto = require('crypto');
const { getSecret, configured } = require('./_db');

const RP_ID = 'freya-black.vercel.app';
const ORIGINS = ['https://freya-black.vercel.app', 'https://freya-paramvirbhambra94-6690s-projects.vercel.app'];
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
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function setCookie(res, name, value, maxAgeSec) {
  const c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}
async function startSession(res) {
  setCookie(res, 'freya_s', await sign({ sub: 'owner', exp: Date.now() + SESSION_DAYS * 864e5 }), SESSION_DAYS * 86400);
}
async function isAuthed(req) {
  if (!configured()) return false;
  try { const s = await unsign(cookies(req).freya_s); return !!(s && s.sub === 'owner'); } catch (e) { return false; }
}
// Use at the top of every protected handler: if (!(await requireAuth(req, res))) return;
async function requireAuth(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) { res.status(503).json({ error: 'Memory not set up yet' }); return false; }
  if (await isAuthed(req)) return true;
  res.status(401).json({ error: 'locked' });
  return false;
}
module.exports = { RP_ID, ORIGINS, sign, unsign, cookies, setCookie, startSession, isAuthed, requireAuth };
