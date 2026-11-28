// Web Push subscription management.
const { readBody, db } = require('./_db');
const { requireAuth, withUser } = require('./_auth');
const { vapid, sendPush } = require('./_life');

module.exports = withUser(async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    if (req.method === 'GET') return res.status(200).json({ publicKey: (await vapid()).publicKey });
    const b = await readBody(req);
    if (b.action === 'subscribe' && b.sub && b.sub.endpoint) {
      await db('push_subscriptions?on_conflict=endpoint', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { endpoint: b.sub.endpoint, sub: b.sub } });
      return res.status(200).json({ ok: true });
    }
    if (b.action === 'test') return res.status(200).json({ sent: await sendPush({ title: 'F.R.E.Y.A.', body: "Notifications are on. I'll only interrupt when it matters.", priority: 'low', tag: 'test' }) });
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) { if (process.env.FREYA_DEBUG) console.error('[dbg]', e.message); return res.status(502).json({ error: 'Push error' }); }
});
