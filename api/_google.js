// Google Workspace: OAuth tokens (encrypted, server-only), Calendar, Gmail (read + drafts only, never send), Drive (read).
const crypto = require('crypto');
const { db, getSecret, setSecret, getProfile, setProfile, assertOwner } = require('./_db');

const REDIRECT = 'https://freya-black.vercel.app/api/google/callback';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/drive.readonly'];
const TZ = 'Europe/London';

async function creds() {
  let id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) { try { id = id || await getSecret('google_client_id'); secret = secret || await getSecret('google_client_secret'); } catch (e) {} }
  return id && secret ? { id: id.trim(), secret: secret.trim() } : null;
}
// ---- encryption for the refresh token ----
const encKey = async () => Buffer.from(await getSecret('google_enc_key', () => crypto.randomBytes(32).toString('hex')), 'hex');
async function enc(text) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', await encKey(), iv); const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]); return [iv, c.getAuthTag(), ct].map(b => b.toString('base64url')).join('.'); }
async function dec(s) { const [iv, tag, ct] = s.split('.').map(x => Buffer.from(x, 'base64url')); const d = crypto.createDecipheriv('aes-256-gcm', await encKey(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]).toString('utf8'); }

function authUrl(c, state) {
  const p = new URLSearchParams({ client_id: c.id, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}
async function exchange(code) {
  assertOwner('google');
  const c = await creds();
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: c.id, client_secret: c.secret, redirect_uri: REDIRECT, grant_type: 'authorization_code' }) });
  const j = await r.json();
  if (!r.ok || !j.refresh_token) throw new Error('exchange_failed: ' + (j.error || 'no refresh token'));
  let email = null;
  if (j.id_token) { try { email = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString()).email; } catch (e) {} }
  await setSecret('google_refresh', await enc(j.refresh_token));
  await setProfile('google_email', email || 'connected');
  await setProfile('google_status', 'connected');
  await setProfile('google_scopes', j.scope || '');
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return { email, scope: j.scope };
}
let cached = null;
async function accessToken() {
  assertOwner('google'); // the Google refresh token is the owner's; never usable from another account
  if (cached && cached.exp > Date.now()) return cached.token;
  const c = await creds(); if (!c) throw new Error('google_not_configured');
  let refresh; try { refresh = await dec(await getSecret('google_refresh')); } catch (e) { throw new Error('google_not_connected'); }
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: refresh, grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!r.ok) { if (j.error === 'invalid_grant') await setProfile('google_status', 'expired'); throw new Error('google_refresh_failed: ' + j.error); }
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return cached.token;
}
async function disconnect() {
  assertOwner('google');
  try { const t = await dec(await getSecret('google_refresh')); await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST' }); } catch (e) {}
  await db('app_secrets?key=eq.google_refresh', { method: 'DELETE' });
  await db('calendar_events?id=neq.__none__', { method: 'DELETE' });
  await setProfile('google_status', 'disconnected'); await setProfile('google_email', '');
  cached = null;
}
async function status() {
  const p = await getProfile();
  return { configured: !!(await creds()), connected: p.google_status === 'connected', status: p.google_status || 'not_connected', email: p.google_email || null };
}
async function g(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { authorization: 'Bearer ' + await accessToken(), ...(opts.body && typeof opts.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  if (!r.ok) { const t = await r.text(); throw new Error(`google_${r.status}: ${t.slice(0, 200)}`); }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

// ---- time helpers (UK) ----
function offsetFor(date) { // "+00:00" or "+01:00" for Europe/London on that date
  const d = new Date(date + 'T12:00:00Z');
  const s = d.toLocaleString('en-US', { timeZone: TZ, hourCycle: 'h23' });
  const h = Math.round((new Date(s + ' UTC') - d) / 36e5);
  return (h >= 0 ? '+' : '-') + String(Math.abs(h)).padStart(2, '0') + ':00';
}
const ukDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const addDay = (date, k) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
const dayStart = date => `${date}T00:00:00${offsetFor(date)}`;
const ukHM = iso => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const ukDay = iso => new Date(iso).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });

// ---- Calendar ----
function slimEvent(e) {
  const self = (e.attendees || []).find(a => a.self);
  return {
    id: e.id, summary: e.summary || '(no title)', all_day: !!(e.start && e.start.date),
    start_at: e.start.dateTime || dayStart(e.start.date), end_at: e.end.dateTime || dayStart(e.end.date),
    location: e.location || null, meet_link: e.hangoutLink || (e.conferenceData && e.conferenceData.entryPoints && (e.conferenceData.entryPoints.find(x => x.entryPointType === 'video') || {}).uri) || null,
    attendees: (e.attendees || []).filter(a => !a.self && !a.resource).length,
    busy: e.transparency !== 'transparent' && !(self && self.responseStatus === 'declined'),
    attachments: (e.attachments || []).map(a => ({ fileId: a.fileId, title: a.title, mimeType: a.mimeType })),
    html_link: e.htmlLink || null
  };
}
async function listEvents(timeMin, timeMax, max = 100) {
  const p = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: String(max), timeZone: TZ });
  const j = await g('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + p);
  return (j.items || []).filter(e => e.status !== 'cancelled').map(slimEvent);
}
function rangeFor(range) {
  const today = ukDate();
  if (range === 'tomorrow') return [dayStart(addDay(today, 1)), dayStart(addDay(today, 2))];
  if (range === 'week') return [dayStart(today), dayStart(addDay(today, 7))];
  if (/^\d{4}-\d\d-\d\d$/.test(range || '')) return [dayStart(range), dayStart(addDay(range, 1))];
  return [dayStart(today), dayStart(addDay(today, 1))];
}
const fmtEvent = e => ({ id: e.id, title: e.summary, when: e.all_day ? `${ukDay(e.start_at)} (all day)` : `${ukDay(e.start_at)} ${ukHM(e.start_at)}–${ukHM(e.end_at)}`, location: e.location || undefined, meet: !!e.meet_link || undefined, with: e.attendees || undefined });
async function getCalendar(range) { const [a, b] = rangeFor(range); return (await listEvents(a, b)).map(fmtEvent); }
async function findFree({ date, duration = 30, from = '09:00', to = '18:00' }) {
  date = /^\d{4}-\d\d-\d\d$/.test(date || '') ? date : ukDate();
  const off = offsetFor(date), s = new Date(`${date}T${from}:00${off}`), e = new Date(`${date}T${to}:00${off}`);
  const evs = (await listEvents(s.toISOString(), e.toISOString())).filter(x => x.busy && !x.all_day);
  const slots = []; let cur = new Date(Math.max(s, Date.now()));
  cur = new Date(Math.ceil(cur / 9e5) * 9e5); // round up to 15 min
  for (const ev of evs) { const a = new Date(ev.start_at), b = new Date(ev.end_at); if (a - cur >= duration * 6e4) slots.push([cur, a]); if (b > cur) cur = b; }
  if (e - cur >= duration * 6e4) slots.push([cur, e]);
  return slots.map(([a, b]) => `${ukHM(a.toISOString())}–${ukHM(b.toISOString())}`);
}
function eventBody(a) {
  const b = {};
  if (a.title) b.summary = a.title;
  if (a.start) b.start = { dateTime: a.start.length === 16 ? a.start + ':00' : a.start, timeZone: TZ };
  if (a.end) b.end = { dateTime: a.end.length === 16 ? a.end + ':00' : a.end, timeZone: TZ };
  if (a.location) b.location = a.location;
  if (a.description) b.description = a.description;
  if (Array.isArray(a.attendees) && a.attendees.length) b.attendees = a.attendees.filter(x => /@/.test(x)).map(email => ({ email }));
  if (a.add_meet) b.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  return b;
}
async function createEvent(a) {
  if (!a.title || !a.start || !a.end) throw new Error('title, start and end are needed');
  const ev = await g('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none', { method: 'POST', body: JSON.stringify(eventBody(a)) });
  return fmtEvent(slimEvent(ev));
}
async function updateEvent(a) {
  if (!a.event_id) throw new Error('event_id needed');
  const ev = await g(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(a.event_id)}?conferenceDataVersion=1&sendUpdates=none`, { method: 'PATCH', body: JSON.stringify(eventBody(a)) });
  return fmtEvent(slimEvent(ev));
}
// Cache upcoming/recent events for meeting detection (called by cron)
async function syncCalendar() {
  const now = Date.now(), a = new Date(now - 24 * 36e5).toISOString(), b = new Date(now + 7 * 864e5).toISOString();
  const evs = await listEvents(a, b, 250);
  if (evs.length) await db('calendar_events?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: evs.map(e => ({ ...e, updated_at: new Date().toISOString() })) });
  const keep = new Set(evs.map(e => e.id));
  const cached = await db(`calendar_events?select=id&start_at=gte.${a}&start_at=lte.${b}`);
  for (const c of cached) if (!keep.has(c.id)) await db(`calendar_events?id=eq.${encodeURIComponent(c.id)}`, { method: 'DELETE' });
  return evs.length;
}

// ---- Gmail (read + drafts; there is deliberately no send function) ----
const hdr = (m, n) => ((m.payload && m.payload.headers) || []).find(h => h.name.toLowerCase() === n.toLowerCase()) || {};
async function searchMail(q, max = 8) {
  const l = await g('https://gmail.googleapis.com/gmail/v1/users/me/messages?' + new URLSearchParams({ q, maxResults: String(max) }));
  const ids = (l.messages || []).map(m => m.id);
  return Promise.all(ids.map(async id => {
    const m = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    return { id, from: hdr(m, 'From').value, subject: hdr(m, 'Subject').value, date: hdr(m, 'Date').value, snippet: m.snippet, unread: (m.labelIds || []).includes('UNREAD') };
  }));
}
const importantUnread = () => searchMail('is:unread in:inbox newer_than:2d -category:promotions -category:social -category:forums', 10);
function partText(p) {
  if (!p) return '';
  if (p.mimeType === 'text/plain' && p.body && p.body.data) return Buffer.from(p.body.data, 'base64url').toString('utf8');
  if (p.parts) { const t = p.parts.map(partText).filter(Boolean); if (t.length) return t[0]; }
  if (p.mimeType === 'text/html' && p.body && p.body.data) return Buffer.from(p.body.data, 'base64url').toString('utf8').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return '';
}
async function readMail(id) {
  const m = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
  return { id, threadId: m.threadId, from: hdr(m, 'From').value, to: hdr(m, 'To').value, subject: hdr(m, 'Subject').value, date: hdr(m, 'Date').value, body: partText(m.payload).slice(0, 6000) };
}
async function createDraft({ to, subject, body, reply_to_id }) {
  let threadId, extra = '';
  if (reply_to_id) {
    const o = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(reply_to_id)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=From`);
    threadId = o.threadId; const mid = hdr(o, 'Message-ID').value;
    if (mid) extra = `In-Reply-To: ${mid}\r\nReferences: ${mid}\r\n`;
    if (!subject) subject = 'Re: ' + (hdr(o, 'Subject').value || '');
    if (!to) to = hdr(o, 'From').value;
  }
  const enc5 = s => /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=` : s;
  const raw = `To: ${to || ''}\r\nSubject: ${enc5(subject || '')}\r\n${extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body || ''}`;
  const d = await g('https://gmail.googleapis.com/gmail/v1/users/me/drafts', { method: 'POST', body: JSON.stringify({ message: { raw: Buffer.from(raw).toString('base64url'), threadId } }) });
  return { draftId: d.id, to, subject, body, link: 'https://mail.google.com/mail/u/0/#drafts' };
}

// Sends an existing draft. Only called by the action ledger after he approved that exact email (gmail.compose scope).
async function sendDraft(draftId) {
  return g('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', { method: 'POST', body: JSON.stringify({ id: draftId }) });
}

// ---- Drive ----
async function searchDrive(q, max = 8) {
  const esc = String(q || '').replace(/['\\]/g, ' ');
  const p = new URLSearchParams({ q: `(name contains '${esc}' or fullText contains '${esc}') and trashed = false`, pageSize: String(max), orderBy: 'modifiedTime desc', fields: 'files(id,name,mimeType,modifiedTime,webViewLink)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
  return (await g('https://www.googleapis.com/drive/v3/files?' + p)).files || [];
}
async function readFile(id, limit = 15000) {
  const meta = await g(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime&supportsAllDrives=true`);
  let text = '';
  if (meta.mimeType === 'application/vnd.google-apps.document') text = await g(`https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/plain`);
  else if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') text = await g(`https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/csv`);
  else if (meta.mimeType === 'application/vnd.google-apps.presentation') text = await g(`https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/plain`);
  else if (/^text\/|json|csv/.test(meta.mimeType)) text = await g(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`);
  else return { name: meta.name, mimeType: meta.mimeType, text: '(This file type can\'t be read as text.)' };
  return { name: meta.name, mimeType: meta.mimeType, modified: meta.modifiedTime, text: String(text).slice(0, limit) };
}

// ---- Meeting notes (Google Meet transcript / Gemini notes) ----
async function findMeetingNotes(ev) {
  const att = (ev.attachments || []).find(a => /notes by gemini|transcript/i.test(a.title || ''));
  if (att && att.fileId) return att.fileId;
  const title = String(ev.summary || '').replace(/['\\]/g, ' ').slice(0, 60);
  if (!title) return null;
  const p = new URLSearchParams({ q: `name contains '${title}' and (name contains 'Notes by Gemini' or name contains 'Transcript') and modifiedTime > '${new Date(ev.start_at).toISOString()}' and trashed = false`, pageSize: '3', orderBy: 'modifiedTime desc', fields: 'files(id,name)' });
  const f = (await g('https://www.googleapis.com/drive/v3/files?' + p)).files || [];
  return f[0] ? f[0].id : null;
}
async function summariseNotes(title, text) {
  const key = process.env.GEMINI_API_KEY;
  const body = JSON.stringify({ contents: [{ parts: [{ text: `Meeting: ${title}\nFrom these meeting notes/transcript, extract for Eesah (the user): a 2-sentence summary, key decisions, and follow-ups (who/what/when; mark the ones that are Eesah's). Be specific and brief.\n\n${text.slice(0, 30000)}` }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { summary: { type: 'STRING' }, decisions: { type: 'ARRAY', items: { type: 'STRING' } }, follow_ups: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['summary', 'decisions', 'follow_ups'] } } });
  let last;
  for (const m of ['gemini-flash-latest', 'gemini-flash-lite-latest']) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(m === 'gemini-flash-latest' ? 12000 : 20000) });
      const j = await r.json();
      if (r.ok && j.candidates) return JSON.parse(j.candidates[0].content.parts.filter(p => p.text).map(p => p.text).join(''));
      last = new Error('gemini_' + r.status);
    } catch (e) { last = e; }
  }
  throw last;
}

module.exports = { REDIRECT, SCOPES, creds, authUrl, exchange, accessToken, disconnect, status, getCalendar, findFree, createEvent, updateEvent, syncCalendar, searchMail, importantUnread, readMail, createDraft, sendDraft, searchDrive, readFile, findMeetingNotes, summariseNotes, ukHM, ukDay, ukDate };
