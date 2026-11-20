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
        private const val RC_MIC = 1; private const val RC_GEO = 2; private const val RC_FIRST = 3
    }

    private lateinit var web: WebView
    private var pendingMic: PermissionRequest? = null
    private var geoCb: GeolocationPermissions.Callback? = null
    private var geoOrigin: String? = null
    @Volatile private var onOurSite = true
    @Volatile private var inSession = false

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
        val wake = intent.getBooleanExtra(EXTRA_WAKE, false)
        if (wake) overLock(true)

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
        web.addJavascriptInterface(Bridge(), "FreyaAndroid")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                val u = r.url
                if (u.scheme == "https" && u.host == HOST) return false
                // Anything else (Google sign-in, links) opens in the phone's browser.
                try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (e: Exception) {}
                return true
            }
            override fun onPageStarted(v: WebView, url: String?, f: android.graphics.Bitmap?) {
                onOurSite = Uri.parse(url ?: "").host == HOST
            }
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

        if (b == null) web.loadUrl(BASE_URL + if (wake) "/?wake=1" else "/") else web.restoreState(b)

        val p = Prefs.app(this)
        if (!p.getBoolean("firstRun", false)) {
            p.edit().putBoolean("firstRun", true).apply()
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS), RC_FIRST)
        }
    }

    private fun overLock(on: Boolean) {
        setShowWhenLocked(on); setTurnScreenOn(on)
    }

    override fun onNewIntent(i: Intent) {
        super.onNewIntent(i); setIntent(i)
        if (i.getBooleanExtra(EXTRA_WAKE, false)) {
            overLock(true)
            web.evaluateJavascript("window.freyaWake ? window.freyaWake() : location.replace('/?wake=1')", null)
        }
    }

    override fun onResume() {
        super.onResume()
        WakeWordService.activityVisible = true
        getSystemService(NotificationManager::class.java).cancel(6)
        // Mic belongs to the live session while FREYA is on screen.
        if (Prefs.wakeEnabled(this)) WakeWordService.tryStart(this, startPaused = true)
    }

    override fun onStop() {
        super.onStop()
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

    /** window.FreyaAndroid — only answers while the FREYA site itself is loaded. */
    inner class Bridge {
        private fun ok() = onOurSite
        @JavascriptInterface fun isApp(): Boolean = true
        @JavascriptInterface fun version(): String = packageManager.getPackageInfo(packageName, 0).versionName ?: ""

        @JavascriptInterface fun setAlarm(at: Double, label: String?): String {
            if (!ok()) return err("not allowed")
            val t = at.toLong()
            if (t < System.currentTimeMillis() - 1000) return err("time is in the past")
            if (t > System.currentTimeMillis() + 400L * 86_400_000L) return err("too far ahead")
            val a = AlarmScheduler.set(this@MainActivity, t, label?.ifBlank { null } ?: "Alarm")
            return a.json().put("ok", true).put("exact", AlarmScheduler.canExact(this@MainActivity)).toString()
        }
        @JavascriptInterface fun cancelAlarm(id: String?): String {
            if (!ok()) return err("not allowed")
            val list = AlarmStore.all(this@MainActivity)
            val targets = if (id == null || id == "all") list else list.filter { it.id.toString() == id }
            targets.forEach { AlarmScheduler.remove(this@MainActivity, it.id) }
            return JSONObject().put("ok", targets.isNotEmpty()).put("cancelled", targets.size).toString()
        }
        @JavascriptInterface fun listAlarms(): String {
            if (!ok()) return "[]"
            val arr = JSONArray(); AlarmStore.all(this@MainActivity).forEach { arr.put(it.json()) }; return arr.toString()
        }
        @JavascriptInterface fun sessionActive(on: Boolean) {
            inSession = on
            runOnUiThread {
                volumeControlStream = if (on) AudioManager.STREAM_VOICE_CALL else AudioManager.USE_DEFAULT_STREAM_TYPE
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            if (on) WakeWordService.pause()
        }
        @JavascriptInterface fun wakeWordEnabled(): Boolean = Prefs.wakeEnabled(this@MainActivity)
        @JavascriptInterface fun setWakeWord(on: Boolean) {
            if (!ok()) return
            Prefs.setWake(this@MainActivity, on)
            runOnUiThread { if (on) WakeWordService.tryStart(this@MainActivity, startPaused = true) else WakeWordService.stop(this@MainActivity) }
        }
        @JavascriptInterface fun openSettings() { runOnUiThread { startActivity(Intent(this@MainActivity, SettingsActivity::class.java)) } }
        private fun err(m: String) = JSONObject().put("ok", false).put("error", m).toString()
    }
}
