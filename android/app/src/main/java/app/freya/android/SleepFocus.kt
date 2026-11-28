package app.freya.android

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject
import kotlin.math.sqrt

/**
 * Sleep Focus: opt-in, user-started, visible (persistent notification with Stop), screen-off capable.
 * Only derived numbers are kept: loud sounds, snore-like minutes and % quiet. Audio samples never leave feed().
 * Same maths as the web version so results are comparable.
 */
object SleepFocus {
    private fun p(c: Context): SharedPreferences = c.getSharedPreferences("sleepfocus", Context.MODE_PRIVATE)
    @Volatile var active = false; private set
    @Volatile var held = false; private set          // Private / Salah: nothing analysed
    @Volatile var startedAt = 0L; private set
    private var acc = 0.0; private var accN = 0
    private var samples = 0; private var quiet = 0; private var loud = 0; private var lastLoud = 0L
    private val hist = ArrayDeque<Double>(); private val bursts = ArrayDeque<Long>(); private var snoreMin = 0
    private var interrupted = false
    private var ctx: Context? = null

    fun allowed(c: Context) = Prefs.app(c).getBoolean("learn_sleep", false)

    @Synchronized fun start(c: Context): JSONObject {
        if (!allowed(c)) return JSONObject().put("ok", false).put("error", "Turn on Sleep Focus in Neuro settings first.")
        if (active) return status()
        samples = 0; quiet = 0; loud = 0; lastLoud = 0; hist.clear(); bursts.clear(); snoreMin = 0; acc = 0.0; accN = 0; interrupted = false
        ctx = c.applicationContext; p(c).edit().remove("snap").apply()
        startedAt = System.currentTimeMillis(); active = true; held = Prefs.app(c).getString("neuro_mode", "") in HOLD
        p(c).edit().putLong("started", startedAt).apply()
        if (!WakeWordService.startForSleep(c)) { active = false; return JSONObject().put("ok", false).put("error", "Android would not start the microphone service. Open Neuro and try again.") }
        return status()
    }

    /** Ends the session and stores the derived summary for the web app to save (sessions under 10 minutes are dropped). */
    @Synchronized fun stop(c: Context, why: String = ""): JSONObject {
        if (!active) return JSONObject().put("ok", true).put("saved", false)
        active = false; held = false
        val ended = System.currentTimeMillis(); val minutes = (ended - startedAt) / 60000.0
        val summary = JSONObject().put("loud_events", loud).put("snore_like_min", snoreMin)
            .put("quiet_pct", if (samples > 0) Math.round(quiet * 100.0 / samples).toInt() else 0)
            .put("interrupted", interrupted).put("native", true)
        val out = JSONObject().put("ok", true).put("started_at", iso(startedAt)).put("ended_at", iso(ended)).put("minutes", minutes).put("summary", summary)
        if (minutes >= 10) { p(c).edit().putString("pending", out.toString()).apply(); out.put("saved", true) } else out.put("saved", false)
        p(c).edit().remove("started").remove("snap").apply()
        WakeWordService.refresh()
        return out
    }
    fun abort(c: Context) { active = false; held = false; p(c).edit().remove("started").apply() }

    /** If Android killed the app mid-session, turn the last snapshot into an interrupted summary (never invented data). */
    fun pending(c: Context): String? {
        val pp = p(c)
        if (!active && pp.contains("started") && pp.contains("snap")) {
            try {
                val s = JSONObject(pp.getString("snap", "{}")); val st = pp.getLong("started", 0); val end = s.optLong("t", st)
                val min = (end - st) / 60000.0
                if (min >= 10) pp.edit().putString("pending", JSONObject().put("ok", true).put("started_at", iso(st)).put("ended_at", iso(end)).put("minutes", min)
                    .put("summary", JSONObject().put("loud_events", s.optInt("loud")).put("snore_like_min", s.optInt("snore")).put("quiet_pct", s.optInt("quiet")).put("interrupted", true).put("native", true)).toString()).apply()
            } catch (e: Exception) {}
            pp.edit().remove("started").remove("snap").apply()
        }
        return pp.getString("pending", null)
    }
    fun clearPending(c: Context) = p(c).edit().remove("pending").apply()

    private val HOLD = setOf("private", "salah")
    fun setMode(c: Context, mode: String) {
        Prefs.app(c).edit().putString("neuro_mode", mode).apply()
        val h = mode in HOLD
        if (active && h != held) { held = h; if (h) interrupted = true; WakeWordService.refresh() }
    }
    fun sessionInterrupted() { if (active) interrupted = true }

    fun status(): JSONObject = JSONObject().put("ok", true).put("active", active).put("held", held).put("started_at", if (active) iso(startedAt) else JSONObject.NULL)

    /** 100 ms of 16 kHz PCM in; only an RMS number survives. 5 chunks = one 500 ms frame, like the web analyser. */
    @Synchronized fun feed(buf: ShortArray, n: Int) {
        if (!active || held) return
        for (i in 0 until n) { val v = buf[i] / 32768.0; acc += v * v }
        accN += n
        if (accN < 8000) return
        val rms = sqrt(acc / accN); acc = 0.0; accN = 0; samples++
        hist.addLast(rms); if (hist.size > 240) hist.removeFirst()
        val sorted = hist.sorted(); val base = sorted.getOrElse((sorted.size * 0.2).toInt()) { rms }
        if (rms < base * 1.6) quiet++
        val t = System.currentTimeMillis()
        if (samples > 20 && rms > maxOf(base * 3.5, 0.015) && t - lastLoud > 1000) { loud++; lastLoud = t; bursts.addLast(t) }
        while (bursts.isNotEmpty() && t - bursts.first() >= 60_000) bursts.removeFirst()
        if (samples % 120 == 0 && bursts.size >= 6) {
            val b = bursts.toList(); val iv = (1 until b.size).map { (b[it] - b[it - 1]) / 1000.0 }
            val m = iv.average(); val sd = sqrt(iv.sumOf { (it - m) * (it - m) } / iv.size)
            if (m in 2.0..7.0 && sd < 1.6) snoreMin++
        }
        if (samples % 120 == 0) ctx?.let { c -> p(c).edit().putString("snap", JSONObject().put("t", t).put("loud", loud).put("snore", snoreMin)
            .put("quiet", Math.round(quiet * 100.0 / samples).toInt()).toString()).apply() }
    }
    private fun iso(t: Long) = java.time.Instant.ofEpochMilli(t).toString()
}
