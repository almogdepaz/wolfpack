#!/usr/bin/env bash

# Re-exec under bash if running under a different shell (e.g. dash on Ubuntu)
if [ -z "$BASH_VERSION" ]; then
  if [ -f "$0" ]; then
    exec bash "$0" "$@"
  else
    echo "  This installer requires bash. Please run:"
    echo "    curl -fsSL https://raw.githubusercontent.com/almogdepaz/wolfpack/main/install.sh | bash"
    exit 1
  fi
fi

set +e

REPO_OWNER="almogdepaz"
REPO_NAME="wolfpack"
INSTALL_DIR="$HOME/.wolfpack/bin"
BINARY_NAME="wolfpack"

bold() { printf "\033[1m%s\033[0m" "$1"; }
green() { printf "\033[32m%s\033[0m" "$1"; }
red() { printf "\033[31m%s\033[0m" "$1"; }
yellow() { printf "\033[33m%s\033[0m" "$1"; }
dim() { printf "\033[2m%s\033[0m" "$1"; }

SEMVER_CORE_IDENTIFIER='(0|[1-9][0-9]*)'
SEMVER_PRERELEASE_IDENTIFIER='(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)'
SEMVER_BUILD_IDENTIFIER='[0-9A-Za-z-]+'
SEMVER_RELEASE_TAG_PATTERN="^v${SEMVER_CORE_IDENTIFIER}\\.${SEMVER_CORE_IDENTIFIER}\\.${SEMVER_CORE_IDENTIFIER}(-${SEMVER_PRERELEASE_IDENTIFIER}(\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?(\\+${SEMVER_BUILD_IDENTIFIER}(\\.${SEMVER_BUILD_IDENTIFIER})*)?$"
SEMVER_VERSION_PATTERN="^${SEMVER_RELEASE_TAG_PATTERN#^v}"

if [ "${WOLFPACK_RELEASE_TAG+x}" = "x" ]; then
  if [[ ! "$WOLFPACK_RELEASE_TAG" =~ $SEMVER_RELEASE_TAG_PATTERN ]]; then
    echo "  $(red 'Invalid WOLFPACK_RELEASE_TAG. Expected a semantic release tag such as v1.6.20-rc.1.')"
    exit 1
  fi
  RELEASE_DOWNLOAD_PATH="releases/download/${WOLFPACK_RELEASE_TAG}"
  RELEASE_PAGE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/${WOLFPACK_RELEASE_TAG}"
else
  RELEASE_DOWNLOAD_PATH="releases/latest/download"
  RELEASE_PAGE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest"
fi

# Detect OS
IS_MACOS=false
IS_LINUX=false
if [[ "$OSTYPE" == "darwin"* ]]; then
  IS_MACOS=true
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  IS_LINUX=true
fi

# Detect OS + arch and map to binary name
detect_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *)
      echo "  $(red "Unsupported OS: $os")"
      exit 1
      ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)
      echo "  $(red "Unsupported architecture: $arch")"
      exit 1
      ;;
  esac

  echo "${BINARY_NAME}-${os}-${arch}"
}

cat << 'WOLF'

        ...:.
           :=+=:
       . .-*####+-
      .- :++**####*=.
       -  :+***#####*=:.
       :   .+**######*+==++++++=:..
       ..   .=*#######*++++====+=--=-.
       .:.-    -+**######**+*#*+=-:-===:
     -.  ..     -++++***#**++*#*--:---===:
     -.:--==+=--=*++*+**********+==------++-
     .:----=++*++##########******+=====--=+#=-.
       .::-----=++*#%%%%%%#***###*+===--==+*=++=:.
         ...::::-=+*#%%############*+-----===+****+=:.

WOLF
echo "  $(bold 'WOLFPACK')"
echo "  $(dim 'Wolfpack is a self-hosted control room for persistent coding-agent terminals on your own machines.')"
echo ""

# ── Phone and remote access ──

if command -v tailscale &>/dev/null || { $IS_MACOS && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; }; then
  echo "  $(green '✓') Tailscale"
else
  echo "  $(dim '○') Tailscale not found $(dim '(setup will offer to install it for secure phone and remote access; decline for local-only)')"
fi

echo ""

# ── Download binaries ──

TARGET=$(detect_target)
PLATFORM_TARGET="${TARGET#${BINARY_NAME}-}"
BROKER_BINARY_NAME="wolfpack-broker"
BROKER_TARGET="${BROKER_BINARY_NAME}-${PLATFORM_TARGET}"
RELEASE_BASE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/${RELEASE_DOWNLOAD_PATH}"
DOWNLOAD_URL="${RELEASE_BASE_URL}/${TARGET}"
BROKER_DOWNLOAD_URL="${RELEASE_BASE_URL}/${BROKER_TARGET}"
CHECKSUMS_DOWNLOAD_URL="${RELEASE_BASE_URL}/checksums-sha256.txt"

echo "  Detected target: $(bold "$PLATFORM_TARGET")"
echo "  Downloading from GitHub releases..."

mkdir -p "$INSTALL_DIR"
STAGING_DIR=$(mktemp -d "${INSTALL_DIR}/.install.XXXXXX") || {
  echo "  $(red 'Could not create installation staging directory.')"
  exit 1
}
cleanup_staging() { rm -rf "$STAGING_DIR"; }
trap cleanup_staging EXIT
STAGED_WOLFPACK="${STAGING_DIR}/${BINARY_NAME}"
STAGED_BROKER="${STAGING_DIR}/${BROKER_BINARY_NAME}"
STAGED_CHECKSUMS="${STAGING_DIR}/checksums-sha256.txt"

download_asset() {
  local url="$1"
  local destination="$2"
  if command -v curl &>/dev/null; then
    curl -fSL --progress-bar -o "$destination" "$url"
  elif command -v wget &>/dev/null; then
    wget -q --show-progress -O "$destination" "$url"
  else
    echo "  $(red 'Neither curl nor wget found. Cannot download.')"
    return 127
  fi
}

if ! download_asset "$CHECKSUMS_DOWNLOAD_URL" "$STAGED_CHECKSUMS"; then
  echo ""
  echo "  $(red "Checksum download failed.")"
  echo "  URL: $CHECKSUMS_DOWNLOAD_URL"
  exit 1
fi
if ! download_asset "$DOWNLOAD_URL" "$STAGED_WOLFPACK"; then
  echo ""
  echo "  $(red 'Download failed.')"
  echo "  URL: $DOWNLOAD_URL"
  echo "  Check that a release exists at:"
  echo "    $RELEASE_PAGE_URL"
  exit 1
fi
if ! download_asset "$BROKER_DOWNLOAD_URL" "$STAGED_BROKER"; then
  echo ""
  echo "  $(red 'Download failed.')"
  echo "  URL: $BROKER_DOWNLOAD_URL"
  exit 1
fi

for artifact in "$STAGED_WOLFPACK" "$STAGED_BROKER"; do
  if [ ! -e "$artifact" ]; then
    echo "  $(red 'Downloaded artifact is empty.')"
    exit 1
  fi
  if [ -L "$artifact" ] || [ ! -f "$artifact" ]; then
    echo "  $(red 'Downloaded artifact is not a regular file.')"
    exit 1
  fi
  if [ ! -s "$artifact" ]; then
    echo "  $(red 'Downloaded artifact is empty.')"
    exit 1
  fi
  chmod +x "$artifact" || {
    echo "  $(red 'Failed to mark downloaded artifact executable.')"
    exit 1
  }
done

sha256_file() {
  if command -v shasum &>/dev/null; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif command -v sha256sum &>/dev/null; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    echo "  $(red "Neither shasum nor sha256sum found. Cannot verify downloads.")" >&2
    return 127
  fi
}

verify_checksum() {
  local artifact="$1"
  local asset_name="$2"
  local expected actual
  expected="$(awk -v name="$asset_name" '$2 == name { print $1; exit }' "$STAGED_CHECKSUMS")"
  actual="$(sha256_file "$artifact")" || return 1
  if [[ ! "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || [ "$actual" != "$expected" ]; then
    echo "  $(red "Checksum verification failed for ${asset_name}.")"
    return 1
  fi
}

verify_checksum "$STAGED_WOLFPACK" "$TARGET" || exit 1
verify_checksum "$STAGED_BROKER" "$BROKER_TARGET" || exit 1

# Remove macOS quarantine/provenance flags and ad-hoc sign both staged assets
# before replacing a working installation.
if $IS_MACOS; then
  for artifact in "$STAGED_WOLFPACK" "$STAGED_BROKER"; do
    xattr -cr "$artifact" 2>/dev/null
    if ! codesign --sign - --force "$artifact" 2>/dev/null; then
      echo ""
      echo "  $(red 'Failed to codesign binary. macOS will block unsigned binaries.')"
      echo "  Install Xcode CLI tools and re-run:"
      echo "    $(bold 'xcode-select --install')"
      exit 1
    fi
  done
fi

SELECTED_RELEASE_TAG="${WOLFPACK_RELEASE_TAG:-}"
if [ -z "$SELECTED_RELEASE_TAG" ]; then
  if ! SELECTED_VERSION="$("$STAGED_WOLFPACK" --version 2>/dev/null)" \
    || [[ ! "$SELECTED_VERSION" =~ $SEMVER_VERSION_PATTERN ]]; then
    echo "  $(red 'Downloaded wolfpack binary did not report a valid machine-readable version.')"
    exit 1
  fi
  SELECTED_RELEASE_TAG="v${SELECTED_VERSION}"
fi

MANAGED_BINARY="${INSTALL_DIR}/${BINARY_NAME}"
MANAGED_BROKER="${INSTALL_DIR}/${BROKER_BINARY_NAME}"
SERVICE_EXISTS=false
BROKER_WAS_RUNNING=false
SERVER_WAS_RUNNING=false
PAIR_REPLACED=false
PAIR_ALREADY_MATCHED=false

if $IS_MACOS; then
  SERVER_SERVICE_PATH="$HOME/Library/LaunchAgents/com.wolfpack.server.plist"
  BROKER_SERVICE_PATH="$HOME/Library/LaunchAgents/com.wolfpack.broker.plist"
elif $IS_LINUX; then
  SERVER_SERVICE_PATH="$HOME/.config/systemd/user/wolfpack.service"
  BROKER_SERVICE_PATH="$HOME/.config/systemd/user/wolfpack-broker.service"
fi

if [ -f "$SERVER_SERVICE_PATH" ] || [ -f "$BROKER_SERVICE_PATH" ]; then
  SERVICE_EXISTS=true
fi

INSTALL_SKIP_SETUP=0
if [ "${WOLFPACK_INSTALL_SKIP_SETUP:-0}" = "1" ]; then
  INSTALL_SKIP_SETUP=1
fi

if [ "$INSTALL_SKIP_SETUP" != "1" ] && { [ ! -t 1 ] || ! { : < /dev/tty; } 2>/dev/null; }; then
  echo "  $(red 'Setup requires an interactive TTY.')"
  exit 1
fi

server_service_running() {
  if $IS_MACOS; then
    launchctl print "gui/$(id -u)/com.wolfpack.server" 2>/dev/null | grep -Eq 'pid[[:space:]]*=[[:space:]]*[0-9]+'
  elif $IS_LINUX; then
    systemctl --user is-active wolfpack >/dev/null 2>&1
  else
    return 1
  fi
}

broker_service_running() {
  if $IS_MACOS; then
    launchctl print "gui/$(id -u)/com.wolfpack.broker" 2>/dev/null | grep -Eq 'pid[[:space:]]*=[[:space:]]*[0-9]+'
  elif $IS_LINUX; then
    systemctl --user is-active wolfpack-broker >/dev/null 2>&1
  else
    return 1
  fi
}

managed_services_running() {
  if $IS_MACOS; then
    launchctl print "gui/$(id -u)/com.wolfpack.broker" 2>/dev/null | grep -Eq 'pid[[:space:]]*=[[:space:]]*[0-9]+' \
      && launchctl print "gui/$(id -u)/com.wolfpack.server" 2>/dev/null | grep -Eq 'pid[[:space:]]*=[[:space:]]*[0-9]+'
  elif $IS_LINUX; then
    systemctl --user is-active wolfpack-broker >/dev/null 2>&1 \
      && systemctl --user is-active wolfpack >/dev/null 2>&1
  else
    return 1
  fi
}

managed_services_inactive() {
  if $IS_MACOS; then
    ! launchctl print "gui/$(id -u)/com.wolfpack.server" 2>/dev/null | grep -Eq 'pid[[:space:]]*=[[:space:]]*[0-9]+' \
      && ! launchctl print "gui/$(id -u)/com.wolfpack.broker" 2>/dev/null | grep -Eq 'pid[[:space:]]*=[[:space:]]*[0-9]+'
  elif $IS_LINUX; then
    ! systemctl --user is-active wolfpack >/dev/null 2>&1 \
      && ! systemctl --user is-active wolfpack-broker >/dev/null 2>&1
  else
    return 1
  fi
}

print_reinstall_command() {
  if [ "$INSTALL_SKIP_SETUP" = "1" ]; then
    echo "  Reinstall: curl -fsSL \"https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${SELECTED_RELEASE_TAG}/install.sh\" | WOLFPACK_RELEASE_TAG=\"${SELECTED_RELEASE_TAG}\" WOLFPACK_INSTALL_SKIP_SETUP=\"1\" WOLFPACK_INSTALL_RETRY_ACTIVATION=\"1\" bash"
  else
    echo "  Reinstall: curl -fsSL \"https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${SELECTED_RELEASE_TAG}/install.sh\" | WOLFPACK_RELEASE_TAG=\"${SELECTED_RELEASE_TAG}\" WOLFPACK_INSTALL_RETRY_ACTIVATION=\"1\" bash"
  fi
}

remove_managed_service_descriptors() {
  if $IS_MACOS; then
    launchctl bootout "gui/$(id -u)/com.wolfpack.server" 2>/dev/null || true
    launchctl bootout "gui/$(id -u)/com.wolfpack.broker" 2>/dev/null || true
    if ! rm -f "$SERVER_SERVICE_PATH" "$BROKER_SERVICE_PATH"; then
      echo "  $(red 'Failed to remove managed service descriptors.')"
      return 1
    fi
  elif $IS_LINUX; then
    systemctl --user disable wolfpack 2>/dev/null || true
    systemctl --user disable wolfpack-broker 2>/dev/null || true
    if ! rm -f "$SERVER_SERVICE_PATH" "$BROKER_SERVICE_PATH"; then
      echo "  $(red 'Failed to remove managed service descriptors.')"
      return 1
    fi
  fi
}

managed_pair_matches() {
  [ ! -L "$MANAGED_BINARY" ] && [ -f "$MANAGED_BINARY" ] && [ -x "$MANAGED_BINARY" ] \
    && [ ! -L "$MANAGED_BROKER" ] && [ -f "$MANAGED_BROKER" ] && [ -x "$MANAGED_BROKER" ] \
    && cmp -s "$STAGED_WOLFPACK" "$MANAGED_BINARY" \
    && cmp -s "$STAGED_BROKER" "$MANAGED_BROKER"
}

if managed_pair_matches; then
  chmod 0755 "$MANAGED_BINARY" "$MANAGED_BROKER" || exit 1
  PAIR_ALREADY_MATCHED=true
  echo "  $(green '✓') Managed wolfpack and broker pair already matches the selected release."
else
  if broker_service_running; then
    BROKER_WAS_RUNNING=true
    SERVICE_EXISTS=true
    echo "  $(yellow 'Warning: broker-owned sessions will end when the broker is replaced.')"
    if [ "${WOLFPACK_INSTALL_ALLOW_SESSION_LOSS:-0}" = "1" ]; then
      :
    elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
      printf "  Continue with session loss? [y/N] " > /dev/tty
      read -r INSTALL_CONFIRMATION < /dev/tty
      if [[ "$INSTALL_CONFIRMATION" != "y" && "$INSTALL_CONFIRMATION" != "Y" ]]; then
        echo "  $(dim 'Aborted.')"
        exit 1
      fi
    else
      echo "  $(red 'Refusing unattended broker replacement without WOLFPACK_INSTALL_ALLOW_SESSION_LOSS=1.')"
      exit 1
    fi
  fi

  if server_service_running; then
    SERVER_WAS_RUNNING=true
    SERVICE_EXISTS=true
  fi

  # Broker-owned PTYs make pair replacement deliberately destructive. Stop
  # server then broker before removing only those descriptors.
  if $SERVER_WAS_RUNNING || $BROKER_WAS_RUNNING; then
    if $IS_MACOS; then
      launchctl bootout "gui/$(id -u)/com.wolfpack.server" 2>/dev/null || true
      launchctl bootout "gui/$(id -u)/com.wolfpack.broker" 2>/dev/null || true
    elif $IS_LINUX; then
      systemctl --user stop wolfpack || true
      systemctl --user stop wolfpack-broker || true
    fi
    if ! managed_services_inactive; then
      echo "  $(red 'Managed services are still active; refusing replacement.')"
      exit 1
    fi
  fi

  if $SERVICE_EXISTS && ! remove_managed_service_descriptors; then
    exit 1
  fi

  rm -f "$MANAGED_BINARY" "$MANAGED_BROKER"
  mv -f "$STAGED_WOLFPACK" "$MANAGED_BINARY" || exit 1
  mv -f "$STAGED_BROKER" "$MANAGED_BROKER" || exit 1
  chmod 0755 "$MANAGED_BINARY" "$MANAGED_BROKER" || exit 1
  PAIR_REPLACED=true

  echo "  $(green '✓') Binary installed to ${MANAGED_BINARY}"
  echo "  $(green '✓') Broker installed to ${MANAGED_BROKER}"

fi

activate_replaced_services() {
  if $SERVICE_EXISTS || [ "${WOLFPACK_INSTALL_RETRY_ACTIVATION:-0}" = "1" ]; then
    if ! managed_services_running && ! "$MANAGED_BINARY" service install; then
      echo "  $(red 'Managed service activation failed.')"
      print_reinstall_command
      return 1
    fi
    if ! managed_services_running; then
      echo "  $(red 'Managed service activation failed.')"
      print_reinstall_command
      return 1
    fi
  fi
}

echo ""

# ── Add to PATH ──

SYMLINK_DIR="${WOLFPACK_SYMLINK_DIR:-/usr/local/bin}"

# Preserve foreign commands. The managed binary is always refreshed at
# INSTALL_DIR, and setup always executes that exact path below.
EXISTING=$(command -v wolfpack 2>/dev/null || true)
MANAGED_BINARY="${INSTALL_DIR}/${BINARY_NAME}"
MANAGED_LINK="${SYMLINK_DIR}/${BINARY_NAME}"
NEEDS_LINK=true

if [ "$EXISTING" = "$MANAGED_BINARY" ]; then
  echo "  $(green '✓') wolfpack is already on PATH"
  NEEDS_LINK=false
elif [ -n "$EXISTING" ]; then
  echo "  $(dim "Existing wolfpack at ${EXISTING} was left unchanged.")"
fi

if [ -e "$MANAGED_LINK" ] || [ -L "$MANAGED_LINK" ]; then
  if [ -L "$MANAGED_LINK" ] && [ "$(readlink "$MANAGED_LINK")" = "$MANAGED_BINARY" ]; then
    echo "  $(green '✓') wolfpack is already linked at ${MANAGED_LINK}"
  else
    echo "  $(dim "Existing ${MANAGED_LINK} was left unchanged.")"
  fi
  NEEDS_LINK=false
fi

if $NEEDS_LINK; then
  if [ -d "$SYMLINK_DIR" ] && [ -w "$SYMLINK_DIR" ]; then
    ln -s "$MANAGED_BINARY" "$MANAGED_LINK"
    echo "  $(green '✓') Symlinked to ${MANAGED_LINK}"
  elif [ -d "$SYMLINK_DIR" ]; then
    echo "  Creating symlink in ${SYMLINK_DIR} (requires sudo)..."
    if sudo ln -s "$MANAGED_BINARY" "$MANAGED_LINK"; then
      echo "  $(green '✓') Symlinked to ${MANAGED_LINK}"
    else
      echo "  $(dim "Could not symlink to ${SYMLINK_DIR}")"
      echo "  Add to your PATH manually:"
      echo "    export PATH=\"${INSTALL_DIR}:\$PATH\""
    fi
  else
    echo "  Add to your PATH manually:"
    echo "    export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi
fi

echo ""

# ── Run setup ──

if [ "$INSTALL_SKIP_SETUP" != "1" ]; then
  if [ ! -x "$MANAGED_BINARY" ]; then
    echo "  $(red '✗') wolfpack binary not found after install"
    exit 1
  fi

  echo "  $(green '✓') $(bold 'wolfpack') installed"
  echo ""
  echo "  Run $(bold 'wolfpack') to start."
  echo ""
  if $SERVICE_EXISTS; then
    "$MANAGED_BINARY" setup --defer-service-restart < /dev/tty || exit "$?"
    if $PAIR_REPLACED || [ "${WOLFPACK_INSTALL_RETRY_ACTIVATION:-0}" = "1" ]; then
      activate_replaced_services || exit 1
    fi
  elif [ "${WOLFPACK_INSTALL_RETRY_ACTIVATION:-0}" = "1" ]; then
    "$MANAGED_BINARY" setup < /dev/tty || exit "$?"
    activate_replaced_services || exit 1
  else
    exec "$MANAGED_BINARY" setup < /dev/tty
  fi
elif $PAIR_REPLACED || [ "${WOLFPACK_INSTALL_RETRY_ACTIVATION:-0}" = "1" ]; then
  activate_replaced_services || exit 1
fi
