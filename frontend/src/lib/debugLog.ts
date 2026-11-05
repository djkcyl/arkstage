/**
 * Lightweight in-app diagnostic log. The release build ships without DevTools by
 * default, and engine failures happen inside an isolated iframe whose console we
 * can't otherwise see — so errors there used to surface as a silent frozen loading
 * screen. This module captures errors from the main window AND the engine iframe
 * and exposes them to an on-screen overlay (DebugConsole) the user can read/screenshot.
 */

import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "log" | "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  time: number;
  level: LogLevel;
  msg: string;
}

const MAX_ENTRIES = 500;
const JOURNAL_KEY = "prts-diagnostic-journal-v1";
const CHECKPOINT_KEY = "prts-playback-checkpoint-v1";
interface PlaybackCheckpoint { title: string; stage: string; time: number }
function readStored(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
const saved = readStored(JOURNAL_KEY);
const entries: LogEntry[] = Array.isArray(saved) ? saved.filter((e): e is LogEntry => e && typeof e.time === "number"
  && typeof e.msg === "string" && ["log", "info", "warn", "error"].includes(e.level)).slice(-MAX_ENTRIES) : [];
const previous = readStored(CHECKPOINT_KEY) as PlaybackCheckpoint | null;
const lastPlayback = previous && typeof previous.title === "string" && typeof previous.stage === "string"
  && typeof previous.time === "number" ? previous : null;
// A missing JS teardown also happens on ordinary Android process stops. Only an
// explicitly recorded failure warrants a recovery alert; ready/preload are breadcrumbs.
let interrupted: PlaybackCheckpoint | null = lastPlayback && ["failed", "context-lost"].includes(lastPlayback.stage)
  ? lastPlayback : null;
const listeners = new Set<() => void>();
let seq = 0;
for (const entry of entries) entry.id = seq++;
let installed = false;

function persistEntries(): void {
  try {
    let json = JSON.stringify(entries);
    while (json.length > 128 * 1024 && entries.length > 1) { entries.shift(); json = JSON.stringify(entries); }
    localStorage.setItem(JOURNAL_KEY, json);
  } catch { /* Native journal remains available. */ }
}
function nativeLog(level: LogLevel, message: string): Promise<unknown> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return Promise.resolve();
  return invoke("record_diagnostic", { level, message });
}

export function getInterruptedPlayback(): PlaybackCheckpoint | null { return interrupted; }

/** Flush both JS and native journals before calling GPU/decoder code. */
export async function playbackCheckpoint(title: string, stage: string, detail = ""): Promise<void> {
  const checkpoint = { title, stage, time: Date.now() };
  try {
    if (["disposed", "cancelled"].includes(stage)) localStorage.removeItem(CHECKPOINT_KEY);
    else localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
  } catch { /* Continue with the native journal. */ }
  const message = `[playback] ${title} stage=${stage}${detail ? ` ${detail}` : ""}`;
  appendLog("info", [message], false);
  try { await nativeLog("info", message); }
  catch (error) { pushLog("warn", "原生日志写入失败:", error); }
}

function fmt(a: unknown): string {
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  if (typeof a === "string") return a;
  if (typeof a === "object" && a !== null) {
    // Errors created in the isolated engine iframe belong to another JS realm,
    // so `instanceof Error` is false in the parent window.  JSON.stringify also
    // drops Error's non-enumerable fields, reducing the only useful diagnostic to
    // `{}`.  Read the standard error-shaped fields explicitly before JSON.
    const errorLike = a as { name?: unknown; message?: unknown; stack?: unknown };
    if (typeof errorLike.stack === "string" && errorLike.stack) return errorLike.stack;
    if (typeof errorLike.message === "string" && errorLike.message) {
      return `${typeof errorLike.name === "string" ? `${errorLike.name}: ` : ""}${errorLike.message}`;
    }
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

function appendLog(level: LogLevel, args: unknown[], mirror: boolean): void {
  const entry = { id: seq++, time: Date.now(), level, msg: args.map(fmt).join(" ").slice(0, 16_384) };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  persistEntries();
  if (mirror) void nativeLog(level, entry.msg).catch(() => {});
  listeners.forEach((l) => l());
}

export function pushLog(level: LogLevel, ...args: unknown[]): void { appendLog(level, args, true); }

export function getEntries(): readonly LogEntry[] {
  return entries;
}

export function clearLog(): void {
  entries.length = 0;
  interrupted = null;
  persistEntries();
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Install capture on the MAIN window. Idempotent; call once at app start. */
export function installGlobalCapture(): void {
  if (installed) return;
  installed = true;

  if (interrupted) pushLog("warn", "[recovery] 上次播放曾记录错误:", interrupted);
  else if (lastPlayback) pushLog("info", "[session] 上次播放阶段（不代表异常退出）:", lastPlayback);
  try { localStorage.removeItem(CHECKPOINT_KEY); } catch { /* ignore */ }
  pushLog("info", "[session]", navigator.userAgent, `viewport=${innerWidth}x${innerHeight} dpr=${devicePixelRatio}`);

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...a: unknown[]) => {
    pushLog("error", ...a);
    origError(...a);
  };
  console.warn = (...a: unknown[]) => {
    pushLog("warn", ...a);
    origWarn(...a);
  };

  window.addEventListener("error", (e) => {
    if (e.error) pushLog("error", e.error);
    else pushLog("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener("unhandledrejection", (e) =>
    pushLog("error", "UnhandledRejection:", e.reason)
  );
}

/**
 * Attach capture to an engine IFRAME's window. Catches uncaught script errors,
 * failed resource loads (img/audio/source/script/link), promise rejections, and
 * console.error/warn happening inside the engine realm.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function captureIframe(iwin: any): void {
  try {
    // Capture phase catches resource-load errors (which don't bubble) AND script errors.
    iwin.addEventListener(
      "error",
      (e: ErrorEvent) => {
        const t = e.target as { tagName?: string; src?: string; href?: string } | null;
        const tag = t && typeof t.tagName === "string" ? t.tagName.toUpperCase() : "";
        if (["IMG", "AUDIO", "VIDEO", "SOURCE", "SCRIPT", "LINK"].includes(tag)) {
          pushLog("error", "[engine] resource load failed:", t?.src || t?.href || tag);
        } else if (e.error) {
          const location = e.filename
            ? `@ ${e.filename}:${e.lineno}:${e.colno}`
            : "";
          pushLog("error", "[engine]", e.error, location);
        } else if (e.message) {
          pushLog("error", `[engine] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
        }
      },
      true
    );
    iwin.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) =>
      pushLog("error", "[engine] rejection:", e.reason)
    );
    // CSP violations don't fire 'error' — catch them explicitly, as a signal that a
    // real resource (img/font/external script) is being blocked by policy.
    // EXCEPTION: inline-script blocks are EXPECTED and not actionable — our CSP
    // intentionally forbids inline scripts (engine code runs via blob: URLs), and
    // libraries such as jQuery still attempt the occasional inline eval. Logging
    // those produced a scary "CSP blocked script-src-elem: inline" on every boot,
    // so we suppress that specific (by-design) case and surface everything else.
    iwin.addEventListener("securitypolicyviolation", (e: SecurityPolicyViolationEvent) => {
      const directive = e.effectiveDirective || e.violatedDirective || "";
      const isInlineScript =
        directive.startsWith("script-src") && (!e.blockedURI || e.blockedURI === "inline");
      if (isInlineScript) return;
      pushLog(
        "error",
        `[engine] CSP blocked ${e.violatedDirective}: ${e.blockedURI || e.sourceFile || "(inline)"}`
      );
    });

    const ic = iwin.console;
    if (ic) {
      const oe = ic.error?.bind(ic);
      const ow = ic.warn?.bind(ic);
      ic.error = (...a: unknown[]) => {
        pushLog("error", "[engine]", ...a);
        oe?.(...a);
      };
      ic.warn = (...a: unknown[]) => {
        pushLog("warn", "[engine]", ...a);
        ow?.(...a);
      };
    }
  } catch (err) {
    pushLog("warn", "captureIframe failed:", err);
  }
}
