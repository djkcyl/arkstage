#!/usr/bin/env bash
#
# Build sideloadable Android APKs for prts-reader and copy them to
# build/artifacts/. Mirrors scripts/build-windows.sh in spirit: installs missing
# toolchain bits, builds, copies the artifact(s) out, and leaves the repo clean.
#
# Size: this script produces SMALL, per-ABI release APKs. The native Rust .so is
# strip+LTO+size-optimized via Cargo's [profile.release], and ABIs are split into
# separate APKs (Tauri --split-per-abi over Gradle product flavors) instead of one
# giant "universal" debug APK. A single-arch APK lands around ~15-25 MB vs the old
# ~650 MB all-ABIs-unstripped-debug bundle.
#
# Default output (3 APKs): arm64-v8a, x86_64, and a combined universal (both ABIs).
# 32-bit (armv7/x86) is intentionally dropped — no modern target needs it.
#
# Mode: RELEASE build by default (strip + optimize). Pass RELEASE=0 for a debug
# APK (unstripped, on-screen debug console on, cleartext allowed) for dev work.
#
# Release signing: a release build is debug-SIGNED unless you provide a keystore.
# Set the ANDROID_KEYSTORE_* env vars (see docs/android-build.md) and the Gradle
# signingConfig switches to your real keystore; unset, it falls back to debug
# signing so the APK still installs on a dev device.
#
# Usage:
#   scripts/build-android.sh                 # release: arm64 + x86_64 + universal APKs
#   ABI=aarch64 scripts/build-android.sh     # single ABI only (real devices)
#   ABI=x86_64  scripts/build-android.sh     # single ABI only (emulator)
#   RELEASE=0   scripts/build-android.sh     # debug APKs (unstripped, dev console)
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

# Build mode: RELEASE by default (strip + optimize). RELEASE=0 → debug APK.
RELEASE="${RELEASE:-1}"
# `tauri android build` defaults to RELEASE — there is no `--release` flag, only
# `--debug` to opt out. So mode_args is empty for release, `--debug` otherwise.
mode_args=()
if [ "$RELEASE" = "1" ]; then
  mode_desc="release"
  # Release ships a clean production build: on-screen debug console OFF by default
  # (users can still enable it in Settings).
  export VITE_DEBUG_DEFAULT="${VITE_DEBUG_DEFAULT:-false}"
else
  mode_args=(--debug)
  mode_desc="debug"
  # Debug builds default the on-screen console ON for dev work.
  export VITE_DEBUG_DEFAULT="${VITE_DEBUG_DEFAULT:-true}"
fi

# ABI selection. Default = arm64-v8a (real devices) + x86_64 (emulator/x86). 32-bit
# is dropped by design. ABI=<tauri-target> restricts to a single architecture.
# Map Tauri target name -> Rust toolchain triple.
declare -A RUST_TRIPLE=(
  [aarch64]=aarch64-linux-android
  [x86_64]=x86_64-linux-android
  [armv7]=armv7-linux-androideabi
  [i686]=i686-linux-android
)
if [ -n "${ABI:-}" ]; then
  TARGETS=("$ABI")
else
  TARGETS=(aarch64 x86_64)
fi
# Validate + collect the Rust triples to install.
triples=()
for t in "${TARGETS[@]}"; do
  if [ -z "${RUST_TRIPLE[$t]:-}" ]; then
    echo "ERROR: unknown ABI '$t' (use one of: ${!RUST_TRIPLE[*]})" >&2
    exit 2
  fi
  triples+=("${RUST_TRIPLE[$t]}")
done
target_args=()
for t in "${TARGETS[@]}"; do target_args+=(--target "$t"); done

echo "==> Checking Rust Android targets: ${triples[*]}"
rustup target add "${triples[@]}"

# --- Pre-build cleanup: drop junk, then remove any stale APK from a prior run
# so the output dir only ever holds the current build's artifacts. ---
echo "==> Pre-build cleanup"
scripts/clean.sh --junk
ARTIFACTS_DIR="build/artifacts"
mkdir -p "$ARTIFACTS_DIR"
rm -f "$ARTIFACTS_DIR"/*.apk
# Ensure a fresh frontend bundle.
rm -rf build/dist

# Clear stale APK outputs so the final collection only sees this run's artifacts.
out_dir="src-tauri/gen/android/app/build/outputs/apk"
rm -rf "$out_dir"

# Build per-ABI APKs (one small APK per architecture). --split-per-abi maps to
# Tauri's per-arch Gradle product flavors instead of the bloated universal flavor.
echo "==> Building per-ABI Android APK(s) ($mode_desc, ABI=${TARGETS[*]}, JAVA_HOME=$JAVA_HOME)"
npm run tauri android build -- --apk "${mode_args[@]}" "${target_args[@]}" --split-per-abi

# Also build a combined "universal" APK (all selected ABIs in one) when more than
# one ABI is targeted — handy for "just give me one APK that installs anywhere".
if [ "${#TARGETS[@]}" -gt 1 ]; then
  echo "==> Building combined universal APK ($mode_desc, ABIs=${TARGETS[*]})"
  npm run tauri android build -- --apk "${mode_args[@]}" "${target_args[@]}"
fi

# Copy the produced APK(s) to build/artifacts/. Tauri emits them under
# app/build/outputs/apk/<flavor>/<buildType>/.
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
