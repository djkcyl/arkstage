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
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the app process alive WHILE downloading or playing,
 * so Android's background limits don't freeze/kill the Rust workers. Started, refined
 * and stopped on demand by the frontend via Rust (see android_service.rs) — it does
 * NOT run while the app is idle, so there's no permanent notification. Posts an
 * ongoing notification (required for a foreground service, and the user-visible
 * keep-alive indicator) whose title/text/progress come from the start Intent's
 * extras, and holds a wakelock only while actively downloading.
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
    private const val WAKELOCK_TAG = "arkstage:download"
    // Safety cap: if progress updates stop arriving (e.g. the webview is frozen and
    // never reports completion), the wakelock auto-releases instead of draining the
    // battery forever. Each busy progress tick re-acquires it, refreshing the timer.
    private const val WAKELOCK_TIMEOUT_MS = 10 * 60 * 1000L
  }

  private var wakeLock: PowerManager.WakeLock? = null

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

    // A foreground service stops the process from being KILLED, but on a sleeping
    // device the CPU still suspends (Doze), freezing the Rust download/index work —
    // that's why downloads stalled in the background while the notification stayed.
    // Hold a partial wakelock only while busy (indexing/downloading); release it
    // when idle/reading so we don't drain the battery for the whole session.
    if (busy) acquireWakeLock() else releaseWakeLock()

    val builder =
      NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle(title)
        .setContentText(text)
        // text may carry a "\n" (flavor line + progress line); BigTextStyle renders
        // both lines when the notification is expanded (collapsed shows the first).
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
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

  override fun onDestroy() {
    releaseWakeLock()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  /**
   * Keep the CPU awake while a download/index is active so it can't be Doze-frozen.
   * Re-acquiring with a timeout on every busy tick refreshes the safety timer, so a
   * steadily-progressing job stays awake while a silently-stalled one self-releases.
   */
  private fun acquireWakeLock() {
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    val lock =
      wakeLock
        ?: pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).also {
          it.setReferenceCounted(false)
          wakeLock = it
        }
    lock.acquire(WAKELOCK_TIMEOUT_MS)
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

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
