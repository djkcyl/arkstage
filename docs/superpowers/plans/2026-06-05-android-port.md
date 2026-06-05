# Android Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `prts-reader` (Tauri 2 + React Arknights offline story reader) to Android with full desktop feature parity except the custom resource-directory picker, producing a sideloadable debug APK while keeping a wired-but-disabled release-signing path.

**Architecture:** Single shared Tauri project. `tauri android init` scaffolds a Gradle project under `src-tauri/gen/android`. Frontend and Rust stay ~99% shared; platform divergence is isolated to: a new `src/lib/platform.ts` (wraps `@tauri-apps/plugin-os` `platform()`), a `#[cfg(target_os="android")]` branch in `src-tauri/src/data_root.rs` (fixed app-private external storage via JNI `getExternalFilesDir`), an Android asset-protocol scope, and three small mobile-UI additions (back-button interception, safe-area insets, hide the resource-dir Settings section).

**Tech Stack:** Tauri 2.10, Rust (cross-compiled to `aarch64-linux-android` + `x86_64-linux-android`), React 19 + react-router 7, Vite 8, Android SDK/NDK 27.x, Gradle (in `gen/android`), JNI via the `jni` + `ndk-context` crates (Android-only deps).

---

## Verification philosophy (read first)

This project has **no frontend unit-test runner** — its test suite is the bash harness (`scripts/test-static.sh`, `scripts/test-e2e.sh`, run via `scripts/run-tests.sh`, currently 12/12) plus Rust `#[cfg(test)]` unit tests in `data_root.rs`. The Android-specific Rust code is `#[cfg(target_os="android")]`-gated, so host `cargo test` cannot exercise it. Therefore:

- **Frontend logic** (`platform.ts`, `proxy.ts`) is verified by the TypeScript type-checker (`npm run build` → `tsc -b`) and by runtime behaviour on the emulator/device — **do not** add a vitest/jest harness (YAGNI; against project convention).
- **Desktop must not regress:** after every Rust change, `cd src-tauri && cargo test` and the existing `scripts/run-tests.sh` must still pass.
- **Android compile** is verified by `cargo check --target aarch64-linux-android` (fast) and ultimately the APK build.
- **Android runtime** is verified on a headless KVM emulator (Task 16), with a physical device as the documented fallback.

**Do NOT invent commands like `pytest`/`vitest`.** Use exactly the commands written in each task.

## Empirical-verification map (spec §9)

The 5 "verify empirically" items are confirmed by concrete tasks/steps:

| # | Item | Where verified |
|---|------|----------------|
| 1 | Custom-scheme URL form (`http://prts-cdn.localhost`?) | Task 6 (implements the prior) + Task 16 step "scheme check" (logcat + on-screen success) |
| 2 | Which API maps to external files dir / JNI needed | Task 7 step "probe" (logs the resolved path on first boot) + Task 16 |
| 3 | Asset-protocol scope for the external dir | Task 9 + Task 16 step "font/asset check" (NotoSans renders, no asset CSP block) |
| 4 | Headless emulator can render the WebView | Task 16 (pixel-variance screencap; device fallback if swiftshader fails) |
| 5 | `gen/android` VCS boundary + exact `.gitignore` | Task 3 (inspects generated inner `.gitignore`, sets root rules) |

---

## File structure (created / modified)

**Created:**
- `src/lib/platform.ts` — platform detection (wraps plugin-os, userAgent fallback).
- `src/lib/androidBack.ts` — Android hardware-back interception hook.
- `scripts/build-android.sh` — install deps → init → build debug APK → copy to root.
- `docs/android-build.md` — build/run/signing/CI-later documentation.

**Modified:**
- `.gitignore` — narrow the `src-tauri/gen/` rule so `gen/android` is tracked.
- `package.json` — add `@tauri-apps/plugin-os`.
- `src-tauri/Cargo.toml` — add `tauri-plugin-os`; Android-only `jni` + `ndk-context`.
- `src-tauri/capabilities/default.json` — add `os:default` permission.
- `src-tauri/src/lib.rs` — register os plugin; platform-split `data_root` init.
- `src-tauri/src/data_root.rs` — `#[cfg(target_os="android")]` fixed-storage branch + JNI helper; no-op set/reset on Android.
- `src-tauri/tauri.conf.json` — add Android asset-protocol scope entry.
- `src/lib/proxy.ts` — derive `PROXY_BASE` from `platform.ts`.
- `src/pages/SettingsPage.tsx` — hide the resource-directory section on Android.
- `src/pages/StoryPlayerPage.tsx` + `src/App.tsx` — wire Android back handling; safe-area on the back button.
- `src/components/DebugConsole.tsx` — safe-area inset on the bottom-left button.
- `src/styles/global.css` — safe-area helpers; edge-to-edge body padding vars.
- `src-tauri/gen/android/app/build.gradle.kts` — release signing config (env-driven, falls back to debug).
- The android memory file (after completion).

---

## Phase A — Toolchain & scaffold

### Task 1: Install NDK + Rust Android targets

**Files:** none (environment + a note appended to `docs/android-build.md` in Task 15).

- [ ] **Step 1: Add the two Rust targets (no armv7)**

Run:
```bash
rustup target add aarch64-linux-android x86_64-linux-android
```
Expected: both print "installed" (or "already installed").

- [ ] **Step 2: Install the NDK via sdkmanager**

Run:
```bash
yes | sdkmanager --sdk_root=/opt/android-sdk "ndk;27.2.12479018" "platforms;android-35" "build-tools;35.0.0"
```
Expected: exits 0; `ls /opt/android-sdk/ndk/27.2.12479018` lists the NDK (contains `toolchains/`, `source.properties`).

- [ ] **Step 3: Export NDK env for this and future shells**

Run:
```bash
export ANDROID_HOME=/opt/android-sdk
export NDK_HOME=/opt/android-sdk/ndk/27.2.12479018
export ANDROID_NDK_HOME="$NDK_HOME"
```
Expected: `echo "$NDK_HOME"` prints the path. (These get baked into `scripts/build-android.sh` in Task 13 so the build is reproducible; here they make the interactive checks below work.)

- [ ] **Step 4: Verify the cross-compiler is reachable**

Run:
```bash
ls "$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang"
```
Expected: the path exists (this is what Tauri/cargo invoke as the linker for `minSdk=24`).

- [ ] **Step 5: Commit** — nothing to commit (environment only). Skip.

---

### Task 2: Scaffold the Android Gradle project (`tauri android init`)

**Files:**
- Create (generated): `src-tauri/gen/android/**`

- [ ] **Step 1: Run the init (idempotent)**

Run from the project root:
```bash
NDK_HOME=/opt/android-sdk/ndk/27.2.12479018 \
ANDROID_NDK_HOME=/opt/android-sdk/ndk/27.2.12479018 \
ANDROID_HOME=/opt/android-sdk \
npm run tauri android init
```
Expected: prints "Generating Android Studio project..." and finishes with no error. Creates `src-tauri/gen/android/`.

- [ ] **Step 2: Verify scaffold shape**

Run:
```bash
ls src-tauri/gen/android
ls src-tauri/gen/android/app/src/main
cat src-tauri/gen/android/app/src/main/AndroidManifest.xml | head -30
```
Expected: top level has `app/`, `build.gradle.kts`, `settings.gradle`, `gradlew`, `gradle/`. `app/src/main` has `AndroidManifest.xml` and `java/` (or `kotlin/`). The manifest's `package`/applicationId derives from `com.prts.reader`, and the launcher activity is `.MainActivity`.

- [ ] **Step 3: Confirm minSdk/targetSdk and applicationId**

Run:
```bash
grep -rn "minSdk\|targetSdk\|compileSdk\|applicationId\|namespace" src-tauri/gen/android/app/build.gradle.kts
```
Expected: `applicationId = "com.prts.reader"` (or `namespace`). Record the default `minSdk`. **If `minSdk < 24`, set it to 24** in `build.gradle.kts` (`defaultConfig { minSdk = 24 }`) and re-grep to confirm. Set/confirm `targetSdk = 35` and `compileSdk = 35`.

- [ ] **Step 4: Commit** (after Task 3 fixes the gitignore — do not commit yet). Skip; commit happens in Task 3.

---

### Task 3: `.gitignore` boundary for `gen/android` (spec §1, VERIFY #5)

**Files:**
- Modify: `.gitignore:16-17`
- Inspect (generated): `src-tauri/gen/android/.gitignore`

- [ ] **Step 1: Inspect Tauri's generated inner gitignore**

Run:
```bash
cat src-tauri/gen/android/.gitignore
find src-tauri/gen -name .gitignore
```
Expected: Tauri writes `src-tauri/gen/android/.gitignore` that already ignores build outputs (typically `/app/build`, `/build`, `.gradle`, `local.properties`, `/.idea`, `/captures`, `/app/.cxx`). **Record exactly what it lists.**

- [ ] **Step 2: Narrow the root `.gitignore` so `gen/android` is tracked**

In `.gitignore`, replace the current Tauri block:
```
# Tauri
src-tauri/target/
src-tauri/gen/
```
with:
```
# Tauri
src-tauri/target/
# Generated capability schemas (regenerated by tauri build); not source.
src-tauri/gen/schemas/
# Apple scaffold (not building iOS); ignore if/when generated.
src-tauri/gen/apple/
# NOTE: src-tauri/gen/android IS version-controlled (it holds customizable
# Gradle/manifest/signing files). Its own src-tauri/gen/android/.gitignore
# excludes the build outputs (app/build, .gradle, .cxx, local.properties).
```

- [ ] **Step 3: Add any build-output patterns the inner gitignore missed**

If Step 1 showed the inner `.gitignore` does **not** cover one of these, append it there (in `src-tauri/gen/android/.gitignore`):
```
/app/build
/build
/.gradle
/app/.cxx
local.properties
/captures
/.idea
```
(Skip the ones already present — do not duplicate.)

- [ ] **Step 4: Verify the staging boundary is correct**

Run:
```bash
git add -A
git status --short | grep "gen/android" | grep -i "build\|\.gradle\|\.cxx\|local.properties" || echo "OK: no build outputs staged"
git status --short | grep "gen/android/app/build.gradle.kts" && echo "OK: gradle config tracked"
```
Expected: first command prints `OK: no build outputs staged`; second confirms `build.gradle.kts` is tracked. If a `build/` path is staged, fix the gitignore and re-run.

- [ ] **Step 5: Commit**

```bash
git add .gitignore src-tauri/gen/android src-tauri/tauri.conf.json 2>/dev/null; git add -A
git commit -m "build(android): scaffold gen/android, set minSdk24/targetSdk35, gitignore boundary"
```

---

## Phase B — First cross-compile (proves the toolchain end-to-end)

### Task 4: Build the first debug APK (unmodified app)

This proves the cross-compile + Gradle pipeline works **before** any app-logic changes. The app will not be fully functional on Android yet (proxy + storage fixes come later) — that is expected; this task only asserts an APK is produced.

**Files:** none.

- [ ] **Step 1: Build a debug APK for x86_64 (emulator ABI) only, for speed**

Run from project root:
```bash
NDK_HOME=/opt/android-sdk/ndk/27.2.12479018 \
ANDROID_NDK_HOME=/opt/android-sdk/ndk/27.2.12479018 \
ANDROID_HOME=/opt/android-sdk \
npm run tauri android build -- --apk --debug --target x86_64
```
Expected: Vite build runs, cargo cross-compiles for `x86_64-linux-android`, Gradle assembles. Finishes with a path to an `*.apk` under `src-tauri/gen/android/app/build/outputs/apk/`.

- [ ] **Step 2: Locate the APK**

Run:
```bash
find src-tauri/gen/android/app/build/outputs/apk -name "*.apk"
```
Expected: at least one `*-debug.apk` (or `*-universal-debug.apk` / `*-x86_64-debug.apk`). **If this succeeds, spec §8 "compile verification" is satisfied: the cross-compile works.**

- [ ] **Step 3: Commit** — nothing source-level changed. Skip.

---

## Phase C — Platform abstraction (frontend)

### Task 5: Add the `@tauri-apps/plugin-os` dependency (JS + Rust + permission)

**Files:**
- Modify: `package.json:15-21`
- Modify: `src-tauri/Cargo.toml:24-26`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/src/lib.rs:159`

- [ ] **Step 1: Add the JS dependency**

Run:
```bash
npm install @tauri-apps/plugin-os@^2.3.2
```
Expected: `package.json` dependencies now include `"@tauri-apps/plugin-os"`.

- [ ] **Step 2: Add the Rust plugin dependency**

In `src-tauri/Cargo.toml`, under `[dependencies]` after `tauri-plugin-dialog = "2"`, add:
```toml
tauri-plugin-os = "2"
```

- [ ] **Step 3: Register the plugin in `lib.rs`**

In `src-tauri/src/lib.rs`, find:
```rust
        .plugin(tauri_plugin_dialog::init())
```
and add the os plugin right after it:
```rust
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
```

- [ ] **Step 4: Grant the `os:default` permission**

In `src-tauri/capabilities/default.json`, add `"os:default"` to the `permissions` array (after `"dialog:default"`):
```json
    "core:image:default",
    "dialog:default",
    "os:default"
```

- [ ] **Step 5: Verify it compiles (desktop)**

Run:
```bash
cd src-tauri && cargo check && cd ..
```
Expected: compiles with no error (downloads `tauri-plugin-os`).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/capabilities/default.json src-tauri/src/lib.rs
git commit -m "feat(android): add tauri-plugin-os (js+rust+permission)"
```

---

### Task 6: `platform.ts` + proxy scheme selection (spec §3, VERIFY #1)

**Files:**
- Create: `src/lib/platform.ts`
- Modify: `src/lib/proxy.ts:8-11`

- [ ] **Step 1: Create `src/lib/platform.ts`**

```ts
import { platform as osPlatform } from "@tauri-apps/plugin-os";

export type Platform = "windows" | "macos" | "linux" | "android" | "ios" | "unknown";

let cached: Platform | null = null;

/**
 * Current platform. Prefers @tauri-apps/plugin-os `platform()` (synchronous in
 * v2); falls back to userAgent sniffing if the plugin isn't ready at the moment
 * of a very-early module-load call. Cached after first resolution.
 */
export function getPlatform(): Platform {
  if (cached) return cached;
  let p: Platform = "unknown";
  try {
    const raw = osPlatform();
    if (
      raw === "windows" ||
      raw === "macos" ||
      raw === "linux" ||
      raw === "android" ||
      raw === "ios"
    ) {
      p = raw;
    }
  } catch {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    if (ua.includes("Windows")) p = "windows";
    else if (ua.includes("Android")) p = "android";
    else if (ua.includes("Mac")) p = "macos";
    else if (ua) p = "linux";
  }
  cached = p;
  return p;
}

export const isAndroid = (): boolean => getPlatform() === "android";
export const isWindows = (): boolean => getPlatform() === "windows";

/**
 * Platforms whose WebView is Chromium-based and serves Tauri custom schemes at
 * `http://<scheme>.localhost/` instead of `<scheme>://localhost/`: Windows
 * (WebView2) and Android (system WebView).
 */
export const usesHttpLocalhostScheme = (): boolean => isWindows() || isAndroid();
```

- [ ] **Step 2: Rewrite `PROXY_BASE` in `src/lib/proxy.ts`**

Replace lines 8-11:
```ts
// On Windows WebView2 the custom scheme is served at http://{scheme}.localhost.
export const PROXY_BASE = navigator.userAgent.includes("Windows")
  ? "http://prts-cdn.localhost"
  : "prts-cdn://localhost";
```
with:
```ts
import { usesHttpLocalhostScheme } from "./platform";

// Chromium-based WebViews (Windows WebView2, Android system WebView) serve the
// custom scheme at http://{scheme}.localhost; WebKitGTK/WKWebView use {scheme}://.
export const PROXY_BASE = usesHttpLocalhostScheme()
  ? "http://prts-cdn.localhost"
  : "prts-cdn://localhost";
```
(Add the `import` at the top of the file with the existing module imports.)

- [ ] **Step 3: Type-check**

Run:
```bash
npm run build
```
Expected: `tsc -b` passes and `vite build` produces `dist/` with no error.

- [ ] **Step 4: Desktop regression — static suite still green**

Run:
```bash
bash scripts/test-static.sh
```
Expected: PASS (the static suite imports `proxy.ts`; this confirms desktop `PROXY_BASE` resolution still yields `prts-cdn://localhost` under the non-Windows fallback, and nothing throws at import).

- [ ] **Step 5: Commit**

```bash
git add src/lib/platform.ts src/lib/proxy.ts
git commit -m "feat(android): platform.ts + http-localhost scheme on Windows/Android"
```

> **Runtime confirmation of VERIFY #1** happens in Task 16 ("scheme check"): on the emulator, engine CDN requests must resolve via `http://prts-cdn.localhost/...` (visible in logcat / DevTools) and the engine UI must render. If Android unexpectedly uses a different host form, adjust `usesHttpLocalhostScheme`/`PROXY_BASE` accordingly and re-verify.

---

## Phase D — Storage (Rust, app-private external) (spec §2, VERIFY #2)

### Task 7: `data_root.rs` Android branch + JNI external-files-dir helper

**Files:**
- Modify: `src-tauri/Cargo.toml` (Android-only deps)
- Modify: `src-tauri/src/data_root.rs`
- Modify: `src-tauri/src/lib.rs:160-163`

- [ ] **Step 1: Add Android-only JNI crates to `Cargo.toml`**

In `src-tauri/Cargo.toml`, after the `[dependencies]` block, add a target-specific section:
```toml
[target.'cfg(target_os = "android")'.dependencies]
jni = "0.21"
ndk-context = "0.1"
```

- [ ] **Step 2: Add the JNI external-files-dir helper to `data_root.rs`**

Append to `src-tauri/src/data_root.rs` (before `#[cfg(test)]`):
```rust
/// Android: the app-private external files dir
/// (`/storage/emulated/0/Android/data/com.prts.reader/files`). No runtime
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
    let file = env
        .call_method(
            &context,
            "getExternalFilesDir",
            "(Ljava/lang/String;)Ljava/io/File;",
            &[(&JObject::null()).into()],
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
        .get_string(&path.into())
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
```

- [ ] **Step 3: Make `info()` / `set` / `reset` Android-correct (no-ops, fixed path)**

In `src-tauri/src/data_root.rs`, replace the existing `fn info()` with a desktop/Android split. Find:
```rust
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
```
Replace with:
```rust
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
```

- [ ] **Step 4: Make `set_resource_dir`/`reset_resource_dir` no-ops on Android**

Replace the two command functions with cfg-split versions. Find the existing `set_resource_dir` and `reset_resource_dir` (`#[tauri::command]` … bodies) and replace both with:
```rust
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
```

- [ ] **Step 5: Silence "unused on Android" warnings**

The desktop-only helpers (`exe_dir`, `read_override`, `write_override`, `resolve`, `config_path`, `is_writable`) are unused when compiling for Android and will warn. Add `#[cfg_attr(target_os = "android", allow(dead_code))]` above each of: `fn exe_dir`, `fn config_path`, `fn is_writable`, `fn read_override`, `fn write_override`, `fn resolve`. (The `init`/`data_root`/`app_data_dir` functions stay used.)

- [ ] **Step 6: Wire platform-split init in `lib.rs`**

In `src-tauri/src/lib.rs`, find the setup body:
```rust
        .setup(|app| {
            if let Ok(dir) = app.path().app_data_dir() {
                data_root::init(dir);
            }
```
Replace the inner `if let` with a cfg split:
```rust
        .setup(|app| {
            #[cfg(target_os = "android")]
            {
                // App-private external storage (spec §2). Fall back to internal
                // app-data if external is somehow unavailable so the app still runs.
                match data_root::android_external_files_dir() {
                    Ok(dir) => {
                        log::info!("[data_root] android external files dir: {}", dir.display());
                        data_root::init_fixed(dir);
                    }
                    Err(e) => {
                        log::warn!("[data_root] external dir unavailable ({e}); using internal app_data");
                        if let Ok(dir) = app.path().app_data_dir() {
                            data_root::init_fixed(dir);
                        }
                    }
                }
            }
            #[cfg(not(target_os = "android"))]
            {
                if let Ok(dir) = app.path().app_data_dir() {
                    data_root::init(dir);
                }
            }
```
(Keep the rest of the setup closure — the `tauri_plugin_log` block and `Ok(())` — unchanged.)

> **VERIFY #2 probe:** the `log::info!("[data_root] android external files dir: …")` line above is the probe. In Task 16 we read it from `adb logcat` to confirm the resolved path is the external `…/Android/data/com.prts.reader/files` (JNI succeeded) and not the internal fallback. If JNI fails on-device, logcat shows the warn line and the internal path — acceptable functional fallback, but investigate (likely `ndk_context` not populated; if so, the alternative is a Tauri mobile plugin Kotlin call — note as follow-up, do not block the port).

- [ ] **Step 7: Desktop still compiles + tests pass**

Run:
```bash
cd src-tauri && cargo test && cd ..
```
Expected: `data_root` unit tests (`is_writable_*`) pass; desktop build unaffected.

- [ ] **Step 8: Android cross-compile check**

Run:
```bash
NDK_HOME=/opt/android-sdk/ndk/27.2.12479018 \
ANDROID_NDK_HOME=/opt/android-sdk/ndk/27.2.12479018 \
cd src-tauri && cargo check --target aarch64-linux-android && cd ..
```
Expected: compiles (pulls `jni`/`ndk-context`, builds the `#[cfg(target_os="android")]` branch). Fix any JNI signature errors here before moving on.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/data_root.rs src-tauri/src/lib.rs
git commit -m "feat(android): fixed app-private external storage via JNI getExternalFilesDir"
```

---

## Phase E — Asset protocol scope (spec §3, VERIFY #3)

### Task 8: Add the Android asset-protocol scope

The frontend uses `convertFileSrc()` → `asset://` for cached engine deps and the NotoSans font (`engineBoot.ts:342/348/361`), which live under `data_root/assets/engine/`. On Android that is the external files dir, which the desktop scope `$APPDATA/**` does **not** cover, so those assets would be blocked.

**Files:**
- Modify: `src-tauri/tauri.conf.json:26-31`

- [ ] **Step 1: Broaden the asset scope to include the Android external dir**

In `src-tauri/tauri.conf.json`, replace:
```json
      "assetProtocol": {
        "enable": true,
        "scope": {
          "allow": ["$APPDATA/**"]
        }
      }
```
with:
```json
      "assetProtocol": {
        "enable": true,
        "scope": {
          "allow": [
            "$APPDATA/**",
            "$APPDATA/../**",
            "**/Android/data/com.prts.reader/files/**"
          ]
        }
      }
```
Rationale: the glob `**/Android/data/com.prts.reader/files/**` matches the external files dir regardless of the storage-emulated mount prefix; `$APPDATA/../**` is a belt-and-suspenders for whatever Tauri maps `$APPDATA` to on Android. Desktop behaviour is unchanged (still allows `$APPDATA/**`).

- [ ] **Step 2: Type/JSON sanity + desktop build**

Run:
```bash
cd src-tauri && cargo check && cd ..
```
Expected: compiles; `tauri.conf.json` parses (a malformed scope fails the build).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "feat(android): asset-protocol scope for external files dir"
```

> **VERIFY #3** is confirmed at runtime in Task 16 ("font/asset check"): NotoSans renders in the engine and the debug console shows **no** `asset:`/`Not allowed to load local resource` violations. If blocked, widen/adjust the glob and re-verify. CSP already permits `asset: http://asset.localhost` (`tauri.conf.json` csp) so no CSP change is needed.

---

## Phase F — Mobile UI

### Task 9: Hide the resource-directory section in Settings on Android (spec §2)

**Files:**
- Modify: `src/pages/SettingsPage.tsx:1-5, 234-263`

- [ ] **Step 1: Import the platform helper**

In `src/pages/SettingsPage.tsx`, add to the imports:
```ts
import { isAndroid } from "../lib/platform";
```

- [ ] **Step 2: Compute a guard near the top of the component**

Inside `SettingsPage`, right after `const navigate = useNavigate();`, add:
```ts
  const hideResourceDir = isAndroid();
```

- [ ] **Step 3: Conditionally render the resource-directory section**

Wrap the entire `{/* Resource directory */}` `<div className="setting-group">…</div>` block (lines ~234-263) in a guard:
```tsx
      {/* Resource directory (desktop only — Android storage is fixed) */}
      {!hideResourceDir && (
        <div className="setting-group">
          {/* …existing resource-directory markup unchanged… */}
        </div>
      )}
```
Leave the inner markup (label, `chooseResourceDir`/`resetResourceDir` buttons, `resDir` display) exactly as-is.

- [ ] **Step 4: Avoid the unused-call lint on Android**

`chooseResourceDir`/`resetResourceDir` are now unreferenced when `hideResourceDir` is true, but they are still referenced in the JSX (just guarded), so TypeScript keeps them "used" — no change needed. Verify:
```bash
npm run build
```
Expected: `tsc -b` passes (no "declared but never read"). If it complains, it means the functions were removed rather than guarded — restore them.

- [ ] **Step 5: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat(android): hide resource-directory section on Android"
```

---

### Task 10: Android hardware-back interception (spec §4)

On Android the system back gesture/button defaults to killing the activity. Intercept it and route through react-router: from the player → back to `/browse`; from any non-home route → back; on home → allow default (exit). Tauri mobile delivers the hardware back as a DOM event on the webview; the robust cross-version approach is to listen for the WebView's back via the history `popstate` plus a Tauri event, but the simplest reliable mechanism that works today is to (a) keep a router history and (b) catch the Android back through Tauri's `onproxy`... To avoid depending on an uncertain API, use the documented pattern: listen to the global `tauri://back-requested`-style event is not guaranteed, so we use the **WebView history + a capacitor-free `popstate` guard** combined with Tauri's plugin. Implement defensively:

**Files:**
- Create: `src/lib/androidBack.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create `src/lib/androidBack.ts`**

```ts
import { isAndroid } from "./platform";

/**
 * Android hardware-back handling.
 *
 * Tauri's Android WebView maps the hardware/gesture back to the standard
 * `window.history` (a `popstate`), and when history is empty it lets the OS
 * close the activity. We rely on react-router's BrowserRouter history so the
 * default behaviour is already "go to previous route, exit on home". This hook
 * adds the one missing nicety: a confirm-to-exit guard on the home route so a
 * stray back-gesture on the landing screen doesn't kill the app unexpectedly.
 *
 * It is a no-op on non-Android platforms.
 */
export function installAndroidBack(): () => void {
  if (!isAndroid()) return () => {};

  // Seed one extra history entry so the first back on "/" hits our guard
  // instead of immediately exiting.
  const seedGuard = () => {
    if (window.location.pathname === "/") {
      window.history.pushState({ prtsHomeGuard: true }, "");
    }
  };
  seedGuard();

  const onPop = (e: PopStateEvent) => {
    // On home: re-seed the guard and ask before exiting.
    if (window.location.pathname === "/") {
      const exit = window.confirm("退出 PRTS 剧情阅读器？");
      if (!exit) {
        window.history.pushState({ prtsHomeGuard: true }, "");
      } else {
        // Pop past our seeded entry → empty history → OS closes the activity.
        window.history.back();
      }
    }
    void e;
  };

  window.addEventListener("popstate", onPop);
  return () => window.removeEventListener("popstate", onPop);
}
```

- [ ] **Step 2: Install the hook in `App.tsx`**

In `src/App.tsx`, convert the component to install the hook on mount. Replace the file body with:
```tsx
import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import HomePage from "./pages/HomePage";
import StoryBrowserPage from "./pages/StoryBrowserPage";
import StoryPlayerPage from "./pages/StoryPlayerPage";
import SettingsPage from "./pages/SettingsPage";
import DebugConsole from "./components/DebugConsole";
import { installAndroidBack } from "./lib/androidBack";

export default function App() {
  useEffect(() => installAndroidBack(), []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/browse" element={<StoryBrowserPage />} />
        <Route path="/play/:pageTitle" element={<StoryPlayerPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
      <DebugConsole />
    </BrowserRouter>
  );
}
```

- [ ] **Step 3: Type-check**

Run:
```bash
npm run build
```
Expected: `tsc -b` passes.

- [ ] **Step 4: Commit**

```bash
git add src/lib/androidBack.ts src/App.tsx
git commit -m "feat(android): hardware-back routing + home-exit guard"
```

> **Runtime note:** Task 16 verifies back behaviour with `adb shell input keyevent 4` (KEYCODE_BACK): from the player it returns to the browse list; on home it shows the exit confirm. If Tauri's Android build turns out **not** to route hardware-back to `popstate` (verify in Task 16 via logcat), the fallback is the Tauri mobile back event — wire it in `androidBack.ts` then (documented in `docs/android-build.md`), keeping the same routing logic.

---

### Task 11: Safe-area insets for edge-to-edge rendering (spec §4)

Tauri mobile renders edge-to-edge; fixed top/bottom UI (player back button, debug-console button, page top bars) must inset by `env(safe-area-inset-*)` so nothing hides behind the status bar / notch / gesture bar.

**Files:**
- Modify: `src/styles/global.css` (add `viewport-fit` note + helper)
- Modify: `src/pages/StoryPlayerPage.tsx:141-153` (back button)
- Modify: `src/components/DebugConsole.tsx:81-96` (bottom-left buttons)
- Modify: `index.html` (viewport meta `viewport-fit=cover`)

- [ ] **Step 1: Ensure the viewport opts into the safe-area insets**

In `index.html`, find the `<meta name="viewport" …>` tag and ensure it contains `viewport-fit=cover`:
```html
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```
(If no viewport meta exists, add this one inside `<head>`.) Without `viewport-fit=cover`, `env(safe-area-inset-*)` is always 0.

- [ ] **Step 2: Add safe-area CSS custom properties in `global.css`**

In `src/styles/global.css`, inside the `:root { … }` block, append:
```css
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-left: env(safe-area-inset-left, 0px);
  --safe-right: env(safe-area-inset-right, 0px);
```

- [ ] **Step 3: Inset the player back button**

In `src/pages/StoryPlayerPage.tsx`, in `backBtnStyle`, change:
```ts
  top: "8px",
  left: "8px",
```
to:
```ts
  top: "calc(8px + env(safe-area-inset-top, 0px))",
  left: "calc(8px + env(safe-area-inset-left, 0px))",
```

- [ ] **Step 4: Inset the debug-console buttons**

In `src/components/DebugConsole.tsx`, both fixed-button style objects (lines ~81-83 and ~94-96) use `bottom: 8, left: 8`. Change both to:
```ts
  bottom: "calc(8px + env(safe-area-inset-bottom, 0px))",
  left: "calc(8px + env(safe-area-inset-left, 0px))",
```
(They are numeric `8` today; switch to the string `calc(...)` form.)

- [ ] **Step 5: Inset the page top bars**

The Settings header (`SettingsPage.tsx:186`), Browser header (`StoryBrowserPage.tsx:91`), and Home container (`HomePage.tsx`) are normal-flow content inside scroll containers, so the status bar overlaps their top. Add top padding via the safe-area var. In `src/styles/global.css`, add a utility and apply it through existing containers — append:
```css
/* Edge-to-edge safe-area padding for top-level page containers (Android). */
.settings-page,
.browser-page {
  padding-top: var(--safe-top);
}
```
Then confirm the home page (inline-styled) gets inset: in `src/pages/HomePage.tsx`, change the container `padding: "24px"` to:
```ts
        padding: "24px",
        paddingTop: "calc(24px + env(safe-area-inset-top, 0px))",
```
(If `StoryBrowserPage`'s root element does not use the class `browser-page`, add that class to its outermost `<div>` so the rule applies. Inspect `StoryBrowserPage.tsx` line ~88 and add `className="browser-page"` to the root container if absent.)

- [ ] **Step 6: Type-check + desktop regression**

Run:
```bash
npm run build && bash scripts/test-static.sh
```
Expected: build passes; static suite green. On desktop, `env(safe-area-inset-*)` resolves to 0 so layout is visually unchanged.

- [ ] **Step 7: Commit**

```bash
git add index.html src/styles/global.css src/pages/StoryPlayerPage.tsx src/components/DebugConsole.tsx src/pages/HomePage.tsx src/pages/StoryBrowserPage.tsx
git commit -m "feat(android): safe-area insets for edge-to-edge UI"
```

---

## Phase G — Build script + release-signing interface

### Task 12: `scripts/build-android.sh` (spec §1, §6)

**Files:**
- Create: `scripts/build-android.sh`

- [ ] **Step 1: Write the script (mirrors `build-windows.sh` style)**

Create `scripts/build-android.sh`:
```bash
#!/usr/bin/env bash
#
# Build a sideloadable Android **debug APK** for prts-reader and copy it to the
# project root. Mirrors scripts/build-windows.sh in spirit: installs missing
# toolchain bits, builds, copies the artifact out, and leaves the repo clean.
#
# ABIs: aarch64 (real devices) + x86_64 (emulator). No 32-bit armv7 (by design).
#
# Release signing: this script builds an UNSIGNED debug APK. To cut a signed
# release later, set the keystore env vars (see docs/android-build.md) and run
# with RELEASE=1 — the Gradle signingConfig (Task 14) reads those vars and the
# build switches to --release. With the vars unset it stays debug-signed.
#
# Usage:
#   scripts/build-android.sh                 # debug APK, both ABIs
#   ABI=x86_64 scripts/build-android.sh      # single ABI (faster, emulator only)
#   RELEASE=1 scripts/build-android.sh       # release APK (requires signing env)
set -euo pipefail
cd "$(dirname "$0")/.."

# --- Toolchain locations (override via env if your SDK/NDK live elsewhere) ---
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
NDK_VERSION="${NDK_VERSION:-27.2.12479018}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/$NDK_VERSION}"
export ANDROID_NDK_HOME="$NDK_HOME"

echo "==> Checking Rust Android targets"
rustup target add aarch64-linux-android x86_64-linux-android

echo "==> Checking NDK at $NDK_HOME"
if [ ! -d "$NDK_HOME" ]; then
  echo "    installing ndk;$NDK_VERSION"
  yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
    --sdk_root="$ANDROID_HOME" "ndk;$NDK_VERSION" "platforms;android-35" "build-tools;35.0.0"
fi

echo "==> Ensuring Android project is initialized (idempotent)"
if [ ! -d src-tauri/gen/android ]; then
  npm run tauri android init
fi

# Script builds ship with the on-screen debug console enabled by default
# (users can turn it off in Settings). Override with VITE_DEBUG_DEFAULT=false.
export VITE_DEBUG_DEFAULT="${VITE_DEBUG_DEFAULT:-true}"

# Build mode + ABI selection.
mode_flag="--debug"
[ "${RELEASE:-0}" = "1" ] && mode_flag="--release"
target_args=()
if [ -n "${ABI:-}" ]; then
  target_args=(--target "$ABI")
fi

echo "==> Building Android APK ($mode_flag ${ABI:-aarch64+x86_64})"
npm run tauri android build -- --apk $mode_flag "${target_args[@]}"

# Copy the produced APK(s) to the project root.
out_dir="src-tauri/gen/android/app/build/outputs/apk"
mapfile -t apks < <(find "$out_dir" -name "*.apk" -newer "$out_dir" 2>/dev/null || find "$out_dir" -name "*.apk")
if [ "${#apks[@]}" -eq 0 ]; then
  echo "ERROR: no APK produced under $out_dir" >&2
  exit 1
fi
for apk in "${apks[@]}"; do
  dest="./$(basename "$apk")"
  cp -f "$apk" "$dest"
  echo "    -> $dest"
done

echo
echo "==> Done. APK(s) in the project root:"
ls -lh ./*.apk
```

- [ ] **Step 2: Make it executable**

Run:
```bash
chmod +x scripts/build-android.sh
```

- [ ] **Step 3: Add APK outputs to root `.gitignore`**

In `.gitignore`, under the "Local build outputs" block, add:
```
/*.apk
/*.aab
```

- [ ] **Step 4: Smoke-run the script (single ABI for speed)**

Run:
```bash
ABI=x86_64 scripts/build-android.sh
```
Expected: finishes and lists a `*-debug.apk` in the project root. (This is the same build as Task 4 but through the script, proving the script end-to-end.)

- [ ] **Step 5: Commit**

```bash
git add scripts/build-android.sh .gitignore
git commit -m "build(android): build-android.sh debug-APK script + apk gitignore"
```

---

### Task 13: Release-signing interface (wired but disabled) (spec §6)

**Files:**
- Modify: `src-tauri/gen/android/app/build.gradle.kts`

- [ ] **Step 1: Inspect the generated buildTypes block**

Run:
```bash
grep -n "signingConfigs\|buildTypes\|getByName(\"release\")\|create(\"release\")\|signingConfig" src-tauri/gen/android/app/build.gradle.kts
sed -n '1,80p' src-tauri/gen/android/app/build.gradle.kts
```
Expected: a `android { … }` block with `buildTypes`. Record whether a `signingConfigs` block already exists.

- [ ] **Step 2: Add an env-driven release signing config that falls back to debug**

In `src-tauri/gen/android/app/build.gradle.kts`, inside the `android { … }` block (before `buildTypes`), add:
```kotlin
    signingConfigs {
        create("release") {
            // Wired-but-disabled: populated only when the env vars are set
            // (CI secrets / local release). With them unset, the release build
            // falls back to the debug signing config below — no real keystore
            // is generated or committed.
            val storeFilePath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (storeFilePath != null && storeFilePath.isNotEmpty()) {
                storeFile = file(storeFilePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }
```
Then in the `buildTypes { getByName("release") { … } }` (or `create`) block, set the signing config conditionally:
```kotlin
        getByName("release") {
            // Use the real release keystore when ANDROID_KEYSTORE_PATH is set,
            // otherwise fall back to debug signing so unsigned local release
            // builds still install on a dev device.
            signingConfig = if (System.getenv("ANDROID_KEYSTORE_PATH").isNullOrEmpty()) {
                signingConfigs.getByName("debug")
            } else {
                signingConfigs.getByName("release")
            }
        }
```
(Adapt to the exact DSL Tauri generated — `getByName` vs `create`. Do not remove Tauri's existing release settings like `isMinifyEnabled`/`proguardFiles`; only add the `signingConfig` line and the `signingConfigs` block.)

- [ ] **Step 3: Confirm the debug build is unaffected**

Run:
```bash
ABI=x86_64 scripts/build-android.sh
```
Expected: debug APK still builds and is copied to root (the signing change only touches the `release` build type).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/gen/android/app/build.gradle.kts
git commit -m "build(android): env-driven release signing interface (falls back to debug)"
```

---

## Phase H — Runtime verification & docs

### Task 14: Emulator harness — install, boot, drive (spec §8, VERIFY #4)

**Files:** none (verification only; record findings in `docs/android-build.md` in Task 15).

- [ ] **Step 1: Install the emulator + a system image**

Run:
```bash
yes | sdkmanager --sdk_root=/opt/android-sdk \
  "emulator" "system-images;android-35;google_apis;x86_64" "platforms;android-35"
```
Expected: exits 0; `ls /opt/android-sdk/emulator/emulator` and `ls /opt/android-sdk/system-images/android-35/google_apis/x86_64` exist.

- [ ] **Step 2: Create an AVD**

Run:
```bash
echo no | avdmanager create avd -n prts_test \
  -k "system-images;android-35;google_apis;x86_64" --device pixel_5 --force
```
Expected: "AVD 'prts_test' created".

- [ ] **Step 3: Boot headless with KVM**

Run (background):
```bash
/opt/android-sdk/emulator/emulator -avd prts_test \
  -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect -accel on >/tmp/emu.log 2>&1 &
adb wait-for-device
# Poll until fully booted
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
echo "booted"
```
Expected: prints "booted" within ~60-120s. `/dev/kvm` makes this fast. If the emulator refuses to start, capture `/tmp/emu.log`.

> **VERIFY #4 decision point:** if the WebView later renders **blank** under `swiftshader_indirect` (a known headless-GPU risk, spec §8), retry once with `-gpu off`. If still blank, **fall back to a physical device** (`adb install` over USB/network) and record that the headless emulator can't render the WebView in this environment. Do not block the port on emulator rendering — the APK + device install is the source of truth.

- [ ] **Step 4: Install the debug APK**

Run:
```bash
apk="$(ls -1 ./*x86_64*debug.apk 2>/dev/null | head -1 || ls -1 ./*debug.apk | head -1)"
adb install -r "$apk"
adb shell am start -n com.prts.reader/.MainActivity
sleep 8
```
Expected: "Success"; activity starts.

- [ ] **Step 5: Capture a screenshot + boot logs**

Run:
```bash
adb exec-out screencap -p > /tmp/prts-home.png
adb logcat -d | grep -iE "prts|data_root|chromium|console" | tail -60
```
Expected: `/tmp/prts-home.png` shows the home screen ("PRTS 剧情阅读器", two buttons). View it with the Read tool to confirm it rendered (not blank).

- [ ] **Step 6: VERIFY #2 — storage path**

In the logcat from Step 5, find the line `[data_root] android external files dir: …`.
Expected: path is `…/Android/data/com.prts.reader/files`. If instead the `warn` fallback line appears, JNI failed — record it and note the follow-up (internal storage is a working fallback).

- [ ] **Step 7: Drive: home → settings → precache engine → browse → open a story**

Run (tap coordinates are for the pixel_5 AVD; adjust from the screenshots):
```bash
# Settings
adb shell input tap 540 1900   # approximate "设置" button — re-derive from /tmp/prts-home.png
sleep 2; adb exec-out screencap -p > /tmp/prts-settings.png
# Precache engine (tap the 预缓存引擎 button — derive from the settings screenshot)
# ... tap, wait, screencap ...
# Back to home, Browse, open first story
```
Drive interactively using screenshots between taps (same approach as the desktop xdotool e2e harness, but via `adb shell input tap/swipe` + `adb exec-out screencap`). The goal states to confirm:
  - **Scheme check (VERIFY #1):** after opening a story, `adb logcat -d | grep "prts-cdn"` shows requests to `http://prts-cdn.localhost/...` and the engine stage renders (not the static "页面载入中" screen).
  - **Font/asset check (VERIFY #3):** the LOG / LOG ALL toolbar buttons and text render with NotoSans; `adb logcat -d | grep -iE "asset|Not allowed to load local resource"` shows no asset-scope denials.
  - **Audio (bonus):** `adb logcat -d | grep -i "NotSupportedError"` is ideally empty (Android WebView decodes mp3/aac).
  - **Back routing (Task 10):** `adb shell input keyevent 4` from the player returns to the browse list; on home it shows the exit confirm.
  - **WebView render (VERIFY #4):** the story screencap shows non-trivial pixel variance (a real scene), not a blank/black frame.

- [ ] **Step 8: Record the results**

Note each VERIFY item's outcome (pass / needed-adjustment / device-fallback) — these go into `docs/android-build.md` (Task 15) and the memory update (Task 16). If any check failed, loop back to the owning task (1→§3, 2→Task 7, 3→Task 8, 4→here, scheme→Task 6) using superpowers:systematic-debugging, fix, rebuild, re-verify.

- [ ] **Step 9: Tear down the emulator**

Run:
```bash
adb emu kill 2>/dev/null || true
```

- [ ] **Step 10: Commit** — verification only, nothing to commit. Skip.

---

### Task 15: Documentation (build + run + signing + CI-later) (spec §6, §7)

**Files:**
- Create: `docs/android-build.md`

- [ ] **Step 1: Write `docs/android-build.md`**

Document, concretely (no placeholders):
- **Prerequisites:** Android SDK at `$ANDROID_HOME`, NDK 27.2.12479018, Rust targets `aarch64-linux-android`+`x86_64-linux-android`, Java 21.
- **Build:** `scripts/build-android.sh` (and `ABI=x86_64` for a fast emulator-only build); where the APK lands (project root).
- **Run on emulator:** the Task 14 commands (create AVD, boot headless KVM, `adb install`, `am start`, `screencap`). Include the swiftshader→`-gpu off`→device fallback note and whatever Task 14 recorded about headless WebView rendering in this environment.
- **Run on a device:** enable USB debugging, `adb install -r <apk>`.
- **Storage location:** `…/Android/data/com.prts.reader/files/{cache,assets,media}`; visible to file managers; cleared on uninstall; no in-app picker.
- **Release signing (when ready):** generate a keystore, set `ANDROID_KEYSTORE_PATH`/`ANDROID_KEYSTORE_PASSWORD`/`ANDROID_KEY_ALIAS`/`ANDROID_KEY_PASSWORD`, run `RELEASE=1 scripts/build-android.sh`. Explain the `build.gradle.kts` fallback-to-debug behaviour.
- **CI (later):** a sketch of the future GitHub Actions job — install SDK/NDK, `rustup target add`, set signing secrets, run the script, upload the APK artifact — explicitly marked "not implemented in this phase."
- **Verified-empirically section:** the recorded outcomes of the 5 VERIFY items from Task 14.

- [ ] **Step 2: Cross-link from the main README**

If `README.md` (project root) has a "Build" section, add a one-line pointer: `- Android: see [docs/android-build.md](docs/android-build.md)`.

- [ ] **Step 3: Commit**

```bash
git add docs/android-build.md README.md 2>/dev/null; git add docs/android-build.md
git commit -m "docs(android): build/run/signing guide + CI-later sketch"
```

---

### Task 16: Finalize — update project memory

**Files:** the android memory file.

- [ ] **Step 1: Update the memory**

Update `/root/.claude/projects/-root-prts-reader/memory/prts-reader-android.md`: change status from "Next step = writing-plans" to record that the port is implemented; capture the **confirmed** answers to the 5 empirical items (scheme URL form, external-dir path / whether JNI worked, asset-scope glob that worked, headless-emulator render outcome, gitignore rules), the NDK version used, and the `scripts/build-android.sh` entry point. Keep it to the non-obvious facts (per memory rules) — don't restate what the spec/plan already record.

- [ ] **Step 2: No code commit** — memory lives outside the repo. Skip.

---

## Self-review against the spec

- **Spec §Scoping 1-5** (storage / parity / debug-APK+signing / script-first / aarch64+x86_64): Tasks 7 (storage), 9 (parity minus picker), 12+13 (debug APK + signing interface), 12 (script; CI deferred to Task 15 docs), 1/4/12 (two ABIs, no armv7). ✓
- **§1 Build & toolchain:** Tasks 1, 2, 3 (NDK, targets, init, minSdk24/targetSdk35, applicationId, gitignore boundary), 12 (`build-android.sh` with `VITE_DEBUG_DEFAULT=true`). ✓
- **§2 Storage:** Task 7 (JNI external dir, no override/picker, no-op set/reset), 9 (Settings hides section). ✓
- **§3 Protocol/WebView:** Task 6 (`http://prts-cdn.localhost`), 8 (asset scope). WebView2 fixes (`#firstHeading` off-screen, blob-URL scripts) and CSP carry over unchanged — no task needed (verified at runtime in Task 14). ✓
- **§4 Mobile UI:** Task 11 (safe-area + windowed-fit already adapts via `innerWidth/innerHeight`), 10 (back button). ✓
- **§5 Parity matrix:** covered by reuse + Tasks 9/10/11; no dropped feature beyond the picker. ✓
- **§6 Distribution:** Tasks 12 (debug APK), 13 (signing interface, no real keystore). ✓
- **§7 CI later:** Task 15 documents only. ✓
- **§8 Verification:** Task 4 (compile), Task 14 (runtime emulator + device fallback). ✓
- **§9 five empirical items:** mapped in the Empirical-verification map and each owned by a task with a runtime check in Task 14. ✓

**Placeholder scan:** no "TBD/handle edge cases/similar to Task N"; every code step shows real code. The only deliberately deferred specifics are the on-device tap coordinates (Task 14, derived from screenshots at run time — inherent to UI driving) and exact DSL adaptation in `build.gradle.kts` (Task 13, because Tauri's generated file is read first in Step 1).

**Type/name consistency:** `getPlatform`/`isAndroid`/`isWindows`/`usesHttpLocalhostScheme` (platform.ts) used consistently in proxy.ts, SettingsPage.tsx, androidBack.ts. `android_external_files_dir`/`init_fixed`/`info` (data_root.rs) match their `lib.rs` call sites. `PROXY_BASE` unchanged in name/shape. Env-var names (`ANDROID_KEYSTORE_PATH` etc.) identical between `build-android.sh`, `build.gradle.kts`, and the docs.
