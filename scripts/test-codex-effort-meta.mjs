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
  // B-6b6d: WHICH FACT that value is. We commanded nothing (no CODEX_WEBUI_EFFORT
  // on this bench), so the wrapper is reporting what the THREAD itself runs at.
  ok(sess._effortOrigin === 'conversation',
    '…and with nothing commanded, the value the wrapper adopted from the thread is stated as the CONVERSATION\'s own', String(sess._effortOrigin));
  ok(metaOnDisk()?.effort === 'ultra', '…and is PERSISTED to session-meta — the value a resume spawns with', JSON.stringify(metaOnDisk()?.effort));
  // r3 (adversarial verifier, medium): the ORIGIN is persisted WITH the value
  // it describes. Without this the disk kept the spawn's origin while memory
  // moved on, and boot-restore rebuilt the stale one.
  ok(metaOnDisk()?.effortOrigin === 'conversation',
    'r3: …and so is WHICH FACT it is — the writer that re-authors the origin must write it', JSON.stringify(metaOnDisk()?.effortOrigin));
  // an effort typed as `/effort` inside the chat takes the same road
  handlers.data(J({ type: 'wrapper_meta', payload: { threadId: 'th-w', model: 'gpt-6-astra', permissionMode: 'yolo', effort: 'ultra', effortNext: 'high' } }));
  ok(sess._effort === 'high' && metaOnDisk()?.effort === 'high',
    'a later pending pick (a `/effort` typed into the chat) follows the same road', JSON.stringify({ s: sess._effort, d: metaOnDisk()?.effort }));
  ok(sess._effortOrigin === 'chosen',
    '…and moving AWAY from a value we already knew is a choice made inside the session, not the conversation\'s own (B-6b6d)', String(sess._effortOrigin));
  ok(metaOnDisk()?.effortOrigin === 'chosen',
    'r3: …on disk too, so a server restart cannot rebuild a hand-changed value as "the conversation\'s own"', JSON.stringify(metaOnDisk()?.effortOrigin));
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
  // ── r3 ①: THE SPAWN'S OWN STATE, then a `/effort` typed inside it ───────
  // The bench above starts from nothing; the defect the verifier reproduced
  // needs the state ws-create really persists for a codex resume whose rollout
  // said ultra ({effort:'ultra', effortOrigin:'conversation', modelOrigin:
  // 'conversation'} — verified on disk in a live-server probe). Memory then
  // moved to high/chosen while the DISK kept 'conversation', and boot-restore
  // reads meta.effortOrigin ⇒ after a restart the panel called a value the
  // user had just changed by hand "this conversation's own value".
  {
    const spawnMeta = {
      name: 'van', cwd: tmp, backend: 'codex', backendSessionId: 'th-w2', mode: 'chat', webuiSessionId: 'w-eff2',
      effort: 'ultra', effortOrigin: 'conversation', modelOrigin: 'conversation',
    };
    fs.writeFileSync(path.join(META_DIR, 'cw-eff2.json'), JSON.stringify(spawnMeta));
    const s2 = {
      backend: 'codex', mode: 'chat', name: 'van', cwd: tmp, sockName: 'cw-eff2', createdAt: Date.now(),
      backendSessionId: 'th-w2', _effort: 'ultra', _effortOrigin: 'conversation', _fed: [],
      // …and NO `_modelOrigin` on the session object: this writer never
      // authors it, so the disk key must survive through the spread.
    };
    s2.normalizer = { processLive(m) { s2._fed.push(m); }, onOp() { }, status: () => ({}) };
    activeSessions.set('w-eff2', s2);
    const h2 = {};
    so.setupSessionPty(s2, 'w-eff2', { onData: (f) => { h2.data = f; }, onExit: () => { }, write() { }, pid: 2 });
    const disk2 = () => { try { return JSON.parse(fs.readFileSync(path.join(META_DIR, 'cw-eff2.json'), 'utf8')); } catch { return null; } };
    h2.data(J({ type: 'wrapper_meta', payload: { threadId: 'th-w2', effort: 'ultra', effortNext: 'high' } }));
    ok(s2._effort === 'high' && s2._effortOrigin === 'chosen',
      'r3 ① the scenario: `/effort high` inside a resumed ultra conversation ⇒ memory says high / chosen',
      JSON.stringify({ e: s2._effort, o: s2._effortOrigin }));
    ok(disk2()?.effort === 'high' && disk2()?.effortOrigin === 'chosen',
      'r3 ① THE FIX: the disk says the same — before it kept "conversation" and boot-restore rebuilt that',
      JSON.stringify({ e: disk2()?.effort, o: disk2()?.effortOrigin }));
    // …and what the panel would claim after a restart, through the REAL rule
    const { spawnValueOrigin } = await import(path.join(REPO, 'src/lib/agent-meta.js'));
    ok(spawnValueOrigin(disk2()?.effortOrigin, disk2()?.effort, undefined) === spawnValueOrigin(s2._effortOrigin, s2._effort, undefined),
      'r3 ①: a restarted session and the live one make the SAME claim (the contradiction the origin exists to remove)',
      JSON.stringify([spawnValueOrigin(disk2()?.effortOrigin, disk2()?.effort, undefined), spawnValueOrigin(s2._effortOrigin, s2._effort, undefined)]));
    // NEGATIVE CONTROL ①: the key this writer does NOT author survives it.
    // Re-listing `modelOrigin` here would stamp null over a real disk value
    // (the session object above deliberately carries none) — the spread is
    // what carries it, and that has to be measured, not assumed.
    ok(disk2()?.modelOrigin === 'conversation',
      'r3 ① negative control: `modelOrigin` — which this consumer never authors — survives the write untouched',
      JSON.stringify(disk2()?.modelOrigin));
    // NEGATIVE CONTROL ②: a wrapper that says nothing about effort changes
    // NEITHER the value nor the origin, on disk or in memory (version skew).
    const before2 = JSON.stringify(disk2());
    h2.data(J({ type: 'wrapper_meta', payload: { threadId: 'th-w2', model: 'gpt-6-astra' } }));
    ok(s2._effortOrigin === 'chosen' && JSON.stringify(disk2()) === before2,
      'r3 ① negative control: an OLD wrapper (no effort fields) re-authors nothing and rewrites nothing',
      JSON.stringify({ o: s2._effortOrigin, changed: JSON.stringify(disk2()) !== before2 }));
    // …and boot-restore really is the reader that makes this matter.
    const bootSrc = fs.readFileSync(path.join(REPO, 'src/server/boot-restore.js'), 'utf8');
    ok((bootSrc.match(/_effortOrigin: meta\.effortOrigin \|\| null/g) || []).length >= 3,
      'r3 ①: …and boot-restore is what reads that key back (all three restore paths)');
  }
  const ev = require(path.join(REPO, 'src/server/stdout/codex-events.js'));
  const src = fs.readFileSync(path.join(REPO, 'src/server/stdout/codex-events.js'), 'utf8');
  ok(/payload\.effortNext !== undefined/.test(src) && !/payload\.effortNext \|\| payload\.effort/.test(src),
    'wiring pin: the writer reads effortNext ONLY (the `|| payload.effort` fallback is the defect, not a belt)');
  ok(/effortOrigin: session\._effortOrigin \|\| null,/.test(src) && !/modelOrigin: session\._modelOrigin/.test(src),
    'r3 ① wiring pin: the meta write lists the key it AUTHORS (effortOrigin) and not the one it does not (modelOrigin — the spread carries that)');
  void ev;
}

// ───────────────────────────────────────────────────────────────────────────
console.log('— ⑧ spawn / restore wiring pins (the saved effort must REACH the wrapper)');
{
  const wsCreate = fs.readFileSync(path.join(REPO, 'src/ws-create.js'), 'utf8');
  ok(/buildSessionArgs\(\{[\s\S]{0,900}?effort: data\.effort,/.test(wsCreate),
    'ws-create hands the session\'s effort to buildSessionArgs on EVERY create (resume included)');
  // B-6b6d: with none supplied the fallback still runs — as the shared ladder
  // one step earlier (leg ⑪ measures it end to end), not as a codex-only env
  // post-fill whose `env is empty` test the client had made unreachable.
  ok(/await pickKnob\(data\.effort, hstore\.lastTurnEffort, 'defaultEffort'\)/.test(wsCreate)
    && /const conversation = stated \? '' : await fromConversation\(hook\);/.test(wsCreate),
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
// ⑩ EVERY VERSION MARKER IN THE TREE MUST RESOLVE — AND THIS BRANCH MUST NOT
//    SQUAT A NUMBER.
// History: the first cut stamped "2.369.61" into 36 places across 17 files
// while master had ALREADY SHIPPED 2.369.61 as an unrelated release (Alt+Enter
// = steer, 16 seconds before this branch's own commit) — every kb entry and
// code comment then pointed a reader at somebody else's release. That was the
// SECOND time (2.369.58 r2 renumbered 21 files off 2.369.54), and the reason
// the older belt did not catch it: a branch that is not rebased has no
// CHANGELOG entry for EITHER number, so a CHANGELOG-only check passes
// vacuously. The number is claimed on the INTEGRATION BRANCH — so ask git.
//
// INTEGRATION r2 — THE LEG WAS ITSELF LYING (reproduced). It carried
// `MARK = '2.369.62'` as "this change's marker" and cleared any claimant whose
// text matched /effort|ultra|xhigh|turn_context/i. By then master had RELEASED
// 2.369.62 for the PREDECESSOR change (subject: "codex effort a TURN ran at …
// test-codex-effort-meta 108; B-6b6d filed for the resume-default half") —
// which matches that topic regex by construction, because the sites cite it
// PRECISELY for being on that topic. So `mine.every(describesThisChange)` was
// true and the assert went green while asserting something false. A topic
// regex cannot separate a predecessor release from its own follow-up.
//
// The number was playing TWO roles that this leg conflated, so it now asks two
// questions:
//   ① 2.369.62 is a CROSS-REFERENCE to a released ancestor. Every site cites it
//      for the effort work it really shipped, so the invariant is that the
//      reference RESOLVES on the integration branch (the release exists AND is
//      about that topic) — not that it names the branch we are on. Rewriting
//      those to an unreleased number would MANUFACTURE the dangling reference
//      this leg exists to prevent (master's 2.369.62 is an ancestor of HEAD).
//   ② THIS branch (B-6b6d + readings-by-slot + the login-expiry merge) is
//      UNRELEASED and deliberately stamps NO number of its own — the
//      integrator assigns one at release. The leg therefore names the first
//      unclaimed number and PROVES it is unclaimed, so the check runs against
//      a live number instead of going vacuous, and refuses any number that a
//      release already took.
console.log('— ⑩ version markers resolve; this branch squats nothing');
{
  const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
  // The RELEASED predecessor every site below back-references. Not this change.
  const PREDECESSOR = '2.369.62';
  // The number the integrator should take (master's head is 2.369.67). Nothing
  // in the tree is stamped with it — that is the point: it must still be free.
  const NEXT_FREE = '2.369.68';
  const SITES = ['CLAUDE.md', 'data/bin/codex-chat-wrapper.js', 'src/codex-message-manager.js',
    'src/codex-session-store.js', 'src/server/stdout/codex-events.js', 'src/lib/agent-meta.js',
    'src/lib/chat-status-bar.js', 'src/lib/chat-view.js', 'src/ws-handler.js', 'src/session-schema.js',
    'server.js', 'docs/kb-file-structure.md', 'docs/kb-features.md', 'docs/kb-bugfix-invariants.md'];
  for (const f of SITES) ok(read(f).includes(PREDECESSOR), `${f} back-references the predecessor ${PREDECESSOR} (all sites name ONE version)`);
  // A leftover mention of 2.369.61 is only allowed where it is ABOUT the
  // renumber (the same line names the predecessor) — anywhere else it is still
  // a cross-reference pointing at somebody else's release.
  const staleLines = [];
  for (const f of SITES) {
    for (const line of read(f).split('\n')) {
      if (/2\.369\.61(?![\d.])/.test(line) && !line.includes(PREDECESSOR)) staleLines.push(`${f}: ${line.trim().slice(0, 80)}`);
    }
  }
  ok(staleLines.length === 0, 'no site still names the number master took as a live cross-reference', JSON.stringify(staleLines).slice(0, 300));

  const { execFileSync } = await import('node:child_process');
  const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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
  // TWO predicates, because "same topic" and "same change" are different
  // questions and the old single one could not tell a predecessor from its
  // follow-up. `describesThisChange` demands a marker only THIS branch's work
  // carries — deliberately NOT 'B-6b6d', which the predecessor's own subject
  // already names ("B-6b6d filed for the resume-default half").
  const describesTheEffortTopic = (text) => /effort|ultra|xhigh|turn_context/i.test(text);
  const describesThisChange = (text) => /resumeSpawnPick|resume[- ]continuity|resume ladder|spawnOriginHint|readingSlotFor|readings[- ]by[- ]slot/i.test(text);
  if (!REF) {
    console.log('  SKIP: no master/origin-master ref in this checkout — the claim checks did not run');
  } else {
    // ① the back-reference RESOLVES: the release exists and is about the work
    //    the sites cite it for.
    const pred = claimants(PREDECESSOR);
    ok(pred.length > 0 && pred.every(describesTheEffortTopic),
      `${PREDECESSOR} is a RELEASED ancestor about the effort work every site cites it for (a marker is a cross-reference — it must resolve)`,
      JSON.stringify(pred).slice(0, 200));
    // ② the number the integrator will take is genuinely free.
    const next = claimants(NEXT_FREE);
    ok(next.length === 0, `${NEXT_FREE} is unclaimed on ${REF} — the integrator may take it`, JSON.stringify(next));
    // ③ and this branch stamps NO unreleased number in any of the files a
    //    reader cross-references. (The suite itself is NOT in this census: its
    //    NEXT_FREE is the DECLARATION of a free number, asserted free above,
    //    not a cross-reference to a release.)
    const unreleasedIn = (text) => {
      const out = [];
      for (const v of text.match(/2\.369\.\d+(?![\d.])/g) || []) { if (claimants(v).length === 0) out.push(v); }
      return [...new Set(out)];
    };
    const squatted = [];
    for (const f of SITES) for (const v of unreleasedIn(read(f))) squatted.push(`${f}: ${v}`);
    ok(squatted.length === 0, 'every version number named in the cited files is a RELEASE that exists on the integration branch (this branch squats none)', JSON.stringify([...new Set(squatted)]).slice(0, 300));
    // NEGATIVE CONTROL C: the census has teeth — the same predicate over a
    // site's text with an unreleased stamp spliced in reports it. (The r2
    // defect was a green assert over a number nobody had checked against git.)
    ok(unreleasedIn(read('CLAUDE.md') + '\n(2.369.9001 residue)').includes('2.369.9001')
       && unreleasedIn(read('CLAUDE.md')).length === 0,
      'negative control C: the census reports an unreleased stamp spliced into a real site, and is silent on the real text');
    // NEGATIVE CONTROL A — the leg's own r2 defect: the predecessor release is
    // ON TOPIC, so the OLD predicate cleared it while the strict one does not.
    // This is the permanent proof that a same-topic squatter is now visible.
    ok(pred.every(describesTheEffortTopic) && !pred.some(describesThisChange),
      'negative control A: the SAME-TOPIC predecessor 2.369.62 passes the old topic regex and FAILS the strict one (the blindness this r2 fixed)',
      JSON.stringify(pred).slice(0, 200));
    // NEGATIVE CONTROL B — an OFF-TOPIC squatter is still caught (the r2 case
    // this leg was originally written for).
    const off = claimants('2.369.61');
    ok(off.length > 0 && !off.every(describesThisChange),
      'negative control B: 2.369.61 IS claimed on the integration branch by a DIFFERENT change (this check can see a squatter)',
      JSON.stringify(off));
  }
  // …and the CHANGELOG rule (test-harness-honesty's belt, kept): unreleased =
  // no entry (fine); released under the number we take = the entry must be OURS.
  const changelog = read('CHANGELOG.md');
  const head = new RegExp(`^## ${NEXT_FREE.replace(/\./g, '\\.')}(?![\\d.])`, 'm').exec(changelog);
  let entry = null;
  if (head) {
    const next = changelog.indexOf('\n## ', head.index + 1);
    entry = changelog.slice(head.index, next < 0 ? changelog.length : next);
  }
  ok(!entry || describesThisChange(entry),
    `CHANGELOG ${NEXT_FREE} is either unwritten (this branch makes no release) or describes THIS change`, entry ? entry.slice(0, 160) : 'no entry yet');
}

// ───────────────────────────────────────────────────────────────────────────
// ⑪ THE RESUME LADDER: A CONVERSATION KEEPS ITS OWN EFFORT/MODEL (B-6b6d).
// This leg used to PIN the gap (the client filled `codex.defaultEffort` into
// every resume, which suppressed ws-create's B-21e4 continuity fallback and
// resumed an `ultra` conversation at `xhigh`). The owner ruled on 2026-09-07:
// the instance default is a NEW-session default; a resume/fork/restart takes
// the conversation's OWN value; an explicit per-session pick still wins. The
// leg now measures the fixed ladder end to end — rollout → harness descriptor
// → the PURE ladder → the adapter's env → the REAL wrapper's first
// turn_context → the REAL normalizer's per-message meta.
console.log('— ⑪ the resume ladder (B-6b6d): the conversation\'s own value wins, the instance default is for NEW sessions');
const { resumeSpawnPick } = require(path.join(REPO, 'src/resume-continuity.js'));
{
  const pick = (a) => { const r = resumeSpawnPick(a); return r.value + '/' + r.origin; };
  ok(pick({ explicit: 'xhigh', conversation: 'ultra', instanceDefault: 'medium', resume: true, hasSource: true }) === 'xhigh/chosen',
    'an explicit per-session pick beats the conversation AND the default (the card ⚙ keeps working)', pick({ explicit: 'xhigh', conversation: 'ultra', instanceDefault: 'medium', resume: true, hasSource: true }));
  ok(pick({ conversation: 'ultra', instanceDefault: 'xhigh', resume: true, hasSource: true }) === 'ultra/conversation',
    'THE FIX: a resume that supplies nothing takes the conversation\'s own value, not codex.defaultEffort');
  ok(pick({ conversation: '', instanceDefault: 'xhigh', resume: true, hasSource: true }) === 'xhigh/instance',
    'a conversation with NOTHING recorded yet falls back to the instance default — honestly, and the caller logs it');
  ok(pick({ instanceDefault: 'xhigh', resume: true, hasSource: false }) === '/harness',
    'a knob this harness cannot read back (claude effort) sends NOTHING on a resume — an unconditional default there IS the defect');
  ok(pick({ instanceDefault: 'xhigh', resume: false, hasSource: false }) === 'xhigh/instance'
    && pick({ instanceDefault: 'xhigh', resume: false, hasSource: true }) === 'xhigh/instance',
    'a NEW session still gets the instance default, source or no source');
  ok(pick({ resume: false }) === '/harness' && pick({ resume: true, hasSource: true }) === '/harness',
    'nothing anywhere = nothing sent (the agent\'s own config decides)');
  ok(pick({ explicit: '', conversation: 'ultra', instanceDefault: 'xhigh', resume: true, hasSource: true }) === 'ultra/conversation',
    "on a CONTINUATION '' and undefined are the same no-pick: that path sends `model || undefined`, so an explicit \"Auto\" and an absent field are identical bytes");
  // r2 (adversarial verifier, medium): the New Session dialog ALWAYS sends a
  // defined string and its FIRST option is '' ("Auto (model default)" /
  // "Default"). Collapsing that into "no pick" made an explicit Auto resolve to
  // the instance default — the user asked the agent to decide and got xhigh.
  ok(pick({ explicit: '', instanceDefault: 'xhigh', resume: false, hasSource: false }) === '/chosen'
    && pick({ explicit: '', instanceDefault: 'xhigh', resume: false, hasSource: true }) === '/chosen'
    && pick({ explicit: '   ', instanceDefault: 'xhigh', resume: false }) === '/chosen',
    'r2 THE FIX: a NEW session with an explicit "Auto (model default)" commands NOTHING — a STATED empty is a choice, not silence',
    pick({ explicit: '', instanceDefault: 'xhigh', resume: false, hasSource: false }));
  ok(pick({ instanceDefault: 'xhigh', resume: false }) === 'xhigh/instance'
    && pick({ explicit: undefined, instanceDefault: 'xhigh', resume: false }) === 'xhigh/instance'
    && pick({ explicit: null, instanceDefault: 'xhigh', resume: false }) === 'xhigh/instance',
    'negative control: a NEW session that supplied NOTHING still gets the instance default (only a DEFINED empty is a choice)');
  ok(pick({ explicit: '', conversation: '', instanceDefault: 'xhigh', resume: true, hasSource: true }) === 'xhigh/instance',
    "…and the stated empty is NOT honoured on a continuation, where the wire cannot carry it (the rule is scoped, not global)");
}

console.log('— ⑪a2 r2: dialog → client → THE WIRE → server ladder → adapter env (an explicit "Auto" must survive all four)');
{
  // Both halves are the product's own composition, and ⑪c pins each of these
  // three lines VERBATIM against the source files — so this leg measures the
  // real chain rather than a paraphrase of it.
  const clientPick = (explicit, instanceDefault, continuesConversation) =>
    resumeSpawnPick({ explicit, instanceDefault, resume: continuesConversation, hasSource: false }).value;
  const wireKnob = (v, continuesConversation) => (continuesConversation ? (v || undefined) : v);
  const createMsg = (dialogEffort, dflt, resumeId) => {
    const continuesConversation = !!resumeId;
    const msg = { type: 'create', backend: 'codex', resumeId: resumeId || undefined, effort: wireKnob(clientPick(dialogEffort, dflt, continuesConversation), continuesConversation) };
    return JSON.parse(JSON.stringify(msg));   // ← the actual JSON round trip
  };
  // the SERVER half, as ws-create composes it (⑪c pins the two lines)
  const serverPick = (data, conversation, dflt, hasSource) => {
    const stated = data.effort !== undefined && data.effort !== null && String(data.effort).trim() !== '';
    return resumeSpawnPick({ explicit: data.effort, conversation: stated ? '' : conversation, instanceDefault: dflt, resume: !!data.resumeId, hasSource });
  };
  const { CodexAdapter } = require(path.join(REPO, 'src/adapters/codex.js'));
  const envOf = (p2, resumeId) => new CodexAdapter().buildSessionArgs({ cwd: '/w', resumeId, effort: p2.value || undefined, mode: 'chat' }).env.CODEX_WEBUI_EFFORT;

  // (a) the dialog's FIRST option, on a NEW session, with the instance default set
  const autoMsg = createMsg('', 'xhigh', null);
  ok(Object.prototype.hasOwnProperty.call(autoMsg, 'effort') && autoMsg.effort === '',
    'r2: an explicit "Auto (model default)" survives the JSON wire as a STATED empty on a NEW create',
    JSON.stringify(autoMsg));
  const autoPick = serverPick(autoMsg, '', 'xhigh', true);
  ok(autoPick.value === '' && autoPick.origin === 'chosen' && !envOf(autoPick, null),
    'r2 THE FIX end to end: the server reads it as the user’s choice and the adapter spawns with NO effort — what master did',
    JSON.stringify([autoPick, envOf(autoPick, null)]));
  // (b) the dialog untouched: it is PRE-FILLED with the instance default, so the
  //     user submits that string and it is honoured (unchanged behaviour)
  const dfltMsg = createMsg('xhigh', 'xhigh', null);
  ok(dfltMsg.effort === 'xhigh' && envOf(serverPick(dfltMsg, '', 'xhigh', true), null) === 'xhigh',
    'negative control: submitting the pre-filled instance default still spawns with it');
  // (c) a create from a path that supplies nothing at all
  const bareMsg = createMsg(undefined, 'xhigh', null);
  ok(bareMsg.effort === 'xhigh' && envOf(serverPick(bareMsg, '', 'xhigh', true), null) === 'xhigh',
    'negative control: a NEW session that supplied NOTHING still gets the instance default');
  // (d) the PRE-FIX client, replayed: `''` collapsed to no-pick, then the
  //     ladder answered the instance default — the defect, in one line
  const preFixClient = (explicit, dflt) => resumeSpawnPick({ explicit: explicit || undefined, instanceDefault: dflt, resume: false, hasSource: false }).value;
  const preFixMsg = JSON.parse(JSON.stringify({ effort: preFixClient('', 'xhigh') || undefined }));
  ok(preFixMsg.effort === 'xhigh' && envOf(serverPick(preFixMsg, '', 'xhigh', true), null) === 'xhigh',
    'r2 REPRODUCED (negative control): the ROUND-1 client turned the dialog’s explicit Auto into codex.defaultEffort, all the way to the spawn env',
    JSON.stringify(preFixMsg));
  // (e) …and the rule is SCOPED: on a continuation the wire cannot carry the
  //     distinction, and there '' still means "take the conversation's own"
  const resumeMsg = createMsg('', 'xhigh', 'th-x');
  ok(resumeMsg.effort === undefined,
    'on a RESUME the client still sends nothing (the create message drops the empty there — one rule, two transports)',
    JSON.stringify(resumeMsg));
  const resumePick = serverPick(resumeMsg, 'ultra', 'xhigh', true);
  ok(resumePick.value === 'ultra' && resumePick.origin === 'conversation' && envOf(resumePick, 'th-x') === 'ultra',
    '…and the conversation’s own value still wins there (the owner’s incident stays fixed)');
}

console.log('— ⑪b end-to-end: a rollout at ultra → descriptor → ladder → adapter env → the REAL wrapper');
const _homeBefore = process.env.HOME, _codexHomeBefore = process.env.CODEX_HOME;
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-b6b6d-home-'));
  process.env.HOME = home; process.env.CODEX_HOME = path.join(home, '.codex');
  const rdir = path.join(REPO, 'data', 'remote-jsonl', 'b6b6d-fixture', 'codex');
  fs.mkdirSync(rdir, { recursive: true });
  const TID = '01a072a3-0d70-78c3-9a90-a69a61e14466';
  const rec = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(path.join(rdir, `${TID}.jsonl`), [
    rec({ timestamp: '2026-09-06T20:33:00.000Z', type: 'session_meta', payload: { id: TID, cwd: '/w', originator: 'claude-code-webui' } }),
    // the conversation ran at xhigh, then the owner set it to ultra
    rec({ timestamp: '2026-09-06T20:33:10.000Z', type: 'turn_context', payload: { cwd: '/w', model: 'gpt-5.6-sol', effort: 'xhigh' } }),
    rec({ timestamp: '2026-09-06T20:40:00.000Z', type: 'turn_context', payload: { cwd: '/w', model: 'gpt-6-astra', effort: 'ultra' } }),
  ].join(''));

  const hx = require(path.join(REPO, 'src/harnesses/codex.js'));
  ok(hx.store.lastTurnEffort(TID) === 'ultra' && hx.store.lastTurnModel(TID) === 'gpt-6-astra',
    'the codex DESCRIPTOR answers "what did this conversation last run at" (its presence IS the declaration — no second caps boolean to drift)',
    JSON.stringify([hx.store.lastTurnEffort(TID), hx.store.lastTurnModel(TID)]));
  ok(typeof hx.store.lastTurnModel === 'function' && typeof hx.store.lastTurnEffort === 'function',
    'codex declares BOTH knobs (its rollout writes a turn_context per turn)');

  // THE LADDER, exactly as ws-create composes it: no explicit value, resume,
  // the instance default that caused the incident.
  const ePick = resumeSpawnPick({ explicit: undefined, conversation: hx.store.lastTurnEffort(TID), instanceDefault: 'xhigh', resume: true, hasSource: true });
  const mPick = resumeSpawnPick({ explicit: undefined, conversation: hx.store.lastTurnModel(TID), instanceDefault: 'gpt-5.6-sol', resume: true, hasSource: true });
  ok(ePick.value === 'ultra' && ePick.origin === 'conversation' && mPick.value === 'gpt-6-astra',
    'the ladder resolves BOTH twins off the rollout (STANDING SWEEP: effort and model move together)', JSON.stringify([ePick, mPick]));

  const { CodexAdapter } = require(path.join(REPO, 'src/adapters/codex.js'));
  const spec = new CodexAdapter().buildSessionArgs({ cwd: '/w', resumeId: TID, effort: ePick.value, model: mPick.value, mode: 'chat' });
  ok(spec.env.CODEX_WEBUI_EFFORT === 'ultra' && spec.env.CODEX_WEBUI_MODEL === 'gpt-6-astra',
    'the adapter turns the ladder\'s answer into the wrapper\'s env — the value that REACHES the agent', JSON.stringify([spec.env.CODEX_WEBUI_EFFORT, spec.env.CODEX_WEBUI_MODEL]));

  // NEGATIVE CONTROL: master's client rule, replayed. It filled the instance
  // default whenever a resume path supplied nothing, so the ladder never saw
  // "nothing" and the conversation's own value could not win.
  const preFixClient = (explicit, dflt) => (explicit !== undefined ? explicit : dflt);
  const preFix = resumeSpawnPick({ explicit: preFixClient(undefined, 'xhigh'), conversation: 'ultra', instanceDefault: 'xhigh', resume: true, hasSource: true });
  ok(preFix.value === 'xhigh' && preFix.origin === 'chosen',
    'negative control: the PRE-FIX client sends xhigh, which the ladder can only read as an explicit choice — the incident, in one line', JSON.stringify(preFix));
  ok(new CodexAdapter().buildSessionArgs({ cwd: '/w', resumeId: TID, effort: preFix.value, mode: 'chat' }).env.CODEX_WEBUI_EFFORT === 'xhigh',
    '…and that is the env leg ② spawned the real wrapper with, whose FIRST turn_context said xhigh (the owner\'s report)');

  // …and the REAL wrapper, spawned with the env the LADDER produced.
  const d11 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxeff-lad-'));
  const buf11 = path.join(d11, 'sess-l.buf'), meta11 = path.join(d11, 'sess-l.json'), rpc11 = path.join(d11, 'rpc.jsonl');
  const STUB11 = STUB.split(JSON.stringify(rpcLog)).join(JSON.stringify(rpc11)).split(JSON.stringify(dir)).join(JSON.stringify(d11));
  const w11 = spawn(process.execPath, [path.join(REPO, 'data/bin/codex-chat-wrapper.js'), buf11, meta11, process.execPath, '-e', STUB11], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env, CODEX_WEBUI_CWD: d11, VIBESPACE_API: '', VIBESPACE_SESSION_TOKEN: '', VIBESPACE_SKIP_AGENT_HOOKS: '1',
      CODEX_WEBUI_RESUME_ID: 'th-eff',
      // ← NOT hand-written: this is spec.env from the ladder above
      CODEX_WEBUI_EFFORT: spec.env.CODEX_WEBUI_EFFORT, CODEX_WEBUI_MODEL: spec.env.CODEX_WEBUI_MODEL,
    },
  });
  let out11 = ''; w11.stdout.on('data', (d) => { out11 += d; });
  const ev11 = () => out11.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const meta11Read = () => { try { return JSON.parse(fs.readFileSync(meta11, 'utf8')); } catch { return null; } };
  const wait11 = async (pred, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(60); } return pred(); };
  ok(await wait11(() => meta11Read()?.threadId === 'th-eff'), 'the ladder-env bench resumed');
  ok(await wait11(() => ev11().some((r) => r.type === 'turn_context')), 'it produced a turn_context');
  const tcs11 = ev11().filter((r) => r.type === 'turn_context');
  ok(tcs11[0]?.payload?.effort === 'ultra',
    'THE FIX, end to end: the FIRST (provisional) turn_context already says ultra — there is no window in which a reader sees xhigh',
    JSON.stringify(tcs11.map((r) => r.payload.effort)));
  ok(tcs11.every((r) => r.payload.effort === 'ultra'), 'and every copy of it agrees', JSON.stringify(tcs11.map((r) => r.payload.effort)));
  // through the REAL normalizer, fed ONLY up to that first record (the owner's
  // 1137-line buffer had exactly one turn_context — that is the shape that must
  // now be right, not just the corrected restatement)
  {
    const upToFirst = ev11().slice(0, ev11().findIndex((r) => r.type === 'turn_context') + 1);
    const mm = new CodexMessageManager('b6b6d-1');
    for (const r of [...upToFirst,
      { type: 'response_item', payload: { type: 'message', item_id: 'it-l', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 0, outputTokens: 2 }, total_token_usage: { totalTokens: 110, inputTokens: 80, cachedInputTokens: 0, outputTokens: 20 }, model_context_window: 272000 } } },
    ]) mm.processLive(r);
    ok(mm.status().effort === 'ultra' && mm.messages.find((m) => m.role === 'assistant')?.meta?.effort === 'ultra',
      'a buffer with ONE turn_context (the owner\'s shape) now stamps every message ultra', JSON.stringify([mm.status().effort, mm.messages.find((m) => m.role === 'assistant')?.meta?.effort]));
  }
  try { w11.stdin.end(); w11.kill(); } catch { }

  // ── THE CLAUDE TWIN, ROUND 2: NEITHER KNOB HAS A COMMANDABLE SOURCE ──────
  // Round 1 read the transcript's last MAIN-THREAD assistant `message.model`
  // and commanded it on every claude resume. The adversarial verifier
  // reproduced two defects on the owner's real 231k-line transcript, and BOTH
  // are properties of the FIELD rather than of the guard around it, so the
  // SOURCE is gone rather than repaired (a rung that can never produce a
  // commandable answer must not ship as the capability — 2.369.66).
  // These legs pin the DATA facts that decided it, in the record order the CLI
  // really writes, plus the behaviour that follows.
  const store = require(path.join(REPO, 'src/session-store.js'));
  const cdir = path.join(home, '.claude', 'projects', '-w'); fs.mkdirSync(cdir, { recursive: true });
  // (a) THE REAL RECORD ORDER of a safety-classifier reroute. Measured on the
  //     owner's transcript: 139 reroutes, each an ASSISTANT record whose
  //     message.model is ALREADY the fallback target and which carries a
  //     {type:'fallback',from,to} content block; the
  //     system/model_refusal_fallback record lands 2-10 lines AFTER it, so a
  //     ≤20-line BACKWARD look-back matched 1 of 139. Round 1's fixture wrote
  //     the system record BEFORE the assistant record it describes, which is
  //     why its suite stayed green.
  const FID = '9f000000-0000-4000-8000-00000000fbfb';
  const rerouteLines = [
    rec({ type: 'assistant', uuid: 'b1', message: { model: 'claude-fable-5', content: [{ type: 'text', text: 'before' }] } }),
    rec({ type: 'user', uuid: 'b2', message: { role: 'user', content: 'something the classifier flags' } }),
    rec({ type: 'assistant', uuid: 'b3', message: { model: 'claude-opus-4-8', content: [{ type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-4-8' } }] } }),
    rec({ type: 'assistant', uuid: 'b4', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'retried' }] } }),
    rec({ type: 'system', subtype: 'model_refusal_fallback', uuid: 'b5', originalModel: 'claude-fable-5[1m]', fallbackModel: 'claude-opus-4-8' }),
  ];
  fs.writeFileSync(path.join(cdir, FID + '.jsonl'), rerouteLines.join(''));
  // The reader round 1 shipped, restated here so the DATA can be measured
  // without the deleted code: "last main-thread assistant message.model", plus
  // round 1's ≤20-line BACKWARD look-back for the system record.
  const r1Reader = (lines) => {
    for (let k = lines.length - 1; k >= 0; k--) {
      let r = null; try { r = JSON.parse(lines[k]); } catch { continue; }
      if (!r || r.type !== 'assistant' || r.isSidechain || r.parent_tool_use_id) continue;
      const m = r.message && r.message.model;
      if (typeof m !== 'string' || !m || m.startsWith('<')) continue;
      for (let q = k - 1, n = 0; q >= 0 && n < 20; q--, n++) {
        let f = null; try { f = JSON.parse(lines[q]); } catch { continue; }
        if (f && f.subtype === 'model_refusal_fallback' && (f.fallbackModel || f.fallback_model) === m) return f.originalModel || f.original_model;
      }
      return m;
    }
    return null;
  };
  const realOrder = rerouteLines.map((l) => l.trim()).filter(Boolean);
  ok(r1Reader(realOrder) === 'claude-opus-4-8',
    'r2 ①a REPRODUCED: in the order the CLI really writes them, round 1’s reader answers the FALLBACK model — the silent downgrade its guard existed to prevent',
    JSON.stringify(r1Reader(realOrder)));
  const r1Order = [realOrder[0], realOrder[1], realOrder[4], realOrder[2], realOrder[3]];
  ok(r1Reader(r1Order) === 'claude-fable-5[1m]' && r1Reader(r1Order) !== r1Reader(realOrder),
    '…and NEGATIVE CONTROL: with round 1’s fixture order (system record BEFORE the assistant) the guard DOES fire — that ordering is what kept the suite green, and note it then commands `claude-fable-5[1m]`, a spelling round 1 never anticipated',
    JSON.stringify([r1Reader(r1Order), r1Reader(realOrder)]));
  // (b) THE VARIANT. `message.model` names the model that SERVED a turn and
  //     never its context-window variant, while the CLI's own reroute record
  //     does — so every id the reader could produce is a lossy rendering and
  //     `--model claude-fable-5` on a `claude-fable-5[1m]` conversation turns
  //     1M of context into 200k.
  const rerouteRecs = realOrder.map((l) => JSON.parse(l));
  ok(rerouteRecs.filter((r) => r.type === 'assistant').every((r) => !/\[/.test(r.message.model))
    && /\[1m\]$/.test(rerouteRecs.find((r) => r.subtype === 'model_refusal_fallback').originalModel),
    'r2 ①b: the served model is BARE while the CLI’s own record proves the conversation ran a [1m] variant — the field cannot express what a resume must command');
  // …and the same measurement against the REAL corpus when there is one (this
  // is what makes (b) a fact about the format rather than about a fixture).
  // Bounded and SKIPPED with a reason when the machine has no transcripts.
  {
    // the REAL home — `process.env.HOME` is the throwaway fixture home for the
    // rest of this block, and pointing the corpus measurement at it would have
    // measured the fixture I just wrote (counts only; no transcript content is
    // read into an assertion message)
    const projRoot = path.join(_homeBefore || os.homedir(), '.claude', 'projects');
    let files = [];
    try { for (const d of fs.readdirSync(projRoot)) { for (const f of fs.readdirSync(path.join(projRoot, d))) if (f.endsWith('.jsonl')) files.push(path.join(projRoot, d, f)); if (files.length > 60) break; } } catch { }
    files = files.slice(0, 60);
    if (!files.length) console.log('  ~ SKIP corpus measurement: no ~/.claude/projects transcripts on this machine');
    else {
      let served = 0, bracketed = 0, scanned = 0;
      for (const fp of files) {
        let txt = '';
        try {
          const fd = fs.openSync(fp, 'r'); const sz = fs.fstatSync(fd).size;
          const len = Math.min(256 * 1024, sz); const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, sz - len); fs.closeSync(fd); txt = buf.toString('utf-8');
        } catch { continue; }
        scanned++;
        for (const m of txt.matchAll(/"model":"([^"]*)"/g)) { served++; if (m[1].includes('[')) bracketed++; }
      }
      ok(served > 0 && bracketed === 0,
        `r2 ①b on the REAL corpus: ${served} \`"model":"…"\` values over ${scanned} transcripts, ${bracketed} of them carrying a […] context variant`,
        JSON.stringify({ served, bracketed, scanned }));
    }
  }
  // (c) THE BEHAVIOUR THAT FOLLOWS: claude declares NEITHER hook, so both knobs
  //     take the no-source rung on a resume and the CLI's own session record
  //     (variant-exact) decides.
  const hc = require(path.join(REPO, 'src/harnesses/claude.js'));
  ok(hc.store.lastTurnModel === undefined && hc.store.lastTurnEffort === undefined,
    'r2 ①c THE ASYMMETRY IS NOW UNIFORM: claude declares NEITHER reader — it records no effort at all, and the model it records cannot express the variant',
    JSON.stringify([typeof hc.store.lastTurnModel, typeof hc.store.lastTurnEffort]));
  ok(store.lastClaudeTurnModel === undefined,
    '…and the reader itself is gone from session-store (a source nobody may wire back by accident)');
  const claudeResume = (knob) => resumeSpawnPick({ instanceDefault: knob, resume: true, hasSource: typeof hc.store.lastTurnModel === 'function' });
  ok(claudeResume('opus[1m]').value === '' && claudeResume('opus[1m]').origin === 'harness'
    && resumeSpawnPick({ instanceDefault: 'high', resume: true, hasSource: typeof hc.store.lastTurnEffort === 'function' }).value === '',
    'a claude resume with no pick commands NEITHER model nor effort — never claude.defaultModel / claude.defaultEffort',
    JSON.stringify(claudeResume('opus[1m]')));
  ok(resumeSpawnPick({ instanceDefault: 'opus[1m]', resume: false }).value === 'opus[1m]'
    && resumeSpawnPick({ instanceDefault: 'high', resume: false }).value === 'high',
    'negative control: a NEW claude session still gets both instance defaults (this is a resume rule, not a deletion)');
  const { ClaudeCodeAdapter } = require(path.join(REPO, 'src/adapters/claude-code.js'));
  const cArgs = new ClaudeCodeAdapter({}).buildSessionArgs({ cwd: '/w', resumeId: FID, model: claudeResume('opus[1m]').value, mode: 'chat' });
  ok(!cArgs.args.includes('--model') && !cArgs.args.includes('--effort'),
    'and the claude adapter spawns the resume with NO model and NO effort flag', JSON.stringify(cArgs.args));
  const harmArgs = new ClaudeCodeAdapter({}).buildSessionArgs({ cwd: '/w', resumeId: FID, model: 'claude-fable-5', mode: 'chat' });
  ok(harmArgs.args.join(' ').includes('--model claude-fable-5'),
    'negative control: the served id WOULD have been commanded verbatim — which is the [1m] downgrade, in one argv');
    try { fs.rmSync(path.join(REPO, 'data', 'remote-jsonl', 'b6b6d-fixture'), { recursive: true, force: true }); } catch { }
}
process.env.HOME = _homeBefore; if (_codexHomeBefore === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = _codexHomeBefore;

console.log('— ⑪c WIRING: every resume/fork/restart entry point, and where the origin is stated');
{
  const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
  const sl = read('src/lib/session-lifecycle.js');
  // (1) the client half is the SAME pure rule, and it can no longer fill a default on a continuation
  ok(/import \{ resumeSpawnPick \} from '\.\.\/resume-continuity\.js';/.test(sl),
    'the client spawns by the same PURE ladder as the server (one law, two callers)');
  ok(/const continuesConversation = !!resumeId;/.test(sl)
    && /const modelPick = pickHere\(model, defaults\.model\);/.test(sl)
    && /const effortPick = pickHere\(effort, defaults\.effort\);/.test(sl)
    && /const sessionModel = modelPick\.value;/.test(sl) && /const sessionEffort = effortPick\.value;/.test(sl)
    && /resume: continuesConversation, hasSource: false/.test(sl),
    'createSession: BOTH twins go through it, and the client declares it cannot read the conversation (hasSource:false)');
  // r3: the client keeps the whole pick — its ORIGIN is the fact the wire
  // could not otherwise carry (leg ⑬ measures it end to end).
  ok(/spawnOriginHint: \{ model: modelPick\.origin, effort: effortPick\.origin \},/.test(sl),
    'r3: …and states WHICH FACT each resolved value is, for both twins');
  ok(!/const sessionEffort = effort !== undefined \? effort : defaults\.effort;/.test(sl)
    && !/const sessionModel = model !== undefined \? model : defaults\.model;/.test(sl),
    'the pre-fix expression is GONE from both twins (this is the line the owner\'s incident traced to)');
  // r2: a NEW session sends the resolved value VERBATIM so an explicit
  // "Auto (model default)" ('') survives the wire as a choice; a continuation
  // keeps `|| undefined`, where '' means the same thing as silence.
  ok(/const wireKnob = \(v\) => \(continuesConversation \? \(v \|\| undefined\) : v\);/.test(sl)
    && /model: wireKnob\(sessionModel\)/.test(sl) && /effort: wireKnob\(sessionEffort\)/.test(sl)
    && !/model: sessionModel\|\|undefined/.test(sl) && !/effort: sessionEffort\|\|undefined/.test(sl),
    'r2: BOTH twins reach the wire through the same continuation-aware helper (a stated empty must survive on a NEW create)');
  // (2) every entry point that continues a conversation funnels through it
  ok(/resumeSession\(sessionId, cwd, sessionName, \{ mode, model, effort/.test(sl)
    && /effort: effort !== undefined \? effort : savedCfg\.effort,/.test(sl)
    && /model: model !== undefined \? model : savedCfg\.model,/.test(sl),
    'resumeSession still forwards an EXPLICIT pick (caller > the card ⚙ override) — the "chosen" rung',
    'resumeSession');
  ok(/_doForkSession[\s\S]{0,2000}?resumeId,[\s\S]{0,400}?fork: true,/.test(sl),
    'a FORK carries resumeId → it is a continuation, so it inherits the parent conversation\'s values');
  ok(/restartConversationInPlace[\s\S]{0,1200}?this\.resumeSession\(cid,/.test(sl),
    'restartConversationInPlace goes through resumeSession (no second spawn path to keep in sync)');
  ok(/const retry = \(\) => this\.createSession\(\{\n\s*cwd, name: sessionName, resumeId, mode: sessionMode, model, permission, effort,/.test(sl),
    'the failed-resume retries re-send the caller\'s ORIGINAL explicitness (never the resolved sessionModel/sessionEffort)');
  const cv = read('src/lib/chat-view.js');
  ok(/this\.app\.resumeSession\(backendSessionId, cwd, name, \{\n\s*mode: 'chat',\n\s*backend,/.test(cv),
    'the chat RESUME BAR sends no model/effort at all — the path the owner hit');
  const lay = read('src/lib/layout.js');
  ok(/this\.app\.resumeSession\(d\.sessionId, d\.cwd, d\.name, d\.opts\)/.test(lay),
    'resume-all replays the window\'s own opts and invents nothing');
  // (3) the server states WHICH FACT it used, everywhere a client can read it
  const wc = read('src/ws-create.js');
  ok(wc.indexOf('resumeSpawnPick({') < wc.indexOf('adapter.buildSessionArgs({'),
    'the ladder runs BEFORE the spawn spec, so every downstream reader (pool chooser, _spawnModel, the lock target) sees the value the session really starts with');
  ok(/data\._modelOrigin = picks\.model\.origin;/.test(wc) && /data\._effortOrigin = picks\.effort\.origin;/.test(wc)
    && /continuityLogLine\(backend, data\.resumeId, picks\)/.test(wc),
    'it records the ORIGIN and logs the decision (a resume that quietly took the default must be readable afterwards)');
  ok(!/lastCodexTurnEffort\(data\.resumeId\)/.test(wc) && !/lastCodexTurnModel\(data\.resumeId\)/.test(wc),
    'the codex-only env post-fill is GONE — one ladder, per-harness readers, no backend branch');
  // r2: only the LADDER may decide what '' means. Normalising `explicit` here
  // is how the dialog's explicit Auto became codex.defaultEffort.
  ok(/resumeSpawnPick\(\{\n\s*explicit, conversation, instanceDefault: instDefault\(key\),/.test(wc)
    && !/const e = \(explicit === undefined \|\| explicit === null\) \? '' : String\(explicit\)\.trim\(\);/.test(wc),
    'r2: ws-create forwards `explicit` UNTOUCHED into the ladder (the pre-fix normalisation is gone)');
  // r2: the claude source is deleted, not repaired — both the descriptor hook
  // and the reader it called must be absent, and the reason must be readable.
  const chz = read('src/harnesses/claude.js'), ssz = read('src/session-store.js');
  // the DEFINITION and the EXPORT, not the prose: the tombstone comment names
  // the deleted reader on purpose, so a bare name match would be a red herring.
  ok(!/lastTurnModel:/.test(chz) && !/lastTurnEffort:/.test(chz)
    && !/function lastClaudeTurnModel/.test(ssz) && !/^\s*lastClaudeTurnModel,\s*$/m.test(ssz)
    && !/function _unfallback/.test(ssz),
    'r2: no claude reader anywhere — no descriptor hook, no session-store definition, no export, and the dead fallback guard is gone with it');
  ok(/WHY THERE IS NO CLAUDE MODEL READER HERE/.test(ssz) && /\[1m\]/.test(ssz) && /2650 transcripts/.test(ssz),
    '…and session-store carries the measured reason where the reader used to be (the next person who wants one reads it first)');
  ok(/RESUME CONTINUITY \(B-6b6d/.test(chz) && /context-window variant/.test(chz),
    '…restated on the descriptor, which is the place a future hook would be added');
  const ocz = read('src/harnesses/opencode.js'), acz = read('src/harnesses/acp.js');
  ok(/lastTurnModel: \(id\) => serve\.facts\(\)\.sessionModel\(id\)/.test(ocz),
    'r2: opencode DOES declare the model reader (its own session record names it)');
  ok(/deliberately NO `lastTurnModel`/.test(acz),
    '…and the GENERIC ACP harness says in place why it declares none (⑫: a silent behaviour change per harness must be written down where that harness lives)');
  ok(/spawnOrigin: \{ model: session\._modelOrigin \|\| null, effort: session\._effortOrigin \|\| null \}/.test(wc),
    "the 'created' reply carries it (the creator never gets an 'attached' — 2.368.4)");
  ok(/effort: session\._effort \|\| null,\n\s*spawnModel: session\._spawnModel \|\| null,/.test(wc),
    "…along with the effort the spawn resolved to, since on a resume the CLIENT deliberately sent none");
  ok(/modelOrigin: session\._modelOrigin \|\| null,/.test(wc) && /effortOrigin: session\._effortOrigin \|\| null,/.test(wc),
    'and session-meta persists it, so a server restart does not turn an honest row into a guess');
  const wsh = read('src/ws-handler.js');
  ok(/spawnOrigin: \{ model: session\._modelOrigin \|\| null, effort: session\._effortOrigin \|\| null \}/.test(wsh),
    'the ATTACH payload carries it too (a second client opening the window learns the same fact)');
  ok(/session\._effortOrigin = 'chosen';/.test(wsh) && /if \(data\.model\) s2\._modelOrigin = 'chosen';/.test(wsh),
    'a pick made INSIDE the session RE-AUTHORS the origin — the panel must not keep calling a hand-changed value "the conversation\'s own"');
  ok(/effortOrigin: session\._effortOrigin/.test(wsh) && /modelOrigin: s2\._modelOrigin \|\| null/.test(wsh),
    '…and that re-authoring is persisted with the value it describes');
  const sbar = read('src/lib/chat-status-bar.js');
  ok(/this\._spawnOrigin = \{ \.\.\.\(this\._spawnOrigin \|\| \{\}\), effort: 'chosen' \};/.test(sbar),
    '…on the CLIENT too, next to the optimistic chip value (one pick, one pair of writes)');
  const boot = read('src/server/boot-restore.js');
  ok((boot.match(/_modelOrigin: meta\.modelOrigin \|\| null/g) || []).length >= 3,
    'every boot-restore path restores it (all three, like _effort)');
  const srv = read('server.js');
  ok(/modelOrigin: s\._modelOrigin \|\| null, effortOrigin: s\._effortOrigin \|\| null,/.test(srv),
    'the active-sessions payload carries value + origin for Session Properties');
  const sb = read('src/lib/sidebar.js');
  ok((sb.match(/modelOrigin: (wm\?\.|ws\.)modelOrigin \|\| null/g) || []).length === 2,
    'BOTH merge branches carry it onto the session record (the 2.369.58 outputStyle row reached neither — fixed here with them)');
  ok((sb.match(/outputStyle: (wm\?\.|ws\.)outputStyle \|\| null/g) || []).length === 2,
    '…including that outputStyle twin, whose "live" value the panel had been reading as always-empty');
  const sp = read('src/lib/session-props.js');
  ok(/originRow\(t\('Model'\), s\.spawnModel \|\| '', cfg\.model, s\.modelOrigin\)/.test(sp)
    && /originRow\(t\('Effort'\), s\.effort \|\| '', cfg\.effort, s\.effortOrigin,/.test(sp),
    'Session Properties shows value + origin for both twins');
  ok((sp.match(/const ORIGIN_LABEL = \{/g) || []).length === 1,
    'ONE label map for all three origin rows (a second copy is how one fact starts being worded two ways in one panel)');
  ok(/const originBit = ORIGIN_LABEL\[originKey\]/.test(sp) && !/ORIGIN_LABEL\[spawnValueOrigin\(stated, live, picked\)\]\(\)/.test(sp),
    "r2: the row only prints a parenthetical for an origin the label map HAS — 'unknown' shows the value alone rather than a fact we do not hold");
  ok(/wrap: true/.test(sp) && /white-space:normal;overflow-wrap:anywhere/.test(sp),
    'an origin row WRAPS instead of ellipsizing (375×667: the origin is the last thing on the line — measured, see scripts/dbg-session-props-mobile.mjs)');
  // (4) the decision is DOCUMENTED where the next reader looks, under its id
  const kb = read('docs/kb-bugfix-invariants.md');
  ok(/B-6b6d/.test(kb) && /is a NEW-session default/i.test(kb) && /conversation's OWN value wins on resume\/fork\/restart/i.test(kb),
    'the kb states the RULE under the backlog id that carries the owner decision');
  ok(/chat resume bar|resume-all/.test(kb) && /session-lifecycle\.js/.test(kb),
    '…with the precise scope it came from (which resume paths, which line)');
  ok(/hasSource/.test(kb) && /nothing claude writes records the effort/i.test(kb),
    '…and the ASYMMETRY, which reads like an omission unless it is written down');
  ok(/NEW sessions only \(B-6b6d\)|NEW Codex sessions/.test(read('docs/settings.md'))
    && /Applies to NEW sessions/.test(read('src/lib/settings-schema.js')),
    'the SETTING itself no longer claims "new or resumed" — the description a user reads is part of the fix');
}

console.log('— ⑪d the ORIGIN a panel shows (PURE, agent-meta)');
{
  const { spawnValueOrigin, responseStyleOrigin } = await import(path.join(REPO, 'src/lib/agent-meta.js'));
  ok(spawnValueOrigin('conversation', 'ultra', undefined) === 'conversation', "the server's word is shown as-is when nothing contradicts it");
  ok(spawnValueOrigin('instance', 'xhigh', undefined) === 'instance', 'instance default, stated');
  ok(spawnValueOrigin('chosen', 'xhigh', 'xhigh') === 'chosen', 'a pick that MATCHES the live value is the choice');
  ok(spawnValueOrigin('conversation', 'ultra', 'xhigh') === 'spawn',
    'a pick saved AFTER the spawn makes the live value "what this session started with" — so the row can never contradict the "(saved: …)" note beside it');
  ok(spawnValueOrigin('chosen', 'ultra', 'xhigh') === 'spawn', '…whatever the server said at the time');
  // r2 (adversarial verifier, low): with no STATED origin the helper may only
  // claim what the PICK proves. responseStyleOrigin answers 'instance' for any
  // live value with no saved pick, so every session restored from an older
  // session-meta asserted "(instance default)" as fact — including ones whose
  // model came from the New Session dialog.
  ok(spawnValueOrigin(null, 'ultra', undefined) === 'unknown'
    && spawnValueOrigin(undefined, 'claude-fable-5', undefined) === 'unknown',
    'r2 THE FIX: a session that predates the field and offers nothing to compare says NOTHING (not "instance default")',
    JSON.stringify(spawnValueOrigin(null, 'ultra', undefined)));
  ok(responseStyleOrigin('ultra', undefined) === 'instance',
    'negative control: the response-style ladder still answers "instance" there — this change is scoped to the two spawn knobs');
  ok(spawnValueOrigin(null, '', 'high') === 'saved' && spawnValueOrigin(null, 'ultra', 'ultra') === 'chosen'
    && spawnValueOrigin(null, 'ultra', 'xhigh') === 'spawn',
    '…while the three answers the PICK really proves survive with no stated origin (saved / chosen / spawn)');
  ok(spawnValueOrigin('instance', 'ultra', undefined) === 'instance' && spawnValueOrigin('conversation', 'ultra', undefined) === 'conversation',
    'negative control: a STATED origin is still shown — the row goes quiet only when nobody stated one');
  ok(spawnValueOrigin('nonsense', 'ultra', undefined) === 'unknown',
    'an unknown origin string is not trusted either (and now says so instead of borrowing a guess)');
  // r2, surfaced by the claude change: with no source the spawn commands
  // NOTHING, so `stated` is 'harness' and the live value is empty — a pick
  // saved afterwards is what the row is actually showing.
  ok(spawnValueOrigin('harness', '', 'opus[1m]') === 'saved' && spawnValueOrigin('chosen', '', 'opus[1m]') === 'saved',
    'r2: when nothing was COMMANDED but a pick is saved, the row says "saved — applies on the next resume" rather than describing the spawn',
    JSON.stringify(spawnValueOrigin('harness', '', 'opus[1m]')));
  ok(spawnValueOrigin('harness', 'ultra', undefined) === 'harness' && spawnValueOrigin('harness', '', undefined) === 'harness',
    'negative control: a stated harness origin WITH a live value (or with nothing saved) is still reported as stated');
}

console.log('— ⑪e r2: OPENCODE CAN ANSWER, SO IT DOES (and a harness that cannot says so in place)');
{
  const { createFacts } = require(path.join(REPO, 'src/opencode-serve.js'));
  const SESSIONS = [
    { id: 'oc-1', directory: '/w', model: { providerID: 'anthropic', id: 'claude-opus-5' }, time: { updated: 2 } },
    { id: 'oc-2', directory: '/w', model: { providerID: 'opencode', id: 'big-pickle' }, time: { updated: 1 } },
  ];
  let listCalls = 0;
  const upClient = { skippedWorktrees: [], listAllSessions: async () => { listCalls++; return SESSIONS; }, firstUserMessage: async () => null };
  const upLocator = { client: async () => upClient, state: () => ({ installed: true, ready: true, parked: false, autostart: true }), invalidate: () => { } };
  const up = createFacts(upLocator);
  ok(await up.sessionModel('oc-1') === 'anthropic/claude-opus-5' && await up.sessionModel('oc-2') === 'opencode/big-pickle',
    'r2 ③: the opencode store answers "what model is this conversation on" from OpenCode\u2019s OWN session record',
    JSON.stringify([await up.sessionModel('oc-1'), await up.sessionModel('oc-2')]));
  const callsBefore = listCalls;
  await up.discover({ activeSessions: new Map() });
  ok(listCalls === callsBefore,
    '…through the SAME cached v1 listing the sidebar poll already uses — a resume adds no route (the 2.369.50 rule: v2 per-session routes boot an instance per directory)',
    JSON.stringify({ callsBefore, listCalls }));
  ok(await up.sessionModel('oc-gone') === '' && await up.sessionModel('') === '',
    'an unknown / empty id is \'\' rather than a throw on the spawn path');
  const offLocator = { client: async () => null, state: () => ({ installed: true, ready: false, parked: false, autostart: false }), invalidate: () => { } };
  const off = createFacts(offLocator);
  ok(await off.sessionModel('oc-1') === '',
    'the background service is OPT-IN and default OFF, so an unreachable serve answers \'\' — never a throw',
    JSON.stringify(await off.sessionModel('oc-1')));
  const hoc = require(path.join(REPO, 'src/harnesses/opencode.js'));
  ok(typeof hoc.store.lastTurnModel === 'function' && await hoc.store.lastTurnModel('oc-1') === '' ,
    'the DESCRIPTOR exposes it under the shared hook name, and with the singleton unwired it degrades to \'\' (NULL_FACTS), never a spawn-path throw');
  ok(hoc.store.lastTurnEffort === undefined,
    'opencode declares no effort reader (its caps row has no effort knob at all)');
  // the ladder, both ways round
  ok(resumeSpawnPick({ conversation: 'anthropic/claude-opus-5', instanceDefault: 'opencode/big-pickle', resume: true, hasSource: true }).value === 'anthropic/claude-opus-5',
    'r2 ③ THE FIX: an OpenCode resume keeps the conversation\u2019s own model, not opencode.defaultModel');
  ok(resumeSpawnPick({ conversation: '', instanceDefault: 'opencode/big-pickle', resume: true, hasSource: true }).origin === 'instance'
    && resumeSpawnPick({ instanceDefault: 'opencode/big-pickle', resume: true, hasSource: false }).origin === 'harness',
    '…and with the service off the instance default applies WITH an origin the log names — the state master had, now said out loud (hasSource:false would have sent nothing and said nothing)');
  const { acpHarness } = require(path.join(REPO, 'src/harnesses/acp.js'));
  const generic = acpHarness({ id: 'demo-agent', command: 'demo-agent', caps: { ...require(path.join(REPO, 'src/harnesses/acp.js')).ACP_DEFAULT_CAPS } });
  ok(generic.store.lastTurnModel === undefined && generic.store.lastTurnEffort === undefined,
    'negative control: a GENERIC ACP harness still declares neither — the hook is per-harness evidence, never a default');
}

// ───────────────────────────────────────────────────────────────────────────
// ⑫ r3 (adversarial verifier, medium): A NEW SESSION COULD ONLY EVER RECORD
// 'chosen'. The client resolves `<prefix>.default*` for a NEW create (it needs
// the value for its own chip, and it owns the legacy `session.defaultEffort`
// key + `settings.isModified`, which the server has no access to) and sends it
// VERBATIM so a stated "Auto (model default)" survives as ''. The server then
// sees a bare string it can only read as a pick ⇒ every create path that shows
// NO picker (openShellTerminal, the toolbar, setup-flows, manage-agents)
// labelled the instance default "your choice for this session", 'instance' was
// unreachable on a new session, and so was 'harness'.
console.log('— ⑫ r3: the wire can now carry "the client resolved this, the user did not state it"');
const { applyOriginHint } = require(path.join(REPO, 'src/resume-continuity.js'));
{
  // (a) the PURE rule: it may only DOWNGRADE our own 'chosen'.
  ok(applyOriginHint('chosen', 'instance') === 'instance' && applyOriginHint('chosen', 'harness') === 'harness',
    'a hint that says "the user did not state this" is believed');
  ok(applyOriginHint('conversation', 'instance') === 'conversation'
    && applyOriginHint('instance', 'harness') === 'instance'
    && applyOriginHint('harness', 'instance') === 'harness',
    'negative control: every OTHER rung was decided by the server from facts the client never had — a hint may not touch it');
  ok(applyOriginHint('chosen', 'conversation') === 'chosen' && applyOriginHint('chosen', 'chosen') === 'chosen',
    "negative control: 'conversation' is a fact only the server holds and 'chosen' agrees — neither is believed as a hint");
  ok(applyOriginHint('chosen', undefined) === 'chosen' && applyOriginHint('chosen', null) === 'chosen'
    && applyOriginHint('chosen', 'wat') === 'chosen' && applyOriginHint('chosen', 42) === 'chosen',
    'negative control: an OLDER client sends no hint (and garbage is not a hint) — master\'s answer stands');

  // (b) the real composition, client → JSON wire → server ladder → origin.
  //     Both halves are the product's own lines; ⑫c pins each against source.
  const clientCreate = (explicit, dflt, resumeId) => {
    const cont = !!resumeId;
    const p = resumeSpawnPick({ explicit, instanceDefault: dflt, resume: cont, hasSource: false });
    const wireKnob = (v) => (cont ? (v || undefined) : v);
    return JSON.parse(JSON.stringify({                      // ← the actual JSON round trip
      resumeId: resumeId || undefined, model: wireKnob(p.value), spawnOriginHint: { model: p.origin },
    }));
  };
  const serverPick = (msg, conversation, dflt, hasSource) => {
    const explicit = msg.model;
    const stated = explicit !== undefined && explicit !== null && String(explicit).trim() !== '';
    const p = resumeSpawnPick({ explicit, conversation: stated ? '' : conversation, instanceDefault: dflt, resume: !!msg.resumeId, hasSource });
    return { value: p.value, origin: applyOriginHint(p.origin, (msg.spawnOriginHint || {}).model) };
  };
  const run = (explicit, dflt, resumeId, conversation = '') => serverPick(clientCreate(explicit, dflt, resumeId), conversation, dflt, true);
  ok(run(undefined, 'gpt-5.6-sol', null).origin === 'instance' && run(undefined, 'gpt-5.6-sol', null).value === 'gpt-5.6-sol',
    'r3 THE FIX: a create from a path with NO picker records the INSTANCE DEFAULT — and the value is unchanged',
    JSON.stringify(run(undefined, 'gpt-5.6-sol', null)));
  ok(run(null, 'gpt-5.6-sol', null).origin === 'instance',
    '…including the callers that pass an explicit null (openShellTerminal)', JSON.stringify(run(null, 'gpt-5.6-sol', null)));
  ok(run(undefined, '', null).origin === 'harness' && run(undefined, '', null).value === '',
    '…and with no instance default either it is the HARNESS rung, not a phantom choice of ""',
    JSON.stringify(run(undefined, '', null)));
  ok(run('gpt-5.6-sol', 'gpt-5.6-sol', null).origin === 'chosen',
    'negative control: SUBMITTING the pre-filled default in the New Session dialog is still a choice (same string, different act)');
  ok(run('gpt-6-astra', 'gpt-5.6-sol', null).origin === 'chosen', 'negative control: picking something else is a choice');
  ok(run('', 'gpt-5.6-sol', null).origin === 'chosen' && run('', 'gpt-5.6-sol', null).value === '',
    'negative control: the dialog\'s explicit "Auto (model default)" stays a CHOICE (r2\'s fix is untouched)');
  ok(run(undefined, 'gpt-5.6-sol', 'th-x', 'gpt-6-astra').origin === 'conversation'
    && run(undefined, 'gpt-5.6-sol', 'th-x', 'gpt-6-astra').value === 'gpt-6-astra',
    'negative control: a RESUME still takes the conversation\'s own value — the client sends nothing there, so no hint can apply',
    JSON.stringify(run(undefined, 'gpt-5.6-sol', 'th-x', 'gpt-6-astra')));
  ok(serverPick({ resumeId: 't', spawnOriginHint: { model: 'instance' } }, 'gpt-6-astra', 'gpt-5.6-sol', true).origin === 'conversation',
    'negative control: a hint cannot re-point a fact only the server holds, even when a client insists');
  // (c) the DEFECT, replayed through the same composition with the hint removed
  const preFix = (explicit, dflt) => {
    const msg = clientCreate(explicit, dflt, null); delete msg.spawnOriginHint;
    return serverPick(msg, '', dflt, true).origin;
  };
  ok(preFix(undefined, 'gpt-5.6-sol') === 'chosen' && preFix(null, 'gpt-5.6-sol') === 'chosen' && preFix(undefined, '') === 'chosen',
    'r3 REPRODUCED (negative control): without the hint EVERY new create reads as a pick — "instance" and "harness" are unreachable',
    JSON.stringify([preFix(undefined, 'gpt-5.6-sol'), preFix(undefined, '')]));
  // …and what the panel then said, through the REAL label rule
  const { spawnValueOrigin } = await import(path.join(REPO, 'src/lib/agent-meta.js'));
  ok(spawnValueOrigin('chosen', 'gpt-5.6-sol', undefined) === 'chosen'
    && spawnValueOrigin('instance', 'gpt-5.6-sol', undefined) === 'instance',
    '…and the panel repeats whichever it is told (which is why the wire had to be able to say it)');
}

console.log('— ⑫c r3 WIRING: both halves, and the placement hint that is never a command');
{
  const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
  const sl = read('src/lib/session-lifecycle.js'), wc = read('src/ws-create.js');
  ok(/const pickHere = \(explicit, instanceDefault\) =>\n\s*resumeSpawnPick\(\{ explicit, instanceDefault, resume: continuesConversation, hasSource: false \}\);/.test(sl),
    'the client keeps the WHOLE pick (its origin is the fact the wire could not carry)');
  ok(/spawnOriginHint: \{ model: modelPick\.origin, effort: effortPick\.origin \},/.test(sl),
    '…and sends it for BOTH twins');
  ok(/const hint = data\.spawnOriginHint \|\| \{\};/.test(wc)
    && /picks\.model\.origin = applyOriginHint\(picks\.model\.origin, hint\.model\);/.test(wc)
    && /picks\.effort\.origin = applyOriginHint\(picks\.effort\.origin, hint\.effort\);/.test(wc),
    'ws-create reconciles it through the PURE rule, for both twins');
  // ORDER, stated so it cannot pass vacuously: `indexOf` answers -1 for text
  // that is not there, and -1 is less than everything — an ordering pin that
  // does not first assert BOTH sites exist goes green when the fix is deleted
  // (measured: this exact assert survived the mutation run).
  const iHint = wc.indexOf('applyOriginHint(picks.model.origin'), iRec = wc.indexOf('data._modelOrigin = picks.model.origin;');
  ok(iHint > 0 && iRec > 0 && iHint < iRec,
    '…BEFORE the origin is handed to the session (else the recorded value is the un-reconciled one)',
    JSON.stringify({ iHint, iRec }));
  ok(/const \{ resumeSpawnPick, applyOriginHint, continuityLogLine \} = require\('\.\/resume-continuity'\);/.test(wc),
    'and it comes from the ONE pure module (no second copy of the rule)');
  // r3 ③: the placement hint is a FAMILY guess for the pool chooser, never a command
  ok(/data\._placementModelHint = data\.model \|\| instDefault\('defaultModel'\) \|\| null;/.test(wc),
    'r3 ③: the pooled-spawn chooser gets a placement hint when the ladder commands nothing');
  ok(/chooseMember: \(\) => poolChooser\?\.\([^)]*\{ model: data\.model \|\| data\._placementModelHint \|\| null \}\)/.test(wc),
    '…at the chooser call site, and nowhere else');
  ok(!/model: data\._placementModelHint/.test(wc.replace(/chooseMember[\s\S]{0,200}?\n/, ''))
    && !/CODEX_WEBUI_MODEL = data\._placementModelHint/.test(wc)
    && !/data\.model = data\._placementModelHint/.test(wc),
    'r3 ③ negative control: it never reaches data.model, the spawn spec or the env — placement is not commanding');
  ok(/session\._spawnModel = data\.model \|\| null;/.test(wc),
    'r3 ③: `_spawnModel` records what the spawn COMMANDED and stays null here — the hint must never leak into session-meta / the attach payload / sessionModelFor\'s floor');
  // …and "placement only" is a COUNTABLE claim, not a promise: exactly two
  // non-comment sites exist — where it is set, and the one chooser that reads it.
  const hintSites = wc.split('\n').filter((l) => l.includes('_placementModelHint') && !l.trim().startsWith('//'));
  ok(hintSites.length === 2,
    'r3 ③: exactly TWO non-comment sites — the assignment beside the ladder, and the chooser',
    JSON.stringify(hintSites.map((l) => l.trim().slice(0, 60))));
}

// ───────────────────────────────────────────────────────────────────────────
// ⑬ r3 (adversarial verifier, low): A CLAUDE RESUME LOST ITS POOL PLACEMENT.
// r2 deleted the claude model source, so `data.model` is undefined on a claude
// resume — and the pooled-spawn chooser short-circuits on `familyOfModel(null)`
// BEFORE decidePoolSwitch, placing the session on the pool's current target
// with no evaluation at all (the 2.305.0 class: 5h/7d fine, the model-scoped
// weekly cap spent). Master got a family because the client filled
// `claude.defaultModel` into every resume. REAL engine, REAL AccountManager
// pool, REAL caches — the short-circuit is not something a stub can show.
console.log('— ⑬ r3: a claude resume commands no model, and still gets a pool placement');
{
  const { AccountManager } = require(path.join(REPO, 'src/accounts.js'));
  const { familyOfModel } = require(path.join(REPO, 'src/model-family.js'));
  const engMod = require(path.join(REPO, 'src/server/usage-pool-engine.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-b6b6d-pool-'));
  const dataDir = path.join(root, 'data');
  const am = new AccountManager({ dataDir });
  if (!am.poolSupported()) console.log('  ~ SKIP: pooled accounts are unsupported on this platform (symlink hot-swap)');
  else {
    const login = (id) => fs.writeFileSync(path.join(am.subDir(id), '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5, subscriptionType: 'max' } }), { mode: 0o600 });
    const CUR = am.createSubscription({ name: 'Spent-on-Opus' }).id; login(CUR);
    const SPARE = am.createSubscription({ name: 'Healthy' }).id; login(SPARE);
    const P = am.createPool({ name: 'pool' }).id;
    am.setPoolTarget(P, CUR); am.updatePool(P, { auto: true, hot: true });
    const cacheDir = path.join(dataDir, 'usage-cache'); fs.mkdirSync(cacheDir, { recursive: true });
    const nowS = Math.floor(Date.now() / 1000), R5 = nowS + 7200, R7 = nowS + 3 * 86400;
    // the 2.305.0 shape: the current target's 5h/7d are fine, its OPUS weekly cap is spent
    fs.writeFileSync(path.join(cacheDir, CUR + '.json'), JSON.stringify({ fetchedAt: Date.now() - 6e4, source: 'cli-usage',
      fiveHour: { utilization: 0.1, resetsAt: R5 }, sevenDay: { utilization: 0.2, resetsAt: R7 }, scopedWeekly: [{ name: 'Opus', utilization: 0.999, resetsAt: R7 }] }));
    fs.writeFileSync(path.join(cacheDir, SPARE + '.json'), JSON.stringify({ fetchedAt: Date.now() - 6e4, source: 'cli-usage',
      fiveHour: { utilization: 0.1, resetsAt: R5 }, sevenDay: { utilization: 0.15, resetsAt: R7 }, scopedWeekly: [{ name: 'Opus', utilization: 0.1, resetsAt: R7 }] }));
    const eng = engMod.create({ app: { get() { }, post() { }, put() { }, delete() { }, use() { }, locals: {} },
      rootDir: root, USAGE_CACHE_DIR: cacheDir, activeSessions: new Map(), wss: { clients: new Set() }, WS_OPEN: 1,
      broadcastToSession() { }, serverNotice() { }, serverSetting: () => undefined, getAccounts: () => am, getHosts: () => null,
      getUsageHistory: () => null, recordUsageAttribution() { }, adapterRegistry: { get() { return null; } },
      getAutoResume: () => null, getOtelIngest: () => null, getQuotaProbe: () => null });
    const hclaude = require(path.join(REPO, 'src/harnesses/claude.js'));
    const SETTING = 'claude-opus-5';
    // ws-create's ladder for a CLAUDE resume with no pick, then its chooser arg
    const pick = resumeSpawnPick({ explicit: undefined, conversation: '', instanceDefault: SETTING,
      resume: true, hasSource: typeof hclaude.store.lastTurnModel === 'function' });
    const data = { model: pick.value || undefined };
    data._placementModelHint = data.model || SETTING || null;
    const place = (d) => eng.poolChooserForModel(P, { model: d.model || d._placementModelHint || null });

    ok(pick.value === '' && pick.origin === 'harness' && data.model === undefined,
      'the ladder still commands NOTHING for a claude resume (r2\'s rule is untouched)', JSON.stringify(pick));
    ok(familyOfModel(null) === null && familyOfModel(SETTING) === 'opus',
      'the chooser projects by model FAMILY, and null means "no projection" — which is where it short-circuits');
    ok(place(data) === SPARE,
      'r3 ③ THE FIX: the spawn is placed on the member whose Opus weekly cap is NOT spent',
      JSON.stringify({ placed: place(data), spare: SPARE, cur: CUR }));
    // NEGATIVE CONTROL ①: the defect, in one line — the pre-fix chooser arg
    ok(eng.poolChooserForModel(P, { model: data.model || null }) === CUR && am.poolCurrent(P) === CUR,
      'r3 ③ REPRODUCED (negative control): without the hint it lands on the pool\'s current target, unevaluated',
      JSON.stringify({ placed: eng.poolChooserForModel(P, { model: data.model || null }), cur: CUR }));
    // NEGATIVE CONTROL ②: master's input produced the SAME answer the fix does
    ok(eng.poolChooserForModel(P, { model: SETTING }) === SPARE,
      'negative control: this is exactly the placement master got (the client used to fill claude.defaultModel)');
    // NEGATIVE CONTROL ③: with the setting unset there is no hint and nothing changes
    const bare = { model: undefined, _placementModelHint: (undefined || '' || null) };
    ok(place(bare) === CUR,
      'negative control: `claude.defaultModel` unset ⇒ no hint ⇒ master\'s behaviour when it was unset (the default target)');
    // NEGATIVE CONTROL ④: an explicit per-session pick still wins over the hint
    const picked = { model: 'claude-fable-5', _placementModelHint: SETTING };
    ok(place(picked) === eng.poolChooserForModel(P, { model: 'claude-fable-5' }),
      'negative control: an explicit pick is what the chooser sees — the hint only fills a void');
    // …and the hint NEVER becomes a command: the real adapter, the real argv
    const { ClaudeCodeAdapter } = require(path.join(REPO, 'src/adapters/claude-code.js'));
    const spec = new ClaudeCodeAdapter({}).buildSessionArgs({ cwd: '/w', resumeId: 'abcdabcd', model: data.model, mode: 'chat' });
    ok(!spec.args.includes('--model') && !spec.args.join(' ').includes(SETTING),
      'r3 ③: the resume spawns with NO --model — the placement hint reached the chooser and nothing else', JSON.stringify(spec.args));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { }
  }
}

console.log(fail ? `\nFAILED (${fail} of ${pass + fail})` : `\nALL PASS (${pass})`);
if (werr && fail) console.error('wrapper stderr:\n' + werr.slice(-2000));
process.exit(fail ? 1 : 0);
