#!/usr/bin/env bash
#
# Pre-commit cleanup — thin wrapper around scripts/clean.sh that removes build
# artifacts and stray scratch files so they never sneak into a commit.
#
# SAFE: clean.sh only deletes known generated/junk patterns and refuses to
# delete anything git currently tracks.
#
# Usage:
#   scripts/precommit-clean.sh            # clean
#   scripts/precommit-clean.sh --dry-run  # show what would be removed
#
# Optional git hook:
#   ln -sf ../../scripts/precommit-clean.sh .git/hooks/pre-commit
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--dry-run" ]; then
  exec scripts/clean.sh --dry-run
fi
exec scripts/clean.sh
