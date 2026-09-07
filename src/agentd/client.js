// DeviceManager (CS refactor M0, server side) — install / token mint / spawn
// supervision / handshake / self-upgrade for vibespace-agentd instances.
// M0 covers DEVICE #0 (localhost) only, but through the SAME protocol every
// device will use (invariant #3: no local special case — the server talks to
// its own machine over the unix socket like any device).
// Lifecycle decision (design addendum): the daemon is ALWAYS setsid-detached;
// the server supervises BY CONNECT — a failed connect (re)spawns from the
// `current` install with backoff. A server restart never touches the daemon.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Mux, PROTO_VERSION } = require('./mux.js');

class DeviceManager {
  /**
   * @param {object} opts
   *  dataDir      server data/ (token hash store)
   *  bundlePath   built single-file daemon (data/bin/vibespace-agentd.js)
   *  version      release version (= daemonVersion expected)
   *  log          logger fn
   */
  constructor({ dataDir, bundlePath, version, nodeModules, transport, log = console.log } = {}) {
    this._tokFile = path.join(dataDir, 'agentd-tokens.json');
    this._bundlePath = bundlePath;
    this._version = version;
    // The version a freshly-upgraded daemon will REPORT is the one baked into
    // the bundle we ship — not this server's package version. They diverge
    // whenever the repo is rebuilt without restarting the server (or vice
    // versa), and comparing against the wrong one makes the upgrade check
    // UNSATISFIABLE: every reconnect sees a mismatch and upgrades again,
    // forever (real incident 2026-08-13: ~8h of 10s-cycle re-installs, 20GB
    // RSS). Read it from the bundle, cached by mtime+size.
    this._bundleVerCache = null;
    this._nodeModules = nodeModules || null; // so the daemon can require node-pty (M1 localhost)
    this._log = log;
    this._root = process.env.VIBESPACE_AGENTD_ROOT || path.join(os.homedir(), '.vibespace', 'agentd');
    this._state = path.join(this._root, 'state');
    this._sock = path.join(this._state, 'agentd.sock');
    // Transport (M2): { kind:'local' } = unix socket on this machine; or
    // { kind:'ssh', host, remoteAgentd, sshArgs } = dial the STANDING remote
    // daemon over `ssh … -- node <remoteAgentd> --stdio` (the bridge). Default
    // local keeps M0/M1 unchanged.
    this._transport = transport || { kind: 'local' };
    this._conn = null;         // {mux, info}
    this._connecting = false;
    this._stopped = false;
    // reverse forwards (port → connectLocal fn) survive the connection object:
    // re-registered on every reconnect so device-side listeners self-heal
    this._reverseForwards = new Map();
    try { this._tokens = JSON.parse(fs.readFileSync(this._tokFile, 'utf-8')); } catch { this._tokens = {}; }
  }

  status() {
    return {
      connected: !!this._conn,
      info: this._conn?.info || null,
      version: this._version,
      socket: this._sock,
    };
  }

  // ── token: vsht_ minted once for device #0; plaintext ONLY in the device's
  // 0600 state file (invariant #4), sha256 server-side ──
  _ensureLocalToken() {
    fs.mkdirSync(this._state, { recursive: true, mode: 0o700 });
    const devTok = path.join(this._state, 'token');
    let raw = null;
    try { raw = fs.readFileSync(devTok, 'utf-8').trim(); } catch { }
    if (!raw) {
      raw = 'vsht_' + crypto.randomBytes(24).toString('hex');
      fs.writeFileSync(devTok, raw, { mode: 0o600 });
    }
    const sha = crypto.createHash('sha256').update(raw).digest('hex');
    if (this._tokens.local !== sha) {
      this._tokens.local = sha;
      try { fs.writeFileSync(this._tokFile, JSON.stringify(this._tokens, null, 2), { mode: 0o600 }); } catch { }
    }
    return raw;
  }

  // Version baked into the bundle we ship (what an upgraded daemon reports).
  // Falls back to our package version when the marker is unreadable.
  _expectedVersion() {
    try {
      const st = fs.statSync(this._bundlePath);
      const key = st.mtimeMs + ':' + st.size;
      if (this._bundleVerCache?.key === key) return this._bundleVerCache.v;
      const head = fs.readFileSync(this._bundlePath, 'utf-8').slice(0, 400000);
      const m = /VERSION\s*:\s*"([\d.]+)"/.exec(head);
      const v = m ? m[1] : this._version;
      this._bundleVerCache = { key, v };
      return v;
    } catch { return this._version; }
  }

  // ── install: land the built bundle into <root>/<version>/ + repoint current ──
  installLocal() {
    if (!fs.existsSync(this._bundlePath)) throw new Error('agentd bundle missing: ' + this._bundlePath);
    const dir = path.join(this._root, this._version);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dst = path.join(dir, 'agentd.js');
    fs.copyFileSync(this._bundlePath, dst);
    fs.chmodSync(dst, 0o700);
    const curTmp = path.join(this._root, '.current.tmp');
    try { fs.unlinkSync(curTmp); } catch { }
    fs.symlinkSync(dir, curTmp);
    fs.renameSync(curTmp, path.join(this._root, 'current'));
    return dst;
  }

  _spawnLocal() {
    const cur = path.join(this._root, 'current', 'agentd.js');
    if (!fs.existsSync(cur)) this.installLocal();
    const child = spawn(process.execPath, [path.join(this._root, 'current', 'agentd.js')], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, ...(this._nodeModules ? { VIBESPACE_NODE_MODULES: this._nodeModules } : {}) },
    });
    child.unref();
    this._log(`[agentd] spawned local daemon pid=${child.pid}`);
  }

  /** connect (spawning if needed) — resolves with {mux, info}; retries internally. */
  async connect() {
    if (this._conn) return this._conn;
    if (this._connecting) return this._connectPromise;
    this._connecting = true;
    this._connectPromise = this._connectLoop();
    try { return await this._connectPromise; }
    finally { this._connecting = false; }
  }

  async _connectLoop() {
    const token = this._transport.kind === 'local' ? this._ensureLocalToken() : this._transport.hostToken;
    const backoffs = [500, 1000, 2000, 5000];
    for (let attempt = 0; !this._stopped; attempt++) {
      const conn = await this._tryOnce(token).catch(() => null);
      if (conn) return conn;
      if (attempt === 0 && this._transport.kind === 'local') this._spawnLocal(); // local: bring the daemon up (ssh bridge self-spawns the remote one)
      const delay = backoffs[Math.min(attempt, backoffs.length - 1)];
      await new Promise((r) => setTimeout(r, delay));
      if (attempt > 12) throw new Error('agentd: cannot reach the local daemon');
    }
    throw new Error('stopped');
  }

  _openTransport() {
    if (this._transport.kind === 'stream') {
      // Transport B consumption: a device that DIALED IN. Its ws stream is
      // handed to us via getStream() (the server's agentdDials registry). A
      // single-use stream — if it's gone (device disconnected), throw so the
      // connect loop backs off and retries; the device's --dial reconnects and
      // a fresh stream appears.
      const s = this._transport.getStream?.();
      if (!s) throw new Error('dial device not connected');
      return s;
    }
    if (this._transport.kind === 'ssh') {
      const t = this._transport;
      const remoteCmd = t.remoteCmd || `node ${JSON.stringify(t.remoteAgentd)} --stdio`;
      const child = spawn(t.sshBin || 'ssh', [...t.sshArgs, '--', remoteCmd], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      // stdin/stdout errors arrive ASYNC as 'error' events on the pipe socket
      // itself — the write wrapper's try/catch only stops sync throws, so a
      // dying ssh child (heartbeat PING → write EPIPE on its stdin) was an
      // UNCAUGHT exception that took the whole server down (2.241.1, userN's
      // 10:34 exit-code-1: crashed 28s after boot during the reattach storm).
      // Swallow here; the 'close' event drives mux teardown + reconnect.
      child.stdin.on('error', () => {});
      child.stdout.on('error', () => {});
      // present the child as a duplex stream for the Mux (write→stdin, data←stdout)
      return {
        write: (d) => { try { return child.stdin.write(d); } catch { return false; } },
        on: (ev, fn) => {
          if (ev === 'data') child.stdout.on('data', fn);
          else if (ev === 'close') { child.on('close', fn); child.stdout.on('close', fn); }
          else if (ev === 'error') child.on('error', fn);
        },
        destroy: () => { try { child.kill(); } catch {} },
      };
    }
    return net.connect(this._sock);
  }

  _tryOnce(token) {
    return new Promise((resolve, reject) => {
      const sock = this._openTransport();
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; try { sock.destroy(); } catch { } reject(e || new Error('connect failed')); } };
      sock.on('error', fail);
      const timer = setTimeout(() => fail(new Error('handshake timeout')), 8000);
      const mux = new Mux(sock, {
        onControl: (msg) => {
          if (msg.op === 'hello-ack') {
            clearTimeout(timer);
            const expected = this._expectedVersion();
            // LOOP BREAKER (2.330.0): an upgrade that does not change the
            // reported version can never converge — a daemon that fails to
            // install, a stale singleton that will not die, a host missing
            // node. Retry a bounded number of times, then KEEP THE LINK and
            // say so loudly. Capability gating already makes an older daemon
            // safe to talk to; spinning forever is not (it re-installed every
            // ~10s for 8h, drove RSS to 20GB and produced no error anywhere).
            if (msg.daemonVersion !== expected && this._upgradeTries > 2) {
              if (!this._upgradeGaveUp) {
                this._upgradeGaveUp = true;
                this._log(`[agentd] daemon stays at ${msg.daemonVersion} after ${this._upgradeTries} upgrade attempts to ${expected} — GIVING UP and using it as-is (capability-gated). Fix the device install manually; no further attempts this connection.`);
                try { global.__vsEvent?.('agentd-upgrade-stuck', { detail: `${msg.daemonVersion}→${expected}` }); } catch { }
                try { this._onUpgradeStuck?.(msg.daemonVersion, expected); } catch { }
              }
            } else if (msg.daemonVersion !== expected && fs.existsSync(this._bundlePath)) {
              this._upgradeTries = (this._upgradeTries || 0) + 1;
              // version drift → stream the new bundle (self-upgrade), then reconnect
              this._log(`[agentd] daemon ${msg.daemonVersion} ≠ ${expected} — upgrading (attempt ${this._upgradeTries}/3)`);
              this._upgrade(mux).then(() => {
                settled = true;
                try { sock.destroy(); } catch { }
                setTimeout(() => resolve(this._connectLoop()), 700); // re-exec window
              }).catch(fail);
              return;
            }
            if (msg.daemonVersion === expected) { this._upgradeTries = 0; this._upgradeGaveUp = false; }
            mux.control({ op: 'ok' });
            settled = true;
            const sessions = new Map(); // chan → { onData, onExit }
            const pending = new Map();  // id → resolve (fs/discovery/cmd/tcp acks)
            this._conn = { mux, info: msg, sessions, pending, nextChan: 2, nextId: 1 };
            // route byte-channel data + session control to the session handlers.
            // A handler may set manualCredit and credit as it truly consumes
            // (backpressure for socket-piping consumers).
            mux.onData = (chan, buf) => {
              const s = sessions.get(chan);
              s?.onData?.(buf);
              if (!s?.manualCredit) mux.credit(chan, buf.length);
            };
            mux.onWritable = (chan) => { sessions.get(chan)?.onWritable?.(); };
            const prevControl = mux.onControl;
            mux.onControl = (m) => {
              if (m.op === 'fs-result' || m.op === 'discovery-result' || m.op === 'discovery-watching' || m.op === 'usage-events-watching' || m.op === 'session-events-watching' || m.op === 'cmd-result' || m.op === 'probe-result' || m.op === 'secret-result' || m.op === 'quota-result' || m.op === 'sysinfo-result' || m.op === 'proc-list-result' || m.op === 'opencode-serve-result' || m.op === 'peer-post-result' || m.op === 'pool-orders-ok' || m.op === 'tcp-open' || m.op === 'listen-open' || m.op === 'serve-folder-result' || m.op === 'serve-socks-result') {
                const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); }
                if (m.op === 'tcp-open' && !m.error) return; // channel stays live
                return;
              }
              // reverse forward: the daemon accepted a device-local connection
              // on a listener we registered — pipe it to our local target
              if (m.op === 'tcp-accept') { this._onTcpAccept(m); return; }
              if (m.op === 'fs-done') { sessions.get(m.chan)?.onDone?.(m); return; }
              if (m.op === 'stream-start') { const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } return; }
              // stream-exit rides the control channel and can OVERTAKE queued
              // stdout (same class as the fs-done truncation) — a handler that
              // sets onExitMsg keeps its registration and settles itself once
              // the counted bytes landed; legacy handlers keep the old delete.
              if (m.op === 'stream-exit') {
                const h = sessions.get(m.chan);
                if (h?.onExitMsg) { h.onExitMsg(m); return; }
                sessions.delete(m.chan); h?.onExit?.(m.code, m.error); return;
              }
              if (m.op === 'tcp-close') { const h = sessions.get(m.chan); sessions.delete(m.chan); h?.onClose?.(); return; }
              if (m.op === 'discovery-dirty') { this._onDiscoveryDirty?.(); return; }
              if (m.op === 'usage-events') { this._onUsageEvents?.(m); return; }
              if (m.op === 'session-events') { this._onSessionEvents?.(m); return; } // step-2 dark stream (unsolicited push branch — the three-touch rule)
              if (m.op === 'pool-orders-executed') { this._onPoolOrdersExecuted?.(m.events || []); return; }
              if (m.op === 'session-open' || m.op === 'pipe-session-open') { sessions.get(m.chan)?.onOpen?.(m); return; }
              if (m.op === 'session-exit') { const h = sessions.get(m.chan); sessions.delete(m.chan); h?.onExit?.(m.code); return; }
              if (m.op === 'session-error') { const h = sessions.get(m.chan); sessions.delete(m.chan); h?.onError?.(m.error); return; }
              prevControl(m);
            };
            mux.onDead = () => {
              // Tear down local sockets we opened for reverse-forward accepts
              // (mirrors the daemon's own onDead). Without this, each accepted
              // /dav connection's socket + its listeners leak on every link
              // drop — the reconnect self-heal re-listens but never reconciles
              // the stale sockets (review finding, client.js:206).
              // ALSO fire onExit: pty/pipe session handles wire onExit, not
              // onClose — a daemon re-exec (self-upgrade) otherwise left the
              // server holding a silently-dead pty shim, so the detach-path
              // auto-reattach never ran and local terminals froze/blanked
              // until a page reload (real report, 3× in one evening).
              for (const s of sessions.values()) { try { s.onClose?.(); } catch { } try { s.onExit?.(-1); } catch { } }
              sessions.clear();
              this._conn = null;
              this._log('[agentd] connection lost');
            };
            resolve(this._conn);
            // self-heal reverse forwards: re-own each registered device port
            for (const [port] of this._reverseForwards) {
              this._request({ op: 'tcp-listen', port }).catch(() => { });
            }
            // re-arm the discovery watch (R4: it also drives the push-
            // triggered usage harvest) — the daemon-side watch survives, but
            // a RESTARTED daemon starts unwatched; idempotent either way
            if (this._onDiscoveryDirty) this._request({ op: 'discovery-watch' }).catch(() => { });
            if (this._onUsageEvents) this._request({ op: 'usage-events-watch' }).catch(() => { });
            if (this._onSessionEvents) this._request({ op: 'session-events-watch' }).catch(() => { }); // session-brain step 2 re-arm
            return;
          }
          if (msg.op === 'auth-fail') fail(new Error('agentd auth failed — token mismatch'));
          if (msg.op === 'proto-mismatch') fail(new Error('agentd protocol mismatch'));
        },
        onDead: () => fail(new Error('connection died during handshake')),
      });
      const sayHello = () => mux.control({ op: 'hello', protoVersion: PROTO_VERSION, hostToken: token, serverVersion: this._version });
      // ssh stdio + a dialed-in ws stream are already connected at open; a unix
      // socket needs its 'connect' event first.
      if (this._transport.kind === 'ssh' || this._transport.kind === 'stream') sayHello();
      else sock.on('connect', sayHello);
    });
  }

  async _upgrade(mux) {
    const bundle = fs.readFileSync(this._bundlePath);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('upgrade timeout')), 30000);
      const origOnControl = mux.onControl;
      mux.onControl = (msg) => {
        if (msg.op === 'upgrade-done') { clearTimeout(timer); mux.onControl = origOnControl; resolve(); }
        else origOnControl(msg);
      };
      mux.control({ op: 'upgrade', version: this._version, size: bundle.length });
      // stream on chan 1 in credit-sized slices (the mux queues past the window)
      for (let off = 0; off < bundle.length; off += 65536) {
        mux.data(1, bundle.subarray(off, Math.min(off + 65536, bundle.length)));
      }
    });
  }

  /**
   * Open a device-side session: the daemon spawns the pty and relays bytes.
   * Returns a handle { write(str), resize(cols,rows), kill(), onData, onExit,
   * ready } — onData/onExit are set by the caller before/after; ready resolves
   * with {pid} on session-open or rejects on session-error.
   */
  async openSession({ cmd, args, cols, rows, cwd, env }) {
    const conn = await this.connect();
    const chan = conn.nextChan++;
    const handle = { chan, onData: null, onExit: null };
    let resolveReady, rejectReady, readySettled = false;
    handle.ready = new Promise((res, rej) => {
      resolveReady = (v) => { readySettled = true; res(v); };
      rejectReady = (e) => { readySettled = true; rej(e); };
    });
    conn.sessions.set(chan, {
      onOpen: (m) => { handle.pid = m.pid; resolveReady({ pid: m.pid }); },
      onError: (e) => rejectReady(new Error(e)),
      onData: (buf) => handle.onData?.(buf),
      // Pre-ready link death (2.271.0 T1-6): reject `ready` so a terminal-on-
      // dial open that races a link drop fails visibly instead of hanging.
      onExit: (code) => { if (!readySettled) rejectReady(new Error('device link lost before session opened')); else handle.onExit?.(code); },
      onClose: () => { if (!readySettled) rejectReady(new Error('device link lost before session opened')); },
    });
    handle.write = (str) => conn.mux.data(chan, Buffer.from(str, 'utf-8'));
    handle.resize = (c, r) => conn.mux.control({ op: 'resize-session', chan, cols: c, rows: r });
    handle.kill = () => conn.mux.control({ op: 'kill-session', chan });
    conn.mux.control({ op: 'open-session', chan, cmd, args, cols, rows, cwd, env });
    return handle;
  }

  /**
   * Open/attach a PERSISTENT pipe session (chat-class; keeper semantics — the
   * child is daemon-owned, setsid-detached, buffer-file backed). Reattach with
   * a byte offset; the {type:'_remote_exit'} sentinel line in the byte stream
   * means the child really ended. Omit cmd to attach-only.
   */
  async openPipeSession({ sid, cmd, args, cwd, env, offset = 0 }) {
    const conn = await this.connect();
    const chan = conn.nextChan++;
    const handle = { chan, sid, onData: null, onExit: null };
    let resolveReady, rejectReady, readySettled = false;
    handle.ready = new Promise((res, rej) => {
      resolveReady = (v) => { readySettled = true; res(v); };
      rejectReady = (e) => { readySettled = true; rej(e); };
    });
    conn.sessions.set(chan, {
      onOpen: (m) => { handle.pid = m.pid; resolveReady({ pid: m.pid, existing: !!m.existing, exited: m.exited }); },
      onError: (e) => rejectReady(new Error(e)),
      onData: (buf) => handle.onData?.(buf),
      // Pre-ready link death (2.271.0 T1-6, the pre-ready twin of the B-b87b
      // CRITICAL): mux.onDead fires onExit(-1)/onClose before the daemon's
      // open reply — if `ready` is still pending the bridge would `await` it
      // FOREVER and the dial chat/terminal window stayed blank with no error.
      // Reject ready when the link dies unsettled; else pass the real exit on.
      onExit: (code) => { if (!readySettled) rejectReady(new Error('device link lost before session opened')); else handle.onExit?.(code); },
      onClose: () => { if (!readySettled) rejectReady(new Error('device link lost before session opened')); },
    });
    handle.write = (str) => conn.mux.data(chan, Buffer.from(str, 'utf-8'));
    handle.kill = () => conn.mux.control({ op: 'kill-pipe-session', sid });
    conn.mux.control(cmd
      ? { op: 'open-pipe-session', chan, sid, cmd, args, cwd, env, offset }
      : { op: 'attach-pipe-session', chan, sid, offset });
    return handle;
  }

  async _request(payload) {
    const conn = await this.connect();
    const id = conn.nextId++;
    return new Promise((resolve, reject) => {
      conn.pending.set(id, (m) => (m.error ? reject(new Error(m.error)) : resolve(m)));
      conn.mux.control({ ...payload, id });
      setTimeout(() => { if (conn.pending.delete(id)) reject(new Error(payload.op + ' timeout')); }, payload.timeoutMs || 30000);
    });
  }

  /** Kill a daemon pipe session by sid without attaching (the dial-chat
   *  terminate path — SIGTERM→SIGKILL escalation happens daemon-side). */
  async killPipeSession(sid) {
    const conn = await this.connect();
    conn.mux.control({ op: 'kill-pipe-session', sid });
  }

  // ── M3 ──
  fsStat(p) { return this._request({ op: 'fs-op', action: 'stat', path: p }); }
  fsList(p) { return this._request({ op: 'fs-op', action: 'list', path: p }); }
  fsWrite(p, buf) { return this._request({ op: 'fs-op', action: 'write', path: p, data64: Buffer.from(buf).toString('base64') }); }
  fsRename(p, to) { return this._request({ op: 'fs-op', action: 'rename', path: p, to }); }
  fsMkdir(p) { return this._request({ op: 'fs-op', action: 'mkdir', path: p }); }
  fsRm(p, recursive = false) { return this._request({ op: 'fs-op', action: 'rm', path: p, recursive }); }
  /** read [start, start+len) — resolves a Buffer (the transcript-slab primitive).
   *  COUNT-GATED: fs-done rides the credit-EXEMPT control channel, so it can
   *  OVERTAKE data still queued daemon-side behind the 256KB credit window —
   *  resolving on fs-done alone truncated every read past the in-flight window
   *  to exactly INITIAL_WINDOW bytes (real incident: a 45MB remote transcript
   *  cached as a 256KB prefix and stamped complete = permanently ancient chat
   *  history). Resolve only once the expected byte count (ack.sending,
   *  adjusted down by fs-done's `sent` if the file shrank mid-read) has
   *  actually arrived; a 30s data stall rejects so callers can fall back. */
  async fsReadRange(p, start, len) {
    const conn = await this.connect();
    const chan = conn.nextChan++;
    const chunks = [];
    // NOTE: mux frames dispatch SYNCHRONOUSLY in one socket-read burst, so for
    // a big read the burst is [ack, ~window of data, fs-done] and the awaited
    // ack's continuation (a microtask) runs only AFTER fs-done was handled —
    // never derive the target from "bytes seen at done time".
    let received = 0, sending = null, sentDone = null, doneSeen = false, legacy = false, stall = null;
    let resolveP, rejectP;
    const donePromise = new Promise((res, rej) => { resolveP = res; rejectP = rej; });
    donePromise.catch(() => {}); // a stall while still awaiting the ack must not be an unhandled rejection
    const cleanup = () => { clearTimeout(stall); conn.sessions.delete(chan); };
    const bumpStall = () => { clearTimeout(stall); stall = setTimeout(() => { cleanup(); rejectP(new Error('read-range stalled')); }, 30000); };
    const maybeFinish = () => {
      if (!doneSeen) return;
      const t = sentDone != null ? (sending != null ? Math.min(sentDone, sending) : sentDone) : sending;
      if (t != null ? received >= t : legacy) { cleanup(); resolveP(); }
    };
    conn.sessions.set(chan, {
      onData: (b) => { chunks.push(b); received += b.length; bumpStall(); maybeFinish(); },
      onDone: (m) => { doneSeen = true; if (typeof m?.sent === 'number') sentDone = m.sent; maybeFinish(); },
    });
    bumpStall();
    const ack = await this._request({ op: 'fs-op', action: 'read-range', path: p, start, len, chan });
    if (ack?.error) { cleanup(); throw new Error(ack.error); }
    if (typeof ack?.sending === 'number') sending = ack.sending;
    else legacy = true; // ancient daemon without counts: resolve on fs-done like before
    maybeFinish();
    await donePromise;
    return { size: ack.size, data: Buffer.concat(chunks) };
  }
  discoverySnapshot() { return this._request({ op: 'discovery-snapshot' }); }
  /** R5 `discovery.v2` (DARK): the device interprets its OWN snapshot into
   *  session cards with the shared functions — the server's job shrinks to
   *  cross-machine merging. Capability-gated (unknown ops hang old daemons). */
  async discoveryClaims({ hostId, hostName, forceInline } = {}) {
    const conn = await this.connect();
    if (!conn.info?.capabilities?.includes?.('discovery-claims')) throw new Error('daemon lacks discovery-claims (capabilities gate)');
    return this._request({ op: 'discovery-claims', hostId, hostName, forceInline, timeoutMs: 40000 });
  }
  async watchDiscovery(onDirty) { this._onDiscoveryDirty = onDirty; return this._request({ op: 'discovery-watch' }); }

  /** Subscribe the usage-events PUSH stream (R4 finale). onBatch({batch, seq})
   *  fires per chunk; when a chunk carries `seq`, call ackUsageEvents(seq)
   *  AFTER durable ingest — that commits the device-side cursor (two-phase;
   *  an unacked batch re-emits and the server's rid dedup absorbs it). */
  async watchUsageEvents(onBatch) {
    this._onUsageEvents = onBatch;
    const conn = await this.connect();
    if (!conn.info?.capabilities?.includes?.('usage-events')) throw new Error('daemon lacks usage-events (capabilities gate)');
    const r = await this._request({ op: 'usage-events-watch', timeoutMs: 20000 });
    if (r?.error) throw new Error(r.error); // an error-ack resolves — never swallow it
    return true;
  }
  /** Push a pool's sealed orders (ranked member snapshot) to the device;
   *  null clears. onExecuted(events) receives fallback switches the device
   *  performed while no orchestrator was reachable — call ackPoolOrdersLog()
   *  after recording them. */
  async poolOrders(orders, onExecuted) {
    if (onExecuted) this._onPoolOrdersExecuted = onExecuted;
    const conn = await this.connect();
    if (!conn.info?.capabilities?.includes?.('pool-orders')) throw new Error('daemon lacks pool-orders (capabilities gate)');
    const r = await this._request({ op: 'pool-orders', orders, timeoutMs: 15000 });
    if (r?.error) throw new Error(r.error);
    if (r?.events?.length && this._onPoolOrdersExecuted) this._onPoolOrdersExecuted(r.events);
    return r?.events || [];
  }
  ackPoolOrdersLog() { try { this._conn?.mux?.control({ op: 'pool-orders-log-ack' }); } catch { } }

  ackUsageEvents(seq) {
    try { this._conn?.mux?.control({ op: 'usage-events-ack', seq }); } catch { }
  }
  // ── M4 ──
  /** R1 machine facts (shared src/machine-probes.js runs daemon-side).
   *  Old daemons don't know these ops — callers bound with a timeout and
   *  fall back to the legacy ssh scripts. */
  probeCli() { return this._request({ op: 'probe-cli', timeoutMs: 9000 }); }
  probeCreds() { return this._request({ op: 'probe-creds', timeoutMs: 9000 }); }
  /** R3 transcript.* — run one transcript-service method ON the device and
   *  return the parsed JSON result. The result streams on a byte channel with
   *  the read-range count-gating contract (never resolve on the done marker:
   *  control overtakes data, 2.187.0). DARK: no production consumer yet — the
   *  parity suite is the only caller until the switchover round. */
  async transcriptOp(method, ref, params = {}) {
    const conn = await this.connect();
    const chan = conn.nextChan++;
    const chunks = [];
    let received = 0, sending = null, sentDone = null, doneSeen = false, stall = null;
    let resolveP, rejectP;
    const donePromise = new Promise((res, rej) => { resolveP = res; rejectP = rej; });
    donePromise.catch(() => {});
    const cleanup = () => { clearTimeout(stall); conn.sessions.delete(chan); };
    const bumpStall = () => { clearTimeout(stall); stall = setTimeout(() => { cleanup(); rejectP(new Error('transcript-op stalled')); }, 30000); };
    const maybeFinish = () => {
      if (!doneSeen) return;
      const t = sentDone != null ? (sending != null ? Math.min(sentDone, sending) : sentDone) : sending;
      if (t != null && received >= t) { cleanup(); resolveP(); }
    };
    conn.sessions.set(chan, {
      onData: (b) => { chunks.push(b); received += b.length; bumpStall(); maybeFinish(); },
      onDone: (m) => { doneSeen = true; if (typeof m?.sent === 'number') sentDone = m.sent; maybeFinish(); },
    });
    bumpStall();
    // parse can legitimately take a while on a huge transcript — generous ack timeout
    const ack = await this._request({ op: 'transcript-op', method, ref, params, chan, timeoutMs: 60000 });
    if (ack?.error) { cleanup(); throw new Error(ack.error); }
    if (typeof ack?.sending === 'number') sending = ack.sending;
    else { cleanup(); throw new Error('daemon lacks transcript-op counts'); }
    maybeFinish();
    await donePromise;
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  }
  runCmd(cmd, args = [], { stdin, env, timeoutMs } = {}) {
    return this._request({ op: 'run-cmd', cmd, args, env, timeoutMs, stdin64: stdin ? Buffer.from(stdin).toString('base64') : undefined });
  }
  /** streaming argv exec: stdout arrives via onData (byte channel); resolves
   *  {code} at exit. For outputs too large for runCmd (usage-scan NDJSON).
   *  COUNT-GATED like fsReadRange: a NEW daemon's stream-exit carries `sent`
   *  (total stdout bytes) — the resolve holds until that many arrived, so the
   *  credit-gated tail can't be overtaken and silently dropped (truncated
   *  usage harvests / streamed downloads). Old daemons omit it → resolve at
   *  exit as before. A 15s post-exit stall resolves {truncated:true}. */
  runStream(cmd, args = [], { env, cwd, stdin, onData } = {}) {
    return this._streamOp({ op: 'run-stream', cmd, args, env, cwd, stdin64: stdin ? Buffer.from(stdin).toString('base64') : undefined }, { onData });
  }
  /** ONE streaming-op consumer (run-stream + usage-scan): count-gated settle
   *  (stream-exit's `sent` vs received), link-death settles, deadline belt. */
  async _streamOp(req, { onData } = {}) {
    const conn = await this.connect();
    const chan = conn.nextChan++;
    let exitR;
    const done = new Promise((r) => { exitR = r; });
    let received = 0, exitMsg = null, stall = null, settled = false;
    const settle = (extra) => {
      if (settled) return; settled = true;
      clearTimeout(stall); conn.sessions.delete(chan);
      exitR({ code: exitMsg?.code, error: exitMsg?.error, ...(extra || {}) });
    };
    const check = () => {
      if (!exitMsg) return;
      if (typeof exitMsg.sent !== 'number' || received >= exitMsg.sent) return settle();
      clearTimeout(stall); stall = setTimeout(() => settle({ truncated: true }), 15000);
    };
    conn.sessions.set(chan, {
      onData: (b) => { received += b.length; onData?.(b); check(); },
      onExitMsg: (m) => { exitMsg = m; check(); },
      // Link death mid-stream (2.271.0 T1-5): mux.onDead fires onClose/onExit —
      // WITHOUT these the `done` promise NEVER settled, so a single device flap
      // during a usage harvest hung hosts.harvestUsage forever and pinned
      // _harvestBusy true for every host until a server restart.
      onClose: () => settle({ error: 'device link lost' }),
      onExit: () => settle({ error: 'device link lost' }),
    });
    // Overall deadline belt: even absent a clean onClose/onExit (a wedged
    // half-open link that never errors), never leave the caller hanging.
    const deadline = setTimeout(() => settle({ error: 'run-stream timed out' }), 120000);
    if (deadline.unref) deadline.unref();
    done.finally?.(() => clearTimeout(deadline));
    const ack = await this._request({ ...req, chan });
    if (ack.error) { conn.sessions.delete(chan); clearTimeout(stall); throw new Error(ack.error); }
    return done;
  }
  /** R4 `usage.scan`: run the daemon's BUNDLED ledger walker (no per-harvest
   *  script ship) — returns {ndjson, cursors, cursorFile}. The device does
   *  NOT persist the cursor; the caller commits it (fsWrite+fsRename) only
   *  after this resolves, i.e. after the full transfer landed (two-phase).
   *  Old daemons never answer unknown ops (they'd hang the request), so gate
   *  on the hello's daemonVersion and throw fast → caller falls back. */
  /** Place a secret file (0600, atomic) on the device — THE sanctioned secret
   *  channel; capability-gated so old daemons fall back to fsWrite+chmod. */
  async placeSecret(remotePath, buf) {
    const conn = await this.connect();
    if (!conn.info?.capabilities?.includes?.('place-secret')) throw new Error('daemon lacks place-secret (capabilities gate)');
    const r = await this._request({ op: 'place-secret', path: remotePath, data: Buffer.from(buf).toString('base64'), timeoutMs: 15000 });
    if (r.error) throw new Error(r.error);
    return r.path;
  }

  /** Human-gated quota refresh executed ON the device (its own token, its own
   *  IP — design §Quota refresh origin). Never called from any scheduler. */
  async watchSessionEvents(cb) {
    // Session-brain step 2: subscribe to the daemon's device-side normalizer
    // stream (dark — the caller compares, it must NOT act on these yet).
    this._onSessionEvents = cb;
    const conn = await this.connect();
    if (!conn.info?.capabilities?.includes?.('session-events')) throw new Error('daemon lacks session-events (capabilities gate)');
    await this._request({ op: 'session-events-watch' });
  }

  async sysinfo() {
    const conn = await this.connect();
    if (!conn.info?.capabilities?.includes?.('sysinfo')) throw new Error('daemon lacks sysinfo (capabilities gate)');
    const r = await this._request({ op: 'sysinfo', timeoutMs: 15000 });
    if (r.error) throw new Error(r.error);
    const { id, op, ...rest } = r;
    return rest;
  }

  /** One OpenCode-serve op on THIS device (S9 remainder piece (e), B-eac2).
   *  The op names and shapes come from the SHARED table src/opencode-remote.js
   *  -- the daemon runs the very same runOpencodeOp() against its own facts,
   *  so `hostId` really is only a transport choice. Capability-gated: an old
   *  daemon that does not know the op would HANG (the 2.300.0 rule). */
  async opencodeServe(action, params = {}, { timeoutMs = 20000 } = {}) {
    const conn = await this.connect();
    if (!conn.info?.capabilities?.includes?.('opencode-serve')) throw new Error('daemon lacks opencode-serve (capabilities gate) -- upgrade the agent on this machine');
    const r = await this._request({ op: 'opencode-serve', action, params, timeoutMs });
    if (r.error) throw new Error(r.error);
    return r.result || {};
  }

  /** Full process table (System panel process manager, 2.354.0). */
  async procList({ max } = {}) {
    const conn = await this.connect();
    if (!conn.info?.capabilities?.includes?.('proc-list')) throw new Error('daemon lacks proc-list (capabilities gate)');
    const r = await this._request({ op: 'proc-list', max, timeoutMs: 15000 });
    if (r.error) throw new Error(r.error);
    const { id, op, ...rest } = r;
    return rest;
  }

  /** Post one message into a conversation whose CLI runs on THIS device
   *  (2.362.0 cross-machine delivery rung). */
  async peerPost({ cid, text }) {
    const conn = await this.connect();
    if (!conn.info?.capabilities?.includes?.('peer-post')) throw new Error('daemon lacks peer-post (capabilities gate)');
    const r = await this._request({ op: 'peer-post', cid, text, timeoutMs: 15000 });
    if (r.error) throw new Error(r.error);
    const { id, op, ...rest } = r;
    return rest;
  }

  async quotaRefresh({ subDir = null, humanGated = false } = {}) {
    const conn = await this.connect();
    if (!conn.info?.capabilities?.includes?.('quota-refresh')) throw new Error('daemon lacks quota-refresh (capabilities gate)');
    const r = await this._request({ op: 'quota-refresh', subDir, humanGated, timeoutMs: 40000 });
    if (r.error) throw new Error(r.error);
    return { usage: r.usage, roles: r.roles, passive: r.passive || null };
  }

  async usageScan({ cursorFile } = {}) {
    const conn = await this.connect();
    if (!conn.info?.capabilities?.includes?.('usage-scan')) throw new Error('daemon lacks usage-scan (capabilities gate)');
    const chunks = [];
    const r = await this._streamOp({ op: 'usage-scan', cursorFile }, { onData: (buf) => chunks.push(buf) });
    if (r.error) throw new Error(r.error);
    if (r.truncated) throw new Error('usage-scan stream truncated');
    if (r.code !== 0) throw new Error('usage-scan exit ' + r.code);
    const lines = Buffer.concat(chunks).toString('utf-8').split('\n').filter((l) => l.trim());
    let cursors = null, cf = null;
    if (lines.length) {
      try {
        const last = JSON.parse(lines[lines.length - 1]);
        if (last && last.__cursors__) { cursors = last.__cursors__; cf = last.__cursorFile__ || null; lines.pop(); }
      } catch { }
    }
    if (!cursors) throw new Error('usage-scan output missing cursor manifest');
    return { ndjson: lines.length ? lines.join('\n') + '\n' : '', cursors, cursorFile: cf };
  }

  /** loopback TCP forward on the device: returns {write, close, onData, onClose}. */
  async tcpForward(port, host) {
    const conn = await this.connect();
    const chan = conn.nextChan++;
    const handle = { chan, onData: null, onClose: null };
    conn.sessions.set(chan, { onData: (b) => handle.onData?.(b), onClose: () => handle.onClose?.() });
    // host defaults to loopback on the device; an explicit host reaches the
    // device's LAN (a user-driven forward to another internal machine)
    await this._request({ op: 'tcp-connect', port, chan, ...(host && host !== '127.0.0.1' ? { host } : {}) });
    handle.write = (b) => conn.mux.data(chan, Buffer.isBuffer(b) ? b : Buffer.from(b));
    handle.close = () => { conn.sessions.delete(chan); conn.mux.closeChan(chan); };
    return handle;
  }

  // ── REVERSE forward (the tunnel primitive, "互挂云盘"): the daemon binds
  // 127.0.0.1:<port> ON THE DEVICE; every accepted connection is pushed back
  // here and piped into connectLocal() (usually our own HTTP port). NAT-proof
  // by construction — the bytes ride whatever link the device already has
  // (ssh stdio or wss dial-out). Registration survives reconnects. ──
  async reverseForward({ port = 0, connectLocal }) {
    const ack = await this._request({ op: 'tcp-listen', port });
    this._reverseForwards.set(ack.port, connectLocal);
    return { port: ack.port };
  }
  async reverseUnforward(port) {
    this._reverseForwards.delete(port);
    try { await this._request({ op: 'tcp-unlisten', port }); } catch { }
  }

  // ── device-folder-mount: serve a device folder over HTTP (the daemon binds
  // 127.0.0.1:<port>), returns {port}. The server tcp-forwards that port and
  // rclone-http-mounts it. unserveFolder tears the server down. ──
  serveFolder(path) { return this._request({ op: 'serve-folder', path }); }
  unserveFolder(port) { return this._request({ op: 'unserve-folder', port }); }

  // on-demand egress: the device serves a SOCKS5 proxy on its loopback, the
  // server reaches it via tcpForward (the exit-proxy shape). CONNECT only.
  serveSocks() { return this._request({ op: 'serve-socks' }); }
  unserveSocks(port) { return this._request({ op: 'unserve-socks', port }); }
  _onTcpAccept(m) {
    const conn = this._conn;
    if (!conn) return;
    const mkLocal = this._reverseForwards.get(m.port);
    const reject = () => { try { conn.mux.closeChan(m.chan); } catch { } };
    if (!mkLocal) return reject();
    let sock;
    try { sock = mkLocal(); } catch { return reject(); }
    const { mux, sessions } = conn;
    sessions.set(m.chan, {
      manualCredit: true, // credit as the local socket truly drains
      onData: (b) => {
        let ok = false; try { ok = sock.write(b); } catch { }
        if (ok) mux.credit(m.chan, b.length);
        else sock.once('drain', () => { try { mux.credit(m.chan, b.length); } catch { } });
      },
      onClose: () => { try { sock.destroy(); } catch { } },
      onWritable: () => { try { sock.resume(); } catch { } },
    });
    sock.on('data', (d) => { try { if (!mux.data(m.chan, d)) sock.pause(); } catch { } });
    sock.on('close', () => { if (sessions.delete(m.chan)) { try { mux.closeChan(m.chan); } catch { } } });
    sock.on('error', () => { });
  }

  stop() { this._stopped = true; this._conn?.mux?.destroy(); this._conn = null; }
}

module.exports = { DeviceManager };
