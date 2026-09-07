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

console.log(fail ? `\nFAILED (${fail} of ${pass + fail})` : `\nALL PASS (${pass})`);
if (werr && fail) console.error('wrapper stderr:\n' + werr.slice(-2000));
process.exit(fail ? 1 : 0);
