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
// called first by the hook, ONCE PER PUSHED REF — the question is about the
// commits being published, not about whichever branch happens to be checked
// out) until a newer green run descends from it or the operator uses the
// existing VIBESPACE_SKIP_CI=1 bypass. That is the honest trade: the fast tier
// proves the push is not obviously broken, the heavy tier proves it is
// actually good, and nothing rides on top of a known-red commit.
//
// ONE HEAVY TIER PER MACHINE (2026-09-07 round 2). Two heavy runs on one box
// double the load the suites' budgets were measured under, and until 2.369.76
// the heavy suites also claimed machine-global names (fixed ports, fixed /tmp
// checkouts) so two runs DESTROYED each other and the loser wrote a red that
// blocked the next push. The names are gone (scripts/scratch.mjs — per-pid
// paths, free ports; test-ci-gate §6 scans BOTH tiers for the fixed shapes,
// because the 40ad936d red came from a VERIFIER AGENT running one suite from
// its own checkout, which no lock covers); the lock stays for the load. Two
// mechanisms keep the tier serial, and both are needed because this box hosts
// ~160 checkouts of this repository driven by parallel agents:
//   · the LAUNCHER supersedes: a run in flight for an ANCESTOR of the sha
//     being pushed is killed, because the newer commit subsumes it and its
//     half-finished verdict is worthless. A run for the same sha is refused;
//     anything else is launched and queues (below).
//   · the RUN takes an exclusive MACHINE lock (literal `/tmp`, per uid —
//     NEVER os.tmpdir(), which follows TMPDIR and would name a process
//     environment rather than a machine; see defaultLockPath) for its
//     whole duration and waits — bounded — for its turn. Timing out writes NO
//     verdict and says so (a run that never happened must not look like one),
//     and a stale lock whose holder is gone is stolen.
// A marker is a claim about a commit; every path that cannot honestly make one
// refuses UP FRONT (a dirty in-place tree) or says NO VERDICT WRITTEN at the
// end. "HEAVY GATE GREEN" is never printed for a run nobody recorded.
//
// EVERY suite under scripts/test-*.mjs is in exactly one tier or in EXCLUDED
// with a reason — asserted by `--census` (and by test-architecture, so it runs
// inside `npm run build`). Before the split, 99 of the 184 suites on disk were
// in NO list at all: they neither ran nor were they written down anywhere.
//
// THE TABLE IS THIS GATE'S, THE SUITE SOURCES ARE THE GATED COMMIT'S (round 6).
// Every isolated run — the whole heavy tier, and a fast run for a pushed tip
// that is not HEAD — gates a commit that may not contain every name in the
// table above. That is an ABSENCE, not a failing suite: it is skipped LOUDLY,
// counted, named in the closing line and recorded in the marker (`absent`), and
// a run in which EVERY suite was absent claims nothing at all. See runSuite.
//
// Modes:
//   node scripts/ci.mjs                  the FAST gate (+ .git/ci-green marker)
//   node scripts/ci.mjs --isolate --sha=<x>  the FAST gate in a scratch
//                                        worktree AT <x> — what the hook runs
//                                        when a pushed ref's tip is not the
//                                        commit you have checked out (no
//                                        marker: it did not gate your tree)
//   node scripts/ci.mjs --heavy --isolate   the HEAVY tier at HEAD, in its own
//                                        worktree (this is `npm run ci:heavy`,
//                                        the command a blocked push is told to
//                                        run — it always earns a marker)
//   node scripts/ci.mjs --heavy          the HEAVY tier against THIS tree; only
//                                        a clean tree can earn a marker, so a
//                                        dirty one is refused up front (exit 2)
//                                        unless --dirty-ok says "no verdict, run
//                                        it anyway"
//   node scripts/ci.mjs --heavy-launch <sha>   detach a heavy run for <sha>
//   node scripts/ci.mjs --check-heavy    exit 1 if a red heavy blocks a push
//   node scripts/ci.mjs --status         last heavy result per sha
//   node scripts/ci.mjs --census         the tier census self-test
// Ops flags: --markers=<dir> (where heavy results live), --head=<sha> (which
// commit the verdict is about), --only=a,b (a subset of the heavy tier, e.g.
// re-running one suite after a fix; an unknown name is a loud exit 2),
// --lock=<file> + --lock-wait-ms=<n> (the machine lock — a test drives its own
// so it never contends with, or waits for, a real heavy run).
// Exit codes: 0 green · 1 red · 2 refused (dirty tree / bad --only) · 3 the
// tier did not run (never got the machine lock) · 4 ABORTED (superseded, the
// lock taken, or terminated from outside — it stopped mid-tier). 0 and 1 are
// the only VERDICTS; 2/3/4 all mean "no verdict was written", and none of them
// may ever be 0, because the Actions heavy job's only signal is the exit code.
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
  { name: 'test-spend-paths', tier: 'fast' }, // THE SPEND CEILING (design-account-hardening §4.4c/P9 + D2/D3/D6/D8): the grep-derived census of every producer that can start a turn nobody typed, the persisted per-identity budget, overage, the EDF reserve floor and the four fail-closed sites. 0.6s, no ports, no fixed /tmp path
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
  { name: 'test-new-member-wake', tier: 'fast' }, // a member that BECOMES usable (login success / human ⟳) re-drives the pool and releases the conversations armed on exhaustion: the 2026-09-08 incident replayed on the real engine + real pool + real symlinks + real auto-resume, each half of the wake proven load-bearing on its own, the polled routes' fingerprint gate measured with the engine floor wound back, and the breaker/cap/quarantine proven still in force
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
  // ── integrated 2.369.72 (suites master added while the split branch was open; all HEAVY: chrome / real serve / real wrapper / >10 s) ──
  { name: 'test-init-frame', tier: 'heavy', why: 'chrome + binary: headless 375×667 census of the status-bar panels + a dump of the installed CLI (2s here with the chrome legs skipped)' },
  { name: 'test-opencode-remote', tier: 'heavy', why: 'binary + slow: the shipped ssh op script over real child processes (21s)' },
  { name: 'test-opencode-s9', tier: 'heavy', why: 'server + chrome: real opencode serve + headless chrome + real processes (227s)' },
  { name: 'test-permission-rules', tier: 'heavy', why: 'cli: the real chat-wrapper stdin verb + local oracles (strace + real CLIs when present) (10s)' },
  { name: 'test-readings-attribution', tier: 'heavy', why: 'chrome: real engine/pool/symlinks + the headless §10 panel legs (3s here with chrome skipped)' },
  { name: 'test-turn-truth-ui', tier: 'heavy', why: 'chrome: a live ChatView in headless chrome + the real stdout consumer (9s)' },
  { name: 'test-worktree-userchan-ui', tier: 'heavy', why: 'chrome: headless chrome + the LIVE_SESSION_FACTS drift guard (4s here with chrome skipped)' },
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

// MACHINE-GLOBAL FIXTURES (2026-09-07 round 2). A suite that claims a name the
// whole BOX shares — a literal port it binds, a fixed /tmp path it creates,
// removes or checks a worktree into — cannot survive a second run of anything.
// In the heavy tier that is contained by the machine lock; in the FAST tier it
// is not, because the fast tier is fail-fast, has no retry and blocks the push
// directly, so one squatter from any of this box's ~160 checkouts turns a
// perfectly good push red. (Measured on the code this replaced: with a plain
// listener on :3991, the pre-fix test-attach-ack — which the fast tier reached
// through the launcher self-test's slice — hung 240 s to its budget; with the
// free port it passes in 2 s under the same squatter.) PURE so the rule can be
// asserted over every fast suite with the pre-fix shapes as negative controls.
//
// It is deliberately narrow: a port DERIVED from freePort()/env is not a claim,
// and a /tmp string that is only ever a fixture VALUE (a `cwd` inside a fake
// record) creates nothing. What counts is a literal that reaches an ACT.
const FIXTURE_ACTS = /(worktree|mkdirSync|mkdtempSync|rmSync|rmdirSync|unlinkSync|writeFileSync|symlinkSync|cpSync|createServer|\.listen\(|spawn|exec(?:Sync|File|FileSync)?\(|rm -rf|cp -r)/;

// A COMMENT BINDS NOTHING. Found the moment §6 first ran: the comment in
// test-ci-gate explaining "a verbatim `const PORT = 3991` control made the
// suite report itself" made the suite report itself. Line-wise on purpose —
// string state resets at every newline, so a regex literal carrying a quote
// (`/['"]/`) can at worst mis-scan its OWN line instead of eating the file;
// block-comment state is the only thing carried across lines.
function stripComments(src) {
  let inBlock = false;
  return src.split('\n').map((line) => {
    let out = '', quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i], n = line[i + 1];
      if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
      if (quote) { out += c; if (c === '\\') { out += n === undefined ? '' : n; i++; } else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
      if (c === '/' && n === '/') break;
      if (c === '/' && n === '*') { inBlock = true; i++; continue; }
      out += c;
    }
    return out;
  }).join('\n');
}

export function machineGlobalFixtures(source) {
  const ports = new Set(), paths = new Set();
  const src = stripComments(source);
  const lines = src.split('\n');
  const port = (v) => { const n = Number(v); if (n > 0 && n <= 65535) ports.add(n); };
  // (a) a literal that IS the port: `const PORT = 3991`, `const TARGET_PORT =
  //     18941`, `.listen(3991`. Uppercase-only for the name form — a lowercase
  //     `port: 3456` passed to a factory binds nothing, and flagging it would
  //     buy an allowlist, which is where rules go to rot.
  for (const m of src.matchAll(/(?:(?:\b(?:const|let|var)\s+|,\s*)[A-Z0-9_]*PORT[A-Z0-9_]*\s*=\s*|\.listen\(\s*)(\d{2,5})\b/g)) port(m[1]);
  // (b) a literal BOUND TO A NAME that is later listened on / handed to a
  //     child as PORT (`const P = 3991` … `spawn(…, { PORT: String(P) })`).
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(\d{2,5})\b/g)) {
    const [, name, n] = m;
    const bound = new RegExp(`(?:\\.listen\\(\\s*|PORT\\s*:\\s*(?:String\\(\\s*)?)${name.replace(/\$/g, '\\$')}\\b`);
    if (bound.test(src)) port(n);
  }
  // (a) a complete /tmp literal used on a line that acts on the filesystem
  for (const line of lines) {
    for (const m of line.matchAll(/(['"`])(\/tmp\/[A-Za-z0-9._/-]+)\1/g)) {
      if (/^\s*\+/.test(line.slice(m.index + m[0].length))) continue; // concatenated with something unique
      if (FIXTURE_ACTS.test(line)) paths.add(m[2]);
    }
  }
  // (b) a complete /tmp literal BOUND TO A NAME whose name later reaches one
  //     (`const wt = '/tmp/vs-ack-smoke'` … `git worktree add ${wt}`)
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])(\/tmp\/[A-Za-z0-9._/-]+)\2/g)) {
    const [, name, , p] = m;
    const used = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);
    if (lines.some((line) => used.test(line) && FIXTURE_ACTS.test(line))) paths.add(p);
  }
  return { ports: [...ports], paths: [...paths] };
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
// A child that died on a SIGNAL somebody SENT to this run was killed from
// OUTSIDE — the launcher superseding our whole process group, an operator, or
// a supervisor shutting us down. That is not a fact about the code under test,
// and heavyGate uses it to refuse a verdict.
//
// SO THE SIGNAL LIST IS AN ALLOWLIST, NOT "ANY SIGNAL" (round 4 finding). A
// crash signal is a FACT ABOUT THE CODE UNDER TEST and must be RED — measured
// on this box, both of the ways a suite dies of memory look like a signal:
//   · a V8 heap-limit OOM   ⇒ {status:null, signal:'SIGABRT'}  (FATAL ERROR:
//     Reached heap limit — V8 calls abort() itself)
//   · the kernel OOM killer ⇒ {status:null, signal:'SIGKILL'}  (external
//     memory: RSS grows outside the heap cap and the kernel takes it)
//   · a native crash        ⇒ SIGSEGV / SIGBUS / SIGILL / SIGFPE
// Reading any of those as "somebody superseded us" made the tier ABANDON at
// that suite, skip every suite after it, write NO marker and exit 0 — so the
// Actions heavy job (whose signal IS the exit code, `--heavy --dirty-ok`)
// showed a GREEN tick for a tier that crashed and ran nothing else, and
// locally nothing blocked the next push. SIGKILL is deliberately on the RED
// side even though an operator's `kill -9` lands there too: the two are
// indistinguishable from here, and the costs are not symmetrical — a wrong RED
// blocks one push and is cleared by re-running `npm run ci:heavy`, a wrong
// "abandoned" is a silent green for a tier that never ran.
//
// Supersession sends SIGTERM (`process.kill(-pid, 'SIGTERM')` in heavyLaunch),
// Ctrl-C sends SIGINT and a lost terminal sends SIGHUP; those three are the
// whole outside set. Our OWN budget kill is excluded by name inside it:
// spawnSync reports ETIMEDOUT for that one (measured: {signal:'SIGTERM',
// error:{code:'ETIMEDOUT'}}), and a hung suite IS a red.
export const OUTSIDE_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
export const killedFromOutside = (r) => !!(r && r.signal && OUTSIDE_SIGNALS.includes(r.signal) && !(r.error && r.error.code === 'ETIMEDOUT'));

// A SUITE THE GATED COMMIT DOES NOT CONTAIN IS AN ABSENCE, NOT A RED (round
// 6). Both tiers take the suite TABLE from the ci.mjs that is RUNNING and the
// suite SOURCES from the commit being gated, and those are two different
// commits whenever `--isolate --sha=<x>` is used (the fast tier's non-HEAD
// push, every heavy run). A name the running table has and the gated commit
// does not is not a failing suite — there is nothing there to fail. Before
// this, `node <scratch>/scripts/<name>.mjs` exited MODULE_NOT_FOUND ⇒ RED ⇒
// the push was hard-blocked, and the fast tier is fail-fast so it stopped
// there. Reproduced with the real module against real history: `--isolate
// --sha=<master's tip>` died on test-ci-gate ("Cannot find module
// /tmp/vs-ci-fast-5d54ffe5-861442/scripts/test-ci-gate.mjs") after 51 green
// suites, and 5d54ffe5 is missing exactly the 2 fast suites this branch adds —
// so once this gate is integrated, EVERY branch and tag that predates it is
// unpushable. Measured across this repository: master's tip 2 of 73 fast
// suites absent, master~300 42 of 73, the v2.30.0 tag all 73.
//   It is scoped to `absentIsSkip` (i.e. to an isolated run) ON PURPOSE: for an
// in-place run the table and the tree come from the same checkout, so a
// missing file means THIS tree disagrees with its own table — a red, and one
// `--census` already reports as a ghost inside `npm run build`.
function runSuite(s, { root = repo, absentIsSkip = false, sha = '' } = {}) {
  if (absentIsSkip && !fs.existsSync(path.join(root, 'scripts', s.name + '.mjs'))) {
    console.log(`  ⊘ ${s.name} — SKIPPED: not present at ${shortSha(sha)} (this gate's table names it; the commit being gated does not contain it, so this run says nothing about it)`);
    return { ok: true, ms: 0, absent: true };
  }
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', s.name + '.mjs')],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: budgetFor(s), encoding: 'utf-8', env: GIT_ENV });
  const ms = Date.now() - t;
  const stdout = r.stdout || '';
  if (r.status === 0) { console.log(`  ✓ ${s.name} (${ms}ms) — ${(stdout.trim().split('\n').pop() || 'ok').slice(0, 80)}`); return { ok: true, ms }; }
  console.log(`\n✗ ${s.name} FAILED (${ms}ms${r.error ? ', ' + r.error.code : ''}${r.signal ? ', ' + r.signal : ''})`);
  console.log(stdout.split('\n').slice(-40).join('\n'));
  console.log(r.stderr || '');
  return { ok: false, ms, killedFromOutside: killedFromOutside(r) };
}

function runBuild({ cwd = repo, log = console.log } = {}) {
  const t = Date.now();
  const r = spawnSync('npm', ['run', 'build'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, encoding: 'utf-8', env: GIT_ENV });
  const ms = Date.now() - t;
  if (r.status === 0) { log(`  ✓ npm run build (${ms}ms)`); return { ok: true, ms }; }
  log(`\n✗ npm run build FAILED (${ms}ms${r.signal ? ', ' + r.signal : ''})`);
  log((r.stdout || '').split('\n').slice(-40).join('\n'));
  log(r.stderr || '');
  return { ok: false, ms, killedFromOutside: killedFromOutside(r) };
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
    const m = /^([0-9a-f]{7,40})\.(green|red|pid|skipped)$/.exec(f);
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
// EPERM means the process EXISTS and belongs to somebody else — the one answer
// this predicate must not report as "gone", because the caller's next move is
// to steal its lock or supersede its run.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// PID IDENTITY. A pid outlives nothing and gets recycled; a stale pid file
// naming a reused number would either block every future launch ("already
// running") or make a lock unstealable. So a record that NAMED what it started
// must still name it — `cmd` is a fragment of the child's own argv, compared
// against /proc. A record that does not say (an older file, one written by
// hand in a test) is trusted as before: unknown is not the same as wrong.
const pidCmdline = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { return null; } };
function pidStillRunning(rec) {
  if (!rec || !rec.pid || !alive(rec.pid)) return false;
  if (!rec.cmd) return true;
  const cur = pidCmdline(rec.pid);
  if (cur === null) return true; // no /proc (or no permission): cannot tell ⇒ trust
  return cur.includes(rec.cmd);
}

// KILLING NEEDS POSITIVE EVIDENCE, READING DOES NOT. `pidStillRunning` trusts a
// record that does not name what it started, because the cost of being wrong is
// a launch we refuse. Superseding SIGTERMs a process GROUP, so the cost of
// being wrong there is somebody else's work — a recycled pid, or a pid file an
// older ci.mjs wrote without a `cmd`. So this asks /proc directly and answers
// NO when it cannot tell (no /proc, no permission): the run then simply queues
// on the machine lock, which is the correct outcome, just slower. This is the
// cli-identity rule in miniature — identify the process by what it IS running.
function looksLikeHeavyRun(pid) {
  const cur = pidCmdline(pid);
  if (cur === null) return false;
  // `--heavy` exactly, not `--heavy-launch`: the launcher is a short-lived
  // process that never appears in a pid file, and `\b` would match it.
  return /(^|[/\s])ci\.mjs(\s|$)/.test(cur) && /--heavy(\s|$)/.test(cur);
}

// A heavy run is IN FLIGHT when its pid file names a living process that is
// still the run it claims to be.
const inFlight = (dir) => readMarkers(dir).filter((m) => m.kind === 'pid' && m.pid && pidStillRunning(m));

// ── THE MACHINE LOCK ─────────────────────────────────────────────────────
// The heavy suites claim machine-global names (test-attach-ack USED to bind
// :3991 and check a worktree out at a fixed /tmp path it force-removed first —
// fixed at the source because it was the destructive one; three more suites
// still share that port and four share :3989, and the lock is what keeps THEM
// from meeting). Two heavy runs on one box therefore
// delete each other's checkouts and steal each other's ports, and the loser
// writes a RED that blocks the next push — a false verdict the retry-once
// absorber cannot rescue, because the competing run holds the fixture for its
// whole 16 minutes. The lock is per MACHINE (os.tmpdir()) and not per checkout
// because the resources are: this box hosts ~160 worktrees of this repository.
// Per uid, so two users never fight over one file they cannot unlink.
// The lock's PATH has to be a machine name, and `os.tmpdir()` is not one — it
// follows TMPDIR/TMP/TEMP, so two agents with different TMPDIRs would each take
// "the machine lock" and neither would wait. The resources being protected do
// not move with TMPDIR (a bound port is machine-global, and the /tmp checkouts
// the suites claim are literal `/tmp` strings), so the lock lives at literal
// /tmp wherever that exists, and falls back to os.tmpdir() only where it does
// not. Exported so the gate's own gate can prove TMPDIR does not move it.
export function machineTmpDir() {
  try { if (process.platform !== 'win32' && fs.statSync('/tmp').isDirectory()) return '/tmp'; } catch { }
  return os.tmpdir();
}
export const defaultLockPath = () => path.join(machineTmpDir(), `vibespace-ci-heavy-${typeof process.getuid === 'function' ? process.getuid() : 'u'}.lock`);
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/**
 * Take the machine's heavy-tier lock, waiting up to `waitMs` for the current
 * holder. Returns {ok:true, release()} · {ok:false, timedOut, holder} · or
 * {ok:false, error} when a lock cannot be used at all (read-only tmp) — the
 * caller then runs UNLOCKED and says so in the marker, because a lock that
 * cannot be taken must never be able to stop the gate from running.
 */
function acquireMachineLock(lockPath, { waitMs, sha, onWait } = {}) {
  const deadline = Date.now() + Math.max(0, waitMs || 0);
  let announced = false;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, sha, root: repo, cmd: 'ci.mjs', startedAt: Date.now() }) + '\n');
      fs.closeSync(fd);
      return {
        ok: true,
        path: lockPath,
        release() { const cur = readJson(lockPath); if (!cur || cur.pid === process.pid) { try { fs.unlinkSync(lockPath); } catch { } } },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, error: e };
      const holder = readJson(lockPath);
      // A holder that is gone (reboot, SIGKILL, recycled pid) leaves a file
      // behind; stealing it is the only way the tier ever runs again.
      if (!pidStillRunning(holder)) { try { fs.unlinkSync(lockPath); continue; } catch { /* someone else won the race — loop */ } }
      if (Date.now() >= deadline) return { ok: false, timedOut: true, holder };
      if (!announced && onWait) { announced = true; onWait(holder); }
      sleepSync(3000);
    }
  }
}

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
    for (const ext of ['green', 'red', 'skipped', 'log', 'pid']) { try { fs.unlinkSync(path.join(d, `${m.sha}.${ext}`)); } catch {} }
  }
}

// ── the scratch worktree, ONE implementation for both tiers ──────────────
// The working tree keeps moving under a run, and a verdict that NAMES a sha
// has to have tested that sha. The heavy tier has always run this way; the
// fast tier does it when a pushed ref's tip is not the commit you have checked
// out (round 5). Also keeps the #127 law: never run server.js against the
// repo's PRODUCTION data/. The name carries the pid, so `scripts/dbg-ci-
// mutations.mjs --reap-only` can tell a live run's scratch from litter, and a
// previous run that was SIGKILLed leaves a registration behind — prune before
// adding so `git worktree list` stays honest.
function addScratchWorktree(sha, tag) {
  spawnSync('git', ['-C', repo, 'worktree', 'prune'], { env: GIT_ENV });
  const wt = path.join(os.tmpdir(), `vs-ci-${tag}-${shortSha(sha)}-${process.pid}`);
  const add = spawnSync('git', ['-C', repo, 'worktree', 'add', '--detach', wt, sha], { encoding: 'utf-8', env: GIT_ENV });
  if (add.status !== 0) throw new Error(`git worktree add failed: ${(add.stderr || '').trim()}`);
  try { fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules')); } catch {}
  return wt;
}
function removeScratchWorktree(wt) {
  try { spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt], { env: GIT_ENV }); } catch {}
  try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
  try { spawnSync('git', ['-C', repo, 'worktree', 'prune'], { env: GIT_ENV }); } catch {}
}

// ── modes ────────────────────────────────────────────────────────────────
/**
 * THE FAST TIER. `isolate` runs it in a scratch worktree at `sha` instead of
 * against this working tree — INVARIANT ⑭ ("the verdict is about the refs
 * being PUSHED") reaching the last place in the hook that had not heard it.
 * Reproduced before the fix: standing on `main` and pushing a branch whose tip
 * adds src/broken.js, the tier ran in a tree that did not contain that file
 * and printed ALL GREEN. The closing line now NAMES its subject either way, so
 * "ALL GREEN" can never again be a sentence about a tree nobody is publishing.
 */
function fastGate({ sha: wantSha, isolate } = {}) {
  const t0 = Date.now();
  const fast = SUITES.filter((s) => s.tier === 'fast');
  const sha = wantSha || gitOut(['rev-parse', 'HEAD']);
  let runRoot = repo, wt = null, cleaned = false;
  const cleanup = () => { if (cleaned || !wt) return; cleaned = true; removeScratchWorktree(wt); };
  // A killed run must not leave a checkout in /tmp and a registration `git
  // worktree prune` can never remove (⑯). `finally` covers the ordinary exits
  // below; these cover the Ctrl-C a person aims at a push. Deliberately NOT
  // heavyGate's `for (const sig of ['SIGTERM', …]) {` spelling — one set, one
  // name (OUTSIDE_SIGNALS), and the two mutation anchors stay distinct.
  if (isolate) for (const sig of OUTSIDE_SIGNALS) process.on(sig, () => { console.error(`\n[ci] ${sig} — cleaning up the scratch worktree for ${shortSha(sha)}`); cleanup(); process.exit(143); });
  try {
    if (isolate) { wt = addScratchWorktree(sha, 'fast'); runRoot = wt; }
    console.log(`release gate — FAST tier: build + ${fast.length} suites (heavy tier: ${SUITES.filter((s) => s.tier === 'heavy').length} suites, runs after the push)${isolate ? ` — ISOLATED worktree at ${shortSha(sha)}` : ''}`);
    if (!runBuild({ cwd: runRoot }).ok) { console.error('\n✗ build FAILED — release gate is RED, do not push\n'); return 1; }
    const absent = [];
    for (const s of fast) {
      const r = runSuite(s, { root: runRoot, absentIsSkip: !!isolate, sha });
      if (r.absent) { absent.push(s.name); continue; }
      if (!r.ok) { console.error(`\n✗ ${s.name} — release gate is RED, do not push\n`); return 1; }
    }
    // NOTHING RAN IS NOT A PASS. An old tag or a commit that predates the gate
    // contains none of these suites (measured: v2.30.0 ⇒ 73 of 73 absent), and
    // "ALL GREEN" for a run of zero suites is the vacuous green the `--only`
    // typo guard already refuses elsewhere. It does NOT block the push — an
    // absence is not evidence of breakage, and blocking every old ref is the
    // defect this round is fixing — it just refuses to claim anything.
    if (absent.length === fast.length) {
      console.log(`\nNO VERDICT — the fast tier could not gate ${shortSha(sha)}: none of its ${fast.length} suites exist at that commit (an old tag, or a commit that predates them). Nothing ran, so nothing is claimed; the push is not blocked by an absence.`);
      return 0;
    }
    const ran = fast.length - absent.length;
    const subject = isolate ? `for ${shortSha(sha)} (isolated worktree at the commit being pushed)` : '(this working tree)';
    console.log(`\nALL GREEN — fast gate passed in ${Math.round((Date.now() - t0) / 1000)}s ${subject}${absent.length ? ` — ${ran} of ${fast.length} suites ran; ${absent.length} not present at that commit` : ''}`);
    if (absent.length) console.log(`[ci] SKIPPED (absent at ${shortSha(sha)}, not run and not judged): ${absent.join(', ')}`);
    // The marker's contract is "HEAD, clean, passed", so an isolated run at
    // some other commit must not write one — it proves nothing about the tree
    // the next push would skip the tier for (⑫: say so, do not go quiet).
    if (isolate) console.log(`[ci] green marker not written: this run gated ${shortSha(sha)} in a scratch worktree, not the tree you have checked out`);
    else writeGreenMarker();
    return 0;
  } finally { cleanup(); }
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

function heavyGate({ sha: wantSha, isolate, dir, only, dirtyOk, lock, lockWaitMs, pidFile }) {
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
  // REFUSE UP FRONT, NOT AT THE END. This decision is made at t=0 and it
  // decides whether the run can produce a verdict at all; announcing it after
  // sixteen minutes — under a closing line that said GREEN — cost a blocked
  // developer the whole tier and left them just as blocked (round 2 finding).
  // `npm run ci:heavy` now passes --isolate, so the command a blocked push is
  // told to run always earns a marker; --dirty-ok is the deliberate "run it
  // against my working tree, I know there will be no verdict".
  const dirtyAtStart = isolate ? '' : gitOut(['status', '--porcelain']);
  if (dirtyAtStart && !dirtyOk) {
    console.error('\n[ci:heavy] REFUSED — this tree is DIRTY, so a marker for ' + shortSha(sha) + ' would not describe what ran.');
    console.error('  Commit first, or:');
    console.error('    npm run ci:heavy               runs the tier in an isolated worktree at HEAD (writes the marker)');
    console.error('    node scripts/ci.mjs --heavy --dirty-ok   runs it against this tree, NO verdict written\n');
    return 2;
  }
  let runRoot = repo, wt = null;
  console.log(`release gate — HEAVY tier: ${heavy.length} suites for ${shortSha(sha)}${isolate ? ' (isolated worktree)' : ''}`);
  if (dirtyAtStart) console.log('[ci:heavy] --dirty-ok: this tree is dirty ⇒ NO VERDICT will be written for ' + shortSha(sha) + ' (said now, not in sixteen minutes)');

  // ONE HEAVY TIER PER MACHINE. Wait for our turn before spending a build.
  const lockPath = lock || defaultLockPath();
  const waitMs = lockWaitMs === undefined ? 40 * 60 * 1000 : lockWaitMs;
  const held = acquireMachineLock(lockPath, {
    waitMs, sha,
    onWait: (h) => console.log(`[ci:heavy] another heavy run holds ${lockPath} (pid ${h && h.pid}, ${h && h.sha ? shortSha(h.sha) : '?'}) — waiting up to ${Math.round(waitMs / 60000)} min for the machine (the suites share ports and /tmp checkouts)`),
  });
  if (!held.ok && held.timedOut) {
    // NOT a verdict. Nothing ran, so nothing is claimed — the note exists so
    // `ci:status` can say "this commit has no heavy run" out loud instead of
    // looking identical to "nobody has pushed lately".
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${sha}.skipped`), JSON.stringify({ sha, result: 'skipped', reason: 'machine lock held by another heavy run', holder: held.holder || null, endedAt: Date.now(), ms: Date.now() - t0 }, null, 2) + '\n');
    } catch { }
    console.error(`\nHEAVY TIER SKIPPED for ${shortSha(sha)} — never got the machine lock (${lockPath}) within ${Math.round(waitMs / 60000)} min. NO VERDICT WRITTEN.`);
    return 3;
  }
  if (!held.ok) console.log(`[ci:heavy] running WITHOUT the machine lock (${held.error && held.error.code}) — the marker will say so`);

  // CLEAN UP EVEN WHEN WE ARE KILLED. A heavy run is now SUPERSEDED by the
  // next push (the launcher SIGTERMs it), and node's default SIGTERM does not
  // run `finally` — so without this the killed run leaves a full checkout in
  // /tmp, a registration in `git worktree list` that `worktree prune` will
  // never remove (the directory still exists), and the machine lock held
  // until its pid is reaped. Idempotent: the finally calls the same function.
  // A SIGNAL HANDLER CANNOT PREEMPT A SYNCHRONOUS RUN — so the abort is also a
  // synchronous QUESTION, asked between suites. Found by mutation-testing the
  // handler above with a kill that lands after `git worktree add` (the earlier
  // timing was measuring git's own cleanup): heavyGate is spawnSync from top to
  // bottom, so a SIGTERM delivered mid-build is queued on the event loop and
  // cannot run until the whole tier has finished — the superseded run kept
  // going and then stamped a marker whose build had been KILLED, i.e. a RED for
  // the exact commit the newer run replaced. That is the false-red this round
  // exists to remove, reintroduced by the fix for it.
  //
  // Two independent pieces of evidence, both synchronous and both read at the
  // moment they matter: our pid file was removed (the superseding launcher
  // unlinks it), or the machine lock is no longer ours (somebody judged us dead
  // and stole it). The pid-file check ARMS on first sight rather than at
  // startup, because the launcher writes that file just after spawning us and
  // a run that never had one (a manual `ci:heavy`) must never trip it.
  // The pid file is passed IN (`--pid-file`), never inferred: a check that
  // armed itself the first time it happened to SEE the file could not fire at
  // all if the supersede landed before its first look, and `abandoned()` is
  // only consulted a handful of times. Being TOLD "you have one" makes its
  // absence unambiguous. The launcher writes it BEFORE spawning (with pid 0,
  // rewritten once the pid exists) so the reverse race cannot happen either.
  let signalled = '';
  const noteChildResult = (r) => { if (r && r.killedFromOutside && !signalled) signalled = 'this run was terminated from outside (a child died on a signal we did not send)'; return r; };
  const abandoned = () => {
    if (signalled) return signalled;
    if (pidFile && !fs.existsSync(pidFile)) return 'superseded by a newer push (our pid file was removed)';
    if (held.ok) { const cur = readJson(lockPath); if (!cur || cur.pid !== process.pid) return 'the machine lock was taken from us (we were judged dead)'; }
    return '';
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return; cleaned = true;
    if (held.ok) held.release();
    try { fs.unlinkSync(pidFile || path.join(d, `${sha}.pid`)); } catch {}
    if (wt) removeScratchWorktree(wt);
  };
  for (const sig of OUTSIDE_SIGNALS) {
    process.on(sig, () => { console.error(`\n[ci:heavy] ${sig} — superseded or cancelled; cleaning up and writing NO verdict for ${shortSha(sha)}`); cleanup(); process.exit(143); });
  }
  try {
    if (isolate) {
      // The working tree keeps moving while a ten-minute run is in flight, so
      // a marker that NAMES a sha has to have tested that sha (see
      // addScratchWorktree — ONE implementation, shared with the fast tier).
      wt = addScratchWorktree(sha, 'heavy');
      runRoot = wt;
    }
    const build = noteChildResult(runBuild({ cwd: runRoot }));
    const failed = [], flaky = [], timings = [], absent = [];
    // The build is the first thing a supersede kill lands on, so ask before
    // believing its failure — and before spending the rest of the tier.
    let abandonedWhy = abandoned();
    // Say it wherever it is first noticed — the abort can be true before the
    // suite loop is ever entered (a supersede that lands during the build),
    // and a run that goes quiet is the thing this whole round is against.
    if (abandonedWhy) console.log(`\n[ci:heavy] stopping: ${abandonedWhy}`);
    if (!build.ok && !abandonedWhy) failed.push('npm run build');
    else if (!abandonedWhy) {
      for (const s of heavy) {
        abandonedWhy = abandoned();
        if (abandonedWhy) { console.log(`\n[ci:heavy] stopping: ${abandonedWhy}`); break; }
        let r = noteChildResult(runSuite(s, { root: runRoot, absentIsSkip: !!isolate, sha }));
        // Absent at the commit being gated (round 6): not run, not judged, and
        // not counted in `timings` — a marker that named 97 suites when 42 of
        // them do not exist at that sha is a claim nobody made.
        if (r.absent) { absent.push(s.name); continue; }
        if (!r.ok) {
          // …BUT NEVER RETRY A SUITE WE OURSELVES KILLED. Supersession SIGTERMs
          // the process GROUP, so the suite in flight dies with the runner's
          // own kill — and `noteChildResult` has just recorded that. Asking
          // `abandoned()` at the loop top only is not enough: the answer
          // becomes true HERE, one line before the most expensive thing the
          // tier does. Measured in a throwaway repo (a 90 s heavy stub,
          // superseded 6 s in): the superseded run spent the whole retry while
          // still HOLDING the machine lock, and the newer run sat in "waiting
          // up to 40 min for the machine" — the exact opposite of the reason
          // supersession kills instead of queueing (round 2 ①a). Retry-once
          // exists for a flaky FIXTURE (another checkout squatting :3987), and
          // its answer here is discarded anyway: this run writes no verdict.
          abandonedWhy = abandoned();
          if (abandonedWhy) { console.log(`\n[ci:heavy] stopping: ${abandonedWhy}`); break; }
          // RETRY ONCE. This tier's verdict BLOCKS the next push, and many of
          // these suites hard-code a port or a /tmp path — on a machine that
          // hosts several checkouts, one of them squatting :3987 is not a
          // regression in the code being pushed. A suite that fails and then
          // passes is recorded as FLAKY, not red: it does not block, and both
          // outcomes are in the log and in the marker, so the flakiness is
          // visible instead of being laundered into a green.
          console.log(`  … ${s.name} failed — retrying once before calling it red`);
          const again = noteChildResult(runSuite(s, { root: runRoot }));
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
      // The suites this gate's table names that the gated COMMIT does not
      // contain: not run, not judged. Named in the marker so `ci:status` and
      // the Diagnostics report can say what the verdict is about rather than
      // implying all `suites` of them ran.
      absent: absent.length ? absent : undefined,
      partial: only ? only.slice() : undefined,
      unlocked: held.ok ? undefined : true,
      timings: timings.sort((a, b) => b.ms - a.ms).slice(0, 10),
    };
    // A marker is a CLAIM about a commit, so it is only written when the run
    // can honestly make it. THREE refusals: a run that was abandoned (killed by
    // a newer push, or judged dead and stripped of the lock — it did not finish
    // and its failures are OUR doing), a dirty in-place tree (the sha would not
    // describe what ran — normally refused at t=0, reachable here only via
    // --dirty-ok), and a PARTIAL run trying to overwrite a full verdict (a
    // `--only` re-run must not erase what the whole tier said).
    const existing = readMarkers(dir).find((m) => m.sha === sha && (m.kind === 'green' || m.kind === 'red') && !m.partial);
    let noVerdict = '';
    if (abandonedWhy || (abandonedWhy = abandoned())) noVerdict = abandonedWhy;
    else if (dirtyAtStart) noVerdict = 'the tree was DIRTY — the sha would not describe what ran';
    // …and a run in which EVERY suite was absent judged nothing (round 6): an
    // old ref that predates them would otherwise earn a GREEN marker for a run
    // of zero suites — the vacuous green `--only` already refuses on a typo.
    else if (absent.length && absent.length === heavy.length) noVerdict = `every suite in this run is absent at ${shortSha(sha)} — nothing ran, so nothing is claimed`;
    else if (only && existing) noVerdict = `partial run — keeping the existing FULL ${existing.kind.toUpperCase()} marker for ${shortSha(sha)}`;
    if (noVerdict) {
      console.log('\n[ci:heavy] ' + noVerdict);
    } else {
      fs.mkdirSync(d, { recursive: true });
      for (const ext of ['green', 'red', 'skipped']) { try { fs.unlinkSync(path.join(d, `${sha}.${ext}`)); } catch {} }
      fs.writeFileSync(path.join(d, `${sha}.${rec.result}`), JSON.stringify(rec, null, 2) + '\n');
      pruneMarkers(dir);
    }
    // THE CLOSING LINE IS THE ONE PEOPLE READ. "HEAVY GATE GREEN" is a claim
    // about a commit; when no marker was written there is no such claim, and
    // saying it anyway is how a developer waits out the whole tier and stays
    // blocked without knowing why (round 2 finding).
    // An ABANDONED run did not pass — it stopped. Printing "GREEN" for a tier
    // that ran zero suites, even with "NO VERDICT WRITTEN" beside it, hands the
    // next reader a sentence they can quote out of context; that is the exact
    // dishonesty this round is about, one word smaller.
    const verdict = abandonedWhy
      ? `HEAVY TIER ABORTED for ${shortSha(sha)} after ${Math.round(rec.ms / 1000)}s (${timings.length} of ${heavy.length} suites ran)`
      : failed.length
        ? `HEAVY ${noVerdict ? 'TIER' : 'GATE'} RED for ${shortSha(sha)} in ${Math.round(rec.ms / 1000)}s — failed: ${failed.join(', ')}`
        : `HEAVY ${noVerdict ? 'TIER' : 'GATE'} GREEN for ${shortSha(sha)} in ${Math.round(rec.ms / 1000)}s (${heavy.length - absent.length} of ${heavy.length} suites${absent.length ? ` ran; ${absent.length} not present at that commit` : ''})`;
    console.log('\n' + verdict + (noVerdict ? ` — NO VERDICT WRITTEN (${noVerdict})` : ''));
    if (absent.length) console.log(`[ci:heavy] SKIPPED (absent at ${shortSha(sha)}, not run and not judged): ${absent.join(', ')}`);
    if (flaky.length) console.log(`[ci:heavy] FLAKY (failed, passed on retry — not blocking, but they did fail once): ${flaky.join(', ')}`);
    // AN ABORTED TIER MUST NEVER EXIT 0 (round 4 finding). `failed` is empty
    // for an abandoned run by construction — it stopped instead of judging —
    // so `failed.length ? 1 : 0` handed it the success code, and the Actions
    // heavy job (whose only signal is the exit code) showed a green tick for a
    // tier that ran zero suites. Exit 4 = ABORTED: the run did not finish and
    // wrote no verdict, which is neither green (0), red (1), refused (2) nor
    // "never got the machine lock" (3). Every one of those non-zero codes means
    // "do not read this as a pass"; only 0 and 1 are verdicts.
    if (abandonedWhy) return 4;
    return failed.length ? 1 : 0;
  } finally {
    cleanup();
  }
}

// DETACHED LAUNCH. No setsid/nohup dependency: node detaches its own child and
// unrefs it, so the hook returns immediately and the run survives the hook,
// the ssh session and the terminal. The child gets the SANITIZED git env —
// a pre-push hook exports GIT_DIR/GIT_INDEX_FILE and every heavy suite runs
// `git worktree add`. (The project's own detached-job primitive — jobs.js /
// data/bin/job-wrapper.js — needs a running server and a session token, so it
// is not reachable from a git hook.)
function heavyLaunch(sha, { dir, only, lock, lockWaitMs } = {}) {
  const d = markerDir(dir);
  if (!sha || gitOut(['cat-file', '-e', sha + '^{commit}']) === null) { console.error(`[ci:heavy] not launching: ${sha ? 'unknown commit ' + shortSha(sha) : 'no sha given'}`); return 0; }
  // SERIALISE THE TIER, NOT JUST THE SHA (round 2 finding). Refusing only a
  // twin for the SAME sha meant two pushes inside one 16-minute window started
  // two full heavy tiers that ate each other's ports and /tmp checkouts, and
  // the loser stamped a RED that blocked the next push. A run for an ANCESTOR
  // of what we are pushing is SUPERSEDED — the newer commit subsumes it and a
  // half-finished verdict about a commit nobody is on top of any more is worth
  // nothing — and killing it now frees the machine instead of queueing behind
  // it. Anything else (a divergent branch, an older push) still gets launched:
  // refusing would leave that commit with no heavy coverage at all, so the
  // child waits for the machine lock instead.
  const running = inFlight(dir);
  const same = running.find((m) => m.sha === sha);
  if (same) { console.error(`[ci:heavy] already running for ${shortSha(sha)} (pid ${same.pid})`); return 0; }
  const isAncestorOfNew = (old) => spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', old, sha], { env: GIT_ENV }).status === 0;
  for (const old of running) {
    if (!old.sha || old.sha === sha || gitOut(['cat-file', '-e', old.sha + '^{commit}']) === null || !isAncestorOfNew(old.sha)) continue;
    // Positive identity before a kill (see looksLikeHeavyRun). Without it, this
    // run queues on the machine lock instead — slower, never destructive.
    if (!looksLikeHeavyRun(old.pid)) {
      console.error(`[ci:heavy] NOT superseding ${shortSha(old.sha)} (pid ${old.pid}): that pid does not read as a heavy run — queueing instead`);
      continue;
    }
    // Detached children are process-group leaders (spawn detached:true), so the
    // negative pid takes the suites down with the runner.
    try { process.kill(-old.pid, 'SIGTERM'); } catch { try { process.kill(old.pid, 'SIGTERM'); } catch {} }
    try { fs.unlinkSync(old.file); } catch {}
    console.error(`[ci:heavy] superseded the run for ${shortSha(old.sha)} (pid ${old.pid}) — ${shortSha(sha)} descends from it`);
  }
  fs.mkdirSync(d, { recursive: true });
  const logPath = path.join(d, `${sha}.log`);
  const pidPath = path.join(d, `${sha}.pid`);
  const fd = fs.openSync(logPath, 'w');
  const args = [HERE, '--heavy', '--sha=' + sha, '--isolate', '--markers=' + d, '--pid-file=' + pidPath];
  if (only) args.push('--only=' + only.join(','));
  if (lock) args.push('--lock=' + lock);
  if (lockWaitMs !== undefined) args.push('--lock-wait-ms=' + lockWaitMs);
  // WRITE IT BEFORE THE SPAWN. The child treats the ABSENCE of this file as
  // "superseded", so it must never be able to look before the file exists.
  // pid 0 = a placeholder nobody reads as in flight (`inFlight` needs a pid).
  const stamp = (pid) => fs.writeFileSync(pidPath, JSON.stringify({ sha, pid, cmd: '--heavy --sha=' + sha, startedAt: Date.now() }) + '\n');
  stamp(0);
  const child = spawn(process.execPath, args, { cwd: repo, detached: true, stdio: ['ignore', fd, fd], env: GIT_ENV });
  child.unref();
  fs.closeSync(fd);
  // `cmd` is a fragment of the child's OWN argv: it is what lets a later
  // launcher tell "still running" from "that pid number belongs to something
  // else now" (pidStillRunning).
  stamp(child.pid);
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
  // The recovery has to be REACHABLE. It used to also offer "or wait for the
  // next push's background run" — but the background run is launched BY a
  // push and the push is the thing being refused, so that sentence pointed at
  // a door that only opens from the other side (round 2 finding).
  console.error('     Fix it, COMMIT, then earn a green heavy verdict on the new commit:');
  console.error('       npm run ci:heavy        (the whole tier in an isolated worktree at HEAD, ~17 min; writes the marker that clears this)');
  console.error('     Emergency bypass: VIBESPACE_SKIP_CI=1 git push\n');
  return 1;
}

function status({ dir, head: wantHead } = {}) {
  const all = readMarkers(dir);
  const results = all.filter((m) => m.kind !== 'pid');
  const running = inFlight(dir);
  const lockPath = defaultLockPath();
  const holder = readJson(lockPath);
  const dur = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s` : `${Math.round(ms / 1000)}s`);
  console.log(`heavy gate results (${path.relative(repo, markerDir(dir)) || markerDir(dir)}):`);
  if (!results.length && !running.length) console.log('  (none yet — the next push launches one)');
  // RUNNING vs WAITING is INFERRED, not stored — the child would have to
  // rewrite its pid file to say so, and that races the launcher's supersede.
  // The inference is sound: if a LIVE holder with a different pid has the
  // machine lock, this process cannot be executing suites (and it cannot be an
  // `unlocked` run either — a holder existing proves the lock file works).
  const lockHeld = holder && pidStillRunning(holder) ? holder : null;
  for (const m of running) {
    const state = lockHeld && lockHeld.pid !== m.pid ? `WAITING (for pid ${lockHeld.pid})` : 'RUNNING';
    console.log(`  ${shortSha(m.sha)}  ${state}  started ${new Date(m.startedAt).toLocaleString()}  pid ${m.pid}`);
  }
  for (const m of results.slice(0, 12)) {
    // SKIPPED is not a verdict — it is the absence of one, said out loud, so a
    // commit that never got its turn on the machine cannot be mistaken for one
    // that passed (or for "nobody has pushed lately").
    const label = m.kind === 'skipped' ? 'SKIP ' : m.result === 'green' ? 'GREEN' : 'RED  ';
    const detail = m.kind === 'skipped' ? `no verdict — ${m.reason || 'did not run'}`
      : m.result === 'green' ? `${m.suites} suites` : 'failed: ' + (m.failed || []).join(', ');
    // `absent` is not decoration: it is what makes "97 suites" above true or
    // false, so the CLI carries it exactly like the route and the report do.
    const marks = [m.partial ? `partial: ${m.partial.join(',')}` : '', m.unlocked ? 'ran WITHOUT the machine lock' : '',
      (m.absent || []).length ? `${m.absent.length} not present at that commit` : '',
      (m.flaky || []).length ? `flaky: ${m.flaky.join(',')}` : ''].filter(Boolean).join('  ');
    console.log(`  ${shortSha(m.sha)}  ${label}  ${dur(m.ms || 0).padStart(6)}  ${new Date(m.endedAt || 0).toLocaleString()}  ${detail}${marks ? '  [' + marks + ']' : ''}`);
  }
  if (holder) console.log(`\nmachine lock: held by pid ${holder.pid} for ${shortSha(holder.sha)}${pidStillRunning(holder) ? '' : ' (DEAD — the next run steals it)'}  ${lockPath}`);
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
  // The machine lock is real infrastructure, so a TEST must be able to drive
  // its own instead of contending with (or waiting 40 minutes for) the box's
  // actual heavy run — scripts/test-ci-heavy-launch.mjs passes both.
  const lock = str('lock') ? path.resolve(str('lock')) : (process.env.VIBESPACE_CI_HEAVY_LOCK || undefined);
  const lockWaitMs = str('lock-wait-ms') !== null ? Number(str('lock-wait-ms')) : undefined;
  if (arg('census')) process.exit(census());
  if (arg('status')) process.exit(status({ dir, head }));
  if (arg('check-heavy')) process.exit(checkHeavy({ dir, head }));
  if (arg('heavy-launch') !== undefined) process.exit(heavyLaunch(str('heavy-launch') || argv[argv.indexOf('--heavy-launch') + 1], { dir, only, lock, lockWaitMs }));
  if (arg('heavy')) process.exit(heavyGate({ sha: str('sha'), isolate: !!arg('isolate'), dir, only, dirtyOk: !!arg('dirty-ok'), lock, lockWaitMs, pidFile: str('pid-file') || undefined }));
  // `--isolate [--sha=<x>]` gates the COMMIT rather than this working tree —
  // the hook uses it when a pushed ref's tip is not HEAD.
  process.exit(fastGate({ sha: str('sha'), isolate: !!arg('isolate') }));
}

// Only run when EXECUTED — test-architecture imports the tier table.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2));
