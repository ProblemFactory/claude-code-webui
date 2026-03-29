# External Editor (Ctrl+G)

When Claude Code prompts you to edit a file (via `Ctrl+G`), the WebUI opens a split-pane editor instead of launching an external application.

## How It Works

1. Claude Code invokes the editor command with a temp file path
2. The WebUI intercepts this via a fake `code` script that mimics VS Code
3. The terminal window splits: **terminal on top**, **CodeMirror editor on bottom**
4. Claude Code shows "Save and close editor to continue..." in the terminal
5. Edit the file, then click **"Save & Close"**
6. Claude reads the edited file and continues

### Why "code"?

Claude Code has a hardcoded whitelist of GUI editors: `["code", "cursor", "windsurf", "codium"]`. If the editor name matches, Claude skips clearing the screen. The fake script at `data/bin/code` is named to match this whitelist.

## Editor Features

The split-pane editor uses CodeMirror 6 with:

- **Syntax highlighting** — Auto-detected from file extension
- **Language override** — Dropdown in the toolbar to force a specific language
- **Word wrap** — Toggle button in toolbar
- **Font size** — A-/A+ buttons
- **Theme** — Follows terminal theme (dark/light auto-detection)
- **Indent with Tab** — Standard tab indentation
- **Line numbers** — Always visible

## Editor Toolbar

| Control | Description |
|---------|-------------|
| Language dropdown | Override auto-detected language |
| Wrap toggle | Toggle word wrap on/off |
| A- / A+ | Decrease / increase font size |
| Theme toggle | Switch dark/light |
| **Save & Close** | Write file and close editor pane |

## Resizable Split

Drag the divider between the terminal and editor to adjust the split ratio. The terminal re-fits automatically when the split changes.

## Multi-Device

When one client opens the editor, all connected clients see the split-pane open for the correct terminal window.
