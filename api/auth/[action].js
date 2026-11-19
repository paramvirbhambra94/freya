// Passkey (WebAuthn) sign-in for a single owner. First device enrols; afterwards new passkeys need the recovery code.
const crypto = require('crypto');
const { db, configured, readBody, getSecret, setSecret } = require('../_db');
const { RP_ID, ORIGINS, sign, unsign, cookies, setCookie, startSession, isAuthed } = require('../_auth');

const sha = s => crypto.createHash('sha256').update(String(s).replace(/[^A-Z0-9]/gi, '').toUpperCase()).digest('hex');
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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ error: 'Memory not set up yet' });
  const action = req.query.action;
  const W = await import('@simplewebauthn/server');
  try {
    if (action === 'status') {
      return res.status(200).json({ enrolled: (await passkeyCount()) > 0, authed: await isAuthed(req) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = await readBody(req);

    if (action === 'register-options') {
      const count = await passkeyCount();
      const authed = await isAuthed(req);
      const viaRecovery = count > 0 && !authed;
      if (viaRecovery && !(await checkRecovery(b.recovery))) return res.status(403).json({ error: count ? 'That recovery code is not right.' : 'Not allowed' });
      const existing = await db('passkeys?select=id,transports');
      const opts = await W.generateRegistrationOptions({
        rpName: 'F.R.E.Y.A.', rpID: RP_ID, userName: 'Eesah', userDisplayName: 'Eesah',
        userID: new TextEncoder().encode('freya-owner'), attestationType: 'none',
        excludeCredentials: existing.map(e => ({ id: e.id, transports: e.transports || undefined })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
      });
      setCookie(res, 'freya_c', await sign({ ch: opts.challenge, kind: 'reg', rec: viaRecovery, exp: Date.now() + 5 * 60e3 }), 300);
      return res.status(200).json(opts);
    }

    if (action === 'register-verify') {
      const c = await unsign(cookies(req).freya_c);
      if (!c || c.kind !== 'reg') return res.status(400).json({ error: 'Setup timed out. Try again.' });
      const count = await passkeyCount();
      if (count > 0 && !c.rec && !(await isAuthed(req))) return res.status(403).json({ error: 'Enrolment is closed.' });
      const v = await W.verifyRegistrationResponse({ response: b.response, expectedChallenge: c.ch, expectedOrigin: ORIGINS, expectedRPID: RP_ID, requireUserVerification: true });
      if (!v.verified) return res.status(400).json({ error: 'Passkey could not be verified.' });
      const cred = v.registrationInfo.credential;
      await db('passkeys', { method: 'POST', body: { id: cred.id, public_key: Buffer.from(cred.publicKey).toString('base64url'), counter: cred.counter, transports: cred.transports || null } });
      // Fresh recovery code on first enrolment and whenever the old one is used. Shown once.
      let recovery = null;
      if (count === 0 || c.rec) { recovery = newRecoveryCode(); await setSecret('recovery_hash', sha(recovery)); }
      setCookie(res, 'freya_c', '', 0);
      await startSession(res);
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
      const rows = id ? await db(`passkeys?select=id,public_key,counter,transports&id=eq.${encodeURIComponent(id)}`) : [];
      if (!rows.length) return res.status(403).json({ error: 'This passkey is not recognised.' });
      const k = rows[0];
      const v = await W.verifyAuthenticationResponse({
        response: b.response, expectedChallenge: c.ch, expectedOrigin: ORIGINS, expectedRPID: RP_ID, requireUserVerification: true,
        credential: { id: k.id, publicKey: new Uint8Array(Buffer.from(k.public_key, 'base64url')), counter: Number(k.counter), transports: k.transports || undefined }
      });
      if (!v.verified) return res.status(403).json({ error: 'Sign-in failed.' });
      await db(`passkeys?id=eq.${encodeURIComponent(k.id)}`, { method: 'PATCH', body: { counter: v.authenticationInfo.newCounter, last_used_at: new Date().toISOString() } });
      setCookie(res, 'freya_c', '', 0);
      await startSession(res);
      return res.status(200).json({ ok: true });
    }

    if (action === 'logout') { setCookie(res, 'freya_s', '', 0); return res.status(200).json({ ok: true }); }
    return res.status(404).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(400).json({ error: 'Sign-in error. Try again.' });
  }
};
