// Local stand-in for Vercel: serves the static app and api/*.js handlers (same req/res surface the handlers use).
// For browser tests against the local stack. Gemini is stubbed when GEMINI_API_KEY=test.
// Run: SUPABASE_URL=http://127.0.0.1:3001 SUPABASE_SECRET_KEY=sb_secret_local GEMINI_API_KEY=test PORT=8080 node tests/devserver.js
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
if (process.env.GEMINI_API_KEY === 'test') {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) return new Response(JSON.stringify(u.includes('auth_tokens') ? { name: 'auth_tokens/test' } : { candidates: [{ content: { parts: [{ text: '{}' }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (/mawaqit|oauth2|googleapis|lunchflow/.test(u)) throw new Error('blocked external call: ' + u);
    return real(url, opts);
  };
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
function handlerFor(p) {
  const seg = p.replace(/^\/api\//, '').split('/');
  if (seg.length === 2 && fs.existsSync(path.join(ROOT, 'api', seg[0], '[action].js'))) return { file: path.join(ROOT, 'api', seg[0], '[action].js'), query: { action: seg[1] } };
  const f = path.join(ROOT, 'api', seg[0] + '.js');
  return seg.length === 1 && !seg[0].startsWith('_') && fs.existsSync(f) ? { file: f, query: {} } : null;
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    const h = handlerFor(u.pathname); if (!h) { res.writeHead(404); return res.end('{}'); }
    let raw = ''; for await (const c of req) raw += c;
    let body; try { body = raw ? JSON.parse(raw) : undefined; } catch (e) { body = raw; }
    const hdr = {}; let code = 200;
    const r = { setHeader: (k, v) => { hdr[k] = v; }, getHeader: k => hdr[k], status(c) { code = c; return r; },
      json(j) { res.writeHead(code, { ...hdr, 'content-type': 'application/json' }); res.end(JSON.stringify(j)); return r; },
      send(t) { res.writeHead(code, hdr); res.end(t); return r; }, end(t) { res.writeHead(code, hdr); res.end(t); return r; },
      redirect(a, b) { const to = b || a; res.writeHead(typeof a === 'number' ? a : 302, { ...hdr, location: to }); res.end(); return r; } };
    try { await require(h.file)({ method: req.method, headers: req.headers, query: { ...Object.fromEntries(u.searchParams), ...h.query }, body, url: req.url }, r); }
    catch (e) { console.error('[devserver]', e); if (!res.headersSent) { res.writeHead(500); res.end('{}'); } }
    return;
  }
  let f = path.join(ROOT, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  if (!f.startsWith(ROOT) || f.includes(path.join(ROOT, 'api')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(ROOT, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(+process.env.PORT || 8080, '127.0.0.1', () => console.log('devserver on', +process.env.PORT || 8080));
