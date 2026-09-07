#!/usr/bin/env node
// HARNESS HONESTY (2.369.57) — the four production defects the 2026-09-07
// harness survey found, each with its own reproduction:
//
//  ① codex PERSONALITY. The wrapper hardcoded `personality:'pragmatic'` into
//     thread/start AND turn/start, silently overriding whatever the user's own
//     ~/.codex/config.toml said. Now: the value comes from the per-session
//     response-style slot, DEFAULT = unset = the key is not sent at all, and a
//     running session can be re-styled through `thread/settings/update`
//     (gated on backend-caps `responseStyle.live`, never on a backend id).
//     The accepted values are codex's own Personality enum, read out of
//     `codex app-server generate-json-schema --experimental` — never memory.
//
//  ② SERVER-REQUEST SHAPES. `respondToServerRequest` matched exactly ONE
//     method by name and answered everything else `{decision: …}` — a result
//     the app-server cannot deserialize for four of the eleven ServerRequest
//     methods (permissions wants a GRANT, requestUserInput wants bare
//     `answers`, elicitation wants an `action`, the v1 pair speaks a different
//     enum), i.e. a hung turn nobody could explain. Now: one explicit branch
//     per method, MCP elicitation rendered as the existing question-card
//     family, and anything we cannot answer refused with a JSON-RPC error +
//     a visible system line.
//
//  ③ ACP UNKNOWN UPDATE. `default: return;` dropped unknown sessionUpdate
//     kinds silently — the invisible-record class, twice convicted (claude's
//     `cli-unknown-system-subtype`, codex's `codex-unknown-record`). Now: a
//     once-per-kind telemetry breadcrumb + one console line.
//
//  ④ LIVE/ROLLOUT TWIN. `imageGeneration` and `sleep` had no branch in the
//     wrapper's item chain at all: a generated image was invisible while
//     streaming and a 20-minute sleep looked like a hang. THREE producers feed
//     the same fact (the live wrapper, the rollout parser, codex-thread-read)
//     and they must land on ONE normalized card — this suite pins all three
//     against each other, shape-equal.
//
// Parts 1-4 are node; part 5 is a headless-chrome leg (SKIPs without chrome)
// that proves the image card actually draws from a LIVE item.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const { capsOf, BACKEND_CAPS } = require(path.join(REPO, 'src/backend-caps.js'));
const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
const { threadToRecords } = require(path.join(REPO, 'src/codex-thread-read.js'));
const { AcpMessageManager } = require(path.join(REPO, 'src/acp-message-manager.js'));

// ═════════ the REAL schema, not a hand-written expectation ═════════
// r2 review: the first cut of this suite asserted, byte for byte, a reply that
// the app-server CANNOT deserialize (`execpolicy_amendment` is `string[]`; the
// code sent `[{kind}]`) — a green gate certifying the exact hung-turn class the
// change exists to kill. The cure is to stop hand-writing the expectation:
// every reply is validated against codex's OWN dumped result schema
// (scripts/fixtures/codex-server-request-responses.json, verbatim from
// `codex app-server generate-json-schema --experimental`).
const RESP_SCHEMAS = JSON.parse(read('scripts/fixtures/codex-server-request-responses.json'));
/** draft-07 SUBSET validator — exactly the keywords those dumps use ($ref /
 *  type / enum / const / allOf / anyOf / oneOf / properties / required /
 *  additionalProperties / items). Cross-checked against python jsonschema on a
 *  31-case battery (both directions) while it was written. Returns error
 *  strings; empty = valid. */
function schemaErrors(schema, value, root = schema, at = '$', errs = []) {
  if (schema === true || schema === undefined || schema === null) return errs;
  if (schema === false) { errs.push(`${at}: schema is false`); return errs; }
  if (schema.$ref) {
    const m = /^#\/definitions\/(.+)$/.exec(schema.$ref);
    const target = m ? (root.definitions || {})[m[1]] : null;
    if (!target) { errs.push(`${at}: unresolvable $ref ${schema.$ref}`); return errs; }
    return schemaErrors(target, value, root, at, errs);
  }
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null'
    : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value;
  if (schema.type !== undefined) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!want.some((t) => t === kind || (t === 'number' && kind === 'integer'))) {
      errs.push(`${at}: type ${kind} not in ${JSON.stringify(want)}`);
      return errs;
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errs.push(`${at}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errs.push(`${at}: ${JSON.stringify(value)} !== const`);
  }
  for (const sub of (schema.allOf || [])) schemaErrors(sub, value, root, at, errs);
  if (schema.anyOf && !schema.anyOf.some((sub) => schemaErrors(sub, value, root, at, []).length === 0)) {
    errs.push(`${at}: matched none of anyOf`);
  }
  if (schema.oneOf) {
    const per = schema.oneOf.map((sub) => schemaErrors(sub, value, root, at, []));
    const n = per.filter((e) => e.length === 0).length;
    // A failing oneOf must NAME the field that broke (the whole point here is
    // that `execpolicy_amendment` wants strings) — "matched 0 of oneOf" alone
    // sends the next reader back to the schema by hand.
    if (n === 0) errs.push(`${at}: matched none of oneOf — ${per.map((e, i) => `#${i}: ${e.join('; ')}`).join(' | ').slice(0, 500)}`);
    else if (n > 1) errs.push(`${at}: matched ${n} of oneOf (must be exactly 1)`);
  }
  if (kind === 'object') {
    for (const req of (schema.required || [])) {
      if (!Object.prototype.hasOwnProperty.call(value, req)) errs.push(`${at}: missing required "${req}"`);
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) schemaErrors(props[k], v, root, `${at}.${k}`, errs);
      else if (schema.additionalProperties === false) errs.push(`${at}: additional property "${k}" not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') schemaErrors(schema.additionalProperties, v, root, `${at}.${k}`, errs);
    }
  }
  if (kind === 'array' && schema.items) value.forEach((v, i) => schemaErrors(schema.items, v, root, `${at}[${i}]`, errs));
  return errs;
}

// ═════════ Part 0 — the caps row is the ONE vocabulary ═════════
console.log('— caps row');
{
  for (const id of Object.keys(BACKEND_CAPS)) {
    const rs = BACKEND_CAPS[id].responseStyle;
    ok(rs && typeof rs.live === 'boolean' && typeof rs.closed === 'boolean' && Array.isArray(rs.values), `${id}: declares responseStyle {live, closed, values}`, JSON.stringify(rs));
  }
  ok(capsOf('codex').responseStyle.live === true, 'codex can be re-styled LIVE (thread/settings/update)');
  ok(JSON.stringify(capsOf('codex').responseStyle.values) === JSON.stringify(['none', 'friendly', 'pragmatic']),
    "codex's values ARE the 0.153.4 Personality enum (schema-read, not remembered)", JSON.stringify(capsOf('codex').responseStyle.values));
  ok(capsOf('claude').responseStyle.live === false && capsOf('claude').responseStyle.values.length === 4,
    'claude is spawn-only (--settings outputStyle) with its four output styles');
  // OPEN vs CLOSED is not decoration: claude's ~/.claude/output-styles/*.md are
  // real user-defined styles, so `values` there is only what the PICKER offers
  // and validating a spawn against it would silently eat a user's own style.
  ok(capsOf('codex').responseStyle.closed === true && capsOf('claude').responseStyle.closed === false,
    "codex's enum is CLOSED (the RPC rejects anything else); claude's is OPEN (custom output-style files)");
  {
    const wc = read('src/ws-create.js');
    ok(/return \(!rs\.closed \|\| rs\.values\.includes\(want\)\) \? want : '';/.test(wc),
      'ws-create drops an out-of-enum value ONLY for a closed vocabulary (an open one passes through)');
    const whs = read('src/ws-handler.js');
    ok(/if \(style && rs\.closed && !rs\.values\.includes\(style\)\)/.test(whs), 'the ws case applies the same open/closed rule');
  }
  ok(capsOf('shell').responseStyle.values.length === 0 && capsOf('opencode').responseStyle.values.length === 0,
    'shell + opencode declare no style knob at all (the chip is not drawn)');
  ok(capsOf('gemini').responseStyle.live === false && capsOf('gemini').responseStyle.values.length === 0,
    "an unknown backend gets the no-knob row (never codex's by accident)");
  const BM = await import(path.join(REPO, 'src/lib/agent-meta.js'));
  for (const id of Object.keys(BM.BACKEND_META)) {
    const caps = BM.BACKEND_META[id].caps;
    if (!caps) continue; // shell carries no caps object
    ok(JSON.stringify(caps.responseStyle) === JSON.stringify(capsOf(id).responseStyle),
      `${id}: client META caps.responseStyle deep-equals the server row (no drift)`, JSON.stringify({ client: caps.responseStyle, server: capsOf(id).responseStyle }));
  }
  ok(BM.responseStyleLabel('codex', 'friendly').startsWith('friendly — '), 'a picker label is the PROTOCOL value + its hint (the value itself is never translated)', BM.responseStyleLabel('codex', 'friendly'));
  ok(BM.responseStyleLabel('codex', 'made-up') === 'made-up', 'a value with no hint labels as itself');
  const sb = read('src/lib/chat-status-bar.js');
  // r2: the row is gated on the HARNESS caps row AND the RUNNING WRAPPER's own
  // advert — with caps alone, every codex session spawned before the live
  // switch got a refusal, no restart row and an invisible saved pick.
  ok(/if \(!styleAppliesLive\(caps, this\._responseStyleLive\) && this\._onRestartSession/.test(sb),
    'the "Restart now to apply" row is gated on styleAppliesLive(caps, wrapper advert) — never on a backend id');
  ok(/if \(styleAppliesLive\(caps, this\._responseStyleLive\)\) \{/.test(sb), '…and so is the choice between "send the live verb" and "save it for the next resume"');
  ok(!/showToast\(s\.v \? t\('Response style .{0,40}applies from the next turn/.test(sb),
    'the live-switch SUCCESS toast is NOT fired at click time (it announced a switch the server was about to refuse)');
  {
    const cv = read('src/lib/chat-view.js');
    ok(/if \(msg\.live\) showToast\(msg\.outputStyle/.test(cv), '…it fires on the server\u2019s response-style-updated ECHO instead');
    ok(/if \('responseStyleLive' in meta\) this\._statusBar\?\.setResponseStyleLive\?\.\(meta\.responseStyleLive\)/.test(cv),
      'the client learns the wrapper advert from the attach payload (carries-the-key guard, like queueSupported)');
    ok(/if \(msg\.code === 'style-wrapper-old'\) this\._statusBar\?\.setResponseStyleLive\?\.\(false\)/.test(cv),
      "only the 'style-wrapper-old' refusal flips the flag (self-heal, no reload) — a transient/other refusal changes no belief");
    ok(!/if \(msg\.code === 'style-not-live'\) this\._statusBar/.test(cv),
      "…and 'style-not-live' does NOT: it also covers a sidecar not written yet and a session that just died (the 2.363.1 one-code-many-meanings law)");
    ok(/setResponseStyleLive\(v\) \{ this\._responseStyleLive = \(v === undefined \|\| v === null\) \? undefined/.test(sb),
      'null on the wire (server: "the wrapper has not reported yet") is UNKNOWN on the client, never false');
    ok(/responseStyleLive: wcapsAttach\./.test(read('src/ws-handler.js')) && /const wcapsAttach = wrapperCaps\(/.test(read('src/ws-handler.js')),
      'the server publishes that advert on attach, from the SAME sidecar read as queueSupported (resolveWrapperFiles walks /proc when the sidecar is missing)');
    ok(/NO `responseStyleLive` here, deliberately/.test(read('src/ws-create.js')), 'the created payload states WHY it cannot know yet (undefined = try it)');
  }
  // the PURE predicate itself (a DOM-free client rule needs a functional test)
  {
    const LIVE = { live: true, closed: true, values: ['none'] }, SPAWN = { live: false, closed: false, values: ['Concise'] };
    ok(BM.styleAppliesLive(LIVE, undefined) === true, 'styleAppliesLive: live harness, wrapper not yet known ⇒ TRY it');
    ok(BM.styleAppliesLive(LIVE, true) === true, 'styleAppliesLive: live harness + a wrapper that adverts it ⇒ live');
    ok(BM.styleAppliesLive(LIVE, false) === false, 'styleAppliesLive: live harness but an OLD wrapper ⇒ needs a restart');
    ok(BM.styleAppliesLive(SPAWN, true) === false, 'styleAppliesLive: a spawn-only harness is never live, whatever the wrapper says');
    ok(BM.styleAppliesLive(null, true) === false, 'styleAppliesLive: no caps row ⇒ never live');
  }
  // …and the ORIGIN label rule (r2: it called the instance default "your
  // choice" whenever ANY pick existed, contradicting the note beside it)
  {
    ok(BM.responseStyleOrigin('Concise', 'Concise') === 'chosen', 'origin: live === picked ⇒ the user\u2019s choice');
    ok(BM.responseStyleOrigin('Explanatory', 'Concise') === 'spawn', 'origin: a DIFFERENT pick is saved ⇒ the live value is what the session started with (never "your choice")');
    ok(BM.responseStyleOrigin('Explanatory', undefined) === 'instance', 'origin: no pick here ⇒ the instance default');
    ok(BM.responseStyleOrigin('Explanatory', null) === 'spawn', 'origin: a CLEARED pick still differs from the live value');
    ok(BM.responseStyleOrigin('', 'Concise') === 'saved', 'origin: stopped session + a pick ⇒ saved for the next resume');
    ok(BM.responseStyleOrigin('', undefined) === 'harness', 'origin: nothing anywhere ⇒ the harness default');
    ok(/const origin = ORIGIN_LABEL\[responseStyleOrigin\(live, picked\)\]\(\)/.test(read('src/lib/session-props.js')),
      'Session Properties uses that ONE rule (wiring pin — a pure fix with no call site is dead code)');
  }
  ok(!/=== 'codex'|=== 'claude'/.test(sb.slice(sb.indexOf('const styleEl'), sb.indexOf('const effortEl'))), 'the style menu contains no backend-id branch');
  ok(/const STYLES = \[\{ v: '', label: t\('agent default'\) \}, \.\.\.caps\.values\.map/.test(sb), 'the menu rows ARE the caps values (no hardcoded list)');
  const wh = read('src/ws-handler.js');
  ok(/case 'set-response-style'/.test(wh) && /capsOf\(session\.backend\)\.responseStyle/.test(wh) && /code = 'style-not-live'/.test(wh) && /scope: 'action'/.test(wh),
    "ws 'set-response-style' gates on the caps row and refuses with a coded, scope:'action' error");
  ok(/const wcaps = wrapperCaps\(BUFFERS_DIR, data\.sessionId, session\.socketPath\);\s*\n\s*if \(!wcaps\.responseStyle\)/.test(wh),
    '…and on the RUNNING wrapper\u2019s own advert too (a session spawned before this release drops the verb silently)');
  ok(/wcaps\.reason === 'no-sidecar' \? 'style-not-live' : 'style-wrapper-old'/.test(wh),
    '…and the two refusals carry DIFFERENT codes: "restart to change it" vs "not reported yet, try again"');
  ok(/responseStyleLive: wcapsAttach\.reason === 'no-sidecar' \? null : !!wcapsAttach\.responseStyle/.test(wh),
    'the attach advert is TRI-STATE: a sidecar not written yet is null (unknown), never a false that would wear a restart row');
  ok(/responseStyle: !!\(caps && caps\.responseStyle\)/.test(read('src/server/wrapper-files.js')), 'wrapperCaps reads that advert from the sidecar the WRAPPER writes (never session-meta \u2014 the 2.364.1 lesson)');
  // RESTART SURVIVAL: a live style must not evaporate when the server restarts
  // (the chip would report "default" for a session really running one).
  ok(/outputStyle: session\._outputStyle \|\| null,/.test(read('src/ws-create.js')) && /writeSessionMeta\(session\.sockName, \{ \.\.\.m, outputStyle: session\._outputStyle \}\)/.test(wh),
    'the effective style is written to session meta at spawn AND on every live change');
  ok((read('src/server/boot-restore.js').match(/_outputStyle: meta\.outputStyle \|\| null,/g) || []).length === 3,
    'boot-restore reads it back on ALL THREE session-construction paths (a dead persistence write is worse than none)');
  ok(/_outputStyle:\s+\{ owner: 'ws',\s+persisted: 'session-meta'/.test(read('src/session-schema.js')), 'the session-schema row names its real persistence home');
}

// ═════════ Part 1 + 2 — the REAL wrapper against a stub app-server ═════════
console.log('— wrapper vs a stub app-server (personality + every ServerRequest shape)');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-honesty-'));
const SID = 'sess-h-1700000000009';
const buf = path.join(dir, SID + '.buf'), metaFile = path.join(dir, SID + '.json'), rpcLog = path.join(dir, 'rpc.jsonl'), repliesLog = path.join(dir, 'replies.jsonl');
// The stub logs every REQUEST we send it AND every REPLY we send to ITS
// requests — the reply shapes are the whole point of ②.
// EVERY ServerRequest method in one table — lifted OUT of the stub source so
// the schema-validation pass below can map a reply id back to its METHOD from
// the same literal the stub sends (r2: a hand-copied map is the twin that
// drifts). 900-906/912-914 are human-answerable, 907 is auto-answered and
// 908-911 must be refused.
const SERVER_REQS = [
  { id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'th-h', turnId: 't1', itemId: 'i900', command: ['rm', '-rf', '/tmp/x'], cwd: '/tmp', proposedExecpolicyAmendment: ['allow rm'] } },
  { id: 901, method: 'item/fileChange/requestApproval', params: { threadId: 'th-h', turnId: 't1', itemId: 'i901', reason: 'edit', changes: {} } },
  { id: 902, method: 'item/permissions/requestApproval', params: { threadId: 'th-h', turnId: 't1', itemId: 'i902', cwd: '/tmp', startedAtMs: 1, permissions: { fileSystem: { read: ['/tmp'] }, network: { enabled: true } } } },
  { id: 903, method: 'item/tool/requestUserInput', params: { threadId: 'th-h', turnId: 't1', itemId: 'i903', isBlocking: true, questions: [{ id: 'q1', header: 'Pick', question: 'Which layout?' , options: [{ label: 'grid', description: '' }, { label: 'list', description: '' }] }] } },
  { id: 904, method: 'mcpServer/elicitation/request', params: { threadId: 'th-h', serverName: 'weather', mode: 'form', message: 'Where are you?', requestedSchema: { type: 'object', required: ['city'], properties: { city: { type: 'string', title: 'City' }, metric: { type: 'boolean', title: 'Use metric' } } } } },
  { id: 905, method: 'applyPatchApproval', params: { conversation_id: 'c', call_id: 'i905', file_changes: {} } },
  { id: 906, method: 'execCommandApproval', params: { conversation_id: 'c', call_id: 'i906', command: ['ls'], cwd: '/tmp' } },
  { id: 912, method: 'mcpServer/elicitation/request', params: { threadId: 'th-h', serverName: 'auth', mode: 'url', elicitationId: 'e1', message: 'Finish signing in', url: 'https://example.org/login' } },
  { id: 913, method: 'item/permissions/requestApproval', params: { threadId: 'th-h', turnId: 't1', itemId: 'i913', cwd: '/tmp', startedAtMs: 1, permissions: { fileSystem: { write: ['/etc'] } } } },
  // a SECOND command approval — answered below with a frame the REAL ADAPTER
  // built, i.e. the only shape production can actually produce (r2 review).
  { id: 914, method: 'item/commandExecution/requestApproval', params: { threadId: 'th-h', turnId: 't1', itemId: 'i914', command: 'rm -rf /tmp/y', cwd: '/tmp', startedAtMs: 1, proposedExecpolicyAmendment: ['allow rm'] } },
  // answered WITHOUT a human: a fact we simply know
  { id: 907, method: 'currentTime/read', params: {} },
  // refused: values only a client that OWNS them can produce
  { id: 908, method: 'attestation/generate', params: {} },
  { id: 909, method: 'item/tool/call', params: { toolName: 'x' } },
  { id: 910, method: 'account/chatgptAuthTokens/refresh', params: {} },
  { id: 911, method: 'totally/unknown/method', params: {} },
];
const STUB = `
const fs = require('fs');
let b = ''; let turns = 0;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const REQS = ${JSON.stringify(SERVER_REQS)};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  b += d; let i;
  while ((i = b.indexOf('\\n')) !== -1) {
    const line = b.slice(0, i); b = b.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method) { fs.appendFileSync(${JSON.stringify(rpcLog)}, line + '\\n'); }
    else { fs.appendFileSync(${JSON.stringify(repliesLog)}, line + '\\n'); continue; }   // a REPLY to one of OUR requests
    if (m.method === 'thread/start') { send({ id: m.id, result: { thread: { id: 'th-h' } } }); continue; }
    if (m.method === 'turn/start') {
      turns++; const tid = 'turn-' + turns;
      send({ id: m.id, result: { turn: { id: tid } } });
      send({ method: 'turn/started', params: { turn: { id: tid } } });
      if (turns === 1) {
        // ④ the LIVE media/sleep items
        send({ method: 'item/started', params: { threadId: 'th-h', turnId: tid, item: { type: 'imageGeneration', id: 'exec-img1', status: 'inProgress', result: '' } } });
        send({ method: 'item/completed', params: { threadId: 'th-h', turnId: tid, item: { type: 'imageGeneration', id: 'exec-img1', status: 'completed', revisedPrompt: 'a red van', result: 'BASE64PAYLOAD'.repeat(500), transparentBackground: false, failure: null, savedPath: '/tmp/gen/exec-img1.png' } } });
        send({ method: 'item/started', params: { threadId: 'th-h', turnId: tid, item: { type: 'sleep', id: 'call_s1', durationMs: 30000 } } });
        send({ method: 'item/completed', params: { threadId: 'th-h', turnId: tid, item: { type: 'sleep', id: 'call_s1', durationMs: 30000 } } });
        // ② every ServerRequest method, in one burst
        for (const r of REQS) send(r);
      }
      continue;
    }
    if (m.method === 'turn/interrupt') {
      send({ id: m.id, result: {} });
      send({ method: 'turn/completed', params: { turn: { id: 'turn-' + turns }, status: 'interrupted' } });
      continue;
    }
    send({ id: m.id, result: {} });
  }
});
setInterval(() => {}, 1e3);
`;
const spawnWrapper = (env) => spawn(process.execPath, [path.join(REPO, 'data/bin/codex-chat-wrapper.js'), buf, metaFile, process.execPath, '-e', STUB], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CODEX_WEBUI_CWD: dir, VIBESPACE_API: '', VIBESPACE_SESSION_TOKEN: '', VIBESPACE_SKIP_AGENT_HOOKS: '1', ...env },
});
let w = spawnWrapper({});
let out = ''; w.stdout.on('data', (d) => { out += d; });
w.stderr.on('data', () => {});
const jsonl = (fp) => { try { return fs.readFileSync(fp, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const rpc = () => jsonl(rpcLog);
const replies = () => jsonl(repliesLog);
const events = () => out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const readMeta = () => { try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { return null; } };
const waitFor = async (pred, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(80); } return pred(); };
const sendLine = (o) => w.stdin.write(JSON.stringify(o) + '\n');

ok(await waitFor(() => readMeta()?.threadId === 'th-h'), 'wrapper handshake against the stub app-server');

// ① NO personality key by default
{
  const ts = rpc().find((m) => m.method === 'thread/start');
  ok(ts && !('personality' in ts.params), 'thread/start carries NO personality key when the user chose nothing (the config.toml choice stands)', JSON.stringify(ts?.params));
}
sendLine({ type: 'chat-input', text: 'go', msgId: 'm1' });
ok(await waitFor(() => rpc().some((m) => m.method === 'turn/start')), 'a turn starts');
{
  const t = rpc().find((m) => m.method === 'turn/start');
  ok(t && !('personality' in t.params), 'turn/start carries NO personality key either', JSON.stringify(Object.keys(t?.params || {})));
}
ok(readMeta()?.caps?.responseStyle === true, 'the wrapper adverts caps.responseStyle in the sidecar IT writes (the 2.361.1/2.364.1 skew rule)');
ok(readMeta()?.personality === '', 'the sidecar reports the EFFECTIVE style — empty = the agent decides', JSON.stringify(readMeta()?.personality));

// ① a LIVE change → thread/settings/update
sendLine({ type: 'set-response-style', style: 'friendly' });
ok(await waitFor(() => rpc().some((m) => m.method === 'thread/settings/update')), 'a live style change sends thread/settings/update');
{
  const u = rpc().find((m) => m.method === 'thread/settings/update');
  ok(u.params.threadId === 'th-h' && u.params.personality === 'friendly', '…with {threadId, personality} exactly as the 0.153.4 schema names them', JSON.stringify(u.params));
  ok(await waitFor(() => readMeta()?.personality === 'friendly'), 'the sidecar now reports the new effective style');
  ok(events().some((e) => e.payload?.type === 'command_applied' && e.payload.command === 'style' && e.payload.value === 'friendly'), 'the change is VISIBLE in the transcript (command_applied)');
}
// an out-of-enum value is refused LOUDLY and never sent
{
  const before = rpc().filter((m) => m.method === 'thread/settings/update').length;
  sendLine({ type: 'set-response-style', style: 'sassy' });
  ok(await waitFor(() => events().some((e) => e.payload?.type === 'task_failed' && /Unknown response style "sassy"/.test(e.payload.error || ''))), 'an out-of-enum style is refused with the accepted list, never sent');
  ok(rpc().filter((m) => m.method === 'thread/settings/update').length === before, '…and no RPC left the wrapper');
  ok(readMeta()?.personality === 'friendly', '…and the effective style is unchanged');
}

// ② every ServerRequest method's reply shape
const replyFor = (id) => replies().find((r) => r.id === id);
ok(await waitFor(() => replyFor(907) && replyFor(908) && replyFor(909) && replyFor(910) && replyFor(911)), 'the auto/unsupported requests are answered WITHOUT a human');
ok(typeof replyFor(907)?.result?.currentTimeAt === 'number' && Math.abs(replyFor(907).result.currentTimeAt - Math.floor(Date.now() / 1000)) < 120,
  'currentTime/read is answered automatically with {currentTimeAt} in SECONDS (a card here would hang the turn)', JSON.stringify(replyFor(907)));
for (const [id, name] of [[908, 'attestation/generate'], [909, 'item/tool/call'], [910, 'account/chatgptAuthTokens/refresh'], [911, 'totally/unknown/method']]) {
  const r = replyFor(id);
  ok(r && r.error && r.error.code === -32601 && !('result' in r), `${name} is refused with a JSON-RPC ERROR — never a wrong-shaped result, never a hang`, JSON.stringify(r));
}
ok(await waitFor(() => events().filter((e) => e.payload?.type === 'client_request_unsupported').length >= 4), 'each refusal also leaves a VISIBLE record (client_request_unsupported)');
ok(!Object.keys(readMeta()?.pendingRequests || {}).some((k) => ['907', '908', '909', '910', '911'].includes(k)), 'none of them ever became a pending card', JSON.stringify(Object.keys(readMeta()?.pendingRequests || {})));
ok(await waitFor(() => ['900', '901', '902', '903', '904', '905', '906', '912', '913', '914'].every((k) => readMeta()?.pendingRequests?.[k])), 'the ten human-answerable requests ARE pending cards', JSON.stringify(Object.keys(readMeta()?.pendingRequests || {})));

// each one answered through the SAME client frame the UI sends
sendLine({ type: 'permission-response', requestId: 900, approved: true, permissionUpdates: [{ kind: 'allow' }], toolInput: {} });
ok(await waitFor(() => replyFor(900)), 'commandExecution approval answered');
// r2 REGRESSION — the one branch that did not validate was the one the first
// cut of this gate certified: `execpolicy_amendment` is `string[]` in the
// dumped schema (execpolicy RULE LINES) while the client's `permissionUpdates`
// is `[{kind}]`, so the wrapper must never build an amendment out of it. A
// plain accept is what the button promised, and it deserializes.
ok(JSON.stringify(replyFor(900).result) === JSON.stringify({ decision: 'accept' }),
  'commandExecution: the client’s option objects NEVER become an execpolicy amendment (the schema says string[]) — a plain accept', JSON.stringify(replyFor(900).result));
sendLine({ type: 'permission-response', requestId: 901, approved: true, alwaysAllow: true, permissionUpdates: [{ kind: 'allow' }] });
ok(await waitFor(() => replyFor(901)), 'fileChange approval answered');
ok(JSON.stringify(replyFor(901).result) === JSON.stringify({ decision: 'acceptForSession' }),
  'fileChange has NO amendment variant — "always" is acceptForSession, nothing invented', JSON.stringify(replyFor(901).result));
sendLine({ type: 'permission-response', requestId: 902, approved: true });
ok(await waitFor(() => replyFor(902)), 'permissions approval answered');
ok(JSON.stringify(replyFor(902).result) === JSON.stringify({ permissions: { fileSystem: { read: ['/tmp'] }, network: { enabled: true } }, scope: 'turn' }),
  'permissions wants a GRANT, not a decision: approving hands back the requested profile', JSON.stringify(replyFor(902).result));
// the round-trip the AskUserQuestion UI actually produces: answers keyed by the
// question TEXT, each a PLAIN STRING (both of which the old code dropped)
sendLine({ type: 'permission-response', requestId: 903, approved: true, toolInput: { answers: { 'Which layout?': 'grid' } }, responseData: { decision: 'accept', answers: { 'Which layout?': 'grid' } } });
ok(await waitFor(() => replyFor(903)), 'requestUserInput answered');
ok(JSON.stringify(replyFor(903).result) === JSON.stringify({ answers: { q1: { answers: ['grid'] } } }),
  'requestUserInput → bare {answers} keyed by QUESTION ID, plain-string answer accepted (the UI keys by text)', JSON.stringify(replyFor(903).result));
sendLine({ type: 'permission-response', requestId: 904, approved: true, toolInput: { answers: { 'Where are you? — City': 'Tokyo', 'Where are you? — Use metric': 'true' } }, responseData: { decision: 'accept', answers: { 'Where are you? — City': 'Tokyo', 'Where are you? — Use metric': 'true' } } });
ok(await waitFor(() => replyFor(904)), 'MCP elicitation answered');
ok(JSON.stringify(replyFor(904).result) === JSON.stringify({ action: 'accept', content: { city: 'Tokyo', metric: true } }),
  'elicitation → {action:"accept", content} with each property TYPED per the requestedSchema (metric is a boolean, not "true")', JSON.stringify(replyFor(904).result));
sendLine({ type: 'permission-response', requestId: 905, approved: false });
ok(await waitFor(() => replyFor(905)), 'v1 applyPatchApproval answered');
ok(JSON.stringify(replyFor(905).result) === JSON.stringify({ decision: { denied: { rejection: 'Denied by the user in VibeSpace.' } } }),
  'the v1 pair speaks ReviewDecision: a denial is {denied:{rejection}} — NOT "decline"', JSON.stringify(replyFor(905).result));
sendLine({ type: 'permission-response', requestId: 906, approved: true, alwaysAllow: true });
ok(await waitFor(() => replyFor(906)), 'v1 execCommandApproval answered');
ok(JSON.stringify(replyFor(906).result) === JSON.stringify({ decision: 'approved_for_session' }),
  '…and its "always" is approved_for_session, not acceptForSession', JSON.stringify(replyFor(906).result));

// a URL-mode elicitation carries no schema: accepting it sends the ACTION only
// (`content` is nullable — an empty object is a different statement)
sendLine({ type: 'permission-response', requestId: 912, approved: true, toolInput: {} });
ok(await waitFor(() => replyFor(912)), 'url-mode elicitation answered');
ok(JSON.stringify(replyFor(912).result) === JSON.stringify({ action: 'accept' }), 'a url-mode accept omits `content` entirely', JSON.stringify(replyFor(912).result));
// a DENIED permissions request grants NOTHING and is labelled Denied — the
// label is decided by the shape we build, not by "does the profile look empty"
sendLine({ type: 'permission-response', requestId: 913, approved: false });
ok(await waitFor(() => replyFor(913)), 'permissions denial answered');
ok(JSON.stringify(replyFor(913).result) === JSON.stringify({ permissions: { fileSystem: null, network: null }, scope: 'turn' }), 'denying a permissions request grants nothing', JSON.stringify(replyFor(913).result));
ok(events().some((e) => e.type === 'server_request_resolved' && e.payload.id === 913 && e.payload.decision === 'decline')
  && events().some((e) => e.type === 'server_request_resolved' && e.payload.id === 902 && e.payload.decision === 'granted'),
  'the resolved record labels a GRANT and a DENY apart (both are `{permissions}` on the wire)',
  JSON.stringify(events().filter((e) => e.type === 'server_request_resolved').map((e) => [e.payload.id, e.payload.decision])));

// ② r2 — the ADAPTER-BUILT frame, i.e. the only permission-response shape
// production can actually produce (src/ws-handler.js 'permission-response' →
// adapter.formatPermissionResponse). The first cut only ever wrote hand-made
// frames to stdin, so a branch that no product path could reach was "covered".
{
  const { CodexAdapter } = require(path.join(REPO, 'src/adapters/codex.js'));
  const ad = new CodexAdapter({ codexCmd: 'codex', chatWrapper: '/w' });
  const frame = ad.formatPermissionResponse({ requestId: 914, approved: true, toolInput: {}, permissionUpdates: [{ kind: 'allow_always' }] });
  ok(!/permissionUpdates/.test(frame), 'the adapter does NOT forward the client\u2019s permissionUpdates \u2014 it carries only the alwaysAllow BOOLEAN', frame.slice(0, 200));
  w.stdin.write(frame + '\n');
  ok(await waitFor(() => replyFor(914)), 'an ADAPTER-built "Always Allow" is answered');
  ok(JSON.stringify(replyFor(914).result) === JSON.stringify({ decision: 'acceptForSession' }),
    '\u2026with acceptForSession \u2014 a SESSION-scoped promise, never a persistent execpolicy amendment the user never asked for', JSON.stringify(replyFor(914).result));
}

// ② r2 — EVERY reply validated against codex's OWN result schema. This is the
// assert that would have failed the shipped `[{kind}]` amendment; the per-method
// expectations above stay because they pin the DECISION, this one pins that the
// decision is even deserializable.
{
  const methodOf = new Map(SERVER_REQS.map((r) => [r.id, r.method]));
  const answered = replies().filter((r) => 'result' in r);
  ok(answered.length >= 11, 'every request got a reply to validate', String(answered.length));
  for (const r of answered) {
    const method = methodOf.get(r.id);
    const sch = RESP_SCHEMAS.byMethod[method];
    if (!sch) { ok(false, `no vendored schema for ${method} \u2014 a new answerable method needs its dump in the fixture`); continue; }
    const errs = schemaErrors(sch, r.result);
    ok(errs.length === 0, `reply to ${method} validates against ${RESP_SCHEMAS.fileByMethod[method]} (codex ${RESP_SCHEMAS.codexVersion})`, errs.join(' | ') + ' :: ' + JSON.stringify(r.result).slice(0, 200));
  }
  // NEGATIVE CONTROL: the validator is not vacuous — the exact payload this
  // suite used to certify is rejected, naming the field.
  const bad = schemaErrors(RESP_SCHEMAS.byMethod['item/commandExecution/requestApproval'],
    { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: [{ kind: 'allow' }] } } });
  ok(bad.length > 0 && /execpolicy_amendment/.test(bad.join(' ')), 'negative control: the OLD amendment payload (option objects) FAILS the real schema', bad.join(' | '));
  const bad2 = schemaErrors(RESP_SCHEMAS.byMethod['item/tool/requestUserInput'], { decision: 'accept' });
  ok(bad2.length > 0, 'negative control: `{decision}` is not a requestUserInput answer (the pre-2.369.57 one-shape-fits-all)', bad2.join(' | '));
  const good = schemaErrors(RESP_SCHEMAS.byMethod['item/commandExecution/requestApproval'],
    { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['allow rm'] } } });
  ok(good.length === 0, 'positive control: the amendment IS legal when it carries the server\u2019s own rule STRINGS (a future UI may send it)', good.join(' | '));
}

// ② r2 — the vendored schema is a COPY of an upstream file: when the codex
// binary is here, re-dump and diff it, so an upstream shape change fails loudly
// instead of rotting in the fixture. No binary = an explicit SKIP with evidence.
{
  let cx = '';
  try { cx = execSync('command -v codex', { encoding: 'utf8' }).trim(); } catch { }
  if (!cx) {
    console.log('  SKIP: no `codex` on PATH — the fixture-vs-live schema diff did not run (the fixture still gates every reply)');
  } else {
    const dumpDir = path.join(dir, 'schema-dump');
    fs.mkdirSync(dumpDir, { recursive: true });
    let dumped = true;
    try { execSync(`codex app-server generate-json-schema --experimental --out ${dumpDir}`, { env: { ...process.env, CODEX_HOME: path.join(dir, 'no-such-home') }, stdio: 'ignore' }); }
    catch { dumped = false; }
    if (!dumped) console.log('  SKIP: `codex app-server generate-json-schema` failed here — fixture diff skipped');
    else {
      let ver = '?';
      try { ver = execSync('codex --version', { encoding: 'utf8' }).trim(); } catch { }
      for (const [method, file] of Object.entries(RESP_SCHEMAS.fileByMethod)) {
        const live = JSON.parse(fs.readFileSync(path.join(dumpDir, file + '.json'), 'utf8'));
        ok(JSON.stringify(live) === JSON.stringify(RESP_SCHEMAS.byMethod[method]),
          `fixture matches the INSTALLED codex (${ver}) for ${method}`, 'the dump changed upstream — re-vendor the fixture and re-check every reply builder');
      }
    }
  }
}

// the elicitation CARD: rows travel with the record, and the normalizer renders
// them through the AskUserQuestion family
const wrapperRecords = () => events();
{
  const rec = wrapperRecords().find((r) => r.type === 'server_request' && r.payload?.method === 'mcpServer/elicitation/request');
  ok(rec && Array.isArray(rec.payload.questions) && rec.payload.questions.length === 2 && rec.payload.questions[0].id === 'city',
    'the elicitation record carries its derived question rows (ONE derivation feeds the card AND the reply mapping)', JSON.stringify(rec?.payload?.questions));
  const mm = new CodexMessageManager('honesty');
  mm.convertHistory(wrapperRecords());
  const card = mm.messages.find((m) => m.permission?.method === 'mcpServer/elicitation/request');
  ok(card && card.permission.kind === 'user_input' && card.permission.questions.length === 2 && /^MCP: weather$/.test(card.toolName),
    'it renders as the SAME question-card family (kind user_input), named for the MCP server', JSON.stringify({ kind: card?.permission?.kind, tool: card?.toolName }));
  ok(card && card.permission.resolved === 'allowed', 'and the accepted reply resolves the card (action "accept" counts as allowed)', String(card?.permission?.resolved));
  const sys = mm.messages.filter((m) => m.role === 'system').map((m) => m.content?.[0]?.text || '');
  ok(sys.some((tx) => /attestation\/generate.*cannot answer/s.test(tx)), 'an unanswerable request prints a system line naming the method', sys.filter((x) => /cannot answer/.test(x)).slice(0, 1).join(' | '));
  // ④ the LIVE half of the three-producer parity
  const liveCards = mm.messages.filter((m) => m.role === 'tool' && ['image_gen', 'sleep'].includes(m.toolName));
  ok(liveCards.length === 2, 'the live stream produced BOTH media cards (image_gen + sleep)', liveCards.map((m) => m.toolName).join(','));
  global.__liveCards = liveCards;
  const raw = JSON.stringify(wrapperRecords());
  ok(!raw.includes('BASE64PAYLOAD'), "the 3 MB base64 image NEVER enters the wrapper's records (the 2.369.35 law)");
}
// …and the NEXT turn carries the chosen style (the key appears only once
// chosen). The turn has to END first — a chat-input during an active turn is a
// queue/add by design, which is exactly what the first cut of this test tripped
// over.
sendLine({ type: 'interrupt' });
ok(await waitFor(() => readMeta()?.activeTurnId == null), 'the first turn ends');
sendLine({ type: 'chat-input', text: 'again', msgId: 'm2' });
ok(await waitFor(() => rpc().filter((m) => m.method === 'turn/start').length === 2), 'a second turn starts');
ok(rpc().filter((m) => m.method === 'turn/start')[1].params.personality === 'friendly', '…and NOW turn/start carries personality (only because the user picked one)', JSON.stringify(rpc().filter((m) => m.method === 'turn/start')[1]?.params));

try { w.kill('SIGTERM'); } catch { }
await sleep(200);

// ① the spawn-time value, when the user DID choose one
console.log('— personality at spawn (chosen)');
{
  fs.rmSync(rpcLog, { force: true }); fs.rmSync(repliesLog, { force: true }); fs.rmSync(metaFile, { force: true });
  w = spawnWrapper({ CODEX_WEBUI_PERSONALITY: 'none' });
  out = ''; w.stdout.on('data', (d) => { out += d; }); w.stderr.on('data', () => {});
  ok(await waitFor(() => rpc().some((m) => m.method === 'thread/start')), 'wrapper restarted with a chosen style');
  ok(rpc().find((m) => m.method === 'thread/start').params.personality === 'none', "a CHOSEN style is sent — including 'none', which is a real codex value meaning \"no persona\"");
  try { w.kill('SIGTERM'); } catch { }
  await sleep(150);
  fs.rmSync(rpcLog, { force: true }); fs.rmSync(metaFile, { force: true });
  w = spawnWrapper({ CODEX_WEBUI_PERSONALITY: 'sassy' });
  out = ''; w.stdout.on('data', (d) => { out += d; }); w.stderr.on('data', () => {});
  ok(await waitFor(() => rpc().some((m) => m.method === 'thread/start')), 'wrapper restarted with a bogus style');
  ok(!('personality' in rpc().find((m) => m.method === 'thread/start').params), 'an out-of-enum spawn value is dropped, never forwarded');
  try { w.kill('SIGTERM'); } catch { }
  await sleep(150);
}
// the adapter is the ONE place the enum is applied to a spawn
{
  const { CodexAdapter } = require(path.join(REPO, 'src/adapters/codex.js'));
  const ad = new CodexAdapter({ codexCmd: 'codex', chatWrapper: '/w' });
  const envOf = (style) => ad.buildSessionArgs({ cwd: '/tmp', mode: 'chat', permissionMode: 'default', outputStyle: style }).env.CODEX_WEBUI_PERSONALITY;
  ok(envOf('friendly') === 'friendly' && envOf('') === '' && envOf('Concise') === '' && envOf(undefined) === '',
    "the adapter passes only codex's OWN vocabulary (claude's 'Concise' is not a personality)", JSON.stringify([envOf('friendly'), envOf('Concise')]));
  ok(JSON.parse(ad.formatSetResponseStyle('none')).type === 'set-response-style', 'formatSetResponseStyle builds the stdin verb');
  const { ClaudeCodeAdapter } = require(path.join(REPO, 'src/adapters/claude-code.js'));
  let threw = false;
  try { new ClaudeCodeAdapter({ buffersDir: '/tmp' }).formatSetResponseStyle('Concise'); } catch { threw = true; }
  ok(threw, 'a spawn-only harness REFUSES the live verb (base.js throws) instead of writing a frame its wrapper would drop');
}

// ═════════ Part 3 — ACP unknown-update breadcrumb ═════════
console.log('— ACP unknown sessionUpdate');
{
  const seen = [];
  const prev = global.__vsEvent;
  global.__vsEvent = (name, detail) => seen.push([name, detail]);
  const warns = [];
  const prevWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const mm = new AcpMessageManager('acp-unknown');
    const before = mm.messages.length;
    const feed = (u) => mm.processLive({ ts: Date.now(), type: 'acp', kind: 'update', sessionId: 's', update: u });
    feed({ sessionUpdate: 'quantum_entanglement_update', payload: 1 });
    feed({ sessionUpdate: 'quantum_entanglement_update', payload: 2 });   // same kind again
    feed({ sessionUpdate: 'another_unknown_kind' });
    ok(mm.messages.length === before, 'an unknown update creates NO card (it is still dropped — but not in silence)');
    const mine = seen.filter(([n]) => n.startsWith('acp-unknown-update:'));
    ok(mine.length === 2, 'ONE telemetry event per KIND (deduped per process), not per record', JSON.stringify(mine));
    ok(mine[0][0] === 'acp-unknown-update:quantum_entanglement_update', 'the event names the kind', mine[0]?.[0]);
    ok(warns.filter((x) => /unhandled sessionUpdate/.test(x)).length === 2, 'and one rate-limited console line per kind', String(warns.length));
    // the 11th variant of the installed opencode's zod union: KNOWN, card-less
    const before2 = mm.messages.length;
    const seenBefore = seen.length;
    feed({ sessionUpdate: 'session_info_update', title: 'renamed by the agent', updatedAt: '2026-09-07' });
    ok(mm.messages.length === before2 && seen.length === seenBefore, 'session_info_update is a KNOWN kind: no card, and NO unknown breadcrumb');
    ok(mm.status()?.agentSessionTitle === 'renamed by the agent' || mm._status.agentSessionTitle === 'renamed by the agent', 'its title is kept on the status (a future surface has the fact)');
    // every kind the installed agent's schema declares is either handled or named
    const src = read('src/acp-message-manager.js');
    for (const k of ['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk', 'tool_call', 'tool_call_update', 'plan', 'available_commands_update', 'current_mode_update', 'config_option_update', 'usage_update', 'session_info_update']) {
      ok(src.includes(`case '${k}'`), `ACP zod union kind '${k}' has a case (opencode 1.x SessionNotification)`);
    }
    ok(/default: return this\._noteUnknownUpdate\(u\.sessionUpdate\);/.test(src), 'the default arm is the breadcrumb, not a bare return');
  } finally { global.__vsEvent = prev; console.warn = prevWarn; }
}

// ═════════ Part 4 — THREE-producer parity on imageGeneration + sleep ═════════
console.log('— image_gen + sleep: three producers, one card');
{
  const shapeOf = (recs) => {
    const mm = new CodexMessageManager('parity');
    mm.convertHistory(recs);
    return mm.messages.filter((m) => m.role === 'tool').map((m) => ({
      toolName: m.toolName, status: m.status, toolStatus: m.toolStatus, collapseKind: m.collapseKind, content: m.content,
    }));
  };
  // producer A — the ROLLOUT (real 0.153.4 records: Extension/image_gen.generation + Extension/clock.sleep)
  const rollout = [
    { timestamp: 't', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'image_gen.generation', id: 'exec-img1', status: 'completed', revisedPrompt: 'a red van', result: 'B'.repeat(4000), transparentBackground: false, failure: null, savedPath: '/tmp/gen/exec-img1.png' } } },
    { timestamp: 't', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'clock.sleep', id: 'call_s1', durationMs: 30000 } } },
  ];
  // producer B — codex-thread-read (a thread with NO rollout file)
  const trRecs = threadToRecords({ id: 'th', turns: [{ id: 'turn1', items: [
    { type: 'imageGeneration', id: 'exec-img1', status: 'completed', revisedPrompt: 'a red van', result: 'B'.repeat(4000), transparentBackground: false, failure: null, savedPath: '/tmp/gen/exec-img1.png' },
    { type: 'sleep', id: 'call_s1', durationMs: 30000 },
  ] }] });
  // producer C — the LIVE wrapper (captured above, against the stub app-server)
  const live = (global.__liveCards || []).map((m) => ({ toolName: m.toolName, status: m.status, toolStatus: m.toolStatus, collapseKind: m.collapseKind, content: m.content }));

  const A = shapeOf(rollout), B = shapeOf(trRecs);
  ok(A.length === 2 && B.length === 2 && live.length === 2, 'all three producers made exactly the two cards', JSON.stringify([A.length, B.length, live.length]));
  ok(JSON.stringify(A) === JSON.stringify(B), 'rollout ⇄ thread-read: SHAPE-EQUAL', JSON.stringify({ A: A[0], B: B[0] }).slice(0, 500));
  ok(JSON.stringify(A) === JSON.stringify(live), 'rollout ⇄ LIVE wrapper: SHAPE-EQUAL (the third producer the critic warned about)', JSON.stringify({ A, live }).slice(0, 700));
  const img = A[0].content[0], slp = A[1].content[0];
  ok(img.toolName === 'image_gen' && img.input.prompt === 'a red van' && img.input.path === '/tmp/gen/exec-img1.png',
    'the canonical image card = {prompt, path} + a status/saved output', JSON.stringify(img.input));
  ok(img.output === 'status: completed\nsaved /tmp/gen/exec-img1.png', '…and the file is NAMED, never inlined', JSON.stringify(img.output));
  ok(!JSON.stringify(A).includes('BBBB'), 'the base64 result never reaches the card on ANY producer');
  ok(slp.toolName === 'sleep' && slp.input.durationMs === 30000 && slp.output === 'slept 30s', 'the canonical sleep card = {durationMs} + a frozen total', JSON.stringify(slp));
  ok(A[0].collapseKind === null && A[1].collapseKind === null, 'both are VISIBLE work — a 20-minute wait folded into "N tool calls" is how a pause reads as a hang');
  // a FAILED generation is an error card, not a silent success
  const failed = shapeOf([{ timestamp: 't', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'image_gen.generation', id: 'x', status: 'failed', result: '', failure: { type: 'usageLimitExceeded', limitId: 'img' } } } }]);
  ok(failed[0].toolStatus === 'error' && /usageLimitExceeded/.test(failed[0].content[0].output), 'a failed generation renders as an ERROR card carrying the failure', JSON.stringify(failed[0].content[0].output));
  // the live PENDING stub uses the SAME input keys, so the merge cannot drift
  const wsrc = read('data/bin/codex-chat-wrapper.js');
  ok(/name: 'image_gen', arguments: JSON\.stringify\(\{ prompt: asString\(item\.revisedPrompt\), path: asString\(item\.savedPath\) \}\)/.test(wsrc),
    'wrapper pin: the pending image_gen stub carries the SAME input keys its completion does');
  ok(/kind: 'image_gen\.generation'/.test(wsrc) && /kind: 'clock\.sleep'/.test(wsrc), "wrapper pin: the completion is recorded in codex's OWN rollout spelling (one shape, three producers)");
  {
    // the emitted PAYLOAD literal itself (not the comment above it) must name
    // no `result` field — that is the 3 MB base64 PNG
    const i = wsrc.indexOf("kind: 'image_gen.generation'");
    const line = wsrc.slice(wsrc.lastIndexOf('\n', i) + 1, wsrc.indexOf('\n', i));
    ok(!/\bresult\b/.test(line) && /savedPath: asString\(item\.savedPath\)/.test(line), 'wrapper pin: `result` (the 3 MB base64 PNG) is deliberately not carried — savedPath is', line.trim().slice(0, 160));
  }
  const tr = read('src/codex-thread-read.js');
  ok(/case 'sleep':/.test(tr) && !/hookPrompt, sleep, future kinds/.test(tr), 'thread-read pin: sleep is no longer in the "not conversation content" drop list');
  // the renderer draws it
  const cr = read('src/lib/chat-renderers.js');
  ok(/const generatesImage = lowerTool === 'image_gen';/.test(cr) && /generatesImage \? t\('Generated image'\)/.test(cr), 'renderer pin: image_gen goes through the SAME media card as view_image');
  ok(/imageMediaHtml\(\{ path: isImagePath\(imgPath\) \? imgPath : ''/.test(cr), 'renderer pin: the thumbnail rides imageMediaHtml (an <img> built by .src, never raw innerHTML)');
  ok(/data-sleep-until="\$\{escHtml\(String\(until\)\)\}"/.test(cr), 'renderer pin: the sleep countdown carries its own deadline');
  ok(/lowerTool === 'sleep'\) \{\n      return `<div class="chat-tool-use"><span class="chat-tool-label">\$\{UI_ICONS\.hourglass\} \$\{escHtml\(resultText/.test(cr), 'renderer pin: a COMPLETED sleep freezes into the normalizer\'s own text (no ticking element survives)');
  const cv = read('src/lib/chat-view.js');
  ok(/this\._sleepTicker = setInterval/.test(cv) && /clearInterval\(this\._sleepTicker\)/.test(cv), 'ChatView pin: ONE ticker per view, cleared on dispose');
  const { formatSleepRemaining } = await import(path.join(REPO, 'src/lib/chat-renderers.js'));
  ok(formatSleepRemaining(760000) === '12:40' && formatSleepRemaining(-5) === '0:00' && formatSleepRemaining(3665000) === '1:01:05',
    'the countdown formats mm:ss (h:mm:ss past an hour) and never goes negative', [formatSleepRemaining(760000), formatSleepRemaining(-5), formatSleepRemaining(3665000)].join(' / '));
}

// ═════════ the version marker names THIS change ═════════
// r2 review: the first cut stamped "2.369.54" into 21 files while master had
// already SHIPPED 2.369.54 as an unrelated fix — every kb entry and code
// comment then pointed a reader at somebody else's release. A marker is a
// cross-reference; it has to resolve.
console.log('— version marker');
{
  const MARK = '2.369.57';   // renumber HERE and everywhere else in one sed
  const SITES = ['src/backend-caps.js', 'data/bin/codex-chat-wrapper.js', 'src/acp-message-manager.js',
    'src/codex-thread-read.js', 'src/lib/chat-status-bar.js', 'src/lib/session-props.js',
    'src/ws-handler.js', 'docs/kb-file-structure.md', 'docs/kb-features.md', 'docs/kb-api.md'];
  for (const f of SITES) ok(read(f).includes(MARK), `${f} carries the marker ${MARK} (all sites name ONE version)`);
  const changelog = read('CHANGELOG.md');
  // The section for that number, header line to the next `## ` (plain slicing:
  // a lazy regex with a multiline `$` lookahead stops at the end of the HEADER
  // and reads the body as empty, which passes any content check vacuously).
  const head = new RegExp(`^## ${MARK.replace(/\./g, '\\.')}(?![\\d.])`, 'm').exec(changelog);
  let entry = null;
  if (head) {
    const from = head.index;
    const next = changelog.indexOf('\n## ', from + 1);
    entry = changelog.slice(from, next < 0 ? changelog.length : next);
  }
  // Unreleased = no entry yet (fine). Released = the entry under this number
  // must be THIS change, not a squatter that shipped first.
  ok(!entry || /personality|response style|ServerRequest|elicitation/i.test(entry),
    `CHANGELOG ${MARK} is either unwritten or describes THIS change (a number another release already used = renumber)`,
    (entry ? entry.slice(0, 160) : 'no entry yet'));
}

// ═════════ docs ═════════
console.log('— docs carry the change');
{
  const kbf = read('docs/kb-file-structure.md');
  ok(/responseStyle/.test(kbf) && /thread\/settings\/update/.test(kbf), 'kb-file-structure documents the response-style capability + the live RPC');
  ok(/image_gen\.generation/.test(kbf) && /clock\.sleep/.test(kbf), 'kb-file-structure documents the media/sleep producers');
  ok(/SERVER_REQUEST_SPEC|ServerRequest/.test(kbf), 'kb-file-structure documents the per-method ServerRequest table');
  ok(/acp-unknown-update/.test(kbf), 'kb-file-structure documents the ACP breadcrumb');
  ok(/[Rr]esponse style/.test(read('docs/kb-features.md')), 'kb-features documents the response-style surface');
  ok(/set-response-style/.test(read('docs/kb-api.md')), "kb-api documents the ws 'set-response-style' message");
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }

// ═════════ Part 5 — headless chrome: the image card really draws ═════════
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.log('  SKIP: no chrome/chromium — the browser leg did not run');
} else {
  console.log('— headless chrome: a LIVE image_gen item renders as a drawn thumbnail');
  const PORT = 3971 + (process.pid % 20), CDP_PORT = 9371 + (process.pid % 20);
  const wt = `/tmp/vs-honesty-wt-${process.pid}`;
  const fakeHome = `${wt}-home`;
  const CWD = `${wt}-cwd`;
  const THREAD = '01a07777-0000-7000-8000-00000000abcd';
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGMwnnkGK2IYWhIAtNFmAVCW3mYAAAAASUVORK5CYII=';
  const IMG = `${CWD}/generated.png`;
  fs.mkdirSync(CWD, { recursive: true });
  fs.writeFileSync(IMG, Buffer.from(PNG_B64, 'base64'));
  // a real codex ROLLOUT carrying the two items — the SAME records the live
  // wrapper writes (that is the whole point of the parity above), so this leg
  // proves the shape those three producers agree on actually DRAWS.
  const day = new Date();
  const rollDir = path.join(fakeHome, '.codex', 'sessions', String(day.getFullYear()), '01', '01');
  fs.mkdirSync(rollDir, { recursive: true });
  const ts = () => new Date().toISOString();
  const lines = [
    { timestamp: ts(), type: 'session_meta', payload: { id: THREAD, cwd: CWD, originator: 'vibespace', cli_version: '0.153.4', instructions: null } },
    { timestamp: ts(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'draw me a van' }] } },
    { timestamp: ts(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'image_gen.generation', id: 'exec-img1', status: 'completed', revisedPrompt: 'a red van', result: '', failure: null, savedPath: IMG } } },
    { timestamp: ts(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'clock.sleep', id: 'call_s1', durationMs: 30000 } } },
    { timestamp: ts(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Here it is.' }] } },
  ].map((r) => JSON.stringify(r));
  fs.writeFileSync(path.join(rollDir, `rollout-2026-01-01T00-00-00-${THREAD}.jsonl`), lines.join('\n') + '\n');

  try { execSync(`git worktree remove --force ${wt}`, { cwd: REPO, stdio: 'ignore' }); } catch { }
  execSync(`git worktree add --detach ${wt} HEAD`, { cwd: REPO, stdio: 'ignore' });
  for (const f of ['src', 'public', 'server.js', 'package.json']) execSync(`rm -rf ${wt}/${f} && cp -r ${REPO}/${f} ${wt}/${f}`);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(wt, 'node_modules'));
  fs.mkdirSync(path.join(wt, 'data'), { recursive: true });
  const srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: { ...process.env, PORT: String(PORT), HOME: fakeHome, CODEX_HOME: path.join(fakeHome, '.codex'), VIBESPACE_SKIP_AGENT_HOOKS: '1', VIBESPACE_PASSWORD: '' }, stdio: 'ignore' });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu', '--window-size=1400,1000',
    '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${wt}-chrome`, 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch { }
    try { srv.kill('SIGKILL'); } catch { }
    try { execSync(`git worktree remove --force ${wt}`, { cwd: REPO, stdio: 'ignore' }); } catch { }
    for (const d of [`${wt}-chrome`, fakeHome, CWD]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
  };
  process.on('exit', cleanup);
  for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }
  const WebSocket = require('ws');
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((x) => x.type === 'page'); } catch { }
    if (!target) await sleep(250);
  }
  if (!target) { ok(false, 'chrome exposed a CDP page target'); }
  else {
    const cws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((r) => cws.on('open', r));
    let seq = 0; const pend = new Map();
    cws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); cws.send(JSON.stringify({ id, method, params })); });
    const evaljs = async (expr) => {
      const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
      return r.result?.result?.value;
    };
    await cdp('Runtime.enable'); await cdp('Page.enable');
    await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    for (let i = 0; i < 100; i++) { if (await evaljs('!!(window.app && window.app.ready && window.app.wm)').catch(() => false)) break; await sleep(300); }
    await evaljs('window.app.ready.then(() => true)').catch(() => { });
    await sleep(1200);
    const got = await evaljs(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.app.viewSession('${THREAD}', ${JSON.stringify(CWD)}, 'codex media', { backend: 'codex', backendSessionId: '${THREAD}' });
      let img = null, list = null;
      for (let i = 0; i < 100; i++) {
        list = document.querySelector('.chat-message-list');
        img = list && list.querySelector('img.chat-tool-img');
        if (img && img.complete && img.naturalWidth > 0) break;
        await sleep(250);
      }
      const labels = list ? [...list.querySelectorAll('.chat-tool-label')].map((e) => e.textContent.trim()) : [];
      return {
        cards: list ? list.querySelectorAll('.chat-msg-tool-result').length : -1,
        imgSrc: img ? img.getAttribute('src') : null,
        natural: img ? img.naturalWidth : 0,
        labels,
        srcIsAttr: img ? !/<img/.test(img.parentElement.getAttribute('data-raw') || '') : false,
      };
    })()`).catch((e) => ({ err: String(e).slice(0, 300) }));
    ok(got && got.natural > 0, 'the generated image DRAWS in a real browser (naturalWidth > 0 — a /api/file/raw fetch that really resolved)', JSON.stringify(got));
    ok(got && /\/api\/file\/raw\?path=/.test(got.imgSrc || ''), '…from /api/file/raw, the same lane the file viewer uses', String(got?.imgSrc).slice(0, 120));
    ok(got && (got.labels || []).some((l) => /Generated image|生成的图片|生成した画像/.test(l)), 'the card is labelled as a GENERATED image, not a bare "status: completed" line', JSON.stringify(got?.labels));
    ok(got && (got.labels || []).some((l) => /slept 30s/.test(l)), 'and the completed sleep is a frozen one-line card', JSON.stringify(got?.labels));
  }
  cleanup();
  process.removeAllListeners('exit');
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
