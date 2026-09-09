#!/usr/bin/env node
/**
 * ssh → ws graduation exists since 2.248.0 but was button-only, so machines
 * stayed on ssh forever. These pin the AUTOMATIC path's guards — every one of
 * them is a way to do something the operator did not ask for.
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { scratch } from './scratch.mjs';
const require = createRequire(import.meta.url);
const { HostManager } = require('../src/hosts.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const srv = readFileSync(new URL('../src/server/mounts-plugins-wiring.js', import.meta.url), 'utf-8')
  + readFileSync(new URL('../server.js', import.meta.url), 'utf-8');
const block = srv.slice(srv.indexOf('hosts.onSshConnected ='), srv.indexOf('const discDirtyTimers'));
ok(block.length > 200, 'auto-graduate handler exists');
ok(/serverSetting\('agentd\.autoGraduate'\) === false/.test(block), 'honours the off switch');
ok(/h\.transport === 'dial' \|\| h\.deviceId/.test(block), 'skips machines already on ws');
ok(/h\.autoGraduate === false/.test(block), 'honours a per-machine opt-out');
ok(/agentdDeps\.publicUrl\?\.\(\)/.test(block) && !/viaRelay: true/.test(block),
   'requires an operator-declared URL and never self-publishes to the relay');
ok(/6 \* 60 \* 60 \* 1000/.test(block), 'at most one attempt per machine per 6h');
ok(/catch \(e\)[\s\S]{0,200}serverNotice/.test(block), 'a failed attempt is reported, never silent');

// the extracted function must keep the invariants the button path had
const fn = srv.slice(srv.indexOf('async function graduateHostToDial'), srv.indexOf('app.post(\'/api/hosts/:id/graduate-dial\''));
ok(/http_code[\s\S]{0,400}graduation aborted \(staying on ssh\)/.test(fn), 'machine is asked whether it can reach us BEFORE installing');
ok(/ungraduateDial\(h\.id\)[\s\S]{0,120}installer failed/.test(fn), 'a failed installer rolls the record back');
ok(/device@\$\{dialHost/.test(fn), 'dialRoot mirrors the installer derivation');

// ssh must remain reachable as the rescue channel
const hostsSrc = readFileSync(new URL('../src/hosts.js', import.meta.url), 'utf-8');
ok(/onSshConnected\?\.\(id\)/.test(hostsSrc), 'the ssh connect path fires the hook');
const dc = hostsSrc.slice(hostsSrc.indexOf('async _deviceConnect(id)'), hostsSrc.indexOf('/** M2 remote install'));
ok(/dialOnline\?\.\(h\.deviceId\)[\s\S]{0,400}catch \{ \/\* ssh fallback below \*\//.test(dc), 'a dead ws link still falls back to ssh');

// a throwing consumer must not break connects
const h = new HostManager({ dataDir: scratch('grad') });
h.onSshConnected = () => { throw new Error('boom'); };
let threw = false;
try { h.onSshConnected?.('x'); } catch { threw = true; }
ok(threw, '(sanity) the hook itself can throw…');
ok(/try \{ this\.onSshConnected\?\.\(id\); \} catch \{ \}/.test(hostsSrc), '…and the connect path swallows it');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
