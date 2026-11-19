// Prayer schedule and mosque management (search, switch, travelling).
const { readBody, setProfile, db } = require('./_db');
const { requireAuth } = require('./_auth');
const { getSchedule, searchMosques, fetchConf } = require('./_prayer');

module.exports = async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    if (req.method === 'GET') return res.status(200).json(await getSchedule());
    const b = await readBody(req);
    switch (b.action) {
      case 'search': return res.status(200).json({ results: await searchMosques({ q: b.q, lat: b.lat, lng: b.lng, country: b.country || 'GB' }) });
      case 'set_mosque': {
        const conf = await fetchConf(String(b.slug || ''));
        await db('prayer_cache?on_conflict=slug', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { slug: b.slug, conf, fetched_at: new Date().toISOString() } });
        await setProfile('mosque_slug', b.slug); await setProfile('mosque_name', conf.name); await setProfile('travel_location', '');
        return res.status(200).json({ ok: true, mosque: conf.name });
      }
      case 'travel': {
        if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return res.status(400).json({ error: 'Location needed' });
        await setProfile('travel_location', JSON.stringify({ lat: b.lat, lng: b.lng, label: String(b.label || 'your current location').slice(0, 80) }));
        return res.status(200).json({ ok: true });
      }
      case 'home': await setProfile('travel_location', ''); return res.status(200).json({ ok: true });
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) { return res.status(502).json({ error: 'Prayer times unavailable right now' }); }
};
