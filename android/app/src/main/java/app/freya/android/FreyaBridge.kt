package app.freya.android

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

/** window.FreyaAndroid for the full app and the floating overlay. Only answers while the Neuro site is loaded. */
class FreyaBridge(private val c: Context, private val ourSite: () -> Boolean, private val onSession: (Boolean) -> Unit) {
    private val h = Handler(Looper.getMainLooper())
    private fun ok() = ourSite()
    private fun err(m: String) = JSONObject().put("ok", false).put("error", m).toString()

    @JavascriptInterface fun isApp(): Boolean = true
    @JavascriptInterface fun version(): String = c.packageManager.getPackageInfo(c.packageName, 0).versionName ?: ""

    @JavascriptInterface fun setAlarm(at: Double, label: String?): String {
        if (!ok()) return err("not allowed")
        val t = at.toLong()
        if (t < System.currentTimeMillis() - 1000) return err("time is in the past")
        if (t > System.currentTimeMillis() + 400L * 86_400_000L) return err("too far ahead")
        val a = AlarmScheduler.set(c, t, label?.ifBlank { null } ?: "Alarm")
        return a.json().put("ok", true).put("exact", AlarmScheduler.canExact(c)).toString()
    }
    @JavascriptInterface fun cancelAlarm(id: String?): String {
        if (!ok()) return err("not allowed")
        val list = AlarmStore.all(c)
        val targets = if (id == null || id == "all") list else list.filter { it.id.toString() == id }
        targets.forEach { AlarmScheduler.remove(c, it.id) }
        return JSONObject().put("ok", targets.isNotEmpty()).put("cancelled", targets.size).toString()
    }
    @JavascriptInterface fun listAlarms(): String {
        if (!ok()) return "[]"
        val arr = JSONArray(); AlarmStore.all(c).forEach { arr.put(it.json()) }; return arr.toString()
    }
    @JavascriptInterface fun sessionActive(on: Boolean) {
        WakeWordService.sessionLive = on
        if (on) { SleepFocus.sessionInterrupted(); WakeWordService.pause() } else WakeWordService.refresh()
        h.post { onSession(on) }
    }
    @JavascriptInterface fun wakeWordEnabled(): Boolean = Prefs.wakeEnabled(c)
    @JavascriptInterface fun setWakeWord(on: Boolean) {
        if (!ok()) return
        Prefs.setWake(c, on)
        h.post { if (on) WakeWordService.tryStart(c, startPaused = true) else WakeWordService.stop(c) }
    }
    @JavascriptInterface fun saveFile(b64: String, name: String?, mime: String?): String {
        if (!ok()) return err("not allowed")
        return try {
            val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
            if (bytes.size > 25_000_000) return err("file too large")
            val uri = FileSaver.save(c, bytes, name ?: "FREYA-file", mime ?: "application/octet-stream")
            JSONObject().put("ok", true).put("uri", uri.toString()).toString()
        } catch (e: Exception) { err("could not save: " + (e.message ?: "error")) }
    }
    @JavascriptInterface fun phoneToday(): String {
        if (!ok()) return err("not allowed")
        return try { Aware.liveToday(c).toString() } catch (e: Exception) { err("unavailable") }
    }
    // Local "your section is ready" notification (scheduled when a section build starts).
    @JavascriptInterface fun notifyAt(at: Double, title: String?, body: String?, path: String?): String {
        if (!ok()) return err("not allowed")
        return try { ReadyReceiver.schedule(c, at.toLong(), title ?: "Neuro", body ?: "", path ?: "/"); JSONObject().put("ok", true).toString() } catch (e: Exception) { err("could not schedule") }
    }
    @JavascriptInterface fun cancelNotify(path: String?): String {
        if (!ok()) return err("not allowed")
        ReadyReceiver.cancel(c, path ?: "/"); return JSONObject().put("ok", true).toString()
    }
    // ---- Limited, opt-in listening (Neuro "Learning you" windows) ----
    /** The web Settings mirror: which windows he allowed, and the evening check-in time (HH:MM). */
    @JavascriptInterface fun setLearning(json: String?): String {
        if (!ok()) return err("not allowed")
        return try {
            val o = JSONObject(json ?: "{}")
            val e = Prefs.app(c).edit().putBoolean("learn_conv", o.optBoolean("conversations")).putBoolean("learn_checkins", o.optBoolean("checkins"))
                .putBoolean("learn_sleep", o.optBoolean("sleep"))
            val t = o.optString("checkin_time", "21:00"); if (Regex("^([01]\\d|2[0-3]):[0-5]\\d$").matches(t)) e.putString("checkin_time", t)
            e.apply()
            if (!o.optBoolean("sleep") && SleepFocus.active) SleepFocus.stop(c, "allowance turned off")
            CheckIn.schedule(c)
            JSONObject().put("ok", true).toString()
        } catch (x: Exception) { err("bad settings") }
    }
    @JavascriptInterface fun setNeuroMode(mode: String?) { if (ok()) { SleepFocus.setMode(c, (mode ?: "").take(20)); CheckIn.schedule(c) } }
    @JavascriptInterface fun listeningStatus(): String {
        val pm = c.getSystemService(android.os.PowerManager::class.java)
        val nm = c.getSystemService(android.app.NotificationManager::class.java)
        return SleepFocus.status()
            .put("mic", c.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED)
            .put("notifications", nm.areNotificationsEnabled())
            .put("battery", pm.isIgnoringBatteryOptimizations(c.packageName))
            .put("wake", Prefs.wakeEnabled(c)).put("native_sleep", true).toString()
    }
    /** Must come from his tap in the app (Android only lets a visible app start the microphone service). */
    @JavascriptInterface fun sleepStart(): String = if (!ok()) err("not allowed") else SleepFocus.start(c).toString()
    @JavascriptInterface fun sleepStop(): String = if (!ok()) err("not allowed") else SleepFocus.stop(c, "stopped in app").toString()
    @JavascriptInterface fun sleepPending(): String = if (!ok()) "" else (SleepFocus.pending(c) ?: "")
    @JavascriptInterface fun sleepClear() { if (ok()) SleepFocus.clearPending(c) }
    @JavascriptInterface fun openListeningSetup() {
        h.post { c.startActivity(Intent(c, SettingsActivity::class.java).putExtra("section", "listening").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
    @JavascriptInterface fun openSettings() {
        h.post { c.startActivity(Intent(c, SettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
}
