# Session Management

## Session Discovery

The sidebar automatically discovers all Claude Code sessions on your machine using a **lock-first algorithm**:

1. Scans Claude Code lock files (`~/.claude/sessions/*.json`)
2. Filters to alive PIDs, verifies the process is actually `claude`
3. Checks if the process runs inside tmux (attachable) or another terminal
4. Matches each lock to its most recent JSONL file by project directory
5. All unmatched JONLs become STOPPED sessions

### Session Statuses

| Status | Badge | Description | Click action |
|--------|-------|-------------|-------------|
| **LIVE** | Green | WebUI-managed (dtach) | Focus existing window |
| **TMUX** | Blue | Running in external tmux | View session (closing won't kill it) |
| **EXTERNAL** | Gray | Running in unknown terminal | Not clickable |
| **STOPPED** | Dim | Not running | Resume via `claude --resume` |

## Sidebar Views

The sidebar has two tabs:

### Folders tab
Sessions grouped by working directory. Each folder header shows:
- Session count
- Green dot if any session is live
- **+** button to create a new session in that directory
- **🔗** button to link the folder to a session group

### Groups tab
User-created groups for organizing sessions across directories. See [Session Groups](#session-groups) below.

## Session Modes

Each session runs in one of two modes:

- **Terminal** -- full TUI rendered via xterm.js (the classic Claude Code experience)
- **Chat** -- structured message view with markdown, tool visualization, and permissions (see [Chat Mode](chat-mode.md))

Chat sessions display a speech bubble icon next to their status badge in the sidebar.

### Default mode

Configure the default mode for new sessions and single-click resume via Settings > Session Card > **Default session mode**. The default is Chat.

### Choosing mode on resume

When resuming a stopped session, the resume button uses your default mode. A split button next to it lets you explicitly choose Terminal or Chat. The mode you last used for a session is persisted.

### Per-session parameters

A gear button (⚙) next to the Resume button opens a config popover where you can override **Model**, **Effort**, and **Permission Mode** for that specific resume. Each option has a checkbox — unchecked means "use global default" (greyed out), checked means the override is active. Changing a dropdown while unchecked auto-checks it. Model supports typing a specific model ID via the "Custom..." option.

## Session Cards

Each session appears as a compact card showing: name, status badge, mode icon (for chat), and expand arrow.

### Card click behavior

Configurable via Settings > Session Card > **Card click behavior**:

| Mode | Click action | How to expand | How to open/resume |
|------|-------------|---------------|-------------------|
| **Focus** (default) | Opens/focuses the session window | ▸ arrow button | Click itself |
| **Expand** | Expands/collapses card details | Click itself | Buttons in detail panel |
| **Flash** | Flashes/bounces the session window | ▸ arrow button | Buttons in detail panel |

### Session card display

Session card details use smart truncation for readability:
- **Session ID** -- mid-truncated (first and last characters visible, middle replaced with ellipsis)
- **Working directory** -- left-truncated (shows the end of the path, which is most informative)
- **Click-to-copy** -- when enabled (Settings > Session Card > **Click to copy**), clicking the session ID or CWD copies it to the clipboard

### Expanded card details

Click the ▸ arrow to expand any card. The detail panel shows:
- Session ID, working directory, start time, status
- Groups membership
- Action buttons: Rename, Find, Attach/Resume, Terminate (red, with confirmation)

Configure visible fields via Settings > Session Card > **Visible detail fields**.
Configure truncation direction via Settings > Session Card > **Detail truncation**.

### Star and archive

- **★** — Star a session to pin it to the top of its group (in sidebar and taskbar)
- **📦** — Archive a session to hide it from the default view

Archived sessions are only visible when "Archived" is included in the status filter.

### Rename

Double-click a session name in the sidebar to rename it. The custom name:
- Displays in the sidebar, window title bar, and taskbar
- Is used as `--name` when resuming the session
- Syncs to all connected clients via WebSocket

### Find / GoTo

The expanded detail panel has a split button that toggles between **Find** and **GoTo** modes (click the ▾ arrow to switch):

- **Find** — flashes the window title bar, taskbar item, and desktop preview rect (cyan, 3 seconds). If the window is on another desktop, only the preview rect flashes.
- **GoTo** — switches to the window's desktop, focuses and flashes it. For tab group windows, switches to the correct tab first.

The mode is persisted via settings (`sessionCard.findMode`) and synced across clients.

## Status Filters

The filter button (top of sidebar) opens a multi-select dropdown:
- **Live**, **Tmux**, **External**, **Stopped**, **Archived**
- Default: all except Archived

### Quick tabs

Enable via Settings > Sidebar > **Status quick tabs** to show one-click filter tabs below the search bar: ALL / LIVE / TMUX / EXT / STOP / ARCH.

## Session Groups

Groups let you organize sessions independently of their working directory.

### Creating a group

In the Groups tab, click **"+ New Group"** and enter a name.

### Adding sessions to a group

Multiple ways:
- **Session card dropdown**: Expand a card → click the Groups ▾ button → check/uncheck groups
- **Drag session**: Drag a session card and drop it on a group header
- **Folder linking**: Link a folder so all sessions with matching `cwd` auto-include (see below)

### Folder linking

Link a folder path to a group to automatically include all sessions whose working directory matches (or is a subdirectory):

- From the **Folders tab**: Click the 🔗 button on a folder header → select a group
- From the **File explorer**: Right-click a folder → "Add to group" → select a group
- **Drag a folder** from the file explorer onto a group header in the sidebar

View and manage linked folders: right-click a group header → **Linked folders**.

### Group header actions

- **▶ button** — Resume/attach all sessions in the group
- **Right-click** — Context menu with: Rename, Linked folders, Delete
- **Drop target** — Drag sessions or folders onto the header

### Multi-client sync

All session state (stars, archives, names, groups, folder links) is stored server-side in `data/user-state.json` and broadcast to all connected clients via WebSocket. Changes made on one device appear instantly on all others.
