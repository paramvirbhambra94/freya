// Onboarding state, answers, plan, pledge and emergency contacts.
const { db, configured, getProfile, setProfile, readBody, clip, isOwner } = require('./_db');
const { requireAuth, withUser } = require('./_auth');

module.exports = withUser(async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  if (!configured()) return res.status(200).json({ configured: false });
  try {
    if (req.method === 'GET') {
      const p = await getProfile();
      let plan = null; try { plan = p.life_plan ? JSON.parse(p.life_plan) : null; } catch (e) {}
      return res.status(200).json({ configured: true, status: p.onboarding_status || 'not_started', plan });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = await readBody(req);
    switch (b.action) {
      case 'start':
        await setProfile('onboarding_status', 'in_progress');
        return res.status(200).json({ ok: true });
      case 'answer': {
        const answer = clip(b.answer, 3000).trim();
        if (!answer) return res.status(400).json({ error: 'Empty answer' });
        await db('onboarding_answers', { method: 'POST', body: { topic: clip(b.topic || 'general', 60), question: clip(b.question, 500) || null, answer } });
        return res.status(200).json({ ok: true });
      }
      case 'plan': {
        const plan = b.plan && typeof b.plan === 'object' ? b.plan : null;
        if (!plan) return res.status(400).json({ error: 'No plan' });
        await setProfile('life_plan', clip(JSON.stringify(plan), 20000));
        await setProfile('onboarding_status', 'awaiting_pledge');
        return res.status(200).json({ ok: true });
      }
      case 'pledge': {
        const text = clip(b.text, 4000).trim();
        const sig = String(b.signature_png || '');
        const contacts = (Array.isArray(b.contacts) ? b.contacts : [])
          .map(c => ({ name: clip(c && c.name, 100).trim(), relation: clip(c && c.relation, 60).trim() || null, phone: clip(c && c.phone, 40).trim() }))
          .filter(c => c.name && c.phone);
        if (!text) return res.status(400).json({ error: 'Pledge text missing' });
        if (!sig.startsWith('data:image/png;base64,') || sig.length > 1500000) return res.status(400).json({ error: 'Signature missing' });
        // The owner chose two emergency contacts as part of his pledge; for other accounts they are optional.
        if (isOwner() && contacts.length < 2) return res.status(400).json({ error: 'Add at least two emergency contacts' });
        await db('emergency_contacts?id=gt.0', { method: 'DELETE' }); // re-run replaces old contacts
        if (contacts.length) await db('emergency_contacts', { method: 'POST', body: contacts });
        await db('pledges', { method: 'POST', body: { text, signature_png: sig } });
        await setProfile('onboarding_status', 'complete');
        await setProfile('onboarding_completed_at', new Date().toISOString());
        return res.status(200).json({ ok: true });
      }
      case 'reset':
        await setProfile('onboarding_status', 'not_started');
        return res.status(200).json({ ok: true });
      default:
        return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    return res.status(502).json({ error: 'Memory service error' });
  }
});
