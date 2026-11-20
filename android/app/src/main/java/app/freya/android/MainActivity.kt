package app.freya.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioManager
import android.view.KeyEvent
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : Activity() {
    companion object {
        const val EXTRA_WAKE = "wake"
        const val ACTION_TALK = "app.freya.android.TALK"
        private const val RC_MIC = 1; private const val RC_GEO = 2; private const val RC_FIRST = 3
    }

    private lateinit var web: WebView
    private var pendingMic: PermissionRequest? = null
    private var geoCb: GeolocationPermissions.Callback? = null
    private var geoOrigin: String? = null
    @Volatile private var onOurSite = true
    @Volatile private var inSession = false
    // Wake-word sessions only start once FREYA is actually on screen (never talk invisibly).
    private var pendingWake = false
    private var pageLoaded = false
    private var resumed = false
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private val notShown = Runnable {
        if (pendingWake) { pendingWake = false; android.util.Log.w("FreyaWake", "not visible in time; leaving Talk notification"); WakeWordService.resume() }
    }

    private fun fireWakeIfReady() {
        if (!pendingWake || !pageLoaded || !resumed || !hasWindowFocus()) return
        pendingWake = false; handler.removeCallbacks(notShown)
        getSystemService(NotificationManager::class.java).cancel(6)
        web.evaluateJavascript("window.freyaWake ? window.freyaWake() : 0", null)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) { super.onWindowFocusChanged(hasFocus); if (hasFocus) fireWakeIfReady() }

    private fun requestWake() {
        overLock(true)
        pendingWake = true
        handler.removeCallbacks(notShown); handler.postDelayed(notShown, 10_000)
        fireWakeIfReady()
    }

    /** While she's talking, the mic puts Android in call mode, so her voice plays on the call stream. Point the volume keys at it. */
    private fun liveStream(): Int {
        val am = getSystemService(AudioManager::class.java)
        return if (inSession || am.mode == AudioManager.MODE_IN_COMMUNICATION) AudioManager.STREAM_VOICE_CALL else AudioManager.STREAM_MUSIC
    }

    /**
     * Volume keys, caught before the WebView sees them. Samsung may play her voice on the call stream or on media,
     * so we turn both, and also step her in-app volume so every press is audible.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val k = event.keyCode
        if (k != KeyEvent.KEYCODE_VOLUME_UP && k != KeyEvent.KEYCODE_VOLUME_DOWN) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN) {
            val up = k == KeyEvent.KEYCODE_VOLUME_UP
            val dir = if (up) AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER
            val am = getSystemService(AudioManager::class.java)
            val main = liveStream()
            val other = if (main == AudioManager.STREAM_VOICE_CALL) AudioManager.STREAM_MUSIC else AudioManager.STREAM_VOICE_CALL
            try { am.adjustStreamVolume(main, dir, AudioManager.FLAG_SHOW_UI) } catch (e: Exception) {}
            if (inSession) try { am.adjustStreamVolume(other, dir, 0) } catch (e: Exception) {}
            if (inSession) web.evaluateJavascript("window.freyaVolumeKey && window.freyaVolumeKey(${if (up) 1 else -1})", null)
        }
        return true
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface", "WrongConstant")
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        Channels.ensure(this)
        val wake = isWake(intent)

        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#0B0805"))
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false   // lets ?wake=1 start her voice without a tap
            setGeolocationEnabled(true)
            userAgentString = "$userAgentString FreyaAndroid/1.0"
        }
        // Passkeys / fingerprint sign-in inside the WebView (needs assetlinks.json on the site).
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(web.settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        web.addJavascriptInterface(FreyaBridge(this, { onOurSite }) { on ->
            inSession = on
            runOnUiThread {
                volumeControlStream = if (on) AudioManager.STREAM_VOICE_CALL else AudioManager.USE_DEFAULT_STREAM_TYPE
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }, "FreyaAndroid")
        // Normal https downloads (if any) go through Android's download manager into Downloads.
        web.setDownloadListener { url, ua, cd, mime, _ ->
            try {
                val u = Uri.parse(url)
                if (u.scheme != "https") return@setDownloadListener
                val name = android.webkit.URLUtil.guessFileName(url, cd, mime)
                val req = android.app.DownloadManager.Request(u).setMimeType(mime).addRequestHeader("User-Agent", ua)
                    .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, name)
                getSystemService(android.app.DownloadManager::class.java).enqueue(req)
                android.widget.Toast.makeText(this, "Downloading $name", android.widget.Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {}
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                val u = r.url
                if (u.scheme == "https" && u.host == HOST) return false
                // Anything else (Google sign-in, links) opens in the phone's browser.
                try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (e: Exception) {}
                return true
            }
            override fun onPageStarted(v: WebView, url: String?, f: android.graphics.Bitmap?) {
                onOurSite = Uri.parse(url ?: "").host == HOST; pageLoaded = false
            }
            override fun onPageFinished(v: WebView, url: String?) { pageLoaded = true; fireWakeIfReady() }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(req: PermissionRequest) {
                runOnUiThread {
                    if (req.origin.host != HOST || !req.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) { req.deny(); return@runOnUiThread }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    else { pendingMic = req; requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), RC_MIC) }
                }
            }
            override fun onGeolocationPermissionsShowPrompt(origin: String, cb: GeolocationPermissions.Callback) {
                if (Uri.parse(origin).host != HOST) { cb.invoke(origin, false, false); return }
                if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) cb.invoke(origin, true, false)
                else { geoCb = cb; geoOrigin = origin; requestPermissions(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION), RC_GEO) }
            }
        }

        if (b == null) web.loadUrl("$BASE_URL/") else web.restoreState(b)
        if (wake) requestWake()

        val p = Prefs.app(this)
        if (!p.getBoolean("firstRun", false)) {
            p.edit().putBoolean("firstRun", true).apply()
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS), RC_FIRST)
        }
    }

    private fun isWake(i: Intent?) = i != null && (i.getBooleanExtra(EXTRA_WAKE, false) || i.action == ACTION_TALK)

    private fun overLock(on: Boolean) {
        setShowWhenLocked(on); setTurnScreenOn(on)
    }

    override fun onNewIntent(i: Intent) {
        super.onNewIntent(i); setIntent(i)
        if (isWake(i)) requestWake()
    }

    override fun onResume() {
        super.onResume()
        WakeWordService.activityVisible = true
        resumed = true; fireWakeIfReady()
        getSystemService(NotificationManager::class.java).cancel(6)
        // Mic belongs to the live session while FREYA is on screen.
        if (Prefs.wakeEnabled(this)) WakeWordService.tryStart(this, startPaused = true)
    }

    override fun onPause() { super.onPause(); resumed = false }

    override fun onStop() {
        super.onStop()
        resumed = false
        WakeWordService.activityVisible = false
        overLock(false)
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Prefs.wakeEnabled(this)) WakeWordService.resume()
    }

    override fun onSaveInstanceState(o: Bundle) { super.onSaveInstanceState(o); web.saveState(o) }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (web.canGoBack()) web.goBack() else moveTaskToBack(true) }

    override fun onRequestPermissionsResult(rc: Int, perms: Array<out String>, res: IntArray) {
        super.onRequestPermissionsResult(rc, perms, res)
        val ok = res.isNotEmpty() && res[0] == PackageManager.PERMISSION_GRANTED
        when (rc) {
            RC_MIC -> { pendingMic?.let { if (ok) it.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else it.deny() }; pendingMic = null }
            RC_GEO -> { geoCb?.invoke(geoOrigin, ok, false); geoCb = null }
            RC_FIRST -> startActivity(Intent(this, SettingsActivity::class.java).putExtra("setup", true))
        }
    }

}
