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
//   ⑥f ONE WRITER PER SLOT: two overlapping fetches coalesce (one remote read,
//      one append) and an append offset the slot has moved past is refetched
//      whole instead of spliced — both rungs, each with its pre-fix repro
//   ⑥g …and that refusal is TERMINAL: it survives the data-plane fallback
//      (typed verdict + the movement outliving its rung + "grow only what we
//      stamped"), the fallback logs whatever it does swallow VERBATIM, and the
//      whole `cat` stamps the bytes it fetched — pre-fix repro + leg isolation
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
    // ROUND 3: …and the delta that GROWS that slot must not erase it. Both
    // rungs stamped a FRESH meta object, so the very next byte of growth
    // dropped `adopted` (and `slab`) and the slot became indistinguishable
    // from one this code had pulled whole — the opposite of the durable
    // provenance the adoption note promises.
    const grown8 = Buffer.concat([big, Buffer.from(tick)]);
    remote.data = grown8; remote.mtime = 13001;
    reads.length = 0;
    const c8b = await hm.fetchTranscript('hz', 'codex', sl.tid, { maxBytes: big.length - 1 });
    const m8b = metaOf(c8b);
    ok(fs.readFileSync(c8b).equals(grown8) && reads.length === 1 && reads[0][1] === big.length, 'the adopted over-cap slot grows by an append-only delta', reads);
    ok(m8b.adopted === true && m8b.slab === true && m8b.size === grown8.length, 'a DELTA carries the prior meta forward — `adopted` (these bytes were VERIFIED, never fetched) and the lane marker survive the growth', m8b);
    // …and a WHOLE refetch legitimately drops it: every byte is now ours
    remote.data = big; remote.mtime = 13002;                               // the remote rotated smaller ⇒ no prefix ⇒ whole
    reads.length = 0;
    const c8c = await hm.fetchTranscript('hz', 'codex', sl.tid);
    const m8c = metaOf(c8c);
    ok(fs.readFileSync(c8c).equals(big) && reads.length === 1 && reads[0][1] === 0 && m8c.adopted === undefined && m8c.slab === true,
      'NEGATIVE CONTROL: a WHOLE refetch clears `adopted` — it describes bytes that are no longer in the slot (the lane marker is re-stamped by the writer that fetched them)', m8c);
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
    ok(m9b.adopted === true, 'ROUND 3: the ssh delta keeps the adoption marker too — this rung\'s meta writer spreads the prior meta instead of rebuilding it (the twin of the slab-rung leg above)', m9b);
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

  // ── ⑥d BOTH SIDES COMPRESSED — the growth leg the compression clause
  // exists for (round 3 of the verify). A host RE-compresses a finished
  // rollout: the remote keeps its path, the cache already holds .zst bytes,
  // and every OTHER delta precondition holds — same remote file, verified
  // bytes (for a compressed slot the magic IS the evidence), cached archive
  // shorter than the remote. `!isZstPath(remotePath) && !cacheIsCompressed()`
  // is the ONLY thing between that poll and a spliced archive, and deleting it
  // left this suite ALL PASS on BOTH rungs. Both copies now carry a leg.
  console.log('— ⑥d a re-compressed .zst remote over a .zst cache is refetched WHOLE (both rungs)');
  // the legality test with its compression clause DELETED — i.e. what BOTH
  // rungs reduce to under that mutation; it calls the growth below legal
  const deltaLegalMinusCompressionClause = (usable, localSize, size) => !!usable && localSize > 0 && localSize <= size;
  const plainOf = (b) => { try { return DF.zstdDecompressFrames(b).toString(); } catch { return '\u0000undecompressable'; } };
  {   // the slab (device data-plane) rung
    const sl = slotOf('cccccccc-dddd-4eee-8fff-00000000000f');
    const zt1 = rollout(sl.tid, '/work/zgrow', 'compressed on both sides', 200);
    const zc1 = zlib.zstdCompressSync(Buffer.from(zt1));
    remote.path = sl.remotePath + '.zst'; remote.data = zc1; remote.mtime = 21000;
    reads.length = 0;
    const z1 = await hm.fetchTranscript('hz', 'codex', sl.tid);
    ok(fs.readFileSync(z1).equals(zc1) && metaOf(z1).compressed === true && reads.length === 1 && reads[0][1] === 0, 'the compressed remote is cached whole (the slot now holds .zst bytes)', reads);
    const zt2 = zt1 + tick.repeat(60);
    const zc2 = zlib.zstdCompressSync(Buffer.from(zt2));                    // the SAME path, re-compressed after more turns
    ok(zc2.length > zc1.length && !zc2.subarray(0, zc1.length).equals(zc1), `fixture: the re-compressed archive is larger and is NOT an append onto the old one (${zc1.length}→${zc2.length}B)`);
    ok(deltaLegalMinusCompressionClause(true, zc1.length, zc2.length) && metaOf(z1).remotePath === remote.path && DF.isZstBuffer(fs.readFileSync(sl.cache)),
      'NEGATIVE CONTROL: every OTHER delta precondition holds — same remote path, a verified (magic-checked) cache, a cached prefix shorter than the remote');
    const spliced = Buffer.concat([zc1, zc2.subarray(zc1.length)]);         // what the guard-less delta would write
    ok(!spliced.equals(zc2) && plainOf(spliced) !== zt2, 'NEGATIVE CONTROL: that delta would weld a foreign frame tail onto the old frames — the slot decompresses to the OLD transcript and the growth is silently lost', plainOf(spliced).length);
    remote.data = zc2; remote.mtime = 22000;
    reads.length = 0;
    const z2 = await hm.fetchTranscript('hz', 'codex', sl.tid);
    ok(fs.readFileSync(z2).equals(zc2), 'a RE-COMPRESSED remote over a compressed cache is refetched WHOLE — never delta-appended (re-compression rewrites the archive, it does not append)');
    ok(reads.length === 1 && reads[0][1] === 0 && reads[0][2] === zc2.length, `…by one whole read from offset 0, not a tail off the cached archive's length (${JSON.stringify(reads)})`);
    ok(plainOf(fs.readFileSync(z2)) === zt2 && metaOf(z2).compressed === true, '…and the cache decompresses to the whole re-compressed transcript');
  }
  {   // …and the SAME leg on the legacy ssh rung: the two legality tests are
      // twins, and a guard only one copy carries is the drift this batch keeps
      // paying for (a one-sided edit must fail a suite).
    const sshHm2 = new HostManager({ dataDir });
    sshHm2._state.hosts.push({ id: 'hz2', name: 'S2' });                    // no transport ⇒ legacy ssh rung
    const tid = 'cccccccc-dddd-4eee-8fff-000000000010';
    const rpath = `/home/u/.codex/sessions/2026/09/05/rollout-2026-09-05T00-00-00-${tid}.jsonl.zst`;
    const zt1 = rollout(tid, '/work/zgrow-ssh', 'compressed on both sides, ssh rung', 200);
    const zc1 = zlib.zstdCompressSync(Buffer.from(zt1));
    const zt2 = zt1 + tick.repeat(60);
    const zc2 = zlib.zstdCompressSync(Buffer.from(zt2));
    const cats = [], tails = [];
    const rem = { bytes: zc1, mtime: 23000 };
    sshHm2._ssh = async (h, cmd) => {
      if (/^cat /.test(cmd)) { cats.push(cmd); return rem.bytes; }
      const m = /^tail -c \+(\d+) /.exec(cmd);
      if (m) { tails.push(Number(m[1])); return rem.bytes.subarray(Number(m[1]) - 1); }
      return Buffer.from(`${rem.bytes.length} ${rem.mtime}\n${rpath}\n`);
    };
    const p1 = await sshHm2.fetchTranscript('hz2', 'codex', tid);
    ok(fs.readFileSync(p1).equals(zc1) && cats.length === 1 && tails.length === 0, 'ssh rung: the compressed remote is cached whole');
    rem.bytes = zc2; rem.mtime = 24000;
    ok(deltaLegalMinusCompressionClause(true, zc1.length, zc2.length), 'NEGATIVE CONTROL: the ssh legality test minus its compression clause calls this growth a legal delta too');
    const p2 = await sshHm2.fetchTranscript('hz2', 'codex', tid);
    ok(fs.readFileSync(p2).equals(zc2) && cats.length === 2 && tails.length === 0, `ssh rung: a re-compressed remote is whole-cat'ed, never tail-appended (${JSON.stringify({ cats: cats.length, tails })})`);
    ok(plainOf(fs.readFileSync(p2)) === zt2, '…and the cached archive decompresses to the whole transcript (a spliced one would stop at the old text)');
  }

  // ── ⑥e THE DELTA IS AN OPTIMISATION, NOT THE ONLY ROAD (round 3). Round 2
  // replaced the whole `cat` on the LAST rung with the delta and left nothing
  // under it: a `tail` that fails — the remote truncated/rotated between the
  // stat and the read, or a host whose `tail` has no `-c +N` — hard-failed a
  // fetch the pre-delta code completed. Under the cap the whole file is still
  // fetchable; over it the delta really was the only road, so THERE the
  // failure stays a failure.
  console.log('— ⑥e a failed ssh tail delta falls back to the whole cat (under the cap only)');
  {
    const sshHm3 = new HostManager({ dataDir });
    sshHm3._state.hosts.push({ id: 'hz3', name: 'S3' });
    const tid = 'cccccccc-dddd-4eee-8fff-000000000011';
    const rpath = `/home/u/.codex/sessions/2026/09/05/rollout-2026-09-05T00-00-00-${tid}.jsonl`;
    const cache = path.join(dataDir, 'remote-jsonl', 'hz3', 'codex', `${tid}.jsonl`);
    const body = Buffer.from(rollout(tid, '/work/ssh-fallback', 'the delta is not the only road', 40));
    const grown = Buffer.concat([body, Buffer.from(tick)]);
    const cats = [], tails = [];
    let tailMode = 'ok';
    const rem = { bytes: grown, size: grown.length, mtime: 26000 };
    sshHm3._ssh = async (h, cmd) => {
      if (/^cat /.test(cmd)) { cats.push(cmd); return rem.bytes; }
      const m = /^tail -c \+(\d+) /.exec(cmd);
      if (m) {
        tails.push(Number(m[1]));
        if (tailMode === 'throw') throw new Error('tail: illegal option -- c');                       // a host whose tail has no -c +N
        if (tailMode === 'short') return rem.bytes.subarray(Number(m[1]) - 1, Number(m[1]) + 2);      // rotated between the stat and the read
        return rem.bytes.subarray(Number(m[1]) - 1);
      }
      return Buffer.from(`${rem.size} ${rem.mtime}\n${rpath}\n`);
    };
    const metaAt = () => JSON.parse(fs.readFileSync(cache + '.meta', 'utf8'));
    const seedFallback = () => {
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      fs.writeFileSync(cache, body);
      fs.writeFileSync(cache + '.meta', JSON.stringify({ size: body.length, mtime: 25000, fetchedAt: Date.now(), remotePath: rpath, compressed: false, v: 2, adopted: true }));
      cats.length = 0; tails.length = 0;
    };

    seedFallback(); tailMode = 'throw';
    let fbErr = null, f1 = null;
    try { f1 = await sshHm3.fetchTranscript('hz3', 'codex', tid); } catch (e) { fbErr = String(e && e.message || e); }
    ok(!fbErr && f1 && fs.readFileSync(f1).equals(grown) && tails.length === 1 && cats.length === 1,
      `a \`tail\` the host cannot run falls back to the whole cat — the fetch COMPLETES instead of hard-failing what the pre-delta code did (${fbErr || JSON.stringify({ cats: cats.length, tails })})`);
    ok(metaAt().size === grown.length && metaAt().mtime === 26000, '…and stamps the bytes the fallback actually fetched', metaAt());
    ok(metaAt().adopted === undefined, '…while the WHOLE refetch drops the `adopted` marker (it described bytes no longer in the slot)', metaAt());

    seedFallback(); tailMode = 'short';
    let shortFbErr = null, f2 = null;
    try { f2 = await sshHm3.fetchTranscript('hz3', 'codex', tid); } catch (e) { shortFbErr = String(e && e.message || e); }
    ok(!shortFbErr && f2 && fs.readFileSync(f2).equals(grown) && cats.length === 1,
      `a SHORT tail (the remote rotated between the stat and the read) falls back too — truncated bytes are never appended, the whole file is (${shortFbErr || JSON.stringify({ cats: cats.length, tails })})`);

    // NEGATIVE CONTROL: over the cap a whole cat is impossible by construction
    // (it is how the slot got there), so the delta failure stays a failure and
    // no `cat` is attempted — the fallback must not become a cap bypass.
    seedFallback(); tailMode = 'throw';
    let overErr = null;
    try { await sshHm3.fetchTranscript('hz3', 'codex', tid, { maxBytes: body.length - 1 }); } catch (e) { overErr = String(e && e.message || e); }
    ok(/illegal option/.test(overErr || '') && cats.length === 0, 'NEGATIVE CONTROL: over the cap the delta failure is still a hard failure and never a whole cat (which could not fit anyway)', { overErr, cats: cats.length });
    ok(fs.readFileSync(cache).equals(body) && metaAt().size === body.length && metaAt().adopted === true, '…and the refused poll leaves the cache and its meta exactly as they were', metaAt());
  }

  // ── ⑥f TWO OVERLAPPING FETCHES OF ONE SLOT (B-7638 round 4). Both rungs are
  // read-then-append against a size measured BEFORE the remote read, and
  // nothing serialized the slot: the 5s session poll and a user opening the
  // window (or two clients, or goal-sync and an attach) each computed the same
  // offset from the same stat and each appended the same tail — the cache grew
  // a DUPLICATED region. That alone self-heals (the doubled file no longer
  // matches its meta ⇒ whole refetch), which is why it survived every earlier
  // review; the permanent damage comes one poll later: once the remote passes
  // the doubled size the delta legality test holds again, the next tail is
  // appended at the doubled offset and the stamp says COMPLETE — with a region
  // duplicated and the region behind it MISSING, on a stopped conversation
  // that never changes again. Fixed by two independent legs, each with its own
  // negative control: the slot is single-flighted (one fetch per slot at a
  // time) AND the append refuses any offset that is no longer the end of the
  // file (positional write; whole refetch under the cap, loud over it).
  console.log('— ⑥f one writer per cache slot: overlapping fetches coalesce, a moved slot is never spliced');
  {
    const tickN = (n) => rec({ timestamp: `2026-09-05T00:${String(n).padStart(2, '0')}:00.000Z`, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: n, cached_input_tokens: n, output_tokens: n }, total_token_usage: { total_tokens: 3 * n } } } });
    // DISTINCT records per tick: a duplicated region built from IDENTICAL ones is
    // byte-identical to the correct file, and the repro would silently pass.
    const ticks = (from, n) => Array.from({ length: n }, (_, i) => tickN(from + i)).join('');
    const slotFor = (hid, tid) => ({
      tid,
      remotePath: `/home/u/.codex/sessions/2026/09/05/rollout-2026-09-05T00-00-00-${tid}.jsonl`,
      cache: path.join(dataDir, 'remote-jsonl', hid, 'codex', `${tid}.jsonl`),
    });
    const seedFor = (sl, bytes, mtime) => {
      fs.mkdirSync(path.dirname(sl.cache), { recursive: true });
      fs.writeFileSync(sl.cache, bytes);
      fs.writeFileSync(sl.cache + '.meta', JSON.stringify({ size: bytes.length, mtime, fetchedAt: Date.now(), remotePath: sl.remotePath, compressed: false, v: 2 }));
    };
    const gateOf = () => { const g = {}; g.p = new Promise((r) => { g.open = r; }); return g; };
    const countAppends = (hmx) => {
      const orig = hmx._appendDeltaAt.bind(hmx);
      const c = { n: 0 };
      hmx._appendDeltaAt = (p2, off, b) => { c.n++; return orig(p2, off, b); };
      return c;
    };
    const blindAppend = (hmx) => { hmx._appendDeltaAt = (p2, off, b) => { fs.appendFileSync(p2, b); return true; }; };            // the PRE-FIX write, verbatim
    const noSingleFlight = (hmx) => { hmx._fetchRemoteByFind = function (...a) { return this._fetchRemoteByFindOnce(...a); }; };  // the PRE-FIX entry point
    const noStampGuard = (hmx) => { hmx._prefixIsOurs = () => true; };                                                           // the PRE-FIX delta legality (round 5's leg removed)
    const noHeal = (hmx) => { hmx._overStampedLegacySlot = () => false; };                                                       // the PRE-FIX code has no over-stamp heal (round 6's leg removed)
    const dialHm = (hid, rem, reads2, gate) => {
      const hmx = new HostManager({ dataDir });
      hmx._state.hosts.push({ id: hid, name: hid, transport: 'dial' });
      hmx._ssh = async () => { throw new Error('the legacy ssh rung must not be needed here'); };
      hmx.deviceBounded = async () => ({
        runCmd: async () => ({ stdout: rem.path + '\n', stderr: '', code: 0 }),
        fsStat: async () => ({ stat: { size: rem.bytes.length, mtimeMs: rem.mtime * 1000 } }),
        fsReadRange: async (p2, off, len) => {
          reads2.push([off, len]);
          if (gate && gate.p) await gate.p;
          if (rem.beforeRead) { rem.beforeRead(); rem.beforeRead = null; }
          return { data: rem.bytes.subarray(off, off + len) };
        },
      });
      return hmx;
    };
    const sshHm = (hid, rem, log) => {
      const hmx = new HostManager({ dataDir });
      hmx._state.hosts.push({ id: hid, name: hid });
      hmx._ssh = async (h, cmd) => {
        if (/^cat /.test(cmd)) { log.cats.push(cmd); return rem.bytes; }
        const m = /^tail -c \+(\d+) /.exec(cmd);
        if (m) {
          log.tails.push(Number(m[1]));
          if (rem.gate && rem.gate.p) await rem.gate.p;
          if (rem.beforeRead) { rem.beforeRead(); rem.beforeRead = null; }
          return rem.bytes.subarray(Number(m[1]) - 1);
        }
        return Buffer.from(`${rem.bytes.length} ${rem.mtime}\n${rem.path}\n`);
      };
      return hmx;
    };

    // (A) SLAB RUNG — two overlapping fetches of one slot
    {
      const sl = slotFor('hf1', 'cccccccc-dddd-4eee-8fff-000000000020');
      const prefix = Buffer.from(rollout(sl.tid, '/work/race', 'two clients, one slot', 40));
      const grown = Buffer.concat([prefix, Buffer.from(ticks(1, 3))]);
      seedFor(sl, prefix, 30000);
      const rem = { path: sl.remotePath, bytes: grown, mtime: 30001 };
      const reads2 = [], gate = gateOf();
      const hmA = dialHm('hf1', rem, reads2, gate);
      const appends = countAppends(hmA);
      const c1 = hmA.fetchTranscript('hf1', 'codex', sl.tid);
      await sleep(20);                                   // the first fetch is parked inside its remote read
      const c2 = hmA.fetchTranscript('hf1', 'codex', sl.tid);
      await sleep(20);                                   // …and so is the second, if anything let it get that far
      gate.open();
      const [p1, p2] = await Promise.all([c1, c2]);
      const got = fs.readFileSync(sl.cache);
      ok(p1 === p2 && reads2.length === 1 && reads2[0][0] === prefix.length && appends.n === 1,
        `two overlapping fetches of one slot = ONE remote read and ONE append (${JSON.stringify({ reads: reads2, appends: appends.n, same: p1 === p2 })})`);
      ok(got.equals(grown) && JSON.parse(fs.readFileSync(sl.cache + '.meta', 'utf8')).size === grown.length,
        `…and the cache is byte-exact (${got.length} vs ${grown.length}B)`);
    }

    // (A′) NEGATIVE CONTROL: the same race with BOTH legs removed — the cache
    // doubles, and the poll after the remote passes the doubled size stamps
    // the duplicated file COMPLETE and serves it forever.
    {
      const sl = slotFor('hf2', 'cccccccc-dddd-4eee-8fff-000000000021');
      const prefix = Buffer.from(rollout(sl.tid, '/work/race', 'pre-fix doubling', 40));
      const delta = Buffer.from(ticks(1, 3));
      const grown = Buffer.concat([prefix, delta]);
      seedFor(sl, prefix, 31000);
      const rem = { path: sl.remotePath, bytes: grown, mtime: 31001 };
      const reads2 = [], gate = gateOf();
      const hmB = dialHm('hf2', rem, reads2, gate);
      blindAppend(hmB); noSingleFlight(hmB); noStampGuard(hmB);   // round 5's leg is removed too — the SEAL below is what it independently blocks (⑥g/E)
      const c1 = hmB.fetchTranscript('hf2', 'codex', sl.tid);
      await sleep(20);
      const c2 = hmB.fetchTranscript('hf2', 'codex', sl.tid);
      await sleep(20);                                   // BOTH offsets are computed before EITHER append — the real race
      gate.open();
      await Promise.all([c1, c2]);
      const doubled = fs.readFileSync(sl.cache);
      ok(reads2.length === 2 && doubled.length === prefix.length + 2 * delta.length && doubled.subarray(prefix.length).equals(Buffer.concat([delta, delta])),
        `REPRO: without the guards both fetches append the SAME tail — the cache carries a duplicated region (${doubled.length} vs ${grown.length}B)`);
      // …and one more poll, once the remote has passed the doubled size, seals it
      const grown2 = Buffer.concat([grown, Buffer.from(ticks(4, 4))]);
      ok(grown2.length > doubled.length, 'fixture: the remote grows past the doubled cache (what makes the corruption permanent)');
      rem.bytes = grown2; rem.mtime = 31002;
      reads2.length = 0;
      const cSealed = await hmB.fetchTranscript('hf2', 'codex', sl.tid);
      const sealed = fs.readFileSync(cSealed);
      ok(sealed.length === grown2.length && !sealed.equals(grown2) && JSON.parse(fs.readFileSync(sl.cache + '.meta', 'utf8')).size === grown2.length,
        `REPRO: the next delta stamps the spliced file COMPLETE — right size, wrong bytes (duplicated region + the records behind it lost) ${JSON.stringify({ sealed: sealed.length, want: grown2.length, meta: JSON.parse(fs.readFileSync(sl.cache + '.meta', 'utf8')).size, equal: sealed.equals(grown2), reads: reads2 })}`);
      reads2.length = 0;
      await hmB.fetchTranscript('hf2', 'codex', sl.tid);
      ok(reads2.length === 0, 'REPRO: and the corrupt slot then short-circuits on every later poll — served forever (a stopped thread never changes again)');
    }

    // (B) SSH RUNG — the same race on the last rung
    {
      const sl = slotFor('hf3', 'cccccccc-dddd-4eee-8fff-000000000022');
      const prefix = Buffer.from(rollout(sl.tid, '/work/race-ssh', 'two clients, one slot, ssh', 40));
      const grown = Buffer.concat([prefix, Buffer.from(ticks(1, 3))]);
      seedFor(sl, prefix, 32000);
      const log = { cats: [], tails: [] };
      const rem = { path: sl.remotePath, bytes: grown, mtime: 32001, gate: gateOf() };
      const hmC = sshHm('hf3', rem, log);
      const appends = countAppends(hmC);
      const c1 = hmC.fetchTranscript('hf3', 'codex', sl.tid);
      await sleep(20);
      const c2 = hmC.fetchTranscript('hf3', 'codex', sl.tid);
      await sleep(20);
      rem.gate.open();
      const [p1, p2] = await Promise.all([c1, c2]);
      ok(p1 === p2 && log.tails.length === 1 && log.cats.length === 0 && appends.n === 1 && fs.readFileSync(sl.cache).equals(grown),
        `ssh rung: overlapping fetches coalesce too — one tail, one append, byte-exact cache (${JSON.stringify({ tails: log.tails, cats: log.cats.length, appends: appends.n })})`);
      // NEGATIVE CONTROL on the same rung
      const sl2 = slotFor('hf4', 'cccccccc-dddd-4eee-8fff-000000000023');
      const prefix2 = Buffer.from(rollout(sl2.tid, '/work/race-ssh', 'pre-fix doubling, ssh', 40));
      const delta2 = Buffer.from(ticks(1, 3));
      seedFor(sl2, prefix2, 33000);
      const log2 = { cats: [], tails: [] };
      const rem2 = { path: sl2.remotePath, bytes: Buffer.concat([prefix2, delta2]), mtime: 33001, gate: gateOf() };
      const hmD = sshHm('hf4', rem2, log2);
      blindAppend(hmD); noSingleFlight(hmD);
      const d1 = hmD.fetchTranscript('hf4', 'codex', sl2.tid);
      await sleep(20);
      const d2 = hmD.fetchTranscript('hf4', 'codex', sl2.tid);
      await sleep(20);
      rem2.gate.open();
      await Promise.all([d1, d2]);
      ok(log2.tails.length === 2 && fs.readFileSync(sl2.cache).length === prefix2.length + 2 * delta2.length,
        `REPRO: the ssh rung doubles the same way without the guards (${JSON.stringify({ tails: log2.tails, size: fs.readFileSync(sl2.cache).length })})`);
    }

    // (C) THE SLOT MOVED WHILE THE REMOTE READ WAS IN FLIGHT — the offset is
    // stale even with no second fetch in this process (a heal, an operator, a
    // future caller that bypasses the lock). Under the cap: refetch whole.
    {
      const sl = slotFor('hf5', 'cccccccc-dddd-4eee-8fff-000000000024');
      const prefix = Buffer.from(rollout(sl.tid, '/work/moved', 'the slot moved under the delta', 40));
      const grown = Buffer.concat([prefix, Buffer.from(ticks(1, 3))]);
      const reads2 = [];
      seedFor(sl, prefix, 34000);
      const rem = { path: sl.remotePath, bytes: grown, mtime: 34001, beforeRead: () => fs.appendFileSync(sl.cache, Buffer.from('X')) };
      const hmE = dialHm('hf5', rem, reads2, null);
      const c = await hmE.fetchTranscript('hf5', 'codex', sl.tid);
      ok(fs.readFileSync(c).equals(grown) && reads2.length === 2 && reads2[1][0] === 0 && reads2[1][1] === grown.length,
        `slab rung: an append offset the slot has moved past triggers a WHOLE refetch, never a splice (${JSON.stringify(reads2)})`);
      // NEGATIVE CONTROL: the pre-fix blind append welds the tail on anyway
      const slN = slotFor('hf6', 'cccccccc-dddd-4eee-8fff-000000000025');
      seedFor(slN, prefix, 34000);
      const readsN = [];
      const remN = { path: slN.remotePath, bytes: grown, mtime: 34001, beforeRead: () => fs.appendFileSync(slN.cache, Buffer.from('X')) };
      const hmF = dialHm('hf6', remN, readsN, null);
      blindAppend(hmF);
      await hmF.fetchTranscript('hf6', 'codex', slN.tid);
      const spliced = fs.readFileSync(slN.cache);
      ok(!spliced.equals(grown) && spliced.length === grown.length + 1 && readsN.length === 1,
        `REPRO: the blind append splices the foreign byte in and keeps the tail (${spliced.length} vs ${grown.length}B)`);
      // …and the same leg on the ssh rung (twin guards must not drift)
      const slS = slotFor('hf7', 'cccccccc-dddd-4eee-8fff-000000000026');
      seedFor(slS, prefix, 34000);
      const logS = { cats: [], tails: [] };
      const remS = { path: slS.remotePath, bytes: grown, mtime: 34001, beforeRead: () => fs.appendFileSync(slS.cache, Buffer.from('X')) };
      const hmG = sshHm('hf7', remS, logS);
      const cs = await hmG.fetchTranscript('hf7', 'codex', slS.tid);
      ok(fs.readFileSync(cs).equals(grown) && logS.tails.length === 1 && logS.cats.length === 1,
        `ssh rung: same — the moved slot falls back to the whole cat (${JSON.stringify({ tails: logS.tails, cats: logS.cats.length })})`);
    }

    // (D) …but OVER the cap a whole refetch is impossible by construction, so a
    // moved slot is a loud failure, never a splice — and the cache is left
    // exactly as it was found.
    {
      const sl = slotFor('hf8', 'cccccccc-dddd-4eee-8fff-000000000027');
      const prefix = Buffer.from(rollout(sl.tid, '/work/moved-cap', 'moved over the cap', 40));
      const grown = Buffer.concat([prefix, Buffer.from(ticks(1, 3))]);
      seedFor(sl, prefix, 35000);
      const log = { cats: [], tails: [] };
      const rem = { path: sl.remotePath, bytes: grown, mtime: 35001, beforeRead: () => fs.appendFileSync(sl.cache, Buffer.from('X')) };
      const hmH = sshHm('hf8', rem, log);
      let capErr = null;
      try { await hmH.fetchTranscript('hf8', 'codex', sl.tid, { maxBytes: prefix.length - 1 }); } catch (e) { capErr = String(e && e.message || e); }
      const after = fs.readFileSync(sl.cache);
      ok(/refusing to splice/.test(capErr || '') && log.cats.length === 0,
        `over the cap a moved slot fails LOUDLY and never splices (${capErr})`);
      ok(after.length === prefix.length + 1 && after.subarray(0, prefix.length).equals(prefix),
        '…and the refused poll adds nothing of its own to the slot (only the foreign write that moved it is there)');
    }

    // ── ⑥g A MOVED SLOT IS TERMINAL ON EVERY RUNG (B-7638 round 5). (D) above
    // proved the refusal on the rung that owns the LAST road — but the slab
    // rung's copy of it was thrown INSIDE the data-plane try, whose catch
    // degrades every failure to the ssh rung. So on a dial host with a
    // reachable ssh fallback the over-cap refusal was swallowed silently, and
    // the ssh rung then recomputed its offset from the MOVED file and spliced:
    // right-size / wrong-bytes cache, meta stamped COMPLETE, and a stopped
    // conversation serves it forever. THREE independent legs fix it — the
    // verdict is a CODE the catch re-throws; what one rung learned about the
    // slot outlives it (the ssh rung is denied a delta even when the slab rung
    // fell through for an unrelated reason); and a delta may only extend bytes
    // this cache's own writers STAMPED, which is the same knowledge one poll
    // later, when the foreign bytes are simply in the file and every in-window
    // check answers "fine" — plus the degrade-path law: whatever the catch DOES
    // swallow, it says verbatim. Each leg is neuterable on its own below.
    console.log('— ⑥g the moved-slot refusal survives the data-plane fallback (and the fallback speaks)');
    {
      const dialWithSsh = (hid, rem, reads2, log) => {
        const hmx = new HostManager({ dataDir });
        hmx._state.hosts.push({ id: hid, name: hid, transport: 'dial' });    // dial ⇒ slab rung FIRST, ssh rung underneath it
        hmx.deviceBounded = async () => ({
          runCmd: async () => ({ stdout: rem.path + '\n', stderr: '', code: 0 }),
          fsStat: async () => { if (rem.statFails) throw new Error(rem.statFails); return { stat: { size: rem.bytes.length, mtimeMs: rem.mtime * 1000 } }; },
          fsReadRange: async (p2, off, len) => {
            reads2.push([off, len]);
            if (rem.beforeRead) { rem.beforeRead(); rem.beforeRead = null; }
            return { data: rem.bytes.subarray(off, off + len) };
          },
        });
        hmx._ssh = async (h, cmd) => {                                        // a REACHABLE legacy rung — the whole point
          if (/^cat /.test(cmd)) { log.cats.push(cmd); return rem.bytes; }
          const m = /^tail -c \+(\d+) /.exec(cmd);
          if (m) { log.tails.push(Number(m[1])); return rem.bytes.subarray(Number(m[1]) - 1); }
          return Buffer.from(`${rem.bytes.length} ${rem.mtime}\n${rem.path}\n`);
        };
        return hmx;
      };
      const FOREIGN = Buffer.from('X'.repeat(203));                           // the verifier's foreign writer, byte for byte
      const metaTextOf = (sl) => fs.readFileSync(sl.cache + '.meta', 'utf8');
      const capturedWarns = [];
      const withWarns = async (fn) => {
        const orig = console.warn; console.warn = (...a) => { capturedWarns.push(a.map(String).join(' ')); };
        try { return await fn(); } finally { console.warn = orig; }
      };

      // (E) THE VERIFIER'S SCENARIO — dial transport, slab rung first, ssh
      // fallback reachable, remote past the cap, a foreign writer during
      // fsReadRange. The fetch must FAIL, on both rungs, touching nothing.
      {
        const sl = slotFor('hg1', 'cccccccc-dddd-4eee-8fff-000000000030');
        const prefix = Buffer.from(rollout(sl.tid, '/work/terminal', 'moved over the cap, dial rung', 40));
        const grown = Buffer.concat([prefix, Buffer.from(ticks(1, 3))]);
        seedFor(sl, prefix, 36000);
        const metaBefore = metaTextOf(sl);
        const reads2 = [], log = { cats: [], tails: [] };
        const rem = { path: sl.remotePath, bytes: grown, mtime: 36001, beforeRead: () => fs.appendFileSync(sl.cache, FOREIGN) };
        const hmI = dialWithSsh('hg1', rem, reads2, log);
        let err = null, got = null;
        await withWarns(async () => { try { got = await hmI.fetchTranscript('hg1', 'codex', sl.tid, { maxBytes: prefix.length - 1 }); } catch (e) { err = String(e && e.message || e); } });
        ok(!got && /refusing to splice/.test(err || ''), `the over-cap refusal reaches the CALLER instead of dying in the data-plane catch (${got ? 'SERVED' : err})`);
        ok(log.tails.length === 0 && log.cats.length === 0, `…and the ssh rung never runs a delta (nor anything else) after the slab rung watched the slot move (${JSON.stringify(log)})`);
        const after = fs.readFileSync(sl.cache);
        ok(after.length === prefix.length + FOREIGN.length && after.subarray(0, prefix.length).equals(prefix) && metaTextOf(sl) === metaBefore,
          '…the cache carries only the foreign write that moved it, and the meta is byte-identical to what the poll found', { len: after.length, meta: metaTextOf(sl) });

        // (E2) THE SAME SLOT ONE POLL LATER — the movement is over, but the
        // file still holds bytes we never stamped. The in-window guard cannot
        // see that (its offset now MATCHES the foreign tail); the stamped-size
        // invariant is what keeps the delta off, forever.
        reads2.length = 0; log.cats.length = 0; log.tails.length = 0;
        rem.beforeRead = null;
        let err2 = null, got2 = null;
        await withWarns(async () => { try { got2 = await hmI.fetchTranscript('hg1', 'codex', sl.tid, { maxBytes: prefix.length - 1 }); } catch (e) { err2 = String(e && e.message || e); } });
        ok(!got2 && log.tails.length === 0 && log.cats.length === 0 && fs.readFileSync(sl.cache).equals(after) && metaTextOf(sl) === metaBefore,
          'the NEXT poll refuses too — a slot that grew outside our writers is never delta-grown, on either rung', { err2, log });
        ok(/holds \d+ bytes where the last fetch stamped \d+/.test(err2 || '') && /cannot be re-fetched whole/.test(err2 || ''),
          '…and the refusal names THAT fault (not a bare "too large", not the spliced-bytes one)', err2);

        // NEGATIVE CONTROL: the pre-fix shape, both legs neutered — the
        // verdict degrades silently and the ssh rung splices exactly as
        // reported: right size, wrong bytes, stamped COMPLETE, served forever.
        const slN = slotFor('hg2', 'cccccccc-dddd-4eee-8fff-000000000031');
        seedFor(slN, prefix, 36000);
        const readsN = [], logN = { cats: [], tails: [] };
        const remN = { path: slN.remotePath, bytes: grown, mtime: 36001, beforeRead: () => fs.appendFileSync(slN.cache, FOREIGN) };
        const hmJ = dialWithSsh('hg2', remN, readsN, logN);
        hmJ._isTerminalFetchError = () => false;                              // the PRE-FIX catch: every throw is "try the other transport"
        hmJ._slotMovedEarlier = () => false;                                  // the PRE-FIX ssh rung: it never heard what the slab rung saw
        noStampGuard(hmJ);                                                    // the PRE-FIX delta legality
        noHeal(hmJ);                                                          // …and round 6's over-stamp heal did not exist either — with `_slotMovedEarlier`
                                                                              // neutered it would probe the remote for the gap, i.e. spend a read the pre-fix
                                                                              // code never spent (the splice below reproduces either way; the tail COUNT is
                                                                              // what the control pins, so the shape has to be the real pre-fix shape)
        let errN = null, gotN = null;
        const warnsAt = capturedWarns.length;
        await withWarns(async () => { try { gotN = await hmJ.fetchTranscript('hg2', 'codex', slN.tid, { maxBytes: prefix.length - 1 }); } catch (e) { errN = String(e && e.message || e); } });
        const spliced = fs.readFileSync(slN.cache);
        const metaN = JSON.parse(metaTextOf(slN));
        ok(!errN && gotN && logN.tails.length === 1 && spliced.length === grown.length && !spliced.equals(grown) && metaN.size === grown.length,
          `REPRO: with both legs removed the ssh rung splices off the MOVED offset — right size, wrong bytes, stamped COMPLETE (${JSON.stringify({ errN, tails: logN.tails, len: spliced.length, want: grown.length, meta: metaN.size })})`);
        ok(spliced.subarray(prefix.length, prefix.length + FOREIGN.length).equals(FOREIGN) && !spliced.subarray(prefix.length).equals(grown.subarray(prefix.length)),
          `REPRO: the remote's bytes [${prefix.length},${prefix.length + FOREIGN.length}) are gone — the foreign write sits in their place`);
        readsN.length = 0; logN.tails.length = 0;
        const servedAgain = await hmJ.fetchTranscript('hg2', 'codex', slN.tid, { maxBytes: prefix.length - 1 });
        ok(servedAgain && readsN.length === 0 && logN.tails.length === 0 && !fs.readFileSync(slN.cache).equals(grown),
          'REPRO: and the sealed slot short-circuits on every later poll — a stopped conversation serves the corrupt transcript forever');
        // …and the ONE thing the pre-fix code did not leave behind either: a line saying it happened
        ok(capturedWarns.slice(warnsAt).some((w) => /refusing to splice/.test(w)),
          'DEGRADE-PATH LAW: when the fallback DOES swallow that verdict, it at least logs it verbatim (pre-fix: not a single line)', capturedWarns.slice(warnsAt));

        // (E3) LEG ISOLATION — each of the three guards is load-bearing on its
        // own, and this suite can show it by neutering exactly one. Here only
        // the TYPED verdict is gone: the other two still keep the splice off,
        // but the caller is handed "too large" about a slot whose real fault is
        // a cache that moved (an error string is not a diagnosis), decided by a
        // rung that never saw the movement. (E2) isolates the stamped-size leg
        // — a fresh poll, nothing moving, the flag necessarily false — and (F)
        // below isolates the flag with the stamped-size leg neutered.
        const slI = slotFor('hg6', 'cccccccc-dddd-4eee-8fff-000000000035');
        seedFor(slI, prefix, 36000);
        const metaI = fs.readFileSync(slI.cache + '.meta', 'utf8');
        const readsI = [], logI = { cats: [], tails: [] };
        const remI = { path: slI.remotePath, bytes: grown, mtime: 36001, beforeRead: () => fs.appendFileSync(slI.cache, FOREIGN) };
        const hmI2 = dialWithSsh('hg6', remI, readsI, logI);
        hmI2._isTerminalFetchError = () => false;                             // ONLY this leg removed
        let errI = null, gotI = null;
        await withWarns(async () => { try { gotI = await hmI2.fetchTranscript('hg6', 'codex', slI.tid, { maxBytes: prefix.length - 1 }); } catch (e) { errI = String(e && e.message || e); } });
        ok(!gotI && logI.tails.length === 0 && fs.readFileSync(slI.cache).length === prefix.length + FOREIGN.length && fs.readFileSync(slI.cache + '.meta', 'utf8') === metaI,
          'LEG ISOLATION: with only the typed verdict removed the other two legs still refuse the splice', { errI, logI });
        ok(/too large/.test(errI || '') && !/refusing to splice/.test(errI || ''),
          '…but the caller loses the diagnosis (it hears "too large" about a slot that MOVED) — which is why the verdict travels as a code', errI);
      }

      // (F) UNDER THE CAP the same movement is a WHOLE refetch, not a failure —
      // and if the slab rung's own whole read then dies, the ssh rung must
      // still refuse the delta: the movement was learned by a rung that is
      // gone, so it travels in `slotMoved`. The stamped-size leg is NEUTERED
      // here on purpose, so the only thing that can keep the tail off is that
      // flag (an isolated single-leg proof; (E2) covers the other leg alone).
      {
        const sl = slotFor('hg3', 'cccccccc-dddd-4eee-8fff-000000000032');
        const prefix = Buffer.from(rollout(sl.tid, '/work/terminal-under', 'moved under the cap, dial rung', 40));
        const grown = Buffer.concat([prefix, Buffer.from(ticks(1, 3))]);
        seedFor(sl, prefix, 37000);
        const reads2 = [], log = { cats: [], tails: [] };
        const rem = { path: sl.remotePath, bytes: grown, mtime: 37001, beforeRead: () => fs.appendFileSync(sl.cache, Buffer.from('X')) };
        const hmK = dialWithSsh('hg3', rem, reads2, log);
        const c = await hmK.fetchTranscript('hg3', 'codex', sl.tid);
        ok(fs.readFileSync(c).equals(grown) && reads2.length === 2 && reads2[1][0] === 0 && log.tails.length === 0 && log.cats.length === 0,
          `under the cap a moved slot is refetched WHOLE on the slab rung and never reaches the ssh one (${JSON.stringify({ reads: reads2, log })})`);

        const sl2 = slotFor('hg4', 'cccccccc-dddd-4eee-8fff-000000000033');
        seedFor(sl2, prefix, 37000);
        const reads3 = [], log2 = { cats: [], tails: [] };
        let readsSeen = 0;
        const rem2 = { path: sl2.remotePath, bytes: grown, mtime: 37001, beforeRead: () => fs.appendFileSync(sl2.cache, Buffer.from('X')) };
        const hmL = dialWithSsh('hg4', rem2, reads3, log2);
        noStampGuard(hmL);                                                    // ← only `slotMoved` can keep the ssh delta off now
        const dev = await hmL.deviceBounded();
        hmL.deviceBounded = async () => ({ ...dev, fsReadRange: async (p2, off, len) => { if (++readsSeen === 2) throw new Error('data plane died before the whole refetch landed'); return dev.fsReadRange(p2, off, len); } });
        let errF = null, cF = null;
        await withWarns(async () => { try { cF = await hmL.fetchTranscript('hg4', 'codex', sl2.tid); } catch (e) { errF = String(e && e.message || e); } });
        ok(!errF && cF && fs.readFileSync(cF).equals(grown) && log2.cats.length === 1 && log2.tails.length === 0,
          `…and when the slab rung's own whole refetch dies, the ssh rung whole-cats instead of deltaing off the moved offset (${errF || JSON.stringify(log2)})`);
      }

      // (G) THE DEGRADE PATH SPEAKS (the round-5 MINOR). The data-plane catch
      // used to swallow EVERY fault silently — a refusal, a transport fault, a
      // free-identifier ReferenceError an extraction left behind (2.340.2 class,
      // dead for three days behind exactly such a catch). Whatever it degrades,
      // it now names verbatim.
      {
        const sl = slotFor('hg5', 'cccccccc-dddd-4eee-8fff-000000000034');
        const body = Buffer.from(rollout(sl.tid, '/work/degrade', 'the fallback speaks', 40));
        const reads2 = [], log = { cats: [], tails: [] };
        const rem = { path: sl.remotePath, bytes: body, mtime: 38000, statFails: 'device link not responding within 6s — synthetic probe fault' };
        const hmM = dialWithSsh('hg5', rem, reads2, log);
        const warns = [];
        const orig = console.warn; console.warn = (...a) => warns.push(a.map(String).join(' '));
        let cD = null;
        try { cD = await hmM.fetchTranscript('hg5', 'codex', sl.tid); } finally { console.warn = orig; }
        ok(cD && fs.readFileSync(cD).equals(body) && log.cats.length === 1, 'a data-plane fault still degrades to the ssh rung (the fetch completes)', log);
        ok(warns.some((w) => w.includes('device link not responding within 6s — synthetic probe fault') && w.includes('hg5')),
          'DEGRADE-PATH LAW: the swallowed error is logged VERBATIM, with the host it happened on', warns);
        // NEGATIVE CONTROL: the line is not unconditional noise — a healthy
        // data-plane fetch degrades nothing and says nothing.
        rem.statFails = null; rem.mtime = 38001; rem.bytes = Buffer.concat([body, Buffer.from(ticks(1, 2))]);
        warns.length = 0; log.cats.length = 0;
        console.warn = (...a) => warns.push(a.map(String).join(' '));
        let cE = null;
        try { cE = await hmM.fetchTranscript('hg5', 'codex', sl.tid); } finally { console.warn = orig; }
        ok(cE && fs.readFileSync(cE).equals(rem.bytes) && log.cats.length === 0 && !warns.some((w) => /falling back to the ssh rung/.test(w)),
          'NEGATIVE CONTROL: a healthy data-plane fetch logs no fallback line at all', warns);
      }

      // (H) …AND THE WHOLE `cat` MUST STAMP WHAT IT FETCHED. `cat` runs after
      // the probe stat, so a live transcript hands back MORE bytes than the
      // stat promised — and that rung stamped the STAT value, leaving
      // meta.size < the file's real length after a perfectly healthy fetch.
      // The round-5 invariant would then read our own whole fetch as bytes
      // that "grew outside our writers" and refuse the next delta (over the
      // cap: a hard failure). The tail branch of the same rung has always
      // stamped the real length; the two writers now agree.
      {
        const hmN = new HostManager({ dataDir });
        hmN._state.hosts.push({ id: 'hg7', name: 'hg7' });                    // no transport ⇒ legacy ssh rung
        const tid = 'cccccccc-dddd-4eee-8fff-000000000036';
        const rpath = `/home/u/.codex/sessions/2026/09/05/rollout-2026-09-05T00-00-00-${tid}.jsonl`;
        const cache = path.join(dataDir, 'remote-jsonl', 'hg7', 'codex', `${tid}.jsonl`);
        const body = Buffer.from(rollout(tid, '/work/overtake', 'the cat overtook the stat', 40));
        const rem = { statSize: body.length, bytes: Buffer.concat([body, Buffer.from(ticks(1, 2))]), mtime: 39000 };   // grew between the probe and the cat
        const log = { cats: [], tails: [] };
        hmN._ssh = async (h, cmd) => {
          if (/^cat /.test(cmd)) { log.cats.push(cmd); return rem.bytes; }
          const m = /^tail -c \+(\d+) /.exec(cmd);
          if (m) { log.tails.push(Number(m[1])); return rem.bytes.subarray(Number(m[1]) - 1); }
          return Buffer.from(`${rem.statSize} ${rem.mtime}\n${rpath}\n`);
        };
        const metaAt = () => JSON.parse(fs.readFileSync(cache + '.meta', 'utf8'));
        const c1 = await hmN.fetchTranscript('hg7', 'codex', tid);
        ok(fs.readFileSync(c1).equals(rem.bytes) && log.cats.length === 1 && metaAt().size === rem.bytes.length,
          `a whole cat that overtakes the stat stamps the bytes it FETCHED, not the ones it was promised (${metaAt().size} vs stat ${rem.statSize} vs file ${rem.bytes.length})`);
        const before = rem.bytes;
        rem.bytes = Buffer.concat([before, Buffer.from(ticks(3, 2))]); rem.statSize = rem.bytes.length; rem.mtime = 39001;
        log.cats.length = 0; log.tails.length = 0;
        const c2 = await hmN.fetchTranscript('hg7', 'codex', tid);
        ok(fs.readFileSync(c2).equals(rem.bytes) && log.tails.length === 1 && log.tails[0] === before.length + 1 && log.cats.length === 0,
          `…which is what lets the NEXT poll still ride the append-only delta (${JSON.stringify(log)})`);
        // NEGATIVE CONTROL: the pre-fix stamp (the stat value) on the same
        // slot — the invariant now reads the fetch's own extra bytes as
        // foreign and re-pulls the whole file instead of the tail.
        fs.writeFileSync(cache + '.meta', JSON.stringify({ ...metaAt(), size: before.length - Buffer.byteLength(ticks(1, 2)) }));
        rem.bytes = Buffer.concat([rem.bytes, Buffer.from(ticks(5, 2))]); rem.statSize = rem.bytes.length; rem.mtime = 39002;
        log.cats.length = 0; log.tails.length = 0;
        const c3 = await hmN.fetchTranscript('hg7', 'codex', tid);
        ok(fs.readFileSync(c3).equals(rem.bytes) && log.cats.length === 1 && log.tails.length === 0 && metaAt().size === rem.bytes.length,
          `NEGATIVE CONTROL: a meta stamped with the stat value costs a WHOLE re-pull (and heals) — the delta win is what the honest stamp protects (${JSON.stringify(log)})`);
      }
    }

    // ── ⑥h THE SHAPE ROUND 5 CONDEMNED BY MISTAKE (B-7638 round 6, the round-5
    // verify's finding). "A delta may only extend bytes THIS cache's own
    // writers stamped" is right about foreign appends and wrong about ONE
    // innocent shape it cannot tell apart: until round 5 the whole `cat` rung
    // stamped the PROBE's stat while `cat` returned everything the live
    // transcript had grown to since, so a perfectly healthy fetch left
    // meta.size < the file's real length. Under the cap that costs one whole
    // re-pull; OVER the cap there is no whole re-pull, so every such slot — a
    // remote stopped thread that opened yesterday — hard-failed FOREVER.
    // The heal cannot be a local scan: the corruption round 5 exists for
    // (⑥g/E2) appends ordinary text, which no local scan can distinguish from
    // our own missing bytes. So the remote is ASKED: the gap [stamp, file) is
    // read back and compared byte-for-byte. Equal ⇒ genuine prefix, re-stamp
    // once with the marker; not equal ⇒ round 5's refusal stands, unchanged.
    console.log('— ⑥h a pre-round-5 over-stamped slot heals once (and only the remote can say so)');
    {
      const rollLog = () => ({ cats: [], tails: [], probes: [] });
      // an ssh rung that can serve the three commands this rung issues: the
      // whole `cat`, the append-only `tail -c +N`, and the round-6 BOUNDED gap
      // probe `tail -c +N … | head -c LEN` (matched FIRST — it is also a tail)
      const sshRung = (hid, rem, log) => {
        const hmx = new HostManager({ dataDir });
        hmx._state.hosts.push({ id: hid, name: hid });                         // no transport ⇒ the legacy rung, which is the rung that produced this shape
        hmx._ssh = async (h, cmd) => {
          if (/^cat /.test(cmd)) { log.cats.push(cmd); return rem.bytes; }
          const g = /^tail -c \+(\d+) .* \| head -c (\d+)$/.exec(cmd);
          if (g) { const off = Number(g[1]) - 1, len = Number(g[2]); log.probes.push([off, len]); return rem.bytes.subarray(off, off + len); }
          const m = /^tail -c \+(\d+) /.exec(cmd);
          if (m) { log.tails.push(Number(m[1])); return rem.bytes.subarray(Number(m[1]) - 1); }
          return Buffer.from(`${rem.bytes.length} ${rem.mtime}\n${rem.path}\n`);
        };
        return hmx;
      };
      // the meta the PRE-ROUND-5 whole `cat` left behind: the stat it was
      // promised, not the bytes it wrote — and no `sizeExact` marker, because
      // no writer stamped one yet
      const seedOverStamped = (sl, held, stamped, mtime, extra = {}) => {
        fs.mkdirSync(path.dirname(sl.cache), { recursive: true });
        fs.writeFileSync(sl.cache, held);
        fs.writeFileSync(sl.cache + '.meta', JSON.stringify({ size: stamped, mtime, fetchedAt: Date.now(), remotePath: sl.remotePath, compressed: false, v: 2, ...extra }));
      };
      const metaAt = (sl) => JSON.parse(fs.readFileSync(sl.cache + '.meta', 'utf8'));

      // (I) THE VERIFIER'S SLOT — over the cap, stat-sized meta, a clean cache
      // LONGER than it. Pre-fix: a permanent hard failure. Fixed: one bounded
      // probe, one re-stamp, and the delta rides again.
      {
        const body = Buffer.from(rollout('cccccccc-dddd-4eee-8fff-000000000040', '/work/overstamp', 'the cat overtook the stat, over the cap', 40));
        const over = Buffer.from(ticks(1, 3));                                  // what `cat` returned past the stat it was promised
        const held = Buffer.concat([body, over]);                               // …and therefore what the cache holds
        const grown = Buffer.concat([held, Buffer.from(ticks(4, 3))]);          // the remote has kept growing since
        const CAP = grown.length - 1;                                           // a whole refetch is impossible by construction
        ok(grown.length > CAP && over.length < CAP && held.length <= grown.length, `fixture: over the cap, with a bounded gap (${JSON.stringify({ stamped: body.length, held: held.length, remote: grown.length, cap: CAP })})`);

        // NEGATIVE CONTROL FIRST (this is the reported harm): with round 6's
        // heal removed the slot can never load again — not once, not ever.
        const slN = slotFor('hh0', 'cccccccc-dddd-4eee-8fff-000000000040');
        seedOverStamped(slN, held, body.length, 40000);
        const metaBeforeN = fs.readFileSync(slN.cache + '.meta', 'utf8');
        const logN = rollLog();
        const hmN = sshRung('hh0', { path: slN.remotePath, bytes: grown, mtime: 40001 }, logN);
        noHeal(hmN);
        let errN = null, gotN = null;
        try { gotN = await hmN.fetchTranscript('hh0', 'codex', slN.tid, { maxBytes: CAP }); } catch (e) { errN = String(e && e.message || e); }
        ok(!gotN && /too large/.test(errN || '') && new RegExp(`holds ${held.length} bytes where the last fetch stamped ${body.length}`).test(errN || ''),
          `REPRO: pre-fix, a slot the old cat over-stamped is refused over the cap (${errN})`);
        let errN2 = null;
        try { await hmN.fetchTranscript('hh0', 'codex', slN.tid, { maxBytes: CAP }); } catch (e) { errN2 = String(e && e.message || e); }
        ok(errN2 === errN && logN.tails.length === 0 && logN.cats.length === 0 && fs.readFileSync(slN.cache + '.meta', 'utf8') === metaBeforeN,
          'REPRO: …and it is PERMANENT — a stopped remote thread that opened yesterday never loads again (nothing on either side can ever move)');

        // …and the same slot with the heal in place
        const sl = slotFor('hh1', 'cccccccc-dddd-4eee-8fff-000000000041');
        seedOverStamped(sl, held, body.length, 40000);
        const log = rollLog();
        const rem = { path: sl.remotePath, bytes: grown, mtime: 40001 };
        const hm1 = sshRung('hh1', rem, log);
        let err = null, got = null;
        try { got = await hm1.fetchTranscript('hh1', 'codex', sl.tid, { maxBytes: CAP }); } catch (e) { err = String(e && e.message || e); }
        ok(got && !err && fs.readFileSync(sl.cache).equals(grown),
          `the over-cap slot loads again: the gap is verified against the remote and the delta lands on it (${err})`);
        ok(log.probes.length === 1 && log.probes[0][0] === body.length && log.probes[0][1] === over.length && log.cats.length === 0 && log.tails.length === 1 && log.tails[0] === held.length + 1,
          `…by ONE bounded probe of exactly [stamp, file) and then the ordinary tail delta — never a whole cat (${JSON.stringify(log)})`);
        const m1 = metaAt(sl);
        ok(m1.size === grown.length && m1.sizeExact === true && typeof m1.healedStampAt === 'number',
          '…and the heal is RECORDED: the marker every writer now stamps, plus the fact that this slot was healed', m1);

        // one more poll: the marker ends the heal, the delta keeps riding
        rem.bytes = Buffer.concat([grown, Buffer.from(ticks(7, 2))]); rem.mtime = 40002;
        const probesAfter = log.probes.length;
        const c2 = await hm1.fetchTranscript('hh1', 'codex', sl.tid, { maxBytes: CAP });
        ok(fs.readFileSync(c2).equals(rem.bytes) && log.probes.length === probesAfter && log.tails.length === 2 && log.cats.length === 0,
          `the heal is paid ONCE per slot: the next poll rides the delta with no probe at all (${JSON.stringify(log)})`);
      }


      // (I3) THE HEAL IS DURABLE THE MOMENT IT IS PROVEN — not when the fetch
      // that triggered it happens to finish. If the re-stamp rode home on the
      // fetch's own meta write, a delta that then dies on the wire would throw
      // the verification away and the NEXT poll would pay for the probe again,
      // every time, on exactly the slots (over the cap, remote flaky) where the
      // fetch is least likely to complete.
      {
        const sl = slotFor('hha', 'cccccccc-dddd-4eee-8fff-00000000004a');
        const body = Buffer.from(rollout(sl.tid, '/work/overstamp-durable', 'the heal outlives its fetch', 40));
        const held = Buffer.concat([body, Buffer.from(ticks(1, 3))]);
        const grown = Buffer.concat([held, Buffer.from(ticks(4, 3))]);
        const CAP = grown.length - 1;
        seedOverStamped(sl, held, body.length, 48000);
        const log = rollLog();
        const rem = { path: sl.remotePath, bytes: grown, mtime: 48001 };
        const hm8 = sshRung('hha', rem, log);
        const okSsh = hm8._ssh.bind(hm8);
        let deltaDies = true;
        hm8._ssh = async (h, cmd) => { if (deltaDies && /^tail -c \+/.test(cmd) && !/\| head -c /.test(cmd)) throw new Error('connection reset while streaming the tail'); return okSsh(h, cmd); };
        let err = null;
        try { await hm8.fetchTranscript('hha', 'codex', sl.tid, { maxBytes: CAP }); } catch (e) { err = String(e && e.message || e); }
        ok(err && /connection reset while streaming the tail/.test(err) && fs.readFileSync(sl.cache).equals(held),
          `fixture: the heal succeeds and the delta behind it dies on the wire (${err})`);
        const mid = metaAt(sl);
        ok(mid.size === held.length && mid.sizeExact === true && typeof mid.healedStampAt === 'number',
          'the verification is on disk the moment it is proven — a failed fetch cannot un-prove what the remote already confirmed', mid);
        deltaDies = false;
        const probesBefore = log.probes.length;
        const c = await hm8.fetchTranscript('hha', 'codex', sl.tid, { maxBytes: CAP });
        ok(fs.readFileSync(c).equals(grown) && log.probes.length === probesBefore && log.cats.length === 0,
          `…so the retry rides the delta with no second probe (${JSON.stringify(log)})`);
      }
      // (I2) THE SLAB RUNG TWIN — the same heal, through the data plane's own
      // read-range (twin guards must not drift: the ssh rung is where the shape
      // comes from, but a dial host reads the very same slots).
      {
        const sl = slotFor('hh2', 'cccccccc-dddd-4eee-8fff-000000000042');
        const body = Buffer.from(rollout(sl.tid, '/work/overstamp-slab', 'over-stamped, dial rung', 40));
        const over = Buffer.from(ticks(1, 3));
        const held = Buffer.concat([body, over]);
        const grown = Buffer.concat([held, Buffer.from(ticks(4, 3))]);
        const CAP = grown.length - 1;
        seedOverStamped(sl, held, body.length, 41000);
        const reads2 = [];
        const hm2 = dialHm('hh2', { path: sl.remotePath, bytes: grown, mtime: 41001 }, reads2, null);
        const c = await hm2.fetchTranscript('hh2', 'codex', sl.tid, { maxBytes: CAP });
        ok(fs.readFileSync(c).equals(grown) && reads2.length === 2 && reads2[0][0] === body.length && reads2[0][1] === over.length && reads2[1][0] === held.length,
          `slab rung: the gap probe then the delta, both bounded, no whole re-pull (${JSON.stringify(reads2)})`);
        ok(metaAt(sl).size === grown.length && metaAt(sl).sizeExact === true, '…with the same re-stamp (one heal, two rungs, one implementation)', metaAt(sl));
      }

      // (J) A DIRTY LONGER CACHE — the bytes past the stamp are NOT the
      // remote's. This is ⑥g's corruption wearing the same size signature, and
      // it must still be refused: the heal is a byte comparison for exactly
      // this reason (the foreign bytes are ordinary text).
      {
        const sl = slotFor('hh3', 'cccccccc-dddd-4eee-8fff-000000000043');
        const body = Buffer.from(rollout(sl.tid, '/work/overstamp-dirty', 'a clean-looking foreign append', 40));
        const over = Buffer.from(ticks(1, 3));
        const foreign = Buffer.from('Y'.repeat(over.length));                   // plain text: no NUL, no zstd magic — no local scan can tell
        const held = Buffer.concat([body, foreign]);
        const grown = Buffer.concat([body, over, Buffer.from(ticks(4, 3))]);    // the remote's own bytes at that offset are `over`
        const CAP = grown.length - 1;
        ok(!foreign.includes(0x00) && foreign.indexOf(DF.ZSTD_MAGIC) < 0 && foreign.length === over.length,
          'fixture: the foreign bytes are the same LENGTH and carry no splice marker — size and local evidence both say "fine"');
        seedOverStamped(sl, held, body.length, 42000);
        const metaBefore = fs.readFileSync(sl.cache + '.meta', 'utf8');
        const log = rollLog();
        const hm3 = sshRung('hh3', { path: sl.remotePath, bytes: grown, mtime: 42001 }, log);
        let err = null, got = null;
        try { got = await hm3.fetchTranscript('hh3', 'codex', sl.tid, { maxBytes: CAP }); } catch (e) { err = String(e && e.message || e); }
        ok(!got && /too large/.test(err || '') && log.tails.length === 0 && log.cats.length === 0,
          `a longer cache whose extra bytes are NOT the remote's is still refused — round 5 is not weakened by the heal (${got ? 'SERVED' : err})`);
        ok(/CHECKED against the remote: they are not its own/.test(err || '') && new RegExp(`holds ${held.length} bytes where the last fetch stamped ${body.length}`).test(err || ''),
          '…and the refusal reports what the heal LEARNED (a checked mismatch is a different diagnosis from an unchecked one)', err);
        ok(fs.readFileSync(sl.cache).equals(held) && fs.readFileSync(sl.cache + '.meta', 'utf8') === metaBefore && log.probes.length === 1,
          '…leaving cache AND meta byte-identical, after exactly one bounded probe', { probes: log.probes, meta: fs.readFileSync(sl.cache + '.meta', 'utf8') });
        // the refusal is REMEMBERED (in memory, never stamped): the next poll
        // costs nothing at all, and clearing the memo is what makes it re-probe
        let err2 = null;
        try { await hm3.fetchTranscript('hh3', 'codex', sl.tid, { maxBytes: CAP }); } catch (e) { err2 = String(e && e.message || e); }
        ok(err2 && log.probes.length === 1 && fs.readFileSync(sl.cache + '.meta', 'utf8') === metaBefore,
          'a refused slot is not re-probed every poll — the verdict is memoized in MEMORY, because stamping it on disk would freeze the corruption in', { probes: log.probes });
        hm3._healRefusedAt.clear();
        let err3 = null;
        try { await hm3.fetchTranscript('hh3', 'codex', sl.tid, { maxBytes: CAP }); } catch (e) { err3 = String(e && e.message || e); }
        ok(err3 && log.probes.length === 2, 'NEGATIVE CONTROL: with the memo cleared the same poll probes again (the memo is the reason, not a disk stamp)', { probes: log.probes });
      }


      // (J3) THE REMOTE COULD NOT BE ASKED — a probe that fails on the wire is
      // a TRANSPORT fact, not a verdict about the cache: nothing is adopted,
      // nothing is memoized (the next poll must be able to answer differently),
      // the refusal says it is retryable, and the line it costs rides the same
      // per-host budget as every other degrade line.
      {
        const sl = slotFor('hh9', 'cccccccc-dddd-4eee-8fff-000000000049');
        const body = Buffer.from(rollout(sl.tid, '/work/overstamp-probe', 'the probe dies on the wire', 40));
        const held = Buffer.concat([body, Buffer.from(ticks(1, 3))]);
        const grown = Buffer.concat([held, Buffer.from(ticks(4, 3))]);
        const CAP = grown.length - 1;
        seedOverStamped(sl, held, body.length, 47000);
        const metaBefore = fs.readFileSync(sl.cache + '.meta', 'utf8');
        const log = rollLog();
        const rem = { path: sl.remotePath, bytes: grown, mtime: 47001 };
        const hm7 = sshRung('hh9', rem, log);
        const okSsh = hm7._ssh.bind(hm7);
        let probeDies = true;
        hm7._ssh = async (h, cmd) => { if (probeDies && /\| head -c /.test(cmd)) throw new Error('connection reset while reading the gap'); return okSsh(h, cmd); };
        const warns = [];
        const orig = console.warn; console.warn = (...x) => warns.push(x.map(String).join(' '));
        let err = null, got = null;
        try { got = await hm7.fetchTranscript('hh9', 'codex', sl.tid, { maxBytes: CAP }); } catch (e) { err = String(e && e.message || e); } finally { console.warn = orig; }
        ok(!got && /retryable on the next poll/.test(err || '') && fs.readFileSync(sl.cache + '.meta', 'utf8') === metaBefore && log.tails.length === 0,
          `a probe that dies on the wire refuses as RETRYABLE and adopts nothing (${got ? 'SERVED' : err})`);
        ok(warns.some((w) => w.includes('connection reset while reading the gap') && w.includes('hh9')), '…naming the wire fault verbatim, on the host it happened on', warns);
        // …and it is NOT remembered: the very next poll asks again and heals
        probeDies = false;
        const c = await hm7.fetchTranscript('hh9', 'codex', sl.tid, { maxBytes: CAP });
        ok(fs.readFileSync(c).equals(grown) && log.probes.length === 1 && metaAt(sl).sizeExact === true,
          'NEGATIVE CONTROL: an unanswered question is not a refusal — the next poll probes again and the slot heals', { probes: log.probes, tails: log.tails });
      }
      // (J2) …and the free evidence comes FIRST: a splice marker buried deeper
      // than the 4 KB tail window is caught by the local whole-file scan, with
      // no remote round trip spent at all.
      {
        const sl = slotFor('hh4', 'cccccccc-dddd-4eee-8fff-000000000044');
        const body = Buffer.from(rollout(sl.tid, '/work/overstamp-buried', 'buried marker under an over-stamp', 40));
        const marker = zlib.zstdCompressSync(Buffer.from(rollout(sl.tid, '/work/overstamp-buried', 'buried marker under an over-stamp', 40))).subarray(0, 64);
        const later = Buffer.from(tickN(9).repeat(80));
        const held = Buffer.concat([body, marker, later]);
        ok(later.length > 4096 && held.indexOf(DF.ZSTD_MAGIC) >= body.length, 'fixture: the marker sits above the 4 KB tail window (only the whole-file scan can see it)');
        const grown = Buffer.concat([held, Buffer.from(ticks(4, 3))]);
        const CAP = grown.length - 1;
        seedOverStamped(sl, held, body.length, 43000);
        const metaBefore = fs.readFileSync(sl.cache + '.meta', 'utf8');
        const log = rollLog();
        const hm4 = sshRung('hh4', { path: sl.remotePath, bytes: grown, mtime: 43001 }, log);
        let err = null, got = null;
        try { got = await hm4.fetchTranscript('hh4', 'codex', sl.tid, { maxBytes: CAP }); } catch (e) { err = String(e && e.message || e); }
        ok(!got && log.probes.length === 0 && log.tails.length === 0 && fs.readFileSync(sl.cache + '.meta', 'utf8') === metaBefore,
          `a cache carrying a buried splice marker is never healed, and never costs a remote read to find that out (${got ? 'SERVED' : err})`);
        ok(/carries a splice marker/.test(err || '') && !/CHECKED against the remote/.test(err || ''),
          '…and the refusal names the evidence it ACTUALLY has — claiming the remote check it skipped would be the "an error string is not a diagnosis" law with the sign flipped', err);
      }

      // (K) UNDER THE CAP the heal must NOT fire: a whole refetch is possible,
      // and that is the remedy (adopting bytes you can simply re-fetch is a
      // way of trusting what you did not have to trust).
      {
        const sl = slotFor('hh5', 'cccccccc-dddd-4eee-8fff-000000000045');
        const body = Buffer.from(rollout(sl.tid, '/work/overstamp-under', 'over-stamped but under the cap', 40));
        const held = Buffer.concat([body, Buffer.from(ticks(1, 3))]);
        const grown = Buffer.concat([held, Buffer.from(ticks(4, 3))]);
        seedOverStamped(sl, held, body.length, 44000);
        const log = rollLog();
        const hm5 = sshRung('hh5', { path: sl.remotePath, bytes: grown, mtime: 44001 }, log);
        const c = await hm5.fetchTranscript('hh5', 'codex', sl.tid);            // default cap ⇒ way under
        ok(fs.readFileSync(c).equals(grown) && log.cats.length === 1 && log.probes.length === 0 && log.tails.length === 0,
          `under the cap the same shape is a whole refetch, with no probe and no adoption (${JSON.stringify(log)})`);
        ok(metaAt(sl).size === grown.length && metaAt(sl).sizeExact === true && metaAt(sl).healedStampAt === undefined,
          '…and the fetched bytes carry the exact-size marker, so this slot can never need the heal again', metaAt(sl));
      }

      // (L) A META THAT ALREADY CARRIES THE MARKER IS NEVER HEALED — round 5
      // stays absolute where it is provably right: those writers stamp what the
      // file holds, so a longer file under such a meta IS foreign bytes.
      {
        const sl = slotFor('hh6', 'cccccccc-dddd-4eee-8fff-000000000046');
        const body = Buffer.from(rollout(sl.tid, '/work/marked', 'a marked meta is not healable', 40));
        const over = Buffer.from(ticks(1, 3));
        const held = Buffer.concat([body, over]);
        const grown = Buffer.concat([held, Buffer.from(ticks(4, 3))]);
        const CAP = grown.length - 1;
        seedOverStamped(sl, held, body.length, 45000, { sizeExact: true });      // …the ONLY difference from (I)
        const metaBefore = fs.readFileSync(sl.cache + '.meta', 'utf8');
        const log = rollLog();
        const hm6 = sshRung('hh6', { path: sl.remotePath, bytes: grown, mtime: 45001 }, log);
        let err = null, got = null;
        try { got = await hm6.fetchTranscript('hh6', 'codex', sl.tid, { maxBytes: CAP }); } catch (e) { err = String(e && e.message || e); }
        ok(!got && log.probes.length === 0 && log.tails.length === 0 && fs.readFileSync(sl.cache + '.meta', 'utf8') === metaBefore,
          `the heal is gated on the MARKER, not on the size alone: a round-5+ meta refuses without asking anyone (${got ? 'SERVED' : err})`);
        ok(new RegExp(`holds ${held.length} bytes where the last fetch stamped ${body.length}`).test(err || '') && !/CHECKED against the remote|splice marker/.test(err || ''),
          '…and says so without claiming a check it did not run', err);
      }

      // (M) THE DEGRADE LINE IS RATE-LIMITED PER HOST (round 6's second half).
      // Round 5 made the data-plane fallback speak, which is the law — but the
      // thing it degrades on is usually persistent, and every attach/poll comes
      // through here. One line per host per minute, with the suppressed count
      // carried onto the next one; a suppressed fault is not a forgotten one.
      {
        const mk = (hid, tid) => {
          const sl = slotFor(hid, tid);
          const body = Buffer.from(rollout(sl.tid, '/work/degrade-rate', 'the fallback repeats itself', 20));
          const log = rollLog();
          const hmx = sshRung(hid, { path: sl.remotePath, bytes: body, mtime: 46000 }, log);
          hmx._state.hosts[0].transport = 'dial';                               // ⇒ the slab rung runs first…
          hmx.deviceBounded = async () => { throw new Error('device link not responding — persistent synthetic fault'); };   // …and always fails
          return { sl, body, log, hmx };
        };
        const a = mk('hh7', 'cccccccc-dddd-4eee-8fff-000000000047'), b2 = mk('hh8', 'cccccccc-dddd-4eee-8fff-000000000048');
        const warns = [];
        const orig = console.warn; console.warn = (...x) => warns.push(x.map(String).join(' '));
        let wired = 0;
        const origWarnOnce = a.hmx._warnDegradeOnce.bind(a.hmx);
        a.hmx._warnDegradeOnce = (...x) => { if (/falling back to the ssh rung/.test(String(x[1]))) wired++; return origWarnOnce(...x); };
        try {
          for (let i = 0; i < 3; i++) { fs.rmSync(a.sl.cache + '.meta', { force: true }); await a.hmx.fetchTranscript('hh7', 'codex', a.sl.tid); }
          await b2.hmx.fetchTranscript('hh8', 'codex', b2.sl.tid);
        } finally { console.warn = orig; }
        const lines = warns.filter((w) => /falling back to the ssh rung/.test(w));
        ok(wired === 3 && lines.length === 2 && lines.filter((w) => w.includes('hh7')).length === 1,
          `three degraded fetches on one host print ONE line, and a second host in the same window still prints its own (${JSON.stringify({ wired, lines })})`);
        ok(lines.every((w) => w.includes('device link not responding — persistent synthetic fault')),
          'DEGRADE-PATH LAW: the line that IS printed still names the swallowed fault verbatim', lines);
        // …and the window is a window: the next one prints, carrying what the
        // last one swallowed (driven on the method's own clock — the wiring
        // above already proved the fetch path goes through it)
        const later = [];
        console.warn = (...x) => later.push(x.map(String).join(' '));
        let printed = 0;
        try {
          const t0 = Date.now();
          printed += origWarnOnce('hh7', 'A', t0 + 1000) ? 1 : 0;               // inside the window ⇒ suppressed (and counted)
          printed += origWarnOnce('hh7', 'B', t0 + 61000) ? 1 : 0;              // …a minute later it speaks again
        } finally { console.warn = orig; }
        ok(printed === 1 && later.length === 1 && /^B \(\+3 similar suppressed in the last minute\)$/.test(later[0]),
          'a new window prints again and reports how many faults the closed one swallowed', later);
      }
    }
  }
}
try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
