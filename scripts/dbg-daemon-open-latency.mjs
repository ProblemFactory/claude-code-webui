#!/usr/bin/env node
// MEASUREMENT (throwaway, not a gate suite): how long does a REAL local
// vibespace-device take to answer `open-session` with `session-open`?  The
// number sets attachToDtach's bounded `ready` budget — a budget invented from
// a feeling is exactly how a fallback stops firing when it matters.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const { scratch } = await import(path.join(REPO, 'scripts/scratch.mjs'));

const root = scratch('daemon-open-lat');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
process.env.VIBESPACE_AGENTD_ROOT = path.join(root, 'agentd');
process.env.VIBESPACE_NODE_MODULES = path.join(REPO, 'node_modules');

const { DeviceManager } = require(path.join(REPO, 'src/agentd/client.js'));
const dm = new DeviceManager({
  dataDir: path.join(root, 'data'),
  bundlePath: path.join(REPO, 'data/bin/vibespace-agentd.js'),
  version: require(path.join(REPO, 'package.json')).version,
  nodeModules: path.join(REPO, 'node_modules'),
  log: () => {},
});
const killDaemon = () => {
  try {
    const pid = Number(fs.readFileSync(path.join(process.env.VIBESPACE_AGENTD_ROOT, 'state', 'agentd.pid'), 'utf8'));
    if (pid) process.kill(pid, 'SIGTERM');
  } catch {}
};
process.on('exit', killDaemon);
process.on('SIGTERM', () => { killDaemon(); process.exit(1); });
process.on('SIGINT', () => { killDaemon(); process.exit(1); });

const t0 = Date.now();
await dm.connect();
console.log(`connect (spawn + handshake): ${Date.now() - t0} ms`);

// A) plain sh sessions
const plain = [];
for (let i = 0; i < 10; i++) {
  const t = Date.now();
  const h = await dm.openSession({ cmd: '/bin/sh', args: ['-c', 'sleep 30'], cols: 120, rows: 30 });
  await h.ready;
  plain.push(Date.now() - t);
  h.kill();
}
console.log('open-session→ready (sh) ms:', JSON.stringify(plain), 'max', Math.max(...plain));

// B) the real shape: dtach -a against a live socket
const sock = path.join(root, 'p.sock');
fs.writeFileSync(path.join(root, 'quiet.js'), 'process.stdin.resume();setTimeout(()=>process.exit(0),120000);\n');
const { execFileSync } = await import('node:child_process');
execFileSync('dtach', ['-n', sock, '-E', '-z', process.execPath, path.join(root, 'quiet.js')]);
await new Promise((r) => setTimeout(r, 400));
const att = [], firstByte = [];
for (let i = 0; i < 10; i++) {
  const t = Date.now();
  const h = await dm.openSession({ cmd: 'dtach', args: ['-a', sock, '-E', '-r', 'winch'], cols: 120, rows: 30 });
  let seen = null;
  h.onData = () => { if (seen === null) seen = Date.now() - t; };
  await h.ready;
  att.push(Date.now() - t);
  await new Promise((r) => setTimeout(r, 250));
  firstByte.push(seen);
  h.kill();
}
console.log('open-session→ready (dtach -a) ms:', JSON.stringify(att), 'max', Math.max(...att));
console.log('open-session→FIRST BYTE (dtach attach preamble) ms:', JSON.stringify(firstByte));

// C) 12 concurrent opens — the restore shape
{
  const t = Date.now();
  const hs = await Promise.all(Array.from({ length: 12 }, () =>
    dm.openSession({ cmd: 'dtach', args: ['-a', sock, '-E', '-r', 'winch'], cols: 120, rows: 30 })));
  await Promise.all(hs.map((h) => h.ready));
  console.log(`12 concurrent opens all ready in ${Date.now() - t} ms`);
  hs.forEach((h) => h.kill());
}

try { execFileSync('pkill', ['-f', sock]); } catch {}
dm.stop();
killDaemon();
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
