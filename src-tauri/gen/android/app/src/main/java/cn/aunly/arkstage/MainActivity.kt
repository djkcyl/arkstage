package cn.aunly.arkstage

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Edge-to-edge keeps the WebView layout stable; we then HIDE the system bars so
    // the (landscape) reader runs fullscreen and the status bar never overlaps the
    // top button row. Orientation is locked to landscape in the manifest.
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    hideSystemBars()
    requestNotificationPermission()
  }

  /** Re-hide the bars after they're transiently shown (swipe) or a dialog steals focus. */
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) hideSystemBars()
  }

  /** Immersive fullscreen: hide status + navigation bars; a swipe reveals them transiently. */
  private fun hideSystemBars() {
    WindowInsetsControllerCompat(window, window.decorView).apply {
      hide(WindowInsetsCompat.Type.systemBars())
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
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
