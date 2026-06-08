/**
 * Lightweight in-app diagnostic log. The release build ships without DevTools by
 * default, and engine failures happen inside an isolated iframe whose console we
 * can't otherwise see — so errors there used to surface as a silent frozen loading
 * screen. This module captures errors from the main window AND the engine iframe
 * and exposes them to an on-screen overlay (DebugConsole) the user can read/screenshot.
 */

export type LogLevel = "log" | "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  time: number;
  level: LogLevel;
  msg: string;
}

const MAX_ENTRIES = 500;
const entries: LogEntry[] = [];
const listeners = new Set<() => void>();
let seq = 0;
let installed = false;

function fmt(a: unknown): string {
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  if (typeof a === "string") return a;
  if (typeof a === "object" && a !== null) {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

export function pushLog(level: LogLevel, ...args: unknown[]): void {
  entries.push({ id: seq++, time: Date.now(), level, msg: args.map(fmt).join(" ") });
  if (entries.length > MAX_ENTRIES) entries.shift();
  listeners.forEach((l) => l());
}

export function getEntries(): readonly LogEntry[] {
  return entries;
}

export function clearLog(): void {
  entries.length = 0;
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
      (e: ErrorEvent & { target?: any }) => {
        const t = e.target;
        const tag = t && typeof t.tagName === "string" ? t.tagName.toUpperCase() : "";
        if (["IMG", "AUDIO", "VIDEO", "SOURCE", "SCRIPT", "LINK"].includes(tag)) {
          pushLog("error", "[engine] resource load failed:", t.src || t.href || tag);
        } else if (e.error) {
          pushLog("error", "[engine]", e.error);
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
