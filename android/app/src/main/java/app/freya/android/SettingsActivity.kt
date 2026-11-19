package app.freya.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView

/** One screen to switch on the wake word and grant the background permissions. */
class SettingsActivity : Activity() {
    private val gold = Color.parseColor("#E8B45A")
    private lateinit var list: LinearLayout
    private lateinit var wakeSwitch: Switch

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 96, 48, 48) }
        setContentView(ScrollView(this).apply { setBackgroundColor(Color.parseColor("#0B0805")); addView(list) })
    }

    override fun onResume() { super.onResume(); render() }

    private fun text(t: String, size: Float, color: Int = Color.WHITE, top: Int = 0) = TextView(this).apply {
        text = t; textSize = size; setTextColor(color); setPadding(0, top, 0, 8)
    }

    @SuppressLint("BatteryLife", "UseSwitchCompatOrMaterialCode")
    private fun render() {
        list.removeAllViews()
        list.addView(text("FREYA", 30f, gold))
        list.addView(text("Set her up once. Ticks show what's done.", 15f, Color.LTGRAY))

        wakeSwitch = Switch(this).apply {
            text = "Wake word “Freya” (works with the phone locked)"; textSize = 18f; setTextColor(Color.WHITE)
            isChecked = Prefs.wakeEnabled(this@SettingsActivity); setPadding(0, 48, 0, 24)
            setOnCheckedChangeListener { _, on -> setWake(on) }
        }
        list.addView(wakeSwitch)

        val pm = getSystemService(PowerManager::class.java)
        val nm = getSystemService(NotificationManager::class.java)
        row("Microphone", granted(Manifest.permission.RECORD_AUDIO)) { requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1) }
        row("Notifications", granted(Manifest.permission.POST_NOTIFICATIONS)) { requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2) }
        row("Run in background (battery: Unrestricted)", pm.isIgnoringBatteryOptimizations(packageName)) {
            open(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        }
        if (Build.VERSION.SDK_INT >= 34) row("Full-screen alerts (wake over lock screen, alarms)", nm.canUseFullScreenIntent()) {
            open(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
        }
        row("Appear on top (open instantly when unlocked)", Settings.canDrawOverlays(this)) {
            open(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }
        row("Exact alarms", AlarmScheduler.canExact(this)) {
            if (Build.VERSION.SDK_INT >= 31) open(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$packageName")))
        }
        list.addView(text("Samsung tip: Settings → Battery → Background usage limits → Never sleeping apps → add FREYA. " +
            "This stops One UI from putting her to sleep.", 14f, Color.LTGRAY, 40))
        list.addView(Button(this).apply {
            text = "Open FREYA"; isAllCaps = false; textSize = 18f; setTextColor(Color.BLACK); setBackgroundColor(gold)
            setOnClickListener { startActivity(Intent(this@SettingsActivity, MainActivity::class.java)); finish() }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 160).apply { topMargin = 48 }
        })
    }

    private fun granted(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun row(label: String, done: Boolean, go: () -> Unit) {
        list.addView(Button(this).apply {
            text = (if (done) "✓  " else "○  ") + label; isAllCaps = false; textSize = 16f; gravity = Gravity.START or Gravity.CENTER_VERTICAL
            setTextColor(if (done) gold else Color.WHITE); setBackgroundColor(Color.parseColor("#1E140A"))
            isEnabled = !done
            setOnClickListener { go() }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = 20 }
            setPadding(36, 36, 36, 36)
        })
    }

    private fun open(i: Intent) { try { startActivity(i) } catch (e: Exception) {
        try { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) } catch (e2: Exception) {} } }

    private fun setWake(on: Boolean) {
        if (on && !granted(Manifest.permission.RECORD_AUDIO)) { wakeSwitch.isChecked = false; requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 3); return }
        Prefs.setWake(this, on)
        if (on) WakeWordService.tryStart(this, startPaused = false) else WakeWordService.stop(this)
    }

    override fun onRequestPermissionsResult(rc: Int, perms: Array<out String>, res: IntArray) {
        super.onRequestPermissionsResult(rc, perms, res)
        if (rc == 3 && res.isNotEmpty() && res[0] == PackageManager.PERMISSION_GRANTED) { Prefs.setWake(this, true); WakeWordService.tryStart(this) }
        render()
    }
}
