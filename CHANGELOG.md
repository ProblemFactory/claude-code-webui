# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and this project uses [Semantic Versioning](https://semver.org/).

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
