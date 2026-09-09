#!/usr/bin/env node
// HARNESS S4 — QuotaSignalSource per harness + the caps-routed quota probe
// (docs/design-harness-plugins.md §2.4 S4, §1 P2). Every harness descriptor
// carries `quota = {normalize, signalFromStream, probe, classifyAuthFailure}`
// and the pool engine reaches quota knowledge ONLY through the registry:
//   1. registry contract (built-ins, loud unknown, contributed harness)
//   2. codex normalize on the real 0.149.x / two-window / camelCase shapes
//      + the usage-routes export IS the harness function (single source)
//   3. claude normalize over its three reading shapes (CLI panel text /
//      get_usage control payload / OAuth REST JSON)
//   4. signalFromStream on real record shapes (claude rate_limit_event +
//      limit banner; codex rate_limits_updated / task_failed / reset credit)
//   5. classifyAuthFailure per vendor wording
//   6. the dispatcher, FUNCTIONALLY through a real engine.create(): a codex
//      identity rides the live session's app-server (wrapper verb
//      codex-read-limits → rate_limits_updated settles the waiter AFTER the
//      cache write) and NEVER spawns claude; a claude identity keeps the
//      cli-usage rung; shell/unknown run nothing; timeout + failed read are
//      honest
//   7. beforeAutoResumeFire routes through the same dispatcher + wiring pins
//   8. the vendor whitelist stays green (no new vendor call anywhere)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + (typeof e === 'string' ? e : JSON.stringify(e)) : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const near = (a, b) => Math.abs(a - b) < 1e-9;

const harnesses = require(path.join(REPO, 'src/harnesses'));
const { capsOf } = require(path.join(REPO, 'src/backend-caps.js'));
const { classifyAuthFailure: claudeClassify } = require(path.join(REPO, 'src/account-pool-auto.js'));
const { ClaudeCodeAdapter } = require(path.join(REPO, 'src/adapters/claude-code.js'));
const usageRoutes = require(path.join(REPO, 'src/usage-routes.js'));

// ── 1. registry contract ──
{
  ok('built-in harnesses registered: claude, codex, shell, opencode', ['claude', 'codex', 'shell', 'opencode'].every((id) => harnesses.has(id)) && harnesses.ids().length === 4, harnesses.ids());
  let e1 = null; try { harnesses.get('gemini'); } catch (e) { e1 = e.message; }
  ok('an UNKNOWN harness id fails LOUDLY (never a silent claude fall-through)', /unknown harness 'gemini'/.test(e1 || ''), e1);
  let e2 = null; try { harnesses.get(''); } catch (e) { e2 = e.message; }
  ok('an EMPTY id fails loudly too', /harness id required/.test(e2 || ''), e2);
  for (const h of harnesses.list()) {
    const q = h.quota;
    ok(`${h.id}: quota contract = normalize/signalFromStream/classifyAuthFailure functions + a probe rung`,
      typeof q.normalize === 'function' && typeof q.signalFromStream === 'function' && typeof q.classifyAuthFailure === 'function' && harnesses.QUOTA_PROBE_RUNGS.includes(q.probe));
    ok(`${h.id}: quota.probe mirrors capsOf().quotaProbe (${String(q.probe)})`, q.probe === capsOf(h.id).quotaProbe);
  }
  // a CONTRIBUTED harness (plugin tier-5 / tests): register → dispatch → unregister
  const fake = { id: 'fake-acp', label: 'Fake ACP', quota: { normalize: (raw) => (raw ? { fiveHour: { utilization: 0.5 } } : null), signalFromStream: (r) => (r?.type === 'acp_limit' ? { source: 'acp_limit', kind: 'exhausted', resetsAtMs: 0 } : null), probe: null, classifyAuthFailure: () => false } };
  harnesses.register(fake);
  ok('a contributed harness registers and dispatches through the same get()', harnesses.get('fake-acp').quota.normalize({}).fiveHour.utilization === 0.5 && harnesses.get('fake-acp').quota.signalFromStream({ type: 'acp_limit' }).kind === 'exhausted');
  let e3 = null; try { harnesses.register(fake); } catch (e) { e3 = e.message; }
  ok('a duplicate contributed id refuses without {replace:true} (silent shadowing = a twin)', /already registered/.test(e3 || ''), e3);
  ok('…and replaces with the flag', harnesses.register({ ...fake, label: 'v2' }, { replace: true }).label === 'v2');
  let e4 = null; try { harnesses.register({ id: 'claude', quota: fake.quota }); } catch (e) { e4 = e.message; }
  ok('a built-in id can never be replaced', /built-in/.test(e4 || ''), e4);
  let e5 = null; try { harnesses.register({ id: 'bad-probe', quota: { ...fake.quota, probe: 'telepathy' } }); } catch (e) { e5 = e.message; }
  ok('an unknown probe rung is rejected at registration', /quota\.probe must be one of/.test(e5 || ''), e5);
  let e6 = null; try { harnesses.register({ id: 'no-quota' }); } catch (e) { e6 = e.message; }
  ok('a descriptor without the quota contract is rejected (NULL_QUOTA exists for that)', /quota contract missing/.test(e6 || ''), e6);
  ok('unregister removes a contributed harness', harnesses.unregister('fake-acp') === true && !harnesses.has('fake-acp'));
  let e7 = null; try { harnesses.unregister('codex'); } catch (e) { e7 = e.message; }
  ok('…but never a built-in', /built-in/.test(e7 || ''), e7);
  ok('NULL_QUOTA is frozen and honest (null/null/false)', Object.isFrozen(harnesses.NULL_QUOTA) && harnesses.NULL_QUOTA.normalize({}) === null && harnesses.NULL_QUOTA.signalFromStream({ type: 'rate_limit_event' }) === null && harnesses.NULL_QUOTA.probe === null && harnesses.NULL_QUOTA.classifyAuthFailure({ status: 403 }) === false);
}

// ── 2. codex normalize (real shapes; the usage-routes export IS the harness fn) ──
{
  const cx = harnesses.get('codex').quota;
  ok('SINGLE SOURCE: usage-routes.normalizeCodexRateLimit === codex harness quota.normalize', usageRoutes.normalizeCodexRateLimit === cx.normalize);
  // 0.149.x single-window shape (real rollout token_count.rate_limits)
  const n = cx.normalize({ limit_id: 'codex', limit_name: null, primary: { used_percent: 37, window_minutes: 10080, resets_at: 1788175818 }, secondary: null, credits: { has_credits: false, unlimited: false, balance: '0' }, plan_type: 'pro', rate_limit_reached_type: null }, 1000);
  ok('single-window: a 10080min primary lands in sevenDay, no fiveHour', !n.fiveHour && n.sevenDay?.usedPercent === 37 && n.sevenDay.windowMinutes === 10080 && n.fetchedAt === 1000, n);
  const o = cx.normalize({ primary: { used_percent: 25, window_minutes: 300, resets_at: 111 }, secondary: { used_percent: 51, window_minutes: 10080, resets_at: 222 } }, 1000);
  ok('two-window: 300→fiveHour / 10080→sevenDay', o.fiveHour?.usedPercent === 25 && o.sevenDay?.usedPercent === 51);
  const l = cx.normalize({ limitId: 'codex', primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1788175818 }, secondary: null, planType: 'pro' }, 1000);
  ok('live app-server camelCase (windowDurationMins) read', !l.fiveHour && l.sevenDay?.windowMinutes === 10080 && l.planType === 'pro');
  const r = cx.normalize({ primary: { used_percent: 99, window_minutes: 10080, resets_at: 333 }, secondary: null, rate_limit_reached_type: 'primary', spend_control_reached: true, credits: { has_credits: true, unlimited: false, balance: '12' } }, 1000);
  ok('rate_limit_reached_type kept + the tripped window reads dead', r.rateLimitReachedType === 'primary' && r.sevenDay.utilization === 1 && r.sevenDay.status === 'limited' && r.spendControlReached === true && r.credits?.balance === '12');
  ok('garbage → null (never a fabricated bucket)', cx.normalize(null) === null && cx.normalize({}) === null && cx.normalize('x') === null);
  ok('trippedWindow: primary→burst window when present, else weekly; secondary→weekly', cx.trippedWindow(r) === r.sevenDay && cx.trippedWindow({ rateLimitReachedType: 'secondary', fiveHour: { a: 1 }, sevenDay: { b: 1 } }).b === 1 && cx.trippedWindow({ rateLimitReachedType: 'primary', fiveHour: { a: 1 }, sevenDay: { b: 1 } }).a === 1 && cx.trippedWindow(o) === null);
}

// ── 3. claude normalize over its three reading shapes ──
{
  const cl = harnesses.get('claude').quota;
  ok('SINGLE SOURCE: usage-routes.parseCliUsageText === claude harness parseCliUsageText', usageRoutes.parseCliUsageText === cl.parseCliUsageText);
  // (a) `claude -p /usage` panel text — the captured real output (test-cli-usage-parse fixture)
  const PANEL = `You are currently using your subscription to power your Claude Code usage

Current session: 30% used · resets Aug 12, 12:20am (America/Los_Angeles)
Current week (all models): 5% used · resets Aug 13, 2am (America/Los_Angeles)
Current week (Fable): 9% used · resets Aug 13, 2am (America/Los_Angeles)

What's contributing to your limits usage?`;
  const NOW = Date.UTC(2026, 7, 12, 1, 0, 0);
  const p = cl.normalize(PANEL, NOW);
  ok('CLI panel text → 5h .30 / 7d .05 / scoped Fable .09 (+ parsed resets)', p && near(p.fiveHour.utilization, 0.30) && near(p.sevenDay.utilization, 0.05) && p.scopedWeekly[0]?.name === 'Fable' && near(p.scopedWeekly[0].utilization, 0.09) && p.fiveHour.resetsAt > NOW / 1000 && p.fetchedAt === NOW, p);
  ok('API-key-mode panel text → null', cl.normalize('API key detected — usage tracking is unavailable') === null);
  // (b) get_usage control payload — the LIVE envelope captured 2026-08-09 (test-get-usage-parse fixture)
  const live = { session: { total_cost_usd: 0 }, subscription_type: 'max', rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 34, resets_at: '2026-08-09T09:59:59.753015+00:00', limit_dollars: null },
    seven_day: { utilization: 39, resets_at: '2026-08-11T16:59:59.753043+00:00' },
    seven_day_oauth_apps: null, seven_day_opus: null,
    seven_day_sonnet: { utilization: 12, resets_at: '2026-08-11T16:59:59.753043+00:00' },
    nimbus_quill: { utilization: 0, resets_at: null }, extra_usage: { is_enabled: false } } };
  const g = cl.normalize(live);
  const gRef = ClaudeCodeAdapter.parseGetUsageResponse(live);
  ok('get_usage payload → the adapter parse (0-100 ints normalized, named scoped field, codename skipped)', g && near(g.fiveHour.utilization, 0.34) && near(g.sevenDay.utilization, 0.39) && g.scopedWeekly.some((w) => /Sonnet/i.test(w.name) && near(w.utilization, 0.12)) && !g.scopedWeekly.some((w) => /nimbus/i.test(w.name)) && g.source === gRef.source, g);
  // (c) GET /api/oauth/usage REST JSON (limits[] + a named seven_day_* field + extra_usage)
  const rest = { five_hour: { utilization: 42, resets_at: '2026-08-08T05:00:00.000Z' }, seven_day: { utilization: 71, resets_at: '2026-08-12T00:00:00.000Z' },
    seven_day_opus: { utilization: 100, resets_at: '2026-08-12T00:00:00.000Z' },
    limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Claude Fable' } }, percent: 33, resets_at: '2026-08-13T00:00:00.000Z', severity: 'normal' }],
    extra_usage: { is_enabled: true, used_credits: 1234, monthly_limit: null, utilization: 0, currency: 'USD' } };
  const o = cl.normalize(rest);
  ok('OAuth REST JSON → 5h .42 / 7d .71 / limits[] Fable .33 / named Opus 1.0 exceeded / spend line', o && near(o.fiveHour.utilization, 0.42) && o.fiveHour.status === 'allowed' && near(o.sevenDay.utilization, 0.71)
    && o.scopedWeekly.some((w) => w.name === 'Claude Fable' && near(w.utilization, 0.33)) && o.scopedWeekly.some((w) => w.name === 'Opus' && w.utilization === 1 && w.severity === 'exceeded')
    && o.spend?.used === 12.34 && o.spend.limit === null && o.overallStatus === 'allowed', o);
  ok('the REST parse is the SAME function usage-routes binds as _parseUsage (moved, not copied)', /const _parseUsage = claudeQuota\.parseOAuthUsage;/.test(read('src/usage-routes.js')) && !/function _parseUsage\(/.test(read('src/usage-routes.js')));
  ok('unknown shapes → null', cl.normalize(null) === null && cl.normalize({}) === null && cl.normalize({ rate_limits: null }) === null && cl.normalize(42) === null);
}

// ── 4. signalFromStream on real record shapes ──
{
  const cl = harnesses.get('claude').quota;
  // the EXACT shape captured from a real 2.1.226 buffer (5h, allowed, overage)
  const s1 = cl.signalFromStream({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1786332600, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled_until', isUsingOverage: false }, uuid: 'x', session_id: 's' });
  ok('claude: a real allowed 5h event (no utilization) → meta signal, bucket fiveHour, resetsAtMs', s1?.source === 'rate_limit_event' && s1.kind === 'meta' && s1.bucket === 'fiveHour' && s1.resetsAtMs === 1786332600000 && s1.ev.overage.status === 'rejected', s1);
  const s2 = cl.signalFromStream({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1786900000 } });
  ok('claude: rejected → exhausted (the structured wall signal)', s2?.kind === 'exhausted' && s2.bucket === 'sevenDay' && s2.resetsAtMs === 1786900000000, s2);
  const s3 = cl.signalFromStream({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day_fable', utilization: 63 } });
  ok('claude: utilization → reading; seven_day_<model> → scoped bucket with its name', s3?.kind === 'reading' && s3.bucket === 'scoped' && s3.scopedName === 'fable' && s3.ev.utilization === 0.63, s3);
  const s4 = cl.signalFromStream({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "You've reached your Fable 5 limit · resets 3am" }] } });
  ok('claude: the chat LIMIT BANNER → exhausted, scoped Fable (a boolean wall signal — resetsAtMs stays 0, text is never a data source)', s4?.source === 'limit-banner' && s4.kind === 'exhausted' && s4.bucket === 'scoped' && s4.scopedName === 'Fable' && s4.resetsAtMs === 0, s4);
  const s5 = cl.signalFromStream({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 3am" }] } });
  ok('claude: the subagent/workflow "hit your session limit" wording → fiveHour', s5?.bucket === 'fiveHour', s5);
  ok('claude: ordinary assistant text / results / garbage → null', cl.signalFromStream({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello, the limit of this function is 5' }] } }) === null && cl.signalFromStream({ type: 'result' }) === null && cl.signalFromStream({ type: 'rate_limit_event' }) === null && cl.signalFromStream(null) === null);

  const cx = harnesses.get('codex').quota;
  const nowSec = Math.floor(Date.now() / 1000);
  const c1 = cx.signalFromStream({ type: 'event_msg', payload: { type: 'rate_limits_updated', rateLimits: { primary: { used_percent: 99, window_minutes: 10080, resets_at: nowSec + 3600 }, secondary: null, rate_limit_reached_type: 'primary' } } });
  ok('codex: rate_limits_updated with rate_limit_reached_type → exhausted + the tripped window + resetsAtMs', c1?.source === 'rate_limits_updated' && c1.kind === 'exhausted' && c1.tripped === c1.snapshot.sevenDay && c1.snapshot.sevenDay.utilization === 1 && c1.resetsAtMs === (nowSec + 3600) * 1000, c1);
  const c2 = cx.signalFromStream({ type: 'rate_limits_updated', rateLimits: { primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: nowSec + 3600 }, secondary: null }, resetCredits: { availableCount: 2 }, onDemand: true });
  ok('codex: a bare payload is accepted; healthy live push → reading; on-demand resetCredits ride the snapshot', c2?.kind === 'reading' && c2.tripped === null && c2.snapshot.sevenDay.usedPercent === 12 && c2.snapshot.resetCredits.availableCount === 2 && c2.onDemand === true, c2);
  const c3 = cx.signalFromStream({ type: 'event_msg', payload: { type: 'rate_limits_updated', error: 'request timed out', onDemand: true } });
  ok('codex: a FAILED on-demand rateLimits/read → probe-failed with the error (never silent)', c3?.kind === 'probe-failed' && /timed out/.test(c3.error), c3);
  const c4 = cx.signalFromStream({ type: 'event_msg', payload: { type: 'task_failed', error: 'You have hit your usage limit', codexErrorInfo: 'usage_limit_reached', resetsAt: 1788175818, rateLimits: null } });
  ok('codex: task_failed usage_limit_reached → exhausted with resetsAtSec/Ms (snapshot null when none rode along)', c4?.source === 'task_failed' && c4.kind === 'exhausted' && c4.errorInfo === 'usage_limit_reached' && c4.resetsAtSec === 1788175818 && c4.resetsAtMs === 1788175818000 && c4.snapshot === null, c4);
  for (const info of ['quota_exceeded', 'usage_not_included', 'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached', 'workspace_member_credits_depleted']) {
    ok(`codex: ${info} is exhaustion`, cx.signalFromStream({ type: 'task_failed', codex_error_info: info }).kind === 'exhausted');
  }
  // ── THE SPELLING THE WIRE ACTUALLY SENDS (2026-09-08, the 32h codex stall) ──
  // The names above are the HISTORICAL enum; measured over this instance's whole
  // codex corpus they match ZERO records. RE-MEASURED 2026-09-08 17:5x PDT, the
  // numbers being what a reader can reproduce today: `codex_error_info` takes
  // exactly three values across ~/.codex/sessions — `usage_limit_exceeded`
  // (102 records), `cyber_policy` (6), `unauthorized` (1) — and the historical
  // regex matches NONE of them. The app-server's camelCase twin
  // `usageLimitExceeded` is what the LIVE lane sends (its 0.153.4 schema
  // documents the translation: "This translation layer make sure that we expose
  // codex error code in camel case"); its record count in data/session-buffers
  // is NOT reproducible from here — those buffers rotate, and the incident
  // thread's own was replaced when the owner resumed it. EXCEEDED, not REACHED,
  // so codex auto-resume never armed once.
  {
    const WIRE = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 13th, 2026 8:36 PM.";
    for (const info of ['usageLimitExceeded', 'usage_limit_exceeded']) {
      const v = cx.signalFromStream({ type: 'event_msg', payload: { type: 'task_failed', error: WIRE, codexErrorInfo: info, resetsAt: null, rateLimits: null } });
      ok(`codex: ${info} — the spelling the wire really sends — is exhaustion`, v?.kind === 'exhausted', JSON.stringify(v).slice(0, 120));
      ok(`codex: …and its reset comes out of the CLI's own sentence, since the record states none (${info})`,
        Math.abs(v.resetsAtSec * 1000 - Date.parse('2026-09-13T20:36:23-07:00')) < 61000, v && new Date(v.resetsAtSec * 1000).toISOString());
    }
    // NOT exhaustion, each for a reason a continue would not fix — a closed set
    // that quietly grew would spend turns into walls that do not lift.
    for (const info of ['rateLimitExceeded', 'sessionBudgetExceeded', 'contextWindowExceeded', 'serverOverloaded'])
      ok(`codex: ${info} is NOT a quota wall (a continue would land in the same second / hit the same budget)`, cx.signalFromStream({ type: 'task_failed', codexErrorInfo: info, error: 'x' }) === null);
    // the enum can also ride NESTED (core writes it inside the turn's error)
    ok('codex: a nested error object is read too (core writes {message, codex_error_info})',
      cx.signalFromStream({ type: 'task_failed', error: { message: WIRE, codex_error_info: 'usage_limit_exceeded' } })?.kind === 'exhausted');
    // and the prose parser states nothing it cannot read
    ok('codex: a message with no "try again at …" states NO reset (never an invented wait)', cx.parseCodexLimitReset('You have hit your usage limit.') === 0);
    ok('codex: …nor does a reset already in the past', cx.parseCodexLimitReset('try again at Jan 2nd, 2020 8:36 PM') === 0);
    ok('codex: …and the printed minute is truncated, so the parse rounds UP (late costs a tick, early costs a turn)',
      cx.parseCodexLimitReset('try again at Sep 13th, 2026 8:36 PM', Date.parse('2026-09-07T00:00:00Z')) * 1000 === Date.parse('2026-09-13T20:37:00-07:00'));
  }

  // ── THE ENUM'S SHAPE, NOT JUST ITS SPELLING (2026-09-08 re-measurement) ──
  // CodexErrorInfo is a serde EXTERNALLY-TAGGED enum, so a variant carrying data
  // arrives as a ONE-KEY OBJECT. VERBATIM from this instance's own live buffer
  // (data/session-buffers/sess-13-1788764799305.buf — the incident thread):
  //     "codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":null}}
  // Every fixture in this repo assumed a bare string, and `String({…})` is
  // "[object Object]" — TRUTHY — so the object form never even reached the
  // message ladder: it was read as an unknown enum and dropped. Whether
  // `usageLimitExceeded` is itself a unit or a data variant in 0.153.4 could not
  // be measured (no such record survives, and `codex app-server` is a REJECTED
  // oracle: 7 INET connects incl. chatgpt.com:443, so asking it is banned), so
  // BOTH shapes are read.
  {
    const WIRE2 = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 13th, 2026 8:36 PM.";
    const obj = cx.signalFromStream({ type: 'task_failed', error: WIRE2, codexErrorInfo: { usageLimitExceeded: {} } });
    ok('codex: the EXTERNALLY-TAGGED object form of the exhaustion enum is exhaustion too', obj?.kind === 'exhausted' && obj.errorInfo === 'usageLimitExceeded', JSON.stringify(obj).slice(0, 140));
    const withData = cx.signalFromStream({ type: 'task_failed', error: 'no prose here', codexErrorInfo: { usageLimitExceeded: { resetsAt: 1789356983 } } });
    ok('codex: …and a reset carried INSIDE the variant is read (the http variants prove a variant can carry fields)', withData?.resetsAtSec === 1789356983, withData);
    // THE MEASURED RECORD ITSELF, as a negative control: a transport hiccup is
    // not a quota wall and not an auth failure — a continue would be a billed
    // turn for nothing, and marking the account dead would route around a
    // healthy one.
    const live = cx.signalFromStream({ type: 'task_failed', error: 'Reconnecting... 1/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, resetsAt: null, rateLimits: null });
    ok('codex: NEGATIVE CONTROL — the real object-form record from the incident buffer is neither a wall nor an auth failure', live === null, live);
    ok('codex: an internally-tagged spelling names the VARIANT, never the tag field', cx.codexErrorEnum({ type: 'usageLimitExceeded' }).name === 'usageLimitExceeded');
    ok('codex: an object that states no variant states nothing (never "[object Object]")', cx.codexErrorEnum({ a: 1, b: 2 }).name === '' && cx.codexErrorEnum(null).name === '' && cx.codexErrorEnum([1]).name === '');
    ok('codex: the auth enum is read in the object form too (same field, same wire)', cx.classifyAuthFailure({ codexErrorInfo: { unauthorized: {} } }) === true);
    // PRE-FIX CONTROL: the reader this release replaced, verbatim, on the same
    // record — it is the whole reason the shape had to be measured.
    const preFix = String({ usageLimitExceeded: {} } || '');
    ok('codex: PRE-FIX CONTROL — String(enum) on the object form yields "[object Object]", which no vocabulary matches', preFix === '[object Object]' && cx.isExhaustionInfo(preFix) === false);
  }
  const c5 = cx.signalFromStream({ type: 'event_msg', payload: { type: 'task_failed', error: 'Unauthorized', codexErrorInfo: 'unauthorized' } });
  ok('codex: the typed unauthorized enum → auth-failure', c5?.kind === 'auth-failure' && c5.errorInfo === 'unauthorized', c5);
  ok('codex: task_failed with no/other codex_error_info → null (a plain error is not a quota signal)', cx.signalFromStream({ type: 'task_failed', error: 'stream disconnected' }) === null && cx.signalFromStream({ type: 'task_failed', codexErrorInfo: 'other' }) === null);
  const c6 = cx.signalFromStream({ type: 'reset_credit_result', result: { outcome: 'reset' } });
  const c7 = cx.signalFromStream({ type: 'reset_credit_result', outcome: 'nothingToReset' });
  ok('codex: reset_credit_result → recovered / reset-credit-failed', c6?.kind === 'recovered' && c6.outcome === 'reset' && c7?.kind === 'reset-credit-failed' && c7.outcome === 'nothingToReset');
  ok('codex: other events → null', cx.signalFromStream({ type: 'event_msg', payload: { type: 'plan_updated', plan: [] } }) === null && cx.signalFromStream({ type: 'response_item' }) === null && cx.signalFromStream(null) === null);
  const sh = harnesses.get('shell').quota;
  ok('shell: nothing is ever a quota signal, no probe rung', sh.signalFromStream({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }) === null && sh.probe === null && sh.normalize('Current session: 30% used') === null);
}

// ── 5. classifyAuthFailure per vendor wording ──
{
  const cl = harnesses.get('claude').quota, cx = harnesses.get('codex').quota;
  ok('claude: the harness classifier IS account-pool-auto.classifyAuthFailure (verbatim, no twin)', cl.classifyAuthFailure === claudeClassify && cl.classifyAuthFailure({ status: 403 }) === true && cl.classifyAuthFailure({ status: 401, attempt: 1 }) === false);
  ok('codex: typed unauthorized qualifies', cx.classifyAuthFailure({ codexErrorInfo: 'unauthorized' }) === true);
  ok('codex: OpenAI wording — 401 Unauthorized / invalid_grant / token expired / not logged in / org deactivated', ['401 Unauthorized', 'invalid_grant: refresh token has expired', 'The access token has expired', 'Not logged in. Run codex login', 'This organization has been deactivated'].every((m) => cx.classifyAuthFailure({ message: m }) === true));
  ok('codex: 403 immediate; a lone first 401 is the refresh race; attempt ≥2 qualifies', cx.classifyAuthFailure({ status: 403 }) === true && cx.classifyAuthFailure({ status: 401, attempt: 1 }) === false && cx.classifyAuthFailure({ status: 401, attempt: 2 }) === true);
  ok('codex: 5xx / 429 / transport errors / empty never qualify', cx.classifyAuthFailure({ status: 500, message: 'Internal server error', attempt: 9 }) === false && cx.classifyAuthFailure({ status: 429 }) === false && cx.classifyAuthFailure({ message: 'stream disconnected before completion' }) === false && cx.classifyAuthFailure({}) === false && cx.classifyAuthFailure() === false);
}

// ── 6. THE DISPATCHER — functional, through a real engine.create() ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-qs-'));
const cacheDir = path.join(dir, 'usage-cache');
const sessions = new Map();
const cliSpy = [];
const ROSTER = {
  'cxs-1': { id: 'cxs-1', name: 'CxA', type: 'subscription', backend: 'codex' },
  'cxs-2': { id: 'cxs-2', name: 'CxB', type: 'subscription', backend: 'codex' },
  'cxs-3': { id: 'cxs-3', name: 'CxC', type: 'subscription', backend: 'codex' },
  'sub-1': { id: 'sub-1', name: 'Personal', type: 'subscription' }, // legacy record: no backend field = claude
  'pool-cx': { id: 'pool-cx', name: 'CxPool', type: 'pooled', backend: 'codex' },
};
const accounts = {
  get(id) { return ROSTER[id] || null; },
  list() { return { accounts: Object.values(ROSTER) }; },
  poolCurrentFor(pool) { return pool === 'pool-cx' ? 'cxs-1' : null; },
  poolCurrent(pool) { return pool === 'pool-cx' ? 'cxs-1' : null; },
  poolMembers() { return []; },
  subCredsPath(id) { return path.join(dir, 'nope', id); },
  sessionPoolLinkPath() { return path.join(dir, 'nope-link'); },
};
const engMod = require(path.join(REPO, 'src/server/usage-pool-engine.js'));
const app = { get() { }, post() { }, put() { }, delete() { }, use() { }, locals: {} };
const eng = engMod.create({
  app, rootDir: dir, USAGE_CACHE_DIR: cacheDir, activeSessions: sessions,
  wss: { clients: new Set() }, WS_OPEN: 1, broadcastToSession() { }, serverNotice() { },
  serverSetting() { return undefined; }, getAccounts() { return accounts; }, getHosts() { return null; },
  getUsageHistory() { return null; }, recordUsageAttribution() { }, adapterRegistry: { get() { return null; } },
  getAutoResume: () => null, getOtelIngest: () => null,
  getQuotaProbe: () => (key) => { cliSpy.push(key); return true; }, // the cli-usage rung's refresher (server.js: usage.refreshViaCliPanel)
});
ok('engine exports the dispatcher + the registry lookups (functional seam, never a source grep)', ['probeQuotaForKey', 'quotaSourceFor', 'quotaBackendFor'].every((k) => typeof eng[k] === 'function'));
ok('quotaSourceFor: claude/codex/shell resolve; falsy = legacy claude record; unknown = NULL source (loud, once)', eng.quotaSourceFor('codex').probe === 'rpc-rate-limits' && eng.quotaSourceFor(undefined).probe === 'cli-usage' && eng.quotaSourceFor('shell').probe === null && eng.quotaSourceFor('gemini') === harnesses.NULL_QUOTA);
ok('quotaBackendFor: named account → its backend (legacy = claude); __global_codex__ → codex; identity-less key → the asking session; else claude',
  eng.quotaBackendFor('cxs-1') === 'codex' && eng.quotaBackendFor('sub-1') === 'claude' && eng.quotaBackendFor('__global_codex__') === 'codex' && eng.quotaBackendFor('__global__', { backend: 'codex' }) === 'codex' && eng.quotaBackendFor('host-h1', { backend: 'shell' }) === 'shell' && eng.quotaBackendFor('__global__') === 'claude');

const nowSec = Math.floor(Date.now() / 1000);
const mkCodex = (webuiId, acct, onVerb) => {
  const s = { backend: 'codex', mode: 'chat', host: null, _webuiId: webuiId, _accountId: acct, writes: [] };
  s.pty = { write(line) { s.writes.push(line); let m = null; try { m = JSON.parse(line); } catch { } if (m && onVerb) onVerb(m, s); } };
  sessions.set(webuiId, s);
  return s;
};
// a live codex session whose app-server answers the wrapper verb the way the
// real wrapper does: `codex-read-limits` → rateLimits/read → rate_limits_updated
const cxSess = mkCodex('w-cx', 'cxs-1', (m, s) => {
  if (m.type !== 'codex-read-limits') return;
  setTimeout(() => eng.recordCodexQuotaSignal(s, { type: 'rate_limits_updated', onDemand: true, resetCredits: { availableCount: 1 }, rateLimits: { primary: { used_percent: 12, window_minutes: 10080, resets_at: nowSec + 3600 }, secondary: null } }), 10);
});
{
  const r = await eng.probeQuotaForKey('cxs-1', { session: cxSess });
  ok("codex identity → the 'rpc-rate-limits' rung, ok", r.rung === 'rpc-rate-limits' && r.backend === 'codex' && r.ok === true && r.reason === null, r);
  ok('…NO claude spawn for a codex identity (the §1 P2 fix)', cliSpy.length === 0, cliSpy);
  ok('…the wrapper verb went down the live session stdin', cxSess.writes.some((l) => l.trim() === JSON.stringify({ type: 'codex-read-limits' })), cxSess.writes);
  let cache = null; try { cache = JSON.parse(fs.readFileSync(path.join(cacheDir, 'cxs-1.json'), 'utf8')); } catch { }
  ok('…the reading was in the account cache BEFORE the probe settled (verdict-next sees it)', cache?.sevenDay?.usedPercent === 12 && cache.resetCredits?.availableCount === 1, cache);
  ok('…and the waiter list drained', (cxSess._codexLimitsWaiters || []).length === 0);
  const r2 = await eng.probeQuotaForKey('cxs-1');
  ok('no asking session: the dispatcher finds a live local codex session on the SAME identity', r2.ok === true && r2.rung === 'rpc-rate-limits' && cliSpy.length === 0, r2);
  const r3 = await eng.probeQuotaForKey('cxs-1', { session: { backend: 'claude', mode: 'chat', pty: {}, _accountId: 'sub-1' } });
  ok('a claude session asking about a codex KEY still rides the codex rung (the key decides, not the asker)', r3.rung === 'rpc-rate-limits' && r3.ok === true && cliSpy.length === 0, r3);
}
{
  const r = await eng.probeQuotaForKey('sub-1');
  ok("claude identity → the 'cli-usage' rung (refreshViaCliPanel), called with the key", r.rung === 'cli-usage' && r.ok === true && cliSpy.length === 1 && cliSpy[0] === 'sub-1', r);
  const r2 = await eng.probeQuotaForKey('__global__', { session: { backend: 'claude', mode: 'chat', pty: {} } });
  ok('the claude CLI login (__global__) rides cli-usage too', r2.rung === 'cli-usage' && cliSpy[1] === '__global__', r2);
}
{
  const r = await eng.probeQuotaForKey('__global_codex__');
  ok('codex CLI login with NO live codex session on that identity → honest miss, still no claude spawn', r.ok === false && r.rung === 'rpc-rate-limits' && /no live local codex chat session/.test(r.reason) && cliSpy.length === 2, r);
  const r2 = await eng.probeQuotaForKey('__global__', { session: { backend: 'shell', mode: 'terminal' } });
  ok('shell → no rung, nothing runs', r2.ok === false && r2.rung === null && /declares no quota probe/.test(r2.reason) && cliSpy.length === 2, r2);
  const r3 = await eng.probeQuotaForKey('__global__', { session: { backend: 'gemini', mode: 'chat', pty: {} } });
  ok('unknown backend → NULL source: no rung, no claude spawn (never gemini-as-claude)', r3.ok === false && r3.rung === null && r3.backend === 'gemini' && cliSpy.length === 2, r3);
}
{
  const silent = mkCodex('w-cx2', 'cxs-2', null); // app-server never answers
  const t0 = Date.now();
  const r = await eng.probeQuotaForKey('cxs-2', { session: silent, timeoutMs: 60 });
  ok('an unanswered rateLimits/read times out honestly (bounded wait, waiter dropped)', r.ok === false && /no rate_limits_updated within 60ms/.test(r.reason) && Date.now() - t0 < 2000 && (silent._codexLimitsWaiters || []).length === 0, r);
  const failing = mkCodex('w-cx3', 'cxs-3', (m, s) => { if (m.type === 'codex-read-limits') setTimeout(() => eng.recordCodexQuotaSignal(s, { type: 'rate_limits_updated', error: 'app-server: request timed out', onDemand: true }), 5); });
  const r2 = await eng.probeQuotaForKey('cxs-3', { session: failing });
  ok('a FAILED on-demand read settles the probe with the wrapper\'s error (never hangs to the timeout)', r2.ok === false && /request timed out/.test(r2.reason), r2);
  const late = mkCodex('w-cx4', 'cxs-3', (m, s) => { if (m.type === 'codex-read-limits') setTimeout(() => eng.recordCodexQuotaSignal(s, { type: 'rate_limits_updated', rateLimits: { primary: null, secondary: null } }), 5); });
  const r3 = await eng.probeQuotaForKey('cxs-3', { session: late });
  ok('an unparseable reply settles ok:false (a null snapshot is not a reading)', r3.ok === false && /unparseable/.test(r3.reason), r3);
  ok('a pooled codex scope probes its CURRENT MEMBER through the same rung', (await eng.probeQuotaForKey('pool-cx', { session: cxSess })).rung === 'rpc-rate-limits');
}
// the two engine consumers route through the dispatcher (functional)
{
  const before = cliSpy.length, writesBefore = cxSess.writes.length;
  const ok1 = await eng.beforeAutoResumeFire('w-cx', cxSess);
  ok('beforeAutoResumeFire on a codex session: probes via the live app-server, no claude spawn, and (fresh 12% reading) does not veto', ok1 === true && cliSpy.length === before && cxSess.writes.length === writesBefore + 1, { ok1, cli: cliSpy.length - before, writes: cxSess.writes.length - writesBefore });
  const clSess = { backend: 'claude', mode: 'chat', host: null, _webuiId: 'w-cl', _accountId: 'sub-1', pty: { write() { } } };
  sessions.set('w-cl', clSess);
  const ok2 = await eng.beforeAutoResumeFire('w-cl', clSess);
  ok('beforeAutoResumeFire on a claude session: the cli-usage rung, keyed to its account', ok2 === true && cliSpy[cliSpy.length - 1] === 'sub-1' && cliSpy.length === before + 1);
}

// ── 7. wiring pins (the 2.355.0 lesson: a pure fix without its call site is dead) ──
{
  const eng = read('src/server/usage-pool-engine.js');
  ok('WIRING: scheduleWallProbe and beforeAutoResumeFire both call probeQuotaForKey(target, { session })', (eng.match(/probeQuotaForKey\(target, \{ session \}\)/g) || []).length === 2);
  ok('WIRING: getQuotaProbe is consumed ONLY inside the dispatcher\'s cli-usage rung', (eng.match(/getQuotaProbe\?\.\(\)/g) || []).length === 1 && /if \(rung === 'cli-usage'\) \{\s*\n\s*const probe = getQuotaProbe\?\.\(\);/.test(eng));
  ok('WIRING: recordRateLimitEvent classifies through the session harness (no direct parseRateLimitEvent in the engine)', /quotaSourceFor\(session\.backend\)\.signalFromStream\(msg\)/.test(eng) && !/parseRateLimitEvent\(/.test(eng));
  ok('WIRING: recordCodexQuotaSignal consumes the harness signal (snapshot / tripped / resetsAtSec), NAMES the reading channel at the write (2026-09-07 r3: writeSnap takes `source` as a parameter — the task_failed branch is a refusal, not this push) and settles probe waiters AFTER the cache write', /const snap0 = sig\?\.snapshot \|\| null;[\s\S]{0,200}const w = writeSnap\(snap0, 'codex-rate-limits'\);\s*\n[\s\S]{0,300}settleCodexLimitsWaiters\(session, w && w\.key \?/.test(eng) && /const tripped = sig\.tripped;/.test(eng) && /const resets = sig\.resetsAtSec;/.test(eng) && !/require\('\.\.\/usage-routes\.js'\)/.test(eng));
  ok('WIRING: notePoolAuthFailure asks the session harness for the auth verdict', /quotaSourceFor\(session\.backend\)\.classifyAuthFailure\(info\)/.test(eng));
  ok('WIRING: the wall-machine pins test-auto-resume relies on are intact (verify probe, ladder, veto)', /_wallVerifyAt\.set\(scope, Date\.now\(\)\);\s*\n\s*scheduleWallProbe\(session, scope, model, 0\)/.test(eng) && /async function beforeAutoResumeFire/.test(eng) && /WALL_PROBE_BACKOFF = \[0, 1800000, 3600000, 7200000\]/.test(eng));
  ok('server.js still hands the cli-usage refresher to the engine (usage.refreshViaCliPanel — the ONE `claude -p /usage` spawn site)', /getQuotaProbe: \(\) => \{ try \{ return usage\.refreshViaCliPanel; \}/.test(read('server.js')));
  ok('session-schema registers the waiter field with an owner', /_codexLimitsWaiters:\s*\{ owner: 'engine'/.test(read('src/session-schema.js')));
  const ur = read('src/usage-routes.js');
  ok('usage-routes defines NO quota normalizer of its own any more — it binds the registry and re-exports the old names', !/function normalizeCodexRateLimit\(/.test(ur) && !/function parseCliUsageText\(/.test(ur) && /harnesses\.get\('codex'\)\.quota\.normalize/.test(ur) && /module\.exports = \{ setupUsage, parseCliUsageText, normalizeCodexRateLimit \}/.test(ur));
  const arch = read('scripts/test-architecture.mjs');
  // both sides' pins kept: backend-caps is in the PURE SET (membership) AND inside the `const PURE = new Set([` literal (placement)
  ok('test-architecture tiers the harness modules as SHARED (never reaching up into ORCH) and backend-caps as PURE', /'src\/harnesses\/claude-quota\.js', 'src\/harnesses\/codex-quota\.js'/.test(arch) && /'src\/backend-caps\.js'[,\]]/.test(arch) && /const PURE = new Set\(\[[^\]]*'src\/backend-caps\.js'/.test(arch));
  const ss = read('src/server/stdout/claude-stream-json.js') + '\n' + read('src/server/stdout/codex-events.js'); // S5: per-protocol consumer modules
  ok('the stdout consumers still feed both engine entry points (claude rate_limit_event / codex quota events) — S5 moved the parse behind the registry, S4 owns the signals', /recordRateLimitEvent\(session, msg\)/.test(ss) && /recordCodexQuotaSignal\?\.\(session, msg\.payload\)/.test(ss));
  ok('the codex wrapper still serves the verb the rpc rung writes (codex-read-limits → account/rateLimits/read → rate_limits_updated)', /msg\.type === 'codex-read-limits'/.test(read('data/bin/codex-chat-wrapper.js')) && /account\/rateLimits\/read/.test(read('data/bin/codex-chat-wrapper.js')));
}

// ── 8. §ban-safety: the vendor whitelist stays green ──
{
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/test-vendor-whitelist.mjs')], { encoding: 'utf8', timeout: 60000 });
  ok('scripts/test-vendor-whitelist.mjs passes (no new vendor call site anywhere in this slice)', r.status === 0, (r.stdout || '').split('\n').filter((l) => /✗/.test(l)).join('; ') || r.stderr);
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
