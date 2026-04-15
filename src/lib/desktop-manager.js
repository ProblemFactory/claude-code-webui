import { showContextMenu } from './utils.js';

/**
 * DesktopManager — virtual desktop system.
 * Each desktop has its own set of windows, grid mode, and layout state.
 * Multiple clients can view different desktops simultaneously.
 */
export class DesktopManager {
  constructor(app) {
    this.app = app;
    this._desktops = [];           // [{ id, name }]
    this._activeId = null;
    this._savedStates = new Map(); // desktopId → capturedState (cached layout for non-active desktops)
    this._restoring = false;

    // Listen for desktop metadata updates from other clients
    app.ws.onGlobal((msg) => {
      if (msg.type === 'desktop-updated') this._onRemoteDesktopUpdated(msg);
    });

    // Taskbar resize handle (drag top edge to resize)
    this._setupTaskbarResize();
  }

  get activeDesktopId() { return this._activeId; }
  get desktops() { return this._desktops; }

  // ── Lifecycle ──

  /** Load desktops from server layout data. Called from LayoutManager.loadAutoSave(). */
  async loadFromServer(layoutData) {
    const meta = layoutData.desktopMeta || [];
    const desktopsData = layoutData.desktops || {};

    if (meta.length === 0) {
      // Migration: no desktops yet — create Desktop 1 from legacy autoSave
      const firstId = this._generateId();
      this._desktops = [{ id: firstId, name: 'Desktop 1' }];
      this._activeId = firstId;

      const legacyState = layoutData.autoSave;
      if (legacyState?.windows?.length) {
        this._savedStates.set(firstId, legacyState);
        await this.app.layoutManager.restoreState(legacyState);
        for (const [, win] of this.app.wm.windows) win._desktopId = firstId;
      }

      // Persist the new desktop structure to server
      this.app.ws.send({ type: 'desktop-create', name: 'Desktop 1', id: firstId });
    } else {
      this._desktops = meta;
      this._activeId = meta[0].id;

      // Cache all desktop states
      for (const [id, dState] of Object.entries(desktopsData)) {
        if (dState.autoSave) this._savedStates.set(id, dState.autoSave);
      }

      // Restore the active (first) desktop
      const firstState = this._savedStates.get(this._activeId);
      if (firstState?.windows?.length) {
        await this.app.layoutManager.restoreState(firstState);
        for (const [, win] of this.app.wm.windows) {
          if (!win._desktopId) win._desktopId = this._activeId;
        }
      }
    }

    this._renderSwitcher();
  }

  // ── Desktop CRUD ──

  createDesktop(name) {
    const id = this._generateId();
    const deskName = name || `Desktop ${this._desktops.length + 1}`;
    this._desktops.push({ id, name: deskName });
    this.app.ws.send({ type: 'desktop-create', name: deskName, id });
    this._renderSwitcher();
    return id;
  }

  deleteDesktop(desktopId) {
    if (this._desktops.length <= 1) return; // can't delete last desktop
    const idx = this._desktops.findIndex(d => d.id === desktopId);
    if (idx < 0) return;

    // If deleting the active desktop, switch to adjacent first
    const wasActive = this._activeId === desktopId;
    if (wasActive) {
      const targetIdx = idx > 0 ? idx - 1 : 1;
      this._activeId = this._desktops[targetIdx].id;
      // Show the new active desktop's windows
      for (const [, win] of this.app.wm.windows) {
        if (win._desktopId === this._activeId && win._hiddenByDesktop) this._showWin(win);
      }
    }
    const targetId = this._activeId;

    // Reassign deleted desktop's windows to the active desktop and show them
    for (const [, win] of this.app.wm.windows) {
      if (win._desktopId === desktopId) {
        win._desktopId = targetId;
        if (win._hiddenByDesktop) this._showWin(win);
      }
    }

    // For windows not yet in DOM (never switched to after refresh),
    // restore them via the standard layout restore pipeline
    const cached = this._savedStates.get(desktopId);
    if (cached?.windows) {
      const unloaded = cached.windows.filter(ws => !this.app.wm.windows.has(ws.winId || ws.id));
      if (unloaded.length) {
        // Tag restored windows with active desktop
        const origCreate = this.app.wm.createWindow;
        this.app.wm.createWindow = (opts) => {
          const win = origCreate.call(this.app.wm, opts);
          win._desktopId = targetId;
          return win;
        };
        this.app.layoutManager.restoreState({ windows: unloaded });
        this.app.wm.createWindow = origCreate;
      }
    }

    this._desktops.splice(idx, 1);
    this._savedStates.delete(desktopId);
    this.app.ws.send({ type: 'desktop-delete', desktopId });
    // Reflow positions for all now-visible windows
    this.app.wm._reflowWindows();
    this._renderSwitcher();
    this.app.updateTaskbar();
    this.app.layoutManager.scheduleAutoSave();
  }

  renameDesktop(desktopId, name) {
    const desk = this._desktops.find(d => d.id === desktopId);
    if (desk) {
      desk.name = name;
      this.app.ws.send({ type: 'desktop-rename', desktopId, name });
      this._renderSwitcher();
    }
  }

  // ── Desktop Switching ──

  async switchTo(desktopId) {
    if (desktopId === this._activeId || this._restoring) return;
    this._restoring = true;

    try {
      // 1. Capture current desktop state and cache it
      const currentState = this.app.layoutManager.captureState();
      this._savedStates.set(this._activeId, currentState);

      // 2. Hide all windows for current desktop
      for (const [, win] of this.app.wm.windows) {
        if (win._desktopId === this._activeId && !win._hiddenByDesktop) {
          this._hideWin(win);
        }
      }

      // 3. Switch active desktop
      const prevId = this._activeId;
      this._activeId = desktopId;

      // 4. Apply target desktop's grid
      const targetState = this._savedStates.get(desktopId);
      if (targetState?.grid) {
        this.app.wm.setGrid(targetState.grid.rows, targetState.grid.cols);
      } else {
        this.app.wm.setGrid(null);
      }

      // 5. Show windows for target desktop (visibility:hidden preserves all state)
      let hasWindows = false;
      for (const [, win] of this.app.wm.windows) {
        if (win._desktopId === desktopId && win._hiddenByDesktop) {
          this._showWin(win);
          hasWindows = true;
        }
      }
      // Single reflow: recalculate all visible windows' pixel positions from gridBounds
      this.app.wm._reflowWindows();

      // 6. Create windows that exist in saved state but not yet in DOM
      // (from other clients or disk restore)
      if (targetState?.windows) {
        for (const ws of targetState.windows) {
          const winId = ws.winId || ws.id;
          if (!this.app.wm.windows.has(winId) && ws.openSpec) {
            this.app.replayOpenSpec(ws.openSpec, winId);
            hasWindows = true;
            // Tag and position after creation
            setTimeout(() => {
              const newWin = this.app.wm.windows.get(winId);
              if (newWin) {
                newWin._desktopId = desktopId;
                if (ws.gridBounds) {
                  newWin.gridBounds = ws.gridBounds;
                  this.app.wm._applyGridBounds(newWin);
                }
              }
            }, 500);
          }
        }
      }

      // 7. Update UI
      this._renderSwitcher();
      this.app.updateTaskbar();
      this.app._checkWelcome();

      // 8. Broadcast (save previous desktop's state, then save current desktop)
      // Use non-restoring doAutoSave for the previous desktop
      this._broadcastDesktopState(prevId, currentState);
      // Schedule save for new active desktop
      setTimeout(() => this.app.layoutManager.scheduleAutoSave(), 300);

    } finally {
      setTimeout(() => { this._restoring = false; }, 1000);
    }
  }

  /** Move a window to another desktop */
  moveWindowToDesktop(winId, desktopId) {
    const win = this.app.wm.windows.get(winId);
    if (!win || win._desktopId === desktopId) return;

    win._desktopId = desktopId;

    // If moving to a non-active desktop, hide
    if (desktopId !== this._activeId) {
      this._hideWin(win);
    }

    // Update cached state for the target desktop so preview shows the new window
    this._updateCachedDesktop(desktopId);

    this._renderSwitcher();
    this.app.updateTaskbar();
    this.app.layoutManager.scheduleAutoSave();
    this.app._checkWelcome();
  }

  /** Rebuild cached state for a non-active desktop from its live windows */
  _updateCachedDesktop(desktopId) {
    if (desktopId === this._activeId) return;
    const cached = this._savedStates.get(desktopId) || { windows: [] };
    const wins = [];
    for (const [id, win] of this.app.wm.windows) {
      if (win._desktopId !== desktopId) continue;
      wins.push({
        winId: id, gridBounds: win.gridBounds,
        isMinimized: false, openSpec: win._openSpec,
      });
    }
    cached.windows = wins;
    this._savedStates.set(desktopId, cached);
  }

  // ── Remote sync ──

  _onRemoteDesktopUpdated(msg) {
    if (msg.desktops) {
      const oldIds = new Set(this._desktops.map(d => d.id));
      const newIds = new Set(msg.desktops.map(d => d.id));
      this._desktops = msg.desktops;

      // Reassign windows from deleted desktops to the first remaining desktop
      const fallbackId = this._desktops[0]?.id;
      if (fallbackId) {
        for (const [, win] of this.app.wm.windows) {
          if (win._desktopId && !newIds.has(win._desktopId)) {
            win._desktopId = fallbackId;
            if (fallbackId === this._activeId && win._hiddenByDesktop) {
              this._showWin(win);
            }
          }
        }
      }

      // If our active desktop was deleted, switch to first
      if (!newIds.has(this._activeId) && this._desktops.length > 0) {
        this.switchTo(this._desktops[0].id);
      }
      this._renderSwitcher();
    }
  }

  /** Update desktop metadata from layout-sync message */
  updateFromMeta(desktopMeta) {
    if (!desktopMeta?.length) return;
    this._desktops = desktopMeta;
    this._renderSwitcher();
  }

  /** Broadcast a specific desktop's state (used during switch) */
  _broadcastDesktopState(desktopId, state) {
    this.app.ws.send({ type: 'layout-sync', state, desktopId });
  }

  // ── UI: Ubuntu-style desktop previews in taskbar ──

  _renderSwitcher() {
    const container = document.getElementById('desktop-previews');
    if (!container) return;
    container.innerHTML = '';

    for (const desk of this._desktops) {
      const preview = document.createElement('div');
      preview.className = 'desktop-preview' + (desk.id === this._activeId ? ' active' : '');
      preview.title = desk.name;

      // Collect windows for this desktop and draw miniature rectangles
      // All windows exist in DOM (visibility:hidden for non-active), so check live state
      const winEntries = []; // { id, gridBounds, waiting }
      let deskHasWaiting = false;
      if (desk.id === this._activeId) {
        for (const [id, win] of this.app.wm.windows) {
          if (win._desktopId === desk.id && win.gridBounds && !win._hiddenByDesktop && !win.isMinimized) {
            const waiting = win.element.classList.contains('window-waiting');
            winEntries.push({ id, gridBounds: win.gridBounds, waiting });
            if (waiting) deskHasWaiting = true;
          }
        }
      } else {
        // Non-active: try live DOM windows first (they exist after first switch)
        for (const [id, win] of this.app.wm.windows) {
          if (win._desktopId === desk.id && win.gridBounds && !win.isMinimized) {
            const waiting = win.element.classList.contains('window-waiting');
            winEntries.push({ id, gridBounds: win.gridBounds, waiting });
            if (waiting) deskHasWaiting = true;
          }
        }
        // Fallback: if no live windows found, use cached state (e.g. after page refresh)
        if (!winEntries.length) {
          const cached = this._savedStates.get(desk.id);
          if (cached?.windows) {
            for (const ws of cached.windows) {
              if (ws.gridBounds && !ws.isMinimized) {
                winEntries.push({ id: ws.winId, gridBounds: ws.gridBounds, waiting: false });
              }
            }
          }
        }
      }
      if (deskHasWaiting) preview.classList.add('desktop-preview-waiting');
      for (const entry of winEntries) {
        const b = entry.gridBounds;
        if (!b) continue;
        const rect = document.createElement('div');
        rect.className = 'desktop-preview-win' + (entry.waiting ? ' desktop-preview-win-waiting' : '');
        if (entry.id) rect.dataset.winId = entry.id;
        rect.style.left = (b.left * 100) + '%';
        rect.style.top = (b.top * 100) + '%';
        rect.style.width = (b.width * 100) + '%';
        rect.style.height = (b.height * 100) + '%';
        preview.appendChild(rect);
      }

      // Wrapper: preview + label below
      const wrapper = document.createElement('div');
      wrapper.className = 'desktop-preview-wrapper';
      const label = document.createElement('div');
      label.className = 'desktop-preview-label';
      label.textContent = desk.name;
      wrapper.append(preview, label);

      // Click to switch
      wrapper.addEventListener('click', () => this.switchTo(desk.id));

      // Right-click context menu
      wrapper.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const items = [
          { label: 'Rename', action: () => this._startRename(desk) },
        ];
        if (this._desktops.length > 1) {
          items.push({ label: 'Delete', action: () => this.deleteDesktop(desk.id), style: 'color:var(--red, #e55)' });
        }
        const menu = showContextMenu(e.clientX, e.clientY, items);
        menu.style.top = '';
        menu.style.bottom = (window.innerHeight - e.clientY + 4) + 'px';
      });

      // Drop target: drag taskbar items here (HTML5 drag)
      preview.addEventListener('dragover', (e) => { e.preventDefault(); preview.classList.add('desktop-preview-drop'); });
      preview.addEventListener('dragleave', () => preview.classList.remove('desktop-preview-drop'));
      preview.addEventListener('drop', (e) => {
        e.preventDefault();
        preview.classList.remove('desktop-preview-drop');
        const winId = e.dataTransfer.getData('text/window-id');
        if (winId) this.moveWindowToDesktop(winId, desk.id);
      });

      container.appendChild(wrapper);
    }

    // "+" add button
    const addBtn = document.createElement('button');
    addBtn.className = 'desktop-preview-add';
    addBtn.textContent = '+';
    addBtn.title = 'Add desktop';
    addBtn.addEventListener('click', () => {
      const id = this.createDesktop();
      this.switchTo(id);
    });
    container.appendChild(addBtn);
  }

  _startRename(desk) {
    const name = prompt('Desktop name:', desk.name);
    if (name && name.trim()) this.renameDesktop(desk.id, name.trim());
  }

  /** Build "Move to Desktop" submenu items for window context menu */
  getDesktopMenuItems(winId) {
    const win = this.app.wm.windows.get(winId);
    if (!win || this._desktops.length < 2) return [];
    return this._desktops
      .filter(d => d.id !== win._desktopId)
      .map(d => ({
        label: d.name,
        action: () => this.moveWindowToDesktop(winId, d.id),
      }));
  }

  // ── Taskbar resize ──

  _setupTaskbarResize() {
    const handle = document.getElementById('taskbar-resize-handle');
    const taskbar = document.getElementById('taskbar');
    if (!handle || !taskbar) return;

    const MIN_H = 36, MAX_H = 120;
    // Restore saved height
    const saved = parseInt(localStorage.getItem('taskbarHeight'));
    if (saved && saved >= MIN_H && saved <= MAX_H) {
      taskbar.style.height = saved + 'px';
      this._adaptTaskbarSize(saved);
    }

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = taskbar.offsetHeight;
      handle.classList.add('active');
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      // Suppress ResizeObserver-triggered reflow during drag
      this.app.wm._suppressReflow = true;

      const onMove = (e) => {
        const h = Math.max(MIN_H, Math.min(MAX_H, startH + (startY - e.clientY)));
        taskbar.style.height = h + 'px';
        this._adaptTaskbarSize(h);
      };
      const onUp = () => {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        localStorage.setItem('taskbarHeight', taskbar.offsetHeight);
        // Re-enable reflow and do one final reflow
        this.app.wm._suppressReflow = false;
        this.app.wm._reflowWindows?.();
        // Broadcast height to other clients via layout sync
        this.app.layoutManager.scheduleAutoSave();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /** Adapt desktop preview and taskbar element sizes to current height */
  _adaptTaskbarSize(h) {
    const root = document.documentElement;
    // Preview: fill available height minus label + padding (3:2 aspect)
    const previewH = Math.max(16, h - 18);
    root.style.setProperty('--desktop-preview-h', previewH + 'px');
    root.style.setProperty('--desktop-preview-w', Math.round(previewH * 1.5) + 'px');
    // All elements proportional to taskbar height — no upper caps
    const iconSize = Math.max(14, Math.round(h * 0.4));
    root.style.setProperty('--taskbar-icon-size', iconSize + 'px');
    root.style.setProperty('--taskbar-icon-scale', (iconSize / 14).toFixed(2));
    root.style.setProperty('--taskbar-title-size', Math.max(8, Math.round(h * 0.18)) + 'px');
    root.style.setProperty('--taskbar-sub-size', Math.max(7, Math.round(h * 0.14)) + 'px');
    root.style.setProperty('--usage-pie-size', Math.max(10, Math.round(h * 0.25)) + 'px');
    root.style.setProperty('--taskbar-item-pad', Math.max(2, Math.round(h * 0.06)) + 'px');
  }

  // ── Helpers ──

  /** Hide a window without collapsing layout (preserves scroll, DOM state) */
  _hideWin(win) {
    win._hiddenByDesktop = true;
    win.element.style.visibility = 'hidden';
    win.element.style.pointerEvents = 'none';
  }

  /** Show a previously hidden window */
  _showWin(win) {
    win._hiddenByDesktop = false;
    win.element.style.visibility = '';
    win.element.style.pointerEvents = '';
  }

  _generateId() {
    return 'desk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
  }
}
