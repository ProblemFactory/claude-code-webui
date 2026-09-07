import { escHtml, copyText, showConfirmDialog, stripCwdHostLabel, taskGroupColor } from './utils.js';
import { SESSION_STATE_META, SESSION_URGENCY_META } from './sidebar-tasks.js';
import { getBackendMeta, getAgentKindMeta, getAgentRoleLabel, responseStyleCaps, responseStyleOrigin, spawnValueOrigin, effortDisplay, composerSendModes, notificationDeliveryFor, worktreeCapsFor, worktreePick, permissionRulesCaps } from './agent-meta.js';
import { loadInto } from './permission-rules-view.js';
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
    const row = (parent, label, valueHtml, { copy, wrap } = {}) => {
      const r = document.createElement('div');
      r.className = 'session-detail-row';
      r.innerHTML = `<span class="session-detail-label">${escHtml(label)}</span>`;
      const v = document.createElement('span');
      v.className = 'session-detail-value';
      v.style.cssText = wrap
        ? 'flex:1;min-width:0;white-space:normal;overflow-wrap:anywhere'
        : 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
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
    // ONE header, however many of the rows below exist. `section()` APPENDS a
    // new header every time it is called, so the `cfgSec || section(...)`
    // idiom below was only ever correct while exactly ONE lazy row could
    // follow it; the moment a second one did (the 'Sending during a turn' row)
    // a codex session with no saved override — the common case — printed the
    // 'Config overrides' header TWICE (round-2 verifier's minor). The header
    // is now created at most once, on first demand.
    let cfgSecMemo = cfgBits.length ? section(t('Config overrides')) : null;
    const cfgSection = () => { if (!cfgSecMemo) cfgSecMemo = section(t('Config overrides')); return cfgSecMemo; };
    if (cfgSecMemo) row(cfgSecMemo, t('Saved'), escHtml(cfgBits.join(' · ')));

    // ── Model + effort: the EFFECTIVE value and WHICH FACT it is (B-6b6d) ──
    // The owner ruling: a resumed conversation keeps its OWN model/effort, and
    // the instance default only applies to a NEW session. That makes "where did
    // this value come from" a real question with four answers, and one the
    // panel cannot work out for itself — the conversation's own value and the
    // instance default are frequently the same string. So the SERVER states the
    // origin at spawn (src/resume-continuity.js) and it rides the session
    // record; `spawnValueOrigin` only decides how to show it, and still flips to
    // 'spawn' when a pick saved afterwards disagrees with the live value, so the
    // origin can never contradict the "(saved: …)" note next to it.
    const ORIGIN_LABEL = {
      chosen: () => t('your choice for this session'),
      conversation: () => t('this conversation\u2019s own value'),
      instance: () => t('instance default'),
      spawn: () => t('what this session started with'),
      saved: () => t('saved \u2014 applies on the next resume'),
      harness: () => t('harness default \u2014 the agent\u2019s own config decides'),
    };
    {
      const originRow = (label, live, picked, stated, render) => {
        const shown = live || (picked || '');
        if (!shown) return;   // nothing commanded and nothing picked: no row rather than an empty claim
        // 'unknown' = a session that predates the stated origin and offers
        // nothing to compare (r2 review). It gets the VALUE and no
        // parenthetical \u2014 an origin we do not have must not be invented, and
        // "(instance default)" was wrong for every session whose model came
        // from the New Session dialog.
        const originKey = spawnValueOrigin(stated, live, picked);
        const originBit = ORIGIN_LABEL[originKey]
          ? ` <span class="chat-status-dim">${escHtml('(' + ORIGIN_LABEL[originKey]() + ')')}</span>` : '';
        const pendBit = (live && picked !== undefined && (picked || '') !== live)
          ? ` <span class="chat-status-dim">${escHtml(t('(saved: {v} \u2014 applies on the next resume)', { v: picked || t('agent default') }))}</span>` : '';
        row(cfgSection(), label,
          `${escHtml(render ? render(shown) : shown)}${originBit}${pendBit}`,
          // an origin row states TWO facts; the second must not be the one the
          // ellipsis eats (375x667: it is the last thing on the line)
          { wrap: true });
      };
      originRow(t('Model'), s.spawnModel || '', cfg.model, s.modelOrigin);
      if (getBackendMeta(s.backend || 'claude')?.caps?.effort !== false) {
        originRow(t('Effort'), s.effort || '', cfg.effort, s.effortOrigin,
          (v) => effortDisplay(s.backend || 'claude', v, { model: s.spawnModel || '' }));
      }
    }

    // ── Response style, EFFECTIVE + its ORIGIN (2.369.58) ──
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
      // The origin is decided by COMPARING the two, not by "does a pick exist"
      // (2.369.58): with a live 'Explanatory' and a saved 'Concise' the old
      // rule called the live value "your choice for this session" while the
      // note beside it said the choice had not landed yet.
      // ONE label map for all three rows (above) — a second copy is how the
      // same fact starts being worded two ways in one panel.
      const origin = ORIGIN_LABEL[responseStyleOrigin(live, picked)]();
      const pendBit = (live && picked !== undefined && (picked || '') !== live)
        ? ` <span class="chat-status-dim">${escHtml(t('(saved: {v} \u2014 applies on the next resume)', { v: picked || t('agent default') }))}</span>` : '';
      row(cfgSection(), t('Response style'),
        `${escHtml(shown || t('agent default'))} <span class="chat-status-dim">${escHtml('(' + origin + ')')}</span>${pendBit}`,
        { wrap: true });   // same family, same reason
    }

    // ── Per-session git worktree (owner ruling 9) ──
    // TWO facts, said apart, exactly like the response-style row above — and
    // they are genuinely different things, so they never share a control:
    //   · `s.worktree` / `s.worktreePath` = what THIS RUN is, decided by the
    //     CLI's own init frame (the arbiter, both directions: a worktree it
    //     could not re-enter turns the live fact OFF). Read-only by nature —
    //     a running process cannot be moved into or out of a checkout.
    //   · `cfg.worktree` = the standing PICK for this conversation, which is
    //     what a fork (and a restart from this config) asks for. That one is
    //     the CHECKBOX, mirroring the New Session dialog's row.
    // A resume is deliberately NOT in that list: `--worktree` is emitted on a
    // new session and on a fork only, because the CLI records the binding on
    // the conversation and re-enters it by itself (2.1.257 `worktreeSession`,
    // stripped by --fork-session) — a second flag would create a SECOND tree.
    // The hint says exactly that, so an unticked box is never a broken promise.
    // Gated on the CAPS MIRROR, never on a backend id.
    {
      const wtCaps = worktreeCapsFor(s.backend || 'claude');
      const live = !!s.worktree;
      if (wtCaps.supported) {
        const sec = cfgSection();
        const lbl = document.createElement('label');
        lbl.className = 'session-props-group';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        // ONE rule, shared with the fork path (worktreePick): an absent pick
        // shows what this RUN is, and the box the user is looking at is
        // therefore exactly what a fork of this conversation will ask for.
        cb.checked = worktreePick({ saved: cfg.worktree, live });
        // The pick is TRI-STATE and written as a BOOLEAN: `false` has to
        // persist, or unticking the box while the run IS isolated is a control
        // that re-checks itself on the next render (accept-and-ignore) — and
        // the fork would keep inheriting a preference the user just revoked.
        cb.onchange = () => sidebar.setSessionConfig?.(s, { ...(sidebar.getSessionConfig?.(s) || {}), worktree: cb.checked });
        const txt = document.createElement('span');
        txt.textContent = t('Run in a git worktree');
        lbl.append(cb, txt);
        sec.appendChild(lbl);
        const hint = document.createElement('div');
        hint.className = 'empty-hint';
        hint.textContent = t('Applies when a new session or a fork starts. A resume re-enters whatever worktree the CLI recorded for this conversation, so it cannot gain or lose one.');
        sec.appendChild(hint);
        // What this RUN actually is — the CLI's own word, or an honest absence.
        if (live) {
          const r = row(sec, t('Git worktree'), s.worktreePath
            ? `<span class="session-detail-path">${escHtml(s.worktreePath)}</span>`
            : escHtml(t('on \u2014 the CLI has not reported the directory yet')),
          s.worktreePath ? { copy: s.worktreePath } : {});
          r.classList.add('sp-wrap');
        } else if (cfg.worktree === true) {
          // Ticked, but this run is not isolated — say so rather than letting
          // the checkbox imply otherwise (the CLI clears a binding whose
          // worktree is gone, and a resume can never create one).
          row(sec, t('Git worktree'), `<span class="chat-status-dim">${escHtml(t('not isolated in this run'))}</span>`);
        }
      }
    }

    // ── What a send DURING a running turn does here (2026-09-07) ──
    // The HARNESS row, not the live intersection: a properties panel describes
    // what this KIND of agent does, and it is opened on stopped sessions too.
    // A harness with no queue surface (claude's CLI holds the message and
    // publishes nothing; shell has no turn) gets NO row — the owner's rule for
    // the chord is the same one here: 不支持queue的就不显示.
    {
      const sm = composerSendModes(getBackendMeta(s.backend || 'claude')?.caps?.inputModes);
      if (sm.showHint) {
        const bits = [];
        if (sm.queueSegment) bits.push(t('Enter queues it — it runs after this turn'));
        if (sm.steerSegment) bits.push(t('Alt+Enter injects it into the running turn (the agent sees it at its next reply)'));
        row(cfgSection(), t('Sending during a turn'), escHtml(bits.join(' \u00b7 ')));
      }
    }

    // ── Permission rules (READ-ONLY, owner ruling 10) ──
    // "Where does this rule come from" for THIS session. Gated on the caps row
    // (`permissionRules`), never on a backend id — a harness with no rule
    // surface (shell) gets no section at all, and one that only answers for
    // the whole machine (opencode: the serve reports ONE resolved config with
    // no per-key origin) says so instead of pretending it is session-scoped.
    // HUMAN-TRIGGERED: the tree loads on the button, never on render — the
    // codex rung asks the session's own agent, and a panel that re-rendered on
    // every broadcast would ask it again on every broadcast.
    {
      const prCaps = permissionRulesCaps(s.backend || 'claude');
      if (prCaps.source) {
        const prSec = section(t('Permission rules'));
        const hint = document.createElement('div');
        hint.className = 'agents-note';
        hint.textContent = prCaps.session
          ? t('Read-only: which rule comes from which file or layer.')
          : t('Read-only, and machine-wide: this agent reports one resolved set of rules, not a per-session one.');
        prSec.appendChild(hint);
        const tree = document.createElement('div');
        const btn = document.createElement('button');
        btn.className = 'task-detail-btn';
        btn.textContent = t('Show rules…');
        btn.onclick = () => {
          btn.disabled = true;
          loadInto(tree, {
            backend: s.backend || 'claude',
            scope: prCaps.session ? 'session' : 'instance',
            sessionId: prCaps.session ? (s.webuiId || '') : '',
            // TWO fields of a merged session record, both of which have been
            // wrong here before (round-2 verifier, both reproduced):
            //  · `s.host` is the field. `s.hostId` does not exist on a session
            //    — it is an OPENSPEC name (session-card.js / sidebar-tasks.js
            //    both MAP `hostId: s.host` when they build one), so reading it
            //    here sent `host=` EMPTY for every remote session and the
            //    server's `remote-session` guard never fired: the panel showed
            //    THIS machine's ~/.claude/settings.json as the remote
            //    session's rules.
            //  · `s.cwd` on a merged record is the host-labeled DISPLAY string
            //    ("box: /home/u/proj", sidebar.js _merge) — the 2.225.2 law
            //    says it must never reach an operation, and a settings-file
            //    reader is an operation. Strip it here too, so a mistake in
            //    ONE of the two fields cannot compose a fake path either.
            cwd: stripCwdHostLabel(s.cwd || ''),
            host: s.host || '',
          }).finally(() => { btn.disabled = false; btn.textContent = t('Reload rules'); });
        };
        prSec.append(btn, tree);
      }
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
      // HOW a notification reaches a BUSY session — derived from the harness
      // capability row (backend-caps peerDelivery + inputModes.steer), never
      // from a backend id. Owner decision 2026-09-07: notifications STEER,
      // human messages QUEUE, and a steer carries only itself.
      if (eff) {
        const lane = notificationDeliveryFor(s.backend || 'claude');
        const laneRow = document.createElement('div');
        laneRow.className = 'session-detail-row';
        const laneValue = lane === 'steer' ? t('Steered into the running turn')
          : lane === 'queue' ? t('Queued — runs after the current turn')
            : lane === 'cli-inbox' ? t('The CLI decides (it queues mid-turn itself)')
              : t('Stashed — injected at the next turn');
        laneRow.innerHTML = `<span class="session-detail-label">${escHtml(t('While busy'))}</span><span class="session-detail-value">${escHtml(laneValue)}</span>`;
        bwSec.appendChild(laneRow);
        const laneHint = document.createElement('div');
        laneHint.className = 'empty-hint';
        laneHint.textContent = lane === 'steer'
          ? t('A notification arriving mid-turn joins the RUNNING turn and carries only itself — the input queue is untouched, and several notifications merge into one injection (Codex TUI parity). Messages from other agents are different: they QUEUE and run as their own turn, because a person\u2019s message is its own task.')
          : lane === 'queue' ? t('This harness has no steer verb, so a notification arriving mid-turn waits in the input queue and runs as its own turn afterwards — like a message from another agent.')
            : lane === 'cli-inbox' ? t('Delivery goes through the CLI\u2019s own inbox: it queues a mid-turn notification itself and opens a turn when the session is idle. Same for messages from other agents.')
              : t('This harness has no live delivery lane, so notifications and agent messages are stashed and injected at the session\u2019s next turn.');
        bwSec.appendChild(laneHint);
      }
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
