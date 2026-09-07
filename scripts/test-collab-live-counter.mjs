#!/usr/bin/env node
// LIVE SUB-AGENT TRAFFIC COUNTER (2026-09-07, owner: "这种互聊如果连续发生是不是
// 应该界面里展示下连续数量, 这样我好知道对话没卡住").
//
// A codex root agent orchestrating sub-agents emits dozens of ENCRYPTED
// one-line collab rows over minutes with no assistant text between them — from
// the outside that is indistinguishable from a wedged turn. Three surfaces now
// read the same DERIVED numbers:
//   ① the coalesced card's head  ("Sub-agent traffic · 47 messages · 3 agents · last 4s ago")
//   ② the run header / footer / floating bar  ("· 3 sub-agents · 47 messages · last 4s ago")
//   ③ the spinner line            ("Sub-agents working — 47 messages, last 4s ago")
// Live = a ticking relative age; frozen = the absolute span ("over 4 min 12 s").
//
//   Part 1 (node, DOM-free): the PURE composers in src/collab-row.js — counts,
//     pluralisation, age granularity, live vs frozen, the run segment, the
//     spinner label — plus the normalizer leg (every row carries the RECORD's
//     own timestamp and says so) and the wiring pins.
//   Part 2 (headless chrome, SKIPs without chrome): a REAL codex rollout of the
//     shape the owner's root thread writes, opened READ-ONLY (frozen totals, no
//     ticking, no encrypted blob anywhere in the DOM), and a LIVE codex chat
//     session driven by a stub app-server through the real wrapper → real
//     normalizer → real ws push: the head count grows, the age ticks, the
//     spinner switches to the sub-agents form and yields back when another
//     record lands, and everything freezes at turn end.
// Run: node scripts/test-collab-live-counter.mjs
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0, passed = 0;
const check = (n, c, e) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}${e ? '\n    ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 500) : ''}`); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CR = require(path.join(REPO, 'src/collab-row.js'));
const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
const t = (k, p) => String(k).replace(/\{(\w+)\}/g, (m, x) => (p && p[x] !== undefined ? String(p[x]) : m));
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

// A fernet-shaped blob PREFIX, invented here — never the owner's rollout bytes.
// It is the string the DOM must never contain (assert ⑦).
// SHORT on purpose: the normalizer's encrypted-twin discriminator is the blob's
// first 32 chars (version + timestamp + IV in a real fernet token), so a fixture
// whose blobs share a 39-char prefix would dedupe into ONE row and silently
// weaken every count assertion below (caught on the first run).
const BLOB = 'gAAAAABqFIXTURE';
const blobFor = (tag) => BLOB + tag + '_' + 'z'.repeat(48);

// ── Part 1: the PURE composers ──────────────────────────────────────────────
console.log('— ① counts, pluralisation, age granularity, live vs frozen');
{
  const T0 = 1788640000000;
  const row = (dir, agent, over = {}) => ({ dir, agentPath: `/root/${agent}`, agentName: agent, msgType: 'MESSAGE', encrypted: true, ts: T0, tsKind: 'record', ...over });
  const one = CR.collabTrafficStats({ rows: [row('in', 'water')] });
  check('one inbound row: 1 message, 1 agent, no span (a single event has no duration)',
    one.count === 1 && one.agents === 1 && one.messagesOnly === true && one.firstTs === T0 && one.lastTs === T0
    && CR.collabHeadText(one, { live: false, t }) === 'Sub-agent traffic · 1 message · 1 agent',
    CR.collabHeadText(one, { live: false, t }));
  const many = CR.collabTrafficStats({ rows: [
    row('in', 'water'), row('in', 'energy', { ts: T0 + 60000 }), row('in', 'water', { ts: T0 + 252000 }),
  ] });
  check('pluralisation is real keys, never "1 messages" / "1 agents"',
    CR.collabHeadText(many, { live: false, t }) === 'Sub-agent traffic · 3 messages · 2 agents · over 4 min 12 s',
    CR.collabHeadText(many, { live: false, t }));
  check('LIVE replaces the span with a relative age off the LAST row',
    CR.collabHeadText(many, { live: true, now: T0 + 252000 + 4200, t }) === 'Sub-agent traffic · 3 messages · 2 agents · last 4s ago',
    CR.collabHeadText(many, { live: true, now: T0 + 252000 + 4200, t }));
  check('age: 1s granularity under a minute, whole minutes above it (floor, never a rounded lie)',
    CR.collabAgeText(0, t) === '0s' && CR.collabAgeText(999, t) === '0s' && CR.collabAgeText(1000, t) === '1s'
    && CR.collabAgeText(59999, t) === '59s' && CR.collabAgeText(60000, t) === '1m' && CR.collabAgeText(3 * 60000 + 59000, t) === '3m',
    [0, 999, 1000, 59999, 60000, 239000].map((m) => CR.collabAgeText(m, t)).join(','));
  check('span: "4 min 12 s" over a minute, "12 s" under it', CR.collabSpanText(252000, t) === '4 min 12 s' && CR.collabSpanText(12400, t) === '12 s',
    [CR.collabSpanText(252000, t), CR.collabSpanText(12400, t)].join(' | '));
  // HONESTY: a mixed set is not "messages" (spawn/wait/lifecycle are not mail)
  const mixed = CR.collabTrafficStats({ rows: [row('spawn', 'water'), row('in', 'water', { ts: T0 + 5000 }), row('activity', 'energy', { ts: T0 + 9000, kind: 'completed' })] });
  check('a MIXED set counts "sub-agent events", and agents are DISTINCT paths (not spellings)',
    mixed.messagesOnly === false && mixed.agents === 2
    && CR.collabHeadText(mixed, { live: false, t }) === 'Sub-agent traffic · 3 sub-agent events · 2 agents · over 9 s',
    CR.collabHeadText(mixed, { live: false, t }));
  // A MISSING clock must not be invented
  const noTs = CR.collabTrafficStats({ rows: [{ dir: 'in', agentPath: '/root/a', agentName: 'a' }, { dir: 'in', agentPath: '/root/a', agentName: 'a' }] });
  check('rows with no timestamp drop the age/span segment entirely (never "over 0 s", never "last 0s ago")',
    noTs.firstTs === null && noTs.lastTs === null
    && CR.collabHeadText(noTs, { live: false, t }) === 'Sub-agent traffic · 2 messages · 1 agent'
    && CR.collabHeadText(noTs, { live: true, now: Date.now(), t }) === 'Sub-agent traffic · 2 messages · 1 agent',
    CR.collabHeadText(noTs, { live: true, t }));
  check('the run segment names the agents first and carries the live age', CR.collabRunPart(many, { live: false, t }) === '2 sub-agents · 3 messages'
    && CR.collabRunPart(many, { live: true, now: T0 + 252000 + 65000, t }) === '2 sub-agents · 3 messages · last 1m ago'
    && CR.collabRunPart(CR.collabTrafficStats({ rows: [row('in', 'water')] }), { live: false, t }) === '1 sub-agent · 1 message'
    && CR.collabRunPart(CR.collabTrafficStats({ rows: [] }), { t }) === '',
    [CR.collabRunPart(many, { live: false, t }), CR.collabRunPart(many, { live: true, now: T0 + 252000 + 65000, t })].join(' | '));
  check('the spinner label states the count and the age, and degrades honestly with no clock',
    CR.subAgentStreamLabel(many, { now: T0 + 252000 + 4000, t }) === 'Sub-agents working — 3 messages this turn, last 4s ago'
    && CR.subAgentStreamLabel(noTs, { t }) === 'Sub-agents working — 2 messages this turn',
    CR.subAgentStreamLabel(many, { now: T0 + 252000 + 4000, t }));
  // r2 (verifier MINOR): the three surfaces are three SCOPES — card / run /
  // turn — and they legitimately show different numbers at the same moment.
  // The two that are read INSIDE the thing they count stay bare; the one that
  // floats free above the composer must say which scope it means.
  check('the free-floating spinner NAMES its scope ("this turn"); the card head and the run segment do not (they are read inside their own container)',
    / this turn/.test(CR.subAgentStreamLabel(many, { now: T0, t }))
    && !/this turn/.test(CR.collabHeadText(many, { live: true, now: T0, t }))
    && !/this turn/.test(CR.collabRunPart(many, { live: true, now: T0, t })),
    [CR.subAgentStreamLabel(many, { now: T0, t }), CR.collabHeadText(many, { live: true, now: T0, t })].join(' | '));
}

console.log('— ② the head is a rendered element, escaped, and never replaces a lone row');
{
  const T0 = 1788640000000;
  const rows = [
    { dir: 'in', agentPath: '/root/water', agentName: 'water', msgType: 'MESSAGE', encrypted: true, ts: T0, tsKind: 'record' },
    { dir: 'in', agentPath: '/root/energy', agentName: 'energy', msgType: 'MESSAGE', encrypted: true, ts: T0 + 252000, tsKind: 'record' },
  ];
  const frozen = CR.collabRowsHtml({ rows }, { esc: escHtml, t, icons: {} });
  const live = CR.collabRowsHtml({ rows }, { esc: escHtml, t, icons: {}, live: true, now: T0 + 252000 + 3000 });
  check('the head text lives in its OWN .chat-collab-head element (the ticker rewrites only that, never the card)',
    /<span class="chat-collab-head">Sub-agent traffic · 2 messages · 2 agents · over 4 min 12 s<\/span>/.test(frozen)
    && /<span class="chat-collab-head">Sub-agent traffic · 2 messages · 2 agents · last 3s ago<\/span>/.test(live),
    frozen.slice(0, 220));
  check('…and the clickable agent chips survive next to it (one per agent)', (live.match(/class="chat-collab-name"/g) || []).length === 2);
  const lone = CR.collabRowsHtml({ rows: [rows[0]] }, { esc: escHtml, t, icons: {}, live: true, now: T0 + 3000 });
  check('a LONE row keeps its full label (agent · TYPE) — summarising one event would only lose information',
    !/chat-collab-head/.test(lone) && /water/.test(lone) && /MESSAGE/.test(lone), lone.slice(0, 160));
  // XSS: the head is composed from model-controlled agent names ⇒ marker proof
  const marks = [];
  const markerEsc = (s) => { marks.push(String(s ?? '')); return '' + String(s ?? '') + ''; };
  const hostile = rows.map((r, i) => ({ ...r, agentPath: '/root/<img src=x onerror=alert(1)>' + i, agentName: '<img src=x onerror=alert(1)>' + i }));
  const marked = CR.collabRowsHtml({ rows: hostile }, { esc: markerEsc, t, icons: {}, live: true, now: T0 });
  check('every string in the head leaves through the INJECTED escaper (marker proof)',
    !/<img|onerror/.test(marked.replace(/[^]*/g, '')) && marks.some((m) => m.includes('Sub-agent traffic')),
    marked.replace(/[^]*/g, '').slice(0, 160));
  const real = CR.collabRowsHtml({ rows: hostile }, { esc: escHtml, t, icons: {}, live: true, now: T0 });
  check('…and with the real escaper no tag opening survives (an ESCAPED onerror= inside a value is inert)',
    !/<img|<script|<svg\//.test(real) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(real), real.slice(0, 200));
  // provenance: the title says WHICH clock
  check('the row title names the time AND where the clock came from (a rebuilt burst must not read as "just now")',
    /\(record timestamp\)/.test(CR.collabRowTitle(rows[0], t)) && /\(arrival time\)/.test(CR.collabRowTitle({ ...rows[0], tsKind: 'arrival' }, t))
    && !/Time:/.test(CR.collabRowTitle({ dir: 'in', agentName: 'x' }, t)),
    CR.collabRowTitle(rows[0], t));
}

console.log('— ③ the normalizer stamps every row from the RECORD (shapes from a real 0.153.4 root rollout)');
{
  const TID = '01a07700-0000-4000-8000-0000000000f1';
  const CHILD = '01a07700-0000-4000-8000-0000000000c1';
  const ENV = (sender) => `Message Type: MESSAGE\nTask name: /root\nSender: ${sender}\nPayload:\n`;
  const iso = (ms) => new Date(ms).toISOString();
  const T0 = Date.parse('2026-09-07T10:00:00.000Z');
  const ri = (payload, ms) => ({ timestamp: iso(ms), type: 'response_item', payload });
  const ev = (payload, ms) => ({ timestamp: iso(ms), type: 'event_msg', payload });
  const enc = (id, sender, blobTail, ms) => ri({
    type: 'agent_message', id, author: sender, recipient: '/root',
    content: [{ type: 'input_text', text: ENV(sender) }, { type: 'encrypted_content', encrypted_content: blobFor(blobTail) }],
  }, ms);
  const mm = new CodexMessageManager('live-counter');
  mm.convertHistory([
    { timestamp: iso(T0 - 1000), type: 'session_meta', payload: { session_id: TID, id: TID, cwd: '/w/vanlife', cli_version: '0.153.4' } },
    ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'design the van' }] }, T0 - 500),
    ri({ type: 'function_call', id: 'fc1', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ task_name: 'water_research', message: blobFor('spawn1') }), call_id: 'call_S1' }, T0),
    ri({ type: 'function_call_output', id: 'fco1', call_id: 'call_S1', output: '{"task_name":"/root/water_research"}' }, T0 + 500),
    ev({ type: 'item_completed', item: { type: 'SubAgentActivity', id: 'call_S1', kind: 'started', agent_thread_id: CHILD, agent_path: '/root/water_research' } }, T0 + 700),
    ri({ type: 'function_call', id: 'fc2', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ task_name: 'energy_research', message: blobFor('spawn2') }), call_id: 'call_S2' }, T0 + 2000),
    ri({ type: 'function_call_output', id: 'fco2', call_id: 'call_S2', output: '{"task_name":"/root/energy_research"}' }, T0 + 2100),
    enc('amsg_1', '/root/water_research', 'a', T0 + 60000),
    enc('amsg_2', '/root/energy_research', 'b', T0 + 150000),
    enc('amsg_3', '/root/water_research', 'c', T0 + 252000),
  ]);
  const cards = mm.messages.filter((m) => m.collab && !m.collab.report);
  check('the whole burst coalesces into ONE card', cards.length === 1, cards.map((c) => c.content[0].output));
  const rows = cards[0].collab.rows;
  check('every row carries the RECORD\'s own timestamp, marked as such', rows.length === 5 && rows.every((r) => r.tsKind === 'record' && r.ts > 0)
    && rows[0].ts === T0 && rows[4].ts === T0 + 252000, JSON.stringify(rows.map((r) => [r.dir, r.ts - T0, r.tsKind])));
  const stats = CR.collabTrafficStats(cards[0].collab);
  check('stats over the real rows: 5 events, 2 agents, a 4 min 12 s span',
    stats.count === 5 && stats.agents === 2 && stats.lastTs - stats.firstTs === 252000, JSON.stringify(stats));
  check('the stored plain-text output IS the frozen head + the names (search previews read what the screen reads)',
    cards[0].content[0].output.startsWith('Sub-agent traffic · 5 sub-agent events · 2 agents · over 4 min 12 s · ')
    && /water_research/.test(cards[0].content[0].output),
    cards[0].content[0].output);
  check('NO encrypted blob reaches any rendered string (spawn arguments + three encrypted messages)', !JSON.stringify(mm.messages).includes(BLOB));
  // (4) DEDUP TWINS ARE NOT COUNTED TWICE — the 2.369.49 rules, measured
  const mm2 = new CodexMessageManager('live-counter-twins');
  const base = [
    { timestamp: iso(T0 - 1000), type: 'session_meta', payload: { session_id: TID, id: TID, cwd: '/w', cli_version: '0.153.4' } },
    ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }, T0 - 500),
    enc('amsg_1', '/root/water_research', 'a', T0 + 1000),
    enc('amsg_1', '/root/water_research', 'a', T0 + 1000),                                     // exact re-read (id leg)
    enc('amsg_2', '/root/water_research', 'b', T0 + 2000),                                     // DIFFERENT blob, same envelope
    ev({ type: 'item_completed', item: { type: 'SubAgentActivity', id: 'sa1', kind: 'completed', agent_thread_id: CHILD, agent_path: '/root/water_research' } }, T0 + 3000),
    ev({ type: 'item_completed', item: { type: 'SubAgentActivity', id: 'sa2', kind: 'completed', agent_thread_id: CHILD, agent_path: '/root/water_research' } }, T0 + 3100),
  ];
  mm2.convertHistory(base);
  const s2 = CR.collabTrafficStats(mm2.messages.filter((m) => m.collab)[0].collab);
  check('the counter never double-counts a dedup twin: a re-read id collapses, a second (thread,kind) lifecycle collapses, two DIFFERENT encrypted messages both count',
    s2.count === 3, JSON.stringify(mm2.messages.filter((m) => m.collab)[0].collab.rows.map((r) => `${r.dir}:${r.kind || r.msgType}`)));
  check('…and encrypted vs plaintext makes no difference to counting (both are one event each)',
    mm2.messages.filter((m) => m.collab)[0].collab.rows.filter((r) => r.encrypted).length === 2);
}

console.log('— ④ wiring pins (a pure composer with an unstaged call site is dead code)');
{
  const cv = read('src/lib/chat-view.js');
  const cr = read('src/lib/chat-renderers.js');
  const ci = read('src/lib/chat-input.js');
  const rs = read('src/lib/chat-run-summary.js');
  check('chat-view imports the composers from the PURE collab module', /import \{ collabTrafficStats, collabHeadText, collabRunPart, subAgentStreamLabel \} from '\.\.\/collab-row\.js';/.test(cv));
  check('the renderer asks the VIEW whether a card is live (view-only ⇒ always frozen) and the answer is REMEMBERED',
    /isCollabLive: \(msg\) => this\._noteCollabHeadPainted\(msg\?\.id, this\._liveCollabId\(\) === msg\?\.id\),/.test(cv)
    && /this\._isCollabLive = isCollabLive \|\| null;/.test(cr)
    && /const live = !!this\._isCollabLive\?\.\(msg\);/.test(cr));
  check('liveness = the LAST message, and only while the turn streams', /_liveCollabId\(\) \{\s*\n\s*if \(!this\._typingSince \|\| this\._disposed\) return null;[\s\S]{0,220}return \(last\?\.collab && !last\.collab\.report\) \? last\.id : null;/.test(cv));
  check('the ticker is only armed when something is live (a claude session never carries an interval) and paints once immediately',
    /if \(this\._collabTimer \|\| this\._disposed \|\| !this\._liveCollabId\(\)\) return;\s*\n\s*this\._collabTimer = setInterval[^\n]*\n\s*this\._tickCollab\(\);/.test(read('src/lib/chat-view.js')));
  check('ONE interval per ChatView, bound to the window AbortController + cleared in dispose (never one timer per message)',
    (cv.match(/setInterval\(\(\) => this\._tickCollab\(\), 1000\)/g) || []).length === 1
    && /pressSignal\.addEventListener\('abort', \(\) => this\._stopCollabTick\(\), \{ once: true \}\)/.test(cv)
    && /this\._stopCollabTick\(\);/.test(cv.slice(cv.indexOf('  dispose() {'))));
  check('a hidden window is a NO-OP and resume repaints immediately (setSuspended)',
    /_tickCollab\(\) \{\s*\n\s*if \(this\._disposed\) return;\s*\n\s*if \(this\._suspended\) return;/.test(cv)
    && /this\._tickCollab\(\); \/\/ the ages went stale while hidden/.test(cv));
  check('the ticker never pages, trims, scrolls or writes the pin', (() => {
    const body = cv.slice(cv.indexOf('  _tickCollab() {'), cv.indexOf('  // _showTyping / _hideTyping delegate'));
    return body.length > 200 && !/_extendTop|_extendBottom|_trimTop|_trimBottom|_pinned =|scrollTop =/.test(body);
  })());
  check('op dispatch notes the record KIND after the message is applied (a coalescing edit carries the grown rows)',
    /this\._onCreateMessage\(op\.message\);\s*\n\s*this\._noteRecordKind\(op\.message\);/.test(cv)
    && /this\._onEditMessage\(op\.id, op\.fields\);[\s\S]{0,140}this\._noteRecordKind\(this\._messages\.find\(\(m\) => m\.id === op\.id\)\);/.test(cv));
  check('the server stays the label authority: the override yields back ONLY what it took',
    /_onServerStreamLabel\(label, kind\) \{/.test(cv) && /this\._collabLabelShown = false; \/\/ the server is writing the line itself now/.test(cv)
    && /if \(this\._collabLabelShown\) \{\s*\n\s*this\._collabLabelShown = false;/.test(cv)
    && !/if \(msg\.label\) this\._showTyping\(msg\.label, msg\.kind \|\| null\);/.test(cv));
  check('turn end FREEZES every surface (a ticking age on a finished turn reads as progress)',
    /_hideTyping\(\) \{[\s\S]{0,320}this\._freezeCollab\(\);/.test(cv) && /_freezeCollab\(\) \{\s*\n\s*this\._stopCollabTick\(\);/.test(cv));
  // r2 (verifier MAJOR): the freeze walked only the card the TICKER had
  // painted, so a burst that ran entirely while the window was hidden — the
  // ticker is a no-op then — never froze at all.
  check('the freeze walks the SET of live-painted heads, never "the card the ticker last painted"',
    /_freezeCollab\(\) \{[\s\S]{0,260}this\._freezeStaleHeads\(null, now\);/.test(cv)
    && /_freezeStaleHeads\(liveId, now\) \{[\s\S]{0,220}for \(const id of \[\.\.\.this\._liveHeadIds\]\)/.test(cv)
    && /this\._liveHeadIds = new Set\(\);/.test(cv)
    && !/_tickedCollabId/.test(cv));
  check('…and the tick uses the same sweep (a card that stops being live is frozen once, whoever painted it)',
    /_tickCollab\(\) \{[\s\S]{0,700}this\._freezeStaleHeads\(liveId, now\);\s*\n\s*if \(liveId\) this\._paintCollabHead\(liveId, true, now\);/.test(cv));
  // chat-view.js is DOM-free at import and its resume guards are unit-tested on
  // PROTOTYPE-ONLY views whose constructor never ran (test-chat-trim-guard) —
  // setSuspended(false) runs a tick on those, so every new constructor field
  // the tick path touches must be optional there (caught by that suite: a bare
  // `this._liveHeadIds.size` threw and took the whole resume suite down).
  check('the live-head set is lazily created and read optionally (a prototype-only view still ticks)',
    /const ids = \(this\._liveHeadIds \|\|= new Set\(\)\);/.test(cv)
    && /if \(!this\._liveHeadIds\?\.size\) return;/.test(cv)
    && /this\._liveHeadIds\?\.delete\(msgId\); return;/.test(cv));
  // r2 (verifier BLOCKER): the label CHANGES on every tick (the age), so a
  // memo keyed on the label text could never protect anything — the button was
  // rebuilt once a second and trusted Stop clicks were swallowed. A text
  // change must be a textContent write into the label's own element.
  check('ChatInput.showTyping writes the label TEXT and never rebuilds the Stop button while the kind is unchanged',
    /const liveBtn = this\._isStreaming \? this\._streamStatus\.querySelector\('\.chat-interrupt-btn'\) : null;/.test(ci)
    && /const labelEl = liveBtn && this\._typingKind === kind \? this\._streamStatus\.querySelector\('\.chat-stream-label'\) : null;/.test(ci)
    && /if \(labelEl\) \{\s*\n\s*if \(this\._typingLabel !== label\) \{ labelEl\.textContent = label; this\._typingLabel = label; \}/.test(ci)
    && /<span class="chat-stream-label">\$\{escHtml\(label\)\}<\/span>/.test(ci)
    && /this\._typingLabel = null;[\s\S]{0,80}this\._typingKind = null;/.test(ci));
  check('…and the button-less pending line still falls through to a FULL render (it has no .chat-interrupt-btn)',
    /this\._typingLabel = null; \/\/ this line has no Stop button/.test(ci));
  check('the read-only stream line carries the same label element (a ticking age is a text write there too)',
    /<span class="chat-spinner"><\/span> <span class="chat-stream-label">\$\{escHtml\(label\)\}<\/span>/.test(cv)
    && /if \(roLabel && !this\._streamStatus\.classList\.contains\('hidden'\)\) \{/.test(cv));
  check('the run label takes a PRE-COMPOSED collab segment — chat-run-summary still imports nothing',
    /collabPart: collabRunPart\(collabStats, \{ now, live, t \}\)/.test(cv) && /collabPart = ''/.test(rs) && !/^\s*import /m.test(rs));
  check('the run record carries the label recipe so the ticker never builds a second kind table',
    /const rec = \{ header, members, inline, footer: null, label, open: false, mkLabel, collabStats/.test(cv)
    && /run\.mkLabel\(\{ now, live \}\)/.test(cv));
  check('the run header keeps a separator before the clickable chips (r2: "2 sub-agent events water_research" read as one phrase)',
    /\$\{label \? ' · ' : ' '\}<span class="chat-run-agents">/.test(cv));
  check('the ticker repaints header, footer AND the floating bar (three views of ONE label)',
    /const footLabel = run\.footer\?\.querySelector\('\.chat-run-label'\);/.test(cv) && /if \(this\._runBarRun === run\) this\._scheduleRunBar\(\);/.test(cv));
  check('chat.css styles the head with theme vars only (§17)', /\.chat-collab-head \{ color: var\(--text\); font-variant-numeric: tabular-nums; \}/.test(read('public/chat.css')));
  for (const f of ['src/lib/i18n-zh.js', 'src/lib/i18n-ja.js']) {
    const d = read(f);
    const keys = ['"Sub-agent traffic":', '"{n} message":', '"{n} agent":', '"{n} sub-agent":', '"last {age} ago":', '"over {span}":', '"{n}s":', '"{m} min {s} s":', '"{s} s":', '"Sub-agents working — {msgs} this turn":', '"Sub-agents working — {msgs} this turn, last {age} ago":', '"record timestamp":', '"arrival time":'];
    check(`${path.basename(f)} carries every new key`, keys.every((k) => d.includes(k)), keys.filter((k) => !d.includes(k)).join(' '));
  }
}

// ── Part 2: headless chrome ─────────────────────────────────────────────────
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.log('  SKIP: no chrome/chromium — browser half not run');
  console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASS (${passed})`);
  process.exit(failed ? 1 : 0);
}
// be a good citizen on a shared box (the chrome-suite convention)
for (let i = 0; i < 60; i++) {
  const load = Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
  if (!(load >= 15)) break;
  await sleep(5000);
}

const PORT = await freePort(), CDP_PORT = await freePort();
const wt = `/tmp/vs-collablive-${process.pid}`;
const fakeHome = `${wt}-home`;
const CWD = `${wt}-cwd`;
const FROZEN_TID = '01a07700-0000-4000-8000-0000000000f1';
const CHILD_TID = '01a07700-0000-4000-8000-0000000000c1';
const LIVE_TID = '01a07700-0000-4000-8000-0000000000aa';

// ── the FROZEN fixture: a real-shaped 0.153.4 root rollout with a 4m12s burst ──
{
  const sessDir = path.join(fakeHome, '.codex', 'sessions', '2026', '09', '07');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.mkdirSync(CWD, { recursive: true });
  const T0 = Date.parse('2026-09-07T10:00:00.000Z');
  const iso = (ms) => new Date(ms).toISOString();
  const L = [];
  let ord = 0;
  const R = (type, payload, ms) => L.push(JSON.stringify({ timestamp: iso(ms), ordinal: ord++, type, payload }));
  const ENV = (sender) => `Message Type: MESSAGE\nTask name: /root\nSender: ${sender}\nPayload:\n`;
  R('session_meta', { session_id: FROZEN_TID, id: FROZEN_TID, timestamp: iso(T0 - 2000), cwd: CWD, originator: 'claude-code-webui', cli_version: '0.153.4', source: 'vscode', history_mode: 'paginated' }, T0 - 2000);
  R('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'design the van' }] }, T0 - 1000);
  R('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Spawning research agents.' }], phase: 'commentary' }, T0 - 500);
  R('response_item', { type: 'function_call', id: 'fc1', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ task_name: 'water_research', message: blobFor('sp1') }), call_id: 'call_S1' }, T0);
  R('response_item', { type: 'function_call_output', id: 'fco1', call_id: 'call_S1', output: '{"task_name":"/root/water_research"}' }, T0 + 400);
  R('event_msg', { type: 'item_completed', thread_id: FROZEN_TID, item: { type: 'SubAgentActivity', id: 'call_S1', kind: 'started', agent_thread_id: CHILD_TID, agent_path: '/root/water_research' } }, T0 + 600);
  R('response_item', { type: 'function_call', id: 'fc2', name: 'spawn_agent', namespace: 'collaboration', arguments: JSON.stringify({ task_name: 'energy_research', message: blobFor('sp2') }), call_id: 'call_S2' }, T0 + 2000);
  R('response_item', { type: 'function_call_output', id: 'fco2', call_id: 'call_S2', output: '{"task_name":"/root/energy_research"}' }, T0 + 2100);
  for (const [i, [who, at]] of [['water_research', 60000], ['energy_research', 150000], ['water_research', 252000]].entries()) {
    R('response_item', {
      type: 'agent_message', id: `amsg_${i}`, author: `/root/${who}`, recipient: '/root',
      content: [{ type: 'input_text', text: ENV(`/root/${who}`) }, { type: 'encrypted_content', encrypted_content: blobFor('m' + i) }],
    }, T0 + at);
  }
  R('event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '' }, T0 + 253000);
  fs.writeFileSync(path.join(sessDir, `rollout-2026-09-07T10-00-00-${FROZEN_TID}.jsonl`), L.join('\n') + '\n');
}

// ── the stub codex app-server: a REAL wrapper drives it, we script the burst ──
const STUB = `#!/usr/bin/env node
'use strict';
// Stub \`codex\` for scripts/test-collab-live-counter.mjs. Only the app-server
// surface the codex-chat-wrapper actually calls; every unknown method answers
// {} exactly as the other codex suites' stubs do.
if (process.argv[2] !== 'app-server') { process.stdout.write('codex-cli 0.153.4-stub\\n'); process.exit(0); }
const TID = ${JSON.stringify(LIVE_TID)};
const CHILD = ${JSON.stringify(CHILD_TID)};
const BLOBLESS_ENV = (s) => 'Message Type: MESSAGE\\nTask name: /root\\nSender: ' + s + '\\nPayload:\\n';
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
const note = (method, params) => send({ method, params });
let buf = '', turns = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined || !m.method) continue;
    if (m.method === 'thread/start') { send({ id: m.id, result: { thread: { id: TID } } }); continue; }
    if (m.method === 'thread/queue/list') { send({ id: m.id, result: { data: [], nextCursor: null } }); continue; }
    if (m.method === 'turn/start') {
      const tid = 'turn-' + (++turns);
      // KEYED ON THE INPUT TEXT, never on a turn counter: the wrapper may open
      // a turn WE did not ask for (the stop-nudge bookkeeping turn fires at
      // every turn end), and a counter-keyed stub then plays the wrong script
      // into the wrong turn — which is exactly how the first version of leg ⑨
      // sampled a burst it had not started.
      const text = (m.params?.input || []).map((i) => (i && i.text) || '').join(' ');
      send({ id: m.id, result: { turn: { id: tid } } });
      note('turn/started', { turn: { id: tid } });
      const item = (o) => note('item/completed', { threadId: TID, turnId: tid, item: o });
      const mail = (id, who) => item({ type: 'agentMessage', id, text: BLOBLESS_ENV('/root/' + who) });
      if (/second orchestration/.test(text)) {
        // THE HIDDEN-WINDOW BURST (leg ⑨): THREE agents, so its head
        // ("4 messages · 3 agents") can never be confused with turn 1's cards.
        setTimeout(() => mail('bm-1', 'water_research'), 300);
        setTimeout(() => mail('bm-2', 'energy_research'), 900);
        setTimeout(() => mail('bm-3', 'solar_research'), 1500);
        setTimeout(() => mail('bm-4', 'water_research'), 2100);
        setTimeout(() => note('turn/completed', { turn: { id: tid }, status: 'completed' }), 3000);
        continue;
      }
      if (!/orchestrate the research/.test(text)) {   // any other turn (a nudge): end it at once, script nothing
        setTimeout(() => note('turn/completed', { turn: { id: tid }, status: 'completed' }), 200);
        continue;
      }
      // THE BURST: three phases the browser half samples between.
      setTimeout(() => item({ type: 'subAgentActivity', id: 'sa-1', kind: 'started', agentThreadId: CHILD, agentPath: '/root/water_research' }), 300);
      setTimeout(() => mail('am-1', 'water_research'), 700);
      setTimeout(() => mail('am-2', 'energy_research'), 1100);
      setTimeout(() => mail('am-3', 'water_research'), 1500);
      // …then SILENCE (the age must tick on its own)…
      // a NON-collab record: the label must yield
      // a real app-server always opens a commandExecution with item/started —
      // without it the wrapper records only the OUTPUT and the normalizer has no
      // tool name to classify (the card falls to the unknown-tool 'mcp' kind)
      setTimeout(() => {
        note('item/started', { threadId: TID, turnId: tid, item: { type: 'commandExecution', id: 'exec-1', command: ['ls', '-l'], status: 'inProgress' } });
        item({ type: 'commandExecution', id: 'exec-1', command: ['ls', '-l'], status: 'completed', aggregatedOutput: 'total 0\\n', exitCode: 0 });
      }, 7000);
      // …and back to collab traffic
      setTimeout(() => mail('am-4', 'energy_research'), 9000);
      // …and the turn stays open long enough for the Stop-button legs to watch
      // the label tick for several seconds (r2 BLOCKER) before the freeze legs.
      setTimeout(() => note('turn/completed', { turn: { id: tid }, status: 'completed' }), 36000);
      continue;
    }
    send({ id: m.id, result: {} });
  }
});
setInterval(() => {}, 60000);
`;
const stubPath = `${wt}-codex-stub`;
fs.writeFileSync(stubPath, STUB, { mode: 0o755 });

try { execSync(`git worktree remove --force ${wt}`, { cwd: REPO, stdio: 'ignore' }); } catch { }
execSync(`git worktree add --detach ${wt} HEAD`, { cwd: REPO, stdio: 'ignore' });
for (const f of ['src', 'public', 'server.js', 'package.json']) execSync(`rm -rf ${wt}/${f} && cp -r ${REPO}/${f} ${wt}/${f}`);
// data/ = ONLY the tracked agent tools. The repo's data/ is PRODUCTION (~600 MB of
// buffers, telemetry, ledgers): copying it made this suite take >9 min and put
// live-session artifacts under /tmp (2.369.57 gate timeout).
execSync(`rm -rf ${wt}/data && mkdir -p ${wt}/data && cp -r ${REPO}/data/bin ${wt}/data/bin`);
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(wt, 'node_modules'));

const srv = spawn(process.execPath, ['server.js'], {
  cwd: wt,
  env: { ...process.env, PORT: String(PORT), HOME: fakeHome, CODEX_CMD: stubPath, VIBESPACE_SKIP_AGENT_HOOKS: '1', VIBESPACE_PASSWORD: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const srvLog = [];
srv.stdout.on('data', (d) => srvLog.push(String(d)));
srv.stderr.on('data', (d) => srvLog.push(String(d)));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-first-run', '--disable-gpu', '--window-size=1500,1000',
  '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', `--user-data-dir=${wt}-chrome`, 'about:blank'], { stdio: 'ignore' });
let liveWs = null;
const cleanup = () => {
  try { liveWs?.close(); } catch { }
  try { chrome.kill('SIGKILL'); } catch { }
  try { srv.kill('SIGKILL'); } catch { }
  try { execSync(`git worktree remove --force ${wt}`, { cwd: REPO, stdio: 'ignore' }); } catch { }
  for (const d of [`${wt}-chrome`, fakeHome, CWD, stubPath]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
};
process.on('exit', cleanup);
for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/home`); break; } catch { await sleep(250); } }

const WebSocket = require('ws');
let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((x) => x.type === 'page'); } catch { }
  if (!target) await sleep(250);
}
if (!target) { console.error('✗ chrome never exposed a CDP page target'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaljs = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
};
await cdp('Runtime.enable'); await cdp('Page.enable');
await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
for (let i = 0; i < 120; i++) { if (await evaljs('!!(window.app && window.app.ready && window.app.wm)').catch(() => false)) break; await sleep(300); }
await evaljs('window.app.ready.then(() => true)').catch(() => { });
await sleep(1200);

// ── ⑤ READ-ONLY RELOAD: frozen totals, no ticking, no blob ──────────────────
console.log('— ⑤ a stopped transcript shows FROZEN totals (read-only reload)');
{
  const opened = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.app.viewSession(${JSON.stringify(FROZEN_TID)}, ${JSON.stringify(CWD)}, 'frozen burst', { backend: 'codex', backendSessionId: ${JSON.stringify(FROZEN_TID)} });
    let list = null, head = null;
    for (let i = 0; i < 100; i++) {
      list = [...document.querySelectorAll('.chat-message-list')].pop();
      head = list && list.querySelector('.chat-collab-head');
      if (head) break;
      await sleep(250);
    }
    if (!head) return { ok: false, msgs: list ? list.querySelectorAll('.chat-msg').length : -1 };
    window.__frozen = list;
    const header = list.querySelector(':scope > .chat-run-header');
    return { ok: true, head: head.textContent, header: header ? header.textContent.trim() : '', html: list.innerHTML.length };
  })()`);
  check('the read-only view rendered the coalesced burst with its head', opened?.ok, JSON.stringify(opened));
  check('the head reads the FROZEN totals — count, agents, and the absolute span',
    opened?.head === 'Sub-agent traffic · 5 sub-agent events · 2 agents · over 4 min 12 s', opened?.head);
  check('the run header carries the same traffic (this is what a folded reader sees) and NO live age',
    /2 sub-agents · 5 sub-agent events/.test(opened?.header || '') && !/last \d+[sm] ago/.test(opened?.header || ''), opened?.header);
  check('…and the clickable agent chips are a SEPARATE segment, not glued to the count (r2)',
    /sub-agent events · water_research/.test(opened?.header || ''), opened?.header);
  const after = await (async () => { await sleep(2600); return evaljs(`window.__frozen.querySelector('.chat-collab-head').textContent`); })();
  check('…and NOTHING ticks on a stopped transcript (same text 2.6s later)', after === opened?.head, `${opened?.head} → ${after}`);
  const blobHit = await evaljs(`(() => { const h = document.body.innerHTML; return h.indexOf(${JSON.stringify(BLOB)}); })()`);
  check('⑦ no encrypted blob text anywhere in the DOM (5 blobs in the fixture: 2 spawn arguments, 3 payloads)', blobHit === -1, `index ${blobHit}`);
}

// ── LIVE: a real codex chat session driven by the stub app-server ───────────
console.log('— ⑥ a LIVE turn: the head grows, the age ticks, the label switches and yields, then everything freezes');
{
  liveWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => liveWs.on('open', r));
  const frames = [];
  liveWs.on('message', (d) => { try { frames.push(JSON.parse(String(d))); } catch { } });
  liveWs.send(JSON.stringify({ type: 'create', backend: 'codex', mode: 'chat', cwd: CWD, reqId: 'live1' }));
  let sid = null;
  for (let i = 0; i < 80 && !sid; i++) { const f = frames.find((m) => m?.type === 'created'); if (f) sid = f.sessionId; else await sleep(500); }
  check('a live codex chat session was created through the real spawn path (stub app-server behind the real wrapper)', !!sid,
    frames.slice(-3).map((f) => JSON.stringify(f).slice(0, 200)).join('\n') + '\n' + srvLog.join('').slice(-800));
  if (!sid) {
    console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASS (${passed})`);
    process.exit(1);
  }
  const attached = await evaljs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const win = window.app.attachSession(${JSON.stringify(sid)}, 'live burst', ${JSON.stringify(CWD)}, { mode: 'chat', backend: 'codex' });
    for (let i = 0; i < 80; i++) { if (window.app.sessions.get(win.id)?._messageList) break; await sleep(200); }
    const view = window.app.sessions.get(win.id);
    window.__live = view;
    window.__liveList = view._messageList;
    return !!view;
  })()`);
  check('the live window is attached in the browser', attached === true);

  const probe = () => evaljs(`(() => {
    const v = window.__live, list = window.__liveList;
    const head = list.querySelector('.chat-collab-head');
    const header = list.querySelector(':scope > .chat-run-header .chat-run-label');
    // THIS view's own status line — a document-wide query finds the read-only
    // window's (permanently hidden) one first and reports "no label" forever
    const status = v._container.querySelector('.chat-stream-status');
    return {
      head: head ? head.textContent : null,
      header: header ? header.textContent : null,
      label: status && !status.classList.contains('hidden') ? (status.textContent || '').replace(/\\s*■\\s*Stop\\s*$/, '').trim() : null,
      liveId: v._liveCollabId(),
      rows: (v._messages.filter((m) => m.collab).flatMap((m) => m.collab.rows || [])).length,
      ticking: !!v._collabTimer,
    };
  })()`);

  // fire the turn from the node ws (the browser window just renders it)
  liveWs.send(JSON.stringify({ type: 'chat-input', sessionId: sid, text: 'orchestrate the research', msgId: 'live-m1' }));

  // ── the head COUNT grows as rows arrive ──
  const counts = [];
  for (let i = 0; i < 40; i++) {
    const p = await probe();
    if (p.rows) counts.push(p.rows);
    if (p.rows >= 4) break;
    await sleep(300);
  }
  const grew = counts.length > 1 && counts[counts.length - 1] > counts[0];
  check('the coalesced card GREW as rows arrived (the head count is derived, never a stored counter)', grew && counts[counts.length - 1] === 4,
    JSON.stringify(counts));
  const p1 = await probe();
  check('the head names the traffic with a LIVE age while the turn streams', /^Sub-agent traffic · 4 sub-agent events · 2 agents · last \d+s ago$/.test(p1.head || ''), p1.head);
  check('the run header carries the same live traffic (what a folded reader sees)', /2 sub-agents · 4 sub-agent events · last \d+s ago/.test(p1.header || ''), p1.header);
  check('the spinner line switched to the sub-agents form (naming its TURN scope)', /^Sub-agents working — 4 sub-agent events this turn, last \d+s ago$/.test(p1.label || ''), p1.label);
  check('one ticker is running for this view', p1.ticking === true && !!p1.liveId);

  // ── the AGE ticks with no new rows ──
  const ageOf = (s) => { const m = /last (\d+)s ago/.exec(s || ''); return m ? Number(m[1]) : null; };
  const a1 = ageOf(p1.head);
  await sleep(2600);
  const p2 = await probe();
  const a2 = ageOf(p2.head);
  check('the age TICKS while the turn is still streaming (head)', a1 != null && a2 != null && a2 >= a1 + 2, `${p1.head} → ${p2.head}`);
  check('…and on the run header + the spinner line, off the SAME clock', ageOf(p2.header) === a2 && ageOf(p2.label) === a2,
    `${p2.header} | ${p2.label}`);
  check('no rows arrived in between (the age moved on its own, not because of new traffic)', p2.rows === p1.rows, `${p1.rows} → ${p2.rows}`);

  // ── ATTACH MID-BURST: the arming path a re-attach / a second client takes ──
  // loadHistory renders every card BEFORE _showTyping runs, so the head is
  // painted frozen and no ticker exists yet; _onServerStreamLabel is the event
  // that finally makes "is this live" answerable, and it must repaint at once
  // (attaching to a STALLED turn is the case the whole readout exists for).
  const rearmed = await evaljs(`(async () => {
    const v = window.__live, list = window.__liveList;
    v._stopCollabTick();
    const head = list.querySelector('.chat-collab-head');
    head.textContent = 'STALE';                      // as a fresh render would leave it
    v._onServerStreamLabel('thinking...', null);      // the attach/reattach event
    await new Promise((r) => setTimeout(r, 60));
    return { head: list.querySelector('.chat-collab-head').textContent, ticking: !!v._collabTimer };
  })()`);
  check('a mid-burst attach paints the LIVE age immediately and re-arms the one ticker',
    /^Sub-agent traffic · 4 sub-agent events · 2 agents · last \d+s ago$/.test(rearmed?.head || '') && rearmed?.ticking === true, JSON.stringify(rearmed));
  check('…and the server label it carried is what the spinner shows (the collab override yields only what it took)',
    (await probe()).label === 'thinking...', (await probe()).label);

  // ── a NON-collab record lands: the label yields ──
  let yielded = null;
  for (let i = 0; i < 60; i++) {
    const p = await probe();
    if (p.label && !/Sub-agents working/.test(p.label)) { yielded = p; break; }
    await sleep(300);
  }
  check('the spinner YIELDS the moment a different record arrives (the exec card)', !!yielded && !/Sub-agents working/.test(yielded.label || ''), JSON.stringify(yielded));
  // ── …and switches back when collab traffic resumes ──
  let back = null;
  for (let i = 0; i < 60; i++) {
    const p = await probe();
    if (/Sub-agents working/.test(p.label || '')) { back = p; break; }
    await sleep(300);
  }
  check('…and switches BACK when the next collab record lands', !!back && /Sub-agents working — 5 sub-agent events this turn/.test(back.label || ''), JSON.stringify(back));

  // ── ⑧ r2 BLOCKER: the Stop button must SURVIVE the ticking label ─────────
  // The label changes every second (the age), so the old "unchanged label"
  // memo could never fire: showTyping rewrote .chat-stream-status innerHTML and
  // rebuilt `.chat-interrupt-btn` once a second. A mousedown whose target is
  // removed before mouseup fires `click` on the common ancestor — which has no
  // handler — so the interrupt is lost with no toast and no log (measured 6/10
  // trusted clicks delivered), and keyboard focus on Stop died within 1.4s.
  // This is the exact moment the readout exists for: the user believes the turn
  // is wedged and reaches for Stop.
  console.log('— ⑧ the Stop button survives the ticking label (node identity + ten TRUSTED clicks)');
  const btnWatch = await evaljs(`(async () => {
    const v = window.__live;
    const status = v._container.querySelector('.chat-stream-status');
    const btn0 = status.querySelector('.chat-interrupt-btn');
    if (!btn0) return { ok: false, why: 'no Stop button on the line', html: status.innerHTML.slice(0, 200) };
    btn0.__r2 = 'mark';
    btn0.focus();
    const same = [], labels = [];
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1100));
      const b = status.querySelector('.chat-interrupt-btn');
      same.push(!!b && b === btn0 && b.__r2 === 'mark');
      // read the WHOLE line minus the button, so this leg measures the age on
      // either shape (a suite that can only read the fixed DOM proves nothing)
      labels.push((status.textContent || '').replace(/\\s*■\\s*Stop\\s*$/, '').trim());
    }
    return { ok: true, same, labels, focused: document.activeElement === btn0 };
  })()`);
  check('the age advanced across the sampled ticks (the label really is being repainted)',
    !!btnWatch?.ok && /Sub-agents working/.test(btnWatch.labels[0] || '') && btnWatch.labels[0] !== btnWatch.labels[btnWatch.labels.length - 1],
    JSON.stringify(btnWatch));
  check('…and the .chat-interrupt-btn NODE is unchanged across every tick (a text change never rebuilds the button)',
    !!btnWatch?.ok && btnWatch.same.length === 4 && btnWatch.same.every(Boolean), JSON.stringify(btnWatch?.same));
  check('…so keyboard focus on Stop survives the ticks (it used to be destroyed once a second)',
    btnWatch?.focused === true, JSON.stringify(btnWatch?.focused));
  await evaljs(`(() => { window.__stops = 0; window.__live._chatInput._onInterrupt = () => { window.__stops++; }; return true; })()`);
  // 2.369.55 made Stop single-flight: the first click disables the button
  // ("Stopping…") until the turn ends or the 8 s fallback. That is correct and
  // is pinned by test-queue-steer; THIS leg measures a different thing — that
  // the ticking label never destroys the button between two legitimate clicks
  // — so each iteration first ends the pending state the way a turn boundary
  // would (_endStopPending repaints the SAME live line), then clicks again.
  let pendingAfterFirst = null;
  for (let i = 0; i < 10; i++) {
    if (i === 1) pendingAfterFirst = await evaljs(`(() => { const b = window.__live._container.querySelector('.chat-stream-status .chat-interrupt-btn'); return b ? { disabled: b.disabled, text: b.textContent } : null; })()`);
    if (i > 0) await evaljs(`(() => { window.__live._chatInput._endStopPending?.(); return true; })()`);
    // re-read the rect every time: the button sits AFTER the label, so it
    // shifts a few px as the age grows — a cached centre would start missing it
    const r = await evaljs(`(() => { const b = window.__live._container.querySelector('.chat-stream-status .chat-interrupt-btn'); if (!b) return null; const q = b.getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) }; })()`);
    if (!r) break;
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(280);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(120);
  }
  const stops = await evaljs('window.__stops');
  check('all ten TRUSTED Stop clicks reached the handler while the label ticked (a swallowed interrupt is a silent failure)',
    stops === 10, `${stops}/10 delivered`);
  check('…and the first click left the button in the 2.369.55 pending state (disabled, "Stopping…") — single-flight, not a rebuilt button',
    pendingAfterFirst?.disabled === true && /Stopping/.test(pendingAfterFirst?.text || ''), JSON.stringify(pendingAfterFirst));

  // ── turn end: everything FREEZES to the absolute span ──
  let frozen = null;
  for (let i = 0; i < 160; i++) {
    const p = await probe();
    if (p.label === null && p.head && /over /.test(p.head)) { frozen = p; break; }
    await sleep(300);
  }
  // the head belongs to the FIRST coalesced card (4 events): the exec card in
  // between ended that card's coalescing, so the 5th row opened a new one —
  // which is exactly the "card stops growing ⇒ freeze" rule
  check('turn end freezes the head to the absolute span and stops the ticker',
    !!frozen && /^Sub-agent traffic · 4 sub-agent events · 2 agents · over \d+ s$/.test(frozen.head || '') && frozen.ticking === false && frozen.liveId === null,
    JSON.stringify(frozen));
  check('…and the run header froze with it (no live age left anywhere)', !!frozen && !/last \d+[sm] ago/.test(frozen.header || ''), frozen?.header);
  const still = await (async () => { await sleep(2600); return probe(); })();
  check('…and nothing moves afterwards (a finished turn must not read as progress)', still.head === frozen?.head, `${frozen?.head} → ${still.head}`);


  // ── ⑨ r2 MAJOR: a burst that starts AND ends while the window is HIDDEN ──
  // (the owner's own workflow: start an orchestration, switch desktop, come
  // back). _tickCollab is a no-op while suspended, so the ticker never paints —
  // but the RENDERER still paints every coalescing edit live. A freeze that
  // depended on the ticker having painted left the card reading "last 0s ago"
  // on a turn that ended minutes ago, contradicting the run header next to it.
  console.log('— ⑨ a burst that runs entirely on a hidden window still freezes');
  // Wait for a genuinely IDLE session first — the wrapper opens a bookkeeping
  // nudge turn of its own at every turn end, and firing into it would have this
  // leg sampling someone else's turn.
  for (let i = 0; i < 60; i++) { if (await evaljs('!window.__live._typingSince') === true) break; await sleep(300); }
  // The sampler is installed BEFORE the turn is fired: a loop started after the
  // send races the burst (the first version of this leg did exactly that and
  // read only the finished state — a negative control that proved nothing).
  await evaljs(`(() => {
    const v = window.__live, list = window.__liveList;
    v.setSuspended(true);
    window.__trail = []; window.__sawLive = false; window.__t0 = Date.now();
    window.__sampler = setInterval(() => {
      const h = [...list.querySelectorAll('.chat-collab-head')];
      const own = h.filter((e) => /3 agents/.test(e.textContent));      // THIS leg's card (the burst has three agents)
      const txt = own.length ? own[own.length - 1].textContent : '';
      if (/last \\d+[sm] ago/.test(txt)) window.__sawLive = true;
      const stamp = txt + ' |ts=' + (!!v._typingSince) + '|+' + (Date.now() - window.__t0) + 'ms';
      if (window.__trail[window.__trail.length - 1] !== stamp) window.__trail.push(stamp);
    }, 120);
    return v._suspended;
  })()`);
  liveWs.send(JSON.stringify({ type: 'chat-input', sessionId: sid, text: 'second orchestration', msgId: 'live-m2' }));
  let hidden = null;
  for (let i = 0; i < 100; i++) {
    hidden = await evaljs(`(() => {
      const v = window.__live, list = window.__liveList;
      const own = [...list.querySelectorAll('.chat-collab-head')].filter((e) => /3 agents/.test(e.textContent));
      return {
        suspended: v._suspended, found: own.length, streaming: !!v._typingSince, ticked: !!v._collabTimer,
        sawLive: window.__sawLive, trail: window.__trail.slice(0, 3).concat(window.__trail.slice(-2)),
        last: own.length ? own[own.length - 1].textContent : null,
      };
    })()`);
    if (hidden?.found && hidden.streaming === false && hidden.sawLive) break;
    await sleep(250);
  }
  await evaljs('clearInterval(window.__sampler), 1');
  check('the second burst ran and its turn ENDED while the window was hidden, and the card WAS painted live meanwhile (the ticker never ran)',
    hidden?.suspended === true && hidden?.found === 1 && hidden?.streaming === false && hidden?.sawLive === true && hidden?.ticked === false,
    JSON.stringify(hidden));
  check('…and it FROZE anyway: the absolute span, never a live age left on a finished turn',
    /^Sub-agent traffic · 4 messages · 3 agents · over \d+ s$/.test(hidden?.last || ''), JSON.stringify(hidden?.last));
  const resumed = await evaljs(`(async () => {
    window.__live.setSuspended(false);
    await new Promise((r) => setTimeout(r, 1400));
    const own = [...window.__liveList.querySelectorAll('.chat-collab-head')].filter((e) => /3 agents/.test(e.textContent));
    return { last: own.length ? own[own.length - 1].textContent : null, ticking: !!window.__live._collabTimer };
  })()`);
  check('…and it is still frozen after the desktop comes back (no ticker re-armed on a finished turn)',
    /over \d+ s$/.test(resumed?.last || '') && resumed?.ticking === false, JSON.stringify(resumed));

  liveWs.send(JSON.stringify({ type: 'kill', sessionId: sid }));
  await sleep(500);
}

console.log(failed ? `\n${failed} FAILED (${passed} passed)` : `\nALL PASS (${passed})`);
process.exit(failed ? 1 : 0);
