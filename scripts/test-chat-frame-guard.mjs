#!/usr/bin/env node
// The 79928a2b 38MB poisoning trio (2.360.0):
// 1. POISON GUARD — a huge shredded frame must THROW in formatChatInput,
//    never be wrapped as text into the conversation.
// 2. FRAME FILE BYPASS — chat-wrapper's `_frame_file` pointer line reads the
//    payload from disk, validates it as ONE frame, forwards to the child and
//    unlinks; an invalid/shredded file is DROPPED, never wrapped.
// 3. RESCUE — transcripts.rescue stubs oversized records in place (chain,
//    order, count untouched), keeps a byte-preserved backup, atomic swap.
// 4. CAPABILITY GATE (2.361.1 → fixed 2.364.1): the server decides "does this
//    wrapper understand pointer lines" from the wrapper's OWN sidecar through
//    the canonical resolver — behaviorally, against the real wrapper's file,
//    never a text pin (the 2.361.1 reader pointed at data/session-meta, which
//    never carries caps; the text pins stayed green while every paste >1MB
//    was refused for two releases).
// 5. CODEX PARITY (design-harness-plugins §1 P1): the bypass used to exclude
//    codex BY BACKEND ID — the codex wrapper had no `_frame_file` verb, so a
//    multi-image paste rode raw pty stdin (shreddable, the 79928a2b class) and
//    an unparseable line was a silent `continue` (message lost, nobody told).
//    Now: the REAL codex-chat-wrapper against a stub app-server — pointer line
//    → intact turn/start input; caps.frameFile advertised in its sidecar and
//    read by wrapperCaps; shredded/missing/nested frame files and unparseable
//    raw lines all produce a task_failed event (LOUD), never a silent drop;
//    and the ws-handler gate is transport + capability only.
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

// ── 1. poison guard ──
{
  const { ClaudeCodeAdapter } = require(REPO + '/src/adapters/claude-code.js');
  const ad = new ClaudeCodeAdapter({ buffersDir: '/tmp' });
  const good = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  ok(ad.formatChatInput(good, 'm1').stdinPayload === good, 'valid frame passes through verbatim');
  const shred = '{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"data":"' + 'A'.repeat(600 * 1024) + '{"type":"user","message":{}}';
  let threw = null; try { ad.formatChatInput(shred, 'm2'); } catch (e) { threw = e.message; }
  ok(/corrupted in transit/.test(threw || ''), 'shredded 600KB frame THROWS instead of poisoning', threw);
  const small = '{"broken json but small';
  ok(ad.formatChatInput(small, 'm3').stdinPayload.includes('"text"'), 'small non-JSON text still wraps normally');
}

// ── 2. wrapper frame-file bypass (real chat-wrapper against a cat child) ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-framefile-'));
  const SID = 'sess-9-1700000000000'; // wrapper files follow <BUFFERS_DIR>/<id>.{buf,json}
  const buf = path.join(dir, SID + '.buf'), meta = path.join(dir, SID + '.json');
  // fake claude: echo stdin lines to a capture file
  const cap = path.join(dir, 'child-got.txt');
  const fake = path.join(dir, 'fake-claude.sh');
  fs.writeFileSync(fake, `#!/bin/bash\nwhile IFS= read -r l; do printf '%s\\n' "$l" >> ${cap}; done\n`, { mode: 0o755 });
  const w = spawn(process.execPath, [path.join(REPO, 'data/bin/chat-wrapper.js'), buf, meta, fake], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, VIBESPACE_SKIP_AGENT_HOOKS: '1' } });
  await sleep(700);
  const frame = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'BIG:' + 'x'.repeat(200 * 1024) }] } });
  const fp = path.join(dir, 'frame.json');
  fs.writeFileSync(fp, frame);
  w.stdin.write(JSON.stringify({ type: '_frame_file', path: fp }) + '\n');
  await sleep(900);
  const got = fs.existsSync(cap) ? fs.readFileSync(cap, 'utf8').trim().split('\n') : [];
  ok(got.length === 1 && got[0] === frame, `frame-file payload reaches the child INTACT as one line (${got[0]?.length || 0} bytes)`);
  ok(!fs.existsSync(fp), 'frame file unlinked after forwarding');
  // 2.361.1 skew gate: the wrapper ADVERTISES frame-file support in its boot
  // meta — the server only sends pointer lines to wrappers that do (a
  // pre-2.360.0 wrapper forwarded pointers verbatim to claude = silent loss;
  // the c1206711 lost-image incident).
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    ok(m?.caps?.frameFile === true, 'wrapper boot meta advertises caps.frameFile');
  } catch (e) { ok(false, 'wrapper boot meta advertises caps.frameFile', e.message); }
  // PARITY (2.364.1): the server's reader must see what the REAL wrapper wrote,
  // by the file convention the spawn uses — not a fixture of our own making.
  const { wrapperCaps } = require(REPO + '/src/server/wrapper-files.js');
  const seen = wrapperCaps(dir, SID, null);
  ok(seen.frameFile === true && seen.reason === 'ok' && seen.pid === w.pid, `server-side wrapperCaps reads the REAL wrapper's sidecar (${JSON.stringify(seen)})`);
  // shredded file must be dropped, never wrapped
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, frame.slice(0, 1000) + frame); // concatenated shred
  w.stdin.write(JSON.stringify({ type: '_frame_file', path: bad }) + '\n');
  await sleep(700);
  const got2 = fs.readFileSync(cap, 'utf8').trim().split('\n');
  ok(got2.length === 1, 'shredded frame file DROPPED (child got nothing new)');
  ok(!fs.existsSync(bad), 'shredded file still cleaned up');
  w.kill('SIGKILL');
}

// ── 2b. CODEX wrapper frame-file bypass (real codex-chat-wrapper against a
//        stub app-server; the stub records every JSON-RPC request it gets) ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxframe-'));
  const SID = 'sess-7-1700000000007';
  const buf = path.join(dir, SID + '.buf'), meta = path.join(dir, SID + '.json');
  const rpcLog = path.join(dir, 'rpc.jsonl');
  // Minimal app-server: answers every request by id (thread/start → thread id,
  // turn/start → turn id), appends each request line to rpc.jsonl.
  const STUB = `
const fs = require('fs');
let b = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  b += d;
  let i;
  while ((i = b.indexOf('\\n')) !== -1) {
    const line = b.slice(0, i); b = b.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && m.method) {
      fs.appendFileSync(${JSON.stringify(rpcLog)}, line + '\\n');
      const result = m.method === 'thread/start' ? { thread: { id: 'th-frame-1' } }
        : m.method === 'turn/start' ? { turn: { id: 'turn-' + m.id } } : {};
      process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n');
      // end every turn at once: since 2.369.20 a chat-input during an ACTIVE turn is
      // QUEUED (thread/queue/add) — this stub is about frame delivery, not queueing
      if (m.method === 'turn/start') process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { id: result.turn.id }, status: 'completed' } }) + '\\n');
    }
  }
});
setInterval(() => {}, 1e3);
`;
  const w = spawn(process.execPath, [path.join(REPO, 'data/bin/codex-chat-wrapper.js'), buf, meta, process.execPath, '-e', STUB], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_WEBUI_CWD: dir, VIBESPACE_API: '', VIBESPACE_SESSION_TOKEN: '', VIBESPACE_SKIP_AGENT_HOOKS: '1' },
  });
  let out = ''; w.stdout.on('data', (d) => { out += d; }); w.stderr.on('data', () => {});
  const readMeta = () => { try { return JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { return null; } };
  const rpc = () => { try { return fs.readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const turns = () => rpc().filter((m) => m.method === 'turn/start');
  const failures = () => out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.type === 'event_msg' && r.payload?.type === 'task_failed').map((r) => r.payload.error || '');
  let m1 = null;
  for (let i = 0; i < 50 && !(m1?.threadId); i++) { await sleep(200); m1 = readMeta(); }
  ok(m1?.threadId === 'th-frame-1', 'codex wrapper handshake completed against the stub app-server');
  ok(m1?.caps?.frameFile === true && m1?.caps?.peerMessage === true, `codex wrapper boot meta advertises caps.frameFile (and keeps peerMessage) — ${JSON.stringify(m1?.caps)}`);
  const { wrapperCaps } = require(REPO + '/src/server/wrapper-files.js');
  const seen = wrapperCaps(dir, SID, null);
  ok(seen.frameFile === true && seen.reason === 'ok' && seen.pid === w.pid, `server-side wrapperCaps reads the REAL codex wrapper's sidecar (${JSON.stringify(seen)})`);

  // The frame = EXACTLY what ws-handler writes into the file: the codex
  // adapter's stdinPayload for the client's image-paste shape (a claude-style
  // {type:'user'} frame with a base64 image block — chat-input.js sends the
  // same shape to every backend).
  const { CodexAdapter } = require(REPO + '/src/adapters/codex.js');
  const ad = new CodexAdapter({ codexCmd: 'codex', chatWrapper: '/x', ptyWrapper: '/y' });
  const IMG = 'A'.repeat(200 * 1024);
  const clientText = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG } }, { type: 'text', text: 'what is in this screenshot' }] } });
  const { stdinPayload } = ad.formatChatInput(clientText, 'm-frame-1');
  ok(stdinPayload.length > 64 * 1024, `fixture is a real >64KB codex stdin frame (${stdinPayload.length} bytes)`);
  const fp = path.join(dir, `${SID}-${Date.now()}.json`);
  fs.writeFileSync(fp, stdinPayload);
  w.stdin.write(JSON.stringify({ type: '_frame_file', path: fp }) + '\n');
  let t = [];
  for (let i = 0; i < 40 && !t.length; i++) { await sleep(150); t = turns(); }
  const input = t[0]?.params?.input || [];
  const img = input.find((x) => x.type === 'image');
  const txt = input.find((x) => x.type === 'text');
  ok(t.length === 1 && img?.url === `data:image/png;base64,${IMG}` && txt?.text === 'what is in this screenshot',
    `frame-file payload reaches the app-server INTACT as one turn/start (image ${img?.url?.length || 0} bytes + text)`);
  ok(!fs.existsSync(fp), 'codex frame file unlinked after delivery');
  await sleep(1200); // buffer (1s) + meta (500ms) persist on debounces
  // the stub completes every turn at once (2.369.20 queue-while-busy semantics): the turn
  // was adopted through the normal chat-input path (turn/start above) and is RELEASED by
  // turn/completed — activeTurnId must be null, not a stale id (the startTurn-vs-completed
  // ordering race guarded in the wrapper); live adoption is pinned by test-codex-p2-wrapper
  ok(readMeta()?.activeTurnId === null && readMeta()?.streaming === false, `turn adopted then released on turn/completed (no stale active turn): ${readMeta()?.activeTurnId}`);
  const bufText = fs.existsSync(buf) ? fs.readFileSync(buf, 'utf8') : '';
  ok(bufText.includes('"webui_msg_id":"m-frame-1"') && bufText.includes('"input_image"'), 'the user message is recorded in the wrapper buffer with its msgId (history survives a restart)');
  ok(failures().length === 0, 'no failure event for the good frame');
  // stdin ACK (design-harness-plugins §1 P2 "stdin ack", pulled in because it
  // now guards frame delivery): the server's broken-pty detector re-sends the
  // line after 5s without an ack — a re-sent pointer finds its file already
  // consumed. The wrapper must ack on stdout the moment a line arrives.
  ok(/"type":"_stdin_ack"/.test(out), 'codex wrapper emits _stdin_ack on stdout for a received stdin line (no 5s re-send of a consumed pointer)');
  ok(!bufText.includes('_stdin_ack'), 'the ack is stdout-only, never recorded into the history buffer');

  // shredded (concatenated) frame file → dropped, LOUD, unlinked, no turn
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, stdinPayload.slice(0, 1000) + stdinPayload);
  w.stdin.write(JSON.stringify({ type: '_frame_file', path: bad }) + '\n');
  await sleep(700);
  ok(turns().length === 1, 'shredded codex frame file DROPPED (no new turn/start)');
  ok(!fs.existsSync(bad), 'shredded codex frame file still unlinked');
  ok(failures().length === 1 && /frame file/.test(failures()[0]) && /send it again/.test(failures()[0]), `shredded frame → task_failed event the user can see (${JSON.stringify(failures()[0])})`);
  // missing file → LOUD
  w.stdin.write(JSON.stringify({ type: '_frame_file', path: path.join(dir, 'never-written.json') }) + '\n');
  await sleep(500);
  ok(failures().length === 2 && /read failed/.test(failures()[1]), 'missing frame file → task_failed with the reason');
  // nested pointer inside a frame file → refused (no recursion / arbitrary reads)
  const nest = path.join(dir, 'nest.json');
  fs.writeFileSync(nest, JSON.stringify({ type: '_frame_file', path: '/etc/hostname' }));
  w.stdin.write(JSON.stringify({ type: '_frame_file', path: nest }) + '\n');
  await sleep(500);
  ok(failures().length === 3 && /nested/.test(failures()[2]) && turns().length === 1, 'nested _frame_file pointer refused (loud, no turn)');
  // unparseable RAW stdin line (the shredded-in-transit shape) → LOUD, wrapper alive
  w.stdin.write('{"type":"chat-input","text":"' + 'B'.repeat(300) + '\n');
  await sleep(500);
  ok(failures().length === 4 && /corrupted in transit/.test(failures()[3]) && /send it again/.test(failures()[3]), `unparseable stdin line → task_failed (was a silent continue): ${JSON.stringify(failures()[3].slice(0, 80))}`);
  ok(!/BBBB/.test(failures()[3]) && !/BBBB/.test(out), 'the rejection quotes at most a short prefix (never the payload)');
  ok(w.exitCode === null, 'wrapper survives every rejection');
  // …and a normal small line still works afterwards (the stream is not poisoned)
  w.stdin.write(ad.formatChatInput('plain follow-up', 'm-2').stdinPayload + '\n');
  let t2 = [];
  for (let i = 0; i < 30 && t2.length < 2; i++) { await sleep(150); t2 = turns(); }
  ok(t2.length === 2 && t2[1].params.input[0]?.text === 'plain follow-up', 'a normal chat-input after the rejections still starts a turn');
  w.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 3. rescue ──
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-rescue-'));
  const proj = path.join(home, '.claude', 'projects', '-tmp-x');
  fs.mkdirSync(proj, { recursive: true });
  const cid = '11111111-2222-3333-4444-555555555555';
  const fp = path.join(proj, cid + '.jsonl');
  const rec = (u, p, extra) => JSON.stringify({ type: 'user', uuid: u, parentUuid: p, sessionId: cid, message: { role: 'user', content: [{ type: 'text', text: extra || 'ok' }] } });
  const monster = rec('u2', 'u1', 'M'.repeat(3 * 1024 * 1024));
  fs.writeFileSync(fp, [rec('u1', null), monster, rec('u3', 'u2')].join('\n') + '\n');
  const HOME0 = process.env.HOME;
  process.env.HOME = home; // findSessionJsonlPath scans $HOME/.claude/projects
  const { createTranscriptService } = require(REPO + '/src/transcript-service.js');
  const svc = createTranscriptService({ activeSessions: new Map(), createSessionMessages: () => null, hosts: null });
  const r = await svc.rescue({ sessionId: cid, cwd: '/tmp/x', backend: 'claude' });
  process.env.HOME = HOME0;
  ok(r.replaced === 1 && r.lines === 3, `rescue stubbed exactly the monster (${JSON.stringify({ replaced: r.replaced, lines: r.lines })})`);
  ok(r.sizeBefore > 3 * 1024 * 1024 && r.sizeAfter < 4096, 'file shrank to sane size');
  ok(fs.existsSync(r.backup) && fs.statSync(r.backup).size === r.sizeBefore, 'byte-preserved backup exists');
  const lines = fs.readFileSync(fp, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(lines.length === 3 && lines[1].uuid === 'u2' && lines[1].parentUuid === 'u1', 'chain + order + count untouched');
  ok(/rescued/.test(lines[1].message.content[0].text), 'stub carries the rescue note');
  ok(lines[2].parentUuid === 'u2', 'child still parents onto the stubbed uuid');
  // idempotent second pass
  process.env.HOME = home;
  const r2 = await svc.rescue({ sessionId: cid, cwd: '/tmp/x', backend: 'claude' });
  process.env.HOME = HOME0;
  ok(r2.replaced === 0 && r2.backup === null, 'second pass finds nothing (no backup litter)');
}

// ── 4. server-side capability gate (the c1206711 skew incident: a
//      capability-less wrapper must NEVER be sent a pointer line; 2.364.1: and a
//      capable one must never be REFUSED — the reader targets the wrapper's
//      sidecar, is stateless, and the refusal carries evidence) ──
{
  const { wrapperCaps } = require(REPO + '/src/server/wrapper-files.js');
  const bufs = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-caps-bufs-'));
  const metaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-caps-meta-'));
  const id = 'sess-4-1700000000001';
  // absent sidecar (wrapper still booting a huge resume)
  let c = wrapperCaps(bufs, id, null);
  ok(c.frameFile === false && c.reason === 'no-sidecar', 'no sidecar yet → not capable, reason no-sidecar');
  // pre-2.360.0 wrapper shape: pid/startedAt/mode/tasks/todos, NO caps
  fs.writeFileSync(path.join(bufs, id + '.json'), JSON.stringify({ pid: 4242, startedAt: 1786704676294, mode: 'chat', tasks: {}, todos: [] }));
  c = wrapperCaps(bufs, id, null);
  ok(c.frameFile === false && c.reason === 'no-caps' && c.startedAt === 1786704676294 && c.pid === 4242, 'old wrapper sidecar → not capable, startedAt/pid carried as evidence');
  // statelessness: the SAME id becomes capable once the sidecar says so
  fs.writeFileSync(path.join(bufs, id + '.json'), JSON.stringify({ pid: 4243, startedAt: 1787308555500, mode: 'chat', tasks: {}, todos: [], caps: { frameFile: true } }));
  c = wrapperCaps(bufs, id, null);
  ok(c.frameFile === true && c.reason === 'ok', 'a later read sees the capable sidecar (no negative verdict is baked into the reader)');
  // NEGATIVE CONTROL — the exact 2.361.1 bug: a SERVER session-meta record for
  // the same id (webuiSessionId/claudeSessionId…, never caps) must play no part.
  fs.writeFileSync(path.join(metaDir, id.replace(/^sess-/, 'cw-') + '.json'), JSON.stringify({ webuiSessionId: id, claudeSessionId: '11111111-1111-1111-1111-111111111111', mode: 'chat' }));
  c = wrapperCaps(bufs, id, null);
  ok(c.frameFile === true, 'verdict comes from the wrapper sidecar alone (a caps-less server meta beside it changes nothing)');
  // wiring pins: the gate calls the sidecar reader, caches only TRUE, refuses with evidence
  const ws = fs.readFileSync(path.join(REPO, 'src/ws-handler.js'), 'utf8');
  ok(ws.includes('wrapperCaps(BUFFERS_DIR, data.sessionId, session.socketPath)'), 'chat-input gate reads capability through wrapperCaps (sidecar + collision-aware resolver)');
  ok(!/readSessionMeta\([^)]*\)\?\.caps/.test(ws), 'NEGATIVE: the gate no longer consults data/session-meta for caps (the 2.361.1 wrong-file read)');
  ok(/session\._wrapperFrameFile !== true\)/.test(ws) && /if \(session\._wrapperFrameFile === true\) \{/.test(ws), 'only a POSITIVE verdict is cached; pointer line only to capability-advertising wrappers');
  ok(/1024 \* 1024\)/.test(ws) && ws.includes('it was NOT sent') && ws.includes('Terminate + Resume') && ws.includes('wait a moment'), 'oversized + incapable → VISIBLE refusal with the evidenced reason (old wrapper vs still-starting)');
  ok(ws.includes('chat-input REFUSED'), 'every refusal leaves a server-side journal line (the 2.364.1 forensics gap: nothing in the journal)');
  const sv = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  ok(sv.includes("'chat-frames'") && sv.includes('48 * 3600 * 1000'), 'orphaned chat-frames swept age-based (old wrappers never unlink)');
  // CAPABILITY-ONLY GATE (design-harness-plugins §1 P1): the bypass condition is
  // size + local transport; the wrapper's advertised capability decides the
  // rest. A backend-id exclusion is exactly what kept the shredding class open
  // for codex while its wrapper had no _frame_file verb.
  ok(!ws.includes("session.backend !== 'codex'") && !/stdinPayload\.length > 64 \* 1024[^\n]*session\.backend/.test(ws), "NEGATIVE: the chat-input bypass carries no backend-id exclusion (codex is gated by its wrapper's caps like everyone else)");
  ok(/stdinPayload\.length > 64 \* 1024 && !session\.host && session\.socketPath\) \{/.test(ws), 'bypass condition = size + local transport only; capability decides pointer-vs-raw-vs-refuse');
  // the codex wrapper side of the contract
  const cw = fs.readFileSync(path.join(REPO, 'data/bin/codex-chat-wrapper.js'), 'utf8');
  // the caps object GROWS (threadScoped joined it in B-7473) — pin the two the
  // bypass gates on, not the literal object
  ok(/caps: \{[^}]*peerMessage: true[^}]*\}/.test(cw) && /caps: \{[^}]*frameFile: true[^}]*\}/.test(cw), 'codex-chat-wrapper advertises caps.frameFile (+ peerMessage) in its boot meta');
  ok(/if \(msg\.type === '_frame_file'\) \{ msg = loadFrameFile\(msg\);/.test(cw), 'codex-chat-wrapper resolves _frame_file pointers on the stdin path (before the ready gate)');
  ok(/if \(!msg \|\| typeof msg !== 'object'\) \{ rejectStdinLine\(line\); continue; \}/.test(cw) && !/const msg = safeJsonParse\(line\);\n\s*if \(!msg\) continue;/.test(cw), 'NEGATIVE: an unparseable stdin line is no longer a silent continue');
  // the ack has a consumer in EVERY stdout consumer module (S5: src/server/stdout/<protocol>.js, one per declared protocol)
  const ACK_SRC = "if \\(msg\\.type === '_stdin_ack'\\) \\{ session\\._stdinAckReceived = true; continue; \\}";
  const perProto = Object.fromEntries(['claude-stream-json', 'codex-events', 'acp-events'].map((m) => [m, (fs.readFileSync(path.join(REPO, `src/server/stdout/${m}.js`), 'utf8').match(new RegExp(ACK_SRC, 'g')) || []).length]));
  ok(perProto['claude-stream-json'] === 1 && perProto['codex-events'] === 1 && perProto['acp-events'] === 1, `each stdout consumer (claude-stream-json / codex-events / acp-events) consumes _stdin_ack exactly once (${JSON.stringify(perProto)})`);
  ok(!new RegExp(ACK_SRC).test(fs.readFileSync(path.join(REPO, 'src/server/session-stdout.js'), 'utf8')), 'session-stdout itself parses no records since S5 (registry dispatch only) — the codex wrapper ack lands in stdout/codex-events.js, not a dead emit');
  fs.rmSync(bufs, { recursive: true, force: true }); fs.rmSync(metaDir, { recursive: true, force: true });
}

// ── 5. send-refusal presentation pins (inc-mt2arppw, userW: every refusal
//      flipped the LIVE window into the Resume bar with no reason — the
//      client's error handler read ALL per-session errors as attach failures,
//      and the refusal text rode msg.error which it never read) ──
{
  const ws = fs.readFileSync(path.join(REPO, 'src/ws-handler.js'), 'utf8');
  ok((ws.match(/code: 'input-rejected'/g) || []).length >= 2, 'both chat-input refusal sites carry code:input-rejected');
  ok(/code: 'input-rejected',[^\n]*message:/.test(ws.replace(/\n\s*/g, ' ')), 'refusals carry the text in the message field the client reads');
  const cv = fs.readFileSync(path.join(REPO, 'src/lib/chat-view.js'), 'utf8');
  ok(cv.includes("msg.code === 'input-rejected'"), 'chat-view renders coded refusals in-chat (no read-only flip)');
  ok(cv.indexOf("msg.code === 'input-rejected'") < cv.indexOf('_tryViewOnlyRescue'), 'refusal branch runs BEFORE the attach-failure rescue');
  const ir = fs.readFileSync(path.join(REPO, 'src/lib/incident-recorder.js'), 'utf8');
  ok(ir.includes('msg.message || msg.error'), 'incident ring captures error-field texts (the msg:"" forensic gap)');
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
