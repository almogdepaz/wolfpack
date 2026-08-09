#!/bin/bash
set -euo pipefail

usage() {
  echo "Usage: scripts/deploy-local.sh --broker=yes|no" >&2
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi
case "$1" in
  --broker=yes) DEPLOY_BROKER=1 ;;
  --broker=no) DEPLOY_BROKER=0 ;;
  *)
    usage
    exit 2
    ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: scripts/deploy-local.sh supports macOS only; Linux release installs use wolfpack service commands" >&2
  exit 1
fi

if [ "$DEPLOY_BROKER" = "1" ] && [ -n "${WOLFPACK_SESSION_NAME:-}" ]; then
  echo "ERROR: --broker=yes cannot run from a broker-owned Wolfpack session; run it from an external terminal" >&2
  exit 1
fi

if [ "$DEPLOY_BROKER" = "1" ] && [ "${WOLFPACK_DEPLOY_ALLOW_NONINTERACTIVE:-0}" != "1" ] && [ ! -t 0 ]; then
  echo "ERROR: --broker=yes must be run from an interactive external terminal; set WOLFPACK_DEPLOY_ALLOW_NONINTERACTIVE=1 only for a known one-shot supervisor" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
VERIFY_TIMEOUT_SECS="${DEPLOY_VERIFY_TIMEOUT_SECS:-20}"
DOMAIN="gui/$(id -u)"
SERVER_SERVICE="com.wolfpack.server"
BROKER_SERVICE="com.wolfpack.broker"
SERVER_PLIST="$HOME/Library/LaunchAgents/$SERVER_SERVICE.plist"
BROKER_PLIST="$HOME/Library/LaunchAgents/$BROKER_SERVICE.plist"
INSTALL_DIR="$HOME/.wolfpack/bin"
SERVER_INSTALL="$INSTALL_DIR/wolfpack"
BROKER_INSTALL="$INSTALL_DIR/wolfpack-broker"
ACTIVE_STAGE=""
SESSION_BEFORE=""
SESSION_AFTER=""
HELP_OUTPUT=""
HELP_ERROR=""
DEPLOY_LOCK_DIR="$HOME/.wolfpack/deploy.lock"
DEPLOY_LOCK_HELD=0
DEPLOY_MUTATION_STARTED=0
DEPLOY_SUCCEEDED=0

cleanup() {
  [ -z "$ACTIVE_STAGE" ] || rm -f "$ACTIVE_STAGE"
  [ -z "$SESSION_BEFORE" ] || rm -f "$SESSION_BEFORE"
  [ -z "$SESSION_AFTER" ] || rm -f "$SESSION_AFTER"
  [ -z "$HELP_OUTPUT" ] || rm -f "$HELP_OUTPUT"
  [ -z "$HELP_ERROR" ] || rm -f "$HELP_ERROR"
  if [ "$DEPLOY_LOCK_HELD" = "1" ]; then
    if [ "$DEPLOY_SUCCEEDED" = "1" ] || [ "$DEPLOY_MUTATION_STARTED" = "0" ]; then
      rm -rf "$DEPLOY_LOCK_DIR"
    else
      date -u '+%Y-%m-%dT%H:%M:%SZ' > "$DEPLOY_LOCK_DIR/failed_at" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT

acquire_deploy_lock() {
  mkdir -p "$HOME/.wolfpack"
  if mkdir "$DEPLOY_LOCK_DIR" 2>/dev/null; then
    DEPLOY_LOCK_HELD=1
    printf '%s\n' "$$" > "$DEPLOY_LOCK_DIR/pid"
    date -u '+%Y-%m-%dT%H:%M:%SZ' > "$DEPLOY_LOCK_DIR/started_at"
    return 0
  fi

  local holder=""
  holder="$(cat "$DEPLOY_LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$holder" ]; then
    echo "ERROR: another Wolfpack deploy is already running (pid $holder); remove $DEPLOY_LOCK_DIR only after verifying no deploy is active" >&2
  else
    echo "ERROR: another Wolfpack deploy is already running; remove $DEPLOY_LOCK_DIR only after verifying no deploy is active" >&2
  fi
  exit 1
}

acquire_deploy_lock

service_pid() {
  # Consume the complete launchctl stream. Exiting awk after the first match
  # makes launchctl receive SIGPIPE under `set -o pipefail` on larger lists.
  launchctl list | awk -v label="$1" '$3 == label && $1 ~ /^[0-9]+$/ { print $1 }'
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

# bootout returns before launchd necessarily finishes unregistering the job.
# Bootstrap during that window fails with "operation already in progress".
wait_for_service_unloaded() {
  local label="$1"
  local name="$2"
  local attempts=$((VERIFY_TIMEOUT_SECS * 5))
  local i=0
  while [ "$i" -le "$attempts" ]; do
    if ! launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
    i=$((i + 1))
  done
  echo "ERROR: $name did not finish unloading" >&2
  return 1
}

start_replacement_service() {
  local label="$1"
  local plist="$2"
  local old_pid="$3"
  local name="$4"
  local pid_variable="$5"
  local new_pid

  if [ -f "$plist" ]; then
    if [ -n "$old_pid" ]; then
      launchctl bootout "$DOMAIN/$label"
    else
      launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    fi
    wait_for_service_unloaded "$label" "$name"
    launchctl bootstrap "$DOMAIN" "$plist"
  elif ! launchctl kickstart -k "$DOMAIN/$label" 2>/dev/null; then
    echo "ERROR: $name service is not installed; run 'wolfpack service install' first" >&2
    return 1
  fi

  new_pid="$(wait_for_pid_change "$label" "$old_pid" "$name")"
  printf -v "$pid_variable" '%s' "$new_pid"
}

config_port() {
  local config="$HOME/.wolfpack/config.json"
  if [ -f "$config" ]; then
    sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$config" | head -1
  fi
}

sha256() {
  shasum -a 256 "$1" | awk '{ print $1 }'
}

install_signed() {
  local source="$1"
  local destination="$2"
  local hash_variable="$3"
  local staged_hash installed_hash

  if [ ! -f "$source" ]; then
    echo "ERROR: deployment artifact is missing: $source" >&2
    return 1
  fi
  ACTIVE_STAGE="$(mktemp "${destination}.new.XXXXXX")"
  cp "$source" "$ACTIVE_STAGE"
  chmod 755 "$ACTIVE_STAGE"
  codesign -f -s - "$ACTIVE_STAGE"
  staged_hash="$(sha256 "$ACTIVE_STAGE")"
  mv -f "$ACTIVE_STAGE" "$destination"
  ACTIVE_STAGE=""
  installed_hash="$(sha256 "$destination")"
  if [ "$installed_hash" != "$staged_hash" ]; then
    echo "ERROR: installed artifact hash mismatch for $destination" >&2
    return 1
  fi
  printf -v "$hash_variable" '%s' "$installed_hash"
}

verify_served_app_bundle() {
  local port="$1"
  local expected actual tmp url attempts i last_error
  url="http://127.0.0.1:$port/app.bundle.js"
  expected="$(sha256 public/app.bundle.js)"
  attempts=$((VERIFY_TIMEOUT_SECS * 5))
  i=0
  last_error="not checked"
  while [ "$i" -le "$attempts" ]; do
    tmp="$(mktemp)"
    if curl --connect-timeout 1 --max-time 2 --fail --silent --show-error "$url" > "$tmp"; then
      actual="$(sha256 "$tmp")"
      rm -f "$tmp"
      if [ "$actual" = "$expected" ]; then
        SERVED_BUNDLE_HASH="$actual"
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

verify_api_info() {
  local port="$1"
  local url tmp attempts i
  url="http://127.0.0.1:$port/api/info"
  attempts=$((VERIFY_TIMEOUT_SECS * 5))
  i=0
  while [ "$i" -le "$attempts" ]; do
    tmp="$(mktemp)"
    if curl --connect-timeout 1 --max-time 2 --fail --silent --show-error "$url" > "$tmp" \
      && jq -e '.name | type == "string"' "$tmp" >/dev/null \
      && jq -e '.version | type == "string"' "$tmp" >/dev/null; then
      SERVER_VERSION="$(jq -r '.version' "$tmp")"
      rm -f "$tmp"
      return 0
    fi
    rm -f "$tmp"
    sleep 0.2
    i=$((i + 1))
  done
  echo "ERROR: server API health check failed at $url" >&2
  return 1
}

verify_cli_help() {
  HELP_OUTPUT="$(mktemp)"
  HELP_ERROR="$(mktemp)"
  if ! env -u WOLFPACK_SESSION_NAME -u WOLFPACK_AGENT_KIND NO_COLOR=1 WOLFPACK_SERVICE=1 \
    "$SERVER_INSTALL" session open --help > "$HELP_OUTPUT" 2> "$HELP_ERROR"; then
    echo "ERROR: installed CLI help command failed" >&2
    cat "$HELP_ERROR" >&2
    return 1
  fi
  if ! grep -Fq 'Usage: wolfpack session open <project>' "$HELP_OUTPUT"; then
    echo "ERROR: installed CLI help output is invalid" >&2
    return 1
  fi
}

capture_sessions() {
  local port="$1"
  local destination="$2"
  if ! curl --connect-timeout 1 --max-time 2 --fail --silent --show-error \
    "http://127.0.0.1:$port/api/sessions" > "$destination"; then
    echo "ERROR: could not capture sessions for broker-preserving deployment" >&2
    return 1
  fi
  if ! jq -e '.sessions | type == "array"' "$destination" >/dev/null; then
    echo "ERROR: session API returned an invalid response" >&2
    return 1
  fi
}

verify_preserved_sessions() {
  local before="$1"
  local after="$2"
  if ! jq -e --slurpfile before "$before" '
    ($before[0].sessions | map({key:.name,value:.identity.wolfpackSessionId}) | from_entries) as $old
    | (.sessions | map({key:.name,value:.identity.wolfpackSessionId}) | from_entries) as $new
    | all($old | keys[]; $new[.] == $old[.])
  ' "$after" >/dev/null; then
    echo "ERROR: a pre-existing session identity changed or disappeared" >&2
    return 1
  fi
}

verify_service_pid() {
  local label="$1"
  local expected_pid="$2"
  local name="$3"
  local current_pid
  current_pid="$(service_pid "$label")"
  if [ -z "$current_pid" ] || [ "$current_pid" != "$expected_pid" ]; then
    echo "ERROR: $name pid changed before deployment verification completed (${expected_pid:-none} -> ${current_pid:-none})" >&2
    return 1
  fi
}

bun run scripts/build.ts

ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
  SERVER_SOURCE="dist/wolfpack-darwin-arm64"
else
  SERVER_SOURCE="dist/wolfpack-darwin-x64"
fi
BROKER_SOURCE="dist/wolfpack-broker"
PORT="$(config_port)"
PORT="${PORT:-18790}"
mkdir -p "$INSTALL_DIR"

OLD_SERVER_PID="$(service_pid "$SERVER_SERVICE")"
OLD_BROKER_PID="$(service_pid "$BROKER_SERVICE")"
if [ "$DEPLOY_BROKER" = "0" ]; then
  if [ -z "$OLD_SERVER_PID" ] || [ -z "$OLD_BROKER_PID" ]; then
    echo "ERROR: --broker=no requires running server and broker services" >&2
    exit 1
  fi
  SESSION_BEFORE="$(mktemp)"
  SESSION_AFTER="$(mktemp)"
  capture_sessions "$PORT" "$SESSION_BEFORE"
fi

SERVER_HASH=""
BROKER_HASH=""
DEPLOY_MUTATION_STARTED=1
install_signed "$SERVER_SOURCE" "$SERVER_INSTALL" SERVER_HASH

NEW_BROKER_PID="$OLD_BROKER_PID"
if [ "$DEPLOY_BROKER" = "1" ]; then
  install_signed "$BROKER_SOURCE" "$BROKER_INSTALL" BROKER_HASH
  start_replacement_service "$BROKER_SERVICE" "$BROKER_PLIST" "$OLD_BROKER_PID" "broker" NEW_BROKER_PID
  BROKER_RESTART_ACTION="$([ -f "$BROKER_PLIST" ] && echo reloaded || echo restarted)"
  echo "broker $BROKER_RESTART_ACTION (pid ${OLD_BROKER_PID:-none} -> $NEW_BROKER_PID)"
fi

NEW_SERVER_PID=""
start_replacement_service "$SERVER_SERVICE" "$SERVER_PLIST" "$OLD_SERVER_PID" "server" NEW_SERVER_PID
SERVER_RESTART_ACTION="$([ -f "$SERVER_PLIST" ] && echo reloaded || echo restarted)"
echo "server $SERVER_RESTART_ACTION (pid ${OLD_SERVER_PID:-none} -> $NEW_SERVER_PID)"

SERVED_BUNDLE_HASH=""
SERVER_VERSION=""
verify_served_app_bundle "$PORT"
verify_api_info "$PORT"
verify_cli_help
verify_service_pid "$SERVER_SERVICE" "$NEW_SERVER_PID" "server"
if [ "$DEPLOY_BROKER" = "1" ]; then
  verify_service_pid "$BROKER_SERVICE" "$NEW_BROKER_PID" "broker"
fi

PRESERVED_SESSIONS="null"
if [ "$DEPLOY_BROKER" = "0" ]; then
  NEW_BROKER_PID="$(service_pid "$BROKER_SERVICE")"
  if [ "$NEW_BROKER_PID" != "$OLD_BROKER_PID" ]; then
    echo "ERROR: broker pid changed during server-only deploy (${OLD_BROKER_PID:-none} -> ${NEW_BROKER_PID:-none})" >&2
    exit 1
  fi
  capture_sessions "$PORT" "$SESSION_AFTER"
  verify_preserved_sessions "$SESSION_BEFORE" "$SESSION_AFTER"
  PRESERVED_SESSIONS="$(jq '.sessions | length' "$SESSION_BEFORE")"
fi

DEPLOY_SUCCEEDED=1
jq -cn \
  --arg mode "$([ "$DEPLOY_BROKER" = "1" ] && echo yes || echo no)" \
  --argjson brokerDeployed "$([ "$DEPLOY_BROKER" = "1" ] && echo true || echo false)" \
  --arg oldServerPid "$OLD_SERVER_PID" \
  --arg serverPid "$NEW_SERVER_PID" \
  --arg oldBrokerPid "$OLD_BROKER_PID" \
  --arg brokerPid "$NEW_BROKER_PID" \
  --arg serverHash "$SERVER_HASH" \
  --arg brokerHash "$BROKER_HASH" \
  --arg bundleHash "$SERVED_BUNDLE_HASH" \
  --arg serverVersion "$SERVER_VERSION" \
  --argjson preservedSessions "$PRESERVED_SESSIONS" \
  '{
    mode:$mode,
    brokerDeployed:$brokerDeployed,
    oldServerPid:$oldServerPid,
    serverPid:$serverPid,
    oldBrokerPid:$oldBrokerPid,
    brokerPid:$brokerPid,
    serverHash:$serverHash,
    brokerHash:(if $brokerHash == "" then null else $brokerHash end),
    bundleHash:$bundleHash,
    serverVersion:$serverVersion,
    preservedSessions:$preservedSessions
  }'
