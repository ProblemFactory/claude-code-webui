import { escHtml, copyText, createPopover } from './utils.js';
import { createBackendIcon, createAgentKindIcon, createModeBackendIcon, getBackendMeta, getAgentKindMeta, getAgentRoleLabel, getAgentRoleShortLabel, getSessionKey } from './agent-meta.js';

/** Inline SVG icon helper — returns an HTML string for a 12x12 stroked icon */
const _s = (d, fill = false) => `<svg style="width:12px;height:12px;vertical-align:-2px" viewBox="0 0 16 16" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">${d}</svg>`;
const ICON = {
  starOn:    _s('<path d="M8 1.5l2 4.2 4.5.6-3.3 3.1.8 4.6L8 11.5l-4 2.5.8-4.6L1.5 6.3 6 5.7z"/>', true),
  starOff:   _s('<path d="M8 1.5l2 4.2 4.5.6-3.3 3.1.8 4.6L8 11.5l-4 2.5.8-4.6L1.5 6.3 6 5.7z"/>'),
  archive:   _s('<path d="M2 4h12M3 4v8a1 1 0 001 1h8a1 1 0 001-1V4"/><path d="M6.5 8h3"/>'),
  unarchive: _s('<path d="M2 4h12M3 4v8a1 1 0 001 1h8a1 1 0 001-1V4"/><path d="M8 7v4M6 9l2-2 2 2"/>'),
  rename:    _s('<path d="M11.5 1.5l3 3L5 14H2v-3z"/>'),
  find:      _s('<circle cx="7" cy="7" r="4"/><path d="M10 10l4 4"/>'),
  chat:      _s('<path d="M2 3a2 2 0 012-2h8a2 2 0 012 2v6a2 2 0 01-2 2H6l-4 3V3z"/>'),
  history:   _s('<circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 1.5"/>'),
  terminal:  _s('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 7l2 2-2 2M8.5 11h3"/>'),
  terminate: _s('<path d="M4 4l8 8M12 4l-8 8"/>'),
  goto:      _s('<path d="M5 1l7 7-7 7"/>'),
};

/**
 * Render the detail groups section inside a session card.
 * @param {HTMLElement} container - DOM container for groups
 * @param {object|string} sessionRef
 * @param {boolean} clickToCopy
 * @param {object} state - sidebar instance (for _getSessionGroups, _showGroupChecklistPopover, _addSessionToGroup, _removeSessionFromGroup)
 */
function renderDetailGroups(container, sessionRef, clickToCopy, state) {
  container.innerHTML = '';
  const sessionGroups = state._getSessionGroups(sessionRef);
  const summary = sessionGroups.length ? sessionGroups.join(', ') : 'None';

  const row = document.createElement('div');
  row.className = 'session-detail-row';
  const lbl = document.createElement('span'); lbl.className = 'session-detail-label'; lbl.textContent = 'Groups';
  const val = document.createElement('span'); val.className = 'session-detail-value';
  val.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  val.textContent = summary;
  if (clickToCopy) {
    val.classList.add('session-detail-copyable');
    val.title = 'Click to copy';
    val.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(summary).then(() => {
        const orig = val.textContent; val.textContent = 'Copied!';
        setTimeout(() => { val.textContent = orig; }, 800);
      }).catch(() => {});
    };
  }
  row.append(lbl, val);
  const btn = document.createElement('button');
  btn.className = 'session-detail-btn';
  btn.textContent = '\u25be';
  btn.style.cssText = 'padding:1px 6px;font-size:10px;min-width:0';
  btn.onclick = (e) => {
    e.stopPropagation();
    const groups = state._getSessionGroups(sessionRef);
    state._showGroupChecklistPopover(btn,
      (name) => groups.includes(name),
      (name, checked) => { if (checked) state._addSessionToGroup(sessionRef, name); else state._removeSessionFromGroup(sessionRef, name); });
  };
  row.appendChild(btn);
  container.appendChild(row);
}

/**
 * Render a session card element.
 * @param {object} s - session data object
 * @param {object} opts
 * @param {object} opts.state - sidebar instance (isStarred, isArchived, getCustomName, getSessionMode, toggleStar, toggleArchive, etc.)
 * @param {object} opts.app - App instance (attachSession, resumeSession, etc.)
 * @param {object} opts.settings - SettingsManager
 * @param {string|null} opts.expandedCardId - currently expanded card ID
 * @param {function} opts.onExpandToggle - callback(sessionId) when expand toggled
 * @param {function} opts.onRename - callback(session, originalName) for rename
 * @returns {HTMLElement}
 */
export function renderSessionCard(s, { state, app, settings, expandedCardId, onExpandToggle, onRename }) {
  const card = document.createElement('div'); card.className = 'session-item-card';
  card._sessionId = s.sessionId; // Store for highlight lookup
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-session-id', s.sessionId);
    const sessionKey = getSessionKey(s);
    if (sessionKey) e.dataTransfer.setData('application/x-session-key', sessionKey);
    e.dataTransfer.effectAllowed = 'link';
  });
  const isArchived = state.isArchived(s);
  if (isArchived) card.classList.add('archived');
  if (expandedCardId === s.sessionId) card.classList.add('expanded');
  const date = new Date(s.startedAt);
  const customName = state.getCustomName(s);
  const cwdFolder = s.cwd ? s.cwd.replace(/\/+$/, '').split('/').pop() : '';
  const originalName = s.name || s.webuiName || cwdFolder || s.sessionId.substring(0, 12) + '...';
  const displayName = customName || originalName;
  const backendMeta = getBackendMeta(s.backend || 'claude');
  const agentKindMeta = getAgentKindMeta(s.agentKind || 'primary');
  const agentRoleLabel = getAgentRoleLabel(s.agentRole);
  const agentRoleShort = getAgentRoleShortLabel(s.agentRole);
  const showAgentKind = (s.agentKind || 'primary') !== 'primary';
  const agentOpts = {
    backend: s.backend || 'claude',
    backendSessionId: s.backendSessionId || s.sessionId,
    agentKind: s.agentKind || 'primary',
    agentRole: s.agentRole || '',
    agentNickname: s.agentNickname || '',
    sourceKind: s.sourceKind || '',
    parentThreadId: s.parentThreadId || null,
  };

  const badgeMap = {
    live:     { cls: 'badge-live', text: 'LIVE' },
    tmux:     { cls: 'badge-tmux', text: 'TMUX' },
    external: { cls: 'badge-external', text: 'EXTERNAL' },
    stopped:  { cls: 'badge-stopped', text: 'STOPPED' },
  };
  const badge = badgeMap[s.status] || badgeMap.stopped;

  const starred = state.isStarred(s);
  const isExpanded = expandedCardId === s.sessionId;
  // Compact row: star archive mode/backend icon name status expand
  card.innerHTML = `<div class="session-card-row">
    <span class="session-card-name">${escHtml(displayName)}</span>
    ${agentRoleShort ? `<span class="session-card-badge badge-agent-role" title="${escHtml(agentRoleLabel)}">${escHtml(agentRoleShort)}</span>` : ''}
    <span class="session-card-badge ${badge.cls}">${badge.text}</span>
  </div>`;
  const row = card.querySelector('.session-card-row');
  // Star button (inline, always visible)
  const starBtn = document.createElement('button');
  starBtn.className = 'session-inline-btn' + (starred ? ' starred' : '');
  starBtn.innerHTML = starred ? ICON.starOn : ICON.starOff;
  starBtn.title = starred ? 'Unstar' : 'Star';
  starBtn.onclick = (e) => { e.stopPropagation(); state.toggleStar(s); };
  row.insertBefore(starBtn, row.firstChild);
  // Archive button (inline, always visible)
  const archBtn = document.createElement('button');
  archBtn.className = 'session-inline-btn' + (isArchived ? ' archived' : '');
  archBtn.innerHTML = isArchived ? ICON.unarchive : ICON.archive;
  archBtn.title = isArchived ? 'Unarchive' : 'Archive';
  archBtn.onclick = (e) => { e.stopPropagation(); state.toggleArchive(s); };
  row.insertBefore(archBtn, row.children[1]);
  // Composite icon: mode shape (chat/terminal) + backend logo inside
  // For live sessions with known mode: composite icon before name
  // For stopped/external: plain backend icon before name
  if (s.webuiMode) {
    const compositeIcon = createModeBackendIcon(s.backend || 'claude', s.webuiMode, {
      className: 'session-composite-icon',
      title: `${backendMeta.label} ${s.webuiMode === 'chat' ? 'Chat' : 'Terminal'}`,
    });
    row.insertBefore(compositeIcon, row.querySelector('.session-card-name'));
  } else {
    const backendIcon = createBackendIcon(s.backend || 'claude', {
      className: 'session-backend-icon',
      title: backendMeta.label,
    });
    row.insertBefore(backendIcon, row.querySelector('.session-card-name'));
  }

  if (showAgentKind) {
    const agentKindIcon = createAgentKindIcon(s.agentKind || 'primary', {
      className: 'session-agent-kind-icon',
      title: agentKindMeta.label,
    });
    row.insertBefore(agentKindIcon, row.querySelector('.session-card-name'));
  }

  // Expand/collapse button on the right side, after badge
  const expandBtn = document.createElement('button');
  expandBtn.className = 'session-expand-btn';
  expandBtn.textContent = expandedCardId === s.sessionId ? '\u25BE' : '\u25B8';
  expandBtn.title = 'Show details';
  expandBtn.onclick = (e) => {
    e.stopPropagation();
    if (expandedCardId === s.sessionId) {
      onExpandToggle(null);
    } else {
      onExpandToggle(s.sessionId);
    }
  };
  card.querySelector('.session-card-row').appendChild(expandBtn);

  // Detail panel (shown when expanded)
  const detailPanel = document.createElement('div');
  detailPanel.className = 'session-card-detail';

  const visibleFields = settings?.get('sessionCard.visibleFields') ?? ['id', 'backend', 'cwd', 'started', 'status', 'groups'];
  const clickToCopy = settings?.get('sessionCard.clickToCopy') ?? false;
  const truncation = settings?.get('sessionCard.detailTruncation') ?? 'left';
  const cwdShort = (s.cwd || '').replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~');

  const fields = [
    { key: 'id', label: 'ID', display: s.sessionId, copy: s.sessionId, copiable: true, midTruncate: true },
    { key: 'backend', label: 'Agent', display: [backendMeta.label, showAgentKind ? agentKindMeta.label : null, agentRoleLabel, s.agentNickname || null].filter(Boolean).join(' / '), copy: [backendMeta.label, showAgentKind ? agentKindMeta.label : null, agentRoleLabel, s.agentNickname || null].filter(Boolean).join(' / ') },
    { key: 'cwd', label: 'CWD', display: cwdShort, copy: s.cwd || '', copiable: true, leftTruncate: true },
    { key: 'started', label: 'Started', display: date.toLocaleString(), copy: date.toISOString() },
    { key: 'status', label: 'Status', display: null, badge: true, copy: `${s.status}${s.pid ? ' PID ' + s.pid : ''}` },
  ];

  for (const f of fields) {
    if (!visibleFields.includes(f.key)) continue;
    const row = document.createElement('div'); row.className = 'session-detail-row';
    row.style.position = 'relative';
    const lbl = document.createElement('span'); lbl.className = 'session-detail-label'; lbl.textContent = f.label;
    const val = document.createElement('span'); val.className = 'session-detail-value';
    if (f.badge) {
      val.innerHTML = `<span class="session-card-badge ${badge.cls}">${badge.text}</span>`;
    } else if (f.midTruncate && f.display.length > 12) {
      // Middle truncation: flexible head (ellipsis) + fixed tail
      val.classList.add('session-detail-mid-truncate');
      const head = document.createElement('span'); head.className = 'mid-truncate-head'; head.textContent = f.display.slice(0, -4);
      const tail = document.createElement('span'); tail.className = 'mid-truncate-tail'; tail.textContent = f.display.slice(-4);
      val.append(head, tail);
    } else {
      val.textContent = f.display;
      val.style.display = 'block';
      if (f.leftTruncate) { val.style.direction = 'rtl'; val.style.unicodeBidi = 'plaintext'; }
    }
    if (f.copiable || clickToCopy) {
      val.classList.add('session-detail-copyable');
      val.title = f.copy;
      val.onclick = (e) => {
        e.stopPropagation();
        copyText(f.copy).then(() => {
          const tip = document.createElement('span');
          tip.className = 'session-detail-tooltip';
          tip.textContent = 'Copied!';
          row.appendChild(tip);
          setTimeout(() => tip.remove(), 1000);
        });
      };
    }
    row.append(lbl, val);
    detailPanel.appendChild(row);
  }

  // Groups section
  if (visibleFields.includes('groups')) {
    const groupsContainer = document.createElement('div'); groupsContainer.className = 'session-detail-groups';
    detailPanel.appendChild(groupsContainer);
    renderDetailGroups(groupsContainer, s, clickToCopy, state);
  }

  const actionsDiv = document.createElement('div'); actionsDiv.className = 'session-detail-actions';
  detailPanel.appendChild(actionsDiv);

  // Rename button
  const detailRenameBtn = document.createElement('button');
  detailRenameBtn.className = 'session-detail-btn';
  detailRenameBtn.innerHTML = ICON.rename + ' Rename';
  detailRenameBtn.onclick = (e) => { e.stopPropagation(); onRename(s, originalName); };
  actionsDiv.appendChild(detailRenameBtn);

  // Find / GoTo split button
  if (s.webuiId) {
    const findWrap = document.createElement('div');
    findWrap.className = 'session-resume-split';
    const findBtn = document.createElement('button');
    findBtn.className = 'session-detail-btn';
    const findDrop = document.createElement('button');
    findDrop.className = 'session-resume-drop session-find-drop';
    const getFindMode = () => settings?.get('sessionCard.findMode') ?? 'find';
    const updateFindLabel = () => {
      const m = getFindMode();
      findBtn.innerHTML = m === 'goto' ? (ICON.goto + ' GoTo') : (ICON.find + ' Find');
    };
    updateFindLabel();
    findBtn.onclick = (e) => {
      e.stopPropagation();
      if (getFindMode() === 'goto') app.goToWindow(s.webuiId);
      else app.flashWindow(s.webuiId);
    };
    findDrop.textContent = '\u25BE';
    findDrop.onclick = (e) => {
      e.stopPropagation();
      settings?.set('sessionCard.findMode', getFindMode() === 'goto' ? 'find' : 'goto');
      updateFindLabel();
    };
    findWrap.append(findBtn, findDrop);
    actionsDiv.appendChild(findWrap);
  }

  // Resume/Attach action button
  if (s.status === 'live' && s.webuiId) {
    const detailAttachBtn = document.createElement('button');
    detailAttachBtn.className = 'session-detail-btn session-detail-btn-primary';
    detailAttachBtn.innerHTML = ICON.terminal + ' Attach';
    detailAttachBtn.onclick = (e) => { e.stopPropagation(); app.attachSession(s.webuiId, s.webuiName || displayName, s.cwd, { mode: s.webuiMode, ...agentOpts }); };
    actionsDiv.appendChild(detailAttachBtn);
  } else if (s.status === 'tmux') {
    const detailTmuxBtn = document.createElement('button');
    detailTmuxBtn.className = 'session-detail-btn session-detail-btn-primary';
    detailTmuxBtn.innerHTML = ICON.terminal + ' View';
    detailTmuxBtn.onclick = (e) => { e.stopPropagation(); app.attachTmuxSession(s.tmuxTarget, displayName, s.cwd); };
    actionsDiv.appendChild(detailTmuxBtn);
  } else if (s.status === 'stopped') {
    const savedMode = state.getSessionMode(s);
    const defaultMode = settings?.get('session.defaultMode') ?? 'terminal';
    let resumeMode = savedMode || defaultMode;

    // Per-session config (model / effort / permission) — popover
    const backend = s.backend || 'claude';
    const opts = app.getSessionOptions(backend);
    const prefix = backend === 'codex' ? 'codex' : 'claude';
    const defaults = {
      model: settings?.get(`${prefix}.defaultModel`) ?? '',
      effort: settings?.get(`${prefix}.defaultEffort`) ?? '',
      permission: settings?.get(`${prefix}.defaultPermissionMode`) ?? '',
    };
    const overrides = { model: defaults.model, effort: defaults.effort, permission: defaults.permission };
    // Track current labels for the config button badge
    const getModelLabel = () => {
      if (!overrides.model) return '';
      const m = opts.models.find(o => (o.value || o.id || '') === overrides.model);
      return m ? (m.label || m.value || '') : overrides.model;
    };

    const resumeWrap = document.createElement('div');
    resumeWrap.className = 'session-resume-split';

    const resumeBtn = document.createElement('button');
    const dropBtn = document.createElement('button');
    const updateLabel = () => {
      const isChat = resumeMode === 'chat';
      resumeBtn.innerHTML = isChat ? (ICON.chat + ' Resume in Chat') : (ICON.terminal + ' Resume in Terminal');
      resumeBtn.className = 'session-detail-btn ' + (isChat ? 'session-detail-btn-chat' : 'session-detail-btn-primary');
      dropBtn.className = 'session-resume-drop ' + (isChat ? 'session-detail-btn-chat' : 'session-detail-btn-primary');
    };
    updateLabel();
    resumeBtn.onclick = (e) => {
      e.stopPropagation();
      app.resumeSession(s.sessionId, s.cwd, customName || s.name, {
        mode: resumeMode,
        model: overrides.model || undefined,
        effort: overrides.effort || undefined,
        permission: overrides.permission || undefined,
        ...agentOpts,
      });
    };

    dropBtn.textContent = '\u25BE';
    dropBtn.onclick = (e) => {
      e.stopPropagation();
      resumeMode = resumeMode === 'chat' ? 'terminal' : 'chat';
      state.setSessionMode(s, resumeMode);
      updateLabel();
    };

    // Config button (gear) — opens popover for model/effort/permission
    const configBtn = document.createElement('button');
    configBtn.className = 'session-resume-drop ' + (resumeMode === 'chat' ? 'session-detail-btn-chat' : 'session-detail-btn-primary');
    configBtn.innerHTML = '<svg style="width:10px;height:10px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9"/><path d="M6.5 1.5h3l.3 1.5.8.3 1.3-.8 2.1 2.1-.8 1.3.3.8 1.5.3v3l-1.5.3-.3.8.8 1.3-2.1 2.1-1.3-.8-.8.3-.3 1.5h-3l-.3-1.5-.8-.3-1.3.8-2.1-2.1.8-1.3-.3-.8L1.5 9.5v-3l1.5-.3.3-.8-.8-1.3 2.1-2.1 1.3.8.8-.3z"/></svg>';
    configBtn.title = 'Session parameters';
    configBtn.style.borderLeft = '1px solid var(--border)';
    configBtn.onclick = (e) => {
      e.stopPropagation();
      _showConfigPopover(configBtn);
    };

    const _showConfigPopover = (anchor) => {
      const pop = createPopover(anchor, 'session-config-popover');

      const makeRow = (label, options, key, isModel) => {
        const curVal = overrides[key];
        const defaultVal = defaults[key];
        const isDefault = !curVal || curVal === defaultVal;
        const row = document.createElement('div'); row.className = 'session-config-row';
        const cb = document.createElement('input'); cb.type = 'checkbox';
        cb.className = 'session-config-cb'; cb.checked = !isDefault;
        cb.title = cb.checked ? 'Uncheck to use global default' : 'Check to override';
        const lbl = document.createElement('span'); lbl.className = 'session-config-label'; lbl.textContent = label;
        const sel = document.createElement('select'); sel.className = 'session-config-select';
        for (const opt of options) {
          const o = document.createElement('option');
          o.value = opt.value || opt.id || '';
          o.textContent = opt.label || opt.value || 'Default';
          if (String(o.value) === String(isDefault ? defaultVal : curVal)) o.selected = true;
          sel.appendChild(o);
        }
        // All rows support Custom... for free-form input (model IDs, effort levels like xhigh, etc.)
        const customOpt = document.createElement('option'); customOpt.value = '__custom__'; customOpt.textContent = 'Custom...';
        sel.appendChild(customOpt);
        const input = document.createElement('input'); input.type = 'text'; input.className = 'session-config-input';
        input.placeholder = isModel ? 'e.g. claude-opus-4-6' : 'e.g. xhigh';
        const known = options.map(o => o.value || o.id || '');
        const cv = isDefault ? defaultVal : curVal;
        if (cv && !known.includes(cv)) {
          sel.value = '__custom__'; input.value = cv; input.style.display = '';
        } else { input.style.display = 'none'; }
        sel.onchange = () => {
          if (sel.value === '__custom__') { input.style.display = ''; input.focus(); overrides[key] = input.value; }
          else { input.style.display = 'none'; overrides[key] = sel.value; }
          if (!cb.checked) { cb.checked = true; applyDisabled(); }
        };
        input.onchange = () => { overrides[key] = input.value; if (!cb.checked) { cb.checked = true; applyDisabled(); } };
        const applyDisabled = () => {
          const disabled = !cb.checked;
          sel.disabled = disabled;
          if (input) input.disabled = disabled;
          row.classList.toggle('session-config-disabled', disabled);
          if (disabled) overrides[key] = ''; // revert to global default
        };
        cb.onchange = () => {
          applyDisabled();
          if (cb.checked) { overrides[key] = sel.value === '__custom__' ? (input?.value || '') : sel.value; }
        };
        row.append(cb, lbl, sel);
        if (input) row.appendChild(input);
        applyDisabled();
        return row;
      };

      pop.appendChild(makeRow('Model', opts.models, 'model', true));
      pop.appendChild(makeRow('Effort', opts.efforts, 'effort'));
      pop.appendChild(makeRow('Permission', opts.permissions, 'permission'));
    };

    resumeWrap.append(resumeBtn, dropBtn, configBtn);
    actionsDiv.appendChild(resumeWrap);

    // View History button (read-only, no resume)
    const viewBtn = document.createElement('button');
    viewBtn.className = 'session-detail-btn';
    viewBtn.innerHTML = ICON.history + ' View History';
    viewBtn.onclick = (e) => {
      e.stopPropagation();
      app.viewSession(s.sessionId, s.cwd, customName || s.name, {
        ...agentOpts,
      });
    };
    actionsDiv.appendChild(viewBtn);
  }

  // Terminate button (for any running session)
  if (s.status !== 'stopped') {
    const terminateBtn = document.createElement('button');
    terminateBtn.className = 'session-detail-btn';
    terminateBtn.style.color = 'var(--red, #e55)';
    terminateBtn.innerHTML = ICON.terminate + ' Terminate';
    terminateBtn.onclick = (e) => {
      e.stopPropagation();
      if (!confirm('Terminate session "' + displayName + '"?')) return;
      if (s.webuiId) app.killSession(s.webuiId);
      else if (s.pid) app.killPid(s.pid);
    };
    actionsDiv.appendChild(terminateBtn);
  }

  card.appendChild(detailPanel);

  // Double-click name to rename (sets --name for next resume)
  const nameEl = card.querySelector('.session-card-name');
  if (nameEl) {
    if (customName) nameEl.title = `Custom name (--name on resume). Original: ${originalName}`;
    nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); onRename(s, originalName); });
  }

  const clickBehavior = settings?.get('sessionCard.clickBehavior') ?? 'focus';
  if (s.status === 'external') {
    card.style.opacity = '0.7';
    if (clickBehavior === 'focus') card.style.cursor = 'default';
    card.title = 'Running in unsupported terminal (PID ' + (s.pid || '?') + ')';
  }
  if (clickBehavior === 'expand') {
    // Click expands/collapses; use buttons inside detail to open/resume
    card.onclick = (e) => {
      if (e.target.closest('.session-detail-btn') || e.target.closest('.session-inline-btn') || e.target.closest('.session-expand-btn') || e.target.closest('.session-detail-copyable')) return;
      if (expandedCardId === s.sessionId) {
        onExpandToggle(null);
      } else {
        onExpandToggle(s.sessionId);
      }
    };
  } else if (clickBehavior === 'flash') {
    card.onclick = (e) => {
      if (e.target.closest('.session-detail-btn') || e.target.closest('.session-inline-btn') || e.target.closest('.session-expand-btn') || e.target.closest('.session-detail-copyable')) return;
      if (s.webuiId) app.flashWindow(s.webuiId);
      else if (s.status === 'tmux') app.attachTmuxSession(s.tmuxTarget, displayName, s.cwd);
      else if (s.status === 'stopped') app.resumeSession(s.sessionId, s.cwd, customName || s.name, { ...agentOpts });
    };
  } else if (clickBehavior === 'goto') {
    card.onclick = (e) => {
      if (e.target.closest('.session-detail-btn') || e.target.closest('.session-inline-btn') || e.target.closest('.session-expand-btn') || e.target.closest('.session-detail-copyable')) return;
      if (s.webuiId) app.goToWindow(s.webuiId);
      else if (s.status === 'tmux') app.attachTmuxSession(s.tmuxTarget, displayName, s.cwd);
      else if (s.status === 'stopped') app.resumeSession(s.sessionId, s.cwd, customName || s.name, { ...agentOpts });
    };
  } else {
    // Default 'focus': click opens/resumes directly
    if (s.status === 'live' && s.webuiId) {
      card.onclick = () => app.attachSession(s.webuiId, s.webuiName || displayName, s.cwd, { mode: s.webuiMode, ...agentOpts });
    } else if (s.status === 'tmux') {
      card.onclick = () => app.attachTmuxSession(s.tmuxTarget, displayName, s.cwd);
      card.title = 'Running in tmux \u2014 click to view (closing won\'t kill it)';
    } else if (s.status === 'live') {
      // LIVE but no window open (e.g. layout didn't restore it) — click to attach
      card.onclick = () => app.attachSession(s.webuiId, s.webuiName || displayName, s.cwd, { mode: s.webuiMode, ...agentOpts });
    } else if (s.status === 'stopped') {
      card.onclick = () => app.resumeSession(s.sessionId, s.cwd, customName || s.name, {
        ...agentOpts,
      });
    }
  }
  return card;
}
