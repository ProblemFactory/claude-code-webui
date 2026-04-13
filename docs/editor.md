# External Editor (Ctrl+G)

When Claude Code prompts you to edit a file (via `Ctrl+G`), the WebUI opens a split-pane editor instead of launching an external application.

## How It Works

1. Claude Code invokes the editor command with a temp file path
2. The WebUI intercepts this via a fake `code` script that mimics VS Code
3. The terminal window splits: **terminal on top**, **CodeMirror editor on bottom**
4. Claude Code shows "Save and close editor to continue..." in the terminal
5. Edit the file, then click **"Save & Close"** or press **Ctrl+G** again
6. Claude reads the edited file and continues

The editor auto-focuses on open, so you can start typing immediately. Ctrl+G toggles the editor: first press opens it, second press saves and closes.

### Why "code"?

Claude Code has a hardcoded whitelist of GUI editors: `["code", "cursor", "windsurf", "codium"]`. If the editor name matches, Claude skips clearing the screen. The fake script at `data/bin/code` is named to match this whitelist.

## Editor Features

The split-pane editor uses CodeMirror 6 with:

- **Syntax highlighting** — Auto-detected from file extension
- **Language override** — Dropdown in the toolbar to force a specific language
- **Word wrap** — Toggle button in toolbar
- **Font size** — A-/A+ buttons
- **Theme** — Follows the global app theme (no separate theme toggle)
- **Auto-format** — Shift+Alt+F or the format button (&#8801;) in the toolbar. Prettier for JS, TS, JSON, HTML, CSS, Markdown, YAML, GraphQL. Server-side formatting for Python (ruff/black), Go (gofmt), Rust (rustfmt), Shell (shfmt).
- **Markdown preview** — Toggle between code editing and rendered preview for `.md` files
- **HTML preview** — HTML files open in the editor with a Preview toggle (sandboxed iframe, same behavior as markdown preview)
- **Jump to line** — When opened from a path with a `:line` suffix, the editor jumps to and highlights that line
- **Indent with Tab** — Standard tab indentation
- **Line numbers** — Always visible

## Editor Toolbar

| Control | Description |
|---------|-------------|
| Language dropdown | Override auto-detected language (also drives Preview button visibility) |
| Wrap toggle | Toggle word wrap on/off |
| A- / A+ | Decrease / increase font size |
| Format (&#8801;) | Format document via Prettier or server-side formatter |
| Preview | Toggle rendered preview (`.md` and `.html` files) |
| **Save & Close** | Write file and close editor pane |

## Resizable Split

Drag the divider between the terminal and editor to adjust the split ratio. The terminal re-fits automatically when the split changes.

## Multi-Device

When one client opens the editor, all connected clients see the split-pane open for the correct terminal window.
