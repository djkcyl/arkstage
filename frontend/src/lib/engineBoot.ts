import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { PROXY_BASE, discoverAssetDomains, proxyUrl, rewriteAllCdnUrls } from "./proxy";
import { captureIframe, pushLog } from "./debugLog";
import { scenarioLinkOverrides, type ScenarioLinkOverride } from "./BookshelfMetadataContext";

/**
 * Boots the original PRTS ScenarioSimulator engine inside an ISOLATED <iframe>
 * realm. A fresh realm per boot is required because the engine declares top-level
 * `const`s (queue, log_limit_px, $enum, …): re-running it in the main window — e.g.
 * opening a second story, or capturing a manifest while playing — throws
 * "duplicate variable". Using an iframe also means teardown is just iframe.remove()
 * (no global/ timer cleanup, no leakage between stories).
 *
 * "play"    — visible iframe, CDN URLs rewritten to prts-cdn://, runs normally.
 * "manifest"— hidden iframe, RAW CDN URLs, hooks PreloadJS and runs the engine's own
 *             fun_sys_preload() to enumerate a story's deduped asset URLs (no loading).
 */

export interface WidgetBundle {
  dom_html: string;
  data_blocks_html: string;
  engine_scripts: string[];
  revision?: string;
  diagnostics?: {
    data_block_ids: string[];
    dom_element_ids?: string[];
    background_entries: number;
    character_entries: number;
    audio_entries?: number;
    link_groups: number;
    engine_script_count: number;
    engine_script_bytes?: number;
    engine_capabilities?: string[];
  };
}

export interface FrameBootOptions {
  /** A freshly created, already-attached iframe to boot the engine into. */
  iframe: HTMLIFrameElement;
  bundle: WidgetBundle;
  /** Raw scenario script (#datas_txt content) for this story. */
  script: string;
  /** Page title, written into #firstHeading (read by data.init()). */
  title: string;
  mode: "play" | "manifest";
  /** Polled between async steps so a cancelled boot can bail early. */
  isCancelled?: () => boolean;
}

export interface FrameBootResult {
  /** In "manifest" mode: the deduped original asset URLs from fun_sys_preload. */
  manifest?: string[];
  audit?: ScenarioAudit;
  health?: EngineHealth;
}

export interface EngineHealth {
  globals: string[];
  engineScriptCount: number;
  assetDomains: string[];
}

export interface ScenarioAudit {
  referenced: number;
  missing: string[];
}

// Engine dependencies are refreshed once per app lifecycle. Validated disk cache
// is the offline rollback; bundled files are the final disaster-recovery copy.
export const EXTERNALS = {
  css: { url: "https://static.prts.wiki/assets/scenario/arknights-scenario.css", filename: "arknights-scenario.css", bundled: "vendor/arknights-scenario.css" },
  jquery: { url: "https://code.jquery.com/jquery-3.7.1.min.js", filename: "jquery.min.js", bundled: "vendor/jquery.min.js" },
  preloadjs: { url: "https://static.prts.wiki/npm/PreloadJS@1.0.1/preloadjs.min.js", filename: "preloadjs.min.js", bundled: "vendor/preloadjs.min.js" },
  toolbox: { url: "https://static.prts.wiki/assets/scenario/krliov.toolbox.js", filename: "krliov.toolbox.js", bundled: "vendor/krliov.toolbox.js" },
  font: { url: "https://static.prts.wiki/assets/scenario/fonts/NotoSans.ttf", filename: "NotoSans.ttf", bundled: "vendor/NotoSans.ttf" },
};

/** Absolute app-origin URL for a bundled asset path (e.g. "vendor/x.js"). */
function bundledUrl(rel: string): string {
  return new URL(rel, `${window.location.origin}/`).href;
}

// Count of engine script blocks in the last boot (for the diagnostic probe).
let bundleScriptCount = 0;
let engineRefreshPromise: Promise<string> | null = null;

interface AssetSnapshot {
  path: string;
  sha256: string;
  fresh: boolean;
  warning?: string | null;
}

/** Fresh-first hot update for all executable/style engine dependencies. */
export function refreshEngineDeps(): Promise<string> {
  if (!engineRefreshPromise) {
    const deps = [EXTERNALS.css, EXTERNALS.jquery, EXTERNALS.preloadjs, EXTERNALS.toolbox];
    engineRefreshPromise = Promise.all(deps.map(async (dep) => {
      try {
        const snapshot = await invoke<AssetSnapshot>("refresh_engine_asset", {
          url: dep.url,
          filename: dep.filename,
        });
        if (!snapshot.fresh && snapshot.warning) {
          pushLog("warn", `[engine-update] ${dep.filename}: ${snapshot.warning}`);
        }
        return `${dep.filename}:${snapshot.sha256}`;
      } catch (error) {
        pushLog("warn", `[engine-update] ${dep.filename}: using bundled fallback`, error);
        return `${dep.filename}:bundled`;
      }
    })).then((parts) => parts.join("|"));
  }
  return engineRefreshPromise;
}

export async function bootEngineInFrame(opts: FrameBootOptions): Promise<FrameBootResult> {
  const { iframe, bundle, script, title, mode } = opts;
  const isCancelled = opts.isCancelled ?? (() => false);
  const play = mode === "play";
  const assetDomains = discoverAssetDomains(
    bundle.dom_html,
    bundle.data_blocks_html,
    ...bundle.engine_scripts
  );
  bundleScriptCount = bundle.engine_scripts.length;
  await refreshEngineDeps();

  const idoc = iframe.contentDocument;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iwin = iframe.contentWindow as any;
  if (!idoc || !iwin) throw new Error("iframe realm unavailable");

  // MediaWiki shim must exist before engine scripts read mw.config.
  const nickname = localStorage.getItem("prts-nickname") || null;
  iwin.mw = { config: { get: (k: string) => (k === "wgUserName" ? nickname : null) } };

  // === Build the engine document ===
  const normalizedScript = normalizeScenarioScript(script);
  if (normalizedScript !== script) {
    pushLog("info", `[engine] normalized malformed character group spacing in ${title}`);
  }
  let dataBlocksHtml = replaceDataBlock(bundle.data_blocks_html, "datas_txt", normalizedScript);
  // manifest mode keeps RAW CDN URLs so captured assets are original https URLs.
  const domHtml = play ? rewriteAllCdnUrls(bundle.dom_html, assetDomains) : bundle.dom_html;
  if (play) dataBlocksHtml = rewriteAllCdnUrls(dataBlocksHtml, assetDomains);
  // NOTE: render off-screen rather than `display:none`. The engine reads the page
  // name via `tarObj.innerText` in data.init(); on Chromium/WebView2 `innerText`
  // of a non-rendered (display:none) element is "", which corrupts system.page and
  // aborts boot — leaving the static "页面载入中…" screen. Off-screen keeps it
  // rendered so innerText works, while staying invisible.
  const heading = `<h1 id="firstHeading" style="position:absolute;left:-99999px;top:0"><span class="mw-page-title-main">${escapeHtml(title)}</span></h1>`;

  // overflow:hidden so nothing ever shows a scrollbar: the off-screen #firstHeading
  // (left:-99999px) and sub-pixel rounding in the scaled #sys_main would otherwise
  // produce horizontal/vertical scrollbars, and the scrollbars toggling on/off
  // during a window resize is what makes the stage "jitter".
  const baseStyle = `<style>html,body{margin:0;height:100%;overflow:hidden;background:#000;}</style>`;
  idoc.open();
  idoc.write(`<!DOCTYPE html><html><head><meta charset="utf-8">${baseStyle}</head><body style="margin:0;background:#000;">${heading}${domHtml}${dataBlocksHtml}</body></html>`);
  idoc.close();

  // PRTS updates the global image table and the character-link table separately.
  // During that window new scripts/images exist but `datas_link` lacks their base
  // groups, so charLink("avg_x#1$2") aborts before the image URL is even looked up.
  // Recover missing groups from datas_char itself; existing precise layouts win.
  repairScenarioLinks(idoc, scenarioLinkOverrides());
  const audit = auditScenarioReferences(idoc, normalizedScript);
  if (audit.missing.length) {
    pushLog("error", `[sync-audit] ${title}: ${audit.missing.join("; ")}`);
  } else {
    pushLog("info", `[sync-audit] ${title}: ${audit.referenced} references resolved`);
  }

  // Capture engine-side errors (uncaught script errors, failed asset loads, console)
  // BEFORE any engine script runs, so the real cause of a stuck boot is visible.
  captureIframe(iwin);

  if (play) {
    // URL-rewrite shim (patches the iframe's own Image/Audio/Source prototypes).
    await runScriptCode(idoc, iwin, buildShimCode(assetDomains));
    // Font + CSS.
    const fontUrl = await ensureFontCached();
    await loadCssInDoc(idoc, fontUrl);
  }
  if (isCancelled()) return {};
  const depsRevision = engineRefreshPromise ? await engineRefreshPromise : "unknown";

  // === Load JS deps in order (into the iframe realm) ===
  await loadScriptInDoc(idoc, await resolveAssetUrl(EXTERNALS.jquery));
  if (isCancelled()) return {};
  await loadScriptInDoc(idoc, await resolveAssetUrl(EXTERNALS.preloadjs));
  if (isCancelled()) return {};
  await loadScriptInDoc(idoc, await resolveAssetUrl(EXTERNALS.toolbox));
  if (isCancelled()) return {};
  assertExternalDepsReady(iwin, depsRevision);

  // === Execute engine scripts (defines data/system/queue/fun_sys_preload, runs fun_sys_init) ===
  // PRTS emits several classic scripts which share one global lexical scope.
  // Execute them as one program: besides preserving that contract, this avoids a
  // Chromium WebView failure where separate blob: scripts emitted opaque errors
  // for every block and none of them defined their globals.
  if (isCancelled()) return {};
  validateEngineSource(bundle.engine_scripts);
  const engineCode = bundle.engine_scripts
    .map((code, index) => `// ---- PRTS engine block ${index + 1} ----\n${code}`)
    .join("\n;\n")
    + engineCompatibilityPatch();
  await runScriptCode(
    idoc,
    iwin,
    play ? rewriteAllCdnUrls(engineCode, assetDomains) : engineCode,
    "prts-engine.js"
  );
  const health = assertEngineReady(iwin, assetDomains);

  if (mode === "manifest") {
    reportBootHealth(iwin);
    return { manifest: capturePreloadManifest(iwin), audit, health };
  }

  // === Play: run jQuery ready (fun_sys_preload + event wiring) and window.onload ===
  processRLQ(iwin);
  triggerWindowOnload(iwin);
  // Skip the engine's "long-press 1s to start preload" gate: kick off preloading
  // immediately so the story is ready without the intermediate prompt screen.
  autoStartPreload(iwin);
  // Scale the fixed 960x540 stage to fill the window (the engine only does this in
  // real browser fullscreen, leaving black margins in our windowed webview).
  installWindowedFit(iwin, idoc);
  reportBootHealth(iwin);
  return { audit, health };
}

/** Fast fail for cached snapshots created by older, less strict parsers. */
export function validateEngineSource(scripts: readonly string[]): void {
  const source = scripts.join("\n");
  const problems: string[] = [];
  const markers: Array<[string, RegExp]> = [
    ["Timer", /function\s+Timer\b/],
    ["system", /\bvar\s+system\b/],
    ["data.init", /\bdata\.init\s*\(/],
    ["fun_sys_init", /\bfun_sys_init\b/],
    ["fun_sys_preload", /\bfun_sys_preload\b/],
    ["window.onload", /\bwindow\.onload\b/],
  ];
  if (source.length < 10_000) problems.push(`脚本异常短 (${source.length} bytes)`);
  if (/&(?:amp|gt|lt|quot);/.test(source)) problems.push("脚本包含 HTML 实体");
  for (const [name, marker] of markers) if (!marker.test(source)) problems.push(`缺少 ${name}`);
  if (problems.length) throw new Error(`PRTS 引擎源码不完整: ${problems.join("；")}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assertExternalDepsReady(iwin: any, revision: string): void {
  const missing: string[] = [];
  if (typeof iwin.$ !== "function" || !iwin.$.fn?.jquery) missing.push("jQuery");
  if (typeof iwin.createjs?.LoadQueue !== "function") missing.push("PreloadJS.LoadQueue");
  // toolbox declares `class TimerManager` as a global lexical binding (not a
  // window property), but also installs these stable prototype helpers.
  if (typeof iwin.Array?.prototype?.empty !== "function"
    || typeof iwin.Array?.prototype?.last !== "function") missing.push("krliov.toolbox");
  if (missing.length) {
    throw new Error(`PRTS 外部引擎依赖不完整: ${missing.join(", ")} (revision=${revision})`);
  }
}

/** Static mirror of the engine's preload key resolution. This catches a script /
 * global-table mismatch before the user reaches a blank CG or character frame. */
export function auditScenarioReferences(doc: Document, script: string): ScenarioAudit {
  const csvKeys = (id: string) => new Set(
    (doc.getElementById(id)?.textContent || "")
      .split("\n")
      .map((line) => line.split(",", 1)[0]?.trim().toLowerCase())
      .filter(Boolean)
  );
  const backgrounds = csvKeys("datas_back");
  const characters = csvKeys("datas_char");
  let links: Record<string, ScenarioLink> = {};
  try { links = JSON.parse(doc.getElementById("datas_link")?.textContent || "{}"); } catch { /* reported below */ }

  const missing = new Set<string>();
  let referenced = 0;
  const command = /^\s*\[\s*(background|image|showitem|gridbg|verticalbg|largebg|largeimg|character|charactercutin|charslot)\s*(?:\((.*?)\))?\s*\]/gim;
  for (const match of script.matchAll(command)) {
    const type = match[1].toLowerCase();
    const args: Record<string, string> = {};
    const params = match[2] || "";
    const param = /([a-zA-Z][\w]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s)]+))/g;
    for (const p of params.matchAll(param)) args[p[1].toLowerCase()] = p[2] ?? p[3] ?? p[4] ?? "";

    if (["background", "image", "showitem"].includes(type) && args.image) {
      const key = `${type === "background" ? "bg_" : ""}${args.image.toLowerCase()}`;
      referenced++;
      if (!backgrounds.has(key)) missing.add(`<${type}> ${key}`);
    }
    if (["gridbg", "verticalbg", "largebg", "largeimg"].includes(type) && args.imagegroup) {
      for (const image of args.imagegroup.split("/").filter(Boolean)) {
        const key = `${type.endsWith("bg") ? "bg_" : ""}${image.toLowerCase()}`;
        referenced++;
        if (!backgrounds.has(key)) missing.add(`<${type}> ${key}`);
      }
    }
    if (["character", "charactercutin", "charslot"].includes(type)) {
      const names = [args.name, type === "character" ? args.name2 : undefined].filter(Boolean) as string[];
      for (const raw of names) {
        referenced++;
        const parsed = raw.trim().toLowerCase().match(/^([^@#$]+)(?:[@#$]([a-z\d]+)|#(\d+)\$(\d+))?$/);
        const base = parsed?.[1];
        if (!base || !links[base]) { missing.add(`<${type}> ${base || raw}`); continue; }
        const group = parsed?.[4];
        if (group && !links[base].array.some((entry) => entry.name.toLowerCase().endsWith(`$${group}`))) {
          missing.add(`<${type}> ${base} group $${group}`);
          continue;
        }
        // Every link entry must resolve to the character URL table. Checking all
        // entries also validates automatically repaired link groups.
        if (!links[base].array.some((entry) => characters.has(entry.name.toLowerCase()))) {
          missing.add(`<${type}> ${base} image table`);
        }
      }
    }
  }
  return { referenced, missing: Array.from(missing) };
}

/**
 * PRTS occasionally publishes a grouped character key with whitespace between
 * its expression and group (`#3 $1`). The upstream engine only accepts `#3$1`
 * and otherwise skips the frame and its preload asset. This narrow repair keeps
 * the character-key grammar intact without rewriting general text.
 */
export function normalizeScenarioScript(script: string): string {
  return script.replace(/(#\d+)\s+(\$\d+)/g, "$1$2");
}

interface ScenarioLink {
  pos: { x: number; y: number };
  size: { x: number; y: number };
  array: { alias: string; name: string }[];
}

/**
 * Fill only missing `datas_link` groups from the canonical image keys already in
 * `datas_char`. This is intentionally generic: future upstream table races heal
 * without shipping another hard-coded character list.
 */
export function repairScenarioLinks(
  doc: Document,
  overrides: Record<string, ScenarioLinkOverride> = {}
): number {
  const charNode = doc.getElementById("datas_char");
  const linkNode = doc.getElementById("datas_link");
  if (!charNode || !linkNode) return 0;

  let links: Record<string, ScenarioLink>;
  try {
    links = JSON.parse(linkNode.textContent || "{}");
  } catch {
    return 0;
  }

  const grouped = new Map<string, { name: string; group: number; expression: number }[]>();
  for (const line of (charNode.textContent || "").split("\n")) {
    const name = line.split(",", 1)[0]?.trim().toLowerCase();
    if (!name) continue;
    // base$G or base-N$G. The optional expression suffix is the final `-digits`
    // only, so hyphens elsewhere in a character ID remain part of the base.
    const match = /^(.+?)(?:-(\d+))?\$(\d+)$/.exec(name);
    if (!match) continue;
    const base = match[1];
    const expression = Number(match[2] ?? 0);
    const group = Number(match[3]);
    const entries = grouped.get(base) ?? [];
    entries.push({ name, group, expression });
    grouped.set(base, entries);
  }

  let added = 0;
  for (const [base, entries] of grouped) {
    if (links[base]) continue;
    entries.sort((a, b) => {
      // The engine treats #1 as the first numbered expression. A rare unsuffixed
      // base$G entry is a fallback and belongs after base-N$G entries (matching
      // PRTS' maintained link tables), never before expression 1.
      const ae = a.expression === 0 ? Number.MAX_SAFE_INTEGER : a.expression;
      const be = b.expression === 0 ? Number.MAX_SAFE_INTEGER : b.expression;
      return a.group - b.group || ae - be || a.name.localeCompare(b.name);
    });
    const layout = overrides[base] ?? {
      pos: { x: 0, y: 160 },
      size: { x: 1024, y: 1024 },
    };
    links[base] = {
      pos: { ...layout.pos },
      size: { ...layout.size },
      array: entries.map(({ name }) => ({ alias: "", name })),
    };
    added++;
  }
  if (added > 0) {
    linkNode.textContent = JSON.stringify(links);
    pushLog("info", `[engine] repaired ${added} missing character link groups`);
  }
  return added;
}

/**
 * After boot, surface why the engine might be stuck on the loading screen:
 * whether engine globals initialized, and the engine's own captured error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reportBootHealth(iwin: any): void {
  try {
    // Probe what actually initialized, to distinguish causes:
    //  jQuery/createjs="undefined" -> external dep <script src> didn't load/run
    //  system/onload missing but deps present -> engine program failed
    pushLog(
      "info",
      "[boot] probe:",
      JSON.stringify({
        jQuery: typeof iwin.$,
        createjs: typeof iwin.createjs,
        Timer: typeof iwin.Timer,
        system: typeof iwin.system,
        onload: typeof iwin.onload,
        scripts: iwin.document?.scripts?.length,
        engineScripts: bundleScriptCount,
      })
    );
    if (typeof iwin.system === "undefined") {
      pushLog(
        "error",
        "[engine] window.system is undefined — an engine script failed to execute before defining it."
      );
      return;
    }
    const err = iwin.system?.error;
    if (err?.stat) {
      pushLog("error", `[engine] ${err.type || "error"}: ${err.info}`);
    }
    if (typeof iwin.fun_sys_preload !== "function") {
      pushLog("error", "[engine] fun_sys_preload not defined — engine init did not complete.");
    }
  } catch (e) {
    pushLog("warn", "reportBootHealth failed:", e);
  }
}

/** Fail the page boot instead of revealing a permanently frozen loading stage. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assertEngineReady(iwin: any, assetDomains: string[]): EngineHealth {
  const missing = [
    ["Timer", iwin.Timer],
    ["system", iwin.system],
    ["fun_sys_preload", iwin.fun_sys_preload],
    ["window.onload", iwin.onload],
  ].filter(([, value]) => typeof value === "undefined" || value === null)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`PRTS 引擎初始化不完整，缺少: ${missing.join(", ")}`);
  }
  return {
    globals: ["Timer", "system", "fun_sys_preload", "window.onload"],
    engineScriptCount: bundleScriptCount,
    assetDomains,
  };
}

/**
 * Hook the iframe's createjs.LoadQueue.prototype.loadFile to record URLs, run the
 * engine's fun_sys_preload() (which resolves the deduped asset set), then restore.
 * No network happens because queue.load() is never called.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function capturePreloadManifest(iwin: any): string[] {
  const captured: string[] = [];
  const proto = iwin.createjs?.LoadQueue?.prototype;
  if (!proto || typeof proto.loadFile !== "function") {
    console.warn("captureManifest: createjs.LoadQueue not available in iframe");
    return [];
  }
  const orig = proto.loadFile;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proto.loadFile = function (item: any) {
    const url = typeof item === "string" ? item : item?.src ?? item?.path;
    if (typeof url === "string") captured.push(url);
    // Do NOT call orig -> no queueing/loading.
  };
  try {
    if (typeof iwin.fun_sys_preload !== "function") {
      throw new Error("fun_sys_preload is not defined in iframe");
    }
    iwin.fun_sys_preload();
  } catch (e) {
    pushLog("error", "[engine] fun_sys_preload capture failed:", e);
    throw new Error(`PRTS 预加载执行失败: ${errorMessage(e)}`);
  } finally {
    proto.loadFile = orig;
  }
  return Array.from(new Set(captured));
}

/**
 * Compatibility fixes for verified upstream engine defects. This code is appended
 * to the same classic program as PRTS's scripts, so it can reach their top-level
 * lexical `scenario` binding without depending on it becoming a window property.
 *
 * Current PRTS charLink() adds a group's start offset twice for `$G`, and repeats
 * that mistake when `#N$G` is out of range. The resulting undefined array entry
 * makes charFormat() throw and aborts both playback and asset preloading. Resolve
 * grouped references deterministically and keep the engine's documented default-
 * character fallback for any other bad index.
 */
function engineCompatibilityPatch(): string {
  return `
;(() => {
  if (typeof scenario !== "object" || !scenario.extend || typeof scenario.extend.charLink !== "function") return;
  const originalCharLink = scenario.extend.charLink;
  const originalCharFormat = scenario.extend.charFormat;
  scenario.extend.charLink = function (value) {
    const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
    const grouped = raw.match(/^([^@#$]+)(?:#(\\d+))?\\$(\\d+)$/);
    if (grouped && typeof data === "object" && data.link) {
      const key = grouped[1];
      const entries = data.link[key] && data.link[key].array;
      if (Array.isArray(entries) && entries.length) {
        const suffix = "$" + grouped[3];
        const start = entries.findIndex((entry) => entry && typeof entry.name === "string" && entry.name.endsWith(suffix));
        if (start >= 0) {
          let end = entries.findIndex((entry, index) => index > start && (!entry || typeof entry.name !== "string" || !entry.name.endsWith(suffix)));
          if (end < 0) end = entries.length;
          const offset = grouped[2] ? Number(grouped[2]) - 1 : 0;
          return [key, offset >= 0 && start + offset < end ? start + offset : start];
        }
      }
    }
    const result = originalCharLink.call(this, value);
    if (Array.isArray(result) && result[0] !== -1 && typeof data === "object" && data.link) {
      const entries = data.link[result[0]] && data.link[result[0]].array;
      if (Array.isArray(entries) && entries.length && !entries[result[1]]) return [result[0], 0];
    }
    return result;
  };
  if (typeof originalCharFormat === "function") {
    scenario.extend.charFormat = function (key, index) {
      const entries = typeof data === "object" && data.link && data.link[key] && data.link[key].array;
      if (Array.isArray(entries) && entries.length && !entries[index]) return entries[0].name;
      return originalCharFormat.call(this, key, index);
    };
  }
})();`;
}

// ─── helpers (operate on the iframe's document/window) ──────────────────────

/**
 * Execute script code synchronously in the iframe's global realm. Tauri's CSP
 * explicitly permits unsafe-eval, and this path works on Chromium WebViews that
 * sometimes accept blob: script elements but then report only an opaque Event
 * without executing their source. A single blob remains the policy fallback.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runScriptCode(idoc: Document, iwin: any, code: string, sourceName?: string): Promise<void> {
  const name = sourceName || "engine script";
  const labelledCode = sourceName ? `${code}\n//# sourceURL=${sourceName}` : code;
  try {
    if (typeof iwin.eval !== "function") throw new EvalError("iframe eval is unavailable");
    iwin.eval(labelledCode);
    return;
  } catch (error) {
    // A real exception from the upstream code must not be retried: declarations
    // or event handlers may already have been installed. Only a CSP/eval-policy
    // rejection is safe to retry through an external classic script.
    const message = errorMessage(error);
    if (!/unsafe-eval|content security policy|refused to evaluate|eval is unavailable/i.test(message)) {
      pushLog("error", `[engine] ${name} threw:`, error);
      throw new Error(`${name} 执行失败: ${message}`);
    }
    pushLog("warn", `[engine] ${name}: eval unavailable, using blob fallback`, error);
  }

  await runBlobScript(idoc, iwin, code, name, sourceName);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function runBlobScript(idoc: Document, iwin: any, code: string, name: string, sourceName?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let url = "";
    const marker = `__prtsExec_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    try {
      const BlobCtor = iwin.Blob || Blob;
      const URLObj = iwin.URL || URL;
      const labelledCode = `${code}\n;window[${JSON.stringify(marker)}] = true;${sourceName ? `\n//# sourceURL=${sourceName}` : ""}`;
      url = URLObj.createObjectURL(new BlobCtor([labelledCode], { type: "application/javascript" }));
      const s = idoc.createElement("script");
      const finish = (error?: Error) => {
        URLObj.revokeObjectURL(url);
        try { delete iwin[marker]; } catch { /* disposable iframe realm */ }
        if (error) {
          pushLog("error", `[engine] ${error.message}`);
          reject(error);
        } else {
          resolve();
        }
      };
      s.src = url;
      s.onload = () => finish(iwin[marker] === true
        ? undefined
        : new Error(`${name} loaded but did not finish executing`));
      s.onerror = () => finish(new Error(`${name} failed to load`));
      idoc.body.appendChild(s);
    } catch (error) {
      if (url) {
        try { (iwin.URL || URL).revokeObjectURL(url); } catch { /* ignore */ }
      }
      const wrapped = new Error(`${name} blob fallback failed: ${errorMessage(error)}`);
      pushLog("error", "[engine]", wrapped);
      reject(wrapped);
    }
  });
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const shaped = error as { message?: unknown; name?: unknown };
    if (typeof shaped.message === "string" && shaped.message) {
      return `${typeof shaped.name === "string" ? `${shaped.name}: ` : ""}${shaped.message}`;
    }
  }
  return String(error);
}

/** Build the dynamic URL-rewrite shim source (patches the doc's Image/Audio/Source src). */
function buildShimCode(assetDomains: readonly string[]): string {
  return `
(function() {
  var PROXY_BASE = ${JSON.stringify(PROXY_BASE)};
  var CDN_DOMAINS = ${JSON.stringify(assetDomains)};
  function rewriteUrl(url) {
    if (typeof url !== 'string') return url;
    for (var i = 0; i < CDN_DOMAINS.length; i++) {
      var d = CDN_DOMAINS[i];
      var https = 'https://' + d + '/', http = 'http://' + d + '/';
      if (url.indexOf(https) === 0) return PROXY_BASE + '/' + d + '/' + url.substring(https.length);
      if (url.indexOf(http) === 0) return PROXY_BASE + '/' + d + '/' + url.substring(http.length);
    }
    return url;
  }
  function patch(proto) {
    var d = Object.getOwnPropertyDescriptor(proto, 'src');
    if (d && d.set) Object.defineProperty(proto, 'src', {
      get: function(){ return d.get.call(this); },
      set: function(v){ d.set.call(this, rewriteUrl(v)); },
      configurable: true, enumerable: true
    });
  }
  patch(HTMLImageElement.prototype);
  patch(HTMLMediaElement.prototype);
  patch(HTMLSourceElement.prototype);
  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if ((name === 'src' || name === 'href') && typeof value === 'string') value = rewriteUrl(value);
    return origSetAttr.call(this, name, value);
  };
  window.__prtsRewriteUrl = rewriteUrl;
})();`;
}

/**
 * Load the engine CSS as an inlined <style> whose url()s are rewritten to local
 * paths. The stylesheet references its assets with ABSOLUTE https://static.prts.wiki
 * URLs (the NotoSans font and the toolbar icons ui_playback/ui_playback_all/
 * ui_fullscreen/ui_bug_report.png). Loaded as a plain <link>, those absolute URLs
 * are NOT rewritten and get CSP-blocked (img-src/font-src) — which is exactly why
 * the LOG / LOG ALL buttons rendered as empty boxes. So we obtain the CSS *text*
 * and rewrite it before injecting:
 *   1. the engine-asset cache (rarely populated), then
 *   2. fetch through the offline-first prts-cdn proxy (the usual path — the CSS
 *      lives in the media store).
 * Only if both fail do we fall back to a proxied <link> (icons may then be blocked).
 */
async function loadCssInDoc(idoc: Document, localFontUrl: string): Promise<void> {
  let cssText: string | null = null;
  // Validated hot-updated cache first.
  if (!cssText) {
    try {
      cssText = await invoke<string | null>("read_asset_text", {
        category: "engine",
        filename: EXTERNALS.css.filename,
      });
    } catch {
      // fall through to proxy fetch
    }
  }
  // Final offline fallback shipped with the app.
  if (!cssText && EXTERNALS.css.bundled) {
    try {
      const r = await fetch(bundledUrl(EXTERNALS.css.bundled));
      if (r.ok) cssText = await r.text();
    } catch {
      // fall through
    }
  }
  if (!cssText) {
    try {
      const resp = await fetch(proxyUrl(EXTERNALS.css.url));
      if (resp.ok) cssText = await resp.text();
    } catch {
      // fall through to <link>
    }
  }
  if (cssText) {
    let patched = cssText.replace(
      /url\(['"]?https:\/\/static\.prts\.wiki\/assets\/scenario\/fonts\/NotoSans\.ttf['"]?\)/g,
      `url("${localFontUrl}")`
    );
    patched = rewriteAllCdnUrls(patched);
    const style = idoc.createElement("style");
    style.textContent = patched;
    idoc.head.appendChild(style);
    return;
  }
  const link = idoc.createElement("link");
  link.rel = "stylesheet";
  link.href = proxyUrl(EXTERNALS.css.url);
  idoc.head.appendChild(link);
}

/** Download the font if not cached, returning a local asset URL or proxy URL. */
async function ensureFontCached(): Promise<string> {
  // Bundled-in-app font first (no network, no cache).
  if (EXTERNALS.font.bundled) return bundledUrl(EXTERNALS.font.bundled);
  try {
    const existing = await invoke<string | null>("get_asset_path", {
      category: "engine",
      filename: EXTERNALS.font.filename,
    });
    if (existing) return convertFileSrc(existing);
    const localPath = await invoke<string>("download_asset", {
      url: EXTERNALS.font.url,
      category: "engine",
      filename: EXTERNALS.font.filename,
    });
    return convertFileSrc(localPath);
  } catch {
    return proxyUrl(EXTERNALS.font.url);
  }
}

/**
 * Resolve an engine dep (jQuery/PreloadJS/toolbox) to a local `asset://` URL,
 * downloading it through Rust (rustls) and caching it on first use.
 *
 * Why download via Rust instead of letting the WebView fetch it: jQuery lives on
 * `code.jquery.com`, which `proxyUrl` does NOT rewrite (only wiki CDNs are), so it
 * would be loaded straight by the WebView. That fails wherever the WebView can't
 * reach/secure that host — e.g. an emulator whose Chromium TLS is broken, or a
 * region where code.jquery.com is blocked/slow — which made EVERY manifest capture
 * throw "dep load failed: …jquery…", so indexing produced zero URLs and nothing
 * downloaded. Caching via Rust also makes deps work offline and load instantly from
 * disk on every subsequent iframe boot (a big speed-up for the parallel indexing).
 */
export async function resolveAssetUrl(ext: { url: string; filename: string; bundled?: string }): Promise<string> {
  // The startup refresh already validated this file; prefer it over the package.
  try {
    const localPath = await invoke<string | null>("get_asset_path", {
      category: "engine",
      filename: ext.filename,
    });
    if (localPath) return convertFileSrc(localPath);
  } catch {
    // fall through to download
  }
  // Final disaster-recovery copy when online refresh and disk rollback both fail.
  if (ext.bundled) return bundledUrl(ext.bundled);
  try {
    const localPath = await invoke<string>("download_asset", {
      url: ext.url,
      category: "engine",
      filename: ext.filename,
    });
    return convertFileSrc(localPath);
  } catch {
    // Last resort: a proxy URL (rewrites wiki CDNs; code.jquery.com stays raw and
    // may still fail, but at least wiki-hosted deps keep working).
    return proxyUrl(ext.url);
  }
}

/**
 * Pre-fetch+cache the engine deps needed for manifest capture ONCE, before the
 * parallel index pool spins up — so the concurrent iframe boots all load them from
 * disk instead of each racing to download the same files over the network.
 */
export async function prewarmEngineDeps(): Promise<void> {
  await refreshEngineDeps();
}

/** Append a <script src> to a document and resolve when it loads. */
function loadScriptInDoc(idoc: Document, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = idoc.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`dep load failed: ${src}`));
    idoc.body.appendChild(s);
  });
}

/** Process the MediaWiki Resource Loader Queue inside the iframe (runs document.ready). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function processRLQ(iwin: any): void {
  const rlq = iwin.RLQ;
  if (rlq && Array.isArray(rlq)) {
    for (const entry of rlq) {
      if (Array.isArray(entry) && entry[0] === "jquery" && typeof entry[1] === "function") {
        try {
          entry[1]();
        } catch (e) {
          pushLog("error", "[engine] RLQ/ready callback threw:", e);
        }
      }
    }
  }
}

/**
 * Bypass the engine's long-press gate. window.onload normally only wires the
 * preload to a 1s mouse/touch hold on #sys_clicker (the "为避免意外的数据消耗，
 * 剧情资源仅在长按1s后开始预载" screen) before calling system.preload.init().
 * Calling preload.start() ourselves runs queue.load() right away. We replicate the
 * engine's own guard from onload: it skips preload.init() entirely when the page is
 * disabled or a preload error occurred, so we must not auto-start in those cases.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function autoStartPreload(iwin: any): void {
  try {
    const sys = iwin.system;
    if (!sys || iwin.public_disabled || sys.disabled?.flag || sys.error?.stat) return;
    if (typeof sys.preload?.start === "function") sys.preload.start();
  } catch (e) {
    pushLog("warn", "auto preload start failed:", e);
  }
}

/**
 * Make the engine's fixed 960x540 stage fill the iframe/window, centered and
 * letterboxed, and keep it fitted on resize. The engine only rescales in real
 * browser fullscreen (fun_fullscreen, keyed off screen.width); in a normal
 * windowed webview #sys_main stays 960x540 with black margins around it. We
 * replicate the engine's own scale math (scale #sys_main, center via #sys_offset)
 * but drive it from the iframe's inner size, and defer to the engine when it is
 * actually fullscreen so the two don't fight.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installWindowedFit(iwin: any, idoc: Document): void {
  try {
    const fit = () => {
      try {
        // Real fullscreen is handled by the engine's own fun_fullscreen handler.
        if (typeof iwin.fun_fullscreen_check === "function" && iwin.fun_fullscreen_check()) return;
        const main = idoc.getElementById("sys_main");
        const offset = idoc.getElementById("sys_offset");
        if (!main || !offset) return;
        const w = iwin.innerWidth || idoc.documentElement.clientWidth;
        const h = iwin.innerHeight || idoc.documentElement.clientHeight;
        if (!w || !h) return;
        const s = Math.min(w / 960, h / 540);
        main.style.transform = `scale(${s})`; // transform-origin is already top-left
        offset.style.left = `${(w - 960 * s) / 2}px`;
        offset.style.top = `${(h - 540 * s) / 2}px`;
      } catch {
        // ignore — leave the stage at its base size
      }
    };
    iwin.addEventListener("resize", fit);
    // After leaving fullscreen the engine clears the transform; re-fit afterwards.
    const refit = () => setTimeout(fit, 0);
    iwin.addEventListener("fullscreenchange", refit);
    iwin.addEventListener("webkitfullscreenchange", refit);
    fit();
  } catch (e) {
    pushLog("warn", "windowed fit setup failed:", e);
  }
}

/** Trigger window.onload inside the iframe (engine inits the preload system here). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function triggerWindowOnload(iwin: any): void {
  const Ev = iwin.Event || Event;
  // Fire the window.onload PROPERTY handler EXACTLY ONCE. The engine's onload runs
  // `system.preload.init()`, which registers the preload "complete" listener that
  // binds the toolbar buttons (自动/重置/LOG/…). Firing onload twice (a direct call
  // AND a dispatched 'load' event, as it did before) ran preload.init() twice → two
  // "complete" listeners → every button bound twice → toggle buttons like 自动
  // engaged-then-disengaged on a single tap (looked like the tap was "swallowed").
  // Detach onload before dispatching so the event reaches only addEventListener
  // ('load') handlers, never the property handler a second time.
  const onload = iwin.onload;
  if (typeof onload === "function") {
    iwin.onload = null;
    try {
      onload.call(iwin, new Ev("load"));
    } catch (e) {
      pushLog("error", "[engine] window.onload threw:", e);
    }
  } else {
    pushLog("error", "[engine] window.onload is not a function after boot.");
  }
  try {
    iwin.dispatchEvent(new Ev("load"));
  } catch {
    // ignore
  }
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Replace a data table independent of tag name, class order, or quote style. */
function replaceDataBlock(html: string, id: string, text: string): string {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(
    `<([a-z][\\w:-]*)\\b(?=[^>]*\\bid=["']${escapedId}["'])[^>]*>[\\s\\S]*?<\\/\\1>`,
    "i"
  );
  const replacement = `<pre class="hidden" id="${escapeHtml(id)}">${escapeHtml(text)}</pre>`;
  if (!block.test(html)) throw new Error(`PRTS 数据快照缺少 #${id}`);
  return html.replace(block, replacement);
}
