package app.freya.android

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/** Rings the alarm loudly (alarm stream, looping, vibration) until dismissed/snoozed, max 10 minutes. */
class AlarmService : Service() {
    companion object {
        const val ACTION_RING = "ring"; const val ACTION_DISMISS = "dismiss"; const val ACTION_SNOOZE = "snooze"
        const val SNOOZE_MIN = 9
        var ringing: String? = null; private set
        var onStopped: (() -> Unit)? = null
        fun ring(c: Context, label: String) =
            c.startForegroundService(Intent(c, AlarmService::class.java).setAction(ACTION_RING).putExtra("label", label))
        fun send(c: Context, action: String) = c.startService(Intent(c, AlarmService::class.java).setAction(action))
    }

    private var player: MediaPlayer? = null
    private var vib: Vibrator? = null
    private var wl: PowerManager.WakeLock? = null
    private var label = "Alarm"
    private val h = Handler(Looper.getMainLooper())
    private val timeout = Runnable { finish() }

    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(i: Intent?, flags: Int, startId: Int): Int {
        when (i?.action) {
            ACTION_RING -> start(i.getStringExtra("label") ?: "Alarm")
            ACTION_SNOOZE -> { AlarmScheduler.set(this, System.currentTimeMillis() + SNOOZE_MIN * 60_000L, label); finish() }
            ACTION_DISMISS -> finish()
            else -> if (ringing == null) stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun pi(action: String, code: Int) = PendingIntent.getService(this, code,
        Intent(this, AlarmService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    private fun start(l: String) {
        label = l
        Channels.ensure(this)
        val full = PendingIntent.getActivity(this, 11, Intent(this, AlarmActivity::class.java).putExtra("label", label)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = Notification.Builder(this, Channels.ALARM)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("⏰ " + label)
            .setContentText("FREYA alarm")
            .setCategory(Notification.CATEGORY_ALARM)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setFullScreenIntent(full, true)
            .setContentIntent(full)
            .addAction(Notification.Action.Builder(null, "Snooze $SNOOZE_MIN min", pi(ACTION_SNOOZE, 12)).build())
            .addAction(Notification.Action.Builder(null, "Dismiss", pi(ACTION_DISMISS, 13)).build())
            .build()
        startForeground(2, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        ringing = label

        wl = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "freya:alarm").apply { acquire(11 * 60_000L) }
        try { startActivity(Intent(this, AlarmActivity::class.java).putExtra("label", label).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (e: Exception) {}

        // Make sure it is actually loud: lift the alarm volume to at least 80%.
        val am = getSystemService(AudioManager::class.java)
        val max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
        if (am.getStreamVolume(AudioManager.STREAM_ALARM) < max * 8 / 10) try { am.setStreamVolume(AudioManager.STREAM_ALARM, max * 8 / 10, 0) } catch (e: Exception) {}

        player?.release()
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        player = try {
            MediaPlayer().apply {
                setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                setDataSource(this@AlarmService, uri); isLooping = true; prepare(); start()
            }
        } catch (e: Exception) { null }

        vib = (getSystemService(VibratorManager::class.java)).defaultVibrator
        try { vib?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 600), 0),
            AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build()) } catch (e: Exception) {}

        h.removeCallbacks(timeout); h.postDelayed(timeout, 10 * 60_000L)
    }

    private fun finish() {
        h.removeCallbacks(timeout)
        try { player?.stop() } catch (e: Exception) {}
        player?.release(); player = null
        vib?.cancel()
        wl?.let { if (it.isHeld) it.release() }
        ringing = null
        onStopped?.invoke()
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }

    override fun onDestroy() { if (ringing != null) finish(); super.onDestroy() }
}
