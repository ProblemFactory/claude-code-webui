/**
 * AccountManager — Anthropic account switching for Claude sessions.
 *
 * Two billing identities exist for the Claude CLI:
 *  - Subscription: the CLI's global OAuth login (~/.claude/.credentials.json).
 *  - API / Console: an org API key. The CLI's own console login MINTS one and
 *    stores it as `primaryApiKey` in ~/.claude.json — but /login is mutually
 *    exclusive (switching wipes the other), so VibeSpace keeps console keys in
 *    its OWN store and injects ANTHROPIC_API_KEY into a session's spawn env
 *    (process-env channel, never argv). Per-session choice, no global switch.
 *
 * Keys are AES-256-GCM encrypted at rest under a server-local key
 * (data/.accounts-key), same pattern as mounts.js. list() never returns
 * secrets — only the key tail (last 8 chars) for identification; that matches
 * how the CLI's own trust list (customApiKeyResponses) fingerprints keys.
 */
const fs = require('fs');
const { get: harnessOf } = require('./harnesses'); // S2: per-harness credential mechanics live on the descriptor (creds)
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { capsOf } = require('./backend-caps.js'); // PURE registry: per-backend hot-switch verdict rides list() so the UI never offers a dead toggle
const { loginRank } = require('./login-expiry.js'); // PURE: which login is the WORST of a pool's members
// "no claim" — the shape every non-declaring harness / non-subscription record
// answers with. Never 'ok': an unreadable deadline is ignorance, not health.
const LOGIN_UNKNOWN = () => ({ state: 'unknown', refreshExpiresAt: null, accessExpiresAt: null, msLeft: null });

class AccountManager {
  constructor({ dataDir, onChange, platform = process.platform }) {
    this.dataDir = dataDir;
    this._file = path.join(dataDir, 'accounts.json');
    this._keyFile = path.join(dataDir, '.accounts-key');
    this._platform = platform;
    // Per-SUBSCRIPTION credential dirs. A subscription account is a real dir
    // holding ONLY that account's .credentials.json; the CLI reads it via
    // CLAUDE_SECURESTORAGE_CONFIG_DIR (relocates the SECRET store only —
    // projects/sessions/settings stay in ~/.claude, so transcripts + discovery
    // stay shared). Verified vs claude 2.1.205 (Wde() = env ?? sn()). This is
    // how we hold MANY subscription logins at once.
    this._dataDir = dataDir;
    this._subsDir = path.join(dataDir, 'subs');
    // Per-CODEX-account homes. Codex has NO auth-only relocation env (CODEX_HOME
    // moves the WHOLE config dir), so we isolate auth by giving each account its
    // own CODEX_HOME whose `sessions/` + `config.toml` are SYMLINKS to the
    // shared ~/.codex — auth.json stays real per-account, threads land in the
    // shared sessions dir (unified discovery), settings stay shared. Verified vs
    // codex 0.142.5 (symlinks survive a run; rollout written to shared dir).
    this._codexSubsDir = path.join(dataDir, 'codex-subs');
    this._onChange = onChange || (() => {});
    this._state = { version: 1, defaultAccountId: null, defaultCodexAccountId: null, accounts: [] };
    this._load();
    // Console-login scratch dirs (con-*) are transient; drop any abandoned by a
    // login that never completed before a prior restart.
    try { for (const d of fs.readdirSync(this._subsDir)) if (/^con-/.test(d)) fs.rmSync(path.join(this._subsDir, d), { recursive: true, force: true }); } catch { }
  }

  _acctType(a) { return a.type || 'api'; } // legacy records (no type) = API key
  _acctBackend(a) { return a.backend || 'claude'; } // legacy records = Claude
  _localOnlyClaudeSub(a) {
    return this._platform === 'darwin'
      && !!this._credsOf(this._acctBackend(a))?.keychainSensitive
      && this._acctType(a) === 'subscription';
  }
  subDir(id) { return path.join(this._subsDir, id); }
  // ── S2 generic credential helpers (read the harness descriptor, never a backend-id branch) ──
  _credsOf(be) { return harnessOf(be || 'claude').creds; }
  _acctDir(be, id) { return path.join(this._dataDir, this._credsOf(be).subsDirName, id); }
  _readAuthFor(be, id) { return this._credsOf(be).parseAuth(this._acctDir(be, id)); }
  /** LOGIN LIFETIME of an account (2026-09-07, src/login-expiry.js): when does
   *  the LOGIN SESSION itself end, as opposed to "is there a token right now".
   *  The verdict comes from the harness descriptor's optional creds.loginState
   *  — a harness whose credential format carries no deadline simply does not
   *  declare it and gets 'unknown', i.e. NO CLAIM (never 'ok': claiming health
   *  we cannot read is what made the old behaviour surprise people). */
  loginStateOf(id, now = Date.now()) {
    try {
      const a = this.get(id);
      if (!a) return LOGIN_UNKNOWN(now);
      const be = this._acctBackend(a);
      const type = this._acctType(a);
      // A pool has no login of its own — it is exactly its members' worst.
      if (type === 'pooled') return this.poolLoginState(id, now);
      if (type !== 'subscription') return LOGIN_UNKNOWN(now); // API keys / oat records have no OAuth login session
      const fn = this._credsOf(be)?.loginState;
      if (typeof fn !== 'function') return LOGIN_UNKNOWN(now);
      return fn(this._acctDir(be, id), now);
    } catch { return LOGIN_UNKNOWN(now); }
  }
  /** A pool's row summarises its MEMBERS: the worst state among the candidate
   *  members (the accounts it can actually route to), plus the member that
   *  earned it — one dead login inside a pool is the user-actionable fact even
   *  while the pool as a whole still works. */
  poolLoginState(poolId, now = Date.now()) {
    const out = { ...LOGIN_UNKNOWN(now), members: [] };
    let members = [];
    try { members = this._poolLoginCandidates(poolId); } catch { return out; }
    if (!members.length) return out;
    let worst = null;
    for (const m of members) {
      const st = this.loginStateOf(m.id, now);
      out.members.push({ id: m.id, name: m.name, state: st.state, refreshExpiresAt: st.refreshExpiresAt, msLeft: st.msLeft });
      if (!worst || loginRank(st) > loginRank(worst.st) || (loginRank(st) === loginRank(worst.st) && (st.msLeft ?? Infinity) < (worst.st.msLeft ?? Infinity))) worst = { m, st };
    }
    if (!worst) return out;
    return { ...worst.st, worstId: worst.m.id, worstName: worst.m.name, members: out.members };
  }
  /** Pool members for the LOGIN summary: the explicit list when narrowed, else
   *  every same-backend subscription. Deliberately NOT poolMembers() — that one
   *  filters to still-logged-in accounts, which would hide the exact members
   *  this feature exists to report (a signed-out member is the finding). */
  _poolLoginCandidates(poolId) {
    const a = this.get(poolId);
    const be = this._acctBackend(a);
    const all = this._state.accounts.filter((x) => this._acctBackend(x) === be && this._acctType(x) === 'subscription');
    const wanted = Array.isArray(a?.members) && a.members.length ? all.filter((x) => a.members.includes(x.id)) : all;
    return wanted.map((x) => ({ id: x.id, name: x.name }));
  }
  /** remoteCreds for resolveForSpawn — the ONE shape ws-create ships to a host
   *  (tar of `files` from srcDir → $HOME/.vibespace/<dirName>, env var pointed
   *  at it, shared subdirs symlinked, poison-heal probe); every field is the
   *  harness descriptor's. `shippable` only exists for keychain-sensitive
   *  harnesses (macOS Keychain-primary dirs must never be copied). */
  _remoteCreds(be, id, a) {
    const c = this._credsOf(be);
    return {
      srcDir: this._acctDir(be, id), dirName: c.subsDirName + '/' + id, envVar: c.spawnEnvVar,
      files: c.files.slice(), symlinks: { ...(c.remoteSymlinks || {}) }, ensureTargets: [...(c.ensureTargets || [])],
      probe: c.probe ? { ...c.probe } : null,
      ...(c.keychainSensitive ? { shippable: !this._localOnlyClaudeSub(a) } : {}),
    };
  }
  subCredsPath(id) { return path.join(this.subDir(id), '.credentials.json'); }
  codexSubDir(id) { return path.join(this._codexSubsDir, id); }

  // Pre-seed an isolated login dir's .claude.json with the onboarding-complete
  // flags (hasCompletedOnboarding/hasTrustDialogAccepted) so the login (run with
  // CLAUDE_CONFIG_DIR=dir) does NOT show the first-run onboarding screen. Setting
  // CLAUDE_CONFIG_DIR isolates the identity (oauthAccount) INTO the dir, so the
  // GLOBAL ~/.claude.json is never clobbered — the whole point.
  _seedConfigDir(dir) { return this._credsOf('claude').seedDir(dir); } // S2: the seeder lives on the claude descriptor

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._file, 'utf-8'));
      if (parsed && Array.isArray(parsed.accounts)) this._state = parsed;
    } catch { /* fresh install */ }
  }

  _save() {
    const tmp = this._file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this._file);
  }

  _notify() { try { this._onChange(this.list()); } catch { } }

  _key() {
    try { return Buffer.from(fs.readFileSync(this._keyFile, 'utf-8').trim(), 'hex'); }
    catch {
      const k = crypto.randomBytes(32);
      fs.writeFileSync(this._keyFile, k.toString('hex'), { mode: 0o600 });
      return k;
    }
  }

  _enc(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this._key(), iv);
    const enc = Buffer.concat([c.update(text, 'utf-8'), c.final()]);
    return iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + enc.toString('hex');
  }

  _dec(blob) {
    const [iv, tag, data] = String(blob).split(':').map((s) => Buffer.from(s, 'hex'));
    const d = crypto.createDecipheriv('aes-256-gcm', this._key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf-8');
  }

  // Sanitized — NEVER includes key material. Subscription accounts add a
  // read-only identity probe (email/plan/loggedIn) from their creds dir.
  list() {
    return {
      defaultAccountId: this._state.defaultAccountId || null,
      defaultCodexAccountId: this._state.defaultCodexAccountId || null,
      accounts: this._state.accounts.map((a) => {
        const type = this._acctType(a);
        const backend = this._acctBackend(a);
        const base = { id: a.id, name: a.name, type, backend, source: a.source, originHost: a.originHost || null, note: a.note || null, hostLogins: a.hostLogins || null, createdAt: a.createdAt, localOnly: this._localOnlyClaudeSub(a) };
        // POOLED FIRST, for every backend (2.369.18): the codex branch used to
        // run before this one, so a codex pool listed as a bare ChatGPT login
        // — no `pooled`/`current`/`memberOptions`/`auto` — and every client
        // surface (roster menu, switcher, New Session) plus the engine's
        // `type==='pooled' && a.auto` tick enumeration saw a pool with no
        // pool fields. Identity reads THROUGH the symlink via the member's
        // own auth reader; hot-switch support is the capability registry's
        // verdict (codex: 'impossible' — the client hides the toggle).
        if (type === 'pooled') {
          const cur = this.poolCurrent(a.id);
          const info = this._readAuthFor(backend, a.id); // resolves through the symlink
          const curAcct = cur ? this.get(cur) : null;
          // loginState on a pool = its MEMBERS' worst (a pool has no login of
          // its own); the row names the member that earned it so the user can
          // act without opening the pool's Members dialog.
          return { ...base, pooled: true, loggedIn: !!info.loggedIn, email: info.email || null, subscriptionType: info.subscriptionType || null, current: cur, currentName: curAcct?.name || null, members: a.members || null, memberOptions: this.poolMembers(a.id), auto: !!a.auto, hot: !!a.hot, hotSupported: capsOf(backend).hotSwitch === 'verified', supported: backend === 'codex' || this.poolSupported(), loginState: this.poolLoginState(a.id) };
        }
        if (type === 'subscription') {
          // ONE branch for every harness (S2): the descriptor's parseAuth reads
          // the account dir; authMode rides only where the reader reports it
          // (codex), long-lived-token meta only where the harness has one.
          // a.email = manual backfill (setEmail) for dirs whose login never
          // wrote the identity file; the dir's own identity wins when present.
          const info = this._readAuthFor(backend, a.id);
          // loginState (2026-09-07): the LOGIN SESSION's own deadline, so every
          // surface can warn BEFORE the refresh fails instead of after a dead
          // turn. 'unknown' where the harness declares no reader.
          return { ...base, loggedIn: info.loggedIn, email: info.email || a.email || null, emailDeclared: !info.email && !!a.email, subscriptionType: info.subscriptionType, loginState: this.loginStateOf(a.id), ...(info.authMode !== undefined ? { authMode: info.authMode } : {}), ...(this._credsOf(backend).longLivedToken ? this._oatMeta(a) : {}) };
        }
        return { ...base, tail: a.tail };
      }),
    };
  }

  // ── Subscription accounts (each = its own securestorage creds dir) ──

  // Allocate an empty account + dir. The OAuth login happens in an interactive
  // terminal through vibespace-claude-subscription-login.mjs; the caller
  // watches for the creds/status file, then calls finalizeSubscription.
  createSubscription({ name } = {}) {
    const id = 'sub-' + crypto.randomBytes(6).toString('hex');
    fs.mkdirSync(this.subDir(id), { recursive: true, mode: 0o700 });
    this._seedConfigDir(this.subDir(id));
    const a = { id, name: String(name || '').trim().slice(0, 60) || 'Subscription', type: 'subscription', source: 'login', createdAt: Date.now() };
    this._state.accounts.push(a);
    this._save();
    this._notify();
    return { id, dir: this.subDir(id) };
  }

  // Read-only parse of a subscription account's creds. NEVER writes/refreshes
  // (rotation would break the account, issue #20). Returns loggedIn + identity
  // + the access token IF currently valid (for the usage poll).
  readSubCreds(id) { return this._credsOf('claude').parseAuth(this.subDir(id)); } // parser lives on the claude harness descriptor (S2)

  _subscriptionLoginStatus(id) {
    try {
      const status = JSON.parse(fs.readFileSync(path.join(this.subDir(id), '.vibespace-login-status.json'), 'utf-8'));
      if (status?.state !== 'error' || !/^[a-z0-9-]{1,40}$/.test(status.code || '')) return null;
      return { state: 'error', code: status.code };
    } catch { return null; }
  }

  // After the login terminal wrote creds: pull identity, default the name to
  // the email/plan if the user didn't set one. Returns loggedIn.

  // Re-login IDENTITY GUARD (2.333.0, owner directive "orgid不对得自动变成新条
  // 目"): after a re-login into an EXISTING record's dir, the fresh login may
  // belong to a DIFFERENT Anthropic account (wrong browser profile, shared
  // machine). Silently rebranding the record would splice two accounts' ledger
  // history and pool identity together — so a mismatched login MOVES OUT:
  //   · fresh identity matches ANOTHER existing record → its creds move into
  //     that record's dir (fresh login wins there); this record reverts to
  //     signed-out untouched
  //   · fresh identity matches NO record → a NEW record is minted around it;
  //     this record reverts to signed-out untouched
  //   · same identity (or the record never had one) → normal in-place refresh
  // Identity = orgUuid when both sides have it, else email (case-insensitive).
  // The dir's .claude.json rides along with the creds — it carries the fresh
  // identity and belongs with the login, not with the old record.
  reloginResolve(id) {
    const a = this.get(id);
    if (!a || this._acctType(a) !== 'subscription') throw new Error('not a subscription account');
    const fresh = this.readSubCreds(id);
    if (!fresh.loggedIn) return { outcome: 'pending' };
    const norm = (s) => String(s || '').trim().toLowerCase();
    const freshEmail = norm(fresh.email);
    const knownEmail = norm(a.email || (String(a.name || '').includes('@') ? a.name : ''));
    const sameIdentity = !knownEmail || !freshEmail || freshEmail === knownEmail;
    if (sameIdentity) return { outcome: 'same', account: this.finalizeSubscription(id) };

    // ── mismatch: move the fresh login out of this record's dir ──
    const src = this.subDir(id);
    const moveLogin = (destDir) => {
      fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
      for (const f of ['.credentials.json', '.claude.json']) {
        try { fs.renameSync(path.join(src, f), path.join(destDir, f)); } catch { }
      }
    };
    const other = this._state.accounts.find((x) => x.id !== id
      && this._acctBackend(x) === 'claude' && this._acctType(x) === 'subscription'
      && norm(x.email || (String(x.name || '').includes('@') ? x.name : '')) === freshEmail);
    if (other) {
      moveLogin(this.subDir(other.id));
      this._notify();
      return { outcome: 'moved', movedTo: { id: other.id, name: other.name }, freshEmail: fresh.email, keptName: a.name };
    }
    const created = this.createSubscription({ name: (fresh.email || 'Subscription').slice(0, 60) });
    moveLogin(this.subDir(created.id));
    const finalized = this.finalizeSubscription(created.id);
    this._notify();
    return { outcome: 'split', account: finalized, freshEmail: fresh.email, keptName: a.name };
  }

  finalizeSubscription(id) {
    const a = this.get(id);
    if (!a || this._acctType(a) !== 'subscription') throw new Error('not a subscription account');
    const info = this.readSubCreds(id);
    const loginStatus = this._subscriptionLoginStatus(id);
    if (info.loggedIn && (!a.name || a.name === 'Subscription')) {
      a.name = (info.email || (info.subscriptionType ? info.subscriptionType[0].toUpperCase() + info.subscriptionType.slice(1) : 'Subscription')).slice(0, 60);
      this._save();
    }
    this._notify();
    const { accessToken: _accessToken, ...publicInfo } = info;
    return {
      id, ...publicInfo, name: a.name,
      localOnly: this._localOnlyClaudeSub(a),
      loginFailed: !info.loggedIn && loginStatus?.state === 'error',
      loginErrorCode: !info.loggedIn ? loginStatus?.code || null : null,
    };
  }

  // ── Codex subscription accounts (each = its own CODEX_HOME, auth isolated) ──

  // The shared ~/.codex the per-account homes symlink into. Ensure the symlink
  // TARGETS exist (sessions dir + config.toml) so codex reads/writes go there.
  _codexSharedHome() { return this._credsOf('codex').sharedHome(); } // S2: lives on the codex descriptor
  _seedCodexDir(dir) { return this._credsOf('codex').seedDir(dir); } // S2: the seeder lives on the codex descriptor

  createCodexSubscription({ name } = {}) {
    const id = 'cxs-' + crypto.randomBytes(6).toString('hex');
    fs.mkdirSync(this.codexSubDir(id), { recursive: true, mode: 0o700 });
    this._seedCodexDir(this.codexSubDir(id));
    const a = { id, name: String(name || '').trim().slice(0, 60) || 'ChatGPT', type: 'subscription', backend: 'codex', source: 'login', createdAt: Date.now() };
    this._state.accounts.push(a);
    this._save();
    this._notify();
    return { id, dir: this.codexSubDir(id) };
  }

  // Decode a JWT payload without verifying (identity display only — never trust
  // for auth). Returns {} on any malformation.
  _jwtPayload(tok) {
    try {
      const seg = String(tok).split('.')[1];
      return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')) || {};
    } catch { return {}; }
  }

  // Read-only parse of a codex auth.json (never refreshes). Reports loggedIn +
  // auth mode + identity (email/plan) from the id_token claims.
  _parseCodexAuthFile(file) { return this._credsOf('codex').parseAuthFile(file); } // parser lives on the codex harness descriptor (S2)
  readCodexSubAuth(id) { return this._credsOf('codex').parseAuth(this.codexSubDir(id)); }
  // The machine's OWN codex login (~/.codex/auth.json) — the codex counterpart
  // of subscriptionStatus(); identity feeds the codex global↔named-account link.
  codexGlobalStatus() { return this._parseCodexAuthFile(path.join(this._codexSharedHome(), 'auth.json')); }

  finalizeCodexSubscription(id) {
    const a = this.get(id);
    if (!a || this._acctBackend(a) !== 'codex') throw new Error('not a codex account');
    const info = this.readCodexSubAuth(id);
    if (info.loggedIn && (!a.name || a.name === 'ChatGPT')) {
      a.name = (info.email || (info.plan ? 'ChatGPT ' + info.plan : 'ChatGPT')).slice(0, 60);
      this._save();
    }
    this._notify();
    return { id, ...info, name: a.name };
  }

  // ── Config export / import (Backup & migrate, 2.100.0) ──
  // Returns PLAINTEXT secrets — the caller MUST put this inside the export's
  // passphrase-encrypted sensitive blob. API keys are decrypted out of the
  // machine-local .accounts-key store (the key file itself never travels);
  // subscription creds ride as whitelisted dir files. Import re-encrypts under
  // the TARGET machine's own key and recreates the dirs.
  exportBundle() {
    const readFiles = (dir, names) => {
      const out = {};
      for (const n of names) {
        try { out[n] = fs.readFileSync(path.join(dir, n), 'utf-8'); } catch { }
      }
      return out;
    };
    const accounts = this._state.accounts.map((a) => {
      const backend = this._acctBackend(a);
      const type = this._acctType(a);
      const rec = { id: a.id, name: a.name, backend, type, source: a.source, createdAt: a.createdAt };
      if (a.email) rec.email = a.email;
      if (a.tail) rec.tail = a.tail;
      if (a.keyEnc) { try { rec.key = this._dec(a.keyEnc); } catch { } }
      // Long-lived token travels like an API key (decrypted into the
      // passphrase blob; re-encrypted under the TARGET's key on import) — an
      // oat-ONLY account would otherwise import as a dead record (B-211a)
      if (a.oatEnc) { try { rec.oat = this._dec(a.oatEnc); rec.oatMintedAt = a.oatMintedAt || null; } catch { } }
      if (type === 'subscription') {
        // macOS secure storage is Keychain-primary. The local fallback is a
        // same-machine compatibility shadow for launchd and can diverge after
        // refresh-token rotation, so never treat it as a portable backup.
        const c = this._credsOf(backend);
        rec.files = readFiles(this._acctDir(backend, a.id), this._localOnlyClaudeSub(a) ? c.files.filter((x) => x !== c.authFile) : c.files);
      }
      return rec;
    });
    return {
      version: 1,
      defaultAccountId: this._state.defaultAccountId || null,
      defaultCodexAccountId: this._state.defaultCodexAccountId || null,
      accounts,
    };
  }

  importBundle(bundle) {
    if (!bundle || !Array.isArray(bundle.accounts)) return { imported: 0, skipped: 0 };
    const FILE_OK = /^[.\w][\w.-]*$/; // whitelist shape — no separators, no traversal
    let imported = 0, skipped = 0;
    for (const rec of bundle.accounts) {
      if (!rec || typeof rec.id !== 'string' || !/^(acct|sub|cxs)-[a-f0-9]{6,}$/.test(rec.id)) { skipped++; continue; }
      if (this._state.accounts.some((a) => a.id === rec.id)) { skipped++; continue; } // never clobber an existing account
      const a = {
        id: rec.id,
        name: String(rec.name || '').slice(0, 60) || rec.id,
        source: rec.source || 'import',
        createdAt: rec.createdAt || Date.now(),
      };
      if (rec.email) a.email = String(rec.email).slice(0, 120);
      // backend = any registered harness with credential mechanics (an unknown
      // id falls back to claude exactly like a legacy record with no backend);
      // harnesses without API keys only ever hold subscription-type records.
      const be = (() => { try { return rec.backend && harnessOf(rec.backend).creds ? rec.backend : 'claude'; } catch { return 'claude'; } })();
      if (be !== 'claude') a.backend = be;
      if (rec.type === 'subscription' || !this._credsOf(be).supportsApiKeys) a.type = 'subscription';
      if (rec.key && /^sk-ant-/.test(rec.key)) { a.keyEnc = this._enc(String(rec.key)); a.tail = String(rec.key).slice(-8); }
      else if (rec.tail) a.tail = rec.tail;
      if (rec.oat && /^sk-ant-oat\d{2}-/.test(String(rec.oat))) { a.oatEnc = this._enc(String(rec.oat)); a.oatMintedAt = Number(rec.oatMintedAt) || Date.now(); }
      if (rec.files && typeof rec.files === 'object' && a.type === 'subscription') {
        const dir = this._acctDir(be, a.id);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this._credsOf(be).seedDir(dir); // claude: onboarding-complete .claude.json; codex: sessions/config.toml symlinks into the shared ~/.codex
        for (const [n, content] of Object.entries(rec.files)) {
          if (!FILE_OK.test(n) || typeof content !== 'string') continue;
          fs.writeFileSync(path.join(dir, n), content, { mode: 0o600 });
        }
      }
      this._state.accounts.push(a);
      imported++;
    }
    // Defaults only when the referenced account actually landed and none is set
    // locally — an import must not silently re-route existing sessions' billing.
    for (const [k, v] of [['defaultAccountId', bundle.defaultAccountId], ['defaultCodexAccountId', bundle.defaultCodexAccountId]]) {
      if (v && !this._state[k] && this._state.accounts.some((a) => a.id === v)) this._state[k] = v;
    }
    if (imported) { this._save(); this._notify(); }
    return { imported, skipped };
  }

  /** Identity email of a claude subscription record: the dir's own identity
   *  wins, then the declared email, then an email-shaped name. */
  identityEmailOf(a) {
    let dirEmail = null;
    try { if (this._acctType(a) === 'subscription' && (a.backend || 'claude') === 'claude') dirEmail = this.readSubCreds(a.id).email; } catch { }
    const v = dirEmail || a.email || (String(a.name || '').includes('@') ? a.name : '');
    return String(v || '').trim().toLowerCase();
  }

  /** Merge duplicate records of the SAME real account (same identity email —
   *  2.205.0, real report: a host add-flow login minted a second record of an
   *  account the user already had; "can't it auto-recognize?"). `fromId` (the
   *  newer dup) folds into `intoId` (the survivor): fresh local creds win
   *  when asked, hostLogins union, metadata kept on the survivor, the dup
   *  record spliced WITHOUT the delete-path host cleanup (its host dirs are
   *  renamed to the survivor by the caller first). */
  mergeSubscription(fromId, intoId, { preferFromCreds = false, liveAccountIds = null } = {}) {
    const from = this._state.accounts.find((x) => x.id === fromId);
    const into = this._state.accounts.find((x) => x.id === intoId);
    if (!from || !into || fromId === intoId) throw new Error('bad merge pair');
    // B-3f8a: NEVER rewrite creds while a session of EITHER side is running.
    // The CLI re-reads .credentials.json per HTTP request (verified vs 2.1.222,
    // SharedContext/devices-and-access.md) — so copying over intoDir/.credentials.json
    // would silently re-bill the survivor's live sessions MID-TURN, and the
    // rmSync(fromDir) would yank creds out from under the merged-away side's
    // live sessions. The caller (server.js, which holds activeSessions) passes
    // the set of account ids with a running session; refuse loudly if hit.
    if (liveAccountIds && (liveAccountIds.has?.(fromId) || liveAccountIds.has?.(intoId))) {
      const e = new Error('cannot merge these accounts while a session using either is running — stop those sessions first');
      e.code = 'merge-account-live';
      throw e;
    }
    // Claude's macOS Keychain service is hashed from the config-dir path
    // (PR #23). Moving fresh fallback bytes to another id does NOT
    // move that Keychain item, so the survivor can keep reading its old token
    // and the new item is orphaned. Keep both records instead of claiming a
    // safe file-only merge.
    if (this._localOnlyClaudeSub(from) || this._localOnlyClaudeSub(into)) {
      throw new Error('macOS Keychain-backed subscriptions cannot be merged across config directories');
    }
    // local creds: bring the dup's dir over when it's fresher/the only login
    try {
      const fromDir = this.subDir(fromId), intoDir = this.subDir(intoId);
      const intoLogged = this.readSubCreds(intoId).loggedIn;
      if (fs.existsSync(path.join(fromDir, '.credentials.json')) && (preferFromCreds || !intoLogged)) {
        fs.mkdirSync(intoDir, { recursive: true, mode: 0o700 });
        fs.chmodSync(intoDir, 0o700);
        for (const f of ['.credentials.json', '.claude.json']) {
          const src = path.join(fromDir, f);
          if (fs.existsSync(src)) {
            const dest = path.join(intoDir, f);
            const tmp = dest + `.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
            let fd;
            try {
              const content = fs.readFileSync(src);
              fd = fs.openSync(tmp, 'wx', 0o600);
              fs.writeFileSync(fd, content);
              fs.fchmodSync(fd, 0o600);
              if ((fs.fstatSync(fd).mode & 0o777) !== 0o600) throw new Error('private mode not applied');
              fs.fsyncSync(fd);
              fs.closeSync(fd); fd = undefined;
              fs.renameSync(tmp, dest);
            } finally {
              if (fd !== undefined) { try { fs.closeSync(fd); } catch { } }
              try { fs.unlinkSync(tmp); } catch { }
            }
          }
        }
      }
      fs.rmSync(fromDir, { recursive: true, force: true });
    } catch { /* best-effort file consolidation */ }
    if (from.hostLogins) into.hostLogins = { ...(from.hostLogins), ...(into.hostLogins || {}) };
    if (!into.email && from.email) into.email = from.email;
    if (!into.oatEnc && from.oatEnc) { into.oatEnc = from.oatEnc; into.oatMintedAt = from.oatMintedAt; } // long-lived token survives the fold (B-211a)
    if (!into.note && from.note) into.note = from.note;
    if (this._state.defaultAccountId === fromId) this._state.defaultAccountId = intoId;
    this._state.accounts = this._state.accounts.filter((x) => x.id !== fromId);
    this._save();
    this._notify();
    return this.list().accounts.find((x) => x.id === intoId) || null;
  }

  /** Write-through from a host identity probe (2.204.0): remember which
   *  machines hold a per-account login dir for each account, so EVERY view
   *  (incl. the local one, which probes no host) can say "logged in on X"
   *  instead of a bare "not logged in" (real report: an account whose only
   *  login lived on the devbox read as dead on the local view). Cleared for a
   *  host when its probe stops listing the account. */
  noteHostLogins(hostId, ids) {
    if (!hostId) return;
    const set = new Set(ids || []);
    let changed = false;
    for (const a of this._state.accounts) {
      const has = !!a.hostLogins?.[hostId];
      if (set.has(a.id) && !has) { (a.hostLogins ||= {})[hostId] = Date.now(); changed = true; }
      else if (!set.has(a.id) && has) {
        delete a.hostLogins[hostId];
        if (!Object.keys(a.hostLogins).length) delete a.hostLogins;
        changed = true;
      }
    }
    if (changed) { this._save(); this._notify(); }
  }

  /** Decrypted key VALUE for the reveal dialog (API-key accounts only).
   *  Same trust model as the mounts config endpoint (2.108.8, user
   *  directive): single-user instance, cookie-authed — blank secrets that
   *  can never be re-read are worse than showing them on request (real
   *  incident: a removed key was unrecoverable; the Console never re-shows
   *  values). */
  revealKey(id) {
    const a = this._state.accounts.find((x) => x.id === id);
    if (!a) throw new Error('unknown account');
    if (!a.keyEnc) throw new Error('not an API-key account');
    return this._dec(a.keyEnc);
  }

  /** Free-text provenance/annotation shown as a dim tag in the roster —
   *  answers "where did this key come from?" (real report: a key imported
   *  from a host read as live-shared from it; the note + originHost make the
   *  independent-copy semantics visible). */
  setNote(id, note) {
    const a = this._state.accounts.find((x) => x.id === id);
    if (!a) throw new Error('unknown account');
    const v = String(note || '').trim().slice(0, 120);
    if (v) a.note = v; else delete a.note;
    this._save();
    return this.list().accounts.find((x) => x.id === id) || null;
  }

  add({ name, key, source = 'manual', originHost = null } = {}) {
    key = String(key || '').trim();
    if (!/^sk-ant-/.test(key)) throw new Error('not an Anthropic API key (must start with sk-ant-)');
    const tail = key.slice(-8);
    // Idempotent: re-adding the same key returns the existing record.
    for (const a of this._state.accounts) {
      if (a.tail === tail) {
        try { if (this._dec(a.keyEnc) === key) return { id: a.id, name: a.name, tail: a.tail, existing: true }; } catch { }
      }
    }
    const a = {
      id: 'acct-' + crypto.randomBytes(6).toString('hex'),
      name: String(name || '').trim().slice(0, 60) || ('API key …' + tail),
      keyEnc: this._enc(key),
      tail,
      source,
      // provenance: the machine this key was imported FROM (display only —
      // the record is an independent copy in this store, not live-linked)
      ...(originHost ? { originHost: String(originHost).slice(0, 60) } : {}),
      createdAt: Date.now(),
    };
    this._state.accounts.push(a);
    this._save();
    this._notify();
    return { id: a.id, name: a.name, tail: a.tail };
  }

  rename(id, name) {
    const a = this._state.accounts.find((x) => x.id === id);
    if (!a) throw new Error('account not found');
    a.name = String(name || '').trim().slice(0, 60) || a.name;
    this._save();
    this._notify();
    return { id: a.id, name: a.name, tail: a.tail };
  }

  // Manual identity backfill: some login flows leave a subscription's creds dir
  // without the identity file (.claude.json oauthAccount) — creds work, but the
  // email is unknowable from disk. The email is what links a named account to
  // the machine's own CLI login (usage merge/dedup), so let the user declare it.
  // Stored on the account record; list() uses it only when the dir has none.
  setEmail(id, email) {
    const a = this._state.accounts.find((x) => x.id === id);
    if (!a) throw new Error('account not found');
    a.email = String(email || '').trim().slice(0, 120) || undefined;
    this._save();
    this._notify();
    return { id: a.id, name: a.name, email: a.email || null };
  }

  remove(id) {
    const i = this._state.accounts.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('account not found');
    const a = this._state.accounts[i];
    this._state.accounts.splice(i, 1);
    if (this._state.defaultAccountId === id) this._state.defaultAccountId = null;
    if (this._state.defaultCodexAccountId === id) this._state.defaultCodexAccountId = null;
    // POOL HYGIENE (2.335.0, real report: deleting the account a pool was
    // sitting on left the pool's default symlink AND per-session links
    // dangling — the whole pool showed signed-out and running sessions read
    // creds through a dead link until some spawn happened to heal it).
    // Deleting a member must leave every pool self-consistent NOW.
    if (this._acctBackend(a) === 'claude' && this._acctType(a) === 'subscription') {
      this._save(); // poolMembers below must not offer the removed account
      this._healPoolsAfterRemoval(id);
    }
    // Isolated-login accounts own a creds dir — wipe it (best-effort).
    if (this._acctType(a) === 'pooled') { try { fs.unlinkSync(this._acctDir(this._acctBackend(a), id)); } catch { } try { fs.rmSync(this.poolLinksDir(id), { recursive: true, force: true }); } catch { } } // unlink ONLY — the target is a real account's dir; the links dir holds only symlinks (rm never follows)
    else if (this._acctType(a) === 'subscription') { try { fs.rmSync(this._acctDir(this._acctBackend(a), id), { recursive: true, force: true }); } catch { } }
    this._save();
    this._notify();
  }

  /** Every pool that referenced a just-removed member: strip it from explicit
   *  member lists, re-point the default link if it targeted the removed
   *  account, and re-point (or drop, when no member is left) per-session
   *  links that targeted it. Symlink re-points don't care that the old
   *  target dir is about to be rm'd — order-independent of the wipe. */
  _healPoolsAfterRemoval(removedId) {
    const readTarget = (p) => { try { return path.basename(fs.readlinkSync(p)); } catch { return null; } };
    for (const pool of this._state.accounts.filter((x) => this._acctType(x) === 'pooled')) {
      try {
        if (Array.isArray(pool.members) && pool.members.includes(removedId)) {
          const rest = pool.members.filter((m) => m !== removedId);
          // NEVER null out the list (review finding, high stakes): null/empty
          // means "ALL logged-in subscriptions" — stripping the LAST explicit
          // member would silently WIDEN the pool onto accounts the user
          // deliberately excluded and re-point billing there. A list of only
          // now-nonexistent ids yields zero members through poolMembers'
          // filter, which is the honest "unusable pool" state.
          if (rest.length) pool.members = rest;
        }
        const alive = this.poolMembers(pool.id);
        if (readTarget(this.subDir(pool.id)) === removedId) {
          if (alive.length) {
            this.setPoolTarget(pool.id, alive[0].id);
            console.warn(`[pool] "${pool.name}" target was the deleted account — re-pointed to ${alive[0].name}`);
          } else {
            try { fs.unlinkSync(this.subDir(pool.id)); } catch { } // a dangling link reads as a phantom login path; absent = honestly signed-out
            console.warn(`[pool] "${pool.name}" lost its only member to deletion — pool is unusable until a member logs in`);
          }
        }
        for (const l of this.sessionPoolLinks(pool.id)) {
          if (readTarget(l.path) !== removedId) continue;
          const target = this.poolCurrent(pool.id);
          if (target) require('./account-material.js').repointPoolSymlink(l.path, this.subDir(target), this.subCredsPath(target));
          else { try { fs.unlinkSync(l.path); } catch { } }
        }
      } catch (e) { console.warn(`[pool] hygiene after removing ${removedId} failed for ${pool.id}:`, e.message); }
    }
  }

  // null = the CLI's own global login is the default for new sessions. Each
  // backend has its OWN default (claude vs codex). When id is given the backend
  // is derived from the account; when clearing (id null) the caller passes it.
  setDefault(id, backend = 'claude') {
    let be = backend;
    if (id != null) {
      const a = this.get(id);
      if (!a) throw new Error('account not found');
      be = this._acctBackend(a);
    }
    this._state[this._credsOf(be).defaultIdField] = id || null; // per-harness default-account field (S2)
    this._save();
    this._notify();
  }

  get(id) { return this._state.accounts.find((a) => a.id === id) || null; }

  getKey(id) {
    const a = this.get(id);
    if (!a) return null;
    try { return this._dec(a.keyEnc); } catch { return null; }
  }

  // Resolve what a create request means into a spawn descriptor.
  //   undefined/null → server default; 'subscription' → the CLI's GLOBAL login
  //   (no env override); 'acct-…'/'sub-…' → that account.
  // Returns null (= global login, no env change) or:
  //   { id, name, tail?, kind:'api'|'subscription',
  //     localEnv: {VAR:val},          // set in the LOCAL process spawn env
  //     secret: {var,value} | null }  // shipped over ssh-stdin for REMOTE (api only)
  /**
   * evaluateOnHost — THE single authority for "how does account X run on
   * machine Y" (B-f531, 2.244.0 — after SIX field incidents where four client
   * surfaces and two server branches each computed their own verdict from
   * their own caches). PURE given hostFacts: the same function feeds the
   * display surfaces (accounts-status `verdicts`) and the spawn path
   * (ws-handler create), so what the UI promises is exactly what the spawn
   * does.
   *
   * @param a          account record (this.get(id))
   * @param hostFacts  null = LOCAL spawn; else the accountsStatus() result
   *                   (+ .transport) — LIVE host facts, never a client cache
   * @param opts       { allowShip } — accounts.shipSubscriptionToRemote
   * @returns {usable, how, reason, linked, held, heldVerified}
   *   how:    'local-env'  spawn locally with the account env
   *           'ship'       creds/key ship to the host (resolveForSpawn path)
   *           'host-held'  host-side ~/.vibespace/subs/<id> dir (nothing ships)
   *           'host-login' the host's own CLI login IS this account (email)
   *   reason (when !usable): 'never-signed-in' | 'ship-disabled' |
   *           'dial-no-ship' | 'held-identity-mismatch'
   * PRECEDENCE (2.243.2 lesson): host-held beats email-linked — the dir's
   * creds are the named account deterministically, while the host's config
   * email goes stale right after a /login switch (2.114.1 class). And when
   * the host REPORTS the dir's actual identity (hostSubEmails) and it does
   * NOT match this account, the dir is poisoned/mislabeled — refuse it
   * loudly instead of billing whoever's creds sit in it.
   */
  evaluateOnHost(a, hostFacts, { allowShip = false } = {}) {
    const backend = this._acctBackend(a);
    // Pooled pseudo-accounts are LOCAL-ONLY: shipping would freeze the pool at
    // spawn time (a copy of the symlink's contents) and break the shared-lock
    // invariant on the host. Never let them fall into the API-key always-ship
    // branch below.
    if (this._acctType(a) === 'pooled') {
      if (hostFacts) return { usable: false, how: null, reason: 'pool-local-only', linked: false, held: false, heldVerified: false };
      const ok = !!this.poolCurrent(a.id) && !!this.readSubCreds(a.id).loggedIn;
      return { usable: ok, how: 'local-env', reason: ok ? null : 'pool-no-target', linked: false, held: false, heldVerified: false };
    }
    const isSub = this._acctType(a) === 'subscription' || !this._credsOf(backend).supportsApiKeys;
    const norm = (v) => String(v || '').trim().toLowerCase();
    const acctEmail = norm(a.email || (String(a.name || '').includes('@') ? a.name : ''));
    if (!isSub) {
      // API keys are the sanctioned programmatic path — always shippable
      return { usable: true, how: hostFacts ? 'ship' : 'local-env', reason: null, linked: false, held: false, heldVerified: false };
    }
    const loggedIn = !!this._readAuthFor(backend, a.id).loggedIn;
    // Hosts KNOWN to hold this account's own login (noteHostLogins write-
    // through) minus the host being evaluated: "signed in SOMEWHERE else" is
    // a different situation than "never signed in anywhere" — userN's
    // report: ClaudeLu (held on Novita) showed "never finished signing in"
    // in a CW-H200 session's menu, reading as a broken account (2.244.3).
    const otherHosts = Object.keys(a.hostLogins || {}).filter((h) => h !== hostFacts?.hostId);
    const noLoginReason = () => (otherHosts.length ? 'not-on-this-host' : 'never-signed-in');
    // hasOat = a VALID token only — mirrors resolveForSpawn's oatExpired drop
    // (an expired oat must never rank an account usable: the switcher would
    // kill-then-fail the create, and a DEFAULT account would silently flip to
    // the host login the day it expires). Expired gets its own 'oat-expired'
    // reason below so every surface can say re-mint instead of the §ban-safety
    // ship explanation.
    const hasOat = this._credsOf(backend).longLivedToken && !!a.oatEnc && (a.oatMintedAt || 0) + this.OAT_TTL_MS > Date.now();
    const oatExpired = this._credsOf(backend).longLivedToken && !!a.oatEnc && !hasOat;
    if (!hostFacts) {
      if (loggedIn) return { usable: true, how: 'local-env', reason: null, linked: false, held: false, heldVerified: false };
      // no local login but a long-lived token → spawns via the env token
      if (hasOat) return { usable: true, how: 'oat', reason: null, linked: false, held: false, heldVerified: false };
      if (oatExpired) return { usable: false, how: null, reason: 'oat-expired', linked: false, held: false, heldVerified: false };
      return { usable: false, how: null, reason: noLoginReason(), otherHosts, linked: false, held: false, heldVerified: false };
    }
    const hostEmail = norm(hostFacts[this._credsOf(backend).hostFactsKey]?.email);
    const linked = !!acctEmail && !!hostEmail && acctEmail === hostEmail;
    const held = backend === 'claude' && (hostFacts.hostSubs || []).includes(a.id);
    if (held) {
      const dirEmail = norm(hostFacts.hostSubEmails?.[a.id]);
      if (dirEmail && acctEmail && dirEmail !== acctEmail) {
        return { usable: false, how: null, reason: 'held-identity-mismatch', linked, held, heldVerified: false, dirEmail };
      }
      return { usable: true, how: 'host-held', reason: null, linked, held, heldVerified: !!dirEmail };
    }
    if (linked) return { usable: true, how: 'host-login', reason: null, linked, held, heldVerified: false };
    // Long-lived token: usable on ANY host incl. dial — it rides the secret
    // env channel (nothing rotates, no token-endpoint traffic from the host).
    // Ranked below host-held/linked (a full login there has more capability)
    // and above full-login shipping.
    if (hasOat) return { usable: true, how: 'oat', reason: null, linked, held, heldVerified: false };
    if (loggedIn && allowShip && hostFacts.transport !== 'dial') {
      // macOS Keychain-backed logins never ship (PR #23): the file
      // fallback is a same-machine shadow that forks the rotating refresh
      // token the moment either copy refreshes. Log in ON the host instead
      // (held/linked/oat rungs above stay fully usable for these accounts).
      if (this._localOnlyClaudeSub(a)) return { usable: false, how: null, reason: 'local-only-mac', linked, held, heldVerified: false };
      return { usable: true, how: 'ship', reason: null, linked, held, heldVerified: false };
    }
    // Expired oat beats the generic reasons — 're-mint' is the actionable fix
    if (oatExpired) return { usable: false, how: null, reason: 'oat-expired', linked, held, heldVerified: false };
    if (!loggedIn) return { usable: false, how: null, reason: noLoginReason(), otherHosts, linked, held, heldVerified: false };
    // local-only-mac beats ship-disabled: flipping the ship setting would not
    // make a Keychain-backed login portable — say the real constraint.
    return { usable: false, how: null, reason: hostFacts.transport === 'dial' ? 'dial-no-ship' : this._localOnlyClaudeSub(a) ? 'local-only-mac' : 'ship-disabled', linked, held, heldVerified: false };
  }

  // ── Long-lived OAuth token (oat01, B-211a) ─────────────────────────────
  // `claude setup-token` mints a 1-year subscription token with NO refresh
  // token (verified vs 2.1.225: LONG_LIVED_OAUTH_TOKEN_TTL_SECONDS=31536000,
  // inferenceOnly:true; the client adapts it as {refreshToken:null,
  // expiresAt:null} and NEVER touches the token endpoint). Stored encrypted
  // like API keys. What it buys per placement:
  //   · REMOTE: ships as CLAUDE_CODE_OAUTH_TOKEN via the existing 0600-file +
  //     $(cat …) secret channel (ssh AND dial) — never rotates, so the local
  //     and remote copies can never diverge and the host makes ZERO
  //     token-endpoint calls (§ban-safety's #1 signal gone; the creds-dir
  //     tar dance isn't used for oat accounts).
  //   · LOCAL fallback: an account with no local login but an oat spawns via
  //     the env token (macOS keychain bypassed too).
  // Scope is inference-only (no user:profile): the on-demand quota ⟳ cannot
  // work through an oat, and a 401 (revoked/expired) has NO self-heal — the
  // CLI errors until re-mint. Minting the token is treated as the per-account
  // consent to run it on remote machines (finer-grained than the global
  // shipSubscriptionToRemote toggle, which stays for full-login shipping).
  OAT_TTL_MS = 31536000 * 1000;

  setOat(id, token) {
    const a = this.get(id);
    if (!a) throw new Error('unknown account: ' + id);
    if (this._acctBackend(a) !== 'claude' || this._acctType(a) !== 'subscription') throw new Error('long-lived tokens apply to Claude subscription accounts only');
    token = String(token || '').trim();
    // sk-ant-oat01-… today; tolerate future oat revisions, refuse everything
    // else (an API key or a pasted access token here would mis-bill silently)
    if (!/^sk-ant-oat\d{2}-[\w-]{20,600}$/.test(token)) throw new Error('that does not look like a long-lived token (expected sk-ant-oat01-…, from `claude setup-token`)');
    a.oatEnc = this._enc(token);
    a.oatMintedAt = Date.now();
    this._save();
    this._notify();
    return { id, mintedAt: a.oatMintedAt };
  }

  clearOat(id) {
    const a = this.get(id);
    if (!a) throw new Error('unknown account: ' + id);
    delete a.oatEnc; delete a.oatMintedAt;
    this._save();
    this._notify();
  }

  getOat(id) {
    const a = this.get(id);
    if (!a || !a.oatEnc) return null;
    try { return this._dec(a.oatEnc); } catch { return null; }
  }

  _oatMeta(a) {
    if (!a?.oatEnc) return {};
    const expiresAt = (a.oatMintedAt || 0) + this.OAT_TTL_MS;
    return { oat: true, oatMintedAt: a.oatMintedAt || null, oatDaysLeft: Math.floor((expiresAt - Date.now()) / 86400000) };
  }

  // ── Pooled pseudo-account (B-6217) ──────────────────────────────────────
  // A pooled account is NOT a login of its own: its "creds dir" is a DIRECTORY
  // SYMLINK at data/subs/<poolId> pointing at a REAL subscription's dir, and
  // switching accounts = atomically re-pointing that symlink.
  //
  // Why a DIRECTORY symlink and not copies or a file symlink (proven in
  // scripts/test-creds-symlink-swap.mjs, 8 asserts):
  //   · the CLI writes credentials with atomicWrite = tmp+rename, which
  //     REPLACES a *file* symlink on the first refresh — a *directory* one
  //     survives, because the rename happens INSIDE the resolved dir;
  //   · refreshes therefore land in the canonical account dir, so there is
  //     exactly ONE credential copy and Anthropic's ROTATING refresh token
  //     never gets rotated out from under a sibling session (the reason
  //     per-session copies are unsafe);
  //   · `<dir>/.oauth_refresh.lock` resolves through the symlink to the SAME
  //     real lock a normal session of that account takes ⇒ a pooled session
  //     and a normal session of one account are mutually excluded exactly as
  //     two normal sessions are today. Zero new refresh conflict.
  //   · QX() (the CLI's config-home resolver) returns the env STRING with no
  //     realpath and no caching, so the kernel re-resolves per syscall and a
  //     re-point is visible immediately; the stat'd mtime changes too, which
  //     is what invalidates the CLI's credential cache.
  // LINUX ONLY: on macOS credentials go to a keychain whose service name is
  // sha256(NFC(env string)) — the STRING, not the resolved path — so the pool
  // path would get its own keychain entry and the sharing silently breaks.
  poolSupported() { return process.platform !== 'win32' && process.platform !== 'darwin'; }

  // Candidate members: explicit list (filtered to still-valid logins) or, when
  // the pool declares none, EVERY logged-in Claude subscription (the default
  // the user asked for). Never includes another pool.
  poolMembers(id) {
    const a = this.get(id);
    const be = this._acctBackend(a) || 'claude';
    const all = this._state.accounts.filter((x) => this._acctBackend(x) === be && this._acctType(x) === 'subscription');
    const wanted = Array.isArray(a?.members) && a.members.length ? all.filter((x) => a.members.includes(x.id)) : all;
    const loggedIn = (x) => !!this._readAuthFor(be, x.id).loggedIn;
    return wanted.filter(loggedIn).map((x) => ({ id: x.id, name: x.name }));
  }

  /** The pool's own symlink path + a member's home dir — per backend (codex
   *  pool = symlink among the CODEX_HOME dirs; P2, design-backend-parity §2). */
  _poolLinkDir(a) { return this._acctDir(this._acctBackend(a), a.id); }
  _poolMemberDir(a, subId) { return this._acctDir(this._acctBackend(a), subId); }

  // The real account a pool currently resolves to, read from the symlink
  // itself (the link IS the state — no second source of truth to drift).
  poolCurrent(id) {
    try {
      const a = this.get(id);
      const t = fs.readlinkSync(this._poolLinkDir(a || { id }));
      const sub = path.basename(t);
      return this.get(sub) ? sub : null;
    } catch { return null; }
  }

  // ── Per-SESSION pool links (B-a612 plan C, 2.315.0) ─────────────────────
  // The pool's default link at data/subs/<poolId> stays THE state for display
  // and for sessions with no model identity. A session that declares a model
  // gets its OWN directory symlink at data/pool-links/<poolId>/<sessKey> —
  // same primitive, same lock/credential invariants (N links over M accounts
  // still leave exactly M credential files; every link to account X resolves
  // to X's one refresh lock), so a fable conversation and an opus conversation
  // can bill to DIFFERENT members simultaneously. The link is created at
  // spawn, re-pointed per session by the auto-switch, dropped at kill, and
  // reconciled at boot (a link whose session is gone is unlinked).
  poolLinksDir(poolId) { return path.join(this.dataDir, 'pool-links', String(poolId).replace(/[^\w-]/g, '')); }
  sessionPoolLinkPath(poolId, sessKey) { return path.join(this.poolLinksDir(poolId), String(sessKey).replace(/[^\w.-]/g, '')); }
  ensureSessionPoolLink(poolId, sessKey, memberId) {
    const target = this.get(memberId);
    if (!target || this._acctType(target) !== 'subscription') throw new Error('not a subscription: ' + memberId);
    if (!this.readSubCreds(memberId).loggedIn) throw new Error('pool member not logged in: ' + target.name);
    const link = this.sessionPoolLinkPath(poolId, sessKey);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    require('./account-material.js').repointPoolSymlink(link, this.subDir(memberId), this.subCredsPath(memberId));
    return link;
  }
  /** The real account THIS session bills to: its own link's target, else the
   *  pool default. The link IS the state at both granularities. */
  poolCurrentFor(poolId, sessKey) {
    if (sessKey) {
      try {
        const sub = path.basename(fs.readlinkSync(this.sessionPoolLinkPath(poolId, sessKey)));
        if (this.get(sub)) return sub;
      } catch { }
    }
    return this.poolCurrent(poolId);
  }
  dropSessionPoolLink(poolId, sessKey) { try { fs.unlinkSync(this.sessionPoolLinkPath(poolId, sessKey)); } catch { } }
  /** Boot reconciliation: unlink per-session links whose session no longer
   *  exists — a leaked link is a billing pointer nobody can see or move. */
  sweepSessionPoolLinks(liveKeys) {
    const root = path.join(this.dataDir, 'pool-links');
    let dropped = 0;
    try {
      for (const poolId of fs.readdirSync(root)) {
        const dir = path.join(root, poolId);
        let entries = []; try { entries = fs.readdirSync(dir); } catch { continue; }
        for (const k of entries) if (!liveKeys.has(k)) { try { fs.unlinkSync(path.join(dir, k)); dropped++; } catch { } }
        try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { }
      }
    } catch { }
    return dropped;
  }
  /** Every live link path of a pool (sealed orders carry these so the daemon
   *  can match a banner to the RIGHT link; old daemons ignore the field and
   *  keep matching only the default link — reduced coverage, never a wrong
   *  re-point). */
  sessionPoolLinks(poolId) {
    try { return fs.readdirSync(this.poolLinksDir(poolId)).map((k) => ({ sessKey: k, path: this.sessionPoolLinkPath(poolId, k) })); } catch { return []; }
  }

  // Atomically re-point the pool at `subId`. symlink-to-temp + rename so a
  // concurrent spawn either sees the old target or the new one, never a gap.
  // The target's creds mtime is bumped because the CLI's credential cache is
  // mtime-gated and two accounts could otherwise share an mtimeMs.
  setPoolTarget(id, subId, { sweepSessionLinks = false } = {}) {
    const a = this.get(id);
    if (!a || this._acctType(a) !== 'pooled') throw new Error('not a pooled account');
    const be = this._acctBackend(a) || 'claude';
    const target = this.get(subId);
    if (!target || this._acctType(target) !== 'subscription' || this._acctBackend(target) !== be) throw new Error(`not a ${be} subscription: ` + subId);
    if (!this._readAuthFor(be, subId).loggedIn) throw new Error('subscription not logged in: ' + target.name);
    // ONE material implementation (src/account-material.js, 2.298.0): the
    // same primitive the daemon's sealed-orders reflex executes — data/subs
    // is device #0's account store, and the mechanical act is device-tier.
    // codex pools repoint among CODEX_HOME dirs; the creds-mtime bump is a
    // claude cred-cache detail (null for codex — auth.json needs no bump).
    const mat = require('./account-material.js');
    const bump = this._credsOf(be).bumpFile;
    mat.repointPoolSymlink(this._poolLinkDir(a), this._poolMemberDir(a, subId), bump ? path.join(this._acctDir(be, subId), bump) : null);
    // sweepSessionLinks (2.355.0, userW's inc-msz495u6 — "热切换死了"):
    // plan C (2.315.0) gave every live session its OWN link and
    // poolCurrentFor prefers it, which silently DEMOTED the manual target
    // change to new-sessions-only: the default moved while every live
    // session's link stayed on the old member (verified on the reporting
    // instance: default → new member, 16 live links → old member). The USER
    // route passes true when the pool is hot (an explicit pick means "all of
    // it, now"); the ENGINE never passes it — its per-session moves are the
    // model-family projections a blanket sweep would clobber.
    let swept = 0;
    if (sweepSessionLinks) {
      for (const { path: lp } of this.sessionPoolLinks(id)) {
        try { mat.repointPoolSymlink(lp, this.subDir(subId), null); swept++; } catch { }
      }
      if (swept) console.log(`[pool] manual target → ${target.name}: repointed ${swept} live session link(s)`);
    }
    this._notify();
    return { id, current: subId, name: target.name, swept };
  }

  createPool({ name, members, backend = 'claude' } = {}) {
    const be = backend || 'claude';
    if (!capsOf(be).pool || !this._credsOf(be)) throw new Error('pooling is not supported for backend ' + be); // unknown ids throw in harnessOf
    // The darwin exclusion is claude-specific (keychain service name = a hash
    // of the env string) — codex auth.json is a plain file, pools work anywhere
    // directory symlinks do.
    if (be === 'claude' && !this.poolSupported()) throw new Error('pooled accounts need a platform with directory symlinks and no keychain-backed credentials (Linux)');
    const id = 'pool-' + crypto.randomBytes(6).toString('hex');
    const a = { id, name: String(name || '').trim().slice(0, 60) || 'Pool', type: 'pooled', backend: be, members: Array.isArray(members) && members.length ? members.slice(0, 40) : null, auto: false, hot: false, createdAt: Date.now() };
    this._state.accounts.push(a);
    this._save();
    const first = this.poolMembers(id)[0];
    if (!first) { this._state.accounts = this._state.accounts.filter((x) => x.id !== id); this._save(); throw new Error(`no logged-in ${this._credsOf(be).loginLabel} subscription to pool`); }
    this.setPoolTarget(id, first.id);
    this._notify();
    return { id, current: first.id };
  }

  // members / auto / hot. A member list that drops the CURRENT target re-points
  // to the first remaining member (a pool must always resolve to something).
  updatePool(id, { members, auto, hot } = {}) {
    const a = this.get(id);
    if (!a || this._acctType(a) !== 'pooled') throw new Error('not a pooled account');
    if (members !== undefined) a.members = Array.isArray(members) && members.length ? members.slice(0, 40) : null;
    if (auto !== undefined) a.auto = !!auto;
    if (hot !== undefined) a.hot = !!hot;
    this._save();
    const cur = this.poolCurrent(id);
    const list = this.poolMembers(id);
    if (list.length && !list.some((m) => m.id === cur)) this.setPoolTarget(id, list[0].id);
    this._notify();
    return this.get(id);
  }

  resolveForSpawn(requested, backend = 'claude', opts = {}) {
    if (backend === 'codex') return this._resolveCodexSpawn(requested);
    if (requested === 'subscription') return null; // the CLI's own global login
    const id = requested || this._state.defaultAccountId;
    if (!id) return null;
    const a = this.get(id);
    if (!a) throw new Error('unknown account: ' + id);
    if (this._acctBackend(a) !== 'claude') throw new Error('not a Claude account: ' + a.name);
    if (this._acctType(a) === 'pooled') {
      let cur = this.poolCurrent(id);
      // SELF-HEAL (2.330.2, real outage: BOTH the pool's target and every
      // per-session link pointed at accounts whose refresh token had aged out
      // while idle, so EVERY resume failed with "pooled target is not logged
      // in" and the user had no way forward). Routing around a dead member is
      // the entire point of a pool — a dead target must re-point, not throw.
      // poolMembers() is already filtered to still-valid logins.
      const liveTarget = (x) => !!x && this.readSubCreds(x).loggedIn;
      if (!cur || !this.readSubCreds(id).loggedIn) {
        const alive = this.poolMembers(id).map((m) => m.id);
        if (!alive.length) {
          throw new Error(`every member of pool "${a.name}" is signed out — re-login one in Manage Agents (the pool cannot route around a fully signed-out member set)`);
        }
        // Prefer a member whose LOGIN SESSION is not already dead (2026-09-07):
        // an 'expired' member still parses as loggedIn (the tokens are only
        // blanked at the CLI's next failed refresh), so without this the
        // self-heal happily re-points onto a login that fails the first turn.
        // A STABLE ordering, never a filter — every member being expired must
        // still start the session (and then say so) rather than throw here.
        alive.sort((x, y) => loginRank(this.loginStateOf(x)) - loginRank(this.loginStateOf(y)));
        let pick = null;
        try { const c = opts.chooseMember?.(); if (alive.includes(c)) pick = c; } catch { }
        pick = pick || alive[0];
        const was = cur;
        this.setPoolTarget(id, pick);
        cur = pick;
        console.warn(`[pool] "${a.name}" target ${was || '(none)'} is signed out — re-pointed to ${this.get(pick)?.name || pick} so the session can start; re-login the dead account in Manage Agents`);
        try { global.__vsEvent?.('pool-target-signed-out', { detail: `${was || 'none'}→${pick}` }); } catch { }
      }
      // No remoteCreds: shipping would copy the symlink's CONTENTS to a fixed
      // remote dir, freezing the pool at spawn time and (on a macOS host)
      // landing in a per-path keychain entry. Pools are local-only for now.
      // Per-session link (plan C): a session with an identity gets its own
      // symlink so concurrent conversations on different models can bill to
      // different members. The CHOICE is the caller's (chooseMember reads the
      // usage caches, which this store deliberately doesn't); default = the
      // pool's current target, i.e. exactly the legacy behaviour.
      if (opts.sessionKey) {
        let member = null;
        try { member = opts.chooseMember?.(); } catch { }
        // The chooser ranks by QUOTA (it reads the usage caches); credentials
        // are this store's authority. A member that is signed out is not a
        // candidate no matter how much quota it shows — same outage, second
        // door (a per-session link pinned to a dead account).
        if (!liveTarget(member)) {
          if (member) console.warn(`[pool] chooser picked signed-out member ${member} — falling back to the live target`);
          member = null;
        }
        member = member || cur;
        const link = this.ensureSessionPoolLink(id, opts.sessionKey, member);
        return { id: a.id, name: a.name, kind: 'subscription', pooled: true, poolTarget: member, sessionLink: true, localEnv: { [this._credsOf('claude').spawnEnvVar]: link }, secret: null };
      }
      return { id: a.id, name: a.name, kind: 'subscription', pooled: true, poolTarget: cur, localEnv: { [this._credsOf('claude').spawnEnvVar]: this._acctDir('claude', id) }, secret: null };
    }
    if (this._acctType(a) === 'subscription') {
      const info = this.readSubCreds(id);
      // Long-lived token (B-211a): rides the API-key secret channel for
      // remote spawns (both remote paths check .secret BEFORE the creds-dir
      // ship, so an oat account never tars its rotating login to a host).
      // Locally the dir login stays authoritative when present (hot-swap +
      // full capabilities); with NO local login the env token IS the spawn.
      const oatExpired = a.oatEnc && (a.oatMintedAt || 0) + this.OAT_TTL_MS < Date.now();
      const oat = oatExpired ? null : this.getOat(id);
      const oatSecret = oat ? { var: 'CLAUDE_CODE_OAUTH_TOKEN', value: oat } : null;
      if (!info.loggedIn && oat) {
        return { id: a.id, name: a.name, kind: 'subscription', oatOnly: true, localEnv: { CLAUDE_CODE_OAUTH_TOKEN: oat }, secret: oatSecret };
      }
      // Expired oat: fail the CREATE with the real reason instead of letting
      // the CLI 401 opaquely mid-session (a long-lived 401 has no self-heal).
      // loggedIn + expired-oat just drops the secret — the dir login works
      // locally and the remote paths give their normal actionable errors.
      if (!info.loggedIn && a.oatEnc && oatExpired) throw new Error(`the long-lived token for ${a.name} has expired — re-mint it in Manage agents (⋯ → Long-lived token)`);
      if (!info.loggedIn) throw new Error('subscription not logged in: ' + a.name);
      return {
        id: a.id, name: a.name, kind: 'subscription', oatExpired: oatExpired || undefined,
        localEnv: { [this._credsOf('claude').spawnEnvVar]: this._acctDir('claude', id) }, secret: oatSecret,
        // REMOTE: ship the creds dir to the host so the remote CLI reads THIS
        // account's login (securestorage relocated; config stays ~/.claude).
        // probe: newest-wins keeps a POISONED remote file forever (e.g. a
        // Console /login inside a remote session wipes .credentials.json to {}
        // with a fresh mtime) — a remote primary file MISSING the marker is
        // deleted before extract so the valid local copy always restores it.
        remoteCreds: this._remoteCreds('claude', id, a), // shippable:false on a Keychain-primary Mac dir (must never be copied)
      };
    }
    const key = this.getKey(id);
    if (!key) throw new Error('account key unavailable (decryption failed): ' + a.name);
    return { id: a.id, name: a.name, tail: a.tail, kind: 'api', localEnv: { ANTHROPIC_API_KEY: key }, secret: { var: 'ANTHROPIC_API_KEY', value: key } };
  }

  // Codex spawn: undefined/null → the account's own global login (default) or
  // ~/.codex when none; a 'cxs-…' id → that account's isolated CODEX_HOME.
  _resolveCodexSpawn(requested) {
    if (requested === 'subscription') return null; // codex's own global login
    const id = requested || this._state.defaultCodexAccountId;
    if (!id) return null;
    const a = this.get(id);
    if (!a) throw new Error('unknown account: ' + id);
    // codex POOL (P2, cold-switch v1): CODEX_HOME = the pool's symlink among
    // the member CODEX_HOME dirs — a spawn resolves through it to whichever
    // member the engine currently targets; switches restart the session
    // (kill+resume, the existing cold machinery). Self-heal a dangling link
    // to the first healthy member, exactly like the claude resolve branch.
    if (this._acctType(a) === 'pooled') {
      if (this._acctBackend(a) !== 'codex') throw new Error('not a Codex account: ' + a.name);
      let cur = this.poolCurrent(id);
      if (!cur || !this.readCodexSubAuth(cur).loggedIn) {
        const first = this.poolMembers(id)[0];
        if (!first) throw new Error(`pool "${a.name}" has no logged-in ChatGPT member`);
        this.setPoolTarget(id, first.id);
        cur = first.id;
      }
      return { id: a.id, name: a.name, kind: 'codex-pooled', localEnv: { [this._credsOf('codex').spawnEnvVar]: this._acctDir('codex', id) }, secret: null, remoteCreds: null };
    }
    if (this._acctBackend(a) !== 'codex') throw new Error('not a Codex account: ' + a.name);
    const info = this.readCodexSubAuth(id);
    if (!info.loggedIn) throw new Error('codex account not logged in: ' + a.name);
    return {
      id: a.id, name: a.name, kind: 'codex-subscription',
      localEnv: { [this._credsOf('codex').spawnEnvVar]: this._acctDir('codex', id) }, secret: null,
      // REMOTE: ship auth.json to the host's CODEX_HOME copy; sessions/config
      // symlink the host's own ~/.codex (targets ensured first) so threads +
      // settings stay shared on the host, auth isolated per account.
      remoteCreds: this._remoteCreds('codex', id, a),
    };
  }

  // ── Add a CONSOLE account (its minted API key) WITHOUT nuking the global
  // subscription. A console /login mints primaryApiKey into ~/.claude.json AND
  // wipes .credentials.json (destructive). We protect the global creds by
  // pointing CLAUDE_SECURESTORAGE_CONFIG_DIR at a throwaway dir — the wipe lands
  // THERE, ~/.claude/.credentials.json is untouched (its token reads from
  // securestorage). The minted key still lands in the shared ~/.claude.json, so
  // capture reads it via importFromCli. Config dir stays ~/.claude → no
  // first-run onboarding. Throwaway dir discarded after.
  beginConsoleLogin() {
    const id = 'con-' + crypto.randomBytes(6).toString('hex');
    const dir = path.join(this._subsDir, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this._seedConfigDir(dir);
    return { id, dir };
  }
  captureConsoleLogin(id, { name } = {}) {
    if (!/^con-[a-f0-9]+$/.test(id)) throw new Error('bad login id');
    const dir = path.join(this._subsDir, id);
    // With CLAUDE_CONFIG_DIR=dir the console login minted primaryApiKey into
    // dir/.claude.json (isolated — ~/.claude.json untouched). Read it there.
    let pk = null, org = null;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf-8'));
      pk = cfg?.primaryApiKey; org = cfg?.oauthAccount?.organizationName || null;
    } catch { }
    if (typeof pk !== 'string' || !/^sk-ant-/.test(pk)) return { captured: false };
    const account = this.add({ name: name || (org ? org + ' (Console)' : 'Console API'), key: pk, source: 'console-login' });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
    return { captured: true, account };
  }

  // A subscription account's read-only access token for the usage poll (null if
  // expired/absent — we NEVER refresh; a running session or a next-use refreshes
  // it). Used by server.js to poll per-account /api/oauth/usage.
  usageToken(id) {
    const a = this.get(id);
    // Anthropic-only poll — codex usage is OpenAI-side, not surfaced here.
    if (!a || this._acctBackend(a) !== 'claude' || this._acctType(a) !== 'subscription') return null;
    return this.readSubCreds(id).accessToken || null;
  }

  // ── Read-only probes of the CLI's own login state (NEVER written) ──

  // Subscription = global OAuth login present in ~/.claude/.credentials.json.
  subscriptionStatus() {
    let loggedIn = false;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf-8'));
      loggedIn = !!raw?.claudeAiOauth?.accessToken;
    } catch { }
    let email = null, org = null;
    if (loggedIn) {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'));
        email = cfg?.oauthAccount?.emailAddress || null;
        org = cfg?.oauthAccount?.organizationName || null;
      } catch { }
    }
    return { loggedIn, email, org };
  }

  // The CLI's console login mints primaryApiKey in ~/.claude.json — importable.
  cliPrimaryKey() {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'));
      const pk = cfg?.primaryApiKey;
      if (typeof pk === 'string' && /^sk-ant-/.test(pk)) {
        const tail = pk.slice(-8);
        return {
          present: true,
          tail,
          org: cfg?.oauthAccount?.organizationName || null,
          imported: this._state.accounts.some((a) => a.tail === tail),
        };
      }
    } catch { }
    return { present: false };
  }

  importFromCli() {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'));
      const pk = cfg?.primaryApiKey;
      if (typeof pk !== 'string' || !/^sk-ant-/.test(pk)) throw new Error('no primaryApiKey in ~/.claude.json — log in to a Console account first');
      const org = cfg?.oauthAccount?.organizationName;
      return this.add({ name: org ? org + ' (API)' : 'Console API', key: pk, source: 'cli-import' });
    } catch (e) { throw new Error(e.message); }
  }
}

module.exports = { AccountManager };
