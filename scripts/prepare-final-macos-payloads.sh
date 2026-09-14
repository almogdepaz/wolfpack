#!/usr/bin/env bash
set -euo pipefail

for target in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
  cp "dist/broker/bun-${target}/wolfpack-broker" "dist/wolfpack-broker-${target}"
  chmod 755 "dist/wolfpack-${target}" "dist/wolfpack-broker-${target}"
  chmod 755 "dist/npm/wolfpack-bridge-${target}/wolfpack" "dist/npm/wolfpack-bridge-${target}/wolfpack-broker"
done
codesign --sign - --force dist/wolfpack-darwin-arm64
codesign --sign - --force dist/wolfpack-darwin-x64
cp dist/wolfpack-darwin-arm64 dist/npm/wolfpack-bridge-darwin-arm64/wolfpack
cp dist/wolfpack-darwin-x64 dist/npm/wolfpack-bridge-darwin-x64/wolfpack
chmod 755 dist/npm/wolfpack-bridge-darwin-arm64/wolfpack dist/npm/wolfpack-bridge-darwin-x64/wolfpack
for target in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
  cmp "dist/wolfpack-${target}" "dist/npm/wolfpack-bridge-${target}/wolfpack"
  cmp "dist/wolfpack-broker-${target}" "dist/npm/wolfpack-bridge-${target}/wolfpack-broker"
done
codesign --verify --strict dist/wolfpack-darwin-arm64
codesign --verify --strict dist/wolfpack-darwin-x64
codesign --verify --strict dist/wolfpack-broker-darwin-arm64
codesign --verify --strict dist/wolfpack-broker-darwin-x64
test "$(lipo -archs dist/wolfpack-darwin-arm64)" = arm64
test "$(lipo -archs dist/wolfpack-broker-darwin-arm64)" = arm64
test "$(lipo -archs dist/wolfpack-darwin-x64)" = x86_64
test "$(lipo -archs dist/wolfpack-broker-darwin-x64)" = x86_64
