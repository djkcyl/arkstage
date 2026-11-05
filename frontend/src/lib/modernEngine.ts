import { moduleDependencies, buildEngineModule } from "./engineModule";
import { PROXY_BASE, proxyUrl } from "./proxy";
import { captureIframe, pushLog, playbackCheckpoint } from "./debugLog";
import type { FrameBootOptions, FrameBootResult } from "./engineBoot";
import { createPlaybackModes } from "./playbackModes";
import { bindSceneInput } from "./playerInput";
import { invoke } from "@tauri-apps/api/core";
import { cachedEngine, sha256, type EngineDescriptor, type PreparedEngine } from "./engineCache";
import { readPlaybackResume, savePlaybackResume, clearPlaybackResume } from "./playbackResume";
import { createPlaybackCompletion } from "./playbackCompletion";
import { reportLoading, type LoadingProgress } from "./loadingProgress";
import { ensurePlaybackAsset, resetPlaybackAssetRequests } from "./mediaCache";
import { createLogPosition, createReadLogHistory, type LogPosition, type LogSnapshot, type NativeLogView } from "./playerTranscript";

export type ModuleEngine = EngineDescriptor;

export interface PlayerController {
  advance(): Promise<void>;
  reset(): Promise<void>;
  seekHistory(index: number): Promise<void>;
  setAuto(enabled: boolean): void;
  setFastForward(enabled: boolean): boolean;
  setSpeed(level: number): void;
  setVolume(volume: number): void;
  setUIVisible(visible: boolean): void;
  skip(): Promise<void>;
  openLog(fontSize: number, onClose: () => void): void;
  closeLog(): void;
  state(): { state: string; auto: boolean; fastForward: boolean; line: number | null; speed: number; canSkip: boolean };
  dispose(): void;
}

interface NativePlayer {
  mount(host: HTMLElement): Promise<void>;
  start(): Promise<void>;
  advance(): Promise<void>;
  destroy(): void;
  getState(): string;
  getAutoPlayState(): { mode: string; buttonSpeedLevel: number };
  getDisplayedLineIndex(): number | null;
  getLogPosition(): LogPosition;
  seekToLine?(target: number, choices: ReadonlyMap<number, number>, onUpdate: (update: { phase: string; target: number }) => void): () => void;
  setAutoPlayMode(mode: string): void;
  setAutoPlaySpeedLevel(level: number): void;
  canSkipNode(): boolean;
  skipNode(): Promise<void>;
  onDisplayedLineChange?(listener: (line: number | null) => void): () => void;
  getRenderer?(): {
    dialogPanel?: { root?: { renderable: boolean } };
    app?: { renderer: { events: { mapPositionToPoint(point: { x: number; y: number }, x: number, y: number): void; rootBoundary: { hitTest(x: number, y: number): unknown } } } };
  };
}

interface EngineBridge {
  musicContinuity?: boolean;
  nativeLog?: boolean;
  nativeLogSeek?: boolean;
  buildLog(context: unknown): unknown;
  mountLog(host: HTMLElement, document: unknown, context: unknown, position: LogSnapshot, fontSize: number, onClose: () => void, onSeek?: (index: number) => void): NativeLogView;
  loadContext(script: string): Promise<unknown>;
  createPlayer(context: unknown): NativePlayer;
  preload(context: unknown, onProgress?: (progress: number) => void): Promise<void>;
  manifest(context: unknown): string[];
  setVolume(volume: number): void;
}

const prepared = new Map<string, Promise<PreparedEngine>>();
const preparationListeners = new Map<string, Set<(progress: LoadingProgress) => void>>();
const preparationProgress = new Map<string, LoadingProgress>();
const metadataRequests = new Map<string, Promise<Response>>();
const localMetadataRequests = new Map<string, Promise<Response>>();
let rebuildEngine = false;
export function reloadModernEngine(): void {
  prepared.clear(); metadataRequests.clear(); localMetadataRequests.clear();
  preparationProgress.clear(); resetPlaybackAssetRequests();
  rebuildEngine = true;
}
const OFFICIAL_HOSTS = ["static.prts.wiki", "torappu.prts.wiki", "prts.wiki"];
const localUrl = (url: string) => proxyUrl(url, OFFICIAL_HOSTS);

function isEngineAsset(url: string): boolean {
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.hostname === "static.prts.wiki"
    && parsed.pathname.startsWith("/widgets/");
}

function prepareEngine(descriptor: ModuleEngine, onProgress?: (progress: LoadingProgress) => void): Promise<PreparedEngine> {
  const key = JSON.stringify(descriptor);
  let listeners = preparationListeners.get(key);
  if (!listeners) { listeners = new Set(); preparationListeners.set(key, listeners); }
  const report = (progress: LoadingProgress) => {
    preparationProgress.set(key, progress);
    listeners.forEach(listener => listener(progress));
  };
  if (onProgress) {
    listeners.add(onProgress);
    const current = preparationProgress.get(key);
    if (current) onProgress(current);
  }
  let promise = prepared.get(key);
  if (!promise) {
    const force = rebuildEngine;
    rebuildEngine = false;
    promise = cachedEngine(descriptor, {
      read: (key) => force ? Promise.resolve(null) : invoke<string | null>("load_from_cache", { key }),
      write: (key, data) => invoke("save_to_cache", { key, data }),
    }, async () => {
      if (!isEngineAsset(descriptor.entry_url)) throw new Error("PRTS 模块入口来源无效");
      const sources = new Map<string, string>();
      const resources = new Set<string>(descriptor.stylesheet_urls);
      const waiting = [descriptor.entry_url, ...descriptor.polyfill_urls];
      let bytes = 0;
      let done = 0, total = waiting.length;
      report({ phase: "engine", message: "正在缓存演出引擎…", done, total, bytes });
      while (waiting.length) {
        const batch = [...new Set(waiting.splice(0))].filter((url) => !sources.has(url));
        if (sources.size + batch.length > 128) throw new Error("PRTS 模块依赖数量异常");
        const loaded = await Promise.all(batch.map(async (url) => {
          if (!isEngineAsset(url)) throw new Error(`PRTS 模块依赖来源无效: ${url}`);
          await ensurePlaybackAsset(url, force);
          const response = await fetch(localUrl(url));
          if (!response.ok) throw new Error(`PRTS 模块加载失败 (${response.status}): ${url}`);
          const source = await response.text();
          if (!source.trim() || /^\s*</.test(source)) throw new Error(`PRTS 返回了无效模块: ${url}`);
          bytes += source.length;
          done++;
          report({ phase: "engine", message: "正在缓存演出引擎…", done, total, bytes });
          if (bytes > 32 * 1024 * 1024) throw new Error("PRTS 模块依赖体积异常");
          return { url, source };
        }));
        for (const { url, source } of loaded) {
          sources.set(url, source);
          resources.add(url);
          waiting.push(...moduleDependencies(source, url).filter((url) => /\.m?js(?:[?#]|$)/.test(url)));
        }
        total = sources.size + new Set(waiting.filter((url) => !sources.has(url))).size;
        report({ phase: "engine", message: "正在解析引擎依赖…", done, total, bytes });
      }
      const source = buildEngineModule(sources.get(descriptor.entry_url)!, descriptor.entry_url, sources, localUrl);
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode([...sources.values()].join("\n")));
      const revision = [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, "0")).join("");
      return { source, resources: [...resources], revision };
    }, localUrl(descriptor.entry_url)).then(async ({ engine, reused }) => {
      // The prepared bridge may outlive individually deleted media-cache files.
      // Refill missing modules through IPC before native import() touches Wry.
      let complete = 0;
      await Promise.all(engine.resources.map(async (url) => {
        await ensurePlaybackAsset(url);
        report({ phase: "engine", message: "正在准备本地演出引擎…", done: ++complete, total: engine.resources.length });
      }));
      pushLog("info", `[engine-cache] ${reused ? "reuse" : "prepared"}: ${descriptor.entry_url}`);
      if (reused) report({ phase: "engine", message: "演出引擎未更新，复用本地缓存", done: 1, total: 1 });
      return engine;
    });
    prepared.set(key, promise);
    void promise.catch(() => { if (prepared.get(key) === promise) prepared.delete(key); });
  }
  return onProgress ? promise.finally(() => { listeners.delete(onProgress); }) : promise;
}

/** Include fresh sidecar contents in manifest cache identity, not just wiki oldid. */
export async function modernEngineRevision(descriptor: ModuleEngine, metadataUrls: string[] = []): Promise<string> {
  const runtime = await prepareEngine(descriptor);
  await Promise.all(metadataUrls.map((url) => metadataResponse(url)));
  const metadata = await Promise.all([...metadataRequests.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(async ([url, response]) => `${url}:${await (await response).clone().text()}`));
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runtime.revision + metadata.join("\n")));
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function metadataResponse(url: string, preferCache = false, onProgress: ((progress: LoadingProgress) => void) | null = reportLoading): Promise<Response> {
  if (!/^https:\/\/(static|torappu)\.prts\.wiki\/.*\.json(?:[?#]|$)/.test(url)) return Promise.reject(new Error("PRTS 数据表来源无效"));
  const requests = preferCache ? localMetadataRequests : metadataRequests;
  let promise = requests.get(url);
  if (!promise) {
    onProgress?.({ phase: "data", message: preferCache ? "正在读取本地演出数据表…" : "正在检查演出数据表更新…" });
    promise = ensurePlaybackAsset(url, !preferCache).then(() => fetch(localUrl(url))).then(async (response) => {
      if (!response.ok) throw new Error(`PRTS 数据表加载失败 (${response.status}): ${url}`);
      await response.clone().json();
      if (!preferCache && requests.get(url) === promise) localMetadataRequests.set(url, Promise.resolve(response.clone()));
      return response;
    });
    requests.set(url, promise);
    void promise.catch(() => { if (requests.get(url) === promise) requests.delete(url); });
  }
  return promise.then((response) => response.clone());
}

function installRouting(win: Window & typeof globalThis, metadata: Set<string>, preferCachedMetadata: boolean, onProgress: ((progress: LoadingProgress) => void) | null): void {
  const route = (url: string) => /^https?:\/\//.test(url) ? localUrl(url) : url;
  const nativeFetch = win.fetch.bind(win);
  win.fetch = async (input, init) => {
    const isRequest = typeof input === "object" && "url" in input;
    const url = typeof input === "string" ? input : isRequest ? input.url : String(input);
    if (/^https:\/\/(static|torappu)\.prts\.wiki\/.*\.json(?:[?#]|$)/.test(url)) {
      metadata.add(url);
      const response = await metadataResponse(url, preferCachedMetadata, onProgress);
      return new win.Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    }
    await ensurePlaybackAsset(url);
    return nativeFetch(isRequest ? new win.Request(route(url), input) : route(url), init);
  };
  const nativeOpen = win.XMLHttpRequest.prototype.open;
  const xhrRequests = new WeakMap<XMLHttpRequest, { url: string; async: boolean }>();
  win.XMLHttpRequest.prototype.open = function (method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) {
    xhrRequests.set(this, { url: String(url), async });
    nativeOpen.call(this, method, route(String(url)), async, username ?? null, password ?? null);
  };
  const nativeSend = win.XMLHttpRequest.prototype.send;
  win.XMLHttpRequest.prototype.send = function (body) {
    const request = xhrRequests.get(this);
    if (!request?.async) { nativeSend.call(this, body); return; }
    void ensurePlaybackAsset(request.url).then(() => {
      if (xhrRequests.get(this) === request) nativeSend.call(this, body);
    }).catch((error) => {
      pushLog("error", "[playback-cache] XHR failed", request.url, error);
      this.dispatchEvent(new win.ProgressEvent("error"));
      this.dispatchEvent(new win.ProgressEvent("loadend"));
    });
  };
  const nativeAbort = win.XMLHttpRequest.prototype.abort;
  win.XMLHttpRequest.prototype.abort = function () { xhrRequests.delete(this); nativeAbort.call(this); };
  const sources = new WeakMap<Element, symbol>();
  const setSource = (element: Element, value: string, apply: () => void) => {
    const token = Symbol(); sources.set(element, token);
    void ensurePlaybackAsset(value).then(() => { if (sources.get(element) === token) apply(); })
      .catch((error) => {
        if (sources.get(element) !== token) return;
        pushLog("error", "[playback-cache] asset failed", value, error);
        element.dispatchEvent(new win.Event("error"));
      });
  };
  for (const proto of [win.HTMLImageElement.prototype, win.HTMLMediaElement.prototype, win.HTMLSourceElement.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, "src");
    if (!descriptor?.set) continue;
    Object.defineProperty(proto, "src", {
      ...descriptor,
      set(value: string) {
        const element = this as HTMLElement;
        setSource(element, value, () => {
          descriptor.set!.call(element, route(value));
          if (element instanceof win.HTMLSourceElement && element.parentElement instanceof win.HTMLMediaElement) element.parentElement.load();
        });
      },
    });
  }
  const nativeSetAttribute = win.Element.prototype.setAttribute;
  win.Element.prototype.setAttribute = function (key, value) {
    if (key === "src" && ["IMG", "AUDIO", "VIDEO", "SOURCE"].includes(this.tagName)) {
      setSource(this, value, () => {
        nativeSetAttribute.call(this, key, route(value));
        if (this instanceof win.HTMLSourceElement && this.parentElement instanceof win.HTMLMediaElement) this.parentElement.load();
      });
    } else nativeSetAttribute.call(this, key, ["src", "href"].includes(key) ? route(value) : value);
  };
  const NativeFontFace = win.FontFace;
  win.FontFace = class extends NativeFontFace {
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
      super(family, typeof source === "string"
        ? source.replace(/https?:\/\/[^\s"'()]+/g, route) : source, descriptors);
    }
  };
}

export async function bootModernEngineInFrame(opts: FrameBootOptions): Promise<FrameBootResult> {
  const report = opts.onLoading ?? (opts.mode === "play" ? reportLoading : undefined);
  const timing = (stage: string, start: number) => {
    if (opts.mode === "play") pushLog("info", `[startup] ${opts.title} ${stage}=${Math.round(performance.now() - start)}ms`);
  };
  const checkpoint = async (stage: string, detail = "") => {
    if (opts.mode === "play" && !opts.isCancelled?.()) await playbackCheckpoint(opts.title, stage, detail);
  };
  await checkpoint("prepare");
  const descriptor = opts.bundle.module_engine!;
  const engineStart = performance.now();
  const runtime = await prepareEngine(descriptor, report);
  timing("engine-cache", engineStart);
  if (opts.isCancelled?.()) return {};
  const win = opts.iframe.contentWindow as Window & typeof globalThis;
  const doc = opts.iframe.contentDocument;
  if (!win || !doc) throw new Error("PRTS 模块播放器容器不可用");
  doc.open();
  // The scene is focusable for keyboard input. Without its own outline rule,
  // Android WebView paints a focus ring around the whole 16:9 picture.
  doc.write('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}body{display:flex;align-items:center;justify-content:center}#arkstage-stage{position:relative;width:min(100vw,calc(100vh * 16 / 9));height:min(100vh,calc(100vw * 9 / 16));overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;outline:none;-webkit-tap-highlight-color:transparent}canvas{display:block}</style></head><body><div id="arkstage-stage"></div></body></html>');
  doc.close();
  doc.documentElement.classList.add("skin-theme-clientpref-night");
  // Some shared wiki modules read these optional MediaWiki settings at import.
  Object.assign(win, { mw: { config: { get: () => null, values: { wgUserGroups: [] } } } });
  captureIframe(win);
  const metadata = new Set<string>();
  installRouting(win, metadata, !!opts.preferCachedMetadata, report ?? null);
  const imports = doc.createElement("script");
  imports.type = "importmap";
  imports.textContent = JSON.stringify({ imports: Object.fromEntries(OFFICIAL_HOSTS.map((host) => [`https://${host}/`, `${PROXY_BASE}/${host}/`])) });
  doc.head.append(imports);
  for (const url of descriptor.stylesheet_urls) {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = localUrl(url);
    doc.head.append(link);
  }
  const importModule = (url: string) => win.eval(`import(${JSON.stringify(url)})`) as Promise<{ arkstageEngine: EngineBridge }>;
  const importStart = performance.now();
  for (const url of descriptor.polyfill_urls) await importModule(localUrl(url));
  const blob = win.URL.createObjectURL(new win.Blob([runtime.source], { type: "text/javascript" }));
  let bridge: EngineBridge;
  try { bridge = (await importModule(blob)).arkstageEngine; }
  finally { win.URL.revokeObjectURL(blob); }
  timing("module-import", importStart);
  if (opts.mode === "play") pushLog(bridge.musicContinuity ? "info" : "warn", `[audio] intro/loop preparation ${bridge.musicContinuity ? "enabled" : "unavailable in upstream API"}`);
  const nickname = localStorage.getItem("prts-nickname") || "博士";
  const script = opts.script.replaceAll("{@nickname}", nickname);
  const contextStart = performance.now();
  const context = await bridge.loadContext(script);
  timing(opts.preferCachedMetadata ? "local-context" : "fresh-context", contextStart);
  await checkpoint("context-ready");
  const urls = bridge.manifest(context);
  const manifest = [...new Set([...runtime.resources, ...metadata, ...urls])].filter((url) => /^https?:\/\//.test(url));
  if (!urls.length) throw new Error("PRTS 新版引擎未生成资源清单");
  const health = { globals: ["createStoryPlayer", "loadContextByScript", "collectPreloadAssetUrls", "preloadContextAssets"], engineScriptCount: runtime.resources.length, assetDomains: OFFICIAL_HOSTS, metadataUrls: [...metadata] };
  pushLog("info", `[module-engine] ${opts.title}: ${manifest.length} assets; entry=${descriptor.entry_url}`);
  if (opts.mode === "manifest") return { manifest, health };
  await Promise.all(manifest.filter((url) => /\.(?:woff2?|ttf|otf|css)(?:[?#]|$)/i.test(url)).map((url) => ensurePlaybackAsset(url)));
  opts.onStatus?.("正在预加载画面资源…");
  report?.({ phase: "art", message: "正在预加载画面资源…", done: 0, total: 100 });
  await checkpoint("preload-start", `assets=${manifest.length}; audio=on-demand; decode-batch=2`);
  let lastProgress = -1;
  await bridge.preload(context, (progress) => {
    const percent = Math.floor(progress * 10) * 10;
    opts.onStatus?.(`正在预加载画面资源… ${Math.round(progress * 100)}%`);
    report?.({ phase: "art", message: "正在预加载画面资源…", done: Math.round(progress * 100), total: 100 });
    if (percent !== lastProgress) { lastProgress = percent; pushLog("info", `[playback] ${opts.title} preload=${percent}%`); }
  });
  await checkpoint("preload-ready");
  if (opts.isCancelled?.()) return {};
  const host = doc.getElementById("arkstage-stage")!;
  let player = bridge.createPlayer(context);
  opts.onStatus?.("正在创建兼容模式画布…");
  report?.({ phase: "initialize", message: "正在创建兼容模式画布…" });
  await checkpoint("renderer-mount", "preference=webgl; antialias=false; resolution<=1.5");
  await player.mount(host);
  await checkpoint("ready", `canvas=${host.querySelector("canvas")?.width}x${host.querySelector("canvas")?.height}`);
  if (opts.preferCachedMetadata) {
    for (const url of metadata) void metadataResponse(url, false, null)
      .catch(error => pushLog("warn", "[runtime-update] background metadata check failed", url, error));
  }
  const watchContext = () => {
    const canvas = host.querySelector("canvas");
    const lost = (event: Event) => {
      if (opts.isCancelled?.()) return;
      event.preventDefault();
      pushLog("error", `[playback] ${opts.title} WebGL context lost`);
      void checkpoint("context-lost");
      opts.onFatal?.("图形上下文丢失，诊断日志已保存。请返回书架后重试。");
    };
    canvas?.addEventListener("webglcontextlost", lost);
    return () => canvas?.removeEventListener("webglcontextlost", lost);
  };
  let removeContextListener = watchContext();
  let uiVisible = true;
  let modes = createPlaybackModes(player);
  const logPosition = createLogPosition();
  const readHistory = createReadLogHistory();
  const scriptHash = await sha256(opts.script);
  let savedProgress: LogSnapshot | null = player.seekToLine ? readPlaybackResume(opts.title, scriptHash) : null;
  let resuming = false;
  let disposed = false;
  let cancelResume: (() => void) | undefined;
  let playbackEligible = true;
  const observeCompletion = createPlaybackCompletion(() => opts.onCompleted?.());
  const checkCompletion = () => observeCompletion(player.getState(), readHistory.cursor() > 0,
    resuming || disposed || !playbackEligible);
  let logView: NativeLogView | undefined;
  let logHost: HTMLElement | undefined;
  let logTimer: ReturnType<typeof setInterval> | undefined;
  let logDocument: unknown;
  let onLogClose: (() => void) | undefined;
  const readLogPosition = (): LogSnapshot => {
    const actual = player.getLogPosition();
    readHistory.record(actual.lineIndex, actual.selections);
    return { ...logPosition.read(actual), readLines: readHistory.snapshot(), readCursor: readHistory.cursor() };
  };
  const syncLog = () => {
    const position = readLogPosition();
    if (logView && logPosition.changed(position)) logView.update(position);
  };
  const lineChanged = () => { if (!resuming) { modes.reconcile(); syncLog(); } };
  let releaseLineListener = player.onDisplayedLineChange?.(lineChanged);
  // Synchronous storage on hide/teardown survives normal Android process stops.
  // Periodic saving also captures choices made without a displayed-line event.
  let lastSaved = "";
  const saveProgress = () => {
    if (resuming || disposed) return;
    checkCompletion();
    if (player.getState() === "finished") { clearPlaybackResume(opts.title); savedProgress = null; return; }
    const position = readLogPosition();
    if (position.lineIndex == null) return;
    const signature = JSON.stringify(position);
    if (signature === lastSaved) return;
    lastSaved = signature;
    savePlaybackResume(opts.title, scriptHash, { ...position, choiceHistory: readHistory.choices() });
  };
  const saveTimer = setInterval(saveProgress, 750);
  const parentDocument = opts.iframe.ownerDocument;
  parentDocument.addEventListener("visibilitychange", saveProgress);
  parentDocument.defaultView?.addEventListener("pagehide", saveProgress);
  const closeLog = () => {
    clearInterval(logTimer); logTimer = undefined;
    logView?.dispose(); logView = undefined;
    logHost?.remove(); logHost = undefined;
    const closed = onLogClose; onLogClose = undefined;
    closed?.();
  };
  const rebuildPlayer = async () => {
    input.cancel(); releaseLineListener?.(); removeContextListener();
    player.destroy(); host.replaceChildren(); player = bridge.createPlayer(context);
    modes = createPlaybackModes(player);
    await player.mount(host);
    if (disposed) { player.destroy(); throw new Error("播放已关闭"); }
    releaseLineListener = player.onDisplayedLineChange?.(lineChanged);
    removeContextListener = watchContext();
  };
  const controller: PlayerController = {
    async advance() {
      if (resuming) return;
      if (host.querySelector("[data-resume-prompt]")) {
        host.querySelector("[data-resume-prompt]")?.remove();
        clearPlaybackResume(opts.title); savedProgress = null;
      }
      host.querySelector("[data-start-prompt]")?.remove();
      await (player.getState() === "idle" ? player.start() : player.advance());
      checkCompletion();
    },
    async reset() {
      cancelResume?.();
      clearPlaybackResume(opts.title); savedProgress = null; lastSaved = "";
      await checkpoint("reset");
      closeLog(); logPosition.reset(); readHistory.reset();
      playbackEligible = true;
      await rebuildPlayer();
      showStartPrompt();
    },
    async seekHistory(index) {
      if (resuming || disposed) return;
      const target = readHistory.target(index);
      if (!target || !player.seekToLine) throw new Error("这条记录暂时不能跳转");
      const previous = { ...readLogPosition(), choiceHistory: readHistory.choices() };
      closeLog(); input.cancel();
      savePlaybackResume(opts.title, scriptHash, previous);
      try {
        await seekPlayback(target, true, "正在跳转到历史位置…");
        lastSaved = ""; saveProgress();
      } catch (error) {
        if (!disposed) {
          resuming = true;
          try { await rebuildPlayer(); }
          finally { resuming = false; }
          logPosition.reset(); readHistory.reset();
          savedProgress = previous;
          savePlaybackResume(opts.title, scriptHash, previous);
          showStartPrompt();
          const prompt = host.querySelector("[data-start-prompt]");
          if (prompt) prompt.textContent = "跳转未完成，可从头播放";
        }
        throw error;
      }
    },
    setAuto(enabled) { if (!resuming) { input.cancel(); modes.setAuto(enabled); } },
    setFastForward(enabled) { return !resuming && modes.setFastForward(enabled); },
    setSpeed(level) { player.setAutoPlaySpeedLevel(level); },
    setVolume(volume) { bridge.setVolume(Math.min(1, Math.max(0, volume))); },
    setUIVisible(visible) {
      uiVisible = visible;
      if (!visible) input.cancel();
      const panel = player.getRenderer?.()?.dialogPanel?.root;
      if (panel) panel.renderable = visible;
    },
    async skip() { if (!resuming && player.canSkipNode()) await player.skipNode(); },
    openLog(fontSize, onClose) {
      closeLog(); input.cancel(); modes.setAuto(false);
      if (!bridge.nativeLog) throw new Error("当前 PRTS 引擎缺少原生 LOG 接口，请刷新演出引擎后重试。");
      const root = doc.createElement("div");
      root.className = "arkstage-native-log";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-label", "剧情日志");
      root.style.cssText = "position:absolute;inset:0;z-index:20;overflow:hidden;overscroll-behavior:contain;user-select:text;background:#101418";
      doc.body.append(root); logHost = root;
      try {
        logView = bridge.mountLog(root, () => logDocument ??= bridge.buildLog(context), context, readLogPosition(), fontSize, closeLog,
          bridge.nativeLogSeek && player.seekToLine ? index => {
            void controller.seekHistory(index).catch(error => pushLog("warn", "[playback] LOG 跳转失败，原进度已保留:", error));
          } : undefined);
        onLogClose = onClose;
        // Choices can change without changing the displayed source line. The
        // event handles fast text changes; this lightweight timer covers choices.
        logTimer = setInterval(syncLog, 120);
      } catch (error) { closeLog(); throw error; }
    },
    closeLog,
    state() { checkCompletion(); return { state: resuming ? "resuming" : player.getState(), ...(resuming ? { auto: false, fastForward: false, speed: 1 } : modes.state()), line: player.getDisplayedLineIndex(), canSkip: !resuming && player.canSkipNode() }; },
    dispose() {
      saveProgress(); disposed = true; cancelResume?.(); clearInterval(saveTimer);
      parentDocument.removeEventListener("visibilitychange", saveProgress);
      parentDocument.defaultView?.removeEventListener("pagehide", saveProgress);
      void playbackCheckpoint(opts.title, "disposed");
      closeLog();
      input.dispose(); releaseLineListener?.();
      removeContextListener();
      player.destroy();
    },
  };
  const onClick = () => {
    if (logView || resuming) return;
    if (!uiVisible) { controller.setUIVisible(true); return; }
    void controller.advance().catch((error) => pushLog("error", "[module-engine] advance failed", error));
  };
  const input = bindSceneInput(host, {
    advance: onClick,
    setFastForward: (enabled) => controller.setFastForward(enabled),
    canHold: () => uiVisible && !logView && !resuming && !opts.iframe.ownerDocument.querySelector('[aria-modal="true"]'),
    isClaimed: (x, y) => {
      if (player.getState() === "waiting_decision") return true;
      const events = player.getRenderer?.()?.app?.renderer.events;
      if (!events) return false;
      const point = { x: 0, y: 0 };
      events.mapPositionToPoint(point, x, y);
      return !!events.rootBoundary.hitTest(point.x, point.y);
    },
  });
  host.tabIndex = 0;
  function showStartPrompt() {
    if (savedProgress && player.seekToLine) {
      const resume = host.ownerDocument.createElement("button");
      resume.dataset.resumePrompt = "";
      resume.textContent = "继续上次阅读";
      resume.style.cssText = "position:absolute;inset:32% 20% 52%;border:0;background:#000c;color:#f4c430;font-size:20px;cursor:pointer";
      resume.onclick = event => {
        event.stopPropagation();
        host.querySelector("[data-start-prompt]")?.remove(); resume.remove();
        void seekPlayback(savedProgress!).catch(async error => {
          if (disposed || !savedProgress) return;
          pushLog("warn", "[resume] 恢复失败，可从头播放:", error);
          await controller.reset();
          const prompt = host.querySelector("[data-start-prompt]");
          if (prompt) prompt.textContent = "恢复未完成，点击从头播放";
        });
      };
      host.append(resume);
    }
    const prompt = host.ownerDocument.createElement("button");
    prompt.dataset.startPrompt = "";
    prompt.textContent = savedProgress ? "从头播放" : "点击开始剧情回顾";
    prompt.style.cssText = `position:absolute;inset:${savedProgress ? "53% 20% 30%" : "40% 20%"};border:0;background:#000b;color:#fff;font-size:20px;cursor:pointer`;
    prompt.addEventListener("click", () => {
      host.querySelector("[data-resume-prompt]")?.remove(); prompt.remove();
      clearPlaybackResume(opts.title); savedProgress = null;
    }, { once: true });
    host.append(prompt);
  }
  async function seekPlayback(saved: LogSnapshot, rebuild = false, message = "正在恢复上次阅读位置…"): Promise<void> {
    if (!saved?.lineIndex || !player.seekToLine) return;
    resuming = true; playbackEligible = false;
    const overlay = host.ownerDocument.createElement("div");
    overlay.textContent = message;
    overlay.style.cssText = "position:absolute;inset:0;display:grid;place-items:center;background:#000;color:#ddd;font-size:18px;z-index:10";
    try {
      if (rebuild) await rebuildPlayer();
      if (disposed) throw new Error("播放已关闭");
      host.append(overlay);
      await new Promise<void>((resolve, reject) => {
        const seek: { stop?: () => void; settled: boolean } = { settled: false };
        const finish = (error?: Error) => {
          if (seek.settled) return;
          seek.settled = true;
          clearTimeout(timer); seek.stop?.(); cancelResume = undefined;
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => finish(new Error("恢复阅读位置超时")), 60_000);
        cancelResume = () => finish(new Error("恢复已取消"));
        seek.stop = player.seekToLine!(saved.lineIndex!, new Map(saved.selections.map(choice => [choice.decisionId, choice.optionIndex])), update => {
          if (update.phase === "reached") finish();
          else if (update.phase !== "seeking") finish(new Error(`恢复阅读位置未完成: ${update.phase}`));
        });
        if (seek.settled) seek.stop();
        void player.start().catch(error => finish(error instanceof Error ? error : new Error(String(error))));
      });
      readHistory.restore(saved); logPosition.reset(); logPosition.read(saved);
      playbackEligible = true;
      pushLog("info", `[resume] ${opts.title}: restored line=${saved.lineIndex}`);
    } finally {
      resuming = false; overlay.remove();
      if (!disposed) { modes = createPlaybackModes(player); syncLog(); }
    }
  }
  showStartPrompt();
  return { health, controller };
}
