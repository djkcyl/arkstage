# Android Build & Run

prts-reader runs on Android as a Tauri 2 app: the same React frontend and Rust
backend as desktop, with platform divergence isolated to a few points (see
`docs/superpowers/specs/2026-06-05-android-port-design.md`). Storage is fixed to
the app-private external files dir; there is no resource-directory picker on
Android.

## Prerequisites

- **Android SDK** at `$ANDROID_HOME` (default `/opt/android-sdk`) with
  `cmdline-tools`, `platform-tools` (`adb`), `platforms;android-35`,
  `build-tools;35.0.0`.
- **NDK 27.2.12479018** (`sdkmanager "ndk;27.2.12479018"`).
- **Rust targets:** `aarch64-linux-android` (devices) and `x86_64-linux-android`
  (emulator). No 32-bit `armv7` by design.
- **A full JDK 21 with `javac`** (NOT a JRE). Gradle's Java toolchain needs a
  compiler; a JRE-only `JAVA_HOME` fails with
  `Toolchain installation ... does not provide the required capabilities: [JAVA_COMPILER]`.
  Install with `apt-get install -y openjdk-21-jdk-headless`. `build-android.sh`
  auto-detects a JDK via its `ensure_jdk` helper; you can also set `JAVA_HOME`
  explicitly to e.g. `/usr/lib/jvm/java-21-openjdk-amd64`.
- **Node + npm** (the frontend build), as for desktop.

`build-android.sh` installs the NDK and Rust targets automatically if missing.

## Build (debug APK)

```bash
scripts/build-android.sh                 # both ABIs (aarch64 + x86_64)
ABI=x86_64 scripts/build-android.sh      # emulator-only, faster
ABI=aarch64 scripts/build-android.sh     # real-device-only
```

The finished APK is copied to the **project root** (e.g.
`app-universal-debug.apk`) and is gitignored. The script sets
`VITE_DEBUG_DEFAULT=true`, so script-built APKs ship with the on-screen debug
console enabled (toggle it off in Settings) — consistent with the desktop
`build-windows*.sh` scripts.

Under the hood it runs `npm run tauri android build -- --apk --debug`, which
runs `tauri android init` first if `src-tauri/gen/android` is missing.

### Cross-compile note (reqwest / TLS)

The Rust backend uses `reqwest` with `default-features = false` +
`features = ["rustls-tls", "json"]`. This is required for Android: reqwest's
default `default-tls` feature pulls `native-tls → openssl-sys`, which has no
Android target and fails to cross-compile. rustls provides TLS on every platform.

## Run on an emulator (headless, KVM-accelerated)

```bash
# One-time: install emulator + a system image
sdkmanager "emulator" "system-images;android-35;google_apis;x86_64"
echo no | avdmanager create avd -n prts_test \
  -k "system-images;android-35;google_apis;x86_64" --device pixel_5 --force

# Boot headless (requires /dev/kvm)
$ANDROID_HOME/emulator/emulator -avd prts_test \
  -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect -accel on >/tmp/emu.log 2>&1 &
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done

# Install + launch
adb install -r app-universal-debug.apk
adb shell am start -n com.prts.reader/.MainActivity

# Observe
adb exec-out screencap -p > /tmp/shot.png
adb logcat -d | grep -iE "prts|data_root|chromium|console"
```

Drive the UI with `adb shell input tap X Y` / `adb shell input swipe …` /
`adb shell input keyevent 4` (back), taking `screencap` between actions (the
same loop as the desktop xdotool e2e harness).

**Headless GPU caveat:** if the WebView renders blank under
`-gpu swiftshader_indirect`, retry once with `-gpu off`. If still blank, the
headless emulator can't render the WebView in this environment — fall back to a
physical device (below). The APK + a device install is the source of truth.

## Run on a physical device

Enable Developer Options → USB debugging, connect, then:

```bash
adb install -r app-universal-debug.apk
adb shell am start -n com.prts.reader/.MainActivity
```

## Storage location

Data lives in the app-private external files dir:

```
/storage/emulated/0/Android/data/com.prts.reader/files/
  ├── cache/    (story scripts, story index, widget bundle)
  ├── assets/   (engine JS/CSS/font)
  └── media/    (content-addressed CDN media store)
```

No runtime permission is required; it is visible to file managers and cleared on
uninstall. There is **no** in-app directory picker on Android (the Settings
"resource directory" section is hidden). The path is obtained at startup via a
JNI call to `Context.getExternalFilesDir(null)`; if external storage is somehow
unavailable, the app falls back to internal app-data so it still runs.

## Release signing (when ready)

The release path is wired but disabled — no keystore is generated or committed.
To cut a signed release:

```bash
# 1. Generate a keystore (once)
keytool -genkey -v -keystore prts-release.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias prts

# 2. Point the build at it via env vars
export ANDROID_KEYSTORE_PATH=/abs/path/to/prts-release.jks
export ANDROID_KEYSTORE_PASSWORD=…
export ANDROID_KEY_ALIAS=prts
export ANDROID_KEY_PASSWORD=…

# 3. Build a release APK
RELEASE=1 scripts/build-android.sh
```

`src-tauri/gen/android/app/build.gradle.kts` reads those env vars in
`signingConfigs.release`. When `ANDROID_KEYSTORE_PATH` is unset, the release
build type falls back to the **debug** signing config, so an unsigned local
release build still installs on a dev device. Keep the keystore and passwords
out of the repo (use CI secrets).

## CI (not implemented this phase)

A future GitHub Actions job would:
1. Check out + set up Node, Rust (with the two Android targets), JDK 21.
2. Install the Android SDK + NDK 27.2.12479018 (e.g. `android-actions/setup-android`).
3. Restore the signing keystore from a secret; export the `ANDROID_KEYSTORE_*` env.
4. Run `RELEASE=1 scripts/build-android.sh`.
5. Upload the APK as an artifact / attach to a GitHub Release.

This phase intentionally ships only the local script + this doc.

## Empirical verification results

Verified 2026-06-05 on a headless, KVM-accelerated emulator
(`system-images;android-35;google_apis;x86_64`, Pixel 5 AVD,
`-gpu swiftshader_indirect`). The full offline player works end-to-end on
Android:

- **Custom-scheme URL form:** confirmed. On Android the engine loads CDN assets
  through the `prts-cdn` handler served at `http://prts-cdn.localhost/...` (the
  same Chromium form as Windows WebView2). Opening a story filled the media store
  (`media/static.prts.wiki/...`, `media/torappu.prts.wiki/...`) with the engine
  CSS/JS, the four `ui_*.png` toolbar icons, scene art, and audio — all served
  and cached via the handler.
- **External files dir / JNI:** confirmed. The JNI `getExternalFilesDir(null)`
  call resolves to `/storage/emulated/0/Android/data/com.prts.reader/files/`, and
  all `cache/`, `assets/`, `media/` data lands there. No internal-storage
  fallback was needed.
- **Asset-protocol scope:** confirmed. The NotoSans font and engine deps load via
  `convertFileSrc()` → `asset://` from the external `assets/engine/` dir with **no**
  "Not allowed to load local resource" / scope-denial errors. The
  `**/Android/data/com.prts.reader/files/**` scope glob is sufficient.
- **Headless-emulator WebView rendering:** works. The home, browser, settings, and
  the engine player (background art + character sprite + dialogue) all render
  under `swiftshader_indirect` — no device fallback required in this environment.
  (Note: the very first post-launch `screencap` can catch an early white frame
  before first paint; wait a few seconds and re-capture.)
- **`gen/android` VCS boundary:** `src-tauri/gen/android` is committed; build
  outputs (`app/build`, `.gradle`, `.cxx`, `local.properties`) are excluded by the
  generated `src-tauri/gen/android/.gitignore`, and the root `.gitignore` ignores
  only `src-tauri/gen/schemas/` and `src-tauri/gen/apple/`.

**Bonus:** audio decodes and plays (mp3 via AAudio) — better than desktop Linux
WebKitGTK, which can't decode mp3/ogg.

### Build prerequisites discovered during bring-up

- **reqwest must be rustls-only** (`default-features = false`) — see the
  cross-compile note above. Without it, `openssl-sys` fails to cross-compile.
- **A full JDK with `javac`** is required (a JRE-only `JAVA_HOME` fails Gradle's
  toolchain). If a stale Gradle daemon cached a JRE-only detection, stop it with
  `src-tauri/gen/android/gradlew --stop` after installing the JDK.

### Hardware-back behavior

The custom JS back-interception hook was **removed**: Tauri's Android WebView
already maps hardware-back to `popstate`, so react-router handles it correctly —
sub-pages go to the previous route (Settings→Home, Player→Browser) and Home
(empty history) exits the app to the launcher. An earlier seeded-history
exit-confirm guard was found (on the emulator) to mis-fire on sub-page back
(Settings + back showed the exit dialog instead of returning Home), so it was
dropped in favor of the correct default.
