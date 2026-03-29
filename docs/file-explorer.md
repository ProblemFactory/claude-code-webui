# File Explorer

Open a file explorer via the toolbar folder icon, command mode (`Ctrl+\` then `e`), or from the sidebar folder right-click menu.

## Navigation

- **Path bar** at the top with autocomplete (Tab/Enter to select)
- **↑** button to go up one directory
- **↻** button to refresh
- Supports `~` for home directory
- Title bar shows the current path (front-truncated for long paths)

## View Modes

Toggle between views with the toolbar icons:

### List view
- Columns: Name, Size, Modified (plus optional Type, Created)
- Click column headers to sort (click again to reverse)
- Right-click column header to show/hide columns

### Icon grid view
- Large folder/file icons with names
- Double-click to open files or navigate into directories

## Hidden Files

Toggle dotfile visibility with the **eye** button in the toolbar.

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
- Add to bookmarks
- Sessions ▸ — submenu with "+ New session" and all sessions at this path
- Add to group ▸ — link folder to a session group
- Rename
- Delete

**On files:**
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
| Code/text | CodeMirror 6 | Syntax highlighting, word wrap, font size, dark/light theme |
| Markdown | MarkdownViewer | Preview, Edit, and Split modes |
| PDF | iframe | Native browser PDF viewer |
| Images | ImageViewer | Zoom (scroll wheel), drag-to-pan |
| Video | Native `<video>` | Browser's built-in controls |
| Audio | Native `<audio>` | Browser's built-in controls |
| CSV | Table | Parsed as HTML table |
| Excel (.xlsx) | Table | Parsed via server-side library |
| Word (.docx) | HTML | Converted to HTML via server-side library |
| HTML | Dual mode | Preview (iframe) and Code (CodeEditor) toggle |
| Binary | HexViewer | Hex + ASCII display with 64KB chunk loading |

### Large file handling
- Files **>1MB** show a size warning before opening
- Binary files are auto-detected and opened in hex viewer
- Hex viewer loads in 64KB chunks for large files

## Sorting

File explorer remembers your sort preference (column and direction) via localStorage. Change it by clicking column headers in list view.

In the settings menu (gear icon in file explorer toolbar):
- **Mixed sort** — When sorting by time, mix files and folders instead of grouping directories first
