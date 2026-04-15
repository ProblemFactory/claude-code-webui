# Claude Code WebUI

A web-based UI for managing multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI sessions with a tiling window manager, file explorer, and code editor.

![License](https://img.shields.io/badge/license-MIT-blue)

## Features

### Dual-Mode Sessions
- **Terminal mode** -- full TUI via xterm.js with dtach persistence (survive server restarts)
- **Chat mode** -- structured message view with markdown rendering, tool visualization, and interactive permissions
- Default mode configurable per-user; split button on resume to choose Terminal or Chat

### Chat Mode
- **Normalized message system** -- MessageManager (Claude) / CodexMessageManager (Codex) converts raw backend output to normalized messages with stable IDs, merged tool calls, streaming text edits. Backend-agnostic adapter interface (`BackendAdapter`) for pluggable AI backends.
- **Tool visualization** -- Edit diffs (flex layout, wrap toggle), Read/Write with syntax highlighting (30 languages via highlight.js) + line numbers + searchable language picker
- **Interactive permissions** -- Allow / Always Allow / Deny buttons inline on tool cards (`--permission-prompt-tool` support)
- **Subagent support** -- Agent tool cards show live status; View Log opens read-only ChatView via per-subagent normalizers
- **Search** -- Ctrl+F with CSS Custom Highlight API, match counter, prev/next navigation across full history
- **Status bar** -- model, context %, cache ratio, cost, permission mode (clickable), background tasks (clickable popup)
- **Virtual scroll** -- sliding DOM window (~150 max), auto-trim top/bottom, deferred live messages when viewing history
- **Scroll minimap** -- semantic turn-based navigation with user message markers, compact markers, drag-to-jump, floating preview label
- **View-only mode** -- open stopped sessions as read-only (📋 View History); auto-converts on session terminate
- **Draft persistence** -- chat input auto-saved to server, synced across clients (Telegram-style)
- **Interrupt** -- dual mechanism (control_request + SIGINT) for reliability
- **TODO display** -- live TodoWrite tracking above input area, tracked in wrapper metadata
- **Collapsible long messages** -- 120-char preview + total length, collapse toggle
- **Reconnect sync** -- auto re-attach, StateSync resync for drafts/settings

### Terminal Mode
- **Multi-session terminals** with dtach persistence (survive server restarts)
- **Pin-to-bottom** -- scroll up freezes output; scroll back or click arrow to resume
- **Idle detection** -- window blinks orange when Claude finishes and waits for input
- **Clipboard image paste** -- Ctrl+V images from clipboard directly into Claude Code's TUI
- **Ctrl+G external editor** -- split-pane CodeMirror integration without screen clearing

### Window Manager
- **Tiling window manager** with drag/resize, grid snap, edge snap, custom grid presets, command mode (Ctrl+\\)
- **Virtual desktops** -- multiple independent workspaces with per-desktop grid; Ubuntu-style miniature previews in taskbar showing live window positions; drag windows between desktops; waiting windows blink yellow across desktops
- **Tab groups** -- drag window icons together to merge into Chrome-style tab groups; drag tab out to split
- **Snap memory** -- snapping saves original size; dragging out of snap restores it
- **Overlap switcher** -- right-click title bar to switch between overlapping windows
- **Resizable taskbar** -- drag top edge to resize (36-120px); all elements scale proportionally; synced across clients
- **Taskbar context menu** -- right-click taskbar items for Move, Move to Desktop, Minimize/Restore, Close
- **Move mode** -- window attaches to cursor, click to place (via taskbar context menu or command mode)
- **Proportional tracking** -- windows maintain relative positions on workspace resize
- **Multi-client layout sync** -- workspace state broadcast to all clients; smart diff syncs positions, open/close, navigation; openSpec pattern for window creation sync

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
- **Rate limit monitoring** -- dual pie charts (5h session + 7d weekly) in taskbar, click for details
- **Multi-client layout sync** -- workspace state synced across browsers in real-time (positions, open/close, navigation)
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
| CMD → d/D | Switch to next / previous desktop |
| CMD → ]/[ | Move active window to next / previous desktop |
| Ctrl+Alt+←/→ | Switch desktop (non-command-mode) |
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
- [Window Manager](docs/window-manager.md) — Grid, snap, command mode, presets, virtual desktops, tab groups
- [Session Management](docs/sessions.md) — Groups, star/archive, drag-drop, filters
- [File Explorer](docs/file-explorer.md) — Browsing, bookmarks, viewers, code editor
- [External Editor](docs/editor.md) — Ctrl+G split-pane CodeMirror integration
- [Embedded Browser](docs/browser.md) — Iframe browser with proxy mode
- [Settings](docs/settings.md) — All configuration options
- [Keyboard Shortcuts](docs/keyboard-shortcuts.md) — Complete reference

## License

MIT
