// Pattern learning on his own transactions ("Doctor Strange": learn how he really spends, so the futures are his).
// Learns: when he spends (weekday, time of day, weekends, late nights, after payday, merchant rhythms), what sets it off
// (calendar load, habits/prayers missed) with significance tests, weekly forecasts scored against reality, and the
// weights the Monte Carlo engine uses. Patterns are introduced to him gradually; nothing here is shown until introduced.
const { db, getProfile, setProfile, london } = require('./_db');
const M = require('./_money');
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Behavioural spending only: no bills, rent, fees, subscriptions, business, payments to people, or charity.
const BEHAV = ['Groceries', 'Eating out', 'Takeaways', 'Transport', 'Fuel', 'Shopping', 'Health', 'Personal care', 'Entertainment', 'Travel', 'Education', 'Cash', 'Other'];
const WINDOW = 182;
const r2 = n => Math.round(n * 100) / 100;
const dowOf = d => new Date(d + 'T12:00:00Z').getUTCDay();
const hourOf = ts => ts ? +new Date(ts).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }) : null;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const weekStart = d => M.day(d, -((dowOf(d) + 6) % 7));
function rng(seed) { let s = seed >>> 0 || 7; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
// Two-sided permutation test on the difference in means.
function perm(a, b, iters = 2000) {
  if (a.length < 3 || b.length < 3) return 1;
  const obs = Math.abs(mean(a) - mean(b)), all = a.concat(b), n = a.length, rand = rng(a.length * 131 + b.length);
  let hits = 0;
  for (let k = 0; k < iters; k++) {
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = all[i]; all[i] = all[j]; all[j] = t; }
    let sa = 0; for (let i = 0; i < n; i++) sa += all[i];
    let sb = 0; for (let i = n; i < all.length; i++) sb += all[i];
    if (Math.abs(sa / n - sb / (all.length - n)) >= obs) hits++;
  }
  return (hits + 1) / (iters + 1);
}
const conf = (p, nMin, effect) => p < 0.01 && nMin >= 15 && effect >= 0.4 ? 'high' : p < 0.05 && nMin >= 8 && effect >= 0.25 ? 'medium' : 'low';
// Binomial upper tail P(X >= k) for n trials with prob p
function binomTail(k, n, p) { let s = 0; for (let i = k; i <= n; i++) { let c = 1; for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1); s += c * Math.pow(p, i) * Math.pow(1 - p, n - i); } return Math.min(1, s); }

function paydays(txs, today) {
  const inc = txs.filter(t => t.category === 'Income' && !t.is_transfer && t.amount > 0 && t.date >= M.day(today, -365));
  const byMonth = {}; for (const t of inc) byMonth[t.date.slice(0, 7)] = (byMonth[t.date.slice(0, 7)] || 0) + t.amount;
  const mi = M.median(Object.values(byMonth)); const thr = Math.max(150, mi * 0.25);
  const big = inc.filter(t => t.amount >= thr).sort((a, b) => a.date < b.date ? -1 : 1);
  const dates = [...new Set(big.map(t => t.date))];
  const gaps = dates.slice(1).map((d, i) => M.daysBetween(dates[i], d)).filter(g => g >= 5);
  const g = gaps.length >= 2 ? M.median(gaps) : null;
  const regular = g && gaps.filter(x => Math.abs(x - g) <= Math.max(3, g * 0.2)).length / gaps.length >= 0.6;
  return { dates, amounts: big.map(t => t.amount), gap: regular ? Math.round(g) : null, last: dates[dates.length - 1] || null, threshold: thr };
}

// Daily behavioural spend over the window (zero days included).
function daily(d, from, to) {
  const days = {}; for (let x = from; x <= to; x = M.day(x, 1)) days[x] = { spend: 0, n: 0, cats: {} };
  for (const t of d.txs) {
    if (t.is_transfer || t.amount >= 0 || !BEHAV.includes(t.category) || !days[t.date]) continue;
    const o = days[t.date]; o.spend -= t.amount; o.n++; o.cats[t.category] = (o.cats[t.category] || 0) - t.amount;
  }
  return days;
}

function learnPatterns(d, signals = []) {
  const today = d.today, to = M.day(today, -1), first = d.txs.length ? d.txs[0].date : today;
  const from = first > M.day(today, -WINDOW) ? first : M.day(today, -WINDOW);
  const days = daily(d, from, to), keys = Object.keys(days), out = [];
  const nDays = keys.length; if (nDays < 42) return { patterns: [], days: nDays, note: 'not enough history' };
  const base = mean(keys.map(k => days[k].spend));
  const tx = d.txs.filter(t => !t.is_transfer && t.amount < 0 && BEHAV.includes(t.category) && t.date >= from && t.date <= to);
  // 1. Day of week
  const byDow = [...Array(7)].map((_, i) => keys.filter(k => dowOf(k) === i).map(k => days[k].spend));
  const dowMeans = byDow.map(mean), top = dowMeans.indexOf(Math.max(...dowMeans));
  { const a = byDow[top], b = keys.filter(k => dowOf(k) !== top).map(k => days[k].spend), eff = mean(a) / Math.max(1, mean(b)) - 1, p = perm(a, b);
    out.push({ id: 'dow:' + DOW[top], kind: 'when', effect: r2(eff), p: r2(p), n: a.length, confidence: conf(p, a.length, eff),
      say: `He spends most on ${DOW[top]}s: about £${Math.round(mean(a))} on a typical ${DOW[top]} vs £${Math.round(mean(b))} on other days.`, ask: `Is ${DOW[top]} usually your big spending day?` }); }
  // 2. Weekend vs weekday
  { const a = keys.filter(k => [0, 6].includes(dowOf(k))).map(k => days[k].spend), b = keys.filter(k => ![0, 6].includes(dowOf(k))).map(k => days[k].spend), ma = mean(a), mb = mean(b);
    const eff = Math.abs(ma / Math.max(1, mb) - 1), p = perm(a, b);
    out.push({ id: ma > mb ? 'weekend:up' : 'weekend:down', kind: 'when', effect: r2(eff), p: r2(p), n: a.length, confidence: conf(p, a.length, eff),
      say: `Weekends: about £${Math.round(ma)} a day vs £${Math.round(mb)} on weekdays.`, ask: ma > mb ? 'Do weekends tend to be when the money goes?' : 'Do you find weekdays cost you more than weekends?' }); }
  // 3. After payday
  const pd = paydays(d.txs, today);
  if (pd.dates.length >= 3) {
    const near = new Set(); for (const p of pd.dates) for (let i = 0; i <= 3; i++) near.add(M.day(p, i));
    const a = keys.filter(k => near.has(k)).map(k => days[k].spend), b = keys.filter(k => !near.has(k)).map(k => days[k].spend);
    const eff = mean(a) / Math.max(1, mean(b)) - 1, p = perm(a, b);
    if (eff > 0) out.push({ id: 'payday', kind: 'when', effect: r2(eff), p: r2(p), n: a.length, confidence: conf(p, a.length, eff),
      say: `In the 4 days after money lands he spends about £${Math.round(mean(a))} a day, vs £${Math.round(mean(b))} otherwise (${Math.round(eff * 100)}% more).`, ask: 'When money comes in, do you notice yourself loosening up for a few days?' });
  }
  // 4. Late night (22:00-04:00) and time of day
  const timed = tx.filter(t => t.ts); if (timed.length >= 40) {
    const late = timed.filter(t => { const h = hourOf(t.ts); return h >= 22 || h < 4; });
    const share = late.length / timed.length, lateCats = {}; for (const t of late) lateCats[t.category] = (lateCats[t.category] || 0) + 1;
    const topLate = Object.entries(lateCats).sort((a, b) => b[1] - a[1])[0];
    const lateSpend = -late.reduce((s, t) => s + t.amount, 0), lateMonthly = lateSpend / (nDays / 30.44);
    const c = late.length >= 25 && share >= 0.12 ? 'high' : late.length >= 10 && share >= 0.08 ? 'medium' : 'low';
    out.push({ id: 'late_night', kind: 'when', effect: r2(share), n: late.length, confidence: c,
      say: `${Math.round(share * 100)}% of his everyday purchases happen between 10pm and 4am (about £${Math.round(lateMonthly)} a month)${topLate ? ', mostly ' + topLate[0].toLowerCase() : ''}.`, ask: 'Are late nights when the impulse buys happen?' });
    const bands = { morning: [5, 12], afternoon: [12, 17], evening: [17, 22] }, bc = {};
    for (const t of timed) { const h = hourOf(t.ts); const b = Object.keys(bands).find(k => h >= bands[k][0] && h < bands[k][1]) || 'night'; bc[b] = (bc[b] || 0) + -t.amount; }
    const tot = Object.values(bc).reduce((x, y) => x + y, 0), tb = Object.entries(bc).sort((a, b) => b[1] - a[1])[0];
    if (tb && tot) out.push({ id: 'time:' + tb[0], kind: 'when', effect: r2(tb[1] / tot), n: timed.length, confidence: tb[1] / tot >= 0.45 && timed.length >= 60 ? 'medium' : 'low',
      say: `Most of his everyday spending (${Math.round(tb[1] / tot * 100)}%) happens in the ${tb[0]}.`, ask: `Is the ${tb[0]} when you tend to spend?` });
  }
  // 5. Merchant rhythms (same weekday)
  const byM = {}; for (const t of tx) { const k = M.mkey(t); (byM[k] = byM[k] || []).push(t); }
  for (const [k, l] of Object.entries(byM)) {
    if (l.length < 5) continue;
    const c = [0, 0, 0, 0, 0, 0, 0]; for (const t of l) c[dowOf(t.date)]++;
    const best = c.indexOf(Math.max(...c)), pv = binomTail(c[best], l.length, 1 / 7) * 7;
    if (c[best] / l.length < 0.4 || pv > 0.05) continue;
    out.push({ id: `merchant:${k}:${DOW[best]}`, kind: 'habit', effect: r2(c[best] / l.length), p: r2(Math.min(1, pv)), n: l.length, confidence: pv < 0.01 && c[best] >= 5 ? 'high' : 'medium',
      say: `${(l[l.length - 1].merchant || k)} is a ${DOW[best]} habit: ${c[best]} of ${l.length} visits (about £${Math.round(mean(l.map(t => -t.amount)))} each).`, ask: `Is ${(l[l.length - 1].merchant || k)} a ${DOW[best]} thing for you?` });
  }
  // 6. Category hot days
  for (const cat of ['Takeaways', 'Eating out', 'Shopping', 'Entertainment']) {
    const l = tx.filter(t => t.category === cat); if (l.length < 8) continue;
    const c = [0, 0, 0, 0, 0, 0, 0]; for (const t of l) c[dowOf(t.date)]++;
    const best = c.indexOf(Math.max(...c)), pv = binomTail(c[best], l.length, 1 / 7) * 7;
    if (c[best] / l.length >= 0.3 && pv < 0.05) out.push({ id: `catday:${cat}:${DOW[best]}`, kind: 'habit', effect: r2(c[best] / l.length), p: r2(Math.min(1, pv)), n: l.length, confidence: pv < 0.01 ? 'high' : 'medium',
      say: `${cat}: ${Math.round(c[best] / l.length * 100)}% of them happen on ${DOW[best]}s.`, ask: `${DOW[best]}s seem to be ${cat.toLowerCase()} days. Fair?` });
  }
  // 7. Drift: last 60 days vs the 120 before
  { const recent = keys.slice(-60).map(k => days[k].spend), before = keys.slice(-180, -60).map(k => days[k].spend);
    if (before.length >= 60) { const ratio = mean(recent) / Math.max(1, mean(before)), p = perm(recent, before);
      out.push({ id: ratio >= 1 ? 'drift:up' : 'drift:down', kind: 'trend', effect: r2(ratio - 1), p: r2(p), n: recent.length, confidence: conf(p, recent.length, Math.abs(ratio - 1)),
        say: `Everyday spending over the last two months is ${Math.round(Math.abs(ratio - 1) * 100)}% ${ratio >= 1 ? 'higher' : 'lower'} than the four months before.`, ask: ratio >= 1 ? 'Has anything changed lately that has pushed spending up?' : "Spending's eased off lately. Something you've been doing on purpose?" }); } }
  // 8. Triggers: calendar load, missed habits/prayers (only with enough paired days)
  const sig = Object.fromEntries(signals.map(s => [s.day, s]));
  const pair = (test, label, id, ask) => {
    const a = [], b = []; for (const k of keys) { const s = sig[k]; if (!s) continue; const v = test(s); if (v === null) continue; (v ? a : b).push(days[k].spend); }
    if (a.length < 10 || b.length < 10) { out.push({ id, kind: 'trigger', confidence: 'insufficient', n: a.length + b.length, say: `Not enough days yet to judge whether ${label}.` }); return; }
    const eff = mean(a) / Math.max(1, mean(b)) - 1, p = perm(a, b);
    out.push({ id, kind: 'trigger', effect: r2(eff), p: r2(p), n: a.length, confidence: eff > 0 ? conf(p, Math.min(a.length, b.length), eff) : 'low',
      say: `On days when ${label}, everyday spending is ${Math.round(Math.abs(eff) * 100)}% ${eff >= 0 ? 'higher' : 'lower'} (£${Math.round(mean(a))} vs £${Math.round(mean(b))}).`, ask });
  };
  pair(s => s.meeting_minutes == null ? null : s.meeting_minutes >= 240, 'his calendar is heavy (4h+ of meetings)', 'trigger:busy', 'Do heavy meeting days leave you reaching for comfort spends?');
  pair(s => s.habits_done == null && s.habits_missed == null ? null : (s.habits_missed || 0) > 0, 'he misses a habit', 'trigger:habits', 'When a habit slips, does the spending slip too?');
  pair(s => s.prayers_done == null ? null : s.prayers_done < 4, 'fewer prayers get logged', 'trigger:prayer', 'On the off days, do you notice spending creep up?');
  const rank = { high: 3, medium: 2, low: 1, insufficient: 0 };
  out.sort((a, b) => rank[b.confidence] - rank[a.confidence] || (b.effect || 0) - (a.effect || 0));
  return { patterns: out, days: nDays, base_daily: r2(base), paydays: { count: pd.dates.length, gap: pd.gap, last: pd.last } };
}

// ---------- Weekly forecasts ----------
function weeklySeries(d) {
  const S = {}; // cat -> weekStart -> spend (cat 'Total' = all spending)
  for (const t of d.txs) {
    if (t.is_transfer || t.amount >= 0 || M.NON_SPEND.includes(t.category)) continue;
    const w = weekStart(t.date); for (const c of ['Total', t.category]) { S[c] = S[c] || {}; S[c][w] = (S[c][w] || 0) - t.amount; }
  }
  return S;
}
function predictWeek(d, S, W, pd) {
  const prev = []; for (let i = 12; i >= 1; i--) prev.push(M.day(W, -7 * i));
  const first = d.txs.length ? weekStart(d.txs[0].date) : W; const hist = prev.filter(w => w > first);
  if (hist.length < 6) return null;
  const tot = hist.map(w => (S.Total || {})[w] || 0), totMean = mean(tot);
  const cats = Object.keys(S).filter(c => c !== 'Total').map(c => [c, mean(hist.map(w => S[c][w] || 0))]).sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]);
  const paydayIn = w => pd.dates.some(p => p >= w && p <= M.day(w, 6));
  let nextPay = false; if (pd.gap && pd.last) { let n = pd.last; while (n < W) n = M.day(n, pd.gap); nextPay = n <= M.day(W, 6); } else nextPay = pd.dates.some(p => p.slice(8) >= W.slice(8) && p.slice(8) <= M.day(W, 6).slice(8));
  const out = [];
  for (const c of ['Total'].concat(cats)) {
    const v = hist.map(w => (S[c] || {})[w] || 0);
    let e = v[0]; for (let i = 1; i < v.length; i++) e = 0.35 * v[i] + 0.65 * e;
    const pw = hist.filter(paydayIn), npw = hist.filter(w => !paydayIn(w));
    let pf = 1; if (pw.length >= 2 && npw.length >= 2) { const a = mean(pw.map(w => (S[c] || {})[w] || 0)), b = mean(npw.map(w => (S[c] || {})[w] || 0)), m = mean(v) || 1; pf = Math.max(0.7, Math.min(1.5, (nextPay ? a : b) / m)); }
    const r8 = mean(v.slice(-4)), o8 = mean(v.slice(0, -4)) || r8 || 1; const df = Math.sqrt(Math.max(0.85, Math.min(1.2, r8 / o8)));
    out.push({ category: c, pattern: r2(Math.max(0, e * pf * df)), naive: r2(mean(v.slice(-8))) });
  }
  void totMean; return out;
}
function actualWeek(S, W, c) { return r2((S[c] || {})[W] || 0); }

// Weekly job: score last forecasts, backtest (first run), forecast this week, re-learn patterns, update engine weights and best path.
async function weekly({ force = false } = {}) {
  const prof = await getProfile(), now = london(), W = weekStart(now.date);
  if (!force && prof.money_learned_week === W) return { skipped: 'done this week' };
  const d = await M.load();
  if (!d.txs.length) return { skipped: 'no data' };
  const S = weeklySeries(d), pd = paydays(d.txs, d.today), res = {};
  // a) score any unscored live forecasts for finished weeks
  const open = await db(`money_predictions?select=week_start,category,model,predicted&actual=is.null&week_start=lt.${W}`).catch(() => []);
  for (const r of open) { const a = actualWeek(S, r.week_start, r.category); await db(`money_predictions?week_start=eq.${r.week_start}&category=eq.${encodeURIComponent(r.category)}&model=eq.${r.model}`, { method: 'PATCH', body: { actual: a, abs_error: r2(Math.abs(a - +r.predicted)), scored_at: new Date().toISOString() } }); }
  res.scored = open.length;
  // b) walk-forward backtest over the last 12 finished weeks (first run only)
  const have = await db('money_predictions?select=week_start&limit=1').catch(() => []);
  if (!have.length) {
    const rows = [];
    for (let i = 12; i >= 1; i--) {
      const w = M.day(W, -7 * i), dd = { ...d, txs: d.txs.filter(t => t.date < w) };
      const p = predictWeek(dd, weeklySeries(dd), w, paydays(dd.txs, w)); if (!p) continue;
      for (const x of p) for (const m of ['pattern', 'naive']) { const a = actualWeek(S, w, x.category); rows.push({ week_start: w, category: x.category, model: m, predicted: x[m], actual: a, abs_error: r2(Math.abs(a - x[m])), source: 'backtest', scored_at: new Date().toISOString() }); }
    }
    if (rows.length) await db('money_predictions?on_conflict=week_start,category,model', { method: 'POST', prefer: 'resolution=merge-duplicates', body: rows });
    res.backtest_rows = rows.length;
  }
  // d) accuracy -> engine weights (last 8 scored weeks, Total)
  const sc = await db(`money_predictions?select=week_start,model,predicted,actual,source&category=eq.Total&actual=not.is.null&order=week_start.desc&limit=16`).catch(() => []);
  const by = m => sc.filter(r => r.model === m).slice(0, 8), wape = l => { const a = l.reduce((s, r) => s + +r.actual, 0); return a > 0 ? l.reduce((s, r) => s + Math.abs(+r.actual - +r.predicted), 0) / a : null; };
  const ep = wape(by('pattern')), en = wape(by('naive')), sumA = by('pattern').reduce((s, r) => s + +r.actual, 0), sumP = by('pattern').reduce((s, r) => s + +r.predicted, 0);
  const weight = ep != null && en != null ? Math.max(0.25, Math.min(0.85, (1 / Math.max(0.05, ep)) / (1 / Math.max(0.05, ep) + 1 / Math.max(0.05, en)))) : 0.5;
  const bias = sumP > 0 ? Math.max(0.8, Math.min(1.25, sumA / sumP)) : 1;
  // c) forecast this week
  const p = predictWeek(d, S, W, pd); if (p) for (const x of p) x.pattern = r2(x.pattern * bias); // calibrated by her own track record
  if (p) { await db('money_predictions?on_conflict=week_start,category,model', { method: 'POST', prefer: 'resolution=merge-duplicates', body: p.flatMap(x => ['pattern', 'naive'].map(m => ({ week_start: W, category: x.category, model: m, predicted: x[m], source: 'live' }))) }); res.forecast = p.length; }
  const L = learnPatterns(d, await db(`day_signals?select=*&day=gte.${M.day(d.today, -WINDOW)}`).catch(() => []));
  const drift = (L.patterns.find(x => x.id.startsWith('drift:')) || {});
  const model = { weight: r2(weight), bias: r2(bias), drift: drift.confidence && ['high', 'medium'].includes(drift.confidence) ? r2(Math.max(0.85, Math.min(1.2, 1 + drift.effect))) : 1,
    accuracy: { pattern_wape: ep == null ? null : r2(ep), naive_wape: en == null ? null : r2(en), weeks: by('pattern').length }, learned_at: new Date().toISOString(), week: W };
  await db('money_patterns?on_conflict=key', { method: 'POST', prefer: 'resolution=merge-duplicates', body: [{ key: 'model', data: model, updated_at: new Date().toISOString() }, { key: 'patterns', data: L, updated_at: new Date().toISOString() }] });
  // e) best path for this month, with a learned within-month pace curve
  const bp = M.bestPath({ ...d, model }, 6);
  const a = M.analyse(d), curve = paceCurve(d);
  const target = Math.max(0, a.usual.monthly_spend - (bp.levers || []).reduce((s, l) => s + l.monthly_saving, 0));
  await db('money_patterns?on_conflict=key', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { key: 'path', data: { month: now.date.slice(0, 7), target: r2(target), usual: a.usual.monthly_spend, levers: bp.levers, curve, set_at: now.date }, updated_at: new Date().toISOString() } });
  await setProfile('money_learned_week', W);
  return { ...res, patterns: L.patterns.length, model };
}
// Share of a month's spending done by each day of the month (average over last 6 full months)
function paceCurve(d) {
  const thisM = d.today.slice(0, 7), ms = [...new Set(d.txs.map(t => t.date.slice(0, 7)))].filter(m => m < thisM).sort().slice(-6);
  const curve = new Array(32).fill(0); let n = 0;
  for (const m of ms) { const c = new Array(32).fill(0); let tot = 0;
    for (const t of d.txs) if (t.date.slice(0, 7) === m && !t.is_transfer && t.amount < 0 && !M.NON_SPEND.includes(t.category)) { c[+t.date.slice(8)] -= t.amount; tot -= t.amount; }
    if (!tot) continue; let cum = 0; for (let i = 1; i <= 31; i++) { cum += c[i]; curve[i] += cum / tot; } n++; }
  return curve.map(v => n ? Math.round(v / n * 1000) / 1000 : 0);
}

// Daily signals for trigger learning (calendar load, habits, prayers). Called from cron.
async function recordSignals(s) {
  const today = london().date, row = { day: today, updated_at: new Date().toISOString() };
  try {
    const prayers = s.habits.filter(h => h.kind === 'prayer'), habits = s.habits.filter(h => h.kind !== 'prayer');
    const DONE = ['done', 'prayed', 'jamaah', 'qada'];
    row.prayers_done = prayers.filter(h => DONE.includes(h.today)).length;
    row.habits_done = habits.filter(h => DONE.includes(h.today)).length;
    row.habits_missed = habits.filter(h => h.today === 'missed').length;
    if (s.google && s.google.connected) {
      const evs = await db(`calendar_events?select=start_at,end_at&all_day=eq.false&busy=eq.true&start_at=gte.${today}T00:00:00Z&start_at=lt.${M.day(today, 1)}T00:00:00Z`);
      row.events = evs.length; row.meeting_minutes = Math.round(evs.reduce((m, e) => m + (new Date(e.end_at) - new Date(e.start_at)) / 6e4, 0));
    }
    await db('day_signals?on_conflict=day', { method: 'POST', prefer: 'resolution=merge-duplicates', body: row });
  } catch (e) {}
}

// Drift watch vs the chosen best path. Returns a nudge or null.
async function driftCheck(d) {
  const r = (await db('money_patterns?select=data&key=eq.path').catch(() => []))[0]; if (!r) return null;
  const path = r.data, dom = +d.today.slice(8);
  if (!path.target || !path.curve || !path.curve[dom]) return null;
  const mtd = -d.txs.filter(t => t.date.slice(0, 7) === d.today.slice(0, 7) && !t.is_transfer && t.amount < 0 && !M.NON_SPEND.includes(t.category)).reduce((s, t) => s + t.amount, 0);
  const expected = path.target * path.curve[Math.max(1, dom - 1)];
  const over = mtd - expected;
  if (!(mtd > expected * 1.15 && over >= 30)) return { drifting: false, mtd: r2(mtd), expected: r2(expected) };
  const pd = paydays(d.txs, d.today), since = pd.last ? M.daysBetween(pd.last, d.today) : null;
  const text = since != null && since <= 7 ? `You're ${since === 0 ? 'on payday' : since + ' day' + (since === 1 ? '' : 's') + ' past payday'} and £${Math.round(over)} ahead of your planned pace. Easy does it this week.` : `You're £${Math.round(over)} ahead of your planned pace for this month. A quieter few days gets you back on the winning path.`;
  return { drifting: true, over: r2(over), mtd: r2(mtd), expected: r2(expected), text };
}

// ---------- Gradual introduction ----------
// Status per pattern id: raised (she brought it up), confirmed / dismissed (his answer). Only these ever surface in the brief or money view.
async function introState() { const r = (await db('money_patterns?select=data&key=eq.intro').catch(() => []))[0]; return r ? r.data : {}; }
async function setIntro(id, status) {
  const st = await introState(); st[id] = { status, at: new Date().toISOString() };
  await db('money_patterns?on_conflict=key', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { key: 'intro', data: st, updated_at: new Date().toISOString() } });
  if (status === 'raised') await setProfile('pattern_last_intro', london().date);
  return st;
}
// Is she allowed to raise a new pattern yet? Not during onboarding, not in his first days with her, max one new one a day.
function canIntroduce(prof) {
  const days = +prof.companion_days || 0, done = prof.onboarding_status === 'complete';
  const since = prof.onboarding_completed_at ? (Date.now() - new Date(prof.onboarding_completed_at)) / 864e5 : 0;
  return done && days >= 3 && since >= 2 && prof.pattern_last_intro !== london().date;
}
async function view(prof) {
  prof = prof || await getProfile();
  const [L, st, model] = await Promise.all([db('money_patterns?select=data&key=eq.patterns').then(r => r[0] && r[0].data).catch(() => null), introState(), db('money_patterns?select=data&key=eq.model').then(r => r[0] && r[0].data).catch(() => null)]);
  const pats = (L && L.patterns) || [];
  const known = pats.filter(p => st[p.id] && st[p.id].status !== 'dismissed').map(p => ({ id: p.id, say: p.say, confidence: p.confidence, his_answer: st[p.id].status }));
  const eligible = canIntroduce(prof);
  const candidate = eligible ? pats.find(p => ['high', 'medium'].includes(p.confidence) && !st[p.id]) : null;
  return { known, candidate: candidate ? { id: candidate.id, say: candidate.say, ask: candidate.ask, confidence: candidate.confidence, evidence_days: L.days } : null, can_introduce: eligible,
    still_learning: pats.filter(p => !st[p.id] && ['high', 'medium'].includes(p.confidence)).length, accuracy: model ? model.accuracy : null };
}

// ---------- Learned day engine for the Monte Carlo ----------
function dayEngine(d, sc = {}) {
  const m = d.model; if (!m) return null;
  const today = d.today, from = M.day(today, -WINDOW), pd = paydays(d.txs, today);
  const cut = {}; for (const c of sc.cuts || []) cut[String(c.category).toLowerCase()] = Math.max(0, Math.min(100, +c.percent || 0)) / 100;
  const cancel = (sc.cancel || []).map(x => String(x).toLowerCase()).filter(Boolean), payset = new Set(pd.gap ? pd.dates : []);
  const keys = []; for (let x = from; x < today; x = M.day(x, 1)) keys.push(x);
  if (keys.length < 60) return null;
  const ix = Object.fromEntries(keys.map((k, i) => [k, i])), sp = new Float64Array(keys.length), inc = new Float64Array(keys.length);
  for (const t of d.txs) {
    const i = ix[t.date]; if (i === undefined || t.is_transfer) continue;
    if (t.amount > 0) { if (t.category === 'Refunds' || !(pd.gap && payset.has(t.date) && t.amount >= pd.threshold)) inc[i] += t.amount; continue; }
    if (M.NON_SPEND.includes(t.category)) continue;
    const name = `${t.merchant} ${t.description}`.toLowerCase(); if (cancel.some(c => name.includes(c))) continue;
    sp[i] += -t.amount * (1 - (cut[t.category.toLowerCase()] || 0));
  }
  // phase = days since last payday: 0-2, 3-6, 7-13, 14+
  const phaseOf = n => n == null ? 0 : n <= 2 ? 0 : n <= 6 ? 1 : n <= 13 ? 2 : 3;
  const pools = {}, dowPools = [[], [], [], [], [], [], []];
  let lastPay = null; const pdates = pd.dates.slice().sort();
  keys.forEach((k, i) => { while (pdates.length && pdates[0] <= k) lastPay = pdates.shift(); const dw = dowOf(k), ph = pd.gap ? phaseOf(lastPay ? M.daysBetween(lastPay, k) : null) : 0; (pools[dw + ':' + ph] = pools[dw + ':' + ph] || []).push(i); dowPools[dw].push(i); });
  const incMul = 1 + (+sc.income_change_pct || 0) / 100;
  return {
    weight: m.weight || 0.5, bias: 1, drift: m.drift || 1, gap: pd.gap, incMul,
    paydays: pd.gap ? pd.amounts.slice(-6) : [], sinceLastPayday: pd.last ? M.daysBetween(pd.last, today) : 0, startDow: dowOf(today),
    sp, inc, pool: (dw, since) => { const p = pools[dw + ':' + (pd.gap ? phaseOf(since) : 0)]; return p && p.length >= 3 ? p : dowPools[dw]; }
  };
}

module.exports = { learnPatterns, weekly, recordSignals, driftCheck, view, setIntro, canIntroduce, dayEngine, paceCurve, paydays };
