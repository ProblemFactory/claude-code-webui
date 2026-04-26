# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and this project uses [Semantic Versioning](https://semver.org/).

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
