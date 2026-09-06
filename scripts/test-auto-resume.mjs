#!/usr/bin/env node
// Auto-continue after a usage limit resets + the CLI output style (2.368.0,
// owner: "都做吧 另外可以配置是否默认开启自动恢复").
//
// The CLI has its own auto-continue, but only in the interactive REPL —
// `/rate-limit-options` is absent from a stream-json session's command list and
// the timer is a TUI interval — so this is ours. What the suite protects:
//   · the tri-state gate (per-session OFF must survive the default being ON)
//   · it never fires early, never twice, never while the session is working
//   · anything that proves recovery (pool switch, the user's own prompt)
//     DISARMS it — a fire on a recovered session is a billed turn for nothing
//   · the wait SURVIVES A RESTART (the CLI's own cannot; that is the point)
//   · output style rides the ONE --settings flag we already use, and only at
//     spawn (stream-json has no /output-style)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const { create, CONTINUE_PROMPT, GRACE_MS, MAX_WAIT_MS } = require(path.join(REPO, 'src/server/auto-resume.js'));

const mk = ({ dflt = false, dir } = {}) => {
  const d = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ar-'));
  const sent = [], notes = [], casts = [];
  const sessions = new Map();
  const ar = create({
    dataDir: d, activeSessions: sessions,
    serverSetting: (k) => (k === 'claude.autoResumeOnLimit' ? dflt : undefined),
    sendToSession: (id, s, text) => { if (s.dead) return false; sent.push({ id, text }); return true; },
    notify: (id, s, text) => notes.push({ id, text }),
    broadcast: (id, m) => casts.push(m),
  });
  return { ar, dir: d, sent, notes, casts, sessions };
};
const sess = (over = {}) => ({ mode: 'chat', backend: 'claude', pty: {}, _isStreaming: false, ...over });
const T0 = Date.now();   // the module refuses waits >26h out, so the clock must be REAL

// ── 1. the tri-state gate ──
{
  const a = mk({ dflt: false });
  a.sessions.set('s1', sess());
  ok('default OFF ⇒ exhaustion does not arm', a.ar.armIfEnabled('s1', a.sessions.get('s1'), Date.now() + 60000, '5h') === null);
  const b = mk({ dflt: true });
  b.sessions.set('s1', sess());
  ok('default ON ⇒ arms', !!b.ar.armIfEnabled('s1', b.sessions.get('s1'), Date.now() + 60000, '5h'));
  const c = mk({ dflt: true });
  c.sessions.set('s1', sess({ _autoResume: false }));
  ok('THE POINT of the tri-state: a per-session OFF beats the default being ON', c.ar.armIfEnabled('s1', c.sessions.get('s1'), Date.now() + 60000, '5h') === null);
  const d = mk({ dflt: false });
  d.sessions.set('s1', sess({ _autoResume: true }));
  ok('and a per-session ON beats the default being OFF', !!d.ar.armIfEnabled('s1', d.sessions.get('s1'), Date.now() + 60000, '5h'));
  ok('status reports where the answer came from', d.ar.statusFor('s1').explicit === true && d.ar.statusFor('s1').globalDefault === false);
}

// ── 2. refusals: nothing to wait for ──
{
  const a = mk({ dflt: true });
  a.sessions.set('s1', sess());
  ok('no reset time ⇒ no arm (we do not invent a wait)', a.ar.armIfEnabled('s1', a.sessions.get('s1'), null, 'x') === null);
  ok('a reset already in the past ⇒ no arm', a.ar.armIfEnabled('s1', a.sessions.get('s1'), Date.now() - 1000, 'x') === null);
  ok('a reset a week out ⇒ refuses to squat', a.ar.armIfEnabled('s1', a.sessions.get('s1'), Date.now() + MAX_WAIT_MS + 60000, 'weekly') === null);
  ok('an unknown session ⇒ no arm', a.ar.armIfEnabled('nope', null, Date.now() + 60000, 'x') === null);
}

// ── 3. firing: on time, once, and only when idle ──
{
  const a = mk({ dflt: true });
  a.sessions.set('s1', sess());
  const resets = T0 + 60000;
  a.ar.armIfEnabled('s1', a.sessions.get('s1'), resets, '5h limit');
  ok('armed status carries the reset time for the UI', a.ar.statusFor('s1').armed === true && a.ar.statusFor('s1').resetsAt === resets);
  ok('does NOT fire before the reset', a.ar.tick(resets - 1) === 0 && a.sent.length === 0);
  ok('does NOT fire during the grace window (let the reset actually land)', a.ar.tick(resets + GRACE_MS - 1) === 0);
  a.sessions.get('s1')._isStreaming = true;
  ok('does NOT fire while the session is already working', a.ar.tick(resets + GRACE_MS + 1) === 0 && a.sent.length === 0);
  a.sessions.get('s1')._isStreaming = false;
  ok('fires once the reset has landed and the session is idle', a.ar.tick(resets + GRACE_MS + 1) === 1);
  ok('and sends the CLI\'s own continue wording', a.sent[0].text === CONTINUE_PROMPT && /do not repeat work that is already complete/.test(a.sent[0].text));
  ok('NEVER twice', a.ar.tick(resets + 600000) === 0 && a.sent.length === 1);
  ok('the fire is announced in the conversation (a billed turn must explain itself)', a.notes.some((n) => /自动继续|continue/i.test(n.text)));
  ok('the arming announcement is DELAYED, not immediate (2.368.34 §10 covers the full lifecycle)', a.notes.filter((n) => /已安排/.test(n.text)).length === 0);
}

// ── 4. recovery disarms (a fire on a recovered session is money for nothing) ──
{
  for (const why of ['user sent a prompt', 'fresh non-rejected reading', 'pool switched']) {
    const a = mk({ dflt: true });
    a.sessions.set('s1', sess());
    const resets = T0 + 60000;
    a.ar.armIfEnabled('s1', a.sessions.get('s1'), resets, '5h');
    a.ar.noteRecovered('s1', why);
    ok(`disarmed by: ${why}`, a.ar.statusFor('s1').armed === false && a.ar.tick(resets + 600000) === 0 && a.sent.length === 0);
  }
  const a = mk({ dflt: true });
  a.sessions.set('s1', sess());
  a.ar.armIfEnabled('s1', a.sessions.get('s1'), T0 + 60000, '5h');
  a.ar.setEnabled('s1', false);
  ok('turning the toggle off cancels a pending wait', a.ar.statusFor('s1').armed === false && a.ar.tick(T0 + 600000) === 0);
  const b = mk({ dflt: true });
  b.sessions.set('s1', sess());
  b.ar.armIfEnabled('s1', b.sessions.get('s1'), T0 + 60000, '5h');
  b.sessions.delete('s1');
  ok('a session that died while waiting is dropped, not resurrected', b.ar.tick(T0 + 600000) === 0 && b.sent.length === 0);
}

// ── 5. THE differentiator: the wait survives a restart ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ar-p-'));
  const a = mk({ dflt: true, dir });
  a.sessions.set('s1', sess());
  const resets = T0 + 3_600_000;
  a.ar.armIfEnabled('s1', a.sessions.get('s1'), resets, '5h limit');
  ok('the pending wait is persisted', JSON.parse(fs.readFileSync(path.join(dir, 'auto-resume.json'), 'utf-8')).armed.s1.resetsAt === resets);
  const b = mk({ dflt: true, dir });          // a NEW process, same data dir
  b.sessions.set('s1', sess());
  ok('a fresh process still knows about the wait (the CLI\'s own version cancels here)', b.ar.statusFor('s1').armed === true);
  ok('and it still fires', b.ar.tick(resets + GRACE_MS + 1) === 1 && b.sent[0].text === CONTINUE_PROMPT);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 6. delivery failure must not silently drop the wait ──
{
  const a = mk({ dflt: true });
  a.sessions.set('s1', sess({ dead: true }));   // sendToSession returns false
  // FRESH now, not module-load T0 (CI flake 2026-08-24: a slow Actions runner
  // took >1s to reach this section, T0+1000 was already past, armIfEnabled
  // correctly refused, and both asserts failed — green locally for weeks)
  const resets = Date.now() + 60000;
  a.ar.armIfEnabled('s1', a.sessions.get('s1'), resets, '5h');
  ok('a failed delivery keeps the wait armed for the next tick', a.ar.tick(resets + GRACE_MS + 1) === 0 && a.ar.statusFor('s1').armed === true);
  a.sessions.get('s1').dead = false;
  ok('…and it lands on the retry', a.ar.tick(resets + GRACE_MS + 2) === 1);
}

// ── 7. wiring pins ──
{
  const eng = read('src/server/usage-pool-engine.js');
  ok('exhaustion arms it — AFTER trying the pool switch (seconds beat hours)', /maybePoolAutoSwitch\(session\);[\s\S]{0,400}getAutoResume\(\)\?\.armIfEnabled/.test(eng));
  ok('a fresh non-rejected reading disarms it', eng.includes("getAutoResume()?.noteRecovered?.(session._webuiId, 'fresh non-rejected reading')"));
  const wsh = read('src/ws-handler.js');
  ok('a user prompt disarms it', wsh.includes("autoResume?.noteRecovered?.(data.sessionId, 'user sent a prompt')"));
  ok('the live toggle is a ws case', wsh.includes("case 'auto-resume'") && wsh.includes('autoResume?.setEnabled'));
  ok('attach carries the state (a reconnecting tab sees the pending wait)', wsh.includes('autoResume: autoResume?.statusFor?.(data.sessionId)'));
  const sv = read('server.js');
  ok('server.js creates + starts it', sv.includes("auto-resume.js').create") && sv.includes('autoResume.start()'));
  ok('and hands it to the engine LAZILY (created later in the file)', sv.includes('getAutoResume: () => { try { return autoResume;'));
  const sb = read('src/lib/chat-status-bar.js');
  ok('status bar shows the pending wait with its time', sb.includes('chat-status-autoresume') && sb.includes('will continue by itself at {t}'));
  ok('and the toggle persists per session', /type: 'auto-resume'[\s\S]{0,200}autoResume: on/.test(sb));
  // 2.368.5 (owner: "几乎没有视觉反馈…和outputstyle的待加载沙漏挨着不好"): the
  // chip's ON state must be visibly ON (accent class + label, not a one-shade
  // dim), and its icon must NOT be the hourglass — that means "pending pick"
  // on the style chip one chip to the left.
  {
    const arSpan = sb.slice(sb.indexOf('chat-status-autoresume chat-status-clickable') - 400, sb.indexOf('chat-status-autoresume chat-status-clickable') + 400);
    ok('auto-continue chip does NOT reuse the style chip\'s hourglass', arSpan.includes('UI_ICONS.autoContinue') && !arSpan.includes('UI_ICONS.hourglass'));
    ok('ON state is visibly on: accent class + label', sb.includes('chat-status-autoresume-on') && /a\.enabled \? ' ' \+ escHtml\(t\('auto'\)\)/.test(sb));
    ok('the on-state class is styled (accent, not dim)', /\.chat-status-autoresume-on\s*{\s*color: var\(--accent\)/.test(read('public/chat.css')));
    ok('the icon exists in the SVG library', read('src/lib/icons.js').includes('autoContinue:'));
  }
  ok('the default is a documented setting', read('src/lib/settings-schema.js').includes("'claude.autoResumeOnLimit'"));
}

// ── 8. output style: spawn-only, on the ONE --settings flag ──
{
  const { ClaudeCodeAdapter } = require(path.join(REPO, 'src/adapters/claude-code.js'));
  const ad = new ClaudeCodeAdapter({ buffersDir: '/tmp' });
  const argsOf = (opts) => ad.buildSessionArgs({ cwd: '/tmp', mode: 'chat', ...opts }).args;
  const settingsOf = (args) => { const i = args.indexOf('--settings'); return i < 0 ? null : JSON.parse(args[i + 1]); };
  ok('no style ⇒ no settings flag invented', settingsOf(argsOf({})) === null);
  ok('Concise rides --settings as outputStyle', settingsOf(argsOf({ outputStyle: 'Concise' })).outputStyle === 'Concise');
  ok('"default" is treated as unset', settingsOf(argsOf({ outputStyle: 'default' })) === null);
  const both = argsOf({ outputStyle: 'Concise', effort: 'ultracode' });
  ok('MERGED with the other settings keys, never a second --settings flag', both.filter((a) => a === '--settings').length === 1 && settingsOf(both).outputStyle === 'Concise' && settingsOf(both).ultracode === true);
  ok('there is no --output-style flag to pass (the CLI has none)', !argsOf({ outputStyle: 'Concise' }).includes('--output-style'));
  const wc = read('src/ws-create.js');
  ok('every create path gets the instance default unless the client picked one', wc.includes("data.outputStyle || (() => { try { return serverSetting('claude.outputStyle')"));
  ok('the session records what it was spawned with (the EFFECTIVE style)', wc.includes('session._outputStyle = data._effOutputStyle'));
  ok('a resume carries the saved style + auto-resume choice', read('src/lib/session-lifecycle.js').includes('outputStyle: savedCfg.outputStyle') && read('src/lib/session-lifecycle.js').includes('autoResume: savedCfg.autoResume'));
  const sb = read('src/lib/chat-status-bar.js');
  ok('the picker exists and is HONEST that it only applies next resume', sb.includes('chat-status-style') && sb.includes('A running session cannot change style'));
  ok('the default style is a documented setting', read('src/lib/settings-schema.js').includes("'claude.outputStyle'"));
  // ── STRIKE FOUR (2.368.1, owner-caught within hours): the sidebar's
  // per-session-config WHITELIST silently dropped both new keys — the exact
  // bug its own comment documents for 'account' (2.43.0) and 'groupManager'
  // (2.132.0). Pin the list AND the tri-state exception, because the truthy
  // filter would erase an explicit autoResume:false (whose whole point is
  // beating the global default being ON).
  const st = read('src/lib/sidebar-state.js');
  ok('config whitelist carries outputStyle (strike-four fix)', /for \(const k of \[[^\]]*'outputStyle'/.test(st));
  ok('an explicit autoResume:false PERSISTS (tri-state, not truthy-filtered)', st.includes('config?.autoResume === true || config?.autoResume === false'));
  ok('the chip reports the EFFECTIVE spawn style, default-sourced included', read('src/ws-create.js').includes('data._effOutputStyle') && read('src/ws-create.js').includes('session._outputStyle = data._effOutputStyle'));
  ok('a pick is VISIBLY pending on the chip (a silent drop must never look like this again)', sb.includes('setOutputStylePending') && sb.includes('applies on the next resume (now running'));
  // one-click restart (owner UX 2.369.8): the pending pick offers a restart
  // row in the menu; the machinery is the pool cold switch's kill→exited→resume
  ok('the style menu offers Restart-now when a pick is pending', sb.includes('Restart now to apply') && sb.includes('_onRestartSession'));
  const sl9 = read('src/lib/session-lifecycle.js');
  ok('restartConversationInPlace exists (kill → exited → resume, config rides the respawn)', /restartConversationInPlace\(sessLike = \{\}\)/.test(sl9) && /this\.killSession\(webuiId, cid\)/.test(sl9));
  ok('…and the session ops ride the window-title menu + the sidebar card menu (registry since Ph1: both menus contribute the session.restart command, whose run() is restartConversationInPlace)', /id: 'window\/restart-session', command: 'session\.restart'/.test(read('src/lib/taskbar.js')) && /id: 'session\.restart'[^\n]*restartConversationInPlace/.test(read('src/lib/session-card.js')) && /command: 'session\.restart'/.test(read('src/lib/session-card.js')));
  ok('locate-in-sidebar exists (folders panel, expand, scroll, flash)', /locateSessionInSidebar\(backendSessionId\)/.test(sl9) && /locate-flash/.test(sl9));
  const cv2 = read('src/lib/chat-view.js');
  ok('partial-meta refreshes do NOT reset the live style (2.368.3: wiping os to \'\' re-lit the hourglass on a running Concise session)', /_applyLiveMeta\(meta\)\s*{\s*if \(!meta\) return;[\s\S]{0,200}'outputStyle' in meta/.test(cv2) && cv2.includes("'autoResume' in meta"));
  // ── 2.368.4 (owner-caught on the very resume the feature was built for):
  // the CREATOR never receives an 'attached' payload — its history loads over
  // HTTP with NO meta — so the live style must ride the 'created' reply. And
  // the attach path copied the payload into meta KEY BY KEY, a hand list that
  // silently lacked outputStyle/autoResume (the whitelist-drift class, fifth
  // strike): both attach-shaped call sites must pass the payload WHOLESALE.
  ok("'created' carries the live style + auto-resume state (always, null = default)", /type: 'created'[\s\S]{0,1800}outputStyle: session\._outputStyle \|\| null[\s\S]{0,200}autoResume: autoResume\?\.statusFor\?\.\(id\) \|\| null/.test(read('src/ws-create.js')));
  const sl2 = read('src/lib/session-lifecycle.js');
  ok('the created handler APPLIES it (HTTP history load has no meta)', /if \(sessionEffort\) chatView\.applyStatus[\s\S]{0,600}chatView\._applyLiveMeta\?\.\(msg\)/.test(sl2));
  ok('the attach path passes the payload WHOLESALE, not a hand-copied key list', /chatView\.loadHistory\(msg\.messages, msg\.totalCount, msg\.isStreaming, msg\)/.test(sl2) && !/loadHistory\(msg\.messages, msg\.totalCount, msg\.isStreaming, { chatStatus: msg\.chatStatus, taskState/.test(sl2));
  ok('…and a zero-message attach still applies live state', /else {\s*\n\s*chatView\._applyLiveMeta\?\.\(msg\);/.test(sl2));
  ok('_fullViewReset passes the payload wholesale too', /this\.loadHistory\(msg\.messages \|\| \[\], msg\.totalCount \|\| 0, msg\.isStreaming, msg\)/.test(cv2));
}

// ── §8-10 THE WALL MACHINE (2.369.0, owner-designed replacement for the
// .27-.34 patch pile; design record: docs/design-wall-machine.md). The four
// agreed pillars, each with its incident:
//   ① the banner is a BOOLEAN signal, never a data source
//   ② quotaVerdict = the account system's ONE usability answer (5h<10%,
//      weekly<5%; blockedUntil = max over dead buckets; pool = min over
//      members) — same THRESH table as the pool engine, no twin
//   ③ the RESULT record classifies the turn; a normally-completed turn is
//      sufficient proof the session is not blocked (kills the record-
//      granular noteWorked/30s-age hacks)
//   ④ missing reset time → PROBE (/usage panel, 0→30m→1h→2h), never guess
{
  const { quotaVerdict } = require(path.join(REPO, 'src/account-pool-auto.js'));
  const nowS = 1787751372;
  const H = 3600;
  // the premature-fire shape (owner: 7d重置没对齐5h): both dead ⇒ MAX
  const v1 = quotaVerdict({ fiveHour: { utilization: 0.97, resetsAt: nowS + 4.7 * H }, sevenDay: { utilization: 0.99, resetsAt: nowS + 2 * H } }, nowS);
  ok('quotaVerdict: two dead buckets ⇒ blockedUntil is the MAX (all must reset)', v1.usable === false && v1.blockedUntil === (nowS + 4.7 * H) * 1000, JSON.stringify(v1));
  const v2 = quotaVerdict({ fiveHour: { utilization: 0.5, resetsAt: nowS + H }, sevenDay: { utilization: 0.99, resetsAt: nowS + 9 * H } }, nowS);
  ok("a healthy bucket's nearer reset is not a candidate (7d dead ⇒ wait for 7d)", v2.usable === false && v2.blockedUntil === (nowS + 9 * H) * 1000, JSON.stringify(v2));
  ok("the owner's usability line: 5h<10% / weekly<5% (THRESH hot tier)", quotaVerdict({ fiveHour: { utilization: 0.91, resetsAt: nowS + H } }, nowS).usable === false && quotaVerdict({ fiveHour: { utilization: 0.89, resetsAt: nowS + H } }, nowS).usable === true);
  const v3 = quotaVerdict({ fiveHour: { utilization: 0.97 } }, nowS);
  ok('a dead bucket with NO future reset ⇒ blockedUntil 0 (caller PROBES, never guesses)', v3.usable === false && v3.blockedUntil === 0);
  ok('no usage data ⇒ usable null (unknown, never guessed dead)', quotaVerdict(null, nowS).usable === null);
  ok('a rolled-over window reads FULL again (reset-passed rule intact)', quotaVerdict({ fiveHour: { utilization: 1, resetsAt: nowS - 60 } }, nowS).usable === true);

  // engine wiring: the machine owns every transition (2.355.0 wiring law)
  const eng = read('src/server/usage-pool-engine.js');
  ok('WIRING: rejected events are SIGNALS, not arms (the turn result classifies)', /if \(r\.dead\) \{[\s\S]{0,600}noteWallSignal\(session, \{ resetsAtMs/.test(eng) && !/armBestReset/.test(eng));
  // the banner names its BUCKET (parseLimitBanner, the same name the cache mark used) and the KEY its mark landed on (B-2c9b) — never a TIME
  ok('WIRING: the banner is a BOOLEAN signal (no time extraction feeds the machine)', /noteWallSignal\(session, \{ bucket: hit\.kind, scopedName: hit\.kind === 'scoped' \? hit\.name : null, key \}\)/.test(eng) && !/noteWallSignal\(session, \{[^}]*resetsAtMs[^}]*hit\./.test(eng) && !/parseBannerResetMs/.test(eng));
  ok('WIRING: both codex exhaustion sites signal + classify through the same machine', /noteWallSignal\(session, \{ resetsAtMs: \(Number\(tripped\?\.resetsAt\)/.test(eng) && /noteWallSignal\(session, \{ resetsAtMs: resets > nowSec \? resets \* 1000 : 0, bucket: 'sevenDay', key: w2\?\.key \|\| codexQuotaKeyFor\(session\) \}\); noteTurnEnd\(session\);/.test(eng));
  ok('WIRING: turn classification = signals with no real work after the last one', /sigs\.length && workAfter <= 1/.test(eng) && /noteRecovered\?\.\(session\._webuiId, 'turn completed normally'\)/.test(eng));
  ok('WIRING: a walled turn arms from the SESSION-AWARE quotaVerdictFor (usable ⇒ near fire; blocked ⇒ blockedUntil; unknown ⇒ probe)', /quotaVerdictFor\(scope, \{ model, session \}\)/.test(eng) && !/quotaVerdictFor\(scope, \{ model \}\)/.test(eng) && /scheduleWallProbe\(session, scope, model, 0\)/.test(eng));
  ok('WIRING: the probe ladder is 0→30m→1h→2h then a LOUD give-up', /WALL_PROBE_BACKOFF = \[0, 1800000, 3600000, 7200000\]/.test(eng) && /giving up \(manual resume needed\)/.test(eng));
  ok('WIRING: a CONFIDENT blocked verdict is VERIFIED too — one throttled probe on BLOCKED entry (a lying cache armed a 2.6-day wait on an alive account, inc-mtdsoj5f)', /_wallVerifyAt\.get\(scope\) \|\| 0\) > 10 \* 60e3/.test(eng) && /_wallVerifyAt\.set\(scope, Date\.now\(\)\);\s*\n\s*scheduleWallProbe\(session, scope, model, 0\)/.test(eng));
  ok('WIRING: pool verdict = any member usable / min over members blockedUntil', /verdicts\.find\(\(x\) => x\.v\.usable === true\)/.test(eng) && /Math\.min\(\.\.\.untils\)/.test(eng));
  ok('WIRING: the pre-fire gate probes + re-verdicts and can VETO the spend', /async function beforeAutoResumeFire/.test(eng) && /if \(v\.usable === false\)/.test(eng) && /return false;/.test(eng));
  const srv8 = read('server.js');
  ok('WIRING: server.js routes beforeFire → beforeAutoResumeFire and provides the probe', /beforeFire: \(id, s\) => \{ try \{ return beforeAutoResumeFire\(id, s\); \}/.test(srv8) && /getQuotaProbe: \(\) => \{ try \{ return usage\.refreshViaCliPanel; \}/.test(srv8));
  const ss8 = read('src/server/stdout/claude-stream-json.js') + '\n' + read('src/server/stdout/codex-events.js'); // S5: per-protocol consumer modules
  ok("WIRING: the claude result record IS the turn boundary; codex task_complete too", /if \(msg\.type === 'result'\) \{ try \{ noteTurnEnd\?\.\(session\); \} catch \{ \} \}/.test(ss8) && /task_complete'\) \{\s*\n\s*try \{ noteTurnEnd\?\.\(session\); \} catch \{\}/.test(ss8));

  // the pre-fire VETO, functionally (async gate through a real create())
  const dV = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ar-veto-'));
  const sentV = [];
  const sessV = new Map();
  let gateResult = false;
  const arV = create({
    dataDir: dV, activeSessions: sessV, serverSetting: () => true,
    sendToSession: (id, s2, text) => { sentV.push(text); return true; },
    beforeFire: async () => gateResult,
  });
  const sV = sess(); sessV.set('wV', sV);
  arV.armIfEnabled('wV', sV, Date.now() + 60000, 'fiveHour limit');
  arV._armed.get('wV').resetsAt = Date.now() - GRACE_MS - 1000; // backdate → due now
  arV.tick(Date.now());
  await new Promise((r) => setTimeout(r, 30));
  ok('an async beforeFire VETO (false) blocks the spend', sentV.length === 0 && sV._arFiring === false);
  gateResult = true;
  arV.tick(Date.now());
  await new Promise((r) => setTimeout(r, 30));
  ok('…and a true gate delivers the continue', sentV.length === 1 && sentV[0] === CONTINUE_PROMPT);
}


// ── §11 WALL = GROUND TRUTH + OBSERVED-ORG AWARE EVALUATION (B-2c9b, owner-
// approved plan A+B 2026-09-05). Three same-day production occurrences: a
// walled turn's verdict read the POOL scope and said "usable via <linked
// member>" off the linked member's healthy cache, while the banner had landed
// on the org the CLI was ACTUALLY on (193 usage-reading-reattributed events
// had moved the session's readings there); the pool moved 1.5-3 min later
// when a reading arrived and in-flight subagents died in the gap. Functional:
// a REAL AccountManager pool (real symlinks + per-session links), the REAL
// engine, the REAL auto-resume module, a fake OTel truth source. Fixtures are
// shaped from that journal: member caches read healthy, the wall says no.
{
  const { AccountManager } = require(path.join(REPO, 'src/accounts.js'));
  const engMod = require(path.join(REPO, 'src/server/usage-pool-engine.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-wall-'));
  const dataDir = path.join(root, 'data');
  const am = new AccountManager({ dataDir });
  if (!am.poolSupported()) { console.log('  · SKIP §11 (pooled accounts are unsupported on ' + process.platform + ')'); }
  else {
    const login = (id) => fs.writeFileSync(path.join(am.subDir(id), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-' + id, refreshToken: 'r', expiresAt: Date.now() + 36e5, subscriptionType: 'max' } }), { mode: 0o600 });
    const A = am.createSubscription({ name: 'Fish Max' }).id; login(A);
    const B = am.createSubscription({ name: 'ProblemFactory Max' }).id; login(B);
    const C = am.createSubscription({ name: 'Personal Max' }).id; login(C);
    const P = am.createPool({ name: 'Pool' }).id;
    am.setPoolTarget(P, B); // the pool DEFAULT sits on a healthy member — the per-session links are what the incident is about
    am.updatePool(P, { auto: true, hot: true });
    const cacheDir = path.join(dataDir, 'usage-cache'); fs.mkdirSync(cacheDir, { recursive: true });
    const nowS = Math.floor(Date.now() / 1000), H = 3600;
    const RESET_5H = nowS + 3 * H, RESET_7D = nowS + 3 * 86400;
    const healthy = (u5, u7) => ({ fetchedAt: Date.now() - 60000, source: 'cli-usage', fiveHour: { utilization: u5, resetsAt: RESET_5H }, sevenDay: { utilization: u7, resetsAt: RESET_7D } });
    const writeCache = (id, c) => fs.writeFileSync(path.join(cacheDir, id + '.json'), JSON.stringify(c));
    const readCache = (id) => JSON.parse(fs.readFileSync(path.join(cacheDir, id + '.json'), 'utf8'));
    writeCache(A, healthy(0.2, 0.3)); writeCache(B, healthy(0.1, 0.2)); writeCache(C, healthy(0.15, 0.25)); // "the cache for the LINKED member said fine"
    const sessions = new Map();
    const sent = [], notices = [], journal = [], events = [];
    const obs = new Map(); // claudeSessionId → the OTel truth stream's latest observation
    const origLog = console.log;
    // capture ONLY the engine's journal lines; the suite's own ✓ lines pass through (they quote journal text and would double-count)
    console.log = (...a) => { const s = a.join(' '); if (/^\[(wall|pool|auto-resume)\]/.test(s)) journal.push(s); else origLog(...a); };
    const prevEv = global.__vsEvent; global.__vsEvent = (n, d) => { events.push([n, d]); };
    const ar = create({ dataDir, activeSessions: sessions, serverSetting: () => true, sendToSession: (id, s2, text) => { sent.push([id, text]); return true; } });
    const app = { get() { }, post() { }, put() { }, delete() { }, use() { }, locals: {} };
    const eng = engMod.create({
      app, rootDir: root, USAGE_CACHE_DIR: cacheDir, activeSessions: sessions,
      wss: { clients: new Set() }, WS_OPEN: 1, broadcastToSession() { }, serverNotice: (k, t) => notices.push(t),
      serverSetting: () => undefined, getAccounts: () => am, getHosts: () => null, getUsageHistory: () => null,
      recordUsageAttribution() { }, adapterRegistry: { get() { return null; } },
      getAutoResume: () => ar, getOtelIngest: () => ({ observedOrgFor: (cid) => obs.get(cid) || null }), getQuotaProbe: () => null,
    });
    const mkSess = (wid, cid, member) => {
      const s = { backend: 'claude', mode: 'chat', host: null, _webuiId: wid, claudeSessionId: cid, _accountId: P, _autoResume: true, _servedModel: 'claude-fable-5', _servedModelAt: Date.now(), pty: { write() { } }, name: wid };
      sessions.set(wid, s); am.ensureSessionPoolLink(P, wid, member); return s;
    };
    try {
      // (a) the misattribution guard: ONE wall on the linked member, no OTel observation anywhere → held
      const s1 = mkSess('w1', 'cid-1', A);
      eng.noteWallSignal(s1, { resetsAtMs: RESET_5H * 1000, bucket: 'fiveHour', key: A });
      eng.noteTurnEnd(s1);
      ok('single unverified wall: the member cache is untouched (guard held — a single wall on an account the session is not verifiably on is not enough)', readCache(A).fiveHour.utilization === 0.2 && readCache(A).source === 'cli-usage', JSON.stringify(readCache(A)));
      ok('…the link stays put and nothing fired', am.poolCurrentFor(P, 'w1') === A && sent.length === 0);
      ok('…the session is still ARMED for the near fire (the verdict said usable)', ar.statusFor('w1').armed === true);
      ok("…and the hold is journaled + telemetered ('wall-demote-held'), never silent", journal.some((l) => /\[wall\] w1: single wall on Fish Max .*holding the demotion/.test(l)) && events.some(([n]) => n === 'wall-demote-held'), journal.join(' | '));
      // (b) a SECOND wall on the same account inside 120s → ground truth
      eng.noteWallSignal(s1, { resetsAtMs: RESET_5H * 1000, bucket: 'fiveHour', key: A });
      eng.noteTurnEnd(s1);
      const cA = readCache(A);
      ok("two walls in 120s: A.fiveHour exhausted (utilization 1, limited) with the SIGNAL's resetsAt, source 'wall', fetchedAt now", cA.fiveHour.utilization === 1 && cA.fiveHour.status === 'limited' && cA.fiveHour.resetsAt === RESET_5H && cA.source === 'wall' && Date.now() - cA.fetchedAt < 5000, JSON.stringify(cA));
      ok('…only the affected bucket (7d untouched)', cA.sevenDay.utilization === 0.3);
      ok("…journaled '[wall] demoted Fish Max 5h until <iso> (2 walls)'", journal.some((l) => /\[wall\] demoted Fish Max 5h until \d{4}-\d\d-\d\dT\S+ \(2 walls\)$/.test(l)), journal.filter((l) => /demoted/.test(l)).join(' | '));
      ok("…telemetry 'wall-demote'", events.some(([n, d]) => n === 'wall-demote' && /:5h:2-walls$/.test(d)), JSON.stringify(events.filter(([n]) => /wall/.test(n))));
      ok("…the pool moved the session's link OFF A in the SAME noteTurnEnd (no 1.5-3 minute reading lag)", am.poolCurrentFor(P, 'w1') !== A && [B, C].includes(am.poolCurrentFor(P, 'w1')), am.poolCurrentFor(P, 'w1'));
      ok("…and the hot switch's fireNow delivered the continue in that tick (armed → continued, not a 45s wait)", sent.length === 1 && sent[0][0] === 'w1' && sent[0][1] === CONTINUE_PROMPT && ar.statusFor('w1').armed === false, JSON.stringify({ sent, st: ar.statusFor('w1') }));
      ok('…the user was told (per-session switch notice)', notices.some((t) => /conversation "w1" moved to (ProblemFactory|Personal) Max/.test(t)), notices.join(' | '));
      ok('…the walled-turn log names the demoted key — the pool verdict is no longer trusted alone', journal.some((l) => /\[wall\] w1: walled turn \(scope pool-\w+, demoted sub-\w+\) → usable via (ProblemFactory|Personal) Max/.test(l)), journal.filter((l) => /walled turn/.test(l)).join(' | '));
      // (c) OBSERVED-ORG divergence: a session linked to B whose CLI the OTel truth stream sees on C
      const s3 = mkSess('w3', 'cid-3', B);
      obs.set('cid-3', { orgUuid: 'org-c', acct: C, known: true, ts: Date.now() - 30000 });
      const cm = eng.sessionCurrentMember(s3, P);
      ok('sessionCurrentMember: the observed member wins, the link is remembered, divergent', cm.id === C && cm.linkedId === B && cm.observedId === C && cm.divergent === true, JSON.stringify(cm));
      ok("…logged once: '[pool] session w3 observed on Personal Max while linked to ProblemFactory Max'", journal.filter((l) => l === '[pool] session w3 observed on Personal Max while linked to ProblemFactory Max').length === 1, journal.filter((l) => /observed on/.test(l)).join(' | '));
      eng.sessionCurrentMember(s3, P);
      ok('…and not again inside 10 minutes', journal.filter((l) => /session w3 observed on/.test(l)).length === 1);
      ok('resolveUsageKey follows the observation (live burn + probe matching attribute to C, not the link)', eng.resolveUsageKey(s3) === C && eng.usageCacheKeyFor(s3) === C);
      const v = eng.quotaVerdictFor(P, { model: 'claude-fable-5', session: s3 });
      ok('quotaVerdictFor names the OBSERVED member as current (on=C, linked=B, divergent) and judges it FIRST (via C)', v.usable === true && v.on === C && v.linked === B && v.divergent === true && v.via === 'Personal Max' && /observed on Personal Max while linked to ProblemFactory Max/.test(v.reason), JSON.stringify(v));
      ok('negative control: without a session the pool verdict has no current-member context', eng.quotaVerdictFor(P, { model: 'claude-fable-5' }).on === undefined);
      // a SINGLE wall on the observed member is ground truth (the observed-org rule, no ring needed); a key-less signal resolves the readings' way (org-verified → C)
      eng._wallRing.clear();
      eng.noteWallSignal(s3, { bucket: 'fiveHour' });
      eng.noteTurnEnd(s3);
      const cC = readCache(C);
      ok('single wall on the OBSERVED member demotes it (observed-org rule); no signal reset ⇒ the cached future reset is kept', cC.fiveHour.utilization === 1 && cC.source === 'wall' && cC.fiveHour.resetsAt === RESET_5H, JSON.stringify(cC));
      ok("…journaled as '(1 walls / observed-org)'", journal.some((l) => /\[wall\] demoted Personal Max 5h until \S+ \(1 walls \/ observed-org\)$/.test(l)), journal.filter((l) => /demoted Personal/.test(l)).join(' | '));
      ok('…B (the link, healthy) is NOT touched', readCache(B).fiveHour.utilization === 0.1 && readCache(B).source === 'cli-usage');
      ok('…the per-session pass decided FROM C (dead), re-pointed the link at B (same target — the creds-mtime bump the CLI re-reads on) and fireNow continued w3', am.poolCurrentFor(P, 'w3') === B && sent.some(([id]) => id === 'w3') && journal.some((l) => /\[pool\] per-session switch pool-\w+\/w3: sub-\w+ \(observed; linked sub-\w+\) → sub-\w+ \(re-point, same target\)/.test(l)), journal.filter((l) => /per-session switch/.test(l)).join(' | '));
      ok('…a same-target re-point raises NO user notice (journal only)', !notices.some((t) => /"w3"/.test(t)), notices.join(' | '));
      ok("…the walled-turn log carries the divergence '[on Personal Max, linked ProblemFactory Max]'", journal.some((l) => /\[wall\] w3: walled turn .*\[on Personal Max, linked ProblemFactory Max\]$/.test(l)));
      // (d) staleness: an observation older than OBSERVED_ORG_RECENT_MS speaks for nothing
      const s4 = mkSess('w4', 'cid-4', B);
      obs.set('cid-4', { orgUuid: 'org-c', acct: C, known: true, ts: Date.now() - eng.OBSERVED_ORG_RECENT_MS - 1000 });
      ok('a >10min-old observation falls back to the link (no divergence, burn attributed to the link)', eng.sessionCurrentMember(s4, P).id === B && eng.sessionCurrentMember(s4, P).divergent === false && eng.resolveUsageKey(s4) === B);
      ok('…and a single wall keyed to that stale-observed member is HELD (not verifiably on it)', (eng._wallRing.clear(), eng.demoteWalledAccount(s4, [{ key: C, bucket: 'fiveHour', at: Date.now(), resetsAtMs: 0 }]).reason === 'unverified'));
      // (e) named non-demotions
      const s5 = { backend: 'claude', mode: 'chat', host: null, _webuiId: 'w5', claudeSessionId: 'cid-5', _accountId: A, pty: { write() { } } };
      ok("a non-pooled session's walled turn returns 'not-pooled' (its own cache mark already IS the ground truth)", eng.demoteWalledAccount(s5, [{ key: A, bucket: 'fiveHour' }]).reason === 'not-pooled');
      ok("a wall on a key that is no pool member returns 'not-a-member'", eng.demoteWalledAccount(s1, [{ key: 'sub-stranger', bucket: 'fiveHour' }]).reason === 'not-a-member');
      ok('the ring counts WALLED TURNS per account: one turn with two records on the same key is ONE wall', (() => { eng._wallRing.clear(); const s6 = { _webuiId: 'w6' }; eng.noteWallSignal(s6, { key: 'sub-x', bucket: 'fiveHour' }); eng.noteWallSignal(s6, { key: 'sub-x', bucket: 'sevenDay' }); return eng.wallCount('sub-x') === 1; })());
    } finally { console.log = origLog; global.__vsEvent = prevEv; }
    // order-of-operations pins (the fix IS the order)
    const eng2 = read('src/server/usage-pool-engine.js');
    ok('PIN: onWalledTurn demotes BEFORE the verdict, and the verdict is session-aware', /function onWalledTurn\(session, sigs\) \{[\s\S]{0,700}demoteWalledAccount\(session, sigs\)[\s\S]{0,900}quotaVerdictFor\(scope, \{ model, session \}\)/.test(eng2));
    ok("PIN: the walled turn's pool evaluation runs AFTER the arm (finally) so fireNow finds the session armed", /ar\.armIfEnabled\(id, session, Date\.now\(\) \+ 45000[\s\S]{0,2000}\} finally \{[\s\S]{0,600}maybePoolAutoSwitch\(session\);\s*\n\s*\}\s*\n\}/.test(eng2));
    ok('PIN: noteTurnEnd evaluates the pool only on the NORMAL branch (the walled branch owns its own, after the arm)', /if \(sigs\.length && workAfter <= 1\) \{[\s\S]{0,600}return;\s*\n\s*\}\s*\n\s*maybePoolAutoSwitch\(session\);/.test(eng2) && !/session\._turnWallSigs = \[\]; session\._turnWorkAfterSig = 0;\s*\n\s*maybePoolAutoSwitch\(session\);/.test(eng2));
    ok("PIN: the demotion rides captureRateLimitEvent with source 'wall' (ONE write path, no twin)", /captureRateLimitEvent\(\{ cacheDir: USAGE_CACHE_DIR, key: member\.id, identityIds: usageIdentityAccountIds\(member\.id\), ev, now, source: 'wall' \}\)/.test(eng2) && /source = 'rate-limit-event' \}\)/.test(read('src/rate-limit-capture.js')));
    ok('PIN: the guard constants (≥2 walls inside a 120s ring, 10min observation recency) and the guard itself', /WALL_RING_MS = 120e3/.test(eng2) && /OBSERVED_ORG_RECENT_MS = 10 \* 60e3/.test(eng2) && /if \(walls < 2 && !observedMatch\)/.test(eng2));
    ok('PIN: the per-session pool pass decides from sessionCurrentMember (observed over linked)', /const cm = sessionCurrentMember\(s2, poolId\);\s*\n\s*const curFor = cm\.id \|\| linkCur;/.test(eng2) && /decidePoolSwitch\(\{ currentId: curFor, members, readCache: projected/.test(eng2));
    ok('PIN: resolveUsageKey is observed-aware for pooled sessions (live odometer, probe matching, derived cache keys)', /function resolveUsageKey\(session\)[\s\S]{0,800}sessionCurrentMember\(session, acct\)\.id/.test(eng2));
    ok('PIN: both probe targets (wall ladder + pre-fire gate) are the member the session is ON', (eng2.match(/sessionCurrentMember\(session, scope\)\.id : scope/g) || []).length === 2);
    ok('PIN: every wall signal carries the key its mark landed on (claude rejected + banner + all three codex sites)', /noteWallSignal\(session, \{ resetsAtMs: \(Number\(ev\.resetsAt\) \|\| 0\) \* 1000, bucket: ev\.kind, scopedName: ev\.scopedName, key \}\)/.test(eng2) && /noteWallSignal\(session, \{ bucket: hit\.kind, scopedName: hit\.kind === 'scoped' \? hit\.name : null, key \}\)/.test(eng2) && (eng2.match(/noteWallSignal\(session, \{ resetsAtMs:[^\n]*key: (w\.key|w2\?\.key \|\| codexQuotaKeyFor\(session\)|codexQuotaKeyFor\(session\)) \}\)/g) || []).length === 3);
    ok('PIN: session-schema documents the signal shape on _turnWallSigs', /_turnWallSigs:[^\n]*\{at, resetsAtMs, bucket, scopedName, key\}/.test(read('src/session-schema.js')));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { }
  }
}

// ── FUNCTIONAL export-seam check (2.369.4 — the SIXTH unstaged-wiring strike,
// and the worst: the entire wall machine sat dead in production for a day
// because the engine's return list lacked its functions; every grep pin was
// green because the SOURCE contained them. A seam is verified by CALLING it.)
{
  const engMod = require(path.join(REPO, 'src/server/usage-pool-engine.js'));
  const app = { get() { }, post() { }, put() { }, delete() { }, use() { }, locals: {} };
  const eng = engMod.create({
    app, rootDir: os.tmpdir(), USAGE_CACHE_DIR: path.join(os.tmpdir(), 'vs-uc-seam'), activeSessions: new Map(),
    wss: { clients: new Set() }, WS_OPEN: 1, broadcastToSession() { }, serverNotice() { },
    serverSetting() { return undefined; }, getAccounts() { return null; }, getHosts() { return null; },
    getUsageHistory() { return null; }, recordUsageAttribution() { }, adapterRegistry: { get() { return null; } },
  });
  ok('the engine INSTANCE exports the whole wall machine (functional call-seam check, never a source grep)',
    ['noteTurnEnd', 'noteWallSignal', 'beforeAutoResumeFire', 'quotaVerdictFor', 'noteSessionProduced'].every((k) => typeof eng[k] === 'function'));
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
