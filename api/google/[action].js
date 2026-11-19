// Google Workspace endpoints. Everything except the OAuth callback needs the owner's passkey session.
const crypto = require('crypto');
const { readBody, db, configured } = require('../_db');
const { requireAuth, sign, unsign } = require('../_auth');
const G = require('../_google');

const page = (title, msg) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${title}</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0805;color:#f3e6cf;font-family:-apple-system,Roboto,sans-serif;text-align:center"><div style="max-width:320px;padding:24px"><div style="width:70px;height:70px;margin:0 auto 18px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#fff2d0,#e8b45a 30%,#a8641c 65%,#3b1f06);box-shadow:0 0 40px 8px rgba(232,180,90,.4)"></div><h2 style="font-weight:400;color:#e8b45a">${title}</h2><p style="opacity:.75;line-height:1.5">${msg}</p><p><a href="/" style="color:#e8b45a">Back to FREYA</a></p></div></body>`;
const html = (res, code, t, m) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); return res.status(code).send(page(t, m)); };

module.exports = async (req, res) => {
  const action = req.query.action;
  if (action === 'callback') {
    if (!configured()) return html(res, 503, 'Not ready', 'Memory is not set up yet.');
    const st = await unsign(String(req.query.state || '')).catch(() => null);
    if (!st || !st.g) return html(res, 400, 'Link expired', 'That sign-in link expired. Go back to FREYA and tap Connect Google again.');
    if (req.query.error) return html(res, 200, 'Not connected', 'Google sign-in was cancelled. You can try again from FREYA any time.');
    try {
      const r = await G.exchange(String(req.query.code || ''));
      const personal = r.email && /@(gmail|googlemail)\.com$/i.test(r.email);
      return html(res, 200, 'Google connected', `Connected as <b>${(r.email || '').replace(/</g, '')}</b>.${personal ? ' Heads up: that looks like a personal Gmail, not your JSE account. If that is wrong, disconnect in FREYA and reconnect with JSE.' : ''} You can close this and go back to FREYA.`);
    } catch (e) { return html(res, 400, "Couldn't connect", 'Google did not hand over access. Go back to FREYA and try Connect Google again.'); }
  }
  if (!(await requireAuth(req, res))) return;
  try {
    if (action === 'start') {
      const c = await G.creds();
      if (!c) return html(res, 503, 'Almost there', 'The Google keys are not set up in Vercel yet.');
      const state = await sign({ g: 1, n: crypto.randomBytes(8).toString('hex'), exp: Date.now() + 15 * 60e3 });
      res.setHeader('Location', G.authUrl(c, state));
      return res.status(302).end();
    }
    if (action === 'status') return res.status(200).json(await G.status());
    const b = req.method === 'POST' ? await readBody(req) : req.query;
    switch (action) {
      case 'disconnect': await G.disconnect(); return res.status(200).json({ ok: true });
      case 'calendar': return res.status(200).json({ events: await G.getCalendar(b.range) });
      case 'free': return res.status(200).json({ free: await G.findFree({ date: b.date, duration: +b.duration || 30, from: b.from, to: b.to }) });
      case 'create_event': return res.status(200).json({ ok: true, event: await G.createEvent(b) });
      case 'update_event': return res.status(200).json({ ok: true, event: await G.updateEvent(b) });
      case 'mail_search': return res.status(200).json({ messages: await G.searchMail(String(b.q || ''), 8) });
      case 'mail_unread': return res.status(200).json({ messages: await G.importantUnread() });
      case 'mail_read': return res.status(200).json(await G.readMail(String(b.id || '')));
      case 'draft': return res.status(200).json({ ok: true, draft: await G.createDraft(b) });
      case 'drive_search': return res.status(200).json({ files: await G.searchDrive(b.q) });
      case 'drive_read': return res.status(200).json(await G.readFile(String(b.id || '')));
      case 'debrief_done': {
        if (b.event_id) await db(`calendar_events?id=eq.${encodeURIComponent(b.event_id)}`, { method: 'PATCH', body: { debrief_status: 'done' } });
        if (b.summary) await db('memories', { method: 'POST', body: { category: 'work', content: String(b.summary).slice(0, 2000), source: 'debrief' } });
        return res.status(200).json({ ok: true });
      }
      default: return res.status(404).json({ error: 'Unknown action' });
    }
  } catch (e) {
    const m = String(e.message || '');
    const msg = /not_connected|not_configured/.test(m) ? 'Google is not connected yet.' : /refresh_failed/.test(m) ? 'Google access expired. Reconnect Google in FREYA.' : /google_403/.test(m) ? 'Google refused that (missing permission).' : 'Google request failed.';
    return res.status(502).json({ error: msg });
  }
};
