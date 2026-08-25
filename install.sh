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
dim() { printf "\033[2m%s\033[0m" "$1"; }

SEMVER_CORE_IDENTIFIER='(0|[1-9][0-9]*)'
SEMVER_PRERELEASE_IDENTIFIER='(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)'
SEMVER_BUILD_IDENTIFIER='[0-9A-Za-z-]+'
SEMVER_RELEASE_TAG_PATTERN="^v${SEMVER_CORE_IDENTIFIER}\\.${SEMVER_CORE_IDENTIFIER}\\.${SEMVER_CORE_IDENTIFIER}(-${SEMVER_PRERELEASE_IDENTIFIER}(\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?(\\+${SEMVER_BUILD_IDENTIFIER}(\\.${SEMVER_BUILD_IDENTIFIER})*)?$"

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

mv -f "$STAGED_WOLFPACK" "${INSTALL_DIR}/${BINARY_NAME}" || exit 1
mv -f "$STAGED_BROKER" "${INSTALL_DIR}/${BROKER_BINARY_NAME}" || exit 1

echo "  $(green '✓') Binary installed to ${INSTALL_DIR}/${BINARY_NAME}"
echo "  $(green '✓') Broker installed to ${INSTALL_DIR}/${BROKER_BINARY_NAME}"

# ── Detect an existing service (upgrade path) ──

SERVICE_EXISTS=false
if $IS_MACOS && [ -f "$HOME/Library/LaunchAgents/com.wolfpack.server.plist" ]; then
  SERVICE_EXISTS=true
elif $IS_LINUX && [ -f "$HOME/.config/systemd/user/wolfpack.service" ]; then
  SERVICE_EXISTS=true
fi

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

if [ "${WOLFPACK_INSTALL_SKIP_SETUP:-0}" != "1" ]; then
  if [ -x "$MANAGED_BINARY" ]; then
    echo "  $(green '✓') $(bold 'wolfpack') installed"
    echo ""
    echo "  Run $(bold 'wolfpack') to start."
    echo ""
    if $SERVICE_EXISTS && [ -f "$HOME/.wolfpack/config.json" ]; then
      "$MANAGED_BINARY" setup --defer-service-restart < /dev/tty || exit "$?"
    else
      exec "$MANAGED_BINARY" setup < /dev/tty
    fi
  else
    echo "  $(red '✗') wolfpack binary not found after install"
    exit 1
  fi
fi

# ── Restart service after successful setup (upgrade path) ──

if $SERVICE_EXISTS && [ -f "$HOME/.wolfpack/config.json" ]; then
  echo "  Restarting service with new binary..."
  if "$MANAGED_BINARY" service restart --server-only 2>/dev/null; then
    echo "  $(green '✓') Server service restarted"
  else
    echo "  $(dim 'Server restart failed — run: wolfpack service restart')"
    exit 1
  fi
fi
