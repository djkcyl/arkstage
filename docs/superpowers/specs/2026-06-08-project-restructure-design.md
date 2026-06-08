# 项目目录重构 + 构建脚本强化 — 设计

**日期**：2026-06-08
**分支**：`android`（在此分支上进行）
**目标**：把散落在仓库根目录的源码、配置、构建产物按类型归拢到统一入口；删除临时/无用内容；强化构建脚本，使其在构建前后都清理垃圾，并在构建前检测并删除已存在的目标产物。

---

## 1. 动机

当前根目录混杂了四类东西：

- **前端源码与配置**：`index.html`、`src/`、`public/`、`vite.config.ts`、`eslint.config.js`、`tsconfig.json`、`tsconfig.app.json`、`tsconfig.node.json`
- **构建产物**：`dist/`（前端 bundle），以及三个 `scripts/build-*.sh` 把最终安装包/APK **直接 copy 到仓库根**（`*.apk`、`*.msi`、`*-setup.exe`、`prts-reader-portable/`…）
- **临时/分析残留**：`_reference/`（7.9M 下载的 wiki 页面）、`.playwright-mcp/`（调试日志快照）、空的 `.claude/`
- **其余**：`src-tauri/`、`scripts/`、`docs/`、`.github/`、`package.json`、`README.md`

主要痛点是构建产物在根目录散落，以及前端配置文件堆在根。

## 2. 约束（被工具链钉死、不能动的路径）

- **`src-tauri/` 不能移动**：`src-tauri/gen/android` 的 Gradle 使用相对路径（`rootDirRel = "../../../"` 等），且 `gen/android` 是版本控制的。移动会破坏已验证的 Android 脚手架。
- **`.github/` 必须在根**：GitHub Actions 硬性要求。
- **`package.json` / `package-lock.json` / `node_modules/` 留在根**：单一 npm 工程入口；Tauri CLI 从根调用；`node_modules` 在根。
- **Vite root** 默认为被调用时的目录；通过 `vite <root>` positional 参数即可把 root 指到子目录并自动发现该目录下的 `vite.config.ts`，无需 `--config`。
- **CI 产物来源**：`.github/workflows/ci.yml` 从 `src-tauri/target/release/bundle/**` 收集安装包（Tauri 自身输出），**不经过**根目录 copy，因此本次重构不影响 CI。

## 3. 目标目录结构

```
prts-reader/
├─ frontend/                 # 前端 Web 应用（统一入口）
│  ├─ index.html
│  ├─ src/
│  ├─ public/
│  ├─ vite.config.ts
│  ├─ eslint.config.js
│  ├─ tsconfig.json
│  ├─ tsconfig.app.json
│  └─ tsconfig.node.json
├─ src-tauri/                # Tauri / Rust 后端（不动）
├─ scripts/                  # 构建 / 测试脚本
├─ docs/
│  ├─ reference/             # 由 _reference/ 移来（保持 gitignore，不进 git）
│  └─ superpowers/ …
├─ build/                    # 唯一构建产物出口
│  ├─ dist/                  # 前端 bundle（vite 输出 + Tauri frontendDist 读取）
│  └─ artifacts/             # 最终 .apk / .msi / installer（build 脚本 copy 目的地）
├─ .github/
├─ package.json
├─ package-lock.json
├─ node_modules/
└─ README.md
```

被删除：`.playwright-mcp/`、空 `.claude/`、当前根 `dist/`。
被移动：`_reference/` → `docs/reference/`。

## 4. 配置重接线

| 文件 | 改动 |
|------|------|
| `package.json` scripts | `dev: "vite frontend"`；`build: "tsc -b frontend && vite build frontend"`；`preview: "vite preview frontend"`；`lint: "eslint -c frontend/eslint.config.js frontend"`。`tauri` / `tauri:dev` / `tauri:build` 不变 |
| `frontend/vite.config.ts` | 增加 `build.outDir: '../build/dist'` 与 `build.emptyOutDir: true`（root=frontend，解析为仓库根的 `build/dist`）；增加 `server: { port: 5174, strictPort: true }` 以对齐 Tauri `devUrl`（见 §8） |
| `frontend/tsconfig.app.json` | `include` 保持 `["src"]`（现已相对 frontend/）；`tsBuildInfoFile` 改为 `../node_modules/.tmp/tsconfig.app.tsbuildinfo`（复用根 node_modules） |
| `frontend/tsconfig.node.json` | `tsBuildInfoFile` 改为 `../node_modules/.tmp/tsconfig.node.tsbuildinfo`；`include: ["vite.config.ts"]` 保持不变（与 config 一同移动，相对路径仍有效） |
| `frontend/eslint.config.js` | `globalIgnores(['dist'])` → 忽略相对仓库根的 `build`（实际 build 在 frontend/ 之外，eslint 不会触及，调整仅为正确性） |
| `src-tauri/tauri.conf.json` | `frontendDist: "../dist"` → `"../build/dist"`。`devUrl` / `beforeDevCommand` / `beforeBuildCommand` 不变 |

> 注：`src-tauri/gen/android/app/src/main/assets/tauri.conf.json` 是构建期从 `src-tauri/tauri.conf.json` 自动生成的副本，已 gitignore，无需手改。

## 5. 构建产物统一出口

- 前端 bundle → `build/dist/`（`vite build` 输出；Tauri `frontendDist` 读取）。
- 最终安装包 / APK / 便携包 → `build/artifacts/`。三个脚本的 copy 目的地从「仓库根」改为此处：
  - `build-android.sh`：APK → `build/artifacts/`
  - `build-windows.sh`：`*-setup.exe` / `*.msi` 等 → `build/artifacts/`
  - `build-windows-portable.sh`：`prts-reader-portable/` 与 `prts-reader-portable.zip` → `build/artifacts/`

## 6. 删除与移动

- **删除**（均未跟踪 / 已 gitignore）：`.playwright-mcp/`、空 `.claude/`、当前根 `dist/`。
- **移动**：`_reference/` → `docs/reference/`。因体积大（7.9M）继续保持 gitignore，不纳入版本控制；仅落到一个语义合适的位置。

## 7. 构建脚本强化

新增共享脚本 **`scripts/clean.sh`**（吸收现有 `precommit-clean.sh` 的"只删已知生成物/垃圾、绝不删 git 跟踪文件"安全逻辑，路径更新为 `build/`），提供两种用法：

- `scripts/clean.sh --junk`：删除 OS/编辑器残留（`.DS_Store`、`*.swp`、`*~`…）、根级 scratch（`error.txt`、`image*.png`、`screenshot*.png`、`*.tmp`）。
- `scripts/clean.sh --build`：删除 `build/`、`dist`、`dist-ssr`、`src-tauri/gen`（生成物）等。

`precommit-clean.sh` 改为薄封装调用 `clean.sh`（保持向后兼容的命令名与 `--dry-run`）。

三个 `build-*.sh` 统一加入：

- **构建前**：
  1. `scripts/clean.sh --junk`（清垃圾）；
  2. **检测目标产物是否已存在**——若 `build/artifacts/` 下已有本次将产出的同类产物（如 `*.apk` / `*-setup.exe` / `prts-reader-portable*`），先删除，避免与旧产物混淆；
  3. 删除陈旧的 `build/dist`（保证前端 bundle 是新的）。
- **构建后**：
  1. 把新产物 copy 到 `build/artifacts/`；
  2. `scripts/clean.sh --junk` 再清一次中间垃圾；
  3. 最终只在 `build/artifacts/` 留下产物。

## 8. 顺带修复：dev 端口不匹配（已批准纳入）

`src-tauri/tauri.conf.json` 的 `devUrl` 为 `http://localhost:5174`，而 `vite.config.ts` 未设端口（Vite 默认 `5173`），属潜在的 `tauri dev` 端口不匹配。本次在 `frontend/vite.config.ts` 显式设 `server: { port: 5174, strictPort: true }` 对齐 `devUrl`，消除该 latent bug。

## 9. 文档与 gitignore 更新

- **`.gitignore`**：`dist` → `/build/`；删除已无意义的根级安装包模式（`/*.apk`、`/*.msi`、`/*.exe`、`prts-reader-portable/`、`prts-reader-portable.zip` 等，现已收纳进 `build/`，由 `/build/` 覆盖）；新增 `docs/reference/`；保留 `node_modules`、`src-tauri/target/`、`src-tauri/gen/schemas/`、`src-tauri/gen/apple/`、scratch 与编辑器忽略项。
- **`README.md`**：更新「项目结构」段以反映 `frontend/` 与 `build/`；更新构建产物位置说明。
- **`docs/android-build.md`**、**`scripts/README.md`**：更新 APK / 产物输出路径与脚本说明。

## 10. 验证策略

每个改动阶段后执行：

- `scripts/test-static.sh`：`cargo test` + `cargo build` + `tsc -b frontend` + `vite build frontend`（产物落 `build/dist`）全绿。
- `scripts/test-e2e.sh`：`tauri:dev` 流程确认前端仍被正确加载（端口对齐后应更稳）。
- 至少跑一次 `scripts/build-android.sh` 确认 APK 落到 `build/artifacts/`，且构建前若存在旧 APK 会被删除、构建后无垃圾残留。
- `scripts/clean.sh --dry-run`（或等价）确认不会误删任何 git 跟踪文件。

## 11. 非目标（YAGNI）

- 不移动 `src-tauri/`（含 `gen/android`）。
- 不把 `package.json` / 工程拆成多包（monorepo）。
- 不改 CI 工作流的产物来源（仍从 `target/release/bundle/**`）。
- 不重命名既有源码文件或重构组件内部实现。
