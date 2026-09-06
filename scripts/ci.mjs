#!/usr/bin/env node
// THE MANDATORY RELEASE GATE (2.336.0, owner directive: "发版之前能有个强制CI
// 过程，确保至少核心工作流都是能用的"). Runs the full core battery in ~90s:
//   1. npm run build   — esbuild + arch(40) + bundle-globals + ws-contract +
//                        session-schema + i18n (all already chained in build)
//   2. every gate suite the CLAUDE.md routing table names + the account/pool/
//      usage batteries (pure + store + real-daemon, all self-contained)
//   3. test-client-boot — headless chrome boots the real app (splash gone,
//      zero uncaught exceptions, ws open; negative-controlled) — the CLIENT
//      face of "打不开" (2.330.x) that static checks only partially model
//   4. test-restore-smoke — boots the WORKING TREE in an isolated worktree,
//      creates a real session, SIGKILLs, reboots, reconnects, then fires the
//      28-route GET battery (the lost-binding class ONLY manifests at boot or
//      route-run time; 2.330.0/2.330.1/2.333.0/2.335.0 all slipped past every
//      static gate)
// Enforced by scripts/git-hooks/pre-push (docs-only pushes skip; emergency
// bypass VIBESPACE_SKIP_CI=1) and mirrored in .github/workflows/ci.yml.
// Fail-fast: the first red suite stops the run with a nonzero exit.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t0 = Date.now();

// Ordered cheap→expensive so a pure-logic regression fails in seconds.
const SUITES = [
  'test-discovery-interpret', 'test-remote-discovery-dirty', 'test-remote-shell',
  'test-usage-walk-parity', 'test-ctx-sync', 'test-migrations',
  'test-job-model', 'test-jobs-engine', 'test-peer-messaging', 'test-lazy', 'test-server-globals',
  'test-resume-all-desktops', // pure scan + the WIRING pin (the 2.331.0 dead-fix lesson)
  'test-window-types',  // window-type registry (Plugin Ph1): node-functional dispatch + loud unknown-action + the exact core type/action sets + no switch/TYPE_ICONS literal left
  'test-contributions', // commands + menus (when/group/order) + keybindings registry (Plugin Ph1): node-functional dispatch/ordering/filtering/dispatcher, the three migrated core menus ≡ verbatim legacy builders over a state matrix, ws-handler `default:` on the REAL handler (no sessionId in the reply), plugin-scoped removal, wiring pins
  'test-path-mounts',   // /svc/<name>/ reverse proxy: real http+ws round trips + store rules
  'test-mount-oauth-probe', // dead OAuth token behind a healthy-looking mount: probe eligibility + slow clock + phrasings + Re-authorize button
  'test-mount-stranded', // stranded writes under a DISCONNECTED mount point: quarantine-never-delete on connect + shadowedBy predicate + TASK.md writer guard + wiring pins
  'test-tool-toggles', // per-feature Integration toggles: a disabled agent CLI is neither taught (context/reminder/stop nudge) nor served (403) — was outside the gate and rotted on a literal CLI count for 27 releases (B-0e1b)
  'test-owner-batch-2369-32', // owner batch 2.369.32: codex resume model continuity (last turn_context) + wrapper model pin, sidebar primary-only default, codex ⟳ dispatch, auto-resume origin label, 'not started' reset display
  'test-codex-zst', // harness S3: descriptor store (discover/locate/forkChain/writerSweep/remoteFind) + codex facts off the hot path (worker walk, dir-mtime cache, /proc liveness) + zstd rollouts (readers, walker+scanner lockstep, NC/CO discovery lines)
  'test-harness-contract', // S1 harness registry conformance: every registered harness passes the same descriptor/adapter/normalizer/wrapper/store/client-META assertions; unknown ids throw
  'test-stdout-registry', // S5 stdout consumer registry: descriptor caps.streamProtocol → ONE consumer (src/server/stdout/); unknown protocol = loud console.error + telemetry + RAW passthrough (never stream-json); each consumer on a fake pty feeds representative records to its REAL normalizer + id adoption / streaming flag / _stdin_ack / todos / engine calls; wiring pins
  'test-acp-harness',   // S8 generic ACP v1 harness: the REAL acp-wrapper against a mock ACP agent (initialize → session/new → prompt → tool_call → request_permission → cancel → load) + normalizer shapes + stdout consumer + wiring pins
  'test-opencode-serve', // S9 OpenCode serve-mode store: mock serve (client, session→acp-events synthesis, discover cache/negative-cache/hang budget ≤2s, keeper reuse/spawn/crash-park/stop, serve-backed reader, caps verdict) + wiring pins
  'test-plugin-security', // plugin-system security regressions (2.369.43): shim code-injection via manifest free text, capability-path collapsing, agent-tools consent gate, reinstall-under-a-trusted-id, proxied-reply headers, per-child stop mark, upload cleanup
  'test-plugin-trust', // Plugin Ph4: validator (settings/themes/capabilities/module tier), consent 409 + trusted enable + drift re-prompt, module 403/200 + theme serving, node --permission denial vs granted path, install path/zip/Zip-Slip/update/uninstall-to-trash, shim shipping, client pins
  'test-plugin-loader', // Plugin Ph2: manifest validator matrix + a real fixture plugin (iframe assets w/ sandbox CSP, forked server process, proxied routes, agent-tool shim, enable/disable lifecycle) + client wiring pins
  'test-codex-p2-client', // codex P2 client rows: fork via thread/fork (real wrapper vs stub), onboarding per-backend readiness, switcher codex quota, permission-mode seeds
  'test-codex-p2-wrapper', // codex P2 wrapper: queue-while-busy, slash commands + real compact, live MCP/web/image/compaction records — real wrapper vs stub app-server
  'test-codex-sandbox-net', // codex sandbox keeps loopback open for the vibespace-* tools: real `codex sandbox` A/B (evidence-SKIP without the binary) + wrapper/adapter/probe pins
  'test-attach-rebuild', // first-attach history rebuild is time-sliced + gated (live records replay in order), heartbeat is stall-aware, kills are acknowledged + re-sent until acked
  'test-otel-truth',    // per-request billing truth: parser + loopback ingest + bake override + wiring pins
  'test-chat-frame-guard', // 38MB-poisoning trio: poison guard + frame-file bypass (real claude AND codex wrappers, loud rejections) + rescue + capability-only gate pins
  'test-agent-msg',     // Channels v1: ACL matrix + delivery ladder + wiring pins
  'test-proxy-post',    // proxied POST body reaches the target (real unblocker; the json-parser-skips-/proxy/ pin)
  'test-compaction-ux', // prompt_too_long → guidance card + /compact turn label + two-step Stop (normalizer behavioral + wiring pins)
  'test-auto-resume', // continue-after-limit-reset (tri-state gate, never-early/twice, restart-survival) + CLI output style at spawn
  'test-public-links', // every "link to something here" surface uses the instance's public address (not the browser origin)
  'test-instance-url', // this instance's own public address: frp mapping layered over agentd.publicUrl (never written), one publisher of the relay proxy
  'test-design-kit', // /design kit from the installed CLI: extraction (cli-dir + binary parity), adaptation all-or-nothing, helper --check, wiring
  'test-published-pages', // instance-hosted shareable HTML: publish/serve/auth-gate/CSP-sandbox/upsert + wiring pins
  'test-peer-msg-card', // peer message visible on the LIVE stream (result.origin mining + 3-site dedup) + the codex twin (injectPeerCard, webui_peer marker live/rebuild, marker-blind twin dedup, feedPeerCard no longer false for codex)
  'test-pool-auto', 'test-account-pool', 'test-account-verdicts',
  'test-pool-signed-out', 'test-account-relogin', 'test-auto-cli-refresh',
  'test-cli-usage-parse', 'test-rate-limit-capture', 'test-agentd-upgrade-loop', 'test-vendor-whitelist', 'test-wrapper-files',
  'test-usage-ledger-perf', // inc-mtox23xw: the estimator's per-pair ledger walk is O(log n + k) + interval-memoized (it blocked the loop 10-59s); parity vs brute force + timing pins
  'test-usage-estimator', // dead-reckoning core; was OUTSIDE the gate (silent-stale class) until the 2.368.13 delta-relative calib change touched it
  'test-task-wakeup-card', // background-task lifecycle closure incl. the real record order (tool_result BEFORE the completion notification); also joined the gate late (same class)
  'test-codex-history', // codex rollout coverage: custom_tool_call_output routing, sub-agent visibility, live contextWindow, encrypted reasoning, web_search_end cards (rollout-only searches, live twin dedup, 0.14x call pairing)
  'test-search-card-title', // search cards carry the query in the TITLE (claude WebSearch/WebFetch, codex web_search, ACP search): pure helper + the REAL renderer (esbuild→node) incl. XSS escaping + wiring pins
  'test-codex-0153',   // codex 0.153.4 remainder (B-21e4): fork ordinal (Referenced-fork prefix cut, sub-agent start ordinal, wrapper forked_from echo) + the rows added below it
  'test-codex-quota',   // codex quota P0+P1: window-by-length normalization (0.149.x single-window), exhaustion markers kept, persistence, estimator inclusion
  'test-codex-pool',    // codex pooled account cold-switch v1: store/spawn/self-heal + engine gates + wrapper signal relay + list() pool shape for every backend + ONE shared pool menu/roster pins (2.369.18)
  'test-peer-delivery', // peerDelivery registry lane: codex rpc-queue rung (real deliver.create + sidecar) + wiring pins
  'test-quota-source',  // harness S4: per-harness QuotaSignalSource (normalize/signalFromStream/probe/classifyAuthFailure on real shapes) + the caps-routed probe dispatcher (no claude spawn for codex identities) + wiring pins
  'test-chat-trim-guard', // fold-dominated window trim guard (inc-mtajy6wr white-screen) pins
  'test-fold-ux',       // run-fold honesty (ToolSearch = tool lookups, never MCP; pure summary composer) + expanded-run legibility (rail/floating bar/footer) — node unit + headless-chrome fixture (SKIPs the chrome half without chrome)
  'test-task-lifecycle', // background Agent/Workflow/Bash lifecycle from HISTORY (launch acks + persisted notifications)
  'test-local-device', 'test-sysinfo-op', 'test-transcript-parity',
  'test-writer-sweep', 'test-agentd-session', 'test-session-brain-dark',
  'test-chat-e2e',      // ONE real haiku turn through the full chat pipeline (oat token slot; SKIPs without ~/.config/vibespace/ci-oat)
  'test-client-boot',   // headless-chrome app boot (the FRONTEND face of 打不开; SKIPs without chrome)
  'test-sidebar-rail',  // rail panels + process manager CDP battery (was manual-only and went silently stale — the 9-item assert was red for 12 releases; no rebuild: overlays the gate's own build; SKIPs without chrome)
  'test-restore-smoke', // LAST: the end-to-end boot + session-lifecycle + route battery
];

function run(name, cmd, args) {
  const s = Date.now();
  // Headless-chrome suites boot a worktree server + a browser; on a box that is
  // also running other agents' gates they legitimately take minutes (three
  // load-only reds on 2026-09-06 at the flat 300s cap). A hang still fails —
  // the budget is doubled for the browser suites only, never removed.
  const isBrowserSuite = /test-(client-boot|sidebar-rail|fold-ux|desktop-resume-paging|run-collapse-fold)/.test(String(args.join(' ')));
  const r = spawnSync(cmd, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], timeout: isBrowserSuite ? 600000 : 300000, encoding: 'utf-8' });
  const ms = Date.now() - s;
  if (r.status !== 0) {
    console.error(`\n✗ ${name} FAILED (${ms}ms) — release gate is RED, do not push\n`);
    console.error((r.stdout || '').split('\n').slice(-40).join('\n'));
    console.error(r.stderr || '');
    process.exit(1);
  }
  const tail = (r.stdout || '').trim().split('\n').pop() || 'ok';
  console.log(`  ✓ ${name} (${ms}ms) — ${tail.slice(0, 80)}`);
}

console.log('release gate: build + ' + SUITES.length + ' suites');
run('npm run build', 'npm', ['run', 'build']);
for (const s of SUITES) run(s, process.execPath, [path.join(repo, 'scripts', s + '.mjs')]);
console.log(`\nALL GREEN — release gate passed in ${Math.round((Date.now() - t0) / 1000)}s`);
