# Arkstage（方舟剧场）

Tauri + React 的明日方舟剧情离线阅读器（Android + 桌面）。前端在 `frontend/`，Rust 后端在 `src-tauri/`，构建产物在 `build/`。

## 架构要点

- **数据来源：prts.wiki 直连**。没有镜像/CDN 中间层——媒体资源在下载时直接从 prts.wiki 抓取（仅受用户在设置里配置的全局下载并发/限速约束，`src-tauri/src/download.rs` + `media::prts_url`）。
- **剧情索引运行时拉取（不再内置）**。首次启动从 prts「剧情一览」拉取（`fetch_story_index` 解析 HTML），缓存到 `cache/story-index.json`；之后缓存优先 + 后台刷新（`frontend/src/hooks/useStoryIndex.ts`）。首启需联网。StoryLine 篇章划分（`frontend/src/data/storylines.json`，由 `tools/gen-index/gen-storylines.mjs` 拉 prts 曲谱生成）仍内置，运行时 `regroupStoryIndex` 套用到拉取的索引。
- **下载流程**：前端在 WebView 里启动 ScenarioSimulator 引擎抓取单个剧情的资源清单（manifest），缓存到 `manifest_<title>`（支持后台不中断下载 / 断点续传），再由 Rust 从 prts 拉取媒体。引擎（jQuery/PreloadJS/toolbox/scenario.css/NotoSans）**内置于软件包** `frontend/public/vendor/`（`EXTERNALS.bundled` → `engineBoot.ts`），不下载、不可清除；`清除所有缓存`只清剧情媒体+索引。书架多选为长按呼出（隐藏复选框 + 分类复选框），缓存状态用圆点（卡片：黄=部分/绿=全部；章节行：灰未缓存/黄已缓存/绿已读）。
- **书架 UI**（电子书式）：`StoryBrowserPage` + `CoverCard`/`ChapterDetail`。封面三档：① 游戏内 StoryLine「曲谱/乐章」原图（`mixstory` kv：主线 EP 方形 432²、活动宽幅 ~632×456，`kv-map.json` + `extract-mixstory-kv.mjs`）；② 无 kv 的 联动 + 集成战略/生息演算 用 prts 活动导引图/头图横幅（`activity-banner-covers.json` + `extract-banner-covers.mjs`）；③ 都没有的（特殊/四月辑录）用软件 logo 占位（`coverFallback`，已去掉旧的彩色渐变）。全部打包到 `frontend/src/assets/covers/*.webp` + `cover-dims.json`。导航：主页→书架→章节→阅读器，逐级返回（章节抽屉用 `?cat=&book=` 进 history）。安卓硬件/手势返回由 `MainActivity` 自己处理（`handleBackNavigation=false` 关掉 Wry 自带的 `WebView.goBack()`——它无视 SPA 的 pushState 历史，会一次返回直接退出/需双滑；改为拦截后驱动前端 JS `history.back()`，根路由 `/` 才退出）。多选为长按呼出。
- **Android**：见 `src-tauri/gen/android/.../MainActivity.kt` + `AndroidManifest.xml`。**仅播放器** 锁横屏（`set_orientation`）+ 沉浸式隐藏状态+导航栏（`set_immersive`→`MainActivity.setReaderImmersive`，前端 `immersive.ts` 在 `StoryPlayerPage` 进/出时切换），避免系统栏遮挡演出；**其余页面保留系统栏**（否则顶部空 + 侧滑返回会被 transient-immersive 吃掉首个手势→需滑两次，曾踩坑）。返回由 `MainActivity` 拦截后驱动前端 JS `history.back()`（`handleBackNavigation=false` + `enableOnBackInvokedCallback=true`），根路由 `/` 才退出。`--safe-top=env(safe-area-inset-top)` 仅在顶层容器加一次：`.browser-page` 已含顶 inset，其内 `.detail-hero`/`.hero-back` **不再重复加**（曾因重复计算把返回按钮压到分类文字上）。

> 历史：曾做过一套 jsDelivr/GitHub 资源镜像（v2），已于 2026-06-22 整体移除，回到 prts 直连 + 内置索引。跨会话记忆见 `~/.claude/.../memory/`（索引 `MEMORY.md`）。
