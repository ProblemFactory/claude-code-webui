#!/usr/bin/env node
// WIRE-REACHABILITY PROBE for the claude stream-json consumer
// (design-harness-features §8: a record is REAL only if it is observed on OUR
// stdout in the wrapper's exact spawn shape).
//
// WHY THIS EXISTS. Round 3 of the B3 batch shipped a consumer branch, a
// broadcast, an attach field, a CSS dot and a caps row for
// `set_in_progress_tool_use_ids` — a record the CLI documents, declares in its
// own zod schema, and NEVER SENDS US: 2.1.257 routes it into a host callback
// (`n.onInProgressToolUseIDs?.(e.op); return`) instead of the yielded stream.
// Three suites stayed green because every one of them synthesized the record
// itself. A fixture leg cannot tell "we parse it right" from "it never
// arrives"; only the wire can.
//
// WHAT IT DOES. Spawns the installed CLI in chat-wrapper.js's exact flag shape
// (--output-format stream-json --input-format stream-json --verbose
// --permission-prompt-tool stdio, piped stdio, CLAUDE_CODE_EMIT_SESSION_STATE_
// EVENTS=1 like src/adapters/claude-code.js), asks for READ-ONLY tool calls in
// a throwaway temp dir, answers any permission control_request with allow, and
// prints ONE json line censusing what actually appeared on stdout.
//   --model haiku is a COST control, not a shape change: which record types the
//   SDK sink forwards is decided by the output mode (`wJt`/`k5` in the binary),
//   never by the model, and the tool-dispatch emitters are model-agnostic.
// Everything that is not a clean measurement reports `skip` with a reason — a
// probe that cannot measure must never be read as evidence of absence.
//
// IT MUST LEAVE NOTHING BEHIND. This runs inside `npm run ci`, i.e. on EVERY
// non-docs push through the mandatory pre-push gate, against the developer's
// REAL $HOME — the probe needs the machine's actual claude credentials, so it
// cannot be given a throwaway HOME. A real CLI turn therefore writes a real
// transcript to `~/.claude/projects/<cwd-encoded>/`, and VibeSpace's own
// discovery lists every one of them as a stopped session in the sidebar (12
// junk sessions had accumulated by the time this was measured, one per push,
// each with its own cwd folder group). The env half of the same lesson is
// below (VIBESPACE_* stripped so the hook cannot touch the task board); this
// is the filesystem half: the temp cwd, the transcript the CLI wrote for it,
// and the CLI's per-session env dir are all removed when the probe reports,
// old ones are swept at startup, and the raw stdout goes to ONE fixed path
// that is overwritten each run instead of accumulating.
//
// Output (stdout, one line): {"ok":true, version, args, cwd, toolUses,
//   toolResults, types:{<type>:<count>}, raw, cleaned} | {"skip":"<reason>"}
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BUDGET_MS = Number(process.env.VIBESPACE_WIRE_PROBE_MS || 90000);
const PREFIX = 'vs-wire-probe-';
const HOME = process.env.HOME || os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const SESSION_ENV = path.join(HOME, '.claude', 'session-env');
// cwdToProjectDir (src/session-store.js) — the CLI's own deterministic
// encoding. Built from os.tmpdir() so the sweep prefix is EXACT and can never
// match a directory that is not one of this probe's throwaway cwds.
const encode = (p) => p.replace(/[/._]/g, '-');
const PROJ_PREFIX = encode(path.join(os.tmpdir(), PREFIX));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rmDir = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { } };
// The CLI leaves an EMPTY dir per session id. rmdir (never recursive): if a
// future CLI puts something in there, this refuses rather than deleting it.
const rmEmptyDir = (p) => { try { fs.rmdirSync(p); } catch { } };

/** Remove the transcript + session-env the CLI wrote for ONE throwaway cwd.
 *  `ids` may be empty — the project dir's own `<uuid>.jsonl` names are the
 *  authoritative list, which is also how a LEFTOVER dir gets fully cleaned. */
function purgeProject(projDir, ids = []) {
  if (path.dirname(projDir) !== PROJECTS || !path.basename(projDir).startsWith(PROJ_PREFIX)) return 0;
  const sids = new Set(ids.filter((s) => UUID.test(s)));
  try { for (const f of fs.readdirSync(projDir)) if (f.endsWith('.jsonl') && UUID.test(f.slice(0, -6))) sids.add(f.slice(0, -6)); } catch { }
  for (const sid of sids) rmEmptyDir(path.join(SESSION_ENV, sid));
  rmDir(projDir);
  return 1;
}

// ── SWEEP of everything earlier versions of this probe left behind. Runs
//    BEFORE the CLI check, so even a machine with no claude cleans up.
//    STALE ONLY (>10min): a concurrently running probe's cwd must survive.
const STALE_MS = 10 * 60 * 1000;
const stale = (p) => { try { return Date.now() - fs.statSync(p).mtimeMs > STALE_MS; } catch { return false; } };
let swept = 0;
for (const d of (() => { try { return fs.readdirSync(os.tmpdir(), { withFileTypes: true }); } catch { return []; } })()) {
  const p = path.join(os.tmpdir(), d.name);
  if (d.isDirectory() && d.name.startsWith(PREFIX) && stale(p)) { rmDir(p); swept++; }
}
for (const d of (() => { try { return fs.readdirSync(PROJECTS, { withFileTypes: true }); } catch { return []; } })()) {
  const p = path.join(PROJECTS, d.name);
  if (d.isDirectory() && d.name.startsWith(PROJ_PREFIX) && stale(p)) swept += purgeProject(p);
}

let cwd = null;
const sessionIds = new Set();
let cleaned = null;
/** Idempotent, and safe before the temp dir exists (every early `skip` path
 *  goes through `out` too). */
function cleanupRun() {
  if (!cwd || cleaned) return;
  purgeProject(path.join(PROJECTS, encode(cwd)), [...sessionIds]);
  if (path.dirname(cwd) === os.tmpdir() && path.basename(cwd).startsWith(PREFIX)) rmDir(cwd);
  cleaned = { cwd, swept };
}
const out = (o) => { cleanupRun(); process.stdout.write(JSON.stringify({ ...o, cleaned }) + '\n'); process.exit(0); };

let bin = null;
try { bin = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim(); } catch { }
if (!bin) out({ skip: 'no claude CLI on PATH' });
let version = '?';
try { version = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 }).trim(); } catch (e) { out({ skip: `claude --version failed: ${e.message}` }); }

cwd = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(cwd, `probe-${n}.txt`), `probe file ${n}\nsecond line\n`);

// chat-wrapper.js's flags, verbatim (data/bin/chat-wrapper.js "Ensure
// stream-json flags are in args"). The probe asserts this list itself so a
// wrapper change cannot silently make the measurement irrelevant.
const WRAPPER_FLAGS = ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'];
const args = [...WRAPPER_FLAGS, '--model', 'haiku'];

// THE PROBE MUST NOT TOUCH PRODUCTION STATE. Observed the hard way on the first
// manual run of this probe: a suite started from inside a VibeSpace session
// inherits VIBESPACE_API + VIBESPACE_SESSION_TOKEN, the user-level SessionStart
// hook is therefore NOT a no-op, it injects the parent session's task context,
// and the probe's model dutifully went and updated the real task board. So the
// child env drops EVERY VIBESPACE_* key (which makes vibespace-hook.mjs exit 0
// by its own first check) and every data/bin PATH entry (the agent-tool shims),
// on top of the CLAUDE_CODE_CHILD_SESSION strip that keeps a parent session's
// marker from suppressing the child's transcript (project_child_session_env).
const env = { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1', VIBESPACE_SKIP_AGENT_HOOKS: '1' };
for (const k of Object.keys(env)) if (k.startsWith('VIBESPACE_') && k !== 'VIBESPACE_SKIP_AGENT_HOOKS' && k !== 'VIBESPACE_WIRE_PROBE_MS') delete env[k];
delete env.CLAUDE_CODE_CHILD_SESSION;
if (env.PATH) env.PATH = env.PATH.split(':').filter((d) => !/(^|\/)data\/bin(\/|$)/.test(d)).join(':');

let child;
try { child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { out({ skip: `spawn failed: ${e.message}` }); }

// ONE fixed path, overwritten each run and OUTSIDE the throwaway cwd (which is
// deleted): the raw capture is for reading a failure, and a per-run copy is
// exactly the accumulation this probe stopped doing. Buffered and written
// synchronously at the end — `out` exits the process, which would truncate a
// write stream anyway. Capped so a runaway CLI cannot eat memory.
const rawPath = path.join(os.tmpdir(), 'vs-wire-probe.last.jsonl');
const RAW_CAP = 8 * 1024 * 1024;
const rawChunks = []; let rawBytes = 0;
const types = {}; let toolUses = 0, toolResults = 0, buf = '', stderr = '';
const note = (t) => { types[t] = (types[t] || 0) + 1; };
let done = false;
const finish = (extra) => {
  if (done) return; done = true;
  clearTimeout(timer);
  try { fs.writeFileSync(rawPath, Buffer.concat(rawChunks)); } catch { }
  out({ ok: true, version, bin, args, cwd, raw: rawPath, toolUses, toolResults, types, stderr: stderr.slice(-400), ...extra });
};

child.stdout.on('data', (d) => {
  if (rawBytes < RAW_CAP) { rawChunks.push(d); rawBytes += d.length; }
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { note('«non-json»'); continue; }
    note(r.type === 'system' ? 'system/' + r.subtype : r.type);
    // Every session id the CLI names is one we made it create — the cleanup
    // has to know them to remove the per-session env dirs it leaves behind.
    if (typeof r.session_id === 'string') sessionIds.add(r.session_id);
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) for (const b of r.message.content) if (b?.type === 'tool_use') toolUses++;
    if (r.type === 'user' && Array.isArray(r.message?.content)) for (const b of r.message.content) if (b?.type === 'tool_result') toolResults++;
    if (r.type === 'control_request' && r.request?.subtype === 'can_use_tool') {
      // the wrapper's own answer shape (ClaudeCodeAdapter.buildPermissionResponse)
      try { child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: r.request_id, response: { behavior: 'allow', updatedInput: r.request.input || {} } } }) + '\n'); } catch { }
    }
    // Give the CLI a beat after the result: the whole point is to catch records
    // that trail a turn (the CLI's own `idle` fires AFTER the result).
    if (r.type === 'result') setTimeout(() => { try { child.kill('SIGTERM'); } catch { } }, 2000);
  }
});
child.stderr.on('data', (d) => { stderr += d.toString(); });
child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); out({ skip: `child error: ${e.message}` }); } });
child.on('close', () => finish({}));

try {
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Use the Read tool on ./probe-a.txt, ./probe-b.txt and ./probe-c.txt — three separate Read calls in ONE message. Then reply with exactly: OK' } }) + '\n');
} catch (e) { out({ skip: `stdin write failed: ${e.message}` }); }

const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { } setTimeout(() => finish({ budgetExpired: true }), 2000); }, BUDGET_MS);
