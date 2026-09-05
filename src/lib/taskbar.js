import { createPopover, showContextMenu } from './utils.js';
import { t } from './i18n.js';
import { registerCommand, registerMenuItem, menuItems as contribMenuItems } from './contributions.js';

// Resolve the sidebar SESSION object behind a session window (chat/terminal)
// — identity kept fresh in _openSpec by syncSessionIdentity. Non-session
// windows (files/editor/browser) return null: Rename/Task-Groups are
// session-level concepts.
function sessionForWin(app, win) {
  if (!win || (win.type !== 'chat' && win.type !== 'terminal')) return null;
  const spec = win._openSpec || {};
  const all = app.sidebar?._allSessions || [];
  return all.find((s) =>
    (spec.backendSessionId && s.sessionId === spec.backendSessionId)
    || (spec.serverId && s.webuiId === spec.serverId)) || null;
}

// "Switch window" submenu items (2.212.0, title-bar right-click). Scope from
// window.titlebarSwitchScope: 'overlap' (windows intersecting this one — the
// pre-2.212 behavior of the whole right-click) | 'desktop' (all windows on
// the active desktop) | 'all' (every window, cross-desktop entries labeled
// with their desktop name). Click routes through app.goToWinId (tab-chain +
// stage + desktop aware).
function switchWindowItems(app, selfId) {
  const scope = app.settings?.get('window.titlebarSwitchScope') || 'overlap';
  const wm = app.wm;
  const self = wm.windows.get(selfId);
  if (!self) return [];
  const dm = app.desktopManager;
  const activeDesk = dm?.activeDesktopId;
  const deskName = (id) => dm?.desktops?.find((d) => d.id === id)?.name || '';
  const selfRect = self.element.getBoundingClientRect();
  const items = [];
  for (const [wid, w] of wm.windows) {
    if (wid === selfId || w._isStagePlaceholder) continue;
    // tab-group GUESTS have no geometry of their own (content reparented into
    // the host element) — skip them in the geometric scope; the wider scopes
    // list them as direct jump-to-tab entries (goToWinId resolves host+tab).
    const isGuest = w._tabChain && w._tabChain.tabs[0] !== wid;
    if (scope === 'overlap') {
      if (isGuest || w._hiddenByDesktop || w._hiddenByStage || w.isMinimized) continue;
      if (!wm._rectsOverlap(selfRect, w.element.getBoundingClientRect())) continue;
    } else if (scope === 'desktop') {
      if (w._hiddenByStage) continue;
      if (activeDesk && w._desktopId && w._desktopId !== activeDesk) continue;
    }
    const otherDesk = scope === 'all' && w._desktopId && w._desktopId !== activeDesk && w._desktopId !== '__stage__';
    items.push({
      label: (w.title || w.type) + (otherDesk ? `  — ${deskName(w._desktopId)}` : '') + (w.isMinimized ? ' ' + t('(minimized)') : ''),
      action: () => app.goToWinId(wid),
    });
  }
  if (!items.length) items.push({ label: t('(no windows)'), disabled: true });
  return items;
}

/**
 * Rebuild the taskbar items from the current window state.
 * Called as app.updateTaskbar() — the App method delegates here.
 */
export function updateTaskbar(app) {
  const container = document.getElementById('taskbar-items');
  const activeDesk = app.desktopManager?.activeDesktopId;

  // Collect visible entries + per-entry star prefix (one sidebar map instead
  // of an Array.find per window)
  const webuiIdToSession = new Map();
  for (const s of app.sidebar?._allSessions || []) { if (s.webuiId) webuiIdToSession.set(s.webuiId, s); }
  const entries = [];
  for (const [id, win] of app.wm.windows) {
    // Skip grouped guests — only the host appears in taskbar
    if (win._tabChain && win._tabChain.tabs[0] !== id) continue;
    // Skip windows on other desktops
    if (activeDesk && win._desktopId && win._desktopId !== activeDesk) continue;
    const term = app.sessions.get(id);
    let starPrefix = '';
    if (term?.sessionId) {
      const match = webuiIdToSession.get(term.sessionId);
      if (match && app.sidebar.isStarred(match)) starPrefix = '\u2605 ';
    }
    // Tab group host → collect its tabs so the taskbar shows a stacked entry
    let group = null;
    if (win._tabChain && win._tabChain.tabs[0] === id) {
      const chain = win._tabChain;
      const tabWins = chain.tabs.map(tid => ({ id: tid, win: app.wm.windows.get(tid) })).filter(t => t.win);
      if (tabWins.length > 1) group = { chain, tabWins, active: Math.min(chain.active, tabWins.length - 1) };
    }
    entries.push({ id, win, starPrefix, group });
  }

  // Structure unchanged → update state classes in place. onWindowsChanged
  // fires on EVERY focus (each mousedown); a full innerHTML rebuild + listener
  // re-wiring per click was constant churn.
  const structKey = entries.map(e => {
    const g = e.group
      ? `\tG:${e.group.tabWins.map(t => t.id).join(',')}:${e.group.active}:${e.group.tabWins.map(t => t.win.title).join('\t')}`
      : '';
    return `${e.id}\t${e.win.title}\t${e.starPrefix}${g}`;
  }).join('\n');
  if (container._structKey === structKey) {
    for (const el of container.children) _applyTaskbarItemState(app, el);
  } else {
    container._structKey = structKey;
    container.innerHTML = '';
    _rebuildTaskbarItems(app, container, entries);
  }
  const winCount = [...app.wm.windows.values()].filter(w => !activeDesk || w._desktopId === activeDesk).length;
  // Compact chip: window-stack icon + bare count; the wordy label lives in the tooltip
  const countEl = document.getElementById('active-count');
  countEl.textContent = winCount;
  const chip = document.getElementById('taskbar-status');
  chip.title = `${winCount} window${winCount === 1 ? '' : 's'} — click for window list`;
  chip.onclick = (e) => { e.stopPropagation(); showWindowList(app, chip); };
}

function _rebuildTaskbarItems(app, container, entries) {
  for (const { id, win, starPrefix, group } of entries) {
    const item = document.createElement('div'); item.className = 'taskbar-item';
    item.dataset.winId = id;
    // Tab group → render a stacked entry (Windows-style) instead of a single icon
    if (group) { _buildGroupItem(app, container, item, win, starPrefix, group); continue; }
    if (id === app.wm.activeWindowId && !win.isMinimized) item.classList.add('active');
    if (win.isMinimized) item.classList.add('minimized');
    if (win.element.classList.contains('window-waiting')) item.classList.add('waiting');
    // Icon: clone the window's backend+mode icon if available, else use type emoji
    const icon = document.createElement('span');
    icon.className = 'taskbar-icon';
    if (win.backendIconSlot?.children.length) {
      const clone = win.backendIconSlot.children[0].cloneNode(true);
      clone.style.width = ''; clone.style.height = '';
      icon.appendChild(clone);
    } else {
      icon.innerHTML = win._typeIcon || '';
    }
    item.title = win.title; // full title — taskbar items truncate hard
    // Text column (title + subtitle)
    const textCol = document.createElement('div');
    textCol.className = 'taskbar-text';
    const title = document.createElement('div');
    title.className = 'taskbar-title';
    // Split title: first part = name, second part = path (after " — ")
    const parts = win.title.split(' \u2014 ');
    title.textContent = starPrefix + (parts[0] || win.title);
    const subtitle = document.createElement('div');
    subtitle.className = 'taskbar-subtitle';
    subtitle.textContent = parts[1] || win.type;
    textCol.append(title, subtitle);
    item.append(icon, textCol);
    // Draggable: allow dropping onto desktop previews
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/window-id', id);
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('click', () => {
      if (win.isMinimized) app.wm.restore(id);
      else if (id === app.wm.activeWindowId) app.wm.minimize(id);
      else app.wm.focusWindow(id);
      const session = app.sessions.get(id); if (session && !win.isMinimized) session.focus();
    });
    // Right-click context menu for window recovery
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showWindowContextMenu(app, id, e.clientX, e.clientY);
    });
    container.appendChild(item);
  }
}

// Shared per-window context menu (taskbar items, group items, window-list
// rows). Opens upward only when invoked in the lower half of the screen
// (bottom taskbar); downward otherwise \u2014 a top-docked taskbar or a
// window-count chip moved into the toolbar must not push the menu off-screen.
// opts.onAction(kind) fires after any action ('move'|'minimize'|'desktop'|
// 'close') so a hosting popover can refresh itself instead of going stale.
// ── WINDOW COMMANDS + the 'window' MENU (contributions registry, Plugin Ph1).
//    The title-bar / taskbar / window-list right-click menu is the
//    registrations below, rendered by menuItems('window', ctx) in the
//    hand-built order (scripts/test-contributions.mjs diffs it against a
//    verbatim copy of the pre-registry builder over a state matrix). Window
//    verbs are `window.*` commands over ctx.id; the session block reuses the
//    `session.*` commands session-card.js registers (same semantics: restart /
//    resume / locate / properties over ctx.s) plus two window-flavoured ones
//    (rename via the sidebar, terminate WITHOUT the card's confirm — as before).
//    ctx = { app, id, win, s (the sidebar session behind a chat/terminal
//    window, else null), switchSubmenu, closeLabel }. Items carry `kind`; the
//    renderer fires onAction(kind) after each action (children inherit their
//    parent's kind — Task Groups / Move to Desktop — never the Switch-window
//    submenu, which had none).
//    Keep this block self-contained (the gate suite extracts + replays it):
//    it closes over registerCommand, registerMenuItem, t, switchWindowItems only. ──
export function registerWindowMenu() {
  const M = 'window';
  const hasSess = (c) => !!c.s;
  const live = (c) => hasSess(c) && c.s.status === 'live';
  registerCommand({ id: 'window.move', title: () => t('Move'), run: (c) => c.app.wm.startMoveMode(c.id) });
  registerCommand({ id: 'window.minimizeOrRestore', title: (c) => (c.win.isMinimized ? t('Restore') : t('Minimize')), run: (c) => (c.win.isMinimized ? c.app.wm.restore(c.id) : c.app.wm.minimize(c.id)) });
  registerCommand({ id: 'window.renameSession', title: () => t('Rename…'), run: (c) => c.app.sidebar?.renameSession?.(c.s, c.s.name) });
  registerCommand({ id: 'window.terminateSession', title: () => t('Terminate session'), run: (c) => c.app.killSession(c.s.webuiId) });
  registerCommand({ id: 'window.close', title: () => t('Close'), run: (c) => c.app.wm.closeWindow(c.id) });
  // Title-bar variant (2.212.0): the whole right-click used to BE the overlap
  // switcher — now it's a submenu whose scope is user-configurable.
  registerMenuItem({ menu: M, group: 'navigation', order: 10, id: 'window/switch-window', when: (c) => !!c.switchSubmenu, label: () => t('Switch window'), children: (c) => switchWindowItems(c.app, c.id) });
  registerMenuItem({ menu: M, group: 'navigation', order: 20, when: (c) => !!c.switchSubmenu, separator: true });
  registerMenuItem({ menu: M, group: '1_window', order: 10, command: 'window.move', kind: 'move', label: (c, title) => '✥ ' + title });
  registerMenuItem({ menu: M, group: '1_window', order: 20, command: 'window.minimizeOrRestore', kind: 'minimize', label: (c, title) => (c.win.isMinimized ? '□ ' : '– ') + title });
  // Session windows: rename + Task Group binding straight from the window
  // chrome (2.212.0, user request) — same semantics as the session card menu.
  registerMenuItem({ menu: M, group: '1_window', order: 30, command: 'window.renameSession', kind: 'rename', when: hasSess });
  const activeGroups = (c) => (c.app.sidebar?._tasks || []).filter((tg) => !tg.archived);
  registerMenuItem({
    menu: M, group: '1_window', order: 40, id: 'window/task-groups', kind: 'groups', when: hasSess, label: () => t('Task Groups'),
    children: (c) => { // an empty list drops the submenu (registry rule) — the legacy `if (groups.length)`
      const sb = c.app.sidebar;
      const explicitIds = new Set((sb._getSessionTasks?.(c.s) || []).map((tg) => tg.id));
      const folderIds = new Set((sb._getSessionTaskGroups?.(c.s) || []).map((tg) => tg.id));
      return activeGroups(c).map((tg) => ({
        label: (explicitIds.has(tg.id) ? '✓ ' : folderIds.has(tg.id) ? '◇ ' : ' ') + tg.title + (!explicitIds.has(tg.id) && folderIds.has(tg.id) ? t(' (folder)') : ''),
        disabled: !explicitIds.has(tg.id) && folderIds.has(tg.id),
        action: () => { explicitIds.has(tg.id) ? sb._taskUnbind(tg.id, c.s) : sb._taskBind(tg.id, c.s); },
      }));
    },
  });
  // Common SESSION ops on the window chrome (owner UX 2.369.8: restart after a
  // style pick meant a sidebar hunt; the title menu is right here)
  registerMenuItem({ menu: M, group: '2_session', order: 0, when: hasSess, separator: true });
  registerMenuItem({ menu: M, group: '2_session', order: 10, id: 'window/restart-session', command: 'session.restart', kind: 'restart', when: live, label: () => '⟳ ' + t('Restart session') });
  registerMenuItem({ menu: M, group: '2_session', order: 20, command: 'window.terminateSession', kind: 'terminate', when: live, style: 'color:var(--red, #e55)' });
  registerMenuItem({ menu: M, group: '2_session', order: 10, id: 'window/resume-session', command: 'session.restart', kind: 'resume', when: (c) => hasSess(c) && c.s.status !== 'live' && !!c.s.sessionId, label: () => t('Resume session') });
  registerMenuItem({ menu: M, group: '2_session', order: 30, command: 'session.locate', kind: 'locate', when: hasSess });
  registerMenuItem({ menu: M, group: '2_session', order: 40, command: 'session.properties', kind: 'props', when: hasSess, label: () => t('Session properties…') });
  registerMenuItem({ menu: M, group: '2_session', order: 50, when: hasSess, separator: true });
  registerMenuItem({ menu: M, group: '3_close', order: 10, id: 'window/move-to-desktop', kind: 'desktop', label: () => '➤ ' + t('Move to Desktop'), children: (c) => c.app.desktopManager?.getDesktopMenuItems(c.id) || [] });
  registerMenuItem({ menu: M, group: '3_close', order: 20, command: 'window.close', kind: 'close', label: (c) => c.closeLabel, style: 'color:var(--red, #e55)' });
}
registerWindowMenu();
// end registerWindowMenu (scripts/test-contributions.mjs extracts the block above)

export function showWindowContextMenu(app, id, x, y, { closeLabel = null, onAction, switchSubmenu = false } = {}) {
  const win = app.wm.windows.get(id);
  if (!win) return;
  closeLabel = closeLabel || '✕ ' + t('Close');
  // Items come from the 'window' MENU REGISTRY (registerWindowMenu above; a
  // plugin adds rows through the same call). Every kinded action — and each
  // child of a kinded submenu — reports onAction(kind) after it runs.
  const sess = sessionForWin(app, win);
  const ctx = { app, id, win, s: sess, switchSubmenu, closeLabel };
  const wrapAct = (item, kind = item.kind) => {
    const out = { ...item };
    if (kind && typeof item.action === 'function') out.action = () => { item.action(); onAction?.(kind); };
    if (Array.isArray(item.children)) out.children = item.children.map((ch) => wrapAct(ch, kind));
    return out;
  };
  const menuItems = contribMenuItems('window', ctx).map((it) => wrapAct(it));
  const menu = showContextMenu(x, y, menuItems, 'taskbar-context-menu');
  if (y > window.innerHeight / 2) {
    menu.style.top = '';
    menu.style.bottom = (window.innerHeight - y + 4) + 'px';
  }
  return menu;
}

// Group-aware item state: a tab-group item is active/waiting if ANY of its tabs
// is, minimized if the host (which all tabs share) is. Stored tab ids let the
// in-place update path (no rebuild) stay correct without re-reading the chain.
function _applyTaskbarItemState(app, el) {
  const hostId = el.dataset.winId;
  const win = app.wm.windows.get(hostId);
  if (!win) return;
  const ids = el.dataset.groupTabs ? el.dataset.groupTabs.split(',') : [hostId];
  el.classList.toggle('active', ids.includes(app.wm.activeWindowId) && !win.isMinimized);
  el.classList.toggle('minimized', win.isMinimized);
  el.classList.toggle('waiting', ids.some(tid => app.wm.windows.get(tid)?.element.classList.contains('window-waiting')));
}

function _cloneTabIcon(win) {
  if (win.backendIconSlot?.children.length) {
    const clone = win.backendIconSlot.children[0].cloneNode(true);
    clone.style.width = ''; clone.style.height = '';
    return clone;
  }
  const span = document.createElement('span');
  span.innerHTML = win._typeIcon || '';
  return span;
}

// Stacked icon: the unique tab icons (active tab frontmost) offset like a card
// stack, plus a count badge. A single unique icon gets a faded ghost behind so
// it still reads as a stack.
function _buildStackIcon(app, group) {
  const stack = document.createElement('span');
  stack.className = 'taskbar-icon taskbar-icon-stack';
  const activeIdx = group.active;
  const order = [activeIdx, ...group.tabWins.map((_, i) => i).filter(i => i !== activeIdx)];
  const seen = new Set();
  const layers = [];
  for (const i of order) {
    const w = group.tabWins[i].win;
    const key = w.backendIconSlot?.children.length
      ? 'b:' + w.backendIconSlot.children[0].outerHTML
      : 't:' + (w._typeIcon || w.type || '');
    if (seen.has(key)) continue;
    seen.add(key);
    layers.push(w);
    if (layers.length >= 3) break;
  }
  if (layers.length === 1) layers.push(layers[0]); // ghost duplicate behind
  for (let j = layers.length - 1; j >= 0; j--) {
    const layer = document.createElement('span');
    layer.className = 'stack-layer' + (j > 0 ? ' stack-ghost' : '');
    layer.style.transform = `translate(${j * 3}px, ${j * 3}px)`;
    layer.style.zIndex = String(10 - j);
    layer.appendChild(_cloneTabIcon(layers[j]));
    stack.appendChild(layer);
  }
  const badge = document.createElement('span');
  badge.className = 'taskbar-stack-count';
  badge.textContent = String(group.tabWins.length);
  stack.appendChild(badge);
  return stack;
}

// Render a stacked tab-group taskbar item. Click expands the tab list; right
// click acts on the whole group (host).
function _buildGroupItem(app, container, item, hostWin, starPrefix, group) {
  item.classList.add('taskbar-group');
  item.title = group.tabWins.map(t => t.win.title).join('\n');
  item.dataset.groupTabs = group.tabWins.map(t => t.id).join(',');
  _applyTaskbarItemState(app, item);
  item.appendChild(_buildStackIcon(app, group));

  const activeTab = group.tabWins[group.active] || group.tabWins[0];
  const textCol = document.createElement('div'); textCol.className = 'taskbar-text';
  const title = document.createElement('div'); title.className = 'taskbar-title';
  const parts = activeTab.win.title.split(' \u2014 ');
  title.textContent = starPrefix + (parts[0] || activeTab.win.title);
  const subtitle = document.createElement('div'); subtitle.className = 'taskbar-subtitle';
  subtitle.textContent = `${group.tabWins.length} windows grouped`;
  textCol.append(title, subtitle);
  item.appendChild(textCol);

  const hostId = group.chain.tabs[0];
  item.draggable = true;
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/window-id', hostId);
    e.dataTransfer.effectAllowed = 'move';
  });
  item.addEventListener('click', () => showTabGroupList(app, item, group.chain));
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showWindowContextMenu(app, hostId, e.clientX, e.clientY, { closeLabel: '\u2715 ' + t('Close group') });
  });
  container.appendChild(item);
}

// Popover listing the tabs in a group; click one to focus the group + switch to it.
export function showTabGroupList(app, anchor, chain) {
  const pop = createPopover(anchor, 'overlap-switcher');
  for (let i = 0; i < chain.tabs.length; i++) {
    const tid = chain.tabs[i];
    const win = app.wm.windows.get(tid);
    if (!win) continue;
    const item = document.createElement('div');
    item.className = 'overlap-switcher-item';
    if (i === chain.active) item.classList.add('active');
    // carry the waiting blink into the list — the stacked icon only says "one
    // of these is waiting"; the row says WHICH
    if (win.element.classList.contains('window-waiting')) item.classList.add('waiting');
    const icon = document.createElement('span');
    icon.style.cssText = 'flex-shrink:0;display:inline-flex;align-items:center';
    icon.appendChild(_cloneTabIcon(win));
    const label = document.createElement('span');
    label.textContent = win.title;
    item.append(icon, label);
    item.onclick = () => {
      if (app.wm.windows.get(chain.tabs[0])?.isMinimized) app.wm.restore(chain.tabs[0]);
      app.wm.focusWindow(chain.tabs[0]);
      const idx = chain.tabs.indexOf(tid);
      if (idx >= 0) app.wm.switchTab(chain, idx);
      const session = app.sessions.get(tid);
      if (session) session.focus();
      pop.remove();
    };
    pop.appendChild(item);
  }
  requestAnimationFrame(() => {
    const rect = anchor.getBoundingClientRect();
    pop.style.left = Math.max(0, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 4)) + 'px';
    // Prefer above (bottom taskbar); flip below when the anchor is near the
    // top edge (top-docked taskbar)
    const above = rect.top - pop.offsetHeight - 4;
    pop.style.top = (above >= 4 ? above : rect.bottom + 4) + 'px';
  });
}

/**
 * Show a popover listing all open windows (triggered by "x active" click).
 */
export function showWindowList(app, anchor) {
  if (!app.wm.windows.size) return;
  const pop = createPopover(anchor, 'overlap-switcher');

  const place = () => requestAnimationFrame(() => {
    if (!pop.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    pop.style.left = Math.max(4, Math.min(rect.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 4)) + 'px';
    // Prefer opening above the anchor (bottom taskbar); flip below when
    // there's no room -- e.g. the chip was moved into the top toolbar
    const above = rect.top - pop.offsetHeight - 4;
    pop.style.top = (above >= 4 ? above : rect.bottom + 4) + 'px';
  });

  const render = () => {
    pop.innerHTML = '';
    const activeDesk = app.desktopManager?.activeDesktopId;
    let count = 0;
    for (const [id, win] of app.wm.windows) {
      // Skip grouped guests -- only the host appears in the list
      if (win._tabChain && win._tabChain.tabs[0] !== id) continue;
      if (activeDesk && win._desktopId && win._desktopId !== activeDesk) continue;
      count++;
      const item = document.createElement('div');
      item.className = 'overlap-switcher-item';
      if (id === app.wm.activeWindowId && !win.isMinimized) item.classList.add('active');
      // waiting blink — for a tab-group host, aggregate over ALL its tabs
      // (guests are skipped from this list, so the host row speaks for them)
      const tabIds = win._tabChain ? win._tabChain.tabs : [id];
      if (tabIds.some(tid => app.wm.windows.get(tid)?.element.classList.contains('window-waiting'))) item.classList.add('waiting');

      const icon = document.createElement('span');
      icon.innerHTML = win._typeIcon || '';
      icon.style.cssText = 'font-size:11px;flex-shrink:0;display:inline-flex;align-items:center';
      if (win.isMinimized) icon.style.opacity = '0.4';
      const label = document.createElement('span');
      label.textContent = (win.isMinimized ? '\u229E ' : '') + win.title;
      item.append(icon, label);
      item.onclick = () => {
        if (win.isMinimized) app.wm.restore(id);
        else app.wm.focusWindow(id);
        const session = app.sessions.get(id);
        if (session) session.focus();
        pop.remove();
      };
      // Right-click: same per-window menu as the taskbar item. The list stays
      // open under the menu (attachPopoverClose ignores clicks inside other
      // popovers) and refreshes in place after the action -- except Move,
      // which takes over the whole screen, so the list gets out of the way.
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showWindowContextMenu(app, id, e.clientX, e.clientY, {
          onAction: (kind) => {
            if (!pop.isConnected) return;
            if (kind === 'move') pop.remove();
            else render();
          },
        });
      });
      pop.appendChild(item);
    }
    if (!count) { pop.remove(); return; }
    place();
  };
  render();
}
