package app.freya.android

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Posts "your section is ready" at the build's finish time; tapping opens that section. */
class ReadyReceiver : BroadcastReceiver() {
    companion object {
        private fun pi(c: Context, title: String, body: String, path: String) = PendingIntent.getBroadcast(c, path.hashCode(),
            Intent(c, ReadyReceiver::class.java).putExtra("title", title).putExtra("body", body).putExtra("path", path),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        fun schedule(c: Context, at: Long, title: String, body: String, path: String) {
            val am = c.getSystemService(AlarmManager::class.java)
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, maxOf(at, System.currentTimeMillis() + 5000), pi(c, title, body, path))
        }
        fun cancel(c: Context, path: String) {
            c.getSystemService(AlarmManager::class.java).cancel(pi(c, "", "", path))
            c.getSystemService(NotificationManager::class.java).cancel(path.hashCode())
        }
    }
    override fun onReceive(c: Context, i: Intent) {
        Channels.ensure(c)
        val path = i.getStringExtra("path") ?: "/"
        if (path == CheckIn.PATH && !CheckIn.shouldPost(c)) return
        val open = PendingIntent.getActivity(c, path.hashCode(), Intent(c, MainActivity::class.java).putExtra(MainActivity.EXTRA_PATH, path)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(c, Channels.INFO).setSmallIcon(R.drawable.ic_stat).setContentTitle(i.getStringExtra("title") ?: "Neuro")
            .setContentText(i.getStringExtra("body") ?: "").setContentIntent(open).setAutoCancel(true).build()
        try { c.getSystemService(NotificationManager::class.java).notify(path.hashCode(), n) } catch (e: SecurityException) {}
    }
}
