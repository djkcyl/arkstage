# Test scripts

| Script | What it does | Needs network | Needs display |
|--------|--------------|:-------------:|:-------------:|
| `test-static.sh` | `cargo test` + `cargo build` + `tsc -b` + `vite build` | no | no |
| `test-e2e.sh` | launches the real app under headless **Xvfb**, drives the UI with **xdotool**, asserts on real side-effects | **yes** (prts.wiki) | Xvfb |
| `run-tests.sh` | runs static then e2e | yes | Xvfb |

```bash
scripts/test-static.sh     # fast, offline
scripts/test-e2e.sh        # full app smoke test (headless)
scripts/run-tests.sh       # everything
```

## What `test-e2e.sh` proves

It does not trust screenshots alone — each step asserts an **observable side-effect** the app only produces if the feature actually ran:

1. the app **window appears** (boot works);
2. visiting the browser writes `cache/story-index.json` (wiki index fetch + parse);
3. opening a story writes `cache/widget-bundle-v2.json` + `cache/stories_*.json` (engine bundle + story fetch);
4. a 1s long-press fills `media/{host}/{path}` (engine preload through the `prts-cdn://` handler with cache-through persist);
5. the canvas region has real pixel variance (the engine actually **drew a scene**);
6. predownloading a *fresh* story **grows the media store** (the iframe-isolated `fun_sys_preload` manifest capture + `batch_download_assets`), and the log is checked for the `duplicate variable` regression.

Screenshots are written to `/tmp/prts-e2e/` (`01_home` … `05_story_b_loaded`).

## Requirements / caveats

- Tools: `Xvfb`, `xdotool`, ImageMagick (`import`, `convert`), `npm`, a built Rust toolchain (`cargo`).
- `test-e2e.sh` clears `~/.local/share/com.prts.reader/{cache,media,assets}` for a deterministic run.
- **Audio is not tested** — Linux WebKitGTK often lacks mp3/ogg codecs; this verifies the visual pipeline only. Real target platforms (Windows/macOS) ship codecs.
- UI coordinates assume the window pinned at `0,0` size `1024x600` with no window manager (the script pins this). Override the display with `PRTS_TEST_DISPLAY=:N`.
