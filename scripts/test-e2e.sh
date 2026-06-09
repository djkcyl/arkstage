#!/usr/bin/env bash
#
# End-to-end smoke test: launches the real Tauri app under a headless Xvfb X
# server, drives the UI with xdotool, and ASSERTS on observable side-effects:
#
#   - the app window actually appears                  (app boots)
#   - visiting the browser writes story-index cache    (wiki index fetch + parse)
#   - opening a story writes widget-bundle + script    (engine bundle + story fetch)
#   - opening a story fills the content-addressed store (engine AUTO-preload via prts-cdn://)
#   - a story scene renders (pixel variance in canvas) (engine actually draws)
#   - opening a second story also grows the store      (fresh iframe realm, no dup-var)
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
STORY_B_X=71;       STORY_B_Y=295          # a different story ("序章·上"), opened to test a 2nd realm
PLAY_CX=512;        PLAY_CY=300            # centre of the play area

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
echo " Arkstage (方舟剧场) — E2E smoke test (headless Xvfb + xdotool)"
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
# Pin the data root to APPDATA so the assertions below (which check $APPDATA/media
# etc.) stay valid. In a real release the default is the exe's own folder.
info "launching: DISPLAY=$DISP PRTS_DATA_DIR=$APPDATA npm run tauri:dev (cold-ish, may take a minute)"
( DISPLAY=$DISP PRTS_DATA_DIR="$APPDATA" npm run tauri:dev >"$APP_LOG" 2>&1 & )
WID=""
for _ in $(seq 1 120); do
  WID=$(DISPLAY=$DISP xdotool search --name "方舟剧场" 2>/dev/null | head -1)
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
pre_media=$(count_media)   # baseline BEFORE opening (engine auto-preload starts on boot)
cl "$STORY_A_X" "$STORY_A_Y" 2
info "opened a story; waiting for engine bundle + story script to cache"
wait_file "$CACHE/widget-bundle-v2.json" 40 && ok "engine widget bundle cached (widget-bundle-v2.json)" || no "engine bundle not cached"
# The story script is saved asynchronously after the bundle, so poll for it.
sd_deadline=$((SECONDS+30))
while ! ls "$CACHE"/stories_*.json >/dev/null 2>&1 && [ $SECONDS -lt $sd_deadline ]; do sleep 1; done
if ls "$CACHE"/stories_*.json >/dev/null 2>&1; then ok "story script cached (stories_*.json)"; else no "story script not cached"; fi
sleep 4   # let engine finish booting (deps + scripts)
shot 03_player_loaded

# ---- 6. AUTO-preload via prts-cdn:// (no long-press gate) -------------------
# The long-press "1s to start preload" gate was removed: preload now starts
# automatically on boot, so the media store should fill without any interaction.
info "engine loaded; media files before open: $pre_media. Waiting for auto-preload to fill the store."
wait_media $((pre_media+3)) 40
post_media=$(count_media)
if [ "$post_media" -ge $((pre_media+3)) ]; then ok "engine auto-preloaded assets via prts-cdn:// (media $pre_media -> $post_media)"; else no "no assets fetched after auto-preload (media stayed $post_media)"; fi

# ---- 7. scene renders -------------------------------------------------------
sleep 3
cl "$PLAY_CX" "$PLAY_CY" 2     # click to start playback
cl "$PLAY_CX" "$PLAY_CY" 2     # advance a line
shot 04_scene
sd=$(region_stddev "$SHOTS/04_scene.png")
if awk -v v="$sd" 'BEGIN{exit !(v+0>0.04)}'; then ok "story scene rendered (canvas stddev=$sd)"; else no "story scene did not render (canvas stddev=$sd)"; fi

# ---- 8. open a SECOND story (fresh iframe realm boots + renders) ------------
# Opening another story boots a second engine in a FRESH iframe realm. The real
# regression risk is realm isolation: re-running the engine in a shared realm
# throws "duplicate variable" and the scene never draws. (We don't assert media
# growth here — the content-addressed store dedups, so a 2nd story that reuses
# already-cached assets legitimately adds zero files.)
cl 42 22 2                      # 返回 -> browser
cl "$STORY_B_X" "$STORY_B_Y" 6  # open a different story
shot 05_story_b_loaded
info "opened a second story; waiting for it to boot, then clicking to render a scene"
sleep 4
cl "$PLAY_CX" "$PLAY_CY" 2     # click to start playback
cl "$PLAY_CX" "$PLAY_CY" 2     # advance a line
shot 06_story_b_scene
sd=$(region_stddev "$SHOTS/06_story_b_scene.png")
if awk -v v="$sd" 'BEGIN{exit !(v+0>0.04)}'; then ok "second story rendered in a fresh realm (canvas stddev=$sd)"; else no "second story did not render (canvas stddev=$sd); realm boot broken"; fi
# guard against the known 'duplicate variable' realm bug regressing
if grep -q "duplicate variable" "$APP_LOG"; then no "engine threw 'duplicate variable' (realm isolation regressed)"; else ok "no 'duplicate variable' engine error in log"; fi

# ---- summary ----------------------------------------------------------------
echo "=============================================================="
echo " RESULT: $PASS passed, $FAIL failed.  Screenshots in $SHOTS"
echo "=============================================================="
[ "$FAIL" -eq 0 ] && { echo "E2E: ALL PASS"; exit 0; } || { echo "E2E: FAILURES PRESENT"; exit 1; }
