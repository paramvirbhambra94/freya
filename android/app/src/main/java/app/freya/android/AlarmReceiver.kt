package app.freya.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class AlarmReceiver : BroadcastReceiver() {
    companion object { const val ACTION_FIRE = "app.freya.android.FIRE" }
    override fun onReceive(c: Context, i: Intent) {
        if (i.action != ACTION_FIRE) return
        val id = i.getIntExtra("id", -1)
        val a = AlarmStore.remove(c, id)
        AlarmService.ring(c, a?.label ?: "Alarm")
    }
}
