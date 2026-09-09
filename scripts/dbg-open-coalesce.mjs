#!/usr/bin/env node
// MEASUREMENT (throwaway): can the daemon's `session-open` reply and the first
// DATA frame land in the SAME socket read?  If they can, then a client that
// only installs its onData sink after `ready` settles (a promise = a microtask
// LATER) drops those bytes — which for a silent session is the whole evidence
// the attach liveness probe runs on.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const { scratch } = await import(path.join(REPO, 'scripts/scratch.mjs'));

const ROOT = scratch('open-coalesce');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// a daemon that answers open-session and writes a data frame in the SAME tick
const OPEN_ANCHOR = 'if (msg.op === "open-session") {';
let src = fs.readFileSync(path.join(REPO, 'data/bin/vibespace-agentd.js'), 'utf-8');
if (src.split(OPEN_ANCHOR).length - 1 !== 1) throw new Error('anchor not unique');
src = src.replace(OPEN_ANCHOR, `${OPEN_ANCHOR}
        if (process.env.VS_FAULT_OPEN === "burst") {
          mux.control({ op: "session-open", chan: msg.chan, pid: 424242 });
          mux.data(msg.chan, Buffer.from("VSEARLY\\n"));
          return;
        }`);
const bundle = path.join(ROOT, 'burst.js');
fs.writeFileSync(bundle, src);

process.env.VIBESPACE_AGENTD_ROOT = path.join(ROOT, 'agentd');
process.env.VIBESPACE_NODE_MODULES = path.join(REPO, 'node_modules');
process.env.VS_FAULT_OPEN = 'burst';
const { DeviceManager } = require(path.join(REPO, 'src/agentd/client.js'));
const dm = new DeviceManager({
  dataDir: path.join(ROOT, 'data'), bundlePath: bundle,
  version: require(path.join(REPO, 'package.json')).version,
  nodeModules: path.join(REPO, 'node_modules'), log: () => { },
});
const killDaemon = () => {
  try {
    const pid = Number(fs.readFileSync(path.join(process.env.VIBESPACE_AGENTD_ROOT, 'state', 'agentd.pid'), 'utf8'));
    if (pid > 0) process.kill(pid, 'SIGKILL');
  } catch { }
};
process.on('exit', () => { killDaemon(); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { } });
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => process.exit(1));

await dm.connect();
let coalesced = 0, afterReady = 0, never = 0;
for (let i = 0; i < 8; i++) {
  const h = await dm.openSession({ cmd: '/bin/true', args: [], cols: 80, rows: 24 });
  // MASTER's shape: nothing is listening until `ready` settles.
  let seen = '';
  const readyP = h.ready.then(() => { /* master installs the shim HERE */ });
  h.onData = (b) => { seen += b.toString('utf-8'); };       // OUR fix installs this NOW
  await readyP;
  const before = /VSEARLY/.test(seen);
  await new Promise((r) => setTimeout(r, 400));             // …and did it EVER arrive?
  const ever = /VSEARLY/.test(seen);
  // A run where the byte never arrives at all measures NOTHING (the injected
  // fault did not reach the daemon) — count it separately or this is vacuous.
  if (before) coalesced++; else if (ever) afterReady++; else never++;
}
console.log(`open-session + first data in the SAME read: ${coalesced}/8   (later read: ${afterReady}/8)   (byte NEVER arrived — measurement vacuous: ${never}/8)`);
dm.stop();
process.exit(0);
