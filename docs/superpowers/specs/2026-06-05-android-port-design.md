# Android Port — Design Spec

**Date:** 2026-06-05
**Branch:** `android`
**Status:** Approved (brainstorming complete) — next step is an implementation plan via writing-plans.

## Goal

Port `prts-reader` (Tauri 2 + React Arknights offline story reader) to Android,
reusing the existing shared codebase. Achieve full feature parity with the
desktop app **except** the custom resource-directory picker, which is replaced
on Android by a fixed app-private external storage location.

## Scoping decisions (locked)

1. **Storage:** app-private external storage (`getExternalFilesDir`) — no runtime
   permission, large space, visible to file managers, cleared on uninstall. No
   custom-directory feature on Android.
2. **Feature scope:** port everything except the resource-directory picker.
3. **Distribution:** local/sideloadable **debug APK** now, but keep a
   release-signing + GitHub-Release path as a wired-but-disabled interface so it
   can be flipped on later without rework.
4. **CI:** local build script + docs now; a GitHub Actions job comes later.
5. **ABIs:** `aarch64-linux-android` (real devices) + `x86_64-linux-android`
   (emulator) only. **No 32-bit `armv7`.**

## Architecture: minimal-divergence shared codebase

Keep the single Tauri project. `tauri android init` scaffolds a Gradle project
under `src-tauri/gen/android`. Frontend and Rust code stay ~99% shared; platform
differences are isolated to a few well-bounded points:

- **Frontend:** new `src/lib/platform.ts` wrapping `@tauri-apps/plugin-os`
  `platform()`, replacing the current `navigator.userAgent.includes("Windows")`
  check in `src/lib/proxy.ts`.
- **Rust:** a `#[cfg(target_os = "android")]` branch in `src-tauri/src/data_root.rs`.
- **UI:** the Settings page hides the "resource directory" section on Android.

Rejected alternative: abstracting storage behind a trait with desktop/Android
implementations plus a separate mobile UI shell — over-engineered for a reader
whose engine is already the mobile (`m.prts.wiki`) H5 build.

## 1. Build & toolchain

- Install the **NDK** (`sdkmanager "ndk;27.x"`) and Rust targets
  `aarch64-linux-android`, `x86_64-linux-android`. Set `NDK_HOME`/`ANDROID_NDK_HOME`.
- `minSdk = 24` (Android 7+, Tauri default); WebView is the auto-updating system
  WebView (Chromium). `targetSdk = 34` (or 35).
- `applicationId = com.prts.reader` (matches the existing identifier); reuse app
  name and icon.
- New `scripts/build-android.sh` mirroring `build-windows*.sh` style: install
  deps → `tauri android init` (idempotent) → `tauri android build --apk --debug`
  → copy the APK to the project root. Sets `VITE_DEBUG_DEFAULT=true` so
  script-built artifacts ship with the debug console on (consistent with desktop).
- **`.gitignore`:** Tauri's convention is to version-control the generated
  `gen/android` project (it holds customizable Gradle/manifest files) and ignore
  only its build outputs. Change the current blanket `src-tauri/gen/` ignore to
  ignore just the build dirs (e.g. `src-tauri/gen/android/app/build/`,
  `src-tauri/gen/android/.gradle/`, `src-tauri/gen/android/app/.cxx/`, local
  properties). Keep the rest committed.

## 2. Storage (app-private external, `getExternalFilesDir`)

- `data_root.rs` Android branch: data root = the app-private external files dir
  (`…/Android/data/com.prts.reader/files/`), containing `cache/`, `assets/`,
  `media/`. **No** exe-folder default, **no** `config.json` override, **no**
  directory picker.
- Resolution mechanism (to settle during implementation): prefer a Tauri path
  API that maps to the external files dir; if none exists, use a small JNI call
  to `Context.getExternalFilesDir(null)`. **[VERIFY EMPIRICALLY during the plan.]**
- `get_resource_dir` on Android returns the fixed path with `is_custom = false`;
  `set_resource_dir`/`reset_resource_dir` become no-ops (keep the command
  signatures so the frontend contract is unchanged).
- `SettingsPage.tsx` hides the entire resource-directory section on Android
  (via `platform()`).

## 3. Custom protocol / asset protocol / WebView

- The offline-first `prts-cdn://` URI-scheme handler is cross-platform. On Android
  the scheme is served as **`http://prts-cdn.localhost/...`** (same form as
  Windows WebView2). Update `proxy.ts` `PROXY_BASE` so "Windows **or** Android" →
  the `http://…localhost` form. **[VERIFY the exact URL form empirically.]**
- `protocol-asset` / `convertFileSrc`: confirm the asset-protocol scope covers the
  external files dir on Android; add an Android scope entry in `tauri.conf.json`
  if required. **[VERIFY.]**
- **WebView compatibility (key win):** Android's system WebView is Chromium-based,
  same family as WebView2. The two WebView2 fixes already in the codebase carry
  over unchanged: (1) the off-screen `#firstHeading` working around Chromium's
  layout-dependent `innerText`; (2) blob-URL `<script>` execution bypassing the
  inline-script CSP. CSP config and the engine boot flow need no changes.
- **Audio:** Android WebView decodes mp3/aac (ogg/vorbis on most modern devices),
  so audio is expected to work — better than Linux WebKitGTK. A bonus, not a
  blocker.

## 4. Mobile UI adaptation

- `installWindowedFit` reads `innerWidth`/`innerHeight` = the WebView viewport, so
  orientation changes fire `resize` → auto re-scale. Already adapts.
- **Android back button/gesture:** intercept it and route through react-router
  (player → back to browser; home → exit) instead of the default (which kills the
  app). Wire via Tauri's mobile back-handling or a JS `popstate`/plugin hook.
- **Safe areas/status bar:** Tauri mobile renders edge-to-edge; add
  `env(safe-area-inset-*)` padding to top/bottom UI (back button, debug-console
  button, toolbar) so nothing hides behind the status bar, notch, or gesture bar.
- Touch: the engine is the `m.prts.wiki` mobile build — tap/long-press already
  supported.

## 5. Feature parity matrix

- **Ported:** engine boot; prts-cdn offline-first; allow-online toggle; story
  index/browse/search; story-script caching; auto-preload; category/chapter
  predownload; debug console (+ toggle); windowed-fit (orientation); nickname;
  cache management (precache/update/clear/status).
- **Dropped on Android:** the resource-directory picker (change/reset/path
  display) — storage is fixed to the external files dir.
- **Android-only additions:** back-button interception, safe-area insets, platform
  scheme detection.

## 6. Distribution (debug APK now, signing interface retained)

- Now: the script produces a sideloadable **debug/self-signed APK**.
- **Retain the release interface:** pre-wire a Gradle signing config that reads a
  keystore from env vars / CI secrets (empty by default → falls back to the debug
  signing config), and document the path to flip to `--release` + a GitHub Release
  upload. **Do not** generate a real keystore now.

## 7. CI (later)

- This phase ships only the script + docs. Document a future GitHub Actions job
  (install SDK/NDK, add Rust targets, signing secret, upload artifact); do not
  implement it in this phase.

## 8. Verification strategy

- **Compile verification:** `scripts/build-android.sh` producing an APK proves the
  cross-compile works.
- **Runtime verification:** this environment has the SDK + `/dev/kvm` (HW accel)
  but lacks the NDK, an emulator package, and a system image. Plan: install
  `emulator` + `system-images;android-35;google_apis;x86_64`, create an AVD, boot
  headless (`-no-window`, KVM-accelerated), `adb install`, and drive with
  `adb shell input` + `screencap` — same approach as the existing e2e harness.
  **Open risk:** headless-emulator WebView rendering in this environment is
  uncertain (GPU/swiftshader); fall back to `adb install` on a physical device if
  needed.

## 9. Risks / items to verify empirically during implementation

1. Tauri-on-Android custom-scheme URL form (`http://prts-cdn.localhost`?).
2. Which Tauri path API maps to the external files dir; may need JNI.
3. Asset-protocol scope for the external files dir on Android.
4. Whether a headless emulator in this environment can actually render the WebView.
5. The `gen/android` version-control boundary and the exact `.gitignore` rules.

## Out of scope (this phase)

- 32-bit `armv7` ABI.
- Custom resource-directory picker on Android.
- Play Store / F-Droid compliance work.
- A GitHub Actions Android build job.
- Real release-signing keystore (only the wired-but-disabled interface).
