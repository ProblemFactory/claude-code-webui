#!/usr/bin/env node
// First-attach history rebuild must not stall the server, and the things a
// stall broke must be robust (2.369.16, userW inc-mtndq0vb "无法打开也没法
// terminate，卡死了"): after a restart every chat session's first attach ran a
// SYNC convertHistory over its whole transcript on the main thread (userW:
// 58 sessions, 1.35GB); a 19-window reconnect storm stalled the loop ~4min,
// the heartbeat blamed the client for the missing pong and terminated it,
// and the kills queued on that socket vanished. Three layers, functional:
//   ① convertHistoryAsync = same output as convertHistory, yields to the loop
//   ② rebuildHistory holds live records back and replays them IN ORDER,
//      single-flight for concurrent attaches, _historyLoaded only after success
//   ③ the heartbeat skips terminating on a stalled tick; the kill handler
//      acknowledges the requester; the client re-sends kills until acked
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };

const { createMessageManager, feedLive, feedPeerCard, rebuildHistory } = require(path.join(REPO, 'src/normalizers.js'));
const { createWsHeartbeat } = require(path.join(REPO, 'src/server/ws-heartbeat.js'));

// ── a realistic transcript: N turns of user → assistant(text+tool_use) → user(tool_result) → assistant → result
function makeRecords(turns) {
  const recs = [];
  let ts = 1788550000000;
  for (let i = 0; i < turns; i++) {
    const tu = `toolu_${i}`;
    recs.push({ type: 'user', uuid: `u${i}`, timestamp: new Date(ts += 1000).toISOString(), message: { role: 'user', content: `question ${i}` } });
    recs.push({ type: 'assistant', uuid: `a${i}`, timestamp: new Date(ts += 1000).toISOString(), message: { id: `msg_${i}`, role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: `thinking about ${i}` }, { type: 'tool_use', id: tu, name: 'Bash', input: { command: `echo ${i}` } }] } });
    recs.push({ type: 'user', uuid: `r${i}`, timestamp: new Date(ts += 1000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: `out ${i}` }] } });
    recs.push({ type: 'assistant', uuid: `b${i}`, timestamp: new Date(ts += 1000).toISOString(), message: { id: `msg_${i}b`, role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: `answer ${i}` }] } });
    recs.push({ type: 'result', subtype: 'success', timestamp: new Date(ts += 1000).toISOString(), duration_ms: 10, total_cost_usd: 0.01 });
  }
  return recs;
}
const strip = (msgs) => JSON.stringify(msgs.map((m) => ({ ...m, ts: undefined })));

// ── ① parity + yielding ──
{
  const recs = makeRecords(1500);
  const sync = createMessageManager('claude', 'same-id'); sync.convertHistory(recs);
  const asyncMM = createMessageManager('claude', 'same-id'); // ids embed the session id — same id ⇒ byte-comparable
  let ticks = 0; const iv = setInterval(() => ticks++, 1);
  await asyncMM.convertHistoryAsync(recs, { budgetMs: 5 });
  clearInterval(iv);
  ok(sync.total > 1500 && sync.total === asyncMM.total, `async rebuild yields the same message count as sync (${asyncMM.total})`);
  ok(strip(sync.messages) === strip(asyncMM.messages), 'and byte-identical normalized messages (ids, roles, merged tool calls)');
  ok(ticks >= 1, `the loop actually turned during the rebuild (${ticks} timer ticks — the sync path gives 0)`);
  const csync = createMessageManager('codex', 'c1'), casync = createMessageManager('codex', 'c2');
  ok(typeof casync.convertHistoryAsync === 'function' && typeof csync.convertHistory === 'function', 'codex normalizer carries the same async seam (registry parity, no claude-only path)');
}

// ── ② rebuild gate: live records queue behind the rebuild and replay in order; single-flight ──
{
  const recs = makeRecords(600);
  const ops = [];
  const session = { backend: 'claude', _normalizer: createMessageManager('claude', 's'), _historyLoaded: false };
  session._normalizer.onOp((op) => ops.push(op));
  const p1 = rebuildHistory(session, 's', recs, { budgetMs: 2 });
  const p2 = rebuildHistory(session, 's', recs, { budgetMs: 2 });
  ok(p1 === p2, 'a second attach during the rebuild awaits the SAME promise (single-flight — no double rebuild)');
  ok(Array.isArray(session._rebuildQueue) && session._historyLoaded === false, 'while rebuilding: the queue is armed and _historyLoaded is still false (set only after success)');
  // a live turn arrives mid-rebuild
  const live1 = { type: 'user', uuid: 'live-u', timestamp: new Date(1788560000000).toISOString(), message: { role: 'user', content: 'LIVE question' } };
  const live2 = { type: 'assistant', uuid: 'live-a', timestamp: new Date(1788560001000).toISOString(), message: { id: 'msg_live', role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'LIVE answer' }] } };
  feedLive(session, live1); feedLive(session, live2);
  ok(session._rebuildQueue.length === 2 && !session._normalizer.messages.some((m) => JSON.stringify(m.content).includes('LIVE')), 'live records are HELD (queued, not in the normalizer) while history converts');
  await p1;
  ok(session._historyLoaded === true && session._rebuildQueue === null && session._rebuildPromise === null, 'after the rebuild: flag set, queue disarmed, promise cleared');
  const msgs = session._normalizer.messages;
  const iLive = msgs.findIndex((m) => JSON.stringify(m.content).includes('LIVE question'));
  const iLast = msgs.length - 1;
  ok(iLive > 0 && iLive >= msgs.length - 2 && JSON.stringify(msgs[iLast].content).includes('LIVE answer'), `queued live records land AFTER the whole history, in order (live at ${iLive}/${iLast})`);
  ok(ops.some((o) => o.op === 'create' && JSON.stringify(o.message?.content || '').includes('LIVE question')), 'replayed live records EMIT ops (clients see them) — history records do not');
  ok(ops.filter((o) => o.op === 'create').length <= 4, `history conversion stays silent (${ops.filter((o) => o.op === 'create').length} create ops, all from the 2 live records)`);
  // after the gate is down, feedLive is a plain processLive
  const before = session._normalizer.total;
  feedLive(session, { type: 'user', uuid: 'later', timestamp: new Date(1788560002000).toISOString(), message: { role: 'user', content: 'later' } });
  ok(session._normalizer.total === before + 1, 'with no rebuild in flight feedLive processes immediately');
  // peer cards use the same gate
  {
    const s2 = { backend: 'claude', _normalizer: createMessageManager('claude', 'pc') };
    const p = rebuildHistory(s2, 'pc', makeRecords(300), { budgetMs: 1 });
    feedPeerCard(s2, { fromName: 'Background Work', text: 'job done' });
    ok(s2._rebuildQueue.length === 1 && s2._rebuildQueue[0].kind === 'peer', 'a peer card injected mid-rebuild is HELD like a live record');
    await p;
    const last = s2._normalizer.messages[s2._normalizer.messages.length - 1];
    ok(JSON.stringify(last).includes('job done'), 'and lands after the whole history');
  }
  // FIFO: two sessions rebuilding at once finish in order, the first one early
  {
    const sA = { backend: 'claude', _normalizer: createMessageManager('claude', 'A') };
    const sB = { backend: 'claude', _normalizer: createMessageManager('claude', 'B') };
    const order = [];
    const pA = rebuildHistory(sA, 'A', makeRecords(400), { budgetMs: 1 }).then(() => order.push('A'));
    const pB = rebuildHistory(sB, 'B', makeRecords(400), { budgetMs: 1 }).then(() => order.push('B'));
    await Promise.all([pA, pB]);
    ok(order.join('') === 'AB', 'rebuilds are serialized FIFO (the first window opens early instead of every window landing at the total time)');
  }
  // a FAILED rebuild still drains what was held (never lose a live record)
  {
    const sF = { backend: 'claude', _normalizer: createMessageManager('claude', 'F') };
    const boom = { convertHistoryAsync: async () => { throw new Error('boom'); }, processLive(m) { this.got = (this.got || 0) + 1; }, listeners: [], onOp() {}, messages: [], total: 0 };
    const realCreate = createMessageManager;
    // simulate via a normalizer whose convert throws: swap the freshly created mm's method
    const p = rebuildHistory(sF, 'F', makeRecords(50), { budgetMs: 1 });
    sF._normalizer.convertHistoryAsync = boom.convertHistoryAsync; // the promise chain calls it lazily (FIFO turn)
    feedLive(sF, { type: 'user', uuid: 'held', timestamp: new Date(1788560002000).toISOString(), message: { role: 'user', content: 'held during failure' } });
    let threw = false; try { await p; } catch { threw = true; }
    ok(threw === false || sF._historyLoaded !== true, 'a failing rebuild rejects/does not flag loaded');
    ok(sF._rebuildQueue === null && sF._normalizer.messages.some((m) => JSON.stringify(m.content).includes('held during failure')), 'the held record was drained into the normalizer anyway (never dropped)');
    void realCreate;
  }
  // a throwing record mid-history does not amputate the rebuild (2.89.2 rule kept)
  const bad = { backend: 'claude', _normalizer: createMessageManager('claude', 'b') };
  const recs2 = makeRecords(5); recs2.splice(3, 0, { type: 'assistant', message: null, timestamp: 'x' });
  await rebuildHistory(bad, 'b', recs2, { budgetMs: 1 });
  ok(bad._historyLoaded === true && bad._normalizer.total >= 15, 'a malformed record is skipped, not fatal — the flag still lands');
}

// ── ③ heartbeat: stall-aware ──
{
  let now = 1000000;
  const mk = () => { const c = { _isAlive: true, pings: 0, term: 0, ping() { this.pings++; }, terminate() { this.term++; } }; return c; };
  const a = mk(), b = mk();
  const wss = { clients: new Set([a, b]) };
  const hb = createWsHeartbeat(wss, { intervalMs: 30000, stallGraceMs: 5000, now: () => now, log: { warn() {} } });
  hb.start(); clearInterval(wss._heartbeatTimer); clearInterval(wss._heartbeatPulse);
  // production runs a 1s pulse; the fake clock must feed it too, else every 30s jump reads as a 30s loop gap
  const advance = (ms) => { for (let i = 0; i < ms; i += 1000) { now += Math.min(1000, ms - i); hb.pulse(); } };
  advance(30000); let r = hb.tick();
  ok(!r.stalled && r.terminated === 0 && a._isAlive === false && r.pinged === 2, 'on-time tick: everyone pinged, nobody terminated');
  b._isAlive = true; // b ponged, a did not
  advance(30000); r = hb.tick();
  ok(!r.stalled && r.terminated === 1 && a.term === 1 && b.term === 0, 'on-time tick after a REAL missed pong: that client is terminated (half-open detection kept)');
  wss.clients.delete(a); // a real wss drops a terminated client from the set ('close' fires)
  // now a stall: the tick fires 4 minutes late while b's pong sits unread
  b._isAlive = false;
  now += 30000 + 240000; r = hb.tick();
  ok(r.stalled && r.terminated === 0 && b.term === 0 && b.pings === 3, 'a tick that fires 4min LATE terminates nobody — the missed pong was measured across our own stall — and re-pings');
  b._isAlive = true;
  advance(30000); r = hb.tick();
  ok(!r.stalled && r.terminated === 0, 'the next on-time tick judges normally (client answered → kept)');
  advance(35001); r = hb.tick();
  ok(r.stalled, 'the grace threshold is strict (>5s late = stalled)');
  // ② the blind band the review found: a 32s block right after the ping — the tick is only 2s late but the pong sat unread
  b._isAlive = true; advance(30000); r = hb.tick(); ok(!r.stalled, '(reset) on-time tick');
  b._isAlive = false; // ping sent; pong will not be READ until the loop frees
  now += 1000; hb.pulse(); now += 32000; hb.pulse(); // one pulse gap of 32s = the block
  r = hb.tick(); // fires at +33s → only 3s late
  ok(r.stalled && r.terminated === 0 && b.term === 0 && r.maxGapMs >= 30000, 'a 32s loop gap inside the round taints it even though the tick is only 3s late (pulse detector) — the live client survives');
  // bound: pong-less across MANY tainted rounds → terminated anyway
  let tainted = 0;
  for (let i = 0; i < 8 && b.term === 0; i++) { now += 1000; hb.pulse(); now += 30000; hb.pulse(); r = hb.tick(); if (r.stalled) tainted++; }
  ok(b.term === 1 && tainted >= 6, `a client that never pongs across ${tainted} consecutive tainted rounds is terminated anyway (dead half-open under a chronically stalling server is still reaped)`);
  const src = fs.readFileSync(path.join(REPO, 'src/ws-handler.js'), 'utf8');
  ok(/createWsHeartbeat\(wss\)\.start\(\)/.test(src) && !/setInterval\(\(\) => \{\s*for \(const client of wss\.clients\)/.test(src), 'ws-handler runs THIS heartbeat (the inline blind interval is gone)');
}

// ── wiring pins (the 2.331.0 lesson: a fix with an unstaged call site is dead) ──
{
  const wsh = fs.readFileSync(path.join(REPO, 'src/ws-handler.js'), 'utf8');
  const so = fs.readFileSync(path.join(REPO, 'src/server/session-stdout.js'), 'utf8');
  // S5: the three parse pipelines live in src/server/stdout/<protocol>.js — the live-feed sites moved with them
  const stdoutDir = fs.readdirSync(path.join(REPO, 'src/server/stdout')).filter((f) => f.endsWith('.js')).map((f) => 'src/server/stdout/' + f);
  const consumers = stdoutDir.map((f) => fs.readFileSync(path.join(REPO, f), 'utf8')).join('\n');
  ok(/await rebuildHistory\(session, data\.sessionId, sm\.raw\(\)\)/.test(wsh), 'attach rebuilds through rebuildHistory (time-sliced + gated)');
  ok(!/session\._normalizer\.convertHistory\(/.test(wsh), 'no sync session-normalizer convertHistory left in the ws attach path');
  const serverSide = ['server.js', 'src/ws-handler.js', 'src/ws-create.js', 'src/agent-routes.js', 'src/routes/sessions.js', ...fs.readdirSync(path.join(REPO, 'src/server')).filter((f) => f.endsWith('.js')).map((f) => 'src/server/' + f), ...stdoutDir]
    .map((f) => fs.readFileSync(path.join(REPO, f), 'utf8')).join('\n');
  const direct = (serverSide.match(/_normalizer\??\.processLive\(/g) || []).length;
  const directCards = (serverSide.match(/_normalizer\??\.injectPeerCard\??\(/g) || []).length;
  ok(direct === 0, `every live-feed site across server.js + src/server + ws-handler goes through feedLive (direct _normalizer.processLive calls: ${direct})`);
  ok(directCards === 0, `every peer-card writer (Background Work notify, vibespace-msg, auto-resume notice) goes through feedPeerCard (direct injectPeerCard calls: ${directCards})`);
  ok((wsh.match(/feedLive\(session, /g) || []).length === 2 && (consumers.match(/feedLive\(session, /g) || []).length === 4 && (so.match(/feedLive\(session, /g) || []).length === 0, 'the six known live sites (chat-input echo, permission payload, stdout consumers ×4: codex / acp non-acp frames / acp records / claude — session-stdout itself feeds nothing since S5) are all gated');
  ok(/type: 'killed', sessionId: requestedKillId, resolvedId: data\.sessionId, ok: true/.test(wsh) && /type: 'killed', sessionId: requestedKillId, resolvedId: data\.sessionId, ok: false, reason: 'not-found'/.test(wsh), "kill replies 'killed' to the REQUESTER in both outcomes, carrying the id the client ASKED for (the 2.179.0 remap must not orphan the request)");
  ok(/const requestedKillId = data\.sessionId;[\s\S]{0,400}data\.sessionId = eid; break;/.test(wsh), 'the requested id is captured BEFORE the stale-id remap');
  ok(/activeSessions\.get\(data\.sessionId\) !== session\) \{[\s\S]{0,200}code: 'ended-during-attach'/.test(wsh), 'attach re-checks liveness after the rebuild — a session killed meanwhile gets an error, never a live-looking attached');
  ok(/type: 'attach-ack', sessionId: data\.sessionId, progress:/.test(wsh) && /clearInterval\(progressTimer\)/.test(wsh), 'the rebuild window re-acks every 10s with progress (and the timer is cleared in finally)');
  ok(!/mm\.convertHistory\(sm\.raw\(\)\)/.test(wsh) && !/subMM\.convertHistory\(rawMsgs\)/.test(wsh), 'view-only and subagent attaches convert async too (boot replay opens N dead-session windows at once)');
  const ts = fs.readFileSync(path.join(REPO, 'src/transcript-service.js'), 'utf8');
  ok(/await session\._rebuildPromise/.test(ts) && /await mm\.convertHistoryAsync\(sm\.raw\(\)\)/.test(ts) && !/mm\.convertHistory\(sm\.raw\(\)\)/.test(ts), 'transcript-service.view joins an in-flight rebuild and never converts a whole transcript synchronously (the HTTP re-entry of the stall)');
  const sl = fs.readFileSync(path.join(REPO, 'src/lib/session-lifecycle.js'), 'utf8');
  ok(/killSession\(webuiId, backendSessionId\) \{[\s\S]{0,900}resend: true/.test(sl), 'client killSession = ws.request with resend:true (re-sent on every reconnect until acknowledged)');
  ok(/const cancel = this\.ws\.request\(msg[\s\S]{0,200}onTimeout: \(\) => cancel\(\)/.test(sl), 'the kill watchdog DISARMS the request (ws.request leaves the handler live on timeout)');
  ok(/if \(backendSessionId\) this\.ws\.send\(\{ type: 'kill', sessionId: webuiId, backendSessionId \}\);/.test(sl) && /const msg = \{ type: 'kill', sessionId: webuiId \};/.test(sl), 'the backendSessionId (stale-id fallback) frame is a ONE-SHOT — only the plain kill rides the resend chase, so a resend can never kill a resumed successor');
  const cvsrc = fs.readFileSync(path.join(REPO, 'src/lib/chat-view.js'), 'utf8');
  ok(/const freshAck = acked && Date\.now\(\) - this\._lastAttachAckAt < 30000/.test(cvsrc) && /if \(!freshAck\) waits\+\+;/.test(cvsrc), 'the re-attach ladder keeps waiting while fresh progress acks arrive (bounded 15min) instead of flipping read-only at 2 minutes');
  const clientKillSends = ['src/lib/session-lifecycle.js', 'src/lib/chat-view.js', 'src/lib/manage-agents.js', 'src/lib/session-card.js', 'src/lib/taskbar.js', 'src/lib/sidebar-workbench.js', 'src/lib/setup-flows.js', 'src/lib/app.js']
    .map((f) => fs.readFileSync(path.join(REPO, f), 'utf8')).join('\n');
  const bareKills = (clientKillSends.match(/ws\.send\(\{ type: 'kill'/g) || []).length;
  ok(bareKills === 1 && /killSession\(webuiId, backendSessionId\) \{[\s\S]{0,400}this\.ws\.send\(\{ type: 'kill', sessionId: webuiId, backendSessionId \}\)/.test(sl), `the ONLY bare kill send is killSession's own one-shot fallback frame (found ${bareKills}) — every other site routes through killSession`);
  const schema = fs.readFileSync(path.join(REPO, 'src/session-schema.js'), 'utf8');
  ok(/_rebuildQueue:/.test(schema) && /_rebuildPromise:/.test(schema) && /_rebuildProgress:/.test(schema), 'the three new session fields are registered with an owner');
  const cmm = fs.readFileSync(path.join(REPO, 'src/codex-message-manager.js'), 'utf8');
  ok(/convertHistoryAsync[\s\S]{0,400}try \{ this\._processRecord\(record, false\); \}/.test(cmm), 'codex convertHistoryAsync isolates per record (one bad rollout record must not reject the rebuild)');
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
