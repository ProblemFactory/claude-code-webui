/**
 * Command Mode — Ctrl+\ prefix key (tmux-style).
 * Yellow [CMD] indicator in taskbar, 2s auto-exit.
 * Single keystrokes: arrows=snap, m=maximize, w=close, Tab=cycle, f/g/n/s/b/e=global.
 */

export class CommandMode {
  /**
   * @param {object} app - App instance for dispatching commands
   * @param {object} settings - SettingsManager
   */
  constructor(app, settings) {
    this.app = app;
    this.settings = settings;
    this._cmdMode = false;
    this._cmdTimer = null;
    this._cmdDigits = '';
    this._cmdDigitTimer = null;
    this._cmdIndicator = document.getElementById('cmd-indicator');
    this._setup();
  }

  _setup() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+Alt+Left/Right: switch virtual desktops
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.ctrlKey && e.altKey && !e.metaKey) {
        const dm = this.app.desktopManager;
        if (dm && dm.desktops.length > 1) {
          e.preventDefault(); e.stopPropagation();
          const idx = dm.desktops.findIndex(d => d.id === dm.activeDesktopId);
          const next = e.key === 'ArrowRight' ? (idx + 1) % dm.desktops.length : (idx - 1 + dm.desktops.length) % dm.desktops.length;
          dm.switchTo(dm.desktops[next].id);
        }
        return;
      }

      // Ctrl+\ toggles command mode (if enabled in settings)
      if (e.key === '\\' && e.ctrlKey && !e.altKey && !e.metaKey && (this.settings.get('toolbar.showCommandMode') ?? true)) {
        e.preventDefault();
        e.stopPropagation();
        if (this._cmdMode) this.exit();
        else this.enter();
        return;
      }

      if (!this._cmdMode) return;
      this._resetTimer();
      const key = e.key;

      if (key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.exit(); return; }

      // Digit accumulation for cell snap
      if (key >= '0' && key <= '9') {
        e.preventDefault(); e.stopPropagation();
        this._cmdDigits += key;
        clearTimeout(this._cmdDigitTimer);
        this._cmdDigitTimer = setTimeout(() => this._executeCellSnap(), 500);
        return;
      }

      if (this._cmdDigits) {
        clearTimeout(this._cmdDigitTimer);
        this._executeCellSnap();
        if (!this._cmdMode) return;
      }

      e.preventDefault(); e.stopPropagation();
      const app = this.app;
      const wm = app.wm;
      const activeWin = wm.windows.get(wm.activeWindowId);

      switch (key) {
        case 'ArrowLeft': if (activeWin) wm.snapToHalf(wm.activeWindowId, 'left'); this.exit(); break;
        case 'ArrowRight': if (activeWin) wm.snapToHalf(wm.activeWindowId, 'right'); this.exit(); break;
        case 'ArrowUp': if (activeWin) wm.snapToHalf(wm.activeWindowId, 'top'); this.exit(); break;
        case 'ArrowDown': if (activeWin) wm.snapToHalf(wm.activeWindowId, 'bottom'); this.exit(); break;
        case 'm': if (activeWin) wm.toggleMaximize(wm.activeWindowId); this.exit(); break;
        case 'w': if (activeWin) wm.closeWindow(wm.activeWindowId); this.exit(); break;
        case 'Tab':
          if (wm.windows.size > 0) {
            const ids = [...wm.windows.keys()];
            const curIdx = ids.indexOf(wm.activeWindowId);
            const nextIdx = (curIdx + 1) % ids.length;
            const nextId = ids[nextIdx];
            const nextWin = wm.windows.get(nextId);
            if (nextWin && nextWin.isMinimized) wm.restore(nextId);
            else wm.focusWindow(nextId);
            const session = app.sessions.get(nextId);
            if (session) session.focus();
          }
          break; // Stay in command mode for Tab
        case 'f': wm.applyLayout('freeform'); this.exit(); break;
        case 'g': {
          this.exit();
          const input = prompt('Grid (e.g. 3x3):');
          if (input) {
            const match = input.match(/(\d+)\s*[x×X]\s*(\d+)/);
            if (match) wm.setGrid(parseInt(match[1]), parseInt(match[2]));
          }
          break;
        }
        case 'n': this.exit(); app.showNewSessionDialog(); break;
        case 's': app.sidebar.toggle(); this.exit(); break;
        case 'b': app.openBrowser(); this.exit(); break;
        case 'e': app.openFileExplorer(); this.exit(); break;
        default: this.exit(); break;
      }
    }, true); // capture phase
  }

  enter() {
    this._cmdMode = true;
    this._cmdDigits = '';
    clearTimeout(this._cmdDigitTimer);
    this._cmdIndicator.classList.add('active');
    this._resetTimer();
  }

  exit() {
    this._cmdMode = false;
    this._cmdDigits = '';
    clearTimeout(this._cmdTimer);
    clearTimeout(this._cmdDigitTimer);
    this._cmdIndicator.classList.remove('active');
  }

  _resetTimer() {
    clearTimeout(this._cmdTimer);
    this._cmdTimer = setTimeout(() => this.exit(), 2000);
  }

  _executeCellSnap() {
    const cellIdx = parseInt(this._cmdDigits, 10) - 1;
    this._cmdDigits = '';
    if (cellIdx >= 0) this.app.wm.snapActiveToCell(cellIdx);
    this.exit();
  }
}
