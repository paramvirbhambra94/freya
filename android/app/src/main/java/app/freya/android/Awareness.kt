package app.freya.android

import android.Manifest
import android.app.AlarmManager
import android.app.AppOpsManager
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min

/**
 * Phone awareness (opt-in). Every ~10 minutes: reads screen time from Usage access, the step counter,
 * and notification counts (metadata only), runs the nudge rules, and uploads a daily summary every ~30 min.
 * Nothing here reads message text.
 */
object Aware {
    private const val TICK_MS = 10 * 60_000L
    private const val UPLOAD_MS = 30 * 60_000L
    val zone: ZoneId = ZoneId.of("Europe/London")

    fun p(c: Context): SharedPreferences = c.getSharedPreferences("aware", Context.MODE_PRIVATE)

    // ---- permissions ----
    fun hasUsage(c: Context): Boolean {
        val ops = c.getSystemService(AppOpsManager::class.java)
        return ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), c.packageName) == AppOpsManager.MODE_ALLOWED
    }
    fun hasSteps(c: Context) = c.checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED &&
        c.getSystemService(SensorManager::class.java).getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null
    fun hasNotif(c: Context) = c.getSystemService(NotificationManager::class.java)
        .isNotificationListenerAccessGranted(ComponentName(c, FreyaNotifListener::class.java))
    fun anyOn(c: Context) = hasUsage(c) || hasSteps(c) || hasNotif(c)

    // ---- settings ----
    fun nudgesOn(c: Context) = p(c).getBoolean("nudges", true)
    fun spokenOn(c: Context) = p(c).getBoolean("spoken", false)
    fun quietHours(c: Context): Pair<Int, Int>? { val s = p(c).getInt("qs", -1); val e = p(c).getInt("qe", -1); return if (s < 0 || e < 0) null else s to e }
    fun workApps(c: Context): Set<String> = p(c).getStringSet("work", emptySet()) ?: emptySet()
    fun setWork(c: Context, set: Set<String>) = p(c).edit().putStringSet("work", HashSet(set)).apply()

    fun today(): LocalDate = LocalDate.now(zone)
    fun dayStart(d: LocalDate) = d.atStartOfDay(zone).toInstant().toEpochMilli()

    // ---- scheduling ----
    fun schedule(c: Context, soon: Boolean = false) {
        val am = c.getSystemService(AlarmManager::class.java)
        val pi = PendingIntent.getBroadcast(c, 41, Intent(c, AwarenessReceiver::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        if (!anyOn(c)) { am.cancel(pi); return }
        am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + if (soon) 60_000L else TICK_MS, pi)
    }

    // ---- steps (cumulative sensor, reboot-safe) ----
    private fun readCounter(c: Context): Float? {
        val sm = c.getSystemService(SensorManager::class.java)
        val s = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) ?: return null
        var v: Float? = null
        val latch = CountDownLatch(1)
        val l = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) { v = e.values[0]; latch.countDown() }
            override fun onAccuracyChanged(s: Sensor?, a: Int) {}
        }
        sm.registerListener(l, s, SensorManager.SENSOR_DELAY_NORMAL, 0, Handler(Looper.getMainLooper()))
        latch.await(4, TimeUnit.SECONDS)
        sm.unregisterListener(l)
        return v
    }
    /** Updates today's steps and lastMoveAt. Returns finished yesterday steps if the day rolled over. */
    @Synchronized fun sampleSteps(c: Context): Pair<String, Int>? {
        if (!hasSteps(c)) return null
        val cur = readCounter(c) ?: return null
        val sp = p(c); val ed = sp.edit()
        val day = today().toString(); val now = System.currentTimeMillis()
        var rolled: Pair<String, Int>? = null
        val sDay = sp.getString("s_day", null)
        var base = sp.getFloat("s_base", cur); var acc = sp.getInt("s_acc", 0); val last = sp.getFloat("s_last", cur)
        val prevTotal = (acc + (last - base).toInt()).coerceAtLeast(0)
        val rebooted = cur < last
        if (rebooted) { acc = prevTotal; base = 0f }  // reboot reset the counter
        if (sDay != day) {
            if (sDay != null) { rolled = sDay to prevTotal; ed.putInt("steps_$sDay", prevTotal) }
            base = if (rebooted) 0f else last; acc = 0
            ed.putString("s_day", day)
        }
        val steps = (acc + (cur - base).toInt()).coerceAtLeast(0)
        val moved = cur - sp.getFloat("s_prev_tick", cur)
        if (moved >= 40 || !sp.contains("move_at")) ed.putLong("move_at", now)
        ed.putFloat("s_base", base).putInt("s_acc", acc).putFloat("s_last", cur).putFloat("s_prev_tick", cur).putInt("steps", steps).apply()
        return rolled
    }
    fun stepsToday(c: Context): Int? = if (hasSteps(c) && p(c).getString("s_day", null) == today().toString()) p(c).getInt("steps", 0) else null
    /** Minutes without walking, counted from 08:00 at the earliest so sleep never counts as sitting. */
    fun stillMinutes(c: Context): Int? {
        if (!hasSteps(c) || !p(c).contains("move_at")) return null
        val from = max(p(c).getLong("move_at", 0), dayStart(today()) + 8 * 3_600_000L)
        return ((System.currentTimeMillis() - from) / 60_000).toInt().coerceAtLeast(0)
    }

    // ---- usage ----
    data class Sess(val pkg: String, val start: Long, val end: Long)
    class Day(val day: String) {
        var screenMin = 0; var unlocks = 0; var lateMin = 0
        val hourly = IntArray(24)
        val perApp = HashMap<String, Long>(); val sessions = HashMap<String, Int>()
        var longest: Sess? = null
        var current: Sess? = null   // the app open right now, merged across brief switches
        var lastActivity = 0L
    }
    private fun homePkgs(c: Context): Set<String> {
        val i = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        return c.packageManager.queryIntentActivities(i, 0).map { it.activityInfo.packageName }.toSet() + setOf("com.android.systemui", c.packageName)
    }
    fun usage(c: Context, d: LocalDate): Day? {
        if (!hasUsage(c)) return null
        val out = Day(d.toString())
        val start = dayStart(d); val end = min(dayStart(d.plusDays(1)), System.currentTimeMillis())
        val usm = c.getSystemService(UsageStatsManager::class.java)
        val ev = usm.queryEvents(start - 3 * 3_600_000L, end) ?: return out
        val skip = homePkgs(c)
        val raw = ArrayList<Sess>()
        var cur: String? = null; var curStart = 0L
        fun close(t: Long) { val pk = cur ?: return; if (t > curStart && pk !in skip) raw.add(Sess(pk, curStart, t)); cur = null }
        val e = UsageEvents.Event()
        while (ev.hasNextEvent()) {
            ev.getNextEvent(e); val t = e.timeStamp
            when (e.eventType) {
                UsageEvents.Event.ACTIVITY_RESUMED -> { if (cur != e.packageName) { close(t); cur = e.packageName; curStart = t } }
                UsageEvents.Event.ACTIVITY_PAUSED, UsageEvents.Event.ACTIVITY_STOPPED -> if (cur == e.packageName) close(t)
                UsageEvents.Event.SCREEN_NON_INTERACTIVE -> close(t)
                UsageEvents.Event.KEYGUARD_HIDDEN -> if (t >= start) out.unlocks++
            }
        }
        val interactive = c.getSystemService(PowerManager::class.java).isInteractive
        val openNow = if (interactive && cur != null && cur !in skip) cur else null
        if (interactive) close(end) else cur = null
        // clip to the day
        val list = raw.mapNotNull { s -> val a = max(s.start, start); val b = min(s.end, end); if (b > a) Sess(s.pkg, a, b) else null }
        for (s in list) {
            out.perApp[s.pkg] = (out.perApp[s.pkg] ?: 0L) + (s.end - s.start)
            var t = s.start
            while (t < s.end) {
                val z = Instant.ofEpochMilli(t).atZone(zone); val h = z.hour
                val hourEnd = min(s.end, z.withMinute(0).withSecond(0).withNano(0).plusHours(1).toInstant().toEpochMilli())
                val m = (hourEnd - t) / 60_000.0
                out.hourly[h] += m.toInt().coerceAtLeast(0)
                if (h >= 23 || h < 5) out.lateMin += m.toInt()
                t = hourEnd
            }
            out.lastActivity = max(out.lastActivity, s.end)
        }
        // merge each app's sessions across gaps under 2 minutes (quick switches, notification shade)
        val merged = ArrayList<Sess>()
        for (s in list.sortedBy { it.start }) {
            val i = merged.indexOfLast { it.pkg == s.pkg }
            if (i >= 0 && s.start - merged[i].end < 120_000L && merged.subList(i + 1, merged.size).sumOf { it.end - it.start } < 120_000L) merged[i] = Sess(s.pkg, merged[i].start, s.end)
            else merged.add(s)
        }
        merged.forEach { s -> out.sessions[s.pkg] = (out.sessions[s.pkg] ?: 0) + 1; if (out.longest == null || s.end - s.start > out.longest!!.end - out.longest!!.start) out.longest = s }
        if (openNow != null) out.current = merged.lastOrNull { it.pkg == openNow && end - it.end < 5_000L }
        out.screenMin = (out.perApp.values.sum() / 60_000L).toInt()
        return out
    }

    private val labels = HashMap<String, String>()
    fun label(c: Context, pkg: String): String = labels.getOrPut(pkg) {
        try { c.packageManager.getApplicationLabel(c.packageManager.getApplicationInfo(pkg, 0)).toString() } catch (e: Exception) { pkg.substringAfterLast('.') }
    }
    fun category(c: Context, pkg: String): Int = try { c.packageManager.getApplicationInfo(pkg, 0).category } catch (e: Exception) { ApplicationInfo.CATEGORY_UNDEFINED }

    // ---- notification stats (per day, metadata only) ----
    @Synchronized fun notifStats(c: Context, day: String): JSONObject = try { JSONObject(p(c).getString("n_$day", "{}")!!) } catch (e: Exception) { JSONObject() }
    @Synchronized fun notifUpdate(c: Context, pkg: String, f: (JSONObject) -> Unit) {
        val day = today().toString(); val all = notifStats(c, day)
        val o = all.optJSONObject(pkg) ?: JSONObject(); f(o); all.put(pkg, o)
        val ed = p(c).edit().putString("n_$day", all.toString())
        p(c).all.keys.filter { it.startsWith("n_") && it < "n_" + today().minusDays(3) }.forEach { ed.remove(it) }
        ed.apply()
    }

    // ---- summary for upload / voice ----
    fun summary(c: Context, d: LocalDate, final: Boolean, steps: Int? = null): JSONObject {
        val day = d.toString(); val o = JSONObject().put("day", day).put("final", final)
        val work = workApps(c)
        usage(c, d)?.let { u ->
            o.put("screen_min", u.screenMin).put("unlocks", u.unlocks).put("late_min", u.lateMin).put("hourly", JSONArray(u.hourly.toList()))
            val top = JSONArray()
            u.perApp.entries.sortedByDescending { it.value }.take(12).forEach { (pk, ms) ->
                top.put(JSONObject().put("app", pk).put("label", label(c, pk)).put("min", ms / 60_000).put("sessions", u.sessions[pk] ?: 0).put("work", pk in work))
            }
            o.put("top_apps", top)
            u.longest?.let { o.put("longest_session", JSONObject().put("label", label(c, it.pkg)).put("min", (it.end - it.start) / 60_000)) }
        }
        val st = steps ?: if (day == today().toString()) stepsToday(c) else p(c).getInt("steps_$day", -1).takeIf { it >= 0 }
        if (st != null) o.put("steps", st)
        val sit = p(c).getInt("sit_max_$day", -1); if (sit >= 0) o.put("sedentary_max_min", sit)
        val ns = notifStats(c, day); var total = 0
        val arr = ns.keys().asSequence().map { pk ->
            val x = ns.getJSONObject(pk); total += x.optInt("n")
            JSONObject().put("app", pk).put("label", label(c, pk)).put("n", x.optInt("n")).put("clicks", x.optInt("clicks"))
                .apply { if (x.optInt("rn") > 0) put("avg_resp_s", x.optLong("rs") / x.optInt("rn")) }
                .put("cats", x.optJSONObject("cats") ?: JSONObject())
        }.sortedByDescending { it.optInt("n") }.take(12).toList()
        if (hasNotif(c)) o.put("notif_count", total).put("notif_by_app", JSONArray(arr))
        return o
    }
    /** Live numbers for the voice tool. */
    fun liveToday(c: Context): JSONObject {
        if (!anyOn(c)) return JSONObject().put("enabled", false)
        val s = summary(c, today(), false)
        stillMinutes(c)?.let { s.put("sitting_still_now_min", it) }
        return s.put("enabled", true).put("work_apps", JSONArray(workApps(c).map { label(c, it) }))
    }

    // ---- events queued for upload (nudges and his feedback) ----
    @Synchronized fun logEvent(c: Context, kind: String, rule: String?, app: String?) {
        val arr = try { JSONArray(p(c).getString("events", "[]")) } catch (e: Exception) { JSONArray() }
        arr.put(JSONObject().put("at", System.currentTimeMillis()).put("kind", kind).put("rule", rule ?: "").put("app", app ?: ""))
        val trimmed = JSONArray(); for (i in max(0, arr.length() - 50) until arr.length()) trimmed.put(arr.get(i))
        p(c).edit().putString("events", trimmed.toString()).apply()
    }

    // ---- the tick ----
    fun tick(c: Context) {
        if (!anyOn(c)) return
        val now = System.currentTimeMillis(); val sp = p(c)
        val rolled = try { sampleSteps(c) } catch (e: Exception) { null }
        val d = today()
        val u = try { usage(c, d) } catch (e: Exception) { null }
        // longest sit today (daytime only), for the daily summary
        val still = stillMinutes(c)
        val hour = ZonedDateTime.now(zone).hour
        if (still != null && hour in 8..21) { val k = "sit_max_$d"; if (still > sp.getInt(k, 0)) sp.edit().putInt(k, min(still, 14 * 60)).apply() }
        val old = "_" + d.minusDays(4)
        sp.all.keys.filter { (it.startsWith("sit_max_") || it.startsWith("steps_")) && it.substringAfterLast('_') < old.drop(1) }.let { ks -> if (ks.isNotEmpty()) { val ed = sp.edit(); ks.forEach { ed.remove(it) }; ed.apply() } }
        try { Nudger.check(c, u, still) } catch (e: Exception) {}
        val dayChanged = sp.getString("up_day", null) != d.toString()
        if (dayChanged || now - sp.getLong("up_at", 0) >= UPLOAD_MS) {
            val days = JSONArray()
            if (dayChanged) days.put(summary(c, d.minusDays(1), true, rolled?.second))
            days.put(summary(c, d, false))
            if (upload(c, days)) sp.edit().putLong("up_at", now).putString("up_day", d.toString()).apply()
        }
    }

    private fun cookie(): String? {
        var v: String? = null; val l = CountDownLatch(1)
        Handler(Looper.getMainLooper()).post { try { v = CookieManager.getInstance().getCookie(BASE_URL) } catch (e: Exception) {}; l.countDown() }
        l.await(5, TimeUnit.SECONDS); return v
    }
    fun upload(c: Context, days: JSONArray): Boolean {
        val ck = cookie() ?: return false
        val sp = p(c); val events = sp.getString("events", "[]")
        val body = JSONObject().put("action", "phone_upload").put("days", days).put("events", JSONArray(events)).toString()
        return try {
            val h = URL("$BASE_URL/api/state").openConnection() as HttpURLConnection
            h.requestMethod = "POST"; h.connectTimeout = 15_000; h.readTimeout = 20_000; h.doOutput = true
            h.setRequestProperty("content-type", "application/json"); h.setRequestProperty("cookie", ck)
            h.outputStream.use { it.write(body.toByteArray()) }
            val code = h.responseCode
            if (code == 200) {
                val r = JSONObject(h.inputStream.bufferedReader().readText())
                synchronized(this) {
                    val ed = sp.edit().putString("quiet", (r.optJSONArray("quiet") ?: JSONArray()).toString())
                    if (sp.getString("events", "[]") == events) ed.putString("events", "[]")
                    ed.apply()
                }
            }
            h.disconnect(); code == 200
        } catch (e: Exception) { false }
    }
}

/** Nudge rules, caps, quiet times and his feedback. */
object Nudger {
    const val MAX_PER_DAY = 4
    private const val GAP_MS = 45 * 60_000L
    private const val SAME_RULE_MS = 2 * 3_600_000L
    private val NO_NUDGE_CATS = setOf(ApplicationInfo.CATEGORY_MAPS, ApplicationInfo.CATEGORY_PRODUCTIVITY, ApplicationInfo.CATEGORY_AUDIO)
    private val NO_NUDGE_HINTS = listOf("dialer", "incallui", "telecom", "camera", "maps", "waze", "clock", "calculator")

    fun quietNow(c: Context, now: Long = System.currentTimeMillis()): Boolean {
        val sp = Aware.p(c)
        if (now < sp.getLong("snooze", 0)) return true
        Aware.quietHours(c)?.let { (s, e) ->
            val z = ZonedDateTime.now(Aware.zone); val m = z.hour * 60 + z.minute
            if (if (s <= e) m in s until e else (m >= s || m < e)) return true
        }
        val q = try { JSONArray(sp.getString("quiet", "[]")) } catch (e: Exception) { JSONArray() }
        for (i in 0 until q.length()) {
            val w = q.getJSONObject(i)
            val a = try { Instant.parse(w.getString("from")).toEpochMilli() } catch (e: Exception) { continue }
            val b = try { Instant.parse(w.getString("to")).toEpochMilli() } catch (e: Exception) { continue }
            if (now in a until b) return true
        }
        return false
    }
    private fun nextFajrMin(c: Context, now: Long): Int? {
        val q = try { JSONArray(Aware.p(c).getString("quiet", "[]")) } catch (e: Exception) { return null }
        var best: Long? = null
        for (i in 0 until q.length()) { val w = q.getJSONObject(i); if (w.optString("why") != "salah") continue
            val a = try { Instant.parse(w.getString("from")).toEpochMilli() } catch (e: Exception) { continue }
            if (a > now && (best == null || a < best)) best = a }
        return best?.let { ((it - now) / 60_000).toInt() }
    }

    /** Extra minutes added to a rule for an app after he says "not now" a few times (she learns). */
    fun extra(c: Context, rule: String, app: String?) = min(4, Aware.p(c).getInt("nn_${rule}_${app ?: ""}", 0) / 2) * 15

    fun check(c: Context, u: Aware.Day?, still: Int?) {
        if (!Aware.nudgesOn(c)) return
        if (c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        if (WakeWordService.activityVisible || Overlay.showing) return
        val sp = Aware.p(c); val now = System.currentTimeMillis(); val day = Aware.today().toString()
        if (sp.getString("nd_day", "") != day) sp.edit().putString("nd_day", day).putInt("nd_count", 0).apply()
        if (sp.getInt("nd_count", 0) >= MAX_PER_DAY || now - sp.getLong("nd_last", 0) < GAP_MS || quietNow(c, now)) return
        val z = ZonedDateTime.now(Aware.zone); val hour = z.hour
        val work = Aware.workApps(c)
        val cur = u?.current
        val curPkg = cur?.pkg
        val curMin = cur?.let { ((it.end - it.start) / 60_000).toInt() } ?: 0
        val nudgeable = curPkg != null && curPkg !in work && Aware.category(c, curPkg) !in NO_NUDGE_CATS && NO_NUDGE_HINTS.none { curPkg.contains(it) }
        fun ok(rule: String) = now - sp.getLong("nd_rule_$rule", 0) >= SAME_RULE_MS
        val name = curPkg?.let { Aware.label(c, it) } ?: ""
        when {
            nudgeable && hour < 5 && curMin >= 10 + extra(c, "late", curPkg) && ok("late") -> {
                val f = nextFajrMin(c, now)
                val fajr = if (f != null && f < 8 * 60) " Fajr's in about ${if (f >= 90) "${(f + 30) / 60} hours" else "$f minutes"}." else ""
                send(c, "late", curPkg, pick(listOf(
                    "It's ${"%d:%02d".format(hour, z.minute)}, Eesah. $name can wait till morning.$fajr Time to rest?",
                    "Still up? Let's put $name down and get some sleep.$fajr",
                    "Late one tonight. Phone down, lights off? I'll be here tomorrow.$fajr")))
            }
            nudgeable && curMin >= 30 + extra(c, "sink", curPkg) && ok("sink") -> send(c, "sink", curPkg, pick(listOf(
                "You've been on $name for $curMin minutes. Quick stretch or a glass of water?",
                "$curMin minutes of $name. Want to stand up for two minutes and come back fresh?",
                "That's $curMin minutes on $name, Eesah. Worth a little break?")))
            still != null && hour in 10..19 && still >= 120 + extra(c, "sit", null) && u != null && now - u.lastActivity < 20 * 60_000L && ok("sit") -> send(c, "sit", null, pick(listOf(
                "You've barely moved for about ${still / 60} hours. A five-minute walk?",
                "Long sit, Eesah. Stand up, stretch, maybe a quick walk round?",
                "About ${still / 60} hours sitting still. Your back would love a short walk.")))
        }
    }
    private fun pick(l: List<String>) = l[(System.currentTimeMillis() / 60_000 % l.size).toInt()]

    private fun send(c: Context, rule: String, app: String?, text: String) {
        val sp = Aware.p(c); val now = System.currentTimeMillis()
        sp.edit().putLong("nd_last", now).putLong("nd_rule_$rule", now).putInt("nd_count", sp.getInt("nd_count", 0) + 1).apply()
        Aware.logEvent(c, "nudge", rule, app)
        Channels.ensure(c)
        fun act(code: Int, a: String) = PendingIntent.getBroadcast(c, 500 + code,
            Intent(c, NudgeActionReceiver::class.java).setAction(a).putExtra("rule", rule).putExtra("app", app), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val open = PendingIntent.getActivity(c, 499, Intent(c, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val b = Notification.Builder(c, Channels.NUDGE).setSmallIcon(R.drawable.ic_stat).setContentTitle("Freya")
            .setContentText(text).setStyle(Notification.BigTextStyle().bigText(text)).setContentIntent(open).setAutoCancel(true)
            .addAction(Notification.Action.Builder(null, "Snooze 1h", act(1, NudgeActionReceiver.SNOOZE)).build())
            .addAction(Notification.Action.Builder(null, "Not now", act(2, NudgeActionReceiver.NOT_NOW)).build())
        if (app != null) b.addAction(Notification.Action.Builder(null, "This is work", act(3, NudgeActionReceiver.WORK)).build())
        try { c.getSystemService(NotificationManager::class.java).notify(NOTIF_ID, b.build()) } catch (e: SecurityException) {}
        if (Aware.spokenOn(c) && android.provider.Settings.canDrawOverlays(c) && c.getSystemService(PowerManager::class.java).isInteractive &&
            !c.getSystemService(KeyguardManager::class.java).isKeyguardLocked) {
            Handler(Looper.getMainLooper()).post { Overlay.show(c, text) }
        }
    }
    const val NOTIF_ID = 4100
}

class AwarenessReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        val pr = goAsync()
        Thread {
            try { Aware.tick(c) } catch (e: Exception) {} finally { try { Aware.schedule(c) } catch (e: Exception) {}; pr.finish() }
        }.start()
    }
}

class NudgeActionReceiver : BroadcastReceiver() {
    companion object { const val SNOOZE = "app.freya.android.NUDGE_SNOOZE"; const val NOT_NOW = "app.freya.android.NUDGE_NOT_NOW"; const val WORK = "app.freya.android.NUDGE_WORK" }
    override fun onReceive(c: Context, i: Intent) {
        val rule = i.getStringExtra("rule") ?: ""; val app = i.getStringExtra("app")
        val sp = Aware.p(c)
        when (i.action) {
            SNOOZE -> { sp.edit().putLong("snooze", System.currentTimeMillis() + 3_600_000L).apply(); Aware.logEvent(c, "nudge_snooze", rule, app) }
            NOT_NOW -> { val k = "nn_${rule}_${app ?: ""}"; sp.edit().putInt(k, sp.getInt(k, 0) + 1).apply(); Aware.logEvent(c, "nudge_not_now", rule, app) }
            WORK -> if (app != null) { Aware.setWork(c, Aware.workApps(c) + app); Aware.logEvent(c, "nudge_work", rule, app) }
        }
        c.getSystemService(NotificationManager::class.java).cancel(Nudger.NOTIF_ID)
    }
}
