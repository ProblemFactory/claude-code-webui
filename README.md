# Claude Code WebUI

A web-based UI for managing multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI sessions with a tiling window manager, file explorer, and code editor.

![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Multi-session terminals** with dtach persistence (survive server restarts)
- **Tiling window manager** with drag/resize, grid snap, edge snap, custom grid presets, command mode (Ctrl+\\)
- **Session groups**: Folders | Groups dual tab, folder linking, drag sessions/folders to groups, right-click context menu
- **Session management**: star/archive, rename, status filters, quick tabs, clickBehavior (focus/expand/flash)
- **File explorer** with list/icon views, drag-to-terminal, upload/download, bookmarks (drag-reorder, right-click), "Add to group" on folders
- **File viewers**: PDF, images (zoom + pan), video, audio, CSV, Excel, Word, Markdown (preview/edit/split), hex
- **Code editor** (CodeMirror 6) with syntax highlighting, Ctrl+G split-pane integration
- **Embedded browser** with URL bar and node-unblocker proxy mode for iframe-restricted sites
- **6 color themes**: Dark, Light, Dracula, Nord, Solarized, Monokai
- **Settings system**: VS Code-style UI, per-terminal overrides (theme/font/size), active window highlight intensity
- **Session discovery**: auto-detects running Claude Code sessions (tmux, dtach, external)
- **Multi-device sync**: share terminal sessions across browsers, auto-resize to smallest client
- **Clipboard image paste**: Ctrl+V images from your local clipboard into Claude Code
- **Presets**: save/restore full workspace state (windows, positions, grid, theme, fonts)
- **Rate limit monitoring**: 5-hour and 7-day usage display from Anthropic API

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/ProblemFactory/claude-code-webui/master/install.sh | bash
```

The installer will:
1. Check for Node.js 18+, dtach, and Claude CLI (auto-installs dtach if needed)
2. Prompt for install location (default: `~/claude-code-webui`)
3. Clone the repo, install dependencies, and build

### Prerequisites

| Dependency | macOS | Ubuntu/Debian | Fedora/RHEL |
|-----------|-------|---------------|-------------|
| **Node.js 18+** | `brew install node` | `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo bash - && sudo apt install -y nodejs` | `sudo dnf install nodejs` |
| **dtach** | `brew install dtach` | `sudo apt install dtach` | `sudo dnf install dtach` |
| **Claude CLI** | `npm install -g @anthropic-ai/claude-code` | same | same |

After installing Claude CLI for the first time, run `claude` once to complete login/setup.

## Usage

```bash
cd ~/claude-code-webui
npm start
```

Open `http://localhost:3456` in your browser.

### Options

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3456` | Server port |
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` for local-only access |
| `CLAUDE_CMD` | `claude` | Path to Claude CLI binary |

Example: `PORT=8080 HOST=127.0.0.1 npm start`

### Updating

Re-run the install command or:
```bash
cd ~/claude-code-webui
git pull
npm install
npm run build
```

## How It Works

```
Browser (xterm.js) <-> WebSocket <-> node-pty (dtach) <-> pty-wrapper.js <-> claude CLI
                                                               |
                                                         buffer file (persistent)
```

- **dtach** provides PTY detach/attach with zero rendering overhead (unlike tmux/screen)
- **pty-wrapper.js** runs inside dtach, captures all output to a buffer file for server restart recovery
- **Server** manages sessions, broadcasts terminal I/O to all connected clients
- **Client** is vanilla JS with xterm.js (terminal), CodeMirror 6 (editor), and a custom window manager

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+G | Open external editor (split-pane CodeMirror) |
| Ctrl+V | Paste text or images from clipboard |
| Ctrl+C | Copy selection (SIGINT if no selection) |
| Ctrl+\ | Enter command mode (tmux-style prefix) |
| CMD → ←/→/↑/↓ | Snap window to half screen |
| CMD → 1-9+ | Snap to grid cell N (digits accumulate for 500ms) |
| CMD → m / w / Tab | Maximize / Close / Cycle next window |
| CMD → f/g/n/s/b/e | Freeform / Grid / New session / Sidebar / Browser / Files |
| Drag + Shift | Hold Shift while dragging title bar to select rectangular cell range |
| Alt+drag | Bypass grid snap |
| Right-click title bar | Switch between overlapping windows |

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| Linux | Full support | Primary development platform |
| macOS | Full support | Requires Homebrew for dtach. If node-pty fails: `npm rebuild node-pty --build-from-source` |
| WSL2 | Should work | Install dtach via apt |
| Windows (native) | Not supported | Requires WSL2 or remote Linux server |

## Documentation

See the **[docs/](docs/)** directory for detailed guides:

- [Getting Started](docs/getting-started.md) — Installation, first run, quick tour
- [Terminal Management](docs/terminal.md) — Persistence, multi-device, clipboard, fonts
- [Window Manager](docs/window-manager.md) — Grid, snap, command mode, presets
- [Session Management](docs/sessions.md) — Groups, star/archive, drag-drop, filters
- [File Explorer](docs/file-explorer.md) — Browsing, bookmarks, viewers
- [Settings](docs/settings.md) — All configuration options
- [Keyboard Shortcuts](docs/keyboard-shortcuts.md) — Complete reference

## License

MIT
