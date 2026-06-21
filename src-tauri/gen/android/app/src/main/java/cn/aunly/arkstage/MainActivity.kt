package cn.aunly.arkstage

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    requestNotificationPermission()
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
