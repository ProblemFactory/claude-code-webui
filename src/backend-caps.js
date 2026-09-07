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
// chip all gate on THIS, never on a backend id). A row declares TWO facts:
//   queue      — a message sent mid-turn is HELD and runs after the turn, and
//                the harness REPORTS that state back to us (a CLI that queues
//                silently still counts: claude's own stdin queue is real, it
//                just has no readable state — see queueVerbs).
//   queueVerbs — THE VERB TABLE (design-harness-features §3.1): the closed set
//                of queue actions this harness actually SERVES. Adding a verb
//                is one array entry + its three implementations (adapter
//                frame, wrapper handler, client control), never a new boolean
//                on five call sites.
// The old `{steer, queueOps}` booleans are kept as a DERIVED VIEW of that list
// (deriveInputModes below, materialized once at module load) so the existing
// consumers keep reading what they always read — but there is exactly ONE
// place to edit, and scripts/test-queue-steer.mjs ① pins the derivation law
// (steer === verbs.includes('steer'), queueOps === verbs.length > 0) on both
// this row AND the client's mirror in src/lib/agent-meta.js.
//   'remove'    — drop a queued item (it never runs).
//   'steer'     — INJECT it into the running turn so the agent sees it at its
//                 next reply (codex `turn/steer`; measured on 0.153.4: several
//                 steers per turn are accepted, and a steer does NOT remove
//                 the queued copy — the wrapper deletes it).
//   'steer-all' — the same, for every queued item in order.
//   'reorder'   — move an item (ws frame: RELATIVE `afterId`; the wrapper
//                 translates it into the app-server's absolute full-order
//                 array — the two layers deliberately do not share vocabulary,
//                 because a full order computed on a stale render would delete
//                 whatever a peer queued in between).
//   'edit'      — rewrite the TEXT of a queued item, preserving every other
//                 input element by exclusion (never a whitelist).
//   'run-now'   — run ONE queued item immediately (idle thread only).
//   'run-all'   — run the whole queue immediately (idle thread only). A
//                 SEPARATE verb, never run-now without an id: one lost id
//                 would otherwise drain the queue.
// A harness that declares a verb it cannot construct is a RED test, so
// "offering a control we cannot honour" (the 2.361.4 accept-and-ignore
// failure) is structurally impossible rather than a review promise.
// turnState names WHERE "is a turn running right now" comes from
// (design-harness-features §3.5). Everything that gates on streaming — the
// composer's Stop button, auto-resume's "it is already working" skip, the
// attach payload's isStreaming — reads ONE flag; this row says whether that
// flag is the harness's own statement or our inference:
//   'authoritative' — the harness PUBLISHES turn state and we drive the flag
//                     from it (claude: system/session_state_changed
//                     {idle|running|requires_action}, the CLI's own words
//                     "authoritative turn-over signal"; codex: turn/started +
//                     turn/completed; ACP: prompt_start / prompt_end's stop
//                     reason). Per SESSION the fact is still tri-state — an
//                     old CLI, or claude without the spawn env below, never
//                     emits one, so the consumer stays on the derived path
//                     until the FIRST record arrives and only THEN reports
//                     authoritative. Declaring it here says the PROTOCOL can,
//                     never that this session did.
//   'derived'       — we infer it from record shapes (no such harness today;
//                     the value exists so a future one can say so honestly).
//   null            — no turn concept at all (shell).
// inProgressTools names the TOOL-GRANULAR truth: whether the harness reports
// which tool_use ids are executing right now. FALSE ON EVERY HARNESS TODAY —
// including claude, whose `set_in_progress_tool_use_ids` record exists and is
// even documented ("Surfaces use this to show which tools are running") but
// NEVER REACHES A STREAM-JSON CONSUMER: 2.1.257 hands it to a host callback
// (`n.onInProgressToolUseIDs?.(e.op); return`, offset 186333979) and the 'add'
// side goes to a callback at tool dispatch without entering that dispatcher at
// all. Measured, not inferred — a probe in chat-wrapper.js's exact spawn shape
// ran 6 tools and saw 0 of these while session_state_changed arrived on the
// same stdout, and 24 production buffers hold 212 tool_use blocks and 0 of
// these. A cap is a PROMISE TO A SURFACE: claiming true here painted a
// "currently executing" dot no user could ever see. The consumer stays (dormant
// with the callback named) and scripts/test-stdout-registry.mjs re-measures the
// wire on every run — the day a CLI forwards the record, that leg goes red and
// says to flip this row. codex/ACP report per-item lifecycle instead, and a
// card's spinner is derived from its own item there.
// CLAUDE'S SPAWN PREREQUISITE (owner decision 8(c), design §5.1): the CLI only
// emits session_state_changed when CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS is in
// its environment — src/adapters/claude-code.js sets it on every claude spawn.
// It is pure observability (no behaviour change), which is why it is the ONE
// spawn default that changed in this batch.
// responseStyle names the harness's "how should the agent talk" knob and,
// crucially, WHEN it can be set (2.369.58 — the chip's "restart to apply" row
// gates on `live`, never on a backend id):
//   values    — the harness's OWN accepted vocabulary. PROTOCOL VALUES, never
//               translated, never guessed: claude's four settings-file output
//               styles; codex's Personality enum, read out of
//               `codex app-server generate-json-schema` on 0.153.4
//               (none | friendly | pragmatic). An empty list = the harness has
//               no such knob and the chip is not drawn at all.
//   closed    — `true` when `values` is the WHOLE accepted vocabulary and the
//               harness REJECTS anything else (codex: a Personality outside the
//               enum fails the RPC), so an out-of-enum value is dropped before
//               it can reach a spawn. `false` when the harness accepts
//               user-defined values too (claude: `~/.claude/output-styles/*.md`
//               are real custom output styles — `values` is only what the
//               PICKER offers, and validating against it would silently eat a
//               user's own style).
//   live      — `true` when a RUNNING session can be re-styled
//               (codex: `thread/settings/update {threadId, personality}`
//               applies from the next turn on the SAME thread);
//               `false` when the value is only read at spawn (claude: it is a
//               --settings key and stream-json has no /output-style, so the
//               menu offers "Restart now to apply").
// THE UNSET RULE (both harnesses): the empty string means "the user made NO
// choice" and the key is then NEVER sent — the agent keeps whatever its own
// config file says. codex's 'none' is a real, DIFFERENT value ("no
// personality"), so it can only arrive from an explicit pick.
const QUEUE_VERBS = Object.freeze(['remove', 'steer', 'steer-all', 'reorder', 'edit', 'run-now', 'run-all']);

/** What a wrapper that advertises a queue but NAMES NO VERBS is taken to
 *  serve — i.e. every build up to and including 2.369.55, which had exactly
 *  these three. It lives HERE, in the PURE module, because BOTH sides need it:
 *  the server maps a verb-less sidecar/publication onto it (src/server/
 *  wrapper-files.js re-exports this very array) and the CLIENT applies the
 *  SAME mapping to a verb-less in-band `queue_changed` — a client that instead
 *  read "no verbs" as "serves nothing" hid the whole strip from an older
 *  session the server was happily serving (round-2 verifier). One list, one
 *  meaning, both ends. */
const LEGACY_QUEUE_VERBS = Object.freeze(['remove', 'steer', 'steer-all']);

/** The derived view of a queue verb table. PURE, shared with the CLIENT
 *  (src/lib/agent-meta.js imports it — a PURE module is bundled directly), so
 *  the LAW lives in one place even though each side declares its own row. */
function deriveInputModes(row) {
  const verbs = Object.freeze((row && Array.isArray(row.queueVerbs) ? row.queueVerbs : []).filter((v) => QUEUE_VERBS.includes(v)));
  return Object.freeze({
    queue: !!(row && row.queue),
    steer: verbs.includes('steer'),
    queueOps: verbs.length > 0,
    queueVerbs: verbs,
  });
}
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
    // The CLI queues stdin messages itself and reports nothing about it —
    // an HONEST EMPTY verb table, not a missing feature.
    inputModes: { queue: true, queueVerbs: [] },
    // system/session_state_changed (env-gated at spawn) — VERIFIED on our
    // stdout in the wrapper's spawn shape (running → idle around a real turn).
    // inProgressTools is false because the record it would need is swallowed by
    // a host callback and never reaches us (see the row's essay above).
    turnState: 'authoritative',
    inProgressTools: false,
    // --settings outputStyle, read once at spawn (stream-json has no
    // /output-style verb) ⇒ a change needs a restart.
    responseStyle: { live: false, closed: false, values: ['Concise', 'Explanatory', 'Learning', 'Proactive'] },
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
    // thread/queue/{add,list,delete,update,reorder,start} + turn/steer — every
    // shape dumped from the 0.153.4 schema and exercised against a live
    // app-server (the removal verb is `delete` with `queuedSubmissionId`;
    // there is NO `thread/queue/remove`).
    inputModes: { queue: true, queueVerbs: ['remove', 'steer', 'steer-all', 'reorder', 'edit', 'run-now', 'run-all'] },
    // turn/started (+ turn_id) and turn/completed / turn_aborted / task_failed
    // are the app-server's own turn boundaries — already the only thing the
    // codex consumer flips _isStreaming on. No tool-granular set exists.
    turnState: 'authoritative',
    inProgressTools: false,
    // Personality enum + thread/settings/update, both from the 0.153.4 schema
    // dump. LIVE: the running thread takes the new personality for its next
    // turn — no restart, no new conversation.
    responseStyle: { live: true, closed: true, values: ['none', 'friendly', 'pragmatic'] },
  },
  shell: {
    pool: false, hotSwitch: 'unverified', planC: false, sealedOrders: false, resetCredit: false, quotaProbe: null, fork: false,
    streamProtocol: null, // terminal-only: no chat parse pipeline
    peerDelivery: 'stash-only',
    inputModes: { queue: false, queueVerbs: [] },
    turnState: null, inProgressTools: false, // terminal-only: there is no turn
    responseStyle: { live: false, closed: true, values: [] }, // terminal-only: no agent to style
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
    // a plain local array, which makes remove/reorder/edit cheap array ops it
    // really serves. It cannot inject into a running prompt (session/prompt is
    // one-at-a-time; there is no steer in the protocol), and run-now/run-all
    // are declared FALSE for a structural reason, not laziness: that queue only
    // ever has entries WHILE a prompt is running (an idle wrapper dispatches
    // immediately), so "run it now" could only ever answer 'busy'.
    inputModes: { queue: true, queueVerbs: ['remove', 'reorder', 'edit'] },
    // ACP v1's prompt_end carries a stop reason — the agent's own statement
    // that the prompt is over (acp-events already drives the flag from it).
    turnState: 'authoritative',
    inProgressTools: false,
    // ACP v1 has no response-style/persona verb; the agent's own config owns it.
    responseStyle: { live: false, closed: true, values: [] },
  },
};

// The verb tables above are DECLARATIONS; the booleans every existing consumer
// reads are computed from them exactly once, here, so no call site can see a
// row whose `steer` disagrees with its `queueVerbs`.
for (const row of Object.values(BACKEND_CAPS)) row.inputModes = deriveInputModes(row.inputModes);

const NO_CAPS = Object.freeze({ pool: false, hotSwitch: 'unverified', planC: false, sealedOrders: false, resetCredit: false, quotaProbe: null, fork: false, streamProtocol: null, peerDelivery: 'stash-only', inputModes: deriveInputModes({ queue: false, queueVerbs: [] }), turnState: null, inProgressTools: false, responseStyle: Object.freeze({ live: false, closed: true, values: Object.freeze([]) }) });

function capsOf(backend) {
  return BACKEND_CAPS[backend || 'claude'] || NO_CAPS;
}

// WHICH LANE A **VIBESPACE NOTIFICATION** TAKES WHEN THE RECEIVER IS BUSY
// (owner decision 2026-09-07, after a codex session accumulated 20
// "[VibeSpace Background Work] … done" items as 20 SEPARATE queued
// submissions = 20 billed turns after the one it was running):
//   'steer'     — inject it into the RUNNING turn (codex `turn/steer`).
//                 TUI parity, and it is the reason this is safe: a steer
//                 carries ONLY its own items (codex-rs
//                 app-server/src/request_processors/turn_processor.rs:1023-1039
//                 maps `params.input` into ONE TurnInput::UserInput and
//                 submits it with TurnInputMode::Steer), and core drains
//                 every pending steer WHOLESALE before each model request
//                 (core/src/session/turn.rs:312-323 → session/input_queue.rs
//                 get_pending_input, `pending_input.items.split_off(0)`), so
//                 consecutive notifications merge by themselves. The QUEUE is
//                 never read and never written by a steer.
//   'queue'     — held and run as its OWN turn after this one (a harness with
//                 a queue but no steer verb — ACP v1 has no such method).
//   'cli-inbox' — the CLI owns the decision (claude's inbox queues a mid-turn
//                 delivery itself and opens a billed turn when idle).
//   'stash'     — no live lane at all; injected at the next turn.
// DERIVED, never declared: a harness that serves the 'steer' verb on the
// 'rpc-queue' lane steers its notifications — the same law that makes
// inputModes.steer a VIEW of queueVerbs, so there is no second place to edit
// and no backend-id branch anywhere downstream. HUMAN peer messages (frame
// kind 'peer') deliberately do NOT take this lane: a person's message is its
// own turn, and stealing it into someone else's running turn would change what
// the agent was asked to do mid-answer.
function notificationDelivery(caps) {
  const c = caps || NO_CAPS;
  const modes = c.inputModes || NO_CAPS.inputModes;
  if (c.peerDelivery === 'rpc-queue') return modes.steer ? 'steer' : 'queue';
  if (c.peerDelivery === 'cli-inbox') return 'cli-inbox';
  return 'stash';
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

module.exports = { BACKEND_CAPS, capsOf, setVerifiedCap, QUEUE_VERBS, LEGACY_QUEUE_VERBS, deriveInputModes, notificationDelivery };
