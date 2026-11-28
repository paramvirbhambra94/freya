// Prayer times: Mawaqit mosque page (confData) with daily cache in Supabase; calculated (MWL) fallback.
const { db, getProfile, london, isOwner } = require('./_db');
const NAMES = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const toMin = hm => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const toHM = min => { min = ((Math.round(min) % 1440) + 1440) % 1440; return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); };

async function fetchConf(slug) {
  const r = await fetch(`https://mawaqit.net/en/${encodeURIComponent(slug)}`, { headers: { 'user-agent': UA, 'accept-language': 'en-GB' } });
  if (!r.ok) throw new Error('mawaqit_' + r.status);
  const html = await r.text();
  const m = html.match(/confData\s*=\s*(\{[\s\S]*?\});\s*\n/);
  if (!m) throw new Error('mawaqit_parse');
  const c = JSON.parse(m[1]);
  return { name: c.name, timezone: c.timezone, latitude: c.latitude, longitude: c.longitude, jumua: c.jumua, jumua2: c.jumua2, jumua3: c.jumua3, jumuaAsDuhr: c.jumuaAsDuhr, calendar: c.calendar, iqamaCalendar: c.iqamaCalendar, times: c.times, shuruq: c.shuruq };
}
async function getConf(slug) {
  const rows = await db(`prayer_cache?select=conf,fetched_at&slug=eq.${encodeURIComponent(slug)}`);
  const fresh = rows.length && (Date.now() - new Date(rows[0].fetched_at).getTime() < 20 * 3600e3);
  if (fresh) return rows[0].conf;
  try {
    const conf = await fetchConf(slug);
    await db('prayer_cache?on_conflict=slug', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { slug, conf, fetched_at: new Date().toISOString() } });
    return conf;
  } catch (e) { if (rows.length) return rows[0].conf; throw e; }
}

// ---- calculated fallback (Muslim World League: Fajr 18°, Isha 17°, Asr Hanafi (matches his mosque), angle-based high-latitude rule) ----
const dtr = d => d * Math.PI / 180, rtd = r => r * 180 / Math.PI;
const fix = (a, b) => { a = a - b * Math.floor(a / b); return a < 0 ? a + b : a; };
function sunPos(jd) {
  const D = jd - 2451545.0, g = fix(357.529 + 0.98560028 * D, 360), q = fix(280.459 + 0.98564736 * D, 360);
  const L = fix(q + 1.915 * Math.sin(dtr(g)) + 0.020 * Math.sin(dtr(2 * g)), 360), e = 23.439 - 0.00000036 * D;
  const RA = fix(rtd(Math.atan2(Math.cos(dtr(e)) * Math.sin(dtr(L)), Math.cos(dtr(L)))) / 15, 24);
  return { decl: rtd(Math.asin(Math.sin(dtr(e)) * Math.sin(dtr(L)))), eqt: q / 15 - RA };
}
function tzOffsetHours(y, m, d, tz) {
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const s = dt.toLocaleString('en-US', { timeZone: tz, hourCycle: 'h23' });
  return Math.round((new Date(s + ' UTC') - dt) / 36e5 * 4) / 4;
}
function calcTimes(y, m, d, lat, lng, tz = 'Europe/London') {
  const jd = 367 * y - Math.floor(7 * (y + Math.floor((m + 9) / 12)) / 4) + Math.floor(275 * m / 9) + d + 1721013.5 - lng / 360;
  const off = tzOffsetHours(y, m, d, tz);
  const mid = t => { const { eqt } = sunPos(jd + t); return fix(12 - eqt, 24); };
  const angleT = (angle, t, ccw) => {
    const { decl } = sunPos(jd + t);
    const v = (-Math.sin(dtr(angle)) - Math.sin(dtr(decl)) * Math.sin(dtr(lat))) / (Math.cos(dtr(decl)) * Math.cos(dtr(lat)));
    const a = rtd(Math.acos(Math.max(-1, Math.min(1, v)))) / 15;
    return mid(t) + (ccw ? -a : a);
  };
  const asrT = t => { const { decl } = sunPos(jd + t); const ang = -rtd(Math.atan(1 / (2 + Math.tan(dtr(Math.abs(lat - decl)))))); return angleT(ang, t); };
  let fajr = angleT(18, 5 / 24, true), sunrise = angleT(0.833, 6 / 24, true), dhuhr = mid(12 / 24), asr = asrT(13 / 24), sunset = angleT(0.833, 18 / 24), isha = angleT(17, 18 / 24);
  const night = 24 - (sunset - sunrise);
  if (!(sunrise - fajr <= 18 / 60 * night) || isNaN(fajr)) fajr = sunrise - 18 / 60 * night;
  if (!(isha - sunset <= 17 / 60 * night) || isNaN(isha)) isha = sunset + 17 / 60 * night;
  const adj = t => toHM((t + off - lng / 15) * 60);
  return { fajr: adj(fajr), sunrise: adj(sunrise), dhuhr: toHM((dhuhr + off - lng / 15) * 60 + 1), asr: adj(asr), maghrib: toHM((sunset + off - lng / 15) * 60 + 1), isha: adj(isha) };
}

// ---- day schedule ----
function dayFromConf(conf, y, m, d, weekday) {
  const cal = conf.calendar && conf.calendar[m - 1] && conf.calendar[m - 1][String(d)];
  const iq = conf.iqamaCalendar && conf.iqamaCalendar[m - 1] && conf.iqamaCalendar[m - 1][String(d)];
  if (!cal || cal.length < 6) return null;
  const adhan = { fajr: cal[0], dhuhr: cal[2], asr: cal[3], maghrib: cal[4], isha: cal[5] };
  const out = { source: 'mawaqit', mosque: conf.name, sunrise: cal[1], prayers: {} };
  NAMES.forEach((n, i) => {
    let q = iq && iq[i];
    if (q && /^\+\d+$/.test(q)) q = toHM(toMin(adhan[n]) + +q.slice(1));
    else if (!q || !/^\d\d:\d\d$/.test(q)) q = null;
    out.prayers[n] = { adhan: adhan[n], iqamah: q };
  });
  if (weekday === 'Fri') {
    out.jumuah = [conf.jumua, conf.jumua2, conf.jumua3].filter(Boolean);
    if (out.jumuah.length) out.prayers.dhuhr.iqamah = out.jumuah[0];
  }
  return out;
}
function dayCalc(lat, lng, y, m, d, weekday, label) {
  const t = calcTimes(y, m, d, lat, lng);
  const out = { source: 'calculated', mosque: label || null, sunrise: t.sunrise, prayers: {} };
  NAMES.forEach(n => { out.prayers[n] = { adhan: t[n], iqamah: null }; });
  return out;
}
function addDays(y, m, d, k) { const dt = new Date(Date.UTC(y, m - 1, d + k)); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), weekday: dt.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }) }; }

// Returns today + tomorrow schedules, next prayer and auto private-mode window.
async function getSchedule(profile) {
  profile = profile || await getProfile();
  const now = london();
  const travel = profile.travel_location ? (() => { try { return JSON.parse(profile.travel_location); } catch (e) { return null; } })() : null;
  const slug = profile.mosque_slug;
  const days = [addDays(now.y, now.m, now.d, 0), addDays(now.y, now.m, now.d, 1)];
  let sched = null, conf = null;
  if (!travel && slug) { try { conf = await getConf(slug); sched = days.map(x => dayFromConf(conf, x.y, x.m, x.d, x.weekday)); if (sched.some(s => !s)) sched = null; } catch (e) { sched = null; } }
  if (!sched) {
    // Fallback location: the owner's home area; other accounts default to central London until they set a location.
    const home = isOwner() ? [52.4486, -1.848] : [51.5074, -0.1278];
    const lat = travel ? travel.lat : (conf ? conf.latitude : home[0]), lng = travel ? travel.lng : (conf ? conf.longitude : home[1]);
    sched = days.map(x => dayCalc(lat, lng, x.y, x.m, x.d, x.weekday, travel ? (travel.label || 'your current location') : (profile.mosque_name || null)));
  }
  const after = +(profile.private_after_iqamah_min || 15);
  let next = null, privateWindow = null;
  for (const [di, s] of sched.entries()) {
    for (const n of NAMES) {
      const p = s.prayers[n], a = toMin(p.adhan) + di * 1440, q = p.iqamah ? toMin(p.iqamah) + di * 1440 : a + 10;
      const endJ = (n === 'dhuhr' && s.jumuah && s.jumuah.length) ? toMin(s.jumuah[s.jumuah.length - 1]) + di * 1440 + 30 : q + after;
      if (!privateWindow && now.min >= a && now.min < endJ) privateWindow = { prayer: n, until: toHM(endJ) };
      if (!next && (p.iqamah ? q : a) > now.min) next = { prayer: n, adhan: p.adhan, iqamah: p.iqamah, day: di === 0 ? 'today' : 'tomorrow', inMin: (p.iqamah ? q : a) - now.min, adhanInMin: a - now.min };
    }
  }
  return { now, today: sched[0], tomorrow: sched[1], next, privateWindow, travelling: !!travel, mosque: profile.mosque_name || (conf && conf.name) || null, slug };
}

// Mosque search via Mawaqit's public country map (name/city search and nearest-first by coordinates)
async function searchMosques({ q, lat, lng, country = 'GB' }) {
  const r = await fetch(`https://mawaqit.net/api/2.0/mosque/map/${encodeURIComponent(String(country).toUpperCase())}`, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error('mawaqit_search_' + r.status);
  let list = await r.json();
  if (q) { const w = String(q).toLowerCase().split(/\s+/).filter(Boolean); list = list.filter(x => w.every(t => `${x.name} ${x.city} ${x.address} ${x.zipcode}`.toLowerCase().includes(t))); }
  if (lat != null && lng != null) {
    const hav = (a, b, c, d) => { const R = 6371, x = dtr(c - a), y = dtr(d - b); const h = Math.sin(x / 2) ** 2 + Math.cos(dtr(a)) * Math.cos(dtr(c)) * Math.sin(y / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
    list.forEach(x => { x.km = Math.round(hav(lat, lng, x.lat, x.lng) * 10) / 10; });
    list.sort((a, b) => a.km - b.km);
  }
  return list.slice(0, 8).map(x => ({ slug: x.slug, name: x.name, address: [x.address, x.city, x.zipcode].filter(Boolean).join(', '), km: x.km }));
}

module.exports = { getSchedule, searchMosques, calcTimes, fetchConf, toMin, toHM, NAMES };
