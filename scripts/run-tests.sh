#!/usr/bin/env bash
# Run the full test suite: static checks, then the headless E2E smoke test.
set -uo pipefail
cd "$(dirname "$0")/.."

rc=0
echo "######## STATIC CHECKS ########"
bash scripts/test-static.sh || rc=1

echo
echo "######## E2E SMOKE TEST ########"
bash scripts/test-e2e.sh || rc=1

echo
if [ "$rc" -eq 0 ]; then echo "SUITE: ALL PASS"; else echo "SUITE: FAILURES PRESENT"; fi
exit $rc
