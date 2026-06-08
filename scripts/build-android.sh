#!/usr/bin/env bash
#
# Build a sideloadable Android **debug APK** for prts-reader and copy it to
# build/artifacts/. Mirrors scripts/build-windows.sh in spirit: installs missing
# toolchain bits, builds, copies the artifact out, and leaves the repo clean.
#
# ABIs: aarch64 (real devices) + x86_64 (emulator). No 32-bit armv7 (by design).
#
# Release signing: this script builds a debug-signed APK by default. To cut a
# signed release later, set the keystore env vars (see docs/android-build.md)
# and run with RELEASE=1 — the Gradle signingConfig (app/build.gradle.kts) reads
# those vars and the build switches to --release. With the vars unset, a release
# build still falls back to debug signing so it installs on a dev device.
#
# Usage:
#   scripts/build-android.sh                 # debug APK, both ABIs
#   ABI=x86_64 scripts/build-android.sh      # single ABI (faster, emulator only)
#   ABI=aarch64 scripts/build-android.sh     # single ABI (real devices)
#   RELEASE=1 scripts/build-android.sh       # release APK (see signing note)
set -euo pipefail
cd "$(dirname "$0")/.."

SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

# --- Toolchain locations (override via env if your SDK/NDK live elsewhere) ---
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
NDK_VERSION="${NDK_VERSION:-27.2.12479018}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/$NDK_VERSION}"
export ANDROID_NDK_HOME="$NDK_HOME"
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"

# --- Ensure a JDK (with javac). Gradle's Java toolchain needs a COMPILER, not
# just a JRE; a JRE-only JAVA_HOME fails with "does not provide JAVA_COMPILER". ---
ensure_jdk() {
  if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/javac" ]; then
    return
  fi
  local cand
  for cand in \
    /usr/lib/jvm/java-21-openjdk-amd64 \
    /usr/lib/jvm/java-17-openjdk-amd64 \
    /usr/lib/jvm/default-java; do
    if [ -x "$cand/bin/javac" ]; then
      export JAVA_HOME="$cand"; echo "==> Using JDK at $JAVA_HOME"; return
    fi
  done
  if command -v javac >/dev/null; then
    local jh
    jh="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
    if [ -x "$jh/bin/javac" ]; then
      export JAVA_HOME="$jh"; echo "==> Using JDK at $JAVA_HOME"; return
    fi
  fi
  echo "ERROR: no JDK with 'javac' found (Gradle needs a full JDK, not a JRE)." >&2
  echo "Install one, e.g.: $SUDO apt-get install -y openjdk-21-jdk-headless" >&2
  exit 2
}
ensure_jdk

echo "==> Checking Rust Android targets"
rustup target add aarch64-linux-android x86_64-linux-android

echo "==> Checking NDK at $NDK_HOME"
if [ ! -d "$NDK_HOME" ]; then
  echo "    installing ndk;$NDK_VERSION (+ platforms;android-35, build-tools;35.0.0)"
  yes | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" \
    "ndk;$NDK_VERSION" "platforms;android-35" "build-tools;35.0.0"
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

# --- Pre-build cleanup: drop junk, then remove any stale APK from a prior run
# so the output dir only ever holds the current build's artifacts. ---
echo "==> Pre-build cleanup"
scripts/clean.sh --junk
ARTIFACTS_DIR="build/artifacts"
mkdir -p "$ARTIFACTS_DIR"
rm -f "$ARTIFACTS_DIR"/*.apk
# Ensure a fresh frontend bundle.
rm -rf build/dist

echo "==> Building Android APK ($mode_flag, ABI=${ABI:-aarch64+x86_64}, JAVA_HOME=$JAVA_HOME)"
npm run tauri android build -- --apk "$mode_flag" "${target_args[@]}"

# Copy the produced APK(s) to build/artifacts/. Tauri emits them under
# app/build/outputs/apk/<flavor>/<buildType>/.
out_dir="src-tauri/gen/android/app/build/outputs/apk"
mapfile -t apks < <(find "$out_dir" -name "*.apk" 2>/dev/null)
if [ "${#apks[@]}" -eq 0 ]; then
  echo "ERROR: no APK produced under $out_dir" >&2
  exit 1
fi
for apk in "${apks[@]}"; do
  dest="$ARTIFACTS_DIR/$(basename "$apk")"
  cp -f "$apk" "$dest"
  echo "    -> $dest"
done

# --- Post-build cleanup: clear scratch/junk; final APK(s) stay in artifacts. ---
echo "==> Post-build cleanup"
scripts/clean.sh --junk

echo
echo "==> Done. APK(s) in $ARTIFACTS_DIR:"
ls -lh "$ARTIFACTS_DIR"/*.apk
