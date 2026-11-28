// Minimal in-memory PostgREST + Gemini stub for unit tests (no network, no real data).
const crypto = require('crypto');
function makeMock() {
  const T = {}; let idn = 1; const gemini = [];
  const parseVal = v => v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : v;
  const cmp = (a, op, v) => {
    if (op === 'in') { const list = v.replace(/^\(|\)$/g, '').split(','); return list.includes(String(a)); }
    const x = parseVal(v), A = a instanceof Date ? a.toISOString() : a;
    const num = typeof A === 'number' && !isNaN(+x);
    const L = num ? A : String(A), R = num ? +x : String(x);
    if (op === 'eq') return x === null ? A == null : (typeof x === 'boolean' ? A === x : String(A) === String(x));
    if (op === 'neq') return String(A) !== String(x);
    if (A == null) return false;
    if (op === 'gt') return L > R; if (op === 'lt') return L < R; if (op === 'gte') return L >= R; if (op === 'lte') return L <= R;
    return true;
  };
  function filters(params) {
    const fs = [];
    for (const [k, v] of params) { if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue; const m = v.match(/^(eq|neq|gt|lt|gte|lte|in)\.(.*)$/); if (m) fs.push(r => (k === 'user_id' && r[k] == null) || cmp(r[k], m[1], decodeURIComponent(m[2]))); /* seeded rows without user_id act like the column default (owner) */ }
    return r => fs.every(f => f(r));
  }
  async function fetchMock(url, opts = {}) {
    const u = new URL(url), method = opts.method || 'GET';
    if (u.hostname === 'generativelanguage.googleapis.com') {
      const reqBody = JSON.parse(opts.body || '{}'); gemini.push(reqBody);
      const out = typeof fetchMock.geminiReply === 'function' ? fetchMock.geminiReply(reqBody) : {};
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.hostname === 'gmail.googleapis.com' || u.hostname === 'oauth2.googleapis.com') { fetchMock.google = (fetchMock.google || []).concat([{ url, method, body: opts.body }]); return new Response(JSON.stringify(/drafts$/.test(u.pathname) ? { id: 'd1' } : /token/.test(u.pathname) ? { access_token: 'x', expires_in: 3600 } : { id: 'm1' }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    const m = u.pathname.match(/\/rest\/v1\/(\w+)/); if (!m) return new Response('{}', { status: 404 });
    const t = m[1]; T[t] = T[t] || []; const f = filters(u.searchParams); const prefer = (opts.headers || {}).prefer || '';
    const ret = rows => new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
    if (method === 'GET') {
      let rows = T[t].filter(f);
      const ord = u.searchParams.get('order'); if (ord) { const [col, dir] = ord.split(',')[0].split('.'); rows = rows.slice().sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1)); }
      const lim = +u.searchParams.get('limit'); if (lim) rows = rows.slice(0, lim);
      return ret(rows.map(r => ({ ...r })));
    }
    if (method === 'POST') {
      const body = JSON.parse(opts.body); const arr = Array.isArray(body) ? body : [body]; const out = [];
      const conflict = u.searchParams.get('on_conflict');
      for (const r of arr) {
        if (conflict) { const cols = conflict.split(','); const ex = T[t].find(x => cols.every(c => (c === 'user_id' && x[c] == null) || String(x[c]) === String(r[c]))); if (ex) { if (/merge/.test(prefer)) Object.assign(ex, r); continue; } }
        const row = { created_at: new Date().toISOString(), ...r };
        if (row.id == null) row.id = ['neuro_actions', 'neuro_futures', 'neuro_sleep'].includes(t) ? crypto.randomUUID() : idn++;
        if (t === 'neuro_actions') { row.status = row.status || 'pending'; row.expires_at = row.expires_at || new Date(Date.now() + 18e5).toISOString(); }
        if (t === 'neuro_observations') { row.status = row.status || 'active'; }
        T[t].push(row); out.push({ ...row });
      }
      return ret(/return=representation/.test(prefer) ? out : []);
    }
    if (method === 'PATCH') { const body = JSON.parse(opts.body); const hit = T[t].filter(f); hit.forEach(r => Object.assign(r, body)); return ret(/return=representation/.test(prefer) ? hit.map(r => ({ ...r })) : []); }
    if (method === 'DELETE') { T[t] = T[t].filter(r => !f(r)); return ret([]); }
    return new Response('{}', { status: 405 });
  }
  fetchMock.tables = T; fetchMock.gemini = gemini;
  return fetchMock;
}
module.exports = { makeMock };
