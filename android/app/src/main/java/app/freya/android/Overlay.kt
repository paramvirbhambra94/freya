package app.freya.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout

/**
 * Floating FREYA panel over whatever app is open (needs "Appear on top").
 * Runs a live voice session in a compact WebView; closes itself when the session ends.
 */
object Overlay {
    private const val TAG = "FreyaOverlay"
    private val h = Handler(Looper.getMainLooper())
    private var root: LinearLayout? = null
    private var web: WebView? = null
    private var params: WindowManager.LayoutParams? = null
    private var sessionStarted = false
    @Volatile private var ourSite = true
    val showing get() = root != null

    private val noSession = Runnable { if (!sessionStarted) close() }

    private fun dp(c: Context, v: Int) = (v * c.resources.displayMetrics.density).toInt()

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility", "JavascriptInterface")
    fun show(c: Context, nudge: String? = null): Boolean {
        if (root != null) return true
        return try {
            val wm = c.getSystemService(WindowManager::class.java)
            sessionStarted = false
            val panel = object : LinearLayout(c) {
                override fun dispatchKeyEvent(e: KeyEvent): Boolean {
                    val k = e.keyCode
                    if (k == KeyEvent.KEYCODE_VOLUME_UP || k == KeyEvent.KEYCODE_VOLUME_DOWN) {
                        if (e.action == KeyEvent.ACTION_DOWN) volume(c, k == KeyEvent.KEYCODE_VOLUME_UP)
                        return true
                    }
                    if (k == KeyEvent.KEYCODE_BACK) { if (e.action == KeyEvent.ACTION_UP) close(); return true }
                    return super.dispatchKeyEvent(e)
                }
            }.apply {
                orientation = LinearLayout.VERTICAL
                val pad = dp(c, 10); setPadding(pad, pad, pad, pad)
                background = GradientDrawable().apply {
                    setColor(Color.parseColor("#F20B0805")); cornerRadius = dp(c, 24).toFloat()
                    setStroke(dp(c, 1), Color.parseColor("#59E8B45A"))
                }
                elevation = dp(c, 12).toFloat()
            }
            val w = WebView(c).apply {
                setBackgroundColor(Color.TRANSPARENT)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.mediaPlaybackRequiresUserGesture = false
                settings.userAgentString = settings.userAgentString + " FreyaAndroid/overlay"
                CookieManager.getInstance().setAcceptCookie(true)
                addJavascriptInterface(FreyaBridge(c, { ourSite }) { on ->
                    if (on) { sessionStarted = true; h.removeCallbacks(noSession) }
                    else if (sessionStarted) h.postDelayed({ close() }, 1200)
                }, "FreyaAndroid")
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                        if (r.url.scheme == "https" && r.url.host == HOST) return false
                        try { c.startActivity(Intent(Intent.ACTION_VIEW, r.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (e: Exception) {}
                        close(); return true
                    }
                    override fun onPageStarted(v: WebView, url: String?, f: android.graphics.Bitmap?) { ourSite = Uri.parse(url ?: "").host == HOST }
                }
                webChromeClient = object : WebChromeClient() {
                    override fun onPermissionRequest(req: PermissionRequest) {
                        h.post {
                            val mic = c.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                            if (req.origin.host == HOST && mic && req.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                                req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else req.deny()
                        }
                    }
                }
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(c, 150))
                loadUrl("$BASE_URL/?wake=1&mini=1" + (if (nudge != null) "&nudge=" + Uri.encode(nudge) else ""))
            }
            panel.addView(w)
            val row = LinearLayout(c).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END }
            fun btn(t: String, go: () -> Unit) = Button(c).apply {
                text = t; isAllCaps = false; textSize = 14f; setTextColor(Color.parseColor("#E8B45A"))
                background = GradientDrawable().apply { setColor(Color.parseColor("#2A1C0C")); cornerRadius = dp(c, 18).toFloat() }
                setOnClickListener { go() }
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(c, 40)).apply { marginStart = dp(c, 8) }
                setPadding(dp(c, 16), 0, dp(c, 16), 0)
            }
            row.addView(btn("Open FREYA") {
                close()
                c.startActivity(Intent(c, MainActivity::class.java).setAction(MainActivity.ACTION_TALK).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            })
            row.addView(btn("✕") { close() })
            panel.addView(row)

            val p = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                PixelFormat.TRANSLUCENT).apply {
                gravity = Gravity.TOP; y = dp(c, 56); horizontalMargin = 0.03f
            }
            // Tapping the app underneath hands the keyboard back to it; the panel keeps talking.
            panel.setOnTouchListener { _, e ->
                if (e.action == MotionEvent.ACTION_OUTSIDE) {
                    params?.let { lp -> lp.flags = lp.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE; try { wm.updateViewLayout(panel, lp) } catch (x: Exception) {} }
                }
                false
            }
            wm.addView(panel, p)
            root = panel; web = w; params = p
            h.postDelayed(noSession, 40_000)
            Log.i(TAG, "overlay shown")
            true
        } catch (e: Exception) { Log.w(TAG, "overlay failed", e); close(); false }
    }

    private fun volume(c: Context, up: Boolean) {
        val am = c.getSystemService(AudioManager::class.java)
        val dir = if (up) AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER
        try { am.adjustStreamVolume(AudioManager.STREAM_VOICE_CALL, dir, AudioManager.FLAG_SHOW_UI) } catch (e: Exception) {}
        try { am.adjustStreamVolume(AudioManager.STREAM_MUSIC, dir, 0) } catch (e: Exception) {}
        web?.evaluateJavascript("window.freyaVolumeKey && window.freyaVolumeKey(${if (up) 1 else -1})", null)
    }

    fun close() {
        h.removeCallbacks(noSession)
        val r = root ?: return
        root = null
        val w = web; web = null; params = null
        try { w?.loadUrl("about:blank") } catch (e: Exception) {}
        try { r.context.getSystemService(WindowManager::class.java).removeView(r) } catch (e: Exception) {}
        try { w?.destroy() } catch (e: Exception) {}
        Log.i(TAG, "overlay closed")
        WakeWordService.resume()
    }
}
