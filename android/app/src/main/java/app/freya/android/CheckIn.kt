package app.freya.android

import android.content.Context
import java.util.Calendar

/** Evening check-in reminder, on the phone itself (the WebView can't receive web push). Off unless he allowed check-ins. */
object CheckIn {
    const val PATH = "/?checkin=1"
    fun schedule(c: Context) {
        val p = Prefs.app(c)
        if (!p.getBoolean("learn_checkins", false)) { ReadyReceiver.cancel(c, PATH); return }
        val (hh, mm) = (p.getString("checkin_time", "21:00") ?: "21:00").split(":").map { it.toIntOrNull() ?: 0 }
        val cal = Calendar.getInstance().apply { set(Calendar.HOUR_OF_DAY, hh); set(Calendar.MINUTE, mm); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0) }
        if (cal.timeInMillis <= System.currentTimeMillis() + 60_000) cal.add(Calendar.DAY_OF_YEAR, 1)
        ReadyReceiver.schedule(c, cal.timeInMillis, "Evening check-in", "Two minutes with Freya: how today really went.", PATH)
    }
    /** Called when the reminder fires: skip in Private mode, then line up tomorrow's. */
    fun shouldPost(c: Context): Boolean {
        val p = Prefs.app(c)
        val ok = p.getBoolean("learn_checkins", false) && p.getString("neuro_mode", "") != "private"
        schedule(c)
        return ok
    }
}
