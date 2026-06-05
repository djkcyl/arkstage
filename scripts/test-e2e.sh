#!/usr/bin/env bash
#
# End-to-end smoke test: launches the real Tauri app under a headless Xvfb X
# server, drives the UI with xdotool, and ASSERTS on observable side-effects:
#
#   - the app window actually appears                  (app boots)
#   - visiting the browser writes story-index cache    (wiki index fetch + parse)
#   - opening a story writes widget-bundle + script    (engine bundle + story fetch)
#   - long-pressing fills the content-addressed store  (engine preload via prts-cdn://)
#   - a story scene renders (pixel variance in canvas) (engine actually draws)
#   - predownloading a fresh story grows the store     (iframe manifest capture + batch dl)
#
# Requires network (prts.wiki) and: Xvfb, xdotool, ImageMagick (import/convert).
# Usage: scripts/test-e2e.sh   (run from anywhere; needs the repo built)
#
# NOTE: requires a connected display server backend for Xvfb. Audio is NOT tested
# (Linux WebKitGTK may lack mp3/ogg codecs); this test verifies the VISUAL pipeline.

set -uo pipefail
cd "$(dirname "$0")/.."

# ---- config -----------------------------------------------------------------
DISP="${PRTS_TEST_DISPLAY:-:99}"
APPID="com.prts.reader"
APPDATA="${XDG_DATA_HOME:-$HOME/.local/share}/$APPID"
MEDIA="$APPDATA/media"
CACHE="$APPDATA/cache"
SHOTS="${PRTS_TEST_SHOTS:-/tmp/prts-e2e}"
APP_LOG=/tmp/prts-e2e-app.log
XVFB_LOG=/tmp/prts-e2e-xvfb.log
WIN_W=1024; WIN_H=600

# UI coordinates (window pinned at 0,0 with size ${WIN_W}x${WIN_H}, no WM).
HOME_BROWSE_X=476;  HOME_BROWSE_Y=384      # "浏览剧情" button on Home
STORY_A_X=235;      STORY_A_Y=295          # first story link ("0-1 坍塌 行动前")
STORY_B_X=71;       STORY_B_Y=295          # a different story ("序章·上") for predownload
PLAY_CX=512;        PLAY_CY=300            # centre of the play area
PREDL_X=950;        PREDL_Y=22             # "预下载本剧情资源" button (player, top-right)

mkdir -p "$SHOTS"
PASS=0; FAIL=0

ok(){ echo "  PASS  $*"; PASS=$((PASS+1)); }
no(){ echo "  FAIL  $*"; FAIL=$((FAIL+1)); }
info(){ echo "  ..    $*"; }

cleanup(){
  pkill -f "$PWD/src-tauri/target/debug/app" 2>/dev/null
  pkill -f "tauri dev" 2>/dev/null
  pkill -f "$PWD/node_modules/.bin/vite" 2>/dev/null
  pkill -f "Xvfb $DISP" 2>/dev/null
}
trap cleanup EXIT

count_media(){ find "$MEDIA" -type f 2>/dev/null | wc -l | tr -d ' '; }
cl(){ DISPLAY=$DISP xdotool mousemove "$1" "$2" click 1; sleep "${3:-1}"; }
shot(){ DISPLAY=$DISP import -window root "$SHOTS/$1.png" 2>/dev/null; }
# grayscale std-dev of the canvas region (below the top button bar). ~0 = blank, higher = drawn content.
region_stddev(){ convert "$1" -crop "${WIN_W}x480+0+90" +repage -colorspace Gray -format "%[fx:standard_deviation]" info: 2>/dev/null; }
# poll until file exists (timeout seconds)
wait_file(){ local f=$1 t=${2:-30} d=$((SECONDS+${2:-30})); while [ ! -e "$f" ] && [ $SECONDS -lt $d ]; do sleep 1; done; [ -e "$f" ]; }
# poll until media count >= target (timeout seconds)
wait_media(){ local target=$1 d=$((SECONDS+${2:-40})); while [ "$(count_media)" -lt "$target" ] && [ $SECONDS -lt $d ]; do sleep 2; done; }

echo "=============================================================="
echo " PRTS Reader — E2E smoke test (headless Xvfb + xdotool)"
echo "=============================================================="

# ---- 0. tooling -------------------------------------------------------------
for t in Xvfb xdotool import convert npm; do
  command -v "$t" >/dev/null || { no "required tool present: $t"; echo; echo "Aborting: missing $t"; exit 2; }
done
ok "required tooling present (Xvfb, xdotool, ImageMagick, npm)"

# ---- 1. fresh state ---------------------------------------------------------
rm -rf "$CACHE" "$MEDIA" "$APPDATA/assets" 2>/dev/null
info "cleared app cache/media for a deterministic run"

# ---- 2. Xvfb ----------------------------------------------------------------
pkill -f "Xvfb $DISP" 2>/dev/null; sleep 1
Xvfb "$DISP" -screen 0 1280x800x24 -ac -nolisten tcp >"$XVFB_LOG" 2>&1 &
sleep 2
if DISPLAY=$DISP xdotool getdisplaygeometry >/dev/null 2>&1; then ok "Xvfb display $DISP is up"; else no "Xvfb display $DISP failed (see $XVFB_LOG)"; exit 2; fi

# ---- 3. launch app ----------------------------------------------------------
info "launching: DISPLAY=$DISP npm run tauri:dev (cold-ish, may take a minute)"
( DISPLAY=$DISP npm run tauri:dev >"$APP_LOG" 2>&1 & )
WID=""
for _ in $(seq 1 120); do
  WID=$(DISPLAY=$DISP xdotool search --name "PRTS 剧情阅读器" 2>/dev/null | head -1)
  [ -n "$WID" ] && break
  if grep -qiE "panicked|Failed to initialize GTK" "$APP_LOG"; then
    no "app crashed during launch"; grep -iE "panicked|Failed to initialize" "$APP_LOG" | head -2; exit 1
  fi
  sleep 1
done
if [ -n "$WID" ]; then ok "app window appeared (id $WID)"; else no "app window did not appear (see $APP_LOG)"; exit 1; fi

# pin geometry so UI coordinates are deterministic
DISPLAY=$DISP xdotool windowmove "$WID" 0 0 2>/dev/null
DISPLAY=$DISP xdotool windowsize "$WID" "$WIN_W" "$WIN_H" 2>/dev/null
sleep 2
shot 01_home
sd=$(region_stddev "$SHOTS/01_home.png")
if awk -v v="$sd" 'BEGIN{exit !(v+0>0.02)}'; then ok "Home page rendered content (stddev=$sd)"; else no "Home page looks blank (stddev=$sd)"; fi

# ---- 4. story index fetch+parse --------------------------------------------
cl "$HOME_BROWSE_X" "$HOME_BROWSE_Y" 2
info "opened browser; waiting for story index to fetch+cache"
if wait_file "$CACHE/story-index.json" 30; then ok "story index fetched & cached (story-index.json)"; else no "story index not cached (wiki fetch/parse failed?)"; fi
shot 02_browser
sd=$(region_stddev "$SHOTS/02_browser.png")
awk -v v="$sd" 'BEGIN{exit !(v+0>0.05)}' && ok "browser list rendered (stddev=$sd)" || no "browser list looks empty (stddev=$sd)"

# ---- 5. open a story: engine bundle + script -------------------------------
cl "$STORY_A_X" "$STORY_A_Y" 2
info "opened a story; waiting for engine bundle + story script to cache"
wait_file "$CACHE/widget-bundle-v2.json" 40 && ok "engine widget bundle cached (widget-bundle-v2.json)" || no "engine bundle not cached"
if ls "$CACHE"/stories_*.json >/dev/null 2>&1; then ok "story script cached (stories_*.json)"; else no "story script not cached"; fi
sleep 4   # let engine finish booting (deps + scripts) before long-press
shot 03_player_loaded

# ---- 6. preload via prts-cdn:// (long-press) -------------------------------
pre_media=$(count_media)
info "engine loaded; media files before preload: $pre_media. Long-pressing to trigger preload."
triggered=0
for attempt in 1 2 3; do
  DISPLAY=$DISP xdotool mousemove "$PLAY_CX" "$PLAY_CY" mousedown 1; sleep 1.4; DISPLAY=$DISP xdotool mouseup 1
  wait_media $((pre_media+3)) 20
  if [ "$(count_media)" -ge $((pre_media+3)) ]; then triggered=1; break; fi
  info "preload not detected yet (attempt $attempt), retrying long-press"
  sleep 3
done
post_media=$(count_media)
if [ "$triggered" = 1 ]; then ok "engine preloaded assets via prts-cdn:// (media $pre_media -> $post_media)"; else no "no assets fetched after preload (media stayed $post_media)"; fi

# ---- 7. scene renders -------------------------------------------------------
sleep 3
cl "$PLAY_CX" "$PLAY_CY" 2     # click to start playback
cl "$PLAY_CX" "$PLAY_CY" 2     # advance a line
shot 04_scene
sd=$(region_stddev "$SHOTS/04_scene.png")
if awk -v v="$sd" 'BEGIN{exit !(v+0>0.04)}'; then ok "story scene rendered (canvas stddev=$sd)"; else no "story scene did not render (canvas stddev=$sd)"; fi

# ---- 8. predownload a FRESH story (iframe manifest capture + batch dl) ------
cl 42 22 2                      # 返回 -> browser
base_media=$(count_media)
cl "$STORY_B_X" "$STORY_B_Y" 6  # open a different story
shot 05_story_b_loaded
cl "$PREDL_X" "$PREDL_Y" 1      # click 预下载本剧情资源
info "predownloading a fresh story; media before: $base_media"
wait_media $((base_media+3)) 45
grow_media=$(count_media)
if [ "$grow_media" -gt "$base_media" ]; then ok "predownload grew media store ($base_media -> $grow_media); iframe manifest capture works"; else no "predownload did not grow media store (stayed $base_media); manifest capture broken"; fi
# guard against the known 'duplicate variable' realm bug regressing
if grep -q "duplicate variable" "$APP_LOG"; then no "engine threw 'duplicate variable' (manifest realm isolation regressed)"; else ok "no 'duplicate variable' engine error in log"; fi

# ---- summary ----------------------------------------------------------------
echo "=============================================================="
echo " RESULT: $PASS passed, $FAIL failed.  Screenshots in $SHOTS"
echo "=============================================================="
[ "$FAIL" -eq 0 ] && { echo "E2E: ALL PASS"; exit 0; } || { echo "E2E: FAILURES PRESENT"; exit 1; }
