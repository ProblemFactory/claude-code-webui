// PluginManager (2.140.0, B-2d44) — a GENERIC mechanism for host-level
// capabilities that need: an install step, PERSISTENT state across pod
// rebuilds (everything lives under ~/.vibespace/plugins/<id>/ — the home dir
// is the per-user PVC in fleet deployments), a boot-time replay (rootfs is
// volatile — enabled plugins restart with the server), a guided setup flow
// (auth URLs surfaced to the UI like the Drive OAuth flow), and live status.
//
// First plugin: TAILSCALE. Dual mode —
//   • kernel: /dev/net/tun usable (+ root or passwordless sudo) → full tunnel
//     (SMB/NFS mounts to tailnet hosts work). Helm exposes an optional tun
//     device + NET_ADMIN for this.
//   • userspace: no tun needed, runs as the plain user —
//     `--tun=userspace-networking` + a local SOCKS5/HTTP proxy (ssh/http to
//     tailnet hosts work through localhost:<port>).
// A SYSTEM tailscaled (the dev-machine case) is detected and reported, never
// managed. Our instance runs with its OWN --socket and --statedir so it can
// coexist with a system daemon. The node key lives in the statedir → a pod
// rebuild reconnects WITHOUT re-login (the whole point).
//
// THIRD plugin: OPENCODE-SERVE (2026-09-07, owner decision) — the background
// `opencode serve` that lets STOPPED OpenCode conversations list / open /
// resume / fork. It is DEFAULT OFF and exists as a plugin precisely so the
// user turns a third-party background daemon on DELIBERATELY (the 2.369.42
// runaway is why). This manager is only the CONTROL SURFACE: the serve facts,
// keeper and resource guard stay in the SHARED module src/opencode-serve.js
// (ONE implementation) — here we own enabled/desiredUp/prompted, boot replay
// and the status the UI renders.
//
// State: data/plugins.json { plugins: { <id>: { enabled, config, desiredUp } } }
// (enabled = replay at boot; runtime pid/state live in the plugin dir itself).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');

const PLUGIN_ROOT = path.join(os.homedir(), '.vibespace', 'plugins');
const SOCKS_PORT = Number(process.env.VIBESPACE_TAILSCALE_SOCKS_PORT || 1055);

// frp (B-0b60 public port exposure): the frps RELAY server is shared fleet
// infra — its address/port/token are INJECTED via env (helm/deploy), never in
// the repo. Absent → the plugin reports configured:false and does nothing.
const FRPS_ADDR = process.env.VIBESPACE_FRPS_ADDR || '';
const FRPS_PORT = Number(process.env.VIBESPACE_FRPS_PORT || 7000);
const FRPS_TOKEN = process.env.VIBESPACE_FRPS_TOKEN || '';
const FRP_ADMIN_PORT = Number(process.env.VIBESPACE_FRP_ADMIN_PORT || 7400);
const FRP_VERSION = process.env.VIBESPACE_FRP_VERSION || '0.70.0';
// public TCP ports frps allows a client to request (must match frps allowPorts)
const FRP_PORT_MIN = Number(process.env.VIBESPACE_FRP_PORT_MIN || 20000);
const FRP_PORT_MAX = Number(process.env.VIBESPACE_FRP_PORT_MAX || 25000);

function pidCmdline(pid) {
  try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf-8').replace(/\0/g, ' '); } catch { return ''; }
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

const OPENCODE_SERVE_ID = 'opencode-serve';

class PluginManager {
  // opencodeServe = the SHARED serve module (injected so tests can drive a
  // fake keeper); the installed singleton is resolved lazily through facts().
  constructor({ dataDir, broadcast, opencodeServe = null }) {
    this._file = path.join(dataDir, 'plugins.json');
    this.broadcast = broadcast || (() => {});
    try { this._state = JSON.parse(fs.readFileSync(this._file, 'utf-8')); } catch { this._state = { plugins: {} }; }
    this._loginProcs = new Map(); // id → {proc, authUrl}
    this._serve = opencodeServe || require('./opencode-serve');
  }

  _save() {
    try {
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this._file);
    } catch { }
  }

  _rec(id) { return (this._state.plugins[id] = this._state.plugins[id] || {}); }
  // restored 2.343.1 — a dead-code sweep (dc37220) deleted this while 8 call
  // sites remained; every plugin-state broadcast (and publish) threw since.
  _notify() { this.broadcast({ type: 'plugins-updated', ...this._snapshot() }); }

  // ── registry ──
  defs() {
    return {
      tailscale: {
        id: 'tailscale',
        label: 'Tailscale',
        description: 'Join your tailnet — reach home/LAN machines (NAS, dev boxes) from this instance. State persists across container rebuilds; no re-login.',
      },
      frp: {
        id: 'frp',
        label: 'Public URLs (frp)',
        description: 'Expose a machine’s dev server on the public internet via the frp relay — share a preview link. Off by default; needs the relay configured.',
      },
      [OPENCODE_SERVE_ID]: {
        id: OPENCODE_SERVE_ID,
        label: 'OpenCode background service',
        description: 'Lists, opens, resumes and forks STOPPED OpenCode conversations. OpenCode keeps its sessions in its own database rather than in files, so VibeSpace runs `opencode serve` on 127.0.0.1 to read them. Off by default; it stops when you disable it.',
      },
    };
  }

  /** ONE pass over every plugin → the panel rows AND the compact service rows.
   *  Deliberately one pass: `status('tailscale')` shells out (pgrep + `tailscale
   *  status --json`, 5s timeout) on the event loop, so building the two shapes
   *  with two walks would double that cost on every plugin broadcast. */
  _snapshot() {
    const plugins = [], services = {};
    for (const d of Object.values(this.defs())) {
      const rec = this._state.plugins[d.id] || {};
      let st = {};
      try { st = this.status(d.id); } catch (e) { st = { error: e.message }; }
      plugins.push({ ...d, enabled: !!rec.enabled, ...st });
      services[d.id] = this._serviceRow(d, rec, st);
    }
    return { plugins, services };
  }
  _serviceRow(d, rec, st) {
    return {
      id: d.id, label: d.label, description: d.description,
      enabled: st.enabled !== undefined ? !!st.enabled : !!rec.enabled,
      desiredUp: !!st.desiredUp, prompted: !!st.prompted,
      installed: !!st.installed, running: !!st.running, starting: !!st.starting,
      parked: !!st.parked, envForced: st.envForced === undefined ? null : st.envForced,
      reason: st.reason || st.lastError || st.error || null,
    };
  }

  list() { return this._snapshot().plugins; }
  services() { return this._snapshot().services; }

  /** The COMPACT state a harness/feature surface needs to decide "is my
   *  background service on?" for ONE plugin — cheap (no sibling probes),
   *  carried on /api/home's harness rows. */
  serviceState(id) {
    const d = this.defs()[id];
    if (!d) return null;
    let st = {};
    try { st = this.status(id); } catch (e) { st = { error: e.message }; }
    return this._serviceRow(d, this._state.plugins[id] || {}, st);
  }
  /** THE plugin half of the serve autostart decision (the env override half
   *  lives in src/opencode-serve.js — ONE parse of that switch). */
  wantsServiceUp(id) { const rec = this._state.plugins[id] || {}; return !!(rec.enabled && rec.desiredUp); }

  setMode(id, mode) {
    if (id !== 'tailscale') throw new Error('unknown plugin: ' + id);
    if (!['auto', 'kernel', 'userspace'].includes(mode)) throw new Error('mode must be auto|kernel|userspace');
    this._rec('tailscale').mode = mode;
    this._save();
    // if running, restart into the new mode (login persists in the statedir)
    if (this._tsOurDaemonPid()) { try { this.stop(id); } catch { } setTimeout(() => { try { this.start(id); } catch { } }, 1500); }
    this._notify();
    return { mode };
  }

  // User-tuned `tailscale up` flags (free text, whitespace-separated). Only
  // tokens starting with '-' or their following values are kept, and a small
  // denylist blocks flags we own (--socket/--tun/--socks5-server/up itself).
  _upFlags() {
    const raw = this._rec('tailscale').upFlags;
    if (!raw) return [];
    const OWNED = /^--(socket|tun|socks5-server|outbound-http-proxy-listen|accept-routes)(=|$)/;
    return String(raw).split(/\s+/).filter(Boolean).filter((tok) => !OWNED.test(tok));
  }

  setConfig(id, patch = {}) {
    if (id === OPENCODE_SERVE_ID) throw new Error('the OpenCode background service has nothing to configure — it binds a free port on 127.0.0.1');
    if (id === 'frp') {
      // user override of the cluster-injected relay defaults (empty string ⇒
      // clear the override → fall back to env). Restart if running to apply.
      const rec = this._rec('frp');
      const c = rec.config = rec.config || {};
      const set = (k, v, max = 200) => { if (v === undefined) return; const s = String(v).trim().slice(0, max); if (s) c[k] = s; else delete c[k]; };
      set('serverAddr', patch.serverAddr);
      if (patch.serverPort !== undefined) { const n = Number(patch.serverPort); if (n > 0 && n < 65536) c.serverPort = n; else delete c.serverPort; }
      set('token', patch.token, 200);
      set('subDomainHost', patch.subDomainHost);
      this._save();
      if (this._frpDaemonPid()) { try { this._frpStop(); } catch { } setTimeout(() => { try { this._frpStart(); } catch { } }, 800); }
      this._notify();
      return this._frpStatus().config;
    }
    if (id !== 'tailscale') throw new Error('unknown plugin: ' + id);
    const rec = this._rec('tailscale');
    if (patch.upFlags !== undefined) rec.upFlags = String(patch.upFlags || '').slice(0, 500);
    this._save();
    this._notify();
    return { upFlags: rec.upFlags || '' };
  }

  setEnabled(id, enabled) {
    if (!this.defs()[id]) throw new Error('unknown plugin: ' + id);
    // The OpenCode service is not a "also start it at boot" checkbox — it IS
    // the switch, and `enabled`/`desiredUp` move in LOCKSTEP. Anything else is
    // a silent no-op: an enabled-but-not-desiredUp record leaves autostart
    // false, so ticking the box would do nothing until a restart that also
    // does nothing. On ⇒ start now and at every boot; off ⇒ STOP the daemon
    // (a background process the user just turned off that keeps burning CPU
    // is the 2.369.42 shape).
    if (id === OPENCODE_SERVE_ID) return void (enabled ? this._ocStart() : this._ocStop());
    this._rec(id).enabled = !!enabled;
    this._save();
    this._notify();
  }

  /** "We already asked" — the first-use dialog is shown ONCE per instance
   *  (owner: "Not now" must be remembered). Broadcast like every other
   *  persistent state change so a second tab never re-asks. */
  setPrompted(id, prompted = true) {
    if (!this.defs()[id]) throw new Error('unknown plugin: ' + id);
    const rec = this._rec(id);
    if (prompted) rec.promptedAt = Date.now(); else delete rec.promptedAt;
    this._save();
    this._notify();
    return { prompted: !!rec.promptedAt };
  }

  // Boot replay: rootfs is volatile — restart enabled plugins that were up.
  // frp is special: the cluster injects the relay env + wants it default-ON, so
  // it replays whenever effective-enabled + configured (no prior desiredUp
  // needed — a fresh pod has no state yet). It auto-installs frpc if missing.
  bootReplay() {
    for (const id of Object.keys(this.defs())) {
      const rec = this._state.plugins[id] || {};
      if (id === OPENCODE_SERVE_ID) {
        // enabled + desiredUp ⇒ start with the server (the keeper would also
        // start it lazily on the first discovery; replaying makes "it is on"
        // true before anyone looks). Never when the CLI is absent or the env
        // forces it off — _ocStart says so loudly and boot replay is silent.
        if (!rec.enabled || !rec.desiredUp) continue;
        try {
          const st = this._ocStatus();
          if (!st.installed || st.envForced === false || st.running) continue;
          console.log('[plugins] boot replay: starting the OpenCode background service');
          this._ocStart();
        } catch (e) { console.warn('[plugins] boot replay opencode-serve failed:', e.message); }
        continue;
      }
      if (id === 'frp') {
        if (!this._frpEffectiveEnabled() || !this._frpConfigured()) continue;
        (async () => {
          try {
            if (!this._frpBin()) { console.log('[plugins] boot: installing frpc (relay default-on)'); await this._frpInstall(); }
            if (!this._frpDaemonPid()) { console.log('[plugins] boot replay: starting frp'); this._frpStart(); }
          } catch (e) { console.warn('[plugins] boot replay frp failed:', e.message); }
        })();
        continue;
      }
      if (!rec.enabled || !rec.desiredUp) continue;
      try {
        const st = this.status(id);
        if (!st.running && st.installed && st.mode !== 'system') {
          console.log(`[plugins] boot replay: starting ${id}`);
          this.start(id);
        }
      } catch (e) { console.warn(`[plugins] boot replay ${id} failed:`, e.message); }
    }
  }

  // ── tailscale ──
  _tsDir() { return path.join(PLUGIN_ROOT, 'tailscale'); }
  _tsBin(name) {
    const local = path.join(this._tsDir(), 'bin', name);
    if (fs.existsSync(local)) return local;
    try { return execFileSync('which', [name], { encoding: 'utf-8' }).trim() || null; } catch { return null; }
  }
  _tsSock() { return path.join(this._tsDir(), 'tailscaled.sock'); }
  _tsPidFile() { return path.join(this._tsDir(), 'tailscaled.pid'); }
  _tsOurDaemonPid() {
    try {
      const pid = Number(fs.readFileSync(this._tsPidFile(), 'utf-8').trim());
      if (pid && pidAlive(pid) && pidCmdline(pid).includes('tailscaled')) return pid;
    } catch { }
    return null;
  }
  _systemTailscaled() {
    // a root/system tailscaled on the DEFAULT socket — report, never manage.
    // OURS is identified by its cmdline referencing our socket/dir (in kernel
    // mode tailscaled runs under a `sudo` wrapper AND forks a child, so pgrep
    // returns pids that differ from the pidfile — comparing pids alone
    // false-flagged our own child as 'system', graying out the card).
    try {
      const out = execFileSync('pgrep', ['-x', 'tailscaled'], { encoding: 'utf-8' }).trim();
      const ours = this._tsSock();
      const ourDir = this._tsDir();
      for (const pid of out.split('\n').filter(Boolean)) {
        const cmd = pidCmdline(Number(pid));
        if (cmd.includes(ours) || cmd.includes(ourDir)) continue; // our parent/child
        return Number(pid); // genuinely foreign (default socket, dev machine)
      }
    } catch { }
    return null;
  }
  _sudoAvailable() {
    try { execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 3000 }); return true; } catch { return false; }
  }
  _tunUsable() {
    try { fs.accessSync('/dev/net/tun', fs.constants.R_OK | fs.constants.W_OK); return true; } catch { }
    // root/sudo can still open it even without direct perms
    return fs.existsSync('/dev/net/tun') && (process.getuid?.() === 0 || this._sudoAvailable());
  }

  async install(id) {
    if (id === OPENCODE_SERVE_ID) return this._ocInstall();
    if (id === 'frp') return this._frpInstall();
    if (id !== 'tailscale') throw new Error('unknown plugin: ' + id);
    const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
    if (!arch) throw new Error('unsupported arch: ' + process.arch);
    const binDir = path.join(this._tsDir(), 'bin');
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    // resolve the latest stable tarball name from the official index
    const idx = await fetch(`https://pkgs.tailscale.com/stable/?mode=json`).then((r) => r.json());
    const name = (idx.Tarballs || {})[arch];
    if (!name) throw new Error('no tarball for ' + arch);
    const tgz = path.join(this._tsDir(), name);
    const res = await fetch(`https://pkgs.tailscale.com/stable/${name}`);
    if (!res.ok) throw new Error('download failed: HTTP ' + res.status);
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    // tarball layout: tailscale_<ver>_<arch>/{tailscale,tailscaled}
    execFileSync('tar', ['-xzf', tgz, '-C', this._tsDir()]);
    const extracted = fs.readdirSync(this._tsDir()).find((f) => f.startsWith('tailscale_') && fs.statSync(path.join(this._tsDir(), f)).isDirectory());
    if (!extracted) throw new Error('unexpected tarball layout');
    for (const b of ['tailscale', 'tailscaled']) {
      fs.copyFileSync(path.join(this._tsDir(), extracted, b), path.join(binDir, b));
      fs.chmodSync(path.join(binDir, b), 0o755);
    }
    fs.rmSync(path.join(this._tsDir(), extracted), { recursive: true, force: true });
    fs.rmSync(tgz, { force: true });
    this._rec('tailscale').installedAt = Date.now();
    this._save();
    this._notify();
    return { installed: true, version: extracted.replace(/^tailscale_/, '').replace(/_[^_]+$/, '') };
  }

  start(id) {
    if (id === OPENCODE_SERVE_ID) return this._ocStart();
    if (id === 'frp') return this._frpStart();
    if (id !== 'tailscale') throw new Error('unknown plugin: ' + id);
    if (this._systemTailscaled()) throw new Error('a system tailscaled is already running — this machine is managed outside VibeSpace');
    if (this._tsOurDaemonPid()) return { running: true };
    const daemon = this._tsBin('tailscaled');
    if (!daemon) throw new Error('tailscaled not installed — run install first');
    const stateDir = path.join(this._tsDir(), 'state');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const logFd = fs.openSync(path.join(this._tsDir(), 'tailscaled.log'), 'a');
    // Mode preference (user-settable): 'auto' (default — kernel if a usable tun
    // exists, else userspace), 'kernel' (force full-tunnel; errors if no tun),
    // 'userspace' (force proxy-only — never touches the pod's routing table).
    const pref = this._rec('tailscale').mode || 'auto';
    if (pref === 'kernel' && !this._tunUsable()) throw new Error('kernel mode needs /dev/net/tun + NET_ADMIN (or sudo) — none available; use auto or userspace');
    const kernel = pref === 'kernel' || (pref === 'auto' && this._tunUsable());
    const args = [
      `--statedir=${stateDir}`,
      `--socket=${this._tsSock()}`,
      ...(kernel ? [] : ['--tun=userspace-networking', `--socks5-server=localhost:${SOCKS_PORT}`, `--outbound-http-proxy-listen=localhost:${SOCKS_PORT + 1}`]),
    ];
    // kernel mode needs NET_ADMIN: root directly, else passwordless sudo
    const useSudo = kernel && process.getuid?.() !== 0;
    const cmd = useSudo ? 'sudo' : daemon;
    const argv = useSudo ? ['-n', daemon, ...args] : args;
    const child = spawn(cmd, argv, { detached: true, stdio: ['ignore', logFd, logFd] });
    child.unref();
    fs.writeFileSync(this._tsPidFile(), String(child.pid));
    const rec = this._rec('tailscale');
    rec.desiredUp = true;
    rec.mode = kernel ? 'kernel' : 'userspace';
    this._save();
    setTimeout(() => this._notify(), 1500);
    return { starting: true, mode: rec.mode };
  }

  stop(id) {
    if (id === OPENCODE_SERVE_ID) return this._ocStop();
    if (id === 'frp') return this._frpStop();
    if (id !== 'tailscale') throw new Error('unknown plugin: ' + id);
    const pid = this._tsOurDaemonPid();
    if (pid) {
      // kernel-mode daemon may run as root — try plain kill, then sudo
      try { process.kill(pid, 'SIGTERM'); }
      catch { try { execFileSync('sudo', ['-n', 'kill', String(pid)], { timeout: 5000 }); } catch { } }
    }
    try { fs.unlinkSync(this._tsPidFile()); } catch { }
    const rec = this._rec('tailscale');
    rec.desiredUp = false;
    this._save();
    this._notify();
    return { stopped: true };
  }

  status(id) {
    if (id === OPENCODE_SERVE_ID) return this._ocStatus();
    if (id === 'frp') return this._frpStatus();
    if (id !== 'tailscale') throw new Error('unknown plugin: ' + id);
    const rec = this._state.plugins.tailscale || {};
    const installed = !!this._tsBin('tailscaled');
    const sysPid = this._systemTailscaled();
    const base = {
      installed,
      tunAvailable: fs.existsSync('/dev/net/tun'),
      tunUsable: this._tunUsable(),
      sudo: this._sudoAvailable(),
      desiredUp: !!rec.desiredUp,
      modePref: rec.mode || 'auto',
      upFlags: rec.upFlags || '',
      socksPort: SOCKS_PORT,
    };
    const cli = this._tsBin('tailscale');
    const probe = (sockArg) => {
      try {
        const out = execFileSync(cli, [...(sockArg ? [`--socket=${sockArg}`] : []), 'status', '--json'], { encoding: 'utf-8', timeout: 5000 });
        const j = JSON.parse(out);
        return {
          backendState: j.BackendState,
          self: j.Self ? { dnsName: j.Self.DNSName, ips: j.Self.TailscaleIPs } : null,
          peers: j.Peer ? Object.keys(j.Peer).length : 0,
        };
      } catch { return null; }
    };
    if (sysPid) {
      // system daemon: report its state read-only (default socket)
      return { ...base, running: true, mode: 'system', ...(cli ? probe(null) || {} : {}) };
    }
    const pid = this._tsOurDaemonPid();
    if (!pid) return { ...base, running: false, mode: rec.mode || null };
    return { ...base, running: true, mode: rec.mode || 'userspace', pid, ...(probe(this._tsSock()) || {}) };
  }

  // Guided login: `tailscale up` prints the auth URL — capture it for the UI
  // (the Drive-OAuth pattern: user opens the link, approves, we poll status).
  loginStart(id) {
    if (id !== 'tailscale') throw new Error('unknown plugin: ' + id);
    if (this._systemTailscaled()) throw new Error('system tailscaled — log in with `sudo tailscale up` on the machine');
    if (!this._tsOurDaemonPid()) throw new Error('daemon not running — start it first');
    const st = this.status(id);
    if (st.backendState === 'Running') return Promise.resolve({ done: true, self: st.self });
    const prev = this._loginProcs.get(id);
    if (prev?.authUrl && prev.proc.exitCode === null) return Promise.resolve({ authUrl: prev.authUrl });
    prev?.proc?.kill?.();
    const cli = this._tsBin('tailscale');
    const rec = this._rec('tailscale');
    const running = this.status(id).mode; // 'kernel' | 'userspace'
    const useSudo = running === 'kernel' && process.getuid?.() !== 0;
    // Base flags + user-tuned `tailscale up` flags (advertise-routes, exit-node,
    // hostname, ssh, …). Stored per-plugin; validated to look like flags.
    const argv = [`--socket=${this._tsSock()}`, 'up', '--accept-routes', ...this._upFlags()];
    const proc = spawn(useSudo ? 'sudo' : cli, useSudo ? ['-n', cli, ...argv] : argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = { proc, authUrl: null };
    this._loginProcs.set(id, entry);
    return new Promise((resolve, reject) => {
      let out = '';
      const scan = (d) => {
        out += d.toString();
        const m = out.match(/https:\/\/login\.tailscale\.com\/[^\s]+/);
        if (m && !entry.authUrl) { entry.authUrl = m[0]; resolve({ authUrl: m[0] }); }
      };
      proc.stdout.on('data', scan);
      proc.stderr.on('data', scan);
      proc.on('exit', (code) => {
        this._notify();
        if (!entry.authUrl) {
          if (code === 0) resolve({ done: true }); // already authorized (key in statedir)
          else reject(new Error('tailscale up failed: ' + out.trim().slice(-300)));
        }
      });
      setTimeout(() => { if (!entry.authUrl && proc.exitCode === null) resolve({ pending: true }); }, 15000);
    });
  }

  // ── opencode-serve (the OpenCode background service, 2026-09-07) ──────────
  // CONTROL SURFACE ONLY. Every fact (installed / running / parked / runaway
  // numbers) comes from the ONE keeper in src/opencode-serve.js; this class
  // owns nothing but the user's intent (enabled / desiredUp / prompted).
  _ocFacts() { try { return this._serve.facts(); } catch { return null; } }
  _ocServeState() { try { return this._ocFacts()?.state() || {}; } catch (e) { return { error: e.message }; } }
  _ocLocator() { const f = this._ocFacts(); return f && f.locator ? f.locator : null; }

  /** There is nothing for VibeSpace to download: the service IS the user's own
   *  `opencode` CLI. "Installed" = cli-env resolved that executable. Say how to
   *  get it instead of pretending we can (no silent failure, no dead button). */
  _ocInstall() {
    const st = this._ocServeState();
    if (!st.installed) throw new Error('the `opencode` CLI is not on PATH — install OpenCode (https://opencode.ai), then reload this panel (or set OPENCODE_CMD and restart VibeSpace)');
    return { installed: true, version: st.version || null };
  }

  _ocStart() {
    const st = this._ocServeState();
    if (!st.installed) throw new Error('the `opencode` CLI is not on PATH — install OpenCode (https://opencode.ai) first');
    if (this._serve.serveEnvOverride() === false) throw new Error('VIBESPACE_OPENCODE_SERVE=0 is set on this instance — the OpenCode background service is forced off by the environment');
    const rec = this._rec(OPENCODE_SERVE_ID);
    rec.enabled = true;      // Start IS the enable: autostart reads enabled && desiredUp
    rec.desiredUp = true;
    this._save();
    const loc = this._ocLocator();
    // the keeper's own ladder (reuse → spawn → boot wait ≤20s) runs in the
    // background; the UI shows 'starting…' from status() until it answers.
    // Dropping the facts caches is part of starting: the 10s NEGATIVE cache
    // was filled while the service was off, and without this the sidebar
    // would keep showing "no stopped conversations" after the user turned it
    // on (the cache-invalidation law — one dirty signal at the entry point).
    if (loc?.start) Promise.resolve(loc.start()).catch(() => { }).then(() => { try { this._ocFacts()?.invalidate?.(); } catch { } this._notify(); });
    this._notify();
    return { starting: true };
  }

  _ocStop() {
    const rec = this._rec(OPENCODE_SERVE_ID);
    rec.enabled = false;          // lockstep with desiredUp — ONE switch, no "enabled but off" limbo
    rec.desiredUp = false;
    this._save();
    // killRecorded: a serve we merely ADOPTED is still a VibeSpace-started
    // daemon — "off" must mean the process is gone, not "we stopped looking"
    try { this._ocLocator()?.stop?.({ killRecorded: true }); } catch { }
    this._notify();
    return { stopped: true };
  }

  _ocStatus() {
    const rec = this._state.plugins[OPENCODE_SERVE_ID] || {};
    const st = this._ocServeState();
    const envForced = this._serve.serveEnvOverride();
    const enabled = envForced === true ? true : envForced === false ? false : !!rec.enabled;
    const running = !!st.ready;
    return {
      installed: !!st.installed,
      configured: !!st.installed,
      enabled,
      desiredUp: !!rec.desiredUp,
      prompted: !!rec.promptedAt,
      envForced,                       // true = forced on, false = forced off, null = the plugin decides
      running,
      starting: !running && !st.parked && !!st.installed && !!st.autostart,
      parked: !!st.parked,
      parkedKind: st.parkedKind || null,
      port: st.port || null,
      pid: st.pid || null,
      source: st.source || null,       // 'spawned' | 'reused'
      version: st.version || null,
      cpuPct: st.cpuPct == null ? null : Math.round(st.cpuPct),
      rssMb: st.rssBytes ? Math.round(st.rssBytes / 1048576) : null,
      lastError: st.lastError || null,
      reason: running ? null : (() => { try { return this._ocFacts()?.reasonUnavailable?.() || null; } catch { return null; } })(),
    };
  }

  // ── frp (public port exposure via the shared frps relay) ──────────────────
  _frpDir() { return path.join(PLUGIN_ROOT, 'frp'); }
  _frpBin() {
    const local = path.join(this._frpDir(), 'bin', 'frpc');
    if (fs.existsSync(local)) return local;
    try { return execFileSync('which', ['frpc'], { encoding: 'utf-8' }).trim() || null; } catch { return null; }
  }
  _frpProxiesDir() { return path.join(this._frpDir(), 'proxies'); }
  _frpConf() { return path.join(this._frpDir(), 'frpc.toml'); }
  _frpPidFile() { return path.join(this._frpDir(), 'frpc.pid'); }
  _frpAdminPw() {
    const f = path.join(this._frpDir(), 'admin.pw');
    try { return fs.readFileSync(f, 'utf-8').trim(); } catch { }
    const pw = require('crypto').randomBytes(12).toString('hex');
    fs.mkdirSync(this._frpDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, pw, { mode: 0o600 });
    return pw;
  }
  // Effective relay config: USER override (data/plugins.json config) wins over
  // the cluster-injected ENV defaults (user directive: the fleet auto-injects
  // VIBESPACE_FRPS_* as defaults + enables the plugin; the user can change any
  // of it in the plugin UI).
  _frpCfg() {
    const c = (this._state.plugins.frp || {}).config || {};
    return {
      serverAddr: c.serverAddr || FRPS_ADDR,
      serverPort: Number(c.serverPort || FRPS_PORT),
      token: c.token || FRPS_TOKEN,
      subDomainHost: c.subDomainHost || process.env.VIBESPACE_FRPS_SUBDOMAIN_HOST || '',
      portMin: Number(c.portMin || FRP_PORT_MIN),
      portMax: Number(c.portMax || FRP_PORT_MAX),
      fromEnv: !!(FRPS_ADDR && FRPS_TOKEN),   // was the RELAY provided by the cluster?
    };
  }
  _frpConfigured() { const c = this._frpCfg(); return !!(c.serverAddr && c.token); }
  // Default-enabled when the cluster injects the relay env AND the user hasn't
  // explicitly turned it off (rec.enabled === false). Undefined = follow env.
  _frpEffectiveEnabled() {
    const rec = this._state.plugins.frp || {};
    if (rec.enabled === false) return false;
    if (rec.enabled === true) return true;
    return this._frpCfg().fromEnv; // cluster default-on
  }
  _frpDaemonPid() {
    try {
      const pid = Number(fs.readFileSync(this._frpPidFile(), 'utf-8').trim());
      if (pid && pidAlive(pid) && pidCmdline(pid).includes('frpc')) return pid;
    } catch { }
    return null;
  }
  _frpWriteConf() {
    const pw = this._frpAdminPw();
    const cfg = this._frpCfg();
    fs.mkdirSync(this._frpProxiesDir(), { recursive: true, mode: 0o700 });
    const toml = [
      `serverAddr = "${cfg.serverAddr}"`,
      `serverPort = ${cfg.serverPort}`,
      `auth.method = "token"`,
      `auth.token = "${cfg.token}"`,
      `webServer.addr = "127.0.0.1"`,
      `webServer.port = ${FRP_ADMIN_PORT}`,
      `webServer.user = "vibespace"`,
      `webServer.password = "${pw}"`,
      // keep retrying instead of exiting when the relay is unreachable at
      // start — frp's default (exit on first failed login) left the
      // default-ON plugin permanently down after a boot-time relay blip
      `loginFailExit = false`,
      `log.to = "${path.join(this._frpDir(), 'frpc.log')}"`,
      `log.level = "info"`,
      `log.maxDays = 3`,
      // proxy files (one per published port) are hot-added via `frpc reload`
      `includes = ["${this._frpProxiesDir()}/*.toml"]`,
    ].join('\n') + '\n';
    fs.writeFileSync(this._frpConf(), toml, { mode: 0o600 });
  }

  async _frpInstall() {
    const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
    if (!arch) throw new Error('unsupported arch: ' + process.arch);
    const binDir = path.join(this._frpDir(), 'bin');
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const name = `frp_${FRP_VERSION}_linux_${arch}`;
    const url = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${name}.tar.gz`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('download failed: HTTP ' + res.status);
    const tgz = path.join(this._frpDir(), 'frp.tgz');
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    execFileSync('tar', ['-xzf', tgz, '-C', this._frpDir()]);
    fs.copyFileSync(path.join(this._frpDir(), name, 'frpc'), path.join(binDir, 'frpc'));
    fs.chmodSync(path.join(binDir, 'frpc'), 0o755);
    fs.rmSync(path.join(this._frpDir(), name), { recursive: true, force: true });
    fs.rmSync(tgz, { force: true });
    this._rec('frp').installedAt = Date.now();
    this._save();
    this._notify();
    return { installed: true, version: FRP_VERSION };
  }

  _frpStart() {
    if (!this._frpConfigured()) throw new Error('the frp relay is not configured on this instance (set VIBESPACE_FRPS_ADDR/TOKEN)');
    const bin = this._frpBin();
    if (!bin) throw new Error('frpc not installed — run install first');
    if (this._frpDaemonPid()) return { running: true };
    this._frpWriteConf();
    const logFd = fs.openSync(path.join(this._frpDir(), 'frpc.out'), 'a');
    const child = spawn(bin, ['-c', this._frpConf()], { detached: true, stdio: ['ignore', logFd, logFd] });
    child.unref();
    fs.writeFileSync(this._frpPidFile(), String(child.pid));
    const rec = this._rec('frp');
    rec.desiredUp = true;
    this._save();
    setTimeout(() => this._notify(), 1200);
    return { starting: true };
  }

  _frpStop() {
    const pid = this._frpDaemonPid();
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { } }
    try { fs.unlinkSync(this._frpPidFile()); } catch { }
    const rec = this._rec('frp');
    rec.desiredUp = false;
    this._save();
    this._notify();
    return { stopped: true };
  }

  _frpStatus() {
    const rec = this._state.plugins.frp || {};
    const c = this._frpCfg();
    return {
      installed: !!this._frpBin(),
      configured: this._frpConfigured(),
      // WHICH field is missing (2.227.10, him188: he filled the address+port,
      // the token stayed empty, and the UI only said "relay not configured" —
      // an unactionable dead end. Name the gap; never make the user guess).
      missing: [!c.serverAddr && 'serverAddr', !c.token && 'token'].filter(Boolean),
      server: this._frpConfigured() ? `${c.serverAddr}:${c.serverPort}` : null,
      publicHost: c.serverAddr || null,
      subDomainHost: c.subDomainHost || null,     // subdomain mode when set
      fromEnv: c.fromEnv,                          // relay came from the cluster env
      running: !!this._frpDaemonPid(),
      pid: this._frpDaemonPid() || undefined,
      enabled: this._frpEffectiveEnabled(),        // default-on when cluster-injected
      desiredUp: !!rec.desiredUp,
      selfDialSub: rec.selfDialSub || '',          // stable subdomain for double-NAT self-publish (B-5c1e)
      portRange: [c.portMin, c.portMax],
      // echo the CURRENT effective config so the UI can prefill editable fields
      config: { serverAddr: c.serverAddr, serverPort: c.serverPort, hasToken: !!c.token, subDomainHost: c.subDomainHost },
    };
  }

  // frpc admin API (localhost only) — reload picks up new proxy files, status
  // reports each proxy's run state (so we can detect a taken remotePort).
  async _frpAdmin(pathname, method = 'GET') {
    const pw = this._frpAdminPw();
    const auth = 'Basic ' + Buffer.from('vibespace:' + pw).toString('base64');
    const res = await fetch(`http://127.0.0.1:${FRP_ADMIN_PORT}${pathname}`, { method, headers: { Authorization: auth }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error('frpc admin ' + res.status);
    const t = await res.text();
    try { return JSON.parse(t); } catch { return t; }
  }
  async _frpReload() { return this._frpAdmin('/api/reload', 'GET'); }
  async _frpProxyStatus(kind = 'tcp') {
    const s = await this._frpAdmin('/api/status', 'GET');
    return (s && s[kind]) || [];
  }

  /** Publish a LOCAL port to the public internet via the relay. If a
   *  subDomainHost is configured → a random `https://<sub>.<host>` subdomain
   *  (the SNI broker); else a TCP port map `http://<relay>:<port>/` (retrying
   *  on collision — the relay is fleet-shared). name = a stable proxy name. */
  /** Sniff what a local service speaks so we pick the right relay proxy type
   *  (see module-level probeProto). */
  async _probeProto(port, opts) { return probeProto(port, opts); }

  async frpPublish(name, localPort, { preferPort = 0, preferSub = '', proto: protoHint = '' } = {}) {
    if (!this._frpConfigured()) throw new Error('public URLs are not available — the frp relay is not configured on this instance');
    if (!this._frpDaemonPid()) { this._frpStart(); await new Promise((r) => setTimeout(r, 1500)); }
    const cfg = this._frpCfg();
    const safe = String(name).replace(/[^\w-]/g, '_').slice(0, 60);
    const file = path.join(this._frpProxiesDir(), safe + '.toml');

    // Detect the backend protocol: HTTP/HTTPS can ride a routed subdomain; a
    // raw-TCP service (DB/VNC/SSH — no Host/SNI) can ONLY be an IP:port, so it
    // falls through to TCP mode even when a subdomain host is configured.
    const proto = ['http', 'https', 'tcp'].includes(protoHint) ? protoHint
      : await this._probeProto(localPort).catch(() => 'http');

    // ── subdomain (vhost) mode — PLAINTEXT-HTTP backends ──
    // TLS is terminated SERVER-SIDE at the relay (it holds the wildcard cert
    // and forwards to frps's plaintext HTTP vhost) — no cert on any instance.
    // The proxy is a plain `type=http`; the relay makes it a trusted https URL.
    // An HTTPS-native backend already serves its own cert and a raw-TCP service
    // has no Host to route on — both fall through to IP:port mode below.
    if (cfg.subDomainHost && proto === 'http') {
      const sub = /^[a-z0-9][a-z0-9-]{1,62}$/.test(preferSub) ? preferSub
        : 'vs' + require('crypto').randomBytes(5).toString('hex'); // e.g. vs3f9a1c2b4d
      const toml = `[[proxies]]\nname = "${safe}"\ntype = "http"\nsubdomain = "${sub}"\nlocalIP = "127.0.0.1"\nlocalPort = ${localPort}\nhostHeaderRewrite = "127.0.0.1"\n`;
      fs.writeFileSync(file, toml, { mode: 0o600 });
      try { await this._frpReload(); } catch (e) { throw new Error('frpc reload failed: ' + e.message); }
      for (let t = 0; t < 12; t++) {
        await new Promise((r) => setTimeout(r, 400));
        let st = []; try { st = await this._frpProxyStatus('http'); } catch { }
        const p = st.find((x) => x.name === safe);
        if (p && p.status === 'running') { this._notify(); return { name: safe, subdomain: sub, proto, url: `https://${sub}.${cfg.subDomainHost}/`, publicHost: `${sub}.${cfg.subDomainHost}` }; }
        if (p && (p.status === 'error' || p.status === 'closed')) break;
      }
      try { fs.unlinkSync(file); await this._frpReload(); } catch { }
      throw new Error('could not publish the subdomain on the relay (is the domain / DNS set up?)');
    }

    // ── TCP port mode (works with just the relay IP) ──
    const cand = [];
    if (preferPort >= cfg.portMin && preferPort <= cfg.portMax) cand.push(preferPort);
    const span = cfg.portMax - cfg.portMin + 1;
    let seed = 0; for (const c of safe) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
    cand.push(cfg.portMin + (seed % span));
    for (let i = 0; i < 8; i++) cand.push(cfg.portMin + Math.floor(((seed = (seed * 1103515245 + 12345) >>> 0) / 0xffffffff) * span));
    let lastErr = '';
    for (const remotePort of cand) {
      const toml = `[[proxies]]\nname = "${safe}"\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = ${localPort}\nremotePort = ${remotePort}\n`;
      fs.writeFileSync(file, toml, { mode: 0o600 });
      try { await this._frpReload(); } catch (e) { lastErr = e.message; continue; }
      // poll the proxy's run state — 'running' = the relay accepted the port
      for (let t = 0; t < 12; t++) {
        await new Promise((r) => setTimeout(r, 400));
        let st = []; try { st = await this._frpProxyStatus(); } catch { }
        const p = st.find((x) => x.name === safe);
        if (p && p.status === 'running') {
          this._notify();
          // scheme reflects what the backend speaks: https:// keeps its own
          // cert (passthrough), http:// for plaintext web, tcp:// for a raw
          // service (DB/VNC/SSH — not a browser link)
          const scheme = proto === 'https' ? 'https' : proto === 'tcp' ? 'tcp' : 'http';
          const url = proto === 'tcp' ? `tcp://${cfg.serverAddr}:${remotePort}` : `${scheme}://${cfg.serverAddr}:${remotePort}/`;
          return { name: safe, remotePort, proto, url, publicHost: cfg.serverAddr };
        }
        if (p && (p.status === 'error' || p.status === 'closed')) { lastErr = p.err || 'port unavailable'; break; }
      }
    }
    try { fs.unlinkSync(file); await this._frpReload(); } catch { }
    throw new Error('could not allocate a public port on the relay' + (lastErr ? ' (' + lastErr + ')' : ''));
  }

  /** Persist the stable subdomain used to self-publish this instance for
   *  double-NAT device pairing (B-5c1e) so re-pairs/reconnects keep the URL. */
  setSelfDialSub(sub) {
    const rec = this._rec('frp');
    const s = String(sub || '').trim();
    if (s) rec.selfDialSub = s; else delete rec.selfDialSub;
    this._save();
  }

  async frpUnpublish(name) {
    const safe = String(name).replace(/[^\w-]/g, '_').slice(0, 60);
    try { fs.unlinkSync(path.join(this._frpProxiesDir(), safe + '.toml')); } catch { }
    if (this._frpDaemonPid()) { try { await this._frpReload(); } catch { } }
    this._notify();
    return { ok: true };
  }
}

/** Sniff what a service speaks so publish/UI pick the right exposure mode.
 *  'https' (TLS backend — passthrough, keeps its own cert) / 'http' (plaintext
 *  HTTP — can ride a routed subdomain with server-side TLS termination) /
 *  'tcp' (anything else — a DB, VNC, SSH: NO Host/SNI to route on, so it can
 *  only be an IP:port). `target` = a local port number, or `{ connect }` — an
 *  async factory returning a duplex stream (how remote ports are probed
 *  through the device tunnel; each probe pass gets its OWN fresh stream). */
async function probeProto(target, { timeoutMs = 2500 } = {}) {
  const net = require('net'), tls = require('tls');
  const mk = typeof target === 'object' && target && target.connect
    ? target.connect
    : () => new Promise((res, rej) => {
      const s = net.connect({ host: '127.0.0.1', port: target, timeout: timeoutMs }, () => res(s));
      s.on('error', rej); s.on('timeout', () => { s.destroy(); rej(new Error('timeout')); });
    });
  // TLS? a completed handshake = the backend serves TLS (its own https)
  const isTls = await new Promise(async (res) => {
    let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
    const guard = setTimeout(() => fin(false), timeoutMs + 500);
    let sock; try { sock = await mk(); } catch { clearTimeout(guard); return fin(false); }
    const s = tls.connect({ socket: sock, rejectUnauthorized: false }, () => { clearTimeout(guard); fin(true); s.destroy(); });
    s.setTimeout(timeoutMs, () => { fin(false); s.destroy(); });
    s.on('error', () => { clearTimeout(guard); fin(false); try { s.destroy(); } catch { } });
  });
  if (isTls) return 'https';
  // HTTP? send a minimal request and look for an HTTP status line
  const isHttp = await new Promise(async (res) => {
    let done = false, buf = ''; const fin = (v) => { if (!done) { done = true; res(v); } };
    const guard = setTimeout(() => { fin(/^HTTP\//.test(buf)); }, timeoutMs + 500);
    let s; try { s = await mk(); } catch { clearTimeout(guard); return fin(false); }
    const end = (v) => { clearTimeout(guard); fin(v); try { s.destroy?.() ?? s.end?.(); } catch { } };
    try { s.write('GET / HTTP/1.0\r\nHost: localhost\r\n\r\n'); } catch { return end(false); }
    s.on('data', (d) => { buf += d.toString('latin1'); if (buf.length >= 5) end(/^HTTP\//.test(buf)); });
    s.on('error', () => end(/^HTTP\//.test(buf)));
    s.on('close', () => end(/^HTTP\//.test(buf)));
    if (s.setTimeout) s.setTimeout(timeoutMs, () => end(/^HTTP\//.test(buf)));
  });
  return isHttp ? 'http' : 'tcp';
}

module.exports = { PluginManager, probeProto, OPENCODE_SERVE_ID };
