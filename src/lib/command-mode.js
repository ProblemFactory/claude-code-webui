/**
 * Command Mode — Ctrl+\ prefix key (tmux-style).
 * Yellow [CMD] indicator in taskbar, 2s auto-exit.
 * Single keystrokes: arrows=snap, m=maximize, w=close, Tab=cycle, f/g/n/s/b/e=global.
 */

import { showInputDialog } from './utils.js';
import { registerCommand, runCommand } from './contributions.js';

// ── COMMANDS (contributions registry, Plugin Ph1) ──
// Every action command mode can perform is a registered command, runnable by
// anything (a plugin menu row, a plugin keybinding) via runCommand(id, { app }).
// The PREFIX-KEY DISPATCH stays in this class and is NOT a registerKeybinding
// chord: it is stateful (arm → 2s auto-exit, digit accumulation), its checks
// are modifier-LENIENT (Ctrl+\ ignores shift; Ctrl+Alt+Left/Right ignores
// shift) while the registry matcher is strict, and its capture-listener ORDER
// relative to the palette listener is load-bearing — moving it would change
// behaviour. Titles are plain English (no menu shows them; wrap in t() at
// render time, like window-types' `label`).
// Keep this block self-contained (the gate suite extracts + replays it): it
// closes over registerCommand and showInputDialog only.
export function registerCommandModeCommands() {
  const activeWin = (app) => app.wm.windows.get(app.wm.activeWindowId);
  const snap = (side) => (c) => { const wm = c.app.wm; if (activeWin(c.app)) wm.snapToHalf(wm.activeWindowId, side); };
  const desktopStep = (app, dir) => {
    const dm = app.desktopManager;
    if (dm && dm.desktops.length > 1) {
      const idx = dm.desktops.findIndex(d => d.id === dm.activeDesktopId);
      const next = dir > 0 ? (idx + 1) % dm.desktops.length : (idx - 1 + dm.desktops.length) % dm.desktops.length;
      dm.switchTo(dm.desktops[next].id);
    }
  };
  const moveWinDesktop = (app, dir) => {
    const wm = app.wm;
    const dm = app.desktopManager;
    if (dm && dm.desktops.length > 1 && activeWin(app)) {
      const idx = dm.desktops.findIndex(d => d.id === dm.activeDesktopId);
      const next = dir > 0 ? (idx + 1) % dm.desktops.length : (idx - 1 + dm.desktops.length) % dm.desktops.length;
      dm.moveWindowToDesktop(wm.activeWindowId, dm.desktops[next].id);
    }
  };
  registerCommand({ id: 'commandMode.toggle', title: 'Toggle command mode', run: (c) => c.app._commandMode?.toggle() });
  registerCommand({ id: 'activeWindow.snapLeft', title: 'Snap window left', run: snap('left') });
  registerCommand({ id: 'activeWindow.snapRight', title: 'Snap window right', run: snap('right') });
  registerCommand({ id: 'activeWindow.snapTop', title: 'Snap window top', run: snap('top') });
  registerCommand({ id: 'activeWindow.snapBottom', title: 'Snap window bottom', run: snap('bottom') });
  registerCommand({ id: 'activeWindow.toggleMaximize', title: 'Toggle maximize', run: (c) => { const wm = c.app.wm; if (activeWin(c.app)) wm.toggleMaximize(wm.activeWindowId); } });
  registerCommand({ id: 'activeWindow.close', title: 'Close window', run: (c) => { const wm = c.app.wm; if (activeWin(c.app)) wm.closeWindow(wm.activeWindowId); } });
  registerCommand({
    id: 'activeWindow.cycle', title: 'Cycle windows',
    run: (c) => {
      const app = c.app, wm = app.wm;
      // Cycle only windows on the active desktop (and skip tab guests) —
      // focusing a _hiddenByDesktop window sent keyboard focus into an
      // invisible window with no desktop switch
      const cycleIds = [...wm.windows.entries()]
        .filter(([, w]) => !w._hiddenByDesktop && !(w._tabChain && w._tabChain.tabs[0] !== w.id))
        .map(([id]) => id);
      if (cycleIds.length > 0) {
        const curIdx = cycleIds.indexOf(wm.activeWindowId);
        const nextId = cycleIds[(curIdx + 1) % cycleIds.length];
        const nextWin = wm.windows.get(nextId);
        if (nextWin && nextWin.isMinimized) wm.restore(nextId);
        else wm.focusWindow(nextId);
        const session = app.sessions.get(nextId);
        if (session) session.focus();
      }
    },
  });
  registerCommand({ id: 'layout.freeform', title: 'Freeform layout', run: (c) => c.app.wm.applyLayout('freeform') });
  registerCommand({
    id: 'layout.customGrid', title: 'Custom grid…',
    run: (c) => {
      const wm = c.app.wm;
      showInputDialog({ title: 'Custom Grid', label: 'Grid (e.g. 3x3)', placeholder: '3x3', confirmText: 'Apply' }).then((input) => {
        if (!input) return;
        const match = input.match(/(\d+)\s*[x×X]\s*(\d+)/);
        if (match) wm.setGrid(parseInt(match[1]), parseInt(match[2]));
      });
    },
  });
  registerCommand({ id: 'session.new', title: 'New session', run: (c) => c.app.showNewSessionDialog() });
  registerCommand({ id: 'sidebar.toggle', title: 'Toggle sidebar', run: (c) => c.app.sidebar.toggle() });
  registerCommand({ id: 'browser.open', title: 'Open browser', run: (c) => c.app.openBrowser() });
  registerCommand({ id: 'explorer.open', title: 'Open file explorer', run: (c) => c.app.openFileExplorer() });
  registerCommand({ id: 'desktop.next', title: 'Next desktop', run: (c) => desktopStep(c.app, +1) });
  registerCommand({ id: 'desktop.previous', title: 'Previous desktop', run: (c) => desktopStep(c.app, -1) });
  registerCommand({ id: 'activeWindow.moveToNextDesktop', title: 'Move window to next desktop', run: (c) => moveWinDesktop(c.app, +1) });
  registerCommand({ id: 'activeWindow.moveToPreviousDesktop', title: 'Move window to previous desktop', run: (c) => moveWinDesktop(c.app, -1) });
}
registerCommandModeCommands();
// end registerCommandModeCommands (scripts/test-contributions.mjs extracts the block above)

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
      const cctx = { app: this.app };
      // Ctrl+Alt+Left/Right: switch virtual desktops
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.ctrlKey && e.altKey && !e.metaKey) {
        const dm = this.app.desktopManager;
        const stage = this.app.stage;
        // Stage sits LEFT of the strip: Left from the leftmost desktop enters
        // it; Right from the stage leaves to the first desktop.
        if (stage?.isActive) {
          if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); stage.leave(dm.desktops[0]?.id); }
          return;
        }
        if (dm) {
          const idx = dm.desktops.findIndex(d => d.id === dm.activeDesktopId);
          if (e.key === 'ArrowLeft' && idx === 0 && stage?.enabled) {
            e.preventDefault(); e.stopPropagation(); stage.enter(); return;
          }
          if (dm.desktops.length > 1) {
            e.preventDefault(); e.stopPropagation();
            runCommand(e.key === 'ArrowRight' ? 'desktop.next' : 'desktop.previous', cctx);
          }
        }
        return;
      }

      // Ctrl+\ toggles command mode (if enabled in settings)
      if (e.key === '\\' && e.ctrlKey && !e.altKey && !e.metaKey && (this.settings.get('toolbar.showCommandMode') ?? true)) {
        e.preventDefault();
        e.stopPropagation();
        runCommand('commandMode.toggle', cctx);
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

      switch (key) {
        case 'ArrowLeft': runCommand('activeWindow.snapLeft', cctx); this.exit(); break;
        case 'ArrowRight': runCommand('activeWindow.snapRight', cctx); this.exit(); break;
        case 'ArrowUp': runCommand('activeWindow.snapTop', cctx); this.exit(); break;
        case 'ArrowDown': runCommand('activeWindow.snapBottom', cctx); this.exit(); break;
        case 'm': runCommand('activeWindow.toggleMaximize', cctx); this.exit(); break;
        case 'w': runCommand('activeWindow.close', cctx); this.exit(); break;
        case 'Tab': runCommand('activeWindow.cycle', cctx); break; // Stay in command mode for Tab
        case 'f': runCommand('layout.freeform', cctx); this.exit(); break;
        case 'g': this.exit(); runCommand('layout.customGrid', cctx); break;
        case 'n': this.exit(); runCommand('session.new', cctx); break;
        case 's': runCommand('sidebar.toggle', cctx); this.exit(); break;
        case 'b': runCommand('browser.open', cctx); this.exit(); break;
        case 'e': runCommand('explorer.open', cctx); this.exit(); break;
        // d = switch to next desktop, D (shift+d) = switch to previous
        case 'd': runCommand('desktop.next', cctx); this.exit(); break;
        case 'D': runCommand('desktop.previous', cctx); this.exit(); break;
        // [ = move active window to prev desktop, ] = next desktop
        case '[': runCommand('activeWindow.moveToPreviousDesktop', cctx); this.exit(); break;
        case ']': runCommand('activeWindow.moveToNextDesktop', cctx); this.exit(); break;
        default: this.exit(); break;
      }
    }, true); // capture phase
  }

  toggle() { if (this._cmdMode) this.exit(); else this.enter(); }

  enter() {
    this._cmdMode = true;
    this._cmdDigits = '';
    clearTimeout(this._cmdDigitTimer);
    this._cmdIndicator.classList.add('active');
    // Show the available keys while armed — command mode was undiscoverable
    this._cmdIndicator.textContent = '[CMD] ←↑↓→ snap · m max · w close · Tab cycle · f free · g grid · n new · s sidebar';
    this._resetTimer();
  }

  exit() {
    this._cmdMode = false;
    this._cmdDigits = '';
    clearTimeout(this._cmdTimer);
    clearTimeout(this._cmdDigitTimer);
    this._cmdIndicator.classList.remove('active');
    this._cmdIndicator.textContent = '[CMD]';
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
