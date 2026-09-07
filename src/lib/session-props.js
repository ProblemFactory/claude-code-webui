import { escHtml, copyText, showConfirmDialog, taskGroupColor } from './utils.js';
import { SESSION_STATE_META, SESSION_URGENCY_META } from './sidebar-tasks.js';
import { getBackendMeta, getAgentKindMeta, getAgentRoleLabel, responseStyleCaps } from './agent-meta.js';
import { t } from './i18n.js';
import { registerOpenAction } from './window-types.js';

/**
 * Session Properties window — the FULL view of everything VibeSpace knows
 * about one session (活儿): identity, connection, billing, per-session config,
 * Task Group membership, agent TODO steps, and the status history timeline.
 * The card stays a glanceable summary; this window is the reference sheet.
 *
 * Live-synced: re-renders on active-sessions / tasks-updated /
 * session-status-updated broadcasts (read-only layout — no focus guard
 * needed except the account select, which re-applies its value).
 * openSpec `openSessionProps` replays across clients/restores.
 */
export function openSessionProps(app, sessionRef, { syncId } = {}) {
  const sidebar = app.sidebar;
  const refKey = typeof sessionRef === 'string' ? sessionRef : sidebar._getSessionStateKey(sessionRef);
  const findSession = () =>
    (sidebar._allSessions || []).find(x => sidebar._getSessionStateKey(x) === refKey)
    || (typeof sessionRef === 'object' ? sessionRef : null);
  const s0 = findSession();
  if (!s0) return null;

  const existing = [...app.wm.windows.values()].find(w => w._sessionPropsKey === refKey);
  if (existing) { app.wm.focusWindow(existing.id); return existing; }

  const openSpec = { action: 'openSessionProps', sessionKey: refKey, cwd: s0.cwd || '', name: s0.name || '' };
  const winInfo = app.wm.createWindow({
    title: (sidebar.getCustomName(s0) || s0.name || t('Session')) + t(' — Properties'),
    type: 'task', syncId, openSpec, width: 440, height: 620,
  });
  winInfo._sessionPropsKey = refKey;

  const root = document.createElement('div');
  root.className = 'task-detail session-props';
  winInfo.content.appendChild(root);

  const render = () => {
    const s = findSession();
    if (!s) { root.innerHTML = `<div class="empty-hint">${escHtml(t('Session no longer known (transcript gone from discovery).'))}</div>`; return; }
    // Don't clobber an open native select the user is interacting with
    if (root.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
    root.innerHTML = '';
    const customName = sidebar.getCustomName(s);
    const displayName = customName || s.name || s.webuiName || (s.cwd || '').split('/').pop() || s.sessionId;
    app.wm.setTitle(winInfo.id, displayName + t(' — Properties'));

    const section = (label) => {
      const el = document.createElement('div');
      el.className = 'task-detail-section';
      el.innerHTML = `<div class="task-detail-label">${escHtml(label)}</div>`;
      root.appendChild(el);
      return el;
    };
    const row = (parent, label, valueHtml, { copy } = {}) => {
      const r = document.createElement('div');
      r.className = 'session-detail-row';
      r.innerHTML = `<span class="session-detail-label">${escHtml(label)}</span>`;
      const v = document.createElement('span');
      v.className = 'session-detail-value';
      v.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      v.innerHTML = valueHtml;
      if (copy) {
        v.classList.add('session-detail-copyable');
        v.dataset.tip = t('Click to copy');
        v.onclick = () => { copyText(copy); v.dataset.tip = t('Copied!'); setTimeout(() => { v.dataset.tip = t('Click to copy'); }, 900); };
      }
      r.appendChild(v);
      parent.appendChild(r);
      return r;
    };

    // ── Identity ──
    const idSec = section(t('Identity'));
    row(idSec, t('Name'), escHtml(displayName) + (customName ? ` <span class="sp-dim-note">${escHtml(t('(custom)'))}</span>` : ''));
    row(idSec, t('ID'), escHtml(s.sessionId || ''), { copy: s.sessionId || '' });
    const bm = getBackendMeta(s.backend || 'claude');
    const agentBits = [bm.label, (s.agentKind && s.agentKind !== 'primary') ? getAgentKindMeta(s.agentKind).label : null, getAgentRoleLabel(s.agentRole), s.agentNickname || null].filter(Boolean).join(' / ');
    row(idSec, t('Agent'), escHtml(agentBits));
    row(idSec, t('Mode'), escHtml(s.webuiMode || s.mode || 'terminal'));
    if (s.hostName) row(idSec, t('Machine'), escHtml(s.hostName));
    row(idSec, t('CWD'), escHtml((s.cwd || '').replace(/^\/home\/[^/]+/, '~')), { copy: s.cwd || '' });
    if (s.startedAt) row(idSec, t('Started'), escHtml(new Date(s.startedAt).toLocaleString()));
    const connLabel = { live: t('LIVE (VibeSpace-managed)'), tmux: t('Running in tmux'), external: t('Running externally'), stopped: t('Stopped') }[s.status] || s.status;
    row(idSec, t('Connection'), escHtml(connLabel) + (s.pid ? ` <span style="color:var(--text-dim)">PID ${escHtml(String(s.pid))}</span>` : ''));

    // ── State (current + change) ──
    const stSec = section(t('State'));
    const st = sidebar.getSessionStatus?.(s);
    const meta = st?.state ? (SESSION_STATE_META[st.state] || { label: st.state, color: 'var(--text-dim)' }) : null;
    const urgMark = st?.urgency ? (SESSION_URGENCY_META[st.urgency]?.mark || '') : '';
    const stRow = document.createElement('div');
    stRow.className = 'session-detail-row';
    stRow.innerHTML = `<span class="session-detail-label">${escHtml(t('Now'))}</span>
      <span class="session-detail-value" style="flex:1">${meta
        ? `<span style="color:${meta.color};font-weight:600">${escHtml(meta.label)}${urgMark ? ' ' + urgMark : ''}</span>${st.reason ? ` <span style="color:var(--text-dim)">— ${escHtml(st.reason)}</span>` : ''} <span class="sp-dim-note">(${st.setBy === 'agent' ? escHtml(t('agent')) : escHtml(t('you'))})</span>${st.detail ? `<details class="sp-status-detail"><summary>${escHtml(t('detail'))}</summary><div>${escHtml(st.detail)}</div></details>` : ''}`
        : `<span style="color:var(--text-dim)">${escHtml(t('none declared'))}</span>`}</span>`;
    const chg = document.createElement('button');
    chg.className = 'task-detail-btn';
    chg.textContent = t('Change…');
    chg.onclick = () => sidebar._showSessionStatusPopover?.(chg, s);
    stRow.appendChild(chg);
    stSec.appendChild(stRow);
    // History timeline
    const histList = document.createElement('div');
    histList.className = 'session-history-list';
    histList.style.marginTop = '4px';
    histList.innerHTML = `<div class="empty-hint" style="padding:2px 0">${escHtml(t('Loading history…'))}</div>`;
    stSec.appendChild(histList);
    const keys = [refKey, s.webuiId ? 'webui:' + s.webuiId : null].filter(Boolean).join(',');
    fetch(`/api/session-status/history?sessionKey=${encodeURIComponent(keys)}`).then(r => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText || 'request failed'}`);
      return r.json();
    }).then(d => {
      if (!histList.isConnected) return;
      const hist = (d?.history || []).slice(-20).reverse();
      histList.innerHTML = hist.length ? '' : `<div class="empty-hint" style="padding:2px 0">${escHtml(t('No status changes recorded yet'))}</div>`;
      const today = new Date().toDateString();
      for (const h of hist) {
        const li = document.createElement('div');
        li.className = 'session-history-item';
        const when = new Date(h.at);
        const tm = (when.toDateString() === today ? '' : (when.getMonth() + 1) + '/' + when.getDate() + ' ') + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const m = h.state ? (SESSION_STATE_META[h.state] || { label: h.state, color: 'var(--text-dim)' }) : null;
        li.innerHTML = `<span class="session-history-time">${escHtml(tm)}</span>`
          + `<span class="session-history-dot" style="--h-color:${m ? m.color : 'var(--text-dim)'}"></span>`
          + `<span class="session-history-state">${escHtml(h.cleared ? t('cleared') : (m?.label || ''))}</span>`
          + (h.reason ? `<span class="session-history-reason" title="${escHtml(h.reason)}">${escHtml(h.reason)}</span>` : '')
          + `<span class="session-history-by">${h.setBy === 'user' ? escHtml(t('you')) : escHtml(t('agent'))}</span>`;
        histList.appendChild(li);
      }
    }).catch((e) => {
      // A permanent "Loading history…" is indistinguishable from an op still
      // in progress — terminate the section honestly and let the broadcast-
      // driven re-render be the retry.
      if (!histList.isConnected) return;
      histList.innerHTML = `<div class="usage-warn" style="padding:2px 0">${escHtml(t('Couldn’t load the status history — {reason}', { reason: e?.message || t('server unreachable') }))}</div>`;
    });

    // ── Billing ──
    const bilSec = section(t('Billing'));
    const a = s.auth;
    const authLabel = !a || a.source === 'subscription' ? (a?.guessed ? t('Subscription (estimated from login state at spawn)') : t('Subscription (Pro/Max plan)'))
      : a.source === 'api-key' ? t('API key — {name}{tail} · pay per use{est}', { name: a.name || 'key', tail: a.tail ? ' (…' + a.tail + ')' : '', est: a.guessed ? t(' (estimated)') : '' })
      : a.source === 'api-console' ? t('API — Console login · pay per use{est}', { est: a.guessed ? t(' (estimated)') : '' })
      : a.source === 'api-other' ? t('API — {detail} · pay per use', { detail: a.detail || t('other key source') })
      // pooled (claude or codex) + the two codex shapes fell through to
      // "Unknown (started before tracking)" — a labeled identity is never
      // unknown (2.369.18)
      : a.source === 'pooled' ? t('Pooled account — {name}', { name: a.name || t('Pool') }) + (a.poolTarget ? ' → ' + a.poolTarget : ' · ' + t('no target'))
      : a.source === 'codex-subscription' ? t('ChatGPT account — {name}', { name: a.name || 'ChatGPT' })
      : a.source === 'codex-cli' ? t('ChatGPT login (the machine’s own)')
      : t('Unknown (started before tracking)');
    // remote session: the login is the HOST's — name the machine (2.188.0)
    const authLabelHost = a?.hostName ? authLabel + ' · @ ' + a.hostName : authLabel;
    row(bilSec, t('This run'), (a && a.source?.startsWith('api')) ? `<span style="color:var(--yellow,#e5c07b)">${escHtml(authLabelHost)}</span>` : escHtml(authLabelHost));
    // Account override for the NEXT resume
    const acctRow = document.createElement('div');
    acctRow.className = 'session-detail-row';
    acctRow.innerHTML = `<span class="session-detail-label">${escHtml(t('On resume'))}</span>`;
    const acctSel = document.createElement('select');
    acctSel.className = 'session-config-select';
    acctSel.style.flex = '1';
    const savedCfg = sidebar.getSessionConfig?.(s) || {};
    const sbe = s.backend || 'claude';
    const accts = (app._accounts?.accounts || []).filter(x => (x.backend || 'claude') === sbe);
    const globalLabel = sbe === 'codex' ? t('ChatGPT login') : t('Subscription');
    // Remote session: subscription accounts can't spawn there (dial: never;
    // ssh: only with the ship opt-in) — offering them was fail-late (2.188.0)
    const rHost = s.host || null;
    const rTransport = rHost ? (sidebar._hostsData?.hosts?.find(h => h.id === rHost)?.transport || 'ssh') : null;
    const shipSubs = !!app.settings?.get?.('accounts.shipSubscriptionToRemote');
    // SERVER-COMPUTED verdicts are the ONE authority (B-f531): this surface
    // used to recompute linked/held here from page caches that start COLD and
    // that NOTHING on this window ever warmed — so on a fresh page a remote
    // session's Properties disabled every host-held/linked subscription as
    // "blocked on this host" and only un-greyed if some OTHER surface happened
    // to probe (the 2.239.2 cold-page lie, and it missed every verdict-only
    // reason: held-identity-mismatch, oat rungs, not-on-this-host).
    if (rHost) app._warmHostAccountCache?.(rHost); // TTL-guarded; the broadcast-driven re-render picks up the answer
    const vOf = (x) => (rHost ? app._hostVerdicts?.[rHost]?.[x.id] : null) || null;
    const warmState = rHost ? app._hostAcctWarmState?.[rHost] : null;
    // gated on the warm state: a pre-verdict server sends no `verdicts` at
    // all, and a bare absence test would claim "checking…" forever there
    const verdictsCold = !!rHost && !app._hostVerdicts?.[rHost] && (warmState === 'pending' || warmState === 'error');
    // linked/held accounts run on the host's own/held login — never blocked
    // (PR #23 brought session-props up to the switcher's semantics); a valid
    // long-lived token keeps its own exemption (B-211a); macOS Keychain-
    // backed logins (localOnly) can never ship regardless of the opt-in.
    const hostOwnEmail = rHost
      ? String(app._hostOwnUsage?.[rHost]?.orgEmail || app._hostOwnEmailKnown?.[rHost] || '').trim().toLowerCase()
      : '';
    const acctEmailOf = (x) => String(x.email || (String(x.name || '').includes('@') ? x.name : '')).trim().toLowerCase();
    const hostLinked = (x) => { const v = vOf(x); if (v) return v.usable && v.how === 'host-login'; return sbe !== 'codex' && !!hostOwnEmail && acctEmailOf(x) === hostOwnEmail; };
    const hostSubHeld = (x) => { const v = vOf(x); if (v) return v.usable && v.how === 'host-held'; return sbe !== 'codex' && (app._hostSubsKnown?.[rHost] || []).includes(x.id); };
    const subBlocked = (x) => {
      const v = vOf(x);
      if (v) return !v.usable; // verdict is authoritative — the same call the spawn makes
      return (x.oat && !(x.oatDaysLeft <= 0)) ? false : (rHost
        && (sbe === 'codex' || x.type === 'subscription')
        && !hostLinked(x)
        && !hostSubHeld(x)
        && (rTransport === 'dial' || !shipSubs || x.localOnly));
    };
    // Suffix + tooltip for a blocked row: verbatim from the verdict when we
    // have one, honest about being a GUESS while the probe is out.
    const blockedNote = (x) => {
      const v = vOf(x);
      if (v?.reason === 'held-identity-mismatch') return [t('host login belongs to {email}', { email: v.dirEmail || '?' }), t('The login held on this machine for this account belongs to someone else — re-run “Log in on host as this account”.')];
      if (v?.reason === 'not-on-this-host') return [t('not logged in on this machine'), t('This account is signed in elsewhere — log it in on this machine, or run the session where it is signed in.')];
      if (v?.reason === 'never-signed-in') return [t('never finished signing in'), t('Complete this account’s login in Manage agents first.')];
      if (v?.reason === 'oat-expired') return [t('long-lived token expired'), t('Re-mint it in Manage agents (⋯ → Long-lived token).')];
      if (v?.reason === 'pool-local-only') return [t('this machine only'), t('Pooled accounts run on the local machine only.')];
      if (verdictsCold) {
        return warmState === 'error'
          ? [t('availability unknown'), t('Couldn’t reach this session’s machine to check which accounts it can use — this row is a guess from cached data.')]
          : [t('checking…'), t('Still checking which accounts this session’s machine can use — this row is a guess until it answers.')];
      }
      return [t('blocked on this host'), t('Subscription logins don’t ship to this machine — log in there, or use an API-key account')];
    };
    for (const [v, label, blocked, acctRec] of [['', t('Default')], ['subscription', globalLabel], ...accts.map(x => [x.id, x.type === 'subscription' ? `${x.name} (${t('subscription')})` : `${x.name} — API …${x.tail}`, subBlocked(x), x])]) {
      const o = document.createElement('option'); o.value = v;
      if (blocked) {
        const [why, tip] = blockedNote(acctRec || {});
        o.textContent = label + ' · ' + why;
        o.disabled = true; o.title = tip;
      } else o.textContent = label;
      acctSel.appendChild(o);
    }
    acctSel.value = [...acctSel.options].some(o => o.value === (savedCfg.account || '')) ? (savedCfg.account || '') : '';
    acctSel.onchange = () => sidebar.setSessionConfig?.(s, { ...(sidebar.getSessionConfig?.(s) || {}), account: acctSel.value });
    acctRow.appendChild(acctSel);
    bilSec.appendChild(acctRow);

    // ── Config overrides (summary; edit via the card ⚙) ──
    const cfg = sidebar.getSessionConfig?.(s) || {};
    const cfgBits = ['model', 'effort', 'permission'].filter(k => cfg[k]).map(k => `${k}: ${cfg[k]}`);
    const cfgSec = cfgBits.length ? section(t('Config overrides')) : null;
    if (cfgSec) row(cfgSec, t('Saved'), escHtml(cfgBits.join(' · ')));

    // ── Response style, EFFECTIVE + its ORIGIN (2.369.54) ──
    // Two different facts, and the panel says which is which: `s.outputStyle`
    // is what the LIVE session actually runs with (server truth, null = no key
    // was ever sent), `cfg.outputStyle` is the pick saved for this conversation.
    // Before this, a codex session silently ran a hardcoded 'pragmatic' while
    // the panel showed nothing at all.
    const rsCaps = responseStyleCaps(s.backend || 'claude');
    if (rsCaps.values.length) {
      const live = s.outputStyle || '';           // server truth for a LIVE session ('' = no key was ever sent)
      const picked = cfg.outputStyle;             // undefined = never picked here
      // Three different facts, said apart. A STOPPED session has no live value
      // at all, so a saved pick must not be reported as "the harness default".
      const shown = live || (picked || '');
      const origin = live
        ? (picked ? t('your choice for this session') : t('instance default'))
        : (picked ? t('saved \u2014 applies on the next resume')
          : t('harness default \u2014 the agent\u2019s own config decides'));
      const pendBit = (live && picked !== undefined && (picked || '') !== live)
        ? ` <span class="chat-status-dim">${escHtml(t('(saved: {v} \u2014 applies on the next resume)', { v: picked || t('agent default') }))}</span>` : '';
      row(cfgSec || section(t('Config overrides')), t('Response style'),
        `${escHtml(shown || t('agent default'))} <span class="chat-status-dim">${escHtml('(' + origin + ')')}</span>${pendBit}`);
    }

    // ── Task Groups (explicit toggles; folder-derived shown, not toggleable) ──
    const tgSec = section(t('Task Groups'));
    const explicitIds = new Set((sidebar._getSessionTasks?.(s) || []).map(t => t.id));
    const belonged = sidebar._getSessionTaskGroups?.(s) || [];
    const byId = new Map(belonged.map(t => [t.id, t]));
    for (const g of (sidebar._tasks || []).filter(x => !x.archived)) {
      const isExplicit = explicitIds.has(g.id);
      const viaFolder = !isExplicit && byId.has(g.id);
      const lbl = document.createElement('label');
      lbl.className = 'session-props-group';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isExplicit || viaFolder;
      cb.disabled = viaFolder; // dynamic membership — remove the folder link instead
      cb.onchange = () => { cb.checked ? sidebar._taskBind(g.id, s) : sidebar._taskUnbind(g.id, s); };
      const txt = document.createElement('span');
      txt.textContent = g.title + (viaFolder ? t(' (folder)') : '');
      {
        const c = app.sidebar?.getTaskColor ? app.sidebar.getTaskColor(g) : taskGroupColor(g);
        if (c) { const dot = document.createElement('span'); dot.className = 'tvg-dot'; dot.style.setProperty('--g-color', c); lbl.append(cb, dot, txt); }
        else lbl.append(cb, txt);
      }
      tgSec.appendChild(lbl);
    }
    if (!(sidebar._tasks || []).filter(t => !t.archived).length) tgSec.insertAdjacentHTML('beforeend', `<div class="empty-hint">${escHtml(t('No Task Groups yet'))}</div>`);

    // ── Agent permissions: Group manager delegation (issue #21) ──
    // Double-gated: this per-session toggle AND the global setting
    // agents.allowGroupManagement must both be on for /api/agent/group-admin.
    {
      const mgrSec = section(t('Agent permissions'));
      const lbl = document.createElement('label');
      lbl.className = 'session-props-group';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!(sidebar.getSessionConfig?.(s) || {}).groupManager;
      cb.onchange = () => sidebar.setSessionConfig?.(s, { ...(sidebar.getSessionConfig?.(s) || {}), groupManager: cb.checked || undefined });
      const txt = document.createElement('span');
      txt.textContent = t('Group manager — may organize ALL Task Groups from its CLI (not just its own)');
      lbl.append(cb, txt);
      mgrSec.appendChild(lbl);
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = app.settings?.get('agents.allowGroupManagement')
        ? t('Globally enabled — a designated session can list/create/configure/bind EVERY group and act on any of them with --group (audited in each group\'s activity log). The agent is told about these powers on its next turn.')
        : t('Also requires Settings → Integration → "Allow agents to manage Task Groups" (currently off).');
      mgrSec.appendChild(hint);
    }

    // ── Background Work: auto-notify visibility (2.344.0, owner request) ──
    // READ-ONLY effective state for this session's conversation: global
    // setting > any bound group's tri-state (explicit OFF wins). The toggles
    // themselves live in Settings → Integration and the Task Group window.
    {
      const bwSec = section(t('Background Work'));
      const globalOn = app.settings?.get('agents.jobNotify') !== false;
      // same membership set as the Task Groups section above (explicit binds
      // + folder-derived) — a job's owner snapshot is taken from these
      const memberIds = new Set([...explicitIds, ...byId.keys()]);
      const groups = (sidebar._tasks || []).filter(g => !g.archived && memberIds.has(g.id) && (g.jobNotify === true || g.jobNotify === false));
      const offGroup = groups.find(g => g.jobNotify === false);
      const onGroup = groups.find(g => g.jobNotify === true);
      const eff = offGroup ? false : onGroup ? true : globalOn;
      const src = offGroup ? t('group “{name}”', { name: offGroup.title }) : onGroup ? t('group “{name}”', { name: onGroup.title }) : t('global setting');
      const rowEl = document.createElement('div');
      rowEl.className = 'session-detail-row';
      rowEl.innerHTML = `<span class="session-detail-label">${escHtml(t('Job auto-notify'))}</span><span class="session-detail-value">${escHtml(eff ? t('On') : t('Off'))} · ${escHtml(src)}</span>`;
      bwSec.appendChild(rowEl);
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = eff
        ? t('Background jobs owned by this conversation message it when they finish, fail, get parked, or ask for input; while it is closed, notifications queue and inject at resume. Toggle globally in Settings → Integration, per group in the group window.')
        : t('This conversation is NOT notified when its background jobs finish — agents must poll. Toggle globally in Settings → Integration, per group in the group window.');
      bwSec.appendChild(hint);
    }

    // ── Agent steps (native TODO) ──
    const stepSec = section(t('Agent steps'));
    const stepList = document.createElement('div');
    stepList.className = 'session-steps-list';
    stepList.innerHTML = `<div class="empty-hint" style="padding:2px 0">${escHtml(t('Loading…'))}</div>`;
    stepSec.appendChild(stepList);
    const rid = s.backendSessionId || s.sessionId;
    fetch(`/api/session-todos?backend=${encodeURIComponent(s.backend || 'claude')}&backendSessionId=${encodeURIComponent(rid)}&cwd=${encodeURIComponent(s.cwd || '')}${s.host ? `&host=${encodeURIComponent(s.host)}` : ''}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText || 'request failed'}`);
        return r.json();
      }).then(d => {
        if (!stepList.isConnected) return;
        const todos = (d?.todos || []).filter(t => (t.content || t.step || '').trim());
        stepList.innerHTML = todos.length ? '' : `<div class="empty-hint" style="padding:2px 0">${escHtml(t("The agent hasn't kept a todo list"))}</div>`;
        const mkStep = (t) => {
          const li = document.createElement('div');
          li.className = 'session-step ' + (t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : '');
          li.textContent = (t.status === 'completed' ? '✓ ' : t.status === 'in_progress' ? '▸ ' : '○ ') + (t.content || t.step || '');
          return li;
        };
        // Open work first; completed collapsed to the last 2 with an
        // expandable "N more" row (long histories drowned the actionable steps).
        const open = todos.filter(t => t.status !== 'completed');
        const done = todos.filter(t => t.status === 'completed');
        for (const t of open) stepList.appendChild(mkStep(t));
        const hidden = done.slice(0, -2);
        if (hidden.length) {
          const toggle = document.createElement('div');
          toggle.className = 'session-step session-step-more';
          toggle.textContent = t('✓ {n} more completed…', { n: hidden.length });
          toggle.onclick = () => {
            const frag = document.createDocumentFragment();
            for (const t of hidden) frag.appendChild(mkStep(t));
            toggle.replaceWith(frag);
          };
          stepList.appendChild(toggle);
        }
        for (const t of done.slice(-2)) stepList.appendChild(mkStep(t));
      }).catch((e) => {
        // Remote sessions read the steps out of an ssh-fetched transcript — a
        // slow/dead host used to leave this section on 'Loading…' forever.
        if (!stepList.isConnected) return;
        stepList.innerHTML = `<div class="usage-warn" style="padding:2px 0">${escHtml(s.host
          ? t('Couldn’t load the steps from {host} — {reason}', { host: sidebar._hostsData?.hosts?.find(h => h.id === s.host)?.name || s.host, reason: e?.message || t('unreachable') })
          : t('Couldn’t load the steps — {reason}', { reason: e?.message || t('server unreachable') }))}</div>`;
      });
  };

  render();
  // Debounced (audit round-2, high): 'active-sessions' fires every 5s poll +
  // every broadcast — an open Properties window re-rendered its whole body
  // (plus a /api/session-todos fetch) each time. 300ms trailing-edge coalesce.
  let renderTimer = null;
  const onMsg = (msg) => {
    if (!['tasks-updated', 'session-status-updated', 'active-sessions', 'accounts-updated', 'user-state-updated'].includes(msg.type)) return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 300);
  };
  app.ws.onGlobal(onMsg);
  const prevClose = winInfo.onClose;
  winInfo.onClose = () => { app.ws.offGlobal(onMsg); prevClose?.(); };
  return winInfo;
}

// ── openSpec ACTION REGISTRATION (Plugin Ph1) ── opens a 'task'-kind window (kind owned by task-detail.js)
registerOpenAction({ action: 'openSessionProps', type: 'task', replay: (app, spec, { syncId } = {}) => app.openSessionProps(spec.sessionKey, { syncId }) });
