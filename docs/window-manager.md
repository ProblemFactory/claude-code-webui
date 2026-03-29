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

## Presets

Presets save and restore the complete workspace state:
- Window positions, sizes, z-order
- Grid configuration
- Theme and font settings
- Session-to-window mapping (by `claudeSessionId`)

When loading a preset, windows not in the preset are minimized (not closed) — sessions stay alive.

Save presets via the toolbar menu. They persist across server restarts.

## Bounce on Focus

Optional: when focusing a window from the sidebar or taskbar, a brief scale-bounce animation provides visual feedback. Enable via Settings > Window > **Bounce on remote focus**.
