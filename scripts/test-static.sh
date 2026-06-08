#!/usr/bin/env bash
# Static checks: Rust unit tests + Rust build + frontend type-check + frontend build.
# Exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/4] cargo test (backend unit tests)"
cargo test --manifest-path src-tauri/Cargo.toml

echo "==> [2/4] cargo build (backend compiles)"
cargo build --manifest-path src-tauri/Cargo.toml

echo "==> [3/4] tsc -b (frontend type-check)"
npx tsc -b frontend

echo "==> [4/4] vite build (frontend bundles)"
npm run build >/dev/null

echo "STATIC: ALL PASS"
