// F.R.E.Y.A. Phase 2: live voice via Gemini Live API (client-to-server with ephemeral token)
const orb = document.getElementById('orb');
const statusEl = document.getElementById('status');
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

const h = new Date().getHours();
const greeting = (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + ', Eesah.';
const setStatus = t => { statusEl.textContent = t; };
const setState = s => { orb.dataset.state = s; };
setStatus(greeting + ' Tap the orb to talk.');

let ws = null, micCtx = null, micStream = null, micNode = null;
let outCtx = null, analyser = null, nextTime = 0, sources = new Set();
let active = false, connecting = false, model = null;

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
  sources.add(src); src.onended = () => { sources.delete(src); if (!sources.size && active) { setState('listening'); setStatus('Listening…'); } };
  setState('speaking'); setStatus('Speaking…');
}
function stopPlayback() {
  sources.forEach(s => { try { s.stop(); } catch (e) {} }); sources.clear();
  nextTime = 0; if (active) { setState('listening'); setStatus('Listening…'); }
}

// Orb reacts to her output level
const lvl = new Uint8Array(256);
(function loop() {
  let v = 0;
  if (analyser && sources.size) { analyser.getByteTimeDomainData(lvl); for (const x of lvl) v = Math.max(v, Math.abs(x - 128)); v /= 128; }
  orb.style.setProperty('--lvl', Math.min(1, v * 1.6).toFixed(3));
  requestAnimationFrame(loop);
})();

async function start() {
  if (connecting) return; connecting = true;
  setState('connecting'); setStatus('Connecting…');
  try {
    if (!navigator.onLine) throw new Error("You're offline. Check your connection and try again.");
    outCtx = new AudioContext({ sampleRate: 24000 });
    micCtx = new AudioContext({ sampleRate: 16000 });
    outCtx.resume(); micCtx.resume();
    analyser = outCtx.createAnalyser(); analyser.fftSize = 256; analyser.connect(outCtx.destination);
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) { throw new Error('Microphone blocked. Allow mic access for FREYA in your phone settings.'); }
    const r = await fetch('/api/token', { method: 'POST', cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) throw new Error(j.error || "Couldn't reach her brain. Try again in a moment.");
    model = j.model;
    await micCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
    const srcNode = micCtx.createMediaStreamSource(micStream);
    micNode = new AudioWorkletNode(micCtx, 'pcm16');
    srcNode.connect(micNode);
    await new Promise((resolve, reject) => {
      ws = new WebSocket(WS_URL + '?access_token=' + encodeURIComponent(j.token));
      const to = setTimeout(() => reject(new Error('Connection timed out. Tap to try again.')), 12000);
      ws.onopen = () => ws.send(JSON.stringify({ setup: { model } }));
      ws.onerror = () => { clearTimeout(to); reject(new Error("Couldn't connect to her voice. Tap to try again.")); };
      ws.onclose = e => { clearTimeout(to); reject(new Error(e.reason ? 'Disconnected: ' + e.reason : "Couldn't connect. Tap to try again.")); };
      ws.onmessage = async ev => {
        const m = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text());
        if (m.setupComplete) { clearTimeout(to); resolve(); }
      };
    });
    ws.onmessage = async ev => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text());
      const sc = m.serverContent;
      if (sc) {
        if (sc.interrupted) stopPlayback();
        for (const p of (sc.modelTurn && sc.modelTurn.parts) || []) if (p.inlineData && p.inlineData.data) playPcm(p.inlineData.data);
      }
      if (m.goAway) setStatus('Session ending soon. Tap to restart if she drops.');
    };
    ws.onclose = e => { if (active) stop(e.code === 1000 ? 'Session ended. Tap the orb to talk again.' : 'Connection dropped' + (e.reason ? ': ' + e.reason : '') + '. Tap to reconnect.'); };
    ws.onerror = null;
    micNode.port.onmessage = e => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64FromBuf(e.data), mimeType: 'audio/pcm;rate=16000' } } }));
    };
    active = true; connecting = false;
    setState('listening'); setStatus('Listening…');
  } catch (e) {
    connecting = false; stop(e.message || 'Something went wrong. Tap to try again.');
  }
}

function stop(msg) {
  active = false;
  try { ws && ws.close(1000); } catch (e) {} ws = null;
  try { micNode && micNode.disconnect(); } catch (e) {} micNode = null;
  micStream && micStream.getTracks().forEach(t => t.stop()); micStream = null;
  sources.forEach(s => { try { s.stop(); } catch (e) {} }); sources.clear(); nextTime = 0;
  micCtx && micCtx.close().catch(() => {}); micCtx = null;
  outCtx && outCtx.close().catch(() => {}); outCtx = null; analyser = null;
  setState('idle'); setStatus(msg || 'Standing by. Tap the orb to talk.');
}

orb.addEventListener('click', () => { active ? stop() : start(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && active) stop('Paused while FREYA was in the background. Tap to talk.'); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
