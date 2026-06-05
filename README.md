# PRTS 剧情阅读器

明日方舟（Arknights）剧情**离线**阅读器。它把 [PRTS Wiki](https://prts.wiki) 上的**原版剧情演出引擎**（ScenarioSimulator）搬进一个跨平台桌面应用里运行——带立绘、背景、配音与对话动画——并支持在不限量网络下**预下载**指定范围的资源，之后在无网或计费网络环境下**完全离线**播放。

[![CI](https://github.com/djkcyl/prts-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/djkcyl/prts-reader/actions/workflows/ci.yml)

> 基于 **Tauri 2 + React 19 + TypeScript**。桌面端复用 Wiki 原生引擎，不自研渲染器，最大程度还原游戏内演出。

---

## ✨ 功能特性

- **原版演出还原**：直接运行 PRTS Wiki 的 ScenarioSimulator 引擎，背景 / 立绘 / 对话 / 配音与网页端一致。
- **真离线**：预下载后可在断网环境完整播放，运行时资源一律走本地。
- **按范围预下载**：可按单剧情 / 章节 / 分类批量下载，并通过引擎自身的资源清单精确获取所需文件。
- **内容寻址去重**：相同资源（跨章节复用的立绘、音乐等）只下载与存储一份。
- **联网策略开关**：允许联网时自动拉取并缓存缺失资源；禁止联网时仅播放已缓存内容。
- **博士昵称**：替换剧情文本中的 `{@nickname}` 占位符。

---

## 📦 安装与使用（普通用户）

### 1. 下载安装包

前往 [**Releases**](https://github.com/djkcyl/prts-reader/releases) 下载对应平台的安装包：

| 平台 | 文件 |
|------|------|
| Windows | `.msi` 或 `*-setup.exe` |
| macOS | `.dmg`（区分 Apple Silicon / Intel） |
| Linux | `.AppImage` / `.deb` / `.rpm` |

> 想要尝鲜可在 [Actions](https://github.com/djkcyl/prts-reader/actions) 的 CI 运行记录里下载每次提交自动构建的「CI 版」产物。

### 2. 首次使用

1. 打开应用 → **设置**：
   - 点击 **「预缓存引擎」** 下载播放器所需的引擎代码与样式（需联网，仅需一次）。
   - 点击 **「预缓存目录」** 下载剧情列表。
2. 回到首页 → **浏览剧情**，挑选想看的剧情。
3. 想离线观看时，先在不限量网络下预下载资源：
   - 在播放器里点 **「预下载本剧情资源」**，或
   - 在浏览页对某个**章节 / 分类**点 **「⬇ 预下载」** 批量获取。
4. 之后即可在 **设置 → 联网：关** 的离线状态下流畅播放已缓存的剧情。

### 3. 联网策略

- **联网：开**（默认）——缺失资源会自动从 PRTS 拉取并缓存，适合 PC / 常驻不限量网络。
- **联网：关**——只播放已缓存资源；遇到未缓存内容会提示你开启联网或先行预下载。

---

## 🧩 工作原理（简述）

```
prts.wiki ──HTTP──▶ Rust 后端 ──invoke──▶ React 前端 ──注入 iframe──▶ 原版引擎运行
                       │                                                  │
                  本地缓存 (APPDATA)                 运行时 CDN 资源经 prts-cdn:// 协议「先本地后网络」
```

- **Rust 后端**抓取并解析剧情目录与剧本，管理缓存，并提供自定义 `prts-cdn://` 协议：命中本地的内容寻址仓库（`$APPDATA/media/{host}/{path}`）即离线返回，未命中时（且允许联网）带正确 Referer 拉取并落盘。
- **前端**在隔离的 `<iframe>` realm 中启动原版引擎（每个剧情独立 realm，避免引擎顶层 `const` 冲突），并复用引擎自身的 `fun_sys_preload()` 精确枚举某剧情所需资源用于预下载。

更详细的设计见 [`docs/superpowers/specs`](docs/superpowers/specs) 与 [`docs/superpowers/plans`](docs/superpowers/plans)。

---

## 🛠️ 开发与构建（开发者）

### 环境要求

- **Node.js** ≥ 18（推荐 20+）
- **Rust** 稳定版工具链（通过 [rustup](https://rustup.rs) 安装）
- 各平台的 Tauri 2 系统依赖（见下）

### 平台系统依赖

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

### 常用命令

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

# —— 仅后端（Rust / Tauri）——
cargo test  --manifest-path src-tauri/Cargo.toml   # 后端单元测试
cargo build --manifest-path src-tauri/Cargo.toml   # 仅编译后端（debug）
```

> 说明：`npm run tauri:build` 是**完整构建**——它会先打包前端（`npm run build`），再编译 Rust 后端并生成安装包，无需单独构建后端。上面的 `cargo` 命令仅用于单独测试 / 编译后端。

### 如何验证构建是否正确

按从快到慢、从本地到云端的顺序：

1. **静态检查（最快，离线）**：`scripts/test-static.sh` —— 等价于 CI 的 `check` 任务（cargo test + cargo build + tsc + vite build）。
2. **本地完整打包**：`npm run tauri:build` —— 复现 CI `build` 任务，在 `src-tauri/target/release/bundle/` 下生成**当前操作系统**的安装包。

   只想快速验证某一种格式，可指定打包器（注意：`--` 不能省，否则 npm 会把参数吞掉；且只能构建当前系统支持的格式）：

   ```bash
   # Linux（本机）：deb / rpm / appimage
   npm run tauri:build -- --bundles deb

   # Windows 上：msi / nsis        macOS 上：dmg / app
   # npm run tauri:build -- --bundles msi
   ```

   > ⚠️ `--bundles` 按**宿主系统**校验，所以本地 `tauri build` 默认只出当前系统的格式（Linux=deb/rpm/appimage，Windows=msi/nsis，macOS=dmg/app）。跨平台安装包一般交给 Release 工作流在各自 runner 上产出；如需在 Linux 上交叉出 Windows 包，见下。
3. **本地跑 Actions（可选）**：用 [`act`](https://github.com/nektos/act) 在本地执行工作流，例如 `act push -j check`。
4. **云端真跑**：推送到分支会触发 `check`；在 GitHub **Actions → CI → Run workflow** 可手动构建任意分支的安装包；验证发布流程可推一个测试标签：

   ```bash
   git tag v0.0.1-test && git push origin v0.0.1-test   # 含连字符 → pre-release，可随后删除
   ```

### 在 Linux 上交叉构建 Windows 包（实验性）

可以在 Linux 上直接产出 Windows 的 **NSIS 安装包（`*-setup.exe`）**，已实测可用：

```bash
scripts/build-windows.sh
# 等价于：
#   sudo apt-get install -y mingw-w64 nsis
#   rustup target add x86_64-pc-windows-gnu
#   npm run tauri:build -- --target x86_64-pc-windows-gnu   # 注意：不要带 --bundles
```

产物：`src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/prts-reader_<版本>_x64-setup.exe`。

要点与限制：

- **不要带 `--bundles`**：该参数按宿主系统校验会报错；省略后 Tauri 依据 `tauri.conf.json` 的 `bundle.targets` 并按**目标平台**选打包器。
- **MSI 无法在 Linux 构建**（需 Windows 的 WiX），Tauri 会打印 `ignoring msi` 并跳过，只产出 NSIS。
- 该二进制是 **GNU ABI**（非 GitHub `windows-latest` 的 MSVC ABI）；能在 Windows 运行，但要最「官方」的产物仍建议用 Release 工作流，或改用 [`cargo-xwin`](https://github.com/rust-cross/cargo-xwin) 走 `--target x86_64-pc-windows-msvc`。
- Tauri 将交叉编译标记为**实验性**，安装包**未签名**；首次构建会从 GitHub 下载 `nsis_tauri_utils.dll`（需联网）。

> 想本地出 `.msi` 或 macOS 的 `.dmg`，仍需对应系统（或在 Linux 上跑 Windows/macOS 虚拟机）。`act` 只能在本地跑 Actions 的 **Linux** 任务，无法替代 Windows/macOS runner——最省事的跨平台出包方式仍是已配置好的 GitHub Actions。

### 项目结构

```
prts-reader/
├─ src/                      # React 前端
│  ├─ pages/                 # 首页 / 浏览 / 播放器 / 设置
│  ├─ lib/                   # engineBoot(引擎启动) · predownload(清单+预下载) · proxy(CDN 改写)
│  └─ hooks/
├─ src-tauri/                # Tauri / Rust 后端
│  └─ src/
│     ├─ commands/           # wiki(抓取) · cache(缓存) · assets(下载)
│     ├─ parser/             # 剧情目录 / 剧情页解析
│     ├─ media.rs            # 内容寻址媒体仓库
│     ├─ net_state.rs        # 联网开关
│     └─ lib.rs              # prts-cdn:// 协议 + 命令注册
├─ scripts/                  # 测试脚本（见下）
└─ .github/workflows/        # CI 与 Release 工作流
```

### 测试

```bash
scripts/test-static.sh   # 离线：cargo test + cargo build + tsc + vite build
scripts/test-e2e.sh      # 无头端到端冒烟：Xvfb 启动真实应用，xdotool 驱动并断言副作用
scripts/run-tests.sh     # 以上全部
```

`test-e2e.sh` 需要 `Xvfb`、`xdotool`、ImageMagick，且需联网（prts.wiki）；它会临时清空本地缓存以保证结果确定。详见 [`scripts/README.md`](scripts/README.md)。

> ⚠️ 已知限制：Linux 的 WebKitGTK 可能缺少 mp3/ogg 编解码器导致**音频不出声**，画面正常；Windows / macOS 自带编解码器无此问题。

### CI / Release

- **CI**（`.github/workflows/ci.yml`）：每次 push / PR 运行静态检查；push 时额外为三大平台构建安装包并作为 Workflow 产物上传（即「CI 版」）。
- **Release**（`.github/workflows/release.yml`）：推送 `v*` 版本标签时，为 Windows / macOS(Intel + Apple Silicon) / Linux 构建并将安装包发布到对应 GitHub Release 的 Assets。标签含连字符（如 `v1.0.0-beta.1`）会发布为 **pre-release**。

发布示例：

```bash
# 正式版
git tag v1.0.0 && git push origin v1.0.0
# 预发布版
git tag v1.0.0-beta.1 && git push origin v1.0.0-beta.1
```

---

## 📄 数据来源与免责声明

- 剧情文本与素材来自 [PRTS Wiki](https://prts.wiki)，最终版权归 **《明日方舟》/ 鹰角网络（Hypergryph）** 所有。
- 本项目为非官方的同人 / 学习性质阅读器，请合理使用、避免对源站造成压力，勿用于任何商业用途。

## 📜 许可证

本仓库尚未指定开源许可证。在补充 `LICENSE` 之前，默认保留所有权利。
