class LayoutManager {
  constructor(app) {
    this.app = app;
    this._autoSaveTimer = null;
    this._savedPresets = {};
    this._currentName = null;

    // Listen for state sync from other clients
    app.ws.onGlobal((msg) => {
      if (msg.type === 'layout-sync' && !this._restoring) {
        this._applyRemoteState(msg.state);
      }
    });
  }

  // Apply remote state: diff against local windows, update only what changed
  _applyRemoteState(state) {
    if (!state) return;
    this._restoring = true;
    try {
      // Grid
      if (state.grid) {
        const cur = this.app.wm.grid;
        if (!cur || cur.rows !== state.grid.rows || cur.cols !== state.grid.cols) {
          this.app.wm.setGrid(state.grid.rows, state.grid.cols);
        }
      }
      // Sidebar
      if (state.sidebarOpen !== undefined && state.sidebarOpen !== this.app.sidebar.isOpen) {
        this.app.sidebar.toggle(state.sidebarOpen);
      }
      // Windows: update existing, create missing, close removed
      if (state.windows) {
        const remoteIds = new Set();
        for (const rw of state.windows) {
          const winId = rw.winId || rw.id;
          remoteIds.add(winId);
          const win = this.app.wm.windows.get(winId);

          if (!win) {
            // Window doesn't exist locally — create it
            this._createRemoteWindow(rw);
            continue;
          }

          // Update gridBounds
          if (rw.gridBounds) {
            const changed = !win.gridBounds
              || Math.abs(win.gridBounds.left - rw.gridBounds.left) > 0.0001
              || Math.abs(win.gridBounds.top - rw.gridBounds.top) > 0.0001
              || Math.abs(win.gridBounds.width - rw.gridBounds.width) > 0.0001
              || Math.abs(win.gridBounds.height - rw.gridBounds.height) > 0.0001;
            if (changed) {
              win.gridBounds = rw.gridBounds;
              this.app.wm._applyGridBounds(win);
              setTimeout(() => { if (win.onResize) win.onResize(); this.app.wm._applyGridBounds(win); }, 150);
            }
          }
          // z-index: only apply if remote z is higher (local focus wins)
          const z = rw.z || rw.zIndex || 0;
          const localZ = parseInt(win.element.style.zIndex) || 0;
          if (z > localZ) {
            win.element.style.zIndex = z;
            if (z >= this.app.wm.zIndex) this.app.wm.zIndex = z + 1;
          }
          // maximize
          const isMax = rw.isMaximized ?? false;
          if (isMax && !win.isMaximized) this.app.wm.toggleMaximize(win.id);
          if (!isMax && win.isMaximized) this.app.wm.toggleMaximize(win.id);
          // minimize/restore
          const isMin = rw.min ?? rw.isMinimized ?? false;
          if (isMin && !win.isMinimized) this.app.wm.minimize(win.id);
          if (!isMin && win.isMinimized) this.app.wm.restore(win.id);
          // snap state
          win._isSnapped = rw.snap ?? rw.isSnapped ?? false;
          const snapB = rw.snapBounds || rw.preSnapBounds;
          if (snapB) win._preSnapBounds = snapB;
        }
        // Close windows that exist locally but not remotely
        for (const [id] of this.app.wm.windows) {
          if (!remoteIds.has(id)) {
            this.app.wm.closeWindow(id);
          }
        }
      }
    } catch {}
    setTimeout(() => { this._restoring = false; }, 1000);
  }

  // Create a window from remote layout state
  _createRemoteWindow(rw) {
    const winId = rw.winId || rw.id;
    try {
      let winInfo;
      if ((rw.type === 'terminal' || rw.type === 'chat') && rw.serverSessionId) {
        // Session window — attach to existing server session
        const mode = rw.type === 'chat' ? 'chat' : undefined;
        winInfo = this.app.attachSession(rw.serverSessionId, rw.title, rw.explorerPath || '', { mode, syncId: winId });
      } else if (rw.type === 'files' && rw.explorerPath) {
        winInfo = this.app.openFileExplorer(rw.explorerPath, { syncId: winId });
      } else if ((rw.type === 'viewer' || rw.type === 'editor') && rw.filePath) {
        winInfo = this.app.openFile(rw.filePath, rw.fileName, { syncId: winId });
      }
      if (winInfo) {
        // Remap ID and apply position
        if (winInfo.id !== winId) {
          const wm = this.app.wm;
          wm.windows.delete(winInfo.id);
          const session = this.app.sessions.get(winInfo.id);
          if (session) { this.app.sessions.delete(winInfo.id); this.app.sessions.set(winId, session); }
          winInfo.id = winId;
          wm.windows.set(winId, winInfo);
        }
        if (rw.gridBounds) { winInfo.gridBounds = rw.gridBounds; this.app.wm._applyGridBounds(winInfo); }
        if (rw.isSnapped) { winInfo._isSnapped = true; winInfo._preSnapBounds = rw.preSnapBounds; }
      }
    } catch {}
  }

  // Capture current workspace state (complete)
  captureState() {
    const windows = [];
    for (const [id, win] of this.app.wm.windows) {
      const el = win.element;
      const termSession = this.app.sessions.get(id);
      const winState = {
        winId: id, // unique window ID for cross-client sync
        title: win.title, type: win.type,
        left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height,
        isMinimized: win.isMinimized, isMaximized: win.isMaximized,
        gridBounds: win.gridBounds || undefined,
        zIndex: parseInt(el.style.zIndex) || 0,
      };
      if (win._isSnapped) { winState.isSnapped = true; winState.preSnapBounds = win._preSnapBounds; }
      // For terminals, save both webui session id and claude session id + overrides
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
      // For chat windows, save session id and claude session id
      if (win.type === 'chat' && termSession) {
        winState.serverSessionId = termSession.sessionId;
        const allSess = this.app.sidebar?._allSessions || [];
        const match = allSess.find(s => s.webuiId === termSession.sessionId);
        if (match) winState.claudeSessionId = match.sessionId;
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
    const globalFontSize = this.app._fontSize;
    const globalFontFamily = this.app._fontFamily;
    const sidebarOpen = this.app.sidebar.isOpen;
    return { windows, grid, theme, globalFontSize, globalFontFamily, sidebarOpen };
  }

  // Restore workspace from state (used for autosave restore on startup)
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
      // Remap window ID to saved ID for cross-client sync
      if (winState.winId && winInfo.id !== winState.winId) {
        const wm = this.app.wm;
        wm.windows.delete(winInfo.id);
        const session = this.app.sessions.get(winInfo.id);
        if (session) { this.app.sessions.delete(winInfo.id); this.app.sessions.set(winState.winId, session); }
        winInfo.id = winState.winId;
        wm.windows.set(winState.winId, winInfo);
      }
      if (winState.gridBounds) {
        winInfo.gridBounds = winState.gridBounds;
        this.app.wm._applyGridBounds(winInfo);
      } else {
        const el = winInfo.element;
        el.style.left = winState.left; el.style.top = winState.top;
        el.style.width = winState.width; el.style.height = winState.height;
      }
      if (winState.zIndex) { winInfo.element.style.zIndex = winState.zIndex; if (winState.zIndex >= this.app.wm.zIndex) this.app.wm.zIndex = winState.zIndex + 1; }
      if (winState.isSnapped) { winInfo._isSnapped = true; winInfo._preSnapBounds = winState.preSnapBounds; }
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
          const customName = this.app.sidebar?.getCustomName(ws.claudeSessionId || alive.claudeSessionId);
          const winInfo = this.app.attachSession(alive.id, customName || alive.name, alive.cwd);
          applyPosition(winInfo, ws);
          // Restore split-pane editor if it was active (Ctrl+G)
          if (ws.editorState && winInfo) {
            setTimeout(() => {
              this.app.wm.focusWindow(winInfo.id);
              this.app._openExternalEditor(ws.editorState.filePath, ws.editorState.signalPath);
            }, 500);
          }
        }
      } else if (ws.type === 'chat') {
        let alive = null;
        if (ws.claudeSessionId) {
          alive = activeSessions.find(s => s.claudeSessionId === ws.claudeSessionId);
        }
        if (!alive && ws.serverSessionId) {
          alive = activeSessions.find(s => s.id === ws.serverSessionId);
        }
        if (alive) {
          const customName = this.app.sidebar?.getCustomName(ws.claudeSessionId || alive.claudeSessionId);
          const winInfo = this.app.attachSession(alive.id, customName || alive.name, alive.cwd, { mode: 'chat' });
          applyPosition(winInfo, ws);
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
    this._autoSaveTimer = setTimeout(() => this._doAutoSave(), 500);
  }

  _isMobile() {
    return window.innerWidth <= 768 || ('ontouchstart' in window && window.innerWidth < 1024);
  }

  async _doAutoSave() {
    if (this._restoring) return;
    const state = this.captureState();
    // Full state to server for disk persistence
    this.app.ws.send({ type: 'layout-sync', state });
  }

  // Load auto-saved state on startup
  async loadAutoSave() {
    this._restoring = true;
    try {
      const res = await fetch('/api/layouts');
      const data = await res.json();
      this._savedPresets = data.saved || {};
      this._currentName = data.current || null;

      // Pick the right autosave for this device type
      const toRestore = this._isMobile() ? (data.autoSaveMobile || data.autoSave) : data.autoSave;

      if (toRestore && toRestore.windows && toRestore.windows.length > 0) {
        await this.restoreState(toRestore);
      }
    } catch {}
    // Allow autosave after restore is complete (with extra delay for windows to attach)
    setTimeout(() => { this._restoring = false; }, 5000);
  }

  // Save a named preset
  async savePreset(name) {
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
      this._savedPresets[name] = state;
      this._currentName = name;
    } catch {}
  }

  // Load a named preset — rearranges workspace without killing sessions
  async loadPreset(name) {
    const preset = this._savedPresets[name];
    if (!preset) return;

    // Get current active sessions (dtach-managed)
    let activeSessions = [];
    try {
      const res = await fetch('/api/active');
      const data = await res.json();
      activeSessions = data.sessions || [];
    } catch {}

    // Get all sessions (including stopped for resume)
    let allSessions = [];
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      allSessions = data.sessions || [];
    } catch {}

    // Track which current window IDs are matched to a preset window
    const matchedWinIds = new Set();

    // Helper: apply position to a window from preset state
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
      if (winState.zIndex) {
        winInfo.element.style.zIndex = winState.zIndex;
        if (winState.zIndex >= this.app.wm.zIndex) this.app.wm.zIndex = winState.zIndex + 1;
      }
      // Restore from minimized if preset says it should be visible
      if (!winState.isMinimized && winInfo.isMinimized) {
        this.app.wm.restore(winInfo.id);
      } else if (winState.isMinimized && !winInfo.isMinimized) {
        this.app.wm.minimize(winInfo.id);
      }
      setTimeout(() => { if (winInfo.onResize) winInfo.onResize(); }, 200);
      setTimeout(() => {
        const term = this.app.sessions.get(winInfo.id);
        if (term?.forceRedraw) term.forceRedraw();
      }, 2000);
    };

    // Restore global settings
    if (preset.theme) {
      this.app.themeManager.apply(preset.theme);
      for (const [, term] of this.app.sessions) term.updateTheme(this.app.themeManager.getTerminalTheme());
    }
    if (preset.globalFontSize && preset.globalFontSize !== this.app._fontSize) {
      this.app._fontSize = preset.globalFontSize;
      localStorage.setItem('termFontSize', this.app._fontSize);
      for (const [, term] of this.app.sessions) {
        if (!term.overrides.fontSize) {
          term.terminal.options.fontSize = this.app._fontSize;
          try { term.terminal.clearTextureAtlas(); } catch {}
          term.fit();
        }
      }
    }
    if (preset.globalFontFamily && preset.globalFontFamily !== this.app._fontFamily) {
      this.app._fontFamily = preset.globalFontFamily;
      localStorage.setItem('termFontFamily', this.app._fontFamily);
      for (const [, term] of this.app.sessions) {
        if (!term.overrides.fontFamily) {
          term.terminal.options.fontFamily = this.app._fontFamily;
          try { term.terminal.clearTextureAtlas(); } catch {}
          term.fit();
        }
      }
    }

    // Restore grid
    if (preset.grid) {
      this.app.wm.setGrid(preset.grid.rows, preset.grid.cols);
    } else {
      this.app.wm.setGrid(null);
    }

    // Restore sidebar
    if (preset.sidebarOpen !== undefined) {
      this.app.sidebar.toggle(preset.sidebarOpen);
    }

    // Build a map of currently open terminal windows by claudeSessionId
    const openTermByClaudeId = new Map(); // claudeSessionId -> { winId, win, term }
    const openTermByServerId = new Map(); // serverSessionId -> { winId, win, term }
    for (const [winId, win] of this.app.wm.windows) {
      if (win.type === 'terminal') {
        const term = this.app.sessions.get(winId);
        if (term) {
          const sidebarSess = (this.app.sidebar._allSessions || []).find(s => s.webuiId === term.sessionId);
          if (sidebarSess) {
            openTermByClaudeId.set(sidebarSess.sessionId, { winId, win, term });
          }
          openTermByServerId.set(term.sessionId, { winId, win, term });
        }
      }
    }

    // Build a map of currently open non-terminal windows for matching
    const openNonTermWindows = new Map(); // type:key -> { winId, win }
    for (const [winId, win] of this.app.wm.windows) {
      if (win.type === 'files' && win._explorerPath) {
        openNonTermWindows.set(`files:${win._explorerPath}`, { winId, win });
      } else if (win.type === 'browser' && win._browserUrl) {
        openNonTermWindows.set(`browser:${win._browserUrl}`, { winId, win });
      } else if ((win.type === 'editor' || win.type === 'viewer' || win.type === 'hex-viewer') && win._filePath) {
        openNonTermWindows.set(`${win.type}:${win._filePath}`, { winId, win });
      }
    }

    // Track which claudeSessionIds have already been processed (prevent duplicates)
    const processedClaudeIds = new Set();

    // Process each preset window
    for (const ws of preset.windows) {
      if (ws.type === 'terminal') {
        // Skip if we already processed this session (prevents duplicate resume)
        if (ws.claudeSessionId && processedClaudeIds.has(ws.claudeSessionId)) continue;
        if (ws.claudeSessionId) processedClaudeIds.add(ws.claudeSessionId);

        // Try to find an already-open window matching this terminal
        let existing = null;
        if (ws.claudeSessionId) {
          existing = openTermByClaudeId.get(ws.claudeSessionId);
        }
        if (!existing && ws.serverSessionId) {
          existing = openTermByServerId.get(ws.serverSessionId);
        }

        if (existing) {
          // Already open — just reposition
          matchedWinIds.add(existing.winId);
          applyPosition(existing.win, ws);
          this.app.wm.focusWindow(existing.winId);
        } else {
          // Not open — check if session exists as active (attach) or stopped (resume)
          let activeMatch = null;
          if (ws.claudeSessionId) {
            activeMatch = activeSessions.find(s => s.claudeSessionId === ws.claudeSessionId);
          }
          if (!activeMatch && ws.serverSessionId) {
            activeMatch = activeSessions.find(s => s.id === ws.serverSessionId);
          }

          if (activeMatch) {
            // Active but no window — attach (use custom name if available)
            const customName = this.app.sidebar?.getCustomName(ws.claudeSessionId);
            const winInfo = this.app.attachSession(activeMatch.id, customName || activeMatch.name, activeMatch.cwd);
            if (winInfo) {
              matchedWinIds.add(winInfo.id);
              applyPosition(winInfo, ws);
              // Restore split-pane editor if saved
              if (ws.editorState && winInfo) {
                setTimeout(() => {
                  this.app.wm.focusWindow(winInfo.id);
                  this.app._openExternalEditor(ws.editorState.filePath, ws.editorState.signalPath);
                }, 500);
              }
            }
          } else if (ws.claudeSessionId) {
            // Check stopped sessions for resume
            const stoppedMatch = allSessions.find(s => s.sessionId === ws.claudeSessionId && s.status === 'stopped');
            if (stoppedMatch) {
              const customName = this.app.sidebar?.getCustomName(ws.claudeSessionId);
              this.app.resumeSession(stoppedMatch.sessionId, stoppedMatch.cwd, customName || stoppedMatch.name);
              // resumeSession creates window asynchronously; find it after a delay
              const capturedWs = ws;
              setTimeout(() => {
                // Find the new window for this session
                for (const [winId, win] of this.app.wm.windows) {
                  if (!matchedWinIds.has(winId) && win.type === 'terminal') {
                    const term = this.app.sessions.get(winId);
                    if (term) {
                      matchedWinIds.add(winId);
                      applyPosition(win, capturedWs);
                      break;
                    }
                  }
                }
              }, 1500);
            }
            // If session doesn't exist at all — skip
          }
        }
      } else if (ws.type === 'files') {
        const key = `files:${ws.explorerPath || ''}`;
        const existing = ws.explorerPath ? openNonTermWindows.get(key) : null;
        if (existing) {
          matchedWinIds.add(existing.winId);
          applyPosition(existing.win, ws);
        } else {
          const winInfo = this.app.openFileExplorer(ws.explorerPath);
          if (winInfo) {
            matchedWinIds.add(winInfo.id);
            applyPosition(winInfo, ws);
          }
        }
      } else if (ws.type === 'editor' && ws.filePath) {
        const key = `editor:${ws.filePath}`;
        const existing = openNonTermWindows.get(key);
        if (existing) {
          matchedWinIds.add(existing.winId);
          applyPosition(existing.win, ws);
        } else {
          this.app.openEditor(ws.filePath, ws.fileName || ws.filePath.split('/').pop());
          const lastWin = [...this.app.wm.windows.values()].pop();
          if (lastWin && lastWin.type === 'editor') {
            matchedWinIds.add(lastWin.id);
            applyPosition(lastWin, ws);
          }
        }
      } else if ((ws.type === 'viewer' || ws.type === 'hex-viewer') && ws.filePath) {
        const key = `${ws.type}:${ws.filePath}`;
        const existing = openNonTermWindows.get(key);
        if (existing) {
          matchedWinIds.add(existing.winId);
          applyPosition(existing.win, ws);
        } else {
          const beforeIds = new Set(this.app.wm.windows.keys());
          const opts = ws.type === 'hex-viewer' ? { hex: true } : {};
          this.app.openFile(ws.filePath, ws.fileName || ws.filePath.split('/').pop(), opts);
          const applyPos = ws;
          const checkWin = () => {
            for (const [id, win] of this.app.wm.windows) {
              if (!beforeIds.has(id) && (win.type === 'viewer' || win.type === 'hex-viewer')) {
                matchedWinIds.add(id);
                applyPosition(win, applyPos);
                return;
              }
            }
            setTimeout(checkWin, 100);
          };
          setTimeout(checkWin, 100);
        }
      } else if (ws.type === 'browser' && ws.browserUrl) {
        const key = `browser:${ws.browserUrl}`;
        const existing = openNonTermWindows.get(key);
        if (existing) {
          matchedWinIds.add(existing.winId);
          applyPosition(existing.win, ws);
        } else {
          const winInfo = this.app.openBrowser(ws.browserUrl);
          if (winInfo) {
            matchedWinIds.add(winInfo.id);
            applyPosition(winInfo, ws);
          }
        }
      }
    }

    // Minimize windows not in the preset
    for (const [id, win] of this.app.wm.windows) {
      if (!matchedWinIds.has(id) && !win.isMinimized) {
        this.app.wm.minimize(id);
      }
    }

    // Update active preset name
    await fetch('/api/layouts-active', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    this._currentName = name;
  }

  // Delete a named preset
  async deletePreset(name) {
    try {
      await fetch(`/api/layouts/${encodeURIComponent(name)}`, { method: 'DELETE' });
      delete this._savedPresets[name];
      if (this._currentName === name) this._currentName = null;
    } catch {}
  }

  // Refresh saved presets list from server
  async refresh() {
    try {
      const res = await fetch('/api/layouts');
      const data = await res.json();
      this._savedPresets = data.saved || {};
      this._currentName = data.current || null;
    } catch {}
  }

  // Legacy aliases for backwards compatibility
  get _savedLayouts() { return this._savedPresets; }
  set _savedLayouts(v) { this._savedPresets = v; }
  async saveNamed(name) { return this.savePreset(name); }
  async loadNamed(name) { return this.loadPreset(name); }
  async deleteNamed(name) { return this.deletePreset(name); }
}

export { LayoutManager };
