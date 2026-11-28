// Daily life state: prayer times, habits/streaks, private mode, brief time.
const { readBody, setProfile, getProfile } = require('./_db');
const { requireAuth } = require('./_auth');
const { lifeState, logHabit, addHabit, setPrivate } = require('./_life');
const PH = require('./_phone');
const NEURO = require('./_neuro');
const SEC = require('./_sections');
const SAL = require('./_salah');

module.exports = async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if(q.neuro==='daily')return res.status(200).json(await NEURO.daily());
      if(q.neuro==='preferences'){const p=await getProfile();return res.status(200).json({islamicMode:p.neuro_islamic_mode==='true',configured:p.neuro_islamic_mode!=null});}
      if (q.sec) return res.status(200).json(await SEC.handle(req, {}));
      if (q.phone === 'today') return res.status(200).json(await PH.view().then(v => v ? { today: v.today, yesterday: v.yesterday, baseline: v.baseline } : { none: true }));
      if (q.phone === 'week') return res.status(200).json(await PH.week());
      const s = await lifeState();
      return res.status(200).json({ schedule: s.schedule, habits: s.habits, private: s.private, salahMode: s.salahMode, due: s.due, briefTime: s.briefTime, google: s.google });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = await readBody(req);
    if (String(b.action || '').startsWith('sec_')) { const r = await SEC.handle(req, b); return res.status(r && r.ok === false && /not_ready/.test(r.error || '') ? 409 : 200).json(r); }
    switch (b.action) {
      case 'neuro_goal': return res.status(200).json(await NEURO.goal(b));
      case 'neuro_islamic_mode': {if(typeof b.enabled!=='boolean')return res.status(400).json({error:'Boolean required'});await setProfile('neuro_islamic_mode',String(b.enabled));return res.status(200).json({ok:true,islamicMode:b.enabled});}
      case 'log': { const r = await logHabit(b.name, b.status || 'done', b.day); return res.status(r.forbidden ? 403 : 200).json(r); }
      // Prayers: only with evidence Freya has checked (camera stills while he prays, or a masjid photo).
      case 'prayer_log': return res.status(200).json(await SAL.logWithEvidence({ kind: b.kind, prayer: b.prayer, images: b.images, upload_id: b.upload_id }));
      case 'prayer_missed': return res.status(200).json(await SAL.markMissed(b.prayer));
      case 'salah_mode': return res.status(200).json(await SAL.setSalahMode(!!b.on, b.minutes));
      case 'add_habit': return res.status(200).json(await addHabit(b.name));
      case 'private': return res.status(200).json(await setPrivate(!!b.on, b.minutes));
      case 'brief_time': {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || '')) return res.status(400).json({ error: 'Use HH:MM' });
        await setProfile('brief_time', b.time); return res.status(200).json({ ok: true, time: b.time });
      }
      case 'phone_upload': return res.status(200).json(await PH.upload(b));
      case 'phone_note': return res.status(200).json(await PH.note(String(b.id || ''), b.answer));
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) { return res.status(502).json({ error: /section_not_ready/.test(e.message) ? 'This section is not ready yet.' : 'Life engine error' }); }
};
