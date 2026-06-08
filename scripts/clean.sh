#!/usr/bin/env bash
#
# Unified cleanup. Removes build outputs and/or scratch/junk files.
#
# SAFE BY DESIGN: only deletes known generated/junk patterns; as a guard it
# refuses to delete anything git currently tracks.
#
# Usage:
#   scripts/clean.sh             # clean BOTH build outputs and junk (default)
#   scripts/clean.sh --build     # only build outputs (build/, dist, gen)
#   scripts/clean.sh --junk      # only scratch / OS / editor junk
#   scripts/clean.sh --dry-run   # show what would be removed (combine w/ above)
set -euo pipefail
cd "$(dirname "$0")/.."

DO_BUILD=0
DO_JUNK=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --build)   DO_BUILD=1 ;;
    --junk)    DO_JUNK=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done
# Default with no scope flag: do both.
if [ "$DO_BUILD" = 0 ] && [ "$DO_JUNK" = 0 ]; then
  DO_BUILD=1; DO_JUNK=1
fi

removed=0
# Delete a path unless git tracks it (tracked files/dirs are never touched).
rm_path() {
  local p="$1"
  [ -e "$p" ] || return 0
  if git ls-files --error-unmatch "$p" >/dev/null 2>&1; then
    echo "  skip (tracked): $p"
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    echo "  would remove: $p"
  else
    echo "  removing: $p"
    rm -rf "$p"
  fi
  removed=$((removed + 1))
}

if [ "$DO_BUILD" = 1 ]; then
  echo "==> Cleaning build outputs"
  rm_path build
  rm_path dist
  rm_path dist-ssr
  rm_path src-tauri/gen   # guard skips gen/android (tracked); clears gen/schemas etc.
fi

if [ "$DO_JUNK" = 1 ]; then
  echo "==> Cleaning scratch / OS / editor junk"
  shopt -s nullglob
  for f in ./error.txt ./image.png ./image*.png ./screenshot*.png ./*.tmp; do
    rm_path "$f"
  done
  shopt -u nullglob
  # OS / editor cruft anywhere (skip heavy/ignored dirs).
  while IFS= read -r f; do
    rm_path "$f"
  done < <(find . \( -path ./node_modules -o -path ./src-tauri/target -o -path ./.git -o -path ./build \) -prune -o \
    -type f \( -name '.DS_Store' -o -name 'Thumbs.db' -o -name '*.swp' -o -name '*~' \) -print)
fi

if [ "$removed" -eq 0 ]; then
  echo "==> Nothing to clean."
elif [ "$DRY" = 1 ]; then
  echo "==> Done. ${removed} item(s) would be removed."
else
  echo "==> Done. ${removed} item(s) removed."
fi
