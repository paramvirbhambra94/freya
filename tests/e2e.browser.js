// Browser end-to-end for invited accounts: owner creates an invite in Settings; the invitee opens the link on an
// "iPhone" (Playwright WebKit with an iOS user agent), creates a passkey, gets the Add-to-Home-Screen guide, uses a
// clean account, signs in again as the home-screen app; the owner revokes them. Also runs in Chromium with a real
// virtual authenticator (browser-generated WebAuthn for RP ID freya-black.vercel.app), and checks the iOS audio path.
// Needs: local stack + tests/devserver.js on :8080, and playwright (NODE_PATH to a dir with it installed).
// Run: SUPABASE_URL=http://127.0.0.1:3001 SUPABASE_SECRET_KEY=sb_secret_local NODE_PATH=/workspace/mu-e2e/node_modules node tests/e2e.browser.js [webkit|chromium]
const { webkit, chromium } = require('playwright');
const { makeAuthenticator } = require('./webauthn-soft');
const { sign } = require('../api/_auth');
const ORIGIN = 'https://freya-black.vercel.app', LOCAL = 'http://127.0.0.1:8080';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const which = process.argv[2] || 'webkit';
const NAME = 'E2E Tester ' + which + ' ' + Date.now().toString(36);
let pass = 0, failN = 0; const ok = (c, m, extra) => { if (c) { pass++; console.log('PASS', m); } else { failN++; console.log('FAIL', m, extra || ''); } };

// The site is served from the local devserver under its real origin (so WebAuthn sees RP ID freya-black.vercel.app).
// Route interception hides cookies in WebKit, so each context keeps its own jar here (HttpOnly cookies behave the same).
async function proxy(ctx, jar = new Map()) {
  ctx._jar = jar;
  await ctx.route(ORIGIN + '/**', async route => {
    const r = route.request(), url = r.url().replace(ORIGIN, LOCAL);
    try {
      const headers = { ...(await r.allHeaders()) }; delete headers.cookie;
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => k + '=' + v).join('; ');
      const resp = await route.fetch({ url, headers, maxRedirects: 0 });
      for (const h of resp.headersArray().filter(h => h.name.toLowerCase() === 'set-cookie')) {
        const [kv, ...attrs] = h.value.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
        if (/max-age=0\b/i.test(attrs.join(';')) || v === '') jar.delete(k); else jar.set(k, v);
      }
      await route.fulfill({ status: resp.status(), headers: Object.fromEntries(resp.headersArray().filter(h => h.name.toLowerCase() !== 'set-cookie').map(h => [h.name, h.value])), body: await resp.body() });
    } catch (e) { if (process.env.E2E_DEBUG) console.log('[proxy]', r.url(), e.message); await route.abort(); }
  });
  await ctx.route(/fonts\.googleapis|gstatic|generativelanguage/, r => r.abort());
}
// Software passkey bridged into the page (WebKit on Linux has no platform authenticator).
async function softPasskeys(ctx) {
  const auth = makeAuthenticator();
  await ctx.exposeBinding('__wa', (src, kind, opts) => kind === 'create' ? auth.create(opts) : auth.get(opts));
  await ctx.addInitScript(() => {
    const b2u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const u2b = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer; };
    const wrap = j => ({ id: j.id, rawId: u2b(j.rawId), type: j.type, authenticatorAttachment: 'platform', getClientExtensionResults: () => ({}),
      response: Object.fromEntries(Object.entries(j.response).map(([k, v]) => [k, Array.isArray(v) ? v : u2b(v)]).concat([['getTransports', () => j.response.transports || ['internal']]])) });
    window.__waCalls = [];
    const cc = {}; try { Object.defineProperty(navigator, 'credentials', { configurable: true, get: () => cc }); } catch (e) {}
    cc.create = async ({ publicKey: p }) => { window.__waCalls.push({ kind: 'create', rp: p.rp && p.rp.id, uv: p.authenticatorSelection && p.authenticatorSelection.userVerification, rk: p.authenticatorSelection && p.authenticatorSelection.residentKey }); return wrap(await window.__wa('create', { challenge: b2u(p.challenge) })); };
    cc.get = async ({ publicKey: p }) => { window.__waCalls.push({ kind: 'get', rp: p.rpId }); return wrap(await window.__wa('get', { challenge: b2u(p.challenge) })); };
  });
}
async function realPasskeys(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}
const visible = (page, sel) => page.$eval(sel, e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) && getComputedStyle(e).display !== 'none').catch(() => false);

(async () => {
  const B = which === 'chromium' ? chromium : webkit;
  const browser = await B.launch();
  const ownerCookie = await sign({ sub: 'owner', exp: Date.now() + 864e5 });
  // ---------- owner ----------
  const oc = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } }); await proxy(oc, new Map([['freya_s', encodeURIComponent(ownerCookie)]]));
  const op = await oc.newPage(); const oerr = []; op.on('pageerror', e => oerr.push(e.message)); if (process.env.E2E_DEBUG) op.on('console', m => console.log('[owner console]', m.text()));
  await op.goto(ORIGIN + '/'); await op.waitForTimeout(1500);
  ok(await op.evaluate(() => window.freyaUser && window.freyaUser.owner === true), 'owner: signed in with his existing cookie, owner=true');
  ok(/Eesah/.test(await op.textContent('#n-greeting')), 'owner: greeting still says Eesah');
  ok(!(await op.evaluate(() => document.body.classList.contains('tester'))), 'owner: no tester restrictions on his screen');
  await op.click('#n-nav [data-page="settings"]'); await op.waitForSelector('#nx-testers', { timeout: 5000 }).catch(() => {});
  ok(await visible(op, '#nx-testers'), 'owner: Settings shows the Testers card');
  await op.fill('#nx-invn', NAME); await op.click('#nx-invf button');
  await op.waitForSelector('#nx-invl', { timeout: 5000 }).catch(() => {});
  const link = (await op.textContent('#nx-invl').catch(() => '')).trim();
  ok(/^https:\/\/freya-black\.vercel\.app\/\?invite=[A-Za-z0-9_-]{32}$/.test(link), 'owner: invite link created and shown', link);
  ok(await visible(op, '#nx-invc'), 'owner: Copy link button');
  await op.waitForTimeout(800);
  ok(/Invite open/.test(await op.textContent('#nx-users')), 'owner: open invite listed');

  // ---------- invitee on an iPhone (Safari) ----------
  const tc = await browser.newContext(which === 'webkit' ? { serviceWorkers: 'block', userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, hasTouch: true } : { viewport: { width: 390, height: 844 } }); await proxy(tc);
  const tp = await tc.newPage(); const terr = []; tp.on('pageerror', e => terr.push(e.message));
  if (which === 'webkit') await softPasskeys(tc); else await realPasskeys(tc, tp);
  await tp.goto(link); await tp.waitForSelector('[data-v="invite"]:not([hidden])', { timeout: 5000 }).catch(() => {});
  ok(/Hi E2E/.test(await tp.textContent('#inv-msg')), 'invitee: invite landing greets them by first name');
  ok(/UK time/.test(await tp.textContent('#inv-exp')), 'invitee: expiry shown in UK time');
  await tp.waitForTimeout(500); await tp.click('#btn-invite');
  if (which === 'webkit') {
    await tp.waitForSelector('[data-v="welcome"]:not([hidden])', { timeout: 8000 }).catch(() => {});
    ok(await visible(tp, '#inv-steps'), 'invitee (iOS Safari): after the passkey, Add to Home Screen steps are shown', await tp.textContent('#lock-err'));
    ok(/Add to Home Screen/.test(await tp.textContent('#inv-steps')), 'invitee: steps mention Share → Add to Home Screen');
    const calls = await tp.evaluate(() => window.__waCalls);
    ok(calls[0] && calls[0].rp === 'freya-black.vercel.app' && calls[0].uv === 'required' && calls[0].rk === 'required', 'invitee: passkey request is for RP freya-black.vercel.app, discoverable, user verification', JSON.stringify(calls));
    await tp.click('#btn-welcome', { timeout: 5000 }).catch(() => {});
  }
  await tp.waitForFunction(() => document.getElementById('lock').hidden, null, { timeout: 8000 }).catch(() => {});
  ok(await tp.evaluate(() => document.getElementById('lock').hidden), 'invitee: signed in to the app', await tp.textContent('#lock-err').catch(() => ''));
  ok(await tp.evaluate(() => location.search === ''), 'invitee: invite token removed from the address bar');
  await tp.waitForTimeout(1200);
  const u = await tp.evaluate(() => window.freyaUser);
  ok(u && u.owner === false && u.first === 'E2E', 'invitee: their own account (owner=false)', JSON.stringify(u));
  ok(/E2E/.test(await tp.textContent('#n-greeting')) && !/Eesah/.test(await tp.textContent('#n-greeting')), 'invitee: greeting uses their name');
  ok(!/Eesah|JSE/.test(await tp.textContent('#status')), 'invitee: Freya status line has no owner name');
  ok(!(await visible(tp, '#mbtn')) && !(await visible(tp, '#gchip')), 'invitee: no money button or Google (JSE) chip');
  if (which === 'webkit') {
    ok(!(await visible(tp, '#a2hs')), 'invitee: guide not shown twice right after the welcome steps');
    await tp.evaluate(() => { localStorage.removeItem('neuroA2hs'); a2hsMaybe(); });
    ok(await visible(tp, '#a2hs') && /Add to Home Screen/.test(await tp.textContent('#a2hs')), 'iOS Safari first visit: Add to Home Screen guide appears');
    await tp.click('#a2hs-close'); ok(!(await visible(tp, '#a2hs')), 'guide dismisses with Got it');
  }
  await tp.click('#n-nav [data-page="life"]'); await tp.waitForTimeout(300);
  ok(!(await tp.$('[data-space="finance"]')), 'invitee: Life has no Finance space');
  ok(/Mind/.test(await tp.textContent('#nx-root')) && !/Mind & Deen/.test(await tp.textContent('#nx-root')), 'invitee: Islamic Mode off by default (Mind, not Mind & Deen)');
  await tp.click('#n-nav [data-page="settings"]'); await tp.waitForTimeout(600);
  ok(!(await tp.$('#nx-testers')) && !(await tp.$('#n-native')), 'invitee: no Testers admin, no Android settings');
  ok(!(await tp.$eval('#n-islamic', e => e.checked)), 'invitee: Islamic Mode toggle off');
  const st = await tp.evaluate(() => fetch('/api/state').then(r => r.json()));
  ok(!/OWNER_|Eesah|JSE|Tyseley/.test(JSON.stringify(st)), 'invitee: /api/state has none of the owner\'s data');
  const g = await tp.evaluate(() => fetch('/api/google/status').then(r => r.status)), m = await tp.evaluate(() => fetch('/api/money/summary').then(r => r.status));
  ok(g === 403 && m === 403, 'invitee: Google and money APIs refused (403)', g + ' ' + m);

  // ---------- iOS audio path (WebKit) ----------
  if (which === 'webkit') {
    const a = await tp.evaluate(async () => {
      const out = new (window.AudioContext || window.webkitAudioContext)();
      const buf = out.createBuffer(1, 2400, 24000); // her 24 kHz voice into a native-rate context
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([ctx.sampleRate === 16000 ? WORKLET : WORKLET_RS], { type: 'application/javascript' })));
      const node = new AudioWorkletNode(ctx, 'pcm16'); let n = 0, chunks = 0, peak = 0;
      node.port.onmessage = e => { const s = new Int16Array(e.data); chunks++; n += s.length; for (const v of s) peak = Math.max(peak, Math.abs(v)); };
      const osc = ctx.createOscillator(); osc.frequency.value = 300; osc.connect(node); osc.start(); await ctx.resume();
      const t0 = ctx.currentTime; await new Promise(r => setTimeout(r, 2000)); const secs = ctx.currentTime - t0;
      osc.stop(); ctx.close(); out.close();
      return { rate: ctx.sampleRate, secs, perSec: n / secs, chunks, peak, bufDur: buf.duration, ios: IOS };
    });
    ok(a.ios === true, 'iOS detected from the iPhone user agent');
    ok(a.rate !== 16000 && Math.abs(a.perSec - 16000) < 1600 && a.peak > 10000, `iOS mic path: native ${a.rate} Hz → ${Math.round(a.perSec)} samples/s (16 kHz) PCM16, signal intact`, JSON.stringify(a));
    ok(Math.abs(a.bufDur - 0.1) < 1e-6, 'iOS speaker path: 24 kHz voice buffers play in a native-rate context');
  }

  // ---------- home-screen app (standalone, no Safari cookie): passkey sign-in ----------
  // Re-use the invitee's context with cookies cleared = the home-screen app's separate cookie jar, same passkey.
  tc._jar.clear(); await tc.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
  const hp = await tc.newPage(); if (which === 'chromium') await realPasskeys(tc, hp);
  await hp.goto(ORIGIN + '/'); await hp.waitForTimeout(1500);
  if (!(await hp.evaluate(() => document.getElementById('lock').hidden))) { await hp.click('#btn-unlock').catch(() => {}); await hp.waitForTimeout(1500); }
  const hu = await hp.evaluate(() => window.freyaUser);
  ok(hu && hu.first === 'E2E' && hu.owner === false && await hp.evaluate(() => document.getElementById('lock').hidden), 'home-screen app: passkey sign-in lands in their own account', JSON.stringify(hu) + ' ' + await hp.textContent('#lock-err').catch(() => ''));
  ok(!(await visible(hp, '#a2hs')), 'home-screen app: no Add to Home Screen nag when already installed');

  // ---------- link is single-use ----------
  const xc = await browser.newContext({ serviceWorkers: 'block' }); await proxy(xc); const xp = await xc.newPage();
  await xp.goto(link); await xp.waitForTimeout(1200);
  ok(/expired or was already used/.test(await xp.textContent('#inv-msg')), 'invite link cannot be used twice');

  // ---------- owner revokes ----------
  await op.reload(); await op.waitForTimeout(1200); await op.click('#n-nav [data-page="settings"]'); await op.waitForTimeout(1500);
  op.on('dialog', d => d.accept());
  const li = op.locator('#nx-users li', { hasText: NAME }); await li.locator('[data-revoke]').click(); await op.waitForTimeout(1200);
  ok(/Switched off/.test(await li.textContent()), 'owner: tester shows as switched off');
  await new Promise(r => setTimeout(r, 21000)); // the server caches account status for up to 20 s per instance
  const after = await hp.evaluate(() => fetch('/api/state').then(r => r.status));
  ok(after === 401, 'revoked tester is locked out', after);
  const ost = await op.evaluate(() => fetch('/api/state').then(r => r.status));
  ok(ost === 200, 'owner still works');
  ok(!oerr.length && !terr.length, 'no page errors', JSON.stringify([oerr, terr]));
  await browser.close();
  console.log(`${pass}/${pass + failN} passed (${which})`); process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
