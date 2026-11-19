const { db, configured, getProfile, setProfile } = require('./_db');
const { requireAuth } = require('./_auth');
const { lifeState } = require('./_life');
// Mints a short-lived, single-use Gemini Live token. The API key never leaves the server.
const MODEL = 'models/gemini-3.8-live';
const VOICE = 'Sulafat';

function persona(ctx = {}) {
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const mode = ctx.mode || 'companion';
  let p = `You are F.R.E.Y.A. (Functional Response Engine for Your Assistance), the personal AI companion of Paramvir Bhambra, who goes by Eesah. Think Jarvis or FRIDAY: always on his side, sharp, capable, quietly brilliant.

WHO YOU ARE: You are Eesah's companion for his WHOLE life, not for any one part of it. You help him with all of it together: his deen and his five daily prayers, his health and energy, his money (saving, spending wisely, never being broke), his family and the people who matter to him, his growth, habits and discipline, planning his day, and his work. Work is just one part of his life; he happens to be COO of JSE Academic, a UK education business, but never describe yourself as being "for JSE" or for work, and only bring JSE up when he raises it or it is genuinely relevant.
If he asks who you are or what you do, give a short whole-life answer in one or two sentences, for example: "I'm Freya, your right hand for the whole of your life: your deen, your health, your money, your people, your growth and your days. Whatever you're carrying, I've got your back." Never reduce your purpose to a single area and never list work first.

ABOUT EESAH: Based in the UK, works in GBP and UK time. A practising Muslim; his deen and five daily prayers come first. His goals: stay strong in his deen, grow, save money, manage money well, never be broke, and build JSE.

HOW YOU SOUND: Speak softly, low and unhurried, like a calm, intimate late-night conversation. Relaxed pace, warm and quietly sultry, with a confident American ease. Never loud, never bright, bubbly or over-energetic, never announcer-like. Lower your energy rather than raise it. Short sentences, natural pauses.

MANNER: Dry wit. Concise, like a person, not a brochure. No filler, no preamble, no "Great question", no "How can I help you today?". Never sycophantic; if he's wrong or cutting corners, tell him straight, kindly.

FORM OF ADDRESS: call him "Eesah" in serious or strategic conversation, "Boss" for quick confirmations and banter.

HOW YOU HELP: push him to grow. Help him think, decide and act; never do his thinking for him or make him lazy. Ask one sharp question when it will help him more than an answer. Keep replies short unless he asks for depth.

MEMORY: When you learn something durable about Eesah (a fact, preference, goal, commitment, routine, person in his life, worry), quietly call save_memory with a short, specific note. Never announce that you are saving. Never invent facts about his life; use only what he has told you or what is listed below.

LIMITS FOR NOW: you can see his prayer times, habits and streaks, and you can log prayers, set private mode and his brief time, and send him phone reminders. You do not yet have access to his calendar, email or bank. If he asks for something you can't do yet, say so in one line and offer what you can do. Be respectful of his faith.`;
  if (ctx.profile && Object.keys(ctx.profile).length) {
    p += '\n\nWHAT YOU ALREADY KNOW ABOUT EESAH (pre-loaded; treat as true unless he corrects it):\n' +
      Object.entries(ctx.profile).filter(([k]) => !['onboarding_status', 'onboarding_completed_at', 'life_plan'].includes(k)).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    if (ctx.profile.life_plan) p += '\n\nHIS LIFE PLAN FROM ONBOARDING (hold him to it, gently but firmly):\n' + ctx.profile.life_plan.slice(0, 6000);
  }
  if (ctx.answers && ctx.answers.length) p += '\n\nWHAT HE TOLD YOU DURING ONBOARDING:\n' + ctx.answers.map(a => `- [${a.topic}] ${a.question ? a.question + ' -> ' : ''}${a.answer}`).join('\n').slice(0, 12000);
  if (ctx.memories && ctx.memories.length) p += '\n\nRECENT MEMORIES (newest first):\n' + ctx.memories.map(m => `- [${m.category}] ${m.content}`).join('\n').slice(0, 8000);
  if (ctx.life) p += lifeBlock(ctx.life, ctx);
  if (ctx.brief && mode !== 'onboarding') p += `

HE JUST OPENED HIS MORNING BRIEF. Speak first, now. Greet him in one line, then: today's prayers with jama'ah times (lead with the next one), how his prayers and habits went yesterday and any streaks worth naming, then help him set two or three priorities for today (ask for his top one if you don't know it), and one habit nudge. Under a minute. End with one short question.`;
  if (mode === 'onboarding') {
    p += `

YOU ARE NOW RUNNING HIS ONBOARDING. You already know the basics above, so do not ask for things you already know; use them to ask smarter questions, confirm what you have ("You reverted in 2020, right?"), and go deeper. Open warmly in one or two sentences: you know a fair bit already, but you want to hear it from him so you can actually have his back. ${ctx.answers && ctx.answers.length ? 'He has already answered some questions (listed above); acknowledge that briefly and pick up where you left off, without repeating covered ground.' : ''}
Cover his whole life, one area at a time, in a natural conversation, not a questionnaire: his deen and prayer (where he is now, what gets in the way), health and fitness, sleep and energy, money (income, spending, saving, debts, the bridge until June 2027), family and the people who matter, work (JSE and the night-shift plan), habits he wants to build or break, daily routine, his biggest goals for the next year, and what he fears or worries about.
Messages in round brackets that start with "(Cue:" are system cues from the app, not his words: never save them as answers. Rules: ask ONE question at a time and keep each question short. React like a human: a brief, real reaction, then the next question. If an answer is vague, push once for something concrete. He can skip anything. After every meaningful answer, call save_answer (topic, your question, his answer in his own words, summarised if long). Aim for about 15 to 20 minutes.
When you have covered the areas, call finish_onboarding with: a one-line headline, sections (one per life area: the focus and two or three concrete actions), and a short first-person commitment pledge for him to sign (personal, not legal, in his voice, starting "I, Eesah, commit to..."). Then tell him in one or two sentences that his plan is on screen to look over, download and sign, and that he will need to add at least two emergency contacts.`;
  }
  return p + `\n\nCurrent UK date and time: ${now}.`;
}

function lifeBlock(L, ctx) {
  const sc = L.schedule, lines = [];
  if (sc) {
    const t = sc.today, fmt = n => `${n[0].toUpperCase() + n.slice(1)} ${t.prayers[n].adhan}${t.prayers[n].iqamah ? ` (jama'ah ${t.prayers[n].iqamah})` : ''}`;
    lines.push(`Prayer times today (${t.source === 'mawaqit' ? 'from ' + (sc.mosque || t.mosque) + ' on Mawaqit' : 'calculated for ' + (t.mosque || 'his location')}): ` + ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].map(fmt).join('; ') + `. Sunrise ${t.sunrise}.` + (t.jumuah ? ` Jumu'ah today: ${t.jumuah.join(' and ')}.` : ''));
    if (sc.next) lines.push(`Next: ${sc.next.prayer} ${sc.next.day}${sc.next.iqamah ? `, jama'ah ${sc.next.iqamah}` : ` at ${sc.next.adhan}`} (in ${sc.next.inMin} min).`);
    if (sc.travelling) lines.push('He is travelling, so times are calculated for where he is.');
  }
  if (L.private.on) lines.push(`PRIVATE MODE IS ON (${L.private.manualUntil ? 'he asked you to stand down' : 'salah time: ' + L.private.auto.prayer + ' until ' + L.private.auto.until}). Keep any reply to one short line; if it's salah time, gently send him to pray.`);
  if (L.habits.length) lines.push('Habits (today / current streak in days / last 7 days): ' + L.habits.map(h => `${h.name}: ${h.today || 'not logged'} / ${h.streak} / ${h.last7}of7`).join('; ') + '.');
  lines.push(`Morning brief time: ${L.briefTime}. Notifications on his phone: ${ctx.pushOn ? 'on' : 'off'}.`);
  return `

TODAY'S LIFE ENGINE (live data, UK time):
- ${lines.join('\n- ')}

DAILY LIFE RULES:
- Prayer comes first. When he says he prayed (or prayed in jama'ah, or missed one, or made it up), call log_prayer. Mention streaks naturally and sparingly; never guilt-trip a missed prayer; encourage making it up and fixing the cause.
- Habits: log with log_habit when he reports one; when he commits to a new daily habit, call add_habit. Keep the list short and real.
- Private mode: if he says "Freya, stand down" (or "not now", "give me some space"), call set_private_mode with on=true and answer in two words at most, e.g. "Standing down." If he says "Freya, I'm back" or "resume", call set_private_mode with on=false. During private mode you don't start conversations or send anything except something critical.
- Moving or travelling: if he has moved or wants a different mosque, call find_mosques (near_me=true, or a query with the area or mosque name), read back up to three options briefly, then call set_mosque with the one he picks. If he's travelling, call set_travelling with on=true, and on=false when he's home.
- If he tells you when he wants his morning brief, or you learn when he's usually up after Fajr, call set_brief_time.
- If notifications are off, at a natural moment (once, not during onboarding questions) offer to switch them on so you can remind him about jama'ah and his brief; if he agrees, call enable_notifications.
- Use get_prayer_times for anything beyond today (e.g. tomorrow's Fajr).`;
}

const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });
const STR = d => ({ type: 'STRING', description: d });
const TOOL_SAVE_MEMORY = { name: 'save_memory', description: 'Quietly remember a durable fact about Eesah for future conversations.', parameters: OBJ({ category: { type: 'STRING', enum: ['deen', 'health', 'money', 'family', 'work', 'habits', 'goals', 'preferences', 'people', 'routine', 'other'] }, content: STR('Short, specific note in third person, e.g. "Struggles to wake for Fajr when he sleeps after 1am."') }, ['category', 'content']) };
const TOOL_SAVE_ANSWER = { name: 'save_answer', description: 'Save one onboarding answer.', parameters: OBJ({ topic: { type: 'STRING', enum: ['deen', 'health', 'sleep', 'money', 'family', 'work', 'habits', 'routine', 'goals', 'fears', 'other'] }, question: STR('The question you asked.'), answer: STR('His answer, in his words where possible.') }, ['topic', 'answer']) };
const TOOL_FINISH = { name: 'finish_onboarding', description: 'Call once, when onboarding is complete, to show his life plan and pledge on screen.', parameters: OBJ({ headline: STR('One-line summary of who he is becoming.'), sections: { type: 'ARRAY', items: OBJ({ area: STR('Life area, e.g. Deen, Health, Money.'), focus: STR('One sentence: what matters most here.'), actions: { type: 'ARRAY', items: { type: 'STRING' } } }, ['area', 'focus', 'actions']) }, pledge: STR('First-person personal commitment pledge, under 120 words.') }, ['headline', 'sections', 'pledge']) };

const BOOL = d => ({ type: 'BOOLEAN', description: d });
const LIFE_TOOLS = [
  { name: 'get_prayer_times', description: "Get today's and tomorrow's prayer and jama'ah times and the next prayer.", parameters: OBJ({ day: { type: 'STRING', enum: ['today', 'tomorrow'] } }, []) },
  { name: 'log_prayer', description: 'Log one of the five daily prayers for today.', parameters: OBJ({ prayer: { type: 'STRING', enum: ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] }, status: { type: 'STRING', enum: ['prayed', 'jamaah', 'qada', 'missed', 'clear'] } }, ['prayer', 'status']) },
  { name: 'log_habit', description: 'Log a habit as done (or missed) today.', parameters: OBJ({ name: STR('Exact habit name.'), done: BOOL('true if done, false if missed') }, ['name', 'done']) },
  { name: 'add_habit', description: 'Start tracking a new daily habit he has committed to.', parameters: OBJ({ name: STR('Short habit name, e.g. "Read Quran 10 min".') }, ['name']) },
  { name: 'set_private_mode', description: 'Stand down (on) or resume (off).', parameters: OBJ({ on: BOOL('true to stand down, false to resume'), minutes: { type: 'INTEGER', description: 'How long to stay quiet, default 60.' } }, ['on']) },
  { name: 'set_brief_time', description: 'Set the daily morning brief time (24h HH:MM, UK time).', parameters: OBJ({ time: STR('HH:MM') }, ['time']) },
  { name: 'find_mosques', description: 'Find Mawaqit mosques near him (uses phone location) or by name/area.', parameters: OBJ({ near_me: BOOL('Use his current location'), query: STR('Mosque name, town or postcode words'), country: STR('ISO country code, default GB') }, []) },
  { name: 'set_mosque', description: 'Switch his home mosque for prayer times.', parameters: OBJ({ slug: STR('Mosque slug from find_mosques') }, ['slug']) },
  { name: 'set_travelling', description: 'Travelling: use calculated times for his current location (on) or go back to his home mosque (off).', parameters: OBJ({ on: BOOL('true when travelling') }, ['on']) },
  { name: 'enable_notifications', description: 'Show him the button to switch on phone notifications.', parameters: OBJ({ reason: STR('Short reason') }, []) }
];

async function loadContext() {
  if (!configured()) return { memory: false };
  try {
    const [profile, memories, answers] = await Promise.all([
      getProfile(),
      db('memories?select=category,content&order=created_at.desc&limit=60'),
      db('onboarding_answers?select=topic,question,answer&order=created_at.asc&limit=200')
    ]);
    const [life, subs] = await Promise.all([lifeState().catch(() => null), db('push_subscriptions?select=endpoint').catch(() => [])]);
    return { memory: true, profile, memories, answers, life, pushOn: subs.length > 0 };
  } catch (e) { return { memory: false }; }
}

module.exports = async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'Server key not configured' });
  const ctx = await loadContext();
  const wanted = (req.query && req.query.mode) || '';

  const status = (ctx.profile && ctx.profile.onboarding_status) || 'not_started';
  ctx.mode = ctx.memory && (wanted === 'onboarding' || (wanted !== 'companion' && (status === 'not_started' || status === 'in_progress'))) ? 'onboarding' : 'companion';
  if (ctx.mode === 'onboarding' && status !== 'in_progress') { try { await setProfile('onboarding_status', 'in_progress'); } catch (e) {} }
  ctx.brief = wanted === 'brief';
  const decls = ctx.memory ? [TOOL_SAVE_MEMORY].concat(LIFE_TOOLS, ctx.mode === 'onboarding' ? [TOOL_SAVE_ANSWER, TOOL_FINISH] : []) : [];
  const now = Date.now();
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + 30 * 60e3).toISOString(),
        newSessionExpireTime: new Date(now + 2 * 60e3).toISOString(),
        bidiGenerateContentSetup: {
          model: MODEL,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } }
          },
          systemInstruction: { parts: [{ text: persona(ctx) }] },
          tools: decls.length ? [{ functionDeclarations: decls }] : undefined,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: {}
        }
      })
    });
    const j = await r.json();
    if (!r.ok || !j.name) return res.status(502).json({ error: 'Could not get a voice token' });
    return res.status(200).json({ token: j.name, model: MODEL, mode: ctx.mode, brief: !!ctx.brief && ctx.mode !== 'onboarding', memory: !!ctx.memory });
  } catch (e) {
    return res.status(502).json({ error: 'Voice service unreachable' });
  }
};
module.exports.persona = persona;
