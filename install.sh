#!/usr/bin/env bash
set +e

REPO="https://github.com/almogdepaz/wolfpack.git"
INSTALL_DIR="$HOME/.wolfpack/app"

bold() { printf "\033[1m%s\033[0m" "$1"; }
green() { printf "\033[32m%s\033[0m" "$1"; }
red() { printf "\033[31m%s\033[0m" "$1"; }
dim() { printf "\033[2m%s\033[0m" "$1"; }

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

fail=0

if command -v node &>/dev/null; then
  echo "  $(green '✓') Node.js $(node --version)"
else
  echo "  $(red '✗') Node.js not found"
  fail=1
fi

if command -v tmux &>/dev/null; then
  echo "  $(green '✓') tmux $(tmux -V)"
else
  echo "  $(red '✗') tmux not found"
  echo "    Install with: $(bold 'brew install tmux')"
  fail=1
fi

if command -v tailscale &>/dev/null || [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  echo "  $(green '✓') Tailscale"
else
  echo "  $(red '✗') Tailscale not found (needed for remote access)"
  echo "    Install from: $(bold 'https://tailscale.com/download')"
  fail=1
fi

echo ""

if [ "$fail" -eq 1 ]; then
  echo "  $(red 'Install missing dependencies above, then re-run this script.')"
  echo ""
  exit 1
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
