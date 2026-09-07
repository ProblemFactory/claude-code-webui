'use strict';
/**
 * THE OpenCode-serve TERMINAL BRIDGE (S9 remainder piece (c), B-eac2).
 *
 * `opencode serve` owns real ptys on its own machine and streams them over a
 * websocket. This module connects to that socket SERVER-SIDE and presents it
 * as the {pid, onData, onExit, write, resize, kill} duck the session layer
 * already speaks — the same shape the daemon pipe-session shim uses — so the
 * xterm window, input, resize, the buffer file and every window action work
 * with zero terminal-side changes. THE SERVE PORT (and its auth header, and
 * the connect ticket) NEVER reach the browser: the browser only ever talks to
 * VibeSpace's own /ws.
 *
 * THE WIRE, measured on a real 1.18.29 serve (`GET /pty/{id}/connect`):
 *   • the upgrade succeeds with NO ticket on an unsecured loopback serve
 *     (`POST /pty/{id}/connect-token` answers PtyForbiddenError there), so the
 *     bridge mints a ticket when it can and connects without one when it
 *     cannot;
 *   • TEXT frames are terminal output (utf8, ANSI and all);
 *   • BINARY frames are control JSON prefixed with a 0x00 byte
 *     (e.g. `\0{"cursor":73}`) — not output, and rendering them would paint
 *     json into the user's shell;
 *   • frames written to the socket are fed to the pty (verified: both a text
 *     and a Buffer frame reached bash).
 * Resize is NOT on the socket — it is `PUT /pty/{id} {size:{rows,cols}}`.
 *
 * LIFETIME: the pty belongs to the SERVE, so it survives our socket dropping.
 * A dropped socket therefore RECONNECTS (bounded) instead of ending the
 * session; the session ends when the pty itself exits (`GET /pty/{id}` says
 * `exited`, or the user kills the window, which deletes it).
 */
const { access } = require('./opencode-access');

const RECONNECT_MS = 800;
const MAX_RECONNECTS = 5;

/** Open a serve-owned pty and return {ptyId, shim}. Throws LOUDLY (the caller
 *  turns it into a user-visible refusal). */
async function openOpencodePty({ cwd = null, title = null, command = null, args = null, log = console } = {}) {
  const WebSocket = require('ws');
  const bridge = await access().openPtyBridge({ cwd, title, command, args });
  const ptyId = bridge.pty.id;

  let onData = null, onExit = null;
  let sock = null, closed = false, reconnects = 0;
  const pending = [];                       // input typed before the socket is up
  // …and the mirror problem, which cost a blank terminal until the browser leg
  // caught it: the serve greets the socket with the shell's banner/prompt the
  // instant it opens — BEFORE the session layer has registered onData (the
  // create is still in flight). Whatever arrives first is held here and
  // flushed when the consumer shows up; without this the window opens on an
  // empty screen and only wakes up when the user types.
  let preData = [];

  function connect() {
    const headers = bridge.auth ? { authorization: bridge.auth } : undefined;
    sock = new WebSocket(bridge.url, { headers });
    sock.on('open', () => { reconnects = 0; while (pending.length) { try { sock.send(pending.shift()); } catch { break; } } });
    sock.on('message', (buf, isBinary) => {
      if (isBinary) return;                 // \0-prefixed control json (cursor), never output
      const text = buf.toString('utf8');
      if (!onData) { if (preData.length < 500) preData.push(text); return; }   // bounded: a consumer that never arrives must not grow memory
      try { onData(text); } catch { }
    });
    sock.on('error', (e) => { log?.warn?.(`[opencode-pty] ${ptyId} socket error: ${e.message}`); });
    sock.on('close', () => {
      if (closed) return;
      // the pty lives in the serve: a dropped socket is OUR problem, not the
      // shell's. Reconnect a bounded number of times, then end the session
      // honestly rather than showing a dead-but-open terminal.
      if (reconnects++ >= MAX_RECONNECTS) { closed = true; try { onExit?.({ exitCode: 0 }); } catch { } return; }
      setTimeout(() => { if (!closed) connect(); }, RECONNECT_MS * reconnects).unref?.();
    });
  }
  connect();

  const shim = {
    pid: bridge.pty.pid || -1,
    cols: 0, rows: 0,
    onData: (cb) => {
      onData = cb;
      const held = preData; preData = [];
      for (const chunk of held) { try { cb(chunk); } catch { } }
    },
    onExit: (cb) => { onExit = cb; },
    write: (str) => {
      const data = typeof str === 'string' ? str : String(str);
      if (sock && sock.readyState === 1) { try { sock.send(data); } catch { } }
      else if (pending.length < 200) pending.push(data);   // bounded: a dead socket must not grow memory
    },
    resize: (cols, rows) => {
      shim.cols = cols; shim.rows = rows;
      access().call(null, 'pty-resize', { ptyId, rows, cols, cwd }).catch(() => { });
    },
    kill: () => {
      closed = true;
      try { sock?.close(); } catch { }
      access().call(null, 'pty-close', { ptyId, cwd }).catch((e) => log?.warn?.(`[opencode-pty] ${ptyId} close failed: ${e.message}`));
      try { onExit?.({ exitCode: 0 }); } catch { }
    },
  };
  return { ptyId, shim, pty: bridge.pty };
}

module.exports = { openOpencodePty };
