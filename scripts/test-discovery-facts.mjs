#!/usr/bin/env node
// ONE interpretation of discovery facts, any machine (CS separation, 2.278.0).
//
// The collectors legitimately differ (local rich sweep / daemon snapshot /
// ssh script fallback); the INTERPRETATION of the same bytes must not. It
// did: local named a session from the FIRST LINE of the first real user
// message while the remote parser whitespace-collapsed the WHOLE message
// (same session, two names); tail-ids had three implementations feeding one
// consumer; the daemon's lock scan missed the PID-reuse guard local has had
// for years. This test pins the now-single rules.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { scratch } from './scratch.mjs';
const require = createRequire(import.meta.url);
const { extractTailIds, nameFromUserRecord, nameFromUserLine, pidLooksClaude } = require('../src/discovery-facts.js');
const { readJsonlTailIds } = require('../src/session-store.js');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } };

// ── naming: the drift case that motivated this ──
const multiline = { type: 'user', message: { role: 'user', content: '帮我修这个bug\n下面是详细的日志\nERROR at foo.js:12' } };
ok(nameFromUserRecord(multiline) === '帮我修这个bug', 'multi-line message names from its FIRST LINE (local rule; the remote collapse appended the log)');
const arr = { type: 'user', message: { content: [{ type: 'text', text: '  spaced   name here  ' }] } };
ok(nameFromUserRecord(arr) === 'spaced   name here', 'array-content records extract the text block');
ok(nameFromUserRecord({ type: 'user', message: { content: '<vibespace-task-context>\nreal question' } }) === null, 'injected <tag> context is never a name');
ok(nameFromUserRecord({ type: 'user', message: { content: '/model claude-fable-5' } }) === null, 'slash-command echo is never a name');
ok(nameFromUserRecord({ type: 'user', message: { content: '\n\n  actual ask' } }) === 'actual ask', 'leading blank lines are skipped (first NON-EMPTY line)');
ok((nameFromUserRecord({ type: 'user', message: { content: 'x'.repeat(200) } }) || '').length === 80, '80-char cap');

// raw-line path (the ssh script truncates N lines — JSON.parse fails)
const fullLine = JSON.stringify(multiline);
ok(nameFromUserLine(fullLine) === '帮我修这个bug', 'raw full line parses to the same name as the record path');
const truncated = fullLine.slice(0, fullLine.indexOf('详细')); // cut mid-string: unparseable
ok(nameFromUserLine(truncated) === '帮我修这个bug', 'TRUNCATED line (regex fallback) still yields the identical first-line name');
ok(nameFromUserLine('J 123 456 /path') === null, 'non-user noise yields null');

// ── tail ids: one rule, and session-store now delegates to it ──
const tail = Array(5).fill('{"sessionId":"aaa"}').concat(['{"sessionId":"bbb"}', '{"sessionId":"aaa"}']).join('\n');
ok(JSON.stringify(extractTailIds(tail)) === '["aaa","bbb","aaa"]', 'runs uniq-collapse; re-appearance is a NEW run (last = current writer)');
const many = Array.from({ length: 12 }, (_, i) => `{"sessionId":"s${i}"}`).join('\n');
ok(extractTailIds(many).length === 8 && extractTailIds(many)[7] === 's11', 'last-8 cap keeps the newest runs (ssh script semantics)');
const tmp = scratch('df-tail') + '.jsonl';
fs.writeFileSync(tmp, tail + '\n');
ok(JSON.stringify(readJsonlTailIds(tmp)) === '["aaa","bbb","aaa"]', 'session-store readJsonlTailIds delegates to the SAME rule');
fs.rmSync(tmp);
ok(readJsonlTailIds('/nonexistent/x.jsonl') === null, "null-on-unreadable contract preserved (claimJsonls' no-tail-evidence class)");

// ── PID verification: the guard the daemon snapshot was missing ──
ok(pidLooksClaude(process.pid) === false, 'this node process is not claude (liveness alone would have said yes)');
ok(pidLooksClaude(999999999) === false, 'dead pid is false, never throws');

// ── the wiring is real: agentd bundle + hosts + session-store all import it ──
const agentdSrc = fs.readFileSync(new URL('../src/agentd/agentd.js', import.meta.url), 'utf-8');
ok(agentdSrc.includes("require('./../discovery-facts.js')") && agentdSrc.includes('pidLooksClaude(pid)'), 'daemon snapshot uses the shared module (bundled by esbuild — code sharing IS possible here)');
const hostsSrc = fs.readFileSync(new URL('../src/hosts.js', import.meta.url), 'utf-8');
ok(hostsSrc.includes("require('./discovery-facts')"), 'hosts N-line parser uses the shared naming');
const bundle = fs.readFileSync(new URL('../data/bin/vibespace-agentd.js', import.meta.url), 'utf-8');
ok(bundle.includes('pidLooksClaude') || bundle.includes('PID-reuse guard'), 'built daemon bundle actually carries the shared code');

console.log(fail ? `FAIL (${fail})` : `ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
