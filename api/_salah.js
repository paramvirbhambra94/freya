// Salah accountability: only Freya logs a prayer, and only with evidence she has checked.
// Evidence: "camera" (Pray with Freya: stills from the live camera while he prays) or "masjid" (a photo of him at the masjid).
// The images are only analysed here, never stored by this module (section uploads keep their own 24h raw rule).
const { db, london, getProfile, setProfile, storage } = require('./_db');
const { getSchedule, toMin, NAMES } = require('./_prayer');
const DONE = ['done', 'prayed', 'jamaah', 'qada'];
const BUCKET = 'growth';
const cap = n => n[0].toUpperCase() + n.slice(1);
const MASJID = 'MahmudSabir (Al Furqan) Masjid, Tyseley';

function prevDay(date) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }

// Which prayer is due now, from his Mawaqit times. Windows: Fajr until sunrise, others until the next adhan, Isha until midnight
// (after midnight and before Fajr, it is still last night's Isha).
function windows(sc) {
  const t = sc.today, now = sc.now.min, out = [];
  NAMES.forEach((n, i) => {
    const start = toMin(t.prayers[n].adhan);
    const end = n === 'fajr' ? toMin(t.sunrise || '07:00') : i < 4 ? toMin(t.prayers[NAMES[i + 1]].adhan) : 24 * 60;
    out.push({ prayer: n, day: sc.now.date, start, end, started: now >= start, open: now >= start && now < end });
  });
  return out;
}
function dueNow(sc) {
  if (!sc) return null;
  const w = windows(sc), open = w.find(x => x.open);
  if (open) return { prayer: open.prayer, day: open.day, onTime: true };
  if (sc.now.min < toMin(sc.today.prayers.fajr.adhan)) return { prayer: 'isha', day: prevDay(sc.now.date), onTime: true };
  return null;
}

async function prayerLogs(day) {
  const hs = await db('habits?select=id,name,kind&kind=eq.prayer&active=eq.true');
  const ids = hs.map(h => h.id);
  const logs = ids.length ? await db(`habit_logs?select=habit_id,day,status,evidence,verified_at&day=eq.${day}&habit_id=in.(${ids.join(',')})`) : [];
  return hs.map(h => ({ ...h, key: h.name.toLowerCase(), log: logs.find(l => l.habit_id === h.id) || null }));
}

// Pick the prayer to log: the one he asked for (if its time has come), else the one due now, else the latest unlogged one today.
async function choose(sc, requested) {
  const w = windows(sc), due = dueNow(sc);
  if (requested && NAMES.includes(requested)) {
    if (due && due.prayer === requested) return { ...due };
    const x = w.find(v => v.prayer === requested);
    if (!x.started) return { error: `${cap(requested)} hasn't started yet (adhan ${sc.today.prayers[requested].adhan}).` };
    return { prayer: requested, day: x.day, onTime: x.open };
  }
  if (due) {
    const logs = await prayerLogs(due.day), mine = logs.find(l => l.key === due.prayer);
    if (!(mine && mine.log && DONE.includes(mine.log.status))) return due;
  }
  const logs = await prayerLogs(sc.now.date);
  const missed = w.filter(v => v.started && !v.open).reverse().find(v => { const l = logs.find(x => x.key === v.prayer); return !(l && l.log && DONE.includes(l.log.status)); });
  if (missed) return { prayer: missed.prayer, day: missed.day, onTime: false };
  if (due) return due; // already logged; caller reports that
  return { error: 'No prayer is due right now.' };
}

const B = { type: 'BOOLEAN' }, S = d => ({ type: 'STRING', description: d });
const CAMERA_SCHEMA = { type: 'OBJECT', properties: {
  person_visible: B,
  positions_seen: { type: 'ARRAY', items: { type: 'STRING', enum: ['standing', 'ruku', 'sujood', 'sitting', 'tasleem'] } },
  completed: { type: 'BOOLEAN', description: 'true only if the frames show a full salah being performed through to the final sitting (and tasleem if visible)' },
  credible: { type: 'BOOLEAN', description: 'true only if this genuinely looks like one person really performing Islamic salah in these frames' },
  reason: S('one short sentence on what you saw')
}, required: ['person_visible', 'positions_seen', 'completed', 'credible', 'reason'] };
const MASJID_SCHEMA = { type: 'OBJECT', properties: {
  at_masjid: { type: 'BOOLEAN', description: 'true if the photo was clearly taken at or inside a mosque/masjid (prayer hall, rows of worshippers, mihrab, prayer carpet lines, minbar, mosque entrance or wudu area)' },
  first_person: { type: 'BOOLEAN', description: 'true if it looks like his own real photo from there (a selfie, his view of the hall or rows, his feet on the carpet). A screenshot of his own photo or camera (gallery, Snapchat, WhatsApp) still counts. False for a stock or professional image, a web page or search result, or a photo of a screen showing someone else\'s picture.' },
  credible: { type: 'BOOLEAN', description: 'true only if at_masjid and first_person are both true and nothing suggests it is fake' },
  reason: S('one short sentence on what you saw')
}, required: ['at_masjid', 'first_person', 'credible', 'reason'] };

async function verify(kind, images) {
  const SEC = require('./_sections');
  const parts = kind === 'camera'
    ? [{ text: `These ${images.length} stills are in time order from a phone camera propped up while a Muslim man (Eesah) prays salah at home. Decide honestly whether they show him actually performing salah. Look for the positions: standing (qiyam), bowing (ruku), prostration (sujood), sitting (jalsa/tashahhud) and turning the head for tasleem. Frames are about every few seconds, so some positions may be missed. Do not be fooled by someone just standing or sitting, an empty room, or a picture of a screen. Never identify anyone.` }]
    : [{ text: `Eesah says he is at the masjid for salah and sent this photo as proof. Decide honestly whether it credibly shows he is at or inside a mosque right now. A selfie in the masjid, his view of the prayer hall or rows, or his feet on masjid carpet all count, including a screenshot of his own photo or camera. A stock or professional image, a web page or search result, or a photo of a screen showing someone else's picture does not. Never identify anyone.` }];
  for (const b of images) parts.push({ inlineData: { mimeType: 'image/jpeg', data: b } });
  const v = await SEC.gen(parts, kind === 'camera' ? CAMERA_SCHEMA : MASJID_SCHEMA, { models: ['gemini-flash-latest', 'gemini-flash-lite-latest'], timeout: 30000, temperature: 0.1 });
  if (kind === 'camera') {
    const pos = new Set(v.positions_seen || []);
    const ok = !!(v.person_visible && v.credible && v.completed && pos.has('sujood') && (pos.has('ruku') || pos.has('standing')) && pos.size >= 2);
    return { ok, reason: String(v.reason || '').slice(0, 240), positions: [...pos] };
  }
  return { ok: !!(v.credible && v.at_masjid && v.first_person), reason: String(v.reason || '').slice(0, 240) };
}

const okImg = b => typeof b === 'string' && b.length > 200 && b.length < 1.5e6 && /^[A-Za-z0-9+/=]+$/.test(b.slice(0, 200));

// A masjid photo he recently dropped into a section (raw files live 24h): the newest image in the last 3 hours.
async function recentUploadImage(id) {
  const q = id ? `id=eq.${encodeURIComponent(id)}` : `created_at=gte.${new Date(Date.now() - 3 * 36e5).toISOString()}&kind=in.(photo,file)&mime=like.image*`;
  const it = (await db(`section_items?select=id,section,mime,raw_path,raw_expires_at,created_at,analysis&${q}&raw_path=not.is.null&order=created_at.desc&limit=1`))[0];
  if (!it || !/^image\//.test(it.mime || '') || (it.raw_expires_at && new Date(it.raw_expires_at) < new Date())) return null;
  try { const r = await storage(`object/${BUCKET}/${it.raw_path}`); return { item: it, b64: Buffer.from(await r.arrayBuffer()).toString('base64') }; } catch (e) { return null; }
}

async function writeLog(habitId, day, status, evidence, note) {
  await db('habit_logs?on_conflict=habit_id,day', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { habit_id: habitId, day, status, evidence, verified_at: new Date().toISOString(), evidence_note: note ? String(note).slice(0, 240) : null } });
}

// The only way a prayer becomes "done". kind: camera | masjid. images: base64 JPEGs (camera stills or the photo).
async function logWithEvidence({ kind, prayer, images, upload_id } = {}) {
  kind = kind === 'camera' ? 'camera' : 'masjid';
  let imgs = (Array.isArray(images) ? images : []).filter(okImg);
  if (kind === 'camera') { if (imgs.length < 4) return { ok: false, verified: false, error: 'not_enough_frames', say: "I didn't get enough of the prayer on camera to be sure." }; imgs = imgs.slice(-16); }
  else {
    if (!imgs.length) { const u = await recentUploadImage(upload_id); if (u) imgs = [u.b64]; }
    if (!imgs.length) return { ok: false, verified: false, error: 'no_evidence', say: 'I need proof first: a photo of you at the masjid, or pray in front of me with Pray with Freya.' };
    imgs = imgs.slice(0, 2);
  }
  const profile = await getProfile();
  const sc = await getSchedule(profile);
  const pick = await choose(sc, prayer && String(prayer).toLowerCase());
  if (pick.error) return { ok: false, verified: false, error: 'not_due', say: pick.error };
  const logs = await prayerLogs(pick.day), h = logs.find(l => l.key === pick.prayer);
  if (!h) return { ok: false, error: 'no_habit' };
  if (h.log && DONE.includes(h.log.status) && h.log.evidence) return { ok: true, already: true, prayer: pick.prayer, status: h.log.status, evidence: h.log.evidence, say: `${cap(pick.prayer)} is already logged.` };
  let v; try { v = await verify(kind, imgs); } catch (e) { return { ok: false, verified: false, error: 'verify_failed', say: "I couldn't check the proof just now. Try again in a moment." }; }
  if (!v.ok) return { ok: false, verified: false, prayer: pick.prayer, error: 'not_verified', reason: v.reason, say: kind === 'camera' ? `I couldn't verify ${cap(pick.prayer)} from what I saw (${v.reason}). I haven't logged it.` : `That photo doesn't show me you're at the masjid (${v.reason}). I haven't logged it.` };
  const status = kind === 'masjid' ? (pick.onTime ? 'jamaah' : 'qada') : (pick.onTime ? 'prayed' : 'qada');
  const evidence = kind === 'masjid' ? 'masjid' : 'camera';
  await writeLog(h.id, pick.day, status, evidence, (kind === 'masjid' ? 'At the masjid: ' : 'On camera: ') + v.reason);
  return { ok: true, verified: true, prayer: pick.prayer, day: pick.day, status, evidence, reason: v.reason, mosque: kind === 'masjid' ? (profile.mosque_name || (require('./_db').isOwner() ? MASJID : 'the masjid')) : null, say: kind === 'masjid' ? `${cap(pick.prayer)} logged, at the masjid.` : `${cap(pick.prayer)} logged, verified on camera.` };
}

// Freya may record a missed prayer (no proof needed to admit one), only once its time has passed and it isn't already done.
async function markMissed(prayer) {
  prayer = String(prayer || '').toLowerCase(); if (!NAMES.includes(prayer)) return { ok: false, error: 'Unknown prayer' };
  const sc = await getSchedule(); const w = windows(sc).find(x => x.prayer === prayer);
  if (!w.started || w.open) return { ok: false, error: `${cap(prayer)}'s time hasn't finished yet, so it can't be marked missed.` };
  const logs = await prayerLogs(sc.now.date), h = logs.find(l => l.key === prayer);
  if (!h) return { ok: false, error: 'Prayer tracking is off. Turn on Islamic Mode in Settings first.' };
  if (h.log && DONE.includes(h.log.status)) return { ok: false, error: `${cap(prayer)} is already logged as done.` };
  await writeLog(h.id, sc.now.date, 'missed', 'freya', 'Marked missed by Freya');
  return { ok: true, prayer, status: 'missed' };
}

// Salah mode: while he prays in front of the camera nothing may buzz him.
async function setSalahMode(on, minutes) {
  const until = on ? new Date(Date.now() + Math.max(5, Math.min(40, +minutes || 30)) * 60e3).toISOString() : '';
  await setProfile('salah_mode_until', until);
  return { ok: true, on: !!on, until: until || null };
}
const salahModeOn = profile => !!(profile && profile.salah_mode_until && new Date(profile.salah_mode_until) > new Date());

module.exports = { logWithEvidence, markMissed, setSalahMode, salahModeOn, dueNow, windows, verify, recentUploadImage, _test: { choose } };
