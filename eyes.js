// F.R.E.Y.A. eyes: show her something. Live camera streamed into the voice session (~1 fps, low-res, never stored),
// or a photo / short video shared into the conversation. Shares app.js globals.
(() => {
  const btn = $('eye'), wrap = $('eyes'), cam = $('cam'), vid = $('camv'), capEl = $('cam-cap'), ringEl = $('cam-ring');
  const FPS_MS = 1000, MAX_SIDE = 640, Q = 0.6;
  let stream = null, timer = null, paused = false, facing = 'environment', camSince = null, seenBuf = [], seenT = null, lastSeenSend = 0, lastMedia = null, opening = false;
  const canvas = document.createElement('canvas');
  const isOn = () => !!stream;

  // ---------- button visibility ----------
  function showBtn() { wrap.hidden = !(authed && onboardingState && onboardingState.status === 'complete' && !document.body.classList.contains('mini')); }
  addEventListener('freya:ready', showBtn); setTimeout(showBtn, 1500);

  // ---------- menu ----------
  const pick = (accept, capture) => new Promise(res => {
    pickingAt = Date.now(); const i = document.createElement('input'); i.type = 'file'; i.accept = accept; if (capture) i.setAttribute('capture', 'environment');
    i.onchange = () => { pickingAt = 0; res(i.files && i.files[0] || null); }; i.addEventListener('cancel', () => { pickingAt = 0; res(null); }); i.click();
  });
  function menu() {
    card(`<p class="kicker">Show Freya</p><div class="eyemenu">
      <button id="em-live"><b>Live camera</b><small>Point your phone and talk. She watches with you; nothing is saved.</small></button>
      <button id="em-cap" class="ghost"><b>Photo or video</b><small>Take a photo or record a short clip for her.</small></button>
      <button id="em-gal" class="ghost"><b>Gallery</b><small>Pick a photo or video you already have.</small></button>
    </div><button id="em-x" class="link">Not now</button>`);
    $('em-x').onclick = hideCard;
    $('em-live').onclick = () => { hideCard(); openCam(); };
    $('em-gal').onclick = async () => { hideCard(); const f = await pick('image/*,video/*'); if (f) share(f); };
    $('em-cap').onclick = () => {
      $('card-body').innerHTML = `<p class="kicker">Photo or video</p><div class="row"><button id="em-ph">Take a photo</button><button id="em-vd" class="ghost">Record a clip</button></div><button id="em-x2" class="link">Back</button>`;
      $('em-x2').onclick = menu;
      $('em-ph').onclick = async () => { hideCard(); const f = await pick('image/*', true); if (f) share(f); };
      $('em-vd').onclick = async () => { hideCard(); const f = await pick('video/*', true); if (f) share(f); };
    };
  }
  btn.addEventListener('click', () => { if (!authed) return showLock(); menu(); });

  // ---------- helpers ----------
  const blobB64 = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1] || ''); fr.readAsDataURL(b); });
  const sendFrame = b64 => { if (ws && ws.readyState === 1 && b64) { ws.send(JSON.stringify({ realtimeInput: { video: { data: b64, mimeType: 'image/jpeg' } } })); return true; } return false; };
  const cue = t => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ realtimeInput: { text: t } })); setBusy(true); } };
  async function ensureSession() {
    if (active && ws && ws.readyState === 1) return true;
    if (!active) await start();
    for (let i = 0; i < 60 && (connecting || !ws || ws.readyState !== 1); i++) await new Promise(r => setTimeout(r, 250));
    return !!(active && ws && ws.readyState === 1);
  }
  function grab(max, q) {
    if (!vid.videoWidth) return null;
    const k = Math.min(1, max / Math.max(vid.videoWidth, vid.videoHeight));
    canvas.width = Math.round(vid.videoWidth * k); canvas.height = Math.round(vid.videoHeight * k);
    canvas.getContext('2d').drawImage(vid, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', q).split(',')[1];
  }
  // What she saw is described (never stored as an image) so the memory of it survives.
  function sendSeen(kind, frames, end) {
    if (!conv.sid || (!frames.length && !end)) return Promise.resolve({});
    return post('/api/memory', { action: 'seen', session: conv.sid, kind, frames, end: !!end, since: camSince, cid: 'seen-' + conv.sid + '-' + Date.now() }).catch(() => ({}));
  }

  // ---------- live camera ----------
  async function openCam() {
    if (opening || stream) return; opening = true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('nocam');
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
      catch (e) { stream = null; toast(e && e.name === 'NotAllowedError' ? 'Camera is blocked. Allow it for FREYA in your phone settings.' : 'Couldn’t open the camera.'); return; }
      vid.srcObject = stream; await vid.play().catch(() => {});
      cam.hidden = false; document.body.classList.add('cam-on'); paused = false; setPaused(false); capEl.textContent = ''; camSince = new Date().toISOString(); seenBuf = []; lastSeenSend = Date.now();
      const ok = await ensureSession();
      if (!stream) return;
      if (!ok) { closeCam('failed'); toast('Couldn’t reach her just now. Try again in a moment.'); return; }
      let first = true;
      clearInterval(timer);
      timer = setInterval(() => {
        if (!stream || paused || !ws || ws.readyState !== 1) return;
        const f = grab(MAX_SIDE, Q); if (!f) return;
        sendFrame(f);
        if (first) { first = false; cue('(Cue, not his words: Eesah just opened live camera. You can now see what his phone camera sees, about one frame a second. Say one short line that you are looking, then wait for him.)'); }
        const now = Date.now();
        if (!seenBuf.length || now - seenBuf[seenBuf.length - 1].t > 20000) { const s = grab(320, 0.5); if (s) { seenBuf.push({ t: now, f: s }); if (seenBuf.length > 3) seenBuf.shift(); } }
        if (now - lastSeenSend > 90000 && seenBuf.length) { lastSeenSend = now; sendSeen('camera', seenBuf.map(x => x.f)); seenBuf = []; }
      }, FPS_MS);
    } finally { opening = false; }
  }
  function setPaused(p) {
    paused = p; cam.classList.toggle('paused', p);
    $('cam-pause').textContent = p ? 'Resume' : 'Pause'; $('cam-pause').setAttribute('aria-label', p ? 'Let her watch again' : 'Pause her watching');
  }
  async function closeCam(why) {
    if (!stream) { cam.hidden = true; document.body.classList.remove('cam-on'); return; }
    clearInterval(timer); timer = null;
    const s = stream; stream = null; s.getTracks().forEach(t => t.stop()); vid.srcObject = null;
    cam.hidden = true; document.body.classList.remove('cam-on');
    const frames = seenBuf.map(x => x.f); seenBuf = [];
    if (why !== 'background' && why !== 'session' && ws && ws.readyState === 1) cue('(Cue, not his words: he closed the camera, so you can no longer see. Don\'t comment on it unless he speaks; carry on the conversation normally.)');
    setBusy(false);
    // Her key suggestions land in the chat history (and on screen) once she's finished.
    const r = await sendSeen('camera', frames, true);
    if (r && r.notes && r.notes.length && !document.hidden) notesCard(r.notes);
  }
  function notesCard(points) {
    card(`<p class="kicker">From live camera</p><ul class="camnotes">${points.map(p => `<li>${esc(p)}</li>`).join('')}</ul><p class="hint">Saved to your conversation. Ask her about any of it later.</p><div class="row"><button id="cn-ok">Got it</button></div>`);
    $('cn-ok').onclick = hideCard;
  }
  $('cam-end').addEventListener('click', () => closeCam('end'));
  $('cam-pause').addEventListener('click', () => setPaused(!paused));
  $('cam-flip').addEventListener('click', async () => {
    if (!stream) return; facing = facing === 'environment' ? 'user' : 'environment';
    try { const n = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); stream.getTracks().forEach(t => t.stop()); stream = n; vid.srcObject = n; vid.classList.toggle('selfie', facing === 'user'); await vid.play().catch(() => {}); }
    catch (e) { facing = facing === 'environment' ? 'user' : 'environment'; toast('Couldn’t switch camera'); }
  });
  // Her ring in the corner mirrors the orb (listening pulse, speaking glow); her words appear as captions.
  new MutationObserver(() => { ringEl.dataset.state = orb.dataset.state; }).observe(orb, { attributes: true, attributeFilter: ['data-state'] });
  new MutationObserver(() => { if (stream) { const t = herEl.textContent || ''; capEl.textContent = t.length > 160 ? '…' + t.slice(-160).replace(/^\S*\s/, '') : t; capEl.classList.toggle('on', herEl.classList.contains('on') && !!t); } }).observe(herEl, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });

  // ---------- photo / video into the conversation ----------
  async function share(file) {
    const t = file.type || '';
    if (!/^image\/|^video\//.test(t)) return toast('Photos or videos only here');
    toast(/^video/.test(t) ? 'Pulling stills from your clip…' : 'Getting it ready for her…');
    let frame, small, kind = 'photo', secs = 0;
    try {
      if (/^image\//.test(t)) { const b = await freyaSections.toJpeg(file, 1024, 0.8); frame = await blobB64(b); small = await blobB64(await freyaSections.toJpeg(file, 512, 0.6)); }
      else { const kf = await freyaSections.keyframes(file); frame = await blobB64(kf.sheet); small = kf.thumb ? await blobB64(kf.thumb) : frame; kind = 'video'; secs = kf.secs; }
    } catch (e) { return toast(/too long/.test(e && e.message) ? 'That clip is too long (max 10 minutes).' : 'Couldn’t read that file.'); }
    lastMedia = { file, at: Date.now(), kind };
    const ok = await ensureSession();
    if (!ok) return toast('Couldn’t reach her just now. Try again in a moment.');
    sendFrame(frame);
    pushTurn('user', kind === 'video' ? `(shared a ${secs}s video)` : '(shared a photo)');
    setTimeout(() => cue(kind === 'video'
      ? `(Cue, not his words: Eesah just shared a ${secs}-second video with you; the frame you just received is 6 stills from it in order, left to right, top to bottom. Look closely. In one line say what you see, then give the most useful practical suggestions for what he most likely wants. Ask what he wants if it's unclear. If it fits one of his growth sections, offer once to save it there.)`
      : '(Cue, not his words: Eesah just shared a photo with you; it is the image you just received. Look closely. In one line say what you see, then give the most useful practical suggestions for what he most likely wants. Ask what he wants if it\'s unclear. If it fits one of his growth sections, offer once to save it there.)'), 250);
    sendSeen(kind, [small]);
  }

  // ---------- tool: save_to_section ----------
  async function saveToSection(section, note) {
    if (!window.freyaSections) return 'Sections are not available.';
    const st = freyaSections.status(section);
    if (st && st !== 'ready') return `His ${section} section isn't set up yet (${st}). Tell him to open its tile under the orb first.`;
    const recent = lastMedia && Date.now() - lastMedia.at < 30 * 60e3 ? lastMedia.file : null;
    const r = await freyaSections.saveFile(section, recent, note).catch(() => null);
    if (r && r.error === 'not_ready') return `His ${section} section isn't set up yet. Tell him to open its tile under the orb first.`;
    if (!r || r.ok === false) return 'Saving failed just now; tell him briefly and offer to try again.';
    toast('Saved to ' + section);
    return recent ? 'Saved to the section. The raw file is deleted within 24 hours; the insight stays.' : 'Saved a note to the section.';
  }

  // ---------- conversation history (panel + app + camera, one thread) ----------
  const hb = $('hist'), hv = $('histv');
  const showHist = () => { hb.hidden = !(authed && onboardingState && onboardingState.status === 'complete') || !$('textbar').hidden; };
  addEventListener('freya:ready', showHist); setTimeout(showHist, 1600);
  new MutationObserver(showHist).observe($('textbar'), { attributes: true, attributeFilter: ['hidden'] });
  const dayOf = t => new Date(t).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const hm = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  async function openHist() {
    hv.hidden = false; $('hbody').innerHTML = '<p class="hint">Loading…</p>';
    await flushTurns().catch(() => {});
    const r = await post('/api/memory', { action: 'history', limit: 120 }).catch(() => ({}));
    const pend = (readLS('freyaTurnQ', [])).map(t => ({ role: t.role, text: t.text, at: t.at, cid: t.cid }));
    const all = ((r && r.turns) || []).concat(pend.filter(p => !((r && r.turns) || []).some(x => x.text === p.text && Math.abs(Date.parse(x.at) - Date.parse(p.at)) < 5000)));
    if (!all.length) { $('hbody').innerHTML = '<p class="hint">Nothing yet. Everything you and Freya say will appear here.</p>'; return; }
    let last = '', html = '';
    for (const t of all) {
      const d = dayOf(t.at); if (d !== last) { html += `<p class="hday">${esc(d)}</p>`; last = d; }
      const who = t.role === 'user' ? 'You' : t.role === 'freya' ? 'Freya' : t.role === 'seen' ? 'Freya saw' : 'Notes';
      html += `<div class="ht ${t.role}"><small>${who} · ${hm(t.at)}</small>${esc(t.text.replace(/^\[(camera|photo|video)\]\s*/, ''))}</div>`;
    }
    $('hbody').innerHTML = html; hv.scrollTop = hv.scrollHeight;
  }
  hb.addEventListener('click', openHist); $('hclose').addEventListener('click', () => { hv.hidden = true; });

  // ---------- reply to anything she asked (spoken question left hanging, nudge, notification ?ask=) ----------
  let replyShown = false, askParam = new URLSearchParams(location.search).get('ask');
  function replyCard(q, from) {
    if (!q || !q.text || !$('card').hidden || active || document.body.classList.contains('mini')) return;
    replyShown = true;
    card(`<p class="kicker">Freya asked</p><p class="rq">${esc(q.text)}</p><textarea id="rq-a" rows="2" placeholder="Type or dictate your answer…" enterkeyhint="send"></textarea><div class="row"><button id="rq-skip" class="link">Skip</button><button id="rq-talk" class="ghost">Talk instead</button><button id="rq-send">Reply</button></div><p id="rq-out" class="rqr" hidden></p>`);
    const done = () => { replyShown = false; try { localStorage.removeItem('freyaOpenQ'); } catch (x) {} };
    $('rq-skip').onclick = () => { done(); hideCard(); };
    $('rq-talk').onclick = () => { done(); hideCard(); start(); };
    $('rq-send').onclick = async () => {
      const a = $('rq-a').value.trim(); if (!a) return $('rq-a').focus();
      $('rq-send').disabled = true; $('rq-send').textContent = '…';
      const r = await post('/api/memory', { action: 'answer', session: q.sid, question: q.text, answer: a, from }).catch(() => ({}));
      done();
      $('rq-a').hidden = true; $('rq-skip').hidden = true; $('rq-talk').hidden = true;
      const out = $('rq-out'); out.hidden = false; out.textContent = r.reply || "Saved. I'll pick it up from here.";
      $('rq-send').disabled = false; $('rq-send').textContent = 'Done'; $('rq-send').onclick = hideCard;
    };
  }
  function checkReplies() {
    if (!authed || active || replyShown || !(onboardingState && onboardingState.status === 'complete') || document.body.classList.contains('mini')) return;
    if (askParam) { const ask = askParam; askParam = null; if (/[?&]ask=/.test(location.search)) history.replaceState(null, '', '/'); return replyCard({ text: ask.slice(0, 400) }, 'notification'); }
    const q = readLS('freyaOpenQ', null);
    if (q && Date.now() - q.at < 12 * 36e5) replyCard(q, 'voice');
  }
  addEventListener('freya:ready', () => setTimeout(checkReplies, 600));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(checkReplies, 900); });
  window.freyaReplies = { check: checkReplies, hide: () => { if (replyShown) { replyShown = false; hideCard(); } } };
  // Stopping mid-conversation right after she asked something: offer the reply box straight away.
  new MutationObserver(() => { if (!active) setTimeout(checkReplies, 700); }).observe(orb, { attributes: true, attributeFilter: ['data-state'] });

  window.freyaEyes = { on: isOn, close: closeCam, open: openCam, share, saveToSection };
})();
