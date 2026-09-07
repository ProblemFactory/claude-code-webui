/**
 * HostManager — SSH host registry for remote sessions (collaboration P2).
 *
 * - Host records in data/hosts.json: {id, name, user, host, port, keyPath}.
 *   No secrets stored — auth is ssh key based (reuses ~/.ssh by default; an
 *   in-app generated ed25519 pair lives in data/ssh/ with the public key
 *   surfaced for authorized_keys).
 * - Connectivity test: `ssh -o BatchMode=yes … true` (never prompts).
 * - Remote session discovery runs over ssh on demand (lock files + project
 *   JSONL listing), cached with a short TTL — no daemon on the remote.
 * - Remote transcripts stay on the remote host by design; resume/fork must
 *   target the same host (session records carry `host`).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { REMOTE_PRELUDE, nodeFinder } = require('./remote-shell.js');
const { execFile } = require('child_process');
const { claimJsonls, cwdToProjectDir } = require('./session-store');
const { nameFromUserLine, interpretDiscoveryLines, synthesizeDiscoveryLines, isZstPath, isZstBuffer, ZSTD_MAGIC } = require('./discovery-facts');
const { classifyPrivateKey } = require('./ssh-key-format');

const SSH_BASE_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=6',
  '-o', 'StrictHostKeyChecking=accept-new',
  // Keepalive (2.124.0, remote-stability pass): silent NAT drops / network
  // blips used to leave half-open ssh pipes lingering for the whole TCP
  // timeout — sessions looked alive but were dead, and nothing could react.
  // 15s app-level probes, 4 misses ⇒ ssh exits within ~60s so the reconnect
  // layers (chat-wrapper remote retry / pty-wrapper retry) can act. Applies
  // to EVERY ssh use (session spawns, discovery, remote-fs, rsync via sshCmd).
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=4',
  '-o', 'TCPKeepAlive=yes',
];

class HostManager {
  constructor({ dataDir }) {
    this.convIndex = new (require('./conversation-index.js').ConversationIndex)({ dataDir });
    this.dataDir = dataDir;
    this._file = path.join(dataDir, 'hosts.json');
    this._sshDir = path.join(dataDir, 'ssh');
    // ControlPath sockets must stay under the ~104-char unix-socket limit —
    // the data dir can be arbitrarily deep (bit on first try: workspace path
    // + cm-<40hex>.<tmpsuffix> overflowed), so masters live in a short
    // per-uid tmp dir instead.
    this._cmDir = path.join(os.tmpdir(), `vs-cm-${process.getuid ? process.getuid() : 'u'}`);
    try { fs.mkdirSync(this._cmDir, { recursive: true, mode: 0o700 }); } catch { }
    this._state = { hosts: [] };
    this._discoveryCache = new Map(); // hostId -> {at, sessions}
    // LAST-KNOWN discovery results, persisted across restarts (2.124.0): the
    // sidebar shows remote sessions immediately after a reload / while a host
    // is unreachable, marked stale, instead of an empty zone.
    this._discFile = path.join(dataDir, 'remote-sessions-cache.json');
    this._persistedDisc = {};
    try { this._persistedDisc = JSON.parse(fs.readFileSync(this._discFile, 'utf-8')) || {}; } catch { }
    this._discPersistTimer = null;
    this._load();
  }

  _persistDiscovery(id, sessions) {
    this._persistedDisc[id] = { at: Date.now(), sessions };
    if (this._discPersistTimer) return;
    this._discPersistTimer = setTimeout(() => {
      this._discPersistTimer = null;
      try {
        const tmp = this._discFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this._persistedDisc));
        fs.renameSync(tmp, this._discFile);
      } catch { }
    }, 2000);
  }

  /** Drop the in-memory discovery cache for a host so the NEXT sidebar poll
   *  re-probes immediately — called after remote create/kill/exit so the list
   *  doesn't stay wrong for the cache TTL (state-sync pass, 2.124.0). */
  invalidateDiscovery(id) {
    this._discoveryCache.delete(id);
    // …and TELL THE CLIENTS (2.309.0, real report: terminate a remote chat and
    // the Recent zone kept showing it live until a manual ⟳). The client's
    // per-host list has no TTL — it is loaded on demand and kept — so dropping
    // only the SERVER cache made the staleness invisible-but-permanent. The
    // notification hangs off the one invalidation entry point rather than each
    // of the ~8 call sites, because "someone remembered one site" is exactly
    // how this bug existed (the /api/kill-pid path had a hand-wired refresh;
    // the ws terminate path did not).
    try { this.onDiscoveryDirty?.(id); } catch { }
  }

  /** Drop the cached DeviceManager for a host (called when a dial device
   *  re-dials with a fresh stream) so hosts.device() rebuilds it. */
  invalidateDevice(id) { try { this._devices?.get(id)?.stop?.(); } catch { } this._devices?.delete(id); }

  _load() {
    try { this._state = JSON.parse(fs.readFileSync(this._file, 'utf-8')); }
    catch {
      // hosts.json is the SOLE holder of every dialTokenHash since B-f3e8 —
      // an unparseable file is backed up before we proceed empty, never
      // silently overwritten by the next _save (review hardening)
      try { if (fs.existsSync(this._file)) fs.copyFileSync(this._file, this._file + '.corrupt-' + Date.now()); } catch { }
    }
    if (!Array.isArray(this._state.hosts)) this._state.hosts = [];
  }

  _save() {
    const tmp = this._file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2));
    fs.renameSync(tmp, this._file);
  }

  list() {
    // dial hosts carry a live `online` field (server wires dialOnline to the
    // dialed-in stream registry) — the ONE machine list is the whole roster,
    // there is no separate device API anymore (B-f3e8).
    return this._state.hosts.map(h => (h.transport === 'dial'
      ? { ...h, dialTokenHash: undefined, online: !!this.dialOnline?.(h.deviceId) }
      // graduated ssh machine (B-6640): expose the upgrade + live-dial state
      // (hash stays redacted like pure-dial records)
      : { ...h, dialTokenHash: undefined, ...(h.deviceId ? { graduated: true, dialLive: !!this.dialOnline?.(h.deviceId) } : {}) }));
  }

  get(id) {
    const h = this._state.hosts.find(x => x.id === id);
    if (!h) throw new Error('host not found');
    return h;
  }

  /** The host record a dialed-in device belongs to (deviceId = wire identity). */
  findByDeviceId(deviceId) {
    // Pure-dial first (existing behavior), else a GRADUATED ssh record
    // (B-6640: an ssh machine that also dials out carries deviceId +
    // dialTokenHash on its ssh record — dial-in auth and the dial-in hooks
    // must resolve it, or the daemon's dial is rejected as unknown).
    return this._state.hosts.find(h => h.transport === 'dial' && h.deviceId === String(deviceId))
      || this._state.hosts.find(h => h.deviceId === String(deviceId)) || null;
  }

  /** B-6640: mark an ssh machine as dial-graduated — assigns its stable
   *  deviceId (the mint + dial-in key) and records the install root for a
   *  later deterministic removal. transport STAYS 'ssh'/absent: every ssh
   *  path keeps working as the bootstrap + rescue channel; only the live
   *  routing (_deviceConnect) prefers the dialed-in stream. */
  graduateDial(id, { dialRoot } = {}) {
    const h = this.get(id);
    if (h.transport === 'dial') throw new Error('already a dial device');
    if (!h.deviceId) h.deviceId = ('grad-' + id).replace(/[^\w-]/g, '').slice(0, 32);
    if (dialRoot) h.dialRoot = String(dialRoot);
    this._save();
    return h;
  }

  ungraduateDial(id) {
    const h = this.get(id);
    delete h.deviceId; delete h.dialTokenHash; delete h.dialRoot;
    this._save();
    return h;
  }

  /** Dial-in hook for GRADUATED hosts (wired from the server's dial-in
   *  branch): the fresh dial stream should win over a cached ssh-transport
   *  DeviceManager — evict it so the next op rebuilds over the dial link.
   *  In-flight ops on the old dm finish undisturbed. */
  onDialIn(deviceId) {
    const h = this.findByDeviceId(deviceId);
    if (!h || h.transport === 'dial') return;
    const cached = this._devices?.get(h.id);
    if (cached && !cached._dialStream) this._devices.delete(h.id);
  }

  /** Pairing credential lives ON the host record (B-f3e8 — dial-tokens.json
   *  folded in). setDialToken find-or-creates so re-pairing an existing name
   *  rotates the token in place. */
  setDialToken(deviceId, sha256Hash, { name } = {}) {
    let h = this.findByDeviceId(deviceId);
    if (!h) { this.add({ name: name || deviceId, transport: 'dial', deviceId }); h = this.findByDeviceId(deviceId); }
    // add() keys by the SANITIZED id — a different raw deviceId that sanitizes
    // to the same id collides and findByDeviceId (raw match) stays null
    if (!h) throw new Error(`device name "${deviceId}" collides with an existing pairing after sanitization — pick another name`);
    h.dialTokenHash = String(sha256Hash);
    this._save();
    return h.id;
  }
  dialTokenHash(deviceId) { return this.findByDeviceId(deviceId)?.dialTokenHash || null; }

  /** Opt-in flag: may an agent use this machine as an on-demand egress (exit
   *  node)? Default off — turning a paired machine into an egress is a real
   *  capability (SSRF into its LAN, abuse), so it's per-machine + explicit. */
  setAllowExit(id, on) {
    const h = this.get(id);
    if (on) h.allowExit = true; else delete h.allowExit;
    this._save();
    return h;
  }

  /** B-f3e8 one-time migration: the legacy dial-tokens.json (deviceId →
   *  sha256) folds into the dial host records. MUST be lossless — devices in
   *  the field hold the raw tokens; a lost hash locks every daemon out
   *  permanently. The legacy file is renamed only AFTER every entry landed
   *  in hosts.json (a crash mid-way just re-runs it). */
  migrateDialTokenFile(file) {
    if (!fs.existsSync(file)) return false;
    const all = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const [devId, hash] of Object.entries(all)) {
      if (hash && !this.dialTokenHash(devId)) this.setDialToken(devId, hash);
    }
    const ok = Object.entries(all).every(([devId, hash]) => !hash || this.dialTokenHash(devId));
    if (ok) fs.renameSync(file, file + '.migrated');
    else console.warn('[hosts] dial-token migration incomplete — legacy file kept');
    return ok;
  }

  add({ name, user, host, port, keyPath, privateKey, transport, deviceId, dialTokenHash }) {
    // DIAL host (graduation slice B): a paired dial-out device promoted to a
    // full machine — no ssh fields; every data path rides deviceForDial.
    if (transport === 'dial') {
      if (!deviceId) throw new Error('deviceId required for a dial host');
      const id = 'host-dial-' + String(deviceId).replace(/[^\w-]/g, '');
      if (this._state.hosts.some(h => h.id === id)) return id; // idempotent
      const rec = { id, name: String(name || deviceId).slice(0, 60), transport: 'dial', deviceId: String(deviceId), createdAt: Date.now() };
      if (dialTokenHash) rec.dialTokenHash = String(dialTokenHash);
      this._state.hosts.push(rec);
      this._save();
      return id;
    }
    if (!host) throw new Error('host required');
    if (!user) throw new Error('user required');
    const id = 'host-' + crypto.randomBytes(4).toString('hex');
    const hasKeyText = !!(privateKey && String(privateKey).trim());
    const rec = {
      id,
      name: String(name || host).slice(0, 60),
      user: String(user), host: String(host),
      port: Number(port) || 22,
      keyPath: null,
      // honest key provenance for the UI (real report: an IMPORTED private key
      // was labeled 'using VibeSpace key'): imported = user pasted/uploaded it;
      // app = the VibeSpace-generated key; default = the system's ssh keys.
      keySource: hasKeyText ? 'imported' : (keyPath ? 'app' : 'default'),
      createdAt: Date.now(),
    };
    // Name collision is checked BEFORE any file write — the old order wrote
    // data/ssh/<id>.key and THEN threw, orphaning a key file no record ever
    // referenced again.
    if (this._state.hosts.some(h => h.name === rec.name)) throw new Error('A host with that name exists');
    // Pasted/uploaded private key → stored per-host under data/ssh, 0600.
    // add() stays SYNCHRONOUS (setDialToken calls it and immediately does
    // findByDeviceId on the result), so it cannot run the ssh-keygen unlock —
    // the /api/hosts route decrypts first via src/ssh-key.js and hands us
    // plaintext. This is the BELT for any caller that skips the route:
    // BatchMode ssh can never prompt, so a still-encrypted key is refused
    // rather than stored as a key that will only fail at connect time with a
    // bare "Permission denied (publickey)".
    if (hasKeyText) {
      const body = String(privateKey).replace(/\r\n/g, '\n').trim() + '\n';
      const info = classifyPrivateKey(body);
      if (!info.usable) throw new Error('Not a valid private key (missing BEGIN PRIVATE KEY header)');
      if (info.encrypted) {
        const e = new Error('Key is passphrase-protected — supply its passphrase so it can be unlocked at import');
        e.code = 'key-encrypted';
        throw e;
      }
      fs.mkdirSync(this._sshDir, { recursive: true, mode: 0o700 });
      const kp = path.join(this._sshDir, `${id}.key`);
      fs.writeFileSync(kp, body, { mode: 0o600 });
      rec.keyPath = kp;
    } else if (keyPath) {
      rec.keyPath = String(keyPath);
    }
    this._state.hosts.push(rec);
    this._save();
    return rec.id;
  }

  remove(id) {
    const h = this.get(id);
    // uploaded per-host key files are ours to clean up
    if (h.keyPath && h.keyPath.startsWith(this._sshDir) && h.keyPath.endsWith(`${id}.key`)) {
      try { fs.unlinkSync(h.keyPath); } catch {}
    }
    this._state.hosts = this._state.hosts.filter(x => x.id !== id);
    this._discoveryCache.delete(id);
    // The host's remote-transcript cache is dead weight once the host is gone
    // (files up to 64MB each accumulated forever — audit round-3).
    try { fs.rmSync(path.join(this.dataDir, 'remote-jsonl', id), { recursive: true, force: true }); } catch {}
    this._save();
  }

  // Boot sweep: remote-jsonl dirs whose host no longer exists (orphaned before
  // remove() learned to clean up) + cached transcripts unused for 30 days.
  sweepJsonlCache() {
    const base = path.join(this.dataDir, 'remote-jsonl');
    let dirs = [];
    try { dirs = fs.readdirSync(base); } catch { return; }
    const live = new Set(this._state.hosts.map((h) => h.id));
    const cutoff = Date.now() - 30 * 86400000;
    for (const d of dirs) {
      const dir = path.join(base, d);
      if (!live.has(d)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} continue; }
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        try {
          const fp = path.join(dir, f);
          if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
        } catch {}
      }
    }
  }

  /** Config transfer: host records + the private-key TEXT of any uploaded keys. */
  exportBundle() {
    const keys = {};
    for (const h of this._state.hosts) {
      if (h.keyPath && h.keyPath.startsWith(this._sshDir)) {
        try { keys[h.id] = fs.readFileSync(h.keyPath, 'utf-8'); } catch {}
      }
    }
    return { hosts: this._state.hosts, keys };
  }

  /** Import a host bundle — records REPLACE, uploaded keys rewritten (0600).
   *  Returns {warnings} — a passphrase-protected key in the bundle is SKIPPED
   *  (we can't prompt for its passphrase during an unattended import, and
   *  writing it would produce a host that only fails at connect time); the
   *  caller surfaces the reason in the import result. */
  importBundle(bundle) {
    const warnings = [];
    if (!bundle || !Array.isArray(bundle.hosts)) return { warnings };
    fs.mkdirSync(this._sshDir, { recursive: true, mode: 0o700 });
    const hosts = [];
    for (const h of bundle.hosts) {
      const rec = { ...h };
      // A bundle from a pre-2.160.0 instance carries dial records WITHOUT the
      // token hash (it lived in dial-tokens.json, never exported) — a wholesale
      // replace would lock every paired device out. Keep the hash we have.
      if (rec.transport === 'dial' && !rec.dialTokenHash) {
        const cur = this.findByDeviceId(rec.deviceId);
        if (cur?.dialTokenHash) rec.dialTokenHash = cur.dialTokenHash;
      }
      const keyText = bundle.keys?.[h.id];
      if (keyText && h.keyPath && h.keyPath.startsWith(this._sshDir)) {
        if (classifyPrivateKey(keyText).encrypted) {
          // Don't write a key ssh can never use non-interactively.
          rec.keyPath = null;
          rec.keySource = 'default';
          warnings.push(`${rec.name || h.id}: key skipped (passphrase-protected — re-import it in Remote → Add machine)`);
        } else {
          // rebase the key under THIS instance's ssh dir
          const kp = path.join(this._sshDir, `${h.id}.key`);
          fs.writeFileSync(kp, keyText, { mode: 0o600 });
          rec.keyPath = kp;
        }
      } else if (h.keyPath && h.keyPath.startsWith(this._sshDir)) {
        rec.keyPath = null; // key text missing — fall back to ~/.ssh
      }
      hosts.push(rec);
    }
    this._state.hosts = hosts;
    this._save();
    return { warnings };
  }

  /** ssh argv for a host (shared by test/discovery/bootstrap/session spawn).
   *  multiplex (2.125.0): ControlMaster connection reuse for SHORT-LIVED
   *  per-op ssh (discovery probes, remote-fs, rsync) — first op pays the
   *  handshake, the next ~10min ride the persisted master (~1s → ~50ms).
   *  NEVER set it on SESSION pipes: if a session's ssh became the master,
   *  its death would kill every multiplexed connection with it (coupling
   *  unrelated sessions), and long-lived pipes pin the master forever. */
  sshArgs(h, { tty = false, reverse = null, multiplex = false } = {}) {
    if (h && h.transport === 'dial') throw new Error(`"${h.name}" is a dial-out device — it has no ssh; this operation must ride the device link`);
    const args = [...SSH_BASE_OPTS, '-p', String(h.port || 22)];
    if (h.keyPath) args.push('-i', h.keyPath, '-o', 'IdentitiesOnly=yes');
    if (multiplex) {
      args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${path.join(this._cmDir, '%C')}`, '-o', 'ControlPersist=600');
    }
    if (tty) args.push('-t');
    // Reverse tunnel (remote 127.0.0.1:<rport> → this server): remote agent
    // tools (vibespace-status/-task) call VIBESPACE_API through it. Placed
    // BEFORE the destination so option parsing is unambiguous. Bind failures
    // (port in use) only warn — the session still runs, tools just degrade.
    if (reverse) args.push('-R', reverse);
    args.push(`${h.user}@${h.host}`);
    return args;
  }

  /** ssh option STRING for tools that take a transport command (rsync -e):
   *  everything sshArgs adds except the destination. */
  sshCmd(h) {
    const args = [...SSH_BASE_OPTS, '-p', String(h.port || 22)];
    if (h.keyPath) args.push('-i', h.keyPath, '-o', 'IdentitiesOnly=yes');
    // rsync transports are short-lived per-op — ride the shared master too
    args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${path.join(this._cmDir, '%C')}`, '-o', 'ControlPersist=600');
    return 'ssh ' + args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
  }

  dest(h) { return `${h.user}@${h.host}`; }

  /** Run a read-only shell probe on ANY machine — ssh hosts via _ssh, dial
   *  devices via the device daemon's run-cmd (2.188.0: the Manage-Agents
   *  status probes were ssh-only, so a selected dial device showed everything
   *  as not-installed/unreachable while the same probes worked over ssh). */
  async _hostShell(h, script, { timeoutMs = 15000 } = {}) {
    try {
      if (h.transport === 'dial') {
        // 15s, not the 6s default (review catch): accountsStatus rides this
        // inside session CREATE (linked/host-held rescue) — a tight bound
        // failed creates a slow-but-healthy link would have served.
        const dm = await this.deviceBounded(h.id, 15000);
        const r = await dm.runCmd('sh', ['-c', script], { timeoutMs });
        return String(r.stdout || '');
      }
      return String(await this._ssh(h, script, { timeoutMs }));
    } catch (e) {
      // Probe-failure telemetry (2.207.0): silent host-probe failures made
      // identity/roster bugs look like data bugs. Name + transport only.
      global.__vsEvent?.('host-probe-failed', h.transport === 'dial' ? 'dial' : 'ssh');
      throw e;
    }
  }

  /** Anthropic login state ON THE HOST (read-only probe, one round trip):
   *  subscription = remote credentials.json holds an OAuth token; cliKey = the
   *  remote's console-login-minted primaryApiKey (importable into the central
   *  store). Mirrors AccountManager's local probes — INCLUDING the API-key
   *  auth shapes (2.188.0: backendStatus learned apiKeyHelper in 2.186.7 but
   *  this probe didn't, so one dialog said "logged in (apiKeyHelper)" on top
   *  and "not logged in" in the accounts roster for the same host). Also
   *  returns the host login's IDENTITY: claude email from ~/.claude.json
   *  oauthAccount (config-reported, can lag a /login switch) and the codex
   *  auth.json id_token payload segment (decoded server-side — the JWT email
   *  can never go stale relative to the token itself). */
  async accountsStatus(id) {
    const h = this.get(id);
    // R1 (three-tier): op-first — the SHARED machine-probes implementation
    // answers from the machine itself (probe-creds). The ssh script below
    // stays as the fallback for daemon-less hosts and pre-R1 daemons (whose
    // unknown-op silence times the bounded request out).
    try {
      const dm = await this.deviceBounded(id, 6000);
      const r = await dm.probeCreds();
      if (r?.facts && r.facts.subscription) return r.facts;
    } catch { }
    // JSON field greps tolerate ": " — the CLI writes ~/.claude.json with
    // INDENTED JSON on most machines, and the old no-space patterns were
    // blind there (real incident: a Console key + email sat in the config
    // for months while accountsStatus reported cliKey absent / email null —
    // "Import its key" never appeared and the key was later orphaned by an
    // OAuth login switch).
    const out = await this._hostShell(h,
      `echo "OS:$(uname -s 2>/dev/null)"; `
      + `S=$(grep -c accessToken "$HOME/.claude/.credentials.json" 2>/dev/null); echo "SUB:$S"; `
      + `K=$(grep -o "primaryApiKey\\": *\\"sk-ant-[^\\"]*" "$HOME/.claude.json" 2>/dev/null | head -1); echo "KEY:$K"; `
      + `grep -q "\\"apiKeyHelper\\"" "$HOME/.claude/settings.json" 2>/dev/null && echo "HELPER:yes" || echo "HELPER:no"; `
      + `E=$(grep -o "emailAddress\\": *\\"[^\\"]*" "$HOME/.claude.json" 2>/dev/null | head -1); echo "EMAIL:$E"; `
      + `J=$(grep -o "id_token\\": *\\"[^\\"]*" "$HOME/.codex/auth.json" 2>/dev/null | head -1 | cut -d. -f2); echo "CXJWT:$J"; `
      // Credential-file mtimes (GNU stat else BSD) — the freshness anchor for
      // the 2.114.1 identity class: a cached roles-derived orgEmail OLDER than
      // the creds file describes the PREVIOUS login and must not be preferred
      // (real report: on-host /login switch kept showing the old account 2h).
      + `M=$(stat -c %Y "$HOME/.claude/.credentials.json" 2>/dev/null || stat -f %m "$HOME/.claude/.credentials.json" 2>/dev/null); echo "CMT:$M"; `
      + `MX=$(stat -c %Y "$HOME/.codex/auth.json" 2>/dev/null || stat -f %m "$HOME/.codex/auth.json" 2>/dev/null); echo "XMT:$MX"; `
      // Per-account subscription logins held ON the host (2.199.0): isolated
      // creds dirs under ~/.vibespace/subs/<acctId> minted by an on-host
      // login (or a past opt-in ship) — a session picking that account runs
      // on the host-side dir, nothing ships. find -exec (no shell globs —
      // zsh nomatch aborts glob-carrying lines in _hostShell scripts).
      + `HS=$(find "$HOME/.vibespace/subs" -maxdepth 2 -name ".credentials.json" -exec grep -l accessToken {} + 2>/dev/null | tr "\\n" " "); echo "HSUBS:$HS"; `
      // Sanitized helper state for a currently-watched on-host login. The
      // attempt id is random but non-secret; matching it avoids both stale
      // markers and another concurrent account's completion.
      + `find "$HOME/.vibespace/subs" -maxdepth 2 -name ".vibespace-login-status.json" -exec grep -H "\\"state\\":" {} + 2>/dev/null | sed "s/^/HSSTAT:/"; `
      // per-dir identity email — the anchor for same-account auto-merge
      // (2.205.0): a host login whose email matches an EXISTING record means
      // duplicate records of one real account
      + `find "$HOME/.vibespace/subs" -maxdepth 2 -name ".claude.json" -exec grep -H -o "emailAddress\\": *\\"[^\\"]*" {} + 2>/dev/null | sed "s/^/HSE:/"`);
    const hostOs = /^OS:([A-Za-z0-9._-]+)\s*$/m.exec(out);
    const sub = /SUB:(\d+)/.exec(out);
    const key = /KEY:primaryApiKey": *"(sk-ant-[^\s"]+)/.exec(out);
    const helper = /HELPER:yes/.test(out);
    const email = /EMAIL:emailAddress": *"([^"\s]+)/.exec(out);
    const cxSeg = /CXJWT:([A-Za-z0-9_-]{8,})/.exec(out);
    const cmt = /CMT:(\d+)/.exec(out);
    const xmt = /XMT:(\d+)/.exec(out);
    let codexEmail = null, codexPlan = null;
    if (cxSeg) {
      try {
        const payload = JSON.parse(Buffer.from(cxSeg[1], 'base64url').toString('utf-8'));
        codexEmail = payload.email || null;
        codexPlan = payload['https://api.openai.com/auth']?.chatgpt_plan_type || null;
      } catch { }
    }
    const hsubs = /HSUBS:([^\n]*)/.exec(out);
    const hostSubs = hsubs
      ? [...hsubs[1].matchAll(/subs\/([\w-]+)\/\.credentials\.json/g)].map((m) => m[1])
      : [];
    const hostSubLoginStatus = {};
    for (const m of out.matchAll(/HSSTAT:.*subs\/([\w-]+)\/\.vibespace-login-status\.json:[^\n]*"state":"(running|success|error)"[^\n]*"attempt":"([a-zA-Z0-9._-]{8,80})"/g)) {
      hostSubLoginStatus[m[1]] = { state: m[2], attempt: m[3] };
    }
    const hostSubEmails = {};
    for (const m of out.matchAll(/HSE:.*subs\/([\w-]+)\/\.claude\.json:emailAddress": *"([^"\s]+)/g)) {
      hostSubEmails[m[1]] = m[2];
    }
    return {
      platform: hostOs ? hostOs[1].toLowerCase() : null,
      subscription: { loggedIn: !!(sub && parseInt(sub[1]) > 0), email: email ? email[1] : null },
      cliKey: key ? { present: true, tail: key[1].slice(-8) } : { present: false },
      keyHelper: helper,
      codex: { email: codexEmail, plan: codexPlan },
      credsMtime: cmt ? parseInt(cmt[1]) : null,      // seconds — claude .credentials.json
      codexAuthMtime: xmt ? parseInt(xmt[1]) : null,  // seconds — codex auth.json
      hostSubs, // acct ids with a live host-side creds dir (~/.vibespace/subs/<id>)
      hostSubLoginStatus, // {acctId:{state,attempt}} from sanitized on-host helper markers
      hostSubEmails, // { acctId: identity email of its host-side dir } — merge anchor
    };
  }

  /** Rename a per-account creds dir on the host (same-account record merge —
   *  2.205.0). Refuses to clobber an existing target dir. */
  async renameHostSubDir(id, fromAcct, toAcct) {
    if (!/^sub-[\w-]{1,40}$/.test(fromAcct) || !/^sub-[\w-]{1,40}$/.test(toAcct)) throw new Error('bad account id');
    const h = this.get(id);
    const out = await this._hostShell(h,
      `if [ -e "$HOME/.vibespace/subs/${toAcct}" ]; then echo EXISTS; elif [ -d "$HOME/.vibespace/subs/${fromAcct}" ]; then mv "$HOME/.vibespace/subs/${fromAcct}" "$HOME/.vibespace/subs/${toAcct}" && echo MOVED; else echo ABSENT; fi`);
    return /MOVED/.test(out);
  }

  /** Full remote primaryApiKey + org name (for one-click import into the
   *  central store — travels over the ssh/device channel, never argv). */
  async cliPrimaryKey(id) {
    const h = this.get(id);
    // ": *" tolerance — indented-JSON configs (see accountsStatus note)
    const out = await this._hostShell(h,
      `grep -o "primaryApiKey\\": *\\"sk-ant-[^\\"]*" "$HOME/.claude.json" 2>/dev/null | head -1; grep -o "organizationName\\": *\\"[^\\"]*" "$HOME/.claude.json" 2>/dev/null | head -1`);
    const key = /primaryApiKey": *"(sk-ant-[^\s"]+)/.exec(out);
    const org = /organizationName": *"([^"]+)/.exec(out);
    return { key: key ? key[1] : null, org: org ? org[1] : null };
  }

  /** Remote $HOME, cached per host — injection needs ABSOLUTE remote paths
   *  (agent file tools don't expand ~ or $HOME). */
  async homeDir(h) {
    if (!this._homes) this._homes = new Map();
    if (this._homes.has(h.id)) return this._homes.get(h.id);
    try {
      // dial machines have no ssh — resolve the home over the device link
      // (B-0d70: a null home here made New Session default the device cwd to
      // the LOCAL home, which doesn't exist on the device → spawn/cd failure).
      let out;
      if (h.transport === 'dial') {
        // 15s (review catch): this default feeds the session-create cwd — a
        // deadline records the POD's local home as the device cwd (B-0d70).
        const dm = await this.deviceBounded(h.id, 15000);
        out = String((await dm.runCmd('sh', ['-c', 'echo "$HOME"'])).stdout || '').trim().split('\n').pop().trim();
      } else {
        out = String(await this._ssh(h, 'echo "$HOME"')).trim().split('\n').pop().trim();
      }
      if (out && out.startsWith('/')) { this._homes.set(h.id, out); return out; }
    } catch { }
    return null;
  }

  _ssh(h, remoteCmd, { timeoutMs = 15000, maxBuffer = 4 * 1024 * 1024, encoding, fresh = false } = {}) {
    return new Promise((resolve, reject) => {
      execFile('ssh', [...this.sshArgs(h, { multiplex: !fresh }), '--', remoteCmd], { timeout: timeoutMs, maxBuffer, ...(encoding !== undefined ? { encoding } : {}) }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr?.toString() || err.message || '').trim().slice(0, 300)));
        resolve(stdout);
      });
    });
  }

  /** Connectivity + remote tool inventory in ONE round trip. */
  async test(id) {
    const h = this.get(id);
    // dial machine: no ssh — a real round trip over the dialed-in link (runCmd
    // exercises the whole mux path) + the daemon's self-reported identity.
    if (h.transport === 'dial') {
      if (!this.dialOnline?.(h.deviceId)) throw new Error('not dialed in — start the daemon on the device (rerun the install command)');
      const t0 = Date.now();
      const dm = await this.deviceBounded(id, 8000);
      const st = dm.status();
      let tools;
      try {
        const r = await dm.runCmd('sh', ['-c', 'for c in dtach node claude codex; do command -v $c >/dev/null 2>&1 && printf "%s=yes " $c || printf "%s=no " $c; done'], { timeoutMs: 8000 });
        tools = {};
        for (const m of String(r.stdout || '').matchAll(/(\w+)=(yes|no)/g)) tools[m[1]] = m[2] === 'yes';
      } catch { tools = null; } // Windows daemon: no sh — identity still proves the link
      return { ok: true, latencyMs: Date.now() - t0, dial: true, tools, info: st.info || null };
    }
    const probe = REMOTE_PRELUDE + 'echo VS-OK; for c in dtach node claude codex; do command -v $c >/dev/null 2>&1 && printf "%s=yes " $c || printf "%s=no " $c; done; echo; uname -sm';
    const t0 = Date.now();
    // The probe must measure what SESSIONS experience: a FRESH connection.
    // Multiplexed probes ride the persisted ControlMaster, whose ESTABLISHED
    // TCP flow survives firewall/route changes (conntrack keeps it; the
    // keepalives maintain it) — so a host whose address went dark kept
    // showing READY for hours while every new session pipe timed out (real
    // userL report 2.228.1: sidebar green, session stuck "host
    // reconnecting"). On fresh-fail we still try the mux once, ONLY to name
    // the situation precisely.
    let out;
    try {
      out = await this._ssh(h, probe, { timeoutMs: 10000, fresh: true });
    } catch (freshErr) {
      let muxAlive = false;
      try { muxAlive = String(await this._ssh(h, 'echo VS-MUX', { timeoutMs: 6000 })).includes('VS-MUX'); } catch {}
      if (muxAlive) {
        throw new Error(`new SSH connections fail (${String(freshErr.message || freshErr).slice(0, 120)}) while an already-established channel still responds — the network path to this host changed (firewall/NAT/address). File transfers over the old channel may still work, but sessions cannot connect until the address is fixed.`);
      }
      throw freshErr;
    }
    if (!out.includes('VS-OK')) throw new Error('unexpected response');
    const tools = {};
    for (const m of out.matchAll(/(\w+)=(yes|no)/g)) tools[m[1]] = m[2] === 'yes';
    return { ok: true, latencyMs: Date.now() - t0, tools, uname: (out.trim().split('\n').pop() || '').trim() };
  }

  /** Kill an EXTERNAL/tmux agent process ON the host (sidebar Terminate for
   *  remote-discovered sessions — the pid is remote). Validates the pid is a
   *  claude/codex process there before SIGTERM; device link first, ssh
   *  fallback (dial machines have no ssh). */
  async killRemotePid(id, pid) {
    const h = this.get(id);
    const p = parseInt(pid, 10);
    if (!Number.isFinite(p) || p <= 1) throw new Error('bad pid');
    const cmd = `C=$(ps -p ${p} -o args= 2>/dev/null); case "$C" in *claude*|*codex*) kill -TERM ${p} && echo VS_OK;; "") echo VS_GONE;; *) echo VS_NOTAGENT;; esac`;
    let out = '';
    if (h.transport === 'dial' || this.dataPlaneOn?.()) {
      try { const dm = await this.deviceBounded(id); out = String((await dm.runCmd('sh', ['-c', cmd], { timeoutMs: 10000 })).stdout || ''); }
      catch (e) { if (h.transport === 'dial') throw new Error('device unreachable: ' + e.message); }
    }
    if (!out) out = String(await this._ssh(h, cmd));
    if (out.includes('VS_NOTAGENT')) throw new Error('that PID is not a claude/codex process on the host');
    if (!out.includes('VS_OK') && !out.includes('VS_GONE')) throw new Error('kill failed: ' + out.trim().slice(0, 120));
    this.invalidateDiscovery(id); // the card should flip on the next poll
    return { success: true, gone: out.includes('VS_GONE') };
  }

  /** Remote directory autocomplete — parent-dir listing, prefix-filter.
   *  Device link first (the ONLY path for dial machines — real report: the
   *  pull dialog completed LOCAL folders; ssh fallback below unchanged). */
  async dirComplete(id, input) {
    const h = this.get(id);
    const raw = String(input || '');
    const slash = raw.lastIndexOf('/');
    const parent = slash >= 0 ? raw.slice(0, slash) || '/' : '';
    const prefix = slash >= 0 ? raw.slice(slash + 1) : raw;
    if (h.transport === 'dial' || this.dataPlaneOn?.()) {
      try {
        const dm = await this.deviceBounded(id, 4000);
        let base = parent;
        if (base === '' || base === '~') base = String((await dm.runCmd('sh', ['-c', 'echo "$HOME"'], { timeoutMs: 5000 })).stdout || '').trim() || '/';
        else if (base.startsWith('~/')) base = String((await dm.runCmd('sh', ['-c', 'echo "$HOME"'], { timeoutMs: 5000 })).stdout || '').trim() + base.slice(1);
        const r = await dm.fsList(base);
        const shown = (parent === '' || parent === '~') ? '~' : parent;
        return r.entries
          .filter(e => e.isDir && e.name.toLowerCase().startsWith(prefix.toLowerCase()))
          .slice(0, 20)
          .map(e => (shown === '/' ? '/' : shown + '/') + e.name);
      } catch { if (h.transport === 'dial') return []; /* ssh hosts fall through */ }
    }
    const base = (parent === '' || parent === '~') ? '"$HOME"' : `'${parent.replace(/'/g, `'\\''`)}'`;
    const out = await this._ssh(h, `cd ${base} 2>/dev/null && ls -1ap 2>/dev/null | grep '/$' | head -60`, { timeoutMs: 6000 }).catch(() => '');
    const shownParent = (parent === '' || parent === '~') ? '~' : parent;
    return out.split('\n')
      .map(s => s.replace(/\/$/, ''))
      .filter(s => s && s !== '.' && s !== '..' && s.toLowerCase().startsWith(prefix.toLowerCase()))
      .slice(0, 20)
      .map(s => (shownParent === '/' ? '/' : shownParent + '/') + s);
  }

  /** Backend status on a host (mirrors local /api/backend-status shape). */
  async backendStatus(id) {
    const h = this.get(id);
    // R1: op-first (shared machine-probes via probe-cli); ssh script fallback.
    try {
      const dm = await this.deviceBounded(id, 6000);
      const r = await dm.probeCli();
      const f = r?.facts;
      if (f?.claude) {
        return {
          claude: { installed: !!f.claude.installed, ...(f.claude.version ? { version: f.claude.version } : {}),
            loggedIn: !!f.claude.loggedIn, ...(f.claude.loginMethod ? { loginMethod: f.claude.loginMethod } : {}),
            ...(f.claude.keyHelper ? { keyHelper: true } : {}) },
          codex: { installed: !!f.codex.installed, ...(f.codex.version ? { version: f.codex.version } : {}), loggedIn: !!f.codex.loggedIn },
        };
      }
    } catch { }
    const probe = REMOTE_PRELUDE
      + 'for c in claude codex; do '
      + 'if command -v $c >/dev/null 2>&1; then v=$($c --version 2>/dev/null | head -1); echo "$c|yes|$v"; else echo "$c|no|"; fi; done; '
      // login state: OAuth token OR console-managed key OR an apiKeyHelper —
      // .credentials.json existence alone missed every API-key-authed machine
      // (real report: an apiKeyHelper host ran claude fine, showed "not
      // logged in"). Quoted grep patterns so a prompt-history mention (stored
      // JSON-escaped as \"…\") can't false-positive.
      + 'if grep -q accessToken "$HOME/.claude/.credentials.json" 2>/dev/null; then echo "claude-login|yes|oauth"; '
      + 'elif grep -q "\\"primaryApiKey\\"" "$HOME/.claude.json" 2>/dev/null; then echo "claude-login|yes|console-key"; '
      + 'elif grep -q "\\"apiKeyHelper\\"" "$HOME/.claude/settings.json" 2>/dev/null; then echo "claude-login|yes|key-helper"; '
      + 'elif command -v security >/dev/null 2>&1 && security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; then echo "claude-login|yes|keychain"; '
      + 'else echo "claude-login|no"; fi; '
      // apiKeyHelper as an INDEPENDENT flag (2.191.0, real CW-H200 mixup): the
      // CLI's real precedence puts a configured helper ABOVE OAuth (verified
      // in the 2.1.211 binary — HS() disables claude.ai auth whenever the
      // merged settings carry apiKeyHelper, valid creds or not). The elif
      // ladder above hides the helper the moment OAuth creds exist, so the
      // dialog said "logged in" while every session billed via the helper.
      + 'grep -q "\\"apiKeyHelper\\"" "$HOME/.claude/settings.json" 2>/dev/null && echo "claude-helper|yes"; '
      + '[ -f "$HOME/.codex/auth.json" ] && echo "codex-login|yes" || echo "codex-login|no"';
    const out = await this._hostShell(h, probe, { timeoutMs: 10000 });
    const st = { claude: {}, codex: {} };
    for (const line of out.split('\n')) {
      const [k, v, ver] = line.split('|');
      if (k === 'claude' || k === 'codex') { st[k].installed = v === 'yes'; if (ver) st[k].version = ver.trim(); }
      else if (k === 'claude-login') { st.claude.loggedIn = v === 'yes'; if (ver) st.claude.loginMethod = ver.trim(); }
      else if (k === 'claude-helper') st.claude.keyHelper = v === 'yes';
      else if (k === 'codex-login') st.codex.loggedIn = v === 'yes';
    }
    return st;
  }

  // ── VibeSpace integration on the host (2.129.0, backlog B-34bb) ─────────
  // Transparency for the ~/.vibespace footprint remote sessions leave on a
  // box (the user was rightly startled finding it unannounced): what's
  // installed, whether it matches the local copies, whether the hook is
  // registered in the REMOTE's own CLI configs, and how many keeper session
  // files exist — plus explicit install/refresh + remove.

  /** The STATIC agent-tool set shipped to remotes. Readers use agentTools()
   *  (below), which appends the plugin-generated shims — the per-spawn
   *  distribution in ws-create, agentToolsStatus/installAgentTools here. */
  static AGENT_TOOLS = ['vibespace-status', 'vibespace-task', 'vibespace-ask', 'vibespace-exit', 'vibespace-job', 'vibespace-docs', 'vibespace-msg', 'vibespace-page', 'vibespace-hook.mjs', 'vibespace-hook-register.mjs', 'vibespace-remote-keeper', 'vibespace-claude-subscription-login.mjs', 'vibespace-usage'];
  /** Plugin agent-tool shims (Plugin Ph4, 2.369.30): the loader installs a
   *  provider returning the `vibespace-tool-<plugin>-<name>` files it
   *  generates right now, so they ship to ssh hosts and dial devices with the
   *  core tools (docs/plugins.md). Default = none (no loader = no shims). */
  static extraAgentTools = () => [];
  /** THE ship list: static tools + live plugin shims (deduped, static first). */
  static agentTools() {
    let extra = [];
    try { extra = (HostManager.extraAgentTools() || []).filter((n) => typeof n === 'string' && /^vibespace-tool-[a-z0-9.-]+$/.test(n)); } catch { extra = []; }
    return [...HostManager.AGENT_TOOLS, ...extra.filter((n) => !HostManager.AGENT_TOOLS.includes(n))];
  }

  /** Integration state ON THE HOST in one ssh round trip: per-tool presence +
   *  sha256 (content compare beats mtime — the local hook/status tools are
   *  REGENERATED every server boot with identical content), hook registration
   *  (grep in the remote's own settings), node availability, keeper session
   *  files. Read-only probe. */
  async agentToolsStatus(id) {
    const h = this.get(id);
    const probe = REMOTE_PRELUDE
      + `for f in ${HostManager.agentTools().join(' ')}; do `
      + 'p="$HOME/.vibespace/bin/$f"; if [ -f "$p" ]; then s=$( (sha256sum "$p" 2>/dev/null || shasum -a 256 "$p" 2>/dev/null) | cut -d" " -f1 ); echo "T|$f|$s"; else echo "T|$f|"; fi; done; '
      + 'command -v node >/dev/null 2>&1 && echo "NODE|yes" || echo "NODE|no"; '
      + 'grep -q vibespace-hook.mjs "$HOME/.claude/settings.json" 2>/dev/null && echo "HOOK|claude|yes" || echo "HOOK|claude|no"; '
      + 'grep -q vibespace-hook.mjs "$HOME/.codex/hooks.json" 2>/dev/null && echo "HOOK|codex|yes" || echo "HOOK|codex|no"; '
      + 'echo "KEEP|$(ls "$HOME/.vibespace/run" 2>/dev/null | grep -c "\\.sock$")"';
    const out = await this._hostShell(h, probe, { timeoutMs: 12000 });
    const st = { tools: {}, node: false, hooks: {}, keeperSessions: 0 };
    for (const line of out.split('\n')) {
      const p = line.trim().split('|');
      if (p[0] === 'T') st.tools[p[1]] = { present: !!p[2], sha256: p[2] || null };
      else if (p[0] === 'NODE') st.node = p[1] === 'yes';
      else if (p[0] === 'HOOK') st.hooks[p[1]] = p[2] === 'yes';
      else if (p[0] === 'KEEP') st.keeperSessions = parseInt(p[1], 10) || 0;
    }
    return st;
  }

  /** Install/refresh the tools + register the hook — the SAME tar-over-stdin
   *  channel the per-spawn distribution uses (nothing bulky/secret in argv;
   *  no token here, tokens stay strictly per-session). */
  installAgentTools(id, toolDir) {
    const h = this.get(id);
    const present = HostManager.agentTools().filter((n) => { try { return fs.statSync(path.join(toolDir, n)).isFile(); } catch { return false; } });
    if (!present.length) throw new Error('no agent tools found locally');
    const { execFileSync } = require('child_process');
    const tar = execFileSync('tar', ['-c', '-C', toolDir, ...present], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    return new Promise((resolve, reject) => {
      const child = execFile('ssh', [...this.sshArgs(h, { multiplex: true }), '--',
        'umask 077; mkdir -p "$HOME/.vibespace/bin"; tar -x -C "$HOME/.vibespace/bin"; chmod +x "$HOME/.vibespace/bin"/vibespace-* 2>/dev/null || true; '
        + REMOTE_PRELUDE
        // POSIX node finder (2.244.4): nvm.sh sourcing only works in bash — a
        // dash login shell leaves `node` unresolvable (userN's Novita)
        + nodeFinder()
        + '[ -n "$VS_NODE" ] && "$VS_NODE" "$HOME/.vibespace/bin/vibespace-hook-register.mjs" 2>/dev/null; echo VS-INSTALLED'],
        { timeout: 30000 }, (err, stdout, stderr) => {
          if (err) return reject(new Error((stderr?.toString() || err.message || '').trim().slice(0, 300)));
          if (!String(stdout).includes('VS-INSTALLED')) return reject(new Error('unexpected response'));
          resolve({ installed: present });
        });
      child.stdin.end(tar);
    });
  }

  /** ── CS data-plane (2.146.0): per-host DeviceManager over the ssh stdio
   *  bridge — the shared engine for the fs/discovery/transcript/usage
   *  switchovers. ALWAYS ON since the 2.175.0 graduation;
   *  connection failures surface so callers fall back to the legacy ssh path.
   *  deps.agentd = { ensureAgentdOnHost, agentdHostToken, bundlePath, version }
   *  injected by server.js after boot. ── */
  /** device() with a hard connect DEADLINE — for READ-ONLY probes and
   *  interactive surfaces (B-fa6f, userN's flapping H200 links): the
   *  connect retry ladder runs up to ~2.7 minutes, and on a lossy path where
   *  TCP opens but the ssh banner hangs (ConnectTimeout only bounds the TCP
   *  connect — verified live) every data-plane consumer sat on that ladder
   *  BEFORE reaching its own ssh fallback / error UI. The race never cancels
   *  the underlying connect — a later success still heals the cached link
   *  for everyone. Session-ESTABLISHING paths keep calling device() directly:
   *  they want the full ladder. */
  deviceBounded(id, connectMs = 6000) {
    const p = this.device(id);
    // Observe the LOSER: after the deadline wins, the underlying connect keeps
    // running (deliberate — a late success heals the cached link), but a late
    // ladder-exhausted REJECTION with no remaining handler is an
    // unhandledRejection, which crashes modern Node. One no-op catch marks it
    // handled without swallowing the race's own rejection path.
    p.catch(() => { });
    return Promise.race([
      p,
      new Promise((_, rj) => setTimeout(() => rj(new Error(`device link not responding within ${Math.round(connectMs / 1000)}s — it may be flapping; reconnection keeps retrying in the background, try again shortly`)), connectMs).unref()),
    ]);
  }

  /** THE machine handle — remote host OR this machine (device #0).
   *
   *  CS SEPARATION (2.276.0): `hostId` must be a PARAMETER, not a branch. The
   *  local daemon has been a full DeviceManager since 2.158.0 (same binary,
   *  same mux, same op surface — the transport is the ONLY difference), but it
   *  lived in a server.js variable that `device()` could not return because
   *  this method started with `this.get(id)`. So every consumer wrote
   *  `if (host) { …dm path… } else { …local path… }` — two implementations per
   *  feature, and the local twin is the one nobody exercises when they fix a
   *  remote bug (and vice versa: the remote twin is the one that silently
   *  lags). Passing a falsy id now yields device #0, so a consumer can be
   *  written ONCE and run on any machine including this one. */
  setLocalDevice(dm) { this._localDevice = dm; }
  isLocal(id) { return !id || id === 'local'; }

  async device(id) {
    if (this.isLocal(id)) {
      if (!this._localDevice) throw new Error('local device daemon is not available');
      return this._localDevice;
    }
    if (!this._devices) this._devices = new Map();
    const cached = this._devices.get(id);
    if (cached?.status().connected) return cached;
    // IN-FLIGHT DEDUP (review catch): deviceBounded abandons its race loser,
    // so without this every timed-out probe stacked ANOTHER full connect
    // ladder (fresh DeviceManager + ensureAgentdOnHost ssh + up to ~13 ssh
    // spawns) — a 5s-polling sidebar against a flapping host multiplied them.
    if (!this._deviceInflight) this._deviceInflight = new Map();
    const inflight = this._deviceInflight.get(id);
    if (inflight) return inflight;
    const p = this._deviceConnect(id);
    this._deviceInflight.set(id, p);
    p.finally(() => this._deviceInflight.delete(id)).catch(() => { });
    return p;
  }

  /** R4: every connected device pushes transcript-growth dirt (the daemon
   *  fs.watches .claude/sessions+projects and .codex/sessions). One signal,
   *  two consumers: discovery cache freshness + the push-triggered usage
   *  harvest (server wires onDeviceDirty). Idempotent per dm; the client
   *  re-arms it on reconnect. Failure is harmless — polling remains. */
  _armDirtyPush(id, dm) {
    try {
      dm.watchDiscovery(() => {
        try { this.invalidateDiscovery(id); } catch { }
        try { this.onDeviceDirty?.(id); } catch { }
      }).catch(() => { });
    // session-brain step 2 (DARK): device-side normalizer stream — consumer
    // only COMPARES until parity earns the switch. Failure harmless.
    try { dm.watchSessionEvents?.((m) => { try { this.onSessionEvents?.(id, m); } catch { } }).catch(() => { }); } catch { }
    } catch { }
    // usage-events PUSH (R4 finale): events stream in seconds-fresh; the ack
    // AFTER durable ingest commits the device cursor (two-phase). When this
    // stream is live the 60s-floor dirty-kick harvest becomes the fallback
    // rung (it stays armed — a lapsed push heals through it). Capability-
    // gated; old daemons just keep the pull path.
    try {
      dm.watchUsageEvents?.((m) => {
        try {
          const text = (m.batch || []).join('\n');
          const r = this.onUsageEvents?.(id, text);
          if (m.seq != null) {
            // ingest is synchronous today (ingestRemoteEvents appends + fsyncs
            // via appendFileSync) — ack only on success; a throw above leaves
            // the batch unacked and it re-emits
            if (r !== false) dm.ackUsageEvents(m.seq);
          }
        } catch { /* unacked → re-emitted → rid dedup absorbs */ }
      }).catch(() => { });
    } catch { }
  }

  async _deviceConnect(id) {
    if (!this.agentdDeps) throw new Error('agentd deps not wired');
    const h = this.get(id);
    // dial hosts have no ssh — the daemon is already dialed IN; drive it
    // over that live stream (deviceForDial caches per device id)
    if (h.transport === 'dial') {
      if (!this.agentdDeps.deviceForDial) throw new Error('dial transport not wired');
      const dm = await this.agentdDeps.deviceForDial(h.deviceId);
      this._devices.set(id, dm);
      this._armDirtyPush(id, dm);
      return dm;
    }
    // GRADUATED ssh host with a LIVE dial-in link (B-6640): ride the ws
    // dial stream — our own handshake/heartbeat/backpressure — instead of an
    // ssh child (banner hangs, ControlMaster staleness, per-op spawns). Any
    // failure falls straight through to the ssh path: never worse than today.
    if (h.deviceId && this.dialOnline?.(h.deviceId) && this.agentdDeps.deviceForDial) {
      try {
        const dm = await this.agentdDeps.deviceForDial(h.deviceId);
        this._devices.set(id, dm);
        this._armDirtyPush(id, dm);
        return dm;
      } catch { /* ssh fallback below */ }
    }
    await this.agentdDeps.ensureAgentdOnHost(id);
    const remoteCmd = REMOTE_PRELUDE + `exec node "$HOME/.vibespace/agentd/current/agentd.js" --stdio`;
    const { DeviceManager } = require('./agentd/client.js');
    const dm = new DeviceManager({
      dataDir: this.dataDir,
      bundlePath: this.agentdDeps.bundlePath,
      version: this.agentdDeps.version,
      transport: { kind: 'ssh', hostToken: this.agentdDeps.agentdHostToken(id), sshBin: 'ssh', sshArgs: this.sshArgs(h, { multiplex: true }), remoteCmd },
      log: () => {},
    });
    await dm.connect();
    this._devices.set(id, dm);
    this._armDirtyPush(id, dm);
    // We are now talking to this machine's daemon — but over an ssh child
    // (per-op spawns, banner hangs, ControlMaster staleness). ws is strictly
    // better once it exists, so tell the server it may graduate this machine
    // in the background. ssh stays the bootstrap + rescue channel forever.
    try { this.onSshConnected?.(id); } catch { }
    return dm;
  }

  /** M2 remote install: land the agentd bundle into ~/.vibespace/agentd/<ver>/
   *  + symlink `current`, and provision the host vsht_ token (0600) so the
   *  standing remote daemon authenticates the server's ssh-bridge connection.
   *  Bundle + token ride ONE tar over ssh stdin (never argv). Idempotent. */
  installAgentd(id, bundlePath, version, hostToken) {
    const h = this.get(id);
    const { execFileSync } = require('child_process');
    if (!fs.existsSync(bundlePath)) throw new Error('device daemon bundle missing: ' + bundlePath);
    // stage a tar with two entries: agentd.js + token
    const os2 = require('os');
    const stage = fs.mkdtempSync(path.join(os2.tmpdir(), 'vs-agentd-stage-'));
    try {
      fs.copyFileSync(bundlePath, path.join(stage, 'agentd.js'));
      fs.writeFileSync(path.join(stage, 'token'), String(hostToken), { mode: 0o600 });
      const tar = execFileSync('tar', ['-c', '-C', stage, 'agentd.js', 'token'], { timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
      const ver = JSON.stringify(String(version));
      const remote = 'umask 077; D="$HOME/.vibespace/agentd"; mkdir -p "$D/'+String(version).replace(/[^\w.-]/g,'')+'" "$D/state"; '
        + 'tar -x -C "$D/state"; ' // extracts agentd.js + token into state/ temporarily
        + 'mv -f "$D/state/agentd.js" "$D/'+String(version).replace(/[^\w.-]/g,'')+'/agentd.js"; '
        + 'chmod 600 "$D/state/token"; ln -sfn "$D/'+String(version).replace(/[^\w.-]/g,'')+'" "$D/current"; '
        + 'echo VS-AGENTD-INSTALLED';
      return new Promise((resolve, reject) => {
        const child = execFile('ssh', [...this.sshArgs(h, { multiplex: true }), '--', remote],
          { timeout: 30000 }, (err, stdout, stderr) => {
            try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
            if (err) return reject(new Error((stderr?.toString() || err.message || '').trim().slice(0, 300)));
            if (!String(stdout).includes('VS-AGENTD-INSTALLED')) return reject(new Error('unexpected response: ' + String(stdout).slice(0, 120)));
            resolve({ agentdPath: '$HOME/.vibespace/agentd/current/agentd.js' });
          });
        child.stdin.end(tar);
      });
    } catch (e) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}; throw e; }
  }

  /** Remove the integration: unregister the hook from the remote CLI configs
   *  (needs the register script still present — runs BEFORE the rm), then rm
   *  exactly our tool files. Per-session token files (.tok-*) and account key
   *  files are left alone (running sessions own them); NOTE a future remote
   *  session spawn re-installs everything by design (per-spawn distribution). */
  async uninstallAgentTools(id) {
    const h = this.get(id);
    const rms = HostManager.agentTools().map((n) => `"$HOME/.vibespace/bin/${n}"`).join(' ');
    // plugin shims of plugins disabled/uninstalled since the last ship are not
    // in the live list any more — the glob sweeps every generated shim
    const cmd = REMOTE_PRELUDE
      + nodeFinder() + 'if [ -n "$VS_NODE" ] && [ -f "$HOME/.vibespace/bin/vibespace-hook-register.mjs" ]; then "$VS_NODE" "$HOME/.vibespace/bin/vibespace-hook-register.mjs" --uninstall 2>/dev/null || true; fi; '
      + `rm -f ${rms} "$HOME"/.vibespace/bin/vibespace-tool-* 2>/dev/null; echo VS-REMOVED`;
    const out = String(await this._ssh(h, cmd, { timeoutMs: 15000 }));
    if (!out.includes('VS-REMOVED')) throw new Error('unexpected response');
    return { ok: true };
  }

  // ── In-app key generation (optional; default is the user's own ~/.ssh) ──

  keyInfo() {
    const priv = path.join(this._sshDir, 'id_ed25519');
    try {
      const pub = fs.readFileSync(priv + '.pub', 'utf-8').trim();
      return { exists: true, path: priv, publicKey: pub };
    } catch { return { exists: false, path: priv, publicKey: null }; }
  }

  generateKey() {
    if (this.keyInfo().exists) return this.keyInfo();
    fs.mkdirSync(this._sshDir, { recursive: true, mode: 0o700 });
    return new Promise((resolve, reject) => {
      execFile('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'vibespace', '-f', path.join(this._sshDir, 'id_ed25519')], (err) => {
        if (err) return reject(new Error('ssh-keygen failed: ' + err.message));
        resolve(this.keyInfo());
      });
    });
  }

  // ── Remote session transcripts (JSONL over ssh → local cache) ──
  // The cache makes remote sessions first-class: findSessionJsonlPath scans
  // data/remote-jsonl/<hostId>/, so history load / View History / pagination /
  // search all work unchanged. Invalidation by remote size+mtime (one ssh stat
  // when fresh; stat+cat when stale). Session ids are UUIDs — no collisions.
  async fetchSessionJsonl(id, sessionId, opts = {}) { return this.fetchTranscript(id, 'claude', sessionId, opts); }
  // Does the host still run a LIVE keeper child for this claude conversation?
  // Returns the keeper sid to ATTACH to (ws create keeperSid path — never a
  // second writer), or null. One read-only probe: scan the persistence-layer
  // session metas mentioning the conversation id, keep only those whose
  // childPid (the claude process) is alive. 2.218.0 — resume host inference's
  // double-writer guard. ssh hosts scan the keeper's ~/.vibespace/run; DIAL
  // devices scan the daemon's pipe-session store (~/.vibespace/*/state/
  // sessions — the sid feeds attach-pipe-session, audit #11/#47).
  async findKeeperFor(id, conversationId) {
    if (!/^[\w-]+$/.test(conversationId)) return null;
    const h = this.get(id);
    if (!h) return null;
    const cid = JSON.stringify(conversationId);
    // ONE scan over BOTH stores, returning {sid, kind} (2.247.3): the old ssh
    // leg read only legacy ~/.vibespace/run — it never saw agentd pipe
    // sessions at all — and matching by grep-in-state-json only found RESUMED
    // spawns (the --resume arg embeds the cid); a fresh-spawned claude's
    // conversation id lives ONLY in its own lock ~/.claude/sessions/<pid>.json,
    // so the second grep leg covers those (userL's 12 orphans were all
    // invisible to the old probe for one reason or the other). kind tells the
    // consumer WHICH attach transport the sid belongs to — tagging a legacy
    // keeper sid as agentd (or vice versa) routes the adopt into a binary
    // that has never heard of it.
    const script = `scan() { for f in "$1"/*.json; do [ -e "$f" ] || continue
      grep -q '"exited"' "$f" 2>/dev/null && continue
      cpid=$(sed -n 's/.*"childPid":\\([0-9]*\\).*/\\1/p' "$f" | head -1)
      [ -n "$cpid" ] && kill -0 "$cpid" 2>/dev/null || continue
      if grep -l ${cid} "$f" >/dev/null 2>&1 || grep -l ${cid} "$HOME/.claude/sessions/$cpid.json" >/dev/null 2>&1; then echo "$2|$(basename "$f" .json)"; fi
    done; }
    for d in "$HOME"/.vibespace/*/state/sessions; do [ -d "$d" ] && scan "$d" agentd; done
    scan "$HOME/.vibespace/run" keeper`;
    try {
      // SESSION-ESTABLISHING (review catch, do not re-bound BELOW 15s): this
      // probe decides ADOPT-a-live-claude vs sweep+respawn — a deadline here
      // reads as "no live keeper" and the writer sweep then SIGTERMs the
      // healthy claude the full ladder would have adopted. 15s per the
      // documented invariant (the ssh leg was 10s, below the bar the dial
      // leg already honored — 2.271.0 audit T1-1/T1-7).
      const out = String(await this._hostShell(h, script, { timeoutMs: 15000 }) || '');
      const hits = out.trim().split('\n').map((l) => l.trim()).filter((l) => /^(agentd|keeper)\|[\w][\w-]*$/.test(l))
        .map((l) => { const [kind, sid] = l.split('|'); return { kind, sid }; });
      // newest-transport first: an agentd hit wins over a legacy keeper one
      return hits.find((x) => x.kind === 'agentd') || hits[0] || null;
    } catch (e) {
      // CRITICAL DISTINCTION (2.271.0, the sweep-kills-healthy-claude class):
      // a FAILED probe (timeout/host lag) must NOT read as "no keeper" — the
      // caller would sweep+respawn and SIGTERM the surviving claude it should
      // have adopted, corrupting the transcript with a second writer. Return a
      // distinct sentinel so every consumer can refuse-and-retry instead.
      return { error: true, reason: String(e?.message || e) };
    }
  }
  // Remote SUBAGENT transcript (2.191.0, remote workflow viewer's View Log):
  // agent-<id>.jsonl lives under <projDir>/<sid>/subagents/ (plain agents) or
  // <sid>/subagents/workflows/wf_*/ (dynamic-workflow agents) — same
  // cache/invalidation model as the session transcript.
  async fetchAgentJsonl(id, agentId, { claudeSessionId = '', maxBytes = 32 * 1024 * 1024 } = {}) {
    if (!/^[\w-]+$/.test(agentId)) throw new Error('bad agent id');
    const sidPath = claudeSessionId && /^[\w-]+$/.test(claudeSessionId)
      ? `-path ${JSON.stringify('*/' + claudeSessionId + '/subagents/*')}` : `-path '*/subagents/*'`;
    return this._fetchRemoteByFind(id, `-maxdepth 6 -name ${JSON.stringify('agent-' + agentId + '.jsonl')} ${sidPath}`,
      path.join(id, 'agents', 'agent-' + agentId + '.jsonl'), { maxBytes });
  }
  // Remote CODEX rollout (B-10ed): view-history/resume-load of a codex thread
  // that ran on the host. Cached under remote-jsonl/<host>/codex/ — the codex
  // finder (findCodexSessionJsonlPath) scans that cache like claude's.
  async fetchCodexJsonl(id, threadId, opts = {}) { return this.fetchTranscript(id, 'codex', threadId, opts); }
  /** THE remote transcript fetch (S3): the harness descriptor's store.remoteFind
   *  names where find(1) looks on the host, the predicate (codex: .jsonl OR
   *  .jsonl.zst — a compressed rollout lands under the .jsonl cache name and
   *  readers detect it by magic bytes) and the cache name; this method only
   *  runs the shared fetch-and-cache core. Unknown backends throw in get(). */
  async fetchTranscript(id, backend, sessionId, { maxBytes = null } = {}) {
    if (!/^[\w-]+$/.test(String(sessionId || ''))) throw new Error('bad session id');
    const h = require('./harnesses').get(backend || 'claude');
    if (!h.store || typeof h.store.remoteFind !== 'function') throw new Error(`${h.id} conversations cannot be fetched from a host (no remote transcript location)`);
    const rf = h.store.remoteFind(sessionId);
    const r = await this._fetchRemoteByFind(id, rf.findExpr, path.join(id, rf.cacheRel), { maxBytes: maxBytes || rf.maxBytes || 64 * 1024 * 1024, root: rf.root });
    if (h.id === 'claude') { try { this.convIndex.note(sessionId, id, { src: 'fetch' }); } catch { } } // conversation-location index (R3 tail)
    return r;
  }
  // Shared fetch-and-cache core (generalized from fetchSessionJsonl 2.191.0 —
  // findExpr = the find(1) predicate under "$HOME"/.claude/projects; cacheRel
  // = path under data/remote-jsonl/). All the 2.187.0/2.188.1 integrity
  // invariants live HERE: count-gated reads, never stamp meta for bytes not
  // received, cache-valid requires the FILE to hold meta.size bytes.
  async _fetchRemoteByFind(id, findExpr, cacheRel, { maxBytes = 64 * 1024 * 1024, root = '"$HOME"/.claude/projects' } = {}) {
    const h = this.get(id);
    const cachePath = path.join(this.dataDir, 'remote-jsonl', cacheRel);
    // Known-unreachable host memo (2.218.0, real report): with the host DOWN,
    // every window's view-only attach ate a full ssh connect timeout (~15s)
    // before the stale-cache fallback kicked in — a desktop of 3 such windows
    // read as "blank/gone". After one timeout, serve the cache instantly for
    // 60s instead of re-probing per request.
    if (Date.now() < (this._hostDownUntil?.get(id) || 0) && fs.existsSync(cachePath)) return cachePath;
    const dir = path.dirname(cachePath);
    const metaPath = cachePath + '.meta';
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
    // ONE CACHE SLOT, MANY REMOTE FILES (2.369.x, codex .zst). A backend's
    // remoteFind predicate may resolve DIFFERENT files across polls — codex
    // matches `rollout-*<tid>.jsonl` OR `….jsonl.zst`, and the host compresses
    // a finished rollout — while the slot is keyed by conversation id only.
    // The meta recorded {size,mtime} alone, so the append-only delta path
    // happily concatenated the compressed file's bytes onto the cached PLAIN
    // prefix (or vice versa) and stamped the result complete; a stopped thread
    // never changes again, so the corrupt transcript was served forever. The
    // meta now records the resolved remote path + whether it is compressed:
    // a changed path invalidates the slot (full refetch), and a compressed
    // remote (or an already-compressed cache file) is NEVER delta-appended —
    // recompression rewrites the whole file, it does not append plain bytes.
    // HEALING A SLOT THE PRE-FIX CODE ALREADY CORRUPTED (same batch, review
    // follow-up): provenance only protects slots THIS code wrote. A meta
    // stamped before the field exists carries no remotePath, and reading that
    // as "same file" is vacuously true — so an ALREADY spliced cache (plain
    // prefix + the twin's bytes, stamped complete) kept passing the size/mtime
    // short-circuit and was served forever, because a stopped thread never
    // changes again. A meta WITHOUT provenance is therefore NOT valid: refetch
    // whole once and rewrite it. And never take the meta's word about the
    // BYTES either — a hybrid is visible in the file itself: the head tells
    // plain from compressed, and an append always lands its foreign bytes at
    // the TAIL. A plain transcript is UTF-8 JSON text, so neither marker can
    // occur there legitimately: a raw NUL is invalid JSON (it must be escaped),
    // and the frame magic's first two bytes `28 b5` are invalid UTF-8 (0xb5 is
    // a continuation byte and '(' is not a lead byte) — no false positives, and
    // a false one would only cost one refetch anyway.
    const readCacheAt = (pos, len) => {
      let fd;
      try {
        fd = fs.openSync(cachePath, 'r');
        const b = Buffer.alloc(len);
        const n = fs.readSync(fd, b, 0, len, pos);
        return b.subarray(0, Math.max(0, n));
      } catch { return Buffer.alloc(0); } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { } } }
    };
    const cacheIsCompressed = () => isZstBuffer(readCacheAt(0, 4));
    const spliceMarkers = (buf) => buf.includes(0x00) || buf.indexOf(ZSTD_MAGIC) >= 0;
    // The splice markers are looked for in the TAIL, because an append lands
    // its foreign bytes there. ONE decision outlives that window: the over-cap
    // ADOPTION below keeps bytes this code never fetched, and a slot the
    // pre-fix delta path spliced and then kept appending to has the marker
    // BURIED under the later appends — invisible to a 4KB tail read. So the
    // adoption (and only the adoption, it is paid once per slot) scans the
    // WHOLE file: chunked, with a 3-byte carry so a magic split across a
    // chunk boundary is still seen.
    const wholeCacheOk = (csize) => {
      const CH = 1 << 20;
      let fd;
      try {
        fd = fs.openSync(cachePath, 'r');
        const buf = Buffer.alloc(CH + 3);        // [0,3) = the previous window's last 3 bytes
        let pos = 0, carryLen = 0;
        while (pos < csize) {
          const n = fs.readSync(fd, buf, 3, Math.min(CH, csize - pos), pos);
          if (n <= 0) return false;                                       // unreadable ⇒ cannot verify
          const win = buf.subarray(3 - carryLen, 3 + n);
          if (spliceMarkers(win)) return false;
          pos += n;
          carryLen = Math.min(3, win.length);
          win.subarray(win.length - carryLen).copy(buf, 3 - carryLen);
        }
        return true;
      } catch { return false; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { } } }
    };
    const cacheBytesOk = (remotePath, { deep = false } = {}) => {
      let csize = 0;
      try { csize = fs.statSync(cachePath).size; } catch { return false; }
      const head = readCacheAt(0, 4);
      const zstRemote = isZstPath(remotePath);
      if (head.length >= 4) {
        if (isZstBuffer(head) !== zstRemote) return false;                // the other twin's bytes are in the slot
        if (zstRemote) return true;                                       // compressed: the magic IS the evidence
      } else if (zstRemote) {
        return false;                                                     // a zstd frame is never shorter than its 4-byte magic
      }
      // A cache SHORTER than the magic cannot be judged BY the magic — but it
      // also cannot BE a compressed frame nor hide a splice, and an empty or
      // one-tiny-record transcript is perfectly legitimate. Reading that as
      // "unverifiable ⇒ refetch" re-pulled every such transcript on EVERY poll
      // forever (the check below still applies to whatever bytes exist).
      if (head.length && /\.jsonl$/i.test(cachePath) && head[0] !== 0x7b && head[0] !== 0x5b) return false; // a JSONL cache starts with a record
      if (deep) return wholeCacheOk(csize);
      const tail = readCacheAt(Math.max(0, csize - 4096), Math.min(4096, csize));
      return !spliceMarkers(tail);
    };
    // A pre-provenance meta heals by ONE whole refetch. The single exception:
    // a remote grown past maxBytes cannot be refetched whole at all (the delta
    // path is how such a slot got there), and failing "too large" on a
    // transcript that worked yesterday is a worse answer than the byte check —
    // there, a verified cache adopts the provenance we just resolved.
    const sameRemote = (remotePath) => !!meta && meta.remotePath === remotePath;
    const adopting = (remotePath, size) => !sameRemote(remotePath) && !!meta && !meta.remotePath && size > maxBytes;
    // WHICH SLOTS OWE WHOLE-FILE EVIDENCE (review round 2). Provenance alone is
    // not proof the bytes were ever deep-checked: the tail-only adoption that
    // shipped before this fix ADOPTED a buried hybrid and then let the delta
    // path stamp remotePath onto it, so `sameRemote` is true for exactly the
    // corruption this scan exists to find. A meta is trusted on the cheap tail
    // check only once it carries the schema marker every writer below stamps —
    // i.e. once THIS code verified (or fetched) the bytes. Older metas pay for
    // one whole-file scan the first time their bytes are trusted, and are
    // re-stamped so it is paid ONCE per slot, never per poll.
    const META_V = 2;
    const legacyMeta = () => !!meta && !(Number(meta.v) >= META_V);
    const provenanceOk = (remotePath, size) => sameRemote(remotePath) || adopting(remotePath, size);
    const cacheUsable = (remotePath, size) => provenanceOk(remotePath, size)   // cheap verdict first — the deep scan only runs on bytes we might actually trust
      && cacheBytesOk(remotePath, { deep: legacyMeta() });
    // …and the verification is RECORDED before we hand the cache back. Without
    // the stamp the slot stays legacy forever and every later poll re-runs the
    // whole-file scan. `adopted` additionally marks bytes we VERIFIED rather
    // than fetched (the over-cap exception), for anyone reading the meta later.
    const stampVerified = (remotePath, size, mtime) => {
      const adopt = !sameRemote(remotePath);
      if (!adopt && !legacyMeta()) return;                                  // already ours, already current-schema
      try {
        meta = { ...(meta || {}), size, mtime, fetchedAt: Date.now(), remotePath, compressed: isZstPath(remotePath), v: META_V, ...(adopt ? { adopted: true } : {}) };
        fs.writeFileSync(metaPath, JSON.stringify(meta));
      } catch { }
    };
    // PROVENANCE IS DURABLE — SO THE META WRITERS MUST NOT REBUILD IT (review
    // round 3). Both rungs stamped a FRESH object at the end of a fetch, so a
    // delta that grew an ADOPTED over-cap slot erased the one marker saying
    // "these bytes were VERIFIED, never fetched" (and the `slab` lane marker
    // with it) — exactly the durability the adoption note above claims. The
    // prior meta is spread and this fetch overwrites only what it just
    // learned. A WHOLE refetch is the single case that legitimately drops
    // those two: they describe bytes that are no longer in the slot, while a
    // delta keeps the prefix they were stamped for.
    const nextMeta = (fields, { whole }) => {
      const m = { ...(meta || {}) };
      if (whole) { delete m.adopted; delete m.slab; }
      return { ...m, ...fields, fetchedAt: Date.now(), compressed: isZstPath(fields.remotePath), v: META_V };
    };
    // …and when a whole refetch is BOTH impossible (over the cap) and the only
    // way out (the cache did not verify), say so — including that there is no
    // remedy on this side. "remote transcript too large" alone sends the reader
    // diagnosing a size problem on a slot whose real fault is spliced bytes; an
    // error string is not a diagnosis, and neither is advice that cannot work
    // (this suffix is reachable ONLY when the remote is past the cap, so
    // deleting the cache just destroys the last copy and fails identically).
    const tooLarge = (n, cacheVerified) => new Error(`remote transcript too large (${(n / 1048576) | 0}MB)`
      + (!cacheVerified && fs.existsSync(cachePath) ? ` — and the cached copy could not be verified (bytes from another file, or spliced), so there is no prefix to grow from; the remote is past the ${(maxBytes / 1048576) | 0}MB fetch cap and cannot be re-fetched whole (deleting the cache would not help)` : ''));
    // CS data-plane: INCREMENTAL slab sync — transcripts are append-only, so
    // when the cache already holds a prefix we fetch ONLY [cachedSize, size)
    // via read-range instead of re-pulling the whole file (the remote-jsonl
    // whole-file cache's biggest cost). Any failure → legacy ssh path below.
    if (this.dataPlaneOn?.() || h.transport === 'dial') {
      try {
        const dm = await this.deviceBounded(id);
        // locate via the discovery snapshot (cached-ish) or a targeted find —
        // `sort` makes the pick DETERMINISTIC and prefers the plain twin
        // (".jsonl" sorts before ".jsonl.zst"), so a codex thread whose
        // rollout exists in both forms doesn't flap between them per poll
        const find = await dm.runCmd('sh', ['-c', `find ${root} ${findExpr} 2>/dev/null | sort | head -1`]);
        const remotePath = find.stdout.trim();
        if (!remotePath) return fs.existsSync(cachePath) ? cachePath : null;
        const st = await dm.fsStat(remotePath);
        const size = st.stat.size, mtime = Math.floor(st.stat.mtimeMs / 1000);
        // cache "valid" requires the FILE to actually hold meta.size bytes — a
        // pre-2.187.0 truncated fetch stamped full-size meta over a 256KB stump,
        // and for a transcript that never grows again (stopped session) the
        // size/mtime match would serve the stump FOREVER (the self-heal only
        // triggers when the remote file changes) — and the bytes must have come
        // from the SAME remote file (see the cache-slot note above)
        const usable = cacheUsable(remotePath, size);   // ONE verdict per poll (a legacy slot's whole-file scan is not run twice)
        if (meta && meta.size === size && meta.mtime === mtime && usable && (() => { try { return fs.statSync(cachePath).size === size; } catch { return false; } })()) { stampVerified(remotePath, size, mtime); return cachePath; }
        fs.mkdirSync(dir, { recursive: true });
        let localSize = 0;
        try { localSize = fs.statSync(cachePath).size; } catch { }
        // append-only delta is legal ONLY when the same, uncompressed remote
        // file grew: a different remote path (or either side compressed) means
        // the cached prefix is not a prefix of what we are fetching. The
        // both-compressed case looks the most innocent and is the worst: same
        // path, verified bytes (a .zst slot's magic IS its evidence), cached
        // archive shorter than the remote — yet re-compression REWRITES the
        // archive, so the "delta" would weld a foreign frame tail onto the old
        // frames. Negative-controlled in test-codex-zst ⑥d on BOTH rungs.
        const canDelta = usable && !isZstPath(remotePath) && !cacheIsCompressed();
        // the cap guards what we FETCH — with a warm prefix that's just the
        // delta, so a transcript growing past maxBytes keeps incrementing
        // instead of suddenly erroring (a 45MB real session was on track)
        const deltaSlab = canDelta && localSize > 0 && localSize <= size && !!meta;
        const fetchBytes = deltaSlab ? size - localSize : size;
        if (fetchBytes > maxBytes) throw tooLarge(fetchBytes, usable);
        if (deltaSlab) {
          // append-only delta — the slab win
          if (size > localSize) {
            const delta = await dm.fsReadRange(remotePath, localSize, size - localSize);
            // NEVER stamp meta for bytes we didn't get (a truncated read once
            // cached a 256KB prefix as a "complete" 45MB transcript — the
            // permanently-ancient-history incident); mismatch → legacy ssh
            if (delta.data.length !== size - localSize) throw new Error(`short read-range: ${delta.data.length} of ${size - localSize}`);
            fs.appendFileSync(cachePath, delta.data);
          }
        } else {
          // no/invalid prefix (or remote rotated smaller) — full streamed fetch
          const whole = await dm.fsReadRange(remotePath, 0, size);
          if (whole.data.length !== size) throw new Error(`short read-range: ${whole.data.length} of ${size}`);
          const tmp2 = cachePath + '.tmp';
          fs.writeFileSync(tmp2, whole.data);
          fs.renameSync(tmp2, cachePath);
        }
        fs.writeFileSync(metaPath, JSON.stringify(nextMeta({ size, mtime, slab: true, remotePath }, { whole: !deltaSlab })));
        return cachePath;
      } catch (e2) { /* legacy fallback below */ }
    }
    const probe = `f=$(find ${root} ${findExpr} 2>/dev/null | sort | head -1); [ -n "$f" ] && { stat -c '%s %Y' "$f" 2>/dev/null || stat -f '%z %m' "$f"; } && echo "$f"`;
    let out;
    try {
      out = (await this._ssh(h, probe, { timeoutMs: 15000 })).toString().trim();
      this._hostDownUntil?.delete(id); // reachable again — drop the memo
    }
    catch (e) {
      // Host unreachable (machine down, network partition) — remember for 60s
      // (see the memo check at entry) and serve the stale cached transcript;
      // only throw when there's nothing to serve.
      (this._hostDownUntil ||= new Map()).set(id, Date.now() + 60000);
      if (fs.existsSync(cachePath)) return cachePath;
      throw e;
    }
    if (!out) return fs.existsSync(cachePath) ? cachePath : null; // gone remotely — keep stale cache if any
    const [sizeMtime, remotePath] = [out.split('\n')[0], out.split('\n')[1]];
    const [size, mtime] = sizeMtime.split(' ').map(Number);
    // same stump-integrity + same-remote-file + cache-bytes checks as the slab path above
    const usableSsh = cacheUsable(remotePath, size);
    if (meta && meta.size === size && meta.mtime === mtime && usableSsh && (() => { try { return fs.statSync(cachePath).size === size; } catch { return false; } })()) { stampVerified(remotePath, size, mtime); return cachePath; }
    let localSizeSsh = 0;
    try { localSizeSsh = fs.statSync(cachePath).size; } catch { }
    // APPEND-ONLY DELTA ON THE LEGACY RUNG TOO (B-7638 round 2). The slab rung
    // has grown an over-cap slot by its delta since 2.187.0; this rung only
    // ever whole-`cat`ted, so the SAME conversation — one the data plane is
    // off/failing for — hard-failed "too large" on its very next byte of
    // growth: a >maxBytes transcript that opened yesterday is an error today,
    // with no fallback to the verified cache. Same legality test as the slab
    // rung (same remote file, uncompressed on both sides — a re-compressed
    // .zst remote over a .zst cache is a whole refetch, ⑥d — cached prefix no
    // longer than the remote), same never-stamp-bytes-we-didn't-get rule;
    // `tail -c +N` is 1-based on both GNU and BSD.
    const canDeltaSsh = usableSsh && !isZstPath(remotePath) && !cacheIsCompressed() && localSizeSsh > 0 && localSizeSsh <= size && !!meta;
    const fetchBytesSsh = canDeltaSsh ? size - localSizeSsh : size;
    if (fetchBytesSsh > maxBytes) throw tooLarge(fetchBytesSsh, usableSsh);
    fs.mkdirSync(dir, { recursive: true });
    let stampSize = size;
    let grewSsh = false;
    if (canDeltaSsh) {
      try {
        if (size > localSizeSsh) {
          const delta = await this._ssh(h, `tail -c +${localSizeSsh + 1} ${JSON.stringify(remotePath)}`, { timeoutMs: 120000, maxBuffer: maxBytes + 1024, encoding: 'buffer' });
          // fewer bytes than the stat promised = a truncated read: never stamp
          // those (the 2.187.0 stump rule). MORE is normal on a live transcript —
          // it grew between the stat and the read, and an append-only file's
          // extra tail bytes are genuinely its next bytes — so keep them and
          // stamp what the file ACTUALLY holds (the stump check compares the two).
          if (delta.length < size - localSizeSsh) throw new Error(`short tail read: ${delta.length} of ${size - localSizeSsh}`);
          fs.appendFileSync(cachePath, delta);
          stampSize = localSizeSsh + delta.length;
        }
        grewSsh = true;
      } catch (eDelta) {
        // THE DELTA IS AN OPTIMISATION, NOT THE ONLY ROAD (round 3). Round 2
        // REPLACED the whole `cat` on the LAST rung with the delta, so a `tail`
        // that fails — the remote truncated/rotated between the stat and the
        // read, or a host whose `tail` has no `-c +N` — now hard-fails a fetch
        // the pre-delta code completed, and this rung has nothing below it to
        // fall through to. Under the cap the whole file is still fetchable, so
        // fetch it; the hard error is kept for the ONE case where a whole
        // re-pull is impossible by construction (over the cap — where the
        // delta was not an optimisation but the only road).
        if (size > maxBytes) throw eDelta;
        console.warn(`[hosts] ${id}: tail delta failed (${eDelta && eDelta.message || eDelta}) — falling back to a whole fetch`);
        stampSize = size;
      }
    }
    if (!grewSsh) {
      const buf = await this._ssh(h, `cat ${JSON.stringify(remotePath)}`, { timeoutMs: 120000, maxBuffer: maxBytes + 1024, encoding: 'buffer' });
      const tmp = cachePath + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, cachePath);
    }
    fs.writeFileSync(metaPath, JSON.stringify(nextMeta({ size: stampSize, mtime, remotePath }, { whole: !grewSsh })));
    return cachePath;
  }

  // Remote WORKFLOW state (2.191.0, remote View Workflow): one read-only
  // compound probe (ssh multiplexed ~50ms warm, or dial runCmd) returning the
  // terminal snapshot + live journal + agent-file inventory for a run. TTL
  // cache 2s — below the viewer's 2.5s live poll, so N clients ≈ 1 round trip
  // per 2s. Payload sections are nonce-delimited (snapshot/journal content is
  // arbitrary text — fixed markers could collide). stat is GNU-else-BSD so
  // macOS dial devices work.
  async fetchWorkflowState(id, runId, claudeSessionId = '', cwd = '') {
    if (!/^wf_[\w-]{1,64}$/.test(runId)) throw new Error('bad run id');
    const h = this.get(id);
    if (!this._wfStateCache) this._wfStateCache = new Map();
    const key = id + ':' + runId;
    const hit = this._wfStateCache.get(key);
    if (hit && Date.now() - hit.at < 2000) return hit.val;
    const nonce = crypto.randomBytes(8).toString('hex');
    const M = (s) => `__VSWF_${nonce}_${s}__`;
    const sidOk = claudeSessionId && /^[\w-]+$/.test(claudeSessionId);
    const projDir = sidOk && cwd ? cwdToProjectDir(String(cwd)) : '';
    const targeted = projDir
      ? `S="$P"/${JSON.stringify(projDir)}/${JSON.stringify(claudeSessionId)}/workflows/${JSON.stringify(runId + '.json')}; [ -f "$S" ] || S=""; D="$P"/${JSON.stringify(projDir)}/${JSON.stringify(claudeSessionId)}/subagents/workflows/${JSON.stringify(runId)}; [ -d "$D" ] || D=""; `
      : '';
    const script = `P="$HOME/.claude/projects"; S=""; D=""; ${targeted}`
      + `[ -n "$S" ] || S=$(find "$P" -maxdepth 4 -name ${JSON.stringify(runId + '.json')} -path '*/workflows/*' 2>/dev/null | head -1); `
      + `[ -n "$D" ] || D=$(find "$P" -maxdepth 5 -name ${JSON.stringify(runId)} -type d -path '*/subagents/workflows/*' 2>/dev/null | head -1); `
      + `mt(){ stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }; `
      + `echo "SNAPMT:$( [ -n "$S" ] && mt "$S" )"; `
      + `echo "JMT:$( [ -n "$D" ] && mt "$D/journal.jsonl" )"; `
      + `echo "AMT:$( [ -n "$D" ] && for f in "$D"/agent-*.jsonl; do [ -f "$f" ] && mt "$f"; done | sort -n | tail -1 )"; `
      + `[ -n "$D" ] && ls -1 "$D" 2>/dev/null | sed 's/^/AG:/'; `
      + `echo "NM:$( [ -n "$D" ] && ls -1 "$(dirname "$(dirname "$(dirname "$D")")")/workflows/scripts" 2>/dev/null | grep -F -- ${JSON.stringify('-' + runId + '.js')} | head -1 )"; `
      // dial run-cmd slices stdout at 1MB — keep the whole payload under it
      // (snapshot 700K + journal 250K + headers; a truncated journal only
      // degrades attempt labels, a truncated snapshot 500s with a clear error)
      + `echo ${JSON.stringify(M('SNAP'))}; [ -n "$S" ] && head -c 700000 "$S"; `
      + `echo; echo ${JSON.stringify(M('JOURNAL'))}; [ -n "$D" ] && head -c 250000 "$D/journal.jsonl"; echo`;
    const out = await this._hostShell(h, script, { timeoutMs: 20000 });
    const [head, rest] = out.split(M('SNAP') + '\n');
    if (rest === undefined) throw new Error('workflow probe returned no payload');
    const [snapRaw, journalRaw] = rest.split('\n' + M('JOURNAL') + '\n');
    const headLines = head.split('\n');
    const grab = (p) => { const l = headLines.find((x) => x.startsWith(p)); return l ? l.slice(p.length).trim() : ''; };
    const val = {
      snapMtime: Number(grab('SNAPMT:')) || 0,
      journalMtime: Number(grab('JMT:')) || 0,
      agentMtime: Number(grab('AMT:')) || 0,
      agentFiles: headLines.filter((x) => x.startsWith('AG:')).map((x) => x.slice(3).trim()).filter(Boolean),
      scriptName: grab('NM:'),
      snapText: (snapRaw || '').trim() || null,
      journalText: (journalRaw === undefined ? '' : journalRaw),
      hasRunDir: false,
    };
    val.hasRunDir = !!(val.journalMtime || val.agentMtime || val.agentFiles.length);
    this._wfStateCache.set(key, { at: Date.now(), val });
    return val;
  }

  // ── Remote usage (2.127.0) ──

  /** Harvest per-request usage events from the host's ~/.claude transcripts.
   *  Ships the scanner over ssh STDIN (never argv) and runs it; the remote
   *  keeps its own byte cursors (~/.vibespace/usage-cursor.json), so after the
   *  first full pass each harvest returns only NEW events. Throttled 15min per
   *  host unless forced. Returns the raw NDJSON text ('' when throttled). */
  async harvestUsage(id, { force = false, scannerPath, minIntervalMs } = {}) {
    const h = this.get(id);
    if (!this._usageHarvestAt) this._usageHarvestAt = new Map();
    const last = this._usageHarvestAt.get(id) || 0;
    // minIntervalMs: the event-driven cadence (a remote session's turn just
    // ended → harvest soon so the ledger + billing popup lag ~a minute, not
    // 15). The 15-min default remains the idle/背景 cadence. Still one ssh/
    // device round trip per call — never sub-minute.
    const gate = Math.max(60 * 1000, minIntervalMs ?? 15 * 60 * 1000);
    if (!force && Date.now() - last < gate) return '';
    this._usageHarvestAt.set(id, Date.now());
    const script = fs.readFileSync(scannerPath, 'utf-8');
    // CS data-plane: ship+run the scanner through the daemon (streaming exec —
    // NDJSON output can be huge). Same cursor semantics; legacy ssh fallback.
    if (this.dataPlaneOn?.() || h.transport === 'dial') {
      try {
        const dm = await this.deviceBounded(id);
        // R4 `usage.scan`: the walker is BUNDLED in the daemon (≥2.286.0) —
        // no per-harvest script ship, and the cursor commits over the device
        // link ONLY after the count-gated transfer fully landed server-side
        // (two-phase: a link death mid-transfer leaves the cursor put, the
        // next harvest re-emits, rid dedup absorbs — the script's
        // flush-then-persist model lost that window's events forever on
        // relayed paths). Older daemon / op failure → script-ship fallback.
        try {
          const r = await dm.usageScan();
          if (r.cursors && r.cursorFile) {
            try {
              await dm.fsWrite(r.cursorFile + '.tmp', JSON.stringify(r.cursors));
              await dm.fsRename(r.cursorFile + '.tmp', r.cursorFile);
            } catch (e4) { console.warn('[usage] cursor commit failed (next harvest re-emits):', e4.message); }
          }
          return r.ndjson;
        } catch (e3) {
          if (!/lacks usage-scan/.test(e3.message || '')) console.warn('[usage] usage-scan op failed, falling back to script ship:', e3.message);
        }
        const home = (await dm.runCmd('sh', ['-c', 'echo "$HOME"'])).stdout.trim();
        const scanPath = home + '/.vibespace/bin/vibespace-usage-scan';
        await dm.fsWrite(scanPath, script); // fsWrite mkdirs the parent
        const chunks = [];
        const { code, error } = await dm.runStream('node', [scanPath], { onData: (b) => chunks.push(b) });
        if (error) throw new Error(error);
        if (code !== 0) throw new Error('scanner exit ' + code);
        return Buffer.concat(chunks).toString('utf-8');
      } catch (e2) {
        // DIAL has no ssh fallback (sshArgs throws 'is a dial-out device'),
        // and the ssh path would MISDIAGNOSE the device-link failure as a
        // transport-absent one (2.271.0 T3-6). Rethrow the real error and
        // reset the throttle so the next kick retries instead of a silent
        // 15-min block on a misleading message.
        if (h.transport === 'dial') { this._usageHarvestAt.set(id, 0); throw e2; }
        /* ssh host: fall through to the legacy ssh path below */
      }
    }
    return new Promise((resolve, reject) => {
      const child = execFile('ssh', [...this.sshArgs(h, { multiplex: true }), '--',
        'umask 077; mkdir -p "$HOME/.vibespace/bin"; cat > "$HOME/.vibespace/bin/vibespace-usage-scan"; ' + REMOTE_PRELUDE + 'node "$HOME/.vibespace/bin/vibespace-usage-scan"'],
        { timeout: 180000, maxBuffer: 128 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) { this._usageHarvestAt.set(id, 0); return reject(new Error((stderr || err.message || '').toString().slice(0, 200))); }
          resolve(stdout.toString());
        });
      child.stdin.end(script);
    });
  }

  /** READ-ONLY peek at the host's own claude login token (ban-safety: never
   *  refresh, never write — expired/absent → null; the host's own CLI usage
   *  refreshes it). Powers the on-demand quota ⟳ for remote hosts. */
  async readRemoteOAuth(id) {
    const h = this.get(id);
    let raw;
    // _hostShell: dial devices peek via the device link (2.188.0 — the ⟳ in
    // the quota popup threw for paired devices; the peek was ssh-only)
    // UNREACHABLE ≠ TOKEN-ABSENT (2.271.0 T2-12): both used to return null, so
    // the ⟳ route told the user "no valid login on the host — log in there"
    // when the host was merely down. Throw a tagged error instead; the route
    // renders "host unreachable" and skips stamping its throttle.
    try { raw = await this._hostShell(h, 'cat "$HOME/.claude/.credentials.json" 2>/dev/null || true', { timeoutMs: 10000 }); }
    catch (e) { const err = new Error('host unreachable: ' + (e?.message || e)); err.code = 'host-unreachable'; throw err; }
    try {
      const o = JSON.parse(raw).claudeAiOauth;
      if (o?.accessToken && (!o.expiresAt || o.expiresAt > Date.now() + 60000)) return o.accessToken;
    } catch { }
    return null;
  }

  /** READ-ONLY peek at a host-HELD account's login token (2.245.0): the
   *  isolated creds dir ~/.vibespace/subs/<subId> a per-account on-host login
   *  minted. Same §ban-safety class as readRemoteOAuth — never refresh, never
   *  write; expired/absent → null (the account's own sessions on the host
   *  refresh it). Powers the on-demand quota ⟳ for host-held accounts. */
  async readRemoteSubOAuth(id, subId) {
    if (!/^sub-[\w-]{1,40}$/.test(String(subId || ''))) return null;
    const h = this.get(id);
    let raw;
    // same unreachable-vs-absent split as readRemoteOAuth (2.271.0 T2-12)
    try { raw = await this._hostShell(h, `cat "$HOME/.vibespace/subs/${subId}/.credentials.json" 2>/dev/null || true`, { timeoutMs: 10000 }); }
    catch (e) { const err = new Error('host unreachable: ' + (e?.message || e)); err.code = 'host-unreachable'; throw err; }
    try {
      const o = JSON.parse(raw).claudeAiOauth;
      if (o?.accessToken && (!o.expiresAt || o.expiresAt > Date.now() + 60000)) return o.accessToken;
    } catch { }
    return null;
  }

  // ── Remote session discovery (lock-first, same algorithm as local) ──

  /** Cheap link-state classifier for the offline-bias defense:
   *  'online'  — dial link live, or a cached device connection reports connected
   *  'offline' — dial host with NO live link, or a fresh unreachable memo
   *  'unknown' — pure-ssh host with no cached facts (reachability is probed at
   *              use; absence of evidence is not evidence of absence).
   *  Deliberately never probes — this runs inside estimator/pool decisions. */
  linkState(id) {
    const h = this.get(id);
    if (!h) return 'unknown';
    try {
      if (h.transport === 'dial' || h.deviceId) {
        if (this.dialOnline?.(h.deviceId || id)) return 'online';
        if (h.transport === 'dial') return 'offline'; // dial-only: no link = unreachable
      }
      if ((this._hostDownUntil?.get(id) || 0) > Date.now()) return 'offline';
      const dm = this._devices?.get(id);
      if (dm?.status?.().connected) return 'online';
    } catch { }
    return 'unknown';
  }

  /** The single owning host of a conversation per the location index, or
   *  null (unknown/ambiguous). Claims from since-removed hosts are ignored. */
  conversationOwner(sessionId) {
    try { return this.convIndex.ownerHost(sessionId, (hid) => !!this.get(hid)); } catch { return null; }
  }

  async discoverSessions(id, { ttlMs = 15000 } = {}) {
    const h = this.get(id);
    const hit = this._discoveryCache.get(id);
    if (hit && Date.now() - hit.at < ttlMs) return hit.sessions;
    // STALE-WHILE-REVALIDATE (2.320.0, inc-msp2srj2 "AIDev默认没有session"):
    // a COLD sweep blocks 10-60s right after a server restart (device
    // bootstrap, daemon self-upgrade, ssh master rebuild — measured 12.3s on
    // a healthy link), and for that whole window the zone renders EMPTY.
    // The persisted last-known list was sitting on disk the entire time but
    // was only consulted on FAILURE. Serve it IMMEDIATELY (stale-marked) and
    // refresh in the BACKGROUND — the 2.310.0 remote-sessions push delivers
    // the fresh result to every client when it lands. An explicit ⟳
    // (ttlMs 0) still blocks for the real scan, so "refresh" means refresh.
    if (ttlMs > 0 && !hit && this._persistedDisc[id]?.sessions?.length) {
      try { this.onDiscoveryDirty?.(id); } catch { } // debounced: one background compute + one broadcast
      return this._persistedDisc[id].sessions.map((x) => ({ ...x, stale: true }));
    }
    // One round trip: alive lock files + all project JSONLs (path, mtime, size)
    const script = `
      find "$HOME"/.claude/sessions -maxdepth 1 -name '*.json' 2>/dev/null | while read -r f; do
        pid=$(basename "$f" .json)
        kill -0 "$pid" 2>/dev/null && { echo "LOCK $(cat "$f")"; }
      done
      # -printf is GNU-only — on macOS/BSD ssh hosts it errored into the
      # 2>/dev/null and the WHOLE remote history silently vanished (audit
      # 2.192.0). Probe once; BSD falls back to a stat -f loop (slower but
      # correct; Linux keeps the single-command fast path).
      if find "$HOME"/.claude -maxdepth 0 -printf '' 2>/dev/null; then GNUFIND=1; else GNUFIND=; fi
      if [ -n "$GNUFIND" ]; then
        find "$HOME"/.claude/projects -maxdepth 2 -name '*.jsonl' ! -name 'agent-*' -printf 'J %T@ %s %p\\n' 2>/dev/null | sort -rn -k2 | head -200
      else
        find "$HOME"/.claude/projects -maxdepth 2 -name '*.jsonl' ! -name 'agent-*' 2>/dev/null | while read -r f; do
          set -- $(stat -f '%m %z' "$f" 2>/dev/null); [ -n "$1" ] && echo "J $1 $2 $f"
        done | sort -rn -k2 | head -200
      fi
      # K = keeper session metas (~/.vibespace/run) — lets discovery classify a
      # keeper-managed claude as reattachable instead of generic 'external'
      # (B-4058: pod rebuild loses local state; the keeper+claude survive)
      find "$HOME"/.vibespace/run -maxdepth 1 -name '*.json' 2>/dev/null | while read -r kf; do
        printf 'K %s\\t' "$(basename "$kf" .json)"; head -c 4000 "$kf" | tr -d '\\n'; echo
      done
      # cwd from the head of each JSONL (projDir decode is ambiguous; the first
      # record may be a summary without cwd, so grep the first cwd field instead)
      { if [ -n "$GNUFIND" ]; then
          find "$HOME"/.claude/projects -maxdepth 2 -name '*.jsonl' ! -name 'agent-*' -printf '%T@ %p\\n' 2>/dev/null
        else
          find "$HOME"/.claude/projects -maxdepth 2 -name '*.jsonl' ! -name 'agent-*' 2>/dev/null | while read -r f; do
            m=$(stat -f '%m' "$f" 2>/dev/null); [ -n "$m" ] && echo "$m $f"
          done
        fi; } | sort -rn | head -60 | while read -r _ f; do
        printf 'H %s\\t' "$f"; head -c 16000 "$f" | grep -o '"cwd":"[^"]*"' | head -n 1; echo
        # up to 6 early user records (NOT just the first) — the first user turn is
        # often an injected <vibespace-task-context>/<system-reminder>; the JS side
        # skips those and takes the first REAL message (matches local naming).
        grep -m6 '"type":"user"' "$f" 2>/dev/null | while IFS= read -r u; do printf 'N %s\\t' "$f"; printf '%s' "$u" | head -c 2000; printf '\\n'; done
        # T = sessionIds seen in the file TAIL (last = current writer; records
        # carry the CURRENT id even when a resume kept the ORIGINAL filename).
        # uniq collapses runs (records from one session are consecutive).
        printf 'T %s\\t' "$f"; tail -c 65536 -- "$f" 2>/dev/null | grep -o '"sessionId":"[^"]*"' | cut -d'"' -f4 | uniq | tail -n 8 | tr '\\n' ','; echo
      done
      # C = codex rollouts (~/.codex/sessions) so codex terminal sessions run
      # remotely reappear as resumable STOPPED cards (B-10ed — they used to
      # vanish from the sidebar the moment they ended). HC = head cwd.
      if [ -d "$HOME/.codex/sessions" ]; then
        CDX=$({ if [ -n "$GNUFIND" ]; then
          find "$HOME"/.codex/sessions -type f \\( -name 'rollout-*.jsonl' -o -name 'rollout-*.jsonl.zst' \\) -printf 'C %T@ %s %p\\n' 2>/dev/null
        else
          find "$HOME"/.codex/sessions -type f \\( -name 'rollout-*.jsonl' -o -name 'rollout-*.jsonl.zst' \\) 2>/dev/null | while read -r f; do
            m=$(stat -f '%m %z' "$f" 2>/dev/null); [ -n "$m" ] && echo "C $m $f"
          done
        fi; } | sort -rn -k2 | head -100)
        [ -n "$CDX" ] && printf '%s\\n' "$CDX"
        # HC = head cwd; NC = the first user records (2000B each, the codex naming
        # rule picks the first non-injected one); a .zst rollout is read through
        # zstd(1) when the host has it, else it lists nameless. CO = rollouts held
        # OPEN by a codex process = RUNNING threads (no lock files in codex).
        [ -n "$CDX" ] && printf '%s\\n' "$CDX" | head -30 | while read -r c m s f; do
          case "$f" in *.zst) HD=$( (command -v zstd >/dev/null 2>&1 && zstd -dc -- "$f" 2>/dev/null) | head -c 200000 );; *) HD=$(head -c 200000 -- "$f" 2>/dev/null);; esac
          printf 'HC %s\\t' "$f"; printf '%s' "$HD" | grep -o '"cwd":"[^"]*"' | head -n 1; echo
          printf '%s' "$HD" | grep -m3 '"role":"user"' | while IFS= read -r u; do printf 'NC %s\\t' "$f"; printf '%s' "$u" | head -c 2000; printf '\\n'; done
        done
        if [ -d /proc/self ]; then
          for p in /proc/[0-9]*; do
            tr '\\0' ' ' < "$p/cmdline" 2>/dev/null | grep -qE '(^|[/ ])codex( |$)|/@openai/codex/|/codex-linux-' || continue
            for l in "$p"/fd/*; do t=$(readlink "$l" 2>/dev/null) || continue; case "$t" in "$HOME"/.codex/sessions/*rollout-*.jsonl|"$HOME"/.codex/sessions/*rollout-*.jsonl.zst) echo "CO $t";; esac; done
          done
        else
          lsof -Fcn +D "$HOME"/.codex/sessions 2>/dev/null | awk '/^c/{c=substr($0,2)} /^n/ && c ~ /codex/ && $0 ~ /rollout-.*\\.jsonl(\\.zst)?$/ {print "CO " substr($0,2)}'
        fi
      fi
    `.trim();
    let out;
    try {
      // CS data-plane (device data plane — always on since the 2.175.0 flag graduation): the daemon's raw-facts snapshot
      // SYNTHESIZED into the exact LOCK/J/H/N/T line format the ssh script
      // emits — the parser below runs UNCHANGED (zero interpretation drift).
      // Any failure falls through to the classic ssh script.
      out = null;
      if (this.dataPlaneOn?.() || h.transport === 'dial') {
        try {
          // HARD DEADLINE on the device path (2.246.2, userN's flapping
          // link): device(id) runs the connect retry ladder — up to ~13 ×
          // (8s handshake + backoff) ≈ 2.7 MINUTES — and a lossy path where
          // TCP opens but the ssh banner hangs (observed live: ssh blew past
          // ConnectTimeout=8, which only bounds the TCP connect) rides that
          // ladder to the end. Discovery is a read-only probe with TWO
          // fallbacks right below (legacy ssh script, 20s hard kill → stale
          // cache), so the sidebar sat on "Scanning sessions over ssh…" for
          // minutes while 85 cached sessions were one throw away. The race
          // doesn't cancel the background connect (deliberate — a later
          // success heals the device link for everyone else).
          const deadline = (p, ms, what) => Promise.race([p,
            new Promise((_, rj) => setTimeout(() => rj(new Error(`${what} deadline`)), ms).unref())]);
          const dm = await this.deviceBounded(id);
          // ── R5 SWITCHOVER (2.292.0): ask the DEVICE for finished session
          // cards (`discovery-claims`, dark since 2.291.0 with byte-identical
          // parity). The claim algorithm runs where the facts are; the
          // orchestrator's job shrinks to cross-machine merging. Ladder:
          // claims op → the snapshot+synthesize path (SAME shared functions,
          // just executed here) → legacy ssh script → stale cache. All three
          // rungs stay exercised; capability-gating degrades old daemons.
          let claimed = null;
          if ((await dm.connect?.())?.info?.capabilities?.includes?.('discovery-claims')) {
            try {
              const res = await deadline(dm.discoveryClaims({ hostId: h.id, hostName: h.name }), 15000, 'device-claims');
              if (res?.error) throw new Error(res.error);
              if (Array.isArray(res?.sessions)) claimed = res.sessions;
            } catch (e3) {
              console.warn(`[discovery] device claims failed for ${h.name} — falling back to server-side interpretation:`, e3.message);
            }
          }
          if (claimed) {
            this._discoveryCache.set(id, { at: Date.now(), sessions: claimed });
            try { this.convIndex.noteDiscovery(id, claimed); } catch { }
            this._persistDiscovery(id, claimed);
            return claimed;
          }
          const snap = await deadline(dm.discoverySnapshot(), 12000, 'device-discovery');
          out = synthesizeDiscoveryLines(snap); // shared with the device's own discovery.v2 chain
        } catch (e2) { out = null; /* legacy fallback below */ }
      }
      if (out == null) out = await this._ssh(h, script, { timeoutMs: 20000 });
    } catch (e) {
      // Host unreachable — serve LAST-KNOWN (expired memory cache, else the
      // disk-persisted copy from a previous run) marked stale instead of
      // failing the sidebar into an empty remote zone (2.124.0).
      const last = this._discoveryCache.get(id) || this._persistedDisc[id];
      if (last && Array.isArray(last.sessions)) {
        return last.sessions.map((s) => ({ ...s, stale: true, staleAt: last.at }));
      }
      throw e;
    }
    const sessions = interpretDiscoveryLines(out, { hostId: h.id, hostName: h.name, claimJsonls });
    this._discoveryCache.set(id, { at: Date.now(), sessions });
    try { this.convIndex.noteDiscovery(id, sessions); } catch { }
    this._persistDiscovery(id, sessions);
    return sessions;
  }
}

// ── Bootstrap ──
// One ssh session runs a step-marked script; the caller receives structured
// progress events (step start/ok/fail) plus the raw log stream — the UI shows
// a step list with an expandable live log. Idempotent: every step checks
// before installing.
const BOOTSTRAP_STEPS = [
  { key: 'connect', label: 'Connect' },
  { key: 'dtach', label: 'dtach (session persistence)' },
  { key: 'node', label: 'Node.js' },
  { key: 'claude', label: 'Claude Code CLI' },
];

function bootstrapScript() {
  return `
set -u
export PATH="$HOME/.local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
step() { echo "::STEP:$1:$2::"; }
step connect start
echo "connected: $(uname -sm) — $(whoami)@$(hostname)"
step connect ok

step dtach start
if command -v dtach >/dev/null 2>&1; then
  echo "dtach already installed: $(command -v dtach)"
  step dtach ok
else
  echo "dtach missing — trying package managers (needs passwordless sudo) then source build"
  if command -v brew >/dev/null 2>&1 && brew install dtach >/dev/null 2>&1; then
    echo "installed via Homebrew"
    step dtach ok
  elif sudo -n apt-get install -y dtach >/dev/null 2>&1 || sudo -n yum install -y dtach >/dev/null 2>&1 || sudo -n dnf install -y dtach >/dev/null 2>&1; then
    echo "installed via package manager"
    step dtach ok
  elif command -v gcc >/dev/null 2>&1 || command -v cc >/dev/null 2>&1; then
    tmp=$(mktemp -d) && cd "$tmp" \\
      && curl -fsSL -o dtach.tar.gz https://github.com/crigler/dtach/archive/refs/tags/v0.9.tar.gz \\
      && tar xzf dtach.tar.gz && cd dtach-0.9 && ./configure >/dev/null && make >/dev/null \\
      && mkdir -p "$HOME/.local/bin" && cp dtach "$HOME/.local/bin/" \\
      && echo "built from source into ~/.local/bin/dtach" && step dtach ok \\
      || step dtach fail
    cd "$HOME"
  else
    echo "no sudo and no compiler — install dtach manually"
    step dtach fail
  fi
fi

step node start
if command -v node >/dev/null 2>&1; then
  echo "node already installed: $(node --version)"
  step node ok
else
  echo "installing node via nvm…"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null 2>&1
  export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" 2>/dev/null
  nvm install --lts >/dev/null 2>&1 && echo "node $(node --version) via nvm" && step node ok || step node fail
fi

step claude start
if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then
  echo "claude already installed: $(claude --version 2>/dev/null || "$HOME/.local/bin/claude" --version 2>/dev/null)"
  step claude ok
else
  echo "installing Claude Code (native installer)…"
  curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 \\
    && echo "installed: $($HOME/.local/bin/claude --version 2>/dev/null || echo done)" && step claude ok || step claude fail
fi
echo "::DONE::"
`.trim();
}

HostManager.prototype.bootstrapSteps = () => BOOTSTRAP_STEPS.map(s => ({ ...s }));

/**
 * Run the bootstrap; onEvent receives {type:'step', key, status} and
 * {type:'log', line} events. Resolves with the final step map.
 */
HostManager.prototype.bootstrap = function (id, onEvent) {
  const h = this.get(id);
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const steps = Object.fromEntries(BOOTSTRAP_STEPS.map(s => [s.key, 'pending']));
    const child = spawn('ssh', [...this.sshArgs(h), 'bash -s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.write(bootstrapScript());
    child.stdin.end();
    let buf = '';
    const feed = (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const m = line.match(/^::STEP:(\w+):(\w+)::$/);
        if (m) {
          steps[m[1]] = m[2] === 'start' ? 'running' : m[2];
          onEvent({ type: 'step', key: m[1], status: steps[m[1]] });
        } else if (line === '::DONE::') { /* final resolve below */ }
        else if (line.trim()) onEvent({ type: 'log', line: line.slice(0, 500) });
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 10 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      for (const k of Object.keys(steps)) if (steps[k] === 'pending' || steps[k] === 'running') steps[k] = 'fail';
      onEvent({ type: 'done', code, steps });
      resolve(steps);
    });
  });
};

module.exports = { HostManager };
