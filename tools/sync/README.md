# Arkstage sync tool (Phase 2)

A Node + Puppeteer tool that mirrors Arknights story assets from **prts.wiki** into a
static tree under `out/`, ready to be served via jsDelivr.

It runs the original PRTS *ScenarioSimulator* engine in headless Chrome to capture
each story's deduped asset manifest (the same way the desktop/Android app does for
offline download), then downloads those assets into a content-addressed tree.

## Requirements

- Node 18+ (uses global `fetch`, `AbortSignal.timeout`). Developed on Node 22.
- Google Chrome at `/usr/bin/google-chrome` (puppeteer-core launches it; no Chromium
  download). Override with the `CHROME` constant in `sync.js` if elsewhere.
- Network access to `prts.wiki` and its CDNs (`media.prts.wiki`, `static.prts.wiki`,
  `torappu.prts.wiki`).

```sh
cd tools/sync
npm install
```

## Usage

### Spike (default) — the fully working path

```sh
node sync.js --spike       # or just: node sync.js
```

Fetches the `剧情一览` index, picks 3 stories (`W2G/BEG` + two real scenarios), and
fully mirrors them: manifest capture → manifest files → media download.

### Explicit titles

```sh
node sync.js "W2G/BEG" "EP09/ENTRY"
```

Syncs exactly the given story page-titles (still builds `index.json` + `version.json`).

### Incremental (skeleton)

```sh
node sync.js --incremental 2026-06-01T00:00:00Z
```

Queries the MediaWiki `recentchanges` API (namespace 0) for pages changed since the
given ISO timestamp, intersects them with known story pages from the index, and lists
what it WOULD re-sync. The actual `runStories()` call is stubbed with a clear TODO —
uncomment it in `sync.js` to enable real re-syncing.

### Backfill (skeleton)

```sh
node sync.js --backfill --limit 50
```

Walks ALL index stories in order, bounded by `--limit N` (default 25), persisting a
cursor in `out/.cursor.json` so successive runs resume. The actual sync call is stubbed
(TODO) — uncomment `runStories()` in `sync.js` to enable.

## Output tree (`out/`)

```
out/
  index.json              structured 剧情一览 index { categories: [...] }
  version.json            { ref, generatedAt, counts: { stories, mediaFiles, manifests } }
  manifests/<title>.json  per-story JSON array of canonical keys
                          (title sanitized: / \ : * ? " < > | -> _)
  media/<key>             downloaded asset bytes, where <key> = {host}/{path}
```

## Throttle (protects prts.wiki — keep it!)

- **Page fetches** (`wiki.js`): ≤2 concurrent, min 300 ms spacing, 3 retries.
- **Media downloads** (`media.js`): ≤2 concurrent **AND** a global token bucket
  capping total throughput at **< 5 MB/s**. 3 retries with backoff.
- Every request sends a normal `User-Agent` and `Referer: https://prts.wiki/`.

The spike is intentionally slowish — that is correct and respectful to the wiki.

`SYNC_NOW` (env): overrides `version.json.generatedAt` (else `new Date().toISOString()`).

## Canonical-key contract

Manifests store **canonical keys** produced by `canonicalKey()` in `canonicalKey.js`,
a byte-for-byte JS port of `canonical_key` in `src-tauri/src/media.rs`. A key is
`{host}/{path}` with: scheme stripped; query/fragment dropped; host lowercased; each
segment percent-decoded once; anti-traversal (`.`/`..`/encoded separators collapsed);
require ≥2 segments and a dotted host; non-http(s) inputs → `null`.

This makes the Rust app and this tool agree on the content-addressed store key, so the
mirror tree is interchangeable with the app's `media/` store. `keyToPrtsUrl(key)`
reverses a key into the `https://` fetch URL (per-segment encoded).

## Modules

| file              | role |
|-------------------|------|
| `canonicalKey.js` | the canonical-key port (the dedup/store-key contract) |
| `wiki.js`         | throttled page fetch + cheerio ports of the Rust parsers (index, widget bundle, story script) |
| `engine.js`       | the linchpin: boots the engine in headless Chrome, hooks `createjs.LoadQueue.loadFile`, runs `fun_sys_preload()`, returns canonical keys |
| `media.js`        | `keyToPrtsUrl` + throttled `downloadKey` |
| `throttle.js`     | hand-written concurrency limiter + byte token bucket |
| `covers.js`       | `discoverCover()` stub (cover-art source TBD) |
| `sync.js`         | orchestrator / CLI |

## Environment knobs

| env          | default                  | meaning |
|--------------|--------------------------|---------|
| `SYNC_OUT`   | `./out`                  | mirror tree root. CI points this at the `arkstage-assets` checkout so files land at the repo root. |
| `SYNC_REF`   | `main`                   | value written into `version.json.ref`. CI overrides per-commit (see below). |
| `CHROME_PATH`| `/usr/bin/google-chrome` | headless Chrome binary. |
| `SYNC_NOW`   | now (ISO)                | pin `version.json.generatedAt` (used as the incremental cursor). |

## CI / Deploy (the `arkstage-assets` repo)

`workflows/*.yml` here are the **source of truth** for the two GitHub Actions that
populate and maintain the mirror; deploy them to `.github/workflows/` in
`djkcyl/arkstage-assets`:

- **`sync-incremental.yml`** — scheduled every 12h (+ manual). Reads `version.json`
  for the last-sync time, queries `recentchanges`, re-syncs only changed stories.
- **`sync-backfill.yml`** — manual dispatch with a `limit` input. Fills the mirror
  in bounded, resumable batches (cursor at `.cursor.json`). Run repeatedly to fill.

Both check out this tool sparsely from `djkcyl/prts-reader`, install Chrome, run the
sync with `SYNC_OUT=$GITHUB_WORKSPACE`, then commit and **pin `version.json.ref` to
the commit SHA** holding the new media (two commits: media, then a `version.json`
commit pointing back at it). The app fetches `version.json` `@latest` to learn the
pinned ref, then fetches everything else `@<ref>` for permanent CDN caching. A
`concurrency` group prevents overlapping runs.

## Modes (all implemented)

- **`--spike`** (default) — W2G/BEG + two index-derived stories, end-to-end.
- **`--incremental <ISO>`** — re-sync stories changed since `<ISO>` (idempotent).
- **`--backfill --limit N`** — bounded, cursor-resumable walk of the whole index.
- **explicit titles** — `node sync.js W2G/BEG EP09/ENTRY` syncs exactly those.

## Stubbed / future work

- **covers.js** — `discoverCover(activityName)` returns `null`; cover-art source is
  being researched separately (likely each chapter's first-story background art).
