#!/usr/bin/env bash
#
# Pre-commit cleanup. Removes build artifacts and stray scratch files so they
# never sneak into a commit and keeps the working tree tidy.
#
# SAFE BY DESIGN: it only deletes known generated/junk patterns (build outputs,
# OS/editor cruft, root-level scratch screenshots/logs) — never tracked source.
# As a guard it refuses to delete anything git currently tracks.
#
# Usage:
#   scripts/precommit-clean.sh            # clean
#   scripts/precommit-clean.sh --dry-run  # show what would be removed
#
# Optional: wire it as a real git hook so it runs automatically:
#   ln -sf ../../scripts/precommit-clean.sh .git/hooks/pre-commit
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
DRY_LABEL=""
if [ "${1:-}" = "--dry-run" ]; then
  DRY=1
  DRY_LABEL=" (dry-run)"
fi

removed=0

# Delete a path unless git tracks it (tracked files are never touched).
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

echo "==> Cleaning build artifacts and scratch files${DRY_LABEL}"

# Frontend / build outputs (also gitignored; cleaned to keep the tree tidy).
rm_path dist
rm_path dist-ssr
rm_path src-tauri/gen

# Windows build products that scripts/build-*.sh drop in the project root.
rm_path prts-reader-portable
rm_path prts-reader-portable.zip
shopt -s nullglob
for f in ./*-setup.exe ./*.msi ./*.deb ./*.rpm ./*.AppImage ./*.dmg ./*.zip ./*.exe; do
  rm_path "$f"
done

# Scratch artifacts dropped at the repo root while debugging / iterating in chat
# (screenshots pasted in for review, captured logs, scratch images).
for f in ./error.txt ./image.png ./image*.png ./screenshot*.png ./*.tmp; do
  rm_path "$f"
done
shopt -u nullglob

# OS / editor cruft anywhere in the tree (skip the heavy/ignored dirs).
while IFS= read -r f; do
  rm_path "$f"
done < <(find . \( -path ./node_modules -o -path ./src-tauri/target -o -path ./.git \) -prune -o \
  -type f \( -name '.DS_Store' -o -name 'Thumbs.db' -o -name '*.swp' -o -name '*~' \) -print)

if [ "$removed" -eq 0 ]; then
  echo "==> Nothing to clean."
elif [ "$DRY" = 1 ]; then
  echo "==> Done. ${removed} item(s) would be removed."
else
  echo "==> Done. ${removed} item(s) removed."
fi
