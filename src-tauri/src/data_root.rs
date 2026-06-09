//! Configurable data root: the single directory that holds `cache/`, `assets/`,
//! and `media/`. Resolution priority (first writable wins):
//!   1. `PRTS_DATA_DIR` env var          (escape hatch for tests / power users)
//!   2. user override in `config.json`   (set via the folder picker in Settings)
//!   3. the executable's own folder      (default — keeps a portable build self-contained)
//!   4. the OS app-data dir              (fallback when the exe folder isn't writable,
//!                                        e.g. installed under Program Files)
//!
//! `config.json` itself always lives in the (always-writable) app-data dir, so the
//! override survives even when the data lives next to the exe — and a fresh machine
//! with no config naturally falls back to "next to the exe", finding portable data.

use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

/// OS app-data dir: holds `config.json` and is the last-resort data root.
static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
/// Folder containing the running executable (None if it can't be determined).
static EXE_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
/// The resolved active data root.
static DATA_ROOT: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Called once at startup with the OS app-data dir.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn init(app_data: PathBuf) {
    let _ = APP_DATA_DIR.set(app_data);
    let _ = EXE_DIR.set(
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf())),
    );
    let resolved = resolve();
    *DATA_ROOT.write().unwrap() = Some(resolved);
}

/// The active data root. `cache/`, `assets/`, `media/` are subdirectories of this.
pub fn data_root() -> PathBuf {
    DATA_ROOT
        .read()
        .ok()
        .and_then(|g| g.clone())
        .or_else(|| APP_DATA_DIR.get().cloned())
        .unwrap_or_else(std::env::temp_dir)
}

fn app_data_dir() -> PathBuf {
    APP_DATA_DIR.get().cloned().unwrap_or_else(std::env::temp_dir)
}

#[cfg_attr(target_os = "android", allow(dead_code))]
fn exe_dir() -> Option<PathBuf> {
    EXE_DIR.get().cloned().flatten()
}

#[cfg_attr(target_os = "android", allow(dead_code))]
fn config_path() -> PathBuf {
    app_data_dir().join("config.json")
}

/// Can we create `dir` and write a file in it?
#[cfg_attr(target_os = "android", allow(dead_code))]
fn is_writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".prts_write_test");
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Read the persisted override path (None if unset/empty).
#[cfg_attr(target_os = "android", allow(dead_code))]
fn read_override() -> Option<PathBuf> {
    let txt = std::fs::read_to_string(config_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
    v.get("data_dir")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Persist (or clear, with None) the override path in config.json.
#[cfg_attr(target_os = "android", allow(dead_code))]
fn write_override(dir: Option<&Path>) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = match dir {
        Some(d) => serde_json::json!({ "data_dir": d.to_string_lossy() }),
        None => serde_json::json!({}),
    };
    std::fs::write(&path, serde_json::to_string_pretty(&json).unwrap_or_default())
        .map_err(|e| format!("写入配置失败: {}", e))
}

/// Resolve the data root per the documented priority.
#[cfg_attr(target_os = "android", allow(dead_code))]
fn resolve() -> PathBuf {
    if let Some(env) = std::env::var_os("PRTS_DATA_DIR") {
        let p = PathBuf::from(env);
        if !p.as_os_str().is_empty() && is_writable(&p) {
            return p;
        }
    }
    if let Some(over) = read_override() {
        if is_writable(&over) {
            return over;
        }
    }
    if let Some(exe) = exe_dir() {
        if is_writable(&exe) {
            return exe;
        }
    }
    app_data_dir()
}

/// Info for the Settings UI.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ResourceDirInfo {
    /// Active data root in use right now.
    pub current: String,
    /// True if a user override (config.json) or env var is forcing the location.
    pub is_custom: bool,
    /// The default location (the exe's folder), shown so the user knows the baseline.
    pub default_dir: String,
    /// The fallback location (OS app-data dir).
    pub fallback_dir: String,
    /// Whether the default (exe folder) is writable on this machine.
    pub default_writable: bool,
}

#[cfg(not(target_os = "android"))]
fn info() -> ResourceDirInfo {
    let default_dir = exe_dir().unwrap_or_else(app_data_dir);
    ResourceDirInfo {
        current: data_root().to_string_lossy().into_owned(),
        is_custom: read_override().is_some() || std::env::var_os("PRTS_DATA_DIR").is_some(),
        default_dir: default_dir.to_string_lossy().into_owned(),
        fallback_dir: app_data_dir().to_string_lossy().into_owned(),
        default_writable: exe_dir().map(|d| is_writable(&d)).unwrap_or(false),
    }
}

// Android: storage is fixed to the app-private external files dir. The directory
// picker is removed from the UI; report a non-custom, fixed location.
#[cfg(target_os = "android")]
fn info() -> ResourceDirInfo {
    let cur = data_root().to_string_lossy().into_owned();
    ResourceDirInfo {
        current: cur.clone(),
        is_custom: false,
        default_dir: cur.clone(),
        fallback_dir: cur,
        default_writable: true,
    }
}

#[tauri::command]
pub fn get_resource_dir() -> ResourceDirInfo {
    info()
}

/// Set a custom data root. Validates writability, persists it, and switches live.
/// Existing data is NOT moved — new downloads/cache go to the new location.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn set_resource_dir(path: String) -> Result<ResourceDirInfo, String> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("路径为空".into());
    }
    if !is_writable(&p) {
        return Err("该目录无法写入（可能需要管理员权限或路径无效）".into());
    }
    write_override(Some(&p))?;
    *DATA_ROOT.write().unwrap() = Some(p);
    Ok(info())
}

/// Clear the override and fall back to the default resolution (exe folder / app-data).
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn reset_resource_dir() -> Result<ResourceDirInfo, String> {
    write_override(None)?;
    *DATA_ROOT.write().unwrap() = Some(resolve());
    Ok(info())
}

// Android: storage location is fixed. Keep the command signatures so the frontend
// contract is unchanged, but they are no-ops that just echo the fixed info.
#[cfg(target_os = "android")]
#[tauri::command]
pub fn set_resource_dir(_path: String) -> Result<ResourceDirInfo, String> {
    Ok(info())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn reset_resource_dir() -> Result<ResourceDirInfo, String> {
    Ok(info())
}

/// Android: the app-private external files dir
/// (`/storage/emulated/0/Android/data/cn.aunly.arkstage/files`). No runtime
/// permission needed; visible to file managers; large quota; cleared on uninstall.
/// Obtained via JNI `Context.getExternalFilesDir(null)` because Tauri's path
/// resolver maps `app_data_dir()` to *internal* storage on Android.
#[cfg(target_os = "android")]
pub fn android_external_files_dir() -> Result<PathBuf, String> {
    use jni::objects::JObject;
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    // File dir = context.getExternalFilesDir(null)
    let null = JObject::null();
    let file = env
        .call_method(
            &context,
            "getExternalFilesDir",
            "(Ljava/lang/String;)Ljava/io/File;",
            &[(&null).into()],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    if file.is_null() {
        return Err("getExternalFilesDir returned null (external storage unavailable)".into());
    }
    // path = file.getAbsolutePath()
    let path = env
        .call_method(&file, "getAbsolutePath", "()Ljava/lang/String;", &[])
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
    let s: String = env
        .get_string(&jni::objects::JString::from(path))
        .map_err(|e| e.to_string())?
        .into();
    Ok(PathBuf::from(s))
}

/// Android: pin the data root to a fixed directory (the external files dir).
/// No env override, no config.json, no exe-folder logic — storage is not
/// user-configurable on Android.
#[cfg(target_os = "android")]
pub fn init_fixed(dir: PathBuf) {
    let _ = APP_DATA_DIR.set(dir.clone());
    *DATA_ROOT.write().unwrap() = Some(dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_writable_true_for_temp() {
        let d = std::env::temp_dir().join(format!("prts_dr_{}", std::process::id()));
        assert!(is_writable(&d));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn is_writable_false_for_bogus() {
        // A path under a file (not a dir) cannot be created.
        let f = std::env::temp_dir().join(format!("prts_dr_file_{}", std::process::id()));
        std::fs::write(&f, b"x").unwrap();
        let under_file = f.join("sub");
        assert!(!is_writable(&under_file));
        let _ = std::fs::remove_file(&f);
    }
}
