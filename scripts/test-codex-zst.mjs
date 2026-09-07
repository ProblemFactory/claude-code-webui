#!/usr/bin/env node
// Harness S3 (2.369.31): the descriptor STORE + codex facts off the hot path
// + zstd rollouts (codex ≥0.153). Real fixtures under a temp HOME:
//   ① zstd readers (discovery-facts + adapters/codex): multi-frame decompress,
//      bounded head reads, materialized plain twin, locate .jsonl.zst
//   ①b (review batch) a >4×-compressing rollout at DEFAULT level still yields a
//      head (bisected prefixes, never ''), and a failed head is never cached
//   ② the usage walk (module + shipped scanner) counts a .zst rollout, with
//      an incremental cursor (compressed-size keyed)
//   ③ discovery interpretation: NC names (codex naming rule, truncated lines),
//      CO open rollouts → remote-running, .zst thread ids, dedup of twins
//   ④ the async codex listing keeps the MAIN THREAD free over a 2000-rollout
//      tree (worker-side walk + dir-mtime cache) and lists every thread
//   ④b the dir-listing settle guard is recorded at CAPTURE time (same-mtime-tick
//      sibling repro via utimesSync)
//   ⑤ descriptor store contract + route/consumer wiring pins
//   ⑥ ONE remote cache slot, MANY remote files: hosts._fetchRemoteByFind against
//      a stub device that switches .jsonl ⇄ .jsonl.zst under one conversation id
//   ⑥b a slot the PRE-FIX code already spliced (hybrid bytes under a meta with no
//      provenance) heals itself — the remote never has to move
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 400) : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// isolated HOME so adapters/codex's CODEX_SESSIONS_DIR (read at require time) is ours
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-zst-home-'));
process.env.HOME = home; process.env.CODEX_HOME = path.join(home, '.codex');
const cxDir = path.join(home, '.codex', 'sessions', '2026', '09', '05');
fs.mkdirSync(cxDir, { recursive: true });
const TID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', TID2 = '11111111-2222-4333-8444-555555555555';
const rec = (o) => JSON.stringify(o) + '\n';
const rollout = (tid, cwd, firstUser, n = 3) => [
  rec({ timestamp: '2026-09-05T00:00:00.000Z', type: 'session_meta', payload: { id: tid, cwd, timestamp: '2026-09-05T00:00:00.000Z', cli_version: '0.153.4' } }),
  rec({ timestamp: '2026-09-05T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>\nfoo\n</recommended_plugins>' }] } }),
  rec({ timestamp: '2026-09-05T00:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: firstUser }] } }),
  rec({ timestamp: '2026-09-05T00:00:03.000Z', type: 'turn_context', payload: { model: 'gpt-6-astra', cwd } }),
  ...Array.from({ length: n }, (_, i) => rec({ timestamp: `2026-09-05T00:00:0${4 + i}.000Z`, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000 * (i + 1), cached_input_tokens: 500 * (i + 1), output_tokens: 10 }, total_token_usage: { total_tokens: 1000 * (i + 1) + 10 } } } })),
].join('');
const plainText = rollout(TID, '/work/plain', 'please fix the parser bug in lexer.js');
const zstText = rollout(TID2, '/work/zst', 'compressed rollout question about zstd');
// two frames (an appended rollout) + a skippable frame in between
const frame1 = zlib.zstdCompressSync(Buffer.from(zstText.slice(0, 300)));
const skippable = Buffer.concat([Buffer.from([0x50, 0x2a, 0x4d, 0x18]), Buffer.from([4, 0, 0, 0]), Buffer.from('xxxx')]);
const frame2 = zlib.zstdCompressSync(Buffer.from(zstText.slice(300)));
const zstBuf = Buffer.concat([frame1, skippable, frame2]);
const plainPath = path.join(cxDir, `rollout-2026-09-05T00-00-00-${TID}.jsonl`);
const zstPath = path.join(cxDir, `rollout-2026-09-05T00-00-00-${TID2}.jsonl.zst`);
fs.writeFileSync(plainPath, plainText);
fs.writeFileSync(zstPath, zstBuf);

console.log('— ① zstd readers');
const DF = require(path.join(REPO, 'src/discovery-facts.js'));
ok(DF.ZSTD_SUPPORTED === true, `this node (${process.versions.node}) has zlib zstd (the readers need ≥22.15)`);
ok(DF.isZstBuffer(zstBuf) && !DF.isZstBuffer(Buffer.from(plainText)) && DF.isZstPath(zstPath) && !DF.isZstPath(plainPath), 'zstd detection by magic bytes and by extension');
ok(DF.zstdDecompressFrames(zstBuf).toString() === zstText, 'zstdDecompressFrames concatenates EVERY frame and steps over skippable frames (zstdDecompressSync alone stops after the first)');
ok(DF.zstdDecompressFrames(zstBuf.subarray(0, frame1.length + 20)).toString() === zstText.slice(0, 300), 'a truncated trailing frame yields the earlier frames\' text (bounded prefix reads work)');
let big = null; try { DF.zstdDecompressFrames(zstBuf, { maxOutputLength: 100 }); } catch (e) { big = e.code; }
ok(big === 'EZSTBIG', 'exceeding maxOutputLength throws the coded EZSTBIG error (never a giant string)');
const headZ = DF.readHeadText(zstPath, 100000), headP = DF.readHeadText(plainPath, 100000);
ok(headZ === zstText && headP === plainText, 'readHeadText returns plain text for both a .zst and a plain rollout');
ok(DF.readHeadText(zstPath, 200).length <= 200 && DF.readHeadText(zstPath, 200).endsWith('\n'), 'readHeadText caps the PLAIN bytes and drops the cut-off last line');
ok(DF.codexThreadIdOf(zstPath) === TID2 && DF.codexThreadIdOf(plainPath) === TID && DF.CODEX_ROLLOUT_RE.test('rollout-x.jsonl.zst') && !DF.CODEX_ROLLOUT_RE.test('notes.jsonl'), 'thread-id + rollout-name rules accept .jsonl and .jsonl.zst');
const CX = require(path.join(REPO, 'src/adapters/codex.js'));

// ── ①b A REAL-SHAPED ROLLOUT THAT COMPRESSES BETTER THAN 4× (the vanished-thread bug)
// Measured on this dev box: compressing the 40 real ~/.codex rollouts at the
// DEFAULT zstd level, 7 of them decompressed to more than the old
// `max(plainBytes*4, 1MiB)` cap out of a ≤256KiB compressed prefix (ratios
// 4.0–6.0, e.g. plain 1,115,325 → comp 195,087) — readHeadText returned '' for
// every one, extractCodexThreadMeta produced threadId '' and the thread
// VANISHED from /api/sessions (and the empty meta was then cached by mtime).
// The fixture below is synthetic-but-representative (no real transcript text
// in a public repo): mixed prose + high-entropy tokens, DEFAULT level, ratio
// asserted > 4 so it keeps reproducing the real shape.
const TID3 = '77777777-6666-4555-8444-333333333333';
{
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const words = 'the quick brown fox jumps over lazy dog parser lexer token stream buffer commit rebase render layout socket handler timeout retry cache index thread rollout session meta payload assistant reasoning output patch diff file path error stack trace request response usage tokens model context window bisect prefix compressed head discovery poll'.split(' ');
  const sentence = (n) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ');
  let body = '';
  for (let i = 0; Buffer.byteLength(body) < 1300000; i++) {
    body += rec({ timestamp: '2026-09-05T00:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: sentence(60) + ' ' + Array.from({ length: 40 }, () => Math.floor(rnd() * 4294967296).toString(36)).join(' ') }] } });
  }
  const bigText = rollout(TID3, '/work/big', 'high ratio rollout that used to vanish', 1) + body;
  const bigComp = zlib.zstdCompressSync(Buffer.from(bigText));   // DEFAULT level, like codex writes
  const bigPath = path.join(cxDir, `rollout-2026-09-05T00-00-00-${TID3}.jsonl.zst`);
  fs.writeFileSync(bigPath, bigComp);
  const HEAD = 262144; // adapters/codex THREAD_META_HEAD_BYTES
  const ratio = Buffer.byteLength(bigText) / bigComp.length;
  ok(ratio > 4 && Buffer.byteLength(bigText) > 1048576, `fixture is representative of the real rollouts: ratio ${ratio.toFixed(2)}× (>4) over ${(Buffer.byteLength(bigText) / 1048576).toFixed(2)}MB plain`);
  let oldCap = null;
  try { DF.zstdDecompressFrames(bigComp.subarray(0, Math.min(bigComp.length, HEAD)), { maxOutputLength: Math.max(HEAD * 4, 1024 * 1024) }); } catch (e) { oldCap = e.code; }
  ok(oldCap === 'EZSTBIG', 'REPRO: the old one-shot ratio-guess cap throws on this file (that throw became an empty head)');
  const bigHead = DF.readHeadText(bigPath, HEAD);
  ok(bigHead.length > 0 && bigHead.length <= HEAD && bigHead.startsWith('{"timestamp"') && bigHead.endsWith('\n'), `readHeadText BISECTS the compressed prefix instead of guessing a ratio (${bigHead.length} plain bytes, never '')`);
  ok(DF.zstdDecompressHead(bigComp, HEAD).length >= HEAD && DF.zstdDecompressHead(bigComp, HEAD).length <= Math.max(HEAD * 4, 1024 * 1024), 'zstdDecompressHead yields AT LEAST the requested head and never inflates the whole archive');
  const bigMeta = CX.extractCodexThreadMeta(bigPath);
  ok(bigMeta.threadId === TID3 && bigMeta.cwd === '/work/big' && bigMeta.name === 'high ratio rollout that used to vanish', 'the thread stays in the session list (threadId + cwd + name), where it used to vanish', bigMeta);
  // A FAILED head must never be cached as a successful EMPTY meta: corrupt the
  // file, read it (throws → no cache), then restore the content KEEPING THE
  // SAME mtime — a cached empty meta would survive and hide the thread forever.
  const corruptPath = path.join(cxDir, `rollout-2026-09-05T00-00-00-88888888-6666-4555-8444-333333333333.jsonl.zst`);
  fs.writeFileSync(corruptPath, Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('not really a zstd frame at all')]));
  const stamp = new Date(Date.now() - 60000);
  fs.utimesSync(corruptPath, stamp, stamp);
  let headErr = null; try { DF.readHeadText(corruptPath, HEAD); } catch (e) { headErr = e.code; }
  ok(headErr === 'EZSTHEAD', 'an unreadable compressed head THROWS a coded error (it is not "an empty transcript")');
  ok(CX.extractCodexThreadMeta(corruptPath).threadId === '', 'a failed extraction yields an empty meta…');
  fs.writeFileSync(corruptPath, zlib.zstdCompressSync(Buffer.from(rollout('88888888-6666-4555-8444-333333333333', '/work/healed', 'healed rollout', 1))));
  fs.utimesSync(corruptPath, stamp, stamp); // SAME mtime as the failed read
  ok(CX.extractCodexThreadMeta(corruptPath).threadId === '88888888-6666-4555-8444-333333333333', '…and is NEVER cached by mtime — the next read sees the readable file');
  fs.rmSync(bigPath); fs.rmSync(corruptPath);
}

ok(CX.findCodexSessionJsonlPath(TID2) === zstPath && CX.findCodexSessionJsonlPath(TID) === plainPath, 'findCodexSessionJsonlPath locates a .jsonl.zst rollout (plain wins when both exist)');
const twin = CX.plainJsonlPath(zstPath);
ok(twin !== zstPath && fs.readFileSync(twin, 'utf8') === zstText && CX.plainJsonlPath(plainPath) === plainPath, 'plainJsonlPath materializes a compressed rollout ONCE into the per-user temp cache; plain files return themselves');
ok(CX.plainJsonlPath(zstPath) === twin, '…and reuses the cached twin for the same (mtime,size)');
const meta = CX.extractCodexThreadMeta(zstPath);
ok(meta.threadId === TID2 && meta.cwd === '/work/zst' && meta.name === 'compressed rollout question about zstd', 'extractCodexThreadMeta reads a .zst head (cwd + name via the shared naming rule, injected <recommended_plugins> block skipped)', meta);
  const parsed = CX.parseCodexSessionJsonl(TID2);
  const recs = Array.isArray(parsed) ? parsed : (parsed?.records || parsed?.messages || []);
  ok(recs.length >= 5, `parseCodexSessionJsonl(threadId) reads a .zst rollout through the twin (${recs.length} records)`, Object.keys(parsed || {}).slice(0, 5));

console.log('— ② usage walk counts compressed rollouts (module + shipped scanner, incremental)');
{
  const { runUsageWalk } = require(path.join(REPO, 'src/usage-walker.js'));
  const cursorFile = path.join(home, 'cursor.json');
  const r1 = runUsageWalk({ home, cursorFile });
  const cx = r1.events.map((l) => JSON.parse(l)).filter((e) => e.be === 'codex');
  const zstEvs = cx.filter((e) => e.sid === TID2), plainEvs = cx.filter((e) => e.sid === TID);
  ok(zstEvs.length === 3 && plainEvs.length === 3 && zstEvs[0].model === 'gpt-6-astra' && zstEvs[0].cwd === '/work/zst', `the walker module counts the .zst rollout like the plain one (${zstEvs.length}+${plainEvs.length})`);
  ok(r1.cursors[zstPath]?.zsize === zstBuf.length && r1.cursors[zstPath].offset === Buffer.byteLength(zstText), 'the .zst cursor records compressed size + PLAIN offset');
  fs.writeFileSync(cursorFile, JSON.stringify(r1.cursors));
  const r2 = runUsageWalk({ home, cursorFile });
  ok(r2.events.length === 0, 'a committed cursor makes the compressed rollout incremental (unchanged size ⇒ skipped, no decompress)');
  // append a frame → only the new events
  const extra = rec({ timestamp: '2026-09-05T00:00:09.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 9000, cached_input_tokens: 100, output_tokens: 1 }, total_token_usage: { total_tokens: 99999 } } } });
  fs.appendFileSync(zstPath, zlib.zstdCompressSync(Buffer.from(extra)));
  const r3 = runUsageWalk({ home, cursorFile });
  const e3 = r3.events.map((l) => JSON.parse(l)).filter((e) => e.be === 'codex');
  ok(e3.length === 1 && e3[0].rid === `cx:${TID2}:99999`, 'an appended frame yields exactly the new event (plain-offset cursor over the re-decompressed stream)');
  const scOut = execFileSync(process.execPath, [path.join(REPO, 'data/bin/vibespace-usage-scan')], { encoding: 'utf8', env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), VIBESPACE_USAGE_CURSOR: path.join(home, 'sc-cursor.json') }, timeout: 30000 });
  const sc = scOut.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.be === 'codex');
  const mod = runUsageWalk({ home, cursorFile: path.join(home, 'fresh-cursor.json') }).events.map((l) => JSON.parse(l)).filter((e) => e.be === 'codex');
  ok(sc.length === 7 && JSON.stringify(sc) === JSON.stringify(mod), `the shipped scanner emits the SAME codex events as the module incl. the .zst rollout (${sc.length}) — parity holds`);
}

console.log('— ③ discovery interpretation: NC names, CO liveness, .zst ids');
{
  const run = (lines) => DF.interpretDiscoveryLines(lines.join('\n'), { hostId: 'h1', hostName: 'Box', claimJsonls: () => new Map() });
  const rp = `/HOME/.codex/sessions/2026/09/05/rollout-2026-09-05T00-00-00-${TID}.jsonl`;
  const rz = `/HOME/.codex/sessions/2026/09/05/rollout-2026-09-05T00-00-00-${TID2}.jsonl.zst`;
  const inj = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>\nfoo' }] } });
  const real = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'please fix the parser bug in lexer.js' }] } });
  const s = run([`C 1700001000 4000 ${rp}`, `HC ${rp}\t"cwd":"/work/plain"`, `NC ${rp}\t${inj}`, `NC ${rp}\t${real}`, `C 1700000900 3000 ${rz}`, `HC ${rz}\t"cwd":"/work/zst"`, `CO ${rz}`]);
  const a = s.find((x) => x.sessionId === TID), b = s.find((x) => x.sessionId === TID2);
  ok(a && a.name === 'please fix the parser bug in lexer.js' && a.status === 'remote-stopped', 'NC lines name the thread through the codex naming rule (the injected <recommended_plugins> record is skipped)', a);
  ok(b && b.backend === 'codex' && b.status === 'remote-running' && b.cwd === '/work/zst' && b.name === null, 'a CO line marks the thread RUNNING on the host (Resume must not double-write); a .zst rollout gets its thread id', b);
  const cut = `NC ${rp}\t` + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a long question that gets cut off by the 2000-byte cap somewhere in the middle of the' }] } }).slice(0, 120);
  const s2 = run([`C 1700001000 4000 ${rp}`, cut]);
  ok(s2[0]?.name && /^a long questio/.test(s2[0].name), 'a TRUNCATED NC line still names from the cut "text":"…" fragment', { got: s2[0]?.name, cut });
  const twins = run([`C 1700001000 4000 ${rp}`, `C 1700000000 900 ${rp.replace(/\.jsonl$/, '.jsonl.zst')}`]);
  ok(twins.length === 1 && twins[0].sessionId === TID, 'a .jsonl and its .jsonl.zst twin list ONCE');
  // TWIN ORDER, BOTH WAYS (the "plain wins" comment used to be a lie): both
  // producers sort NEWEST FIRST and the .zst is written AFTER the last plain
  // write, so in production the compressed twin came first — and it is the one
  // whose head the ssh scanner often cannot read (no zstd(1) on the host), so
  // the card lost the cwd/name its plain twin carried.
  const rzTwin = rp.replace(/\.jsonl$/, '.jsonl.zst');
  const twinLines = (first) => (first === 'zst'
    ? [`C 1700002000 900 ${rzTwin}`, `C 1700001000 4000 ${rp}`]
    : [`C 1700001000 4000 ${rp}`, `C 1700002000 900 ${rzTwin}`]
  ).concat([`HC ${rp}\t"cwd":"/work/plain"`, `NC ${rp}\t${real}`]);
  for (const first of ['zst', 'plain']) {
    const t = run(twinLines(first));
    ok(t.length === 1 && t[0].sessionId === TID && t[0].cwd === '/work/plain' && t[0].name === 'please fix the parser bug in lexer.js' && t[0].mtime === 1700002000000,
      `twins list once with the PLAIN twin's facts and the newer mtime, ${first}-line-first (producer order must not decide)`, t[0]);
  }
  const twinZstFacts = run([`C 1700002000 900 ${rzTwin}`, `C 1700001000 4000 ${rp}`, `HC ${rzTwin}\t"cwd":"/work/zstonly"`]);
  ok(twinZstFacts.length === 1 && twinZstFacts[0].cwd === '/work/zstonly', 'the twins\' facts MERGE — whichever line carries cwd/name fills it');
  const twinRunning = run([`C 1700002000 900 ${rzTwin}`, `C 1700001000 4000 ${rp}`, `CO ${rp}`]);
  ok(twinRunning[0].status === 'remote-running', 'a CO line on EITHER twin marks the one thread running');
  const lines = DF.synthesizeDiscoveryLines({ locks: [], jsonls: [], codexRollouts: [{ path: rz, size: 3000, mtimeMs: 1700000900000, headCwd: '/work/zst', userLines: [real] }], codexOpen: [rz] });
  ok(/^NC /m.test(lines) && /^CO /m.test(lines) && run(lines.split('\n'))[0].status === 'remote-running' && run(lines.split('\n'))[0].name === 'please fix the parser bug in lexer.js', 'the daemon snapshot (userLines + codexOpen) synthesizes NC/CO lines the same interpreter reads (device/ssh parity)');
  ok(DF.nameFromCodexUserLine(inj) === null && DF.nameFromCodexUserLine('{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"nope"}]}}') === null, 'assistant records and injected blocks never name a thread');
}

console.log('— ④ async listing keeps the main thread free (2000 rollouts)');
{
  const CS = require(path.join(REPO, 'src/codex-session-store.js'));
  const bigDir = path.join(home, '.codex', 'sessions', '2026', '09', '06');
  fs.mkdirSync(bigDir, { recursive: true });
  for (let i = 0; i < 2000; i++) {
    const tid = `${(i + 0x10000000).toString(16).padStart(8, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`;
    fs.writeFileSync(path.join(bigDir, `rollout-2026-09-06T00-00-00-${tid}.jsonl`), rollout(tid, `/w/${i}`, `question ${i}`, 1));
  }
  const gaps = []; let last = Date.now(); const ticker = setInterval(() => { const now = Date.now(); gaps.push(now - last); last = now; }, 5);
  const t0 = Date.now();
  const list = await CS.listCodexThreadsAsync({ activeSessions: new Map() });
  const wall = Date.now() - t0;
  clearInterval(ticker);
  const worst = Math.max(...gaps, 0);
  ok(list.length === 2002, `listCodexThreadsAsync lists every thread (${list.length}) in ${wall}ms`);
  ok(worst < 250, `the main thread never stalled while the worker walked the tree (worst tick gap ${worst}ms over ${gaps.length} ticks)`);
  const t1 = Date.now(); await CS.listCodexThreadsAsync({ activeSessions: new Map() }); const wall2 = Date.now() - t1;
  await sleep(2100); // the worker holds its own dir cache; exercise the cache INLINE after the 2s settle window
  CS.collectCodexThreadMetas(); const before = CS.dirCacheStats().hits; CS.collectCodexThreadMetas();
  ok(CS.dirCacheStats().size >= 4 && CS.dirCacheStats().hits > before, `the per-directory mtime cache serves a repeat walk without readdir (${JSON.stringify(CS.dirCacheStats())}; worker listing ${wall2}ms)`);
  const sync = CS.listCodexThreads({ activeSessions: new Map() });
  ok(sync.length === list.length && sync[0].sessionId === list[0].sessionId, 'the sync listing (user-action consumers) returns the same threads');
  const withLive = await CS.listCodexThreadsAsync({ activeSessions: new Map([['w1', { backend: 'codex', backendSessionId: TID, name: 'live one', mode: 'chat', forkedFrom: [TID2] }]]) });
  ok(withLive.find((t) => t.sessionId === TID)?.status === 'live' && !withLive.find((t) => t.sessionId === TID2), 'a live webui session marks its thread live and hides its forkedFrom sources (unchanged merge rules)');
}

console.log('— ④b the dir-listing settle guard belongs to the CAPTURE, not the lookup');
{
  // Directory mtimes are coarse (1s on many filesystems, NFS included): a
  // listing captured while the current tick was still open can miss a sibling
  // created in that same second, and that sibling never bumps the mtime again.
  // The guard used to be evaluated at LOOKUP time (`now - mtime > 2s`), so such
  // a capture became trusted FOREVER once the clock moved on — the second
  // rollout never appeared in the session list (the poll is 5s: the window is
  // always over by the next lookup). utimesSync reproduces the same-tick case
  // deterministically.
  const CS = require(path.join(REPO, 'src/codex-session-store.js'));
  const d = path.join(home, '.codex', 'sessions', '2026', '09', '07');
  fs.mkdirSync(d, { recursive: true });
  const mk = (n) => {
    const tid = `abcdef${n}0-1111-4222-8333-44444444444${n}`;
    fs.writeFileSync(path.join(d, `rollout-2026-09-07T00-00-0${n}-${tid}.jsonl`), rollout(tid, `/w/settle${n}`, `settle ${n}`, 1));
    return tid;
  };
  const tidA = mk(1);
  const tick = new Date();                       // the dir's mtime tick is OPEN right now
  fs.utimesSync(d, tick, tick);
  const first = CS.collectCodexThreadMetas().metas;
  ok(first.some((m) => m.threadId === tidA), 'the unsettled capture lists what it saw');
  const tidB = mk(2);                            // created in the SAME mtime tick…
  fs.utimesSync(d, tick, tick);                  // …so the mtime does not move
  await sleep(2100);                             // the lookup-time guard would now say "settled"
  const second = CS.collectCodexThreadMetas().metas;
  ok(second.some((m) => m.threadId === tidB), 'a listing captured UNSETTLED is re-read on the next lookup (the same-second sibling appears)');
  const hitsBefore = CS.dirCacheStats().hits;
  CS.collectCodexThreadMetas();
  ok(CS.dirCacheStats().hits > hitsBefore, '…and the now-SETTLED capture is cached again (the readdir-per-poll win survives)');
}

console.log('— ⑤ descriptor store contract + wiring pins');
{
  const { HARNESSES, chatHarnessIds } = require(path.join(REPO, 'src/harnesses/index.js'));
  for (const id of chatHarnessIds()) {
    const st = HARNESSES[id].store;
    ok(st && typeof st.locate === 'function' && (typeof st.SessionMessages === 'function' || typeof st.createReader === 'function'), `${id}: store declares locate + a reader`);
  }
  for (const id of ['claude', 'codex']) {
    const st = HARNESSES[id].store;
    ok(typeof st.discover === 'function' && typeof st.forkChain === 'function' && typeof st.writerSweep === 'function' && typeof st.remoteFind === 'function' && typeof st.remoteFind('abc').findExpr === 'string' && typeof st.remoteFind('abc').cacheRel === 'string' && typeof st.remoteFind('abc').root === 'string', `${id}: store declares discover/forkChain/writerSweep/remoteFind`);
  }
  ok(/rollout-\*abc\.jsonl\.zst/.test(HARNESSES.codex.store.remoteFind('abc').findExpr) && HARNESSES.codex.store.forkChain(TID2).length === 0, 'codex remoteFind matches .jsonl and .jsonl.zst; forkChain reads the rollout meta');
  const rs = read('src/routes/sessions.js');
  ok(/for \(const h of listHarnesses\(\)\) \{\s*\n\s*if \(!h\.store \|\| typeof h\.store\.discover !== 'function'\) continue;\s*\n\s*const entries = await h\.store\.discover\(\{ activeSessions, webuiPids, devSnap \}\);/.test(rs) && !/listCodexThreads\(\{ activeSessions \}\)/.test(rs) && !/runningByProjDir/.test(rs), 'routes/sessions discovers through every harness\'s store.discover (the claude sweep moved to session-store, the codex walk to the worker) — no backend ternary');
  ok(/async function discoverClaudeSessions\(\{ activeSessions, webuiPids = new Set\(\), devSnap = null \} = \{\}\)/.test(read('src/session-store.js')), 'session-store owns discoverClaudeSessions (lock-first sweep, verbatim)');
  const ts = read('src/transcript-service.js');
  ok(/function localTranscriptPath\(r\)/.test(ts) && /h\.store\.locate\(r\.sessionId, r\.cwd\)/.test(ts) && /hosts\.fetchTranscript\(r\.host, r\.backend \|\| 'claude', r\.sessionId\)/.test(ts) && !/r\.backend === 'codex' \? findCodexSessionJsonlPath/.test(ts), 'transcript-service locates + fetches through the descriptor store (no codex ternaries)');
  const hs = read('src/hosts.js');
  ok(/async fetchTranscript\(id, backend, sessionId/.test(hs) && /h\.store\.remoteFind\(sessionId\)/.test(hs) && /return this\.fetchTranscript\(id, 'codex', threadId, opts\)/.test(hs) && /return this\.fetchTranscript\(id, 'claude', sessionId, opts\)/.test(hs), 'hosts.fetchTranscript is THE remote fetch; the two legacy methods are shims');
  ok(/-name 'rollout-\*\.jsonl' -o -name 'rollout-\*\.jsonl\.zst'/.test(hs) && /printf 'NC %s\\\\t'/.test(hs) && /echo "CO \$t"/.test(hs) && /zstd -dc -- "\$f"/.test(hs), 'the ssh discovery script lists .zst rollouts, emits NC name lines (zstd(1) for compressed heads) and CO open-rollout lines');
  const ag = read('src/agentd/agentd.js');
  ok(/rollout-\.\*\\\.jsonl\(\?:\\\.zst\)\?\$/.test(ag) && /r\.userLines = head\.split/.test(ag) && /listOpenCodexRolloutPaths\(\{ sessionsDir: croot \}\)/.test(ag) && /codexOpen: snap\.codexOpen \|\| \[\]/.test(ag), 'the daemon snapshot carries .zst rollouts, userLines and codexOpen (one implementation via discovery-facts)');
  const tw = read('src/transcript-worker.js');
  ok(/case 'codexThreadMetas'/.test(tw) && /case 'codexOpenThreads'/.test(tw) && /transcriptWorkerCall\('codexThreadMetas', \{\}, collectCodexThreadMetas\)/.test(read('src/codex-session-store.js')), 'the rollout walk and the /proc scan run as transcript-worker ops with inline fallbacks');
  const uw = read('src/usage-walker.js'), sc = read('data/bin/vibespace-usage-scan');
  ok(/\\\.jsonl\(\\\.zst\)\?\$\/i/.test(uw) && /\\\.jsonl\(\\\.zst\)\?\$\/i/.test(sc) && /cur\.zsize === st\.size/.test(uw) && /cur\.zsize === st\.size/.test(sc) && /function zstdPlain\(buf\)/.test(uw) && /function zstdPlain\(buf\)/.test(sc), 'walker module + shipped scanner carry the SAME zst handling (lockstep)');
  ok(/'test-codex-zst'/.test(read('scripts/ci.mjs')), 'this suite is in the release gate');
}

console.log('— ⑥ ONE remote cache slot, MANY remote files (codex .jsonl ⇄ .jsonl.zst)');
{
  // hosts._fetchRemoteByFind keys ONE cache file per conversation id, but the
  // codex remoteFind predicate matches BOTH the plain rollout and its
  // compressed twin — and a host compresses a finished rollout. The meta used
  // to record {size,mtime} only, so the append-only delta path concatenated the
  // NEW file's bytes onto the OTHER file's cached prefix and stamped it
  // complete; a stopped thread never changes again ⇒ served corrupt forever.
  const { HostManager } = require(path.join(REPO, 'src/hosts.js'));
  const dataDir = path.join(home, 'hostdata');
  fs.mkdirSync(dataDir, { recursive: true });
  const hm = new HostManager({ dataDir });
  hm._state.hosts.push({ id: 'hz', name: 'Z', transport: 'dial' });   // dial ⇒ the device data-plane path
  hm._ssh = async () => { throw new Error('the legacy ssh rung must not be needed here'); };
  const TIDR = '99999999-8888-4777-8666-555555555555';
  const remote = { path: '', data: Buffer.alloc(0), mtime: 1000 };
  const reads = [];
  let findCmd = '';
  hm.deviceBounded = async () => ({
    runCmd: async (cmd, args) => { findCmd = args[args.length - 1]; return { stdout: remote.path + '\n', stderr: '', code: 0 }; },
    fsStat: async () => ({ stat: { size: remote.data.length, mtimeMs: remote.mtime * 1000 } }),
    fsReadRange: async (p, off, len) => { reads.push([p, off, len]); return { data: remote.data.subarray(off, off + len) }; },
  });
  const rolloutPath = `/home/u/.codex/sessions/2026/09/05/rollout-2026-09-05T00-00-00-${TIDR}.jsonl`;
  const metaOf = (p) => JSON.parse(fs.readFileSync(p + '.meta', 'utf8'));

  const plainSmall = rollout(TIDR, '/work/remote', 'remote codex thread', 1);
  remote.path = rolloutPath; remote.data = Buffer.from(plainSmall); remote.mtime = 1000;
  const c1 = await hm.fetchTranscript('hz', 'codex', TIDR);
  ok(fs.readFileSync(c1, 'utf8') === plainSmall, 'first fetch caches the plain rollout');
  ok(/\| sort \| head -1/.test(findCmd), 'the remote locate is DETERMINISTIC and prefers the plain twin (find | sort | head -1)');
  ok(metaOf(c1).remotePath === rolloutPath && metaOf(c1).compressed === false, 'the meta records WHICH remote file the bytes came from');

  // the host compresses the finished rollout: same thread, different file
  const compressed = zlib.zstdCompressSync(Buffer.from(rollout(TIDR, '/work/remote', 'remote codex thread', 2000)));
  ok(compressed.length > plainSmall.length, 'fixture: the compressed twin is LARGER than the cached plain prefix (the delta path\'s precondition)');
  remote.path = rolloutPath + '.zst'; remote.data = compressed; remote.mtime = 2000;
  const c2 = await hm.fetchTranscript('hz', 'codex', TIDR);
  const got2 = fs.readFileSync(c2);
  ok(got2.equals(compressed) && DF.isZstBuffer(got2), 'a SWITCHED remote file is refetched whole — never compressed bytes appended onto the plain prefix', got2.subarray(0, 8).toString('hex'));
  ok(metaOf(c2).remotePath.endsWith('.zst') && metaOf(c2).compressed === true, 'the meta follows the switch (compressed flag recorded)');

  // …and back: a resumed thread writes plain again, over a COMPRESSED cache
  const plainBig = rollout(TIDR, '/work/remote', 'remote codex thread', 800);
  ok(Buffer.byteLength(plainBig) > compressed.length, 'fixture: the returning plain file is larger than the cached compressed bytes');
  remote.path = rolloutPath; remote.data = Buffer.from(plainBig); remote.mtime = 3000;
  const c3 = await hm.fetchTranscript('hz', 'codex', TIDR);
  ok(fs.readFileSync(c3, 'utf8') === plainBig, 'a compressed cache is never delta-appended to either — the plain twin comes back whole');

  // the slab win must survive: the SAME plain file growing still syncs a delta
  reads.length = 0;
  const plainGrown = plainBig + rec({ timestamp: '2026-09-05T00:01:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 }, total_token_usage: { total_tokens: 6 } } } });
  remote.data = Buffer.from(plainGrown); remote.mtime = 4000;
  const c4 = await hm.fetchTranscript('hz', 'codex', TIDR);
  ok(fs.readFileSync(c4, 'utf8') === plainGrown && reads.length === 1 && reads[0][1] === Buffer.byteLength(plainBig), `the same growing plain file still syncs as an append-only DELTA (${JSON.stringify(reads)})`);
  reads.length = 0;
  await hm.fetchTranscript('hz', 'codex', TIDR);
  ok(reads.length === 0, 'an unchanged remote file serves the cache with no read at all');

  // ── ⑥b A SLOT THE PRE-FIX CODE ALREADY CORRUPTED (review follow-up)
  // The provenance fields only protect slots the FIXED code wrote. A meta
  // stamped before them carries no remotePath, and reading that as "same
  // file" is vacuously true — so a cache the old delta path had ALREADY
  // spliced (plain prefix + the compressed twin's bytes, stamped complete)
  // kept passing the size/mtime short-circuit and was served forever: a
  // stopped thread never changes again, so nothing ever invalidated it. The
  // heal must therefore need no movement on the remote side.
  console.log('— ⑥b a pre-fix hybrid cache heals itself (no provenance in the meta)');
  const slotOf = (tid) => ({
    tid,
    remotePath: `/home/u/.codex/sessions/2026/09/05/rollout-2026-09-05T00-00-00-${tid}.jsonl`,
    cache: path.join(dataDir, 'remote-jsonl', 'hz', 'codex', `${tid}.jsonl`),
  });
  // the pre-fix cache-valid predicate, verbatim (the NEGATIVE CONTROL: it says
  // "valid" for every fixture below, which is exactly why they were served)
  const preFixValid = (m, rp, size, mtime, cache) => !!m && m.size === size && m.mtime === mtime
    && (!m || !m.remotePath || m.remotePath === rp)
    && (() => { try { return fs.statSync(cache).size === size; } catch { return false; } })();
  const seedSlot = (s2, bytes, metaObj) => {
    fs.mkdirSync(path.dirname(s2.cache), { recursive: true });
    fs.writeFileSync(s2.cache, bytes);
    fs.writeFileSync(s2.cache + '.meta', JSON.stringify(metaObj));
  };
  const tick = rec({ timestamp: '2026-09-05T00:02:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 2 }, total_token_usage: { total_tokens: 9 } } } });

  {   // plain prefix + the compressed twin's bytes appended (the reported shape)
    const sl = slotOf('cccccccc-dddd-4eee-8fff-000000000001');
    const prefix = Buffer.from(rollout(sl.tid, '/work/heal', 'already corrupted slot', 1));
    const comp = zlib.zstdCompressSync(Buffer.from(rollout(sl.tid, '/work/heal', 'already corrupted slot', 3000)));
    ok(comp.length > prefix.length, 'fixture: the compressed twin is larger than the cached plain prefix (what the old delta path needed)');
    const hybrid = Buffer.concat([prefix, comp.subarray(prefix.length)]);   // byte-for-byte what the pre-fix delta wrote
    seedSlot(sl, hybrid, { size: comp.length, mtime: 2000, fetchedAt: Date.now(), slab: true });   // PRE-FIX meta shape
    remote.path = sl.remotePath + '.zst'; remote.data = comp; remote.mtime = 2000;
    ok(hybrid.length === comp.length && !hybrid.equals(comp) && !DF.isZstBuffer(hybrid), 'REPRO: the hybrid has the remote file\'s exact size and mtime, but neither file\'s bytes');
    ok(preFixValid(JSON.parse(fs.readFileSync(sl.cache + '.meta', 'utf8')), remote.path, comp.length, 2000, sl.cache), 'NEGATIVE CONTROL: the pre-fix predicate calls the hybrid VALID (vacuous sameRemote) — served forever');
    reads.length = 0;
    const healed = await hm.fetchTranscript('hz', 'codex', sl.tid);
    ok(fs.readFileSync(healed).equals(comp), 'a meta WITHOUT provenance is not valid: the slot refetches WHOLE and now holds the remote\'s bytes', reads);
    ok(metaOf(healed).remotePath === remote.path && metaOf(healed).compressed === true, '…and the rewritten meta carries the provenance the old one lacked');
    reads.length = 0;
    await hm.fetchTranscript('hz', 'codex', sl.tid);
    ok(reads.length === 0 && fs.readFileSync(sl.cache).equals(comp), 'the heal costs exactly ONE refetch — the next poll short-circuits on the HEALED bytes');
  }

  {   // the mirror shape: plain bytes appended onto a cached COMPRESSED file
    const sl = slotOf('cccccccc-dddd-4eee-8fff-000000000002');
    const text = rollout(sl.tid, '/work/heal2', 'reverse hybrid slot', 400);
    const plainBuf = Buffer.from(text), comp = zlib.zstdCompressSync(plainBuf);
    ok(comp.length < plainBuf.length, 'fixture: the cached compressed bytes are shorter than the returning plain file');
    seedSlot(sl, Buffer.concat([comp, plainBuf.subarray(comp.length)]), { size: plainBuf.length, mtime: 5000, fetchedAt: Date.now(), slab: true });
    remote.path = sl.remotePath; remote.data = plainBuf; remote.mtime = 5000;
    ok(preFixValid(JSON.parse(fs.readFileSync(sl.cache + '.meta', 'utf8')), remote.path, plainBuf.length, 5000, sl.cache), 'NEGATIVE CONTROL: the pre-fix predicate accepts the reverse hybrid too (zstd magic under a plain remote)');
    const healed = await hm.fetchTranscript('hz', 'codex', sl.tid);
    ok(fs.readFileSync(healed, 'utf8') === text, 'a cache whose MAGIC contradicts the resolved remote is refetched whole');
    ok(metaOf(healed).compressed === false && metaOf(healed).remotePath === sl.remotePath, '…with the plain remote recorded');
  }

  {   // an INTACT legacy slot: one refetch, then business as usual
    const sl = slotOf('cccccccc-dddd-4eee-8fff-000000000003');
    const text = rollout(sl.tid, '/work/heal3', 'intact legacy slot', 20);
    seedSlot(sl, Buffer.from(text), { size: Buffer.byteLength(text), mtime: 6000, fetchedAt: Date.now(), slab: true });
    remote.path = sl.remotePath; remote.data = Buffer.from(text); remote.mtime = 6000;
    reads.length = 0;
    const c = await hm.fetchTranscript('hz', 'codex', sl.tid);
    ok(fs.readFileSync(c, 'utf8') === text && reads.length === 1 && reads[0][1] === 0, `an intact pre-provenance slot refetches once too — the old meta cannot prove WHICH file filled it (${JSON.stringify(reads)})`);
    reads.length = 0;
    await hm.fetchTranscript('hz', 'codex', sl.tid);
    ok(reads.length === 0 && metaOf(c).remotePath === sl.remotePath, 'the healed slot short-circuits on the next poll (provenance stamped)');
    const grown = text + tick;
    remote.data = Buffer.from(grown); remote.mtime = 7000;
    reads.length = 0;
    const c2 = await hm.fetchTranscript('hz', 'codex', sl.tid);
    ok(fs.readFileSync(c2, 'utf8') === grown && reads.length === 1 && reads[0][1] === Buffer.byteLength(text), 'and the append-only DELTA win comes back after the heal');
  }

  {   // a legacy slot already PAST the fetch cap: a whole refetch is impossible
    // (the delta path is how it got there), so verified bytes adopt the
    // provenance instead of failing "remote transcript too large"
    const sl = slotOf('cccccccc-dddd-4eee-8fff-000000000004');
    const base = rollout(sl.tid, '/work/heal4', 'over the fetch cap', 300), grown = base + tick;
    seedSlot(sl, Buffer.from(base), { size: Buffer.byteLength(base), mtime: 8000, fetchedAt: Date.now(), slab: true });
    remote.path = sl.remotePath; remote.data = Buffer.from(grown); remote.mtime = 9000;
    reads.length = 0;
    let capErr = null;
    let c = null;
    try { c = await hm.fetchTranscript('hz', 'codex', sl.tid, { maxBytes: Buffer.byteLength(base) - 1 }); } catch (e) { capErr = String(e && e.message || e); }
    ok(!capErr && fs.readFileSync(c, 'utf8') === grown && reads.length === 1 && reads[0][1] === Buffer.byteLength(base), `a slot already past maxBytes keeps syncing deltas instead of hard-failing (${capErr || JSON.stringify(reads)})`);
    ok(metaOf(c).remotePath === sl.remotePath && metaOf(c).compressed === false, '…and gains provenance on the way through');
  }

  {   // the byte check is not only for old metas: a splice under a GOOD meta
    const sl = slotOf('cccccccc-dddd-4eee-8fff-000000000005');
    const text = rollout(sl.tid, '/work/heal5', 'spliced under a good meta', 30);
    const spliced = Buffer.concat([Buffer.from(text.slice(0, -50)), Buffer.alloc(50, 0)]);
    seedSlot(sl, spliced, { size: spliced.length, mtime: 9500, fetchedAt: Date.now(), slab: true, remotePath: sl.remotePath, compressed: false });
    remote.path = sl.remotePath; remote.data = Buffer.from(text); remote.mtime = 9500;
    ok(preFixValid(JSON.parse(fs.readFileSync(sl.cache + '.meta', 'utf8')), remote.path, spliced.length, 9500, sl.cache), 'NEGATIVE CONTROL: size + mtime + provenance all agree — only the BYTES say the cache is spliced');
    const c = await hm.fetchTranscript('hz', 'codex', sl.tid);
    ok(fs.readFileSync(c, 'utf8') === text, 'a cache whose TAIL is not text is refetched even under a provenance-carrying meta (an append always lands its foreign bytes at the tail)');
  }

  // ── ⑥c THE ADOPTION EXCEPTION'S BLIND SPOT + the un-stamped rungs (B-7638)
  // Three residuals the ⑥b verify pass confirmed:
  //  (1) the over-cap ADOPTION kept bytes verified by a 4 KB TAIL read only —
  //      but the pre-fix delta path kept appending AFTER it spliced, so the
  //      marker is buried and a corrupt slot was adopted as "verified";
  //  (2) neither rung wrote the adoption back, so the deep scan repeats every
  //      poll and the ssh rung (no delta path) fails "too large" on the next
  //      byte of growth;
  //  (3) a transcript shorter than the 4-byte magic could never be verified at
  //      all ⇒ fully re-pulled on EVERY poll, forever.
  console.log('— ⑥c the adoption scans the WHOLE file, records itself, and tiny transcripts verify');
  const tailOnlyClean = (b) => { const t = b.subarray(Math.max(0, b.length - 4096)); return !t.includes(0x00) && t.indexOf(DF.ZSTD_MAGIC) < 0; };
  // a REACHABLE legacy rung for the refusal cases: the slab path's cap error
  // falls through to ssh by design, and an ssh rung that cannot be reached at
  // all triggers the host-down memo (which serves the stale cache) — that
  // would hide the very refusal under test.
  const sshDead = () => { hm._ssh = async () => { throw new Error('the legacy ssh rung must not be needed here'); }; };
  const sshProbeOnly = () => {
    hm._hostDownUntil?.clear();
    hm._ssh = async (h, cmd) => {
      if (/^cat /.test(cmd)) throw new Error('the refusal path must never whole-cat an over-cap remote');
      return Buffer.from(`${remote.data.length} ${remote.mtime}\n${remote.path}\n`);
    };
  };

  {   // (1) a splice BURIED under later appends — invisible to the tail window
    const sl = slotOf('cccccccc-dddd-4eee-8fff-000000000006');
    const head = Buffer.from(rollout(sl.tid, '/work/buried', 'buried splice', 40));
    const foreign = zlib.zstdCompressSync(Buffer.from(rollout(sl.tid, '/work/buried', 'buried splice', 40))).subarray(0, 64);
    const later = Buffer.from(tick.repeat(80));                 // the appends that buried it
    ok(later.length > 4096, `fixture: the later appends bury the splice deeper than the 4 KB tail window (${later.length}B)`);
    const buried = Buffer.concat([head, foreign, later]);
    ok(tailOnlyClean(buried) && buried.indexOf(DF.ZSTD_MAGIC) >= 0, 'NEGATIVE CONTROL: a tail-only scan calls the buried hybrid verified — the marker is 6 KB from the end');
    seedSlot(sl, buried, { size: buried.length, mtime: 11000, fetchedAt: Date.now(), slab: true });   // PRE-FIX meta
    remote.path = sl.remotePath; remote.data = Buffer.concat([head, later, Buffer.alloc(foreign.length, 0x20)]); remote.mtime = 11000;
    reads.length = 0; sshProbeOnly();
    let err = null, got = null;
    try { got = await hm.fetchTranscript('hz', 'codex', sl.tid, { maxBytes: buried.length - 1 }); } catch (e) { err = String(e && e.message || e); }
    ok(!got, 'the over-cap adoption is refused: a splice buried under later appends is never served as verified', got && fs.readFileSync(got).equals(buried) ? 'SERVED THE HYBRID' : err);
    ok(/could not be verified/.test(err || ''), '…and the refusal names the real fault instead of a bare "too large"', err);
    ok(!(JSON.parse(fs.readFileSync(sl.cache + '.meta', 'utf8')).remotePath), 'a refused slot is NOT stamped with provenance (it would freeze the corruption in)');
    // ROUND 2: the suffix must not hand out a remedy that cannot work. It is
    // reachable ONLY when the remote is past the cap — where a whole refetch is
    // impossible by construction — so "delete it to re-sync" destroyed the only
    // local copy and failed identically.
    ok(!/delete it to re-sync/.test(err || '') && /cannot be re-fetched whole/.test(err || ''), 'the refusal states that the remote is past the cap, not a deletion that cannot repair anything', err);
    fs.rmSync(sl.cache); fs.rmSync(sl.cache + '.meta');                 // do exactly what the old text told the user to do
    let errAfterDelete = null;
    try { await hm.fetchTranscript('hz', 'codex', sl.tid, { maxBytes: buried.length - 1 }); } catch (e) { errAfterDelete = String(e && e.message || e); }
    ok(/too large/.test(errAfterDelete || '') && !fs.existsSync(sl.cache), 'NEGATIVE CONTROL: deleting the cache as the old text instructed fails identically — with the last local copy gone', errAfterDelete);
    sshDead(); hm._hostDownUntil?.clear();
  }

  {   // (1b) the chunked scan must see a magic that STRADDLES a chunk boundary
    const sl = slotOf('cccccccc-dddd-4eee-8fff-000000000007');
    const CH = 1 << 20;
    const filler = (n) => Buffer.from('{"t":"' + 'x'.repeat(Math.max(0, n - 9)) + '"}\n');
    const pre = filler(CH - 2);
    ok(pre.length === CH - 2, `fixture: the first chunk ends 2 bytes into the zstd magic (${pre.length})`);
    const straddle = Buffer.concat([pre, DF.ZSTD_MAGIC, filler(8192)]);
    ok(tailOnlyClean(straddle), 'NEGATIVE CONTROL: the straddling magic is also outside the tail window');
    seedSlot(sl, straddle, { size: straddle.length, mtime: 12000, fetchedAt: Date.now(), slab: true });
    remote.path = sl.remotePath; remote.data = Buffer.alloc(straddle.length, 0x20); remote.mtime = 12000; sshProbeOnly();
    let err2 = null, got2 = null;
    try { got2 = await hm.fetchTranscript('hz', 'codex', sl.tid, { maxBytes: straddle.length - 1 }); } catch (e) { err2 = String(e && e.message || e); }
    ok(!got2 && /could not be verified/.test(err2 || ''), 'a marker split across the 1 MiB chunk boundary is still caught (3-byte carry)', err2);
    sshDead(); hm._hostDownUntil?.clear();
  }

  {   // (1d) THE HYBRID THE SHIPPED CODE ALREADY STAMPED (round 2 of the verify).
      // Provenance is not evidence that the bytes were ever deep-checked: the
      // tail-only adoption accepted a buried hybrid and the delta path then
      // wrote remotePath onto that very slot — so `sameRemote` is TRUE for
      // exactly the corruption the whole-file scan exists to find, and gating
      // the scan on "no provenance" would serve those slots forever. Any meta
      // written before this fix (no schema marker) owes ONE whole-file scan.
    const sl = slotOf('cccccccc-dddd-4eee-8fff-00000000000d');
    const head = Buffer.from(rollout(sl.tid, '/work/stamped', 'already-stamped hybrid', 40));
    const foreign = zlib.zstdCompressSync(Buffer.from(rollout(sl.tid, '/work/stamped', 'already-stamped hybrid', 40))).subarray(0, 64);
    const later = Buffer.from(tick.repeat(80));
    const buried = Buffer.concat([head, foreign, later]);
    ok(tailOnlyClean(buried) && buried.indexOf(DF.ZSTD_MAGIC) >= 0, 'NEGATIVE CONTROL: the tail window sees nothing wrong with this slot either');
    // the meta the SHIPPED adoption + delta path left behind: provenance, no schema marker
    seedSlot(sl, buried, { size: buried.length, mtime: 19000, fetchedAt: Date.now(), slab: true, remotePath: sl.remotePath, compressed: false });
    remote.path = sl.remotePath; remote.data = Buffer.concat([head, later, Buffer.alloc(foreign.length, 0x20)]); remote.mtime = 19000;
    sshProbeOnly();
    let e3 = null, g3 = null;
    try { g3 = await hm.fetchTranscript('hz', 'codex', sl.tid, { maxBytes: buried.length - 1 }); } catch (e) { e3 = String(e && e.message || e); }
    ok(!g3 && /could not be verified/.test(e3 || ''), 'a hybrid that already CARRIES provenance is deep-checked once and refused (sameRemote is not evidence of verified bytes)', g3 ? 'SERVED THE HYBRID' : e3);
    sshDead(); hm._hostDownUntil?.clear();
  }

  {   // (1e) …and that scan is paid ONCE: a clean legacy slot is verified,
      // re-stamped with the schema marker, and tail-only from then on.
    const sl = slotOf('cccccccc-dddd-4eee-8fff-00000000000e');
    const clean = Buffer.from(rollout(sl.tid, '/work/stampedok', 'clean legacy-provenance slot', 400));
    seedSlot(sl, clean, { size: clean.length, mtime: 20000, fetchedAt: Date.now(), slab: true, remotePath: sl.remotePath, compressed: false });
    remote.path = sl.remotePath; remote.data = clean; remote.mtime = 20000;
    const origReadSync = fs.readSync, deepReads = [];
    fs.readSync = (fd, buf, off, len, pos) => { if (off === 3) deepReads.push(len); return origReadSync(fd, buf, off, len, pos); };  // offset 3 = the carry buffer, unique to the whole-file scan
    try {
      reads.length = 0;
      const p1 = await hm.fetchTranscript('hz', 'codex', sl.tid);
      ok(fs.readFileSync(p1).equals(clean) && reads.length === 0 && deepReads.length > 0, 'a legacy-provenance slot is whole-file verified before its bytes are trusted (and then served, no refetch)', { deepReads, reads });
      ok(metaOf(p1).v >= 2, '…and re-stamped with the schema marker every meta writer now carries', metaOf(p1));
      const n1 = deepReads.length;
      await hm.fetchTranscript('hz', 'codex', sl.tid);
      ok(deepReads.length === n1, 'the whole-file scan is paid ONCE per slot, never per poll (the next poll is tail-only)', { first: n1, after: deepReads.length });
    } finally { fs.readSync = origReadSync; }
  }

  {   // (1c) POSITIVE CONTROL + (2) the adoption is stamped once, on BOTH rungs
    const sl = slotOf('cccccccc-dddd-4eee-8fff-000000000008');
    const big = Buffer.from(rollout(sl.tid, '/work/bigclean', 'clean over-cap slot', 9000));
    ok(big.length > (1 << 20), `fixture: the clean slot spans more than one scan chunk (${big.length}B)`);
    seedSlot(sl, big, { size: big.length, mtime: 13000, fetchedAt: Date.now(), slab: true });          // PRE-FIX meta
    remote.path = sl.remotePath; remote.data = big; remote.mtime = 13000;
    reads.length = 0;
    const c8 = await hm.fetchTranscript('hz', 'codex', sl.tid, { maxBytes: big.length - 1 });
    ok(fs.readFileSync(c8).equals(big) && reads.length === 0, 'a CLEAN over-cap slot still adopts after the whole-file scan (no false positive, no refetch)', reads);
    const m8 = metaOf(c8);
    ok(m8.remotePath === sl.remotePath && m8.compressed === false && m8.adopted === true, 'the adoption is WRITTEN BACK (provenance + an `adopted` marker) — the deep scan is paid once, not per poll', m8);
  }

  {   // (2) the ssh rung — no data plane at all — must stamp the adoption too,
      // AND be able to GROW the slot it adopted. ROUND 2 of the verify: the
      // stamp alone changes nothing here. The short-circuit needs
      // meta.size === size, so the very next byte of growth fell straight into
      // "remote transcript too large" with no fallback — a >maxBytes transcript
      // that opened yesterday was an error today. The rung now carries the same
      // append-only delta the slab rung has had since 2.187.0, and every poll
      // below keeps the SAME cap the slot was adopted under (dropping the cap on
      // the growth poll is what let the un-fixed rung look green).
    const sshHm = new HostManager({ dataDir });
    sshHm._state.hosts.push({ id: 'hssh', name: 'S' });                    // no transport ⇒ legacy ssh rung
    const sl = { tid: 'cccccccc-dddd-4eee-8fff-000000000009', remotePath: '/home/u/.codex/sessions/2026/09/05/rollout-2026-09-05T00-00-00-cccccccc-dddd-4eee-8fff-000000000009.jsonl', cache: path.join(dataDir, 'remote-jsonl', 'hssh', 'codex', 'cccccccc-dddd-4eee-8fff-000000000009.jsonl') };
    const body = Buffer.from(rollout(sl.tid, '/work/ssh', 'over-cap slot on the ssh rung', 300));
    const CAP = body.length - 1;                                           // the slot is ALREADY past the fetch cap
    const cats = [], tails = [];
    const rem = { bytes: body, size: body.length, mtime: 14000 };          // what the host reports vs what it serves
    sshHm._ssh = async (h, cmd) => {
      if (/^cat /.test(cmd)) { cats.push(cmd); return rem.bytes; }
      const m = /^tail -c \+(\d+) /.exec(cmd);
      if (m) { tails.push(Number(m[1])); return rem.bytes.subarray(Number(m[1]) - 1); }   // `tail -c +N` is 1-based
      return Buffer.from(`${rem.size} ${rem.mtime}\n${sl.remotePath}\n`);
    };
    seedSlot(sl, body, { size: body.length, mtime: 14000, fetchedAt: Date.now() });                    // PRE-FIX meta
    const c9 = await sshHm.fetchTranscript('hssh', 'codex', sl.tid, { maxBytes: CAP });
    ok(fs.readFileSync(c9).equals(body) && cats.length === 0, 'the ssh rung adopts an over-cap verified slot without re-pulling it', cats);
    const m9 = JSON.parse(fs.readFileSync(sl.cache + '.meta', 'utf8'));
    ok(m9.remotePath === sl.remotePath && m9.adopted === true, 'the ssh rung STAMPS the meta before returning (it used to hand the cache back provenance-less forever)', m9);
    // …and now the remote grows, under the cap it was adopted with
    const grown = Buffer.concat([body, Buffer.from(tick)]);
    rem.bytes = grown; rem.size = grown.length; rem.mtime = 15000;
    ok(grown.length > CAP, `fixture: a whole re-pull is still impossible (${grown.length}B remote vs a ${CAP}B cap) — the growth rides a delta or not at all`);
    let growErr = null, c9b = null;
    try { c9b = await sshHm.fetchTranscript('hssh', 'codex', sl.tid, { maxBytes: CAP }); } catch (e) { growErr = String(e && e.message || e); }
    ok(!growErr && c9b && fs.readFileSync(c9b).equals(grown), 'an over-cap ssh slot GROWS instead of hard-failing "too large" on its next byte (forever, since nothing else can move)', growErr);
    ok(cats.length === 0 && tails.length === 1 && tails[0] === body.length + 1, `…by an append-only tail delta off the cached prefix, never a whole cat (${JSON.stringify({ cats: cats.length, tails })})`);
    const m9b = JSON.parse(fs.readFileSync(sl.cache + '.meta', 'utf8'));
    ok(m9b.size === grown.length && m9b.mtime === 15000 && m9b.v >= 2, '…and the meta follows the growth (schema marker carried by every writer)', m9b);
    // a LIVE transcript overtakes the stat between probe and read: the extra
    // tail bytes ARE the file's next bytes (append-only), so they are kept and
    // the meta stamps what the cache actually holds — the stump check compares
    // the two, and a hard failure here would be a regression on the last rung.
    const grown2 = Buffer.concat([grown, Buffer.from(tick)]);
    rem.bytes = grown2; rem.size = grown.length + 1; rem.mtime = 16000;
    const c9c = await sshHm.fetchTranscript('hssh', 'codex', sl.tid, { maxBytes: CAP });
    const m9c = JSON.parse(fs.readFileSync(sl.cache + '.meta', 'utf8'));
    ok(fs.readFileSync(c9c).equals(grown2) && m9c.size === grown2.length, 'a read that overtakes the stat keeps the extra bytes and stamps the REAL size', m9c);
    // …but FEWER bytes than the stat promised is a truncated read: never stamped
    rem.size = grown2.length + Buffer.byteLength(tick); rem.mtime = 17000;   // promises bytes the host will not serve
    const metaBefore = fs.readFileSync(sl.cache + '.meta', 'utf8');
    let shortErr = null;
    try { await sshHm.fetchTranscript('hssh', 'codex', sl.tid, { maxBytes: CAP }); } catch (e) { shortErr = String(e && e.message || e); }
    ok(/short tail read/.test(shortErr || ''), 'a truncated tail read throws instead of stamping bytes we did not get (the 2.187.0 stump rule)', shortErr);
    ok(fs.readFileSync(sl.cache + '.meta', 'utf8') === metaBefore, '…and the meta is left exactly as it was', fs.readFileSync(sl.cache + '.meta', 'utf8'));
    // NEGATIVE CONTROL: a slot whose bytes do NOT verify has no prefix to grow
    // from — the honest cap error, not a silent delta off unverified bytes
    fs.writeFileSync(sl.cache, Buffer.concat([grown2.subarray(0, grown2.length - 8), Buffer.alloc(8, 0)]));
    rem.bytes = grown2; rem.size = grown2.length + 1; rem.mtime = 18000;
    const tailsBefore = tails.length;
    let badErr = null;
    try { await sshHm.fetchTranscript('hssh', 'codex', sl.tid, { maxBytes: CAP }); } catch (e) { badErr = String(e && e.message || e); }
    ok(/too large/.test(badErr || '') && /could not be verified/.test(badErr || '') && tails.length === tailsBefore && cats.length === 0, 'NEGATIVE CONTROL: an unverifiable cache is never delta-grown — the cap error names the real fault instead', { badErr, tails });
  }

  {   // (3) a transcript SHORTER than the 4-byte magic must verify, not re-pull
    const sl = slotOf('cccccccc-dddd-4eee-8fff-00000000000a');
    const tiny = Buffer.from('{}\n');
    seedSlot(sl, tiny, { size: tiny.length, mtime: 16000, fetchedAt: Date.now(), slab: true, remotePath: sl.remotePath, compressed: false });
    remote.path = sl.remotePath; remote.data = tiny; remote.mtime = 16000;
    reads.length = 0;
    const ct = await hm.fetchTranscript('hz', 'codex', sl.tid);
    ok(fs.readFileSync(ct).equals(tiny) && reads.length === 0, 'a 3-byte transcript short-circuits on its cache (it used to be fully re-pulled on EVERY poll — nothing to judge by the 4-byte magic)', reads);
    // …but the head still has to look like a record, and a compressed remote
    // can never be shorter than its own magic
    const sl2 = slotOf('cccccccc-dddd-4eee-8fff-00000000000b');
    seedSlot(sl2, Buffer.from('xy'), { size: 2, mtime: 17000, fetchedAt: Date.now(), slab: true, remotePath: sl2.remotePath, compressed: false });
    remote.path = sl2.remotePath; remote.data = Buffer.from(rollout(sl2.tid, '/work/tiny2', 'not a record head', 2)); remote.mtime = 17000;
    reads.length = 0;
    const ct2 = await hm.fetchTranscript('hz', 'codex', sl2.tid);
    ok(reads.length === 1 && fs.readFileSync(ct2, 'utf8').startsWith('{'), 'NEGATIVE CONTROL: a short cache that does not start with a record is still refetched', reads);
    const sl3 = slotOf('cccccccc-dddd-4eee-8fff-00000000000c');
    const zbody = zlib.zstdCompressSync(Buffer.from(rollout(sl3.tid, '/work/tiny3', 'compressed twin', 3)));
    seedSlot(sl3, Buffer.from([0x28, 0xb5]), { size: 2, mtime: 18000, fetchedAt: Date.now(), slab: true, remotePath: sl3.remotePath + '.zst', compressed: true });
    remote.path = sl3.remotePath + '.zst'; remote.data = zbody; remote.mtime = 18000;
    reads.length = 0;
    const ct3 = await hm.fetchTranscript('hz', 'codex', sl3.tid);
    ok(reads.length === 1 && fs.readFileSync(ct3).equals(zbody), 'NEGATIVE CONTROL: a 2-byte cache under a COMPRESSED remote is never called verified (a zstd frame is never shorter than its magic)', reads);
  }
}
try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
