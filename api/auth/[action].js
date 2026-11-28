// Passkey (WebAuthn) sign-in. The owner enrols first (unchanged); afterwards new owner passkeys need the recovery code.
// Testers join only through a one-time, expiring invite link the owner creates in Settings; each gets their own
// account (app_users) and their own passkey, and every data read/write is scoped to them (see _db.js).
const crypto = require('crypto');
const { db, configured, readBody, setSecret, current, OWNER_ID, clip, runAs } = require('../_db');
const { RP_ID, ORIGINS, sign, unsign, cookies, setCookie, startSession, withUser, firstName, _userCache } = require('../_auth');

const sha = s => crypto.createHash('sha256').update(String(s).replace(/[^A-Z0-9]/gi, '').toUpperCase()).digest('hex');
const tokHash = t => crypto.createHash('sha256').update('invite|' + String(t)).digest('hex');
const INVITE_DAYS = 7;
const BASE = 'https://' + RP_ID;
function newRecoveryCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = crypto.randomBytes(16);
  const s = [...b].map(x => A[x % A.length]).join('');
  return s.match(/.{4}/g).join('-');
}
async function checkRecovery(code) {
  if (!code) return false;
  const rows = await db('app_secrets?select=value&key=eq.recovery_hash');
  if (!rows.length) return false;
  const a = Buffer.from(rows[0].value), b = Buffer.from(sha(code));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const passkeyCount = async () => (await db('passkeys?select=id')).length;
const ownerPasskeys = () => db(`passkeys?select=id,transports&user_id=eq.${OWNER_ID}`);
const me = () => current() || {};
const authed = () => !!me().uid;
const isOwner = () => !!(me().uid === OWNER_ID && me().owner);
const uuidOk = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(s || ''));

// A valid invite (unused, unrevoked, unexpired) for this raw token, or null.
async function findInvite(t) {
  if (!/^[\w-]{20,80}$/.test(String(t || ''))) return null;
  const rows = await db(`invites?select=id,name,user_id,expires_at,used_at,revoked_at&token_hash=eq.${tokHash(t)}`);
  const i = rows[0];
  if (!i || i.used_at || i.revoked_at || new Date(i.expires_at) <= new Date()) return null;
  return i;
}

module.exports = withUser(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ error: 'Memory not set up yet' });
  const action = req.query.action;
  const W = await import('@simplewebauthn/server');
  try {
    if (action === 'status') {
      const u = me();
      return res.status(200).json({ enrolled: (await passkeyCount()) > 0, authed: authed(), user: u.uid ? { name: u.name, first: u.first || firstName(u.name), owner: isOwner(), role: u.role } : null });
    }
    // Public: what an invite link is for (name + expiry only), so the landing screen can greet them.
    if (action === 'invite') {
      const i = await findInvite(req.query.t);
      return res.status(200).json(i ? { valid: true, name: i.name, first: firstName(i.name), expires_at: i.expires_at } : { valid: false });
    }

    // ---------- owner admin ----------
    if (action === 'users') {
      if (!isOwner()) return res.status(403).json({ error: 'Owner only' });
      const [users, invites, keys] = await Promise.all([
        db('app_users?select=id,name,role,status,voice_cap_min,created_at,revoked_at&order=created_at.asc'),
        db(`invites?select=id,name,user_id,created_at,expires_at,used_at,revoked_at&order=created_at.desc&limit=50`),
        db('passkeys?select=user_id,last_used_at,created_at')
      ]);
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
      const vu = await Promise.all(users.filter(u => u.role !== 'owner').map(async u => {
        // voice_usage is a per-user table: read it inside that user's own scope.
        const r = await runAs({ uid: u.id, owner: false }, () => db(`voice_usage?select=seconds,sessions&day=eq.${today}`)).catch(() => []);
        return [u.id, r[0] || { seconds: 0, sessions: 0 }];
      }));
      const vmap = Object.fromEntries(vu);
      return res.status(200).json({ ok: true,
        users: users.map(u => { const k = keys.filter(x => x.user_id === u.id); const last = k.map(x => x.last_used_at || x.created_at).filter(Boolean).sort().pop() || null; return { id: u.id, name: u.name, role: u.role, status: u.status, created_at: u.created_at, passkeys: k.length, last_sign_in: last, voice_cap_min: u.voice_cap_min, voice_today_min: vmap[u.id] ? Math.round(vmap[u.id].seconds / 60) : null }; }),
        invites: invites.filter(i => !i.used_at && !i.revoked_at && new Date(i.expires_at) > new Date()).map(i => ({ id: i.id, name: i.name, user_id: i.user_id, created_at: i.created_at, expires_at: i.expires_at }))
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = await readBody(req);

    if (action === 'invite-create') {
      if (!isOwner()) return res.status(403).json({ error: 'Owner only' });
      const name = clip(b.name, 60).replace(/[<>]/g, '').trim();
      let forUser = null;
      if (b.user_id) {
        if (!uuidOk(b.user_id) || b.user_id === OWNER_ID) return res.status(400).json({ error: 'Bad user' });
        forUser = (await db(`app_users?select=id,name,status&id=eq.${b.user_id}`))[0];
        if (!forUser) return res.status(404).json({ error: 'No such user' });
      } else if (!name) return res.status(400).json({ error: 'Name needed' });
      const t = crypto.randomBytes(24).toString('base64url');
      const days = Math.max(1, Math.min(14, +b.days || INVITE_DAYS));
      const row = (await db('invites', { method: 'POST', prefer: 'return=representation', body: { token_hash: tokHash(t), name: forUser ? forUser.name : name, user_id: forUser ? forUser.id : null, expires_at: new Date(Date.now() + days * 864e5).toISOString() } }))[0];
      return res.status(200).json({ ok: true, id: row.id, name: row.name, link: `${BASE}/?invite=${t}`, expires_at: row.expires_at });
    }
    if (action === 'invite-revoke') {
      if (!isOwner()) return res.status(403).json({ error: 'Owner only' });
      if (!uuidOk(b.id)) return res.status(400).json({ error: 'Bad id' });
      await db(`invites?id=eq.${b.id}&used_at=is.null`, { method: 'PATCH', body: { revoked_at: new Date().toISOString() } });
      return res.status(200).json({ ok: true });
    }
    if (action === 'user-revoke' || action === 'user-restore') {
      if (!isOwner()) return res.status(403).json({ error: 'Owner only' });
      if (!uuidOk(b.id) || b.id === OWNER_ID) return res.status(400).json({ error: 'Bad user' });
      const revoke = action === 'user-revoke';
      const r = await db(`app_users?id=eq.${b.id}&role=neq.owner`, { method: 'PATCH', prefer: 'return=representation', body: revoke ? { status: 'revoked', revoked_at: new Date().toISOString() } : { status: 'active', revoked_at: null } });
      if (!r.length) return res.status(404).json({ error: 'No such user' });
      if (revoke) await db(`invites?user_id=eq.${b.id}&used_at=is.null`, { method: 'PATCH', body: { revoked_at: new Date().toISOString() } });
      _userCache.delete(b.id);
      return res.status(200).json({ ok: true, status: r[0].status });
    }

    // ---------- invite redemption: create their own passkey (and account) ----------
    if (action === 'invite-options') {
      const i = await findInvite(b.t);
      if (!i) return res.status(410).json({ error: 'This invite link has expired or was already used. Ask for a new one.' });
      const uid = i.user_id || crypto.randomUUID();
      const existing = i.user_id ? await db(`passkeys?select=id,transports&user_id=eq.${uid}`) : [];
      const opts = await W.generateRegistrationOptions({
        rpName: 'Neuro', rpID: RP_ID, userName: i.name, userDisplayName: i.name,
        userID: new TextEncoder().encode('neuro-' + uid), attestationType: 'none',
        excludeCredentials: existing.map(e => ({ id: e.id, transports: e.transports || undefined })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
      });
      setCookie(res, 'freya_c', await sign({ ch: opts.challenge, kind: 'inv', inv: i.id, uid, exp: Date.now() + 5 * 60e3 }), 300);
      return res.status(200).json(opts);
    }
    if (action === 'invite-verify') {
      const c = await unsign(cookies(req).freya_c);
      if (!c || c.kind !== 'inv' || !uuidOk(c.uid)) return res.status(400).json({ error: 'Setup timed out. Try again.' });
      const i = await findInvite(b.t);
      if (!i || i.id !== c.inv) return res.status(410).json({ error: 'This invite link has expired or was already used. Ask for a new one.' });
      const v = await W.verifyRegistrationResponse({ response: b.response, expectedChallenge: c.ch, expectedOrigin: ORIGINS, expectedRPID: RP_ID, requireUserVerification: true });
      if (!v.verified) return res.status(400).json({ error: 'Passkey could not be verified.' });
      // Single use: claim the invite atomically before anything is created.
      const claimed = await db(`invites?id=eq.${i.id}&used_at=is.null&revoked_at=is.null`, { method: 'PATCH', prefer: 'return=representation', body: { used_at: new Date().toISOString() } });
      if (!claimed.length) return res.status(410).json({ error: 'This invite link was already used.' });
      if (!i.user_id) { await db('app_users', { method: 'POST', body: { id: c.uid, name: i.name, role: 'tester', status: 'active' } }); await db(`invites?id=eq.${i.id}`, { method: 'PATCH', body: { user_id: c.uid } }); }
      else { const u = (await db(`app_users?select=status,role&id=eq.${c.uid}`))[0]; if (!u || u.role === 'owner') return res.status(403).json({ error: 'Not allowed' }); if (u.status !== 'active') return res.status(403).json({ error: 'This account has been switched off.' }); }
      const cred = v.registrationInfo.credential;
      await db('passkeys', { method: 'POST', body: { id: cred.id, public_key: Buffer.from(cred.publicKey).toString('base64url'), counter: cred.counter, transports: cred.transports || null, user_id: c.uid } });
      _userCache.delete(c.uid);
      setCookie(res, 'freya_c', '', 0);
      await startSession(res, c.uid);
      return res.status(200).json({ ok: true, name: i.name, first: firstName(i.name) });
    }

    // ---------- owner enrolment (unchanged), and a signed-in user adding another passkey to their own account ----------
    if (action === 'register-options') {
      const count = await passkeyCount();
      const viaRecovery = count > 0 && !authed();
      if (viaRecovery && !(await checkRecovery(b.recovery))) return res.status(403).json({ error: count ? 'That recovery code is not right.' : 'Not allowed' });
      const owner = viaRecovery || count === 0 || isOwner();
      const u = me();
      const existing = owner ? await ownerPasskeys() : await db(`passkeys?select=id,transports&user_id=eq.${u.uid}`);
      const opts = await W.generateRegistrationOptions(owner ? {
        rpName: 'F.R.E.Y.A.', rpID: RP_ID, userName: 'Eesah', userDisplayName: 'Eesah',
        userID: new TextEncoder().encode('freya-owner'), attestationType: 'none',
        excludeCredentials: existing.map(e => ({ id: e.id, transports: e.transports || undefined })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
      } : {
        rpName: 'Neuro', rpID: RP_ID, userName: u.name, userDisplayName: u.name,
        userID: new TextEncoder().encode('neuro-' + u.uid), attestationType: 'none',
        excludeCredentials: existing.map(e => ({ id: e.id, transports: e.transports || undefined })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
      });
      setCookie(res, 'freya_c', await sign({ ch: opts.challenge, kind: 'reg', rec: viaRecovery, uid: owner ? OWNER_ID : u.uid, exp: Date.now() + 5 * 60e3 }), 300);
      return res.status(200).json(opts);
    }

    if (action === 'register-verify') {
      const c = await unsign(cookies(req).freya_c);
      if (!c || c.kind !== 'reg') return res.status(400).json({ error: 'Setup timed out. Try again.' });
      const count = await passkeyCount();
      const target = c.uid || OWNER_ID;
      if (count > 0 && !c.rec && !(authed() && me().uid === target)) return res.status(403).json({ error: 'Enrolment is closed.' });
      const v = await W.verifyRegistrationResponse({ response: b.response, expectedChallenge: c.ch, expectedOrigin: ORIGINS, expectedRPID: RP_ID, requireUserVerification: true });
      if (!v.verified) return res.status(400).json({ error: 'Passkey could not be verified.' });
      const cred = v.registrationInfo.credential;
      await db('passkeys', { method: 'POST', body: { id: cred.id, public_key: Buffer.from(cred.publicKey).toString('base64url'), counter: cred.counter, transports: cred.transports || null, user_id: target } });
      // Fresh owner recovery code on first enrolment and whenever the old one is used. Shown once.
      let recovery = null;
      if (target === OWNER_ID && (count === 0 || c.rec)) { recovery = newRecoveryCode(); await setSecret('recovery_hash', sha(recovery)); }
      setCookie(res, 'freya_c', '', 0);
      await startSession(res, target);
      return res.status(200).json({ ok: true, recovery });
    }

    if (action === 'login-options') {
      const keys = await db('passkeys?select=id,transports');
      if (!keys.length) return res.status(400).json({ error: 'No passkey set up yet.' });
      const opts = await W.generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'required', allowCredentials: keys.map(k => ({ id: k.id, transports: k.transports || undefined })) });
      setCookie(res, 'freya_c', await sign({ ch: opts.challenge, kind: 'auth', exp: Date.now() + 5 * 60e3 }), 300);
      return res.status(200).json(opts);
    }

    if (action === 'login-verify') {
      const c = await unsign(cookies(req).freya_c);
      if (!c || c.kind !== 'auth') return res.status(400).json({ error: 'Sign-in timed out. Try again.' });
      const id = b.response && b.response.id;
      const rows = id ? await db(`passkeys?select=id,public_key,counter,transports,user_id&id=eq.${encodeURIComponent(id)}`) : [];
      if (!rows.length) return res.status(403).json({ error: 'This passkey is not recognised.' });
      const k = rows[0];
      const v = await W.verifyAuthenticationResponse({
        response: b.response, expectedChallenge: c.ch, expectedOrigin: ORIGINS, expectedRPID: RP_ID, requireUserVerification: true,
        credential: { id: k.id, publicKey: new Uint8Array(Buffer.from(k.public_key, 'base64url')), counter: Number(k.counter), transports: k.transports || undefined }
      });
      if (!v.verified) return res.status(403).json({ error: 'Sign-in failed.' });
      const uid = k.user_id || OWNER_ID;
      if (uid !== OWNER_ID) {
        const u = (await db(`app_users?select=status,role&id=eq.${uid}`))[0];
        if (!u || u.status !== 'active' || u.role === 'owner') return res.status(403).json({ error: 'This account has been switched off. Ask Eesah for access.' });
      }
      await db(`passkeys?id=eq.${encodeURIComponent(k.id)}`, { method: 'PATCH', body: { counter: v.authenticationInfo.newCounter, last_used_at: new Date().toISOString() } });
      setCookie(res, 'freya_c', '', 0);
      await startSession(res, uid);
      return res.status(200).json({ ok: true });
    }

    if (action === 'logout') { setCookie(res, 'freya_s', '', 0); return res.status(200).json({ ok: true }); }
    return res.status(404).json({ error: 'Unknown action' });
  } catch (e) {
    if (process.env.FREYA_DEBUG) console.error('[auth]', e);
    return res.status(400).json({ error: 'Sign-in error. Try again.' });
  }
});
module.exports._tokHash = tokHash;
