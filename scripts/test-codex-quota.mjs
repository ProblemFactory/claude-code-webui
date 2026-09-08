#!/usr/bin/env node
// Codex quota P0+P1 (2.368.18, design-backend-parity.md §0/§1): the normalizer
// mislabeled the 0.149.x single-window shape (weekly rendered as the 5h
// bucket) and DROPPED every exhaustion marker; snapshots never persisted (14-
// day amnesia) and codex was excluded from the anchors→estimator stack.
// Shapes below are verbatim from real rollouts / the live app-server push.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const { normalizeCodexRateLimit } = require(path.join(REPO, 'src/usage-routes.js'));

// ── P0: window classification by LENGTH, not position ──
{
  // 0.149.x single-window shape (real): primary IS the weekly window
  const n = normalizeCodexRateLimit({ limit_id: 'codex', limit_name: null, primary: { used_percent: 37, window_minutes: 10080, resets_at: 1788175818 }, secondary: null, credits: { has_credits: false, unlimited: false, balance: '0' }, plan_type: 'pro', rate_limit_reached_type: null }, 1000);
  ok('single-window shape: a 10080min primary lands in sevenDay (was mislabeled fiveHour)', !n.fiveHour && n.sevenDay?.usedPercent === 37 && n.sevenDay.windowMinutes === 10080, JSON.stringify(n));
  ok('…and credits/plan survive', n.credits?.hasCredits === false && n.planType === 'pro');
  // pre-0.149 two-window shape (real May/July rollouts)
  const o = normalizeCodexRateLimit({ primary: { used_percent: 25, window_minutes: 300, resets_at: 111 }, secondary: { used_percent: 51, window_minutes: 10080, resets_at: 222 } }, 1000);
  ok('two-window shape still maps 300→fiveHour / 10080→sevenDay', o.fiveHour?.usedPercent === 25 && o.sevenDay?.usedPercent === 51);
  // live app-server camelCase with windowDurationMins (real sidecar shape)
  const l = normalizeCodexRateLimit({ limitId: 'codex', primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1788175818 }, secondary: null, planType: 'pro' }, 1000);
  ok("live push's windowDurationMins is read (was ignored → weekly defaulted to a 300min fiveHour)", !l.fiveHour && l.sevenDay?.windowMinutes === 10080, JSON.stringify(l));
}

// ── P0: exhaustion markers kept + tripped window marked dead ──
{
  const n = normalizeCodexRateLimit({ primary: { used_percent: 99, window_minutes: 10080, resets_at: 333 }, secondary: null, rate_limit_reached_type: 'primary', spend_control_reached: true, credits: { has_credits: true, unlimited: false, balance: '12' } }, 1000);
  ok('rate_limit_reached_type is KEPT (it is the auto-switch trigger)', n.rateLimitReachedType === 'primary');
  ok('the tripped window reads dead regardless of its %', n.sevenDay.utilization === 1 && n.sevenDay.status === 'limited');
  ok('spend_control + credits survive normalization', n.spendControlReached === true && n.credits?.balance === '12');
}

// ── P1: persistence + estimator wiring pins ──
{
  const ur = read('src/usage-routes.js');
  ok('snapshots SEED from USAGE_CACHE_DIR (idle accounts stop going amnesiac at 14 days)', /SEED FROM DISK[\s\S]{0,400}cxs-\[\\w-\]\+\|__global_codex__/.test(ur));
  ok('…and WRITE-THROUGH freshest-wins (fetchedAt-guarded, never poison newer with older)', /WRITE-THROUGH[\s\S]{0,600}Number\(cur\.fetchedAt\) \|\| 0\) >= \(Number\(snap\.fetchedAt\)/.test(ur));
  ok('/api/usage estimates cover codex keys', /codex identities estimate too[\s\S]{0,300}codexRl\.byAccount/.test(ur));
  const eng = read('src/server/usage-pool-engine.js');
  ok('codex identities JOIN the groups (the "economics are separate" skip is gone)', !/backend === 'codex'\)\) continue; \/\/ pools have no quota/.test(eng) && /codex identities join the groups/.test(eng));
  ok('codex identity keys are backend-prefixed (email collision with a claude login must never merge quotas)', /isCodex \? 'codex:' : ''\) \+ identityKeyFor/.test(eng));
  ok("'__global_codex__' is a pseudo id, not a deleted account", /__global_codex__\.json'\) \? null/.test(eng));
  ok('codex identities learn WITHOUT the claude Max priors', /priorsFor: \(identityKey\) => String\(identityKey \|\| ''\)\.startsWith\('codex:'\) \? null : CLAUDE_MAX_PRIOR_FULL_USD/.test(eng));
  // (the gate grew a sibling clause in 2026-09-08 — autoCliReady — so the
  // adjacency is bounded to the same line rather than literal; what is pinned
  // is unchanged: the backend test is one of the conditions that `continue`s
  // BEFORE the spawn.)
  ok('auto-cli refresh loop skips codex accounts (claude -p /usage is claude-only)', /a\.backend \|\| 'claude'\) !== 'claude'[^\n]*\) continue; \/\/ auto-cli/.test(read('server.js')));
  const um = read('src/lib/usage-meter.js');
  ok('the popup codex section renders est pairs like the claude one', /estDisplayPair\(codex\?\.fiveHour, cEstSel\?\.fiveHour\)/.test(um) && /estBar\(cp5\)/.test(um) && /estStat\(cp7\)/.test(um));
  ok('cache-efficiency bar drops the fake cache-write segment for codex-only views', /codexOnly \? \[\] : \[\{ k: t\('Cache writes'\)/.test(read('src/lib/usage-window.js')));
}

// ── P1: costBetweenMulti keys codex-global events correctly ──
{
  const { costBetweenMulti } = require(path.join(REPO, 'src/usage-anchors.js'));
  const fakeHistory = {
    *_events() {
      yield { ts: 10, acct: null, be: 'codex', model: 'gpt-5.6-sol', i: 1000, o: 100, cw5: 0, cw1: 0, cr: 0 };
      yield { ts: 11, acct: null, be: 'claude', model: 'claude-fable-5', i: 1000, o: 100, cw5: 0, cw1: 0, cr: 0 };
    },
    _cost: () => 1,
  };
  const cx = costBetweenMulti(fakeHistory, ['__global_codex__'], 0, 100);
  const cl = costBetweenMulti(fakeHistory, [null], 0, 100);
  ok('a codex CLI-login event counts into __global_codex__, NOT the claude global', cx.requests === 1 && cl.requests === 1, JSON.stringify({ cx: cx.requests, cl: cl.requests }));
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
