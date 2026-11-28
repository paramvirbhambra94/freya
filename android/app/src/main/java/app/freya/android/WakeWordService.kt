package app.freya.android

import android.Manifest
import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.StorageService

/**
 * Offline wake word ("Freya") using Vosk with a tiny grammar, plus opt-in Sleep Focus sound analysis, on ONE mic stream.
 * No network, no API key, no audio stored.
 * Similar-sounding decoy words absorb near-misses so "prayer"/"player"/"fire" don't wake her.
 */
class WakeWordService : Service() {
    companion object {
        private const val TAG = "FreyaWake"
        private const val ACTION_OFF = "off"
        const val ACTION_SLEEP_STOP = "sleep_stop"
        @Volatile var sessionLive = false
        private val GRAMMAR = """["freya","prayer","player","fire","free","fry","pray","[unk]"]"""
        private const val MIN_CONF = 0.55
        @Volatile var instance: WakeWordService? = null; private set
        @Volatile var activityVisible = false

        /** Start listening service. Returns false if Android refused (e.g. from boot on 14+). */
        fun tryStart(c: Context, startPaused: Boolean = false): Boolean {
            if (c.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false
            instance?.let { if (startPaused) it.pause() else it.resume(); return true }
            return try {
                c.startForegroundService(Intent(c, WakeWordService::class.java).putExtra("paused", startPaused)); true
            } catch (e: Exception) { Log.w(TAG, "start refused", e); false }
        }
        fun stop(c: Context) { instance?.shutdown() ?: c.stopService(Intent(c, WakeWordService::class.java)) }
        fun pause() { instance?.pause() }
        fun resume() { instance?.resume() }
        fun refresh() { instance?.refresh() }
        /** Start (or promote) the mic service for Sleep Focus. Must be called from a user-visible action. */
        fun startForSleep(c: Context): Boolean {
            if (c.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false
            instance?.let { it.refresh(); return true }
            return try { c.startForegroundService(Intent(c, WakeWordService::class.java).putExtra("paused", true)); true } catch (e: Exception) { Log.w(TAG, "start refused", e); false }
        }
    }

    private val h = Handler(Looper.getMainLooper())
    private var model: Model? = null
    private var mic: MicLoop? = null
    private var paused = false            // wake-word detection off (app on screen / live session)
    private var lastTrigger = 0L
    private val failsafe = Runnable { if (!activityVisible && !Overlay.showing) resume() }

    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(i: Intent?, flags: Int, startId: Int): Int {
        if (i?.action == ACTION_OFF) { Prefs.setWake(this, false); if (SleepFocus.active) { paused = true; refresh() } else shutdown(); return START_NOT_STICKY }
        if (i?.action == ACTION_SLEEP_STOP) { SleepFocus.stop(this, "stopped from notification"); return START_NOT_STICKY }
        try {
            startForeground(1, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } catch (e: Exception) {
            Log.w(TAG, "foreground refused", e)
            if (SleepFocus.active) SleepFocus.abort(this) else BootReceiver.notifyTapToResume(this)
            stopSelf(); return START_NOT_STICKY
        }
        instance = this
        paused = i?.getBooleanExtra("paused", paused) ?: paused
        if (!Prefs.wakeEnabled(this)) paused = true
        if (model == null && Prefs.wakeEnabled(this)) loadModel() else refresh()
        return START_STICKY
    }

    /** One persistent, visible notification for whatever the mic is doing, with a one-tap stop. */
    private fun buildNotification(): Notification {
        Channels.ensure(this)
        val open = PendingIntent.getActivity(this, 3, Intent(this, SettingsActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return if (SleepFocus.active) {
            val stop = PendingIntent.getService(this, 7, Intent(this, WakeWordService::class.java).setAction(ACTION_SLEEP_STOP), PendingIntent.FLAG_IMMUTABLE)
            Notification.Builder(this, Channels.LISTEN_ON)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(if (SleepFocus.held) "Freya · Sleep Focus paused" else "Freya is listening · Sleep Focus")
                .setContentText(if (SleepFocus.held) "Paused for Private / Salah. Nothing is recorded." else "Sound levels only, worked out on your phone. No audio is kept.")
                .setOngoing(true).setContentIntent(open).setUsesChronometer(true).setWhen(SleepFocus.startedAt)
                .addAction(Notification.Action.Builder(null, "Stop", stop).build())
                .build()
        } else {
            val off = PendingIntent.getService(this, 4, Intent(this, WakeWordService::class.java).setAction(ACTION_OFF), PendingIntent.FLAG_IMMUTABLE)
            Notification.Builder(this, Channels.LISTEN)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Freya is listening for her name")
                .setContentText("Say “Freya”. Audio stays on your phone.")
                .setOngoing(true).setContentIntent(open)
                .addAction(Notification.Action.Builder(null, "Turn off", off).build())
                .build()
        }
    }

    private fun loadModel() {
        StorageService.unpack(this, "model-en-us", "model", { m ->
            model = m; refresh()
        }, { e -> Log.e(TAG, "model unpack failed", e); model = null; refresh() })
    }

    private val wakeOn get() = !paused && Prefs.wakeEnabled(this) && model != null
    private val sleepOn get() = SleepFocus.active && !SleepFocus.held && !sessionLive

    /** Opens or closes the single microphone stream to match what is needed. Never two streams. */
    fun refresh() {
        h.post {
            val need = wakeOn || sleepOn
            if (need && mic == null) mic = MicLoop().also { it.start() }
            if (!need && mic != null) { mic?.finish(); mic = null }
            mic?.recognizer = if (wakeOn) (mic?.recognizer ?: try { Recognizer(model, 16000f, GRAMMAR).apply { setWords(true) } } catch (e: Exception) { null }) else null
            try { getSystemService(NotificationManager::class.java).notify(1, buildNotification()) } catch (e: Exception) {}
            if (!need && !Prefs.wakeEnabled(this) && !SleepFocus.active) shutdown()
        }
    }

    fun pause() { h.post { paused = true; h.removeCallbacks(failsafe); refresh() } }
    fun resume() { h.post { if (!Prefs.wakeEnabled(this)) return@post; paused = false; if (model == null) loadModel() else refresh() } }

    fun shutdown() {
        h.post {
            mic?.finish(); mic = null; model?.close(); model = null; instance = null
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
        }
    }

    /** The only AudioRecord in the app outside a live chat. Feeds the wake-word recogniser and/or the Sleep Focus analyser. */
    private inner class MicLoop : Thread("freya-mic") {
        @Volatile var recognizer: Recognizer? = null
        @Volatile private var running = true
        fun finish() { running = false; try { join(800) } catch (e: Exception) {} }
        @SuppressLint("MissingPermission")
        override fun run() {
            val rate = 16000
            val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val rec = try { AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, rate)) } catch (e: Exception) { null }
            if (rec == null || rec.state != AudioRecord.STATE_INITIALIZED) { Log.w(TAG, "mic unavailable"); rec?.release(); h.postDelayed({ mic = null; refresh() }, 5000); return }
            val buf = ShortArray(1600) // 100 ms
            try {
                rec.startRecording()
                while (running) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n <= 0) continue
                    val r = recognizer
                    if (r != null && !paused) {
                        try { if (r.acceptWaveForm(buf, n)) check(r.result) } catch (e: Exception) { Log.w(TAG, "recogniser", e) }
                    }
                    if (sleepOn) SleepFocus.feed(buf, n)  // derived numbers only; the samples are dropped right here
                }
            } catch (e: Exception) { Log.w(TAG, "mic loop", e) }
            finally { try { rec.stop() } catch (e: Exception) {}; rec.release() }
        }
    }

    private fun check(hyp: String?) {
        if (hyp == null || paused) return
        try {
            val words = JSONObject(hyp).optJSONArray("result") ?: return
            for (k in 0 until words.length()) {
                val w = words.getJSONObject(k)
                if (w.optString("word") == "freya" && w.optDouble("conf", 0.0) >= MIN_CONF) { trigger(); return }
            }
        } catch (e: Exception) {}
    }

    private fun trigger() {
        val now = System.currentTimeMillis()
        if (now - lastTrigger < 5000) return
        lastTrigger = now
        paused = true; refresh()   // free the mic for the live session
        val pm = getSystemService(PowerManager::class.java)
        val locked = getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked || !pm.isInteractive
        // Phone unlocked and in another app: float Freya over it (needs "Appear on top").
        if (!locked && android.provider.Settings.canDrawOverlays(this)) {
            Log.i(TAG, "wake: unlocked -> overlay")
            if (Overlay.show(this)) return
        }
        Log.i(TAG, "wake: locked=$locked overlay=${android.provider.Settings.canDrawOverlays(this)} -> activity/notification")
        // Wake the screen, then open FREYA over the lock screen.
        @Suppress("DEPRECATION")
        getSystemService(PowerManager::class.java).newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "freya:wake").acquire(10_000)
        val i = Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_WAKE, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pi = PendingIntent.getActivity(this, 5, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = Notification.Builder(this, Channels.WAKE)
            .setSmallIcon(R.drawable.ic_stat).setContentTitle("Freya").setContentText("I'm here.")
            .setCategory(Notification.CATEGORY_CALL).setVisibility(Notification.VISIBILITY_PUBLIC)
            .setFullScreenIntent(pi, true).setContentIntent(pi).setAutoCancel(true).setTimeoutAfter(30_000)
            .addAction(Notification.Action.Builder(null, "Talk", pi).build()).build()
        try { getSystemService(NotificationManager::class.java).notify(6, n) } catch (e: SecurityException) {}
        try { startActivity(i) } catch (e: Exception) {}  // works directly when "display over other apps" is allowed
        h.removeCallbacks(failsafe); h.postDelayed(failsafe, 45_000) // if she never opened, listen again
    }

    override fun onDestroy() { mic?.finish(); mic = null; instance = null; super.onDestroy() }
}
