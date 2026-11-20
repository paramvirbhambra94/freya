// F.R.E.Y.A. client: Gemini Live voice, memory tools, onboarding wrap-up, ambient visuals.
const $ = id => document.getElementById(id);
const orb = $('orb'), statusEl = $('status'), herEl = document.querySelector('#captions .her'), himEl = document.querySelector('#captions .him');
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let forceOnboarding = new URLSearchParams(location.search).has('onboarding');

const h = new Date().getHours();
const greeting = (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + ', Eesah.';
const setStatus = t => { statusEl.textContent = t; };
const setState = s => { orb.dataset.state = s; };
const setBusy = b => document.body.classList.toggle('busy', !!b);
let idleMsg = greeting + ' Tap the orb to talk.';
setStatus(idleMsg);

// ---------- her volume (remembered; quieter at night 22:00–07:00) ----------
let outGain = null, resumeHandle = null, lastPlayEnd = 0;
const isNight = () => { const h = new Date().getHours(); return h >= 22 || h < 7; };
const volKey = () => isNight() ? 'freyaVolNight' : 'freyaVol';
function curVol() { const v = parseFloat(localStorage.getItem(volKey())); return isNaN(v) ? (isNight() ? 0.25 : 0.5) : Math.max(0, Math.min(1, v)); }
function setVol(v) {
  v = Math.max(0, Math.min(1, Math.round(v * 100) / 100)); localStorage.setItem(volKey(), String(v));
  if (outGain && outCtx) outGain.gain.setTargetAtTime(v, outCtx.currentTime, 0.05);
  const r = document.getElementById('volr'); if (r) r.value = Math.round(v * 100);
  return v;
}
let ws = null, micCtx = null, micStream = null, micNode = null, outCtx = null, analyser = null;
let nextTime = 0, sources = new Set(), active = false, connecting = false, model = null, mode = 'companion';
let briefPending = new URLSearchParams(location.search).has('brief');
let debriefPending = new URLSearchParams(location.search).get('debrief');
let pendingAction = null;
// Android shell (FREYA app): native bridge for alarms + wake word. Absent in a normal browser.
const APP = (() => { try { return !!(window.FreyaAndroid && window.FreyaAndroid.isApp()); } catch (e) { return false; } })();
let wakePending = APP && new URLSearchParams(location.search).has('wake');
let nudgePending = APP ? String(new URLSearchParams(location.search).get('nudge') || '').slice(0, 200) : '';
// Floating panel over other apps (Android overlay): compact layout.
if (APP) document.body.classList.add('app');
if (APP && new URLSearchParams(location.search).has('mini')) document.body.classList.add('mini');
let micLevel = 0, outLevel = 0, retries = 0, finishing = null, onboardingState = { configured: false, status: null, plan: null };

// ---------- captions & toast ----------
let herTimer, himTimer, toastTimer, newHerTurn = true, newHimTurn = true;
function caption(el, text, append, fadeMs) {
  el.textContent = append ? (el.textContent + text) : text;
  el.classList.add('on');
  const t = setTimeout(() => el.classList.remove('on'), fadeMs);
  if (el === herEl) { clearTimeout(herTimer); herTimer = t; } else { clearTimeout(himTimer); himTimer = t; }
}
function clearCaptions() { herEl.classList.remove('on'); himEl.classList.remove('on'); }
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3200);
}

// ---------- audio ----------
const WORKLET = `class P extends AudioWorkletProcessor{constructor(){super();this.b=new Int16Array(1600);this.i=0}
process(inp){const c=inp[0]&&inp[0][0];if(c){for(let k=0;k<c.length;k++){const s=Math.max(-1,Math.min(1,c[k]));this.b[this.i++]=s<0?s*0x8000:s*0x7fff;
if(this.i===this.b.length){this.port.postMessage(this.b.buffer,[this.b.buffer]);this.b=new Int16Array(1600);this.i=0}}}return true}}
registerProcessor('pcm16',P);`;
function b64FromBuf(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function playPcm(b64) {
  const bin = atob(b64), n = bin.length >> 1, f = new Float32Array(n);
  for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v & 0x8000) v -= 0x10000; f[i] = v / 32768; }
  const buf = outCtx.createBuffer(1, n, 24000); buf.copyToChannel(f, 0);
  const src = outCtx.createBufferSource(); src.buffer = buf; src.connect(analyser);
  const t = Math.max(nextTime, outCtx.currentTime + 0.05);
  src.start(t); nextTime = t + buf.duration;
  sources.add(src);
  src.onended = () => { sources.delete(src); if (!sources.size) lastPlayEnd = performance.now(); if (!sources.size && active) { setState('listening'); setStatus(mode === 'onboarding' ? 'Setting you up · listening…' : 'Listening…'); checkFinish(); } };
  setBusy(false); setState('speaking'); setStatus('Speaking…');
}
function stopPlayback() {
  sources.forEach(s => { try { s.stop(); } catch (e) {} }); sources.clear(); nextTime = 0; lastPlayEnd = performance.now();
  if (active) { setState('listening'); setStatus('Listening…'); }
}

// ---------- visuals loop: mic ripples, output glow ----------
const lvl = new Uint8Array(256), rings = $('rings'); let lastRipple = 0;
function ripple(strength) {
  if (reduceMotion || rings.childElementCount > 5) return;
  const s = document.createElement('span'); s.style.setProperty('--a', (0.25 + strength * 0.6).toFixed(2));
  s.addEventListener('animationend', () => s.remove()); rings.appendChild(s);
}
(function loop(ts) {
  let v = 0;
  if (analyser && sources.size) { analyser.getByteTimeDomainData(lvl); for (const x of lvl) v = Math.max(v, Math.abs(x - 128)); v /= 128; }
  outLevel += (Math.min(1, v * 1.6) - outLevel) * 0.25;
  micLevel *= 0.9;
  document.documentElement.style.setProperty('--out', outLevel.toFixed(3));
  document.documentElement.style.setProperty('--mic', Math.min(1, micLevel).toFixed(3));
  if (active && !sources.size && micLevel > 0.12 && ts - lastRipple > 380) { lastRipple = ts; ripple(Math.min(1, micLevel)); }
  requestAnimationFrame(loop);
})(0);

// ---------- particles ----------
(function particles() {
  const c = $('bg'), ctx = c.getContext('2d'), dpr = Math.min(1.5, devicePixelRatio || 1); let W, H, P = [], speed = 1;
  const size = () => { W = c.width = innerWidth * dpr; H = c.height = innerHeight * dpr; };
  size(); addEventListener('resize', size);
  for (let i = 0; i < 50; i++) P.push({ x: Math.random(), y: Math.random(), r: (0.6 + Math.random() * 1.6) * dpr, vx: (Math.random() - .5) * 0.00012, vy: -(0.00005 + Math.random() * 0.00018), a: 0.15 + Math.random() * 0.35, t: Math.random() * 6.28 });
  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const p of P) {
      const tw = 0.6 + 0.4 * Math.sin(p.t += 0.02);
      ctx.beginPath(); ctx.arc(p.x * W, p.y * H, p.r, 0, 6.283);
      ctx.fillStyle = `rgba(240,195,110,${(p.a * tw).toFixed(3)})`; ctx.fill();
    }
  }
  if (reduceMotion) { draw(); return; }
  (function tick() {
    const target = orb.dataset.state === 'speaking' ? 2.4 + outLevel * 2 : orb.dataset.state === 'listening' ? 1.3 : 1;
    speed += (target - speed) * 0.04;
    for (const p of P) { p.x += p.vx * speed; p.y += p.vy * speed; if (p.y < -0.02) { p.y = 1.02; p.x = Math.random(); } if (p.x < -0.02) p.x = 1.02; if (p.x > 1.02) p.x = -0.02; }
    if (!document.hidden) draw();
    requestAnimationFrame(tick);
  })();
})();

// ---------- tools ----------
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => { if (r.status === 401) showLock(); return r.json().catch(() => ({})).then(j => ({ ok: r.ok, ...j })); });
const getJ = url => fetch(url, { cache: 'no-store' }).then(r => { if (r.status === 401) showLock(); return r.json().catch(() => ({})).then(j => ({ ok: r.ok, status: r.status, ...j })); });
let pendingStop = null;
function here() {
  return new Promise((res, rej) => navigator.geolocation ? navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => rej(new Error('location blocked')), { timeout: 15000, maximumAge: 600000 }) : rej(new Error('no location')));
}
async function handleTool(f) {
  const a = f.args || {};
  try {
    if (f.name === 'save_memory') { const r = await post('/api/memory', { category: a.category, content: a.content }); if (r.ok) toast('Noted: ' + a.content); return r.ok ? 'saved' : 'not saved'; }
    if (f.name === 'save_answer') { const r = await post('/api/onboarding', { action: 'answer', topic: a.topic, question: a.question, answer: a.answer }); if (r.ok) toast('Noted · ' + (a.topic || 'answer')); return r.ok ? 'saved' : 'not saved'; }
    if (f.name === 'get_prayer_times') { const r = await getJ('/api/prayers'); return r.ok ? JSON.stringify({ today: r.today, tomorrow: r.tomorrow, next: r.next, mosque: r.mosque, travelling: r.travelling }) : 'unavailable'; }
    if (f.name === 'log_prayer') { const r = await post('/api/state', { action: 'log', name: a.prayer, status: a.status }); if (r.ok) { toast(a.status === 'clear' ? 'Cleared ' + a.prayer : 'Logged · ' + a.prayer + (a.status === 'jamaah' ? ' in jama\'ah' : a.status === 'missed' ? ' (missed)' : '')); loadLife(); } return r.ok ? 'logged' : (r.error || 'failed'); }
    if (f.name === 'log_habit') { const r = await post('/api/state', { action: 'log', name: a.name, status: a.done === false ? 'missed' : 'done' }); if (r.ok) { toast('Logged · ' + a.name); loadLife(); } return r.ok ? 'logged' : (r.error || 'failed'); }
    if (f.name === 'add_habit') { const r = await post('/api/state', { action: 'add_habit', name: a.name }); if (r.ok) { toast('New habit: ' + a.name); loadLife(); } return r.ok ? 'added' : 'failed'; }
    if (f.name === 'set_private_mode') {
      const r = await post('/api/state', { action: 'private', on: !!a.on, minutes: a.minutes });
      if (r.ok && a.on) { pendingStop = 'Standing down. Tap the orb when you want me back.'; }
      if (r.ok) loadLife();
      return r.ok ? (a.on ? 'Private mode on. Say at most two words, then the session ends.' : 'Private mode off.') : 'failed';
    }
    if (f.name === 'set_brief_time') { const r = await post('/api/state', { action: 'brief_time', time: a.time }); if (r.ok) toast('Morning brief · ' + a.time); return r.ok ? 'set' : (r.error || 'failed'); }
    if (f.name === 'find_mosques') {
      let body = { action: 'search', q: a.query, country: a.country || 'GB' };
      if (a.near_me || !a.query) { try { Object.assign(body, await here()); } catch (e) { if (!a.query) return 'Location is blocked on his phone; ask him for the area or postcode instead.'; } }
      const r = await post('/api/prayers', body); return r.ok ? JSON.stringify(r.results) : 'search unavailable';
    }
    if (f.name === 'set_mosque') { const r = await post('/api/prayers', { action: 'set_mosque', slug: a.slug }); if (r.ok) { toast('Mosque · ' + r.mosque); loadLife(); } return r.ok ? 'switched to ' + r.mosque : 'could not load that mosque'; }
    if (f.name === 'set_travelling') {
      if (!a.on) { const r = await post('/api/prayers', { action: 'home' }); loadLife(); return r.ok ? 'back to home mosque times' : 'failed'; }
      try { const loc = await here(); const r = await post('/api/prayers', { action: 'travel', ...loc }); loadLife(); toast('Travelling · local times'); return r.ok ? 'using calculated times for his location' : 'failed'; }
      catch (e) { return 'Location is blocked; could not switch to travel times.'; }
    }
    if (f.name === 'set_volume') {
      const c = curVol(), l = a.level;
      const v = setVol(l === 'quieter' ? c * 0.6 : l === 'louder' ? Math.max(0.1, c * 1.5) : l === 'whisper' ? 0.12 : (Number(l) || 50) / 100);
      toast('Her volume · ' + Math.round(v * 100) + '%'); return 'Volume now ' + Math.round(v * 100) + '%.';
    }
    if (f.name === 'set_alarm' || f.name === 'list_alarms' || f.name === 'cancel_alarm') return alarmTool(f.name, a);
    if (f.name === 'connect_google') { showGoogleChip(true); return 'The Connect Google button is on his screen; ask him to tap it and sign in with his JSE account.'; }
    if (f.name === 'get_calendar') { const r = await getJ('/api/google/calendar?range=' + encodeURIComponent(a.range || 'today')); return r.ok ? JSON.stringify(r.events) : (r.error || 'unavailable'); }
    if (f.name === 'find_free_time') { const r = await post('/api/google/free', a); return r.ok ? JSON.stringify(r.free) : (r.error || 'unavailable'); }
    if (f.name === 'create_event' || f.name === 'update_event') { pendingAction = { kind: f.name, args: a }; showEventCard(f.name, a); return 'NOT BOOKED YET. A confirmation card is on screen. Do not say it is booked or set up. Read the details back as a question, e.g. "Call with Jay, tomorrow 3 to 3:30 — shall I book it?", then wait for his yes.'; }
    if (f.name === 'confirm_pending') { if (!pendingAction) return 'Nothing is waiting for confirmation.'; const r = await runPending(); return r; }
    if (f.name === 'cancel_pending') { pendingAction = null; hideCard(); return 'Cancelled.'; }
    if (f.name === 'search_email') { const r = await post('/api/google/mail_search', { q: a.query }); return r.ok ? JSON.stringify(r.messages) : (r.error || 'unavailable'); }
    if (f.name === 'summarise_unread') { const r = await getJ('/api/google/mail_unread'); return r.ok ? JSON.stringify(r.messages) : (r.error || 'unavailable'); }
    if (f.name === 'read_email') { const r = await post('/api/google/mail_read', { id: a.id }); return r.ok ? JSON.stringify(r) : (r.error || 'unavailable'); }
    if (f.name === 'draft_email') { const r = await post('/api/google/draft', a); if (r.ok) showDraftCard(r.draft); return r.ok ? 'Draft saved in Gmail and shown on screen. It has NOT been sent.' : (r.error || 'failed'); }
    if (f.name === 'search_drive') { const r = await post('/api/google/drive_search', { q: a.query }); return r.ok ? JSON.stringify(r.files) : (r.error || 'unavailable'); }
    if (f.name === 'read_doc') { const r = await post('/api/google/drive_read', { id: a.id }); return r.ok ? JSON.stringify(r) : (r.error || 'unavailable'); }
    if (f.name === 'save_debrief') { const r = await post('/api/google/debrief_done', { event_id: a.event_id, summary: a.summary }); if (r.ok) toast('Debrief saved'); return r.ok ? 'saved' : 'failed'; }
    if (f.name === 'get_balances') { const r = await getJ('/api/money/balances'); return r.ok ? JSON.stringify(r) : (r.error || 'unavailable'); }
    if (f.name === 'spending_summary') { const r = await getJ('/api/money/spending?period=' + encodeURIComponent(a.period || 'this_month') + (a.category ? '&category=' + encodeURIComponent(a.category) : '')); return r.ok ? JSON.stringify(r) : (r.error || 'unavailable'); }
    if (f.name === 'list_subscriptions') { const r = await getJ('/api/money/subscriptions'); return r.ok ? JSON.stringify(r) : (r.error || 'unavailable'); }
    if (f.name === 'simulate') { const r = await post('/api/money/simulate', a); if (r.ok) toast(`Ran ${(r.runs || 10000).toLocaleString('en-GB')} futures`); return r.ok ? JSON.stringify(r) : (r.error || 'unavailable'); }
    if (f.name === 'set_savings_goal') { const r = await post('/api/money/goal', a); if (r.ok) toast('Savings goal set'); return r.ok ? JSON.stringify(r) : (r.error || 'failed'); }
    if (f.name === 'explain_patterns') { const r = await getJ('/api/money/patterns'); return r.ok ? JSON.stringify(r) : (r.error || 'unavailable'); }
    if (f.name === 'note_pattern') { const r = await post('/api/money/intro', { pattern_id: a.pattern_id, status: a.status }); return r.ok ? 'noted' : 'not saved'; }
    if (f.name === 'show_money') { openMoney(); return 'The money view is on his screen.'; }
    if (f.name === 'phone_today') {
      let live = null; try { if (APP && window.FreyaAndroid.phoneToday) live = JSON.parse(window.FreyaAndroid.phoneToday()); } catch (e) {}
      const r = await getJ('/api/state?phone=today');
      if (!live && (!r.ok || r.none)) return 'Phone awareness is not switched on yet (or has no data). Tell him he can turn it on in the FREYA app under the ⚙ settings: Usage access, Physical activity and Notification access.';
      return JSON.stringify({ live_from_phone_now: live, from_server: r.ok ? { today: r.today, yesterday: r.yesterday, usual: r.baseline } : null });
    }
    if (f.name === 'weekly_reflection') { const r = await getJ('/api/state?phone=week'); return r.ok ? JSON.stringify(r) : (r.error || 'unavailable'); }
    if (f.name === 'note_phone_pattern') { const r = await post('/api/state', { action: 'phone_note', id: a.pattern_id, answer: a.his_answer }); return r.ok ? 'noted' : 'not saved'; }
    if (f.name === 'enable_notifications') { showNotifyChip(true); return 'The button is on his screen now; ask him to tap it.'; }
    if (f.name === 'finish_onboarding') {
      const plan = { headline: a.headline, sections: a.sections || [], pledge: a.pledge };
      await post('/api/onboarding', { action: 'plan', plan });
      finishing = plan; return 'Plan is on screen now.';
    }
  } catch (e) { return 'error'; }
  return 'unknown tool';
}
function alarmTool(name, a) {
  if (!APP) return 'Alarms need the FREYA Android app (this is a plain browser). Tell him to install it from freya-black.vercel.app/app on his Samsung.';
  const when = t => new Date(t).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  if (name === 'list_alarms') { const l = JSON.parse(FreyaAndroid.listAlarms() || '[]'); return l.length ? JSON.stringify(l.map(x => ({ id: x.id, when: when(x.at), label: x.label }))) : 'No alarms set.'; }
  if (name === 'cancel_alarm') { const r = JSON.parse(FreyaAndroid.cancelAlarm(String(a.id || 'all'))); if (r.ok) toast('Alarm cancelled'); return r.ok ? 'Cancelled ' + r.cancelled + ' alarm(s).' : 'No matching alarm.'; }
  let at = null;
  if (a.in_minutes) at = Date.now() + Number(a.in_minutes) * 60000;
  else if (a.time && /^\d{1,2}:\d{2}$/.test(a.time)) {
    const [H, M] = a.time.split(':').map(Number);
    const d = a.date ? new Date(a.date + 'T00:00') : new Date();
    d.setHours(H, M, 0, 0);
    if (!a.date && d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    at = d.getTime();
  }
  if (!at || isNaN(at)) return 'I need a time (HH:MM) or minutes from now.';
  if (at <= Date.now()) return 'That time has already passed.';
  const r = JSON.parse(FreyaAndroid.setAlarm(at, a.label || 'Alarm'));
  if (r.ok) toast('⏰ ' + when(at) + (a.label ? ' · ' + a.label : ''));
  return r.ok ? 'Alarm set for ' + when(at) + ' (id ' + r.id + ').' + (r.exact ? '' : ' Exact alarms are off in his phone settings, so it may be a few minutes late.') : (r.error || 'Could not set the alarm.');
}
let turnDone = false;
function checkFinish() {
  if (pendingStop && turnDone && !sources.size) { const m = pendingStop; pendingStop = null; setTimeout(() => stop(m), 400); return; }
  if (finishing && turnDone && !sources.size) { const plan = finishing; finishing = null; forceOnboarding = false; setTimeout(() => { stop('Your plan is ready.'); showWrap(plan); }, 600); }
}

// ---------- session ----------
async function connect(isReconnect) {
  let q = forceOnboarding ? '?mode=onboarding' : (briefPending && !isReconnect ? '?mode=brief' : (debriefPending && !isReconnect ? '?mode=debrief&event=' + encodeURIComponent(debriefPending) : ''));
  const resuming = !!(isReconnect && resumeHandle);
  if (resuming) q += (q ? '&' : '?') + 'resume=' + encodeURIComponent(resumeHandle);
  const r = await fetch('/api/token' + q, { method: 'POST', cache: 'no-store' });
  if (r.status === 401) { showLock(); throw new Error('Locked. Unlock with your fingerprint first.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(j.error || "Couldn't reach her brain. Try again in a moment.");
  model = j.model; mode = j.mode || 'companion';
  await new Promise((resolve, reject) => {
    const sock = new WebSocket(WS_URL + '?access_token=' + encodeURIComponent(j.token));
    const to = setTimeout(() => reject(new Error('Connection timed out. Tap to try again.')), 12000);
    // The voice must be sent in the client setup too: a bare { model } setup falls back to Gemini's default voice.
    const voiceName = j.voice || 'Sulafat';
    sock.onopen = () => sock.send(JSON.stringify({ setup: { model, generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } } } }));
    sock.onerror = () => { clearTimeout(to); reject(new Error("Couldn't connect to her voice. Tap to try again.")); };
    sock.onclose = e => { clearTimeout(to); reject(new Error(e.reason ? 'Disconnected: ' + e.reason : "Couldn't connect. Tap to try again.")); };
    sock.onmessage = async ev => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text());
      if (m.setupComplete) { clearTimeout(to); const old = ws; ws = sock; try { old && old !== sock && old.close(1000); } catch (e) {} resolve(); }
    };
  });
  const sock = ws;
  sock.onmessage = async ev => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text());
    if (m.sessionResumptionUpdate && m.sessionResumptionUpdate.resumable !== false && m.sessionResumptionUpdate.newHandle) resumeHandle = m.sessionResumptionUpdate.newHandle;
    if (m.toolCall) {
      setBusy(true);
      const calls = m.toolCall.functionCalls || [];
      const results = await Promise.all(calls.map(handleTool));
      if (sock.readyState === 1) sock.send(JSON.stringify({ toolResponse: { functionResponses: calls.map((f, i) => ({ id: f.id, name: f.name, response: { result: results[i] } })) } }));
    }
    const sc = m.serverContent;
    if (sc) {
      if (sc.interrupted) { stopPlayback(); newHerTurn = true; }
      if (sc.inputTranscription && sc.inputTranscription.text) {
        caption(himEl, sc.inputTranscription.text, !newHimTurn, 7000); newHimTurn = false; newHerTurn = true;
        if (!sources.size) setBusy(true);
      }
      if (sc.outputTranscription && sc.outputTranscription.text) { caption(herEl, sc.outputTranscription.text, !newHerTurn, 9000); newHerTurn = false; newHimTurn = true; }
      for (const p of (sc.modelTurn && sc.modelTurn.parts) || []) if (p.inlineData && p.inlineData.data) { turnDone = false; playPcm(p.inlineData.data); }
      if (sc.turnComplete) { turnDone = true; newHerTurn = true; setBusy(false); checkFinish(); }
    }
    if (m.goAway && active) refresh();
  };
  sock.onclose = e => { if (active && ws === sock) refresh(e); };
  if (isReconnect) {
    // Reconnects are silent: the conversation resumes (same history) and she waits for him. No cue, no greeting, no replay.
  } else if (mode === 'onboarding') {
    sock.send(JSON.stringify({ realtimeInput: { text: '(Cue: Eesah just tapped the orb to start his onboarding. Begin now.)' } }));
    setBusy(true);
  } else if (j.debrief) {
    debriefPending = null; history.replaceState(null, '', '/');
    sock.send(JSON.stringify({ realtimeInput: { text: '(Cue: Eesah opened the debrief. Begin it now.)' } })); setBusy(true);
  } else if (j.brief) {
    briefPending = false; history.replaceState(null, '', '/');
    sock.send(JSON.stringify({ realtimeInput: { text: '(Cue: Eesah opened his morning brief. Begin it now.)' } })); setBusy(true);
  } else if (nudgePending) {
    const t = nudgePending; nudgePending = '';
    sock.send(JSON.stringify({ realtimeInput: { text: '(Cue: spoken nudge from his phone, not his words: "' + t.replace(/["()]/g, '') + '". Say it to him now in one short, warm, light line in your own words, no lecture, then stop and wait. If he says not now or that it is work, accept it in a few words.)' } })); setBusy(true);
  }
  retries = 0;
}
async function refresh(e) {
  if (!active || connecting) return;
  if (retries++ >= 3) return stop('Connection dropped' + (e && e.reason ? ': ' + e.reason : '') + '. Tap to reconnect.');
  connecting = true; setStatus('Reconnecting…'); setBusy(true);
  try { await connect(true); connecting = false; setStatus('Listening…'); setBusy(false); }
  catch (err) { connecting = false; stop(err.message); }
}

async function start() {
  if (connecting) return; connecting = true;
  setState('connecting'); setStatus('Connecting…'); clearCaptions();
  try {
    if (!navigator.onLine) throw new Error("You're offline. Check your connection and try again.");
    outCtx = new AudioContext({ sampleRate: 24000 });
    micCtx = new AudioContext({ sampleRate: 16000 });
    outCtx.resume(); micCtx.resume();
    analyser = outCtx.createAnalyser(); analyser.fftSize = 256;
    outGain = outCtx.createGain(); outGain.gain.value = curVol(); analyser.connect(outGain); outGain.connect(outCtx.destination);
    let micOk = true;
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }); }
    catch (e) { micOk = false; }
    if (micOk) {
      await micCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
      micNode = new AudioWorkletNode(micCtx, 'pcm16');
      micCtx.createMediaStreamSource(micStream).connect(micNode);
      micNode.port.onmessage = e => {
        const s = new Int16Array(e.data); let sum = 0; for (let i = 0; i < s.length; i += 4) sum += s[i] * s[i];
        micLevel = Math.max(micLevel, Math.min(1, Math.sqrt(sum / (s.length / 4)) / 6000));
        // Echo guard: while she's speaking (and just after), her own voice from the speaker must not count as him.
        // Quiet frames are replaced with silence; speaking up clearly over her still interrupts (barge-in).
        const herTalking = sources.size > 0 || performance.now() - lastPlayEnd < 500;
        const lvl = Math.sqrt(sum / (s.length / 4)) / 6000;
        const data = herTalking && lvl < 0.35 ? new ArrayBuffer(e.data.byteLength) : e.data;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64FromBuf(data), mimeType: 'audio/pcm;rate=16000' } } }));
      };
    }
    active = true; turnDone = false; finishing = null; resumeHandle = null;
    await connect(false);
    connecting = false;
    $('textbar').hidden = false; $('redo').hidden = true;
    if (APP) try { FreyaAndroid.sessionActive(true); } catch (e) {}
    setState('listening');
    setStatus(micOk ? (mode === 'onboarding' ? 'Setting you up · listening…' : 'Listening…') : 'Mic is off. Type to talk to her below.');
  } catch (e) {
    connecting = false; stop(e.message || 'Something went wrong. Tap to try again.');
  }
}

function stop(msg) {
  active = false; setBusy(false);
  if (APP) try { FreyaAndroid.sessionActive(false); } catch (e) {}
  const s = ws; ws = null; try { s && s.close(1000); } catch (e) {}
  try { micNode && micNode.disconnect(); } catch (e) {} micNode = null;
  micStream && micStream.getTracks().forEach(t => t.stop()); micStream = null;
  sources.forEach(x => { try { x.stop(); } catch (e) {} }); sources.clear(); nextTime = 0;
  micCtx && micCtx.close().catch(() => {}); micCtx = null;
  outCtx && outCtx.close().catch(() => {}); outCtx = null; analyser = null; outGain = null;
  $('textbar').hidden = true; $('redo').hidden = !(onboardingState.configured && onboardingState.status === 'complete');
  setState('idle'); setStatus(msg || idleMsg);
}

orb.addEventListener('click', () => {
  if (!authed) return showLock();
  if (active) return stop();
  if (life && life.private && life.private.manualUntil) { post('/api/state', { action: 'private', on: false }).then(loadLife); }
  start();
});
orb.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); orb.click(); } });
$('textbar').addEventListener('submit', e => {
  e.preventDefault(); const t = $('textin').value.trim(); if (!t || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ realtimeInput: { text: t } })); caption(himEl, t, false, 7000); newHimTurn = true; $('textin').value = ''; setBusy(true);
});
document.addEventListener('visibilitychange', () => { if (document.hidden && active) stop('Paused while FREYA was in the background. Tap to talk.'); });

// ---------- onboarding status ----------
async function loadOnboarding() {
  try { const r = await getJ('/api/onboarding'); if (r.status === 401) return; onboardingState = r; }
  catch (e) { onboardingState = { configured: false }; }
  if (!onboardingState.configured) return;
  const st = onboardingState.status;
  if (st === 'awaiting_pledge' && onboardingState.plan) { idleMsg = 'Your plan is waiting for your signature.'; showWrap(onboardingState.plan); }
  else if (st !== 'complete' || forceOnboarding) idleMsg = greeting + " Before anything else, let's set you up properly. Tap the orb to begin.";
  else { $('redo').hidden = false; showNotifyChip(false); }
  if (briefPending && st === 'complete') idleMsg = 'Your morning brief is ready. Tap the orb.';
  if (debriefPending && st === 'complete') idleMsg = 'Debrief ready. Tap the orb and tell me how it went.';
  if (!active) setStatus(idleMsg);
}
$('redo').addEventListener('click', async () => {
  if (!confirm('Redo your setup with Freya? Your memories stay; she will walk you through it again.')) return;
  const r = await post('/api/onboarding', { action: 'reset' });
  if (r.ok) { onboardingState.status = 'not_started'; $('redo').hidden = true; idleMsg = "Fresh start. Tap the orb and she'll walk you through it."; setStatus(idleMsg); }
  else toast("Couldn't reset right now.");
});

// ---------- wrap-up: plan, PDF, pledge, contacts ----------
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let currentPlan = null, sigDirty = false;
function showWrap(plan) {
  currentPlan = plan;
  $('plan-headline').textContent = plan.headline || 'Your plan';
  $('plan-sections').innerHTML = (plan.sections || []).map((s, i) => `<div class="card" style="animation-delay:${i * 0.12}s"><b>${esc(s.area)}</b>${esc(s.focus)}<ul>${(s.actions || []).map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>`).join('');
  $('pledge').value = plan.pledge || '';
  if (!$('contacts').children.length) { addContact(); addContact(); }
  $('wrap').hidden = false; $('wrap').scrollTop = 0; setupSig();
}
function addContact() {
  const d = document.createElement('div'); d.className = 'contact';
  d.innerHTML = '<input placeholder="Name" data-k="name"><input placeholder="Relation (e.g. brother)" data-k="relation"><input placeholder="Phone number" type="tel" data-k="phone">';
  $('contacts').appendChild(d);
}
$('add-contact').addEventListener('click', addContact);
function setupSig() {
  const c = $('sig'), r = c.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr;
  const x = c.getContext('2d'); x.scale(dpr, dpr); x.fillStyle = '#f7f0e2'; x.fillRect(0, 0, r.width, r.height);
  x.strokeStyle = '#1f1408'; x.lineWidth = 2.4; x.lineCap = x.lineJoin = 'round'; sigDirty = false;
  let drawing = false;
  c.onpointerdown = e => { drawing = true; c.setPointerCapture(e.pointerId); x.beginPath(); x.moveTo(e.offsetX, e.offsetY); };
  c.onpointermove = e => { if (!drawing) return; x.lineTo(e.offsetX, e.offsetY); x.stroke(); sigDirty = true; };
  c.onpointerup = c.onpointercancel = () => { drawing = false; };
}
$('sig-clear').addEventListener('click', setupSig);
function loadJsPdf() {
  if (window.jspdf) return Promise.resolve();
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'; s.onload = res; s.onerror = () => rej(new Error('PDF tool failed to load. Check your connection.')); document.head.appendChild(s); });
}
$('pdf').addEventListener('click', async () => {
  try {
    await loadJsPdf(); const { jsPDF } = window.jspdf; const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const W = 595, M = 50; let y = 60;
    const line = (t, size, color, gap) => { doc.setFontSize(size); doc.setTextColor(...color); for (const l of doc.splitTextToSize(String(t), W - 2 * M)) { if (y > 790) { doc.addPage(); y = 60; } doc.text(l, M, y); y += size * 1.35; } y += gap || 0; };
    line('F.R.E.Y.A.  ·  Life plan for Eesah', 11, [168, 100, 28], 6);
    line(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }), 9, [120, 110, 100], 14);
    line(currentPlan.headline || '', 18, [30, 20, 8], 12);
    for (const s of currentPlan.sections || []) { line(s.area, 13, [168, 100, 28], 2); line(s.focus, 11, [40, 30, 20], 2); for (const a of s.actions || []) line('•  ' + a, 11, [40, 30, 20]); y += 10; }
    line('My pledge', 13, [168, 100, 28], 2); line($('pledge').value, 11, [40, 30, 20], 10);
    if (sigDirty) { if (y > 700) { doc.addPage(); y = 60; } doc.addImage($('sig').toDataURL('image/png'), 'PNG', M, y, 200, 200 * $('sig').height / $('sig').width); y += 200 * $('sig').height / $('sig').width + 10; line('Signed by Eesah', 9, [120, 110, 100]); }
    if (APP && window.FreyaAndroid.saveFile) {
      // Android app: the WebView can't do blob downloads, so hand the bytes to the app to save in Downloads.
      const r = JSON.parse(FreyaAndroid.saveFile(doc.output('datauristring').split(',')[1], 'FREYA-life-plan.pdf', 'application/pdf'));
      toast(r.ok ? 'Saved to Downloads · FREYA-life-plan.pdf' : (r.error || "Couldn't save the PDF."));
    } else doc.save('FREYA-life-plan.pdf');
  } catch (e) { toast(e.message || "Couldn't make the PDF."); }
});
$('commit').addEventListener('click', async () => {
  const err = $('wrap-err'); err.textContent = '';
  const contacts = [...document.querySelectorAll('.contact')].map(d => Object.fromEntries([...d.querySelectorAll('input')].map(i => [i.dataset.k, i.value.trim()]))).filter(c => c.name && c.phone);
  if (!$('pledge').value.trim()) return err.textContent = 'Your pledge is empty.';
  if (!sigDirty) return err.textContent = 'Sign with your finger first.';
  if (contacts.length < 2) return err.textContent = 'Add at least two emergency contacts with a name and phone number.';
  $('commit').disabled = true; $('commit').textContent = 'Saving…';
  const r = await post('/api/onboarding', { action: 'pledge', text: $('pledge').value.trim(), signature_png: $('sig').toDataURL('image/png'), contacts }).catch(() => ({ ok: false }));
  $('commit').disabled = false; $('commit').textContent = 'Sign & commit';
  if (!r.ok) return err.textContent = r.error || "Couldn't save. Check your connection and try again.";
  $('wrap').hidden = true; onboardingState.status = 'complete'; $('redo').hidden = false;
  idleMsg = "Signed and sealed, Eesah. I've got your back. Tap the orb to talk."; setStatus(idleMsg); toast('Pledge saved');
  if (forceOnboarding) { forceOnboarding = false; history.replaceState(null, '', '/'); }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
boot();

// ================= Sign-in (passkey, single owner) =================
let authed = false, life = null;
const b2u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const u2b = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer; };
function lockView(v) { document.querySelectorAll('#lock [data-v]').forEach(e => { e.hidden = e.dataset.v !== v; }); }
function showLock(view) {
  authed = false; if (active) stop();
  $('lock').hidden = false; $('lock-err').textContent = '';
  if (view) return lockView(view);
  getJ('/api/auth/status').then(s => lockView(s.enrolled ? 'unlock' : 'enrol')).catch(() => lockView('unlock'));
}
async function enrol(recovery) {
  const err = $('lock-err'); err.textContent = '';
  try {
    const o = await post('/api/auth/register-options', { recovery });
    if (!o.ok) throw new Error(o.error || 'Could not start setup.');
    const cred = await navigator.credentials.create({ publicKey: {
      ...o, challenge: u2b(o.challenge), user: { ...o.user, id: u2b(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: u2b(c.id) }))
    } });
    const r = await post('/api/auth/register-verify', { response: {
      id: cred.id, rawId: b2u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: { clientDataJSON: b2u(cred.response.clientDataJSON), attestationObject: b2u(cred.response.attestationObject), transports: cred.response.getTransports ? cred.response.getTransports() : [] }
    } });
    if (!r.ok) throw new Error(r.error || 'Setup failed.');
    authed = true;
    if (r.recovery) { $('rcode').textContent = r.recovery; lockView('recovery'); } else unlocked();
  } catch (e) { err.textContent = e.name === 'NotAllowedError' ? 'Cancelled. Tap to try again.' : (e.message || 'Setup failed.'); }
}
async function unlock() {
  const err = $('lock-err'); err.textContent = '';
  try {
    const o = await post('/api/auth/login-options', {});
    if (!o.ok) throw new Error(o.error || 'Could not start sign-in.');
    const cred = await navigator.credentials.get({ publicKey: { ...o, challenge: u2b(o.challenge), allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: u2b(c.id) })) } });
    const r = await post('/api/auth/login-verify', { response: {
      id: cred.id, rawId: b2u(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
      response: { clientDataJSON: b2u(cred.response.clientDataJSON), authenticatorData: b2u(cred.response.authenticatorData), signature: b2u(cred.response.signature), userHandle: cred.response.userHandle ? b2u(cred.response.userHandle) : undefined }
    } });
    if (!r.ok) throw new Error(r.error || 'Sign-in failed.');
    authed = true; unlocked();
  } catch (e) { err.textContent = e.name === 'NotAllowedError' ? 'Cancelled. Tap Unlock to try again.' : (e.message || 'Sign-in failed.'); }
}
function unlocked() { $('lock').hidden = true; loadOnboarding(); loadLife(); wakeGo(); }
// "Freya" wake word (Android app): ?wake=1 or window.freyaWake() starts talking straight away once signed in.
function wakeGo() {
  if (!wakePending || !authed) return;
  wakePending = false;
  if (location.search) history.replaceState(null, '', '/');
  if (!active && !connecting) start();
}
window.freyaWake = () => { wakePending = true; if (authed) wakeGo(); else { showLock('unlock'); unlock(); } };
$('btn-enrol').addEventListener('click', () => enrol());
$('btn-unlock').addEventListener('click', unlock);
$('btn-saved').addEventListener('click', unlocked);
$('btn-copy').addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText($('rcode').textContent).then(() => toast('Recovery code copied')); });
$('to-recover').addEventListener('click', () => lockView('recover'));
$('btn-recover').addEventListener('click', () => enrol($('recin').value.trim()));
$('back-unlock').addEventListener('click', () => lockView('unlock'));
async function boot() {
  const s = await getJ('/api/auth/status').catch(() => ({ ok: false }));
  if (s.ok && s.authed) { authed = true; return unlocked(); }
  if (!s.ok) { authed = true; loadOnboarding(); return wakeGo(); } // memory not configured: voice-only mode
  showLock(s.enrolled ? 'unlock' : 'enrol');
  if (s.enrolled) unlock(); // one tap: the fingerprint prompt appears straight away
}

// ================= Daily life: next prayer, dots, private mode =================
const PR = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'], cap = n => n[0].toUpperCase() + n.slice(1);
async function loadLife() {
  const r = await getJ('/api/state').catch(() => null);
  if (!r || !r.ok) return;
  life = r; renderLife();
}
function renderLife() {
  if (!life || !life.schedule) return;
  $('top').hidden = false;
  const sc = life.schedule, n = sc.next;
  const pv = life.private || {};
  document.body.classList.toggle('private', !!pv.on);
  let txt = '';
  if (pv.on) txt = pv.manualUntil ? 'Private · standing down' : pv.auto ? `Private · ${cap(pv.auto.prayer)} until ${pv.auto.until}` : `In a meeting · until ${pv.meeting.until}`;
  else if (n) {
    const target = n.iqamah || n.adhan, mins = minutesUntil(target, n.day);
    txt = `${n.prayer === 'dhuhr' && sc.today.jumuah && n.day === 'today' ? "Jumu'ah" : cap(n.prayer)} ${n.iqamah ? "jama'ah " : ''}${target} · ${fmtIn(mins)}`;
  }
  $('next').textContent = txt + (sc.travelling ? ' · travelling' : sc.today.source !== 'mawaqit' ? ' · calculated' : '');
  const habits = life.habits || [];
  $('dots').innerHTML = PR.map(p => {
    const h = habits.find(x => x.kind === 'prayer' && x.name.toLowerCase() === p) || {};
    const st = h.today || '', done = ['done', 'prayed', 'jamaah', 'qada'].includes(st);
    return `<button class="dot ${done ? 'done' : ''} ${st === 'missed' ? 'missed' : ''} ${st === 'jamaah' ? 'jamaah' : ''}" data-p="${p}" aria-label="${cap(p)}: ${st || 'not logged'}"><i></i><span>${cap(p)[0]}</span></button>`;
  }).join('');
  if (!active) setStatus(pv.on && pv.auto && !pv.manualUntil ? `Salah time. I'll be here after ${cap(pv.auto.prayer)}.` : pv.on && pv.meeting && !pv.manualUntil ? `You're in "${pv.meeting.summary}". I'll keep quiet.` : idleMsg);
  showGoogleChip(false);
  $('mbtn').hidden = onboardingState.status !== 'complete';
  if (moneyPending && onboardingState.status === 'complete') { moneyPending = false; history.replaceState(null, '', '/'); openMoney(); }
}
function minutesUntil(hm, day) {
  const [h, m] = hm.split(':').map(Number);
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
  return h * 60 + m + (day === 'tomorrow' ? 1440 : 0) - (now.getHours() * 60 + now.getMinutes());
}
const fmtIn = m => m <= 0 ? 'now' : m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)}h ${m % 60}m`;
setInterval(() => { if (authed && life) { renderLife(); } }, 30000);
setInterval(() => { if (authed && !document.hidden) loadLife(); }, 5 * 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && authed) loadLife(); });
$('dots').addEventListener('click', e => {
  const b = e.target.closest('.dot'); if (!b) return;
  const p = b.dataset.p, h = (life.habits || []).find(x => x.kind === 'prayer' && x.name.toLowerCase() === p) || {};
  const cycle = { '': 'prayed', null: 'prayed', prayed: 'jamaah', jamaah: 'missed', missed: 'clear', done: 'jamaah', qada: 'clear' };
  const next = cycle[h.today || ''] || 'prayed';
  h.today = next === 'clear' ? null : next; renderLife();
  post('/api/state', { action: 'log', name: p, status: next }).then(r => { if (r.ok) toast(next === 'clear' ? `${cap(p)} cleared` : `${cap(p)} · ${next === 'jamaah' ? "in jama'ah" : next}`); loadLife(); });
});
// Check-in from a notification: /?log=asr
(function () {
  const p = new URLSearchParams(location.search).get('log');
  if (!p || !PR.includes(p)) return;
  $('logq-title').textContent = `Did you pray ${cap(p)}?`; $('logq').hidden = false;
  $('logq').onclick = e => {
    const st = e.target.dataset && e.target.dataset.s; if (!st) return;
    $('logq').hidden = true; history.replaceState(null, '', '/');
    if (st !== 'later') post('/api/state', { action: 'log', name: p, status: st }).then(() => { toast(`${cap(p)} logged`); loadLife(); });
  };
})();

// ================= Notifications =================
function showNotifyChip(force) {
  if (!('Notification' in window) || !('PushManager' in window)) return;
  if (Notification.permission === 'granted') { ensurePush(); return; }
  if (Notification.permission === 'default' && (force || (onboardingState.status === 'complete'))) $('notify').hidden = false;
}
async function ensurePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const k = await getJ('/api/push'); if (!k.ok) return;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u2b(k.publicKey) });
    }
    await post('/api/push', { action: 'subscribe', sub: sub.toJSON() });
    return true;
  } catch (e) { return false; }
}
$('notify').addEventListener('click', async () => {
  const p = await Notification.requestPermission();
  $('notify').hidden = true;
  if (p === 'granted' && await ensurePush()) { await post('/api/push', { action: 'test' }); toast('Reminders on'); }
  else toast('Notifications are blocked. You can allow them in phone settings.');
});


// ================= Google Workspace =================
function showGoogleChip(force) {
  const gg = (life && life.google) || {};
  const done = onboardingState.status === 'complete';
  const chip = $('gchip');
  if (gg.connected) { chip.hidden = true; $('glink').hidden = !done; $('glink').textContent = 'Google ✓'; return; }
  $('glink').hidden = true;
  if (gg.status === 'expired') { chip.textContent = 'Reconnect Google'; chip.hidden = false; return; }
  if (force || (done && gg.status !== 'disconnected')) { chip.textContent = 'Connect Google (JSE)'; chip.hidden = false; }
}
$('gchip').addEventListener('click', () => { if (active) stop(); location.href = '/api/google/start'; });
$('glink').addEventListener('click', async () => {
  if (!confirm(`Disconnect Google (${(life.google && life.google.email) || 'JSE'})? Freya will stop seeing your calendar, email and Drive.`)) return;
  const r = await post('/api/google/disconnect', {}); if (r.ok) { toast('Google disconnected'); loadLife(); }
});
function card(html) { $('card-body').innerHTML = html; $('card').hidden = false; }
function hideCard() { $('card').hidden = true; }
const fmtWhen = (s, e) => { try { const d = new Date(s); return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + s.slice(11, 16) + (e ? '–' + e.slice(11, 16) : ''); } catch (x) { return s; } };
function showEventCard(kind, a) {
  card(`<p class="kicker">${kind === 'create_event' ? 'New event' : 'Change event'} · needs your OK</p><h3>${esc(a.title || '(same title)')}</h3><p>${a.start ? esc(fmtWhen(a.start, a.end)) : ''}${a.location ? '<br>' + esc(a.location) : ''}${a.add_meet ? '<br>With Google Meet' : ''}${a.attendees && a.attendees.length ? '<br>Guests: ' + esc(a.attendees.join(', ')) + ' (no invites sent)' : ''}</p><div class="row"><button class="ghost" data-c="cancel">Cancel</button><button data-c="ok">Confirm</button></div>`);
}
function showDraftCard(d) {
  card(`<p class="kicker">Draft saved · not sent</p><h3>${esc(d.subject || '(no subject)')}</h3><p class="hint">To: ${esc(d.to || '—')}</p><pre>${esc(d.body || '')}</pre><div class="row"><button class="ghost" data-c="close">Close</button><a class="btn" href="${d.link}" target="_blank" rel="noopener">Open Gmail drafts</a></div>`);
}
async function runPending() {
  const pa = pendingAction; pendingAction = null; if (!pa) return 'Nothing pending.';
  const r = await post('/api/google/' + pa.kind, pa.args);
  if (r.ok) { hideCard(); toast(pa.kind === 'create_event' ? 'Added to calendar' : 'Event updated'); return 'Done: ' + JSON.stringify(r.event); }
  card(`<p class="err">${esc(r.error || 'Calendar update failed.')}</p><div class="row"><button class="ghost" data-c="close">Close</button></div>`);
  return 'Failed: ' + (r.error || 'unknown');
}
$('card').addEventListener('click', async e => {
  const c = e.target.dataset && e.target.dataset.c; if (!c) return;
  if (c === 'close') return hideCard();
  if (c === 'cancel') { pendingAction = null; hideCard(); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ realtimeInput: { text: '(Cue: he tapped Cancel on the card. Nothing was written.)' } })); return; }
  if (c === 'ok') { const res = await runPending(); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ realtimeInput: { text: '(Cue: he tapped Confirm. Result: ' + res + ' Acknowledge in a few words.)' } })); }
});


// ================= Money (read-only) =================
var moneyPending = new URLSearchParams(location.search).has('money');
const gb = n => (n < 0 ? '-£' : '£') + Math.abs(+n || 0).toLocaleString('en-GB', { maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0, minimumFractionDigits: Math.abs(n) < 100 && n % 1 ? 2 : 0 });
async function openMoney() {
  $('money').hidden = false; $('mbody').innerHTML = '<p class="hint">Loading…</p>';
  const r = await getJ('/api/money/summary');
  if (!r.ok || r.empty) { $('mbody').innerHTML = `<p class="hint">${esc(r.error || 'Money is not available right now.')}</p>`; return; }
  const b = r.balances, m = r.this_month, top = (r.insights || [])[0];
  const max = Math.max(1, ...m.by_category.map(c => Math.max(c.spent, c.usual)));
  const asOf = r.as_of ? new Date(r.as_of).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  $('mbody').innerHTML = `
    <div><div class="mtotal">${gb(b.total)}</div><div class="msub">Across ${b.accounts.length} account${b.accounts.length === 1 ? '' : 's'}${asOf ? ' · updated ' + esc(asOf) : ''}</div></div>
    ${top ? `<div class="minsight ${top.level}">${esc(top.text)}</div>` : '<div class="minsight">Nothing needs your attention. Keep going.</div>'}
    <div>${b.accounts.map(a => `<div class="macc"><span>${esc(a.name)} <span class="msub">${esc(a.type)}</span></span><span>${gb(a.balance)}</span></div>`).join('')}</div>
    <div><h3>This month · ${gb(m.spent)} spent</h3><p class="msub" style="margin:4px 0 8px">Line marks your usual for a full month. Income so far ${gb(m.income)}.</p>
      ${m.by_category.slice(0, 9).map(c => `<div class="mcat"><span>${esc(c.category)}</span><div class="mbar"><i style="width:${(c.spent / max * 100).toFixed(1)}%"></i>${c.usual ? `<b style="left:${Math.min(99, c.usual / max * 100).toFixed(1)}%"></b>` : ''}</div><span>${gb(c.spent)}</span></div>`).join('') || '<p class="hint">No spending yet this month.</p>'}</div>
    ${r.upcoming && r.upcoming.length ? `<div><h3>Due soon</h3><div class="mlist">${r.upcoming.slice(0, 6).map(u => `<div><span>${esc(u.name)} · ${esc(new Date(u.due + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }))}</span><span>${gb(u.amount)}</span></div>`).join('')}</div></div>` : ''}
    ${(r.insights || []).length > 1 ? `<div><h3>Also</h3><div class="mlist">${r.insights.slice(1, 5).map(i => `<div><span>${esc(i.text)}</span></div>`).join('')}</div></div>` : ''}
    <div><h3>Patterns</h3><div class="mlist">${(r.patterns || []).length ? r.patterns.slice(0, 4).map(t => `<div><span>${esc(t)}</span></div>`).join('') : '<div><span>Still getting to know how you spend. I\'ll share what I notice as we go.</span></div>'}</div></div>
    ${r.goal ? `<div><h3>Goal</h3><div class="mlist"><div><span>${esc(r.goal.label)}${r.goal.by ? ' · by ' + esc(r.goal.by) : ''}</span><span>${r.goal.amount ? gb(r.goal.amount) : gb(r.goal.monthly) + '/mo'}</span></div></div></div>` : ''}
    <p class="msub">Ask Freya "what if…" to run 10,000 futures. Read-only: she can't move money.</p>`;
}
$('mbtn').addEventListener('click', openMoney);
$('mclose').addEventListener('click', () => { $('money').hidden = true; });

// ---------- Android app settings ----------
if (APP) { const ab = $('appbtn'); if (ab) { ab.hidden = false; ab.addEventListener('click', () => FreyaAndroid.openSettings()); } }

// ---------- volume control ----------
(() => {
  const b = $('volbtn'), r = $('volr'); if (!b || !r) return;
  r.value = Math.round(curVol() * 100);
  b.addEventListener('click', () => { r.hidden = !r.hidden; r.value = Math.round(curVol() * 100); });
  r.addEventListener('input', () => setVol(r.value / 100));
  r.addEventListener('change', () => { toast('Her volume · ' + r.value + '%' + (isNight() ? ' (night)' : '')); setTimeout(() => { r.hidden = true; }, 1500); });
})();

// Android volume keys also step her in-app volume so they always make an audible difference.
window.freyaVolumeKey = dir => { const v = setVol(curVol() + (dir > 0 ? 0.1 : -0.1)); toast('Her volume · ' + Math.round(v * 100) + '%'); };
