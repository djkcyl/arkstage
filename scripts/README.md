# Scripts

## Test scripts

| Script | What it does | Needs network | Needs display |
|--------|--------------|:-------------:|:-------------:|
| `test-static.sh` | `cargo test` + `cargo build` + `tsc -b frontend` + `vite build frontend` | no | no |
| `test-e2e.sh` | launches the real app under headless **Xvfb**, drives the UI with **xdotool**, asserts on real side-effects | **yes** (prts.wiki) | Xvfb |
| `test-manifest-e2e.sh [title...]` | runs the real iframe manifest + Rust downloader without fragile pixel clicks | **yes** (prts.wiki) | Xvfb |
| `run-tests.sh` | runs static then e2e | yes | Xvfb |

```bash
scripts/test-static.sh     # fast, offline
scripts/test-e2e.sh        # full app smoke test (headless)
scripts/test-manifest-e2e.sh "W2G/BEG" # deterministic manifest/download test
scripts/run-tests.sh       # everything
```

## Build & cleanup scripts

All build products land under **`build/artifacts/`** (gitignored). Each build
script cleans scratch/junk before and after, and deletes any stale same-type
artifact in `build/artifacts/` before building.

| Script | What it does | Needs network | Needs display |
|--------|--------------|:-------------:|:-------------:|
| `build-android.sh` | build a sideloadable Android APK → `build/artifacts/` (ABIs via `ABI=`, `RELEASE=1` for release signing) | yes (first run) | no |
| `build-windows.sh` | cross-build a Windows **NSIS** installer (`*-setup.exe`) from Linux via MinGW → `build/artifacts/` | yes (first run) | no |
| `build-windows-portable.sh` | cross-build a portable Windows folder + `.zip` → `build/artifacts/` | yes (first run) | no |
| `clean.sh` | remove build outputs and/or scratch junk; never deletes git-tracked files | no | no |
| `precommit-clean.sh` | thin wrapper around `clean.sh` (wire as a git pre-commit hook) | no | no |

```bash
scripts/clean.sh             # clean BOTH build outputs and junk (default)
scripts/clean.sh --build     # only build outputs (build/, dist, gen)
scripts/clean.sh --junk      # only scratch / OS / editor junk
scripts/clean.sh --dry-run   # show what would be removed (combine w/ above)
```

## What `test-e2e.sh` proves

It does not trust screenshots alone — each step asserts an **observable side-effect** the app only produces if the feature actually ran:

1. the app **window appears** (boot works);
2. visiting the browser writes `cache/story-index.json` (wiki index fetch + parse);
3. opening a story writes `cache/widget-bundle-v2.json` + `cache/stories_*.json` (engine bundle + story fetch);
4. a 1s long-press fills `media/{host}/{path}` (engine preload through the `prts-cdn://` handler with cache-through persist);
5. the canvas region has real pixel variance (the engine actually **drew a scene**);
6. opening a second story boots a fresh iframe realm, and the log is checked for the `duplicate variable` regression.

`test-manifest-e2e.sh` separately verifies the bookshelf download pipeline without
UI coordinates: every requested story must produce a non-empty `fun_sys_preload`
manifest, the Rust job must reach `completed`, and every discovered asset must be
downloaded or already cached with zero failures.

Screenshots are written to `/tmp/prts-e2e/` (`01_home` … `05_story_b_loaded`).

## Requirements / caveats

- Tools: `Xvfb`, `xdotool`, ImageMagick (`import`, `convert`), `npm`, a built Rust toolchain (`cargo`).
- `test-e2e.sh` clears `~/.local/share/cn.aunly.arkstage/{cache,media,assets}` for a deterministic run.
- **Audio is not tested** — Linux WebKitGTK often lacks mp3/ogg codecs; this verifies the visual pipeline only. Real target platforms (Windows/macOS) ship codecs.
- UI coordinates assume the window pinned at `0,0` size `1024x600` with no window manager (the script pins this). Override the display with `PRTS_TEST_DISPLAY=:N`.
