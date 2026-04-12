import { escHtml, copyText } from './utils.js';

/**
 * Render the detail groups section inside a session card.
 * @param {HTMLElement} container - DOM container for groups
 * @param {string} sessionId
 * @param {boolean} clickToCopy
 * @param {object} state - sidebar instance (for _getSessionGroups, _showGroupChecklistPopover, _addSessionToGroup, _removeSessionFromGroup)
 */
function renderDetailGroups(container, sessionId, clickToCopy, state) {
  container.innerHTML = '';
  const sessionGroups = state._getSessionGroups(sessionId);
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
    const groups = state._getSessionGroups(sessionId);
    state._showGroupChecklistPopover(btn,
      (name) => groups.includes(name),
      (name, checked) => { if (checked) state._addSessionToGroup(sessionId, name); else state._removeSessionFromGroup(sessionId, name); });
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
 * @param {function} opts.onRename - callback(sessionId, originalName) for rename
 * @returns {HTMLElement}
 */
export function renderSessionCard(s, { state, app, settings, expandedCardId, onExpandToggle, onRename }) {
  const card = document.createElement('div'); card.className = 'session-item-card';
  card._sessionId = s.sessionId; // Store for highlight lookup
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-session-id', s.sessionId);
    e.dataTransfer.effectAllowed = 'link';
  });
  const isArchived = state.isArchived(s.sessionId);
  if (isArchived) card.classList.add('archived');
  if (expandedCardId === s.sessionId) card.classList.add('expanded');
  const date = new Date(s.startedAt);
  const customName = state.getCustomName(s.sessionId);
  const cwdFolder = s.cwd ? s.cwd.replace(/\/+$/, '').split('/').pop() : '';
  const originalName = s.name || s.webuiName || cwdFolder || s.sessionId.substring(0, 12) + '...';
  const displayName = customName || originalName;

  const badgeMap = {
    live:     { cls: 'badge-live', text: 'LIVE' },
    tmux:     { cls: 'badge-tmux', text: 'TMUX' },
    external: { cls: 'badge-external', text: 'EXTERNAL' },
    stopped:  { cls: 'badge-stopped', text: 'STOPPED' },
  };
  const badge = badgeMap[s.status] || badgeMap.stopped;

  const starred = state.isStarred(s.sessionId);
  const isExpanded = expandedCardId === s.sessionId;
  // Compact row: star archive name [mode] badge expand
  const modeIcon = s.webuiMode === 'chat' ? '<span class="session-mode-icon" title="Chat mode">\uD83D\uDCAC</span>' : '';
  card.innerHTML = `<div class="session-card-row">
    <span class="session-card-name">${escHtml(displayName)}</span>
    ${modeIcon}<span class="session-card-badge ${badge.cls}">${badge.text}</span>
  </div>`;
  const row = card.querySelector('.session-card-row');
  // Star button (inline, always visible)
  const starBtn = document.createElement('button');
  starBtn.className = 'session-inline-btn' + (starred ? ' starred' : '');
  starBtn.textContent = starred ? '\u2605' : '\u2606';
  starBtn.title = starred ? 'Unstar' : 'Star';
  starBtn.onclick = (e) => { e.stopPropagation(); state.toggleStar(s.sessionId); };
  row.insertBefore(starBtn, row.firstChild);
  // Archive button (inline, always visible)
  const archBtn = document.createElement('button');
  archBtn.className = 'session-inline-btn' + (isArchived ? ' archived' : '');
  archBtn.textContent = isArchived ? '\u{1F4E4}' : '\u{1F4E6}';
  archBtn.title = isArchived ? 'Unarchive' : 'Archive';
  archBtn.onclick = (e) => { e.stopPropagation(); state.toggleArchive(s.sessionId); };
  row.insertBefore(archBtn, row.children[1]);

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

  const visibleFields = settings?.get('sessionCard.visibleFields') ?? ['id', 'cwd', 'started', 'status', 'groups'];
  const clickToCopy = settings?.get('sessionCard.clickToCopy') ?? false;
  const truncation = settings?.get('sessionCard.detailTruncation') ?? 'left';
  const cwdShort = (s.cwd || '').replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~');

  const fields = [
    { key: 'id', label: 'ID', display: s.sessionId, copy: s.sessionId, copiable: true, midTruncate: true },
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
    renderDetailGroups(groupsContainer, s.sessionId, clickToCopy, state);
  }

  const actionsDiv = document.createElement('div'); actionsDiv.className = 'session-detail-actions';
  detailPanel.appendChild(actionsDiv);

  // Rename button
  const detailRenameBtn = document.createElement('button');
  detailRenameBtn.className = 'session-detail-btn';
  detailRenameBtn.textContent = '\u270F Rename';
  detailRenameBtn.onclick = (e) => { e.stopPropagation(); onRename(s.sessionId, originalName); };
  actionsDiv.appendChild(detailRenameBtn);

  // Find button — highlight the window + taskbar item with fast blink
  if (s.webuiId) {
    const findBtn = document.createElement('button');
    findBtn.className = 'session-detail-btn';
    findBtn.textContent = '\uD83D\uDD0D Find';
    findBtn.onclick = (e) => {
      e.stopPropagation();
      app.flashWindow(s.webuiId);
    };
    actionsDiv.appendChild(findBtn);
  }

  // Resume/Attach action button
  if (s.status === 'live' && s.webuiId) {
    const detailAttachBtn = document.createElement('button');
    detailAttachBtn.className = 'session-detail-btn session-detail-btn-primary';
    detailAttachBtn.textContent = '\u25B6 Attach';
    detailAttachBtn.onclick = (e) => { e.stopPropagation(); app.attachSession(s.webuiId, s.webuiName || displayName, s.cwd, { mode: s.webuiMode }); };
    actionsDiv.appendChild(detailAttachBtn);
  } else if (s.status === 'tmux') {
    const detailTmuxBtn = document.createElement('button');
    detailTmuxBtn.className = 'session-detail-btn session-detail-btn-primary';
    detailTmuxBtn.textContent = '\u25B6 View';
    detailTmuxBtn.onclick = (e) => { e.stopPropagation(); app.attachTmuxSession(s.tmuxTarget, displayName, s.cwd); };
    actionsDiv.appendChild(detailTmuxBtn);
  } else if (s.status === 'stopped') {
    const savedMode = state.getSessionMode(s.sessionId);
    const defaultMode = settings?.get('session.defaultMode') ?? 'terminal';
    let resumeMode = savedMode || defaultMode;

    const resumeWrap = document.createElement('div');
    resumeWrap.className = 'session-resume-split';

    const resumeBtn = document.createElement('button');
    const dropBtn = document.createElement('button');
    const updateLabel = () => {
      const isChat = resumeMode === 'chat';
      resumeBtn.textContent = isChat ? '\uD83D\uDCAC Resume in Chat' : '\u25B6 Resume in Terminal';
      resumeBtn.className = 'session-detail-btn ' + (isChat ? 'session-detail-btn-chat' : 'session-detail-btn-primary');
      dropBtn.className = 'session-resume-drop ' + (isChat ? 'session-detail-btn-chat' : 'session-detail-btn-primary');
    };
    updateLabel();
    resumeBtn.onclick = (e) => { e.stopPropagation(); app.resumeSession(s.sessionId, s.cwd, customName || s.name, { mode: resumeMode }); };

    dropBtn.textContent = '\u25BE';
    dropBtn.onclick = (e) => {
      e.stopPropagation();
      resumeMode = resumeMode === 'chat' ? 'terminal' : 'chat';
      state.setSessionMode(s.sessionId, resumeMode);
      updateLabel();
    };

    resumeWrap.append(resumeBtn, dropBtn);
    actionsDiv.appendChild(resumeWrap);

    // View History button (read-only, no resume)
    const viewBtn = document.createElement('button');
    viewBtn.className = 'session-detail-btn';
    viewBtn.textContent = '\uD83D\uDCCB View History';
    viewBtn.onclick = (e) => { e.stopPropagation(); app.viewSession(s.sessionId, s.cwd, customName || s.name); };
    actionsDiv.appendChild(viewBtn);
  }

  // Terminate button (for any running session)
  if (s.status !== 'stopped') {
    const terminateBtn = document.createElement('button');
    terminateBtn.className = 'session-detail-btn';
    terminateBtn.style.color = 'var(--red, #e55)';
    terminateBtn.textContent = '\u2715 Terminate';
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
    nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); onRename(s.sessionId, originalName); });
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
    // Click flashes/bounces the corresponding window
    card.onclick = (e) => {
      if (e.target.closest('.session-detail-btn') || e.target.closest('.session-inline-btn') || e.target.closest('.session-expand-btn') || e.target.closest('.session-detail-copyable')) return;
      if (s.webuiId) app.flashWindow(s.webuiId);
      else if (s.status === 'live' && s.webuiId) app.attachSession(s.webuiId, s.webuiName || displayName, s.cwd, { mode: s.webuiMode });
      else if (s.status === 'tmux') app.attachTmuxSession(s.tmuxTarget, displayName, s.cwd);
      else if (s.status === 'stopped') app.resumeSession(s.sessionId, s.cwd, customName || s.name);
    };
  } else {
    // Default 'focus': click opens/resumes directly
    if (s.status === 'live' && s.webuiId) {
      card.onclick = () => app.attachSession(s.webuiId, s.webuiName || displayName, s.cwd, { mode: s.webuiMode });
    } else if (s.status === 'tmux') {
      card.onclick = () => app.attachTmuxSession(s.tmuxTarget, displayName, s.cwd);
      card.title = 'Running in tmux \u2014 click to view (closing won\'t kill it)';
    } else if (s.status === 'live') {
      // LIVE but no window open (e.g. layout didn't restore it) — click to attach
      card.onclick = () => app.attachSession(s.webuiId, s.webuiName || displayName, s.cwd, { mode: s.webuiMode });
    } else if (s.status === 'stopped') {
      card.onclick = () => app.resumeSession(s.sessionId, s.cwd, customName || s.name);
    }
  }
  return card;
}
