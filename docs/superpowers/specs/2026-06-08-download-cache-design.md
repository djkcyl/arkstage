# 下载与缓存管理重构 — 设计文档

日期：2026-06-08 · 分支：`refactor/download-cache`

## 1. 背景与问题

`prts-reader` 是一个 Arknights 剧情离线阅读器：从 prts.wiki CDN 抓取剧情脚本、引擎
widget bundle、立绘/音频等资源，落盘到 `cache/`(JSON)、`assets/`(引擎外部依赖)、
`media/`(内容寻址媒体库)。当前下载子系统缺少基础能力，且存在一个明确的行为 bug。

### 1.1 现状（排查结论）

出网调用**没有单一收口**，散落在三处，且各自 `reqwest::Client::new()`：

| 位置 | 作用 | 是否检查离线开关 |
|---|---|---|
| `src-tauri/src/commands/wiki.rs` `fetch_page_raw` | 抓 story-index / story-page / widget-bundle | ❌ 否 |
| `src-tauri/src/commands/assets.rs` `download_asset` | 引擎外部依赖(jquery/css/font) | ❌ 否 |
| `src-tauri/src/commands/assets.rs` `batch_download_assets` | 批量预下载媒体(顺序阻塞循环) | ❌ 否 |
| `src-tauri/src/lib.rs` `prts-cdn://` handler | 播放器内按需取媒体 | ✅ 是(唯一) |

离线开关 `net_state::ALLOW_ONLINE`(`set/get_allow_online`)**只被 `prts-cdn://`
handler 读取**。

### 1.2 要解决的问题

1. **关闭联网后仍能下载（bug）**：预下载/引擎预缓存/目录抓取全部绕过 `allow_online()`。
2. **无法暂停/恢复**：`batch_download_assets` 是一次性顺序循环。
3. **无进度**：只在全部结束后返回 `{total,success,failed,skipped}` 计数。
4. **无限速**：无任何带宽控制。
5. **无并发控制**：逐个串行，慢；同时也无上限保护。

## 2. 设计目标

- 把所有出网收口到一个 `net` facade，**统一离线 gate + 共享 client + 全局限速**。
- 用一个 **DownloadManager** 取代 `batch_download_assets`：job 模型，支持并发上限、
  暂停/恢复、取消、按文件进度事件、限速。
- 前端展示进度条 / 速度 / 暂停·取消，设置页可配并发数与限速。
- 保持桌面与 Android 行为一致；离线时**真正离线**（只读缓存，零出网）。

## 3. 架构

### 3.1 `net` 模块（新增 `src-tauri/src/net/mod.rs`，并入 `net_state`）

```
net::client() -> &'static reqwest::Client        // 共享单例(从 lib.rs 上移，统一 UA)
net::allow_online() -> bool                       // 原 net_state
net::ensure_online() -> Result<(), NetError>      // 离线 gate：离线时返回 Offline
net::fetch(url, headers) -> Result<Bytes>         // 先 ensure_online，再共享 client GET
net::RateLimiter                                  // 全局令牌桶(bytes/sec)，0=不限
```

所有下载路径改为经 `net::fetch` / 显式 `ensure_online()`：
- `wiki.rs` 三个抓取 → 先 `ensure_online()`，离线返回明确错误（前端提示“已离线”）。
- `download_asset` → 经 `net::fetch`。
- `batch_download_assets` → 由 DownloadManager 取代。
- `prts-cdn://` handler → 维持现有 gate；其网络分支改用 `net::client()` 并接入限速。

### 3.2 DownloadManager（新增 `src-tauri/src/download/mod.rs`）

```
struct Job {
  id: u64,
  status: Queued|Running|Paused|Completed|Cancelled|Failed,
  total/done/success/failed/skipped: u32,
  bytes: u64, started_at, bytes_per_sec: u64,
}
struct Manager {                         // 放入 tauri::State，全局唯一
  jobs: Mutex<HashMap<u64, JobShared>>,
  semaphore: Semaphore,                  // 并发上限(可配)
  rate: RateLimiter,                     // 全局限速(可配)
}
```

- **并发**：`tokio::sync::Semaphore`，许可数 = 配置的并发上限（默认见 §5）。
- **暂停/恢复**：每个 job 一个 `AtomicBool paused` + `tokio::sync::Notify`；worker 在
  取下一个 item 前 await 暂停门（in-flight 的请求自然完成）。
- **取消**：`AtomicBool cancelled`；worker 检测后停止派发并标记 `Cancelled`。
- **进度**：worker 完成每个 item 后更新计数，通过 `AppHandle.emit("download://progress",
  JobStatus)` 推送；节流（≥150ms 或每完成 N 个）以免风暴。
- **限速**：流式读取 body，按全局令牌桶消费字节配额；超额则 `sleep`。
- **去重/跳过**：沿用 `media::store_path` 命中即 `skipped`（跨剧情去重）。

命令（`#[tauri::command]`）：
```
download_start(urls: Vec<String>) -> u64           // 返回 job_id，立即开始
download_pause(job_id) / download_resume(job_id)
download_cancel(job_id)
download_status(job_id) -> Option<JobStatus>
download_settings_get() -> {concurrency, rate_limit_bps}
download_settings_set({concurrency, rate_limit_bps})
```

### 3.3 前端

- `frontend/src/lib/predownload.ts`：`predownloadScope` 的下载阶段改为
  `download_start` + 监听 `download://progress` 事件；返回一个可暂停/取消的句柄。
- `frontend/src/pages/StoryBrowserPage.tsx`：进度区显示 done/total、速度、暂停/恢复/取消按钮。
- `frontend/src/pages/SettingsPage.tsx`：新增“并发数”“限速”设置；离线开关保持，但其语义
  现在真正全局生效。

## 4. 离线语义

关网（`allow_online=false`）后：
- ✅ 已缓存资源照常读取/播放（`load_from_cache` / `media::read_local`）。
- ❌ 任何**出网**一律拒绝：预下载、引擎预缓存、目录/剧情抓取、播放器内未命中媒体。
- 前端对“离线 + 未缓存”给出明确提示，不再静默下载。

## 5. 需用户审阅的决策（实现时取默认值，最后提交确认）

| # | 决策 | 暂定默认 | 备注 |
|---|---|---|---|
| D1 | 离线时是否连剧情文本/目录这类小元数据也禁止 | **是，全禁**（真飞行模式） | 最贴合“关网=不下载”的字面诉求 |
| D2 | 默认并发数 | **4** | 平衡速度与 CDN 友好 |
| D3 | 默认限速 | **0 = 不限速** | 用户可在设置中设上限 |
| D4 | 缓存淘汰策略 | **暂不自动淘汰**，仅保留手动“清除缓存” + 显示用量 | 自动 LRU/容量上限属产品决策，单列后续 |
| D5 | 是否保留旧 `batch_download_assets` 命令 | **移除**，由 download_start 取代 | 无外部消费者 |

## 6. 实施阶段

0. 分支 + 本设计文档。
1. `net` 模块：共享 client + `ensure_online` + 限速器；wiki/assets/prts-cdn 接入离线 gate（修 bug）。
2. DownloadManager 核心 + 命令；移除 `batch_download_assets`。单元测试（令牌桶、暂停/取消状态机、跳过去重）。
3. 前端接线：事件监听、进度/速度 UI、暂停·取消按钮；设置页并发/限速。
4. 设置页离线开关语义校验；离线 E2E 烟测（关网→预下载应被拒）。
5. 自测：`cargo test`、`scripts/test-static.sh`；提交；整理 D1–D5 审阅清单。

## 7. 验证

- Rust 单元测试覆盖：令牌桶速率、暂停后不再派发、取消后停止、离线 gate 拒绝。
- `scripts/test-static.sh` 全过（tsc + vite build + cargo test/build）。
- 手动/E2E：关网后点预下载 → 被拒且有提示；开网预下载 → 有进度+速度，可暂停/恢复/取消。
