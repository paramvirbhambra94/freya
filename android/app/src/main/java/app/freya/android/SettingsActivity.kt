package app.freya.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ComponentName
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

    override fun onResume() { super.onResume(); render(); try { Aware.schedule(this, soon = true) } catch (e: Exception) {} }

    private fun text(t: String, size: Float, color: Int = Color.WHITE, top: Int = 0) = TextView(this).apply {
        text = t; textSize = size; setTextColor(color); setPadding(0, top, 0, 8)
    }

    @SuppressLint("BatteryLife", "UseSwitchCompatOrMaterialCode")
    private fun render() {
        list.removeAllViews()
        list.addView(text("FREYA", 30f, gold))
        list.addView(text("Set her up once. Ticks show what's done.", 15f, Color.LTGRAY))
        list.addView(text("App version " + (packageManager.getPackageInfo(packageName, 0).versionName ?: "?"), 14f, gold))

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
        // ---- Phone awareness (all opt-in) ----
        list.addView(text("Phone awareness", 22f, gold, 56))
        list.addView(text("Optional. Lets FREYA learn your phone and activity habits and give gentle nudges. " +
            "She only keeps totals (minutes per app, steps, how many notifications), never message content. Each item is separate.", 14f, Color.LTGRAY))
        row("Usage access (screen time per app, unlocks)", Aware.hasUsage(this)) {
            open(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:$packageName")), Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
        }
        row("Physical activity (steps, sitting still)", granted(Manifest.permission.ACTIVITY_RECOGNITION)) {
            requestPermissions(arrayOf(Manifest.permission.ACTIVITY_RECOGNITION), 4)
        }
        row("Notification access (counts only, never content)", Aware.hasNotif(this)) {
            open(Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                ComponentName(this, FreyaNotifListener::class.java).flattenToString()), Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        list.addView(switch("Gentle nudges (max ${Nudger.MAX_PER_DAY} a day)", Aware.nudgesOn(this)) { Aware.p(this).edit().putBoolean("nudges", it).apply() })
        list.addView(switch("Say nudges out loud (needs Appear on top)", Aware.spokenOn(this)) { Aware.p(this).edit().putBoolean("spoken", it).apply() })
        val work = Aware.workApps(this)
        plain("Work apps, never nudged: " + (if (work.isEmpty()) "none yet" else work.joinToString(", ") { Aware.label(this, it) })) { pickWork() }
        val qh = Aware.quietHours(this)
        plain("Quiet hours: " + (qh?.let { "%02d:%02d–%02d:%02d".format(it.first / 60, it.first % 60, it.second / 60, it.second % 60) } ?: "off") +
            " (she never nudges during salah, meetings or private mode)") { pickQuiet() }
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

    private fun open(i: Intent, fallback: Intent? = null) { try { startActivity(i) } catch (e: Exception) {
        try { startActivity(fallback ?: Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) } catch (e2: Exception) {} } }

    @SuppressLint("UseSwitchCompatOrMaterialCode")
    private fun switch(label: String, on: Boolean, set: (Boolean) -> Unit) = Switch(this).apply {
        text = label; textSize = 16f; setTextColor(Color.WHITE); isChecked = on; setPadding(0, 32, 0, 8)
        setOnCheckedChangeListener { _, v -> set(v) }
    }
    private fun plain(label: String, go: () -> Unit) {
        list.addView(Button(this).apply {
            text = label; isAllCaps = false; textSize = 15f; gravity = Gravity.START or Gravity.CENTER_VERTICAL
            setTextColor(Color.WHITE); setBackgroundColor(Color.parseColor("#1E140A")); setOnClickListener { go() }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = 20 }
            setPadding(36, 30, 36, 30)
        })
    }
    private fun pickWork() {
        val i = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = packageManager.queryIntentActivities(i, 0).map { it.activityInfo.packageName }.distinct()
            .filter { it != packageName }.map { it to Aware.label(this, it) }.sortedBy { it.second.lowercase() }
        val chosen = Aware.workApps(this).toMutableSet()
        AlertDialog.Builder(this).setTitle("Work apps (never nudged)")
            .setMultiChoiceItems(apps.map { it.second }.toTypedArray(), apps.map { it.first in chosen }.toBooleanArray()) { _, idx, on ->
                if (on) chosen.add(apps[idx].first) else chosen.remove(apps[idx].first) }
            .setPositiveButton("Save") { _, _ -> Aware.setWork(this, chosen); render() }
            .setNegativeButton("Cancel", null).show()
    }
    private fun pickQuiet() {
        val opts = listOf("Off" to null, "21:00–07:00" to (21 * 60 to 7 * 60), "22:00–07:00" to (22 * 60 to 7 * 60),
            "23:00–07:00" to (23 * 60 to 7 * 60), "22:00–06:00" to (22 * 60 to 6 * 60), "Work hours 09:00–17:30" to (9 * 60 to 17 * 60 + 30))
        AlertDialog.Builder(this).setTitle("Quiet hours (no nudges)")
            .setItems(opts.map { it.first }.toTypedArray()) { _, idx ->
                val v = opts[idx].second
                Aware.p(this).edit().putInt("qs", v?.first ?: -1).putInt("qe", v?.second ?: -1).apply(); render() }
            .show()
    }

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
