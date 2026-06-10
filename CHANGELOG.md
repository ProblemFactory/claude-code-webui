# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and this project uses [Semantic Versioning](https://semver.org/).

## [2.8.2] — 2026-06-09

### Added

- **Persistent goal entry point in the chat status bar**: a dim 🎯 is always shown when no goal is active — clicking it opens a set-a-goal popup (condition input + "Resume previous"). Active goals show status icon + elapsed + objective as before.
- **Codex status bar parity**: reasoning effort next to the model badge, sandbox policy in the permission tooltip, cumulative session token usage (in/cached/out/reasoning) in the context-pie tooltip, and Codex's plan tool (`update_plan`) now drives the same TODO display above the input that Claude's TodoWrite does.

### Fixed

- **Spontaneous terminal shrink + apparent disconnect mid-use**: `resizeSessionToMin` min'd over all clients while ghost/placeholder entries sat at a hardcoded 120×30 (the attach placeholder, or a subagent View-Log window registered into the parent session). Compounded by no WS heartbeat, so half-open connections lingered. Now only genuinely-fitted terminal clients drive PTY size (`real:true`), subagent viewers never participate (`viewer:true`), a 30s ping/pong heartbeat evicts ghosts, and terminals re-fit on reconnect.
- **Status bar empty until the first reply after resume/attach**: model and context window were derived only from `result.modelUsage` / system-init records, which are stream-json stdout-only and never in the JSONL. Now falls back to `assistant.message.model`, infers the context window from observed usage (>190k ⇒ 1M beta), and restores the permission mode from the session's launch args. Codex unaffected (rollout JSONL carries it natively).
- **Codex resume showed no goal for the whole first turn**: resuming a thread with an active goal auto-continues by Codex design, but the wrapper only emitted a goal event at turn end. It now emits `goal_updated` right after the startup `thread/goal/get`. Replacing an active goal (`/goal B` over A) now also saves A to `_prevGoal` for resume.
- **Codex live token% / rate limits were dead paths**: the `thread/tokenUsage/updated` notification's v2 shape (`{tokenUsage:{total,last,modelContextWindow}}`) was read with nonexistent field names, and rate limits were looked for on the wrong notification — both now parsed correctly (`account/rateLimits/updated` carries the limits).

### Changed

- **Claude `/goal` uses the CLI's native goal mechanism** (parity with Codex; superseded the wrapper simulation + 200-iteration cap from 2.8.0). The CLI's Stop hook drives continuation and met-detection; the server tails the JSONL for `goal_status` attachments (stdout-gap) to sync state. Requires CLI ~2.1.1xx (`/goal` `supportsNonInteractive`).

## [2.8.1] — 2026-06-09

### Changed

- **Claude `/goal` switched to the CLI's native goal mechanism** (parity with Codex). CLI ~2.1.1xx added `supportsNonInteractive` to `/goal`, so it now dispatches as a real command in stream-json (verified live on 2.1.170) — the wrapper forwards `/goal <text>` / `/goal clear` instead of simulating continuation. The CLI's Stop hook drives both auto-continue and **met-detection** (which the simulation never had), so the v2.8.0 200-iteration safety cap is gone — goals terminate when their condition is met, with `reason`/`iterations`/`durationMs`/`tokens` reported.
- `goal_status` attachments are JSONL-only (not emitted on stream-json stdout — same gap class as subagent messages #8262), so the server tails the session JSONL after each turn to sync goal state, broadcasts `Goal met: …` with the hook's reasoning, and writes the cleared state back to the wrapper meta so restarts don't resurrect a finished goal.

## [2.8.0] — 2026-06-09

Full-project code review release: 8 parallel review agents audited every subsystem (server, wrappers, WS/stores, routes, window manager, sidebar, chat UI, viewers, CSS), followed by five fix batches covering ~120 findings.

### Added

- **Fable 5 model tier**: `fable` / `fable[1m]` aliases in all model lists; model discovery switched to `/v1/models` with OAuth Bearer (the bootstrap endpoint's `additional_model_options` now returns null), so new full model IDs appear automatically.
- **Per-session config persistence**: model/effort/permission overrides from the gear popover are now stored in user state (`sessionConfigs`, key `backend:backendSessionId`), synced multi-client, applied by ALL resume paths (card click, resume-all, chat resume bar, layout restore), and surfaced as a purple gear badge on session cards (tooltip shows the full config).
- **Hex viewer**: auto-loads chunks on scroll; offset gutter shows real file offsets after a jump; jump scrolls to its target.
- **Accessibility**: pinch-zoom re-enabled (was `user-scalable=no`), hover-revealed controls visible on touch devices, chat minimap non-interactive on touch, `prefers-reduced-motion` support.
- **Theme system**: per-theme `--accent-fg`/`--magenta`/`--cyan`/`--hover-overlay` variables; hardcoded indigo/green/red follow the theme accent via `color-mix`; Nord/Monokai accent-background buttons now readable; Light-theme scrollbars/hovers visible.

### Fixed (highlights)

- **Claude thinking content rendered empty** — the normalizer read `block.text` but Claude sends `block.thinking`. All thinking blocks now display.
- **Sidebar lazy rendering never fired** — the IntersectionObserver was created *after* `observe()` calls registered on its disconnected predecessor; the Groups tab rendered permanently empty and off-screen folders stayed blank.
- **Codex AskUserQuestion always declined** — questionnaire answers (`toolInput.answers`) never reached the wrapper; the adapter now translates them to `responseData.{decision,answers}`.
- **XSS hardening** — `escHtml` escapes quotes (attribute-context injection); DOMPurify sanitizes all markdown rendering; file paths/error messages escaped in hex viewer, external editor, browser overlay, explorer/editor error cards.
- **Zombie sessions after attach-PTY death** — stale PTY exits no longer null a freshly re-attached PTY or tear down live subagent watchers/normalizer listeners; dead attach PTYs auto-re-attach with bounded retries.
- **Data-loss windows closed** — all persistence JSON writes are atomic (tmp+rename); SyncStores and layouts flush on shutdown; user-state migration no longer POSTs a stale localStorage cache over other devices' changes; CodeEditor/external editor surface write failures instead of reporting "Saved".
- **Window manager leaks** — per-window/per-tab document listeners released on close (previously leaked the full window DOM per close); ChatView removes its settings listeners; `_messages` no longer grows unboundedly with duplicates.
- **Concurrent create cross-wiring** — `create`/`created` correlate via reqId (group resume-all could bind a ChatView to the wrong session); tmux view windows get an openSpec so remote layout-sync stops closing them.
- **Performance** — Codex thread metadata cached by mtime with head-only reads (sidebar polls re-parsed every session file); user-state writes skip the Codex tree scan when no legacy keys exist; Codex history conversion no longer O(n²); taskbar updates in place on focus changes; streaming markdown re-renders coalesce per frame; waiting/find blink animates composited opacity instead of repainting box-shadow; `/api/sessions` gets a 2s response cache.
- **Logic** — WebUI goals re-check state before auto-continuing and cap at 200 turns (paused, resumable); CSV viewer parses quoted fields and estimates totals correctly (large files were capped at ~10k rows); upload names are confined to the destination directory; upload failures no longer record success; goal status icons show for Codex (case mismatch); AskUserQuestion multi-select can't submit empty; ~340 lines of verified dead code/CSS removed (the typo'd notification-card selector now styles correctly).

### Removed

- Dead `/api/session-groups` CRUD routes (7 endpoints, unreachable, conflicting data shape that corrupted state if invoked). Groups remain managed through `/api/user-state`.

## [2.7.0] — 2026-06-02

### Added

- **`/goal` command in chat mode (Claude + Codex)**: set a session-scoped objective the agent auto-continues toward until met.
  - **Claude**: `/goal <text>` sets the goal; wrapper auto-sends a continuation message after each `result` (turn end) so the model keeps working. CLI's own `/goal` (Stop hook) is also detected — `goal_status` attachments in stream-json sync `session._goal`. `/goal`, `/goal clear`, `/goal resume` semantics match the CLI.
  - **Codex**: uses the app-server's **native** goal loop via `thread/goal/set` RPC (objective stored in Codex's SQLite, auto-continues with developer messages). Wrapper queries `thread/goal/get` on startup and after each `turn/completed` to sync authoritative state (`objective`, `status`, `timeUsedSeconds`, `tokensUsed` — note camelCase). Resuming a thread with an active goal auto-continues by Codex design.
  - **Status bar goal indicator**: 🎯 + status icon (▶ active / ⏸ paused / ✓ complete) + elapsed time + truncated objective. Click for popup with full text, elapsed/status, Continue (when not active) and Clear buttons. Elapsed comes from protocol (`timeUsedSeconds`), not a wall clock — updates per turn.
  - Goal state persisted in wrapper meta + session, survives server restart (read in `restoreSessions`), broadcast to all clients via `goal-updated`.
- **Interactive AskUserQuestion UI**: `AskUserQuestion` tool calls (via `control_request` `tool_name === 'AskUserQuestion'`) render as a paginated questionnaire — one question per page with ← → navigation, selectable option cards, a custom-answer input per question, and a Submit enabled only when all are answered. Response uses `approved: true` + `toolInput.answers` keyed by question text.
- **Fork button on session cards**: branches a session from its history. Claude uses `--fork-session`; Codex uses the app-server's `thread/fork` RPC (confirmed to return a new thread with `forkedFromId`). Fork name auto-generated: "Name (forked)", "(forked 2)", etc.
- **Hook event rendering**: `hook_response` → collapsed "✓ Hook: name" card (expand for output); `stop_hook_summary` → "N hooks ran". `hook_started` ignored.
- **CLI command notification cards**: `<command-name>`, `<local-command-stdout>`, `<system-reminder>`, `<task-notification>`, and goal Stop-hook directives render as compact dim notification cards instead of raw XML user messages.

### Fixed

- **Session history lost after server restart**: attach only loaded JSONL when `normalizer.total === 0`, but PTY `processLive` could populate partial buffer data first, skipping the full history (e.g. 4367 messages → 63). Now uses a `_historyLoaded` flag and re-creates the normalizer from full JSONL + buffer on first attach.
- **Duplicate Codex messages from JSONL/buffer overlap**: JSONL records carry an `item_id` that buffer records lack, so `JSON.stringify(payload)` fingerprints differed and dedup failed. Now strips `item_id`/`itemId` before fingerprinting.
- **Resume opening a second window for a terminated conversation**: clicking Resume in the sidebar while a terminated (read-only) window for the same session was still open created a duplicate stuck window. `resumeSession` now closes any window whose `_openSpec.backendSessionId` matches the target before creating the resumed window.
- **File explorer Copy Path over HTTP**: `navigator.clipboard` is undefined in non-HTTPS contexts, so the optional chain silently skipped the fallback. Replaced inline code with the shared `copyText` utility.
- **Codex `apply_patch` Update cards expanded by default**: `renderPatchDiff` had `open` on the diff `<details>`. Now collapsed like other tool cards.

## [2.6.1] — 2026-05-09

### Fixed

- **Mid-stream attach showed `isStreaming: false`**: `_isStreaming` was only set from PTY output (user message echo), causing a timing gap where a second client attaching mid-stream would see the session as idle. Now set to `true` immediately when the server sends `chat-input` to the PTY, before waiting for the round-trip echo. Verified with multi-client sync test.

## [2.6.0] — 2026-05-09

### Added

- **Codex fork history merge**: Codex `thread/resume` always creates a new thread ID (fork by design). Now tracks `forkedFrom` chain on the session: when `backendSessionId` changes, the old ID is appended. `CodexSessionMessages` loads the full chain (oldest → newest) with fingerprint dedup, so resumed sessions show their complete history. Forked-from threads hidden from sidebar to avoid duplicates. Persisted in metadata, survives restarts. Supports multi-level forks (A → B → C).
- **Explicit server-side streaming state**: replaced the fragile heuristic that derived `isStreaming` from normalizer message statuses with an explicit `session._isStreaming` flag. Tracked from deterministic protocol signals: Claude (`result`/`compact_boundary`/`user`), Codex (`task_started`/`task_complete`/`turn_aborted`/`task_failed`). Initialized from wrapper metadata on restore, cleared on exit. Eliminates the race condition where `processLive` created stale streaming entries before `convertHistory` finalized them.

### Fixed

- **`/compact` leaving chat stuck on 'thinking'**: after `/compact`, stream-json emits `user` messages (compact summary) but no `result`, leaving the normalizer with stale streaming assistant messages. `MessageManager._processUser` now calls `_finalizeStreaming` on new user message arrival. Wrapper also treats `compact_boundary` system message as end-of-stream.
- **Stale streaming messages causing permanent 'responding' indicator**: `_finalizeStreaming()` broke at first non-streaming message, leaving interleaved stale ones. Now scans to `role==='user'` boundary. `_deriveTypingLabel` also stops at user messages to ignore stale turns.
- **`isStreaming` in attach response**: was `sm.isStreaming || hasStreamingMsg` — stale wrapper meta overrode normalizer's correct state. Changed to normalizer-first: prefer `hasStreamingMsg` when normalizer has messages, fall back to wrapper meta only when empty.
- **Broken pty stdin false positives**: buffer-growth check failed for opus[1m] (10-30s before first token). Wrapper now writes `_stdin_ack` to stdout immediately on stdin receipt; server checks for ack. Fallback to buffer growth for old wrappers without ack support.

## [2.5.0] — 2026-05-08

### Added

- **View-only fallback on server restart**: when a chat/terminal session's dtach process died (full server/machine restart), layout restore now opens it as view-only (JSONL history + Resume button) instead of silently dropping the window.
- **Auto-detect broken pty stdin**: after server restart, if a chat-input write produces no buffer output within 5s, the pty is re-attached automatically and the message re-sent. Uses buffer growth check (not just meta.streaming) to avoid false positives from slow API responses.

### Changed

- **Folder '+' opens dialog**: clicking '+' on a folder header now opens the New Session dialog with cwd prefilled, instead of immediately creating with defaults.
- **captureState saves cwd**: layout auto-save now persists `cwd` for both terminal and chat windows (needed for view-only fallback).
- **restoreState fetches /api/sessions**: stopped session lookup no longer depends on sidebar._allSessions being loaded (race condition fix).

### Fixed

- **Codex thinking messages lost during/after tool calls**: `_finalizeStreaming()` prematurely cleared `streamingReasoningMessages` map on every new text stream, and `_processReasoningItem()` created duplicates. Now reasoning is only finalized on turn-end events, and finalized items update existing streaming messages in-place.
- **Lazy folder rendering empty folders**: IntersectionObserver only handled `'placeholder'` state, not `'pending'` (initial state for off-screen folders). Folders below the fold never rendered their cards.
- **Broken pty stdin false positive**: previous detection only checked `meta.streaming` which races with debounced meta writes. Now checks buffer length growth as primary signal.
- **Thinking/streaming state not syncing across clients**: `isStreaming` in attach response only read wrapper meta (can lag). Now also checks normalizer messages for `status==='streaming'`. `_reattach()` now calls `_syncTypingIndicator()` after fetching missed messages.

## [2.4.0] — 2026-04-25

### Added

- **Mobile UI overhaul**: comprehensive responsive redesign tested on Pixel 10 Pro XL via ADB.
  - **Two-level sidebar navigation**: folder list (level 1) → session list (level 2) with back button. Replaces the single giant scrollable list (~1600 DOM nodes → ~20). Both Folders and Groups tabs use this pattern.
  - **Window switcher**: tap the nav bar title to see all open windows, switch or close them. Includes desktop tabs when 2+ virtual desktops exist (tap to switch desktop, list updates in-place).
  - **Close button** (✕) in nav bar to close the active window. Auto-focuses the most recently used window after closing.
  - **Image upload button** in chat input area (mobile only) — opens system file picker for images since Ctrl+V paste isn't available on mobile.
  - **Edge swipe gesture**: swipe right from left edge opens sidebar, swipe left closes it.
  - **Folder/group icons**: folder 📁 and people 👥 SVG icons on mobile navigation cards.
  - **Lazy folder rendering**: IntersectionObserver defers rendering session cards until their folder group enters viewport (desktop optimization too).
- **Effort combobox**: effort setting (both global and per-session) now has "Custom..." option for typing values like `xhigh` that the CLI may not list but models support.
- **Per-session config Custom...**: all three rows (Model, Effort, Permission) in the per-session config popover now support free-form Custom... input, not just Model.
- **Auto-detect effort levels**: server parses `--effort` options from `claude --help` and serves via `GET /api/session-options`. Frontend updates dropdowns dynamically.

### Changed

- **Mobile architecture split**: extracted `mobile-nav.js` (MobileNav class) and `sidebar-render-mobile.js` (mixin) from app.js and sidebar-render.js. Centralized `app.isMobile` flag replaces scattered `matchMedia` checks.
- **Mobile CSS**: `100dvh` for keyboard-aware layout, sticky nav bar, full-screen fixed sidebar (z-index 90000), larger touch targets (32-44px), 16px font in chat input, rounded input corners, folder path middle-truncation.
- **Mobile link handling**: tap opens directly (file viewer / new tab) instead of copying. Desktop Ctrl+click behavior unchanged.

### Fixed

- **Background tasks accumulating** (40+ stale "running" tasks in status bar): stream-json rarely emits `task_notification` for background Bash commands. Now tasks are deleted from wrapper meta on completion, and command-type tasks are cleaned up on turn end (`result` message).
- **Mobile nav bar not showing**: CSS source order issue — `#mobile-nav { display:none }` defined after `@media` block.
- **Mobile sidebar behind windows**: z-index 1000 vs window z-index 5000+.
- **Star/archive icons too small on mobile**: inline `style="width:12px"` overridden with `!important`.
- **Filter buttons not toggleable on mobile**: re-click created new popover instead of closing.
- **Groups tab empty on mobile**: wrong `_getGroupSessions` call signature.
- **Drill-down reset on session click**: `_render()` lost drill-down state. Fixed with `_mobileDrilldown` state tracking.
- **No focus transfer after closing window**: closed active window left blank screen on mobile.

## [2.3.0] — 2026-04-22

### Added

- **Per-session model/effort/permission config**: Gear button (⚙) in the Resume split button group opens a popover with Model, Effort, and Permission overrides. Each row has a checkbox — unchecked = greyed out (use global default), checked = per-session override active. Model supports "Custom..." for specific model IDs. Overrides are passed to `claude --resume --model X --effort Y --permission-mode Z`.
- **"Not logged in" detection + login helper**: When a session exits because the CLI's OAuth token expired, the chat window shows a dedicated login bar with "Open Login Terminal" (opens a terminal to run `/login`) and "Retry" buttons, instead of a blank read-only window.

### Fixed

- **Session config was inline panel taking too much space**: Changed to a compact popover anchored to a gear button.
- **Config gear icon was a sun**: Replaced with actual gear SVG.

## [2.2.1] — 2026-04-20

### Fixed

- **Resume/new session broken on older Claude CLI**: Claude Code <2.1.98 doesn't support `--name`, causing immediate exit code 1 and read-only window. Server now parses `claude --help` at startup to detect supported flags and only passes `--name` when available.
- **Startup banner showed hardcoded "v2.0"**: Now reads version from package.json dynamically.

## [2.2.0] — 2026-04-18

### Added

- **Upload redesign**: Upload button now opens a Chrome-style popover menu with "Upload Files", "Upload Folder" (webkitdirectory), upload history list (last 10, click to reopen), and "Clear History". Active uploads show with spinner + cancel in the menu.
- **Inline upload progress**: Uploading files appear as real file-list rows with a Mac Finder-style progress bar (accent fill in the size column area), percentage label, and cancel button. Survives folder navigation — rows re-render via `_renderItems`.
- **Upload button ring progress**: SVG circle ring on the upload button fills during active uploads (Chrome download-button style). Hidden when idle.
- **Upload history persistence**: Stored via SyncStore `uploads` — persisted to disk, broadcast to all clients in real-time.
- **Folder upload**: `webkitdirectory` input preserves relative paths; server creates nested directories via `mkdirSync({recursive: true})`.
- **Combobox model selector**: Model settings now show a dropdown of known aliases plus a "Custom..." option that reveals a text input for typing specific model IDs (e.g. `claude-opus-4-6-20250414`). Works for both Claude and Codex.
- **Opus and WMA audio formats** added to file type registry.
- **Path-based file serving route**: `GET /api/file/serve/*` maps URL paths to filesystem paths, enabling `<base href>` for HTML preview.

### Changed

- **OAuth token auto-refresh**: Server stores full OAuth credentials (accessToken + refreshToken + expiresAt). Expired tokens are automatically refreshed via `platform.claude.com/v1/oauth/token` using the same client_id as Claude Code. Both model discovery and rate limit polling use the async token getter.
- **Model discovery via bootstrap API**: OAuth users now fetch models from `/api/claude_cli/bootstrap` (supports OAuth, same endpoint Claude Code uses) instead of `/v1/models` (API key only). Falls back to `ANTHROPIC_API_KEY` + `/v1/models` when OAuth unavailable.
- **HTML preview uses `<base href>` + `allow-same-origin`**: Relative paths (CSS, images, fonts, JS) now resolve correctly via the path-based serve route. Live editing still works via srcdoc.
- **HTML preview re-renders on resize**: ResizeObserver triggers debounced srcdoc rewrite so JS-computed layouts recalculate at new dimensions.
- **Popover/context menu viewport clamping**: All popovers and context menus now check bounds after render and nudge back on-screen if clipped by viewport edges.

### Fixed

- **Upload progress bar not filling**: Fill element was `display:inline` (span default) — width/height had no visual effect. Fixed with `display:block`.
- **Upload popover had no background**: Missing `background/border/box-shadow` CSS.

## [2.1.0] — 2026-04-16

### Added

- **Resume button on read-only chat windows**: every read-only ChatView (view-history, terminated, exited) now shows a "Resume this session" button in place of the input area. Click resumes via `app.resumeSession()` and closes the read-only window — unifies the three read-only scenarios so users never have to go back to the sidebar just to continue chatting. Subagent viewers (`sub-*`) are excluded since they can't be resumed.
- **Tab drag-out merge**: dragging a tab out of a tabbed window can now merge into another window's tab bar or icon (including the original group), in addition to becoming standalone.
- **Shared tab-merge hit-test helper** (`_detectTabMergeTarget` on tab-group mixin): unifies window.js titleBar drag, icon drag, and tab drag-out. All three use `elementFromPoint` (not `getBoundingClientRect`) so occluded icons never match.
- **Stacked Workspaces app icon**: replaced the ⚡ emoji favicon + loading splash with a custom SVG — three layered window rectangles (representing virtual desktops) with mini tiled window thumbnails in the front pane, using the brand indigo gradient.
- **CHANGELOG.md**: this file. Past changes are best tracked via `git log` and CLAUDE.md's "Bug Fixes Applied" section.

### Changed

- **Interrupt uses delayed-fallback instead of dual-interrupt**: sending Stop now issues the `control_request` interrupt immediately and schedules SIGINT 2 seconds later. Before firing, the wrapper meta is re-read — if `streaming:false`, SIGINT is skipped. Sending a new chat message during the window also cancels the pending SIGINT. Avoids the "Stop kills the whole session" problem in newer Claude Code versions that exit on SIGINT instead of just interrupting the turn. Historical SIGINT was kept as a safety net for bugs #17466 and #3455; the delayed approach keeps the safety net without its side effects.
- **Tab drag-out follows titleBar-drag pattern for merge zones**: the detached window itself acts as the cursor-following preview in empty space (with snap highlights). Entering a tab merge zone collapses it to a small `.tab-ghost` preview (window `display:none`). Leaving restores the window. Previously the detached window stayed visible while merge target was indicated only via `.tab-drop-target` — confusing, since it wasn't clear merging would occur.
- **Icon drag auto-hides source window**: source window is set to `visibility:hidden` once drag threshold is crossed, since the ghost represents it. Restored on mouseup.
- **Detached tab window raised to front**: calling `focusWindow` right after `_detachFromChain` so the cursor-following preview is never hidden behind the original chain host or other windows.
- **Version bump**: 2.0.0 → 2.1.0 (minor: new user-visible features, all backward-compatible).

### Fixed

- **Dragging a window's icon onto itself made the window disappear**. Root cause: `getBoundingClientRect`-based hit-test matched a stacked window underneath whose iconSpan rect happened to overlap the cursor. Fixed via the new `_detectTabMergeTarget` helper (uses `elementFromPoint`, skips the dragged element).
- **Hit-test on tab bar drops never worked**: window.js queried `.tab-bar` (wrong class — actual is `.tab-bar-tabs`). Now works.
- **Tab drag-out mini preview invisible when hovering the original tabbed window**: the detached window was being hidden on merge-target hover, but it *was* the preview. Restored window + swapped to titleBar-drag pattern (hide only when a ghost takes over).

### Notes for future changelogs

- Keep entries user-visible and short. One-liners are fine.
- For internal refactors without behavior change, use a single line under "Changed" — readers can always check `git log` for commit-level detail.
- CLAUDE.md's "Bug Fixes Applied" is the authoritative long-form technical log; CHANGELOG is for release notes.
