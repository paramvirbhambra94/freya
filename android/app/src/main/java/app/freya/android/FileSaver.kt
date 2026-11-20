package app.freya.android

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.widget.Toast

/** Saves bytes into the public Downloads folder (MediaStore, no storage permission) and offers Open / Share. */
object FileSaver {
    fun save(c: Context, bytes: ByteArray, name: String, mime: String): Uri {
        val safe = name.replace(Regex("[^\\w. -]"), "_").take(80).ifBlank { "FREYA-file" }
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, safe)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val r = c.contentResolver
        val uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("no Downloads")
        r.openOutputStream(uri)!!.use { it.write(bytes) }
        values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0); r.update(uri, values, null, null)
        notify(c, uri, safe, mime)
        Handler(Looper.getMainLooper()).post { Toast.makeText(c, "Saved to Downloads: $safe", Toast.LENGTH_LONG).show() }
        return uri
    }

    private fun notify(c: Context, uri: Uri, name: String, mime: String) {
        Channels.ensure(c)
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val open = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        val share = Intent.createChooser(Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Share $name").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val n = Notification.Builder(c, Channels.INFO)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Saved to Downloads")
            .setContentText(name)
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(c, 21, open, flags))
            .addAction(Notification.Action.Builder(null, "Open", PendingIntent.getActivity(c, 21, open, flags)).build())
            .addAction(Notification.Action.Builder(null, "Share", PendingIntent.getActivity(c, 22, share, flags)).build())
            .build()
        try { c.getSystemService(NotificationManager::class.java).notify(21, n) } catch (e: SecurityException) {}
    }
}
