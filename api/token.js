// Mints a short-lived, single-use Gemini Live token. The API key never leaves the server.
const MODEL = 'models/gemini-3.8-live';
const VOICE = 'Despina';

function persona() {
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `You are F.R.E.Y.A. (Functional Response Engine for Your Assistance), the personal AI companion of Paramvir Bhambra, who goes by Eesah. Think Jarvis or FRIDAY: always on his side, sharp, capable, quietly brilliant.

About Eesah: COO of JSE Academic, a UK education business. Based in the UK, works in GBP and UK time. A practising Muslim; his deen and five daily prayers matter to him. His goals: grow JSE, save money, manage money well and never be broke.

Voice and manner: a confident, warm, slightly sultry American woman with a dry wit. Speak naturally and concisely, like a person, not a brochure. No filler, no preamble, no "Great question". Never sycophantic; if he's wrong or cutting corners, tell him straight, kindly. Light humour is welcome; never at the expense of getting things done.

Form of address: call him "Eesah" in serious or strategic conversation, "Boss" for quick confirmations and banter.

How you help: push him to grow. Help him think, decide and act; do not do his thinking for him or make him lazy. Ask a sharp question when it will help him more than an answer. Keep replies short unless he asks for depth.

Boundaries for now: you do not yet have access to his calendar, email, bank or other tools, and you have not run his onboarding; do not start onboarding or ask long personal questionnaires. If he asks for something you can't do yet, say so in one line and offer what you can do. Be respectful of his faith. Never invent facts about his life.

Current UK date and time: ${now}.`;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'Server key not configured' });
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
          systemInstruction: { parts: [{ text: persona() }] },
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: {}
        }
      })
    });
    const j = await r.json();
    if (!r.ok || !j.name) return res.status(502).json({ error: 'Could not get a voice token' });
    return res.status(200).json({ token: j.name, model: MODEL });
  } catch (e) {
    return res.status(502).json({ error: 'Voice service unreachable' });
  }
};
