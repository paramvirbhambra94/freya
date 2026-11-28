// Software passkey (WebAuthn, ES256, attestation "none") for tests: real signatures, verified by @simplewebauthn.
const crypto = require('crypto');
const b64u = b => Buffer.from(b).toString('base64url');
function cbor(v) {
  const head = (major, n) => n < 24 ? Buffer.from([major << 5 | n]) : n < 256 ? Buffer.from([major << 5 | 24, n]) : n < 65536 ? Buffer.from([major << 5 | 25, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(5); b[0] = major << 5 | 26; b.writeUInt32BE(n, 1); return b; })();
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (typeof v === 'object') return cbor(new Map(Object.entries(v)));
  throw new Error('cbor type');
}
function makeAuthenticator(rpId = 'freya-black.vercel.app', origin = 'https://freya-black.vercel.app') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16); let counter = 0;
  const rpHash = crypto.createHash('sha256').update(rpId).digest();
  return {
    id: b64u(credId),
    create(opts) {
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: opts.challenge, origin, crossOrigin: false }));
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, cose]);
      const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(cd), attestationObject: b64u(att), transports: ['internal'] } };
    },
    get(opts) {
      counter++;
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opts.challenge, origin, crossOrigin: false }));
      const c = Buffer.alloc(4); c.writeUInt32BE(counter);
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), c]);
      const sig = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(cd).digest()]), privateKey);
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(sig) } };
    }
  };
}
module.exports = { makeAuthenticator };
