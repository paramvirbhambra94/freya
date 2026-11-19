// Habits, streaks, private mode and push helpers shared by state, token and cron.
const { db, getProfile, setProfile, london, getSecret } = require('./_db');
const { getSchedule } = require('./_prayer');
const DONE = ['done', 'prayed', 'jamaah', 'qada'];

function dayStr(date, k) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); }

async function getHabits() {
  const today = london().date, since = dayStr(today, -60);
  const [habits, logs] = await Promise.all([
    db('habits?select=id,name,kind,sort&active=eq.true&order=sort.asc,id.asc'),
    db(`habit_logs?select=habit_id,day,status&day=gte.${since}&order=day.desc`)
  ]);
  return habits.map(h => {
    const mine = logs.filter(l => l.habit_id === h.id), byDay = Object.fromEntries(mine.map(l => [l.day, l.status]));
    let streak = 0, k = DONE.includes(byDay[today]) ? 0 : -1;
    while (DONE.includes(byDay[dayStr(today, k)])) { streak++; k--; }
    const last7 = [...Array(7)].map((_, i) => DONE.includes(byDay[dayStr(today, -i)]) ? 1 : 0).reduce((a, b) => a + b, 0);
    return { id: h.id, name: h.name, kind: h.kind, today: byDay[today] || null, streak, last7 };
  });
}
async function findHabit(name) {
  const rows = await db(`habits?select=id,name,kind&name=ilike.${encodeURIComponent(String(name).trim())}`);
  return rows[0] || null;
}
async function logHabit(name, status = 'done', day) {
  const h = await findHabit(name);
  if (!h) return { ok: false, error: 'No habit called ' + name };
  day = day || london().date;
  if (status === 'clear') await db(`habit_logs?habit_id=eq.${h.id}&day=eq.${day}`, { method: 'DELETE' });
  else await db('habit_logs?on_conflict=habit_id,day', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { habit_id: h.id, day, status } });
  return { ok: true, habit: h.name, status, day };
}
async function addHabit(name) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) return { ok: false };
  if (await findHabit(name)) { await db(`habits?name=ilike.${encodeURIComponent(name)}`, { method: 'PATCH', body: { active: true } }); return { ok: true, name }; }
  await db('habits', { method: 'POST', body: { name, kind: 'habit' } });
  return { ok: true, name };
}

// Private mode: manual (stand down) or automatic around each salah.
async function getPrivate(profile, schedule) {
  const manualUntil = profile.private_until ? new Date(profile.private_until) : null;
  const manual = manualUntil && manualUntil > new Date() ? manualUntil.toISOString() : null;
  const auto = schedule && schedule.privateWindow;
  return { on: !!(manual || auto), manualUntil: manual, auto: auto || null };
}
async function setPrivate(on, minutes) {
  const until = on ? new Date(Date.now() + Math.max(5, Math.min(600, +minutes || 60)) * 60e3).toISOString() : '';
  await setProfile('private_until', until);
  return { ok: true, on: !!on, until: until || null };
}

async function lifeState() {
  const profile = await getProfile();
  const schedule = await getSchedule(profile).catch(() => null);
  const [habits, priv] = await Promise.all([getHabits(), getPrivate(profile, schedule)]);
  return { profile, schedule, habits, private: priv, briefTime: profile.brief_time || '07:30' };
}

// ---- Web Push ----
async function vapid() {
  const wp = require('web-push');
  const raw = await getSecret('vapid_keys', async () => JSON.stringify(wp.generateVAPIDKeys()));
  const k = JSON.parse(raw);
  wp.setVapidDetails('mailto:freya@freya-black.vercel.app', k.publicKey, k.privateKey);
  return { wp, publicKey: k.publicKey };
}
// priority: critical | high | low
async function sendPush({ title, body, priority = 'high', url = '/', tag }) {
  const { wp } = await vapid();
  const subs = await db('push_subscriptions?select=endpoint,sub');
  let sent = 0;
  for (const s of subs) {
    try {
      await wp.sendNotification(s.sub, JSON.stringify({ title, body, priority, url, tag }), { TTL: 3600, urgency: priority === 'low' ? 'low' : 'high' });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await db(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'DELETE' });
    }
  }
  return sent;
}

module.exports = { getHabits, logHabit, addHabit, getPrivate, setPrivate, lifeState, vapid, sendPush, DONE, dayStr };
