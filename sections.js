// F.R.E.Y.A. growth sections: tiles under the orb + a full-screen space per section.
// Shares app.js globals ($, post, getJ, toast, esc, authed, onboardingState, APP).
(() => {
  const ICONS = {
    body: '<path d="M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11"/>',
    connections: '<path d="M4 5h10a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2H9l-3.5 3v-3H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/><path d="M18.5 9H20a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2h-1v3l-3.5-3H12"/>',
    mind: '<path d="M14.5 3.5a8.5 8.5 0 1 0 6 14.5 7 7 0 0 1-6-14.5z"/><path d="M18 5.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
    work: '<path d="M3 8h18v11H3z"/><path d="M9 8V5.5h6V8M3 13h18M11 13v2h2v-2"/>',
    vault: '<path d="M4 4h16v16H4z"/><circle cx="12" cy="12" r="3.5"/><path d="M12 8.5V7M15.5 12H17M12 15.5V17M8.5 12H7M6.5 20v1.5M17.5 20v1.5"/>'
  };
  const SHORT = { body: 'Body', connections: 'Connect', mind: 'Mind·Deen', work: 'Work', vault: 'Vault' };
  const KIND = { insight: 'Insight', question: 'Question', review: 'Weekly review', compare: 'Then vs now', prep: 'Call prep', welcome: 'Freya' };
  let list = [], cur = null, curData = null, pollT = null, tilesT = null, askHist = [];
  const icon = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;
  const tiles = $('tiles'), sect = $('sect'), body = $('sect-body');

  // ---------------- tiles ----------------
  function renderTiles() {
    tiles.innerHTML = list.map(s => `<button class="tile ${s.status}" data-k="${s.key}" aria-label="${esc(s.name)}: ${s.status === 'ready' ? 'ready' : s.status === 'building' ? 'building' : 'not set up yet'}"><span class="ti">${icon(s.key)}<i class="spin"></i></span><span class="tl">${SHORT[s.key]}</span></button>`).join('');
  }
  async function loadTiles() {
    if (!authed || !onboardingState || onboardingState.status !== 'complete' || document.body.classList.contains('mini')) { tiles.hidden = true; return; }
    const r = await getJ('/api/state?sec=all').catch(() => null);
    if (!r || !r.sections) return;
    list = r.sections; tiles.hidden = false; renderTiles();
    clearTimeout(tilesT); if (list.some(s => s.status === 'building')) tilesT = setTimeout(loadTiles, 20000);
    const want = new URLSearchParams(location.search).get('section');
    if (want && list.some(s => s.key === want) && !cur) { history.replaceState(null, '', '/'); open(want); }
  }
  tiles.addEventListener('click', e => { const b = e.target.closest('.tile'); if (b) open(b.dataset.k); });
  // Used by the camera button: save what he showed Freya into a section via the same pipeline (24h raw delete, insights kept).
  const status = k => (list.find(s => s.key === k) || {}).status;
  async function saveFile(k, file, note) {
    if (!list.length) await loadTiles();
    if (status(k) !== 'ready') return { ok: false, error: 'not_ready' };
    if (!file) return sendText(note || '', 'text', (note || 'Note').slice(0, 60), () => {}, k);
    return queue(file, k, () => {});
  }
  window.freyaSections = { refresh: loadTiles, open, saveFile, status, toJpeg: (...a) => toJpeg(...a), keyframes: f => keyframes(f) };

  // ---------------- section shell ----------------
  function ring(cls = '') {
    const o = document.getElementById('orb');
    const pick = sel => { const e = o.querySelector(sel); return e ? e.outerHTML : ''; };
    return `<div class="sring ${cls}" aria-hidden="true"><div class="sr-ring">${pick('.l-ring svg')}</div><div class="sr-ticks">${pick('.l-ticks svg')}</div><div class="sr-f">${pick('.l-f svg')}</div></div>`;
  }
  async function open(k) {
    cur = k; askHist = []; sect.hidden = false; document.body.classList.add('in-sect');
    $('sect-title').textContent = (list.find(s => s.key === k) || {}).name || '';
    body.innerHTML = `<div class="sload">${ring('work')}</div>`;
    await refresh();
  }
  function close() { cur = null; curData = null; clearTimeout(pollT); sect.hidden = true; document.body.classList.remove('in-sect'); loadTiles(); }
  $('sect-back').addEventListener('click', close);
  async function refresh() {
    const k = cur; if (!k) return;
    const d = await getJ('/api/state?sec=' + k).catch(() => null);
    if (k !== cur) return;
    if (!d || !d.status) { body.innerHTML = `<p class="hint">I couldn't open this right now. Check your connection and try again.</p>`; return; }
    curData = d; $('sect-title').textContent = d.name;
    if (d.status === 'locked' || d.status === 'onboarding') return renderQuestions(d);
    if (d.status === 'building') return renderBuilding(d);
    renderReady(d);
  }

  // ---------------- 1. questions ----------------
  const draftKey = k => 'freyaSecDraft:' + k;
  function renderQuestions(d) {
    let answers = d.answers && d.answers.length ? d.answers.map(a => ({ a: a.a || '' })) : [];
    try { const loc = JSON.parse(localStorage.getItem(draftKey(d.key)) || 'null'); if (loc && loc.length >= answers.filter(x => x.a).length) answers = loc; } catch (e) {}
    while (answers.length < d.questions.length) answers.push({ a: '' });
    let i = d.status === 'onboarding' ? Math.min(answers.findIndex(x => !x.a) < 0 ? d.questions.length - 1 : answers.findIndex(x => !x.a), d.questions.length - 1) : -1;
    const save = finish => post('/api/state', { action: 'sec_answers', section: d.key, finish, answers: answers.map(x => ({ a: x.a })) });
    const draw = () => {
      if (i < 0) {
        body.innerHTML = `<div class="sq intro">${ring('idle')}<p class="kicker">${esc(d.name)} · not set up yet</p><h2>${esc(d.intro)}</h2><p class="hint">${d.questions.length} questions, about 5 to 10 minutes. Type, or tap the mic on your keyboard to speak. Your answers save as you go.</p><button id="sq-go">Let's begin</button></div>`;
        $('sq-go').onclick = () => { i = 0; draw(); save(false); };
        return;
      }
      const last = i === d.questions.length - 1;
      body.innerHTML = `<div class="sq">
        <div class="sq-prog"><span style="width:${((i + 1) / d.questions.length * 100).toFixed(0)}%"></span></div>
        <p class="kicker">Question ${i + 1} of ${d.questions.length}</p>
        <h2 class="sq-q">${esc(d.questions[i])}</h2>
        <textarea id="sq-a" rows="6" placeholder="Your answer…">${esc(answers[i].a)}</textarea>
        <div class="row sq-nav"><button class="link" id="sq-back">${i ? 'Back' : 'Intro'}</button><button class="ghost" id="sq-skip">Skip</button><button id="sq-next">${last ? 'Build my space' : 'Next'}</button></div>
        <p id="sq-err" class="err"></p></div>`;
      const ta = $('sq-a'); setTimeout(() => ta.focus({ preventScroll: true }), 60);
      ta.oninput = () => { answers[i].a = ta.value; localStorage.setItem(draftKey(d.key), JSON.stringify(answers)); };
      $('sq-back').onclick = () => { i--; draw(); };
      $('sq-skip').onclick = () => { answers[i].a = answers[i].a || ''; if (last) finish(); else { i++; draw(); } };
      $('sq-next').onclick = () => { answers[i].a = ta.value.trim(); if (last) return finish(); if (!answers[i].a) { $('sq-err').textContent = 'Give me something here, even a line. Or tap Skip.'; return; } save(false); i++; draw(); };
    };
    async function finish() {
      const btn = $('sq-next'); btn.disabled = true; btn.textContent = 'Starting…';
      const r = await save(true).catch(() => ({ ok: false, error: 'No connection. Your answers are saved on this phone; try again.' }));
      if (!r.ok) { $('sq-err').textContent = r.error || 'Something went wrong.'; btn.disabled = false; btn.textContent = 'Build my space'; return; }
      localStorage.removeItem(draftKey(d.key));
      if (APP && r.eta) try { FreyaAndroid.notifyAt && FreyaAndroid.notifyAt(Date.parse(r.eta) + 60e3, `Your ${d.name} space is ready`, 'I built it around your answers. Tap to step in.', '/?section=' + d.key); } catch (e) {}
      refresh(); loadTiles();
    }
    draw();
  }

  // ---------------- 2. building ----------------
  function renderBuilding(d) {
    const eta = Date.parse(d.eta);
    body.innerHTML = `<div class="sbuild">${ring('work big')}<p class="kicker">Building your ${esc(d.name)} space</p><div class="cd" id="cd">5:00</div>
      <ul class="steps">${d.steps.map((s, i) => `<li class="${s.done ? 'done' : (i === d.steps.findIndex(x => !x.done) ? 'now' : '')}"><i></i>${esc(s.label)}</li>`).join('')}</ul>
      <p class="hint">I'm genuinely working on this: planning your goals, what to track and how I'll coach you. You can leave; I'll let you know the moment it's ready.</p>
      <button class="ghost" id="sb-leave">Leave it with me</button></div>`;
    $('sb-leave').onclick = close;
    const tickCd = () => { if (!$('cd')) return; const s = Math.max(0, Math.round((eta - Date.now()) / 1000)); $('cd').textContent = s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Almost there…'; };
    tickCd(); const iv = setInterval(() => { if (!$('cd')) return clearInterval(iv); tickCd(); }, 1000);
    clearTimeout(pollT); pollT = setTimeout(async () => { const k = cur; await refresh(); if (curData && curData.status === 'ready' && k) { toast(`Your ${curData.name} space is ready`); try { APP && FreyaAndroid.cancelNotify && FreyaAndroid.cancelNotify('/?section=' + k); } catch (e) {} } }, 8000);
  }

  // ---------------- 3. ready ----------------
  const fmtDay = s => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  function spark(points, dir) {
    if (points.length < 2) return '';
    const vs = points.map(p => +p.value), min = Math.min(...vs), max = Math.max(...vs), W = 120, H = 34, span = max - min || 1;
    const pts = vs.map((v, i) => `${(i / (vs.length - 1) * W).toFixed(1)},${(H - 3 - (v - min) / span * (H - 6)).toFixed(1)}`).join(' ');
    const good = dir === 'down' ? vs[vs.length - 1] <= vs[0] : dir === 'up' ? vs[vs.length - 1] >= vs[0] : true;
    return `<svg class="spark ${good ? 'good' : ''}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
  }
  function metricsHtml(d) {
    const ms = (d.config.metrics || []); if (!ms.length) return '';
    return `<section class="scard"><h3>Tracking</h3><div class="mgrid">${ms.map(m => {
      const pts = d.metrics_data.filter(x => x.key === m.key), last = pts[pts.length - 1];
      return `<div class="met"><span class="ml">${esc(m.label)}</span><span class="mv">${last ? esc(+(+last.value).toFixed(1)) : '—'}<small> ${esc(m.unit || '')}</small></span>${spark(pts.slice(-20), m.direction)}${m.source === 'manual' ? `<form class="mlog" data-k="${esc(m.key)}"><input inputmode="decimal" placeholder="Log" aria-label="Log ${esc(m.label)}"><button aria-label="Save">+</button></form>` : ''}</div>`;
    }).join('')}</div></section>`;
  }
  function feedHtml(d) {
    if (!d.insights.length) return '';
    return `<section class="scard"><h3>From Freya</h3><div class="feed">${d.insights.slice(0, 15).map(i => `<div class="ins ${i.kind}"><span class="ik">${KIND[i.kind] || 'Insight'} · ${fmtDay(i.created_at)}</span><p>${esc(i.text)}</p>${i.data && i.data.rewrites ? i.data.rewrites.map(r => `<div class="rw"><s>${esc(r.original)}</s><b>${esc(r.better)}</b><em>${esc(r.why)}</em></div>`).join('') : ''}${i.kind === 'prep' && i.data ? prepHtml(i.data) : ''}</div>`).join('')}</div></section>`;
  }
  const prepHtml = p => `<div class="prep"><b>Aim:</b> ${esc(p.objective)}<br><b>Land:</b> ${(p.key_points || []).map(esc).join(' · ')}<br><b>Ask:</b> ${(p.questions || []).map(esc).join(' · ')}<br><b>Watch:</b> ${esc(p.watch_out)}<br><b>Open with:</b> “${esc(p.opener)}”</div>`;
  function itemsHtml(d) {
    if (!d.items.length) return '';
    return `<section class="scard"><h3>Dropped in</h3><div class="items">${d.items.slice(0, 12).map(i => `<div class="it ${i.status}"><span class="itk">${esc(i.kind)}</span><span class="itt">${esc(i.title || i.name || (i.status === 'analysed' ? i.kind : 'Analysing…'))}</span><span class="itd">${i.status === 'pending' || i.status === 'uploading' ? 'analysing' : i.status === 'failed' ? 'couldn’t read' : fmtDay(i.created_at)}</span></div>`).join('')}</div><p class="hint">Raw files are deleted after 24 hours. I keep only what I learned${d.key === 'body' ? ' (plus small progress thumbnails, if on)' : ''}.</p></section>`;
  }
  function toolsHtml(d) {
    const k = d.key;
    if (k === 'body') return `<section class="scard"><h3>Then vs now</h3><div id="tvn" class="tvn"><p class="hint">Add progress photos over time and I'll compare them.</p></div></section>`;
    if (k === 'connections') return `<section class="scard"><h3>Sharpen before you send</h3><textarea id="sh-t" rows="3" placeholder="Paste the message you're about to send…"></textarea><div class="row l"><input id="sh-to" placeholder="To (e.g. potential match, client)"><button id="sh-go">Sharpen</button></div><div id="sh-out"></div></section>`;
    if (k === 'mind') return `<section class="scard"><h3>Today's reflection</h3><p class="prompt">${esc(d.prompt_today || 'How is your heart today?')}</p><div class="moods" role="group" aria-label="Mood">${[1, 2, 3, 4, 5].map(n => `<button class="mood" data-v="${n}" aria-label="Mood ${n} of 5">${['😞', '😕', '😐', '🙂', '😄'][n - 1]}</button>`).join('')}</div><textarea id="rf-t" rows="4" placeholder="Write freely. Only you and Freya see this."></textarea><button id="rf-go">Save reflection</button></section>`;
    if (k === 'work') return `<section class="scard"><h3>Upcoming call prep</h3><div id="ev"><p class="hint">Loading your calendar…</p></div><div class="row l"><input id="pr-t" placeholder="Or describe the call (who, what, why)"><button id="pr-go">Prep me</button></div><div id="pr-out"></div></section>`;
    if (k === 'vault') return `<section class="scard"><h3>Find anything</h3><form id="vs" class="row l"><input id="vs-q" placeholder="Search receipts, ideas, certificates…" enterkeyhint="search"><button>Search</button></form><div id="vs-out"></div></section>`;
    return '';
  }
  function dropHtml(d) {
    const k = d.key, camera = k === 'body' || k === 'vault' || k === 'work';
    const accept = { body: 'image/*,video/*', connections: '.txt,.zip,text/plain,application/zip,image/*', mind: 'image/*,.txt,text/plain,application/pdf', work: 'image/*,application/pdf,.txt,text/plain', vault: 'image/*,application/pdf,.txt,text/plain' }[k];
    const hint = { body: 'Progress photos, meals, gym clips (videos are reduced to keyframes on your phone).', connections: 'WhatsApp export (.txt or .zip, “Without media”), or screenshots. I focus on your side.', mind: 'Journal pages, Qur’an or dua notes, screenshots.', work: 'Documents (PDF), decks, screenshots, call notes.', vault: 'Receipts, certificates, documents, ideas.' }[k];
    return `<section class="scard drop" id="drop"><h3>Drop something in</h3><p class="hint">${hint}</p><div class="row l">${camera ? `<label class="btnl">Camera<input type="file" accept="image/*" capture="environment" hidden data-up></label>` : ''}${k === 'body' ? `<label class="btnl ghost">Record clip<input type="file" accept="video/*" capture="environment" hidden data-up></label>` : ''}<label class="btnl ghost">Choose files<input type="file" accept="${accept}" multiple hidden data-up></label><button class="ghost" id="paste-b">Paste text</button></div><div id="paste" hidden><textarea id="paste-t" rows="4" placeholder="${k === 'connections' ? 'Paste a conversation or message…' : 'Paste notes, an idea, anything…'}"></textarea><button id="paste-go">Save</button></div><div id="upq"></div></section>`;
  }
  function renderReady(d) {
    const c = d.config || {};
    body.innerHTML = `<div class="sready">
      <div class="shero">${ring('idle')}<div><p class="kicker">${esc(d.name)}</p><h2>${esc(c.headline || d.name)}</h2><p class="ssum">${esc(c.summary || '')}</p></div></div>
      ${toolsHtml(d)}${dropHtml(d)}${metricsHtml(d)}${feedHtml(d)}
      ${(c.goals || []).length ? `<section class="scard"><h3>Your goals</h3><ul class="goals">${c.goals.map(g => `<li><b>${esc(g.title)}</b>${g.target ? ` · ${esc(g.target)}` : ''}${g.by ? ` · ${esc(g.by)}` : ''}</li>`).join('')}</ul>${(c.coaching_plan || []).length ? `<h3 class="sub">The plan</h3><ul class="plan">${c.coaching_plan.map(p => `<li><span>${esc(p.phase)}</span>${esc(p.focus)}</li>`).join('')}</ul>` : ''}</section>` : ''}
      ${itemsHtml(d)}
      <section class="scard"><h3>Ask Freya about this</h3><div id="ask-log" class="asklog"></div><form id="ask" class="row l"><input id="ask-q" placeholder="e.g. How am I doing this month?" enterkeyhint="send"><button>Ask</button></form></section>
      <section class="scard danger">${d.key === 'body' ? `<label class="tog"><input type="checkbox" id="thumbs" ${d.settings && d.settings.thumbs === false ? '' : 'checked'}><span></span>Keep small progress thumbnails for then vs now</label>` : ''}<button class="link del" id="wipe">Delete everything in this section</button></section>
    </div>`;
    wireReady(d);
  }

  function wireReady(d) {
    const k = d.key;
    body.querySelectorAll('input[data-up]').forEach(inp => inp.addEventListener('change', () => { const fs = [...inp.files]; inp.value = ''; fs.forEach(f => queue(f)); }));
    const drop = $('drop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); [...e.dataTransfer.files].forEach(f => queue(f)); });
    $('paste-b').onclick = () => { $('paste').hidden = !$('paste').hidden; if (!$('paste').hidden) $('paste-t').focus(); };
    $('paste-go').onclick = async () => { const t = $('paste-t').value.trim(); if (!t) return; $('paste-t').value = ''; $('paste').hidden = true; await sendText(k === 'connections' && looksChat(t) ? await prepChat(t) : t, k === 'connections' ? 'chat' : 'note', 'Pasted text'); };
    body.querySelectorAll('.mlog').forEach(f => f.addEventListener('submit', async e => { e.preventDefault(); const v = parseFloat(f.querySelector('input').value.replace(',', '.')); if (!isFinite(v)) return; const r = await post('/api/state', { action: 'sec_metric', section: k, key: f.dataset.k, value: v }); if (r.ok) { toast('Logged'); refresh(); } }));
    $('ask').addEventListener('submit', async e => {
      e.preventDefault(); const q = $('ask-q').value.trim(); if (!q) return; $('ask-q').value = '';
      const log = $('ask-log'); log.insertAdjacentHTML('beforeend', `<p class="me">${esc(q)}</p><p class="her" id="ask-wait">…</p>`);
      const r = await post('/api/state', { action: 'sec_ask', section: k, q, history: askHist }).catch(() => ({}));
      const w = $('ask-wait'); if (w) { w.removeAttribute('id'); w.textContent = r.text || "I couldn't answer that just now. Try again in a moment."; }
      askHist.push({ who: 'me', text: q }, { who: 'her', text: r.text || '' });
    });
    $('wipe').onclick = () => {
      card(`<p class="kicker">Delete everything · ${esc(d.name)}</p><h3>Are you sure?</h3><p>This deletes every upload, thumbnail, insight and metric in ${esc(d.name)}, and resets the section to its questions. It can't be undone.</p><div class="row"><button class="ghost" data-c="close">Cancel</button><button id="wipe-yes" class="dangerb">Yes, delete everything</button></div>`);
      $('wipe-yes').onclick = async () => { const r = await post('/api/state', { action: 'sec_wipe', section: k, confirm: 'DELETE' }); hideCard(); if (r.ok) { toast(d.name + ' cleared'); refresh(); loadTiles(); } else toast('Could not delete. Try again.'); };
    };
    if ($('thumbs')) $('thumbs').onchange = async e => { const on = e.target.checked; const r = await post('/api/state', { action: 'sec_setting', section: 'body', name: 'thumbs', value: on, purge: !on }); toast(r.ok ? (on ? 'Thumbnails on' : 'Thumbnails off and deleted') : 'Could not save'); if (!on) loadTvn(); };
    if (k === 'body') loadTvn();
    if (k === 'connections') $('sh-go').onclick = async () => {
      const t = $('sh-t').value.trim(); if (!t) return; const out = $('sh-out'); out.innerHTML = '<p class="hint">Sharpening…</p>';
      const r = await post('/api/state', { action: 'sec_sharpen', section: k, text: t, to: $('sh-to').value }).catch(() => ({}));
      out.innerHTML = r.ok ? `<div class="shr"><span class="ik">Sharper</span><p>${esc(r.best)}</p><button class="link" data-copy="${esc(r.best)}">Copy</button><span class="ik">Bolder</span><p>${esc(r.alt)}</p><button class="link" data-copy="${esc(r.alt)}">Copy</button>${(r.notes || []).length ? `<ul>${r.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>` : `<p class="err">${esc(r.error || "Couldn't sharpen that just now.")}</p>`;
      out.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied')));
    };
    if (k === 'mind') {
      let mood = 0; body.querySelectorAll('.mood').forEach(b => b.onclick = async () => { body.querySelectorAll('.mood').forEach(x => x.classList.toggle('on', x === b)); mood = +b.dataset.v; const r = await post('/api/state', { action: 'sec_metric', section: 'mind', key: 'mood', value: mood }); toast(r.ok ? 'Mood noted' : 'Mood isn\'t a tracked metric here'); });
      $('rf-go').onclick = async () => { const t = $('rf-t').value.trim(); if (!t) return; $('rf-t').value = ''; await sendText(`Prompt: ${d.prompt_today || ''}\n${mood ? 'Mood ' + mood + '/5\n' : ''}${t}`, 'reflection', 'Reflection'); };
    }
    if (k === 'work') {
      getJ('/api/state?sec=events').then(r => { const ev = (r && r.events) || []; $('ev').innerHTML = ev.length ? ev.map(e => `<button class="evb ghost" data-id="${esc(e.id)}">${esc(e.summary || 'Call')} · ${new Date(e.start_at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</button>`).join('') : '<p class="hint">No calls in the next 3 days on your calendar.</p>'; $('ev').querySelectorAll('.evb').forEach(b => b.onclick = () => doPrep({ event_id: b.dataset.id })); }).catch(() => {});
      $('pr-go').onclick = () => { const t = $('pr-t').value.trim(); if (t) doPrep({ text: t }); };
    }
    if (k === 'vault') $('vs').addEventListener('submit', async e => {
      e.preventDefault(); const q = $('vs-q').value.trim(); if (!q) return; const out = $('vs-out'); out.innerHTML = '<p class="hint">Searching…</p>';
      const r = await post('/api/state', { action: 'sec_search', section: 'vault', q }).catch(() => ({}));
      const res = (r && r.results) || [];
      out.innerHTML = res.length ? res.map(x => `<div class="it"><span class="itk">${esc(x.type === 'item' ? (x.tags[0] || 'item') : 'note')}</span><span class="itt">${esc(x.title)}${x.summary ? `<small>${esc(x.summary)}</small>` : ''}${x.dates && x.dates.length ? `<small>${x.dates.map(dd => esc(dd.what + ' ' + dd.date)).join(' · ')}</small>` : ''}</span><span class="itd">${fmtDay(x.at)}</span></div>`).join('') : '<p class="hint">Nothing matched. Try another word, or ask me below.</p>';
    });
  }
  async function doPrep(p) {
    const out = $('pr-out'); out.innerHTML = '<p class="hint">Preparing your brief…</p>';
    const r = await post('/api/state', { action: 'sec_prep', section: 'work', ...p }).catch(() => ({}));
    out.innerHTML = r.ok ? prepHtml(r) : `<p class="err">${esc(r.error || "Couldn't prep that just now.")}</p>`;
  }
  async function loadTvn() {
    const box = $('tvn'); if (!box) return;
    const r = await getJ('/api/state?sec=thumbs').catch(() => null);
    const th = (r && r.thumbs) || [];
    if (th.length < 2) { box.innerHTML = `<p class="hint">${th.length ? 'One progress photo so far. Add another in a week or two and I’ll compare them.' : 'Add progress photos over time and I’ll compare them.'}</p>`; return; }
    let a = th[0], b = th[th.length - 1];
    const opts = sel => th.map(t => `<option value="${t.id}" ${t.id === sel.id ? 'selected' : ''}>${fmtDay(t.at)}</option>`).join('');
    box.innerHTML = `<div class="tv"><figure><img src="${a.url}" alt="Then" id="tv-a"><figcaption><select id="tv-sa">${opts(a)}</select></figcaption></figure><figure><img src="${b.url}" alt="Now" id="tv-b"><figcaption><select id="tv-sb">${opts(b)}</select></figcaption></figure></div><button id="tv-go">Compare these</button><p id="tv-out" class="prompt"></p>`;
    const pick = (sel, img, set) => $(sel).onchange = e => { const t = th.find(x => x.id === e.target.value); set(t); $(img).src = t.url; };
    pick('tv-sa', 'tv-a', t => a = t); pick('tv-sb', 'tv-b', t => b = t);
    $('tv-go').onclick = async () => { if (a.id === b.id) return toast('Pick two different days'); $('tv-out').textContent = 'Looking closely…'; const r = await post('/api/state', { action: 'sec_compare', section: 'body', a: a.id, b: b.id }).catch(() => ({})); $('tv-out').textContent = r.text || "Couldn't compare just now."; };
  }

  // ---------------- uploads (compressed on the phone first) ----------------
  const upq = () => $('upq');
  function row(label) { const el = document.createElement('div'); el.className = 'upr'; el.innerHTML = `<span>${esc(label)}</span><i>Preparing…</i>`; upq() && upq().prepend(el); return t => { el.querySelector('i').textContent = t; if (/ready|saved|couldn|too|not supported/i.test(t)) setTimeout(() => el.remove(), 6000); }; }
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  async function toJpeg(src, max, q) {
    let bmp; try { bmp = await createImageBitmap(src, { imageOrientation: 'from-image' }); } catch (e) { bmp = await loadImg(URL.createObjectURL(src)); }
    const w = bmp.width, h = bmp.height, k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise(r => c.toBlob(r, 'image/jpeg', q));
  }
  async function keyframes(file) {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = URL.createObjectURL(file);
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('video')); setTimeout(() => rej(new Error('video timeout')), 15000); });
    if (!isFinite(v.duration) || v.duration <= 0) throw new Error('video');
    if (v.duration > 600) throw new Error('too long');
    const N = 6, cw = 520, ch = Math.round(cw * (v.videoHeight / v.videoWidth || 1.78));
    const sheet = document.createElement('canvas'); sheet.width = cw * 3; sheet.height = ch * 2; const g = sheet.getContext('2d');
    let mid = null;
    for (let i = 0; i < N; i++) {
      v.currentTime = Math.min(v.duration - 0.05, (i + 0.5) * v.duration / N);
      await new Promise((res, rej) => { v.onseeked = res; setTimeout(res, 4000); });
      g.drawImage(v, (i % 3) * cw, Math.floor(i / 3) * ch, cw, ch);
      if (i === 2) { const m = document.createElement('canvas'); m.width = 320; m.height = Math.round(320 * ch / cw); m.getContext('2d').drawImage(v, 0, 0, m.width, m.height); mid = await new Promise(r => m.toBlob(r, 'image/jpeg', 0.72)); }
    }
    URL.revokeObjectURL(v.src);
    return { sheet: await new Promise(r => sheet.toBlob(r, 'image/jpeg', 0.8)), thumb: mid, secs: Math.round(v.duration) };
  }
  // Minimal .zip reader (WhatsApp exports): finds the chat .txt inside.
  async function unzipTxt(file) {
    const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
    let e = buf.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('zip');
    let p = dv.getUint32(e + 16, true); const n = dv.getUint16(e + 10, true); let best = null;
    for (let i = 0; i < n; i++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl));
      if (/\.txt$/i.test(name) && (!best || /chat/i.test(name))) best = { method, csize, off };
      p += 46 + nl + xl + cl;
    }
    if (!best) throw new Error('no txt');
    const lo = best.off, start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), data = buf.subarray(start, start + best.csize);
    if (best.method === 0) return new TextDecoder().decode(data);
    const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(ds).text();
  }
  const LINE = /^\u200e?\[?(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}),?\s+(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s?[apAP]\.?[mM]\.?)?)\]?\s*(?:-\s*)?([^:]{1,40}?):\s(.*)$/;
  const looksChat = t => t.split('\n').slice(0, 40).filter(l => LINE.test(l)).length >= 3;
  async function prepChat(text) {
    // Anonymise ON THE PHONE before anything is uploaded: his lines -> ME, everyone else -> THEM.
    const lines = text.replace(/\r/g, '').split('\n'), msgs = [];
    for (const l of lines) { const m = l.match(LINE); if (m) msgs.push({ d: m[1], t: m[2], who: m[3].replace(/^\u200e/, '').trim(), text: m[4] }); else if (msgs.length && l.trim()) msgs[msgs.length - 1].text += ' ' + l.trim(); }
    if (msgs.length < 3) return text.slice(-60000);
    const counts = {}; msgs.forEach(m => counts[m.who] = (counts[m.who] || 0) + 1);
    const people = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 8);
    let me = people.find(p => /eesah|paramvir|\bparam\b/i.test(p));
    if (!me) me = await pickMe(people);
    const others = people.filter(p => p !== me), alias = p => p === me ? 'ME' : others.length > 1 ? 'THEM' + (others.indexOf(p) + 1) : 'THEM';
    const names = people.flatMap(p => p.split(/\s+/)).filter(w => w.length > 2).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const nameRe = names.length ? new RegExp('\\b(' + names.join('|') + ')\\b', 'gi') : null;
    const clean = s => { s = s.replace(/\+?\d[\d \-]{8,}\d/g, '[number]').replace(/\S+@\S+\.\S+/g, '[email]').replace(/https?:\/\/\S+/g, '[link]'); return nameRe ? s.replace(nameRe, '[name]') : s; };
    return msgs.filter(m => !/^<?(media omitted|image omitted|video omitted|sticker omitted|this message was deleted|you deleted this message)>?$/i.test(m.text.trim()))
      .slice(-1500).map(m => `${m.d} ${m.t} ${alias(m.who)}: ${clean(m.text)}`).join('\n');
  }
  function pickMe(people) {
    return new Promise(res => {
      card(`<p class="kicker">Which one is you?</p><p>So I coach your side, not theirs.</p><div class="row">${people.slice(0, 6).map((p, i) => `<button class="ghost" data-me="${i}">${esc(p)}</button>`).join('')}</div>`);
      $('card-body').querySelectorAll('[data-me]').forEach(b => b.onclick = () => { hideCard(); res(people[+b.dataset.me]); });
    });
  }
  async function sendText(text, kind, label, set, k = cur) {
    set = set || row(label); set('Freya is reading…');
    const r = await post('/api/state', { action: 'sec_text', section: k, kind, text, name: label }).catch(() => ({}));
    set(r.ok ? 'Done · insight ready' : (r.error || 'Saved. I’ll finish it in the background.')); if (cur && cur === k) refresh();
    return r;
  }
  async function putFile(url, blob, type) { const r = await fetch(url, { method: 'PUT', headers: { 'content-type': type, 'x-upsert': 'true' }, body: blob }); if (!r.ok) throw new Error('upload ' + r.status); }
  async function queue(file, k = cur, set) {
    set = set || row(file.name || 'file');
    try {
      const t = file.type || '', name = file.name || 'file';
      if (/\.zip$/i.test(name) || t === 'application/zip' || t === 'application/x-zip-compressed') { set('Opening the export…'); const txt = await unzipTxt(file); return sendText(k === 'connections' ? await prepChat(txt) : txt.slice(-100000), k === 'connections' ? 'chat' : 'text', name.replace(/\.zip$/i, ''), set, k); }
      if (/^text\//.test(t) || /\.txt$/i.test(name)) { const txt = await file.text(); return sendText(k === 'connections' && looksChat(txt) ? await prepChat(txt) : txt.slice(-100000), k === 'connections' ? 'chat' : 'text', name, set, k); }
      let blob, mime, kind, thumb = null;
      if (/^image\//.test(t)) { set('Compressing…'); blob = await toJpeg(file, 1600, 0.82); mime = 'image/jpeg'; kind = 'photo'; if (k === 'body') thumb = await toJpeg(file, 320, 0.72); }
      else if (/^video\//.test(t)) { set('Pulling keyframes…'); const kf = await keyframes(file); blob = kf.sheet; mime = 'image/jpeg'; kind = 'video'; thumb = k === 'body' ? kf.thumb : null; }
      else if (t === 'application/pdf' || /\.pdf$/i.test(name)) { if (file.size > 8 * 1024 * 1024) return set('Too big (max 8 MB PDF)'); blob = file; mime = 'application/pdf'; kind = 'file'; }
      else return set('Not supported here');
      if (k !== 'body' && kind === 'photo') kind = 'file';
      set('Uploading…');
      const u = await post('/api/state', { action: 'sec_upload_url', section: k, kind, mime, bytes: blob.size, name, thumb: !!thumb });
      if (!u.ok) return set(u.error || 'Couldn’t upload');
      await putFile(u.upload, blob, mime);
      if (u.thumb_upload && thumb) await putFile(u.thumb_upload, thumb, 'image/jpeg').catch(() => {});
      set('Freya is looking…');
      const r = await post('/api/state', { action: 'sec_uploaded', section: k, id: u.id }).catch(() => ({}));
      set(r.ok ? 'Done · insight ready' : (r.error || 'Saved. I’ll finish it in the background.'));
      if (cur === k) refresh();
      return r.ok ? { ok: true, insight: r.insight || (r.analysis && r.analysis.summary) || null } : { ok: !!u.id, pending: true, error: r.error };
    } catch (e) { set(/too long/.test(e.message) ? 'Video too long (max 10 min)' : 'Couldn’t read that file'); }
  }

  // Hooks from app.js
  window.addEventListener('freya:ready', loadTiles);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadTiles(); if (cur && curData && curData.status !== 'ready') refresh(); } });
})();
