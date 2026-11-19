package app.freya.android

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Full-screen alarm over the lock screen. */
class AlarmActivity : Activity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        setShowWhenLocked(true); setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val gold = Color.parseColor("#E8B45A")
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setBackgroundColor(Color.parseColor("#0B0805")); setPadding(48, 48, 48, 48)
        }
        root.addView(TextView(this).apply {
            text = SimpleDateFormat("HH:mm", Locale.UK).format(Date()); textSize = 84f; setTextColor(gold); gravity = Gravity.CENTER
            typeface = Typeface.create("sans-serif-light", Typeface.NORMAL)
        })
        root.addView(TextView(this).apply {
            text = intent.getStringExtra("label") ?: AlarmService.ringing ?: "Alarm"; textSize = 24f; setTextColor(Color.WHITE); gravity = Gravity.CENTER
            setPadding(0, 16, 0, 96)
        })
        fun btn(t: String, primary: Boolean, go: () -> Unit) = Button(this).apply {
            text = t; textSize = 22f; isAllCaps = false
            setTextColor(if (primary) Color.BLACK else gold); setBackgroundColor(if (primary) gold else Color.parseColor("#2A1C0C"))
            setOnClickListener { go() }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 180).apply { topMargin = 28 }
        }
        root.addView(btn("Dismiss", true) { AlarmService.send(this, AlarmService.ACTION_DISMISS); finish() })
        root.addView(btn("Snooze ${AlarmService.SNOOZE_MIN} min", false) { AlarmService.send(this, AlarmService.ACTION_SNOOZE); finish() })
        setContentView(root)
        AlarmService.onStopped = { runOnUiThread { finish() } }
        if (AlarmService.ringing == null && b != null) finish()
    }
    override fun onDestroy() { if (AlarmService.onStopped != null) AlarmService.onStopped = null; super.onDestroy() }
}
