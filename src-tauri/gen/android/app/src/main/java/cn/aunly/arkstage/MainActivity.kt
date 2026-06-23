package cn.aunly.arkstage

import android.Manifest
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  // We handle back ourselves (below), so disable the generated WryActivity handler
  // — its WebView.canGoBack()/goBack() ignores the SPA's history.pushState entries,
  // which made one back exit the whole app instead of going up a level.
  override val handleBackNavigation: Boolean = false

  private var webView: WebView? = null

  /** Whether the system bars are currently hidden (true only on the player screen). */
  @Volatile private var immersive = false

  /** Capture the Wry WebView so the back handler can drive the SPA's JS history. */
  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Edge-to-edge keeps the WebView layout stable behind the (kept-visible) system
    // bars. The bars stay visible everywhere EXCEPT the player, which calls
    // setReaderImmersive(true) so nothing occludes the fullscreen reader.
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    applySystemBars()
    requestNotificationPermission()
    installBackHandler()
  }

  /**
   * Toggle immersive (hide status + nav bars) — invoked from Rust (`set_immersive`)
   * by the player on enter/leave. Hops to the UI thread since it touches the window.
   */
  @Suppress("unused")
  fun setReaderImmersive(enabled: Boolean) {
    immersive = enabled
    runOnUiThread { applySystemBars() }
  }

  /**
   * Hardware/gesture back → drive the React-Router history directly (its history is
   * one clean entry per UI level: home → 书架 → 章节 → 阅读器). At the home route
   * there's nothing to pop, so we let the system default exit the app. This avoids
   * the native WebView.goBack() path entirely, which mis-reports pushState history
   * (one back would exit, or need two swipes, depending on the WebView build).
   */
  private fun installBackHandler() {
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = webView ?: return finishOrDefault()
        wv.evaluateJavascript("(window.location.pathname === '/')") { atRoot ->
          if (atRoot == "true") finishOrDefault()
          else wv.evaluateJavascript("window.history.back()", null)
        }
      }

      /** Pop our callback and re-dispatch so the system performs its default back (exit). */
      private fun finishOrDefault() {
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        isEnabled = true
      }
    })
  }

  /** Re-apply bar state after a transient show (swipe) or a dialog steals focus. */
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) applySystemBars()
  }

  /**
   * Re-apply the bar state after a rotation. Entering the player rotates to landscape
   * (set_orientation) AND hides the bars (set_immersive); the rotation relayout would
   * otherwise re-show the bars after the hide, leaving the status bar on the player.
   */
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applySystemBars()
  }

  /**
   * Show the system bars everywhere, OR hide them (player only) when `immersive`.
   * Non-player screens keep both bars so pages don't look empty and the back gesture
   * commits on the first swipe (hiding the nav bar makes the first edge swipe just
   * reveal the bars — the old "double-swipe back").
   */
  private fun applySystemBars() {
    WindowInsetsControllerCompat(window, window.decorView).apply {
      if (immersive) {
        hide(WindowInsetsCompat.Type.systemBars())
        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      } else {
        show(WindowInsetsCompat.Type.systemBars())
      }
    }
  }

  /**
   * API 33+ needs runtime consent for POST_NOTIFICATIONS, otherwise the keep-alive
   * foreground-service notification is suppressed when a download/playback later
   * brings it up. Ask once on launch. The service itself is NOT started here — it
   * runs on demand (started by the frontend only while downloading or playing), so
   * there's no permanent idle notification.
   */
  private fun requestNotificationPermission() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
          PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
    }
  }
}
