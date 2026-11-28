// NEURO authority matrix, risk engine, approvals and action ledger (server-side; the model prompt is not the gate).
// Deny by default. Every consequential action is a ledger row bound to its exact parameters (hash), expires,
// can be approved once (conditional status transition prevents replay) and records what happened.
const crypto = require('crypto');
const { db, getProfile } = require('./_db');

// kind -> policy. 'never' = refused outright; 'approval' = needs his explicit tap for this exact action;
// 'routine' = Freya may do it herself (low risk, inside the app); 'blocked' = needs native capability not built yet.
const POLICY = {
  email_send:   { authority: 'approval', risk: 'medium', label: 'Send an email from your Gmail' },
  email_draft:  { authority: 'routine',  risk: 'low',    label: 'Save an email draft (not sent)' },
  message:      { authority: 'approval', risk: 'medium', label: 'Message someone (you press send in WhatsApp/SMS)' },
  reminder:     { authority: 'routine',  risk: 'low',    label: 'Set a reminder for you' },
  call_screen:  { authority: 'blocked',  risk: 'medium', label: 'Screen a phone call', reason: 'Call screening needs a native Android call-screening role and an app update; not built yet.' },
  sms_auto:     { authority: 'blocked',  risk: 'high',   label: 'Send an SMS automatically', reason: 'Automatic SMS needs native Android SMS permission and an app update; not built yet.' },
  payment:      { authority: 'never',    risk: 'high',   label: 'Move money or pay', reason: 'Finance is read-only. Freya can never move money.' },
  investment:   { authority: 'never',    risk: 'high',   label: 'Trade or invest', reason: 'No trading or investing. Jibreel is a concept only.' },
  delete_data:  { authority: 'never',    risk: 'high',   label: 'Delete records', reason: 'Freya never deletes your records herself; you delete them from the screen.' }
};
const TTL_MIN = 30;

const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v === undefined ? null : v);
const hash = (kind, params) => crypto.createHash('sha256').update(kind + '|' + canon(params)).digest('hex').slice(0, 32);

function clean(kind, p = {}) {
  const s = (x, n) => String(x == null ? '' : x).slice(0, n).trim();
  if (kind === 'email_send' || kind === 'email_draft') {
    const to = s(p.to, 300);
    if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(to.replace(/^.*<(.+)>$/, '$1'))) throw Object.assign(new Error('A valid email address is needed.'), { status: 400 });
    const o = { to, subject: s(p.subject, 200), body: s(p.body, 8000) };
    if (p.reply_to_id) o.reply_to_id = s(p.reply_to_id, 100); // no undefined keys: the hash must survive a database round trip
    return o;
  }
  if (kind === 'message') {
    const channel = p.channel === 'sms' ? 'sms' : 'whatsapp';
    const phone = s(p.phone, 30).replace(/[^\d+]/g, '');
    return { channel, to_name: s(p.to_name, 80), phone, text: s(p.text, 2000) };
  }
  if (kind === 'reminder') return { text: s(p.text, 200), at: s(p.at, 40) };
  return Object.fromEntries(Object.entries(p).slice(0, 10).map(([k, v]) => [k, s(v, 500)]));
}

async function authorityOverrides() { // future: delegated scopes he configures. Today: nothing is pre-delegated beyond routine.
  const p = await getProfile().catch(() => ({}));
  try { return JSON.parse(p.neuro_authority || '{}'); } catch (e) { return {}; }
}

// Propose: classify, record. Never executes anything.
async function propose({ kind, params, why }) {
  const pol = POLICY[kind];
  if (!pol) return { ok: false, status: 'denied', error: 'Unknown action. Denied by default.' };
  if (pol.authority === 'never' || pol.authority === 'blocked') {
    await db('neuro_actions', { method: 'POST', body: { kind, params: {}, params_hash: hash(kind, {}), why: String(why || '').slice(0, 300), risk: pol.risk, authority: pol.authority, status: 'denied', decided_at: new Date().toISOString(), result: { reason: pol.reason } } }).catch(() => {});
    return { ok: false, status: 'denied', authority: pol.authority, error: pol.reason };
  }
  const p = clean(kind, params);
  if (kind === 'message' && !p.text) return { ok: false, error: 'Message text is empty.' };
  const h = hash(kind, p);
  const rows = await db('neuro_actions', { method: 'POST', prefer: 'return=representation', body: { kind, params: p, params_hash: h, why: String(why || '').slice(0, 300), risk: pol.risk, authority: pol.authority, expires_at: new Date(Date.now() + TTL_MIN * 60e3).toISOString() } });
  const a = rows[0];
  return { ok: true, id: a.id, hash: h, kind, label: pol.label, params: p, risk: pol.risk, authority: pol.authority, expires_at: a.expires_at, needs_approval: pol.authority === 'approval' };
}

async function list({ status, limit = 30 } = {}) {
  await db(`neuro_actions?status=eq.pending&expires_at=lt.${new Date().toISOString()}`, { method: 'PATCH', body: { status: 'expired' } }).catch(() => {});
  const q = status ? `&status=eq.${encodeURIComponent(status)}` : '';
  const rows = await db(`neuro_actions?select=id,kind,params,params_hash,why,risk,authority,status,result,created_at,expires_at,decided_at,executed_at&order=created_at.desc&limit=${Math.min(100, +limit || 30)}${q}`);
  return { actions: rows.map(r => ({ ...r, label: (POLICY[r.kind] || {}).label || r.kind })), policy: Object.fromEntries(Object.entries(POLICY).map(([k, v]) => [k, { authority: v.authority, risk: v.risk, label: v.label, reason: v.reason }])) };
}

async function claim(id, from, to, extra = {}) {
  const r = await db(`neuro_actions?id=eq.${encodeURIComponent(id)}&status=eq.${from}`, { method: 'PATCH', prefer: 'return=representation', body: { status: to, ...extra } });
  return r && r[0];
}

async function deny(id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) return { ok: false, error: 'bad id' };
  const a = await claim(id, 'pending', 'denied', { decided_at: new Date().toISOString() });
  return a ? { ok: true, status: 'denied' } : { ok: false, error: 'Not pending any more.' };
}

// Approve = he tapped Approve on the card showing these exact parameters. Hash must match, not expired, once only.
async function approve(id, h, exec = executor) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) return { ok: false, error: 'bad id' };
  const rows = await db(`neuro_actions?select=*&id=eq.${encodeURIComponent(id)}`);
  const a = rows[0];
  if (!a) return { ok: false, error: 'No such action.' };
  if (a.status !== 'pending') return { ok: false, error: `Already ${a.status}.` };
  if (new Date(a.expires_at) < new Date()) { await claim(id, 'pending', 'expired'); return { ok: false, error: 'This approval expired. Ask Freya again.' }; }
  if (!h || h !== a.params_hash || hash(a.kind, a.params) !== a.params_hash) return { ok: false, error: 'The action changed since you saw it. Not approved.' };
  const got = await claim(id, 'pending', 'approved', { decided_at: new Date().toISOString() });
  if (!got) return { ok: false, error: 'Already handled.' }; // replay / double tap
  let result;
  try { result = await exec(a.kind, a.params); }
  catch (e) { await claim(id, 'approved', 'failed', { result: { error: String(e.message || e).slice(0, 300) } }); return { ok: false, error: 'It failed: ' + String(e.message || e).slice(0, 160) }; }
  await claim(id, 'approved', 'executed', { executed_at: new Date().toISOString(), result });
  return { ok: true, status: 'executed', result };
}

// Routine actions she may do herself (still ledgered).
async function routine(kind, params, why, exec = executor) {
  const pol = POLICY[kind];
  if (!pol || pol.authority !== 'routine') return propose({ kind, params, why });
  const p = clean(kind, params), h = hash(kind, p);
  const rows = await db('neuro_actions', { method: 'POST', prefer: 'return=representation', body: { kind, params: p, params_hash: h, why: String(why || '').slice(0, 300), risk: pol.risk, authority: 'routine', status: 'approved', decided_at: new Date().toISOString() } });
  const id = rows[0].id;
  try { const result = await exec(kind, p); await claim(id, 'approved', 'executed', { executed_at: new Date().toISOString(), result }); return { ok: true, status: 'executed', result }; }
  catch (e) { await claim(id, 'approved', 'failed', { result: { error: String(e.message || e).slice(0, 300) } }); return { ok: false, error: String(e.message || e).slice(0, 160) }; }
}

async function executor(kind, p) {
  if (kind === 'email_draft' || kind === 'email_send') {
    const G = require('./_google');
    const d = await G.createDraft(p);
    if (kind === 'email_draft') return { draft: true, link: d.link };
    await G.sendDraft(d.draftId);
    return { sent: true, to: p.to, subject: d.subject };
  }
  if (kind === 'message') {
    // He presses send himself: we hand the approved text to WhatsApp/SMS. Nothing is sent automatically.
    const t = encodeURIComponent(p.text);
    const url = p.channel === 'sms' ? `sms:${p.phone || ''}?body=${t}` : (p.phone ? `https://wa.me/${p.phone.replace(/^\+/, '')}?text=${t}` : `https://wa.me/?text=${t}`);
    return { handoff: true, url };
  }
  throw new Error('No executor for ' + kind);
}

module.exports = { POLICY, propose, approve, deny, list, routine, hash, clean, _canon: canon };
