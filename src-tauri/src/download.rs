//! Managed, streaming bulk-download engine.
//!
//! Pipelined: URLs can be appended to a *live* job ([`Manager::add`]) while its
//! workers are already downloading, and the producer calls [`Manager::close`]
//! when no more will arrive. This lets the (frontend, engine-driven) manifest
//! phase and the (Rust) download phase run concurrently — each captured story's
//! assets start downloading immediately instead of waiting for every manifest.
//!
//! Each job runs a pool of N worker tasks (configurable concurrency) that:
//!   - honor pause/resume (stop pulling new items; in-flight requests finish) and
//!     cancel (abort mid-file),
//!   - stream bodies through the global net::limiter token bucket (bandwidth cap),
//!   - skip already-stored / duplicate URLs (cross-story dedup), and
//!   - emit throttled `download://progress` events with live counts + bytes/sec.
//!
//! A [`Manager`] lives in Tauri managed state; the frontend drives it through the
//! `download_*` commands at the bottom of this file.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager as _};

/// Default number of concurrent workers per job (jsd default). Configurable at
/// runtime (D2).
const DEFAULT_CONCURRENCY: usize = 8;
/// Minimum gap between progress events for one job, to avoid event storms.
const PROGRESS_THROTTLE_MS: u128 = 150;
/// How long a worker waits when the queue is momentarily empty but the producer
/// (manifest phase) hasn't closed the job yet.
const IDLE_POLL_MS: u64 = 50;
/// Name of the progress event the frontend listens for.
pub const PROGRESS_EVENT: &str = "download://progress";

/// Where progress snapshots go. Abstracting this keeps `Manager`/the worker engine
/// independent of Tauri's `AppHandle`, so they're testable in a plain async test.
pub trait ProgressSink: Send + Sync {
    fn emit(&self, snap: &Snapshot);
}

/// Production sink: forward each snapshot as a `download://progress` Tauri event,
/// AND drive the Android keep-alive notification straight from here. The latter is
/// what lets download progress keep advancing (and the FGS stay refreshed) even
/// when the WebView renderer is frozen in the background — the previous design
/// routed progress through the WebView, which aggressive ROMs (ColorOS, MIUI…)
/// freeze, making the download look stopped.
struct AppHandleSink(AppHandle);
impl ProgressSink for AppHandleSink {
    fn emit(&self, snap: &Snapshot) {
        let _ = self.0.emit(PROGRESS_EVENT, snap);
        // A running/paused job keeps the service alive; a terminal one releases it
        // (back to "reading" or idle, decided in android_service).
        let active = matches!(snap.status, Status::Running | Status::Paused);
        crate::android_service::set_download(active, snap.done, snap.total);
    }
}

/// Lifecycle of a download job. Encoded as `u8` for atomic storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Paused,
    Completed,
    Cancelled,
}

impl Status {
    fn to_u8(self) -> u8 {
        match self {
            Status::Running => 0,
            Status::Paused => 1,
            Status::Completed => 2,
            Status::Cancelled => 3,
        }
    }
    fn from_u8(v: u8) -> Status {
        match v {
            1 => Status::Paused,
            2 => Status::Completed,
            3 => Status::Cancelled,
            _ => Status::Running,
        }
    }
}

/// Live state for one streaming job. Shared (`Arc`) between worker tasks, the
/// producer (add/close), and the command handlers; atomics + short-held mutexes
/// so no side blocks the others. Never held across the jobs-map lock.
struct Job {
    id: u64,
    /// Total URLs enqueued so far — grows while the manifest phase feeds the job.
    total: AtomicU32,
    done: AtomicU32,
    success: AtomicU32,
    failed: AtomicU32,
    skipped: AtomicU32,
    bytes: AtomicU64,
    status: std::sync::atomic::AtomicU8,
    paused: AtomicBool,
    cancelled: AtomicBool,
    /// Set when no more URLs will be added; workers exit once the queue drains.
    closed: AtomicBool,
    active_workers: AtomicUsize,
    pending: Mutex<VecDeque<String>>,
    /// Canonical keys ever enqueued, for cross-story dedup as manifests stream in.
    /// Keying off the canonical key (not the raw URL) collapses http/https/case
    /// variants of the same asset to a single download.
    seen: Mutex<HashSet<String>>,
    speed: Mutex<Speed>,
}

/// Sliding sample for instantaneous bytes/sec (delta since the last emit).
struct Speed {
    last_at: Instant,
    last_bytes: u64,
    last_emit_at: Instant,
    bps: u64,
}

/// Serializable snapshot sent to the frontend (event payload + command result).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: u64,
    pub status: Status,
    pub total: u32,
    pub done: u32,
    pub success: u32,
    pub failed: u32,
    pub skipped: u32,
    pub bytes: u64,
    pub bytes_per_sec: u64,
}

impl Job {
    fn new(id: u64) -> Self {
        let now = Instant::now();
        Job {
            id,
            total: AtomicU32::new(0),
            done: AtomicU32::new(0),
            success: AtomicU32::new(0),
            failed: AtomicU32::new(0),
            skipped: AtomicU32::new(0),
            bytes: AtomicU64::new(0),
            status: std::sync::atomic::AtomicU8::new(Status::Running.to_u8()),
            paused: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            active_workers: AtomicUsize::new(0),
            pending: Mutex::new(VecDeque::new()),
            seen: Mutex::new(HashSet::new()),
            speed: Mutex::new(Speed {
                last_at: now,
                last_bytes: 0,
                last_emit_at: now,
                bps: 0,
            }),
        }
    }

    /// Enqueue new (unseen) URLs; returns how many were actually added.
    fn enqueue(&self, urls: Vec<String>) -> u32 {
        let mut pending = self.pending.lock().unwrap();
        let mut seen = self.seen.lock().unwrap();
        let mut added = 0u32;
        for u in urls {
            // Dedup by canonical key so http/https/case-variant duplicates of the
            // same asset collapse to one download; unmappable strings (canonical
            // None) fall back to the raw string as their own dedup identity.
            let key = crate::media::canonical_key(&u).unwrap_or_else(|| u.clone());
            if seen.insert(key) {
                pending.push_back(u);
                added += 1;
            }
        }
        self.total.fetch_add(added, Ordering::Relaxed);
        added
    }

    fn pop(&self) -> Option<String> {
        self.pending.lock().unwrap().pop_front()
    }

    fn status(&self) -> Status {
        Status::from_u8(self.status.load(Ordering::Relaxed))
    }
    fn set_status(&self, s: Status) {
        self.status.store(s.to_u8(), Ordering::Relaxed);
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            id: self.id,
            status: self.status(),
            total: self.total.load(Ordering::Relaxed),
            done: self.done.load(Ordering::Relaxed),
            success: self.success.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            skipped: self.skipped.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            bytes_per_sec: self.speed.lock().unwrap().bps,
        }
    }
}

/// Owns all jobs and the configurable concurrency. Held in Tauri managed state.
pub struct Manager {
    sink: Arc<dyn ProgressSink>,
    jobs: Mutex<HashMap<u64, Arc<Job>>>,
    next_id: AtomicU64,
    concurrency: AtomicUsize,
}

impl Manager {
    pub fn new(sink: Arc<dyn ProgressSink>) -> Self {
        Manager {
            sink,
            jobs: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            concurrency: AtomicUsize::new(DEFAULT_CONCURRENCY),
        }
    }

    fn get(&self, id: u64) -> Option<Arc<Job>> {
        self.jobs.lock().unwrap().get(&id).cloned()
    }

    /// Open a streaming job, seeded with `initial` URLs, and spawn its worker
    /// pool. The job stays open (workers wait for more) until [`Self::close`].
    pub fn start(&self, initial: Vec<String>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let job = Arc::new(Job::new(id));
        job.enqueue(initial);
        self.jobs.lock().unwrap().insert(id, job.clone());

        // prts is hard-capped at its fixed concurrency; jsd uses the configurable
        // worker count (driven by the download_settings commands).
        let workers = if crate::source::current().kind == crate::source::SourceKind::Prts {
            crate::source::PRTS_MAX_CONCURRENCY
        } else {
            self.concurrency.load(Ordering::Relaxed).max(1)
        };
        job.active_workers.store(workers, Ordering::Relaxed);

        let root = Arc::new(crate::media::media_root(&crate::data_root::data_root()));
        for _ in 0..workers {
            let job = job.clone();
            let root = root.clone();
            let sink = self.sink.clone();
            tauri::async_runtime::spawn(worker(job, root, sink));
        }
        id
    }

    /// Append URLs to a live job (pipelined from the manifest phase).
    pub fn add(&self, id: u64, urls: Vec<String>) {
        if let Some(job) = self.get(id) {
            if job.enqueue(urls) > 0 {
                self.sink.emit(&job.snapshot());
            }
        }
    }

    /// Signal that no more URLs will be added; workers finish the queue and exit.
    pub fn close(&self, id: u64) {
        if let Some(job) = self.get(id) {
            job.closed.store(true, Ordering::Relaxed);
        }
    }

    pub fn pause(&self, id: u64) {
        if let Some(job) = self.get(id) {
            if job.status() == Status::Running {
                job.paused.store(true, Ordering::Relaxed);
                job.set_status(Status::Paused);
                self.sink.emit(&job.snapshot());
            }
        }
    }

    pub fn resume(&self, id: u64) {
        if let Some(job) = self.get(id) {
            if job.status() == Status::Paused {
                job.paused.store(false, Ordering::Relaxed);
                job.set_status(Status::Running);
                self.sink.emit(&job.snapshot());
            }
        }
    }

    pub fn cancel(&self, id: u64) {
        if let Some(job) = self.get(id) {
            job.cancelled.store(true, Ordering::Relaxed);
            job.paused.store(false, Ordering::Relaxed);
        }
    }

    pub fn status(&self, id: u64) -> Option<Snapshot> {
        self.get(id).map(|j| j.snapshot())
    }

    pub fn concurrency(&self) -> usize {
        self.concurrency.load(Ordering::Relaxed)
    }
    pub fn set_concurrency(&self, n: usize) {
        self.concurrency.store(n.clamp(1, 32), Ordering::Relaxed);
    }
}

/// One worker: pull URLs (waiting while the producer streams more), honor
/// pause/cancel/offline, fetch+store, update counters.
async fn worker(job: Arc<Job>, root: Arc<std::path::PathBuf>, sink: Arc<dyn ProgressSink>) {
    let client = crate::net::client();
    loop {
        if job.cancelled.load(Ordering::Relaxed) {
            break;
        }
        // Pause gate: poll until resumed or cancelled (~100ms latency, no spin).
        while job.paused.load(Ordering::Relaxed) && !job.cancelled.load(Ordering::Relaxed) {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        if job.cancelled.load(Ordering::Relaxed) {
            break;
        }
        // Offline toggled mid-job: stop pulling new items (cached reads only).
        if !crate::net::allow_online() {
            job.cancelled.store(true, Ordering::Relaxed);
            break;
        }

        let url = match job.pop() {
            Some(u) => u,
            None => {
                // Queue empty: exit if the producer is done, else wait for more.
                if job.closed.load(Ordering::Relaxed) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(IDLE_POLL_MS)).await;
                continue;
            }
        };

        // Normalize to the canonical key. Unmappable strings (data:/blob:/relative
        // paths the engine emits while enumerating a manifest) are not real assets
        // and NOT failures — count them as skipped so they never show up as a
        // phantom "1 failed".
        let key = match crate::media::canonical_key(&url) {
            Some(k) => k,
            None => {
                job.skipped.fetch_add(1, Ordering::Relaxed);
                finish_item(&job, &*sink);
                continue;
            }
        };

        // Already in the content-addressed store (store_path on the canonical key
        // is idempotent, so it matches whether the input was a URL or a bare key).
        if let Some(p) = crate::media::store_path(&root, &key) {
            if p.exists() {
                job.skipped.fetch_add(1, Ordering::Relaxed);
                finish_item(&job, &*sink);
                continue;
            }
        }

        match fetch_item(client, &key, &root, &job).await {
            Ok(()) => {
                job.success.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
                // Exhausted retries (or a permanent 4xx). Tracked internally for
                // diagnostics but never surfaced — auto-retry already gave it
                // several attempts, so we don't alarm the user with a failure count.
                job.failed.fetch_add(1, Ordering::Relaxed);
            }
        }
        finish_item(&job, &*sink);
    }

    // Last worker out finalizes the job.
    if job.active_workers.fetch_sub(1, Ordering::Relaxed) == 1 {
        let final_status = if job.cancelled.load(Ordering::Relaxed) {
            Status::Cancelled
        } else {
            Status::Completed
        };
        job.set_status(final_status);
        sink.emit(&job.snapshot());
    }
}

/// Source-aware fetch of one canonical key into the store. Under jsd we try the
/// jsd mirror first; on failure (and if not cancelled) we fall back PER FILE to
/// prts — which is throttled by the global prts gate + limiter. Under prts we go
/// straight to the (throttled) prts fetch.
async fn fetch_item(
    client: &reqwest::Client,
    key: &str,
    root: &std::path::Path,
    job: &Job,
) -> Result<(), String> {
    let cfg = crate::source::current();
    if cfg.kind == crate::source::SourceKind::Jsd {
        let url = crate::source::fetch_url(crate::source::SourceKind::Jsd, key, &cfg);
        if fetch_with_retry(client, &url, key, root, job, false).await.is_ok() {
            return Ok(());
        }
        if job.cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        // fall through to the per-file prts fallback (throttled).
    }
    let purl = crate::source::fetch_url(crate::source::SourceKind::Prts, key, &cfg);
    fetch_with_retry(client, &purl, key, root, job, true).await
}

/// Stream a URL into the media store under `key`, metering bytes through the global
/// limiter. When `is_prts`, additionally hold a prts concurrency permit across the
/// whole request and meter every chunk through the prts bandwidth limiter too.
async fn fetch_to_store(
    client: &reqwest::Client,
    url: &str,
    key: &str,
    root: &std::path::Path,
    job: &Job,
    is_prts: bool,
) -> Result<(), String> {
    // Hold a prts permit for the WHOLE request+body so concurrent prts fetches
    // never exceed the cap (kept alive until this scope ends).
    let _permit = if is_prts {
        Some(crate::source::prts_gate().acquire().await.unwrap())
    } else {
        None
    };

    let mut resp = client
        .get(url)
        .header("Referer", "https://prts.wiki/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        let len = chunk.len() as u64;
        // User's global bandwidth cap (always applies).
        crate::net::limiter().acquire(len).await;
        // prts-only: also meter through the fixed prts bandwidth limiter.
        if is_prts {
            crate::source::prts_limiter().acquire(len).await;
        }
        job.bytes.fetch_add(len, Ordering::Relaxed);
        buf.extend_from_slice(&chunk);
        // Abort mid-file on cancel so big files don't hold the job open.
        if job.cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
    }
    // Store under the canonical key, not the source-specific fetch URL.
    crate::media::write_local(root, key, &buf)
}

/// Max attempts per URL. Auto-retrying transient failures means a flaky network
/// (or a backgrounded device briefly losing connectivity) never surfaces as a
/// "failed download" — the worker keeps trying until the asset lands.
const MAX_ATTEMPTS: u32 = 6;

/// Fetch a URL into the store, retrying transient failures with capped
/// exponential backoff. Stops early on cancellation or a permanent error
/// (HTTP 4xx other than 429); network/timeout/5xx errors are retried.
async fn fetch_with_retry(
    client: &reqwest::Client,
    url: &str,
    key: &str,
    root: &std::path::Path,
    job: &Job,
    is_prts: bool,
) -> Result<(), String> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        if job.cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        match fetch_to_store(client, url, key, root, job, is_prts).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                if job.cancelled.load(Ordering::Relaxed)
                    || attempt >= MAX_ATTEMPTS
                    || is_permanent(&e)
                {
                    return Err(e);
                }
                // Backoff 200ms, 400, 800, … capped at 3s; wake early on cancel.
                let backoff_ms = (200u64.saturating_mul(1u64 << (attempt - 1))).min(3000);
                let mut waited = 0u64;
                while waited < backoff_ms && !job.cancelled.load(Ordering::Relaxed) {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    waited += 100;
                }
            }
        }
    }
}

/// A permanent failure not worth retrying: an HTTP 4xx response other than 429
/// (Too Many Requests is transient). Connection/timeout/5xx errors are retried.
fn is_permanent(err: &str) -> bool {
    err.starts_with("HTTP 4") && !err.starts_with("HTTP 429")
}

/// Bump the done counter and emit a throttled progress event.
fn finish_item(job: &Job, sink: &dyn ProgressSink) {
    job.done.fetch_add(1, Ordering::Relaxed);
    maybe_emit(job, sink);
}

/// Emit a progress event if enough time has elapsed since the last one, updating
/// the instantaneous speed sample. Always cheap; the throttle guards event spam.
fn maybe_emit(job: &Job, sink: &dyn ProgressSink) {
    let now = Instant::now();
    let mut emit_now = false;
    {
        let mut s = job.speed.lock().unwrap();
        if now.duration_since(s.last_emit_at).as_millis() >= PROGRESS_THROTTLE_MS {
            let dt = now.duration_since(s.last_at).as_secs_f64();
            let cur = job.bytes.load(Ordering::Relaxed);
            if dt > 0.0 {
                s.bps = (((cur.saturating_sub(s.last_bytes)) as f64) / dt) as u64;
            }
            s.last_at = now;
            s.last_bytes = cur;
            s.last_emit_at = now;
            emit_now = true;
        }
    }
    if emit_now {
        sink.emit(&job.snapshot());
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSettings {
    pub concurrency: usize,
    pub rate_limit_bps: u64,
}

#[tauri::command]
pub fn download_start(
    urls: Vec<String>,
    state: tauri::State<'_, Manager>,
) -> Result<u64, String> {
    // Offline gate: don't even start a bulk download when networking is off.
    crate::net::ensure_online()?;
    // Start the keep-alive foreground service NOW, from this (foreground) command —
    // Android 12+ forbids starting an FGS from the background, and the first engine
    // progress emit could land after the user has already backgrounded the app.
    crate::android_service::set_download(true, 0, 0);
    Ok(state.start(urls))
}

#[tauri::command]
pub fn download_add(job_id: u64, urls: Vec<String>, state: tauri::State<'_, Manager>) {
    state.add(job_id, urls);
}

/// Feed already-cached story manifests into the live job ENTIRELY in Rust (read the
/// `manifest_<title>.json` files, stream their http(s) URLs to the worker pool) and
/// return the titles that have NO cached manifest yet. Those still need the WebView
/// engine to index them; everything fed here downloads without the WebView, so the
/// bulk of a (re)download keeps running in the background — where aggressive ROMs
/// (ColorOS/MIUI) freeze the WebView renderer the per-story indexing depends on.
#[tauri::command]
pub fn download_feed_cached(
    job_id: u64,
    titles: Vec<String>,
    state: tauri::State<'_, Manager>,
) -> Vec<String> {
    let mut uncached = Vec::new();
    for title in titles {
        let path = crate::commands::cache::manifest_cache_path(&title);
        match std::fs::read_to_string(&path) {
            Ok(s) => match serde_json::from_str::<Vec<String>>(&s) {
                Ok(urls) => {
                    let urls: Vec<String> = urls
                        .into_iter()
                        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
                        .collect();
                    state.add(job_id, urls);
                }
                Err(_) => uncached.push(title), // corrupt cache → re-index
            },
            Err(_) => uncached.push(title), // not cached yet
        }
    }
    uncached
}

#[tauri::command]
pub fn download_close(job_id: u64, state: tauri::State<'_, Manager>) {
    state.close(job_id);
}

#[tauri::command]
pub fn download_pause(job_id: u64, state: tauri::State<'_, Manager>) {
    state.pause(job_id);
}

#[tauri::command]
pub fn download_resume(job_id: u64, state: tauri::State<'_, Manager>) {
    state.resume(job_id);
}

#[tauri::command]
pub fn download_cancel(job_id: u64, state: tauri::State<'_, Manager>) {
    state.cancel(job_id);
}

#[tauri::command]
pub fn download_status(job_id: u64, state: tauri::State<'_, Manager>) -> Option<Snapshot> {
    state.status(job_id)
}

#[tauri::command]
pub fn download_settings_get(state: tauri::State<'_, Manager>) -> DownloadSettings {
    DownloadSettings {
        concurrency: state.concurrency(),
        rate_limit_bps: crate::net::limiter().rate(),
    }
}

#[tauri::command]
pub fn download_settings_set(
    concurrency: usize,
    rate_limit_bps: u64,
    state: tauri::State<'_, Manager>,
) {
    state.set_concurrency(concurrency);
    crate::net::limiter().set_rate(rate_limit_bps);
}

/// Frontend → Android keep-alive: report the "reading a story" (playback) state.
/// Download progress is driven natively by the engine (see `AppHandleSink`); this
/// only covers what the WebView alone knows. No-op off Android.
#[tauri::command]
pub fn keepalive_set_reading(reading: bool) {
    crate::android_service::set_reading(reading);
}

/// Frontend → Android keep-alive: report indexing (manifest) progress, the one
/// piece the native download engine can't see. Folded into the download
/// notification's text while `active`. No-op off Android.
#[tauri::command]
pub fn keepalive_set_manifest(done: u32, total: u32, active: bool) {
    crate::android_service::set_manifest(done, total, active);
}

/// Convenience: register the manager in Tauri state (called from setup()).
pub fn init(app: &AppHandle) {
    app.manage(Manager::new(Arc::new(AppHandleSink(app.clone()))));
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoopSink;
    impl ProgressSink for NoopSink {
        fn emit(&self, _: &Snapshot) {}
    }

    #[test]
    fn status_u8_roundtrips() {
        for s in [Status::Running, Status::Paused, Status::Completed, Status::Cancelled] {
            assert_eq!(Status::from_u8(s.to_u8()), s);
        }
    }

    #[test]
    fn enqueue_dedups_and_counts_total() {
        let job = Job::new(1);
        assert_eq!(job.enqueue(vec!["a".into(), "b".into(), "a".into()]), 2);
        assert_eq!(job.enqueue(vec!["b".into(), "c".into()]), 1); // b already seen
        assert_eq!(job.total.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn pause_cancel_flags_drive_status() {
        let job = Job::new(1);
        assert_eq!(job.status(), Status::Running);
        job.set_status(Status::Paused);
        assert_eq!(job.snapshot().status, Status::Paused);
        job.set_status(Status::Cancelled);
        assert_eq!(job.snapshot().status, Status::Cancelled);
    }

    // --- Integration tests for the live streaming engine (no network) -------
    // data_root() falls back to std::env::temp_dir() in tests (init is never
    // called), so the media store lives under temp_dir()/media. URLs are unique
    // per process so parallel tests don't collide.

    fn unique_url(tag: &str, i: usize) -> String {
        format!("https://t.invalid/{}/{}/f{}.png", std::process::id(), tag, i)
    }
    fn precreate(url: &str) {
        let root = crate::media::media_root(&crate::data_root::data_root());
        crate::media::write_local(&root, url, b"x").unwrap();
    }
    async fn wait_terminal(m: &Manager, id: u64) -> Snapshot {
        for _ in 0..200 {
            let s = m.status(id).expect("job exists");
            if matches!(s.status, Status::Completed | Status::Cancelled) {
                return s;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("job {id} did not reach a terminal state");
    }

    #[tokio::test]
    async fn empty_job_completes_after_close() {
        let m = Manager::new(Arc::new(NoopSink));
        let id = m.start(vec![]);
        m.close(id);
        let s = wait_terminal(&m, id).await;
        assert_eq!(s.status, Status::Completed);
        assert_eq!(s.total, 0);
    }

    #[tokio::test]
    async fn streamed_cached_urls_all_skip() {
        // Seed some, stream more after start, then close: all are pre-cached so
        // every one is skipped — exercises the live add() path while downloading.
        let seed: Vec<String> = (0..3).map(|i| unique_url("seed", i)).collect();
        let more: Vec<String> = (0..4).map(|i| unique_url("more", i)).collect();
        for u in seed.iter().chain(more.iter()) {
            precreate(u);
        }
        let m = Manager::new(Arc::new(NoopSink));
        let id = m.start(seed);
        m.add(id, more);
        m.close(id);
        let s = wait_terminal(&m, id).await;
        assert_eq!(s.status, Status::Completed);
        assert_eq!(s.total, 7);
        assert_eq!(s.skipped, 7);
        assert_eq!(s.done, 7);
    }

    #[tokio::test]
    async fn precached_canonical_keys_are_skipped() {
        // Items are enqueued as bare canonical keys while their store entries were
        // written via the `https://` URL form — exercises the canonical-key
        // store-path match across key vs URL form (no network needed).
        let pid = std::process::id();
        let keys: Vec<String> = (0..3)
            .map(|i| format!("media.prts.wiki/canon{pid}/{i}/f.png"))
            .collect();
        for k in &keys {
            // Precreate via the https URL form; canonical_key collapses both forms.
            let root = crate::media::media_root(&crate::data_root::data_root());
            crate::media::write_local(&root, &format!("https://{k}"), b"x").unwrap();
        }
        let m = Manager::new(Arc::new(NoopSink));
        let id = m.start(keys);
        m.close(id);
        let s = wait_terminal(&m, id).await;
        assert_eq!(s.status, Status::Completed);
        assert_eq!(s.total, 3);
        assert_eq!(s.skipped, 3);
        assert_eq!(s.done, 3);
    }

    #[tokio::test]
    async fn unmappable_urls_count_as_skipped_not_failed() {
        // data:/blob:/single-segment URLs the engine emits are unmappable; they
        // must NOT count as failures (that was the phantom "1 failed" bug).
        let m = Manager::new(Arc::new(NoopSink));
        let id = m.start(vec!["https://x".into(), "not a url".into()]);
        m.close(id);
        let s = wait_terminal(&m, id).await;
        assert_eq!(s.status, Status::Completed);
        assert_eq!(s.failed, 0);
        assert_eq!(s.skipped, 2);
        assert_eq!(s.done, 2);
    }

    #[test]
    fn is_permanent_only_for_4xx_except_429() {
        assert!(is_permanent("HTTP 404 Not Found"));
        assert!(is_permanent("HTTP 403 Forbidden"));
        assert!(!is_permanent("HTTP 429 Too Many Requests"));
        assert!(!is_permanent("HTTP 500 Internal Server Error"));
        assert!(!is_permanent("error sending request for url")); // network error
    }

    #[tokio::test]
    async fn cancel_finishes_cancelled_not_stuck() {
        let urls: Vec<String> = (0..200).map(|i| unique_url("cancel", i)).collect();
        for u in &urls {
            precreate(u);
        }
        let m = Manager::new(Arc::new(NoopSink));
        let id = m.start(urls);
        m.cancel(id);
        let s = wait_terminal(&m, id).await;
        assert!(matches!(s.status, Status::Cancelled | Status::Completed));
    }
}
