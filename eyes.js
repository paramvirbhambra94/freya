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
  async function openCam(opts) {
    const wantSalah = !!(opts && opts.salah);
    if (stream) { if (wantSalah && !salah) startSalah(); return; }
    if (opening) return; opening = true;
    if (wantSalah) { facing = 'user'; vid.classList.add('selfie'); }
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('nocam');
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
      catch (e) { stream = null; toast(e && e.name === 'NotAllowedError' ? 'Camera is blocked. Allow it for FREYA in your phone settings.' : 'Couldn’t open the camera.'); return; }
      vid.srcObject = stream; await vid.play().catch(() => {});
      cam.hidden = false; document.body.classList.add('cam-on'); paused = false; setPaused(false); capEl.textContent = ''; camSince = new Date().toISOString(); seenBuf = []; lastSeenSend = Date.now();
      if (wantSalah) startSalah(); // silent from the very first moment, even while she connects
      const ok = await ensureSession();
      if (!stream) return;
      if (!ok) { closeCam('failed'); toast('Couldn’t reach her just now. Try again in a moment.'); return; }
      // Android can move or stall audio output when the camera starts: re-bind her voice to the current route now, while she's quiet.
      if (window.freyaAudio) { freyaAudio.kick(); freyaAudio.rebind(); }
      let first = true;
      clearInterval(timer);
      timer = setInterval(() => {
        if (!stream || paused || !ws || ws.readyState !== 1) return;
        const f = grab(MAX_SIDE, Q); if (!f) return;
        sendFrame(f);
        if (first) { first = false; if (salah) salahCue(true); else cue('(Cue, not his words: Eesah just opened live camera. You can now see what his phone camera sees, about one frame a second. Keep talking out loud with your normal voice the whole time the camera is on. Say one short line that you are looking, then wait for him.)'); }
        const now = Date.now();
        if (salah) return; // while he prays nothing about the frames is described or remembered
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
    if (salah && why !== 'salah') abortSalah(why);
    if (!stream) { cam.hidden = true; document.body.classList.remove('cam-on'); return; }
    clearInterval(timer); timer = null;
    const s = stream; stream = null; s.getTracks().forEach(t => t.stop()); vid.srcObject = null;
    cam.hidden = true; document.body.classList.remove('cam-on');
    const frames = seenBuf.map(x => x.f); seenBuf = [];
    if (window.freyaAudio) freyaAudio.kick();
    if (why !== 'background' && why !== 'session' && why !== 'salah' && ws && ws.readyState === 1) cue('(Cue, not his words: he closed the camera, so you can no longer see. Don\'t comment on it unless he speaks; carry on the conversation normally.)');
    setBusy(false);
    // Her key suggestions land in the chat history (and on screen) once she's finished.
    const r = await sendSeen('camera', frames, true);
    if (why !== 'salah' && r && r.notes && r.notes.length && !document.hidden) notesCard(r.notes);
  }
  function notesCard(points) {
    card(`<p class="kicker">From live camera</p><ul class="camnotes">${points.map(p => `<li>${esc(p)}</li>`).join('')}</ul><p class="hint">Saved to your conversation. Ask her about any of it later.</p><div class="row"><button id="cn-ok">Got it</button></div>`);
    $('cn-ok').onclick = hideCard;
  }
  $('cam-end').addEventListener('click', () => { if (salah) return complete('user-end'); closeCam('end'); });
  $('cam-fin').addEventListener('click', () => { if (salah) complete('user'); });
  $('cam-pray').addEventListener('click', () => { if (!salah) startSalah(); });
  $('cam-pause').addEventListener('click', () => setPaused(!paused));
  $('cam-flip').addEventListener('click', async () => {
    if (!stream) return; facing = facing === 'environment' ? 'user' : 'environment';
    try { const n = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); stream.getTracks().forEach(t => t.stop()); stream = n; vid.srcObject = n; vid.classList.toggle('selfie', facing === 'user'); await vid.play().catch(() => {}); }
    catch (e) { facing = facing === 'environment' ? 'user' : 'environment'; toast('Couldn’t switch camera'); }
  });
  // Her ring in the corner mirrors the orb (listening pulse, speaking glow); her words appear as captions.
  new MutationObserver(() => { ringEl.dataset.state = orb.dataset.state; }).observe(orb, { attributes: true, attributeFilter: ['data-state'] });
  new MutationObserver(() => { if (stream) { const t = herEl.textContent || ''; capEl.textContent = t.length > 160 ? '…' + t.slice(-160).replace(/^\S*\s/, '') : t; capEl.classList.toggle('on', herEl.classList.contains('on') && !!t); } }).observe(herEl, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });

  // ---------- salah mode: she watches him pray in total silence, then logs it herself (server-verified) ----------
  let salah = null;
  const sEl = $('cam-salah'), doneEl = $('cam-done');
  const setFlag = until => { try { caches.open('freya-flags').then(c => c.put('/__salah', new Response(String(until || 0)))); } catch (e) {} };
  function salahCue(first) {
    if (!(ws && ws.readyState === 1)) return;
    const due = life && life.due ? life.due.prayer : null;
    const txt = first
      ? `(Cue, not his words: SALAH MODE IS ON. Eesah is about to pray${due ? ' ' + due : ''} in front of the camera. From now until salah mode ends, be completely silent: do not speak, do not make any sound, do not reply to anything, produce no audio at all. Just watch the frames. When you have seen him complete the prayer, through the final sitting and the tasleem (turning his head right then left), call salah_complete once. Never call it before.)`
      : '(Salah check, silent, not his words: still salah mode. Produce no speech or audio. If you have now seen him finish the prayer with the tasleem, call salah_complete; otherwise do nothing and keep watching.)';
    ws.send(JSON.stringify({ realtimeInput: { text: txt } }));
  }
  function startSalah() {
    if (salah) return;
    salah = { since: Date.now(), frames: [], attempts: 0, checking: false };
    if (window.freyaAudio) freyaAudio.mute(true);
    document.body.classList.add('salah-on'); cam.classList.add('salah');
    sEl.hidden = false; doneEl.hidden = true; $('cam-fin').hidden = false; $('cam-pray').hidden = true; capEl.textContent = ''; clearCaptions();
    if (window.freyaReplies) freyaReplies.hide();
    hideCard && !$('card').hidden && hideCard();
    post('/api/state', { action: 'salah_mode', on: true, minutes: 35 }).catch(() => {});
    setFlag(Date.now() + 35 * 60e3);
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch (e) {}
    if (ws && ws.readyState === 1 && !first0()) salahCue(true);
    // Proof: a small still every 3 seconds, kept only in memory and sent once to be checked (never stored).
    salah.grab = setInterval(() => {
      if (!stream || paused) return; const f = grab(384, 0.55); if (!f) return;
      salah.frames.push(f); if (salah.frames.length > 240) salah.frames = salah.frames.filter((_, i) => i % 2 === 0);
    }, 3000);
    salah.poll = setInterval(() => salahCue(false), 30000);
    salah.max = setTimeout(() => complete('timeout'), 30 * 60e3);
  }
  const first0 = () => !timer; // camera stream not yet sending: the first-frame cue will carry the salah instruction
  function pickFrames(fr, n) { if (fr.length <= n) return fr.slice(); const out = []; for (let i = 0; i < n; i++) out.push(fr[Math.round(i * (fr.length - 1) / (n - 1))]); return out; }
  async function complete(by, positions) {
    if (!salah) return 'Salah mode is not on.';
    if (salah.checking) return 'Already checking; stay silent.';
    if (by === 'freya' && salah.lastTry && Date.now() - salah.lastTry < 45000) return 'Checked moments ago and not verified yet. Stay completely silent and keep watching.';
    if (salah.frames.length < 6) {
      if (by === 'freya') return 'Too early to be sure. Stay completely silent and keep watching; call salah_complete only after the tasleem.';
      if (by === 'user-end') { abortSalah('cancel'); closeCam('salah'); return 'cancelled'; }
      showDone('Keep going. I need to see a bit more first.', 'wait'); setTimeout(() => { if (salah && !salah.checking) doneEl.hidden = true; }, 2500); return 'not enough';
    }
    salah.checking = true; showDone('Checking…', 'wait');
    const r = await post('/api/state', { action: 'prayer_log', kind: 'camera', images: pickFrames(salah.frames, 14) }).catch(() => ({}));
    if (!salah) return 'ended';
    if (r && r.ok) { endSalah(r, true); return 'Logged and verified. Salah mode is ending now; stay silent until you get the cue, then confirm it in one short warm line.'; }
    // Her own early/false call never ends salah mode: only a verified log, his Finished/✕ or the time limit does.
    if (by === 'freya' && !(r && r.already)) { salah.attempts++; salah.lastTry = Date.now(); salah.checking = false; doneEl.hidden = true; return 'Not verified yet (' + ((r && (r.reason || r.say)) || 'unclear') + '). Stay completely silent and keep watching; call salah_complete again only after you see the tasleem.'; }
    endSalah(r || {}, false); return 'Not logged. Salah mode is ending; when you get the cue, tell him why in a few words.';
  }
  function showDone(t, kind) { doneEl.textContent = t; doneEl.className = kind || ''; doneEl.hidden = false; }
  function clearSalah() {
    if (!salah) return; clearInterval(salah.grab); clearInterval(salah.poll); clearTimeout(salah.max);
    post('/api/state', { action: 'salah_mode', on: false }).catch(() => {}); setFlag(0);
  }
  function endSalah(r, ok) {
    const name = r.prayer ? r.prayer[0].toUpperCase() + r.prayer.slice(1) : 'Prayer';
    showDone(ok ? `✓ ${name} logged · verified on camera` : 'Not logged. ' + (r.say || 'I couldn’t verify it.'), ok ? 'ok' : 'no');
    clearSalah(); loadLife();
    setTimeout(() => {
      const say = r.say || (ok ? name + ' logged.' : 'Not verified.');
      salah.frames = []; salah = null;
      document.body.classList.remove('salah-on'); cam.classList.remove('salah'); sEl.hidden = true; $('cam-fin').hidden = true; $('cam-pray').hidden = false;
      if (window.freyaAudio) freyaAudio.mute(false);
      closeCam('salah');
      if (ws && ws.readyState === 1) cue(`(Cue, not his words: salah mode has ended and the camera is closed. Result: ${say} Speak normally again now, out loud: ${ok ? 'one short warm line confirming it is logged' : 'say in a few words why it could not be verified and that he can pray in front of you again or show a masjid photo'}, then wait.)`);
    }, 2400);
  }
  function abortSalah(why) {
    if (!salah) return; clearSalah(); salah.frames = []; salah = null;
    document.body.classList.remove('salah-on'); cam.classList.remove('salah'); sEl.hidden = true; doneEl.hidden = true; $('cam-fin').hidden = true; $('cam-pray').hidden = false;
    if (window.freyaAudio) freyaAudio.mute(false);
    if (why !== 'background' && why !== 'session' && ws && ws.readyState === 1) cue('(Cue, not his words: salah mode was cancelled before he finished; nothing was logged. You may speak normally again. Say nothing unless he speaks.)');
  }
  window.freyaSalah = { on: () => !!salah, complete, start: () => openCam({ salah: true }), _frames: n => { if (salah) for (let i = 0; i < n; i++) salah.frames.push(grab(384, 0.55) || ''); } };

  // ---------- masjid photo as proof (from the salah panel or a check-in notification) ----------
  async function masjidPhoto() {
    const f = await pick('image/*', true); if (!f) return;
    toast('Freya is checking your photo…');
    let b64; try { b64 = await blobB64(await freyaSections.toJpeg(f, 1024, 0.8)); } catch (e) { return toast('Couldn’t read that photo.'); }
    lastMedia = { file: f, at: Date.now(), kind: 'photo' };
    const r = await post('/api/state', { action: 'prayer_log', kind: 'masjid', images: [b64] }).catch(() => ({}));
    loadLife();
    if (active && ws && ws.readyState === 1) { sendFrame(b64); cue(`(Cue, not his words: he just showed you a photo from the masjid as proof for his salah; it is the image you just received. Result from the check: ${r.say || 'it could not be checked'}. Tell him the result in one short warm line.)`); }
    else card(`<p class="kicker">Salah</p><p class="rq">${esc(r.say || 'I couldn’t check that just now. Try again in a moment.')}</p><div class="row"><button id="mp-ok">OK</button></div>`), $('mp-ok').onclick = hideCard;
  }
  async function recentPhoto() {
    if (!lastMedia || lastMedia.kind !== 'photo' || Date.now() - lastMedia.at > 60 * 60e3) return null;
    return blobB64(await freyaSections.toJpeg(lastMedia.file, 1024, 0.8));
  }

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
      : '(Cue, not his words: Eesah just shared a photo with you; it is the image you just received. Look closely. In one line say what you see, then give the most useful practical suggestions for what he most likely wants. Ask what he wants if it\'s unclear. If it fits one of his growth sections, offer once to save it there. If it shows him at the masjid and he wants his salah counted, call log_prayer with evidence photo.)'), 250);
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

  window.freyaEyes = { on: isOn, close: closeCam, open: openCam, share, saveToSection, masjidPhoto, recentPhoto };
})();
