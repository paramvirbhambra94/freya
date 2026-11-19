package app.freya.android

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.UserManager

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        AlarmScheduler.rescheduleAll(c)
        val unlocked = c.getSystemService(UserManager::class.java).isUserUnlocked
        if (!unlocked || i.action == Intent.ACTION_LOCKED_BOOT_COMPLETED) return
        if (i.action == "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED") return
        if (Prefs.wakeEnabled(c)) {
            // Android 14+ blocks starting a microphone service straight from boot, so we try,
            // and if refused we post a one-tap notification to switch listening back on.
            if (!WakeWordService.tryStart(c)) notifyTapToResume(c)
        }
    }

    companion object {
        fun notifyTapToResume(c: Context) {
            Channels.ensure(c)
            val pi = PendingIntent.getActivity(c, 7, Intent(c, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
            val n = Notification.Builder(c, Channels.INFO)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Tap to wake FREYA's ears")
                .setContentText("After a restart, open FREYA once so she can listen for her name again.")
                .setContentIntent(pi).setAutoCancel(true).build()
            try { c.getSystemService(NotificationManager::class.java).notify(7, n) } catch (e: SecurityException) {}
        }
    }
}
