#!/usr/bin/env node
// PTY wrapper — runs inside dtach, spawns claude with a PTY, tees output to a buffer file.
// Survives server restarts (dtach keeps this process alive).
// Usage: node pty-wrapper.js <buffer-file> <meta-file> <command> [args...]

const fs = require('fs');
const path = require('path');

// Debug log to file (since stdout goes to dtach PTY, errors are invisible)
const logFile = path.join(path.dirname(process.argv[2] || '/tmp/pty-wrapper'), 'pty-wrapper.log');
function log(msg) { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch {} }

let pty;
try {
  pty = require(path.join(__dirname, '../../node_modules/node-pty'));
} catch (err) {
  log(`Failed to load node-pty: ${err.message}`);
  process.exit(1);
}

const bufferFile = process.argv[2];
const metaFile = process.argv[3];
const cmd = process.argv[4];
const args = process.argv.slice(5);

log(`Starting: cmd=${cmd} args=${JSON.stringify(args.slice(0, 3))}... cwd=${process.cwd()}`);

if (!bufferFile || !cmd) {
  log('Missing arguments');
  process.exit(1);
}

// Write metadata for server recovery
const meta = { pid: process.pid, startedAt: Date.now() };
try { fs.mkdirSync(path.dirname(metaFile), { recursive: true }); } catch {}
try { fs.writeFileSync(metaFile, JSON.stringify(meta)); } catch (e) { log(`meta write failed: ${e.message}`); }

// Spawn child with PTY
let child;
try {
  child = pty.spawn(cmd, args, {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
    cwd: process.cwd(),
    env: process.env,
  });
  log(`Spawned child PID=${child.pid}`);
} catch (err) {
  log(`Failed to spawn: ${err.message}\ncmd=${cmd}\nargs=${JSON.stringify(args)}`);
  process.exit(1);
}

// Buffer management
let buffer = '';
const MAX_BUFFER = 50000;
let writeTimer = null;

function persistBuffer() {
  writeTimer = null;
  try { fs.writeFileSync(bufferFile, buffer); } catch {}
}

// Child output → stdout (dtach PTY) + buffer file
child.onData((data) => {
  try { process.stdout.write(data); } catch {}
  buffer = (buffer + data).slice(-MAX_BUFFER);
  if (!writeTimer) writeTimer = setTimeout(persistBuffer, 2000);
});

// stdin (dtach PTY) → child
try {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (data) => { try { child.write(data); } catch {} });
} catch (err) {
  log(`stdin setup failed: ${err.message}`);
}

// Propagate SIGWINCH to child PTY
process.on('SIGWINCH', () => {
  try { child.resize(process.stdout.columns || 120, process.stdout.rows || 30); } catch {}
});

// Child exit → persist final buffer and exit
child.onExit(({ exitCode }) => {
  log(`Child exited with code ${exitCode}`);
  if (writeTimer) { clearTimeout(writeTimer); persistBuffer(); }
  try { fs.unlinkSync(metaFile); } catch {}
  process.exit(exitCode);
});

process.on('uncaughtException', (err) => { log(`Uncaught: ${err.message}\n${err.stack}`); });
