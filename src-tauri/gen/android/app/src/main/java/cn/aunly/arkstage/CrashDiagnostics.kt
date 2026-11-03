package cn.aunly.arkstage

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream

/** Independent of JS and Rust: survives renderer death and records OS kill reasons. */
object CrashDiagnostics {
  private lateinit var directory: File
  private var installed = false

  @Synchronized fun init(context: Context) {
    directory = File(context.getExternalFilesDir(null) ?: context.filesDir, "logs")
    directory.mkdirs()
    if (!installed) {
      installed = true
      val previous = Thread.getDefaultUncaughtExceptionHandler()
      Thread.setDefaultUncaughtExceptionHandler { thread, error ->
        write("uncaught thread=${thread.name}\n${Log.getStackTraceString(error)}")
        previous?.uncaughtException(thread, error)
      }
    }
    write("startup version=${BuildConfig.VERSION_NAME} pid=${android.os.Process.myPid()} sdk=${Build.VERSION.SDK_INT} device=${Build.MANUFACTURER}/${Build.MODEL}")
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val memory = ActivityManager.MemoryInfo()
    manager.getMemoryInfo(memory)
    write("memory available=${memory.availMem} total=${memory.totalMem} low=${memory.lowMemory} javaMax=${Runtime.getRuntime().maxMemory()}")
    if (Build.VERSION.SDK_INT >= 30) try {
      for (exit in manager.getHistoricalProcessExitReasons(null, 0, 5)) {
        write("previous-exit time=${exit.timestamp} process=${exit.processName} reason=${exit.reason} status=${exit.status} importance=${exit.importance} pssKiB=${exit.pss} rssKiB=${exit.rss} detail=${exit.description}")
      }
    } catch (error: Exception) { write("exit-info unavailable: $error") }
  }

  @Synchronized fun write(message: String) {
    Log.i("ArkstageDiagnostics", message)
    try {
      if (!::directory.isInitialized) return
      val file = File(directory, "android.log")
      if (file.length() > 512 * 1024) {
        val previous = File(directory, "android.previous.log")
        previous.delete()
        file.renameTo(previous)
      }
      FileOutputStream(file, true).use {
        it.write("${System.currentTimeMillis()} ${message.take(16384)}\n".toByteArray(Charsets.UTF_8))
        it.fd.sync()
      }
    } catch (error: Exception) { Log.e("ArkstageDiagnostics", "persist failed", error) }
  }

  fun share(activity: Activity, source: File? = null) {
    try {
      val report = File(activity.cacheDir, "arkstage-diagnostics.txt")
      if (source != null) source.copyTo(report, overwrite = true)
      else report.writeText(listOf("diagnostics.previous.log", "diagnostics.log", "android.previous.log", "android.log", "runtime.log").joinToString("\n") { name ->
        val file = File(directory, name)
        "===== $name =====\n" + if (file.exists()) file.readText().takeLast(512 * 1024) else "(no log)"
      })
      val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", report)
      val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivity(Intent.createChooser(intent, "导出诊断日志"))
    } catch (error: Exception) {
      write("share failed: $error")
      android.widget.Toast.makeText(activity, "日志导出失败：$error", android.widget.Toast.LENGTH_LONG).show()
    }
  }
}
