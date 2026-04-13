# Window Manager

The workspace uses a tiling window manager inspired by macOS Magnet. All windows (terminals, file explorers, editors, browsers) share the same drag/resize/snap behavior.

## Basic Operations

- **Drag** a window by its title bar to move it
- **Resize** by dragging any edge or corner
- **Minimize** via the `─` button (restore from taskbar)
- **Maximize** via the `□` button (toggle)
- **Close** via the `✕` button

## Grid Layouts

### Built-in presets

The toolbar provides quick layout presets:

| Button | Layout | Description |
|--------|--------|-------------|
| `□` | Maximize | Single window fills workspace |
| `▐▌` | 2-column | Side by side |
| `▄▀` | 2-row | Top and bottom |
| `⊞` | Quad | 2x2 grid |
| `▎▐▐` | 3-column | Three equal columns |

### Custom grids

Click the **+** button to create custom grids (e.g., 3x3, 4x2). Custom grids appear as buttons in the toolbar:
- Grids up to 4x4 show as SVG icon previews
- Larger grids show as "RxC" text
- Right-click a custom grid button to delete it

### Freeform mode

Click the **freeform** button to exit grid mode. Windows become freely positionable without snap constraints.

## Snap Behavior

### Grid snap
When a grid is active, dragging a window snaps it to the nearest grid cell on release. The snap indicator (blue highlight) shows where the window will land.

### Edge snap
In freeform mode, dragging near screen edges snaps to half-screen positions (left/right/top/bottom).

### Drag threshold
A 5-pixel drag threshold prevents accidental snaps when you click the title bar just to focus a window. Snap behavior only activates after moving at least 5 pixels.

### Pre-snap size memory
When a window snaps to a grid cell or edge zone, its original size is saved. If you drag the window out of the snap zone, it restores to its pre-snap dimensions. This size is persisted in the layout, so it survives page refreshes.

### Bypass snap
Hold **Alt** while dragging to bypass all snap behavior.

### Shift+drag cell range
While dragging a window title bar in grid mode, press and hold **Shift** to activate rectangular cell selection. The selected range highlights in blue — release to span the window across all selected cells.

> Note: Shift activates mid-drag (start dragging first, then press Shift), not the other way around.

## Proportional Tracking

All positioned windows store their bounds as proportional fractions (0-1) of the workspace. When the workspace resizes (sidebar toggle, browser resize), windows automatically reflow to maintain their relative positions. This works in both grid and freeform modes.

## Overlap Switcher

When windows overlap, the title bar shows an overlap indicator:
- **⧉** — Other windows overlap with this one (click to show list)
- **□** — No overlap

Right-click any title bar to see a popup listing all overlapping windows. Click one to bring it to focus.

## Active Window Highlight

The focused window is visually distinguished. The highlight intensity is configurable via Settings > Window > **Active window highlight**:

| Level | Appearance |
|-------|------------|
| Subtle | Shadow only (minimal) |
| Normal | Accent-colored border (default) |
| Strong | Accent border + outer glow |

## Command Mode

Press **Ctrl+\\** to enter command mode. A yellow **[CMD]** indicator appears in the taskbar. Commands are single keystrokes — no modifier needed.

Command mode auto-exits after 2 seconds or on Escape.

### Window commands

| Key | Action |
|-----|--------|
| ← → ↑ ↓ | Snap active window to half-screen |
| 1-9 | Snap to grid cell N (digits accumulate for 500ms for cells >9) |
| m | Maximize / restore |
| w | Close window |
| Tab | Cycle to next window (stays in command mode) |

### Global commands

| Key | Action |
|-----|--------|
| f | Switch to freeform mode |
| g | Prompt for grid dimensions (e.g. "3x3") |
| n | Open new session dialog |
| s | Toggle sidebar |
| b | Open embedded browser |
| e | Open file explorer |

## Taskbar

The taskbar at the bottom shows all open windows in a two-row layout: a large type icon (18px) on the left with the window title and subtitle stacked to the right. Window type icons indicate the content:

| Icon | Window type |
|------|-------------|
| `💬` | Chat session |
| `⬛` | Terminal session |
| `📁` | File explorer |
| `📄` | File viewer |
| `✏️` | Code editor |
| `🔢` | Hex viewer |
| `🌐` | Browser |

Items use flex-shrink with text-overflow ellipsis to handle many windows gracefully.

### Right-click context menu

Right-click any taskbar item to open a context menu:

| Action | Description |
|--------|-------------|
| **Move** | Enters move mode -- the window attaches to your cursor. Click anywhere in the workspace to place it. |
| **Minimize** / **Restore** | Toggle minimize state |
| **Close** | Close the window |

### Move mode

Move mode detaches a window from its current position and attaches it to your cursor. A full-screen overlay blocks all other UI interaction during move, ensuring no accidental clicks reach elements underneath. If the window is maximized or snapped, it restores to its original (pre-snap) size before following the cursor. Click to place it at the new location.

Move mode can also be triggered via command mode (Ctrl+\\ then a move command).

## Tab Groups

Merge multiple windows into Chrome-style tab groups for space-efficient multitasking.

### Creating a tab group

- **Drag a window's type icon** onto another window's type icon to merge them into a tab group
- **Drag a full window** over another window's type icon to merge (the dragged window collapses to a ghost indicator before snapping in)

### Tab bar

When windows merge, the title bar is replaced by a tab bar with rounded-top tabs. The active tab visually connects to the content area below.

- **Click** a tab to switch to that window's content
- **Close button** on each tab to remove it from the group (window closes or becomes standalone)
- **Drag a tab downward** to pull it out of the group — the detached window follows the cursor with full snap support

### Data model

Tab groups share a `{tabs, active}` object among all grouped windows. The `tabs` array holds references to each window in the group, and `active` tracks the currently displayed tab.

### Layout persistence

Tab groups are saved and restored as part of the layout auto-save, and synced across clients via the layout sync protocol.

## Layout Sync

When multiple browsers are connected, layout changes are synced in real-time:

- **State-based**: the full workspace state is broadcast after every change (not individual operations)
- **Smart diff**: the receiver compares remote state against local and only applies differences
- **Synced properties**: window positions, maximize/minimize state, snap, z-order, open/close, file explorer navigation
- **Proportional coordinates**: all positions use gridBounds (0-1 fractions), so different screen sizes work correctly
- **Window matching**: windows are matched across clients by unique ID (`win-{timestamp}-{random}`)
- **Window creation via openSpec**: every window records a serializable creation recipe. When a window exists on one client but not another, the receiver replays it. Supports all window types: sessions, file explorers, viewers, editors, browsers, subagent viewers.
- **Draft sync**: chat input text synced across clients in real-time via StateSync

The sync is debounced at 500ms and uses a 1-second cooldown to prevent echo loops.

## Presets

Presets save and restore the complete workspace state:
- Window positions, sizes, z-order
- Grid configuration
- Theme and font settings
- Session-to-window mapping (by `claudeSessionId`)

When loading a preset, windows not in the preset are minimized (not closed) — sessions stay alive.

Save presets via the toolbar menu. They persist across server restarts.

## Close Behavior

Configure via Settings > Window > **Window close behavior**:

| Mode | Close window action |
|------|-------------------|
| **Terminate** (default) | Kills the session (process terminated) |
| **Detach** | Removes the window but keeps the session alive. Re-attach from the sidebar. |

Regardless of this setting, you can always explicitly terminate a session via the **Terminate** button in the session card's expand panel.

## Bounce on Focus

Optional: when focusing a window from the sidebar or taskbar, a brief scale-bounce animation provides visual feedback. Enable via Settings > Window > **Bounce on remote focus**.
