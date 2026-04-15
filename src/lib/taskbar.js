import { createPopover, showContextMenu } from './utils.js';

/**
 * Rebuild the taskbar items from the current window state.
 * Called as app.updateTaskbar() — the App method delegates here.
 */
export function updateTaskbar(app) {
  const container = document.getElementById('taskbar-items'); container.innerHTML = '';
  const activeDesk = app.desktopManager?.activeDesktopId;
  for (const [id, win] of app.wm.windows) {
    // Skip grouped guests — only the host appears in taskbar
    if (win._tabChain && win._tabChain.tabs[0] !== id) continue;
    // Skip windows on other desktops
    if (activeDesk && win._desktopId && win._desktopId !== activeDesk) continue;
    const item = document.createElement('div'); item.className = 'taskbar-item';
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
    // Text column (title + subtitle)
    const textCol = document.createElement('div');
    textCol.className = 'taskbar-text';
    const title = document.createElement('div');
    title.className = 'taskbar-title';
    // Star prefix for starred sessions
    const term = app.sessions.get(id);
    let starPrefix = '';
    if (term?.sessionId) {
      const allSess = app.sidebar?._allSessions || [];
      const match = allSess.find(s => s.webuiId && s.webuiId === term.sessionId);
      if (match && app.sidebar.isStarred(match)) starPrefix = '\u2605 ';
    }
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
      const menuItems = [
        { label: '\u2725 Move', action: () => app.wm.startMoveMode(id) },
        { label: win.isMinimized ? '\u25A1 Restore' : '\u2013 Minimize', action: () => win.isMinimized ? app.wm.restore(id) : app.wm.minimize(id) },
      ];
      // "Move to Desktop" submenu
      const deskItems = app.desktopManager?.getDesktopMenuItems(id);
      if (deskItems?.length) {
        menuItems.push({ label: '\u27A4 Move to Desktop', children: deskItems });
      }
      menuItems.push({ label: '\u2715 Close', action: () => app.wm.closeWindow(id), style: 'color:var(--red, #e55)' });
      const menu = showContextMenu(e.clientX, e.clientY, menuItems, 'taskbar-context-menu');
      menu.style.top = '';
      menu.style.bottom = (window.innerHeight - e.clientY + 4) + 'px';
    });
    container.appendChild(item);
  }
  const winCount = [...app.wm.windows.values()].filter(w => !activeDesk || w._desktopId === activeDesk).length;
  const countEl = document.getElementById('active-count');
  countEl.textContent = `${winCount} windows`;
  countEl.style.cursor = 'pointer';
  countEl.onclick = (e) => { e.stopPropagation(); showWindowList(app, countEl); };
}

/**
 * Show a popover listing all open windows (triggered by "x active" click).
 */
export function showWindowList(app, anchor) {
  if (!app.wm.windows.size) return;
  const pop = createPopover(anchor, 'overlap-switcher');
  const activeDesk = app.desktopManager?.activeDesktopId;

  for (const [id, win] of app.wm.windows) {
    // Skip grouped guests — only the host appears in the list
    if (win._tabChain && win._tabChain.tabs[0] !== id) continue;
    if (activeDesk && win._desktopId && win._desktopId !== activeDesk) continue;
    const item = document.createElement('div');
    item.className = 'overlap-switcher-item';
    if (id === app.wm.activeWindowId && !win.isMinimized) item.classList.add('active');

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
    pop.appendChild(item);
  }

  requestAnimationFrame(() => {
    const rect = anchor.getBoundingClientRect();
    pop.style.left = Math.max(0, rect.right - pop.offsetWidth) + 'px';
    pop.style.top = (rect.top - pop.offsetHeight - 4) + 'px';
  });
}
