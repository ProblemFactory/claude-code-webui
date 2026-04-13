/**
 * Tab grouping — mixin methods for WindowManager.
 * Adds tab chain support: drag window icon onto another to merge into tabs.
 *
 * Chain model: { tabs: [hostId, ...guestIds], active: index }
 * All grouped windows share the same chain reference via win._tabChain.
 * tabs[0] is always the host (owns the physical .window element).
 */

export const TYPE_ICONS = {
  terminal: '\u2B1B', chat: '\uD83D\uDCAC', files: '\uD83D\uDCC1', viewer: '\uD83D\uDCC4',
  editor: '\u270F\uFE0F', 'hex-viewer': '\uD83D\uDD22', browser: '\uD83C\uDF10',
};

/**
 * Install tab group methods onto a WindowManager instance.
 * Called once from WindowManager constructor.
 */
export function installTabGroupMixin(wm) {
  Object.assign(wm, tabGroupMethods);
}

const tabGroupMethods = {

  _syncChainBounds(chain) {
    const host = this.windows.get(chain.tabs[0]);
    if (!host) return;
    for (let i = 1; i < chain.tabs.length; i++) {
      const guest = this.windows.get(chain.tabs[i]);
      if (guest) guest.gridBounds = host.gridBounds ? { ...host.gridBounds } : null;
    }
  },

  _setupIconDrag(winInfo) {
    const icon = winInfo.iconSpan;
    if (!icon) return;
    let mouseDown = false, dragging = false, ghost = null, startX, startY;
    let targetWin = null;

    icon.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      mouseDown = true; dragging = false;
      startX = e.clientX; startY = e.clientY;
    });

    const onMove = (e) => {
      if (!mouseDown) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!dragging) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        dragging = true;
        ghost = document.createElement('div');
        ghost.className = 'tab-ghost';
        ghost.innerHTML = `<span>${winInfo._typeIcon}</span><span>${winInfo.title}</span>`;
        document.body.appendChild(ghost);
      }
      ghost.style.left = (e.clientX + 12) + 'px';
      ghost.style.top = (e.clientY + 12) + 'px';

      // Hit-test other windows' icons
      targetWin = null;
      for (const [id, w] of this.windows) {
        if (id === winInfo.id) continue;
        if (w._tabChain && w._tabChain.tabs[0] !== w.id) continue;
        const wIcon = w.iconSpan;
        if (!wIcon) continue;
        if (w._tabChain) {
          const tabItems = w.titleBar.querySelectorAll('.tab-item .tab-icon');
          for (const ti of tabItems) {
            const r = ti.getBoundingClientRect();
            if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
              targetWin = w; break;
            }
          }
          if (targetWin) break;
        }
        const r = wIcon.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          targetWin = w; break;
        }
      }
      for (const [, w] of this.windows) {
        w.element.classList.toggle('tab-drop-target', w === targetWin);
      }
    };

    const onUp = () => {
      if (!mouseDown) return;
      mouseDown = false;
      if (ghost) { ghost.remove(); ghost = null; }
      for (const [, w] of this.windows) w.element.classList.remove('tab-drop-target');
      if (!dragging) return;
      dragging = false;

      if (targetWin && targetWin.id !== winInfo.id) {
        if (winInfo._tabChain && winInfo._tabChain === targetWin._tabChain) return;
        if (winInfo._tabChain) this._detachFromChain(winInfo._tabChain, winInfo.id);
        if (targetWin._tabChain) this.addToTabChain(targetWin._tabChain, winInfo);
        else this.createTabChain(targetWin, winInfo);
      }
      targetWin = null;
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  },

  createTabChain(hostWin, guestWin) {
    const chain = { tabs: [hostWin.id, guestWin.id], active: 1 };
    hostWin._tabChain = chain;
    guestWin._tabChain = chain;
    // Enforce same desktop: guest inherits host's desktop
    if (hostWin._desktopId) guestWin._desktopId = hostWin._desktopId;
    // Host content hidden, guest content visible (guest = newly dragged in = active)
    hostWin.content.classList.add('tab-hidden');
    hostWin.element.appendChild(guestWin.content);
    guestWin.element.style.display = 'none';
    guestWin.gridBounds = hostWin.gridBounds ? { ...hostWin.gridBounds } : null;
    this.activeWindowId = guestWin.id;
    this._renderTabBar(chain);
    this._notify();
  },

  addToTabChain(chain, guestWin) {
    chain.tabs.push(guestWin.id);
    guestWin._tabChain = chain;
    const hostWin = this.windows.get(chain.tabs[0]);
    // Enforce same desktop
    if (hostWin?._desktopId) guestWin._desktopId = hostWin._desktopId;
    if (!hostWin) return;
    guestWin.content.classList.add('tab-hidden');
    hostWin.element.appendChild(guestWin.content);
    guestWin.element.style.display = 'none';
    guestWin.gridBounds = hostWin.gridBounds ? { ...hostWin.gridBounds } : null;
    this._renderTabBar(chain);
    this.switchTab(chain, chain.tabs.length - 1);
    this._notify();
  },

  _renderTabBar(chain) {
    const hostWin = this.windows.get(chain.tabs[0]);
    if (!hostWin) return;
    const titleBar = hostWin.titleBar;
    const existing = titleBar.querySelector('.tab-bar-tabs');
    if (existing) existing.remove();
    const standaloneIcon = titleBar.querySelector(':scope > .window-type-icon');
    if (standaloneIcon) standaloneIcon.style.display = 'none';
    hostWin.titleSpan.style.display = 'none';

    const tabBar = document.createElement('div');
    tabBar.className = 'tab-bar-tabs';

    for (let i = 0; i < chain.tabs.length; i++) {
      const tabWinId = chain.tabs[i];
      const tabWin = this.windows.get(tabWinId);
      if (!tabWin) continue;

      const tab = document.createElement('div');
      tab.className = 'tab-item';
      tab.dataset.winId = tabWinId;
      if (i === chain.active) tab.classList.add('active');

      const icon = document.createElement('span');
      icon.className = 'tab-icon';
      icon.textContent = tabWin._typeIcon || '';
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = tabWin.title;
      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.textContent = '\u2715';
      closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.removeFromTabChain(chain, tabWinId); });

      tab.append(icon, label, closeBtn);
      tab.addEventListener('mousedown', (e) => {
        if (e.target.closest('.tab-close')) return;
        e.stopPropagation();
        const idx = chain.tabs.indexOf(tabWinId);
        if (idx >= 0 && idx !== chain.active) this.switchTab(chain, idx);
      });
      this._setupTabDrag(tab, tabWinId, chain);
      tabBar.appendChild(tab);
    }

    const controls = titleBar.querySelector('.window-controls');
    titleBar.insertBefore(tabBar, controls);
  },

  switchTab(chain, index) {
    if (index < 0 || index >= chain.tabs.length) return;
    const hostWin = this.windows.get(chain.tabs[0]);
    if (!hostWin) return;
    const prevWin = this.windows.get(chain.tabs[chain.active]);
    if (prevWin) prevWin.content.classList.add('tab-hidden');
    chain.active = index;
    const newWin = this.windows.get(chain.tabs[index]);
    if (newWin) newWin.content.classList.remove('tab-hidden');
    const tabs = hostWin.titleBar.querySelectorAll('.tab-item');
    tabs.forEach((t, i) => t.classList.toggle('active', i === index));
    this.activeWindowId = chain.tabs[index];
    requestAnimationFrame(() => { if (newWin && newWin.onResize) newWin.onResize(); });
    this._notify();
  },

  _setupTabDrag(tabEl, winId, chain) {
    let mouseDown = false, startX = 0, startY = 0, detached = false;

    tabEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('.tab-close') || e.button !== 0) return;
      if (chain.tabs.length <= 1) return;
      mouseDown = true; detached = false;
      startX = e.clientX; startY = e.clientY;
      e.preventDefault();
    });

    const onMove = (e) => {
      if (!mouseDown) return;
      if (!detached && Math.abs(e.clientY - startY) > 30) {
        detached = true;
        this._detachFromChain(chain, winId);
        const win = this.windows.get(winId);
        if (!win) { mouseDown = false; return; }
        const w = parseInt(win.element.style.width) || 700;
        win.element.style.left = (e.clientX - w / 2) + 'px';
        win.element.style.top = (e.clientY - 15) + 'px';
        win.element.classList.add('dragging');
        if (this.grid) this.gridOverlay.classList.add('dragging');
      }
      if (detached) {
        const win = this.windows.get(winId);
        if (!win) return;
        const w = parseInt(win.element.style.width) || 700;
        win.element.style.left = (e.clientX - w / 2) + 'px';
        win.element.style.top = (e.clientY - 15) + 'px';
        if (!e.altKey) {
          if (this.grid) this._showGridHighlight(e.clientX, e.clientY);
          else this._showSnap(e.clientX, e.clientY);
        }
      }
    };

    const onUp = (e) => {
      if (!mouseDown) return;
      mouseDown = false;
      if (!detached) return;
      const win = this.windows.get(winId);
      if (!win) return;
      win.element.classList.remove('dragging');
      this.snapIndicator.style.display = 'none';
      this.gridOverlay.classList.remove('dragging');
      let snapped = false;
      if (!e.altKey) {
        if (this.grid) { this._snapToGrid(winId, e.clientX, e.clientY); snapped = true; }
        else { const snap = this._getSnapZone(e.clientX, e.clientY); if (snap) { this._applySnap(winId, snap); snapped = true; } }
      }
      if (snapped) win._isSnapped = true;
      this._clearGridHighlight();
      setTimeout(() => { this._captureGridBounds(win); this._scheduleOverlapUpdate(); this._notify(); }, 250);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  },

  _detachFromChain(chain, winId) {
    const idx = chain.tabs.indexOf(winId);
    if (idx < 0) return;
    const win = this.windows.get(winId);
    if (!win) return;
    const hostWin = this.windows.get(chain.tabs[0]);
    const isHost = idx === 0;

    if (isHost && chain.tabs.length > 1) {
      const newHostId = chain.tabs[1];
      const newHost = this.windows.get(newHostId);
      if (!newHost) return;
      for (let i = 1; i < chain.tabs.length; i++) {
        const gw = this.windows.get(chain.tabs[i]);
        if (gw && gw.id !== winId) {
          hostWin.element.removeChild(gw.content);
          newHost.element.appendChild(gw.content);
        }
      }
      newHost.element.style.left = hostWin.element.style.left;
      newHost.element.style.top = hostWin.element.style.top;
      newHost.element.style.width = hostWin.element.style.width;
      newHost.element.style.height = hostWin.element.style.height;
      newHost.element.style.zIndex = hostWin.element.style.zIndex;
      newHost.element.style.display = '';
      newHost.gridBounds = hostWin.gridBounds ? { ...hostWin.gridBounds } : null;
      newHost.isMaximized = hostWin.isMaximized;
      newHost.prevBounds = hostWin.prevBounds;
      chain.tabs.splice(idx, 1);
      if (chain.active >= chain.tabs.length) chain.active = chain.tabs.length - 1;
      if (chain.active < 0) chain.active = 0;
    } else {
      if (hostWin && hostWin.element.contains(win.content)) {
        hostWin.element.removeChild(win.content);
        win.element.appendChild(win.content);
      }
      chain.tabs.splice(idx, 1);
      if (chain.active >= chain.tabs.length) chain.active = chain.tabs.length - 1;
      if (chain.active < 0) chain.active = 0;
    }

    win.content.classList.remove('tab-hidden');
    win._tabChain = null;
    if (hostWin && win.id !== hostWin.id) {
      win.element.style.left = hostWin.element.style.left;
      win.element.style.top = hostWin.element.style.top;
      win.element.style.width = hostWin.element.style.width;
      win.element.style.height = hostWin.element.style.height;
      win.element.style.zIndex = hostWin.element.style.zIndex;
      win.gridBounds = hostWin.gridBounds ? { ...hostWin.gridBounds } : null;
    }
    win.element.style.display = '';
    const standaloneIcon = win.titleBar.querySelector(':scope > .window-type-icon');
    if (standaloneIcon) standaloneIcon.style.display = '';
    win.titleSpan.style.display = '';
    const existingTabBar = win.titleBar.querySelector('.tab-bar-tabs');
    if (existingTabBar) existingTabBar.remove();

    if (chain.tabs.length <= 1) {
      this._ungroupLast(chain);
    } else {
      const currentHost = this.windows.get(chain.tabs[0]);
      if (currentHost) {
        const activeWin = this.windows.get(chain.tabs[chain.active]);
        if (activeWin) activeWin.content.classList.remove('tab-hidden');
        this._renderTabBar(chain);
      }
    }

    requestAnimationFrame(() => { if (win.onResize) win.onResize(); });
    this._notify();
  },

  removeFromTabChain(chain, winId) {
    const win = this.windows.get(winId);
    if (!win) return;
    this._detachFromChain(chain, winId);
    if (win.onClose) win.onClose();
    win.element.remove();
    this.windows.delete(winId);
    this._notify(); this._scheduleOverlapUpdate();
  },

  _ungroupLast(chain) {
    if (chain.tabs.length !== 1) return;
    const lastWin = this.windows.get(chain.tabs[0]);
    if (!lastWin) return;
    lastWin._tabChain = null;
    lastWin.content.classList.remove('tab-hidden');
    const standaloneIcon = lastWin.titleBar.querySelector(':scope > .window-type-icon');
    if (standaloneIcon) standaloneIcon.style.display = '';
    lastWin.titleSpan.style.display = '';
    const tabBar = lastWin.titleBar.querySelector('.tab-bar-tabs');
    if (tabBar) tabBar.remove();
    lastWin.element.style.display = '';
    requestAnimationFrame(() => { if (lastWin.onResize) lastWin.onResize(); });
  },

  restoreTabChain(tabIds, activeIndex) {
    if (!tabIds || tabIds.length < 2) return;
    const hostWin = this.windows.get(tabIds[0]);
    if (!hostWin) return;
    const chain = { tabs: [], active: activeIndex || 0 };
    chain.tabs.push(hostWin.id);
    hostWin._tabChain = chain;
    for (let i = 1; i < tabIds.length; i++) {
      const guestWin = this.windows.get(tabIds[i]);
      if (!guestWin) continue;
      chain.tabs.push(guestWin.id);
      guestWin._tabChain = chain;
      guestWin.content.classList.add('tab-hidden');
      hostWin.element.appendChild(guestWin.content);
      guestWin.element.style.display = 'none';
      guestWin.gridBounds = hostWin.gridBounds ? { ...hostWin.gridBounds } : null;
    }
    const activeWin = this.windows.get(chain.tabs[chain.active]);
    if (activeWin) activeWin.content.classList.remove('tab-hidden');
    if (chain.active !== 0) hostWin.content.classList.add('tab-hidden');
    this._renderTabBar(chain);
  },
};
