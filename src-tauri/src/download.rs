//! Managed bulk-download engine.
//!
//! Replaces the old synchronous `batch_download_assets` loop (one URL at a time,
//! no control, only a final count) with a job model that supports:
//!   - bounded concurrency (a pool of N worker tasks per job),
//!   - pause / resume (workers stop pulling new items; in-flight ones finish),
//!   - cancel,
//!   - per-file progress via throttled `download://progress` Tauri events,
//!   - global bandwidth limiting (streamed reads metered through [`crate::net::limiter`]).
//!
//! A [`Manager`] lives in Tauri managed state; the frontend drives it through the
//! `download_*` commands at the bottom of this file.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager as _};

/// Default number of concurrent workers per job. Balances throughput against
/// being polite to the CDN. Configurable at runtime (D2 in the design spec).
const DEFAULT_CONCURRENCY: usize = 4;
/// Minimum gap between progress events for one job, to avoid event storms.
const PROGRESS_THROTTLE_MS: u128 = 150;
/// Name of the progress event the frontend listens for.
pub const PROGRESS_EVENT: &str = "download://progress";

/// Where progress snapshots go. Abstracting this keeps `Manager`/the worker engine
/// independent of Tauri's `AppHandle`, so they're testable in a plain async test.
pub trait ProgressSink: Send + Sync {
    fn emit(&self, snap: &Snapshot);
}

/// Production sink: forward each snapshot as a `download://progress` Tauri event.
struct AppHandleSink(AppHandle);
impl ProgressSink for AppHandleSink {
    fn emit(&self, snap: &Snapshot) {
        let _ = self.0.emit(PROGRESS_EVENT, snap);
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

/// Live counters + control flags for one job. Shared (`Arc`) between the worker
/// tasks and the command handlers; all fields are atomic so neither side blocks
/// the other. Never held across the jobs-map lock.
struct Job {
    id: u64,
    total: u32,
    done: AtomicU32,
    success: AtomicU32,
    failed: AtomicU32,
    skipped: AtomicU32,
    bytes: AtomicU64,
    status: std::sync::atomic::AtomicU8,
    paused: AtomicBool,
    cancelled: AtomicBool,
    active_workers: AtomicUsize,
    next_index: AtomicUsize,
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
    fn new(id: u64, total: u32) -> Self {
        let now = Instant::now();
        Job {
            id,
            total,
            done: AtomicU32::new(0),
            success: AtomicU32::new(0),
            failed: AtomicU32::new(0),
            skipped: AtomicU32::new(0),
            bytes: AtomicU64::new(0),
            status: std::sync::atomic::AtomicU8::new(Status::Running.to_u8()),
            paused: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            active_workers: AtomicUsize::new(0),
            next_index: AtomicUsize::new(0),
            speed: Mutex::new(Speed {
                last_at: now,
                last_bytes: 0,
                last_emit_at: now,
                bps: 0,
            }),
        }
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
            total: self.total,
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

    /// Start a job for `urls` and return its id. Spawns the worker pool and
    /// returns immediately; progress arrives via `download://progress` events.
    pub fn start(&self, urls: Vec<String>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let total = urls.len() as u32;
        let job = Arc::new(Job::new(id, total));
        self.jobs.lock().unwrap().insert(id, job.clone());

        let urls = Arc::new(urls);
        // One worker per URL up to the concurrency cap; none for an empty job.
        let workers = if total == 0 {
            0
        } else {
            self.concurrency.load(Ordering::Relaxed).clamp(1, total as usize)
        };
        job.active_workers.store(workers, Ordering::Relaxed);

        let root = crate::media::media_root(&crate::data_root::data_root());
        let root = Arc::new(root);

        for _ in 0..workers {
            let job = job.clone();
            let urls = urls.clone();
            let root = root.clone();
            let sink = self.sink.clone();
            tauri::async_runtime::spawn(worker(job, urls, root, sink));
        }
        // Edge case: empty job — no workers, finalize immediately.
        if total == 0 {
            job.set_status(Status::Completed);
            self.sink.emit(&job.snapshot());
        }
        id
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
            // A paused worker polls these flags and will observe the cancel.
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

/// One worker: pull indices, honor pause/cancel, fetch+store, update counters.
async fn worker(
    job: Arc<Job>,
    urls: Arc<Vec<String>>,
    root: Arc<std::path::PathBuf>,
    sink: Arc<dyn ProgressSink>,
) {
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

        let i = job.next_index.fetch_add(1, Ordering::Relaxed);
        if i >= urls.len() {
            break;
        }
        let url = &urls[i];

        // Already in the content-addressed store, or unmappable URL.
        match crate::media::store_path(&root, url) {
            Some(p) if p.exists() => {
                job.skipped.fetch_add(1, Ordering::Relaxed);
                finish_item(&job, &*sink);
                continue;
            }
            None => {
                job.failed.fetch_add(1, Ordering::Relaxed);
                finish_item(&job, &*sink);
                continue;
            }
            _ => {}
        }

        match fetch_to_store(client, url, &root, &job).await {
            Ok(()) => {
                job.success.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
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

/// Stream a URL into the media store, metering bytes through the global limiter.
async fn fetch_to_store(
    client: &reqwest::Client,
    url: &str,
    root: &std::path::Path,
    job: &Job,
) -> Result<(), String> {
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
        // Bandwidth limit: consume quota before accepting the chunk.
        crate::net::limiter().acquire(chunk.len() as u64).await;
        job.bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        buf.extend_from_slice(&chunk);
        // Abort mid-file on cancel so big files don't hold the job open.
        if job.cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
    }
    crate::media::write_local(root, url, &buf)
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
    Ok(state.start(urls))
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

/// Convenience: register the manager in Tauri state (called from setup()).
pub fn init(app: &AppHandle) {
    app.manage(Manager::new(Arc::new(AppHandleSink(app.clone()))));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_u8_roundtrips() {
        for s in [Status::Running, Status::Paused, Status::Completed, Status::Cancelled] {
            assert_eq!(Status::from_u8(s.to_u8()), s);
        }
    }

    #[test]
    fn job_snapshot_reflects_counters_and_flags() {
        let job = Job::new(7, 10);
        let snap = job.snapshot();
        assert_eq!(snap.id, 7);
        assert_eq!(snap.total, 10);
        assert_eq!(snap.status, Status::Running);
        assert_eq!(snap.done, 0);

        job.success.fetch_add(2, Ordering::Relaxed);
        job.skipped.fetch_add(1, Ordering::Relaxed);
        job.done.fetch_add(3, Ordering::Relaxed);
        job.bytes.fetch_add(4096, Ordering::Relaxed);
        let snap = job.snapshot();
        assert_eq!(snap.success, 2);
        assert_eq!(snap.skipped, 1);
        assert_eq!(snap.done, 3);
        assert_eq!(snap.bytes, 4096);
    }

    #[test]
    fn pause_cancel_flags_drive_status() {
        let job = Job::new(1, 5);
        assert_eq!(job.status(), Status::Running);
        job.paused.store(true, Ordering::Relaxed);
        job.set_status(Status::Paused);
        assert_eq!(job.snapshot().status, Status::Paused);
        job.cancelled.store(true, Ordering::Relaxed);
        job.set_status(Status::Cancelled);
        assert_eq!(job.snapshot().status, Status::Cancelled);
    }

    // --- Integration tests for the live worker engine (no network) ---------
    // data_root() falls back to std::env::temp_dir() in tests (init is never
    // called), so the media store lives under temp_dir()/media. We use URLs
    // unique to this process so parallel tests don't collide.

    struct NoopSink;
    impl ProgressSink for NoopSink {
        fn emit(&self, _: &Snapshot) {}
    }

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
    async fn empty_job_finalizes_immediately() {
        let m = Manager::new(Arc::new(NoopSink));
        let id = m.start(vec![]);
        let s = m.status(id).unwrap();
        assert_eq!(s.status, Status::Completed);
        assert_eq!(s.total, 0);
    }

    #[tokio::test]
    async fn job_completes_skipping_already_cached_files() {
        let urls: Vec<String> = (0..5).map(|i| unique_url("skip", i)).collect();
        for u in &urls {
            precreate(u);
        }
        let m = Manager::new(Arc::new(NoopSink));
        let id = m.start(urls);
        let s = wait_terminal(&m, id).await;
        assert_eq!(s.status, Status::Completed);
        assert_eq!(s.total, 5);
        assert_eq!(s.skipped, 5, "all pre-cached files should be skipped");
        assert_eq!(s.success, 0);
        assert_eq!(s.failed, 0);
        assert_eq!(s.done, 5);
    }

    #[tokio::test]
    async fn unmappable_urls_count_as_failed_without_network() {
        // "https://x" has only one path segment → store_path None → failed,
        // exercised without any network access.
        let m = Manager::new(Arc::new(NoopSink));
        let id = m.start(vec!["https://x".into(), "not a url".into()]);
        let s = wait_terminal(&m, id).await;
        assert_eq!(s.status, Status::Completed);
        assert_eq!(s.failed, 2);
        assert_eq!(s.done, 2);
    }

    #[tokio::test]
    async fn cancelled_before_start_finishes_cancelled() {
        // Pre-create many files so there is work; cancel immediately. The job
        // ends Cancelled (or Completed if it raced to done first) — never stuck.
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
