#!/usr/bin/env node
// VENDOR-CALL WHITELIST GUARD (docs/design-three-tier.md §Quota refresh origin:
// "the safety law is a WHITELIST … a guard test enforces the whitelist
// structurally"). §ban-safety is the one law whose violation gets accounts
// BANNED (real Max ban, refunded, 2.60.0 postmortem) — so which code may
// construct a request to Anthropic is pinned HERE, not by discipline.
//
// Contract:
//  1. The ONLY files that construct an HTTP request to an Anthropic endpoint
//     are the allowlisted ones, with their exact construction counts.
//  2. Each allowlisted site keeps its GATES (opt-in setting / human-gate
//     setting / 429 backoff) — deleting a gate fails this test even though
//     the call site itself is unchanged.
//  3. The device daemon (source AND built bundle) contains ZERO vendor
//     endpoints: no device op may originate a vendor call. When the
//     human-gated quota-refresh op moves device-side, it gets allowlisted
//     HERE deliberately, with its own gate asserts — that is the point.
//  4. The shipped usage tools (statusline capture + remote scanner) import no
//     network primitives at all: purely passive by construction.
// Adding a vendor call ANYWHERE else fails this test until it is explicitly
// allowlisted with its gates. That is the desired friction.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? '\n    ' + e : '')); } };

const VENDOR = /api\.anthropic\.com|platform\.claude\.com|console\.anthropic\.com|claude\.ai\/|anthropic-beta/;
const REQUESTY = /https?\.request\s*\(|\bfetch\s*\(|axios|got\s*\(/;

// ── collect every server-side JS file (the browser bundle never holds tokens) ──
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'public', 'docs', 'lib'].includes(e.name)) continue; // src/lib = browser
      walk(p);
    } else if (/\.(js|mjs)$/.test(e.name)) files.push(p);
  }
};
walk(path.join(REPO, 'src'));
files.push(path.join(REPO, 'server.js'));
for (const f of fs.readdirSync(path.join(REPO, 'data', 'bin'))) {
  if (/\.(js|mjs)$/.test(f) || !f.includes('.')) {
    const p = path.join(REPO, 'data', 'bin', f);
    try { if (fs.statSync(p).isFile()) files.push(p); } catch { }
  }
}

// ── 1+2: request constructions near a vendor string, per file ──
// A "construction" = a vendor endpoint within ±4 lines of a request primitive.
const constructions = {}; // rel → count
for (const f of files) {
  let text; try { text = fs.readFileSync(f, 'utf-8'); } catch { continue; }
  const rel = path.relative(REPO, f);
  if (rel.startsWith('data/bin/vibespace-agentd')) continue; // asserted separately below
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!VENDOR.test(lines[i])) continue;
    const lo = Math.max(0, i - 4), hi = Math.min(lines.length, i + 5);
    const ctx = lines.slice(lo, hi).join('\n');
    if (REQUESTY.test(ctx)) constructions[rel] = (constructions[rel] || 0) + 1;
  }
}

const ALLOW = {
  // _fetchOAuthUsage (oauth/usage) + _fetchOAuthRoles (claude_cli/roles):
  // each URL line + its anthropic-beta header line sit inside one https.request
  // context window; counts pin the shape, not exact line numbers.
  'src/usage-routes.js': { max: 6, gates: ['usagePollingEnabled', '_rateLimitBackoffUntil', "onDemandQuotaRefresh"] },
  // refreshAvailableModels' v1/models fetch (both auth types) — lived in
  // server.js until the 2.325.0 decomposition moved the CLI environment out
  'src/server/cli-env.js': { max: 4, gates: ['usagePollingEnabled'] },
};
for (const [rel, n] of Object.entries(constructions)) {
  const a = ALLOW[rel];
  ok(!!a, `vendor request construction only in allowlisted files (found in ${rel}${a ? '' : ' — NOT ALLOWLISTED'})`);
  if (a) ok(n <= a.max, `${rel}: construction count ${n} ≤ ${a.max} (a NEW vendor call site must be allowlisted here with its gates)`);
}
for (const [rel, a] of Object.entries(ALLOW)) {
  ok(constructions[rel] > 0, `${rel} still holds its allowlisted vendor call (moved/renamed ⇒ update the allowlist)`);
  const text = fs.readFileSync(path.join(REPO, rel), 'utf-8');
  for (const g of a.gates) ok(text.includes(g), `${rel} keeps gate marker '${g}' (§ban-safety gate deleted?)`);
}

// ── 3: the device protocol's vendor surface is EXACTLY the quota-refresh op ──
// (design §Quota refresh origin: "the ONLY device op that may reach the
// vendor API is the human-gated, throttled read-only quota query"). agentd.js
// holds that one op WITH its gates; every other daemon file stays at zero.
{
  const text = fs.readFileSync(path.join(REPO, 'src/agentd/agentd.js'), 'utf-8');
  const hits = (text.match(/api\.anthropic\.com/g) || []).length;
  ok(hits === 1, `src/agentd/agentd.js: exactly ONE vendor host literal (the quota-refresh op; found ${hits})`);
  for (const g of ["humanGated !== true", '_quotaAt', 'never refreshes']) {
    ok(text.includes(g), `agentd quota-refresh keeps gate marker '${g}'`);
  }
  ok(!/oauth\/token|platform\.claude\.com/.test(text), 'agentd never touches the token-refresh endpoint (read-only peek only)');
}
for (const rel of ['src/agentd/client.js', 'src/agentd/ws-min.js', 'src/agentd/mux.js']) {
  const text = fs.readFileSync(path.join(REPO, rel), 'utf-8');
  ok(!VENDOR.test(text), `${rel}: zero vendor endpoints`);
}
// bundle: carries the same single op (minified) — gate property names survive
for (const b of ['data/bin/vibespace-agentd.js']) {
  try {
    const text = fs.readFileSync(path.join(REPO, b), 'utf-8');
    ok((text.match(/api\.anthropic\.com/g) || []).length <= 2 && text.includes('humanGated'),
      `${b}: bundle vendor surface = the gated quota-refresh op only`);
  } catch { ok(true, `${b} not built here — source asserted above`); }
}
try {
  const att = fs.readFileSync(path.join(REPO, 'data/bin/vibespace-agentd-attach.js'), 'utf-8');
  ok(!/api\.anthropic\.com|oauth\/usage/.test(att), 'attach-cli bundle carries zero vendor endpoints');
} catch { ok(true, 'attach bundle not built here'); }

// ── 4: shipped usage tools are passive by construction ──
// vibespace-usage legitimately requires child_process — it PASSES THROUGH the
// user's own statusline command (by design); the passivity contract for it is
// "no network primitive + no vendor endpoint". The scanner allows neither.
{
  const u = fs.readFileSync(path.join(REPO, 'data/bin/vibespace-usage'), 'utf-8');
  ok(!/require\(['"](https?|net|tls|dgram)['"]\)/.test(u) && !/\bfetch\s*\(/.test(u) && !VENDOR.test(u),
    'data/bin/vibespace-usage: no network primitive, no vendor endpoint (statusline passthrough via child_process is the one sanctioned spawn)');
  const sc = fs.readFileSync(path.join(REPO, 'data/bin/vibespace-usage-scan'), 'utf-8');
  ok(!/require\(['"](https?|net|tls|dgram|child_process)['"]\)/.test(sc) && !/\bfetch\s*\(/.test(sc),
    'data/bin/vibespace-usage-scan: imports no network primitive at all (purely passive)');
}

// ── 5: the CLI-native quota channel stays write-to-STDIN (first-party call) ──
const adapter = fs.readFileSync(path.join(REPO, 'src/adapters/claude-code.js'), 'utf-8');
ok(/get_usage/.test(adapter) && !VENDOR.test(adapter), 'claude-code adapter: get_usage rides the CLI control channel, never a direct vendor call');

// ── 6: LOCAL ORACLES (owner ruling 6 of docs/design-harness-features.md §5.1) ──
// "用（逐条附「不发 vendor 请求」证据进白名单豁免；人触发/已有节拍）", with §4.2's
// hard gate: the zero-network property must be MEASURED per command, never
// inferred from the shape of the CLI. Two halves:
//   (a) STRUCTURAL — every shipped oracle carries a proof whose every measured
//       run is 0 INET connects; every measured-and-REJECTED candidate carries
//       its counts and its verdict and can never appear as a shipped oracle;
//       the runner can only spawn registry argv and holds no vendor endpoint.
//   (b) LIVE — when strace + the CLI are present, RE-MEASURE each shipped
//       oracle here and fail on any AF_INET/AF_INET6 connect. A NEGATIVE
//       CONTROL (a deliberate loopback connect) proves the detector can see
//       one, so a green run is never vacuous.
// The REJECTED candidates are deliberately NOT re-run: they reach
// api.anthropic.com by construction, and a suite that runs on every push is
// exactly the "on a timer" shape §ban-safety forbids. Their numbers are the
// hand-measurement recorded in src/local-oracles.js with tool + date + version.
{
  const { ORACLES, NOT_ORACLES, PROOF_KEYS, oracle, rejected, blockedCapability, blockingRejectionsFor } = require(path.join(REPO, 'src/local-oracles.js'));
  const runner = fs.readFileSync(path.join(REPO, 'src/server/permission-rules.js'), 'utf-8');
  // "IN-PROCESS" is load-bearing (round-2 verifier). This assert reads the
  // file's own text, so it can only ever speak about requests this MODULE
  // constructs — it says nothing about what a child it spawns does, and the
  // first cut of this module spawned `codex app-server`, which connects to
  // chatgpt.com. The companion assert below is the one that covers children.
  ok(!VENDOR.test(runner) && !REQUESTY.test(runner.split('\n').filter((l) => VENDOR.test(l)).join('\n')),
    'src/server/permission-rules.js (the oracle runner + rule reader) constructs NO vendor request IN-PROCESS');
  ok(/spawn\(cmd, o\.argv\.slice\(\)/.test(runner),
    'the oracle runner spawns the REGISTRY\'s frozen argv — a caller cannot supply its own command');
  // …AND that is the ONLY child it starts. A file that may spawn a vendor CLI
  // needs every such spawn to come from the measured registry, because the
  // registry is the thing that cannot accept an entry without a proof. A
  // second `spawn(` here is exactly how a 7-connect app-server child shipped
  // under a menu advertising "no network requests (measured)".
  {
    // count CODE spawns only: the comments above the runner quote the call on
    // purpose (they explain why it is the only one), and a census that counts
    // its own documentation is a census that gets silenced by rewording it.
    const code = runner.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const spawns = (code.match(/\bspawn\s*\(/g) || []).length;
    ok(spawns === 1, `src/server/permission-rules.js starts exactly ONE kind of child — the registry oracle (found ${spawns} spawn call(s) in code; a new one must go through src/local-oracles.js, which needs a measurement)`);
    // the counter must be able to SEE a second one, or the 1 above is luck
    ok(((code + '\n  const x = spawn(other, []);').match(/\bspawn\s*\(/g) || []).length === 2,
      'NEGATIVE CONTROL: the spawn census counts a second call when one is present (so "exactly one" is a measurement)');
    ok(!/'app-server'/.test(runner) && !/"app-server"/.test(runner),
      'src/server/permission-rules.js starts no `codex app-server` child: measured 2026-09-07 at 7 INET connects incl. chatgpt.com:443 with an EMPTY CODEX_HOME, so the codex INSTANCE scope is not offered at all');
  }
  // A rejection that claims to explain a missing capability must actually
  // match a caps row that is OFF. Otherwise the note is decoration and the
  // connecting path is live again — the exact regression this round fixes.
  {
    const { capsOf } = require(path.join(REPO, 'src/backend-caps.js'));
    const dig = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
    const blocking = NOT_ORACLES.filter((r) => r.blocks);
    ok(blocking.length > 0, `at least one rejection explains a switched-off capability (${blocking.map((r) => r.blocks).join(', ') || 'none'})`);
    for (const r of blocking) {
      const [backend, ...rest] = r.blocks.split('.');
      const capPath = rest.join('.');
      const live = dig(capsOf(backend), capPath);
      ok(live === false, `${r.id}: the capability it blocks (${r.blocks}) is really OFF — re-enabling it needs a NEW measurement, not just a caps edit (found ${JSON.stringify(live)})`);
      ok(blockedCapability(backend, capPath) === r, `${r.id}: is reachable through blockedCapability('${backend}', '${capPath}') — the server's refusal and the menu's note read the SAME record`);
      ok(blockingRejectionsFor(backend).includes(r), `${r.id}: appears in blockingRejectionsFor('${backend}') so the menu shows it EVEN THOUGH ${backend} has shipped oracles (a missing button must be explained)`);
    }
    // the client mirror must agree, or the chrome offers a door the server refuses
    const meta = fs.readFileSync(path.join(REPO, 'src/lib/agent-meta.js'), 'utf-8');
    ok(/permissionRules: \{ source: 'config-read', session: true, instance: false, liveVerb: true \}/.test(meta),
      'src/lib/agent-meta.js mirrors codex permissionRules.instance:false (a client that still offered the row would fetch a refusal)');
  }
  ok(!/setInterval|setTimeout\([^)]*runOracle/.test(runner) && /app\.post\('\/api\/local-oracle/.test(runner),
    'an oracle runs ONLY on a POST (a button): nothing schedules one, and the route is not a pre-fetchable GET');
  ok(ORACLES.length > 0, `at least one measured-clean oracle ships (${ORACLES.map((o) => o.id).join(', ') || 'none'})`);
  const rejectedIds = new Set(NOT_ORACLES.map((o) => o.id));
  for (const o of ORACLES) {
    ok(PROOF_KEYS.every((k) => o.proof && o.proof[k] != null) && Array.isArray(o.proof.runs) && o.proof.runs.length > 0,
      `oracle ${o.id}: carries a proof (tool + date + CLI version + at least one measured run)`);
    ok(o.proof.runs.every((r) => r.inetConnects === 0),
      `oracle ${o.id}: EVERY recorded run measured ZERO INET connects (${o.proof.runs.map((r) => `${r.what}=${r.inetConnects}`).join('; ')})`);
    ok(!rejectedIds.has(o.id), `oracle ${o.id}: is not also on the rejected list`);
    // program-use billing law: an oracle is a READ, never an inference channel
    ok(!o.argv.some((a) => /^(-p|--print|exec|--json-schema|--output-schema|-o)$/.test(a)),
      `oracle ${o.id}: argv carries no print/exec/inference flag (${o.argv.join(' ')})`);
  }
  for (const r of NOT_ORACLES) {
    ok(r.measured && r.measured.inetConnects > 0 && typeof r.verdict === 'string' && r.verdict.length > 20,
      `rejected candidate ${r.id}: keeps its measurement (${r.measured?.inetConnects} INET connects) and the reason it is not offered`);
    ok(!oracle(r.id) && !!rejected(r.id), `rejected candidate ${r.id}: cannot be looked up as a shipped oracle`);
  }
  ok(NOT_ORACLES.some((r) => r.id === 'claude-auth-status') && NOT_ORACLES.some((r) => r.id === 'claude-agents-list') && NOT_ORACLES.some((r) => r.id === 'codex-doctor'),
    'the three candidates the design proposed (claude auth status / claude agents / codex doctor) are all recorded as MEASURED AND REJECTED — the negative control that keeps them out');
  ok(!ORACLES.some((o) => o.backend === 'claude'),
    'no claude oracle ships: every measured claude subcommand reached api.anthropic.com, including with every traffic-suppressing env set');
  // THE OTHER app-server SPAWN IN THE REPO (round-2 verifier, same root cause).
  // src/codex-thread-read.js is shipped B-21e4 code whose behaviour this round
  // deliberately does NOT change — but it carried the same unmeasured "no
  // network of ours" claim, and a false comment is how the next reader ships
  // the same mistake. The measurement now lives in it; this assert keeps it
  // there. (An UNMEASURED reassurance is worse than none: it is the sentence
  // someone will cite as the precedent.)
  {
    const ctr = fs.readFileSync(path.join(REPO, 'src/codex-thread-read.js'), 'utf-8');
    ok(!/no\s+network\s+of\s+ours/.test(ctr),
      'src/codex-thread-read.js no longer claims its `codex app-server` child makes no network calls (measured: it connects to chatgpt.com even logged out)');
    ok(/strace/.test(ctr) && /chatgpt\.com/.test(ctr) && /B-af31/.test(ctr),
      'src/codex-thread-read.js records the measurement + the tool + the backlog id that owns the §ban-safety decision, instead of a reassurance nobody checked');
  }

  // ── (b) the live re-measurement ──
  const has = (bin) => { try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'pipe' }); return true; } catch { return false; } };
  const cmdPath = (bin) => { try { return execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf-8' }).trim(); } catch { return ''; } };
  const straceOk = has('strace');
  if (!straceOk) {
    ok(true, 'SKIP live re-measurement: strace is not on PATH (`command -v strace` found nothing) — the recorded proofs above stand alone');
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-oracle-'));
    const ENVBASE = { HOME: tmp, PATH: process.env.PATH || '/usr/bin:/bin', TERM: 'dumb' };
    /** Run one command under strace and count INET connects. AF_UNIX and
     *  AF_NETLINK are NOT network (every process does those). */
    const inetConnects = (bin, argv) => {
      const out = path.join(tmp, 'trace-' + Math.random().toString(36).slice(2));
      try {
        execFileSync('strace', ['-f', '-qq', '-e', 'trace=network', '-o', out, bin, ...argv],
          { env: ENVBASE, stdio: 'ignore', timeout: 60000 });
      } catch { /* a non-zero exit is fine: the TRACE is the measurement */ }
      let text = ''; try { text = fs.readFileSync(out, 'utf-8'); } catch { return null; }
      const lines = text.split('\n').filter((l) => /\bconnect\(/.test(l) && /AF_INET6?/.test(l));
      return { n: lines.length, sample: lines.slice(0, 2).join(' | ') };
    };
    // NEGATIVE CONTROL FIRST: a deliberate LOOPBACK connect must be seen, or a
    // green measurement below means nothing. Loopback, never a vendor — the
    // rejected candidates stay un-run precisely because re-running them WOULD
    // be the call this law forbids.
    const ctl = inetConnects(process.execPath, ['-e', "const s=require('net').connect(1,'127.0.0.1');s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),300)"]);
    ok(ctl && ctl.n >= 1, `NEGATIVE CONTROL: the detector sees a deliberate loopback connect (${ctl?.n} INET connect lines) — a zero below is a measurement, not a blind spot`);
    for (const o of ORACLES) {
      const bin = cmdPath(o.backend === 'codex' ? 'codex' : o.backend);
      if (!bin) { ok(true, `SKIP live re-measurement of ${o.id}: ${o.backend} is not installed here (\`command -v ${o.backend}\` found nothing)`); continue; }
      const got = inetConnects(bin, o.argv.slice());
      ok(got && got.n === 0, `LIVE: ${o.id} (${o.backend} ${o.argv.join(' ')}) opened ZERO INET connections under strace${got && got.n ? ' — got ' + got.n + ': ' + got.sample : ''}`);
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  }
}

console.log(fail ? `FAIL (${fail})` : `ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
