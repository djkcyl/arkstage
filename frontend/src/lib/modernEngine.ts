import { moduleDependencies, buildEngineModule } from "./engineModule";
import { PROXY_BASE, proxyUrl } from "./proxy";
import { captureIframe, pushLog, playbackCheckpoint } from "./debugLog";
import type { FrameBootOptions, FrameBootResult } from "./engineBoot";
import { createPlaybackModes } from "./playbackModes";
import { bindSceneInput } from "./playerInput";
import { invoke } from "@tauri-apps/api/core";
import { cachedEngine, type EngineDescriptor, type PreparedEngine } from "./engineCache";
import { reportLoading } from "./loadingProgress";
import { ensurePlaybackAsset } from "./mediaCache";

export type ModuleEngine = EngineDescriptor;

export interface PlayerController {
  advance(): Promise<void>;
  reset(): Promise<void>;
  setAuto(enabled: boolean): void;
  setFastForward(enabled: boolean): boolean;
  setSpeed(level: number): void;
  setVolume(volume: number): void;
  setUIVisible(visible: boolean): void;
  skip(): Promise<void>;
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
  loadContext(script: string): Promise<unknown>;
  createPlayer(context: unknown): NativePlayer;
  preload(context: unknown, onProgress?: (progress: number) => void): Promise<void>;
  manifest(context: unknown): string[];
  setVolume(volume: number): void;
}

const prepared = new Map<string, Promise<PreparedEngine>>();
const metadataRequests = new Map<string, Promise<Response>>();
const OFFICIAL_HOSTS = ["static.prts.wiki", "torappu.prts.wiki", "prts.wiki"];
const localUrl = (url: string) => proxyUrl(url, OFFICIAL_HOSTS);

function isEngineAsset(url: string): boolean {
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.hostname === "static.prts.wiki"
    && parsed.pathname.startsWith("/widgets/");
}

function prepareEngine(descriptor: ModuleEngine): Promise<PreparedEngine> {
  const key = JSON.stringify(descriptor);
  let promise = prepared.get(key);
  if (!promise) {
    promise = cachedEngine(descriptor, {
      read: (key) => invoke<string | null>("load_from_cache", { key }),
      write: (key, data) => invoke("save_to_cache", { key, data }),
    }, async () => {
      if (!isEngineAsset(descriptor.entry_url)) throw new Error("PRTS 模块入口来源无效");
      const sources = new Map<string, string>();
      const resources = new Set<string>(descriptor.stylesheet_urls);
      const waiting = [descriptor.entry_url, ...descriptor.polyfill_urls];
      let bytes = 0;
      let done = 0, total = waiting.length;
      reportLoading({ phase: "engine", message: "正在缓存演出引擎…", done, total, bytes });
      while (waiting.length) {
        const batch = [...new Set(waiting.splice(0))].filter((url) => !sources.has(url));
        if (sources.size + batch.length > 128) throw new Error("PRTS 模块依赖数量异常");
        const loaded = await Promise.all(batch.map(async (url) => {
          if (!isEngineAsset(url)) throw new Error(`PRTS 模块依赖来源无效: ${url}`);
          await ensurePlaybackAsset(url);
          const response = await fetch(localUrl(url));
          if (!response.ok) throw new Error(`PRTS 模块加载失败 (${response.status}): ${url}`);
          const source = await response.text();
          if (!source.trim() || /^\s*</.test(source)) throw new Error(`PRTS 返回了无效模块: ${url}`);
          bytes += source.length;
          done++;
          reportLoading({ phase: "engine", message: "正在缓存演出引擎…", done, total, bytes });
          if (bytes > 32 * 1024 * 1024) throw new Error("PRTS 模块依赖体积异常");
          return { url, source };
        }));
        for (const { url, source } of loaded) {
          sources.set(url, source);
          resources.add(url);
          waiting.push(...moduleDependencies(source, url).filter((url) => /\.m?js(?:[?#]|$)/.test(url)));
        }
        total = sources.size + new Set(waiting.filter((url) => !sources.has(url))).size;
        reportLoading({ phase: "engine", message: "正在解析引擎依赖…", done, total, bytes });
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
        reportLoading({ phase: "engine", message: "正在准备本地演出引擎…", done: ++complete, total: engine.resources.length });
      }));
      pushLog("info", `[engine-cache] ${reused ? "reuse" : "prepared"}: ${descriptor.entry_url}`);
      if (reused) reportLoading({ phase: "engine", message: "演出引擎未更新，复用本地缓存", done: 1, total: 1 });
      return engine;
    });
    prepared.set(key, promise);
    void promise.catch(() => { if (prepared.get(key) === promise) prepared.delete(key); });
  }
  return promise;
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

function metadataResponse(url: string): Promise<Response> {
  if (!/^https:\/\/(static|torappu)\.prts\.wiki\/.*\.json(?:[?#]|$)/.test(url)) return Promise.reject(new Error("PRTS 数据表来源无效"));
  let promise = metadataRequests.get(url);
  if (!promise) {
    reportLoading({ phase: "data", message: "正在检查演出数据表更新…" });
    promise = ensurePlaybackAsset(url, true).then(() => fetch(localUrl(url))).then(async (response) => {
      if (!response.ok) throw new Error(`PRTS 数据表加载失败 (${response.status}): ${url}`);
      await response.clone().json();
      return response;
    });
    metadataRequests.set(url, promise);
    void promise.catch(() => { if (metadataRequests.get(url) === promise) metadataRequests.delete(url); });
  }
  return promise.then((response) => response.clone());
}

function installRouting(win: Window & typeof globalThis, metadata: Set<string>): void {
  const route = (url: string) => /^https?:\/\//.test(url) ? localUrl(url) : url;
  const nativeFetch = win.fetch.bind(win);
  win.fetch = async (input, init) => {
    const isRequest = typeof input === "object" && "url" in input;
    const url = typeof input === "string" ? input : isRequest ? input.url : String(input);
    if (/^https:\/\/(static|torappu)\.prts\.wiki\/.*\.json(?:[?#]|$)/.test(url)) {
      metadata.add(url);
      const response = await metadataResponse(url);
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
  const checkpoint = async (stage: string, detail = "") => {
    if (opts.mode === "play" && !opts.isCancelled?.()) await playbackCheckpoint(opts.title, stage, detail);
  };
  await checkpoint("prepare");
  const descriptor = opts.bundle.module_engine!;
  const runtime = await prepareEngine(descriptor);
  if (opts.isCancelled?.()) return {};
  const win = opts.iframe.contentWindow as Window & typeof globalThis;
  const doc = opts.iframe.contentDocument;
  if (!win || !doc) throw new Error("PRTS 模块播放器容器不可用");
  doc.open();
  // The scene is focusable for keyboard input. Without its own outline rule,
  // Android WebView paints a focus ring around the whole 16:9 picture.
  doc.write('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}body{display:flex;align-items:center;justify-content:center}#arkstage-stage{position:relative;width:min(100vw,calc(100vh * 16 / 9));height:min(100vh,calc(100vw * 9 / 16));overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;outline:none;-webkit-tap-highlight-color:transparent}canvas{display:block}</style></head><body><div id="arkstage-stage"></div></body></html>');
  doc.close();
  // Some shared wiki modules read these optional MediaWiki settings at import.
  Object.assign(win, { mw: { config: { get: () => null, values: { wgUserGroups: [] } } } });
  captureIframe(win);
  const metadata = new Set<string>();
  installRouting(win, metadata);
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
  for (const url of descriptor.polyfill_urls) await importModule(localUrl(url));
  const blob = win.URL.createObjectURL(new win.Blob([runtime.source], { type: "text/javascript" }));
  let bridge: EngineBridge;
  try { bridge = (await importModule(blob)).arkstageEngine; }
  finally { win.URL.revokeObjectURL(blob); }
  if (opts.mode === "play") pushLog(bridge.musicContinuity ? "info" : "warn", `[audio] intro/loop preparation ${bridge.musicContinuity ? "enabled" : "unavailable in upstream API"}`);
  const nickname = localStorage.getItem("prts-nickname") || "博士";
  const script = opts.script.replaceAll("{@nickname}", nickname);
  const context = await bridge.loadContext(script);
  await checkpoint("context-ready");
  const urls = bridge.manifest(context);
  const manifest = [...new Set([...runtime.resources, ...metadata, ...urls])].filter((url) => /^https?:\/\//.test(url));
  if (!urls.length) throw new Error("PRTS 新版引擎未生成资源清单");
  const health = { globals: ["createStoryPlayer", "loadContextByScript", "collectPreloadAssetUrls", "preloadContextAssets"], engineScriptCount: runtime.resources.length, assetDomains: OFFICIAL_HOSTS, metadataUrls: [...metadata] };
  pushLog("info", `[module-engine] ${opts.title}: ${manifest.length} assets; entry=${descriptor.entry_url}`);
  if (opts.mode === "manifest") return { manifest, health };
  await Promise.all(manifest.filter((url) => /\.(?:woff2?|ttf|otf|css)(?:[?#]|$)/i.test(url)).map((url) => ensurePlaybackAsset(url)));
  opts.onStatus?.("正在预加载画面资源…");
  reportLoading({ phase: "art", message: "正在预加载画面资源…", done: 0, total: 100 });
  await checkpoint("preload-start", `assets=${manifest.length}; audio=on-demand; decode-batch=2`);
  let lastProgress = -1;
  await bridge.preload(context, (progress) => {
    const percent = Math.floor(progress * 10) * 10;
    opts.onStatus?.(`正在预加载画面资源… ${Math.round(progress * 100)}%`);
    reportLoading({ phase: "art", message: "正在预加载画面资源…", done: Math.round(progress * 100), total: 100 });
    if (percent !== lastProgress) { lastProgress = percent; pushLog("info", `[playback] ${opts.title} preload=${percent}%`); }
  });
  await checkpoint("preload-ready");
  if (opts.isCancelled?.()) return {};
  const host = doc.getElementById("arkstage-stage")!;
  let player = bridge.createPlayer(context);
  opts.onStatus?.("正在创建兼容模式画布…");
  reportLoading({ phase: "initialize", message: "正在创建兼容模式画布…" });
  await checkpoint("renderer-mount", "preference=webgl; antialias=false; resolution<=1.5");
  await player.mount(host);
  await checkpoint("ready", `canvas=${host.querySelector("canvas")?.width}x${host.querySelector("canvas")?.height}`);
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
  let releaseLineListener = player.onDisplayedLineChange?.(() => modes.reconcile());
  const controller: PlayerController = {
    async advance() {
      host.querySelector("[data-start-prompt]")?.remove();
      await (player.getState() === "idle" ? player.start() : player.advance());
    },
    async reset() {
      await checkpoint("reset");
      input.cancel();
      releaseLineListener?.();
      removeContextListener();
      player.destroy(); host.replaceChildren(); player = bridge.createPlayer(context);
      modes = createPlaybackModes(player);
      await player.mount(host);
      releaseLineListener = player.onDisplayedLineChange?.(() => modes.reconcile());
      removeContextListener = watchContext();
      showStartPrompt();
    },
    setAuto(enabled) { input.cancel(); modes.setAuto(enabled); },
    setFastForward(enabled) { return modes.setFastForward(enabled); },
    setSpeed(level) { player.setAutoPlaySpeedLevel(level); },
    setVolume(volume) { bridge.setVolume(Math.min(1, Math.max(0, volume))); },
    setUIVisible(visible) {
      uiVisible = visible;
      if (!visible) input.cancel();
      const panel = player.getRenderer?.()?.dialogPanel?.root;
      if (panel) panel.renderable = visible;
    },
    async skip() { if (player.canSkipNode()) await player.skipNode(); },
    state() { return { state: player.getState(), ...modes.state(), line: player.getDisplayedLineIndex(), canSkip: player.canSkipNode() }; },
    dispose() {
      void playbackCheckpoint(opts.title, "disposed");
      input.dispose(); releaseLineListener?.();
      removeContextListener();
      player.destroy();
    },
  };
  const onClick = () => {
    if (!uiVisible) { controller.setUIVisible(true); return; }
    void controller.advance().catch((error) => pushLog("error", "[module-engine] advance failed", error));
  };
  const input = bindSceneInput(host, {
    advance: onClick,
    setFastForward: (enabled) => controller.setFastForward(enabled),
    canHold: () => uiVisible && !opts.iframe.ownerDocument.querySelector('[aria-modal="true"]'),
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
    const prompt = host.ownerDocument.createElement("button");
    prompt.dataset.startPrompt = "";
    prompt.textContent = "点击开始剧情回顾";
    prompt.style.cssText = "position:absolute;inset:40% 20%;border:0;background:#000b;color:#fff;font-size:20px;cursor:pointer";
    prompt.addEventListener("click", () => prompt.remove(), { once: true });
    host.append(prompt);
  }
  showStartPrompt();
  return { health, controller };
}
