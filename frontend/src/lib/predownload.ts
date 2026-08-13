import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bootEngineInFrame, prewarmEngineDeps, refreshEngineDeps } from "./engineBoot";
import type { WidgetBundle } from "./engineBoot";
import { setManifestProgress } from "./keepalive";
import { pushLog } from "./debugLog";

/**
 * Predownload status. Indexing (manifest) and downloading run CONCURRENTLY now
 * (each parsed story's assets are streamed to the downloader immediately), so
 * this carries both phases' progress at once — the UI shows two progress bars.
 */
export interface PredownloadStatus {
  paused: boolean;
  // 索引 (manifest) phase
  manifestDone: number;
  manifestTotal: number;
  manifestActive: boolean; // still indexing stories
  // 下载 (download) phase
  done: number;
  total: number; // known assets so far (grows while indexing)
  success: number;
  failed: number;
  skipped: number;
  bytesPerSec: number;
}

/** One control surface that pauses/cancels both phases together. */
export interface PredownloadSession {
  pause: () => void;
  resume: () => void;
  cancel: () => void;
}

/** Live snapshot of a managed download job (mirrors download::Snapshot in Rust). */
export interface JobSnapshot {
  id: number;
  status: "running" | "paused" | "completed" | "cancelled";
  total: number;
  done: number;
  success: number;
  failed: number;
  skipped: number;
  bytes: number;
  bytesPerSec: number;
  /** Keys that failed after retries (with last error), for diagnosing missing assets. */
  failedKeys: string[];
}

/** True when an error string came from the backend offline gate. */
export function isOfflineError(e: unknown): boolean {
  return String(e instanceof Error ? e.message : e).includes("PRTS_OFFLINE");
}

// One fresh-first request per app lifetime. The bundle contains PRTS's GLOBAL
// background/character/link databases; treating it as an eternal cache made every
// new event miss its art until the user manually cleared all cache. Network failure
// falls back to the last successful bundle so already-cached stories remain usable.
let bundlePromise: Promise<WidgetBundle> | null = null;
const storyRuntimePromises = new Map<string, Promise<StoryRuntime>>();

/** Allow a later navigation/retry to re-fetch after a transient rejected request. */
function retainOnlySuccess<T>(promise: Promise<T>, clear: () => void): Promise<T> {
  void promise.catch(() => clear());
  return promise;
}

interface RawStoryRuntime {
  story: { script: string; title: string };
  bundle: WidgetBundle;
  revision: string;
}

export interface StoryRuntime extends RawStoryRuntime {
  source: "live" | "cache" | "legacy-cache";
  warning?: string;
  /** Previous verified generation, used if visible-mode boot rejects the candidate. */
  fallback?: RawStoryRuntime;
}

/** Load the shared widget bundle (engine DOM + scripts + global databases). */
export function loadBundle(): Promise<WidgetBundle> {
  if (!bundlePromise) {
    const pending = refreshBundle();
    bundlePromise = retainOnlySuccess(pending, () => {
      if (bundlePromise === pending) bundlePromise = null;
    });
  }
  return bundlePromise;
}

async function refreshBundle(): Promise<WidgetBundle> {
  let cached: WidgetBundle | null = null;
  try {
    for (const key of ["widget-bundle-v5", "widget-bundle-v4", "widget-bundle-v3", "widget-bundle-v2"]) {
      const raw = await invoke<string | null>("load_from_cache", { key });
      if (!raw) continue;
      const candidate = JSON.parse(raw) as WidgetBundle;
      // v3 briefly serialised script raw-text through innerHTML, corrupting JS
      // operators into HTML entities. Never use such a bundle as offline rollback.
      if (validateBundleShape(candidate).length === 0
        && !candidate.engine_scripts.some((script) => /&(?:amp|gt|lt|quot);/.test(script))) {
        cached = candidate;
        break;
      }
    }
  } catch {
    // Continue with the live request.
  }
  try {
    const fresh = await invoke<WidgetBundle>("fetch_widget_bundle", { pageTitle: "W2G/BEG" });
    if (cached && isSuspiciousRegression(fresh, cached)) {
      throw new Error("PRTS 全局资源表数量异常回退，已拒绝覆盖本地可用版本");
    }
    await validateBundleBoot(fresh, "W2G/BEG");
    await invoke("save_to_cache", {
      key: "widget-bundle-v5",
      data: JSON.stringify(fresh),
    }).catch(() => {});
    await refreshEngineDeps();
    return fresh;
  } catch (error) {
    if (cached) {
      pushLog("warn", "[runtime-update] PRTS 候选引擎验证失败，保留上次可用版本:", error);
      await refreshEngineDeps();
      return cached;
    }
    throw error;
  }
}

function isSuspiciousRegression(fresh: WidgetBundle, cached: WidgetBundle): boolean {
  const a = fresh.diagnostics;
  const b = cached.diagnostics;
  if (!a || !b) return false;
  return a.background_entries < b.background_entries * 0.8
    || a.character_entries < b.character_entries * 0.8
    || a.link_groups < b.link_groups * 0.8
    || a.engine_script_count < b.engine_script_count
    || (a.audio_entries ?? 0) < (b.audio_entries ?? 0) * 0.8
    || (a.engine_script_bytes ?? 0) < (b.engine_script_bytes ?? 0) * 0.7;
}

/** Exact-page, fresh-first script + engine/data snapshot for interactive playback. */
export function loadStoryRuntime(title: string): Promise<StoryRuntime> {
  let promise = storyRuntimePromises.get(title);
  if (!promise) {
    const pending = refreshStoryRuntime(title);
    promise = retainOnlySuccess(pending, () => {
      if (storyRuntimePromises.get(title) === pending) storyRuntimePromises.delete(title);
    });
    storyRuntimePromises.set(title, promise);
  }
  return promise;
}

async function refreshStoryRuntime(title: string): Promise<StoryRuntime> {
  const key = `story-runtime-v5_${title.replace(/\//g, "_")}`;
  const previousKey = `${key}-previous`;
  let cached: RawStoryRuntime | null = null;
  try {
    for (const cacheKey of [key, previousKey, `story-runtime-v4_${title.replace(/\//g, "_")}`]) {
      const raw = await invoke<string | null>("load_from_cache", { key: cacheKey });
      if (!raw) continue;
      const candidate = JSON.parse(raw) as RawStoryRuntime;
      if (validateRuntimeShape(candidate).length === 0) {
        cached = candidate;
        break;
      }
    }
  } catch {
    // Continue with live fetch.
  }
  try {
    const fresh = await invoke<RawStoryRuntime>("fetch_story_runtime", { pageTitle: title });
    if (cached && isSuspiciousRegression(fresh.bundle, cached.bundle)) {
      throw new Error("PRTS 当前同页快照完整性低于本地版本，已阻止覆盖");
    }
    // This is the promotion gate: execute the candidate in a disposable iframe
    // before it is allowed to replace last-known-good on disk.
    await validateRuntimeBoot(fresh, title);
    if (cached && cached.revision !== fresh.revision) {
      await invoke("save_to_cache", { key: previousKey, data: JSON.stringify(cached) }).catch(() => {});
    }
    await invoke("save_to_cache", { key, data: JSON.stringify(fresh) }).catch(() => {});
    await refreshEngineDeps();
    return { ...fresh, source: "live", fallback: cached ?? undefined };
  } catch (error) {
    if (cached) {
      pushLog("warn", `[runtime-update] ${title}: 候选快照验证失败，自动回退`, error);
      await refreshEngineDeps();
      return { ...cached, source: "cache", warning: String(error) };
    }
    // Upgrade path: preserve old v1.1.x script cache when the first v3 sync is
    // attempted offline. The shared bundle has its own last-known-good rollback.
    const legacyKey = `stories_${title.replace(/\//g, "_")}`;
    const legacyRaw = await invoke<string | null>("load_from_cache", { key: legacyKey }).catch(() => null);
    if (legacyRaw) {
      const story = JSON.parse(legacyRaw) as { script: string; title: string };
      const bundle = await loadBundle();
      return {
        story,
        bundle,
        revision: `legacy:${await hashText(story.script)}:${bundle.revision || "unknown"}`,
        source: "legacy-cache",
        warning: String(error),
      };
    }
    throw error;
  }
}

const REQUIRED_DATA_BLOCKS = ["datas_txt", "datas_back", "datas_char", "datas_audio", "datas_link"];
const REQUIRED_ENGINE_CAPABILITIES = ["Timer", "system", "data.init", "fun_sys_init", "fun_sys_preload", "window.onload"];

export function validateBundleShape(bundle: WidgetBundle): string[] {
  const problems: string[] = [];
  if (!bundle || !Array.isArray(bundle.engine_scripts)) return ["快照格式无效"];
  const diagnostics = bundle.diagnostics;
  for (const id of REQUIRED_DATA_BLOCKS) {
    if (!bundle.data_blocks_html?.includes(`id="${id}"`)) problems.push(`缺少 #${id}`);
  }
  if (!bundle.dom_html?.includes("id=\"sys_main\"")) problems.push("缺少 #sys_main");
  const engine = bundle.engine_scripts.join("\n");
  const markers: Record<string, RegExp> = {
    Timer: /function\s+Timer\b/,
    system: /\bvar\s+system\b/,
    "data.init": /\bdata\.init\s*\(/,
    fun_sys_init: /\bfun_sys_init\b/,
    fun_sys_preload: /\bfun_sys_preload\b/,
    "window.onload": /\bwindow\.onload\b/,
  };
  for (const capability of REQUIRED_ENGINE_CAPABILITIES) {
    if (!markers[capability].test(engine)) problems.push(`引擎缺少 ${capability}`);
  }
  if (engine.length < 10_000) problems.push(`引擎脚本异常短 (${engine.length} bytes)`);
  if (diagnostics) {
    if (diagnostics.background_entries < 100) problems.push("背景表异常短");
    if (diagnostics.character_entries < 100) problems.push("角色表异常短");
    if ((diagnostics.audio_entries ?? 10) < 10) problems.push("音频表异常短");
    if (diagnostics.link_groups < 50) problems.push("角色链接表异常短");
  }
  return problems;
}

function validateRuntimeShape(runtime: RawStoryRuntime): string[] {
  const problems = validateBundleShape(runtime?.bundle);
  if (!runtime?.story?.script?.trim()) problems.push("剧情脚本为空");
  if (!runtime?.revision) problems.push("快照版本缺失");
  return problems;
}

async function validateRuntimeBoot(runtime: RawStoryRuntime, title: string): Promise<void> {
  const problems = validateRuntimeShape(runtime);
  if (problems.length) throw new Error(`候选快照结构验证失败: ${problems.join("；")}`);
  await validateCandidateBoot(runtime.bundle, runtime.story.script, title);
}

async function validateBundleBoot(bundle: WidgetBundle, title: string): Promise<void> {
  const problems = validateBundleShape(bundle);
  if (problems.length) throw new Error(`候选引擎结构验证失败: ${problems.join("；")}`);
  const parsed = new DOMParser().parseFromString(bundle.data_blocks_html, "text/html");
  const script = parsed.getElementById("datas_txt")?.textContent || "";
  if (!script.trim()) throw new Error("候选引擎自带剧情脚本为空");
  await validateCandidateBoot(bundle, script, title);
}

async function validateCandidateBoot(bundle: WidgetBundle, script: string, title: string): Promise<void> {
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;left:-99999px;top:0;width:960px;height:540px;border:0;";
  document.body.appendChild(iframe);
  try {
    const result = await bootEngineInFrame({ iframe, bundle, script, title, mode: "manifest" });
    if (!result.health || result.health.globals.length < 4) {
      throw new Error("候选引擎未通过启动健康检查");
    }
    if (result.audit?.missing.length) {
      throw new Error(`资源引用缺失: ${result.audit.missing.slice(0, 8).join("；")}`);
    }
    if (!result.manifest?.length) {
      throw new Error("候选引擎未能完成预加载资源解析");
    }
  } finally {
    iframe.remove();
  }
}

/** Fetch+cache a story's script if needed, returning its raw scenario text. */
interface ScriptRecord {
  script: string;
  title: string;
  pageRevision?: string;
  scriptHash?: string;
}

async function ensureScriptRecord(title: string, pageRevision?: string): Promise<ScriptRecord> {
  const key = `stories_${title.replace(/\//g, "_")}`;
  let cached: ScriptRecord | null = null;
  try {
    const raw = await invoke<string | null>("load_from_cache", { key });
    if (raw) cached = JSON.parse(raw) as ScriptRecord;
  } catch {
    // Continue with live fetch.
  }
  if (pageRevision && cached?.pageRevision === pageRevision && cached.script) {
    cached.scriptHash ||= await hashText(cached.script);
    return cached;
  }
  try {
    const data = await invoke<{ script: string; title: string }>("fetch_story_page", { pageTitle: title });
    const record: ScriptRecord = {
      ...data,
      pageRevision,
      scriptHash: await hashText(data.script),
    };
    await invoke("save_to_cache", { key, data: JSON.stringify(record) }).catch(() => {});
    return record;
  } catch (error) {
    if (cached?.script) {
      cached.scriptHash ||= await hashText(cached.script);
      return cached;
    }
    throw error;
  }
}

/** Fetch+cache a story's script with revision validation. */
export async function ensureScript(title: string, pageRevision?: string): Promise<string> {
  return (await ensureScriptRecord(title, pageRevision)).script;
}

async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16);
}

/**
 * Boot the engine for one story inside an isolated, hidden iframe and return its
 * deduped asset URLs (via bootEngineInFrame's manifest mode). No media is fetched.
 */
export async function captureManifest(
  bundle: WidgetBundle,
  script: string,
  title: string
): Promise<string[]> {
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;left:-99999px;top:0;width:960px;height:540px;border:0;";
  document.body.appendChild(iframe);
  try {
    const { manifest, audit } = await bootEngineInFrame({ iframe, bundle, script, title, mode: "manifest" });
    if (audit?.missing.length) {
      throw new Error(`PRTS 同步校验失败（${title}）：${audit.missing.slice(0, 8).join("；")}`);
    }
    return manifest ?? [];
  } finally {
    iframe.remove();
  }
}

/**
 * Captured asset-URL manifest for one story, **cached** under `manifest_<title>`
 * so we don't re-boot the engine (and don't re-fetch the script) on every
 * predownload. A cache hit needs no network at all — important for offline reuse
 * and for breakpoint-resume (a re-run skips already-parsed stories instantly).
 */
interface ManifestRecord {
  schemaVersion: 2;
  runtimeRevision: string;
  pageRevision?: string;
  scriptHash: string;
  urls: string[];
}

export async function manifestForStory(
  bundle: WidgetBundle,
  title: string,
  pageRevision?: string,
  engineAssetsRevision?: string
): Promise<string[]> {
  const key = `manifest_${title.replace(/\//g, "_")}`;
  const script = await ensureScriptRecord(title, pageRevision);
  const runtimeRevision = `${bundle.revision || "legacy"}|${engineAssetsRevision || "unknown"}`;
  const cachedRaw = await invoke<string | null>("load_from_cache", { key }).catch(() => null);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as ManifestRecord;
      if (cached.schemaVersion === 2
        && cached.runtimeRevision === runtimeRevision
        && cached.pageRevision === script.pageRevision
        && cached.scriptHash === script.scriptHash
        && cached.urls.length > 0) return cached.urls;
    } catch {
      // Legacy/corrupt manifest is recaptured below.
    }
  }
  const urls = await captureManifest(bundle, script.script, title);
  if (!urls.length) throw new Error(`PRTS 引擎未能为「${title}」生成任何资源清单`);
  const record: ManifestRecord = {
    schemaVersion: 2,
    runtimeRevision,
    pageRevision: script.pageRevision,
    scriptHash: script.scriptHash || await hashText(script.script),
    urls,
  };
  await invoke("save_to_cache", { key, data: JSON.stringify(record) }).catch(() => {});
  return urls;
}

/** Frontend pause/cancel gate for the (engine-driven) manifest phase. */
class PauseGate {
  private _paused = false;
  private _cancelled = false;
  private waiters: Array<() => void> = [];
  get paused() {
    return this._paused;
  }
  get cancelled() {
    return this._cancelled;
  }
  pause() {
    this._paused = true;
  }
  resume() {
    this._paused = false;
    this.flush();
  }
  cancel() {
    this._cancelled = true;
    this._paused = false;
    this.flush();
  }
  private flush() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }
  /** Block while paused; returns as soon as resumed or cancelled. */
  async wait(): Promise<void> {
    while (this._paused && !this._cancelled) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

/**
 * How many story manifests to capture concurrently. Each capture boots the engine
 * in its own hidden iframe (independent realms), so several can run at once; this
 * overlaps the (network-bound) script fetches with the (CPU-bound) engine parsing
 * and is the main speed-up for the indexing phase. Kept modest so several heavy
 * engine iframes don't exhaust memory on low-end phones.
 */
const MANIFEST_CONCURRENCY = 4;

/**
 * How many passes to retry stories whose manifest capture failed before giving up.
 * Failures are usually transient (the WebView renderer was throttled/frozen while
 * backgrounded); retrying keeps the job from closing early with missing assets.
 * Bounded so a genuinely broken story can't loop forever.
 */
const MANIFEST_INDEX_ROUNDS = 4;

// Screen Wake Lock — keep the screen on (so the WebView renderer stays active and
// the indexing phase keeps running) while the user has the app open and sets the
// phone down. The lock auto-releases when the page is hidden, so we re-acquire on
// visibility. Best-effort: unsupported/denied just no-ops. Doesn't help once the
// app is fully backgrounded (that's what PHASE-1 Rust cached-feeding is for).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let screenWakeLock: any = null;
async function acquireScreenWake(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wl = (navigator as any).wakeLock;
    if (wl && !screenWakeLock) screenWakeLock = await wl.request("screen");
  } catch {
    screenWakeLock = null;
  }
}
function releaseScreenWake(): void {
  try {
    void screenWakeLock?.release();
  } catch {
    /* ignore */
  }
  screenWakeLock = null;
}

const ZERO_JOB: JobSnapshot = {
  id: 0,
  status: "running",
  total: 0,
  done: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  bytes: 0,
  bytesPerSec: 0,
  failedKeys: [],
};

/**
 * Orchestrate a pipelined predownload: open a streaming download job, then parse
 * each story's manifest and immediately stream its (deduped, cached) asset URLs
 * to the job so indexing and downloading run CONCURRENTLY. Reports both phases'
 * progress via `onStatus` (two bars) and exposes one pause/cancel `onSession`.
 *
 * Brings up the Android keep-alive foreground service with "downloading" text + a
 * progress bar while it runs (via setDownloadProgress), and clears it (`null`) when
 * done — which tears the service/notification down unless a story is being read.
 * Throws on the offline gate (detect with isOfflineError).
 */
export async function runPredownload(
  titles: string[],
  onStatus: (s: PredownloadStatus) => void,
  onSession: (s: PredownloadSession) => void
): Promise<{ cancelled: boolean; job: JobSnapshot | null }> {
  // Tell the native keep-alive about indexing right away (download counts come
  // from the Rust engine; the FGS itself is started by the download_start command).
  setManifestProgress(0, titles.length, true);

  const gate = new PauseGate();
  let manifestDone = 0;
  const manifestTotal = titles.length;
  let manifestActive = true;
  let paused = false;
  let dl: JobSnapshot = { ...ZERO_JOB };
  const emit = () => {
    onStatus({
      paused,
      manifestDone,
      manifestTotal,
      manifestActive,
      done: dl.done,
      total: dl.total,
      success: dl.success,
      failed: dl.failed,
      skipped: dl.skipped,
      bytesPerSec: dl.bytesPerSec,
    });
    // Mirror only the indexing counts to the native keep-alive; the download
    // numbers + the notification itself are driven by the Rust engine.
    setManifestProgress(manifestDone, manifestTotal, manifestActive);
  };

  // Keep the screen awake for the duration (re-acquire when the app becomes
  // visible again, since the lock drops while hidden).
  const onVisible = () => { if (document.visibilityState === "visible") void acquireScreenWake(); };
  document.addEventListener("visibilitychange", onVisible);
  await acquireScreenWake();

  try {
    const bundle = await loadBundle();
    // Cache the engine deps once up-front (via Rust) so the parallel iframe boots
    // below all load jQuery/PreloadJS/toolbox from disk instead of the network.
    await prewarmEngineDeps();
    const engineAssetsRevision = await refreshEngineDeps();
    const runtimeRevision = `${bundle.revision || "legacy"}|${engineAssetsRevision}`;
    let pageRevisions: Record<string, string> = {};
    try {
      pageRevisions = await invoke<Record<string, string>>("fetch_page_revisions", { titles });
    } catch (error) {
      // Safe fallback: no old manifest is trusted; ensureScriptRecord will fetch
      // each page fresh and only use cache if that live request fails.
      console.warn("PRTS revision check failed; switching to per-page validation", error);
    }
    // Open a streaming job (foreground → keep-alive start is allowed).
    const jobId = await invoke<number>("download_start", { urls: [] });

    onSession({
      pause: () => { paused = true; gate.pause(); invoke("download_pause", { jobId }); emit(); },
      resume: () => { paused = false; gate.resume(); invoke("download_resume", { jobId }); emit(); },
      cancel: () => { gate.cancel(); invoke("download_cancel", { jobId }); },
    });

    // Resolve when the job reaches a terminal status (driven by events + a poll backstop).
    let resolveDone: (s: JobSnapshot) => void = () => {};
    const done = new Promise<JobSnapshot>((res) => { resolveDone = res; });
    const isTerminal = (s: JobSnapshot) => s.status === "completed" || s.status === "cancelled";
    const unlisten = await listen<JobSnapshot>("download://progress", (e) => {
      if (e.payload.id !== jobId) return;
      dl = e.payload;
      if (e.payload.status === "paused") paused = true;
      emit();
      if (isTerminal(e.payload)) resolveDone(e.payload);
    });
    emit();

    let cancelled = false;
    let offlineErr: unknown = null;

    // PHASE 1 (Rust, background-proof): feed every ALREADY-cached manifest straight
    // from the cache files into the job — no WebView involved, so these keep
    // downloading even when the app is fully backgrounded (Home/screen-off), which
    // is when aggressive ROMs freeze the WebView renderer. Returns the titles that
    // still need WebView engine indexing.
    let pending: string[];
    try {
      pending = await invoke<string[]>("download_feed_cached", {
        jobId,
        titles,
        runtimeRevision,
        pageRevisions,
      });
    } catch {
      pending = [...titles];
    }
    const cachedCount = titles.length - pending.length;
    let indexed = 0; // uncached stories newly indexed this run
    manifestDone = cachedCount;
    emit();

    // PHASE 2 (WebView): index the remaining uncached stories. Booting the engine
    // per story (hidden iframe) MUST run in the foreground WebView — the screen wake
    // lock above keeps it alive while the phone is set down. A POOL runs
    // concurrently; failures are RETRIED (not dropped) so a momentary background
    // throttle doesn't close the job early with missing assets — it resumes on
    // return to the foreground.
    const indexOne = async (title: string): Promise<boolean> => {
      try {
        const urls = (await manifestForStory(
          bundle,
          title,
          pageRevisions[title],
          engineAssetsRevision
        ))
          // Only real http(s) assets are downloadable; drop data:/blob:/relative
          // URLs the engine emits so they never inflate the total or look failed.
          .filter((u) => /^https?:\/\//i.test(u));
        await invoke("download_add", { jobId, urls });
        indexed++;
        manifestDone = cachedCount + indexed;
        emit();
        return true;
      } catch (e) {
        if (isOfflineError(e)) { offlineErr = e; return false; }
        console.warn("manifest failed for", title, e);
        return false;
      }
    };

    // One concurrent pass over `items` (titles); returns the ones that failed.
    const runPass = async (items: string[]): Promise<string[]> => {
      const failed: string[] = [];
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          await gate.wait();
          if (gate.cancelled) { cancelled = true; return; }
          if (offlineErr) return;
          const k = next++;
          if (k >= items.length) return;
          const ok = await indexOne(items[k]);
          if (!ok && !gate.cancelled && !offlineErr) failed.push(items[k]);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(MANIFEST_CONCURRENCY, items.length) }, worker)
      );
      return failed;
    };

    for (let round = 0; round < MANIFEST_INDEX_ROUNDS; round++) {
      if (!pending.length) break;
      pending = await runPass(pending);
      if (!pending.length || gate.cancelled || offlineErr) break;
      // Backoff before retrying. If the app is backgrounded (renderer throttled),
      // the awaited work below simply doesn't progress until it's foreground again.
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (offlineErr) { unlisten(); throw offlineErr; }
    if (pending.length) {
      console.warn(
        `predownload: ${pending.length}/${titles.length} stories could not be indexed after ${MANIFEST_INDEX_ROUNDS} rounds`
      );
    }
    manifestActive = false;
    emit();

    // No more URLs coming — let the queue drain and the job finish.
    await invoke("download_close", { jobId });
    const poll = setInterval(() => {
      invoke<JobSnapshot | null>("download_status", { jobId }).then((s) => {
        if (s && isTerminal(s)) resolveDone(s);
      });
    }, 400);
    const job = await done;
    clearInterval(poll);
    unlisten();
    return { cancelled: cancelled || job.status === "cancelled", job };
  } finally {
    document.removeEventListener("visibilitychange", onVisible);
    releaseScreenWake();
    // Indexing is over; clear its counts. The engine clears the download state on
    // the job's terminal snapshot, which drops the service to "reading" or stops it.
    setManifestProgress(0, 0, false);
  }
}

// ---------------------------------------------------------------------------
// Download settings (concurrency + bandwidth limit). The backend holds these in
// memory for the session; we mirror them to localStorage and re-apply on
// startup so they survive restarts.
// ---------------------------------------------------------------------------

export interface DownloadSettings {
  concurrency: number;
  rateLimitBps: number; // bytes/sec; 0 = unlimited
}

const SETTINGS_KEY = "prts-download-settings";

export async function getDownloadSettings(): Promise<DownloadSettings> {
  return await invoke<DownloadSettings>("download_settings_get");
}

export async function setDownloadSettings(s: DownloadSettings): Promise<void> {
  await invoke("download_settings_set", {
    concurrency: s.concurrency,
    rateLimitBps: s.rateLimitBps,
  });
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/** Re-apply persisted download settings to the backend (call once at startup). */
export async function applyPersistedDownloadSettings(): Promise<void> {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return;
  try {
    const s = JSON.parse(raw) as DownloadSettings;
    await invoke("download_settings_set", {
      concurrency: s.concurrency,
      rateLimitBps: s.rateLimitBps,
    });
  } catch {
    /* ignore malformed persisted settings */
  }
}
