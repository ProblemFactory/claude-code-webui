#!/usr/bin/env node
// Codex pooled account, cold-switch v1 (P2, design-backend-parity.md §2):
// same three layers as claude's pool — pure decision (reused verbatim),
// symlink material (repointPoolSymlink among CODEX_HOME dirs), cold-restart
// client machinery (already backend-agnostic). Hot switching stays OFF until
// the P3 symlink-swap verification proves the codex app-server re-reads
// auth.json mid-run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const { AccountManager } = require(path.join(REPO, 'src/accounts.js'));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cxpool-'));
process.env.CODEX_HOME = path.join(dataDir, 'shared-codex'); // keep _seedCodexDir off the real ~/.codex
const am = new AccountManager({ dataDir });
const mkSub = (name) => {
  const { id } = am.createCodexSubscription({ name });
  fs.writeFileSync(path.join(am.codexSubDir(id), 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok-' + name } }));
  return id;
};
const a1 = mkSub('CxA'), a2 = mkSub('CxB');

// ── pool store ──
const pool = am.createPool({ name: 'CxPool', backend: 'codex' });
ok('codex pool creates and targets the first logged-in ChatGPT member', pool.current === a1 || pool.current === a2);
const pid = am.list().accounts.find((a) => a.type === 'pooled' && a.backend === 'codex')?.id;
ok('the pool record carries backend codex', !!pid);
ok('the pool symlink lives among the CODEX_HOME dirs (data/codex-subs)', fs.readlinkSync(path.join(dataDir, 'codex-subs', pid)).includes('codex-subs'));
ok('poolMembers lists only logged-in ChatGPT subs', am.poolMembers(pid).length === 2 && am.poolMembers(pid).every((m) => [a1, a2].includes(m.id)));
const other = pool.current === a1 ? a2 : a1;
am.setPoolTarget(pid, other);
ok('setPoolTarget repoints atomically and poolCurrent reads the link', am.poolCurrent(pid) === other);
let threw = null; try { am.setPoolTarget(pid, 'sub-nope'); } catch (e) { threw = e.message; }
ok('a non-codex/unknown target refuses loudly', /not a codex subscription|unknown/i.test(threw || ''), threw);

// ── spawn resolution ──
const r = am.resolveForSpawn(pid, 'codex');
ok('a codex session on the pool spawns with CODEX_HOME = the pool symlink', r.kind === 'codex-pooled' && r.localEnv.CODEX_HOME === path.join(dataDir, 'codex-subs', pid));
// self-heal: dead target re-points instead of throwing (the 2.330.2 claude lesson)
fs.rmSync(path.join(am.codexSubDir(other), 'auth.json'));
const r2 = am.resolveForSpawn(pid, 'codex');
ok('a signed-out target self-heals to a live member at spawn', r2 && am.poolCurrent(pid) !== other, JSON.stringify({ cur: am.poolCurrent(pid) }));

// ── engine + wiring pins ──
{
  // ── capability registry (P4 slice, 2.368.21): the engine consults
  // backend-caps.js instead of backend-id special cases; hotSwitch encodes
  // the per-backend VERDICT (claude 'verified' by test-creds-symlink-swap;
  // codex 'impossible' by the 2026-08-24 P3 experiment — CODEX_HOME is
  // canonicalized at startup AND a turn completed on garbage auth content,
  // i.e. tokens live in process memory).
  const { capsOf, BACKEND_CAPS } = require(path.join(REPO, 'src/backend-caps.js'));
  ok("capsOf('claude').hotSwitch === 'verified'", capsOf('claude').hotSwitch === 'verified');
  ok("capsOf('codex').hotSwitch === 'impossible' (P3 experimental verdict, twice over)", capsOf('codex').hotSwitch === 'impossible' && /canonicalizes CODEX_HOME/.test(read('src/backend-caps.js')));
  ok('an unknown backend gets NO capabilities (pool refused, cold, no credits)', capsOf('gemini').pool === false && capsOf('gemini').hotSwitch === 'unverified');
  ok('codex declares resetCredit; claude does not', BACKEND_CAPS.codex.resetCredit === true && BACKEND_CAPS.claude.resetCredit === false);
  const eng = read('src/server/usage-pool-engine.js');
  ok("the eval's hot gate is capability-based (hot only where 'verified')", /const hot = !!a\.hot && poolCaps\.hotSwitch === 'verified';/.test(eng));
  ok('sealed orders + plan-C gate on capabilities, not backend ids', /if \(poolCaps\.sealedOrders\) pushSealedOrders/.test(eng) && /if \(!poolCaps\.planC\) break;/.test(eng));
  // ── reset-credit escape ladder (owner ask: reset vs switch choice) ──
  ok('exhaustion ladder: ① reset credit (opt-in) → ② pool switch → ③ auto-resume', /if \(tryResetCredit\(tripped\?\.resetsAt\)\) return;[\s\S]{0,200}maybePoolAutoSwitch\(session\)/.test(eng) && /if \(tryResetCredit\(resets\)\) return;[\s\S]{0,120}maybePoolAutoSwitch\(session\)/.test(eng));
  ok("…auto-consume is OPT-IN (codex.limitResetCredit 'auto', default off) with a 10min retry floor", /serverSetting\('codex\.limitResetCredit'\) !== 'auto'\) return false;/.test(eng) && /_codexResetTriedAt && now - session\._codexResetTriedAt < 10 \* 60e3\) return false;/.test(eng));
  ok('a successful reset recovers in place; a failed one falls through the ladder', /out === 'reset'[\s\S]{0,400}noteRecovered[\s\S]{0,800}codex-reset-credit-failed[\s\S]{0,200}maybePoolAutoSwitch\(session\)/.test(eng));
  ok('the setting exists in the Codex group', /'codex\.limitResetCredit'/.test(read('src/lib/settings-schema.js')));
  ok('session-schema registers the throttle fields', /_codexResetTriedAt/.test(read('src/session-schema.js')) && /_codexLastResetsAt/.test(read('src/session-schema.js')));
  const wsrc = read('src/ws-handler.js');
  ok('manual actions exist as ws cases (codex-reset-credit / codex-read-limits), codex-chat-gated', /case 'codex-reset-credit':\s*\n\s*case 'codex-read-limits':/.test(wsrc) && /session\.backend === 'codex'/.test(wsrc));
  const w2 = read('data/bin/codex-chat-wrapper.js');
  ok('the wrapper serves both verbs via the LIVE app-server RPC (rateLimits/read + rateLimitResetCredit/consume)', /account\/rateLimits\/read/.test(w2) && /account\/rateLimitResetCredit\/consume/.test(w2) && /reset_credit_result/.test(w2));
  // ── reset-credit COUNT in the usage popup (owner: usage里展示剩余reset) ──
  ok('the wrapper reads limits ONCE at startup (credits only ride rateLimits/read, never the passive push)', /readAccountLimits\(false\); \/\/ surface reset-credit count/.test(w2));
  ok('the codex harness keeps resetCredits on the account snapshot (S4: the engine writes sig.snapshot)', /snapshot\.resetCredits = \{ availableCount:/.test(read('src/harnesses/codex-quota.js')) && /const snap0 = sig\?\.snapshot \|\| null;/.test(eng));
  ok('…and the sidecar reader merges meta.rateLimitResetCredits', /snap\.resetCredits = \{ availableCount:/.test(read('src/usage-routes.js')));
  const um2 = read('src/lib/usage-meter.js');
  ok('the popup shows the stored reset-credit count', /Reset credits'\)\)\}<\/span> \$\{Number\(codex\.resetCredits\.availableCount\)/.test(um2));
  ok("…and the codex ⟳ is CAPABILITY-gated (quotaRefresh 'session-rpc'), riding a live session's app-server", /backendFeatureCaps\('codex'\)\.quotaRefresh === 'session-rpc'/.test(um2) && /_refreshCodexQuota\(btn\)/.test(um2) && /codex-read-limits', sessionId: live\.webuiId/.test(um2));
  ok('recordCodexQuotaSignal exists: readings write the member cache, exhaustion switches then feeds the WALL MACHINE (2.369.0)', /function recordCodexQuotaSignal[\s\S]{0,3000}maybePoolAutoSwitch\(session\);[\s\S]{0,500}noteWallSignal/.test(eng));
  ok('…typed exhaustion enum covers the workspace variants (owned by the codex harness since S4)', /usage_limit_reached\|quota_exceeded\|usage_not_included\|workspace_owner_usage_limit_reached\|workspace_member_usage_limit_reached\|workspace_member_credits_depleted/.test(read('src/harnesses/codex-quota.js')) && !/CODEX_EXHAUSTION_RE/.test(eng));
  ok('…a pool-billed reading lands on the CURRENT MEMBER, never the pool wrapper', /a\.type === 'pooled'\) key = accounts\.poolCurrentFor\(key, session\._webuiId\)/.test(eng));
  const ss = read('src/server/stdout/codex-events.js'); // S5: the codex-events consumer module
  ok('the codex stdout pipeline feeds the engine (rate_limits_updated + task_failed + reset_credit_result)', /rate_limits_updated' \|\| msg\.payload\?\.type === 'task_failed' \|\| msg\.payload\?\.type === 'reset_credit_result'\)/.test(ss) && /recordCodexQuotaSignal\?\.\(session, msg\.payload\)/.test(ss));
  const w = read('data/bin/codex-chat-wrapper.js');
  ok('the wrapper RELAYS rateLimits to stdout (sidecar was display-only)', /emitTaskEvent\('rate_limits_updated', \{ rateLimits: params\.rateLimits \}\)/.test(w));
  ok('…and forwards the typed codex_error_info on task_failed (it was dropped)', /codexErrorInfo: params\?\.codexErrorInfo \?\? params\?\.codex_error_info/.test(w));
  ok('the pool-create route accepts backend codex', /backend: req\.body\?\.backend === 'codex' \? 'codex' : 'claude'/.test(read('src/server/account-usage-routes.js')));
}

// ── list() pool shape for EVERY backend + ONE shared pool UI (2.369.18, P1) ──
{
  // The codex branch of list() used to run BEFORE the pooled branch, so a
  // codex pool listed as a bare ChatGPT login — no pooled/current/currentName/
  // memberOptions/auto/hot — and no client surface could operate it (nor
  // could the engine's `type==='pooled' && a.auto` tick enumeration see it).
  // Identity must read THROUGH the symlink with the member's own reader:
  // give the current member an id_token carrying email + plan (the real
  // auth.json shape: tokens.id_token JWT with the openai auth claim).
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const cur = am.poolCurrent(pid);
  const idTok = `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ email: 'cxa@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } })}.sig`;
  fs.writeFileSync(path.join(am.codexSubDir(cur), 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'tok-cur', id_token: idTok } }));
  const row = am.list().accounts.find((a) => a.id === pid);
  ok('a codex pool row is POOLED (pooled:true, type pooled, backend codex)', row?.pooled === true && row.type === 'pooled' && row.backend === 'codex', JSON.stringify(row));
  ok('…carries current + currentName (the member the symlink points at)', row?.current === cur && row.currentName === am.get(cur)?.name, JSON.stringify({ current: row?.current, cur }));
  ok('…carries memberOptions = poolMembers (logged-in ChatGPT members only)', JSON.stringify((row?.memberOptions || []).map((m) => m.id)) === JSON.stringify(am.poolMembers(pid).map((m) => m.id)) && row?.memberOptions?.length === 1);
  ok('…carries auto/hot flags (false by default) and members:null (= all)', row?.auto === false && row?.hot === false && row?.members === null);
  ok("…hotSupported is the registry verdict: codex 'impossible' ⇒ false (the UI hides the toggle)", row?.hotSupported === false);
  ok('…supported is true for codex (the darwin exclusion is claude-keychain-specific)', row?.supported === true);
  ok('…identity reads THROUGH the symlink with the codex reader (loggedIn + email + plan of the current member)', row?.loggedIn === true && row?.email === 'cxa@example.com' && row?.subscriptionType === 'plus', JSON.stringify({ loggedIn: row?.loggedIn, email: row?.email, plan: row?.subscriptionType }));
  // negative control: a plain codex login row keeps its own shape
  const plain = am.list().accounts.find((a) => a.id === cur);
  ok('negative control: a plain ChatGPT login row is NOT pooled and keeps authMode', plain && !plain.pooled && plain.type === 'subscription' && plain.authMode === 'chatgpt' && plain.email === 'cxa@example.com');
  // the engine's tick enumerates auto pools from list() — a codex pool must be visible there
  am.updatePool(pid, { auto: true });
  ok("the engine's auto-pool enumeration (list().filter(type==='pooled' && auto)) SEES a codex pool", (am.list().accounts || []).filter((a) => a.type === 'pooled' && a.auto).some((a) => a.id === pid));
  // claude pool for the hotSupported contrast (linux only — createPool refuses on darwin by design)
  if (am.poolSupported()) {
    const { id: cs } = am.createSubscription({ name: 'ClA' });
    fs.writeFileSync(am.subCredsPath(cs), JSON.stringify({ claudeAiOauth: { accessToken: 'at', subscriptionType: 'max' } }));
    const cp = am.createPool({ name: 'ClPool' });
    const crow = am.list().accounts.find((a) => a.id === cp.id);
    ok("a claude pool row says hotSupported:true ('verified') with the same pool shape", crow?.pooled === true && crow.backend === 'claude' && crow.hotSupported === true && crow.current === cs && crow.loggedIn === true && crow.subscriptionType === 'max', JSON.stringify(crow));
  } else console.log('  · SKIP claude pool contrast (pools unsupported on ' + process.platform + ')');

  // ── static pins: the ordering fix + ONE pool menu for both rosters ──
  const acc = read('src/accounts.js');
  const listBody = acc.slice(acc.indexOf('  list() {'), acc.indexOf('// ── Subscription accounts'));
  ok('accounts.list() evaluates the pooled branch BEFORE the (now harness-neutral, S2) subscription branch', listBody.indexOf("if (type === 'pooled')") > 0 && listBody.indexOf("if (type === 'pooled')") < listBody.indexOf("if (type === 'subscription')") && !/if \(backend === 'codex'\) \{/.test(listBody));
  ok('…the pool row reads identity via the backend\'s own auth reader and carries the registry\'s hotSwitch verdict', /this\._readAuthFor\(backend, a\.id\)/.test(listBody) && /hotSupported: capsOf\(backend\)\.hotSwitch === 'verified'/.test(listBody));
  const ma = read('src/lib/manage-agents.js');
  const count = (s, re) => (s.match(re) || []).length;
  ok('manage-agents defines ONE pool menu block (_poolMenuItems)', count(ma, /_poolMenuItems\(id, a, refresh\) \{/g) === 1);
  ok('…spliced into BOTH rosters (claude + codex) — no per-backend copy', count(ma, /items\.splice\(0, 1, \.\.\.this\._poolMenuItems\(id, a, refresh\)\)/g) === 2);
  ok('…the Switch target / Hot switch labels live ONLY in the shared block', count(ma, /t\('Switch target'\)/g) === 1 && count(ma, /t\('Hot switch \(no restart\)'\)/g) === 1 && count(ma, /t\('Auto-switch when nearly exhausted'\)/g) === 1);
  ok("…the hot toggle is gated on the server's hotSupported verdict (codex gets a disabled explanatory row, SVG-free text)", /const hotOk = a\.hotSupported !== false;/.test(ma) && /if \(hotOk\) items\.push\(\{ label: \(a\.hot \? '✓ ' : ''\) \+ t\('Hot switch \(no restart\)'\)/.test(ma) && /Hot switch unavailable — every switch restarts the session/.test(ma));
  ok('…a codex pool cold-restarts even when hot is set (effHot = hotOk && a.hot)', /const effHot = hotOk && !!a\.hot;/.test(ma) && /this\._poolSwitchTarget\(id, m\.id, a\.name, effHot\)/.test(ma));
  ok('…the members dialog filters members by the POOL\'s backend and uses the same effective-hot rule', /\(x\.backend \|\| 'claude'\) === be && !x\.pooled/.test(ma) && /const effHot = a\?\.hotSupported !== false && !!a\?\.hot;/.test(ma) && /if \(!effHot\) for \(const sess of \(r\.affected \|\| \[\]\)\) this\._poolColdRestart/.test(ma));
  ok('…ONE create-pool dialog for both rosters (api(), so a refused create is a visible error)', count(ma, /_createPoolDialog\(/g) === 3 && /await api\('\/api\/accounts\/pool', \{ method: 'POST'/.test(ma) && !/fetchJson\('\/api\/accounts\/pool'/.test(ma));
  ok('…BOTH rosters sort with the shared rosterSort (pool → login → key)', count(ma, /\.sort\(rosterSort\)/g) === 2 && /export const rosterSort/.test(ma));
  ok('…the codex roster draws the POOL glyph (shared ROSTER_ICONS, SVG) and shows → target + the target\'s usage', /const \{ CROWN, GLOBE, POOL, STAR_F, STAR_O, DOTS \} = ROSTER_ICONS;/.test(ma) && count(ma, /isPool \? POOL : /g) === 2 && /no target — pick a ChatGPT account in ⋯/.test(ma) && /this\._codexAccountUsage\[a\.current\], this\._usageEstimates\?\.\[a\.current\]/.test(ma));
  ok('…codex pool rows never get the set-email item (identity is the member\'s)', /if \(!a\?\.pooled && a\?\.loggedIn && \(!a\.email \|\| a\.emailDeclared\)\) items\.push/.test(ma));
  // the three wrong-icon/label surfaces
  const sv = read('server.js');
  ok('server.js sessionAuth: a codex pool reports source pooled + poolTarget (the status-bar chip / title badge / session props render it as a pool)', count(sv, /if \(a && a\.type === 'pooled'\) return poolAuth\(a\);/g) === 2 && /const poolAuth = \(a\) =>/.test(sv));
  ok('chat-status-bar + window.js consume source pooled with the pool glyph + target (unchanged consumers)', /isPooled \? '⣿ ' \+ \(a\.name \|\| t\('Pool'\)\) \+ \(a\.poolTarget/.test(read('src/lib/chat-status-bar.js')) && /const isPooled = auth\.source === 'pooled';/.test(read('src/lib/window.js')));
  ok('usage-meter: codex account chips exclude pools (a pool is not a quota holder — same rule as claudeSubs)', /a\.backend === 'codex' && a\.type === 'subscription'\)/.test(read('src/lib/usage-meter.js')));
  ok('session-card ⚙ account list: a pool row names its target (was "— API …undefined")', /\(a\.pooled \|\| a\.type === 'pooled'\) \? a\.name \+ \(a\.currentName \? ` → \$\{a\.currentName\}` : ' · ' \+ tr\('pool'\)\)/.test(read('src/lib/session-card.js')));
  ok('session-props billing row: pooled / codex-subscription / codex-cli are labeled, never "Unknown"', /a\.source === 'pooled' \? t\('Pooled account — \{name\}'/.test(read('src/lib/session-props.js')) && /a\.source === 'codex-subscription' \? t\('ChatGPT account — \{name\}'/.test(read('src/lib/session-props.js')) && /a\.source === 'codex-cli' \? t\('ChatGPT login \(the machine’s own\)'\)/.test(read('src/lib/session-props.js')));
  // i18n: every new human-visible string has zh + ja entries
  const zh = read('src/lib/i18n-zh.js'), ja = read('src/lib/i18n-ja.js');
  const keys = ['no logged-in ChatGPT accounts', 'Hot switch unavailable — every switch restarts the session', 'All ChatGPT accounts', 'Pool set to all ChatGPT accounts (incl. future ones)',
    'no target — pick a ChatGPT account in ⋯', 'Pooled account — one billing identity auto-switching across your ChatGPT accounts', 'Pooled account — {name}', 'ChatGPT account — {name}', 'ChatGPT login (the machine’s own)',
    'The pool switches between these ChatGPT accounts. Not-signed-in accounts are skipped until they log in.'];
  const missing = keys.filter((k) => !zh.includes(`"${k}":`) || !ja.includes(`"${k}":`));
  ok('zh + ja dictionaries carry every new pool-UI key', missing.length === 0, missing.join(' | '));
}

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
