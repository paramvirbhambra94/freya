// Cost guard for Gemini Live: invited accounts get a daily voice allowance (default 30 min, set per user in
// app_users.voice_cap_min). The owner is never limited. Usage is counted from the app's heartbeat while a voice
// session is live (voice_tick), plus a cap on how many voice sessions can be started per day.
const { db, current, isOwner } = require('./_db');
const MAX_MINTS = 400; // token mints per day (the app pre-fetches tokens, so this is generous; it only stops abuse)
const day = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const capMin = () => { const c = current() || {}; return c.voiceCapMin > 0 ? c.voiceCapMin : 30; };
async function usage() {
  const r = await db(`voice_usage?select=seconds,sessions&day=eq.${day()}`);
  return r[0] || { seconds: 0, sessions: 0 };
}
async function save(u) {
  await db('voice_usage?on_conflict=day', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { day: day(), seconds: u.seconds, sessions: u.sessions, updated_at: new Date().toISOString() } });
}
const outMsg = m => `You've used today's ${m} minutes of voice with Freya. Typing still works, and voice resets at midnight (UK time).`;
// Called before minting a voice token.
async function gate() {
  if (isOwner()) return { ok: true, unlimited: true };
  const u = await usage(), cap = capMin();
  if (u.seconds >= cap * 60) return { ok: false, error: outMsg(cap), left_min: 0 };
  if (u.sessions >= MAX_MINTS) return { ok: false, error: 'Too many voice sessions today. Try again tomorrow.', left_min: 0 };
  await save({ seconds: u.seconds, sessions: u.sessions + 1 });
  return { ok: true, left_min: Math.max(0, Math.floor((cap * 60 - u.seconds) / 60)) };
}
// Heartbeat from the app while voice is live: adds up to 75 s per call.
async function tick(seconds) {
  if (isOwner()) return { ok: true, unlimited: true };
  const add = Math.max(0, Math.min(75, Math.round(+seconds || 0)));
  const u = await usage(), cap = capMin();
  u.seconds += add; await save(u);
  const left = cap * 60 - u.seconds;
  return { ok: true, over: left <= 0, left_sec: Math.max(0, left), cap_min: cap, message: left <= 0 ? outMsg(cap) : null };
}
module.exports = { gate, tick, capMin };
