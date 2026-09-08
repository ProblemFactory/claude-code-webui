#!/usr/bin/env node
// THE MANDATORY RELEASE GATE — TWO TIERS (2.336.0, owner directive "发版之前能
// 有个强制CI过程，确保至少核心工作流都是能用的"; SPLIT 2026-09-07, B-4c5a).
//
// WHY THE SPLIT. The single battery reached 85 suites / 11.5 min — longer than
// anyone waits before a push and longer than GitHub's SSH idle timeout, which
// is how the "run the gate first, then push" green-marker dance (2.369.51) was
// born and how `VIBESPACE_SKIP_CI=1` started looking reasonable. A gate people
// route around is not a gate. So the battery is now two tiers with two
// different jobs:
//
//   FAST   (`npm run ci`, the pre-push gate) — build + every suite that costs
//          less than ~10 s, PLUS the one real haiku chat turn. Target ≤2 min.
//          Fail-fast: the first red stops the run and blocks the push.
//   HEAVY  (`npm run ci:heavy`) — headless chrome, real worktree servers, real
//          agent CLIs, the real opencode binary, and anything over ~10 s. The
//          pre-push hook launches it DETACHED after the fast tier is green, in
//          its own git worktree at the sha being pushed. Runs every suite (no
//          fail-fast — a background run should report ALL the damage) and
//          writes data/ci-heavy/<sha>.{green,red}.
//
// THE HEAVY TIER STILL BLOCKS — ONE PUSH LATER. A red heavy marker on any
// commit that is an ANCESTOR of HEAD blocks the NEXT push (`--check-heavy`,
// called first by the hook) until a newer green run descends from it or the
// operator uses the existing VIBESPACE_SKIP_CI=1 bypass. That is the honest
// trade: the fast tier proves the push is not obviously broken, the heavy tier
// proves it is actually good, and nothing rides on top of a known-red commit.
//
// EVERY suite under scripts/test-*.mjs is in exactly one tier or in EXCLUDED
// with a reason — asserted by `--census` (and by test-architecture, so it runs
// inside `npm run build`). Before the split, 99 of the 184 suites on disk were
// in NO list at all: they neither ran nor were they written down anywhere.
//
// Modes:
//   node scripts/ci.mjs                  the FAST gate (+ .git/ci-green marker)
//   node scripts/ci.mjs --heavy          the HEAVY tier here, now
//   node scripts/ci.mjs --heavy-launch <sha>   detach a heavy run for <sha>
//   node scripts/ci.mjs --check-heavy    exit 1 if a red heavy blocks a push
//   node scripts/ci.mjs --status         last heavy result per sha
//   node scripts/ci.mjs --census         the tier census self-test
// Ops flags: --markers=<dir> (where heavy results live), --head=<sha> (which
// commit the verdict is about), --only=a,b (a subset of the heavy tier, e.g.
// re-running one suite after a fix; an unknown name is a loud exit 2).
// Mirrored in .github/workflows/ci.yml (fast and heavy as separate jobs).
// Gate for this file: scripts/test-ci-gate.mjs.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitEnvFrom } from './git-env.mjs';

const HERE = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(HERE), '..');
// This file is imported by scripts/test-architecture.mjs (the census) and is
// launched from a git hook, so EVERY git it runs gets the sanitized
// environment — a hook exports GIT_DIR/GIT_INDEX_FILE and the heavy tier runs
// `git worktree add` (scripts/git-env.mjs has the full essay).
const GIT_ENV = gitEnvFrom(process.env);

// ─────────────────────────────────────────────────────────────────────────
// THE TIER TABLE. `tier` is 'fast' or 'heavy'; every HEAVY entry states WHY it
// is not in the fast tier — chrome / server / cli / binary / slow / adopted —
// with the measured wall time that says so, because "heavy" without a reason
// is where suites go to be forgotten. Both tiers are ordered by MEASURED cost,
// cheap first, so a pure-logic regression fails in seconds.
// ─────────────────────────────────────────────────────────────────────────
export const SUITES = [
  // ── FAST TIER — the pre-push gate. MEASURED cheap→expensive so a
  // pure-logic regression fails in seconds. Nothing here launches a
  // browser and nothing here costs ~10s; the one deliberate exception is
  // test-chat-e2e (a real haiku turn, ~10s, real quota) — it stays because
  // it is the only proof in the whole battery that a real turn works.
  { name: 'test-lazy', tier: 'fast' },
  { name: 'test-migrations', tier: 'fast' },
  { name: 'test-auto-cli-refresh', tier: 'fast' },
  { name: 'test-task-wakeup-card', tier: 'fast' }, // background-task lifecycle closure incl. the real record order (tool_result BEFORE the completion notification); also joined the gate late (same class)
  { name: 'test-agentd-upgrade-loop', tier: 'fast' },
  { name: 'test-pool-auto', tier: 'fast' },
  { name: 'test-rate-limit-capture', tier: 'fast' },
  { name: 'test-public-links', tier: 'fast' }, // every "link to something here" surface uses the instance's public address (not the browser origin)
  { name: 'test-remote-shell', tier: 'fast' },
  { name: 'test-mount-oauth-probe', tier: 'fast' }, // dead OAuth token behind a healthy-looking mount: probe eligibility + slow clock + phrasings + Re-authorize button
  { name: 'test-compaction-ux', tier: 'fast' }, // prompt_too_long → guidance card + /compact turn label + two-step Stop (normalizer behavioral + wiring pins)
  { name: 'test-job-model', tier: 'fast' },
  { name: 'test-usage-estimator', tier: 'fast' }, // dead-reckoning core; was OUTSIDE the gate (silent-stale class) until the 2.368.13 delta-relative calib change touched it
  { name: 'test-remote-discovery-dirty', tier: 'fast' },
  { name: 'test-resume-all-desktops', tier: 'fast' }, // pure scan + the WIRING pin (the 2.331.0 dead-fix lesson)
  { name: 'test-ctx-sync', tier: 'fast' },
  { name: 'test-task-lifecycle', tier: 'fast' }, // background Agent/Workflow/Bash lifecycle from HISTORY (launch acks + persisted notifications)
  { name: 'test-codex-quota', tier: 'fast' }, // codex quota P0+P1: window-by-length normalization (0.149.x single-window), exhaustion markers kept, persistence, estimator inclusion
  { name: 'test-peer-delivery', tier: 'fast' }, // peerDelivery registry lane: codex rpc-queue rung (real deliver.create + sidecar) + wiring pins
  { name: 'test-cli-usage-parse', tier: 'fast' },
  { name: 'test-account-relogin', tier: 'fast' },
  { name: 'test-peer-msg-card', tier: 'fast' }, // peer message visible on the LIVE stream (result.origin mining + 3-site dedup) + the codex twin (injectPeerCard, webui_peer marker live/rebuild, marker-blind twin dedup, feedPeerCard no longer false for codex)
  { name: 'test-stdout-registry', tier: 'fast' }, // S5 stdout consumer registry: descriptor caps.streamProtocol → ONE consumer (src/server/stdout/); unknown protocol = loud console.error + telemetry + RAW passthrough (never stream-json); each consumer on a fake pty feeds representative records to its REAL normalizer + id adoption / streaming flag / _stdin_ack / todos / engine calls; wiring pins
  { name: 'test-account-pool', tier: 'fast' },
  { name: 'test-mount-stranded', tier: 'fast' }, // stranded writes under a DISCONNECTED mount point: quarantine-never-delete on connect + shadowedBy predicate + TASK.md writer guard + wiring pins
  { name: 'test-pool-signed-out', tier: 'fast' },
  { name: 'test-owner-batch-2369-32', tier: 'fast' }, // owner batch 2.369.32: codex resume model continuity (last turn_context) + wrapper model pin, sidebar primary-only default, codex ⟳ dispatch, auto-resume origin label, 'not started' reset display
  { name: 'test-codex-pool', tier: 'fast' }, // codex pooled account cold-switch v1: store/spawn/self-heal + engine gates + wrapper signal relay + list() pool shape for every backend + ONE shared pool menu/roster pins (2.369.18)
  { name: 'test-vendor-whitelist', tier: 'fast' },
  { name: 'test-account-verdicts', tier: 'fast' },
  { name: 'test-window-types', tier: 'fast' }, // window-type registry (Plugin Ph1): node-functional dispatch + loud unknown-action + the exact core type/action sets + no switch/TYPE_ICONS literal left
  { name: 'test-harness-contract', tier: 'fast' }, // S1 harness registry conformance: every registered harness passes the same descriptor/adapter/normalizer/wrapper/store/client-META assertions; unknown ids throw
  { name: 'test-tool-toggles', tier: 'fast' }, // per-feature Integration toggles: a disabled agent CLI is neither taught (context/reminder/stop nudge) nor served (403) — was outside the gate and rotted on a literal CLI count for 27 releases (B-0e1b)
  { name: 'test-image-cards', tier: 'fast' }, // image media cards against the REAL renderer in node: claude Read(image) + codex view_image → one expandable /api/file/raw card (host-qualified), non-image cards unchanged, XSS, codex call_id dedupe + input_image lifting, wiring pins
  { name: 'test-otel-truth', tier: 'fast' }, // per-request billing truth: parser + loopback ingest + bake override + wiring pins
  { name: 'test-search-card-title', tier: 'fast' }, // search cards carry the query in the TITLE (claude WebSearch/WebFetch, codex web_search, ACP search): pure helper + the REAL renderer (esbuild→node) incl. XSS escaping + wiring pins
  { name: 'test-attach-rebuild', tier: 'fast' }, // first-attach history rebuild is time-sliced + gated (live records replay in order), heartbeat is stall-aware, kills are acknowledged + re-sent until acked
  { name: 'test-path-mounts', tier: 'fast' }, // /svc/<name>/ reverse proxy: real http+ws round trips + store rules
  { name: 'test-contributions', tier: 'fast' }, // commands + menus (when/group/order) + keybindings registry (Plugin Ph1): node-functional dispatch/ordering/filtering/dispatcher, the three migrated core menus ≡ verbatim legacy builders over a state matrix, ws-handler `default:` on the REAL handler (no sessionId in the reply), plugin-scoped removal, wiring pins
  { name: 'test-published-pages', tier: 'fast' }, // instance-hosted shareable HTML: publish/serve/auth-gate/CSP-sandbox/upsert + wiring pins
  { name: 'test-usage-walk-parity', tier: 'fast' },
  { name: 'test-proxy-post', tier: 'fast' }, // proxied POST body reaches the target (real unblocker; the json-parser-skips-/proxy/ pin)
  { name: 'test-auto-resume', tier: 'fast' }, // continue-after-limit-reset (tri-state gate, never-early/twice, restart-survival) + CLI output style at spawn
  { name: 'test-codex-sandbox-net', tier: 'fast' }, // codex sandbox keeps loopback open for the vibespace-* tools: real `codex sandbox` A/B (evidence-SKIP without the binary) + wrapper/adapter/probe pins
  { name: 'test-codex-subagents', tier: 'fast' }, // B-7473 sub-agent visibility: the PURE row builder (labels/coalescing/XSS marker proof), the renderer + chat-view click-through/fold wiring, and GET /api/subagents over a temp CODEX_HOME with real parent+child rollout heads
  { name: 'test-quota-source', tier: 'fast' }, // harness S4: per-harness QuotaSignalSource (normalize/signalFromStream/probe/classifyAuthFailure on real shapes) + the caps-routed probe dispatcher (no claude spawn for codex identities) + wiring pins
  { name: 'test-server-globals', tier: 'fast' },
  { name: 'test-peer-messaging', tier: 'fast' },
  { name: 'test-plugin-loader', tier: 'fast' }, // Plugin Ph2: manifest validator matrix + a real fixture plugin (iframe assets w/ sandbox CSP, forked server process, proxied routes, agent-tool shim, enable/disable lifecycle) + client wiring pins
  { name: 'test-codex-p2-client', tier: 'fast' }, // codex P2 client rows: fork via thread/fork (real wrapper vs stub), onboarding per-backend readiness, switcher codex quota, permission-mode seeds
  { name: 'test-wrapper-files', tier: 'fast' },
  { name: 'test-ci-gate', tier: 'fast' },
  { name: 'test-design-kit', tier: 'fast' }, // /design kit from the installed CLI: extraction (cli-dir + binary parity), adaptation all-or-nothing, helper --check, wiring
  { name: 'test-usage-ledger-perf', tier: 'fast' }, // inc-mtox23xw: the estimator's per-pair ledger walk is O(log n + k) + interval-memoized (it blocked the loop 10-59s); parity vs brute force + timing pins
  { name: 'test-codex-effort-meta', tier: 'fast' }, // the effort a TURN ran at (owner: "调成了 ultra 但 metadata 显示 xhigh"): the resume race reproduced against a stub app-server with the REAL wrapper (+ a negative control in master's record shapes), set-effort reaching the app-server AND the live status, per-message meta following its own turn, the wrapper_meta fallback, the merge fold vs codex's own copy, the session-meta writer, and the "ultra (multi-agent · reasoning …)" label read from the model catalog
  { name: 'test-plugin-security', tier: 'fast' }, // plugin-system security regressions (2.369.43): shim code-injection via manifest free text, capability-path collapsing, agent-tools consent gate, reinstall-under-a-trusted-id, proxied-reply headers, per-child stop mark, upload cleanup
  { name: 'test-local-device', tier: 'fast' },
  { name: 'test-agent-msg', tier: 'fast' }, // Channels v1: ACL matrix + delivery ladder + wiring pins
  { name: 'test-plugin-trust', tier: 'fast' }, // Plugin Ph4: validator (settings/themes/capabilities/module tier), consent 409 + trusted enable + drift re-prompt, module 403/200 + theme serving, node --permission denial vs granted path, install path/zip/Zip-Slip/update/uninstall-to-trash, shim shipping, client pins
  { name: 'test-codex-history', tier: 'fast' }, // codex rollout coverage: custom_tool_call_output routing, sub-agent visibility, live contextWindow, encrypted reasoning, web_search_end cards (rollout-only searches, live twin dedup, 0.14x call pairing)
  { name: 'test-transcript-parity', tier: 'fast' },
  { name: 'test-codex-0153', tier: 'fast' }, // codex 0.153.4 remainder (B-21e4): fork ordinal (Referenced-fork prefix cut, sub-agent start ordinal, wrapper forked_from echo) + the rows added below it
  { name: 'test-sysinfo-op', tier: 'fast' },
  { name: 'test-opencode-serve', tier: 'fast' }, // S9 OpenCode serve-mode store: mock serve (client, session→acp-events synthesis, discover cache/negative-cache/hang budget ≤2s, keeper reuse/spawn/crash-park/stop, serve-backed reader, caps verdict) + wiring pins
  { name: 'test-ci-heavy-launch', tier: 'fast' },
  { name: 'test-codex-zst', tier: 'fast' }, // harness S3: descriptor store (discover/locate/forkChain/writerSweep/remoteFind) + codex facts off the hot path (worker walk, dir-mtime cache, /proc liveness) + zstd rollouts (readers, walker+scanner lockstep, NC/CO discovery lines)
  { name: 'test-agentd-session', tier: 'fast' },
  { name: 'test-instance-url', tier: 'fast' }, // this instance's own public address: frp mapping layered over agentd.publicUrl (never written), one publisher of the relay proxy
  { name: 'test-chat-frame-guard', tier: 'fast' }, // 38MB-poisoning trio: poison guard + frame-file bypass (real claude AND codex wrappers, loud rejections) + rescue + capability-only gate pins
  { name: 'test-discovery-interpret', tier: 'fast' },
  { name: 'test-restore-smoke', tier: 'fast' }, // the end-to-end boot + session-lifecycle + 29-route GET battery (the lost-export class only shows at boot or route-run time). 8.9s measured: the most expensive thing the fast tier is willing to pay for
  { name: 'test-chat-trim-guard', tier: 'fast' }, // fold-dominated window trim guard (inc-mtajy6wr white-screen) pins
  { name: 'test-chat-e2e', tier: 'fast' }, // ONE real haiku turn through the full chat pipeline (oat token slot; SKIPs without ~/.config/vibespace/ci-oat)

  // ── HEAVY TIER — MEASURED cheap→expensive. Two origins, both stated per
  // row: the suites that already paid for the 11.5-minute battery (chrome,
  // real worktree servers, real agent CLIs, the real opencode binary), and
  // the 83 ADOPTED on 2026-09-07 — suites that were in NO runner at all,
  // which is what the census (B-4c5a) was filed for. Adopted suites land
  // here rather than in fast even when they are cheap: the fast tier is the
  // CURATED pre-push battery, and an unaudited suite earns a place in it
  // deliberately, with a measurement — never by default.
  { name: 'test-paging-collapse-guard', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (14ms)' }, // COLLAPSED-GEOMETRY guard, pinned against the REAL incident numbers (inc-mso818ry). The scroll tracer recorded 14 extendTop landings in the affected window: 11…
  { name: 'test-get-usage-parse', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (16ms)' }, // B-7edc: get_usage control-request builder + rate_limits→cache parser. Pure pieces — the LIVE ws-correlation is validated separately on a real chat session (the…
  { name: 'test-permission-mode-ack', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (16ms)' }, // Regression test for the tracked set_permission_mode flow (2.195.0). CLI ground truth (verified live on claude 2.1.215, scripts in the 2.195.0 changelog entry)…
  { name: 'test-resume-desktop', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (16ms)' }, // Pool cold-restart + resume must keep each conversation on its HOME desktop (a fleet user, inc-mso43urh: a pool target switch cold-restarted sessions across
  { name: 'test-session-palette-search', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (16ms)' }, // Palette search: userW's real regression (inc-msjro90z-n6y3) + guards. "cmd+K 搜 best ever 搜不到 best ever toB signing 的 session，只能搜到 vendor session"
  { name: 'test-usage-pace', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (16ms)' }, // Parity test for src/lib/usage-pace.js vs claude-swap's pace.py logic (B-87fe).
  { name: 'test-device-mount-rclone', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (17ms) — server' }, // device-folder-mount LAST MILE (2.150.0): a REAL rclone `webdav` mount over the device chain (serve-folder → tcp-forward → rclone mount), verifying the device's…
  { name: 'test-frp-plugin', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (17ms) — server' }, // LIVE test for the frp plugin (B-0b60 public exposure) against the REAL frps relay. Needs the relay env: set VIBESPACE_FRPS_* directly, or point…
  { name: 'test-tool-progress', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (17ms)' }, // tool_progress must never be treated as a subagent message (2.227.7). Real record shape captured from a live stream buffer.
  { name: 'test-fallback-policy', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (18ms)' }, // claude.disableModelFallback contract test (2.228.0). Covers the three mechanisms: (1) spawn — buildSessionArgs merges switchModelsOnFlag:false into ONE --settings…
  { name: 'test-model-fallback-notice', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (18ms)' }, // REAL record shape captured from the transcript
  { name: 'test-usage-anchors', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (18ms)' }, // Dead-reckoning data foundation: identity key precedence (survives sub remove+re-add), anchor dedup by fetchedAt, cost-delta pairing.
  { name: 'test-creds-symlink-swap', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (19ms)' }, // Design guard for pooled hot-swap (B-6217/B-71c3): the session's credential directory is a SYMLINK to the canonical account dir; swapping accounts = re-pointing that…
  { name: 'test-session-id-race', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (19ms)' }, // Session id / socket-name COUNTER RACE (2026-08-11, proven in production data on a fleet instance: four sessions minted ids sess-21/22/31/34 all carried sockName…
  { name: 'test-message-ids', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (20ms) — server' }, // R0 — content-derived message ids (docs/design-three-tier.md). The old id was `${sessionId}:${counter}` — every parser rebuild renumbered everything, which forces…
  { name: 'test-page-attachments', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (21ms)' }, // Regression test for CLI-injected PDF page images (2.194.0). A Read on a PDF ships the extracted pages into model context as image-only user records: LIVE = one…
  { name: 'test-dedup-sockets', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (22ms)' }, // dedupWebuiSockets — restore-time conversation dedup (2.185.3, real owner "重复session" report). A plain `claude --resume` REUSES the conversation id, so a resume of a…
  { name: 'test-eml', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (22ms)' }, // Unit tests for src/lib/eml.js — run: node scripts/test-eml.mjs
  { name: 'test-remote-attribution', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (22ms)' }, // Per-account attribution for REMOTE ledger events (2.294.0, the owner's live complaint: a remote message's billing row could only say "<host>'s machine login").…
  { name: 'test-onedrive-resolve', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (23ms)' }, // OneDrive drive_id/drive_type resolution (2.268.8) — rclone's onedrive backend refuses to create the fs without both in config, and the guided add flow has no…
  { name: 'test-usage-scan-subagents', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (23ms)' }, // 2.265.0: the ledger scan must mine SUBAGENT + WORKFLOW agent transcripts (<proj>/<sid>/subagents/**). Workflow agents' API usage exists ONLY there — the…
  { name: 'test-claim-jsonls', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (24ms)' },
  { name: 'test-task-colors', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (26ms)' }, // Task-group color scalability (2.230.0): auto-distinct colors for unset groups must be deterministic (same id → same color, every client/restart) and well-spread…
  { name: 'test-conversation-index', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (29ms)' }, // Conversation-location index (R3 tail): host-inference / dead-host rescue can locate a conversation the raw transcript cache has never seen (ownership recorded from…
  { name: 'test-graduate-dial', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (30ms) — server' }, // B-6640 e2e: graduate a REAL ssh machine to dial-out and back. Runs a THROWAWAY server in a git worktree (its own data/ — never touches a live instance) with the…
  { name: 'test-machine-migrate', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (31ms) — server' }, // B-f3e8 migration guard: dial-tokens.json → host records (dialTokenHash) and host-mounts.json + device-mounts.json → machine-mounts.json. The token migration MUST be…
  { name: 'test-agent-env', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (34ms)' }, // agentEnv() contract test (2.227.12) — the sanitizer that keeps the server's container runtime env (and the instance's chart-injected SECRETS) out of agent sessions.…
  { name: 'test-transcript-switchover', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (36ms) — server' }, // R3/R5 switchover ladders: the device is PRIMARY, every fallback rung still works, and the live-session overlay is never bypassed.
  { name: 'test-usage-link', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (37ms)' }, // Smoke for the global↔named usage-account link (usage-routes ingestPassiveUsage): org-uuid evidence must beat a stale ~/.claude.json email, and a proven-different
  { name: 'test-context-diff', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (50ms)' }, // Unit tests for TaskGroupManager.snapshotForDiff / renderContextDiff — the diff-based Task Group update injection (2.113.0). Pure store-level tests (no server)…
  { name: 'test-task-scan', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (53ms)' }, // Task-tool scan regression (2.180.1 — real report: a long-completed task showed as in_progress in Steps forever): (a) COMPACTION re-appends retained records…
  { name: 'test-claude-subscription-login', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (70ms) — cli' },
  { name: 'test-layout-history', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (81ms)' }, // Layout rollback points (2.296.0). A layout-destroying bug was previously unrecoverable: sessions survive, but WHERE they lived is gone, and when the damage EMPTIES…
  { name: 'test-discovery-facts', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (98ms) — server' }, // ONE interpretation of discovery facts, any machine (CS separation, 2.278.0). The collectors legitimately differ (local rich sweep / daemon snapshot / ssh script…
  { name: 'test-group-admin', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (99ms)' }, // Route-level smoke for /api/agent/group-admin (2.132.0, issue #21 — manager agent delegation). Fake express + real TaskGroupManager in a temp dir. Asserts the DOUBLE…
  { name: 'test-prompt-context', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (119ms) — cli' }, // Route-level smoke for /api/agent/prompt-context — the diff-update delivery (2.113.0). Drives setupAgentRoutes with a fake express app + a real TaskGroupManager in a…
  { name: 'test-agentd-reexec-argv', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (154ms) — server' }, // Self-upgrade re-exec must PRESERVE the original argv (2.185.2, real owner↔Mac dial outage). The dial transport reads `--dial <url> --dial-token <t>` from…
  { name: 'test-node-bootstrap', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (226ms) — server' }, // Node-free pairing: the installer's node RESOLUTION + PROVISIONING contract (2.246.0). Hermetic — a local HTTP fixture stands in for nodejs.org/dist, so
  { name: 'test-gmail-sync', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (324ms)' }, // Offline e2e for the Gmail sync engine (2.134.0): a mock Gmail API served on 127.0.0.1 + a patched API base exercises seed sync, filename shape (RFC2047
  { name: 'test-exit-proxy', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (325ms) — server' }, // ExitProxyManager (task #164): opt-in gating, machine resolution, and the SOCKS forward's byte pipe + lifecycle. The daemon SOCKS5 protocol itself is covered by…
  { name: 'test-mux', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (425ms) — server' }, // Unit test for src/agentd/mux.js — framing round-trip, chan-0 JSON control, byte-channel data, and CREDIT flow control (a fat transfer must not starve a
  { name: 'test-ssh-key-dialog', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (650ms) — chrome' },
  { name: 'test-ssh-key', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (757ms)' },
  { name: 'test-device-secret-quota', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (794ms) — server' }, // place-secret + quota-refresh device ops (2.298.0, design §Account split / §Quota refresh origin) against a REAL daemon. The quota op's VENDOR call is deliberately…
  { name: 'test-agentd-socks', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (903ms) — server' }, // On-demand EGRESS through a device (task #164): the daemon serves a SOCKS5 proxy on its loopback, the server reaches it via tcpForward, and a real SOCKS5 client…
  { name: 'test-agentd-bigread', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (910ms) — server' }, // Big-transfer integrity over the device plane (2.187.0). The mux control channel is credit-EXEMPT, so fs-done / stream-exit could OVERTAKE data still queued behind…
  { name: 'test-device-agent-setup', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (953ms) — server' }, // deviceAgentSetup primitives over a REAL dialed-in daemon (graduation B.3): the ws-handler dial branch ships agent tools + the 0600 token via fsWrite, registers the…
  { name: 'test-agentd-devicemount', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (1221ms) — server' }, // device-folder-mount CHAIN acceptance (2.150.0): the daemon serves a folder over WEBDAV on 127.0.0.1 (serve-folder), the server reaches it through the mux via…
  { name: 'test-transcript-worker', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (1268ms)' }, // Transcript worker contract + main-thread-block regression (2.235.0, the userL degradation follow-up). Generates a >34MB JSONL (forces the bounded tail path + line…
  { name: 'test-machine-probes', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (1270ms) — server' }, // R1 — machine fact probes, one implementation for every machine (docs/design-three-tier.md `probe.*`). The same facts existed three ways: the local backend-status…
  { name: 'test-attach-ack', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (1788ms) — server' }, // attach-ack proof-of-life contract (2.234.1, userL mass false-death incident): EVERY ws attach — real, sub-, or nonexistent id — must get a synchronous attach-ack…
  { name: 'test-login-expiry', tier: 'heavy', why: 'chrome — the fast tier never launches a browser (1934ms here; a browser leg\'s cost follows machine load)' }, // a subscription's LOGIN SESSION has its own absolute deadline: pure reading (incl. the CLI-wiped shape), pool gates (dead ⇒ never usable, near ⇒ never a switch target), the once-per-threshold inbox ladder on a fake clock (restart-survival + re-login reset), the STRING every blocked/inbox surface prints (a login is never a spent quota bucket; a wiped file is never "expired" at a future date), wiring pins
  { name: 'test-agentd', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (3068ms) — server' }, // M0 e2e for vibespace-agentd (docs/design-remote-cs.md "= the local config"). Builds the daemon bundle into a temp install root, then via DeviceManager:
  { name: 'test-agentd-tunnel', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (3417ms) — server' }, // REVERSE-FORWARD (tunnel) acceptance (2.148.0, "互挂云盘去公网化"): the daemon binds 127.0.0.1:<port> ON THE DEVICE and pushes every accepted connection back over the mux to…
  { name: 'test-remote-lasterror', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (3724ms)' }, // meta.remote.lastError contract (2.228.1, the userL "host reconnecting (9) with no reason" report): when the remote transport child dies, the wrapper must record the…
  { name: 'test-agentd-dial', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (3733ms) — server' }, // Transport B e2e (dial-out, M4-lite): a daemon behind "NAT" dials OUT to the server over websocket (hand-rolled zero-dep client in the bundle); the server speaks the…
  { name: 'test-incident', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (4056ms) — chrome' }, // Incident-capture contract smoke (2.238.0): POST /api/incident writes a bundle with client rings + server state, append attaches a follow-up, /api/incidents lists…
  { name: 'test-workflow-usage-tailer', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (4571ms)' }, // Workflow usage tailer (2.270.0) — the race regression test: the launch ack precedes the run dir's creation by ~17ms in real runs, so the tailer MUST arm on a dir…
  { name: 'test-agentd-remote', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (4624ms) — server' }, // M2 e2e: the agentd protocol over the SSH STDIO BRIDGE + persistent pipe-sessions (docs/design-remote-cs.md M2). The "remote" is localhost over a real `ssh` process…
  { name: 'test-cwd-recreate', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (4897ms) — server' },
  { name: 'test-port-forward', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (5242ms) — server' }, // Unit test for PortForwardManager (B-0b60 tunnel path): detect() parsing + end-to-end piping through a MOCK device (tcpForward → a real loopback echo server standing…
  { name: 'test-usage-events-push', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (5276ms) — server' }, // usage-events PUSH stream (R4 finale) against a REAL daemon: transcript growth → walker child → batched chan-0 push → server ack commits the device-side cursor…
  { name: 'test-usage-scan-op', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (5940ms) — cli' }, // R4 step 1 — the daemon's `usage-scan` op, end to end against a REAL daemon (docs/design-three-tier.md `usage.scan`). WHAT IT PINS: (1) the op's events match the…
  { name: 'test-sidebar-scroll', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (6336ms) — chrome' }, // Sidebar lazy-folder scroll preservation (2.228.3, recurring user report: "scroll down, click a card's expand arrow → the list jumps back to the top"). Mechanism…
  { name: 'test-desktop-drop', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (6696ms) — chrome' }, // Desktop-preview drop resolves the target desktop by the preview's OWN id, NOT by DOM index (task #165, real report: dropping a window on a preview landed it on the…
  { name: 'test-ghost-host-heal', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (7202ms) — chrome' }, // GHOST-HOST SELF-HEAL (2.334.1, real fleet report): a persisted Recent/History host selection whose host record was REMOVED left the switcher <select> rendering…
  { name: 'test-auto-resume-loop', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (7458ms) — cli' }, // THE AUTO-RESUME FIRE LOOP (2026-09-07 incident; owner decision ut-1c6c15a2db ①④). What happened, from the frozen journal (last 6h of the production server):
  { name: 'test-harness-honesty', tier: 'heavy', why: 'chrome — the fast tier never launches a browser (7631ms here; a browser leg\'s cost follows machine load)' }, // the 2026-09-07 survey's four defects: codex personality is the USER's choice (unset ⇒ key absent; thread/settings/update applies it live), one explicit reply shape per ServerRequest method (+ MCP elicitation as a question card, unsupported ⇒ JSON-RPC error not a hang), the ACP unknown-sessionUpdate breadcrumb, and image_gen/sleep shape-equal across all THREE producers (live wrapper / rollout / thread-read) with a headless-chrome leg proving the image really draws
  { name: 'test-sidebar-empty-remote', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (7799ms) — chrome' }, // Zero-local-sessions + a configured remote host must still render the workbench with its Recent host switcher (2.186.8, real report: a fresh instance with a remote…
  { name: 'test-codex-remote-wrapper', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (8128ms) — server' }, // E2E for codex-chat-wrapper's REMOTE MODE (2.139.0, B-0588): a minimal JSON-RPC app-server stub runs under the REAL vibespace-remote-keeper; the wrapper attaches…
  { name: 'test-agentd-adopt', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (8362ms) — server' }, // Pipe-session ADOPTION across a daemon restart (the 2026-07-17 userL outage): a remote chat child is spawned as `sh -lc '… exec … <cli>'`, so after the execs its…
  { name: 'test-agentd-wired', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (8902ms) — server' }, // M2 WIRED-CHAIN e2e: the full production pipeline with the agentd path ON — chat-wrapper (remote mode) → agentd-attach bridge → standing daemon → persistent pipe…
  { name: 'test-run-collapse-fold', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (9004ms) — chrome' }, // CDP smoke: a Skill card folds, and a newly appended foldable card is folded BEFORE it can paint (no flash) — 2.227.9.
  { name: 'test-queue-steer', tier: 'heavy', why: 'chrome — the fast tier never launches a browser (9206ms here; a browser leg\'s cost follows machine load)' }, // QUEUED vs STEERED input (owner ask): the backend-caps inputModes row + client META twin, the formatQueueOp adapter verb (refusals name the reason), the ws 'queue-op' caps gate + coded refusal, the normalizer's queue meta op + bubble chips + multi-queue semantics, a DOM-free render of the queue strip from the REAL ChatInput (incl. XSS), and the REAL wrapper against a REAL `codex app-server` (no turn — evidence-SKIP without the binary; a renamed queue method fails there)
  { name: 'test-agentd-workers', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (10s) — server' }, // R2 — daemon worker isolation (docs/design-three-tier.md). THE INVARIANT: a hung filesystem path (dead FUSE mount class) may starve a WORKER — which the pool then…
  { name: 'test-local-discovery-device', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (11s) — cli' }, // B-47e2 — the local discovery sweep's FS facts from device #0, flag-gated. PARITY: with a synthetic HOME (locks + transcripts + a resumed session's tail-id case)…
  { name: 'test-stage-overlap', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (11s) — chrome' }, // Stage pile-at-slot regression smoke (userW's 超级重叠, 2.209.0): BUG: Stage → normal desktop → Stage round trip revealed EVERY slot-parked ex-hero at identical slot…
  { name: 'test-minimap-jump', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (12s) — chrome' }, // INDEX-mode minimap jump landing (inc-msnyti7z-c5sb: "minimap 跳转又不准" on a tool-heavy 4.4MB remote session). The incident trace showed the exact failure: jumpToIndex…
  { name: 'test-session-brain-dark', tier: 'heavy', why: 'slow, server (13s)' }, // SESSION-BRAIN STEP 2 (dark double-feed) against a REAL daemon. Pins: (1) the daemon's device-side normalizer stream emits ops for a live pipe session's stdout; (2)…
  { name: 'test-fold-ux', tier: 'heavy', why: 'chrome — the fast tier never launches a browser (14s here; a browser leg\'s cost follows machine load)' }, // run-fold honesty (ToolSearch = tool lookups, never MCP; pure summary composer) + expanded-run legibility (rail/floating bar/footer) — node unit + headless-chrome fixture (SKIPs the chrome half without chrome)
  { name: 'test-resume-breaker', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (14s) — server' }, // transcript EXISTS under the fake HOME (the "known" case)
  { name: 'test-agentd-robustness', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (14s) — server' }, // M2 ROBUSTNESS e2e (docs/design-remote-cs.md M2): adversarial verification of the ssh-bridge + persistent pipe-session model under real-world stress — 1.…
  { name: 'test-sidebar-rail', tier: 'heavy', why: 'chrome — the fast tier never launches a browser (15s here; a browser leg\'s cost follows machine load)' }, // rail panels + process manager CDP battery (was manual-only and went silently stale — the 9-item assert was red for 12 releases; no rebuild: overlays the gate's own build; SKIPs without chrome)
  { name: 'test-sealed-orders', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (17s) — server' }, // SEALED-ORDERS emergency reflex (design §Pool management) vs a REAL daemon: the device executes a LOCAL pool fallback switch ONLY under the double condition (limit…
  { name: 'test-attach-rescue', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (19s) — chrome' }, // Attach-error view-only rescue smoke (2.217.0 — userL's 12 blank windows): BUG: after the server loses its sessions (OOM kill, pod recreation), every saved layout…
  { name: 'test-ui-scale', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (24s) — chrome' }, // UI scale (DPI) + UI font scale + locked-model-badge restyle smoke (2.257.0). - locked badge: SVG lock in currentColor on the accent pill (no more orange
  { name: 'test-remote-keeper', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (27s) — server' }, // E2E test for data/bin/vibespace-remote-keeper — the remote-side persistence layer for remote chat sessions (2.124.0). Simulates the local chat-wrapper's
  { name: 'test-codex-p2-wrapper', tier: 'heavy', why: 'slow (28s)' }, // codex P2 wrapper: queue-while-busy, slash commands + real compact, live MCP/web/image/compaction records — real wrapper vs stub app-server
  { name: 'test-opencode-plugin', tier: 'heavy', why: 'chrome — the fast tier never launches a browser (29s here; a browser leg\'s cost follows machine load)' }, // the OpenCode background service is a PLUGIN, default OFF (owner 2026-09-07): fresh instance spawns nothing, enable/replay/disable over HTTP on a real server, env override, and the first-use dialog in headless chrome (asked once, Enable resumes the pending action)
  { name: 'test-acp-harness', tier: 'heavy', why: 'slow, binary (33s)' }, // S8 generic ACP v1 harness: the REAL acp-wrapper against a mock ACP agent (initialize → session/new → prompt → tool_call → request_permission → cancel → load) + normalizer shapes + stdout consumer + wiring pins
  { name: 'test-toolbar-resize', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (36s) — chrome' }, // Toolbar-resize persistence smoke (2.252.1 — the 2.250.1 snap-back rootfix). The bug: cssDefault()/def read the COMPUTED --toolbar-height, which the drag
  { name: 'test-writer-sweep', tier: 'heavy', why: 'slow, binary (40s)' }, // ONE writer sweep, any machine (CS separation, 2.276.0). Before this, the sweep existed three times — ssh, dial, and NOT AT ALL for local — so a local resume of a…
  { name: 'test-chat-paging', tier: 'heavy', why: 'adopted 2026-09-07, was in NO runner (44s) — chrome' }, // Chat virtual-scroll paging stability (2026-07-30 user report: "翻页过程中会 往上跳一大截，往回翻也会意外跳跃"). Drives a REAL view-only ChatView over a synthetic 700-record transcript…
  { name: 'test-collab-live-counter', tier: 'heavy', why: 'chrome — the fast tier never launches a browser (53s here; a browser leg\'s cost follows machine load)' }, // the live sub-agent traffic readout (2026-09-07): the PURE composers (counts/pluralisation/age granularity/live vs frozen) + the normalizer's per-row record timestamps, then headless chrome — a REAL codex rollout opened read-only (frozen totals, nothing ticking, no encrypted blob in the DOM) and a LIVE codex chat session behind a stub app-server (head grows, age ticks, spinner switches and yields, everything freezes at turn end)
  { name: 'test-client-boot', tier: 'heavy', why: 'chrome — the fast tier never launches a browser (70s here; a browser leg\'s cost follows machine load)' }, // headless-chrome app boot (the FRONTEND face of 打不开; SKIPs without chrome)
  { name: 'test-jobs-engine', tier: 'heavy', why: 'slow (71s)' }, // Background Work ENGINE gate (real spawns in an isolated tmp dataDir — never the repo's production data/). Pins: spawn→adopt-by-stamp across engine generations…
  { name: 'test-desktop-resume-paging', tier: 'heavy', why: 'chrome — the fast tier never launches a browser (224s here; a browser leg\'s cost follows machine load)' }, // inc-mtq5bpjt-0o0n end-to-end: a PINNED window survives a real desktop switch on a real >34MB transcript (gap sentinel installed), incl. the input-less scrollTop→0 probes and the round-3 TRUSTED-input legs (a real click must NOT disarm the resume repair, a real wheel/scrollbar drag must), WITH a source-level negative control that rebuilds the bundle with the gates patched out (SKIPs without chrome; ~3.5 min, two chrome runs + two bundle builds)
];

// Suites that are in NEITHER tier, each with the reason it cannot be gated.
// This list is the census's escape hatch and it is deliberately uncomfortable
// to add to: an entry here is a suite nobody runs.
export const EXCLUDED = [
  { name: 'test-agentd-m3m4', why: 'RED on this checkout 2026-09-07 (6542ms) — fails "live claude lock reported; dead AND pid-reused locks filtered" (a real daemon-side assertion, not a missing resource). A debt WITH EVIDENCE, not a shrug: fix it, then move it into a tier' },
  { name: 'test-agentd-real-ssh', why: 'MANUAL: needs a REAL remote host — `node scripts/test-agentd-real-ssh.mjs <hostId>` (hostId from data/hosts.json; key auth + node on the host). No unattended runner can supply one' },
  { name: 'test-agentd-switchover', why: 'MANUAL: needs a REAL remote host id argument (same M2 family as test-agentd-real-ssh)' },
  { name: 'test-agents-overview', why: 'RED on this checkout 2026-09-07 (72s) — chrome; fails three asserts — water-level-coloured switcher percentages, the scoped bucket in the preview, and the login terminal opening. In no runner, so it rotted unseen: exactly what this census exists for. A debt WITH EVIDENCE, not a shrug: fix it, then move it into a tier' },
  { name: 'test-architecture', why: 'chained by `npm run build` — tier conformance AND this census itself, so it already runs in both tiers and in the in-app update' },
  { name: 'test-auto-graduate', why: 'RED on this checkout 2026-09-07 (26ms) — fails "requires an operator-declared URL and never self-publishes to the relay" — a pure assert, most likely superseded by the 2.367.0 instance-url rules and never re-read because nothing ran it. A debt WITH EVIDENCE, not a shrug: fix it, then move it into a tier' },
  { name: 'test-bundle-globals', why: 'chained by `npm run build` (client free-variable scan of the just-built bundle)' },
  { name: 'test-desktop-reorder', why: 'NOT RE-RUNNABLE on this checkout 2026-09-07 (chrome, 12s) — it passes on a clean run and FAILS on the immediately following one, deterministically: measured pass/fail/pass/fail over four consecutive runs (6 FAILED, "toolbar resize handle exists" + "--toolbar-scale drives the rendered toolbar size"). It boots chrome on a FIXED CDP port with no --user-data-dir, so run N+1 inherits run N. Never in the gate, so nothing ever ran it twice. A debt WITH EVIDENCE: give it a free port + its own profile, then move it into a tier' },
  { name: 'test-host-mounts', why: 'MANUAL: `node scripts/test-host-mounts.mjs <hostId> [publicHost]` — needs a real ssh host to mount from' },
  { name: 'test-host-mounts-tunnel', why: 'MANUAL: `node scripts/test-host-mounts-tunnel.mjs <hostId>` — needs a real ssh host for the tunnel leg' },
  { name: 'test-integration-toggle', why: 'RED on this checkout 2026-09-07 (6893ms) — fails "task-context delivers content while ON" (the server answers {"success":true,"context":""}). A debt WITH EVIDENCE, not a shrug: fix it, then move it into a tier' },
  { name: 'test-session-schema', why: 'chained by `npm run build` (the live-session `_field` registry)' },
  { name: 'test-stage-preview', why: 'CANNOT RUN on a shared machine (chrome, 7s) — it hard-codes PORT=3987 / CDP 9337 with no free-port fallback, so it fails "page threw: Error: no app" whenever anything else holds the port. Measured 2026-09-07: :3987 was held by an ORPHANED throwaway server from another checkout (pid 2840592, cwd /tmp/vs-boot-lex (deleted)) and the suite failed 3/3 while that process lived. A debt WITH EVIDENCE: adopt the freePort() helper test-client-boot already uses, then move it into a tier' },
  { name: 'test-sys-panel', why: 'RED on this checkout 2026-09-07 (15s) — chrome; fails "3 range chips". A debt WITH EVIDENCE, not a shrug: fix it, then move it into a tier' },
  { name: 'test-window-menu', why: 'RED on this checkout 2026-09-07 (chrome, ~4 min) — fails "menu has Rename" and "scope=all lists the non-overlapping terminal", then the harness itself throws (TypeError: reading \'click\' of undefined). NOTE: its first two runs died as "Command failed: npm run build" because it copies scripts/ onto a HEAD worktree and a build-time assert compared files it had not copied — that was OUR bug, fixed; this is the real failure. A debt WITH EVIDENCE: fix it, then move it into a tier' },
  { name: 'test-ws-contract', why: 'chained by `npm run build` (WS_CTX_CONTRACT ⇄ destructures ⇄ call site)' },
];

export const listSuiteFiles = (root = repo) =>
  fs.readdirSync(path.join(root, 'scripts')).filter((f) => /^test-.*\.mjs$/.test(f)).map((f) => f.replace(/\.mjs$/, '')).sort();

// PURE: the census over a name list (no I/O — test-architecture feeds it the
// same disk listing and asserts the same findings).
export function censusFindings(diskNames, suites = SUITES, excluded = EXCLUDED) {
  const disk = new Set(diskNames);
  const tierOf = new Map(), exclOf = new Map(), duplicated = [];
  for (const s of suites) { if (tierOf.has(s.name)) duplicated.push(s.name); tierOf.set(s.name, s.tier); }
  for (const e of excluded) { if (exclOf.has(e.name)) duplicated.push(e.name); exclOf.set(e.name, e.why); }
  return {
    counted: { fast: suites.filter((s) => s.tier === 'fast').length, heavy: suites.filter((s) => s.tier === 'heavy').length, excluded: excluded.length, disk: disk.size },
    unclassified: [...disk].filter((n) => !tierOf.has(n) && !exclOf.has(n)),
    inBoth: [...disk].filter((n) => tierOf.has(n) && exclOf.has(n)),
    duplicated,
    ghosts: [...new Set([...tierOf.keys(), ...exclOf.keys()])].filter((n) => !disk.has(n)),
    badTier: suites.filter((s) => s.tier !== 'fast' && s.tier !== 'heavy').map((s) => s.name),
    reasonless: [
      ...suites.filter((s) => s.tier === 'heavy' && !(s.why || '').trim()).map((s) => s.name),
      ...excluded.filter((e) => !(e.why || '').trim()).map((e) => e.name),
    ],
  };
}

// ── running one suite ────────────────────────────────────────────────────
// Headless-chrome suites boot a worktree server + a browser; on a box that is
// also running other agents' gates they legitimately take minutes (three
// load-only reds on 2026-09-06 at the flat 300s cap). A hang still fails —
// the budget is generous for the browser suites only, never removed. The
// heavy tier is unattended, so it can afford to wait longer than the fast one.
const budgetFor = (s) => (s.tier === 'fast' ? 300000 : /chrome/.test(s.why || '') ? 900000 : 600000);

// ONE runner for both tiers. `root` is the checkout the suite runs in — the
// repo for the fast tier and for a manual `npm run ci:heavy`, an isolated
// worktree at the pushed sha for a hook-launched heavy run (suites resolve
// their own repo root from their file location, so the WORKTREE's copy of the
// suite is what must be executed).
function runSuite(s, { root = repo } = {}) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', s.name + '.mjs')],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: budgetFor(s), encoding: 'utf-8', env: GIT_ENV });
  const ms = Date.now() - t;
  const stdout = r.stdout || '';
  if (r.status === 0) { console.log(`  ✓ ${s.name} (${ms}ms) — ${(stdout.trim().split('\n').pop() || 'ok').slice(0, 80)}`); return { ok: true, ms }; }
  console.log(`\n✗ ${s.name} FAILED (${ms}ms${r.error ? ', ' + r.error.code : ''})`);
  console.log(stdout.split('\n').slice(-40).join('\n'));
  console.log(r.stderr || '');
  return { ok: false, ms };
}

function runBuild({ cwd = repo, log = console.log } = {}) {
  const t = Date.now();
  const r = spawnSync('npm', ['run', 'build'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, encoding: 'utf-8', env: GIT_ENV });
  const ms = Date.now() - t;
  if (r.status === 0) { log(`  ✓ npm run build (${ms}ms)`); return { ok: true, ms }; }
  log(`\n✗ npm run build FAILED (${ms}ms)`);
  log((r.stdout || '').split('\n').slice(-40).join('\n'));
  log(r.stderr || '');
  return { ok: false, ms };
}

// ── heavy-run markers (data/ci-heavy/<sha>.{green,red,pid,log}) ───────────
const markerDir = (dir) => dir || path.join(repo, 'data', 'ci-heavy');
const shortSha = (s) => String(s || '').slice(0, 8);

function readMarkers(dir) {
  const d = markerDir(dir);
  let files = [];
  try { files = fs.readdirSync(d); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = /^([0-9a-f]{7,40})\.(green|red|pid)$/.exec(f);
    if (!m) continue;
    let rec = {};
    try { rec = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch {}
    out.push({ ...rec, sha: rec.sha || m[1], kind: m[2], file: path.join(d, f) });
  }
  return out.sort((a, b) => (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0));
}

const gitIn = (root, args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8', env: GIT_ENV });
  return r.status === 0 ? (r.stdout || '').trim() : null;
};
const gitOut = (args) => gitIn(repo, args);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A heavy run is IN FLIGHT when its pid file names a living process.
const inFlight = (dir) => readMarkers(dir).filter((m) => m.kind === 'pid' && m.pid && alive(m.pid));

/**
 * THE BLOCK RULE. A red heavy marker blocks the next push when its commit is
 * an ancestor of HEAD (i.e. this branch is built ON TOP of a known-red commit)
 * and no green heavy run for a DESCENDANT of it exists. Markers for commits
 * this repository no longer knows (amended/rebased away) are ignored — they
 * describe a history nobody is pushing.
 *
 * `repoRoot` is a PARAMETER, not this file's location: the ancestry question
 * belongs to whichever repository is being pushed (scripts/test-ci-gate.mjs
 * asks it of a throwaway repo with real commits — a rule about git history has
 * to be tested against real git history).
 */
export function heavyBlocker({ dir, head, repoRoot = repo } = {}) {
  const HEAD = head || gitIn(repoRoot, ['rev-parse', 'HEAD']);
  if (!HEAD) return null;
  const exists = (sha) => gitIn(repoRoot, ['cat-file', '-e', sha + '^{commit}']) !== null;
  const isAncestor = (a, b) => spawnSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', a, b], { env: GIT_ENV }).status === 0;
  const all = readMarkers(dir);
  const reds = all.filter((m) => m.kind === 'red' && exists(m.sha));
  // A PARTIAL green (`--only=…`) is not evidence that the tier passed, so it
  // can never clear a block — otherwise re-running one suite would unlock a
  // commit the rest of the tier never saw. A partial RED still blocks: a suite
  // really did fail on that commit.
  const greens = all.filter((m) => m.kind === 'green' && !m.partial && exists(m.sha));
  for (const red of reds) {
    if (!isAncestor(red.sha, HEAD)) continue;
    const cleared = greens.some((g) => g.sha !== red.sha && isAncestor(red.sha, g.sha) && isAncestor(g.sha, HEAD));
    if (!cleared) return red;
  }
  return null;
}

// Keep the last N results (with their logs). A red older than that stops
// blocking — deliberate: 30 heavy runs is far past the point where "fix it or
// bypass it" was the honest answer, and an unbounded directory of 10-minute
// logs is its own problem.
function pruneMarkers(dir, keep = 30) {
  const d = markerDir(dir);
  const results = readMarkers(dir).filter((m) => m.kind !== 'pid');
  for (const m of results.slice(keep)) {
    for (const ext of ['green', 'red', 'log', 'pid']) { try { fs.unlinkSync(path.join(d, `${m.sha}.${ext}`)); } catch {} }
  }
}

// ── modes ────────────────────────────────────────────────────────────────
function fastGate() {
  const t0 = Date.now();
  const fast = SUITES.filter((s) => s.tier === 'fast');
  console.log(`release gate — FAST tier: build + ${fast.length} suites (heavy tier: ${SUITES.filter((s) => s.tier === 'heavy').length} suites, runs after the push)`);
  if (!runBuild().ok) { console.error('\n✗ build FAILED — release gate is RED, do not push\n'); process.exit(1); }
  for (const s of fast) {
    if (!runSuite(s).ok) { console.error(`\n✗ ${s.name} — release gate is RED, do not push\n`); process.exit(1); }
  }
  console.log(`\nALL GREEN — fast gate passed in ${Math.round((Date.now() - t0) / 1000)}s`);
  writeGreenMarker();
}

// GREEN MARKER (2.369.51): the pre-push hook accepts a fresh marker for the
// EXACT tree instead of re-running the gate inside the SSH session (GitHub
// closes an idle connection before a long gate finishes). Only a CLEAN tree
// earns the marker — the sha must describe what was tested.
function writeGreenMarker() {
  try {
    const dirty = gitOut(['status', '--porcelain']);
    if (dirty === null) { console.log('[ci] green marker not written: git could not read this tree'); return; }
    if (dirty) { console.log('[ci] tree is dirty — no green marker (commit first, then re-run the gate)'); return; }
    const sha = gitOut(['rev-parse', 'HEAD']);
    const gitDir = gitOut(['rev-parse', '--git-dir']);
    if (!sha || !gitDir) { console.log('[ci] green marker not written: git could not name HEAD'); return; }
    fs.writeFileSync(path.resolve(repo, gitDir, 'ci-green'), `${sha} ${Date.now()}\n`);
    console.log(`[ci] green marker written for ${shortSha(sha)} — a push of this exact tree within 60 min skips the in-hook run`);
  } catch (e) { console.log('[ci] green marker not written: ' + e.message); }
}

function heavyGate({ sha: wantSha, isolate, dir, only }) {
  const t0 = Date.now();
  const all = SUITES.filter((s) => s.tier === 'heavy');
  // `--only=a,b` re-runs part of the tier (after a fix, or from the self-test).
  // An unknown name is LOUD: silently running zero suites and stamping a green
  // marker is the worst possible outcome of a typo.
  const heavy = only ? only.map((n) => {
    const hit = all.find((s) => s.name === n);
    if (!hit) { console.error(`✗ --only: '${n}' is not a heavy suite`); process.exit(2); }
    return hit;
  }) : all;
  const sha = wantSha || gitOut(['rev-parse', 'HEAD']);
  const d = markerDir(dir);
  const dirtyAtStart = isolate ? '' : gitOut(['status', '--porcelain']);
  let runRoot = repo, wt = null;
  console.log(`release gate — HEAVY tier: ${heavy.length} suites for ${shortSha(sha)}${isolate ? ' (isolated worktree)' : ''}`);
  try {
    if (isolate) {
      // The working tree keeps moving while a ten-minute run is in flight, so
      // a marker that NAMES a sha has to have tested that sha. A detached
      // worktree at the pushed commit is the honest subject (and keeps the
      // #127 law: never run server.js against the repo's PRODUCTION data/).
      // A previous run that was killed (reboot, SIGKILL) leaves a registration
      // behind; prune before adding so `git worktree list` stays honest.
      spawnSync('git', ['-C', repo, 'worktree', 'prune'], { env: GIT_ENV });
      wt = path.join(os.tmpdir(), `vs-ci-heavy-${shortSha(sha)}-${process.pid}`);
      const add = spawnSync('git', ['-C', repo, 'worktree', 'add', '--detach', wt, sha], { encoding: 'utf-8', env: GIT_ENV });
      if (add.status !== 0) throw new Error(`git worktree add failed: ${(add.stderr || '').trim()}`);
      try { fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules')); } catch {}
      runRoot = wt;
    }
    const build = runBuild({ cwd: runRoot });
    const failed = [], flaky = [], timings = [];
    if (!build.ok) failed.push('npm run build');
    else {
      for (const s of heavy) {
        let r = runSuite(s, { root: runRoot });
        if (!r.ok) {
          // RETRY ONCE. This tier's verdict BLOCKS the next push, and many of
          // these suites hard-code a port or a /tmp path — on a machine that
          // hosts several checkouts, one of them squatting :3987 is not a
          // regression in the code being pushed. A suite that fails and then
          // passes is recorded as FLAKY, not red: it does not block, and both
          // outcomes are in the log and in the marker, so the flakiness is
          // visible instead of being laundered into a green.
          console.log(`  … ${s.name} failed — retrying once before calling it red`);
          const again = runSuite(s, { root: runRoot });
          if (again.ok) { flaky.push(s.name); r = again; } else { failed.push(s.name); }
        }
        timings.push({ name: s.name, ms: r.ms, ok: r.ok });
      }
    }
    const rec = {
      sha, result: failed.length ? 'red' : 'green', failed,
      flaky: flaky.length ? flaky : undefined,
      startedAt: t0, endedAt: Date.now(), ms: Date.now() - t0,
      suites: heavy.length, isolated: !!isolate, host: os.hostname(),
      partial: only ? only.slice() : undefined,
      timings: timings.sort((a, b) => b.ms - a.ms).slice(0, 10),
    };
    // A marker is a CLAIM about a commit, so it is only written when the run
    // can honestly make it. Two refusals: a dirty in-place tree (the sha would
    // not describe what ran), and a PARTIAL run trying to overwrite a full
    // verdict (a `--only` re-run must not erase what the whole tier said).
    const existing = readMarkers(dir).find((m) => m.sha === sha && m.kind !== 'pid' && !m.partial);
    if (!isolate && dirtyAtStart) {
      console.log('\n[ci:heavy] tree was DIRTY — no marker written (the sha would not describe what ran)');
    } else if (only && existing) {
      console.log(`\n[ci:heavy] partial run — keeping the existing FULL ${existing.kind.toUpperCase()} marker for ${shortSha(sha)}`);
    } else {
      fs.mkdirSync(d, { recursive: true });
      for (const ext of ['green', 'red']) { try { fs.unlinkSync(path.join(d, `${sha}.${ext}`)); } catch {} }
      fs.writeFileSync(path.join(d, `${sha}.${rec.result}`), JSON.stringify(rec, null, 2) + '\n');
      pruneMarkers(dir);
    }
    console.log(failed.length
      ? `\nHEAVY GATE RED for ${shortSha(sha)} in ${Math.round(rec.ms / 1000)}s — failed: ${failed.join(', ')}`
      : `\nHEAVY GATE GREEN for ${shortSha(sha)} in ${Math.round(rec.ms / 1000)}s (${heavy.length} suites)`);
    if (flaky.length) console.log(`[ci:heavy] FLAKY (failed, passed on retry — not blocking, but they did fail once): ${flaky.join(', ')}`);
    return failed.length ? 1 : 0;
  } finally {
    try { fs.unlinkSync(path.join(d, `${sha}.pid`)); } catch {}
    if (wt) {
      try { spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt], { env: GIT_ENV }); } catch {}
      try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
      try { spawnSync('git', ['-C', repo, 'worktree', 'prune'], { env: GIT_ENV }); } catch {}
    }
  }
}

// DETACHED LAUNCH. No setsid/nohup dependency: node detaches its own child and
// unrefs it, so the hook returns immediately and the run survives the hook,
// the ssh session and the terminal. The child gets the SANITIZED git env —
// a pre-push hook exports GIT_DIR/GIT_INDEX_FILE and every heavy suite runs
// `git worktree add`. (The project's own detached-job primitive — jobs.js /
// data/bin/job-wrapper.js — needs a running server and a session token, so it
// is not reachable from a git hook.)
function heavyLaunch(sha, { dir, only } = {}) {
  const d = markerDir(dir);
  if (!sha || gitOut(['cat-file', '-e', sha + '^{commit}']) === null) { console.error(`[ci:heavy] not launching: ${sha ? 'unknown commit ' + shortSha(sha) : 'no sha given'}`); return 0; }
  const live = inFlight(dir).find((m) => m.sha === sha);
  if (live) { console.error(`[ci:heavy] already running for ${shortSha(sha)} (pid ${live.pid})`); return 0; }
  fs.mkdirSync(d, { recursive: true });
  const logPath = path.join(d, `${sha}.log`);
  const fd = fs.openSync(logPath, 'w');
  const args = [HERE, '--heavy', '--sha=' + sha, '--isolate', '--markers=' + d];
  if (only) args.push('--only=' + only.join(','));
  const child = spawn(process.execPath, args, { cwd: repo, detached: true, stdio: ['ignore', fd, fd], env: GIT_ENV });
  child.unref();
  fs.closeSync(fd);
  fs.writeFileSync(path.join(d, `${sha}.pid`), JSON.stringify({ sha, pid: child.pid, startedAt: Date.now() }) + '\n');
  console.error(`[ci:heavy] launched for ${shortSha(sha)} (pid ${child.pid}) — ${path.relative(repo, logPath)}; \`npm run ci:status\` for the verdict`);
  return 0;
}

function checkHeavy({ dir, head } = {}) {
  let blocker = null;
  try { blocker = heavyBlocker({ dir, head }); } catch (e) {
    // A broken checker must never silently block every push — but it must not
    // be silent either (§no-silent-failures).
    console.error(`[ci] WARNING: could not read the heavy-gate markers (${e.message}) — not blocking`);
    return 0;
  }
  if (!blocker) return 0;
  const when = blocker.endedAt ? new Date(blocker.endedAt).toLocaleString() : '?';
  console.error(`\n[ci] PUSH BLOCKED — the heavy tier went RED on ${shortSha(blocker.sha)} (${when}), which is an ancestor of HEAD.`);
  console.error(`     failed: ${(blocker.failed || []).join(', ') || '(no suite names recorded)'}`);
  console.error(`     log:    ${path.relative(repo, path.join(markerDir(dir), blocker.sha + '.log'))}`);
  console.error('     Fix it, then clear the block with a green heavy run on the new commit:');
  console.error('       npm run ci:heavy        (or wait for the next push\'s background run)');
  console.error('     Emergency bypass: VIBESPACE_SKIP_CI=1 git push\n');
  return 1;
}

function status({ dir, head: wantHead } = {}) {
  const all = readMarkers(dir);
  const results = all.filter((m) => m.kind !== 'pid');
  const running = inFlight(dir);
  const dur = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s` : `${Math.round(ms / 1000)}s`);
  console.log(`heavy gate results (${path.relative(repo, markerDir(dir)) || markerDir(dir)}):`);
  if (!results.length && !running.length) console.log('  (none yet — the next push launches one)');
  for (const m of running) console.log(`  ${shortSha(m.sha)}  RUNNING  started ${new Date(m.startedAt).toLocaleString()}  pid ${m.pid}`);
  for (const m of results.slice(0, 12)) {
    const detail = m.result === 'green' ? `${m.suites} suites` : 'failed: ' + (m.failed || []).join(', ');
    const marks = [m.partial ? `partial: ${m.partial.join(',')}` : '', (m.flaky || []).length ? `flaky: ${m.flaky.join(',')}` : ''].filter(Boolean).join('  ');
    console.log(`  ${shortSha(m.sha)}  ${m.result === 'green' ? 'GREEN' : 'RED  '}  ${dur(m.ms || 0).padStart(6)}  ${new Date(m.endedAt || 0).toLocaleString()}  ${detail}${marks ? '  [' + marks + ']' : ''}`);
  }
  const blocker = heavyBlocker({ dir, head: wantHead });
  const head = wantHead || gitOut(['rev-parse', 'HEAD']);
  console.log(blocker
    ? `\nHEAD ${shortSha(head)}: PUSH BLOCKED by the red run on ${shortSha(blocker.sha)} (${(blocker.failed || []).join(', ')})`
    : `\nHEAD ${shortSha(head)}: not blocked`);
  return 0;
}

function census() {
  const f = censusFindings(listSuiteFiles());
  const problems = [];
  if (f.unclassified.length) problems.push(`${f.unclassified.length} suite(s) in NO tier and NOT excluded: ${f.unclassified.join(', ')}`);
  if (f.inBoth.length) problems.push(`in a tier AND excluded: ${f.inBoth.join(', ')}`);
  if (f.duplicated.length) problems.push(`listed twice: ${f.duplicated.join(', ')}`);
  if (f.ghosts.length) problems.push(`listed but no scripts/<name>.mjs: ${f.ghosts.join(', ')}`);
  if (f.badTier.length) problems.push(`tier is neither fast nor heavy: ${f.badTier.join(', ')}`);
  if (f.reasonless.length) problems.push(`heavy/excluded without a stated reason: ${f.reasonless.join(', ')}`);
  console.log(`census: ${f.counted.disk} suites on disk = ${f.counted.fast} fast + ${f.counted.heavy} heavy + ${f.counted.excluded} excluded`);
  for (const p of problems) console.error('  ✗ ' + p);
  if (!problems.length) console.log('  ✓ every scripts/test-*.mjs is in exactly one tier or excluded with a reason');
  return problems.length ? 1 : 0;
}

function main(argv) {
  const arg = (name) => { const hit = argv.find((a) => a === '--' + name || a.startsWith('--' + name + '=')); return hit === undefined ? undefined : (hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true); };
  const str = (name) => (typeof arg(name) === 'string' ? arg(name) : null);
  // Ops flags (all modes): --markers=<dir> where the heavy results live,
  // --head=<sha> which commit the verdict is about, --only=a,b a subset of the
  // heavy tier. They exist so the gate can be pointed at a throwaway
  // repository/marker dir — a rule about git ancestry has to be testable
  // against real git history, not a mock.
  const dir = str('markers') ? path.resolve(str('markers')) : undefined;
  const head = str('head') || undefined;
  const only = str('only') ? str('only').split(',').map((x) => x.trim()).filter(Boolean) : null;
  if (arg('census')) process.exit(census());
  if (arg('status')) process.exit(status({ dir, head }));
  if (arg('check-heavy')) process.exit(checkHeavy({ dir, head }));
  if (arg('heavy-launch') !== undefined) process.exit(heavyLaunch(str('heavy-launch') || argv[argv.indexOf('--heavy-launch') + 1], { dir, only }));
  if (arg('heavy')) process.exit(heavyGate({ sha: str('sha'), isolate: !!arg('isolate'), dir, only }));
  fastGate();
}

// Only run when EXECUTED — test-architecture imports the tier table.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2));
