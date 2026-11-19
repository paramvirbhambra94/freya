// Phase 6: money. READ-ONLY bank data via Lunch Flow (x-api-key), stored server-only in Supabase.
// Sync (~every 6h from cron), auto-categorise, recurring bills, income, insights, Monte Carlo outcomes.
const { db, getProfile, setProfile, london } = require('./_db');
const LF = 'https://www.lunchflow.app/api/v1';
const SYNC_EVERY_H = 6, CONSENT_DAYS = 90, RENEW_WARN_DAYS = 7;
const configured = () => !!process.env.LUNCHFLOW_API_KEY;

async function lf(path) {
  const r = await fetch(LF + path, { headers: { 'x-api-key': process.env.LUNCHFLOW_API_KEY }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('lunchflow_' + r.status);
  return r.json();
}
// PostgREST caps rows per request; page through.
async function all(path, page = 1000) {
  let out = [], off = 0;
  for (;;) { const rows = await db(`${path}${path.includes('?') ? '&' : '?'}limit=${page}&offset=${off}`); out = out.concat(rows); if (rows.length < page) return out; off += page; }
}
const day = (d, k = 0) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);
const r2 = n => Math.round(n * 100) / 100;
const gbp = n => (n < 0 ? '-£' : '£') + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: Math.abs(n) < 100 ? 2 : 0, maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 });

// ---------- Categories ----------
const CATS = ['Groceries', 'Eating out', 'Takeaways', 'Transport', 'Fuel', 'Shopping', 'Bills', 'Subscriptions', 'Housing', 'Health', 'Family', 'People', 'Charity', 'Entertainment', 'Travel', 'Personal care', 'Education', 'Fees', 'Cash', 'Business', 'Other', 'Income', 'Refunds', 'Transfers'];
const NON_SPEND = ['Income', 'Refunds', 'Transfers'];
const DISCRETIONARY = ['Takeaways', 'Eating out', 'Shopping', 'Entertainment', 'Subscriptions', 'Personal care', 'Travel', 'Other'];
const RULES = [
  [/uber ?eats|deliveroo|just ?eat|justeat|domino|papa john|pizza hut|hungry ?panda|beyond ?menu/, 'Takeaways'],
  [/tesco|sainsbury|asda|aldi|lidl|morrisons|co-?op|waitrose|iceland|m&s food|marks.*spencer.*food|ocado|farmfoods|spar\b|one stop|costcutter|nisa|premier store|whole ?foods|halal (meat|butcher)|supermarket|grocer/, 'Groceries'],
  [/mcdonald|kfc|nando|greggs|starbucks|costa|pret|subway|burger king|five guys|wingstop|leon\b|wasabi|itsu|tim hortons|caffe nero|chicken|grill|cafe|coffee|restaurant|kitchen|dessert|shisha|bakery/, 'Eating out'],
  [/\buber\b(?! ?eats)|bolt\.eu|\bbolt\b|addison lee|tfl|trainline|national rail|west midlands|nx bus|national express|megabus|avanti|crosscountry|lner|gwr|parking|ringgo|paybyphone|justpark|dvla|congestion|toll/, 'Transport'],
  [/\bshell\b|\bbp\b|esso|texaco|jet petrol|gulf|petrol|fuel/, 'Fuel'],
  [/netflix|spotify|disney|youtube|apple\.com|itunes|google (one|storage|play)|amazon prime|prime video|audible|now tv|nowtv|dazn|chatgpt|openai|x\.ai|\bxai\b|grok|supergrok|x premium|twitter|tango|claude|anthropic|cursor|adobe|microsoft|canva|notion|icloud|patreon|onlyfans|xbox|playstation|ps plus|lunch ?flow/, 'Subscriptions'],
  [/\bee\b|vodafone|\bo2\b|three\.co|\bthree\b|giffgaff|sky\b|virgin media|\bbt\b|plusnet|talktalk|hyperoptic|british gas|octopus|edf|e\.on|ovo|severn trent|south staffs|water|council tax|tv licen|insurance|admiral|aviva|direct line/, 'Bills'],
  [/rent|letting|lettings|landlord|mortgage/, 'Housing'],
  [/islamic relief|muslim hands|launchgood|penny appeal|human appeal|muslim aid|mosque|masjid|sadaq|zakat|charity|donat|national zakat/, 'Charity'],
  [/boots|superdrug|pharmacy|chemist|dentist|optician|gym|puregym|the gym|fitness|nuffield|holland ?& ?barrett|myprotein/, 'Health'],
  [/barber|salon|hair|beauty|spa\b/, 'Personal care'],
  [/cinema|odeon|vue\b|cineworld|steam|ticketmaster|eventbrite|bowling|golf/, 'Entertainment'],
  [/ryanair|easyjet|british airways|jet2|booking\.com|airbnb|expedia|hotel|travelodge|premier inn|emirates|qatar|turkish/, 'Travel'],
  [/amazon|amzn|ebay|argos|primark|next\b|zara|h&m|asos|jd sports|currys|ikea|b&q|wilko|the range|home bargains|b&m|poundland|tk ?maxx|shein|temu|apple store|samsung/, 'Shopping'],
  [/udemy|coursera|school|college|university|tuition|book(s|shop)|waterstones/, 'Education'],
  [/\bfee\b|interest|charge|overdraft|late payment/, 'Fees'],
  [/atm|cash withdrawal|cashpoint/, 'Cash'],
  [/hmrc|companies house|vistaprint|google ?workspace|godaddy|namecheap|vercel|stripe/, 'Business']
];
const MCC = [[[5411, 5412, 5422, 5441, 5451, 5462, 5499], 'Groceries'], [[5811, 5812, 5813], 'Eating out'], [[5814], 'Eating out'], [[4111, 4112, 4121, 4131, 4784, 4789, 7512, 7523], 'Transport'], [[5541, 5542, 5983], 'Fuel'],
  [[4812, 4814, 4899, 4900, 6300, 6381], 'Bills'], [[5815, 5816, 5817, 5818], 'Subscriptions'], [[8398, 8661], 'Charity'], [[5912, 8011, 8021, 8043, 8062, 8099, 7997], 'Health'], [[7230, 7297, 7298], 'Personal care'],
  [[7832, 7922, 7929, 7933, 7941, 7991, 7994, 7996, 7999], 'Entertainment'], [[4411, 4511, 4722, 7011, 3000], 'Travel'], [[8211, 8220, 8241, 8244, 8249, 8299, 5942], 'Education'], [[6010, 6011], 'Cash'],
  [[5300, 5310, 5311, 5331, 5399, 5651, 5655, 5661, 5691, 5699, 5712, 5719, 5722, 5732, 5734, 5735, 5945, 5947, 5964, 5999, 5200, 5251, 5261, 5944, 5977, 5941, 5310], 'Shopping']];
const mccCat = m => { const n = +m; if (!n) return null; if (n >= 3000 && n <= 3999) return 'Travel'; for (const [list, c] of MCC) if (list.includes(n)) return c; return null; };
const mkey = t => String(t.merchant || t.description || '').toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').replace(/\b(ltd|limited|plc|uk|gb|london|birmingham|www|com|co|the|payment|card|pos)\b/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ') || 'unknown';

function ruleCat(t, learned) {
  if (t.is_transfer) return ['Transfers', 'rule'];
  const text = `${t.merchant || ''} ${t.description || ''}`.toLowerCase();
  if (t.amount > 0) return [t.code === 'mastercard' ? 'Refunds' : 'Income', 'rule'];
  if (t.code === 'monzo_to_monzo' && !learned[mkey(t)]) return ['People', 'rule'];
  for (const [re, c] of RULES) if (re.test(text)) return [c, 'rule'];
  if (learned[mkey(t)]) return [learned[mkey(t)], 'learned'];
  const m = mccCat(t.mcc); if (m) return [m, 'mcc'];
  if (t.code === 'payport_faster_payments') return ['People', 'rule'];
  return [null, null];
}

async function aiCategorise(items) {
  // items: [{key, sample, amount}] -> {key: category}. Only merchant names/descriptions are sent.
  const key = process.env.GEMINI_API_KEY; if (!key || !items.length) return {};
  const body = JSON.stringify({ contents: [{ parts: [{ text: `Categorise these UK bank-statement merchants (spending) into exactly one of: ${CATS.filter(c => !NON_SPEND.includes(c)).join(', ')}. "People" means payments to individuals. Return one entry per input key.\n` + items.map(i => `${i.key} | ${i.sample} | £${Math.abs(i.amount)}`).join('\n') }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'ARRAY', items: { type: 'OBJECT', properties: { key: { type: 'STRING' }, category: { type: 'STRING', enum: CATS.filter(c => !NON_SPEND.includes(c)) } }, required: ['key', 'category'] } } } });
  for (const m of ['gemini-flash-lite-latest', 'gemini-flash-latest']) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(30000) });
      const j = await r.json(); if (!r.ok || !j.candidates) continue;
      const arr = JSON.parse(j.candidates[0].content.parts.filter(p => p.text).map(p => p.text).join(''));
      return Object.fromEntries(arr.filter(x => items.some(i => i.key === x.key)).map(x => [x.key, x.category]));
    } catch (e) {}
  }
  return {};
}

// ---------- Sync ----------
async function sync({ force = false } = {}) {
  if (!configured()) return { skipped: 'no key' };
  const prof = await getProfile();
  const last = prof.money_last_sync ? new Date(prof.money_last_sync) : null;
  if (!force && last && Date.now() - last < SYNC_EVERY_H * 36e5) return { skipped: 'fresh' };
  if (force && last && Date.now() - last < 15 * 6e4) return { skipped: 'synced under 15 min ago' };
  await setProfile('money_last_sync', new Date().toISOString()); // claim early so overlapping cron runs don't double-hit Lunch Flow
  const { accounts = [] } = await lf('/accounts?include_raw=true');
  const known = Object.fromEntries((await db('bank_accounts?select=id,connection_id,connection_since,first_seen')).map(a => [a.id, a]));
  const connSince = {}; for (const a of Object.values(known)) if (a.connection_id && a.connection_since) connSince[a.connection_id] = connSince[a.connection_id] && connSince[a.connection_id] < a.connection_since ? connSince[a.connection_id] : a.connection_since;
  const today = london().date, out = { accounts: accounts.length, new_tx: 0, categorised_ai: 0 };
  const rows = [];
  // Consent clock: starts when we first see a connection. If it's still working past ~90 days, he has renewed it, so restart the clock.
  const sinceFor = (a, bal) => { const s = connSince[a.connection_id] || (known[a.id] && known[a.id].connection_since); if (!s) return new Date().toISOString(); return a.status === 'ACTIVE' && bal && Date.now() - new Date(s) > (CONSENT_DAYS + 2) * 864e5 ? new Date().toISOString() : s; };
  for (const a of accounts) {
    let bal = null; try { bal = (await lf(`/accounts/${a.id}/balance`)).balance; } catch (e) {}
    const raw = (a.raw && Object.values(a.raw)[0]) || {};
    rows.push({ id: a.id, connection_id: a.connection_id, name: a.name, institution: a.institution_name, provider: a.provider, status: a.status, account_type: raw.cashAccountType || null,
      balance: bal ? bal.amount : null, currency: (bal && bal.currency) || raw.currency || 'GBP', balance_at: bal ? new Date().toISOString() : null,
      connection_since: sinceFor(a, bal), updated_at: new Date().toISOString() });
  }
  if (rows.length) {
    // keep balance when a balance call failed
    for (const r of rows) if (r.balance == null) { delete r.balance; delete r.balance_at; }
    for (const r of rows) await db('bank_accounts?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: r });
    const hist = rows.filter(r => r.balance != null).map(r => ({ day: today, account_id: r.id, balance: r.balance }));
    if (hist.length) await db('balance_history?on_conflict=day,account_id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: hist });
  }
  // Mark accounts that disappeared from Lunch Flow
  const gone = Object.keys(known).filter(id => !accounts.some(a => String(a.id) === id));
  for (const id of gone) await db(`bank_accounts?id=eq.${id}`, { method: 'PATCH', body: { status: 'DISCONNECTED' } });

  const learned = Object.fromEntries((await all('merchant_rules?select=merchant_key,category')).map(r => [r.merchant_key, r.category]));
  let txs = [];
  for (const a of accounts) {
    const latest = (await db(`bank_transactions?select=date&account_id=eq.${a.id}&order=date.desc&limit=1`))[0];
    const from = latest ? day(latest.date, -10) : day(today, -730);
    let j; try { j = await lf(`/accounts/${a.id}/transactions?include_raw=true&from=${from}`); } catch (e) { out.tx_error = true; continue; }
    for (const t of j.transactions || []) {
      if (t.isPending) continue;
      const raw = (t.raw && Object.values(t.raw)[0]) || {};
      const code = raw.proprietaryBankTransactionCode || null;
      txs.push({ id: String(t.id), account_id: a.id, date: t.date, amount: +t.amount, currency: t.currency || 'GBP', merchant: (t.merchant || '').slice(0, 120), description: (t.description || '').slice(0, 160),
        code, mcc: raw.merchantCategoryCode || null, is_transfer: /pot/.test(code || '') });
    }
  }
  // Transfers between his own connected accounts: equal and opposite amounts within 2 days.
  const recentOwn = txs.length ? await all(`bank_transactions?select=id,account_id,date,amount&date=gte.${day(today, -40)}`) : [];
  const pool = txs.concat(recentOwn.filter(r => !txs.some(t => t.id === r.id)));
  for (const t of txs) if (!t.is_transfer && pool.some(o => o.account_id !== t.account_id && Math.abs(o.amount + t.amount) < 0.005 && Math.abs(daysBetween(o.date, t.date)) <= 2)) t.is_transfer = true;
  // Categorise
  const unknown = {};
  for (const t of txs) { const [c, s] = ruleCat(t, learned); t.category = c; t.cat_source = s; if (!c) { const k = mkey(t); (unknown[k] = unknown[k] || { key: k, sample: (t.merchant || t.description).slice(0, 60), amount: t.amount }); } }
  const keys = Object.values(unknown);
  for (let i = 0; i < keys.length && i < 400; i += 100) {
    const got = await aiCategorise(keys.slice(i, i + 100));
    const ups = Object.entries(got).map(([merchant_key, category]) => ({ merchant_key, category, source: 'ai', updated_at: new Date().toISOString() }));
    if (ups.length) await db('merchant_rules?on_conflict=merchant_key', { method: 'POST', prefer: 'resolution=merge-duplicates', body: ups });
    Object.assign(learned, got); out.categorised_ai += ups.length;
  }
  for (const t of txs) if (!t.category) { const c = learned[mkey(t)]; t.category = c || 'Other'; t.cat_source = c ? 'ai' : 'none'; }
  for (let i = 0; i < txs.length; i += 500) await db('bank_transactions?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: txs.slice(i, i + 500) });
  out.new_tx = txs.length;
  await setProfile('money_last_sync', new Date().toISOString());
  await setProfile('money_last_result', JSON.stringify(out));
  return out;
}

// ---------- Analysis ----------
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const ym = d => d.slice(0, 7);

function recurring(spend) {
  const by = {};
  for (const t of spend) { const k = mkey(t); (by[k] = by[k] || []).push(t); }
  const out = [];
  for (const [k, list] of Object.entries(by)) {
    if (list.length < 3) continue;
    list.sort((a, b) => a.date < b.date ? -1 : 1);
    const gaps = list.slice(1).map((t, i) => daysBetween(list[i].date, t.date)).filter(g => g > 2);
    if (gaps.length < 2) continue;
    const g = median(gaps);
    const cadence = g >= 5 && g <= 9 ? 'weekly' : g >= 12 && g <= 16 ? 'fortnightly' : g >= 25 && g <= 38 ? 'monthly' : g >= 84 && g <= 98 ? 'quarterly' : g >= 350 && g <= 380 ? 'yearly' : null;
    if (!cadence) continue;
    const regular = gaps.filter(x => Math.abs(x - g) <= Math.max(4, g * 0.15)).length / gaps.length;
    const amts = list.map(t => -t.amount), am = median(amts.slice(-4));
    const similar = amts.slice(-4).filter(a => Math.abs(a - am) <= Math.max(1.5, am * 0.2)).length / Math.min(4, amts.length);
    if (regular < 0.5 || similar < 0.5) continue;
    const lastD = list[list.length - 1].date, step = { weekly: 7, fortnightly: 14, monthly: 30, quarterly: 91, yearly: 365 }[cadence];
    const today = london().date, sinceLast = daysBetween(lastD, today);
    const active = sinceLast <= step * 1.6 + 3;
    let next = cadence === 'monthly' ? (() => { const d = new Date(lastD + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); })() : day(lastD, step);
    while (active && next < today) next = day(next, step);
    const cat = list[list.length - 1].category;
    const isSub = cat === 'Subscriptions' || (am < 60 && ['Entertainment', 'Shopping', 'Other', 'Education', 'Health'].includes(cat));
    out.push({ name: (list[list.length - 1].merchant || k).slice(0, 60), key: k, amount: r2(am), cadence, category: cat, type: isSub ? 'subscription' : ['Bills', 'Housing', 'Fees', 'Education', 'Business'].includes(cat) ? 'bill' : 'regular', last: lastD, next_due: active ? next : null, active, count: list.length,
      monthly: r2(am * 30.44 / step), account_id: list[list.length - 1].account_id });
  }
  // Subscriptions that bill irregularly (app stores, usage-based): still list them if charged recently.
  const today = london().date;
  for (const [k, list] of Object.entries(by)) {
    if (out.some(o => o.key === k)) continue;
    const recent = list.filter(t => t.date >= day(today, -92));
    if (list[list.length - 1].category !== 'Subscriptions' || recent.length < 2 || list[list.length - 1].date < day(today, -45)) continue;
    const tot = recent.reduce((s, t) => s - t.amount, 0);
    out.push({ name: (list[list.length - 1].merchant || k).slice(0, 60), key: k, amount: r2(median(recent.map(t => -t.amount))), cadence: 'irregular', category: 'Subscriptions', type: 'subscription', last: list[list.length - 1].date, next_due: null, active: true, count: list.length, monthly: r2(tot / 3), account_id: list[list.length - 1].account_id });
  }
  return out.sort((a, b) => b.monthly - a.monthly);
}

async function load(months = 24) {
  const today = london().date;
  const [accounts, txs, prof] = await Promise.all([
    db('bank_accounts?select=id,name,institution,status,account_type,balance,currency,balance_at,connection_id,connection_since&order=balance.desc.nullslast'),
    all(`bank_transactions?select=id,account_id,date,amount,merchant,description,code,category,is_transfer&date=gte.${day(today, -31 * months)}&order=date.asc`),
    getProfile()
  ]);
  for (const t of txs) t.amount = +t.amount;
  for (const a of accounts) a.balance = a.balance == null ? null : +a.balance;
  return { accounts, txs, prof, today };
}

function analyse({ accounts, txs, prof, today }) {
  const spend = txs.filter(t => t.amount < 0 && !t.is_transfer && !NON_SPEND.includes(t.category));
  const credits = txs.filter(t => t.amount > 0 && !t.is_transfer);
  const thisM = ym(today), months = {};
  for (const t of txs) { if (t.is_transfer) continue; const m = months[ym(t.date)] = months[ym(t.date)] || { spend: 0, income: 0, refunds: 0, cats: {} };
    if (t.category === 'Income') m.income += t.amount; else if (t.category === 'Refunds') m.refunds += t.amount; else if (t.amount < 0 && !NON_SPEND.includes(t.category)) { m.spend -= t.amount; m.cats[t.category] = (m.cats[t.category] || 0) - t.amount; } }
  const firstDate = txs.length ? txs[0].date : today;
  const complete = Object.keys(months).filter(m => m < thisM && m > ym(firstDate)).sort();
  const last3 = complete.slice(-3), last6 = complete.slice(-6);
  const avg = (ms, f) => ms.length ? ms.reduce((s, m) => s + f(months[m] || { spend: 0, income: 0, cats: {} }), 0) / ms.length : 0;
  const cur = months[thisM] || { spend: 0, income: 0, refunds: 0, cats: {} };
  const dom = +today.slice(8), dim = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).getUTCDate();
  const byCat = Object.entries(cur.cats).map(([c, v]) => ({ category: c, spent: r2(v), usual: r2(avg(last3, m => m.cats[c] || 0)) })).sort((a, b) => b.spent - a.spent);
  const allCats = [...new Set(last6.flatMap(m => Object.keys(months[m].cats)))].map(c => ({ category: c, monthly: r2(avg(last6, m => m.cats[c] || 0)) })).sort((a, b) => b.monthly - a.monthly);
  // Income: regular payers
  const payers = {}; for (const t of credits.filter(t => t.category === 'Income')) { const k = mkey(t); (payers[k] = payers[k] || []).push(t); }
  const regularIncome = Object.entries(payers).map(([k, l]) => ({ name: (l[l.length - 1].merchant || k).slice(0, 60), months: new Set(l.map(t => ym(t.date))).size, typical: r2(median(l.map(t => t.amount))), last: l[l.length - 1].date }))
    .filter(p => p.months >= 2 && p.typical >= 100).sort((a, b) => b.typical * b.months - a.typical * a.months).slice(0, 5);
  const rec = recurring(spend);
  const cash = accounts.filter(a => a.status !== 'DISCONNECTED' && a.balance != null);
  const total = r2(cash.reduce((s, a) => s + a.balance, 0));
  const main = cash.filter(a => a.account_type === 'CACC').sort((a, b) => b.balance - a.balance)[0] || cash[0] || null;
  const upcoming = rec.filter(r => r.active && r.type !== 'regular' && r.next_due && r.next_due <= day(today, 14)).map(r => ({ name: r.name, amount: r.amount, due: r.next_due, type: r.type })).sort((a, b) => a.due < b.due ? -1 : 1);
  const due7 = upcoming.filter(u => u.due <= day(today, 7)).reduce((s, u) => s + u.amount, 0);
  const lowAt = +prof.money_low_threshold || 100;
  const insights = [];
  const spendable = main ? main.balance : total;
  if (main && spendable < lowAt) insights.push({ level: 'high', kind: 'low_balance', text: `${main.name} is down to ${gbp(spendable)}.` });
  if (due7 > 0 && spendable < due7) insights.push({ level: 'high', kind: 'bill_risk', text: `${gbp(r2(due7))} of bills due in the next 7 days, but only ${gbp(spendable)} available.` });
  // Pace: this month vs usual
  const usualToDate = avg(last3, m => m.spend) * dom / dim;
  if (last3.length && usualToDate > 50 && cur.spend > usualToDate * 1.25) insights.push({ level: 'medium', kind: 'pace', text: `Spending is running ${Math.round((cur.spend / usualToDate - 1) * 100)}% ahead of your usual pace this month (${gbp(r2(cur.spend))} so far).` });
  for (const c of byCat) if (c.usual > 30 && c.spent > c.usual * 1.4 && c.spent - c.usual > 40) insights.push({ level: 'medium', kind: 'category', text: `${c.category}: ${gbp(c.spent)} this month vs about ${gbp(c.usual)} usually.` });
  // Unusual single transactions in the last 7 days
  const catMed = {}; for (const t of spend) (catMed[t.category] = catMed[t.category] || []).push(-t.amount);
  for (const t of spend.filter(t => t.date >= day(today, -7))) { const m = median(catMed[t.category] || []); if (-t.amount >= 60 && -t.amount > Math.max(3 * m, 0) && (catMed[t.category] || []).length >= 5) insights.push({ level: 'low', kind: 'unusual', text: `Unusual: ${gbp(-t.amount)} at ${t.merchant || t.description} on ${t.date}.` }); }
  // Subscriptions creeping
  const subs = rec.filter(r => r.type === 'subscription' && r.active);
  if (subs.length) insights.push({ level: 'low', kind: 'subs', text: `${subs.length} active subscriptions, about ${gbp(r2(subs.reduce((s, r) => s + r.monthly, 0)))} a month.` });
  // Consent renewal (Lunch Flow / open banking: ~90 days)
  const renewals = [];
  const conns = {}; for (const a of accounts) if (a.connection_id) conns[a.connection_id] = conns[a.connection_id] || { institution: a.institution, since: a.connection_since, status: a.status };
  for (const [id, c] of Object.entries(conns)) {
    const due = c.since ? day(c.since.slice(0, 10), CONSENT_DAYS) : null, left = due ? daysBetween(today, due) : null;
    renewals.push({ connection_id: id, institution: c.institution, renew_by: due, days_left: left, status: c.status });
    if (c.status && c.status !== 'ACTIVE') insights.push({ level: 'high', kind: 'reconnect', text: `${c.institution} needs reconnecting in Lunch Flow (status: ${c.status.toLowerCase()}).` });
    else if (left != null && left <= RENEW_WARN_DAYS) insights.push({ level: 'medium', kind: 'renew', text: `${c.institution} bank access needs renewing in Lunch Flow by about ${due} (${Math.max(0, left)} days).` });
  }
  const goal = prof.money_goal ? JSON.parse(prof.money_goal) : null;
  const avgIncome = r2(avg(last3, m => m.income)), avgSpend = r2(avg(last3, m => m.spend));
  return {
    as_of: prof.money_last_sync || null, today,
    balances: { total, accounts: cash.map(a => ({ name: a.name, institution: a.institution, type: a.account_type === 'CACC' ? 'current' : a.account_type === 'SVGS' ? 'savings' : (a.account_type || 'account').toLowerCase(), balance: a.balance })), main: main ? { name: main.name, balance: main.balance } : null, low_threshold: lowAt },
    this_month: { month: thisM, spent: r2(cur.spend), income: r2(cur.income), refunds: r2(cur.refunds), by_category: byCat, usual_spend_to_date: r2(usualToDate) },
    usual: { monthly_income: avgIncome, monthly_spend: avgSpend, monthly_net: r2(avgIncome - avgSpend), months_used: last3.length, by_category: allCats.slice(0, 12) },
    income: regularIncome, recurring: rec, upcoming, insights: insights.sort((a, b) => ['high', 'medium', 'low'].indexOf(a.level) - ['high', 'medium', 'low'].indexOf(b.level)),
    renewals, goal, months, history_from: firstDate
  };
}

async function summary() { const d = await load(); const a = analyse(d); a.connected = configured(); a.accounts_count = d.accounts.length; a.tx_count = d.txs.length; return a; }

function spending(d, period = 'this_month', category) {
  const today = d.today; let from, to = today, label = period;
  const m0 = today.slice(0, 7) + '-01';
  if (period === 'last_month') { const x = new Date(m0 + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() - 1); from = x.toISOString().slice(0, 10); to = day(m0, -1); }
  else if (/^\d{4}-\d{2}$/.test(period)) { from = period + '-01'; const x = new Date(from + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + 1); to = day(x.toISOString().slice(0, 10), -1); }
  else if (period === 'this_week') from = day(today, -((new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7));
  else if (period === 'last_7_days') from = day(today, -6);
  else if (period === 'last_30_days') from = day(today, -29);
  else if (period === 'last_3_months') from = day(today, -91);
  else if (period === 'this_year') from = today.slice(0, 4) + '-01-01';
  else { from = m0; label = 'this_month'; }
  let rows = d.txs.filter(t => t.date >= from && t.date <= to && !t.is_transfer && t.amount < 0 && !NON_SPEND.includes(t.category));
  if (category) rows = rows.filter(t => t.category.toLowerCase() === String(category).toLowerCase());
  const byCat = {}, byMerch = {};
  for (const t of rows) { byCat[t.category] = (byCat[t.category] || 0) - t.amount; const k = t.merchant || t.description; byMerch[k] = (byMerch[k] || 0) - t.amount; }
  const income = d.txs.filter(t => t.date >= from && t.date <= to && t.category === 'Income' && !t.is_transfer).reduce((s, t) => s + t.amount, 0);
  return { period: label, from, to, category: category || null, total_spent: r2(rows.reduce((s, t) => s - t.amount, 0)), income: category ? undefined : r2(income), transactions: rows.length,
    by_category: Object.entries(byCat).map(([c, v]) => ({ category: c, spent: r2(v) })).sort((a, b) => b.spent - a.spent),
    top_merchants: Object.entries(byMerch).map(([m, v]) => ({ merchant: m, spent: r2(v) })).sort((a, b) => b.spent - a.spent).slice(0, 8) };
}

// ---------- Monte Carlo ("Doctor Strange") ----------
// Bootstraps whole historical months (keeping real income timing and spending mix), with recent months weighted more,
// applies the scenario, and simulates daily balances. 10,000 futures by default.
function buildBlocks(d, sc = {}) {
  const thisM = ym(d.today), first = d.txs.length ? ym(d.txs[0].date) : thisM;
  const ms = [...new Set(d.txs.map(t => ym(t.date)))].filter(m => m < thisM && m > first).sort().slice(-12);
  const cut = {}; for (const c of sc.cuts || []) cut[String(c.category).toLowerCase()] = Math.max(0, Math.min(100, +c.percent || 0)) / 100;
  const cancel = (sc.cancel || []).map(x => String(x).toLowerCase()).filter(Boolean);
  const incMul = 1 + (+sc.income_change_pct || 0) / 100;
  return ms.map(m => {
    const len = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate(), inc = new Float64Array(32), sp = new Float64Array(32);
    for (const t of d.txs) {
      if (ym(t.date) !== m || t.is_transfer) continue;
      const dd = +t.date.slice(8);
      if (t.amount > 0) { inc[dd] += t.category === 'Refunds' ? t.amount : t.amount * incMul; continue; }
      if (NON_SPEND.includes(t.category)) continue;
      const name = `${t.merchant} ${t.description}`.toLowerCase();
      if (cancel.some(c => name.includes(c))) continue;
      const f = cut[t.category.toLowerCase()] || 0;
      sp[dd] += -t.amount * (1 - f);
    }
    return { m, len, inc, sp };
  });
}
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
function simulate(d, sc = {}, base) {
  const runs = Math.min(50000, Math.max(1000, +sc.runs || 10000)), months = [3, 6, 12, 24].includes(+sc.months) ? +sc.months : 6;
  const blocks = buildBlocks(d, sc);
  if (blocks.length < 2) return { error: 'Not enough history yet (need at least two full months).' };
  const a = analyse(d);
  const start = +sc.start_balance || a.balances.total;
  const extraMonthly = +sc.monthly_change || 0; // +ve = extra money in each month, -ve = extra cost
  const purchase = Math.abs(+sc.purchase_amount || 0), pMonth = Math.max(0, Math.min(months - 1, +sc.purchase_month || 0));
  const goalAmt = sc.goal != null ? +sc.goal : (a.goal && a.goal.amount ? +a.goal.amount : null);
  const nb = blocks.length, recentFrom = Math.max(0, nb - 6), rand = rng(1234567 + months * 7 + Math.round(purchase) + Math.round(extraMonthly));
  const today = +d.today.slice(8);
  const ends = new Float64Array(runs), mins = new Float64Array(runs); let never0 = 0, goalHit = 0;
  const monthEnds = [...Array(months)].map(() => new Float64Array(runs));
  for (let r = 0; r < runs; r++) {
    let bal = start, mn = start;
    for (let k = 0; k < months; k++) {
      const b = blocks[rand() < 0.7 ? recentFrom + Math.floor(rand() * (nb - recentFrom)) : Math.floor(rand() * nb)];
      const noise = 0.9 + rand() * 0.2; // ±10% month-to-month spending wobble
      const d0 = k === 0 ? Math.min(today + 1, b.len) : 1;
      if (k === pMonth && purchase) { bal -= purchase; if (bal < mn) mn = bal; }
      for (let dd = d0; dd <= b.len; dd++) { bal += b.inc[dd] - b.sp[dd] * noise; if (dd === 1 || dd === 15) bal += extraMonthly / 2; if (bal < mn) mn = bal; }
      if (k === 0 && d0 > b.len) bal += extraMonthly;
      monthEnds[k][r] = bal;
    }
    ends[r] = bal; mins[r] = mn; if (mn >= 0) never0++; if (goalAmt != null && bal - start >= goalAmt) goalHit++;
  }
  const q = (arr, p) => { const s = Float64Array.from(arr).sort(); return r2(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
  const res = {
    months, runs, start_balance: r2(start), history_months_used: nb,
    p_never_below_zero: Math.round(never0 / runs * 1000) / 10,
    end_balance: { p10: q(ends, 0.1), median: q(ends, 0.5), p90: q(ends, 0.9) },
    expected_savings: r2(q(ends, 0.5) - start),
    lowest_point: { p10: q(mins, 0.1), median: q(mins, 0.5) },
    path: monthEnds.map((arr, i) => ({ month: i + 1, p10: q(arr, 0.1), median: q(arr, 0.5), p90: q(arr, 0.9) })),
    goal: goalAmt != null ? { amount: goalAmt, p_reached: Math.round(goalHit / runs * 1000) / 10 } : null,
    scenario: { cuts: sc.cuts || [], cancel: sc.cancel || [], purchase_amount: purchase || 0, purchase_month: pMonth, monthly_change: extraMonthly, income_change_pct: +sc.income_change_pct || 0, label: sc.label || null }
  };
  if (base) { res.vs_baseline = { p_never_below_zero: r2(res.p_never_below_zero - base.p_never_below_zero), expected_savings: r2(res.expected_savings - base.expected_savings) }; }
  return res;
}
function bestPath(d, months = 6) {
  const a = analyse(d), levers = [];
  for (const c of a.usual.by_category) {
    if (!DISCRETIONARY.includes(c.category) || c.monthly < 15) continue;
    const pct = c.category === 'Subscriptions' ? 30 : c.category === 'Takeaways' ? 50 : 25;
    levers.push({ action: `Cut ${c.category.toLowerCase()} by ${pct}%`, cuts: [{ category: c.category, percent: pct }], monthly_saving: r2(c.monthly * pct / 100), usual_monthly: c.monthly });
  }
  levers.sort((x, y) => y.monthly_saving - x.monthly_saving);
  const top = levers.slice(0, 3);
  const base = simulate(d, { months, runs: 5000 });
  const combo = top.length ? simulate(d, { months, runs: 5000, cuts: top.flatMap(l => l.cuts) }, base) : null;
  return { months, baseline: base.error ? base : { p_never_below_zero: base.p_never_below_zero, expected_savings: base.expected_savings, end_median: base.end_balance.median }, levers: top.map(l => ({ ...l, over_period: r2(l.monthly_saving * months) })),
    combined: combo && !combo.error ? { p_never_below_zero: combo.p_never_below_zero, expected_savings: combo.expected_savings, gain: combo.vs_baseline } : null };
}

module.exports = { configured, sync, load, analyse, summary, spending, simulate, bestPath, recurring, ruleCat, mkey, gbp, CATS, day, daysBetween };
