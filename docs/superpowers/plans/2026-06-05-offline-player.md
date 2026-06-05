# PRTS Offline Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the prts.wiki ScenarioSimulator engine building and playing a story in the dev environment, then add true offline playback: pre-download a selected scope of assets on WiFi, store them content-addressed with dedup, and serve them offline-first through the `prts-cdn://` protocol with an opt-in online cache-through fallback.

**Architecture:** Three layers. (A) A global base layer (engine JS/CSS/font + the shared `datas_*` databases) fetched once and cached, never bundled into the binary. (B) A content-addressed media store at `$APPDATA/media/{host}/{path}` served by an offline-first `prts-cdn://` handler gated by a global "allow online" flag. (C) A pre-download flow that reuses the engine's own `fun_sys_preload()` (via a `queue.loadFile` hook) to enumerate a story's exact deduped asset URLs without playing it, then batch-downloads the union across a selected scope.

**Tech Stack:** Tauri 2 (Rust: `reqwest`, `scraper`, `tokio`, custom URI protocol), React 19 + TypeScript + Vite, the original prts.wiki engine (jQuery 3.7.1 + PreloadJS 1.0.1 + `krliov.toolbox.js`).

**Spec:** `docs/superpowers/specs/2026-06-05-offline-player-design.md`

---

## Conventions & Testing Notes

- **Rust tests:** add `#[cfg(test)] mod tests { ... }` in the same file; run with `cargo test --manifest-path src-tauri/Cargo.toml <name>`. Pure logic (URL→path mapping, sanitize, dedup) is unit-tested. Anything touching the network or `AppHandle` is verified manually.
- **Frontend:** no JS test runner is added (scope). Verify with `npx tsc -b` (type check) plus running the real app and observing behavior/screenshots.
- **Running the GUI headless:** a live X server exists (`DISPLAY=:1024`). To launch: `DISPLAY=:1024 npm run tauri:dev` (or wrap with `xvfb-run -a` if `:1024` is unavailable). Screenshot with `DISPLAY=:1024 import -window root /tmp/shot.png` (ImageMagick) or scrot; then Read the PNG to inspect.
- **Commit after every task.** Branch is `offline-player` (already created).

## File Structure (created / modified)

- `src-tauri/src/media.rs` — **new**. Content-addressed media store: URL→path mapping, read/write, the `prts-cdn://` fetch+persist helper. One responsibility: media bytes on disk.
- `src-tauri/src/net_state.rs` — **new**. Global "allow online" flag (shared state) + getter/setter commands.
- `src-tauri/src/lib.rs` — **modify**. `prts-cdn://` handler delegates to `media.rs`; register new state + commands.
- `src-tauri/src/commands/cache.rs` — **modify**. Fix the `stories/` subdir vs flat-file mismatch.
- `src-tauri/src/commands/assets.rs` — **modify**. Refactor `batch_download_assets` to take a URL list and write to the media store with dedup/skip/concurrency/Referer.
- `src/lib/engineBoot.ts` — **new**. Reusable engine boot logic extracted from `StoryPlayerPage`, with `mode: "play" | "manifest"`.
- `src/lib/proxy.ts` — **new**. CDN domain list + URL rewrite helpers (shared by player and manifest capture).
- `src/pages/StoryPlayerPage.tsx` — **modify**. Use `engineBoot` (`play` mode). No behavior change.
- `src/pages/SettingsPage.tsx` — **modify**. Add "更新全局数据" + "允许联网" toggle.
- `src/pages/StoryBrowserPage.tsx` — **modify**. Scope selection + "预下载" entry + progress.
- `src/lib/predownload.ts` — **new**. Orchestrates manifest capture loop + union dedup + `batch_download_assets`.

---

## Phase 0 — Bring-up & cache fix

### Task 0.1: Build the Tauri app

**Files:** none (build only)

- [ ] **Step 1: Build the Rust side**

Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -40`
Expected: compiles to `Finished`. If it fails, read the error, fix the offending file, re-run. Do not proceed until it builds. (First build compiles many crates; allow several minutes.)

- [ ] **Step 2: Type-check + build the frontend**

Run: `npx tsc -b && npm run build 2>&1 | tail -20`
Expected: `tsc` exits 0; Vite writes `dist/`.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "build: make src-tauri and frontend build cleanly" || echo "nothing to commit"
```

### Task 0.2: Launch and verify a story plays end-to-end

**Files:** none (manual verification)

- [ ] **Step 1: Launch the app against the live X server**

Run (background): `DISPLAY=:1024 npm run tauri:dev`
Expected: a window titled "PRTS 剧情阅读器" opens. If `:1024` fails, use `xvfb-run -a -s "-screen 0 1280x800x24" npm run tauri:dev`.

- [ ] **Step 2: Pre-cache the engine, then open a story**

In the running app: Settings → 「预缓存引擎」(needs network) → back → 浏览剧情 → open any story (e.g. the first one). Long-press the play area 1s to trigger preload (engine requires it).

- [ ] **Step 3: Screenshot and inspect**

Run: `DISPLAY=:1024 import -window root /tmp/prts_play.png` then Read `/tmp/prts_play.png`.
Expected: dialogue UI + a background image + (after preload) character art render. Confirm no blank/black screen.

- [ ] **Step 4: Verify audio decoding (Linux WebKitGTK)**

Observe whether BGM/voice plays. If silent, check devtools console (open via the app) for media errors. **Record the result** (works / mp3 unsupported / ogg unsupported) in the spec's §10 as a known limitation if broken — do not block on it.

- [ ] **Step 5: Commit a note**

```bash
git commit --allow-empty -m "test: verified engine plays a story in dev env (see /tmp/prts_play.png)"
```

### Task 0.3: Fix the cache "already cached" bug

**Problem:** `save_to_cache("stories/X")` sanitizes `/`→`_`, writing a flat `cache/stories_X.json`, but `list_cached_stories` scans a non-existent `cache/stories/` subdir, so it always returns empty. The browser's `isCached` and settings count are permanently wrong.

**Fix chosen:** keep keys flat (`stories_X`) everywhere and make listing scan the flat `stories_` prefix. This avoids creating subdirs and matches the frontend's existing `isCached` key (`stories_${title}`).

**Files:**
- Modify: `src-tauri/src/commands/cache.rs`
- Modify: `src/pages/StoryPlayerPage.tsx:131` (cache key) — align to flat key

- [ ] **Step 1: Write a failing Rust test for prefix-based listing**

Add to `src-tauri/src/commands/cache.rs` (bottom of file):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn lists_flat_story_files_by_prefix() {
        let tmp = std::env::temp_dir().join(format!("prts_cache_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("stories_W2G_BEG.json"), "{}").unwrap();
        fs::write(tmp.join("stories_W2G_END.json"), "{}").unwrap();
        fs::write(tmp.join("story-index.json"), "{}").unwrap();

        let mut got = list_story_keys(&tmp);
        got.sort();
        assert_eq!(got, vec!["stories_W2G_BEG".to_string(), "stories_W2G_END".to_string()]);
        let _ = fs::remove_dir_all(&tmp);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml lists_flat_story_files_by_prefix 2>&1 | tail -20`
Expected: FAIL — `list_story_keys` does not exist.

- [ ] **Step 3: Implement `list_story_keys` and rewire callers**

In `src-tauri/src/commands/cache.rs`, replace the body of `list_cached_stories_internal` and `list_cached_stories` to use a shared prefix scanner, and add it:

```rust
/// List cache keys for stored stories (flat files named `stories_*.json`).
fn list_story_keys(cache_dir: &std::path::Path) -> Vec<String> {
    let mut keys = Vec::new();
    if let Ok(entries) = std::fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("stories_") && name.ends_with(".json") {
                    keys.push(name.trim_end_matches(".json").to_string());
                }
            }
        }
    }
    keys
}
```

Then change `list_cached_stories` to `Ok(list_story_keys(&dir))` and `list_cached_stories_internal` to call `list_story_keys`. Delete the now-unused `stories_dir` logic. Update the `use` of `PathBuf` if needed (accept `&Path`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml lists_flat_story_files_by_prefix 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Align the player's cache key to the flat form**

In `src/pages/StoryPlayerPage.tsx`, change the cache key (currently `` `stories/${decodedTitle.replace(/\//g, "_")}` ``) to:

```ts
const cacheKey = `stories_${decodedTitle.replace(/\//g, "_")}`;
```

Run: `npx tsc -b` — Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/cache.rs src/pages/StoryPlayerPage.tsx
git commit -m "fix: cached-story listing now matches flat cache file naming"
```

---

## Phase 1 — Offline-first engine shell

### Task 1.1: Extract `proxy.ts` (URL rewrite helpers)

**Files:**
- Create: `src/lib/proxy.ts`
- Modify: `src/pages/StoryPlayerPage.tsx` (import from `proxy.ts`, delete the inline copies)

- [ ] **Step 1: Create `src/lib/proxy.ts`**

```ts
// Wiki CDN domains that must be proxied through the prts-cdn:// protocol.
export const WIKI_CDN_DOMAINS = [
  "static.prts.wiki",
  "media.prts.wiki",
  "torappu.prts.wiki",
];

// On Windows WebView2 the custom scheme is served at http://{scheme}.localhost.
export const PROXY_BASE = navigator.userAgent.includes("Windows")
  ? "http://prts-cdn.localhost"
  : "prts-cdn://localhost";

/** Rewrite a single CDN URL to the proxy protocol. */
export function proxyUrl(url: string): string {
  for (const domain of WIKI_CDN_DOMAINS) {
    if (url.startsWith(`https://${domain}/`)) {
      return `${PROXY_BASE}/${domain}/${url.substring(`https://${domain}/`.length)}`;
    }
    if (url.startsWith(`http://${domain}/`)) {
      return `${PROXY_BASE}/${domain}/${url.substring(`http://${domain}/`.length)}`;
    }
  }
  return url;
}

/** Rewrite ALL CDN URLs in a text block (HTML/CSS/JS) to proxy URLs. */
export function rewriteAllCdnUrls(text: string): string {
  for (const domain of WIKI_CDN_DOMAINS) {
    text = text.replaceAll(`https://${domain}/`, `${PROXY_BASE}/${domain}/`);
    text = text.replaceAll(`http://${domain}/`, `${PROXY_BASE}/${domain}/`);
  }
  return text;
}
```

- [ ] **Step 2: Replace inline copies in `StoryPlayerPage.tsx`**

Delete the local `WIKI_CDN_DOMAINS`, `PROXY_BASE`, `proxyUrl`, `rewriteAllCdnUrls` definitions (lines ~26–84) and add at top: `import { WIKI_CDN_DOMAINS, PROXY_BASE, proxyUrl, rewriteAllCdnUrls } from "../lib/proxy";`

- [ ] **Step 3: Type-check**

Run: `npx tsc -b` — Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/proxy.ts src/pages/StoryPlayerPage.tsx
git commit -m "refactor: extract CDN proxy helpers into src/lib/proxy.ts"
```

### Task 1.2: Extract `engineBoot.ts` (play mode), keep behavior identical

**Files:**
- Create: `src/lib/engineBoot.ts`
- Modify: `src/pages/StoryPlayerPage.tsx`

This is a mechanical extraction: move every helper currently below the component in `StoryPlayerPage.tsx` (`injectUrlRewriteShim`, `ensureFontCached`, `loadCssPatched`, `resolveAssetUrl`, `ensureScript`, `executeScript`, `setupMwShims`, `processRLQ`, `triggerWindowOnload`, `cleanupEngineTimers`, `cleanupGlobals`, `escapeHtml`, `EXTERNALS`, `loadedScripts`) plus the boot sequence (Steps 3–10 of the existing `useEffect`) into `engineBoot.ts`.

- [ ] **Step 1: Create `src/lib/engineBoot.ts` exporting `bootEngine`**

Define and export:

```ts
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { PROXY_BASE, WIKI_CDN_DOMAINS, proxyUrl, rewriteAllCdnUrls } from "./proxy";

export interface WidgetBundle {
  dom_html: string;
  data_blocks_html: string;
  engine_scripts: string[];
}

export interface BootOptions {
  container: HTMLElement;
  bundle: WidgetBundle;
  /** Raw scenario script (#datas_txt content) for this story. */
  script: string;
  /** Page title, written into #firstHeading (read by data.init()). */
  title: string;
  /** "play": rewrite CDN→proxy and run normally. "manifest": keep raw URLs, capture preload set. */
  mode: "play" | "manifest";
  /** AbortSignal-like flag; boot checks it between async steps. */
  isCancelled: () => boolean;
}

export interface BootResult {
  /** Elements appended to <head>/<body> so the caller can remove them on teardown. */
  addedElements: HTMLElement[];
  /** In "manifest" mode, the deduped original asset URLs captured from fun_sys_preload. */
  manifest?: string[];
}

export async function bootEngine(opts: BootOptions): Promise<BootResult> { /* see steps below */ }
```

Move the existing helper functions verbatim into this module (they already exist in `StoryPlayerPage.tsx`). The `bootEngine` body is the existing Steps 3–10 sequence, parameterized: when `mode === "play"`, apply `rewriteAllCdnUrls` to data blocks/dom/engine scripts exactly as today; the `manifest` branch is added in Task 3.1 (for now `bootEngine` only implements `"play"` and `manifest` returns `addedElements` with no `manifest` field).

- [ ] **Step 2: Rewrite `StoryPlayerPage.tsx` to call `bootEngine`**

The component keeps Steps 1–2 (load `widget-bundle-v2` + story script from cache or fetch) and then calls:

```ts
const { addedElements } = await bootEngine({
  container, bundle, script: storyData.script, title: decodedTitle,
  mode: "play", isCancelled: () => cancelled,
});
addedElements.forEach((el) => addedElementsRef.current.push(el));
```

Teardown (`return () => {...}`) stays in the component and removes `addedElements`, clears engine timers/globals (move `cleanupEngineTimers`/`cleanupGlobals` calls to import from `engineBoot`).

- [ ] **Step 3: Type-check**

Run: `npx tsc -b` — Expected: exits 0.

- [ ] **Step 4: Run the app and re-verify a story still plays**

Run (background): `DISPLAY=:1024 npm run tauri:dev`; open a cached story; screenshot `DISPLAY=:1024 import -window root /tmp/prts_refactor.png`; Read it.
Expected: identical playback to Task 0.2 (no regression).

- [ ] **Step 5: Commit**

```bash
git add src/lib/engineBoot.ts src/pages/StoryPlayerPage.tsx
git commit -m "refactor: extract reusable bootEngine() (play mode), no behavior change"
```

### Task 1.3: "更新全局数据" action + confirm offline-first deps

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

`precacheEngine` already downloads the engine externals and the widget bundle. Add an explicit refresh that re-fetches the bundle and overwrites the cache (for game updates), and confirm the player prefers cache.

- [ ] **Step 1: Add `updateGlobalData` handler in `SettingsPage.tsx`**

```ts
const updateGlobalData = async () => {
  setBusy(true);
  showMsg("正在更新全局数据...", 0);
  try {
    const bundle = await invoke("fetch_widget_bundle", { pageTitle: "W2G/BEG" });
    await invoke("save_to_cache", { key: "widget-bundle-v2", data: JSON.stringify(bundle) });
    showMsg("全局数据已更新");
    refreshCacheStatus();
  } catch (e) {
    showMsg(`错误: ${e}`, 5000);
  } finally {
    setBusy(false);
  }
};
```

Add a button in the 缓存管理 group: `<button className="btn-primary" onClick={updateGlobalData} disabled={busy}>更新全局数据</button>`.

- [ ] **Step 2: Type-check + manual check**

Run: `npx tsc -b` — Expected: 0. In-app: click 更新全局数据 → success message; cache size updates.

- [ ] **Step 3: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat: add '更新全局数据' to refresh the shared engine databases"
```

---

## Phase 2 — Media store + offline-first protocol + allow-online + batch

### Task 2.1: Content-addressed URL→path mapping (`media.rs`)

**Files:**
- Create: `src-tauri/src/media.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod media;`)

- [ ] **Step 1: Write failing tests for `url_to_relpath`**

Create `src-tauri/src/media.rs`:

```rust
use std::path::{Path, PathBuf};

/// Map an absolute CDN URL to a relative store path `{host}/{path}` (query dropped),
/// sanitized so it cannot escape the store root. Returns None for non-http(s) URLs.
pub fn url_to_relpath(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    if rest.is_empty() || rest.starts_with('/') { return None; }
    let mut out = PathBuf::new();
    for seg in rest.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." { continue; }
        out.push(seg);
    }
    if out.components().count() < 2 { return None; }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_media_url_to_host_path() {
        assert_eq!(
            url_to_relpath("https://media.prts.wiki/1/10/Avg_071_mini01.png").unwrap(),
            PathBuf::from("media.prts.wiki/1/10/Avg_071_mini01.png"));
    }
    #[test]
    fn drops_query_and_blocks_traversal() {
        assert_eq!(
            url_to_relpath("https://static.prts.wiki/a/../../etc/passwd?x=1").unwrap(),
            PathBuf::from("static.prts.wiki/a/etc/passwd"));
    }
    #[test]
    fn rejects_non_http() {
        assert!(url_to_relpath("ftp://x/y").is_none());
        assert!(url_to_relpath("prts-cdn://localhost/a").is_none());
    }
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/lib.rs`, add `mod media;` near the other `mod` declarations.

- [ ] **Step 3: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml media:: 2>&1 | tail -20`
Expected: 3 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/media.rs src-tauri/src/lib.rs
git commit -m "feat: media store URL->path mapping with traversal guard"
```

### Task 2.2: Media store read/write + fetch-and-persist helper

**Files:**
- Modify: `src-tauri/src/media.rs`

- [ ] **Step 1: Add store helpers (read/exists/write)**

Append to `media.rs`:

```rust
/// Absolute path inside the media store for a given URL, or None if URL is unmappable.
pub fn store_path(media_root: &Path, url: &str) -> Option<PathBuf> {
    url_to_relpath(url).map(|rel| media_root.join(rel))
}

/// Read bytes from the store if present.
pub fn read_local(media_root: &Path, url: &str) -> Option<Vec<u8>> {
    let p = store_path(media_root, url)?;
    std::fs::read(&p).ok()
}

/// Write bytes to the store, creating parent dirs.
pub fn write_local(media_root: &Path, url: &str, bytes: &[u8]) -> Result<(), String> {
    let p = store_path(media_root, url).ok_or_else(|| "unmappable url".to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, bytes).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Add a round-trip test**

Add inside the existing `mod tests`:

```rust
#[test]
fn write_then_read_roundtrip() {
    let root = std::env::temp_dir().join(format!("prts_media_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let url = "https://media.prts.wiki/a/ab/Test.png";
    write_local(&root, url, b"hello").unwrap();
    assert_eq!(read_local(&root, url).unwrap(), b"hello");
    let _ = std::fs::remove_dir_all(&root);
}
```

- [ ] **Step 3: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml media:: 2>&1 | tail -20`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/media.rs
git commit -m "feat: media store read/write helpers"
```

### Task 2.3: Allow-online shared state + commands (`net_state.rs`)

**Files:**
- Create: `src-tauri/src/net_state.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create `src-tauri/src/net_state.rs`**

```rust
use std::sync::atomic::{AtomicBool, Ordering};

/// Process-wide "allow online" flag. Default true (online-first works out of the box;
/// users on metered networks can turn it off). The prts-cdn:// handler reads this.
pub static ALLOW_ONLINE: AtomicBool = AtomicBool::new(true);

pub fn allow_online() -> bool { ALLOW_ONLINE.load(Ordering::Relaxed) }

#[tauri::command]
pub fn set_allow_online(value: bool) { ALLOW_ONLINE.store(value, Ordering::Relaxed); }

#[tauri::command]
pub fn get_allow_online() -> bool { allow_online() }
```

- [ ] **Step 2: Register module + commands**

In `src-tauri/src/lib.rs`: add `mod net_state;`; add to the `generate_handler!` list: `net_state::set_allow_online, net_state::get_allow_online`.

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: builds.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/net_state.rs src-tauri/src/lib.rs
git commit -m "feat: global allow-online flag with get/set commands"
```

### Task 2.4: Rewire `prts-cdn://` handler to offline-first

**Files:**
- Modify: `src-tauri/src/lib.rs`

The handler currently always fetches. Change to: map the request URL (`{host}/{path}`) to the media store; serve local bytes if present; else if `allow_online()` fetch via reqwest, **persist to the store**, and serve; else return 503 with a marker header.

- [ ] **Step 1: Compute the media root once**

In `run()`, before registering the protocol, the closure needs the app data dir. Capture it inside the async task via the `app` handle is not available in this closure signature; instead resolve the media root lazily using the same `$APPDATA` logic. Add a helper in `media.rs`:

```rust
/// Resolve `$APPDATA/<identifier>/media`. Mirrors tauri's app_data_dir for the protocol
/// handler, which runs without an AppHandle. `app_data` is passed from the handler.
pub fn media_root(app_data: &Path) -> PathBuf { app_data.join("media") }
```

In `lib.rs`, capture the app data dir at `setup()` time into a `static OnceLock<PathBuf>` and read it in the handler:

```rust
static APP_DATA_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
```

In `.setup(|app| { ... })`, set it: `let _ = APP_DATA_DIR.set(app.path().app_data_dir().expect("app data dir"));` (add `use tauri::Manager;`).

- [ ] **Step 2: Replace the handler body**

Inside the `register_asynchronous_uri_scheme_protocol("prts-cdn", ...)` closure, after computing `target_url` and `content_type`, replace the network-only `spawn` with:

```rust
let media_root = APP_DATA_DIR.get().map(|d| crate::media::media_root(d));

// 1) Serve from local store if present.
if let Some(root) = &media_root {
    if let Some(bytes) = crate::media::read_local(root, &target_url) {
        let r = tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", content_type)
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes).unwrap();
        responder.respond(r);
        return;
    }
}

// 2) Offline + not cached: refuse with a marker the frontend can detect.
if !crate::net_state::allow_online() {
    let r = tauri::http::Response::builder()
        .status(503)
        .header("Access-Control-Allow-Origin", "*")
        .header("X-PRTS-Offline", "1")
        .body(b"offline: asset not cached".to_vec()).unwrap();
    responder.respond(r);
    return;
}

// 3) Online: fetch, persist to store, serve. (existing reqwest logic, plus write-on-success)
let media_root = media_root.clone();
tauri::async_runtime::spawn(async move {
    let client = http_client();
    match client.get(&target_url).header("Referer", "https://prts.wiki/").send().await {
        Ok(resp) if resp.status().is_success() => {
            let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok())
                .unwrap_or(content_type).to_string();
            match resp.bytes().await {
                Ok(bytes) => {
                    if let Some(root) = &media_root { let _ = crate::media::write_local(root, &target_url, &bytes); }
                    let r = tauri::http::Response::builder().status(200)
                        .header("Content-Type", ct).header("Access-Control-Allow-Origin", "*")
                        .body(bytes.to_vec()).unwrap();
                    responder.respond(r);
                }
                Err(e) => respond_err(responder, 502, format!("Read error: {}", e)),
            }
        }
        Ok(resp) => { let s = resp.status().as_u16(); respond_err(responder, s, format!("Upstream returned {}", s)); }
        Err(e) => respond_err(responder, 502, format!("Fetch error: {}", e)),
    }
});
```

Add a small helper near `guess_content_type`:

```rust
fn respond_err(responder: tauri::UriSchemeResponder, status: u16, msg: String) {
    let r = tauri::http::Response::builder().status(status)
        .header("Access-Control-Allow-Origin", "*").body(msg.into_bytes()).unwrap();
    responder.respond(r);
}
```

(Adjust `UriSchemeResponder` path/type to match the version; if the type name differs, infer it from the closure's `responder` parameter.)

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -30`
Expected: builds.

- [ ] **Step 4: Manual verify cache-through + offline**

Run app (`DISPLAY=:1024 npm run tauri:dev`), open a story, preload it (assets fetched → now persisted under `$APPDATA/com.prts.reader/media/...`). Confirm files exist:
Run: `find ~/.local/share/com.prts.reader/media -type f 2>/dev/null | head`
Expected: several `media.prts.wiki/...png` etc. Then in Settings toggle 允许联网 OFF (added in Task 2.5), re-open the same story → still plays from disk.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/media.rs
git commit -m "feat: offline-first prts-cdn:// handler with cache-through persist"
```

### Task 2.5: "允许联网" toggle in Settings

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

- [ ] **Step 1: Add state + load + toggle**

```ts
const [allowOnline, setAllowOnline] = useState(true);
useEffect(() => { invoke<boolean>("get_allow_online").then(setAllowOnline).catch(() => {}); }, []);
const toggleAllowOnline = async () => {
  const next = !allowOnline;
  await invoke("set_allow_online", { value: next });
  setAllowOnline(next);
  showMsg(next ? "已允许联网（缺失资源将自动拉取并缓存）" : "已禁止联网（缺失资源将提示获取）");
};
```

Add a setting group with a button: `<button className="nav-btn" onClick={toggleAllowOnline}>{allowOnline ? "联网：开" : "联网：关"}</button>`.

- [ ] **Step 2: Type-check + commit**

Run: `npx tsc -b` — Expected: 0.

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat: settings toggle for allow-online network policy"
```

### Task 2.6: Refactor `batch_download_assets` to URL-list → media store

**Files:**
- Modify: `src-tauri/src/commands/assets.rs`
- Modify: `src-tauri/src/lib.rs` (signature unchanged in handler list; struct changes)

- [ ] **Step 1: Replace request/result structs and the command**

In `src-tauri/src/commands/assets.rs`, replace `batch_download_assets` + its structs with:

```rust
use crate::media;
use tauri::Manager;

#[derive(Debug, Clone, serde::Serialize)]
pub struct BatchDownloadResult { pub total: u32, pub success: u32, pub failed: u32, pub skipped: u32 }

/// Download a list of absolute CDN URLs into the content-addressed media store.
/// Already-present files are skipped (cross-story dedup). Sends Referer to avoid 403.
#[tauri::command]
pub async fn batch_download_assets(urls: Vec<String>, app: AppHandle) -> Result<BatchDownloadResult, String> {
    let root = media::media_root(&app.path().app_data_dir().map_err(|e| e.to_string())?);
    let client = reqwest::Client::new();
    let (mut success, mut failed, mut skipped) = (0u32, 0u32, 0u32);
    let total = urls.len() as u32;
    for url in urls {
        match media::store_path(&root, &url) {
            Some(p) if p.exists() => { skipped += 1; continue; }
            None => { failed += 1; continue; }
            _ => {}
        }
        match client.get(&url).header("Referer", "https://prts.wiki/").send().await {
            Ok(resp) if resp.status().is_success() => match resp.bytes().await {
                Ok(bytes) => match media::write_local(&root, &url, &bytes) {
                    Ok(()) => success += 1,
                    Err(_) => failed += 1,
                },
                Err(_) => failed += 1,
            },
            _ => failed += 1,
        }
    }
    Ok(BatchDownloadResult { total, success, failed, skipped })
}
```

(Keep `download_asset`, `get_asset_path`, `read_asset_text` as-is for the engine-externals flow.)

- [ ] **Step 2: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: builds. Fix any unused-import warnings.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/assets.rs
git commit -m "feat: batch_download_assets downloads URL list into media store with dedup"
```

### Task 2.7: Remove dead asset-database code

**Files:**
- Delete: `src-tauri/src/parser/asset_database.rs`
- Modify: `src-tauri/src/parser/mod.rs`, `src-tauri/src/commands/wiki.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/models.rs`

This code (custom-renderer remnant) is unused now that playback runs the original engine.

- [ ] **Step 1: Confirm no frontend reference**

Run: `grep -rn "fetch_asset_databases\|AssetDatabases" src/`
Expected: no matches in `src/` (frontend). If any exist, stop and reassess.

- [ ] **Step 2: Remove the command and parser**

- Delete `src-tauri/src/parser/asset_database.rs`.
- In `src-tauri/src/parser/mod.rs` remove `pub mod asset_database;` (and any re-export).
- In `src-tauri/src/commands/wiki.rs` delete `fetch_asset_databases` and its `use` of `asset_database` / `AssetDatabases`.
- In `src-tauri/src/lib.rs` remove `wiki::fetch_asset_databases` from `generate_handler!`.
- In `src-tauri/src/models.rs` remove `AssetDatabases` and `OverrideEntry` (only used by the deleted parser).
- Keep `DataBlocks` / `extract_data_blocks` only if still referenced; otherwise remove them too (check with grep).

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: builds with no unused-code warnings for the removed items.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: remove unused asset-database parser/command"
```

---

## Phase 3 — Single-story manifest capture

### Task 3.1: Add `manifest` mode to `bootEngine`

**Files:**
- Modify: `src/lib/engineBoot.ts`

In `manifest` mode: inject data blocks with **raw** (non-rewritten) URLs so captured assets are original `https://` URLs; before running engine scripts, install a hook that replaces `window.queue.loadFile`; after boot, call `window.fun_sys_preload()`; collect the captured URLs; never call `queue.load()`.

- [ ] **Step 1: Implement the capture branch**

In `bootEngine`, branch on `opts.mode`:

```ts
// data blocks: rewrite only in play mode; keep raw URLs in manifest mode so we capture originals
let dataBlocksHtml = bundle.data_blocks_html.replace(
  /<pre class="hidden" id="datas_txt">[\s\S]*?<\/pre>/,
  `<pre class="hidden" id="datas_txt">${escapeHtml(script)}</pre>`
);
const domHtml = opts.mode === "play" ? rewriteAllCdnUrls(bundle.dom_html) : bundle.dom_html;
if (opts.mode === "play") dataBlocksHtml = rewriteAllCdnUrls(dataBlocksHtml);
```

After the engine scripts execute and `processRLQ()` / `triggerWindowOnload()` run, add:

```ts
if (opts.mode === "manifest") {
  const w = window as any;
  const captured: string[] = [];
  if (w.queue && typeof w.queue.loadFile === "function") {
    w.queue.loadFile = (item: any) => {
      const url = typeof item === "string" ? item : item?.src ?? item?.path;
      if (typeof url === "string") captured.push(url);
    };
  }
  if (typeof w.fun_sys_preload === "function") {
    try { w.fun_sys_preload(); } catch (e) { console.warn("fun_sys_preload capture error:", e); }
  }
  return { addedElements, manifest: Array.from(new Set(captured)) };
}
```

For manifest mode the caller passes a hidden, detached container (e.g. an off-screen `<div>` appended to `document.body` with `style="position:fixed;left:-99999px;width:960px;height:540px"`). Skip the font/CSS network steps in manifest mode (not needed to build URLs) by guarding Step 5 with `if (opts.mode === "play")`.

- [ ] **Step 2: Type-check**

Run: `npx tsc -b` — Expected: 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/engineBoot.ts
git commit -m "feat: bootEngine manifest mode captures fun_sys_preload asset set"
```

### Task 3.2: `captureManifest` helper + "预下载本剧情资源" button

**Files:**
- Create: `src/lib/predownload.ts`
- Modify: `src/pages/StoryPlayerPage.tsx` (add a button)

- [ ] **Step 1: Implement `captureManifest` in `src/lib/predownload.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";
import { bootEngine, WidgetBundle } from "./engineBoot";

/** Load the engine for one story in a hidden container and return its deduped asset URLs. */
export async function captureManifest(bundle: WidgetBundle, script: string, title: string): Promise<string[]> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;width:960px;height:540px;";
  document.body.appendChild(host);
  let result: string[] = [];
  let added: HTMLElement[] = [];
  try {
    const r = await bootEngine({ container: host, bundle, script, title, mode: "manifest", isCancelled: () => false });
    result = r.manifest ?? [];
    added = r.addedElements;
  } finally {
    added.forEach((el) => el.remove());
    host.remove();
    const w = window as any;
    ["system","data","timer","scenario","queue","AnaRes","ResType","SetType","LogType","pos_multiply","public_disabled","RLQ","mw"]
      .forEach((g) => { try { delete w[g]; } catch {} });
  }
  return result;
}

/** Fetch+cache the story script if needed, returning its raw scenario text. */
export async function ensureScript(title: string): Promise<string> {
  const key = `stories_${title.replace(/\//g, "_")}`;
  const cached = await invoke<string | null>("load_from_cache", { key });
  if (cached) return (JSON.parse(cached) as { script: string }).script;
  const data = await invoke<{ script: string; title: string }>("fetch_story_page", { pageTitle: title });
  await invoke("save_to_cache", { key, data: JSON.stringify(data) }).catch(() => {});
  return data.script;
}

export async function loadBundle(): Promise<WidgetBundle> {
  const cached = await invoke<string | null>("load_from_cache", { key: "widget-bundle-v2" });
  if (cached) return JSON.parse(cached) as WidgetBundle;
  const b = await invoke<WidgetBundle>("fetch_widget_bundle", { pageTitle: "W2G/BEG" });
  await invoke("save_to_cache", { key: "widget-bundle-v2", data: JSON.stringify(b) }).catch(() => {});
  return b;
}
```

- [ ] **Step 2: Add a "预下载本剧情资源" button in `StoryPlayerPage.tsx`**

Near the 返回 button, add a button whose handler:

```ts
const predownloadThis = async () => {
  setStatus("正在解析资源清单...");
  const bundle = await loadBundle();
  const script = await ensureScript(decodedTitle);
  const urls = await captureManifest(bundle, script, decodedTitle);
  setStatus(`正在下载 ${urls.length} 个资源...`);
  const res = await invoke<{ total: number; success: number; failed: number; skipped: number }>(
    "batch_download_assets", { urls });
  setStatus(`完成：成功${res.success} 跳过${res.skipped} 失败${res.failed}`);
};
```

(Import `captureManifest, ensureScript, loadBundle` from `../lib/predownload`.)

- [ ] **Step 3: Type-check**

Run: `npx tsc -b` — Expected: 0.

- [ ] **Step 4: Manual verify the manifest is non-empty and downloads**

Run app; open a story; click 预下载本剧情资源.
Expected: status shows a plausible asset count (dozens) then 成功>0. Verify files landed: `find ~/.local/share/com.prts.reader/media -type f | wc -l` increased.

- [ ] **Step 5: Commit**

```bash
git add src/lib/predownload.ts src/pages/StoryPlayerPage.tsx
git commit -m "feat: per-story asset manifest capture + predownload button"
```

### Task 3.3: Verify single-story offline playback

**Files:** none (verification)

- [ ] **Step 1: Pre-download one story, then go offline**

In-app: predownload story X. Settings → 联网：关.

- [ ] **Step 2: Play it offline and screenshot**

Re-open story X, preload, `DISPLAY=:1024 import -window root /tmp/prts_offline.png`, Read it.
Expected: background + character art render with 联网 OFF (served from disk). If something is blank, note which host/path 503'd (devtools network) — that asset wasn't in the captured manifest; record as a gap to investigate.

- [ ] **Step 3: Commit a note**

```bash
git commit --allow-empty -m "test: single-story offline playback verified (allow-online off)"
```

---

## Phase 4 — Scope selection + bulk pre-download

### Task 4.1: Bulk orchestration in `predownload.ts`

**Files:**
- Modify: `src/lib/predownload.ts`

- [ ] **Step 1: Add `predownloadScope`**

```ts
export interface PreProgress { phase: "manifest" | "download"; done: number; total: number; label: string; }

/** Capture manifests for many stories, union+dedup, then batch download missing assets. */
export async function predownloadScope(
  titles: string[],
  onProgress: (p: PreProgress) => void
): Promise<{ assets: number; result: { total: number; success: number; failed: number; skipped: number } }> {
  const bundle = await loadBundle();
  const union = new Set<string>();
  for (let i = 0; i < titles.length; i++) {
    onProgress({ phase: "manifest", done: i, total: titles.length, label: titles[i] });
    try {
      const script = await ensureScript(titles[i]);
      const urls = await captureManifest(bundle, script, titles[i]);
      urls.forEach((u) => union.add(u));
    } catch (e) { console.warn("manifest failed for", titles[i], e); }
  }
  onProgress({ phase: "download", done: 0, total: union.size, label: "下载中" });
  const result = await invoke<{ total: number; success: number; failed: number; skipped: number }>(
    "batch_download_assets", { urls: Array.from(union) });
  return { assets: union.size, result };
}
```

- [ ] **Step 2: Type-check + commit**

Run: `npx tsc -b` — Expected: 0.

```bash
git add src/lib/predownload.ts
git commit -m "feat: predownloadScope unions deduped manifests across stories"
```

### Task 4.2: Scope selection UI + progress in the browser

**Files:**
- Modify: `src/pages/StoryBrowserPage.tsx`

- [ ] **Step 1: Add a "预下载本章" / "预下载本分类" control per group**

For each category header and each chapter, add a small button that collects the relevant `page_title`s and calls `predownloadScope`, wiring a progress state:

```ts
const [pre, setPre] = useState<PreProgress | null>(null);
const runPredownload = async (titles: string[]) => {
  setPre({ phase: "manifest", done: 0, total: titles.length, label: "" });
  const { assets, result } = await predownloadScope(titles, setPre);
  setPre(null);
  alert(`范围资源 ${assets} 个：成功${result.success} 跳过${result.skipped} 失败${result.failed}`);
};
```

Category button collects `cat.chapters.flatMap(ch => ch.stories.map(s => s.page_title))`; chapter button collects `ch.stories.map(s => s.page_title)`. Render a progress bar when `pre !== null` showing `${pre.phase} ${pre.done}/${pre.total} ${pre.label}`.

- [ ] **Step 2: Type-check**

Run: `npx tsc -b` — Expected: 0.

- [ ] **Step 3: Manual verify dedup across a chapter**

Run app; 预下载本章 on a chapter with shared art; observe progress; second run of the same chapter should report high 跳过 (dedup working).

- [ ] **Step 4: Commit**

```bash
git add src/pages/StoryBrowserPage.tsx
git commit -m "feat: scope (chapter/category) pre-download with progress"
```

---

## Phase 5 — Offline end-to-end verification

### Task 5.1: Scope offline playback verification

**Files:** none (verification)

- [ ] **Step 1: Pre-download a chapter on WiFi**

In-app: 预下载本章 for a chapter; wait for completion.

- [ ] **Step 2: Go offline and play multiple stories**

Settings → 联网：关. Open 2–3 different stories from that chapter; preload + screenshot each (`/tmp/prts_scope_1.png` …); Read them.
Expected: all render fully (image + character) with no network. Confirm via devtools that no out-of-process requests succeed (all served by `prts-cdn://` from disk).

- [ ] **Step 3: Negative check — uncached story offline shows prompt**

With 联网：关, open a story NOT pre-downloaded. Expected: missing assets 503 with `X-PRTS-Offline`; the player surfaces a hint to enable 联网 or pre-cache (wire a simple `onerror`/status message in `StoryPlayerPage` if not already visible).

- [ ] **Step 4: Final commit**

```bash
git commit --allow-empty -m "test: scope offline playback + offline-miss prompt verified"
```

---

## Self-Review Notes

- **Spec coverage:** Layer A base-fetch (Tasks 1.3, existing precache) ✓; offline-first protocol + allow-online (2.1–2.5) ✓; content-addressed dedup store (2.1, 2.2, 2.6) ✓; dead-code cleanup (2.7) ✓; engine-hook manifest (3.1, 3.2) ✓; scope pre-download (4.1, 4.2) ✓; cache bug (0.3) ✓; bring-up + audio check (0.1, 0.2) ✓; offline E2E (3.3, 5.1) ✓.
- **Type consistency:** `WidgetBundle`, `BatchDownloadResult { total, success, failed, skipped }`, `PreProgress`, and command names (`batch_download_assets(urls)`, `get_allow_online`, `set_allow_online`) are used identically across tasks.
- **Known adaptation:** GUI/engine tasks use run+screenshot verification rather than unit tests (no JS test runner by design); backend logic is unit-tested via `cargo test`.
