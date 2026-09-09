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
import { scratch } from './scratch.mjs';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };

const { HARNESSES, harnessOf, harnessIds, chatHarnessIds, REQUIRED_DESCRIPTOR_KEYS } = require(path.join(REPO, 'src/harnesses/index.js'));
const { BackendAdapter } = require(path.join(REPO, 'src/adapters/base.js'));
const { createAdapterRegistry } = require(path.join(REPO, 'src/adapters/index.js'));
const { NORMALIZERS, createMessageManager } = require(path.join(REPO, 'src/normalizers.js'));
const { capsOf, BACKEND_CAPS, worktreeCaps, worktreeRefusal, worktreeSpawnArgs, worktreePick, worktreeLatchWrite, NO_WORKTREE } = require(path.join(REPO, 'src/backend-caps.js'));
const { hasConsumer, PROTOCOLS } = require(path.join(REPO, 'src/server/stdout/index.js')); // S5: protocol → stdout consumer registry
const { BACKEND_META, backendFeatureCaps, worktreeCapsFor, worktreePick: clientWorktreePick, worktreeLatchWrite: clientWorktreeLatchWrite } = await import(path.join(REPO, 'src/lib/agent-meta.js'));
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
// ── the caps MIRROR (design-harness-features §6 landing discipline): a caps row
// the client also carries must be BYTE-IDENTICAL to the server's, and a row the
// client carries ALONE is how §2.13's `review` drifted (client had it, server
// never did, so nothing could disagree). Deep-compared per row, per backend.
{
  const MIRRORED = ['permissionRules', 'responseStyle', 'inputModes'];  // rows both tiers carry
  const norm = (v) => JSON.stringify(v, Object.keys(v || {}).sort());
  // A caps-LESS client row is deliberate for a backend with no agent (`shell`
  // carries no caps object at all, so every chrome gate reads the all-false
  // fallback). Those are asserted through the fallback below, not row by row.
  const mirroredIds = Object.keys(BACKEND_META).filter((id) => BACKEND_META[id].caps);
  for (const row of MIRRORED) {
    for (const id of mirroredIds) {
      const server = capsOf(id)[row], client = BACKEND_META[id].caps[row];
      ok(server !== undefined && client !== undefined && norm(server) === norm(client),
        `${id}: client META caps.${row} mirrors the server backend-caps row exactly`,
        `server=${JSON.stringify(server)} client=${JSON.stringify(client)}`);
    }
    // …and the row cannot be a client-only invention (the §2.13 drift shape)
    ok(Object.keys(BACKEND_CAPS).every((id) => BACKEND_CAPS[id][row] !== undefined),
      `every SERVER harness row declares ${row} (a client-only caps row is how \`review\` drifted)`);
  }
  const { backendFeatureCaps } = await import(path.join(REPO, 'src/lib/agent-meta.js'));
  // shell / an unknown id: both tiers must land on the SAME all-false row, or a
  // surface would offer a no-agent session something no server rung can answer.
  for (const id of ['shell', 'nope-not-a-backend']) {
    ok(norm(backendFeatureCaps(id).permissionRules) === norm(capsOf(id).permissionRules) && capsOf(id).permissionRules.source === null,
      `${id}: the all-false permissionRules row reads identically on both tiers (chrome shows nothing it cannot do)`,
      `server=${JSON.stringify(capsOf(id).permissionRules)} client=${JSON.stringify(backendFeatureCaps(id).permissionRules)}`);
  }
  ok(!BACKEND_META.shell.caps, 'shell carries NO client caps object on purpose — its chrome resolves through the all-false fallback');
}
// ── THE QUEUE IS A CLAIM, SO IT MUST BE RE-STATABLE (2026-09-09) ───────────
// A queue publication is a stdout record and every wrapper that owns a queue
// keeps its stdout in a RING (MAX_BUFFER, head-dropped), so a server that
// restarts rebuilds a normalizer that has never seen one: its `queue: []` is a
// GUESS, byte-identical whether the wrapper's queue is empty or holds 25 items.
// Every harness that declares a queue therefore owes THREE things — the ask
// (adapter), the answer (wrapper verb) and the per-PROCESS advert the server
// gates the ask on. This is the conformance row, so a FOURTH harness that
// declares queueVerbs and forgets one fails HERE, not in a fleet report.
for (const id of chatHarnessIds()) {
  const verbs = capsOf(id).inputModes?.queueVerbs || [];
  const ad = registry.get(id);
  const w = fs.readFileSync(path.join(REPO, HARNESSES[id].wrapper), 'utf8');
  if (!verbs.length) {
    // claude: the CLI owns its own queue and publishes nothing, so there is
    // nothing to re-state — and the adapter must REFUSE rather than format a
    // frame its wrapper would drop (the accept-and-ignore failure of 2.361.4).
    let threw = '';
    try { ad.formatQueueResync(); } catch (e) { threw = e.message; }
    ok(!!threw, `${id}: declares NO queue verbs ⇒ formatQueueResync REFUSES with a reason (${threw})`);
    continue;
  }
  let frame = null, err = '';
  try { frame = JSON.parse(ad.formatQueueResync()); } catch (e) { err = e.message; }
  ok(frame && frame.type === 'queue-resync' && Object.keys(frame).length === 1,
    `${id}: adapter formats the resync ASK as a bare {type:'queue-resync'} frame (no id, no text ⇒ no size gate to get wrong)`, err || JSON.stringify(frame));
  ok(/msg\.type === 'queue-resync'|case 'queue-resync'/.test(w),
    `${id}: its wrapper SERVES the verb (${path.basename(HARNESSES[id].wrapper)})`);
  ok(/queueResync:\s*true/.test(w),
    `${id}: …and ADVERTS it in the sidecar it writes — the per-PROCESS gate, because a wrapper spawned before the verb either drops the frame silently (codex) or answers it with a VISIBLE error card (ACP)`);
}
// …and the server READS that advert (wrapperCaps is the ONE reader of a
// wrapper's own file; a caps flag nothing surfaces is a fix that never landed).
{
  const { wrapperCaps } = require(path.join(REPO, 'src/server/wrapper-files.js'));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-hc-qr-'));
  fs.writeFileSync(path.join(d, 'sess-new.json'), JSON.stringify({ caps: { inputQueue: true, queueResync: true } }));
  fs.writeFileSync(path.join(d, 'sess-old.json'), JSON.stringify({ caps: { inputQueue: true } }));
  ok(wrapperCaps(d, 'sess-new', '/x').queueResync === true, 'wrapperCaps surfaces queueResync from a REAL sidecar file');
  ok(wrapperCaps(d, 'sess-old', '/x').queueResync === false, '…and a wrapper predating the verb reads FALSE (never inherited from inputQueue)');
  ok(wrapperCaps(d, 'sess-missing', '/x').queueResync === false, '…and an unreadable sidecar (a REMOTE wrapper: its file is on ITS machine) is FALSE — unknown is never "yes"');
  fs.rmSync(d, { recursive: true, force: true });
}
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

// ── §2.13 caps收口: server↔client DEEP COMPARE + no backend-id gate left ──
// The drift this exists to stop is REAL: the client carried `caps.review` for
// releases while src/backend-caps.js had no such row at all, so the mirror had
// nothing to be checked against and four call sites kept gating on a backend
// id instead. Two assertions: (a) every client caps key is either the server
// row's value (deep) or a named chrome-only flag, (b) the four call sites read
// caps — proven by a checker that is itself proven on a planted gate.
console.log('— caps mirror (§2.13)');
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Client-only FEATURE flags: pure chrome with no server behaviour behind them.
// A NEW client-only key fails here — that is the law ("a client-only row is
// forbidden"), with today's four grandfathered BY NAME.
// 2026-09-08: 'autoResume' LEFT this list — it is a real server row now
// (deriveAutoResume, written by the registry from the descriptor), so the deep
// compare below enforces the mirror instead of grandfathering it. That is the
// law working: a client-only flag is allowed only while nothing on the server
// answers for it.
const CLIENT_ONLY_OK = new Set(['effort', 'accounts', 'quotaRefresh']);
for (const id of chatHarnessIds()) {
  const srv = capsOf(id), cli = BACKEND_META[id].caps || {};
  const drift = Object.keys(cli).filter((k) => (k in srv ? !deepEq(srv[k], cli[k]) : !CLIENT_ONLY_OK.has(k)));
  ok(drift.length === 0, `${id}: client caps mirror the server row (or are named chrome-only flags)`, drift.map((k) => `${k}: server=${JSON.stringify(srv[k])} client=${JSON.stringify(cli[k])}`).join(' | '));
  ok(['review', 'renameWriteback', 'forkAtMessage'].every((k) => typeof srv[k] === 'boolean' && typeof cli[k] === 'boolean'),
    `${id}: review / renameWriteback / forkAtMessage exist on BOTH sides (review=${srv.review} renameWriteback=${srv.renameWriteback} forkAtMessage=${srv.forkAtMessage})`);
}
ok(capsOf('claude').forkAtMessage === true && capsOf('claude').fork === true && capsOf('codex').forkAtMessage === false && capsOf('codex').fork === true,
  'forkAtMessage is NOT fork: claude can fork at a message (--resume-session-at <uuid> --fork-session), codex forks the whole thread only');
ok(capsOf('codex').review === true && capsOf('claude').review === false && capsOf('codex').renameWriteback === true && capsOf('claude').renameWriteback === false,
  'review + renameWriteback are codex-side today (the values the four call sites used to hardcode)');

// The checker: a backend-id gate anywhere in a named block. Proven on a
// PLANTED gate before it is trusted to report a clean tree (a grep pin that
// can only ever pass is not a pin).
const hasBackendIdGate = (text) => /backend\s*[!=]==\s*'(?:codex|claude|opencode|shell)'/.test(text);
const blockOf = (src, marker, lines) => {
  const i = src.indexOf(marker);
  return i < 0 ? null : src.slice(i).split('\n').slice(0, lines).join('\n');
};
const SITES = [
  ['src/ws-handler.js', "case 'review-start': {", 12, 'ws review-start'],
  ['src/ws-handler.js', 'if (trimmedName) session.name = trimmedName;', 8, 'ws rename writeback'],
  ['src/lib/chat-view.js', '_syncReviewAvailability() {', 8, 'client review availability'],
  ['src/lib/chat-view.js', '_startReadOnlyPolling() {', 8, 'client detached-review poll'],
  ['src/lib/chat-renderers.js', 'addForkBtn(el, msg) {', 8, 'per-message fork button'],
  // The ACTION half of the same capability. Round 1 gated only the button, so
  // the first harness whose row said forkAtMessage:true would have shown a
  // control whose click returned silently on a `backend !== 'claude'` branch.
  ['src/lib/chat-view.js', '_forkFromMessage(uuid, msg) {', 8, 'per-message fork handler'],
  // The TRIGGER half of renameWriteback (round 3). The pin above covers the ws
  // case that DOES the writeback; this is the only site that decides whether
  // the `rename-session` frame is produced at all, and it read
  // `sessionOrKey?.backend === 'codex'`. Same latent shape as the fork defect
  // with the halves swapped: the first harness whose row flips to true would
  // have had a server ready to write and a client that never asks.
  ['src/lib/sidebar-state.js', 'proto.renameSession = async function', 28, 'client rename-writeback trigger'],
];
for (const [file, marker, lines, label] of SITES) {
  const block = blockOf(fs.readFileSync(path.join(REPO, file), 'utf8'), marker, lines);
  ok(block !== null, `${label}: the call site is still where the pin looks (${file} :: ${marker})`);
  ok(block !== null && !hasBackendIdGate(block), `${label}: gated on caps, no backend-id branch left`, block ? block.split('\n').filter((l) => hasBackendIdGate(l)).join(' / ') : 'marker gone');
  ok(hasBackendIdGate(`${block}\n  if (backend !== 'claude') return;`), `${label}: NEGATIVE CONTROL — the checker DOES catch a planted backend-id gate`);
}

// "No backend-id branch left" is an ABSENCE test, and deleting the gate
// outright also passes it — which for the rename trigger is a real behaviour
// change (the ws case writes session.name + session-meta and broadcasts, so
// sending the frame for claude is not a no-op). So the trigger is ALSO pinned
// positively: it must read the capability row.
const READS_RENAME_CAP = /backendFeatureCaps\(sessionOrKey\?\.backend\)\.renameWriteback/;
const renameTrigger = blockOf(fs.readFileSync(path.join(REPO, 'src/lib/sidebar-state.js'), 'utf8'), 'proto.renameSession = async function', 28);
ok(READS_RENAME_CAP.test(renameTrigger || ''), 'client rename-writeback trigger: reads caps.renameWriteback (the mirror row test-harness-contract deep-compares), so it cannot be silently DELETED either');
ok(!READS_RENAME_CAP.test("if (sessionOrKey?.backend === 'codex' && name.trim()) this.app.renameBackendSession?.(sessionOrKey, name.trim());"),
  '…NEGATIVE CONTROL: that checker reads FALSE on the pre-fix backend-id line');
ok(/import \{ getSessionKey, backendFeatureCaps \} from '\.\/agent-meta\.js';/.test(fs.readFileSync(path.join(REPO, 'src/lib/sidebar-state.js'), 'utf8')),
  '…and the predicate is the SHARED one (agent-meta), not a local caps twin');
// ZERO BEHAVIOUR CHANGE TODAY (the reason this is a drift fix, not a feature):
// the predicate the trigger now reads answers exactly what the deleted id test
// answered, for every backend that ships — and for the two falsy shapes the
// call site really passes (a bare string session key, and an unknown backend),
// where `sessionOrKey?.backend` is undefined.
for (const id of [...Object.keys(BACKEND_META), 'gemini', undefined])
  ok(backendFeatureCaps(id).renameWriteback === (id === 'codex'), `renameWriteback(${String(id)}) === (id==='codex') — the trigger's verdict is unchanged for every shipped backend`);
ok(backendFeatureCaps(undefined).renameWriteback === false && backendFeatureCaps('gemini').renameWriteback === false,
  '…and an unknown/absent backend gets the all-false row (chrome never asks for something the harness cannot do)');


// ── PER-SESSION GIT WORKTREE (owner ruling 9) ──
// The caps row is the ONE gate every surface reads, so the client mirror is
// deep-compared here: a drifted mirror would offer a checkbox for a flag the
// spawn refuses (exactly the §2.13 `review` drift this suite exists to stop).
console.log('— worktree caps (owner ruling 9)');
{
  for (const id of Object.keys(BACKEND_META)) {
    const server = capsOf(id).worktree, client = BACKEND_META[id].caps?.worktree;
    ok(!!server && typeof server.supported === 'boolean', `${id}: server backend-caps declares a worktree row`);
    // A META row that declares `caps` at all MUST carry the mirror; a row with
    // no caps object (shell — terminal-only, no feature chrome) reads the
    // all-false NO_WORKTREE default, which is what the server row says too.
    // Both spellings are asserted, so neither side can drift alone.
    if (BACKEND_META[id].caps) ok(JSON.stringify(client) === JSON.stringify(server), `${id}: client META caps.worktree deep-equals the server row (no drift)`, JSON.stringify({ client, server }));
    else ok(client === undefined && server.supported === false, `${id}: no client caps row at all ⇒ the server row must be the all-false one`, JSON.stringify(server));
    ok(JSON.stringify(worktreeCapsFor(id)) === JSON.stringify(worktreeCaps(id)), `${id}: the two readers (client worktreeCapsFor / server worktreeCaps) agree`);
  }
  // The FACTS, dumped from `claude --help` on 2.1.257 and measured on a real
  // repo (see the caps-row comment): only claude has the flag, it is spelled
  // --worktree, and it needs a git repository.
  ok(capsOf('claude').worktree.supported && capsOf('claude').worktree.flag === '--worktree' && capsOf('claude').worktree.requiresGitRepo === true
    && ['codex', 'shell', 'opencode'].every((id) => capsOf(id).worktree.supported === false),
    'claude is the only harness with the flag, spelled exactly --worktree, needing a git repo');
  ok(worktreeCaps('gemini') === NO_WORKTREE, "an unknown backend gets the all-false NO_WORKTREE row (never claude's by accident)");
  // NEVER --tmux (its own help: "Create a tmux session for the worktree
  // (requires --worktree)") — dtach is the persistence layer.
  const capsSrc = fs.readFileSync(path.join(REPO, 'src/backend-caps.js'), 'utf8');
  const adapterSrc = fs.readFileSync(path.join(REPO, 'src/adapters/claude-code.js'), 'utf8');
  ok(!/flag:\s*'--tmux'/.test(capsSrc) && !/args\.push\('--tmux'/.test(adapterSrc) && /--tmux must never be spawned/.test(adapterSrc),
    'no harness declares --tmux and the claude adapter never pushes it');
  // REFUSAL is a tri-state read: only a DEFINITIVE "not a repo" refuses.
  ok(!worktreeRefusal({ backend: 'claude', want: false, isGitRepo: false }), 'worktreeRefusal: not asked ⇒ no refusal, whatever the probe said');
  ok(worktreeRefusal({ backend: 'codex', want: true, isGitRepo: true })?.reason === 'unsupported', 'worktreeRefusal: a harness without the flag refuses with `unsupported`');
  ok(worktreeRefusal({ backend: 'claude', want: true, isGitRepo: false })?.reason === 'not-a-git-repo', 'worktreeRefusal: a definitive non-repo refuses with `not-a-git-repo`');
  ok(worktreeRefusal({ backend: 'claude', want: true, isGitRepo: null }) === null, 'worktreeRefusal: an UNANSWERABLE probe (null) is NOT a refusal — the CLI speaks for itself');
  // THE HOOK ESCAPE — the CLI's gate is `WorktreeCreate hook OR git repo`
  // (2.1.257: `if(!pX() && !await rh())`, pX = fB("WorktreeCreate").length>0).
  // Mirroring only the repo half is a FALSE REFUSAL of exactly the setup the
  // CLI's own error text recommends ("Configure a WorktreeCreate hook in
  // settings.json to use --worktree with other VCS systems").
  ok(capsOf('claude').worktree.hookEscape === 'WorktreeCreate', 'the caps row NAMES the hook event that makes a non-repo legal');
  ok(worktreeRefusal({ backend: 'claude', want: true, isGitRepo: false, hasWorktreeHook: true }) === null,
    'worktreeRefusal: a definite WorktreeCreate hook RESCUES a definite non-repo (the CLI would have accepted it)');
  ok(worktreeRefusal({ backend: 'claude', want: true, isGitRepo: false, hasWorktreeHook: null })?.reason === 'not-a-git-repo',
    'worktreeRefusal: an UNKNOWN hook still refuses a KNOWN non-repo (the alternative is the instantly-dead window)');
  ok(worktreeRefusal({ backend: 'claude', want: true, isGitRepo: false, hasWorktreeHook: false })?.hookEscape === 'WorktreeCreate',
    'worktreeRefusal: the refusal CARRIES the escape hatch so the message can name it (no dead end for a non-git VCS)');
  // NEGATIVE CONTROL: the hook may only ever RESCUE — it can never itself
  // cause, or suppress, an `unsupported` refusal on a harness without the flag.
  ok(worktreeRefusal({ backend: 'codex', want: true, isGitRepo: true, hasWorktreeHook: true })?.reason === 'unsupported'
    && worktreeRefusal({ backend: 'claude', want: true, isGitRepo: true, hasWorktreeHook: false }) === null,
    'NEGATIVE CONTROL: the hook never creates a refusal and never overrides `unsupported`');
  // WIRING PIN (2.355.0's law: a pure fix with no staged call site is a fix
  // that ships dead) — ws-create must actually probe the hook and hand it to
  // the rule, on BOTH transports.
  const wsCreateSrc = fs.readFileSync(path.join(REPO, 'src/ws-create.js'), 'utf8');
  ok(/claudeWorktreeHookConfigured/.test(wsCreateSrc) && /hooks\.WorktreeCreate/.test(wsCreateSrc)
    && /worktreeRefusal\(\{[^}]*hasWorktreeHook\b/.test(wsCreateSrc) && /__VS_WTHOOK_YES__/.test(wsCreateSrc),
    'WIRING: ws-create probes the hook locally AND over the host shell, and passes it to worktreeRefusal');
  ok(/refusal\.hookEscape/.test(wsCreateSrc), 'WIRING: the refusal message names the hook escape hatch from the caps row');
  // WHICH SPAWNS PASS THE FLAG (2.1.257 decompiled): a resume RE-ENTERS the
  // recorded worktree by itself (y6(host, se.worktreeSession)), a fork STRIPS
  // the binding (Une(se,{stripWorktreeSession:true})).
  const wt = (o) => worktreeSpawnArgs({ backend: 'claude', ...o });
  ok(JSON.stringify(wt({ want: true }).args) === '["--worktree"]' && wt({ want: true }).why === 'new', 'worktreeSpawnArgs: a NEW session passes --worktree with NO name (the CLI mints a unique one)');
  ok(wt({ want: true, resume: true }).pass === false && wt({ want: true, resume: true }).why === 'resume-rebinds', 'worktreeSpawnArgs: a plain RESUME passes NOTHING (the CLI re-enters its own recorded worktree; a second flag = a SECOND worktree)');
  ok(JSON.stringify(wt({ want: true, resume: true, fork: true }).args) === '["--worktree"]' && wt({ want: true, resume: true, fork: true }).why === 'fork', 'worktreeSpawnArgs: a FORK passes it again (--fork-session strips the binding)');
  ok(wt({ want: false }).args.length === 0 && worktreeSpawnArgs({ backend: 'codex', want: true }).args.length === 0, 'worktreeSpawnArgs: not asked / unsupported harness ⇒ no args');
  // The client surfaces gate on the CAPS ROW, never on a backend id.
  const appSrc = fs.readFileSync(path.join(REPO, 'src/lib/app.js'), 'utf8');
  const propsSrc = fs.readFileSync(path.join(REPO, 'src/lib/session-props.js'), 'utf8');
  ok(/worktreeCapsFor\(backend\)\.supported/.test(appSrc) && /worktreeCapsFor\(s\.backend \|\| 'claude'\)/.test(propsSrc)
    && !/backend === 'claude'[^\n]*worktree/.test(appSrc) && !/worktree[^\n]*backend === 'claude'/.test(propsSrc),
    'the New Session row + the Session Properties row gate on worktreeCapsFor(backend).supported (no backend-id branch)');
  // BOTH surfaces are a real CHECKBOX writing the same per-session key, so the
  // pick a user makes in the dialog and the one they change later are ONE
  // fact (`cfg.worktree`), which resumeSession/fork read back.
  const lifeSrc = fs.readFileSync(path.join(REPO, 'src/lib/session-lifecycle.js'), 'utf8');
  const sideSrc = fs.readFileSync(path.join(REPO, 'src/lib/sidebar-state.js'), 'utf8');
  ok(/id="input-worktree"/.test(fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8'))
    && /getElementById\('input-worktree'\)\?\.checked/.test(appSrc)
    && /setSessionConfig\?\.\(s, \{ \.\.\.\(sidebar\.getSessionConfig\?\.\(s\) \|\| \{\}\), worktree: cb\.checked \}\)/.test(propsSrc),
    'the tick is a CHECKBOX in both places, writing the one per-session key (dialog → create, properties → cfg.worktree)');
  ok(/if \(config\?\.worktree === true \|\| config\?\.worktree === false\) clean\.worktree = config\.worktree;/.test(sideSrc)
    && !/'outputStyle', 'worktree'\]/.test(sideSrc)
    && /worktree: worktree !== undefined \? worktree : savedCfg\.worktree/.test(lifeSrc),
    "…and the saved pick SURVIVES as a TRI-STATE (sidebar-state persists an explicit false like autoResume — the truthy list would erase an untick; resumeSession reads it back)");
}

const wsCreateSrc = fs.readFileSync(path.join(REPO, 'src/ws-create.js'), 'utf8');

// ── THE PICK vs THE LIVE FACT (round-2 verifier, MAJOR + the untick it exposed)
// Two different things, and every surface that asks "would the NEXT run of this
// conversation be isolated?" must answer with ONE function.
{
  const pick = (saved, live) => worktreePick({ saved, live });
  ok(pick(true, false) === true && pick(true, true) === true, 'worktreePick: an explicit tick wins, whatever this run turned out to be');
  ok(pick(false, true) === false && pick(false, false) === false,
    'worktreePick: an explicit UNTICK is a DECISION — a live isolated run never resurrects it (the accept-and-ignore the truthy-only key used to produce)');
  ok(pick(undefined, true) === true && pick(undefined, false) === false,
    'worktreePick: no pick on record ⇒ this RUN answers (the normal state right after a New Session tick — the conversation has no id yet)');
  // NEGATIVE CONTROL: the rule is not "any falsy saved value defers to live" —
  // that is precisely the shape that made the untick unrepresentable.
  ok(pick(false, true) !== pick(undefined, true),
    'NEGATIVE CONTROL: `false` and `undefined` are DIFFERENT answers under the same live fact (a truthy test collapses them and the untick disappears)');
  ok(worktreeLatchWrite({ saved: undefined, live: true }) === true, 'worktreeLatchWrite: an ABSENT pick records what this run turned out to be');
  ok(worktreeLatchWrite({ saved: undefined, live: false }) === null
    && worktreeLatchWrite({ saved: true, live: false }) === null
    && worktreeLatchWrite({ saved: true, live: true }) === null,
    'worktreeLatchWrite: ONE-WAY — it never writes OFF, and never rewrites a pick that already exists');
  ok(worktreeLatchWrite({ saved: false, live: true }) === null,
    'NEGATIVE CONTROL: an explicit `false` is never overruled by a live isolated run (a fact we were wrong about is not a preference the user changed — and neither is one they revoked)');
  ok(clientWorktreePick === worktreePick && clientWorktreeLatchWrite === worktreeLatchWrite,
    'the CLIENT surfaces import the SAME function objects through agent-meta (no paraphrase — the fork lost the pick entirely by having none)');
}

// ── WIRING: who actually PRODUCES each branch of worktreeSpawnArgs ──────────
{
  const propsSrc2 = fs.readFileSync(path.join(REPO, 'src/lib/session-props.js'), 'utf8');
  const lifeSrc2 = fs.readFileSync(path.join(REPO, 'src/lib/session-lifecycle.js'), 'utf8');
  const viewSrc = fs.readFileSync(path.join(REPO, 'src/lib/chat-view.js'), 'utf8');
  ok(/cb\.checked = worktreePick\(\{ saved: cfg\.worktree, live \}\);/.test(propsSrc2)
    && /worktree: cb\.checked \}\)/.test(propsSrc2) && !/worktree: cb\.checked \|\| undefined/.test(propsSrc2),
    'WIRING: the Session Properties checkbox READS worktreePick and WRITES a boolean (so unticking sticks)');
  // The fork call site — the round-2 MAJOR. `fork ⇒ pass` had no producer at
  // all: `_doForkSession`'s createSession carried no `worktree` key, so the
  // branch was pinned by a call no site could make.
  const forkBlock = lifeSrc2.slice(lifeSrc2.indexOf('async _doForkSession('), lifeSrc2.indexOf('// Open a stopped session as view-only'));
  ok(forkBlock.length > 200 && /worktreePick\(\{ saved: forkCfg\.worktree, live: sessionInfo\.worktree \}\)/.test(forkBlock)
    && /worktree: forkWorktree \|\| undefined,/.test(forkBlock),
    'WIRING: _doForkSession RESOLVES the pick and passes it on the create (a fork is the other spawn that emits --worktree)');
  ok(/const wtWillPass = worktreeSpawnArgs\(\{/.test(wsCreateSrc) && /if \(wtWillPass\) \{/.test(wsCreateSrc)
    && /resume: !!\(data\.resume && data\.resumeId\)/.test(wsCreateSrc) && /fork: !!data\.fork/.test(wsCreateSrc),
    'WIRING: the ws-create repo preflight gates on the EMITTED decision, not on the tick (a resume never sends the flag)');
  // BOTH entry points reach the one latch, and BOTH bodies are prototype
  // methods — scripts/test-worktree-userchan-ui.mjs drives them for real. The
  // ws branch is now a one-line delegation precisely because a body that lives
  // only inside the live-view constructor closure can be pinned by grep and by
  // nothing else (which is how the pre-fix dead write stayed green).
  ok(/msg\.type === 'worktree-path'[\s\S]{0,2000}this\._onWorktreePath\(msg\);/.test(viewSrc)
    && /_onWorktreePath\(msg\) \{[\s\S]{0,240}this\._latchWorktreePick\(\);/.test(viewSrc)
    && /if \('worktree' in meta\) \{[\s\S]{0,80}this\._latchWorktreePick\(\);/.test(viewSrc)
    && /worktreeLatchWrite\(\{ saved: cfg\.worktree, live: this\._worktree \}\) === true/.test(viewSrc),
    'WIRING: BOTH chat-view entry points run the one latch, and both bodies are drivable prototype methods (the worktree-path branch used to write a field nobody read)');
  // The swap bookkeeping (round-2 verifier, MAJOR): three sites, one helper.
  ok((viewSrc.match(/this\._swapMessageEl\(/g) || []).length === 3
    && /_swapMessageEl\(oldEl, newEl, id\) \{/.test(viewSrc)
    && !/if \(next\) el\.replaceWith\(next\);/.test(viewSrc),
    'WIRING: every in-place message re-render goes through _swapMessageEl (the tool-card swap was a bare replaceWith)');
}

// ── THE PREFLIGHT, DRIVEN THROUGH THE REAL ws-create HANDLER ────────────────
// Not a grep: the handler is constructed with stub deps and a `buildSessionArgs`
// that THROWS a sentinel, so execution stops exactly where the spawn would
// start — every refusal above it is real, and nothing is ever spawned.
{
  const SENTINEL = Symbol('spawn');
  const drive = async (mod, data) => {
    const sent = [], built = [];
    const adapter = { installed: true, buildSessionArgs(o) { built.push(o); const e = new Error('probe'); e[SENTINEL] = true; throw e; } };
    const handler = mod.createWsCreateHandler({
      ctx: {
        activeSessions: new Map(), WS_OPEN: 1, adapterRegistry: { get: () => adapter },
        sessionCounterRef: { value: 0 }, hosts: null, accounts: null, os, fs, path,
        serverSetting: () => '', SOCKETS_DIR: scratch('wtprobe-sockets'), BUFFERS_DIR: scratch('wtprobe-buffers'),
        broadcastActiveSessions() { }, broadcastToSession() { },
      },
      agentEnv: () => ({}), crashLoopRef: { map: new Map() }, noConvoRef: { map: new Map() },
      execFileAsync: async () => ({ stdout: '', stderr: '' }), pickCodexThreadCandidate: () => null,
      getSessionKey: (s) => `${s.backend}:${s.backendSessionId}`, normalizeComparablePath: (p) => p,
    });
    try { await handler({ readyState: 1, send: (t) => sent.push(JSON.parse(t)) }, data, new Set()); }
    catch (e) { if (!e[SENTINEL]) throw e; }
    return { codes: sent.map((m) => m.code || m.type), built };
  };
  const NOREPO = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-notarepo-'));
  const RID = '11111111-2222-3333-4444-555555555555';
  const base = { backend: 'claude', mode: 'chat', cwd: NOREPO, worktree: true, reqId: 'r' };
  const wsCreate = require(path.join(REPO, 'src/ws-create.js'));

  const newSess = await drive(wsCreate, { ...base });
  ok(newSess.codes.join() === 'worktree-not-a-git-repo' && newSess.built.length === 0,
    'PREFLIGHT: a NEW session in a non-repo is refused BEFORE the spawn (the instantly-dead window this exists to prevent)', JSON.stringify(newSess.codes));
  const resumed = await drive(wsCreate, { ...base, resume: true, resumeId: RID, ignoreNoConvo: true });
  ok(resumed.codes.length === 0 && resumed.built.length === 1 && resumed.built[0].worktree === true && resumed.built[0].fork === false,
    'PREFLIGHT: a plain RESUME of the same conversation in the same non-repo folder is NOT refused — the spawn would not send the flag at all (round-2 verifier)', JSON.stringify(resumed.codes));
  ok(worktreeSpawnArgs({ backend: 'claude', want: true, resume: true, fork: false }).args.length === 0,
    '…and the adapter proves it: the same options emit no --worktree (the refusal would have been for a flag nobody sends)');
  const forked = await drive(wsCreate, { ...base, resume: true, fork: true, resumeId: RID, ignoreNoConvo: true });
  ok(forked.codes.join() === 'worktree-not-a-git-repo' && forked.built.length === 0,
    'NEGATIVE CONTROL: a FORK in that same non-repo IS still refused — it really does emit --worktree, so the gate is the decision and not a blanket skip', JSON.stringify(forked.codes));
  const codexResume = await drive(wsCreate, { ...base, backend: 'codex', resume: true, resumeId: 'th_x', ignoreNoConvo: true });
  ok(codexResume.codes.join() === 'worktree-unsupported' && codexResume.built.length === 0,
    'NEGATIVE CONTROL: `unsupported` stays UNCONDITIONAL — a harness with no such flag refuses on a resume too (accept-and-ignore is the 2.361.4 failure)', JSON.stringify(codexResume.codes));

  // MUTATION CONTROL: the pre-fix gate, reproduced from the product source. The
  // copy lives beside the original so its relative requires still resolve.
  const mutSrc = wsCreateSrc.replace('if (wtWillPass) {', 'if (data.worktree) {');
  ok(mutSrc !== wsCreateSrc, 'MUTATION CONTROL: the gate is one identifiable line');
  const mutPath = path.join(REPO, 'src', `.ws-create-negctl-${process.pid}.js`);
  try {
    fs.writeFileSync(mutPath, mutSrc);
    const mutResume = await drive(require(mutPath), { ...base, resume: true, resumeId: RID, ignoreNoConvo: true });
    ok(mutResume.codes.join() === 'worktree-not-a-git-repo' && mutResume.built.length === 0,
      '…and with it the RESUME is refused again — the pre-fix behaviour, reproduced from the product source (so the leg above measures the fix)', JSON.stringify(mutResume.codes));
  } finally { try { fs.rmSync(mutPath, { force: true }); } catch { } }
  try { fs.rmSync(NOREPO, { recursive: true, force: true }); } catch { }
}


// ── AUTO-RESUME CONFORMANCE (owner ruling 2026-09-08: "auto resume 应该是通用的,
// 只要支持 hook/注入的 harness 都支持, 形式可以不一样") ──────────────────────
// The feature is VibeSpace's own and harness-neutral; only TWO facts differ per
// harness and both are on the descriptor — quota.signalFromStream (how a LIMIT
// shows up) and resume {form, deliver} (how a TURN is restarted). So every
// registered harness gets the SAME conformance run: the caps row is re-derived
// from the descriptor in both directions, a harness that can be continued
// proves it CAN be (arm → fire, delivered through its OWN verb into a stub of
// its own channel), and a harness that cannot is never armed and never offered.
console.log('— auto-resume conformance (owner ruling 2026-09-08)');
{
  const { deriveAutoResume, AUTO_RESUME_FORMS, NO_AUTO_RESUME } = require(path.join(REPO, 'src/backend-caps.js'));
  const reg = require(path.join(REPO, 'src/harnesses'));
  const { NULL_QUOTA } = require(path.join(REPO, 'src/harnesses/null-quota.js'));
  const arMod = require(path.join(REPO, 'src/server/auto-resume.js'));

  // (a) THE ROW IS DERIVED, NOT DECLARED — recompute it from the descriptor and
  // compare, so a hand-edited caps literal (or a stale placeholder the registry
  // failed to overwrite) is red rather than a silent capability claim.
  for (const id of reg.ids()) {
    const h = reg.get(id);
    const want = deriveAutoResume({
      hasLimitSignal: !!h.quota && h.quota !== NULL_QUOTA && h.quota.signalFromStream !== NULL_QUOTA.signalFromStream,
      resumeForm: h.resume ? h.resume.form : null,
    });
    ok(JSON.stringify(capsOf(id).autoResume) === JSON.stringify(want),
      `${id}: caps.autoResume is DERIVED from the descriptor (${JSON.stringify(want)})`, JSON.stringify(capsOf(id).autoResume));
    ok(want.resume === null || AUTO_RESUME_FORMS.includes(want.resume), `${id}: its resume form is in the closed set`);
    ok(want.supported === (want.signal && want.resume !== null), `${id}: 'supported' is exactly signal AND a verb — never hand-set`);
  }
  ok(JSON.stringify(capsOf('gemini').autoResume) === JSON.stringify(NO_AUTO_RESUME), 'an UNREGISTERED backend answers the honest nothing (no fallthrough to claude)');
  // the four measured rows, named, so a silent flip is visible in the diff
  ok(capsOf('claude').autoResume.resume === 'message' && capsOf('codex').autoResume.resume === 'turn-start'
    && capsOf('opencode').autoResume.resume === 'prompt' && capsOf('shell').autoResume.resume === null,
    'the four harnesses each declare their OWN verb form (message / turn-start / prompt / none)');
  ok(capsOf('opencode').autoResume.supported === false && capsOf('opencode').autoResume.resume === 'prompt',
    'opencode CAN be continued but has no limit signal (ACP v1 exposes no subscription window) ⇒ not offered, honestly');

  // (b) A DECLARED VERB REALLY WORKS: arm → fire, delivered through the
  // harness's OWN deliver() into a stub of its OWN channel. Driven through the
  // real module (its breaker, its gate, its persistence), never a paraphrase.
  const mkAr = (backend, extra = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-arconf-'));
    const sent = [];
    const sessions = new Map();
    const ar = arMod.create({
      dataDir: dir, activeSessions: sessions, serverSetting: () => true, log: () => { },
      // THE STUB CHANNEL: whatever the harness's verb decides to do, it reaches
      // the wire through exactly this one ORCH function (claude's chat stdin,
      // the codex wrapper's rpc lane, the ACP wrapper's prompt) — so a verb
      // that forgot to use it, or used something else, cannot pass.
      sendToSession: (id, s, text) => { sent.push({ id, text, backend: s.backend }); return true; },
      ...extra,
    });
    const s = { mode: 'chat', backend, pty: {}, _isStreaming: false, _autoResume: true };
    sessions.set('s1', s);
    return { ar, s, sent, dir, sessions };
  };
  for (const id of reg.ids()) {
    const verb = reg.resumeVerb(id);
    const w = mkAr(id);
    const rec = w.ar.armIfEnabled('s1', w.s, Date.now() + 60000, 'usage limit', { lane: null, bucket: 'fiveHour' });
    if (!verb) {
      ok(rec === null && w.ar.statusFor('s1').armed === false, `${id}: declares NO resume verb ⇒ never armed (a promise nobody can keep is not made)`);
      ok(w.ar.tick(Date.now() + 3600e3) === 0 && w.sent.length === 0, `${id}: …and nothing is ever fired at it`);
      ok(w.ar.statusFor('s1').resume === null, `${id}: …and the status says so, so no surface offers the toggle`);
    } else {
      ok(!!rec, `${id}: declares the '${verb.form}' verb ⇒ the wait is armed`);
      const fired = w.ar.tick(Date.now() + 60000 + 60000);
      ok(fired === 1 && w.sent.length === 1 && w.sent[0].text === arMod.CONTINUE_PROMPT && w.sent[0].backend === id,
        `${id}: …and the continue is DELIVERED through its own '${verb.form}' verb into that harness's channel`, JSON.stringify(w.sent));
      ok(w.ar.statusFor('s1').armed === false, `${id}: …exactly once (the wait is spent)`);
      ok(w.ar.statusFor('s1').resume === verb.form, `${id}: …and the status names the form the surfaces gate on`);
    }
    try { fs.rmSync(w.dir, { recursive: true, force: true }); } catch { }
  }

  // (c) A VERB THAT REFUSES IS NOT A DELIVERY. The fire path must believe the
  // harness, not its own optimism: a deliver() that returns false leaves the
  // wait armed for the next tick rather than reporting a continue nobody sent.
  {
    const w = mkAr('claude', { sendToSession: () => false });
    w.ar.armIfEnabled('s1', w.s, Date.now() + 1000, 'usage limit', { bucket: 'fiveHour' });
    ok(w.ar.tick(Date.now() + 60000) === 0 && w.ar.statusFor('s1').armed === true, 'a verb that could not deliver leaves the promise standing (never a phantom continue)');
    try { fs.rmSync(w.dir, { recursive: true, force: true }); } catch { }
  }

  // (d) NO SURFACE MAY BRANCH ON A BACKEND ID around auto-resume. The census is
  // derived from the source, not from a list somebody remembered to update, and
  // it is proven on a PLANTED gate before it is trusted to report a clean tree.
  {
    // THE FILE SET IS DERIVED, NOT ENUMERATED (the cli-identity r7 law: a
    // standing sweep is worth exactly the set it walked, and a hand-written
    // list only ever polices the files its author already read — it missed 47
    // real ones there). Every .js/.mjs under src/, server.js and data/bin/ that
    // MENTIONS auto-resume is censused; the set is printed so the scope is
    // visible, and it is pinned to still cover the four sites that carry the
    // decision.
    const MARK = /autoResume|auto-resume|armIfEnabled|noteQuotaReading|windowOpened|resumeVerb|autoResumeCapsFor/;
    const ID_GATE = /backend\s*[!=]==\s*'(?:codex|claude|opencode|shell)'/;
    const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (!/node_modules|\.git/.test(f)) walk(f, out); } else if (/\.(js|mjs)$/.test(e.name)) out.push(f); } return out; };
    // BUILD OUTPUTS ARE NOT SOURCES: data/bin/vibespace-agentd*.js is esbuild's
    // bundle of the very src/ files censused below (gitignored since 2.369.75),
    // so censusing it would police the same code twice and make the verdict
    // depend on whether this tree has been built.
    const GENERATED = /^data\/bin\/vibespace-agentd(-attach)?\.js$/;
    const allFiles = [...walk(path.join(REPO, 'src')), path.join(REPO, 'server.js'), ...walk(path.join(REPO, 'data/bin'))];
    const SITES = allFiles.map((f) => path.relative(REPO, f)).filter((f) => !GENERATED.test(f) && MARK.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
    // A gate that is NEAR an auto-resume mention but is not ABOUT it needs a
    // reason, and a reason that stops matching is itself a failure (the dead
    // allowlist rule from test-architecture).
    const ALLOW = [{ file: 'src/lib/session-lifecycle.js', gate: "backend === 'claude'", why: 'tuiRenderer (a TERMINAL-mode setting) sits in the same createSession payload literal as the autoResume field — proximity, not a gate on this feature' }];
    const offenders = [], allowHit = new Set();
    for (const f of SITES) {
      const txt = fs.readFileSync(path.join(REPO, f), 'utf8');
      for (const m of txt.matchAll(new RegExp(MARK.source, 'g'))) {
        const win = txt.slice(Math.max(0, m.index - 600), m.index + 600);
        const g = ID_GATE.exec(win);
        if (!g) continue;
        const a = ALLOW.find((x) => x.file === f && x.gate === g[0]);
        if (a) { allowHit.add(a.why); continue; }
        offenders.push(`${f} :: ${g[0]}`);
      }
    }
    console.log(`  · census scope: ${SITES.length} files mention auto-resume (${SITES.slice(0, 6).join(', ')}${SITES.length > 6 ? ', …' : ''})`);
    ok(offenders.length === 0, 'CENSUS: no auto-resume site gates on a backend id (every one reads the caps row / the descriptor)', [...new Set(offenders)].join(' ; '));
    for (const f of ['src/server/auto-resume.js', 'src/server/usage-pool-engine.js', 'src/lib/chat-status-bar.js', 'src/auto-resume-signal.js'])
      ok(SITES.includes(f), `CENSUS scope covers ${f} (a sweep that can miss the deciding file is not a sweep)`);
    ok(SITES.length >= 10, `CENSUS scope is non-vacuous (${SITES.length} files)`);
    for (const a of ALLOW) ok(allowHit.has(a.why), `CENSUS allowlist entry still matches something (dead reason = red): ${a.file} — ${a.why}`);
    ok(ID_GATE.test("if (session.backend === 'codex') return null;"), '…and the census can go red (proven on a planted gate, never a check that only ever passes)');
    // WIRING PINS (2.355.0 law: a fix nobody calls is not a fix). Each names the
    // ONE reader, so a surface that grows a private copy of the question — or
    // reads the row back as a boolean, which it was until this release — is red.
    const sb = fs.readFileSync(path.join(REPO, 'src/lib/chat-status-bar.js'), 'utf8');
    ok(/autoResumeCapsFor\(this\._backend\)\.supported/.test(sb), 'WIRING: the status-bar chip is drawn from the DERIVED caps row, through the shared reader');
    const arSrc = fs.readFileSync(path.join(REPO, 'src/server/auto-resume.js'), 'utf8');
    ok(/if \(!verbFor\(session\)\) \{ log\(/.test(arSrc), 'WIRING: armIfEnabled refuses a harness with no resume verb (never a promise nobody can keep)');
    ok(/const verb = verbFor\(session\);[\s\S]{0,400}verb\.deliver\(session, CONTINUE_PROMPT, \{ sendChatInput/.test(arSrc), 'WIRING: the ONE fire choke point runs the DESCRIPTOR\'s verb, handing it the ORCH channel');
    ok((arSrc.match(/verb\.deliver\(/g) || []).length === 1, 'WIRING: …and there is exactly ONE of them (a second fire path is how the loop breaker — and the spend authorizer — get bypassed)');
    const engSrc2 = fs.readFileSync(path.join(REPO, 'src/server/usage-pool-engine.js'), 'utf8');
    ok((engSrc2.match(/noteQuotaReadingForResume\(/g) || []).length === 3, 'WIRING: ONE shared reading edge with exactly its two producers (claude + codex), never a per-harness answer', String((engSrc2.match(/noteQuotaReadingForResume\(/g) || []).length));
  }
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
