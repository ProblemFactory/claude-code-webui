#!/usr/bin/env node
// QUEUED vs STEERED input (owner ask 2026-09-06: "codex has two send modes —
// a message sent during a turn is QUEUED, with a control to convert it to
// STEERED, which injects it at the agent's next reply"). This suite owns the
// GENERIC framework rows; the wrapper↔app-server behaviour lives in
// test-codex-p2-wrapper (real wrapper vs a stub app-server) and
// test-acp-harness (real acp-wrapper vs a mock ACP agent).
//
//   ① CAPABILITY, never a backend id: backend-caps `inputModes`
//      {queue, steer, queueOps} per harness, mirrored by the client's
//      BACKEND_META caps row, internally consistent (steer ⇒ queue+queueOps).
//   ② ADAPTER VERB `formatQueueOp({op,id})`: each adapter formats the frames it
//      can honour and REFUSES the rest WITH A REASON (the accept-and-ignore
//      failure of 2.361.4 is what we are avoiding).
//   ③ ws 'queue-op' VALIDATION against the caps row — coded, never silent,
//      and never a session-scoped error that would flip a live window
//      read-only (inc-mt2arppw).
//   ④ NORMALIZER: queue_changed → a `meta` op (session state, NOT a transcript
//      message) + the bubble chip; multi-queue semantics (steering N injects
//      ONLY N, the others keep their order); the failure sentences.
//   ⑤ CLIENT: a DOM-free render of the queue strip from the REAL ChatInput
//      (markup + escaping + which controls each capability set offers).
//   ⑥ THE LIVE SURFACE: the REAL wrapper against a REAL `codex app-server`
//      (no turn started, nothing billed) — every other row here is written
//      against a shape WE wrote down, and the design this was built from
//      assumed a `thread/queue/remove` that does not exist on 0.153.4. A
//      renamed method or param must fail HERE, not in a fleet report.
//      Evidence-SKIPs (with the reason) without the binary or a login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 500) : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

console.log('— ① the capability row (backend-caps ⇄ client META)');
{
  const { BACKEND_CAPS, capsOf } = require(path.join(REPO, 'src/backend-caps.js'));
  const { BACKEND_META } = await import(path.join(REPO, 'src/lib/agent-meta.js'));
  const { chatHarnessIds, HARNESSES } = require(path.join(REPO, 'src/harnesses/index.js'));
  for (const id of Object.keys(BACKEND_CAPS)) {
    const m = BACKEND_CAPS[id].inputModes;
    ok(`${id}: declares inputModes {queue, steer, queueOps} as booleans`, m && ['queue', 'steer', 'queueOps'].every((k) => typeof m[k] === 'boolean'), m);
    // A harness that can steer must also be able to queue and to enumerate:
    // steering means "take THIS queued item and inject it", which needs both.
    ok(`${id}: steer ⇒ queue + queueOps (a steer names a queued item)`, !m.steer || (m.queue && m.queueOps), m);
    ok(`${id}: queueOps ⇒ queue (nothing to operate on otherwise)`, !m.queueOps || m.queue, m);
  }
  ok('codex is the QUEUE+STEER harness (thread/queue/{add,list,delete} + turn/steer, all measured on 0.153.4)', JSON.stringify(capsOf('codex').inputModes) === JSON.stringify({ queue: true, steer: true, queueOps: true }));
  ok('opencode (ACP v1) queues + removes but cannot steer (no such method in the protocol)', JSON.stringify(capsOf('opencode').inputModes) === JSON.stringify({ queue: true, steer: false, queueOps: true }));
  ok("claude queues (the CLI's own stdin queue) but publishes NO queue state ⇒ no ops offered", JSON.stringify(capsOf('claude').inputModes) === JSON.stringify({ queue: true, steer: false, queueOps: false }));
  ok('shell (terminal-only) has no input queue at all', JSON.stringify(capsOf('shell').inputModes) === JSON.stringify({ queue: false, steer: false, queueOps: false }));
  ok('an unknown backend gets the all-false NO_CAPS row (never codex\'s by accident)', JSON.stringify(capsOf('gemini').inputModes) === JSON.stringify({ queue: false, steer: false, queueOps: false }));
  // the client gates its chrome on META; a drifted copy would offer a control
  // the server refuses (or hide one it would honour) — the S7 twin rule
  for (const id of Object.keys(BACKEND_META)) {
    const server = capsOf(id).inputModes, client = BACKEND_META[id].caps?.inputModes;
    if (!BACKEND_META[id].caps) continue;   // shell carries no caps object
    ok(`${id}: client META caps.inputModes deep-equals the server row (no drift)`, JSON.stringify(client) === JSON.stringify(server), { client, server });
  }
  ok('every CHAT harness answers queueState() on its normalizer (one question, one answer everywhere)',
    chatHarnessIds().every((id) => typeof new HARNESSES[id].Normalizer('q').queueState === 'function'),
    chatHarnessIds().filter((id) => typeof new HARNESSES[id].Normalizer('q').queueState !== 'function'));
  ok('claude\'s queueState() is empty by construction (the CLI publishes nothing)', new HARNESSES.claude.Normalizer('q').queueState().length === 0);
}

console.log('— ② the adapter verb (formatQueueOp)');
{
  const { BackendAdapter } = require(path.join(REPO, 'src/adapters/base.js'));
  const { createAdapterRegistry } = require(path.join(REPO, 'src/adapters/index.js'));
  ok('base.js DECLARES formatQueueOp (a harness that never implements it refuses, it does not crash on a missing method)', typeof BackendAdapter.prototype.formatQueueOp === 'function');
  const reg = createAdapterRegistry({ claudeCmd: 'claude', codexCmd: 'codex', codexSandboxSupported: true, chatWrapper: '/w/chat', codexChatWrapper: '/w/codex', acpWrapper: '/w/acp', acpCommands: { opencode: '/usr/bin/opencode' }, ptyWrapper: '/w/pty', buffersDir: '/b' });
  const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const cx = reg.get('codex');
  ok('codex steer → the queue-op frame with the item id', JSON.parse(cx.formatQueueOp({ op: 'steer', id: 'q1' })).type === 'queue-op' && JSON.parse(cx.formatQueueOp({ op: 'steer', id: 'q1' })).op === 'steer' && JSON.parse(cx.formatQueueOp({ op: 'steer', id: 'q1' })).id === 'q1');
  ok('codex remove → the same frame shape', JSON.parse(cx.formatQueueOp({ op: 'remove', id: 'q2' })).op === 'remove');
  ok('codex steer-all needs no id', JSON.parse(cx.formatQueueOp({ op: 'steer-all' })).op === 'steer-all');
  ok('codex: an id-requiring op without an id is REFUSED (never a frame the wrapper would answer with "gone")', /needs an item id/.test(threw(() => cx.formatQueueOp({ op: 'steer' })) || ''));
  ok('codex: an unknown op is refused by name', /unknown queue op "reorder"/.test(threw(() => cx.formatQueueOp({ op: 'reorder', id: 'q' })) || ''));
  const acp = reg.get('opencode');
  ok('opencode remove → a frame', JSON.parse(acp.formatQueueOp({ op: 'remove', id: 'q1' })).op === 'remove');
  {
    const msg = threw(() => acp.formatQueueOp({ op: 'steer', id: 'q1' })) || '';
    ok('opencode STEER is refused WITH THE REASON and what happens instead', /no steer/i.test(msg) && /runs after this turn|after this turn|remove it/i.test(msg), msg);
  }
  {
    const msg = threw(() => reg.get('claude').formatQueueOp({ op: 'remove', id: 'q1' })) || '';
    ok('claude refuses every queue op, naming WHY (its CLI owns the queue and reports nothing)', /owns its own input queue/.test(msg) && /reports no queue/.test(msg), msg);
  }
  ok('shell inherits the base refusal (a terminal has no input queue)', /no input-queue operations/.test(threw(() => reg.get('shell').formatQueueOp({ op: 'remove', id: 'x' })) || ''));
}

console.log('— ③ the ws case gates on the caps row');
{
  const src = read('src/ws-handler.js');
  const m = /case 'queue-op': \{([\s\S]*?)\n        \}/.exec(src);
  ok("ws-handler has ONE 'queue-op' case", !!m);
  const body = m ? m[1] : '';
  ok('it reads inputModes from backend-caps — no backend-id branch anywhere in the case', /capsOf\(session\.backend\)\.inputModes/.test(body) && !/=== 'codex'|=== 'claude'|=== 'opencode'/.test(body), body.slice(0, 400));
  ok('queueOps false ⇒ refuse; steer with steer:false ⇒ refuse', /if \(!modes\.queueOps\)/.test(body) && /!modes\.steer/.test(body));
  ok("every refusal is CODED 'queue-op-unsupported' with a human reason (never silent, never a bare session error)", /code: 'queue-op-unsupported'/.test(body) && /error: message, message/.test(body) && !/ws\.send\(JSON\.stringify\(\{ type: 'error', sessionId: data\.sessionId \}\)\)/.test(body));
  ok('the adapter throw is the second line of defense (formatQueueOp inside a try that refuses with e.message)', /try \{ payload = adapter\.formatQueueOp\(/.test(body) && /catch \(e\) \{ refuse\(e\.message\); break; \}/.test(body));
  ok('the frame goes to the wrapper on stdin, like every other verb', /session\.pty\.write\(payload \+ '\\n'\)/.test(body));
  // CLIENT: a coded per-session error must NOT be read as an attach failure —
  // the 2.363.1 rule, generalized so the NEXT code is safe by construction
  const cv = read('src/lib/chat-view.js');
  ok('client: ANY coded per-session error renders in chat and leaves the window alone (generalized from input-rejected)', /if \(msg\.code\) \{\s*\n\s*this\._hideTyping\(\);/.test(cv) && !/if \(msg\.code === 'input-rejected'\) \{/.test(cv));
  ok('client: an error with NO code is still the attach failure it always was (view-only rescue path intact)', /if \(!this\._tryViewOnlyRescue\(\)\)/.test(cv));
  // the queue rides EVERY window-birth payload (the 2.368.4 rule)
  ok("attach carries the queue from the normalizer", /queue: session\._normalizer\?\.queueState\?\.\(\) \|\| \[\]/.test(read('src/ws-handler.js')));
  ok("…and 'created' carries it too (the creator never gets an 'attached')", /queue: \[\],/.test(read('src/ws-create.js')));
  ok('the client applies it through the carries-the-key guard', /if \('queue' in meta\) this\._setQueue\(meta\.queue\);/.test(cv));
  ok('wiring pin: the strip and the chip send the SAME ws message through one method', /this\.ws\.send\(\{ type: 'queue-op', sessionId: this\.sessionId, op, id: id \|\| null \}\)/.test(cv) && (cv.match(/type: 'queue-op'/g) || []).length === 1);
  // NO DEAD CONTROLS: the chip is only rendered clickable where the harness can
  // actually steer, and a click on a window that went read-only/offline SPEAKS
  const cr = read('src/lib/chat-renderers.js');
  ok('the bubble chip is clickable only where the caps row says steer (an ACP/claude chip is inert by construction)', /_canSteerQueue\(\) \? this\._onQueueChipClick : null/.test(cr) && /getBackendMeta\(this\.backend\)\?\.caps\?\.inputModes\?\.steer/.test(cr));
  ok('a chip click on a dead/disconnected window explains itself instead of doing nothing', /if \(this\._readOnly \|\| this\._disconnected\) \{ showToast\(t\('This session is not live/.test(cv));
  const cw2 = read('data/bin/codex-chat-wrapper.js');
  ok('removing a queued PEER message hands the text back to the delivery ladder (never a silent loss of a message already reported delivered)', /known\?\.kind === 'peer' && known\.text\) emitTaskEvent\('peer_message_result', \{ ok: false/.test(cw2));
}

console.log('— ④ the normalizer: session state + chips + multi-queue semantics');
{
  const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
  const mm = new CodexMessageManager('q');
  const ops = []; mm.onOp((o) => ops.push(o));
  const user = (text, msgId) => mm.processLive({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', webui_msg_id: msgId, content: [{ type: 'input_text', text }] } });
  const ev = (type, payload) => mm.processLive({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type, ...payload } });
  user('one', 'm1'); user('two', 'm2');
  ev('queue_changed', { items: [{ id: 'q1', msgId: 'm1', preview: 'one', ts: 1, kind: 'user' }, { id: 'q2', msgId: 'm2', preview: 'two', ts: 2, kind: 'user' }], turn_id: 't1' });
  const metaOps = ops.filter((o) => o.op === 'meta' && o.subtype === 'queue');
  ok("queue_changed is a {op:'meta', subtype:'queue'} op carrying the WHOLE queue", metaOps.length === 1 && metaOps[0].items.length === 2, metaOps);
  ok('…and NOTHING enters the transcript (session state, not a message)', mm.messages.filter((m) => m.role === 'system').length === 0 && mm.messages.length === 2, mm.messages.map((m) => m.role));
  ok('queueState() is the attach payload', mm.queueState().length === 2);
  ok("both bubbles wear a 'queued' chip, delivered as edit ops", mm.messages.every((m) => m.queueState === 'queued') && ops.filter((o) => o.op === 'edit' && o.fields?.queueState === 'queued').length === 2);
  // MULTI-QUEUE SEMANTICS: steering #2 injects ONLY #2; #1 keeps its place.
  ev('queue_op_result', { op: 'steer', id: 'q2', msg_id: 'm2', ok: true });
  ev('queue_changed', { items: [{ id: 'q1', msgId: 'm1', preview: 'one', ts: 1, kind: 'user' }], turn_id: 't1' });
  ok("the steered bubble becomes 'steered'; the other stays 'queued' and keeps its place", mm.messages[1].queueState === 'steered' && mm.messages[0].queueState === 'queued' && mm.queueState().length === 1 && mm.queueState()[0].msgId === 'm1');
  ok('a steered item is not in the queue any more (it never runs twice)', !mm.queueState().some((i) => i.msgId === 'm2'));
  // it LEFT the queue with no steer/remove ⇒ it RAN ⇒ the chip clears
  ev('queue_changed', { items: [], turn_id: null });
  ok("a queued item that simply RUNS loses its chip (a bubble never claims to be queued forever)", mm.messages[0].queueState === null && mm.messages[1].queueState === 'steered', mm.messages.map((m) => m.queueState));
  // removal
  user('three', 'm3');
  ev('queue_changed', { items: [{ id: 'q3', msgId: 'm3', preview: 'three', ts: 3, kind: 'user' }] });
  ev('queue_op_result', { op: 'remove', id: 'q3', msg_id: 'm3', ok: true });
  ok("a removed bubble wears 'removed'", mm.messages[2].queueState === 'removed');
  // a queued message with NO bubble of its own (a peer message) still SPEAKS
  const mm2 = new CodexMessageManager('q2');
  mm2.processLive({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'queued_input', msg_id: '', turn_id: 't1' } });
  ok('queued_input with no bubble to stamp falls back to the visible system card (never silent)', mm2.messages.some((m) => m.role === 'system' && /Queued — runs after the current turn/.test(m.content[0].text)), mm2.messages);
  // the failure sentences: every one says what happens to the message NOW
  const F = CodexMessageManager.queueOpFailureText;
  ok('review/compact turn: refused, and the message still runs when the turn ends', /Cannot steer during a review turn/.test(F({ op: 'steer', reason: 'not-steerable', kind: 'review' })) && /runs when this turn ends/.test(F({ op: 'steer', reason: 'not-steerable', kind: 'review' })));
  ok('compact turn is named as such', /compact turn/.test(F({ op: 'steer', reason: 'not-steerable', kind: 'compact' })));
  ok('the turn ended between click and RPC: "it will simply run next"', /simply run next/.test(F({ op: 'steer', reason: 'turn-mismatch' })) && /simply run next/.test(F({ op: 'steer', reason: 'no-active-turn' })));
  ok('gone: it already ran', /already ran/.test(F({ op: 'remove', reason: 'gone' })));
  ok('an unclassified failure still carries the server\'s own words', /Could not steer the queued message: boom/.test(F({ op: 'steer', reason: 'error', detail: 'boom' })));
  ok('a steer whose queued copy could NOT be deleted warns about the double run', (() => { const m3 = new CodexMessageManager('q3'); m3.processLive({ timestamp: '', type: 'event_msg', payload: { type: 'queue_op_result', op: 'steer', id: 'q', msg_id: '', ok: true, reason: 'steered-not-dequeued' } }); return m3.messages.some((x) => /may run a second time/.test(x.content?.[0]?.text || '')); })());
  // ACP normalizer: same ops, same chips
  const { AcpMessageManager } = require(path.join(REPO, 'src/acp-message-manager.js'));
  const am = new AcpMessageManager('a'); const aops = []; am.onOp((o) => aops.push(o));
  am.processLive({ ts: new Date().toISOString(), type: 'acp', kind: 'user', msgId: 'a1', content: [{ type: 'text', text: 'hello' }] });
  am.processLive({ ts: new Date().toISOString(), type: 'acp', kind: 'queue_changed', items: [{ id: 'p1', msgId: 'a1', preview: 'hello', ts: 1, kind: 'user' }] });
  ok('ACP: queue_changed → the SAME meta op + the SAME chip (one client path for both harnesses)', aops.some((o) => o.op === 'meta' && o.subtype === 'queue' && o.items.length === 1) && am.messages.find((m) => m.role === 'user')?.queueState === 'queued' && am.queueState().length === 1);
  am.processLive({ ts: new Date().toISOString(), type: 'acp', kind: 'queue_op_result', op: 'remove', id: 'p1', msg_id: 'a1', ok: true });
  ok("ACP: a removed entry's bubble wears 'removed'", am.messages.find((m) => m.role === 'user')?.queueState === 'removed');
}

console.log('— ⑤ the client strip (DOM-free render of the REAL ChatInput)');
{
  const esbuild = require(path.join(REPO, 'node_modules/esbuild'));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-qs-')), 'chat-input.mjs');
  const stubBuildVersion = { name: 'stub-build-version', setup(b) { b.onResolve({ filter: /build-version\.js$/ }, () => ({ path: 'build-version', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: "export const BUILD_VERSION = 'test';", loader: 'js' })); } };
  await esbuild.build({ entryPoints: [path.join(REPO, 'src/lib/chat-input.js')], bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile: out, logLevel: 'silent', loader: { '.css': 'text' }, plugins: [stubBuildVersion] });
  const noop = () => {};
  const mkEl = () => ({ className: '', dataset: {}, _html: '', classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} }, set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, appendChild() {}, append() {}, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, focus() {} });
  for (const [k, v] of Object.entries({ addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }), requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: noop, getComputedStyle: () => ({ getPropertyValue: () => '' }), innerWidth: 1024, innerHeight: 768, location: { origin: 'http://test', href: 'http://test/', hostname: 'test', protocol: 'http:' } })) {
    try { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); } catch {}
  }
  globalThis.window = globalThis;
  globalThis.document = { createElement: mkEl, getElementById: () => null, body: mkEl(), documentElement: mkEl(), head: mkEl(), addEventListener: noop, removeEventListener: noop, querySelector() { return null; }, querySelectorAll() { return []; }, createTextNode: (t) => ({ textContent: t }) };
  try { Object.defineProperty(globalThis, 'navigator', { value: { language: 'en', userAgent: 'node' }, configurable: true, writable: true }); } catch {}
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const { ChatInput } = await import(out);
  const items = [
    { id: 'q1', msgId: 'm1', preview: 'first one', ts: 1, kind: 'user' },
    { id: 'q2', msgId: '', preview: 'ping', ts: 2, kind: 'peer', from: 'session B' },
  ];
  const full = ChatInput.queueStripHtml(items, { steer: true, queueOps: true });
  ok('the strip heads with the count and what happens next', /2 queued — runs after this turn/.test(full), full.slice(0, 200));
  ok('one row per item, each carrying its app-server id', (full.match(/class="chat-queue-item"/g) || []).length === 2 && /data-queue-id="q1"/.test(full) && /data-queue-id="q2"/.test(full));
  ok('steer + remove buttons per row when the harness can steer', (full.match(/data-queue-op="steer"/g) || []).length === 2 && (full.match(/data-queue-op="remove"/g) || []).length === 2);
  ok('"Steer all" appears only when MORE THAN ONE is queued', /data-queue-op="steer-all"/.test(full) && !/data-queue-op="steer-all"/.test(ChatInput.queueStripHtml([items[0]], { steer: true, queueOps: true })));
  ok('a peer message is LISTED and LABELLED (hiding it would misstate what runs next)', /class="chat-queue-from">session B</.test(full));
  const noSteer = ChatInput.queueStripHtml(items, { steer: false, queueOps: true });
  ok('a harness that cannot steer offers ONLY remove — no steer button, no Steer all', !/data-queue-op="steer/.test(noSteer) && (noSteer.match(/data-queue-op="remove"/g) || []).length === 2);
  ok('rows are keyboard-reachable (tabindex) so Enter can steer a focused one', /class="chat-queue-item" tabindex="0"/.test(full));
  ok('icons are SVG, never a glyph (§17)', /<svg/.test(full) && !/[✕✖×⚡]/.test(full), full.slice(0, 120));
  // XSS: a preview is message text and syncs to EVERY client
  const evil = '<img src=x onerror=alert(1)>" onmouseover="y';
  const xss = ChatInput.queueStripHtml([{ id: evil, msgId: '', preview: evil, kind: 'peer', from: evil }], { steer: true, queueOps: true });
  ok('XSS: preview, sender and id are escaped everywhere they land (text + attributes)', !xss.includes('<img src=x') && !/onmouseover="y/.test(xss) && xss.includes('&lt;img') && (xss.match(/&quot;/g) || []).length >= 2, xss.slice(0, 300));
}

console.log('— wiring + docs pins');
{
  const ci = read('scripts/ci.mjs');
  ok('this suite runs in the release gate', /'test-queue-steer'/.test(ci));
  const cinput = read('src/lib/chat-input.js');
  ok('the strip is the FIRST child of the input area (above the box, as designed)', /inputArea\.append\(this\._queueStrip, this\._attachArea/.test(cinput));
  ok('the strip renders nothing for a harness without queueOps (no dead control)', /const items = this\._queueCaps\.queueOps \? this\._queue : \[\];/.test(cinput));
  const cw = read('data/bin/codex-chat-wrapper.js');
  const aw = read('data/bin/acp-wrapper.js');
  ok('BOTH wrappers serve the new stdin verb in the same batch (the frame-file lesson)', /msg\.type === 'queue-op'/.test(cw) && /case 'queue-op':/.test(aw));
  ok('both adverts caps.inputQueue in the sidecar THEY write', /inputQueue: true/.test(cw) && /inputQueue: true/.test(aw));
  ok('the ACP unknown-verb message lists queue-op (the wrapper tells the truth about what it serves)', /chat-input\/interrupt\/queue-op\//.test(aw));
  // DISTINCT phrases per file (a loose grep matched 'queue-operation' in an
  // unrelated essay and the docs pin passed while the docs were empty)
  ok('kb-features documents QUEUED vs STEERED incl. the multi-queue rule', /QUEUED vs STEERED/.test(read('docs/kb-features.md')) && /steering item N injects\s*\n?\s*\*\*only N\*\*/.test(read('docs/kb-features.md')));
  ok("kb-api documents the ws 'queue-op' message + the queue_changed/queue_op_result events", /\*\*Input queue \(`queue-op`/.test(read('docs/kb-api.md')) && /queue_op_result \{op, id, msg_id, ok, reason, detail\}/.test(read('docs/kb-api.md')));
  ok('design-harness-plugins §1 records the closure on its own P2 row', /两种发送模式 ✅2026-09-06/.test(read('docs/design-harness-plugins.md')));
  { const kbfs = read('docs/kb-file-structure.md');
    ok('kb-file-structure carries the wrapper/normalizer/ws essays (the measured app-server facts live there)',
      /THE INPUT QUEUE — QUEUED vs STEERED/.test(kbfs) && /QUEUE STATE IS SESSION STATE, NEVER A MESSAGE/.test(kbfs) && /the ONE new case for QUEUED vs STEERED/.test(kbfs) && /no `remove`/.test(kbfs)); }
}

console.log('— ⑥ the REAL wrapper against the REAL `codex app-server` (evidence-SKIP without the binary)');
{
  // THE POINT of this leg: every other assertion in the file is written against
  // a shape WE wrote down. The design this feature was built from assumed a
  // `thread/queue/remove` that does not exist on 0.153.4 — a method/param name
  // is exactly the kind of fact only the live surface can settle, and a future
  // codex that renames one must fail HERE, not in a fleet report. No turn is
  // started, so nothing is billed.
  const { spawnSync, spawn } = await import('node:child_process');
  const which = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (which.status !== 0) {
    console.log(`  SKIP: no working \`codex\` on PATH (${(which.error?.message || which.stderr || '').trim().slice(0, 80)})`);
  } else {
    const ver = (which.stdout || '').trim();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-qs-real-'));
    const buf = path.join(dir, 's.buf'), sidecar = path.join(dir, 's.json');
    const w = spawn(process.execPath, [path.join(REPO, 'data/bin/codex-chat-wrapper.js'), buf, sidecar, 'codex', 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_WEBUI_CWD: dir, VIBESPACE_API: '', VIBESPACE_SESSION_TOKEN: '', VIBESPACE_SKIP_AGENT_HOOKS: '1' },
    });
    let out = '', werr = '';
    w.stdout.on('data', (d) => { out += d; }); w.stderr.on('data', (d) => { werr += d; });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const events = () => out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const queues = () => events().filter((e) => e.type === 'event_msg' && e.payload?.type === 'queue_changed').map((e) => e.payload);
    const results = () => events().filter((e) => e.type === 'event_msg' && e.payload?.type === 'queue_op_result').map((e) => e.payload);
    const sc = () => { try { return JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch { return null; } };
    const waitFor = async (pred, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await sleep(200); } return pred(); };
    const up = await waitFor(() => !!sc()?.threadId, 40000);
    if (!up) {
      // not logged in / app-server unavailable: SKIP WITH THE EVIDENCE, never a
      // silent pass and never a red for something this box cannot do
      console.log(`  SKIP: \`codex app-server\` (${ver}) never reached a thread — ${(werr || 'no stderr').trim().slice(0, 140)}`);
      try { w.kill('SIGKILL'); } catch {}
    } else {
      ok(`${ver}: the wrapper publishes a BASELINE queue read from a real thread/queue/list (a wrong method or param name fails here)`, await waitFor(() => queues().length > 0, 20000), events().map((e) => e.type + ':' + (e.payload?.type || '')).slice(-10));
      ok('…empty on a fresh thread, and mirrored into the sidecar with caps.inputQueue', queues().slice(-1)[0]?.items?.length === 0 && Array.isArray(sc()?.queue) && sc()?.caps?.inputQueue === true, { last: queues().slice(-1)[0], caps: sc()?.caps });
      w.stdin.write(JSON.stringify({ type: 'queue-op', op: 'remove', id: 'not-a-real-id' }) + '\n');
      ok("a queue-op for an id the real server does not have answers reason:'gone' (never a hang, never a fake success)", await waitFor(() => results().some((r) => r.op === 'remove' && r.reason === 'gone'), 20000), results());
      const log = (() => { try { return fs.readFileSync(path.join(dir, 'codex-chat-wrapper.log'), 'utf8'); } catch { return ''; } })();
      ok('the wrapper log carries NO RPC-shape complaint (a renamed method would land here verbatim)', !/thread\/queue\/list failed|Invalid request|unknown variant/.test(log), log.slice(-400));
      try { w.kill('SIGTERM'); } catch {}
      await sleep(400);
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
