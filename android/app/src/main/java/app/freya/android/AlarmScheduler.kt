package app.freya.android

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

object AlarmScheduler {
    fun canExact(c: Context): Boolean =
        Build.VERSION.SDK_INT < 31 || c.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()

    private fun firePi(c: Context, id: Int, flags: Int = PendingIntent.FLAG_UPDATE_CURRENT): PendingIntent? =
        PendingIntent.getBroadcast(c, id, Intent(c, AlarmReceiver::class.java).setAction(AlarmReceiver.ACTION_FIRE).putExtra("id", id),
            flags or PendingIntent.FLAG_IMMUTABLE)

    fun schedule(c: Context, a: Alarm) {
        val am = c.getSystemService(AlarmManager::class.java)
        val show = PendingIntent.getActivity(c, 0, Intent(c, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val pi = firePi(c, a.id)!!
        if (canExact(c)) am.setAlarmClock(AlarmManager.AlarmClockInfo(a.at, show), pi)
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, a.at, pi) // fallback: may be a few minutes late
    }

    fun cancel(c: Context, id: Int) {
        firePi(c, id, PendingIntent.FLAG_NO_CREATE)?.let { c.getSystemService(AlarmManager::class.java).cancel(it); it.cancel() }
    }

    fun set(c: Context, at: Long, label: String): Alarm { val a = AlarmStore.add(c, at, label); schedule(c, a); return a }

    fun remove(c: Context, id: Int): Boolean { cancel(c, id); return AlarmStore.remove(c, id) != null }

    /** After boot / update: re-arm future alarms, drop stale ones. */
    fun rescheduleAll(c: Context) {
        val now = System.currentTimeMillis()
        AlarmStore.all(c).forEach { a ->
            when {
                a.at > now -> schedule(c, a)
                now - a.at < 10 * 60_000L -> { AlarmStore.remove(c, a.id); AlarmService.ring(c, a.label) } // missed during reboot: ring now
                else -> AlarmStore.remove(c, a.id)
            }
        }
    }
}
