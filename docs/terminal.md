# Terminal Management

## Session Persistence

Terminal sessions run inside **dtach**, a minimal PTY detach/attach tool. This means:

- Sessions survive server restarts — dtach keeps the process alive independently
- A **pty-wrapper** inside dtach continuously writes output to a buffer file
- On server restart, the buffer is replayed so you see the full terminal history

### Why dtach (not tmux)

dtach has zero rendering layer — all PTY I/O passes through transparently. tmux interposes its own terminal rendering which breaks mouse events, scroll, and selection in Claude Code's TUI. After 6+ failed attempts to fix tmux mouse handling, we migrated to dtach.

## Multi-Device Sync

Open the same WebUI from multiple browsers or devices:

- **Output** broadcasts to all connected clients in real-time
- **Terminal size** uses the minimum cols/rows across all clients (tmux-style)
- Larger clients show padding around the terminal area
- When a client disconnects, the size may increase for remaining clients
- Editor open/close events broadcast to all clients for correct window targeting

## Per-Terminal Settings

Each terminal window has a gear icon (⚙) in the title bar. Click it to customize:

| Setting | Options | Default |
|---------|---------|---------|
| Theme | Any of the 6 themes + "Default" | Follows global |
| Font size | 8-32px + "Default" checkbox | Follows global |
| Font family | System + web fonts + "Default" | Follows global |

Selecting "Default" makes the terminal follow the global setting. Overrides are persisted in the layout auto-save.

## Pin-to-Bottom (Scroll Freeze)

By default, the terminal auto-scrolls to show new output. When you scroll up to read history:

1. Output is **queued** instead of written to the terminal
2. The viewport stays frozen at your scroll position
3. A **↓** button appears in the bottom-right corner
4. Click ↓ or scroll to the bottom to flush queued output and resume auto-scroll

This prevents Claude Code's TUI redraws from yanking the viewport while you're reading.

## Idle Detection

Claude Code updates the terminal title via OSC 0 escape sequences:
- **✳** (U+2733) = idle, waiting for input
- **Braille spinners** (U+2800-28FF) = working

When Claude transitions to idle and the window is not focused:
- The window title bar blinks orange
- The taskbar item blinks orange
- Blinking clears when you focus the window

Configure via Settings > Terminal > **Waiting blink behavior**:
- **Always** — blink even if window is focused
- **Only when unfocused** — default
- **Never** — disable blinking entirely

## Clipboard Image Paste

Paste images from your system clipboard directly into Claude Code:

1. Copy an image to your clipboard (screenshot, browser image, etc.)
2. Focus the terminal window
3. Press **Ctrl+V**

Behind the scenes:
- The browser intercepts Ctrl+V and reads the image from the paste event
- The image is uploaded to the server
- The server writes it to the system clipboard via `xclip` (Linux) or `osascript` (macOS)
- A raw Ctrl+V (0x16) is sent to the PTY, triggering Claude Code's clipboard image check

> **Linux requirement**: `xclip` must be installed and a display server available (X11 or Xwayland).

## Bell Notification

When a terminal receives a BEL character (U+0007) while not focused, a bell icon appears on the window title bar. The icon clears when you focus the window.

## CJK Support

The terminal uses xterm.js's Unicode 11 addon for correct fullwidth character width calculation. CJK monospace fonts are included in the fallback chain.

## Font Discovery

Terminal fonts are discovered dynamically:

1. **Client-side** (Chrome 103+): `queryLocalFonts()` API detects monospace fonts installed on your machine
2. **Server fallback**: `fc-list :spacing=mono` for browsers without `queryLocalFonts`
3. **Google Web Fonts**: Fira Code, JetBrains Mono, Source Code Pro, IBM Plex Mono, Inconsolata — always available

Since the terminal renders in the browser, client-side fonts are what matter, not server fonts.

## Drag-to-Terminal

Drag a file from the file explorer and drop it on a terminal window. The shell-escaped absolute path is automatically typed into the terminal.
