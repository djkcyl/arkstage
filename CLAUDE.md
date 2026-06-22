# Arkstage（方舟剧场）

Tauri + React 的明日方舟剧情离线阅读器（Android + 桌面）。前端在 `frontend/`，Rust 后端在 `src-tauri/`，构建产物在 `build/`。

## 架构要点

- **数据来源：prts.wiki 直连**。没有镜像/CDN 中间层——媒体资源在下载时直接从 prts.wiki 抓取（仅受用户在设置里配置的全局下载并发/限速约束，`src-tauri/src/download.rs` + `media::prts_url`）。
- **剧情索引内置 + 可增量更新**。索引随软件打包（`frontend/src/data/story-index.json`，作为离线基线，首次启动即时可用），可通过拉取 prts 的「剧情一览」刷新（`fetch_story_index` 解析 HTML → 缓存）；离线时刷新失败则保留内置/缓存索引（`frontend/src/hooks/useStoryIndex.ts`）。
- **下载流程**：前端在 WebView 里启动 ScenarioSimulator 引擎抓取单个剧情的资源清单（manifest），缓存到 `manifest_<title>`（支持后台不中断下载 / 断点续传），再由 Rust 从 prts 拉取媒体。
- **书架 UI**（电子书式）：`StoryBrowserPage` + `CoverCard`/`ChapterDetail`，封面用基于标题哈希的程序化渐变（`frontend/src/lib/cover.ts`，无外部封面图）。
- **Android**：锁定横屏 + 沉浸式全屏（隐藏系统栏），见 `src-tauri/gen/android/.../MainActivity.kt` + `AndroidManifest.xml`。

> 历史：曾做过一套 jsDelivr/GitHub 资源镜像（v2），已于 2026-06-22 整体移除，回到 prts 直连 + 内置索引。跨会话记忆见 `~/.claude/.../memory/`（索引 `MEMORY.md`）。
