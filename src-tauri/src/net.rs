//! Networking facade: a single choke-point for all outbound HTTP.
//!
//! Everything that fetches bytes over the network goes through here so that the
//! offline switch, the shared reqwest client, and the global bandwidth limiter
//! all apply uniformly. Previously the `allow_online` flag was only consulted by
//! the `prts-cdn://` protocol handler, so the wiki/asset/predownload paths kept
//! downloading even after the user turned networking off — this module fixes that
//! by routing those paths through [`ensure_online`].

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Process-wide "allow online" flag. Default true (online-first works out of the
/// box; users on metered networks can turn it off). When false the app is truly
/// offline: cached resources still load, but every outbound fetch is refused.
static ALLOW_ONLINE: AtomicBool = AtomicBool::new(true);

pub fn allow_online() -> bool {
    ALLOW_ONLINE.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_allow_online(value: bool) {
    ALLOW_ONLINE.store(value, Ordering::Relaxed);
}

#[tauri::command]
pub fn get_allow_online() -> bool {
    allow_online()
}

/// Sentinel substring used in error strings so the frontend can detect the
/// offline case and show a tailored message instead of a generic failure.
pub const OFFLINE_MARKER: &str = "PRTS_OFFLINE";

/// Gate for outbound fetches. Returns an error (containing [`OFFLINE_MARKER`])
/// when networking is disabled, so callers refuse to download.
pub fn ensure_online() -> Result<(), String> {
    if allow_online() {
        Ok(())
    } else {
        Err(format!("{OFFLINE_MARKER}: networking is disabled"))
    }
}

/// Shared reqwest client (connection pooling, one consistent User-Agent). All
/// HTTP in the app should use this instead of building ad-hoc clients.
pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
            .build()
            .unwrap()
    })
}

// ---------------------------------------------------------------------------
// Global bandwidth limiter (token bucket, bytes/sec). 0 == unlimited.
// ---------------------------------------------------------------------------

/// A token-bucket rate limiter shared across all download workers so the limit
/// is a global cap, not per-connection. The refill math is a pure function
/// ([`refill`]) so it can be unit-tested deterministically without sleeping.
pub struct RateLimiter {
    /// Bytes per second; 0 disables limiting.
    rate: AtomicU64,
    inner: std::sync::Mutex<Bucket>,
}

#[derive(Clone, Copy)]
struct Bucket {
    /// Currently available tokens, in bytes.
    tokens: f64,
    /// Last time the bucket was refilled.
    last: Instant,
}

/// Pure refill step: given the previous token count, the elapsed time, and the
/// rate, return the new token count (capped at one second's worth so a long idle
/// period can't bank unlimited burst). Extracted for deterministic testing.
fn refill(tokens: f64, elapsed_secs: f64, rate_bps: u64) -> f64 {
    if rate_bps == 0 {
        return tokens;
    }
    let rate = rate_bps as f64;
    (tokens + elapsed_secs * rate).min(rate)
}

impl RateLimiter {
    pub fn new(rate_bps: u64) -> Self {
        Self {
            rate: AtomicU64::new(rate_bps),
            inner: std::sync::Mutex::new(Bucket {
                tokens: rate_bps as f64,
                last: Instant::now(),
            }),
        }
    }

    pub fn rate(&self) -> u64 {
        self.rate.load(Ordering::Relaxed)
    }

    pub fn set_rate(&self, rate_bps: u64) {
        self.rate.store(rate_bps, Ordering::Relaxed);
    }

    /// Block (async) until `bytes` worth of quota is available, then consume it.
    /// No-op when the rate is 0 (unlimited). Sleeps in bounded slices so a rate
    /// change while waiting takes effect quickly.
    pub async fn acquire(&self, bytes: u64) {
        loop {
            let rate = self.rate.load(Ordering::Relaxed);
            if rate == 0 {
                return;
            }
            let wait = {
                let mut b = self.inner.lock().unwrap();
                let now = Instant::now();
                let elapsed = now.duration_since(b.last).as_secs_f64();
                b.tokens = refill(b.tokens, elapsed, rate);
                b.last = now;
                if b.tokens >= bytes as f64 {
                    b.tokens -= bytes as f64;
                    return;
                }
                // Seconds until enough tokens accumulate.
                (bytes as f64 - b.tokens) / rate as f64
            };
            // Cap each sleep so set_rate() / unlimited toggles are responsive.
            let slice = wait.min(0.25).max(0.001);
            tokio::time::sleep(Duration::from_secs_f64(slice)).await;
        }
    }
}

/// Global limiter instance (default unlimited). The bulk-download workers
/// consume from this so the cap is process-wide across concurrent jobs. The
/// `prts-cdn://` playback handler deliberately does NOT meter through it —
/// interactive media must load at full speed even when a download cap is set.
pub fn limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| RateLimiter::new(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_online_gates_on_flag() {
        set_allow_online(true);
        assert!(ensure_online().is_ok());
        set_allow_online(false);
        let err = ensure_online().unwrap_err();
        assert!(err.contains(OFFLINE_MARKER));
        set_allow_online(true); // restore for other tests in the binary
    }

    #[test]
    fn refill_is_capped_at_one_second_of_rate() {
        // Idle far longer than 1s must not bank more than `rate` tokens.
        assert_eq!(refill(0.0, 100.0, 1000), 1000.0);
        // Zero rate never changes the token count.
        assert_eq!(refill(42.0, 5.0, 0), 42.0);
        // Partial second accrues proportionally.
        assert_eq!(refill(0.0, 0.5, 1000), 500.0);
        // Existing tokens accumulate up to the cap.
        assert_eq!(refill(200.0, 0.5, 1000), 700.0);
    }

    #[tokio::test]
    async fn acquire_is_immediate_when_unlimited() {
        let rl = RateLimiter::new(0);
        let start = Instant::now();
        rl.acquire(10_000_000).await;
        assert!(start.elapsed() < Duration::from_millis(50));
    }

    #[tokio::test]
    async fn acquire_consumes_initial_bucket_without_waiting() {
        // Fresh bucket starts full (== rate), so one rate-sized acquire is instant.
        let rl = RateLimiter::new(1_000_000);
        let start = Instant::now();
        rl.acquire(1_000_000).await;
        assert!(start.elapsed() < Duration::from_millis(50));
    }

    #[tokio::test]
    async fn acquire_throttles_beyond_the_initial_bucket() {
        // rate = 10k B/s. The first 10k drains the starting bucket instantly; the
        // next 10k must wait ~1s for the bucket to refill. Generous bounds keep
        // this from flaking under load.
        let rl = RateLimiter::new(10_000);
        rl.acquire(10_000).await; // drains initial bucket
        let start = Instant::now();
        rl.acquire(10_000).await; // must wait for a refill
        let elapsed = start.elapsed();
        assert!(elapsed >= Duration::from_millis(600), "too fast: {elapsed:?}");
        assert!(elapsed < Duration::from_secs(3), "too slow: {elapsed:?}");
    }
}
