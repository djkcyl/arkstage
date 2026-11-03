import { useSyncExternalStore } from "react";

export interface LoadingProgress {
  phase: "check" | "engine" | "data" | "art" | "initialize";
  message: string;
  done?: number;
  total?: number;
  bytes?: number;
}
let current: LoadingProgress = { phase: "check", message: "正在检查剧情与引擎更新…" };
const listeners = new Set<() => void>();
export function reportLoading(progress: LoadingProgress): void {
  current = progress;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useLoadingProgress(): LoadingProgress {
  return useSyncExternalStore(subscribe, () => current);
}
