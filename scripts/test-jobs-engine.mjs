#!/usr/bin/env node
// Background Work ENGINE gate (real spawns in an isolated tmp dataDir — never
// the repo's production data/). Pins: spawn→adopt-by-stamp across engine
// generations, single-engine lock refusal, verified handle-kill, until-output
// completion, rm-refuses-live, GC-never-on-live, cron notify fire.
process.env.VIBESPACE_JOBS_GRACE_MS = '1000';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JobManager } = require('../src/jobs.js');
const jobModel = require('../src/job-model.js');
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(400); } return false; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-jobs-'));
fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
fs.copyFileSync(new URL('../data/bin/job-wrapper.js', import.meta.url), path.join(dir, 'bin', 'job-wrapper.js'));
const notifications = [];
const deps = { dataDir: dir, broadcast: () => { }, notifyUser: (n) => notifications.push(n), log: () => { } };
const caller = { conversationId: 'conv-T', sessionId: 'sess-T', sessionCreatedAt: 1, groups: new Set(['T-g']) };
const owner = { conversation: { backend: 'claude', id: 'conv-T' }, sessionId: 'sess-T', sessionCreatedAt: 1, createdBy: 'agent', groupsSnapshot: ['T-g'] };

try {
  // 1. spawn + stamp
  const A = new JobManager(deps); A.init();
  ok(A.ready && !A.readOnly, 'engine A takes the lock and initializes');
  const r1 = A.create({ kind: 'task', name: 'sleeper', cmd: { argv: ['sh', '-c', 'sleep 30'] }, owner }, caller);
  ok(r1.job && !r1.error, 'task created', r1.error);
  const j1 = A.jobs.get(r1.job.id);
  ok(await until(() => A._verifyAlive(A._readStamp(j1))), 'wrapper wrote a verifiable pid+starttime+bootId stamp');

  // 2. single-engine lock: fake a FOREIGN live engine
  const decoy = spawn('sleep', ['20']);
  await sleep(200);
  const stRaw = fs.readFileSync(`/proc/${decoy.pid}/stat`, 'utf-8');
  const starttime = Number(stRaw.slice(stRaw.lastIndexOf(')') + 2).split(' ')[19]);
  fs.writeFileSync(path.join(dir, 'jobs.lock'), JSON.stringify({ pid: decoy.pid, starttime }));
  const B = new JobManager(deps); B.init();
  ok(B.readOnly === true, 'second engine against a live foreign lock goes READ-ONLY');
  ok(B.create({ kind: 'task', name: 'x', cmd: { argv: ['true'] }, owner }, caller).error, 'read-only engine refuses creates');
  decoy.kill('SIGKILL');

  // 3. adopt across an engine generation (simulated restart)
  A._save();
  fs.rmSync(path.join(dir, 'jobs.lock'), { force: true });
  const C = new JobManager(deps); C.init();
  const j1c = C.jobs.get(r1.job.id);
  ok(j1c && j1c.state === 'up' && C._verifyAlive(C._readStamp(j1c)), 'new engine ADOPTS the live task by stamp (no respawn, no kill)');

  // 4. rm refuses live; GC never touches live
  ok(C.rm(j1c).error && C.jobs.has(j1c.id), 'rm on a running job refuses with guidance');
  await C._gc();
  ok(C.jobs.has(j1c.id), 'GC never collects a record whose stamp verifies alive');

  // 5. verified stop
  C.stop(j1c);
  ok(await until(() => ['interrupted', 'failed'].includes(j1c.state)), 'stop kills the group and finalizes the run', j1c.state);
  ok((j1c.runs[j1c.runs.length - 1].cause || '') === 'interrupted', 'stop records cause=interrupted');

  // 6. until-output completion (grace shrunk via env)
  const r2 = C.create({ kind: 'task', name: 'marker', cmd: { argv: ['sh', '-c', 'echo START; echo THE_MARKER; sleep 60'] }, untilOutput: 'THE_MARKER', owner }, caller);
  const j2 = C.jobs.get(r2.job.id);
  ok(await until(() => j2.state === 'done', 30000), 'until-output marker completes the task', j2.state);
  ok(j2.runs[j2.runs.length - 1].cause === 'ok(until-output)', 'cause=ok(until-output)', j2.runs[j2.runs.length - 1].cause);

  // 7. cron notify fire (forced past nextFireAt)
  const r3 = C.create({ kind: 'cron', name: 'noti', schedule: { at: Date.now() + 3600e3 }, action: { type: 'notify', text: 'ping from cron' }, owner }, caller);
  const j3 = C.jobs.get(r3.job.id);
  j3.nextFireAt = Date.now() - 1000;
  await C._cronTick();
  // option A (2.363.1, owner decision): the user inbox is OPT-IN — a default
  // notify fire is the agent's own reminder, not a user notification
  ok(!notifications.some((n) => n.text === 'ping from cron'), 'default cron notify does NOT copy the user inbox (option A)');
  ok(j3.state === 'done', 'one-shot {at} cron goes done after firing');

  // 7b. cron spawn-task: ONE reused child across fires; routine success silent
  const r4 = C.create({ kind: 'cron', name: 'tick', schedule: { at: Date.now() + 3600e3 }, action: { type: 'spawn-task', task: { cmd: { argv: ['sh', '-c', 'exit 0'] } } }, owner }, caller);
  const j4 = C.jobs.get(r4.job.id);
  j4.nextFireAt = Date.now() - 1000; j4.schedule = { everyMs: 3600e3 }; // recurring so it can fire twice
  await C._cronTick();
  ok(await until(() => [...C.jobs.values()].some((x) => x.cronParent === j4.id && x.state === 'done'), 15000), 'first cron fire spawns and completes a child');
  const evCount = C.events.length;
  j4.nextFireAt = Date.now() - 1000;
  await C._cronTick();
  await until(() => { const k = [...C.jobs.values()].find((x) => x.cronParent === j4.id); return k && k.state === 'done' && (k.runs || []).length >= 2; }, 15000);
  const kids = [...C.jobs.values()].filter((x) => x.cronParent === j4.id);
  ok(kids.length === 1 && (kids[0].runs || []).length >= 2, 'second fire REUSES the same child (one record, two runs)', `kids=${kids.length} runs=${kids[0] && kids[0].runs.length}`);
  ok(!C.events.slice(evCount).some((e) => e.jobId === kids[0].id && /done exit=0/.test(e.what || '')), 'routine cron success emits NO event (quiet-success)');

  // 7c. owner auto-notify (2.344.0): deliver lane, stash lane, drain, toggles
  const delivered = [];
  C.d.notifyGlobal = () => true;
  C._notifyRate.clear(); // earlier phases posted for conv-T — reset the floor
  C.pendingNotifs.clear();
  C.d.deliverToConversation = async (cid, text, opts) => { delivered.push({ cid, text, opts }); return { ok: true, lane: 'message', peerName: 'peer-X' }; };
  const rn1 = C.create({ kind: 'task', name: 'notif-ok', cmd: { argv: ['sh', '-c', 'exit 1'] }, owner }, caller);
  const jn1 = C.jobs.get(rn1.job.id);
  ok(await until(() => jn1.state === 'failed' && jn1.lastNotify && jn1.lastNotify.lane === 'message' && jn1.lastNotify.ok, 15000), 'failed task messages the owner conversation (lastNotify lane=message)', JSON.stringify(jn1.lastNotify));
  ok(delivered.length === 1 && delivered[0].cid === 'conv-T' && delivered[0].text.includes(jn1.id), 'delivery targeted the owner conversation lineage id and named the job');
  // TYPED ORIGIN (2026-09-07, owner: 系统通知默认应该是steering的): every owner
  // notification says on the wire that it is a NOTIFICATION, so a busy codex
  // session steers it into the running turn instead of opening its own billed
  // turn afterwards. The ENGINE never picks the lane — the wrapper does.
  ok(delivered[0].opts && delivered[0].opts.kind === 'notification', "…and is TYPED kind:'notification' (a person's vibespace-msg is 'peer' and keeps queueing)", JSON.stringify(delivered[0].opts));
  // stash lane: delivery fails → durable per-conversation queue, drained at injection
  C.d.deliverToConversation = async () => ({ ok: false, reason: 'no live inbox' });
  C._notifyRate.clear();
  const rn2 = C.create({ kind: 'task', name: 'notif-stash', cmd: { argv: ['sh', '-c', 'exit 1'] }, owner }, caller);
  const jn2 = C.jobs.get(rn2.job.id);
  ok(await until(() => jn2.lastNotify && jn2.lastNotify.lane === 'stash', 15000), 'unreachable owner → notification stashed (lastNotify lane=stash)', JSON.stringify(jn2.lastNotify));
  C._save();
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'job-notifications.json'), 'utf-8'));
  ok(Array.isArray(persisted['conv-T']) && persisted['conv-T'].some((n) => n.jobId === jn2.id), 'stash persists to job-notifications.json keyed by conversation');
  const drained = C.drainNotifs('conv-T');
  ok(drained.length >= 1 && C.drainNotifs('conv-T').length === 0, 'drainNotifs returns the queue once and clears it');
  // toggle: job-level off → no delivery, no stash
  C.d.deliverToConversation = async () => { throw new Error('must not be called'); };
  C._notifyRate.clear();
  const rn3 = C.create({ kind: 'task', name: 'notif-off', notify: 'off', cmd: { argv: ['sh', '-c', 'exit 1'] }, owner }, caller);
  const jn3 = C.jobs.get(rn3.job.id);
  ok(await until(() => jn3.state === 'failed', 15000) && (await sleep(300), !jn3.lastNotify || jn3.lastNotify.lane === 'off'), 'notify:off job never posts (lastNotify lane=off)', JSON.stringify(jn3.lastNotify));
  // 7c-bis. THE FLOOD FLOOR + THE DRAIN ARE **ONE FRAME**, not N (2026-09-07).
  // The floor is what turns a burst into a batch: only the FIRST distinct event
  // in 30s is posted, every other one is STASHED. And the stash is drained by
  // the injection routes as a SINGLE rendered block (job-model renderNotifStash)
  // that rides the conversation's next turn — it is never handed back to the
  // delivery ladder entry by entry, which is exactly how 20 job events would
  // become 20 queued messages again.
  {
    const posts = [];
    C.d.deliverToConversation = async (cid, text, opts) => { posts.push({ cid, text, opts }); return { ok: true, lane: 'message', peerName: 'peer-X' }; };
    C._notifyRate.clear();
    C.pendingNotifs.clear();
    // a SYNTHETIC record (the jb-floor idiom above): a real spawned job would
    // also fire its own terminal notification and pollute the next phase
    const jb = { id: 'jb-burst', name: 'burst', kind: 'task', state: 'done', owner: { conversation: { id: 'conv-T' } } };
    for (const n of [1, 2, 3, 4, 5, 6]) C._notifyOwner(jb, { what: `step ${n} finished` });
    await sleep(200);
    ok(posts.length === 1 && /step 1 finished/.test(posts[0].text), `a burst of six events posts ONCE — the 30s floor holds the rest (${posts.length} posts)`, JSON.stringify(posts.map((p) => p.text.slice(0, 60))));
    const stashed = C.pendingNotifs.get('conv-T') || [];
    ok(stashed.length === 5 && stashed.every((e) => e.jobId === jb.id), `the five floored events are STASHED, not dropped (${stashed.length})`, JSON.stringify(stashed.map((e) => e.text)));
    ok(!(jb.notifyLog || []).some((e) => e.lane === 'message' && e.ok && (jb.notifyLog || []).filter((x) => x.lane === 'message').length > 1), 'the journal shows ONE socket post for the burst', JSON.stringify((jb.notifyLog || []).map((e) => e.lane)));
    const drained = C.drainNotifs('conv-T');
    ok(drained.length === 5 && C.drainNotifs('conv-T').length === 0, 'the drain hands over the whole batch AT ONCE and clears', String(drained.length));
    ok(posts.length === 1, 'draining posts NOTHING through the delivery ladder — the batch rides the next injection, it never becomes five more frames', String(posts.length));
    const block = jobModel.renderNotifStash(drained);
    const heads = (block.match(/<vibespace-jobs-missed-while-away>/g) || []).length;
    ok(heads === 1 && block.includes('step 2 finished') && block.includes('step 6 finished'), `…and it renders as ONE block carrying every entry (${heads} block(s), ${block.length}B)`, block.slice(0, 200));
    // the injection site is the ONLY consumer of that stash (a second consumer
    // that re-delivered per entry is exactly the failure this pins against)
    const ar = fs.readFileSync(new URL('../src/agent-routes.js', import.meta.url), 'utf-8');
    ok(/const drained = jm\.drainNotifs\(caller\.conversationId\);[\s\S]{0,900}?jobModel\.renderNotifStash\(drained/.test(ar) && !/for \(const [a-z] of drained\) [\s\S]{0,80}deliverToConversation/.test(ar),
      'wiring pin: the drain sites render ONE block and never re-enter the delivery ladder per entry');
  }

  // 7d. notify-ACTION crons reach the OWNER CONVERSATION too (2.361.5, the
  //     设备运维大师 hunt): the notify action used to hit only the user inbox —
  //     the agent that scheduled its own reminder was never messaged. Also
  //     pins the per-job delivery journal (owner monitoring ask).
  const delivered2 = [];
  C.d.deliverToConversation = async (cid, text) => { delivered2.push({ cid, text }); return { ok: true, lane: 'message', peerName: 'peer-X' }; };
  C._notifyRate.clear();
  const rc = C.create({ kind: 'cron', name: 'remind-me', schedule: { at: Date.now() + 3600e3 }, action: { type: 'notify', text: '提醒正文XYZ', urgency: 'low' }, owner }, caller);
  const jc = C.jobs.get(rc.job.id);
  jc.nextFireAt = Date.now() - 1000;
  await C._cronTick();
  ok(delivered2.length === 1 && delivered2[0].cid === 'conv-T' && delivered2[0].text.includes('提醒正文XYZ'), 'notify-cron fire MESSAGES the owner conversation (not just the user inbox)', JSON.stringify(delivered2));
  ok((jc.notifyLog || []).some((e) => e.lane === 'message' && e.ok) && !(jc.notifyLog || []).some((e) => e.lane === 'user-inbox'), 'default journal shows the owner lane ONLY (no user-inbox copy)', JSON.stringify(jc.notifyLog));
  // --notify-user opts the inbox copy back in (both lanes journaled)
  C._notifyRate.clear();
  const rcU = C.create({ kind: 'cron', name: 'remind-user', schedule: { at: Date.now() + 3600e3 }, action: { type: 'notify', text: '给用户的提醒ABC', urgency: 'low' }, notifyUser: true, owner }, caller);
  const jcU = C.jobs.get(rcU.job.id);
  jcU.nextFireAt = Date.now() - 1000;
  await C._cronTick();
  ok(notifications.some((n) => n.text === '给用户的提醒ABC'), '--notify-user notify-cron DOES copy the user inbox');
  ok((jcU.notifyLog || []).some((e) => e.lane === 'user-inbox' && e.ok) && (jcU.notifyLog || []).some((e) => e.lane === 'message' && e.ok), 'opt-in journal records BOTH lanes', JSON.stringify(jcU.notifyLog));

  // preview honesty
  C.d.peerReachable = () => false;
  const pv = C.notifyPreview(jn1);
  ok(pv && pv.enabled === true && pv.mode === 'resume-inject', 'notifyPreview: enabled but unreachable → resume-inject mode');
  ok(C.notifyPreview(jn3).enabled === false, 'notifyPreview: job-level off reported disabled');

  // 7d. 2.344.1 review fixes: missed-{at} is terminal-once; rate floor stashes distinct events
  const rm1 = C.create({ kind: 'cron', name: 'missed-once', schedule: { at: Date.now() + 3600e3 }, catchUp: 'none', action: { type: 'notify', text: 'x' }, owner }, caller);
  const jm1 = C.jobs.get(rm1.job.id);
  jm1.nextFireAt = Date.now() - 300_000; // pretend the server slept past it (>120s catch-up window)
  await C._cronTick();
  ok(jm1.state === 'missed' && jm1.desiredUp === false && jm1.nextFireAt === null, 'missed {at} cron parks terminally (no re-notify loop)', `${jm1.state}/${jm1.desiredUp}/${jm1.nextFireAt}`);
  const evBefore = C.events.length;
  await C._cronTick();
  ok(C.events.length === evBefore, 'second tick after missed emits NOTHING');
  C._notifyRate.set('conv-T', { ts: Date.now(), text: 'other' });
  C.pendingNotifs.clear();
  C.d.deliverToConversation = async () => { throw new Error('floored events must not hit the socket'); };
  C._notifyOwner({ id: 'jb-floor', name: 'floor-test', state: 'failed', kind: 'task', owner: { conversation: { id: 'conv-T' } } }, { what: 'failed exit=1' });
  ok((C.pendingNotifs.get('conv-T') || []).some((n) => n.jobId === 'jb-floor'), 'rate-floored DISTINCT event is stashed, not dropped');

  // 7e. subscriptions (2.345.0): a second conversation opts into a visible job
  const cids = [];
  C._notifyRate.clear(); C.pendingNotifs.clear();
  C.d.deliverToConversation = async (cid, text) => { cids.push({ cid, hasCtx: text.includes('订阅测试context') }); return { ok: true, lane: 'message' }; };
  const rs1 = C.create({ kind: 'task', name: 'sub-test', cmd: { argv: ['sh', '-c', 'exit 1'] }, context: { payload: '订阅测试context说明' }, owner }, caller);
  const js1 = C.jobs.get(rs1.job.id);
  const subCaller = { conversationId: 'conv-SUB', sessionId: 'sess-SUB', sessionCreatedAt: 2, groups: new Set(['T-g']) };
  ok(C.subscribe(js1, subCaller).ok && C.subscribe(js1, subCaller).already, 'subscribe is idempotent by conversation lineage');
  await until(() => js1.state === 'failed' && cids.length >= 2, 15000);
  ok(cids.some((c) => c.cid === 'conv-T') && cids.some((c) => c.cid === 'conv-SUB'), 'failure notifies OWNER and SUBSCRIBER conversations', JSON.stringify(cids));
  ok(cids.every((c) => c.hasCtx), 'notification text carries the {payload} context echo (E2E-caught bug pinned)');
  ok(js1.lastNotify && js1.lastNotify.lane === 'message' && C.snapshot(js1).subscribersCount === 1, 'lastNotify narrates the owner lane; snapshot counts subscribers');
  ok(C.unsubscribe(js1, subCaller).removed === 1, 'unsubscribe removes the conversation');

  // 7f. recurring cron: repeated distinct failures notify EACH time (multi-fire)
  const cronNotifs = [];
  C._notifyRate.clear();
  C.d.deliverToConversation = async (cid, text) => { cronNotifs.push(text.slice(0, 60)); return { ok: true, lane: 'message' }; };
  const rc1 = C.create({ kind: 'cron', name: 'flaky', schedule: { at: Date.now() + 3600e3 }, action: { type: 'spawn-task', task: { cmd: { argv: ['sh', '-c', 'exit 3'] } } }, owner }, caller);
  const jc1 = C.jobs.get(rc1.job.id);
  jc1.schedule = { everyMs: 3600e3 }; jc1.nextFireAt = Date.now() - 1000;
  await C._cronTick();
  await until(() => cronNotifs.length >= 1, 15000);
  C._notifyRate.clear(); // both fires produce byte-identical failure text — clear the dedupe as a 15min-apart fire would be
  jc1.nextFireAt = Date.now() - 1000;
  await C._cronTick();
  ok(await until(() => cronNotifs.length >= 2, 15000), 'a recurring cron child failing on TWO fires notifies twice (multi-fire callbacks work)', `got ${cronNotifs.length}`);

  // 7g. 2.346.0: notifyOk opts scheduled successes in; announce decouples news from exit codes; spill file
  const okNotifs = [];
  C._notifyRate.clear();
  C.d.deliverToConversation = async (cid, text) => { okNotifs.push({ cid, text }); return { ok: true, lane: 'message' }; };
  const ro1 = C.create({ kind: 'cron', name: 'verbose-ok', schedule: { at: Date.now() + 3600e3 }, action: { type: 'spawn-task', task: { cmd: { argv: ['sh', '-c', 'exit 0'] }, notifyOk: true } }, owner }, caller);
  const jo1 = C.jobs.get(ro1.job.id);
  jo1.schedule = { everyMs: 3600e3 }; jo1.nextFireAt = Date.now() - 1000;
  await C._cronTick();
  ok(await until(() => okNotifs.some((n) => n.text.includes('done')), 15000), '--notify-ok cron child SUCCESS notifies (quiet-success is default, not law)');
  const okChild = [...C.jobs.values()].find((x) => x.cronParent === jo1.id);
  ok(C.events.some((e) => e.jobId === okChild.id && /done/.test(e.what)), 'notify-ok success also emits the event (panel + injection see it)');
  C._notifyRate.clear(); okNotifs.length = 0;
  const annSub = { conversationId: 'conv-ANN', sessionId: 's', sessionCreatedAt: 3, groups: new Set(['T-g']) };
  C.subscribe(jo1, annSub);
  const ann = C.announce(okChild, '页面出现新条目: Fable 5 发布');
  ok(ann.ok && await until(() => okNotifs.length >= 2, 15000) && okNotifs.some((n) => n.cid === 'conv-T' && n.text.includes('页面出现新条目')) && okNotifs.some((n) => n.cid === 'conv-ANN'), 'announce reaches owner AND cron-parent subscribers with the custom text', JSON.stringify(okNotifs.map((n) => n.cid)));
  ok(!C.announce(okChild, '').ok, 'announce refuses empty text');
  const sp = C.spillNotifs('conv-T', [{ jobId: 'jb-x', jobName: 'n', text: 'done', ts: Date.now() }]);
  ok(sp && fs.readFileSync(sp, 'utf-8').includes('jb-x'), 'spill file written with the full history');

  // 7h. 2.347.0: subscription regex filters
  const filtNotifs = [];
  C._notifyRate.clear();
  C.d.deliverToConversation = async (cid, text) => { filtNotifs.push(cid); return { ok: true, lane: 'message' }; };
  const rf1 = C.create({ kind: 'task', name: 'news-src', cmd: { argv: ['sh', '-c', 'sleep 30'] }, owner }, caller);
  const jf1 = C.jobs.get(rf1.job.id);
  const spaceSub = { conversationId: 'conv-SPACEX', sessionId: 's2', sessionCreatedAt: 4, groups: new Set(['T-g']) };
  const sres = C.subscribe(jf1, spaceSub, { filter: 'SpaceX|Starship' });
  ok(sres.ok && sres.filter === 'SpaceX|Starship', 'subscribe stores the filter');
  ok(C.subscribe(jf1, spaceSub, { filter: 'onlyThis' }).updated, 're-subscribe UPDATES the filter in place');
  C.subscribe(jf1, spaceSub, { filter: 'SpaceX' });
  ok(!C.subscribe(jf1, spaceSub, { filter: '(' }).ok, 'invalid regex refused');
  C._notifyRate.clear(); filtNotifs.length = 0;
  C.announce(jf1, '普通新闻: 今天天气不错');
  await sleep(400);
  ok(filtNotifs.includes('conv-T') && !filtNotifs.includes('conv-SPACEX'), 'non-matching announce reaches owner but NOT the filtered subscriber', JSON.stringify(filtNotifs));
  C._notifyRate.clear(); filtNotifs.length = 0;
  C.announce(jf1, 'BREAKING: spacex Starship 第七次试飞成功');
  await sleep(400);
  ok(filtNotifs.includes('conv-SPACEX'), 'matching announce (case-insensitive) reaches the filtered subscriber', JSON.stringify(filtNotifs));
  C.stop(jf1, { force: true });

  // 7i. 2.350.0: answering a panel clears its inbox entry; rm clears everything
  const resolved = [];
  C.d.resolveJobAsk = (jobId, opts) => { resolved.push({ jobId, opts }); return 1; };
  const rp1 = C.create({ kind: 'task', name: 'panel-clear', cmd: { argv: ['sh', '-c', 'sleep 30'] }, owner }, caller);
  const jp1 = C.jobs.get(rp1.job.id);
  C.ask(jp1, { title: 't', blocks: [{ type: 'md', text: 'x' }, { type: 'buttons', options: [{ id: 's', label: 'ok' }] }] });
  C.answerPanel(jp1, { button: 's' });
  ok(resolved.some((r) => r.jobId === jp1.id), 'answerPanel resolves the needs-your-input inbox entry');
  C.stop(jp1, { force: true });
  const settled = await until(() => ['interrupted', 'failed'].includes(jp1.state));
  const rmr = C.rm(jp1, {});
  ok(resolved.some((r) => r.jobId === jp1.id && r.opts && r.opts.onlyAsk === false), 'rm clears ALL of the job inbox items', `settled=${settled} state=${jp1.state} rm=${JSON.stringify(rmr)} resolved=${JSON.stringify(resolved)}`);

  // 8. store hygiene: raw token never persisted
  C._save();
  ok(!fs.readFileSync(path.join(dir, 'jobs.json'), 'utf-8').includes('jbt_'), 'raw job tokens are never written to the store');

  // 9. rm --stop on terminal + cleanup
  ok(C.rm(j2, {}).ok, 'rm on a terminal task succeeds');
  C.shutdown();
} finally {
  try { const all = JSON.parse(fs.readFileSync(path.join(dir, 'jobs.json'), 'utf-8')); } catch { }
  try { for (const d of fs.readdirSync(path.join(dir, 'job-logs'))) { } } catch { }
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
