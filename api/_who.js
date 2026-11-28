// Who Freya is talking to. The owner (Eesah) keeps his personal context exactly as before; every other account
// gets the same engine with his name, his work (JSE) and his masjid taken out, so nothing of his leaks into
// their prompts, questions or replies.
const { current, isOwner } = require('./_db');

const first = () => { const c = current() || {}; return c.first || (c.name ? String(c.name).split(/\s+/)[0] : 'there'); };
const name = () => (isOwner() ? 'Eesah' : first());

const RULES = [
  [/Paramvir Bhambra,? who goes by Eesah/g, () => first()],
  [/Paramvir Bhambra/g, () => first()],
  [/\(Paramvir Bhambra\)/g, () => ''],
  [/\s*\(he is COO of JSE Academic\)/g, () => ''],
  [/he is COO of JSE Academic \(UK\)\.\s*/g, () => ''],
  [/,? for JSE and for your career/g, () => ' and for your career'],
  [/Tell me about your role at JSE Academic as you see it/g, () => 'Tell me about your work or studies as you see them'],
  [/the three biggest goals for JSE/g, () => 'the three biggest goals for your work'],
  [/held JSE, or you, back/g, () => 'held you back'],
  [/alignment with JSE goals/g, () => 'alignment with your goals'],
  [/JSE goals/g, () => 'work goals'],
  [/JSE Academic/g, () => 'their work'],
  [/\bJSE\b/g, () => 'work'],
  [/MahmudSabir \/ Al Furqan Masjid, Tyseley/g, () => 'their local masjid'],
  [/MahmudSabir \(Al Furqan\) Masjid, Tyseley/g, () => 'the masjid'],
  [/Islamic values matter to him; be respectful\./g, () => 'Respect their values and beliefs.'],
  [/a Muslim man \(Eesah\)/g, () => 'a Muslim (' + first() + ')'],
  [/Mind & Deen/g, () => 'Mind'],
  [/headspace and deen/g, () => 'headspace'],
  [/Values, deen, character, lifestyle/g, () => 'Values, character, lifestyle'],
  [/\bEesah's\b/g, () => first() + "'s"],
  [/\bEESAH\b/g, () => first().toUpperCase()],
  [/\bEesah\b/g, () => first()]
];
function personalize(text) {
  if (isOwner() || typeof text !== 'string') return text;
  let t = text;
  for (const [re, f] of RULES) t = t.replace(re, f);
  return t;
}
// Deep-apply to prompt parts / plain objects of strings.
function personalizeAll(v) {
  if (isOwner()) return v;
  if (typeof v === 'string') return personalize(v);
  if (Array.isArray(v)) return v.map(personalizeAll);
  if (v && typeof v === 'object' && !v.inlineData && !v.inline_data) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, personalizeAll(x)]));
  return v;
}
module.exports = { first, name, personalize, personalizeAll };
