// Daily life state: prayer times, habits/streaks, private mode, brief time.
const { readBody, setProfile, getProfile } = require('./_db');
const { requireAuth } = require('./_auth');
const { lifeState, logHabit, addHabit, setPrivate } = require('./_life');
const PH = require('./_phone');
const NEURO = require('./_neuro');
const SEC = require('./_sections');
const SAL = require('./_salah');
const AUTH = require('./_authority');

module.exports = async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.neuro) {
        const G = {
          daily: NEURO.daily, preferences: NEURO.preferences, briefing: NEURO.briefing, learned: NEURO.observations,
          trajectory: NEURO.trajectory, futures: NEURO.futuresList, trainer: NEURO.trainer, connect: NEURO.connectLast,
          finance: NEURO.finance, contacts: NEURO.contacts, sleep: NEURO.sleepList, salah_times: () => NEURO.salahTimes(q),
          actions: () => AUTH.list({ status: q.status })
        }[q.neuro];
        if (!G) return res.status(400).json({ error: 'Unknown view' });
        return res.status(200).json(await G());
      }
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
      case 'neuro_islamic_mode': { if (typeof b.enabled !== 'boolean') return res.status(400).json({ error: 'Boolean required' }); await setProfile('neuro_islamic_mode', String(b.enabled)); return res.status(200).json({ ok: true, islamicMode: b.enabled }); }
      case 'neuro_learning': return res.status(200).json(await NEURO.setLearning(b));
      case 'neuro_mode': return res.status(200).json(await NEURO.setMode(b));
      case 'neuro_guest': return res.status(200).json(await NEURO.setGuest(b));
      case 'neuro_observe': { const L = NEURO.learning(await getProfile()); if (!(L.conversations || L.checkins)) return res.status(200).json({ ok: false, error: 'Learning is switched off; nothing recorded.' }); return res.status(200).json(await NEURO.addObservation(b, 'Freya, in conversation')); }
      case 'neuro_learned': return res.status(200).json(await NEURO.observationEdit(b));
      case 'neuro_futures': return res.status(200).json(await NEURO.futures(b));
      case 'neuro_futures_choose': return res.status(200).json(await NEURO.futuresChoose(b));
      case 'neuro_trainer_plan': return res.status(200).json(await NEURO.trainerPlan(b));
      case 'neuro_trainer_log': return res.status(200).json(await NEURO.trainerLog(b));
      case 'neuro_connect': return res.status(200).json(await NEURO.connectAnalyse(b));
      case 'neuro_sleep': return res.status(200).json(await NEURO.sleepSave(b));
      case 'neuro_sleep_delete': return res.status(200).json(await NEURO.sleepDelete(b.id));
      // Action ledger: propose never executes; approve binds id + exact-parameter hash, once, before expiry.
      case 'action_propose': return res.status(200).json(await AUTH.propose({ kind: b.kind, params: b.params, why: b.why }));
      case 'action_approve': return res.status(200).json(await AUTH.approve(b.id, b.hash));
      case 'action_deny': return res.status(200).json(await AUTH.deny(b.id));
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
  } catch (e) { if (e.status === 400) return res.status(400).json({ error: e.message }); return res.status(502).json({ error: /section_not_ready/.test(e.message) ? 'This section is not ready yet.' : /no_gemini_key/.test(e.message) ? 'Freya\'s reasoning is not configured here.' : 'Life engine error' }); }
};
