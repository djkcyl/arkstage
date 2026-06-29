//! Client-side image compression ("资源压缩").
//!
//! The deduplicated media store is ~94% images (mostly per-story-unique CG). Re-
//! encoding those PNG/JPEG images to WebP shrinks the cache dramatically with no
//! visible loss at the quality tier (full-corpus study: q90 ≈ −79%, SSIM ≥ 0.99).
//! This module:
//!   - runs a resumable *batch* over the existing store (`media/`), transcoding
//!     every image whose recorded tier is weaker than the chosen target,
//!   - transcodes *new* downloads on the fly ([`maybe_transcode_image`]) so the
//!     store stays compressed once a tier is enabled,
//!   - blocks new downloads while the batch runs (and vice-versa), and
//!   - persists enough state to resume after the app is killed.
//!
//! Files are replaced in place under their original content-addressed key (the
//! bytes become WebP but the path/extension stays), so dedup / per-chapter delete
//! / re-download skip-if-exists all keep working unchanged. The original PNG is
//! NOT kept; switching to a more aggressive tier re-encodes the existing WebP
//! (double-lossy, user-accepted).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Progress event name the frontend listens for (mirrors `download://progress`).
pub const PROGRESS_EVENT: &str = "compress://progress";
const PROGRESS_THROTTLE_MS: u128 = 150;
/// Persist the tier index at most this often while the batch churns.
const INDEX_PERSIST_THROTTLE_MS: u128 = 2000;

// ---------------------------------------------------------------------------
// Tier
// ---------------------------------------------------------------------------

/// Compression tier. Ordered by *aggressiveness* (`rank`): a file is (re)compressed
/// only when its current tier is strictly weaker than the target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// Real-time compression disabled (the persisted "off" mode). Never stored per-file.
    Off,
    Lossless,
    Q90,
    Q70,
}

impl Tier {
    /// Aggressiveness rank. `raw` (no entry) = 0; higher = smaller/more lossy.
    fn rank(self) -> u8 {
        match self {
            Tier::Off => 0,
            Tier::Lossless => 1,
            Tier::Q90 => 2,
            Tier::Q70 => 3,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Tier::Off => "off",
            Tier::Lossless => "lossless",
            Tier::Q90 => "q90",
            Tier::Q70 => "q70",
        }
    }
    fn from_str(s: &str) -> Tier {
        match s {
            "lossless" => Tier::Lossless,
            "q90" => Tier::Q90,
            "q70" => Tier::Q70,
            _ => Tier::Off,
        }
    }
    fn to_u8(self) -> u8 {
        self.rank()
    }
    fn from_u8(v: u8) -> Tier {
        match v {
            1 => Tier::Lossless,
            2 => Tier::Q90,
            3 => Tier::Q70,
            _ => Tier::Off,
        }
    }
    /// True for the real, file-applicable tiers (everything except Off).
    fn is_real(self) -> bool {
        self != Tier::Off
    }
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

/// Current real-time mode / last applied tier (drives [`maybe_transcode_image`]).
static TIER: AtomicU8 = AtomicU8::new(0); // Off
/// True while a batch is running — the bidirectional download/compress gate.
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// AppHandle for emitting progress + driving the keep-alive notification.
static APP: OnceLock<AppHandle> = OnceLock::new();
/// Per-file applied tier, keyed by store-relative path (`host/a/ab/Name.png`).
/// Absent = raw (never compressed). Source of truth for resume + re-tier.
static INDEX: OnceLock<Mutex<TierIndex>> = OnceLock::new();
/// The single live batch job (only one at a time).
static JOB: OnceLock<Mutex<Option<Arc<BatchJob>>>> = OnceLock::new();

fn index() -> &'static Mutex<TierIndex> {
    INDEX.get_or_init(|| Mutex::new(TierIndex::load()))
}
fn job_slot() -> &'static Mutex<Option<Arc<BatchJob>>> {
    JOB.get_or_init(|| Mutex::new(None))
}

pub fn current_tier() -> Tier {
    Tier::from_u8(TIER.load(Ordering::Relaxed))
}

/// Whether a batch is in progress (download gate).
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// Refuse an action (used by `download_start`) while a batch is running.
pub fn ensure_idle() -> Result<(), String> {
    if is_active() {
        Err("COMPRESS_ACTIVE: 正在进行记忆重组，请等待资源压缩完成后再下载".into())
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Persistence: config + tier index (atomic temp+rename, like data_root.rs)
// ---------------------------------------------------------------------------

fn config_path() -> PathBuf {
    crate::data_root::data_root().join("compress-config.json")
}
fn index_path() -> PathBuf {
    crate::data_root::data_root().join("compress-index.json")
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[derive(Serialize, serde::Deserialize, Default)]
struct PersistedConfig {
    tier: String,
    /// True between batch start and completion — drives startup resume.
    batch_pending: bool,
}

fn load_config() -> PersistedConfig {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
fn save_config(tier: Tier, batch_pending: bool) {
    let cfg = PersistedConfig { tier: tier.as_str().to_string(), batch_pending };
    if let Ok(s) = serde_json::to_string(&cfg) {
        let _ = atomic_write(&config_path(), s.as_bytes());
    }
}

/// In-memory tier index with debounced persistence.
struct TierIndex {
    map: HashMap<String, u8>,
    dirty: bool,
    last_persist: Instant,
}

impl TierIndex {
    fn load() -> Self {
        let map = std::fs::read_to_string(index_path())
            .ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, u8>>(&s).ok())
            .unwrap_or_default();
        TierIndex { map, dirty: false, last_persist: Instant::now() }
    }
    fn tier_of(&self, rel: &str) -> Tier {
        Tier::from_u8(self.map.get(rel).copied().unwrap_or(0))
    }
    fn set(&mut self, rel: &str, tier: Tier) {
        self.map.insert(rel.to_string(), tier.to_u8());
        self.dirty = true;
    }
    /// Persist if dirty and the throttle elapsed (or `force`).
    fn maybe_persist(&mut self, force: bool) {
        if !self.dirty {
            return;
        }
        if !force && self.last_persist.elapsed().as_millis() < INDEX_PERSIST_THROTTLE_MS {
            return;
        }
        if let Ok(s) = serde_json::to_string(&self.map) {
            if atomic_write(&index_path(), s.as_bytes()).is_ok() {
                self.dirty = false;
                self.last_persist = Instant::now();
            }
        }
    }
}

/// Record a file's applied tier and flush the index opportunistically.
fn record_tier(rel: &str, tier: Tier, force: bool) {
    let mut idx = index().lock().unwrap();
    idx.set(rel, tier);
    idx.maybe_persist(force);
}

// ---------------------------------------------------------------------------
// Image classification + transcoding
// ---------------------------------------------------------------------------

/// True if the canonical key / path names an image we transcode.
pub fn is_image(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".webp")
}

/// Decode any supported image (PNG/JPEG/WebP) and re-encode to WebP at `tier`.
/// Returns the smaller of {encoded, original} so a file never grows; `None` on a
/// decode/encode failure (caller keeps the original bytes).
fn transcode(bytes: &[u8], tier: Tier) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let encoder = webp::Encoder::from_rgba(rgba.as_raw(), w, h);
    let out = match tier {
        Tier::Lossless => encoder.encode_lossless(),
        Tier::Q90 => encoder.encode(90.0),
        Tier::Q70 => encoder.encode(70.0),
        Tier::Off => return None,
    };
    let out: &[u8] = &out;
    if out.len() < bytes.len() {
        Some(out.to_vec())
    } else {
        // Encoded is no smaller (rare, e.g. tiny solid PNGs) — keep original bytes
        // but still treat it as "at this tier" (caller records the tier).
        Some(bytes.to_vec())
    }
}

/// Real-time hook: when a tier is enabled and `key` is an image, return the
/// compressed bytes (and record the tier); otherwise return the input unchanged.
/// Called from the download write paths just before `media::write_local`.
pub fn maybe_transcode_image(key: &str, bytes: Vec<u8>) -> Vec<u8> {
    let tier = current_tier();
    if !tier.is_real() || !is_image(key) {
        return bytes;
    }
    let Some(rel) = crate::media::url_to_relpath(key).map(|p| rel_string(&p)) else {
        return bytes;
    };
    match transcode(&bytes, tier) {
        Some(out) => {
            record_tier(&rel, tier, false);
            out
        }
        None => bytes,
    }
}

/// Store-relative path as a `/`-joined string (the index key), matching the form
/// produced by `media::url_to_relpath` / a recursive walk of the media root.
fn rel_string(rel: &Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

// ---------------------------------------------------------------------------
// Batch job
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Paused,
    Completed,
    Cancelled,
}

struct BatchJob {
    target: Tier,
    total: AtomicU32,
    done: AtomicU32,
    failed: AtomicU32,
    freed_bytes: AtomicU64,
    status: AtomicU8, // 0 run,1 pause,2 done,3 cancel
    paused: AtomicBool,
    cancelled: AtomicBool,
    active_workers: AtomicUsize,
    queue: Mutex<VecDeque<(PathBuf, String)>>, // (abs path, rel key)
    last_emit: Mutex<Instant>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub status: Status,
    pub total: u32,
    pub done: u32,
    pub failed: u32,
    pub freed_bytes: u64,
    pub tier: String,
}

impl BatchJob {
    fn status(&self) -> Status {
        match self.status.load(Ordering::Relaxed) {
            1 => Status::Paused,
            2 => Status::Completed,
            3 => Status::Cancelled,
            _ => Status::Running,
        }
    }
    fn set_status(&self, s: Status) {
        let v = match s {
            Status::Running => 0,
            Status::Paused => 1,
            Status::Completed => 2,
            Status::Cancelled => 3,
        };
        self.status.store(v, Ordering::Relaxed);
    }
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            status: self.status(),
            total: self.total.load(Ordering::Relaxed),
            done: self.done.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            freed_bytes: self.freed_bytes.load(Ordering::Relaxed),
            tier: self.target.as_str().to_string(),
        }
    }
}

/// Emit a progress snapshot to the frontend + the Android keep-alive notification.
fn emit(job: &BatchJob, force: bool) {
    {
        let mut last = job.last_emit.lock().unwrap();
        if !force && last.elapsed().as_millis() < PROGRESS_THROTTLE_MS {
            return;
        }
        *last = Instant::now();
    }
    let snap = job.snapshot();
    if let Some(app) = APP.get() {
        let _ = app.emit(PROGRESS_EVENT, &snap);
    }
    let active = matches!(snap.status, Status::Running | Status::Paused);
    crate::android_service::set_compress(active, snap.done, snap.total);
}

/// Recursively collect image files under `media/` whose recorded tier is weaker
/// than `target` (so already-at-or-beyond-target files are skipped — this is what
/// makes the batch resumable and re-tier cheap).
fn collect_pending(media_root: &Path, target: Tier) -> VecDeque<(PathBuf, String)> {
    let mut out = VecDeque::new();
    let idx = index().lock().unwrap();
    let mut stack = vec![media_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                let Ok(rel) = path.strip_prefix(media_root) else { continue };
                let rel = rel_string(rel);
                if is_image(&rel) && idx.tier_of(&rel).rank() < target.rank() {
                    out.push_back((path, rel));
                }
            }
        }
    }
    out
}

/// Read one image, transcode it to `tier`, and replace it in place atomically
/// (write a sibling `.tmp` then rename — a crash leaves the old or new file, never
/// a partial one). Returns the bytes freed (before − after). `Err(())` on a
/// read/decode/encode/write failure (the original file is left untouched).
fn compress_one(path: &Path, tier: Tier) -> Result<u64, ()> {
    let bytes = std::fs::read(path).map_err(|_| ())?;
    let out = transcode(&bytes, tier).ok_or(())?;
    let tmp = path.with_extension("webp.tmp");
    if std::fs::write(&tmp, &out).is_err() || std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(());
    }
    Ok((bytes.len() as u64).saturating_sub(out.len() as u64))
}

fn worker(job: Arc<BatchJob>) {
    loop {
        if job.cancelled.load(Ordering::Relaxed) {
            break;
        }
        while job.paused.load(Ordering::Relaxed) && !job.cancelled.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if job.cancelled.load(Ordering::Relaxed) {
            break;
        }
        let Some((path, rel)) = job.queue.lock().unwrap().pop_front() else {
            break; // queue drained
        };
        match compress_one(&path, job.target) {
            Ok(freed) => {
                job.freed_bytes.fetch_add(freed, Ordering::Relaxed);
                record_tier(&rel, job.target, false);
            }
            Err(()) => {
                job.failed.fetch_add(1, Ordering::Relaxed);
            }
        }
        job.done.fetch_add(1, Ordering::Relaxed);
        emit(&job, false);
    }

    // Last worker out finalizes the job.
    if job.active_workers.fetch_sub(1, Ordering::Relaxed) == 1 {
        let final_status = if job.cancelled.load(Ordering::Relaxed) {
            Status::Cancelled
        } else {
            Status::Completed
        };
        job.set_status(final_status);
        // Flush the index, drop the gate, clear batch_pending (keep the tier so
        // future downloads stay compressed).
        index().lock().unwrap().maybe_persist(true);
        ACTIVE.store(false, Ordering::Relaxed);
        save_config(job.target, false);
        emit(&job, true);
        *job_slot().lock().unwrap() = None;
    }
}

/// Spawn the worker pool for `job` (CPU-bound encode → OS threads, capped).
fn spawn_workers(job: Arc<BatchJob>) {
    let n = std::thread::available_parallelism()
        .map(|c| (c.get() / 2).clamp(1, 4))
        .unwrap_or(2);
    job.active_workers.store(n, Ordering::Relaxed);
    for _ in 0..n {
        let job = job.clone();
        std::thread::spawn(move || worker(job));
    }
}

/// Start (or resume) a batch toward `target`. Returns the initial snapshot.
fn launch(target: Tier) -> Snapshot {
    let media_root = crate::media::media_root(&crate::data_root::data_root());
    let pending = collect_pending(&media_root, target);
    let job = Arc::new(BatchJob {
        target,
        total: AtomicU32::new(pending.len() as u32),
        done: AtomicU32::new(0),
        failed: AtomicU32::new(0),
        freed_bytes: AtomicU64::new(0),
        status: AtomicU8::new(0),
        paused: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
        active_workers: AtomicUsize::new(0),
        queue: Mutex::new(pending),
        last_emit: Mutex::new(Instant::now()),
    });
    let snap = job.snapshot();
    if job.total.load(Ordering::Relaxed) == 0 {
        // Nothing to do — complete immediately (don't spin up threads / gate).
        job.set_status(Status::Completed);
        ACTIVE.store(false, Ordering::Relaxed);
        save_config(target, false);
        if let Some(app) = APP.get() {
            let _ = app.emit(PROGRESS_EVENT, &job.snapshot());
        }
        crate::android_service::set_compress(false, 0, 0);
        return job.snapshot();
    }
    *job_slot().lock().unwrap() = Some(job.clone());
    crate::android_service::set_compress(true, 0, snap.total);
    spawn_workers(job);
    snap
}

// ---------------------------------------------------------------------------
// Startup + commands
// ---------------------------------------------------------------------------

/// Called once at startup (after data_root init). Restores the persisted tier and,
/// if a batch was interrupted, resumes it (keeping downloads gated until done).
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let cfg = load_config();
    let tier = Tier::from_str(&cfg.tier);
    TIER.store(tier.to_u8(), Ordering::Relaxed);
    let _ = index(); // warm the index
    if tier.is_real() && cfg.batch_pending {
        ACTIVE.store(true, Ordering::Relaxed);
        launch(tier);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    /// Total media-store bytes right now.
    pub total_bytes: u64,
    /// Image bytes eligible for (further) compression at each tier.
    pub image_bytes: u64,
    pub non_image_bytes: u64,
    /// Projected total store size after compressing to each tier (approx).
    pub lossless_bytes: u64,
    pub q90_bytes: u64,
    pub q70_bytes: u64,
    pub current_tier: String,
}

/// Whole-store image-bytes → tier ratios, from the full-corpus feasibility study
/// (byte-weighted blend of CG/bg/立绘). Used only for the UI estimate (approximate).
const RATIO_LOSSLESS: f64 = 0.47;
const RATIO_Q90: f64 = 0.157;
const RATIO_Q70: f64 = 0.090;

#[tauri::command]
pub fn compress_estimate() -> Estimate {
    let media_root = crate::media::media_root(&crate::data_root::data_root());
    let idx = index().lock().unwrap();
    let (mut image_bytes, mut non_image_bytes) = (0u64, 0u64);
    let mut stack = vec![media_root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                let len = meta.len();
                let rel = path
                    .strip_prefix(&media_root)
                    .ok()
                    .map(rel_string)
                    .unwrap_or_default();
                if is_image(&rel) {
                    image_bytes += len;
                } else {
                    non_image_bytes += len;
                }
            }
        }
    }
    drop(idx);
    let total = image_bytes + non_image_bytes;
    // The estimate models compressing the current image bytes to each tier. It's
    // approximate (current bytes may already be partly compressed); UI labels "约".
    let proj = |ratio: f64| non_image_bytes + (image_bytes as f64 * ratio) as u64;
    Estimate {
        total_bytes: total,
        image_bytes,
        non_image_bytes,
        lossless_bytes: proj(RATIO_LOSSLESS),
        q90_bytes: proj(RATIO_Q90),
        q70_bytes: proj(RATIO_Q70),
        current_tier: current_tier().as_str().to_string(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressConfig {
    pub tier: String,
    pub active: bool,
}

#[tauri::command]
pub fn compress_get_config() -> CompressConfig {
    CompressConfig { tier: current_tier().as_str().to_string(), active: is_active() }
}

/// Start a batch toward `tier` (also enabling real-time compression at that tier).
/// Refuses if a download is running or a batch is already active.
#[tauri::command]
pub fn compress_start(tier: String) -> Result<Snapshot, String> {
    let target = Tier::from_str(&tier);
    if !target.is_real() {
        return Err("无效的压缩档位".into());
    }
    if is_active() {
        return Err("COMPRESS_ACTIVE: 压缩任务已在进行".into());
    }
    if crate::download::any_active() {
        return Err("DOWNLOAD_ACTIVE: 请先完成当前下载再压缩".into());
    }
    TIER.store(target.to_u8(), Ordering::Relaxed);
    ACTIVE.store(true, Ordering::Relaxed);
    save_config(target, true);
    Ok(launch(target))
}

#[tauri::command]
pub fn compress_pause() {
    if let Some(job) = job_slot().lock().unwrap().clone() {
        if job.status() == Status::Running {
            job.paused.store(true, Ordering::Relaxed);
            job.set_status(Status::Paused);
            emit(&job, true);
        }
    }
}

#[tauri::command]
pub fn compress_resume() {
    if let Some(job) = job_slot().lock().unwrap().clone() {
        if job.status() == Status::Paused {
            job.paused.store(false, Ordering::Relaxed);
            job.set_status(Status::Running);
            emit(&job, true);
        }
    }
}

#[tauri::command]
pub fn compress_cancel() {
    if let Some(job) = job_slot().lock().unwrap().clone() {
        job.cancelled.store(true, Ordering::Relaxed);
        job.paused.store(false, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn compress_status() -> Option<Snapshot> {
    job_slot().lock().unwrap().clone().map(|j| j.snapshot())
}

/// Disable real-time compression for *new* downloads. Does not touch already-
/// compressed files (they can't be restored). No-op on a running batch's target.
#[tauri::command]
pub fn compress_disable_realtime() {
    TIER.store(Tier::Off.to_u8(), Ordering::Relaxed);
    save_config(Tier::Off, load_config().batch_pending);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_rank_ordering() {
        assert!(Tier::Off.rank() < Tier::Lossless.rank());
        assert!(Tier::Lossless.rank() < Tier::Q90.rank());
        assert!(Tier::Q90.rank() < Tier::Q70.rank());
    }

    #[test]
    fn tier_roundtrips() {
        for t in [Tier::Off, Tier::Lossless, Tier::Q90, Tier::Q70] {
            assert_eq!(Tier::from_str(t.as_str()), t);
            assert_eq!(Tier::from_u8(t.to_u8()), t);
        }
    }

    #[test]
    fn is_image_matches_only_images() {
        assert!(is_image("media.prts.wiki/a/ab/Avg_char_x.png"));
        assert!(is_image("x/y/Z.JPG"));
        assert!(is_image("x/y/z.webp"));
        assert!(!is_image("torappu.prts.wiki/assets/audio/music/m.mp3"));
        assert!(!is_image("static.prts.wiki/video/x.mp4"));
        assert!(!is_image("cache/story-index.json"));
    }

    #[test]
    fn transcode_png_to_smaller_webp_roundtrips_dimensions() {
        // Build a 64x64 RGBA PNG with alpha, encode to q90 WebP, ensure it decodes
        // back to the same dimensions (and is a valid image).
        let mut rgba = image::RgbaImage::new(64, 64);
        for (x, y, p) in rgba.enumerate_pixels_mut() {
            *p = image::Rgba([(x * 4) as u8, (y * 4) as u8, 128, ((x + y) * 2) as u8]);
        }
        let mut png: Vec<u8> = Vec::new();
        image::DynamicImage::ImageRgba8(rgba)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let webp = transcode(&png, Tier::Q90).expect("transcode ok");
        let decoded = image::load_from_memory(&webp).expect("decodes back");
        assert_eq!(decoded.to_rgba8().dimensions(), (64, 64));
    }

    /// Real in-place replace: a PNG on disk becomes a smaller, valid WebP of the
    /// same dimensions, and the reported freed bytes match the size delta.
    #[test]
    fn compress_one_replaces_png_with_smaller_webp() {
        let dir = std::env::temp_dir().join(format!("prts_comp_one_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Avg_x.png");
        // A 256x256 gradient (compressible) with a real alpha channel.
        let mut rgba = image::RgbaImage::new(256, 256);
        for (x, y, p) in rgba.enumerate_pixels_mut() {
            *p = image::Rgba([x as u8, y as u8, 64, ((x + y) % 256) as u8]);
        }
        let mut png: Vec<u8> = Vec::new();
        image::DynamicImage::ImageRgba8(rgba)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        std::fs::write(&path, &png).unwrap();
        let before = std::fs::metadata(&path).unwrap().len();

        let freed = compress_one(&path, Tier::Q90).expect("compress ok");

        let after = std::fs::metadata(&path).unwrap().len();
        assert!(after < before, "should shrink: {after} >= {before}");
        assert_eq!(freed, before - after);
        let now = std::fs::read(&path).unwrap();
        assert!(
            now.len() >= 12 && &now[0..4] == b"RIFF" && &now[8..12] == b"WEBP",
            "file is now WebP"
        );
        assert_eq!(
            image::load_from_memory(&now).unwrap().to_rgba8().dimensions(),
            (256, 256)
        );
        // No stray temp file left behind.
        assert!(!dir.join("Avg_x.webp.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
