# Keyboard Shortcuts

## Terminal Shortcuts

| Shortcut | Action |
|----------|--------|
| **Ctrl+G** | Open external editor (split-pane CodeMirror) |
| **Ctrl+V** | Paste text or image from clipboard |
| **Ctrl+C** | Copy selection to clipboard (sends SIGINT if no selection) |

## Command Mode

Press **Ctrl+\\** to enter command mode. A yellow **[CMD]** indicator appears in the taskbar.

Command mode auto-exits after **2 seconds** or on **Escape**. All commands are single keystrokes.

### Window Commands

| Key | Action |
|-----|--------|
| **←** | Snap window to left half |
| **→** | Snap window to right half |
| **↑** | Snap window to top half |
| **↓** | Snap window to bottom half |
| **1-9** | Snap to grid cell N |
| **10+** | Digits accumulate for 500ms (e.g., press `1` then `2` for cell 12) |
| **m** | Maximize / restore window |
| **w** | Close window |
| **Tab** | Cycle to next window (stays in command mode) |

### Global Commands

| Key | Action |
|-----|--------|
| **f** | Switch to freeform mode (no grid) |
| **g** | Prompt for grid dimensions (e.g., "3x3") |
| **n** | Open new session dialog |
| **s** | Toggle sidebar |
| **b** | Open embedded browser |
| **e** | Open file explorer |

## Drag Modifiers

| Modifier | Action |
|----------|--------|
| **Alt + drag** | Bypass grid snap (free positioning) |
| **Drag + Shift** | Hold Shift while dragging to select rectangular cell range |

> **Note**: For Shift cell selection, start dragging first, then press and hold Shift. The selection activates mid-drag.

## Window Title Bar

| Action | Result |
|--------|--------|
| **Double-click** title bar | (reserved) |
| **Right-click** title bar | Show overlapping windows switcher |
| Click **─** | Minimize window |
| Click **□** | Maximize / restore |
| Click **✕** | Close window |
| Click **⧉/□** indicator | Show overlapping windows list |

## Sidebar

| Action | Result |
|--------|--------|
| **Double-click** session name | Rename session |
| **Drag** session card | Drop on group header to assign |
| **Click** ▸ arrow | Expand/collapse session details |
| **Click** ★ | Toggle star |
| **Click** 📦 | Toggle archive |
| **Right-click** group header | Context menu (Rename, Linked folders, Delete) |

## File Explorer

| Action | Result |
|--------|--------|
| **Double-click** folder | Navigate into folder |
| **Double-click** file | Open in appropriate viewer |
| **Right-click** item | Context menu (Open, Edit, Delete, Sessions, Add to group) |
| **Drag** file to terminal | Type shell-escaped path |
| **Drag** folder to group header | Link folder to group |
| **Drag** file/folder to bookmarks | Add bookmark |
| **Tab** in path bar | Autocomplete directory |
