# VibeSpace

> **HOW TO USE (tiered knowledge, 2026-08-13):** CLAUDE.md is the auto-loaded INDEX + LAWS. The detailed operating essays live in `docs/kb-*.md` and are read ON DEMAND:
> **kb-file-structure.md** (per-file essays — read BEFORE modifying a file) · **kb-design-lessons.md** (§1–§17 + review invariants; §-references resolve there) · **kb-features.md** (shipped-behavior reference) · **kb-patterns.md** (cross-cutting coding patterns) · **kb-api.md** (REST/WS reference) · **kb-bugfix-invariants.md** (incident essays) · **docs/history-archive.md** (ancient chronicle).
> **Contract: before changing a subsystem, read its kb entries; when your change alters behavior, update the kb file IN THE SAME COMMIT — the kb files ARE the operating manual, this file only indexes them.**

## Project Overview
A backend-agnostic web workspace for **coding agents** — manage many concurrent agent CLI sessions with a tiling window manager, file explorer, and code editor. Each backend (Claude Code, Codex, …) is driven through a `BackendAdapter` (`src/adapters/`); the UI, window manager, chat view, and session layer stay backend-neutral. Sessions run via native agent CLIs inside **dtach** for persistence across server restarts. (Project was "Claude Code WebUI" before the 2026-06-22 rename to VibeSpace — references to the `claude`/Claude Code CLI tool itself are unchanged.)

## How to Build and Run
```bash
# One-line install (checks deps, clones, builds):
curl -fsSL https://raw.githubusercontent.com/ProblemFactory/vibespace/master/install.sh | bash

# Or manually:
npm install
npm run build   # esbuild bundles src/client.js → public/bundle.js (~1.8MB)
node server.js  # starts on port 3456 (or PORT env var)
# ./run.sh      # supervised: build once, then respawn on exit (survives an OOM kill)

# PRODUCTION (this machine runs it this way since 2.73.0): systemd USER service
./scripts/install-service.sh        # installs+enables ~/.config/systemd/user/vibespace.service (linger on)
systemctl --user restart vibespace  # THE way to restart after a build — do NOT kill+nohup by hand
./scripts/update.sh                 # pull+install+build+restart in one step (⚙ → Update VibeSpace… runs this in a shell terminal; dtach sessions survive)
journalctl --user -u vibespace -f   # logs (no more /tmp/vibespace-server.log)
# Unit: Restart=always/RestartSec=5 (survives OOM/crash — verified via SIGKILL), OOMScoreAdjust=-500,
# StartLimitIntervalSec=0 (retries forever while the NFS workspace mounts late), **KillMode=process**
# (CRITICAL — the default control-group KillMode killed every dtach session spawned AFTER the service
# migration on each restart, while pre-migration sessions survived; real incident, one session died on
# every restart. Only the node main process may be killed on stop), and baked PATH (node dir +
# ~/.local/bin — systemd's minimal env broke every CLI spawn; real incident). The service does NOT
# build — build at deploy, then restart. dtach sessions survive restarts by design.
```

## Architecture

### ⚑ THE THREE-TIER FINAL FORM (2.319.0) — where a NEW CHANGE goes, and which test gates it

The 2026-08 campaign (docs/design-three-tier.md, R0–R6 + session-brain + closure marathon) reached its terminal shape. Before writing code, route the change:

| The change touches… | It belongs in… | Gated by (run BEFORE commit) |
|---|---|---|
| **Facts about a machine** (discovery, sysinfo, probes, usage walk, transcript parse, ctx sync, writer sweep, shell prelude) | The SHARED module (src/discovery-facts, sysinfo, machine-probes, usage-walker, transcript-service, ctx-sync, writer-sweep, remote-shell) — the daemon bundles it, one implementation runs where the facts live; ssh scripts are FALLBACK RUNGS only | The module's parity suite: test-discovery-interpret / test-sysinfo-op / test-usage-walk-parity / test-transcript-parity / test-ctx-sync / test-writer-sweep / test-remote-shell — a one-sided edit FAILS them |
| **A new device op** | src/agentd/agentd.js handler + capability in the hello-ack + client method. THREE-TOUCH RULE (2.300.0, bit twice): reply carries `op` in the client's id-keyed routing set; unsolicited pushes get their own branch BEFORE prevControl; watches re-arm on reconnect. Reply via `mux.control`, never an invented helper | A real-daemon test (test-sysinfo-op is the template); capability-gate assert (old daemons are never asked — unknown ops HANG) |
| **Live session stdout consumers** (served model, usage odometer, banners, todos…) | `claudeSideEffects` in server.js — ONE implementation fed by the parse AND the device stream through `sbSeenFirst` (parse registers, device fills gaps). Never a new inline consumer in the parse block (= src/server/stdout/claude-stream-json.js since S5; a NEW stream protocol = a new consumer module registered in src/server/stdout/index.js, never a branch in session-stdout) | test-session-brain-dark (mid parity is suffix-wise — every normalizer prefixes its own session id) |
| **Session creation/supervision** | The daemon pipe-session path (R6, `agentd.localPipeSessions`) is the FINAL form; dtach is the legacy path that dies by attrition. New spawn features go through buildRemoteExec (remote) / the r6Argv seam (local) | test-remote-shell drift guard; test-agentd-session |
| **A one-shot data migration** (reshaping stores on old→new update) | src/server/migrations.js (this instance) or the DEVICE_MIGRATIONS registry in agentd.js (devices, runs at daemon boot/self-upgrade) — BOTH through the shared runner src/migration-runner.js: ledger-keyed run-at-most-once, failed = retry next boot never block, archive-never-destroy, append-only dated ids. Pre-framework one-shots keep their own markers — do not re-register. Wire-compat residue (410s, capability gates, permanent aliases) is NOT migratable — it retires by fleet-telemetry condition, except device-local state which a DEVICE_MIGRATIONS entry can rewrite | scripts/test-migrations.mjs (11) |
| **Quota/vendor calls** | NOWHERE new. Exactly two files may construct vendor requests; the quota-refresh op (human-gated, on the login-holding machine) is the ONE device-side vendor surface. Passive capture (statusline/rate_limit_event/banners) is always preferred. **auto-cli (2.329.0, owner-approved reversal for THIS channel only): a burn-aware background loop may spawn `claude -p /usage` (official binary makes the fetch; zero vendor HTTP from us; idle accounts get a SLOW rung since 2.334.0, owner-directed: per-tick-randomized 30–60min staleness threshold — wandering, never metronomic — + failure exponential backoff; never-read accounts bootstrap through it) — decision=decideCliRefresh (PURE), refresher=usage-routes refreshViaCliPanel, wiring=server.js loop. Do NOT generalize this to raw-token polling** | test-vendor-whitelist (23) FAILS any new vendor call until deliberately allowlisted with its gates |
| **Pool/billing decisions** | src/account-pool-auto.js (pure) + the engine in server.js; per-session links (plan C) resolve via poolCurrentFor(pool, webuiId). Every blocked outcome must SPEAK with named buckets | test-pool-auto (56) + test-account-pool (31) + test-account-verdicts (45) |
| **A server cache a client also caches** | The invalidation entry point must NOTIFY (the 2.309.0 rule) — hook on the ONE entry point, never per call site | test-remote-discovery-dirty's drift guard pattern |

**ACTIVATION SWITCHES (code complete, soak-gated — flip deliberately, in order):** ① watch `sb-parity-hit/miss` in Diagnostics (step-2/3 live parity) → ② `agentd.localDiscovery` on (after `local-disc-snap-ms` looks sane on YOUR storage) → ③ `agentd.localPipeSessions` on (R6 — only after ①② soak; the design's sequencing law). Rollback = flip off; every path falls back structurally.

**ENFORCEMENT (2.323.0; PHYSICAL since 2.325-2.326): the tier rules above are a RED TEST, not prose** — scripts/test-architecture.mjs (47 asserts, runs INSIDE `npm run build` AFTER esbuild — it validates the just-built daemon bundle, and running it first broke every fresh checkout's first build) walks the real require/import graph: PURE imports nothing, SHARED never reaches up, DEVICE pulls only shared+pure, CLIENT crosses only the wire, the daemon bundle carries no orchestrator markers, **and server.js stays ≤2100 lines with ≥14 modules under src/server/ (the SIZE RATCHET)**. Cross-tier edges need an allowlist entry WITH a reason; dead allowlist entries fail the suite. Adding a module = add it to the right tier set in that file (path-based defaults cover src/lib/, src/routes/, src/server/). **拆分P1-P3 (2.325.0-2.326.0) made the separation PHYSICAL**: server.js = bootstrap + wiring stanzas only (6423→~1910 lines; 14 `create(deps)` factory modules under src/server/ — usage-pool-engine, session-stdout, boot-restore, session-brain, account-usage-routes, mounts-plugins-wiring, cli-env, dial-pairing, exit-routes, ops-routes, incident-wiring, sysinfo-wiring, goal-sync, agent-tool-generators); the ws 'create' case family lives in src/ws-create.js behind the VALIDATED `WS_CTX_CONTRACT` (missing dep = loud boot error; scripts/test-ws-contract.mjs pins destructures + call site); every live-session `_field` is registered with an owner in src/session-schema.js (scripts/test-session-schema.mjs fails anonymous new fields). Extraction discipline lives in memory `feedback_no_hacks` (verbatim `create(deps)` factories, lazy getters for late singletons, mutable `let` crosses as explicit `get*()` never a Proxy, worktree-only boot smokes — the repo dir attaches to PRODUCTION dtach sessions, #127 class); scripts/test-restore-smoke.mjs (create→SIGKILL→reboot→reconnect, worktree-isolated) is the cross-seam gate that caught the campaign's one real wiring bug. **Since 2.333.0 it also fires a 28-route GET battery at the live worktree server (any 5xx = fail): a factory function used by server.js but never EXPORTED throws only when the route RUNS — no boot log, no build-gate signal (the /api/agent-hooks 500; third lost-export incident).**

**STANDING SWEEP (the sysinfo lesson, 2.314.0): "twin-sets = 0" is not a state, it's a metric to re-measure.** A user caught a missed local/remote twin AFTER closure. When touching any "how much X" reader, grep for its sibling on the other transport first.


### Stack
- **Backend**: Node.js + Express + WebSocket (`ws`) + `node-pty` + dtach
- **Frontend**: Vanilla JS (ES modules) bundled with esbuild, xterm.js for terminals, CodeMirror 6 for editor
- **Session persistence**: dtach — claude processes run in dtach sessions, survive server restarts
- **Data persistence**: `data/layouts.json`, `data/session-meta/*.json`, `data/sockets/cw-*`

### Data Flow
```
Terminal mode:
  Browser (xterm.js) ←→ WebSocket ←→ node-pty (dtach -a) ←→ dtach socket ←→ pty-wrapper.js ←→ claude CLI
                                                                                  ↓
                                                                            buffer file (raw PTY)

Chat mode:
  Browser (ChatView) ←→ WebSocket (msg create/edit/meta) ←→ MessageManager ←→ server ←→ chat-wrapper.js ←→ claude --stream-json
                                                                   ↓
                                                          BackendAdapter (swappable)
```

## Cross-cutting laws (the always-loaded digest — full text lives in the kb files)

- **§ban-safety**: NEVER call Anthropic on a timer with a subscription token; vendor requests live in EXACTLY two files (scripts/test-vendor-whitelist.mjs enforces); passive capture is the default; the ONE owner-approved exception is auto-cli (`claude -p /usage`: burn-aware fast rung + owner-directed slow idle rung at a WANDERING 30–60min threshold, never a fixed cadence) — do NOT generalize it. Full: kb-design-lessons §9 + the routing table above.
- **Program-use billing**: sessions run interactive PTY mode — never `-p`/`--print`/Agent SDK for inference (moves usage to metered programmatic billing).
- **Public repo hygiene**: ZERO company/cluster detail, ZERO personal identifiers (users are userL/userW/userN in docs); secret-scan CI + pre-push guard.
- **Worktree-only smokes**: NEVER run server.js/boot smokes from the repo dir — repo data/ is PRODUCTION (#127 class); git worktree + own data/ + symlinked node_modules; harnesses set VIBESPACE_SKIP_AGENT_HOOKS=1.
- **Release discipline**: every change = version bump + CHANGELOG + commit + push; `git push` runs the MANDATORY release gate (`npm run ci` — build + gate suites + ONE real haiku chat turn (oat slot ~/.config/vibespace/ci-oat locally + VIBESPACE_CI_OAT repo secret in Actions — the officially documented setup-token CI channel) + headless-chrome CLIENT boot smoke + worktree server boot smoke w/ route battery, ~1.5min, tracked pre-push hook + GitHub Actions mirror; docs-only pushes skip; `VIBESPACE_SKIP_CI=1` = emergency bypass, use never). Daemon changes also `npm run build:agentd`; user self-updates — no agent-initiated restarts.
- **CS separation**: `hostId` is a PARAMETER, never a branch — one implementation against a machine handle; new facts-about-a-machine code goes in the SHARED modules with a parity suite (routing table above).
- **Multi-client**: every persistent state change broadcasts to other clients live; UI actions chained after a store write must NOT wait for the broadcast echo.
- **Cache invalidation must NOTIFY**: a server cache a client also caches → the invalidation entry point pushes the recomputed RESULT (one dirty signal = one computation).
- **i18n quick rules**: `t()` with ENGLISH-STRING-AS-KEY on human-visible chrome ONLY (never protocol values/stored strings/agent-facing text); keep `escHtml()` around `t()`; sidebar cluster imports `t as tr`; same-spelling-different-meaning ⇒ `tc(ctx,str)`; new keys need zh+ja entries (i18n-check runs in build). Full: kb-design-lessons §16.
- **UI conventions**: theme vars only (no literal colors), `--radius`/`--radius-sm`, createModalShell for dialogs, NO native prompt/alert/confirm, SVG icons only (never emoji), `data-popover` Esc protocol, no global `.hidden`. Full: kb-design-lessons §17.
- **Injection budgets**: hook additionalContext wraps into <persisted-output> at exactly 10 KiB — tools/rules first, logs byte-budgeted last, 9600B hard cap (agent-routes).
- **Spawn hygiene**: agent sessions get `agentEnv()` (sanitized env, never raw process.env); display strings (host-labeled cwds) never reach a spawn; secrets ride env/files, NEVER argv.
- **Danger constants (memorize)**: NEVER delete data/sockets/cw-* (the socket IS the session). Production restart = `systemctl --user restart vibespace` ONLY (KillMode=process is load-bearing — the default killed every dtach session). Restarting the server from inside a Claude session is safe ONLY because of the CLAUDE_CODE_* env sanitizer in server.js (never remove it — silent transcript loss). Buffer/meta sweeps are age-based; kill-path teardown runs BEFORE activeSessions delete.
- **XSS**: NEVER interpolate user/peer-controlled strings into innerHTML unescaped (they sync to ALL clients — one miss = stored XSS fleet-wide); markdown goes through DOMPurify.sanitize(marked.parse()); build image overlays via .src property, never innerHTML.
- **Atomic persistence**: every data/*.json write goes through writeJsonAtomic (tmp+rename); stores flush on SIGINT/SIGTERM — a bare writeFileSync is silent data loss on the exact crash path the product exists to survive.
- **Listener lifecycle**: window-scoped document listeners bind to `winInfo._listenerCtl.signal` (AbortController, aborted on close); per-drag listeners get a per-drag controller — never a per-render one (tears down MID-DRAG).
- **Never block the event loop**: no sync fs/exec against mountpoints, /dav-sharing processes, or discovery sweeps — child processes/workers with timeouts only (three whole-instance outages: FUSE threadpool, execFileSync sweep freeze, device-mount self-deadlock).
- **No silent failures**: a failed USER action must reach the user (toast/dialog/server-notice) — telemetry having it ≠ reported; fetchJson never throws, so callers check `r?.error`.
- **Working mode**: route every change through the three-tier table above (it names the module AND the gating test); fixes go to git only — the user self-updates; bookkeeping via vibespace-status/-task/-ask each turn.

## File Structure (index — essays in docs/kb-file-structure.md)

**Long entries are truncated here; the ⇒ marker means the full essay (invariants, incidents) is in kb-file-structure.md under that filename. READ IT before editing the file.**

```
src/plugin-manifest.js — PURE plugin manifest validator (Plugin Ph2, 2.369.24): id=<publisher>.<name>=folder, semver, engines.vibespace min, client tier, server flag, contributes windows/agentTools/routes, declared capabilities
src/server/plugin-loader.js — PLUGIN LOADER (Ph2): data/plugins/<id>/ manifests → sandboxed iframe assets at /plugins/<id>/ (opaque-origin CSP), forked server.js processes (IPC v1: route/tool/shutdown, crash backoff, parked after 5/10min), /api/plugins/<id>/x/* proxy, generated agent-tool shims data/bin/vibespace-tool-<id>-<name> → /api/agent/plugin-tool/ (bearer-validated), data/plugin-registry.json, broadcasts plugins-manifests-updated. Example: docs/examples/hello-plugin
server.js — BOOTSTRAP + WIRING ONLY (~1910 lines since the 2.325.0 拆分; the arch suite RATCHETS it ≤2100). ⇒ kb-file-structure.md
src/ws-create.js       — the ws 'create' case family (1633 lines, 拆分P2): new/resume/fork + local/ssh/dial/daemon-pipe spawn + account resolution + breakers + writer sweep + adoption; body wrapped `do{}while(0)` so case-level `break;` semantics survived the move. Deps arrive via the VALIDATED WS_CTX_CONTRACT (ws-handler.js) — missing key = loud boot error; scripts/test-ws-contract.mjs pins contract⇄destructures⇄server.js call site.
src/session-schema.js  — PURE registry of all ~47 live-session `_fields` (owner module + persistence home + note, 拆分P3); scripts/test-session-schema.mjs fails any unregistered new field write and any dead row. New session state ⇒ add the row FIRST.
editor-helper.sh       — Ctrl+G editor helper (overwritten by server on startup)
data/bin/editor/code — Fake "code" script for Ctrl+G (generated by server; moved OUT of data/bin in 2.267.0 — data/bin is PATH-prepended into every local session and the fake `code` shadowed real VS Code there; EDITOR= stay… ⇒ kb-file-structure.md
data/bin/pty-wrapper.js — PTY wrapper for terminal mode (runs inside dtach, survives server restarts)
data/bin/vibespace-hook.mjs — Dual-harness hook (SessionStart→task context OR a baseline tools intro for no-task sessions, UserPromptSubmit→first-prompt context + status-override notices + per-turn micro-reminder, Stop→bookkeeping… ⇒ kb-file-structure.md
data/bin/vibespace-task — Agent task-reporting CLI (STATIC tracked file, not generated — inline template-in-template escaping was unmaintainable): show [--full]/progress "summary" [--detail]/backlog/backlog-add/backlog-done/backlog-drop → /api/agent/task* (scoped to the session's own context task). ⇒ kb-file-structure.md
data/bin/vibespace-ask — Agent CLI for the GLOBAL USER-TODO inbox (2.65.0, STATIC tracked): files items the USER must act on (decision/input/review) → POST /api/agent/user-todo (vsst_ scoped to own session). ⇒ kb-file-structure.md
data/bin/vibespace-status — Agent status tool (GENERATED at startup like data/bin/code — NEVER git-track it: tracking it dirtied the tree every boot and blocked `git pull --ff-only` in self-update (real incident 2.111.26); gitig… ⇒ kb-file-structure.md
data/bin/vibespace-job — Background Work agent CLI (STATIC tracked, 2.342.0): run/--keep-up/--every/--cron/--at/poll(--wait cap 100s)/logs/stop/start/rm/access/progress/ask/answers; auth vsst_ session token OR jbt_ job token (job may act on itself only). In AGENT_TOOLS (ships to remote hosts).
data/bin/job-wrapper.js — Background Work detached wrapper (STATIC tracked): first act = atomic pid.json stamp {pid,starttime,bootId,argvHash}; tees child stdout→current.log (50MB rotate, never unlink live fd); exit.json on child exit; answers.jsonl→stdin tail when stdinOpen.
data/bin/vibespace-msg — agent互聊CLI (Channels v1, 2.362.0, STATIC tracked, in AGENT_TOOLS): list/send by 名称或conversation id; 组ACL服务器端执行; idle接收方=计费turn(工具明教); 手册vibespace-docs msg
data/bin/vibespace-page — 页面发布+design kit CLI(2.366.0, STATIC tracked, in AGENT_TOOLS): publish <file.html> --title [--public](上传快照→/p/<id>分享链接, 同路径同URL) · kit(准备/镜像design工具包并打印base directory) · list; vsst_或jbt_. 手册vibespace-docs pages
data/bin/vibespace-docs — full-manual reader for every agent CLI (2.351.0, STATIC tracked, in AGENT_TOOLS): `vibespace-docs [status|ask|task|jobs|msg|pages]`, no topic = global index; fetches GET /api/agent/docs/:topic (vsst_ or jbt_) which serves docs/agent/*-manual.md from the running server's checkout — manuals never drift from the running version; budgeted context teaching carries one pointer line per surface.
data/bin/vibespace-channel.js — EXPERIMENTAL Claude Code channel server (2.344.0, STATIC tracked, dependency-free hand-rolled MCP stdio): declares claude/channel capability; VibeSpace pushes {content,meta} lines to its per-session unix socket (VIBESPACE_CHANNEL_SOCK, data/channel-socks/<webuiId>.sock) → notifications/claude/channel → <channel source="vibespace"> events in the session. Spawned by the CLI itself when agents.vibespaceChannel is ON (per-spawn --mcp-config + --dangerously-load-development-channels server:vibespace — research preview keeps custom channels on the dev flag). Foundation for external chat bridges; NOT the primary notify lane.
data/bin/vibespace-usage — PASSIVE usage capture (STATIC tracked file, not generated; 2.60.0). ⇒ kb-file-structure.md
data/bin/chat-wrapper.js — Chat wrapper for stream-json mode (runs inside dtach, parses JSON lines)
data/bin/codex-chat-wrapper.js — Codex chat wrapper (JSON-RPC protocol, thread management)
data/bin/vibespace-usage-scan — REMOTE-side usage ledger scanner (2.127.0, STATIC tracked; PARITY-GUARDED since 2.275.0: it is a shipped SINGLE FILE (a host has no checkout ⇒ it cannot require the local walker), so it silently lagged its twin twice — the 2.265.0 subagents/workflows walk took 6 weeks to reach it. ⇒ kb-file-structure.md
data/bin/vibespace-remote-keeper — REMOTE-side persistence for remote CHAT sessions (2.124.0, STATIC tracked; distributed to remote ~/.vibespace/bin with the other tools): claude runs setsid-DETACHED on the host under a keeper daemon (… ⇒ kb-file-structure.md
data/sockets/cw-*      — dtach socket files (session anchors)
data/session-buffers/  — Per-session output buffer files (written by pty-wrapper)
data/session-meta/     — Per-session metadata JSON
data/layouts.json      — Persisted layouts and autosave state
data/drafts.json       — Chat input drafts (SyncStore, versioned, multi-client synced)
data/settings-sync.json — Settings SyncStore (future migration target)
src/
  transcript-service.js — ONE interface over the transcript parse stack (R3 of docs/design-three-tier.md; 2.283.0 step 1 = server-hosted, HTTP read family rerouted through it). ⇒ kb-file-structure.md
  client.js            — Entry point (2 lines): imports App and initializes
  ws-handler.js        — WebSocket protocol handler (all WS message cases, extracted from server.js; `default:` since Plugin Ph1 = rate-limited log + telemetry 'ws-unknown-type' + `{type:'error', code:'unknown-type'}` reply WITHOUT sessionId — a session-scoped error flips live windows read-only). ⇒ kb-file-structure.md
  sync-store.js        — SyncStore class (versioned state sync with diff broadcast)
  session-store.js — SessionMessages + JSONL parsing + session discovery helpers. ⇒ kb-file-structure.md
  message-manager.js — MessageManager (Claude stream-json → normalized messages with stable IDs; 2.368.30 parseBackgroundLaunch=后台启动ack→taskInfo合成, task_*系统subtype只在活流上存在, 落盘的ack+<task-notification>才是历史可用的生命周期真源, session-store taskState扫描共用同一解析器). ⇒ kb-file-structure.md
  codex-message-manager.js — CodexMessageManager (Codex JSON-RPC → normalized messages)
  codex-session-store.js — Codex session discovery (thread listing, JSONL parsing, forkedFrom chain merge)
  codex-thread-read.js — codex 0.153 `thread/read` fallback for a thread with NO rollout file (paginated history store): pure Thread→records mapper + ONE bounded app-server read behind the descriptor's `store.warmTranscript` hook; local only, cached, never a session (B-21e4). ⇒ kb-file-structure.md
  normalizers.js       — createMessageManager(backend, id) factory for backend-agnostic normalization
  mounts.js — MountManager (rclone mounts, MULTI-SOURCE: typed records s3/drive/onedrive/gmail/webdav/sftp/vibespace/rclone via _rcloneFor; detached + boot adoption; one-click rclone install (data/bin, pinned 1.65.… ⇒ kb-file-structure.md
  gmail-sync.js — GmailSync (2.134.0, backlog B-64db): Gmail-as-a-folder — a 'gmail' mount = local dir of .eml files synced READ-ONLY from the Gmail API (GYB-style; NOT FUSE). ⇒ kb-file-structure.md
  transcript-worker.js — heavy JSONL transcript work OFF the main thread (2.235.0, the userL degradation follow-up): a persistent SafeFs-hosted worker pool (SafeFs gained opts.workerPath/inlineRun generalization + in-flight r… ⇒ kb-file-structure.md
  agentd/ — CS refactor (B-5052) machine agent — ALL milestones' protocol+device side COMPLETE and acceptance-tested (2.140.0–2.146.0; docs/design-remote-cs.md + M0 addendum + milestone record). ⇒ kb-file-structure.md
  machine-mounts.js — MachineMounts (B-f3e8 2.160.0 — HostMounts 2.147.0 + DeviceMounts 2.153.0 collapsed into ONE manager; records carry dir:'push'|'pull', keyed by hostId, store data/machine-mounts.json, both legacy stor… ⇒ kb-file-structure.md
  exit-proxy.js — ExitProxyManager (task #164, 2.186.0): ON-DEMAND egress — an agent borrows a paired machine's network for a SINGLE command (a region / internal-VPN / fixed source IP), NOT the whole session. ⇒ kb-file-structure.md
  port-forward.js — PortForwardManager (B-0b60 tunnel path, 2.165.0): vscode-style port forwarding over the agentd data plane — NO frps/public exposure. ⇒ kb-file-structure.md
  plugins.js — PluginManager (2.140.0, B-2d44): generic host-capability plugins — install + PERSISTENT state (~/.vibespace/plugins/<id>/, home=PVC in fleet) + boot replay (enabled+desiredUp → restart with server) + guided setup + status. ⇒ kb-file-structure.md
  accounts.js — AccountManager (per-session billing-identity switching, backend-scoped via a `backend` field on each account — legacy records = 'claude'. ⇒ kb-file-structure.md
  (LONG-LIVED TOKENS oat, B-211a 2.253.0 — `claude setup-token` integration: env channel, expiry honesty, ambient strip, review-hardened invariant list) ⇒ kb-file-structure.md (under accounts.js)
  account-pool-auto.js — Pooled pseudo-account (B-6217, 2.251.0-2.252.0): account type 'pooled' — ONE switchable billing identity over the logged-in Claude subscriptions. ⇒ kb-file-structure.md
  rate-limit-capture.js — PASSIVE quota capture from the CLI's own `rate_limit_event` stream-json records (B-e5c9, 2.289.0; discovered by 2.1.226 binary forensics — a first-class stdout record "emitted when rate limit info changes" VibeSpace dropped as unknown forever). ⇒ kb-file-structure.md
  usage-anchors.js — Quota dead-reckoning DATA FOUNDATION (2.261.0, user-designed 惯性导航 step 1): every ground-truth usage reading (statusline/⟳/get_usage/limit-banner — any usage-cache write) becomes an ANCHOR paired with … ⇒ kb-file-structure.md
  usage-estimator.js — Quota dead-reckoning ESTIMATOR (B-fcff v2, 2.263.0): est_u = anchor_u + learned_rate × ledger_cost_since_anchor, per identity per bucket. ⇒ kb-file-structure.md
  usage-walker.js — THE ledger walk, ONE module (2.297.0 twin-killer): UsageHistory.scan() consumes it IN-PROCESS (cursors injected, onEvent enrichment orchestrator-side), the daemon runs it as the usage-scan op child, and data/bin/vibespace-usage-scan mirrors it for checkout-less ssh hosts (parity-pinned). ⇒ kb-file-structure.md
  conversation-index.js — Conversation-location index (2.297.0, R3 tail): data/conversation-index.json records which machine owns each conversation from BOTH discovery listings and transcript fetches — resume host-inference lo… ⇒ kb-file-structure.md
  account-material.js  — Device-tier credential-MATERIAL mechanics (2.298.0, data/subs formalized as device #0's account store): repointPoolSymlink (the 2.251.0 hot-swap primitive verbatim) shared by accounts.setPoolTarget AND the daemon's sealed-orders reflex (bundled). Decisions stay orchestrator-side; material acts are one implementation per machine.
  backend-caps.js — PURE per-backend switching-capability registry (P4切片1, 2.368.21): {pool, hotSwitch: verified|impossible|unverified, planC, sealedOrders, resetCredit, quotaProbe} — 池引擎按能力门控, hotSwitch是实验判定(claude=verified法证三事实; codex=impossible: CODEX_HOME启动canonicalize+token驻内存, 2026-08-24实验); 新backend加一行不加if链; 2.368.26增peerDelivery('cli-inbox'|'rpc-queue'|'stash-only')=互聊活投递通道
  msg-acl.js — PURE reach ACL for agent messaging (Channels v1, 2.362.0): 组内互通 / 组externalVisibility / 会话override只放宽 / 多组并集 / 无组singleton. ⇒ kb-file-structure.md
  harnesses/ — THE harness registry (design-harness-plugins §2.2; S4 first slice): index.js `get(id)` LOUD on unknown/empty (core never falls through to claude), `register()` for contributed harnesses; claude.js/codex.js/shell.js descriptors carry `quota` = QuotaSignalSource {normalize, signalFromStream, probe, classifyAuthFailure} (claude-quota.js / codex-quota.js — the former usage-routes normalizers moved verbatim; null-quota.js for shell/unknown). Engine `probeQuotaForKey` dispatches the quota probe on the identity's harness rung ('cli-usage' claude panel / 'rpc-rate-limits' live codex app-server / null) — never a claude spawn for a codex identity. ⇒ kb-file-structure.md
  server/auto-resume.js — 撞限后自动续跑(2.368.0): CLI那套只在TUI(stream-json没有/rate-limit-options), 这是我们自己的且**跨重启存活**(CLI自己重启即取消); 顺序=先让account pool换号(秒级)换不动才arm; 三态门(会话值>claude.autoResumeOnLimit默认关), 不早发/不重复/不在streaming时发/恢复即解除, 续跑用CLI原话; 2.368.27-32 armBestReset: 身份内取**死桶max**(owner抓提前fire: 7d重置≠5h对齐, 健康桶的更早重置不是候选)、跨身份(自己+池兄弟)取min; 热切落到armed会话即fireNow立即续跑, 定时fire先beforeFire跑池评估; limit-banner路径也(re-)arm; 误报处理(2.368.34, .33的已恢复预检吃掉真撞墙已删——link≠活CLI实际所在org): arm无条件+公告延迟90s(窗口内disarm即静默)+noteWorked(>30s持续产出才disarm); banner自带'resets 12:40pm (TZ)'解析为精确arm时刻; 超26h拒绝会在会话内出声(1/h). 同版还有输出风格(Concise等)=spawn时经唯一的--settings设, stream-json不能中途切. ⇒ kb-file-structure.md
  server/instance-url.js — 本实例公开地址(2.367.0; 2.367.3 客户端唯一join=utils.absUrl, 地址经/api/home+instance-url广播下发, 严禁再用location.origin拼): 唯一解析者(显式frp映射 > agentd.publicUrl > env > 空)且**映射只是叠加层, 绝不写入设置**(取消映射即回落原值) + 'vibespace-instance' frp代理的唯一发布者(远程agent安装曾在背后发同名代理); 显式映射盖过设置, 安装副作用产生的auto映射只记录不改地址; auth关闭时拒绝发布. UI=Ports面板'This VibeSpace'行. ⇒ kb-file-structure.md
  server/design-kit.js — /design画布工具包(2.366.0): 从已安装CLI提取helper+payload(CLI自解压目录优先, 否则二进制流式扫描)+技能文本, 写data/design-kit/<ver>/ 并把第4步改写成vibespace-page publish(全有或全无, 缺锚点=明确不可用), 每次用helper自己--check验证; 状态栏design芯片→可见的design request→agent走kit→发布到本实例. ⇒ kb-file-structure.md
  server/published-pages.js — 发布页(2.364.0 接管artifact; 2.366.0 publishContent上传+srcKey=host:path+会话归属+onPublished唯一通知点; 2.366.1 shell/raw分离+compat prelude(randomUUID secure-context坑)+URL只由发问方Host或publicUrl决定): /p/<id>自托管可分享HTML, 默认私有+public锁, srcPath upsert稳定URL, CSP sandbox=同源XSS防线(勿加allow-same-origin). ⇒ kb-file-structure.md
  server/wrapper-files.js — chat-wrapper文件解析(2.339.2 resolveWrapperFiles: 碰撞会话经/proc argv定位真sidecar) + wrapperCaps(2.364.1: 能力=wrapper SIDECAR data/session-buffers/<id>.json的caps, 唯一读者, 无状态; 严禁从data/session-meta读caps). ⇒ kb-file-structure.md
  server/conversation-deliver.js — THE conversation delivery ladder (2.362.0): channel socket→local inbox→owning machine's agentd peer-post op→durable stash drained at injection; jobs通知与agent消息同一实现; 2.363.0投递点即渲染peer卡片(emitPeerCard→normalizer.injectPeerCard — server-posted在CLI侧是body-less origin, 只有poster能渲染); 2.368.26 rung1.5=capsOf(backend).peerDelivery=='rpc-queue'经wrapper stdin帧活投递codex(idle=turn/start计费turn, busy=thread/queue/add, wrapper自录user消息故此路不发卡片; ok:false重新入stash). ⇒ kb-file-structure.md
  server/stdout/ — HARNESS STDOUT consumer registry (S5): index.js maps the descriptor's caps.streamProtocol → ONE consumer module (claude-stream-json.js / codex-events.js / acp-events.js = the former setupSessionPty inline branches, moved verbatim; each = create(deps) → {protocol, attach(session,id,pty,helpers)}); session-stdout only looks up + attaches; unknown/missing protocol = loud console.error + telemetry + RAW passthrough (never stream-json); consumers stay ORCH (engine/hosts/ledger deps) so the descriptor carries NO protocol twin. Gates: test-stdout-registry + test-harness-contract. ⇒ kb-file-structure.md (HARNESS STDOUT)
  job-model.js — PURE Background Work model (2.342.0): schedule math (cron parse/next-fire/jitter/15min agent floor), permission predicates (conversation-lineage owner + view/control scopes, NO existence oracle), vendor-pattern vet, digest/update renderers (600B budget, never trips the 10240 wrap), panel schema validation. Gated by scripts/test-job-model.mjs (36).
  jobs.js — JobManager engine (2.342.0, docs/design-background-work.md): registry data/jobs.json + detached-wrapper spawns (identity pid+starttime+bootId, adopt-first boot, verified handle-kills, single-engine lock, park-after-6 crash loops, until-output cursor scan, cron ticks, GC-never-on-live, secret literal-redaction). Per-machine only (cross-machine parked by owner). 2.344.0: owner auto-notify (_notifyOwner at terminal/park/missed/ask/answered; toggles job>group>global default ON; 30s rate floor; stash data/job-notifications.json drained at resume injection; notifyPreview honesty). Gated by scripts/test-jobs-engine.mjs (27, real spawns).
  peer-messaging.js — THE delivery primitive for jobs→conversation notifications (2.344.0, B-0bf4): scans the CLI's own session registry (~/.claude/sessions/<pid>.json + published <pid>.<sha>.key) and posts the documented two-frame injection (auth + stream-json user message) onto the session's cross-session-messaging inbox socket — the CLI queues mid-turn / opens a billed turn when idle / applies its own inbound controls (never bypassed; automation red line intact: we never write session stdin). Also postChannelEvent (experimental vibespace-channel lane). Local machine only; every failure returns {ok:false,reason} so the engine stashes. Gated by scripts/test-peer-messaging.mjs (10, real unix-socket inbox).
  otel-truth.js — PURE OTLP-logs parser (2.361.0, B-345b): the CLI's OpenTelemetry api_request events are the ONLY per-request channel that NAMES the billing org (transcript/statusline/rate_limit_event carry values, never identity). ⇒ kb-file-structure.md
  server/otel-ingest.js — loopback OTLP TRUTH receiver (2.361.0): local claude sessions push their own api_request telemetry here (zero vendor calls); observed org overrides link-intent attribution at ledger bake time + corrective attribution records + append-only stash. ⇒ kb-file-structure.md
  usage-history.js — UsageHistory (2.61.0, codex 2.63.0): PERMANENT per-request token LEDGER for the Usage window. ⇒ kb-file-structure.md
  session-status.js    — SessionStatusManager (session-level state/urgency set by the AGENT via vibespace-status CLI or by the user; user overrides of agent-set values record a pendingNotice injected as <system-reminder> into the NEXT chat-input; data/session-status.json — memory + session-status-updated broadcast are IMMEDIATE, disk write is DEBOUNCED 500ms + content-compared + flushed on exit (2.38.0), single-process so no race; independent of any task/context folder)
  user-todos.js — UserTodoManager (2.65.0, the GLOBAL user-facing TODO list / "For you" inbox): discrete items an AGENT filed that need the USER (decision/input/review) — the inverse of the agent's own TodoWrite. ⇒ kb-file-structure.md
  task-groups.js — TaskGroupManager (岗位/Task-Group store; renamed from tasks.js in 2.39.0 — data/task-groups.json authoritative, migrated once from legacy data/tasks.json; ⊃ legacy groups, CRUD + bind/unbind + progress,… ⇒ kb-file-structure.md
  webdav.js            — MountTokens (scoped bearer mount tokens, sha256-hashed, per-token chroot root + ro/rw) + registerWebdav (/dav WebDAV subset for VibeSpace↔VibeSpace mounting; auth = Bearer vsmt_ token, bypasses cookie auth, registered before json body parser)
  vnc.js — VncManager (2.104.0, in-container desktop): LAZY lifecycle — POST /api/vnc/start spawns Xtigervnc (-localhost -SecurityTypes None, safe: the cookie-authed /api/vnc WS bridge is the ONLY route in) + XF… ⇒ kb-file-structure.md
  ssh-key-format.js — Private-key FORMAT classifier, PURE + shared server/browser (CJS pulled into the bundle like task-color-seq.js). ⇒ kb-file-structure.md
  ssh-key.js — Server-side private-key UNLOCK at import (2.246.0). ⇒ kb-file-structure.md
  ctx-sync.js — THE ctx-folder sync, ONE implementation for every machine (2.277.0). The old split — ssh=bidirectional rsync NO caps, dial=hashed sync with a SILENT ≤400-files/≤2MB cap — meant a 3MB context file reached every ssh host and never reached a dial device, invisibly. ⇒ kb-file-structure.md
  discovery-facts.js — Shared discovery INTERPRETATION (2.278.0) — deliberately tiny so the esbuild agentd bundle carries it (unlike the ssh one-file scanner, the daemon CAN share code). ⇒ kb-file-structure.md
  writer-sweep.js — THE pre-resume writer sweep, ONE implementation for every machine (CS separation, 2.276.0). The invariant: before resuming, no OTHER process may still be writing that conversation's transcript (two writers on one JSONL = the B-4058 corruption class). ⇒ kb-file-structure.md
  remote-shell.js — ALSO buildRemoteExec (2.279.0): the five remote spawn command builders (ssh terminal/ssh keeper chat/ssh agentd pipe/dial pty/dial pipe) are ONE composition — `cd → pre → resolve → AMBIENT_OAT_UNS…` ⇒ kb-file-structure.md
  **CS SEPARATION RULE (2.276.0): `hostId` is a PARAMETER, never a branch.** Server-side logic is written ONCE against a machine handle; the only difference between this machine, an ssh host and a dialed-in device is the transport underneath it. `hosts.device(falsy)` returns device #0 (the local daemon has been a full DeviceManager since 2.158.0 — same binary/mux/op surface — but was unreachable through the API, so every feature was written twice BY CONSTRUCTION). Migration table: docs/design-cs-unification.md — the metric is PARALLEL IMPLEMENTATIONS (9 twin-sets → 0 unjustified as of 2.279.1), not branch count (branches that select a transport for ONE shared implementation are fine). Live keystone proof: scripts/test-local-device.mjs (real daemon; absence THROWS). Documented exceptions require a table row + a drift/parity guard: the shipped single-file usage scanner (checkout-less host) and local file ops (SafeFs FUSE-hang isolation is load-bearing; the daemon carries live session pipes — revisit only with daemon-side worker isolation).
  hosts.js — HostManager (ssh host registry, connectivity test, keygen, remote discovery + first-user-message names, bootstrap, backend-status, dir-complete, fetchSessionJsonl = remote transcript → data/remote-jso… ⇒ kb-file-structure.md
  remote-fs.js         — RemoteFs (ssh-per-op remote filesystem: list/read/write/mkdir/rename/rm/stat/copy/move/download/archive/tar-stream folder transfer — mirrors /api/file* shapes; files.js dispatches on ?host=, cross-host copy = server relay)
  auth.js              — Optional password auth (scrypt, server-side cookie tokens in data/auth.json, per-IP rate limit; VIBESPACE_PASSWORD / VIBESPACE_GENERATE_PASSWORD=1). 2.103.0: optional Clerk SSO rides on top — `passwordEnabled` vs `enabled` split (Clerk alone enables auth), POST /api/clerk-login verifies the Clerk session JWT vs JWKS and issues the SAME cookie token; loginHtml() renders password and/or SSO per config
  clerk-auth.js — ClerkAuth (2.103.0, env-gated: VIBESPACE_CLERK_PUBLISHABLE_KEY = on-switch, frontend-API host + JWKS URL DERIVED from the key's base64 payload; VIBESPACE_CLERK_ALLOWED_EMAILS comma list, @domain = whole domain, EMPTY = reject all). ⇒ kb-file-structure.md
  agent-routes.js — setupAgentRoutes() (2.93.0 split): every agent-facing endpoint — vibespace-ask/status/task routes, task-context/prompt-context injection (incl. ⇒ kb-file-structure.md
  usage-routes.js — setupUsage() (2.92.0 split): the ENTIRE usage/rate-limit cluster from server.js — passive statusline ingest, read-only OAuth token, opt-in active poll, on-demand quota refresh, codex rollout-tail summarizer (§ban-safety rules apply — see kb-design-lessons §9). ⇒ kb-file-structure.md
  opslog.js — Optional persistent ops log (2.115.0, env-gated no-op): VIBESPACE_OPSLOG_DIR → console tee into daily-rotated files + boot/exit/crash markers (VIBESPACE_OPSLOG_CEPHFS_* = server kernel-mounts the path-scoped subtree first, same mechanism as My storage). ⇒ kb-file-structure.md
  incident.js — FREEZE THE SCENE for a panic-button capture (2.239.0, the admin's correction: users troubleshoot their own problems — ssh/resume/kill — and destroy the evidence before anyone looks). ⇒ kb-file-structure.md
  routes/persistence.js — …also LAYOUT ROLLBACK POINTS (2.296.0, after a bug flattened a user's whole desktop layout): `writeLayouts` is the ONE choke point every layout write passes through, so it snapshots the PREVIOUS s… ⇒ kb-file-structure.md
  lib/incident-recorder.js — "Report a problem" panic button (2.238.0, the timezone-gap fix): ALWAYS-ON client ring buffers (clicks/coarse keys — typed TEXT never recorded, only a per-burst marker; ws message TYPES both direction… ⇒ kb-file-structure.md
  telemetry.js — Telemetry (2.84.0, local-first observability): monthly ndjson shards data/telemetry/events-YYYY-MM.ndjson of {ts,kind:error|event|boot|server-error|metric,name,detail,stack,version,ua,value}; summary(… ⇒ kb-file-structure.md
  adapters/
    base.js            — BackendAdapter + SessionHandle (abstract interface for AI backends)
    claude-code.js     — ClaudeCodeAdapter (Claude Code CLI: flags, JSONL, control protocol, format methods)
    codex.js           — CodexAdapter (Codex CLI: app-server mode, JSON-RPC, permission mapping)
    shell.js           — ShellAdapter (plain login-shell terminals — no AI; toolbar Terminal button, "Open Terminal Here")
    index.js           — createAdapterRegistry() factory
  routes/
    files.js           — File system API routes (browse, read, write, upload, download, clipboard paste, CSV streaming, format)
    persistence.js     — Persistence routes (layouts, bookmarks, themes, settings, user state, groups)
    sessions.js        — Session API routes (discovery, messages, subagents, kill)
  lib/
    app.js             — App controller / mediator (~2000 lines; 2.82.0 split three prototype-mixin clusters out — installed at module tail, BEFORE client.js instantiates App)
    manage-agents.js — installManageAgents(App): Manage-Agents dialog + Anthropic/ChatGPT account rosters/wizard (~790 lines, split from app.js). ⇒ kb-file-structure.md
    usage-meter.js     — installUsageMeter(App): taskbar quota pies + usage popup + on-demand refresh (~370 lines, split from app.js)
    session-lifecycle.js — installSessionLifecycle(App): create/attach/resume/fork/view/kill + billing switcher + replayOpenSpec (~680 lines, split from app.js) RESUME PRESERVES THE HOME DESKTOP (2.295.0, a fleet user, inc-ms… ⇒ kb-file-structure.md
    themes.js          — THEMES constant + ThemeManager class. **extractThemeValues probes inside a data-theme="dark" WRAPPER (B-b2d6, 2.268.9): custom properties inherit and only dark defines every var — a bare probe read live-preview inline overrides (and an applied custom theme's stylesheet values) back as a partially-defined theme's "defaults", and Save froze them into new themes. Never regress to a single-layer probe.**
    ws.js              — WsManager (WebSocket with reconnect)
    window.js          — WindowManager (drag/resize/snap/grid)
    plugin-client.js   — PLUGIN CLIENT (Ph2): fetches /api/plugins/manifests, registers every enabled iframe plugin's windows as window types (sandboxed iframe + postMessage bridge ready/init/storage/notify/close), ⚙ menu rows; trusted-module host API incl. Ph1 `api.registerCommand/registerMenuItem/registerKeybinding/runCommand` (ids `plugin:<id>:<slug>`, all bound to the plugin's signal)
    window-types.js    — WINDOW-TYPE REGISTRY (Plugin Ph1, 2.369.19): registerWindowType({type, icon, replay}) — replayOpenSpec dispatches through it, unknown action = loud warn + telemetry 'openspec-unknown'; TYPE_ICONS is a view; core registers its 14 kinds where they live (scripts/test-window-types.mjs pins the sets)
    contributions.js   — COMMANDS + MENUS (when/group/order) + KEYBINDINGS REGISTRY (Plugin Ph1): registerCommand/registerMenuItem/menuItems(menu, ctx)/registerKeybinding + ONE document dispatcher/runCommand; DOM-free at import; explicit separators; loud unknowns (throw / warn-once + telemetry). Core menus 'session-card' (session-card.js), 'window' (taskbar.js), 'gear' (gear-menu.js) are registrations, byte-identical to the former literals; core key chords stay in their own dispatchers as commands. ⇒ kb-file-structure.md
    gear-menu.js       — ⚙ gear menu rows as 'gear' contributions (groups 0_prefs/1_admin/2_maint/2p_plugins/3_help, decorate() for Language + Update rows) + buildGearMenu(app, pop) renderer (split from app.js; mobile shares it)
    tab-group.js       — Tab grouping mixin (chain model, icon drag, tab bar, drag-out)
    terminal.js        — TerminalSession (xterm.js wrapper, per-terminal settings)
    sidebar.js         — Sidebar shell (filter/sort/merge pipeline, tab switching, ~870 lines)
    sidebar-workbench.js — Folders-tab three-zone rendering (installSidebarWorkbench mixin, ~540 lines)
    sidebar-mounts.js — Remote tab: machines (ssh hosts) + storage (mounts) rendering (installSidebarMounts mixin, ~1000 lines; 2.152.0: "Pair a device" action + _showDevicePairDialog — dial-out device pairing, mints via POS… ⇒ kb-file-structure.md
    sidebar-rail.js — Sidebar activity rail (2.176.0, vscode-style, setting `sidebar.activityRail` default ON): installSidebarRail mixin — ~44px icon strip replaces the 3-tab bar; panels Folders/Tasks/Remote reuse the tab … ⇒ kb-file-structure.md
    sidebar-state.js   — Sidebar state mixin (star/archive/archivedFolders/rename/migration)
    sidebar-render.js  — Sidebar rendering mixin (folder groups, drag-drop)
    sidebar-tasks.js   — Sidebar tasks mixin (client task store + tasks-updated sync, task board render desktop+mobile, bind/unbind write-through, bind popover, attention aggregation)
    task-detail.js     — Task detail window (structured editor: objective/plan/progress/sessions/folders/contextDir/color)
    task-log.js — Task Group log viewer (2.85.0, openSpec openTaskLog, window type 'task'): Backlog tab (2.122.0 — status filter all/open/done/dropped, parked/resolved attribution chips, ✎ inline text+detail edit, ✓/⊘/… ⇒ kb-file-structure.md
    workflow-detail.js — Workflow detail window (POST-HOC dynamic-workflow/ultracode viewer: phases → agents w/ state/model, per-agent View Log; reads the terminal wf_<runId>.json snapshot — live progress is TUI-only, unreadable)
    session-props.js     — Session Properties window (2.49.0: identity/state+history timeline/billing+on-resume account/config/Task-Group toggles/agent steps; openSpec openSessionProps, live re-render on broadcasts)
    user-todos-panel.js — "For you" inbox UI (2.65.0, installUserTodos(app)): taskbar button #taskbar-user-todos (count badge, worst-urgency color, blink + click-to-jump toast on NEW items — knownIds starts null so boot doesn'… ⇒ kb-file-structure.md
    usage-window.js — Usage dashboard window (2.61.0, ⚙ → Usage, window type 'usage', openSpec openUsage). ⇒ kb-file-structure.md
  sidebar-render-mobile.js — Mobile sidebar mixin (two-level folder/group navigation)
    mobile-nav.js — MobileNav class (window switcher, close, desktop tabs, gestures; 2.99.0: ⚙ gear → gs-menu + worst-of quota donut chip → usage popup — the taskbar with ALL its entry points is hidden ≤768px, these are … ⇒ kb-file-structure.md
    session-card.js — Session card renderer (SVG icons, composite backend+mode icons). ⇒ kb-file-structure.md
    agent-meta.js      — Backend/agent metadata, SVG icon creation (createBackendIcon, createModeBackendIcon) + `effortLabel(backend, value, {capitalize})` = picker label with the harness's META `effortHints` one-liner (codex 'ultra' = 0.153 multi-agent delegation, extra usage — offered only when the served model's catalog entry reports it; B-21e4)
    file-explorer.js   — FileExplorer (browse, View menu, resizable columns, preview panel; uploads + ops clusters split out 2.93.0)
    file-explorer-uploads.js — installExplorerUploads: upload popover, batched multipart, inline progress + ring, synced history
    file-explorer-ops.js — installExplorerOps: context/background menus, clipboard copy/cut/paste, rename/delete/duplicate, archive compress/extract, properties
    setup-flows.js     — installSetupFlows(App): onboarding wizard, Backup & migrate, password dialogs, diagnostics report (2.93.0 split from app.js)
    file-viewer.js     — FileViewer (dispatch by type via file-types registry, renderInto shared method; 2.341.0 floating ⟳ reload w/ media cache-bust)
    file-types.js      — File type registry (extension → category, icon, viewer, bypassBinary)
    code-editor.js     — CodeEditor (CodeMirror 6, Prettier format, server-side format, HTML/MD preview; 2.341.0 disk-freshness watch + ⟳ reload — kb-features §File Management)
    chat-view.js       — ChatView controller (virtual scroll, op dispatch, lifecycle; gap-seek mixin split out 2.92.0)
    chat-view-seek.js  — installChatSeek(ChatView): the huge-JSONL continuous-scroll machinery (sentinel, slab loading, teleport, stable-height landings; 17 methods)
    chat-renderers.js  — Message rendering (user/assistant/tool/system, linkify, diffs, permissions)
    chat-input.js      — ChatInput (textarea, send, attachments, drafts, slash commands, TODO display)
    chat-status-bar.js — ChatStatusBar (model, context%, cost, permission mode, task popup)
    chat-search.js     — ChatSearch (Ctrl+F, CSS Custom Highlight API, server-side search)
    chat-minimap.js    — ChatMinimap (semantic scrollbar, turn markers, drag-to-jump)
    highlight.js       — Syntax highlighting (30 hljs languages, code block rendering, line numbers)
    theme-editor.js    — ThemeEditor (floating panel for custom themes, ~50 CSS vars + 16 ANSI colors)
    hex-viewer.js      — HexViewer (binary file viewer with chunked loading)
    resizer.js         — Resizer (reusable drag-to-resize handle)
    layout.js          — LayoutManager (auto-save/restore, multi-client layout sync)
    desktop-manager.js — DesktopManager (virtual desktops, Ubuntu-style previews, window routing) DRAG-REORDER (2.250.0): desktop preview wrappers are draggable(text/desktop-id); dropping onto another preview → reorderDeskt… ⇒ kb-file-structure.md
    stage-manager.js — StageManager (2.112.0 dynamic desktop 'Stage', default OFF via desktop.dynamicEnabled — docs/design-dynamic-desktop.md is the blueprint+progress anchor. ⇒ kb-file-structure.md
    external-editor.js — Ctrl+G split-pane CodeMirror editor (extracted from app.js)
    command-mode.js    — CommandMode (Ctrl+\ prefix key, tmux-style shortcuts, desktop switch)
    session-palette.js — Ctrl+K session palette (fuzzy session switcher; installSessionPalette, desktop only). ⇒ kb-file-structure.md
    icons.js           — Centralized inline SVG icon library (FILE_ICONS + UI_ICONS; imported by file-types/file-explorer/chat-*/etc.)
    customize-mode.js  — CustomizeMode (Firefox-style chrome edit mode: click-to-toggle + drag-to-move elements, zone arrangement, position pills)
    taskbar.js         — Taskbar rendering + window list popup (extracted from app.js)
    browser-window.js  — Embedded browser window (iframe + URL bar + proxy toggle)
    utils.js           — Shared utilities (escHtml, createPopover, showContextMenu, fetchJson, copyText, StateSync)
    i18n.js            — i18n runtime: t(str, params?) with ENGLISH-STRING-AS-KEY, per-device lang (localStorage vibespace.lang), applyI18nToDom for index.html data-i18n/-attr; reload-on-switch (see §16)
    i18n-zh.js / i18n-ja.js — dictionaries ({'English': '翻译'}, 869 entries each; missing key = English fallback)
    autocomplete.js    — Shared directory autocomplete (setupDirAutocomplete)
    settings.js        — SettingsManager (sparse storage, server persist, WS sync, event listeners)
    settings-schema.js — Settings schema (all options with types, defaults, categories)
    settings-ui.js     — SettingsUI (VS Code-style full settings, search + category nav). Opens as a NON-BLOCKING same-level WINDOW (type 'settings', singleton-focus, no openSpec = transient/not persisted) so you can edit a setting and watch the effect live — NOT a modal overlay (2.53.0)
public/
  brand/               — Backend brand SVGs (claude.svg, codex.svg)
  index.html           — HTML structure
  style.css            — CSS: themes, sidebar, toolbar, workspace, windows, taskbar, settings (~2300 lines)
  chat.css             — CSS: chat view, compact mode, role indicators (~600 lines)
  viewers.css          — CSS: file explorer, media viewer, editor, hex viewer (~300 lines)
  theme-editor.css     — CSS: theme editor panel (~100 lines)
  bundle.js            — Built output (do not edit)
CLAUDE.md              — This file
docs/
  design-harness-plugins.md — 2026-09-05 调研: Codex支持缺口矩阵(P0-P3) + HarnessDescriptor抽象层/一致性套件/ACP通用第三方harness + VS Code式插件系统(manifest/派生激活/五层隔离/贡献点→现有注册表); 每节带backlog归属
  README.md            — Documentation index
  getting-started.md   — Installation, first run, quick tour
  terminal.md          — Terminal: dtach, multi-device, clipboard, idle detection, fonts
  window-manager.md    — Windows: grid, snap, command mode, presets, highlight
  sessions.md          — Sessions: discovery, groups, star/archive, drag-drop, filters
  file-explorer.md     — Files: browsing, bookmarks, viewers, right-click, drag-drop
  settings.md          — Settings: global/per-terminal, complete reference table
  mounts.md            — Shared S3 storage: my-storage, share minting, import links
  customize-ui.md      — Customize mode guide: show/hide, drag between bars, springs, alignment, extra rows
  editor.md            — Ctrl+G split-pane CodeMirror editor
  browser.md           — Embedded browser with proxy mode
  keyboard-shortcuts.md — Complete shortcut reference
  screenshot-helper.js — JS sanitizer for privacy-safe screenshots
  screenshots/         — Documentation screenshots (overview, sidebar, settings, grid)
```

## Developer Guide: Where to Find & Modify Code

### Common Tasks → File Location Map

| Task | Primary File(s) | Notes |
|------|-----------------|-------|
| **Add/change terminal behavior** | `src/lib/terminal.js` | xterm.js config, input filtering, cursor, font |
| **Session list / sidebar** | `src/lib/sidebar.js` + `src/lib/sidebar-state.js` + `src/lib/sidebar-render.js` + `src/lib/sidebar-render-mobile.js` + `src/lib/sidebar-workbench.js` (Folders tab) + `src/lib/sidebar-mounts.js` (Remote tab) + `src/lib/session-card.js` | Sidebar shell + state mixin + render mixin (desktop) + render mixin (mobile) + Folders-tab workbench + Remote-tab mounts + card factory |
| **Backend metadata / icons** | `src/lib/agent-meta.js` | Backend/agent meta, createBackendIcon, createModeBackendIcon, contrast adaptation |
| **Session discovery (RUNNING/STOPPED)** | `src/routes/sessions.js` + `src/session-store.js` | Lock-first algorithm, tmux detection, PID verification |
| **Window tiling / grid / snap** | `src/lib/window.js` | Drag, resize, grid cells, layout presets, freeform, Alt bypass, overlap switcher, pre-snap size memory, move mode |
| **Tab groups** | `src/lib/tab-group.js` | Drag icon-to-icon to merge windows into tabs, Chrome-style tab bar, drag-out to split |
| **Custom grid presets** | `src/lib/app.js` → `_addCustomGrid()` + `src/routes/persistence.js` | + button adds, right-click removes, persisted in layouts.json |
| **Session starring** | `src/lib/sidebar.js` → `toggleStar()`, `isStarred()` | ★/☆ per session, starred first in sidebar + taskbar |
| **Task system / board** | `src/task-groups.js` + `src/lib/sidebar-tasks.js` + `src/lib/task-detail.js` | tasks.json store, board (Tasks tab), bind-as-tag, detail window, attention — design in docs/design-task-system.md |
| **Workflow detail viewer** | `src/lib/workflow-detail.js` + `src/routes/sessions.js` (`/api/workflow`) + `chat-renderers.js` (View Workflow btn) | Post-hoc dynamic-workflow/ultracode viewer; reads terminal `wf_<runId>.json` snapshot; per-agent View Log reuses subagent viewer |
| **Session rename** | `src/lib/sidebar.js` → `renameSession()` | Double-click name in sidebar, syncs to open windows via `app.syncSessionName()` |
| **Ctrl+G external editor** | `server.js` → `createEditorHelper()` + `src/lib/external-editor.js` | Fake "code" script + split-pane CodeMirror |
| **File viewer (open file)** | `src/lib/file-viewer.js` | Dispatch by type, size check, binary detection |
| **Code editor** | `src/lib/code-editor.js` | CodeMirror 6, language switching, Prettier/server-side format, markdown/HTML preview |
| **Chat mode** | `src/lib/chat-view.js` (controller) + `src/lib/chat-renderers.js` (rendering) | Virtual scroll, op dispatch, message rendering, tool cards |
| **Chat input / send** | `src/lib/chat-input.js` | Textarea, attachments, slash commands, draft persistence, TODO display |
| **Chat status bar** | `src/lib/chat-status-bar.js` | Model, context%, cost, permission mode dropdown, task popup |
| **Chat search** | `src/lib/chat-search.js` | Ctrl+F, CSS Custom Highlight API, server-side search |
| **Chat minimap** | `src/lib/chat-minimap.js` | Semantic scrollbar, turn markers, drag-to-jump |
| **Hex viewer** | `src/lib/hex-viewer.js` | Binary display with chunked loading |
| **Themes / colors** | `src/lib/themes.js` + `public/style.css` | 6 built-in themes, CSS variables `[data-theme="..."]` |
| **Theme editor** | `src/lib/theme-editor.js` + `public/theme-editor.css` | Floating panel: ~50 CSS vars + 16 ANSI, live preview, save/load/delete |
| **Layout save/restore + sync** | `src/lib/layout.js` + `src/ws-handler.js` | Auto-save debounce, layout-sync WS protocol, openSpec pattern |
| **Virtual desktops** | `src/lib/desktop-manager.js` + `src/ws-handler.js` | Create/delete/rename/switch desktops, Ubuntu-style previews, per-desktop grid, drag-to-move, multi-client sync |
| **Usage / rate limits** | `src/usage-routes.js` + `data/bin/vibespace-usage` + `src/lib/usage-meter.js` | PASSIVE statusline capture by default (§ban-safety); on-demand ⟳ + opt-in active poll + auto-cli — see §9 and the usage-routes.js entry |
| **WebSocket protocol** | `src/ws-handler.js` + `src/lib/ws.js` | All WS message types in ws-handler switch/case |
| **State sync / drafts** | `src/sync-store.js` + `src/lib/utils.js` → `StateSync` class | Versioned diff broadcast, reconnect recovery, draft persistence |
| **Syntax highlighting** | `src/lib/highlight.js` + `src/lib/chat-renderers.js` | 30 hljs languages, line numbers, language picker |
| **File routes** | `src/routes/files.js` | Browse, read, write, upload, download, clipboard paste |
| **Persistence routes** | `src/routes/persistence.js` | Layouts, bookmarks, themes, settings, user state, groups |
| **Taskbar** | `src/lib/taskbar.js` | Taskbar rendering, window list popup, right-click context menu |
| **Command mode** | `src/lib/command-mode.js` | Ctrl+\ prefix key, tmux-style window commands |
| **Embedded browser** | `src/lib/browser-window.js` | iframe + URL bar + proxy toggle |
| **Shared utilities** | `src/lib/utils.js` | escHtml, createPopover, showContextMenu, fetchJson, copyText, showImageOverlay (the ONE image-zoom overlay — chat thumbs + pending chips), StateSync |
| **i18n / translations** | `src/lib/i18n.js` + `i18n-zh.js`/`i18n-ja.js` + `scripts/i18n-extract.mjs` | t() wrapping rules + dictionary workflow in §16 — read it BEFORE adding UI strings |
| **CSS / visual styling** | `public/style.css` + `public/chat.css` + `public/viewers.css` | Split by component area |
| **HTML structure** | `public/index.html` | Sidebar, toolbar, workspace, dialogs |

### Architecture Patterns — INDEX

**Full text: docs/kb-patterns.md (moved verbatim). Cross-cutting coding patterns — the mediator rule, one-time WS handlers, agentEnv() spawn sanitization, no-native-dialogs, drag rAF coalescing, uiScale drag conversions, popover/toast conventions, sidebar poll digest. Read before writing frontend chrome or a new spawn path.** Index:

- All frontend cross-class communication goes through `App` (mediator pattern). Classes receive a…
- One-time WebSocket handler pattern: Register via `ws.onGlobal()`, match on `type` + `sessionId`,…
- Debounced auto-save: `LayoutManager.scheduleAutoSave()` waits 2s after last change. Blocked by …
- Resizer: Reusable component with `inside: true` mode for fixed-position elements (sidebar). Don'…
- Layout restore: `attachSession()` returns `winInfo` synchronously (the DOM element). Position is…
- Proportional bounds tracking: `win.gridBounds` stores position `{left, top, width, height}` as f…
- Title-bar right-click = full window menu (2.212.0): showWindowContextMenu (taskbar.js, shared wi…
- WebSocket reconnect re-attach: On WS reconnect, all active sessions are re-attached. Timeout ≠ d…
- Layout sync (multi-client): State-based — full workspace state broadcast via `layout-sync` WS me…
- Atomic openSpec: `createWindow({ openSpec })` sets the openSpec before `_notify()` fires, ensuri…
- ChatView module split: ChatView is the controller (virtual scroll, op dispatch). Rendering deleg…
- Shared utilities: `createPopover(anchor, className, opts)` handles popover positioning/dedup/clo…
- Agent sessions get a SANITIZED env, never raw `process.env` (2.227.12, `agentEnv()` in ws-handle…
- Server-side settings reads use `serverSetting(key)` (server.js; ws-handler gets it via deps) — b…
- No native dialogs: `prompt()/alert()/confirm()` are banned — use `showInputDialog`/showConfirmD…
- Drag mousemove is rAF-coalesced everywhere (window.js titlebar drag + resize, tab-group icon dra…
- Cursor→window positioning MUST convert viewport→workspace coords (2.100.3, trace-diagnosed real …
- UI scale (DPI) + UI font size (2.257.0, per-DEVICE like the language): gs-menu rows writing loca…
- Sidebar session poll (5s) pauses while `document.hidden` (30s heartbeat + immediate catch-up on …
- Tab groups (chain model): Windows can be merged into tab groups by dragging one window's icon on…
- Tab merge hit-test: Shared helper `_detectTabMergeTarget(x, y, sourceWinId, hiddenEls)` on tab-g…
- Window type icons: Each window type has an inline SVG icon (`TYPE_ICONS` in tab-group.js): termi…
- Move mode: Right-click taskbar → Move. Full-screen overlay blocks all UI interaction. Window res…
- Loading screen: Inline splash in HTML (no CSS dependency). Fades out after `app.ready` promise r…
- Resume-all boot popup (2.250.0): sessions that come back STOPPED restore as read-only history wi…

### Server-Side Key Functions

| Function | Location | Purpose |
|----------|----------|---------|
| `createEditorHelper()` | server.js | Generates `data/bin/code` script on startup |
| `attachToDtach()` | server.js | Creates PTY bridge to dtach socket |
| `restoreSessions()` | server.js | Reconnects to surviving dtach sessions on startup |
| `setupSessionPty()` | server.js | Wires PTY onData (chat JSON parser or terminal raw) + onExit |
| `refreshRateLimit()` | server.js | OPT-IN active usage poll (`accounts.activeUsagePolling`, default OFF — default is passive capture, §9) |
| `registerWsHandler()` | src/ws-handler.js | All WebSocket message type handling (create/attach/kill/etc.) |
| `cwdToProjectDir()` | src/session-store.js | `cwd.replace(/[/._]/g, '-')` — deterministic encoding |
| `recoverCwdFromProjDir()` | src/session-store.js | Greedy reverse: try segments as-is, `.` prefix, `_` |
| `SessionMessages` | src/session-store.js | Unified JSONL+buffer access, chatStatus, taskState |
| `SyncStore` | src/sync-store.js | Versioned key-value store with diff broadcast |
| `broadcastActiveSessions()` | server.js | Pushes session list to all WebSocket clients |

## Key Design Decisions & Lessons Learned — INDEX

**Full text: docs/kb-design-lessons.md (moved verbatim; §-numbers unchanged). Read the relevant § BEFORE touching that area; update it in the same commit.**

- **§1 dtach for session persistence** — dtach NOT tmux (zero rendering layer); `dtach -c` never `-n`; NEVER delete socket files (the socket IS the session); pty-wrapper tees output to the buffer file.
- **§2 Mouse/scroll** — no middle layer; strip `\e[I`/`\e[O` focus events from onData; 6 tmux approaches failed (docs/history-archive.md).
- **§3 Ctrl+G external editor** — fake `code` script (GUI-editor whitelist trick) + HTTP bridge; never print to the terminal from the helper; POST carries the vsst_ Bearer.
- **§4 Session discovery** — LOCK-FIRST; claimJsonls exact→tail→mtime (mtime only over no-tail-evidence files); each lock claims ≤1 JSONL; status values tmux/external/stopped.
- **§5 Project path recovery** — cwd→dir encoding `replace(/[/._]/g,'-')` is deterministic; the reverse is ambiguous, prefer forward.
- **§6/6a/6b/6c Layout** — autosave/restore + gridBounds fractions; custom grid presets; MULTI-CLIENT sync anti-ping-pong (4 guards: seq, user-dirty w/ 60s expiry, defer-while-interacting, rounding epsilon — do not regress ANY); virtual desktops (visibility:hidden model, purge-vs-preserve on close).
- **§7/7a Modular frontend + mobile** — App mediator; isMobile/isTouch; long-press=contextmenu; mobile yield-sidebar is CENTRAL.
- **§8/8a/8b xterm + rendering** — WebGL renderer (do not remove), clearTextureAtlas on font change, alt-screen awareness, query-response arbitration, self-hosted fonts (never third-party origin); hljs span-split fix; 交付夜 invariants (self-update dialog, /dav DAV class 2, archive ops, VNC probe retry, mountpoint hygiene ladder).
- **§9 Usage / rate limits — §ban-safety home** — DEFAULT = passive statusline capture; active poll is OPT-IN (accounts.activeUsagePolling); read-only token NEVER refreshes; OAuth Bearer + anthropic-beta header; approach history in docs/history-archive.md.
- **§10 Settings** — schema-driven; only add settings with working code; serverSetting() server-side (never the SyncStore).
- **§11 Chat mode dual-arch** — THE big one: chat-wrapper stream-json, permission stdio protocol, subagent virtual sessions, workflow viewer, goal loop (claude native + codex thread/goal RPC), interrupt delayed-fallback, model/effort/permission mid-session switches, model lock v2, fallback policy, task wakeups. Read §11 in the kb before ANY chat-pipeline change.
- **§12 Font discovery** — queryLocalFonts → fc-list fallback; client fonts are what matter.
- **§13 StateSync** — versioned diff broadcast + reconnect resync; register stores before set() (writes silently drop otherwise).
- **§14 Syntax highlighting** — 30 langs, EXT_TO_LANG, splitHighlightedLines carries the span stack.
- **§15 Frontend optimization** — minify+gzip; delivery-stall watchdog; stale-tab reload is PER-TAB (sessionStorage); index.html route injects ?v=mtime cache-busting.
- **§16 i18n** — see Laws digest above + kb §16 for the full wrapping rules.
- **§17 UI design conventions** — see Laws digest above + kb §17 for the token/radius/type tables.
- **2026-06-09 review invariants (v2.8.0)** + **2026-07-03 review invariants** — two do-NOT-regress lists (escHtml quotes, atomic JSON writes, AbortController listeners, XSS rules, one-time WS handler self-guards…). In the kb.

## API Reference — INDEX

**Full REST + WebSocket reference: docs/kb-api.md (moved verbatim). Adding/changing a route or WS message type ⇒ update kb-api.md in the same commit.** Quick shape: REST under /api/* (files, sessions, usage, accounts, hosts, mounts, tasks, agent-facing vsst_ endpoints), WS /ws (create/attach/input/kill + msg/layout-sync/state-sync families), /dav WebDAV, /proxy.

## Features Summary — INDEX

**Full behavior reference: docs/kb-features.md (moved verbatim). These sections describe SHIPPED behavior with embedded do-not-regress notes — read the relevant one before changing that surface.**

- **Deployment & Onboarding** — auth (password/Clerk SSO), Docker/K8s/Helm, onboarding wizard, config export/import (4-touch-point gotcha), Manage Agents, account switching + billing identity + verdicts (the accounts mega-essay), chrome customization/springs/zones, toolbar scale, mounts/storage rows, remote hosts + keeper, orphan sweep, kill-path teardown, async discovery sweep.
- **Terminal Management** — dtach sessions, per-terminal settings, bell/idle detection, clipboard image paste, CJK, multi-device size, contrast.
- **Chat Mode** — message rendering, permission cards, relative-path linkify, metadata popup, virtual scroll, minimap, search, drafts, uploads, resume bar, read-only views.
- **Window Manager** — snap/grid/presets, shake-bypass, tab groups, move mode, virtual desktops, taskbar stacking, resume-all boot popup.
- **Session Management** — Task Groups (岗位) refactor + backlog claim model + status/urgency + injection contracts + repo task files + remote ctx sync + group admin + New-Session prefills + right-click menu + Session Properties + per-session config. The 2.39.0 concept-refactor block SUPERSEDES older bullets where they conflict.
- **File Management** — explorer, multi-select, clipboard ops, archives, viewers (PDF/DOCX/XLSX/PPTX/CSV/hex/eml), uploads, cross-host.
- **UI** — themes, theme editor, embedded browser + proxy normalization, window-list popup.

### claude CLI 中途文本丢失 (2026-07-13, 上游bug — 产品无辜, 勿再向内排查)
stream-json 下 assistant 的 `thinking→text→thinking→tool_use` 三明治形状响应, 其 text 块会在**长寿会话**中被 CLI 从 stdout 流和 JSONL 转录**双双丢弃**(模型上下文保留 → 永久分叉; 全新会话不复现, 连同形状都不复现; wrapper/normalizer/renderer 逐层验证无辜)。用户视角="agent 没回复"。取证档案+判别矩阵+issue草稿: ~/workspace/AIWorkspace/SharedContext/claude-cli-text-loss.md。Agent 准则: 实质内容只放 turn 末尾消息(其后无工具调用), 中途只发可丢弃状态行。

- **2.284.0 field-test batch invariants**: message-meta billing row is THREE-state honest (host-namespaced `h:<id>:` rid suffix-match / not-yet-harvested says so + session identity / no-requestId falls back to session-level — never a silently missing row); CLAUDE_KNOWN_MODELS = the GA baseline the dropdown always carries (passive discovery only learns locally-SERVED statusline models — Opus 5 was invisible until served here; noteModelSeen also feeds __models__.json from EVERY session's served model); customize-mode taskbar pill is BODY-FIXED measured off the live bar rect (a bar-child with negative offsets hides under extra rows when docked top); `.cz-overlay` dims with theme-agnostic black (a var(--bg) mix is invisible on dark themes — same class as the no-global-.hidden rule); #taskbar-row2 belongs in the pinned-defaults var block (extra rows are NEUTRAL zones — missing it made the same element size differently top vs bottom); extra rows re-dispatch contextmenu onto their parent bar. **2.284.1: per-message billing joins on message.id** — live stdout records carry NO requestId (CLI behavior; only the transcript copy has it), so the popup lookup queries rid AND mid; eventForMid joins mid-field/rid-fallback/host-namespaced; the remote scanner emits mid (parity-asserted per event). NO billing data is ever lost by a missing requestId — the ledger mines transcripts. Model baseline labels carry NO context-size claims (a claude-opus-5 session served 222k/1M under a "(200k)" label). **2.284.2: `api_retry` system records feed the SPINNER LABEL ("API retrying (3/10, HTTP 500)…"), deliberately card-less** — a fleet API-500 burst read as "everything stuck on thinking" because the subtype was silently dropped (the 2.227.5 invisible-record class again). **Degrade-gracefully catches can swallow their own bugs**: the 2.276.0 local writer sweep referenced shq out of scope and its own catch hid the ReferenceError for 6 releases — a degrade path that logs the message VERBATIM is the only reason it was ever found; never catch broader than the failure you designed for.

### Bug Fixes Applied — INDEX

**Full essays: docs/kb-bugfix-invariants.md (moved verbatim; ancient one-liners in docs/history-archive.md). Each entry is an incident whose FIX carries invariants — search here before re-diagnosing a familiar symptom.** Index:

- CODEX EXCLUDED FROM THE FRAME-FILE BYPASS BY BACKEND ID (design-harness-plugins §1 P1): 帧文件旁路条件里`backend !== 'codex'`让codex的多图粘贴永远走裸pty stdin(可粉碎, 79928a2b类)且wrapper不可解析行静默`continue`(消息丢+无人知); 修复=codex-chat-wrapper实现`_frame_file`(读→必unlink→必须单个JSON→拒嵌套→走handleInput)+宣告caps.frameFile+不可解析行/坏帧文件记日志并发task_failed+每行stdin立即`_stdin_ack`(否则5s broken-pty重发的指针撞上已消费的帧文件); ws-handler条件只剩尺寸+本地传输, 能力决定指针/裸/举证拒收; 不变量=传输安全特性按运行中wrapper宣告的能力门控绝不按backend id, stdin loop绝不静默丢行, 新stdin动词两个wrapper同批
- CODEX SANDBOX CLOSED LOOPBACK → AGENT TOOLS DEAD (2.369.17): codex沙箱网络策略默认关且seccomp连127.0.0.1也禁(AF_UNIX同样)→非yolo的codex会话里vibespace-*工具全EPERM; 修复=wrapper策略带networkAccess:true(VIBESPACE_API存在时)+终端`-c sandbox_workspace_write.network_access=true`(裸布尔)+boot探测改`codex sandbox -- true`功能探测; 不变量=产品依赖的能力要靠运行验证不靠找文件, 同一权限模式在chat/terminal必须解析成同一沙箱
- ATTACH STORM STALL → HEARTBEAT KILLED THE CLIENT → KILLS LOST (2.369.16, inc-mtndq0vb): 重启后首次attach同步convertHistory整份transcript(58会话1.35GB)→19窗口重连风暴堵循环4分钟→心跳把自己停顿期间没读到的pong当客户端死亡terminate→socket里排队的kill全丢; 修复=convertHistoryAsync分片+rebuildHistory单飞+feedLive唯一活记录入口(重建期间排队按序重放)+心跳迟到>5s不判死+kill向请求方应答killed且客户端request resend到ack; 不变量=ws handler里不做整份transcript的同步工作, 活性判定要剔除自己的停顿窗口
- STRANDED WRITES UNDER A DISCONNECTED MOUNT POINT (2.369.15): 未挂载的挂载点=裸目录, 生成的TASK.md把树重建在上面→重连"not empty"; 连接时隔离到兄弟目录`<mp>.stranded-<ts>/`(绝不删)+shadowedBy谓词(files.js 503, TASK.md写入器跳过+mounts-updated重试); 不变量=写用户路径先问shadowedBy, `--allow-non-empty`永不
- VNC POINTER OFFSET UNDER DPI ZOOM (2.369.5): body zoom下noVNC混用viewport px与layout px, 远端指针偏zoom倍; 不变量=VNC画布必须net zoom 1(容器counter-zoom, var反应式)
- RECONNECT RE-ATTACH REBUILD STORM (2.369.2): ws重连re-attach全部会话, 相同slab必须no-op(epoch/total/首尾id全同⇒跳过DOM重建, meta照常applied)
- DIALOG EATEN BY SELECT-DRAG + DESKTOP-SWITCH PAGING STORM (2.369.1): backdrop关闭必须以mousedown起点为准(click的target是共同祖先); 桌面隐藏的ChatView必须suspend(几何无意义时分页/pin机器零决策, 恢复走settle窗口)
- FOLD-DOMINATED TRIM WHITE-SCREEN (2.368.29, inc-mtajy6wr): 语义折叠让150条窗口矮于视口(sh=ch), trim掉的是唯一可见内容+每滚轮瞬移50条; 不变量=窗口矮于2视口必须生长不滑动(两个trim对称, cap升600)
- CREATOR NEVER GETS 'attached' — live state rides 'created' (2.368.4): resume的创建端历史走HTTP无meta, 只搭attach载荷的per-session状态(风格/auto-resume)永远到不了主流程; 加payload字段⇒枚举窗口诞生的每条路(create/attach/view/restart)逐一验证送达; 载荷进meta必须整体传递, 手抄键列表=第五次whitelist漂移
- HOSTED PAGE NEEDED A SECURE CONTEXT (2.366.1, owner '打开后无法加载'): crypto.randomUUID只在secure context存在, 而VibeSpace走明文http+主机名⇒undefined⇒画布每块artboard永远卡'Loading artboard…'; 127.0.0.1是可信源所以我在loopback上的验证全部无效(被owner一句'你用的是你发给我的链接访问的吗'戳破); 控制台两股报错(扩展postMessage 'null'/localStorage SecurityError)都是sandbox opaque origin的真实后果但都不是卡死原因; 修复=serve时compat prelude(randomUUID用getRandomValues补, 存储用内存版, 仅在缺失时装)+/p/<id>改shell(真origin, 无用户内容)框住/p/<id>/raw(仍sandbox); 不变量=托管产物必须在用户实际使用的地址上验证(loopback=secure context, 结论不可迁移), 浏览器测量必须带nonce(三次stale-tab假象带偏两个错误结论), 修复要用同源A/B(无补丁5/5卡, 有补丁0/5)证明
- SHARE URL GUESSED FROM SOMEONE ELSE'S BROWSER (2.366.1): 记住的'上次浏览器origin'被当作分享URL交给agent, 写进聊天回复的是本机主机名; 不变量=服务器不知道自己被怎样访问(反代/隧道), 绝对URL只能来自publicUrl或发问请求的Host, 给agent的一律是相对路径, 由前端按location.origin linkify
- CAPABILITY GATE READ THE WRONG FILE (2.364.1, owner三次Terminate+Resume无效): 2.361.1帧文件能力门从data/session-meta(服务器记录, 从无caps)读caps, 真caps在wrapper sidecar data/session-buffers/<id>.json → 所有wrapper都判'旧', 旁路死两版, >1MB粘贴全拒且拒收文案指错方向; 修复=wrapperCaps()唯一读者(sidecar+碰撞解析器, 无状态), 只缓存正向判定, 拒收带证据+进journal; 不变量=进程宣告的能力只从该进程写的文件读, 负判定不缓存, 拒收必须举证, 读者测试要对着真写者的文件+负控, 报告与解释矛盾时解释错…
- PROXIED POST EATEN BY BODY PARSER (2.363.2, inc-mt2bpw2f userW): express.json在unblocker之上吞掉代理POST的body→目标端等Content-Length到超时, GET无恙所以页面渲染正常但按钮全死; 修复=json parser跳过/proxy/(unblocker保持在auth之后, 严禁open proxy); 不变量=流式中间件必须拿到原始请求, 全局body parser与任何pass-through路由互斥…
- SEND REFUSAL READ AS ATTACH FAILURE (2.363.1, inc-mt2arppw userW): chat-input拒收被client当attach失败→活窗口翻Resume bar+拒收文本在error字段没人读; 修复=code:'input-rejected'分流+双字段+ring补记error; 不变量=一个error类型多语义必须带code分流…
- PEER MESSAGE INVISIBLE ON LIVE STREAM (2.362.2+2.363.0, inc-mt27t0bg userW+owner): CLI收站内信stdout从不带user记录(仅JSONL), 会话发的挖result.origin补渲染; SERVER发的(jobs notify/vibespace-msg)在CLI侧连origin都body-less — 投递梯自己渲染卡片(emitPeerCard); 不变量=可见性归属掌握信息的一方…
- UNSTAGED WIRING (2.355.0, userW复报): 2.331.0纯函数+单测入库但调用点没staged — 修复死了24个版本而单测常绿; 纯函数修复必须配WIRING PIN(套件grep调用点)…
- MANUAL POOL HOT-SWITCH DEMOTED (2.355.0, userW热切换): plan C per-session links优先级盖过手动切换面 — 新间接层压过旧控制面时, 旧面每个writer都要重审为新层consumer…
- NOTIFY-CRON NEVER WOKE ITS OWNER AGENT (2.361.5): notify action只投user inbox+被动组事件, _notifyOwner从未被调用; 修复=接上标准owner投递栈+每job notifyLog投递日志环(面板Delivery log可监控)…
- RUN+ECHO REMINDER = SILENT NO-OP (2.361.4): 定时裸echo因quiet-success law永久静默+创建响应误导; 修复=该形状默认notifyOk+创建响应明说per-fire语义; 不变量=常见直觉形状要么让它工作要么大声拒绝, 绝不accept-and-ignore…
- AGENT-TIME IS UTC, BARE DATETIMES ARE SERVER-LOCAL (2.361.3): --at裸时间按服务器本地时区解析害agent追查幻影'通知链路坏了'; 修复=相对形式+2m+创建回显resolved fire time…
- MONTHLY-SPEND-CAP REJECT UNMARKED (2.361.2): seven_day_overage_included被映射成'other'→周桶+月度cap双死成员7d缓存仍0.53被池反复挑中; 修复=映射到sevenDay+按事件resetsAt标死…
- WRAPPER VERSION SKEW ATE IMAGE PASTES (2.361.1, c1206711): 2.360.0帧文件旁路对旧wrapper会话发指针行→CLI静默丢弃; 修复=wrapper boot meta广播caps.frameFile, 服务器按能力门控…
- HOT-SWITCH STALE-TOKEN MISATTRIBUTION (2.361.0, B-345b定案): 池热切换对运行中CLI不生效(≥25min) — 链接意图记账双向错位毒化odometer+学习率(爆发层-30~-49%); 修复=OTel每请求真值通道…
- SCHEMA-TWIN FALSY-0 REVERT (2.360.1, inc-mt0mozsp): Manage Agents instructions tab held a pre-2.210.0 bounds copy + `Number(v)||dflt` — explicit 0 (every-stop mode) silently…
- PROXY-SWALLOWED ASSIGNMENT (2.343.0, 7th): lazy.js get-only Proxy ate `portForwards.plugins=` since 拆分#12 — publish dead 17 releases; set trap + test-lazy gate; 跨seam赋值必须落在真实例…
- RELATIVE-PATH LOST BINDING (2.341.1, 6th): extraction carried require('./package.json') into src/server/ — call-time throw, all gates blind; test-architecture #8 now statically resolves every re…
- LATENT LOST BINDING (2.340.2, 5th): free identifier swallowed by its own catch — 'capture failed: X is not defined' logs, dead 3 days; grep journals for is-not-defined after every extraction…
- STUCK-THINKING AFTER RESTART (2.339.2): socket-derived wrapper-file reads miss counter-collision sessions — resolve via wrapper argv; attach reconciles streaming vs sidecar…
- TYPING-DRIVEN PAGING SELF-FEED (2.338.0, Windows freeze audit): autosize thrash → anchoring drift → ungated _extendTop paged 50/bounce; every ex…
- Three-tier closure marathon (2.297.0–2.300.0, owner directive "一次性完全做完"; invariants, do not regress): ① script…
- PAGING INTENT GATE (2.307.0, inc-msorcsrl — the mechanism two earlier fixes missed): after an upward page, con…
- PAGING BOUNCE / COLLAPSED GEOMETRY (2.301.0→2.306.0, inc-mso818ry + inc-msor3oax): while content-visibility le…
- SCOPED-BUCKET MERGE (2.305.0, inc-msof8i22 — the pool refused to leave an account whose Opus was spent): model…
- COUNTER CAPTURE (2.302.0, proven in fleet production data): a monotonic counter's value is CAPTURED ONCE and r…
- B-b87b batch (2.267.0 — all 16 confirmed findings from the 31-agent global review; do not regress): ①dial-sess…
- Display cwd must never reach a spawn (2.225.2, userL h200 real incident): the sidebar merge composes remote we…
- Restart-survival audit batch (2.218.0-2.219.0, user directive '整体review所有不抗重启处'; full 54-finding report: Share…
- Dead-session replay = blank window shell (2.217.0, userL ×12 real report; user directive: restart后必须能看read-onl…
- Resume guard (2.179.0, userW's duplicate-session incident): a plain claude `--resume` REUSES the conversation …
- Username migration must also re-encode claude's project dirs (2.236.1, userW's real incident): the 3.5.0 image…
- Changing the container USER ripples to EVERY `kubectl exec` (2.162.7 regression): the 3.5.0 personalized-usern…
- Dial-device (paired) sessions — FULLY FIXED + E2E-verified (B-0d70, 2.163.0–2.164.1; scripts/dbg-dial-session-…
- #workspace must be overflow:clip, NEVER a scroller (2.161.2, three-iteration live-tracer diagnosis): overflow:…
- Permission/AskUserQuestion resolution must survive restarts WITHOUT the control_response (2.109.5, real report…
- SILENT TRANSCRIPT LOSS (2026-07-03, CRITICAL): sessions spawned by a server that was itself started from INSID…
- Chat status bar empty until first reply after resume/attach: model + contextWindow came only from result.mode…
- Clipboard image paste failures: (1) `paste` event never fires — xterm.js v5 uses Clipboard API directly, bypas…
- Spontaneous terminal shrink + disconnect (mid-use, no user action): `resizeSessionToMin` min'd over ALL sessi…
- Dead settings in schema: removed 9 settings defined in `settings-schema.js` but never read by any code (enable…
- Tab merge hit-test matched occluded icons: dragging A's titlebar onto A's own position would merge with a stac…
- `/compact` leaving chat stuck on 'thinking': stream-json emits `user` messages (compact summary) but no resul…
- isStreaming derived from stale normalizer messages: old heuristic scanned normalizer messages for status==='s…
- Huge sessions (>512MB JSONL) — tail-only load + continuous seek scroll (no seam marker): readFileSync(fp,'utf…
- Codex thread vanished from session list permanently: a transient IO error in `extractCodexThreadMeta` was swal…
- Stale openSpec replay → blank chat window with outdated title: a window whose dtach session died and was resum…
- Chat drag-upload overlay permanently visible ("won't disappear"): this project has NO global .hidden {display…
- Claude fork behaved identically to resume in chat: the WebUI never captured Claude's stream-json `session_id` …
- Minimap/search accuracy (huge sessions, reconnect, gap slabs) — five related fixes + the 2.286.1 sixth, keep A…
- CodeMirror active-line highlight hid the selection on the first/last selected line: `highlightActiveLine` (fro…

