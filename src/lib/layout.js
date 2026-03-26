class LayoutManager {
  constructor(app) {
    this.app = app;
    this._autoSaveTimer = null;
    this._savedLayouts = {};
    this._currentName = null;
  }

  // Capture current workspace state
  captureState() {
    const windows = [];
    for (const [id, win] of this.app.wm.windows) {
      const el = win.element;
      const termSession = this.app.sessions.get(id);
      const winState = {
        title: win.title, type: win.type,
        left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height,
        isMinimized: win.isMinimized, isMaximized: win.isMaximized,
        gridBounds: win.gridBounds || undefined,
      };
      // For terminals, save both webui session id and claude session id
      if (win.type === 'terminal' && termSession) {
        winState.serverSessionId = termSession.sessionId;
        const allSess = this.app.sidebar?._allSessions || [];
        const match = allSess.find(s => s.webuiId === termSession.sessionId);
        if (match) winState.claudeSessionId = match.sessionId;
        // Save per-terminal overrides
        if (termSession.overrides) winState.terminalOverrides = termSession.overrides;
        // Save editor split-pane state (Ctrl+G)
        if (win._editorState) winState.editorState = win._editorState;
      }
      // For file explorers, save current path
      if (win.type === 'files' && win._explorerPath) {
        winState.explorerPath = win._explorerPath;
      }
      // For file viewers and editors, save file path and name
      if ((win.type === 'viewer' || win.type === 'hex-viewer' || win.type === 'editor') && win._filePath) {
        winState.filePath = win._filePath;
        winState.fileName = win._fileName;
      }
      // For browser windows, save URL
      if (win.type === 'browser' && win._browserUrl) {
        winState.browserUrl = win._browserUrl;
      }
      windows.push(winState);
    }
    const grid = this.app.wm.grid;
    const theme = this.app.themeManager.current;
    const sidebarOpen = this.app.sidebar.isOpen;
    return { windows, grid, theme, sidebarOpen };
  }

  // Restore workspace from state
  async restoreState(state) {
    if (!state || !state.windows) return;

    // Restore theme
    if (state.theme) {
      this.app.themeManager.apply(state.theme);
    }

    // Restore grid
    if (state.grid) {
      this.app.wm.setGrid(state.grid.rows, state.grid.cols);
    }

    // Restore sidebar
    if (state.sidebarOpen !== undefined) {
      this.app.sidebar.toggle(state.sidebarOpen);
    }

    // Wait for active sessions list from server
    let activeSessions = [];
    try {
      const res = await fetch('/api/active');
      const data = await res.json();
      activeSessions = data.sessions || [];
    } catch {}

    // Restore windows — use gridBounds if available, otherwise absolute position
    const applyPosition = (winInfo, winState) => {
      if (!winInfo) return;
      if (winState.gridBounds) {
        winInfo.gridBounds = winState.gridBounds;
        this.app.wm._applyGridBounds(winInfo);
      } else {
        const el = winInfo.element;
        el.style.left = winState.left; el.style.top = winState.top;
        el.style.width = winState.width; el.style.height = winState.height;
      }
      if (winState.isMinimized) this.app.wm.minimize(winInfo.id);
      setTimeout(() => { if (winInfo.onResize) winInfo.onResize(); }, 200);
      // Force terminal redraw after attach completes (triggers SIGWINCH via size toggle)
      setTimeout(() => {
        const term = this.app.sessions.get(winInfo.id);
        if (term?.forceRedraw) term.forceRedraw();
      }, 2000);
    };

    for (const ws of state.windows) {
      if (ws.type === 'terminal') {
        let alive = null;
        if (ws.claudeSessionId) {
          alive = activeSessions.find(s => s.claudeSessionId === ws.claudeSessionId);
        }
        if (!alive && ws.serverSessionId) {
          alive = activeSessions.find(s => s.id === ws.serverSessionId);
        }
        if (alive) {
          const winInfo = this.app.attachSession(alive.id, alive.name, alive.cwd);
          applyPosition(winInfo, ws);
          // Restore split-pane editor if it was active (Ctrl+G)
          if (ws.editorState && winInfo) {
            setTimeout(() => {
              this.app.wm.focusWindow(winInfo.id);
              this.app._openExternalEditor(ws.editorState.filePath, ws.editorState.signalPath);
            }, 500);
          }
        }
      } else if (ws.type === 'files') {
        const winInfo = this.app.openFileExplorer(ws.explorerPath);
        applyPosition(winInfo, ws);
      } else if (ws.type === 'editor' && ws.filePath) {
        this.app.openEditor(ws.filePath, ws.fileName || ws.filePath.split('/').pop());
        // openEditor creates the window synchronously; find it by checking the last created window
        const lastWin = [...this.app.wm.windows.values()].pop();
        if (lastWin && lastWin.type === 'editor') applyPosition(lastWin, ws);
      } else if ((ws.type === 'viewer' || ws.type === 'hex-viewer') && ws.filePath) {
        // openFile is async (FileViewer.open), so we need to wait for the window to appear
        const beforeIds = new Set(this.app.wm.windows.keys());
        const opts = ws.type === 'hex-viewer' ? { hex: true } : {};
        this.app.openFile(ws.filePath, ws.fileName || ws.filePath.split('/').pop(), opts);
        // Poll briefly for the new window to appear (FileViewer.open is async)
        const applyPos = ws;
        const checkWin = () => {
          for (const [id, win] of this.app.wm.windows) {
            if (!beforeIds.has(id) && (win.type === 'viewer' || win.type === 'hex-viewer')) {
              applyPosition(win, applyPos);
              return;
            }
          }
          setTimeout(checkWin, 100);
        };
        setTimeout(checkWin, 100);
      } else if (ws.type === 'browser' && ws.browserUrl) {
        const winInfo = this.app.openBrowser(ws.browserUrl);
        applyPosition(winInfo, ws);
      }
    }
  }

  // Auto-save (debounced, triggered on every window change)
  // Won't fire until initial restore is complete
  scheduleAutoSave() {
    if (this._restoring) return; // Don't autosave while restoring
    if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
    this._autoSaveTimer = setTimeout(() => this._doAutoSave(), 2000);
  }

  async _doAutoSave() {
    const state = this.captureState();
    try {
      await fetch('/api/layouts-autosave', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
    } catch {}
  }

  // Load auto-saved state on startup
  async loadAutoSave() {
    this._restoring = true;
    try {
      const res = await fetch('/api/layouts');
      const data = await res.json();
      this._savedLayouts = data.saved || {};
      this._currentName = data.current || null;

      const toRestore = data.autoSave;

      if (toRestore && toRestore.windows && toRestore.windows.length > 0) {
        await this.restoreState(toRestore);
      }
    } catch {}
    // Allow autosave after restore is complete (with extra delay for windows to attach)
    setTimeout(() => { this._restoring = false; }, 5000);
  }

  // Save a named layout
  async saveNamed(name) {
    const state = this.captureState();
    try {
      await fetch(`/api/layouts/${encodeURIComponent(name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      await fetch('/api/layouts-active', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      this._savedLayouts[name] = state;
      this._currentName = name;
    } catch {}
  }

  // Load a named layout
  async loadNamed(name) {
    const layout = this._savedLayouts[name];
    if (!layout) return;
    // Detach windows without killing sessions — just remove UI elements
    for (const [id, win] of [...this.app.wm.windows]) {
      const term = this.app.sessions.get(id);
      if (term) { term.dispose(); this.app.sessions.delete(id); }
      win.element.remove();
      this.app.wm.windows.delete(id);
    }
    this.app.wm._notify();
    await fetch('/api/layouts-active', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    this._currentName = name;
    await this.restoreState(layout);
  }

  // Delete a named layout
  async deleteNamed(name) {
    try {
      await fetch(`/api/layouts/${encodeURIComponent(name)}`, { method: 'DELETE' });
      delete this._savedLayouts[name];
      if (this._currentName === name) this._currentName = null;
    } catch {}
  }

  // Refresh saved list from server
  async refresh() {
    try {
      const res = await fetch('/api/layouts');
      const data = await res.json();
      this._savedLayouts = data.saved || {};
      this._currentName = data.current || null;
    } catch {}
  }
}

export { LayoutManager };
