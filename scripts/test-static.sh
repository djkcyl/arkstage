#!/usr/bin/env bash
# Static checks: Rust unit tests + Rust build + frontend type-check + frontend build.
# Exits non-zero on any failure.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> [1/6] engine compatibility tests"
npm run test:engine
npm run test:modules
npm run test:diagnostics
npm run test:playback
npm run test:transcript
npm run test:resume
npm run test:read-state
npm run test:cache
npm run test:startup
npm run test:music
npm run test:resources

echo "==> [2/6] bookshelf metadata fallback tests"
npm run test:metadata

echo "==> [3/6] cargo test (backend unit tests)"
cargo test --manifest-path src-tauri/Cargo.toml

echo "==> [4/6] cargo build (backend compiles)"
cargo build --manifest-path src-tauri/Cargo.toml

echo "==> [5/6] tsc -b (frontend type-check)"
npx tsc -b frontend

echo "==> [6/6] vite build (frontend bundles)"
npm run build >/dev/null

echo "STATIC: ALL PASS"
