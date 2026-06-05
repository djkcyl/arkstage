use std::sync::atomic::{AtomicBool, Ordering};

/// Process-wide "allow online" flag. Default true (online-first works out of the box;
/// users on metered networks can turn it off). The prts-cdn:// handler reads this to
/// decide whether to fetch missing media or refuse with an offline marker.
pub static ALLOW_ONLINE: AtomicBool = AtomicBool::new(true);

pub fn allow_online() -> bool {
    ALLOW_ONLINE.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_allow_online(value: bool) {
    ALLOW_ONLINE.store(value, Ordering::Relaxed);
}

#[tauri::command]
pub fn get_allow_online() -> bool {
    allow_online()
}
