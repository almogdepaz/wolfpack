#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

(
  cd dist
  shasum -a 256 \
    wolfpack-linux-x64 wolfpack-linux-arm64 \
    wolfpack-darwin-x64 wolfpack-darwin-arm64 \
    wolfpack-broker-linux-x64 wolfpack-broker-linux-arm64 \
    wolfpack-broker-darwin-x64 wolfpack-broker-darwin-arm64 \
    THIRD_PARTY_NOTICES
) > dist/checksums-sha256.txt
tar -czf "$RUNNER_TEMP/release-final-bundle.tar.gz" dist
