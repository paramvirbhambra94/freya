package app.freya.android

import android.Manifest
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
import org.vosk.android.RecognitionListener
import org.vosk.android.SpeechService
import org.vosk.android.StorageService

/**
 * Offline wake word ("Freya") using Vosk with a tiny grammar. No network, no API key.
 * Similar-sounding decoy words absorb near-misses so "prayer"/"player"/"fire" don't wake her.
 */
class WakeWordService : Service(), RecognitionListener {
    companion object {
        private const val TAG = "FreyaWake"
        private const val ACTION_OFF = "off"
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
    }

    private val h = Handler(Looper.getMainLooper())
    private var model: Model? = null
    private var speech: SpeechService? = null
    private var paused = false
    private var lastTrigger = 0L
    private val failsafe = Runnable { if (!activityVisible && !Overlay.showing) resume() }

    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(i: Intent?, flags: Int, startId: Int): Int {
        if (i?.action == ACTION_OFF) { Prefs.setWake(this, false); shutdown(); return START_NOT_STICKY }
        try {
            startForeground(1, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } catch (e: Exception) {
            Log.w(TAG, "foreground refused", e); BootReceiver.notifyTapToResume(this); stopSelf(); return START_NOT_STICKY
        }
        instance = this
        paused = i?.getBooleanExtra("paused", false) ?: false
        if (model == null) loadModel() else if (!paused) listen()
        return START_STICKY
    }

    private fun buildNotification(): Notification {
        Channels.ensure(this)
        val open = PendingIntent.getActivity(this, 3, Intent(this, SettingsActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val off = PendingIntent.getService(this, 4, Intent(this, WakeWordService::class.java).setAction(ACTION_OFF), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, Channels.LISTEN)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("FREYA is listening for her name")
            .setContentText("Say “Freya”. Audio stays on your phone.")
            .setOngoing(true).setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Turn off", off).build())
            .build()
    }

    private fun loadModel() {
        StorageService.unpack(this, "model-en-us", "model", { m ->
            model = m; if (!paused) listen()
        }, { e -> Log.e(TAG, "model unpack failed", e); shutdown() })
    }

    @Synchronized private fun listen() {
        val m = model ?: return
        if (speech != null) return
        try {
            val rec = Recognizer(m, 16000f, GRAMMAR).apply { setWords(true) }
            speech = SpeechService(rec, 16000f).also { it.startListening(this) }
        } catch (e: Exception) { Log.e(TAG, "listen failed", e); speech = null; h.postDelayed({ if (!paused) listen() }, 5000) }
    }

    @Synchronized private fun stopListening() {
        speech?.let { try { it.stop(); it.shutdown() } catch (e: Exception) {} }
        speech = null
    }

    fun pause() { h.post { paused = true; h.removeCallbacks(failsafe); stopListening() } }
    fun resume() { h.post { if (!Prefs.wakeEnabled(this)) return@post; paused = false; listen() } }

    fun shutdown() {
        h.post {
            stopListening(); model?.close(); model = null; instance = null
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
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
        paused = true; stopListening()   // free the mic for the live session
        val pm = getSystemService(PowerManager::class.java)
        val locked = getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked || !pm.isInteractive
        // Phone unlocked and in another app: float FREYA over it (needs "Appear on top").
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
            .setSmallIcon(R.drawable.ic_stat).setContentTitle("FREYA").setContentText("I'm here.")
            .setCategory(Notification.CATEGORY_CALL).setVisibility(Notification.VISIBILITY_PUBLIC)
            .setFullScreenIntent(pi, true).setContentIntent(pi).setAutoCancel(true).setTimeoutAfter(30_000)
            .addAction(Notification.Action.Builder(null, "Talk", pi).build()).build()
        try { getSystemService(NotificationManager::class.java).notify(6, n) } catch (e: SecurityException) {}
        try { startActivity(i) } catch (e: Exception) {}  // works directly when "display over other apps" is allowed
        h.removeCallbacks(failsafe); h.postDelayed(failsafe, 45_000) // if she never opened, listen again
    }

    override fun onPartialResult(hyp: String?) {}
    override fun onResult(hyp: String?) = check(hyp)
    // (Listening continues while other apps are open; if another app takes the mic, Android gives us silence and we carry on.)
    override fun onFinalResult(hyp: String?) = check(hyp)
    override fun onError(e: Exception?) { Log.w(TAG, "error", e); stopListening(); h.postDelayed({ if (!paused) listen() }, 3000) }
    override fun onTimeout() { stopListening(); if (!paused) listen() }

    override fun onDestroy() { stopListening(); instance = null; super.onDestroy() }
}
