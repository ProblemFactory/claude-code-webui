# Claude Code WebUI

A web-based UI for managing multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI sessions with a tiling window manager, file explorer, and code editor.

![License](https://img.shields.io/badge/license-MIT-blue)

## Features

### Dual-Mode Sessions
- **Terminal mode** -- full TUI via xterm.js with dtach persistence (survive server restarts)
- **Chat mode** -- structured message view with markdown rendering, tool visualization, and interactive permissions
- Default mode configurable per-user; split button on resume to choose Terminal or Chat

### Chat Mode
- **Structured messages** -- user/assistant/tool/thinking blocks rendered with markdown and syntax highlighting
- **Tool visualization** -- Edit diffs, file read/write summaries, collapsible tool results with first-line preview
- **Interactive permissions** -- Allow / Always Allow / Deny buttons inline on tool cards (`--permission-prompt-tool` support)
- **Subagent support** -- Agent tool cards show live status during execution; View Log opens a read-only ChatView
- **Search** -- Ctrl+F with CSS Custom Highlight API, match counter, prev/next navigation across full history
- **Status bar** -- model badge, context % with color-coded progress bar, cache hit ratio, cost with color tiers, permission mode
- **Slash command autocomplete** -- type `/` to see all commands, arrow keys to navigate, Tab/Enter to accept
- **Image paste** -- paste images from clipboard as message attachments (inline preview, removable)
- **Interrupt** -- Stop button in streaming status bar to interrupt Claude mid-response
- **Open in Editor** -- clipboard button on messages and tool cards opens content in a temporary CodeEditor window
- **System notifications** -- task-notification and system-reminder messages detected and rendered separately
- **Collapsible long messages** -- messages over 500 characters auto-collapse with preview
- **View Manager** -- sliding window pagination over full conversation history; scroll up to load earlier messages
- **Reconnect sync** -- on WebSocket reconnect, automatically re-attaches and fetches missed messages

### Terminal Mode
- **Multi-session terminals** with dtach persistence (survive server restarts)
- **Pin-to-bottom** -- scroll up freezes output; scroll back or click arrow to resume
- **Idle detection** -- window blinks orange when Claude finishes and waits for input
- **Clipboard image paste** -- Ctrl+V images from clipboard directly into Claude Code's TUI
- **Ctrl+G external editor** -- split-pane CodeMirror integration without screen clearing

### Window Manager
- **Tiling window manager** with drag/resize, grid snap, edge snap, custom grid presets, command mode (Ctrl+\\)
- **Overlap switcher** -- right-click title bar to switch between overlapping windows
- **Proportional tracking** -- windows maintain relative positions on workspace resize

### Sessions
- **Session discovery** -- auto-detects running Claude Code sessions (Live/Tmux/External/Stopped)
- **Session groups** -- Folders | Groups dual tab, folder linking, drag sessions/folders to groups
- **Session management** -- star/archive, rename, status filters, quick tabs, clickBehavior (focus/expand/flash)
- **Session cards** -- ID mid-truncation, CWD left-truncation, click-to-copy on ID/CWD
- **Multi-device sync** -- share sessions across browsers, auto-resize to smallest client

### File Management
- **File explorer** with list/icon views, drag-to-terminal, upload/download, bookmarks
- **File viewers** -- PDF, images (zoom + pan), video, audio, CSV, Excel, Word, hex
- **Code editor** (CodeMirror 6) -- syntax highlighting, markdown preview toggle, jump to line from `:line` paths
- **Clickable file paths** -- in chat messages and tool cards; click to copy, Ctrl+click to open; supports `:line`, `:line:col`, `:line-line` suffixes

### General
- **Embedded browser** with URL bar and node-unblocker proxy mode for iframe-restricted sites
- **6 color themes** -- Dark, Light, Dracula, Nord, Solarized, Monokai
- **Settings system** -- VS Code-style UI, per-terminal overrides (theme/font/size), active window highlight intensity
- **Presets** -- save/restore full workspace state (windows, positions, grid, theme, fonts)
- **Rate limit monitoring** -- 5-hour and 7-day usage display from Anthropic API
- **WebSocket auto-reconnect** -- re-attaches all active sessions on connection recovery

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
Terminal mode:
  Browser (xterm.js) <-> WebSocket <-> node-pty (dtach) <-> pty-wrapper.js <-> claude CLI
                                                                  |
                                                            buffer file (persistent)

Chat mode:
  Browser (ChatView) <-> WebSocket <-> node-pty (dtach) <-> chat-wrapper.js <-> claude --stream-json
                                                                  |
                                                            buffer file (JSON lines)
```

- **dtach** provides PTY detach/attach with zero rendering overhead (unlike tmux/screen)
- **pty-wrapper.js** (terminal) and **chat-wrapper.js** (chat) run inside dtach, capture output to buffer files
- Both wrappers survive server restarts -- dtach keeps them alive independently
- **Server** manages sessions, broadcasts I/O to all connected clients, handles permission prompts
- **Client** is vanilla JS with xterm.js (terminal), ChatView (chat), CodeMirror 6 (editor), and a custom window manager

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
- [Chat Mode](docs/chat-mode.md) — Structured messages, tool visualization, permissions, search, subagents
- [Terminal Management](docs/terminal.md) — Persistence, multi-device, clipboard, fonts
- [Window Manager](docs/window-manager.md) — Grid, snap, command mode, presets
- [Session Management](docs/sessions.md) — Groups, star/archive, drag-drop, filters
- [File Explorer](docs/file-explorer.md) — Browsing, bookmarks, viewers, code editor
- [External Editor](docs/editor.md) — Ctrl+G split-pane CodeMirror integration
- [Embedded Browser](docs/browser.md) — Iframe browser with proxy mode
- [Settings](docs/settings.md) — All configuration options
- [Keyboard Shortcuts](docs/keyboard-shortcuts.md) — Complete reference

## License

MIT
