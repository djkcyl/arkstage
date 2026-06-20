package cn.aunly.arkstage

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    requestNotificationPermission()
    startKeepAliveIfAllowed()
  }

  /**
   * API 33+ needs runtime consent for POST_NOTIFICATIONS, otherwise the keep-alive
   * foreground-service notification is suppressed (the service still runs, but the
   * user never sees it). Ask once on launch.
   */
  private fun requestNotificationPermission() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
          PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
    }
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    // Bring the notification up as soon as the user grants permission, instead of
    // waiting for the next state change from the webview.
    startKeepAliveIfAllowed()
  }

  /**
   * Start the always-on keep-alive foreground service natively, as soon as the app
   * launches. Doing it here (not from the webview) means the persistent notification
   * never depends on JS booting or on the notification permission being granted in
   * time; the frontend only refines its text/progress afterwards.
   */
  private fun startKeepAliveIfAllowed() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
          PackageManager.PERMISSION_GRANTED) {
      return
    }
    ContextCompat.startForegroundService(this, Intent(this, DownloadService::class.java))
  }
}
