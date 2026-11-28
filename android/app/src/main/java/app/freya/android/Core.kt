package app.freya.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

const val BASE_URL = "https://freya-black.vercel.app"
const val HOST = "freya-black.vercel.app"

object Prefs {
    // Normal (credential-protected) prefs for app settings.
    fun app(c: Context): SharedPreferences = c.getSharedPreferences("freya", Context.MODE_PRIVATE)
    fun wakeEnabled(c: Context) = app(c).getBoolean("wake", false)
    fun setWake(c: Context, on: Boolean) = app(c).edit().putBoolean("wake", on).apply()
    fun learning(c: Context) = app(c).let { mapOf("conversations" to it.getBoolean("learn_conv", false), "checkins" to it.getBoolean("learn_checkins", false), "sleep" to it.getBoolean("learn_sleep", false)) }
}

object Channels {
    const val LISTEN = "listen"
    const val LISTEN_ON = "listening"
    const val WAKE = "wake"
    const val ALARM = "alarm"
    const val INFO = "info"
    const val NUDGE = "nudge"
    fun ensure(c: Context) {
        val nm = c.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(LISTEN, "Wake word", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Shown while Freya listens for her name"; setShowBadge(false)
        })
        nm.createNotificationChannel(NotificationChannel(LISTEN_ON, "Listening indicator", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Always shown while Freya listens in a window you started (Sleep Focus), with a Stop button"; setShowBadge(false)
        })
        nm.createNotificationChannel(NotificationChannel(WAKE, "Wake-up", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Opens Neuro when you say her name"; setSound(null, null); setShowBadge(false)
        })
        nm.createNotificationChannel(NotificationChannel(ALARM, "Alarms", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Alarms set by Freya"; setSound(null, null); enableVibration(false); setBypassDnd(true)
        })
        nm.createNotificationChannel(NotificationChannel(INFO, "General", NotificationManager.IMPORTANCE_DEFAULT))
        nm.createNotificationChannel(NotificationChannel(NUDGE, "Gentle nudges", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Short nudges from Freya about long scrolling, late nights and sitting still"
        })
    }
}

data class Alarm(val id: Int, val at: Long, val label: String) {
    fun json(): JSONObject = JSONObject().put("id", id).put("at", at).put("label", label)
}

/** Alarms live in device-protected storage so they can ring after a reboot, before first unlock. */
object AlarmStore {
    private fun p(c: Context): SharedPreferences =
        c.createDeviceProtectedStorageContext().getSharedPreferences("alarms", Context.MODE_PRIVATE)

    @Synchronized fun all(c: Context): List<Alarm> {
        val arr = try { JSONArray(p(c).getString("list", "[]")) } catch (e: Exception) { JSONArray() }
        return (0 until arr.length()).map { val o = arr.getJSONObject(it); Alarm(o.getInt("id"), o.getLong("at"), o.optString("label", "Alarm")) }
    }
    @Synchronized private fun save(c: Context, list: List<Alarm>) {
        val arr = JSONArray(); list.sortedBy { it.at }.forEach { arr.put(it.json()) }
        p(c).edit().putString("list", arr.toString()).commit()
    }
    @Synchronized fun add(c: Context, at: Long, label: String): Alarm {
        val id = p(c).getInt("next", 1); p(c).edit().putInt("next", id + 1).commit()
        val a = Alarm(id, at, label.take(80)); save(c, all(c) + a); return a
    }
    @Synchronized fun remove(c: Context, id: Int): Alarm? {
        val list = all(c); val a = list.find { it.id == id } ?: return null
        save(c, list - a); return a
    }
    fun get(c: Context, id: Int) = all(c).find { it.id == id }
}
