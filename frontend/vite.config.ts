import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// 通过 `vite frontend`（从仓库根运行）把 Vite root 设到本目录，故 config /
// index.html / src / public 都从这里解析。
export default defineConfig({
  plugins: [react()],
  // 对齐 Tauri 的 devUrl（src-tauri/tauri.conf.json），使 `tauri dev` 能连上。
  server: { port: 5174, strictPort: true },
  build: {
    // 相对 Vite root（frontend/）解析 → 仓库根的 build/dist。
    outDir: '../build/dist',
    emptyOutDir: true,
  },
})
