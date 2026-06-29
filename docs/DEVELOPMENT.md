# 开发与构建（开发者文档）

面向贡献者 / 自行构建的开发者。普通使用说明见仓库根的 [`README.md`](../README.md)。

## 🧩 工作原理（简述）

```
prts.wiki ──HTTP──▶ Rust 后端 ──invoke──▶ React 前端 ──注入 iframe──▶ 原版引擎运行
                       │                                                  │
                  本地缓存 (APPDATA)                 运行时 CDN 资源经 prts-cdn:// 协议「先本地后网络」
```

- **Rust 后端**抓取并解析剧情目录与剧本，管理缓存，并提供自定义 `prts-cdn://` 协议：命中本地的内容寻址仓库（`$APPDATA/media/{host}/{path}`）即离线返回，未命中时（且允许联网）带正确 Referer 拉取并落盘。
- **前端**在隔离的 `<iframe>` realm 中启动原版引擎（每个剧情独立 realm，避免引擎顶层 `const` 冲突），并复用引擎自身的 `fun_sys_preload()` 精确枚举某剧情所需资源用于预下载。

更详细的设计见 [`docs/superpowers/specs`](superpowers/specs) 与 [`docs/superpowers/plans`](superpowers/plans)；架构约定见仓库根 [`CLAUDE.md`](../CLAUDE.md)。

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

⚠️ **发版铁律**：发版前必须把 `package.json` 的 `version` 一并 bump 到 master 再打标签。应用内「检测更新」的首选源读取的就是 master 上 `package.json` 的 `version`（`cdn.jsdelivr.net/gh/<repo>@master/package.json`），漏 bump 会导致检测不到新版本。

```bash
# 正式版
git tag v1.0.0 && git push origin v1.0.0
# 预发布版
git tag v1.0.0-beta.1 && git push origin v1.0.0-beta.1
```
