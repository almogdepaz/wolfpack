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
  echo "  $(dim '○') tmux not found $(dim '(optional — needed for tmux backend)')"
fi

if command -v tailscale &>/dev/null || { $IS_MACOS && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; }; then
  echo "  $(green '✓') Tailscale"
else
  echo "  $(dim '○') Tailscale not found $(dim '(optional — needed for remote access)')"
fi

echo ""

# ── Download binary ──

TARGET=$(detect_target)
DOWNLOAD_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download/${TARGET}"

echo "  Detected target: $(bold "$TARGET")"
echo "  Downloading from GitHub releases..."

mkdir -p "$INSTALL_DIR"

if command -v curl &>/dev/null; then
  if ! curl -fSL --progress-bar -o "${INSTALL_DIR}/${BINARY_NAME}" "$DOWNLOAD_URL"; then
    echo ""
    echo "  $(red 'Download failed.')"
    echo "  URL: $DOWNLOAD_URL"
    echo "  Check that a release exists at:"
    echo "    https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest"
    exit 1
  fi
elif command -v wget &>/dev/null; then
  if ! wget -q --show-progress -O "${INSTALL_DIR}/${BINARY_NAME}" "$DOWNLOAD_URL"; then
    echo ""
    echo "  $(red 'Download failed.')"
    echo "  URL: $DOWNLOAD_URL"
    exit 1
  fi
else
  echo "  $(red 'Neither curl nor wget found. Cannot download.')"
  exit 1
fi

chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

# Remove macOS quarantine/provenance flags and ad-hoc sign
if $IS_MACOS; then
  xattr -cr "${INSTALL_DIR}/${BINARY_NAME}" 2>/dev/null
  if ! codesign --sign - --force "${INSTALL_DIR}/${BINARY_NAME}" 2>/dev/null; then
    echo ""
    echo "  $(red 'Failed to codesign binary. macOS will block unsigned binaries.')"
    echo "  Install Xcode CLI tools and re-run:"
    echo "    $(bold 'xcode-select --install')"
    exit 1
  fi
fi

echo "  $(green '✓') Binary installed to ${INSTALL_DIR}/${BINARY_NAME}"

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

if command -v wolfpack &>/dev/null; then
  echo "  $(green '✓') $(bold 'wolfpack') installed"
  echo ""
  echo "  Run $(bold 'wolfpack') to start."
  echo ""
  exec wolfpack setup < /dev/tty
elif [ -x "${INSTALL_DIR}/${BINARY_NAME}" ]; then
  echo "  $(green '✓') $(bold 'wolfpack') installed"
  echo ""
  echo "  Run $(bold 'wolfpack') to start."
  echo ""
  exec "${INSTALL_DIR}/${BINARY_NAME}" setup < /dev/tty
else
  echo "  $(red '✗') wolfpack binary not found after install"
  exit 1
fi
