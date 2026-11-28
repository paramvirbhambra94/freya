package app.freya.android

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.TileService

/** Quick Settings tile: "Talk to Freya". */
class TalkTile : TileService() {
    @android.annotation.SuppressLint("StartActivityAndCollapseDeprecated")
    @Suppress("DEPRECATION")
    override fun onClick() {
        val i = Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_TALK).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 31, i, PendingIntent.FLAG_IMMUTABLE))
        else startActivityAndCollapse(i)
    }
}
