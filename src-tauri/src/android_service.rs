//! Android keep-alive foreground service + notification — centralized driver.
//!
//! Android aggressively freezes/kills background apps, which would suspend the
//! Rust workers (downloads, caching). While there's work worth protecting we run a
//! tiny foreground service ([`DownloadService.kt`]) that posts an ongoing
//! notification — that raises the process to foreground priority so the OS leaves
//! it running.
//!
//! The notification is driven from TWO independent sources that must never fight:
//!   - the **Rust download engine** ([`set_download`]) — download progress, updated
//!     straight from the worker threads so it keeps advancing even when the WebView
//!     renderer is frozen in the background (aggressive ROMs like ColorOS do this),
//!   - the **frontend** ([`set_reading`] for playback, [`set_manifest`] for the
//!     indexing counts that only the WebView knows).
//!
//! All three feed shared state here; [`render`] picks what to show (download beats
//! reading beats idle) and posts it. The service runs ON DEMAND and is torn down
//! when everything goes idle (no permanent notification). No-op off Android.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Instant;

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const TITLE: &str = "方舟剧场";
/// Min gap between notification re-posts while download numbers tick.
const POST_THROTTLE_MS: u128 = 1000;

// --- Shared keep-alive state -------------------------------------------------
static READING: AtomicBool = AtomicBool::new(false);
static DL_ACTIVE: AtomicBool = AtomicBool::new(false);
static DL_DONE: AtomicU32 = AtomicU32::new(0);
static DL_TOTAL: AtomicU32 = AtomicU32::new(0);
static MAN_DONE: AtomicU32 = AtomicU32::new(0);
static MAN_TOTAL: AtomicU32 = AtomicU32::new(0);
static MAN_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Last posted (key, active, when) — for dedup + throttle.
static LAST: Mutex<Option<(String, bool, Instant)>> = Mutex::new(None);

/// Download engine progress (called from the worker threads — works in background).
pub fn set_download(active: bool, done: u32, total: u32) {
    DL_ACTIVE.store(active, Ordering::Relaxed);
    DL_DONE.store(done, Ordering::Relaxed);
    DL_TOTAL.store(total, Ordering::Relaxed);
    render();
}

/// Indexing (manifest) progress — only the WebView knows this, so the frontend
/// pushes it while it's running.
pub fn set_manifest(done: u32, total: u32, active: bool) {
    MAN_DONE.store(done, Ordering::Relaxed);
    MAN_TOTAL.store(total, Ordering::Relaxed);
    MAN_ACTIVE.store(active, Ordering::Relaxed);
    render();
}

/// Playback ("reading a story") state — pushed by the frontend.
pub fn set_reading(reading: bool) {
    READING.store(reading, Ordering::Relaxed);
    render();
}

// Several fields are read only in the Android `apply`; keep them on desktop too.
#[allow(dead_code)]
struct Plan {
    active: bool,
    text: String,
    progress: i32,
    max: i32,
    indeterminate: bool,
    key: String,
}

/// Decide what the notification should show: download > reading > idle (off).
fn plan() -> Plan {
    if DL_ACTIVE.load(Ordering::Relaxed) {
        let done = DL_DONE.load(Ordering::Relaxed);
        let total = DL_TOTAL.load(Ordering::Relaxed);
        let md = MAN_DONE.load(Ordering::Relaxed);
        let mt = MAN_TOTAL.load(Ordering::Relaxed);
        let ma = MAN_ACTIVE.load(Ordering::Relaxed);
        // Flavor line + explicit counts; index line only while still indexing.
        let text = if ma {
            format!("正在释放神经递质…\n索引 {md}/{mt} · 下载 {done}/{total}")
        } else {
            format!("正在释放神经递质…\n下载 {done}/{total}")
        };
        // Bar tracks the slower of index/download so it never overstates progress.
        let idx_frac = if ma && mt > 0 { md as f64 / mt as f64 } else { 1.0 };
        let dl_frac = if total > 0 { done as f64 / total as f64 } else { 0.0 };
        let progress = (idx_frac.min(dl_frac) * 100.0) as i32;
        Plan {
            active: true,
            text,
            progress,
            max: 100,
            indeterminate: false,
            key: format!("dl|{md}|{mt}|{ma}|{done}|{total}"),
        }
    } else if READING.load(Ordering::Relaxed) {
        Plan {
            active: true,
            text: "正在走过漫漫时空…".to_string(),
            progress: -1,
            max: 0,
            indeterminate: false,
            key: "read".to_string(),
        }
    } else {
        Plan {
            active: false,
            text: String::new(),
            progress: -1,
            max: 0,
            indeterminate: false,
            key: "off".to_string(),
        }
    }
}

/// Recompute and (when it changed / throttle elapsed) push the notification.
fn render() {
    let p = plan();
    {
        let mut last = LAST.lock().unwrap();
        let now = Instant::now();
        if let Some((lk, la, lt)) = last.as_ref() {
            if *lk == p.key {
                return; // identical — nothing to do
            }
            // Same active-state: throttle rapid numeric updates; an active-state
            // change (on↔off) always posts immediately.
            if *la == p.active && now.duration_since(*lt).as_millis() < POST_THROTTLE_MS {
                return;
            }
        }
        *last = Some((p.key.clone(), p.active, now));
    }
    apply(&p);
}

#[cfg(target_os = "android")]
fn apply(p: &Plan) {
    let title = Some(TITLE.to_string());
    let text = if p.text.is_empty() { None } else { Some(p.text.clone()) };
    if let Err(e) = imp::toggle(p.active, title, text, p.progress, p.max, p.indeterminate) {
        log::warn!("[android_service] update failed: {e}");
    }
}

#[cfg(not(target_os = "android"))]
fn apply(_p: &Plan) {}

/// Force the activity to landscape (player) or back to free/sensor orientation
/// (everywhere else). No-op off Android.
#[tauri::command]
pub fn set_orientation(landscape: bool) {
    #[cfg(target_os = "android")]
    {
        if let Err(e) = imp::set_orientation(landscape) {
            log::warn!("[android_service] set_orientation failed: {e}");
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = landscape;
    }
}

/// Immersive fullscreen for the player ONLY (hide status + navigation bars so the
/// reader isn't occluded); every other screen keeps the system bars visible. No-op
/// off Android.
#[tauri::command]
pub fn set_immersive(enabled: bool) {
    #[cfg(target_os = "android")]
    {
        if let Err(e) = imp::set_immersive(enabled) {
            log::warn!("[android_service] set_immersive failed: {e}");
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = enabled;
    }
}

#[cfg(target_os = "android")]
mod imp {
    use jni::objects::{JObject, JValue};
    use jni::JNIEnv;

    pub fn toggle(
        active: bool,
        title: Option<String>,
        text: Option<String>,
        progress: i32,
        max: i32,
        indeterminate: bool,
    ) -> Result<(), String> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };

        // Load the app class via the Context's ClassLoader — JNI FindClass on a
        // native thread can't see app classes, only bootstrap ones.
        let loader = env
            .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;
        let name = env
            .new_string("cn.aunly.arkstage.DownloadService")
            .map_err(|e| e.to_string())?;
        let cls = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[(&name).into()],
            )
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;

        // intent = new Intent(context, DownloadService.class)
        let intent = env
            .new_object(
                "android/content/Intent",
                "(Landroid/content/Context;Ljava/lang/Class;)V",
                &[(&context).into(), (&cls).into()],
            )
            .map_err(|e| e.to_string())?;

        if active {
            put_string(&mut env, &intent, "title", title.as_deref().unwrap_or(""))?;
            put_string(&mut env, &intent, "text", text.as_deref().unwrap_or(""))?;
            put_int(&mut env, &intent, "progress", progress)?;
            put_int(&mut env, &intent, "max", max)?;
            put_bool(&mut env, &intent, "indeterminate", indeterminate)?;
            env.call_method(
                &context,
                "startForegroundService",
                "(Landroid/content/Intent;)Landroid/content/ComponentName;",
                &[(&intent).into()],
            )
            .map_err(|e| e.to_string())?;
        } else {
            env.call_method(
                &context,
                "stopService",
                "(Landroid/content/Intent;)Z",
                &[(&intent).into()],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Call activity.setRequestedOrientation(int). SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    /// = 6 (both landscape directions); SCREEN_ORIENTATION_UNSPECIFIED = -1 (system/
    /// sensor decides — the default for non-player screens).
    pub fn set_orientation(landscape: bool) -> Result<(), String> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
        let value: i32 = if landscape { 6 } else { -1 };
        env.call_method(
            &activity,
            "setRequestedOrientation",
            "(I)V",
            &[JValue::Int(value)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Call MainActivity.setReaderImmersive(boolean) — it hops to the UI thread and
    /// hides/shows the system bars. Named to avoid the built-in Activity.setImmersive.
    pub fn set_immersive(enabled: bool) -> Result<(), String> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
        env.call_method(
            &activity,
            "setReaderImmersive",
            "(Z)V",
            &[JValue::Bool(enabled as u8)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn put_string(env: &mut JNIEnv, intent: &JObject, key: &str, val: &str) -> Result<(), String> {
        let k = env.new_string(key).map_err(|e| e.to_string())?;
        let v = env.new_string(val).map_err(|e| e.to_string())?;
        env.call_method(
            intent,
            "putExtra",
            "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
            &[(&k).into(), (&v).into()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn put_int(env: &mut JNIEnv, intent: &JObject, key: &str, val: i32) -> Result<(), String> {
        let k = env.new_string(key).map_err(|e| e.to_string())?;
        env.call_method(
            intent,
            "putExtra",
            "(Ljava/lang/String;I)Landroid/content/Intent;",
            &[(&k).into(), JValue::Int(val)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn put_bool(env: &mut JNIEnv, intent: &JObject, key: &str, val: bool) -> Result<(), String> {
        let k = env.new_string(key).map_err(|e| e.to_string())?;
        env.call_method(
            intent,
            "putExtra",
            "(Ljava/lang/String;Z)Landroid/content/Intent;",
            &[(&k).into(), JValue::Bool(val as u8)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
