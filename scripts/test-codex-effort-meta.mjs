#!/usr/bin/env node
// THE EFFORT A TURN RAN AT (owner 2026-09-07: "我刚才把那个van的对话调成了 ultra,
// 但我看它回复怎么都 metadata 显示的是 xhigh?").
//
// The conversation had been at 'ultra' codex-side since 09-06 20:33 (its own
// rollout turn_context, 21/21). At the 07:06:44 resume the app-server pushed
// `turn/started` for a turn it auto-continued and the wrapper synthesized the
// turn_context that every reader takes a turn's effort from — quoting the
// SPAWN ENV ('xhigh', the instance default `codex.defaultEffort`) because the
// thread/resume reply carrying reasoningEffort:'ultra' had not landed yet
// (1.9ms later; codex's own copy of the SAME turn says 'ultra' at 07:06:46.484).
// That one record was the only turn_context in the whole 1137-line live buffer,
// so `_status.effort` stayed 'xhigh' and every token_count baked 'xhigh' onto
// every message of the session.
//
// Legs: ① the PURE label rules ② the race, reproduced against a stub
// app-server with the REAL wrapper (+ a negative control that removes only the
// correction) ③ set-effort reaches the APP-SERVER and the live status, not just
// the next turn/start ④ per-message meta = the effort of ITS turn, over a
// two-turn rollout-shaped fixture ⑤ the wrapper_meta fallback (mid-turn attach)
// ⑥ the merge fold (our synthesized twin never suppresses codex's own copy)
// ⑦ the WRITER — the wrapper's effort reaches session-meta, so the next resume
// carries it ⑧ spawn/restore wiring pins ⑨ client wiring pins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));

// ───────────────────────────────────────────────────────────────────────────
console.log('— ① the PURE label rules (agent-meta): ultra is a MODE, the level comes from the catalog');
{
  const { effortDisplay, multiAgentReasoningFor, noteModelCatalog, BACKEND_META } = await import(path.join(REPO, 'src/lib/agent-meta.js'));
  ok(effortDisplay('codex', 'ultra') === 'ultra', 'with no catalog loaded, ultra is just "ultra" (never a guessed level)', effortDisplay('codex', 'ultra'));
  // the REAL shape /api/available-models serves (server.js refreshCodexModels)
  noteModelCatalog('codex', [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra (272k)', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], multiAgentEffort: 'xhigh' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], multiAgentEffort: '' },
  ]);
  ok(effortDisplay('codex', 'ultra', { model: 'gpt-6-astra' }) === 'ultra (multi-agent · reasoning xhigh)',
    'a model whose catalog names multi_agent_reasoning_effort says BOTH facts', effortDisplay('codex', 'ultra', { model: 'gpt-6-astra' }));
  ok(effortDisplay('codex', 'ultra', { model: 'gpt-5.6-sol' }) === 'ultra',
    'a model that supports ultra but names NO level stays a bare "ultra" (we do not guess "max")', effortDisplay('codex', 'ultra', { model: 'gpt-5.6-sol' }));
  ok(effortDisplay('codex', 'ultra', { model: 'gpt-9-unheard-of' }) === 'ultra', 'an unknown model stays a bare "ultra"');
  ok(effortDisplay('codex', 'xhigh', { model: 'gpt-6-astra' }) === 'xhigh', 'a real reasoning LEVEL is never decorated');
  ok(effortDisplay('codex', '') === '' && effortDisplay('codex', null) === '', 'empty stays empty');
  // NEVER HARDCODED: the level is whatever the catalog says, not 'xhigh'
  noteModelCatalog('codex', [{ id: 'gpt-7-future', multiAgentEffort: 'max' }]);
  ok(effortDisplay('codex', 'ultra', { model: 'gpt-7-future' }) === 'ultra (multi-agent · reasoning max)',
    'the level is READ from the catalog, never hardcoded to xhigh', effortDisplay('codex', 'ultra', { model: 'gpt-7-future' }));
  ok(multiAgentReasoningFor('codex', 'gpt-6-astra') === 'xhigh' && multiAgentReasoningFor('codex', '') === '' && multiAgentReasoningFor('', 'x') === '',
    'multiAgentReasoningFor answers the catalog, and "" for anything it does not know');
  // GATED ON THE CAPS ROW, NOT A BACKEND ID (2.369.58 law): a harness whose
  // META names no multiAgentEffort never gets the decoration, even for the
  // same STRING and even with a same-named model in the catalog.
  noteModelCatalog('claude', [{ id: 'gpt-6-astra', multiAgentEffort: 'xhigh' }]);
  ok(effortDisplay('claude', 'ultra', { model: 'gpt-6-astra' }) === 'ultra',
    'the decoration gates on META.multiAgentEffort, never on the value string or a backend id', effortDisplay('claude', 'ultra', { model: 'gpt-6-astra' }));
  ok(BACKEND_META.codex.multiAgentEffort === 'ultra' && !BACKEND_META.claude.multiAgentEffort, 'exactly codex declares the delegation value');
}

// ───────────────────────────────────────────────────────────────────────────
// A stub app-server that reproduces the incident's ORDER: `turn/started` for a
// turn the app-server auto-continues on resume goes out BEFORE the
// thread/resume reply that carries the thread's real reasoningEffort.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxeff-'));
const SID = 'sess-7-1700000000007';
const buf = path.join(dir, SID + '.buf'), metaFile = path.join(dir, SID + '.json'), rpcLog = path.join(dir, 'rpc.jsonl');
const STUB = `
const fs = require('fs');
let b = ''; let turns = 0; let threadEffort = 'ultra'; let activeTurn = null;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  b += d; let i;
  while ((i = b.indexOf('\\n')) !== -1) {
    const line = b.slice(0, i); b = b.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined || !m.method) continue;
    fs.appendFileSync(${JSON.stringify(rpcLog)}, line + '\\n');
    if (m.method === 'thread/resume') {
      // THE INCIDENT'S ORDER (buffer 2026-09-07T07:06:44.565-.566Z): the
      // app-server auto-continues a turn and pushes turn/started FIRST; the
      // resume reply — the only carrier of the thread's own reasoningEffort —
      // lands after it, inside the same millisecond.
      const tid = 'turn-resumed'; activeTurn = tid; turns++;
      send({ method: 'event/goalCleared', params: { threadId: 'th-eff' } });
      send({ method: 'turn/started', params: { threadId: 'th-eff', turn: { id: tid, status: 'inProgress', items: [] } } });
      send({ id: m.id, result: { thread: { id: 'th-eff' }, model: 'gpt-6-astra', modelProvider: 'openai', cwd: ${JSON.stringify(dir)}, approvalPolicy: 'never', reasoningEffort: threadEffort } });
      continue;
    }
    if (m.method === 'thread/settings/update') {
      // r2 leg ③c: an app-server that REFUSES the verb (older build, unknown
      // method). The wrapper must fall back to the per-turn param and must NOT
      // record that the thread was reconfigured.
      if (process.env.CX_REFUSE_SETTINGS) { send({ id: m.id, error: { code: -32601, message: 'thread/settings/update is not supported' } }); continue; }
      if (typeof m.params.effort === 'string') threadEffort = m.params.effort;
      else if (m.params.effort === null) threadEffort = '';
      send({ id: m.id, result: {} });
      send({ method: 'thread/settings/updated', params: { threadId: 'th-eff', threadSettings: { model: 'gpt-6-astra', modelProvider: 'openai', cwd: ${JSON.stringify(dir)}, approvalPolicy: 'never', approvalsReviewer: 'user', collaborationMode: { mode: 'default' }, sandboxPolicy: { type: 'danger-full-access' }, effort: threadEffort || null } } });
      continue;
    }
    if (m.method === 'turn/start') {
      // TurnStartParams.effort is documented "Override the reasoning effort for
      // this turn and subsequent turns" — so a commanded effort re-points the
      // thread too. The stub models that.
      if (typeof m.params.effort === 'string' && m.params.effort) threadEffort = m.params.effort;
      turns++; const tid = 'turn-' + turns; activeTurn = tid;
      send({ id: m.id, result: { turn: { id: tid } } });
      send({ method: 'turn/started', params: { threadId: 'th-eff', turn: { id: tid, status: 'inProgress', items: [] } } });
      continue;
    }
    // Stop LISTS the queue before it interrupts (2.369.x) — a stub that does
    // not answer this leaves the sweep to time out and the leg measures the
    // timeout instead of the effort.
    if (m.method === 'thread/queue/list') { send({ id: m.id, result: { data: [], nextCursor: null } }); continue; }
    if (m.method === 'turn/interrupt') {
      send({ id: m.id, result: {} });
      const ended = activeTurn; activeTurn = null;
      send({ method: 'turn/completed', params: { turn: { id: ended }, status: 'interrupted' } });
      continue;
    }
    send({ id: m.id, result: {} });
  }
});
`;
console.log('— ② the incident: the resume race (REAL wrapper vs a stub that answers in the incident\'s order)');
const w = spawn(process.execPath, [path.join(REPO, 'data/bin/codex-chat-wrapper.js'), buf, metaFile, process.execPath, '-e', STUB], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env, CODEX_WEBUI_CWD: dir, VIBESPACE_API: '', VIBESPACE_SESSION_TOKEN: '', VIBESPACE_SKIP_AGENT_HOOKS: '1',
    CODEX_WEBUI_RESUME_ID: 'th-eff',
    // The instance default `codex.defaultEffort` — documented as applying to
    // "new or resumed Codex sessions", so a resume really does spawn with it.
    CODEX_WEBUI_EFFORT: 'xhigh',
    CODEX_WEBUI_MODEL: 'gpt-6-astra',
  },
});
let out = ''; w.stdout.on('data', (d) => { out += d; });
let werr = ''; w.stderr.on('data', (d) => { werr += d; });
const events = () => out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const turnContexts = () => events().filter((r) => r.type === 'turn_context');
const rpc = () => { try { return fs.readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const readMeta = () => { try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { return null; } };
const waitFor = async (pred, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(60); } return pred(); };
const sendLine = (o) => w.stdin.write(JSON.stringify(o) + '\n');

ok(await waitFor(() => readMeta()?.threadId === 'th-eff'), 'wrapper resumed the thread against the stub');
ok(await waitFor(() => turnContexts().length >= 2), 'the resumed turn produced TWO turn_context records', JSON.stringify(turnContexts().map((r) => r.payload.effort)));
const tcs = turnContexts();
// The leg is only meaningful if the race really happened in this run.
const evs = events();
const iFirstTc = evs.findIndex((r) => r.type === 'turn_context');
const iSessionMeta = evs.findIndex((r) => r.type === 'session_meta');
ok(iFirstTc >= 0 && iSessionMeta > iFirstTc,
  'the race is REAL in this run: the synthesized turn_context precedes the thread/resume reply (session_meta)', `tc@${iFirstTc} session_meta@${iSessionMeta}`);
ok(tcs[0]?.payload?.turn_id === 'turn-resumed' && tcs[0]?.payload?.effort === 'xhigh',
  'the FIRST (provisional) copy quotes the spawn env — the master bug, reproduced verbatim', JSON.stringify(tcs[0]?.payload));
ok(tcs[1]?.payload?.turn_id === 'turn-resumed' && tcs[1]?.payload?.effort === 'ultra',
  'a SECOND copy for the SAME turn id restates it as the thread\'s real effort', JSON.stringify(tcs[1]?.payload));
ok(rpc().every((m) => m.method !== 'turn/start'),
  'we never started that turn — so the value we quoted first had never reached codex at all');

// Through the REAL normalizer: the popup value is _status.effort at token_count.
const feedAll = (records, mm) => { for (const r of records) mm.processLive(r); return mm; };
const assistantTurnRecords = (turnId) => ([
  { type: 'response_item', payload: { type: 'message', item_id: 'it-' + turnId, role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] } },
  { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 0, outputTokens: 2 }, total_token_usage: { totalTokens: 100 + turnId.length, inputTokens: 80, cachedInputTokens: 0, outputTokens: 20 }, model_context_window: 272000 } } },
]);
{
  const live = feedAll([...events(), ...assistantTurnRecords('turn-resumed')], new CodexMessageManager('eff-1'));
  const am = live.messages.find((m) => m.role === 'assistant');
  ok(live.status().effort === 'ultra', 'the REAL normalizer ends at effort ultra', live.status().effort);
  ok(am?.meta?.effort === 'ultra', 'and every message of that turn is stamped ultra — the owner\'s complaint, fixed', JSON.stringify(am?.meta?.effort));
  // NEGATIVE CONTROL — reconstruct exactly what MASTER's wrapper emitted for
  // this same stub exchange (one provisional turn_context, and a wrapper_meta
  // with no effort fields at all) and feed it to the SAME normalizer: the
  // incident comes back. Both carriers have to be removed, because both are
  // part of the fix (the restated turn_context and the wrapper's status pair).
  let correctionsSeen = 0;
  const masterShape = [...events(), ...assistantTurnRecords('turn-resumed')]
    // drop the RESTATED copy (the 2nd turn_context for the resumed turn) —
    // by value, because events() re-parses the stdout text on every call
    .filter((r) => !(r.type === 'turn_context' && r.payload.turn_id === 'turn-resumed' && ++correctionsSeen > 1))
    .map((r) => {
      if (r.type !== 'wrapper_meta') return r;
      const { effort, effortNext, activeTurnId, ...rest } = r.payload;
      return { ...r, payload: rest };
    });
  const noFix = feedAll(masterShape, new CodexMessageManager('eff-1n'));
  ok(noFix.messages.find((m) => m.role === 'assistant')?.meta?.effort === 'xhigh',
    'negative control: with master\'s record shapes the SAME pipeline reports xhigh again',
    JSON.stringify(noFix.messages.find((m) => m.role === 'assistant')?.meta?.effort));
  ok(masterShape.filter((r) => r.type === 'turn_context').length === 1,
    '…and that shape really is one turn_context, as the owner\'s 1137-line buffer had');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('— ③ set-effort reaches the APP-SERVER and the live status, not just the next turn/start');
{
  const before = events().length;
  sendLine({ type: 'set-effort', effort: 'high' });
  ok(await waitFor(() => rpc().some((m) => m.method === 'thread/settings/update' && m.params?.effort === 'high')),
    'set-effort sends thread/settings/update {effort} — the verb whose own doc is "Override the reasoning effort for subsequent turns"',
    JSON.stringify(rpc().filter((m) => m.method === 'thread/settings/update').map((m) => m.params)));
  ok(await waitFor(() => events().slice(before).some((r) => r.type === 'event_msg' && r.payload?.type === 'thread_settings_applied' && r.payload?.thread_settings?.reasoning_effort === 'high')),
    '…and records it in codex\'s OWN rollout shape (event_msg thread_settings_applied, snake_case reasoning_effort)',
    JSON.stringify(events().slice(before).filter((r) => r.payload?.type === 'thread_settings_applied').map((r) => r.payload.thread_settings)));
  // r2 review: a record in CODEX's spelling that CODEX did not write must say
  // so — the synthesized turn_context has carried `wrapper: true` since this
  // release and its settings twin was the one honesty gap left.
  ok(events().slice(before).filter((r) => r.payload?.type === 'thread_settings_applied').every((r) => r.payload.wrapper === true),
    '…MARKED `wrapper: true` (codex\'s own rollout copy is the unmarked one — 9 thread_settings keys to our 5, so they can never dedup)',
    JSON.stringify(events().slice(before).filter((r) => r.payload?.type === 'thread_settings_applied').map((r) => r.payload.wrapper)));
  const wm = events().slice(before).filter((r) => r.type === 'wrapper_meta').pop();
  ok(wm?.payload?.effortNext === 'high', 'the wrapper restates its status record with the PENDING value', JSON.stringify(wm?.payload && { effort: wm.payload.effort, effortNext: wm.payload.effortNext }));
  ok(wm?.payload?.effort === 'ultra', '…while still reporting the RUNNING turn as ultra (a pending pick never relabels the turn in flight)', JSON.stringify(wm?.payload?.effort));
  // the running turn's messages keep ultra, the pending value is visible
  const live = feedAll([...events(), ...assistantTurnRecords('turn-resumed')], new CodexMessageManager('eff-2'));
  ok(live.status().effort === 'ultra' && live.status().effortNext === 'high',
    'the REAL normalizer keeps the running turn at ultra and reports "high" as pending', JSON.stringify({ e: live.status().effort, n: live.status().effortNext }));
  ok(live.messages.find((m) => m.role === 'assistant')?.meta?.effort === 'ultra',
    'a mid-turn re-pick does NOT retro-label the messages the running turn already produced');
}

console.log('— ③b the NEXT turn really runs at the new effort, and says so');
{
  // Wait on the wrapper's OWN statement (turn_aborted on stdout), never on the
  // sidecar: scheduleMeta debounces 200ms, so the file is a LAGGING view and a
  // chat-input sent on its word gets queued into the turn we just stopped.
  sendLine({ type: 'interrupt' });
  ok(await waitFor(() => events().some((r) => r.payload?.type === 'turn_aborted')),
    'the resumed turn was interrupted (the bench needs an idle thread)');
  const before = turnContexts().length;
  sendLine({ type: 'chat-input', text: 'go', msgId: 'm-1' });
  ok(await waitFor(() => turnContexts().length > before), 'a new turn started', JSON.stringify(turnContexts().map((r) => r.payload.turn_id)));
  const tc = turnContexts().pop();
  const start = rpc().filter((m) => m.method === 'turn/start').pop();
  ok(start?.params?.effort === 'high', 'turn/start carries the commanded effort', JSON.stringify(start?.params?.effort));
  ok(tc.payload.effort === start?.params?.effort,
    'THE INVARIANT: turn_context.effort === the effort the turn was STARTED with', JSON.stringify({ tc: tc.payload.effort, start: start?.params?.effort }));
  ok(tc.payload.turn_id !== 'turn-resumed', 'and it is the NEW turn\'s context, not a restatement of the old one', tc.payload.turn_id);
  ok(!('effort_next' in tc.payload), 'nothing is pending any more, so no effort_next rides the record', JSON.stringify(tc.payload));
  // the popup value for THIS turn's messages follows the turn, not the session
  const live2 = feedAll([...events(), ...assistantTurnRecords('t2')], new CodexMessageManager('eff-3'));
  const last = live2.messages.filter((m) => m.role === 'assistant').pop();
  ok(last?.meta?.effort === 'high', 'the new turn\'s messages are stamped high', JSON.stringify(last?.meta?.effort));
}
try { w.stdin.end(); w.kill(); } catch { }

console.log('— ③c a REFUSED thread/settings/update records nothing about the thread (r2 review)');
{
  // The record the set-effort path emits is in CODEX's own rollout spelling.
  // Emitting it after a refusal put a record into the history saying codex had
  // applied a setting it had just rejected — and because our 5-key payload can
  // never dedup against codex's 9-key one, a rebuild kept it forever.
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxeff-ref-'));
  const buf3 = path.join(d3, 'sess-r.buf'), meta3 = path.join(d3, 'sess-r.json'), rpc3 = path.join(d3, 'rpc.jsonl');
  const STUB3 = STUB.split(JSON.stringify(rpcLog)).join(JSON.stringify(rpc3)).split(JSON.stringify(dir)).join(JSON.stringify(d3));
  const w3 = spawn(process.execPath, [path.join(REPO, 'data/bin/codex-chat-wrapper.js'), buf3, meta3, process.execPath, '-e', STUB3], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env, CODEX_WEBUI_CWD: d3, VIBESPACE_API: '', VIBESPACE_SESSION_TOKEN: '', VIBESPACE_SKIP_AGENT_HOOKS: '1',
      CODEX_WEBUI_RESUME_ID: 'th-eff', CODEX_WEBUI_EFFORT: 'xhigh', CODEX_WEBUI_MODEL: 'gpt-6-astra',
      CX_REFUSE_SETTINGS: '1',
    },
  });
  let out3 = ''; w3.stdout.on('data', (d) => { out3 += d; });
  const ev3 = () => out3.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const rpcOf3 = () => { try { return fs.readFileSync(rpc3, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const meta3Read = () => { try { return JSON.parse(fs.readFileSync(meta3, 'utf8')); } catch { return null; } };
  const wait3 = async (pred, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(60); } return pred(); };
  ok(await wait3(() => meta3Read()?.threadId === 'th-eff'), 'the refusing bench resumed');
  const mark = ev3().length;
  w3.stdin.write(JSON.stringify({ type: 'set-effort', effort: 'max' }) + '\n');
  ok(await wait3(() => rpcOf3().some((m) => m.method === 'thread/settings/update' && m.params?.effort === 'max')),
    'we still ASK the app-server (the verb is tried, not assumed)');
  ok(await wait3(() => ev3().slice(mark).some((r) => r.type === 'wrapper_meta' && r.payload?.effortNext === 'max')),
    'the pending pick still reaches every client through the wrapper\'s OWN status record (a statement about us, which a refusal leaves true)',
    JSON.stringify(ev3().slice(mark).filter((r) => r.type === 'wrapper_meta').map((r) => r.payload.effortNext)));
  ok(!ev3().slice(mark).some((r) => r.type === 'event_msg' && r.payload?.type === 'thread_settings_applied'),
    'THE FIX: nothing claims the THREAD was reconfigured — codex refused',
    JSON.stringify(ev3().slice(mark).filter((r) => r.payload?.type === 'thread_settings_applied').map((r) => r.payload)));
  // …and the per-turn fallback the refusal falls back to still works
  w3.stdin.write(JSON.stringify({ type: 'interrupt' }) + '\n');
  ok(await wait3(() => ev3().some((r) => r.payload?.type === 'turn_aborted')), 'the auto-continued turn was interrupted');
  w3.stdin.write(JSON.stringify({ type: 'chat-input', text: 'go', msgId: 'm-r1' }) + '\n');
  ok(await wait3(() => rpcOf3().some((m) => m.method === 'turn/start')), 'a new turn started');
  const st3 = rpcOf3().filter((m) => m.method === 'turn/start').pop();
  ok(st3?.params?.effort === 'max', 'the per-turn param still carries the pick (the fallback a refusal leaves in place)', JSON.stringify(st3?.params?.effort));
  const tc3 = ev3().filter((r) => r.type === 'turn_context').pop();
  ok(tc3?.payload?.effort === 'max', '…and the new turn_context states the effort that turn was STARTED with', JSON.stringify(tc3?.payload?.effort));
  try { w3.stdin.end(); w3.kill(); } catch { }
  try { fs.rmSync(d3, { recursive: true, force: true }); } catch { }
}

// ───────────────────────────────────────────────────────────────────────────
console.log('— ④ per-message meta = the effort of ITS turn (two turns, xhigh then ultra)');
{
  // Codex's OWN rollout shapes, redacted (turn_context / message / token_count
  // key names and nesting taken from a real 0.153.4 rollout).
  const TID = '01a0733f-f028-7462-9769-be3e761a4f19';
  const rollout = [
    { type: 'session_meta', payload: { id: TID, cwd: '/w/proj', model: 'gpt-6-astra', originator: 'codex_cli_rs', cli_version: '0.153.4' } },
    { type: 'turn_context', payload: { turn_id: 'r-t1', cwd: '/w/proj', approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' }, model: 'gpt-6-astra', personality: 'pragmatic', effort: 'xhigh', summary: 'none' } },
    { type: 'response_item', payload: { type: 'message', item_id: 'i1', role: 'assistant', content: [{ type: 'output_text', text: 'first turn answer' }] } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { totalTokens: 50, inputTokens: 40, cachedInputTokens: 0, outputTokens: 10 }, total_token_usage: { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 0, outputTokens: 100 }, model_context_window: 272000 } } },
    // the user re-picks: codex records its own settings event…
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: TID, thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai', approval_policy: 'never', approvals_reviewer: 'user', cwd: '/w/proj', reasoning_effort: 'ultra', personality: 'pragmatic' } } },
    // …and the NEXT turn's own context is the authority for that turn
    { type: 'turn_context', payload: { turn_id: 'r-t2', cwd: '/w/proj', approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' }, model: 'gpt-6-astra', personality: 'pragmatic', effort: 'ultra', summary: 'none' } },
    { type: 'response_item', payload: { type: 'message', item_id: 'i2', role: 'assistant', content: [{ type: 'output_text', text: 'second turn answer' }] } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { totalTokens: 60, inputTokens: 45, cachedInputTokens: 0, outputTokens: 15 }, total_token_usage: { totalTokens: 2000, inputTokens: 1800, cachedInputTokens: 0, outputTokens: 200 }, model_context_window: 272000 } } },
  ];
  const mm = new CodexMessageManager('eff-roll', { threadId: TID });
  const msgs = mm.convertHistory(rollout);
  const a1 = msgs.find((m) => JSON.stringify(m.content || '').includes('first turn answer'));
  const a2 = msgs.find((m) => JSON.stringify(m.content || '').includes('second turn answer'));
  ok(a1?.meta?.effort === 'xhigh', 'turn 1 messages are stamped xhigh', JSON.stringify(a1?.meta?.effort));
  ok(a2?.meta?.effort === 'ultra', 'turn 2 messages are stamped ultra', JSON.stringify(a2?.meta?.effort));
  ok(a1?.meta?.effort !== a2?.meta?.effort, 'the two turns of ONE conversation do not share one effort field');
  ok(mm.status().effort === 'ultra', 'the conversation ends reporting the last turn\'s effort', mm.status().effort);
}

console.log('— ④b thread_settings_applied moves the PENDING value only (it is not a statement about the running turn)');
{
  const mm = new CodexMessageManager('eff-ts');
  mm.processLive({ type: 'turn_context', payload: { turn_id: 't1', effort: 'xhigh', model: 'gpt-6-astra' } });
  mm.processLive({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'x', thread_settings: { model: 'gpt-6-astra', reasoning_effort: 'ultra' } } });
  ok(mm.status().effort === 'xhigh' && mm.status().effortNext === 'ultra',
    'a settings event mid-turn leaves the turn\'s own effort alone and reports the new one as next', JSON.stringify(mm.status()).slice(0, 120));
  // …but before ANY turn has named one it IS the best answer for "now"
  const fresh = new CodexMessageManager('eff-ts2');
  fresh.processLive({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'x', thread_settings: { model: 'gpt-6-astra', reasoning_effort: 'ultra' } } });
  ok(fresh.status().effort === 'ultra' && fresh.status().effortNext === 'ultra', 'with no turn yet, the thread setting answers both');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('— ⑤ the wrapper_meta fallback: a mid-turn attach is honest with no turn_context in range');
{
  const mm = new CodexMessageManager('eff-wm');
  const ops = []; mm.onOp((o) => ops.push(o));
  mm.processLive({ type: 'wrapper_meta', payload: { threadId: 'th-x', model: 'gpt-6-astra', permissionMode: 'yolo', activeTurnId: 'tA', effort: 'ultra', effortNext: 'high' } });
  ok(mm.status().effort === 'ultra' && mm.status().effortNext === 'high',
    'a bare wrapper_meta carries both facts (no rollout re-read, no waiting for the next turn)', JSON.stringify({ e: mm.status().effort, n: mm.status().effortNext }));
  ok(ops.some((o) => o.op === 'meta' && o.subtype === 'effort' && o.data?.effort === 'ultra' && o.data?.effortNext === 'high'),
    'and it EMITS the live meta op an open window listens to', JSON.stringify(ops.filter((o) => o.subtype === 'effort')));
  // a turn_context still wins for the turn it names
  mm.processLive({ type: 'turn_context', payload: { turn_id: 'tB', effort: 'high' } });
  ok(mm.status().effort === 'high' && mm.status().effortNext === null, 'the next turn_context settles both again', JSON.stringify(mm.status().effortNext));
  // chatStatus (the attach payload) over a buffer of ONLY wrapper_meta
  const { CodexSessionMessages } = require(path.join(REPO, 'src/codex-session-store.js'));
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxeff2-'));
  fs.writeFileSync(path.join(d2, 'sess-y.json'), JSON.stringify({ threadId: 'th-y', model: 'gpt-6-astra', effort: 'ultra', effortNext: 'high' }));
  const bufText = JSON.stringify({ type: 'wrapper_meta', payload: { threadId: 'th-y', model: 'gpt-6-astra', activeTurnId: 'tZ', effort: 'ultra', effortNext: 'high' } }) + '\n';
  const sm = new CodexSessionMessages({ buffer: bufText, backendSessionId: 'th-y' }, 'sess-y', { buffersDir: d2 });
  const st = sm.chatStatus();
  ok(st.effort === 'ultra' && st.effortNext === 'high',
    'chatStatus (the attach payload) answers from the wrapper\'s own sidecar + record', JSON.stringify({ e: st.effort, n: st.effortNext }));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('— ⑥ the merge fold: our synthesized twin never suppresses codex\'s own copy');
{
  const { mergeCodexRecords } = require(path.join(REPO, 'src/codex-session-store.js'));
  // The incident's two records, verbatim timestamps: ours at 07:06:44.566,
  // codex's own at 07:06:46.484 — same turn id, so the same fingerprint, and
  // OURS is the earlier one that first-wins used to keep forever.
  const merged = mergeCodexRecords(
    [{ type: 'turn_context', timestamp: '2026-09-07T07:06:46.484Z', payload: { turn_id: 'T', effort: 'ultra', model: 'gpt-6-astra' } }],
    [{ type: 'turn_context', timestamp: '2026-09-07T07:06:44.566Z', payload: { turn_id: 'T', effort: 'xhigh', model: 'gpt-6-astra', modelPinned: true, wrapper: true, effort_next: 'xhigh' } }],
  );
  const tc = merged.filter((r) => r.type === 'turn_context');
  ok(tc.length === 1, 'the twins collapse to ONE turn (a refresh of a turn is never a second turn)', String(tc.length));
  ok(tc[0].payload.effort === 'ultra', 'and the surviving copy carries CODEX\'s value, not our earlier guess', JSON.stringify(tc[0].payload.effort));
  ok(!('effort_next' in tc[0].payload), 'codex\'s own copy settles the pending question too (nothing is pending in a rebuilt history)', JSON.stringify(tc[0].payload));
  // our own LATER correction overrides our own earlier copy
  const merged2 = mergeCodexRecords([], [
    { type: 'turn_context', timestamp: '2026-09-07T07:06:44.566Z', payload: { turn_id: 'T', effort: 'xhigh', modelPinned: true, wrapper: true } },
    { type: 'turn_context', timestamp: '2026-09-07T07:06:44.568Z', payload: { turn_id: 'T', effort: 'ultra', modelPinned: true, wrapper: true } },
  ]);
  const tc2 = merged2.filter((r) => r.type === 'turn_context');
  ok(tc2.length === 1 && tc2[0].payload.effort === 'ultra',
    'a rebuilt history keeps the wrapper\'s own late correction, not the value it superseded', JSON.stringify(tc2.map((r) => r.payload.effort)));
  // a DIFFERENT turn is still a different turn
  const merged3 = mergeCodexRecords([], [
    { type: 'turn_context', timestamp: '2026-09-07T07:06:44.566Z', payload: { turn_id: 'T1', effort: 'xhigh', wrapper: true } },
    { type: 'turn_context', timestamp: '2026-09-07T07:07:44.566Z', payload: { turn_id: 'T2', effort: 'ultra', wrapper: true } },
  ]);
  ok(merged3.filter((r) => r.type === 'turn_context').length === 2, 'two turns stay two turns (the fold is keyed on the turn id)');
}

console.log('— ⑥b the SETTINGS twin folds the same way (r2 review: our copy is in codex\'s spelling)');
{
  const { mergeCodexRecords } = require(path.join(REPO, 'src/codex-session-store.js'));
  // codex's REAL rollout payload — nine thread_settings keys, key set taken
  // verbatim from a 0.153.4 rollout (values redacted). Ours carries five, so
  // the fingerprints differ and the exact-repeat dedup can never see the twin.
  const codexCopy = (effort) => ({
    type: 'event_msg', timestamp: '2026-09-07T07:10:00.400Z',
    payload: { type: 'thread_settings_applied', thread_id: 'T', thread_settings: { model: 'gpt-6-astra', model_provider_id: 'openai', approval_policy: 'never', approvals_reviewer: 'user', collaboration_mode: { mode: 'default' }, permission_profile: null, cwd: '/w', reasoning_effort: effort, personality: 'pragmatic' } },
  });
  const wrapperCopy = (effort, ts = '2026-09-07T07:10:00.100Z') => ({
    type: 'event_msg', timestamp: ts,
    payload: { type: 'thread_settings_applied', thread_id: 'T', wrapper: true, thread_settings: { model: 'gpt-6-astra', approval_policy: 'never', cwd: '/w', reasoning_effort: effort, personality: 'pragmatic' } },
  });
  const m = mergeCodexRecords([codexCopy('ultra')], [wrapperCopy('ultra')]);
  const settings = m.filter((r) => r.payload?.type === 'thread_settings_applied');
  ok(settings.length === 1, 'the twins collapse to ONE settings record (a rebuild used to hold both)', String(settings.length));
  ok(settings[0].payload.wrapper === undefined && settings[0].payload.thread_settings.model_provider_id === 'openai',
    'and the survivor is CODEX\'s own copy, key set and all', JSON.stringify(Object.keys(settings[0].payload.thread_settings)));
  // NEGATIVE CONTROL ①: an unmarked twin is the ONLY thing that replaces ours —
  // two wrapper copies with DIFFERENT values are two real changes.
  const m2 = mergeCodexRecords([], [wrapperCopy('high', '2026-09-07T07:10:00.100Z'), wrapperCopy('ultra', '2026-09-07T07:10:01.100Z')]);
  ok(m2.filter((r) => r.payload?.type === 'thread_settings_applied').length === 2,
    'negative control: two DIFFERENT settings changes stay two records', String(m2.filter((r) => r.payload?.type === 'thread_settings_applied').length));
  // NEGATIVE CONTROL ②: high → ultra → high is a real sequence, not a twin.
  // The fold is ADJACENCY-scoped precisely so the third record is not folded
  // into the first (which would leave a rebuilt status reporting 'ultra').
  const m3 = mergeCodexRecords([], [
    { ...wrapperCopy('high', '2026-09-07T07:10:00.100Z') },
    { type: 'turn_context', timestamp: '2026-09-07T07:10:00.500Z', payload: { turn_id: 'T2', effort: 'ultra', wrapper: true } },
    { ...wrapperCopy('ultra', '2026-09-07T07:10:01.100Z') },
    { type: 'turn_context', timestamp: '2026-09-07T07:10:01.500Z', payload: { turn_id: 'T3', effort: 'high', wrapper: true } },
    { ...wrapperCopy('high', '2026-09-07T07:10:02.100Z') },
  ]);
  const seq = m3.filter((r) => r.payload?.type === 'thread_settings_applied').map((r) => r.payload.thread_settings.reasoning_effort);
  ok(JSON.stringify(seq) === JSON.stringify(['high', 'ultra', 'high']),
    'negative control: high → ultra → high survives in order (the LAST value is what a rebuilt status reports)', JSON.stringify(seq));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('— ⑦ the WRITER: the wrapper\'s effort reaches session-meta, so the NEXT resume carries it');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxeff-w-'));
  const BUFFERS_DIR = path.join(tmp, 'buffers'), META_DIR = path.join(tmp, 'meta');
  fs.mkdirSync(BUFFERS_DIR, { recursive: true }); fs.mkdirSync(META_DIR, { recursive: true });
  const activeSessions = new Map();
  const engine = {
    _vsuPending: new Map(), armWorkflowUsageWatcher() { }, kickPoolEval() { }, markLimitBanner() { }, maybePoolAutoSwitch() { },
    maybeRepinLockedModel() { }, maybeStopOnFallback() { }, notePoolAuthFailure() { }, modelsMatch: () => false,
    noteSessionProduced() { }, noteTurnEnd() { }, noteWallSignal() { }, recordRateLimitEvent() { },
    recordCodexQuotaSignal() { }, resolveUsageKey: () => '__global__', usageEstimator: { noteLive() { } },
  };
  const so = require(path.join(REPO, 'src/server/session-stdout.js')).create({
    rootDir: tmp, BUFFERS_DIR, META_DIR, DTACH_CMD: 'dtach', USAGE_SCANNER_PATH: path.join(tmp, 'nope'),
    CLAUDE_STREAM_TYPES: new Set(['system', 'assistant', 'user', 'result']), _seenStreamTypes: new Set(), activeSessions, engine,
    checkClaudeGoalStatus() { }, broadcastToSession() { }, broadcastActiveSessions() { },
    noteModelSeen() { }, noteHarnessModels() { }, recordUsageAttribution() { }, daemonPtyShim: (h) => h,
    sbSeenFirst: () => true, getDeviceMgr: () => null, getHosts: () => null,
  });
  const sess = { backend: 'codex', mode: 'chat', name: 'n', cwd: tmp, sockName: 'cw-eff', createdAt: Date.now(), _fed: [], _ops: [] };
  sess.normalizer = { processLive(m) { sess._fed.push(m); }, onOp() { }, status: () => ({}) };
  activeSessions.set('w-eff', sess);
  const handlers = {};
  const pty = { onData: (f) => { handlers.data = f; }, onExit: () => { }, write() { }, pid: 1 };
  so.setupSessionPty(sess, 'w-eff', pty);
  const J = (o) => JSON.stringify(o) + '\n';
  handlers.data(J({ type: 'session_meta', payload: { id: 'th-w', cwd: tmp } }));
  handlers.data(J({ type: 'wrapper_meta', payload: { threadId: 'th-w', model: 'gpt-6-astra', permissionMode: 'yolo', effort: 'ultra', effortNext: 'ultra' } }));
  const metaOnDisk = () => { try { return JSON.parse(fs.readFileSync(path.join(META_DIR, 'cw-eff.json'), 'utf8')); } catch { return null; } };
  ok(sess._effort === 'ultra', 'the wrapper\'s own effort moves session._effort (it used to move only on a CLIENT click)', String(sess._effort));
  ok(metaOnDisk()?.effort === 'ultra', '…and is PERSISTED to session-meta — the value a resume spawns with', JSON.stringify(metaOnDisk()?.effort));
  // an effort typed as `/effort` inside the chat takes the same road
  handlers.data(J({ type: 'wrapper_meta', payload: { threadId: 'th-w', model: 'gpt-6-astra', permissionMode: 'yolo', effort: 'ultra', effortNext: 'high' } }));
  ok(sess._effort === 'high' && metaOnDisk()?.effort === 'high',
    'a later pending pick (a `/effort` typed into the chat) follows the same road', JSON.stringify({ s: sess._effort, d: metaOnDisk()?.effort }));
  // ── r2 review: `effortNext: null` is a STATEMENT, not a gap ──
  // Picking "Auto (model default)" clears the pick: the wrapper sends
  // thread/settings/update {effort:null}, the thread's effort goes away, and it
  // publishes {effort:'<the last turn ran at>', effortNext:null}. Reading the
  // LIVE value as a fallback re-commanded the level the user had just cleared —
  // into session-meta, the attach payload, the chip after a restart and the
  // next resume spawn. ws-handler had just written null on the same click.
  handlers.data(J({ type: 'wrapper_meta', payload: { threadId: 'th-w', model: 'gpt-6-astra', permissionMode: 'yolo', effort: 'high', effortNext: null } }));
  ok(sess._effort === null, 'clearing the pick CLEARS session._effort (the last turn\'s level is not the next turn\'s pick)', JSON.stringify(sess._effort));
  ok(metaOnDisk()?.effort === null, '…and session-meta with it, so the next resume commands nothing', JSON.stringify(metaOnDisk()?.effort));
  // NEGATIVE CONTROL: a wrapper that PREDATES this release sends neither field.
  // `undefined` is "this record says nothing", and must leave master's value
  // exactly where it was — the version-skew class (2.361.1 / 2.364.1).
  sess._effort = 'ultra';
  handlers.data(J({ type: 'wrapper_meta', payload: { threadId: 'th-w', model: 'gpt-6-astra', permissionMode: 'yolo' } }));
  ok(sess._effort === 'ultra', 'negative control: an OLD wrapper (no effort fields at all) never moves the value', JSON.stringify(sess._effort));
  // and the live value alone is never mistaken for the pending one
  handlers.data(J({ type: 'wrapper_meta', payload: { threadId: 'th-w', model: 'gpt-6-astra', permissionMode: 'yolo', effort: 'max' } }));
  ok(sess._effort === 'ultra', 'negative control: `effort` WITHOUT `effortNext` is the last turn\'s level and is ignored here', JSON.stringify(sess._effort));
  const ev = require(path.join(REPO, 'src/server/stdout/codex-events.js'));
  const src = fs.readFileSync(path.join(REPO, 'src/server/stdout/codex-events.js'), 'utf8');
  ok(/payload\.effortNext !== undefined/.test(src) && !/payload\.effortNext \|\| payload\.effort/.test(src),
    'wiring pin: the writer reads effortNext ONLY (the `|| payload.effort` fallback is the defect, not a belt)');
  void ev;
}

// ───────────────────────────────────────────────────────────────────────────
console.log('— ⑧ spawn / restore wiring pins (the saved effort must REACH the wrapper)');
{
  const wsCreate = fs.readFileSync(path.join(REPO, 'src/ws-create.js'), 'utf8');
  ok(/buildSessionArgs\(\{[\s\S]{0,900}?effort: data\.effort,/.test(wsCreate),
    'ws-create hands the session\'s effort to buildSessionArgs on EVERY create (resume included)');
  ok(/if \(!sessionSpec\.env\.CODEX_WEBUI_EFFORT\).*lastCodexTurnEffort\(data\.resumeId\)/.test(wsCreate),
    'and with none supplied, the resume falls back to the thread\'s OWN last turn effort (B-21e4 continuity)');
  const adapter = fs.readFileSync(path.join(REPO, 'src/adapters/codex.js'), 'utf8');
  ok(/CODEX_WEBUI_EFFORT/.test(adapter), 'the codex adapter is what turns that into the wrapper\'s env');
  const boot = fs.readFileSync(path.join(REPO, 'src/server/boot-restore.js'), 'utf8');
  ok((boot.match(/_effort: meta\.effort \|\| null/g) || []).length >= 3,
    'every boot-restore path restores _effort from session-meta (so a server restart does not lose it)');
  const wsh = fs.readFileSync(path.join(REPO, 'src/ws-handler.js'), 'utf8');
  ok(/chatStatus\.effortNext = session\._effort/.test(wsh), 'the attach payload carries the pending value separately from the running one');
  // the adapter really produces the env for a resume spawn
  const { CodexAdapter } = require(path.join(REPO, 'src/adapters/codex.js'));
  const spec = new CodexAdapter().buildSessionArgs({ cwd: '/w', resumeId: 'th-z', effort: 'ultra', mode: 'chat' });
  ok(spec?.env?.CODEX_WEBUI_EFFORT === 'ultra', 'a resume spawn carries the saved effort into CODEX_WEBUI_EFFORT', JSON.stringify(spec?.env?.CODEX_WEBUI_EFFORT));
}

console.log('— ⑨ client wiring pins');
{
  const cv = fs.readFileSync(path.join(REPO, 'src/lib/chat-view.js'), 'utf8');
  ok(/op\.subtype === 'effort'/.test(cv) && /_statusBar\.setEffort\(/.test(cv), 'chat-view routes the live effort meta op to the status bar');
  ok(/add\(t\('Effort'\), effortDisplay\(/.test(cv), 'the metadata popup renders the effort through effortDisplay');
  const sb = fs.readFileSync(path.join(REPO, 'src/lib/chat-status-bar.js'), 'utf8');
  ok(/setEffort\(live, next\)/.test(sb), 'the status bar exposes setEffort(live, next)');
  ok(/effortDisplay\(this\._backend, this\._statusEffort/.test(sb), 'and its tooltip decorates the value the same way');
  ok(/noteModelCatalog\('codex', models\)/.test(sb), 'the effort picker\'s own catalog fetch feeds the model catalog');
  const appjs = fs.readFileSync(path.join(REPO, 'src/lib/app.js'), 'utf8');
  ok(/noteModelCatalog\(be, data\[be\]\)/.test(appjs), 'the boot catalog fetch feeds it too');
  const srv = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  ok(/multiAgentEffort: m\.multi_agent_reasoning_effort \|\| ''/.test(srv),
    'server.js carries multi_agent_reasoning_effort out of codex\'s own model cache (never a hardcoded level)');
}

// ───────────────────────────────────────────────────────────────────────────
// ⑩ THE VERSION MARKER NAMES THIS CHANGE.
// r2 review: the first cut stamped "2.369.61" into 36 places across 17 files
// while master had ALREADY SHIPPED 2.369.61 as an unrelated release (Alt+Enter
// = steer, 16 seconds before this branch's own commit) — every kb entry and
// code comment then pointed a reader at somebody else's release. This is the
// SECOND time (2.369.58 r2 renumbered 21 files off 2.369.54), and the reason
// the older belt did not catch it: a branch that is not rebased has no
// CHANGELOG entry for EITHER number, so a CHANGELOG-only check passes
// vacuously. The number is claimed on the INTEGRATION BRANCH — so ask git.
console.log('— ⑩ version marker');
{
  const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
  const MARK = '2.369.62';   // renumber HERE and everywhere else in one sed
  const SITES = ['CLAUDE.md', 'data/bin/codex-chat-wrapper.js', 'src/codex-message-manager.js',
    'src/codex-session-store.js', 'src/server/stdout/codex-events.js', 'src/lib/agent-meta.js',
    'src/lib/chat-status-bar.js', 'src/lib/chat-view.js', 'src/ws-handler.js', 'src/session-schema.js',
    'server.js', 'docs/kb-file-structure.md', 'docs/kb-features.md', 'docs/kb-bugfix-invariants.md'];
  for (const f of SITES) ok(read(f).includes(MARK), `${f} carries the marker ${MARK} (all sites name ONE version)`);
  // A leftover mention of the old number is only allowed where it is ABOUT the
  // renumber (the same line names the new one) — anywhere else it is still a
  // cross-reference pointing at somebody else's release.
  const staleLines = [];
  for (const f of SITES) {
    for (const line of read(f).split('\n')) {
      if (/2\.369\.61(?![\d.])/.test(line) && !line.includes(MARK)) staleLines.push(`${f}: ${line.trim().slice(0, 80)}`);
    }
  }
  ok(staleLines.length === 0, 'no site still names the number master took as a live cross-reference', JSON.stringify(staleLines).slice(0, 300));

  const { execFileSync } = await import('node:child_process');
  const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const REF = ['origin/master', 'master'].find((r) => { try { git('rev-parse', '--verify', r); return true; } catch { return false; } });
  /** Everything on the INTEGRATION BRANCH that already claims this number:
   *  release commit subjects (`<n>: …`) and CHANGELOG headings (`## <n> — …`).
   *  A branch's own commit is not on that branch yet, so this is exactly "did
   *  somebody else ship it". */
  const claimants = (mark) => {
    if (!REF) return null;
    const re = new RegExp(`^${mark.replace(/\./g, '\\.')}(?![\\d.])`);
    const out = [];
    for (const line of git('log', '--format=%s', '-400', REF).split('\n')) {
      const t = line.trim(); if (re.test(t)) out.push(t);
    }
    for (const line of git('show', `${REF}:CHANGELOG.md`).split('\n')) {
      const m = /^## (.+)$/.exec(line.trim());
      if (m && re.test(m[1].trim())) out.push(m[1].trim());
    }
    return out;
  };
  const describesThisChange = (text) => /effort|ultra|xhigh|turn_context/i.test(text);
  if (!REF) {
    console.log('  SKIP: no master/origin-master ref in this checkout — the squatter check did not run');
  } else {
    const mine = claimants(MARK);
    ok(mine.length === 0 || mine.every(describesThisChange),
      `${MARK} is unclaimed on ${REF} (or the claim IS this change) — a number another release used = renumber everywhere`,
      JSON.stringify(mine));
    // NEGATIVE CONTROL: the number this branch originally carried really is
    // taken on master, by a change that is not this one. If this goes green
    // the check above is blind and the next parallel branch ships a dangling
    // cross-reference again.
    const squatted = claimants('2.369.61');
    ok(squatted.length > 0 && !squatted.every(describesThisChange),
      'negative control: 2.369.61 IS claimed on the integration branch by a DIFFERENT change (this check can see a squatter)',
      JSON.stringify(squatted));
  }
  // …and the CHANGELOG rule (test-harness-honesty's belt, kept): unreleased =
  // no entry (fine); released = the entry under this number must be OURS.
  const changelog = read('CHANGELOG.md');
  const head = new RegExp(`^## ${MARK.replace(/\./g, '\\.')}(?![\\d.])`, 'm').exec(changelog);
  let entry = null;
  if (head) {
    const next = changelog.indexOf('\n## ', head.index + 1);
    entry = changelog.slice(head.index, next < 0 ? changelog.length : next);
  }
  ok(!entry || describesThisChange(entry),
    `CHANGELOG ${MARK} is either unwritten or describes THIS change`, entry ? entry.slice(0, 160) : 'no entry yet');
}

// ───────────────────────────────────────────────────────────────────────────
// ⑪ THE DISCLOSED GAP HAS AN OWNER, AND ITS TWIN CANNOT DRIFT.
// Task item (3) — "the conversation's saved effort must reach the wrapper on a
// resume" — is only HALF done, and deliberately so: ws-create's B-21e4
// continuity fallback exists, but the client sends the INSTANCE DEFAULT as
// `data.effort` whenever a resume path supplies nothing, which suppresses it.
// Flipping that priority is a product-default decision (owner gate), so what
// this suite does is make the gap immovable-in-silence: both twins pinned (a
// fix that touches effort but not model fails), and the kb paragraph must name
// the backlog id that carries the decision.
console.log('— ⑪ the resume-vs-instance-default gap is PINNED to a backlog id (owner gate)');
{
  const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
  const sl = read('src/lib/session-lifecycle.js');
  ok(/const sessionEffort = effort !== undefined \? effort : defaults\.effort;/.test(sl),
    'the gap is HERE: a resume that supplies nothing gets the instance default as its effort');
  ok(/const sessionModel = model !== undefined \? model : defaults\.model;/.test(sl),
    'STANDING SWEEP: the MODEL twin is the same line — a fix must move both or neither');
  ok(/effort: effort !== undefined \? effort : savedCfg\.effort,/.test(sl) && /model: model !== undefined \? model : savedCfg\.model,/.test(sl),
    'the per-session override path (session card gear) DOES carry the conversation\'s own values — the gap is only "supplied nothing"');
  const wsCreate = read('src/ws-create.js');
  ok(/if \(!sessionSpec\.env\.CODEX_WEBUI_MODEL\).*lastCodexTurnModel\(data\.resumeId\)/.test(wsCreate),
    'and both continuity fallbacks are gated the same way (model twin of the ⑧ pin)');
  // FUNCTIONAL negative control: the fallback is reachable exactly when the
  // client sends no value, and dead exactly when it sends one. That is the
  // whole mechanism, measured on the real adapter rather than asserted in prose.
  const { CodexAdapter } = require(path.join(REPO, 'src/adapters/codex.js'));
  const envFor = (effort) => new CodexAdapter().buildSessionArgs({ cwd: '/w', resumeId: 'th-z', effort, mode: 'chat' }).env.CODEX_WEBUI_EFFORT;
  ok(!envFor('') && !envFor(undefined), 'no value ⇒ empty CODEX_WEBUI_EFFORT ⇒ ws-create\'s continuity fallback RUNS', JSON.stringify([envFor(''), envFor(undefined)]));
  ok(envFor('xhigh') === 'xhigh', 'a value (incl. the instance default) ⇒ the fallback is skipped — the gap, reproduced in one line', JSON.stringify(envFor('xhigh')));
  // the decision is filed, not just narrated
  const kb = read('docs/kb-bugfix-invariants.md');
  ok(/B-6b6d/.test(kb), 'the kb entry names the backlog id that carries the owner decision (a paragraph nobody re-reads is not an owner)');
  ok(/chat resume bar|resume-all/.test(kb) && /session-lifecycle\.js/.test(kb),
    'and it states the PRECISE scope (which resume paths, which line) instead of "every resume"');
}

console.log(fail ? `\nFAILED (${fail} of ${pass + fail})` : `\nALL PASS (${pass})`);
if (werr && fail) console.error('wrapper stderr:\n' + werr.slice(-2000));
process.exit(fail ? 1 : 0);
