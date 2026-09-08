#!/usr/bin/env node
// Proxied POST bodies must reach the target (2.363.2, inc-mt2bpw2f, userW:
// "用 Proxy 打开这个网页，里面的交互按钮点不动"). Root cause, reproduced with
// headless chrome against an isolated harness: express.json() was mounted
// BEFORE unblocker, so every proxied JSON POST had its body stream consumed
// by the parser — unblocker forwarded a body-less request and the target
// waited on Content-Length until the client aborted. GETs were untouched, so
// proxied pages RENDERED but every interactive action (the pulse-console
// posts api/events for each click) hung silently. Fix: the json parser skips
// /proxy/ paths (unblocker stays mounted late so auth keeps covering the
// proxy — never an open proxy). This suite runs the REAL unblocker module in
// the same [auth-position → skip-json → unblocker] chain shape and asserts
// the round trip; a wiring pin holds server.js to the pattern.
import http from 'http';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const express = require(path.join(REPO, 'node_modules/express'));
const Unblocker = require(path.join(REPO, 'node_modules/unblocker'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); } };

// FREE ports (2026-09-07 round 2): a fixed pair is a claim on a name the whole
// BOX shares, and the fast tier that runs this suite is fail-fast with no
// retry — one squatter from any of this machine's ~160 checkouts of this repo
// turns an unrelated push red. Nothing outside this process needs the numbers.
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const TARGET_PORT = await freePort();
const PROXY_PORT = await freePort();

// target: GET ping + POST echo (reports how many body bytes actually arrived)
const target = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ got: body.length, echo: body.slice(0, 50) })); });
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end('{"pong":true}');
});
await new Promise((r) => target.listen(TARGET_PORT, r));

// proxy app: server.js chain shape — json parser SKIPS /proxy/, unblocker after
const app = express();
const jsonBody = express.json({ limit: '50mb' });
app.use((req, res, next) => (req.path.startsWith('/proxy/') ? next() : jsonBody(req, res, next)));
app.post('/api/local', (req, res) => res.json({ parsed: req.body }));
app.use(new Unblocker({ prefix: '/proxy/', responseMiddleware: [function stripFrameHeaders(data) { delete data.headers['x-frame-options']; }] }));
const proxySrv = app.listen(PROXY_PORT);
await new Promise((r) => proxySrv.on('listening', r));

const base = `http://127.0.0.1:${PROXY_PORT}`;
const tgt = `http://127.0.0.1:${TARGET_PORT}`;
const timed = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT ' + ms + 'ms')), ms))]);

// 1. proxied GET works (was never broken — the "page renders" half)
const g = await timed(fetch(`${base}/proxy/${tgt}/`).then((r) => r.json()), 4000).catch((e) => ({ err: e.message }));
ok('proxied GET reaches the target', g.pong === true, JSON.stringify(g));

// 2. THE bug: proxied JSON POST must round-trip with its body intact
const p1 = await timed(fetch(`${base}/proxy/${tgt}/api/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hello: 'world' }) }).then((r) => r.json()), 4000).catch((e) => ({ err: e.message }));
ok('proxied JSON POST delivers its body (the inc-mt2bpw2f hang)', p1.got === 17, JSON.stringify(p1));

// 3. non-JSON proxied POST too (belt)
const p2 = await timed(fetch(`${base}/proxy/${tgt}/api/events`, { method: 'POST', body: 'raw-bytes' }).then((r) => r.json()), 4000).catch((e) => ({ err: e.message }));
ok('proxied non-JSON POST delivers its body', p2.got === 9, JSON.stringify(p2));

// 4. the skip must not break normal routes: local JSON bodies still parse
const l = await timed(fetch(`${base}/api/local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' }).then((r) => r.json()), 4000).catch((e) => ({ err: e.message }));
ok('non-proxy routes still get parsed JSON bodies', l.parsed && l.parsed.a === 1, JSON.stringify(l));

// 5. wiring pins: server.js carries the exact pattern (unstaged-wiring class)
const sv = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
ok('server.js json parser skips /proxy/', /req\.path\.startsWith\('\/proxy\/'\) \? next\(\) : jsonBody/.test(sv));
ok('unblocker still mounted AFTER auth (no open proxy)', sv.indexOf('auth.middleware()') < sv.indexOf('app.use(unblocker)'));

target.close(); proxySrv.close();
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
