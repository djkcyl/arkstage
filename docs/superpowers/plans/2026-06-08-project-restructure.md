# 项目目录重构 + 构建脚本强化 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把前端源码+配置归拢到 `frontend/`，所有构建产物归拢到 `build/{dist,artifacts}`，删除临时垃圾，并强化构建脚本（构建前后清垃圾 + 构建前删除已存在的目标产物）。

**Architecture:** Vite 通过 `vite frontend` 的 positional-root 参数把 web root 指到 `frontend/`，`package.json`/`node_modules`/`src-tauri/` 留在根。Tauri `frontendDist` 指向 `../build/dist`。一个共享 `scripts/clean.sh` 承担所有清理，build 脚本在前后调用它并把产物 copy 到 `build/artifacts/`。

**Tech Stack:** Tauri v2, Vite 8, React 19, TypeScript 5.9, bash 构建脚本。

**Spec:** `docs/superpowers/specs/2026-06-08-project-restructure-design.md`

**全局说明：** 这是一次重构，"测试"= 现有套件（`scripts/test-static.sh`、`scripts/test-e2e.sh`）与具体验证命令的预期输出，而非新单元测试。每个 Task 末尾提交一次。

---

### Task 0: 基线确认（动手前先确保绿）

**Files:** 无改动

- [ ] **Step 1: 跑静态套件确认当前绿**

Run: `bash scripts/test-static.sh`
Expected: 末尾输出 `STATIC: ALL PASS`（cargo test + cargo build + tsc + vite build 全过）。若不绿，先停下排查，勿继续。

---

### Task 1: 把前端源码与配置移入 `frontend/` 并重接线

这一步必须原子完成——中间态无法构建。先移动文件，再改 4 处配置，最后一次性验证。

**Files:**
- Move: `index.html`, `src/`, `public/`, `vite.config.ts`, `eslint.config.js`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json` → `frontend/`
- Modify: `package.json`（scripts）
- Modify: `frontend/vite.config.ts`、`frontend/tsconfig.app.json`、`frontend/tsconfig.node.json`
- Modify: `src-tauri/tauri.conf.json:7`（frontendDist）

- [ ] **Step 1: 创建 frontend/ 并 git mv 进去**

```bash
mkdir -p frontend
git mv index.html src public vite.config.ts eslint.config.js \
        tsconfig.json tsconfig.app.json tsconfig.node.json frontend/
```

`eslint.config.js` 移动后无需改内容：其 `globalIgnores(['dist'])` 在新的 lint 基准目录（frontend/）下指向不存在的 `frontend/dist`，无害；构建产物 `build/` 在 frontend/ 之外，lint 本就不会触及。

- [ ] **Step 2: 改 `package.json` 的 scripts 块**

把 `scripts` 改为（其余字段不动）：

```json
  "scripts": {
    "dev": "vite frontend",
    "build": "tsc -b frontend && vite build frontend",
    "lint": "eslint -c frontend/eslint.config.js frontend",
    "preview": "vite preview frontend",
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build"
  },
```

- [ ] **Step 3: 重写 `frontend/vite.config.ts`**

```ts
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
```

- [ ] **Step 4: 改 `frontend/tsconfig.app.json` 的 tsBuildInfoFile**

把第一行 compilerOptions 内的：
```json
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
```
改为（复用仓库根的 node_modules）：
```json
    "tsBuildInfoFile": "../node_modules/.tmp/tsconfig.app.tsbuildinfo",
```
`include: ["src"]` 保持不变（现已相对 frontend/）。

- [ ] **Step 5: 改 `frontend/tsconfig.node.json` 的 tsBuildInfoFile**

把：
```json
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
```
改为：
```json
    "tsBuildInfoFile": "../node_modules/.tmp/tsconfig.node.tsbuildinfo",
```
`include: ["vite.config.ts"]` 保持不变。

- [ ] **Step 6: 改 `src-tauri/tauri.conf.json` 的 frontendDist**

第 7 行：
```json
    "frontendDist": "../dist",
```
改为：
```json
    "frontendDist": "../build/dist",
```

- [ ] **Step 7: 验证前端构建 + 类型检查 + lint**

Run: `npm run build`
Expected: 成功；产物出现在 `build/dist/`（`ls build/dist/index.html` 存在）。

Run: `ls build/dist`
Expected: 含 `index.html`、`assets/`、`favicon.svg` 等。

Run: `npm run lint`
Expected: 无 ESLint 报错（退出码 0）。

- [ ] **Step 8: 验证根目录已无散落前端文件**

Run: `ls index.html src public vite.config.ts 2>&1 || true`
Expected: 四者在根均「No such file」（已移入 frontend/）。

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "refactor: move frontend app + configs into frontend/, output to build/dist

vite frontend (positional root) + tauri frontendDist=../build/dist.
Aligns Vite dev port to Tauri devUrl (5174).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 删除临时垃圾、移动 `_reference/`、更新 `.gitignore`

`_reference/`、`.playwright-mcp/`、`dist/` 均已 gitignore/未跟踪，删除/移动它们除 `.gitignore` 外不产生 git 变更。

**Files:**
- Delete: `.playwright-mcp/`、`.claude/`（空）、根 `dist/`
- Move: `_reference/` → `docs/reference/`
- Modify: `.gitignore`

- [ ] **Step 1: 删除垃圾、移动 _reference**

```bash
rm -rf .playwright-mcp .claude dist
mkdir -p docs
mv _reference docs/reference
```

- [ ] **Step 2: 验证**

Run: `ls -d .playwright-mcp dist _reference 2>&1 || true`
Expected: 三者均「No such file」。

Run: `ls docs/reference | head`
Expected: 列出 `arknights-scenario.css`、`sample_story.html` 等（移动成功）。

- [ ] **Step 3: 改 `.gitignore`**

把现有 `dist`（Logs 块下那一行 `dist`）保留，并做以下编辑：

1. 在 `# Tauri` 之前的构建产物区，新增对 `build/` 的忽略。把：
```
node_modules
dist
dist-ssr
*.local
```
改为：
```
node_modules
dist
dist-ssr
*.local

# Unified build output (frontend bundle + installers/APK)
/build/
```

2. 删除已无意义的根级安装包/便携产物模式（现已收纳进 `/build/`）。删掉这两块：
```
# Local build outputs (installers copied to the project root by scripts/build-*.sh)
/*.exe
/*.msi
/*.deb
/*.rpm
/*.AppImage
/*.dmg
/*.zip
/*.apk
/*.aab

# Portable build output (scripts/build-windows-portable.sh)
/prts-reader-portable/
prts-reader-portable.zip
```

3. 把 `_reference/` 那一块改为新位置：
```
# Reference files (downloaded for analysis)
_reference/
```
改为：
```
# Reference files (downloaded for analysis; kept out of git due to size)
docs/reference/
```

- [ ] **Step 4: 验证 .gitignore 生效**

Run: `git check-ignore docs/reference build && echo OK`
Expected: 两路径都被忽略，打印 `OK`。

Run: `git status --short`
Expected: 仅显示 `.gitignore` 被修改（垃圾删除/_reference 移动不出现，因均被忽略）。

- [ ] **Step 5: 提交**

```bash
git add .gitignore
git commit -m "chore: drop scratch dirs, relocate _reference to docs/reference, gitignore /build/

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 新增 `scripts/clean.sh`，把 `precommit-clean.sh` 改为薄封装

**Files:**
- Create: `scripts/clean.sh`
- Rewrite: `scripts/precommit-clean.sh`

- [ ] **Step 1: 创建 `scripts/clean.sh`**

```bash
#!/usr/bin/env bash
#
# Unified cleanup. Removes build outputs and/or scratch/junk files.
#
# SAFE BY DESIGN: only deletes known generated/junk patterns; as a guard it
# refuses to delete anything git currently tracks.
#
# Usage:
#   scripts/clean.sh             # clean BOTH build outputs and junk (default)
#   scripts/clean.sh --build     # only build outputs (build/, dist, gen)
#   scripts/clean.sh --junk      # only scratch / OS / editor junk
#   scripts/clean.sh --dry-run   # show what would be removed (combine w/ above)
set -euo pipefail
cd "$(dirname "$0")/.."

DO_BUILD=0
DO_JUNK=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --build)   DO_BUILD=1 ;;
    --junk)    DO_JUNK=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done
# Default with no scope flag: do both.
if [ "$DO_BUILD" = 0 ] && [ "$DO_JUNK" = 0 ]; then
  DO_BUILD=1; DO_JUNK=1
fi

removed=0
# Delete a path unless git tracks it (tracked files/dirs are never touched).
rm_path() {
  local p="$1"
  [ -e "$p" ] || return 0
  if git ls-files --error-unmatch "$p" >/dev/null 2>&1; then
    echo "  skip (tracked): $p"
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    echo "  would remove: $p"
  else
    echo "  removing: $p"
    rm -rf "$p"
  fi
  removed=$((removed + 1))
}

if [ "$DO_BUILD" = 1 ]; then
  echo "==> Cleaning build outputs"
  rm_path build
  rm_path dist
  rm_path dist-ssr
  rm_path src-tauri/gen   # guard skips gen/android (tracked); clears gen/schemas etc.
fi

if [ "$DO_JUNK" = 1 ]; then
  echo "==> Cleaning scratch / OS / editor junk"
  shopt -s nullglob
  for f in ./error.txt ./image.png ./image*.png ./screenshot*.png ./*.tmp; do
    rm_path "$f"
  done
  shopt -u nullglob
  # OS / editor cruft anywhere (skip heavy/ignored dirs).
  while IFS= read -r f; do
    rm_path "$f"
  done < <(find . \( -path ./node_modules -o -path ./src-tauri/target -o -path ./.git -o -path ./build \) -prune -o \
    -type f \( -name '.DS_Store' -o -name 'Thumbs.db' -o -name '*.swp' -o -name '*~' \) -print)
fi

if [ "$removed" -eq 0 ]; then
  echo "==> Nothing to clean."
elif [ "$DRY" = 1 ]; then
  echo "==> Done. ${removed} item(s) would be removed."
else
  echo "==> Done. ${removed} item(s) removed."
fi
```

- [ ] **Step 2: 赋可执行权限**

Run: `chmod +x scripts/clean.sh`

- [ ] **Step 3: 把 `scripts/precommit-clean.sh` 改为薄封装**

整体替换为：

```bash
#!/usr/bin/env bash
#
# Pre-commit cleanup — thin wrapper around scripts/clean.sh that removes build
# artifacts and stray scratch files so they never sneak into a commit.
#
# SAFE: clean.sh only deletes known generated/junk patterns and refuses to
# delete anything git currently tracks.
#
# Usage:
#   scripts/precommit-clean.sh            # clean
#   scripts/precommit-clean.sh --dry-run  # show what would be removed
#
# Optional git hook:
#   ln -sf ../../scripts/precommit-clean.sh .git/hooks/pre-commit
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--dry-run" ]; then
  exec scripts/clean.sh --dry-run
fi
exec scripts/clean.sh
```

- [ ] **Step 4: 验证 dry-run 不误删跟踪文件**

Run: `scripts/clean.sh --dry-run`
Expected: 仅列出 `would remove:` 的生成物/垃圾；对 `src-tauri/gen` 打印 `skip (tracked)`；退出码 0；运行后 `git status --short` 无变化。

Run: `scripts/precommit-clean.sh --dry-run`
Expected: 同上（薄封装等价）。

- [ ] **Step 5: 提交**

```bash
git add scripts/clean.sh scripts/precommit-clean.sh
git commit -m "build: unified scripts/clean.sh; precommit-clean becomes a thin wrapper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 三个 build 脚本输出到 `build/artifacts/` + 前后清理 + 删旧产物

**Files:**
- Modify: `scripts/build-android.sh`
- Modify: `scripts/build-windows.sh`
- Modify: `scripts/build-windows-portable.sh`

- [ ] **Step 1: 改 `scripts/build-android.sh` —— 构建前清理 + 删旧 APK**

在第 88 行 `echo "==> Building Android APK ..."` **之前**插入：

```bash
# --- Pre-build cleanup: drop junk, then remove any stale APK from a prior run
# so the output dir only ever holds the current build's artifacts. ---
echo "==> Pre-build cleanup"
scripts/clean.sh --junk
ARTIFACTS_DIR="build/artifacts"
mkdir -p "$ARTIFACTS_DIR"
rm -f "$ARTIFACTS_DIR"/*.apk
# Ensure a fresh frontend bundle.
rm -rf build/dist
```

- [ ] **Step 2: 改 `scripts/build-android.sh` —— 输出到 build/artifacts + 构建后清理**

把第 91–107 行（`# Copy the produced APK(s) ...` 到文件末尾 `ls -lh ./*.apk`）整体替换为：

```bash
# Copy the produced APK(s) to build/artifacts/. Tauri emits them under
# app/build/outputs/apk/<flavor>/<buildType>/.
out_dir="src-tauri/gen/android/app/build/outputs/apk"
mapfile -t apks < <(find "$out_dir" -name "*.apk" 2>/dev/null)
if [ "${#apks[@]}" -eq 0 ]; then
  echo "ERROR: no APK produced under $out_dir" >&2
  exit 1
fi
for apk in "${apks[@]}"; do
  dest="$ARTIFACTS_DIR/$(basename "$apk")"
  cp -f "$apk" "$dest"
  echo "    -> $dest"
done

# --- Post-build cleanup: clear scratch/junk; final APK(s) stay in artifacts. ---
echo "==> Post-build cleanup"
scripts/clean.sh --junk

echo
echo "==> Done. APK(s) in $ARTIFACTS_DIR:"
ls -lh "$ARTIFACTS_DIR"/*.apk
```

- [ ] **Step 3: 改文件头注释（build-android.sh 第 3 行）**

把 `# Build a sideloadable Android **debug APK** for prts-reader and copy it to the` / `# project root.` 中的 `project root` 改为 `build/artifacts/`。具体把第 3–4 行：
```
# Build a sideloadable Android **debug APK** for prts-reader and copy it to the
# project root. Mirrors scripts/build-windows.sh in spirit: installs missing
```
改为：
```
# Build a sideloadable Android **debug APK** for prts-reader and copy it to
# build/artifacts/. Mirrors scripts/build-windows.sh in spirit: installs missing
```

- [ ] **Step 4: 改 `scripts/build-windows.sh` —— 输出到 build/artifacts + 前后清理 + 删旧**

a) 把第 31 行 `rm -f ./*-setup.exe` 替换为：
```bash
echo "==> Pre-build cleanup"
scripts/clean.sh --junk
ARTIFACTS_DIR="build/artifacts"
mkdir -p "$ARTIFACTS_DIR"
rm -f "$ARTIFACTS_DIR"/*-setup.exe
```

b) 把第 69–71 行：
```bash
# Put the finished installer directly in the project root.
dest="./$(basename "$installer")"
cp -f "$installer" "$dest"
```
替换为：
```bash
# Put the finished installer in build/artifacts/.
dest="$ARTIFACTS_DIR/$(basename "$installer")"
cp -f "$installer" "$dest"
```

c) 把第 82–83 行：
```bash
echo "==> Done. Installer is in the project root:"
ls -lh "$dest"
```
替换为：
```bash
echo "==> Post-build cleanup"
scripts/clean.sh --junk
echo "==> Done. Installer is in $ARTIFACTS_DIR:"
ls -lh "$dest"
```

- [ ] **Step 5: 改 `scripts/build-windows-portable.sh` —— 输出到 build/artifacts + 前后清理 + 删旧**

a) 把第 27 行 `OUT="prts-reader-portable"` 替换为：
```bash
ARTIFACTS_DIR="build/artifacts"
OUT="$ARTIFACTS_DIR/prts-reader-portable"
```

b) 把第 34 行 `rm -rf "$OUT" "$OUT.zip"` 替换为：
```bash
echo "==> Pre-build cleanup"
scripts/clean.sh --junk
mkdir -p "$ARTIFACTS_DIR"
rm -rf "$OUT" "$OUT.zip"
```
（第 73 行第二处 `rm -rf "$OUT" "$OUT.zip"` 保持原样——它在组装前再清一次，仍有效。）

c) 把第 92–94 行：
```bash
echo "==> Done. Portable build in the project root:"
ls -lh "$OUT"/ 2>/dev/null
[ -f "$OUT.zip" ] && ls -lh "$OUT.zip"
```
替换为：
```bash
echo "==> Post-build cleanup"
scripts/clean.sh --junk
echo "==> Done. Portable build in $ARTIFACTS_DIR:"
ls -lh "$OUT"/ 2>/dev/null
[ -f "$OUT.zip" ] && ls -lh "$OUT.zip"
```

- [ ] **Step 6: 语法检查三个脚本**

Run: `bash -n scripts/build-android.sh && bash -n scripts/build-windows.sh && bash -n scripts/build-windows-portable.sh && echo OK`
Expected: 打印 `OK`（无语法错误）。

- [ ] **Step 7: 提交**

```bash
git add scripts/build-android.sh scripts/build-windows.sh scripts/build-windows-portable.sh
git commit -m "build: emit installers/APK to build/artifacts; pre/post clean; drop stale artifacts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 更新文档（README 结构、android-build、scripts/README）

**Files:**
- Modify: `README.md`（「项目结构」段 + 产物位置）
- Modify: `docs/android-build.md`（APK 路径）
- Modify: `scripts/README.md`（脚本说明）

- [ ] **Step 1: 更新 `README.md` 的「项目结构」段**

把现有树（约第 166–181 行，含 `├─ src/` / `├─ src-tauri/` / `├─ scripts/`）的**目录树内容**替换为下面这棵（保留外层的 ``` 围栏与段落里其它说明文字，仅替换树本身的行）：

```
prts-reader/
├─ frontend/                 # React 前端（index.html / src / public / vite·ts·eslint 配置）
│  └─ src/
├─ src-tauri/                # Tauri / Rust 后端
│  └─ src/
├─ scripts/                  # 构建 / 测试 / 清理脚本
├─ docs/                     # 设计文档、构建指南、reference/（gitignore）
├─ build/                    # 构建产物：dist/（前端 bundle）+ artifacts/（安装包/APK）
└─ .github/                  # CI / Release 工作流
```

- [ ] **Step 2: 更新 README 中产物位置描述**

搜索并更新任何提到安装包/便携包落在「项目根目录 / project root」的措辞，改为 `build/artifacts/`。

Run（定位）: `grep -n '项目根\|project root\|根目录' README.md`
对命中行据实改为 `build/artifacts/`（前端 bundle 则为 `build/dist/`）。`src-tauri/target/release/bundle/` 这类 Tauri 原生输出路径**不改**。

- [ ] **Step 3: 更新 `docs/android-build.md`**

Run（定位）: `grep -n 'project root\|根目录\|\.apk\|./\*.apk\|APK' docs/android-build.md`
把 APK 产出/取用位置由「项目根」改为 `build/artifacts/`。

- [ ] **Step 4: 更新 `scripts/README.md`**

Run（定位）: `grep -n 'precommit-clean\|dist\|项目根\|project root\|artifact\|清理' scripts/README.md`
补充 `clean.sh` 的用途与三种用法；把产物位置说明改为 `build/artifacts/`；说明 `precommit-clean.sh` 现为 `clean.sh` 的薄封装。

- [ ] **Step 5: 验证无遗漏的陈旧路径引用**

Run: `grep -rn '\.\./dist\b\|frontendDist.*\.\./dist\b' . --include='*.json' --include='*.ts' | grep -v node_modules | grep -v src-tauri/gen`
Expected: 无输出（除已改的 tauri.conf 指向 build/dist）。

- [ ] **Step 6: 提交**

```bash
git add README.md docs/android-build.md scripts/README.md
git commit -m "docs: reflect frontend/ + build/{dist,artifacts} layout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 端到端验证

**Files:** 无改动

- [ ] **Step 1: 静态套件**

Run: `bash scripts/test-static.sh`
Expected: `STATIC: ALL PASS`（`vite build frontend` 产物落 `build/dist`）。

- [ ] **Step 2: E2E 冒烟（需 Xvfb/xdotool/联网；见 scripts/README.md）**

Run: `bash scripts/test-e2e.sh`
Expected: 通过——`tauri:dev` 起 Vite（5174，已与 devUrl 对齐），引擎场景渲染、缓存副作用断言成立。

- [ ] **Step 3: Android 构建冒烟（单 ABI，较快）确认产物落点 + 删旧逻辑**

Run: `ABI=x86_64 scripts/build-android.sh`
Expected: 末尾 `==> Done. APK(s) in build/artifacts:` 并列出 `*.apk`；构建前若 `build/artifacts/` 已有旧 APK 会被删除；运行后 `git status --short` 干净（产物在 gitignore 的 build/ 下）。

- [ ] **Step 4: 终态自检**

Run: `ls build/dist >/dev/null && ls build/artifacts/*.apk >/dev/null && echo LAYOUT_OK`
Expected: `LAYOUT_OK`。

Run: `git status --short`
Expected: 干净（无未跟踪产物泄漏到根）。

- [ ] **Step 5: 更新记忆**

更新 `/root/.claude/projects/-root-prts-reader/memory/prts-reader-android.md`（或新增一条 project 记忆），记录新布局：前端在 `frontend/`，产物在 `build/{dist,artifacts}`，`scripts/clean.sh` 统一清理，Vite 端口 5174 对齐 devUrl。

---

## 验收标准

- 根目录不再出现散落的前端配置文件与构建产物（APK/安装包/dist）。
- `npm run build` → `build/dist/`；三个 build 脚本 → `build/artifacts/`。
- 构建脚本在构建前清垃圾并删除已存在的同类目标产物，构建后再清一次。
- `scripts/test-static.sh`、`scripts/test-e2e.sh` 全绿；`ABI=x86_64 scripts/build-android.sh` 产物落 `build/artifacts/`。
- `_reference/` 安在 `docs/reference/`（gitignore）；`.playwright-mcp/`、空 `.claude/`、旧 `dist/` 已删。
- CI 工作流未改（仍从 `src-tauri/target/release/bundle/**` 取件）。
