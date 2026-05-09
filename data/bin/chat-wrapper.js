#!/usr/bin/env node
// Chat wrapper — runs inside dtach, spawns claude with --output-format stream-json.
// Reads structured JSON lines from stdout, writes to buffer file.
// Survives server restarts (dtach keeps this process alive).
// Usage: node chat-wrapper.js <buffer-file> <meta-file> <command> [args...]
//
// The buffer file contains JSON lines — each line is a complete JSON object
// from claude's stream-json output. Server reads this on attach to recover
// message history. New lines are also teed to stdout (dtach PTY) so the
// server can read them in real-time via the attached PTY.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const logFile = path.join(path.dirname(process.argv[2] || '/tmp/chat-wrapper'), 'chat-wrapper.log');
function log(msg) { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch {} }

const bufferFile = process.argv[2];
const metaFile = process.argv[3];
const cmd = process.argv[4];
const args = process.argv.slice(5);

log(`Starting: cmd=${cmd} args=${JSON.stringify(args.slice(0, 5))}... cwd=${process.cwd()}`);

if (!bufferFile || !cmd) {
  log('Missing arguments');
  process.exit(1);
}

// Ensure stream-json flags are in args
if (!args.includes('--output-format')) {
  args.push('--output-format', 'stream-json');
}
if (!args.includes('--input-format')) {
  args.push('--input-format', 'stream-json');
}
if (!args.includes('--verbose')) {
  args.push('--verbose');
}
if (!args.includes('--permission-prompt-tool')) {
  args.push('--permission-prompt-tool', 'stdio');
}

// Write initial metadata
try { fs.mkdirSync(path.dirname(metaFile), { recursive: true }); } catch {}
const meta = { pid: process.pid, startedAt: Date.now(), mode: 'chat', tasks: {}, todos: [] };
let metaDirty = false;
let metaTimer = null;

function persistMeta() {
  metaTimer = null;
  metaDirty = false;
  try { fs.writeFileSync(metaFile, JSON.stringify(meta)); } catch {}
}

function scheduleMeta() {
  if (!metaTimer) metaTimer = setTimeout(persistMeta, 500);
  metaDirty = true;
}

try { fs.writeFileSync(metaFile, JSON.stringify(meta)); } catch (e) { log(`meta write failed: ${e.message}`); }

// Ensure buffer directory exists and start with empty buffer
try { fs.mkdirSync(path.dirname(bufferFile), { recursive: true }); } catch {}

// Spawn child as a regular process (pipe stdio, NOT PTY)
let child;
try {
  child = spawn(cmd, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  log(`Spawned child PID=${child.pid}`);
  meta.childPid = child.pid;
  try { fs.writeFileSync(metaFile, JSON.stringify(meta)); } catch {}
} catch (err) {
  log(`Failed to spawn: ${err.message}\ncmd=${cmd}\nargs=${JSON.stringify(args)}`);
  process.exit(1);
}

// Buffer: stores complete JSON lines for history recovery
let buffer = '';
const MAX_BUFFER = 500000; // 500KB — JSON lines are larger than raw PTY
let writeTimer = null;
let lineBuffer = ''; // accumulator for partial lines from stdout

function persistBuffer() {
  writeTimer = null;
  try { fs.writeFileSync(bufferFile, buffer); } catch {}
}

function schedulePersist() {
  if (!writeTimer) writeTimer = setTimeout(persistBuffer, 2000);
}

// Child stdout → parse JSON lines → buffer + tee to our stdout (dtach PTY)
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  lineBuffer += chunk;
  // Process complete lines
  let nlIdx;
  while ((nlIdx = lineBuffer.indexOf('\n')) !== -1) {
    const line = lineBuffer.substring(0, nlIdx).trim();
    lineBuffer = lineBuffer.substring(nlIdx + 1);
    if (!line) continue;

    // Validate it's JSON and inspect for task/todo tracking
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`Non-JSON line: ${line.substring(0, 100)}`);
      continue;
    }

    // Track tasks: system.task_started / task_progress / task_notification
    if (msg.type === 'system' && msg.tool_use_id) {
      if (msg.subtype === 'task_started') {
        meta.tasks[msg.tool_use_id] = {
          id: msg.task_id, type: msg.task_type === 'local_agent' ? 'agent' : 'command',
          description: msg.description || '', status: 'running', startedAt: Date.now(),
        };
        scheduleMeta();
      } else if (msg.subtype === 'task_progress') {
        const t = meta.tasks[msg.tool_use_id];
        if (t) {
          if (msg.description) t.description = msg.description;
          if (msg.last_tool_name) t.lastTool = msg.last_tool_name;
          scheduleMeta();
        }
      } else if (msg.subtype === 'task_notification') {
        // Remove completed tasks entirely — don't accumulate in meta
        delete meta.tasks[msg.tool_use_id];
        scheduleMeta();
      }
    }

    // Track streaming state
    if (msg.type === 'user') { meta.streaming = true; scheduleMeta(); }
    if (msg.type === 'result' || (msg.type === 'system' && msg.subtype === 'compact_boundary')) {
      meta.streaming = false;
      // Clean up background command tasks on turn end — stream-json rarely
      // emits task_notification for them (known bug). Agent tasks are kept
      // since they may genuinely span multiple turns.
      for (const [id, t] of Object.entries(meta.tasks)) {
        if (t.type === 'command') delete meta.tasks[id];
      }
      scheduleMeta();
    }

    // Track todos: TodoWrite tool_use in assistant messages
    if (msg.type === 'assistant' && msg.message?.content) {
      const blocks = Array.isArray(msg.message.content) ? msg.message.content : [];
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.name === 'TodoWrite' && b.input?.todos) {
          meta.todos = b.input.todos;
          scheduleMeta();
        }
      }
    }

    // Append to buffer and tee to stdout
    buffer += line + '\n';
    try { process.stdout.write(line + '\n'); } catch {}
  }

  // Trim buffer if too large (keep last MAX_BUFFER chars, aligned to line boundary)
  if (buffer.length > MAX_BUFFER) {
    const trimStart = buffer.indexOf('\n', buffer.length - MAX_BUFFER);
    if (trimStart > 0) buffer = buffer.substring(trimStart + 1);
  }
  schedulePersist();
});

// Child stderr → log (not shown to user, but useful for debugging)
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  log(`[stderr] ${chunk.trim()}`);
});

// stdin (from dtach PTY) → child stdin
// Server writes lines via dtach PTY. Each line is either:
// - A raw JSON object (already formatted as stream-json input) → pass through
// - Plain text → wrap as {"type":"user","content":"..."}
let stdinLineBuf = '';
try {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    stdinLineBuf += data;
    let nlIdx;
    while ((nlIdx = stdinLineBuf.indexOf('\n')) !== -1) {
      const line = stdinLineBuf.substring(0, nlIdx).replace(/\r/g, '').trim();
      stdinLineBuf = stdinLineBuf.substring(nlIdx + 1);
      if (!line) continue;
      // Immediately ack on stdout so the server knows stdin is alive.
      // This fires before claude processes the message, so it works
      // even when the model takes 30+ seconds to respond.
      try { process.stdout.write(JSON.stringify({ type: '_stdin_ack', timestamp: Date.now() }) + '\n'); } catch {}
      try {
        // Try parsing as JSON — if valid, pass through as-is
        JSON.parse(line);
        if (child.stdin.writable) child.stdin.write(line + '\n');
      } catch {
        // Plain text — wrap as stream-json user message
        // Format must match JSONL schema: {type, message: {role, content: [{type, text}]}}
        const msg = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: line }] }
        });
        if (child.stdin.writable) child.stdin.write(msg + '\n');
      }
    }
  });
} catch (err) {
  log(`stdin setup failed: ${err.message}`);
}

// Child exit → persist final buffer and exit
child.on('exit', (exitCode) => {
  log(`Child exited with code ${exitCode}`);
  // Flush any remaining partial line
  if (lineBuffer.trim()) {
    try {
      JSON.parse(lineBuffer.trim());
      buffer += lineBuffer.trim() + '\n';
      try { process.stdout.write(lineBuffer.trim() + '\n'); } catch {}
    } catch {}
  }
  if (writeTimer) { clearTimeout(writeTimer); }
  persistBuffer();
  meta.streaming = false;
  // Mark all running tasks as unknown (process died — can't know real state)
  for (const t of Object.values(meta.tasks)) {
    if (t.status === 'running') t.status = 'unknown';
  }
  if (metaTimer) clearTimeout(metaTimer);
  persistMeta();
  try { fs.unlinkSync(metaFile); } catch {}
  process.exit(exitCode ?? 0);
});

child.on('error', (err) => {
  log(`Child error: ${err.message}`);
  process.exit(1);
});

process.on('uncaughtException', (err) => { log(`Uncaught: ${err.message}\n${err.stack}`); });
