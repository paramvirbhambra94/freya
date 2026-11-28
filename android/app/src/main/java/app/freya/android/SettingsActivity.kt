package app.freya.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ComponentName
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
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
import android.widget.ImageView
import android.view.View
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/** Neuro setup: wake word, listening windows, background permissions and phone awareness, in the Neuro design system. */
class SettingsActivity : Activity() {
    private val teal = Color.parseColor("#37D6CF")
    private val ice = Color.parseColor("#D8E7F3")
    private val sil = Color.parseColor("#A4B7C9")
    private val ob = Color.parseColor("#080D17")
    private val mid = Color.parseColor("#101E30")
    private val slate = Color.parseColor("#26374A")
    private lateinit var list: LinearLayout
    private lateinit var scroll: ScrollView
    private var wakeSwitch: Switch? = null
    private var listenAnchor: View? = null
    private val medium = Typeface.create("sans-serif-medium", Typeface.NORMAL)

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(16), dp(16), dp(32)) }
        scroll = ScrollView(this).apply { setBackgroundColor(ob); addView(list); isFillViewport = true }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(scroll)
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { v, ins ->
            val bars = ins.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom); WindowInsetsCompat.CONSUMED
        }
    }

    override fun onResume() {
        super.onResume(); render(); try { Aware.schedule(this, soon = true) } catch (e: Exception) {}
        if (intent?.getStringExtra("section") == "listening") scroll.post { listenAnchor?.let { scroll.smoothScrollTo(0, it.top - dp(8)) }; intent.removeExtra("section") }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun bg(fill: Int, stroke: Int = slate, r: Int = 16) = GradientDrawable().apply { setColor(fill); cornerRadius = dp(r).toFloat(); setStroke(dp(1), stroke) }
    private fun tv(t: String, sp: Float, color: Int = ice, face: Typeface = Typeface.DEFAULT) = TextView(this).apply { text = t; textSize = sp; setTextColor(color); typeface = face; setLineSpacing(0f, 1.15f) }
    private val wrap get() = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

    private fun header() {
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(4), dp(8), dp(4), dp(16)) }
        bar.addView(ImageView(this).apply { setImageResource(R.drawable.neuro_wordmark); adjustViewBounds = true; contentDescription = "Neuro" },
            LinearLayout.LayoutParams(dp(118), dp(16)))
        bar.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        bar.addView(tv("v" + (packageManager.getPackageInfo(packageName, 0).versionName ?: "?"), 12f, sil).apply {
            background = bg(Color.TRANSPARENT, slate, 999); setPadding(dp(10), dp(4), dp(10), dp(4)) })
        list.addView(bar)
        list.addView(tv("Settings", 28f, ice, medium))
        list.addView(tv("Set Neuro up once. Each item shows its status.", 14f, sil).apply { setPadding(0, dp(4), 0, dp(8)) })
    }
    private fun section(title: String, note: String? = null): LinearLayout {
        list.addView(tv(title.uppercase(), 12f, sil, medium).apply { letterSpacing = .12f; setPadding(dp(4), dp(24), 0, dp(8)) })
        if (note != null) list.addView(tv(note, 13f, sil).apply { setPadding(dp(4), 0, dp(4), dp(8)) })
        val card = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; background = bg(mid) }
        list.addView(card, wrap); return card
    }
    private fun divider(card: LinearLayout) { if (card.childCount > 0) card.addView(View(this).apply { setBackgroundColor(slate) }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1)).apply { marginStart = dp(16) }) }
    private fun rowBase(card: LinearLayout, title: String, sub: String?): LinearLayout {
        divider(card)
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = dp(56); setPadding(dp(16), dp(12), dp(12), dp(12)) }
        val txt = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        txt.addView(tv(title, 15f, ice, medium))
        if (sub != null) txt.addView(tv(sub, 12.5f, sil).apply { setPadding(0, dp(2), 0, 0) })
        row.addView(txt, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        card.addView(row, wrap); return row
    }
    private fun pill(t: String, on: Boolean) = tv(t, 12f, if (on) teal else ice, medium).apply {
        background = if (on) bg(Color.parseColor("#172C2D"), Color.parseColor("#5537D6CF"), 999) else bg(Color.TRANSPARENT, slate, 999)
        setPadding(dp(12), dp(6), dp(12), dp(6)); gravity = Gravity.CENTER
    }
    /** Permission-style row: Done pill when granted, otherwise "Set up" and tappable. */
    private fun row(card: LinearLayout, label: String, done: Boolean, sub: String? = null, go: () -> Unit) {
        val r = rowBase(card, label, sub)
        r.addView(pill(if (done) "✓ Done" else "Set up", done), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(12) })
        if (!done) { r.isClickable = true; r.setOnClickListener { go() } }
    }
    private fun info(card: LinearLayout, label: String, value: String, sub: String? = null, go: (() -> Unit)? = null) {
        val r = rowBase(card, label, sub)
        r.addView(tv(value, 13f, if (go != null) teal else sil, medium).apply { gravity = Gravity.END }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(12) })
        if (go != null) { r.isClickable = true; r.setOnClickListener { go() } }
    }
    @SuppressLint("UseSwitchCompatOrMaterialCode")
    private fun switch(card: LinearLayout, label: String, on: Boolean, sub: String? = null, set: (Boolean) -> Unit): Switch {
        val r = rowBase(card, label, sub)
        val s = Switch(this).apply {
            isChecked = on; contentDescription = label
            thumbTintList = ColorStateList(states, intArrayOf(teal, Color.parseColor("#7D8B99")))
            trackTintList = ColorStateList(states, intArrayOf(Color.parseColor("#8037D6CF"), Color.parseColor("#26374A")))
            setOnCheckedChangeListener { _, v -> set(v) }
        }
        r.addView(s, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(12) })
        r.setOnClickListener { s.toggle() }
        return s
    }
    private val states = arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf())

    @SuppressLint("BatteryLife")
    private fun render() {
        list.removeAllViews()
        header()
        val pm = getSystemService(PowerManager::class.java)
        val nm = getSystemService(NotificationManager::class.java)
        val mic = granted(Manifest.permission.RECORD_AUDIO)
        val notif = granted(Manifest.permission.POST_NOTIFICATIONS) && nm.areNotificationsEnabled()
        val battery = pm.isIgnoringBatteryOptimizations(packageName)

        val voice = section("Voice")
        wakeSwitch = switch(voice, "Wake word “Freya”", Prefs.wakeEnabled(this), "Works with the phone locked. Detected on your phone.") { setWake(it) }
        row(voice, "Microphone", mic, "For talking to Freya") { requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1) }
        row(voice, "Appear on top", Settings.canDrawOverlays(this), "Opens Freya instantly over other apps") {
            open(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }

        // ---- Limited, opt-in listening ----
        val L = Prefs.learning(this)
        val listen = section("Listening", "Freya only listens in windows you allow and start. A notification with Stop is shown the whole time. No audio is ever stored, only what she works out from it.")
        listenAnchor = list.getChildAt(list.childCount - 3)
        row(listen, "Microphone", mic, "Needed for every listening window") { requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1) }
        row(listen, "Notifications", notif, "Shows the listening indicator and its Stop button") {
            if (!granted(Manifest.permission.POST_NOTIFICATIONS)) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2)
            else open(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
        }
        Channels.ensure(this)
        val ind = nm.getNotificationChannel(Channels.LISTEN_ON)?.importance ?: 0
        row(listen, "Listening indicator", notif && ind != NotificationManager.IMPORTANCE_NONE, "Must stay on so you always see when she listens") {
            open(Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName).putExtra(Settings.EXTRA_CHANNEL_ID, Channels.LISTEN_ON))
        }
        row(listen, "Run in background", battery, "Battery: Unrestricted, so Sleep Focus works with the screen off") {
            open(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        }
        val goWeb = { startActivity(Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_PATH, "/?page=settings").addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)); finish() }
        info(listen, "Conversations", if (L["conversations"] == true) "On" else "Off", "Learns from your own words while you talk to her", goWeb)
        info(listen, "Evening check-in", if (L["checkins"] == true) (Prefs.app(this).getString("checkin_time", "21:00") ?: "21:00") else "Off", "A reminder on this phone at your time", goWeb)
        info(listen, "Sleep Focus", when { SleepFocus.active -> "Listening now"; L["sleep"] == true -> "Allowed"; else -> "Off" },
            "Start it from Mind; works with the screen off. Pauses in Private and Salah.", goWeb)
        if (SleepFocus.active) row(listen, "Stop Sleep Focus", false, "Ends the session and keeps the summary only") { SleepFocus.stop(this, "settings"); render() }

        val bgc = section("Reliability")
        if (Build.VERSION.SDK_INT >= 34) row(bgc, "Full-screen alerts", nm.canUseFullScreenIntent(), "Wake over the lock screen and alarms") {
            open(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
        }
        row(bgc, "Exact alarms", AlarmScheduler.canExact(this), "Alarms ring on time") {
            if (Build.VERSION.SDK_INT >= 31) open(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$packageName")))
        }
        list.addView(tv("Samsung: Settings → Battery → Background usage limits → Never sleeping apps → add Neuro.", 12.5f, sil).apply { setPadding(dp(4), dp(8), dp(4), 0) })

        // ---- Phone awareness (all opt-in) ----
        val aw = section("Phone awareness", "Optional. Totals only (minutes per app, steps, notification counts), never message content.")
        row(aw, "Usage access", Aware.hasUsage(this), "Screen time per app, unlocks") {
            open(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:$packageName")), Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
        }
        row(aw, "Physical activity", granted(Manifest.permission.ACTIVITY_RECOGNITION), "Steps, sitting still") {
            requestPermissions(arrayOf(Manifest.permission.ACTIVITY_RECOGNITION), 4)
        }
        row(aw, "Notification access", Aware.hasNotif(this), "Counts only, never content") {
            open(Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                ComponentName(this, FreyaNotifListener::class.java).flattenToString()), Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        switch(aw, "Gentle nudges", Aware.nudgesOn(this), "At most ${Nudger.MAX_PER_DAY} a day") { Aware.p(this).edit().putBoolean("nudges", it).apply() }
        switch(aw, "Say nudges out loud", Aware.spokenOn(this), "Needs Appear on top") { Aware.p(this).edit().putBoolean("spoken", it).apply() }
        val work = Aware.workApps(this)
        info(aw, "Work apps", if (work.isEmpty()) "Choose" else "${work.size} chosen", if (work.isEmpty()) "Never nudged" else work.joinToString(", ") { Aware.label(this, it) }) { pickWork() }
        val qh = Aware.quietHours(this)
        info(aw, "Quiet hours", qh?.let { "%02d:%02d–%02d:%02d".format(it.first / 60, it.first % 60, it.second / 60, it.second % 60) } ?: "Off",
            "Never during salah, meetings or Private") { pickQuiet() }

        list.addView(Button(this).apply {
            text = "Open Neuro"; isAllCaps = false; textSize = 16f; typeface = medium; setTextColor(ob); background = bg(teal, teal, 14); stateListAnimator = null
            setOnClickListener { startActivity(Intent(this@SettingsActivity, MainActivity::class.java)); finish() }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)).apply { topMargin = dp(32) })
    }

    private fun granted(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun open(i: Intent, fallback: Intent? = null) { try { startActivity(i) } catch (e: Exception) {
        try { startActivity(fallback ?: Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) } catch (e2: Exception) {} } }

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
        if (on && !granted(Manifest.permission.RECORD_AUDIO)) { wakeSwitch?.isChecked = false; requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 3); return }
        Prefs.setWake(this, on)
        if (on) WakeWordService.tryStart(this, startPaused = false) else WakeWordService.stop(this)
    }

    override fun onRequestPermissionsResult(rc: Int, perms: Array<out String>, res: IntArray) {
        super.onRequestPermissionsResult(rc, perms, res)
        if (rc == 3 && res.isNotEmpty() && res[0] == PackageManager.PERMISSION_GRANTED) { Prefs.setWake(this, true); WakeWordService.tryStart(this) }
        render()
    }
}
