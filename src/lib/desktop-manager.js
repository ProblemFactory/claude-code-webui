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

    // Move windows from deleted desktop to adjacent one
    const targetIdx = idx > 0 ? idx - 1 : 1;
    const targetId = this._desktops[targetIdx].id;
    for (const [, win] of this.app.wm.windows) {
      if (win._desktopId === desktopId) win._desktopId = targetId;
    }

    // If we're on the deleted desktop, switch first
    if (this._activeId === desktopId) {
      this._activeId = targetId;
      // Show windows that now belong to us
      for (const [, win] of this.app.wm.windows) {
        if (win._desktopId === targetId && win._hiddenByDesktop) {
          win.element.style.display = '';
          win.isMinimized = false;
          win._hiddenByDesktop = false;
        }
      }
    }

    this._desktops.splice(idx, 1);
    this._savedStates.delete(desktopId);
    this.app.ws.send({ type: 'desktop-delete', desktopId });
    this._renderSwitcher();
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
          win._hiddenByDesktop = true;
          win.element.style.display = 'none';
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

      // 5. Show/restore windows for target desktop
      let hasWindows = false;
      for (const [, win] of this.app.wm.windows) {
        if (win._desktopId === desktopId && win._hiddenByDesktop) {
          win._hiddenByDesktop = false;
          win.element.style.display = '';
          if (win.gridBounds) this.app.wm._applyGridBounds(win);
          if (win.onResize) setTimeout(() => win.onResize(), 100);
          hasWindows = true;
        }
      }

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
      win._hiddenByDesktop = true;
      win.element.style.display = 'none';
    }

    this._renderSwitcher();
    this.app.updateTaskbar();
    this.app.layoutManager.scheduleAutoSave();
    this.app._checkWelcome();
  }

  // ── Remote sync ──

  _onRemoteDesktopUpdated(msg) {
    if (msg.desktops) {
      this._desktops = msg.desktops;
      // If our active desktop was deleted, switch to first
      if (!this._desktops.find(d => d.id === this._activeId)) {
        if (this._desktops.length > 0) {
          this.switchTo(this._desktops[0].id);
        }
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
      const wins = [];
      for (const [, win] of this.app.wm.windows) {
        if (win._desktopId === desk.id && win.gridBounds && !win._hiddenByDesktop && !win.isMinimized) wins.push(win);
      }
      // For non-active desktops, use cached state
      if (desk.id !== this._activeId) {
        const cached = this._savedStates.get(desk.id);
        if (cached?.windows) {
          for (const ws of cached.windows) {
            if (ws.gridBounds && !ws.isMinimized) {
              wins.push({ gridBounds: ws.gridBounds }); // pseudo-win for rendering
            }
          }
        }
      }
      for (const win of wins) {
        const b = win.gridBounds;
        if (!b) continue;
        const rect = document.createElement('div');
        rect.className = 'desktop-preview-win';
        rect.style.left = (b.left * 100) + '%';
        rect.style.top = (b.top * 100) + '%';
        rect.style.width = (b.width * 100) + '%';
        rect.style.height = (b.height * 100) + '%';
        preview.appendChild(rect);
      }

      // Label
      const label = document.createElement('div');
      label.className = 'desktop-preview-label';
      label.textContent = desk.name;
      preview.appendChild(label);

      // Click to switch
      preview.addEventListener('click', () => this.switchTo(desk.id));

      // Right-click context menu
      preview.addEventListener('contextmenu', (e) => {
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

      // Drop target: drag taskbar items or windows here
      preview.addEventListener('dragover', (e) => { e.preventDefault(); preview.classList.add('desktop-preview-drop'); });
      preview.addEventListener('dragleave', () => preview.classList.remove('desktop-preview-drop'));
      preview.addEventListener('drop', (e) => {
        e.preventDefault();
        preview.classList.remove('desktop-preview-drop');
        const winId = e.dataTransfer.getData('text/window-id');
        if (winId) this.moveWindowToDesktop(winId, desk.id);
      });

      container.appendChild(preview);
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

  // ── Helpers ──

  _generateId() {
    return 'desk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
  }
}
