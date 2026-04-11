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

User messages over 500 characters are automatically collapsed showing the first 120 characters as a preview with the total character count (e.g., "这是消息内容前120个字符... (1224 chars)"). Click to expand — the preview text hides and a "Collapse" button appears.

## Tool Visualization

Each tool call is rendered as a structured card showing the tool name, inputs, and results.

### File Operations

| Tool | Card Display |
|------|-------------|
| **Edit** | Diff view with +/- prefix columns (flex layout, prefix stays fixed on wrap), suffix context matching |
| **Write** | Line count, file size, full content with syntax highlighting + line numbers |
| **Read** | Line count, full content with syntax highlighting + line numbers |

Syntax highlighting uses highlight.js (30 languages), auto-detected from file extension. A searchable language dropdown next to the Wrap button allows manual override. Files >10KB defer highlighting until the `<details>` section is expanded.

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

To change the permission mode mid-session, click the lock icon in the status bar (see [Permission Mode Dropdown](#permission-mode-dropdown) under Status Bar).

## Subagent Support

When Claude uses the Agent tool (subagent), the chat view provides visibility into the subagent's execution.

### Architecture

Subagent viewers use a **virtual session** model. Each subagent gets a virtual session ID:
- **Live agents**: `sub-{parentToolUseId}` -- the server buffers messages and forwards new ones in real time
- **Completed agents**: `sub-agent-{agentId}` -- the server loads messages from the agent's saved JSONL file

The client opens a standard read-only ChatView attached to the virtual session. All buffering and message forwarding is handled server-side -- the client code is the same `ChatView` class used for regular sessions, just with `readOnly: true`.

### JSONL File Watcher

Claude's stream-json mode does not emit subagent assistant text messages (known bug: [anthropics/claude-code#8262](https://github.com/anthropics/claude-code/issues/8262)). To work around this, the server watches subagent JSONL files via `fs.watch()` for live text messages. Messages from the JSONL watcher are deduplicated by UUID against those already received via stream-json.

### Live Status

While the agent is running, the Agent tool card shows:
- A live message count ("12 messages")
- Current activity (thinking, running ToolName, responding)
- A **View Log** button to open a live viewer

### View Log

Clicking **View Log** on a running agent opens a read-only ChatView window (no input area, no status bar) that displays the subagent's messages in real time. New messages appear as the agent works. You can scroll up to review history while new messages continue arriving -- scrolling back to the bottom re-enables auto-scroll.

For completed agents, the View Log button opens a read-only ChatView populated from the agent's saved JSONL history.

Subagent messages are filtered from the main chat -- they only appear in the dedicated agent log viewer.

## Search

Press **Ctrl+F** to open the search bar. Features:

- Full-text search across the entire conversation history (not just the current view). Falls back to `/api/active` when JSONL path is unavailable.
- **CSS Custom Highlight API** for non-destructive highlighting (does not modify DOM)
- Match counter showing current position and total matches
- **Previous/Next** navigation (arrow buttons or Enter/Shift+Enter)
- Search results from outside the current view window automatically load the target messages

The highlight layer is re-applied when the view changes (scroll, pagination, expand/collapse).

## Input

### Text Input

- **Enter** sends the message (in normal mode). IME composition (CJK input) is detected and Enter is not intercepted during composing.
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

The interrupt uses a dual mechanism for reliability: a `control_request` with `subtype: 'interrupt'` is sent via stdin, and a SIGINT signal is sent to the claude child process as a fallback (working around known Claude Code bugs [#17466](https://github.com/anthropics/claude-code/issues/17466), [#3455](https://github.com/anthropics/claude-code/issues/3455)).

### Interrupt Result

When Claude is interrupted or hits a turn limit, the result message shows a human-readable label:

| Subtype | Label |
|---------|-------|
| `error_during_execution` | Interrupted |
| `error_max_turns` | Max turns reached |
| Other | Raw subtype value |

## TODO Display

When Claude uses the `TodoWrite` tool to track task progress, the current TODO state is displayed above the input area:

- Shows the current **in-progress** item with a hourglass icon and a progress count (e.g., "3/7")
- When all items are completed, the display is hidden
- **Click** the TODO display to expand a popup showing the full list with status icons:
  - Completed items
  - In-progress item (highlighted)
  - Pending items

The TODO list updates live as Claude calls `TodoWrite` with updated items.

## Status Bar

The status bar at the bottom of the chat view shows session metrics:

| Metric | Display | Description |
|--------|---------|-------------|
| **Model** | Badge | Active model name (e.g., claude-sonnet-4-20250514), read-only |
| **Permission mode** | Lock icon + mode | Current permission mode. **Click to open dropdown** and change mode mid-session (see below) |
| **Background tasks** | Spinner + count | Active background tasks (agents + commands). **Click for detail popup** (see below) |
| **Context usage** | Colored progress bar + percentage | How much of the context window is used. Colors: green (<70%), yellow (70-85%), orange (85-95%), red (>95%) |
| **Cache ratio** | Lightning bolt + percentage | Ratio of cache-read tokens to total input tokens |
| **Cost** | Dollar amount | Cumulative session cost. Colors: green (<$1), orange ($1-5), red (>$5) |

Status data comes from per-turn `usage` in assistant messages and `modelUsage` in result messages. It is persisted in the session's `chatStatus` and restored when re-attaching to an existing session.

### Permission Mode Dropdown

Click the lock icon in the status bar to open a dropdown listing available permission modes (sourced from `claude --help` output). Selecting a mode sends a `set-permission-mode` WebSocket message to the server, which writes a `control_request` with `subtype: 'set_permission_mode'` to Claude's stdin. The active mode is always displayed even if unknown (defaults to "default").

### Background Tasks

Two types of background tasks are tracked:

| Source | Detection | Icon |
|--------|-----------|------|
| **Agent tool** | `system.task_started` message | Robot |
| **Background commands** | `tool_use` with `run_in_background: true` | Lightning bolt |

The task count badge appears in the status bar when tasks are active. Click to open a popup showing each task's description and current activity. Clicking a task in the popup:
- **Agent tasks**: opens the subagent View Log viewer
- **Command tasks**: opens a temporary editor showing the command input and output

Tasks are removed when `task_notification` arrives (agent completion) or when the tool_result is received (command completion).

## Font Size

The chat message area respects the global terminal font size setting. The message list scales proportionally based on the font size relative to the 14px baseline. Change the font size via the global settings (toolbar gear icon > A-/A+).

## View Manager (Pagination)

The chat view uses a virtual scroll system with a sliding DOM window for efficient rendering of long conversations:

- On attach, the server normalizes all messages via `MessageManager` and sends the last 50 as normalized messages (with stable IDs, merged tool calls). All messages go through the same `MessageManager` — no separate "buffer" vs "JSONL" concept exposed to the client.
- **Scroll up** near the top to load earlier messages (50 at a time via `_extendTop`). When DOM exceeds ~150 elements, older messages at the bottom are trimmed (`_trimBottom`).
- **Scroll down** past the rendered window loads newer messages (`_extendBottom`) and trims the top (`_trimTop`) with scroll position preservation.
- **Wheel at top edge**: When `scrollTop=0`, scroll events stop firing. A wheel listener detects upward scroll intent and triggers pagination.
- **Auto-fill**: If initial content is shorter than viewport (no scrollbar), more messages are loaded automatically.
- **Position indicator**: A floating pill at top center shows "120–170 / 3000" when not pinned to bottom.

### Scroll Minimap

A semantic scrollbar on the right side of the message list provides an overview of the entire conversation:

- **User message markers**: Thin blue lines at each user input position
- **Compact markers**: Wider red lines at context compaction boundaries
- **Drag to navigate**: Click or drag the minimap to jump to any point in the conversation via `jumpToIndex`
- **Floating label**: Follows cursor vertically, showing time and a preview of the nearest user message (first ~10 chars, word-boundary truncated). Non-today messages include the date (e.g., "Apr 5 14:32 · Fix the...").
- **Viewport thumb**: Semi-transparent bar showing current rendered window position
- Hidden for short conversations (<3 turns). Native scrollbar hidden when minimap is active.

Turn data comes from `MessageManager.turnMap()`, included in the attach response or fetched via `?turnmap=1` API.

### Pin-to-Bottom

By default, the view auto-scrolls to show new messages. When you scroll up:
1. Auto-scroll is disabled
2. A scroll-to-bottom button appears (with a badge showing new message count)
3. Live messages arriving while viewing history are **deferred** — only the total count is updated and the badge increments. Messages load when you return to the bottom.
4. Click the button or scroll to the bottom to re-enable auto-scroll

The scroll-to-bottom uses iterative convergence across multiple animation frames (up to 10 rAF) to account for `content-visibility: auto` CSS optimization that may change scroll heights.

## View-Only Mode

Stopped sessions can be viewed without resuming:

- **View History button**: In the sidebar expand panel for stopped sessions, click "📋 View History" to open a read-only ChatView that loads JSONL history without running `claude --resume`
- **After terminate**: When a running session exits or is terminated while a window is open, the window automatically converts to read-only — the input area is hidden, and closing the window doesn't send a kill signal
- View-only sessions support full scroll-up pagination and minimap navigation
- Virtual session ID uses `view-{claudeSessionId}` prefix

## Draft Persistence

Chat input text is automatically saved every 300ms to the server and synced across all connected clients (Telegram-style):

- Drafts persist across page refresh (stored server-side via StateSync)
- Typing in one browser tab updates the textarea in another tab (unless actively focused)
- Drafts are cleared when the message is sent

## Clickable Paths and URLs

URLs and absolute file paths in messages are automatically detected and made interactive. Path detection uses a VS Code-style character exclusion regex. The `_linkify` function is HTML-aware: it splits content into tags and text segments, skipping `<a>` and `<code>` blocks to avoid double-linking.

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
