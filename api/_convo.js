// Conversation memory: every turn (voice, typed, camera) persisted as it happens, digested into
// durable facts + a rolling summary in the background, and searchable when he asks "what did I say about X".
const { db, getProfile, setProfile, clip } = require('./_db');
const { gen } = require('./_sections');

const SID = /^[\w-]{8,64}$/, CID = /^[\w.-]{4,80}$/;
const ROLES = ['user', 'freya', 'seen', 'note'];
const CATS = ['deen', 'health', 'money', 'family', 'work', 'habits', 'goals', 'preferences', 'people', 'routine', 'other'];
const iso = (v, d = new Date()) => { const t = Date.parse(v); return new Date(isNaN(t) || Math.abs(Date.now() - t) > 7 * 864e5 ? d : t).toISOString(); };
const uk = t => new Date(t).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const WHO = { user: 'Eesah', freya: 'Freya', seen: '(seen)', note: '(notes)' };
const bad = m => Object.assign(new Error(m), { status: 400 });

async function touch(sid, extra = {}) {
  await db('convo_sessions?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { id: sid, last_at: new Date().toISOString(), dirty: true, ...extra } });
}
async function insert(sid, rows) {
  if (!rows.length) return 0;
  await db('convo_turns?on_conflict=cid', { method: 'POST', prefer: 'resolution=ignore-duplicates', body: rows.map(r => ({ session_id: sid, ...r })) });
  return rows.length;
}

// POST {action:'turns', session, mode, turns:[{cid, role, text, at}], ended?, camera?}
async function addTurns(b) {
  const sid = String(b.session || ''); if (!SID.test(sid)) throw bad('bad_session');
  const mode = clip(String(b.mode || ''), 20) || null;
  const rows = (Array.isArray(b.turns) ? b.turns : []).slice(0, 60).map(t => ({
    cid: CID.test(String(t.cid || '')) ? String(t.cid) : null, role: ROLES.includes(t.role) ? t.role : 'user',
    text: clip(String(t.text || ''), 4000).trim(), mode, created_at: iso(t.at)
  })).filter(t => t.text && t.cid && t.role !== 'note');
  const extra = {};
  if (b.camera) extra.camera = true;
  if (typeof b.ended === 'string' && /^[a-z]{3,12}$/.test(b.ended)) extra.ended = b.ended;
  await touch(sid, extra);
  return { ok: true, saved: await insert(sid, rows) };
}

// POST {action:'seen', session, kind:'camera'|'photo'|'video', frames:[b64 jpeg], end?, since?, cid}
// Images are only described, never stored. On camera end, her key suggestions become a note turn.
async function seen(b) {
  const sid = String(b.session || ''); if (!SID.test(sid)) throw bad('bad_session');
  const kind = ['camera', 'photo', 'video'].includes(b.kind) ? b.kind : 'photo';
  const frames = (Array.isArray(b.frames) ? b.frames : []).filter(f => typeof f === 'string' && f.length < 400000).slice(0, 4);
  const out = { ok: true };
  await touch(sid, kind === 'camera' ? { camera: true } : {});
  if (frames.length) {
    try {
      out.seen = clip(await gen([...frames.map(data => ({ inline_data: { mime_type: 'image/jpeg', data } })), { text: `These ${frames.length > 1 ? 'are frames' : 'is an image'} from Eesah's phone ${kind === 'camera' ? 'live camera, shown to his assistant Freya' : kind === 'video' ? 'video he shared with his assistant Freya' : 'photo he shared with his assistant Freya'}. In ONE plain sentence (max 30 words) say what is visible and its state (e.g. "His bedroom: unmade bed, clothes on the floor, a small desk by the window with cables everywhere."). Never identify anyone by face; say "a person" if needed. No preamble.` }], null, { models: ['gemini-flash-lite-latest', 'gemini-flash-latest'], timeout: 20000, temperature: 0.2 }), 400);
      await insert(sid, [{ cid: clip(String(b.cid || ('seen-' + sid + '-' + Date.now())), 80), role: 'seen', text: `[${kind}] ${out.seen}`, mode: 'camera', created_at: new Date().toISOString() }]);
    } catch (e) { out.seen = null; }
  }
  if (b.end && kind === 'camera') {
    const since = iso(b.since, new Date(Date.now() - 30 * 60e3));
    const said = await db(`convo_turns?select=role,text&session_id=eq.${encodeURIComponent(sid)}&created_at=gte.${since}&role=in.(freya,user,seen)&order=id.asc&limit=120`).catch(() => []);
    if (said.some(t => t.role === 'freya')) {
      try {
        const r = await gen([{ text: `From this live-camera conversation between Eesah and his assistant Freya, list her key practical suggestions as up to 4 short bullet points (max 18 words each, imperative, specific). Only things she actually suggested. If she made no real suggestions, return an empty list.\n\n${said.map(t => `${WHO[t.role]}: ${t.text}`).join('\n').slice(-12000)}` }], { type: 'OBJECT', properties: { points: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['points'] }, { models: ['gemini-flash-lite-latest', 'gemini-flash-latest'], timeout: 20000, temperature: 0.2 });
        out.notes = (r.points || []).map(p => clip(String(p), 200)).filter(Boolean).slice(0, 4);
        if (out.notes.length) await insert(sid, [{ cid: 'note-' + sid + '-' + Date.now(), role: 'note', text: 'Live camera notes: ' + out.notes.join(' • '), mode: 'camera', created_at: new Date().toISOString() }]);
      } catch (e) { out.notes = []; }
    } else out.notes = [];
  }
  return out;
}

// What she loads at the start of every session.
async function context() {
  const since = new Date(Date.now() - 48 * 36e5).toISOString();
  const [p, sessions, recent] = await Promise.all([
    getProfile().catch(() => ({})),
    db('convo_sessions?select=id,started_at,last_at,summary,ended,camera&summary=not.is.null&order=last_at.desc&limit=5').catch(() => []),
    db(`convo_turns?select=session_id,role,text,created_at&created_at=gte.${since}&order=id.desc&limit=40`).catch(() => [])
  ]);
  const turns = recent.reverse();
  const last = turns.length ? turns[turns.length - 1] : null;
  return { summary: p.convo_summary || null, sessions, turns, lastAt: last ? last.created_at : null, lastSession: last ? last.session_id : null };
}
function block(c, cont) {
  if (!c) return '';
  let s = '\n\nCONVERSATION MEMORY (you remember everything you and Eesah have said; this is how):';
  if (c.summary) s += '\nWHAT YOU REMEMBER FROM PAST CONVERSATIONS (rolling summary):\n' + c.summary.slice(0, 2500);
  const sum = (c.sessions || []).filter(x => x.summary).slice(0, 5);
  if (sum.length) s += '\nRECENT CONVERSATIONS:\n' + sum.map(x => `- ${uk(x.last_at)}: ${x.summary.slice(0, 600)}`).join('\n');
  if (c.turns && c.turns.length) {
    let lines = c.turns.map(t => `[${uk(t.created_at)}] ${WHO[t.role] || t.role}: ${t.text.slice(0, 600)}`), txt = lines.join('\n');
    while (txt.length > 7000 && lines.length > 4) { lines = lines.slice(1); txt = lines.join('\n'); }
    s += '\nTHE LATEST TURNS (oldest first; "(seen)" is what his camera or a shared photo showed you):\n' + txt;
  }
  if (c.lastAt && Date.now() - Date.parse(c.lastAt) < 30 * 60e3) s += `\nTHE LATEST TURNS ARE FROM ${Math.round((Date.now() - Date.parse(c.lastAt)) / 60e3)} MINUTE(S) AGO: this is the same conversation carrying on (he may have just moved between the floating panel and the full app). Carry on seamlessly from them; no fresh greeting, no recap unless he asks.`;
  s += `\nMEMORY RULES: This is one continuous relationship. Use what is above naturally, the way a person who was there would: never recite it, never list what you remember, never say "according to my memory". If he refers to something you discussed before and it isn't above, call recall_conversations before answering; never claim you can't remember without checking. If he asks what he said about something, call recall_conversations and answer with when and what.`;
  if (cont) s += `\nCONTINUING: the last conversation was cut off ${cont.ago != null ? cont.ago + ' minute(s) ago' : 'recently'} (${cont.why}). This is the same conversation picking back up. If you were mid-thought or mid-advice in the latest turns, continue from exactly there ("As I was saying about…"). Don't apologise at length or talk about the technical cut-off.`;
  return s;
}

// "What did I say about X last week?"
const STOP = new Set('the and for that this with what when where about from have just your you did said say tell told was were are our week last month ago days day yesterday today thing things talk talked chat about'.split(' '));
async function recall(b) {
  const days = Math.max(1, Math.min(365, parseInt(b.days, 10) || 30));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const words = [...new Set((String(b.query || '').toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) || []).filter(w => !STOP.has(w)))].slice(0, 5).map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  const or = f => words.length ? `&or=(${words.map(w => `${f}.ilike.*${encodeURIComponent(w)}*`).join(',')})` : '';
  const [turns, sessions] = await Promise.all([
    words.length ? db(`convo_turns?select=session_id,role,text,created_at&created_at=gte.${since}${or('text')}&order=id.desc&limit=30`).catch(() => []) : [],
    db(`convo_sessions?select=id,last_at,summary&last_at=gte.${since}&summary=not.is.null${or('summary')}&order=last_at.desc&limit=10`).catch(() => [])
  ]);
  return {
    ok: true, query: words.join(' '), days,
    conversations: sessions.map(x => ({ when: uk(x.last_at), summary: x.summary })),
    matches: turns.reverse().map(t => ({ when: uk(t.created_at), who: WHO[t.role] || t.role, text: t.text.slice(0, 500) })),
    note: !sessions.length && !turns.length ? 'Nothing found in that period. Say so honestly, and ask him to remind you.' : undefined
  };
}

// Background digest (cron, every 5 min): quiet sessions -> session summary + durable facts + rolling summary.
const DIGEST = { type: 'OBJECT', properties: {
  session_summary: { type: 'STRING', description: '2-5 sentences: what this conversation covered, decisions, advice given, what he committed to. Merge with the previous summary of this same session if given.' },
  facts: { type: 'ARRAY', items: { type: 'OBJECT', properties: { category: { type: 'STRING', enum: CATS }, content: { type: 'STRING' } }, required: ['category', 'content'] }, description: 'NEW durable facts about Eesah (preferences, goals, commitments, people, routines, worries, plans). Third person, specific, max 25 words. Exclude anything already in KNOWN MEMORIES. Empty if none.' },
  rolling_summary: { type: 'STRING', description: 'Updated running summary of everything important across ALL conversations so far (max ~1200 characters): ongoing threads, open loops, advice in progress, his current focus. Keep older important points; drop trivia.' }
}, required: ['session_summary', 'facts', 'rolling_summary'] };
const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
async function digest({ limit = 2, quietMin = 10 } = {}) {
  const cutoff = new Date(Date.now() - quietMin * 60e3).toISOString();
  const list = await db(`convo_sessions?select=id,processed_upto,summary&dirty=eq.true&last_at=lte.${cutoff}&order=last_at.asc&limit=${limit}`).catch(() => []);
  let done = 0;
  for (const s of list) {
    const old = s.processed_upto || 0;
    const turns = await db(`convo_turns?select=id,role,text,created_at&session_id=eq.${encodeURIComponent(s.id)}&id=gt.${old}&order=id.asc&limit=400`).catch(() => null);
    if (!turns) continue;
    if (!turns.length) { await db(`convo_sessions?id=eq.${encodeURIComponent(s.id)}`, { method: 'PATCH', body: { dirty: false } }).catch(() => {}); continue; }
    const upto = turns[turns.length - 1].id;
    const got = await db(`convo_sessions?id=eq.${encodeURIComponent(s.id)}&processed_upto=eq.${old}`, { method: 'PATCH', prefer: 'return=representation', body: { processed_upto: upto, dirty: false } }).catch(() => []);
    if (!got || !got.length) continue; // another run claimed it
    try {
      const [p, mems] = await Promise.all([getProfile(), db('memories?select=content&order=created_at.desc&limit=80')]);
      const r = await gen([{ text: `You maintain the long-term memory of Freya, Eesah's personal AI companion. Read the new conversation turns and return JSON.
Rules: facts are about Eesah only (never store other people's private details beyond a name and relationship). No sensitive bank numbers or passwords. "(seen)" lines describe what his camera showed.
PREVIOUS SUMMARY OF THIS SESSION: ${s.summary || '(none)'}
CURRENT ROLLING SUMMARY: ${p.convo_summary || '(none)'}
KNOWN MEMORIES:\n${mems.map(m => '- ' + m.content).join('\n').slice(0, 9000)}
NEW TURNS:\n${turns.map(t => `[${uk(t.created_at)}] ${WHO[t.role] || t.role}: ${t.text}`).join('\n').slice(-40000)}` }], DIGEST, { models: ['gemini-flash-lite-latest', 'gemini-flash-latest'], timeout: 25000, temperature: 0.2 });
      const known = mems.map(m => norm(m.content));
      let saved = 0;
      for (const f of (r.facts || []).slice(0, 8)) {
        const c = clip(String(f.content || ''), 400).trim(), n = norm(c); if (!c || known.some(k => k === n || (n.length > 20 && (k.includes(n) || n.includes(k))))) continue;
        await db('memories', { method: 'POST', body: { category: CATS.includes(f.category) ? f.category : 'other', content: c, source: 'convo' } }).catch(() => {}); known.push(n); saved++;
      }
      await db(`convo_sessions?id=eq.${encodeURIComponent(s.id)}`, { method: 'PATCH', body: { summary: clip(String(r.session_summary || s.summary || ''), 2000) || null } });
      if (r.rolling_summary) { await setProfile('convo_summary', clip(String(r.rolling_summary), 2500)); }
      done++;
      s.facts = saved;
    } catch (e) {
      await db(`convo_sessions?id=eq.${encodeURIComponent(s.id)}`, { method: 'PATCH', body: { processed_upto: old, dirty: true } }).catch(() => {});
    }
  }
  return done;
}
async function prune(claim) {
  const day = new Date().toISOString().slice(0, 10);
  if (claim && !(await claim('convo_prune:' + day).catch(() => false))) return 0;
  await db(`convo_turns?created_at=lt.${new Date(Date.now() - 180 * 864e5).toISOString()}`, { method: 'DELETE' }).catch(() => {});
  return 1;
}

// A typed reply to something she asked (spoken question he didn't answer, a nudge, a notification).
async function answerQ(b) {
  const q = clip(String(b.question || ''), 600).trim(), a = clip(String(b.answer || ''), 2000).trim();
  if (!q || !a) throw bad('missing');
  const sid = SID.test(String(b.session || '')) ? String(b.session) : 'reply-' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let r;
  try {
    const [p, mems] = await Promise.all([getProfile().catch(() => ({})), db('memories?select=content&order=created_at.desc&limit=30').catch(() => [])]);
    r = await gen([{ text: `You are FREYA, Eesah's calm, warm AI companion (British English, plain and concise, never sycophantic, no jokes). Earlier you asked him something and he has now typed a reply. React in one or two short sentences: acknowledge what he said specifically; add a next step only if it follows directly from his words. Use ONLY facts from his reply and WHAT YOU KNOW. Never add details, opinions or assumptions about places, people, traffic, parking, prices or anything he did not mention. Never say you will set, change, schedule or remind anything (you cannot from here); say it is noted, e.g. "Noted: 6:30 after Fajr." If he wants it actually changed, suggest telling you by voice. No question unless essential.\nWHAT YOU KNOW: ${mems.map(m => m.content).join(' | ').slice(0, 3000)}${p.convo_summary ? '\nRECENT CONTEXT: ' + p.convo_summary.slice(0, 1500) : ''}\nYOU ASKED: ${q}\nHE REPLIED: ${a}` }], { type: 'OBJECT', properties: { reply: { type: 'STRING' }, facts: { type: 'ARRAY', items: { type: 'OBJECT', properties: { category: { type: 'STRING', enum: CATS }, content: { type: 'STRING' } }, required: ['category', 'content'] }, description: 'durable facts about Eesah from his reply; [] if none' } }, required: ['reply', 'facts'] }, { models: ['gemini-flash-lite-latest', 'gemini-flash-latest'], timeout: 20000, temperature: 0.2 });
  } catch (e) { r = { reply: 'Got it, noted.', facts: [] }; }
  const reply = clip(String(r.reply || 'Noted.'), 500);
  for (const f of (r.facts || []).slice(0, 3)) { const t = clip(String(f.content || ''), 400).trim(); if (t) await db('memories', { method: 'POST', body: { category: CATS.includes(f.category) ? f.category : 'other', content: t, source: 'convo' } }).catch(() => {}); }
  const tag = 'ans-' + Date.now().toString(36);
  await touch(sid);
  await insert(sid, [...(b.from === 'voice' ? [] : [{ cid: tag + '.q', role: 'freya', text: q, mode: 'reply', created_at: new Date(Date.now() - 1000).toISOString() }]), { cid: tag + '.a', role: 'user', text: a, mode: 'reply', created_at: new Date().toISOString() }, { cid: tag + '.r', role: 'freya', text: reply, mode: 'reply', created_at: new Date(Date.now() + 500).toISOString() }]);
  return { ok: true, reply };
}
// The conversation as a readable history (for the History view).
async function history(b) {
  const limit = Math.max(10, Math.min(200, parseInt(b.limit, 10) || 80));
  const before = parseInt(b.before, 10);
  const rows = await db(`convo_turns?select=id,session_id,role,text,created_at${before > 0 ? '&id=lt.' + before : ''}&order=id.desc&limit=${limit}`);
  return { ok: true, turns: rows.reverse().map(t => ({ id: t.id, sid: t.session_id, role: t.role, text: t.text, at: t.created_at })) };
}
async function handle(b) {
  if (b.action === 'turns') return addTurns(b);
  if (b.action === 'seen') return seen(b);
  if (b.action === 'recall') return recall(b);
  if (b.action === 'history') return history(b);
  if (b.action === 'answer') return answerQ(b);
  throw bad('unknown_action');
}
module.exports = { handle, addTurns, seen, recall, history, context, block, digest, prune };
