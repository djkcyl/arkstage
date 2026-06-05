import { isAndroid } from "./platform";

/**
 * Android hardware-back handling.
 *
 * Tauri's Android WebView maps the hardware/gesture back to the standard
 * `window.history` (a `popstate`), and when history is empty it lets the OS
 * close the activity. We rely on react-router's BrowserRouter history so the
 * default behaviour is already "go to previous route, exit on home". This hook
 * adds the one missing nicety: a confirm-to-exit guard on the home route so a
 * stray back-gesture on the landing screen doesn't kill the app unexpectedly.
 *
 * It is a no-op on non-Android platforms.
 */
export function installAndroidBack(): () => void {
  if (!isAndroid()) return () => {};

  // Seed one extra history entry so the first back on "/" hits our guard
  // instead of immediately exiting.
  const seedGuard = () => {
    if (window.location.pathname === "/") {
      window.history.pushState({ prtsHomeGuard: true }, "");
    }
  };
  seedGuard();

  const onPop = (e: PopStateEvent) => {
    // On home: re-seed the guard and ask before exiting.
    if (window.location.pathname === "/") {
      const exit = window.confirm("退出 PRTS 剧情阅读器？");
      if (!exit) {
        window.history.pushState({ prtsHomeGuard: true }, "");
      } else {
        // Pop past our seeded entry → empty history → OS closes the activity.
        window.history.back();
      }
    }
    void e;
  };

  window.addEventListener("popstate", onPop);
  return () => window.removeEventListener("popstate", onPop);
}
