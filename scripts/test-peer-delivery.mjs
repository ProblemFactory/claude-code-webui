#!/usr/bin/env node
// Peer-delivery registry lane (2.368.26, B-7c4a): conversation-deliver's
// rung 1.5 delivers to backends declaring capsOf(backend).peerDelivery ===
// 'rpc-queue' (codex) by writing a 'peer-message' stdin frame to the LIVE
// wrapper — which owns the app-server connection (idle ⇒ turn/start billed
// turn, busy ⇒ thread/queue/add; upstream-test-pinned semantics). Functional:
// a REAL deliver.create() over a temp data dir + a real sidecar file (shape =
// what codex-chat-wrapper actually writes), with negative controls — plus the
// wiring pins the 2.355.0 unstaged-wiring lesson demands.
//
// 2026-09-07 (owner: 系统通知默认应该是steering的 / 按照TUI实现吧): the frame
// carries a TYPED ORIGIN. `kind:'notification'` = VibeSpace itself speaking (a
// Background Work event, a system notice) and a busy codex session STEERS it
// into the running turn instead of opening a turn of its own after it;
// `kind:'peer'` = a person's message from another session, which keeps
// queueing. The LADDER only tags — the receiving wrapper picks the lane,
// because only it knows whether a turn is running (the wrapper-side legs live
// in test-codex-p2-wrapper ②f, against a real stub app-server). Which lane a
// harness uses at all is DERIVED, never declared:
// backend-caps notificationDelivery({peerDelivery, inputModes}).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

// ── registry rows ──
const { capsOf } = require(path.join(REPO, 'src/backend-caps.js'));
ok("claude declares peerDelivery 'cli-inbox'", capsOf('claude').peerDelivery === 'cli-inbox');
ok("codex declares peerDelivery 'rpc-queue'", capsOf('codex').peerDelivery === 'rpc-queue');
ok("shell + unknown backends are 'stash-only' (no live lane, no crash)", capsOf('shell').peerDelivery === 'stash-only' && capsOf('gemini').peerDelivery === 'stash-only');

// ── the NOTIFICATION lane is DERIVED from that row + the queue verb table ──
{
  const { notificationDelivery, BACKEND_CAPS } = require(path.join(REPO, 'src/backend-caps.js'));
  const { BACKEND_META, notificationDeliveryFor } = await import(path.join(REPO, 'src/lib/agent-meta.js'));
  ok("codex: rpc-queue + a 'steer' verb ⇒ notifications STEER into the running turn", notificationDelivery(capsOf('codex')) === 'steer');
  ok("claude: the CLI's own inbox owns the decision ⇒ 'cli-inbox' (it queues mid-turn itself; we never write its stdin)", notificationDelivery(capsOf('claude')) === 'cli-inbox');
  ok("opencode/ACP v1: no live lane ⇒ 'stash' (and its queueVerbs deliberately omit 'steer' — session/prompt is one-at-a-time)", notificationDelivery(capsOf('opencode')) === 'stash' && !capsOf('opencode').inputModes.steer);
  ok("shell + an unknown backend ⇒ 'stash', never codex's lane by accident", notificationDelivery(capsOf('shell')) === 'stash' && notificationDelivery(capsOf('gemini')) === 'stash' && notificationDelivery(null) === 'stash');
  // THE DERIVATION LAW (the same one that makes inputModes.steer a view of
  // queueVerbs): an rpc-queue harness that cannot steer QUEUES — there is no
  // second place to declare "notifications steer", so a verb table and this
  // answer can never disagree.
  ok("a HYPOTHETICAL rpc-queue harness without the steer verb ⇒ 'queue' (derived, not declared)", notificationDelivery({ peerDelivery: 'rpc-queue', inputModes: { steer: false } }) === 'queue');
  ok('…and the same row WITH steer ⇒ steer', notificationDelivery({ peerDelivery: 'rpc-queue', inputModes: { steer: true } }) === 'steer');
  // the client mirrors peerDelivery next to inputModes and derives through the
  // SAME pure function — a drifted mirror would let Session Properties promise
  // a lane the server does not take (the S7 twin rule).
  for (const id of Object.keys(BACKEND_META)) {
    if (!BACKEND_META[id].caps) continue;
    ok(`${id}: client META caps.peerDelivery mirrors the server row`, BACKEND_META[id].caps.peerDelivery === capsOf(id).peerDelivery, `${BACKEND_META[id].caps.peerDelivery} vs ${capsOf(id).peerDelivery}`);
    ok(`${id}: notificationDeliveryFor(client) === notificationDelivery(server)`, notificationDeliveryFor(id) === notificationDelivery(BACKEND_CAPS[id]));
  }
}

// ── functional: real deliver.create() + real sidecar ──
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-peerdeliv-'));
fs.mkdirSync(path.join(dataDir, 'session-buffers'), { recursive: true });
const CID = '11111111-2222-4333-8444-555566667777';
const WID = 'sess-1-1000';
// sidecar shape = what codex-chat-wrapper.js writes (meta object incl. caps)
fs.writeFileSync(path.join(dataDir, 'session-buffers', WID + '.json'),
  JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: 'chat', backend: 'codex', threadId: CID, caps: { peerMessage: true } }));
const frames = [];
const activeSessions = new Map([[WID, {
  backend: 'codex', mode: 'chat', backendSessionId: CID, name: 'CxPeer', host: null,
  socketPath: path.join(dataDir, 'sockets', 'cw-' + WID),
  pty: { write: (s) => frames.push(s) },
}]]);
let cards = 0;
const deliver = require(path.join(REPO, 'src/server/conversation-deliver.js')).create({
  dataDir,
  peerMsg: { findPeer: () => null, postToPeer: async () => ({ ok: false, reason: 'unused' }), postChannelEvent: async () => ({ ok: false }) },
  getHosts: () => null, getConvIndex: () => null,
  serverSetting: () => false, activeSessions,
  emitPeerCard: () => { cards++; return true; },
  log: () => { },
});
const r = await deliver.deliverToConversation(CID, 'Message from session "A": hello codex', { fromName: 'A', cardText: 'hello codex' });
ok("a live codex session delivers on lane 'rpc-queue'", r.ok === true && r.lane === 'rpc-queue' && r.peerName === 'CxPeer', JSON.stringify(r));
const frame = frames.length === 1 ? JSON.parse(frames[0]) : null;
ok("…as ONE 'peer-message' stdin frame carrying the text", !!frame && frame.type === 'peer-message' && /hello codex/.test(frame.text));
ok('…plus the card label fields (fromName + cardText) the wrapper writes into its webui_peer marker (P1: labelled peer card, not a "You" bubble)', !!frame && frame.fromName === 'A' && frame.cardText === 'hello codex', JSON.stringify(frame));
ok('…and NO in-memory peer card is emitted (the wrapper record is the ONE carrier — 2.362.2: the party holding the information renders it; a card here double-renders live)', cards === 0);
ok("…and TYPED as a peer message by default (a human's message keeps its own turn)", frame.kind === 'peer' && r.kind === 'peer', JSON.stringify([frame.kind, r.kind]));
frames.length = 0;
await deliver.deliverToConversation(CID, 'unlabelled');
ok('…label fields are explicit nulls when the caller passes none (wrapper falls back to frame parsing)', frames.length === 1 && JSON.parse(frames[0]).fromName === null && JSON.parse(frames[0]).cardText === null);
ok('peerReachable() sees the live rpc peer', deliver.peerReachable(CID) === true);
// THE TYPED ORIGIN (2026-09-07): a notification says so on the wire, so the
// wrapper can steer it into the running turn instead of queueing a turn.
frames.length = 0;
const rn = await deliver.deliverToConversation(CID, '[VibeSpace Background Work] task "nightly" (job-1): done.', { fromName: 'Background Work · nightly', kind: 'notification' });
ok("a notification is TAGGED kind:'notification' on the frame AND in the result", frames.length === 1 && JSON.parse(frames[0]).kind === 'notification' && rn.kind === 'notification', frames[0]);
frames.length = 0;
await deliver.deliverToConversation(CID, 'hello', { fromName: 'A', kind: 'shout' });
ok('an UNKNOWN origin is normalised to peer — the conservative lane, never a silent steer', JSON.parse(frames[0]).kind === 'peer', frames[0]);
frames.length = 0;
await deliver.deliverToConversation(CID, 'hello again', { fromName: 'A' });
ok('…and so is an absent one (older callers keep their behaviour)', JSON.parse(frames[0]).kind === 'peer', frames[0]);

// negative control 1: sidecar without caps (old wrapper) ⇒ falls to the miss path
fs.writeFileSync(path.join(dataDir, 'session-buffers', WID + '.json'),
  JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: 'chat', backend: 'codex', threadId: CID }));
frames.length = 0;
const r2 = await deliver.deliverToConversation(CID, 'again');
ok('an old wrapper (no caps advert) is never sent the frame — honest miss instead', r2.ok === false && frames.length === 0, JSON.stringify(r2));

// negative control 2: a claude-backend session never takes the rpc lane
activeSessions.set(WID, { ...activeSessions.get(WID), backend: 'claude' });
fs.writeFileSync(path.join(dataDir, 'session-buffers', WID + '.json'),
  JSON.stringify({ pid: process.pid, startedAt: Date.now(), caps: { peerMessage: true, frameFile: true } }));
frames.length = 0;
const r3 = await deliver.deliverToConversation(CID, 'again2');
ok('a claude session never rides rpc-queue (registry gate, even with a caps-bearing sidecar)', r3.ok === false && frames.length === 0, JSON.stringify(r3));

// stash still works as the final rung
deliver.stashFor(CID, { source: 'agent', fromName: 'A', text: 'queued' });
ok('the stash rung is intact (queued + drained once)', deliver.drainStash(CID).length === 1 && deliver.drainStash(CID).length === 0);

// ── wrapper contract pins ──
const w = read('data/bin/codex-chat-wrapper.js');
// caps grew a NON-boolean member in 2026-09-07 (`queueVerbs`, the verb table the
// running wrapper serves) — the advert this suite owns is still peerMessage.
ok('the codex wrapper adverts caps.peerMessage in its sidecar meta', /caps: \{ peerMessage: true(, [a-zA-Z]+: (?:true|[A-Z_]+))* \}/.test(w), /caps: \{[^}]*\}/.exec(w)?.[0]);
ok("…serves the 'peer-message' verb: busy ⇒ thread/queue/add, idle ⇒ turn/start", /msg\.type === 'peer-message'/.test(w) && /meta\.activeTurnId\) \{[\s\S]{0,600}?await request\('thread\/queue\/add'/.test(w) && /noteQueued\(cid, \{ kind: 'peer', msgId: '', from: fromName, text \}\)/.test(w) && /await startTurn\(text\);/.test(w));
ok('…records the peer user message itself (item notifications never carry userMessage) — with the webui_peer marker, on both the queued and the turn path', /const recordPeerMessage = \(\) => record\('response_item', \{ type: 'message', role: 'user', content: \[\{ type: 'input_text', text \}\], webui_peer: \{ name: fromName, body: cardText \} \}\)/.test(w) && /thread\/queue\/add[\s\S]{0,400}recordPeerMessage\(\);/.test(w) && /await startTurn\(text\);\s*\n\s*recordPeerMessage\(\);/.test(w));
ok('…reports peer_message_result on EVERY lane, echoing text + fromName on failure so the server can re-stash with its label', /peer_message_result', \{ ok: true, mode: 'steered' \}/.test(w) && /peer_message_result', \{ ok: true, mode: 'queued', \.\.\.fell \}/.test(w) && /peer_message_result', \{ ok: true, mode: 'turn', \.\.\.fell \}/.test(w) && /peer_message_result', \{ ok: false, reason: e\.message, text, fromName \}/.test(w));
// the NOTIFICATION rule, at the wrapper: typed frame → steer lane; unknown
// origin → peer; the ACP wrapper has no steer verb and says so on the wire.
ok("…routes a kind:'notification' frame to turn/steer while busy, and leaves human peer messages on thread/queue/add", /const peerKind = msg\.kind === 'notification' \? 'notification' : 'peer';/.test(w) && /if \(peerKind === 'notification' && meta\.activeTurnId\)/.test(w) && /await steerInput\(encodeUserInput\(text, \[\]\), `notif-/.test(w));
{
  const acp = read('data/bin/acp-wrapper.js');
  ok('the ACP wrapper accepts the same typed frame and REPORTS that it cannot steer (ACP v1 has no such method) instead of silently queueing', /const peerKind = msg\.kind === 'notification' \? 'notification' : 'peer';/.test(acp) && /steer: 'unsupported'/.test(acp));
}
const cd = read('src/server/conversation-deliver.js');
ok('the LADDER tags the frame and never decides the lane itself (only the wrapper knows whether a turn is running)', /const kind = opts\.kind === 'notification' \? 'notification' : 'peer';/.test(cd) && /type: 'peer-message', text, fromName: opts\.fromName \|\| null, cardText: opts\.cardText \|\| null, kind \}/.test(cd));
const jb = read('src/jobs.js');
ok("jobs.js TYPES its owner notifications (the wiring pin: a rule with no call site is dead code)", /deliverToConversation\(cid, text, \{ fromName: 'Background Work · ' \+ \(job\.name \|\| job\.id\), kind: 'notification' \}\)/.test(jb));
const ar = read('src/agent-routes.js');
ok('…while vibespace-msg (a PERSON writing to another session) passes no kind at all ⇒ peer', /deliver\.deliverToConversation\(target\.cid, framed, \{ fromName, cardText: text \}\)/.test(ar) && !/msg\/send[\s\S]{0,2000}kind: 'notification'/.test(ar));
const sp = read('src/lib/session-props.js');
ok('Session Properties STATES the rule (derived from the caps row, never a backend id)', /notificationDeliveryFor\(s\.backend \|\| 'claude'\)/.test(sp) && /Steered into the running turn/.test(sp) && /carries only itself/.test(sp));
const cev = read('src/server/stdout/codex-events.js');
ok('a notification that could NOT be steered is LOUD about the lane it took instead (no silent divergence from the documented rule)', /msg\.payload\.ok === true && msg\.payload\.steerFailed/.test(cev) && /turn\/steer refused/.test(cev));

// ── wiring pins (the 2.355.0 lesson: a pure fix with an unstaged call site stays dead while unit tests glow green) ──
const srv = read('server.js');
ok('server.js DESTRUCTURES recordCodexQuotaSignal from the engine (was exported-but-never-wired: the whole codex quota chain silently dead)', /probeUsageViaSession, recordCodexQuotaSignal, recordRateLimitEvent/.test(srv));
ok('…and forwards it to session-stdout in the engine object', /modelsMatch, noteSessionProduced, noteTurnEnd, noteWallSignal, recordCodexQuotaSignal, recordRateLimitEvent, resolveUsageKey, usageEstimator \}/.test(srv));
ok('…and passes getDeliver for the re-stash fallback', /getDeliver: \(\) => \{ try \{ return deliver; \} catch \{ return null; \} \}/.test(srv));
const ss = read('src/server/stdout/codex-events.js'); // S5: the codex-events consumer module
ok('stdout/codex-events re-stashes on peer_message_result ok:false (a promised message is never silently lost), keeping the echoed label', /peer_message_result' && msg\.payload\.ok === false && msg\.payload\.text/.test(ss) && /stashFor\(cid, \{ source: 'agent', fromName: msg\.payload\.fromName \|\| null, text: String\(msg\.payload\.text\) \}\)/.test(ss));
const wf = read('src/server/wrapper-files.js');
ok('wrapperCaps surfaces peerMessage (stateless, negative verdicts never cached)', /peerMessage: !!\(caps && caps\.peerMessage\)/.test(wf));

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
