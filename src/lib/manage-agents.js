// Manage-Agents dialog + Anthropic/ChatGPT account rosters (mixin split from app.js, 2.82.0 audit seam). Methods run with the App instance as `this`.
import { UI_ICONS } from './icons.js';
import { t } from './i18n.js';
import { SETTINGS_SCHEMA } from './settings-schema.js';
import { agoText, api, copyText, createModalShell, escHtml, estDisplayPair, fetchJson, showConfirmDialog, showContextMenu, showInputDialog, showToast } from './utils.js';
import { track } from './telemetry-client.js';
import { openPermissionRulesDialog, runLocalOracle } from './permission-rules-view.js';
import { permissionRulesCaps } from './agent-meta.js';
// The oracle registry + its measured PROOFS and the measured-and-REJECTED
// candidates are PURE and shared with the server (CJS pulled into the bundle
// like search-card.js): the menu can only offer what the server will run, and
// a rejected candidate is NAMED here rather than silently missing.
import { oraclesFor, rejectedFor, blockingRejectionsFor } from '../local-oracles.js';

// Roster order = TYPE, never add-order (2.268.5): pool → subscription → API
// key, name-sorted within a type. ONE comparator for both rosters (2.369.18 —
// the codex roster name-sorted "because all codex entries are logins", which
// stopped being true with codex pools); the billing switcher and the New
// Session dropdown inline the same comparator — keep them in step.
const acctTypeRank = (x) => (x.pooled || x.type === 'pooled') ? 0 : (x.type === 'subscription' ? 1 : 2);
export const rosterSort = (a, b) => acctTypeRank(a) - acctTypeRank(b) || String(a.name || '').localeCompare(String(b.name || ''));
// Roster row icons (SVG only, never emoji) — shared by both rosters so a
// pooled account draws the SAME overlapping-circles glyph whatever its
// backend (a pool is NOT a login: the crown/key misread as one, real report).
const rosterSvg = (d, sw = 1.4) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ROSTER_ICONS = Object.freeze({
  CROWN: rosterSvg('<path d="M2.5 12.5h11M3 12.5L2 4.5l3.2 2.6L8 3l2.8 4.1L14 4.5l-1 8z"/>'),
  GLOBE: rosterSvg('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12"/>'),
  KEY: rosterSvg('<circle cx="5" cy="9" r="2.6"/><path d="M7.4 8.2 14 3M11.5 5.2l1.6 1.6M13 3.7l1.6 1.6"/>', 1.5),
  POOL: rosterSvg('<circle cx="5.4" cy="6.2" r="3"/><circle cx="10.6" cy="6.2" r="3"/><circle cx="8" cy="10.6" r="3"/>', 1.3),
  STAR_F: rosterSvg('<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .8 4.3L8 11.6 4.1 13.6l.8-4.3-3.1-3 4.3-.6z" fill="currentColor"/>'),
  STAR_O: rosterSvg('<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .8 4.3L8 11.6 4.1 13.6l.8-4.3-3.1-3 4.3-.6z"/>'),
  DOTS: rosterSvg('<circle cx="3" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="13" cy="8" r="1.3" fill="currentColor" stroke="none"/>'),
  // Login-session expiry (2026-09-07): a clock, because the fact is a
  // DEADLINE, not a permission problem (SVG only — never emoji).
  CLOCK: rosterSvg('<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6"/>'),
});

// ── Login-session expiry chip (2026-09-07) ───────────────────────────────
// The server hands every subscription row `loginState` = the PURE reading of
// its credential file (src/login-expiry.js): {state, refreshExpiresAt,
// msLeft}. NOTE the same-spelling trap: the /relogin(-finalize) routes return
// a STRING `loginState` meaning "how the login TERMINAL went" ('error') —
// this one is an OBJECT about the login's LIFETIME. Different objects,
// different types; never join them.
// A pool's row carries its members' WORST state plus `worstName`/`worstId`,
// because a pool has no login of its own.
const loginLeftText = (ms) => {
  const v = Math.max(0, Number(ms) || 0);
  if (v < 90 * 60e3) return t('{n} min', { n: Math.max(1, Math.round(v / 60e3)) });
  if (v < 36 * 3600e3) return t('{n} h', { n: Math.round(v / 3600e3) });
  return t('{n} d', { n: Math.round(v / 86400e3) });
};
// Short date + short time (no seconds): the chip sits on the row's one extras
// line, and a second-precision timestamp is noise for a deadline the user acts
// on in hours. Locale-formatted — the device decides, like every other time here.
const loginWhenText = (ms) => { try { return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }); } catch { try { return new Date(ms).toLocaleString(); } catch { return ''; } } };
/** The chip, or '' when there is nothing worth saying (ok / unknown — an
 *  unreadable deadline is ignorance and must never be dressed as a warning).
 *  `local` = the "This machine" roster; a host section only ever shows the
 *  DEAD state (the same rule oatTag uses: an expiry warning about this
 *  machine's creds dir would be noise while looking at a host). */
export function loginExpiryChipHtml(a, { local = true } = {}) {
  const ls = a && a.loginState;
  if (!ls || typeof ls !== 'object') return '';
  const dead = ls.state === 'expired' || ls.state === 'logged-out';
  if (!dead && !(local && ls.state === 'expiring')) return '';
  const target = ls.worstId || a.id;           // pool ⇒ the member that earned the state
  const who = ls.worstName ? escHtml(ls.worstName) + ': ' : '';
  const when = loginWhenText(ls.refreshExpiresAt);
  const label = ls.state === 'logged-out' ? t('login signed out — re-login')
    : ls.state === 'expired' ? t('login expired {when} — re-login', { when: escHtml(when) })
    : t('login expires in {left}', { left: escHtml(loginLeftText(ls.msLeft)) });
  const title = ls.state === 'logged-out'
    ? t('This account’s login session ran out and the CLI cleared its tokens — every session on it fails until you sign in again. Click to re-login.')
    : ls.state === 'expired'
    ? t('This account’s login session ended {when}. Refreshing the access token does NOT extend it, so the CLI can no longer authenticate — every session on this account fails. Click to re-login.', { when: escHtml(when) })
    : t('This account’s login session ends {when} — that deadline does NOT move when the access token refreshes. Re-login before then or sessions on it will start failing. Click to re-login.', { when: escHtml(when) });
  return ` <span class="acct-blocked-hint acct-login-chip" role="button" tabindex="0" data-relogin="${escHtml(target)}"`
    + `${dead ? ' style="color:var(--red,#e55)"' : ''} title="${title}">${ROSTER_ICONS.CLOCK}${who}${label}</span>`;
}

function remoteClaudeSubscriptionLoginCommand(id) {
  if (!/^sub-[a-f0-9]+$/.test(id)) throw new Error('invalid subscription id');
  const dir = `$HOME/.vibespace/subs/${id}`;
  const attempt = `vslogin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // The server ships this single transport helper even when agent Integration
  // is off. It runs the official login and, on a Mac host, captures Keychain
  // credentials before the interactive terminal/security session ends.
  return {
    attempt,
    command: `mkdir -p "${dir}" && node "$HOME/.vibespace/bin/vibespace-claude-subscription-login.mjs" --config-dir "${dir}" --claude claude --attempt "${attempt}"`,
  };
}

export function installManageAgents(App, ctx = {}) {
  Object.assign(App.prototype, {
  /**
   * THE READ-ONLY "rules & checks" MENU BLOCK (owner rulings 10 + 6), shared
   * by both account rosters so the two never drift.
   *   · "Permission rules…" — the read-only tree, offered when the caps row
   *     says this harness answers at INSTANCE scope. Never on a remote host
   *     section: the rules live on that machine and the reader is local.
   *   · one row per registered LOCAL ORACLE for this harness — human-triggered,
   *     measured zero-network, run under the account's own config dir.
   *   · when a harness has NO oracles, the measured-and-REJECTED candidates
   *     are shown DISABLED with the reason, because "there is nothing here"
   *     and "we measured these and they phone home" are different facts and
   *     the second one is the one worth knowing.
   *   · a rejection that carries `blocks` is shown ALWAYS (round-2 verifier).
   *     It explains a MISSING BUTTON rather than an empty menu, and the one
   *     such row today belongs to codex — which has three shipped oracles, so
   *     the "only when there are none" rule would have hidden precisely the
   *     rejection a user needs to see when "Permission rules…" is not there.
   */
  _rulesAndChecksItems(backend, { accountId = '', accountName = '', selectedHost = null } = {}) {
    if (selectedHost) return [];                       // local machine only — say nothing rather than guess
    const items = [];
    const caps = permissionRulesCaps(backend);
    if (caps.source && caps.instance) {
      items.push({
        label: t('Permission rules…'),
        title: t('Read-only: which permission rule comes from which file or layer'),
        action: () => openPermissionRulesDialog({ backend, accountId, accountName }),
      });
    }
    const oracles = oraclesFor(backend);
    for (const o of oracles) {
      items.push({
        label: t('{check}…', { check: o.label }),
        title: `${o.description} (${backend} ${o.argv.join(' ')})`,
        action: () => runLocalOracle({ id: o.id, label: o.label, accountId, accountName }),
      });
    }
    // the honest note. `blocks` rows always; the rest only when the menu would
    // otherwise be empty (they answer "why is there nothing here").
    const notes = oracles.length ? blockingRejectionsFor(backend) : rejectedFor(backend);
    for (const r of notes) {
      items.push({ label: t('{cmd} — not offered', { cmd: r.label }), disabled: true, title: r.verdict });
    }
    return items.length ? [{ separator: true }, ...items] : [];
  },

  // ── Manage Agents dialog: install/login status + login/update actions ──
  // One place for CLI lifecycle instead of scattered menu entries. Login and
  // update both run visibly in a shell terminal window (nothing hidden).
  // Guided "both accounts" setup (subscription OAuth + a saved API key). The
  // CLI's /login is mutually exclusive, so the wizard choreographs the order:
  // Console login FIRST (its minted key gets captured into VibeSpace), then log
  // BACK into the subscription — final state: subscription owns the global
  // login, the API key lives in our store, sessions pick per-spawn. Each login
  // step opens a terminal; a background watcher detects completion and reopens
  // the wizard at the next step.
  // Add another Claude subscription: name it, allocate an isolated creds dir,
  // open a login terminal scoped to that dir (does NOT disturb the CLI's global
  // login), and watch for the OAuth login to land. Held per-account, switchable
  // per session. (Local Claude only in P1.)
  async _addSubscription(hostId, hostLabel) {
    // NOT the dialog-scope refresh — this is a standalone method (real
    // incident inc-mslfbdjv: the 2.255.0 fix called the dialog's `refresh()`
    // here, the ReferenceError killed the flow BEFORE the login terminal
    // opened, and the click looked like a silent no-op).
    const refresh = () => { try { this._agentsRefreshHook?.(); } catch { } };
    const name = await showInputDialog({
      title: hostId ? t('Add subscription — log in on {host}', { host: hostLabel }) : t('Add subscription'),
      label: t('Name this subscription (e.g. Work Max, Personal Max)'),
      placeholder: t('e.g. Work Max'),
      confirmText: t('Continue'),
    });
    if (name === null) return; // cancelled
    let created;
    try {
      created = await fetchJson('/api/accounts/subscription', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: (name || '').trim() }),
      });
    } catch { showToast(t('Could not start — server unreachable'), { type: 'error' }); return; }
    if (!created?.loginCmd) { showToast(created?.error || t('Could not start'), { type: 'error' }); return; }
    // With a MACHINE selected the login runs ON that machine, into the
    // account's per-host creds dir (2.199.0/2.200.0 — real trap: the dialog
    // said the devbox, the login terminal quietly opened LOCALLY, and the user's
    // account landed in the local store "moved to this machine"). The token
    // is minted on the host and never leaves it; the account record still
    // lives in VibeSpace (machine-independent identity).
    if (hostId) {
      const login = remoteClaudeSubscriptionLoginCommand(created.id);
      this._watchHostLogin(hostId, hostLabel, created.id, login.attempt);
      this.openShellTerminal(undefined, { hostId, initialCommand: login.command });
      showToast(t('A terminal opened ON {host} — sign in there. The login lives on {host} only; sessions on it can then pick this account.', { host: hostLabel }), { duration: 7000 });
      refresh();
      return;
    }
    // Show the new (not-yet-logged-in) account in the roster IMMEDIATELY —
    // the create already succeeded server-side; without this the page looked
    // unchanged until a manual reopen (inc-msl890ua, real report).
    refresh();
    // Open a login terminal with the env-scoped command. The sign-in writes THIS
    // account's creds into its own dir — your current/global login is untouched.
    this.openShellTerminal(undefined, { initialCommand: created.loginCmd });
    showToast(t('A terminal opened — sign in with the account you want to add. Your other logins are untouched; VibeSpace captures it automatically.'), { duration: 6000 });
    // Poll finalize until the creds file appears (or give up after ~5 min).
    let tries = 0;
    const iv = setInterval(async () => {
      // GIVING UP MUST BE SAID (静默失能零容忍): the user was promised
      // "VibeSpace captures it automatically", so a login finished after
      // minute 5 (slow browser flow, MFA) left the account silently stuck at
      // "not logged in" with nothing hinting a manual re-check was needed.
      if (++tries > 100) {
        clearInterval(iv);
        const last = await fetchJson(`/api/accounts/subscription/${encodeURIComponent(created.id)}/finalize`, { method: 'POST' }); // one last chance
        if (last?.loggedIn) { showToast(t('✓ Added {name}', { name: last.name || t('subscription') })); return; }
        showToast(t('Stopped watching for the login after 5 min. If you completed it, press Re-check in Manage agents to finish capturing it.'), { type: 'error', duration: 10000 });
        return;
      }
      try {
        const r = await fetchJson(`/api/accounts/subscription/${encodeURIComponent(created.id)}/finalize`, { method: 'POST' });
        if (r?.loggedIn) {
          clearInterval(iv);
          if (r.merged) showToast(t('✓ Recognized as existing account “{name}” — merged (freshest login kept)', { name: r.account?.name || '' }), { duration: 7000 });
          else showToast(t('✓ Added {name}', { name: r.name || t('subscription') }));
        } else if (r?.loginFailed) {
          clearInterval(iv);
          showToast(t('Subscription login could not be saved. Check the login terminal for details, then try again.'), { type: 'error', duration: 8000 });
        }
      } catch { /* keep polling */ }
    }, 3000);
  },

  // Add a Console account (its minted API key) without disturbing the global
  // subscription — the /login runs in an isolated dir server-side, we poll for
  // the minted key and import it.
  async _addConsoleAccount() {
    let r;
    try { r = await fetchJson('/api/accounts/console-login', { method: 'POST' }); }
    catch { showToast(t('Could not start — server unreachable'), { type: 'error' }); return; }
    if (!r?.loginCmd) { showToast(r?.error || t('Could not start'), { type: 'error' }); return; }
    this.openShellTerminal(undefined, { initialCommand: r.loginCmd });
    showToast(t('A terminal opened — pick “Anthropic Console account” and sign in. Your subscription login stays intact.'), { duration: 6000 });
    let tries = 0;
    const iv = setInterval(async () => {
      if (++tries > 100) { // one final capture attempt, then SAY we stopped
        clearInterval(iv);
        const last = await fetchJson(`/api/accounts/console-login/${encodeURIComponent(r.id)}/capture`, { method: 'POST' });
        if (last?.captured) { showToast(t('✓ Added {name}', { name: last.account?.name || t('Console account') })); return; }
        showToast(t('Stopped watching for the login after 5 min. If you completed it, press Re-check in Manage agents to finish capturing it.'), { type: 'error', duration: 10000 });
        return;
      }
      try {
        const c = await fetchJson(`/api/accounts/console-login/${encodeURIComponent(r.id)}/capture`, { method: 'POST' });
        if (c?.captured) { clearInterval(iv); showToast(t('✓ Added {name}', { name: c.account?.name || t('Console account') })); }
      } catch { /* keep polling */ }
    }, 3000);
  },

  // Add a Codex (ChatGPT) subscription — same isolation idea via CODEX_HOME.
  async _addCodexSubscription() {
    const name = await showInputDialog({
      title: t('Add ChatGPT account'),
      label: t('Name this account (e.g. Work ChatGPT, Personal)'),
      placeholder: t('e.g. Work ChatGPT'),
      confirmText: t('Continue'),
    });
    if (name === null) return; // cancelled
    let created;
    try {
      created = await fetchJson('/api/accounts/codex-subscription', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: (name || '').trim() }),
      });
    } catch { showToast(t('Could not start — server unreachable'), { type: 'error' }); return; }
    if (!created?.loginCmd) { showToast(created?.error || t('Could not start'), { type: 'error' }); return; }
    // Login writes THIS account's auth.json into its own CODEX_HOME; sessions
    // stay shared (symlinked). Your other logins are untouched.
    this.openShellTerminal(undefined, { initialCommand: created.loginCmd });
    showToast(t('A terminal opened — sign in with the ChatGPT account you want to add. Your other logins are untouched; VibeSpace captures it automatically.'), { duration: 6000 });
    let tries = 0;
    const iv = setInterval(async () => {
      if (++tries > 100) { // one final finalize attempt, then SAY we stopped
        clearInterval(iv);
        const last = await fetchJson(`/api/accounts/codex-subscription/${encodeURIComponent(created.id)}/finalize`, { method: 'POST' });
        if (last?.loggedIn) { showToast(t('✓ Added {name}', { name: last.name || t('account') })); return; }
        showToast(t('Stopped watching for the login after 5 min. If you completed it, press Re-check in Manage agents to finish capturing it.'), { type: 'error', duration: 10000 });
        return;
      }
      try {
        const r = await fetchJson(`/api/accounts/codex-subscription/${encodeURIComponent(created.id)}/finalize`, { method: 'POST' });
        if (r?.loggedIn) { clearInterval(iv); showToast(t('✓ Added {name}', { name: r.name || t('account') })); }
      } catch { /* keep polling */ }
    }, 3000);
  },

  // Watch a "Log in on <host>…" flow land (2.195.0, real report: after an
  // on-host login the dialog showed another machine + the old identity).
  // Polls the host's live login state — a read-only ssh probe, NO API calls
  // (§ban-safety) — until the credential files CHANGE vs the pre-login
  // snapshot, then brings the Agents surface back on the SAME machine.
  // ── Long-lived token (oat01, B-211a) ────────────────────────────────────
  // `claude setup-token` mints a 1-year, refresh-free subscription token.
  // Storing one here is the per-account consent to run it on remote machines
  // (it ships as CLAUDE_CODE_OAUTH_TOKEN over the same 0600-file channel API
  // keys use — nothing rotates, no login is shipped). The mint itself is an
  // interactive OAuth consent: the BROWSER login chooses which account the
  // token belongs to, so the dialog says that in bold terms.
  _oatDialog(id, a, refresh) {
    const { body, close } = createModalShell({ id: 'oat-dialog', title: t('Long-lived token — {name}', { name: a?.name || '' }), minWidth: '460px', escapeToClose: true });
    const status = a?.oat
      ? (a.oatDaysLeft <= 0
        ? `<div class="usage-warn">${t('The stored token has EXPIRED — sessions using it fail until you paste a fresh one.')}</div>`
        : `<div class="usage-note">${t('Active — renews in {n} days.', { n: a.oatDaysLeft })}</div>`)
      : '';
    body.innerHTML = `
      <div class="usage-note">${t('A long-lived token (Anthropic’s official `claude setup-token`, the same one the Claude Code GitHub Action uses) lets this subscription run on remote machines and paired devices WITHOUT shipping its interactive login: it lasts 1 year and never rotates, so nothing can get out of sync. This is the intended way to run your own subscription on your own remote/CI machines — safer than shipping the login. It still bills YOUR subscription and is tied to it, so treat it like the account itself; Anthropic recommends an API key instead when a credential is shared broadly across many contexts. Limits: quota refresh (⟳) does not work through it, and when it expires sessions fail until you re-mint.')}</div>
      ${status}
      <div class="oat-steps">
        <div>1. ${t('Run the mint command in a terminal, then complete the sign-in it opens in your browser.')}</div>
        <div class="usage-warn">${t('The BROWSER account you sign in with decides which account the token bills — sign in as “{name}”.', { name: escHtml(a?.name || '') })}</div>
        <div>2. ${t('Copy the sk-ant-oat01-… value it prints and paste it below.')}</div>
      </div>
      <div class="oat-row"><button class="btn-create" id="oat-run">${t('Open a terminal with `claude setup-token`')}</button></div>
      <div class="oat-row"><input type="text" id="oat-paste" class="settings-input-text" placeholder="sk-ant-oat01-…" spellcheck="false" autocomplete="off" style="width:100%"></div>
      <div class="dialog-buttons">
        ${a?.oat ? `<button class="btn-create danger" id="oat-remove">${t('Remove token')}</button>` : ''}
        <button class="btn-create" id="oat-save">${t('Save token')}</button>
      </div>`;
    body.querySelector('#oat-run').onclick = () => {
      // LOCAL helper terminal — setup-token only needs a browser for the
      // consent; local creds do not decide the account. CLOSE the dialog
      // FIRST: modal overlays sit at z≈99998 while windows live at z≈9000,
      // so the terminal would open blurred and unclickable behind it
      // (adversarial-review must-fix).
      close();
      this.openShellTerminal(undefined, { initialCommand: 'claude setup-token' });
      showToast(t('Complete the sign-in in your browser, copy the sk-ant-oat01-… value, then reopen ⋯ → Long-lived token to paste it.'), { duration: 9000 });
    };
    body.querySelector('#oat-save').onclick = async () => {
      const tok = body.querySelector('#oat-paste').value.trim();
      if (!tok) { showToast(t('Paste the sk-ant-oat01-… token first'), { type: 'error' }); return; }
      try {
        const r = await fetchJson(`/api/accounts/${encodeURIComponent(id)}/oat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok }) });
        if (!r?.success) { showToast(r?.error || t('Save failed'), { type: 'error' }); return; }
        showToast(t('Long-lived token stored — “{name}” is now usable on any machine.', { name: a?.name || '' }));
        close(); refresh?.();
      } catch (e) { showToast(e?.message || t('Save failed'), { type: 'error' }); }
    };
    const rm = body.querySelector('#oat-remove');
    if (rm) rm.onclick = async () => {
      if (!(await showConfirmDialog({ title: t('Remove token'), message: t('Remove the long-lived token from “{name}”? Machines relying on it lose access at their next spawn (running sessions keep working).', { name: a?.name || '' }) }))) return;
      const r = await fetchJson(`/api/accounts/${encodeURIComponent(id)}/oat`, { method: 'DELETE' });
      if (!r?.success) { showToast(r?.error || t('Remove failed'), { type: 'error' }); return; }
      showToast(t('Removed')); close(); refresh?.();
    };
  },


  // Re-login an EXISTING subscription on THIS machine (2.332.0, real ask —
  // until now the only path was remove + re-add, which loses pool membership
  // and identity continuity): same env-scoped helper terminal as the Add
  // flow, pointed at the account's own creds dir. Success is judged by the
  // helper's ATTEMPT id (a fresh run mints a new one), so re-logging a
  // still-logged-in account never reports success before the user actually
  // completes the browser flow.
  async _reloginSubscription(id, a, refresh) {
    let r;
    try { r = await fetchJson(`/api/accounts/${encodeURIComponent(id)}/relogin`, { method: 'POST' }); }
    catch { showToast(t('Could not start — server unreachable'), { type: 'error' }); return; }
    if (!r?.loginCmd) { showToast(r?.error || t('Could not start'), { type: 'error' }); return; }
    const baseline = r.baselineAttempt || null;
    this.openShellTerminal(undefined, { initialCommand: r.loginCmd });
    showToast(t('A terminal opened — sign in as “{name}”. Only this account’s login is refreshed; every other login is untouched.', { name: a?.name || '' }), { duration: 6000 });
    let tries = 0;
    const iv = setInterval(async () => {
      if (++tries > 100) {
        clearInterval(iv);
        showToast(t('Stopped watching for the login after 5 min. If you completed it, press Re-check in Manage agents to finish capturing it.'), { type: 'error', duration: 10000 });
        return;
      }
      try {
        const fin = await fetchJson(`/api/accounts/${encodeURIComponent(id)}/relogin-finalize`, { method: 'POST' });
        const freshAttempt = fin?.loginAttempt && fin.loginAttempt !== baseline;
        if (fin?.outcome === 'same' && (freshAttempt || !baseline)) {
          clearInterval(iv);
          showToast(t('✓ “{name}” signed in again', { name: fin.account?.name || a?.name || '' }), { duration: 6000 });
          refresh?.();
        } else if (fin?.outcome === 'split') {
          // identity guard (owner directive): wrong account ⇒ NEW entry, the
          // original record stays signed-out and keeps its history
          clearInterval(iv);
          showToast(t('The login belongs to a DIFFERENT account ({email}) — saved as the new entry “{new}”. “{name}” stays signed out.', { email: fin.freshEmail || '?', new: fin.account?.name || '', name: fin.keptName || a?.name || '' }), { duration: 10000 });
          refresh?.();
        } else if (fin?.outcome === 'moved') {
          clearInterval(iv);
          showToast(t('The login belongs to “{other}” ({email}) — its login was refreshed there instead. “{name}” stays signed out.', { other: fin.movedTo?.name || '', email: fin.freshEmail || '?', name: fin.keptName || a?.name || '' }), { duration: 10000 });
          refresh?.();
        } else if (freshAttempt && fin?.loginState === 'error') {
          clearInterval(iv);
          showToast(t('Subscription login could not be saved. Check the login terminal for details, then try again.'), { type: 'error', duration: 8000 });
        }
      } catch { /* keep polling */ }
    }, 3000);
  },

  // Add a subscription record and go STRAIGHT to minting its long-lived token
  // (B-211a #2, user request 'why can oat only be added to an existing
  // account'): no local login step — the setup-token browser flow decides the
  // account, usable on any machine once pasted. Creates the record, opens
  // _oatDialog on it, and deletes the throwaway if the user cancels with no
  // token AND no login (a dead record otherwise).
  async _addSubscriptionViaOat() {
    const name = await showInputDialog({ title: t('Add via long-lived token'), label: t('Name this subscription (e.g. Work Max, Personal Max)'), placeholder: t('e.g. Work Max'), confirmText: t('Continue') });
    if (name === null) return;
    let created;
    try { created = await fetchJson('/api/accounts/subscription', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: (name || '').trim() }) }); }
    catch { showToast(t('Could not start — server unreachable'), { type: 'error' }); return; }
    if (!created?.id) { showToast(created?.error || t('Could not start'), { type: 'error' }); return; }
    const refresh = () => { this._agentsRefreshHook?.(); };
    refresh();
    this._oatDialog(created.id, { name: (name || '').trim() || 'Subscription' }, async () => {
      refresh();
      try {
        const list = await fetchJson('/api/accounts');
        const a = (list?.accounts || []).find((x) => x.id === created.id);
        if (a && !a.loggedIn && !a.oat) { await fetchJson(`/api/accounts/${encodeURIComponent(created.id)}`, { method: 'DELETE' }); refresh(); }
      } catch {}
    });
  },

  // ── Pooled pseudo-account: re-point + cold restart (B-6217 v1) ──────────
  // Re-pointing moves the symlink IMMEDIATELY, and a running claude re-reads
  // the credential file mid-session (mtime-gated) — so any conversation on the
  // pool would silently start billing the NEW account without a restart. v1
  // semantics are COLD: the switch restarts every affected conversation (same
  // kill→exited→resume machinery as the billing switcher). Not optional.
  async _poolSwitchTarget(poolId, subId, poolName, hot) {
    let r;
    try { r = await fetchJson('/api/accounts/pool/' + encodeURIComponent(poolId) + '/target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: subId }) }); }
    catch (e) { showToast(e?.message || t('Switch failed'), { type: 'error' }); return; }
    if (!r?.success) { showToast(r?.error || t('Switch failed'), { type: 'error' }); return; }
    const affected = r.affected || [];
    // hot = re-point only: the running CLI re-reads the credential file on its
    // next request, so the conversations continue uninterrupted on the new
    // account. Cold (default) restarts them for clean per-process attribution.
    const restart = !hot && affected.length;
    showToast(t('“{name}” now uses {target}', { name: poolName, target: r.name }) + (restart ? ' — ' + t('restarting {n} conversation(s)…', { n: affected.length }) : ''), { duration: 6000 });
    if (restart) for (const sess of affected) this._poolColdRestart(sess, poolId);
  },
  // ── Pool ⋯ menu: ONE block for every backend (2.369.18 — the codex roster
  // had no pool menu at all, and a copy of the claude block would be the
  // whitelist-drift twin class). Wording rides a.backend; the hot toggle
  // rides the SERVER's capability verdict (list() → a.hotSupported, from
  // src/backend-caps.js): a codex pool is cold by structure (the app-server
  // holds tokens in memory — P3 experiment), so the row SAYS so instead of
  // offering a switch the engine ignores.
  _poolMenuItems(id, a, refresh) {
    const codex = a.backend === 'codex';
    const members = a.memberOptions || [];
    const hotOk = a.hotSupported !== false;
    const effHot = hotOk && !!a.hot;
    const patchPool = async (body) => {
      try { await api('/api/accounts/pool/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
      catch (e) { showToast(e?.message || t('Update failed'), { type: 'error' }); }
    };
    const items = [
      { label: t('Switch target'), children: members.length ? members.map((m) => ({
        label: (m.id === a.current ? '✓ ' : '') + m.name,
        disabled: m.id === a.current,
        action: () => this._poolSwitchTarget(id, m.id, a.name, effHot),
      })) : [{ label: codex ? t('no logged-in ChatGPT accounts') : t('no logged-in subscriptions'), disabled: true, action: () => {} }] },
      { label: t('Members…'), action: () => this._poolMembersDialog(id, a, refresh) },
      { label: (a.auto ? '✓ ' : '') + t('Auto-switch when nearly exhausted'), action: () => patchPool({ auto: !a.auto }) },
    ];
    if (hotOk) items.push({ label: (a.hot ? '✓ ' : '') + t('Hot switch (no restart)'), action: () => patchPool({ hot: !a.hot }) });
    else items.push({ label: t('Hot switch unavailable — every switch restarts the session'), disabled: true, action: () => {}, title: t('The Codex app-server keeps its login in memory, so a re-pointed login never reaches a running session (verified) — switches restart the conversation via resume.') });
    return items;
  },
  // "+ Add pooled account…" — ONE dialog for both rosters, wording per backend.
  // api() (not fetchJson): a 400 from createPool ("no logged-in … to pool")
  // used to toast "Pooled account created" and create nothing.
  async _createPoolDialog(backend, refresh) {
    const codex = backend === 'codex';
    const name = await showInputDialog({
      title: t('Pooled account'),
      label: codex
        ? t('One account entry that internally switches between your logged-in ChatGPT accounts. Sessions pick it like any account; you (or auto-switching) choose which real account it currently uses — every switch restarts the session (Codex cannot switch hot).')
        : t('One account entry that internally switches between your logged-in subscriptions. Sessions pick it like any account; you (or later, auto-switching) choose which real subscription it currently uses.'),
      value: t('Pool'), confirmText: t('Create'),
    });
    if (name == null) return;
    try { await api('/api/accounts/pool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(codex ? { name, backend: 'codex' } : { name }) }); showToast(t('Pooled account created')); }
    catch (e) { showToast(e?.message || t('Create failed'), { type: 'error' }); }
    refresh?.();
  },
  _poolColdRestart(sess, poolId) {
    if (!sess.backendSessionId) return; // nothing to resume by — leave it be
    try { window.__vsOp?.('pool-cold-restart', { pool: poolId, sid: sess.backendSessionId, serverId: sess.serverId, host: sess.host || null }); } catch {}
    const live = (this.sidebar?._allSessions || []).find((x) => x.webuiId === sess.serverId);
    const name = this.sidebar?.getCustomName?.({ backend: sess.backend, backendSessionId: sess.backendSessionId }) || live?.name || sess.name || '';
    const mode = live?.webuiMode || 'chat';
    const finish = () => this.resumeSession(sess.backendSessionId, sess.cwd || live?.cwd || '', name, { mode, backend: sess.backend, backendSessionId: sess.backendSessionId, accountId: poolId, hostId: sess.host || undefined, excludeWebuiId: sess.serverId });
    let done = false;
    const go = () => { if (done) return; done = true; this.ws.offGlobal(onExit); finish(); };
    const onExit = (msg) => { if (msg.type === 'exited' && msg.sessionId === sess.serverId) setTimeout(go, 400); }; // let the CLI flush its transcript
    this.ws.onGlobal(onExit);
    this.killSession(sess.serverId, sess.backendSessionId);
    setTimeout(go, 15000); // a lost exited must not strand the restart
  },
  // Pool MEMBERS dialog (user request): choose which subscriptions the pool
  // switches over. "All" = members:null in the store — a DYNAMIC default that
  // includes subscriptions added LATER (the user's 全选 semantics), not a
  // snapshot of today's list. Explicit selection = a narrowed fixed set;
  // narrowing away the current target re-points server-side (updatePool).
  async _poolMembersDialog(poolId, a, refresh) {
    let list;
    try { list = await fetchJson('/api/accounts'); } catch { showToast(t('Could not load accounts'), { type: 'error' }); return; }
    // Members are the pool's OWN backend's logins (a codex pool switches
    // among ChatGPT accounts — 2.369.18; the dialog was claude-only)
    const be = a?.backend || 'claude';
    const codex = be === 'codex';
    const effHot = a?.hotSupported !== false && !!a?.hot;
    const subs = (list?.accounts || []).filter((x) => x.type === 'subscription' && (x.backend || 'claude') === be && !x.pooled);
    const { body, close } = createModalShell({ id: 'pool-members-dialog', title: t('Pool members — {name}', { name: a?.name || '' }), minWidth: '420px', escapeToClose: true });
    const explicit = Array.isArray(a?.members) && a.members.length ? a.members : null;
    body.innerHTML = `
      <div class="usage-note">${escHtml(codex ? t('The pool switches between these ChatGPT accounts. Not-signed-in accounts are skipped until they log in.') : t('The pool switches between these subscriptions. Not-signed-in accounts are skipped until they log in.'))}</div>
      <label class="pool-mem-row pool-mem-all"><input type="checkbox" id="pool-mem-all" ${explicit ? '' : 'checked'}>
        <span><b>${escHtml(codex ? t('All ChatGPT accounts') : t('All subscriptions'))}</b><br><span class="pool-mem-sub">${escHtml(t('including accounts you add in the future'))}</span></span></label>
      <div class="pool-mem-list">${subs.map((x) => `
        <label class="pool-mem-row"><input type="checkbox" class="pool-mem-cb" data-id="${escHtml(x.id)}" ${explicit ? (explicit.includes(x.id) ? 'checked' : '') : 'checked'} ${explicit ? '' : 'disabled'}>
          <span>${escHtml(x.name)}${x.email ? ` <span class="pool-mem-sub">${escHtml(x.email)}</span>` : ''}${x.loggedIn ? '' : ` <span class="pool-mem-sub">· ${escHtml(t('not signed in'))}</span>`}</span></label>`).join('')}
        ${subs.length ? '' : `<div class="empty-hint">${escHtml(t('No subscription accounts yet'))}</div>`}</div>
      <div class="dialog-buttons"><button class="btn-create" id="pool-mem-save">${escHtml(t('Save'))}</button></div>`;
    const allCb = body.querySelector('#pool-mem-all');
    const cbs = [...body.querySelectorAll('.pool-mem-cb')];
    allCb.onchange = () => { for (const cb of cbs) { cb.disabled = allCb.checked; if (allCb.checked) cb.checked = true; } };
    body.querySelector('#pool-mem-save').onclick = async () => {
      // empty explicit selection would silently mean ALL in the store
      // (updatePool maps [] → null) — refuse instead of surprising
      const members = allCb.checked ? null : cbs.filter((cb) => cb.checked).map((cb) => cb.dataset.id);
      if (members && !members.length) { showToast(t('Pick at least one member (or choose All)'), { type: 'error' }); return; }
      // review B2: a selection with ZERO signed-in members can never take over
      // — the pool would keep billing the current (now non-member) target
      // while the row still shows it, with nothing telling the user why
      if (members && !members.some((mid) => subs.find((x) => x.id === mid)?.loggedIn)) {
        showToast(t('None of the selected members is signed in — the pool would keep billing its current (non-member) target. Sign one in first.'), { type: 'error', duration: 8000 }); return;
      }
      let r;
      try {
        r = await fetchJson('/api/accounts/pool/' + encodeURIComponent(poolId), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ members }) });
        if (r?.error) { showToast(r.error, { type: 'error' }); return; }
      } catch (e) { showToast(e?.message || t('Update failed'), { type: 'error' }); return; }
      close(); refresh?.();
      showToast(members ? t('Pool members updated ({n} selected)', { n: members.length }) : codex ? t('Pool set to all ChatGPT accounts (incl. future ones)') : t('Pool set to all subscriptions (incl. future ones)'));
      // Narrowing away the current target re-points the pool IMMEDIATELY —
      // same consequences as an explicit target switch (review B1): tell the
      // user, and cold-restart affected conversations unless the pool is hot
      // (effHot: a codex pool's `hot` flag is inert — always restart).
      if (r?.retargeted) {
        showToast(t('“{name}” now uses {target}', { name: a?.name || '', target: r.retargeted.name || '?' }) + ((!effHot && r.affected?.length) ? ' — ' + t('restarting {n} conversation(s)…', { n: r.affected.length }) : ''), { duration: 6000 });
        if (!effHot) for (const sess of (r.affected || [])) this._poolColdRestart(sess, poolId);
      }
    };
  },

  _watchHostLogin(hostId, hostLabel, accountId = null, loginAttempt = null) {
    if (!hostId) return;
    if (this._hostLoginWatch) { clearInterval(this._hostLoginWatch); this._hostLoginWatch = null; }
    const sig = (r) => (r && !r.error)
      ? [r.credsMtime || 0, r.codexAuthMtime || 0, r.subscription?.loggedIn ? 1 : 0, r.subscription?.email || '', r.codex?.email || '', (r.hostSubs || []).join('+')].join('|')
      : null;
    // Baseline = the FIRST SUCCESSFUL poll (t≈6s), never a pre-click fetch:
    // (a) a transient probe failure at t0 must not make the first good poll
    // of the UNCHANGED login read as "updated" (review-confirmed); (b) the
    // login terminal's claude may refresh its own token at startup, bumping
    // credsMtime seconds in — baselining after that absorbs it, while a real
    // OAuth login takes ≥15-30s and still lands after the baseline.
    let baseSig = null;
    let tries = 0;
    const complete = (machineLoginChanged) => {
      clearInterval(this._hostLoginWatch); this._hostLoginWatch = null;
      if (machineLoginChanged) (this._hostLoginSeenAt ||= {})[hostId] = Date.now();
      showToast(t('✓ Login on {host} updated', { host: hostLabel }), { duration: 5000 });
      // Refresh the open Agents surface in place, else reopen it (the wizard
      // pattern). Since 2.245.0 the surface stacks EVERY machine's section, so
      // there's no machine selection to force — a plain refresh shows it.
      if (!this._agentsRefreshHook?.()) this._showAgentsDialog();
    };
    this._hostLoginWatch = setInterval(async () => {
      // Silent give-up is the failure mode here (the user was told VibeSpace
      // notices the login by itself): an on-host sign-in that lands after
      // ~5 min never refreshed the surface and nothing said the watch ended.
      if (++tries > 50) {
        clearInterval(this._hostLoginWatch); this._hostLoginWatch = null;
        showToast(t('Stopped watching {host} for the login after 5 min. If you finished signing in there, press Re-check to pick it up.', { host: hostLabel }), { type: 'error', duration: 10000 });
        this._agentsRefreshHook?.(); // one last repaint in case it did land
        return;
      }
      let cur = null;
      try { cur = await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}/accounts-status`); } catch { return; }
      if (accountId && loginAttempt) {
        const loginStatus = cur?.hostSubLoginStatus?.[accountId];
        // A named-account helper owns its exact completion signal (PR #23).
        // Never let another account/global refresh satisfy this watcher, and
        // do not lose a fast login that completed before the first poll.
        if (!loginStatus || loginStatus.attempt !== loginAttempt || loginStatus.state === 'running') return;
        if (loginStatus.state === 'error') {
          clearInterval(this._hostLoginWatch); this._hostLoginWatch = null;
          showToast(t('Subscription login could not be saved. Check the login terminal for details, then try again.'), { type: 'error', duration: 8000 });
          return;
        }
        if (loginStatus.state === 'success') complete(false);
        return;
      }
      const s = sig(cur);
      if (s === null) return;
      if (baseSig === null) { baseSig = s; return; }
      if (s === baseSig) return;
      // Stamp for the roster's identity-freshness note — ONLY when the
      // MACHINE login itself changed (a per-account host login landing is
      // the last sig field; it must not arm the CLI-login row's amber
      // "login changed" note). Local clocks only — remote mtimes rotate on
      // normal token refresh and skew.
      const machinePart = (x) => x.split('|').slice(0, 5).join('|');
      complete(machinePart(s) !== machinePart(baseSig));
    }, 6000);
  },

  // ── Codex/OpenAI accounts roster (rendered UNDER Codex in Manage Agents).
  // Same unified model as the Anthropic roster: the peer "CLI login" row is
  // the SELECTED machine's own codex login; the named ChatGPT accounts below
  // are stored by VibeSpace (machine-independent, ship per session). No usage
  // bars (OpenAI quota isn't polled).
  // Compact per-account usage readout (mini donuts, same visual language as
  // the taskbar quota pies) shared by the Claude and Codex rosters. Data:
  // Claude = the passive statusline cache; Codex = the per-account rate-limit
  // buckets (both ride /api/usage). Scoped weekly buckets (e.g. Fable) get
  // their own donut when present.
  _acctUsageHtml(u, est) {
    if (!u) return '';
    const pct = (x) => Math.min(100, Math.round(x?.usedPercent ?? ((x?.utilization || 0) * 100)));
    // Reset countdown (2.268.7, user request — THIS surface, not the popup).
    // resetsAt is unix SECONDS in the usage cache; tolerate ms just in case.
    const resetMs = (x) => { const r = x?.resetsAt; if (!Number.isFinite(r) || r <= 0) return null; return r > 1e12 ? r : r * 1000; };
    const fmtEta = (ms) => {
      const sec = Math.max(0, Math.round((ms - Date.now()) / 1000));
      const dd = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), mm = Math.floor((sec % 3600) / 60);
      return dd ? `${dd}d${hh}h` : hh ? `${hh}h${mm}m` : `${mm}m`;
    };
    const etaTip = (x) => { const ms = resetMs(x); return ms && ms > Date.now() + 45000 ? ' · ' + t('resets in {dur}', { dur: fmtEta(ms) }) : ''; };
    // With a dead-reckoning estimate (B-fcff v2): DARK arc = confirmed reading,
    // LIGHT arc = estimated delta since; after a window reset (est < reading —
    // the clean discriminator) the reading no longer applies, dark collapses to
    // 0 and the whole arc renders light. Dashed ring marks "estimating".
    const donut = (label, x, tipName, estBucket) => {
      const pair = estDisplayPair(x, estBucket);
      const p = pair.estPct != null ? pair.darkPct : pct(x);
      const eff = pair.estPct ?? p;
      const c = eff > 95 ? 'var(--red,#e55)' : eff > 80 ? 'var(--yellow,#e5c07b)' : 'var(--green,#3fb950)';
      const light = `color-mix(in srgb, ${c} 38%, var(--bg-input))`;
      const bg = pair.estPct != null && pair.estPct > pair.darkPct
        ? `conic-gradient(${c} ${Math.round(p * 3.6)}deg, ${light} ${Math.round(p * 3.6)}deg ${Math.round(pair.estPct * 3.6)}deg, var(--bg-input) ${Math.round(pair.estPct * 3.6)}deg)`
        : `conic-gradient(${c} ${Math.round(p * 3.6)}deg, var(--bg-input) ${Math.round(p * 3.6)}deg)`;
      const tip = (pair.estPct != null
        ? `${escHtml(tipName || label)}: ${p}% · ${escHtml(t('est {pct}%', { pct: pair.estPct }))}${pair.rolled ? ' · ' + escHtml(t('window reset since last reading')) : ''}`
        : `${escHtml(tipName || label)}: ${p}%`) + escHtml(etaTip(x));
      return `<span class="acct-usage-donut${pair.estPct != null ? ' acct-donut-est' : ''}" title="${tip}" style="background:${bg}"><span>${escHtml(label)}</span></span>`;
    };
    const parts = [donut('5h', u.fiveHour, null, est?.fiveHour), donut('7d', u.sevenDay, null, est?.sevenDay)];
    const scEst = (name) => (est?.scopedWeekly || []).find((x) => String(x?.name || '').toLowerCase() === String(name || '').toLowerCase()) || null;
    for (const sc of (u.scopedWeekly || [])) parts.push(donut(String(sc.name || '?').slice(0, 2), sc, sc.name, scEst(sc.name)));
    const age = u.fetchedAt ? Math.round((Date.now() - u.fetchedAt) / 60000) : null;
    // The age span ALWAYS renders (empty when fresh) at a fixed min-width —
    // conditional rendering shifted the right-aligned donut group per row and
    // broke the column alignment across the roster (measured: 28px jump).
    const ageLabel = age != null && age > 5 ? (age < 100 ? t('{n}m', { n: age }) : t('{n}h', { n: Math.round(age / 60) })) : '';
    // Narrow-width companion (rail panel, 2.179.1): the donut cluster is
    // ~100px and doesn't shrink — below ~340px a container query swaps it for
    // ONE pill showing the TIGHTEST bucket (full detail in the tooltip).
    const buckets = [['5h', u.fiveHour, est?.fiveHour], ['7d', u.sevenDay, est?.sevenDay], ...(u.scopedWeekly || []).map((sc) => [String(sc.name || '?').slice(0, 2), sc, scEst(sc.name)])]
      .map(([label, x, e]) => { const pr = estDisplayPair(x, e); return [label, pr.estPct ?? pct(x), pr.estPct != null, resetMs(x)]; }).filter(([, p]) => Number.isFinite(p));
    // Second line of the age cell: reset countdown for the row's most-
    // constrained bucket (est-aware, same pick as the narrow-width pill),
    // colored by that bucket's pressure — "when does the tight bucket free
    // up". Buckets whose reset already passed are effectively fresh; skip.
    let eta = '', etaTitle = '';
    const etaCands = buckets.filter(([, , , r]) => r && r > Date.now() + 45000);
    if (etaCands.length) {
      const [el2, ep, , er] = etaCands.reduce((a, b) => (b[1] > a[1] ? b : a));
      const ec = ep > 95 ? 'var(--red,#e55)' : ep > 80 ? 'var(--yellow,#e5c07b)' : 'var(--green,#3fb950)';
      eta = `<span class="acct-reset-eta" style="color:${ec}">${escHtml(fmtEta(er))}</span>`;
      etaTitle = `${el2} ${t('resets in {dur}', { dur: fmtEta(er) })}`;
    }
    let mini = '';
    if (buckets.length) {
      const [wl, wp, wEst] = buckets.reduce((a, b) => (b[1] > a[1] ? b : a));
      const wc = wp > 95 ? 'var(--red,#e55)' : wp > 80 ? 'var(--yellow,#e5c07b)' : 'var(--green,#3fb950)';
      const tip = [buckets.map(([l, p, isE]) => `${l} ${isE ? t('est {pct}%', { pct: p }) : p + '%'}`).join(' · '), etaTitle].filter(Boolean).join(' · ');
      mini = `<span class="acct-usage-mini${wEst ? ' acct-mini-est' : ''}" style="color:${wc}" title="${escHtml(tip)}">${escHtml(wl)} ${wp}%</span>`;
    }
    const ageTitle = [age != null ? t('Last refreshed {n} min ago', { n: age }) : '', etaTitle].filter(Boolean).join(' · ');
    return `<span class="acct-usage">${parts.join('')}<span class="acct-usage-age" title="${escHtml(ageTitle)}"><span>${ageLabel}</span>${eta}</span></span>${mini}`;
  },

  // ── ⟳ Refresh all (2.245.0): ONE human click fans out a per-target
  // on-demand quota refresh across every signed-in identity the machine
  // overview shows — local subscriptions, each host's machine login, and
  // host-HELD account logins. §ban-safety: strictly click-initiated (never a
  // timer), and the Anthropic calls are STAGGERED ~1.5s apart — the usage
  // endpoint hard-429s on bursts (~5 rapid requests, CLAUDE.md §9), so a
  // simultaneous volley of N identities from one IP risks tripping the shared
  // backoff. Rows still update independently as each answer lands; failures
  // render inline on their row (静默失败零容忍 — never silent).
  async _refreshAllQuota(btn, bodyEl) {
    if ((this.settings.get('accounts.onDemandQuotaRefresh') || 'manual') === 'off') {
      showToast(t('On-demand quota refresh is disabled in Settings'), { type: 'error' });
      return;
    }
    // Same one-time explainer + ack key as the usage popup's ⟳.
    let acked = false;
    try { acked = localStorage.getItem('vibespace.quotaRefreshAck') === '1'; } catch {}
    if (!acked) {
      const ok = await showConfirmDialog({
        title: t('Fetch quota from Anthropic?'),
        message: t('This makes ONE non-billable request to Anthropic’s usage endpoint per signed-in account/machine, each with that identity’s own login token — the same call the CLI makes when you run /usage. It only ever fires when you click (never on a timer) and is throttled to ≥60s per target. This notice is shown once.'),
        confirmText: t('Fetch'),
      });
      if (!ok) return;
      try { localStorage.setItem('vibespace.quotaRefreshAck', '1'); } catch {}
    }
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('usage-refresh-spin');
    try {
      // Wait out the section fills so every host's verdicts (held accounts)
      // are known before the target list is built.
      try { await this._agentsFill; } catch {}
      const targets = []; // rows addressed by (section data-host, row data-id)
      const accts = this._accounts?.accounts || [];
      const gl = this._usageGlobal || this._usageGlobalIdent || {};
      const claudeSubs = accts.filter(a => (a.backend || 'claude') !== 'codex' && a.type === 'subscription');
      // Local CLI login (unless it IS a named account — that account's own
      // refresh covers the shared quota via the server-side merge).
      if ((gl.loggedIn || gl.email) && !gl.accountId) targets.push({ host: '', id: '__global__', body: { account: '__global__' } });
      for (const a of claudeSubs) if (a.loggedIn) targets.push({ host: '', id: a.id, body: { account: a.id } });
      for (const h of this._agentsHostsList || []) {
        targets.push({ host: h.id, id: '__global__', body: { host: h.id } });
        for (const [aid, v] of Object.entries(this._hostVerdicts?.[h.id] || {})) {
          if (v?.usable && v.how === 'host-held') targets.push({ host: h.id, id: aid, body: { host: h.id, account: aid } });
        }
      }
      const rowOf = (tg) => bodyEl.querySelector(`.agents-machine-sec[data-host="${tg.host}"] .acct-key-row[data-id="${tg.id}"]`);
      // Failures for targets with NO rendered row (Accounts tab has no machine
      // sections at all; a COLLAPSED accordion's section holds no rows) used to
      // be dropped entirely — the Anthropic call was made, the click "worked",
      // and the user saw zero evidence anything failed.
      const unreported = [];
      const labelOf = (tg) => {
        const hostName = tg.host ? ((this._agentsHostsList || []).find(h => h.id === tg.host)?.name || tg.host) : t('this machine');
        if (tg.id === '__global__') return hostName;
        const an = (this._accounts?.accounts || []).find(a => a.id === tg.id)?.name || tg.id;
        return tg.host ? `${an} @ ${hostName}` : an;
      };
      const one = async (tg) => {
        let r = null;
        try {
          r = await fetchJson('/api/usage/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tg.body) });
        } catch {}
        const msgOf = () => (r?.error ? String(r.error)
          : r?.throttled ? t('Refreshed less than a minute ago — try again shortly')
          : !r ? t('Refresh failed') : null);
        const row = rowOf(tg);
        if (!row || !row.isConnected) { // no row to write on — collect for the summary
          const m = msgOf();
          if (m) unreported.push(`${labelOf(tg)}: ${m}`);
          return;
        }
        row.querySelector('.acct-refresh-err')?.remove();
        const msg = msgOf();
        if (msg) {
          const err = document.createElement('span');
          err.className = 'acct-refresh-err usage-warn';
          err.textContent = '⚠ ' + msg;
          err.title = msg;
          (row.querySelector('.acct-key-main') || row).appendChild(err);
          return;
        }
        // Success → repaint just this row's usage cell from fresh data (a
        // full refresh() here would wipe the other rows' inline errors).
        const u0 = await fetchJson('/api/usage');
        if (u0) this._applyUsage(u0);
        const cell = row.querySelector('.acct-usage-cell');
        if (!cell) return;
        let u = null, est = null;
        if (tg.body.host && tg.body.account) u = this._hostAccountUsage?.[tg.body.host + ':' + tg.body.account];
        else if (tg.body.host) u = this._hostOwnUsage?.[tg.body.host]?.fiveHour ? this._hostOwnUsage[tg.body.host] : null;
        else if (tg.body.account === '__global__') { u = this._rateLimit; est = this._usageEstimates?.__global__; }
        else { u = this._accountUsage?.[tg.body.account]; est = this._usageEstimates?.[tg.body.account]; }
        if (u) cell.innerHTML = this._acctUsageHtml(u, est);
      };
      if (!targets.length) { showToast(t('Nothing to refresh — no signed-in accounts or machines'), { type: 'error' }); return; }
      const jobs = targets.map((tg, i) => (async () => {
        await new Promise((r) => setTimeout(r, i * 1500)); // stagger starts
        await one(tg);
      })());
      await Promise.allSettled(jobs);
      if (unreported.length) {
        showToast(t('Quota refresh failed for {n} target(s): {details}', { n: unreported.length, details: unreported.slice(0, 4).join(' · ') + (unreported.length > 4 ? ' …' : '') }), { type: 'error', duration: 10000 });
      }
    } finally {
      btn.disabled = false;
      btn.classList.remove('usage-refresh-spin');
    }
  },

  async _renderCodexAccounts(ctx) {
    const { body, selectedHost, done, run, refresh, st } = ctx;
    let accts;
    try { accts = await this.refreshAccounts(); } catch { return; }
    const codexAccts = (accts.accounts || []).filter(a => a.backend === 'codex')
      .sort(rosterSort); // type-order parity with the claude roster: pool → ChatGPT login
    // st is already machine-scoped: /api/hosts/<id>/backend-status on a host.
    const gLoggedIn = !!(st?.codex?.loggedIn);
    const hostLabel = selectedHost ? (ctx.hostLabel || t('remote host')) : null;
    const { CROWN, GLOBE, POOL, STAR_F, STAR_O, DOTS } = ROSTER_ICONS;
    const row = document.createElement('div'); row.className = 'ob-backend acct-section acct-roster';
    const left = document.createElement('div'); left.style.flex = '1';
    const gDef = !accts.defaultCodexAccountId;
    const usageHtml = (u) => this._acctUsageHtml(u);
    const cgl = !selectedHost ? (this._usageCodexGlobal || {}) : {};
    const gName = selectedHost ? t('CLI login on {host}', { host: escHtml(hostLabel) }) : t('CLI login');
    // Host codex identity from its auth.json JWT (probed once in refresh —
    // the JWT email can't go stale relative to the token itself, 2.188.0)
    const rcx = selectedHost ? ctx.racct?.codex : null;
    let gIdent = gLoggedIn
      ? (selectedHost
          ? `${rcx?.email ? escHtml(rcx.email + (rcx.plan ? ' · ' + rcx.plan : '')) + ' · ' : ''}<span class="ob-ok">${t('logged in')}</span>`
          : (escHtml(cgl.email || '') || t('logged in')))
      : (selectedHost && (!ctx.racct || ctx.racct.error))
        ? `<span class="ob-warn">${t('unreachable')}</span>`
        : `<span class="ob-warn">${t('not logged in')}</span>`;
    // The machine's codex login may BE one of the named ChatGPT accounts (same
    // email) — say so; their quota buckets are then merged newest-wins.
    const linkedCx = !selectedHost && gLoggedIn && cgl.accountId ? codexAccts.find(a => a.id === cgl.accountId) : null;
    if (linkedCx) gIdent += ` <span class="acct-linked-hint" title="${escHtml(t('The machine login and this VibeSpace account are the same ChatGPT account — usage is shown merged'))}">${t('= “{name}”', { name: escHtml(linkedCx.name) })}</span>`;
    // Host actions live in a ⋯ menu (2.245.2 — same [★][⋯] actions width on
    // every row keeps the right-anchored donut column aligned; see the
    // Anthropic roster's note).
    const gExtraActions = selectedHost
      ? `<button class="acct-icon acct-menu" title="${t('More actions')}">${DOTS}</button>` : '';
    const globalRow = `<div class="acct-key-row${gDef ? ' is-default' : ''}" data-id="__codex_global__">
      <span class="acct-type-icon" title="${selectedHost ? t("This machine's own login — lives on {host}, not in VibeSpace", { host: escHtml(hostLabel) }) : t('The CLI’s own global login on this machine')}">${GLOBE}</span>
      <span class="acct-key-main"><span class="acct-key-name">${gName}</span><span class="acct-key-tail">${gIdent}</span></span>
      <span class="acct-usage-cell">${!selectedHost && gLoggedIn ? usageHtml(this._codexAccountUsage?.['__global_codex__']) : ''}</span>
      <span class="acct-key-actions">
        <button class="acct-icon acct-def ${gDef ? 'on' : ''}" title="${gDef ? t('Default for new sessions — pick another to change') : t('Set as default for new sessions')}">${gDef ? STAR_F : STAR_O}</button>${gExtraActions}
      </span></div>`;
    // §ban-safety: a ChatGPT account (isolated CODEX_HOME) can't run on a
    // remote host unless the opt-in is set — same as Claude subscriptions.
    const allowSubRemote = !!this.settings?.get?.('accounts.shipSubscriptionToRemote');
    const subBlocked = !!selectedHost && !allowSubRemote;
    // Same-account link vs the host's own codex login (see the Anthropic
    // roster note) — a linked account is usable on the host via its own login
    // (2.245.0: `ctx.racct` — the bare `racct` here was a latent
    // ReferenceError that silently killed the codex roster on every host
    // view, swallowed by the caller's try/catch)
    const cxHostEmail = selectedHost ? String(ctx.racct?.codex?.email || '').trim().toLowerCase() : '';
    const cxEmailOf = (a) => String(a.email || (String(a.name || '').includes('@') ? a.name : '')).trim().toLowerCase();
    // Host sections list VERDICT-usable accounts only (B-f531) — same rule as
    // the Anthropic roster; the local section stays the full roster.
    const rosterCx = !selectedHost ? codexAccts
      : ctx.racct?.verdicts ? codexAccts.filter(a => ctx.racct.verdicts[a.id]?.usable) : [];
    const keyLines = rosterCx.map(a => {
      const isDef = accts.defaultCodexAccountId === a.id;
      // Pool row (2.369.18): `→ target · email`, the POOL glyph (never the
      // crown — the misread the claude roster fixed), usage = the current
      // TARGET's buckets (that's what the pool bills right now). Pools are
      // local-only by construction (host views never list them: the verdict
      // is pool-local-only), so the ship/link hints don't apply.
      const isPool = !!a.pooled;
      const linked = !isPool && subBlocked && !!cxHostEmail && cxEmailOf(a) === cxHostEmail;
      const blocked = !isPool && subBlocked && !linked;
      let ident = isPool
        ? (a.current ? escHtml('→ ' + (a.currentName || a.current) + (a.email ? ' · ' + a.email : ''))
          : `<span class="ob-warn">${t('no target — pick a ChatGPT account in ⋯')}</span>`)
        : a.loggedIn
        ? escHtml((a.email || '') + (a.subscriptionType ? (a.email ? ' · ' : '') + a.subscriptionType : '')) || t('logged in')
        : `<span class="ob-warn">${t('not logged in')}</span>`;
      const hint = linked
        ? ` <span class="acct-linked-hint" title="${t('Same account as {host}’s current CLI login — sessions on {host} picking it run on the host’s own login directly (nothing is shipped).', { host: escHtml(hostLabel) })}">${t('· = {host}’s own login', { host: escHtml(hostLabel) })}</span>`
        : blocked ? ` <span class="acct-blocked-hint" title="${t('Runs on this machine only. For {host}, log in on the host — or enable Settings → “Ship subscription logins to remote hosts.”', { host: escHtml(hostLabel) })}">${t('· this machine only')}</span>` : '';
      const iconTitle = isPool ? t('Pooled account — one billing identity auto-switching across your ChatGPT accounts') : t('ChatGPT account — runs on this machine (or a host you log into)');
      const usageCell = isPool
        ? (a.current && this._codexAccountUsage?.[a.current] ? this._acctUsageHtml(this._codexAccountUsage[a.current], this._usageEstimates?.[a.current]) : '')
        : a.loggedIn ? usageHtml(this._codexAccountUsage?.[a.id]) : '';
      // Redesign (2.178.0): star + ⋯ menu, same as the Anthropic roster
      return `<div class="acct-key-row${isDef ? ' is-default' : ''}${blocked ? ' acct-row-blocked' : ''}" data-id="${escHtml(a.id)}"${blocked ? ' data-blocked="1"' : ''}>
        <span class="acct-type-icon" title="${iconTitle}">${isPool ? POOL : CROWN}</span>
        <span class="acct-key-main"><span class="acct-key-name">${escHtml(a.name)}</span><span class="acct-key-tail">${ident}${hint}</span></span>
        <span class="acct-usage-cell">${usageCell}</span>
        <span class="acct-key-actions">
          <button class="acct-icon acct-def ${isDef ? 'on' : ''}" title="${isDef ? t('Default for new sessions — click to clear') : t('Set as default for new sessions')}">${isDef ? STAR_F : STAR_O}</button>
          <button class="acct-icon acct-menu" title="${t('More actions')}">${DOTS}</button>
        </span></div>`;
    }).join('');
    const note = selectedHost
      ? (ctx.racct?.verdicts
          ? t('Only accounts usable on {host} are listed — the full roster lives under “This machine”. The “CLI login” row is {host}’s own login.', { host: escHtml(hostLabel) })
          : t('Machine unreachable — account availability unknown. Accounts are managed under “This machine”.'))
      : t('Each Codex session can pick its ChatGPT login (New Session dialog / card ⚙). Held in isolated logins, switchable per session; threads stay shared.');
    left.innerHTML = `<div class="acct-list">${globalRow}${keyLines}</div>
      <div class="agents-note">${note}</div>`;
    const head = document.createElement('div'); head.className = 'acct-roster-head';
    const title = document.createElement('b'); title.textContent = t('ChatGPT / OpenAI accounts');
    const addBtn = document.createElement('button'); addBtn.className = 'agent-btn acct-add' + (codexAccts.length ? '' : ' primary'); addBtn.textContent = '+ ' + t('Add ChatGPT account…');
    addBtn.title = t('Sign in another ChatGPT account — stored in VibeSpace (not on any one machine), switchable per session');
    addBtn.onclick = () => { done(); this._addCodexSubscription(); };
    head.append(title, addBtn);
    // codex pool (P2, cold-switch): same pseudo-account model as claude's —
    // needs ≥1 logged-in ChatGPT subscription to point at
    if (!selectedHost && codexAccts.some((x) => x.type === 'subscription' && x.loggedIn)) {
      const poolBtn = document.createElement('button'); poolBtn.className = 'agent-btn acct-add'; poolBtn.textContent = '+ ' + t('Add pooled account…');
      poolBtn.title = t('One account entry that internally switches between your logged-in ChatGPT accounts. Sessions pick it like any account; you (or auto-switching) choose which real account it currently uses — every switch restarts the session (Codex cannot switch hot).');
      poolBtn.onclick = () => { done(); this._createPoolDialog('codex', () => this._refreshAgents?.()); };
      head.append(poolBtn);
    }
    if (ctx.stale?.()) return; // a newer refresh took over mid-await
    row.append(head, left);
    body.appendChild(row);
    left.onclick = async (e) => {
      const keyRow = e.target.closest?.('.acct-key-row');
      if (!keyRow) return;
      const id = keyRow.dataset.id;
      if (id === '__codex_global__') {
        const doHostLogin = async () => {
          // Runs ON the selected host — lands in ITS ~/.codex, not VibeSpace.
          // --device-auth: a plain `codex login` would open localhost:1455 on
          // the host, unreachable from the user's browser. Confirmed first —
          // this REPLACES the machine's login (same semantics as claude).
          const okGo = await showConfirmDialog({
            title: t('Switch {host}’s own login?', { host: hostLabel }),
            message: t('This opens codex login ON {host} and REPLACES that machine’s current ChatGPT login. VibeSpace’s named accounts are untouched — to add a switchable account instead, use “+ Add ChatGPT account…”.', { host: hostLabel }),
            confirmText: t('Open login terminal'),
          });
          if (!okGo) return;
          this._watchHostLogin(selectedHost, hostLabel);
          run('codex login --device-auth');
        };
        if (e.target.closest('.acct-menu')) {
          const r = e.target.closest('.acct-menu').getBoundingClientRect();
          showContextMenu(r.left, r.bottom + 4, [
            { label: t('Log in on {host}…', { host: hostLabel }), title: t('Opens a terminal ON {host} — this login lands on that machine, not in VibeSpace', { host: hostLabel }), action: doHostLogin },
          ]);
        } else if (e.target.closest('.acct-def')) {
          // fetchJson never throws → the old catch was dead code and a failed
          // write repainted the OLD state as if it had succeeded.
          try { await api('/api/accounts/default', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: null, backend: 'codex' }) }); }
          catch (err) { showToast(t('Could not change the default account — {reason}', { reason: err?.message || t('server unreachable') }), { type: 'error' }); }
          refresh();
        }
        return;
      }
      const a = codexAccts.find(x => x.id === id);
      const doEmail = async () => {
        const email = await showInputDialog({
          title: t('Account email'),
          label: t('Email of this ChatGPT account. Used to recognize when it is the same account as a machine login (their usage then shows merged).'),
          value: a?.email || '', placeholder: 'you@example.com', confirmText: t('Save'),
        });
        if (email != null) {
          try { await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim() }) }); }
          catch (err) { showToast(t('Could not save the email — {reason}', { reason: err?.message || t('server unreachable') }), { type: 'error' }); }
          refresh();
        }
      };
      const doTest = () => {
        if (!a?.loggedIn) { showToast(t('This account isn’t signed in yet — use “Add ChatGPT account…” to finish the login first.'), { type: 'error' }); return; }
        if (keyRow.dataset.blocked) {
          showToast(t('“{name}” runs on this machine only. For {host}, use “Log in on host…” on the CLI-login row, or turn on Settings → “Ship subscription logins to remote hosts.”', { name: a?.name, host: escHtml(hostLabel) }) + ' ' + t('Already logged in as this account ON {host}? Then pick “CLI login @ {host}” when switching the session’s billing — that uses the host’s own login.', { host: escHtml(hostLabel) }), { type: 'error', duration: 8000 });
          return;
        }
        done();
        // With a remote host selected the test runs ON that host (auth.json
        // ships to it) — proving the full remote path.
        this.createSession({ backend: 'codex', mode: 'terminal', cwd: '', accountId: id, ephemeral: true, hostId: selectedHost || undefined });
      };
      const doRename = async () => {
        const name = await showInputDialog({ title: t('Rename account'), label: t('Account name'), value: a?.name || '', confirmText: t('Save') });
        if (name && name.trim() && name.trim() !== a?.name) {
          try { await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }); }
          catch (err) { showToast(t('Rename failed — {reason}', { reason: err?.message || t('server unreachable') }), { type: 'error' }); }
          refresh();
        }
      };
      const doDelete = async () => {
        if (!(await showConfirmDialog({ title: t('Remove account'), message: t('Remove "{name}" from VibeSpace? Sessions already running keep working.', { name: a?.name }) }))) return;
        try { await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }); showToast(t('Removed “{name}”', { name: a?.name || '' })); }
        catch (err) { showToast(t('Could not remove the account — {reason}', { reason: err?.message || t('server unreachable') }), { type: 'error' }); }
        refresh();
      };
      if (e.target.closest('.acct-def')) {
        const isDef = accts.defaultCodexAccountId === id;
        // Default is GLOBAL — starring a "this machine only" row while a host
        // is selected read as "I switched the remote's account" (2.188.0)
        if (keyRow.dataset.blocked && !isDef) {
          showToast(t('The default is global, and “{name}” can’t run on {host} — new sessions there keep using its own login.', { name: a?.name, host: escHtml(hostLabel) }) + ' ' + t('Already logged in as this account ON {host}? Then pick “CLI login @ {host}” when switching the session’s billing — that uses the host’s own login.', { host: escHtml(hostLabel) }), { type: 'error', duration: 8000 });
          return;
        }
        try { await api('/api/accounts/default', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: isDef ? null : id, backend: 'codex' }) }); }
        catch (err) { showToast(t('Could not change the default account — {reason}', { reason: err?.message || t('server unreachable') }), { type: 'error' }); }
        refresh();
      } else if (e.target.closest('.acct-menu')) {
        const r = e.target.closest('.acct-menu').getBoundingClientRect();
        const items = [
          { label: t('Test'), action: doTest },
          { label: t('Rename account'), action: doRename },
        ];
        // pool: Switch target / Members… / Auto-switch / hot — the SAME block
        // the Anthropic roster uses (2.369.18)
        if (a?.pooled && !selectedHost) items.splice(0, 1, ...this._poolMenuItems(id, a, refresh));
        if (!a?.pooled && a?.loggedIn && (!a.email || a.emailDeclared)) items.push({ label: a.email ? t('edit email') : t('set email…'), action: doEmail });
        items.push(...this._rulesAndChecksItems('codex', { accountId: id, accountName: a?.name || '', selectedHost }));
        items.push({ separator: true }, { label: t('Remove account'), action: doDelete });
        showContextMenu(r.left, r.bottom + 4, items);
      }
    };
  },


  _showAgentsDialog({ container, forceModal, onClose } = {}) {
    // rail mode: render into the sidebar panel instead of a modal (one source).
    // Skip _railGo when the agents panel is ALREADY active — its re-click
    // semantics COLLAPSE the sidebar (the usage popup's "Full overview" door
    // would close the very panel it points at). forceModal callers (the
    // onboarding wizard, 2.267.4) need the MODAL regardless — the rail panel
    // would open BEHIND the wizard overlay.
    if (!container && !forceModal && !this.isMobile && this.sidebar?._railEl) {
      this.sidebar.toggle?.(true);
      if (this.sidebar._activeTab !== 'agents') this.sidebar._railGo?.('agents');
      return;
    }
    const shell = container ? { body: container, close: () => {} } : createModalShell({
      id: 'agents-dialog-overlay', title: t('Agents'), dialogClass: 'agents-dialog',
      bodyClass: 'agents-dialog-body', escapeToClose: true, onClose,
    });
    // rail panel: carry the SAME body class so one stylesheet (incl. the
    // container queries) serves modal and panel — the panel's narrow-width
    // crush came from modal-scoped rules never applying there
    if (container) container.classList.add('agents-dialog-body');
    const { body, close: done } = shell;
    body.innerHTML = `<div class="ob-loading">${t('Checking\u2026')}</div>`;

    const BACKENDS = [
      // installCmd: claude's official native installer is user-local
      // (~/.local/bin, no root, no npm-prefix permission trap); codex has no
      // native installer — npm -g is its official install AND update path.
      { key: 'claude', label: 'Claude Code', loginCmd: 'claude', updateCmd: 'claude update', installCmd: 'curl -fsSL https://claude.ai/install.sh | bash' },
      // codex login is ALWAYS --device-auth (user directive, 2.105.1): plain
      // `codex login` starts a localhost:1455 callback server on the machine
      // running the CLI — unreachable from the user's browser on remote hosts
      // AND on managed/container instances (the callback would land on the
      // user's own machine). Device auth prints a URL + one-time code instead
      // and works everywhere, including this dev box.
      { key: 'codex', label: 'Codex', loginCmd: 'codex login --device-auth', updateCmd: 'npm install -g @openai/codex@latest', installCmd: 'npm install -g @openai/codex@latest' },
    ];
    // Machine-sectioned overview (2.245.0): no host selector anymore — the
    // surface stacks "This machine" plus one section per configured host,
    // each with its full block (CLI status rows, account rosters, integration
    // row). Host sections list only VERDICT-usable accounts (B-f531 — the
    // server computes usable/linked/held, never the client) plus the host's
    // own CLI-login row with its quota.
    // Reentrancy guard: a refresh mid-fill starts a NEW pass whose
    // innerHTML='' wipes the old one's partial rows — but the OLD fills
    // resume after their next await and would keep appending. Generation
    // ticket; stale runs stop at every await/append point.
    let refreshGen = 0;
    // Render ONE machine's full block into its own section container. The
    // container param is deliberately named `body` so the extensive existing
    // append logic below (backend rows, rosters, integration) runs unchanged
    // inside the section — nothing in it needs the OUTER dialog body.
    const renderMachine = async (body, selectedHost, hostLabel, hostTransport, stale) => {
      const run = (cmd) => {
        done();
        if (selectedHost) this.openShellTerminal(undefined, { hostId: selectedHost, initialCommand: cmd });
        else this.openShellTerminal(undefined, { initialCommand: cmd });
      };
      // Row actions re-render the WHOLE surface (all machines) — the same
      // full-refresh semantics the single-machine dialog had.
      const refresh = () => { this._agentsRefreshHook?.(); };
      let st = {};
      try { st = (await fetchJson(selectedHost ? `/api/hosts/${selectedHost}/backend-status` : '/api/backend-status')) || {}; } catch {}
      if (stale() || !body.isConnected) return;
      // Accounts render UNDER their CLI: Anthropic accounts below Claude Code,
      // OpenAI/Codex accounts below Codex. Shared context for the extracted
      // renderers (they capture the same closures the dialog builds).
      // Host login identity probed ONCE for both rosters (claude email/key
      // shapes + codex JWT email — 2.188.0).
      let racct = null;
      if (selectedHost) { try { racct = await fetchJson(`/api/hosts/${encodeURIComponent(selectedHost)}/accounts-status`); } catch {} }
      if (stale() || !body.isConnected) return;
      body.querySelector('.ob-loading')?.remove();
      const actx = { body, selectedHost, hostLabel, done, run, refresh, st, stale, racct };
      // A THROWN roster render used to vanish the whole accounts list from the
      // section with no trace — that empty catch already hid a real
      // ReferenceError (`racct`) that killed the codex roster on every host
      // view for releases, and it read as "this machine just has no accounts".
      const renderRoster = async (which) => {
        try {
          if (which === 'claude') await this._renderClaudeAccounts(actx);
          else await this._renderCodexAccounts(actx);
        } catch (err) {
          try { track('error', 'agents-roster-render-failed', `${which}: ${err?.message || err}`, err?.stack); } catch { }
          if (stale() || !body.isConnected) return;
          const warn = document.createElement('div');
          warn.className = 'ob-backend';
          warn.innerHTML = `<div class="usage-warn">${escHtml(t('The {backend} accounts list failed to render — {reason}', { backend: which === 'claude' ? 'Claude' : 'Codex', reason: String(err?.message || err) }))}</div>`;
          body.appendChild(warn);
        }
      };
      // A host whose status probe failed must SAY so — the empty status
      // object otherwise renders "not installed" + Install buttons for a
      // machine that is simply unreachable (honest-state rule).
      const unreachable = !!selectedHost && (!!st?.error || (!st?.claude && !st?.codex));
      for (const b of BACKENDS) {
        if (unreachable) {
          const row = document.createElement('div'); row.className = 'ob-backend';
          const left = document.createElement('div'); left.className = 'ob-backend-id';
          left.innerHTML = `<b>${b.label}</b> <span class="ob-warn">${t('unreachable')}</span>`;
          row.append(left);
          body.appendChild(row);
          // Rosters still render — the CLI-login row + note carry the state
          await renderRoster(b.key);
          if (stale()) return;
          continue;
        }
        const info = st[b.key] || {};
        const row = document.createElement('div'); row.className = 'ob-backend';
        const left = document.createElement('div');
        // one line: name \u00b7 version chip \u00b7 status \u2014 the version's own "(Claude
        // Code)" suffix just repeats the label and wrapped badly when narrow
        const ver = info.version ? String(info.version).replace(/\s*\((?:claude code|codex(?:-cli)?)\)\s*$/i, '') : '';
        left.className = 'ob-backend-id';
        // API-key-style logins (console-managed key / env var / apiKeyHelper)
        // say so \u2014 mirrors the CLI's own "API Usage Billing" statusline
        const lm = info.loginMethod;
        const lmLabel = (lm === 'console-key' || lm === 'env-key') ? t('API key') : lm === 'key-helper' ? 'apiKeyHelper' : '';
        // apiKeyHelper OUTRANKS OAuth in the CLI (2.191.0, CW-H200 incident:
        // fresh OAuth login + a leftover helper = every session bills the
        // helper key while this row said just "logged in") \u2014 warn loudly.
        const helperWarn = (info.keyHelper && lm !== 'key-helper')
          ? ` <span class="ob-warn" title="${escHtml(t('The CLI prefers a configured apiKeyHelper over the OAuth login \u2014 sessions using the machine\u2019s own login bill via the helper key. Sessions where you explicitly pick a subscription account bypass the helper automatically (2.236.0); to change the machine-wide default, remove apiKeyHelper from ~/.claude/settings.json.'))}">\u26a0 ${t('apiKeyHelper overrides this login')}</span>` : '';
        left.innerHTML = `<b>${b.label}</b>${ver ? ` <span class="ob-ver">${escHtml(ver)}</span>` : ''} ${
          !info.installed ? `<span class="ob-bad">${t('not installed')}</span>`
          : info.loggedIn ? `<span class="ob-ok">\u2713 ${t('logged in')}</span>${lmLabel ? ` <span class="ob-ver">${escHtml(lmLabel)}</span>` : ''}${helperWarn}`
          // Machine login dead but NAMED/pooled accounts carry the sessions
          // (the pooling-era normal state, 2.267.1): "not logged in" read as
          // "Claude is broken" \u2014 say what's actually true. Log in stays
          // offered (it's still how you revive the machine login). The cause
          // is only claimed when KNOWN (2.267.4): token-less creds = expired;
          // no creds at all = never set up \u2014 don't invent idle-expiry.
          : (info.namedLoggedIn > 0)
            ? `<span class="ob-ver">${info.machineLoginState === 'expired' ? t('machine login inactive') : t('machine login not set up')}</span> <span class="ob-ok">${t('{n} named account(s) in use', { n: info.namedLoggedIn })}</span>`
          : `<span class="ob-warn">${t('not logged in')}</span>`
        }`;
        const actions = document.createElement('div'); actions.className = 'agent-actions';
        if (!info.installed && b.installCmd) {
          const instBtn = document.createElement('button'); instBtn.className = 'agent-btn primary'; instBtn.textContent = t('Install');
          instBtn.title = b.installCmd + (selectedHost ? ` — ${t('runs on the selected remote host')}` : '');
          instBtn.onclick = () => run(b.installCmd);
          actions.appendChild(instBtn);
        }
        // Helper terminals are LOGIN shells — /etc/profile resets PATH, and a
        // host missing ~/.local/bin in ~/.profile made a bare `claude update`
        // die "command not found" (fleet-wide him188 incident). Local commands
        // that START with the CLI name use the server-resolved absolute path;
        // remote hosts keep the bare name (their path layout is unknown here).
        const absCmd = (cmd) => {
          if (selectedHost || !info.cmdPath) return cmd;
          const name = b.key === 'claude' ? 'claude' : 'codex';
          return cmd.startsWith(name + ' ') || cmd === name ? `"${info.cmdPath}"` + cmd.slice(name.length) : cmd;
        };
        // With named/pooled accounts carrying the sessions, a PRIMARY "Log in"
        // next to "+ Add account…" was two green look-alikes with no visible
        // distinction (2.268.4, user report) — the machine-wide login demotes
        // into the Add-account menu then ("Log in machine-wide…"); a machine
        // with NO named accounts keeps the button (it IS the primary path).
        if (info.installed && !info.loggedIn && !(b.key === 'claude' && !selectedHost && info.namedLoggedIn > 0)) {
          const loginBtn = document.createElement('button'); loginBtn.className = 'agent-btn primary'; loginBtn.textContent = t('Log in');
          loginBtn.title = selectedHost ? t('Logs in ON the selected remote host (its own login, not VibeSpace)') : '';
          loginBtn.onclick = () => run(selectedHost && b.remoteLoginCmd ? b.remoteLoginCmd : absCmd(b.loginCmd));
          actions.appendChild(loginBtn);
        }
        if (info.installed) {
          const updBtn = document.createElement('button'); updBtn.className = 'agent-btn'; updBtn.textContent = t('Update');
          updBtn.title = b.updateCmd;
          updBtn.onclick = () => run(absCmd(b.updateCmd));
          actions.appendChild(updBtn);
        }
        // READ-ONLY rule view + the human-triggered local checks for the
        // MACHINE's own login (rulings 10 + 6). The per-account rosters carry
        // the same block for named accounts; this row is the only door for a
        // machine that has none. Local only — a remote host's rules and CLI
        // live on that machine and this reader does not.
        {
          const checks = this._rulesAndChecksItems(b.key, { selectedHost });
          if (info.installed && checks.length) {
            const chkBtn = document.createElement('button'); chkBtn.className = 'agent-btn'; chkBtn.textContent = t('Rules & checks');
            chkBtn.title = t('Read-only: permission rules, plus local checks that make no network requests');
            chkBtn.onclick = () => { const rect = chkBtn.getBoundingClientRect(); showContextMenu(rect.left, rect.bottom + 4, checks.filter((x) => !x.separator)); };
            actions.appendChild(chkBtn);
          }
        }
        // Ephemeral-install warning (2.229.0, LOCAL machine only — remote
        // hosts' layout is theirs): a claude living outside $HOME (image-baked
        // npm-global) is wiped back to the baked version on every container
        // rebuild — userW updated, got Opus 5 for 3 days, then a pod rebuild
        // silently reverted the opus alias to 4.8. Offer the persistent
        // user-local install right here (native installer → ~/.local, which
        // wins PATH; picked up by new sessions after the next server restart).
        if (!selectedHost && b.key === 'claude' && info.installed && info.install && !info.install.userLocal && b.installCmd) {
          const warnRow = document.createElement('div');
          warnRow.className = 'ob-cli-ephemeral';
          warnRow.innerHTML = `<span class="usage-warn">⚠ ${escHtml(t('Installed in a system location ({path}) — in containerized deployments, updates to it are lost when the container is rebuilt.', { path: info.install.binPath }))}</span>`;
          const persistBtn = document.createElement('button'); persistBtn.className = 'agent-btn'; persistBtn.textContent = t('Install persistent copy');
          persistBtn.title = b.installCmd + ' — ' + t('installs under your home directory (survives rebuilds; takes over for new sessions after the next server restart)');
          persistBtn.onclick = () => run(b.installCmd);
          warnRow.appendChild(persistBtn);
          left.appendChild(warnRow);
        }
        if (stale()) return;
        row.append(left, actions);
        body.appendChild(row);
        // Account roster for THIS backend, right under its status row.
        await renderRoster(b.key);
        if (stale()) return;
      }
      // ── VibeSpace integration (task context hook) — local machine only.
      // Auto-installed at server start; this row makes the state VISIBLE and
      // repairable for non-engineers (auto-install can fail silently if e.g.
      // the CLI's settings file doesn't exist yet).
      if (!selectedHost) {
        // These probes run AFTER the section's '.ob-loading' was removed, so
        // while in flight the section looked complete with the row simply
        // ABSENT — and on failure the row never appeared at all, making a
        // failed probe indistinguishable from "integration not applicable".
        const probeStub = document.createElement('div');
        probeStub.className = 'ob-backend';
        probeStub.innerHTML = `<div><b>${t('VibeSpace integration')}</b> <span class="ob-ver">${t('checking…')}</span></div>`;
        body.appendChild(probeStub);
        let hs = null, hsErr = null;
        try { hs = await api('/api/agent-hooks'); } catch (err) { hsErr = err?.message || t('probe failed'); }
        if (stale()) { probeStub.remove(); return; }
        probeStub.remove();
        if (!hs) {
          const warn = document.createElement('div');
          warn.className = 'ob-backend';
          warn.innerHTML = `<div><b>${t('VibeSpace integration')}</b></div><div class="usage-warn">${escHtml(t('Could not read the hook status — {reason}', { reason: hsErr || t('server unreachable') }))}</div>`;
          body.appendChild(warn);
        }
        if (hs) {
          const row = document.createElement('div'); row.className = 'ob-backend';
          const left = document.createElement('div');
          const stateOf = (k, label) => {
            const st = hs[k] || {};
            if (st.installed) return `<span class="ob-ok">✓ ${label}</span>`;
            if (st.stale) return `<span class="ob-warn">${t('{label}: needs update', { label })}</span>`;
            if (st.parseError) return `<span class="ob-bad">${t('{label}: config unreadable', { label })}</span>`;
            if (!st.fileExists) return `<span class="ob-warn">${t('{label}: run the CLI once first', { label })}</span>`;
            return `<span class="ob-warn">${t('{label}: not installed', { label })}</span>`;
          };
          const allGood = hs.claude?.installed && hs.codex?.installed;
          if (hs.integrationOff) {
            // Master switch (Settings → Integration) outranks this row — the
            // install route refuses and boot strips, so offer no buttons.
            left.innerHTML = `<b>${t('VibeSpace integration')}</b><div><span class="ob-warn">${t('Disabled — master switch is off (Settings → Integration)')}</span></div>`
              + `<div class="agents-note">${t('Sessions run the pristine CLI: no hooks, no injected context, no agent tools. Re-enable it in Settings to restore Task Group context.')}</div>`;
            row.append(left);
            body.appendChild(row);
          } else {
            left.innerHTML = `<b>${t('VibeSpace integration')}</b><div>${stateOf('claude', 'Claude')} &nbsp; ${stateOf('codex', 'Codex')}</div>`
              + `<div class="agents-note">${t("Lets sessions in a Task Group automatically receive the group's context (objective, shared files).")}</div>`;
            const actions = document.createElement('div'); actions.className = 'agent-actions';
            const installBtn = document.createElement('button');
            installBtn.className = 'agent-btn' + (allGood ? '' : ' primary');
            installBtn.textContent = allGood ? t('Reinstall') : t('Install');
            installBtn.onclick = async () => {
              installBtn.disabled = true;
              try {
                const r = await fetchJson('/api/agent-hooks/install', { method: 'POST' });
                const errs = Object.entries(r?.results || {}).filter(([, v]) => !v.ok);
                if (errs.length) showToast(errs.map(([k, v]) => `${k}: ${v.error}`).join('; '), { type: 'error' });
                else showToast(t('Task Group context hook installed'));
              } catch { showToast(t('Install failed'), { type: 'error' }); }
              refresh();
            };
            actions.appendChild(installBtn);
            if (hs.claude?.installed || hs.codex?.installed || hs.claude?.stale || hs.codex?.stale) {
              const rmBtn = document.createElement('button'); rmBtn.className = 'agent-btn'; rmBtn.textContent = t('Remove');
              rmBtn.title = t('Unregister the hook from both CLIs (sessions stop receiving Task Group context)');
              rmBtn.onclick = async () => {
                rmBtn.disabled = true;
                try { await fetchJson('/api/agent-hooks/uninstall', { method: 'POST' }); showToast(t('Hook removed')); } catch {}
                refresh();
              };
              actions.appendChild(rmBtn);
            }
            row.append(left, actions);
            body.appendChild(row);
          }
        }
      } else {
        // ── VibeSpace integration ON THE HOST (2.129.0, backlog B-34bb):
        // remote sessions drop tools + a hook + keeper files under
        // ~/.vibespace there (per-spawn, silently — a user was rightly
        // startled finding them). This row makes that footprint VISIBLE:
        // per-tool freshness vs the local copies, remote hook registration,
        // keeper session files — with explicit Install/refresh + Remove.
        // ssh/dial round trip — same rule as the local probe: name the wait,
        // and never let a failed probe read as "integration not applicable"
        // (a user checking why remote context injection is broken saw nothing).
        const hostNameStub = hostLabel || t('remote host');
        const probeStub = document.createElement('div');
        probeStub.className = 'ob-backend';
        probeStub.innerHTML = `<div><b>${t('VibeSpace integration on {host}', { host: escHtml(hostNameStub) })}</b> <span class="ob-ver">${t('checking…')}</span></div>`;
        body.appendChild(probeStub);
        let rs = null, rsErr = null;
        try { rs = await api(`/api/hosts/${encodeURIComponent(selectedHost)}/agent-tools`); } catch (err) { rsErr = err?.message || t('probe failed'); }
        if (stale()) { probeStub.remove(); return; }
        probeStub.remove();
        if (!rs?.tools) {
          const warn = document.createElement('div');
          warn.className = 'ob-backend';
          warn.innerHTML = `<div><b>${t('VibeSpace integration on {host}', { host: escHtml(hostNameStub) })}</b></div>`
            + `<div class="usage-warn">${escHtml(t('Could not check the integration on {host} — {reason}', { host: hostNameStub, reason: rsErr || t('unreachable') }))}</div>`;
          body.appendChild(warn);
        }
        if (rs && rs.tools) {
          const hostName = hostLabel || t('remote host');
          const row = document.createElement('div'); row.className = 'ob-backend';
          const left = document.createElement('div');
          const names = Object.keys(rs.tools);
          const presentN = names.filter(n => rs.tools[n].present).length;
          const outdatedN = names.filter(n => rs.tools[n].present && !rs.tools[n].current).length;
          const perTool = names.map(n => `${rs.tools[n].present ? (rs.tools[n].current ? '✓' : '≠') : '✗'} ${n}`).join('\n');
          let toolsHtml;
          if (!presentN) toolsHtml = `<span class="ob-warn">${t('tools: not installed')}</span>`;
          else if (presentN < names.length || outdatedN) toolsHtml = `<span class="ob-warn">${t('tools: {n}/{total} present, {stale} outdated', { n: presentN, total: names.length, stale: outdatedN })}</span>`;
          else toolsHtml = `<span class="ob-ok">✓ ${t('{n} tools current', { n: presentN })}</span>`;
          const hookHtml = ['claude', 'codex'].map((k) => rs.hooks?.[k]
            ? `<span class="ob-ok">✓ ${k === 'claude' ? 'Claude' : 'Codex'} ${t('hook')}</span>`
            : `<span class="ob-warn">${k === 'claude' ? 'Claude' : 'Codex'} ${t('hook')}: ${t('not registered')}</span>`).join(' &nbsp; ');
          const extras = [];
          if (!rs.node) extras.push(`<span class="ob-bad">${t('node missing on the host — agent tools cannot run')}</span>`);
          if (rs.keeperSessions) extras.push(`<span>${t('{n} keeper session file(s)', { n: rs.keeperSessions })}</span>`);
          // Master switch awareness (live-synced settings store, same pattern
          // as the shipSubscriptionToRemote gate): the STATUS still renders —
          // seeing residue from earlier ON spawns is exactly what a pristine
          // verification needs — but the note tells the truth and Install is
          // withheld (the route refuses anyway); Remove stays as the cleanup.
          const masterOff = this.settings?.get?.('agents.vibespaceIntegration') === false;
          const noteHtml = masterOff
            ? `<div><span class="ob-warn">${t('Disabled — master switch is off (Settings → Integration)')}</span></div>`
              + `<div class="agents-note">${t('New remote sessions ship no tools and register no hook. Anything shown above is residue from earlier sessions — inert without the session env; Remove deletes it from the host.')}</div>`
            : `<div class="agents-note">${t('Reporting tools, the Task Group context hook, and the session keeper live under ~/.vibespace on the host. Creating a remote session re-installs them automatically.')}</div>`;
          left.innerHTML = `<b>${t('VibeSpace integration on {host}', { host: escHtml(hostName) })}</b>`
            + `<div title="${escHtml(perTool)}">${toolsHtml} &nbsp; ${hookHtml}${extras.length ? ' &nbsp; ' + extras.join(' &nbsp; ') : ''}</div>`
            + noteHtml;
          const actions = document.createElement('div'); actions.className = 'agent-actions';
          const allGood = presentN === names.length && !outdatedN;
          // Dial devices: install/uninstall ride the SESSION SPAWN channel
          // (deviceAgentSetup ships the tools per spawn) — the tar-over-ssh
          // buttons here are ssh-only, so on a device they'd just error.
          // The status above still works (probes run via the device link).
          if (hostTransport === 'dial') {
            const note = document.createElement('span'); note.className = 'ob-ver';
            note.textContent = t('managed automatically — each session spawn refreshes the tools');
            actions.appendChild(note);
            row.append(left, actions);
            body.appendChild(row);
          } else {
          if (!masterOff) {
            const installBtn = document.createElement('button');
            installBtn.className = 'agent-btn' + (allGood ? '' : ' primary');
            installBtn.textContent = presentN ? t('Reinstall') : t('Install');
            installBtn.onclick = async () => {
              installBtn.disabled = true;
              try {
                const r = await fetchJson(`/api/hosts/${encodeURIComponent(selectedHost)}/agent-tools/install`, { method: 'POST' });
                if (r?.success) showToast(t('Integration installed on {host}', { host: hostName }));
                else showToast(r?.error || t('Install failed'), { type: 'error' });
              } catch { showToast(t('Install failed'), { type: 'error' }); }
              refresh();
            };
            actions.appendChild(installBtn);
          }
          if (presentN) {
            const rmBtn = document.createElement('button'); rmBtn.className = 'agent-btn'; rmBtn.textContent = t('Remove');
            rmBtn.title = t('Unregisters the hook from the host\'s CLIs and deletes the tools. A future remote session on this host re-installs them.');
            rmBtn.onclick = async () => {
              const ok = await showConfirmDialog({
                title: t('Remove VibeSpace integration from {host}?', { host: hostName }),
                message: t("Unregisters the hook from the host's CLIs and deletes the tools under ~/.vibespace/bin. Running remote sessions lose their reporting tools; a future remote session re-installs everything."),
                confirmText: t('Remove'), danger: true,
              });
              if (!ok) return;
              rmBtn.disabled = true;
              try {
                const r = await fetchJson(`/api/hosts/${encodeURIComponent(selectedHost)}/agent-tools/uninstall`, { method: 'POST' });
                if (r?.success) showToast(t('Integration removed from {host}', { host: hostName }));
                else showToast(r?.error || t('Remove failed'), { type: 'error' });
              } catch { showToast(t('Remove failed'), { type: 'error' }); }
              refresh();
            };
            actions.appendChild(rmBtn);
          }
          row.append(left, actions);
          body.appendChild(row);
          } // end non-dial actions
        }
      }
    }; // end renderMachine

    // Exposed so the host-login watcher can refresh THIS surface in place
    // (returns false once the body left the document — panel rebuilt/closed).
    const refresh = async () => {
      const myGen = ++refreshGen;
      const stale = () => myGen !== refreshGen;
      let hostsList = [];
      try { const hd = await fetchJson('/api/hosts'); hostsList = hd?.hosts || []; } catch {}
      if (stale()) return;
      this._agentsHostsList = hostsList; // the refresh-all fan-out reads this
      body.innerHTML = '';
      // ── 2.262.0 REDESIGN (user: 平铺缺分级看着累 + 指令环节孤立): three
      // tabs — Accounts (management home = the local roster), Machines (one
      // ACCORDION card per host, lazily probed on first expand), Instructions
      // (the agent-injection fields, no longer dangling at the bottom). ──
      const tab = ['accounts', 'machines', 'instructions'].includes(localStorage.getItem('vibespace.agentsTab')) ? localStorage.getItem('vibespace.agentsTab') : 'accounts';
      const tabs = document.createElement('div');
      tabs.className = 'agents-tabs';
      for (const [k, label] of [['accounts', t('Accounts')], ['machines', t('Machines') + (hostsList.length ? ` (${hostsList.length})` : '')], ['instructions', t('Instructions')]]) {
        const b = document.createElement('button');
        b.className = 'agents-tab' + (k === tab ? ' active' : '');
        b.textContent = label;
        b.onclick = () => { localStorage.setItem('vibespace.agentsTab', k); refresh(); };
        tabs.appendChild(b);
      }
      body.appendChild(tabs);
      // Header: ONE ⟳ Refresh-all (HUMAN-CLICK-initiated only, §ban-safety:
      // never wire this to any timer). Not shown on the Instructions tab.
      if (tab !== 'instructions') {
        const head = document.createElement('div');
        head.className = 'agents-overview-head';
        const headNote = document.createElement('span');
        headNote.className = 'agents-note';
        headNote.textContent = tab === 'accounts' ? t('Accounts & quota on this machine') : t('Accounts & quota by machine');
        const refreshAll = document.createElement('button');
        refreshAll.className = 'agent-btn agents-refresh-all';
        refreshAll.innerHTML = `${UI_ICONS.refresh}<span>${t('Refresh all')}</span>`;
        refreshAll.title = t('Fetch fresh quota for every signed-in account and machine below — one on-demand request per identity, only when you click (never scheduled)');
        refreshAll.onclick = () => this._refreshAllQuota(refreshAll, body);
        head.append(headNote, refreshAll);
        body.appendChild(head);
      }
      const mkSection = (label, hostId, sub, parent) => {
        const sec = document.createElement('div');
        sec.className = 'agents-machine-sec';
        sec.dataset.host = hostId || '';
        if (label) {
          const hd2 = document.createElement('div');
          hd2.className = 'usage-section-title agents-machine-title';
          const sp = document.createElement('span'); sp.textContent = label; hd2.appendChild(sp);
          if (sub) { const ss = document.createElement('span'); ss.className = 'agents-machine-sub'; ss.textContent = sub; hd2.appendChild(ss); }
          sec.appendChild(hd2);
        }
        const ld = document.createElement('div'); ld.className = 'ob-loading'; ld.textContent = t('Checking…');
        sec.appendChild(ld);
        (parent || body).appendChild(sec);
        return sec;
      };
      const fills = [];
      if (tab === 'accounts') {
        // The LOCAL machine is the management home: full roster + local CLI
        // logins + local integration (renderMachine('') unchanged).
        fills.push(renderMachine(mkSection('', ''), '', null, null, stale));
      } else if (tab === 'machines') {
        if (!hostsList.length) {
          const eh = document.createElement('div');
          eh.className = 'empty-hint';
          eh.textContent = t('No machines yet — add an SSH host or pair a device in the Remote tab.');
          body.appendChild(eh);
        }
        // Accordion: one collapsible card per host; the ssh/dial probe runs
        // LAZILY on first expand (opening the dialog no longer fans probes to
        // every configured machine). Open-set remembered per device.
        let openSet;
        try { openSet = new Set(JSON.parse(localStorage.getItem('vibespace.agentsMachOpen') || '[]')); } catch { openSet = new Set(); }
        // Collapsed-header health at a glance (2.268.9, inbox follow-up) —
        // WITHOUT expanding (the ssh/dial probe stays lazy): a conn dot from
        // the dial registry's live truth (dial `online` / graduated ssh
        // `dialLive`; plain ssh has no probe-free signal → no dot, never
        // guess) + the machine login's worst quota bucket from the cached
        // /api/usage snapshot (local read, zero Anthropic calls).
        try {
          const u = await fetchJson('/api/usage');
          if (u && !stale()) { this._accountUsage = u.accounts || this._accountUsage; this._hostOwnUsage = u.hosts || this._hostOwnUsage; this._hostAccountUsage = u.hostAccounts || this._hostAccountUsage; }
        } catch {}
        const pctOf = (x) => Math.min(100, Math.round(x?.usedPercent ?? ((x?.utilization || 0) * 100)));
        for (const h of hostsList) {
          const det = document.createElement('details');
          det.className = 'agents-mach-acc';
          det.dataset.host = h.id;
          if (openSet.has(h.id) || hostsList.length === 1) det.open = true;
          const sum = document.createElement('summary');
          sum.className = 'agents-mach-sum';
          const live = h.transport === 'dial' ? !!h.online : (h.graduated ? !!h.dialLive : null);
          const dot = live == null ? '' : `<span class="agents-mach-dot${live ? '' : ' off'}" data-tip="${escHtml(live ? t('dialed in') : t('not dialed in'))}"></span>`;
          let pill = '';
          const hu = this._hostOwnUsage?.[h.id];
          const bs = hu ? [['5h', hu.fiveHour], ['7d', hu.sevenDay], ...(hu.scopedWeekly || []).map((sc) => [String(sc.name || '?').slice(0, 2), sc])].filter(([, x]) => x && Number.isFinite(pctOf(x))) : [];
          if (bs.length) {
            const [wl, wx] = bs.reduce((a, b) => (pctOf(b[1]) > pctOf(a[1]) ? b : a));
            const wp = pctOf(wx);
            const c = wp > 95 ? 'var(--red,#e55)' : wp > 80 ? 'var(--yellow,#e5c07b)' : 'var(--green,#3fb950)';
            // AGE MARKER (the row-level donuts have one; this pill didn't):
            // this is the persisted usage-cache snapshot, potentially DAYS
            // old, so a dead host showed a healthy-looking green "5h 12%" that
            // read as current.
            const ageMs = hu.fetchedAt ? Date.now() - hu.fetchedAt : 0;
            const ageTxt = ageMs > 5 * 60000 ? ' · ' + agoText(hu.fetchedAt) : '';
            const tip = bs.map(([l, x]) => `${l} ${pctOf(x)}%`).join(' · ') + (hu.fetchedAt ? ' · ' + t('as of {when}', { when: agoText(hu.fetchedAt) }) : '');
            pill = `<span class="agents-mach-quota" style="color:${c}" title="${escHtml(tip)}">${escHtml(wl)} ${wp}%${escHtml(ageTxt)}</span>`;
          }
          sum.innerHTML = `${dot}<span class="agents-mach-name">${escHtml(h.name)}</span><span class="agents-machine-sub">${escHtml(h.transport === 'dial' ? t('device') : `${h.user}@${h.host}`)}</span>${pill}`;
          det.appendChild(sum);
          const sec = mkSection('', h.id, null, det);
          const fill = () => {
            if (det._filled) return;
            det._filled = true;
            const p = renderMachine(sec, h.id, h.name, h.transport || null, stale);
            fills.push(p);
            this._agentsFill = Promise.allSettled(fills);
          };
          det.addEventListener('toggle', () => {
            try {
              const cur = new Set(JSON.parse(localStorage.getItem('vibespace.agentsMachOpen') || '[]'));
              if (det.open) cur.add(h.id); else cur.delete(h.id);
              localStorage.setItem('vibespace.agentsMachOpen', JSON.stringify([...cur]));
            } catch { }
            if (det.open) fill();
          });
          body.appendChild(det);
          if (det.open) fill();
        }
      }
      // Refresh-all awaits this so a click right after open still sees every
      // rendered machine's verdicts before building its target list.
      this._agentsFill = Promise.allSettled(fills);
      // ── Agent instructions — its OWN tab since 2.262.0 (it used to dangle
      // collapsed at the bottom of the machine stack). Layout: one labelled
      // field per injection surface; each nudge condition is a full sentence
      // with the number input embedded.
      if (tab === 'instructions') {
        const adv = document.createElement('div');
        adv.className = 'agents-adv agents-adv-tab';
        const body2 = document.createElement('div');
        body2.className = 'agents-adv-body';
        const note = document.createElement('div');
        note.className = 'agents-note';
        note.textContent = t('Your custom text rides at the TOP of each VibeSpace injection surface — customize behavior fleet-wide (reply language, reporting habits, house rules). Each surface has its own field and cost profile.');
        body2.appendChild(note);
        const FIELDS = [
          ['agents.injectPreamble', 4000, 4,
            t('Session context (once per session + when edited)'),
            t('e.g. Always reply in Chinese. File a vibespace-ask before starting anything destructive.')],
          ['agents.perTurnExtra', 500, 2,
            t('Per-turn reminder (EVERY prompt — keep it short, costs tokens each turn)'),
            t('e.g. Prefer minimal diffs; never commit without asking.')],
          ['agents.stopNudgeExtra', 500, 2,
            t('Stop nudge (when the end-of-turn bookkeeping reminder fires)'),
            t('e.g. Also update the shared context folder if you learned something reusable.')],
        ];
        const tas = [];
        for (const [key, cap, rows, label, ph] of FIELDS) {
          const field = document.createElement('div');
          field.className = 'agents-field';
          const lab = document.createElement('label');
          lab.className = 'agents-field-label';
          lab.textContent = label;
          const ta = document.createElement('textarea');
          ta.className = 'settings-json';
          ta.rows = rows;
          ta.maxLength = cap;
          ta.placeholder = ph;
          ta.value = this.settings.get(key) || '';
          tas.push([key, ta]);
          field.append(lab, ta);
          body2.appendChild(field);
        }
        // Stop-nudge firing conditions — one full sentence per line, the
        // number input embedded where {n} sits in the translation.
        const numInputs = [];
        const condWrap = document.createElement('div');
        condWrap.className = 'agents-field';
        const condLab = document.createElement('label');
        condLab.className = 'agents-field-label';
        condLab.textContent = t('Stop nudge conditions');
        condWrap.appendChild(condLab);
        for (const [key, label, tip] of [
          // t() WITHOUT params keeps the literal {n} — it marks where the
          // number input embeds into the translated sentence.
          ['agents.stopNudgeStaleMinutes', t('fire after {n} min without a status update'), t('The nudge only fires when the session has not updated its board status for this long. 0 = always stale (with cooldown 0: fires on every stop).')],
          ['agents.stopNudgeCooldownMinutes', t('at most once per {n} min per session'), t('After nudging a session once, wait at least this long before nudging it again. 0 = no cooldown.')],
        ]) {
          const line = document.createElement('label');
          line.className = 'agents-cond';
          line.title = tip;
          const inp = document.createElement('input');
          inp.type = 'number';
          inp.className = 'settings-input-text agents-cond-num';
          // Bounds/default come from the ONE schema (inc-mt0mozsp: this dialog
          // carried a hardcoded pre-2.210.0 twin [min 1/2] that clamped the
          // explicit-0 "every stop" mode back up, and `Number(v) || dflt`
          // erased 0 outright — both fields silently reverted to 10/30).
          const schema = SETTINGS_SCHEMA[key];
          inp.min = schema.min; inp.max = schema.max;
          inp.value = this.settings.get(key) ?? schema.default;
          numInputs.push([key, inp, schema]);
          const [before, after] = label.includes('{n}') ? label.split('{n}') : [label + ' ', ''];
          line.append(document.createTextNode(before), inp, document.createTextNode(after));
          condWrap.appendChild(line);
        }
        body2.appendChild(condWrap);
        const btnRow = document.createElement('div');
        btnRow.className = 'agents-adv-actions';
        const save = document.createElement('button');
        save.className = 'agent-btn'; save.textContent = t('Save');
        save.onclick = () => {
          for (const [key, ta] of tas) this.settings.set(key, ta.value.trim());
          for (const [key, inp, schema] of numInputs) {
            // Explicit 0 is a VALID value (every-stop mode) — only an empty or
            // non-numeric input falls back to the default. Never `|| dflt`.
            const raw = String(inp.value).trim();
            const n = Number(raw);
            const v = raw === '' || !Number.isFinite(n) ? schema.default : Math.min(schema.max, Math.max(schema.min, n));
            inp.value = v;
            this.settings.set(key, v);
          }
          showToast(t('Saved — new/updated sessions receive it on their next turn'));
        };
        btnRow.appendChild(save);
        body2.appendChild(btnRow);
        adv.appendChild(body2);
        body.appendChild(adv);
      }

      if (tab !== 'instructions') {
        const foot = document.createElement('div');
        foot.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;';
        const note = document.createElement('p'); note.className = 'agents-note';
        note.textContent = t('Actions open in a terminal window so you can see exactly what runs.');
        const recheck = document.createElement('button'); recheck.className = 'agent-btn'; recheck.textContent = t('Re-check');
        recheck.onclick = refresh;
        foot.append(note, recheck);
        body.appendChild(foot);
      }
    };
    // Latest surface wins; the watcher checks isConnected so a stale hook
    // (panel rebuilt / modal closed) reports false and triggers a reopen.
    // All machines render at once since 2.245.0 — nothing to select/force.
    this._agentsRefreshHook = () => {
      if (!body.isConnected) return false;
      refresh();
      return true;
    };
    refresh();
  },

  // ── Anthropic accounts roster (rendered UNDER Claude Code in Manage
  // Agents). Extracted from _showAgentsDialog so accounts sit beside their
  // CLI. ctx carries the dialog closures the block already used.
  async _renderClaudeAccounts(ctx) {
    const { body, selectedHost, done, run, refresh, st } = ctx;
    const ctxRacct = ctx.racct;
    // ── Anthropic accounts (billing identity) — ONE unified roster whose
    // meaning is machine-scoped ONLY on the first row: the peer "CLI login"
    // row is the SELECTED machine's own global login (pick a remote host →
    // that host's login, with a clearly-labeled "Log in on <host>…" action).
    // Every NAMED account below is stored by VibeSpace (machine-independent)
    // and ships to whichever machine a session spawns on. This split is what
    // answers "if I pick the devbox, where does a login land?" — the peer row's
    // login lands ON the devbox; the Add… buttons always land in VibeSpace.
    let acct = null;
    try { acct = await fetchJson('/api/accounts'); } catch {}
    if (!acct) return;
    // Prime per-account usage so the rows show current quota on open (the
    // 30s poll also keeps it fresh). Best-effort — rows render regardless.
    try { const u = await fetchJson('/api/usage'); if (u) { this._accountUsage = u.accounts || {}; this._hostOwnUsage = u.hosts || {}; this._hostAccountUsage = u.hostAccounts || {}; this._usageGlobalIdent = u.globalLogin || null; if (u.rateLimit) this._rateLimit = u.rateLimit; } } catch {}
    // Host section → its login state was probed once in renderMachine()
    // (shared with the codex roster — 2.188.0).
    const racct = ctxRacct;
    const hostLabel = selectedHost ? (ctx.hostLabel || t('remote host')) : null;
    const accts = await this.refreshAccounts(); // keep app cache in sync
    // Roster order = TYPE, not insertion (2.268.5, user request): pools first
    // (the umbrella identities you actually pick), then subscriptions, then
    // API keys; name-sorted within a type so the list stays predictable as
    // accounts come and go.
    const claudeAccts = (accts.accounts || []).filter(x => (x.backend || 'claude') === 'claude').sort(rosterSort);
    // §ban-safety: on a REMOTE host a subscription can't run unless the opt-in
    // is set (its creds would ship to the host's — likely datacenter — IP). Its
    // rows render disabled with guidance; API keys are unaffected.
    const allowSubRemote = !!this.settings?.get?.('accounts.shipSubscriptionToRemote');
    const subBlocked = !!selectedHost && !allowSubRemote;
    // Roster card: header row (title + one Add menu) over the list — stacked,
    // never a side column (the side column is what crushed narrow widths)
    const row = document.createElement('div'); row.className = 'ob-backend acct-section acct-roster';
    const left = document.createElement('div');
    left.style.flex = '1';
    const sub = acct.subscription || {};
    // SVG icons (no emoji) — crown for a subscription, key for an API key,
    // overlapping circles for a pool (a pool is NOT an API key; the KEY icon
    // misread as one, real report), star for the default toggle. Shared with
    // the Codex roster (ROSTER_ICONS at module top).
    const { CROWN, GLOBE, KEY, POOL, STAR_F, STAR_O, DOTS } = ROSTER_ICONS;
    // Compact per-account usage readout — shared with the Codex roster.
    const usageHtml = (u, est) => this._acctUsageHtml(u, est);
    // Peer row: the SELECTED MACHINE's own global login. It's the default
    // whenever no named account is starred (a session with no account uses
    // the login of whatever machine it runs on). Not renamable/removable.
    const gDef = !accts.defaultAccountId;
    const importedTails = new Set(claudeAccts.map(a => a.tail));
    let gName, gIdent, gExtraActions = '';
    if (selectedHost) {
      gName = t('CLI login on {host}', { host: escHtml(hostLabel) });
      // Every working auth shape reads as LOGGED IN (2.188.0 — an
      // apiKeyHelper host said "logged in (apiKeyHelper)" in the backend row
      // above and "not logged in" here, in the same dialog; a console key got
      // a warning tone for what is a working API-key auth). Email shown when
      // the host's config reports one.
      // identity preference: roles-derived orgEmail baked by the host quota ⟳
      // (live, tied to the actual token) beats the host's config-file email
      // (goes stale after a /login switch — the 2.114.1 mixup class) — BUT
      // only while the cache POSTDATES the last login the watcher saw land
      // on this host (2.195.0, real report): after an on-host /login switch
      // the cached orgEmail is a snapshot of the OLD token and kept winning
      // for hours. Anchor = the LOCAL _hostLoginSeenAt stamp, deliberately
      // NOT the creds-file mtime — the CLI rotates .credentials.json on its
      // own token refresh and remote clocks skew, so an mtime comparison
      // re-armed the warning forever on any active host (review-confirmed).
      // Trade: a login done OUTSIDE VibeSpace isn't detected — the ⟳ on the
      // row is the manual confirm for that case.
      const hu = this._hostOwnUsage?.[selectedHost];
      const loginAt = this._hostLoginSeenAt?.[selectedHost] || 0;
      const cacheFresh = hu?.orgEmail && (hu.fetchedAt || 0) > loginAt;
      const hEmailV = (cacheFresh ? hu.orgEmail : null) || racct?.subscription?.email;
      const hEmail = hEmailV ? escHtml(hEmailV) + ' · ' : '';
      const identStale = !!(hu?.orgEmail && loginAt && (hu.fetchedAt || 0) <= loginAt);
      const staleNote = identStale
        ? ` <span class="ob-warn" title="${escHtml(t('The login on this machine changed after the last identity/quota refresh — the cached account info may belong to the previous login. Press ⟳ to confirm.'))}">⚠ ${t('login changed — ⟳ to confirm')}</span>` : '';
      // NOT a preference ladder for the helper (2.191.0): the CLI prefers a
      // configured apiKeyHelper OVER OAuth, so when both exist the row must
      // show the helper as the effective billing, not hide it behind
      // "logged in" (CW-H200: fresh OAuth + leftover helper = API billing).
      const helperNote = racct?.keyHelper && racct?.subscription?.loggedIn
        ? ` <span class="ob-warn" title="${escHtml(t('The CLI prefers a configured apiKeyHelper over the OAuth login — sessions on this machine bill via the helper key. Remove apiKeyHelper from ~/.claude/settings.json to bill the subscription.'))}">⚠ ${t('apiKeyHelper overrides this login')}</span>` : '';
      gIdent = racct && !racct.error
        ? (racct.subscription?.loggedIn
            ? `${hEmail}<span class="ob-ok">${t('logged in')}</span>${helperNote}${staleNote}`
            : racct.cliKey?.present
            ? `<span class="ob-ok">${t('logged in')}</span> <span class="ob-ver">${t('API key')} …${escHtml(racct.cliKey.tail || '')}</span>`
            : racct.keyHelper
            ? `<span class="ob-ok">${t('logged in')}</span> <span class="ob-ver">apiKeyHelper</span>`
            : `<span class="ob-warn">${t('not logged in')}</span>`)
        : `<span class="ob-warn">${t('unreachable')}</span>`;
      // Column alignment (2.245.2, real screenshot regression): the inline
      // text buttons (⟳ / Log in on host… / Import its key) made this row's
      // .acct-key-actions a DIFFERENT width than the account rows' [★][⋯],
      // shifting the right-anchored donut cluster per row (measured 26-150px).
      // Every row now carries the same [★][⋯] pair — the host actions live
      // in the ⋯ menu, exactly like the account rows' actions (2.178.0).
      gExtraActions = `<button class="acct-icon acct-menu" title="${t('More actions')}">${DOTS}</button>`;
    } else {
      gName = t('CLI login');
      // Prefer the token-derived identity (actualEmail, baked by the quota ⟳
      // roles fetch) over the config-file email — the config goes STALE after
      // a /login switch (the 2.114.1 mixup; the usage popup already prefers
      // it, this dialog didn't — 2.188.0).
      const gEmail = this._usageGlobalIdent?.actualEmail || sub.email;
      gIdent = sub.loggedIn
        ? escHtml((gEmail || '') + (sub.plan ? (gEmail ? ' · ' : '') + sub.plan : '')) || t('logged in')
        : `<span class="ob-warn">${acct.cliKey?.present ? t('not logged in (a Console login replaced it)') : t('not logged in')}</span>`;
      // The machine's login may BE one of the named accounts (same email) —
      // say so, since their rows then show the same (merged) usage.
      const linkedSub = sub.loggedIn && gEmail
        ? claudeAccts.find(a => a.type === 'subscription' && a.email && a.email.toLowerCase() === String(gEmail).toLowerCase())
        : null;
      if (linkedSub) gIdent += ` <span class="acct-linked-hint" title="${escHtml(t('The machine login and this VibeSpace account are the same Anthropic account — usage is shown merged'))}">${t('= “{name}”', { name: escHtml(linkedSub.name) })}</span>`;
    }
    const globalRow = `<div class="acct-key-row${gDef ? ' is-default' : ''}" data-id="__global__">
      <span class="acct-type-icon" title="${selectedHost ? t("This machine's own login — lives on {host}, not in VibeSpace", { host: escHtml(hostLabel) }) : t('The CLI’s own global login on this machine')}">${GLOBE}</span>
      <span class="acct-key-main"><span class="acct-key-name">${gName}</span><span class="acct-key-tail">${gIdent}</span></span>
      <span class="acct-usage-cell">${!selectedHost && sub.loggedIn ? usageHtml(this._rateLimit, this._usageEstimates?.__global__)
        : (selectedHost && this._hostOwnUsage?.[selectedHost]?.fiveHour ? usageHtml(this._hostOwnUsage[selectedHost]) : '')}</span>
      <span class="acct-key-actions">
        <button class="acct-icon acct-def ${gDef ? 'on' : ''}" title="${gDef ? t('Default for new sessions — pick another to change') : t('Set as default for new sessions')}">${gDef ? STAR_F : STAR_O}</button>${gExtraActions}
      </span></div>`;
    // The selected host's own login identity (live probe, ⟳-cache fallback) —
    // a named subscription with the SAME email IS that login: it must not
    // read "this machine only" (real report: user logged the very account in
    // ON the machine and the roster still called it unusable). Picking a
    // linked account for a session on that host runs on the host's own login
    // (server maps it since 2.198.0 — zero creds ship).
    const hostOwnEmail = selectedHost
      ? String(racct?.subscription?.email || this._hostOwnUsage?.[selectedHost]?.orgEmail || '').trim().toLowerCase() : '';
    const acctEmailOf = (a) => String(this._accountUsage?.[a.id]?.orgEmail || a.email || (String(a.name || '').includes('@') ? a.name : '')).trim().toLowerCase();
    // Host-side per-account logins (2.199.0): ids with a live creds dir on
    // the selected host (~/.vibespace/subs/<id>) — usable there directly.
    const hostSubIds = selectedHost ? (racct?.hostSubs || []) : [];
    this._hostSubsKnown = { ...(this._hostSubsKnown || {}), ...(selectedHost ? { [selectedHost]: hostSubIds } : {}) };
    // Share the FRESH machine-login identity with the billing switcher's
    // cache (2.240.1, userN's "左右状态不一致": the roster probed the truth —
    // the host's machine login had CHANGED — while the switcher's page-old
    // warm cache kept the previous identity, labeling the WRONG account
    // "uses the host's own login". One fact, one store, freshest write wins.)
    if (selectedHost && racct) {
      this._hostOwnEmailKnown = { ...(this._hostOwnEmailKnown || {}), [selectedHost]: hostOwnEmail };
      this._hostAcctWarmAt = { ...(this._hostAcctWarmAt || {}), [selectedHost]: Date.now() };
      this._hostAcctWarmState = { ...(this._hostAcctWarmState || {}), [selectedHost]: 'done' };
      // Server-computed verdicts (B-f531) — shared into the same store the
      // billing switcher and New Session dialog read (one fact, one store)
      if (racct.verdicts) this._hostVerdicts = { ...(this._hostVerdicts || {}), [selectedHost]: racct.verdicts };
    }
    // Machine sections (2.245.0): a HOST section lists only accounts the
    // server says are USABLE there (B-f531 verdicts — never computed
    // client-side). No verdicts (host unreachable) → no named rows; the
    // CLI-login row carries the unreachable state and the note says why.
    // The LOCAL section stays the FULL roster — it is the management home
    // (rename/remove/finish-login of any account, usable anywhere or not).
    const rosterAccts = !selectedHost ? claudeAccts
      : racct?.verdicts ? claudeAccts.filter(a => racct.verdicts[a.id]?.usable) : [];
    const keyLines = rosterAccts.map(a => {
      const isDef = accts.defaultAccountId === a.id;
      const isSub = a.type === 'subscription';
      // Verdict-driven when the probe answered (B-f531): the SAME
      // evaluateOnHost the spawn uses; legacy email/dir checks as fallback.
      const v = (selectedHost && racct?.verdicts) ? racct.verdicts[a.id] || null : null;
      const linked = v ? (isSub && subBlocked && v.usable && v.how === 'host-login') : (isSub && subBlocked && !!hostOwnEmail && acctEmailOf(a) === hostOwnEmail);
      const hostSub = v ? (isSub && subBlocked && v.usable && v.how === 'host-held') : (isSub && subBlocked && !linked && hostSubIds.includes(a.id));
      // Long-lived token (B-211a): usable on any machine via the secret env
      // channel — ranked below host-held/linked by the server verdict.
      const oatDead = isSub && !!a.oat && a.oatDaysLeft <= 0;
      const viaOat = !oatDead && (v ? (isSub && v.usable && v.how === 'oat') : (isSub && !!a.oat && !selectedHost));
      const blocked = isSub && subBlocked && !linked && !hostSub && !viaOat; // subscription on a remote host, opt-in off (incl. held-identity-mismatch — Test/spawn error explains)
      // token-derived orgEmail (per-account ⟳ roles bake) beats the creds
      // dir's config email — same staleness class as the global row (2.188.0)
      const aEmail = this._accountUsage?.[a.id]?.orgEmail || a.email;
      // Machines known to hold this account's own login dir (write-through
      // from host probes — 2.204.0): lets EVERY view say "logged in on X"
      // instead of a bare local "not logged in" for host-only accounts.
      const hlNames = Object.keys(a.hostLogins || {})
        .map((hid) => this._hostNamesKnown?.[hid] || this.sidebar?._hostsData?.hosts?.find((h) => h.id === hid)?.name || hid);
      const hlTag = hlNames.length
        ? ` <span class="acct-linked-hint">${t('· logged in on {host}', { host: escHtml(hlNames.join(', ')) })}</span>` : '';
      let ident = a.pooled
        ? (a.supported === false ? `<span class="ob-warn">${t('not supported on this platform')}</span>`
          : a.current ? escHtml('→ ' + (a.currentName || a.current) + (a.email ? ' · ' + a.email : ''))
          : `<span class="ob-warn">${t('no target — pick a subscription in ⋯')}</span>`)
        : isSub
        ? (a.loggedIn ? escHtml((aEmail || '') + (a.subscriptionType ? (aEmail ? ' · ' : '') + a.subscriptionType : '')) || t('logged in')
          // Host-held login + empty LOCAL dir: "not logged in" (which is
          // about the local dir) next to "logged in on {host}" read as a
          // contradiction (real report) — the host tag carries the state.
          : hostSub ? escHtml(aEmail || '')
          : hlNames.length ? `${escHtml(aEmail || '')}${aEmail ? ' ' : ''}${hlTag}`
          : a.oat ? `${escHtml(aEmail || '')}${aEmail ? ' ' : ''}<span class="acct-linked-hint">${t('long-lived token only')}</span>`
          : `<span class="ob-warn">${t('not logged in')}</span>`)
        : `API …${escHtml(a.tail || '')} <span class="acct-master-hint" title="${t('VibeSpace holds the MASTER copy of this key; sessions get derived working copies on their machines (swept on removal). ⋯ → “Show key…” reveals the value.')}">${t('· master held by VibeSpace')}</span>`;
      // Some login flows leave the creds dir without an identity file — the
      // email is then unknowable from disk, which breaks same-account detection
      // vs the machine login (merged usage). Let the user declare/fix it.
      const hint = linked
        ? ` <span class="acct-linked-hint" title="${t('Same account as {host}’s current CLI login — sessions on {host} picking it run on the host’s own login directly (nothing is shipped).', { host: escHtml(hostLabel) })}">${t('· = {host}’s own login', { host: escHtml(hostLabel) })}</span>`
        : hostSub
        ? ` <span class="acct-linked-hint" title="${t('This account holds its own login ON {host} (minted there, never leaves it) — sessions on {host} picking it use that login.', { host: escHtml(hostLabel) })}">${t('· logged in on {host}', { host: escHtml(hostLabel) })}</span>`
        : (selectedHost && viaOat)
        ? ` <span class="acct-linked-hint" title="${t('Runs on {host} through its long-lived token (nothing rotates, no login is shipped).', { host: escHtml(hostLabel) })}">${t('· via long-lived token')}</span>`
        : blocked ? ` <span class="acct-blocked-hint" title="${a.localOnly
          ? t('This macOS Keychain-backed login stays on this machine. Log in as this account on {host} instead; copying it can invalidate rotating OAuth credentials.', { host: escHtml(hostLabel) })
          : t('Runs on this machine only. For {host}: use “Log in on {host} as this account…” in the ⋯ menu (a per-account login held on the host), or enable Settings → “Ship subscription logins to remote hosts.”', { host: escHtml(hostLabel) })}">${t('· this machine only')}</span>` : '';
      // Provenance + user note tags (2.201.0, real report: a key imported
      // from a host read as live-shared FROM it — say where it came from and
      // that it's an independent copy)
      const provTag = a.originHost
        ? ` <span class="acct-linked-hint" title="${t('Imported from {host}’s Console login — an independent copy held in VibeSpace (not linked to {host}); usable on any machine.', { host: escHtml(a.originHost) })}">${t('· from {host}', { host: escHtml(a.originHost) })}</span>` : '';
      const noteTag = a.note
        ? ` <span class="acct-blocked-hint" title="${escHtml(a.note)}">· ${escHtml(String(a.note).slice(0, 24))}${a.note.length > 24 ? '…' : ''}</span>` : '';
      // Long-lived token state: quiet while healthy, amber under 30 days,
      // red once expired (a 401 on an expired oat has no self-heal).
      const oatTag = (isSub && a.oat && (!selectedHost || oatDead))
        ? (a.oatDaysLeft <= 0
          ? ` <span class="acct-blocked-hint" style="color:var(--red,#e55)" title="${t('The long-lived token EXPIRED — sessions using it fail until you re-mint one (⋯ → Long-lived token).')}">${t('· long-lived token expired')}</span>`
          : a.oatDaysLeft <= 30
          ? ` <span class="acct-blocked-hint" title="${t('Long-lived token (used for remote machines) expires in {n} days — re-mint it in ⋯ → Long-lived token.', { n: a.oatDaysLeft })}">${t('· long-lived token · {n}d left', { n: a.oatDaysLeft })}</span>`
          : ` <span class="acct-linked-hint" title="${t('Has a long-lived token: usable on any machine (incl. paired devices) without shipping the login. Renews in {n} days.', { n: a.oatDaysLeft })}">${t('· long-lived token')}</span>`)
        : '';
      // LOGIN-SESSION expiry (2026-09-07): the chip that makes a dying login
      // visible BEFORE a turn dies on it. Pools show their members' worst.
      const loginTag = (isSub || a.pooled) ? loginExpiryChipHtml(a, { local: !selectedHost }) : '';
      const isPool = !!a.pooled;
      const iconTitle = isPool ? t('Pooled account — one billing identity auto-switching across your subscriptions')
        : isSub ? t('Subscription (Pro/Max) — runs on this machine (or a host you log into)') : t('API key — stored in VibeSpace, runs on any machine');
      // Redesign (2.178.0): rows carry ONLY the star + a ⋯ menu — Test/Rename/
      // email/Remove live in the menu (four inline buttons crushed every row,
      // modal AND panel; real screenshot report). Star stays direct: most-used.
      return `<div class="acct-key-row${isDef ? ' is-default' : ''}${blocked ? ' acct-row-blocked' : ''}" data-id="${escHtml(a.id)}" data-sub="${isSub ? '1' : ''}"${blocked ? ' data-blocked="1"' : ''}${hostSub ? ' data-hostsub="1"' : ''}${linked ? ' data-linked="1"' : ''}>
        <span class="acct-type-icon" title="${iconTitle}">${isPool ? POOL : isSub ? CROWN : KEY}</span>
        <span class="acct-key-main"><span class="acct-key-name">${escHtml(a.name)}</span><span class="acct-key-tail">${ident}${hint}</span>${(provTag || noteTag || oatTag || loginTag) ? `<span class="acct-key-extra">${provTag}${noteTag}${oatTag}${loginTag}</span>` : ''}</span>
        <span class="acct-usage-cell">${(() => {
          // Usage source follows the VERDICT's how (2.245.0): a linked account
          // runs on the host's own login (its quota IS the host quota); a
          // host-held one has its own snapshot ('<host>:<id>', ⟳ Refresh all);
          // ship/local read the local passive cache. A POOL row shows its
          // current TARGET's usage (that's what the pool bills right now),
          // dead-reckoned like any other row.
          if (isPool) {
            const tid = a.current;
            const u = tid ? this._accountUsage?.[tid] : null;
            return u ? usageHtml(u, this._usageEstimates?.[tid]) : '';
          }
          if (!isSub) return '';
          let u = null, estKey = null;
          if (selectedHost && v?.how === 'host-login') u = this._hostOwnUsage?.[selectedHost]?.fiveHour ? this._hostOwnUsage[selectedHost] : null;
          else if (selectedHost && v?.how === 'host-held') u = this._hostAccountUsage?.[selectedHost + ':' + a.id] || null;
          else if (a.loggedIn || a.oat) { u = this._accountUsage?.[a.id]; estKey = a.id; }
          return u ? usageHtml(u, estKey ? this._usageEstimates?.[estKey] : null) : '';
        })()}</span>
        <span class="acct-key-actions">
          <button class="acct-icon acct-def ${isDef ? 'on' : ''}" title="${isDef ? t('Default for new sessions — click to clear') : t('Set as default for new sessions')}">${isDef ? STAR_F : STAR_O}</button>
          <button class="acct-icon acct-menu" title="${t('More actions')}">${DOTS}</button>
        </span></div>`;
    }).join('');
    const note = selectedHost
      ? (racct?.verdicts
          ? t('Only accounts usable on {host} are listed — the full roster lives under “This machine”. The “CLI login” row is {host}’s own login.', { host: escHtml(hostLabel) })
          : t('Machine unreachable — account availability unknown. Accounts are managed under “This machine”.'))
      : t('Each session can pick its account (New Session dialog / card ⚙). Subscriptions bill your Pro/Max plan; API keys bill pay-per-use. The starred account is the default when a session doesn’t pick one.');
    left.innerHTML = `<div class="acct-list">${globalRow}${keyLines}</div>
      <div class="agents-note">${note}</div>`;
    // Redesign (2.178.0): the four Add… buttons collapse into ONE menu on the
    // roster header — they wrapped into a vertical CJK pile when narrow and
    // dominated the card even in the modal.
    const addApiKey = async () => {
      const key = await showInputDialog({ title: t('Add API key'), label: t('Anthropic API key (from console.anthropic.com)'), placeholder: 'sk-ant-…', confirmText: t('Save') });
      if (!key || !key.trim()) return;
      const name = await showInputDialog({ title: t('Name this account'), label: t('Shown in account pickers'), placeholder: t('e.g. Company API'), confirmText: t('Save') });
      try {
        const r = await fetchJson('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key.trim(), name: (name || '').trim() }) });
        if (r?.account) showToast(t('Saved: {name} — use Test once to approve the CLI’s trust prompt', { name: r.account.name }));
        else showToast(r?.error || t('Save failed'), { type: 'error' });
      } catch { showToast(t('Save failed'), { type: 'error' }); }
      refresh();
    };
    const head = document.createElement('div'); head.className = 'acct-roster-head';
    const title = document.createElement('b'); title.textContent = t('Anthropic accounts');
    const needsSetup = !selectedHost && (!sub.loggedIn || !claudeAccts.length);
    const importable = !selectedHost && acct.cliKey?.present && !acct.cliKey.imported;
    const addAcctBtn = document.createElement('button');
    addAcctBtn.className = 'agent-btn acct-add' + ((needsSetup || importable) ? ' primary' : '');
    addAcctBtn.textContent = '+ ' + t('Add account…');
    addAcctBtn.onclick = () => {
      const r = addAcctBtn.getBoundingClientRect();
      const items = [];
      if (!selectedHost) {
        // 'Set up both…' (the 2.43.0 console+subscription wizard) retired from
        // the menu in 2.268.3 (user: 没啥意义了) and DELETED in 2.327.0 —
        // pooling/named accounts made the dual-login dance obsolete, and the
        // audit confirmed zero reachable callers remained.
        if (importable) items.push({
          label: t('Import CLI key') + ` (…${acct.cliKey.tail || ''})`,
          action: async () => {
            try { const r2 = await fetchJson('/api/accounts/import-cli', { method: 'POST' }); showToast(t('Imported: {name}', { name: r2.account.name })); } catch { showToast(t('Import failed'), { type: 'error' }); }
            refresh();
          },
        });
        // separator only when something is actually above it (with the wizard
        // entry gone, a non-importable local menu otherwise led with a rule)
        if (items.length) items.push({ separator: true });
      }
      // These add to VibeSpace's store (machine-independent). With a MACHINE
      // selected, the subscription login runs ON that machine (per-host creds
      // dir) — the old always-local terminal was a trap: the dialog said the
      // host, the login quietly landed in the local store (real report).
      if (selectedHost) {
        // With a machine selected, "add" usually means "get an account ONTO
        // this machine" — offer the EXISTING subscriptions first (per-host
        // login into their own dir; picking one never mints a duplicate
        // record — real report: the always-new flow duplicated an account
        // the user already had), then the genuinely-new option.
        for (const sa of claudeAccts.filter((x) => x.type === 'subscription')) {
          if (hostSubIds.includes(sa.id)) continue; // already on this host
          if (hostOwnEmail && acctEmailOf(sa) === hostOwnEmail) continue; // IS the host's own login
          items.push({ label: t('Log in on {host} as “{name}”…', { host: hostLabel, name: sa.name }), action: () => {
            done();
            const login = remoteClaudeSubscriptionLoginCommand(sa.id);
            this._watchHostLogin(selectedHost, hostLabel, sa.id, login.attempt);
            this.openShellTerminal(undefined, { hostId: selectedHost, initialCommand: login.command });
            showToast(t('Sign in as “{name}” in the terminal — this login lives ON {host} only; the machine’s own login is untouched.', { name: sa.name, host: hostLabel }), { duration: 7000 });
          } });
        }
        items.push({ label: t('New subscription — log in on {host}…', { host: hostLabel }), action: () => { done(); this._addSubscription(selectedHost, hostLabel); } });
      } else {
        items.push({ label: t('Add subscription…'), action: () => { done(); this._addSubscription(); } });
        // Add a subscription straight as a LONG-LIVED TOKEN (B-211a) — no local
        // login needed, usable on any machine. Mints the account record then
        // opens the mint dialog directly (real request: 'why can only add oat
        // to an existing account').
        items.push({ label: t('Add subscription via long-lived token…'), action: () => { done(); this._addSubscriptionViaOat(); } });
      }
      items.push(
        { label: t('Add Console account…'), action: () => { done(); this._addConsoleAccount(); } },
        { label: t('Add API key…'), action: addApiKey },
      );
      // Pooled pseudo-account (local only): one switchable identity over the
      // logged-in subscriptions. Needs at least one to point at.
      if (!selectedHost && claudeAccts.some((x) => x.type === 'subscription' && x.loggedIn)) {
        items.push({ separator: true }, { label: t('Add pooled account…'), action: () => { done(); this._createPoolDialog('claude', refresh); } });
      }
      // Machine-wide login lives HERE when it's down but named accounts run
      // the show (2.268.4): the backend row hides its "Log in" then — two
      // primary green buttons (Log in / Add account) read as look-alikes.
      if (!selectedHost && st?.claude?.installed && !st.claude.loggedIn && (st.claude.namedLoggedIn || 0) > 0) {
        const cmd = st.claude.cmdPath ? `"${st.claude.cmdPath}"` : 'claude';
        items.push({ separator: true }, {
          label: t('Log in machine-wide (claude /login)…'),
          action: () => { done(); run(cmd); },
        });
      }
      showContextMenu(r.left, r.bottom + 4, items);
    };
    head.append(title, addAcctBtn);
    if (ctx.stale?.()) return; // a newer refresh took over mid-await
    row.append(head, left);
    body.appendChild(row);
    // Per-key row actions (event delegation on the section)
    // The login chip is role=button: Enter/Space must do what a click does.
    left.onkeydown = (e) => { const c = (e.key === 'Enter' || e.key === ' ') && e.target.closest?.('.acct-login-chip'); if (c) { e.preventDefault(); c.click(); } };
    left.onclick = async (e) => {
      const keyRow = e.target.closest?.('.acct-key-row');
      if (!keyRow) return;
      const id = keyRow.dataset.id;
      // The peer CLI-login row: default star + (host sections) a ⋯ menu —
      // the host actions moved OFF the row into the menu in 2.245.2 so every
      // row's actions column is the same [★][⋯] width (donut alignment).
      if (id === '__global__') {
        const doHostLogin = async () => {
          // Runs ON the selected host (run() targets it) — lands in the
          // host's own ~/.claude, NOT in VibeSpace's store. That REPLACES
          // the machine's current login, which read too much like "add
          // account" (real report: user expected an add, got the machine
          // login swapped) — confirm with the semantics spelled out, and
          // save a not-yet-imported Console key on the host into VibeSpace
          // FIRST so the swap can't orphan it. The watcher then polls the
          // host's login state (read-only ssh probe) and brings the Agents
          // surface back once the login lands.
          const hasKey = racct?.cliKey?.present && !importedTails.has(racct.cliKey.tail);
          const okGo = await showConfirmDialog({
            title: t('Switch {host}’s own login?', { host: hostLabel }),
            message: t('This opens claude /login ON {host} and REPLACES that machine’s current CLI login. VibeSpace’s named accounts are untouched — to add a switchable account instead, use “+ Add account…”.', { host: hostLabel })
              + (hasKey ? ' ' + t('The Console API key currently on it (…{tail}) will be imported into VibeSpace first so it isn’t lost.', { tail: racct.cliKey.tail }) : ''),
            confirmText: t('Open login terminal'),
          });
          if (!okGo) return;
          if (hasKey) {
            try {
              const r = await fetchJson('/api/accounts/import-cli-host', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostId: selectedHost }) });
              if (r?.account) showToast(t('Imported: {name}', { name: r.account.name }));
            } catch { /* best-effort — the dialog already told the user */ }
          }
          this._watchHostLogin(selectedHost, hostLabel);
          run('claude /login');
        };
        const doHostRefresh = async () => {
          try {
            const r = await fetchJson('/api/usage/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: selectedHost }) });
            if (r?.error) showToast(r.error, { type: 'error', duration: 6000 });
            else if (r?.throttled) showToast(t('Refreshed less than a minute ago — try again shortly'), { type: 'error' });
          } catch { showToast(t('Refresh failed'), { type: 'error' }); }
          refresh();
        };
        const doHostImport = async () => {
          try {
            const r = await fetchJson('/api/accounts/import-cli-host', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostId: selectedHost }) });
            if (r?.account) showToast(t('Imported: {name}', { name: r.account.name })); else showToast(r?.error || t('Import failed'), { type: 'error' });
          } catch { showToast(t('Import failed'), { type: 'error' }); }
          refresh();
        };
        if (e.target.closest('.acct-menu')) {
          const r = e.target.closest('.acct-menu').getBoundingClientRect();
          const items = [];
          if ((this.settings.get('accounts.onDemandQuotaRefresh') || 'manual') !== 'off') {
            items.push({ label: t('Refresh quota'), title: t('Confirm identity + quota of {host}’s own login (one on-demand read of its token — never scheduled)', { host: hostLabel }), action: doHostRefresh });
          }
          items.push({ label: t('Log in on {host}…', { host: hostLabel }), title: t('Opens a terminal ON {host} — this login lands on that machine, not in VibeSpace', { host: hostLabel }), action: doHostLogin });
          if (racct?.cliKey?.present && !importedTails.has(racct.cliKey.tail)) {
            items.push({ label: t('Import its key'), title: t('Copy the Console key found on {host} (…{tail}) into VibeSpace so any machine can use it', { host: hostLabel, tail: racct.cliKey.tail }), action: doHostImport });
          }
          showContextMenu(r.left, r.bottom + 4, items);
        } else if (e.target.closest('.acct-def')) {
          try { await api('/api/accounts/default', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: null }) }); }
          catch (err) { showToast(t('Could not change the default account — {reason}', { reason: err?.message || t('server unreachable') }), { type: 'error' }); }
          refresh();
        }
        return;
      }
      const a = claudeAccts.find(x => x.id === id);
      const isSub = a?.type === 'subscription';
      const doTest = () => {
        // LINKED account (2.237.3, userN's report "Test says not signed in"):
        // this account's email IS the selected host's own login, so on that
        // host it needs NO local creds and NO shipped dir — the correct spawn
        // is the CLI-login sentinel. The switcher/New-Session dialog already
        // model this (2.208.0); the Test guard was the last place still
        // treating an empty LOCAL creds dir as "not signed in".
        const linkedHere = isSub && !!keyRow.dataset.linked && !!selectedHost;
        // A not-logged-in subscription can't spawn — the server would
        // reject the create and leave a blank window. Guard it here.
        // EXCEPT host-held logins (2.203.0): the LOCAL dir is empty by
        // design; the spawn resolves against the host-side dir. And EXCEPT
        // any remote test at all (2.243.2, userN's "still says not signed
        // in"): dataset.hostsub/linked come from page caches that start COLD —
        // with a host selected the server resolves against live host facts
        // and errors honestly, so the client must not veto on stale data.
        if (isSub && !a.loggedIn && !a.oat && !selectedHost && !keyRow.dataset.hostsub && !linkedHere) {
          showToast(t('This subscription isn’t signed in yet — use “Add subscription…” to finish the login first.'), { type: 'error' });
          return;
        }
        // §ban-safety: a subscription can't run on a remote host by default.
        // Explain instead of firing a create the server will reject.
        if (keyRow.dataset.blocked) {
          showToast((a?.localOnly
            ? t('This macOS Keychain-backed login stays on this machine. Log in as this account on {host} instead; copying it can invalidate rotating OAuth credentials.', { host: escHtml(hostLabel) })
            : t('“{name}” runs on this machine only. For {host}, use “Log in on host…” on the CLI-login row, or turn on Settings → “Ship subscription logins to remote hosts.”', { name: a?.name, host: escHtml(hostLabel) }))
            + ' ' + t('Already logged in as this account ON {host}? Then pick “CLI login @ {host}” when switching the session’s billing — that uses the host’s own login.', { host: escHtml(hostLabel) }), { type: 'error', duration: 8000 });
          return;
        }
        done();
        // Diagnostic session — ephemeral (closing its window terminates it).
        // With a remote host selected it runs ON that host. ALWAYS the real
        // account id (2.243.1, userN's inc-msghecvm-5ym8): the old
        // client-side linked→CLI-login-sentinel mapping spawned on the host's
        // CURRENT machine login — when that login had rotated to a different
        // account since the client's cache, "Test ClaudeLu" showed the OTHER
        // account signed in. The server resolves the id against LIVE host
        // facts (email-linked → host login; host-held dir → that dir), so the
        // test shows the account it claims to test. §ban-safety unaffected —
        // both server paths ship zero creds.
        this.createSession({ backend: 'claude', mode: 'terminal', cwd: '', accountId: id, ephemeral: true, hostId: selectedHost || undefined });
        // /status DISPLAY caveat (2.244.2, verified forensically on Novita:
        // the spawn refreshed the HELD dir's token — billing correct — while
        // /status Organization/Email showed the MACHINE login): the CLI reads
        // its identity display from the non-relocated ~/.claude.json, so for
        // a host-held login the display lies while the TOKEN (= billing) is
        // the held account's. Say so before the user reads /status and files
        // a wrong-account report.
        const vTest = selectedHost ? this._hostVerdicts?.[selectedHost]?.[id] : null;
        if (vTest?.usable && vTest.how === 'host-held') {
          showToast(t('This test bills “{name}” via its login held on {host}. Note: claude’s /status will show the MACHINE’s identity there — that display doesn’t follow relocated logins; the billed account is “{name}”.', { name: a?.name, host: escHtml(hostLabel) }), { duration: 14000 });
        }
      };
      const doEmail = async () => {
        const email = await showInputDialog({
          title: t('Account email'),
          label: t('Email of this Anthropic account. Used to recognize when it is the same account as a machine login (their usage then shows merged).'),
          value: a?.email || '', placeholder: 'you@example.com', confirmText: t('Save'),
        });
        if (email != null) {
          // api(), not fetchJson: fetchJson NEVER throws (null on failure,
          // {error} bodies handed back as data), so the old try/catch was dead
          // code and a rejected write silently no-op'd — refresh() repainted
          // the OLD value and the user never learned why it didn't take.
          try { await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim() }) }); }
          catch (err) { showToast(t('Could not save the email — {reason}', { reason: err?.message || t('server unreachable') }), { type: 'error' }); }
          refresh();
        }
      };
      const doRename = async () => {
        const name = await showInputDialog({ title: t('Rename account'), label: t('Account name'), value: a?.name || '', confirmText: t('Save') });
        if (name && name.trim() && name.trim() !== a?.name) {
          try { await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }); }
          catch (err) { showToast(t('Rename failed — {reason}', { reason: err?.message || t('server unreachable') }), { type: 'error' }); }
          refresh();
        }
      };
      const doDelete = async () => {
        // API keys: the store holds the ONLY copy VibeSpace has, the roster
        // is shared by every machine view, and Anthropic's Console never
        // re-shows a key's full value — deleting is effectively final (real
        // incident: a rescued key removed "from the local view" was gone
        // from the devbox's view too, and recoverable only from a rotating CLI
        // backup). Say all of that before acting.
        const msg = isSub
          ? t('Remove "{name}" from VibeSpace? Sessions already running keep working; the key itself stays valid.', { name: a?.name })
          : t('Remove "{name}"? The roster is one shared list — this deletes the MASTER key copy held by VibeSpace (it disappears from every machine’s view) and sweeps the per-session working copies it placed on hosts. The Anthropic Console cannot re-show an existing key’s value, so make sure it’s saved elsewhere first. Running sessions keep working.', { name: a?.name });
        if (!(await showConfirmDialog({ title: t('Remove account'), message: msg }))) return;
        try { await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }); showToast(t('Removed “{name}”', { name: a?.name || '' })); }
        catch (err) { showToast(t('Could not remove the account — {reason}', { reason: err?.message || t('server unreachable') }), { type: 'error' }); }
        refresh();
      };
      const doNote = async () => {
        const note = await showInputDialog({
          title: t('Account note'),
          label: t('Shown as a small tag on the account row (e.g. “from laptop backup”). Empty clears it.'),
          value: a?.note || '', confirmText: t('Save'),
        });
        if (note != null) {
          try { await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: note.trim() }) }); }
          catch (err) { showToast(t('Could not save the note — {reason}', { reason: err?.message || t('server unreachable') }), { type: 'error' }); }
          refresh();
        }
      };
      // The chip IS the re-login button (no new flow — it runs exactly what
      // the ⋯ menu's "Re-login on this machine…" runs). A pool's chip carries
      // the MEMBER id, so it re-logs in the account that is actually dying.
      const chip = e.target.closest?.('.acct-login-chip');
      if (chip) {
        const target = chip.dataset.relogin || id;
        const targetAcct = (accts.accounts || []).find((x) => x.id === target) || a;
        this._reloginSubscription(target, targetAcct, refresh);
        return;
      }
      if (e.target.closest('.acct-def')) {
        const isDef = accts.defaultAccountId === id;
        // Default is GLOBAL — starring a "this machine only" subscription
        // while a host is selected read as "I switched the remote's account"
        // when it actually set a default that host can never use (2.188.0)
        if (keyRow.dataset.blocked && !isDef) {
          showToast(t('The default is global, and “{name}” can’t run on {host} — new sessions there keep using its own login.', { name: a?.name, host: escHtml(hostLabel) }) + ' ' + t('Already logged in as this account ON {host}? Then pick “CLI login @ {host}” when switching the session’s billing — that uses the host’s own login.', { host: escHtml(hostLabel) }), { type: 'error', duration: 8000 });
          return;
        }
        try { await api('/api/accounts/default', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: isDef ? null : id }) }); }
        catch (err) { showToast(t('Could not change the default account — {reason}', { reason: err?.message || t('server unreachable') }), { type: 'error' }); }
        refresh();
      } else if (e.target.closest('.acct-menu')) {
        // Redesign (2.178.0): Test/Rename/email/Remove live behind ⋯
        const r = e.target.closest('.acct-menu').getBoundingClientRect();
        const items = [
          { label: t('Test'), action: doTest },
          { label: t('Rename account'), action: doRename },
        ];
        // pool: Switch target / Members / Auto-switch / Hot - ONE block shared
        // with the Codex roster (_poolMenuItems, 2.369.18)
        if (a?.pooled && !selectedHost) items.splice(0, 1, ...this._poolMenuItems(id, a, refresh));
        // Per-account login held ON the host (2.199.0): mint this account's
        // own creds dir on the selected machine via an on-host interactive
        // login (~/.vibespace/subs/<id> — the token is born there and never
        // leaves; §ban-safety-clean, unlike shipping). Coexists with the
        // machine's global login. Once it lands, sessions on that host can
        // pick this account directly.
        if (isSub && selectedHost && keyRow.dataset.blocked) {
          items.splice(1, 0, { label: t('Log in on {host} as this account…', { host: hostLabel }), action: () => {
            const login = remoteClaudeSubscriptionLoginCommand(id);
            this._watchHostLogin(selectedHost, hostLabel, id, login.attempt);
            run(login.command);
            showToast(t('Sign in as “{name}” in the terminal — this login lives ON {host} only; the machine’s own login is untouched.', { name: a?.name, host: hostLabel }), { duration: 7000 });
          } });
        }
        // Re-login on THIS machine (2.332.0): most useful when the row shows
        // signed-out (idle refresh-token expiry, external revocation) — but
        // also offered while logged in, for rotating to a different login.
        if (isSub && !a?.pooled && !selectedHost) {
          items.splice(1, 0, { label: a?.loggedIn ? t('Re-login on this machine…') : t('Log in on this machine…'), action: () => this._reloginSubscription(id, a, refresh) });
        }
        if (isSub && !a?.pooled) items.push({ label: a?.oat ? (a.oatDaysLeft <= 0 ? t('Long-lived token (expired)…') : t('Long-lived token (active)…')) : t('Long-lived token…'), action: () => this._oatDialog(id, a, refresh) });
        if (isSub && a.loggedIn && (!a.email || a.emailDeclared)) items.push({ label: a.email ? t('edit email') : t('set email…'), action: doEmail });
        items.push({ label: a?.note ? t('Edit note…') : t('Set note…'), action: doNote });
        // Reveal the key value (API keys only) — the store holds the MASTER
        // copy and the Console can never re-show it; users need a way to
        // save it elsewhere (real incident: removed key ≈ lost key). A POOLED
        // account has no key (it rendered "Show key…" once — real report).
        if (!isSub && !a?.pooled) items.push({ label: t('Show key…'), action: async () => {
          try {
            const r2 = await fetchJson(`/api/accounts/${encodeURIComponent(id)}/key`);
            if (!r2?.key) { showToast(r2?.error || t('Could not read the key'), { type: 'error' }); return; }
            const act = await showInputDialog({
              title: t('API key — {name}', { name: a?.name }),
              label: t('The full key value (the MASTER copy held by VibeSpace). Save it in a password manager — the Anthropic Console cannot re-show it.'),
              value: r2.key, confirmText: t('Copy'),
            });
            if (act != null) { copyText(r2.key); showToast(t('Copied')); }
          } catch { showToast(t('Could not read the key'), { type: 'error' }); }
        } });
        items.push(...this._rulesAndChecksItems('claude', { accountId: id, accountName: a?.name || '', selectedHost }));
        items.push({ separator: true }, { label: t('Remove account'), action: doDelete });
        showContextMenu(r.left, r.bottom + 4, items);
      }
    };
  },
  });
}
