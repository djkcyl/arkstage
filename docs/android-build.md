# Android Build & Run

方舟剧场 (Arkstage) runs on Android as a Tauri 2 app: the same React frontend and Rust
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

## Build (release APKs)

```bash
scripts/build-android.sh                 # both ABIs (aarch64 + x86_64)
ABI=x86_64 scripts/build-android.sh      # emulator-only, faster
ABI=aarch64 scripts/build-android.sh     # real-device-only
RELEASE=0 scripts/build-android.sh       # debug APKs with on-screen console enabled
```

The finished APKs are copied to **`build/artifacts/`** and are gitignored.
By default the script produces `Arkstage_<version>_android-arm64-release.apk`,
`Arkstage_<version>_android-x86_64-release.apk` and
`Arkstage_<version>_android-universal-release.apk` (both ABIs). Versioned filenames
prevent accidentally installing an older downloaded test APK. Release APKs use the debug signing
config unless a release keystore is supplied, so they can be installed for testing.
The script removes stale APKs there before building and cleans scratch/junk
before and after. Preserve any previous test packages elsewhere before running it.
Release builds default the on-screen debug console off; enable it in Settings
or set `VITE_DEBUG_DEFAULT=true` when building.

Under the hood it runs `npm run tauri android build -- --apk --target aarch64
--target x86_64 --split-per-abi`, then builds the universal APK. `RELEASE=0` adds
`--debug`. It runs `tauri android init` first if `src-tauri/gen/android` is missing.

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
adb install -r build/artifacts/Arkstage_*_android-universal-debug.apk
adb shell am start -n cn.aunly.arkstage/.MainActivity

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
adb install -r build/artifacts/Arkstage_*_android-universal-debug.apk
adb shell am start -n cn.aunly.arkstage/.MainActivity
```

## Storage location

Data lives in the app-private external files dir:

```
/storage/emulated/0/Android/data/cn.aunly.arkstage/files/
  ├── cache/    (story scripts, story index, widget bundle)
  ├── assets/   (engine JS/CSS/font)
  └── media/    (content-addressed CDN media store)
```

No runtime permission is required; it is visible to file managers and cleared on
uninstall. There is **no** in-app directory picker on Android (the Settings
"resource directory" section is hidden). The path is obtained at startup via a
JNI call to `Context.getExternalFilesDir(null)`; if external storage is somehow
unavailable, the app falls back to internal app-data so it still runs.

## Release signing

Reuse the existing app's signing key for releases so users can upgrade without
uninstalling. The key is never committed. For a local signed build, point Gradle
at that existing key:

```bash
# Point the build at the existing keystore via env vars
export ANDROID_KEYSTORE_PATH=/abs/path/to/prts-release.jks
export ANDROID_KEYSTORE_PASSWORD=…
export ANDROID_KEY_ALIAS=prts
export ANDROID_KEY_PASSWORD=…

# Build a release APK
RELEASE=1 scripts/build-android.sh
```

`src-tauri/gen/android/app/build.gradle.kts` reads those env vars in
`signingConfigs.release`. When `ANDROID_KEYSTORE_PATH` is unset, the release
build type falls back to the **debug** signing config, so an unsigned local
release build still installs on a dev device. Keep the keystore and passwords
out of the repo (use CI secrets).

## CI

Android is built in GitHub Actions alongside the desktop targets, producing
per-ABI release APKs for **arm64-v8a** (phones) and **x86_64** (emulators / x86
devices); 32-bit is dropped by design.

- **`.github/workflows/ci.yml`** — `build-android` job: on master pushes (and
  manual `workflow_dispatch`) builds the two APKs and uploads them as a CI
  artifact (`arkstage-android-<sha>`). Debug-signed (no keystore in CI), but
  installable for testing.
- **`.github/workflows/release.yml`** — `android` job: on a `v*` tag, builds the
  arm64-v8a APK, verifies its certificate, package name and version, then attaches
  `arkstage-<tag>-android-arm64-v8a.apk` and its `.sha256` file to the draft Release.

Both set up JDK 21, the Android SDK + NDK 27.2.12479018 and the required Rust
targets. CI builds both ABIs; Release uses
`npm run tauri android build -- --apk --target aarch64 --split-per-abi`.

**Release signing in Actions** requires these repository secrets. Missing keys,
an unexpected certificate or a missing APK fail the release job rather than
silently producing a new signing identity:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 prts-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias (e.g. `prts`) |
| `ANDROID_KEY_PASSWORD` | key password |

The release job decodes `ANDROID_KEYSTORE_BASE64` to a file and exports the
`ANDROID_KEYSTORE_*` env vars that `build.gradle.kts` reads. Its public certificate
fingerprint is pinned in `release.yml`; preserve the existing identity when
updating the workflow. APK construction and upload are performed by Actions,
not by manually uploading a local build.

The compatibility baseline is the published v1.1.5 APK, whose certificate SHA-256
is `c7abaa362386570e28c7df3791fa1e41052e26f515a6389c94536f0ad7dcede8`.
Historical v1.1.4 used a different runner-generated debug certificate; the old
optional-signing workflow did not ensure a stable signing identity. Use the
original v1.1.5 keystore to preserve upgrades from that release. The different
local test keystore cannot substitute for it, and an APK contains no recoverable
signing private key.

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
  call resolves to `/storage/emulated/0/Android/data/cn.aunly.arkstage/files/`, and
  all `cache/`, `assets/`, `media/` data lands there. No internal-storage
  fallback was needed.
- **Asset-protocol scope:** confirmed. The NotoSans font and engine deps load via
  `convertFileSrc()` → `asset://` from the external `assets/engine/` dir with **no**
  "Not allowed to load local resource" / scope-denial errors. The
  `**/Android/data/cn.aunly.arkstage/files/**` scope glob is sufficient.
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
