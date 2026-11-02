//! Crash-surviving diagnostics. Critical playback checkpoints are acknowledged
//! only after the journal has been flushed, before entering GPU/decoder code.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const LIMIT: u64 = 512 * 1024;
static WRITER: Mutex<()> = Mutex::new(());

fn now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn append_in(root: &Path, level: &str, message: &str) -> Result<(), String> {
    let _guard = WRITER.lock().unwrap_or_else(|e| e.into_inner());
    let dir = root.join("logs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("diagnostics.log");
    if fs::metadata(&path).is_ok_and(|m| m.len() > LIMIT) {
        let previous = dir.join("diagnostics.previous.log");
        let _ = fs::remove_file(&previous);
        fs::rename(&path, previous).map_err(|e| e.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let line = serde_json::json!({"time": now(), "level": level, "message": message.chars().take(16_384).collect::<String>()});
    writeln!(file, "{line}").map_err(|e| e.to_string())?;
    file.sync_data().map_err(|e| e.to_string())
}

pub fn init() {
    let _ = append_in(
        &crate::data_root::data_root(),
        "info",
        &format!(
            "session start: Arkstage {} pid={}",
            env!("CARGO_PKG_VERSION"),
            std::process::id()
        ),
    );
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = append_in(&crate::data_root::data_root(), "panic", &info.to_string());
        previous(info);
    }));
}

#[tauri::command]
pub fn record_diagnostic(level: String, message: String) -> Result<(), String> {
    if !["log", "info", "warn", "error"].contains(&level.as_str()) {
        return Err("invalid diagnostic level".into());
    }
    append_in(&crate::data_root::data_root(), &level, &message)
}

#[tauri::command]
pub fn read_diagnostics() -> String {
    let dir = crate::data_root::data_root().join("logs");
    let mut report = format!(
        "Arkstage {}\n日志目录: {}\n",
        env!("CARGO_PKG_VERSION"),
        dir.display()
    );
    for name in [
        "diagnostics.previous.log",
        "diagnostics.log",
        "android.previous.log",
        "android.log",
        "runtime.log",
    ] {
        if let Ok(bytes) = fs::read(dir.join(name)) {
            let start = bytes.len().saturating_sub(LIMIT as usize);
            report.push_str(&format!(
                "\n===== {name} =====\n{}",
                String::from_utf8_lossy(&bytes[start..])
            ));
        }
    }
    report
}

#[tauri::command]
pub fn export_diagnostics(extra: String) -> Result<String, String> {
    let dir = crate::data_root::data_root().join("logs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Fixed name prevents repeated exports accumulating without bound.
    let path = dir.join("diagnostic-report.txt");
    let report = format!(
        "{}\n{}",
        extra.chars().take(128_000).collect::<String>(),
        read_diagnostics()
    );
    fs::write(&path, report).map_err(|e| e.to_string())?;
    #[cfg(target_os = "android")]
    {
        use jni::objects::{JObject, JValue};
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
        let file = env
            .new_string(path.to_string_lossy().as_ref())
            .map_err(|e| e.to_string())?;
        env.call_method(
            &activity,
            "shareDiagnostics",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&file)],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_survives_reopen_and_rotates_with_last_checkpoint() {
        let root =
            std::env::temp_dir().join(format!("arkstage-diagnostics-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        append_in(&root, "info", "before GPU init").unwrap();
        let path = root.join("logs/diagnostics.log");
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("before GPU init"));
        fs::write(&path, vec![b'x'; LIMIT as usize + 1]).unwrap();
        append_in(&root, "error", "renderer terminated").unwrap();
        assert_eq!(
            fs::metadata(root.join("logs/diagnostics.previous.log"))
                .unwrap()
                .len(),
            LIMIT + 1
        );
        let line: serde_json::Value =
            serde_json::from_str(fs::read_to_string(path).unwrap().trim()).unwrap();
        assert_eq!(line["message"], "renderer terminated");
        fs::remove_dir_all(root).unwrap();
    }
}
