#!/usr/bin/env node
// HARNESS CONFORMANCE (S1 of docs/design-harness-plugins.md §2, 2.369.18):
// every registered harness runs the SAME assertions — descriptor shape,
// adapter interface (base methods + buildSessionArgs), normalizer duck
// contract, wrapper file + capability advert, store/locator, client META
// row + settings keys. This is the "twin-sets = 0 is a metric" law made
// mechanical: a third harness that misses a member fails HERE, not in a
// fleet incident. Unknown ids must fail loudly (never a claude fallback).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };

const { HARNESSES, harnessOf, harnessIds, chatHarnessIds, REQUIRED_DESCRIPTOR_KEYS } = require(path.join(REPO, 'src/harnesses/index.js'));
const { BackendAdapter } = require(path.join(REPO, 'src/adapters/base.js'));
const { createAdapterRegistry } = require(path.join(REPO, 'src/adapters/index.js'));
const { NORMALIZERS, createMessageManager } = require(path.join(REPO, 'src/normalizers.js'));
const { capsOf, BACKEND_CAPS } = require(path.join(REPO, 'src/backend-caps.js'));
const { hasConsumer, PROTOCOLS } = require(path.join(REPO, 'src/server/stdout/index.js')); // S5: protocol → stdout consumer registry
const { BACKEND_META } = await import(path.join(REPO, 'src/lib/agent-meta.js'));
const schemaSrc = fs.readFileSync(path.join(REPO, 'src/lib/settings-schema.js'), 'utf8');

ok(harnessIds().length >= 3 && ['claude', 'codex', 'shell'].every((id) => HARNESSES[id]), `registry carries the three built-in harnesses (${harnessIds().join(', ')})`);
let threw = false; try { harnessOf('gemini'); } catch { threw = true; }
ok(threw, 'an unknown harness id THROWS (never a claude fallback)');
ok(createMessageManager('claude', 'x') && (() => { try { createMessageManager('gemini', 'x'); return false; } catch { return true; } })(), 'normalizer registry: known id works, unknown id throws');

const BASE_METHODS = ['formatChatInput', 'formatInterrupt', 'formatPermissionResponse', 'formatSetPermissionMode', 'formatSetModel', 'formatSetEffort', 'postInterrupt'];
const NORM_METHODS = ['onOp', 'processLive', 'convertHistory', 'convertHistoryAsync', 'tail', 'slice', 'turnMap'];
const registry = createAdapterRegistry({ claudeCmd: 'claude', codexCmd: 'codex', codexSandboxSupported: true, chatWrapper: '/w/chat', codexChatWrapper: '/w/codex', acpWrapper: '/w/acp', acpCommands: { opencode: '/usr/bin/opencode' }, ptyWrapper: '/w/pty', buffersDir: '/b' });

for (const id of harnessIds()) {
  const h = HARNESSES[id];
  console.log(`— ${id}`);
  ok(REQUIRED_DESCRIPTOR_KEYS.every((k) => k in h), `${id}: descriptor declares ${REQUIRED_DESCRIPTOR_KEYS.join('/')}`);
  ok(h.caps === capsOf(id) && h.caps === BACKEND_CAPS[id], `${id}: caps ARE the backend-caps row (one source)`);
  const ad = registry.get(id);
  ok(ad instanceof BackendAdapter && ad instanceof h.Adapter, `${id}: adapter registry instantiates the descriptor's Adapter`);
  if (h.kind === 'chat') {
    for (const m of BASE_METHODS) ok(typeof ad[m] === 'function', `${id}: adapter implements ${m}`);
    ok(typeof ad.buildSessionArgs === 'function', `${id}: adapter implements buildSessionArgs (required by ws-create, undeclared in base.js)`);
    const spec = ad.buildSessionArgs({ cwd: '/tmp', mode: 'chat', permissionMode: 'default' });
    ok(spec && typeof spec.cmd === 'string' && Array.isArray(spec.args) && typeof spec.wrapper === 'string' && spec.mode === 'chat' && spec.env && typeof spec.env === 'object', `${id}: buildSessionArgs({mode:'chat'}) → {cmd,args,wrapper,cwd,mode,env}`);
    const mm = new h.Normalizer('contract');
    for (const m of NORM_METHODS) ok(typeof mm[m] === 'function', `${id}: normalizer implements ${m}`);
    ok(Array.isArray(mm.listeners) && typeof mm.total === 'number' && Array.isArray(mm.messages), `${id}: normalizer exposes listeners/total/messages`);
    ok(typeof mm.injectPeerCard === 'function', `${id}: normalizer renders peer/notification cards (injectPeerCard)`);
    ok(NORMALIZERS[id] === h.Normalizer, `${id}: normalizer registry row is the descriptor's Normalizer`);
    ok(fs.existsSync(path.join(REPO, h.wrapper)), `${id}: wrapper file exists (${h.wrapper})`);
    const w = fs.readFileSync(path.join(REPO, h.wrapper), 'utf8');
    ok(/caps\s*[:=]\s*\{/.test(w), `${id}: wrapper adverts a caps object in its sidecar meta`);
    ok(h.store && typeof h.store.locateTranscript === 'function' && Array.isArray(h.store.transcriptDirs) && typeof h.store.conversationIdField === 'string', `${id}: store declares locateTranscript/transcriptDirs/conversationIdField`);
    ok(typeof h.settingsPrefix === 'string' && schemaSrc.includes(`'${h.settingsPrefix}.defaultModel'`) && schemaSrc.includes(`'${h.settingsPrefix}.defaultPermissionMode'`), `${id}: settings schema carries ${h.settingsPrefix}.defaultModel/.defaultPermissionMode`);
    ok(h.inject && ['hooks', 'wrapper', 'acp'].includes(h.inject.kind) && typeof h.inject.sessionStartHonoured === 'boolean' && Array.isArray(h.inject.hookEvents), `${id}: declares its context-injection strategy (${h.inject?.kind}, sessionStartHonoured=${h.inject?.sessionStartHonoured})`);
    if (h.inject?.hookFile) ok(typeof h.inject.hookFile.file === 'function' && typeof h.inject.hookFile.file() === 'string' && typeof h.inject.hookFile.createIfMissing === 'boolean', `${id}: hook file declaration is well-formed (${h.inject.hookFile.file()})`);
    ok(typeof h.caps.streamProtocol === 'string', `${id}: caps name a stream protocol (${h.caps.streamProtocol})`);
    ok(hasConsumer(h.caps.streamProtocol), `${id}: its stream protocol has a registered stdout consumer (src/server/stdout/index.js: ${h.caps.streamProtocol}) — the descriptor NAMES it, the registry RESOLVES it (S5)`);
    ok(!('stdout' in h) && !('stream' in h), `${id}: no stdout/stream twin on the descriptor — caps.streamProtocol is the ONE source of truth`);
  }
  const meta = BACKEND_META[id];
  ok(meta && meta.id === id && meta.label && meta.badgeClass, `${id}: client BACKEND_META row exists`);
  if (h.kind === 'chat') ok(Array.isArray(meta.fallbackModels) && (meta.fallbackModels.length > 0 || meta.modelsFromAgent === true) && meta.caps, `${id}: client META carries fallbackModels (or modelsFromAgent) + feature caps`);
}
ok(Object.keys(BACKEND_META).every((id) => HARNESSES[id]), 'every client META row has a server harness (no client-only backend)');
ok(chatHarnessIds().join(',') === 'claude,codex,opencode', `chat-capable harnesses: ${chatHarnessIds().join(',')}`);
// S5 pins: the stdout registry covers exactly the declared protocols; an unknown one has no consumer (never a stream-json fallback)
ok(PROTOCOLS.every((p) => chatHarnessIds().some((id) => HARNESSES[id].caps.streamProtocol === p)), `no dead stdout consumer row: every registered protocol is declared by a chat harness (${PROTOCOLS.join(',')})`);
ok(!hasConsumer('gemini-events') && !hasConsumer(null) && !hasConsumer(capsOf('shell').streamProtocol), 'an unregistered / null protocol has NO stdout consumer (session-stdout reports it loudly; nothing defaults to stream-json)');
ok(BACKEND_META.codex.fallbackModels[0] === 'gpt-6-astra', 'codex fallback model list leads with gpt-6-astra (0.153.4 catalog default)');
// S7 pins: client settings-prefix / account-surface collapses are gone
const libSrc = fs.readdirSync(path.join(REPO, 'src/lib')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(REPO, 'src/lib', f), 'utf8')).join('\n');
ok(!/=== 'codex' \? 'codex' : 'claude'/.test(libSrc) && !/codex \? 'codex' : 'claude'/.test(libSrc), "no `codex ? 'codex' : 'claude'` collapse left in src/lib (a third backend would inherit claude's settings)");
ok(!/backend !== 'claude' && backend !== 'codex'/.test(libSrc) && !/\(backend === 'claude' \|\| backend === 'codex'\) && acctList/.test(libSrc), 'account surfaces gate on META caps.accounts, not an id list');
for (const id of chatHarnessIds()) ok(BACKEND_META[id].settingsPrefix === HARNESSES[id].settingsPrefix, `${id}: client settingsPrefix matches the server descriptor (${HARNESSES[id].settingsPrefix})`);
// S2 pins: credential mechanics live on the descriptor; accounts.js reads them
for (const id of chatHarnessIds()) {
  const c = HARNESSES[id].creds;
  if (!c) { ok(BACKEND_META[id].caps?.accounts === false && HARNESSES[id].caps.pool === false, `${id}: no credential mechanics ⇒ client META caps.accounts false + no pool (the agent holds its own login)`); continue; }
  ok(c && typeof c.subsDirName === 'string' && typeof c.authFile === 'string' && typeof c.spawnEnvVar === 'string' && typeof c.loginLabel === 'string' && typeof c.defaultIdField === 'string' && typeof c.keychainSensitive === 'boolean' && typeof c.parseAuth === 'function', `${id}: creds descriptor complete (${c?.subsDirName}, ${c?.spawnEnvVar})`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-creds-'));
  ok(c.parseAuth(tmp).loggedIn === false, `${id}: parseAuth on an empty dir = not logged in (never throws)`);
  if (id === 'claude') { fs.writeFileSync(path.join(tmp, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'max', expiresAt: Date.now() + 3600000 } })); fs.writeFileSync(path.join(tmp, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c', organizationName: 'Org' } })); const r = c.parseAuth(tmp); ok(r.loggedIn && r.subscriptionType === 'max' && r.email === 'a@b.c' && r.org === 'Org' && r.accessToken === 'tok', 'claude parseAuth reads creds + identity from the dir'); }
  if (id === 'codex') { const claims = Buffer.from(JSON.stringify({ email: 'x@y.z', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } })).toString('base64url'); fs.writeFileSync(path.join(tmp, 'auth.json'), JSON.stringify({ tokens: { access_token: 'a', id_token: `h.${claims}.s` } })); const r = c.parseAuth(tmp); ok(r.loggedIn && r.email === 'x@y.z' && r.plan === 'pro' && r.subscriptionType === 'pro' && r.authMode === 'chatgpt', 'codex parseAuth reads identity from the id_token (subscriptionType mirrors plan)'); }
  fs.rmSync(tmp, { recursive: true, force: true });
}
const acc = fs.readFileSync(path.join(REPO, 'src/accounts.js'), 'utf8');
// S2 remainder (2.369.27): ship files / seeders / remote-creds shape / host-facts key / swap bump ride the descriptor too
for (const id of chatHarnessIds()) {
  const c = HARNESSES[id].creds;
  if (!c) continue;
  ok(Array.isArray(c.files) && c.files.includes(c.authFile) && typeof c.hostFactsKey === 'string' && typeof c.longLivedToken === 'boolean' && typeof c.supportsApiKeys === 'boolean' && typeof c.seedDir === 'function' && c.probe && typeof c.probe.file === 'string' && typeof c.probe.marker === 'string' && ('bumpFile' in c) && typeof c.remoteSymlinks === 'object' && Array.isArray(c.ensureTargets), `${id}: creds remainder complete (files ${c.files?.join('+')}, hostFactsKey ${c.hostFactsKey}, bumpFile ${c.bumpFile})`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-seed-'));
  const prevHome = process.env.CODEX_HOME; process.env.CODEX_HOME = path.join(tmp, 'shared'); // keep the codex seeder off the real ~/.codex
  try { c.seedDir(tmp); ok(fs.readdirSync(tmp).length >= 1, `${id}: seedDir populates a fresh account dir (${fs.readdirSync(tmp).join(',')})`); } finally { if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome; }
  fs.rmSync(tmp, { recursive: true, force: true });
}
ok((acc.match(/this\._remoteCreds\(/g) || []).length >= 2 && !/CODEX_SUB_FILES|CLAUDE_SUB_FILES/.test(acc) && !/hostFacts\.codex\?\.email/.test(acc) && !/const isCodex = rec\.backend === 'codex'/.test(acc) && !/_seedCodexDir\(dir\) \{\n    const shared/.test(acc) && !/localEnv: \{ CODEX_HOME:/.test(acc) && !/localEnv: \{ CLAUDE_SECURESTORAGE_CONFIG_DIR:/.test(acc), 'accounts.js export/import/delete/verdict/spawn-env/remote-creds read the descriptor (S2 remainder)');
ok((acc.match(/this\._readAuthFor\(/g) || []).length >= 4 && (acc.match(/this\._acctDir\(/g) || []).length >= 3 && !/codexSubDir\(a\.id\) : this\.subDir\(a\.id\)/.test(acc) && !/\? this\.readCodexSubAuth\(/.test(acc), 'accounts.js reads dirs/auth/labels/default-field through the descriptor (mechanical codex-or-claude ternaries gone)');
// S6 wiring pins: injection topology decided by the strategy, never a backend id
const ar = fs.readFileSync(path.join(REPO, 'src/agent-routes.js'), 'utf8');
ok(!/s\.backend !== 'codex'/.test(ar) && (ar.match(/honoursSessionStart\(s\)/g) || []).length === 4, 'agent-routes: the four SessionStart seen-gates consult inject.sessionStartHonoured (no backend-id gate left)');
const atg = fs.readFileSync(path.join(REPO, 'src/server/agent-tool-generators.js'), 'utf8');
ok(/for \(const ev of ALL_HOOK_EVENTS\)/.test(atg) && /ALL_HOOK_EVENTS = \[\.\.\.new Set\(listHarnesses\(\)/.test(atg) && !/\[\.\.\.HOOK_EVENTS, 'Stop'\]/.test(atg), 'the hook REMOVAL path strips every event any harness registers (union from the registry; the old literal was a lost binding after S6)');
ok(/HOOK_FILES = Object\.fromEntries\(listHarnesses\(\)/.test(atg) && /HOOK_EVENTS_FOR = \(harness\) => \{ const h = listHarnesses\(\)/.test(atg) && !/harness === 'claude' \? \[/.test(atg), 'agent-tool-generators: hook files + events come from the registry (no per-harness literals)');
ok(HARNESSES.claude.inject.hookEvents.includes('Stop') && !HARNESSES.codex.inject.hookEvents.includes('Stop') && HARNESSES.codex.inject.sessionStartHonoured === false, 'claude registers Stop, codex does not and ignores SessionStart (zero behaviour change)');

// ── turnState / inProgressTools (design-harness-features §2.5 + §3.5) ──
// Where "is a turn running" comes from, declared per harness and MIRRORED on
// the client. §6's landing rule: a caps row the server does not have must not
// exist on the client either — that is exactly how `review` drifted.
console.log('— turnState');
{
  for (const id of Object.keys(BACKEND_CAPS)) {
    const row = BACKEND_CAPS[id];
    ok([null, 'authoritative', 'derived'].includes(row.turnState) && typeof row.inProgressTools === 'boolean',
      `${id}: declares turnState + inProgressTools (${row.turnState} / ${row.inProgressTools})`);
  }
  ok(capsOf('claude').turnState === 'authoritative' && capsOf('claude').inProgressTools === false,
    "claude publishes system/session_state_changed (idle|running|requires_action) — VERIFIED on our stdout; inProgressTools stays FALSE because set_in_progress_tool_use_ids never leaves the CLI's own host callback (test-stdout-registry re-measures the wire)");
  // NO harness may claim a tool-granular run set today. This is the assert that
  // FAILS if someone flips a row back on the strength of a record existing in a
  // schema — the wire leg in test-stdout-registry is the only thing that may
  // justify flipping it, and it says so in its own failure message.
  ok(Object.values(BACKEND_CAPS).every((r) => r.inProgressTools === false),
    'no harness claims inProgressTools — a cap is a promise to a surface, and no surface can currently draw an "executing" dot from any harness',
    JSON.stringify(Object.fromEntries(Object.entries(BACKEND_CAPS).map(([k, v]) => [k, v.inProgressTools]))));
  ok(capsOf('codex').turnState === 'authoritative' && capsOf('codex').inProgressTools === false,
    'codex: turn/started + turn/completed are its own turn boundaries; no run-set record exists');
  ok(capsOf('opencode').turnState === 'authoritative' && capsOf('opencode').inProgressTools === false,
    "opencode (ACP v1): prompt_end's stop reason is the agent's own statement that the prompt is over");
  ok(capsOf('shell').turnState === null && capsOf('shell').inProgressTools === false, 'shell declares no turn concept at all (terminal-only)');
  ok(capsOf('gemini').turnState === null && capsOf('gemini').inProgressTools === false, "an unknown backend gets the no-turn row (never claude's by accident)");
  // The declaration must be TRUE of the consumer: each authoritative harness's
  // stdout consumer flips _isStreaming from its own protocol records.
  const consumers = { claude: 'claude-stream-json', codex: 'codex-events', opencode: 'acp-events' };
  for (const [id, mod] of Object.entries(consumers)) {
    const src = fs.readFileSync(path.join(REPO, `src/server/stdout/${mod}.js`), 'utf8');
    ok(capsOf(id).turnState !== 'authoritative' || /session\._isStreaming = /.test(src),
      `${id}: the 'authoritative' claim is backed by its consumer actually driving _isStreaming (${mod}.js)`);
  }
  // …and the CLIENT mirror deep-equals it, key by key, in both directions.
  for (const id of Object.keys(BACKEND_META)) {
    const caps = BACKEND_META[id].caps;
    if (!caps) continue; // shell carries no caps object
    ok(caps.turnState === capsOf(id).turnState && caps.inProgressTools === capsOf(id).inProgressTools,
      `${id}: client META mirrors turnState/inProgressTools exactly (no drift)`, JSON.stringify({ client: [caps.turnState, caps.inProgressTools], server: [capsOf(id).turnState, capsOf(id).inProgressTools] }));
    for (const k of ['turnState', 'inProgressTools']) {
      ok(k in capsOf(id), `${id}: the client's ${k} row EXISTS on the server (a client-only caps row is forbidden — the 'review' drift)`);
    }
  }
  // The client gates on the ROW, never on a backend id.
  const sb = fs.readFileSync(path.join(REPO, 'src/lib/chat-status-bar.js'), 'utf8');
  ok(!/_backend === 'claude'[^\n]*turnState|turnState[^\n]*_backend === 'claude'/.test(sb),
    'the status bar never asks "is this claude?" to decide whether to draw the turn state');
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
