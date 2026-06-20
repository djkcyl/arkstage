package cn.aunly.arkstage

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the app process alive for the whole session, so
 * Android's background limits don't freeze/kill the Rust workers (downloads,
 * caching). Started natively by [MainActivity] right after launch and refined by
 * the frontend via Rust (see android_service.rs) as the app's state changes.
 * Posts an ongoing notification (required for a foreground service, and the
 * user-visible keep-alive indicator) whose title/text/progress come from the
 * start Intent's extras.
 */
class DownloadService : Service() {
  companion object {
    private const val CHANNEL_ID = "prts_keepalive"
    private const val NOTIF_ID = 1001
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val EXTRA_PROGRESS = "progress"
    const val EXTRA_MAX = "max"
    const val EXTRA_INDETERMINATE = "indeterminate"
  }

  override fun onCreate() {
    super.onCreate()
    createChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotEmpty() } ?: "方舟剧场"
    val text = intent?.getStringExtra(EXTRA_TEXT)?.takeIf { it.isNotEmpty() } ?: "保持后台运行中"
    val progress = intent?.getIntExtra(EXTRA_PROGRESS, -1) ?: -1
    val max = intent?.getIntExtra(EXTRA_MAX, 0) ?: 0
    val indeterminate = intent?.getBooleanExtra(EXTRA_INDETERMINATE, false) ?: false
    val busy = max > 0 || indeterminate

    val builder =
      NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle(title)
        .setContentText(text)
        // Tapping the notification brings the app back to the foreground.
        .setContentIntent(appPendingIntent())
        // A download arrow while busy, a "play" glyph while just running/reading.
        .setSmallIcon(
          if (busy) android.R.drawable.stat_sys_download else android.R.drawable.ic_media_play
        )
        .setOngoing(true)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        // Android 12+ otherwise defers the foreground-service notification (and
        // suppresses it entirely while the app is in the foreground), so it may
        // never appear. FOREGROUND_SERVICE_IMMEDIATE forces it to show right away.
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)

    when {
      max > 0 -> builder.setProgress(max, progress.coerceIn(0, max), false)
      indeterminate -> builder.setProgress(0, 0, true)
    }

    val notif: Notification = builder.build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIF_ID, notif)
    }
    // Don't auto-restart if the system kills us — the keep-alive is meaningful
    // only while the app process is alive; a lone service would just be a zombie.
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  /** Re-open (or bring to front) the single-task MainActivity when tapped. */
  private fun appPendingIntent(): PendingIntent {
    val launch =
      Intent(this, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
      }
    return PendingIntent.getActivity(
      this,
      0,
      launch,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
        val ch =
          NotificationChannel(CHANNEL_ID, "后台保活", NotificationManager.IMPORTANCE_LOW).apply {
            description = "保持应用后台常驻运行，避免下载/缓存被系统中断"
          }
        mgr.createNotificationChannel(ch)
      }
    }
  }
}
