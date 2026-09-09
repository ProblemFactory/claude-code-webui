// B-7edc: get_usage control-request builder + rate_limits→cache parser.
// Pure pieces — the LIVE ws-correlation is validated separately on a real
// chat session (the control_response envelope nesting is the open unknown).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ClaudeCodeAdapter } = require('../src/adapters/claude-code.js');
let pass=0,fail=0; const ck=(n,c)=>{if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n)}};
const req = ClaudeCodeAdapter.buildGetUsage();
ck('builder shape', req.type==='control_request' && req.request.subtype==='get_usage' && req.request_id.startsWith('vsu-'));
const payload = { subscription_type:'max', rate_limits_available:true, rate_limits:{
  five_hour:{used_percentage:42, resets_at:'2026-08-08T05:00:00.000Z'},
  seven_day:{used_percentage:71, resets_at:'2026-08-12T00:00:00.000Z'},
  model_scoped:[{display_name:'Claude Fable', utilization:33, resets_at:'2026-08-13T00:00:00.000Z'},
                {display_name:'Claude Opus', utilization:0.12, resets_at:1786665600}] } };
const out = ClaudeCodeAdapter.parseGetUsageResponse(payload);
ck('fiveHour 0.42', Math.abs(out.fiveHour.utilization-0.42)<1e-3);
ck('sevenDay 0.71', Math.abs(out.sevenDay.utilization-0.71)<1e-3);
ck('scoped Fable 0.33', out.scopedWeekly.some(w=>w.name==='Claude Fable'&&Math.abs(w.utilization-0.33)<1e-3));
ck('scoped Opus 0-1 kept', out.scopedWeekly.some(w=>w.name==='Claude Opus'&&Math.abs(w.utilization-0.12)<1e-3));
ck('source=control', out.source==='control');
ck('null on garbage', ClaudeCodeAdapter.parseGetUsageResponse(null)===null && ClaudeCodeAdapter.parseGetUsageResponse({})===null);
// ── REAL live envelope (captured 2026-08-09 on a 2.1.x session): utilization
// is a 0-100 INTEGER, resets_at ISO, NO model_scoped array — named nullable
// fields + codename buckets instead. The payload nests at
// control_response.response.response (double). ──
const live = { session:{total_cost_usd:0}, subscription_type:'max', rate_limits_available:true, rate_limits:{
  five_hour:{utilization:34, resets_at:'2026-08-09T09:59:59.753015+00:00', limit_dollars:null},
  seven_day:{utilization:39, resets_at:'2026-08-11T16:59:59.753043+00:00'},
  seven_day_oauth_apps:null, seven_day_opus:null,
  seven_day_sonnet:{utilization:12, resets_at:'2026-08-11T16:59:59.753043+00:00'},
  nimbus_quill:{utilization:0, resets_at:null},
  extra_usage:{is_enabled:false} } };
const lv = ClaudeCodeAdapter.parseGetUsageResponse(live);
ck('LIVE: 0-100 int utilization normalized (34 → 0.34)', Math.abs(lv.fiveHour.utilization-0.34)<1e-3);
ck('LIVE: sevenDay 0.39', Math.abs(lv.sevenDay.utilization-0.39)<1e-3);
ck('LIVE: ISO resets_at → epoch seconds', lv.sevenDay.resetsAt === Math.floor(Date.parse('2026-08-11T16:59:59.753043+00:00')/1000));
ck('LIVE: named scoped field picked up (seven_day_sonnet → Sonnet)', lv.scopedWeekly.some(w=>/Sonnet/i.test(w.name)&&Math.abs(w.utilization-0.12)<1e-3));
// A BUCKET WITHOUT A RESET IS STILL A BUCKET (r6). This used to assert the
// opposite ('codename bucket without resets_at skipped', because it had "no
// usable deadline") — but a deadline and a claim are two different questions,
// which is exactly what the r3/r4 rounds of the quota model settled: a STATED
// SPEND counts (`windowState`), it merely may not name a deadline
// (`bucketCounts`). Dropping the entry turned a number the vendor stated into
// ignorance, and the number it drops is "this model cap is spent" — the
// inc-msof8i22 harm one layer down. The `model_scoped` array in the very same
// parser has always accepted reset-less entries, so this was also one parser
// giving two answers for one payload shape.
ck('LIVE: codename bucket without resets_at is KEPT (a stated spend counts; only the DEADLINE needs a reset)',
  lv.scopedWeekly.some(w=>/nimbus/i.test(w.name)&&w.utilization===0&&!w.resetsAt));
ck('LIVE: null buckets skipped, extra_usage not a scoped entry', !lv.scopedWeekly.some(w=>/extra|oauth/i.test(w.name)));
// …and the parse still says it ENUMERATED, because a `null` field is the vendor
// stating there is no such limit, not a bucket we failed to read (r6: only a
// parse that dropped nothing may retire a limit — see test-quota-model §⑱).
{
  const QM = require('../src/quota-model.js');
  ck('LIVE: the parse claims the model scope (it dropped nothing)', QM.scopedEnumeration(lv) === true);
}

// ── chat-mode limit banner parser (passive exhaustion signal) ──
const pb = ClaudeCodeAdapter.parseLimitBanner;
ck("banner: 5-hour", pb("You've reached your 5-hour limit.").kind==='fiveHour');
ck('banner: weekly', pb("You've reached your weekly limit.").kind==='sevenDay');
ck('banner: model-scoped weekly', (()=>{const r=pb("You've reached your Fable weekly limit."); return r.kind==='scoped'&&r.name==='Fable';})());
ck('banner: unknown wording → fiveHour (shortest self-heal)', pb("You've reached your usage limit for now.").kind==='fiveHour');
ck('banner: non-banner text → null', pb('Normal assistant reply about limits')===null);
// the REAL 2026-08-09 incident wording (workflow agent failure strings) — the
// reach-only anchored regex was blind to it and the pool switched only after
// exhaustion had failed 9 agents
ck("banner: 'hit your session limit' (workflow failure wording) → fiveHour", pb("You've hit your session limit · resets 3am (America/Los_Angeles)").kind==='fiveHour');
ck('banner: phrase mid-blob (task-notification carrier) still matches', pb("[verify:x] failed: You've hit your session limit · resets 3am").kind==='fiveHour');
// incident #2 wording (same day): model-scoped WITHOUT the word "weekly"
ck("banner: 'Fable 5 limit' (no week word) → scoped Fable", (()=>{const r=pb("You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."); return r.kind==='scoped'&&r.name==='Fable';})());


// ── OPUS-INVISIBLE regression (inc-msof8i22, 2.305.0) ──────────────────────
// The named scoped fields were read ONLY when model_scoped was empty, so an
// account with a Fable array entry AND a seven_day_opus field reported just
// Fable — the Opus cap was invisible to the pool's exhaustion test, which is
// why a pool stayed on an account whose Opus was spent.
{
  const r = ClaudeCodeAdapter.parseGetUsageResponse({
    rate_limits: {
      five_hour: { utilization: 12, resets_at: 1786440000 },
      seven_day: { utilization: 55, resets_at: 1786900000 },
      model_scoped: [{ display_name: 'Fable', utilization: 96, resets_at: 1786900000 }],
      seven_day_opus: { utilization: 100, resets_at: 1786900000 },
      seven_day_sonnet: { utilization: 20, resets_at: 1786900000 },
    },
  });
  const names = (r.scopedWeekly || []).map((x) => x.name).sort();
  ck('array AND named scoped buckets are MERGED (Fable + Opus + Sonnet)',
    names.join(',') === 'Fable,Opus,Sonnet', names.join(','));
  const opus = r.scopedWeekly.find((x) => x.name === 'Opus');
  ck('the exhausted Opus bucket survives with utilization 1', opus && opus.utilization === 1);
  ck('a named bucket never overrides the array entry of the same model',
    r.scopedWeekly.filter((x) => x.name === 'Fable').length === 1);
}
{
  // array-only payloads keep working; named-only payloads keep working
  const arrOnly = ClaudeCodeAdapter.parseGetUsageResponse({ rate_limits: { model_scoped: [{ display_name: 'Fable', utilization: 10, resets_at: 1 }] } });
  ck('array-only payload unchanged', arrOnly.scopedWeekly.length === 1 && arrOnly.scopedWeekly[0].name === 'Fable');
  const namedOnly = ClaudeCodeAdapter.parseGetUsageResponse({ rate_limits: { seven_day_opus: { utilization: 40, resets_at: 1786900000 } } });
  ck('named-only payload unchanged', namedOnly.scopedWeekly.length === 1 && namedOnly.scopedWeekly[0].name === 'Opus');
  // A SPENT CAP WITH NO RESET IS THE SHAPE THAT MATTERS (r6): this fixture is a
  // model cap at 50 % that the pre-r6 parser threw away, so the pool saw an
  // account with more headroom than it has.
  const noReset = ClaudeCodeAdapter.parseGetUsageResponse({ rate_limits: { seven_day_zebra: { utilization: 50 } } });
  const QM = require('../src/quota-model.js');
  ck('a scoped field with no reset is KEPT, with its stated number',
    noReset.scopedWeekly.length === 1 && noReset.scopedWeekly[0].name === 'Zebra' && Math.abs(noReset.scopedWeekly[0].utilization - 0.5) < 1e-9);
  ck('…and the parse still claims the scope (nothing was dropped)', QM.scopedEnumeration(noReset) === true);
  // What still is NOT a bucket: a window-shaped field stating no number we can
  // read. It is not admitted — AND it costs the parse the right to retire,
  // because a cap we could not read is a cap we lost.
  const noNum = ClaudeCodeAdapter.parseGetUsageResponse({ rate_limits: { five_hour: { utilization: 1 }, seven_day_zebra: { resets_at: 1786900000 } } });
  ck('a window-shaped field with no readable number is not a bucket', noNum.scopedWeekly.length === 0);
  ck('…and the parse does NOT claim to have enumerated the scope', QM.scopedEnumeration(noNum) === false);
  // …while an object that is not window-shaped at all is neither a bucket nor a drop.
  const other = ClaudeCodeAdapter.parseGetUsageResponse({ rate_limits: { five_hour: { utilization: 1 }, some_flag: { enabled: true } } });
  ck('a non-window object is ignored and costs nothing', other.scopedWeekly.length === 0 && QM.scopedEnumeration(other) === true);
}

console.log(fail?`${fail} FAILED`:`ALL PASS (${pass})`);
process.exit(fail?1:0);
