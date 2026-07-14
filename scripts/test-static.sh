#!/usr/bin/env bash
# Static checks: Rust unit tests + Rust build + frontend type-check + frontend build.
# Exits non-zero on any failure.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> [1/5] bookshelf metadata fallback tests"
npm run test:metadata

echo "==> [2/5] cargo test (backend unit tests)"
cargo test --manifest-path src-tauri/Cargo.toml

echo "==> [3/5] cargo build (backend compiles)"
cargo build --manifest-path src-tauri/Cargo.toml

echo "==> [4/5] tsc -b (frontend type-check)"
npx tsc -b frontend

echo "==> [5/5] vite build (frontend bundles)"
npm run build >/dev/null

echo "STATIC: ALL PASS"
