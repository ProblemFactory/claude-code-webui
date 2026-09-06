#!/usr/bin/env node
// Codex sub-agent VISIBILITY — renderer + click-through + roster route (B-7473).
//
// Owner report (2026-09-06, a real 0.153.4 root window, 12 sub-agents): a
// sub-agent's report ("已完成，仅修改约定两文件：…") appeared as an ORDINARY
// assistant message, some of them twice, and "根本没区分出这是subagent消息".
// The normalizer half is pinned in test-codex-0153 ⑥ / test-codex-p2-wrapper ④;
// this suite covers what the USER sees and clicks:
//   ① the PURE row builder — labels, coalescing, the encrypted note, and the
//      XSS rule made VERIFIABLE (a marker escaper proves every model-controlled
//      string leaves through esc; a faithful escaper proves nothing survives)
//   ② the renderer + chat-view wiring (report card, click delegation, the fold
//      summary's "N sub-agent messages" / "N sub-agents" chips, CSS)
//   ③ GET /api/subagents against a REAL express mount over a temp CODEX_HOME
//      holding real-shaped parent + child rollout heads
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };

const CR = require(path.join(REPO, 'src/collab-row.js'));
// byte-identical to src/lib/utils.js escHtml (the escaper the renderer injects)
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

console.log('— ① the PURE row builder (labels, coalescing, escaping)');
{
  const IN = { dir: 'in', agentPath: '/root/water_research', agentName: 'water_research', msgType: 'FINAL_ANSWER', encrypted: false, threadId: '01a07340-6597-74f2-882c-f7092fecd5a0' };
  const OUT = { dir: 'out', agentPath: '/root/interior_research', agentName: 'interior_research', target: '/root/interior_research', msgType: 'message', encrypted: true };
  const SPAWN = { dir: 'spawn', agentPath: '/root/water_research', agentName: 'water_research', encrypted: true, detail: 'research the water system' };
  const WAIT = { dir: 'wait', cellId: '3', yieldMs: 1000 };
  const ACT = { dir: 'activity', agentPath: '/root/water_research', agentName: 'water_research', kind: 'started', threadId: 'th-child' };
  ok(CR.collabRowLabel(IN) === 'water_research · FINAL_ANSWER', 'inbound label names the agent and the message type', CR.collabRowLabel(IN));
  ok(CR.collabRowLabel(OUT) === 'interior_research · message', 'outbound label', CR.collabRowLabel(OUT));
  ok(CR.collabRowLabel(SPAWN) === 'spawn water_research' && CR.collabRowLabel(WAIT) === 'waiting for sub-agent replies · cell 3 · ≤1s' && CR.collabRowLabel(ACT) === 'water_research started', 'spawn / wait / lifecycle labels', [CR.collabRowLabel(SPAWN), CR.collabRowLabel(WAIT), CR.collabRowLabel(ACT)].join(' | '));
  ok(CR.agentName('/root/water_research') === 'water_research' && CR.agentName('') === '' && CR.agentName('th-1') === 'th-1', 'agentName is the last path segment, thread ids pass through');
  const many = { rows: [IN, { ...IN, agentPath: '/root/energy_research', agentName: 'energy_research', msgType: 'MESSAGE' }, { ...IN, agentPath: '/root/interior_research', agentName: 'interior_research', msgType: 'MESSAGE' }] };
  ok(CR.collabSummaryText(many) === '3 messages · water_research (FINAL_ANSWER), energy_research (MESSAGE), interior_research (MESSAGE)', 'coalesced summary counts and names (the {n} param is substituted even without a client t())', CR.collabSummaryText(many));
  ok(/^4 sub-agent events · /.test(CR.collabSummaryText({ rows: [IN, OUT, SPAWN, ACT] })), 'a MIXED coalesced set reads as sub-agent events', CR.collabSummaryText({ rows: [IN, OUT, SPAWN, ACT] }));
  ok(CR.collabReportHeadText({ rows: [IN] }) === 'water_research · FINAL_ANSWER', 'the report attribution header is "<agent> · <TYPE>"', CR.collabReportHeadText({ rows: [IN] }));
  const title = CR.collabRowTitle(OUT);
  ok(/Sender: \/root\/interior_research/.test(title) && /Message type: message/.test(title) && /payload encrypted upstream/.test(title), 'the hover title carries the envelope + the honest encryption note', title);
  ok(!/payload encrypted upstream/.test(CR.collabRowTitle(IN)), '…and says nothing about encryption for a plaintext row');

  // XSS: EVERY model-controlled field must leave through the injected escaper.
  const HOSTILE = {
    dir: 'in',
    agentPath: '/root/<img src=x onerror=alert(1)>',
    agentName: '<img src=x onerror=alert(1)>',
    nickname: '"><script>alert(2)</script>',
    msgType: '<svg/onload=alert(3)>',
    target: "'-alert(4)-'",
    detail: '<b>detail</b>',
    threadId: '"><script>alert(5)</script>',
    encrypted: true,
  };
  const marks = [];
  const markerEsc = (s) => { marks.push(String(s ?? '')); return '\u0001' + String(s ?? '') + '\u0002'; };
  const marked = CR.collabRowHtml(HOSTILE, { esc: markerEsc, icons: {} });
  const raw = marked.replace(/\u0001[^\u0002]*\u0002/g, '');
  ok(!/<img|<script|<svg|onerror|onload/.test(raw), 'every hostile field is interpolated ONLY through the injected escaper (marker proof)', raw.slice(0, 160));
  ok(marks.includes(HOSTILE.agentName) && marks.includes(HOSTILE.threadId) && marks.some((m) => m.includes(HOSTILE.msgType)), 'the agent name, the thread id and the message type all pass through esc', JSON.stringify(marks.slice(0, 4)));
  const real = CR.collabRowHtml(HOSTILE, { esc: escHtml, icons: { in: '<svg class="i"></svg>' } });
  // (an escaped `onerror=` inside text/attribute VALUES is inert — what must
  // never appear is an unescaped tag opening or a bare quote breaking out)
  ok(!/<img|<script|<svg\/|'-alert/.test(real) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(real) && /&lt;svg\/onload=alert\(3\)&gt;/.test(real), 'with the real escaper nothing executable survives (name, type, title)', real.slice(0, 200));
  ok(/data-agent-path="\/root\/&lt;img src=x onerror=alert\(1\)&gt;"/.test(real) && /data-thread-id="&quot;&gt;&lt;script&gt;/.test(real), 'the click-through data attributes are escaped too (quotes included)', real.slice(0, 260));
  ok(/<svg class="i"><\/svg>/.test(real) && !/[←→⊕●]/.test(real), 'the direction is an injected SVG ICON, never a glyph/emoji (§17)');
  const multi = CR.collabRowsHtml({ rows: [HOSTILE, { ...HOSTILE, agentPath: '/root/other', agentName: 'other', threadId: 'th-2' }] }, { esc: escHtml, icons: {} });
  ok(!/<img|<script/.test(multi) && (multi.match(/class="chat-collab-name"/g) || []).length === 2, 'the coalesced row escapes every name and keeps ONE clickable chip per agent', multi.slice(0, 120));
  ok(CR.collabRowsHtml(null, { esc: escHtml }) === '' && CR.collabRowsHtml({ rows: [] }, { esc: escHtml }) === '', 'an empty collab renders nothing (never "undefined")');
  const blobRow = { dir: 'in', agentPath: '/root/x', agentName: 'x', msgType: 'MESSAGE', encrypted: true, detail: '' };
  ok(!/gAAAAAB/.test(CR.collabRowHtml(blobRow, { esc: escHtml, icons: {} }) + CR.collabRowTitle(blobRow)), 'a row has nowhere to carry an encrypted blob (the normalizer never puts one there, the builder never reads one)');
}

console.log('— ② renderer + chat-view wiring');
{
  const cr = read('src/lib/chat-renderers.js');
  ok(/renderToolMsg\(msg\) \{\s*\n\s*if \(msg\.collab\) return this\._renderCollabMsg\(msg\);/.test(cr), 'renderToolMsg dispatches a collab message BEFORE the tool-card path');
  ok(/collabRowsHtml\(collab, \{ esc: escHtml, t, icons: COLLAB_ICONS \}\)/.test(cr), 'the renderer injects the REAL escHtml + t + the SVG icon set');
  ok(/chat-agent-report-head[\s\S]{0,400}collabReportHeadText|escHtml\(collab\.agentName/.test(cr) && /chat-agent-report-body[^]{0,80}this\.renderMarkdown\(stripAnsi\(body\)\)/.test(cr), 'a sub-agent report renders an attributed head + its body as MARKDOWN (same sanitizer as assistant text)');
  ok(/renderMarkdown\(html\) \{[\s\S]{0,400}DOMPurify\.sanitize/.test(cr) || /DOMPurify\.sanitize\(marked\.parse/.test(cr), '…and renderMarkdown is the DOMPurify path (the XSS law)');
  ok(/COLLAB_ICONS = \{[\s\S]{0,220}lock: UI_ICONS\.lock,/.test(cr) && /agentIn:/.test(read('src/lib/icons.js')), 'the direction icons come from the central SVG library');
  const cv = read('src/lib/chat-view.js');
  ok(/const collabName = e\.target\.closest\?\.\('\.chat-collab-name'\);[\s\S]{0,320}this\._openCollabAgent\(\{/.test(cv), 'chat-view delegates a click on the agent NAME to _openCollabAgent');
  ok(/if \(threadId\) \{ this\._openSubagentViewer\(\{ threadId/.test(cv), '…which opens the EXISTING subagent viewer when the thread id is known (0.153.4 always knows it)');
  ok(/fetchJson\(`\/api\/subagents\?\$\{q\.toString\(\)\}`\)/.test(cv) && /showToast\(t\('This sub-agent’s conversation is not on this machine\.'\)\)/.test(cv), '…falls back to the roster route and TOASTS when the child rollout is elsewhere (no silent failure)');
  // The count is produced in chat-view (only it can see the run's rows) but the
  // LINE — its text and its position in the label — belongs to the ONE summary
  // table in the PURE module (round-5 rebase onto 2.369.37: a second per-kind
  // map in chat-view is exactly the 2.369.34 NaN class).
  const RS = await import(path.join(REPO, 'src/lib/chat-run-summary.js'));
  const tt = (k, p) => k.replace(/\{(\w+)\}/g, (m, x) => String(p?.[x] ?? m));
  ok(/byKind\.subAgentIn = collabRows\.filter\(\(r\) => r\.dir === 'in'\)\.length;/.test(cv)
    && RS.SUMMARY_EXTRAS.includes('subAgentIn')
    && RS.runSummaryParts({ ...RS.countKinds(['agent', 'agent']), subAgentIn: 5 }, new Set(), tt).join(' · ') === '5 sub-agent messages · 2 agent ops'
    && RS.runSummaryParts(RS.countKinds(['agent']), new Set(), tt).join(' · ') === '1 agent ops',
  "the fold summary counts codex INBOUND messages as '{n} sub-agent messages' (before 'agent ops'; absent when there are none)");
  ok(/chat-run-agents[\s\S]{0,200}\{n\} sub-agents[\s\S]{0,400}chat-collab-name/.test(cv), '…and lists the run\'s sub-agents as click-through chips');
  ok(/for \(const nameEl of header\.querySelectorAll\('\.chat-collab-name'\)\) \{[\s\S]{0,220}ev\.stopPropagation\(\);/.test(cv), 'a chip click does NOT toggle the run (stopPropagation on the header\'s own handler)');
  const css = read('public/chat.css');
  ok(/\.chat-msg\.chat-agent-report \{[^}]*border-left: 2px solid var\(--magenta/.test(css) && /\.chat-collab-name \{/.test(css) && /\.chat-collab-line \{/.test(css), 'the report card has the tinted left strip and the rows have their compact styles (theme vars only)');
  ok(!/#[0-9a-fA-F]{3,6}/.test(css.split('Codex multi-agent collab rows')[1].split('.chat-run-header .chat-collab-name')[0]), 'no literal colors in the new CSS block (§17)');
  // the default role indicator ('border') paints EVERY .chat-msg-tool-result
  // green — the report card must not read as ordinary assistant output
  ok(/\[data-role-indicator\] \.chat-msg\.chat-agent-report \{ border-left-color: var\(--magenta/.test(css) && /\[data-role-indicator\] \.chat-msg\.chat-msg-collab \{ border-left-color: transparent/.test(css), 'the role-indicator green bar is overridden for both collab shapes (attribute + 2 classes beats the generic tool-result rule)');
  for (const k of ['{n} sub-agent messages', '{n} sub-agents', 'sub-agent report', 'payload encrypted upstream', 'This sub-agent’s conversation is not on this machine.']) {
    ok(read('src/lib/i18n-zh.js').includes(`"${k}":`) && read('src/lib/i18n-ja.js').includes(`"${k}":`), `zh + ja carry "${k.slice(0, 34)}"`);
  }
  ok(/const PURE = new Set\(\[[^\]]*'src\/collab-row\.js'/.test(read('scripts/test-architecture.mjs')), 'the builder is registered in the PURE tier (it must never grow a dependency)');
  // FOLD KIND (B-7473 integration 2026-09-06): a sub-agent's REPORT is the answer the owner opened
  // the window to read — it must NOT hide inside the 'agent' fold, which ships
  // ON by default. It has its own kind, offered in settings but UNCHECKED.
  const schema = read('src/lib/settings-schema.js');
  const defaults = /'chat\.collapseKinds':[\s\S]{0,600}?default: \[([^\]]*)\]/.exec(schema)?.[1] || '';
  ok(/collapseKind: 'report'/.test(read('src/codex-message-manager.js')), "a sub-agent report is stamped collapseKind 'report' (not 'agent')");
  ok(/\{ value: 'report', label: t\(/.test(schema) && !/'report'/.test(defaults) && /'agent'/.test(defaults), "…'report' is an OFFERED fold kind but NOT in the default set (content, not orchestration noise)", defaults);
  ok(RS.RUN_KINDS.includes('report') && RS.countKinds(['report', 'report']).report === 2
    && RS.runSummaryParts(RS.countKinds(['report', 'report', 'report']), new Set(), tt).join(' · ') === '3 sub-agent reports'
    && RS.messageKind({ collapseKind: 'report', content: [{}] }, { toolCard: true }) === 'report',
  'the run header counts the kind (an unlisted kind counts NaN and vanishes from the summary) — RUN_KINDS/SUMMARY_ORDER own it, not a chat-view map');
  for (const k of ['{n} sub-agent reports', 'Sub-agent reports (a child agent’s written answer)']) {
    ok(read('src/lib/i18n-zh.js').includes(`"${k}":`) && read('src/lib/i18n-ja.js').includes(`"${k}":`), `zh + ja carry "${k.slice(0, 34)}"`);
  }
  // the dead-token fix: --bg-secondary is not defined anywhere in this project
  ok(!/\.chat-msg\.chat-agent-report \{[^}]*var\(--bg-secondary\)/.test(css) && !/\.chat-msg\.chat-peer-message \{[^}]*var\(--bg-secondary\)/.test(css), 'the report + peer cards use a DEFINED background token (--bg-secondary is undefined here ⇒ transparent)');
}

console.log('— ④ ONE IDENTITY PER SUB-AGENT + errors are not interchangeable (round-5)');
{
  // VERBATIM record shapes from the owner's real 0.153.4 root rollout
  // (rollout-2026-09-05T13-26-05, 4807 records at the measurement): the
  // OUTBOUND legs name a child BARE ("water_research"), while the spawn
  // OUTPUT, the inbound agent_message author and SubAgentActivity all name it
  // absolutely ("/root/water_research"). Keying rows on the raw value split
  // one agent into two identities (measured: 36 identities for 20 children,
  // 98 of 409 rows with no thread id ⇒ no click-through).
  const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
  const R = (payload, type = 'response_item') => ({ timestamp: '2026-09-05T20:26:35.282Z', type, payload });
  const ENC = 'gAAAAABqnHr7RNdCFbHi1418YUkBU5f8uf1SsslzHHqPKIgVHL-zdpqrepdT3mAVovAJLO4AnkWVyOKqwzLO24e';
  const recs = [
    R({ type: 'session_meta', id: '01a0733f-f028-7462-9769-be3e761a4f19', cwd: '/w', model: 'gpt-6-astra' }),
    // spawn_agent: BARE task_name in the arguments, absolute in the output
    R({ type: 'function_call', id: 'fc_1', call_id: 'call_SPAWN1', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ task_name: 'water_research', message: ENC }) }),
    R({ type: 'item_completed', thread_id: 'root-thread', turn_id: 't1', item: { type: 'SubAgentActivity', id: 'call_SPAWN1', kind: 'started', agent_thread_id: 'child-water', agent_path: '/root/water_research' } }, 'event_msg'),
    R({ type: 'function_call_output', id: 'fco_1', call_id: 'call_SPAWN1', output: JSON.stringify({ task_name: '/root/water_research' }) }),
    // send_message / followup_task: BARE target — the finding's carrier
    R({ type: 'function_call', id: 'fc_2', call_id: 'call_SEND1', name: 'send_message', namespace: 'collaboration', arguments: JSON.stringify({ target: 'water_research', message: ENC }) }),
    R({ type: 'function_call', id: 'fc_3', call_id: 'call_SEND2', name: 'followup_task', namespace: 'collaboration', arguments: JSON.stringify({ task_name: 'water_research', message: ENC }) }),
    // inbound: absolute author, encrypted payload
    R({ type: 'agent_message', id: 'amsg_1', author: '/root/water_research', recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: MESSAGE\nTask name: /root\nSender: /root/water_research\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: ENC }] }),
  ];
  const mm = new CodexMessageManager('r5');
  const msgs = mm.convertHistory(recs);
  const rows = [];
  for (const m of msgs) if (m.collab) for (const r of (m.collab.rows || [])) rows.push(r);
  const idents = new Set(rows.map((r) => r.agentPath || r.target).filter(Boolean));
  ok(rows.length === 4 && idents.size === 1 && [...idents][0] === '/root/water_research',
    'ONE identity per agent: the bare-name spawn/send/followup legs and the absolute inbound leg all key on /root/water_research', `${rows.length} rows, identities ${JSON.stringify([...idents])}`);
  ok(rows.every((r) => r.threadId === 'child-water'),
    'every row carries the child thread id once the map knows it (the outbound rows used to carry none ⇒ no click-through)', JSON.stringify(rows.map((r) => `${r.dir}:${r.threadId}`)));
  ok(Object.keys(mm.status().subagents).length === 1 && mm.status().subagents['/root/water_research'] === 'child-water',
    'status().subagents holds exactly one entry — the sub-agents summary counts DISTINCT agents, not spellings');
  // NEGATIVE CONTROL: two different parents may each own a child with the same
  // leaf name — the belt must never map one onto the other's thread.
  const mm2 = new CodexMessageManager('r5b');
  mm2.convertHistory([
    R({ type: 'session_meta', id: 'x', cwd: '/w' }),
    R({ type: 'item_completed', item: { type: 'SubAgentActivity', id: 'sa-a', kind: 'started', agent_thread_id: 'tid-a', agent_path: '/root/team_a/research' } }, 'event_msg'),
    R({ type: 'item_completed', item: { type: 'SubAgentActivity', id: 'sa-b', kind: 'started', agent_thread_id: 'tid-b', agent_path: '/root/team_b/research' } }, 'event_msg'),
  ]);
  const r2 = [];
  for (const m of mm2.messages) if (m.collab) for (const r of (m.collab.rows || [])) r2.push(r);
  ok(r2.length === 2 && r2[0].threadId === 'tid-a' && r2[1].threadId === 'tid-b',
    'negative control: two children with the SAME leaf name under different parents keep their own thread ids (the last-segment belt never overwrites an absolute path)', JSON.stringify(r2.map((r) => `${r.agentPath}=${r.threadId}`)));
  // …and the belt itself: a bare-path row left by an unknown carrier still
  // gets its thread id when the map later learns the absolute path
  const mm3 = new CodexMessageManager('r5c');
  mm3.convertHistory([R({ type: 'session_meta', id: 'y', cwd: '/w' })]);
  mm3._pushCollabRow({ dir: 'out', agentPath: 'legacy_child', agentName: 'legacy_child', msgType: 'MESSAGE', threadId: null }, false);
  mm3._noteSubagentThread('/root/legacy_child', 'tid-legacy');
  ok(mm3.messages.at(-1).collab.rows[0].threadId === 'tid-legacy', 'the belt back-fills a BARE row path from the map key’s last segment');

  // ── errors are not interchangeable ──
  // Carrier = the wrapper's synthesized standalone `sub_agent_activity`
  // (handleForeignThreadNotification: a CHILD's ErrorNotification becomes the
  // child's own row, never the root's task_failed) — verbatim field shape.
  const ERR = (event_id, detail) => R({ type: 'sub_agent_activity', event_id, occurred_at_ms: 1788639995297, agent_thread_id: 'kid', agent_path: '/root/kid', kind: 'errored', detail, thread_id: 'root-thread' }, 'event_msg');
  const mm4 = new CodexMessageManager('r5d');
  mm4.convertHistory([
    R({ type: 'session_meta', id: 'z', cwd: '/w' }),
    ERR('foreign-error-kid-1788639995297-1', 'tool exec denied by sandbox'),
    ERR('foreign-error-kid-1788639995297-2', 'stream error: 429 rate limited'),
    ERR('foreign-error-kid-1788639995298-3', 'turn aborted: context window exceeded'),
  ]);
  const errs = [];
  for (const m of mm4.messages) if (m.collab) for (const r of (m.collab.rows || [])) if (r.kind === 'errored') errs.push(r);
  ok(errs.length === 3 && new Set(errs.map((r) => r.detail)).size === 3,
    "three DIFFERENTLY-WORDED errors for one child draw three rows (the (thread,kind) key swallowed every one after the first)", JSON.stringify(errs.map((r) => r.detail)));
  // a genuine re-read of the SAME record still collapses — and an ID COLLISION
  // (Date.now() is not unique; the wrapper now also appends a counter, but the
  // key must not depend on it) does NOT hide the second failure
  const mm5 = new CodexMessageManager('r5e');
  mm5.convertHistory([
    R({ type: 'session_meta', id: 'z2', cwd: '/w' }),
    ERR('foreign-error-kid-1788639995297-1', 'same failure'),
    ERR('foreign-error-kid-1788639995297-1', 'same failure'),
    ERR('foreign-error-kid-1788639995297-1', 'a DIFFERENT failure in the same millisecond'),
  ]);
  const errs5 = [];
  for (const m of mm5.messages) if (m.collab) for (const r of (m.collab.rows || [])) if (r.kind === 'errored') errs5.push(r);
  ok(errs5.length === 2 && errs5[0].detail === 'same failure' && /DIFFERENT/.test(errs5[1].detail),
    'the same error record read twice collapses, but a colliding id with a different message still draws its row', JSON.stringify(errs5.map((r) => r.detail)));
  ok(/foreign-error-\$\{tid\}-\$\{Date\.now\(\)\}-\$\{\+\+foreignErrorSeq\}/.test(read('data/bin/codex-chat-wrapper.js')),
    'wrapper pin: the synthesized foreign-error id carries a counter (Date.now() alone is not unique)');
  // the non-error kinds keep their (thread, kind) coalescing (32 'completed'
  // records over 18 threads in the local corpus ⇒ one row per thread)
  const mm6 = new CodexMessageManager('r5f');
  mm6.convertHistory([
    R({ type: 'session_meta', id: 'z3', cwd: '/w' }),
    R({ type: 'item_completed', item: { type: 'SubAgentActivity', id: 'c1', kind: 'completed', agent_thread_id: 'kid', agent_path: '/root/kid' } }, 'event_msg'),
    R({ type: 'item_completed', item: { type: 'SubAgentActivity', id: 'c2', kind: 'completed', agent_thread_id: 'kid', agent_path: '/root/kid' } }, 'event_msg'),
  ]);
  const done = [];
  for (const m of mm6.messages) if (m.collab) for (const r of (m.collab.rows || [])) if (r.kind === 'completed') done.push(r);
  ok(done.length === 1, "negative control: 'completed' still coalesces per (thread, kind) — only 'errored' carries a message", String(done.length));
}

console.log('— ③ GET /api/subagents over a temp CODEX_HOME (real express mount)');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-subagents-'));
  const sess = path.join(dir, '.codex', 'sessions', '2026', '09', '05');
  fs.mkdirSync(sess, { recursive: true });
  const PARENT = '01a0733f-f028-7462-9769-be3e761a4f19';
  // Heads are REAL 0.153.4 shapes (rollout session_meta, cli_version 0.153.4):
  // a child carries source.subagent.thread_spawn AND a COPY of the parent's
  // meta on the next line — the copy must never be read as the child's own.
  const parentMeta = { session_id: PARENT, id: PARENT, timestamp: '2026-09-05T20:26:05.224Z', cwd: '/w', originator: 'claude-code-webui', cli_version: '0.153.4', source: 'vscode', history_mode: 'paginated' };
  const child = (id, agentPath, nickname, ts) => ({
    session_id: PARENT, id, forked_from_id: PARENT, parent_thread_id: PARENT, timestamp: ts, cwd: '/w',
    originator: 'claude-code-webui', cli_version: '0.153.4',
    source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_path: agentPath, agent_nickname: nickname, agent_role: null } } },
    thread_source: 'subagent', agent_nickname: nickname, agent_path: agentPath,
    history_mode: 'paginated', subagent_history_start_ordinal: 36, multi_agent_version: 'v2',
  });
  const write = (name, metas) => fs.writeFileSync(path.join(sess, name), metas.map((m) => JSON.stringify({ timestamp: m.timestamp, ordinal: 0, type: 'session_meta', payload: m })).join('\n') + '\n');
  write(`rollout-2026-09-05T13-26-05-${PARENT}.jsonl`, [parentMeta]);
  write('rollout-2026-09-05T14-10-31-01a07368-a01e-7503-abca-c6380f68b820.jsonl', [child('01a07368-a01e-7503-abca-c6380f68b820', '/root/walkthrough_v2', 'Beauvoir', '2026-09-05T21:10:31.711Z'), parentMeta]);
  write('rollout-2026-09-05T13-40-31-01a07340-6597-74f2-882c-f7092fecd5a0.jsonl', [child('01a07340-6597-74f2-882c-f7092fecd5a0', '/root/water_research', '', '2026-09-05T20:26:35.297Z'), parentMeta]);
  // an UNRELATED conversation on the same machine must never leak in
  write('rollout-2026-09-05T15-00-00-01a07999-0000-7000-8000-000000000001.jsonl', [{ ...parentMeta, id: '01a07999-0000-7000-8000-000000000001', session_id: '01a07999-0000-7000-8000-000000000001' }]);

  const probe = `
const express = require(${JSON.stringify(path.join(REPO, 'node_modules/express'))});
const { setup, router } = require(${JSON.stringify(path.join(REPO, 'src/routes/sessions.js'))});
const app = express();
// setup(ctx) wires the module-level router (it returns nothing) — mount THAT
setup({ activeSessions: new Map(), webuiPids: new Set(), refreshWebuiPids: () => {}, createSessionMessages: () => null, BUFFERS_DIR: '/tmp', PERMISSION_MODES: [], execFileSync: () => '', hosts: { get: () => null }, serverSetting: () => null });
app.use(router);
const srv = app.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  const get = async (q) => { const r = await fetch(base + '/api/subagents' + q); return { status: r.status, body: await r.json() }; };
  const out = {
    codex: await get('?backend=codex&threadId=${PARENT}'),
    cached: await get('?backend=codex&threadId=${PARENT}'),
    claude: await get('?backend=claude&threadId=x'),
    remote: await get('?backend=codex&threadId=${PARENT}&host=h1'),
    missing: await get('?backend=codex'),
    stranger: await get('?backend=codex&threadId=01a07999-0000-7000-8000-000000000001'),
  };
  console.log('@@' + JSON.stringify(out));
  srv.close(); process.exit(0);
});
`;
  const r = spawnSync(process.execPath, ['-e', probe], { env: { ...process.env, HOME: dir }, encoding: 'utf8', timeout: 60000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@'));
  ok(!!line, 'the route probe ran (real express mount, HOME=temp CODEX_HOME)', (r.stderr || '').slice(-400));
  const out = line ? JSON.parse(line.slice(2)) : {};
  const list = out.codex?.body?.subagents || [];
  ok(list.length === 2, 'the roster lists exactly the conversation\'s OWN children (an unrelated thread never leaks in)', JSON.stringify(list));
  const w = list.find((s) => s.agentPath === '/root/walkthrough_v2');
  ok(w && w.threadId === '01a07368-a01e-7503-abca-c6380f68b820' && w.nickname === 'Beauvoir' && w.depth === 1 && w.startedAt > 0, 'each row carries agentPath / nickname / threadId / depth / startedAt (from the child\'s OWN thread_spawn, not the inherited parent copy)', JSON.stringify(w));
  ok(list[0].startedAt <= list[1].startedAt, 'rows are ordered by spawn time', list.map((s) => s.startedAt).join(','));
  ok(out.cached?.body?.cached === true && JSON.stringify(out.cached.body.subagents) === JSON.stringify(list), 'a second ask inside 10s is served from cache (the walk is not free)');
  // WIRING PIN (B-7473 integration 2026-09-06): the route must not walk the tree ON the event loop —
  // it uses the transcript-worker twin. A sync require here is the regression.
  const routeSrc = fs.readFileSync(path.join(REPO, 'src/routes/sessions.js'), 'utf8');
  ok(/collectCodexThreadMetasAsync/.test(routeSrc) && !/[^A-Za-z]collectCodexThreadMetas\(/.test(routeSrc), 'the roster walk runs OFF the event loop (collectCodexThreadMetasAsync, the worker twin) — never the sync walk', routeSrc.match(/collectCodexThreadMetas\w*/g)?.join(','));
  ok(out.claude?.body?.reason === 'unsupported-backend' && (out.claude.body.subagents || []).length === 0, 'a non-codex backend gets a NAMED refusal, not a bare empty list');
  ok(out.remote?.body?.reason === 'remote-machine', 'a remote session says the children live on another machine (a silent [] would read as "no sub-agents")');
  ok(out.missing?.status === 400, 'a missing threadId is a 400');
  ok((out.stranger?.body?.subagents || []).length === 0, 'a conversation with no children answers with an empty roster');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
