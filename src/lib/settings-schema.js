/**
 * Settings Schema — single source of truth for all configurable options.
 *
 * Each key is a dotted path (e.g. 'toolbar.showLayoutPresets').
 * Only non-default values are persisted (sparse storage).
 */

import { t } from './i18n.js';

const SETTINGS_SCHEMA = {
  // ── Toolbar & Layout ──
  'toolbar.showLayoutPresets': {
    type: 'boolean', default: true, label: t('Show layout presets'),
    description: t('Show the entire layout presets bar (built-in presets, custom grids, and + add button)'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'toolbar.showBrowserButton': {
    type: 'boolean', default: true, label: t('Show Browser button'),
    description: t('Show the embedded-browser button in the toolbar'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'toolbar.showTerminalButton': {
    type: 'boolean', default: true, label: t('Show Terminal button'),
    description: t('Show the plain-shell terminal button in the toolbar'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'toolbar.showPresetsButton': {
    type: 'boolean', default: true, label: t('Show Presets button'),
    description: t('Show the saved workspace presets button in the toolbar'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'toolbar.showFileExplorerButton': {
    type: 'boolean', default: true, label: t('Show Files button'),
    description: t('Show the file explorer button in the toolbar'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'sidebar.activityRail': {
    type: 'boolean', default: true, label: t('Activity rail (vscode-style)'),
    description: t('A vertical icon rail on the sidebar edge hosting the session panels (Folders / Task Groups / Remote / Ports) plus Agents, Plugins and quick launchers. Turn off to restore the classic tab bar and keep Agents/Plugins as dialogs.'),
    category: t('Sidebar'), liveApply: true,
  },
  'sidebar.railPersistent': {
    type: 'boolean', default: true, label: t('Keep the rail when the sidebar is collapsed'),
    description: t('vscode behavior: collapsing the sidebar leaves the 44px icon rail on screen — click any icon to expand back. Off = collapsing hides everything.'),
    category: t('Sidebar'), liveApply: true,
  },
  'sidebar.position': {
    type: 'enum', default: 'left', options: [
      { value: 'left', label: t('Left') },
      { value: 'right', label: t('Right') },
    ], label: t('Sidebar position'),
    description: t('Which screen edge the session sidebar docks to'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'taskbar.position': {
    type: 'enum', default: 'bottom', options: [
      { value: 'bottom', label: t('Bottom') },
      { value: 'top', label: t('Top') },
    ], label: t('Taskbar position'),
    description: t('Dock the taskbar (window list, desktop previews, usage) to the top or bottom of the screen'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'taskbar.visibility': {
    type: 'enum', default: 'show', options: [
      { value: 'show', label: t('Always visible') },
      { value: 'autohide', label: t('Auto-hide (reveal on edge hover)') },
      { value: 'hidden', label: t('Hidden') },
    ], label: t('Taskbar visibility'),
    description: t('Auto-hide slides the taskbar away and reveals it when the pointer touches the screen edge. Hidden removes it entirely (desktops still switch with Ctrl+Alt+Left/Right)'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'taskbar.showDesktopPreviews': {
    type: 'boolean', default: true, label: t('Show desktop previews'),
    description: t('Show the virtual-desktop miniature previews in the taskbar'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'taskbar.showUsage': {
    type: 'boolean', default: true, label: t('Show usage meters'),
    description: t('Show the 5h/7d rate-limit donuts in the taskbar'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'taskbar.showUserTodos': {
    type: 'boolean', default: true, label: t('Show the "For you" inbox'),
    description: t('Show the inbox of items agents filed for you (decisions/input needed) in the taskbar'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'taskbar.showWindowCount': {
    type: 'boolean', default: true, label: t('Show window count'),
    description: t('Show the "N windows" counter/list button in the taskbar'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'toolbar.showCommandMode': {
    type: 'boolean', default: true, label: t('Enable command mode'),
    description: t('Enable Ctrl+\\ command mode for keyboard-driven window management'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'layout.enableDragSnap': {
    type: 'boolean', default: true, label: t('Snap on drag'),
    description: t('Snap windows to grid cells or screen edges when dragging'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'layout.enableShiftDragSelection': {
    type: 'boolean', default: true, label: t('Shift-drag cell selection'),
    description: t('Hold Shift while dragging title bar to select a range of grid cells'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'desktop.dynamicEnabled': {
    type: 'boolean', default: false, label: t('Dynamic desktop (Stage)'),
    description: t('A special desktop at the left of the strip: sessions materialize into a shared slot together with their own workspace of helper windows. See docs/design-dynamic-desktop.md'),
    category: t('Window'), liveApply: true,
  },
  'desktop.stageKeepAlive': {
    type: 'number', default: 3, min: 0, max: 10, step: 1, label: t('Stage: workspaces kept alive'),
    description: t('How many recent session workspaces stay loaded (hidden) for instant switching; older ones are saved and closed'),
    category: t('Window'), liveApply: true,
  },
  'layout.presetOneShot': {
    type: 'boolean', default: false, label: t('Layout buttons apply once'),
    description: t('A layout button arranges the current windows once and returns to free-form. Off (default): it also keeps that grid active, so windows snap to its cells until you pick Freeform'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'layout.shakeBypassSnap': {
    type: 'boolean', default: true, label: t('Shake to bypass snap'),
    description: t('Shake a window vigorously for ~1 second while dragging to turn off grid/edge snap for the rest of that drag (a mouse-only alternative to holding Alt)'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'layout.shakeBypassSeconds': {
    type: 'number', default: 1, min: 0.3, max: 3, step: 0.1, label: t('Shake duration (seconds)'),
    description: t('How long you must keep shaking before grid snap turns off. Lower = triggers faster (but easier to trigger by accident).'),
    category: t('Toolbar & Layout'), liveApply: true,
  },

  'taskbar.desktopPreviewRatio': {
    type: 'number', default: 70, min: 30, max: 100, step: 5,
    label: t('Desktop preview size (%)'),
    description: t('How much of the taskbar height the desktop preview occupies (rest goes to label text)'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'chrome.arrangement': {
    type: 'json', default: null,
    label: t('Chrome element arrangement'),
    description: t('Which bar hosts each movable element, in what order ({zone: [elementId, …]}). Managed by Customize mode (⚙ → Customize UI… → drag elements); edit by hand only if you know what you are doing.'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'chrome.zoneAlign': {
    type: 'json', default: null,
    label: t('Chrome alignment'),
    description: t('Alignment per area: taskbar-items left/center (Windows-11-style centered icons), toolbar-center left/center/right, taskbar-tray left/right end. Managed by Customize mode.'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'chrome.springs': {
    type: 'json', default: null,
    label: t('Spring configs'),
    description: t('Per-spring config: {mode:"flex", weight:1-9} (strength = flex-grow share) or {mode:"fixed", px:N} (rigid spacer). Managed by Customize mode (click a spring).'),
    category: t('Toolbar & Layout'), liveApply: true,
  },

  // ── Window ──
  'window.enableBounceOnFocus': {
    type: 'boolean', default: false, label: t('Bounce on remote focus'),
    description: t('Briefly scale-bounce windows when focused from sidebar or taskbar'),
    category: t('Window'), liveApply: true,
  },
  'window.tabWrap': {
    type: 'boolean', default: false,
    label: t('Multi-row tabs'),
    description: t('Allow tab bar to wrap into multiple rows when there are many tabs (like a flow layout)'),
    category: t('Window'), liveApply: true,
  },
  'window.closeBehavior': {
    type: 'enum', default: 'detach',
    options: [
      { value: 'terminate', label: t('Terminate session') },
      { value: 'detach', label: t('Detach (keep alive)') },
    ],
    label: t('Window close behavior'),
    description: t('What happens when closing a session window: detach and keep it running (default — the session stays in the sidebar for re-attach), or terminate it. Automation helper terminals always terminate.'),
    category: t('Window'), liveApply: true,
  },
  'window.titlebarSwitchScope': {
    type: 'enum', default: 'overlap',
    options: [
      { value: 'overlap', label: t('Overlapping this window') },
      { value: 'desktop', label: t('Current desktop windows') },
      { value: 'all', label: t('All windows') },
    ],
    label: t('Title-bar "Switch window" scope'),
    description: t('Which windows the title-bar right-click menu\'s "Switch window" submenu lists: only windows overlapping this one (classic), every window on the current desktop, or all windows across desktops (entries name their desktop; picking one switches to it).'),
    category: t('Window'), liveApply: true,
  },
  'window.activeHighlightIntensity': {
    type: 'enum', default: 'normal',
    options: [
      { value: 'subtle', label: t('Subtle') },
      { value: 'normal', label: t('Normal') },
      { value: 'strong', label: t('Strong') },
    ],
    label: t('Active window highlight'),
    description: t('How prominently the focused window is highlighted (subtle = shadow only, normal = accent border, strong = border + glow)'),
    category: t('Window'), liveApply: true,
  },

  // ── Terminal ──
  'terminal.minimumContrastRatio': {
    type: 'number', default: 1, min: 1, max: 21, step: 0.5,
    label: t('Minimum contrast ratio'),
    description: t('Auto-adjust text colors to meet this contrast ratio (4.5 = WCAG AA). Set to 1 to disable.'),
    category: t('Terminal'), liveApply: false,
  },
  'terminal.preserveCustomTitle': {
    type: 'boolean', default: false, label: t('Preserve custom session title'),
    description: t('Prevent Claude\'s OSC title updates from overwriting user-set session names'),
    category: t('Terminal'), liveApply: true,
  },
  'terminal.preserveScrollOnFit': {
    type: 'boolean', default: false, label: t('Preserve scroll on resize'),
    description: t('Keep viewport scroll position anchored when terminal is resized'),
    category: t('Terminal'), liveApply: true,
  },
  'terminal.waitingBlinkBehavior': {
    type: 'enum', default: 'onlyUnfocused',
    options: [
      { value: 'always', label: t('Always') },
      { value: 'onlyUnfocused', label: t('Only when window not focused') },
      { value: 'never', label: t('Never') },
    ],
    label: t('Waiting blink behavior'),
    description: t('When to show the orange blink on idle terminals'),
    category: t('Terminal'), liveApply: true,
  },

  // ── Chat ──
  'chat.compactMode': {
    type: 'boolean', default: true, label: t('Compact mode'),
    description: t('Dense document-style layout instead of chat bubbles. Closer to TUI information density.'),
    category: t('Chat'), liveApply: true,
  },
  'chat.roleIndicator': {
    type: 'enum', default: 'border',
    options: [
      { value: 'border', label: t('Color border') },
      { value: 'background', label: t('Background tint') },
      { value: 'icon', label: t('Icon') },
      { value: 'label', label: t('Text label (You/Claude)') },
    ],
    label: t('Role indicator style'),
    description: t('How to visually distinguish user vs assistant messages in compact mode.'),
    category: t('Chat'), liveApply: true,
  },

  // ── Session ──
  'session.defaultMode': {
    type: 'enum', default: 'chat',
    options: [
      { value: 'terminal', label: t('Terminal') },
      { value: 'chat', label: t('Chat') },
    ],
    label: t('Default session mode'),
    description: t('Default mode for new sessions and single-click resume from sidebar'),
    category: t('Session'), liveApply: true,
  },
  'accounts.shipSubscriptionToRemote': {
    type: 'boolean', default: false,
    label: t('Ship subscription logins to remote hosts'),
    description: t('OFF (recommended): a subscription (Pro/Max) account can only run on THIS machine; for a remote host, log in on the host instead. Turning this ON copies the subscription’s login to the remote host — its token then appears from that host’s IP (often a datacenter), which can look like account abuse to Anthropic and risk a ban. API-key accounts are always allowed on remote hosts and are unaffected by this.'),
    category: t('Session'), liveApply: true,
  },
  'chat.showHookCards': {
    type: 'boolean', default: true,
    label: t('Show hook cards in chat'),
    description: t('Hook events (context injections, plugin hooks, stop nudges) render as collapsible ✓/✗ cards. Turn off to hide them all — applies to open chats instantly.'),
    category: t('Chat'), liveApply: true,
  },
  'chat.hideEmptyHooks': {
    type: 'boolean', default: true,
    label: t('Hide hooks with no output'),
    description: t('Hooks like PostToolUse fire on every tool call with nothing to show — by default those render no card at all. Turn off to see every hook event. Applies to newly loaded history (reopen the window for existing views).'),
    category: t('Chat'), liveApply: true,
  },
  'chat.touchEnterSends': {
    type: 'boolean', default: false,
    label: t('Enter sends on touch devices'),
    description: t('On phones and tablets the keyboard\u2019s enter key inserts a newline by default (soft keyboards have no Shift+Enter, so this is the only way to type one) and messages are sent with the send button. Turn on to make enter send instead.'),
    category: t('Chat'), liveApply: true,
  },
  'chat.hideEmptyThinking': {
    type: 'boolean', default: true,
    label: t('Hide empty thinking blocks'),
    description: t('Thinking cards with no visible text (redacted or zero-length thinking) are hidden. They never count toward or break run collapsing. Turn off to see every thinking card — applies to open chats instantly.'),
    category: t('Chat'), liveApply: true,
  },
  'chat.collapseRuns': {
    type: 'boolean', default: true,
    label: t('Collapse runs of working cards'),
    description: t('Consecutive working cards (kinds picked below) fold behind a one-line summary, like the Claude Code TUI — click to expand. The summary shows per-kind counts, the touched file names (✎ marks writes, memory/… marks agent-memory files) and a ✗ failure count. Searching expands everything.'),
    category: t('Chat'), liveApply: true,
  },
  'chat.collapseKinds': {
    // SEMANTIC kinds, one global set for every backend (Track B, owner-decided:
    // per-provider checkbox copies = config sprawl) — each backend's normalizer
    // maps its own tool names in (claude Bash / codex exec are both 'bash').
    type: 'multiSelect', default: ['thinking', 'bash', 'read', 'memory', 'mcp', 'skill', 'agent', 'search', 'image'],
    options: [
      { value: 'thinking', label: t('Thinking blocks') },
      { value: 'search', label: t('Web searches / fetches (WebSearch, WebFetch, web_search)') },
      { value: 'image', label: t('Image views (Read of an image file / view_image)') },
      { value: 'bash', label: t('Command runs (Bash / exec / terminal)') },
      { value: 'read', label: t('File reads') },
      { value: 'write', label: t('File writes (Write/Edit/Patch)') },
      { value: 'memory', label: t('Agent memory files (reads AND writes)') },
      { value: 'mcp', label: t('MCP tool calls (any server)') },
      { value: 'skill', label: t('Skill launches') },
      { value: 'agent', label: t('Sub-agent orchestration (spawn/wait/messages)') },
      // NOT in the default set: a sub-agent's report is the answer the user is
      // reading, not orchestration noise (B-7473 integration 2026-09-06)
      { value: 'report', label: t('Sub-agent reports (a child agent’s written answer)') },
    ],
    label: t('Card kinds that collapse'),
    description: t('Which card kinds fold into the summary line, by MEANING — the same setting covers every backend (claude Bash and codex exec are both command runs). Enabled kinds collapse TOGETHER as one interleaved group (think → read → edit → run is the real work pattern; per-kind groups rarely get long enough to fold). Memory = operations on the agent\'s own memory directory — housekeeping, folded by default and listed as memory/<name> in the summary; project-file writes are off by default — diffs are usually worth seeing. A run of only thinking needs two or more; any tool card folds immediately. Cards waiting for your approval never fold.'),
    category: t('Chat'), liveApply: true,
  },
  'chat.reducedMotionSpin': {
    type: 'boolean', default: false,
    label: t('Keep the spinner rotating under reduced motion'),
    description: t('With "reduce motion" enabled in your OS, the working spinner normally swaps its rotation for a gentle opacity pulse. Turn this on to keep the rotation instead (the pulse can read as blinking).'),
    category: t('Chat'), liveApply: true,
  },
  'chat.uploadDir': {
    type: 'string', default: '',
    label: t('Upload files to'),
    description: t('Where files dropped or attached in chat are saved. Empty = the session’s working directory (default). Set an absolute path (e.g. ~/Downloads or /data/uploads) to collect every upload in one place, or a name (e.g. uploads) for a folder under the working directory. For remote sessions the path is on the remote machine.'),
    category: t('Chat'), liveApply: true,
  },
  'agents.vibespaceIntegration': {
    type: 'boolean', default: true,
    label: t('VibeSpace agent integration (master switch)'),
    description: t('Everything the AGENT can see or use from VibeSpace. ON (default): sessions get the VibeSpace hooks (Task Group context, per-turn reminders, stop nudge) and the vibespace-status/ask/task tools on their PATH. OFF: the model gets a pristine claude/codex — the hook registration is removed from ~/.claude/settings.json and ~/.codex/hooks.json immediately (restored on re-enable, unless you had removed the hook manually in Manage Agents), new sessions spawn with no VibeSpace env or tools, and already-running sessions stop receiving injected context, nudges and task reads. Model-INVISIBLE plumbing keeps working either way: passive usage capture (statusline), billing/account env, the Ctrl+G editor, session persistence and remote transport. Every option below only applies while this is ON.'),
    category: t('Integration'), liveApply: true,
  },
  'agents.contextInjection': {
    type: 'boolean', default: true,
    label: t('Inject Task Group context'),
    description: t('Deliver each session\'s Task Group context (objective, shared-context folder index, activity log, update diffs) into the agent via hooks. OFF: agents get no group payloads at all — the reporting tools below still work if enabled. The per-group "Inject context" checkbox in the group\'s detail window is the finer-grained version of this.'),
    category: t('Integration'), liveApply: true,
  },
  'agents.toolStatus': {
    type: 'boolean', default: true,
    label: t('Agent tool: vibespace-status (board state)'),
    description: t('Lets agents self-report working/blocked/needs-input/… onto the session board. OFF: the tool is no longer taught in injected context or reminders, its endpoint refuses with skip-and-continue guidance, and the stop-time bookkeeping nudge (which is keyed on status staleness) never fires. Synthesized states (idle detection) keep working.'),
    category: t('Integration'), liveApply: true,
  },
  'agents.toolAsk': {
    type: 'boolean', default: true,
    label: t('Agent tool: vibespace-ask (your inbox)'),
    description: t('Lets agents mirror questions/decisions onto your "For you" inbox. OFF: not taught, endpoint refuses with skip-and-continue guidance — agents ask only in chat.'),
    category: t('Integration'), liveApply: true,
  },
  'agents.toolTask': {
    type: 'boolean', default: true,
    label: t('Agent tool: vibespace-task (activity log & backlog)'),
    description: t('Lets agents log finished work into the group activity log and park items in the group backlog. OFF: not taught, the progress/backlog write endpoints refuse with skip-and-continue guidance; reading group state (vibespace-task show) still works while context injection is on.'),
    category: t('Integration'), liveApply: true,
  },
  'agents.toolJobs': {
    type: 'boolean', default: true,
    label: t('Agent tool: vibespace-job (background work)'),
    description: t('Lets agents register services, long tasks and cron schedules that outlive their conversation (Background Work window). OFF: not taught, endpoints refuse with skip-and-continue guidance; existing jobs keep running and stay visible to you.'),
    category: t('Integration'), liveApply: true,
  },
  'agents.jobNotify': {
    type: 'boolean', default: true,
    label: t('Background jobs: notify the owner conversation'),
    description: t('When a background job finishes, fails, is parked, or needs input, its owner conversation gets a message through Claude Code’s own cross-session messaging inbox (delivered by the CLI under its inbound rules; an idle session starts a turn, billed like a typed prompt). When the conversation is closed, the notification is stashed and injected the next time it resumes. Per-group override in the Task Group detail window; per-job override at creation (--notify on/off).'),
    category: t('Integration'), liveApply: true,
  },
  'agents.vibespaceChannel': {
    type: 'boolean', default: false,
    label: t('VibeSpace channel (experimental)'),
    description: t('Registers VibeSpace as a Claude Code channel in NEW local claude sessions (research-preview CLI feature, enabled per spawn via the development-channels flag). Job notifications then arrive as structured <channel source="vibespace"> events instead of plain peer messages, and this becomes the bridge for future external chat integrations. Sessions must be recreated to pick up a change. Leave off unless experimenting.'),
    category: t('Integration'), liveApply: true,
  },
  'agents.stopNudgeStaleMinutes': {
    type: 'number', default: 10, min: 0, max: 240, step: 1,
    label: t('Stop nudge: staleness threshold (minutes)'),
    description: t('The nudge only fires when the session has not updated its board status for this long. Lower = agents are reminded more eagerly; higher = quieter. 0 = always considered stale (with cooldown 0 too, the nudge fires on EVERY stop — one bookkeeping mini-turn per turn).'),
    category: t('Integration'), liveApply: true,
  },
  'agents.stopNudgeCooldownMinutes': {
    type: 'number', default: 30, min: 0, max: 720, step: 1,
    label: t('Stop nudge: cooldown per session (minutes)'),
    description: t('After nudging a session once, wait at least this long before nudging it again — the ceiling on how often an agent pays the bookkeeping mini-turn. 0 = no cooldown.'),
    category: t('Integration'), liveApply: true,
  },
  'agents.stopBookkeepingNudge': {
    type: 'boolean', default: true,
    label: t('Stop-time bookkeeping nudge for agents'),
    description: t('When an agent finishes a turn while its board state is stale (no status update in 10 minutes), it gets one short follow-up asking it to set vibespace-status, mirror open questions with vibespace-ask, and log finished work — then it stops. At most once per 30 minutes per session. Claude enforces this via a blocking Stop hook; Codex via its wrapper at turn end.'),
    category: t('Integration'), liveApply: true,
  },
  'ports.watchNew': {
    type: 'boolean', default: true,
    label: t('Notify when a machine opens a new port'),
    description: t('VS Code-style port discovery: linked machines (paired devices / connected hosts) are checked every ~30s, and a service that STARTS listening (a dev server, a database) shows a toast offering to forward it. Ports above 32767 and ports already forwarded are ignored. Turn off to stop the background checks.'),
    category: t('Session'), liveApply: true,
  },
  'claude.outputStyle': {
    // enum options are {value,label} OBJECTS (settings-ui contract) — the
    // 2.368.0 plain-string list rendered a fully BLANK dropdown (owner-caught)
    type: 'enum', default: '', options: [
      { value: '', label: t('CLI default') },
      { value: 'Concise', label: 'Concise' },
      { value: 'Explanatory', label: 'Explanatory' },
      { value: 'Learning', label: 'Learning' },
      { value: 'Proactive', label: 'Proactive' },
    ],
    label: t('Default output style (Claude)'),
    description: t('The CLI output style new chat sessions start with. "Concise" makes Claude lead with results and skip preamble. Blank = the CLI\'s own default. A stream-json session cannot switch style mid-conversation, so a change takes effect on the next resume; the chat status bar sets it per session.'),
    category: t('Claude'), liveApply: true,
  },
  'claude.autoResumeOnLimit': {
    type: 'boolean', default: false,
    label: t('Continue automatically when a usage limit resets'),
    description: t('DEFAULT for new chat sessions: when the account is out of quota and there is no other account to switch to, wait for the reset and then continue the interrupted task by itself. Each session can override this in the chat status bar. Off by default because continuing spends quota without you being there.'),
    category: t('Claude'), liveApply: true,
  },
  'codex.limitResetCredit': {
    type: 'enum', default: 'off', options: [
      { value: 'off', label: t('Off — never spend a reset credit automatically') },
      { value: 'auto', label: t('Auto — consume one before switching accounts') },
    ],
    label: t('Use stored reset credits on a usage limit (Codex)'),
    description: t('ChatGPT plans can hold rate-limit reset credits. When a Codex session hits a limit, "Auto" consumes one stored credit first (the limit resets and the same account continues); only if that fails does VibeSpace fall back to switching accounts (pool) and then waiting for the reset. Off by default because it spends a stored credit without you being there.'),
    category: t('Codex'), liveApply: true,
  },
  'agentd.publicUrl': {
    type: 'string', default: '',
    label: t('This instance\'s public address (for reverse mounts)'),
    description: t('The https/http URL a remote machine uses to reach THIS VibeSpace (reverse mounts, remote agent installs, page share links). Leave blank to let each browser use its own address. The Ports panel\'s "This VibeSpace" row can map the whole instance to an frp URL, which takes precedence while mapped WITHOUT changing this value.'),
    category: t('Session'), liveApply: true,
  },
  'agentd.autoGraduate': {
    type: 'boolean', default: true, category: 'Integration',
    label: t('Move machines to a ws link automatically'),
    description: t('When an SSH machine\u2019s agent is reachable, install it as a service so it dials back over WebSocket \u2014 fewer per-command SSH spawns and a link that notices breakage. Only runs when a public URL is set above; SSH always stays as the rescue channel.'),
  },
  'agentd.localPipeSessions': {
    type: 'boolean', default: false, category: 'Integration',
    label: t('Local sessions via device daemon (R6)'),
    description: t('New local chat sessions run as device-daemon pipe sessions instead of dtach — the session-brain final form (survives server restarts via the daemon). Existing sessions are never migrated; any daemon failure falls back to dtach at spawn. Leave off until the device-assisted consumer path has soaked.'),
  },
  'agentd.localDiscovery': {
    type: 'boolean', default: false, category: 'Integration',
    label: t('Local session discovery via device daemon'),
    description: t('The 5s session-list sweep reads its filesystem facts (lock files, transcript listing, tail ids) from the device daemon\'s snapshot — computed in a daemon child process, so a slow or network-mounted home directory can never stall the server. Local enrichment (window mapping, tmux) is unaffected. Falls back to the local scan on any failure.'),
  },
  'agents.injectPreamble': {
    type: 'text', default: '',
    label: t('Custom agent instructions (injected)'),
    description: t('Your own standing instructions for every agent session, injected at the TOP of the VibeSpace hook context (task context or the baseline tools intro). Delivered once per session and re-delivered when you change it — never on every turn. Edit comfortably in Manage Agents → Agent instructions. Max 4000 chars.'),
    category: t('Integration'), liveApply: true,
  },
  'agents.perTurnExtra': {
    type: 'text', default: '',
    label: t('Per-turn reminder extra (injected EVERY prompt)'),
    description: t('Short custom text placed at the top of the per-turn reminder — reaches the agent on EVERY message you send, so keep it tight (≤500 chars; it costs tokens each turn). Delivers even if the standard tool reminder is turned off. Edit in Manage Agents → Agent instructions.'),
    category: t('Integration'), liveApply: true,
  },
  'agents.stopNudgeExtra': {
    type: 'text', default: '',
    label: t('Stop-nudge extra (injected when the bookkeeping nudge fires)'),
    description: t('Custom text placed at the top of the stop-time bookkeeping nudge (≤500 chars) — e.g. extra end-of-turn duties for your agents. Edit in Manage Agents → Agent instructions.'),
    category: t('Integration'), liveApply: true,
  },
  'agents.perTurnToolReminder': {
    type: 'boolean', default: true,
    label: t('Per-turn tool reminder for agents'),
    description: t('Injects a one-line (~250 byte) reminder of the vibespace tools (status / ask / task) with every prompt you send, so agents keep using them in long sessions — the full rules injected at session start scroll out of the working context over time. Turn off to save the few tokens per turn.'),
    category: t('Integration'), liveApply: true,
  },
  'agents.contextUpdateDiffs': {
    type: 'boolean', default: true,
    label: t('Task Group updates as diffs'),
    description: t('When a Task Group changes mid-session, agents receive only WHAT changed (new activity entries, objective edits, backlog changes, changed shared files) instead of the whole group context again. The full context is still delivered on first contact and after a server restart. Turn off to always re-send the complete state.'),
    category: t('Integration'), liveApply: true,
  },
  'agents.allowGroupManagement': {
    type: 'boolean', default: false,
    label: t('Allow agents to manage Task Groups'),
    description: t('Lets sessions YOU designate as "Group manager" (Session Properties) create and configure Task Groups via their CLI — create/update/bind/unbind, the same organize-only operations you perform in the UI. Paths they may use are limited by the roots setting below; every operation is recorded in the group\'s activity log. Off = the API refuses all agents.'),
    category: t('Integration'), liveApply: true,
  },
  'agents.groupManagementRoots': {
    type: 'string', default: '~',
    label: t('Group management path roots'),
    description: t('Comma-separated absolute path prefixes a manager agent may use for a group\'s context folder / auto-include folders (~ = your home). Keeps agents from pointing context injection at arbitrary paths.'),
    category: t('Integration'), liveApply: true,
  },
  'accounts.onDemandQuotaRefresh': {
    type: 'enum', default: 'manual',
    options: [
      { value: 'manual', label: t('Manual only (⟳ button)') },
      { value: 'auto', label: t('Auto on popup open (when >30 min stale)') },
      { value: 'auto-cli', label: t('Auto via the CLI (burn-aware background refresh)') },
      { value: 'off', label: t('Off (never contact Anthropic)') },
    ],
    label: t('On-demand quota refresh (model-scoped limits like Fable)'),
    description: t('The passive statusline feed only carries the 5h/7d windows — model-scoped weekly limits (e.g. Fable) can ONLY come from asking Anthropic’s usage endpoint with the account’s own login token. This is the same non-billable call the CLI makes when you run /usage, throttled to ≥60s per account and honoring rate-limit backoff, and it NEVER runs on a timer. It is user-initiated traffic, categorically different from the background polling that has gotten accounts banned — but it is still an off-CLI request with a subscription token, so it is your call: Manual = only when you click ⟳; Auto = also once when you open the quota popup and the data is stale; Off = never (the ⟳ button disappears and scoped limits stay unknown); Auto via the CLI = a background loop spawns `claude -p /usage` (the official binary makes the fetch — this app never calls the endpoint itself) with a BURN-AWARE cadence: refreshes within minutes when the dead-reckoner sees real spending drift, 45min-with-jitter staleness cap for active accounts, and idle accounts are never polled.'),
    category: t('Session'), liveApply: true,
  },
  'usage.dashboard': {
    type: 'json', default: null,
    label: t('Usage dashboard panels'),
    description: t('The configurable panel layout of the Usage window ({metric, dim, chart, span, topN} per panel). Managed by the Usage window itself (Panels… menu, per-panel ✎/⋯); edit by hand only if you know what you are doing.'),
    category: t('Session'), liveApply: true,
  },
  'telemetry.enabled': {
    type: 'boolean', default: true,
    label: t('Local diagnostics (errors + feature usage)'),
    description: t('Records page errors, boot crashes and coarse feature events (window opened, session created — names only, never content) into data/telemetry/ on THIS server. Nothing leaves your instance unless a forward URL is set below. Powers the ⚙ → Diagnostics report.'),
    category: t('Session'), liveApply: true,
  },
  'telemetry.forwardUrl': {
    type: 'text', default: '',
    label: t('Forward diagnostics to a central collector (URL)'),
    description: t('Optional, for team deployments: POST event batches (with an anonymous per-instance id) to this URL so one maintainer can see errors across all instances. Leave empty to keep everything local.'),
    category: t('Session'), liveApply: true,
  },
  'telemetry.forwardToken': {
    type: 'text', default: '',
    label: t('Central collector token'),
    description: t('Sent as a Bearer Authorization header with forwarded batches when the collector requires a shared token (a VibeSpace collector always does). Leave empty if none is required.'),
    category: t('Session'), liveApply: true,
  },
  'usage.otelTruth': {
    type: 'boolean', default: true,
    label: t('Per-request billing truth (local telemetry)'),
    description: t('New LOCAL claude sessions export the CLI’s own OpenTelemetry api_request events to this VibeSpace instance over loopback (never to any external endpoint). Each event names the organization that ACTUALLY billed the request, so the usage ledger, quota estimates and pool decisions stay correct even while a running session still holds a pre-switch token after a pool account switch. Zero extra Anthropic traffic — the CLI pushes locally. Applies to sessions started after the change.'),
    category: t('Session'), liveApply: true,
  },
  'accounts.activeUsagePolling': {
    type: 'boolean', default: false, confirmOn: true,
    label: t('⚠ Actively poll subscription usage (automation risk)'),
    description: t('OFF (recommended): usage bars are captured passively from your live terminal sessions — VibeSpace never contacts Anthropic on its own. Turning this ON restores the old behavior: the server calls Anthropic’s usage endpoint on a ~90s timer with each subscription’s token, even for idle accounts. That off-CLI, fixed-cadence, non-human traffic is exactly what can get a Pro/Max account flagged as automated and BANNED — a real account was banned+refunded for this. Only enable it if you accept that risk (e.g. to see live usage for chat-only or idle accounts).'),
    category: t('Session'), liveApply: true,
  },

  'taskbar.toastSeconds': {
    type: 'number', default: 6, min: 2, max: 60,
    label: t('Notification popup duration (seconds)'),
    description: t('How long toast cards (new inbox items, errors, confirmations) stay on screen. They appear next to the inbox button and every one is kept in the inbox popup’s Notifications tab.'),
    category: t('Toolbar & Layout'), liveApply: true,
  },
  'mounts.vfsCacheMaxSizeGB': {
    type: 'number', default: 10, min: 1, max: 500,
    label: t('Storage mount cache size (GB)'),
    description: t('Per-mount disk budget for the rclone read/write cache (vfs-cache-mode full). Reads are cached chunk-wise on local disk; writes land locally and upload in the background — the cache survives crashes and resumes uploading on reconnect. Applied when a mount (re)connects.'),
    category: t('Session'), liveApply: true,
  },

  // ── Claude ──
  'claude.defaultModel': {
    type: 'enum', default: '', combobox: true,
    options: [
      { value: '', label: t('Default') },
      { value: 'fable', label: 'fable (latest, 200k)' },
      { value: 'fable[1m]', label: 'fable[1m] (latest, 1M context)' },
      { value: 'opus', label: 'opus (latest, 200k)' },
      { value: 'opus[1m]', label: 'opus[1m] (latest, 1M context)' },
      { value: 'sonnet', label: 'sonnet (latest)' },
      { value: 'sonnet[1m]', label: 'sonnet[1m] (latest, 1M context)' },
      { value: 'haiku', label: 'haiku (latest)' },
    ], // dynamically updated from /api/available-models; Custom... allows typing full model IDs
    label: t('Default model'),
    description: t('Select an alias or choose "Custom..." to type a specific model ID (e.g. claude-opus-4-6-20250414).'),
    category: t('Claude'), liveApply: true,
  },
  'claude.defaultPermissionMode': {
    type: 'enum', default: '',
    options: [
      { value: '', label: t('Default') },
      { value: 'auto', label: t('Auto') },
      { value: 'bypassPermissions', label: t('Bypass') },
      { value: 'plan', label: t('Plan') },
      { value: 'acceptEdits', label: t('Accept Edits') },
    ],
    label: t('Default permission mode'),
    description: t('Default Claude permission mode for new or resumed Claude sessions.'),
    category: t('Claude'), liveApply: true,
  },
  'claude.defaultEffort': {
    type: 'enum', default: '', combobox: true,
    options: [
      { value: '', label: t('Auto (model default)') },
      { value: 'low', label: t('Low') },
      { value: 'medium', label: t('Medium') },
      { value: 'high', label: t('High') },
      { value: 'max', label: t('Max') },
    ], // dynamically updated from claude --help; Custom... allows typing values like xhigh
    label: t('Default effort level'),
    description: t('Select a level or choose "Custom..." to type any value (e.g. xhigh).'),
    category: t('Claude'), liveApply: true,
  },
  'claude.defaultExtraArgs': {
    type: 'text', default: '',
    label: t('Default extra args'),
    description: t('Extra Claude CLI args appended when starting a Claude session.'),
    category: t('Claude'), liveApply: true,
  },
  'claude.disableModelFallback': {
    type: 'boolean', default: false,
    label: t('Disable model fallback'),
    description: t('When safeguards flag a message, pause the turn instead of automatically switching to another model (the CLI\'s "Switch models when a message is flagged" set to off). Applies to new sessions at start and to running chat sessions from their next turn; sessions started while enabled also cover their subagents. A stopped turn shows a notice — rephrase and resend to continue.'),
    category: t('Claude'), liveApply: true,
  },
  'claude.tuiRenderer': {
    type: 'enum', default: '',
    options: [
      { value: '', label: t('Auto (CLI preference)') },
      { value: 'fullscreen', label: t('Fullscreen (flicker-free)') },
      { value: 'classic', label: t('Classic (main screen)') },
    ],
    label: t('Terminal TUI renderer'),
    description: t('Renderer for terminal-mode Claude sessions. "Fullscreen" forces the flicker-free alternate-screen renderer with virtualized scrollback (CLAUDE_CODE_NO_FLICKER=1, same as /tui fullscreen); "Classic" forces the main-screen renderer; "Auto" follows the preference saved by the CLI (/tui). Applies to newly started sessions.'),
    category: t('Claude'), liveApply: true,
  },

  // ── Codex ──
  'codex.defaultModel': {
    type: 'enum', default: '', combobox: true,
    options: [
      { value: '', label: t('Default') },
      { value: 'gpt-6-astra', label: 'gpt-6-astra' },
    ],
    label: t('Default model'),
    description: t('Select a known model or choose "Custom..." to type a specific model ID.'),
    category: t('Codex'), liveApply: true,
  },
  'codex.defaultPermissionMode': {
    type: 'enum', default: '',
    options: [
      { value: '', label: t('Default') },
      { value: 'read-only', label: t('Read Only') },
      { value: 'safe-yolo', label: t('Safe Yolo') },
      { value: 'yolo', label: t('Yolo') },
    ],
    label: t('Default permission mode'),
    description: t('Default Codex permission mode for new or resumed Codex sessions.'),
    category: t('Codex'), liveApply: true,
  },
  'codex.defaultEffort': {
    type: 'enum', default: '',
    options: [
      { value: '', label: t('Auto (model default)') },
      { value: 'minimal', label: t('Minimal') },
      { value: 'low', label: t('Low') },
      { value: 'medium', label: t('Medium') },
      { value: 'high', label: t('High') },
      { value: 'xhigh', label: t('XHigh') },
    ],
    label: t('Default effort level'),
    description: t('Default Codex reasoning effort for new or resumed Codex sessions.'),
    category: t('Codex'), liveApply: true,
  },
  'codex.defaultExtraArgs': {
    type: 'text', default: '',
    label: t('Default extra args'),
    description: t('Extra Codex CLI args appended when starting a Codex session.'),
    category: t('Codex'), liveApply: true,
  },

  // ── OpenCode (ACP v1 harness, S8) ──
  'opencode.defaultModel': {
    type: 'enum', default: '', combobox: true,
    options: [
      { value: '', label: t('Default') },
    ],
    label: t('Default model'),
    description: t('A model id the agent offers (provider/model, e.g. opencode/big-pickle) — the list fills from the agent once a session has started; empty keeps the agent default.'),
    category: t('OpenCode'), liveApply: true,
  },
  'opencode.defaultPermissionMode': {
    type: 'enum', default: '',
    options: [
      { value: '', label: t('Default') },
      { value: 'build', label: t('Build') },
      { value: 'plan', label: t('Plan') },
    ],
    label: t('Default permission mode'),
    description: t('Default OpenCode session mode for new sessions: build executes tools per its permission rules, plan disallows edits.'),
    category: t('OpenCode'), liveApply: true,
  },
  'opencode.defaultExtraArgs': {
    type: 'text', default: '',
    label: t('Default extra args'),
    description: t('Extra OpenCode CLI args appended when starting an OpenCode session.'),
    category: t('OpenCode'), liveApply: true,
  },

  // ── Sidebar ──
  'sidebar.defaultTab': {
    type: 'enum', default: 'folders',
    options: [
      { value: 'folders', label: t('Folders (sessions by directory)') },
      { value: 'tasks', label: t('Task Groups') },
      { value: 'mounts', label: t('Remote') },
    ],
    label: t('Default sidebar tab'),
    description: t('Which sidebar tab opens on page load'),
    category: t('Sidebar'), liveApply: false,
  },
  'tasks.autoStyleOrder': {
    type: 'enum', default: 'interleaved',
    options: [
      { value: 'interleaved', label: t('All dimensions from the start (textures early)') },
      { value: 'solid-first', label: t('Solid colors first (textures after 36 groups)') },
    ],
    label: t('Task Group auto-style order'),
    description: t('How automatic Task Group styles are sequenced. "All dimensions" cycles lightness bands AND line-style textures from the first groups (maximum visual difference — the 4th group is already dashed); "Solid first" uses 36 solid color slots before any texture (a cleaner look for small setups). Applies live; changing it re-renders existing auto styles.'),
    category: t('Sidebar'), liveApply: true,
  },
  'sidebar.defaultBoardView': {
    type: 'enum', default: 'groups',
    options: [
      { value: 'groups', label: t('Groups (board with member sessions)') },
      { value: 'tasks', label: t('Tasks (flat list, sorted by urgency)') },
    ],
    label: t('Task Groups tab: default view'),
    description: t('Which sub-view the Task Groups tab shows on page load'),
    category: t('Sidebar'), liveApply: false,
  },
  'sidebar.defaultStatusFilter': {
    type: 'multiSelect', default: ['live', 'tmux', 'external', 'stopped'],
    options: [
      { value: 'live', label: t('Live') },
      { value: 'tmux', label: 'Tmux' },
      { value: 'external', label: t('External') },
      { value: 'stopped', label: t('Stopped') },
      { value: 'archived', label: t('Archived') },
    ],
    label: t('Default status filter'),
    description: t('Which session statuses to show by default'),
    category: t('Sidebar'), liveApply: false,
  },
  'sidebar.enableStatusQuickTabs': {
    type: 'boolean', default: false, label: t('Status quick tabs'),
    description: t('Show quick-filter tabs (ALL/LIVE/STOP/...) below the search bar'),
    category: t('Sidebar'), liveApply: false,
  },

  // ── Session Card ──
  'sessionCard.clickBehavior': {
    type: 'enum', default: 'focus',
    options: [
      { value: 'focus', label: t('Focus window') },
      { value: 'expand', label: t('Expand card') },
      { value: 'flash', label: t('Flash window') },
      { value: 'goto', label: t('Go to window (switch desktop + flash)') },
    ],
    label: t('Card click behavior'),
    description: t('What happens when clicking a session card: focus/open the window, expand card details, or flash/bounce the window'),
    category: t('Session Card'), liveApply: true,
  },
  'sessionCard.findMode': {
    type: 'enum', default: 'find',
    options: [
      { value: 'find', label: t('Find (flash in place)') },
      { value: 'goto', label: t('GoTo (switch desktop + flash)') },
    ],
    label: t('Find button mode'),
    description: t('Default behavior for the Find button in session cards'),
    category: t('Session Card'), liveApply: true,
  },
  'sessionCard.clickToCopy': {
    type: 'boolean', default: false, label: t('Click detail values to copy'),
    description: t('Click on ID, Path, Time, or Tasks values to copy them to clipboard'),
    category: t('Session Card'), liveApply: true,
  },
  'sessionCard.visibleFields': {
    type: 'multiSelect', default: ['id', 'backend', 'cwd', 'started', 'status', 'groups'],
    options: [
      { value: 'id', label: t('Session ID') },
      { value: 'backend', label: t('Agent Backend / Role') },
      { value: 'cwd', label: t('Working Directory') },
      { value: 'started', label: t('Started Time') },
      { value: 'status', label: t('Status') },
      { value: 'groups', label: t('Task Groups') },
    ],
    label: t('Visible detail fields'),
    description: t('Choose which fields to show in the expanded session card'),
    category: t('Session Card'), liveApply: true,
  },
  'sessionCard.detailTruncation': {
    type: 'enum', default: 'left',
    options: [
      { value: 'left', label: t('Truncate left (show end)') },
      { value: 'right', label: t('Truncate right (show start)') },
    ],
    label: t('Detail value truncation'),
    description: t('When text overflows, truncate from the left (shows filename) or right (shows path start)'),
    category: t('Session Card'), liveApply: true,
  },
};

// Ordered category list for UI rendering
const SETTINGS_CATEGORIES = [
  t('Toolbar & Layout'),
  t('Window'),
  t('Terminal'),
  t('Chat'),
  t('Session'),
  t('Integration'),
  t('Claude'),
  t('Codex'),
  t('Sidebar'),
  t('Session Card'),
];

// ── PLUGIN-CONTRIBUTED SETTINGS (Plugin Ph4, 2.369.30 — docs/plugins.md) ──
// `contributes.settings[]` of an ENABLED plugin registers here as
// `plugin.<id>.<key>` under the category "Plugin: <label>". The Settings
// window, SettingsManager (sparse storage + settings-updated WS sync) and the
// plugin host API all read SETTINGS_SCHEMA live, so registering is the only
// step; unregister on disable removes the rows (stored values stay in the
// sparse store, harmless, and come back when the plugin is re-enabled).
// REGISTRATION FUNCTIONS ONLY — nothing outside this module mutates the
// schema object or the category list directly.
const PLUGIN_SETTING_OWNERS = new Map(); // pluginId → { category, paths[] }
export function pluginSettingPath(pluginId, key) { return `plugin.${pluginId}.${key}`; }
export function registerPluginSettings(pluginId, label, items) {
  unregisterPluginSettings(pluginId);
  const category = t('Plugin: {name}', { name: label || pluginId });
  const paths = [];
  for (const s of Array.isArray(items) ? items : []) {
    if (!s || typeof s.key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(s.key)) continue;
    const path = pluginSettingPath(pluginId, s.key);
    const entry = { label: String(s.label || s.key), description: String(s.description || ''), category, liveApply: true, plugin: pluginId };
    if (s.type === 'boolean') Object.assign(entry, { type: 'boolean', default: !!s.default });
    else if (s.type === 'number') Object.assign(entry, { type: 'number', default: Number.isFinite(Number(s.default)) ? Number(s.default) : 0, min: s.min, max: s.max, step: s.step });
    else if (s.type === 'select') Object.assign(entry, { type: 'enum', default: String(s.default ?? ''), options: (Array.isArray(s.options) ? s.options : []).map((o) => (typeof o === 'string' ? { value: o, label: o } : { value: String(o?.value ?? ''), label: String(o?.label ?? o?.value ?? '') })) });
    else Object.assign(entry, { type: 'string', default: String(s.default ?? '') });
    SETTINGS_SCHEMA[path] = entry;
    paths.push(path);
  }
  if (paths.length && !SETTINGS_CATEGORIES.includes(category)) SETTINGS_CATEGORIES.push(category);
  PLUGIN_SETTING_OWNERS.set(pluginId, { category, paths });
  return paths;
}
export function unregisterPluginSettings(pluginId) {
  const own = PLUGIN_SETTING_OWNERS.get(pluginId);
  if (!own) return false;
  for (const p of own.paths) delete SETTINGS_SCHEMA[p];
  PLUGIN_SETTING_OWNERS.delete(pluginId);
  if (![...PLUGIN_SETTING_OWNERS.values()].some((o) => o.category === own.category)) {
    const i = SETTINGS_CATEGORIES.indexOf(own.category);
    if (i >= 0) SETTINGS_CATEGORIES.splice(i, 1);
  }
  return true;
}
export function listPluginSettings(pluginId) { return [...(PLUGIN_SETTING_OWNERS.get(pluginId)?.paths || [])]; }

export { SETTINGS_SCHEMA, SETTINGS_CATEGORIES };
