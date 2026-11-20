// Growth sections: Body, Connections, Mind & Deen, Work & Ambition, Vault.
// Flow per section: onboarding questions -> ~5 minute real build (Gemini plans the section) -> ready space
// where he drops things in. Raw uploads live in the private "growth" bucket for 24h; only insights are kept.
const crypto = require('crypto');
const { db, storage, SUPABASE_URL, getProfile, clip } = require('./_db');

const BUCKET = 'growth';
const RAW_HOURS = 24;
const ORDER = ['body', 'connections', 'mind', 'work', 'vault'];
const MEM_CAT = { body: 'health', connections: 'people', mind: 'deen', work: 'work', vault: 'other' };

// ---------------- Questions (in her voice) ----------------
const META = {
  body: { name: 'Body', intro: "This is your body space: progress photos, weigh-ins, meals, gym clips. Before I build it, I need the honest picture. Take your time, there are no wrong answers.",
    questions: [
      "Let's start with the honest picture. How would you describe your body and fitness right now: weight, energy, strength, how your clothes fit?",
      "What's the goal, in your words? Give me a number if you have one (weight, waist, a lift) and a date that matters to you.",
      "Why does this matter to you now? What changes in your life when you get there?",
      "Walk me through a normal week of training. What you actually do, not what you plan to do.",
      "How do you eat on a typical day, from the first thing to the last thing at night? Where does it usually go wrong?",
      "What's derailed you before? Be specific: times, places, moods, people.",
      "How do sleep, stress and long work days hit your training and eating?",
      "Any injuries, health conditions or medication I should keep in mind?",
      "How do you want me to coach you: straight-talking, gentle, or data-first? And how often should I check in?",
      "What would 'better' look like in 90 days, in a way you could actually see in a photo?"
    ] },
  connections: { name: 'Connections', intro: "This is where I help you sharpen how you talk to people who matter: potential partners, family, business. Let me understand you first.",
    questions: [
      "Who matters most in this space right now: a potential partner, family, business contacts? Where's your focus?",
      "When it comes to finding a partner, what are you looking for? Values, deen, character, lifestyle.",
      "How do you think you come across in messages right now? Be honest. And how do you want to come across?",
      "Tell me about one conversation that went well and one that went flat. What do you think made the difference?",
      "When you're nervous or keen, what do you tend to do: over-text, go quiet, joke, over-explain?",
      "What does a high value man mean to you, in how he speaks and carries himself?",
      "Are there lines you won't cross, in topics, tone or pace, because of your values and deen?",
      "With family and business contacts, where does communication feel hard or tense?",
      "How blunt should I be when I review your messages?",
      "Last one. By default I focus on your side and the flow, and I keep nothing personal about the other person. Anything you'd add to how I treat their words?"
    ] },
  mind: { name: 'Mind & Deen', intro: "This is your space for headspace and deen: reflections, journal entries, Qur'an and dua notes, mood. A few questions so I build it around you.",
    questions: [
      "How's your headspace lately, honestly? Calm, scattered, heavy, driven?",
      "Where are you with your deen right now (salah, Qur'an, dhikr) and where do you want to be?",
      "What lifts you, and what drains you, in a normal week?",
      "When you're low or stressed, what do you usually reach for?",
      "Is there a surah, a dua or a practice that grounds you? Anything you want to build up?",
      "How do you like to reflect: writing, talking it out, or quick check-ins?",
      "What thought patterns keep coming back that you'd like to break?",
      "When you miss a salah or have a bad day, how does it spill into the rest of your life: work, money, people?",
      "What would a strong, steady you look like three months from now?",
      "When's the best time each day for me to give you a reflection prompt?"
    ] },
  work: { name: 'Work & Ambition', intro: "This is your work space: documents, decks, screenshots, call notes and goals, for JSE and for your career. Let me understand the mission first.",
    questions: [
      "Tell me about your role at JSE Academic as you see it: what you own, and what success looks like this year.",
      "What are the three biggest goals for JSE in the next 6 to 12 months?",
      "And for you personally, where do you want your career to be in three years?",
      "What does your week really look like: calls, deep work, firefighting? Where does time leak?",
      "Which calls or meetings matter most, and how do you usually prepare for them?",
      "Where do you feel strongest at work, and where are you still sharpening?",
      "What's held JSE, or you, back so far?",
      "Who are the key people (team, partners, clients) I should know about?",
      "When you send me documents, decks or screenshots, what should I look for?",
      "What would make you say 'Freya genuinely made my work better' a month from now?"
    ] },
  vault: { name: 'Vault', intro: "The Vault is your catch-all: receipts, certificates, ideas, documents. I sort it, tag it and find it when you ask. A few quick questions first.",
    questions: [
      "What kinds of things do you want to keep here: receipts, certificates, ideas, documents, something else?",
      "When you save something, what do you usually need later: amounts and dates, where it is, or just the gist?",
      "How should I group things: by type, by area of life, or by project?",
      "Are there renewals or expiry dates you want me to watch, like warranties, IDs, insurance or memberships?",
      "When you have a random idea, should I just file it, or help you develop it?",
      "Is anything too sensitive to store even for 24 hours? After that I keep only a summary.",
      "How would you like to find things later: ask me out loud, search, or browse?",
      "Anything already scattered (screenshots, notes) you want to bring in first?"
    ] }
};

// Safe defaults so a build can never get stuck: merged with whatever Gemini produces.
const DEFAULTS = {
  body: { metrics: [{ key: 'weight', label: 'Weight', unit: 'kg', direction: 'down', source: 'manual' }, { key: 'training_days', label: 'Training days', unit: 'days/wk', direction: 'up', source: 'manual' }, { key: 'meal_quality', label: 'Meal quality', unit: '/10', direction: 'up', source: 'upload' }],
    look_for: ['visible change vs earlier photos (posture, waist, shoulders, face)', 'meal portions, protein, ultra-processed food', 'training form and intensity in clips'], prompts: ['Log your weight this morning, before food.', 'Snap your lunch and I will rate it.', "What's one training win from this week?"] },
  connections: { metrics: [{ key: 'confidence', label: 'Confidence', unit: '/10', direction: 'up', source: 'upload' }, { key: 'curiosity', label: 'Curiosity', unit: '/10', direction: 'up', source: 'upload' }, { key: 'clarity', label: 'Clarity', unit: '/10', direction: 'up', source: 'upload' }, { key: 'composure', label: 'Composure', unit: '/10', direction: 'up', source: 'upload' }],
    look_for: ['how he opens and leads', 'question-to-statement balance', 'over-texting, double texts, long gaps', 'clarity of intentions and values', 'warmth without neediness'], prompts: ['Paste a message you are about to send and I will sharpen it.', 'Export a recent chat (WhatsApp: chat > More > Export chat, without media).'] },
  mind: { metrics: [{ key: 'mood', label: 'Mood', unit: '/5', direction: 'up', source: 'manual' }, { key: 'calm', label: 'Calm', unit: '/10', direction: 'up', source: 'upload' }],
    look_for: ['recurring thought patterns', 'links between salah, sleep and mood', 'gratitude and tawakkul', 'stressors that repeat'], prompts: ['What is weighing on you today, and what is in your control?', 'Name one blessing from today you nearly missed.', 'Which salah felt most present today, and why?', 'What would make tomorrow 1% better?'] },
  work: { metrics: [{ key: 'goal_progress', label: 'Goal progress', unit: '%', direction: 'up', source: 'upload' }, { key: 'deep_work', label: 'Deep work', unit: 'hrs/wk', direction: 'up', source: 'manual' }],
    look_for: ['clarity of the ask and next steps', 'numbers and evidence', 'risks and blockers', 'alignment with JSE goals'], prompts: ['What is the one outcome that would make this week a win?', 'Drop in the deck or notes for your next important call.'] },
  vault: { metrics: [], look_for: ['type of item', 'amounts, dates, expiry or renewal dates', 'who it involves', 'where it belongs'], prompts: ['Snap a receipt or drop a document and I will file it.'] }
};

// ---------------- Gemini helpers ----------------
async function gen(parts, schema, { models = ['gemini-flash-latest', 'gemini-flash-lite-latest'], timeout = 25000, temperature = 0.6 } = {}) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error('no_gemini_key');
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature, ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}) } });
  let last = 'gemini_failed';
  for (const m of models.flatMap(x => [x, x + '#retry'])) {
    if (m.endsWith('#retry') && !/gemini_(429|500|503)/.test(last)) continue; // one quick retry when Gemini is briefly overloaded
    if (m.endsWith('#retry')) await new Promise(r => setTimeout(r, 1500));
    const model = m.replace('#retry', '');
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(timeout) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.candidates || !j.candidates[0].content) { last = 'gemini_' + r.status; continue; }
      const t = j.candidates[0].content.parts.filter(p => p.text).map(p => p.text).join('');
      return schema ? JSON.parse(t) : t.trim();
    } catch (e) { last = String(e.message || e).slice(0, 80); }
  }
  throw new Error(last);
}
const S = t => ({ type: 'STRING', description: t });
const ARR = (items, d) => ({ type: 'ARRAY', items, description: d });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required: required || Object.keys(properties) });
const CONFIG_SCHEMA = OBJ({
  headline: S('One short line naming what this space is for him, e.g. "From 92kg to a lean 82kg by Ramadan"'),
  summary: S('2-3 sentences: where he is now and the path, in second person, warm and direct'),
  goals: ARR(OBJ({ title: S('specific goal'), target: S('measurable target or "" if not measurable'), by: S('date or timeframe, or ""') }), '2-4 goals'),
  metrics: ARR(OBJ({ key: S('snake_case id'), label: S('short label'), unit: S('unit'), direction: { type: 'STRING', enum: ['up', 'down', 'steady'] }, source: { type: 'STRING', enum: ['manual', 'upload'] } }), '2-5 metrics to track'),
  coaching_plan: ARR(OBJ({ phase: S('e.g. Weeks 1-2'), focus: S('one concrete focus') }), '3-4 phases'),
  tone: S('how to coach him, from his answers'),
  look_for: ARR(S('thing to look for'), 'what to look for in his uploads, 4-6 items'),
  prompts: ARR(S('a short prompt or question she can give him'), '5-7 prompts/check-ins'),
  nudge_rules: ARR(S('gentle rule: when to ask, how, how often (max one a day, always as a question)'), '2-4 rules'),
  welcome: S('Her first message when he opens the finished space: 2 sentences, warm, no recap of everything she knows'),
  facts: ARR(S('a durable fact about him from his answers, third person'), '3-6 facts')
});

function sectionBrief(key) {
  return { body: 'Body: fitness, weight, physique, nutrition, training. Uploads: progress photos, meal photos, gym clips (as keyframes), weigh-ins.',
    connections: 'Connections: how he communicates with potential partners (marriage-minded, Muslim values), family and business contacts. He wants to be a high value man: calm, confident, clear, kind, leads well, not needy. Uploads: exported chats with HIS lines marked ME and others THEM; pasted messages.',
    mind: "Mind & Deen: headspace, mood, stress, reflection, and his deen (salah, Qur'an, dhikr, dua). Uploads: journal entries, reflections, Qur'an/dua notes.",
    work: 'Work & Ambition: he is COO of JSE Academic (UK). Career growth, JSE goals, call prep. Uploads: documents, decks, screenshots, call notes.',
    vault: 'Vault: catch-all filing. Receipts, certificates, ideas, documents. Sort, tag, summarise, track dates; find things on request.' }[key];
}

// ---------------- State ----------------
const now = () => new Date().toISOString();
async function rows(key) { return db(`sections?select=*&key=eq.${key}`); }
async function getSection(key) { return (await rows(key))[0] || null; }
const valid = k => ORDER.includes(k);

// Build plan: real steps, paced across ~5 minutes as agreed with him.
const BUILD_SECONDS = 300;
const STEPS = [
  { at: 0, label: 'Reading your answers' },
  { at: 75, label: 'Choosing what to track' },
  { at: 165, label: 'Writing your coaching plan' },
  { at: 255, label: 'Final checks' }
];

function publicState(s) {
  if (!s) return { status: 'locked' };
  const out = { status: s.status, settings: s.settings || {} };
  if (s.status === 'onboarding') out.answered = (s.answers || []).length;
  if (s.status === 'building') {
    const started = Date.parse(s.build_started_at);
    out.started_at = s.build_started_at; out.eta = new Date(started + BUILD_SECONDS * 1000).toISOString();
    out.steps = STEPS.map((x, i) => ({ label: x.label, done: s.step > i }));
  }
  if (s.status === 'ready') { const c = s.config || {}; out.ready_at = s.ready_at; out.config = { headline: c.headline, summary: c.summary, goals: c.goals, metrics: c.metrics, coaching_plan: c.coaching_plan, prompts: c.prompts, welcome: c.welcome }; }
  return out;
}

async function overview() {
  const all = await db('sections?select=*');
  const by = Object.fromEntries(all.map(s => [s.key, s]));
  const building = all.filter(s => s.status === 'building');
  for (const s of building) { try { await advance(s); } catch (e) {} }
  const fresh = building.length ? Object.fromEntries((await db('sections?select=*')).map(s => [s.key, s])) : by;
  return { sections: ORDER.map(k => ({ key: k, name: META[k].name, ...publicState(fresh[k]) })) };
}

async function detail(key) {
  let s = await getSection(key);
  if (s && s.status === 'building') { try { await advance(s); } catch (e) {} s = await getSection(key); }
  const out = { key, name: META[key].name, intro: META[key].intro, questions: META[key].questions, ...publicState(s) };
  if (s && s.status === 'onboarding') out.answers = s.answers;
  if (s && s.status === 'ready') {
    const [ins, mets, items] = await Promise.all([
      db(`section_insights?select=id,kind,text,data,created_at,item_id&section=eq.${key}&order=created_at.desc&limit=40`),
      db(`section_metrics?select=key,value,unit,at&section=eq.${key}&order=at.asc&limit=400`),
      db(`section_items?select=id,kind,name,status,analysis,created_at,thumb_path&section=eq.${key}&order=created_at.desc&limit=30`)
    ]);
    out.insights = ins.filter(i => i.kind !== 'question'); out.metrics_data = mets;
    const qs = await db(`section_insights?select=id,text,data,created_at&section=eq.${key}&kind=eq.question&order=created_at.desc&limit=60`);
    out.questions_open = qs.filter(isOpen).reverse().slice(-QCAP).map(q => ({ id: q.id, text: q.text, at: q.created_at }));
    out.questions_answered = qs.filter(q => q.data && q.data.status === 'answered').slice(0, 15).map(q => ({ id: q.id, text: q.text, answer: q.data.answer, reply: q.data.reply, at: q.data.answered_at || q.created_at }));
    out.items = items.map(i => ({ id: i.id, kind: i.kind, name: i.name, status: i.status, created_at: i.created_at, title: i.analysis && i.analysis.title, summary: i.analysis && i.analysis.summary, tags: (i.analysis && i.analysis.tags) || [], thumb: !!i.thumb_path }));
    const c = s.config || {}; const p = c.prompts || [];
    if (p.length) out.prompt_today = p[Math.floor(Date.now() / 864e5) % p.length];
  }
  return out;
}

// ---------------- Onboarding + build ----------------
async function saveAnswers(key, answers, finish) {
  const clean = (Array.isArray(answers) ? answers : []).slice(0, 14).map((a, i) => ({ q: clip(META[key].questions[i] || (a && a.q), 400), a: clip(a && a.a, 2500).trim() }));
  const s = await getSection(key);
  if (s && s.status !== 'onboarding') return { ok: false, error: 'This section is already ' + s.status };
  if (!finish) {
    await db('sections?on_conflict=key', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { key, status: 'onboarding', answers: clean, updated_at: now() } });
    return { ok: true };
  }
  if (clean.filter(x => x.a).length < Math.ceil(META[key].questions.length / 2)) return { ok: false, error: 'Answer at least half the questions so I can build it properly.' };
  await db('sections?on_conflict=key', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { key, status: 'building', answers: clean, step: 0, attempts: 0, last_error: null, config: null, build_started_at: now(), updated_at: now() } });
  const fresh = await getSection(key);
  try { await advance(fresh); } catch (e) {}
  return { ok: true, ...publicState(await getSection(key)) };
}

async function advance(s) {
  if (!s || s.status !== 'building') return s;
  const started = Date.parse(s.build_started_at) || Date.now();
  // A step that is claimed but has not finished for 3 minutes is considered crashed and can be re-run.
  // At most two steps per call so one request always fits inside the function time limit.
  for (let guard = 0; guard < 2 && s.status === 'building'; guard++) {
    const n = s.step; if (n >= STEPS.length) break;
    if ((Date.now() - started) / 1000 < STEPS[n].at) break;
    const busy = s.last_error === 'running:' + n && Date.now() - Date.parse(s.updated_at) < 180e3;
    if (busy) break;
    const claimed = await db(`sections?key=eq.${s.key}&step=eq.${n}&status=eq.building&updated_at=eq.${encodeURIComponent(s.updated_at)}`, { method: 'PATCH', prefer: 'return=representation', body: { last_error: 'running:' + n, updated_at: now() } });
    if (!claimed || !claimed.length) break;
    let patch = {};
    try { patch = await runStep(claimed[0], n); patch.last_error = null; patch.attempts = 0; patch.step = n + 1; }
    catch (e) {
      const attempts = (claimed[0].attempts || 0) + 1;
      // Retry up to 3 times, then fall back to a safe default so it never gets stuck.
      if (attempts >= 3) { patch = await runStep(claimed[0], n, true); patch.step = n + 1; patch.attempts = 0; patch.last_error = 'fallback:' + clip(e.message, 120); }
      else patch = { attempts, last_error: 'retry:' + clip(e.message, 120) };
    }
    if (patch.step === STEPS.length) { patch.status = 'ready'; patch.ready_at = now(); }
    patch.updated_at = now();
    const r = await db(`sections?key=eq.${s.key}`, { method: 'PATCH', prefer: 'return=representation', body: patch });
    s = r[0];
    if (s.status === 'ready') await onReady(s).catch(() => {});
  }
  return s;
}

async function profileText() {
  try {
    const [p, mem] = await Promise.all([getProfile(), db('memories?select=category,content&order=created_at.desc&limit=25')]);
    let plan = ''; try { const lp = JSON.parse(p.life_plan || 'null'); if (lp) plan = 'Life plan headline: ' + (lp.headline || '') + '. '; } catch (e) {}
    return plan + 'Known about him: ' + mem.map(m => `(${m.category}) ${m.content}`).join(' | ');
  } catch (e) { return ''; }
}
const answersText = s => (s.answers || []).filter(x => x.a).map((x, i) => `Q${i + 1}: ${x.q}\nA: ${x.a}`).join('\n\n');

function fallbackConfig(s) {
  const d = DEFAULTS[s.key], first = (s.answers || []).find(x => x.a);
  return { headline: META[s.key].name + ' · built around your answers', summary: first ? clip('You told me: "' + first.a + '". We start from there and build steadily.', 400) : "We start from where you are and build steadily.",
    goals: (s.answers || []).filter(x => x.a).slice(1, 3).map(x => ({ title: clip(x.a, 120), target: '', by: '' })), metrics: d.metrics, coaching_plan: [{ phase: 'Weeks 1-2', focus: 'Build the habit of dropping things in here' }, { phase: 'Weeks 3-4', focus: 'Spot the first patterns together' }, { phase: 'Month 2', focus: 'Tighten the one thing that moves the needle most' }],
    tone: 'warm, direct, encouraging', look_for: d.look_for, prompts: d.prompts, nudge_rules: ['At most one gentle question a day, only when relevant'], welcome: "Your space is ready. Drop something in whenever you like, and I'll take it from there.", facts: [] };
}

async function runStep(s, n, fallback = false) {
  const brief = sectionBrief(s.key);
  if (n === 0) {
    if (fallback) return { config: fallbackConfig(s) };
    const cfg = await gen([{ text: `You are FREYA, Eesah's personal AI companion (a calm, warm, sharp British-English assistant, like FRIDAY to Tony Stark). He just answered the onboarding questions for his "${META[s.key].name}" section. Design his personalised section.\nSECTION: ${brief}\n\nHIS ANSWERS:\n${answersText(s)}\n\nCONTEXT ABOUT HIM (use lightly, never recite): ${await profileText()}\n\nRules: be specific to his answers (numbers, dates, words he used). Metrics must be things that can actually be logged or read from uploads. Keep everything short. Islamic values matter to him; be respectful. Never shame.` }], CONFIG_SCHEMA, { models: ['gemini-flash-lite-latest', 'gemini-flash-latest'] });
    return { config: { ...fallbackConfig(s), ...cfg } };
  }
  const cfg = s.config || fallbackConfig(s);
  if (n === 1) {
    if (fallback) return {};
    const better = await gen([{ text: `You are reviewing a coaching configuration for Eesah's "${META[s.key].name}" section before it goes live. Make it sharper: goals measurable where possible, 2-5 metrics with clear units (keep keys snake_case and stable if already good), "look_for" concrete, and prompts in a warm British voice. Remove anything generic. Return the same structure.\nSECTION: ${brief}\nHIS ANSWERS:\n${answersText(s)}\nDRAFT:\n${JSON.stringify(cfg)}` }], CONFIG_SCHEMA, { models: ['gemini-flash-latest', 'gemini-flash-lite-latest'], timeout: 25000 });
    return { config: { ...cfg, ...better, metrics: (better.metrics && better.metrics.length ? better.metrics : cfg.metrics).slice(0, 5) } };
  }
  if (n === 2) {
    if (fallback) return {};
    const plan = await gen([{ text: `Write the opening of Eesah's "${META[s.key].name}" space as FREYA. Return: a refined 3-4 phase coaching plan, 5-7 short daily prompts he will see (rotating), ONE first insight for his feed (a single encouraging, specific observation from his answers; no question in it), and ONE first question that follows the QUESTION RULES. No lists of what you know about him.\n${Q_RULES}\nHIS ANSWERS:\n${answersText(s)}\nCONFIG:\n${JSON.stringify({ goals: cfg.goals, metrics: cfg.metrics, tone: cfg.tone })}` }],
      OBJ({ coaching_plan: CONFIG_SCHEMA.properties.coaching_plan, prompts: CONFIG_SCHEMA.properties.prompts, first_insight: S('one or two sentences, an observation, no question'), first_question: S('one question per the QUESTION RULES, or ""') }), { models: ['gemini-flash-lite-latest', 'gemini-flash-latest'] });
    if (plan.first_insight) await db('section_insights', { method: 'POST', body: { section: s.key, kind: 'insight', text: clip(plan.first_insight, 600) } });
    if (plan.first_question) await addQuestion(s.key, plan.first_question).catch(() => {});
    return { config: { ...cfg, coaching_plan: plan.coaching_plan && plan.coaching_plan.length ? plan.coaching_plan : cfg.coaching_plan, prompts: plan.prompts && plan.prompts.length ? plan.prompts : cfg.prompts } };
  }
  if (n === 3) {
    // Final checks: validate shape, remember the durable facts quietly, add the welcome line.
    const c = { ...fallbackConfig(s), ...cfg };
    c.metrics = (c.metrics || []).filter(m => m && m.key && m.label).map(m => ({ ...m, key: String(m.key).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40) })).slice(0, 5);
    if (s.key === 'mind' && !c.metrics.some(m => m.key === 'mood')) c.metrics.unshift({ key: 'mood', label: 'Mood', unit: '/5', direction: 'up', source: 'manual' });
    c.metrics = c.metrics.slice(0, 5);
    for (const f of (c.facts || []).slice(0, 6)) await db('memories', { method: 'POST', body: { category: MEM_CAT[s.key], content: clip(f, 400), source: 'section:' + s.key } }).catch(() => {});
    await db('section_insights', { method: 'POST', body: { section: s.key, kind: 'welcome', text: clip(c.welcome || fallbackConfig(s).welcome, 600) } });
    delete c.facts;
    return { config: c };
  }
  return {};
}

async function onReady(s) {
  const { sendPush } = require('./_life');
  await sendPush({ title: `Your ${META[s.key].name} space is ready`, body: 'I built it around your answers. Tap to step in.', priority: 'high', url: '/?section=' + s.key, tag: 'section-' + s.key }).catch(() => {});
}

// ---------------- Uploads ----------------
const MIMES = { photo: ['image/jpeg', 'image/png', 'image/webp'], video: ['image/jpeg'], file: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain'], chat: ['text/plain'] };
const ext = m => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt' }[m] || 'bin');

async function requireReady(key) { const s = await getSection(key); if (!s || s.status !== 'ready') throw new Error('section_not_ready'); return s; }

async function signUpload(path) {
  const r = await storage(`object/upload/sign/${BUCKET}/${path}`, { method: 'POST', body: {} });
  const j = await r.json();
  return SUPABASE_URL + '/storage/v1' + j.url;
}

async function uploadUrl(b) {
  const key = b.section; const s = await requireReady(key);
  const kind = ['photo', 'video', 'file', 'chat'].includes(b.kind) ? b.kind : 'file';
  const mime = String(b.mime || '');
  if (!MIMES[kind].includes(mime)) return { ok: false, error: 'That file type is not supported here.' };
  const bytes = +b.bytes || 0; if (bytes > 10 * 1024 * 1024) return { ok: false, error: 'Too big. Max 10 MB after compression.' };
  const id = crypto.randomUUID();
  const raw = `${key}/raw/${id}.${ext(mime)}`;
  const keepThumb = key === 'body' && (kind === 'photo' || kind === 'video') && !(s.settings && s.settings.thumbs === false) && b.thumb;
  const thumb = keepThumb ? `${key}/thumbs/${id}.jpg` : null;
  await db('section_items', { method: 'POST', body: { id, section: key, kind, name: clip(b.name, 120) || null, mime, bytes, raw_path: raw, thumb_path: thumb, status: 'uploading', raw_expires_at: new Date(Date.now() + RAW_HOURS * 36e5).toISOString() } });
  return { ok: true, id, upload: await signUpload(raw), thumb_upload: thumb ? await signUpload(thumb) : null };
}

async function addText(b) {
  const key = b.section; await requireReady(key);
  const text = clip(b.text, 200000).trim(); if (!text) return { ok: false, error: 'Nothing to save.' };
  const kind = ['chat', 'text', 'reflection', 'note'].includes(b.kind) ? b.kind : 'text';
  const id = crypto.randomUUID();
  await db('section_items', { method: 'POST', body: { id, section: key, kind, name: clip(b.name, 120) || null, mime: 'text/plain', bytes: text.length, raw_text: text, status: 'pending', raw_expires_at: new Date(Date.now() + RAW_HOURS * 36e5).toISOString() } });
  return analyse(id);
}

async function uploaded(id) {
  const it = (await db(`section_items?select=id,status&id=eq.${encodeURIComponent(id)}`))[0];
  if (!it) return { ok: false, error: 'Upload not found' };
  if (it.status === 'uploading') await db(`section_items?id=eq.${it.id}`, { method: 'PATCH', body: { status: 'pending' } });
  return analyse(id);
}

const ANALYSIS_SCHEMA = OBJ({
  title: S('short title for this item, max 8 words'),
  tags: ARR(S('tag'), '1-5 short lowercase tags'),
  summary: S('1-2 factual sentences on what is actually visible or written, concrete enough that you could describe it later without seeing it again (for photos: setting, pose, clothing, visible physique or food details; for documents: what, who from, amounts, dates). No private details about other people.'),
  insights: ARR(S('one specific, useful coaching insight in second person, max 2 sentences'), '1-3 insights'),
  question: S('ONE question for him that follows the QUESTION RULES, or "" (often "")'),
  metrics: ARR(OBJ({ key: S('metric key from the list'), value: { type: 'NUMBER' } }), 'values for the listed metrics that this item genuinely shows; [] if none'),
  dates: ARR(OBJ({ what: S('what the date is'), date: S('YYYY-MM-DD') }), 'important dates (expiry, renewal, deadline); [] if none'),
  rewrites: ARR(OBJ({ original: S('his original line'), better: S('sharper version in his voice'), why: S('why, briefly') }), 'Connections only: up to 3 of his lines rewritten; [] otherwise')
});

async function analyse(id) {
  const it = (await db(`section_items?select=*&id=eq.${encodeURIComponent(id)}`))[0];
  if (!it) return { ok: false, error: 'not found' };
  if (it.status === 'analysed') return { ok: true, id, status: 'analysed', analysis: it.analysis };
  const s = await getSection(it.section); const c = (s && s.config) || fallbackConfig(s || { key: it.section, answers: [] });
  await db(`section_items?id=eq.${it.id}`, { method: 'PATCH', body: { attempts: (it.attempts || 0) + 1 } });
  try {
    const parts = [];
    let recent = '';
    try { recent = (await db(`section_insights?select=text&section=eq.${it.section}&order=created_at.desc&limit=6`)).map(x => x.text).join(' | '); } catch (e) {}
    let extra = '', asked = '';
    try { asked = (await askedTexts(it.section)).join(' | ') || '(none)'; } catch (e) {}
    if (it.section === 'mind') { try { const { getHabits } = require('./_life'); const hs = await getHabits(); extra = 'His habit and prayer streaks (context only): ' + hs.map(h => `${h.name}: today ${h.today || 'not logged'}, streak ${h.streak}`).join('; '); } catch (e) {} }
    const privacy = it.section === 'connections'
      ? 'PRIVACY: lines marked ME are his; THEM are the other person. Coach HIS side and the conversation flow (pace, balance, who leads). Do not summarise, store or repeat the other person\'s personal details, names, numbers or private content. Refer to them only as "they".'
      : 'Never store names, numbers or private details of other people.';
    parts.push({ text: `You are FREYA, Eesah's personal AI coach, analysing one thing he dropped into his "${META[it.section].name}" space.\nSECTION: ${sectionBrief(it.section)}\nHIS GOALS: ${JSON.stringify(c.goals || [])}\nMETRICS (use these keys only): ${JSON.stringify((c.metrics || []).map(m => ({ key: m.key, label: m.label, unit: m.unit })))}\nLOOK FOR: ${(c.look_for || []).join('; ')}\nTONE: ${c.tone || 'warm, direct'}\nRECENT INSIGHTS (avoid repeating): ${recent}\n${Q_RULES}\nALREADY ASKED: ${asked}\n${extra}\n${privacy}\nItem kind: ${it.kind}${it.kind === 'video' ? ' (6 keyframes from a video, left to right, top to bottom)' : ''}. Name: ${it.name || ''}. Be specific and kind; never shame. British English.` });
    if (it.raw_text) parts.push({ text: '\nITEM TEXT:\n' + it.raw_text.slice(-60000) });
    else if (it.raw_path) {
      const r = await storage(`object/${BUCKET}/${it.raw_path}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (it.mime === 'text/plain') parts.push({ text: '\nITEM TEXT:\n' + buf.toString('utf8').slice(-60000) });
      else parts.push({ inlineData: { mimeType: it.mime, data: buf.toString('base64') } });
    } else throw new Error('raw_gone');
    const a = await gen(parts, ANALYSIS_SCHEMA, { models: ['gemini-flash-lite-latest', 'gemini-flash-latest'], timeout: 25000, temperature: 0.4 });
    const analysis = { title: clip(a.title, 80), tags: (a.tags || []).slice(0, 5).map(t => clip(t, 24).toLowerCase()), summary: clip(a.summary, 400), dates: (a.dates || []).slice(0, 5), rewrites: (a.rewrites || []).slice(0, 3) };
    for (const t of (a.insights || []).slice(0, 3)) await db('section_insights', { method: 'POST', body: { section: it.section, item_id: it.id, kind: 'insight', text: clip(t, 600), data: analysis.rewrites.length && it.section === 'connections' ? { rewrites: analysis.rewrites } : null } });
    if (a.question) await addQuestion(it.section, a.question, it.id).catch(() => {});
    const keys = new Set((c.metrics || []).map(m => m.key)), units = Object.fromEntries((c.metrics || []).map(m => [m.key, m.unit]));
    for (const m of (a.metrics || []).filter(m => keys.has(m.key) && isFinite(m.value)).slice(0, 6)) await db('section_metrics', { method: 'POST', body: { section: it.section, key: m.key, value: m.value, unit: units[m.key] || null, item_id: it.id } });
    await db(`section_items?id=eq.${it.id}`, { method: 'PATCH', body: { status: 'analysed', analysis } });
    return { ok: true, id: it.id, status: 'analysed', analysis, insights: a.insights || [], question: a.question || '' };
  } catch (e) {
    const failed = (it.attempts || 0) + 1 >= 3;
    await db(`section_items?id=eq.${it.id}`, { method: 'PATCH', body: { status: failed ? 'failed' : 'pending' } }).catch(() => {});
    return { ok: false, id: it.id, status: failed ? 'failed' : 'pending', error: failed ? "I couldn't read that one. Try a clearer photo or a smaller file." : "Still working on that, I'll finish it in the background." };
  }
}

// ---------------- Tools ----------------
async function logMetric(b) {
  const s = await requireReady(b.section); const m = ((s.config && s.config.metrics) || []).find(x => x.key === b.key);
  const v = +b.value; if (!m || !isFinite(v)) return { ok: false, error: 'Unknown metric or value' };
  await db('section_metrics', { method: 'POST', body: { section: b.section, key: m.key, value: v, unit: m.unit || null } });
  return { ok: true };
}

async function thumbs(key) {
  const items = await db(`section_items?select=id,created_at,thumb_path,analysis&section=eq.${key}&thumb_path=not.is.null&order=created_at.asc&limit=200`);
  if (!items.length) return { ok: true, thumbs: [] };
  const r = await storage(`object/sign/${BUCKET}`, { method: 'POST', body: { expiresIn: 3600, paths: items.map(i => i.thumb_path) } });
  const signed = await r.json();
  const url = Object.fromEntries(signed.filter(x => x.signedURL).map(x => [x.path, SUPABASE_URL + '/storage/v1' + x.signedURL]));
  return { ok: true, thumbs: items.filter(i => url[i.thumb_path]).map(i => ({ id: i.id, at: i.created_at, url: url[i.thumb_path], title: i.analysis && i.analysis.title })) };
}

async function compare(b) {
  await requireReady('body');
  const ids = [b.a, b.b].map(String);
  const items = await db(`section_items?select=id,created_at,thumb_path&section=eq.body&id=in.(${ids.map(encodeURIComponent).join(',')})`);
  if (items.length !== 2) return { ok: false, error: 'Pick two progress photos.' };
  items.sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at));
  const imgs = [];
  for (const i of items) { const r = await storage(`object/${BUCKET}/${i.thumb_path}`); imgs.push({ inlineData: { mimeType: 'image/jpeg', data: Buffer.from(await r.arrayBuffer()).toString('base64') } }); }
  const days = Math.round((Date.parse(items[1].created_at) - Date.parse(items[0].created_at)) / 864e5);
  const s = await getSection('body');
  const text = await gen([{ text: `You are FREYA, Eesah's coach. First image = THEN, second = NOW, ${days} days apart. His goals: ${JSON.stringify((s.config && s.config.goals) || [])}. In 2-3 sentences, describe visible, honest changes (posture, waist, shoulders, face, definition) and one encouraging next step. If lighting or angle differ, say so briefly. Never shame.` }, ...imgs], null, { temperature: 0.4 });
  await db('section_insights', { method: 'POST', body: { section: 'body', kind: 'compare', text: clip(text, 800), data: { a: items[0].id, b: items[1].id, days } } });
  return { ok: true, text, days };
}

async function sharpen(b) {
  await requireReady('connections');
  const s = await getSection('connections'); const c = s.config || {};
  const msg = clip(b.text, 2000).trim(); if (!msg) return { ok: false, error: 'Paste the message first.' };
  const r = await gen([{ text: `You are FREYA, Eesah's communication coach. He wants to come across as a calm, confident, warm, high value man with clear intentions and Islamic values. Coaching tone: ${c.tone || 'direct but kind'}. What to watch: ${(c.look_for || []).join('; ')}.\nWho it's to: ${clip(b.to, 80) || 'not said'}. Context: ${clip(b.context, 600) || 'none'}.\nHIS DRAFT MESSAGE:\n${msg}\n\nGive him a sharper version in HIS voice (not robotic, not try-hard, similar length or shorter), a bolder alternative, and up to 3 short notes on what changed and why.` }],
    OBJ({ best: S('sharpened message'), alt: S('alternative version'), notes: ARR(S('short note'), 'up to 3 notes'), score_before: { type: 'NUMBER' }, score_after: { type: 'NUMBER' } }), { temperature: 0.7 });
  return { ok: true, ...r };
}

async function events() {
  const from = new Date().toISOString(), to = new Date(Date.now() + 3 * 864e5).toISOString();
  const ev = await db(`calendar_events?select=id,summary,start_at,end_at,attendees&all_day=eq.false&start_at=gte.${from}&start_at=lte.${to}&order=start_at.asc&limit=8`).catch(() => []);
  return { ok: true, events: ev.map(e => ({ id: e.id, summary: e.summary, start_at: e.start_at, attendees: e.attendees })) };
}

async function prep(b) {
  const s = await requireReady('work'); const c = s.config || {};
  let ev = null;
  if (b.event_id) ev = (await db(`calendar_events?select=id,summary,start_at,end_at,attendees,description&id=eq.${encodeURIComponent(b.event_id)}`).catch(() => db(`calendar_events?select=id,summary,start_at,end_at,attendees&id=eq.${encodeURIComponent(b.event_id)}`).catch(() => [])))[0] || null;
  const what = ev ? `${ev.summary} at ${ev.start_at}${ev.description ? ' — ' + clip(ev.description, 800) : ''}` : clip(b.text, 800);
  if (!what) return { ok: false, error: 'Pick a call or describe it.' };
  const [notes, ins] = await Promise.all([db('meeting_notes?select=summary&order=created_at.desc&limit=4').catch(() => []), db('section_insights?select=text&section=eq.work&order=created_at.desc&limit=8').catch(() => [])]);
  const r = await gen([{ text: `You are FREYA, Eesah's chief of staff (he is COO of JSE Academic). Prep him for this call in a tight, practical way.\nCALL: ${what}\nHIS GOALS: ${JSON.stringify(c.goals || [])}\nRECENT MEETING NOTES: ${notes.map(n => n.summary).join(' | ')}\nRECENT WORK INSIGHTS: ${ins.map(i => i.text).join(' | ')}` }],
    OBJ({ objective: S('the one outcome to aim for'), key_points: ARR(S('point'), '3 points he should land'), questions: ARR(S('question'), '3 sharp questions to ask'), watch_out: S('one risk or trap'), opener: S('a strong first line') }), { temperature: 0.5 });
  await db('section_insights', { method: 'POST', body: { section: 'work', kind: 'prep', text: clip(`Call prep: ${ev ? ev.summary : clip(b.text, 60)} · aim: ${r.objective}`, 600), data: r } });
  return { ok: true, ...r, event: ev && { summary: ev.summary, start_at: ev.start_at } };
}

async function search(b) {
  const q = clip(b.q, 80).trim().replace(/[%*,()]/g, ' '); if (!q) return { ok: true, results: [] };
  const like = encodeURIComponent('*' + q + '*');
  const key = valid(b.section) ? `&section=eq.${b.section}` : '';
  const [items, ins] = await Promise.all([
    db(`section_items?select=id,section,kind,name,analysis,created_at${key}&or=(name.ilike.${like},analysis->>title.ilike.${like},analysis->>summary.ilike.${like},analysis->>tags.ilike.${like})&order=created_at.desc&limit=20`),
    db(`section_insights?select=id,section,kind,text,created_at${key}&text=ilike.${like}&order=created_at.desc&limit=10`)
  ]);
  return { ok: true, results: items.map(i => ({ type: 'item', section: i.section, title: (i.analysis && i.analysis.title) || i.name || i.kind, summary: i.analysis && i.analysis.summary, tags: (i.analysis && i.analysis.tags) || [], dates: (i.analysis && i.analysis.dates) || [], at: i.created_at })).concat(ins.map(i => ({ type: 'insight', section: i.section, title: i.text, at: i.created_at }))) };
}

async function ask(b) {
  const key = b.section; const s = await requireReady(key); const c = s.config || {};
  const q = clip(b.q, 1000).trim(); if (!q) return { ok: false };
  const [ins, mets, items] = await Promise.all([
    db(`section_insights?select=kind,text,created_at&section=eq.${key}&order=created_at.desc&limit=25`),
    db(`section_metrics?select=key,value,unit,at&section=eq.${key}&order=at.desc&limit=40`),
    db(`section_items?select=kind,analysis,created_at&section=eq.${key}&status=eq.analysed&order=created_at.desc&limit=30`)
  ]);
  const hist = (Array.isArray(b.history) ? b.history : []).slice(-6).map(h => `${h.who === 'me' ? 'Eesah' : 'FREYA'}: ${clip(h.text, 400)}`).join('\n');
  const text = await gen([{ text: `You are FREYA, Eesah's calm, warm, sharp AI companion. Answer his question about his "${META[key].name}" space in 1-4 short sentences, British English, specific, no lists unless asked, never recite everything you know.\nSECTION CONFIG: ${JSON.stringify({ headline: c.headline, goals: c.goals, metrics: c.metrics, coaching_plan: c.coaching_plan, tone: c.tone })}\nMETRICS (newest first): ${JSON.stringify(mets)}\nINSIGHTS: ${ins.map(i => `[${i.created_at.slice(0, 10)} ${i.kind}] ${i.text}`).join(' | ')}\nITEMS: ${items.map(i => `[${i.created_at.slice(0, 10)} ${i.kind}] ${i.analysis && i.analysis.title}: ${i.analysis && i.analysis.summary} ${(i.analysis && i.analysis.dates || []).map(d => d.what + ' ' + d.date).join(', ')}`).join(' | ')}\n${hist ? 'CONVERSATION SO FAR:\n' + hist + '\n' : ''}QUESTION: ${q}` }], null, { temperature: 0.5 });
  saveTurns(key, [['user', `(in ${META[key].name}) ${q}`], ['freya', text]], 'ask' + Date.now().toString(36)).catch(() => {});
  return { ok: true, text };
}

async function setSetting(b) {
  const s = await getSection(b.section); if (!s) return { ok: false };
  const settings = { ...(s.settings || {}) };
  if (b.name === 'thumbs') settings.thumbs = !!b.value;
  await db(`sections?key=eq.${s.key}`, { method: 'PATCH', body: { settings, updated_at: now() } });
  if (b.name === 'thumbs' && !b.value && b.purge) {
    const items = await db(`section_items?select=id,thumb_path&section=eq.${s.key}&thumb_path=not.is.null`);
    if (items.length) { await storage(`object/${BUCKET}`, { method: 'DELETE', body: { prefixes: items.map(i => i.thumb_path) } }); await db(`section_items?section=eq.${s.key}&thumb_path=not.is.null`, { method: 'PATCH', body: { thumb_path: null } }); }
  }
  return { ok: true, settings };
}

async function wipe(b) {
  const key = b.section; if (b.confirm !== 'DELETE') return { ok: false, error: 'Confirmation missing' };
  const items = await db(`section_items?select=raw_path,thumb_path&section=eq.${key}`);
  const paths = items.flatMap(i => [i.raw_path, i.thumb_path]).filter(Boolean);
  for (let i = 0; i < paths.length; i += 100) await storage(`object/${BUCKET}`, { method: 'DELETE', body: { prefixes: paths.slice(i, i + 100) } });
  await db(`memories?source=eq.${encodeURIComponent('section:' + key)}`, { method: 'DELETE' }).catch(() => {});
  await db(`sections?key=eq.${key}`, { method: 'DELETE' }); // cascades items, insights, metrics
  return { ok: true };
}

// ---------------- Background (cron) ----------------
// Delete raw files and pasted text after 24h; keep insights (and Body thumbnails unless turned off).
async function sweep() {
  const due = await db(`section_items?select=id,raw_path&raw_expires_at=lt.${now()}&or=(raw_path.not.is.null,raw_text.not.is.null)&limit=200`);
  if (!due.length) return 0;
  const paths = due.map(d => d.raw_path).filter(Boolean);
  if (paths.length) await storage(`object/${BUCKET}`, { method: 'DELETE', body: { prefixes: paths } });
  await db(`section_items?id=in.(${due.map(d => d.id).join(',')})`, { method: 'PATCH', body: { raw_path: null, raw_text: null, raw_deleted_at: now() } });
  return due.length;
}
async function retryPending() {
  const p = await db(`section_items?select=id&status=eq.pending&attempts=lt.3&created_at=lt.${new Date(Date.now() - 90e3).toISOString()}&order=created_at.asc&limit=3`);
  for (const i of p) await analyse(i.id).catch(() => {});
  // Uploads that never finished (phone lost signal): give them 30 min, then treat as uploaded.
  const stale = await db(`section_items?select=id&status=eq.uploading&created_at=lt.${new Date(Date.now() - 30 * 6e4).toISOString()}&limit=5`);
  for (const i of stale) await db(`section_items?id=eq.${i.id}`, { method: 'PATCH', body: { status: 'pending', attempts: 2 } });
  return p.length;
}
// Weekly review (Mondays, folded into the 04:00 re-learn window): one short call per active section.
async function weekly(claim) {
  const ready = await db('sections?select=key,config&status=eq.ready');
  const out = [];
  for (const s of ready) {
    const ins = await db(`section_insights?select=kind,text&section=eq.${s.key}&kind=in.(insight,compare,prep)&created_at=gte.${new Date(Date.now() - 7 * 864e5).toISOString()}&limit=30`);
    if (ins.length < 2) continue;
    if (!(await claim(`section:review:${s.key}:${new Date().toISOString().slice(0, 10)}`))) continue;
    try {
      const mets = await db(`section_metrics?select=key,value,at&section=eq.${s.key}&at=gte.${new Date(Date.now() - 14 * 864e5).toISOString()}&order=at.asc`);
      const t = await gen([{ text: `You are FREYA. Write Eesah's weekly review for his "${META[s.key].name}" space as JSON: "review" is 2-3 sentences with the clearest trend and one win (no question); "question" is ONE question for the week ahead that follows the QUESTION RULES, or "". Goals: ${JSON.stringify((s.config || {}).goals || [])}. This week's insights: ${ins.map(i => i.text).join(' | ')}. Metrics (14 days): ${JSON.stringify(mets)}\n${Q_RULES}\nALREADY ASKED: ${(await askedTexts(s.key)).join(' | ') || '(none)'}` }], OBJ({ review: S('2-3 sentences'), question: S('one question or ""') }), { models: ['gemini-flash-lite-latest', 'gemini-flash-latest'], temperature: 0.5 });
      await db('section_insights', { method: 'POST', body: { section: s.key, kind: 'review', text: clip(t.review || '', 800) } }); out.push(s.key);
      if (t.question) await addQuestion(s.key, t.question).catch(() => {});
    } catch (e) {}
  }
  return out;
}
async function tick(claim, { weeklyNow = false } = {}) {
  const out = {};
  try { const b = await db('sections?select=*&status=eq.building'); for (const s of b) await advance(s); out.building = b.length; } catch (e) { out.build_error = String(e.message).slice(0, 60); }
  try { out.analysed = await retryPending(); } catch (e) {}
  try { out.swept = await sweep(); } catch (e) { out.sweep_error = String(e.message).slice(0, 60); }
  if (weeklyNow && claim) { try { out.reviews = await weekly(claim); } catch (e) {} }
  if (claim) { try { const q = await reviewQuestions(claim); if (q.length) out.questions = q; } catch (e) {} }
  return out;
}

// ---------------- Voice / chat context ----------------
async function context() {
  const all = await db('sections?select=key,status,config');
  if (!all.length) return null;
  const ready = all.filter(s => s.status === 'ready');
  const [ins, items, mets, qs] = ready.length ? await Promise.all([
    db(`section_insights?select=section,kind,text,data,created_at&order=created_at.desc&limit=80`),
    db(`section_items?select=id,section,kind,name,status,analysis,created_at,thumb_path&order=created_at.desc&limit=40`),
    db(`section_metrics?select=section,key,value,unit,at&order=at.desc&limit=120`),
    Promise.resolve(null)
  ]) : [[], [], [], null];
  const day = t => new Date(t).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' });
  return ORDER.map(k => {
    const s = all.find(x => x.key === k); if (!s) return null;
    if (s.status !== 'ready') return { key: k, name: META[k].name, status: s.status };
    const c = s.config || {}, mine = ins.filter(i => i.section === k), latest = {};
    for (const m of mets.filter(m => m.section === k)) if (!latest[m.key]) latest[m.key] = `${+(+m.value).toFixed(1)}${m.unit ? ' ' + m.unit : ''} (${day(m.at)})`;
    return {
      key: k, name: META[k].name, status: 'ready', headline: c.headline, goals: (c.goals || []).map(g => g.title + (g.target ? ' → ' + g.target : '') + (g.by ? ' by ' + g.by : '')).slice(0, 4),
      plan: (c.coaching_plan || [])[0] ? `${c.coaching_plan[0].phase}: ${c.coaching_plan[0].focus}` : null,
      metrics: Object.entries(latest).map(([key, v]) => `${((c.metrics || []).find(m => m.key === key) || {}).label || key} ${v}`),
      uploads: items.filter(i => i.section === k).slice(0, 6).map(i => i.status === 'analysed' && i.analysis ? `${day(i.created_at)} ${i.kind}${i.thumb_path ? ' (photo kept)' : ''}: ${i.analysis.title || ''}. ${i.analysis.summary || ''}${(i.analysis.insights || [])[0] ? ' Your take: ' + i.analysis.insights[0] : ''}` : `${day(i.created_at)} ${i.kind}: still being analysed`),
      latest: mine.filter(i => ['insight', 'review', 'compare', 'note'].includes(i.kind)).slice(0, 3).map(i => i.text),
      open_questions: mine.filter(i => i.kind === 'question' && isOpen(i)).slice(0, QCAP).map(i => i.text),
      answered: mine.filter(i => i.kind === 'question' && i.data && i.data.status === 'answered').slice(0, 3).map(i => `${i.text} → ${i.data.answer}`)
    };
  }).filter(Boolean);
}
// Full detail of one section's uploads, for the voice tool.
async function uploadsFor(key, limit) {
  if (!valid(key)) return { error: 'Unknown section' };
  const n = Math.max(1, Math.min(20, parseInt(limit, 10) || 8));
  const items = await db(`section_items?select=id,kind,name,status,analysis,created_at,thumb_path&section=eq.${key}&order=created_at.desc&limit=${n}`);
  return { section: key, uploads: items.map(i => ({ id: i.id, kind: i.kind, uploaded: i.created_at, status: i.status, photo_available: !!i.thumb_path, title: i.analysis && i.analysis.title, summary: i.analysis && i.analysis.summary, insights: (i.analysis && i.analysis.insights) || [], metrics: (i.analysis && i.analysis.metrics) || [], dates: (i.analysis && i.analysis.dates) || [] })), note: 'These are his real uploads; you have seen and analysed them. Raw files are deleted after 24h; Body progress photos keep a small thumbnail you can look at with look_at_section_photos.' };
}
// Body progress thumbnails as images for the live session to look at (small, server-fetched, oldest first).
async function photos(count) {
  const n = Math.max(1, Math.min(6, parseInt(count, 10) || 4));
  const items = (await db(`section_items?select=id,created_at,thumb_path,analysis&section=eq.body&thumb_path=not.is.null&order=created_at.desc&limit=${n}`)).reverse();
  const out = [];
  for (const i of items) { try { const r = await storage(`object/${BUCKET}/${i.thumb_path}`); out.push({ id: i.id, at: i.created_at, title: i.analysis && i.analysis.title, summary: i.analysis && i.analysis.summary, data: Buffer.from(await r.arrayBuffer()).toString('base64') }); } catch (e) {} }
  return { ok: true, photos: out };
}
// From a conversation with the main Freya into the section: a metric he states, a note, or an answer to an open question.
async function fromChat(b) {
  const key = b.section, s = await requireReady(key), c = s.config || {}, out = { ok: true };
  if (b.metric != null && b.value != null) {
    const want = String(b.metric).toLowerCase(), m = (c.metrics || []).find(x => x.key === want || String(x.label || '').toLowerCase() === want) || (c.metrics || []).find(x => x.key.includes(want) || want.includes(x.key) || String(x.label || '').toLowerCase().includes(want));
    const v = +b.value;
    if (m && isFinite(v)) { await db('section_metrics', { method: 'POST', body: { section: key, key: m.key, value: v, unit: m.unit || null } }); out.logged = `${m.label} ${v}${m.unit ? ' ' + m.unit : ''}`; }
    else out.metric_error = 'No matching metric. Tracked: ' + (c.metrics || []).map(x => x.label + ' (' + x.key + ')').join(', ');
  }
  if (b.note) { await db('section_insights', { method: 'POST', body: { section: key, kind: 'note', text: clip('From our chat: ' + String(b.note), 600) } }); out.noted = true; }
  if (b.question && b.answer) {
    const qs = await db(`section_insights?select=id,text,data&section=eq.${key}&kind=eq.question&order=created_at.desc&limit=20`);
    const q = qs.filter(isOpen).find(x => similar(x.text, b.question) || String(x.id) === String(b.question));
    if (q) { const r = await answer({ section: key, id: q.id, answer: b.answer }); out.answered = r.ok; out.reply = r.reply; }
  }
  return out;
}
async function insightsFor(key) {
  if (!valid(key)) return { error: 'Unknown section' };
  const s = await getSection(key); if (!s) return { status: 'locked', note: 'He has not set this section up yet. If relevant, tell him he can open it from the tiles under the orb.' };
  if (s.status !== 'ready') return { status: s.status };
  const [ins, mets, qs] = await Promise.all([db(`section_insights?select=kind,text,created_at&section=eq.${key}&kind=neq.question&order=created_at.desc&limit=12`), db(`section_metrics?select=key,value,unit,at&section=eq.${key}&order=at.desc&limit=20`), db(`section_insights?select=text,data,created_at&section=eq.${key}&kind=eq.question&order=created_at.desc&limit=30`)]);
  const c = s.config || {};
  return { status: 'ready', headline: c.headline, goals: c.goals, coaching_plan: c.coaching_plan, insights: ins, metrics: mets,
    open_questions: qs.filter(isOpen).slice(0, QCAP).map(q => q.text), answered: qs.filter(q => q.data && q.data.status === 'answered').slice(0, 10).map(q => ({ q: q.text, a: q.data.answer, when: q.data.answered_at })) };
}

// ---------------- Questions he can answer ----------------
const QCAP = 3;
const Q_RULES = `QUESTION RULES: only ask if the answer gives you data or a decision that sharpens your coaching: a number to log (say the unit), a day or date to commit to, a choice between options, or a missing fact you need. One sentence, max 22 words, answerable in a few words. Good: "What's your weight today, so I can log it against this photo?", "Which day this week works for your next progress photo?". Never ask how something felt or made him feel (in Mind & Deen only when it genuinely helps). Never repeat or rephrase anything under ALREADY ASKED. If nothing useful, return "".`;
const isOpen = q => !q.data || !q.data.status || q.data.status === 'open';
const STOP = new Set('the and you your what which how when did does are was were for with this that today exact many much will from have can its into just about current currently morning now right tonight week yesterday last next log let know please'.split(' '));
const words = t => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
const similar = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return false; let n = 0; A.forEach(w => { if (B.has(w)) n++; }); return n / Math.min(A.size, B.size) >= 0.6; };
async function askedTexts(key) { return (await db(`section_insights?select=text&section=eq.${key}&kind=eq.question&order=created_at.desc&limit=40`)).map(q => q.text); }
async function addQuestion(key, text, itemId) {
  text = clip(String(text || ''), 300).trim().replace(/^["']|["']$/g, '');
  if (text.length < 8 || !/\?$/.test(text)) return null;
  const all = await db(`section_insights?select=id,text,data,created_at&section=eq.${key}&kind=eq.question&order=created_at.desc&limit=60`);
  if (all.some(q => similar(q.text, text))) return null;
  const open = all.filter(isOpen).reverse();
  while (open.length >= QCAP) { const o = open.shift(); await db(`section_insights?id=eq.${o.id}`, { method: 'PATCH', body: { data: { ...(o.data || {}), status: 'expired' } } }); }
  const r = await db('section_insights', { method: 'POST', prefer: 'return=representation', body: { section: key, item_id: itemId || null, kind: 'question', text, data: { status: 'open' } } });
  return r && r[0];
}
function saveTurns(key, pairs, tag) {
  const CV = require('./_convo'), day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return CV.addTurns({ session: `sec-${key}-${day}`, mode: 'section', turns: pairs.map(([role, text], i) => ({ cid: `${tag}.${i}`, role, text })) });
}
const ANSWER_SCHEMA = OBJ({
  reply: S('1-3 short sentences reacting to his answer: acknowledge it specifically, then one concrete next step or coaching point. Warm, direct, British English. No question unless essential.'),
  metrics: ARR(OBJ({ key: S('metric key from the list'), value: { type: 'NUMBER' } }), 'values he stated for the listed metrics (convert units if needed); [] if none'),
  facts: ARR(S('durable fact about Eesah from his answer, third person, specific, max 25 words'), '0-3 facts; [] if none'),
  follow_up: S('usually "". Only if his answer opens something genuinely useful: ONE question per the QUESTION RULES')
});
async function answer(b) {
  const key = b.section, s = await requireReady(key), c = s.config || {};
  const q = (await db(`section_insights?select=id,text,data,kind&id=eq.${encodeURIComponent(+b.id || 0)}&section=eq.${key}`))[0];
  if (!q || q.kind !== 'question') return { ok: false, error: 'Question not found' };
  const ans = clip(String(b.answer || ''), 2000).trim(); if (!ans) return { ok: false, error: 'Type an answer first' };
  if (q.data && q.data.status === 'answered') return { ok: true, reply: q.data.reply, already: true };
  const [mets, ins] = await Promise.all([db(`section_metrics?select=key,value,unit,at&section=eq.${key}&order=at.desc&limit=12`), db(`section_insights?select=text&section=eq.${key}&kind=neq.question&order=created_at.desc&limit=6`)]);
  let r;
  try {
    r = await gen([{ text: `You are FREYA, Eesah's calm, warm, sharp AI coach, in his "${META[key].name}" space. You asked him a question and he answered. React briefly and learn from it.\nSECTION: ${sectionBrief(key)}\nGOALS: ${JSON.stringify(c.goals || [])}\nMETRICS (use these keys only): ${JSON.stringify((c.metrics || []).map(m => ({ key: m.key, label: m.label, unit: m.unit })))}\nRECENT METRICS: ${JSON.stringify(mets)}\nRECENT INSIGHTS: ${ins.map(i => i.text).join(' | ')}\n${Q_RULES}\nALREADY ASKED: ${(await askedTexts(key)).join(' | ')}\nYOUR QUESTION: ${q.text}\nHIS ANSWER: ${ans}` }], ANSWER_SCHEMA, { models: ['gemini-flash-lite-latest', 'gemini-flash-latest'], temperature: 0.4 });
  } catch (e) { r = { reply: 'Got it, noted. I’ll factor that in.', metrics: [], facts: [], follow_up: '' }; }
  const logged = [];
  for (const m of (r.metrics || []).slice(0, 4)) {
    const def = (c.metrics || []).find(x => x.key === m.key); const v = +m.value;
    if (!def || !isFinite(v)) continue;
    await db('section_metrics', { method: 'POST', body: { section: key, key: def.key, value: v, unit: def.unit || null } }).catch(() => {}); logged.push({ key: def.key, label: def.label, value: v, unit: def.unit || '' });
  }
  let facts = 0;
  for (const f of (r.facts || []).slice(0, 3)) { const t = clip(String(f || ''), 400).trim(); if (!t) continue; await db('memories', { method: 'POST', body: { category: MEM_CAT[key], content: t, source: 'section:' + key } }).catch(() => {}); facts++; }
  const reply = clip(String(r.reply || 'Noted.'), 600);
  await db(`section_insights?id=eq.${q.id}`, { method: 'PATCH', body: { data: { ...(q.data || {}), status: 'answered', answer: ans, reply, answered_at: now() } } });
  await saveTurns(key, [['freya', q.text], ['user', ans], ['freya', reply]], 'q' + q.id).catch(() => {});
  let follow = null; if (r.follow_up) follow = await addQuestion(key, r.follow_up).catch(() => null);
  return { ok: true, reply, logged, facts, follow_up: follow ? { id: follow.id, text: follow.text, at: follow.created_at } : null };
}
async function dismiss(b) {
  const q = (await db(`section_insights?select=id,data,kind&id=eq.${encodeURIComponent(+b.id || 0)}&section=eq.${b.section}`))[0];
  if (!q || q.kind !== 'question') return { ok: false, error: 'Question not found' };
  await db(`section_insights?id=eq.${q.id}`, { method: 'PATCH', body: { data: { ...(q.data || {}), status: b.why === 'irrelevant' ? 'irrelevant' : 'skipped', dismissed_at: now() } } });
  return { ok: true };
}
// One-off quality pass over older questions (before answerable questions existed): keep, rewrite or retire. Never touches insights.
async function reviewQuestions(claim) {
  const ready = await db('sections?select=key,config&status=eq.ready'); const out = [];
  for (const s of ready) {
    const legacy = (await db(`section_insights?select=id,text,data&section=eq.${s.key}&kind=eq.question&order=created_at.asc&limit=60`)).filter(q => !q.data || !q.data.status).slice(0, 20);
    if (!legacy.length) continue;
    if (claim && !(await claim(`secq:review:v1:${s.key}`).catch(() => false))) continue;
    let plan = [];
    try {
      plan = (await gen([{ text: `You are FREYA reviewing questions you previously asked Eesah in his "${META[s.key].name}" space, which he could not answer yet. For each, decide: "keep" if it already follows the rules, "rewrite" into one sharp question that follows the rules (put it in "text"), or "retire" if it's fluffy, vague or not worth asking. Keep at most ${QCAP} in total.\n${Q_RULES}\nGOALS: ${JSON.stringify((s.config || {}).goals || [])}\nQUESTIONS:\n${legacy.map(q => `${q.id}: ${q.text}`).join('\n')}` }], { type: 'OBJECT', properties: { items: ARR(OBJ({ id: S('question id'), action: { type: 'STRING', enum: ['keep', 'rewrite', 'retire'] }, text: S('rewritten question, or ""') }), 'one per question') }, required: ['items'] }, { models: ['gemini-flash-lite-latest', 'gemini-flash-latest'], temperature: 0.3 })).items || [];
    } catch (e) { plan = null; }
    if (!Array.isArray(plan) || !plan.length) { out.push(s.key + ':skipped'); continue; } // never retire his questions on a model failure
    let kept = 0;
    for (const q of legacy) {
      const p = plan.find(x => String(x.id) === String(q.id)) || { action: 'retire' };
      const keep = p.action !== 'retire' && kept < QCAP && (p.action === 'keep' || (p.text && /\?$/.test(p.text.trim())));
      if (keep) kept++;
      const body = keep ? { data: { status: 'open', ...(p.action === 'rewrite' ? { orig: q.text } : {}) }, ...(p.action === 'rewrite' ? { text: clip(p.text.trim(), 300) } : {}) } : { data: { status: 'retired', orig: q.text } };
      await db(`section_insights?id=eq.${q.id}`, { method: 'PATCH', body });
    }
    out.push(s.key + ':' + kept + '/' + legacy.length);
  }
  return out;
}

// ---------------- Router (called from /api/state) ----------------
async function handle(req, b) {
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q.sec === 'all') return overview();
    if (q.sec === 'thumbs') return thumbs('body');
    if (q.sec === 'events') return events();
    if (q.sec === 'insights') return insightsFor(q.section);
    if (q.sec === 'uploads') return uploadsFor(q.section, q.limit);
    if (q.sec === 'photos') return photos(q.count);
    if (valid(q.sec)) return detail(q.sec);
    return { error: 'Unknown section' };
  }
  const key = b.section;
  if (b.action === 'sec_answer' || b.action === 'sec_dismiss' || b.action === 'sec_from_chat') { if (!valid(key)) return { ok: false, error: 'Unknown section' }; }
  if (b.action !== 'sec_search' && !valid(key) && !['sec_prep', 'sec_sharpen', 'sec_compare'].includes(b.action)) return { ok: false, error: 'Unknown section' };
  switch (b.action) {
    case 'sec_answers': return saveAnswers(key, b.answers, !!b.finish);
    case 'sec_upload_url': return uploadUrl(b);
    case 'sec_uploaded': return uploaded(String(b.id || ''));
    case 'sec_text': return addText(b);
    case 'sec_metric': return logMetric(b);
    case 'sec_compare': return compare(b);
    case 'sec_sharpen': return sharpen(b);
    case 'sec_prep': return prep(b);
    case 'sec_search': return search(b);
    case 'sec_ask': return ask(b);
    case 'sec_answer': return answer(b);
    case 'sec_dismiss': return dismiss(b);
    case 'sec_from_chat': return fromChat(b);
    case 'sec_setting': return setSetting(b);
    case 'sec_wipe': return wipe(b);
    default: return { ok: false, error: 'Unknown action' };
  }
}

module.exports = { handle, tick, context, insightsFor, advance, analyse, sweep, gen, addQuestion, reviewQuestions, META, ORDER, STEPS, BUILD_SECONDS, _test: { fallbackConfig, runStep } };
