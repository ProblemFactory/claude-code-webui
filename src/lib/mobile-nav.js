/**
 * MobileNav — mobile navigation bar controller.
 *
 * Manages: hamburger menu, window switcher (tap title), close button,
 * new session button, title updates, edge-swipe gestures.
 *
 * Constructed by App when isMobile is true. Receives app reference
 * for sidebar/window/session access.
 */

export class MobileNav {
  constructor(app) {
    this.app = app;
    this._titleEl = document.getElementById('mobile-nav-title');

    document.getElementById('mobile-nav-menu').onclick = () => app.sidebar.toggle(true);
    document.getElementById('mobile-nav-new').onclick = () => app.showNewSessionDialog();

    document.getElementById('mobile-nav-close').onclick = () => {
      const activeId = app.wm.activeWindowId;
      if (activeId) app.wm.closeWindow(activeId);
    };

    this._titleEl.onclick = () => this._showWindowSwitcher();
    this._setupGestures();
  }

  updateTitle() {
    if (!this._titleEl) return;
    const win = this.app.wm.windows.get(this.app.wm.activeWindowId);
    const count = [...this.app.wm.windows.values()].filter(w => !w._hiddenByDesktop && !w.isMinimized).length;
    this._titleEl.textContent = (win?.title || 'Claude Code') + (count > 1 ? ` (${count})` : '');
  }

  _showWindowSwitcher() {
    const anchor = this._titleEl;
    if (!anchor) return;
    const existing = document.querySelector('.mobile-win-switcher');
    if (existing) { existing.remove(); return; }

    const pop = document.createElement('div');
    pop.className = 'mobile-win-switcher';
    pop.style.cssText = 'position:fixed;left:0;right:0;z-index:90001;background:var(--bg-dialog);border-bottom:1px solid var(--border);box-shadow:0 4px 16px rgba(0,0,0,0.3);max-height:60vh;overflow-y:auto;-webkit-overflow-scrolling:touch';
    const navRect = anchor.closest('#mobile-nav').getBoundingClientRect();
    pop.style.top = navRect.bottom + 'px';

    const wm = this.app.wm;
    const dm = this.app.desktopManager;
    const desktops = dm?.desktops || [];
    const allWindows = [...wm.windows.values()].filter(w => !w.isMinimized);

    // Desktop tabs (only when 2+ desktops)
    if (desktops.length >= 2) {
      const tabBar = document.createElement('div');
      tabBar.style.cssText = 'display:flex;gap:0;border-bottom:2px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch;flex-shrink:0';
      for (const desk of desktops) {
        const tab = document.createElement('button');
        const isActive = desk.id === dm.activeDesktopId;
        const winCount = allWindows.filter(w => w._desktopId === desk.id).length;
        tab.textContent = `${desk.name} (${winCount})`;
        tab.style.cssText = `flex:1;padding:10px 12px;border:none;background:none;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;color:${isActive ? 'var(--accent)' : 'var(--text-dim)'};border-bottom:2px solid ${isActive ? 'var(--accent)' : 'transparent'};margin-bottom:-2px`;
        tab.onclick = () => {
          pop.remove();
          dm.switchTo(desk.id);
        };
        tabBar.appendChild(tab);
      }
      pop.appendChild(tabBar);
    }

    // Window list (current desktop only)
    const windows = allWindows.filter(w => !w._hiddenByDesktop);
    if (!windows.length) {
      pop.innerHTML += '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:13px">No open windows</div>';
    } else {
      for (const win of windows) {
        pop.appendChild(this._buildWindowItem(win, wm, pop));
      }
    }

    document.body.appendChild(pop);
    const onTap = (e) => { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener('pointerdown', onTap); } };
    setTimeout(() => document.addEventListener('pointerdown', onTap), 0);
  }

  _buildWindowItem(win, wm, pop) {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer;border-bottom:1px solid var(--border);transition:background 0.1s';
    if (win.id === wm.activeWindowId) item.style.background = 'var(--accent-dim)';

    const icon = document.createElement('span');
    icon.style.cssText = 'flex-shrink:0;font-size:16px';
    icon.innerHTML = win._typeIcon || '';

    const label = document.createElement('span');
    label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--text)';
    label.textContent = win.title || 'Window';

    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;color:var(--text-dim);font-size:16px;padding:4px 8px;cursor:pointer;flex-shrink:0;min-width:32px;min-height:32px;display:flex;align-items:center;justify-content:center';
    closeBtn.textContent = '\u2715';
    closeBtn.onclick = (e) => { e.stopPropagation(); wm.closeWindow(win.id); item.remove(); };

    item.append(icon, label, closeBtn);
    item.addEventListener('pointerdown', () => { item.style.background = 'var(--bg-hover)'; });
    item.onclick = () => { pop.remove(); wm.focusWindow(win.id); };
    return item;
  }

  _setupGestures() {
    const app = this.app;
    let startX = 0, startY = 0;
    document.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > 80 && Math.abs(dy) < 50) {
        if (dx > 0 && startX < 30) app.sidebar.toggle(true);
        else if (dx < 0 && app.sidebar.isOpen) app.sidebar.toggle(false);
      }
    }, { passive: true });
  }
}
