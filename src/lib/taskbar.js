import { createPopover, showContextMenu } from './utils.js';

/**
 * Rebuild the taskbar items from the current window state.
 * Called as app.updateTaskbar() — the App method delegates here.
 */
export function updateTaskbar(app) {
  const container = document.getElementById('taskbar-items'); container.innerHTML = '';
  for (const [id, win] of app.wm.windows) {
    // Skip grouped guests — only the host appears in taskbar
    if (win._tabChain && win._tabChain.tabs[0] !== id) continue;
    const item = document.createElement('div'); item.className = 'taskbar-item';
    if (id === app.wm.activeWindowId && !win.isMinimized) item.classList.add('active');
    if (win.isMinimized) item.classList.add('minimized');
    if (win.element.classList.contains('window-waiting')) item.classList.add('waiting');
    if (win.type === 'terminal') {
      const term = app.sessions.get(id);
      // Check if this session is starred
      const allSess = app.sidebar?._allSessions || [];
      const match = allSess.find(s => s.webuiId && s.webuiId === term?.sessionId);
      const isStarred = match && app.sidebar.isStarred(match.sessionId);
      if (isStarred) {
        const star = document.createElement('span'); star.textContent = '\u2605'; star.style.cssText = 'color:var(--yellow);font-size:10px;margin-right:2px'; item.appendChild(star);
      } else {
        const dot = document.createElement('span'); dot.className = 'taskbar-dot'; if (win.exited) dot.classList.add('exited'); item.appendChild(dot);
      }
    }
    const label = document.createElement('span'); label.textContent = win.title; item.appendChild(label);
    item.addEventListener('click', () => {
      if (win.isMinimized) app.wm.restore(id);
      else if (id === app.wm.activeWindowId) app.wm.minimize(id);
      else app.wm.focusWindow(id);
      const session = app.sessions.get(id); if (session && !win.isMinimized) session.focus();
    });
    // Right-click context menu for window recovery
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menu = showContextMenu(e.clientX, e.clientY, [
        { label: '\u2725 Move', action: () => app.wm.startMoveMode(id) },
        { label: win.isMinimized ? '\u25A1 Restore' : '\u2013 Minimize', action: () => win.isMinimized ? app.wm.restore(id) : app.wm.minimize(id) },
        { label: '\u2715 Close', action: () => app.wm.closeWindow(id), style: 'color:var(--red, #e55)' },
      ], 'taskbar-context-menu');
      menu.style.top = '';
      menu.style.bottom = (window.innerHeight - e.clientY + 4) + 'px';
    });
    container.appendChild(item);
  }
  const activeCount = [...app.wm.windows.values()].filter(w => w.type==='terminal' && !w.exited).length;
  const countEl = document.getElementById('active-count');
  countEl.textContent = `${activeCount} active`;
  countEl.style.cursor = 'pointer';
  countEl.onclick = (e) => { e.stopPropagation(); showWindowList(app, countEl); };
}

/**
 * Show a popover listing all open windows (triggered by "x active" click).
 */
export function showWindowList(app, anchor) {
  if (!app.wm.windows.size) return;
  const pop = createPopover(anchor, 'overlap-switcher');

  for (const [id, win] of app.wm.windows) {
    // Skip grouped guests — only the host appears in the list
    if (win._tabChain && win._tabChain.tabs[0] !== id) continue;
    const item = document.createElement('div');
    item.className = 'overlap-switcher-item';
    if (id === app.wm.activeWindowId && !win.isMinimized) item.classList.add('active');

    // Check if starred
    const term = app.sessions.get(id);
    const allSess = app.sidebar?._allSessions || [];
    const match = allSess.find(s => s.webuiId && s.webuiId === term?.sessionId);
    const isStarred = match && app.sidebar.isStarred(match.sessionId);

    const indicator = document.createElement('span');
    if (isStarred) {
      indicator.textContent = '\u2605'; indicator.style.cssText = 'color:var(--yellow);font-size:11px;flex-shrink:0';
    } else {
      indicator.className = 'taskbar-dot';
      if (win.exited) indicator.classList.add('exited');
    }
    if (win.isMinimized) indicator.style.opacity = '0.4';
    const label = document.createElement('span');
    label.textContent = (win.isMinimized ? '\u229E ' : '') + win.title;
    item.append(indicator, label);
    item.onclick = () => {
      if (win.isMinimized) app.wm.restore(id);
      else app.wm.focusWindow(id);
      const session = app.sessions.get(id);
      if (session) session.focus();
      pop.remove();
    };
    pop.appendChild(item);
  }

  requestAnimationFrame(() => {
    const rect = anchor.getBoundingClientRect();
    pop.style.left = Math.max(0, rect.right - pop.offsetWidth) + 'px';
    pop.style.top = (rect.top - pop.offsetHeight - 4) + 'px';
  });
}
