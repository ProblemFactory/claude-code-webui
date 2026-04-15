# File Explorer

Open a file explorer via the toolbar folder icon, command mode (`Ctrl+\` then `e`), or from the sidebar folder right-click menu.

## Toolbar

The toolbar provides a streamlined set of controls:

`[↑] [path bar] [refresh] [View] [+file] [📂folder] [⬆upload]`

- **↑** — Go up one directory
- **Path bar** — Editable with autocomplete (Tab/Enter to select), supports `~` for home directory. Entering a file path opens it directly in the appropriate viewer.
- **Refresh** — Reload the current directory
- **View** — Menu that replaces the old individual toolbar buttons for view mode, display options, group by, and column visibility
- **+file** / **📂folder** — Create new file or directory
- **⬆upload** — Upload files (or drag from your OS file manager)

The title bar shows the current path (front-truncated for long paths).

## View Modes

Toggle between views via the **View** menu:

### List view
- Columns: Name, Size, Modified (plus optional Type, Created)
- Click column headers to sort (click again to reverse)

### Icon grid view
- Large folder/file icons with names
- Double-click to open files or navigate into directories

## Resizable Columns

In list view, column widths are fully adjustable:

- **Drag** column header borders to resize
- **Right-click** a column header to toggle column visibility or auto-fit all columns
- Columns use absolute widths (Windows Explorer behavior) -- they do not flex-fill the available space
- Column widths are persisted in localStorage across sessions

## Preview Panel

Toggle via **View > Show preview panel** to see file previews alongside the file list.

- **Auto layout**: the preview panel appears to the right (horizontal split) in wide windows, or below (vertical split) in tall windows
- Supports all file types: text, images, PDF, video, audio, HTML, DOCX, PPTX, XLSX

## Hidden Files

Toggle dotfile visibility via the **View** menu.

## Large Folders

Folders with many items load the first 100 entries. Click **"Load more"** at the bottom to fetch the next batch.

## Bookmarks

The left panel shows bookmarks for quick navigation.

### Managing bookmarks
- **Drag** a folder from the file list onto the bookmark panel to add it
- **Drag** bookmarks to reorder them
- **Right-click** a bookmark for: Open, Open in new window, Remove, Rename

### From the file list
- Right-click a folder → **"Add to bookmarks"** (starred folders show ★)

Bookmarks sync across all connected clients via WebSocket.

## File Operations

### Right-click context menu

**On folders:**
- Copy Path — copy absolute path to clipboard
- Add to bookmarks
- Sessions ▸ — submenu with "+ New session" and all sessions at this path
- Add to group ▸ — link folder to a session group
- Rename
- Delete

**On files:**
- Copy Path — copy absolute path to clipboard
- Open (in appropriate viewer)
- Edit (CodeMirror editor)
- Open as Hex
- Download
- Rename
- Delete

### Upload

- Click the **upload** button in the toolbar
- Or drag files from your OS file manager onto the file explorer

### Drag to terminal

Drag any file or folder from the explorer and drop it on a terminal window. The shell-escaped absolute path is typed into the terminal.

### Drag folder to group

Drag a folder from the explorer and drop it on a session group header in the sidebar to link it.

## File Viewers

Double-click a file to open it in the appropriate viewer:

| Type | Viewer | Features |
|------|--------|----------|
| Code/text | CodeMirror 6 | Syntax highlighting, word wrap, font size, auto-format (Shift+Alt+F), follows global theme |
| Markdown (.md) | CodeMirror 6 | Edit mode with Preview toggle (rendered markdown view) |
| HTML (.html) | CodeMirror 6 | Edit mode with Preview toggle (sandboxed iframe, same as markdown) |
| PDF | iframe | Native browser PDF viewer |
| Images | ImageViewer | Zoom (scroll wheel), drag-to-pan |
| Video | Native `<video>` | Browser's built-in controls |
| Audio | Native `<audio>` | Browser's built-in controls |
| CSV/TSV | Virtual scroll table | Only visible rows rendered. Pages of 200 rows loaded on demand from server streaming endpoint. Handles any file size. Text selectable. |
| Excel (.xlsx) | Sheet tabs table | Sheet tabs at bottom (click to switch). 5000 row limit. Text selectable. |
| Word (.docx) | docx-preview | Client-side visual rendering via docx-preview library. Full fidelity (headers, footers, tables, images, styles). Text selectable. |
| PowerPoint (.pptx) | Slide viewer | Slide thumbnail sidebar (resizable, high-res CSS-scaled) + main slide view. Keyboard navigation (arrows). Responsive resize. Text selectable. |
| Binary | HexViewer | Hex + ASCII display with 64KB chunk loading |

### Code editor features

The CodeMirror-based code editor supports:
- **Syntax highlighting** for JavaScript, Python, JSON, Markdown, HTML, CSS, and many more
- **Language override** dropdown to force a specific language (also drives Preview button visibility)
- **Auto-format** via Shift+Alt+F or toolbar button -- Prettier for JS/TS/JSON/HTML/CSS/MD/YAML/GraphQL, server-side for Python/Go/Rust/Shell
- **Word wrap** toggle
- **Font size** controls (A-/A+)
- **Theme** -- follows the global app theme
- **Markdown/HTML preview** toggle -- switch between code editing and rendered preview
- **Jump to line** -- when opened from a path with a `:line` suffix (e.g., from a chat message clickable path), the editor jumps to that line
- **Save** (Ctrl+S) and **Download** buttons

### Large file handling
- Files **>1MB** show a size warning before opening
- Binary files are auto-detected and opened in hex viewer
- Hex viewer loads in 64KB chunks for large files

## File Type Registry

All file type associations are defined in a single source of truth: `src/lib/file-types.js`. Adding support for a new file type requires only one entry in the registry -- the viewer dispatch, icon selection, and preview panel all read from the same data.

## Sorting

File explorer remembers your sort preference (column and direction) via localStorage. Change it by clicking column headers in list view.

In the View menu:
- **Mixed sort** -- When sorting by time, mix files and folders instead of grouping directories first
