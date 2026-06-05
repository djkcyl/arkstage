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
# Usage: scripts/build-windows.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

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
npm run tauri:build -- --target x86_64-pc-windows-gnu

OUT_DIR="src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis"
echo
echo "==> Done. Installer(s):"
ls -lh "$OUT_DIR"/*-setup.exe 2>/dev/null || { echo "No installer found in $OUT_DIR" >&2; exit 1; }
