# PRTS 剧情阅读器 — 基础功能落地 + 离线化 设计文档

- 日期: 2026-06-05
- 状态: 已确认设计，待落实施计划
- 作者: djkcyl + Claude

## 1. 目标

1. 让 prts.wiki 的原版剧情播放器（ScenarioSimulator 引擎）在当前开发环境真正构建、启动并端到端播放（画面 + 立绘 + 音频）。
2. 实现真离线：在不限量网络（WiFi）下预下载**选定范围**的剧情资源，之后在无网/计费网络环境下**零联网**播放。
3. 资源去重复用：跨章节共享的立绘/音乐/背景只下载与存储一份。

## 2. 非目标（本期不做）

- 不自研渲染器，继续运行 prts.wiki 原版引擎。
- 不把任何资源/数据库快照打包进应用二进制（避免包体膨胀，沙箱系统空间浪费；首次下载本就在非计费网络，死资源随包分发意义不大）。
- 不做剧情内文本搜索/书签/进度同步等增值功能。
- 不逆向重写引擎的剧本语法解析。

## 3. 关键机制（方案基石）

引擎内联脚本中的 `fun_sys_preload()`：遍历已解析的剧本 `data.txt`，对每条命令解析出资源 URL，放入一个**去重的 `assets` Set**，再逐个 `queue.loadFile(asset, false)`。真正的网络请求只发生在之后的 `queue.load()`（用户长按 1s 触发）。

推论：`fun_sys_preload()` 本质是一个**不联网的、精确的、已去重的资源清单解析器**。只要 hook 住 `queue.loadFile`（或 PreloadJS `LoadQueue.prototype.loadFile`），即可拿到某剧情精确的资源 URL 列表，无需自己逆向剧本语法。

资源 URL 形如 `https://media.prts.wiki/1/10/Avg_071_mini01.png`。`media.prts.wiki` 是 MediaWiki 文件库，路径由文件内容哈希派生 → **相同内容恒为相同 URL/路径** → 按路径存储天然去重，且与 prts.wiki 自身存储方式一致。

涉及的 CDN 域名：`static.prts.wiki`（引擎/CSS/字体）、`media.prts.wiki`（图片）、`torappu.prts.wiki`（音频 `/assets/`）。

## 4. 已确认的设计决策

- **D1 清单机制 = 复用引擎 hook**：隔离上下文中启动引擎、覆盖 `queue.loadFile` 捕获 `fun_sys_preload` 解析出的 assets 集。永远与官方解析一致，随官方更新自动正确。
- **D2 全局基础层 = 首次联网拉取 + 缓存**（不内置二进制）：引擎依赖与全局数据库一次性获取并落盘，之后离线；提供「更新全局数据」以应对游戏更新。

## 5. 目标架构

### Layer A — 全局基础层（一次性联网获取，之后离线）

始终需要、与具体剧情无关的"播放器外壳"，一次性下载并缓存到 `$APPDATA`：

- 引擎依赖文件：`jquery.min.js`、`preloadjs.min.js`、`krliov.toolbox.js`、`arknights-scenario.css`、`NotoSans.ttf` → `download_asset` 落到 `engine/`（命令已存在）。
- Widget bundle：DOM 结构 + 引擎内联脚本 + **全局数据库**（`datas_back/char/audio/link/override`，全游戏共用，约 1.8MB）→ `fetch_widget_bundle` 缓存（命令已存在，key `widget-bundle-v2`）。
- 由一个「初始化 / 预缓存引擎」步骤完成（沿用 Settings 现有按钮，建议首次进入时引导）。
- 播放器一律 **offline-first**：优先读本地缓存，缺失才联网。
- 「更新全局数据」按钮：联网重新抓取 widget bundle 与引擎依赖，刷新快照。

### Layer B — 媒体资源层（按范围预下载，内容寻址去重）

运行时由引擎动态请求的背景图/立绘/音频/视频：

- **内容寻址仓库** `$APPDATA/media/{host}/{path}`，镜像 CDN 路径结构。
- **`prts-cdn://` 协议改造为离线优先**：解析出 `{host}/{path}` 后，先查 `media/{host}/{path}`，命中即从磁盘返回（离线）；未命中且当前允许联网时，拉取并落盘后返回（穿透回退）；未命中且不允许联网则返回 404/占位。
- 去重：同一 URL → 同一路径 → 只存一份，跨剧情自动复用。

### 预下载流程

1. 用户在浏览器页选择范围：单剧情 / 章节 / 分类 / 全部。
2. 对范围内每个剧情：
   a. 确保其剧本（`datas_txt`）已抓取并缓存（小体积 HTML 抓取）。
   b. **清单捕获**：在隔离上下文启动引擎（注入 Layer A 的全局数据库 + 该剧情脚本，使用**原始 https URL、不做 CDN 改写**），覆盖 `queue.loadFile` 收集 URL，调用 `fun_sys_preload()`，得到该剧情去重 URL 集；不调用 `queue.load()`，全程不联网媒体。
3. 合并范围内所有清单并全局去重 → 得到待下载 URL 并集。
4. Rust 批量下载并集中**缺失**项（已存在跳过）到内容寻址仓库，带进度回报；对源站友好（带 `Referer: https://prts.wiki/`、限制并发、失败重试）。

## 6. 组件与接口

### Rust 后端

- `media` 存储模块（新增）
  - `media_dir(app) -> PathBuf`：`$APPDATA/media`。
  - 复用 `lib.rs` 的 `prts-cdn://` handler：改为先查 `media/{host}/{path}`，命中读盘返回；未命中走现有 reqwest 拉取，**成功后写入** `media/{host}/{path}` 再返回。
- `batch_download_assets`（改造现有死代码命令）
  - 输入：`Vec<{ url }>`（host/path 由 url 推导，不再要 category/filename）。
  - 落盘到 `media/{host}/{path}`，已存在跳过，返回 `{ total, success, failed, skipped }`。
  - 带 `Referer` 头、并发上限（如 4~8）、对失败项记录。
  - 后续可加 `tauri` 事件做进度流（`download-progress`）。
- 保留：`fetch_widget_bundle` / `fetch_story_page` / `fetch_story_index` / `download_asset` / `read_asset_text` / `get_asset_path` / cache 系列。
- 清理：`fetch_asset_databases` 与 `parser/asset_database.rs`（确认前端无引用后删除）；`wiki.rs` 中 `#[allow(dead_code)]` 的 API 函数保留或删除（择一）。

### 前端

- `engineBoot.ts`（新增，从 `StoryPlayerPage` 抽出可复用的引擎启动逻辑）
  - `bootEngine({ container, script, mode, rewriteCdn })`：完成注入 DOM、shim、加载依赖、跑引擎脚本、触发 onload。
  - `mode: "play"`：正常播放（CDN 改写为 `prts-cdn://`）。
  - `mode: "manifest"`：注入**原始 https** 数据块，覆盖 `queue.loadFile` 收集 URL，调用 `fun_sys_preload()`，返回 `string[]`；隐藏容器、不渲染、用后即拆。
- `StoryPlayerPage.tsx`：改用 `engineBoot`，依赖一律 offline-first。
- 预下载 UI（浏览器页/设置页）：范围选择、触发 `captureManifest` 循环 + `batch_download_assets`、进度与去重统计展示。
- 修 `list_cached_stories` 路径 bug（见 §7）。

## 7. 缺陷修复

- **缓存"已缓存"标记失效**：剧本以 key `stories/标题` 保存，`sanitize_filename` 把 `/`→`_`，实际平铺成 `cache/stories_标题.json`；而 `list_cached_stories`/`get_cache_status` 从不存在的 `cache/stories/` 子目录列举，恒空。
  - 修法（择一，实施计划中定）：保存时真正建 `stories/` 子目录（key 内 `/` 保留为目录分隔）；或列举改为扫描 `cache/stories_*.json` 前缀。需保证保存与列举两侧一致，前端 `isCached` 的 key 规则（`stories_标题`）也要对齐。

## 8. 验证策略

- Phase 0：`cargo build` 成功；经现有 X server（`DISPLAY=:1024` 等）或 `xvfb-run` 启动；截图确认某剧情真的出画面/立绘；实测 Linux WebView 能解码播放 mp3/ogg 音频。
- Phase 2：预下载一个剧情后，**断网/屏蔽出站**再播放，确认画面+立绘+音频全部来自本地，无任何出站请求。
- 去重：下载相邻两个共享立绘的章节，确认共享文件只存一份、第二次批量下载大量"skipped"。

## 9. 实施阶段

- **Phase 0 — 构建与运行**：`cargo build`、启动、截图端到端验证（含音频）；修 §7 缓存 bug。
- **Phase 1 — 全局基础层 offline-first**：抽出 `engineBoot`；播放器与依赖一律优先本地缓存；「初始化/更新全局数据」流程完善。
- **Phase 2 — 媒体仓库 + 离线优先协议**：内容寻址存储；`prts-cdn://` 先本地后网络并落盘；改造 `batch_download_assets`。
- **Phase 3 — 单剧情清单捕获**：`engineBoot` 的 `manifest` 模式；"预下载本剧情资源"按钮跑通；验证不联网即可解析清单。
- **Phase 4 — 范围选择 + 批量预下载**：范围 UI、合并去重、批量下载、进度。
- **Phase 5 — 离线端到端验证**：断网模拟下完整播放已预下载剧情。

## 10. 风险与缓解

- 隔离上下文 headless 跑引擎 `fun_sys_preload` 可能因 DOM 依赖踩坑 → Phase 3 重点验证；必要时用隐藏 iframe 强隔离全局变量。
- 全局数据库随游戏更新变旧、新剧情缺 key →「更新全局数据」按钮联网刷新。
- Linux WebView 音频编解码（mp3/ogg）支持不确定 → Phase 0 实测，缺则记录为已知限制。
- 批量下载对源站压力 → 带 `Referer`、限并发与速率、失败重试，避免被封。

## 11. 待实施计划阶段细化的开放点

- `prts-cdn://` "是否允许联网"开关如何暴露（全局设置 / 计费网络检测 / 纯手动）。
- 进度回报用 Tauri 事件流还是轮询。
- 缓存 bug 两种修法的取舍与对历史缓存的兼容。
