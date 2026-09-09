# Settings

## Overview

The settings system has three layers:

1. **Global settings** (toolbar ⚙) — Quick access to theme, font size, font family
2. **Per-terminal settings** (window ⚙) — Override theme/font/size per terminal window
3. **Full settings UI** — VS Code-style dialog with all options, including backend-specific Claude/Codex launch defaults, accessible via "All Settings" link

Settings are stored server-side (sparse storage — only non-default values persisted) and sync across all connected clients via WebSocket.

## Opening Settings

- **Toolbar ⚙** → Quick popover with theme, font size (A-/A+), font family, and "All Settings" link
- **"All Settings"** → Full settings, category navigation and search. It opens as a **normal window** (not a blocking overlay), so you can drag it aside, resize it, and tweak a setting while watching the effect on your workspace live. Opening it again focuses the existing window.
- **Per-terminal ⚙** → Gear icon on each terminal window's title bar

## Global Settings (Quick Access)

The toolbar gear opens a popover with:

| Control | Description |
|---------|-------------|
| Theme dropdown | Switch between 6 themes |
| A- / A+ buttons | Decrease / increase terminal font size |
| Font family dropdown | Select terminal font (web fonts + system fonts) |

Changes apply immediately to all terminals that don't have per-terminal overrides.

## Language (English / 中文 / 日本語)

The ⚙ menu has a **Language** entry: Auto (follows your browser/system), English,
中文, or 日本語. The choice is **per device** (stored in this browser, not synced) —
your phone can run in Japanese while your desktop stays in English against the
same server. Switching reloads the page. Untranslated strings fall back to
English automatically. Agent-facing content (injected task context, CLI help
text) intentionally stays English.

## Backend Defaults

The full settings dialog has separate **Claude** and **Codex** sections. These defaults are applied when:

- Creating a new session with that backend
- Resuming a stopped session with that backend
- Switching the backend selector in the new-session dialog

Shared behavior such as default **Chat/Terminal** mode still lives under the generic **Session** section.

## Per-Terminal Overrides

Each terminal window's ⚙ popover allows overriding:

| Setting | Default behavior |
|---------|-----------------|
| Theme | "Default" follows global theme |
| Font size | "Default" checkbox follows global size |
| Font family | "Default" follows global font |

When "Default" is selected, the terminal follows whatever the global setting is. Set a specific value to override for just that terminal.

Overrides persist in the layout auto-save.

## All Settings Reference

### Toolbar & Layout

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `toolbar.showLayoutPresets` | boolean | `true` | Show the layout presets bar (built-in + custom grids + add button) |
| `toolbar.showCommandMode` | boolean | `true` | Enable Ctrl+\\ command mode |
| `toolbar.showBrowserButton` | boolean | `true` | Show the Browser button in the toolbar |
| `toolbar.showFileExplorerButton` | boolean | `true` | Show the Files button in the toolbar |
| `toolbar.showTerminalButton` | boolean | `true` | Show the Terminal button in the toolbar |
| `toolbar.showPresetsButton` | boolean | `true` | Show the saved-presets button in the toolbar |
| `sidebar.position` | enum | `left` | Dock the session sidebar to the `left` or `right` edge |
| `taskbar.position` | enum | `bottom` | Dock the taskbar (windows, desktops, usage) to the `bottom` or `top` |
| `taskbar.visibility` | enum | `show` | `show` / `autohide` (slides away, reveals on edge hover) / `hidden` |
| `taskbar.showDesktopPreviews` | boolean | `true` | Show virtual-desktop previews in the taskbar |
| `taskbar.showUsage` | boolean | `true` | Show the 5h/7d usage donuts |
| `taskbar.showWindowCount` | boolean | `true` | Show the "N windows" counter/list |
| `layout.enableDragSnap` | boolean | `true` | Snap windows to grid cells or screen edges when dragging |
| `layout.enableShiftDragSelection` | boolean | `true` | Hold Shift while dragging to select a range of grid cells |
| `layout.shakeBypassSnap` | boolean | `true` | Shake a window vigorously for ~1s while dragging to turn off grid/edge snap for the rest of that drag |
| `layout.shakeBypassSeconds` | number | `1` | How long (0.3–3s) you must keep shaking before grid snap turns off |
| `taskbar.desktopPreviewRatio` | number | `70` | Desktop preview size as % of taskbar height (30-100) |
| `chrome.arrangement` | json | `null` | Which bar hosts each movable element, in what order — written by Customize-mode drag |
| `chrome.zoneAlign` | json | `null` | Per-area alignment: window items left/center (Win11-style), toolbar center left/center/right, tray left/right end — written by Customize-mode chips |
| `chrome.springs` | json | `null` | Per-spring config: flexible with strength weight, or fixed width (px / % of screen) — written by the spring popover |

> Tip: the easiest way to change all of the above is **Customize mode** (⚙ menu → Customize UI…, or right-click empty toolbar/taskbar space → Customize UI…). It's a Firefox-style edit mode: every customizable element gets outlined on the real UI — **click** an element to hide/show it (hidden elements stay dimmed on screen while editing, so nothing disappears), **drag** an element to reorder it or move it to a different bar entirely (toolbar center, toolbar right, or the taskbar tray — e.g. drag the desktop previews and usage meters into the toolbar, then hide the whole taskbar). Segmented pills next to the taskbar/sidebar switch position (Top/Bottom, Left/Right) and taskbar visibility (Show/Auto-hide/Hidden), and mini **alignment chips** appear next to each alignable area: window items left/centered (Windows-11 style), toolbar-center content left/center/right, and the tray at the taskbar's left or right end. **+ Spring** inserts a flexible space (macOS-toolbar style) that pushes its neighbors apart — drag it between two elements for justify-between-style layouts (e.g. previews centered, usage pushed to the right edge). Click a spring to configure it: **Flexible** with a strength weight (two springs at 1× and 3× split leftover space 1:3) or **Fixed** width — in px or **% of screen width**, plus Remove. The **Match…** button enters a pick mode: click any bar element (the "☰ VibeSpace" section, a button, the previews…) to copy its width into the spring; keep clicking to *sum* multiple elements' widths; Done or Escape finishes. That's the one-click way to align an extra row's center with the toolbar's center: spring at the row start → Match → click the ☰ VibeSpace section. Two **extra bar rows** exist below the toolbar and next to the taskbar — invisible until you drag elements into them (e.g. give the layout presets their own full row), auto-hidden again when emptied. Escape or Done exits; Reset restores chrome defaults. A few core anchors (☰ sidebar toggle, the ⚙ gear, the window-item strip) are deliberately not movable; the New Session button is movable but can't be hidden. The right-click menus also keep direct toggles for quick single changes.

### Window

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `window.enableBounceOnFocus` | boolean | `false` | Scale-bounce when focused from sidebar/taskbar |
| `window.tabWrap` | boolean | `false` | Allow tab bar to wrap into multiple rows |
| `window.closeBehavior` | enum | `terminate` | Close window: terminate session, or detach (keep alive for re-attach) |
| `window.activeHighlightIntensity` | enum | `normal` | Focused window highlight: subtle (shadow), normal (accent border), strong (border + glow) |

### Terminal

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.minimumContrastRatio` | number | `1` | Auto-adjust text colors for contrast (4.5 = WCAG AA, 1 = disabled). Auto-set to 4.5 for light backgrounds. |
| `terminal.preserveCustomTitle` | boolean | `false` | Prevent Claude's title updates from overwriting user-set names |
| `terminal.preserveScrollOnFit` | boolean | `false` | Keep scroll position anchored on terminal resize |
| `terminal.waitingBlinkBehavior` | enum | `onlyUnfocused` | When to blink on idle: always, only when unfocused, never |

### Chat

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `chat.compactMode` | boolean | `true` | Dense document-style layout instead of chat bubbles |
| `chat.uploadDir` | string | *(empty)* | Where chat drag-drop/attached files land: empty = session working directory; absolute path (`~/Downloads`, `/data/uploads`) collects all uploads in one place; a bare name (`uploads`) = subfolder under the working directory. Remote sessions resolve it on the remote machine |
| `chat.touchEnterSends` | boolean | `false` | On touch devices, make the keyboard's enter key send instead of inserting a newline (default: newline; send via the ▶ button) |
| `chat.roleIndicator` | enum | `border` | How to distinguish user vs assistant messages: color border, background tint, icon, or text label |

### Session

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `session.defaultMode` | enum | `chat` | Default mode for new sessions and single-click resume: Terminal or Chat |

### Integration

Everything VibeSpace adds *into* your agent sessions lives here — and all of it can be turned off.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `agents.vibespaceIntegration` | boolean | `true` | **Master switch — everything the AGENT can see or use.** OFF = the model gets a pristine claude/codex: hook registration removed from `~/.claude/settings.json` + `~/.codex/hooks.json` immediately (restored on re-enable unless you removed the hook manually in Manage Agents), new sessions spawn with no VibeSpace env/tools, and already-running sessions stop receiving injected context, nudges and task reads. Model-invisible plumbing is exempt and keeps working: passive usage capture (statusline), billing/account env, Ctrl+G editor, session persistence, remote transport. Every option below applies only while this is ON. |
| `agents.stopBookkeepingNudge` | boolean | `true` | Stop-time bookkeeping nudge (one short follow-up when a session ends a turn with stale board state) |
| `agents.stopNudgeStaleMinutes` | number | `10` | Nudge only when the session hasn't updated its status for this long (1-240) |
| `agents.stopNudgeCooldownMinutes` | number | `30` | Minimum gap between nudges per session (2-720) |
| `agents.perTurnToolReminder` | boolean | `true` | One-line vibespace-tools reminder injected with every prompt |
| `agents.contextUpdateDiffs` | boolean | `true` | Mid-session Task Group changes delivered as diffs instead of full re-injection |
| `agents.injectPreamble` | text | `''` | Custom standing instructions injected once per session (≤4000 chars) |
| `agents.perTurnExtra` | text | `''` | Custom text injected with EVERY prompt (≤500 chars) |
| `agents.stopNudgeExtra` | text | `''` | Custom text prepended to the stop nudge (≤500 chars) |
| `agents.stopNudgeMaxUnanswered` | number | `3` | Stop nudging a session that has **never** reported a board status after this many nudges (any status report resets the count). `0` = never give up |
| `agents.allowGroupManagement` | boolean | `false` | Let designated "Group manager" sessions create/configure Task Groups via CLI |
| `agents.groupManagementRoots` | string | `~` | Comma-separated path prefixes manager agents may use for group folders |

> **Removed 2026-09-07: `agents.opencodeServeAutostart`.** The OpenCode background service (`opencode serve` on 127.0.0.1, which makes STOPPED OpenCode conversations list / open / resume / fork) is now the built-in **OpenCode background service** plugin — ⚙ → Plugins — and it is **off by default**. The first time you use OpenCode, VibeSpace offers to turn it on (once; "Not now" is remembered for the whole instance). `VIBESPACE_OPENCODE_SERVE=0/1` still overrides the plugin as an ops switch and the Plugins panel shows it as "forced by the environment". A stored value for the old setting is ignored — no migration.

### Spending

Every turn VibeSpace starts **without you** — the auto-continue after a usage limit, the Stop bookkeeping nudge, Background Work notifications, messages from another session, a Codex reset credit — passes ONE authorizer with the ceilings below. Turns *you* type are never counted. The counters are per **credential slot** (the account a turn will actually bill, so nine conversations parked on one subscription share one budget) and they are **persisted** in `data/spend-budget.json`: a release restart no longer hands the automatic spenders a fresh hour. A refusal is journalled and filed in the "For you" inbox, and nothing is lost — a notification that cannot be delivered live is injected into that conversation's next turn instead.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `spend.unattendedPerIdentityHour` | number | `12` | Most unattended turns on ONE account in a rolling hour. `0` = no automatic turns at all |
| `spend.unattendedPerIdentityDay` | number | `60` | The same ceiling over a rolling 24 hours |
| `spend.unattendedPerInstanceDay` | number | `200` | The ceiling across every account together — the bound that still holds when a subscription is added mid-incident |
| `spend.budgetNoticePct` | number | `80` | File one "For you" item when a budget reaches this share. `0` = never warn |
| `spend.allowOverageTurns` | boolean | `false` | OFF: while an account reports it is using **paid overage**, every turn VibeSpace would have started by itself on it is refused (with overage on, utilization stays under 100% while every token is billed pay-per-use). Turns you type always run |
| `pool.reserveFloorPct` | number | `15` | Keep this much of each account's **weekly** quota in reserve: below it a member stops being a *voluntary* pool switch target. It still serves its own conversations, and a conversation whose account is genuinely dead may still escape onto it. `0` = no floor |
| `pool.avoidOverageMembers` | boolean | `false` | Also keep the pool from switching conversations *onto* an account billing paid overage (escapes ignore it) |

### Claude

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `claude.defaultModel` | combobox | `''` | Default Claude model — dropdown aliases + "Custom..." for specific model IDs (e.g. claude-opus-4-6-20250414). Populated from `/api/available-models` (Claude `/v1/models`). **NEW sessions only (B-6b6d): a resumed conversation keeps its own model** — for claude that is whatever the CLI recorded, because VibeSpace commands nothing (a transcript names the model that served a turn but never its 1M-context variant, so passing the served id back would silently drop `[1m]`); a per-session override (card → Session parameters) still wins. |
| `claude.defaultPermissionMode` | enum | `''` | Default Claude permission mode for new or resumed Claude sessions |
| `claude.defaultEffort` | enum | `''` | Default Claude effort for NEW Claude sessions. Nothing claude writes records the effort a turn ran at, so a resume with no per-session pick commands **no** effort at all and the CLI's own config decides (B-6b6d) |
| `claude.defaultExtraArgs` | text | `''` | Extra Claude CLI args appended when starting a Claude session |
| `claude.disableModelFallback` | boolean | `false` | When safeguards flag a message, pause the turn instead of automatically switching models (CLI `switchModelsOnFlag:false` at spawn + `apply_flag_settings` to running chat sessions; `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` covers subagents of newly started sessions). A stopped turn shows a notice — rephrase and resend |
| `claude.brief` | boolean | `false` | Start new Claude sessions with the CLI's agent-to-user channel (`--brief`): the agent gets the `SendUserMessage` / `SendUserFile` tools and VibeSpace renders each call as a highlighted "message for you" card (files publish to a private link on this instance). OFF by default because it changes how the agent writes — with `--brief`, plain text outside the tool is hidden from the message view |
| `claude.systemPromptSnapshot` | enum | `''` (CLI default) | `--system-prompt-snapshot on\|off` — record the system prompt once per conversation and reuse it verbatim on every request and resume, which keeps the prompt cache warm across resumes. Blank = leave the CLI's own default alone |
| `claude.excludeDynamicSystemPromptSections` | boolean | `false` | `--exclude-dynamic-system-prompt-sections` — move the per-machine sections (cwd, env info, memory paths, git status) out of the system prompt and into the first user message, so the cached prefix is identical across machines and users. Only applies with the default system prompt |
| `claude.autocompact` | combobox | `''` (CLI default) | `--autocompact auto\|100k–1M` — the auto-compact window size. Compaction is what breaks the cached prefix, so a smaller window trades more compactions for cheaper requests. A value the CLI would reject is dropped rather than passed on |
| `claude.tuiRenderer` | enum | `''` (Auto) | TUI renderer for terminal-mode Claude sessions: Auto (CLI `/tui` preference), Fullscreen (flicker-free alt-screen, `CLAUDE_CODE_NO_FLICKER=1`), Classic (main screen) |

### Codex

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `codex.defaultModel` | combobox | `''` | Default Codex model — dropdown + "Custom..." for specific model IDs. Populated from ~/.codex/models_cache.json. **NEW sessions only (B-6b6d): a resumed thread keeps its own model**, read back from the rollout’s last `turn_context`; a per-session override (card → Session parameters) still wins. |
| `codex.defaultPermissionMode` | enum | `''` | Default Codex permission mode for new or resumed Codex sessions |
| `codex.defaultEffort` | enum | `''` | Default Codex reasoning effort for NEW Codex sessions — a resumed thread keeps the effort its own last `turn_context` ran at (B-6b6d) |
| `codex.defaultExtraArgs` | text | `''` | Extra Codex CLI args appended when starting a Codex session |

### OpenCode

These three shipped without an entry in `SETTINGS_CATEGORIES`, which is the Settings panel's render loop,
so they were never rendered, never searchable and never documented. Fixed 2026-09-09, together with the
same omission that had made every `Spending` row above unreachable; `scripts/test-architecture.mjs` §44
now fails the build if a category ever goes unlisted again.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `opencode.defaultModel` | combobox | `''` | A model id the agent offers (`provider/model`); the list fills from the agent once a session has started, empty keeps the agent default. NEW sessions only — a resumed conversation keeps the model OpenCode's own session record names (that needs the OpenCode background service; without it the default applies and the server log says which rung it used) |
| `opencode.defaultPermissionMode` | enum | `''` | Default OpenCode session mode for new sessions: `build` executes tools per its permission rules, `plan` disallows edits |
| `opencode.defaultExtraArgs` | text | `''` | Extra OpenCode CLI args appended when starting an OpenCode session |

### Sidebar

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidebar.activityRail` | boolean | `true` | vscode-style vertical icon rail (Folders/Task Groups/Remote/Ports panels + Agents/Plugins + launchers); off = classic tab bar + modal dialogs |
| `sidebar.railPersistent` | boolean | `true` | Collapsing the sidebar keeps the 44px rail strip on screen (vscode-style); click any icon to expand back |
| `sidebar.defaultStatusFilter` | multiSelect | live, tmux, external, stopped | Which statuses to show by default (excludes archived) |
| `sidebar.enableStatusQuickTabs` | boolean | `false` | Show ALL/LIVE/TMUX/EXT/STOP/ARCH quick-filter tabs |
| `sidebar.defaultTab` | enum | `folders` | Which sidebar tab opens on page load (folders / tasks / mounts) |
| `tasks.autoStyleOrder` | enum | `interleaved` | Auto Task-Group style sequencing: `interleaved` cycles lightness bands + line-style textures from the first groups (max difference, 4th group already dashed); `solid-first` uses 36 solid slots before any texture (cleaner for small setups). Live; reaches the server allocator so manual-pick masking matches |
| `sidebar.defaultBoardView` | enum | `groups` | Which Task Groups sub-view opens on load (groups / tasks) |

### Session Card

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionCard.clickBehavior` | enum | `focus` | Card click: focus window, expand details, flash window, or goto (switch desktop + flash) |
| `sessionCard.findMode` | enum | `find` | Find button default: find (flash in place) or goto (switch desktop + flash) |
| `sessionCard.clickToCopy` | boolean | `false` | Click detail values (ID, path, time) to copy to clipboard |
| `sessionCard.visibleFields` | multiSelect | all fields | Which fields to show in expanded card details |
| `sessionCard.detailTruncation` | enum | `left` | Truncate long values from left (show filename) or right (show path start) |

## Storage Details

- Settings are **sparse** — only non-default values are stored
- Server-side: `data/settings.json` with in-memory cache
- Changes broadcast via WebSocket `settings-updated` message
- Settings with `liveApply: true` take effect immediately
- Settings with `liveApply: false` take effect on next page load or component creation
