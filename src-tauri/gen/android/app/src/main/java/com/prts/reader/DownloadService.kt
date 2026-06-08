package com.prts.reader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the app process alive while a bulk download is
 * running, so Android's background limits don't freeze/kill the Rust download
 * workers. Started/stopped from Rust (see android_service.rs) on the first/last
 * active job. Posts an ongoing "downloading" notification (required for a
 * foreground service, and the user-visible keep-alive indicator).
 */
class DownloadService : Service() {
  companion object {
    private const val CHANNEL_ID = "prts_download"
    private const val NOTIF_ID = 1001
  }

  override fun onCreate() {
    super.onCreate()
    createChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notif: Notification =
      NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle("PRTS 资源下载")
        .setContentText("正在释放神经递质…")
        .setSmallIcon(android.R.drawable.stat_sys_download)
        .setOngoing(true)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        // Android 12+ otherwise defers the foreground-service notification (and
        // suppresses it entirely while the app is in the foreground), so a quick
        // download finishes before it ever appears. FOREGROUND_SERVICE_IMMEDIATE
        // forces it to show right away.
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIF_ID, notif)
    }
    // Don't auto-restart if the system kills us — the download ends with its job.
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
        val ch =
          NotificationChannel(CHANNEL_ID, "资源下载", NotificationManager.IMPORTANCE_LOW).apply {
            description = "下载剧情资源时保持后台运行"
          }
        mgr.createNotificationChannel(ch)
      }
    }
  }
}
