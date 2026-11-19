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

let ws = null, micCtx = null, micStream = null, micNode = null, outCtx = null, analyser = null;
let nextTime = 0, sources = new Set(), active = false, connecting = false, model = null, mode = 'companion';
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
  src.onended = () => { sources.delete(src); if (!sources.size && active) { setState('listening'); setStatus(mode === 'onboarding' ? 'Setting you up · listening…' : 'Listening…'); checkFinish(); } };
  setBusy(false); setState('speaking'); setStatus('Speaking…');
}
function stopPlayback() {
  sources.forEach(s => { try { s.stop(); } catch (e) {} }); sources.clear(); nextTime = 0;
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
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json().catch(() => ({})).then(j => ({ ok: r.ok, ...j })));
async function handleTool(f) {
  const a = f.args || {};
  try {
    if (f.name === 'save_memory') { const r = await post('/api/memory', { category: a.category, content: a.content }); if (r.ok) toast('Noted: ' + a.content); return r.ok ? 'saved' : 'not saved'; }
    if (f.name === 'save_answer') { const r = await post('/api/onboarding', { action: 'answer', topic: a.topic, question: a.question, answer: a.answer }); if (r.ok) toast('Noted · ' + (a.topic || 'answer')); return r.ok ? 'saved' : 'not saved'; }
    if (f.name === 'finish_onboarding') {
      const plan = { headline: a.headline, sections: a.sections || [], pledge: a.pledge };
      await post('/api/onboarding', { action: 'plan', plan });
      finishing = plan; return 'Plan is on screen now.';
    }
  } catch (e) { return 'error'; }
  return 'unknown tool';
}
let turnDone = false;
function checkFinish() {
  if (finishing && turnDone && !sources.size) { const plan = finishing; finishing = null; forceOnboarding = false; setTimeout(() => { stop('Your plan is ready.'); showWrap(plan); }, 600); }
}

// ---------- session ----------
async function connect(isReconnect) {
  const q = forceOnboarding ? '?mode=onboarding' : '';
  const r = await fetch('/api/token' + q, { method: 'POST', cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(j.error || "Couldn't reach her brain. Try again in a moment.");
  model = j.model; mode = j.mode || 'companion';
  await new Promise((resolve, reject) => {
    const sock = new WebSocket(WS_URL + '?access_token=' + encodeURIComponent(j.token));
    const to = setTimeout(() => reject(new Error('Connection timed out. Tap to try again.')), 12000);
    sock.onopen = () => sock.send(JSON.stringify({ setup: { model } }));
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
  if (mode === 'onboarding') {
    const cue = isReconnect ? '(Cue: the connection refreshed. Continue the onboarding naturally from where you left off. Do not greet again.)'
      : '(Cue: Eesah just tapped the orb to start his onboarding. Begin now.)';
    sock.send(JSON.stringify({ realtimeInput: { text: cue } }));
    setBusy(true);
  } else if (isReconnect) {
    sock.send(JSON.stringify({ realtimeInput: { text: '(Cue: the connection refreshed. Do not say anything; wait for Eesah.)' } }));
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
    analyser = outCtx.createAnalyser(); analyser.fftSize = 256; analyser.connect(outCtx.destination);
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
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64FromBuf(e.data), mimeType: 'audio/pcm;rate=16000' } } }));
      };
    }
    active = true; turnDone = false; finishing = null;
    await connect(false);
    connecting = false;
    $('textbar').hidden = false; $('redo').hidden = true;
    setState('listening');
    setStatus(micOk ? (mode === 'onboarding' ? 'Setting you up · listening…' : 'Listening…') : 'Mic is off. Type to talk to her below.');
  } catch (e) {
    connecting = false; stop(e.message || 'Something went wrong. Tap to try again.');
  }
}

function stop(msg) {
  active = false; setBusy(false);
  const s = ws; ws = null; try { s && s.close(1000); } catch (e) {}
  try { micNode && micNode.disconnect(); } catch (e) {} micNode = null;
  micStream && micStream.getTracks().forEach(t => t.stop()); micStream = null;
  sources.forEach(x => { try { x.stop(); } catch (e) {} }); sources.clear(); nextTime = 0;
  micCtx && micCtx.close().catch(() => {}); micCtx = null;
  outCtx && outCtx.close().catch(() => {}); outCtx = null; analyser = null;
  $('textbar').hidden = true; $('redo').hidden = !(onboardingState.configured && onboardingState.status === 'complete');
  setState('idle'); setStatus(msg || idleMsg);
}

orb.addEventListener('click', () => { active ? stop() : start(); });
orb.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); orb.click(); } });
$('textbar').addEventListener('submit', e => {
  e.preventDefault(); const t = $('textin').value.trim(); if (!t || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ realtimeInput: { text: t } })); caption(himEl, t, false, 7000); newHimTurn = true; $('textin').value = ''; setBusy(true);
});
document.addEventListener('visibilitychange', () => { if (document.hidden && active) stop('Paused while FREYA was in the background. Tap to talk.'); });

// ---------- onboarding status ----------
async function loadOnboarding() {
  try {
    const r = await fetch('/api/onboarding', { cache: 'no-store' }); onboardingState = await r.json();
  } catch (e) { onboardingState = { configured: false }; }
  if (!onboardingState.configured) return;
  const st = onboardingState.status;
  if (st === 'awaiting_pledge' && onboardingState.plan) { idleMsg = 'Your plan is waiting for your signature.'; showWrap(onboardingState.plan); }
  else if (st !== 'complete' || forceOnboarding) idleMsg = greeting + " Before anything else, let's set you up properly. Tap the orb to begin.";
  else $('redo').hidden = false;
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
    doc.save('FREYA-life-plan.pdf');
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

loadOnboarding();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
