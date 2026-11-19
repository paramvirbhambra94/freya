const { db, configured, readBody, clip } = require('./_db');
const { requireAuth } = require('./_auth');
const CATS = ['deen', 'health', 'money', 'family', 'work', 'habits', 'goals', 'preferences', 'people', 'routine', 'other'];

module.exports = async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!configured()) return res.status(503).json({ error: 'Memory not set up yet' });
  const b = await readBody(req);
  const content = clip(b.content, 2000).trim();
  if (!content) return res.status(400).json({ error: 'Nothing to remember' });
  const category = CATS.includes(b.category) ? b.category : 'other';
  try {
    await db('memories', { method: 'POST', body: { category, content, source: b.source === 'onboarding' ? 'onboarding' : 'chat' } });
    return res.status(200).json({ ok: true });
  } catch (e) { return res.status(502).json({ error: 'Could not save memory' }); }
};
