# 开发与构建（开发者文档）

面向贡献者 / 自行构建的开发者。普通使用说明见仓库根的 [`README.md`](../README.md)。

## 🧩 工作原理（简述）

```
prts.wiki ──HTTP──▶ Rust 后端 ──invoke──▶ React 前端 ──注入 iframe──▶ 原版引擎运行
                       │                                                  │
resources@GitHub ─jsDelivr/GitHub Raw─▶ 书架元数据/封面    图片经 prts-cdn://「先本地后网络」
                       └──────────────── 本地缓存 (APPDATA) ───────────────┘
```

- **Rust 后端**抓取并解析剧情目录与剧本，管理缓存，并提供自定义 `prts-cdn://` 协议：所有上游请求统一经 `net::client()` 发送，使用可识别且含项目联系地址的 `Arkstage/<version>` User-Agent；命中本地的内容寻址仓库（`$APPDATA/media/{host}/{path}`）即离线返回，未命中时（且允许联网）带正确 Referer 拉取并落盘。PRTS 会拒绝伪装成通用浏览器的自动请求，因此不要把共享 User-Agent 改回 Chrome/Firefox 字符串。
- **前端**在隔离的 `<iframe>` realm 中启动原版引擎。新版页面动态发现带哈希的 ESM 入口、递归缓存模块依赖，并复用引擎自身的资源收集器生成预下载清单；旧版页面保留 `fun_sys_preload()` 路径。
- **书架资源**不进入安装包：`BookshelfMetadataContext` 先读 `cache/bookshelf-metadata.json`，每次启动再以 `cache: no-store` 刷新 jsDelivr；网络或格式失败则自动改走 `raw.githubusercontent.com`。只有通过完整校验的响应才会覆盖内存和缓存；双线路都失败时保留旧缓存并显示可重试提示。封面/横幅同样在首选源加载失败后切换另一源，使用哈希文件名并经 `prts-cdn://` 懒加载到内容寻址缓存，因此离线可复用，更新分类或封面无需发版。
- **PRTS 演出运行时**使用同页原子快照：从同一个响应提取剧情脚本与模块入口，校验并通过隔离启动测试后写入 `story-runtime-v6`，保留上一代快照供失败回滚。`engineModule.ts` 使用 Acorn 按语法结构发现播放器、上下文和预加载 API，不固定上游哈希文件名或压缩变量名；删除入口中的外置 Vue UI 挂载，只桥接演出引擎。无哈希的角色、背景和变量 JSON 每次启动刷新，离线或无效响应回退本地缓存；模块和数据指纹一同决定清单是否失效。Pixi 使用当前 iframe 的资源加载器，使媒体、字体和模块均经过本地协议缓存。
- **顶部覆盖层**由 `PlayerHUD.tsx` 提供，按游戏的 1280×720 舞台比例缩放，使用客户端 AVG 按钮图标、角点锚定坐标和触摸热区；不挂载 PRTS 的外置工具栏。设置、日志、隐藏、速度、自动与跳过调用原引擎控制器。`tools/extract-player-ui.py` 可从官方 APK 复现导出，依赖 UnityPy 1.25.4 和 Pillow；产物来源见 `frontend/src/assets/player-ui/README.md`。
- **移动端稳定性**：桥接层将上游优先 WebGPU 的画布改为 WebGL，关闭 MSAA，初始和旋转/缩放后的渲染分辨率均限制在 1.5 倍以内。剧情清单仍包含全部音频；播放初始化不提前解码整章音频，而由原音频引擎按需加载，图片按两项一批预热，减少解码峰值。
- **崩溃诊断**：前端环形日志与播放阶段同步保留到本地存储，关键阶段等待 Rust `logs/diagnostics.log` 落盘后才进入 GPU/解码路径；发布版同样启用原生日志。Android 捕获 Java 未处理异常、WebView 渲染进程终止及 API 30+ 历史进程退出原因。渲染进程终止后展示原生导出界面，避免默认处理连带杀死宿主；重启后可在设置或自动打开的恢复日志中复制/导出完整诊断。日志轮换限制大小，不依赖用户提前开启控制台。
- **外部依赖兼容**：每个引擎 iframe 加载 toolbox 后执行 `installEngineCompatibility`，补齐新版工具库删掉、但音频 `fade()` 仍调用的 `Math.clamp`。已有实现保留，兼容补丁不修改应用主窗口。使用 `npm run test:engine` 回归验证；设置 `PRTS_TOOLBOX_FIXTURE=/path/to/krliov.toolbox.js` 可直接校验下载的上游工具库。
- **预下载同步校验**先批量查询 MediaWiki oldid；只有页面 oldid、全局表哈希和外部引擎哈希全部匹配的 v2 manifest 才会复用。媒体下载与协议缓存会校验文件魔数并原子写入，HTML 错误页、空文件和中断文件会被删除后重新拉取。

更详细的设计见 [`docs/superpowers/specs`](superpowers/specs) 与 [`docs/superpowers/plans`](superpowers/plans)。

## 环境要求

- **Node.js** ≥ 18（推荐 20+）
- **Rust** 稳定版工具链（通过 [rustup](https://rustup.rs) 安装）
- 各平台的 Tauri 2 系统依赖（见下）

## 平台系统依赖

**Linux（Debian / Ubuntu）**

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

**Windows**：安装 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) 与 WebView2 运行时（Win10/11 一般已自带）。

**macOS**：安装 Xcode Command Line Tools（`xcode-select --install`）。

> 其他发行版与详细说明参见 [Tauri 官方先决条件](https://v2.tauri.app/start/prerequisites/)。

> 注：资源压缩功能依赖 `webp` crate（封装 `libwebp`，由 `cc` 从源码编译 C 代码）。它随 `cargo build` 自动构建，无需额外系统包；交叉编译到 Android 走与 `ring` 相同的 NDK `cc` 路径（已验证 aarch64 可构建）。图片解码用纯 Rust 的 `image` crate。

## 常用命令

```bash
npm install            # 安装前端依赖

# —— 全应用（前端 + Rust 后端一起）——
npm run tauri:dev      # 启动桌面应用（前端热重载 + Rust 后端）
npm run tauri:build    # 构建当前平台安装包到 src-tauri/target/release/bundle/
                       # （内部会先 npm run build 打包前端，再编译 Rust 并打包）

# —— 仅前端 ——
npm run dev            # 仅启动前端（Vite，浏览器调试用；引擎相关功能需在 Tauri 内运行）
npm run build          # 仅构建前端（tsc + vite）
npm run lint           # ESLint
npm run test:metadata  # 书架元数据校验与 jsDelivr → GitHub 回退单测
npm run test:engine    # 演出工具库兼容与音频淡出回归测试
npm run test:modules   # ESM 依赖解析、动态 API 桥接和外置 UI 隔离
npm run test:diagnostics # 进程重启后的日志与检查点恢复、日志大小限制

# —— 仅后端（Rust / Tauri）——
cargo test  --manifest-path src-tauri/Cargo.toml   # 后端单元测试
cargo build --manifest-path src-tauri/Cargo.toml   # 仅编译后端（debug）
```

> `npm run tauri:build` 是**完整构建**：先打包前端（`npm run build`），再编译 Rust 后端并生成安装包。上面的 `cargo` 命令仅用于单独测试 / 编译后端。

> 📱 **Android**：见 [`android-build.md`](android-build.md)。`scripts/build-android.sh` 默认产出可侧载的 **release** APK（`ABI=` / `RELEASE=` 可调；应用私有外部存储 `getExternalFilesDir`，无资源目录选择器，其余功能与桌面对等）。

## 如何验证构建是否正确

按从快到慢、从本地到云端的顺序：

1. **静态检查（最快，离线）**：`scripts/test-static.sh` —— 等价于 CI 的 `check` 任务（cargo test + cargo build + tsc + vite build）。
2. **本地完整打包**：`npm run tauri:build` —— 复现 CI `build` 任务，在 `src-tauri/target/release/bundle/` 下生成**当前操作系统**的安装包。

   只想快速验证某一种格式，可指定打包器（`--` 不能省，否则 npm 会吞掉参数；且只能构建当前系统支持的格式）：

   ```bash
   # Linux（本机）：deb / rpm
   npm run tauri:build -- --bundles deb
   # Windows 上：nsis        macOS 上：dmg / app
   ```

   > `--bundles` 按**宿主系统**校验，本地 `tauri build` 默认只出当前系统的格式。跨平台安装包交给 Release 工作流在各自 runner 上产出；如需在 Linux 上交叉出 Windows 包，见下。
3. **本地跑 Actions（可选）**：用 [`act`](https://github.com/nektos/act) 在本地执行工作流，例如 `act push -j check`。
4. **云端真跑**：推送到分支会触发 `check`；在 GitHub **Actions → CI → Run workflow** 可手动构建任意分支的安装包；验证发布流程可推一个测试标签：

   ```bash
   git tag v0.0.1-test && git push origin v0.0.1-test   # 含连字符 → pre-release，可随后删除
   ```

## 在 Linux 上交叉构建 Windows 包（实验性）

可以在 Linux 上直接产出 Windows 的 **NSIS 安装包（`*-setup.exe`）**，已实测可用：

```bash
scripts/build-windows.sh
# 等价于：
#   sudo apt-get install -y mingw-w64 nsis
#   rustup target add x86_64-pc-windows-gnu
#   npm run tauri:build -- --target x86_64-pc-windows-gnu   # 注意：不要带 --bundles
```

脚本会把成品 `Arkstage_<版本>_x64-setup.exe` 放到 **`build/artifacts/`**，并在构建后清除庞大的交叉编译中间产物（设 `KEEP_TARGET=1` 可保留以加速重复构建）。整个 `build/` 已在 `.gitignore` 中忽略。

要点与限制：

- **不要带 `--bundles`**：该参数按宿主系统校验会报错；省略后 Tauri 依据 `tauri.conf.json` 的 `bundle.targets` 并按**目标平台**选打包器。
- 该二进制是 **GNU ABI**（非 GitHub `windows-latest` 的 MSVC ABI）；能在 Windows 运行，要最「官方」的产物仍建议用 Release 工作流，或改用 [`cargo-xwin`](https://github.com/rust-cross/cargo-xwin) 走 `--target x86_64-pc-windows-msvc`。
- Tauri 将交叉编译标记为**实验性**，安装包**未签名**；首次构建会从 GitHub 下载 `nsis_tauri_utils.dll`（需联网）。

> 想出 macOS 的 `.dmg` 仍需对应系统。`act` 只能跑 Actions 的 **Linux** 任务，无法替代 Windows/macOS runner——最省事的跨平台出包方式是已配置好的 GitHub Actions。

## 项目结构

```
arkstage/
├─ frontend/                 # React 前端（index.html / vite·ts·eslint 配置）
│  └─ src/
│     ├─ pages/              # 首页 / 浏览 / 播放器 / 设置 / 关于 / 使用说明
│     ├─ lib/                # engineBoot(引擎启动) · predownload(清单+预下载) · proxy(CDN 改写) · version(更新检测)
│     └─ hooks/
├─ src-tauri/                # Tauri / Rust 后端
│  └─ src/
│     ├─ commands/           # wiki(抓取) · cache(缓存) · assets(下载)
│     ├─ parser/             # 剧情目录 / 剧情页解析
│     ├─ media.rs            # 内容寻址媒体仓库
│     ├─ android_service.rs  # 横屏 / 沉浸式 / 前台保活
│     └─ lib.rs              # prts-cdn:// 协议 + 命令注册
├─ scripts/                  # 构建 / 测试 / 清理脚本
├─ tools/build-resources/    # 书架分类源 + 独立 resources 分支生成器
├─ docs/                     # 开发者文档、构建指南、设计 spec/plan
├─ build/                    # 构建产物：dist/（前端 bundle）+ artifacts/（安装包/APK）
└─ .github/workflows/        # CI 与 Release 工作流
```

## 测试

```bash
scripts/test-static.sh   # 离线：cargo test + cargo build + tsc + vite build
scripts/test-e2e.sh      # 无头端到端冒烟：Xvfb 启动真实应用，xdotool 驱动并断言副作用
scripts/run-tests.sh     # 以上全部
```

`test-e2e.sh` 需要 `Xvfb`、`xdotool`、ImageMagick，且需联网（prts.wiki）；它会临时清空本地缓存以保证结果确定。详见 [`scripts/README.md`](../scripts/README.md)。

> ⚠️ 已知限制：Linux 的 WebKitGTK 可能缺少 mp3/ogg 编解码器导致**音频不出声**，画面正常；Windows / macOS 自带编解码器无此问题。

## CI / Release

- **CI**（`.github/workflows/ci.yml`）：每次 push / PR 运行静态检查；push 时额外为各平台构建安装包并作为 Workflow 产物上传（即「CI 版」）。
- **Release**（`.github/workflows/release.yml`）：推送 `v*` 版本标签时，为 Android(arm64-v8a APK) / Windows / macOS(Intel + Apple Silicon) / Linux 构建并发布到对应 GitHub Release 的 Assets。标签含连字符（如 `v1.0.0-beta.1`）发布为 **pre-release**。
- **书架资源**（`.github/workflows/update-storylines.yml`）：手动运行后从 PRTS 重建 StoryLine 分类、从 ArknightsAssets2/PRTS 提取封面和横幅、生成内容哈希清单，并发布到独立 `resources` 分支。客户端下一次启动优先通过 jsDelivr 获取，失败时回退 GitHub Raw。

本地生成同一份资源负载：

```bash
node tools/gen-index/gen-storylines.mjs
node tools/extract-covers/extract-mixstory-kv.mjs
node tools/extract-covers/extract-banner-covers.mjs
node tools/extract-covers/extract-chapter-banners.mjs
node tools/build-resources/build-bookshelf-resources.mjs build/resources
```

新增乐章部署时，先运行 `gen-storylines.mjs --report` 确认新书名及所属 StoryLine，再同步两份人工校验映射：`tools/extract-covers/kv-map.json` 对应 ArknightsAssets2 的 `mixstory/kvs/kv_*.png`，`tools/extract-covers/chapter-banner-map.json` 对应活动页面 `活动信息` 模板中的 `标题图文件名`。生成后必须确认 `metadata.json` 同时包含新书名、`covers[书名]` 和 `banners[书名]`，再发布 `resources` 分支。所有读取 PRTS 的 Node 脚本也必须发送可识别且含项目联系地址的 Arkstage User-Agent；通用 Node/浏览器 UA 会被边缘防护拒绝为 403。

⚠️ **发版铁律**：发版前必须把 `package.json` 的 `version` 一并 bump 到 master 再打标签。应用内「检测更新」的首选源读取的就是 master 上 `package.json` 的 `version`（`cdn.jsdelivr.net/gh/<repo>@master/package.json`），漏 bump 会导致检测不到新版本。

```bash
# 正式版
git tag v1.0.0 && git push origin v1.0.0
# 预发布版
git tag v1.0.0-beta.1 && git push origin v1.0.0-beta.1
```
