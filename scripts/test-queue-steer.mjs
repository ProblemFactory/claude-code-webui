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
    ok('wrapperCaps maps a verb-LESS inputQueue advert to the legacy three (never to the current seven)', /const LEGACY_QUEUE_VERBS = Object\.freeze\(\['remove', 'steer', 'steer-all'\]\)/.test(wf) && /Array\.isArray\(caps && caps\.queueVerbs\)[\s\S]{0,160}inputQueue \? LEGACY_QUEUE_VERBS\.slice\(\) : \[\]/.test(wf), wf.slice(-800));
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
  ok("…and the wrapper's queue advert — SUPPORTED **and the verb list** — rides the SAME payload (the client cannot read a sidecar), and it is computed from the ONE sidecar read the attach handler already made (2.369.16: no second /proc walk here)", /const wcapsAttach = wrapperCaps\(BUFFERS_DIR, data\.sessionId, session\.socketPath\);[\s\S]{0,3000}const wc = wcapsAttach;[\s\S]{0,700}return \{ queueSupported: !!served, queueVerbs: served \|\| \[\] \};/.test(read('src/ws-handler.js')));
  { const wsc = read('src/ws-create.js');
    ok("…'created' carries all three, and says the fresh wrapper has reported NOTHING yet", /queue: \[\],/.test(wsc) && /queueSupported: false,\n\s*queueVerbs: \[\],/.test(wsc)); }
  ok('the client applies both through the carries-the-key guard, advert (and its verb list) FIRST', /if \('queueSupported' in meta\) this\._setQueueSupported\(meta\.queueSupported, meta\.queueVerbs\);\s*\n\s*if \('queue' in meta\) this\._setQueue\(meta\.queue\);/.test(cv));
  // ONE WRITER for the capability, because a FLIP has a consequence (the
  // rendered chips must be re-applied — round-2's MAJOR). A bare assignment
  // anywhere else silently skips it.
  ok('`_queueSupported` has exactly ONE writer besides its initialiser (_setQueueSupported), so every flip is observable',
    (cv.match(/this\._queueSupported = /g) || []).length === 2 && /_setQueueSupported\(next, verbs\) \{[\s\S]{0,700}this\._queueSupported = val;\s*\n\s*this\._queueVerbsServed = list;\s*\n\s*this\._refreshQueueChips\(\);/.test(cv),
    (cv.match(/this\._queueSupported = [^\n]*/g) || []));
  ok('…and the VERB LIST shares that one writer (a wrapper that gains verbs without changing `supported` must re-apply the chips too)',
    (cv.match(/this\._queueVerbsServed = /g) || []).length === 2 && /JSON\.stringify\(list\) === JSON\.stringify\(this\._queueVerbsServed\)/.test(cv),
    (cv.match(/this\._queueVerbsServed = [^\n]*/g) || []));
  ok("…and the live meta path uses it too (a wrapper's baseline queue_changed also arrives after the bubbles), carrying the verbs it published", /if \(op\.supported\) this\._setQueueSupported\(true, op\.verbs \|\| undefined\);/.test(cv));
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
  ok('every queue action passes ONE liveness choke point that toasts (strip buttons included — a dead button that eats the click is the silent failure)', /_queueOpsLive\(\) \{/.test(cv) && /if \(!this\._queueOpsLive\(\)\) return;\s*\n\s*const frame = \{ type: 'queue-op'/.test(cv) && (cv.match(/showToast\(t\('This session is not live/g) || []).length === 1);
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
    ok('an editing row says so, and its edit control becomes a cancel', /data-queue-state="editing"/.test(ChatInput.queueStripHtml(items, CODEX_CAPS, new Map([['q1', { state: 'editing', title: '' }]]))) && /data-queue-op="edit-cancel"/.test(ChatInput.queueStripHtml(items, CODEX_CAPS, new Map([['q1', { state: 'editing', title: '' }]]))));
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
    const empty = mkCI({ _queueCaps: cxCaps, _isStreaming: true, _send: () => null, _onSteerSend: () => { handed = 'NO'; } });
    handed = null;
    ok('an empty composer / disconnected socket / a /goal (all `_send() === null`) reports NO steerable send — a pending steer that can only time out is a lie', empty.steerNow() === false && handed === null);
    const cant = mkCI({ _queueCaps: srvCaps('claude').inputModes, _isStreaming: true, _send: () => { sends++; return 'x'; } });
    ok('steerNow() on a harness that cannot steer sends NOTHING at all', cant.steerNow() === false && sends === 1);
  }
  // _send's new contract, at the source: three null returns and one msgId
  {
    const src = read('src/lib/chat-input.js');
    ok('_send returns the msgId (and null on every non-send path: empty, disconnected, /goal)', /return msgId;/.test(src) && (src.match(/return null;/g) || []).length >= 3, (src.match(/return null;[^\n]*/g) || []));
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
    await esbuild.build({ entryPoints: [path.join(REPO, 'src/lib/chat-input.js')], bundle: true, format: 'iife',  globalName: 'VS',  platform: 'browser',  target: 'es2022',  outfile: bundle, logLevel: 'silent',  loader: { '.css': 'text' }, plugins: [stub] });
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
      const built = await evaljs(`(() => {
        window.__ops = [];
        const ci = new VS.ChatInput({ send(){} }, 'sess-verbs',  { onSend(){}, onInterrupt(){}, onQueueOp: (op, id, extra) => window.__ops.push({ op, id, extra }) });
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
          document.querySelector('[data-queue-op="edit"][data-queue-id="q2"]').click();
          const ta = document.querySelector('textarea');
          return { text: ta.value, ops: window.__ops.length, state: document.querySelector('[data-queue-id="q2"]')?.dataset.queueState, hint: !!document.querySelector('.chat-queue-editing') };
        })()`);
        ok(`the edit control OPENS the queued text (no frame yet — editing is a local mode): ${JSON.stringify(opened)}`, opened.text === 'second' && opened.ops === 0);
        ok('the row says it is being edited, and the strip says how to finish', opened.state === 'editing' && opened.hint === true);
        const saved = await evaljs(`(() => {
          const ta = document.querySelector('textarea');
          ta.value = 'second, rewritten';
          window.__ci._send();
          return { ops: window.__ops, text: ta.value, state: document.querySelector('[data-queue-id="q2"]')?.dataset.queueState };
        })()`);
        ok(`sending SAVES the edit as an edit frame, never as a new message (${JSON.stringify(saved.ops)})`, saved.ops.length === 1 && saved.ops[0].op === 'edit' && saved.ops[0].id === 'q2' && saved.ops[0].extra?.text === 'second, rewritten');
        ok('and the draft the edit borrowed the textarea from is put back', saved.text === 'a draft I was typing');
        ok('the row shows the save is in flight', saved.state === 'pending');
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

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
