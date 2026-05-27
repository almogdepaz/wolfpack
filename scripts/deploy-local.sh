#!/bin/bash
set -e
cd "$(dirname "$0")/.."
VERIFY_TIMEOUT_SECS="${DEPLOY_VERIFY_TIMEOUT_SECS:-20}"

service_pid() {
  launchctl list | awk -v label="$1" '$3 == label && $1 ~ /^[0-9]+$/ { print $1; exit }'
}

wait_for_pid_change() {
  local label="$1"
  local old_pid="$2"
  local name="$3"
  local attempts=$((VERIFY_TIMEOUT_SECS * 5))
  local pid=""
  local i=0
  while [ "$i" -le "$attempts" ]; do
    pid="$(service_pid "$label")"
    if [ -n "$pid" ] && [ "$pid" != "$old_pid" ]; then
      echo "$pid"
      return 0
    fi
    sleep 0.2
    i=$((i + 1))
  done
  echo "ERROR: $name did not restart (old pid: ${old_pid:-none}, current pid: ${pid:-none})" >&2
  return 1
}

config_port() {
  local config="$HOME/.wolfpack/config.json"
  if [ -f "$config" ]; then
    sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$config" | head -1
  fi
}

verify_served_app_bundle() {
  local port="$(config_port)"
  local expected actual tmp url attempts i last_error
  port="${port:-18790}"
  url="http://127.0.0.1:$port/app.bundle.js"
  expected="$(shasum -a 256 public/app.bundle.js | awk '{ print $1 }')"
  attempts=$((VERIFY_TIMEOUT_SECS * 5))
  i=0
  last_error="not checked"
  while [ "$i" -le "$attempts" ]; do
    tmp="$(mktemp)"
    if curl --fail --silent --show-error "$url" > "$tmp"; then
      actual="$(shasum -a 256 "$tmp" | awk '{ print $1 }')"
      rm -f "$tmp"
      if [ "$actual" = "$expected" ]; then
        return 0
      fi
      last_error="stale hash $actual"
    else
      rm -f "$tmp"
      last_error="unreachable"
    fi
    sleep 0.2
    i=$((i + 1))
  done
  echo "ERROR: server is not serving this build's app.bundle.js ($last_error)" >&2
  echo "  expected: $expected (public/app.bundle.js from this build)" >&2
  echo "  url:      $url" >&2
  return 1
}

bun run scripts/build.ts
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
  BIN="wolfpack-darwin-arm64"
else
  BIN="wolfpack-darwin-x64"
fi
cp "dist/$BIN" ~/.wolfpack/bin/wolfpack
codesign -f -s - ~/.wolfpack/bin/wolfpack
# Broker is a separate Rust binary spawned by the wolfpack server. Without
# this copy, server restarts pick up the new wolfpack code but the stale
# broker stays running (or gets respawned from the stale on-disk binary),
# silently masking broker-side fixes.
BROKER_UPDATED=0
if [ -f dist/wolfpack-broker ]; then
  cp dist/wolfpack-broker ~/.wolfpack/bin/wolfpack-broker
  codesign -f -s - ~/.wolfpack/bin/wolfpack-broker
  BROKER_UPDATED=1
fi
DOMAIN="gui/$(id -u)"
BROKER_SERVICE="com.wolfpack.broker"
BROKER_PLIST="$HOME/Library/LaunchAgents/$BROKER_SERVICE.plist"
if [ "$BROKER_UPDATED" = "1" ]; then
  OLD_BROKER_PID="$(service_pid "$BROKER_SERVICE")"
  if launchctl kickstart -k "$DOMAIN/$BROKER_SERVICE" 2>/dev/null; then
    NEW_BROKER_PID="$(wait_for_pid_change "$BROKER_SERVICE" "$OLD_BROKER_PID" "broker")"
    echo "broker restarted (pid ${OLD_BROKER_PID:-none} -> $NEW_BROKER_PID)"
  elif [ -f "$BROKER_PLIST" ]; then
    launchctl bootstrap "$DOMAIN" "$BROKER_PLIST"
    echo "broker bootstrapped"
  else
    echo "broker deployed — no broker plist found, run 'wolfpack service install' first"
  fi
fi
SERVICE="com.wolfpack.server"
PLIST="$HOME/Library/LaunchAgents/$SERVICE.plist"
OLD_SERVER_PID="$(service_pid "$SERVICE")"
if launchctl kickstart -k "$DOMAIN/$SERVICE" 2>/dev/null; then
  NEW_SERVER_PID="$(wait_for_pid_change "$SERVICE" "$OLD_SERVER_PID" "server")"
  verify_served_app_bundle
  echo "deployed and restarted (pid ${OLD_SERVER_PID:-none} -> $NEW_SERVER_PID)"
elif [ -f "$PLIST" ]; then
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "deployed and bootstrapped"
else
  echo "deployed — no plist found, run 'wolfpack service install' first"
fi
