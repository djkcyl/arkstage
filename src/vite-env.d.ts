/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Build-time default for the on-screen debug console. Set to "true" by the
   * release/CI workflows and the local build scripts so those builds ship with
   * diagnostics visible; unset (→ off) for ordinary `npm run tauri:build`.
   */
  readonly VITE_DEBUG_DEFAULT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
