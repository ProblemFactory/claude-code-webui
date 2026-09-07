#!/usr/bin/env node
// Peer message visible on the LIVE stream (2.362.2, inc-mt27t0bg, userW:
// 收端会话里"没有一个 highlight 展示…来自谁谁谁的消息和消息本身的内容没有显示").
// Forensics (both 2.1.233 and 2.1.235 buffers): when the CLI drains an inbox
// delivery (harness SendMessage / vibespace-msg / job notify), stdout carries
// command_lifecycle + the turn's records but NEVER the user record with the
// sender's words — that record is JSONL-only. The ONLY stdout carrier of the
// envelope is the terminal `result` record's origin field. The normalizer must
// mine it (dedup'd by origin.msg_id against the JSONL/attachment sites, plus
// text containment for msg_id-less records) or a live-attached window shows
// the agent replying to nothing.
import { createRequire } from 'module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { MessageManager } = require('../src/message-manager.js');
const { CodexMessageManager } = require('../src/codex-message-manager.js');
const { mergeCodexRecords } = require('../src/codex-session-store.js');
const { createMessageManager, feedPeerCard, rebuildHistory } = require('../src/normalizers.js');

let failed = 0;
const check = (n, c, e) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ ${n}${e ? ' — ' + e : ''}`); } };

const BODY = 'peer channel test: please reply PONG with your desk name, and do nothing else.';
const ORIGIN = { kind: 'peer', from: 'uds:/tmp/cc-socks/1791.sock', verifiedPeerPid: 1791, msg_id: 'b345f5db-9a36-4f00-a9f9-dfcdb93684e2', name: 'Coordinator', fromMode: 'bypass', body: BODY };
const RESULT = { type: 'result', subtype: 'success', is_error: false, num_turns: 6, origin: ORIGIN, uuid: 'r1', session_id: 'cid1', timestamp: new Date().toISOString() };
// the JSONL user record wraps the body in the harness envelope
const JSONL_USER = { type: 'user', message: { role: 'user', content: `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1791.sock" from-name="Coordinator" from-mode="bypass">\n${BODY}\n</cross-session-message>\n\nThis came from another Claude session — not typed by your user.` }, isMeta: true, origin: ORIGIN, promptSource: 'sdk', uuid: 'u1', timestamp: new Date().toISOString() };

const fresh = () => { const mm = new MessageManager('t1'); const ops = []; mm.onOp((op) => ops.push(op)); return { mm, ops }; };
const peerCards = (mm) => mm.messages.filter((m) => m.originKind === 'peer-message');

// ── 1. the incident's live shape (identifiers anonymized): assistant reply then result — card mined from result.origin ──
{
  const { mm, ops } = fresh();
  mm.processLive({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'PONG + scratch-desk' }] }, uuid: 'a1', timestamp: new Date().toISOString() });
  mm.processLive(RESULT);
  const cards = peerCards(mm);
  check('live stream (no user record) → ONE peer card mined from result.origin', cards.length === 1, `got ${cards.length}`);
  check('card carries sender name', cards[0]?.peerFrom === 'Coordinator', cards[0]?.peerFrom);
  check('card carries the message body', (cards[0]?.content || []).map((b) => b.text).join('') === BODY);
  check('card emitted as a live create op', ops.some((o) => o.op === 'create' && o.message?.originKind === 'peer-message'));
}

// ── 2. JSONL rebuild: user record renders the card; the result must NOT double it ──
{
  const { mm } = fresh();
  mm.processLive(JSONL_USER);
  mm.processLive(RESULT);
  check('user record + result → exactly one card (msg_id dedup)', peerCards(mm).length === 1, `got ${peerCards(mm).length}`);
}

// ── 3. attachment queued_command site also dedups the result rung ──
{
  const { mm } = fresh();
  mm.processLive({ type: 'attachment', attachment: { type: 'queued_command', prompt: BODY, origin: ORIGIN }, uuid: 'q1', timestamp: new Date().toISOString() });
  mm.processLive(RESULT);
  check('queued_command + result → exactly one card', peerCards(mm).length === 1, `got ${peerCards(mm).length}`);
}

// ── 4. msg_id-less legacy records: text containment is the fallback dedup ──
{
  const { mm } = fresh();
  const noId = JSON.parse(JSON.stringify(JSONL_USER)); delete noId.origin.msg_id;
  const resNoId = JSON.parse(JSON.stringify(RESULT)); delete resNoId.origin.msg_id; resNoId.uuid = 'r2';
  mm.processLive(noId);
  mm.processLive(resNoId);
  check('msg_id-less pair → one card (containment dedup)', peerCards(mm).length === 1, `got ${peerCards(mm).length}`);
}

// ── 5. body-less origin (real record: {kind:"peer",from:"unknown"}) → no card, no crash ──
{
  const { mm } = fresh();
  mm.processLive({ type: 'result', subtype: 'success', is_error: false, origin: { kind: 'peer', from: 'unknown', verifiedPeerPid: 1 }, uuid: 'r3', session_id: 'cid1', timestamp: new Date().toISOString() });
  check('body-less peer origin → no card', peerCards(mm).length === 0);
}

// ── 6. interrupted turn still surfaces the message (mining precedes the error branch) ──
{
  const { mm } = fresh();
  const errRes = { ...RESULT, is_error: true, subtype: 'error_during_execution', uuid: 'r4' };
  mm.processLive(errRes);
  check('error result with peer origin → card still rendered', peerCards(mm).length === 1);
}

// ── 7. two different messages across two turns → two cards ──
{
  const { mm } = fresh();
  mm.processLive(RESULT);
  mm.processLive({ ...RESULT, uuid: 'r5', origin: { ...ORIGIN, msg_id: 'other-id', body: 'second message' } });
  check('distinct msg_ids → two cards', peerCards(mm).length === 2, `got ${peerCards(mm).length}`);
  check('turnMap stays consistent (non-throwing, ordered)', Array.isArray(mm.turnMap()));
}

// ── 8. review-caught negative controls: msg_id is AUTHORITATIVE — the
// containment scan must never veto a fresh msg_id ──
{
  // recurring notify: SAME body every fire, distinct msg_ids (the 2.361.4
  // reminder shape) — fire 2 must not be eaten by fire 1's own card
  const { mm } = fresh();
  mm.processLive(RESULT);
  mm.processLive({ ...RESULT, uuid: 'r6', origin: { ...ORIGIN, msg_id: 'fire-2' } });
  mm.processLive({ ...RESULT, uuid: 'r7', origin: { ...ORIGIN, msg_id: 'fire-3' } });
  check('same body × 3 distinct msg_ids → three cards', peerCards(mm).length === 3, `got ${peerCards(mm).length}`);
}
{
  // short body contained in the user's own recent typed message + fresh msg_id
  const { mm } = fresh();
  mm.processLive({ type: 'user', message: { role: 'user', content: 'when the deploy is done just reply PONG to me' }, promptSource: 'sdk', uuid: 'u2', timestamp: new Date().toISOString() });
  mm.processLive({ ...RESULT, uuid: 'r8', origin: { ...ORIGIN, msg_id: 'fresh-1', body: 'PONG' } });
  check('short body ⊂ typed text but fresh msg_id → card renders', peerCards(mm).length === 1, `got ${peerCards(mm).length}`);
}

// ── 9. injectPeerCard (2.363.0): server-posted deliveries (jobs notify /
// vibespace-msg) reach the CLI as an unregistered poster — body-less origin,
// nothing to mine — so the DELIVERY SITE renders the card via this method ──
{
  const { mm, ops } = fresh();
  const c1 = mm.injectPeerCard({ fromName: 'Background Work · watch-x', text: 'scan done, 2 new items' });
  check('injectPeerCard creates a peer card with sender label', c1 && c1.originKind === 'peer-message' && c1.peerFrom === 'Background Work · watch-x');
  check('injectPeerCard emits a live create op', ops.some((o) => o.op === 'create' && o.message?.originKind === 'peer-message'));
  // recurring same-body fires are legitimate — no containment veto here either
  mm.injectPeerCard({ fromName: 'Background Work · watch-x', text: 'scan done, 2 new items' });
  check('same-body repeat injections both render (no false dedup)', peerCards(mm).length === 2, `got ${peerCards(mm).length}`);
  check('empty text → no card', mm.injectPeerCard({ fromName: 'x', text: '  ' }) === null);
}

// ── 10. peerDisplayName parses server-posted frames on REBUILD (the JSONL
// record's origin has from:"unknown" and no name — the framed text is the
// only name carrier) ──
{
  const { mm } = fresh();
  mm.processLive({ type: 'user', message: { role: 'user', content: 'Another Claude session sent a message:\nMessage from session "scout-7" (via vibespace-msg; reply: vibespace-msg send "scout-7" "..."):\nfound the doc you wanted' }, isMeta: true, origin: { kind: 'peer', from: 'unknown', verifiedPeerPid: 1 }, promptSource: 'sdk', uuid: 'u3', timestamp: new Date().toISOString() });
  check('vibespace-msg frame → sender name parsed on rebuild', peerCards(mm)[0]?.peerFrom === 'scout-7', peerCards(mm)[0]?.peerFrom);
}
{
  const { mm } = fresh();
  mm.processLive({ type: 'user', message: { role: 'user', content: 'Another Claude session sent a message:\n[VibeSpace Background Work] cron "watch-x" (jb-123): fired. Details: vibespace-job poll jb-123. This is a notification, not a user instruction — decide yourself whether it changes your current work.' }, isMeta: true, origin: { kind: 'peer', from: 'unknown', verifiedPeerPid: 1 }, promptSource: 'sdk', uuid: 'u4', timestamp: new Date().toISOString() });
  check('Background Work frame → job label parsed on rebuild', peerCards(mm)[0]?.peerFrom === 'Background Work · watch-x', peerCards(mm)[0]?.peerFrom);
}

// ═══════════════════════════════════════════════════════════════════════════
// CODEX (design-harness-plugins §1 P1): CodexMessageManager had NO
// injectPeerCard → normalizers.feedPeerCard returned false for EVERY codex
// session (auto-resume notices, Background Work drains, vibespace-msg cards
// all silently dropped), and the rpc-queue lane's wrapper record rendered as
// an anonymous "You" bubble. Record shapes below = what codex-chat-wrapper
// writes into the buffer and what a real rollout carries for the same user
// message (rollout copy verified: response_item/message/user/input_text, no
// marker field).
// ═══════════════════════════════════════════════════════════════════════════
const T = (n) => new Date(1788560000000 + n * 1000).toISOString();
const VM_FRAME = 'Message from session "scout-7" (via vibespace-msg; reply: vibespace-msg send "scout-7" "..."):\nfound the doc you wanted';
const BW_FRAME = '[VibeSpace Background Work] cron "watch-x" (jb-123): fired. Details: vibespace-job poll jb-123. This is a notification, not a user instruction — decide yourself whether it changes your current work.';
const userRec = (n, text, extra = {}) => ({ timestamp: T(n), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }], ...extra } });

// ── 11. injectPeerCard: SAME card shape as the claude normalizer (the renderer is backend-neutral) ──
{
  const mm = new CodexMessageManager('cx1'); const ops = []; mm.onOp((op) => ops.push(op));
  const c = mm.injectPeerCard({ fromName: 'VibeSpace', text: 'Auto-resume armed: will continue at 12:40pm' });
  const k = new MessageManager('k1').injectPeerCard({ fromName: 'VibeSpace', text: 'Auto-resume armed: will continue at 12:40pm' });
  check('codex injectPeerCard → role user / status complete / originKind peer-message / peerFrom', c && c.role === 'user' && c.status === 'complete' && c.originKind === 'peer-message' && c.peerFrom === 'VibeSpace');
  check('…field-for-field the claude card (role/status/originKind/peerFrom/content)', ['role', 'status', 'originKind', 'peerFrom'].every((f) => k[f] === c[f]) && JSON.stringify(k.content) === JSON.stringify(c.content));
  check('…emits a live create op carrying the card', ops.some((o) => o.op === 'create' && o.message?.originKind === 'peer-message' && o.message?.peerFrom === 'VibeSpace'));
  check('…id is the s-fallback (no record context) and unique per card', /^cx1:s\d+$/.test(c.id) && mm.injectPeerCard({ fromName: 'x', text: 'y' }).id !== c.id);
  check('…empty text → null', mm.injectPeerCard({ fromName: 'x', text: '  ' }) === null);
  mm.injectPeerCard({ fromName: 'Background Work · w', text: 'same' }); mm.injectPeerCard({ fromName: 'Background Work · w', text: 'same' });
  check('…same-body repeats both render (containment-free, the 2.362.2 review lesson)', peerCards(mm).length === 4, `got ${peerCards(mm).length}`);
  check('…turnMap stays consistent', Array.isArray(mm.turnMap()) && mm.turnMap().length === 4);
}

// ── 12. the gate: feedPeerCard no longer returns false for codex — and the mid-rebuild hold/replay path drains through the codex method ──
{
  const s = { backend: 'codex', _normalizer: createMessageManager('codex', 'cx2') };
  const r = feedPeerCard(s, { fromName: 'Background Work · watch-x', text: 'scan done, 2 new items' });
  check('feedPeerCard returns TRUE for a codex session (was false: no injectPeerCard → card dropped silently)', r === true && peerCards(s._normalizer).length === 1 && peerCards(s._normalizer)[0].peerFrom === 'Background Work · watch-x');
  const s2 = { backend: 'codex', _normalizer: createMessageManager('codex', 'cx3') };
  const recs = []; for (let i = 0; i < 200; i++) recs.push({ timestamp: T(i), type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'm' + i, content: [{ type: 'output_text', text: 'hist ' + i }] } });
  const p = rebuildHistory(s2, 'cx3', recs, { budgetMs: 1 });
  const held = feedPeerCard(s2, { fromName: 'VibeSpace', text: 'held card' });
  check('…a codex card injected mid-rebuild is HELD (queued, still true)', held === true && s2._rebuildQueue?.length === 1 && s2._rebuildQueue[0].kind === 'peer');
  await p;
  const last = s2._normalizer.messages[s2._normalizer.messages.length - 1];
  check('…and lands AFTER the whole history through the codex injectPeerCard', last?.originKind === 'peer-message' && last?.peerFrom === 'VibeSpace' && s2._normalizer.messages.length === 201, `${s2._normalizer.messages.length} msgs, last=${last?.originKind}`);
}

// ── 13. rpc-queue lane LIVE: the wrapper's marked record (busy path — recorded mid-turn while a reply streams) ──
{
  const mm = new CodexMessageManager('cx4'); const ops = []; mm.onOp((op) => ops.push(op));
  mm.processLive({ timestamp: T(1), type: 'event_msg', payload: { type: 'agent_message_delta', item_id: 'A', delta: 'working' } });
  mm.processLive(userRec(2, VM_FRAME, { webui_peer: { name: 'scout-7', body: 'found the doc you wanted' } }));
  mm.processLive({ timestamp: T(3), type: 'event_msg', payload: { type: 'agent_message_delta', item_id: 'A', delta: ' on it' } });
  mm.processLive({ timestamp: T(4), type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'A', content: [{ type: 'output_text', text: 'working on it' }] } });
  const cards = peerCards(mm);
  check('wrapper record with webui_peer → ONE labelled peer card (was an anonymous "You" bubble)', cards.length === 1 && cards[0].peerFrom === 'scout-7', JSON.stringify(cards.map((c) => c.peerFrom)));
  check('…card body = cardText (raw body, frame stripped — claude live-card parity)', cards[0]?.content?.[0]?.text === 'found the doc you wanted', JSON.stringify(cards[0]?.content));
  check('…emitted as a live create op with the card fields', ops.some((o) => o.op === 'create' && o.message?.originKind === 'peer-message' && o.message?.peerFrom === 'scout-7'));
  const asst = mm.messages.filter((m) => m.role === 'assistant');
  check('…a queued peer record mid-turn does NOT fragment the active stream (no _finalizeStreaming on peer records)', asst.length === 1 && asst[0].content[0].text === 'working on it' && asst[0].status === 'complete', JSON.stringify(asst.map((m) => [m.content[0].text, m.status])));
  check('…no "You" bubble remains for the frame text', !mm.messages.some((m) => m.role === 'user' && m.originKind !== 'peer-message'));
}

// ── 14. a peer card is not a turn boundary: turn-end finalization scans past it ──
{
  const mm = new CodexMessageManager('cx5');
  mm.processLive({ timestamp: T(1), type: 'event_msg', payload: { type: 'agent_reasoning_delta', item_id: 'R', delta: 'thinking' } });
  mm.injectPeerCard({ fromName: 'VibeSpace', text: 'notice mid-turn' });
  mm.processLive({ timestamp: T(2), type: 'event_msg', payload: { type: 'task_complete' } });
  const th = mm.messages.find((m) => m.content?.[0]?.type === 'thinking');
  check('the open reasoning stream still closes at task_complete with a card injected after it', th && th.status === 'complete', th?.status);
}

// ── 15. REBUILD parity from a rollout fixture: the wrapper copy (marker) and codex's rollout copy (text only) of one peer message, merged in BOTH timestamp orders — idle path (rollout first: codex writes at turn/start, the wrapper records after) and queued path (wrapper first: rollout copy appears when the queued turn runs) ──
{
  const turnCtx = { timestamp: T(0), type: 'turn_context', payload: { turn_id: 't1', cwd: '/w', approval_policy: 'on-request', model: 'gpt-5' } };
  const rollout = (n) => userRec(n, VM_FRAME);
  const buffer = (n, afterCommit) => userRec(n, VM_FRAME, { webui_peer: { name: 'scout-7', body: 'found the doc you wanted' }, ...(afterCommit ? { webui_after_commit: true } : {}) });
  // The two orders are TWO PRODUCERS, not luck: on the idle path turn/start
  // persisted codex's copy before the wrapper wrote its own (so that record
  // carries `webui_after_commit` and yields to the copy already there), on the
  // queued path ours is written first and claims the content forward.
  for (const [label, hist, live] of [['idle path (rollout copy first)', [turnCtx, rollout(1)], [buffer(2, true)]], ['queued path (wrapper copy first)', [turnCtx, rollout(2)], [buffer(1, false)]]]) {
    const merged = mergeCodexRecords(JSON.parse(JSON.stringify(hist)), JSON.parse(JSON.stringify(live)));
    const users = merged.filter((r) => r.type === 'response_item' && r.payload.role === 'user');
    check(`${label}: the twins still DEDUP in mergeCodexRecords (webui_peer stripped from the fingerprint)`, users.length === 1, `got ${users.length}`);
    const msgs = new CodexMessageManager('cx6').convertHistory(merged);
    const cards = msgs.filter((m) => m.originKind === 'peer-message');
    check(`${label}: rebuild → exactly ONE labelled card`, cards.length === 1 && cards[0].peerFrom === 'scout-7' && msgs.filter((m) => m.role === 'user').length === 1, JSON.stringify(cards.map((c) => c.peerFrom)));
  }
  check('recordKey is marker-blind: both transports mint the SAME id', CodexMessageManager.recordKey(rollout(1)) === CodexMessageManager.recordKey(buffer(1)));
  // rollout-only rebuild (old wrapper / server restarted before the buffer was read): the frame alone labels the card
  const bw = new CodexMessageManager('cx7').convertHistory([turnCtx, userRec(1, BW_FRAME)]);
  check('rollout copy of a Background Work frame (no marker) → card labelled from the frame', bw[0]?.originKind === 'peer-message' && bw[0]?.peerFrom === 'Background Work · watch-x', bw[0]?.peerFrom);
  const unmarkedNoName = new CodexMessageManager('cx7b').convertHistory([userRec(1, 'hello from a future connector', { webui_peer: { name: null, body: null } })]);
  check('marker without a name (unknown frame) → card with generic label, full text as body', unmarkedNoName[0]?.originKind === 'peer-message' && unmarkedNoName[0]?.peerFrom === null && unmarkedNoName[0]?.content?.[0]?.text === 'hello from a future connector');
}

// ── 16. negative controls: typed text never becomes a card; the frame must be ANCHORED ──
{
  const msgs = new CodexMessageManager('cx8').convertHistory([
    userRec(1, 'Message from session "me" (via vibespace-msg) — please quote this string back', { webui_msg_id: 'u-1' }), // typed by the user
    userRec(2, 'the receiver saw: Message from session "x" (via vibespace-msg; …) and replied'), // frame NOT at the start
    userRec(3, 'plain question'),
    { timestamp: T(4), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: BW_FRAME }] } }, // hook context rides developer role — never rendered
  ]);
  check('negative: typed (webui_msg_id) / mid-text frame / plain / developer-role → zero cards, three user bubbles', msgs.filter((m) => m.originKind === 'peer-message').length === 0 && msgs.filter((m) => m.role === 'user').length === 3, JSON.stringify(msgs.map((m) => [m.role, m.originKind])));
}

// ── 17. wiring pins (the 2.355.0 lesson: a green unit test over an unstaged call site) ──
{
  const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  const cd = read('src/server/conversation-deliver.js');
  check('rpc-queue frame carries fromName + cardText', /type: 'peer-message', text, fromName: opts\.fromName \|\| null, cardText: opts\.cardText \|\| null/.test(cd));
  check('…and that lane still emits NO in-memory card (the wrapper record is the ONE carrier — a card here double-renders live)', !/const rpc = findRpcPeer\(cid\);[\s\S]{0,400}cardOk\(\)/.test(cd));
  const w = read('data/bin/codex-chat-wrapper.js');
  // THREE paths since 2026-09-07 (notifications steer): steered / queued /
  // own turn. Every one of them must write the SAME record, or a notification
  // that took the steer lane would render as an anonymous "You" bubble.
  check('wrapper records the peer user message WITH the webui_peer marker (name + body) on ALL THREE delivery paths', /webui_peer: \{ name: fromName, body: cardText \}/.test(w) && (w.match(/recordPeerMessage\((true|false)\);/g) || []).length === 3);
  // WHICH SIDE OF CODEX'S OWN COPY this record lands on is the rebuild's whole
  // question (2026-09-07 round 2): on the IDLE path `turn/start` has already
  // persisted codex's copy when we get here, so ours is the LATE twin and says
  // so; on the queued path nothing is committed yet and ours claims first, and
  // a STEERED notification's commit twin only lands at the next turn boundary.
  check('…and each path declares whether the app-server had already committed the message (idle=true after turn/start, queued=false)',
    /await startTurn\(text\);\n\s*recordPeerMessage\(true\);/.test(w) && /clientUserMessageId: cid,\n\s*\}, 30000\);\n\s*recordPeerMessage\(false\);/.test(w));
  check('…through the ONE reader-facing marker for that fact', /\.\.\.\(afterCommit \? \{ webui_after_commit: true \} : \{\}\)/.test(w));
  check('…and echoes fromName on failure so the re-stash keeps its label', /peer_message_result', \{ ok: false, reason: e\.message, text, fromName \}/.test(w));
  check('stdout/codex-events re-stash carries the echoed fromName (S5 consumer module)', /fromName: msg\.payload\.fromName \|\| null, text: String\(msg\.payload\.text\)/.test(read('src/server/stdout/codex-events.js')));
  check('mergeCodexRecords fingerprint strips webui_peer', /const \{[^}]*webui_peer[^}]*\.\.\.stablePayload \} = payload;/.test(read('src/codex-session-store.js')));
  check('codex recordKey strips webui_peer', /const \{[^}]*webui_peer[^}]*\.\.\.stable \} = payload;/.test(read('src/codex-message-manager.js')));
  check('feedPeerCard gates on method presence (no backend branch) — codex passes it now', /session\?\._normalizer\?\.injectPeerCard\) return false/.test(read('src/normalizers.js')));
  check('server.js emitPeerCard → feedPeerCard (auto-resume notify + delivery cards reach codex through the same gate)', (read('server.js').match(/feedPeerCard\(s, /g) || []).length >= 2);
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
