// Money endpoints (read-only bank data). Everything needs the owner's passkey session.
const { readBody, setProfile, configured } = require('../_db');
const { requireAuth } = require('../_auth');
const M = require('../_money');

module.exports = async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ error: 'not configured' });
  const action = req.query.action, b = req.method === 'POST' ? await readBody(req) : req.query;
  try {
    if (action === 'sync') { if (!M.configured()) return res.status(503).json({ error: 'Bank link is not set up yet.' }); return res.status(200).json(await M.sync({ force: true })); }
    const d = await M.load();
    if (!d.accounts.length) return res.status(200).json({ connected: M.configured(), empty: true, error: M.configured() ? 'No bank data yet. First sync runs within a few minutes.' : 'Bank link is not set up yet.' });
    if (action === 'summary') { const a = M.analyse(d); delete a.months; return res.status(200).json({ connected: M.configured(), ...a }); }
    if (action === 'balances') { const a = M.analyse(d); return res.status(200).json({ as_of: a.as_of, ...a.balances, upcoming_bills: a.upcoming, renewals: a.renewals }); }
    if (action === 'spending') return res.status(200).json(M.spending(d, b.period, b.category));
    if (action === 'subscriptions') { const a = M.analyse(d); return res.status(200).json({ recurring: a.recurring.filter(r => r.active || b.all), monthly_total: Math.round(a.recurring.filter(r => r.active && r.type !== 'regular').reduce((s, r) => s + r.monthly, 0) * 100) / 100 }); }
    if (action === 'simulate') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
      const sc = { months: b.months, cuts: Array.isArray(b.cuts) ? b.cuts : [], cancel: Array.isArray(b.cancel) ? b.cancel : [], purchase_amount: b.purchase_amount, purchase_month: b.purchase_month, monthly_change: b.monthly_change, income_change_pct: b.income_change_pct, goal: b.goal, label: b.label };
      const base = M.simulate(d, { months: sc.months, goal: sc.goal });
      const changed = sc.cuts.length || sc.cancel.length || +sc.purchase_amount || +sc.monthly_change || +sc.income_change_pct;
      const out = changed ? M.simulate(d, sc, base) : base;
      return res.status(200).json({ ...out, best_path: b.best_path === false ? undefined : M.bestPath(d, out.months || 6) });
    }
    if (action === 'goal') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
      const amount = Math.abs(+b.amount || 0), monthly = Math.abs(+b.monthly || 0);
      if (!amount && !monthly) return res.status(400).json({ error: 'Need an amount or a monthly figure.' });
      const by = /^\d{4}-\d{2}-\d{2}$/.test(b.by || '') ? b.by : null;
      const goal = { amount: amount || null, monthly: monthly || null, by, label: String(b.label || 'Savings').slice(0, 60), set_at: d.today };
      await setProfile('money_goal', JSON.stringify(goal));
      const months = by ? Math.max(1, Math.min(24, Math.round(M.daysBetween(d.today, by) / 30.44))) : 12;
      const target = amount || monthly * months;
      const sim = M.simulate(d, { months: [3, 6, 12, 24].reduce((p, c) => Math.abs(c - months) < Math.abs(p - months) ? c : p, 12), goal: target });
      return res.status(200).json({ ok: true, goal, needs_per_month: Math.round(target / months), p_reached: sim.goal && sim.goal.p_reached, expected_savings: sim.expected_savings, months: sim.months });
    }
    if (action === 'low') { const v = Math.max(0, +b.amount || 0); await setProfile('money_low_threshold', String(v)); return res.status(200).json({ ok: true, low_threshold: v }); }
    return res.status(404).json({ error: 'unknown action' });
  } catch (e) { return res.status(500).json({ error: 'money failed' }); }
};
