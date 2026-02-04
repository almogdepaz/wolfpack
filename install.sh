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

REPO="https://github.com/almogdepaz/wolfpack.git"
INSTALL_DIR="$HOME/.wolfpack/app"

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

missing=()

if command -v node &>/dev/null; then
  node_version=$(node --version)
  # Extract major.minor from vX.Y.Z
  major=$(echo "$node_version" | sed -E 's/^v([0-9]+)\..*/\1/')
  minor=$(echo "$node_version" | sed -E 's/^v[0-9]+\.([0-9]+)\..*/\1/')
  # import.meta.dirname requires Node 20.11+
  if [ "$major" -gt 20 ] || { [ "$major" -eq 20 ] && [ "$minor" -ge 11 ]; }; then
    echo "  $(green '✓') Node.js $node_version"
  else
    echo "  $(red '✗') Node.js $node_version (need >=20.11)"
    missing+=("node")
  fi
else
  echo "  $(red '✗') Node.js not found"
  missing+=("node")
fi

if command -v tmux &>/dev/null; then
  echo "  $(green '✓') tmux $(tmux -V)"
else
  echo "  $(red '✗') tmux not found"
  missing+=("tmux")
fi

if command -v tailscale &>/dev/null || { $IS_MACOS && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; }; then
  echo "  $(green '✓') Tailscale"
else
  echo "  $(red '✗') Tailscale not found (needed for remote access)"
  missing+=("tailscale")
fi

echo ""

if [ ${#missing[@]} -gt 0 ]; then
  if $IS_MACOS; then
    if ! command -v brew &>/dev/null; then
      echo "  $(red 'Homebrew is required to install missing dependencies.')"
      echo "  Install from: $(bold 'https://brew.sh')"
      echo ""
      exit 1
    fi
  elif $IS_LINUX; then
    if ! command -v apt &>/dev/null; then
      echo "  $(red 'apt is required to install missing dependencies.')"
      echo ""
      exit 1
    fi
  else
    echo "  $(red 'Unsupported platform. Please install manually:') ${missing[*]}"
    exit 1
  fi

  echo "  Will install: $(bold "${missing[*]}")"
  printf "  Proceed? (y/n) "
  read -r answer < /dev/tty
  if [ "$answer" != "y" ]; then
    echo "  Aborted."
    exit 1
  fi

  if $IS_MACOS; then
    # Separate CLI tools from cask apps
    brew_pkgs=()
    brew_casks=()
    for pkg in "${missing[@]}"; do
      if [ "$pkg" = "tailscale" ]; then
        brew_casks+=("tailscale")
      else
        brew_pkgs+=("$pkg")
      fi
    done

    if [ ${#brew_pkgs[@]} -gt 0 ]; then
      echo "  Installing ${brew_pkgs[*]}..."
      brew install --quiet "${brew_pkgs[@]}"
    fi

    if [ ${#brew_casks[@]} -gt 0 ]; then
      echo "  Installing Tailscale (GUI app)..."
      brew install --cask --quiet tailscale
    fi
  elif $IS_LINUX; then
    apt_pkgs=()
    for pkg in "${missing[@]}"; do
      if [ "$pkg" = "tailscale" ]; then
        : # handled separately
      elif [ "$pkg" = "node" ]; then
        apt_pkgs+=("nodejs")
      else
        apt_pkgs+=("$pkg")
      fi
    done

    if [ ${#apt_pkgs[@]} -gt 0 ]; then
      echo "  Installing ${apt_pkgs[*]}..."
      sudo apt update -qq && sudo apt install -y -qq "${apt_pkgs[@]}"
    fi

    # Install tailscale via official script (requires sudo)
    for pkg in "${missing[@]}"; do
      if [ "$pkg" = "tailscale" ]; then
        echo "  Installing Tailscale..."
        curl -fsSL https://tailscale.com/install.sh | sudo sh
      fi
    done
  fi

  echo ""

  # Verify
  verify_fail=0
  for pkg in "${missing[@]}"; do
    if [ "$pkg" = "tailscale" ]; then
      if command -v tailscale &>/dev/null || { $IS_MACOS && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; }; then
        echo "  $(green '✓') Tailscale installed"
        if $IS_MACOS; then
          echo "  $(dim 'Open Tailscale.app and sign in to enable remote access.')"
        else
          echo "  $(dim 'Run: sudo tailscale up')"
        fi
      else
        echo "  $(red '✗') Tailscale failed to install"
        verify_fail=1
      fi
    else
      if command -v "$pkg" &>/dev/null; then
        echo "  $(green '✓') $pkg installed"
      else
        echo "  $(red '✗') $pkg failed to install"
        verify_fail=1
      fi
    fi
  done

  echo ""
  if [ "$verify_fail" -eq 1 ]; then
    echo "  $(red 'Some dependencies failed to install.')"
    echo ""
    exit 1
  fi
fi

# ── Install ──

if [ -d "$INSTALL_DIR" ]; then
  echo "  Removing old install..."
  rm -rf "$INSTALL_DIR"
fi

echo "  Cloning wolfpack..."
mkdir -p "$(dirname "$INSTALL_DIR")"
git clone --quiet "$REPO" "$INSTALL_DIR"

echo "  Installing dependencies..."
cd "$INSTALL_DIR"
npm install --silent
npm link --silent

echo ""

# Verify
if command -v wolfpack &>/dev/null; then
  echo "  $(green '✓') $(bold 'wolfpack') installed"
  echo ""
  echo "  Run $(bold 'wolfpack') to start."
  echo ""
  # Run setup — reattach to terminal since stdin is the curl pipe
  exec wolfpack setup < /dev/tty
else
  echo "  $(red '✗') wolfpack not found on PATH after install"
  echo "  Try: $(dim 'npx tsx ~/.wolfpack/app/cli.ts setup')"
  echo ""
  exit 1
fi
