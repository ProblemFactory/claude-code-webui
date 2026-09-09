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
const { windowOpened, laneOf } = require(path.join(REPO, 'src/auto-resume-signal.js')); // PURE: does a reading say the wall is gone?
const cq = require(path.join(REPO, 'src/harnesses/codex-quota.js'));                    // the harness's own normalizer + classifier

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
  // A FAR RESET IS A WATCH, NOT A REFUSAL (2026-09-08, the codex incident: its
  // reset was SIX DAYS out, so refusing outright meant nothing was watching
  // when the window reopened 32 h later). "Refuse to squat" is preserved as
  // the thing that matters — no TIMED continue is ever scheduled — while the
  // fresh-window edge can still keep the promise on positive evidence.
  const far = a.ar.armIfEnabled('s1', a.sessions.get('s1'), Date.now() + MAX_WAIT_MS + 60000, 'weekly');
  ok('a reset a week out ⇒ a WATCH (armed, but no timed continue is promised)', !!far && far.watch === true);
  ok('…and the status says so, so the chip does not promise a time', a.ar.statusFor('s1').watch === true && a.ar.statusFor('s1').armed === true);
  ok('…and the TIMER never fires it, however long we wait (it still refuses to squat)', a.ar.tick(Date.now() + MAX_WAIT_MS) === 0 && a.sent.length === 0);
  ok('…and the far-reset notice says the timed continue will NOT happen but recovery still will', a.notes.some((n) => /不会按时间自动续跑/.test(n.text) && /提前恢复/.test(n.text)));
  a.ar.forget('s1');
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
  {
    // …and the round-4 classification changes NOTHING about the disarm: a
    // caller that has no proof of work still drops the wait (a fire onto a
    // session that is no longer waiting is the wasted billed turn this call
    // has always existed to prevent). Only the loop breaker reads `worked`.
    const a = mk({ dflt: true });
    a.sessions.set('s1', sess());
    const resets = T0 + 60000;
    a.ar.armIfEnabled('s1', a.sessions.get('s1'), resets, '5h');
    a.ar.noteRecovered('s1', 'fresh non-rejected reading', { worked: false });
    ok('disarmed by: a caller that classifies itself as NOT work (worked:false)', a.ar.statusFor('s1').armed === false && a.ar.tick(resets + 600000) === 0 && a.sent.length === 0);
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
  // …and so do the facts a WATCH is useless without (2026-09-08): which wall it
  // is waiting on, and that it promises no time. A watch can be days long — the
  // incident's was six — so a wait that came back lane-blind after a deploy
  // could never be opened by the reading that finally arrives.
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ar-w-'));
  const c = mk({ dflt: true, dir: d2 });
  c.sessions.set('s1', sess({ backend: 'codex' }));
  c.ar.armIfEnabled('s1', c.sessions.get('s1'), Date.now() + MAX_WAIT_MS + 6 * 86400000, 'weekly', { lane: 'codex', bucket: 'sevenDay' });
  const e = mk({ dflt: true, dir: d2 });
  e.sessions.set('s1', sess({ backend: 'codex' }));
  const st2 = e.ar.statusFor('s1');
  ok('a WATCH survives a restart with its wall and its no-timer promise intact', st2.armed === true && st2.watch === true && st2.lane === 'codex' && st2.bucket === 'sevenDay', JSON.stringify(st2));
  ok('…and the fresh window still opens it after the restart', e.ar.noteQuotaReading('s1', { limitId: 'codex', sevenDay: { utilization: 0, resetsAt: Math.floor(Date.now() / 1000) + 700000 } }, 'reading').open === true && e.sent.length === 1);
  fs.rmSync(d2, { recursive: true, force: true });
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
  // round 4: it disarms, and it says it is NOT proof of work — a passive
  // reading may not clear the loop breaker (the full classification table for
  // every noteRecovered caller is pinned in test-auto-resume-loop §5)
  // ONE READING EDGE FOR EVERY HARNESS (2026-09-08). The round-4
  // classification is unchanged and now lives in the shared function: an
  // un-armed session's wait is dropped with worked:false (a passive reading is
  // no proof this conversation produced anything), and an ARMED one is asked
  // whether the reading says the wall is GONE. Both producers route through
  // it — the claude rate_limit_event site and the codex rate_limits_updated
  // push — so no harness can grow its own answer.
  ok('the shared reading edge keeps the round-4 classification (worked:false) for an un-armed session',
    /function noteQuotaReadingForResume[\s\S]{0,900}ar\.noteRecovered\?\.\(id, why, \{ worked: false \}\)/.test(eng));
  ok('…and asks an ARMED session whether the window reopened (never a silent disarm)',
    /function noteQuotaReadingForResume[\s\S]{0,1200}ar\.noteQuotaReading\?\.\(id, snapshot, why\)/.test(eng));
  ok('claude readings route through it', /noteQuotaReadingForResume\(session, snap, 'fresh non-rejected reading'\)/.test(eng));
  ok('codex readings route through it (the ONE channel that reaches an IDLE conversation)',
    /noteQuotaReadingForResume\(session, w\.snap, 'fresh non-limited codex reading'\)/.test(eng));
  ok('…and no producer keeps a private disarm-on-reading any more (the 32h stall)',
    !/noteRecovered\?\.\([^)]*fresh non-rejected reading/.test(eng) && !/noteRecovered\?\.\([^)]*fresh non-limited codex reading/.test(eng));
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
  // 2.369.58: the instance default is read from the HARNESS's own settings
  // family (`<prefix>.outputStyle`), not the hardcoded claude key — a codex
  // spawn was otherwise handed "Concise". The value is also enum-checked
  // against the harness caps row so it can never reach a spawn.
  ok('every create path gets the instance default unless the client picked one, from ITS OWN settings family',
    wc.includes("const want = data.outputStyle || (() => { try { return serverSetting(`${prefix}.outputStyle`) || ''; } catch { return ''; } })();")
    && wc.includes("const rs = capsOf(backend).responseStyle || { closed: true, values: [] };")
    && wc.includes("return (!rs.closed || rs.values.includes(want)) ? want : '';"));
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
  {
    const body = /_applyLiveMeta\(meta\) \{([\s\S]*?)\n  \}/.exec(cv2)?.[1] || '';
    const applied = [...body.matchAll(/\bmeta\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    const unguarded = [...new Set(applied)].filter((k) => !body.includes(`'${k}' in meta`));
    ok('partial-meta refreshes do NOT reset the live style (2.368.3: wiping os to \'\' re-lit the hourglass on a running Concise session) — EVERY key _applyLiveMeta reads is carries-the-key guarded', body.startsWith('\n    if (!meta) return;') && applied.length >= 3 && unguarded.length === 0, unguarded.join(','));
  }
  // ── 2.368.4 (owner-caught on the very resume the feature was built for):
  // the CREATOR never receives an 'attached' payload — its history loads over
  // HTTP with NO meta — so the live style must ride the 'created' reply. And
  // the attach path copied the payload into meta KEY BY KEY, a hand list that
  // silently lacked outputStyle/autoResume (the whitelist-drift class, fifth
  // strike): both attach-shaped call sites must pass the payload WHOLESALE.
  // The gap between the two keys is deliberately WIDE: what this pins is that
  // BOTH facts ride the `created` payload (the creator never gets 'attached'),
  // not that they are adjacent lines. Owner ruling 9 legitimately added
  // `worktree`/`worktreePath` between them for exactly the same reason, and a
  // pin that turns "a third field joined the same list" into a red test is
  // pinning formatting instead of behaviour.
  ok("'created' carries the live style + auto-resume state (always, null = default)", /type: 'created'[\s\S]{0,1800}outputStyle: session\._outputStyle \|\| null[\s\S]{0,1600}autoResume: autoResume\?\.statusFor\?\.\(id\) \|\| null/.test(read('src/ws-create.js')));
  ok("…and (B-6b6d) the effort this spawn RESOLVED to plus WHICH FACT it came from — on a resume the client sends none", /type: 'created'[\s\S]{0,2400}effort: session\._effort \|\| null,[\s\S]{0,200}spawnOrigin: \{ model: session\._modelOrigin/.test(read('src/ws-create.js')));
  const sl2 = read('src/lib/session-lifecycle.js');
  ok('the created handler APPLIES it (HTTP history load has no meta)', /if \(spawnedEffort\) chatView\.applyStatus[\s\S]{0,600}chatView\._applyLiveMeta\?\.\(msg\)/.test(sl2)
    && /const spawnedEffort = \(msg\.effort !== undefined && msg\.effort !== null\) \? msg\.effort : sessionEffort;/.test(sl2));
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
  ok('WIRING: the banner is a BOOLEAN signal (no time extraction feeds the machine)', /noteWallSignal\(session, \{ bucket: hit\.kind, scopedName: hit\.kind === 'scoped' \? hit\.name : null, key, slot: !!slot\.slotOk \}\)/.test(eng) && !/noteWallSignal\(session, \{[^}]*resetsAtMs[^}]*hit\./.test(eng) && !/parseBannerResetMs/.test(eng));
  ok('WIRING: both codex exhaustion sites signal + classify through the same machine', /noteWallSignal\(session, \{ resetsAtMs: \(Number\(tripped\?\.resetsAt\)/.test(eng) && /noteWallSignal\(session, \{ resetsAtMs: resets > nowSec \? resets \* 1000 : 0, bucket: 'sevenDay', key: w2\?\.key \|\| codexQuotaKeyFor\(session\), lane: arSignal\.laneOf\(w2\?\.snap \|\| snap\) \}\); noteTurnEnd\(session\);/.test(eng));
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


// ── §11 WALL = GROUND TRUTH, ATTRIBUTED TO THE CREDENTIAL SLOT (B-2c9b plan
// A, re-based 2026-09-07 by owner decision ut-1c6c15a2db after the fire-loop
// incident; the loop itself lives in scripts/test-auto-resume-loop.mjs).
//
// WHAT STANDS from B-2c9b: a wall is ground truth for the account it lands on
// (readings only confirm), demotion happens on BLOCKED entry before the
// verdict reads the cache, and an account we cannot tie to this session still
// needs corroboration before we mark it dead (≥2 walled turns in 120s, or it
// IS the session's OTel-observed org).
//
// WHAT WAS REFUTED (recorded, not deleted): plan B's rule that the
// OTel-OBSERVED org overrides the link for BLOCKING decisions. The premise was
// "a live CLI holds its old token, so the observation names what it is
// burning". The owner's post-mortem corrected it: organization.id on an
// api_request is the identity the CLI cached in its config dir at SPAWN, and
// the credential file itself IS re-read (that is what the re-point's mtime
// bump exists for). Under the old rule every rejection was recorded against
// the spawn-time org while the linked member — whose credentials the process
// actually reads — stayed "healthy" forever; 130 continues followed.
// So BLOCKING now reads sessionBillingMember (the link, token-slot validated)
// and the session's own validated slot is authority for its OWN wall with no
// corroboration needed. (2026-09-07 SECOND HALF: VALUES moved too. B-b3cd's
// "a utilization number describes whatever token produced it" is still true —
// the refuted step was believing organization.id NAMES that token. So
// resolveUsageKey / readingSlotFor resolve the credential slot as well, and
// sessionReadingMember no longer exists.)
//
// Functional: a REAL AccountManager pool (real symlinks + per-session links),
// the REAL engine, the REAL auto-resume module, a fake OTel truth source.
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
    const ar = create({ dataDir, activeSessions: sessions, serverSetting: () => true, sendToSession: (id, s2, text) => { sent.push([id, text]); return true; }, fireIdentity: (id, s2) => { try { return eng.fireIdentityFor(s2); } catch { return null; } } });
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
      // (a) THE MISATTRIBUTION GUARD, on the account it still protects: a wall
      // keyed to a member that is NOT this session's credential slot, with no
      // observation to corroborate it → HELD.
      const s1 = mkSess('w1', 'cid-1', A);
      eng.noteWallSignal(s1, { resetsAtMs: RESET_5H * 1000, bucket: 'fiveHour', key: C }); // C is not this session's slot (its link is A)
      eng.noteTurnEnd(s1);
      ok('single wall on an account that is NOT this session\'s credential slot: the cache is untouched (the 2.368.34 guard is intact)', readCache(C).fiveHour.utilization === 0.15 && readCache(C).source === 'cli-usage', JSON.stringify(readCache(C)));
      ok("…the hold is journaled + telemetered ('wall-demote-held'), never silent", journal.some((l) => /\[wall\] w1: single wall on Personal Max \(not this session's credential slot\) — holding the demotion/.test(l)) && events.some(([n]) => n === 'wall-demote-held'), journal.join(' | '));
      // (a2) …and a SECOND wall on it inside 120s still demotes (that rung stands)
      eng.noteWallSignal(s1, { resetsAtMs: RESET_5H * 1000, bucket: 'fiveHour', key: C });
      eng.noteTurnEnd(s1);
      const cC0 = readCache(C);
      ok("two walls in 120s on a non-slot account: demoted with the SIGNAL's resetsAt, source 'wall', fetchedAt now", cC0.fiveHour.utilization === 1 && cC0.fiveHour.status === 'limited' && cC0.fiveHour.resetsAt === RESET_5H && cC0.source === 'wall' && Date.now() - cC0.fetchedAt < 5000, JSON.stringify(cC0));
      ok("…journaled '(2 walls / 2-walls)' — the rung that authorised it is named", journal.some((l) => /\[wall\] demoted Personal Max 5h until \d{4}-\d\d-\d\dT\S+ \(2 walls \/ 2-walls\)$/.test(l)), journal.filter((l) => /demoted/.test(l)).join(' | '));
      ok("…telemetry 'wall-demote' carries the same rung", events.some(([n, d]) => n === 'wall-demote' && /:5h:2-walls$/.test(d)), JSON.stringify(events.filter(([n]) => /wall/.test(n))));
      // (b) THE SESSION'S OWN SLOT is authority by itself — one wall, demoted,
      // and the pool moves the link in the SAME noteTurnEnd (the B-2c9b
      // ordering: demote → verdict → arm → pool eval in `finally`).
      writeCache(C, healthy(0.15, 0.25)); // heal C; this leg is about A, w1's link
      eng._wallRing.clear(); eng._sessionWalls.clear();
      eng.noteWallSignal(s1, { resetsAtMs: RESET_5H * 1000, bucket: 'fiveHour', key: A, slot: true });
      eng.noteTurnEnd(s1);
      const cA = readCache(A);
      ok('a wall on the session\'s OWN validated credential slot is ground truth by itself (no corroboration needed — we know what the symlink points at)', cA.fiveHour.utilization === 1 && cA.fiveHour.status === 'limited' && cA.source === 'wall', JSON.stringify(cA));
      ok('…only the affected bucket (7d untouched)', cA.sevenDay.utilization === 0.3);
      ok("…journaled '(1 walls / credential slot)'", journal.some((l) => /\[wall\] demoted Fish Max 5h until \S+ \(1 walls \/ credential slot\)$/.test(l)), journal.filter((l) => /demoted Fish/.test(l)).join(' | '));
      ok("…the pool moved the session's link OFF A in the SAME noteTurnEnd (no 1.5-3 minute reading lag)", am.poolCurrentFor(P, 'w1') !== A && [B, C].includes(am.poolCurrentFor(P, 'w1')), am.poolCurrentFor(P, 'w1'));
      ok("…and the hot switch's fireNow delivered the continue in that tick (armed → continued, not a 45s wait)", sent.length === 1 && sent[0][0] === 'w1' && sent[0][1] === CONTINUE_PROMPT && ar.statusFor('w1').armed === false, JSON.stringify({ sent, st: ar.statusFor('w1') }));
      ok('…the user was told (per-session switch notice)', notices.some((t) => /conversation "w1" moved to (ProblemFactory|Personal) Max/.test(t)), notices.join(' | '));
      ok('…the walled-turn log names the demoted key — the pool verdict is no longer trusted alone', journal.some((l) => /\[wall\] w1: walled turn \(scope pool-\w+, demoted sub-\w+\) → usable via (ProblemFactory|Personal) Max/.test(l)), journal.filter((l) => /walled turn/.test(l)).join(' | '));
      // (c) OBSERVED-ORG divergence: a session linked to B whose CLI the OTel
      // stream saw on C. Since 2026-09-07 the observation decides NOTHING —
      // not blocking (2.369.66) and not values either: it names the identity
      // the CLI cached at SPAWN, so routing readings by it filed a
      // hot-switched session's numbers under the account it started on. It
      // still corroborates a wall on C and still speaks in the journal.
      const s3 = mkSess('w3', 'cid-3', B);
      obs.set('cid-3', { orgUuid: 'org-c', acct: C, known: true, ts: Date.now() - 30000 });
      ok('REFUTED AND REMOVED: sessionReadingMember is gone — there is no longer a "reading member" that differs from the billing member', typeof eng.sessionReadingMember === 'undefined');
      const rs = eng.readingSlotFor(s3);
      ok('readingSlotFor (VALUES): the validated credential slot, NOT the observation', rs.key === B && rs.slotOk === true, JSON.stringify(rs));
      ok('…and it is PINNED for the turn: a mid-turn re-point does not re-key the readings still arriving from the credentials that produced them', (() => { am.ensureSessionPoolLink(P, 'w3', C); const again = eng.readingSlotFor(s3); am.ensureSessionPoolLink(P, 'w3', B); s3._turnReadingSlot = null; return again.key === B && again.slotReason === 'turn-pinned'; })());
      const bm = eng.sessionBillingMember(s3, P);
      ok('sessionBillingMember (BLOCKING): the LINK is the answer, the observation rides along as corroboration, and the slot VALIDATED', bm.id === B && bm.linkedId === B && bm.observedId === C && bm.divergent === true && bm.slotOk === true, JSON.stringify(bm));
      ok("…logged once: '[pool] session w3 observed on Personal Max while linked to ProblemFactory Max'", journal.filter((l) => l === '[pool] session w3 observed on Personal Max while linked to ProblemFactory Max').length === 1, journal.filter((l) => /observed on/.test(l)).join(' | '));
      eng.sessionBillingMember(s3, P);
      ok('…and not again inside 10 minutes', journal.filter((l) => /session w3 observed on/.test(l)).length === 1);
      ok('resolveUsageKey follows the CREDENTIAL SLOT (live burn + probe matching + every derived cache key attribute to the link) — B-b3cd\'s routing REFUTED', eng.resolveUsageKey(s3) === B && eng.usageCacheKeyFor(s3) === B);
      ok('corroborateReading reports the divergence and returns it, but the key is the caller\'s', (() => { const c = eng.corroborateReading(s3, B, 'probe'); return c && c.agree === false && c.observed === C; })());
      ok('wallKeyFor does NOT (a rejection is a fact about the credential slot) — THE inversion this incident bought', eng.wallKeyFor(s3) === B && eng.fireIdentityFor(s3).key === B, JSON.stringify({ wall: eng.wallKeyFor(s3), fire: eng.fireIdentityFor(s3) }));
      const v = eng.quotaVerdictFor(P, { model: 'claude-fable-5', session: s3 });
      ok('quotaVerdictFor judges the BILLING member first (on=B, observed=C, divergent) and names the id it would send us to', v.usable === true && v.on === B && v.linked === B && v.observed === C && v.divergent === true && v.viaId === B && v.via === 'ProblemFactory Max' && /observed on Personal Max while linked to ProblemFactory Max/.test(v.reason), JSON.stringify(v));
      ok('negative control: without a session the pool verdict has no current-member context', eng.quotaVerdictFor(P, { model: 'claude-fable-5' }).on === undefined);
      // a SINGLE wall on the observed member is still corroborated by the
      // observation (that rung stands) — but it is no longer the session's
      // blocking identity, so the pool does not "switch" to where it already is
      eng._wallRing.clear(); eng._sessionWalls.clear();
      eng.noteWallSignal(s3, { bucket: 'fiveHour', key: C });
      eng.noteTurnEnd(s3);
      const cC = readCache(C);
      ok('single wall on the OBSERVED member still demotes it (observed-org rung); no signal reset ⇒ the cached future reset is kept', cC.fiveHour.utilization === 1 && cC.source === 'wall' && cC.fiveHour.resetsAt === RESET_5H, JSON.stringify(cC));
      ok("…journaled as '(1 walls / observed-org)'", journal.some((l) => /\[wall\] demoted Personal Max 5h until \S+ \(1 walls \/ observed-org\)$/.test(l)), journal.filter((l) => /demoted Personal/.test(l)).join(' | '));
      ok('…B (the link, healthy) is NOT touched', readCache(B).fiveHour.utilization === 0.1 && readCache(B).source === 'cli-usage');
      ok('REFUTED AND REMOVED: the per-session pass no longer "switches" a session to the member it is already linked to (740 such re-points in the incident journal, each followed by another billed continue)', !journal.some((l) => /re-point, same target/.test(l)), journal.filter((l) => /per-session switch/.test(l)).join(' | '));
      ok("…the walled-turn log carries BOTH facts, honestly labelled", journal.some((l) => /\[wall\] w3: walled turn .*\[billing ProblemFactory Max, OTel observed Personal Max\]$/.test(l)), journal.filter((l) => /w3: walled turn/.test(l)).join(' | '));
      // (d) staleness: an observation older than OBSERVED_ORG_RECENT_MS speaks for nothing
      const s4 = mkSess('w4', 'cid-4', B);
      obs.set('cid-4', { orgUuid: 'org-c', acct: C, known: true, ts: Date.now() - eng.OBSERVED_ORG_RECENT_MS - 1000 });
      ok('a >10min-old observation speaks for nothing (no divergence logged, everything on the link)', eng.sessionBillingMember(s4, P).divergent === false && eng.resolveUsageKey(s4) === B && eng.sessionBillingMember(s4, P).id === B && eng.corroborateReading(s4, B, 'probe') === null);
      ok('…and a single wall keyed to that stale-observed member is HELD (not this session\'s slot, not verifiably observed)', (eng._wallRing.clear(), eng._sessionWalls.delete('w4'), eng.demoteWalledAccount(s4, [{ key: C, bucket: 'fiveHour', at: Date.now(), resetsAtMs: 0 }]).reason === 'unverified'));
      // (e) named non-demotions
      const s5 = { backend: 'claude', mode: 'chat', host: null, _webuiId: 'w5', claudeSessionId: 'cid-5', _accountId: A, pty: { write() { } } };
      ok("a non-pooled session's walled turn returns 'not-pooled' (its own cache mark already IS the ground truth)", eng.demoteWalledAccount(s5, [{ key: A, bucket: 'fiveHour' }]).reason === 'not-pooled');
      ok("a wall on a key that is no pool member returns 'not-a-member'", eng.demoteWalledAccount(s1, [{ key: 'sub-stranger', bucket: 'fiveHour' }]).reason === 'not-a-member');
      ok('the ring counts WALLED TURNS per account: one turn with two records on the same key is ONE wall', (() => { eng._wallRing.clear(); const s6 = { _webuiId: 'w6' }; eng.noteWallSignal(s6, { key: 'sub-x', bucket: 'fiveHour' }); eng.noteWallSignal(s6, { key: 'sub-x', bucket: 'sevenDay' }); return eng.wallCount('sub-x') === 1; })());
      ok('a member that walled a session is remembered per SESSION (the verdict + the next target choice read it), never pool-wide — and a HELD demotion still records it, because "it rejected me" is true either way', eng.sessionWalledMembers('w3').has(C) && !eng.sessionWalledMembers('w3').has(B) && eng.sessionWalledMembers('never-walled').size === 0, JSON.stringify([...eng.sessionWalledMembers('w3')]));
    } finally { console.log = origLog; global.__vsEvent = prevEv; }
    // order-of-operations pins (the fix IS the order)
    const eng2 = read('src/server/usage-pool-engine.js');
    ok('PIN: onWalledTurn demotes BEFORE the verdict, and the verdict is session-aware', /function onWalledTurn\(session, sigs\) \{[\s\S]{0,900}demoteWalledAccount\(session, sigs\)[\s\S]{0,900}quotaVerdictFor\(scope, \{ model, session \}\)/.test(eng2));
    ok("PIN: the walled turn's pool evaluation runs AFTER the arm (finally) so fireNow finds the session armed", /ar\.armIfEnabled\(id, session, Date\.now\(\) \+ 45000[\s\S]{0,2000}\} finally \{[\s\S]{0,700}maybePoolAutoSwitch\(session\);\s*\n\s*\}\s*\n\}/.test(eng2));
    ok('PIN: noteTurnEnd evaluates the pool only on the NORMAL branch (the walled branch owns its own, after the arm)', /if \(sigs\.length && workAfter <= 1\) \{[\s\S]{0,600}return;\s*\n\s*\}\s*\n\s*maybePoolAutoSwitch\(session\);/.test(eng2) && !/session\._turnWallSigs = \[\]; session\._turnWorkAfterSig = 0;\s*\n\s*maybePoolAutoSwitch\(session\);/.test(eng2));
    ok("PIN: the demotion rides captureRateLimitEvent with source 'wall' (ONE write path, no twin)", /captureRateLimitEvent\(\{ cacheDir: USAGE_CACHE_DIR, key: member\.id, identityIds: usageIdentityAccountIds\(member\.id\), ev, now, source: 'wall' \}\)/.test(eng2) && /source = 'rate-limit-event', corroborated = undefined \}\)/.test(read('src/rate-limit-capture.js')));
    ok('PIN: the guard constants (≥2 walls inside a 120s ring, 10min observation recency, 10min session-wall memory) and the ladder itself', /WALL_RING_MS = 120e3/.test(eng2) && /OBSERVED_ORG_RECENT_MS = 10 \* 60e3/.test(eng2) && /SESSION_WALL_MS = 10 \* 60e3/.test(eng2) && /if \(!slotMatch && walls < 2 && !observedMatch\)/.test(eng2));
    ok('PIN: the per-session pool pass decides from sessionBillingMember (the credential slot), not from the observation', /const cm = sessionBillingMember\(s2, poolId\);\s*\n\s*const curFor = cm\.id \|\| linkCur;/.test(eng2) && /decidePoolSwitch\(\{ currentId: curFor, members, readCache: projected/.test(eng2));
    ok('PIN: resolveUsageKey resolves the CREDENTIAL SLOT for pooled sessions (live odometer, probe matching, derived cache keys) — the observation routes nothing', /function resolveUsageKey\(session\)[\s\S]{0,1200}sessionBillingMember\(session, acct\)\.id/.test(eng2) && !/sessionReadingMember/.test(eng2.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')));
    ok('PIN: both probe targets (wall ladder + pre-fire gate) are the member whose credentials the CLI reads', (eng2.match(/sessionBillingMember\(session, scope\)\.id : scope/g) || []).length === 2);
    ok('PIN: every wall signal carries the key its mark landed on (claude rejected + banner + all three codex sites)', /noteWallSignal\(session, \{ resetsAtMs: \(Number\(ev\.resetsAt\) \|\| 0\) \* 1000, bucket: ev\.kind, scopedName: ev\.scopedName, key, slot: !!slot\?\.slotOk \}\)/.test(eng2) && /noteWallSignal\(session, \{ bucket: hit\.kind, scopedName: hit\.kind === 'scoped' \? hit\.name : null, key, slot: !!slot\.slotOk \}\)/.test(eng2) && (eng2.match(/noteWallSignal\(session, \{ resetsAtMs:[^\n]*key: (w\.key|w2\?\.key \|\| codexQuotaKeyFor\(session\)|codexQuotaKeyFor\(session\))(?:, lane: [^}]+)? \}\)/g) || []).length === 3);
    // …AND ITS LANE (2026-09-08): the armed wait carries which of the harness's
    // limit windows it is waiting on, so a reading about a SIBLING lane can
    // never be read as "the wall is gone". Every CODEX wall site states it
    // (that harness reports more than one lane per login); claude states none,
    // which is the honest answer for a harness with a single lane.
    ok('PIN: every codex wall signal also carries its LANE (the sibling-lane false positive)',
      (eng2.match(/noteWallSignal\(session, \{[^\n]*lane: /g) || []).length === 3);
    ok('PIN: session-schema documents the signal shape on _turnWallSigs', /_turnWallSigs:[^\n]*\{at, resetsAtMs, bucket, scopedName, key, slot\}/.test(read('src/session-schema.js')));
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

// ── 12a. THE EDGE'S OWN CEILING (r2) — scaffolding ─────────────────────────
// A world small enough to run FOUR SIMULATED HOURS of readings: the real
// src/server/auto-resume.js, a stub of the harness's resume verb, and a clock
// we own. The engine is deliberately NOT in this world — the finding is about
// auto-resume's own ceiling on the fresh-window edge, and driving the real
// producer at 30 s intervals for four hours is not something a suite can do in
// wall-clock time. The producer-driven leg is (a) above; this one measures the
// RATE the producer's readings can authorise.
//
// PATCHED COPIES live beside the real module (a sibling, or its relative
// requires do not resolve), are unlinked on exit, and are swept at start —
// only for PIDs that are GONE, because this suite can legitimately run twice
// in one worktree, and a dirty tree is what the release gate REFUSES on.
const AR_PATH = path.join(REPO, 'src/server/auto-resume.js');
const AR_SRC0 = read('src/server/auto-resume.js');
const { FIRE_MAX_IMMEDIATE, EDGE_HOLD_MS } = require(AR_PATH);
const arMutants = [];
process.on('exit', () => { for (const f of arMutants) { try { fs.unlinkSync(f); } catch { } } });
try {
  for (const f of fs.readdirSync(path.join(REPO, 'src/server'))) {
    const m = /^vs-aredge-mut-(\d+)[-.]/.exec(f);
    if (!m || Number(m[1]) === process.pid) continue;
    try { process.kill(Number(m[1]), 0); continue; } catch (e) { if (e.code === 'EPERM') continue; }
    try { fs.unlinkSync(path.join(REPO, 'src/server', f)); } catch { }
  }
} catch { }
let arMutN = 0;
// THE TWO ROUND-1 SHAPES, named once and used by the controls below.
// EDIT_NO_EDGE_GUARD is the money half (every healthy reading re-enters
// fireNow); EDIT_OPTIMISTIC_LOG is the journal half (the line is written
// before the attempt, so it describes a continue that mostly never happened).
const EDIT_NO_EDGE_GUARD = [
  "    if (r0 && r0.edgeSpent && r0.edgeSpent === wall) return { ...v, open: false, why: 'already-refuted', wallOpen: true, fired: false };",
  '    // PRE-FIX: no edge-spent guard — every healthy reading re-enters fireNow'];
// THE FIRE CALL, verbatim, as the anchor both journal controls rewrite around.
const EDGE_FIRE_CALL = "    const head = `${a.watch ? 'watched' : 'armed'} window reopened (${why})`;\n    const fired = fireNow(id, head, { via: 'reading', wall });";
const EDIT_OPTIMISTIC_LOG = [
  EDGE_FIRE_CALL,
  "    const head = `${a.watch ? 'watched' : 'armed'} window reopened (${why})`;\n    log(`[auto-resume] ${id}: ${head} — continuing now`); // PRE-FIX (round 1): said before the attempt, once per reading\n    const fired = fireNow(id, head, { via: 'reading', wall });"];
// ── THE ROUND-3 SHAPES ─────────────────────────────────────────────────────
// EDIT_R2_JOURNAL is round 2 as SHIPPED: the success line is written by the
// CALLER from `attemptFire`'s return value — which is `true` for a gate that
// is merely IN FLIGHT, and the production gate is always a Promise
// (server.js → `async function beforeAutoResumeFire`). EDIT_NO_EDGE_HOLD is
// the other half: a veto stamped nothing, so the next push re-entered the gate.
const EDIT_R2_JOURNAL = [
  EDGE_FIRE_CALL,
  "    const head = `[auto-resume] ${id}: ${a.watch ? 'watched' : 'armed'} window reopened (${why})`;\n    const fired = fireNow(id, 'the usage window reopened', { via: 'reading', wall });\n    if (fired) log(`${head} — continued now`); // ROUND 2: read from a return value that does not know yet"];
const EDIT_NO_EDGE_HOLD = [
  "    if (r0 && r0.edgeHeld && r0.edgeHeld.wall === wall && Date.now() < r0.edgeHeld.until) {\n      return { ...v, open: false, why: 'gate-held', wallOpen: true, fired: false };\n    }",
  '    // PRE-FIX (r2): a gate veto stamps nothing, so the next push re-enters the gate'];
// …and the THIRD shape: this fix's own DRAFT, which stamped the reading's one
// shot when the CLI's rejection was REPORTED instead of when the continue was
// DELIVERED. It is indistinguishable from the shipped rule while the caller
// reports every outcome — and it is the whole loop again when one does not.
const EDIT_SPEND_ON_REJECTION = [
  ["    if (origin && origin.via === 'reading' && origin.wall) r.edgeSpent = origin.wall;\n    r.last = { key: key || null, at: now, kind };",
    "    r.last = { key: key || null, at: now, kind, via: (origin && origin.via) || null, wall: (origin && origin.wall) || null };"],
  ['    if (!r.last) return false;         // the rejection did not answer a fire of ours\n    const key = r.last.key || null;',
    "    if (!r.last) return false;\n    const key = r.last.key || null;\n    if (r.last.via === 'reading' && r.last.wall) r.edgeSpent = r.last.wall; // DRAFT: stamped on the report, not the spend"]];
/** A patched copy of auto-resume.js. Every replacement is counted and the count
 *  is asserted by the caller — an unpatched "control" is not a control. */
function mutantAr(edits) {
  let src = AR_SRC0, hits = 0;
  for (const [from, to] of edits) {
    if (!src.includes(from)) return { err: 'needle missing: ' + from.slice(0, 90), hits };
    src = src.split(from).join(to); hits++;
  }
  const f = path.join(REPO, 'src/server/vs-aredge-mut-' + process.pid + '-' + (++arMutN) + '.js');
  fs.writeFileSync(f, src); arMutants.push(f);
  return { mod: require(f), hits };
}
/** The incident's shape, on a clock we advance: a WATCH whose reset is six days
 *  out, a lane that keeps reading HEALTHY, and a CLI that answers every
 *  continue with another limit rejection (`noteFireOutcome(id,false)`) after
 *  which the engine's walled-turn path re-arms — verbatim what
 *  usage-pool-engine does around `noteWallSignal`.
 *  `rotateWall` re-arms onto a DIFFERENT wall each time (model-scoped weekly
 *  caps: one identity, several windows), which is the shape the per-wall guard
 *  deliberately says nothing about — there the loop breaker is the belt. */
/** `gate` is the PRE-FIRE GATE, and its SHAPE is part of the finding (r3):
 *  production hands an `async` function (server.js → beforeAutoResumeFire), so
 *  `beforeFire` always returns a Promise and `attemptFire` returns before the
 *  outcome exists. `null` = no gate at all, which is what every round-2 leg
 *  ran with — and why the synchronous path was the only one they measured.
 *  `veto`/`allow` are the async production shape; a function is called with
 *  (readingIndex) and may change its mind. */
function mkEdgeWorld({ arModule = null, rotateWall = false, streaming = false, reportOutcome = true, gate = null } = {}) {
  const mod = arModule || require(AR_PATH);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-aredge-'));
  const sessions = new Map(), sent = [], journal = [];
  const realNow = Date.now;
  let NOW = realNow();
  const SID = 'sess-13-1788764799305';
  let gateCalls = 0, readIdx = 0;
  // `veto-sync` is the same veto through the SYNCHRONOUS branch: production
  // never takes it (server.js hands an `async` function), but the branch
  // exists and a source pin is not behaviour — a veto has to hold the wall on
  // BOTH paths or the one nobody exercises drifts.
  const gateFn = gate === null ? null
    : gate === 'veto-sync' ? () => { gateCalls++; return false; }
      : async () => { gateCalls++; return gate === 'veto' ? false : gate === 'allow' ? true : !!gate(readIdx); };
  const ar = mod.create({
    dataDir: dir, activeSessions: sessions, serverSetting: () => true,
    sendToSession: () => true, notify: () => { }, broadcast: () => { },
    notifyDelayMs: 1e12,                                   // the delayed announcement must never fire on a fake clock
    resumeVerb: () => ({ form: 'turn-start', deliver: () => { sent.push(NOW); return true; } }),
    fireIdentity: () => ({ key: 'codex:__global__', name: 'codex login' }),
    ...(gateFn ? { beforeFire: gateFn } : {}),
    log: (l) => journal.push(l),
  });
  sessions.set(SID, { backend: 'codex', mode: 'chat', _webuiId: SID, _autoResume: true, pty: {}, _isStreaming: !!streaming });
  const FAR = NOW + 6 * 24 * 3600e3;                       // the incident's own six-days-out reset
  let wallN = 0;
  const wallOpts = () => (rotateWall
    ? { lane: 'codex', bucket: 'scoped', scopedName: 'cap-' + wallN }
    : { lane: 'codex', bucket: 'sevenDay' });
  const arm = () => ar.armIfEnabled(SID, sessions.get(SID), FAR, 'usage limit', wallOpts());
  const healthy = () => (rotateWall
    ? { limitId: 'codex', scopedWeekly: [{ name: 'cap-' + wallN, utilization: 0, resetsAt: Math.floor(NOW / 1000) + 700000 }] }
    : { limitId: 'codex', sevenDay: { utilization: 0, resetsAt: Math.floor(NOW / 1000) + 700000 } });
  return {
    ar, sent, journal, sid: SID, sessions, healthy, clock: { get: () => NOW, add: (ms) => { NOW += ms; }, install: () => { Date.now = () => NOW; }, restore: () => { Date.now = realNow; } },
    gateCalls: () => gateCalls,
    /** ASYNC since r3: with the production gate shape the continue is delivered
     *  a microtask AFTER the reading returns, so a synchronous loop would score
     *  every world as "nothing was delivered". The drain is unconditional — the
     *  no-gate legs behave identically through it, and a measurement rig that
     *  only works for one shape is how the async path went unmeasured. */
    async run({ hours = 4, stepMs = 30e3 } = {}) {
      Date.now = () => NOW;
      try {
        arm();
        const perHour = []; let base = 0, readings = 0, lastWhy = null, lastWallOpen = false;
        for (let h = 0; h < hours; h++) {
          for (let i = 0; i < 3600e3 / stepMs; i++) {
            NOW += stepMs; readings++; readIdx = readings;
            const before = sent.length;
            const v = ar.noteQuotaReading(SID, healthy(), 'fresh non-limited codex reading');
            await new Promise((r) => setImmediate(r));   // let an in-flight gate settle
            lastWhy = v.why; lastWallOpen = !!v.wallOpen;
            if (sent.length > before) {
              // the CLI rejected it again. `reportOutcome:false` is the SAME
              // world with the one thing this module cannot enforce removed:
              // a caller that re-arms the wall without telling us how the last
              // continue went (an unclassified error enum — this feature's own
              // break (1) for eight months — or simply a future arm site).
              if (reportOutcome) ar.noteFireOutcome(SID, false, 'usage limit');
              if (rotateWall) wallN++;                        // …and the next wall is a different window
              arm();                                          // …and the engine re-arms (noteWallSignal)
            }
          }
          perHour.push(sent.length - base); base = sent.length;
        }
        return {
          perHour, total: sent.length, readings, lastWhy, lastWallOpen, gateCalls,
          armedAtEnd: ar.statusFor(SID).armed === true,
          reopenLines: journal.filter((l) => /window reopened/.test(l)).length,
          // the CLAIM "a continue happened", counted on its own: round 2 wrote
          // it from a return value that could not know yet
          continuedLines: journal.filter((l) => /— continued (now|immediately)$/.test(l)).length,
          gateRefusedLines: journal.filter((l) => /the pre-fire gate refused/.test(l)).length,
        };
      } finally { Date.now = realNow; }
    },
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } },
  };
}

// ── 12. GENERIC AUTO-RESUME: THE CODEX 32-HOUR STALL (2026-09-08) ───────────
// The incident, from this instance's own stores (read-only): codex thread
// 01a0733f… (webui sess-13-1788764799305, accountId null = the machine's codex
// login, no pool).
//   2026-09-07 13:16:40Z  99 records of `codex_error_info: usage_limit_exceeded`
//                         on the app-server's error notification; resetsAt and
//                         rateLimits both null, the reset stated only in prose
//                         ("try again at Sep 13th, 2026 8:36 PM" — which is
//                         sevenDay.resetsAt 1789356983 to the second)
//   2026-09-07 13:20:19Z  the last reading: `limitId:'codex'` sevenDay u=1.0
//   32 h of silence: data/auto-resume.json is `{armed:{},fires:{}}` and the
//   journal has ZERO [auto-resume] lines for that session, ever
//   2026-09-08 21:55:00Z  a FRESH window on the SAME lane (sevenDay 0 %, a new
//                         resetsAt) — quota available — and nothing woke it.
// THREE independent breaks, each enough on its own, all measured:
//   ① the classifier looked for `usage_limit_reached`; the wire says
//      `usageLimitExceeded` (app-server, camelCase — its own schema documents
//      the translation) / `usage_limit_exceeded` (rollout). 0 matches in this
//      instance's whole corpus, so codex NEVER armed since 2.368.20.
//   ② the wrapper's turn/completed branch read `params.error`, which does not
//      exist (the 0.153.4 schema puts it on `params.turn.error`).
//   ③ nothing anywhere could act on "the window reopened EARLY" — and the
//      reset was SIX DAYS out, so no timer could have helped either.
// Driven through the REAL engine + REAL auto-resume + a STUB of the codex
// channel (the wrapper's rpc lane), never injected verdicts.
{
  const engMod = require(path.join(REPO, 'src/server/usage-pool-engine.js'));
  const { AccountManager } = require(path.join(REPO, 'src/accounts.js'));
  const mkCodex = ({ classify = null } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-arcx-'));
    const dataDir = path.join(root, 'data');
    const am = new AccountManager({ dataDir });
    const cacheDir = path.join(dataDir, 'usage-cache'); fs.mkdirSync(cacheDir, { recursive: true });
    const sessions = new Map(); const fired = [], notes = [], journal = [];
    const ar = create({
      dataDir, activeSessions: sessions, serverSetting: () => true,
      log: (...a) => journal.push(a.join(' ')), notify: (id, s2, t) => notes.push(t),
      sendToSession: (id, s2, t) => { fired.push({ id, t, backend: s2.backend }); return true; },
      beforeFire: (id, s2) => { try { return eng.beforeAutoResumeFire(id, s2); } catch { return true; } },
      fireIdentity: (id, s2) => { try { return eng.fireIdentityFor(s2); } catch { return null; } },
    });
    const app = { get() { }, post() { }, put() { }, delete() { }, use() { }, locals: {} };
    const eng = engMod.create({
      app, rootDir: root, USAGE_CACHE_DIR: cacheDir, activeSessions: sessions,
      wss: { clients: new Set() }, WS_OPEN: 1, broadcastToSession() { }, serverNotice: () => { },
      serverSetting: () => undefined, getAccounts: () => am, getHosts: () => null, getUsageHistory: () => null,
      recordUsageAttribution() { }, adapterRegistry: { get() { return null; } },
      getAutoResume: () => ar, getOtelIngest: () => ({ observedOrgFor: () => null }), getQuotaProbe: () => null,
    });
    const SID = 'sess-13-1788764799305';
    // THE STUB OF THE CODEX CHANNEL: the wrapper's stdin verbs. `codex-read-
    // limits` is what the caps-routed pre-fire probe sends, and the wrapper
    // answers with a `rate_limits_updated` push — so the gate resolves here the
    // way it resolves in production instead of waiting out its timeout.
    const w = { root, eng, ar, sessions, SID, fired, notes, journal, lastLimits: null };
    const session = {
      backend: 'codex', mode: 'chat', host: null, _webuiId: SID, backendSessionId: '01a0733f',
      _accountId: null, _autoResume: true, name: 'van',
      pty: { write: (line) => { try { if (JSON.parse(line).type === 'codex-read-limits' && w.lastLimits) setImmediate(() => eng.recordCodexQuotaSignal(session, { type: 'rate_limits_updated', rateLimits: w.lastLimits })); } catch { } } },
    };
    sessions.set(SID, session); w.session = session;
    // the PRE-FIX classifier, reproduced from the harness's own retired regex:
    // `signalFromStream` is the ONE seam every producer goes through, so wrapping
    // it re-creates 2026-09-07's behaviour with everything else unchanged.
    if (classify === 'pre-fix') {
      const cq = require(path.join(REPO, 'src/harnesses/codex-quota.js'));
      const real = cq.signalFromStream;
      const RETIRED = /^(usage_limit_reached|quota_exceeded|usage_not_included|workspace_owner_usage_limit_reached|workspace_member_usage_limit_reached|workspace_member_credits_depleted)$/;
      cq.signalFromStream = (rec, now) => {
        const p2 = rec && rec.type === 'event_msg' ? rec.payload : rec;
        if (p2 && p2.type === 'task_failed') {
          const info = String(p2.codexErrorInfo || p2.codex_error_info || '');
          if (!info || !RETIRED.test(info)) return real({ ...rec, payload: { ...p2, codexErrorInfo: '' } }, now);
        }
        return real(rec, now);
      };
      w.restore = () => { cq.signalFromStream = real; };
    }
    return w;
  };
  const nowSec = () => Math.floor(Date.now() / 1000);
  // the records, verbatim in shape from data/session-buffers + the anchor stream
  const WALL = { type: 'task_failed', error: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 13th, 2026 8:36 PM.", codexErrorInfo: 'usageLimitExceeded', resetsAt: null, rateLimits: null };
  const spark = () => ({ type: 'rate_limits_updated', rateLimits: { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: nowSec() + 3600 }, secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: nowSec() + 600000 }, planType: 'pro', rateLimitReachedType: null } });
  const fresh = () => ({ type: 'rate_limits_updated', rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: nowSec() + 700000 }, secondary: null, planType: 'pro', rateLimitReachedType: null } });
  const stillDead = () => ({ type: 'rate_limits_updated', rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: nowSec() + 500000 }, secondary: null, planType: 'pro', rateLimitReachedType: null } });
  const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

  // (a) THE FIX, end to end
  {
    const w = mkCodex();
    w.eng.recordCodexQuotaSignal(w.session, WALL);
    const st = w.ar.statusFor(w.SID);
    ok('codex: the CLI\'s own exhaustion record ARMS the session (the enum the wire really sends)', st.armed === true, JSON.stringify(st));
    ok('…as a WATCH, because the reset is six days out (no timed continue is promised)', st.watch === true && st.resume === 'turn-start');
    ok('…anchored on the reset the CLI stated in PROSE, to the minute (the record carries no resetsAt and no rateLimits)',
      // The sentence states NO timezone and the parser resolves it in the
      // SERVER's local zone (the wrapper that printed it runs on this machine),
      // so the expectation is built in local time too — a fixed `-07:00` was
      // this box's zone, and the Actions runner (UTC) read the same sentence
      // seven hours earlier (2.369.79: the .78 fast mirror's only red).
      Math.abs(st.resetsAt - new Date(2026, 8, 13, 20, 36, 23).getTime()) < 61000, new Date(st.resetsAt).toISOString());
    ok('…and it recorded WHICH wall it is waiting on', st.lane === 'codex' && st.bucket === 'sevenDay', JSON.stringify(st));
    ok('…and no turn was spent doing it', w.fired.length === 0);

    w.lastLimits = spark().rateLimits;
    // …and the JOURNAL is measured while they arrive: a waiting codex session is
    // pushed a reading every few seconds (measured on this thread's own buffer:
    // 454 pushes in under two hours, 403 of them on the sibling lane) and a
    // WATCH can stand for days, so a line per reading would bury every line
    // that means something. One line per VERDICT, re-said at most every 10 min.
    const realLog = console.log; const engLines = [];
    console.log = (...a) => { const l = a.join(' '); if (/did not reopen the wait/.test(l)) engLines.push(l); else realLog(...a); };
    try {
      for (let i = 0; i < 5; i++) w.eng.recordCodexQuotaSignal(w.session, spark());
      await settle();
      ok('…and five sibling-lane readings journal the verdict ONCE, not five times (a watch lives for days)',
        engLines.length === 1 && /other-lane/.test(engLines[0]), JSON.stringify(engLines));
      w.eng.recordCodexQuotaSignal(w.session, stillDead());
      await settle();
      ok('…while a DIFFERENT verdict is said as soon as it changes (throttling is per verdict, never a mute)',
        engLines.length === 2 && /still-blocked/.test(engLines[1]), JSON.stringify(engLines));
    } finally { console.log = realLog; }
    ok('the SIBLING limit lane reads 0% through the whole stall and continues NOTHING (the measured codex_bengalfox interleave)',
      w.fired.length === 0 && w.ar.statusFor(w.SID).armed === true, JSON.stringify({ fired: w.fired, st: w.ar.statusFor(w.SID) }));
    ok('…and the wait still names the wall it is waiting on (a re-verdict must not downgrade it to lane-blind)',
      w.ar.statusFor(w.SID).lane === 'codex' && w.ar.statusFor(w.SID).bucket === 'sevenDay', JSON.stringify(w.ar.statusFor(w.SID)));
    // …and the MECHANISM that refused, stated directly: without the lane check
    // the very same reading reads as "the wall is gone".
    ok('…because the PURE rule says so by name, and says the opposite once the lane is dropped',
      windowOpened({ snapshot: cq.normalize(spark().rateLimits), armedLane: 'codex', armedBucket: 'sevenDay' }).why === 'other-lane'
      && windowOpened({ snapshot: cq.normalize(spark().rateLimits), armedLane: 'codex_bengalfox', armedBucket: 'sevenDay' }).open === true);
    w.eng.recordCodexQuotaSignal(w.session, stillDead());
    await settle();
    ok('…and a reading on the RIGHT lane that is still spent continues nothing either', w.fired.length === 0 && w.ar.statusFor(w.SID).armed === true);

    w.lastLimits = fresh().rateLimits;
    w.eng.recordCodexQuotaSignal(w.session, fresh());
    await settle(150);
    ok('THE 21:55Z RECORD WAKES IT: the fresh window on the armed lane is acted on', w.journal.some((l) => /window reopened/.test(l)), w.journal.filter((l) => /auto-resume/.test(l)).join(' | '));
    // the pre-fire gate re-verdicts and near-arms (the 2.369.0 pool-switch
    // recovery path, unchanged) — the TICK delivers, through the codex verb
    for (let i = 0; i < 4 && !w.fired.length; i++) {
      const a = w.ar._armed.get(w.SID); if (a) a.resetsAt = Date.now() - GRACE_MS - 1000;
      w.ar.tick(Date.now()); await settle(120);
    }
    ok('…and the continue is DELIVERED, exactly once, through the codex turn-start verb', w.fired.length === 1 && w.fired[0].backend === 'codex' && w.fired[0].t === CONTINUE_PROMPT, JSON.stringify(w.fired));
    // …ON THE REAL WIRING (r3). This leg runs the REAL engine's
    // `beforeAutoResumeFire`, which is `async`, so `attemptFire` returns before
    // the outcome exists — round 2 wrote its line from that return value and
    // measured 2 claims for this one delivery. A claim about a billed turn is
    // written by the code that billed it, so the ratio here is exactly 1:1.
    {
      const claims = w.journal.filter((l) => /— continued (now|immediately|automatically)$/.test(l)).length;
      ok('…and the journal claims exactly as many continues as were delivered (the async gate cannot be read as an outcome)',
        claims === w.fired.length, JSON.stringify({ claims, delivered: w.fired.length, lines: w.journal.filter((l) => /continued/.test(l)) }));
    }
    ok('…and the conversation was TOLD, in words that promise no clock it cannot keep', w.notes.some((t2) => /不会按时间自动续跑/.test(t2)));
    try { fs.rmSync(w.root, { recursive: true, force: true }); } catch { }
  }

  // (b) NEGATIVE CONTROL: the pre-fix classifier, through the harness's own
  // public seam — the 32-hour stall, reproduced. Nothing else changes.
  {
    const w = mkCodex({ classify: 'pre-fix' });
    try {
      w.eng.recordCodexQuotaSignal(w.session, WALL);
      ok('NEGATIVE CONTROL: with the retired enum spelling, the SAME record arms NOTHING (the 32h stall)', w.ar.statusFor(w.SID).armed === false && w.journal.filter((l) => /auto-resume/.test(l)).length === 0, JSON.stringify(w.journal));
      w.lastLimits = fresh().rateLimits;
      w.eng.recordCodexQuotaSignal(w.session, fresh());
      await settle();
      const a = w.ar._armed.get(w.SID); if (a) a.resetsAt = Date.now() - GRACE_MS - 1000;
      w.ar.tick(Date.now()); await settle();
      ok('…so the fresh window wakes nothing either, however long it waits — exactly what the journal showed', w.fired.length === 0);
    } finally { w.restore?.(); try { fs.rmSync(w.root, { recursive: true, force: true }); } catch { } }
  }

  // (c) THE TOGGLE STILL RULES, on codex as on claude
  {
    const w = mkCodex();
    w.session._autoResume = false;
    w.eng.recordCodexQuotaSignal(w.session, WALL);
    ok('a per-session OFF means codex is not armed either (the tri-state gate is harness-neutral)', w.ar.statusFor(w.SID).armed === false && w.fired.length === 0);
    try { fs.rmSync(w.root, { recursive: true, force: true }); } catch { }
  }

  // (d) THE EDGE IS SINGLE-SHOT PER WALL — r2, and the number is the point.
  // Round 1's leg here drove 8 readings and asserted `opened >= 1` plus "the
  // breaker recorded something". `opened` counts the WALL verdict, which is
  // true whether or not a turn was spent, and `r.n > 0` is true for n = 1 and
  // for n = 999 — so nothing in either tier bounded the BILLED RATE of the new
  // fire path, and a sustained loop shipped green.
  // What is actually true, measured against these modules: round 1 put no
  // per-arm limit on the edge, so every reading whose armed bucket read healthy
  // re-entered fireNow and the only ceilings left were the breaker's —
  // FIRE_MAX_IMMEDIATE per ROLLING hour, every hour, for the LIFE OF A WATCH
  // (which stands until its far reset passes: SIX DAYS in the incident).
  // The premise is reachable on this instance today and is invisible to
  // windowOpened: the exhaustion record carries `rateLimits: null` so the
  // engine SYNTHESISES `limitId:'codex'`, and if the true wall is the model
  // lane (`codex_bengalfox`, measured interleaving minute by minute) the plan
  // lane's very next push reads healthy.
  // The world below is that: a WATCH on (codex, sevenDay), the plan lane
  // reading healthy every 30 s, and the CLI answering every continue with
  // ANOTHER limit rejection — which is exactly what the engine's walled-turn
  // path reports through `noteFireOutcome(id, false)` before re-arming.
  {
    const W = mkEdgeWorld();
    const r = await W.run({ hours: 4 });
    ok('the edge is SINGLE-SHOT per wall: four simulated hours of healthy readings against a wall the CLI keeps rejecting spend exactly ONE billed continue',
      r.total === 1, JSON.stringify(r.perHour));
    ok('…and the wait is still standing (bounding the spend must not silently drop the promise — the timed path still owns the reset)',
      r.armedAtEnd === true);
    ok('…and every later reading is REFUSED BY NAME, not mistaken for "the wall is still up"',
      r.lastWhy === 'already-refuted' && r.lastWallOpen === true, JSON.stringify({ why: r.lastWhy, wallOpen: r.lastWallOpen }));
    // FINDING 3, measured on the same run: round 1 logged "continuing now" once
    // per READING, before attempting — 492 lines for 12 continues (41:1) — in
    // the exact channel this incident was diagnosed from ("ZERO [auto-resume]
    // lines for that session").
    ok('…and the journal says what HAPPENED, not what was about to be attempted (one line per real continue, never one per reading)',
      r.reopenLines <= 2 * r.total, JSON.stringify({ reopenLines: r.reopenLines, continues: r.total, readings: r.readings }));
    W.cleanup();
  }
  // (d′) NEGATIVE CONTROL — the SAME world against a patched copy of
  // src/server/auto-resume.js with ONLY the edge-spent guard removed. One
  // mechanism, one control: if this does not reproduce the loop, the assert
  // above is decoration.
  {
    const mut = mutantAr([EDIT_NO_EDGE_GUARD]);
    ok('control setup: the PRE-FIX auto-resume copy applied its one replacement', mut.hits === 1, JSON.stringify({ hits: mut.hits, err: mut.err }));
    if (mut.mod) {
      const W = mkEdgeWorld({ arModule: mut.mod });
      const r = await W.run({ hours: 4 });
      ok('NEGATIVE CONTROL (pre-fix): the identical world burns FIRE_MAX_IMMEDIATE billed continues every hour, forever — the loop this branch shipped',
        r.total >= 4 * FIRE_MAX_IMMEDIATE && r.perHour.every((n) => n === FIRE_MAX_IMMEDIATE) && r.armedAtEnd === true,
        JSON.stringify({ perHour: r.perHour, total: r.total }));
      W.cleanup();
    }
  }
  // (d‴) NEGATIVE CONTROL for finding 3 — ROUND 1's code, both halves. The
  // 41:1 journal is a JOINT consequence: the line was written once per READING
  // *and* the edge stayed re-enterable, so it is reproduced by reverting both
  // and by nothing less. (The guard-only control above deliberately does NOT
  // claim it: with the post-fire logging in place it prints ~6 lines per
  // continue, which is a different, much smaller fact.)
  {
    const mut = mutantAr([EDIT_NO_EDGE_GUARD, EDIT_OPTIMISTIC_LOG]);
    ok('control setup: the ROUND-1 auto-resume copy applied both replacements', mut.hits === 2, JSON.stringify({ hits: mut.hits, err: mut.err }));
    if (mut.mod) {
      const W = mkEdgeWorld({ arModule: mut.mod });
      const r = await W.run({ hours: 4 });
      ok('NEGATIVE CONTROL (round 1): "continuing now" is printed once per READING — 40:1 against the continues that actually happened',
        r.reopenLines >= 30 * r.total && r.reopenLines >= r.readings,
        JSON.stringify({ reopenLines: r.reopenLines, continues: r.total, readings: r.readings }));
      W.cleanup();
    }
  }
  // (d⁗) THE SHOT IS SPENT AT THE DELIVERY, NOT AT THE REJECTION REPORT.
  // Same world, one thing removed: nobody tells auto-resume how the continue
  // went. That is not a hypothetical seam — the answer only becomes an outcome
  // report if the harness's error record is CLASSIFIED as a wall, and this
  // feature's own incident is that the codex classifier matched nothing for
  // eight months; the arm seam is now generic, so the next harness's arm site
  // cannot know it owes us a report either. The bound has to be a property of
  // THIS module.
  {
    const W = mkEdgeWorld({ reportOutcome: false });
    const r = await W.run({ hours: 4 });
    ok('a caller that re-arms the same wall WITHOUT ever reporting the outcome still gets exactly ONE billed continue',
      r.total === 1 && r.armedAtEnd === true, JSON.stringify({ perHour: r.perHour, why: r.lastWhy }));
    W.cleanup();
  }
  // …and its control is THIS FIX'S OWN DRAFT (the reviewer's proposal, taken
  // literally): stamp the shot when the rejection is reported. Identical to
  // the shipped rule in (d) — which is why it needs its own control at all —
  // and round 1's loop, unchanged, the moment a caller stays silent.
  {
    const mut = mutantAr(EDIT_SPEND_ON_REJECTION);
    ok('control setup: the DRAFT auto-resume copy (spend stamped on the rejection report) applied both replacements',
      mut.hits === 2, JSON.stringify({ hits: mut.hits, err: mut.err }));
    if (mut.mod) {
      const A = mkEdgeWorld({ arModule: mut.mod, reportOutcome: true });
      const ra = await A.run({ hours: 4 });
      ok('…and it is INDISTINGUISHABLE while every outcome is reported (so the difference is the seam, not the arithmetic)',
        ra.total === 1, JSON.stringify(ra.perHour));
      A.cleanup();
      const B = mkEdgeWorld({ arModule: mut.mod, reportOutcome: false });
      const rb = await B.run({ hours: 4 });
      ok('NEGATIVE CONTROL (draft): with the report missing it is round 1 again — FIRE_MAX_IMMEDIATE billed continues every hour, forever',
        rb.total >= 4 * FIRE_MAX_IMMEDIATE && rb.perHour.every((n) => n === FIRE_MAX_IMMEDIATE),
        JSON.stringify({ perHour: rb.perHour, total: rb.total }));
      B.cleanup();
    }
  }
  // (d″) THE LOOP BREAKER IS STILL IN FRONT OF THE EDGE. The guard above is a
  // per-WALL rule, so it says nothing about a session whose wall keeps
  // CHANGING — a real shape (model-scoped weekly caps: one identity, several
  // windows, the c1206711 rule). There the second belt is what has to hold,
  // and it is the one round 1 claimed and never measured.
  {
    // The ceiling is asserted BOTH ways on purpose. Reading the constant back
    // out of the module makes the bound move with the code — the verifier's own
    // mutation (FIRE_MAX_IMMEDIATE = 999) would have satisfied a purely
    // relative assert — so the constant is ALSO pinned against a literal: it is
    // a promise about unattended spending, and a suite that lets it drift is
    // measuring nothing.
    ok('the immediate-continue budget is a SPEND PROMISE, pinned to a number a human agreed to',
      FIRE_MAX_IMMEDIATE >= 1 && FIRE_MAX_IMMEDIATE <= 5, 'FIRE_MAX_IMMEDIATE=' + FIRE_MAX_IMMEDIATE);
    const W = mkEdgeWorld({ rotateWall: true });
    const r = await W.run({ hours: 3 });
    ok('a session re-armed onto a DIFFERENT wall each time is bounded by the hourly cap, not by the edge',
      r.perHour.every((n) => n <= FIRE_MAX_IMMEDIATE) && r.total <= 3 * FIRE_MAX_IMMEDIATE, JSON.stringify(r.perHour));
    ok('…and the cap is really the thing doing it (the budget is spent, every hour)',
      r.perHour.filter((n) => n === FIRE_MAX_IMMEDIATE).length >= 2, JSON.stringify(r.perHour));
    W.cleanup();
  }
  // ── (d⁵) THE PRODUCTION GATE IS ASYNC, AND ROUND 2 READ ITS RETURN VALUE ──
  // Everything above ran with NO `beforeFire` at all, so `attemptFire` took its
  // SYNCHRONOUS path and its boolean really did mean "delivered". Production
  // never does that: server.js hands `beforeAutoResumeFire`, which is `async`,
  // so the gate is ALWAYS a Promise and `attemptFire` returns `true` — before
  // `deliver()` has run — for a gate that is merely IN FLIGHT.
  // Two consequences, both measured against round 2's committed code below:
  //   · the journal claimed a continue per READING that never happened, which
  //     is round 1's 41:1 flood back in the one channel this incident was
  //     diagnosed from
  //   · `edgeSpent` is stamped inside `deliver()`, so a VETO left the
  //     single-shot guard un-stamped and every later push re-entered the gate —
  //     a full `probeQuotaForKey` + `maybePoolAutoSwitch` per push, for the
  //     life of a watch, with nothing ever changing state
  {
    ok('the gate-veto hold is a PACING promise, pinned to a number a human agreed to',
      EDGE_HOLD_MS >= 60e3 && EDGE_HOLD_MS <= 30 * 60e3, 'EDGE_HOLD_MS=' + EDGE_HOLD_MS);
    const W = mkEdgeWorld({ gate: 'veto' });
    const r = await W.run({ hours: 4 });
    ok('a VETOING production-shaped gate spends nothing…', r.total === 0, JSON.stringify({ perHour: r.perHour, why: r.lastWhy }));
    ok('…and claims nothing: NOT ONE "continued" line for zero continues',
      r.continuedLines === 0, JSON.stringify({ continued: r.continuedLines, readings: r.readings }));
    // 4 h at 30 s = 480 readings; the hold lets exactly one ask per EDGE_HOLD_MS
    const expectAsks = Math.ceil((4 * 3600e3) / EDGE_HOLD_MS) + 1;
    ok('…and the gate is asked on OUR clock, not on the producer\'s traffic',
      r.gateCalls <= expectAsks, JSON.stringify({ gateCalls: r.gateCalls, readings: r.readings, cap: expectAsks }));
    ok('…each ask says so ONCE (a refusal nothing else reports must still be reportable)',
      r.gateRefusedLines >= 1 && r.gateRefusedLines <= r.gateCalls, JSON.stringify({ said: r.gateRefusedLines, asks: r.gateCalls }));
    ok('…and the promise is INTACT — the wait stands and the refusal is named, never "the wall is back up"',
      r.armedAtEnd === true && r.lastWhy === 'gate-held' && r.lastWallOpen === true, JSON.stringify({ armed: r.armedAtEnd, why: r.lastWhy }));
    W.cleanup();
  }
  // …and the SYNCHRONOUS veto branch holds the wall too. A rule that lives on
  // two paths must live on both of them; the async path is the one production
  // takes, which is exactly why the other one is where a drift would sit
  // unmeasured behind a source pin.
  {
    const W = mkEdgeWorld({ gate: 'veto-sync' });
    const r = await W.run({ hours: 4 });
    ok('a SYNCHRONOUS veto holds the wall on its own path (same rule, both branches)',
      r.total === 0 && r.continuedLines === 0 && r.gateCalls === (4 * 3600e3) / EDGE_HOLD_MS && r.lastWhy === 'gate-held',
      JSON.stringify({ gateCalls: r.gateCalls, why: r.lastWhy, continued: r.continuedLines }));
    W.cleanup();
  }
  // POSITIVE CONTROL: the same async shape that ALLOWS still delivers exactly
  // one continue and journals exactly one line for it. The hold must be a
  // DELAY on a disagreeing gate, never a switch that turns the edge off.
  {
    const W = mkEdgeWorld({ gate: 'allow' });
    const r = await W.run({ hours: 4 });
    ok('an ALLOWING production-shaped gate still continues the session exactly once',
      r.total === 1 && r.lastWhy === 'already-refuted', JSON.stringify({ perHour: r.perHour, gateCalls: r.gateCalls, why: r.lastWhy }));
    ok('…and the journal carries exactly ONE claim, written by the code that delivered it',
      r.continuedLines === 1, JSON.stringify({ continued: r.continuedLines, delivered: r.total }));
    W.cleanup();
  }
  // …and a gate that CHANGES ITS MIND continues the session: the hold delays
  // the re-ask by EDGE_HOLD_MS, it does not retire the wall. (Vetoes for the
  // first hour, then allows — the shape of a window that really did reopen
  // while the verdict had not caught up yet.)
  {
    const W = mkEdgeWorld({ gate: (n) => n > 120 });   // 120 readings × 30 s = the first hour
    const r = await W.run({ hours: 4 });
    ok('a gate that stops vetoing lets the wait be kept (the hold is a delay, never a retirement)',
      r.total === 1 && r.perHour[0] === 0, JSON.stringify({ perHour: r.perHour, gateCalls: r.gateCalls }));
    W.cleanup();
  }
  // (d⁵′) NEGATIVE CONTROL — ROUND 2's JOURNAL, one replacement: the caller
  // writes the line from `attemptFire`'s return value.
  {
    const mut = mutantAr([EDIT_R2_JOURNAL]);
    ok('control setup: the ROUND-2 journal copy applied its one replacement', mut.hits === 1, JSON.stringify({ hits: mut.hits, err: mut.err }));
    if (mut.mod) {
      const W = mkEdgeWorld({ arModule: mut.mod, gate: 'veto' });
      const r = await W.run({ hours: 4 });
      // ONE MECHANISM, ONE CONTROL: with the hold still in place the flood is
      // paced, but EVERY line is still a continue that never happened — which
      // is the defect. The RATE is the other mechanism's, measured below.
      ok('NEGATIVE CONTROL (round 2 journal): every gate ask journals a continue that never happened',
        r.total === 0 && r.continuedLines > 0 && r.continuedLines === r.gateCalls,
        JSON.stringify({ continued: r.continuedLines, delivered: r.total, gateCalls: r.gateCalls }));
      W.cleanup();
    }
  }
  // (d⁵″) NEGATIVE CONTROL — ROUND 2's RE-ENTRY, one replacement: a veto stamps
  // nothing, so the gate runs once per push for the life of the watch.
  {
    const mut = mutantAr([EDIT_NO_EDGE_HOLD]);
    ok('control setup: the ROUND-2 re-entry copy applied its one replacement', mut.hits === 1, JSON.stringify({ hits: mut.hits, err: mut.err }));
    if (mut.mod) {
      const W = mkEdgeWorld({ arModule: mut.mod, gate: 'veto' });
      const r = await W.run({ hours: 4 });
      ok('NEGATIVE CONTROL (round 2): a standing veto re-runs the pre-fire gate on EVERY reading',
        r.gateCalls >= r.readings, JSON.stringify({ gateCalls: r.gateCalls, readings: r.readings }));
      W.cleanup();
    }
  }
  // (d⁵‴) NEGATIVE CONTROL — ROUND 2 AS SHIPPED, both halves. The 480:0 flood
  // is a JOINT consequence, exactly like round 1's: the line was written from
  // a return value that could not know yet AND the veto stamped nothing, so
  // every push re-entered. Reproduced by reverting both and by nothing less.
  {
    const mut = mutantAr([EDIT_R2_JOURNAL, EDIT_NO_EDGE_HOLD]);
    ok('control setup: the ROUND-2 AS-SHIPPED copy applied both replacements', mut.hits === 2, JSON.stringify({ hits: mut.hits, err: mut.err }));
    if (mut.mod) {
      const W = mkEdgeWorld({ arModule: mut.mod, gate: 'veto' });
      const r = await W.run({ hours: 4 });
      ok('NEGATIVE CONTROL (round 2 as shipped): one false "continued" line PER READING, for zero continues',
        r.total === 0 && r.continuedLines >= r.readings && r.gateCalls >= r.readings,
        JSON.stringify({ continued: r.continuedLines, delivered: r.total, readings: r.readings, gateCalls: r.gateCalls }));
      W.cleanup();
    }
  }
  // (d⁵⁗) THE HOLD SURVIVES THE HOUR — `save()` prunes breaker records that
  // "can no longer refuse anything", and it is asked on every arm, fire and
  // refusal. A field the READER consults but the PRUNER does not know about is
  // deleted at the first FIRE_WINDOW_MS boundary; r2 had to teach it about
  // `edgeSpent` for the same reason, and this is that rule's second instance.
  // MEASURED (found by this suite's own cadence assert, not by reading code):
  // 27 asks over four hours instead of 24, one extra at each hour boundary.
  {
    const W = mkEdgeWorld({ gate: 'veto' });
    const r = await W.run({ hours: 4 });
    const perHold = (4 * 3600e3) / EDGE_HOLD_MS;
    ok('the gate hold is paced by ITS OWN clock across hour boundaries (the pruner knows it can still refuse)',
      r.gateCalls === perHold, JSON.stringify({ gateCalls: r.gateCalls, expected: perHold }));
    W.cleanup();
  }
  {
    const mut = mutantAr([[
      "          || (!!(r.edgeHeld && r.edgeHeld.until > now) && armed.has(k));",
      '          || false; // PRE-FIX: the pruner does not know the hold can refuse']]);
    ok('control setup: the UNPRUNED-HOLD copy applied its one replacement', mut.hits === 1, JSON.stringify({ hits: mut.hits, err: mut.err }));
    if (mut.mod) {
      const W = mkEdgeWorld({ arModule: mut.mod, gate: 'veto' });
      const r = await W.run({ hours: 4 });
      ok('NEGATIVE CONTROL: a hold the pruner does not know about is dropped at every window boundary',
        r.gateCalls > (4 * 3600e3) / EDGE_HOLD_MS, JSON.stringify({ gateCalls: r.gateCalls, expected: (4 * 3600e3) / EDGE_HOLD_MS }));
      W.cleanup();
    }
  }
  // …and the REFUSE_LOG_MS throttle on the gate line is REACHABLE — it is not
  // made dead by the hold, because the hold is per-WALL and only the READING
  // edge stamps it. The pool-switch fireNow path (`via` = null, the new-member
  // wake's own call shape) carries no wall, so a standing veto there is paced
  // by the throttle alone. A guard nothing can exercise is not a guard.
  {
    const W = mkEdgeWorld({ gate: 'veto' });
    W.clock.install();
    try {
      W.ar.armIfEnabled(W.sid, W.sessions.get(W.sid), W.clock.get() + 6 * 24 * 3600e3, 'usage limit', { lane: 'codex', bucket: 'sevenDay' });
      let asks = 0;
      for (let i = 0; i < 40; i++) {           // 40 × 30 s = 20 min of wake edges
        W.clock.add(30e3);
        W.ar.fireNow(W.sid, 'account usable again', { cause: 'member-usable' });
        await new Promise((r) => setImmediate(r));
        asks = W.gateCalls();
      }
      const said = W.journal.filter((l) => /the pre-fire gate refused/.test(l)).length;
      ok('the gate refusal THROTTLE is reachable: an un-held path asks every time and speaks once per window',
        asks >= 40 && said >= 1 && said < asks, JSON.stringify({ asks, said }));
    } finally { W.clock.restore(); }
    W.cleanup();
  }
}

// ── 13. THE FRESH-WINDOW RULE ITSELF (PURE) ────────────────────────────────
// It authorises a BILLED TURN, so every branch is stated by name here rather
// than reached only through a world. `why` is part of the contract: it is what
// the journal prints, and "we cannot tell" must never be spelled like "yes".
{
  const S = (over = {}) => ({ limitId: 'codex', sevenDay: { utilization: 0, resetsAt: Math.floor(Date.now() / 1000) + 700000 }, ...over });
  const A = { armedLane: 'codex', armedBucket: 'sevenDay' };
  ok('a fresh window on the armed lane+bucket is OPEN', windowOpened({ snapshot: S(), ...A }).open === true);
  ok('a reading with no bucket at all says nothing (no-reading)', windowOpened({ snapshot: { limitId: 'codex' }, ...A }).why === 'no-reading');
  ok('another LANE says nothing about this wall (the measured codex_bengalfox interleave)', windowOpened({ snapshot: S({ limitId: 'codex_bengalfox' }), ...A }).why === 'other-lane');
  ok('…and an UNSTATED lane against a stated one is ignorance, not a match — ignorance may not spend', windowOpened({ snapshot: S({ limitId: null }), ...A }).why === 'other-lane');
  ok('another BUCKET of the same lane says nothing either (a 7d reading is no evidence about a 5h wall)',
    windowOpened({ snapshot: S(), armedLane: 'codex', armedBucket: 'fiveHour' }).why === 'other-bucket');
  ok('a wait that does not know its own wall is never opened by a reading (the pool\'s +45s near-arm)',
    windowOpened({ snapshot: S(), armedLane: 'codex', armedBucket: null }).why === 'unknown-bucket');
  ok('the armed bucket still spent ⇒ still-blocked', windowOpened({ snapshot: S({ sevenDay: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 500000 } }), ...A }).why === 'still-blocked');
  ok('…and so is a SIBLING bucket of the same lane being spent (an identity unblocks only when ALL its dead windows have)',
    windowOpened({ snapshot: S({ fiveHour: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 900 } }), ...A }).why === 'still-blocked');
  ok('a spent bucket whose reset already PASSED is not spent (the window rolled since the reading)',
    windowOpened({ snapshot: S({ sevenDay: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) - 10 } }), ...A }).open === true);
  ok('claude states no lane, so a claude reading matches a claude wait (one lane, honestly)',
    windowOpened({ snapshot: { fiveHour: { utilization: 0.2, resetsAt: Math.floor(Date.now() / 1000) + 900 } }, armedLane: null, armedBucket: 'fiveHour' }).open === true);
  ok('a model-scoped weekly is identified by NAME (two caps are two windows)',
    windowOpened({ snapshot: { scopedWeekly: [{ name: 'Fable', utilization: 0, resetsAt: Math.floor(Date.now() / 1000) + 900 }] }, armedLane: null, armedBucket: 'scoped', armedScopedName: 'Fable' }).open === true
    && windowOpened({ snapshot: { scopedWeekly: [{ name: 'Fable', utilization: 0, resetsAt: Math.floor(Date.now() / 1000) + 900 }] }, armedLane: null, armedBucket: 'scoped', armedScopedName: 'Opus' }).why === 'other-bucket');
  // …and the CONSEQUENCE, not just the verdict: a 5h wall on a session with a
  // clean breaker, and a healthy 7d reading. Without the bucket rule this
  // fires a billed turn straight back into the wall — the rule is what makes
  // the difference visible, so the leg measures the SPEND, not the string.
  {
    const a = mk({ dflt: true });
    a.sessions.set('s1', sess());
    a.ar.armIfEnabled('s1', a.sessions.get('s1'), Date.now() + 3600e3, 'usage limit', { bucket: 'fiveHour' });
    const v7 = a.ar.noteQuotaReading('s1', { sevenDay: { utilization: 0.4, resetsAt: Math.floor(Date.now() / 1000) + 600000 } }, 'reading');
    ok('a healthy 7d reading spends NO turn on a 5h-walled session', v7.open === false && v7.fired === false && a.sent.length === 0, JSON.stringify({ v7, sent: a.sent }));
    ok('…and the wait it could not judge is still standing', a.ar.statusFor('s1').armed === true);
    const v5 = a.ar.noteQuotaReading('s1', { fiveHour: { utilization: 0.1, resetsAt: Math.floor(Date.now() / 1000) + 900 } }, 'reading');
    ok('…while the reading about the RIGHT bucket continues it, exactly once', v5.open === true && v5.fired === true && a.sent.length === 1 && a.sent[0].text === CONTINUE_PROMPT, JSON.stringify({ v5, sent: a.sent }));
    ok('…and the wait is spent (never twice on one wall)', a.ar.statusFor('s1').armed === false && a.ar.noteQuotaReading('s1', { fiveHour: { utilization: 0.1, resetsAt: Math.floor(Date.now() / 1000) + 900 } }, 'reading').why === 'not-armed' && a.sent.length === 1);
  }
  // A MONTHLY SPEND CAP IS NOT A WINDOW (r2). `spend_control_reached` is the
  // codex twin of 2.361.2's `seven_day_overage_included`: the account refuses
  // every turn while its weekly bucket reads perfectly healthy, so a
  // bucket-only rule reads "the wall is gone" and fires into a wall that has
  // no reset at all. Checked BEFORE the lane, deliberately — it is a fact
  // about the ACCOUNT, not one of its windows.
  ok('a snapshot that states a monthly spend control opens NOTHING, even with a perfectly healthy armed bucket',
    windowOpened({ snapshot: S({ spendControlReached: true }), ...A }).why === 'spend-capped');
  ok('…on the SIBLING lane too (a spend control is about the account, so it is asked before the lane)',
    windowOpened({ snapshot: S({ limitId: 'codex_bengalfox', spendControlReached: true }), ...A }).why === 'spend-capped');
  ok('…while the normal `false` the harness always sends changes nothing (the guard only ever REFUSES)',
    windowOpened({ snapshot: S({ spendControlReached: false }), ...A }).open === true
    && windowOpened({ snapshot: S({ spendControlReached: null }), ...A }).open === true);
  // NEGATIVE CONTROL FOR THE RULE WE REFUSED TO WRITE. The reviewer also
  // proposed treating `credits.hasCredits === false` as spent. MEASURED on this
  // instance and rejected: data/usage-cache/__global_codex__.json — the
  // machine's own codex login, the INCIDENT'S VERY ACCOUNT — carries
  // `{"hasCredits":false,"unlimited":false,"balance":"0"}` while serving turns
  // normally off plan quota, because a plan account simply has no credit
  // balance. Reading that as "spent" would make this edge permanently inert
  // here: the original incident, re-introduced as a guard.
  ok('a plan account with no credit balance is NOT read as spent (measured: the incident\'s own login reports hasCredits:false while serving turns)',
    windowOpened({ snapshot: S({ credits: { hasCredits: false, unlimited: false, balance: '0' } }), ...A }).open === true);
  // the LANE reader, on the two shapes the codex harness really produces
  ok('the lane comes from the harness\'s own limitId, never invented', laneOf(cq.normalize({ limitId: 'codex_bengalfox', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1 } })) === 'codex_bengalfox' && laneOf({ fiveHour: {} }) === null);
}

// ── 14. WHO IS OFFERED THE FEATURE AT ALL (the derived caps row) ───────────
{
  const reg = require(path.join(REPO, 'src/harnesses'));
  const { capsOf } = require(path.join(REPO, 'src/backend-caps.js'));
  ok('claude and codex can BOTH be armed and continued ⇒ the toggle is offered', capsOf('claude').autoResume.supported === true && capsOf('codex').autoResume.supported === true);
  ok('opencode declares the prompt verb but has NO limit signal ⇒ never armed, never offered', capsOf('opencode').autoResume.resume === 'prompt' && capsOf('opencode').autoResume.signal === false && capsOf('opencode').autoResume.supported === false);
  ok('shell has neither half', JSON.stringify(capsOf('shell').autoResume) === '{"signal":false,"resume":null,"supported":false}');
  // …and the module REFUSES to arm a harness it cannot continue, rather than
  // trusting a surface to have gated first (a promise nobody can keep).
  {
    const a = mk({ dflt: true });
    a.sessions.set('sh', sess({ backend: 'shell' }));
    ok('a shell session is never armed, whatever the caller asks for', a.ar.armIfEnabled('sh', a.sessions.get('sh'), Date.now() + 60000, 'usage limit') === null);
    a.sessions.set('oc', sess({ backend: 'opencode' }));
    ok('…while an ACP session CAN be (it has a verb) — the reason it never is in production is that nothing produces a signal for it', !!a.ar.armIfEnabled('oc', a.sessions.get('oc'), Date.now() + 60000, 'usage limit', { bucket: 'fiveHour' }));
    ok('…and its continue is delivered through the ACP prompt verb', a.ar.tick(Date.now() + 120000) === 1 && a.sent.some((x) => x.id === 'oc' && x.text === CONTINUE_PROMPT), JSON.stringify(a.sent));
  }
}

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
