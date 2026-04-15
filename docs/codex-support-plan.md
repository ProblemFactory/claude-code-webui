# Codex Support Plan

Validated on `2026-04-14` against:

- Local `codex` CLI `0.120.0`
- Local app-server schema from `codex app-server generate-json-schema`
- Local persisted sessions under `~/.codex/sessions/`
- Official docs:
  - https://developers.openai.com/codex/app-server
  - https://developers.openai.com/codex/cli/features
  - https://developers.openai.com/codex/subagents

## Goal

Add first-class Codex support to this WebUI without regressing Claude support, and preserve the current product surface:

- Terminal mode
- Chat mode
- Resume and view-only history
- Session discovery in the sidebar
- Search and status bar
- Permission prompts
- Tasks, tool cards, command/file output
- Subagent viewers
- Review mode
- Layout sync and multi-client restore

## Key Findings

### 1. Codex chat mode must use `codex app-server`

`codex exec --json` is real and useful for smoke tests, but it is not enough for full WebUI parity.

Why:

- `codex app-server` exposes `thread/start`, `thread/resume`, `thread/read`, `thread/list`, `turn/start`, `turn/steer`, `turn/interrupt`, and `review/start`
- It streams rich notifications such as `item/started`, `item/completed`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `thread/tokenUsage/updated`, and `turn/plan/updated`
- It sends approval requests over JSON-RPC for command execution, file changes, permission grants, and tool-driven user input
- It exposes collab/subagent state through `collabAgentToolCall` items and receiver thread IDs

Conclusion: terminal mode can reuse the current PTY/dtach approach, but chat mode needs a dedicated Codex app-server wrapper.

### 2. History cannot rely on `thread/read` alone

Live app-server notifications contain full tool items such as:

- `commandExecution`
- `fileChange`
- `collabAgentToolCall`
- `enteredReviewMode`
- `exitedReviewMode`

But in real tests, `thread/read` returned completed turns that only kept user/agent display items and dropped tool details.

Codex's persisted JSONL under `~/.codex/sessions/...jsonl` does keep the richer event stream, including:

- `session_meta`
- `turn_context`
- `response_item`
- `event_msg`

Conclusion: full replay, search, and view-only mode need either:

- persisted raw app-server notifications from our wrapper, or
- a Codex JSONL parser, or
- both

The safest implementation is both: wrapper buffer for live/restart continuity, Codex JSONL parser for backfill and discovery.

### 3. Approval requests are first-class JSON-RPC server requests

Observed request types:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`

Important detail: request IDs can be numeric `0`. Any handler that checks `if (msg.id)` will silently miss valid requests and leave the turn stuck in `waitingOnApproval`.

Observed behavior:

- A shell write in read-only mode surfaced as `item/commandExecution/requestApproval`
- An `apply_patch` style write surfaced as `item/fileChange/requestApproval`
- After approval, the server emitted `serverRequest/resolved` and resumed the turn

Conclusion: the permission UI can be reused conceptually, but the backend contract must become backend-specific.

### 4. Subagents are real child threads, not sidecar JSONL files

In live tests, Codex emitted:

- `collabAgentToolCall` with `tool = spawnAgent`
- receiver thread IDs in `receiverThreadIds`
- later `collabAgentToolCall` with `tool = wait`
- child thread metadata via `thread/read`

The child thread exposed:

- `forkedFromId`
- `agentNickname`
- `agentRole`
- parent linkage in `source.subAgent.thread_spawn.parent_thread_id`

Conclusion: Codex subagent viewers should be thread-based, not Claude-style sidechain JSONL watchers.

### 5. Review mode is explicit

Official docs and schema expose `review/start`, and live review output is represented with:

- `enteredReviewMode`
- `exitedReviewMode`

Conclusion: Codex review can map naturally onto a review-specific renderer in chat mode.

### 6. Token usage and status updates are cleaner than Claude's current stream

Codex emits:

- `thread/tokenUsage/updated`
- `thread/status/changed`
- `turn/completed`

This is a better fit for the current status bar than scraping Claude result blocks.

## Recommended Architecture

### Shared session model

Stop treating `claudeSessionId` as the universal session identity.

Introduce and use:

- `backend`: `claude` or `codex`
- `backendSessionId`: Claude session ID or Codex thread ID
- `sessionKey`: `backend + ":" + backendSessionId`
- `webuiSessionId`: the existing server-side session/window attachment ID
- `sourceKind`: where the thread came from, such as `vscode`, `review`, or `subagent`
- `agentKind`: normalized agent type, such as `primary`, `review`, or `subagent`
- `agentRole`: backend-specific role label when present
- `agentNickname`: backend-specific nickname when present
- `parentThreadId`: parent thread linkage for review/subagent threads

Keep `claudeSessionId` as a compatibility field during migration only.

Longer term, frontend user-state should stop keying by raw session ID alone. The correct stable identity is:

- `sessionKey = backend + ":" + backendSessionId`

This avoids cross-backend collisions in stars, archives, custom names, and groups.

Codex discovery also needs a naming heuristic that ignores injected instruction blocks such as `AGENTS.md`, permissions, skills, and environment context. Otherwise sidebar labels degrade into system prompt fragments instead of real thread intent.

### Per-backend providers

Split the remaining Claude-specific logic into backend providers:

- session creation / attach
- live protocol wrapper
- history parsing
- session discovery
- approval request/response mapping
- subagent discovery
- status extraction

Introduce a real backend registry instead of direct backend imports inside transport code:

- `backend -> adapter`
- `backend -> runtime wrapper`
- `backend -> history parser`
- `backend -> discovery provider`

### Per-backend normalizers, shared frontend shape

Keep the existing normalized frontend message shape, but stop pretending one normalizer can parse every backend's raw protocol.

Use:

- Claude normalizer for stream-json
- Codex normalizer for app-server notifications and persisted Codex JSONL

### Two Codex runtime paths

#### Terminal mode

Use interactive `codex` in `pty-wrapper.js` under dtach, mirroring current Claude terminal mode.

#### Chat mode

Create a new wrapper that:

- spawns `codex app-server`
- performs `initialize` + `initialized`
- starts or resumes a thread
- starts turns from WebUI input
- persists raw notifications to a buffer file
- persists thread metadata and active turn state
- answers approval requests from WebUI actions

## Feature Parity Matrix

| Feature | Claude Today | Codex Source of Truth | Required Change |
| --- | --- | --- | --- |
| Terminal mode | PTY + dtach | interactive `codex` | new create/attach path |
| Chat streaming | Claude stream-json | app-server notifications | new wrapper + normalizer |
| History replay | Claude JSONL + buffer | Codex JSONL + wrapper buffer | new parser + API branch |
| View-only attach | JSONL replay | thread/read + JSONL replay | backend-aware attach |
| Session discovery | lock files + Claude JSONL | Codex thread list + `~/.codex/sessions` scan | backend-aware discovery |
| Permissions | `control_request` protocol | JSON-RPC server requests | backend-aware approval bridge |
| Task/tool cards | Claude tool_use/result | `commandExecution`, `fileChange`, tool items | Codex item renderer |
| Status bar | result scraping | `thread/tokenUsage/updated` | Codex status adapter |
| Subagents | sidechain JSONL | collab thread IDs + thread/read | thread-based subagent viewer |
| Review | none today | `review/start` + review items | new renderer/action |

## Phased Implementation

### Phase 1. Metadata and API backbone

- Make server session metadata backend-aware
- Add backend-aware history route inputs
- Keep Claude compatibility fields during migration

### Phase 2. Codex terminal mode

- Add `CODEX_CMD` resolution
- Allow terminal session creation with backend `codex`
- Support `codex resume <threadId>` for interactive terminal restore

### Phase 3. Codex chat wrapper

- Implement app-server wrapper under dtach
- Map WebSocket `chat-input`, `interrupt`, approval responses, and attach flow
- Persist raw app-server notifications to disk

### Phase 4. History, search, and discovery

- Parse `~/.codex/sessions/*.jsonl`
- Add Codex session discovery provider
- Support view-only attach, search, and turn map generation for Codex

### Phase 5. Subagents, review, and polish

- Add thread-based subagent windows for Codex
- Add review-mode rendering
- Expose token usage, thread status, and model info in the status bar

## Constraints and Suggestions

- Do not wire Codex support by branching on `if (backend === 'codex')` all over the frontend. Keep the branching concentrated server-side and in dedicated normalizers/renderers.
- Do not overload `MessageManager` with both Claude raw stream-json and Codex raw app-server events. Split the parser layer and share the normalized output only.
- Do not depend on truthy `id` checks for app-server requests. `0` is valid.
- Do not assume `thread/read` is a full-fidelity replay surface for Codex.
- Do not remove Claude-specific fields until the UI and persistence format are fully migrated.
