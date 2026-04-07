# Chat Mode

Chat mode provides a structured message view for Claude Code sessions, as an alternative to the raw terminal TUI. It uses Claude's `--output-format stream-json` protocol to render messages with markdown, tool visualization, and interactive permission prompts.

## Creating a Chat Session

When creating a new session:
- The mode (Terminal or Chat) defaults to your **Default session mode** setting (Settings > Session Card)
- You can switch the mode via the split button on the new session dialog

When resuming a stopped session:
- The sidebar resume button uses your default mode setting
- The split button next to resume lets you choose Terminal or Chat explicitly
- The mode you last used for a session is remembered

Chat sessions show a speech bubble icon in the sidebar to distinguish them from terminal sessions.

## Message Display

### Layout Modes

**Compact mode** (default): A dense, document-style layout with role labels (You/Claude) on the left. Closer to the information density of a terminal session.

**Bubble mode**: Traditional chat-style bubbles. Toggle between modes via Settings > Chat > **Compact mode**.

### Role Indicators

In compact mode, you can choose how user and assistant messages are visually distinguished. Configure via Settings > Chat > **Role indicator style**:

| Style | Description |
|-------|-------------|
| **Border** (default) | Colored left border on each message |
| **Background** | Subtle background tint per role |
| **Icon** | Small icon before the role label |
| **Label** | Text label only (You/Claude) |

### Message Types

| Type | Rendering |
|------|-----------|
| **User messages** | Markdown-rendered text, inline image attachments |
| **Assistant messages** | Markdown with syntax highlighting in code blocks |
| **Thinking blocks** | Collapsible "Thinking..." section with raw text |
| **Tool use/result** | Specialized tool cards (see below) |
| **System notifications** | Collapsible details for task-notification and system-reminder |
| **System messages** | Disconnected/reconnected/session ended notices |

### Collapsible Long Messages

User messages over 500 characters are automatically collapsed with a preview of the first line. Click to expand and see the full message.

## Tool Visualization

Each tool call is rendered as a structured card showing the tool name, inputs, and results.

### File Operations

| Tool | Card Display |
|------|-------------|
| **Edit** | Diff view with added/removed lines, color-coded (green for additions, red for deletions) |
| **Write** | Line count, file size, and collapsible content preview |
| **Read** | Line count with collapsible file content |

### Other Tools

Non-file tools show a collapsible Input section and a collapsible Output section with the first line as a summary. Failed tools show an error section highlighted in red.

### Pending Tools

While a tool is running, a spinner indicates progress. For file operations (Edit/Write/Read), the file path is shown immediately. For other tools, the full input is visible while waiting for the result.

### Open in Editor

Each tool card has a clipboard button that opens the tool's input and output in a temporary CodeEditor window. This is useful for examining large outputs without scrolling through the chat. Messages also have a clipboard button that opens the message content in a temporary editor.

## Interactive Permissions

When Claude requests permission to use a tool (via `--permission-prompt-tool`), the permission prompt appears inline on the tool card:

- **Allow** -- approve this single tool use
- **Always Allow** -- approve and add a permanent permission rule (shown when suggestions are available)
- **Deny** -- reject the tool use

After responding, the button area shows the resolution status (Allowed / Always Allowed / Denied). The current permission mode is displayed in the status bar.

If a permission request is cancelled by Claude (e.g., due to interrupt), the prompt updates to show "Cancelled".

## Subagent Support

When Claude uses the Agent tool (subagent), the chat view provides visibility into the subagent's execution:

### Live Status

While the agent is running, the Agent tool card shows:
- A live message count ("12 messages")
- Current activity (thinking, running ToolName, responding)
- A **View Log** button to open a live viewer

### View Log

Clicking **View Log** on a running agent opens a read-only ChatView window that displays the subagent's messages in real time. New messages appear as the agent works.

For completed agents, the View Log button opens a read-only ChatView populated from the agent's saved JSONL history.

Subagent messages are filtered from the main chat -- they only appear in the dedicated agent log viewer.

## Search

Press **Ctrl+F** to open the search bar. Features:

- Full-text search across the entire conversation history (not just the current view)
- **CSS Custom Highlight API** for non-destructive highlighting (does not modify DOM)
- Match counter showing current position and total matches
- **Previous/Next** navigation (arrow buttons or Enter/Shift+Enter)
- Search results from outside the current view window automatically load the target messages

The highlight layer is re-applied when the view changes (scroll, pagination, expand/collapse).

## Input

### Text Input

- **Enter** sends the message (in normal mode)
- **Ctrl+Enter** sends the message (in expanded mode)
- **Shift+Enter** inserts a newline

The input area auto-grows up to 200px as you type.

### Expanded Input

Click the floating expand button (diagonal arrow) inside the textarea to toggle expanded mode. In expanded mode, the textarea gets a fixed 200px height for composing longer messages, and the send shortcut changes to Ctrl+Enter.

### Slash Commands

Type `/` to see all available slash commands from the current Claude session. The autocomplete dropdown appears immediately:
- Arrow keys navigate the list
- Tab or Enter accepts the selected command
- Typing narrows the matches (e.g., `/co` filters to `/compact`, `/config`)

Slash commands are loaded from the session's `system.init` message and persist across reconnects.

### Image Attachments

Paste an image from your clipboard (Ctrl+V) to add it as an attachment:
- A thumbnail preview appears above the input area
- Multiple images can be attached to a single message
- Click the X button on an attachment to remove it
- Images are sent as base64-encoded content blocks alongside the text message

## Interrupt

While Claude is responding, a streaming status bar appears above the input area showing the current activity (thinking, running ToolName, responding) with a spinner. Click the **Stop** button to interrupt Claude mid-response.

## Status Bar

The status bar at the bottom of the chat view shows session metrics:

| Metric | Display | Description |
|--------|---------|-------------|
| **Model** | Badge | Active model name (e.g., claude-sonnet-4-20250514) |
| **Permission mode** | Lock icon + mode | Current permission mode (e.g., default, plan) |
| **Context usage** | Colored progress bar + percentage | How much of the context window is used. Colors: green (<70%), yellow (70-85%), orange (85-95%), red (>95%) |
| **Cache ratio** | Lightning bolt + percentage | Ratio of cache-read tokens to total input tokens |
| **Cost** | Dollar amount | Cumulative session cost. Colors: green (<$1), orange ($1-5), red (>$5) |

Status data comes from per-turn `usage` in assistant messages and `modelUsage` in result messages. It is persisted in the session's `chatStatus` and restored when re-attaching to an existing session.

## Font Size

The chat message area respects the global terminal font size setting. The message list scales proportionally based on the font size relative to the 14px baseline. Change the font size via the global settings (toolbar gear icon > A-/A+).

## View Manager (Pagination)

The chat view uses a sliding window over the server's full message list for efficient rendering:

- On attach, the last 50 messages are loaded
- **Scroll up** near the top of the message list to automatically load earlier messages (50 at a time)
- **Jump to bottom** (scroll-to-bottom button or sending a message) loads the last 50 messages
- **Search results** jump to the target message index, loading that region of the conversation

The current window position (`[start, end)`) determines which messages are rendered. This allows browsing conversations with thousands of messages without loading everything at once.

### Pin-to-Bottom

By default, the view auto-scrolls to show new messages. When you scroll up:
1. Auto-scroll is disabled
2. A scroll-to-bottom button appears (with a badge showing new message count)
3. New messages increment the badge counter
4. Click the button or scroll to the bottom to re-enable auto-scroll

The scroll-to-bottom uses iterative convergence: it scrolls to the bottom across multiple animation frames (up to 10) to account for content-visibility recalculation that may change scroll heights.

## Clickable Paths and URLs

URLs and absolute file paths in messages are automatically detected and made interactive:

- **Click** copies the path/URL to clipboard (with tooltip feedback)
- **Ctrl+Click** opens the target:
  - URLs open in a new browser tab
  - File paths open in the file viewer or code editor
  - Directory paths open in the file explorer

### Path Suffixes

File paths with line number suffixes are supported:
- `/path/to/file.js:42` -- opens at line 42
- `/path/to/file.js:42:10` -- opens at line 42
- `/path/to/file.js:10-20` -- opens at line 10

## WebSocket Reconnect

If the WebSocket connection drops (server restart, network interruption):
1. A "Disconnected from server" message appears and the input is disabled
2. On reconnect, a "Reconnected" message appears
3. The chat view automatically re-attaches to the session
4. Any messages missed during the disconnection are fetched and rendered
5. The input is re-enabled

This ensures no messages are lost during brief network interruptions.
