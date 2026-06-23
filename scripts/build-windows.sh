#!/usr/bin/env bash
#
# Cross-build a Windows installer FROM Linux (or macOS), producing an NSIS
# `*-setup.exe` via the MinGW (x86_64-pc-windows-gnu) toolchain.
#
# Notes / caveats:
#   - Produces an NSIS installer (*-setup.exe). **MSI cannot be built off-Windows**
#     (it needs the WiX toolset); Tauri logs "ignoring msi" and continues with NSIS.
#   - The binary uses the GNU ABI (not MSVC like GitHub's windows-latest). It runs on
#     Windows, but for the most "official" artifact use the Release workflow (windows-latest)
#     or cargo-xwin (--target x86_64-pc-windows-msvc).
#   - Tauri marks cross-compilation as experimental; the installer is unsigned.
#   - First run downloads nsis_tauri_utils.dll from GitHub (needs network).
#
# The finished installer is copied into the PROJECT ROOT, and the (large)
# intermediate cross-compile target dir is removed afterwards. Set KEEP_TARGET=1
# to keep it for faster rebuilds.
#
# Usage: scripts/build-windows.sh   [KEEP_TARGET=1 scripts/build-windows.sh]
set -euo pipefail
cd "$(dirname "$0")/.."

SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

TRIPLE_DIR="src-tauri/target/x86_64-pc-windows-gnu"

# --- Pre-build cleanup: start fresh so a stale/partial previous build can't leak in.
# Removes the prior installer and (unless KEEP_TARGET=1) the cross-compile cache. ---
echo "==> Cleaning stale build products before building"
echo "==> Pre-build cleanup"
scripts/clean.sh --junk
ARTIFACTS_DIR="build/artifacts"
mkdir -p "$ARTIFACTS_DIR"
rm -f "$ARTIFACTS_DIR"/*-setup.exe
if [ "${KEEP_TARGET:-0}" = "1" ]; then
  echo "    KEEP_TARGET=1; keeping cross-compile cache at $TRIPLE_DIR (faster rebuilds)"
else
  rm -rf "$TRIPLE_DIR"
fi

echo "==> Checking host tools (mingw-w64 + nsis)"
need_pkgs=()
command -v x86_64-w64-mingw32-gcc >/dev/null || need_pkgs+=(mingw-w64)
command -v makensis >/dev/null || need_pkgs+=(nsis)
if [ "${#need_pkgs[@]}" -gt 0 ]; then
  if command -v apt-get >/dev/null; then
    echo "    installing: ${need_pkgs[*]}"
    $SUDO apt-get update -qq
    $SUDO apt-get install -y "${need_pkgs[@]}"
  else
    echo "ERROR: missing ${need_pkgs[*]} and no apt-get to install them." >&2
    echo "Install the MinGW-w64 toolchain and NSIS for your distro, then re-run." >&2
    exit 2
  fi
fi

echo "==> Ensuring Rust target x86_64-pc-windows-gnu"
rustup target add x86_64-pc-windows-gnu

echo "==> Building (no --bundles: tauri picks the target's bundlers; MSI is skipped on Linux)"
# Release build: on-screen debug console OFF by default (users can enable it in
# Settings) — matches build-android.sh RELEASE=1. Override with VITE_DEBUG_DEFAULT=true.
export VITE_DEBUG_DEFAULT="${VITE_DEBUG_DEFAULT:-false}"
npm run tauri:build -- --target x86_64-pc-windows-gnu

installer="$(ls -1 "$TRIPLE_DIR/release/bundle/nsis/"*-setup.exe 2>/dev/null | head -1 || true)"
if [ -z "$installer" ]; then
  echo "ERROR: no NSIS installer was produced under $TRIPLE_DIR/release/bundle/nsis" >&2
  exit 1
fi

# Put the finished installer in build/artifacts/.
dest="$ARTIFACTS_DIR/$(basename "$installer")"
cp -f "$installer" "$dest"

# Remove the heavy intermediate cross-compile target dir (KEEP_TARGET=1 to keep it).
if [ "${KEEP_TARGET:-0}" = "1" ]; then
  echo "==> KEEP_TARGET=1 set; keeping $TRIPLE_DIR"
else
  echo "==> Cleaning intermediate build products ($TRIPLE_DIR)"
  rm -rf "$TRIPLE_DIR"
fi

echo
echo "==> Post-build cleanup"
scripts/clean.sh --junk
echo "==> Done. Installer is in $ARTIFACTS_DIR:"
ls -lh "$dest"
