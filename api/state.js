// Daily life state: prayer times, habits/streaks, private mode, brief time.
const { readBody, setProfile } = require('./_db');
const { requireAuth } = require('./_auth');
const { lifeState, logHabit, addHabit, setPrivate } = require('./_life');

module.exports = async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    if (req.method === 'GET') {
      const s = await lifeState();
      return res.status(200).json({ schedule: s.schedule, habits: s.habits, private: s.private, briefTime: s.briefTime });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = await readBody(req);
    switch (b.action) {
      case 'log': return res.status(200).json(await logHabit(b.name, b.status || 'done', b.day));
      case 'add_habit': return res.status(200).json(await addHabit(b.name));
      case 'private': return res.status(200).json(await setPrivate(!!b.on, b.minutes));
      case 'brief_time': {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || '')) return res.status(400).json({ error: 'Use HH:MM' });
        await setProfile('brief_time', b.time); return res.status(200).json({ ok: true, time: b.time });
      }
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) { return res.status(502).json({ error: 'Life engine error' }); }
};
