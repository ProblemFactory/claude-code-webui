#!/bin/bash
set -e

# Claude Code WebUI — One-line installer
# Usage: curl -fsSL <url>/install.sh | bash
#   or:  bash install.sh

PORT="${PORT:-3456}"
DEFAULT_DIR="$HOME/claude-code-webui"

echo ""
echo "  Claude Code WebUI Installer"
echo "  ============================"
echo ""

# Ask user to confirm install location (read from /dev/tty for curl|bash compat)
printf "  Install location [%s]: " "$DEFAULT_DIR"
if read -r USER_DIR < /dev/tty 2>/dev/null; then
  INSTALL_DIR="${USER_DIR:-$DEFAULT_DIR}"
else
  INSTALL_DIR="$DEFAULT_DIR"
fi
# Expand ~ manually
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"
echo "  → $INSTALL_DIR"
echo ""

# ── Check prerequisites ──

# Node.js 18+
if ! command -v node &>/dev/null; then
  echo "  [!] Node.js not found."
  if [[ "$OSTYPE" == darwin* ]]; then
    echo "      Install via: brew install node"
  else
    echo "      Install via: https://nodejs.org/ or your package manager"
  fi
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "  [!] Node.js 18+ required (found v$(node -v))"
  exit 1
fi
echo "  [OK] Node.js $(node -v)"

# dtach
if ! command -v dtach &>/dev/null; then
  echo "  [!] dtach not found. Installing..."
  if [[ "$OSTYPE" == darwin* ]]; then
    if command -v brew &>/dev/null; then
      brew install dtach </dev/null
    else
      echo "      Please install Homebrew first: https://brew.sh"
      echo "      Then run: brew install dtach"
      exit 1
    fi
  elif command -v apt-get &>/dev/null; then
    sudo apt-get install -y dtach </dev/null
  elif command -v yum &>/dev/null; then
    sudo yum install -y dtach </dev/null
  else
    echo "      Please install dtach manually"
    exit 1
  fi
fi
echo "  [OK] dtach $(dtach --help 2>&1 | head -1 || echo 'installed')"

# Claude CLI
if ! command -v claude &>/dev/null; then
  echo "  [!] Claude CLI not found."
  echo "      Install via: npm install -g @anthropic-ai/claude-code"
  echo "      Then run: claude (to complete setup/login)"
  exit 1
fi
echo "  [OK] Claude CLI found"

# ── Install ──

if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/server.js" ]; then
  echo ""
  echo "  Existing installation found at $INSTALL_DIR"
  echo "  Updating..."
  cd "$INSTALL_DIR"
  if [ -d ".git" ]; then git pull --ff-only 2>/dev/null || true; fi
else
  echo ""
  echo "  Installing to $INSTALL_DIR ..."

  # If running from within the project directory (has server.js), use it
  if [ -f "server.js" ] && [ -f "package.json" ]; then
    if [ "$(pwd)" != "$INSTALL_DIR" ]; then
      mkdir -p "$INSTALL_DIR"
      cp -r . "$INSTALL_DIR/"
    fi
    cd "$INSTALL_DIR"
  elif command -v git &>/dev/null; then
    echo "  Cloning from GitHub..."
    git clone https://github.com/ProblemFactory/claude-code-webui.git "$INSTALL_DIR" </dev/null
    cd "$INSTALL_DIR"
  else
    echo "  [!] git not found. Install git or download manually:"
    echo "      https://github.com/ProblemFactory/claude-code-webui"
    exit 1
  fi
fi

echo "  Installing dependencies..."
npm install --no-fund --no-audit </dev/null 2>&1 | tail -1

echo "  Building frontend..."
npm run build 2>&1 | tail -1

# Create data directories
mkdir -p data/sockets data/session-meta data/session-buffers data/bin

echo ""
echo "  ✅ Installation complete!"
echo ""
echo "  To start:"
echo "    cd $INSTALL_DIR"
echo "    npm start"
echo ""
echo "  Then open http://localhost:${PORT} in your browser."
echo ""
echo "  Tips:"
echo "    - Set PORT=xxxx to use a different port"
echo "    - Sessions persist across server restarts"
echo "    - Press Ctrl+C to stop the server (sessions keep running)"
echo ""
