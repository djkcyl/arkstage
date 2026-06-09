//! Keep bulk downloads alive when the app is backgrounded.
//!
//! Android aggressively freezes/kills background apps, which would suspend the
//! Rust download workers. While any download is active we run a tiny foreground
//! service ([`DownloadService.kt`]) that posts an ongoing notification — that
//! raises the process to foreground priority so the OS leaves it running.
//!
//! Driven from the download manager: `set_active(true)` when the first job starts,
//! `set_active(false)` when the last one finishes. No-op on non-Android targets.

#[cfg(target_os = "android")]
pub fn set_active(active: bool) {
    if let Err(e) = imp::toggle(active) {
        log::warn!("[android_service] set_active({active}) failed: {e}");
    }
}

#[cfg(not(target_os = "android"))]
pub fn set_active(_active: bool) {}

#[cfg(target_os = "android")]
mod imp {
    use jni::objects::JObject;

    pub fn toggle(active: bool) -> Result<(), String> {
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
}
