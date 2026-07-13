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
echo "  $(bold 'WOLFPACK') — AI Agent Bridge"
echo "  $(dim 'Deploy your pack. Command from anywhere.')"
echo ""

# ── Prerequisites ──

if command -v tmux &>/dev/null; then
  echo "  $(green '✓') tmux $(tmux -V)"
else
  echo "  $(dim '○') tmux not found — installing..."
  if $IS_MACOS; then
    if command -v brew &>/dev/null; then
      brew install --quiet tmux </dev/null || {
        echo "  $(red '✗') Failed to install tmux via brew."
        echo "  Install manually: $(bold 'brew install tmux')"
        exit 1
      }
    else
      echo "  $(red '✗') Homebrew is required to install tmux on macOS."
      echo "  Install Homebrew from https://brew.sh, then re-run this installer."
      exit 1
    fi
  elif $IS_LINUX; then
    if command -v apt &>/dev/null; then
      sudo apt update -qq </dev/null && sudo apt install -y -qq tmux </dev/null || {
        echo "  $(red '✗') Failed to install tmux via apt."
        echo "  Install manually: $(bold 'sudo apt install tmux')"
        exit 1
      }
    else
      echo "  $(red '✗') apt is required to install tmux on Linux."
      echo "  Install tmux manually with your package manager, then re-run this installer."
      exit 1
    fi
  else
    echo "  $(red '✗') Unsupported platform — install tmux manually, then re-run."
    exit 1
  fi
  echo "  $(green '✓') tmux $(tmux -V)"
fi

if command -v tailscale &>/dev/null || { $IS_MACOS && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; }; then
  echo "  $(green '✓') Tailscale"
else
  echo "  $(dim '○') Tailscale not found $(dim '(optional — needed for remote access)')"
fi

echo ""

# ── Download binaries ──

TARGET=$(detect_target)
PLATFORM_TARGET="${TARGET#${BINARY_NAME}-}"
BROKER_BINARY_NAME="wolfpack-broker"
BROKER_TARGET="${BROKER_BINARY_NAME}-${PLATFORM_TARGET}"
RELEASE_BASE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download"
DOWNLOAD_URL="${RELEASE_BASE_URL}/${TARGET}"
BROKER_DOWNLOAD_URL="${RELEASE_BASE_URL}/${BROKER_TARGET}"

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

if ! download_asset "$DOWNLOAD_URL" "$STAGED_WOLFPACK"; then
  echo ""
  echo "  $(red 'Download failed.')"
  echo "  URL: $DOWNLOAD_URL"
  echo "  Check that a release exists at:"
  echo "    https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest"
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

# ── Restart service if already installed (upgrade path) ──

SERVICE_EXISTS=false
if $IS_MACOS && [ -f "$HOME/Library/LaunchAgents/com.wolfpack.server.plist" ]; then
  SERVICE_EXISTS=true
elif $IS_LINUX && [ -f "$HOME/.config/systemd/user/wolfpack.service" ]; then
  SERVICE_EXISTS=true
fi

if $SERVICE_EXISTS && [ -f "$HOME/.wolfpack/config.json" ]; then
  echo "  Restarting service with new binary..."
  if "${INSTALL_DIR}/${BINARY_NAME}" service install 2>/dev/null; then
    echo "  $(green '✓') Service upgraded"
  else
    echo "  $(dim 'Service restart failed — run: wolfpack service install')"
  fi
fi

echo ""

# ── Add to PATH ──

SYMLINK_DIR="/usr/local/bin"

# Check if already on PATH — but verify it points to our binary
EXISTING=$(command -v wolfpack 2>/dev/null || true)
NEEDS_LINK=true

if [ -n "$EXISTING" ]; then
  RESOLVED=$(readlink -f "$EXISTING" 2>/dev/null || realpath "$EXISTING" 2>/dev/null || echo "$EXISTING")
  if [ "$RESOLVED" = "${INSTALL_DIR}/${BINARY_NAME}" ]; then
    echo "  $(green '✓') wolfpack is already on PATH"
    NEEDS_LINK=false
  else
    echo "  $(dim "Replacing stale wolfpack at ${EXISTING}")"
    rm -f "$EXISTING" 2>/dev/null || sudo rm -f "$EXISTING" 2>/dev/null || true
  fi
fi

if $NEEDS_LINK; then
  if [ -d "$SYMLINK_DIR" ] && [ -w "$SYMLINK_DIR" ]; then
    ln -sf "${INSTALL_DIR}/${BINARY_NAME}" "${SYMLINK_DIR}/${BINARY_NAME}"
    echo "  $(green '✓') Symlinked to ${SYMLINK_DIR}/${BINARY_NAME}"
  elif [ -d "$SYMLINK_DIR" ]; then
    echo "  Creating symlink in ${SYMLINK_DIR} (requires sudo)..."
    if sudo ln -sf "${INSTALL_DIR}/${BINARY_NAME}" "${SYMLINK_DIR}/${BINARY_NAME}"; then
      echo "  $(green '✓') Symlinked to ${SYMLINK_DIR}/${BINARY_NAME}"
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

if [ "${WOLFPACK_INSTALL_SKIP_SETUP:-0}" = "1" ]; then
  exit 0
fi

if command -v wolfpack &>/dev/null; then
  echo "  $(green '✓') $(bold 'wolfpack') installed"
  echo ""
  echo "  Run $(bold 'wolfpack') to start."
  echo ""
  echo "  $(bold 'Security:') Always use the Tailscale hostname URL — not your machine's IP (it won't work)."
  echo "  $(dim 'Set WOLFPACK_JWT_SECRET (32+ chars) to enable authentication.')"
  echo ""
  exec wolfpack setup < /dev/tty
elif [ -x "${INSTALL_DIR}/${BINARY_NAME}" ]; then
  echo "  $(green '✓') $(bold 'wolfpack') installed"
  echo ""
  echo "  Run $(bold 'wolfpack') to start."
  echo ""
  echo "  $(bold 'Security:') Always use the Tailscale hostname URL — not your machine's IP (it won't work)."
  echo "  $(dim 'Set WOLFPACK_JWT_SECRET (32+ chars) to enable authentication.')"
  echo ""
  exec "${INSTALL_DIR}/${BINARY_NAME}" setup < /dev/tty
else
  echo "  $(red '✗') wolfpack binary not found after install"
  exit 1
fi
