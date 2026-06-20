//! Keep the app process alive when backgrounded, with a state-driven notification.
//!
//! Android aggressively freezes/kills background apps, which would suspend the
//! Rust workers (downloads, caching). For the whole app session we run a tiny
//! foreground service ([`DownloadService.kt`]) that posts an ongoing notification
//! — that raises the process to foreground priority so the OS leaves it running.
//!
//! The baseline notification is brought up natively by `MainActivity` as soon as
//! the app is allowed to post it (so it never depends on the webview booting or
//! on the notification permission being granted in time). The frontend then
//! refines its text/progress via [`update`] as the app's state changes
//! (idle → reading → indexing/downloading). No-op on non-Android targets.

/// Update (and ensure running) the keep-alive foreground-service notification.
/// `progress < 0` and `max <= 0` means "no determinate bar"; `indeterminate`
/// requests a spinning bar instead.
#[cfg(target_os = "android")]
pub fn update(
    active: bool,
    title: Option<String>,
    text: Option<String>,
    progress: i32,
    max: i32,
    indeterminate: bool,
) {
    if let Err(e) = imp::toggle(active, title, text, progress, max, indeterminate) {
        log::warn!("[android_service] update failed: {e}");
    }
}

#[cfg(not(target_os = "android"))]
pub fn update(
    _active: bool,
    _title: Option<String>,
    _text: Option<String>,
    _progress: i32,
    _max: i32,
    _indeterminate: bool,
) {
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
