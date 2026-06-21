// Tiny hand-written throttling primitives — no external deps.
//
// 1. `createLimiter(n)` — a concurrency limiter capping in-flight async tasks to n.
// 2. `createTokenBucket(bytesPerSec)` — a byte token bucket so total download
//    throughput stays under a ceiling (protects prts.wiki).
//
// The two combine in media.js: ≤2 concurrent prts requests AND <5 MB/s total.

/**
 * A simple promise concurrency limiter.
 * @param {number} max max concurrent tasks
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>} run wrapper
 */
export function createLimiter(max) {
  let active = 0;
  /** @type {Array<() => void>} */
  const queue = [];

  const next = () => {
    if (active >= max) return;
    const run = queue.shift();
    if (run) {
      active++;
      run();
    }
  };

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}

/**
 * A byte token bucket. `take(n)` resolves once n tokens are available, refilling
 * at `bytesPerSec`. Capacity is 1s worth of tokens so bursts can't exceed the rate.
 * @param {number} bytesPerSec sustained throughput ceiling
 */
export function createTokenBucket(bytesPerSec) {
  let tokens = bytesPerSec;
  let last = Date.now();

  const refill = () => {
    const now = Date.now();
    const elapsed = (now - last) / 1000;
    last = now;
    tokens = Math.min(bytesPerSec, tokens + elapsed * bytesPerSec);
  };

  return {
    /**
     * Wait until `n` bytes worth of tokens are available, then consume them.
     * Large n (bigger than capacity) is allowed: it just waits proportionally.
     * @param {number} n
     */
    async take(n) {
      // Cap a single request's debt at capacity so it can't starve forever.
      const want = Math.max(0, n);
      // Loop: consume what we can, sleep for the rest.
      // Allow taking up to the full bucket; if want > capacity, drain repeatedly.
      let remaining = want;
      while (remaining > 0) {
        refill();
        const grab = Math.min(remaining, tokens);
        if (grab > 0) {
          tokens -= grab;
          remaining -= grab;
        }
        if (remaining > 0) {
          // Sleep long enough to accrue at least some tokens.
          const needSec = Math.min(1, remaining / bytesPerSec);
          await sleep(Math.max(5, needSec * 1000));
        }
      }
    },
  };
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
