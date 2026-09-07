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
//   ③ ws 'queue-op' VALIDATION against TWO gates — the harness caps row AND
//      the RUNNING wrapper's own sidecar advert (a session spawned before this
//      release satisfies the row and drops the frame: 2.361.1/2.364.1) —
//      coded, never silent, and never a session-scoped error that would flip a
//      live window read-only (inc-mt2arppw). The scoped-refusal codes are an
//      EXPLICIT set: 'ended-during-attach' is coded AND fatal, and must keep
//      taking the view-only rescue.
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
//   ⑦ FUNCTIONAL client: chat-view is DOM-free at import, so a REAL
//      normalizer-produced bubble drives the REAL _steerQueuedMessage into a
//      REAL ws frame (the round-1 blocker was a join on a field nobody wrote —
//      every grep-level pin passed), and _onSessionError is driven for both
//      meanings of a per-session `error`.
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
  const { QUEUE_VERBS, deriveInputModes } = require(path.join(REPO, 'src/backend-caps.js'));
  const shape = (queue, verbs) => JSON.stringify({ queue, steer: verbs.includes('steer'), queueOps: verbs.length > 0, queueVerbs: verbs });
  for (const id of Object.keys(BACKEND_CAPS)) {
    const m = BACKEND_CAPS[id].inputModes;
    ok(`${id}: declares a queueVerbs TABLE ⊆ the closed set (a typo'd verb is not a capability)`, Array.isArray(m?.queueVerbs) && m.queueVerbs.every((v) => QUEUE_VERBS.includes(v)), m);
    // THE DERIVATION LAW: the booleans are a VIEW of the table, never a second
    // place to edit — a row whose steer disagrees with its list is the exact
    // two-sources-of-truth bug the table replaced.
    ok(`${id}: steer === queueVerbs.includes('steer') (derived, not declared)`, m.steer === m.queueVerbs.includes('steer'), m);
    ok(`${id}: queueOps === (queueVerbs.length > 0)`, m.queueOps === (m.queueVerbs.length > 0), m);
    // A harness that can steer must also be able to queue and to enumerate:
    // steering means "take THIS queued item and inject it", which needs both.
    ok(`${id}: steer ⇒ queue + queueOps (a steer names a queued item)`, !m.steer || (m.queue && m.queueOps), m);
    ok(`${id}: queueOps ⇒ queue (nothing to operate on otherwise)`, !m.queueOps || m.queue, m);
  }
  ok('deriveInputModes IS the law (the same function the client mirror uses), and it drops a verb outside the closed set', JSON.stringify(deriveInputModes({ queue: true, queueVerbs: ['steer', 'teleport'] })) === shape(true, ['steer']));
  ok('codex serves ALL SEVEN verbs (add/list/delete/update/reorder/start + turn/steer, every shape dumped from the 0.153.4 schema)', JSON.stringify(capsOf('codex').inputModes) === shape(true, ['remove', 'steer', 'steer-all', 'reorder', 'edit', 'run-now', 'run-all']), capsOf('codex').inputModes);
  ok('opencode (ACP v1) removes/reorders/edits its own local queue but cannot steer, and cannot start one early (that queue only exists while a prompt runs)', JSON.stringify(capsOf('opencode').inputModes) === shape(true, ['remove', 'reorder', 'edit']), capsOf('opencode').inputModes);
  ok("claude queues (the CLI's own stdin queue) but publishes NO queue state ⇒ an HONEST EMPTY verb table", JSON.stringify(capsOf('claude').inputModes) === shape(true, []));
  ok('shell (terminal-only) has no input queue at all', JSON.stringify(capsOf('shell').inputModes) === shape(false, []));
  ok('an unknown backend gets the all-false NO_CAPS row (never codex\'s by accident)', JSON.stringify(capsOf('gemini').inputModes) === shape(false, []));
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
  const acpAdapter = () => reg.get('opencode');
  const cx = reg.get('codex');
  ok('codex steer → the queue-op frame with the item id', JSON.parse(cx.formatQueueOp({ op: 'steer', id: 'q1' })).type === 'queue-op' && JSON.parse(cx.formatQueueOp({ op: 'steer', id: 'q1' })).op === 'steer' && JSON.parse(cx.formatQueueOp({ op: 'steer', id: 'q1' })).id === 'q1');
  ok('codex remove → the same frame shape', JSON.parse(cx.formatQueueOp({ op: 'remove', id: 'q2' })).op === 'remove');
  ok('codex steer-all needs no id', JSON.parse(cx.formatQueueOp({ op: 'steer-all' })).op === 'steer-all');
  ok('codex: an id-requiring op without an id is REFUSED (never a frame the wrapper would answer with "gone")', /needs an item id/.test(threw(() => cx.formatQueueOp({ op: 'steer' })) || ''));
  ok('codex: an unknown op is refused by name', /unknown queue op "teleport"/.test(threw(() => cx.formatQueueOp({ op: 'teleport', id: 'q' })) || ''));
  // THE VERB TABLE IS A PROMISE: every verb a harness DECLARES must have a
  // construction branch here, and every verb it does NOT declare must be
  // refused. "Declared but unbuildable" is the 2.361.4 accept-and-ignore
  // failure made structurally impossible.
  {
    const { QUEUE_VERBS, capsOf } = require(path.join(REPO, 'src/backend-caps.js'));
    const args = { remove: { id: 'q1' }, steer: { id: 'q1' }, 'steer-all': {}, reorder: { id: 'q1', afterId: 'q2' }, edit: { id: 'q1', text: 'hi' }, 'run-now': { id: 'q1' }, 'run-all': {} };
    for (const [backend, id] of [['codex', 'codex'], ['opencode', 'opencode'], ['claude', 'claude']]) {
      const declared = capsOf(id).inputModes.queueVerbs;
      const a = reg.get(backend);
      for (const verb of QUEUE_VERBS) {
        const out = (() => { try { return JSON.parse(a.formatQueueOp({ op: verb, ...args[verb] })); } catch (e) { return { _throw: e.message }; } })();
        if (declared.includes(verb)) ok(`${id}: declares '${verb}' AND builds its frame`, out.type === 'queue-op' && out.op === (verb === 'remove' ? 'remove' : verb), out);
        else ok(`${id}: does not declare '${verb}' ⇒ the adapter REFUSES it with a reason`, typeof out._throw === 'string' && out._throw.length > 20, out);
      }
    }
  }
  // the relative vocabulary (§2.1 decision 1): the ws layer never speaks the
  // app-server's absolute shapes
  ok('codex reorder carries the RELATIVE anchor', (() => { const f = JSON.parse(cx.formatQueueOp({ op: 'reorder', id: 'q1', afterId: 'q2' })); return f.op === 'reorder' && f.id === 'q1' && f.afterId === 'q2'; })());
  ok('…and afterId null MEANS the front of the queue (a position, carried as such)', JSON.parse(cx.formatQueueOp({ op: 'reorder', id: 'q1', afterId: null })).afterId === null);
  ok('…while a MISSING anchor is refused (the wrapper cannot guess where it goes)', /needs an anchor/.test(threw(() => cx.formatQueueOp({ op: 'reorder', id: 'q1' })) || ''));
  ok('…and an item cannot be anchored to itself', /anchor an item to itself/.test(threw(() => cx.formatQueueOp({ op: 'reorder', id: 'q1', afterId: 'q1' })) || ''));
  ok('codex edit carries the new TEXT only (the wrapper rebuilds the whole input)', (() => { const f = JSON.parse(cx.formatQueueOp({ op: 'edit', id: 'q1', text: 'new words' })); return f.op === 'edit' && f.id === 'q1' && f.text === 'new words' && !('input' in f); })());
  ok('…and an empty edit is refused here (never a frame that would blank a queued message)', /needs the new message text/.test(threw(() => cx.formatQueueOp({ op: 'edit', id: 'q1', text: '   ' })) || ''));
  // THE ONE THAT MUST NOT DEGRADE: thread/queue/start with no id DRAINS the
  // whole queue, so a lost id has to be an error, never a silent run-all.
  ok('RUN-NOW WITHOUT AN ID THROWS (a lost id must never become a drain)', /needs an item id/.test(threw(() => cx.formatQueueOp({ op: 'run-now' })) || ''), threw(() => cx.formatQueueOp({ op: 'run-now' })));
  ok('…and run-all is its OWN verb, a different frame (never run-now minus its id)', JSON.parse(cx.formatQueueOp({ op: 'run-all' })).op === 'run-all' && JSON.parse(cx.formatQueueOp({ op: 'run-all' })).id === null);
  ok('opencode reorder/edit build frames in the SAME relative vocabulary', JSON.parse(acpAdapter().formatQueueOp({ op: 'reorder', id: 'p1', afterId: null })).afterId === null && JSON.parse(acpAdapter().formatQueueOp({ op: 'edit', id: 'p1', text: 'x' })).text === 'x');
  ok('opencode REFUSES run-now/run-all with the structural reason (its queue only exists while a prompt runs)', /one prompt at a time/.test(threw(() => acpAdapter().formatQueueOp({ op: 'run-now', id: 'p1' })) || ''), threw(() => acpAdapter().formatQueueOp({ op: 'run-now', id: 'p1' })));
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

console.log('— ③ the ws case gates on the caps row AND the running wrapper');
{
  const src = read('src/ws-handler.js');
  const m = /case 'queue-op': \{([\s\S]*?)\n        \}/.exec(src);
  ok("ws-handler has ONE 'queue-op' case", !!m);
  const body = m ? m[1] : '';
  ok('it reads inputModes from backend-caps — no backend-id branch anywhere in the case', /capsOf\(session\.backend\)\.inputModes/.test(body) && !/=== 'codex'|=== 'claude'|=== 'opencode'/.test(body), body.slice(0, 400));
  ok('the gate is the VERB TABLE, not a pair of booleans: no verbs ⇒ refuse, an undeclared verb ⇒ refuse WITH ITS OWN SENTENCE', /if \(!harnessVerbs\.length\)/.test(body) && /if \(!harnessVerbs\.includes\(data\.op\)\) \{ refuse\(queueVerbRefusal\(data\.op, label\)/.test(body), body.slice(0, 400));
  {
    // …and that sentence says what happens to the message ANYWAY (a refusal
    // that only says "no" leaves the user wondering if it is lost).
    const fn = /function queueVerbRefusal\(op, label\) \{[\s\S]*?\n\}/.exec(src)?.[0] || '';
    const refusal = new Function('op', 'label', fn + '; return queueVerbRefusal(op, label);');
    for (const [verb, must] of [['steer', /runs after it/], ['reorder', /order they were sent/], ['edit', /remove it and send a new one/], ['run-now', /runs when the current turn ends/], ['run-all', /run when the current turn ends/]]) {
      ok(`ws refusal for '${verb}' names the harness AND what happens to the message`, /Claude/.test(refusal(verb, 'Claude')) && must.test(refusal(verb, 'Claude')), refusal(verb, 'Claude'));
    }
    ok('every refusal carries a machine `reason` beside the sentence (the client can branch, the user can read)', /refuse = \(message, reason\)/.test(body) && /reason: reason \|\| 'unsupported'/.test(body));
  }
  ok("every refusal is CODED 'queue-op-unsupported' with a human reason (never silent, never a bare session error)", /code: 'queue-op-unsupported'/.test(body) && /error: message, message/.test(body) && !/ws\.send\(JSON\.stringify\(\{ type: 'error', sessionId: data\.sessionId \}\)\)/.test(body));
  ok('the adapter throw is the second line of defense (formatQueueOp inside a try that refuses with e.message)', /payload = adapter\.formatQueueOp\(\{/.test(body) && /catch \(e\) \{ refuse\(e\.message, 'malformed'\); break; \}/.test(body));
  ok("…and `afterId: null` reaches the adapter as a POSITION: the key is spread only when the client sent one (absent ≠ front)", /\.\.\.\('afterId' in data \? \{ afterId: data\.afterId === null \? null : String\(data\.afterId \|\| ''\) \} : \{\}\)/.test(body), body.slice(-1200));
  ok('the frame goes to the wrapper on stdin, like every other verb', /session\.pty\.write\(payload \+ '\\n'\)/.test(body));
  // ── ROUND-2 VERIFIER, finding 6: `edit` is the one verb that carries USER
  // TEXT, and this frame reaches the wrapper over RAW PTY STDIN — the `input`
  // case routes anything large through the frame file precisely because a big
  // pty write gets shredded (the 79928a2b/c1206711 class). Two bounds, both
  // loud: the wrapper's own edit cap, and the transport ceiling AFTER JSON
  // escaping (a control-char string grows sixfold, so the first does not imply
  // the second).
  ok('finding 6: an over-long edit text is REFUSED with evidence before the frame is built (never an unbounded raw-stdin write)',
    /if \(typeof data\.text === 'string' && data\.text\.length > QUEUE_EDIT_MAX_CHARS\) \{/.test(body) && /'text-too-long'/.test(body) && /it was NOT saved/.test(body), body.slice(-1600));
  ok('…and the built FRAME is bounded too (JSON escaping can multiply the text sixfold), refused with its own reason',
    /if \(payload\.length > QUEUE_OP_MAX_BYTES\) \{/.test(body) && /'frame-too-large'/.test(body) && /it was NOT sent/.test(body), body.slice(-1200));
  {
    const { QUEUE_EDIT_MAX_CHARS, QUEUE_OP_MAX_BYTES } = require(path.join(REPO, 'src/server/wrapper-files.js'));
    const wrapperCap = Number(/const QUEUE_EDIT_MAX_CHARS = (\d+);/.exec(read('data/bin/codex-chat-wrapper.js'))?.[1]);
    ok(`…and the server's cap IS the wrapper's own (${QUEUE_EDIT_MAX_CHARS} = ${wrapperCap}) — refusing at a limit the wrapper does not share would refuse edits it would have accepted`,
      QUEUE_EDIT_MAX_CHARS === 20000 && wrapperCap === QUEUE_EDIT_MAX_CHARS, { QUEUE_EDIT_MAX_CHARS, wrapperCap });
    ok('…and the transport ceiling is the SAME 64KiB the `input` case treats as the shredding threshold', QUEUE_OP_MAX_BYTES === 64 * 1024 && /stdinPayload\.length > 64 \* 1024/.test(src));
  }
  // ── finding 3 (server half): a ws refusal never becomes a `queue_op_result`,
  // so the strip could not find the row it had marked pending. The refusal
  // echoes the op AND its id for exactly that join.
  ok('finding 3: every queue-op refusal ECHOES the op and its id (the client marked that row pending before sending; nothing else will ever answer it)',
    /op: data\.op \|\| null, id: data\.id \|\| null/.test(body), body.slice(0, 900));
  // GATE ②, THE WRAPPER SKEW (round-1 review): the caps row describes a KIND
  // of agent; a LONG-LIVED PROCESS is a different question. A codex session
  // spawned before this release satisfies the row and drops the frame
  // silently — the 2.361.1/2.364.1 class, twice shipped.
  ok("…and ALSO on the RUNNING wrapper's own advert (its sidecar verb list, or the in-band one for a remote wrapper), not just the static row", /wrapperCaps\(BUFFERS_DIR, data\.sessionId, session\.socketPath\)/.test(body) && /const served = wcaps\.inputQueue \? wcaps\.queueVerbs/.test(body) && /if \(!served\) \{/.test(body), body.slice(-1400));
  ok('…and a wrapper that serves SOME verbs is refused only the ones it does not serve, naming what it does serve (skew, not a dead session)', /if \(!served\.includes\(data\.op\)\) \{[\s\S]{0,300}it serves \$\{served\.join\(', '\)\}/.test(body), body.slice(-1400));
  ok('…whose refusal says what happens to the message AND how to get the controls', /predates the input-queue update/.test(body) && /Terminate \+ Resume/.test(body) && /still starting up/.test(body));
  ok('the negative verdict is never cached on the session (a wrapper writing its sidecar late must not be locked out)', !/_wrapperInputQueue/.test(src));
  ok('…and a REMOTE wrapper (its sidecar lives on ITS machine) is not mistaken for an old one — its in-band verb list, or a bare published queue, is proof enough', /session\._normalizer\?\.queueVerbsPublished\?\.\(\)/.test(body) && /queuePublished\?\.\(\) \? LEGACY_QUEUE_VERBS\.slice\(\) : null/.test(body));
  {
    // A pre-verb-table wrapper adverts `inputQueue` and NO list — it serves
    // exactly the three verbs that existed then, and must keep serving them.
    const wf = read('src/server/wrapper-files.js');
    ok('wrapperCaps maps a verb-LESS inputQueue advert to the legacy three (never to the current seven)', /const \{ LEGACY_QUEUE_VERBS \} = require\('\.\.\/backend-caps\.js'\);/.test(wf) && /Array\.isArray\(caps && caps\.queueVerbs\)[\s\S]{0,160}inputQueue \? LEGACY_QUEUE_VERBS\.slice\(\) : \[\]/.test(wf), wf.slice(-800));
    const { wrapperCaps } = require(path.join(REPO, 'src/server/wrapper-files.js'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-qcaps-'));
    fs.writeFileSync(path.join(dir, 'sess-old.json'), JSON.stringify({ caps: { inputQueue: true } }));
    fs.writeFileSync(path.join(dir, 'sess-new.json'), JSON.stringify({ caps: { inputQueue: true, queueVerbs: ['remove', 'reorder'] } }));
    fs.writeFileSync(path.join(dir, 'sess-none.json'), JSON.stringify({ caps: { frameFile: true } }));
    ok('…proven against a REAL sidecar file: old build ⇒ the legacy three', JSON.stringify(wrapperCaps(dir, 'sess-old', '/x').queueVerbs) === JSON.stringify(['remove', 'steer', 'steer-all']));
    ok('…a build that NAMES its verbs ⇒ exactly those', JSON.stringify(wrapperCaps(dir, 'sess-new', '/x').queueVerbs) === JSON.stringify(['remove', 'reorder']));
    ok('…and a wrapper with no queue at all ⇒ none', JSON.stringify(wrapperCaps(dir, 'sess-none', '/x').queueVerbs) === '[]' && wrapperCaps(dir, 'sess-none', '/x').inputQueue === false);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ok('wrapperCaps reads inputQueue from the sidecar the WRAPPER itself writes', /const inputQueue = !!\(caps && caps\.inputQueue\)/.test(read('src/server/wrapper-files.js')));
  // CLIENT: a coded per-session error must NOT be read as an attach failure
  // (the 2.363.1 rule) — but "any code = scoped" is TOO WIDE: 'ended-during-
  // attach' is a coded error whose SESSION IS GONE and must keep the rescue.
  const cv = read('src/lib/chat-view.js');
  const scopedSet = /const SCOPED_REFUSAL_CODES = new Set\(\[([\s\S]*?)\]\);/.exec(cv)?.[1] || '';
  ok('client: the scoped-refusal codes are an EXPLICIT allow-list, not "anything with a code"', /'input-rejected'/.test(scopedSet) && /'not-codex-chat'/.test(scopedSet) && /'queue-op-unsupported'/.test(scopedSet), scopedSet);
  ok("…'ended-during-attach' is NOT in it (its session is dead — a live-looking empty window is the regression)", !!scopedSet && !/ended-during-attach/.test(scopedSet), scopedSet);
  ok("…and a NEW server refusal can opt in without a client release via scope:'action'", /msg\?\.scope === 'action'/.test(cv) && /scope: 'action'/.test(body));
  ok('client: an attach failure still takes the view-only rescue path', /if \(!this\._tryViewOnlyRescue\(\)\)/.test(cv));
  // the queue rides EVERY window-birth payload (the 2.368.4 rule)
  ok("attach carries the queue from the normalizer", /queue: session\._normalizer\?\.queueState\?\.\(\) \|\| \[\]/.test(read('src/ws-handler.js')));
  ok("…and the wrapper's queue advert — SUPPORTED **and the verb list** — rides the SAME payload (the client cannot read a sidecar), and it is computed from the ONE sidecar read the attach handler already made (2.369.16: no second /proc walk here)", /const wcapsAttach = wrapperCaps\(BUFFERS_DIR, data\.sessionId, session\.socketPath\);[\s\S]{0,3000}const wc = wcapsAttach;[\s\S]{0,700}return \{ queueSupported: !!served, queueVerbs: served \|\| null \};/.test(read('src/ws-handler.js')));
  { const wsc = read('src/ws-create.js');
    ok("…'created' carries all three, and says the fresh wrapper has reported NOTHING yet", /queue: \[\],/.test(wsc) && /queueSupported: false,[\s\S]{0,400}queueVerbs: null,/.test(wsc)); }
  ok('the client applies both through the carries-the-key guard, advert (and its verb list) FIRST', /if \('queueSupported' in meta\) this\._setQueueSupported\(meta\.queueSupported, \('queueVerbs' in meta\) \? meta\.queueVerbs : undefined\);\s*\n\s*if \('queue' in meta\) this\._setQueue\(meta\.queue\);/.test(cv));
  // ONE WRITER for the capability, because a FLIP has a consequence (the
  // rendered chips must be re-applied — round-2's MAJOR). A bare assignment
  // anywhere else silently skips it.
  ok('`_queueSupported` has exactly ONE writer besides its initialiser (_setQueueSupported), so every flip is observable',
    (cv.match(/this\._queueSupported = /g) || []).length === 2 && /_setQueueSupported\(next, verbs\) \{[\s\S]{0,700}this\._queueSupported = val;\s*\n\s*this\._queueVerbsServed = list;\s*\n\s*this\._refreshQueueChips\(\);/.test(cv),
    (cv.match(/this\._queueSupported = [^\n]*/g) || []));
  ok('…and the VERB LIST shares that one writer (a wrapper that gains verbs without changing `supported` must re-apply the chips too)',
    (cv.match(/this\._queueVerbsServed = /g) || []).length === 2 && /JSON\.stringify\(list\) === JSON\.stringify\(this\._queueVerbsServed\)/.test(cv),
    (cv.match(/this\._queueVerbsServed = [^\n]*/g) || []));
  ok("…and the live meta path uses it too (a wrapper's baseline queue_changed also arrives after the bubbles), carrying the verbs it published", /if \(op\.supported\) this\._setQueueSupported\(true, Array\.isArray\(op\.verbs\) \? op\.verbs : LEGACY_QUEUE_VERBS\.slice\(\)\);/.test(cv));
  ok("a queue op's RESULT reaches the strip as its own meta op (a row that spins forever is the silent failure wearing a spinner)", /if \(op\.subtype === 'queue-result'\) \{ this\._chatInput\?\.setQueueOpResult\(op\.id, op\.ok !== false, op\.text \|\| ''\); return; \}/.test(cv));
  ok('wiring pin: the strip, the row keyboard and the chip send the SAME ws message through one method', /const frame = \{ type: 'queue-op', sessionId: this\.sessionId, op, id: id \|\| null \};/.test(cv) && (cv.match(/type: 'queue-op'/g) || []).length === 1);
  ok("…and the verb's own argument rides it: afterId only when the caller supplied one (null = the front), text only when it is a string", /if \(extra && 'afterId' in extra\) frame\.afterId = extra\.afterId === null \? null : String\(extra\.afterId\);/.test(cv) && /if \(extra && typeof extra\.text === 'string'\) frame\.text = extra\.text;/.test(cv));
  // NO DEAD CONTROLS: the chip is clickable only where the VIEW says steer
  // (harness row ∧ running wrapper — ONE definition), and every queue action
  // on a read-only/offline window SPEAKS through one choke point.
  const cr = read('src/lib/chat-renderers.js');
  ok('the bubble chip asks the VIEW whether this session can steer (no second capability definition in the renderer)', /_canSteerQueue\(\) \? this\._onQueueChipClick : null/.test(cr) && /this\._getQueueCaps\?\.\(\)\?\.steer/.test(cr) && /getQueueCaps: \(\) => this\._queueCaps\(\)/.test(cv));
  ok('_queueCaps is the intersection: no wrapper advert ⇒ no controls at all', /if \(!this\._queueSupported\) return NO_QUEUE_CAPS;/.test(cv) && /const NO_QUEUE_CAPS = Object\.freeze\(\{ queue: false, steer: false, queueOps: false, queueVerbs: Object\.freeze\(\[\]\) \}\);/.test(cv));
  ok('…and it INTERSECTS the harness table with what the running wrapper serves, re-deriving steer/queueOps FROM the result (never carried over)', /const verbs = \(row\.queueVerbs \|\| \[\]\)\.filter\(\(v\) => !served \|\| served\.includes\(v\)\);/.test(cv) && /steer: verbs\.includes\('steer'\), queueOps: verbs\.length > 0, queueVerbs: verbs/.test(cv));
  ok('every queue action passes ONE liveness choke point that toasts (strip buttons included — a dead button that eats the click is the silent failure)', /_queueOpsLive\(\) \{/.test(cv) && /if \(!this\._queueOpsLive\(\)\) return false;\s*\n\s*const frame = \{ type: 'queue-op'/.test(cv) && (cv.match(/showToast\(t\('This session is not live/g) || []).length === 1);
  ok('…and the strip is DIMMED under .chat-input-disconnected, so the state is visible BEFORE the click', /\.chat-input-disconnected \.chat-queue-strip \{ opacity/.test(read('public/chat.css')));
  const cw2 = read('data/bin/codex-chat-wrapper.js');
  ok('removing a queued PEER message hands the text back to the delivery ladder (never a silent loss of a message already reported delivered)', /known\?\.kind === 'peer' && known\.text\) emitTaskEvent\('peer_message_result', \{ ok: false/.test(cw2));
  // A refused Steer-all printed the SAME failure twice, and the batch card
  // defaulted the turn kind to "review" (so a compact turn was named wrong).
  ok('a refused steer-all prints ONE card (the per-item result, which carries the real reason AND kind); the batch abort is journal-only', /log\(`steer-all aborted after/.test(cw2) && !/emitTaskEvent\('queue_op_result', \{ op: 'steer-all', ok: false/.test(cw2));
  ok('…and its SUCCESS summary is still emitted (bookkeeping, card-less by normalizer construction)', /emitTaskEvent\('queue_op_result', \{ op: 'steer-all', ok: true, done \}\)/.test(cw2));
  // STOP CLEARS THE QUEUE ON EVERY HARNESS (owner decision 2026-09-07 — the
  // 2026-09-06 divergence is closed). The bubbles must say 'removed', not clear
  // as if they had RUN (the normalizer clears a chip that left with no result).
  const aw2 = read('data/bin/acp-wrapper.js');
  ok("ACP Stop reports each dropped entry as a removal BEFORE the republish (a cleared chip means 'it ran')", /for \(const q of dropped\) record\('queue_op_result', \{ op: 'remove', id: q\.id, ok: true, msg_id: q\.opts\?\.msgId \|\| '', reason: 'stopped' \}\);\s*\n\s*if \(dropped\.length\) publishQueue\(\);/.test(aw2));
  ok('codex Stop clears the app-server queue too — the deletes go out BEFORE turn/interrupt, or the app-server drains them when the turn ends', /try \{ await clearQueueForStop\(\); \}[\s\S]{0,600}?if \(stopTurnId\) await interruptTurn\(stopTurnId\);/.test(cw2));
  // round-3: BOTH halves single-flight — a double-click (or a second attached
  // client) is ONE sweep and ONE interrupt, never a second sweep reporting the
  // first one's removals as "it already ran" (test-codex-p2-wrapper §②e drives it)
  ok('codex Stop is single-flight on both halves: a second Stop rides the running sweep and the in-flight turn/interrupt', /if \(stopSweepInFlight\) return stopSweepInFlight;/.test(cw2) && /if \(interruptInFlight && interruptInFlight\.turnId === turnId\)/.test(cw2));
  ok("codex steer reads the delete's verdict too: a drained item warns about the second run instead of a bare ok", /if \(!dequeued\) \{[\s\S]{0,400}?reason: 'steered-not-dequeued', detail: 'it had already left the queue \(it may run a second time\)'/.test(cw2));
  ok("…reporting each dropped item as a removal with reason 'stopped' (the SAME frame the ACP wrapper emits, so one client path renders both)", /emitTaskEvent\('queue_op_result', \{ op: 'remove', id, ok: true, msg_id: known\?\.msgId \|\| '', reason: 'stopped' \}\);/.test(cw2));
  ok('…and a delete that FAILS is reported (ok:false) + journalled, never a silent "cleared" queue', /emitTaskEvent\('queue_op_result', \{ op: 'remove', id, ok: false, reason: 'error', detail: e\.message, msg_id: known\?\.msgId \|\| '' \}\);/.test(cw2) && /log\(`interrupt: thread\/queue\/delete failed for/.test(cw2));
  ok('…and a queued PEER message Stop drops goes back to the delivery ladder (same rule as the explicit remove)', /if \(known\?\.kind === 'peer' && known\.text\) emitTaskEvent\('peer_message_result', \{ ok: false, reason: 'dropped by Stop before it was delivered'/.test(cw2));
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
  // WRAPPER SKEW, normalizer side (round-1 review): a codex session spawned
  // BEFORE this release emits `queued_input` (it has since 2.369.20) and never
  // a `queue_changed`. Stamping a chip there paints a 'Queued' badge that can
  // never clear and never be acted on — so with no published queue we keep the
  // old system card, which at least states the truth.
  const mm4 = new CodexMessageManager('q4');
  ok('a wrapper that has published no queue is not treated as one that has', mm4.queuePublished() === false);
  mm4.processLive({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', webui_msg_id: 'z1', content: [{ type: 'input_text', text: 'later' }] } });
  mm4.processLive({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'queued_input', msg_id: 'z1', turn_id: 't9' } });
  ok('PRE-RELEASE WRAPPER: queued_input keeps the old system card and stamps NO dead chip', mm4.messages.find((m) => m.role === 'user')?.queueState == null && mm4.messages.some((m) => m.role === 'system' && /Queued — runs after the current turn/.test(m.content[0].text)), mm4.messages.map((m) => [m.role, m.queueState]));
  mm4.processLive({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'queue_changed', items: [{ id: 'zq', msgId: 'z1', preview: 'later', kind: 'user' }] } });
  ok('…and the moment the wrapper DOES publish a queue, the chip appears and queuePublished() flips', mm4.queuePublished() === true && mm4.messages.find((m) => m.role === 'user')?.queueState === 'queued');
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
  ok('ACP: the user bubble carries its webui msgId too (one join, both harnesses)', am.messages.find((m) => m.role === 'user')?.webuiMsgId === 'a1');
  ok("the meta op CARRIES the wrapper's advert, so a window created before the sidecar existed turns its controls on", aops.some((o) => o.op === 'meta' && o.subtype === 'queue' && o.supported === true) && ops.some((o) => o.op === 'meta' && o.subtype === 'queue' && o.supported === true));
  ok('every CHAT normalizer answers queuePublished() (the same question everywhere, claude says never)', [mm, am].every((n) => typeof n.queuePublished === 'function') && require(path.join(REPO, 'src/message-manager.js')).MessageManager.prototype.queuePublished() === false);
}

// ⑨ THE Alt+Enter STEER CHORD (2026-09-07 owner ask: "顺便加入一个queue的快捷键,
// 不支持queue的就不显示"). The PURE caps→surfaces decision first: it is the
// ONE thing the chord, the hint, the ≤768px button and Session Properties all
// read, so a wrong answer here is wrong on four surfaces at once.
console.log('— ⑨a the PURE send-mode predicate (caps → {showHint, allowSteerChord})');
{
  const { composerSendModes } = await import(path.join(REPO, 'src/lib/agent-meta.js'));
  const { capsOf } = require(path.join(REPO, 'src/backend-caps.js'));
  const m = (id) => composerSendModes(capsOf(id).inputModes);
  const cx = m('codex');
  ok('codex (queue+steer+queueOps): both segments AND the chord', cx.showHint === true && cx.queueSegment === true && cx.steerSegment === true && cx.allowSteerChord === true, cx);
  const oc = m('opencode');
  ok('opencode (queue+queueOps, NO steer): the hint mentions Enter only, and Alt+Enter is not a chord', oc.showHint === true && oc.queueSegment === true && oc.steerSegment === false && oc.allowSteerChord === false, oc);
  const cl = m('claude');
  ok('claude (queues but publishes NO queue): NO hint and NO chord — the owner\'s rule, and there is nothing on screen a "it is queued" line could point at', cl.showHint === false && cl.queueSegment === false && cl.allowSteerChord === false, cl);
  const sh = m('shell');
  ok('shell (no input queue at all): nothing', sh.showHint === false && sh.allowSteerChord === false, sh);
  ok('an unknown backend / missing caps object is the all-false row (never codex\'s by accident)', [composerSendModes(undefined), composerSendModes(null), composerSendModes({}), m('gemini')].every((r) => r.showHint === false && r.allowSteerChord === false));
  // the chord is the SAME fact as the steer segment: a chord that silently
  // degraded to a plain send would be worse than no chord at all
  ok('allowSteerChord === steerSegment on every declared harness (one fact, never two)', Object.keys(require(path.join(REPO, 'src/backend-caps.js')).BACKEND_CAPS).every((id) => m(id).allowSteerChord === m(id).steerSegment));
  ok('…and the chord is never offered without the harness row saying steer', Object.keys(require(path.join(REPO, 'src/backend-caps.js')).BACKEND_CAPS).every((id) => m(id).allowSteerChord === capsOf(id).inputModes.steer));
  // it reads the LIVE intersection, so no wrapper advert ⇒ nothing offered
  ok('the all-false intersection chat-view returns without a wrapper advert yields no hint and no chord', composerSendModes({ queue: false, steer: false, queueOps: false }).showHint === false);
}

console.log('— ⑤ the client strip (DOM-free render of the REAL ChatInput)');
{
  const esbuild = require(path.join(REPO, 'node_modules/esbuild'));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-qs-')), 'chat-input.mjs');
  const stubBuildVersion = { name: 'stub-build-version', setup(b) { b.onResolve({ filter: /build-version\.js$/ }, () => ({ path: 'build-version', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: "export const BUILD_VERSION = 'test';", loader: 'js' })); } };
  await esbuild.build({ entryPoints: [path.join(REPO, 'src/lib/chat-input.js')], bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile: out, logLevel: 'silent', loader: { '.css': 'text' }, plugins: [stubBuildVersion] });
  const noop = () => {};
  // chat-input now imports agent-meta (the PURE composerSendModes lives with
  // the other caps helpers), and agent-meta installs a backend-icon
  // MutationObserver at import when `window` exists — the browser-emulating
  // stub below owes it the constructor (the test-search-card-title idiom).
  class NoopObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
  for (const k of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) { try { Object.defineProperty(globalThis, k, { value: NoopObserver, configurable: true, writable: true }); } catch {} }
  const mkEl = () => ({ className: '', dataset: {}, _html: '', classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} }, set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, appendChild() {}, append() {}, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, focus() {} });
  for (const [k, v] of Object.entries({ addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }), requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: noop, getComputedStyle: () => ({ getPropertyValue: () => '' }), innerWidth: 1024, innerHeight: 768, location: { origin: 'http://test', href: 'http://test/', hostname: 'test', protocol: 'http:' } })) {
    try { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); } catch {}
  }
  globalThis.window = globalThis;
  globalThis.document = { createElement: mkEl, getElementById: () => null, body: mkEl(), documentElement: mkEl(), head: mkEl(), addEventListener: noop, removeEventListener: noop, querySelector() { return null; }, querySelectorAll() { return []; }, createTextNode: (t) => ({ textContent: t }) };
  try { Object.defineProperty(globalThis, 'navigator', { value: { language: 'en', userAgent: 'node' }, configurable: true, writable: true }); } catch {}
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const { ChatInput } = await import(out);
  const { deriveInputModes: derive } = require(path.join(REPO, 'src/backend-caps.js'));
  const items = [
    { id: 'q1', msgId: 'm1', preview: 'first one', text: 'first one', ts: 1, kind: 'user' },
    { id: 'q2', msgId: '', preview: 'ping', ts: 2, kind: 'peer', from: 'session B' },
  ];
  const CODEX_CAPS = derive({ queue: true, queueVerbs: ['remove', 'steer', 'steer-all', 'reorder', 'edit', 'run-now', 'run-all'] });
  const full = ChatInput.queueStripHtml(items, CODEX_CAPS);
  ok('the strip heads with the count and what happens next', /2 queued — runs after this turn/.test(full), full.slice(0, 200));
  ok('one row per item, each carrying its app-server id', (full.match(/class="chat-queue-item"/g) || []).length === 2 && /data-queue-id="q1"/.test(full) && /data-queue-id="q2"/.test(full));
  ok('steer + remove buttons per row when the harness can steer', (full.match(/data-queue-op="steer"/g) || []).length === 2 && (full.match(/data-queue-op="remove"/g) || []).length === 2);
  ok('"Steer all" appears only when MORE THAN ONE is queued', /data-queue-op="steer-all"/.test(full) && !/data-queue-op="steer-all"/.test(ChatInput.queueStripHtml([items[0]], CODEX_CAPS)));
  ok('a peer message is LISTED and LABELLED (hiding it would misstate what runs next)', /class="chat-queue-from">session B</.test(full));
  const noSteer = ChatInput.queueStripHtml(items, derive({ queue: true, queueVerbs: ['remove'] }));
  ok('a harness that cannot steer offers ONLY remove — no steer button, no Steer all', !/data-queue-op="steer/.test(noSteer) && (noSteer.match(/data-queue-op="remove"/g) || []).length === 2);
  ok('rows are keyboard-reachable (tabindex) so Enter can steer a focused one', /class="chat-queue-item" tabindex="0"/.test(full));
  ok('icons are SVG, never a glyph (§17)', /<svg/.test(full) && !/[✕✖×⚡]/.test(full), full.slice(0, 120));
  // XSS: a preview is message text and syncs to EVERY client
  const evil = '<img src=x onerror=alert(1)>" onmouseover="y';
  const xss = ChatInput.queueStripHtml([{ id: evil, msgId: '', preview: evil, text: evil, kind: 'peer', from: evil }], CODEX_CAPS, { [evil]: { state: 'refused', title: evil } });
  ok('XSS: preview, sender, id AND a refusal reason are escaped everywhere they land (text + attributes)', !xss.includes('<img src=x') && !/onmouseover="y/.test(xss) && xss.includes('&lt;img') && (xss.match(/&quot;/g) || []).length >= 2, xss.slice(0, 300));

  // ── ⑨ THE VERB TABLE DRIVES THE CONTROLS (design-harness-features §2.1) ──
  // Every control is rendered from `caps.queueVerbs` — the harness table
  // INTERSECTED with what the running wrapper serves — so a rendered control
  // is one the server will honour.
  const CTRL = { remove: 'data-queue-op="remove"', steer: 'data-queue-op="steer"', 'steer-all': 'data-queue-op="steer-all"', reorder: 'data-queue-drag=', edit: 'data-queue-op="edit"', 'run-now': 'data-queue-op="run-now"', 'run-all': 'data-queue-op="run-all"' };
  for (const verb of Object.keys(CTRL)) {
    const withIt = ChatInput.queueStripHtml(items, derive({ queue: true, queueVerbs: [verb] }));
    const without = ChatInput.queueStripHtml(items, derive({ queue: true, queueVerbs: ['remove'].filter((v) => v !== verb) }));
    // 'steer-all' needs >1 item to show, which `items` has; every other verb
    // renders per row.
    ok(`'${verb}' declared ⇒ its control is rendered`, withIt.includes(CTRL[verb]), withIt.slice(0, 260));
    ok(`'${verb}' NOT declared ⇒ NO such control anywhere (never a button whose frame the ws layer refuses)`, !without.includes(CTRL[verb]), without.slice(0, 260));
  }
  {
    const codex = ChatInput.queueStripHtml(items, CODEX_CAPS);
    // PEER ITEMS: rewriting another agent's words would misattribute them (the
    // wrapper refuses it too — the control is hidden because it MEANS it).
    const rows = codex.split('class="chat-queue-item"').slice(1);
    ok('the PEER row carries no edit control (its words are not yours to rewrite)', rows.length === 2 && !rows[1].includes('data-queue-op="edit"'), rows[1]?.slice(0, 300));
    ok('…while your own row does', rows[0].includes('data-queue-op="edit"'));
    // …and neither does an item the wrapper did NOT send the full text for:
    // the 120-char preview would silently truncate the message on save.
    const noText = ChatInput.queueStripHtml([{ id: 'q9', msgId: 'm9', preview: 'a very long message…', kind: 'user' }], CODEX_CAPS);
    ok('an item whose FULL text the wrapper did not publish offers no edit control (editing a truncated preview would cut the message down)', !noText.includes('data-queue-op="edit"'), noText.slice(0, 300));
    ok('the peer row is still LISTED and labelled, and still removable/movable', rows[1].includes('session B') && rows[1].includes('data-queue-op="remove"') && rows[1].includes('data-queue-drag='));
    ok('"Run all now" is a HEADER control, distinct from per-row "Run this one now"', /chat-queue-head[\s\S]*?data-queue-op="run-all"/.test(codex) && (codex.match(/data-queue-op="run-now"/g) || []).length === 2);
    ok('every new control is an SVG icon, never a ✎ / ▶ / ⠿ glyph (§17)', !/[✎▶⠿⇅↑↓]/.test(codex), (codex.match(/[✎▶⠿⇅↑↓]/g) || []).join(''));
    ok('the drag handle names its KEYBOARD equivalent (a pointer-only control is half a control)', /title="[^"]*Alt\+Up[^"]*"/.test(codex), /title="[^"]*Alt[^"]*"/.exec(codex)?.[0]);
  }
  {
    // ROW STATE: pending while an op is in flight, refused WITH the reason on
    // the row (the system card scrolls away; the control the user pressed
    // must speak for itself).
    const st = new Map([['q1', { state: 'pending', title: '' }], ['q2', { state: 'refused', title: 'A turn is already running.' }]]);
    const html = ChatInput.queueStripHtml(items, CODEX_CAPS, st);
    ok('a row with an op in flight is marked pending', /data-queue-id="q1" data-queue-state="pending"/.test(html), html.slice(0, 400));
    ok('a refused row is marked AND carries its reason', /data-queue-state="refused" title="A turn is already running\."/.test(html));
    // ROUND-4 VERIFIER, finding 1: EDIT MODE IS ITS OWN ARGUMENT. It used to
    // be a third `rowState` value — the state every dispatch and every
    // refusal overwrites — so the ONE on-screen signal that an edit is open
    // was erased by any op touching that row (a batch verb marks EVERY row).
    const editingHtml = ChatInput.queueStripHtml(items, CODEX_CAPS, null, 'q1');
    ok('an editing row says so, and its edit control becomes a cancel', /data-queue-editing="1"/.test(editingHtml) && /data-queue-op="edit-cancel"/.test(editingHtml), editingHtml.slice(0, 400));
    ok('…and the hint under the strip comes from the SAME fact', /class="chat-queue-editing"/.test(editingHtml) && /send to save/.test(editingHtml));
    const bothHtml = ChatInput.queueStripHtml(items, CODEX_CAPS, new Map([['q1', { state: 'pending', title: 'x' }]]), 'q1');
    ok('finding 1: a row carries BOTH its op state and its edit mode — neither renders through the other', /data-queue-state="pending" data-queue-editing="1"/.test(bothHtml) && /data-queue-op="edit-cancel"/.test(bothHtml) && /class="chat-queue-editing"/.test(bothHtml), bothHtml.slice(0, 400));
    const refusedEditing = ChatInput.queueStripHtml(items, CODEX_CAPS, new Map([['q1', { state: 'refused', title: 'The agent could not be reached.' }]]), 'q1');
    ok('…a REFUSED edit that is open again shows the reason AND the editing marker', /data-queue-state="refused" data-queue-editing="1" title="The agent could not be reached\."/.test(refusedEditing) && /data-queue-op="edit-cancel"/.test(refusedEditing), refusedEditing.slice(0, 400));
    ok('negative control: no editingId ⇒ no editing marker, no cancel control, no hint, whatever the op state says', !/data-queue-editing/.test(ChatInput.queueStripHtml(items, CODEX_CAPS, new Map([['q1', { state: 'editing', title: '' }]]))) && !/edit-cancel/.test(ChatInput.queueStripHtml(items, CODEX_CAPS, new Map([['q1', { state: 'editing', title: '' }]]))) && !/class="chat-queue-editing"/.test(ChatInput.queueStripHtml(items, CODEX_CAPS, new Map([['q1', { state: 'editing', title: '' }]]))));
    ok('negative control: an editingId naming a row that is NOT in the queue paints nothing (a stale id is not a hint)', !/data-queue-editing/.test(ChatInput.queueStripHtml(items, CODEX_CAPS, null, 'q404')) && !/class="chat-queue-editing"/.test(ChatInput.queueStripHtml(items, CODEX_CAPS, null, 'q404')));
    // MERGE DEFECT (r2 verifier, finding 2): master's collapse (2.369.60) omits
    // the whole `.chat-queue-body`, and the edit's ✕ lives on a ROW — so a
    // collapsed strip used to leave the user in a mode whose row is invisible,
    // whose cancel is gone and whose Send silently still means "save". The
    // AUTO collapse is suppressed while editing (pinned on the live object
    // below), and the collapse the user DID ask for keeps the mode finishable
    // by putting the cancel on the always-drawn hint line.
    const collapsedEditing = ChatInput.queueStripHtml(items, CODEX_CAPS, null, 'q1', { collapsed: true });
    ok('a COLLAPSED strip with an open edit still says an edit is open', /class="chat-queue-editing"/.test(collapsedEditing) && /send to save/.test(collapsedEditing), collapsedEditing.slice(0, 400));
    ok('…and the cancel control is still REACHABLE, naming the row being edited (the body — and every row control in it — is gone)', !/chat-queue-body/.test(collapsedEditing) && !/class="chat-queue-item"/.test(collapsedEditing) && /data-queue-op="edit-cancel" data-queue-id="q1"/.test(collapsedEditing), collapsedEditing.slice(0, 600));
    ok('negative control: an EXPANDED strip puts the cancel on the row and does NOT duplicate it onto the hint line (one edit, one way out)', (ChatInput.queueStripHtml(items, CODEX_CAPS, null, 'q1').match(/data-queue-op="edit-cancel"/g) || []).length === 1);
    ok('negative control: a collapsed strip with NO edit open carries no cancel at all', !/edit-cancel/.test(ChatInput.queueStripHtml(items, CODEX_CAPS, null, null, { collapsed: true })));
    // …and the fallback obeys the SAME editability predicate as the row it
    // stands in for: a PEER row is never editable (rewriting another agent's
    // words misattributes them), so a stale editingId naming one must not
    // conjure a control the expanded strip would never have drawn.
    ok('negative control: a collapsed strip whose editingId names a PEER row draws the hint but NO cancel (the row would not have offered one either)',
      /class="chat-queue-editing"/.test(ChatInput.queueStripHtml(items, CODEX_CAPS, null, 'q2', { collapsed: true }))
      && !/edit-cancel/.test(ChatInput.queueStripHtml(items, CODEX_CAPS, null, 'q2', { collapsed: true }))
      && !/edit-cancel/.test(ChatInput.queueStripHtml(items, CODEX_CAPS, null, 'q2')));
    ok('negative control: a harness without the `edit` verb gets no cancel in a collapsed strip either',
      !/edit-cancel/.test(ChatInput.queueStripHtml(items, derive({ queue: true, queueVerbs: ['remove', 'reorder'] }), null, 'q1', { collapsed: true })));
    // …and the collapsed markup that made the defect possible is otherwise
    // unchanged (master's own contract: header + chevron, no rows).
    ok('the collapsed strip is header-only with a chevron that says it is collapsed', /class="chat-queue-toggle" aria-expanded="false"/.test(collapsedEditing));
  }
  {
    // EVERY op's outcome has to REACH the strip, including the BATCH verbs
    // that name no item (run-all / steer-all): the dispatch marks every row
    // pending, so a result the client cannot join to a row leaves the whole
    // strip spinning. Driven through the REAL normalizer.
    const { CodexMessageManager: CMM } = require(path.join(REPO, 'src/codex-message-manager.js'));
    const { AcpMessageManager: AMM } = require(path.join(REPO, 'src/acp-message-manager.js'));
    const cm = new CMM('batch'); const cops = []; cm.onOp((o) => cops.push(o));
    cm.processLive({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'queue_op_result', op: 'run-all', id: '', ok: false, reason: 'busy', detail: 'a turn is running' } });
    const res = cops.filter((o) => o.op === 'meta' && o.subtype === 'queue-result');
    ok("a BATCH result (no id) still reaches the client as a queue-result meta op", res.length === 1 && res[0].id === '' && res[0].ok === false && res[0].reason === 'busy' && /already running/.test(res[0].text || ''), res);
    const cm2 = new CMM('batch2'); const cops2 = []; cm2.onOp((o) => cops2.push(o));
    cm2.processLive({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'queue_op_result', op: 'reorder', id: 'q1', msg_id: 'm1', ok: true } });
    ok('…and a per-item success does too (the row must stop spinning even when nothing else changes)', cops2.some((o) => o.subtype === 'queue-result' && o.id === 'q1' && o.ok === true));
    ok('…while a successful reorder/edit stamps NO chip (the bubble is still your queued message; the strip is the confirmation)', !cops2.some((o) => o.op === 'edit' && o.fields?.queueState));
    const am = new AMM('batch3'); const aops = []; am.onOp((o) => aops.push(o));
    am.processLive({ ts: new Date().toISOString(), type: 'acp', kind: 'queue_op_result', op: 'reorder', id: 'p1', msg_id: 'a1', ok: true });
    ok('ACP emits the same queue-result meta op (one client path, both harnesses)', aops.some((o) => o.op === 'meta' && o.subtype === 'queue-result' && o.id === 'p1' && o.ok === true), aops);
    ok('…and does NOT stamp a removed/steered chip for a reorder (only a removal changes what a bubble means)', !aops.some((o) => o.op === 'edit' && o.fields?.queueState));
  }

  // ⑨b THE HINT LINE, from the REAL ChatInput's own PURE composer.
  const { composerSendModes: modesOf } = await import(path.join(REPO, 'src/lib/agent-meta.js'));
  const { capsOf: srvCaps } = require(path.join(REPO, 'src/backend-caps.js'));
  const hint = (id) => ChatInput.sendHintHtml(modesOf(srvCaps(id).inputModes));
  ok('codex: BOTH segments, separated', /Enter queues/.test(hint('codex')) && /Alt\+Enter injects now/.test(hint('codex')) && /chat-send-hint-sep/.test(hint('codex')), hint('codex'));
  ok('opencode: the queue segment only — the line never teaches a key that does nothing here', /Enter queues/.test(hint('opencode')) && !/Alt\+Enter/.test(hint('opencode')) && !/chat-send-hint-sep/.test(hint('opencode')), hint('opencode'));
  ok('claude / shell: the hint is EMPTY markup (and _updateSendModes never unhides it)', hint('claude') === '' && hint('shell') === '');
  ok('the hint carries no raw glyph icon and every phrase is a t() key (zh+ja pinned below)', !/[⚡✕]/.test(hint('codex')));

  // …and the capability plumbing, on the REAL prototype (chat-view's own
  // DOM-free idiom): the chord is a CAPABILITY answer — never "is there text",
  // which would make the hint and the `when` flicker per keystroke — and it
  // needs a RUNNING TURN.
  const mkCI = (over = {}) => Object.assign(Object.create(ChatInput.prototype), { _isStreaming: false, _queueCaps: { queue: false, steer: false, queueOps: false } }, over);
  const cxCaps = srvCaps('codex').inputModes;
  ok('IDLE codex session: no turn ⇒ no chord (Enter is an ordinary send)', mkCI({ _queueCaps: cxCaps }).steerChordAllowed === false);
  ok('…and mid-turn the chord is live', mkCI({ _queueCaps: cxCaps, _isStreaming: true }).steerChordAllowed === true);
  ok('opencode mid-turn: queue but no steer ⇒ still no chord', mkCI({ _queueCaps: srvCaps('opencode').inputModes, _isStreaming: true }).steerChordAllowed === false);
  ok('claude mid-turn: no chord', mkCI({ _queueCaps: srvCaps('claude').inputModes, _isStreaming: true }).steerChordAllowed === false);
  ok('a session whose caps have not arrived yet (the late-capability ordering) offers no chord', mkCI({ _isStreaming: true }).steerChordAllowed === false);
  ok('the chord answer NEVER consults the textarea (it must not flicker per keystroke)', !/steerChordAllowed[\s\S]{0,200}_textarea/.test(read('src/lib/chat-input.js')));

  // steerNow: the ONE send path, then the msgId handed on. Drive the REAL
  // method with _send stubbed to the contract it now has (msgId | null).
  {
    let sends = 0, handed = null;
    const ci = mkCI({ _queueCaps: cxCaps, _isStreaming: true, _send: () => { sends++; return 'm-42'; }, _onSteerSend: (id) => { handed = id; } });
    ok('THE CHORD SENDS ON THE ORDINARY PATH and hands its msgId on (no second wire shape)', ci.steerNow() === true && sends === 1 && handed === 'm-42');
    // THE TWO NON-STRING ANSWERS, each with the value the MERGED `_send` can
    // actually produce (r2 verifier: this leg stubbed `null`, a value the
    // three-valued contract can never return, so `true` — the one state the
    // merge INVENTED — was unpinned and the assert passed only because
    // `typeof null !== 'string'`).
    const empty = mkCI({ _queueCaps: cxCaps, _isStreaming: true, _send: () => false, _onSteerSend: () => { handed = 'NO'; } });
    handed = null;
    ok('an empty composer / a disconnected socket / an attachment-less bail (all `_send() === false`) reports NO steerable send — a pending steer that can only time out is a lie', empty.steerNow() === false && handed === null);
    const tookBox = mkCI({ _queueCaps: cxCaps, _isStreaming: true, _send: () => true, _onSteerSend: () => { handed = 'NO'; } });
    handed = null;
    ok('`_send() === true` (a /goal or a queued-message edit TOOK the box without producing a queueable message) reports NO steerable send and hands no id', tookBox.steerNow() === false && handed === null);
    // NEGATIVE CONTROL for both: the ONLY answer that steers is a string id —
    // a `typeof r === 'string'` that decayed to a truthiness test would steer
    // the `true` above (naming no item) and pass every assert around it.
    let handedId = null;
    const real = mkCI({ _queueCaps: cxCaps, _isStreaming: true, _send: () => 'm-99', _onSteerSend: (id) => { handedId = id; } });
    ok('…and the positive control still steers on a STRING id (the guard is `typeof`, not truthiness)', real.steerNow() === true && handedId === 'm-99');
    const cant = mkCI({ _queueCaps: srvCaps('claude').inputModes, _isStreaming: true, _send: () => { sends++; return 'x'; } });
    ok('steerNow() on a harness that cannot steer sends NOTHING at all', cant.steerNow() === false && sends === 1);
  }
  // _send's MERGED contract, at the source (2.369.61 chord ⊕ round-5 bail-out):
  // a STRING msgId when a queueable message went out, `true` when it took the
  // box without one (/goal, an edit), `false` on every bail.
  {
    const src = read('src/lib/chat-input.js');
    ok('_send returns the msgId for a real message, `true` when it took the box without one (/goal, an edit), and `false` on every bail — the chord reads the id, sendText reads the bail',
      /return msgId;/.test(src) && (src.match(/return false;/g) || []).length >= 3 && /const msgId = typeof r === 'string' \? r : null;/.test(src), (src.match(/return (false|true|msgId);[^\n]*/g) || []));
    // …and the value it can NEVER answer with (r2 verifier): the pre-merge
    // contract's `null` is gone, so a stub that returns it tests nothing.
    const sendBody = src.slice(src.indexOf('\n  _send() {'), src.indexOf('\n  _addImageAttachment('));
    ok('the merged _send has no `return null` path left — the third value is `true`, and a test stubbing `null` would pin a state the product cannot reach',
      sendBody.length > 500 && !/\breturn null\b/.test(sendBody), sendBody.length);
  }
}

console.log('— ⑦ FUNCTIONAL client: a normalizer-produced bubble → a real queue-op, and the error split');
{
  // chat-view.js is DOM-free at IMPORT (the trim-guard suite relies on the
  // same property), so the decisions run here for real instead of by grep.
  // A minimal document stub only exists for showToast, whose text is captured.
  const created = [];
  // The stub carries just enough tree for applyQueueChip to be IDEMPOTENT the
  // way the real DOM makes it: ':scope > .chat-queue-chip' finds the previous
  // chip and prev.remove() detaches it (a no-op remove() would let the chips
  // double and hide exactly the bug this leg exists for).
  const mkEl = () => {
    const e = {
      className: '', id: '', textContent: '', style: {}, dataset: {}, children: [], _parent: null,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {}, append() {},
      appendChild(c) { this.children.push(c); if (c && typeof c === 'object') c._parent = this; return c; },
      remove() { const p = this._parent; if (!p) return; const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); this._parent = null; },
      addEventListener() {}, removeEventListener() {},
      querySelector(sel) {
        const m = /^:scope > \.([\w-]+)$/.exec(String(sel || ''));
        if (!m) return null;
        return this.children.find((c) => String(c?.className || '').split(/\s+/).includes(m[1])) || null;
      },
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), offsetParent: null,
      get firstChild() { return this.children[0] || null; },
    };
    created.push(e); return e;
  };
  globalThis.document = { createElement: mkEl, getElementById: () => null, body: mkEl(), documentElement: mkEl(), addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
  const toasts = () => created.filter((e) => e.className === 'global-toast-body').map((e) => e.textContent);

  const { ChatView } = await import(path.join(REPO, 'src/lib/chat-view.js'));
  const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));

  // THE BLOCKER round 1 found: the chip's join used msg.webuiMsgId, which
  // nothing ever wrote — the webui id lived ONLY in the normalizer's private
  // userMessageIds map, which never leaves the server. Every chip click
  // answered "That message is no longer queued". Drive the REAL pair.
  const mm = new CodexMessageManager('fn');
  const now = new Date().toISOString();
  mm.processLive({ timestamp: now, type: 'response_item', payload: { type: 'message', role: 'user', webui_msg_id: 'm7', content: [{ type: 'input_text', text: 'hello' }] } });
  mm.processLive({ timestamp: now, type: 'event_msg', payload: { type: 'queue_changed', items: [{ id: 'q7', msgId: 'm7', preview: 'hello', ts: 1, kind: 'user' }], turn_id: 't1' } });
  const bubble = mm.messages.find((x) => x.role === 'user');
  ok('the normalizer stamps the webui msgId ON the message (a server-only side map is not an identity the client can join on)', bubble?.webuiMsgId === 'm7', bubble);
  ok('…and it is the id the chip joins on', ChatView.prototype._msgIdOf.call(null, bubble) === 'm7');

  let sent = [], notices = [];
  const mkView = (over = {}) => Object.assign(Object.create(ChatView.prototype), {
    sessionId: 'sess-9', ws: { send: (m) => sent.push(m) },
    _readOnly: false, _disconnected: false, _chatInput: null,
    _queue: mm.queueState(), _queueSupported: true,
    _getSessionIds: () => ({ backend: 'codex' }), winInfo: { backend: 'codex' },
    _renderers: { appendSystem: (txt) => notices.push(txt) },
    _hideTyping() {}, _telemDetail: (x) => String(x || ''),
    _tryViewOnlyRescue: () => { rescued++; return true; }, _setReadOnly() { readOnlyed++; },
  }, over);
  let rescued = 0, readOnlyed = 0;

  sent = []; notices = [];
  ChatView.prototype._steerQueuedMessage.call(mkView(), bubble);
  ok('THE FIX, END TO END: clicking a queued bubble\'s chip sends the queue-op for THAT item', sent.length === 1 && sent[0].type === 'queue-op' && sent[0].op === 'steer' && sent[0].id === 'q7' && sent[0].sessionId === 'sess-9', { sent, notices });
  ok('…and says nothing wrong about the message', notices.length === 0, notices);

  sent = []; notices = [];
  const other = { id: 'x', role: 'user', webuiMsgId: 'm-gone' };
  ChatView.prototype._steerQueuedMessage.call(mkView(), other);
  ok('a bubble that is NOT in the queue any more is told so, and nothing is sent', sent.length === 0 && notices.some((n) => /no longer queued/.test(n)), { sent, notices });

  sent = []; notices = [];
  ChatView.prototype._steerQueuedMessage.call(mkView({ _queueSupported: false }), bubble);
  ok('a session whose RUNNING wrapper never advertised a queue offers nothing (the skew gate, client side)', sent.length === 0 && notices.length === 0);

  sent = []; notices = [];
  const before = toasts().length;
  ChatView.prototype._sendQueueOp.call(mkView({ _disconnected: true }), 'remove', 'q7');
  ok('a strip button on a DISCONNECTED window sends nothing and TOASTS (it used to silently do nothing)', sent.length === 0 && toasts().length === before + 1 && /not live/.test(toasts().slice(-1)[0] || ''), toasts().slice(-1));
  sent = []; notices = [];
  ChatView.prototype._steerQueuedMessage.call(mkView({ _readOnly: true }), bubble);
  ok('…and a read-only window blames the SOCKET, not the message', sent.length === 0 && !notices.some((n) => /no longer queued/.test(n)), notices);

  // THE MAJOR round 1 found: "any coded error is a scoped refusal" quietly
  // regressed 'ended-during-attach' (ws-handler, after the history rebuild) —
  // its session IS gone, so it must keep the view-only rescue + Resume bar.
  notices = []; rescued = 0; readOnlyed = 0;
  ChatView.prototype._onSessionError.call(mkView(), { type: 'error', sessionId: 'sess-9', code: 'queue-op-unsupported', scope: 'action', message: 'nope' });
  ok('a scoped refusal renders in chat and leaves the window ALONE (inc-mt2arppw)', rescued === 0 && readOnlyed === 0 && notices.some((n) => /nope/.test(n)), { notices, rescued, readOnlyed });
  notices = []; rescued = 0; readOnlyed = 0;
  ChatView.prototype._onSessionError.call(mkView(), { type: 'error', sessionId: 'sess-9', code: 'ended-during-attach', message: 'Session sess-9 ended while its history was loading' });
  ok("THE REGRESSION GUARD: 'ended-during-attach' still takes the view-only rescue (never a live-looking empty window)", rescued === 1 && notices.length === 0, { notices, rescued });
  notices = []; rescued = 0; readOnlyed = 0;
  ChatView.prototype._onSessionError.call(mkView(), { type: 'error', sessionId: 'sess-9', message: 'Session not found' });
  ok('a code-LESS error is the attach failure it always was', rescued === 1);
  notices = []; rescued = 0; readOnlyed = 0;
  ChatView.prototype._onSessionError.call(mkView({ _tryViewOnlyRescue: () => false }), { type: 'error', sessionId: 'sess-9', code: 'ended-during-attach', message: 'gone' });
  ok('…and when even the rescue cannot work, the window says so and goes read-only', readOnlyed === 1 && notices.some((n) => /gone/.test(n)));

  // ── ROUND-2 VERIFIER, finding 3 (client half): a ws-layer refusal is the ONE
  // outcome that never arrives as a `queue-result` meta op, so the row the
  // strip marked pending had nothing to end it — one click on a verb this
  // wrapper does not serve left a spinner on the row forever.
  {
    const results = [];
    const view = mkView({ _chatInput: { setQueueOpResult: (...a) => results.push(a) } });
    ChatView.prototype._onSessionError.call(view, { type: 'error', sessionId: 'sess-9', code: 'queue-op-unsupported', scope: 'action', op: 'run-now', id: 'q7', message: 'This session\'s agent is an older build.' });
    ok(`finding 3: a ws refusal ENDS the row's pending state, carrying its reason (${JSON.stringify(results)})`, results.length === 1 && results[0][0] === 'q7' && results[0][1] === false && /older build/.test(results[0][2] || ''), results);
    results.length = 0;
    ChatView.prototype._onSessionError.call(view, { type: 'error', sessionId: 'sess-9', code: 'queue-op-unsupported', scope: 'action', op: 'run-all', id: null, message: 'A turn is running.' });
    ok('…and a BATCH verb (no id) ends every pending row, which is what an empty id already means to the strip', results.length === 1 && results[0][0] === '');
    results.length = 0;
    ChatView.prototype._onSessionError.call(view, { type: 'error', sessionId: 'sess-9', code: 'input-rejected', message: 'too big' });
    ok('…and an unrelated scoped refusal touches no queue row', results.length === 0, results);
  }

  // ── ROUND-2 VERIFIER, finding 4: "no verb list" is UNKNOWN on the payload
  // path and "the pre-table three" on the in-band path — reading it as "serves
  // nothing" made the intersection empty and hid the ENTIRE strip from a
  // session the server was happily serving remove/steer/steer-all for
  // (kb-api's documented behaviour, inverted).
  {
    const { LEGACY_QUEUE_VERBS } = require(path.join(REPO, 'src/backend-caps.js'));
    const mkFresh = (served) => Object.assign(Object.create(ChatView.prototype), {
      sessionId: 'sess-legacy', ws: { send() {} }, _readOnly: false, _disconnected: false,
      _chatInput: null, _disposed: false, _messages: [], _elements: new Map(), _queue: [],
      _queueSupported: false, _queueVerbsServed: served, _queueChipRaf: 0,
      _getSessionIds: () => ({ backend: 'codex' }), winInfo: { backend: 'codex' },
    });
    const legacy = JSON.stringify([...LEGACY_QUEUE_VERBS]);
    ok('the legacy verb list has ONE definition, in the PURE module both ends import (server mapping ⇄ client mapping)',
      legacy === JSON.stringify(['remove', 'steer', 'steer-all'])
      && require(path.join(REPO, 'src/server/wrapper-files.js')).LEGACY_QUEUE_VERBS === LEGACY_QUEUE_VERBS
      && /import \{ LEGACY_QUEUE_VERBS \} from '\.\.\/backend-caps\.js';/.test(read('src/lib/chat-view.js')));
    // THE REPRODUCTION: the create payload says "nothing known" and then a
    // pre-verb-table wrapper publishes a queue with no `verbs`.
    const v1 = mkFresh(null);
    ChatView.prototype._onMeta.call(v1, { op: 'meta', subtype: 'queue', supported: true, items: [] });
    ok(`finding 4: a verb-LESS publication yields the legacy three, never an empty strip (${JSON.stringify(v1._queueCaps().queueVerbs)})`, JSON.stringify(v1._queueCaps().queueVerbs) === legacy && v1._queueCaps().queueOps === true);
    // …and the shape the OLD server sent (an empty ARRAY for "unknown") must
    // not survive as a filter either.
    const v2 = mkFresh([]);
    ChatView.prototype._onMeta.call(v2, { op: 'meta', subtype: 'queue', supported: true, items: [] });
    ok('…and an inherited empty list does not silently keep filtering everything out', JSON.stringify(v2._queueCaps().queueVerbs) === legacy);
    // NEGATIVE CONTROL: a publication that DOES name verbs is still obeyed to
    // the letter (the mapping is for the verb-less case only).
    const v3 = mkFresh(null);
    ChatView.prototype._onMeta.call(v3, { op: 'meta', subtype: 'queue', supported: true, items: [], verbs: ['remove', 'reorder'] });
    ok('…while a wrapper that NAMES its verbs is intersected exactly as before', JSON.stringify(v3._queueCaps().queueVerbs) === JSON.stringify(['remove', 'reorder']));
    const v4 = mkFresh(null);
    ChatView.prototype._onMeta.call(v4, { op: 'meta', subtype: 'queue', supported: true, items: [], verbs: [] });
    ok('…and a wrapper that explicitly serves NOTHING still gets no controls (an empty list is a real answer)', JSON.stringify(v4._queueCaps().queueVerbs) === '[]');
  }

  // ── THE MAJOR round 2 found: THE CHIP IS RENDERED BEFORE THE CAPABILITY
  // ARRIVES. `_queueSupported` starts false; loadHistory renders EVERY message
  // and only then calls `_applyLiveMeta` (which carries the attach payload's
  // `queueSupported`), and on a live session the wrapper's baseline
  // `queue_changed` lands after the first bubbles too. A chip built in that
  // window got onSteer=null ⇒ permanently `disabled`, and nothing re-rendered
  // it — so after ANY history load the 'Queued' chip was dead and its click
  // sent nothing. Drive the REAL renderer + REAL view methods.
  const { ChatRenderers } = await import(path.join(REPO, 'src/lib/chat-renderers.js'));
  const chipsOf = (el) => (el?.children || []).filter((c) => /\bchat-queue-chip\b/.test(String(c?.className || '')));
  const chipOf = (el) => chipsOf(el)[0] || null;
  const flush = () => new Promise((r) => setTimeout(r, 40));   // the rAF coalescing window
  // A dead chip must FAIL the assert below, not crash the suite on `undefined()`
  const clickChip = (el) => { const c = chipOf(el); if (typeof c?.onclick === 'function') c.onclick({ stopPropagation() {} }); };
  const mkQueuedView = () => {
    const out = [];
    const view = Object.assign(Object.create(ChatView.prototype), {
      sessionId: 'sess-q', ws: { send: (m) => out.push(m) },
      _readOnly: false, _disconnected: false, _chatInput: null, _disposed: false, _statusBar: null,
      _messages: [], _elements: new Map(), _queue: [], _queueSupported: false, _queueChipRaf: 0,
      _getSessionIds: () => ({ backend: 'codex' }), winInfo: { backend: 'codex' },
    });
    // The REAL renderer, wired to the view exactly as ChatView wires it.
    view._renderers = new ChatRenderers({
      ws: view.ws, sessionId: view.sessionId, app: null, backend: 'codex', compact: false,
      messageList: mkEl(), onQueueChipClick: (m) => view._steerQueuedMessage(m),
      getQueueCaps: () => view._queueCaps(),
    });
    // …and a bubble rendered while the capability is still the constructor
    // default — the loadHistory ordering, reproduced.
    const el = view._renderers.renderUserMsg(bubble);
    view._messages.push(bubble); view._elements.set(bubble.id, el);
    view._queue = mm.queueState();
    return { view, el, out };
  };

  {
    const { view, el, out } = mkQueuedView();
    ok('a bubble rendered BEFORE the capability lands still SHOWS its queued chip', chipOf(el)?.dataset?.queueState === 'queued', chipsOf(el).map((c) => c.className));
    ok('…and THAT chip is inert — the exact state the bug shipped in', chipOf(el).disabled === true && typeof chipOf(el).onclick !== 'function');
    // THE ATTACH PATH: `attached.queueSupported` arrives after loadHistory
    ChatView.prototype._applyLiveMeta.call(view, { queueSupported: true, queue: mm.queueState() });
    await flush();
    ok('THE FIX (attach path): the capability flipping false→true re-applies the rendered chips', !!chipOf(el) && !chipOf(el).disabled && typeof chipOf(el).onclick === 'function', { disabled: chipOf(el)?.disabled });
    ok('…and exactly ONE chip is on the bubble (a re-application replaces, it never doubles)', chipsOf(el).length === 1, chipsOf(el).length);
    clickChip(el);
    ok('…and clicking it sends the REAL steer for THAT queue item', out.length === 1 && out[0].type === 'queue-op' && out[0].op === 'steer' && out[0].id === 'q7' && out[0].sessionId === 'sess-q', out);
    // …and the reverse flip must make it inert again: a control that cannot
    // work must never look live (the wrapper advert can go away on re-attach).
    ChatView.prototype._applyLiveMeta.call(view, { queueSupported: false });
    await flush();
    ok('a flip true→false makes the chips inert again (no control that would send a frame nobody serves)', chipOf(el).disabled === true && chipsOf(el).length === 1);
  }
  {
    // THE LIVE PATH: same ordering, different messenger — the wrapper's own
    // baseline `queue_changed` (op meta subtype 'queue', supported:true).
    const { view, el, out } = mkQueuedView();
    ok('LIVE ordering: a chip rendered before the wrapper published its queue is inert too', chipOf(el).disabled === true);
    ChatView.prototype._onMeta.call(view, { op: 'meta', subtype: 'queue', supported: true, items: mm.queueState() });
    await flush();
    ok("THE FIX (live path): the wrapper's baseline queue_changed re-applies the chips", !chipOf(el).disabled && typeof chipOf(el).onclick === 'function');
    clickChip(el);
    ok('…and that chip steers for real as well', out.length === 1 && out[0].op === 'steer' && out[0].id === 'q7', out);
  }

  // ── ⑨c THE CHORD'S SECOND HALF, functionally: send → queued → steer.
  // A steer NAMES A QUEUED ITEM (there is no "send this text as a steer" verb
  // anywhere), so the conversion has to survive the round trip through the
  // harness — and the one thing the user may never be lied about is "we never
  // got the id back".
  {
    const mkSteerView = (over = {}) => {
      const out = [];
      const notes = [];
      const view = Object.assign(Object.create(ChatView.prototype), {
        sessionId: 'sess-chord', ws: { send: (m) => out.push(m) },
        _readOnly: false, _disconnected: false, _disposed: false, _chatInput: null,
        _queue: [], _queueSupported: true, _pendingSteers: new Map(),
        _getSessionIds: () => ({ backend: 'codex' }), winInfo: { backend: 'codex' },
        _renderers: { appendSystem: (txt) => notes.push(txt) },
      }, over);
      // THE TURN IS ARMED THROUGH THE REAL METHOD, never by a hand-set flag
      // (round-2 verifier): what the silence guard compares is the turn's
      // IDENTITY, and a fixture that assigns `_typingSince` itself cannot
      // produce one — nor can it produce the sequence that actually happens.
      ChatView.prototype._showTyping.call(view, 'thinking...');
      return { view, out, notes };
    };
    {
      const { view, out } = mkSteerView();
      ChatView.prototype._steerAfterSend.call(view, 'm-99');
      ok('the chord parks the msgId and sends NOTHING yet (the item has no id until the harness publishes it)', out.length === 0 && view._pendingSteers.has('m-99'));
      ChatView.prototype._setQueue.call(view, [{ id: 'q99', msgId: 'm-99', preview: 'do it now', kind: 'user' }]);
      ok('THE CONVERSION: the queue_changed carrying that msgId fires the ORDINARY queue-op steer for its id (no second wire shape)', out.length === 1 && out[0].type === 'queue-op' && out[0].op === 'steer' && out[0].id === 'q99', out);
      ok('…and the pending entry is cleared, so a later queue update can never steer it twice', view._pendingSteers.size === 0);
      ChatView.prototype._setQueue.call(view, [{ id: 'q99', msgId: 'm-99', preview: 'do it now', kind: 'user' }]);
      ok('…proven: a repeat of the same queue publishes nothing more', out.length === 1, out);
    }
    {
      const { view, out } = mkSteerView();
      ChatView.prototype._steerAfterSend.call(view, 'm-1');
      ChatView.prototype._steerAfterSend.call(view, 'm-2');
      ok('two chords in a row park BOTH msgIds (a single pending slot would silently drop the first)', view._pendingSteers.size === 2);
      ChatView.prototype._setQueue.call(view, [{ id: 'qa', msgId: 'm-1' }, { id: 'qb', msgId: 'm-2' }]);
      ok('…and both are converted, in queue order', out.length === 2 && out[0].id === 'qa' && out[1].id === 'qb', out);
    }
    {
      const { view, out } = mkSteerView({ _queue: [{ id: 'qz', msgId: 'm-z' }] });
      ChatView.prototype._steerAfterSend.call(view, 'm-z');
      ok('a queue update that LANDED FIRST is converted immediately (the chord re-checks on arrival)', out.length === 1 && out[0].id === 'qz', out);
    }
    {
      const { view, out } = mkSteerView({ _queueSupported: false });
      ChatView.prototype._steerAfterSend.call(view, 'm-x');
      ok('a session that cannot steer parks nothing at all', view._pendingSteers.size === 0 && out.length === 0);
    }
    {
      const { view } = mkSteerView();
      ChatView.prototype._steerAfterSend.call(view, 'm-lost');
      ok('the wait is BOUNDED (a timer, not a leak)', !!view._pendingSteers.get('m-lost'));
      ChatView.prototype._clearPendingSteers.call(view);
      ok('…and _clearPendingSteers empties it (dispose calls it — no orphaned callback into a closed window)', view._pendingSteers.size === 0);
      ok('the wait outlasts a wrapper round trip', ChatView.STEER_CHORD_WAIT_MS >= 5000);
    }
    // NO SILENT FAILURE, and no false alarm either: the timeout speaks ONLY
    // while the turn is still running. Driven for REAL with the wait shrunk
    // (the ⑧ idiom — the shipped value is pinned above).
    {
      const realWait = Object.getOwnPropertyDescriptor(ChatView, 'STEER_CHORD_WAIT_MS');
      Object.defineProperty(ChatView, 'STEER_CHORD_WAIT_MS', { get: () => 30, configurable: true });
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const still = mkSteerView();                 // the turn is STILL running
      const ended = mkSteerView();                 // it ended and nothing followed
      const ranOwn = mkSteerView();                // it ended and THE MESSAGE became the next turn
      const gone = mkSteerView({ _disposed: true });
      const epochAtSend = ranOwn.view._turnEpoch;
      for (const v of [still, ended, ranOwn, gone]) ChatView.prototype._steerAfterSend.call(v.view, 'm-lost');
      // the turn simply ends (real method, not a hand-set flag)
      ChatView.prototype._hideTyping.call(ended.view);
      // …and THE ROUND-2 MAJOR's sequence: the wrapper was idle, so it ran the
      // message as its OWN turn — which is the ONLY way this timer survives to
      // fire at all (a busy wrapper queues, and a queued item drains the
      // pending entry). The turn ends, the next one starts.
      ChatView.prototype._noteTurnBoundary.call(ranOwn.view); // what the turn_complete meta op does first
      ChatView.prototype._hideTyping.call(ranOwn.view);
      ChatView.prototype._showTyping.call(ranOwn.view, 'thinking...');
      await wait(150);
      ok('THE HONEST TIMEOUT: the id never came and the turn is STILL running ⇒ the window SAYS the injection did not happen (never a user believing it did)', still.notes.length === 1 && /could not be injected into the running turn/.test(still.notes[0]), still.notes);
      ok('…and NOT when the turn ended meanwhile — the message then runs next, immediately, which is what "now" asked for (a false alarm is its own failure)', ended.notes.length === 0, ended.notes);
      ok('THE ROUND-2 MAJOR: the turn ended and THE MESSAGE ITSELF became the next turn (the only shape that lets this timer fire) ⇒ still silent — the window may not apologise for a message the agent is visibly running', ranOwn.notes.length === 0, ranOwn.notes);
      ok('NEGATIVE CONTROL: on that very view the OLD guard (`_typingSince` truthiness) HELD at fire time, so the shipped code would have posted the false notice — what saves it is that the TURN IDENTITY changed', !!ranOwn.view._typingSince === true && (ranOwn.view._turnEpoch || 0) !== epochAtSend, { typingSince: !!ranOwn.view._typingSince, epochAtSend, now: ranOwn.view._turnEpoch });
      ok('…and a disposed view says nothing into a closed window', gone.notes.length === 0);
      ok('…and nothing was sent on the wire in any of the four (a steer with no id is not a frame)', still.out.length === 0 && ended.out.length === 0 && ranOwn.out.length === 0 && gone.out.length === 0);
      // THE OTHER HALF of the same guard: a turn does not "change" because the
      // harness relabelled it. If the epoch advanced on every stream label the
      // honest apology would be silenced by a single "running Bash".
      {
        const repaint = mkSteerView();
        const e0 = repaint.view._turnEpoch || 0; // a fresh view has seen no boundary yet (round 3: the epoch is stamped by turn_complete, not by the arm)
        ChatView.prototype._steerAfterSend.call(repaint.view, 'm-lost');
        ChatView.prototype._showTyping.call(repaint.view, 'running Bash');
        ChatView.prototype._showTyping.call(repaint.view, 'thinking...');
        ok('a LABEL REPAINT is not a new turn (the epoch never moves on a label)', (repaint.view._turnEpoch || 0) === e0, { e0, now: repaint.view._turnEpoch });
        await wait(150);
        ok('…so the still-running apology survives a relabelled turn (the fix silences the NEXT turn, never this one)', repaint.notes.length === 1 && /could not be injected/.test(repaint.notes[0]), repaint.notes);
        ChatView.prototype._hideTyping.call(repaint.view);
        ChatView.prototype._showTyping.call(repaint.view, 'thinking...');
        ok('…and a hide→show INSIDE the turn (permission answer, reconnect) is NOT a new identity either (round 3)', (repaint.view._turnEpoch || 0) === e0, repaint.view._turnEpoch);
        ChatView.prototype._noteTurnBoundary.call(repaint.view);
        ok('…only the REAL boundary (the turn_complete meta op) advances it', repaint.view._turnEpoch === e0 + 1, repaint.view._turnEpoch);
      }
      // ROUND 3: the flag dropping and re-arming inside ONE turn (a permission
      // resolve hides the line, the next label re-arms it) must NOT silence the
      // honest apology — the message is still un-injected in the SAME turn.
      {
        const mid = mkSteerView();
        ChatView.prototype._steerAfterSend.call(mid.view, 'm-lost');
        ChatView.prototype._hideTyping.call(mid.view);
        ChatView.prototype._showTyping.call(mid.view, 'thinking...');
        await wait(150);
        ok('a hide/re-arm inside the same turn keeps the apology (no turn_complete ⇒ same turn ⇒ still un-injected)', mid.notes.length === 1 && /could not be injected/.test(mid.notes[0]), mid.notes);
      }
      ok('the sentence is translated (zh + ja)', read('src/lib/i18n-zh.js').includes('Sent — but it could not be injected into the running turn') && read('src/lib/i18n-ja.js').includes('Sent — but it could not be injected into the running turn'));
      // …and a CONVERSION inside the window cancels the timer: no apology for
      // something that worked (the pending entry is the timer's own guard)
      const won = mkSteerView();
      ChatView.prototype._steerAfterSend.call(won.view, 'm-ok');
      ChatView.prototype._setQueue.call(won.view, [{ id: 'qok', msgId: 'm-ok' }]);
      await wait(150);
      ok('a steer that DID land never apologises afterwards (the timer is cleared with the pending entry)', won.out.length === 1 && won.out[0].op === 'steer' && won.notes.length === 0, { out: won.out, notes: won.notes });
      if (realWait) Object.defineProperty(ChatView, 'STEER_CHORD_WAIT_MS', realWait);
    }
  }

  // ── ⑨d THE CONTRIBUTED COMMAND + ITS PER-VIEW KEYBINDING ──
  {
    const C = await import(path.join(REPO, 'src/lib/contributions.js'));
    const { STEER_NOW_COMMAND } = await import(path.join(REPO, 'src/lib/chat-view.js'));
    const cv = read('src/lib/chat-view.js');
    ok("the chord is a CONTRIBUTED command with a stable id ('chat.steerNow') — a plugin can see it, rebind it and run it", STEER_NOW_COMMAND === 'chat.steerNow' && C.hasCommand('chat.steerNow'));
    ok('…registered ONCE at module scope (registerCommand rejects a duplicate id BY DESIGN — a per-view registration would throw on the second chat window)', /if \(!hasCommand\(STEER_NOW_COMMAND\)\) \{\s*\n\s*registerCommand\(/.test(cv));
    ok('it carries a title and an SVG icon (a menu or palette can render it)', !!C.commandTitle('chat.steerNow', {}) && /<svg/i.test(C.getCommand('chat.steerNow').icon || ''));
    ok("the command's `when` is false when nothing resolves (a chord pressed outside every chat window does nothing)", C.getCommand('chat.steerNow').when({}) === false && C.getCommand('chat.steerNow').when({ event: {} }) === false);
    const fakeView = { steerComposerText: () => 'RAN', _canSteerComposer: () => true };
    const deadView = { steerComposerText: () => false, _canSteerComposer: () => false };
    ok('…and true for a ctx.view that says it can steer', C.getCommand('chat.steerNow').when({ view: fakeView }) === true);
    ok('…and FALSE for one that cannot (the surface disappears, it does not misfire)', C.getCommand('chat.steerNow').when({ view: deadView }) === false);
    ok('runCommand routes to THAT view — one verb for keyboard, button and plugin alike', C.runCommand('chat.steerNow', { view: fakeView }) === 'RAN');
    ok('…and a view that cannot steer answers honestly instead of throwing (runCommand never consults `when`, VS Code semantics)', C.runCommand('chat.steerNow', { view: deadView }) === false);
    ok("the KEYBINDING is 'alt+enter' → that command, per view, carrying the WINDOW's signal", /registerKeybinding\(\{\s*\n\s*key: 'alt\+enter',\s*\n\s*command: STEER_NOW_COMMAND,/.test(cv) && /signal: winInfo\?\._listenerCtl\?\.signal,/.test(cv));
    ok('…with a `when` that scopes the chord to THIS view (which is also what makes N simultaneous registrations of one chord legal)', /when: \(ctx\) => steerTargetView\(ctx\) === this && this\._canSteerComposer\(\)/.test(cv));
    ok('…and dispose() unregisters BOTH the binding and the view (a view can be replaced while its window lives on)', /this\._steerKeyDispose\?\.\(\);/.test(cv) && /LIVE_CHAT_VIEWS\.delete\(this\);/.test(cv));
    ok('the composer keydown routes through the SAME command, never a private handler', /onSteerChord: \(\) => runCommand\(STEER_NOW_COMMAND, \{ view: this \}\)/.test(cv) && /if \(this\._onSteerChord\) this\._onSteerChord\(\); else this\.steerNow\(\);/.test(read('src/lib/chat-input.js')));
    // …and it really binds: a synthetic Alt+Enter resolves to it through the
    // REAL matcher, while the two send keys it must not touch do not.
    const kb = C.registerKeybinding({ key: 'alt+enter', command: 'chat.steerNow', when: (ctx) => !!ctx.view });
    const ev = { key: 'Enter', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, target: {} };
    ok('a synthetic Alt+Enter resolves to the command through the real matcher', C.resolveKeybinding(ev, { view: fakeView })?.command === 'chat.steerNow');
    ok('…and plain Enter / Ctrl+Enter / Cmd+Enter / Alt+Shift+Enter do NOT — every existing send key keeps its meaning',
      !C.resolveKeybinding({ ...ev, altKey: false }, { view: fakeView })
      && !C.resolveKeybinding({ ...ev, altKey: false, ctrlKey: true }, { view: fakeView })
      && !C.resolveKeybinding({ ...ev, altKey: false, metaKey: true }, { view: fakeView })
      && !C.resolveKeybinding({ ...ev, shiftKey: true }, { view: fakeView }));
    ok('…and a ctx whose view cannot steer resolves to nothing (the `when` chain, both halves)', !C.resolveKeybinding(ev, { view: deadView }));
    kb();
  }
}

console.log('— wiring + docs pins');
{
  const ci = read('scripts/ci.mjs');
  ok('this suite runs in the release gate', /'test-queue-steer'/.test(ci));
  const cinput = read('src/lib/chat-input.js');
  ok('the strip is the FIRST child of the input area (above the box, as designed)', /inputArea\.append\(this\._queueStrip, this\._attachArea/.test(cinput));
  ok('the strip renders nothing for a harness without queueOps (no dead control)', /const items = this\._queueCaps\.queueOps \? this\._queue : \[\];/.test(cinput));
  // ROUND-5: THE EDITOR OWNS THE BOX — a DOM-free pin on the guard itself, so
  // the shape survives an edit that never opens a browser.
  ok('sendText REFUSES while a queued-message editor owns the box (an action can never be swallowed into an `edit`)',
    /sendText\(text, \{ carriesUserText = false \} = \{\}\) \{\n\s*if \(!this\._textarea\) return false;\n\s*if \(this\._editingQueueId \|\| this\._pendingEdit\) \{\n\s*showToast\(t\('Finish or cancel the queued-message edit first/.test(cinput));
  ok('…and the action spends nothing of the user\'s: the half-typed box and the pending attachments are put back around the send',
    /const keptText = this\._textarea\.value;/.test(cinput) && /const keptAttachments = this\._attachments;/.test(cinput)
    && /if \(keptAttachments\.length\) \{ this\._attachments = keptAttachments; this\._renderAttachments\(\); \}/.test(cinput));
  ok('…and `_send` ANSWERS whether it took the box, so a bail-out reaches the action\'s caller as a refusal too',
    /_send\(\) \{\n\s*const text = this\._textarea\.value\.trim\(\);\n\s*const hasAttachments = this\._attachments\.length > 0;\n\s*if \(!text && !hasAttachments\) return false;/.test(cinput)
    && /const sent = this\._send\(\) !== false;/.test(cinput) && /\n    return sent;\n  \}/.test(cinput));
  ok('…and the draft SLOT is handed back with the text (confirmDelivery would clear the store out from under it)',
    /if \(prevPendingSend\) this\._pendingSend = prevPendingSend;\n\s*else if \(!carriesUserText\) this\._pendingSend = null;/.test(cinput));
  // ROUND-6: the three follow-ups of the same audit.
  ok('round-6: an OLDER unconfirmed send keeps its slot rather than being cleared by the action that overwrote it',
    /if \(prevPendingSend\) this\._pendingSend = prevPendingSend;/.test(cinput)
    && !/this\._pendingSend && this\._pendingSend !== prevPendingSend/.test(cinput));
  ok('round-6: the delivery echo only clears what THAT send put in the store (a restored prompt is not its to delete)',
    /const stored = loadDraft\('chat', this\._sessionId\);\n\s*if \(stored && stored !== pending\.text && !\(pending\.text === '' && stored === pending\.storeBefore\)\) return;\n\s*clearDraft\('chat', this\._sessionId\);/.test(cinput));
  ok('round-6: sendText puts the box back UNCONDITIONALLY (an empty box must not keep the action\'s own text after a bail-out)',
    /const sent = this\._send\(\) !== false;[\s\S]{0,900}?\n    this\._textarea\.value = keptText;\n/.test(cinput));
  ok('round-6: the LATE writer (uploaded paths) lands on the edit\'s stash, never on the editor\'s box',
    /if \(this\._pendingEdit \|\| this\._editingQueueId\) \{ this\._stashUploadedPaths\(text\); return; \}/.test(cinput)
    && /_stashUploadedPaths\(text\) \{/.test(cinput)
    && /if \(this\._pendingEdit\) this\._pendingEdit\.draftBefore = append\(this\._pendingEdit\.draftBefore\);/.test(cinput));
  ok('round-6: …and the dead-socket notice cannot claim a restore it did not perform',
    /restoredMsg: t\('Connection lost — your message may not have been sent; the text was restored to the input'\),/.test(cinput)
    && /keptMsg: t\('Connection lost — your last message may not have been sent \(the input already had text, so it was left alone\)'\),/.test(cinput));
  // ── ROUND-7: the four follow-ups of the same audit. ────────────────────
  // ⓐ THE RELEASE MUST STAND OUTSIDE THE GATE. Round-6 put the slot hand-back
  // INSIDE `if (keptText.trim())`, i.e. it never ran for the ORDINARY state of
  // an action button: an empty box.
  ok('round-7: the draft-slot release stands OUTSIDE the `keptText.trim()` gate, which an action fired from an EMPTY box never enters',
    /\n    this\._textarea\.value = keptText;\n(?:\s*\/\/[^\n]*\n)*    if \(prevPendingSend\) this\._pendingSend = prevPendingSend;\n    else if \(!carriesUserText\) this\._pendingSend = null;\n    if \(keptText\.trim\(\)\) \{/.test(cinput));
  ok('round-7: …and the store the action PINNED to its own text is put back to what was really there (captured beside the slot, before the send)',
    /const prevDraft = loadDraft\('chat', this\._sessionId\);/.test(cinput)
    && /\} else if \(!carriesUserText \|\| prevPendingSend\) \{\n(?:\s*\/\/[^\n]*\n)*      saveDraft\('chat', this\._sessionId, prevDraft\);\n    \}/.test(cinput));
  // ⓑ+ⓒ ONE helper for the three holders of unsent text, and it answers with
  // WHAT IT DID rather than one sentence for every outcome.
  ok('round-7: ONE `_announceUnsent` helper, THREE outcomes (nothing to restore / restored / box occupied)',
    /_announceUnsent\(text, \{ restoredMsg, keptMsg, noneMsg \}\) \{\n\s*if \(!text\) \{[\s\S]{0,240}?return 'none';[\s\S]{0,400}?return 'restored';[\s\S]{0,240}?return 'kept';\n  \}/.test(cinput));
  ok('round-7: …and all THREE callers go through it — the unconfirmed send and BOTH /goal twins',
    [...cinput.matchAll(/this\._announceUnsent\(/g)].length === 3
    && /noneMsg: t\('Connection lost — your last message may not have been sent'\),/.test(cinput));
  ok('round-7: …so neither /goal twin can still announce a restore it did not perform',
    !/showToast\(t\('Connection lost before the goal was set — your command was restored to the input'\)/.test(cinput)
    && !/showToast\(t\('Goal not confirmed — the session may be unresponsive\. Your command was restored to the input\.'\)/.test(cinput)
    && /keptMsg: t\('Connection lost before the goal was set — the input already had text, so your command was left alone'\),/.test(cinput)
    && /keptMsg: t\('Goal not confirmed — the session may be unresponsive\. The input already had text, so your command was left alone\.'\),/.test(cinput));
  // ⓓ THE CLEAR MUST KNOW WHAT THE SEND DISPLACED, or a send with no text of
  // its own can never clear anything again.
  ok('round-7: the send records what it displaced in the store, and the deferred clear accepts EITHER its pin or that value',
    /const storeBefore = loadDraft\('chat', this\._sessionId\);\n\s*if \(text\) saveDraft\('chat', this\._sessionId, text\);\n\s*this\._pendingSend = \{ text, storeBefore \};/.test(cinput)
    && /if \(stored && stored !== pending\.text && !\(pending\.text === '' && stored === pending\.storeBefore\)\) return;/.test(cinput));
  // ── ROUND-8: `sendText` HAS TWO KINDS OF CALLER, and round-7 released for
  // both. The design request is a message BUILT AROUND THE USER'S OWN BRIEF,
  // typed into a dropdown that closes on a true — the slot `_send` arms is
  // then the only copy, so releasing it made a half-open socket lose the
  // brief with zero trace (round 6, whose release sat inside the trim gate,
  // had restored it with a notice). The flag names the difference; the
  // DEFAULT is the action semantics, so a forgetful caller loses a rescue
  // rather than leaving someone else's text armed in the box.
  ok('round-8: `sendText` takes `carriesUserText`, defaulting to the ACTION semantics',
    /sendText\(text, \{ carriesUserText = false \} = \{\}\) \{/.test(cinput));
  ok('round-8: the release is scoped by WHO AUTHORED the payload — an older unconfirmed send still wins, and only an ACTION releases to nothing',
    /if \(prevPendingSend\) this\._pendingSend = prevPendingSend;\n\s*else if \(!carriesUserText\) this\._pendingSend = null;/.test(cinput)
    && !/this\._pendingSend = prevPendingSend \|\| null;/.test(cinput));
  ok("round-8: …and the store restore is skipped for exactly that case, so `_send`'s pin survives for a user-authored payload",
    /\} else if \(!carriesUserText \|\| prevPendingSend\) \{/.test(cinput));
  ok('round-8: the `storeBefore` arm of the deferred clear is scoped to a send with NO text of its own (a text-carrying send may only clear its own pin)',
    /!\(pending\.text === '' && stored === pending\.storeBefore\)/.test(cinput)
    && !/stored !== pending\.storeBefore/.test(cinput));
  // BOTH CALL SITES SAY WHICH THEY ARE, at the call — the flag is a claim
  // about the payload's author and it lives where the payload is built.
  {
    const cview = read('src/lib/chat-view.js');
    ok('round-8: the in-chat action button passes `carriesUserText: false` explicitly (product-authored text owns nothing)',
      /onSendText: \(txt\) => this\._chatInput\?\.sendText\(txt, \{ carriesUserText: false \}\),/.test(cview));
    ok('round-8: …and the design request passes true, because the dropdown that holds the brief closes on a true',
      /return this\._chatInput\.sendText\(msg, \{ carriesUserText: true \}\) !== false;/.test(cview));
    ok('round-8: those are still the ONLY two callers (a third would have to make the same choice on purpose)',
      [...cview.matchAll(/\.sendText\(/g)].length === 2
      && [...cinput.matchAll(/\n  sendText\(/g)].length === 1);
  }
  // The new sentences are real i18n keys (a missing zh/ja entry ships English).
  {
    const zh = read('src/lib/i18n-zh.js'), ja = read('src/lib/i18n-ja.js');
    const keys = ['Connection lost — your last message may not have been sent',
      'Connection lost before the goal was set — the input already had text, so your command was left alone',
      'Goal not confirmed — the session may be unresponsive. The input already had text, so your command was left alone.'];
    ok('round-7: every new notice has a zh AND a ja entry', keys.every((k) => zh.includes(JSON.stringify(k) + ':') && ja.includes(JSON.stringify(k) + ':')), keys.filter((k) => !zh.includes(JSON.stringify(k) + ':') || !ja.includes(JSON.stringify(k) + ':')));
  }
  ok('…and every OTHER programmatic writer of the textarea is audited where they live (guard or reason, one list)',
    /EVERY PROGRAMMATIC WRITER OF THE TEXTAREA/.test(cinput) && /input-history recall \(ArrowUp\/ArrowDown\)/.test(cinput)
    && /`_insertUploadedPaths` \(upload button, folder picker, ChatView's/.test(cinput));
  // THE AUDIT'S OWN BLIND SPOT (round-6): the writer it missed writes through a
  // LOCAL alias, so grepping the field name cannot find it. Every alias of the
  // textarea must therefore be enumerated here, not just `this._textarea`.
  {
    const writes = [...cinput.matchAll(/\n\s+ta\.value = /g)].length;
    const guard = cinput.indexOf('this._stashUploadedPaths(text); return; }');
    const alias = cinput.indexOf("const ta = this._textarea;\n    const start");
    ok(`exactly ONE aliased writer of the box, and the editor guard stands above it (writes=${writes}, guard@${guard}, alias@${alias})`,
      writes === 1 && guard > 0 && alias > guard);
  }
  // A refusal that leaves the control dead is the offered action disappearing
  // right after its own toast said to come back — both callers must survive it,
  // and the design brief lives ONLY in that dropdown's textarea.
  ok('the Compact-now button re-enables itself when the send is refused',
    /if \(this\._onSendText\('\/compact'\) === false\) btn\.disabled = false;/.test(read('src/lib/chat-renderers.js')));
  ok('the design dropdown keeps the typed brief when the send is refused (it closed BEFORE the send)',
    /if \(this\._onDesignRequest\(brief, \{ public: pubCb\.checked \}\) === false\) return;\n\s*dropdown\.remove\(\);/.test(read('src/lib/chat-status-bar.js'))
    && /return this\._chatInput\.sendText\(msg, \{ carriesUserText: true \}\) !== false;/.test(read('src/lib/chat-view.js')));
  const cw = read('data/bin/codex-chat-wrapper.js');
  const aw = read('data/bin/acp-wrapper.js');
  ok('BOTH wrappers serve the new stdin verb in the same batch (the frame-file lesson)', /msg\.type === 'queue-op'/.test(cw) && /case 'queue-op':/.test(aw));
  ok('both adverts caps.inputQueue in the sidecar THEY write', /inputQueue: true/.test(cw) && /inputQueue: true/.test(aw));
  ok('the ACP unknown-verb message lists queue-op (the wrapper tells the truth about what it serves)', /chat-input\/interrupt\/queue-op\//.test(aw));
  // DISTINCT phrases per file (a loose grep matched 'queue-operation' in an
  // unrelated essay and the docs pin passed while the docs were empty)
  ok('kb-features documents QUEUED vs STEERED incl. the multi-queue rule', /QUEUED vs STEERED/.test(read('docs/kb-features.md')) && /steering item N injects\s*\n?\s*\*\*only N\*\*/.test(read('docs/kb-features.md')));
  // 2026-09-07: the SECOND rule that lives in this section — a VibeSpace
  // notification steers, a person's message queues, and a steer carries only
  // itself. It must be written where the user reads it AND cite the upstream
  // sources, because "a steer carries only itself" is what makes it safe.
  {
    const kbf = read('docs/kb-features.md');
    ok('kb-features states the notification rule in the same section', /SYSTEM NOTIFICATIONS STEER, PEOPLE QUEUE/.test(kbf) && /a steer carries only itself/.test(kbf));
    ok('…with the codex-rs sources cited (turn_processor.rs + get_pending_input/split_off)', /turn_processor\.rs/.test(kbf) && /get_pending_input/.test(kbf) && /split_off\(0\)/.test(kbf));
    ok('…and names the derived lane per harness (never a backend-id branch)', /notificationDelivery/.test(kbf) && /cli-inbox/.test(kbf) && /steer:'unsupported'|steer:.unsupported./.test(kbf));
    ok('kb-features Background Work says the floor+stash drain as ONE block', /renderNotifStash/.test(kbf) && /ONE rendered block/.test(kbf));
    ok("kb-api documents the peer-message frame's typed origin", /TYPED ORIGIN/.test(read('docs/kb-api.md')) && /mode:'steered'/.test(read('docs/kb-api.md')));
  }
  ok("kb-api documents the ws 'queue-op' message + the queue_changed/queue_op_result events", /\*\*Input queue \(`queue-op`/.test(read('docs/kb-api.md')) && /queue_op_result \{op, id, msg_id, ok, reason, detail\}/.test(read('docs/kb-api.md')));
  ok('design-harness-plugins §1 records the closure on its own P2 row', /两种发送模式 ✅2026-09-06/.test(read('docs/design-harness-plugins.md')));
  ok('…and the round-2 client laws are written down where the strip lives (kb-file-structure) and where the user reads (kb-features)',
    /THE QUEUE STRIP'S CLIENT LAWS/.test(read('docs/kb-file-structure.md')) && /Your rewrite is never spent on a refusal/.test(read('docs/kb-features.md')));
  ok('…and kb-api documents the echoed op/id and BOTH size gates on the one verb that carries user text',
    /`op` and `id` are ECHOED/.test(read('docs/kb-api.md')) && /text-too-long/.test(read('docs/kb-api.md')) && /frame-too-large/.test(read('docs/kb-api.md')));
  ok('design-harness-features §2.1 records the adversarial round with its six findings', /round-2 对抗验证：6 条真缺陷/.test(read('docs/design-harness-features.md')));
  ok('…and §2.1b records the notification-steer decision with its upstream citations', /### 2\.1b/.test(read('docs/design-harness-features.md')) && /turn_processor\.rs:1023-1039/.test(read('docs/design-harness-features.md')) && /split_off\(0\)/.test(read('docs/design-harness-features.md')));
  { const kbfs = read('docs/kb-file-structure.md');
    ok('kb-file-structure carries the wrapper/normalizer/ws essays (the measured app-server facts live there)',
      /THE INPUT QUEUE — QUEUED vs STEERED/.test(kbfs) && /QUEUE STATE IS SESSION STATE, NEVER A MESSAGE/.test(kbfs) && /the ONE new case for QUEUED vs STEERED/.test(kbfs) && /no `remove`/.test(kbfs)); }

  // ── ⑨ THE CHORD: wiring + i18n + docs ──
  const cinput2 = read('src/lib/chat-input.js');
  const cv2 = read('src/lib/chat-view.js');
  ok('the chord is checked BEFORE the plain-Enter branch (that branch tests only !shiftKey and would swallow Alt+Enter as an ordinary send — the bug this ordering exists to prevent)',
    cinput2.indexOf("e.key === 'Enter' && e.altKey") < cinput2.indexOf("if (e.key === 'Enter' && !e.shiftKey)"));
  ok('…and it is the ONLY new chord: Tab stays the slash completion, Ctrl/Cmd+Enter stays plain send',
    /if \(e\.key === 'Tab' \|\| e\.key === 'Enter'\)/.test(cinput2) && /if \(e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)\) \{ e\.preventDefault\(\); this\._send\(\); \}/.test(cinput2)
    && (cinput2.match(/e\.key === 'Enter' && e\.altKey/g) || []).length === 1);
  ok('the chord condition excludes every other modifier (Alt+Shift/Alt+Ctrl+Enter are not it)', /e\.key === 'Enter' && e\.altKey && !e\.ctrlKey && !e\.metaKey && !e\.shiftKey && this\.steerChordAllowed/.test(cinput2));
  ok('BOTH surfaces gate on the ONE capability answer, never on a backend id', /this\._steerBtn\.classList\.toggle\('hidden', !\(live && modes\.allowSteerChord\)\)/.test(cinput2) && !/=== 'codex'|=== 'claude'|=== 'opencode'/.test(cinput2));
  ok('…which comes from the PURE composerSendModes over the LIVE queue caps (the same object the strip reads)', /_sendModes\(\) \{ return composerSendModes\(this\._queueCaps\); \}/.test(cinput2) && /_canSteerComposer\(\) \{ return !!this\._chatInput\?\.steerChordAllowed; \}/.test(cv2));
  ok('both faces repaint on BOTH inputs: the streaming flag AND the late-arriving caps (the dead-chip ordering)', /_updateSendModes\(\);\s*\n\s*\}/.test(cinput2) && /this\._renderQueue\(\);[\s\S]{0,400}this\._updateSendModes\(\);/.test(cinput2) && (cinput2.match(/this\._updateSendModes\(\)/g) || []).length >= 4, (cinput2.match(/this\._updateSendModes\(\)/g) || []).length);
  ok('the send→steer conversion reuses the ONE queue-op sender (no second wire shape anywhere)', /this\._sendQueueOp\('steer', it\.id\);/.test(cv2) && (cv2.match(/type: 'queue-op'/g) || []).length === 1);
  ok('the ≤768px button carries an SVG icon and an aria-label, never a glyph (§17)', /this\._steerBtn\.innerHTML = UI_ICONS\.bolt;/.test(cinput2) && /setAttribute\('aria-label'/.test(cinput2));
  ok('the two surfaces are split by VIEWPORT in CSS, theme vars only (§17)',
    /@media \(max-width: 768px\) \{ \.chat-send-hint \{ display: none; \} \}/.test(read('public/chat.css'))
    && /@media \(max-width: 768px\) \{ \.chat-steer-btn:not\(\.hidden\) \{ display: inline-flex; \} \}/.test(read('public/chat.css'))
    && /\.chat-steer-btn\.hidden \{ display: none; \}/.test(read('public/chat.css'))
    && !/chat-(send-hint|steer-btn)[^}]*#[0-9a-f]{3,6}/i.test(read('public/chat.css')));
  { const zh2 = read('src/lib/i18n-zh.js'), ja2 = read('src/lib/i18n-ja.js');
    ok('every new chord string is translated (zh + ja)', ['"Enter queues"', '"Alt+Enter injects now"', '"Send now — inject into the running turn"', '"Sending during a turn"', '"Enter queues it — it runs after this turn"'].every((k) => zh2.includes(k) && ja2.includes(k))); }
  ok('Session Properties documents it, gated by the SAME predicate (and shows nothing where there is no queue surface)', /composerSendModes\(getBackendMeta\(s\.backend \|\| 'claude'\)\?\.caps\?\.inputModes\)/.test(read('src/lib/session-props.js')) && /if \(sm\.showHint\)/.test(read('src/lib/session-props.js')));
  // ROUND-2 MINOR, at the source too: `section()` APPENDS, so no lazy row may
  // call it directly — the header is memoised behind ONE factory (⑨f proves
  // the behaviour in a real document; this is the drift guard).
  { const sp = read('src/lib/session-props.js');
    ok('…and its section header is created at most ONCE (no `cfgSec || section(...)` per lazy row — that idiom printed the header twice)',
      /const cfgSection = \(\) => \{ if \(!cfgSecMemo\) cfgSecMemo = section\(t\('Config overrides'\)\); return cfgSecMemo; \};/.test(sp)
      && !/row\(cfgSec \|\| section\(/.test(sp)
      && (sp.match(/section\(t\('Config overrides'\)\)/g) || []).length === 2, (sp.match(/section\(t\('Config overrides'\)\)/g) || []).length); }
  // ROUND-2 MAJOR, at the source: the timeout's silence is a TURN IDENTITY
  // comparison, never the truthiness of a flag the next turn re-arms.
  { const cv3 = read('src/lib/chat-view.js');
    ok('the steer timeout compares the TURN it was armed in (a re-armed flag is not the same turn)',
      /const turnAtSend = this\._turnEpoch \|\| 0;/.test(cv3) && /if \(\(this\._turnEpoch \|\| 0\) !== turnAtSend\) return;/.test(cv3));
    ok('…and the epoch advances ONLY at the real boundary: _noteTurnBoundary, called first thing by the turn_complete meta op — never on the label arm (round 3)',
      /_noteTurnBoundary\(\) \{ this\._turnEpoch = \(this\._turnEpoch \|\| 0\) \+ 1; \}/.test(cv3)
      && /op\.subtype === 'turn_complete'\) \{\s*\n\s*this\._noteTurnBoundary\(\);/.test(cv3)
      && !/if \(!this\._typingSince\) \{[\s\S]{0,160}_turnEpoch/.test(cv3)
      && (cv3.match(/this\._turnEpoch = /g) || []).length === 1); }
  { const kbd = read('docs/keyboard-shortcuts.md');
    ok('docs/keyboard-shortcuts.md carries the chord, the per-harness table and the ≤768px behaviour', /\*\*Alt\+Enter\*\*/.test(kbd) && /Sending while a turn is running/.test(kbd) && /chat\.steerNow/.test(kbd) && /Touch \/ ≤768px/.test(kbd)); }
  { const kbf = read('docs/kb-features.md');
    ok('kb-features QUEUED vs STEERED gains the chord, the hint gate and the touch face', /THE CHORD: `Alt\+Enter` = steer/.test(kbf) && /not `queue`\*\*/.test(kbf) && /≤768px: no chords, a BUTTON/.test(kbf));
    ok('…and the round-2 invariants: WHICH turn the timeout is about, and the once-only Config-overrides header', /\*\*WHICH turn, never "a turn"/.test(kbf) && /at most once, on\s*\n\s*first demand\*\* \(`cfgSection\(\)`\)/.test(kbf)); }
  { const kbfs2 = read('docs/kb-file-structure.md');
    ok('kb-file-structure: the chord essays live under chat-input.js AND contributions.js', /THE Alt\+Enter STEER CHORD/.test(kbfs2) && /THE FIRST CORE `registerKeybinding` CHORD/.test(kbfs2));
    ok("…and chat-view.js carries the chord's view half incl. the turn-identity guard", /THE STEER CHORD'S VIEW HALF/.test(kbfs2) && /`_turnEpoch`/.test(kbfs2)); }
  { const kbd2 = read('docs/keyboard-shortcuts.md');
    ok('docs say what happens when the turn ends first (silence, not an apology)', /\*\*If the turn ends first,\*\*/.test(kbd2)); }
  ok('CLAUDE.md indexes the new PURE predicate', /composerSendModes/.test(read('CLAUDE.md')));
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

// ⑩ THE VERB TABLE AGAINST THE REAL `codex app-server` (0.153.4).
// WHY a second real leg: ⑥ proves the wrapper talks to a real server; this one
// proves the four NEW verbs' PARAMETER NAMES and SEMANTICS, using the wrapper's
// OWN pure order/input builders (extracted from the file, so there is no twin
// to drift) against the server that will actually answer them.
// NOTHING IS BILLED AND NOTHING IS EVEN ATTEMPTED: the app-server runs on a
// THROWAWAY, LOGGED-OUT CODEX_HOME. The queue verbs are server-side
// bookkeeping and need no API at all — and the one turn the app-server starts
// BY ITSELF (measured 2026-09-07: an add on an idle thread drains immediately)
// dies on a 401 with no account attached. We never send turn/start or
// thread/queue/start, and the leg ASSERTS that at the end.
console.log('— ⑩ the four new verbs against a REAL codex app-server (isolated, logged-out CODEX_HOME — nothing billed)');
{
  const { spawnSync, spawn } = await import('node:child_process');
  const which = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (which.status !== 0) {
    console.log(`  SKIP: no working \`codex\` on PATH (${(which.error?.message || which.stderr || '').trim().slice(0, 80)})`);
  } else {
    const ver = (which.stdout || '').trim();
    // The wrapper's OWN pure builders, lifted out of the file it ships in (it
    // cannot be require()d — importing it would spawn codex).
    const wsrc = read('data/bin/codex-chat-wrapper.js');
    const lift = (name) => {
      const m = new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}`).exec(wsrc);
      if (!m) throw new Error(`could not lift ${name}() from the wrapper`);
      return m[0];
    };
    const builders = new Function('asArray', `${lift('reorderedIds')}\n${lift('replaceQueuedText')}\nreturn { reorderedIds, replaceQueuedText };`)((v) => (Array.isArray(v) ? v : []));
    ok('the wrapper\'s order/input builders are PURE enough to lift and drive directly (no twin in this test)', typeof builders.reorderedIds === 'function' && typeof builders.replaceQueuedText === 'function');

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-qv-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-qv-cwd-'));
    const srv = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: home } });
    let buf = '', rid = 0, stderr = '';
    const pend = new Map(); const notes = []; const sentMethods = [];
    srv.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); continue; }
        if (m.method) notes.push(m.method);
      }
    });
    srv.stderr.on('data', (d) => { stderr += d; });
    const rpc = (method, params) => new Promise((res) => {
      const id = ++rid;
      sentMethods.push(method);
      pend.set(id, res);
      srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (pend.has(id)) { pend.delete(id); res({ timeout: true }); } }, 20000);
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      const init = await rpc('initialize', { clientInfo: { name: 'vibespace-test', title: 'vibespace', version: '1' }, capabilities: { experimentalApi: true } });
      srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
      const th = await rpc('thread/start', { cwd });
      const threadId = th?.result?.thread?.id;
      if (!threadId) {
        console.log(`  SKIP: \`codex app-server\` (${ver}) never started a thread — ${(stderr || 'no stderr').trim().slice(0, 140)}`);
      } else {
        ok(`${ver}: the queue verbs are gated on the experimentalApi capability the wrapper asks for (a future gate change fails HERE)`, !!init?.result, init?.error);
        // The wrapper's own initialize must carry it, or every queue verb 404s
        ok('…and the wrapper asks for exactly that capability', /await request\('initialize', \{ clientInfo, capabilities: \{ experimentalApi: true \} \}/.test(wsrc));
        // FOUR adds: the first drains into the (doomed, unauthenticated) turn
        // the server starts by itself, leaving three queued to work with.
        const added = [];
        for (const label of ['alpha', 'beta', 'gamma', 'delta']) {
          const a = await rpc('thread/queue/add', { threadId, input: [{ type: 'text', text: label }], clientUserMessageId: 'cid-' + label });
          if (a?.result?.queuedSubmission?.id) added.push({ id: a.result.queuedSubmission.id, label });
        }
        ok('thread/queue/add answers {queuedSubmission:{id,input,clientUserMessageId}} for every add', added.length === 4, added.map((x) => x.label));
        await sleep(600);
        // PAGING IS REAL: limit + the opaque nextCursor, followed to the end —
        // exactly what listQueueAll does (a wrong param name fails here).
        const page1 = await rpc('thread/queue/list', { threadId, limit: 1 });
        ok('thread/queue/list takes `limit` and answers an opaque `nextCursor` (the wrapper pages on THIS)', Array.isArray(page1?.result?.data) && page1.result.data.length === 1 && typeof page1.result.nextCursor === 'string', page1?.result);
        const walked = [...page1.result.data];
        let cursor = page1.result.nextCursor, guard = 0;
        while (cursor && guard++ < 10) {
          const pg = await rpc('thread/queue/list', { threadId, cursor, limit: 1 });
          walked.push(...(pg?.result?.data || []));
          cursor = pg?.result?.nextCursor || null;
        }
        const whole = await rpc('thread/queue/list', { threadId });
        const wholeIds = (whole?.result?.data || []).map((q) => q.id);
        ok('…and a cursor walk to the END sees exactly what an unpaged list sees (a truncated walk would be a different queue)', JSON.stringify(walked.map((q) => q.id)) === JSON.stringify(wholeIds), { walked: walked.length, whole: wholeIds.length });
        ok('an add on an IDLE thread is DRAINED by the server itself, so three of the four are still queued (this is why run-now/run-all can only matter on a resumed thread)', wholeIds.length === 3, wholeIds.length);
        if (wholeIds.length >= 3) {
          // REORDER: the wrapper's own relative→absolute translation, sent as
          // the app-server's full-order array.
          const moved = wholeIds[2], anchorId = null;   // to the FRONT
          const order = builders.reorderedIds(wholeIds, moved, anchorId);
          const r = await rpc('thread/queue/reorder', { threadId, queuedSubmissionIds: order });
          ok('thread/queue/reorder accepts {threadId, queuedSubmissionIds} — the FULL order the wrapper computed from a relative move', !r?.error, r?.error?.message);
          const after = await rpc('thread/queue/list', { threadId });
          ok('…and the queue really comes back in that order', JSON.stringify((after?.result?.data || []).map((q) => q.id)) === JSON.stringify(order), { got: (after?.result?.data || []).map((q) => q.id), want: order });
          // …and a PARTIAL order is REFUSED (measured: not a silent delete —
          // which is why listQueueAll pages to the end for the op to WORK).
          const partial = await rpc('thread/queue/reorder', { threadId, queuedSubmissionIds: order.slice(0, 2) });
          ok('a full-order array that is NOT the whole queue is REFUSED (a truncated page would break the op, never silently drop items)', /every queued submission exactly once/i.test(partial?.error?.message || ''), partial);
          // EDIT: the wrapper's exclusion rebuild, with an attachment that must
          // survive the round trip.
          const target = (after?.result?.data || [])[0];
          const mixed = [{ type: 'text', text: 'old words', text_elements: [{ byteRange: { start: 0, end: 3 } }] }, { type: 'mention', name: 'notes', path: '/tmp/notes.md' }];
          const input = builders.replaceQueuedText(mixed, 'brand new words');
          const u = await rpc('thread/queue/update', { threadId, queuedSubmissionId: target.id, input });
          ok('thread/queue/update accepts {threadId, queuedSubmissionId, input} — the WHOLE input array', !u?.error, u?.error?.message);
          const after2 = await rpc('thread/queue/list', { threadId });
          const back = (after2?.result?.data || []).find((q) => q.id === target.id);
          ok('…and the edited text comes back, with the mention still there and the stale text_elements cleared', JSON.stringify(back?.input) === JSON.stringify([{ type: 'text', text: 'brand new words', text_elements: [] }, { type: 'mention', name: 'notes', path: '/tmp/notes.md' }]), back?.input);
          // …and an id the server has drained is NOT FOUND, which the wrapper
          // classifies as 'gone' rather than a bare error.
          const missing = await rpc('thread/queue/update', { threadId, queuedSubmissionId: added[0].id, input: [{ type: 'text', text: 'x' }] });
          ok("an update on an already-drained id answers 'not found' (the wrapper reports that as reason 'gone', i.e. it ran)", /not found/i.test(missing?.error?.message || '') && /if \(\/not found\/i\.test\(m\)\) return \{ reason: 'gone' \}/.test(wsrc), missing?.error);
          // CLEAN UP: delete everything we queued (never `start` it).
          for (const q of (after2?.result?.data || [])) await rpc('thread/queue/delete', { threadId, queuedSubmissionId: q.id });
          const end = await rpc('thread/queue/list', { threadId });
          ok('every queued item is deletable, and the queue ends empty', (end?.result?.data || []).length === 0, end?.result);
        }
        // THE SAFETY ASSERT: this leg never asks for inference.
        ok('THE LEG NEVER STARTS A TURN: no turn/start and no thread/queue/start was sent (only the server\'s own idle drain, which a logged-out home cannot bill)', !sentMethods.includes('turn/start') && !sentMethods.includes('thread/queue/start'), sentMethods.join(','));
        // …and if the server DID drain one into a turn, that turn must have
        // failed on the missing login — the evidence that nothing was spent.
        ok('…and any turn the server started by itself died unauthenticated (401 / an error notification): zero tokens, on a home with no account', !notes.includes('turn/started') || notes.includes('error') || /401 Unauthorized|Unauthorized/i.test(stderr), { notes: [...new Set(notes)], stderr: stderr.slice(-200) });
      }
    } catch (e) {
      ok('the real-app-server verb leg ran', false, String(e.message || e).slice(0, 300));
    } finally {
      try { srv.kill('SIGKILL'); } catch { }
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { }
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { }
    }
  }
}

// ⑧ THE STOP BUTTON, ONE SHOT (round-3 review). Stop is not instantaneous: the
// codex wrapper empties the app-server queue BEFORE it interrupts and that
// sweep is capped at ~6s against a wedged app-server (and claude's §11
// delayed-fallback SIGINT trails the protocol interrupt by 2s). A second click
// in that window is a second `interrupt` frame. The wrapper coalesces them
// now, but the button must also stop inviting the click — and it must not be
// possible to WEDGE it: the pending state ends on the turn ending or on its own
// fallback timer. Driven in a REAL browser because the failure was a DOM one:
// showTyping re-renders the whole status line on every label change, which
// handed back a fresh, clickable Stop mid-flight.
console.log('— ⑧ the Stop button is one-shot while an interrupt is in flight');
{
  const cinput = read('src/lib/chat-input.js');
  ok('every Stop entry point goes through _fireInterrupt (plain click AND the armed compaction confirm)',
    (cinput.match(/this\._fireInterrupt\(\)/g) || []).length === 2 && !/btn\.onclick = \(\) => this\._onInterrupt\(\)/.test(cinput), cinput.match(/_(fire|on)Interrupt\(\)/g));
  ok('the pending state is re-applied by showTyping itself (the label repaint is what used to hand the button back)', /if \(this\._stopPending\) \{ this\._applyStopPending\(btn\);/.test(cinput));
  ok('it ends on the turn ending (hideTyping) AND on a bounded fallback timer — a Stop button that stays dead is the one failure this control may not have',
    /hideTyping\(\) \{[\s\S]{0,400}this\._endStopPending\(\);/.test(cinput) && /setTimeout\(\(\) => \{[\s\S]{0,300}this\._endStopPending\(\);\s*\n\s*\}, ChatInput\.STOP_PENDING_MS\)/.test(cinput));
  ok('dispose clears the timer (no orphaned callback into a closed window)', /if \(this\._stopPendingTimer\) \{ clearTimeout\(this\._stopPendingTimer\); this\._stopPendingTimer = null; \}/.test(cinput));
  // the window must OUTLAST the wrapper's own Stop budget, or it re-arms while
  // the sweep it is waiting for is still running
  const pendingMs = Number(/static get STOP_PENDING_MS\(\) \{ return (\d+); \}/.exec(cinput)?.[1]);
  const sweepMs = Number(/const STOP_SWEEP_TOTAL_MS = (\d+);/.exec(read('data/bin/codex-chat-wrapper.js'))?.[1]);
  ok(`the pending window (${pendingMs}ms) outlasts the codex wrapper's whole Stop sweep budget (${sweepMs}ms)`, pendingMs > sweepMs, { pendingMs, sweepMs });
  const zh = read('src/lib/i18n-zh.js'), ja = read('src/lib/i18n-ja.js');
  ok('the new strings are translated (zh + ja)', ["'Stopping…':", "'Stopping the current turn…':"].every((k) => zh.includes(k) && ja.includes(k)));
  ok('the pending look is a CLASS in the stylesheet, theme vars only (§17)', /\.chat-interrupt-btn\.chat-interrupt-pending/.test(read('public/chat.css')) && !/chat-interrupt-pending[^}]*#[0-9a-f]{3,6}/i.test(read('public/chat.css')));

  const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
  if (!CHROME) {
    console.log('  SKIP: no chrome/chromium on this box — the DOM half of ⑧ did not run');
  } else {
    const http = await import('node:http');
    const net = await import('node:net');
    const { spawn } = await import('node:child_process');
    const esbuild = require(path.join(REPO, 'node_modules/esbuild'));
    const WebSocket = require('ws');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `vs-stopbtn-${process.pid}-`));
    const bundle = path.join(tmp, 'chat-input.iife.js');
    const stub = { name: 'stub-build-version', setup(b) { b.onResolve({ filter: /build-version\.js$/ }, () => ({ path: 'build-version', namespace: 'bv' })); b.onLoad({ filter: /.*/, namespace: 'bv' }, () => ({ contents: "export const BUILD_VERSION = 'test';", loader: 'js' })); } };
    await esbuild.build({ entryPoints: [path.join(REPO, 'src/lib/chat-input.js')], bundle: true, format: 'iife', globalName: 'VS', platform: 'browser', target: 'es2022', outfile: bundle, logLevel: 'silent', loader: { '.css': 'text' }, plugins: [stub] });
    const js = fs.readFileSync(bundle, 'utf8').replace(/<\/script/gi, '<\\/script');
    const css = fs.readFileSync(path.join(REPO, 'public/chat.css'), 'utf8').replace(/<\/style/gi, '<\\/style');
    const html = `<!doctype html><meta charset="utf-8"><title>stop</title><style>${css}</style><body></body><script>${js}</script>`;
    const port = await freePort(), cdpPort = await freePort();
    const srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(html); }).listen(port, '127.0.0.1');
    const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, '--no-first-run', '--no-sandbox', '--disable-gpu',
      '--disable-dev-shm-usage', '--disable-background-timer-throttling', `--user-data-dir=${tmp}/chrome`, 'about:blank'], { stdio: 'ignore' });
    let ws = null;
    try {
      let target = null;
      for (let i = 0; i < 120 && !target; i++) {
        try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page'); } catch {}
        if (!target) await sleep(250);
      }
      if (!target) throw new Error('chrome never exposed a CDP page target');
      ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
      await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
      let seq = 0; const pend = new Map();
      ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
      const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
      const evaljs = async (expr) => {
        const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
        return r.result?.result?.value;
      };
      await cdp('Runtime.enable'); await cdp('Page.enable');
      await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` });
      for (let i = 0; i < 80; i++) { if (await evaljs('!!(window.VS && window.VS.ChatInput)').catch(() => false)) break; await sleep(150); }
      // A REAL ChatInput in a REAL document: the bug lived in innerHTML +
      // querySelector, which no element stub reproduces.
      const built = await evaljs(`(() => {
        window.__n = 0;
        const ci = new VS.ChatInput({ send(){} }, 'sess-stop', { onSend(){}, onInterrupt: () => { window.__n++; } });
        document.body.appendChild(ci.element);
        window.__ci = ci;
        return !!ci.element.querySelector('.chat-stream-status');
      })()`);
      ok('a real ChatInput mounts in a real document', built === true);
      const state = () => evaljs(`(() => {
        const b = document.querySelector('.chat-interrupt-btn');
        return b ? { text: b.textContent, disabled: !!b.disabled, pending: b.classList.contains('chat-interrupt-pending'), n: window.__n, cursor: getComputedStyle(b).cursor } : { none: true, n: window.__n };
      })()`);
      // a TRUSTED click through the browser's own hit test — a disabled button
      // must not even receive it (btn.click() would bypass that question)
      const clickStop = async () => {
        const r = await evaljs(`(() => { const b = document.querySelector('.chat-interrupt-btn'); const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })()`);
        for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await sleep(80);
      };
      await evaljs(`window.__ci.showTyping('thinking...'); true`);
      let s = await state();
      ok('the live Stop button is enabled and says Stop', s.text.includes('Stop') && !s.disabled && !s.pending, s);
      await clickStop();
      s = await state();
      ok('clicking it sends ONE interrupt and the button goes pending: disabled + "Stopping…"', s.n === 1 && s.disabled === true && s.pending === true && /Stopping/.test(s.text), s);
      await clickStop();
      s = await state();
      ok('a SECOND click inside the window sends nothing — the ~6s wedged-server window cannot produce a duplicate interrupt frame', s.n === 1, s);
      // THE REGRESSION: the status line repaints on every label change
      await evaljs(`window.__ci.showTyping('still thinking…'); true`);
      s = await state();
      ok('a label repaint does NOT hand the button back (showTyping re-applies the pending state)', s.disabled === true && /Stopping/.test(s.text) && s.n === 1, s);
      await clickStop();
      ok('…and the button under that repaint is still inert', (await state()).n === 1);
      // TURN END re-arms it
      await evaljs(`window.__ci.hideTyping(); window.__ci.showTyping('thinking...'); true`);
      s = await state();
      ok('the turn ending gives the live button back (enabled, labelled Stop)', !s.disabled && !s.pending && s.text.includes('Stop'), s);
      await clickStop();
      ok('…and it can stop the NEXT turn', (await state()).n === 2);
      // THE FALLBACK TIMER: shortened here, its real value is pinned above
      await evaljs(`window.__ci.hideTyping();
        Object.defineProperty(VS.ChatInput, 'STOP_PENDING_MS', { get: () => 400, configurable: true });
        window.__ci.showTyping('thinking...'); true`);
      await clickStop();
      ok('pending again', (await state()).disabled === true);
      await sleep(700);
      s = await state();
      ok('the fallback timer re-arms a Stop whose turn never ended — the button can never stay dead', !s.disabled && !s.pending && s.text.includes('Stop'), s);
      await clickStop();
      ok('…and that re-armed button really works', (await state()).n === 4);
      // the two-step compaction Stop keeps its confirm AND gets the pending state
      await evaljs(`window.__ci.hideTyping(); window.__ci.showTyping('Compacting context…', 'compacting'); true`);
      await clickStop();
      s = await state();
      ok('a compaction Stop still ARMS first (no interrupt on the first click)', s.n === 4 && /Cancel compaction/.test(s.text) && !s.disabled, s);
      await clickStop();
      s = await state();
      ok('…and the confirming click both interrupts and goes pending', s.n === 5 && s.disabled === true && /Stopping/.test(s.text), s);
    } catch (e) {
      ok('the browser leg ran', false, String(e.message || e).slice(0, 300));
    } finally {
      try { ws?.close(); } catch {}
      try { chrome.kill('SIGKILL'); } catch {}
      try { srv.close(); } catch {}
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
}

// ⑨e THE CHORD IN A REAL BROWSER. Everything above decides; this proves the
// keystroke ARRIVES. The failure it exists to catch is a DOM one: the
// plain-Enter branch tests only `!e.shiftKey`, so before this change Alt+Enter
// WAS a send — a chord that quietly did the other thing. And the ≤768px
// measurement is the owner's standing rule for any UI change (2026-09-07).
console.log('— ⑨e the chord in a REAL browser (trusted keystrokes) + the 375×667 measurement');
{
  const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p2) => fs.existsSync(p2));
  if (!CHROME) {
    console.log('  SKIP: no chrome/chromium on this box — the DOM half of ⑨ did not run');
  } else {
    const http = await import('node:http');
    const net = await import('node:net');
    const { spawn } = await import('node:child_process');
    const esbuild = require(path.join(REPO, 'node_modules/esbuild'));
    const WebSocket = require('ws');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const freePort = () => new Promise((res, rej) => { const sv = net.createServer(); sv.on('error', rej); sv.listen(0, '127.0.0.1', () => { const pt = sv.address().port; sv.close(() => res(pt)); }); });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `vs-chord-${process.pid}-`));
    const bundle = path.join(tmp, 'chord.iife.js');
    const stub = { name: 'stub-build-version', setup(b) { b.onResolve({ filter: /build-version\.js$/ }, () => ({ path: 'build-version', namespace: 'bv' })); b.onLoad({ filter: /.*/, namespace: 'bv' }, () => ({ contents: "export const BUILD_VERSION = 'test';", loader: 'js' })); } };
    // TWO surfaces of the SAME capability in ONE page (and one chrome): the
    // composer (⑨e) and the Session Properties row that documents it (⑨f).
    const entry = path.join(tmp, 'entry.js');
    fs.writeFileSync(entry, `export { ChatInput } from ${JSON.stringify(path.join(REPO, 'src/lib/chat-input.js'))};\nexport { openSessionProps } from ${JSON.stringify(path.join(REPO, 'src/lib/session-props.js'))};\n`);
    await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', globalName: 'VS', platform: 'browser', target: 'es2022', outfile: bundle, logLevel: 'silent', loader: { '.css': 'text' }, plugins: [stub] });
    const js = fs.readFileSync(bundle, 'utf8').replace(/<\/script/gi, '<\\/script');
    const css = fs.readFileSync(path.join(REPO, 'public/chat.css'), 'utf8').replace(/<\/style/gi, '<\\/style');
    const base = fs.readFileSync(path.join(REPO, 'public/style.css'), 'utf8').replace(/<\/style/gi, '<\\/style');
    // A chat window shell so the input area is laid out the way it ships:
    // a column flex box, the composer at the bottom.
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>chord</title>` +
      `<style>${base}</style><style>${css}</style>` +
      `<style>html,body{margin:0;height:100%}#host{position:fixed;inset:0;display:flex;flex-direction:column}#list{flex:1;min-height:0}</style>` +
      `<body><div id="host" class="chat-view"><div id="list"></div></div><script>${js}</script>`;
    const port = await freePort(), cdpPort = await freePort();
    const srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(html); }).listen(port, '127.0.0.1');
    const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, '--no-first-run', '--no-sandbox', '--disable-gpu',
      '--disable-dev-shm-usage', '--disable-background-timer-throttling', `--user-data-dir=${tmp}/chrome`, 'about:blank'], { stdio: 'ignore' });
    let ws = null;
    try {
      let target = null;
      for (let i = 0; i < 120 && !target; i++) {
        try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page'); } catch { }
        if (!target) await sleep(250);
      }
      if (!target) throw new Error('chrome never exposed a CDP page target');
      ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
      await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
      let seq = 0; const pend = new Map();
      ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
      const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
      const evaljs = async (expr) => {
        const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
        return r.result?.result?.value;
      };
      await cdp('Runtime.enable'); await cdp('Page.enable');
      const setViewport = (width, height) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 768 });
      await setViewport(1280, 800);
      await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` });
      for (let i = 0; i < 80; i++) { if (await evaljs('!!(window.VS && window.VS.ChatInput)').catch(() => false)) break; await sleep(150); }

      // A REAL ChatInput in a REAL document, wired the way ChatView wires it:
      // onSteerChord stands in for runCommand('chat.steerNow') (the routing
      // itself is pinned in ⑨d) and onSteerSend for _steerAfterSend.
      const mount = async (caps) => evaljs(`(() => {
        document.querySelectorAll('.chat-input-area').forEach((e) => e.remove());
        window.__sent = []; window.__chord = 0; window.__steerSends = [];
        const ci = new VS.ChatInput({ send: (m) => window.__sent.push(m) }, 'sess-chord', {
          onSend(){}, onInterrupt(){},
          onSteerChord: () => { window.__chord++; ci.steerNow(); },
          onSteerSend: (id) => window.__steerSends.push(id),
        });
        document.getElementById('host').appendChild(ci.element);
        ci.setQueue([], ${JSON.stringify(caps)});
        window.__ci = ci;
        return !!document.querySelector('.chat-input-area');
      })()`);
      const type = async (text) => evaljs(`(() => { const ta = document.querySelector('.chat-input'); ta.focus(); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return ta.value; })()`);
      // TRUSTED keystrokes through the browser's own pipeline — a synthetic
      // KeyboardEvent would bypass exactly the branch order under test.
      const key = async (mods = 0) => {
        const common = { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', modifiers: mods };
        await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
        await cdp('Input.dispatchKeyEvent', { type: 'char', ...common });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
        await sleep(60);
      };
      const ALT = 1, CTRL = 2;
      const state = () => evaljs(`(() => {
        const hint = document.querySelector('.chat-send-hint');
        const btn = document.querySelector('.chat-steer-btn');
        const cs = (el) => el ? getComputedStyle(el).display : null;
        return { sent: window.__sent.length, chord: window.__chord, steers: window.__steerSends.slice(),
                 text: document.querySelector('.chat-input').value,
                 hintDisplay: cs(hint), hintText: hint ? hint.textContent : null,
                 btnDisplay: cs(btn) };
      })()`);

      const codexCaps = require(path.join(REPO, 'src/backend-caps.js')).capsOf('codex').inputModes;
      const claudeCaps = require(path.join(REPO, 'src/backend-caps.js')).capsOf('claude').inputModes;

      // ── DESKTOP, a codex session mid-turn ──
      ok('a real ChatInput mounts with codex caps', (await mount(codexCaps)) === true);
      let st = await state();
      ok('IDLE: no hint (the chord only exists while a turn runs)', st.hintDisplay === 'none' && st.chord === 0, st);
      await evaljs(`window.__ci.showTyping('thinking...'); true`);
      st = await state();
      ok('MID-TURN: the hint is VISIBLE and names both keys', st.hintDisplay !== 'none' && /Enter queues/.test(st.hintText) && /Alt\+Enter injects now/.test(st.hintText), st);
      ok('…and the ≤768px bolt button is NOT shown on a desktop viewport (CSS owns WHERE, JS owns WHETHER)', st.btnDisplay === 'none', st);

      await type('steer me');
      await key(ALT);
      st = await state();
      ok('THE CHORD: a trusted Alt+Enter runs the steer verb and sends the composer text ONCE', st.chord === 1 && st.sent === 1 && st.steers.length === 1, st);
      const frames = await evaljs('JSON.stringify(window.__sent)');
      ok('…as the ORDINARY chat-input frame (no invented "steer" wire shape) carrying the text', /"type":"chat-input"/.test(frames) && /steer me/.test(frames) && !/"type":"steer"/.test(frames), frames.slice(0, 200));
      ok('…and the msgId handed to the host is the frame\'s own (the id that will name the queued item)', st.steers[0] === JSON.parse(frames)[0].msgId, { steers: st.steers, frames: frames.slice(0, 160) });
      ok('…and the composer is cleared, exactly like an ordinary send', st.text === '', st);

      // plain Enter still QUEUES (an ordinary send), Ctrl+Enter still sends
      await type('plain enter');
      await key(0);
      st = await state();
      ok('PLAIN ENTER still sends (queued) and is NOT a steer', st.sent === 2 && st.chord === 1 && st.steers.length === 1, st);
      await evaljs(`window.__ci._expanded = true; true`);
      await type('ctrl enter');
      await key(CTRL);
      st = await state();
      ok('CTRL+ENTER still means send/queue — the chord did not redefine it', st.sent === 3 && st.chord === 1 && st.steers.length === 1, st);
      await evaljs(`window.__ci._expanded = false; true`);

      // ── DESKTOP, a claude session mid-turn: no hint, and Alt+Enter is a PLAIN send ──
      ok('a real ChatInput mounts with claude caps', (await mount(claudeCaps)) === true);
      await evaljs(`window.__ci.showTyping('thinking...'); true`);
      st = await state();
      ok('CLAUDE: no hint at all (the owner\'s rule: 不支持queue的就不显示)', st.hintDisplay === 'none' && st.btnDisplay === 'none', st);
      await type('alt on claude');
      await key(ALT);
      st = await state();
      ok('CLAUDE: Alt+Enter is NOT a chord — it falls through to the ordinary send, and nothing claims a steer', st.chord === 0 && st.steers.length === 0 && st.sent === 1, st);

      // ── ≤768px MEASUREMENT (375×667), the owner's standing rule ──
      await setViewport(375, 667);
      await sleep(120);
      ok('a real ChatInput mounts with codex caps at 375×667', (await mount(codexCaps)) === true);
      await evaljs(`window.__ci.showTyping('thinking...'); true`);
      await type('phone steer');
      await sleep(80);
      const m = await evaljs(`(() => {
        const area = document.querySelector('.chat-input-area');
        const btn = document.querySelector('.chat-steer-btn');
        const send = document.querySelector('.chat-send-btn');
        const ta = document.querySelector('.chat-input');
        const hint = document.querySelector('.chat-send-hint');
        const r = (el) => { const q = el.getBoundingClientRect(); return { x: Math.round(q.left), y: Math.round(q.top), w: Math.round(q.width), h: Math.round(q.height), right: Math.round(q.right), bottom: Math.round(q.bottom) }; };
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
        return { vw: innerWidth, vh: innerHeight, area: r(area), btn: r(btn), send: r(send), ta: r(ta),
                 btnDisplay: getComputedStyle(btn).display, hintDisplay: getComputedStyle(hint).display,
                 rows: +(r(ta).h / lh).toFixed(2), lh,
                 areaScrollW: area.scrollWidth, areaClientW: area.clientWidth,
                 docScrollW: document.documentElement.scrollWidth };
      })()`);
      ok(`375×667: the bolt button IS shown (${m.btnDisplay}) and the keyboard hint is not (${m.hintDisplay}) — a phone has no Alt key`, m.btnDisplay !== 'none' && m.hintDisplay === 'none', m);
      ok(`…and it sits BESIDE Send, on the same row (btn ${m.btn.x}..${m.btn.right} @y${m.btn.y}, send @${m.send.x} y${m.send.y})`, m.btn.right <= m.send.x + 2 && Math.abs(m.btn.bottom - m.send.bottom) <= 24, m);
      ok(`…the button is a real touch target (${m.btn.w}×${m.btn.h} ≥ 32×32)`, m.btn.w >= 32 && m.btn.h >= 32, m.btn);
      ok(`…the textarea still shows ≥2 rows (${m.rows} rows, ${m.ta.h}px at line-height ${m.lh})`, m.ta.h >= 2 * m.lh - 1, m);
      ok(`…and NOTHING overflows: the input area does not scroll sideways (${m.areaScrollW} ≤ ${m.areaClientW}) and neither does the page (${m.docScrollW} ≤ ${m.vw})`, m.areaScrollW <= m.areaClientW + 1 && m.docScrollW <= m.vw + 1, m);
      ok(`…everything stays inside the viewport (send right edge ${m.send.right} ≤ ${m.vw})`, m.send.right <= m.vw && m.btn.x >= 0 && m.area.bottom <= m.vh + 1, m);
      // the button runs the SAME verb
      await evaljs(`document.querySelector('.chat-steer-btn').click(); true`);
      st = await state();
      ok('the touch button runs the SAME verb as the chord (one command, two faces)', st.chord === 1 && st.steers.length === 1 && st.sent === 1, st);
      // …and it disappears with the turn
      await evaljs(`window.__ci.hideTyping(); true`);
      ok('…and it disappears when the turn ends', (await evaljs(`getComputedStyle(document.querySelector('.chat-steer-btn')).display`)) === 'none');

      // ── ⑨f SESSION PROPERTIES: ONE 'Config overrides' header, however many
      //    of its rows are LAZY (round-2 verifier's minor). `section()`
      //    APPENDS a header every time it is called, and the panel's
      //    `cfgSec || section(...)` idiom called it once PER LAZY ROW — which
      //    was invisible while exactly one such row existed and printed the
      //    header TWICE the moment the send-modes row joined it (codex with
      //    no saved override = the common case). Driven through the REAL
      //    openSessionProps in the REAL document: nothing here is a
      //    transcription of the lines under test.
      await setViewport(1280, 800);
      const props = async (backend, cfg) => evaljs(`(() => {
        document.querySelectorAll('.props-host').forEach((e) => e.remove());
        const s = { sessionId: 'sp-' + ${JSON.stringify(backend)}, backend: ${JSON.stringify(backend)}, cwd: '/w', name: 'N', status: 'live', webuiMode: 'chat' };
        const cfg = ${JSON.stringify(cfg || {})};
        const host = document.createElement('div');
        host.className = 'props-host';
        document.body.appendChild(host);
        const win = { id: 'w-props', content: host, onClose: null };
        const app = {
          wm: { windows: new Map(), createWindow: () => win, focusWindow() {}, setTitle() {} },
          ws: { onGlobal() {}, offGlobal() {} },
          settings: { get: () => false },
          _accounts: { accounts: [] },
          sidebar: {
            _allSessions: [s], _tasks: [], _hostsData: { hosts: [] },
            _getSessionStateKey: (x) => x.sessionId,
            getCustomName: () => '', getSessionStatus: () => null,
            getSessionConfig: () => cfg, setSessionConfig() {},
            _getSessionTasks: () => [], _getSessionTaskGroups: () => [],
          },
        };
        VS.openSessionProps(app, s, {});
        window.__propsHost = host;
        return window.__readProps();
      })()`);
      // ONE probe, used by every row below AND by its own sensitivity check.
      await evaljs(`window.__readProps = () => {
        const host = window.__propsHost;
        const secs = [...host.querySelectorAll('.task-detail-section')];
        const cfgSecs = secs.filter((x) => (x.querySelector('.task-detail-label') || {}).textContent === 'Config overrides');
        return {
          headers: cfgSecs.length,
          rows: cfgSecs.map((x) => [...x.querySelectorAll('.session-detail-label')].map((e) => e.textContent)),
          allSections: secs.map((x) => (x.querySelector('.task-detail-label') || {}).textContent),
        };
      }; true`);

      let sp = await props('codex', {});
      ok('THE ROUND-2 MINOR: a codex session with NO saved override renders exactly ONE "Config overrides" header', sp.headers === 1, sp);
      ok('…and BOTH lazy rows live inside that one section (a second header would have split them)', sp.headers === 1 && sp.rows[0].includes('Response style') && sp.rows[0].includes('Sending during a turn'), sp.rows);
      // NEGATIVE CONTROL for the PROBE itself: it must be able to SEE two.
      const dup = await evaljs(`(() => {
        const host = window.__propsHost;
        const first = [...host.querySelectorAll('.task-detail-section')].find((x) => (x.querySelector('.task-detail-label') || {}).textContent === 'Config overrides');
        const clone = first.cloneNode(true); host.appendChild(clone);
        const seen = window.__readProps().headers; clone.remove();
        return { seen, after: window.__readProps().headers };
      })()`);
      ok('NEGATIVE CONTROL: the probe counts headers — inject a duplicate section and it reports 2 (the assert above is not vacuous)', dup.seen === 2 && dup.after === 1, dup);

      sp = await props('codex', { model: 'opus' });
      ok('…and with a saved override the EAGER header is REUSED, never re-created: one section, all three rows', sp.headers === 1 && ['Saved', 'Response style', 'Sending during a turn'].every((r) => sp.rows[0].includes(r)), sp);

      sp = await props('opencode', {});
      ok('opencode: only the send-modes row is lazy here, and it still gets exactly one header', sp.headers === 1 && sp.rows[0].includes('Sending during a turn') && !sp.rows[0].includes('Response style'), sp);

      sp = await props('claude', {});
      ok('claude: one header for the response style — and NO "Sending during a turn" row (the owner\'s rule, 不支持queue的就不显示)', sp.headers === 1 && sp.rows[0].includes('Response style') && !sp.rows[0].includes('Sending during a turn'), sp);

      sp = await props('shell', {});
      ok('shell: no row wants it ⇒ the section is never created at all (the lazy header stays lazy)', sp.headers === 0 && !sp.allSections.includes('Config overrides'), sp);

      // ≤768px (the owner's standing rule for any UI change): the panel is the
      // same window on a phone — one header, both rows, no sideways overflow.
      await setViewport(375, 667);
      await sleep(120);
      sp = await props('codex', {});
      ok('375×667: still ONE header with both rows (the duplicate was a phone bug too — twice the vertical cost on the smallest screen)', sp.headers === 1 && sp.rows[0].includes('Response style') && sp.rows[0].includes('Sending during a turn'), sp);
      const pm = await evaljs(`(() => {
        const root = window.__propsHost.querySelector('.session-props');
        const sec = [...root.querySelectorAll('.task-detail-section')].find((x) => (x.querySelector('.task-detail-label') || {}).textContent === 'Config overrides');
        const r = (el) => { const q = el.getBoundingClientRect(); return { w: Math.round(q.width), h: Math.round(q.height), right: Math.round(q.right) }; };
        return { vw: innerWidth, root: r(root), sec: r(sec), rootScrollW: root.scrollWidth, rootClientW: root.clientWidth, secScrollW: sec.scrollWidth, secClientW: sec.clientWidth };
      })()`);
      ok(`…and nothing overflows sideways at 375px (root ${pm.rootScrollW} ≤ ${pm.rootClientW}, section ${pm.secScrollW} ≤ ${pm.secClientW}, right edge ${pm.sec.right} ≤ ${pm.vw})`, pm.rootScrollW <= pm.rootClientW + 1 && pm.secScrollW <= pm.secClientW + 1 && pm.sec.right <= pm.vw + 1, pm);
    } catch (e) {
      ok('the browser leg ran', false, String(e.message || e).slice(0, 400));
    } finally {
      try { ws?.close(); } catch { }
      try { chrome.kill('SIGKILL'); } catch { }
      try { srv.close(); } catch { }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
    }
  }
}

// ⑪ THE CONTROLS IN A REAL BROWSER (trusted CDP input). The strip's markup is
// already pinned DOM-free in ⑤, but a drag handle is not markup: it is pointer
// capture, rAF-coalesced moves, midpoint hit-testing and a per-drag
// AbortController. The frame it produces — and its `afterId` — can only be
// proven by actually dragging. The edit control is here for the same reason:
// "open the text in the input, send saves it" is three DOM states.
console.log('— ⑪ drag-reorder / edit / run-all in a REAL browser (trusted pointer input)');
{
  const CHROME2 = ['/usr/bin/google-chrome',  '/usr/bin/google-chrome-stable',  '/usr/bin/chromium',  '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
  if (!CHROME2) {
    console.log('  SKIP: no chrome/chromium on this box — the DOM half of ⑪ did not run');
  } else {
    const http = await import('node:http');
    const net = await import('node:net');
    const { spawn } = await import('node:child_process');
    const esbuild = require(path.join(REPO, 'node_modules/esbuild'));
    const WebSocket = require('ws');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error',  rej); s.listen(0, '127.0.0.1',  () => { const p = s.address().port; s.close(() => res(p)); }); });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `vs-qverbs-${process.pid}-`));
    const bundle = path.join(tmp, 'chat-input.iife.js');
    const stub = { name: 'stub-build-version',  setup(b) { b.onResolve({ filter: /build-version\.js$/ }, () => ({ path: 'build-version',  namespace: 'bv' })); b.onLoad({ filter: /.*/, namespace: 'bv' }, () => ({ contents: "export const BUILD_VERSION = 'test';", loader: 'js' })); } };
    // ONE module instance for the component AND the draft channel it writes
    // to: `saveDraft` is a no-op until a StateSync exists, so a second bundle
    // would give the test its own dead singleton and every draft assertion
    // below would pass vacuously. The virtual entry re-exports both halves of
    // the REAL modules (round-3 verifier's evidence used a real StateSync).
    const vEntry = { name: 'virtual-entry',  setup(b) {
      b.onResolve({ filter: /^vs-entry$/ }, () => ({ path: 'vs-entry',  namespace: 'vse' }));
      b.onLoad({ filter: /.*/, namespace: 'vse' }, () => ({
        contents: `export { ChatInput } from ${JSON.stringify(path.join(REPO, 'src/lib/chat-input.js'))};\n`
          + `export { initStateSync, getStateSync, saveDraft, loadDraft, showToast } from ${JSON.stringify(path.join(REPO, 'src/lib/utils.js'))};\n`,
        resolveDir: REPO, loader: 'js' }));
    } };
    await esbuild.build({ entryPoints: ['vs-entry'], bundle: true, format: 'iife',  globalName: 'VS',  platform: 'browser',  target: 'es2022',  outfile: bundle, logLevel: 'silent',  loader: { '.css': 'text' }, plugins: [stub, vEntry] });
    const js = fs.readFileSync(bundle, 'utf8').replace(/<\/script/gi, '<\\/script');
    const css = fs.readFileSync(path.join(REPO, 'public/chat.css'), 'utf8').replace(/<\/style/gi, '<\\/style');
    const html = `<!doctype html><meta charset="utf-8"><title>queue verbs</title><style>${css}
      body { margin: 0; background: #111; color: #eee; }
      /* the strip is normally inside a sized window — give the rows real height
         so the drag's midpoint hit-test has geometry to work with */
      .chat-queue-item { height: 26px; }
    </style><body></body><script>${js}</script>`;
    const port = await freePort(), cdpPort = await freePort();
    const srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(html); }).listen(port, '127.0.0.1');
    const chrome = spawn(CHROME2, ['--headless=new',  `--remote-debugging-port=${cdpPort}`,  '--no-first-run',  '--no-sandbox',  '--disable-gpu', 
      '--disable-dev-shm-usage',  '--disable-background-timer-throttling',  `--user-data-dir=${tmp}/chrome`,  'about:blank'], { stdio: 'ignore' });
    let ws = null;
    try {
      let target = null;
      for (let i = 0; i < 120 && !target; i++) {
        try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page'); } catch { }
        if (!target) await sleep(250);
      }
      if (!target) throw new Error('chrome never exposed a CDP page target');
      ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
      await new Promise((r, j) => { ws.on('open',  r); ws.on('error',  j); });
      let seq = 0; const pend = new Map();
      ws.on('message',  (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
      const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
      const evaljs = async (expr) => {
        const r = await cdp('Runtime.evaluate',  { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
        return r.result?.result?.value;
      };
      await cdp('Runtime.enable'); await cdp('Page.enable');
      await cdp('Page.navigate',  { url: `http://127.0.0.1:${port}/` });
      for (let i = 0; i < 80; i++) { if (await evaljs('!!(window.VS && window.VS.ChatInput)').catch(() => false)) break; await sleep(150); }

      const { capsOf: caps11 } = require(path.join(REPO, 'src/backend-caps.js'));
      const CODEX_VERBS = JSON.stringify(caps11('codex').inputModes);
      const OPENCODE_VERBS = JSON.stringify(caps11('opencode').inputModes);
      const CLAUDE_VERBS = JSON.stringify(caps11('claude').inputModes);
      // A REAL StateSync over a fake socket: `saveDraft`/`loadDraft` are the
      // draft channel this control is forbidden to borrow (round-2 finding 5)
      // and required to fall back to when a rewrite loses its row (round-3) —
      // both are unobservable without one. /api/sync/* 404s into HTML here, so
      // init lands on its own catch and the store starts empty.
      const syncReady = await evaljs(`(async () => {
        window.__stateSets = [];
        await VS.initStateSync({ onGlobal(){}, onStateChange(){}, send: (m) => window.__stateSets.push(m) });
        return !!VS.getStateSync();
      })()`);
      ok('a REAL StateSync backs the draft channel (saveDraft is a silent no-op without one — every draft assert below would pass vacuously)', syncReady === true);
      const built = await evaljs(`(() => {
        window.__ops = []; window.__sent = [];
        const ci = new VS.ChatInput({ send(f){ window.__sent.push(f); } }, 'sess-verbs',  { onSend(){}, onInterrupt(){}, onQueueOp: (op, id, extra) => window.__ops.push({ op, id, extra }) });
        document.body.appendChild(ci.element);
        window.__ci = ci;
        window.__items = [
          { id: 'q1',  msgId: 'm1',  preview: 'first',  text: 'first',  kind: 'user' },
          { id: 'q2',  msgId: 'm2',  preview: 'second',  text: 'second',  kind: 'user' },
          { id: 'q3',  msgId: '',  preview: 'ping',  kind: 'peer',  from: 'session B' },
        ];
        ci.setQueue(window.__items, ${CODEX_VERBS});
        return document.querySelectorAll('.chat-queue-item').length;
      })()`);
      ok(`a real ChatInput renders the three queued rows (${built})`, built === 3);

      // THE DRAG: press the FIRST row's grip, move past the SECOND row's
      // midpoint, release. Trusted CDP input, so pointer capture, the rAF
      // coalescing and the midpoint hit-test all run for real.
      const gripBox = (n) => evaljs(`(() => { const g = document.querySelectorAll('.chat-queue-grip')[${n}]; const r = g.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
      const rowBox = (n) => evaljs(`(() => { const g = document.querySelectorAll('.chat-queue-item')[${n}]; const r = g.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, mid: r.top + r.height/2 }; })()`);
      const ops = () => evaljs('window.__ops');
      {
        const from = await gripBox(0), row2 = await rowBox(1);
        await cdp('Input.dispatchMouseEvent',  { type: 'mousePressed',  x: from.x, y: from.y, button: 'left',  clickCount: 1, pointerType: 'mouse' });
        // two moves: one small (proves the >3px gate), one past row 2's midpoint
        await cdp('Input.dispatchMouseEvent',  { type: 'mouseMoved',  x: from.x, y: from.y + 2, button: 'left',  pointerType: 'mouse' });
        await cdp('Input.dispatchMouseEvent',  { type: 'mouseMoved',  x: from.x, y: row2.mid + 3, button: 'left',  pointerType: 'mouse' });
        await sleep(120);   // let the rAF-coalesced apply() run
        const marked = await evaljs(`(() => ({ dragging: !!document.querySelector('.chat-queue-dragging'), after: document.querySelector('.chat-queue-drop-after')?.dataset.queueId || null }))()`);
        ok(`the drag paints where it would land (dragging + drop-after q2): ${JSON.stringify(marked)}`, marked.dragging === true && marked.after === 'q2');
        await cdp('Input.dispatchMouseEvent',  { type: 'mouseReleased',  x: from.x, y: row2.mid + 3, button: 'left',  clickCount: 1, pointerType: 'mouse' });
        await sleep(120);
        const sent = await ops();
        ok(`THE DRAG SENDS A REORDER for the dragged row (${JSON.stringify(sent)})`, sent.length === 1 && sent[0].op === 'reorder' && sent[0].id === 'q1');
        ok(`…with the RELATIVE anchor it was dropped behind (afterId=${JSON.stringify(sent[0].extra)})`, sent[0].extra?.afterId === 'q2');
        const cleaned = await evaljs(`(() => ({ dragging: !!document.querySelector('.chat-queue-dragging'), after: !!document.querySelector('.chat-queue-drop-after'), pending: document.querySelector('[data-queue-state="pending"]')?.dataset.queueId || null }))()`);
        ok('the drag chrome is gone on release', cleaned.dragging === false && cleaned.after === false);
        ok('and the row shows the op is in flight (a control that looks idle after a click is the silent failure)', cleaned.pending === 'q1');
      }
      // DROP AT THE FRONT: afterId null is a POSITION, not a missing argument.
      {
        await evaljs('window.__ops = []; window.__ci.setQueue(window.__items, ' + CODEX_VERBS + ');');
        const from = await gripBox(2), row0 = await rowBox(0);
        await cdp('Input.dispatchMouseEvent',  { type: 'mousePressed',  x: from.x, y: from.y, button: 'left',  clickCount: 1, pointerType: 'mouse' });
        await cdp('Input.dispatchMouseEvent',  { type: 'mouseMoved',  x: from.x, y: row0.top - 6, button: 'left',  pointerType: 'mouse' });
        await sleep(120);
        await cdp('Input.dispatchMouseEvent',  { type: 'mouseReleased',  x: from.x, y: row0.top - 6, button: 'left',  clickCount: 1, pointerType: 'mouse' });
        await sleep(120);
        const sent = await ops();
        ok(`dropping above the first row means the FRONT, sent as afterId null (${JSON.stringify(sent)})`, sent.length === 1 && sent[0].op === 'reorder' && sent[0].id === 'q3' && sent[0].extra?.afterId === null);
      }
      // ── ROUND-2 VERIFIER, finding 2: A REPUBLISH DURING THE DRAG. Every
      // `queue_changed` rebuilds `strip.innerHTML`, so the rows a closure
      // captured at pointerdown are DETACHED — and a detached node's rect is
      // all zeros, so the midpoint test said "below every row" and the drop
      // landed the item silently at the END of the queue. The trigger is
      // ordinary: a peer message, another client, an item leaving.
      {
        await evaljs('window.__ops = []; window.__ci.setQueue(window.__items, ' + CODEX_VERBS + ');');
        const from = await gripBox(0), row2 = await rowBox(1);
        await cdp('Input.dispatchMouseEvent',  { type: 'mousePressed',  x: from.x, y: from.y, button: 'left',  clickCount: 1, pointerType: 'mouse' });
        await cdp('Input.dispatchMouseEvent',  { type: 'mouseMoved',  x: from.x, y: row2.mid + 4, button: 'left',  pointerType: 'mouse' });
        await sleep(120);
        // …a peer queues a message MID-DRAG (the real 1s window)
        const during = await evaljs(`(() => {
          window.__ci.setQueue([...window.__items, { id: 'q4',  msgId: '',  preview: 'a peer just queued this',  kind: 'peer',  from: 'session C' }], ${CODEX_VERBS});
          return { rows: document.querySelectorAll('.chat-queue-item').length, after: document.querySelector('.chat-queue-drop-after')?.dataset.queueId || null };
        })()`);
        ok(`the republish lands (4 rows) and the drop indicator is REPAINTED on the new rows (${JSON.stringify(during)})`, during.rows === 4 && during.after === 'q2');
        await cdp('Input.dispatchMouseEvent',  { type: 'mouseReleased',  x: from.x, y: row2.mid + 4, button: 'left',  clickCount: 1, pointerType: 'mouse' });
        await sleep(120);
        const sent = await ops();
        ok(`finding 2: the drop still lands WHERE IT WAS DROPPED after a mid-drag republish (${JSON.stringify(sent)})`, sent.length === 1 && sent[0].op === 'reorder' && sent[0].id === 'q1' && sent[0].extra?.afterId === 'q2');
        // …and the dragged row LEAVING the queue mid-drag sends nothing at all
        // (there is nothing left to reorder; sending would earn a 'gone').
        await evaljs('window.__ops = []; window.__ci.setQueue(window.__items, ' + CODEX_VERBS + ');');
        const g0 = await gripBox(0), r2 = await rowBox(1);
        await cdp('Input.dispatchMouseEvent',  { type: 'mousePressed',  x: g0.x, y: g0.y, button: 'left',  clickCount: 1, pointerType: 'mouse' });
        await cdp('Input.dispatchMouseEvent',  { type: 'mouseMoved',  x: g0.x, y: r2.mid + 4, button: 'left',  pointerType: 'mouse' });
        await sleep(120);
        await evaljs(`window.__ci.setQueue(window.__items.slice(1), ${CODEX_VERBS});`);
        await cdp('Input.dispatchMouseEvent',  { type: 'mouseReleased',  x: g0.x, y: r2.mid + 4, button: 'left',  clickCount: 1, pointerType: 'mouse' });
        await sleep(120);
        ok('…and a row that LEFT the queue mid-drag sends no reorder at all', (await ops()).length === 0);
        await evaljs('window.__ci.setQueue(window.__items, ' + CODEX_VERBS + ');');
      }
      // ── THE MERGE'S OWN DEFECT (r2 verifier, finding 1): master's AUTO
      // COLLAPSE (2.369.60) firing MID-DRAG. Neither side has this alone —
      // master had no drag, the branch never collapsed. Crossing
      // QUEUE_COLLAPSE_AT while a pointer drag runs emitted ZERO
      // `.chat-queue-item` nodes; the live drag's repaint then hit-tested an
      // EMPTY row list, so its `let afterId = null` survived untouched — and
      // `null` is not "no answer" in this protocol, it MEANS the front of the
      // queue — and the release dispatched `reorder <id> afterId:null`. The
      // trigger is the exact scenario the collapse feature was built for (the
      // owner's 25 queued Background Work notifications).
      {
        const mk8 = `(() => {
          window.__ops = [];
          window.__items8 = Array.from({ length: 8 }, (_, i) => ({ id: 'q' + (i + 1),  msgId: 'm' + (i + 1),  preview: 'item ' + (i + 1), text: 'item ' + (i + 1), kind: 'user' }));
          window.__items9 = [...window.__items8, { id: 'q9',  msgId: '',  preview: 'a job notification',  kind: 'peer',  from: 'jobs' }];
          window.__ci._queueCollapsed = undefined;
          window.__ci.setQueue(window.__items8, ${CODEX_VERBS});
          return { rows: document.querySelectorAll('.chat-queue-item').length, collapsed: document.querySelector('.chat-queue-strip').classList.contains('chat-queue-collapsed') };
        })()`;
        const start8 = await evaljs(mk8);
        ok(`AT the threshold the strip is still open (${JSON.stringify(start8)})`, start8.rows === 8 && start8.collapsed === false);
        // …and the feature itself still works when nothing is in flight: the
        // 9th item collapses the strip with no user action. (POSITIVE CONTROL
        // for master's 2.369.60 — the fix suppresses the auto collapse ONLY
        // while a live mode owns the rows.)
        const auto9 = await evaljs(`(() => {
          window.__ci.setQueue(window.__items9, ${CODEX_VERBS});
          const out = { rows: document.querySelectorAll('.chat-queue-item').length, collapsed: document.querySelector('.chat-queue-strip').classList.contains('chat-queue-collapsed') };
          window.__ci._queueCollapsed = undefined;
          window.__ci.setQueue(window.__items8, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`past it, with NOTHING in flight, the 9th item still auto-collapses the strip (master's feature, unbroken): ${JSON.stringify(auto9)}`, auto9.rows === 0 && auto9.collapsed === true);

        // THE DEFECT'S SCENARIO: drag q3 past q5's midpoint, then a 9th item
        // arrives (a job notification — no user action at all).
        const dragAcross = async (mutate) => {
          await evaljs(`(() => { window.__ops = []; window.__ci._queueCollapsed = undefined; window.__ci.setQueue(window.__items8, ${CODEX_VERBS}); })()`);
          const grip = await evaljs(`(() => { const g = document.querySelectorAll('.chat-queue-grip')[2]; const r = g.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
          const row5 = await rowBox(4);
          await cdp('Input.dispatchMouseEvent',  { type: 'mousePressed',  x: grip.x, y: grip.y, button: 'left',  clickCount: 1, pointerType: 'mouse' });
          await cdp('Input.dispatchMouseEvent',  { type: 'mouseMoved',  x: grip.x, y: row5.mid + 3, button: 'left',  pointerType: 'mouse' });
          await sleep(120);
          const painted = await evaljs(`(() => ({ after: document.querySelector('.chat-queue-drop-after')?.dataset.queueId || null, dragging: !!document.querySelector('.chat-queue-dragging') }))()`);
          const during = mutate ? await evaljs(mutate) : null;
          await cdp('Input.dispatchMouseEvent',  { type: 'mouseReleased',  x: grip.x, y: row5.mid + 3, button: 'left',  clickCount: 1, pointerType: 'mouse' });
          await sleep(120);
          const sent = await ops();
          await evaljs(`(() => { window.__ci._queueDrag = null; window.__ci._queueCollapsed = undefined; window.__ci.setQueue(window.__items8, ${CODEX_VERBS}); })()`);
          return { painted, during, sent };
        };
        const republish9 = `(() => {
          window.__ci.setQueue(window.__items9, ${CODEX_VERBS});
          return { rows: document.querySelectorAll('.chat-queue-item').length, collapsed: document.querySelector('.chat-queue-strip').classList.contains('chat-queue-collapsed'), after: document.querySelector('.chat-queue-drop-after')?.dataset.queueId || null, dragAfter: (window.__ci._queueDrag ? String(window.__ci._queueDrag.afterId) : 'NO-DRAG') };
        })()`;
        const crossed = await dragAcross(republish9);
        ok(`the drag paints where it would land before the republish (${JSON.stringify(crossed.painted)})`, crossed.painted.dragging === true && crossed.painted.after === 'q5');
        ok(`finding 1: crossing QUEUE_COLLAPSE_AT mid-drag does NOT collapse the rows out from under the drag (${JSON.stringify(crossed.during)})`,
          crossed.during.rows === 9 && crossed.during.collapsed === false);
        ok('…the drop indicator is still on the row it will land behind, and the drag still holds that anchor', crossed.during.after === 'q5' && crossed.during.dragAfter === 'q5');
        ok(`…and the release sends the landing the user aimed at, not the FRONT (${JSON.stringify(crossed.sent)})`,
          crossed.sent.length === 1 && crossed.sent[0].op === 'reorder' && crossed.sent[0].id === 'q3' && crossed.sent[0].extra?.afterId === 'q5');

        // NEGATIVE CONTROL A: the identical drag whose mid-drag republish does
        // NOT cross the threshold — the value that must not depend on it.
        const notCrossed = await dragAcross(`(() => { window.__ci.setQueue([...window.__items8], ${CODEX_VERBS}); return { rows: document.querySelectorAll('.chat-queue-item').length, collapsed: document.querySelector('.chat-queue-strip').classList.contains('chat-queue-collapsed'), after: document.querySelector('.chat-queue-drop-after')?.dataset.queueId || null, dragAfter: (window.__ci._queueDrag ? String(window.__ci._queueDrag.afterId) : 'NO-DRAG') }; })()`);
        ok(`negative control: an 8→8 republish mid-drag lands identically (${JSON.stringify(notCrossed.sent)})`,
          notCrossed.during.rows === 8 && notCrossed.during.collapsed === false && notCrossed.sent.length === 1 && notCrossed.sent[0].extra?.afterId === 'q5');

        // THE BELT, on the ONE collapse the guard deliberately leaves alone:
        // the user's OWN chevron. That render really is rowless, and the drag
        // must keep the last REAL answer instead of falling back to `null`.
        const explicit = await dragAcross(`(() => {
          window.__ci._queueCollapsed = true;
          window.__ci.setQueue(window.__items9, ${CODEX_VERBS});
          return { rows: document.querySelectorAll('.chat-queue-item').length, collapsed: document.querySelector('.chat-queue-strip').classList.contains('chat-queue-collapsed'), after: document.querySelector('.chat-queue-drop-after')?.dataset.queueId || null, dragAfter: (window.__ci._queueDrag ? String(window.__ci._queueDrag.afterId) : 'NO-DRAG') };
        })()`);
        ok(`an EXPLICIT collapse mid-drag really does empty the rows (${JSON.stringify(explicit.during)})`, explicit.during.rows === 0 && explicit.during.collapsed === true);
        ok('…and the belt keeps the drag on its last REAL anchor instead of answering `null`', explicit.during.dragAfter === 'q5');
        ok(`…so the drop still lands where it was aimed (${JSON.stringify(explicit.sent)})`, explicit.sent.length === 1 && explicit.sent[0].extra?.afterId === 'q5');

        // NEGATIVE CONTROL B — THE DEFECT ITSELF, REPRODUCED through the real
        // `finish()`, the real landing math and the real dispatch: the ONLY
        // thing neutered is the belt (the drag's repaint is swapped for a
        // verbatim copy of the pre-fix body, which hit-tests whatever
        // `liveRows()` returns and stores the result unconditionally).
        const unbelted = await dragAcross(`(() => {
          const strip = document.querySelector('.chat-queue-strip');
          window.__ci._queueDrag.apply = () => {                 // the PRE-FIX body, verbatim
            const d = window.__ci._queueDrag; d.raf = 0;
            let afterId = null;
            const rows = [...strip.querySelectorAll('.chat-queue-item')];
            for (const row of rows) {
              if (row.dataset.queueId === d.id) continue;
              const r = row.getBoundingClientRect();
              if (d.y > r.top + r.height / 2) afterId = row.dataset.queueId;
            }
            d.afterId = afterId;
          };
          window.__ci._queueCollapsed = true;                    // …and the guard, off
          window.__ci.setQueue(window.__items9, ${CODEX_VERBS});
          return { rows: document.querySelectorAll('.chat-queue-item').length, dragAfter: (window.__ci._queueDrag ? String(window.__ci._queueDrag.afterId) : 'NO-DRAG') };
        })()`);
        ok(`negative control: with the belt neutered and the guard off, the rowless render answers \`null\` (${JSON.stringify(unbelted.during)})`, unbelted.during.rows === 0 && unbelted.during.dragAfter === 'null');
        ok(`…and THAT is a silent "move to the FRONT of the queue" — the defect, reproduced (${JSON.stringify(unbelted.sent)})`,
          unbelted.sent.length === 1 && unbelted.sent[0].op === 'reorder' && unbelted.sent[0].id === 'q3' && unbelted.sent[0].extra?.afterId === null);
      }
      // ── r2 verifier, finding 2: THE SAME AUTO COLLAPSE WHILE A QUEUED
      // MESSAGE IS OPEN FOR EDITING. It deletes the ✕ that ends the edit and
      // the row's `data-queue-editing` marker while `_editingQueueId` stays
      // set and Send silently still means "save the edit" — with no user
      // action at all (an ordinary job notification / peer message).
      {
        const opened = await evaljs(`(() => {
          window.__ops = [];
          window.__ci._queueCollapsed = undefined;
          window.__ci.setQueue(window.__items8, ${CODEX_VERBS});
          document.querySelector('textarea').value = 'a draft I was typing';
          document.querySelector('[data-queue-op="edit"][data-queue-id="q2"]').click();
          const row = document.querySelector('[data-queue-id="q2"]');
          return { editing: window.__ci._editingQueueId, cancel: !!document.querySelector('[data-queue-op="edit-cancel"]'), marker: row?.dataset.queueEditing || null, box: document.querySelector('textarea').value };
        })()`);
        ok(`an edit is open on a row of an 8-item queue (${JSON.stringify(opened)})`, opened.editing === 'q2' && opened.cancel === true && opened.marker === '1' && opened.box === 'item 2');
        const arrived = await evaljs(`(() => {
          window.__ci.setQueue(window.__items9, ${CODEX_VERBS});
          const row = document.querySelector('[data-queue-id="q2"]');
          return { collapsed: document.querySelector('.chat-queue-strip').classList.contains('chat-queue-collapsed'), rows: document.querySelectorAll('.chat-queue-item').length, editing: window.__ci._editingQueueId, cancel: !!document.querySelector('[data-queue-op="edit-cancel"]'), marker: row?.dataset.queueEditing || null, hint: !!document.querySelector('.chat-queue-editing'), box: document.querySelector('textarea').value };
        })()`);
        ok(`finding 2: a 9th item arriving during an open edit does NOT collapse the mode's own controls away (${JSON.stringify(arrived)})`,
          arrived.collapsed === false && arrived.rows === 9 && arrived.marker === '1' && arrived.cancel === true && arrived.hint === true && arrived.editing === 'q2' && arrived.box === 'item 2');
        // THE ONE COLLAPSE THE GUARD LEAVES ALONE — the user's own chevron —
        // must still leave the mode finishable BY POINTER: the ✕ moves onto
        // the always-drawn hint line, and clicking it really ends the edit.
        const chevron = await evaljs(`(() => {
          document.querySelector('.chat-queue-toggle').click();
          const cancel = document.querySelector('[data-queue-op="edit-cancel"]');
          return { collapsed: document.querySelector('.chat-queue-strip').classList.contains('chat-queue-collapsed'), rows: document.querySelectorAll('.chat-queue-item').length, hint: !!document.querySelector('.chat-queue-editing'), cancelInHint: !!document.querySelector('.chat-queue-editing [data-queue-op="edit-cancel"]'), cancelId: cancel?.dataset.queueId || null, editing: window.__ci._editingQueueId };
        })()`);
        ok(`the user's own chevron still collapses the strip while editing (${JSON.stringify(chevron)})`, chevron.collapsed === true && chevron.rows === 0 && chevron.editing === 'q2');
        ok('…and the ✕ that ends the edit rides the hint line, naming the row being edited', chevron.hint === true && chevron.cancelInHint === true && chevron.cancelId === 'q2');
        const ended = await evaljs(`(() => {
          document.querySelector('.chat-queue-editing [data-queue-op="edit-cancel"]').click();
          const out = { editing: window.__ci._editingQueueId, box: document.querySelector('textarea').value, ops: window.__ops.length, hint: !!document.querySelector('.chat-queue-editing') };
          window.__ci._queueCollapsed = undefined;
          document.querySelector('textarea').value = '';
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`…and it really ends the edit, restoring the borrowed draft and sending no frame (${JSON.stringify(ended)})`, ended.editing === null && ended.box === 'a draft I was typing' && ended.ops === 0 && ended.hint === false);

        // THE GUARD'S SCOPE, pinned from BOTH sides. It is deliberately
        // `_queueDrag || _editingQueueId` and NOT "anything edit-shaped": a
        // save already IN FLIGHT (`_pendingEdit` — `_send` closed the mode when
        // it dispatched) owns no control the user has to reach, it answers by
        // itself, so master's auto collapse still fires there; and when the
        // answer is the NORMAL refusal the row goes back INTO edit mode, whose
        // render re-expands the strip — so the narrow guard strands nobody,
        // while widening it would hold the strip open for up to 20 s on an
        // arrival the user never caused.
        const inFlight = await evaljs(`(() => {
          window.__ops = [];
          window.__ci._queueCollapsed = undefined;
          window.__ci.setDisconnected(false);
          window.__ci.setQueue(window.__items8, ${CODEX_VERBS});
          const ta = document.querySelector('textarea');
          ta.value = 'a draft I was typing';
          VS.saveDraft('chat', 'sess-verbs', 'a draft I was typing');
          document.querySelector('[data-queue-op="edit"][data-queue-id="q2"]').click();
          ta.value = 'item 2, rewritten';
          window.__ci._send();                                     // the MODE closes here; the save is on the wire
          const armed = { editing: window.__ci._editingQueueId, pending: !!window.__ci._pendingEdit, state: document.querySelector('[data-queue-id="q2"]')?.dataset.queueState || null };
          window.__ci.setQueue(window.__items9, ${CODEX_VERBS});   // …and the 9th item arrives, with no user action
          return { armed, ops: window.__ops.map((f) => f.op), collapsed: document.querySelector('.chat-queue-strip').classList.contains('chat-queue-collapsed'), rows: document.querySelectorAll('.chat-queue-item').length, box: ta.value };
        })()`);
        ok(`a saved edit is IN FLIGHT and its MODE is already closed (${JSON.stringify(inFlight.armed)}, ops ${JSON.stringify(inFlight.ops)})`,
          inFlight.armed.editing === null && inFlight.armed.pending === true && inFlight.armed.state === 'pending' && inFlight.ops.join() === 'edit');
        ok(`negative control for the guard's SCOPE: there the 9th item still auto-collapses — only the collapse a LIVE mode would lose its controls to is suppressed (${JSON.stringify({ collapsed: inFlight.collapsed, rows: inFlight.rows })})`,
          inFlight.collapsed === true && inFlight.rows === 0 && inFlight.box === 'item 2, rewritten');
        const answered = await evaljs(`(() => {
          window.__ci.setQueueOpResult('q2', false, 'The agent could not be reached.');
          const row = document.querySelector('[data-queue-id="q2"]');
          const out = { collapsed: document.querySelector('.chat-queue-strip').classList.contains('chat-queue-collapsed'), rows: document.querySelectorAll('.chat-queue-item').length, editing: window.__ci._editingQueueId, cancel: !!document.querySelector('[data-queue-op="edit-cancel"]'), marker: row?.dataset.queueEditing || null, state: row?.dataset.queueState || null, box: document.querySelector('textarea').value };
          document.querySelector('[data-queue-op="edit-cancel"]')?.click();
          window.__ci._queueCollapsed = undefined;
          document.querySelector('textarea').value = '';
          VS.saveDraft('chat', 'sess-verbs', '');
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`…and the refusal that hands the rewrite back re-OPENS the mode, which re-expands the strip: nobody is stranded by the narrow guard (${JSON.stringify(answered)})`,
          answered.editing === 'q2' && answered.collapsed === false && answered.rows === 9 && answered.cancel === true && answered.marker === '1' && answered.state === 'refused' && answered.box === 'item 2, rewritten');
      }
      // A PRESS THAT DOES NOT MOVE IS NOT A DRAG (a no-op reorder still costs
      // an RPC, a republish and a pending flash).
      {
        await evaljs('window.__ops = []; window.__ci.setQueue(window.__items, ' + CODEX_VERBS + ');');
        const from = await gripBox(0);
        await cdp('Input.dispatchMouseEvent',  { type: 'mousePressed',  x: from.x, y: from.y, button: 'left',  clickCount: 1, pointerType: 'mouse' });
        await cdp('Input.dispatchMouseEvent',  { type: 'mouseMoved',  x: from.x, y: from.y + 1, button: 'left',  pointerType: 'mouse' });
        await cdp('Input.dispatchMouseEvent',  { type: 'mouseReleased',  x: from.x, y: from.y + 1, button: 'left',  clickCount: 1, pointerType: 'mouse' });
        await sleep(120);
        ok('a press that never moves sends nothing', (await ops()).length === 0);
        // …and the per-drag listeners really are gone (a per-render controller
        // would have torn them down MID-drag; a leaked one moves rows later).
        const leaked = await evaljs(`(() => { const before = window.__ops.length; document.dispatchEvent(new PointerEvent('pointermove',  { clientY: 9999 })); return window.__ops.length - before; })()`);
        ok('and no listener survives the release', leaked === 0);
      }
      // KEYBOARD: Alt+Down on a focused row is the same relative frame.
      {
        await evaljs('window.__ops = []; window.__ci.setQueue(window.__items, ' + CODEX_VERBS + ');');
        const moved = await evaljs(`(() => {
          const row = document.querySelectorAll('.chat-queue-item')[0];
          row.focus();
          row.dispatchEvent(new KeyboardEvent('keydown',  { key: 'ArrowDown',  altKey: true, bubbles: true }));
          return window.__ops;
        })()`);
        ok(`Alt+Down on a focused row sends the SAME relative frame as the drag (${JSON.stringify(moved)})`, moved.length === 1 && moved[0].op === 'reorder' && moved[0].id === 'q1' && moved[0].extra?.afterId === 'q2');
        const up = await evaljs(`(() => {
          window.__ops = [];
          const row = document.querySelectorAll('.chat-queue-item')[1];
          row.focus();
          row.dispatchEvent(new KeyboardEvent('keydown',  { key: 'ArrowUp',  altKey: true, bubbles: true }));
          return window.__ops;
        })()`);
        ok(`Alt+Up moves the second row to the FRONT (${JSON.stringify(up)})`, up.length === 1 && up[0].id === 'q2' && up[0].extra?.afterId === null);
        const edge = await evaljs(`(() => {
          window.__ops = [];
          const row = document.querySelectorAll('.chat-queue-item')[0];
          row.focus();
          row.dispatchEvent(new KeyboardEvent('keydown',  { key: 'ArrowUp',  altKey: true, bubbles: true }));
          return window.__ops;
        })()`);
        ok('and the first row cannot move above itself', edge.length === 0);
      }
      // EDIT: open → the FULL text lands in the textarea → send saves it.
      {
        const opened = await evaljs(`(() => {
          window.__ops = [];
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          document.querySelector('.chat-input-area textarea, textarea').value = 'a draft I was typing';
          const wasState = document.querySelector('[data-queue-id="q2"]')?.dataset.queueState || null;
          document.querySelector('[data-queue-op="edit"][data-queue-id="q2"]').click();
          const ta = document.querySelector('textarea');
          const row = document.querySelector('[data-queue-id="q2"]');
          return { text: ta.value, ops: window.__ops.length, wasState, state: row?.dataset.queueState || null, mark: row?.dataset.queueEditing || null, cancel: !!document.querySelector('[data-queue-op="edit-cancel"][data-queue-id="q2"]'), hint: !!document.querySelector('.chat-queue-editing') };
        })()`);
        ok(`the edit control OPENS the queued text (no frame yet — editing is a local mode): ${JSON.stringify(opened)}`, opened.text === 'second' && opened.ops === 0);
        // …and edit mode is its OWN mark (round-4): opening an editor is not an
        // op, so the marker/cancel/hint appear WITHOUT the row's op state
        // moving at all — here it still carries the mark the reorder above
        // left on it, and the two coexist.
        ok('the row says it is being edited, and the strip says how to finish', opened.mark === '1' && opened.cancel === true && opened.hint === true);
        ok(`…and opening it left the row's OP state exactly as it was (${JSON.stringify({ was: opened.wasState, now: opened.state })})`, opened.state === opened.wasState);
        const saved = await evaljs(`(() => {
          const ta = document.querySelector('textarea');
          ta.value = 'second, rewritten';
          window.__ci._send();
          return { ops: window.__ops, text: ta.value, state: document.querySelector('[data-queue-id="q2"]')?.dataset.queueState };
        })()`);
        ok(`sending SAVES the edit as an edit frame, never as a new message (${JSON.stringify(saved.ops)})`, saved.ops.length === 1 && saved.ops[0].op === 'edit' && saved.ops[0].id === 'q2' && saved.ops[0].extra?.text === 'second, rewritten');
        // ROUND-2 MAJOR (finding 1): the rewrite used to be thrown away HERE —
        // the draft was restored before the frame was even sent, and nothing
        // held the typed text when the answer came back ok:false. It now stays
        // in the box (and in `_pendingEdit`) until the result proves it landed.
        ok(`the typed rewrite STAYS in the box while the save is unanswered (${JSON.stringify(saved.text)})`, saved.text === 'second, rewritten');
        ok('the row shows the save is in flight', saved.state === 'pending');
        const okd = await evaljs(`(() => {
          window.__ci.setQueueOpResult('q2',  true, '');
          return { text: document.querySelector('textarea').value, state: document.querySelector('[data-queue-id="q2"]')?.dataset.queueState || null, pending: !!window.__ci._pendingEdit };
        })()`);
        ok(`…and ONLY the ok result puts the borrowed draft back (${JSON.stringify(okd)})`, okd.text === 'a draft I was typing' && okd.state === null && okd.pending === false);
        // A REFUSAL WHOSE ROW IS STILL QUEUED: the rewrite is handed back INTO
        // edit mode (Send retries, Esc restores the draft), with the reason on
        // the row — nothing the user typed is spent on the refusal.
        const refusedLive = await evaljs(`(() => {
          window.__ops = [];
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'first, rewritten';
          window.__ci._send();
          window.__ci.setQueueOpResult('q1',  false, 'The agent could not be reached.');
          const row = document.querySelector('[data-queue-id="q1"]');
          return { text: ta.value, state: row?.dataset.queueState, mark: row?.dataset.queueEditing || null, title: row?.getAttribute('title'), editing: window.__ci._editingQueueId };
        })()`);
        ok(`A REFUSED EDIT KEEPS THE REWRITE (${JSON.stringify(refusedLive)})`, refusedLive.text === 'first, rewritten');
        ok('…and, the row still being queued, puts the user back in edit mode with the reason on it', refusedLive.mark === '1' && refusedLive.state === 'refused' && refusedLive.editing === 'q1' && /could not be reached/.test(refusedLive.title || ''));
        await evaljs(`(() => { document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',  { key: 'Escape',  bubbles: true })); })()`);
        // …and THE NORMAL RACE: the item ran while you were typing, so the row
        // is GONE. The republish is the answer, the text becomes the draft, and
        // a toast says where it went (finding your own words in the input with
        // no explanation is the silent failure wearing a full textarea).
        const refusedGone = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q2"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'second, rewritten again';
          window.__ci._send();
          window.__ci.setQueue([window.__items[0], window.__items[2]], ${CODEX_VERBS});
          return { text: ta.value, pending: !!window.__ci._pendingEdit, toast: document.getElementById('global-toasts')?.textContent || '' };
        })()`);
        ok(`…and a rewrite whose ROW LEFT THE QUEUE survives too (${JSON.stringify(refusedGone.text)})`, refusedGone.text === 'second, rewritten again' && refusedGone.pending === false);
        ok(`…with a toast saying where the text went (${JSON.stringify(refusedGone.toast.slice(0, 90))})`, /kept in the input/.test(refusedGone.toast));
        await evaljs(`(() => { document.querySelector('textarea').value = 'a draft I was typing'; window.__ci.setQueue(window.__items, ${CODEX_VERBS}); })()`);
        // …and a refusal ends the pending state ON THE ROW, with the reason.
        // A BATCH verb marks EVERY row pending; its id-less result must end
        // that — a strip left spinning is the failure the state exists to show.
        const batch = await evaljs(`(() => {
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          document.querySelector('[data-queue-op="run-all"]').click();
          const during = [...document.querySelectorAll('.chat-queue-item')].map((r) => r.dataset.queueState || null);
          window.__ci.setQueueOpResult('',  false, 'A turn is already running.');
          const after = [...document.querySelectorAll('.chat-queue-item')].map((r) => r.dataset.queueState || null);
          return { during, after, op: window.__ops.slice(-1)[0] };
        })()`);
        ok(`"Run all now" marks every row pending and sends the id-less verb (${JSON.stringify(batch.op)})`,  batch.during.every((x) => x === 'pending') && batch.op.op === 'run-all' && batch.op.id === null, batch);
        ok('…and its result — which names no item — ends the pending state of ALL of them',  batch.after.every((x) => x === null), batch.after);
        const refused = await evaljs(`(() => {
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          window.__ci.setQueueOpResult('q2',  false, 'That message was sent by another agent.');
          const row = document.querySelector('[data-queue-id="q2"]');
          return { state: row?.dataset.queueState, title: row?.getAttribute('title') };
        })()`);
        ok(`a refusal marks the row and KEEPS the reason on it (${JSON.stringify(refused)})`, refused.state === 'refused' && /another agent/.test(refused.title || ''));
        // Esc puts everything back.
        const escaped = await evaljs(`(() => {
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          const ta = document.querySelector('textarea');
          ta.value = 'my draft';
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const during = ta.value;
          ta.dispatchEvent(new KeyboardEvent('keydown',  { key: 'Escape',  bubbles: true }));
          return { during, after: ta.value, state: document.querySelector('[data-queue-id="q1"]')?.dataset.queueState || null };
        })()`);
        ok(`Esc cancels the edit and restores the draft (${JSON.stringify(escaped)})`, escaped.during === 'first' && escaped.after === 'my draft' && escaped.state === null);
      }
      // ── ROUND-2 VERIFIER, finding 3 (client half): the row is marked pending
      // BEFORE the frame is dispatched, and two live paths send NOTHING — the
      // view's liveness choke point (disconnected / read-only) and a ws-layer
      // refusal. Neither produces a result, and the republish does not clear a
      // row that never left the queue, so one click left a spinner forever.
      {
        const undone = await evaljs(`(() => {
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          const prev = window.__ci._onQueueOp;
          window.__ci._onQueueOp = () => false;      // _sendQueueOp refused: nothing went out
          document.querySelector('[data-queue-op="run-now"][data-queue-id="q1"]').click();
          const after = document.querySelector('[data-queue-id="q1"]')?.dataset.queueState || null;
          window.__ci._onQueueOp = prev;
          document.querySelector('[data-queue-op="run-now"][data-queue-id="q1"]').click();
          const sentToo = document.querySelector('[data-queue-id="q1"]')?.dataset.queueState || null;
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return { after, sentToo };
        })()`);
        ok(`finding 3: a dispatch that sends NOTHING undoes its own pending mark (${JSON.stringify(undone)})`, undone.after === null);
        ok('…and the positive control still marks the row (the state only lies when nothing was sent)', undone.sentToo === 'pending');
        const batchUndone = await evaljs(`(() => {
          const prev = window.__ci._onQueueOp;
          window.__ci._onQueueOp = () => false;
          document.querySelector('[data-queue-op="run-all"]').click();
          const states = [...document.querySelectorAll('.chat-queue-item')].map((r) => r.dataset.queueState || null);
          window.__ci._onQueueOp = prev;
          return states;
        })()`);
        ok(`…including the batch verb, which marked EVERY row (${JSON.stringify(batchUndone)})`, batchUndone.every((x) => x === null));
        const editUndone = await evaljs(`(() => {
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          document.querySelector('textarea').value = 'a draft I was typing';
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'never left the client';
          const prev = window.__ci._onQueueOp;
          window.__ci._onQueueOp = () => false;
          window.__ci._send();
          window.__ci._onQueueOp = prev;
          const out = { text: ta.value, editing: window.__ci._editingQueueId, pending: !!window.__ci._pendingEdit, state: document.querySelector('[data-queue-id="q1"]')?.dataset.queueState || null, mark: !!document.querySelector('[data-queue-id="q1"][data-queue-editing]') };
          ta.dispatchEvent(new KeyboardEvent('keydown',  { key: 'Escape',  bubbles: true }));
          return out;
        })()`);
        ok(`…and an edit that never left the client puts the user straight back in edit mode with the text (${JSON.stringify(editUndone)})`, editUndone.text === 'never left the client' && editUndone.editing === 'q1' && editUndone.pending === false && editUndone.state === null && editUndone.mark === true);
      }
      // ── ROUND-2 VERIFIER, finding 5: EDIT MODE BORROWS THE TEXTAREA, NOT THE
      // DRAFT CHANNEL. Typing a rewrite used to persist the QUEUED MESSAGE as
      // this session's draft (and sync it to every other client), while this
      // box went back to showing the real draft; the reverse bit too — an
      // incoming draft sync overwrote the rewrite mid-edit.
      {
        const drafts = await evaljs(`(() => {
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          const ta = document.querySelector('textarea');
          ta.value = 'my real draft';
          ta.dispatchEvent(new Event('input',  { bubbles: true }));
          const normal = window.__ci._draftTimer !== null;              // the ordinary path DOES save
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          ta.value = 'first, being rewritten';
          ta.dispatchEvent(new Event('input',  { bubbles: true }));
          const whileEditing = window.__ci._draftTimer;                 // …and edit mode does NOT
          // an incoming draft sync from ANOTHER client must not touch the rewrite
          window.__ci._draftSyncHandler('a draft from another client');
          const kept = ta.value, stashed = window.__ci._editDraftBefore;
          ta.dispatchEvent(new KeyboardEvent('keydown',  { key: 'Escape',  bubbles: true }));
          return { normal, whileEditing, kept, stashed, afterEsc: ta.value };
        })()`);
        ok(`finding 5: the debounced draft save is armed normally and SKIPPED while editing a queued message (${JSON.stringify({ normal: drafts.normal, whileEditing: drafts.whileEditing })})`, drafts.normal === true && drafts.whileEditing === null);
        // …and the OTHER door into the same leak: a debounce armed by the last
        // keystroke BEFORE the pencil was clicked would fire ~300ms later and
        // read the textarea after the queued message landed in it.
        const armedBefore = await evaljs(`(() => {
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          const ta = document.querySelector('textarea');
          ta.value = 'still typing my draft';
          ta.dispatchEvent(new Event('input',  { bubbles: true }));   // 300ms autosave armed
          const armed = window.__ci._draftTimer !== null;
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const out = { armed, afterOpen: window.__ci._draftTimer, stashed: window.__ci._editDraftBefore, box: ta.value };
          ta.dispatchEvent(new KeyboardEvent('keydown',  { key: 'Escape',  bubbles: true }));
          return out;
        })()`);
        ok(`…and opening the editor DISARMS the autosave the last keystroke armed (${JSON.stringify(armedBefore)})`, armedBefore.armed === true && armedBefore.afterOpen === null && armedBefore.stashed === 'still typing my draft' && armedBefore.box === 'first');
        ok(`…and another client's draft sync lands on the STASHED draft, never on the rewrite (${JSON.stringify(drafts)})`, drafts.kept === 'first, being rewritten' && drafts.stashed === 'a draft from another client' && drafts.afterEsc === 'a draft from another client');
      }
      // ── ROUND-3 VERIFIER, finding 1: THE GUARD COMPARED THE WRONG STRING.
      // `_send` trims before it dispatches, and `_pendingEdit` stored only the
      // TRIMMED payload, while _resolvePendingEdit compared it against the RAW
      // textarea. Any rewrite ending in a space or a newline — i.e. every
      // multi-line one — therefore took the "the user typed something else"
      // early return on EVERY outcome, silently disarming the round-2 MAJOR
      // fix and resurrecting the round-1 spinner. The pending state now
      // carries `raw` (what is in the BOX) and only that may be compared.
      {
        const setup = (draft) => `(() => {
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          window.__ci._pendingSend = null;
          window.__ci.setDisconnected(false);
          document.getElementById('global-toasts')?.replaceChildren();
          window.__ops = []; window.__sent = [];
          const ta = document.querySelector('textarea');
          ta.value = ${JSON.stringify(String(draft))};
          VS.saveDraft('chat', 'sess-verbs', ${JSON.stringify(String(draft))});
          return true;
        })()`;
        const rowState = (id) => `(document.querySelector('[data-queue-id="` + id + `"]')?.dataset.queueState || null)`;

        // (a) THE OK OUTCOME. The measured consequence of the bail-out was not
        // just "the draft did not come back": the rewrite stayed in the box, so
        // the NEXT Send posted the queued message a second time as a new chat
        // message, and the real draft was gone forever.
        await evaljs(setup('my real draft'));
        const okNl = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'line one\\nline two\\n';
          window.__ci._send();
          const frame = window.__ops[0];
          window.__ci.setQueueOpResult('q1', true, '');
          const afterOk = { box: ta.value, pending: !!window.__ci._pendingEdit, state: ` + rowState('q1') + ` };
          window.__ci._send();                       // the very next Send
          return { frame, afterOk, sent: window.__sent.map((f) => f.text), draft: VS.loadDraft('chat', 'sess-verbs') };
        })()`);
        ok(`a multi-line rewrite still goes on the wire TRIMMED (the payload was never the bug): ${JSON.stringify(okNl.frame)}`, okNl.frame?.op === 'edit' && okNl.frame?.extra?.text === 'line one\nline two');
        ok(`finding 1(a): the ok result puts the pre-edit draft back even when the rewrite ended in a newline (${JSON.stringify(okNl.afterOk)})`, okNl.afterOk.box === 'my real draft' && okNl.afterOk.pending === false && okNl.afterOk.state === null);
        ok(`…so the queued message is NOT posted a second time as a new chat message (${JSON.stringify(okNl.sent)})`, okNl.sent.length === 1 && okNl.sent[0] === 'my real draft');

        // (b) REFUSED, ROW STILL QUEUED ⇒ straight back into edit mode.
        await evaljs(setup('my real draft'));
        const refusedWs = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'rewrite trailing space ';
          window.__ci._send();
          window.__ci.setQueueOpResult('q1', false, 'The agent could not be reached.');
          const out = { box: ta.value, editing: window.__ci._editingQueueId, state: ` + rowState('q1') + `, title: document.querySelector('[data-queue-id="q1"]')?.getAttribute('title') || '', mark: !!document.querySelector('[data-queue-id="q1"][data-queue-editing]'), hint: !!document.querySelector('.chat-queue-editing') };
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return out;
        })()`);
        ok(`finding 1(b): a refusal of a rewrite ending in a SPACE still hands it back into edit mode (${JSON.stringify(refusedWs)})`, refusedWs.box === 'rewrite trailing space ' && refusedWs.editing === 'q1' && /could not be reached/.test(refusedWs.title));
        ok(`…and the row shows BOTH facts — the refusal AND that the edit is open again (round-4) (${JSON.stringify({ state: refusedWs.state, mark: refusedWs.mark, hint: refusedWs.hint })})`, refusedWs.state === 'refused' && refusedWs.mark === true && refusedWs.hint === true);

        // (c) THE ROW IS GONE ⇒ draft + toast. Without the fix the rewrite
        // lived only in a volatile textarea: closing the window lost it.
        await evaljs(setup('my real draft'));
        const goneWs = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q2"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'gone-row rewrite\\n';
          window.__ci._send();
          window.__ci.setQueue([window.__items[0], window.__items[2]], ${CODEX_VERBS});
          const out = { box: ta.value, draft: VS.loadDraft('chat', 'sess-verbs'), toast: document.getElementById('global-toasts')?.textContent || '', pending: !!window.__ci._pendingEdit };
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`finding 1(c): a rewrite ending in a newline whose ROW LEFT THE QUEUE is persisted as the draft, not just left in a volatile box (${JSON.stringify(goneWs)})`, goneWs.box === 'gone-row rewrite\n' && goneWs.draft === 'gone-row rewrite\n' && /kept in the input/.test(goneWs.toast) && goneWs.pending === false);

        // (d) THE SPINNER. The socket-death and 20s paths write no row state
        // at all, so a bail-out left the row 'pending' with no result ever
        // coming — the round-1 finding-3 lie, resurrected by the skew.
        await evaljs(setup('my real draft'));
        const deadSock = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'disconnected rewrite\\n';
          window.__ci._send();
          const during = ` + rowState('q1') + `;
          window.__ci.setDisconnected(true);
          window.__ci.setDisconnected(false);
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});     // the reconnect republish
          const out = { during, after: ` + rowState('q1') + `, box: ta.value, editing: window.__ci._editingQueueId, pending: !!window.__ci._pendingEdit };
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return out;
        })()`);
        ok(`finding 1(d): a dead socket ENDS the row's pending state for a whitespace-carrying rewrite too — no exit from _resolvePendingEdit may leave a spinner (${JSON.stringify(deadSock)})`, deadSock.during === 'pending' && deadSock.after !== 'pending' && deadSock.pending === false && deadSock.box === 'disconnected rewrite\n' && deadSock.editing === 'q1');

        // NEGATIVE CONTROL for (a)–(d): the guard is not simply gone. A user
        // who really did type something ELSE keeps their words — and the row
        // still stops spinning.
        await evaljs(setup('my real draft'));
        const changedMind = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'rewrite\\n';
          window.__ci._send();
          ta.value = 'I changed my mind entirely';        // the user typed something ELSE
          window.__ci.setDisconnected(true);
          window.__ci.setDisconnected(false);
          const out = { box: ta.value, state: ` + rowState('q1') + `, editing: window.__ci._editingQueueId, pending: !!window.__ci._pendingEdit };
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`negative control: text the user typed AFTER the send is never overwritten by either outcome (${JSON.stringify(changedMind)})`, changedMind.box === 'I changed my mind entirely' && changedMind.editing === null && changedMind.pending === false);
        ok('…and that bail-out ALSO ends the row state (the guard may protect the text, never the spinner)', changedMind.state !== 'pending', changedMind);

        // ── ROUND-3 VERIFIER, finding 2: THE SAME RACE, BEFORE SEND. The row
        // being edited leaving the queue while the user is still TYPING went
        // through `_cancelQueueEdit({silent:true})`, which overwrites the
        // textarea with the pre-edit draft — no save, no toast, the words are
        // simply gone. This window (seconds of typing) is far larger than the
        // post-Send one finding 1 covers.
        await evaljs(setup('my real draft'));
        const typingLost = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'ten seconds of typing that must not vanish';    // NOT sent
          window.__ci.setQueue([window.__items[1], window.__items[2]], ${CODEX_VERBS});
          const out = { box: ta.value, draft: VS.loadDraft('chat', 'sess-verbs'), toast: document.getElementById('global-toasts')?.textContent || '', editing: window.__ci._editingQueueId };
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`finding 2: a republish that DRAINS the row being edited keeps the in-progress rewrite (${JSON.stringify(typingLost.box)})`, typingLost.box === 'ten seconds of typing that must not vanish' && typingLost.editing === null);
        ok(`…persists it as the draft and says where it went (${JSON.stringify({ draft: typingLost.draft, toast: typingLost.toast.slice(0, 80) })})`, typingLost.draft === 'ten seconds of typing that must not vanish' && /kept in the input/.test(typingLost.toast));

        // NEGATIVE CONTROL 1: an UNTOUCHED editor is not a rewrite — the row
        // vanishing there restores the pre-edit draft silently, exactly as
        // before (a toast for every drained queue would be noise).
        await evaljs(setup('my real draft'));
        const untouched = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const opened = document.querySelector('textarea').value;
          window.__ci.setQueue([window.__items[1], window.__items[2]], ${CODEX_VERBS});
          const out = { opened, box: document.querySelector('textarea').value, draft: VS.loadDraft('chat', 'sess-verbs'), toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`negative control: an untouched editor whose row is drained restores the pre-edit draft, silently (${JSON.stringify(untouched)})`, untouched.opened === 'first' && untouched.box === 'my real draft' && untouched.draft === 'my real draft' && untouched.toast === '');

        // NEGATIVE CONTROL 2: a republish that KEEPS the edited row must not
        // touch the edit at all (peer messages republish constantly).
        await evaljs(setup('my real draft'));
        const kept = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'still rewriting';
          window.__ci.setQueue([window.__items[0], window.__items[2], { id: 'q9', msgId: '', preview: 'a peer just queued this', kind: 'peer', from: 'session C' }], ${CODEX_VERBS});
          const out = { box: ta.value, editing: window.__ci._editingQueueId, toast: document.getElementById('global-toasts')?.textContent || '' };
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`negative control: a republish that keeps the edited row changes nothing (${JSON.stringify(kept)})`, kept.box === 'still rewriting' && kept.editing === 'q1' && kept.toast === '');

        // NEGATIVE CONTROL 3: the USER abandoning the edit (Esc) is still the
        // plain restore — the fix must not turn every cancel into a toast.
        await evaljs(setup('my real draft'));
        const escRewrite = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'a rewrite the user themself abandons';
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return { box: ta.value, draft: VS.loadDraft('chat', 'sess-verbs'), toast: document.getElementById('global-toasts')?.textContent || '' };
        })()`);
        ok(`negative control: Esc still restores the draft over a rewrite, with no toast (${JSON.stringify(escRewrite)})`, escRewrite.box === 'my real draft' && escRewrite.draft === 'my real draft' && escRewrite.toast === '');

        // ── THE SAME CLASS, TWO PATHS THE TWO FINDINGS LEFT OPEN. Both are
        // "typed words exist ONLY in a textarea": law ② switches the debounced
        // autosave OFF for the whole edit, so the "your draft is already saved"
        // that covers ordinary typing does not hold here.
        // (i) THE BAIL-OUT ITSELF. The guard that protects text the user typed
        // AFTER the send returns without persisting it — the store still holds
        // the pre-edit draft, so that text died with the window.
        await evaljs(setup('my real draft'));
        const bailDraft = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'rewrite\\n';
          window.__ci._send();
          ta.value = 'the words I typed while it was saving';
          window.__ci.setQueueOpResult('q1', true, '');
          const out = { box: ta.value, draft: VS.loadDraft('chat', 'sess-verbs'), pending: !!window.__ci._pendingEdit };
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`the bail-out PERSISTS the text it protects — the edit is over, so the draft channel belongs to the box again (${JSON.stringify(bailDraft)})`, bailDraft.box === 'the words I typed while it was saving' && bailDraft.draft === 'the words I typed while it was saving' && bailDraft.pending === false);

        // NEGATIVE CONTROL: the ordinary ok outcome must NOT push the rewrite
        // into the draft store — the pre-edit draft is what comes back, in the
        // box AND in the store (law ②: edit mode borrows the textarea only).
        await evaljs(setup('my real draft'));
        const okDraft = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'first, rewritten once more\\n';
          window.__ci._send();
          window.__ci.setQueueOpResult('q1', true, '');
          const out = { box: ta.value, draft: VS.loadDraft('chat', 'sess-verbs') };
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`negative control: a save that LANDED leaves the pre-edit draft in the store, never the rewrite (${JSON.stringify(okDraft)})`, okDraft.box === 'my real draft' && okDraft.draft === 'my real draft');

        // (ii) THE VIEW TORN DOWN MID-EDIT (window closed, tab swapped, view
        // replaced). Its own ChatInput on its own session id, so disposing it
        // cannot disturb the rest of this suite.
        const disposeCase = await evaljs(`(() => {
          const mk = (sid) => {
            const ci = new VS.ChatInput({ send(){} }, sid, { onSend(){}, onInterrupt(){}, onQueueOp: () => true });
            document.body.appendChild(ci.element);
            ci.setQueue([{ id: 'd1', msgId: 'md1', preview: 'queued', text: 'the queued message', kind: 'user' }], ${CODEX_VERBS});
            const ta = ci.element.querySelector('textarea');
            ta.value = 'the draft I had';
            VS.saveDraft('chat', sid, 'the draft I had');
            return { ci, ta };
          };
          const out = {};
          // typed, never sent ⇒ the words are kept
          { const { ci, ta } = mk('sess-dispose-a');
            ci.element.querySelector('[data-queue-op="edit"][data-queue-id="d1"]').click();
            ta.value = 'a rewrite the closing window must not eat';
            ci.dispose(); ci.element.remove();
            out.typed = VS.loadDraft('chat', 'sess-dispose-a'); }
          // NEGATIVE CONTROL 1: an untouched editor is not a rewrite
          { const { ci } = mk('sess-dispose-b');
            ci.element.querySelector('[data-queue-op="edit"][data-queue-id="d1"]').click();
            ci.dispose(); ci.element.remove();
            out.untouched = VS.loadDraft('chat', 'sess-dispose-b'); }
          // NEGATIVE CONTROL 2: the frame is already OUT and the box still holds
          // exactly it ⇒ the text is on its way into the queued message;
          // stashing a copy would leave the user their own queue item as a draft.
          { const { ci, ta } = mk('sess-dispose-c');
            ci.element.querySelector('[data-queue-op="edit"][data-queue-id="d1"]').click();
            ta.value = 'a rewrite already on the wire';
            ci._send();
            out.sentPending = !!ci._pendingEdit;
            ci.dispose(); ci.element.remove();
            out.sent = VS.loadDraft('chat', 'sess-dispose-c'); }
          // ── ROUND-4 VERIFIER, finding 2: THE IN-FLIGHT WINDOW IS THE SAME
          // UNPROTECTED WINDOW. The input listener disarms the autosave for
          // _editingQueueId OR _pendingEdit, so keystrokes typed AFTER Send —
          // for as long as the result takes, up to the 20s fallback — also
          // live only in the textarea; dispose looked at _editingQueueId
          // alone and let them die with the window.
          { const { ci, ta } = mk('sess-dispose-d');
            ci.element.querySelector('[data-queue-op="edit"][data-queue-id="d1"]').click();
            ta.value = 'a rewrite already on the wire';
            ci._send();
            ta.value = 'and the words I kept typing while it saved';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            out.armedWhilePending = ci._draftTimer;      // the premise: still disarmed
            ci.dispose(); ci.element.remove();
            out.inFlight = VS.loadDraft('chat', 'sess-dispose-d'); }
          // NEGATIVE CONTROL (instance-level neuter): the PRE-FIX rule —
          // "stash only while _editingQueueId is set" — loses exactly that text.
          { const { ci, ta } = mk('sess-dispose-e');
            ci.element.querySelector('[data-queue-op="edit"][data-queue-id="d1"]').click();
            ta.value = 'a rewrite already on the wire';
            ci._send();
            ta.value = 'and the words I kept typing while it saved';
            ci._unstashedEditText = function () {
              if (this._editingQueueId && this._textarea) {
                const typed = this._textarea.value;
                if (typed.trim() && typed !== this._editOriginalText) return typed;
              }
              return null;
            };
            ci.dispose(); ci.element.remove();
            out.neuteredInFlight = VS.loadDraft('chat', 'sess-dispose-e'); }
          return out;
        })()`);
        ok(`a view torn down mid-edit keeps the UNSENT rewrite (edit mode holds the autosave off, so nothing else would have) (${JSON.stringify(disposeCase.typed)})`, disposeCase.typed === 'a rewrite the closing window must not eat');
        ok(`negative control: an untouched editor leaves the real draft in the store (${JSON.stringify(disposeCase.untouched)})`, disposeCase.untouched === 'the draft I had');
        ok(`negative control: a rewrite already ON THE WIRE is not stashed as the draft (${JSON.stringify({ pending: disposeCase.sentPending, draft: disposeCase.sent })})`, disposeCase.sentPending === true && disposeCase.sent === 'the draft I had');
        ok(`finding 2 (premise): the debounced autosave stays DISARMED while a save is in flight, so those keystrokes are nowhere but the box (${JSON.stringify(disposeCase.armedWhilePending)})`, disposeCase.armedWhilePending === null);
        ok(`finding 2: a view torn down DURING the in-flight window keeps what the box holds beyond the sent payload (${JSON.stringify(disposeCase.inFlight)})`, disposeCase.inFlight === 'and the words I kept typing while it saved');
        ok(`negative control: the PRE-FIX dispose rule ("only while _editingQueueId is set") loses exactly that text (${JSON.stringify(disposeCase.neuteredInFlight)})`, disposeCase.neuteredInFlight === 'the draft I had');

        // ── ROUND-4 VERIFIER, finding 1: THE EDITING INDICATOR LIVED IN THE
        // TRANSIENT OP STATE. The edit→cancel control, the row's marker and
        // the "send to save, Esc to cancel" hint were all derived from
        // `_queueRowState`, which every dispatch and every result overwrites:
        // a BATCH verb marks EVERY row pending (including the one being
        // edited) and a refusal on that row marks it refused, so the only
        // on-screen sign that the textarea holds a queued message vanished
        // while the rewrite was still in it — and the pencil came back over a
        // live edit. Edit mode is now `_editingQueueId`, rendered
        // independently; a row shows BOTH facts.
        const editMarks = `({
          marker: !!document.querySelector('[data-queue-id="q1"][data-queue-editing]'),
          cancel: !!document.querySelector('[data-queue-op="edit-cancel"][data-queue-id="q1"]'),
          pencil: !!document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]'),
          hint: !!document.querySelector('.chat-queue-editing'),
          state: document.querySelector('[data-queue-id="q1"]')?.dataset.queueState || null,
        })`;
        await evaljs(setup('my real draft'));
        const marks = await evaljs(`(() => {
          const snap = () => (${editMarks});
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'a rewrite that must stay visible as an edit';
          const opened = snap();
          window.__ci.setQueueOpResult('q2', false, 'That message is not yours to rewrite.');
          const otherRefused = snap();
          const otherMarked = document.querySelector('[data-queue-id="q2"]')?.dataset.queueState || null;
          document.querySelector('[data-queue-op="run-all"]').click();      // marks EVERY row
          const batch = snap();
          window.__ci.setQueueOpResult('', false, 'A turn is already running.');
          const batchDone = snap();
          window.__ci.setQueueOpResult('q1', false, 'A turn is already running.');
          const ownRefused = snap();
          const out = { opened, otherRefused, otherMarked, batch, batchDone, ownRefused, box: ta.value, editing: window.__ci._editingQueueId };
          document.querySelector('[data-queue-op="edit-cancel"][data-queue-id="q1"]').click();
          out.afterCancel = { box: ta.value, editing: window.__ci._editingQueueId, marker: !!document.querySelector('[data-queue-editing]'), hint: !!document.querySelector('.chat-queue-editing') };
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        const shows = (m) => m && m.marker === true && m.cancel === true && m.pencil === false && m.hint === true;
        ok(`finding 1: a refusal on ANOTHER row leaves the editing marker, the cancel control and the hint alone (${JSON.stringify(marks.otherRefused)})`, shows(marks.otherRefused) && marks.otherRefused.state === null && marks.otherMarked === 'refused');
        ok(`…a BATCH verb marks every row pending WITHOUT erasing the edit — the row carries both (${JSON.stringify(marks.batch)})`, shows(marks.batch) && marks.batch.state === 'pending');
        ok(`…and so does its result, and a refusal on the EDITED row itself (${JSON.stringify({ batchDone: marks.batchDone, ownRefused: marks.ownRefused })})`, shows(marks.batchDone) && marks.batchDone.state === null && shows(marks.ownRefused) && marks.ownRefused.state === 'refused');
        ok(`…with the rewrite untouched in the box the whole way through (${JSON.stringify({ box: marks.box, editing: marks.editing })})`, marks.box === 'a rewrite that must stay visible as an edit' && marks.editing === 'q1');
        ok(`…and the control the user CAN see still ends the edit (${JSON.stringify(marks.afterCancel)})`, marks.afterCancel.box === 'my real draft' && marks.afterCancel.editing === null && marks.afterCancel.marker === false && marks.afterCancel.hint === false);

        // NEGATIVE CONTROL (instance-level neuter): put the PRE-FIX derivation
        // back — edit mode readable only out of the op state — and the same
        // sequence reproduces the defect, including its damage: the pencil
        // returns and one click replaces the rewrite with the queued message.
        await evaljs(setup('my real draft'));
        const neutered = await evaljs(`(() => {
          const snap = () => (${editMarks});
          const orig = VS.ChatInput.queueStripHtml;
          VS.ChatInput.queueStripHtml = (items, caps, rowState) => {
            let derived = null;
            if (rowState && typeof rowState.forEach === 'function') rowState.forEach((v, k) => { if (v?.state === 'editing') derived = k; });
            return orig(items, caps, rowState, derived);
          };
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          window.__ci._queueRowState.set('q1', { state: 'editing', title: '' });   // what _beginQueueEdit used to write
          const ta = document.querySelector('textarea');
          ta.value = 'a rewrite that must stay visible as an edit';
          window.__ci._renderQueue();
          const opened = snap();
          document.querySelector('[data-queue-op="run-all"]').click();
          const batch = snap();
          if (batch.pencil) document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const damage = ta.value;
          VS.ChatInput.queueStripHtml = orig;
          window.__ci._queueRowState.clear();
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return { opened, batch, damage };
        })()`);
        ok(`negative control: the pre-fix derivation renders the same marker while nothing has touched the row (${JSON.stringify(neutered.opened)})`, shows(neutered.opened));
        ok(`…and LOSES it the moment a batch verb marks the row — the defect, reproduced (${JSON.stringify(neutered.batch)})`, neutered.batch.marker === false && neutered.batch.hint === false && neutered.batch.cancel === false && neutered.batch.pencil === true);
        ok(`…and the pencil it brings back replaces the live rewrite with the queued message (${JSON.stringify(neutered.damage)})`, neutered.damage === 'first');

        // ── ROUND-4 VERIFIER, finding 3: OPENING A SECOND ROW'S EDITOR. The
        // guard called `_cancelQueueEdit({silent:true})`, which restores the
        // pre-edit draft OVER the textarea — the same unrecoverable loss as
        // finding 2 of round 3, through a control the user clicks on purpose.
        await evaljs(setup('my real draft'));
        const switched = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'the rewrite of the FIRST row';
          document.querySelector('[data-queue-op="edit"][data-queue-id="q2"]').click();
          const after = { box: ta.value, editing: window.__ci._editingQueueId, draft: VS.loadDraft('chat', 'sess-verbs'), toast: document.getElementById('global-toasts')?.textContent || '', marker: document.querySelector('[data-queue-editing]')?.dataset.queueId || null };
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          const afterEsc = ta.value;
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return { after, afterEsc };
        })()`);
        ok(`finding 3: switching to another row's editor opens it (${JSON.stringify({ box: switched.after.box, editing: switched.after.editing, marker: switched.after.marker })})`, switched.after.box === 'second' && switched.after.editing === 'q2' && switched.after.marker === 'q2');
        ok(`…and the abandoned rewrite is kept as the draft, out loud (${JSON.stringify({ draft: switched.after.draft, toast: switched.after.toast.slice(0, 80) })})`, switched.after.draft === 'the rewrite of the FIRST row' && /kept as this session/.test(switched.after.toast));
        ok(`…so cancelling the new edit hands it straight back (${JSON.stringify(switched.afterEsc)})`, switched.afterEsc === 'the rewrite of the FIRST row');

        // NEGATIVE CONTROL 1: an UNTOUCHED editor is not a rewrite — switching
        // rows there is the plain silent restore it always was.
        await evaljs(setup('my real draft'));
        const switchClean = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          document.querySelector('[data-queue-op="edit"][data-queue-id="q2"]').click();
          const ta = document.querySelector('textarea');
          const after = { box: ta.value, editing: window.__ci._editingQueueId, draft: VS.loadDraft('chat', 'sess-verbs'), toast: document.getElementById('global-toasts')?.textContent || '' };
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          const afterEsc = ta.value;
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return { after, afterEsc };
        })()`);
        ok(`negative control: switching out of an UNTOUCHED editor is silent and keeps the real draft (${JSON.stringify(switchClean)})`, switchClean.after.box === 'second' && switchClean.after.draft === 'my real draft' && switchClean.after.toast === '' && switchClean.afterEsc === 'my real draft');

        // NEGATIVE CONTROL 2 (instance-level neuter): the pre-fix rule was
        // "always cancel", i.e. `_rewriteInBox()` answering null for everything.
        await evaljs(setup('my real draft'));
        const switchNeutered = await evaljs(`(() => {
          const orig = window.__ci._rewriteInBox;
          window.__ci._rewriteInBox = () => null;
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'the rewrite of the FIRST row';
          document.querySelector('[data-queue-op="edit"][data-queue-id="q2"]').click();
          const out = { box: ta.value, draft: VS.loadDraft('chat', 'sess-verbs'), toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci._rewriteInBox = orig;
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`negative control: the pre-fix "always cancel" destroys the rewrite silently — the defect, reproduced (${JSON.stringify(switchNeutered)})`, switchNeutered.box === 'second' && switchNeutered.draft === 'my real draft' && switchNeutered.toast === '');

        // …and the SIBLING guard is unchanged: while a save is in flight the
        // box is not free, so a second editor is REFUSED (never silently).
        await evaljs(setup('my real draft'));
        const whilePending = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'a rewrite on the wire';
          window.__ci._send();
          document.querySelector('[data-queue-op="edit"][data-queue-id="q2"]').click();
          const out = { box: ta.value, editing: window.__ci._editingQueueId, pending: !!window.__ci._pendingEdit, toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci.setQueueOpResult('q1', true, '');
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`…and a second editor DURING a save is refused out loud, box untouched (${JSON.stringify(whilePending)})`, whilePending.box === 'a rewrite on the wire' && whilePending.editing === null && whilePending.pending === true && /still saving/.test(whilePending.toast));

        // ── ROUND-5 VERIFIER (MAJOR): A PROGRAMMATIC SEND FIRED WHILE AN
        // EDITOR IS OPEN. `sendText` is the path every in-chat action button
        // takes (Compact now, the design request): it wrote its text straight
        // into the textarea and called `_send` — which, in edit mode, SAVES
        // the box as an `edit` op. One click therefore rewrote the queued
        // message to "/compact", never ran the action, and destroyed the
        // rewrite (law ② keeps it out of the draft store for the whole edit,
        // so it lived nowhere else). The guard is the sibling of
        // _beginQueueEdit's: refuse OUT LOUD, touch nothing.
        await evaljs(setup('my real draft'));
        const actionWhileEditing = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'the rewrite I am still typing';
          const answer = window.__ci.sendText('/compact');
          const out = { answer, box: ta.value, editing: window.__ci._editingQueueId, pending: !!window.__ci._pendingEdit,
            ops: window.__ops.map((o) => o.op + ':' + (o.extra?.text ?? '')), sent: window.__sent.map((f) => f.text),
            toast: document.getElementById('global-toasts')?.textContent || '' };
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`round-5: an action fired during an open edit is REFUSED, and says so (${JSON.stringify({ answer: actionWhileEditing.answer, toast: actionWhileEditing.toast.slice(0, 90) })})`,
          actionWhileEditing.answer === false && /Finish or cancel the queued-message edit/.test(actionWhileEditing.toast));
        ok(`…NOTHING went on the wire — no queue-op frame, no chat message (${JSON.stringify({ ops: actionWhileEditing.ops, sent: actionWhileEditing.sent })})`,
          actionWhileEditing.ops.length === 0 && actionWhileEditing.sent.length === 0);
        ok(`…and the box is untouched: the rewrite is still there and the row is still being edited (${JSON.stringify({ box: actionWhileEditing.box, editing: actionWhileEditing.editing })})`,
          actionWhileEditing.box === 'the rewrite I am still typing' && actionWhileEditing.editing === 'q1' && actionWhileEditing.pending === false);

        // …and the OTHER half of "the editor owns the box": the save is already
        // on the wire (`_pendingEdit`). The rewrite is in the box waiting for a
        // result that may hand it back — an action written over it is the same
        // loss with a frame already gone.
        await evaljs(setup('my real draft'));
        const actionWhilePending = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'a rewrite on the wire';
          window.__ci._send();
          const answer = window.__ci.sendText('/compact');
          const out = { answer, box: ta.value, pending: !!window.__ci._pendingEdit,
            ops: window.__ops.map((o) => o.op + ':' + (o.extra?.text ?? '')), sent: window.__sent.map((f) => f.text),
            toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci.setQueueOpResult('q1', true, '');
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`…an action fired while the SAVE is in flight is refused the same way (${JSON.stringify({ answer: actionWhilePending.answer, box: actionWhilePending.box, sent: actionWhilePending.sent })})`,
          actionWhilePending.answer === false && actionWhilePending.box === 'a rewrite on the wire' && actionWhilePending.sent.length === 0 && /Finish or cancel the queued-message edit/.test(actionWhilePending.toast));
        ok(`…and the ONLY frame out is the user's own edit, carrying the user's own words (${JSON.stringify(actionWhilePending.ops)})`,
          actionWhilePending.ops.length === 1 && actionWhilePending.ops[0] === 'edit:a rewrite on the wire');

        // NEGATIVE CONTROL (instance-level neuter): the pre-fix body, verbatim.
        await evaljs(setup('my real draft'));
        const actionNeutered = await evaljs(`(() => {
          window.__ci.sendText = function (text) {           // the pre-fix body
            if (!this._textarea) return;
            this._textarea.value = String(text || '');
            this._send();
          };
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'the rewrite I am still typing';
          window.__ci.sendText('/compact');
          const out = { box: ta.value, editing: window.__ci._editingQueueId, pending: !!window.__ci._pendingEdit,
            ops: window.__ops.map((o) => o.op + ':' + (o.extra?.text ?? '')), sent: window.__sent.map((f) => f.text),
            toast: document.getElementById('global-toasts')?.textContent || '' };
          delete window.__ci.sendText;
          window.__ci.setQueueOpResult('q1', true, '');
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          return out;
        })()`);
        ok(`negative control: the pre-fix sendText turns the ACTION into an edit of the queued message — the defect, reproduced (${JSON.stringify(actionNeutered.ops)})`,
          actionNeutered.ops.length === 1 && actionNeutered.ops[0] === 'edit:/compact');
        ok(`…the action never reaches the agent and the rewrite is gone from the box (${JSON.stringify({ sent: actionNeutered.sent, box: actionNeutered.box, toast: actionNeutered.toast })})`,
          actionNeutered.sent.length === 0 && actionNeutered.box === '/compact' && actionNeutered.toast === '');

        // POSITIVE CONTROL: with NO edit open the action goes out exactly as
        // before — and (same audit) it spends nothing of the user's: a
        // half-typed prompt comes back to the box AND to the draft store,
        // which `_send` had just pinned to the action's own text.
        await evaljs(setup('a half-typed prompt'));
        const actionNormally = await evaljs(`(() => {
          const ta = document.querySelector('textarea');
          const answer = window.__ci.sendText('/compact');
          const out = { answer, box: ta.value, draft: VS.loadDraft('chat', 'sess-verbs'),
            sent: window.__sent.map((f) => f.text), ops: window.__ops.length };
          window.__ci.hideTyping();
          window.__ci._pendingSend = null;
          return out;
        })()`);
        ok(`positive control: with no edit open the action IS sent (${JSON.stringify({ answer: actionNormally.answer, sent: actionNormally.sent, ops: actionNormally.ops })})`,
          actionNormally.answer === true && actionNormally.sent.length === 1 && actionNormally.sent[0] === '/compact' && actionNormally.ops === 0);
        ok(`…and the half-typed prompt it wrote over is handed back to the box AND the draft store (${JSON.stringify({ box: actionNormally.box, draft: actionNormally.draft })})`,
          actionNormally.box === 'a half-typed prompt' && actionNormally.draft === 'a half-typed prompt');

        // A REFUSED send (dead socket) must reach the caller too, or the
        // Compact button disables itself over a send that never happened.
        await evaljs(setup('a half-typed prompt'));
        const actionOffline = await evaljs(`(() => {
          window.__ci.setDisconnected(true);
          const ta = document.querySelector('textarea');
          const answer = window.__ci.sendText('/compact');
          const out = { answer, box: ta.value, sent: window.__sent.map((f) => f.text),
            toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci.setDisconnected(false);
          window.__ci._pendingSend = null;
          return out;
        })()`);
        ok(`…a send REFUSED by a dead socket answers false as well, with the typed prompt back in the box (${JSON.stringify(actionOffline)})`,
          actionOffline.answer === false && actionOffline.sent.length === 0 && actionOffline.box === 'a half-typed prompt' && /Disconnected/.test(actionOffline.toast));

        // THE DRAFT SLOT GOES WITH THE TEXT THAT CAME BACK: `_send` arms
        // `_pendingSend` for the ACTION and `confirmDelivery()` clears the
        // store on the first inbound frame — which would have deleted the
        // user's prompt from the store moments after it was handed back.
        await evaljs(setup('a half-typed prompt'));
        const actionSlot = await evaljs(`(() => {
          window.__ci.sendText('/compact');
          const armed = !!window.__ci._pendingSend;
          window.__ci.confirmDelivery();                 // the server answered
          const out = { armed, draft: VS.loadDraft('chat', 'sess-verbs'), box: document.querySelector('textarea').value };
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          return out;
        })()`);
        ok(`…and the action releases the draft slot, so the delivery echo cannot clear the user's prompt out of the store (${JSON.stringify(actionSlot)})`,
          actionSlot.armed === false && actionSlot.draft === 'a half-typed prompt' && actionSlot.box === 'a half-typed prompt');

        // NEGATIVE CONTROL: leave the slot armed (the pre-fix state) AND put
        // the pre-fix UNCONDITIONAL clear back — since round-6 it takes both
        // neuters to reproduce the loss, which is exactly what the second
        // defence is for.
        await evaljs(setup('a half-typed prompt'));
        const slotNeutered = await evaljs(`(() => {
          window.__ci.confirmDelivery = function () {         // the pre-fix body
            if (!this._pendingSend) return;
            this._pendingSend = null;
            VS.saveDraft('chat', this._sessionId, '');
          };
          window.__ci.sendText('/compact');
          window.__ci._pendingSend = { text: '/compact' };   // as _send left it
          window.__ci.confirmDelivery();
          const out = { draft: VS.loadDraft('chat', 'sess-verbs'), box: document.querySelector('textarea').value };
          delete window.__ci.confirmDelivery;
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          return out;
        })()`);
        ok(`negative control: with the slot still armed AND the pre-fix unconditional clear, the delivery echo takes the draft — the box is the only copy again (${JSON.stringify(slotNeutered)})`,
          slotNeutered.draft === '' && slotNeutered.box === 'a half-typed prompt');

        // …and with only ONE of the two neutered the prompt survives: the
        // text-aware clear is the belt for a slot that legitimately STAYS
        // armed, which is now the normal case (round-6 hands OLDER slots back).
        await evaljs(setup('a half-typed prompt'));
        const slotArmedAware = await evaljs(`(() => {
          window.__ci.sendText('/compact');
          window.__ci._pendingSend = { text: '/compact' };   // as _send left it
          window.__ci.confirmDelivery();                     // …the REAL one
          const out = { draft: VS.loadDraft('chat', 'sess-verbs'), box: document.querySelector('textarea').value };
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          return out;
        })()`);
        ok(`round-6: an armed slot whose text the store no longer holds cannot clear it (${JSON.stringify(slotArmedAware)})`,
          slotArmedAware.draft === 'a half-typed prompt' && slotArmedAware.box === 'a half-typed prompt');

        // POSITIVE CONTROL for the same guard: the deferred clear must still
        // DO its job — an ordinary send whose text the store still holds is
        // cleared by the echo, which is the whole reason the slot exists.
        await evaljs(setup(''));
        const plainClear = await evaljs(`(() => {
          const ta = document.querySelector('textarea');
          ta.value = 'an ordinary message';
          window.__ci._send();
          const before = VS.loadDraft('chat', 'sess-verbs');
          window.__ci.confirmDelivery();
          const out = { before, after: VS.loadDraft('chat', 'sess-verbs'), slot: window.__ci._pendingSend };
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          return out;
        })()`);
        ok(`positive control: the deferred draft clear still fires for an ordinary send (${JSON.stringify(plainClear)})`,
          plainClear.before === 'an ordinary message' && plainClear.after === '' && plainClear.slot === null);

        // …and the user's pending ATTACHMENTS are not folded into the action's
        // frame (`_send` builds an image message whenever any are pending).
        await evaljs(setup(''));
        const actionAttachments = await evaljs(`(() => {
          window.__ci._attachments = [{ base64: 'aGk=', mediaType: 'image/png', dataUrl: 'data:image/png;base64,aGk=', name: 'shot.png' }];
          window.__ci._renderAttachments();
          const answer = window.__ci.sendText('/compact');
          const out = { answer, sent: window.__sent.map((f) => f.text), kept: window.__ci._attachments.length,
            chips: document.querySelectorAll('.chat-attach-item').length };
          window.__ci._attachments = []; window.__ci._renderAttachments();
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          return out;
        })()`);
        ok(`…and pending attachments are NOT spent by the action — it sends a plain text frame (${JSON.stringify(actionAttachments.sent)})`,
          actionAttachments.sent.length === 1 && actionAttachments.sent[0] === '/compact');
        ok(`…and they are still pending afterwards, chip and all (${JSON.stringify({ kept: actionAttachments.kept, chips: actionAttachments.chips })})`,
          actionAttachments.kept === 1 && actionAttachments.chips === 1);

        // ── ROUND-6 VERIFIER (MAJOR): THE WRITER THAT LANDS LATE. The round-5
        // audit enumerated everyone who writes the textarea — and missed the
        // one that does it through a LOCAL alias AFTER an await. An upload
        // started BEFORE the pencil was clicked finishes DURING the edit, and
        // its paths were inserted into the box the queued message owns: Send
        // then saved a rewrite the user never typed. `_stashUploadedPaths`
        // now lands them where that message's own draft lives.
        await evaljs(setup('my real draft'));
        const uploadDuringEdit = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'the rewrite I am still typing';
          window.__ci._insertUploadedPaths('/home/u/proj', [{ name: 'shot.png' }]);   // the upload lands NOW
          const out = { box: ta.value, editing: window.__ci._editingQueueId, stash: window.__ci._editDraftBefore,
            draft: VS.loadDraft('chat', 'sess-verbs'), toast: document.getElementById('global-toasts')?.textContent || '' };
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          out.afterEsc = ta.value;
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`);
        ok(`round-6: an upload landing during an OPEN edit leaves the rewrite alone (${JSON.stringify({ box: uploadDuringEdit.box, editing: uploadDuringEdit.editing })})`,
          uploadDuringEdit.box === 'the rewrite I am still typing' && uploadDuringEdit.editing === 'q1');
        ok(`…the paths go to the stash AND the store, and the toast says so (${JSON.stringify({ stash: uploadDuringEdit.stash, draft: uploadDuringEdit.draft, toast: uploadDuringEdit.toast.slice(0, 60) })})`,
          uploadDuringEdit.stash === 'my real draft /home/u/proj/shot.png ' && uploadDuringEdit.draft === 'my real draft /home/u/proj/shot.png '
          && /went to your draft/.test(uploadDuringEdit.toast));
        ok(`…so cancelling the edit hands the box back WITH them (${JSON.stringify(uploadDuringEdit.afterEsc)})`,
          uploadDuringEdit.afterEsc === 'my real draft /home/u/proj/shot.png ');

        // NEGATIVE CONTROL (instance-level neuter): the pre-fix body writes the
        // box, so the paths end up inside the queued message the next Send
        // saves — the user's rewrite silently gains text they typed nowhere.
        await evaljs(setup('my real draft'));
        const uploadNeutered = await evaljs(`(() => {
          window.__ci._insertUploadedPaths = function (cwd, uploaded) {   // the pre-fix body
            const tops = new Set();
            for (const f of uploaded) { const first = (f.name || '').split('/')[0]; if (first) tops.add(first); }
            const text = [...tops].map((n) => cwd + '/' + n).join(' ');
            const ta = this._textarea;
            const before = ta.value;
            ta.value = before + (before ? ' ' : '') + text + ' ';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          };
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'the rewrite I am still typing';
          window.__ci._insertUploadedPaths('/home/u/proj', [{ name: 'shot.png' }]);
          const box = ta.value;
          window.__ci._send();                       // Send SAVES the box as the edit
          const out = { box, op: window.__ops[0]?.extra?.text ?? null, toast: document.getElementById('global-toasts')?.textContent || '' };
          delete window.__ci._insertUploadedPaths;
          window.__ci.setQueueOpResult('q1', true, '');
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`);
        ok(`negative control: the pre-fix writer puts the uploaded path INTO the queued message, silently (${JSON.stringify(uploadNeutered)})`,
          uploadNeutered.box === 'the rewrite I am still typing /home/u/proj/shot.png '
          && uploadNeutered.op === 'the rewrite I am still typing /home/u/proj/shot.png' && uploadNeutered.toast === '');

        // …and the OTHER half, which is worse: the save is already on the wire.
        // `_resolvePendingEdit` compares the box against the frame's `raw` and
        // reads any difference as "the user typed something else" — so an
        // upload landing here disarmed EVERY outcome (round-3's whole family):
        // the ok result never put the draft back, a refusal never re-opened
        // the editor, a gone row never handed the rewrite over.
        await evaljs(setup('my real draft'));
        const uploadDuringSave = await evaljs(`(() => {
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'a rewrite on the wire';
          window.__ci._send();
          window.__ci._insertUploadedPaths('/home/u/proj', [{ name: 'shot.png' }]);   // …lands mid-flight
          const mid = { box: ta.value, stash: window.__ci._pendingEdit?.draftBefore ?? null,
            draft: VS.loadDraft('chat', 'sess-verbs'), toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci.setQueueOpResult('q1', true, '');       // the save landed
          const after = { box: ta.value, pending: !!window.__ci._pendingEdit };
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return { mid, after };
        })()`);
        ok(`round-6: an upload landing DURING the save does not touch the box the frame is being compared against (${JSON.stringify(uploadDuringSave.mid)})`,
          uploadDuringSave.mid.box === 'a rewrite on the wire' && uploadDuringSave.mid.stash === 'my real draft /home/u/proj/shot.png '
          && uploadDuringSave.mid.draft === 'my real draft /home/u/proj/shot.png ');
        ok(`…so the ok result still puts the pre-edit draft back, now carrying the paths (${JSON.stringify(uploadDuringSave.after)})`,
          uploadDuringSave.after.box === 'my real draft /home/u/proj/shot.png ' && uploadDuringSave.after.pending === false);

        // NEGATIVE CONTROL: same moment, pre-fix writer — the box no longer
        // matches `raw`, so the ok outcome silently does nothing and the
        // pre-edit draft is gone.
        await evaljs(setup('my real draft'));
        const saveNeutered = await evaljs(`(() => {
          window.__ci._insertUploadedPaths = function (cwd, uploaded) {   // the pre-fix body
            const ta = this._textarea;
            ta.value = ta.value + ' ' + cwd + '/' + uploaded[0].name + ' ';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          };
          document.querySelector('[data-queue-op="edit"][data-queue-id="q1"]').click();
          const ta = document.querySelector('textarea');
          ta.value = 'a rewrite on the wire';
          window.__ci._send();
          window.__ci._insertUploadedPaths('/home/u/proj', [{ name: 'shot.png' }]);
          window.__ci.setQueueOpResult('q1', true, '');
          const out = { box: ta.value, draft: VS.loadDraft('chat', 'sess-verbs') };
          delete window.__ci._insertUploadedPaths;
          window.__ci.setQueue(window.__items, ${CODEX_VERBS});
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`);
        ok(`negative control: with the box changed under it the ok result takes the bail-out — the pre-edit draft never comes back (${JSON.stringify(saveNeutered)})`,
          saveNeutered.box === 'a rewrite on the wire /home/u/proj/shot.png ' && saveNeutered.draft === 'a rewrite on the wire /home/u/proj/shot.png ');

        // ── ROUND-6 (MINOR): AN OLDER UNCONFIRMED SEND SURVIVES THE ACTION.
        // `_send` OVERWRITES `_pendingSend`, so releasing "this call's slot"
        // by nulling the field threw away the dead-socket protection of a
        // message the USER had sent seconds earlier.
        await evaljs(setup(''));
        const olderSlot = await evaljs(`(() => {
          const ta = document.querySelector('textarea');
          ta.value = 'a message the user just sent';
          window.__ci._send();                          // the USER's send — unconfirmed
          const armedUser = window.__ci._pendingSend?.text ?? null;
          ta.value = 'a half-typed prompt';             // …and they keep typing
          const answer = window.__ci.sendText('/compact');
          const mid = { answer, armedUser, slot: window.__ci._pendingSend?.text ?? null,
            box: ta.value, draft: VS.loadDraft('chat', 'sess-verbs'), sent: window.__sent.map((f) => f.text) };
          window.__ci.confirmDelivery();                // the server answers on the socket
          mid.afterEcho = { slot: window.__ci._pendingSend?.text ?? null, draft: VS.loadDraft('chat', 'sess-verbs'), box: ta.value };
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return mid;
        })()`);
        ok(`round-6: the action releases ITS slot back to the older unconfirmed send, not to nothing (${JSON.stringify({ armedUser: olderSlot.armedUser, slot: olderSlot.slot, sent: olderSlot.sent })})`,
          olderSlot.answer === true && olderSlot.armedUser === 'a message the user just sent'
          && olderSlot.slot === 'a message the user just sent' && olderSlot.sent.length === 2);
        ok(`…and the delivery echo does not clear a store that now holds the user's restored prompt (${JSON.stringify(olderSlot.afterEcho)})`,
          olderSlot.afterEcho.slot === null && olderSlot.afterEcho.draft === 'a half-typed prompt' && olderSlot.afterEcho.box === 'a half-typed prompt');

        // …and the protection it kept is REAL: with the box free, the dead
        // socket hands the user's own message back and says so.
        await evaljs(setup(''));
        const olderSlotDead = await evaljs(`(() => {
          const ta = document.querySelector('textarea');
          ta.value = 'a message the user just sent';
          window.__ci._send();
          ta.value = 'a half-typed prompt';
          window.__ci.sendText('/compact');
          ta.value = '';                                // the user sends/clears the box
          window.__ci.setDisconnected(true);            // …then the socket dies
          const out = { box: ta.value, toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci.setDisconnected(false);
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`);
        ok(`…a dead socket restores the USER's unconfirmed message, not the action's (${JSON.stringify(olderSlotDead)})`,
          olderSlotDead.box === 'a message the user just sent' && /restored to the input/.test(olderSlotDead.toast));

        // …and when the box is NOT free the notice has to change with it: a
        // sentence that says "the text was restored to the input" over an
        // input holding something else reports a rescue that did not happen,
        // and the user reads it as "my message is safe in the box" (round-6).
        await evaljs(setup(''));
        const deadBoxBusy = await evaljs(`(() => {
          const ta = document.querySelector('textarea');
          ta.value = 'a message the user just sent';
          window.__ci._send();
          ta.value = 'the next thing I am typing';       // they kept drafting
          window.__ci.setDisconnected(true);
          const out = { box: ta.value, toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci.setDisconnected(false);
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`);
        ok(`round-6: an occupied box is left alone AND the notice says so, instead of claiming a restore (${JSON.stringify(deadBoxBusy)})`,
          deadBoxBusy.box === 'the next thing I am typing' && /may not have been sent/.test(deadBoxBusy.toast)
          && /the input already had text/.test(deadBoxBusy.toast) && !/was restored to the input/.test(deadBoxBusy.toast));

        // NEGATIVE CONTROL: the pre-fix release (null) — the same dead socket
        // now has nothing to hand back, and says nothing at all.
        await evaljs(setup(''));
        const olderSlotNeutered = await evaljs(`(() => {
          const ta = document.querySelector('textarea');
          ta.value = 'a message the user just sent';
          window.__ci._send();
          ta.value = 'a half-typed prompt';
          window.__ci.sendText('/compact');
          window.__ci._pendingSend = null;              // as the pre-fix release left it
          ta.value = '';
          window.__ci.setDisconnected(true);
          const out = { box: ta.value, toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci.setDisconnected(false);
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`);
        ok(`negative control: with the slot cleared the user's unconfirmed message vanishes with the socket, silently (${JSON.stringify(olderSlotNeutered)})`,
          olderSlotNeutered.box === '' && !/may not have been sent/.test(olderSlotNeutered.toast));

        // ── ROUND-6 (MINOR): THE BAIL-OUT FROM AN EMPTY BOX. `_send` refuses a
        // dead socket before it clears anything, so the ACTION's own text was
        // left sitting in the input whenever there was no typed prompt to
        // restore over it — one Enter away from being posted as a message.
        await evaljs(setup(''));
        const emptyBail = await evaljs(`(() => {
          const ta = document.querySelector('textarea');
          ta.value = '';
          window.__ci.setDisconnected(true);
          const answer = window.__ci.sendText('/compact');
          const out = { answer, box: ta.value, sent: window.__sent.map((f) => f.text),
            toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci.setDisconnected(false);
          window.__ci._pendingSend = null;
          return out;
        })()`);
        ok(`round-6: a dead-socket bail-out from an EMPTY box leaves the box empty, not holding the action (${JSON.stringify(emptyBail)})`,
          emptyBail.answer === false && emptyBail.box === '' && emptyBail.sent.length === 0 && /Disconnected/.test(emptyBail.toast));

        // NEGATIVE CONTROL: the pre-fix restore, gated on `keptText.trim()`.
        await evaljs(setup(''));
        const emptyBailNeutered = await evaljs(`(() => {
          window.__ci.sendText = function (text) {           // the pre-fix body
            if (!this._textarea) return false;
            if (this._editingQueueId || this._pendingEdit) return false;
            const keptText = this._textarea.value;
            const prevPendingSend = this._pendingSend;
            this._textarea.value = String(text || '');
            const sent = this._send() !== false;
            if (keptText.trim()) {
              this._textarea.value = keptText;
              if (this._pendingSend && this._pendingSend !== prevPendingSend) this._pendingSend = null;
              VS.saveDraft('chat', this._sessionId, keptText);
            }
            return sent;
          };
          const ta = document.querySelector('textarea');
          ta.value = '';
          window.__ci.setDisconnected(true);
          const answer = window.__ci.sendText('/compact');
          const out = { answer, box: ta.value };
          delete window.__ci.sendText;
          window.__ci.setDisconnected(false);
          window.__ci._pendingSend = null;
          return out;
        })()`);
        ok(`negative control: the gated restore leaves the action's own text in the user's input (${JSON.stringify(emptyBailNeutered)})`,
          emptyBailNeutered.answer === false && emptyBailNeutered.box === '/compact');


        // ── ROUND-7 VERIFIER (MAJOR): THE ACTION FIRED FROM AN EMPTY BOX.
        // Round-6 put BOTH halves of "the action spends nothing of the user's"
        // — the slot hand-back and the store restore — INSIDE
        // `if (keptText.trim())`, so neither ran in the ORDINARY state of an
        // in-chat action button: an empty input. The whole round-6 fix was
        // therefore live only for the rarer case (an action fired over a
        // half-typed prompt) and dead for the common one.
        const R6_SEND_TEXT = `function (text) {                  // the round-6 body, verbatim
            if (!this._textarea) return false;
            if (this._editingQueueId || this._pendingEdit) return false;
            const keptText = this._textarea.value;
            const keptAttachments = this._attachments;
            const prevPendingSend = this._pendingSend;
            if (keptAttachments.length) { this._attachments = []; this._renderAttachments(); }
            this._textarea.value = String(text || '');
            const sent = this._send() !== false;
            if (keptAttachments.length) { this._attachments = keptAttachments; this._renderAttachments(); }
            this._textarea.value = keptText;
            if (keptText.trim()) {
              this._autoSize?.();
              this._pendingSend = prevPendingSend || null;
              VS.saveDraft('chat', this._sessionId, keptText);
            }
            return sent;
          }`;
        const emptyBoxScenario = (neuter) => `(() => {
          ${neuter ? 'window.__ci.sendText = ' + R6_SEND_TEXT + ';' : ''}
          const ta = document.querySelector('textarea');
          ta.value = 'a message the user just sent';
          window.__ci._send();                          // the USER's send — unconfirmed, store pinned to it
          const afterUserSend = { slot: window.__ci._pendingSend?.text ?? null, draft: VS.loadDraft('chat', 'sess-verbs'), box: ta.value };
          const answer = window.__ci.sendText('/compact');   // …the action, over the EMPTY box it left
          const out = { answer, afterUserSend, slot: window.__ci._pendingSend?.text ?? null,
            draft: VS.loadDraft('chat', 'sess-verbs'), box: ta.value, sent: window.__sent.map((f) => f.text) };
          window.__ci.setDisconnected(true);            // …and then the socket dies
          out.afterDead = { box: ta.value, toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci.setDisconnected(false);
          ${neuter ? 'delete window.__ci.sendText;' : ''}
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`;
        await evaljs(setup(''));
        const emptyBoxOlder = await evaljs(emptyBoxScenario(false));
        ok(`round-7 (setup): the user's own send arms the slot and pins the store, leaving the box empty (${JSON.stringify(emptyBoxOlder.afterUserSend)})`,
          emptyBoxOlder.afterUserSend.slot === 'a message the user just sent' && emptyBoxOlder.afterUserSend.draft === 'a message the user just sent' && emptyBoxOlder.afterUserSend.box === '');
        ok(`round-7: an action fired from an EMPTY box hands the OLDER send its slot back (${JSON.stringify({ answer: emptyBoxOlder.answer, slot: emptyBoxOlder.slot, sent: emptyBoxOlder.sent.length })})`,
          emptyBoxOlder.answer === true && emptyBoxOlder.slot === 'a message the user just sent' && emptyBoxOlder.sent.length === 2);
        ok(`…and puts the STORE back to the user's pinned message instead of leaving it pinned to '/compact' (${JSON.stringify(emptyBoxOlder.draft)})`,
          emptyBoxOlder.draft === 'a message the user just sent');
        ok(`…so the dead socket restores the USER's message, under the sentence that describes it (${JSON.stringify(emptyBoxOlder.afterDead)})`,
          emptyBoxOlder.afterDead.box === 'a message the user just sent' && /restored to the input/.test(emptyBoxOlder.afterDead.toast));

        // NEGATIVE CONTROL: the round-6 body — the gate the fix sat inside.
        await evaljs(setup(''));
        const emptyBoxOlderNeutered = await evaljs(emptyBoxScenario(true));
        ok(`negative control: with the release inside the trim gate the action KEEPS the slot and the pin — the user's own send loses both (${JSON.stringify({ slot: emptyBoxOlderNeutered.slot, draft: emptyBoxOlderNeutered.draft })})`,
          emptyBoxOlderNeutered.slot === '/compact' && emptyBoxOlderNeutered.draft === '/compact');
        ok(`…and the dead socket types the ACTION into the user's input, claiming their message was restored (${JSON.stringify(emptyBoxOlderNeutered.afterDead)})`,
          emptyBoxOlderNeutered.afterDead.box === '/compact' && /restored to the input/.test(emptyBoxOlderNeutered.afterDead.toast));

        // …and the OTHER half of the same defect, with NO older send at all:
        // the action armed the slot for ITSELF, so a later disconnect typed
        // `/compact` into an empty input under a restore notice about a
        // message the user never sent.
        const aloneScenario = (neuter) => `(() => {
          ${neuter ? 'window.__ci.sendText = ' + R6_SEND_TEXT + ';' : ''}
          const ta = document.querySelector('textarea');
          ta.value = '';
          const answer = window.__ci.sendText('/compact');
          const out = { answer, slot: window.__ci._pendingSend?.text ?? null,
            draft: VS.loadDraft('chat', 'sess-verbs'), box: ta.value, sent: window.__sent.map((f) => f.text) };
          window.__ci.setDisconnected(true);
          out.afterDead = { box: ta.value, toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci.setDisconnected(false);
          ${neuter ? 'delete window.__ci.sendText;' : ''}
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`;
        await evaljs(setup(''));
        const actionAlone = await evaljs(aloneScenario(false));
        ok(`round-7: with no older send the action arms NOTHING and leaves the store empty (${JSON.stringify({ slot: actionAlone.slot, draft: actionAlone.draft, sent: actionAlone.sent })})`,
          actionAlone.answer === true && actionAlone.slot === null && actionAlone.draft === '' && actionAlone.sent.length === 1);
        ok(`…so a later disconnect says nothing and writes nothing — there was no user message to lose (${JSON.stringify(actionAlone.afterDead)})`,
          actionAlone.afterDead.box === '' && actionAlone.afterDead.toast === '');

        await evaljs(setup(''));
        const actionAloneNeutered = await evaljs(aloneScenario(true));
        ok(`negative control: the round-6 body arms the slot for the ACTION ITSELF (${JSON.stringify({ slot: actionAloneNeutered.slot, draft: actionAloneNeutered.draft })})`,
          actionAloneNeutered.slot === '/compact' && actionAloneNeutered.draft === '/compact');
        ok(`…and the disconnect types '/compact' into the user's empty input under a toast saying their message was restored (${JSON.stringify(actionAloneNeutered.afterDead)})`,
          actionAloneNeutered.afterDead.box === '/compact' && /restored to the input/.test(actionAloneNeutered.afterDead.toast));

        // ── ROUND-7 (MINOR): "NOTHING TO RESTORE" IS ITS OWN STATE. The
        // discriminator was `!!text && !box.trim()`, so a send with no text of
        // its own — an image with no words, `_pendingSend.text === ''` — fell
        // into the "the input already had text, so it was left alone" branch
        // and told that to a user whose input was empty.
        const ATTACH = `[{ base64: 'aGk=', mediaType: 'image/png', dataUrl: 'data:image/png;base64,aGk=', name: 'shot.png' }]`;
        const PREFIX_ANNOUNCE = `function (text, { restoredMsg, keptMsg }) {   // the pre-fix two-way body
            const restored = !!text && !this._textarea.value.trim();
            if (restored) { this._textarea.value = text; this._textarea.dispatchEvent(new Event('input', { bubbles: true })); }
            VS.showToast(restored ? restoredMsg : keptMsg, { type: 'error' });
          }`;
        const attachOnlyScenario = (neuter) => `(() => {
          ${neuter ? 'window.__ci._announceUnsent = ' + PREFIX_ANNOUNCE + ';' : ''}
          const ta = document.querySelector('textarea');
          ta.value = '';
          window.__ci._attachments = ${ATTACH};
          window.__ci._renderAttachments();
          window.__ci._send();                          // an image with no words
          const out = { slotText: window.__ci._pendingSend?.text ?? null, sent: window.__sent.length };
          window.__ci.setDisconnected(true);
          out.box = ta.value;
          out.toast = document.getElementById('global-toasts')?.textContent || '';
          window.__ci.setDisconnected(false);
          ${neuter ? 'delete window.__ci._announceUnsent;' : ''}
          window.__ci._attachments = []; window.__ci._renderAttachments();
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`;
        await evaljs(setup(''));
        const attachOnlyDead = await evaljs(attachOnlyScenario(false));
        ok(`round-7: an attachments-only send really does carry text '' (${JSON.stringify({ slotText: attachOnlyDead.slotText, sent: attachOnlyDead.sent })})`,
          attachOnlyDead.slotText === '' && attachOnlyDead.sent === 1);
        ok(`…and the dead socket says "may not have been sent" WITHOUT claiming either a restore or an occupied input (${JSON.stringify(attachOnlyDead)})`,
          attachOnlyDead.box === '' && /may not have been sent/.test(attachOnlyDead.toast)
          && !/already had text/.test(attachOnlyDead.toast) && !/restored to the input/.test(attachOnlyDead.toast));

        await evaljs(setup(''));
        const attachOnlyNeutered = await evaljs(attachOnlyScenario(true));
        ok(`negative control: the two-way discriminator tells a user with an EMPTY input that it "already had text" (${JSON.stringify(attachOnlyNeutered)})`,
          attachOnlyNeutered.box === '' && /already had text/.test(attachOnlyNeutered.toast));

        // POSITIVE CONTROL for the same helper: the two states it already had
        // are unchanged — a free box is still restored into, an occupied one
        // is still left alone with the sentence that says so (pinned above in
        // `olderSlotDead` / `deadBoxBusy`, re-asserted here through the helper
        // itself so a future edit of it cannot quietly collapse the three).
        await evaljs(setup(''));
        const helperStates = await evaljs(`(() => {
          const ta = document.querySelector('textarea');
          const seen = [];
          ta.value = '';
          seen.push(window.__ci._announceUnsent('rescued text', { restoredMsg: 'R', keptMsg: 'K', noneMsg: 'N' }));
          const restoredBox = ta.value;
          ta.value = 'the user is typing';
          seen.push(window.__ci._announceUnsent('rescued text', { restoredMsg: 'R', keptMsg: 'K', noneMsg: 'N' }));
          const keptBox = ta.value;
          ta.value = '';
          seen.push(window.__ci._announceUnsent('', { restoredMsg: 'R', keptMsg: 'K', noneMsg: 'N' }));
          const out = { seen, restoredBox, keptBox, noneBox: ta.value, toast: document.getElementById('global-toasts')?.textContent || '' };
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`);
        ok(`round-7: the helper's three outcomes, each with the write it is allowed to make (${JSON.stringify(helperStates)})`,
          JSON.stringify(helperStates.seen) === JSON.stringify(['restored', 'kept', 'none'])
          && helperStates.restoredBox === 'rescued text' && helperStates.keptBox === 'the user is typing' && helperStates.noneBox === ''
          && /R/.test(helperStates.toast) && /K/.test(helperStates.toast) && /N/.test(helperStates.toast));

        // ── ROUND-7 (MINOR): THE TWO /goal TWINS SAID "RESTORED" REGARDLESS.
        // Both already guarded the restore on a free box; only the sentence
        // was unconditional, which is the same lie the send notice had.
        const goalDeadScenario = (busy, neuter) => `(() => {
          ${neuter ? 'window.__ci._announceUnsent = ' + PREFIX_ANNOUNCE.replace('{ restoredMsg, keptMsg }', '{ restoredMsg }').replace('VS.showToast(restored ? restoredMsg : keptMsg', 'VS.showToast(restoredMsg') + ';' : ''}
          const ta = document.querySelector('textarea');
          ta.value = '/goal ship the queue verbs';
          window.__ci._send();                          // /goal is intercepted: _pendingGoal armed
          const armed = !!window.__ci._pendingGoal;
          ta.value = ${JSON.stringify(busy ? 'the next thing I am typing' : '')};
          window.__ci.setDisconnected(true);
          const out = { armed, box: ta.value, pendingGoal: !!window.__ci._pendingGoal,
            toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci.setDisconnected(false);
          ${neuter ? 'delete window.__ci._announceUnsent;' : ''}
          clearTimeout(window.__ci._goalTimer); window.__ci._goalTimer = null; window.__ci._pendingGoal = null;
          window.__ci._clearPending(); window.__ci.hideTyping(); window.__ci._pendingSend = null;
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`;
        await evaljs(setup(''));
        const goalDeadFree = await evaljs(goalDeadScenario(false, false));
        ok(`positive control: a dead socket with a FREE box still restores the /goal command and says so (${JSON.stringify(goalDeadFree)})`,
          goalDeadFree.armed === true && goalDeadFree.box === '/goal ship the queue verbs' && /restored to the input/.test(goalDeadFree.toast) && goalDeadFree.pendingGoal === false);
        await evaljs(setup(''));
        const goalDeadBusy = await evaljs(goalDeadScenario(true, false));
        ok(`round-7: with the box occupied the /goal notice stops claiming a restore (${JSON.stringify(goalDeadBusy)})`,
          goalDeadBusy.box === 'the next thing I am typing' && /the input already had text, so your command was left alone/.test(goalDeadBusy.toast)
          && !/restored to the input/.test(goalDeadBusy.toast));
        await evaljs(setup(''));
        const goalDeadNeutered = await evaljs(goalDeadScenario(true, true));
        ok(`negative control: the pre-fix twin announces a restore over the user's own words (${JSON.stringify(goalDeadNeutered)})`,
          goalDeadNeutered.box === 'the next thing I am typing' && /restored to the input/.test(goalDeadNeutered.toast));

        // …and the SECOND twin, the 10 s silence. The timer is captured and
        // fired by hand so the REAL callback body runs without a 10 s wait.
        const goalTimeoutScenario = (busy) => `(() => {
          const realST = window.setTimeout;
          let fire = null;
          window.setTimeout = (fn, ms) => { if (ms === 10000) { fire = fn; return 0; } return realST(fn, ms); };
          window.__ci._markGoalPending('/goal ship the queue verbs');
          window.setTimeout = realST;
          const captured = typeof fire === 'function';
          const ta = document.querySelector('textarea');
          ta.value = ${JSON.stringify(busy ? 'the next thing I am typing' : '')};
          fire();                                       // the 10s silence, deterministically
          const out = { captured, box: ta.value, pendingGoal: !!window.__ci._pendingGoal,
            toast: document.getElementById('global-toasts')?.textContent || '' };
          clearTimeout(window.__ci._goalTimer); window.__ci._goalTimer = null; window.__ci._pendingGoal = null;
          window.__ci._clearPending(); window.__ci.hideTyping(); window.__ci._pendingSend = null;
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`;
        await evaljs(setup(''));
        const goalTimeoutFree = await evaljs(goalTimeoutScenario(false));
        ok(`positive control: the 10 s fallback still restores into a free box (${JSON.stringify(goalTimeoutFree)})`,
          goalTimeoutFree.captured === true && goalTimeoutFree.box === '/goal ship the queue verbs'
          && /Your command was restored to the input/.test(goalTimeoutFree.toast) && goalTimeoutFree.pendingGoal === false);
        await evaljs(setup(''));
        const goalTimeoutBusy = await evaljs(goalTimeoutScenario(true));
        ok(`round-7: …and with the box occupied it says THAT instead (${JSON.stringify(goalTimeoutBusy)})`,
          goalTimeoutBusy.box === 'the next thing I am typing'
          && /The input already had text, so your command was left alone/.test(goalTimeoutBusy.toast)
          && !/restored to the input/.test(goalTimeoutBusy.toast));

        // ── ROUND-7 (MINOR): A SEND WITH NO TEXT OF ITS OWN COULD NEVER CLEAR
        // THE STORE AGAIN. The round-6 text-aware clear compares the store
        // against `pending.text`, and an attachments-only send pins nothing —
        // so text the user DELETED inside the 300 ms debounce window (whose
        // autosave `_send` cancels) stayed in the store forever and came back
        // as the draft of the next window on this session.
        const zombieScenario = (neuter) => `(() => {
          ${neuter ? `window.__ci.confirmDelivery = function () {          // the round-6 body
            const pending = this._pendingSend;
            if (!pending) return;
            this._pendingSend = null;
            const stored = VS.loadDraft('chat', this._sessionId);
            if (stored && stored !== pending.text) return;
            VS.saveDraft('chat', this._sessionId, '');
          };` : ''}
          const ta = document.querySelector('textarea');
          ta.value = '';                                // the user DELETES the draft…
          ta.dispatchEvent(new Event('input', { bubbles: true }));   // …arming the 300ms autosave
          const armed = window.__ci._draftTimer !== null;
          window.__ci._attachments = ${ATTACH};
          window.__ci._renderAttachments();
          window.__ci._send();                          // …which _send cancels, pinning nothing
          const before = VS.loadDraft('chat', 'sess-verbs');
          window.__ci.confirmDelivery();                // the server answers on the socket
          const out = { armed, before, after: VS.loadDraft('chat', 'sess-verbs'), slot: window.__ci._pendingSend };
          const probe = new VS.ChatInput({ send(){} }, 'sess-verbs', { onSend(){}, onInterrupt(){} });
          out.reopened = probe.element.querySelector('textarea').value;
          probe.dispose();
          ${neuter ? 'delete window.__ci.confirmDelivery;' : ''}
          window.__ci._attachments = []; window.__ci._renderAttachments();
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`;
        await evaljs(setup('text I deleted inside the debounce window'));
        const zombie = await evaljs(zombieScenario(false));
        ok(`round-7 (setup): the deletion's autosave is armed and then cancelled by the send, so the store still holds the deleted text (${JSON.stringify({ armed: zombie.armed, before: zombie.before })})`,
          zombie.armed === true && zombie.before === 'text I deleted inside the debounce window');
        ok(`round-7: the delivery echo of an attachments-only send clears what the send DISPLACED (${JSON.stringify({ after: zombie.after, slot: zombie.slot })})`,
          zombie.after === '' && zombie.slot === null);
        ok(`…so a window reopened on this session comes up EMPTY, not holding text the user deleted (${JSON.stringify(zombie.reopened)})`, zombie.reopened === '');

        await evaljs(setup('text I deleted inside the debounce window'));
        const zombieNeutered = await evaljs(zombieScenario(true));
        ok(`negative control: comparing against \`text\` alone makes the clear a permanent no-op for a send with no text (${JSON.stringify(zombieNeutered.after)})`,
          zombieNeutered.after === 'text I deleted inside the debounce window');
        ok(`…and the next window on this session opens holding the deleted text (${JSON.stringify(zombieNeutered.reopened)})`,
          zombieNeutered.reopened === 'text I deleted inside the debounce window');

        // NEGATIVE CONTROL FOR THE FIX ITSELF: `storeBefore` must not become a
        // licence to empty the draft channel. Words typed AFTER the send match
        // neither the pin nor what it displaced, and survive.
        await evaljs(setup('text I deleted inside the debounce window'));
        const typedAfter = await evaljs(`(() => {
          const ta = document.querySelector('textarea');
          ta.value = '';
          window.__ci._attachments = ${ATTACH};
          window.__ci._renderAttachments();
          window.__ci._send();
          VS.saveDraft('chat', 'sess-verbs', 'brand new words, typed after the send');   // the 300ms autosave
          window.__ci.confirmDelivery();
          const out = { after: VS.loadDraft('chat', 'sess-verbs') };
          window.__ci._attachments = []; window.__ci._renderAttachments();
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`);
        ok(`round-7: words typed AFTER the send are still not the echo's to delete (${JSON.stringify(typedAfter)})`,
          typedAfter.after === 'brand new words, typed after the send');

        // ── ROUND-8 VERIFIER (MAJOR): `sendText` HAS TWO KINDS OF CALLER.
        // Round-7 made the release unconditional — correct for an ACTION
        // (`Compact now` is product-authored text that owns nothing), wrong for
        // the DESIGN REQUEST, whose payload is built around a brief the USER
        // typed into a dropdown that closes the moment the send is accepted.
        // With the slot released, a send that died in a half-open socket took
        // the brief with it and said nothing; round 6 (whose release sat inside
        // the trim gate the dropdown's empty box never enters) had restored it.
        const R7_SEND_TEXT = `function (text) {                 // the round-7 body, verbatim
            if (!this._textarea) return false;
            if (this._editingQueueId || this._pendingEdit) return false;
            const keptText = this._textarea.value;
            const keptAttachments = this._attachments;
            const prevPendingSend = this._pendingSend;
            const prevDraft = VS.loadDraft('chat', this._sessionId);
            if (keptAttachments.length) { this._attachments = []; this._renderAttachments(); }
            this._textarea.value = String(text || '');
            const sent = this._send() !== false;
            if (keptAttachments.length) { this._attachments = keptAttachments; this._renderAttachments(); }
            this._textarea.value = keptText;
            this._pendingSend = prevPendingSend || null;
            if (keptText.trim()) {
              this._autoSize?.();
              VS.saveDraft('chat', this._sessionId, keptText);
            } else {
              VS.saveDraft('chat', this._sessionId, prevDraft);
            }
            return sent;
          }`;
        const DESIGN_MSG = '[VibeSpace design request] a dark pricing page for my side project';
        // ONE scenario, BOTH callers, the same empty box: the only difference
        // is the flag, so the leg proves what the flag is for.
        const twoCallers = (neuter) => `(() => {
          ${neuter ? 'window.__ci.sendText = ' + R7_SEND_TEXT + ';' : ''}
          const ta = document.querySelector('textarea');
          ta.value = '';                                // an action button's box, and the dropdown's
          window.__ci.sendText('/compact');             // ① the ACTION caller (no flag = the default)
          const afterAction = { slot: window.__ci._pendingSend?.text ?? null, draft: VS.loadDraft('chat', 'sess-verbs') };
          const answer = window.__ci.sendText(${JSON.stringify(DESIGN_MSG)}, { carriesUserText: true });   // ② the DESIGN caller
          const out = { answer, afterAction, slot: window.__ci._pendingSend?.text ?? null,
            draft: VS.loadDraft('chat', 'sess-verbs'), box: ta.value, sent: window.__sent.length };
          window.__ci.setDisconnected(true);            // …the frame went into a half-open socket
          out.afterDead = { box: ta.value, toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci.setDisconnected(false);
          ${neuter ? 'delete window.__ci.sendText;' : ''}
          ta.value = '';
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          VS.saveDraft('chat', 'sess-verbs', '');
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`;
        await evaljs(setup(''));
        const twoCallersFixed = await evaljs(twoCallers(false));
        ok(`round-8: the ACTION still arms nothing from an empty box — the default is unchanged (${JSON.stringify(twoCallersFixed.afterAction)})`,
          twoCallersFixed.afterAction.slot === null && twoCallersFixed.afterAction.draft === '');
        ok(`round-8: …while the design request KEEPS the slot its send armed, because the brief is the user's (${JSON.stringify({ answer: twoCallersFixed.answer, slot: twoCallersFixed.slot, sent: twoCallersFixed.sent })})`,
          twoCallersFixed.answer === true && twoCallersFixed.slot === DESIGN_MSG && twoCallersFixed.sent === 2 && twoCallersFixed.box === '');
        ok(`round-8: …so a half-open socket hands the brief back with a notice instead of losing it (${JSON.stringify({ box: twoCallersFixed.afterDead.box.slice(0, 46), toast: twoCallersFixed.afterDead.toast.slice(0, 60) })})`,
          twoCallersFixed.afterDead.box === DESIGN_MSG && /restored to the input/.test(twoCallersFixed.afterDead.toast));

        // NEGATIVE CONTROL: the round-7 body — one release for both callers.
        await evaljs(setup(''));
        const twoCallersNeutered = await evaljs(twoCallers(true));
        ok(`negative control: the round-7 release drops the design request's slot AND its pin (${JSON.stringify({ slot: twoCallersNeutered.slot, draft: twoCallersNeutered.draft })})`,
          twoCallersNeutered.slot === null && twoCallersNeutered.draft === '');
        ok(`…so the user's brief vanishes with the socket, with zero trace — the defect, reproduced (${JSON.stringify(twoCallersNeutered.afterDead)})`,
          twoCallersNeutered.afterDead.box === '' && twoCallersNeutered.afterDead.toast === '');

        // …and the OLDER send still wins over a user-authored payload: it is the
        // user's too, it is older, and it is what this send displaced.
        await evaljs(setup(''));
        const designOverOlder = await evaljs(`(() => {
          const ta = document.querySelector('textarea');
          ta.value = 'a message the user just sent';
          window.__ci._send();                          // the USER's send — unconfirmed
          const answer = window.__ci.sendText(${JSON.stringify(DESIGN_MSG)}, { carriesUserText: true });
          const out = { answer, slot: window.__ci._pendingSend?.text ?? null, draft: VS.loadDraft('chat', 'sess-verbs') };
          window.__ci.setDisconnected(true);
          out.afterDead = { box: ta.value, toast: document.getElementById('global-toasts')?.textContent || '' };
          window.__ci.setDisconnected(false);
          ta.value = '';
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          VS.saveDraft('chat', 'sess-verbs', '');
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`);
        ok(`round-8: with an older unconfirmed send in flight the OLDER one keeps the slot and the pin (${JSON.stringify({ slot: designOverOlder.slot, draft: designOverOlder.draft })})`,
          designOverOlder.answer === true && designOverOlder.slot === 'a message the user just sent' && designOverOlder.draft === 'a message the user just sent');
        ok(`…and it is the one the dead socket restores (${JSON.stringify(designOverOlder.afterDead)})`,
          designOverOlder.afterDead.box === 'a message the user just sent' && /restored to the input/.test(designOverOlder.afterDead.toast));

        // ── ROUND-8 (MINOR): THE `storeBefore` ARM IS FOR A SEND WITH NO TEXT.
        // Round-7 let ANY send clear the store when the value it displaced is
        // back there — but a send that pinned its own text can only prove
        // delivery of THAT, and a reappearing pre-send value (re-typed,
        // recalled with ArrowUp, re-pasted, or handed back by `sendText`) is
        // words that were never sent, sitting where the pin demonstrably is not.
        const R7_CONFIRM = `function () {                        // the round-7 body, verbatim
            const pending = this._pendingSend;
            if (!pending) return;
            this._pendingSend = null;
            const stored = VS.loadDraft('chat', this._sessionId);
            if (stored && stored !== pending.text && stored !== pending.storeBefore) return;
            VS.saveDraft('chat', this._sessionId, '');
          }`;
        const reappearScenario = (neuter) => `(() => {
          ${neuter ? 'window.__ci.confirmDelivery = ' + R7_CONFIRM + ';' : ''}
          const ta = document.querySelector('textarea');
          ta.value = 'a message I am sending now';
          window.__ci._send();                          // pins its own text; storeBefore = the draft it displaced
          const pinned = VS.loadDraft('chat', 'sess-verbs');
          const slot = { text: window.__ci._pendingSend?.text ?? null, storeBefore: window.__ci._pendingSend?.storeBefore ?? null };
          VS.saveDraft('chat', 'sess-verbs', 'the words I had drafted');   // the user types them again
          window.__ci.confirmDelivery();                // the server answers on the socket
          const out = { pinned, slot, after: VS.loadDraft('chat', 'sess-verbs') };
          ${neuter ? 'delete window.__ci.confirmDelivery;' : ''}
          ta.value = '';
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          VS.saveDraft('chat', 'sess-verbs', '');
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`;
        await evaljs(setup('the words I had drafted'));
        const reappear = await evaljs(reappearScenario(false));
        ok(`round-8 (setup): the send pins its own text and records what it displaced (${JSON.stringify(reappear)})`,
          reappear.pinned === 'a message I am sending now' && reappear.slot.text === 'a message I am sending now'
          && reappear.slot.storeBefore === 'the words I had drafted');
        ok(`round-8: the echo of a TEXT-carrying send does not delete a reappearing pre-send draft (${JSON.stringify(reappear.after)})`,
          reappear.after === 'the words I had drafted');
        await evaljs(setup('the words I had drafted'));
        const reappearNeutered = await evaljs(reappearScenario(true));
        ok(`negative control: the unscoped \`storeBefore\` arm empties the draft channel — the defect, reproduced (${JSON.stringify(reappearNeutered.after)})`,
          reappearNeutered.after === '');

        // …and the case the arm EXISTS for is untouched: a send with no text of
        // its own still clears what it displaced (the round-7 zombie draft).
        await evaljs(setup('text I deleted inside the debounce window'));
        const pinlessStillClears = await evaljs(`(() => {
          const ta = document.querySelector('textarea');
          ta.value = '';
          window.__ci._attachments = ${ATTACH};
          window.__ci._renderAttachments();
          window.__ci._send();                          // an image with no words: pins nothing
          const slot = { text: window.__ci._pendingSend?.text ?? null, storeBefore: window.__ci._pendingSend?.storeBefore ?? null };
          window.__ci.confirmDelivery();
          const out = { slot, after: VS.loadDraft('chat', 'sess-verbs') };
          window.__ci._attachments = []; window.__ci._renderAttachments();
          window.__ci.hideTyping(); window.__ci._pendingSend = null;
          VS.saveDraft('chat', 'sess-verbs', '');
          clearTimeout(window.__ci._draftTimer); window.__ci._draftTimer = null;
          return out;
        })()`);
        ok(`round-8: the pinless (attachments-only) send still clears what it displaced — the scoping kept its own case (${JSON.stringify(pinlessStillClears)})`,
          pinlessStillClears.slot.text === '' && pinlessStillClears.slot.storeBefore === 'text I deleted inside the debounce window'
          && pinlessStillClears.after === '');

        await evaljs(`(() => { window.__ci.setQueue(window.__items, ${CODEX_VERBS}); document.querySelector('textarea').value = ''; window.__ci._pendingSend = null; document.getElementById('global-toasts')?.replaceChildren(); })()`);
      }
      // THE HEADER CONTROL is per harness, from the verb table — codex has
      // run-all, an ACP harness does not, and claude has no strip at all.
      {
        const codexHead = await evaljs(`(() => { window.__ci.setQueue(window.__items, ${CODEX_VERBS}); return { runAll: !!document.querySelector('[data-queue-op="run-all"]'), steerAll: !!document.querySelector('[data-queue-op="steer-all"]'), runNow: document.querySelectorAll('[data-queue-op="run-now"]').length, grips: document.querySelectorAll('.chat-queue-grip').length }; })()`);
        ok(`codex: the header carries "Run all now" AND "Steer all", every row a run-now and a grip (${JSON.stringify(codexHead)})`, codexHead.runAll && codexHead.steerAll && codexHead.runNow === 3 && codexHead.grips === 3);
        const acpHead = await evaljs(`(() => { window.__ci.setQueue(window.__items, ${OPENCODE_VERBS}); return { runAll: !!document.querySelector('[data-queue-op="run-all"]'), steerAll: !!document.querySelector('[data-queue-op="steer-all"]'), runNow: document.querySelectorAll('[data-queue-op="run-now"]').length, grips: document.querySelectorAll('.chat-queue-grip').length, edits: document.querySelectorAll('[data-queue-op="edit"]').length }; })()`);
        ok(`an ACP harness gets NO run-all / steer-all / run-now (${JSON.stringify(acpHead)})`, !acpHead.runAll && !acpHead.steerAll && acpHead.runNow === 0);
        ok('…but it does get the reorder grips and the edit controls it really serves (peer excluded)', acpHead.grips === 3 && acpHead.edits === 2, JSON.stringify(acpHead));
        const claudeHead = await evaljs(`(() => { window.__ci.setQueue(window.__items, ${CLAUDE_VERBS}); const s = document.querySelector('.chat-queue-strip'); return { hidden: s.classList.contains('hidden'), html: s.innerHTML.length }; })()`);
        ok(`claude publishes no queue ⇒ NO STRIP AT ALL, not an empty one (${JSON.stringify(claudeHead)})`, claudeHead.hidden && claudeHead.html === 0);
      }
    } catch (e) {
      ok(false,'the browser leg of ⑪ ran',  String(e.message || e).slice(0, 400));
    } finally {
      try { ws?.close(); } catch { }
      try { chrome.kill('SIGKILL'); } catch { }
      try { srv.close(); } catch { }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
    }
  }
}

// ⑫ HISTORY HYGIENE (r2 verifier, finding 4). This feature reached master as a
// cherry-pick chain, and one intermediate pick commit shipped LITERAL CONFLICT
// MARKERS in docs/kb-file-structure.md: the final tree was clean, so every
// suite here was green, but `git bisect` / `git show` landing on that commit
// saw an unresolved file and any per-commit marker scan flagged the branch.
// A tree-only check cannot see it — the assertion has to ask GIT.
console.log('— ⑫ no commit on this branch carries conflict markers (a clean final tree hides an unbisectable middle)');
{
  const { execFileSync } = await import('node:child_process');
  const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  // THE DETECTOR, and its negative control FIRST: a scan that cannot see a
  // marker would pass this section vacuously on any history at all.
  const MARKER = /^(<<<<<<< |>>>>>>> )/m;   // `=======` alone is ordinary prose (CHANGELOG rules, setext headings)
  ok('the detector fires on a conflicted buffer (negative control — without this the whole section is vacuous)',
    MARKER.test('a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\nb\n') && !MARKER.test('a\n=======\nb\n'));

  let baseRef = null;
  for (const r of ['origin/master', 'master']) {
    try { git(['rev-parse', '--verify', '--quiet', r + '^{commit}']); baseRef = r; break; } catch { }
  }
  if (!baseRef) {
    console.log('  SKIP: neither origin/master nor master resolves in this checkout — there is no branch range to scan');
  } else {
    const head = git(['rev-parse', 'HEAD']).trim();
    const commits = git(['rev-list', `${baseRef}..HEAD`]).trim().split('\n').filter(Boolean);
    if (!commits.length) {
      console.log(`  SKIP: HEAD (${head.slice(0, 8)}) is an ancestor of ${baseRef} — this checkout carries no branch commits to scan`);
    } else {
      const dirty = [];
      for (const c of commits) {
        // `git grep -I` = text files only; a match at all is a failure, so the
        // exit status is the whole answer (1 = clean, 0 = markers found).
        let hits = '';
        try { hits = git(['grep', '-I', '-l', '-E', '^(<<<<<<< |>>>>>>> )', c, '--', '.']); } catch { hits = ''; }
        const files = hits.split('\n').filter(Boolean).map((l) => l.slice(l.indexOf(':') + 1)).filter((f) => !/^CHANGELOG\.md$/.test(f));
        if (files.length) dirty.push(`${c.slice(0, 8)} → ${files.join(', ')}`);
      }
      ok(`every one of the ${commits.length} commit(s) in ${baseRef}..HEAD is marker-free, so the chain bisects${dirty.length ? '' : ''}`, dirty.length === 0, dirty);
      // …and the SAME scan against the commit the reviewer named, when this
      // checkout still has it: the defect, reproduced by the shipped detector.
      let known = null;
      try { known = git(['rev-parse', '--verify', '--quiet', '817550d4^{commit}']).trim(); } catch { }
      if (!known) {
        console.log('  SKIP: 817550d4 (the pre-repair pick commit) is not in this object store — the historical positive control cannot run here');
      } else {
        let hits = '';
        try { hits = git(['grep', '-I', '-l', '-E', '^(<<<<<<< |>>>>>>> )', known, '--', 'docs/kb-file-structure.md']); } catch { hits = ''; }
        ok('positive control: the ORIGINAL pick commit 817550d4 does trip this scan (docs/kb-file-structure.md) — the check is the one that would have caught it',
          /kb-file-structure\.md/.test(hits), hits.slice(0, 200));
      }
    }
  }
}

// ⑨ THE STEER-ALL BUBBLES (owner 2026-09-07: "我刚才在那个codex session里全给插入
// 了，但是我只能看到我最后插入的一条消息"). Twenty-five queued submissions were
// steered into the running turn and ONE bubble appeared — the only one this
// wrapper had typed. The queue belongs to the THREAD and survives a
// Terminate+Resume; the app-server's own carrier for an inherited submission
// entering the turn (`item/completed {item:{type:'userMessage', clientId}}`)
// had no branch in the wrapper. This leg owns the REBUILD half: what those
// records must render to after a reload. (The LIVE half — the real wrapper
// against a stub app-server that hands it an inherited queue — is
// test-codex-p2-wrapper ⑥.)
console.log('— ⑨ steered messages: one bubble each, live and after a reload');
{
  const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
  const { mergeCodexRecords, recordFingerprint, userTwinKeys, userRecordIdentity, codexRecordIdentity, userContentKey, retractionIdOf } = require(path.join(REPO, 'src/codex-session-store.js'));
  const rollout = fs.readFileSync(path.join(REPO, 'scripts/fixtures/codex-steer-all-rollout.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const userRecs = rollout.filter((r) => r.type === 'response_item' && r.payload.type === 'message' && r.payload.role === 'user');
  const twins = rollout.filter((r) => r.type === 'event_msg' && r.payload.type === 'item_completed' && r.payload.item?.type === 'UserMessage');

  // THE FIXTURE IS THE SHAPE, not a convenience: a redacted copy of the owner's
  // 07:38:44-45 window (keys, ordering, ~40ms cadence).
  ok('the fixture is the rollout shape: 12 consecutive user records in ONE turn, each with its item_completed UserMessage twin', userRecs.length === 12 && twins.length === 12, `${userRecs.length}/${twins.length}`);
  ok('…and NOT ONE `user_message` event for them — the queued path emits one, the steered path does not, which is why that carrier could not be reused',
    !rollout.some((r) => r.type === 'event_msg' && r.payload.type === 'user_message'));
  ok('every twin carries the submission\'s clientId (the ONLY identity the steered path publishes)', twins.every((r) => typeof r.payload.item.client_id === 'string' && r.payload.item.client_id));

  const bodies = (mm) => mm.messages.filter((m) => m.role === 'user').map((m) => (m.content || []).map((c) => c.text || '').join(''));
  const feed = (records) => { const mm = new CodexMessageManager('rb'); for (const r of records) mm.processLive(r); return mm; };

  // (a) THE ROLLOUT ALONE — a reload of a session whose buffer has rotated away
  {
    const mm = feed(mergeCodexRecords(rollout, []));
    const b = bodies(mm);
    ok(`ROLLOUT ALONE: 12 user records → 12 bubbles (${b.length})`, b.length === 12, JSON.stringify(b.map((x) => x.slice(0, 22))));
    ok('in queue order, each exactly once', b.every((x, i) => x.includes(`steered message ${i + 1} `)), JSON.stringify(b.map((x) => x.slice(0, 26))));
    ok('the developer hooks message after each one is never a bubble', !b.some((x) => /developer message/.test(x)));
    // THE ROUTING PIN: the twin is a DECIDED skip in the normalizer, not a
    // silent drop — a kind that is neither routed nor listed fires telemetry.
    ok('`item_completed:UserMessage` is an EXPLICIT skip in the normalizer (its response_item already rendered the bubble) — never an unknown record',
      CodexMessageManager.ITEM_COMPLETED_SKIPPED_TYPES.has('UserMessage') && ![...CodexMessageManager._seenUnknownRecords].some((k) => /UserMessage/i.test(k)),
      JSON.stringify([...CodexMessageManager._seenUnknownRecords]));
  }

  // (b) THE REAL REBUILD: the wrapper's own bubbles (written when each steer
  // landed, carrying `webui_queue_id`) PLUS codex's copies of the same twelve.
  const ourCopies = userRecs.map((r, i) => ({
    timestamp: new Date(Date.parse(r.timestamp) - 42000).toISOString(),   // the steers landed 42s before the commits (measured)
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: r.payload.content, webui_queue_id: `inh-${i + 1}` },
  }));
  {
    const merged = mergeCodexRecords(rollout, ourCopies);
    const mm = feed(merged);
    const b = bodies(mm);
    ok(`REBUILD: 24 records for 12 messages → 12 bubbles (${b.length})`, b.length === 12, JSON.stringify(b.map((x) => x.slice(0, 22))));
    ok('still in queue order', b.every((x, i) => x.includes(`steered message ${i + 1} `)), JSON.stringify(b.map((x) => x.slice(0, 26))));
    const users = mm.messages.filter((m) => m.role === 'user');
    ok('the surviving copy is OURS, so every bubble keeps the queue id its chip joins on', users.every((m, i) => m.webuiMsgId === `inh-${i + 1}`), JSON.stringify(users.map((m) => m.webuiMsgId)));
    // NEGATIVE CONTROL — the shipped-before algorithm: the fingerprint kept
    // `webui_queue_id` inside the payload, so ours and codex's copy of one
    // message were strangers.
    const preFixFp = (r, turn) => {
      if (r.type === 'response_item' && r.payload?.type === 'message' && r.payload.role === 'user' && r.payload.webui_queue_id) {
        const moved = { ...r.payload, webui_queue_id: undefined, kept_queue_id: r.payload.webui_queue_id };
        return recordFingerprint({ ...r, payload: moved }, turn);   // = the key a NON-stripped marker produced
      }
      return recordFingerprint(r, turn);
    };
    ok('the control only differs where the fix does: for a record with no webui marker it IS the shipped fingerprint',
      preFixFp(rollout[2], 't') === recordFingerprint(rollout[2], 't'));
    const preFixMerge = (hist, live) => {
      const seen = new Set(); const out = []; let turn = 'prelude';
      for (const r of [...hist, ...live].map((x, i) => ({ x, i, t: Date.parse(x.timestamp) || 0 })).sort((p, q) => (p.t - q.t) || (p.i - q.i)).map((p) => p.x)) {
        if (r.type === 'turn_context') turn = r.payload?.turn_id || turn;
        const fp = preFixFp(r, turn);
        if (fp && seen.has(fp)) continue;
        if (fp) seen.add(fp);
        out.push(r);
      }
      return out;
    };
    const before = bodies(feed(preFixMerge(rollout, ourCopies)));
    ok(`NEGATIVE CONTROL: without the marker strip the same 24 records render 24 bubbles — every steered message twice (${before.length})`, before.length === 24, before.length);
  }

  // (c) THE ID-KEYED TWIN — the second defect the owner's own session carried:
  // every message TYPED here rendered twice after a reload (3/3 in the live
  // buffer + rollout of the owner's own thread), because our copy keys on
  // the webui msgId and codex's on its content.
  const typed = (n, text, extra = {}) => ({ timestamp: new Date(Date.parse('2026-09-07T09:00:00.000Z') + n).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', webui_msg_id: `m-${n}`, content: [{ type: 'input_text', text }], ...extra } });
  const codexCopy = (n, text, turn = 'turn-A') => ({ timestamp: new Date(Date.parse('2026-09-07T09:00:10.000Z') + n).toISOString(), type: 'response_item', payload: { type: 'message', id: `msg_c${n}`, role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { turn_id: turn } } });
  const tc = (id, atMs) => ({ timestamp: new Date(Date.parse('2026-09-07T09:00:00.000Z') + atMs).toISOString(), type: 'turn_context', payload: { turn_id: id } });
  {
    const mm = feed(mergeCodexRecords([tc('turn-A', -1000), codexCopy(1, 'run the tests again')], [typed(1, 'run the tests again')]));
    ok('A TYPED message and codex\'s own commit copy are ONE bubble after a reload (they used to be two — measured on the owner\'s real session)', bodies(mm).length === 1, JSON.stringify(bodies(mm)));
    ok('…and the surviving copy is ours, so the Queued/Steered chip still joins', mm.messages.find((m) => m.role === 'user')?.webuiMsgId === 'm-1');
    // the QUEUED path puts the two copies in DIFFERENT turns (ours at send
    // time, codex's in the turn that drained it) — a turn-scoped content key
    // would not have collided, which is why the claim is turn-independent
    const drained = mergeCodexRecords([tc('turn-A', -1000), tc('turn-B', 5000), codexCopy(2, 'and deploy it', 'turn-B')], [typed(2, 'and deploy it')]);
    ok('the DRAINED path too: our copy in the turn it was typed in, codex\'s in the turn that ran it → still ONE bubble', bodies(feed(drained)).length === 1, JSON.stringify(bodies(feed(drained))));
  }
  // (d) NO COALESCING: two DISTINCT submissions of the SAME text are two
  // messages — the reason the claim is COUNTED and the id key is not simply
  // replaced by the content key.
  {
    const recs = mergeCodexRecords([tc('turn-A', -1000), codexCopy(3, 'go on'), codexCopy(4, 'go on')], [typed(3, 'go on'), typed(4, 'go on')]);
    const mm = feed(recs);
    ok('two identical-text sends inside one turn stay TWO bubbles (n claims in, n twins consumed)', bodies(mm).length === 2, JSON.stringify(bodies(mm)));
    ok('…each keeping its own id', mm.messages.filter((m) => m.role === 'user').map((m) => m.webuiMsgId).join(',') === 'm-3,m-4');
  }
  // (e) FORWARD ONLY. A codex-side record that arrives BEFORE any claim must
  // survive: letting a late claim swallow an earlier record would DELETE an old
  // message from history the moment its text was typed again after the buffer
  // had rotated away.
  {
    const early = { ...codexCopy(5, 'same words twice'), timestamp: '2026-09-07T08:00:00.000Z' };
    const mm = feed(mergeCodexRecords([tc('turn-A', -1000), early, codexCopy(6, 'same words twice')], [typed(6, 'same words twice')]));
    ok('an OLD codex-side bubble whose text is typed again later is never deleted (the claim looks forward only)', bodies(mm).length === 2, JSON.stringify(bodies(mm)));
  }
  // (e2) A FALSY webui id is not an identity: the wrapper writes
  // `webui_msg_id: msg.msgId || ''`, so a frame that arrives without a msgId
  // produced a copy that keyed on a payload codex's copy could never match.
  {
    const empty = { timestamp: '2026-09-07T09:20:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', webui_msg_id: '', content: [{ type: 'input_text', text: 'no msgid here' }] } };
    const theirs = { timestamp: '2026-09-07T09:20:00.400Z', type: 'response_item', payload: { type: 'message', id: 'msg_e', role: 'user', content: [{ type: 'input_text', text: 'no msgid here' }], internal_chat_message_metadata_passthrough: { turn_id: 'turn-A' } } };
    ok('an empty webui id keys exactly like the bare record — one bubble, not two', bodies(feed(mergeCodexRecords([tc('turn-A', -1000), theirs], [empty]))).length === 1);
  }

  // (f) REGRESSION GUARDS on the two neighbours of this rule.
  {
    const text = 'Message from session "beta" (via vibespace-msg) — please quote this back';
    const mine = { timestamp: '2026-09-07T09:10:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }], webui_peer: { name: 'beta', body: 'please quote this back' } } };
    const theirs = { timestamp: '2026-09-07T09:10:00.500Z', type: 'response_item', payload: { type: 'message', id: 'msg_peer', role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { turn_id: 'turn-peer' } } };
    const users = feed(mergeCodexRecords([theirs], [mine])).messages.filter((m) => m.role === 'user');
    ok('a delivered peer message is still ONE labelled card after a rebuild', users.length === 1 && users[0].originKind === 'peer-message' && users[0].peerFrom === 'beta', JSON.stringify(users.map((m) => [m.originKind, m.peerFrom])));
    // …and an INHERITED item is not "typed here": most of the owner's 25 were
    // agent-to-agent messages, so peer detection still runs on our new record.
    const inheritedPeer = feed([{ timestamp: '2026-09-07T09:11:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Message from session "gamma" (via vibespace-msg) — inherited peer' }], webui_queue_id: 'inh-peer' } }]).messages.find((m) => m.role === 'user');
    ok('a steered INHERITED peer message keeps its labelled card AND carries the queue id (a webui_msg_id would have made it an anonymous "You" bubble)',
      inheritedPeer?.originKind === 'peer-message' && inheritedPeer.webuiMsgId === 'inh-peer', JSON.stringify([inheritedPeer?.originKind, inheritedPeer?.webuiMsgId]));
  }
  // (g) WHAT EACH COPY IS KEYED BY. Round 1 keyed the inherited bubble on its
  // CONTENT so codex's copy would collapse onto it — which silently deleted the
  // second of two same-text steers (round 2, (j1) below). Every user record is
  // now keyed by the id of the SUBMISSION it carries — ours by the webui/queue
  // id, codex's by its own `msg_…` — and the ours↔codex pair is retired by the
  // content CLAIM instead. The marker still stays out of the NORMALIZER's id
  // hash, so live and rebuilt agree whichever copy survives.
  {
    const marked = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }], webui_queue_id: 'inh-9', webui_queue_via: 'steered' } };
    const bare = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] } };
    const codexOwn = { type: 'response_item', payload: { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text: 'x' }] } };
    const marked2 = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }], webui_queue_id: 'inh-10', webui_queue_via: 'steered' } };
    ok('merge fingerprint: an inherited bubble keys by the app-server cid — a SUBMISSION id, never its text',
      recordFingerprint(marked, 't') === 't:response_item:user:inh-9' && recordFingerprint(marked, 't') !== recordFingerprint(marked2, 't'),
      [recordFingerprint(marked, 't'), recordFingerprint(marked2, 't')]);
    ok('…and codex\'s own copy keys by the id IT minted, in its own namespace', recordFingerprint(codexOwn, 't') === 't:response_item:user#codex:msg_1' && recordFingerprint(bare, 't') !== recordFingerprint(codexOwn, 't'));
    ok('codexRecordIdentity: codex\'s id when it has one, empty for the pre-0.15x records that carry none (they keep the content key)',
      codexRecordIdentity(codexOwn.payload) === 'msg_1' && codexRecordIdentity(bare.payload) === '');
    ok('normalizer recordKey: both copies mint the SAME message id, so live and rebuilt agree whichever survives', CodexMessageManager.recordKey(marked) === CodexMessageManager.recordKey(bare) && CodexMessageManager.recordKey(codexOwn) === CodexMessageManager.recordKey(bare));
    ok('userRecordIdentity names every SUBMISSION-id spelling — webui_queue_id included (it IS the cid a previous wrapper minted)',
      userRecordIdentity(marked.payload) === 'inh-9' && userRecordIdentity({ webui_msg_id: 'm1' }) === 'm1' && userRecordIdentity({ client_msg_id: 'c1' }) === 'c1' && userRecordIdentity(bare.payload) === '');
    ok('userTwinKeys: ours-vs-codex is decided by OUR markers, never by codex\'s fields', userTwinKeys(marked).ours === true && userTwinKeys(bare).ours === false && userTwinKeys(codexOwn).ours === false);
    // `late` = "the app-server had already persisted its own copy when this
    // record was written" — ONE reader-facing marker, set by every producer of
    // ours that writes after the commit (the drained item/completed twin, the
    // idle peer path). The forensic `webui_queue_via` label is NOT the contract:
    // reading it would have made the rule queue-only, and the peer idle path
    // (measured by test-peer-msg-card) doubles the moment it is.
    ok('…and `late` is decided by webui_after_commit, not by which producer\'s label a record carries',
      userTwinKeys(marked).late === false
      && userTwinKeys({ type: 'response_item', payload: { type: 'message', role: 'user', content: [], webui_queue_id: 'i', webui_queue_via: 'drained', webui_after_commit: true } }).late === true
      && userTwinKeys({ type: 'response_item', payload: { type: 'message', role: 'user', content: [], webui_peer: { name: 'b' }, webui_after_commit: true } }).late === true
      && userTwinKeys({ type: 'response_item', payload: { type: 'message', role: 'user', content: [], webui_queue_id: 'i', webui_queue_via: 'drained' } }).late === false
      && userTwinKeys({ type: 'response_item', payload: { type: 'message', role: 'user', webui_msg_id: 'm', content: [] } }).late === false && userTwinKeys(bare).late === false);
    // COMPAT RUNG: a PEER copy is late-capable with or without the marker —
    // every wrapper shipped before it wrote the idle-path record (which lands
    // after turn/start committed codex's copy) unmarked, and those buffers live
    // on inside sessions that are running right now. The queue bubble needs no
    // such rung: no unmarked one was ever released.
    ok('…and an UNMARKED peer copy is late-capable anyway (a running wrapper\'s buffer predates the marker)',
      userTwinKeys({ type: 'response_item', payload: { type: 'message', role: 'user', content: [], webui_peer: { name: 'b' } } }).late === true);
    ok('…and a non-user record is not its business', userTwinKeys({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } }) === null && userTwinKeys({ type: 'event_msg', payload: {} }) === null);
  }


  // (h2) A STEER LANDS MID-STREAM, so its bubble must not close the reply it
  // was steered INTO. Finalizing there cut the agent's message in two — the
  // 2.368.16 fragmentation the peer branch already avoids — and a steer-all
  // would have done it once per item. A TYPED record still finalizes: it can
  // begin a turn, where closing the previous streams is exactly right.
  {
    const midStream = (marker) => {
      const mm = new CodexMessageManager('mid');
      const at = () => new Date().toISOString();
      mm.processLive({ timestamp: at(), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } });
      mm.processLive({ timestamp: at(), type: 'event_msg', payload: { type: 'agent_message_delta', item_id: 'm1', delta: 'first half ' } });
      mm.processLive({ timestamp: at(), type: 'response_item', payload: { type: 'message', role: 'user', ...marker, content: [{ type: 'input_text', text: 'steered mid-stream' }] } });
      mm.processLive({ timestamp: at(), type: 'event_msg', payload: { type: 'agent_message_delta', item_id: 'm1', delta: 'second half' } });
      return mm.messages.filter((m) => m.role === 'assistant');
    };
    const inh = midStream({ webui_queue_id: 'inh-1' });
    ok('a steered bubble does NOT fragment the streaming reply it was injected into (2.368.16 class)', inh.length === 1 && (inh[0].content || []).map((c) => c.text).join('') === 'first half second half', JSON.stringify(inh.map((m) => (m.content || []).map((c) => c.text).join(''))));
    ok('…and the typed path is unchanged: a send that can BEGIN a turn still finalizes the open streams', midStream({ webui_msg_id: 'm-1' }).length === 2);
  }

  // (i) IN A REAL BROWSER: the same messages, rendered by the REAL renderer
  // into a REAL document. The owner's report is a COUNT of what is on screen,
  // so the last hop is measured rather than argued — nothing between the
  // normalizer and the DOM merges two bubbles into one.
  {
    const CHROME9 = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
    if (!CHROME9) {
      console.log('  SKIP: no chrome/chromium on this box — the DOM half of ⑨ did not run');
    } else {
      // the LIVE shape: the wrapper's twelve records, then the steer results
      // that chip them — exactly the frames the ws layer feeds the client.
      const live = new CodexMessageManager('live');
      for (const r of ourCopies) live.processLive(r);
      for (let i = 1; i <= 12; i++) live.processLive({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'queue_op_result', op: 'steer', id: `iq${i}`, msg_id: `inh-${i}`, ok: true, batch: 'steer-all' } });
      const liveUsers = live.messages.filter((m) => m.role === 'user');
      ok('LIVE (normalizer): twelve steered bubbles, each chipped by its queue_op_result',
        liveUsers.length === 12 && liveUsers.filter((m) => m.queueState === 'steered').length === 12, JSON.stringify(liveUsers.map((m) => [m.webuiMsgId, m.queueState])));

      const http = await import('node:http');
      const net = await import('node:net');
      const { spawn } = await import('node:child_process');
      const esbuild = require(path.join(REPO, 'node_modules/esbuild'));
      const WebSocket = require('ws');
      const sleep9 = (ms) => new Promise((r) => setTimeout(r, ms));
      const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `vs-steerdom-${process.pid}-`));
      const bundle = path.join(tmp, 'renderers.iife.js');
      const bvStub = { name: 'stub-build-version', setup(b) { b.onResolve({ filter: /build-version\.js$/ }, () => ({ path: 'build-version', namespace: 'bv' })); b.onLoad({ filter: /.*/, namespace: 'bv' }, () => ({ contents: "export const BUILD_VERSION = 'test';", loader: 'js' })); } };
      await esbuild.build({ entryPoints: [path.join(REPO, 'src/lib/chat-renderers.js')], bundle: true, format: 'iife', globalName: 'VS', platform: 'browser', target: 'es2022', outfile: bundle, logLevel: 'silent', loader: { '.css': 'text' }, plugins: [bvStub] });
      const js = fs.readFileSync(bundle, 'utf8').replace(/<\/script/gi, '<\\/script');
      const css = fs.readFileSync(path.join(REPO, 'public/chat.css'), 'utf8').replace(/<\/style/gi, '<\\/style');
      const html = `<!doctype html><meta charset="utf-8"><title>steer</title><style>${css}</style><body><div id="list"></div></body><script>${js}</script>`;
      const port = await freePort(), cdpPort = await freePort();
      const srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(html); }).listen(port, '127.0.0.1');
      const chrome = spawn(CHROME9, ['--headless=new', `--remote-debugging-port=${cdpPort}`, '--no-first-run', '--no-sandbox', '--disable-gpu',
        '--disable-dev-shm-usage', '--disable-background-timer-throttling', `--user-data-dir=${tmp}/chrome`, 'about:blank'], { stdio: 'ignore' });
      let cws = null;
      try {
        let target = null;
        for (let i = 0; i < 120 && !target; i++) {
          try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page'); } catch {}
          if (!target) await sleep9(250);
        }
        if (!target) throw new Error('chrome never exposed a CDP page target');
        cws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
        await new Promise((r, j) => { cws.on('open', r); cws.on('error', j); });
        let seq = 0; const pend = new Map();
        cws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
        const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); cws.send(JSON.stringify({ id, method, params })); });
        const evaljs = async (expr) => {
          const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
          if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
          return r.result?.result?.value;
        };
        await cdp('Runtime.enable'); await cdp('Page.enable');
        await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` });
        for (let i = 0; i < 80; i++) { if (await evaljs('!!(window.VS && window.VS.ChatRenderers)').catch(() => false)) break; await sleep9(150); }
        const out = await evaljs(`(() => {
          const list = document.getElementById('list');
          const msgs = ${JSON.stringify(liveUsers)};
          const r = new VS.ChatRenderers({ ws: { send() {} }, sessionId: 'sess-steer', app: null, backend: 'codex', compact: false,
            messageList: list, onQueueChipClick: () => {}, getQueueCaps: () => ({ queue: true, steer: true, queueOps: true }) });
          for (const m of msgs) { const el = r.renderUserMsg(m); if (el) list.appendChild(el); }
          const bubbles = [...list.querySelectorAll(':scope > .chat-msg')];
          return {
            bubbles: bubbles.length,
            plain: list.querySelectorAll(':scope > .chat-msg-user').length,
            peers: list.querySelectorAll(':scope > .chat-peer-message').length,
            chips: list.querySelectorAll('.chat-queue-chip').length,
            steeredChips: [...list.querySelectorAll('.chat-queue-chip')].filter((c) => c.dataset.queueState === 'steered').length,
            chipText: (list.querySelector('.chat-queue-chip')?.textContent || '').trim(),
            texts: bubbles.map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)),
            bodies: bubbles.map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim()),
            visible: bubbles.filter((b) => getComputedStyle(b).display !== 'none').length,
          };
        })()`);
        ok(`BROWSER: twelve steered messages are twelve bubbles on screen (${out?.bubbles})`, !!out && out.bubbles === 12, JSON.stringify(out?.texts));
        ok('ten "You" bubbles and the two agent-to-agent ones as labelled peer cards — inherited items are not all "typed here"', out.plain === 10 && out.peers === 2, JSON.stringify([out.plain, out.peers]));
        ok('all twelve are actually displayed', out.visible === 12, String(out.visible));
        ok('no two bubbles carry the same text — nothing merged them', new Set(out.texts).size === 12, JSON.stringify(out.texts));
        // a peer card leads with its sender head, so the ORDER is read from the
        // body — the two agent-to-agent items sit in their queue positions too
        ok('and they are in queue order (peer cards included, read from the body under their sender head)',
          out.bodies.every((t2, i) => t2.includes(`steered message ${i + 1} `)), JSON.stringify(out.texts));
        ok(`every "You" bubble wears exactly one Steered chip (${out.chips}/${out.steeredChips}, "${out.chipText}")`, out.chips === 10 && out.steeredChips === 10 && /Steered/.test(out.chipText));
      } catch (e) {
        ok('the ⑨ browser leg ran', false, String(e.message || e).slice(0, 300));
      } finally {
        try { cws?.close(); } catch {}
        try { chrome.kill('SIGKILL'); } catch {}
        try { srv.close(); } catch {}
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      }
    }
  }

  // (h) THE WRAPPER SIDE, by construction: the branch that records an inherited
  // submission, the cid bookkeeping that stops it doubling our own bubbles, and
  // the breadcrumb every OTHER unrouted item kind now leaves (its absence is
  // how `userMessage` stayed lost through four releases).
  {
    const cw = read('data/bin/codex-chat-wrapper.js');
    ok("item/completed routes `userMessage` — the app-server's own carrier for a submission entering the turn", /if \(type === 'userMessage'\) \{[\s\S]{0,220}recordInboundUserMessage\(asString\(item\.clientId \|\| item\.client_id\), userInputToContent\(item\.content\)/.test(cw));
    ok('a landed steer writes the bubble AT ONCE, in queue order (the commit twin arrives up to a minute later)', /await request\('turn\/steer'[\s\S]{0,1600}recordInboundUserMessage\(cid, userInputToContent\(item\.input\), 'steered'\)/.test(cw));
    // INTEGRATION (2026-09-07): the `turn/steer` call itself now lives in
    // `steerInput`, which the notification lane shares — so the fact this pin
    // owns is stated where it happens: steerOne RETURNS the refusal (whatever
    // `steerInput` classified) BEFORE the line that writes the bubble.
    ok('…and a REFUSED steer records nothing (that message is still queued)',
      /const st = await steerInput\(item\.input, cid\);\n\s*if \(!st\.ok\) \{[\s\S]{0,220}?return \{ \.\.\.base, \.\.\.st \};\n\s*\}/.test(cw)
      && /if \(!st\.ok\) \{[\s\S]{0,1200}?recordInboundUserMessage\(cid, userInputToContent\(item\.input\), 'steered'\)/.test(cw)
      && !/steerInput[\s\S]{0,400}?recordInboundUserMessage/.test(cw.slice(cw.indexOf('async function steerInput'), cw.indexOf('async function steerOne'))));
    ok('every id whose bubble we already wrote is remembered — chat-input, the queued cid and the peer cid', (cw.match(/noteRecordedUserCid\(/g) || []).length >= 5);
    ok('the record carries the queue id + its producer as out-of-band markers, LAST, so the stable payload stays {type, role, content}',
      /record\('response_item', \{\n\s*type: 'message', role: 'user', content: blocks, webui_queue_id: id, webui_queue_via: kind,\n\s*\.\.\.\(kind === 'drained' \? \{ webui_after_commit: true \} : \{\}\),\n\s*\}\);/.test(cw));
    // WHICH producer wrote it is load-bearing, not decoration: the two sit on
    // opposite sides of codex's own copy in time, and only the LATE one may
    // yield to it (see (j3)). A `via` the reader does not know must degrade to
    // the EARLY meaning — an unnamed producer may never delete a bubble.
    ok('…and the producer is a NAMED enum, defaulting to the early meaning', /INBOUND_USER_VIA = \{ steered: 'steered', drained: 'drained' \}/.test(cw) && /INBOUND_USER_VIA\[via\] \|\| 'steered'/.test(cw));
    ok('the item/completed twin — the one that arrives AFTER codex persisted its own copy — is the record marked \'drained\'', /if \(type === 'userMessage'\) \{[\s\S]{0,260}, 'drained'\);/.test(cw));
    ok('an inherited queue row advertises the app-server cid as its msgId so the strip row and the bubble chip join', /msgId: known \? \(known\.msgId \|\| ''\) : cid/.test(cw) && /msg_id: known \? \(known\.msgId \|\| ''\) : cid/.test(cw));
    ok('NO SILENT DROPS: an unrouted item/completed kind is logged once and counted in the sidecar', /noteUnhandledItem\(type\);\n\}/.test(cw) && /meta\.unhandledItems/.test(cw));
    ok('…and the deliberate no-ops are NAMED (a set, not silence)', /NO_RENDER_COMPLETED_ITEMS = new Set\(\[[\s\S]{0,400}'hookPrompt'/.test(cw));
  }

  // (j) ROUND 2 — the defects an adversarial verifier reproduced against (a)-(h)
  // above, each with a NEGATIVE CONTROL that runs the same scenario through the
  // shipped code MINUS the clause that fixes it. The controls are patched copies
  // of the REAL modules, never hand-written imitations: an imitation agrees with
  // whatever I believe the old code did (2.369.44 lesson), and every patch here
  // asserts it matched, so a control that silently patched nothing is red.
  {
    const patchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-steer-ctl-'));
    let ctlSeq = 0;
    const loadPatched = (rel, patches) => {
      let src = read(rel).replace(/require\('\.\/([^']+)'\)/g, (m, p) => `require(${JSON.stringify(path.join(REPO, 'src', p))})`);
      for (const [from, to] of patches) {
        if (!src.includes(from)) throw new Error(`negative control did not match in ${rel}: ${String(from).slice(0, 70)}`);
        src = src.replace(from, to);
      }
      const file = path.join(patchDir, `ctl-${++ctlSeq}-` + path.basename(rel));
      fs.writeFileSync(file, src);
      return require(file);
    };
    const T = Date.parse('2026-09-07T09:00:00.000Z');
    const turn = (id, ms) => ({ timestamp: new Date(T + ms).toISOString(), type: 'turn_context', payload: { turn_id: id } });
    const mine = (extra, text, ms) => ({ timestamp: new Date(T + ms).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }], ...extra } });
    const theirs = (id, text, ms, tid = 'turn-A') => ({ timestamp: new Date(T + ms).toISOString(), type: 'response_item', payload: { type: 'message', ...(id ? { id } : {}), role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { turn_id: tid } } });
    const bubbles = (records) => { const mm = new CodexMessageManager('r2'); for (const r of records) mm.processLive(r); return mm.messages.filter((m) => m.role === 'user').map((m) => (m.content || []).map((c) => c.text || '').join('')); };
    const steered = (cid, text, ms) => mine({ webui_queue_id: cid, webui_queue_via: 'steered' }, text, ms);
    const drained = (cid, text, ms) => mine({ webui_queue_id: cid, webui_queue_via: 'drained', webui_after_commit: true }, text, ms);

    // (j1) THE MAJOR: two INHERITED items with the SAME text steered into one
    // turn. Live they are two bubbles; round 1 keyed the bubble on its CONTENT,
    // so the rebuild dropped the second — a steered message deleted, and live
    // and reload disagreeing, in the scenario this whole section exists for.
    // ('continue', 'go on', identical agent-to-agent notices — a 25-item queue
    // makes this ordinary.)
    {
      const live = [steered('inh-1', 'go on', 1000), steered('inh-2', 'go on', 1100)];
      const rollout = [turn('turn-A', 0), theirs('msg_1', 'go on', 43000), theirs('msg_2', 'go on', 43100)];
      ok('LIVE: two same-text steers are two bubbles', bubbles(live).length === 2, bubbles(live));
      ok('REBUILD: …and still two after a reload, each once', bubbles(mergeCodexRecords(rollout, live)).length === 2, bubbles(mergeCodexRecords(rollout, live)));
      const users = (() => { const mm = new CodexMessageManager('r2'); for (const r of mergeCodexRecords(rollout, live)) mm.processLive(r); return mm.messages.filter((m) => m.role === 'user'); })();
      ok('…both keeping their own queue id, so each chip joins its own row', users.map((m) => m.webuiMsgId).join(',') === 'inh-1,inh-2', users.map((m) => m.webuiMsgId));
      // NEGATIVE CONTROL — the shipped store with round 1's keying restored:
      // every user record keyed by CONTENT (the queue id out of the
      // submission-id list, codex's own id not in the key, the two producers
      // sharing one namespace). It deletes the second steered message.
      const contentKeyed = [
        ["  return payload.webui_msg_id || payload.webuiMsgId || payload.client_msg_id || payload.clientMsgId\n    || payload.webui_queue_id || payload.webuiQueueId || '';",
          "  return payload.webui_msg_id || payload.webuiMsgId || payload.client_msg_id || payload.clientMsgId || '';"],
        ["      const codexId = codexRecordIdentity(payload);\n      if (codexId) return `${turnId}:response_item:user#codex:${codexId}`;", ''],
        ['      return `${turnId}:response_item:user#${userRecordIsOurs(payload) ? \'ours\' : \'codex\'}:${userContentKey(payload) || \'\'}`;', ''],
      ];
      const ctl = loadPatched('src/codex-session-store.js', contentKeyed);
      ok('NEGATIVE CONTROL: with round 1\'s content keying the same records rebuild to ONE bubble', bubbles(ctl.mergeCodexRecords(rollout, live)).length === 1, bubbles(ctl.mergeCodexRecords(rollout, live)));
    }

    // (j2) THE SAME LOSS WITH NO BUFFER AT ALL — codex's own records. A user
    // submission's identity is the id its producer minted, never its text:
    // MEASURED on the local rollout corpus (89 files, 572 user records), the
    // turn-scoped content key deleted 133 real messages on reload, every
    // collision carrying a different `id` AND a different `create_time` — 133
    // distinct submissions, zero genuine duplicates.
    {
      const rollout = [turn('turn-A', 0), theirs('msg_1', 'X', 1000), theirs('msg_2', 'Y', 1100), theirs('msg_3', 'X', 1200)];
      ok('ROLLOUT ALONE: two distinct submissions of the same text in one turn stay two bubbles, in order', bubbles(mergeCodexRecords(rollout, [])).join('|') === 'X|Y|X', bubbles(mergeCodexRecords(rollout, [])));
      const ctl = loadPatched('src/codex-session-store.js', [[
        "      const codexId = codexRecordIdentity(payload);\n      if (codexId) return `${turnId}:response_item:user#codex:${codexId}`;",
        '',
      ]]);
      ok("NEGATIVE CONTROL: without codex's own id in the key, the third record is deleted on reload", ctl.mergeCodexRecords(rollout, []).filter((r) => r.payload?.role === 'user').length === 2, bubbles(ctl.mergeCodexRecords(rollout, [])));
      // …and a fork replay (the SAME record in two files, sharing codex's id)
      // must still collapse — the reason the key may not simply become "content
      // plus position". Real fork chains reuse the parent's ids (measured 4/4
      // and 9/9 on local rollouts).
      const parent = [turn('turn-A', 0), theirs('msg_1', 'X', 1000)];
      ok('…while a fork replaying its parent record (same id, two files) is still ONE bubble', bubbles(mergeCodexRecords(parent, [theirs('msg_1', 'X', 1000)])).length === 1);
    }

    // (j3) WHICH PRODUCER WROTE OUR COPY decides how the pair is retired,
    // because they sit on opposite sides of codex's own record in time. A steer
    // lands ~42s before the commit (ours claims, codex's copy consumes); a
    // DRAINED item is only ever announced by the item/completed twin, which
    // arrives after codex has already persisted its record — so that copy of
    // ours yields instead, or the bubble doubles.
    {
      const rollout = [turn('turn-A', 0), theirs('msg_1', 'do it', 5000)];
      ok('DRAIN: codex\'s record first, our late twin 1ms later → ONE bubble', bubbles(mergeCodexRecords(rollout, [drained('inh-1', 'do it', 5001)])).length === 1);
      ok('NEGATIVE CONTROL: the same records with our copy marked \'steered\' (a producer-blind marker) → TWO', bubbles(mergeCodexRecords(rollout, [steered('inh-1', 'do it', 5001)])).length === 2);
      ok('…and a drained bubble whose codex record has not been flushed yet still renders (it yields only to a copy that EXISTS)',
        bubbles(mergeCodexRecords([turn('turn-A', 0)], [drained('inh-1', 'do it', 5001)])).length === 1);
      ok('…and it never yields to an identical message from ANOTHER turn (the pair is always inside the turn that committed it)',
        bubbles(mergeCodexRecords([turn('turn-A', 0), theirs('msg_0', 'do it', 1000), turn('turn-B', 20000), theirs('msg_1', 'do it', 25000)], [drained('inh-1', 'do it', 25001)])).length === 2);
      ok('STEER keeps its 42s-early claim: ours survives with its chip, codex\'s commit copy is dropped',
        (() => { const mm = new CodexMessageManager('r2'); for (const r of mergeCodexRecords([turn('turn-A', 0), theirs('msg_1', 'do it', 43000)], [steered('inh-1', 'do it', 1000)])) mm.processLive(r); const u = mm.messages.filter((m) => m.role === 'user'); return u.length === 1 && u[0].webuiMsgId === 'inh-1'; })());
    }

    // (j4) THE CLAIM LEDGER vs THE DUPLICATE CHECK. A claim that is never
    // retired DELETES an unrelated message later — the failure the forward-only
    // rule exists to prevent, arriving through the back door.
    {
      const live = [steered('inh-1', 'run the tests', 1000), mine({ webui_msg_id: 'm1' }, 'run the tests', 1100)];
      const rollout = [turn('turn-A', 0), theirs('msg_1', 'run the tests', 43000), theirs('msg_2', 'run the tests', 43100),
        turn('turn-B', 90000), theirs('msg_3', 'run the tests', 91000, 'turn-B')];
      ok('a codex-only message in a LATER turn survives a rebuild that also carries two copies of ours', bubbles(mergeCodexRecords(rollout, live)).length === 3, bubbles(mergeCodexRecords(rollout, live)));
      // The structural reason: ours and codex's copies never share a fingerprint
      // namespace, so `seen` can only ever collapse one producer's own record.
      const ourBare = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }], webui_msg_id: '' } };
      const theirBare = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] } };
      ok('…and with NEITHER side carrying an id, the two producers still key apart (a duplicate is a fact only within one producer)',
        recordFingerprint(ourBare, 't') !== recordFingerprint(theirBare, 't') && /user#ours:/.test(recordFingerprint(ourBare, 't')) && /user#codex:/.test(recordFingerprint(theirBare, 't')),
        [recordFingerprint(ourBare, 't'), recordFingerprint(theirBare, 't')]);
      ok('…yet that pair is still ONE bubble after a rebuild — the claim retires it, not a shared key',
        bubbles(mergeCodexRecords([turn('turn-A', 0), { ...theirBare, timestamp: new Date(T + 5000).toISOString() }], [{ ...ourBare, timestamp: new Date(T + 1000).toISOString() }])).length === 1);
      // The pre-0.15x shape is the one place a "duplicate" is INFERRED from
      // content; there the inferred duplicate must still retire the claim it
      // stands for, or the leak deletes the later message.
      const legacy = (text, ms, tid = 'turn-A') => theirs(null, text, ms, tid);
      const legacyRollout = [turn('turn-A', 0), legacy('ship it', 9000), legacy('ship it', 9100), turn('turn-B', 60000), legacy('ship it', 61000, 'turn-B')];
      const legacyLive = [mine({ webui_peer: { name: 'b', body: 'ship it' } }, 'ship it', 1000), mine({ webui_msg_id: 'm1' }, 'ship it', 1100)];
      ok('LEGACY (id-less records): a claim standing for a content-inferred duplicate is retired, so no message is deleted',
        bubbles(mergeCodexRecords(legacyRollout, legacyLive)).length === 3, bubbles(mergeCodexRecords(legacyRollout, legacyLive)));
      const ctl4 = loadPatched('src/codex-session-store.js', [[
        '      const dup = userTwinKeys(record);\n      if (dup && !dup.ours && !codexRecordIdentity(record.payload || {})) {\n        const claimed = userClaims.get(dup.contentKey) || 0;\n        if (claimed > 0) userClaims.set(dup.contentKey, claimed - 1);\n      }\n',
        '',
      ]]);
      ok('NEGATIVE CONTROL: without that retirement the leaked claim eats the turn-B message', ctl4.mergeCodexRecords(legacyRollout, legacyLive).filter((r) => r.payload?.role === 'user').length === 2);
      // …and an EXACT duplicate (same codex id in two sources) must NOT eat a
      // claim: there the duplicate is a fact, and consuming one would render a
      // later distinct submission twice.
      ok('an id-carrying duplicate leaves the ledger alone (2 sends of one text → 2 bubbles, not 3)',
        bubbles(mergeCodexRecords([turn('turn-A', 0), theirs('msg_1', 'go', 9000), theirs('msg_1', 'go', 9000), theirs('msg_2', 'go', 30000)],
          [mine({ webui_msg_id: 'm1' }, 'go', 1000), mine({ webui_msg_id: 'm2' }, 'go', 1100)])).length === 2);
    }

    // (j5) A BUBBLE THAT DOES NOT CLOSE THE TURN'S STREAMS MUST NOT HIDE THEM
    // from the finalizer either. The inherited record deliberately skips
    // _finalizeStreaming (it lands mid-turn), but it was still a hard `break` in
    // that function's backward scan, so a reply left open when the turn ended
    // stayed 'streaming' forever — a phantom spinner on a dead, read-only
    // conversation. Every attach runs this path.
    {
      const deadTurn = (marker) => [
        { timestamp: new Date(T).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
        { timestamp: new Date(T + 100).toISOString(), type: 'event_msg', payload: { type: 'agent_message_delta', item_id: 'm1', delta: 'half a reply' } },
        marker('inh-1', 'steer one', 200), marker('inh-2', 'steer two', 300), marker('inh-3', 'steer three', 400),
      ];
      const statuses = (records, Manager = CodexMessageManager) => { const mm = new Manager('dead'); mm.convertHistory(records); return mm.messages.map((m) => `${m.role}:${m.status}`); };
      ok('a reply the wrapper never closed is COMPLETE after a rebuild, not a phantom spinner', statuses(deadTurn(steered)).join(',') === 'assistant:complete,user:complete,user:complete,user:complete', statuses(deadTurn(steered)));
      ok('…exactly as it already was for a typed send', statuses(deadTurn((id, text, ms) => mine({ webui_msg_id: id }, text, ms))).join(',') === 'assistant:complete,user:complete,user:complete,user:complete');
      const ctl5 = loadPatched('src/codex-message-manager.js', [[
        "      if (m.role === 'user' && m.originKind !== 'peer-message' && !m.midTurn) break;",
        "      if (m.role === 'user' && m.originKind !== 'peer-message') break;",
      ]]);
      ok('NEGATIVE CONTROL: without the mid-turn exemption the same records leave the reply streaming forever', statuses(deadTurn(steered), ctl5.CodexMessageManager)[0] === 'assistant:streaming');
      // …and the exemption must not resurrect the fragmentation it replaced:
      // a steered bubble still does NOT close the reply it was injected into.
      const midStream = (marker) => {
        const mm = new CodexMessageManager('mid');
        mm.processLive({ timestamp: new Date(T).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } });
        mm.processLive({ timestamp: new Date(T + 10).toISOString(), type: 'event_msg', payload: { type: 'agent_message_delta', item_id: 'm1', delta: 'first half ' } });
        mm.processLive(marker('inh-1', 'steered mid-stream', 20));
        mm.processLive({ timestamp: new Date(T + 30).toISOString(), type: 'event_msg', payload: { type: 'agent_message_delta', item_id: 'm1', delta: 'second half' } });
        return mm.messages.filter((m) => m.role === 'assistant');
      };
      ok('the steered bubble still does not fragment the reply it was injected into (2.368.16 class)', midStream(steered).length === 1 && (midStream(steered)[0].content || []).map((c) => c.text).join('') === 'first half second half');
      ok('…and the flag rides only the inherited bubble, never a typed one', (() => {
        const mm = new CodexMessageManager('flag');
        mm.processLive(steered('inh-1', 'a', 0)); mm.processLive(mine({ webui_msg_id: 'm1' }, 'b', 10));
        const u = mm.messages.filter((m) => m.role === 'user');
        return u[0].midTurn === true && !u[1].midTurn;
      })());
    }

    // (j6) THE CENSUS. The yield rule above is only as complete as the list of
    // producers that DECLARE their commit order — the round-2 peer regression
    // (test-peer-msg-card, idle path) was exactly a producer nobody had asked
    // the question of. Three writers of a user record exist in the wrapper; a
    // fourth must answer "had the app-server committed it yet?" before it
    // ships, so this count is a gate, not a decoration.
    {
      const cw = read('data/bin/codex-chat-wrapper.js');
      const producers = cw.match(/record\('response_item',[\s\S]{0,300}?role: 'user'/g) || [];
      ok(producers.length === 3, `every wrapper producer of a user record is accounted for: chat-input (early), the inherited-queue bubble (steer early / drain late), the peer copy (queued early / idle late) — found ${producers.length}`, producers.length);
      ok(/webui_after_commit/.test(cw) && (cw.match(/webui_after_commit: true/g) || []).length === 2, 'and exactly the two LATE ones declare it', (cw.match(/webui_after_commit: true/g) || []).length);
    }

    // (j8) ROUND 3 — THE TWIN THAT COULD NEVER COLLAPSE: an ATTACHMENT. The
    // two producers of our own user record spelled the content differently —
    // handleInput hand-rolled `[...attachments, text]` while what codex
    // PERSISTS is what `encodeUserInput` SENT, i.e. text first — so every
    // message with an image rendered TWICE after a reload, in the one branch
    // round 2's comment claimed was "BYTE-IDENTICAL to codex's own rollout
    // copy". MEASURED on the local corpus (97 rollout files, 5489 user
    // records): 0 records start with an `input_image`, every `input_text`
    // block is exactly {type,text}, and 34 of the 40 `input_image` blocks
    // carry a third key `detail` that only codex writes.
    {
      const IMG = 'data:image/png;base64,iVBORw0KGgo=';
      const IMG2 = 'data:image/png;base64,ZZZBORw0KGgo=';
      const imgOurs = (id, text, url, ms, order = 'codex') => ({
        timestamp: new Date(T + ms).toISOString(), type: 'response_item',
        payload: { type: 'message', role: 'user', webui_msg_id: id,
          content: order === 'codex'
            ? [{ type: 'input_text', text }, { type: 'input_image', image_url: url }]
            : [{ type: 'input_image', image_url: url }, { type: 'input_text', text }] },
      });
      const imgTheirs = (id, text, url, ms, extra = {}) => ({
        timestamp: new Date(T + ms).toISOString(), type: 'response_item',
        payload: { type: 'message', id, role: 'user',
          content: [{ type: 'input_text', text }, { type: 'input_image', image_url: url, ...extra }],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-A' } },
      });
      const roll = [turn('turn-A', 0), imgTheirs('msg_i1', 'look at this', IMG, 5000, { detail: 'auto' })];
      ok('an IMAGE + text message is ONE bubble after a reload (both producers now spell the content the same way, and codex\'s own `detail` is out of the key)',
        bubbles(mergeCodexRecords(roll, [imgOurs('m-i1', 'look at this', IMG, 1000)])).length === 1,
        bubbles(mergeCodexRecords(roll, [imgOurs('m-i1', 'look at this', IMG, 1000)])));
      ok('the text-only control on the identical scaffold is unchanged', bubbles(mergeCodexRecords([turn('turn-A', 0), theirs('msg_i0', 'look at this', 5000)], [mine({ webui_msg_id: 'm-i0' }, 'look at this', 1000)])).length === 1);
      // NEGATIVE CONTROL ① — the ORDER: the hand-rolled attachments-first
      // spelling the wrapper used before this round, against the same codex
      // copy. Two bubbles: this is the defect, reproduced.
      ok('NEGATIVE CONTROL: our copy written attachments-FIRST (the old spelling) never collapses — two bubbles for one message',
        bubbles(mergeCodexRecords(roll, [imgOurs('m-i1', 'look at this', IMG, 1000, 'ours')])).length === 2);
      // NEGATIVE CONTROL ② — `detail`: the same records through a store whose
      // block normalisation is patched out.
      const ctl8 = loadPatched('src/codex-session-store.js', [[
        '  if (Array.isArray(bare.content)) bare.content = bare.content.map(normalizeUserContentBlock);\n', '',
      ]]);
      ok('NEGATIVE CONTROL: without normalising the image block, codex\'s own `detail` alone splits the pair',
        bubbles(ctl8.mergeCodexRecords(roll, [imgOurs('m-i1', 'look at this', IMG, 1000)])).length === 2);
      // …and the normalisation must not COLLAPSE two different images: only
      // the fields codex adds are dropped, never the ones that identify it.
      ok('two sends of the same caption with DIFFERENT images stay two bubbles',
        bubbles(mergeCodexRecords([turn('turn-A', 0), imgTheirs('msg_i2', 'same caption', IMG, 5000, { detail: 'auto' }), imgTheirs('msg_i3', 'same caption', IMG2, 5100, { detail: 'auto' })],
          [imgOurs('m-i2', 'same caption', IMG, 1000), imgOurs('m-i3', 'same caption', IMG2, 1100)])).length === 2);
      ok('userContentKey: an image block is compared on {type,image_url}, and a different url is a different key',
        userContentKey({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: IMG, detail: 'auto' }] })
          === userContentKey({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: IMG }] })
        && userContentKey({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: IMG }] })
          !== userContentKey({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: IMG2 }] }));
      // THE WIRING PIN (2.355.0 lesson): the reader half above is only half the
      // fix — our copy has to be SPELLED by the same function that encodes the
      // submission, or the two drift again the next time either is touched.
      const cw8 = read('data/bin/codex-chat-wrapper.js');
      ok('WIRING PIN: handleInput writes the content through userInputToContent(encodeUserInput(…)) — ONE spelling, never a second hand-rolled array',
        /content: userInputToContent\(encodeUserInput\(text, attachments\)\),/.test(cw8)
        && !/attachments\.map\(\(item\) => \(\{ type: 'input_image', image_url: item\.image_url \}\)\)/.test(cw8));
      // …and the THIRD producer of our copy: the SERVER's preview record
      // (CodexAdapter._buildUserPreview → session.buffer, ws-handler). It
      // carries the same webui_msg_id, so it WINS the fingerprint and its
      // content key is the one that claims — a wrapper-only fix changes
      // nothing in production. test-codex-p2-wrapper ⑦(a2) compares the two
      // byte for byte through one client frame; this is the cheap tripwire.
      ok('WIRING PIN: the server-side preview record spells the content the same way — text first, attachments after',
        /const content = \[\n\s*\.\.\.\(text \? \[\{ type: 'input_text', text \}\] : \[\]\),\n\s*\.\.\.attachments\.map\(a => \(\{ type: 'input_image', image_url: a\.image_url \}\)\),\n\s*\];/.test(read('src/adapters/codex.js')));
    }

    // (j9) ROUND 3 — A CLAIM WHOSE TWIN NEVER ARRIVES. Our copy is written
    // BEFORE the submission reaches the app-server, so there are sends that
    // never become a user message at all: a wrapper-served slash command
    // (/compact, /review, /model, /effort — answered by the wrapper itself), an
    // RPC that throws, and a queued item Stop or the user removes before it
    // runs. Round 2 retired a claim only when a DUPLICATE codex record was
    // short-circuited by `seen`; a claim whose twin never existed leaked, and
    // the leaked claim later DELETED a legitimate codex-only record of the same
    // text — round-2 finding ④ through a second back door.
    // THE RULE (round 4): EVERY such case says so OUT OF LINE — the
    // `webui_user_retracted` event, which names the submission by identity (the
    // text can be megabytes of data URL). Round 3 also had a write-time
    // declaration (`webui_no_commit`) for the case the wrapper knows in
    // advance, and it was INERT: a typed message has TWO copies of ours — the
    // wrapper's and the SERVER's preview (CodexAdapter._buildUserPreview →
    // session.buffer, ws-handler) — under the same webui_msg_id, the preview
    // lands FIRST and therefore wins the fingerprint, so the claim was always
    // made under the UNMARKED record. Only a marker on EVERY copy could have
    // worked, and only the wrapper knows which texts are its own slash
    // commands. An id names the submission, and both copies carry the id.
    {
      const noCommit = (id, text, ms) => mine({ webui_msg_id: id, webui_no_commit: true }, text, ms);
      const retract = (id, ms, reason = 'thread/queue/add failed: boom') => ({ timestamp: new Date(T + ms).toISOString(), type: 'event_msg', payload: { type: 'webui_user_retracted', msg_id: id, reason } });
      // ① the slash command, ON THE PRODUCTION SCAFFOLD: the server's preview
      // record (built here by the REAL adapter from one real client frame, as
      // ws-handler builds it) + the wrapper's own copy + the retraction, in
      // turn A; a codex-only '/compact' of the same text in turn B (another
      // client, or the same words after the buffer rotated). Both must render.
      const { CodexAdapter } = require(path.join(REPO, 'src/adapters/codex.js'));
      const preview = (id, text, ms) => ({ ...CodexAdapter._buildUserPreview(text, id), timestamp: new Date(T + ms).toISOString() });
      const slashRoll = [turn('turn-A', 0), turn('turn-B', 60000), theirs('msg_s1', '/compact', 91000, 'turn-B')];
      const slashOurs = [preview('m-s1', '/compact', 900), mine({ webui_msg_id: 'm-s1' }, '/compact', 1000), retract('m-s1', 1010, 'served by the wrapper as a slash command')];
      ok('a wrapper-served /compact never reaches the app-server, so its claim is WITHDRAWN — a later codex-only record of the same text survives',
        bubbles(mergeCodexRecords(slashRoll, slashOurs)).length === 2,
        bubbles(mergeCodexRecords(slashRoll, slashOurs)));
      ok('…and the two copies of ours are still ONE bubble (the preview wins the fingerprint, the wrapper\'s copy folds into it)',
        bubbles(mergeCodexRecords([turn('turn-A', 0)], slashOurs)).length === 1,
        bubbles(mergeCodexRecords([turn('turn-A', 0)], slashOurs)));
      ok('NEGATIVE CONTROL (data): drop the retraction and the leaked claim deletes the turn-B message',
        bubbles(mergeCodexRecords(slashRoll, slashOurs.slice(0, 2))).length === 1);
      // THE ROUND-4 FINDING ITSELF, reproduced against ROUND 3's OWN READER
      // (rebuilt here by patch, so the claim is what r3 shipped). Same code,
      // two scaffolds: r3's leg (wrapper record only) is green, and the
      // production one (the server preview in front of it) deletes the turn-B
      // message — the marker is unreachable because it is not on the copy that
      // claims. A write-time declaration cannot work while a second producer
      // writes the same submission first.
      const ctl9a = loadPatched('src/codex-session-store.js', [[
        '    claims: ours,\n', '    claims: ours && payload.webui_no_commit !== true,\n',
      ]]);
      const r3bubbles = (records) => { const mm = new CodexMessageManager('r3-reader'); for (const r of records) mm.processLive(r); return mm.messages.filter((m) => m.role === 'user').map((m) => (m.content || []).map((c) => c.text || '').join('')); };
      ok('round 3\'s reader, on round 3\'s scaffold (wrapper record only): the marker works — 2 bubbles',
        r3bubbles(ctl9a.mergeCodexRecords(slashRoll, [noCommit('m-s1', '/compact', 1000)])).length === 2);
      ok('THE FINDING: round 3\'s reader on the PRODUCTION scaffold (server preview first) — the marker is inert and the turn-B message is deleted',
        r3bubbles(ctl9a.mergeCodexRecords(slashRoll, [preview('m-s1', '/compact', 900), noCommit('m-s1', '/compact', 1000)])).length === 1,
        r3bubbles(ctl9a.mergeCodexRecords(slashRoll, [preview('m-s1', '/compact', 900), noCommit('m-s1', '/compact', 1000)])));
      // ② the send whose RPC threw, retracted out of line — the SAME scenario
      // an arbitrarily long time later (turn A → turn Z), because the claim
      // ledger is turn-independent by design.
      const farRoll = [turn('turn-A', 0), turn('turn-Z', 600000), theirs('msg_z1', 'continue', 900000, 'turn-Z')];
      const failed = [mine({ webui_msg_id: 'm-f1' }, 'continue', 1000), retract('m-f1', 1500)];
      ok('a send whose RPC threw is RETRACTED, so the codex-only "continue" in a much later turn survives',
        bubbles(mergeCodexRecords(farRoll, failed)).length === 2, bubbles(mergeCodexRecords(farRoll, failed)));
      ok('NEGATIVE CONTROL (data): the same records WITHOUT the retraction event — the leaked claim eats the turn-Z message',
        bubbles(mergeCodexRecords(farRoll, [failed[0]])).length === 1);
      const ctl9b = loadPatched('src/codex-session-store.js', [[
        '    const retractedId = retractionIdOf(record);\n    if (retractedId) {\n      const key = oursByIdentity.get(retractedId);\n      const claimed = key ? (userClaims.get(key) || 0) : 0;\n      if (claimed > 0) userClaims.set(key, claimed - 1);\n    }\n', '',
      ]]);
      ok('NEGATIVE CONTROL (code): a store that ignores the retraction event deletes it too',
        ctl9b.mergeCodexRecords(farRoll, failed).filter((r) => r.payload?.role === 'user').length === 1);
      // ③ THE RETRACTION IS NOT A BLANKET OFF-SWITCH. It withdraws ONE claim,
      // by identity; everything else about the pair rule stands.
      ok('a normal send still collapses with codex\'s commit copy (the retraction only touches the record it names)',
        bubbles(mergeCodexRecords([turn('turn-A', 0), theirs('msg_n1', 'ship it', 5000), theirs('msg_n2', 'other', 5100)],
          [mine({ webui_msg_id: 'm-n1' }, 'ship it', 1000), mine({ webui_msg_id: 'm-n2' }, 'other', 1100), retract('m-n2', 1200)])).length === 3);
      ok('…a retraction naming an id we never emitted is a no-op',
        bubbles(mergeCodexRecords([turn('turn-A', 0), theirs('msg_u1', 'unrelated', 5000)], [mine({ webui_msg_id: 'm-u1' }, 'unrelated', 1000), retract('nobody', 1500)])).length === 1);
      // …and the ledger may not go NEGATIVE: two DIFFERENT retractions naming
      // one record (a remove that raced the Stop sweep, say — same id, two
      // reasons, so `seen` cannot fold them) must withdraw ONE claim, leaving
      // the next legitimate send's claim intact. (An identical retraction from
      // two sources is folded by the fingerprint before it is ever counted.)
      ok('…and two retractions of one record never go negative — the next send\'s twin still collapses',
        bubbles(mergeCodexRecords([turn('turn-A', 0), theirs('msg_d2', 'twice', 30000)],
          [mine({ webui_msg_id: 'm-d1' }, 'twice', 1000), retract('m-d1', 1100, 'removed from the queue before it ran'), retract('m-d1', 1200, 'dropped by Stop before it ran'), mine({ webui_msg_id: 'm-d2' }, 'twice', 2000)])).length === 2,
        bubbles(mergeCodexRecords([turn('turn-A', 0), theirs('msg_d2', 'twice', 30000)],
          [mine({ webui_msg_id: 'm-d1' }, 'twice', 1000), retract('m-d1', 1100, 'removed from the queue before it ran'), retract('m-d1', 1200, 'dropped by Stop before it ran'), mine({ webui_msg_id: 'm-d2' }, 'twice', 2000)])));
      ok('…and the SAME retraction arriving from two sources is folded by the fingerprint, not counted twice',
        bubbles(mergeCodexRecords([turn('turn-A', 0), theirs('msg_e2', 'echo', 30000)],
          [mine({ webui_msg_id: 'm-e1' }, 'echo', 1000), retract('m-e1', 1100), retract('m-e1', 1100), mine({ webui_msg_id: 'm-e2' }, 'echo', 2000)])).length === 2);
      // ④ THE BUBBLE STAYS. A retraction is a fact about the CLAIM ledger, not
      // about the message: the user really did send that text, and the
      // task_failed notice is what reports the failure.
      ok('the retracted message keeps its own bubble (the record is never dropped)',
        bubbles(mergeCodexRecords([turn('turn-A', 0)], [mine({ webui_msg_id: 'm-b1' }, 'never landed', 1000), retract('m-b1', 1500)])).join('') === 'never landed');
      ok('…and the retraction event itself renders NOTHING — a NAMED skip, never an unknown record',
        CodexMessageManager.SKIPPED_EVENT_TYPES.has('webui_user_retracted')
        && ![...CodexMessageManager._seenUnknownRecords].some((k) => /webui_user_retracted/.test(k)),
        JSON.stringify([...CodexMessageManager._seenUnknownRecords]));
      // ⑤ THE PURE FUNCTIONS. Round 4: EVERY copy of ours claims, and only the
      // retraction withdraws — there is no write-time exemption left, because
      // no producer can make one on the copy the merge actually reads.
      ok('userTwinKeys: every copy of OURS claims, codex\'s copy never does',
        userTwinKeys(mine({ webui_msg_id: 'm' }, 'x', 0)).claims === true
        && userTwinKeys(preview('m', 'x', 0)).claims === true
        && userTwinKeys(preview('m', 'x', 0)).ours === true
        && userTwinKeys(theirs('msg_x', 'x', 0)).claims === false);
      ok('retractionIdOf names the event and nothing else',
        retractionIdOf(retract('m-1', 0)) === 'm-1' && retractionIdOf({ type: 'event_msg', payload: { type: 'queue_op_result' } }) === ''
        && retractionIdOf(mine({ webui_msg_id: 'm' }, 'x', 0)) === '' && retractionIdOf(null) === '');
      // THE LEGACY MARKER stays out of every key. Nothing writes it any more,
      // but wrappers are long-lived (dtach survives an update — 2.361.1), so a
      // record from a round-3 wrapper must still key like the same message
      // without it, or those buffers double every typed message on reload.
      ok('the legacy `webui_no_commit` marker is stripped from the merge fingerprint, the twin content key AND the normalizer\'s record key',
        recordFingerprint(noCommit('m-k', 'x', 0), 't') === recordFingerprint(mine({ webui_msg_id: 'm-k' }, 'x', 0), 't')
        && userTwinKeys(noCommit('m-k', 'x', 0)).contentKey === userTwinKeys(mine({ webui_msg_id: 'm-k' }, 'x', 0)).contentKey
        && userTwinKeys(noCommit('m-k', 'x', 0)).contentKey === userTwinKeys(theirs('msg_k', 'x', 0)).contentKey
        && CodexMessageManager.recordKey(noCommit('m-k', 'x', 0)) === CodexMessageManager.recordKey(mine({ webui_msg_id: 'm-k' }, 'x', 0)));
      ok('…and an r3-era buffer still collapses with codex\'s commit copy (the marker no longer suppresses the claim, so the pair retires normally)',
        bubbles(mergeCodexRecords([turn('turn-A', 0), theirs('msg_l1', 'legacy', 30000)], [noCommit('m-l1', 'legacy', 1000)])).length === 1);
      // …and NO producer writes it any more. A marker with a reader rule and no
      // writer is the shape this round removed; a marker with a writer that the
      // preview overrides is the shape it removed BEFORE that.
      ok('NO producer writes `webui_no_commit`: not the wrapper, not the adapter\'s preview, not the ws layer',
        ['data/bin/codex-chat-wrapper.js', 'src/adapters/codex.js', 'src/ws-handler.js']
          .every((f) => !/webui_no_commit\s*:/.test(read(f))));
      // ⑥ WIRING PINS — the reader's rule is dead unless the wrapper speaks it.
      const cw9 = read('data/bin/codex-chat-wrapper.js');
      // ONE GATE (round 4): the same predicate both withdraws the claim and
      // decides that the wrapper serves the text — two gates sharing a regex
      // were what round 3 had, and the declaration they fed was unreachable.
      ok('WIRING PIN: the retraction and the executor are behind ONE gate (one regex, no second spelling to drift)',
        /if \(!attachments\.length && isWrapperSlashCommand\(text\)\) \{\n\s*retractUserRecord\(msg\.msgId, 'served by the wrapper as a slash command'\);\n\s*await applySlashCommand\(text\);\n\s*return;\n\s*\}/.test(cw9)
        // ONE regex object, used by the predicate AND by the executor: a second
        // literal listing the commands is what would drift the two apart.
        && /^const SLASH_COMMAND_RE = /m.test(cw9)
        && /function isWrapperSlashCommand\(text\) \{\n\s*return SLASH_COMMAND_RE\.test/.test(cw9)
        && /const m = SLASH_COMMAND_RE\.exec\(String\(text \|\| ''\)\.trim\(\)\);/.test(cw9)
        && (cw9.match(/\/\^\\\/\(compact\|review\|model\|effort\)/g) || []).length === 1);
      // …and it is withdrawn BEFORE the command runs: /compact takes 1–2
      // minutes, and a wrapper killed inside that window would otherwise leave
      // a claim standing over a message it never sent.
      ok('WIRING PIN: the retraction precedes the await, not the return', cw9.indexOf("retractUserRecord(msg.msgId, 'served by the wrapper as a slash command')") < cw9.indexOf('await applySlashCommand(text);'));
      ok('WIRING PIN: every path where the submission never lands retracts — turn/start, thread/queue/add, an explicit remove, the Stop sweep, a wrapper-served slash command',
        (cw9.match(/retractUserRecord\(/g) || []).length === 6
        && /retractUserRecord\(msg\.msgId \|\| cid, 'thread\/queue\/add failed: '/.test(cw9)
        && /retractUserRecord\(msg\.msgId, 'turn\/start failed: '/.test(cw9)
        && /retractUserRecord\(item\.clientUserMessageId, 'removed from the queue before it ran'\)/.test(cw9)
        && /retractUserRecord\(cid, 'dropped by Stop before it ran'\)/.test(cw9)
        && /retractUserRecord\(msg\.msgId, 'served by the wrapper as a slash command'\)/.test(cw9));
      ok('…and a retraction is only ever emitted for a record we actually wrote', /if \(!msgId \|\| !recordedUserCids\.has\(msgId\)\) return false;/.test(cw9));
    }

    // (j10) ROUND 3, THE SAME RULE FOR THE ONE PRODUCER THAT MINTED NO ID: the
    // QUEUED peer copy. Round 2's major — "two same-text submissions in one
    // turn collapse into one bubble" — was fixed for the steered/typed
    // producers by keying on the id, but the peer record carried none, so two
    // identical agent-to-agent notices inside one turn still lost one on
    // reload. It has an id available all along: the app-server cid it was
    // queued under, carried as the same SECOND-CLASS `webui_queue_id` (it must
    // not be `webui_msg_id`, which suppresses the peer card).
    {
      const peerRec = (cid, body, ms) => ({
        timestamp: new Date(T + ms).toISOString(), type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Message from session "beta" (via vibespace-msg) — ${body}` }], webui_peer: { name: 'beta', body }, ...(cid ? { webui_queue_id: cid } : {}) },
      });
      const two = mergeCodexRecords([turn('turn-A', 0)], [peerRec('peer-1', 'done', 1000), peerRec('peer-2', 'done', 1100)]);
      ok('two peer messages with the SAME text inside one turn stay two labelled cards',
        bubbles(two).length === 2 && (() => { const mm = new CodexMessageManager('pr'); for (const r of two) mm.processLive(r); return mm.messages.filter((m) => m.originKind === 'peer-message').length === 2; })(),
        bubbles(two));
      ok('NEGATIVE CONTROL: the same two records with no submission id (the shipped peer shape) collapse to one — the round-1 major, still open for that producer',
        bubbles(mergeCodexRecords([turn('turn-A', 0)], [peerRec('', 'done', 1000), peerRec('', 'done', 1100)])).length === 1);
      ok('…and the queued peer copy still collapses with codex\'s own commit copy of it',
        bubbles(mergeCodexRecords([turn('turn-A', 0), theirs('msg_p1', 'Message from session "beta" (via vibespace-msg) — done', 30000)], [peerRec('peer-1', 'done', 1000)])).length === 1);
      ok('…and a Stop that drops it retracts by that id, so a later codex-only copy of the same text survives',
        bubbles(mergeCodexRecords([turn('turn-A', 0), turn('turn-B', 60000), theirs('msg_p2', 'Message from session "beta" (via vibespace-msg) — done', 90000, 'turn-B')],
          [peerRec('peer-1', 'done', 1000), { timestamp: new Date(T + 1500).toISOString(), type: 'event_msg', payload: { type: 'webui_user_retracted', msg_id: 'peer-1', reason: 'dropped by Stop before it ran' } }])).length === 2);
    }

    // (j7) THE ROUTING PIN stays: neither reader may go back to dropping the
    // app-server's own carrier in silence.
    ok('`item_completed:UserMessage` is still an EXPLICIT skip in the normalizer, and the wrapper still routes `userMessage`',
      CodexMessageManager.ITEM_COMPLETED_SKIPPED_TYPES.has('UserMessage') && /if \(type === 'userMessage'\)/.test(read('data/bin/codex-chat-wrapper.js')));
    try { fs.rmSync(patchDir, { recursive: true, force: true }); } catch {}
  }
}
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
