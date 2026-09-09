#!/usr/bin/env node
// MEASUREMENT (throwaway): what does it take to make an INTERACTIVE login shell
// inside dtach emit on a timer, reliably, on a developer box whose zsh sources a
// full oh-my-zsh?  The e2e leg of test-restore-liveness needs a session that
// keeps printing across a server restart, and the obvious `while :; do echo …`
// one-liner is parsed by whatever $SHELL the machine has.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const { scratch } = await import(path.join(REPO, 'scripts/scratch.mjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = scratch('probe-shell-fixture');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(path.join(ROOT, 'tick.sh'), 'while :; do echo VSTICK; sleep 0.4; done\n');

const pty = require(path.join(REPO, 'node_modules/node-pty'));
const sock = path.join(ROOT, 's.sock');
const shell = process.env.SHELL || '/bin/sh';
const p = pty.spawn('dtach', ['-c', sock, '-E', '-r', 'none', '/usr/bin/env', 'TERM=xterm-256color', 'PROMPT_EOL_MARK=', shell, '-l'],
  { name: 'xterm-256color', cols: 80, rows: 24, env: { ...process.env, TERM: 'xterm-256color' }, cwd: ROOT });
let all = '', lastAt = Date.now();
p.onData((d) => { all += d; lastAt = Date.now(); });

const count = () => (all.match(/VSTICK/g) || []).length;

// A) the naive shape, typed 1.5 s in (what the first draft did)
await sleep(1500);
p.write('while :; do echo VSTICK; sleep 0.4; done\n');
await sleep(3000);
console.log(`A) naive one-liner typed at 1.5s → ${count()} VSTICK occurrences  (shell=${shell})`);
console.log('   tail:', JSON.stringify(all.slice(-160)));

// B) wait for the shell to go QUIET, then exec a SCRIPT FILE (one simple word list)
all = ''; lastAt = Date.now();
const t0 = Date.now();
while (Date.now() - t0 < 15000 && (all.length === 0 || Date.now() - lastAt < 700)) await sleep(100);
console.log(`B) shell settled after ${Date.now() - t0} ms of quiet-watching`);
let sends = 0;
for (let attempt = 1; attempt <= 3; attempt++) {
  const before = count();
  p.write(`exec sh ${path.join(ROOT, 'tick.sh')}\n`); sends++;
  const t1 = Date.now();
  while (Date.now() - t1 < 4000 && count() < before + 3) await sleep(150);
  if (count() >= before + 3) break;
}
console.log(`B) exec of a script file → ${count()} occurrences after ${sends} send(s)`);

// C) does it survive the CLIENT dying (= the server being SIGKILLed)?
try { p.kill(); } catch { }
await sleep(400);
const p2 = pty.spawn('dtach', ['-a', sock, '-E', '-r', 'winch'], { name: 'xterm-256color', cols: 80, rows: 24, env: process.env });
let seen = '';
p2.onData((d) => { seen += d; });
await sleep(2500);
console.log('C) after the attach client dies, an independent reader sees VSTICK:', /VSTICK/.test(seen));
try { p2.kill(); } catch { }
try { execFileSync('pkill', ['-f', sock]); } catch { }
fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(0);
