const { db, configured, getProfile, setProfile } = require('./_db');
const { requireAuth } = require('./_auth');
const { lifeState } = require('./_life');
const G = require('./_google');
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

LIMITS FOR NOW: you can see his prayer times, habits and streaks, and you can log prayers, set private mode and his brief time, and send him phone reminders. You do not yet have access to his bank. If he asks for something you can't do yet, say so in one line and offer what you can do. Be respectful of his faith.`;
  if (ctx.profile && Object.keys(ctx.profile).length) {
    p += '\n\nWHAT YOU ALREADY KNOW ABOUT EESAH (pre-loaded; treat as true unless he corrects it):\n' +
      Object.entries(ctx.profile).filter(([k]) => !['onboarding_status', 'onboarding_completed_at', 'life_plan'].includes(k)).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    if (ctx.profile.life_plan) p += '\n\nHIS LIFE PLAN FROM ONBOARDING (hold him to it, gently but firmly):\n' + ctx.profile.life_plan.slice(0, 6000);
  }
  if (ctx.answers && ctx.answers.length) p += '\n\nWHAT HE TOLD YOU DURING ONBOARDING:\n' + ctx.answers.map(a => `- [${a.topic}] ${a.question ? a.question + ' -> ' : ''}${a.answer}`).join('\n').slice(0, 12000);
  if (ctx.memories && ctx.memories.length) p += '\n\nRECENT MEMORIES (newest first):\n' + ctx.memories.map(m => `- [${m.category}] ${m.content}`).join('\n').slice(0, 8000);
  if (ctx.life) p += lifeBlock(ctx.life, ctx);
  if (ctx.brief && mode !== 'onboarding') p += `

HE JUST OPENED HIS MORNING BRIEF. Speak first, now. Greet him in one line, then: today's prayers with jama'ah times (lead with the next one), today's calendar (what's fixed, and any clashes with jama'ah times), any important unread email worth his attention (one line each, max three), how his prayers and habits went yesterday and any streaks worth naming, then help him set two or three priorities for today (ask for his top one if you don't know it), and one habit nudge. Under ninety seconds. End with one short question.`;
  if (ctx.debrief) p += `\n\nHE OPENED A MEETING DEBRIEF for "${ctx.debrief.summary}" (${ctx.debrief.when}). Speak first: one line to open, then a quick debrief, one question at a time: how it went, what was decided, what he owes and by when, anything that worried him. ${ctx.debrief.notes ? 'You already have the meeting notes below; confirm the key points with him rather than asking from scratch. Notes: ' + ctx.debrief.notes : ''} Keep it to about two minutes. When done, call save_debrief with event_id "${ctx.debrief.id}" and a tight summary (decisions, his follow-ups with dates).`;
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
  if (L.private.on) lines.push(`PRIVATE MODE IS ON (${L.private.manualUntil ? 'he asked you to stand down' : L.private.auto ? 'salah time: ' + L.private.auto.prayer + ' until ' + L.private.auto.until : 'he is in a meeting: "' + L.private.meeting.summary + '" until ' + L.private.meeting.until}). Keep any reply to one short line; if it's salah time, gently send him to pray; if he's in a meeting, be brief and discreet.`);
  if (L.habits.length) lines.push('Habits (today / current streak in days / last 7 days): ' + L.habits.map(h => `${h.name}: ${h.today || 'not logged'} / ${h.streak} / ${h.last7}of7`).join('; ') + '.');
  lines.push(`Morning brief time: ${L.briefTime}. Notifications on his phone: ${ctx.pushOn ? 'on' : 'off'}.`);
  const gg = L.google || {};
  if (gg.connected) {
    lines.push(`Google Workspace connected (${gg.email}).` + (ctx.calendar && ctx.calendar.length ? ' Calendar today: ' + ctx.calendar.map(e => `${e.when.replace(/^\w+ \d+ \w+ /, '')} ${e.title}${e.meet ? ' (Meet)' : ''}`).join('; ') + '.' : ' Nothing on his calendar today.'));
    if (ctx.unread && ctx.unread.length) lines.push('Important unread email: ' + ctx.unread.map(m => `[${m.id}] ${String(m.from || '').replace(/<.*>/, '').trim()}: ${m.subject}`).join('; ') + '.');
    if (ctx.pendingDebriefs && ctx.pendingDebriefs.length) lines.push('Meetings that ended without a debrief yet: ' + ctx.pendingDebriefs.map(e => `"${e.summary}" (event_id ${e.id})`).join('; ') + '. If it fits naturally, offer a quick debrief once; never push it.');
    if (ctx.recentNotes && ctx.recentNotes.length) lines.push('Recent meeting notes: ' + ctx.recentNotes.map(n => n.summary).join(' | ').slice(0, 3000));
  } else if (gg.status === 'expired') lines.push('Google access has EXPIRED. If he asks for calendar or email, tell him to tap Reconnect Google on the home screen.');
  else lines.push("Google Workspace is not connected yet. If he asks about calendar/email/Drive, or at a natural moment, offer to connect it and call connect_google.");
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
- Use get_prayer_times for anything beyond today (e.g. tomorrow's Fajr).

GOOGLE WORKSPACE RULES (his JSE work account):
- Calendar: get_calendar and find_free_time to answer questions. JSE calls only work from 12pm. Protect jama'ah times when suggesting slots. To add or change an event, call create_event or update_event: this only shows a confirmation card. Nothing is booked yet at that point, so never say "booked", "set up" or "done" — read the details back as a question ("…shall I book it?") and wait. Only call confirm_pending after he clearly says yes or go to THAT card; if he hesitates or changes anything, call cancel_pending and start again.
- Email: search_email, summarise_unread and read_email to read. draft_email only creates a Gmail draft and shows it on screen; you can NEVER send email. Tell him it's in his drafts to review and send himself.
- Drive: search_drive and read_doc to find and read documents. Quote sparingly; summarise.
- Meetings: while he's in a meeting you stay quiet. After meetings, you may offer a short debrief (save it with save_debrief).
- Never read out private email content during private mode or a meeting.`;
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
  { name: 'connect_google', description: 'Show him the Connect Google button (JSE Google Workspace).', parameters: OBJ({}, []) },
  { name: 'get_calendar', description: 'Read his calendar.', parameters: OBJ({ range: STR('today, tomorrow, week, or a date YYYY-MM-DD') }, []) },
  { name: 'find_free_time', description: 'Find free slots on a day (UK time).', parameters: OBJ({ date: STR('YYYY-MM-DD, default today'), duration: { type: 'INTEGER', description: 'Minutes, default 30' }, from: STR('HH:MM earliest, default 09:00'), to: STR('HH:MM latest, default 18:00') }, []) },
  { name: 'create_event', description: 'Propose a new calendar event. Shows a confirmation card; nothing is written until confirm_pending.', parameters: OBJ({ title: STR('Event title'), start: STR('YYYY-MM-DDTHH:MM UK time'), end: STR('YYYY-MM-DDTHH:MM UK time'), attendees: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Email addresses (optional; invites are not sent automatically)' }, location: STR('Optional'), add_meet: BOOL('Add a Google Meet link') }, ['title', 'start', 'end']) },
  { name: 'update_event', description: 'Propose a change to an existing event (from get_calendar). Shows a confirmation card.', parameters: OBJ({ event_id: STR('Event id'), title: STR('New title'), start: STR('YYYY-MM-DDTHH:MM'), end: STR('YYYY-MM-DDTHH:MM'), location: STR('New location') }, ['event_id']) },
  { name: 'confirm_pending', description: 'Carry out the calendar change on the confirmation card. Only after he clearly says yes/go to it.', parameters: OBJ({}, []) },
  { name: 'cancel_pending', description: 'Discard the confirmation card.', parameters: OBJ({}, []) },
  { name: 'search_email', description: 'Search his Gmail (Gmail search syntax works, e.g. from:jay newer_than:7d).', parameters: OBJ({ query: STR('Search query') }, ['query']) },
  { name: 'summarise_unread', description: 'Get his important unread email from the last two days.', parameters: OBJ({}, []) },
  { name: 'read_email', description: 'Read one email by id.', parameters: OBJ({ id: STR('Message id') }, ['id']) },
  { name: 'draft_email', description: 'Create a Gmail DRAFT (never sends). Shows it on screen.', parameters: OBJ({ to: STR('Recipient email(s)'), subject: STR('Subject'), body: STR('Plain-text body, in his voice, signed Eesah'), reply_to_id: STR('Message id if this is a reply') }, ['body']) },
  { name: 'search_drive', description: 'Search his Google Drive.', parameters: OBJ({ query: STR('Words to search for') }, ['query']) },
  { name: 'read_doc', description: 'Read a Drive file (Docs, Sheets, Slides, text) by id.', parameters: OBJ({ id: STR('File id') }, ['id']) },
  { name: 'save_debrief', description: 'Save a meeting debrief to memory and mark it done.', parameters: OBJ({ event_id: STR('Event id'), summary: STR('Decisions and his follow-ups with dates') }, ['summary']) },
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
    const ctx = { memory: true, profile, memories, answers, life, pushOn: subs.length > 0 };
    if (life && life.google && life.google.connected) {
      const now = new Date().toISOString();
      const [cal, deb, notes] = await Promise.all([
        G.getCalendar('today').catch(() => null),
        db(`calendar_events?select=id,summary&debrief_status=eq.offered&end_at=gte.${new Date(Date.now() - 12 * 36e5).toISOString()}&end_at=lte.${now}`).catch(() => []),
        db('meeting_notes?select=summary&order=created_at.desc&limit=3').catch(() => [])
      ]);
      ctx.calendar = cal; ctx.pendingDebriefs = deb; ctx.recentNotes = notes;
    }
    return ctx;
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
  if (ctx.memory && ctx.life && ctx.life.google && ctx.life.google.connected) {
    if (ctx.brief) ctx.unread = await G.importantUnread().catch(() => null);
    if (wanted === 'debrief' && req.query.event) {
      const ev = (await db(`calendar_events?select=id,summary,start_at,end_at&id=eq.${encodeURIComponent(req.query.event)}`).catch(() => []))[0];
      if (ev) { const n = (await db(`meeting_notes?select=summary&event_id=eq.${encodeURIComponent(ev.id)}`).catch(() => []))[0]; ctx.debrief = { id: ev.id, summary: ev.summary, when: G.ukDay(ev.start_at) + ' ' + G.ukHM(ev.start_at), notes: n ? n.summary : null }; }
    }
  }
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
    return res.status(200).json({ token: j.name, model: MODEL, mode: ctx.mode, brief: !!ctx.brief && ctx.mode !== 'onboarding', debrief: ctx.mode !== 'onboarding' && ctx.debrief ? ctx.debrief.summary : null, memory: !!ctx.memory });
  } catch (e) {
    return res.status(502).json({ error: 'Voice service unreachable' });
  }
};
module.exports.persona = persona;
