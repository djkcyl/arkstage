#!/usr/bin/env bash
# Deterministic end-to-end test for the real iframe manifest + Rust downloader.
# Unlike test-e2e.sh, this does not click pixel coordinates: a development-only
# probe route runs the same runPredownload() function used by the bookshelf UI and
# writes a machine-readable terminal report through the real Tauri cache command.

set -euo pipefail
cd "$(dirname "$0")/.."

DISP="${PRTS_MANIFEST_DISPLAY:-:98}"
APPID="cn.aunly.arkstage"
APPDATA="${XDG_DATA_HOME:-$HOME/.local/share}/$APPID"
TEST_DATA="$APPDATA/manifest-probe"
REPORT="$TEST_DATA/cache/e2e-manifest-probe.json"
APP_LOG="${PRTS_MANIFEST_LOG:-/tmp/prts-manifest-e2e-app.log}"
XVFB_LOG="${PRTS_MANIFEST_XVFB_LOG:-/tmp/prts-manifest-e2e-xvfb.log}"

if [ "$#" -eq 0 ]; then
  set -- "W2G/BEG"
fi

for tool in Xvfb node npx; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 2; }
done

query=""
for title in "$@"; do
  encoded=$(node -p 'encodeURIComponent(process.argv[1])' "$title")
  [ -n "$query" ] && query="$query&"
  query="${query}manifestProbe=${encoded}"
done
config=$(node -e 'console.log(JSON.stringify({build:{devUrl:process.argv[1]}}))' "http://localhost:5174/?$query")

cleanup() {
  [ -n "${app_pid:-}" ] && kill "$app_pid" 2>/dev/null || true
  [ -n "${xvfb_pid:-}" ] && kill "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT

# TEST_DATA is a dedicated child of the app data directory, never the app data
# root itself. Fresh state ensures manifestDone cannot be inherited from a cache.
rm -rf "$TEST_DATA"
mkdir -p "$TEST_DATA"

Xvfb "$DISP" -screen 0 1280x800x24 -ac -nolisten tcp >"$XVFB_LOG" 2>&1 &
xvfb_pid=$!
sleep 1

DISPLAY="$DISP" PRTS_DATA_DIR="$TEST_DATA" npx tauri dev --config "$config" >"$APP_LOG" 2>&1 &
app_pid=$!

deadline=$((SECONDS + ${PRTS_MANIFEST_TIMEOUT:-240}))
while [ ! -s "$REPORT" ] && [ "$SECONDS" -lt "$deadline" ]; do
  if ! kill -0 "$app_pid" 2>/dev/null; then
    echo "Tauri app exited before writing the manifest report" >&2
    tail -80 "$APP_LOG" >&2
    exit 1
  fi
  sleep 1
done

if [ ! -s "$REPORT" ]; then
  echo "timed out waiting for $REPORT" >&2
  tail -80 "$APP_LOG" >&2
  exit 1
fi

node -e '
  const fs = require("fs");
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const expected = Number(process.argv[2]);
  const status = report.status || {};
  const job = report.job || {};
  const problems = [];
  if (!report.ok) problems.push(report.error || "probe returned ok=false");
  if (status.manifestDone !== expected || status.manifestTotal !== expected) {
    problems.push(`manifest ${status.manifestDone}/${status.manifestTotal}, expected ${expected}/${expected}`);
  }
  if (job.status !== "completed") problems.push(`job status ${job.status}`);
  if (!(job.total > 0)) problems.push("download job discovered zero assets");
  if (job.failed !== 0 || (job.failedKeys || []).length !== 0) {
    problems.push(`${job.failed} failed assets`);
  }
  if (problems.length) {
    console.error("MANIFEST E2E FAILED: " + problems.join("; "));
    process.exit(1);
  }
  console.log(`MANIFEST E2E PASS: ${expected}/${expected} stories, ${job.done}/${job.total} assets, failed 0`);
' "$REPORT" "$#"
