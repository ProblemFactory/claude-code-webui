'use strict';
// PURE per-backend account/switching capability registry (P4 first slice,
// design-backend-parity.md §4 — owner ask: "把其它agent支持接口化之后怎么区分
// 这些冷切热切之类的feature"). The pool engine consults THIS instead of
// backend-id special cases; a future backend adds a row, never an if-chain.
//
// hotSwitch is a VERDICT, not a wish:
//   'verified'   — forensically proven live re-read (claude: dir-symlink
//                  survives atomic cred writes, env re-resolved per syscall,
//                  CLI re-reads .credentials.json per request —
//                  scripts/test-creds-symlink-swap.mjs).
//   'impossible' — experimentally REFUTED (codex, 2026-08-24 P3: the
//                  app-server canonicalizes CODEX_HOME at startup — a symlink
//                  repoint never reaches a running process — AND a turn
//                  completed fine after auth.json's content was swapped to
//                  garbage tokens ⇒ tokens live in process memory).
//   'unverified' — no experiment yet; treat as cold.
// A pool on a backend without hotSwitch 'verified' always cold-restarts
// (kill → exited → resume), whatever its `hot` flag says.
// streamProtocol names the live stdout PARSE PIPELINE a chat session needs —
// session-stdout resolves THIS through the consumer registry
// (src/server/stdout/index.js, harness S5), never the backend id, so a backend
// without a registered consumer fails loudly at session start instead of being
// silently parsed as claude stream-json (the gemini-as-claude fallthrough
// class). This row is the ONE source of truth for the protocol — the harness
// descriptor's caps IS this row; it carries no separate stdout:{protocol}.
// peerDelivery names the LIVE lane for agent-to-agent/job messages
// (conversation-deliver consults this, never the backend id):
//   'cli-inbox'  — the CLI's own cross-session inbox socket (claude:
//                  ~/.claude/sessions registry; idle receiver opens a billed
//                  turn — the CLI's documented behavior, not ours).
//   'rpc-queue'  — the wrapper OWNS the app-server RPC connection (codex,
//                  2026-08-25 research): idle ⇒ turn/start (billed turn +
//                  reply, claude-inbox parity); busy ⇒ thread/queue/add runs
//                  it after the current turn (upstream-test-pinned semantics).
//                  Contract for any backend claiming this: its wrapper adverts
//                  sidecar caps.peerMessage and serves the 'peer-message'
//                  stdin verb, reporting peer_message_result honestly.
//   'stash-only' — no live lane; messages queue for next-turn injection.
// inputModes names what a SEND DURING A TURN can do on this harness — the
// queue/steer surface (ws 'queue-op', the client's queue strip and the bubble
// chip all gate on THIS, never on a backend id):
//   queue     — a message sent mid-turn is HELD and runs after the turn, and
//               the harness REPORTS that state back to us (a CLI that queues
//               silently still counts: claude's own stdin queue is real, it
//               just has no readable state — see queueOps).
//   steer     — a held message can be INJECTED into the running turn so the
//               agent sees it at its next reply (codex `turn/steer`; measured
//               on 0.153.4: several steers per turn are accepted, and a steer
//               does NOT remove the queued copy — the wrapper deletes it).
//   queueOps  — we can enumerate and MUTATE the queue (remove/steer an item).
//               false for claude: the CLI owns the queue, publishes no list
//               and takes no removal — offering a control we cannot honour is
//               the accept-and-ignore failure the 2.361.4 lesson names.
const BACKEND_CAPS = {
  claude: {
    pool: true,
    hotSwitch: 'verified',
    planC: true,          // per-session pool links (model-family projection)
    sealedOrders: true,   // device-side offline fallback switch
    resetCredit: false,   // no such product concept
    quotaProbe: 'cli-usage',      // `claude -p /usage` auto-cli rung
    fork: true,                   // --fork-session (+ --resume-session-at for a mid-conversation fork)
    streamProtocol: 'stream-json',
    peerDelivery: 'cli-inbox',
    // The CLI queues stdin messages itself and reports nothing about it.
    inputModes: { queue: true, steer: false, queueOps: false },
  },
  codex: {
    pool: true,
    hotSwitch: 'impossible',
    planC: false,
    sealedOrders: false,
    resetCredit: true,    // account/rateLimitResetCredit/consume (stored resets)
    quotaProbe: 'rpc-rate-limits', // account/rateLimits/read on a live app-server
    fork: true,                   // thread/fork (whole-thread fork; the wrapper sends it when CODEX_WEBUI_FORK=1)
    streamProtocol: 'codex-events',
    peerDelivery: 'rpc-queue',
    // thread/queue/{add,list,delete} + turn/steer — all four measured against
    // a live 0.153.4 app-server (the removal verb is `delete` with
    // `queuedSubmissionId`; there is NO `thread/queue/remove`).
    inputModes: { queue: true, steer: true, queueOps: true },
  },
  shell: {
    pool: false, hotSwitch: 'unverified', planC: false, sealedOrders: false, resetCredit: false, quotaProbe: null, fork: false,
    streamProtocol: null, // terminal-only: no chat parse pipeline
    peerDelivery: 'stash-only',
    inputModes: { queue: false, steer: false, queueOps: false },
  },
  // ACP v1 harnesses (S8, design-harness-plugins §2.3): the agent holds its
  // own login/provider config — no pool, no quota probe, no credential
  // switching; 'acp-events' is the wrapper journal (data/bin/acp-wrapper.js);
  // fork/list/load are read from the agent's initialize reply at spawn, never
  // declared here. peerDelivery stays stash-only until a live lane is proven.
  opencode: {
    pool: false, hotSwitch: 'unverified', planC: false, sealedOrders: false, resetCredit: false, quotaProbe: null, fork: false,
    streamProtocol: 'acp-events',
    peerDelivery: 'stash-only',
    frameFile: true,
    // ACP v1 has no queue verb, so the WRAPPER owns the queue (promptQueue) —
    // it can list and remove, but it cannot inject into a running prompt
    // (session/prompt is one-at-a-time; there is no steer in the protocol).
    inputModes: { queue: true, steer: false, queueOps: true },
  },
};

const NO_CAPS = Object.freeze({ pool: false, hotSwitch: 'unverified', planC: false, sealedOrders: false, resetCredit: false, quotaProbe: null, fork: false, streamProtocol: null, peerDelivery: 'stash-only', inputModes: Object.freeze({ queue: false, steer: false, queueOps: false }) });

function capsOf(backend) {
  return BACKEND_CAPS[backend || 'claude'] || NO_CAPS;
}

// RUNTIME-VERIFIED verdicts (S9, B-03f2): a capability that only a running
// probe can prove — opencode `fork` = the serve instance's OpenAPI carries
// POST /session/{sessionID}/fork — is written here by the prober with its
// evidence; a declared row is never guessed true at spawn time. PURE: no I/O,
// the caller (ORCH) brings the evidence. Unknown backend/key = a no-op that
// returns false; the row object is mutated IN PLACE so descriptor.caps
// (the same object, test-harness-contract pins the identity) sees it.
function setVerifiedCap(backend, key, value) {
  const row = BACKEND_CAPS[backend];
  if (!row || typeof key !== 'string' || !(key in row)) return false;
  row[key] = value;
  return true;
}

module.exports = { BACKEND_CAPS, capsOf, setVerifiedCap };
