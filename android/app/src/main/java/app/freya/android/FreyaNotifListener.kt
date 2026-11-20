package app.freya.android

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Counts notifications per app and how quickly he opens them. Metadata only:
 * app, time and the system category (message, email, social...). Never reads titles or text.
 */
class FreyaNotifListener : NotificationListenerService() {
    private val seen = HashMap<String, Long>()

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val n = sbn.notification ?: return
        if (sbn.packageName == packageName || sbn.packageName == "android" || sbn.packageName == "com.android.systemui") return
        if (sbn.isOngoing || n.flags and Notification.FLAG_GROUP_SUMMARY != 0 || n.flags and Notification.FLAG_FOREGROUND_SERVICE != 0) return
        val now = System.currentTimeMillis()
        synchronized(seen) {
            val last = seen[sbn.key]
            if (last != null && now - last < 60_000L) return   // updates to the same notification
            seen[sbn.key] = now
            if (seen.size > 500) seen.entries.removeAll { now - it.value > 6 * 3_600_000L }
        }
        val cat = n.category ?: "other"
        Aware.notifUpdate(this, sbn.packageName) { o ->
            o.put("n", o.optInt("n") + 1)
            val cats = o.optJSONObject("cats") ?: org.json.JSONObject()
            cats.put(cat, cats.optInt(cat) + 1); o.put("cats", cats)
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification, rm: RankingMap?, reason: Int) {
        if (reason != REASON_CLICK || sbn.packageName == packageName) return
        val waited = (System.currentTimeMillis() - sbn.postTime) / 1000
        Aware.notifUpdate(this, sbn.packageName) { o ->
            o.put("clicks", o.optInt("clicks") + 1)
            if (waited in 0..21_600) { o.put("rs", o.optLong("rs") + waited); o.put("rn", o.optInt("rn") + 1) }
        }
    }
}
