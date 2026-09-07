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
// Output (stdout, one line): {"ok":true, version, args, cwd, toolUses,
//   toolResults, types:{<type>:<count>}, raw} | {"skip":"<reason>"}
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BUDGET_MS = Number(process.env.VIBESPACE_WIRE_PROBE_MS || 90000);
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };

let bin = null;
try { bin = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim(); } catch { }
if (!bin) out({ skip: 'no claude CLI on PATH' });
let version = '?';
try { version = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 }).trim(); } catch (e) { out({ skip: `claude --version failed: ${e.message}` }); }

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-wire-probe-'));
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

const rawPath = path.join(cwd, 'stdout.jsonl');
const raw = fs.createWriteStream(rawPath);
const types = {}; let toolUses = 0, toolResults = 0, buf = '', stderr = '';
const note = (t) => { types[t] = (types[t] || 0) + 1; };
let done = false;
const finish = (extra) => {
  if (done) return; done = true;
  clearTimeout(timer);
  out({ ok: true, version, bin, args, cwd, raw: rawPath, toolUses, toolResults, types, stderr: stderr.slice(-400), ...extra });
};

child.stdout.on('data', (d) => {
  raw.write(d); buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { note('«non-json»'); continue; }
    note(r.type === 'system' ? 'system/' + r.subtype : r.type);
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
