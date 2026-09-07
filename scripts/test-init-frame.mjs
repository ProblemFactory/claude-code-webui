#!/usr/bin/env node
// THE claude INIT FRAME, WIDENED + `commands_changed` (design-harness-features
// §2.6). Before this, `_processSystem` kept three fields of the frame (model /
// permissionMode / slash_commands) and dropped the rest — so:
//   · a FAILED MCP server was invisible (its tools simply did not exist, and
//     nothing said why; this instance's own live sessions carry such servers),
//   · terminal-bound commands (/doctor, /color) sat in the chat composer's
//     completion doing nothing when picked,
//   · agent-memory classification ran on a HARDCODED regex while the frame
//     names the directories (upstream's stated reason for the field),
//   · a mid-session `commands_changed` push was dropped entirely, so the
//     command list went stale for the rest of the session.
//
// Part 1 (node): the SCHEMA PIN (every field name we read is re-grepped out of
//   the installed 2.1.257 binary's own zod schema — dumped, never guessed;
//   explicit SKIP with evidence when no binary is installed), the normalizer
//   over the real fixture frame (ops, REPLACE semantics, the absent-not-empty
//   degradation, one card per DISTINCT frame), the pure client rules
//   (completion filter / health strip / memory paths) and the chatStatus
//   attach twin.
// Part 2 (headless chrome, SKIPs without chrome): the real ChatRenderers in a
//   real document — the health strip is in the ALWAYS-VISIBLE summary, the
//   inventory is behind the <details>, the REAL codex/ACP frame-less records
//   render NOTHING, 33 identical spawns draw ONE card, the memory-dir ordering
//   is proven both ways, and the 375×667 measurement (nothing overflows).
//
// ROUND 2 (an adversarial verifier reproduced three defects — all confirmed
// against real data before being fixed):
//   ① "the card renders only when the frame widened" was a false description
//      of a gate that every claude init passes (`tools` etc. are REQUIRED in
//      the schema), and the round-1 negative control used a 3-key synthetic
//      record no CLI has ever emitted. Measured over this instance's own
//      data/session-buffers: 62/62 init records drew a card AND a warning
//      strip; one conversation held 33 of them. Fixed by stating the gate
//      honestly, marking repeats in the normalizer, and controlling against
//      the REAL frame-less producers (codex + ACP).
//   ② loadHistory applied the frame's memory dirs AFTER rendering the slab
//      they classify (§4/§5 legs below).
//   ③ the per-message fork HANDLER still gated on a backend id while its
//      button had moved to caps (§5 leg + test-harness-contract SITES).
// Run: node scripts/test-init-frame.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0, skipped = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e !== undefined ? '\n    ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 500) : '')); } };
const skip = (n, why) => { skipped++; console.log(`  SKIP ${n} — ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FRAME = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/fixtures/claude-init-frame.json'), 'utf8'));
const { MessageManager, initFrameFacts, commandNames } = require(path.join(REPO, 'src/message-manager.js'));
const AM = await import(path.join(REPO, 'src/lib/agent-meta.js'));

// ── 1. SCHEMA PIN: the field names come from the binary, not from us ────────
console.log('— schema pin (2.1.257 zod, dumped)');
const CONSUMED = ['tools', 'mcp_servers', 'agents', 'skills', 'plugins', 'plugin_errors', 'plugin_warnings',
  'mcp_server_errors', 'terminal_slash_commands', 'output_style', 'memory_paths', 'betas', 'claude_code_version', 'slash_commands'];
let claudeBin = null;
try { claudeBin = fs.realpathSync(execFileSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim()); } catch { }
// A bounded window after a literal marker inside the (215MB, single-line)
// binary. `grep -o '<marker>.\{0,9000\}'` needs half a minute on a line that
// long — a streaming indexOf is ~200ms and is exactly as literal.
// `marker` is a literal string OR a RegExp (the minifier renames the zod
// helpers between builds — 2.1.257 spells the init variant `subtype:I("init")`
// and 2.1.238 `subtype:kt("init")` — so a cross-version pin cannot be literal).
const binWindow = (file, marker, len) => {
  const fd = fs.openSync(file, 'r');
  const isRe = marker instanceof RegExp;
  try {
    const CH = 8 << 20, buf = Buffer.alloc(CH);
    let carry = '', out = null, pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CH, pos);
      if (!n) break;
      pos += n;
      const chunk = carry + buf.toString('latin1', 0, n);
      if (out !== null) out += chunk;
      else if (isRe) { const m = marker.exec(chunk); if (m) out = chunk.slice(m.index); }
      else { const i = chunk.indexOf(marker); if (i >= 0) out = chunk.slice(i); }
      if (out !== null && out.length >= len) break;
      carry = chunk.slice(-(isRe ? 256 : Math.max(marker.length, 64)));
    }
    return out ? out.slice(0, len) : '';
  } finally { fs.closeSync(fd); }
};
const INIT_SCHEMA_RE = /subtype:\w+\("init"\),agents:/;

// Read ONE field's declaration out of a zod object literal: from `<name>:` to
// the matching TOP-LEVEL comma, tracking (), [], {} and string literals (the
// `.describe(...)` payloads are full of commas, parens and escaped quotes).
// Returns null when the field is not in the window at all.
function zodField(win, name) {
  const at = win.indexOf(name + ':');
  if (at < 0) return null;
  let i = at + name.length + 1, depth = 0, q = null;
  for (; i < win.length; i++) {
    const c = win[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) break;
  }
  return win.slice(at + name.length + 1, i);
}
// Optional for THIS field, not for something nested inside it: `plugins` is
// `T(c({… source:i().optional() …}))` — a plain regex reads the inner row's
// modifier and calls the required field optional. So only a `.optional()` at
// nesting depth 0 of the declaration counts.
const zodOptional = (win, name) => {
  const d = zodField(win, name);
  if (d === null) return null;
  let depth = 0, q = null;
  for (let i = 0; i < d.length; i++) {
    const c = d[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (depth === 0 && c === '.' && (d.startsWith('.optional()', i) || d.startsWith('.nullish()', i))) return true;
  }
  return false;
};
if (!claudeBin || !fs.existsSync(claudeBin)) {
  skip('every consumed init field exists in the CLI\'s own schema', 'no claude binary on this box (the fixture keys stand unverified here — a box with the CLI re-greps them)');
} else {
  const win = binWindow(claudeBin, 'subtype:I("init"),agents', 9000);
  if (!win) {
    skip('every consumed init field exists in the CLI\'s own schema', `the init schema window was not found in ${claudeBin} (upstream reshaped it — re-dump before trusting the reader)`);
  } else {
    const missing = CONSUMED.filter((f) => !win.includes(f + ':'));
    ok(`every consumed init field is in the installed CLI's zod schema (${path.basename(claudeBin)})`, missing.length === 0, missing.join(', '));
    ok('…the fixture invents no field the schema does not declare', Object.keys(FRAME).filter((k) => !k.startsWith('_') && !['type', 'subtype', 'uuid', 'session_id'].includes(k)).every((k) => win.includes(k + ':')),
      Object.keys(FRAME).filter((k) => !k.startsWith('_') && !win.includes(k + ':')).join(', '));
    ok('…NEGATIVE CONTROL: an invented field name is NOT in the schema window', !win.includes('memory_dirs:') && !win.includes('mcp_status:'));
    ok('…`terminal_slash_commands` carries upstream\'s own "Phone/remote UIs should hide these" reason (that is WHY we filter)', /Phone\/remote UIs should hide these/.test(win));
    ok('…`memory_paths` carries upstream\'s own "classify Read/Write/Edit tool calls on these paths as memory operations" reason', /classify Read\/Write\/Edit tool calls on these paths as memory operations/.test(win));
  }
  const cc = binWindow(claudeBin, 'commands_changed"),commands:', 600);
  ok('`commands_changed` is a full-list REPLACE push in the CLI\'s own words ("Clients should REPLACE their cached command list")', /REPLACE their cached command list/.test(cc), cc.slice(0, 200));
}

// ── 1b. WHICH KEYS ARE REQUIRED — the fact that makes "the card renders only
// when the frame widened" a FALSE description of the gate (round 2). If the
// widened keys were optional, their presence would be evidence that this CLI
// is new; they are not, so every claude init frame carries them and every
// claude init renders a card. Measured over EVERY installed version, not just
// the one on PATH — the claim under test is about old CLIs.
console.log('— required vs optional (the gate is not a version test)');
{
  const REQUIRED = ['tools', 'mcp_servers', 'skills', 'plugins', 'output_style', 'claude_code_version', 'model', 'permissionMode', 'slash_commands', 'cwd'];
  const OPTIONAL = ['agents', 'betas', 'terminal_slash_commands', 'plugin_errors', 'plugin_warnings', 'mcp_server_errors', 'memory_paths'];
  const versionsDir = path.join(os.homedir(), '.local/share/claude/versions');
  let bins = [];
  try { bins = fs.readdirSync(versionsDir).map((v) => path.join(versionsDir, v)).filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }); } catch { }
  if (claudeBin && fs.existsSync(claudeBin) && !bins.includes(claudeBin)) bins.push(claudeBin);
  if (!bins.length) {
    skip('the widened init keys are REQUIRED in every installed CLI', 'no claude binaries on this box (~/.local/share/claude/versions is absent) — the required/optional split stands unverified here');
  } else {
    const rows = [];
    for (const bin of bins) {
      const win = binWindow(bin, INIT_SCHEMA_RE, 9000);
      if (!win) { rows.push([path.basename(bin), null]); continue; }
      rows.push([path.basename(bin), {
        req: REQUIRED.filter((f) => zodOptional(win, f) === false),
        wrongReq: REQUIRED.filter((f) => zodOptional(win, f) !== false),
        opt: OPTIONAL.filter((f) => zodOptional(win, f) === true),
        wrongOpt: OPTIONAL.filter((f) => zodOptional(win, f) !== true),
      }]);
    }
    const seen = rows.filter((r) => r[1]);
    if (!seen.length) skip('the widened init keys are REQUIRED in every installed CLI', `no init schema window in ${rows.map((r) => r[0]).join(', ')} (upstream reshaped it — re-dump)`);
    else {
      ok(`tools/mcp_servers/skills/plugins/output_style/claude_code_version are NON-optional in every installed CLI (${seen.map((r) => r[0]).join(', ')}) — so "carries a widened key" is NOT evidence of a new CLI`,
        seen.every((r) => r[1].wrongReq.length === 0), seen.map((r) => `${r[0]}: ${r[1].wrongReq.join(',')}`).join(' | '));
      ok('…NEGATIVE CONTROL for the reader itself: agents/betas/terminal_slash_commands/plugin_errors/plugin_warnings/mcp_server_errors/memory_paths ARE `.optional()` (a checker that answered "required" for everything would fail here)',
        seen.every((r) => r[1].wrongOpt.length === 0), seen.map((r) => `${r[0]}: ${r[1].wrongOpt.join(',')}`).join(' | '));
      ok('…and a field the schema does not declare reads as ABSENT, not as required', zodOptional(binWindow(seen.length ? bins[0] : claudeBin, INIT_SCHEMA_RE, 9000), 'memory_dirs') === null);
      // The consequence, measured on the pure predicate the card gates on: a
      // frame built from ONLY the required keys already renders.
      const requiredOnly = { type: 'system', subtype: 'init', model: 'claude-opus-4', permissionMode: 'default', cwd: '/w', tools: ['Bash', 'Read'], mcp_servers: [{ name: 'a', status: 'connected' }], slash_commands: ['compact'], output_style: 'default', skills: [], plugins: [], claude_code_version: '2.1.238', apiKeySource: 'none', uuid: 'u-req', session_id: 's' };
      const rf = initFrameFacts(requiredOnly);
      ok('…so the card\'s own facts are present on a frame with NOTHING optional set (this is why the gate is documented as "has facts to show", never as "the CLI widened")',
        !!(rf.tools?.length && rf.mcpServers?.length && rf.version) && !('agents' in rf) && !('memoryPaths' in rf), JSON.stringify(rf).slice(0, 200));
    }
  }
}

// ── 2. the normalizer over the REAL frame ──────────────────────────────────
console.log('— normalizer');
const runLive = (records) => {
  const mm = new MessageManager('sess-init');
  const ops = [];
  mm.onOp((op) => ops.push(op));
  for (const r of records) mm.processLive(r);
  return { mm, ops };
};
{
  const { mm, ops } = runLive([FRAME]);
  const init = ops.find((o) => o.op === 'create')?.message;
  const f = init?.content?.[0]?.initData?.frame;
  ok('the init frame still creates exactly one card + keeps the three old fields', ops.filter((o) => o.op === 'create').length === 1
    && init.content[0].initData.model === 'claude-fable-5' && init.content[0].initData.permissionMode === 'default'
    && init.content[0].initData.slashCommands.join(',') === FRAME.slash_commands.join(','), JSON.stringify(init?.content?.[0]?.initData || null).slice(0, 200));
  ok('…and now the WHOLE frame: tools/agents/skills/plugins/mcp servers/errors/output style/version/betas/memory paths/terminal commands', !!f
    && f.tools.length === FRAME.tools.length && f.agents.length === 3 && f.skills.length === 3
    && f.plugins[0].name === 'commit-commands' && f.plugins[0].version === '1.2.0'
    && f.mcpServers.length === 3 && f.mcpServers[1].status === 'failed'
    && f.pluginErrors[0].plugin === 'old-helper' && f.mcpServerErrors[0].name === 'notes' && f.pluginWarnings[0].plugin === 'commit-commands'
    && f.outputStyle === 'Explanatory' && f.version === '2.1.257' && f.betas[0] === 'context-1m'
    && f.memoryPaths.auto.endsWith('/memory') && f.memoryPaths.team.endsWith('/team-memory')
    && f.terminalSlashCommands.join(',') === 'doctor,color', JSON.stringify(f).slice(0, 400));
  const meta = ops.filter((o) => o.op === 'meta' && o.subtype === 'slash-commands');
  ok('…the command list rides ONE meta op (the shape a mid-session push reuses), carrying the terminal subset', meta.length === 1
    && meta[0].data.commands.join(',') === FRAME.slash_commands.join(',') && meta[0].data.terminal.join(',') === 'doctor,color', JSON.stringify(meta[0]?.data));
  ok('…the card itself is unchanged for consumers that only read text/id (no id churn, status complete)', init.role === 'system' && init.status === 'complete' && init.content[0].text === 'Model: claude-fable-5');
  ok('history rebuild (convertHistory) keeps the same widened frame — the buffer replay a restarted window reads', (() => {
    const msgs = new MessageManager('sess-init').convertHistory([FRAME]);
    return msgs[0]?.content?.[0]?.initData?.frame?.mcpServers?.[1]?.status === 'failed';
  })());
}
{
  // ABSENT ≠ EMPTY — a PROPERTY of initFrameFacts over a record that omits the
  // keys, NOT a claim about any shipped CLI: the required/optional pin above
  // measured that no installed claude omits the widened ones (round 2 — the
  // round-1 wording called this "an old CLI" and that was never verified).
  const old = { type: 'system', subtype: 'init', model: 'claude-opus-4', permissionMode: 'default', slash_commands: ['compact'], session_id: 's', uuid: 'u-old' };
  const { ops } = runLive([old]);
  const f = ops[0].message.content[0].initData.frame;
  ok('DEGRADE: a record that omits the widened keys yields only what it said (slashCommands) — absent keys stay ABSENT, never empty arrays that would read as "zero skills"',
    Object.keys(f).join(',') === 'slashCommands' && !('skills' in f) && !('mcpServers' in f) && !('memoryPaths' in f), JSON.stringify(f));
  ok('…and its command list still reaches the composer, with an EMPTY terminal subset (filters nothing)',
    ops.some((o) => o.op === 'meta' && o.subtype === 'slash-commands' && o.data.commands.join() === 'compact' && o.data.terminal.length === 0));
}
{
  // commands_changed: REPLACE, not append.
  const changed = {
    type: 'system', subtype: 'commands_changed', session_id: 's', uuid: 'u-cc',
    commands: [
      { name: 'compact', description: 'compact the conversation', argumentHint: '' },
      { name: 'doctor', description: 'diagnose', argumentHint: '' },
      { name: 'skill-just-discovered', description: 'new', argumentHint: '<file>', aliases: ['sjd'] },
    ],
  };
  const { mm, ops } = runLive([FRAME, changed]);
  const metas = ops.filter((o) => o.op === 'meta' && o.subtype === 'slash-commands');
  ok('a mid-session commands_changed emits a SECOND command-list op…', metas.length === 2);
  ok('…whose list REPLACES wholesale: the new command is in, and every command the push omitted is GONE (an append would keep them)',
    metas[1].data.commands.join(',') === 'compact,doctor,skill-just-discovered'
    && !metas[1].data.commands.includes('model') && !metas[1].data.commands.includes('usage'), JSON.stringify(metas[1].data));
  ok('…the terminal subset survives (the push does not re-send it) but is INTERSECTED with the new list — "color" is gone upstream, so it is gone here',
    metas[1].data.terminal.join(',') === 'doctor', JSON.stringify(metas[1].data.terminal));
  ok('…and the init CARD is patched in place, so a window that rebuilds history sees the current list',
    ops.some((o) => o.op === 'edit') && mm.messages[0].content[0].initData.slashCommands.includes('skill-just-discovered'));
  ok('rich rows are read by NAME (the payload is {name,description,argumentHint,aliases?}, not strings like init\'s slash_commands)',
    commandNames(changed.commands).join(',') === 'compact,doctor,skill-just-discovered');
  ok('…a bare-string payload is still read (a producer that ever sends strings is not dropped), and a payload with NO array does nothing',
    commandNames(['a', 'b']).join(',') === 'a,b' && commandNames(undefined) === null && commandNames({}) === null);
  ok('an EMPTY commands array is a real answer (every command gone), not "say nothing"', (() => {
    const r = runLive([FRAME, { ...changed, commands: [] }]);
    const m = r.ops.filter((o) => o.op === 'meta' && o.subtype === 'slash-commands');
    return m.length === 2 && m[1].data.commands.length === 0;
  })());
}
{
  // The breadcrumb must NOT fire for a subtype we now handle (2.227.5 rule).
  const prev = global.__vsEvent; const seen = [];
  global.__vsEvent = (k, d) => seen.push([k, d]);
  MessageManager._seenUnknownSubtypes?.clear?.();
  runLive([FRAME, { type: 'system', subtype: 'commands_changed', commands: [{ name: 'x' }], uuid: 'u1' }, { type: 'system', subtype: 'brand_new_thing', uuid: 'u2' }]);
  global.__vsEvent = prev;
  ok('commands_changed is a HANDLED subtype (no unknown-subtype breadcrumb), while a genuinely new subtype still trips it',
    !seen.some(([k, d]) => k === 'cli-unknown-system-subtype' && d === 'commands_changed')
    && seen.some(([k, d]) => k === 'cli-unknown-system-subtype' && d === 'brand_new_thing'), JSON.stringify(seen));
}

// ── 2b. ONE CARD PER DISTINCT FRAME (round 2) ──────────────────────────────
// The measurement that forced this, taken on this instance's own
// data/session-buffers (a ROTATING window — these are snapshots, and the
// verifier independently measured the same 05:34 one):
//   2026-09-07 05:34 — 62 `system`/`init` records in 13 conversations, 62 of
//     them carrying a health issue, 33 byte-identical ones in ONE conversation;
//   2026-09-07 05:40 (after the ring buffers rotated) — 30 records, 14 distinct
//     frames, 30 with issues, 6 max in one conversation.
// Both agree on the shape: 2x-33x redundancy at a 100% warned rate, every one
// of which passed the round-1 gate and drew a card AND a warning strip. The
// normalizer now states the fact (`frameRepeat`); the renderer draws nothing
// for a repeat.
console.log('— one card per DISTINCT frame');
{
  const spawn = (n) => ({ ...FRAME, uuid: 'u-init-' + n, session_id: 's-' + n });
  const { ops } = runLive(Array.from({ length: 33 }, (_, i) => spawn(i)));
  const inits = ops.filter((o) => o.op === 'create').map((o) => o.message.content[0].initData);
  ok('33 identical init records (the maximum observed in one real buffer here) create 33 records but only ONE non-repeat frame',
    inits.length === 33 && inits.filter((d) => !d.frameRepeat).length === 1 && inits[0].frameRepeat === false, `${inits.length} inits, ${inits.filter((d) => !d.frameRepeat).length} non-repeat`);
  ok('…and every repeat still carries the WHOLE frame + the per-spawn side-effect facts (the card is suppressed, the facts are not)',
    inits.at(-1).frameRepeat === true && inits.at(-1).frame.mcpServers[1].status === 'failed' && inits.at(-1).model === FRAME.model && inits.at(-1).slashCommands.length === FRAME.slash_commands.length);
}
{
  // NEGATIVE CONTROL for the dedup: a frame that CHANGED is never a repeat.
  const healthy = { ...FRAME, uuid: 'u-b', mcp_servers: [{ name: 'github', status: 'connected' }, { name: 'drive', status: 'connected' }, { name: 'fs', status: 'connected' }] };
  const { ops } = runLive([FRAME, { ...FRAME, uuid: 'u-a2' }, healthy, { ...FRAME, uuid: 'u-c' }]);
  const flags = ops.filter((o) => o.op === 'create').map((o) => o.message.content[0].initData.frameRepeat);
  ok('a frame that CHANGED always draws — failed→connected is one card, and going back to the earlier state is another (the comparison is with the PREVIOUS init, never with any earlier one)',
    flags.join(',') === 'false,true,false,false', flags.join(','));
}
{
  // The trap this was written against: `commands_changed` patches
  // `_initFrame.slashCommands` IN PLACE. If the fingerprint were read off that
  // object instead of snapshotted at init time, the next identical init would
  // read as "changed" and the dedup would silently stop working.
  const changed = { type: 'system', subtype: 'commands_changed', uuid: 'u-cc2', commands: [{ name: 'compact' }] };
  const { ops } = runLive([FRAME, changed, { ...FRAME, uuid: 'u-again' }]);
  const flags = ops.filter((o) => o.op === 'create').map((o) => o.message.content[0].initData.frameRepeat);
  ok('a commands_changed BETWEEN two identical inits does not fake a change (the fingerprint is snapshotted at init, before the in-place patch)', flags.join(',') === 'false,true', flags.join(','));
}
{
  // Rebuild parity: a restarted window replays the same buffer and must land
  // on the same cards — a per-instance flag that only existed on the live path
  // would make history and live disagree.
  const recs = [FRAME, { ...FRAME, uuid: 'u-r2' }, { ...FRAME, uuid: 'u-r3' }];
  const live = runLive(recs).ops.filter((o) => o.op === 'create').map((o) => o.message.content[0].initData.frameRepeat);
  const rebuilt = new MessageManager('sess-rb').convertHistory(recs).filter((m) => m.content[0]?.initData).map((m) => m.content[0].initData.frameRepeat);
  ok('history rebuild marks the SAME repeats as the live stream (same records, same cards)', live.join(',') === rebuilt.join(',') && rebuilt.join(',') === 'false,true,true', `${live.join(',')} vs ${rebuilt.join(',')}`);
}

// ── 3. the pure client rules ───────────────────────────────────────────────
console.log('— pure client rules');
{
  const f = initFrameFacts(FRAME);
  const list = AM.slashCompletionList(f.slashCommands, f.terminalSlashCommands);
  ok('terminal-bound commands are FILTERED OUT of the composer completion (/doctor, /color are terminal UX — upstream says hide them)',
    !list.includes('/doctor') && !list.includes('/color') && list.includes('/compact') && list.includes('/model') && list.length === FRAME.slash_commands.length - 2, list.join(' '));
  ok('…every entry carries its slash exactly once, whichever spelling the caller passes',
    AM.slashCompletionList(['/compact', 'model'], []).join(',') === '/compact,/model');
  ok('…NEGATIVE CONTROL: with no terminal subset (old CLI / codex / ACP) nothing is filtered',
    AM.slashCompletionList(f.slashCommands, null).length === FRAME.slash_commands.length && AM.slashCompletionList(f.slashCommands, []).includes('/doctor'));

  const issues = AM.initHealthIssues(f);
  ok('the health strip names every server that is NOT connected, plus skipped configs and demoted plugins (3 here: failed + needs-auth + a config error + a plugin error)',
    issues.length === 4 && issues.filter((i) => i.kind === 'mcp-server').map((i) => `${i.name}/${i.detail}`).join(',') === 'github/failed,drive/needs-auth'
    && issues.some((i) => i.kind === 'mcp-config' && i.name === 'notes') && issues.some((i) => i.kind === 'plugin' && i.name === 'old-helper'), JSON.stringify(issues));
  ok('…the status vocabulary is OPEN: an unknown status is reported verbatim, never mapped away',
    AM.initHealthIssues({ mcpServers: [{ name: 'x', status: 'reconnecting-v2' }] })[0]?.detail === 'reconnecting-v2');
  ok('…NEGATIVE CONTROL: an all-connected frame with no error keys has NOTHING to report (and we never claim "all healthy" — an absent key is not a clean load)',
    AM.initHealthIssues({ mcpServers: [{ name: 'a', status: 'connected' }], skills: ['s'] }).length === 0 && AM.initHealthIssues(null).length === 0);

  AM._resetMemoryPaths();
  const custom = '/w/store/agent-memory/NOTES.md';
  ok('memory classification BEFORE the frame speaks: the hardcoded regex only (today\'s behaviour)',
    AM.isAgentMemoryPath('/h/.claude/projects/p/memory/M.md') && !AM.isAgentMemoryPath(custom));
  AM.noteMemoryPaths({ auto: '/w/store/agent-memory', team: '/w/proj/.claude/team-memory' });
  ok('…AFTER it: a directory the CLI NAMED classifies as memory (the regex could never know it), and the regex still covers the default dirs',
    AM.isAgentMemoryPath(custom) && AM.isAgentMemoryPath('/w/proj/.claude/team-memory/T.md') && AM.isAgentMemoryPath('/h/.claude/projects/p/memory/M.md'));
  ok('…a declared dir matches as a PATH PREFIX, not a string prefix (…/agent-memory must not swallow …/agent-memory-backup)',
    !AM.isAgentMemoryPath('/w/store/agent-memory-backup/N.md') && AM.isAgentMemoryPath('/w/store/agent-memory/sub/N.md'));
  AM._resetMemoryPaths();
}

// ── 4. the attach/HTTP twin (session-store chatStatus) ─────────────────────
console.log('— chatStatus twin (attach path)');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-initframe-'));
  const cwd = path.join(tmp, 'proj');
  const sid = '11111111-2222-4333-8444-555555555555';
  const proj = path.join(tmp, '.claude', 'projects', cwd.replace(/[/._]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', timestamp: ts }),
    JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 5, output_tokens: 2 } }, uuid: 'u2', timestamp: ts }),
  ].join('\n') + '\n');
  const prevHome = process.env.HOME;
  process.env.HOME = tmp;
  const { SessionMessages } = require(path.join(REPO, 'src/session-store.js'));
  // init + a later commands_changed, as they really arrive: stdout-only
  // records in the session BUFFER, never in the JSONL.
  const buffer = [JSON.stringify({ ...FRAME, session_id: sid }),
    JSON.stringify({ type: 'system', subtype: 'commands_changed', session_id: sid, uuid: 'u-cc', commands: [{ name: 'compact' }, { name: 'doctor' }, { name: 'newly-found' }] })].join('\n');
  const st = new SessionMessages({ backend: 'claude', backendSessionId: sid, claudeSessionId: sid, cwd, buffer }, null, { buffersDir: path.join(tmp, 'buf'), permissionModes: [] }).chatStatus();
  process.env.HOME = prevHome;
  ok('a window that ATTACHES (or reloads) gets the same two facts as one that watched the push live: the CURRENT list + the terminal subset',
    st && st.slashCommands.join(',') === 'compact,doctor,newly-found' && st.initFrame?.terminalSlashCommands.join(',') === 'doctor', JSON.stringify({ sc: st?.slashCommands, tf: st?.initFrame?.terminalSlashCommands }));
  ok('…and the memory dirs + health facts, so a window whose init card is outside the loaded tail still classifies memory writes and can be told what is broken',
    st.initFrame?.memoryPaths?.auto?.endsWith('/memory') && AM.initHealthIssues(st.initFrame).length === 4, JSON.stringify(st.initFrame?.memoryPaths));
  ok('…the completion the composer would build from the attach payload hides the terminal commands too (ONE rule, both paths)',
    !AM.slashCompletionList(st.slashCommands, st.initFrame.terminalSlashCommands).includes('/doctor'));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
}

// ── 5. wiring pins (the 2.331.0 lesson: a pure fix with no call site is dead) ──
console.log('— wiring pins');
{
  const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
  const cv = read('src/lib/chat-view.js'), ci = read('src/lib/chat-input.js'), cr = read('src/lib/chat-renderers.js');
  ok("ChatView routes the 'slash-commands' meta op into the composer (an `edit` on the init card can NOT do this: a complete system card is never re-rendered, so its side effects never re-run)",
    /op\.subtype === 'slash-commands'/.test(cv) && /setSlashCommands\(op\.data\?\.commands \|\| \[\], \{ terminal: op\.data\?\.terminal \|\| null \}\)/.test(cv));
  ok('…the init card\'s side effect and the attach path both pass the terminal subset',
    /setSlashCommands\(se\.slashCommands, \{ terminal: se\.terminalSlashCommands \|\| null \}\)/.test(cv) && /setSlashCommands\(status\.slashCommands, \{ terminal: status\.initFrame\?\.terminalSlashCommands \|\| null \}\)/.test(cv));
  ok('…and both feed the frame-declared memory dirs to the classifier', (cv.match(/noteMemoryPaths\(/g) || []).length >= 2);
  ok('setSlashCommands REPLACES through the ONE pure rule (no local filtering twin)', /this\._slashCommands = slashCompletionList\(cmds, terminal\);/.test(ci));
  ok('the renderer builds the card from the frame and returns it (it used to return el:null unconditionally), passing the repeat verdict through',
    /return \{ el: this\.buildInitCard\(f, \{ repeat: !!d\.frameRepeat \}\), sideEffect \};/.test(cr));
  for (const [file, what] of [['src/acp-message-manager.js', 'ACP available_commands_update'], ['src/codex-message-manager.js', 'codex wrapper_meta']]) {
    ok(`${what} emits the SAME meta op (one client path, no local/remote twin)`, /op: 'meta', subtype: 'slash-commands'/.test(read(file)));
  }

  // ORDER PIN (round 2). The frame-declared memory dirs must reach the
  // classifier BEFORE loadHistory renders the slab they classify: applyStatus
  // runs after the render loop, and a system/tool card is not re-rendered on a
  // status change, so a late noteMemoryPaths leaves every memory card in the
  // attached window rendered as an ordinary file card for the life of that
  // window. Positions, not presence — this pin fails on a HOISTED-BACK edit.
  const orderOk = (src) => {
    const loop = src.indexOf('for (const msg of messages) this._onCreateMessage(msg);');
    const hoist = src.indexOf('if (meta?.chatStatus?.initFrame?.memoryPaths) noteMemoryPaths(');
    return loop > 0 && hoist > 0 && hoist < loop;
  };
  ok('loadHistory learns the frame-declared memory dirs BEFORE it renders the history they classify', orderOk(cv));
  ok('…NEGATIVE CONTROL: the same checker FAILS on the pre-fix source (the hoist removed — proof it measures order, not presence)',
    !orderOk(cv.replace(/\n *if \(meta\?\.chatStatus\?\.initFrame\?\.memoryPaths\) noteMemoryPaths\([^\n]*\n/, '\n')));

  // §2.13: BOTH halves of forkAtMessage read the SAME row. The button lives in
  // chat-renderers, the handler in chat-view — round 1 gated only the button,
  // so the first harness to gain the row would have shown a dead control.
  const forkHandler = cv.slice(cv.indexOf('_forkFromMessage(uuid, msg) {'), cv.indexOf('_forkFromMessage(uuid, msg) {') + 600);
  ok('the per-message fork HANDLER gates on caps.forkAtMessage, like the button — no backend id left',
    /backendFeatureCaps\(backend\)\.forkAtMessage/.test(forkHandler) && !/backend !== 'claude'/.test(forkHandler), forkHandler.split('\n').slice(0, 6).join(' / '));
  ok('…and a click that cannot proceed SPEAKS (no-silent-failures) instead of returning silently', /showToast\(t\('Session id not known yet/.test(forkHandler));
  ok('…NEGATIVE CONTROL: the checker catches a planted backend-id gate', /backend !== 'claude'/.test(forkHandler + "\n if (backend !== 'claude') return;"));
}

// ── 6. the card in a REAL browser + the 375×667 measurement ────────────────
console.log('— the card in chrome');
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!CHROME) {
  skip('the init card in a real document (health strip visibility + 375×667)', 'no chrome/chromium on this box');
} else {
  const http = await import('node:http');
  const net = await import('node:net');
  const esbuild = require(path.join(REPO, 'node_modules/esbuild'));
  const WebSocket = require('ws');
  const freePort = () => new Promise((res, rej) => { const sv = net.createServer(); sv.on('error', rej); sv.listen(0, '127.0.0.1', () => { const pt = sv.address().port; sv.close(() => res(pt)); }); });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `vs-initcard-${process.pid}-`));
  const stub = { name: 'stub-build-version', setup(b) { b.onResolve({ filter: /build-version\.js$/ }, () => ({ path: 'build-version', namespace: 'bv' })); b.onLoad({ filter: /.*/, namespace: 'bv' }, () => ({ contents: "export const BUILD_VERSION = 'test';", loader: 'js' })); } };
  const entry = path.join(tmp, 'entry.js');
  fs.writeFileSync(entry, `export { ChatRenderers } from ${JSON.stringify(path.join(REPO, 'src/lib/chat-renderers.js'))};\n`
    + `export * as AM from ${JSON.stringify(path.join(REPO, 'src/lib/agent-meta.js'))};\n`);
  const bundle = path.join(tmp, 'init.iife.js');
  await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', globalName: 'VS', platform: 'browser', target: 'es2022', outfile: bundle, logLevel: 'silent', loader: { '.css': 'text' }, plugins: [stub] });
  const js = fs.readFileSync(bundle, 'utf8').replace(/<\/script/gi, '<\\/script');
  const css = fs.readFileSync(path.join(REPO, 'public/chat.css'), 'utf8').replace(/<\/style/gi, '<\\/style');
  const base = fs.readFileSync(path.join(REPO, 'public/style.css'), 'utf8').replace(/<\/style/gi, '<\\/style');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>init card</title>`
    + `<style>${base}</style><style>${css}</style>`
    + `<style>html,body{margin:0;height:100%}#host{position:fixed;inset:0;display:flex;flex-direction:column}#list{flex:1;min-height:0;overflow:auto}</style>`
    + `<body><div id="host" class="chat-view"><div id="list" class="chat-message-list"></div></div><script>${js}</script>`;
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
    for (let i = 0; i < 80; i++) { if (await evaljs('!!(window.VS && window.VS.ChatRenderers)').catch(() => false)) break; await sleep(150); }

    // The REAL renderSystemMsg path over the REAL normalizer output — not a
    // hand-built element: the card, its side effect and the frame all have to
    // survive the same trip a live session takes.
    const mkFrame = JSON.stringify(FRAME);
    const render = async (frameJson) => evaljs(`(() => {
      const list = document.getElementById('list');
      list.innerHTML = '';
      const r = new VS.ChatRenderers({ sessionId: 'view-x', backend: 'claude', messageList: list });
      const msg = ${frameJson};
      const out = r.renderSystemMsg(msg);
      if (out.el) list.appendChild(out.el);
      const card = list.querySelector('.chat-msg-init');
      const summary = card && card.querySelector('.chat-init-summary');
      const warn = card && card.querySelector('.chat-init-warn');
      const details = card && card.querySelector('.chat-init-details');
      const cs = warn ? getComputedStyle(warn) : null;
      return {
        rendered: !!card,
        sideEffect: out.sideEffect,
        summaryText: summary ? summary.textContent.replace(/\\s+/g, ' ').trim() : '',
        warnText: warn ? warn.textContent.replace(/\\s+/g, ' ').trim() : '',
        warnVisible: !!(warn && cs.display !== 'none' && cs.visibility !== 'hidden' && warn.getBoundingClientRect().width > 0),
        warnInSummary: !!(warn && summary && summary.contains(warn)),
        detailsOpen: details ? details.open : null,
        bodyText: card ? (card.querySelector('.chat-init-body')?.textContent || '').replace(/\\s+/g, ' ').trim() : '',
        bodyHeight: card && card.querySelector('.chat-init-body') ? card.querySelector('.chat-init-body').getBoundingClientRect().height : -1,
        svgInWarn: !!(warn && warn.querySelector('svg')),
        rawHtml: card ? card.innerHTML : '',
      };
    })()`);
    // a normalized message, exactly as the normalizer builds it
    const norm = (frame) => {
      const mm = new MessageManager('sess-b');
      const msgs = mm.convertHistory([frame]);
      return JSON.stringify(msgs[0]);
    };
    const r1 = await render(norm(FRAME));
    ok('the widened frame renders a card (it used to render nothing at all)', r1.rendered, JSON.stringify(r1).slice(0, 300));
    ok('the HEALTH STRIP is in the always-visible summary and VISIBLE while the card is still collapsed — a dead MCP server behind a click would not fix the invisibility this exists for',
      r1.warnInSummary && r1.warnVisible && r1.detailsOpen === false && /4/.test(r1.warnText), JSON.stringify({ warn: r1.warnText, vis: r1.warnVisible, open: r1.detailsOpen }));
    ok('…its icon is an inline SVG from icons.js (never an emoji)', r1.svgInWarn && !/[\u{1F300}-\u{1FAFF}]/u.test(r1.rawHtml));
    ok('the summary answers "what is this session" at a glance: skills count + output style', /Session start/.test(r1.summaryText) && /3 skills/.test(r1.summaryText) && /Explanatory/.test(r1.summaryText), r1.summaryText);
    ok('the collapsed body is not taking vertical space, and holds the inventory + the per-issue detail lines', r1.bodyHeight === 0
      && /github \(failed\)/.test(r1.bodyText) && /dataviz/.test(r1.bodyText) && /commit-commands 1\.2\.0/.test(r1.bodyText) && /old-helper/.test(r1.bodyText) && /2\.1\.257/.test(r1.bodyText), JSON.stringify({ h: r1.bodyHeight, t: r1.bodyText.slice(0, 200) }));
    ok('the card\'s side effect still carries model/mode/commands, plus the terminal subset and the memory dirs the client needs',
      r1.sideEffect.model === 'claude-fable-5' && r1.sideEffect.permMode === 'default'
      && r1.sideEffect.terminalSlashCommands.join(',') === 'doctor,color' && !!r1.sideEffect.memoryPaths.auto, JSON.stringify(r1.sideEffect).slice(0, 300));
    // XSS: every value from the frame is peer-controlled text (a plugin name
    // reaches every client) — it must never become markup.
    const nasty = { ...FRAME, skills: ['<img src=x onerror=window.__pwned=1>'], plugins: [{ name: '"><script>window.__pwned=1</script>', path: '/p', source: 's' }] };
    const r2 = await render(norm(nasty));
    ok('XSS: frame text is escaped, never markup (a plugin/skill name syncs to every client)',
      (await evaljs('!window.__pwned')) && !/<img src=x/.test(r2.rawHtml) && /&lt;img src=x/.test(r2.rawHtml), r2.rawHtml.slice(0, 200));

    // NEGATIVE CONTROLS — the round-1 leg used a hand-made 3-key claude record
    // that no CLI has ever emitted, so it green-lit the claim "an old claude
    // CLI renders nothing" while measuring nothing. The producers that really
    // do render nothing are codex and ACP/OpenCode, whose normalizers build
    // initData WITHOUT a frame at all — so the control is now their REAL
    // output, and the honest statement about old claude CLIs is the OPPOSITE
    // one, asserted right below on a real pre-widening keyset.
    const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
    const { AcpMessageManager } = require(path.join(REPO, 'src/acp-message-manager.js'));
    const cxOps = []; const cx = new CodexMessageManager('cx-1'); cx.onOp((o) => cxOps.push(o));
    cx.processLive({ timestamp: '2026-09-07T00:00:00.000Z', type: 'session_meta', payload: { id: '01a07386-3386-7203-adfb-7c4ba193e24d', cwd: '/w', model: 'gpt-6-astra', cli_version: '0.153.4' } });
    const cxInit = cxOps.find((o) => o.op === 'create' && o.message.content?.[0]?.initData)?.message;
    const acpOps = []; const acp = new AcpMessageManager('acp-1'); acp.onOp((o) => acpOps.push(o));
    acp.processLive({ type: 'acp', kind: 'session', sessionId: 'sess-acp', how: 'new', model: 'mock/fast', mode: 'build', agentInfo: { name: 'mock-acp' } });
    const acpInit = acpOps.find((o) => o.op === 'create' && o.message.content?.[0]?.initData)?.message;
    ok('the two REAL frame-less producers exist and were driven (codex session_meta / ACP session record)', !!cxInit && !!acpInit && !cxInit.content[0].initData.frame && !acpInit.content[0].initData.frame);
    const rCx = await render(JSON.stringify(cxInit));
    const rAcp = await render(JSON.stringify(acpInit));
    ok('NEGATIVE CONTROL: the codex and ACP/OpenCode init records — REAL normalizer output, no `frame` key — render NOTHING, yet still apply their side effects',
      rCx.rendered === false && rCx.sideEffect.model === 'gpt-6-astra' && rAcp.rendered === false && rAcp.sideEffect.model === 'mock/fast',
      JSON.stringify({ cx: rCx.rendered, cxSe: rCx.sideEffect, acp: rAcp.rendered, acpSe: rAcp.sideEffect }).slice(0, 300));

    // The claim the round-1 fixture pretended to test, stated honestly and the
    // right way round: a frame carrying ONLY the keys the schema makes
    // REQUIRED (the 2.1.238 keyset) DOES render — every installed claude CLI
    // gets a card. What it does not get, with everything healthy, is a strip.
    const preWiden = { type: 'system', subtype: 'init', model: 'claude-opus-4', permissionMode: 'default', cwd: '/w', tools: ['Bash', 'Read', 'Write'], mcp_servers: [{ name: 'a', status: 'connected' }], slash_commands: ['compact'], output_style: 'default', skills: [], plugins: [], claude_code_version: '2.1.238', apiKeySource: 'none', uuid: 'u-238', session_id: 's' };
    const r3 = await render(norm(preWiden));
    ok('a frame with ONLY the schema-REQUIRED keys (2.1.238 keyset, all healthy) renders a card and NO health strip — the gate is "has facts", not "is a new CLI"',
      r3.rendered === true && !r3.warnText && /3/.test(r3.bodyText) && r3.sideEffect.model === 'claude-opus-4', JSON.stringify({ r: r3.rendered, w: r3.warnText, b: r3.bodyText.slice(0, 120) }));

    const healthy = { ...FRAME, mcp_servers: [{ name: 'a', status: 'connected' }], plugin_errors: undefined, mcp_server_errors: undefined };
    const r4 = await render(norm(healthy));
    ok('a healthy session gets the card WITHOUT a health strip (and no "all good" claim — an absent error key is not a clean load)',
      r4.rendered && !r4.warnText, JSON.stringify({ w: r4.warnText }));

    // THE REPEAT, end to end: 33 identical spawns → ONE card in the document.
    const repeats = (() => {
      const mm = new MessageManager('sess-rep');
      const msgs = mm.convertHistory(Array.from({ length: 33 }, (_, i) => ({ ...FRAME, uuid: 'u-rep-' + i, session_id: 's-' + i })));
      return JSON.stringify(msgs.filter((m) => m.content?.[0]?.initData));
    })();
    const rRep = await evaljs(`(() => {
      const list = document.getElementById('list');
      list.innerHTML = '';
      const r = new VS.ChatRenderers({ sessionId: 'view-x', backend: 'claude', messageList: list });
      let se = 0;
      for (const msg of ${repeats}) { const out = r.renderSystemMsg(msg); if (out.el) list.appendChild(out.el); if (out.sideEffect && out.sideEffect.model) se++; }
      return { cards: list.querySelectorAll('.chat-msg-init').length, strips: list.querySelectorAll('.chat-init-warn').length, sideEffects: se };
    })()`);
    ok(`a conversation whose 33 spawns all report the SAME frame draws ONE card and ONE health strip (round 1 drew 33 of each), while all 33 side effects still apply`,
      rRep.cards === 1 && rRep.strips === 1 && rRep.sideEffects === 33, JSON.stringify(rRep));

    // MEMORY CLASSIFICATION IS ORDER-SENSITIVE (the loadHistory hoist). Same
    // card, same renderer — only "has the classifier been told yet" differs,
    // and a system card is never re-rendered, so the late answer never lands.
    const memMsgs = (() => {
      const mm = new MessageManager('sess-mem');
      const msgs = mm.convertHistory([
        { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/srv/agentmem/notes.md', content: 'remembered' } }] }, uuid: 'ua1', timestamp: '2026-09-07T00:00:00.000Z' },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] }, uuid: 'uu1', timestamp: '2026-09-07T00:00:01.000Z' },
      ]);
      return JSON.stringify(msgs.filter((m) => m.role === 'tool'));
    })();
    const rMem = await evaljs(`(() => {
      const list = document.getElementById('list');
      const draw = () => { list.innerHTML = '';
        const r = new VS.ChatRenderers({ sessionId: 'view-x', backend: 'claude', messageList: list });
        for (const m of ${memMsgs}) { const el = r.renderToolMsg(m); if (el) list.appendChild(el); }
        return (list.textContent || '').replace(/\\s+/g, ' ').trim(); };
      VS.AM._resetMemoryPaths();
      const before = draw();
      VS.AM.noteMemoryPaths({ auto: '/srv/agentmem' });
      const after = draw();
      VS.AM._resetMemoryPaths();
      return { before, after };
    })()`);
    ok('a Write into a directory only the FRAME names renders as an ordinary Write until the classifier is told, and as a Memory update once it is — which is why loadHistory must learn the dirs before it renders the slab',
      /Write/.test(rMem.before) && !/Memory update/.test(rMem.before) && /Memory update/.test(rMem.after) && /notes\.md/.test(rMem.after), JSON.stringify(rMem).slice(0, 300));

    // ── ≤768px (375×667): the standing rule ──
    await setViewport(375, 667);
    await sleep(120);
    const m = await evaljs(`(() => {
      const list = document.getElementById('list');
      list.innerHTML = '';
      const r = new VS.ChatRenderers({ sessionId: 'view-x', backend: 'claude', messageList: list });
      const out = r.renderSystemMsg(${norm(FRAME)});
      list.appendChild(out.el);
      const card = list.querySelector('.chat-msg-init');
      const summary = card.querySelector('.chat-init-summary');
      const warn = card.querySelector('.chat-init-warn');
      const details = card.querySelector('.chat-init-details');
      const before = { cardW: card.getBoundingClientRect().width, sumRight: summary.getBoundingClientRect().right, warnRight: warn.getBoundingClientRect().right,
        listScrollW: list.scrollWidth, listClientW: list.clientWidth, sumH: summary.getBoundingClientRect().height,
        sumWrap: getComputedStyle(summary).flexWrap, sumScrollW: summary.scrollWidth, sumClientW: summary.clientWidth };
      details.open = true;
      const body = card.querySelector('.chat-init-body');
      const after = { bodyRight: body.getBoundingClientRect().right, listScrollW: list.scrollWidth, listClientW: list.clientWidth, bodyH: body.getBoundingClientRect().height };
      return { vw: innerWidth, before, after };
    })()`);
    ok(`375×667 collapsed: the card and its health strip stay inside the viewport (card ${Math.round(m.before.cardW)} ≤ ${m.vw}, strip right ${Math.round(m.before.warnRight)} ≤ ${m.vw}) and the list does not scroll sideways (${m.before.listScrollW} ≤ ${m.before.listClientW})`,
      m.before.cardW <= m.vw + 1 && m.before.warnRight <= m.vw + 1 && m.before.listScrollW <= m.before.listClientW + 1, m);
    ok(`375×667: the summary is a WRAPPING row, and at this width it does not overflow its own box (flex-wrap ${m.before.sumWrap}, scrollWidth ${m.before.sumScrollW} ≤ ${m.before.sumClientW}, height ${Math.round(m.before.sumH)}px) — a longer style name or a bigger count wraps to a second line instead of clipping`,
      m.before.sumWrap === 'wrap' && m.before.sumScrollW <= m.before.sumClientW + 1, m.before);
    ok(`375×667 expanded: the inventory wraps too — long verbatim lists break instead of pushing the transcript sideways (body right ${Math.round(m.after.bodyRight)} ≤ ${m.vw}, scrollWidth ${m.after.listScrollW} ≤ ${m.after.listClientW}, body ${Math.round(m.after.bodyH)}px tall)`,
      m.after.bodyRight <= m.vw + 1 && m.after.listScrollW <= m.after.listClientW + 1 && m.after.bodyH > 0, m.after);
  } catch (e) {
    ok('the chrome leg ran', false, String(e).slice(0, 400));
  } finally {
    try { ws?.close(); } catch { }
    try { chrome.kill('SIGKILL'); } catch { }
    try { srv.close(); } catch { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  }
}

console.log(fail ? `\n${fail} FAILED (${pass} passed${skipped ? `, ${skipped} skipped` : ''})` : `\nALL PASS (${pass}${skipped ? `, ${skipped} skipped` : ''})`);
process.exit(fail ? 1 : 0);
