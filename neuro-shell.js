// NEURO shell: pages, life spaces, futures, approvals, modes, learning, guest chat, Sleep Focus and screen awareness.
// Builds on app.js (voice session, orb, history), sections.js (growth spaces) and eyes.js (camera). Event IDs are preserved.
(() => {
  const $ = id => document.getElementById(id);
  const body = document.body;
  if (body.classList.contains('mini') || new URLSearchParams(location.search).has('mini')) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const say = m => { try { window.toast ? window.toast(m) : console.log(m); } catch (e) {} };
  async function api(q) {
    const r = await fetch('/api/state?' + q, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw Object.assign(new Error('Unlock NEURO to see this.'), { locked: true });
    if (r.status === 503) throw new Error('Memory is not connected on this deployment.');
    if (!r.ok) throw new Error(j.error || 'Unavailable right now.');
    return j;
  }
  async function act(action, b = {}) {
    const r = await fetch('/api/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...b }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw Object.assign(new Error('Unlock NEURO first.'), { locked: true });
    if (!r.ok) throw new Error(j.error || 'That did not work.');
    return j;
  }
  const fail = (el, e) => { el.innerHTML = `<p class="nx-empty">${esc(e.message || e)}</p>`; };
  const lvl = v => `<i class="nx-chip ${esc(v)}">${esc(v)}</i>`;
  const ukTime = t => new Date(t).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  let prefs = { islamicMode: true, learning: {}, mode: { mode: 'available' } };
  let page = 'home';

  // ---------------- header ----------------
  const now = new Date(), hr = now.getHours();
  $('n-date').textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const U = () => window.freyaUser || null, isOwner = () => !U() || U().owner !== false;
  const greet = () => { $('n-greeting').textContent = (hr < 5 ? 'Still up' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening') + ', ' + ((U() && U().first) || 'Eesah') + '.'; };
  greet();
  window.addEventListener('freya:user', () => { greet(); if (page === 'settings' || page === 'life') setPage(page); });
  const sub = document.querySelector('#n-home .n-muted'); if (sub) sub.textContent = 'Your day, decisions and progress in one place.';
  // One app bar: brand left; salah status, volume and settings right. Existing controls are moved in (their handlers stay).
  const actions = $('nx-actions');
  ['vol', 'sbtn'].forEach(id => { const e = $(id); if (e && actions) actions.insertBefore(e, actions.firstChild); });
  const brand = document.querySelector('.nx-brand'); if (brand) brand.addEventListener('click', e => { e.preventDefault(); setPage('home'); });
  // App prompts (reminders, Google) sit in the Home flow instead of floating over content.
  ['notify', 'gchip'].forEach(id => { const e = $(id); if (e && $('nx-prompts')) $('nx-prompts').appendChild(e); });
  const APPX = window.FreyaAndroid && typeof FreyaAndroid.sleepStart === 'function';
  const native = (fn, ...a) => { try { return window.FreyaAndroid && typeof FreyaAndroid[fn] === 'function' ? FreyaAndroid[fn](...a) : null; } catch (e) { return null; } };

  // ---------------- navigation ----------------
  const root = $('nx-root');
  function go(p) {
    const spaces = { physical: 'physical', finance: 'finance', mind: 'mind', islamic: 'mind', connect: 'connect', work: 'work' };
    if (spaces[p]) { setPage('life'); return openSpace(spaces[p]); }
    if (p === 'learned') { setPage('vault'); setTimeout(() => { const e = $('nx-learned'); e && e.scrollIntoView({ block: 'start' }); }, 300); return; }
    if (p === 'futures') { setPage('home'); setTimeout(() => { const e = $('nx-fq'); e && e.focus(); }, 200); return; }
    if (p === 'approvals') { setPage('home'); return; }
    setPage(p);
  }
  function setPage(p) {
    if (!['home', 'chat', 'life', 'vault', 'settings'].includes(p)) p = 'home';
    page = p; body.dataset.neuroPage = p; closeSheet(true);
    document.querySelectorAll('#n-nav button').forEach(b => b.dataset.page === p ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
    $('textbar').hidden = p !== 'chat';
    const m = document.querySelector('main'); if (m) m.scrollTop = 0;
    render();
    screenChanged();
  }
  document.querySelectorAll('#n-nav button').forEach(b => b.addEventListener('click', () => setPage(b.dataset.page)));
  $('n-settings').addEventListener('click', () => setPage('settings'));
  $('nx-voice').addEventListener('click', () => $('orb').click());
  $('nx-text').addEventListener('click', () => { setPage('chat'); setTimeout(() => $('textin').focus(), 50); });

  function render() {
    if (page === 'home') return renderHome();
    if (page === 'chat') return renderChat();
    if (page === 'life') return renderLife();
    if (page === 'vault') return renderVault();
    if (page === 'settings') return renderSettings();
  }
  const card = (id, title, extra = '') => `<section class="nx-card" id="${id}"><div class="nx-card-h"><h2>${title}</h2>${extra}</div><div class="nx-card-b"><p class="nx-load">Loading…</p></div></section>`;
  const cb = id => document.querySelector('#' + id + ' .nx-card-b');

  // ---------------- modes ----------------
  const MODES = [
    ['available', 'Available', 'Normal. Freya can reach you.'],
    ['focus', 'Focus', 'Short replies, notifications held (except critical).'],
    ['private', 'Private', 'Freya stands down; no insights on screen.'],
    ['salah', 'Salah', 'Pray with Freya: silent camera, she only watches.'],
    ['standby', 'Standby', 'Quiet and dim; notifications held.'],
    ['sleep', 'Sleep', 'Wind down; notifications held until morning.'],
    ['emergency', 'Emergency', 'Your emergency contacts and support, fast.']
  ];
  function renderModeBar() {
    const m = prefs.mode || { mode: 'available' }, cur = MODES.find(x => x[0] === m.mode) || MODES[0];
    body.dataset.mode = m.mode; native('setNeuroMode', m.mode);
    $('nx-modebar').innerHTML = `<button id="nx-mode" class="nx-mode ${esc(m.mode)}" aria-haspopup="dialog"><i></i>${esc(cur[1])}${m.until ? ' · until ' + new Date(m.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}</button>`;
    $('nx-mode').onclick = modeSheet;
  }
  function modeSheet() {
    openSheet('Mode', `<div class="nx-modes">${MODES.filter(x => x[0] !== 'salah' || prefs.islamicMode).map(x => `<button data-m="${x[0]}" class="${prefs.mode.mode === x[0] ? 'on' : ''}"><strong>${x[1]}</strong><small>${x[2]}</small></button>`).join('')}</div>`, el => {
      el.querySelectorAll('[data-m]').forEach(b => b.onclick = async () => {
        const m = b.dataset.m;
        if (m === 'salah') { closeSheet(); if (window.freyaEyes) freyaEyes.open({ salah: true }); return; }
        try { const r = await act('neuro_mode', { mode: m }); prefs.mode = { mode: r.mode, until: r.until }; renderModeBar(); closeSheet(); say('Mode · ' + b.querySelector('strong').textContent); if (m === 'emergency') emergencySheet(r.contacts); if (window.freyaContext) freyaContext('He switched NEURO to ' + m + ' mode.'); } catch (e) { say(e.message); }
      });
    });
  }
  function emergencySheet(contacts) {
    const list = (contacts || []).map(c => `<a class="nx-big" href="tel:${esc(String(c.phone || '').replace(/[^\d+]/g, ''))}">Call ${esc(c.name)}<small>${esc(c.relation || '')} · ${esc(c.phone || '')}</small></a>`).join('');
    openSheet('Emergency', `<p class="nx-lead">You're not alone. Pick one.</p><a class="nx-big danger" href="tel:999">Call 999<small>Emergency services (UK)</small></a>${list || '<p class="nx-empty">No emergency contacts saved yet (set them in your plan).</p>'}<a class="nx-big" href="tel:111">NHS 111<small>Urgent medical advice</small></a><a class="nx-big" href="tel:116123">Samaritans 116 123<small>Free, 24/7, to talk</small></a>${prefs.islamicMode ? '<button class="nx-big" id="nx-em-deen">Emergency deen<small>Words of comfort and Freya by your side</small></button>' : ''}<button class="nx-big" id="nx-em-talk">Talk to Freya now</button><button class="link" id="nx-em-off">I'm OK · leave emergency mode</button>`, el => {
      const d = el.querySelector('#nx-em-deen'); if (d) d.onclick = deenSheet;
      el.querySelector('#nx-em-talk').onclick = () => { closeSheet(); window.freyaCue && freyaCue('He opened emergency mode and wants to talk. Be calm, warm and practical. Ask what is happening in one short line.'); };
      el.querySelector('#nx-em-off').onclick = async () => { try { const r = await act('neuro_mode', { mode: 'available' }); prefs.mode = { mode: r.mode, until: null }; renderModeBar(); closeSheet(); } catch (e) { say(e.message); } };
    });
  }

  // ---------------- home ----------------
  function renderHome() {
    root.innerHTML = card('nx-approvals', 'Waiting for you') + card('nx-brief', 'Your day', '<span class="nx-live"><i></i>Live</span>') +
      `<section class="nx-card nx-fut" id="nx-futures"><div class="nx-card-h"><h2>Futures</h2><span class="nx-tag">Risk · Reward</span></div><form id="nx-ff"><label for="nx-fq" class="nx-lead">What decision are you weighing?</label><textarea id="nx-fq" rows="3" maxlength="600" placeholder="e.g. Save £1,200 by summer, or clear my card first?"></textarea><button type="submit">See the futures</button></form><div id="nx-fout"></div></section>` +
      card('nx-prio', 'Priorities today');
    $('nx-approvals').hidden = true;
    loadApprovals(); loadBrief(); loadPriorities(); loadLastFuture();
    $('nx-ff').onsubmit = e => { e.preventDefault(); runFutures($('nx-fq').value); };
  }
  async function loadBrief() {
    const el = cb('nx-brief'); if (!el) return;
    try {
      const d = await api('neuro=briefing');
      if (d.private) { el.innerHTML = '<p class="nx-empty">Private mode · your briefing is hidden.</p>'; return; }
      const icon = { deen: '☾', work: '▤', finance: '£', physical: '＋', mind: '◈', assistant: '✓' };
      el.innerHTML = (d.items.length ? `<ul class="nx-brief">${d.items.map(i => `<li class="${esc(i.level)}"><b>${icon[i.domain] || '•'}</b><div>${esc(i.text)}<small>${esc(i.evidence)}</small></div></li>`).join('')}</ul>` : '<p class="nx-empty">Nothing to brief yet. Connect your calendar, bank or phone awareness and Freya will join the dots.</p>') +
        (d.links && d.links.length ? `<div class="nx-links"><p class="nx-k">Connected</p>${d.links.map(l => `<p>${esc(l.text)}<small>${esc(l.evidence)}</small></p>`).join('')}</div>` : '') +
        `<button class="link" id="nx-brief-talk">Walk me through it</button>`;
      $('nx-brief-talk').onclick = () => window.freyaCue && freyaCue('He asked you to walk him through his day from the briefing on screen: prayers (if relevant), commitments, money, anything at risk, and the one thing that matters most. Keep it short.');
    } catch (e) { fail(el, e); }
  }
  async function loadApprovals() {
    const sec = $('nx-approvals'); if (!sec) return;
    try {
      const d = await api('neuro=actions&status=pending');
      const live = d.actions.filter(a => new Date(a.expires_at) > new Date());
      sec.hidden = !live.length; if (!live.length) return;
      cb('nx-approvals').innerHTML = live.map(a => `<button class="nx-row" data-id="${esc(a.id)}"><strong>${esc(a.label)}</strong><small>${esc(a.params.to || a.params.to_name || a.params.phone || '')} · expires ${new Date(a.expires_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</small></button>`).join('');
      cb('nx-approvals').querySelectorAll('[data-id]').forEach(b => b.onclick = () => { const a = live.find(x => x.id === b.dataset.id); approvalCard({ id: a.id, hash: a.params_hash, kind: a.kind, label: a.label, params: a.params, risk: a.risk, expires_at: a.expires_at }); });
    } catch (e) { sec.hidden = true; }
  }
  async function loadPriorities() {
    const el = cb('nx-prio'); if (!el) return;
    try {
      const d = await api('neuro=daily');
      el.innerHTML = `<div class="nx-goals">${d.goals.map(g => `<div class="nx-goal ${g.done ? 'done' : ''}"><button data-t="${g.id}" aria-label="${g.done ? 'Reopen' : 'Mark done'}">${g.done ? '✓' : '○'}</button><span>${esc(g.title)}</span><button class="x" data-x="${g.id}" aria-label="Remove">✕</button></div>`).join('') || '<p class="nx-empty">No priorities yet. Add up to five.</p>'}</div>` +
        (d.insights.length ? `<div class="nx-links">${d.insights.map(i => `<p>${esc(i.text)}<small>${esc(i.evidence)}</small></p>`).join('')}</div>` : '') +
        `<form id="nx-pf" class="nx-inline"><input maxlength="180" placeholder="Add a priority" aria-label="Add a priority" required><button>Add</button></form>`;
      el.querySelectorAll('[data-t]').forEach(b => b.onclick = async () => { const g = d.goals.find(x => String(x.id) === b.dataset.t); try { await act('neuro_goal', { id: g.id, done: !g.done }); loadPriorities(); } catch (e) { say(e.message); } });
      el.querySelectorAll('[data-x]').forEach(b => b.onclick = async () => { try { await act('neuro_goal', { id: +b.dataset.x, remove: true }); loadPriorities(); } catch (e) { say(e.message); } });
      $('nx-pf').onsubmit = async e => { e.preventDefault(); const i = e.target.querySelector('input'); try { await act('neuro_goal', { title: i.value }); loadPriorities(); } catch (x) { say(x.message); } };
    } catch (e) { fail(el, e); }
  }

  // ---------------- futures ----------------
  async function runFutures(q) {
    q = String(q || '').trim(); const out = $('nx-fout'); if (!out) return;
    if (q.length < 6) { out.innerHTML = '<p class="nx-empty">Tell me the decision in a sentence.</p>'; return; }
    const btn = document.querySelector('#nx-ff button'); btn.disabled = true;
    out.innerHTML = '<div class="nx-thinking"><i></i><p>Looking across possible futures from your own data…</p></div>'; body.classList.add('tooling');
    try { showFutures(await act('neuro_futures', { question: q })); }
    catch (e) { fail(out, e); }
    finally { btn.disabled = false; body.classList.remove('tooling'); }
  }
  async function loadLastFuture() {
    try { const d = await api('neuro=futures'); if (d.runs && d.runs[0] && $('nx-fout') && !$('nx-fout').innerHTML) showFutures({ ...d.runs[0].result, id: d.runs[0].id, chosen: d.runs[0].chosen, old: d.runs[0].created_at }, true); } catch (e) {}
  }
  function showFutures(r, quiet) {
    if (!quiet && page !== 'home') setPage('home');
    const out = $('nx-fout'); if (!out) return;
    if (!quiet && $('nx-fq')) $('nx-fq').value = r.question || '';
    const L = { low: 0, medium: 1, high: 2 }, routes = r.routes || [];
    const cells = [...Array(9)].map((_, i) => { const rw = 2 - Math.floor(i / 3), rk = i % 3; const here = routes.map((x, n) => [x, n]).filter(([x]) => L[x.reward] === rw && L[x.risk] === rk); return `<div class="c${rw === 2 && rk === 0 ? ' best' : ''}${rw === 0 && rk === 2 ? ' worst' : ''}">${here.map(([x, n]) => `<b class="${x.name === r.recommended ? 'rec' : ''}" title="${esc(x.name)}">${n + 1}</b>`).join('')}</div>`; }).join('');
    out.innerHTML = `${r.old ? `<p class="nx-k">Last run · ${ukTime(r.old)}</p>` : ''}<p class="nx-fsum"><strong>${routes.length} routes</strong>${r.simulated_futures ? ` · <strong>${Number(r.simulated_futures).toLocaleString('en-GB')}</strong> simulated money futures` : ''}</p>
      <div class="nx-matrix" aria-label="Risk and reward of each route"><span class="ax y">reward ↑</span><div class="g">${cells}</div><span class="ax x">risk →</span></div>
      <div class="nx-routes">${routes.map((x, n) => `<article class="nx-route${x.name === r.recommended ? ' rec' : ''}"><h3><b>${n + 1}</b>${esc(x.name)}${x.name === r.recommended ? '<em>Freya\'s pick</em>' : ''}</h3><p>${esc(x.summary)}</p><p class="nx-chips">risk ${lvl(x.risk)} reward ${lvl(x.reward)} likelihood ${lvl(x.likelihood)}</p>
        ${x.simulation ? `<p class="nx-sim">${x.simulation.runs.toLocaleString('en-GB')} simulated futures over ${x.simulation.months} months: ${Math.round(x.simulation.p_never_below_zero || 0)}% never go below £0${x.simulation.expected_savings != null ? `, expected saved ~£${Math.round(x.simulation.expected_savings).toLocaleString('en-GB')}` : ''}${x.simulation.end_p10 != null ? `, end balance £${Math.round(x.simulation.end_p10).toLocaleString('en-GB')}–£${Math.round(x.simulation.end_p90).toLocaleString('en-GB')}` : ''}.</p>` : ''}
        <details><summary>Evidence & assumptions</summary><p><b>Upside:</b> ${esc(x.upside)}</p><p><b>Downside:</b> ${esc(x.downside)}</p>${(x.evidence || []).length ? `<p class="nx-k">From your data</p><ul>${x.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : '<p class="nx-k">No direct evidence in your data</p>'}<p class="nx-k">Assumptions</p><ul>${(x.assumptions || []).map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>
        <p class="nx-first">First step: ${esc(x.first_step)}</p>${r.id ? `<button class="ghost sm" data-choose="${esc(x.name)}">${r.chosen === x.name ? '✓ Chosen' : 'Choose this route'}</button>` : ''}</article>`).join('')}</div>
      ${r.why ? `<p class="nx-why"><b>Why:</b> ${esc(r.why)}</p>` : ''}${(r.unknowns || []).length ? `<p class="nx-k">Unknowns</p><ul class="nx-unk">${r.unknowns.map(u => `<li>${esc(u)}</li>`).join('')}</ul>` : ''}${r.would_change ? `<p class="nx-small">Would change my mind: ${esc(r.would_change)}</p>` : ''}<p class="nx-small">${esc(r.disclaimer || '')}</p>`;
    out.querySelectorAll('[data-choose]').forEach(b => b.onclick = async () => { try { await act('neuro_futures_choose', { id: r.id, chosen: b.dataset.choose }); r.chosen = b.dataset.choose; showFutures(r, true); say('Route chosen · Freya will hold you to it'); window.freyaContext && freyaContext('He chose the route "' + b.dataset.choose + '" for: ' + r.question); } catch (e) { say(e.message); } });
    screenChanged();
  }

  // ---------------- approvals ----------------
  function approvalCard(a) {
    const p = a.params || {};
    const what = a.kind === 'email_send' ? `<dl class="nx-dl"><dt>To</dt><dd>${esc(p.to)}</dd><dt>Subject</dt><dd>${esc(p.subject)}</dd><dt>Message</dt><dd class="pre">${esc(p.body)}</dd></dl>` : `<dl class="nx-dl"><dt>To</dt><dd>${esc(p.to_name || p.phone || 'you choose in ' + (p.channel === 'sms' ? 'Messages' : 'WhatsApp'))}</dd><dt>Via</dt><dd>${p.channel === 'sms' ? 'SMS' : 'WhatsApp'} (you press send)</dd><dt>Message</dt><dd class="pre">${esc(p.text)}</dd></dl>`;
    openSheet('Approve?', `<p class="nx-lead">${esc(a.label)}</p>${what}<p class="nx-small">Risk ${esc(a.risk)} · this exact ${a.kind === 'email_send' ? 'email' : 'message'} only · expires ${new Date(a.expires_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</p><div class="nx-row2"><button class="ghost" id="nx-ap-no">Cancel</button><button id="nx-ap-yes">${a.kind === 'email_send' ? 'Approve & send' : 'Approve & open ' + (p.channel === 'sms' ? 'Messages' : 'WhatsApp')}</button></div><p class="err" id="nx-ap-err"></p>`, el => {
      el.querySelector('#nx-ap-no').onclick = async () => { try { await act('action_deny', { id: a.id }); } catch (e) {} closeSheet(); window.freyaContext && freyaContext('He cancelled the ' + a.label.toLowerCase() + '. Nothing was sent.'); loadApprovals(); };
      el.querySelector('#nx-ap-yes').onclick = async ev => {
        ev.target.disabled = true;
        try {
          const r = await act('action_approve', { id: a.id, hash: a.hash });
          if (!r.ok) throw new Error(r.error || 'Not approved');
          closeSheet(); loadApprovals();
          if (r.result && r.result.handoff) { window.freyaContext && freyaContext('He approved the message; WhatsApp/SMS is opening with the text for him to press send.'); location.href = r.result.url; }
          else { say('Sent · ' + (p.subject || 'email')); window.freyaContext && freyaContext('He approved it and the email to ' + p.to + ' was sent (executed).'); }
        } catch (e) { el.querySelector('#nx-ap-err').textContent = e.message; ev.target.disabled = false; }
      };
    });
  }

  // ---------------- chat ----------------
  function renderChat() {
    root.innerHTML = `<section class="nx-quick" aria-label="Quick actions"><button id="nx-hist"><b aria-hidden="true">◷</b><span>History</span></button><button id="nx-cam"><b aria-hidden="true">◎</b><span>Camera</span></button><button id="nx-chk"><b aria-hidden="true">✓</b><span>Check in</span></button><button id="nx-fut"><b aria-hidden="true">✦</b><span>Futures</span></button></section>`;
    $('nx-chk').onclick = () => window.freyaCheckin && freyaCheckin();
    $('nx-fut').onclick = () => go('futures');
    $('nx-hist').onclick = () => { if (!$('hist').hidden) $('hist').click(); else say('History appears once you are unlocked.'); };
    $('nx-cam').onclick = () => { if (window.freyaEyes && $('eye')) $('eye').click(); };
  }

  // ---------------- life spaces ----------------
  const SPACES = () => [
    ['physical', '＋', 'Physical', 'Trainer · nutrition · recovery'],
    ...(isOwner() ? [['finance', '£', 'Finance', 'Saver · accountant · decisions']] : []),
    ['mind', prefs.islamicMode ? '☾' : '◈', prefs.islamicMode ? 'Mind & Deen' : 'Mind', prefs.islamicMode ? 'Salah · wisdom · wellbeing' : 'Wellbeing · sleep · habits'],
    ['connect', '◎', 'Connect', 'Communication coach'],
    ['work', '▤', 'Work', 'Today · decisions · focus'],
    ['vault', '◇', 'Vault', 'Improvement or downfall?']
  ];
  function renderLife() {
    root.innerHTML = `<section class="nx-spaces">${SPACES().map(s => `<button data-space="${s[0]}"><i>${s[1]}</i><strong>${esc(s[2])}</strong><small>${esc(s[3])}</small></button>`).join('')}</section>`;
    root.querySelectorAll('[data-space]').forEach(b => b.onclick = () => b.dataset.space === 'vault' ? setPage('vault') : openSpace(b.dataset.space));
  }
  const openSec = k => { closeSheet(); if (window.freyaSections) freyaSections.open(k); };
  function openSpace(k) {
    const s = SPACES().find(x => x[0] === k); if (!s) return;
    openSheet(s[2], '<p class="nx-load">Loading…</p>', el => ({ physical: spacePhysical, finance: spaceFinance, mind: spaceMind, connect: spaceConnect, work: spaceWork })[k](el));
    sheetKey = k;
  }
  let sheetKey = null;
  function refresh(k) { if (sheetKey === k && !$('nx-sheet').hidden) openSpace(k); }

  async function spacePhysical(el) {
    try {
      const d = await api('neuro=trainer'), p = d.plan, today = new Date().toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 3);
      el.innerHTML = `<p class="nx-lead">Your all-in-one trainer.</p>` + (p ? `<p class="nx-k">${esc(p.goal)}</p><p class="nx-small">${esc(p.level)}</p><div class="nx-week">${(p.week || []).map(w => `<details ${String(w.day).slice(0, 3) === today ? 'open class="today"' : ''}><summary><b>${esc(w.day)}</b> ${esc(w.focus)}${w.minutes ? ` · ${w.minutes} min` : ''}</summary><ul>${(w.exercises || []).map(x => `<li><strong>${esc(x.name)}</strong> ${esc(x.sets)}×${esc(x.reps)}<small>${esc(x.notes)}</small></li>`).join('') || '<li>Rest and recover.</li>'}</ul></details>`).join('')}</div>
        <div class="nx-row2"><button id="nx-wo-done">Session done</button><button class="ghost" id="nx-wo-skip">Skipped</button></div>
        <p class="nx-k">Nutrition</p><ul>${(p.nutrition || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul><p class="nx-k">Recovery</p><ul>${(p.recovery || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul><p class="nx-small">Next week: ${esc(p.progression)} · ${esc(p.caution)}</p>` : '<p class="nx-empty">No plan yet. Freya builds one from your Body space, metrics and steps.</p>') +
        (d.log.length ? `<p class="nx-k">Recent sessions</p><ul class="nx-log">${d.log.slice(0, 7).map(l => `<li>${esc(l.day)} · ${esc(l.focus)} · ${l.done ? 'done' : 'skipped'}</li>`).join('')}</ul>` : '') +
        `<form id="nx-tp" class="nx-inline"><input maxlength="300" placeholder="Changes (optional)" aria-label="Changes to your plan (optional)"><button>${p ? 'New plan' : 'Build my plan'}</button></form><button class="link" id="nx-body">Open Body space</button>`;
      const todays = p && (p.week || []).find(w => String(w.day).slice(0, 3) === today);
      const log = async done => { try { await act('neuro_trainer_log', { focus: todays ? todays.focus : 'Workout', done }); say(done ? 'Logged · nice work' : 'Logged as skipped'); spacePhysical(el); } catch (e) { say(e.message); } };
      if ($('nx-wo-done')) { $('nx-wo-done').onclick = () => log(true); $('nx-wo-skip').onclick = () => log(false); }
      $('nx-tp').onsubmit = async e => { e.preventDefault(); const b = e.target.querySelector('button'); b.disabled = true; b.textContent = 'Building…'; body.classList.add('tooling'); try { await act('neuro_trainer_plan', { request: e.target.querySelector('input').value }); spacePhysical(el); } catch (x) { say(x.message); b.disabled = false; b.textContent = 'Try again'; } finally { body.classList.remove('tooling'); } };
      $('nx-body').onclick = () => openSec('body');
    } catch (e) { fail(el, e); }
    screenChanged();
  }
  async function spaceFinance(el) {
    try {
      const d = await api('neuro=finance'), g = n => '£' + Math.round(n).toLocaleString('en-GB');
      if (!d.connected) { el.innerHTML = '<p class="nx-empty">Your bank is not connected on this deployment. Finance stays read-only either way.</p>' + jib(); return; }
      const pace = d.this_month && d.this_month.usual_spend_to_date ? d.this_month.spent - d.this_month.usual_spend_to_date : null;
      el.innerHTML = `<div class="nx-stats"><div><small>Balance</small><strong>${g(d.balance)}</strong></div><div><small>Spent this month</small><strong>${g(d.this_month.spent)}</strong></div><div><small>Usual net / month</small><strong>${g(d.usual.monthly_net)}</strong></div></div>${pace != null ? `<p class="nx-small">${pace > 0 ? g(pace) + ' ahead of' : g(-pace) + ' under'} your usual pace${d.as_of ? ' · updated ' + ukTime(d.as_of) : ''}</p>` : ''}${d.feed_stale || d.feed_error ? `<p class="nx-small nx-warn">Bank feed: latest transaction ${d.latest_tx ? fmtDay(d.latest_tx) : 'unknown'}${d.feed_error ? ' · ' + esc(d.feed_error.replace(/(\d{4}-\d{2}-\d{2})/, m => fmtDay(m))) : ''}. Spending figures may be incomplete.</p>` : ''}
        ${d.savers && d.savers.levers && d.savers.levers.length ? `<p class="nx-k">Money saver</p><ul class="nx-brief">${d.savers.levers.map(l => `<li class="good"><b>£</b><div>${esc(l.action)}: ~${g(l.monthly_saving)}/month (${g(l.over_period)} over ${d.savers.months} months)<small>from your usual ${g(l.usual_monthly)}/month</small></div></li>`).join('')}</ul>${d.savers.combined ? `<p class="nx-small">All three together, simulated on your real months: +${g(d.savers.combined.expected_savings || 0)} expected.</p>` : ''}` : ''}
        ${d.upcoming.length ? `<p class="nx-k">Coming up</p><ul>${d.upcoming.map(u => `<li>${esc(u.name)} ${g(u.amount)} · ${/^\d{4}-\d{2}-\d{2}$/.test(u.due) ? fmtDay(u.due) : esc(u.due)}</li>`).join('')}</ul>` : ''}
        ${d.subscriptions.length ? `<p class="nx-k">Subscriptions</p><ul>${d.subscriptions.map(s => `<li>${esc(s.name)} ~${g(s.monthly)}/month</li>`).join('')}</ul>` : ''}
        ${d.insights.length ? `<p class="nx-k">Accountant's notes</p><ul>${d.insights.map(i => `<li>${esc(i.text)}</li>`).join('')}</ul>` : ''}
        <div class="nx-row2"><button id="nx-fin-full">Money view</button><button class="ghost" id="nx-fin-fut">Weigh a decision</button></div>${jib()}`;
      $('nx-fin-full').onclick = () => { closeSheet(); if (typeof window.openMoney === 'function') openMoney(); else $('mbtn').click(); };
      $('nx-fin-fut').onclick = () => { go('futures'); };
    } catch (e) { fail(el, e); el.innerHTML += jib(); }
    screenChanged();
  }
  const jib = () => `<div class="nx-planned"><strong>Jibreel</strong><p>Future fund concept. Planned only: no trading, investing or moving money is built or allowed.</p></div>`;

  const WISDOM = [
    ['For indeed, with hardship [will be] ease. Indeed, with hardship [will be] ease.', 'Qur\'an 94:5–6'],
    ['Allah does not charge a soul except [with that within] its capacity.', 'Qur\'an 2:286'],
    ['Unquestionably, by the remembrance of Allah hearts are assured.', 'Qur\'an 13:28'],
    ['And whoever relies upon Allah – then He is sufficient for him.', 'Qur\'an 65:3'],
    ['Say, "O My servants who have transgressed against themselves [by sinning], do not despair of the mercy of Allah."', 'Qur\'an 39:53'],
    ['O you who have believed, seek help through patience and prayer. Indeed, Allah is with the patient.', 'Qur\'an 2:153'],
    ['So do not weaken and do not grieve, and you will be superior if you are [true] believers.', 'Qur\'an 3:139'],
    ['And when My servants ask you concerning Me – indeed I am near.', 'Qur\'an 2:186'],
    ['Sufficient for us is Allah, and [He is] the best Disposer of affairs.', 'Qur\'an 3:173']
  ];
  const wisdomToday = () => WISDOM[Math.floor(Date.now() / 864e5) % WISDOM.length];
  function deenSheet() {
    openSheet('Emergency deen', `<p class="nx-lead">Breathe. Allah is near.</p>${WISDOM.slice(0, 6).map(w => `<blockquote>${esc(w[0])}<cite>${esc(w[1])}</cite></blockquote>`).join('')}<p class="nx-small">Translations: Sahih International.</p><button id="nx-deen-talk">Talk it through with Freya</button><button class="ghost" id="nx-deen-call">Call someone I trust</button>`, el => {
      el.querySelector('#nx-deen-talk').onclick = () => { closeSheet(); window.freyaCue && freyaCue('He pressed the Emergency Deen button: he is struggling spiritually or emotionally right now. Be soft, calm and present. One short line first, then listen. Offer a relevant ayah or dua only if it helps, never lecture. If he may be in danger, guide him to his emergency contacts or 999.'); };
      el.querySelector('#nx-deen-call').onclick = async () => { try { const c = await api('neuro=contacts'); emergencySheet(c.contacts); } catch (e) { emergencySheet([]); } };
    });
  }
  async function spaceMind(el) {
    const w = wisdomToday();
    el.innerHTML = (prefs.islamicMode ? `<blockquote class="nx-wis">${esc(w[0])}<cite>${esc(w[1])}</cite></blockquote>
      <div class="nx-row2"><button id="nx-salah">Salah tracker</button><button class="ghost danger" id="nx-deen">Emergency deen</button></div>
      <p class="nx-k">Prayer times where you are</p><div id="nx-times"><button class="ghost" id="nx-here">Use my location</button></div>
      <p class="nx-small">Works anywhere in the world. Your tracker is evidence-only: Freya logs a prayer after seeing it, or from a masjid photo.</p>` : '') +
      `<p class="nx-k">Check in</p><div class="nx-row2"><button class="ghost" id="nx-checkin">Check in now</button><button class="ghost" id="nx-sleep">${sleep.on ? 'Stop Sleep Focus' : 'Sleep Focus'}</button></div>
      <p class="nx-small">Sleep Focus listens only while it's on, with an indicator and Stop. It works out loud sounds and snore-like minutes on your phone${APPX ? ', with the screen off' : ''}, and keeps no audio.</p>
      <button class="link" id="nx-mindsec">Open ${prefs.islamicMode ? 'Mind & Deen' : 'Mind'} space</button>`;
    const S = id => el.querySelector('#' + id);
    if (S('nx-salah')) {
      S('nx-salah').onclick = () => { closeSheet(); window.freyaSalahPanel ? $('sbtn').click() : say('Salah tracker unavailable'); };
      S('nx-deen').onclick = deenSheet;
      S('nx-here').onclick = () => {
        const box = S('nx-times'); box.innerHTML = '<p class="nx-load">Finding you…</p>';
        if (!navigator.geolocation) { box.innerHTML = '<p class="nx-empty">Location is not available on this device.</p>'; return; }
        navigator.geolocation.getCurrentPosition(async pos => {
          try {
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const d = await api(`neuro=salah_times&lat=${pos.coords.latitude.toFixed(4)}&lng=${pos.coords.longitude.toFixed(4)}&tz=${encodeURIComponent(tz)}`);
            if (!d.ok) throw new Error(d.error);
            const t = d.times; box.innerHTML = `<div class="nx-times">${[['Fajr', t.fajr], ['Sunrise', t.sunrise], ['Dhuhr', t.dhuhr], ['Asr', t.asr], ['Maghrib', t.maghrib], ['Isha', t.isha]].map(x => `<div><small>${x[0]}</small><strong>${esc(x[1])}</strong></div>`).join('')}</div><p class="nx-small">${esc(d.tz)} · ${esc(d.method)}</p>`;
          } catch (e) { fail(box, e); }
        }, () => { box.innerHTML = '<p class="nx-empty">Location permission was declined. Your masjid times still work.</p>'; }, { timeout: 15000, maximumAge: 6e5 });
      };
    }
    S('nx-checkin').onclick = () => { if (!prefs.learning.checkins && !prefs.learning.conversations) say('Check-in starts. Turn on learning in Settings if you want Freya to remember patterns.'); closeSheet(); window.freyaCheckin && freyaCheckin(); };
    S('nx-sleep').onclick = () => { sleep.on ? sleep.stop() : sleep.start(); };
    S('nx-mindsec').onclick = () => openSec('mind');
    screenChanged();
  }
  async function spaceConnect(el) {
    let last = null; try { last = (await api('neuro=connect')).last; } catch (e) {}
    el.innerHTML = `<p class="nx-lead">Share a conversation. Freya strips it down to how you communicate, then you practise out loud.</p>
      <form id="nx-cf"><textarea id="nx-ct" rows="6" maxlength="30000" placeholder="Paste a chat, or import a WhatsApp export. Only your messages are judged; the chat isn't stored."></textarea><div class="nx-inline"><input id="nx-cme" maxlength="60" value="Eesah" aria-label="Your name in the chat"><label class="nx-file">Import .txt<input type="file" id="nx-cfile" accept=".txt,text/plain" hidden></label></div><button>Analyse</button></form><div id="nx-cout"></div>
      <p class="nx-k">Speaking practice</p><div class="nx-practice">${['Difficult family talk', 'Asking for my worth', 'Setting a boundary', 'Confident sales call'].map(s => `<button class="ghost" data-pr="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <button class="link" id="nx-consec">Open Connections space</button>`;
    const out = el.querySelector('#nx-cout');
    const show = r => { out.innerHTML = `<p class="nx-k">${r.analysed_at ? 'Analysed ' + ukTime(r.analysed_at) : ''}</p><p>${esc(r.summary)}</p><p class="nx-small">Tone: ${esc(r.tone)} · ${esc(r.confidence)}</p>${(r.strengths || []).length ? `<p class="nx-k">Strengths</p><ul>${r.strengths.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}${(r.flaws || []).map(f => `<article class="nx-flaw"><strong>${esc(f.pattern)}</strong><p class="q">"${esc(f.quote)}"</p><p>${esc(f.why)}</p><p class="better">Try: ${esc(f.better)}</p></article>`).join('')}${(r.practice || []).length ? `<div class="nx-practice">${r.practice.map(p => `<button data-pr="${esc(p.title + ': ' + p.brief)}">Practise · ${esc(p.title)}</button>`).join('')}</div>` : ''}`; bindPractice(); screenChanged(); };
    const bindPractice = () => el.querySelectorAll('[data-pr]').forEach(b => b.onclick = () => { closeSheet(); window.freyaStartSpecial && freyaStartSpecial({ mode: 'practice', scenario: b.dataset.pr }); });
    if (last) show(last); bindPractice();
    el.querySelector('#nx-cfile').onchange = async e => { const f = e.target.files[0]; if (f) { el.querySelector('#nx-ct').value = (await f.text()).slice(-30000); } };
    el.querySelector('#nx-cf').onsubmit = async e => { e.preventDefault(); const b = e.target.querySelector('button:last-child'); b.disabled = true; out.innerHTML = '<div class="nx-thinking"><i></i><p>Reading how you communicate…</p></div>'; body.classList.add('tooling'); try { show(await act('neuro_connect', { text: el.querySelector('#nx-ct').value, me: el.querySelector('#nx-cme').value })); el.querySelector('#nx-ct').value = ''; } catch (x) { fail(out, x); } finally { b.disabled = false; body.classList.remove('tooling'); } };
    el.querySelector('#nx-consec').onclick = () => openSec('connections');
    screenChanged();
  }
  async function spaceWork(el) {
    el.innerHTML = `<p class="nx-lead">Your working day, decisions and focus.</p><p class="nx-k">Today</p><div id="nx-wb"><p class="nx-load">Loading…</p></div>
      <p class="nx-k">Actions</p><div class="nx-list">
        <button data-w="focus"><strong>Focus for 90 minutes</strong><small>Notifications held, short replies</small></button>
        <button data-w="fut"><strong>Weigh a work decision</strong><small>Routes scored for risk and reward</small></button>
        <button data-w="email"><strong>Draft an email with Freya</strong><small>Nothing is sent without your approval</small></button>
        <button data-w="sec"><strong>Work &amp; Ambition space</strong><small>Goals, projects and her questions</small></button></div>`;
    el.querySelectorAll('[data-w]').forEach(b => b.onclick = async () => {
      const w = b.dataset.w;
      if (w === 'sec') return openSec('work');
      if (w === 'fut') return go('futures');
      if (w === 'email') { closeSheet(); return window.freyaCue && freyaCue('He wants to draft a work email. Ask who it is to and what it needs to say, then propose it with propose_action so he can approve it.'); }
      if (w === 'focus') { try { const r = await act('neuro_mode', { mode: 'focus', minutes: 90 }); prefs.mode = { mode: r.mode, until: r.until }; renderModeBar(); say('Focus on for 90 minutes'); closeSheet(); } catch (e) { say(e.message); } }
    });
    try { const d = await api('neuro=briefing'); const w = (d.items || []).filter(i => i.domain === 'work'); el.querySelector('#nx-wb').innerHTML = w.length ? `<ul class="nx-brief">${w.map(i => `<li><b>▤</b><div>${esc(i.text)}<small>${esc(i.evidence)}</small></div></li>`).join('')}</ul>` : '<p class="nx-empty">No work commitments found today. Connect Google (JSE) to see your calendar here.</p>'; } catch (e) { fail(el.querySelector('#nx-wb'), e); }
    screenChanged();
  }

  // ---------------- vault ----------------
  function renderVault() {
    root.innerHTML = card('nx-traj', 'Improvement or downfall?') + card('nx-learned', 'What Freya learned', '<span class="nx-tag">Edit · Delete</span>') + card('nx-ledger', 'Action ledger') + card('nx-fhist', 'Futures you weighed') + card('nx-sleepv', 'Sleep Focus') + `<button class="ghost nx-wide" id="nx-vaultsec">Vault records: documents and receipts</button>`;
    $('nx-vaultsec').onclick = () => openSec('vault');
    loadTraj(); loadLearned(); loadLedger(); loadFHist(); loadSleep();
  }
  async function loadTraj() {
    const el = cb('nx-traj'); if (!el) return;
    try {
      const d = await api('neuro=trajectory');
      const row = (x, cls) => `<li class="${cls}"><div class="l"><strong>${esc(x.label)}</strong><small>${esc(x.evidence)}</small></div><div class="v"><span>${esc(fmtVal(x.before, x.unit))}</span><i aria-hidden="true">→</i><b>${esc(fmtVal(x.now, x.unit))}</b></div><em class="${cls}">${esc(fmtChange(x))}</em></li>`;
      const P = d.period || {};
      el.innerHTML = `<div class="nx-verdict ${d.verdict === 'Improvement' ? 'up' : d.verdict === 'Downfall' ? 'down' : ''}"><strong>${esc(d.verdict)}</strong><small>${P.now_from ? esc(fmtRange(P.before_from, P.before_to)) + ' vs ' + esc(fmtRange(P.now_from, P.now_to)) : esc(P.now || '')}</small></div>` +
        (d.good.length ? `<p class="nx-k">The good</p><ul class="nx-traj">${d.good.map(x => row(x, 'good')).join('')}</ul>` : '') +
        (d.bad.length ? `<p class="nx-k">The bad</p><ul class="nx-traj">${d.bad.map(x => row(x, 'bad')).join('')}</ul>` : '') +
        (d.steady.length ? `<p class="nx-k">Holding</p><ul class="nx-traj">${d.steady.map(x => row(x, '')).join('')}</ul>` : '') +
        ((d.stale || []).length ? `<p class="nx-small nx-warn">Left out: ${d.stale.map(x => esc(x.label) + ' (' + esc(String(x.reason).replace(/\d{4}-\d{2}-\d{2}/, m => fmtDay(m))) + ')').join(', ')}</p>` : '') + `<p class="nx-small">${esc(d.note)}</p>`;
    } catch (e) { fail(el, e); }
  }
  const fmtDay = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  function fmtRange(a, b) {
    const A = new Date(a + 'T12:00:00Z'), B = new Date(b + 'T12:00:00Z'), m = d => d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
    return A.getUTCMonth() === B.getUTCMonth() ? `${A.getUTCDate()}–${B.getUTCDate()} ${m(B)}` : `${A.getUTCDate()} ${m(A)} – ${B.getUTCDate()} ${m(B)}`;
  }
  const hm = v => { v = Math.round(+v || 0); return v >= 60 ? `${Math.floor(v / 60)}h ${String(v % 60).padStart(2, '0')}m` : `${v}m`; };
  function fmtVal(v, unit) {
    const n = +v; if (!isFinite(n)) return String(v);
    if (unit === '£/week') return '£' + n.toLocaleString('en-GB', { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 }) + '/wk';
    if (unit === '%') return Math.round(n) + '%';
    if (/^of \d+$/.test(unit)) return Math.round(n) + '/' + unit.slice(3);
    if (unit === 'steps/day') return Math.round(n).toLocaleString('en-GB') + ' steps';
    if (unit === 'min/day' || unit === 'min/night') return hm(n);
    if (unit === 'h/night') return n.toFixed(1) + 'h';
    return n.toLocaleString('en-GB') + ' ' + unit;
  }
  function fmtChange(x) {
    const b = +x.before, n = +x.now;
    if (isFinite(b) && isFinite(n) && b) { const p = Math.round((n - b) / Math.abs(b) * 100); return (p > 0 ? '+' : p < 0 ? '−' : '') + Math.abs(p) + '%'; }
    return String(x.change || '').replace('-', '−');
  }
  async function loadLearned() {
    const el = cb('nx-learned'); if (!el) return;
    try {
      const d = await api('neuro=learned');
      const L = prefs.learning || {};
      el.innerHTML = `<div class="nx-pills"><span class="${L.conversations ? 'on' : ''}">Conversations ${L.conversations ? 'on' : 'off'}</span><span class="${L.checkins ? 'on' : ''}">Check-ins ${L.checkins ? 'on' : 'off'}</span><span class="${L.sleep ? 'on' : ''}">Sleep Focus ${L.sleep ? 'on' : 'off'}</span></div><p class="nx-small">Change these in Settings. No raw audio is ever kept.</p>` + (d.observations.length ? d.observations.map(o => `<article class="nx-obs" data-id="${o.id}"><p class="t">${esc(o.text)}</p><p class="nx-small">${esc(o.domain)} · ${esc(o.confidence)} confidence · ${ukTime(o.created_at)}</p>${o.evidence ? `<p class="nx-small">Evidence: ${esc(o.evidence)}</p>` : ''}<div class="nx-row2"><button class="ghost sm" data-e="${o.id}">Correct</button><button class="ghost sm" data-d="${o.id}">Delete</button></div></article>`).join('') : '<p class="nx-empty">Nothing yet. Freya only learns in the windows you allow.</p>');
      el.querySelectorAll('[data-d]').forEach(b => b.onclick = async () => { try { await act('neuro_learned', { id: +b.dataset.d, remove: true }); loadLearned(); say('Deleted'); } catch (e) { say(e.message); } });
      el.querySelectorAll('[data-e]').forEach(b => b.onclick = () => { const a = b.closest('.nx-obs'), t = a.querySelector('.t'); a.innerHTML = `<form class="nx-inline"><input maxlength="300" value="${esc(t.textContent)}" aria-label="Correct this"><button>Save</button></form>`; a.querySelector('form').onsubmit = async e => { e.preventDefault(); try { await act('neuro_learned', { id: +a.dataset.id, text: a.querySelector('input').value }); loadLearned(); } catch (x) { say(x.message); } }; });
    } catch (e) { fail(el, e); }
  }
  async function loadLedger() {
    const el = cb('nx-ledger'); if (!el) return;
    try { const d = await api('neuro=actions'); el.innerHTML = d.actions.length ? `<ul class="nx-ledger">${d.actions.slice(0, 15).map(a => `<li><strong>${esc(a.label)}</strong> <i class="nx-chip ${esc(a.status)}">${esc(a.status)}</i><small>${ukTime(a.created_at)}${a.why ? ' · ' + esc(a.why) : ''}${a.result && a.result.reason ? ' · ' + esc(a.result.reason) : ''}</small></li>`).join('')}</ul>` : '<p class="nx-empty">No actions yet. Anything Freya does for you outside the app is recorded here.</p>'; }
    catch (e) { fail(el, e); }
  }
  async function loadFHist() {
    const el = cb('nx-fhist'); if (!el) return;
    try { const d = await api('neuro=futures'); el.innerHTML = d.runs.length ? `<ul class="nx-ledger">${d.runs.map(r => `<li><strong>${esc(r.question)}</strong><small>${ukTime(r.created_at)} · pick: ${esc(r.result.recommended || '')}${r.chosen ? ' · you chose: ' + esc(r.chosen) : ''}</small></li>`).join('')}</ul>` : '<p class="nx-empty">No decisions weighed yet.</p>'; }
    catch (e) { fail(el, e); }
  }
  async function loadSleep() {
    const el = cb('nx-sleepv'); if (!el) return;
    try { const d = await api('neuro=sleep'); el.innerHTML = d.sessions.length ? `<ul class="nx-ledger">${d.sessions.map(s => `<li><strong>${ukTime(s.started_at)} · ${Math.round((s.summary.minutes || 0) / 6) / 10}h</strong><small>${s.summary.loud_events} loud sounds · ${s.summary.snore_like_min} snore-like min · ${s.summary.quiet_pct}% quiet${s.tiredness != null ? ' · tiredness ' + s.tiredness + '/10' : ''}${s.summary.interrupted ? ' · interrupted' : ''}</small><button class="ghost sm" data-sd="${s.id}">Delete</button></li>`).join('')}</ul><p class="nx-small">Session length is not proven sleep; not a medical assessment.</p>` : '<p class="nx-empty">No Sleep Focus sessions yet.</p>'; el.querySelectorAll('[data-sd]').forEach(b => b.onclick = async () => { await act('neuro_sleep_delete', { id: b.dataset.sd }).catch(() => {}); loadSleep(); }); }
    catch (e) { fail(el, e); }
  }

  // ---------------- settings ----------------
  function renderSettings() {
    const L = prefs.learning || {};
    const tog = (attrs, title, sub) => `<label class="nx-toggle"><span class="t"><strong>${title}</strong>${sub ? `<small>${sub}</small>` : ''}</span><input type="checkbox" role="switch" ${attrs}><i aria-hidden="true"></i></label>`;
    root.innerHTML = `<h1 class="nx-title">Settings</h1>
      <section class="nx-card"><div class="nx-card-h"><h2>Islamic Mode</h2></div>${tog(`id="n-islamic" ${prefs.islamicMode ? 'checked' : ''}`, 'Include deen', 'Salah, Mind &amp; Deen, wisdom and emergency deen')}<p class="nx-small" id="n-islamic-status">${prefs.configured ? 'Saved.' : 'On because you already use deen features.'}</p></section>
      <section class="nx-card"><div class="nx-card-h"><h2>Learning you</h2><span class="nx-tag">Opt-in</span></div>
        ${tog(`data-l="conversations" ${L.conversations ? 'checked' : ''}`, 'Conversations', 'Your own words only')}
        ${tog(`data-l="checkins" ${L.checkins ? 'checked' : ''}`, 'Evening check-in', 'A short reminder at your chosen time')}
        <div class="nx-field"><label for="nx-cit">Check-in time</label><input type="time" id="nx-cit" value="${esc(L.checkin_time || '21:00')}"></div>
        ${tog(`data-l="sleep" ${L.sleep ? 'checked' : ''}`, 'Sleep Focus', 'Only while you start it')}
        <p class="nx-small">No background recording. Freya never keeps raw audio, pauses in Private and Salah, and everything she learns is in Vault, where you can correct or delete it.</p>
        ${APPX ? `<button class="ghost nx-wide" id="nx-listen-setup">Phone listening setup</button><p class="nx-small" id="nx-listen-state"></p>` : ''}</section>
      <section class="nx-card"><div class="nx-card-h"><h2>Guest chat</h2></div><p class="nx-small">Freya answers only you. Let someone talk to her for a few minutes; they get none of your private information.</p><form id="nx-gf" class="nx-inline"><input maxlength="40" placeholder="Their name" id="nx-gn" aria-label="Guest's name"><button>Allow</button></form></section>
      ${isOwner() && U() ? `<section class="nx-card" id="nx-testers"><div class="nx-card-h"><h2>Testers</h2><span class="nx-tag">Owner</span></div><p class="nx-small">Invite someone to their own separate account. They see none of your data, and owner-only features (Google, bank, phone awareness) stay yours.</p><form id="nx-invf" class="nx-inline"><input maxlength="60" placeholder="Their name" id="nx-invn" aria-label="Tester's name" autocomplete="off"><button>Invite a tester</button></form><div id="nx-invout"></div><div id="nx-users"><p class="nx-load">Loading…</p></div></section>` : ''}
      <section class="nx-card"><div class="nx-card-h"><h2>What Freya may do</h2><span class="nx-tag">Deny by default</span></div><div id="nx-auth"><p class="nx-load">Loading…</p></div></section>
      <section class="nx-card"><div class="nx-card-h"><h2>Device</h2></div><div class="nx-list">
        ${isOwner() ? `<button id="n-native"><strong>Android settings</strong><small>Wake word, listening and permissions</small></button>` : ''}
        <button id="nx-notif"><strong>Reminders</strong><small>Notifications on this device</small></button>
        <button id="nx-redo" hidden><strong>Redo setup</strong><small>Go through onboarding again</small></button></div></section>`;
    const redo = $('redo'), nr = $('nx-redo'); if (redo && nr) { nr.hidden = redo.hidden; nr.onclick = () => redo.click(); }
    if ($('nx-listen-setup')) {
      $('nx-listen-setup').onclick = () => native('openListeningSetup');
      try { const st = JSON.parse(native('listeningStatus') || '{}'); const miss = [!st.mic && 'microphone', !st.notifications && 'notifications', !st.battery && 'battery: unrestricted'].filter(Boolean); $('nx-listen-state').textContent = miss.length ? 'Still needed on this phone: ' + miss.join(', ') + '.' : 'Phone is ready: microphone, indicator and background all set.'; } catch (e) {}
    }
    $('n-islamic').onchange = async e => { const v = e.target.checked; e.target.disabled = true; try { await act('neuro_islamic_mode', { enabled: v }); prefs.islamicMode = v; prefs.configured = true; $('n-islamic-status').textContent = 'Saved.'; body.classList.toggle('no-deen', !v); } catch (x) { e.target.checked = !v; $('n-islamic-status').textContent = x.message; } finally { e.target.disabled = false; } };
    root.querySelectorAll('[data-l]').forEach(i => i.onchange = async () => { try { const r = await act('neuro_learning', { [i.dataset.l]: i.checked, checkin_time: $('nx-cit').value }); prefs.learning = r.learning; native('setLearning', JSON.stringify(r.learning || {})); say('Saved'); } catch (e) { i.checked = !i.checked; say(e.message); } });
    $('nx-cit').onchange = async () => { try { const r = await act('neuro_learning', { checkin_time: $('nx-cit').value }); prefs.learning = r.learning; native('setLearning', JSON.stringify(r.learning || {})); } catch (e) { say(e.message); } };
    $('nx-gf').onsubmit = e => { e.preventDefault(); confirmGuest($('nx-gn').value || 'a guest', 15); };
    if (isOwner() && U()) testersCard();
    if ($('n-native')) $('n-native').onclick = () => { if (window.FreyaAndroid && FreyaAndroid.openSettings) FreyaAndroid.openSettings(); else say('Available in the Neuro Android app.'); };
    $('nx-notif').onclick = () => { if (!$('notify').hidden) $('notify').click(); else say('Reminders are already set up on this device.'); };
    api('neuro=actions').then(d => { $('nx-auth').innerHTML = `<ul class="nx-auth">${Object.values(d.policy).map(p => `<li><div><strong>${esc(p.label)}</strong>${p.reason ? `<small>${esc(p.reason)}</small>` : ''}</div><i class="nx-status ${esc(p.authority)}">${({ approval: 'Asks first', routine: 'Allowed', never: 'Never', blocked: 'Not built' })[p.authority] || esc(p.authority)}</i></li>`).join('')}</ul>`; }).catch(e => fail($('nx-auth'), e));
  }

  // ---------------- testers (owner only): invite links, accounts, revoke ----------------
  async function authApi(action, b) {
    const r = await fetch('/api/auth/' + action, b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : { cache: 'no-store' });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'That did not work.'); return j;
  }
  const ukShort = t => new Date(t).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  function showLink(r) {
    const out = $('nx-invout'); if (!out) return;
    out.innerHTML = `<p class="nx-small">Link for <strong>${esc(r.name)}</strong> · works once · until ${esc(ukShort(r.expires_at))} (UK)</p><p class="nx-invlink" id="nx-invl">${esc(r.link)}</p><div class="nx-row2"><button id="nx-invc">Copy link</button>${navigator.share ? '<button class="ghost" id="nx-invs">Share…</button>' : ''}</div><p class="nx-small">Ask them to open it in Safari on their iPhone, create a passkey, then Add to Home Screen.</p>`;
    $('nx-invc').onclick = () => { (navigator.clipboard ? navigator.clipboard.writeText(r.link) : Promise.reject()).then(() => say('Link copied')).catch(() => { const sel = getSelection(), rg = document.createRange(); rg.selectNodeContents($('nx-invl')); sel.removeAllRanges(); sel.addRange(rg); say('Select and copy the link'); }); };
    if ($('nx-invs')) $('nx-invs').onclick = () => navigator.share({ title: 'Neuro invite', text: `Your invite to try Neuro (works once, until ${ukShort(r.expires_at)} UK time):`, url: r.link }).catch(() => {});
  }
  async function testersCard() {
    const f = $('nx-invf');
    if (f) f.onsubmit = async e => { e.preventDefault(); const n = $('nx-invn').value.trim(); if (!n) return say('Add their name'); const b = f.querySelector('button'); b.disabled = true; try { const r = await authApi('invite-create', { name: n }); $('nx-invn').value = ''; showLink(r); listUsers(); } catch (x) { say(x.message); } finally { b.disabled = false; } };
    listUsers();
  }
  async function listUsers() {
    const el = $('nx-users'); if (!el) return;
    try {
      const d = await authApi('users');
      const people = d.users.filter(u => u.role !== 'owner');
      const rows = people.map(u => `<li><div><strong>${esc(u.name)}</strong><small>${u.status === 'active' ? 'Active' : 'Switched off'} · ${u.last_sign_in ? 'last in ' + esc(ukShort(u.last_sign_in)) : 'not signed in yet'}${u.voice_today_min != null ? ` · voice today ${u.voice_today_min}/${u.voice_cap_min || 30} min` : ''}</small></div><span>${u.status === 'active' ? `<button class="ghost" data-newlink="${esc(u.id)}">New link</button> <button class="ghost" data-revoke="${esc(u.id)}">Revoke</button>` : `<button class="ghost" data-restore="${esc(u.id)}">Restore</button>`}</span></li>`);
      const inv = d.invites.filter(i => !i.user_id || !people.some(u => u.id === i.user_id && u.passkeys)).map(i => `<li><div><strong>${esc(i.name)}</strong><small>Invite open · until ${esc(ukShort(i.expires_at))}</small></div><button class="ghost" data-uninvite="${esc(i.id)}">Cancel</button></li>`);
      el.innerHTML = rows.length || inv.length ? `<ul class="nx-users">${rows.join('')}${inv.join('')}</ul>` : '<p class="nx-small">No testers yet.</p>';
      el.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => { if (!confirm('Switch this account off? They are signed out straight away. Their data is kept.')) return; try { await authApi('user-revoke', { id: b.dataset.revoke }); listUsers(); } catch (e) { say(e.message); } });
      el.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => { try { await authApi('user-restore', { id: b.dataset.restore }); listUsers(); } catch (e) { say(e.message); } });
      el.querySelectorAll('[data-uninvite]').forEach(b => b.onclick = async () => { try { await authApi('invite-revoke', { id: b.dataset.uninvite }); listUsers(); } catch (e) { say(e.message); } });
      el.querySelectorAll('[data-newlink]').forEach(b => b.onclick = async () => { try { showLink(await authApi('invite-create', { user_id: b.dataset.newlink })); listUsers(); } catch (e) { say(e.message); } });
    } catch (e) { fail(el, e); }
  }

  // ---------------- guest chat ----------------
  function confirmGuest(name, minutes) {
    name = String(name || 'a guest').slice(0, 40); minutes = Math.max(5, Math.min(60, +minutes || 15));
    openSheet('Guest chat', `<p class="nx-lead">Let ${esc(name)} talk to Freya for ${minutes} minutes?</p><p class="nx-small">They won't hear anything about your life, money, schedule, messages or memories, and Freya takes no actions. Your current chat ends.</p><div class="nx-row2"><button class="ghost" id="nx-g-no">Not now</button><button id="nx-g-yes">Allow</button></div>`, el => {
      el.querySelector('#nx-g-no').onclick = () => { closeSheet(); window.freyaContext && freyaContext('He declined the guest chat.'); };
      el.querySelector('#nx-g-yes').onclick = async () => { try { const r = await act('neuro_guest', { on: true, name, minutes }); closeSheet(); $('nx-guest-t').textContent = 'Guest chat · ' + r.guest.name + ' · nothing private'; $('nx-guestbar').hidden = false; window.freyaStartSpecial && freyaStartSpecial({ mode: 'guest' }); } catch (e) { say(e.message); } };
    });
  }
  $('nx-guest-end').onclick = async () => { await act('neuro_guest', { on: false }).catch(() => {}); $('nx-guestbar').hidden = true; if (window.freyaIsActive && freyaIsActive()) $('orb').click(); };
  function specialEnded() { if (!$('nx-guestbar').hidden) { $('nx-guestbar').hidden = true; act('neuro_guest', { on: false }).catch(() => {}); } }

  // ---------------- Sleep Focus (on-device, derived only) ----------------
  const sleep = {
    on: false,
    async start() {
      if (!prefs.learning.sleep) { say('Turn on Sleep Focus in Settings first.'); setPage('settings'); return; }
      if (window.freyaIsActive && freyaIsActive()) { say('End your chat with Freya first.'); return; }
      if (window.freyaSalah && freyaSalah.on()) return;
      if (APPX) {
        // Android app: the phone's own microphone service does the listening, so it carries on with the screen off.
        let r = {}; try { r = JSON.parse(native('sleepStart') || '{}'); } catch (e) {}
        if (!r.ok) { say(r.error || 'Sleep Focus could not start.'); return; }
        Object.assign(this, { on: true, nativeOn: true, started: new Date(r.started_at || Date.now()) });
        this.showIndicator(); say('Sleep Focus on. You can lock your phone; tap Stop in the notification when you wake.');
        if (sheetKey === 'mind') refresh('mind');
        return;
      }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      } catch (e) { say('Microphone permission is needed for Sleep Focus.'); return; }
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this.ctx.createMediaStreamSource(this.stream); this.an = this.ctx.createAnalyser(); this.an.fftSize = 2048; src.connect(this.an);
      const buf = new Float32Array(this.an.fftSize);
      Object.assign(this, { on: true, started: new Date(), samples: 0, quiet: 0, loud: 0, lastLoud: 0, bursts: [], snoreMin: 0, hist: [], interrupted: false });
      try { this.lock = await navigator.wakeLock.request('screen'); } catch (e) { this.lock = null; }
      this.timer = setInterval(() => {
        this.an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const rms = Math.sqrt(s / buf.length); this.samples++;
        this.hist.push(rms); if (this.hist.length > 240) this.hist.shift();
        const base = [...this.hist].sort((a, b) => a - b)[Math.floor(this.hist.length * 0.2)] || rms;
        if (rms < base * 1.6) this.quiet++;
        const t = Date.now();
        if (this.samples > 20 && rms > Math.max(base * 3.5, 0.015) && t - this.lastLoud > 1000) { this.loud++; this.lastLoud = t; this.bursts.push(t); }
        this.bursts = this.bursts.filter(b => t - b < 60e3);
        if (this.samples % 120 === 0) { const iv = this.bursts.slice(1).map((b, i) => (b - this.bursts[i]) / 1000); const m = iv.reduce((a, b) => a + b, 0) / (iv.length || 1); const sd = Math.sqrt(iv.reduce((a, b) => a + (b - m) * (b - m), 0) / (iv.length || 1)); if (iv.length >= 5 && m >= 2 && m <= 7 && sd < 1.6) this.snoreMin++; }
        if ((window.freyaSalah && freyaSalah.on()) || body.dataset.mode === 'private') this.stop(true);
      }, 500);
      this.showIndicator();
      say('Sleep Focus on. Keep Neuro open with the screen dimmed; tap Stop when you wake.');
      if (sheetKey === 'mind') refresh('mind');
    },
    showIndicator() { $('nx-listen-t').textContent = 'Sleep Focus · listening, no audio kept'; $('nx-listen').hidden = false; },
    resumeNative() {
      if (!APPX) return;
      try { const st = JSON.parse(native('listeningStatus') || '{}'); if (st.active && !this.on) { Object.assign(this, { on: true, nativeOn: true, started: new Date(st.started_at) }); this.showIndicator(); } if (!st.active && this.on && this.nativeOn) { this.on = false; $('nx-listen').hidden = true; } } catch (e) {}
      const pend = native('sleepPending'); if (pend && !this.on) { try { const r = JSON.parse(pend); this.morning(new Date(r.started_at), new Date(r.ended_at), r.summary, () => native('sleepClear')); } catch (e) { native('sleepClear'); } }
    },
    morning(started, ended, summary, done) {
      openSheet('Good morning', `<p class="nx-lead">How tired do you feel?</p><p class="nx-small">0 is fresh, 10 is exhausted.</p><div class="nx-scale">${[...Array(11)].map((_, i) => `<button data-t="${i}">${i}</button>`).join('')}</div><button class="link" data-t="">Skip</button>`, el => el.querySelectorAll('[data-t]').forEach(b => b.onclick = async () => { closeSheet(); try { await act('neuro_sleep', { started_at: started.toISOString(), ended_at: ended.toISOString(), summary, tiredness: b.dataset.t === '' ? null : +b.dataset.t }); done && done(); say('Sleep Focus saved · see Vault'); } catch (e) { say(e.message); } }));
    },
    async stop(auto) {
      if (!this.on) return; this.on = false; clearInterval(this.timer);
      if (this.nativeOn) {
        this.nativeOn = false; $('nx-listen').hidden = true;
        let r = {}; try { r = JSON.parse(native('sleepStop') || '{}'); } catch (e) {}
        if (!r.saved) { say('Sleep Focus stopped (under 10 minutes, nothing saved).'); return; }
        return this.morning(new Date(r.started_at), new Date(r.ended_at), r.summary, () => native('sleepClear'));
      }
      try { this.stream.getTracks().forEach(t => t.stop()); this.ctx.close(); } catch (e) {}
      try { this.lock && this.lock.release(); } catch (e) {}
      $('nx-listen').hidden = true;
      const ended = new Date(), minutes = (ended - this.started) / 6e4;
      const summary = { loud_events: this.loud, snore_like_min: this.snoreMin, quiet_pct: this.samples ? Math.round(this.quiet / this.samples * 100) : 0, interrupted: this.interrupted || !!auto };
      if (minutes < 10) { say('Sleep Focus stopped (under 10 minutes, nothing saved).'); return; }
      this.morning(this.started, ended, summary);
    }
  };
  $('nx-listen-stop').onclick = () => sleep.stop();
  document.addEventListener('visibilitychange', () => { if (document.hidden && sleep.on && !sleep.nativeOn) sleep.interrupted = true; if (!document.hidden) sleep.resumeNative(); });

  // ---------------- sheet ----------------
  function openSheet(title, html, bind) {
    $('nx-sheet-title').textContent = title; const el = $('nx-sheet-body'); el.innerHTML = html; $('nx-sheet').hidden = false; el.scrollTop = 0;
    if (bind) bind(el);
    screenChanged();
  }
  function closeSheet(silent) { if ($('nx-sheet').hidden) return; $('nx-sheet').hidden = true; sheetKey = null; if (!silent) screenChanged(); }
  $('nx-sheet-back').onclick = () => closeSheet();

  // ---------------- screen awareness: Freya always knows what he is looking at ----------------
  const LABELS = { home: 'Home (briefing, futures, priorities)', chat: 'Freya conversation', life: 'Life spaces', vault: 'Vault (improvement or downfall, what Freya learned, action ledger)', settings: 'Settings' };
  function visibleScreen() {
    const open = id => { const e = $(id); return e && !e.hidden ? e : null; };
    let e;
    if ((e = open('salahv'))) return { label: 'Salah tracker panel', el: e };
    if ((e = open('money'))) return { label: 'Money (read-only bank view)', el: e };
    if ((e = open('sect'))) return { label: 'Growth space: ' + (($('sect-title') || {}).textContent || ''), el: e };
    if ((e = open('nx-sheet'))) return { label: ($('nx-sheet-title').textContent || 'panel') + (sheetKey ? ' space' : ''), el: $('nx-sheet-body') };
    if ((e = open('card'))) return { label: 'Card on screen', el: e };
    return { label: LABELS[page] || page, el: root };
  }
  window.freyaScreenCtx = () => {
    const v = visibleScreen();
    if (body.dataset.mode === 'private') return `He is on the NEURO screen "${v.label}" (private mode: contents hidden).`;
    const text = (v.el ? v.el.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    return `He is now on the NEURO screen "${v.label}".${text ? ' On screen: ' + text : ''}`;
  };
  let lastSent = '', scT = null;
  function screenChanged() {
    clearTimeout(scT);
    scT = setTimeout(() => {
      const v = visibleScreen(), key = v.label + '|' + (v.el ? v.el.innerText.length >> 6 : 0);
      if (key === lastSent) return; lastSent = key;
      body.dataset.screen = v.label;
      if (window.freyaIsActive && freyaIsActive() && window.freyaContext) freyaContext(window.freyaScreenCtx());
    }, 900);
  }
  new MutationObserver(screenChanged).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  const contentObs = new MutationObserver(screenChanged);
  ['sect', 'money', 'salahv'].forEach(id => { const e = $(id); if (e) contentObs.observe(e, { childList: true, subtree: true }); });

  // ---------------- preferences + API for app.js ----------------
  async function loadPrefs() {
    try { const p = await api('neuro=preferences'); prefs = { ...prefs, ...p }; if (p.learning) native('setLearning', JSON.stringify(p.learning)); sleep.resumeNative(); if (typeof p.islamicMode === 'boolean') body.classList.toggle('no-deen', !p.islamicMode); if (p.guest && !(window.freyaSpecial && freyaSpecial.mode === 'guest')) act('neuro_guest', { on: false }).catch(() => {}); } catch (e) {}
    renderModeBar(); if (page === 'settings' || page === 'life') render();
  }
  window.freyaNeuro = {
    go, showFutures, approvalCard, confirmGuest, specialEnded, refresh,
    modeChanged: r => { prefs.mode = { mode: r.mode, until: r.until }; renderModeBar(); if (r.mode === 'emergency') emergencySheet(r.contacts); },
    page: () => page, prefs: () => prefs
  };
  const start = new URLSearchParams(location.search).get('page');
  setPage(start || 'home');
  loadPrefs();
  // When he unlocks, reload data-bound views.
  const lock = $('lock'); if (lock) new MutationObserver(() => { if (lock.hidden) { loadPrefs(); render(); } }).observe(lock, { attributes: true, attributeFilter: ['hidden'] });
})();
