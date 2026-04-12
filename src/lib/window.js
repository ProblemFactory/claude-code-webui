import { attachPopoverClose } from './utils.js';

const TYPE_ICONS = {
  terminal: '\u2B1B', chat: '\uD83D\uDCAC', files: '\uD83D\uDCC1', viewer: '\uD83D\uDCC4',
  editor: '\u270F\uFE0F', 'hex-viewer': '\uD83D\uDD22', browser: '\uD83C\uDF10',
};

class WindowManager {
  constructor(workspace) {
    this.workspace = workspace;
    this.windows = new Map(); this.zIndex = 100; this.activeWindowId = null;
    this.snapIndicator = document.getElementById('snap-indicator');
    this.gridOverlay = document.getElementById('grid-overlay');
    this.onWindowsChanged = null; this.windowCounter = 0;
    this.grid = null; // { rows, cols }
    this._overlapDebounceTimer = null;
    this._settings = null; // set by App after construction

    // Reflow grid-tracked windows when workspace resizes (sidebar toggle, browser resize)
    this._resizeObserver = new ResizeObserver(() => this._reflowWindows());
    this._resizeObserver.observe(workspace);
  }

  createWindow({ title, type, x, y, width, height, syncId, openSpec }) {
    const id = syncId || ('win-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    this.windowCounter++;
    if (x === undefined) { const o = (this.windowCounter % 8) * 30; x = 40 + o; y = 40 + o; }
    width = width || 700; height = height || 500;

    const el = document.createElement('div');
    el.className = 'window';
    el.style.cssText = `left:${x}px;top:${y}px;width:${width}px;height:${height}px;z-index:${this.zIndex++}`;

    const titleBar = document.createElement('div'); titleBar.className = 'window-titlebar';
    const iconSpan = document.createElement('span'); iconSpan.className = 'window-type-icon'; iconSpan.textContent = TYPE_ICONS[type] || '';
    const titleSpan = document.createElement('span'); titleSpan.className = 'window-title'; titleSpan.textContent = title;
    const controls = document.createElement('div'); controls.className = 'window-controls';
    controls.innerHTML = '<button class="win-btn win-overlap-btn no-overlap" title="Overlapping windows">□</button><button class="win-btn win-minimize" title="Minimize">─</button><button class="win-btn win-maximize" title="Maximize">□</button><button class="win-btn win-close" title="Close">✕</button>';
    titleBar.append(iconSpan, titleSpan, controls);

    const content = document.createElement('div'); content.className = 'window-content';
    for (const dir of ['n','s','e','w','ne','nw','se','sw']) {
      const h = document.createElement('div'); h.className = `resize-handle resize-${dir}`; h.dataset.dir = dir; el.appendChild(h);
    }
    el.append(titleBar, content); this.workspace.appendChild(el);

    const winInfo = { id, element: el, titleBar, titleSpan, iconSpan, content, title, type,
      isMaximized: false, isMinimized: false, prevBounds: null, onResize: null, onClose: null, exited: false,
      _typeIcon: TYPE_ICONS[type] || '', _tabChain: null };
    this.windows.set(id, winInfo);
    this._setupDrag(winInfo); this._setupResize(winInfo); this._setupIconDrag(winInfo);
    controls.querySelector('.win-overlap-btn').onclick = (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      if (btn.classList.contains('no-overlap')) return;
      this._showOverlapSwitcher(winInfo, e.clientX, e.clientY);
    };
    controls.querySelector('.win-minimize').onclick = (e) => { e.stopPropagation(); this.minimize(winInfo.id); };
    controls.querySelector('.win-maximize').onclick = (e) => { e.stopPropagation(); this.toggleMaximize(winInfo.id); };
    controls.querySelector('.win-close').onclick = (e) => { e.stopPropagation(); this.closeWindow(winInfo.id); };
    el.addEventListener('mousedown', () => this.focusWindow(winInfo.id));
    titleBar.addEventListener('dblclick', (e) => { if (!e.target.closest('.window-controls')) this.toggleMaximize(winInfo.id); });
    // Right-click on title bar: show overlapping windows switcher
    titleBar.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.window-controls')) return;
      e.preventDefault();
      this._showOverlapSwitcher(winInfo, e.clientX, e.clientY);
    });
    if (openSpec) winInfo._openSpec = openSpec;
    this.focusWindow(id); this._notify(); this._scheduleOverlapUpdate(); return winInfo;
  }

  // ── Grid Bounds Tracking ──
  // Store window position as fractions of workspace (0-1) so it scales with resize.
  // Set on grid snap or applyLayout. Updated on user resize. Cleared on manual drag or freeform.
  _captureGridBounds(win) {
    // Skip grouped guests — they share host bounds via _syncChainBounds
    if (win._tabChain && win._tabChain.tabs[0] !== win.id) return;
    const r = this.workspace.getBoundingClientRect();
    const el = win.element;
    win.gridBounds = {
      left: el.offsetLeft / r.width,
      top: el.offsetTop / r.height,
      width: el.offsetWidth / r.width,
      height: el.offsetHeight / r.height,
    };
  }

  _applyGridBounds(win) {
    if (!win.gridBounds) return;
    const r = this.workspace.getBoundingClientRect();
    const b = win.gridBounds;
    const el = win.element;
    el.style.left = (b.left * r.width) + 'px';
    el.style.top = (b.top * r.height) + 'px';
    el.style.width = (b.width * r.width) + 'px';
    el.style.height = (b.height * r.height) + 'px';
    if (win.onResize) win.onResize();
  }

  _reflowWindows() {
    // Skip on mobile — windows are position:fixed via CSS
    if (window.innerWidth <= 768) return;
    for (const win of this.windows.values()) {
      // Skip grouped guests — they share the host's element
      if (win._tabChain && win._tabChain.tabs[0] !== win.id) continue;
      if (win.gridBounds && !win.isMinimized && !win.isMaximized) {
        this._applyGridBounds(win);
      }
    }
  }

  _setupDrag(win) {
    const { element, titleBar } = win;
    let mouseDown = false, dragging = false, startX, startY, initL, initT;
    let shiftDragStart = -1;
    const DRAG_THRESHOLD = 5; // px — must move this far before drag starts

    titleBar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.window-controls') || e.target.closest('.tab-item') || e.target.closest('.window-type-icon') || e.button !== 0) return;
      mouseDown = true; dragging = false;
      startX = e.clientX; startY = e.clientY;
      initL = element.offsetLeft; initT = element.offsetTop;
      shiftDragStart = -1;
      e.preventDefault();
    });

    const onMove = (e) => {
      if (!mouseDown) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;

      // Start dragging only after threshold (prevents click-to-focus from snapping)
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        dragging = true;
        // Save pre-snap size for restore on un-snap
        if (!win._preSnapBounds) {
          win._preSnapBounds = { width: element.style.width, height: element.style.height, left: element.style.left, top: element.style.top };
        }
        if (win.isMaximized) {
          const prev = win.prevBounds, prevW = parseInt(prev.width) || 700;
          win.isMaximized = false; element.style.width = prev.width; element.style.height = prev.height;
          element.style.left = (e.clientX - prevW * (e.clientX / this.workspace.offsetWidth)) + 'px'; element.style.top = '0px';
          initL = element.offsetLeft; initT = element.offsetTop;
          startX = e.clientX; startY = e.clientY;
        }
        // Restore pre-snap size when dragging out of a snap
        if (win._isSnapped && win._preSnapBounds) {
          const ps = win._preSnapBounds;
          element.style.width = ps.width; element.style.height = ps.height;
          // Center on cursor
          initL = e.clientX - (parseInt(ps.width) || 350) / 2;
          initT = e.clientY - 15;
          element.style.left = initL + 'px'; element.style.top = initT + 'px';
          startX = e.clientX; startY = e.clientY;
          win._isSnapped = false;
        }
        element.classList.add('dragging');
        if (this.grid) this.gridOverlay.classList.add('dragging');
      }

      element.style.left = (initL + dx) + 'px'; element.style.top = (initT + dy) + 'px';
      const snapEnabled = this._settings?.get('layout.enableDragSnap') ?? true;
      const shiftDragEnabled = this._settings?.get('layout.enableShiftDragSelection') ?? true;
      if (!e.altKey && snapEnabled) {
        if (e.shiftKey && this.grid && shiftDragEnabled) {
          if (shiftDragStart < 0) shiftDragStart = this._getGridCell(e.clientX, e.clientY);
          const current = this._getGridCell(e.clientX, e.clientY);
          if (shiftDragStart >= 0 && current >= 0) this._showGridRangeHighlight(shiftDragStart, current);
        } else {
          if (shiftDragStart >= 0) { shiftDragStart = -1; this._clearGridHighlight(); }
          if (this.grid) this._showGridHighlight(e.clientX, e.clientY);
          else this._showSnap(e.clientX, e.clientY);
        }
      } else {
        this.snapIndicator.style.display = 'none';
        this._clearGridHighlight();
      }
    };

    const onUp = (e) => {
      if (!mouseDown) return;
      mouseDown = false;
      if (!dragging) return; // Click without drag — don't snap
      dragging = false; element.classList.remove('dragging');
      this.snapIndicator.style.display = 'none';
      const snapEnabled = this._settings?.get('layout.enableDragSnap') ?? true;
      const shiftDragEnabled = this._settings?.get('layout.enableShiftDragSelection') ?? true;
      let snapped = false;
      if (!e.altKey && snapEnabled) {
        if (shiftDragStart >= 0 && e.shiftKey && this.grid && shiftDragEnabled) {
          const endCell = this._getGridCell(e.clientX, e.clientY);
          if (endCell >= 0) { this._snapToGridRange(win.id, shiftDragStart, endCell); snapped = true; }
          shiftDragStart = -1;
        } else if (this.grid) {
          this._snapToGrid(win.id, e.clientX, e.clientY); snapped = true;
        } else {
          const snap = this._getSnapZone(e.clientX, e.clientY);
          if (snap) { this._applySnap(win.id, snap); snapped = true; }
        }
      }
      if (snapped) {
        win._isSnapped = true;
      } else {
        // Free drop — clear pre-snap memory
        win._preSnapBounds = null;
        win._isSnapped = false;
      }
      this._clearGridHighlight(); this.gridOverlay.classList.remove('dragging');
      // Re-capture proportional bounds after final position (snap or free drop)
      setTimeout(() => {
        this._captureGridBounds(win);
        if (win._tabChain) this._syncChainBounds(win._tabChain);
        this._scheduleOverlapUpdate(); this._notify();
      }, 250);
    };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }

  _snapVal(val, gridLines, threshold) {
    for (const gl of gridLines) {
      if (Math.abs(val - gl) < threshold) return gl;
    }
    return val;
  }

  _getGridLines() {
    if (!this.grid) return { x: [], y: [] };
    const r = this.workspace.getBoundingClientRect();
    const gap = 4;
    const { rows, cols } = this.grid;
    const cw = (r.width - gap * (cols + 1)) / cols;
    const ch = (r.height - gap * (rows + 1)) / rows;
    const x = [], y = [];
    for (let c = 0; c <= cols; c++) x.push(gap + c * (cw + gap));
    for (let rr = 0; rr <= rows; rr++) y.push(gap + rr * (ch + gap));
    return { x, y };
  }

  _setupResize(win) {
    win.element.querySelectorAll('.resize-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation(); e.preventDefault();
        const dir = handle.dataset.dir, sX = e.clientX, sY = e.clientY;
        const sW = win.element.offsetWidth, sH = win.element.offsetHeight, sL = win.element.offsetLeft, sT = win.element.offsetTop;
        const SNAP_T = 15;

        const onMove = (e) => {
          const dx = e.clientX - sX, dy = e.clientY - sY;
          let newL = sL, newT = sT, newW = sW, newH = sH;

          if (dir.includes('e')) newW = Math.max(320, sW + dx);
          if (dir.includes('w')) { newW = Math.max(320, sW - dx); newL = sL + sW - newW; }
          if (dir.includes('s')) newH = Math.max(180, sH + dy);
          if (dir.includes('n')) { newH = Math.max(180, sH - dy); newT = sT + sH - newH; }

          if (this.grid && !e.altKey) {
            const gl = this._getGridLines();
            if (dir.includes('e')) { const snapped = this._snapVal(newL + newW, gl.x, SNAP_T); newW = snapped - newL; }
            if (dir.includes('w')) { const snapped = this._snapVal(newL, gl.x, SNAP_T); newW = newW + (newL - snapped); newL = snapped; }
            if (dir.includes('s')) { const snapped = this._snapVal(newT + newH, gl.y, SNAP_T); newH = snapped - newT; }
            if (dir.includes('n')) { const snapped = this._snapVal(newT, gl.y, SNAP_T); newH = newH + (newT - snapped); newT = snapped; }
          }

          win.element.style.left = newL + 'px'; win.element.style.top = newT + 'px';
          win.element.style.width = Math.max(320, newW) + 'px'; win.element.style.height = Math.max(180, newH) + 'px';
          if (win.onResize) win.onResize();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          // Update gridBounds after resize (if window was grid-tracked, keep tracking with new proportions)
          if (win.gridBounds) this._captureGridBounds(win);
          if (win._tabChain) this._syncChainBounds(win._tabChain);
          if (win.onResize) win.onResize();
          this._scheduleOverlapUpdate();
          // Manual resize = new baseline for snap restore
          if (!win._isSnapped) {
            win._preSnapBounds = { width: win.element.style.width, height: win.element.style.height, left: win.element.style.left, top: win.element.style.top };
          }
          this._notify();
        };
        document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
      });
    });
  }

  // ── Snap Zones ──
  _getSnapZone(cx, cy) {
    const r = this.workspace.getBoundingClientRect(), x = cx - r.left, y = cy - r.top, T = 30;
    if (x < T && y < T) return 'top-left'; if (x > r.width - T && y < T) return 'top-right';
    if (x < T && y > r.height - T) return 'bottom-left'; if (x > r.width - T && y > r.height - T) return 'bottom-right';
    if (x < T) return 'left'; if (x > r.width - T) return 'right';
    if (y < T) return 'top'; if (y > r.height - T) return 'bottom'; return null;
  }
  _getSnapZones(g) {
    const r = this.workspace.getBoundingClientRect();
    return {
      left:{left:g,top:g,width:r.width/2-g*1.5,height:r.height-g*2}, right:{left:r.width/2+g/2,top:g,width:r.width/2-g*1.5,height:r.height-g*2},
      top:{left:g,top:g,width:r.width-g*2,height:r.height/2-g*1.5}, bottom:{left:g,top:r.height/2+g/2,width:r.width-g*2,height:r.height/2-g*1.5},
      'top-left':{left:g,top:g,width:r.width/2-g*1.5,height:r.height/2-g*1.5}, 'top-right':{left:r.width/2+g/2,top:g,width:r.width/2-g*1.5,height:r.height/2-g*1.5},
      'bottom-left':{left:g,top:r.height/2+g/2,width:r.width/2-g*1.5,height:r.height/2-g*1.5}, 'bottom-right':{left:r.width/2+g/2,top:r.height/2+g/2,width:r.width/2-g*1.5,height:r.height/2-g*1.5},
    };
  }
  _showSnap(cx, cy) {
    const zone = this._getSnapZone(cx, cy);
    if (!zone) { this.snapIndicator.style.display = 'none'; return; }
    const z = this._getSnapZones(6)[zone]; const si = this.snapIndicator;
    si.style.display = 'block'; si.style.left = z.left+'px'; si.style.top = z.top+'px'; si.style.width = z.width+'px'; si.style.height = z.height+'px';
  }
  _applySnap(winId, zone) {
    const win = this.windows.get(winId); if (!win) return;
    const z = this._getSnapZones(4)[zone], el = win.element;
    el.classList.add('snap-animating');
    el.style.left=z.left+'px'; el.style.top=z.top+'px'; el.style.width=z.width+'px'; el.style.height=z.height+'px';
    win.isMaximized = false;
    setTimeout(() => { el.classList.remove('snap-animating'); if (win.onResize) win.onResize(); this._captureGridBounds(win); if (win._tabChain) this._syncChainBounds(win._tabChain); }, 220);
  }

  // ── Custom Grid ──
  setGrid(rows, cols) {
    this.grid = rows && cols ? { rows, cols } : null;
    this._renderGridOverlay();
    this._notify();
  }
  _renderGridOverlay() {
    const ov = this.gridOverlay; ov.innerHTML = '';
    if (!this.grid) { ov.classList.remove('active'); return; }
    ov.classList.add('active');
    ov.style.gridTemplateRows = `repeat(${this.grid.rows}, 1fr)`;
    ov.style.gridTemplateColumns = `repeat(${this.grid.cols}, 1fr)`;
    for (let i = 0; i < this.grid.rows * this.grid.cols; i++) {
      const cell = document.createElement('div'); cell.className = 'grid-cell'; cell.dataset.idx = i; ov.appendChild(cell);
    }
  }
  _getGridCell(cx, cy) {
    if (!this.grid) return -1;
    const r = this.workspace.getBoundingClientRect();
    const x = cx - r.left, y = cy - r.top;
    const col = Math.floor(x / (r.width / this.grid.cols));
    const row = Math.floor(y / (r.height / this.grid.rows));
    if (col < 0 || col >= this.grid.cols || row < 0 || row >= this.grid.rows) return -1;
    return row * this.grid.cols + col;
  }
  _showGridHighlight(cx, cy) {
    const idx = this._getGridCell(cx, cy);
    this.gridOverlay.querySelectorAll('.grid-cell').forEach((c, i) => c.classList.toggle('highlight', i === idx));
  }
  _clearGridHighlight() { this.gridOverlay.querySelectorAll('.grid-cell').forEach(c => c.classList.remove('highlight')); }

  _snapToGrid(winId, cx, cy) {
    const idx = this._getGridCell(cx, cy); if (idx < 0) return;
    const win = this.windows.get(winId); if (!win) return;
    this._positionToCell(win, idx, true);
    this._captureGridBounds(win); // Track as proportional bounds
  }

  snapActiveToCell(cellIdx) {
    const win = this.windows.get(this.activeWindowId);
    if (!win || !this.grid) return;
    const totalCells = this.grid.rows * this.grid.cols;
    if (cellIdx < 0 || cellIdx >= totalCells) return; // bounds check
    this._positionToCell(win, cellIdx, true);
    setTimeout(() => this._captureGridBounds(win), 250);
  }

  // Snap a window to half the workspace without changing the grid
  snapToHalf(winId, side) {
    const win = this.windows.get(winId); if (!win) return;
    const r = this.workspace.getBoundingClientRect(), g = 4;
    const el = win.element;
    const zones = {
      left:   { left: g, top: g, width: r.width / 2 - g * 1.5, height: r.height - g * 2 },
      right:  { left: r.width / 2 + g / 2, top: g, width: r.width / 2 - g * 1.5, height: r.height - g * 2 },
      top:    { left: g, top: g, width: r.width - g * 2, height: r.height / 2 - g * 1.5 },
      bottom: { left: g, top: r.height / 2 + g / 2, width: r.width - g * 2, height: r.height / 2 - g * 1.5 },
    };
    const z = zones[side]; if (!z) return;
    el.classList.add('snap-animating');
    el.style.left = z.left + 'px'; el.style.top = z.top + 'px';
    el.style.width = z.width + 'px'; el.style.height = z.height + 'px';
    win.isMaximized = false;
    setTimeout(() => { el.classList.remove('snap-animating'); if (win.onResize) win.onResize(); this._captureGridBounds(win); if (win._tabChain) this._syncChainBounds(win._tabChain); }, 220);
  }

  _showGridRangeHighlight(startIdx, endIdx) {
    const { cols } = this.grid;
    const r1 = Math.floor(startIdx / cols), c1 = startIdx % cols;
    const r2 = Math.floor(endIdx / cols), c2 = endIdx % cols;
    const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
    const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
    this.gridOverlay.querySelectorAll('.grid-cell').forEach((cell, i) => {
      const cr = Math.floor(i / cols), cc = i % cols;
      cell.classList.toggle('highlight', cr >= minR && cr <= maxR && cc >= minC && cc <= maxC);
    });
  }

  _snapToGridRange(winId, startIdx, endIdx) {
    const win = this.windows.get(winId); if (!win || !this.grid) return;
    const { rows, cols } = this.grid;
    const r1 = Math.floor(startIdx / cols), c1 = startIdx % cols;
    const r2 = Math.floor(endIdx / cols), c2 = endIdx % cols;
    const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
    const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);

    const r = this.workspace.getBoundingClientRect(), g = 4;
    const cw = (r.width - g * (cols + 1)) / cols;
    const ch = (r.height - g * (rows + 1)) / rows;

    const el = win.element;
    el.classList.add('snap-animating');
    el.style.left = (g + minC * (cw + g)) + 'px';
    el.style.top = (g + minR * (ch + g)) + 'px';
    el.style.width = ((maxC - minC + 1) * (cw + g) - g) + 'px';
    el.style.height = ((maxR - minR + 1) * (ch + g) - g) + 'px';
    win.isMaximized = false;
    setTimeout(() => { el.classList.remove('snap-animating'); if (win.onResize) win.onResize(); this._captureGridBounds(win); if (win._tabChain) this._syncChainBounds(win._tabChain); }, 220);
  }

  _positionToCell(win, idx, animate) {
    if (!this.grid) return;
    const r = this.workspace.getBoundingClientRect(), g = 4;
    const { rows, cols } = this.grid;
    const row = Math.floor(idx / cols), col = idx % cols;
    const cw = (r.width - g * (cols + 1)) / cols, ch = (r.height - g * (rows + 1)) / rows;
    const el = win.element;
    if (animate) el.classList.add('snap-animating');
    el.style.left = (g + col * (cw + g)) + 'px'; el.style.top = (g + row * (ch + g)) + 'px';
    el.style.width = cw + 'px'; el.style.height = ch + 'px';
    win.isMaximized = false;
    if (animate) setTimeout(() => { el.classList.remove('snap-animating'); if (win.onResize) win.onResize(); }, 220);
    else if (win.onResize) win.onResize();
  }

  // ── Layout Presets ──
  focusWindow(id, { bounce = false } = {}) {
    const win = this.windows.get(id); if (!win) return;
    // If this window is a grouped guest, focus the host and switch to this tab
    if (win._tabChain && win._tabChain.tabs[0] !== win.id) {
      const idx = win._tabChain.tabs.indexOf(win.id);
      if (idx >= 0) this.switchTab(win._tabChain, idx);
      const hostId = win._tabChain.tabs[0];
      const host = this.windows.get(hostId);
      if (host) {
        this.windows.forEach(w => w.element.classList.remove('window-active', 'highlight-subtle', 'highlight-strong'));
        host.element.style.zIndex = this.zIndex++; host.element.classList.add('window-active');
        const intensity = this._settings?.get('window.activeHighlightIntensity') ?? 'normal';
        if (intensity === 'subtle') host.element.classList.add('highlight-subtle');
        else if (intensity === 'strong') host.element.classList.add('highlight-strong');
      }
      this.activeWindowId = id; this._notify();
      return;
    }
    this.windows.forEach(w => w.element.classList.remove('window-active', 'highlight-subtle', 'highlight-strong'));
    win.element.style.zIndex = this.zIndex++; win.element.classList.add('window-active');
    const intensity = this._settings?.get('window.activeHighlightIntensity') ?? 'normal';
    if (intensity === 'subtle') win.element.classList.add('highlight-subtle');
    else if (intensity === 'strong') win.element.classList.add('highlight-strong');
    this.activeWindowId = id; this._notify();
    if (bounce && (this._settings?.get('window.enableBounceOnFocus') ?? false)) {
      win.element.classList.remove('window-bounce');
      requestAnimationFrame(() => win.element.classList.add('window-bounce'));
      setTimeout(() => win.element.classList.remove('window-bounce'), 300);
    }
  }
  // Move mode: window attaches to cursor, click to place (for recovering off-screen windows)
  startMoveMode(id) {
    const win = this.windows.get(id); if (!win) return;
    if (win.isMinimized) this.restore(id);
    this.focusWindow(id);
    const el = win.element;
    el.style.cursor = 'move';
    document.body.style.cursor = 'move';

    const onMove = (e) => {
      const w = el.offsetWidth || parseInt(el.style.width) || 350;
      el.style.left = (e.clientX - w / 2) + 'px';
      el.style.top = (e.clientY - 15) + 'px';
    };
    const onClick = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      el.style.cursor = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mousedown', onClick, true);
      this._captureGridBounds(win);
      this._notify();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mousedown', onClick, true); // capture phase to intercept before other handlers
  }

  toggleMaximize(id) {
    let win = this.windows.get(id); if (!win) return;
    // For grouped guests, operate on host
    if (win._tabChain && win._tabChain.tabs[0] !== win.id) {
      win = this.windows.get(win._tabChain.tabs[0]);
      if (!win) return;
    }
    const el = win.element;
    if (win.isMaximized) { const p = win.prevBounds; el.style.left=p.left; el.style.top=p.top; el.style.width=p.width; el.style.height=p.height; win.isMaximized = false; }
    else { win.prevBounds={left:el.style.left,top:el.style.top,width:el.style.width,height:el.style.height}; el.style.left='0';el.style.top='0';el.style.width='100%';el.style.height='100%'; win.isMaximized = true; }
    setTimeout(() => {
      if (win.onResize) win.onResize();
      this._captureGridBounds(win);
      if (win._tabChain) this._syncChainBounds(win._tabChain);
    }, 50); this._notify(); this._scheduleOverlapUpdate();
  }
  minimize(id) {
    let win = this.windows.get(id); if (!win) return;
    // For grouped guests, minimize the host
    if (win._tabChain && win._tabChain.tabs[0] !== win.id) {
      win = this.windows.get(win._tabChain.tabs[0]);
      if (!win) return;
    }
    win.element.style.display='none'; win.isMinimized=true; this._notify(); this._scheduleOverlapUpdate();
  }
  restore(id) {
    let win = this.windows.get(id); if (!win) return;
    // For grouped guests, restore the host
    if (win._tabChain && win._tabChain.tabs[0] !== win.id) {
      win = this.windows.get(win._tabChain.tabs[0]);
      if (!win) return;
    }
    win.element.style.display=''; win.isMinimized=false; this.focusWindow(id); setTimeout(() => { if (win.onResize) win.onResize(); this._captureGridBounds(win); }, 50); this._scheduleOverlapUpdate();
  }
  closeWindow(id) {
    const win = this.windows.get(id); if (!win) return;
    if (win._tabChain) {
      this.removeFromTabChain(win._tabChain, id);
      // onClose fires inside removeFromTabChain
      return;
    }
    if (win.onClose) win.onClose(); win.element.remove(); this.windows.delete(id); this._notify(); this._scheduleOverlapUpdate();
  }
  setTitle(id, t) {
    const win = this.windows.get(id); if (!win) return;
    win.title = t; win.titleSpan.textContent = t;
    // Update tab label if in a chain
    if (win._tabChain) {
      const host = this.windows.get(win._tabChain.tabs[0]);
      if (host) {
        const tabEl = host.titleBar.querySelector(`.tab-item[data-win-id="${id}"] .tab-label`);
        if (tabEl) tabEl.textContent = t;
      }
    }
    this._notify();
  }

  applyLayout(layout) {
    if (layout === 'freeform') { this.setGrid(null); return; }

    const gridMap = {
      'maximize':      { rows: 1, cols: 1 },
      'two-vertical':  { rows: 1, cols: 2 },
      'two-horizontal':{ rows: 2, cols: 1 },
      'quad':          { rows: 2, cols: 2 },
      'three-columns': { rows: 1, cols: 3 },
    };
    let g = gridMap[layout];
    if (!g && layout.startsWith('grid-')) {
      const parts = layout.split('-');
      g = { rows: parseInt(parts[1]), cols: parseInt(parts[2]) };
    }
    if (!g || !g.rows || !g.cols) return;

    this.setGrid(g.rows, g.cols);

    // Skip grouped guests — only host windows get positioned
    const visible = [...this.windows.values()].filter(w => !w.isMinimized && !(w._tabChain && w._tabChain.tabs[0] !== w.id));
    if (!visible.length) return;
    const totalCells = g.rows * g.cols;

    // Round-robin: all windows get a cell, wrapping around if more windows than cells
    visible.forEach((w, i) => {
      const cellIdx = i % totalCells;
      this._positionToCell(w, cellIdx, true);
      setTimeout(() => { this._captureGridBounds(w); if (w._tabChain) this._syncChainBounds(w._tabChain); }, 250);
    });
    setTimeout(() => this._scheduleOverlapUpdate(), 300);
  }
  // ── Overlap Switcher (middle-click on title bar) ──
  _rectsOverlap(a, b) {
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  }

  _showOverlapSwitcher(win, cx, cy) {
    document.querySelectorAll('.overlap-switcher').forEach(p => p.remove());
    const el = win.element;
    const rect = { left: el.offsetLeft, top: el.offsetTop, right: el.offsetLeft + el.offsetWidth, bottom: el.offsetTop + el.offsetHeight };

    const overlapping = [];
    for (const [id, w] of this.windows) {
      if (id === win.id || w.isMinimized) continue;
      if (w._tabChain && w._tabChain.tabs[0] !== w.id) continue; // skip grouped guests
      const wEl = w.element;
      const wr = { left: wEl.offsetLeft, top: wEl.offsetTop, right: wEl.offsetLeft + wEl.offsetWidth, bottom: wEl.offsetTop + wEl.offsetHeight };
      if (this._rectsOverlap(rect, wr)) overlapping.push(w);
    }
    if (!overlapping.length) return;

    const pop = document.createElement('div');
    pop.className = 'overlap-switcher';

    for (const w of overlapping) {
      const item = document.createElement('div');
      item.className = 'overlap-switcher-item';
      const dot = document.createElement('span');
      dot.className = 'taskbar-dot';
      if (w.exited) dot.classList.add('exited');
      const label = document.createElement('span');
      label.textContent = w.title;
      item.append(dot, label);
      item.onclick = () => { this.focusWindow(w.id); pop.remove(); };
      pop.appendChild(item);
    }

    document.body.appendChild(pop);
    // Position at cursor, clamp to viewport
    requestAnimationFrame(() => {
      const pw = pop.offsetWidth, ph = pop.offsetHeight;
      pop.style.left = Math.min(cx, window.innerWidth - pw - 8) + 'px';
      pop.style.top = Math.min(cy, window.innerHeight - ph - 8) + 'px';
    });

    attachPopoverClose(pop);
  }

  // ── Overlap Indicators ──
  _scheduleOverlapUpdate() {
    clearTimeout(this._overlapDebounceTimer);
    this._overlapDebounceTimer = setTimeout(() => this._updateOverlapIndicators(), 200);
  }

  _updateOverlapIndicators() {
    const allWins = [...this.windows.values()].filter(w => !w.isMinimized && !(w._tabChain && w._tabChain.tabs[0] !== w.id));
    // Build rects for all visible windows
    const rects = new Map();
    for (const w of allWins) {
      const el = w.element;
      rects.set(w.id, { left: el.offsetLeft, top: el.offsetTop, right: el.offsetLeft + el.offsetWidth, bottom: el.offsetTop + el.offsetHeight });
    }
    for (const w of allWins) {
      const btn = w.element.querySelector('.win-overlap-btn');
      if (!btn) continue;
      const myRect = rects.get(w.id);
      let hasOverlap = false;
      for (const other of allWins) {
        if (other.id === w.id) continue;
        if (this._rectsOverlap(myRect, rects.get(other.id))) { hasOverlap = true; break; }
      }
      if (hasOverlap) {
        btn.classList.remove('no-overlap');
        btn.textContent = '\u29C9'; // ⧉ stacked windows
        btn.title = 'Show overlapping windows';
      } else {
        btn.classList.add('no-overlap');
        btn.textContent = '\u25A1'; // □ single window
        btn.title = 'No overlapping windows';
      }
    }
  }

  // ── Tab Grouping ──

  _syncChainBounds(chain) {
    const host = this.windows.get(chain.tabs[0]);
    if (!host) return;
    // Host bounds are canonical — copy to all guests
    for (let i = 1; i < chain.tabs.length; i++) {
      const guest = this.windows.get(chain.tabs[i]);
      if (guest) guest.gridBounds = host.gridBounds ? { ...host.gridBounds } : null;
    }
  }

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
        if (w._tabChain && w._tabChain.tabs[0] !== w.id) continue; // skip grouped guests
        const wIcon = w.iconSpan;
        if (!wIcon) continue;
        // For grouped windows, check tab items' icons too
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
      // Highlight drop target
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
        // Don't merge a window with itself or into a chain it's already in
        if (winInfo._tabChain && winInfo._tabChain === targetWin._tabChain) return;
        // Remove from existing chain first
        if (winInfo._tabChain) {
          this._detachFromChain(winInfo._tabChain, winInfo.id);
        }
        if (targetWin._tabChain) {
          this.addToTabChain(targetWin._tabChain, winInfo);
        } else {
          this.createTabChain(targetWin, winInfo);
        }
      }
      targetWin = null;
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  createTabChain(hostWin, guestWin) {
    const chain = { tabs: [hostWin.id, guestWin.id], active: 0 };
    hostWin._tabChain = chain;
    guestWin._tabChain = chain;

    // Move guest content into host element, hide guest element
    const guestContent = guestWin.content;
    guestContent.classList.add('tab-hidden');
    hostWin.element.appendChild(guestContent);
    guestWin.element.style.display = 'none';

    // Copy host bounds to guest
    guestWin.gridBounds = hostWin.gridBounds ? { ...hostWin.gridBounds } : null;

    this._renderTabBar(chain);
    this._notify();
  }

  addToTabChain(chain, guestWin) {
    chain.tabs.push(guestWin.id);
    guestWin._tabChain = chain;

    const hostWin = this.windows.get(chain.tabs[0]);
    if (!hostWin) return;

    // Move guest content into host element, hidden
    const guestContent = guestWin.content;
    guestContent.classList.add('tab-hidden');
    hostWin.element.appendChild(guestContent);
    guestWin.element.style.display = 'none';

    // Copy host bounds to guest
    guestWin.gridBounds = hostWin.gridBounds ? { ...hostWin.gridBounds } : null;

    this._renderTabBar(chain);
    // Switch to the newly added tab
    this.switchTab(chain, chain.tabs.length - 1);
    this._notify();
  }

  _renderTabBar(chain) {
    const hostWin = this.windows.get(chain.tabs[0]);
    if (!hostWin) return;
    const titleBar = hostWin.titleBar;

    // Remove existing tab bar if any
    const existing = titleBar.querySelector('.tab-bar-tabs');
    if (existing) existing.remove();
    // Also remove the standalone icon and title
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
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeFromTabChain(chain, tabWinId);
      });

      tab.append(icon, label, closeBtn);

      // Tab click = switch to that tab
      tab.addEventListener('mousedown', (e) => {
        if (e.target.closest('.tab-close')) return;
        e.stopPropagation();
        const idx = chain.tabs.indexOf(tabWinId);
        if (idx >= 0 && idx !== chain.active) this.switchTab(chain, idx);
      });

      // Tab drag-out: drag down >30px to pull out of group
      this._setupTabDrag(tab, tabWinId, chain);

      tabBar.appendChild(tab);
    }

    // Insert tab bar before controls
    const controls = titleBar.querySelector('.window-controls');
    titleBar.insertBefore(tabBar, controls);
  }

  switchTab(chain, index) {
    if (index < 0 || index >= chain.tabs.length) return;
    const hostWin = this.windows.get(chain.tabs[0]);
    if (!hostWin) return;

    // Hide current active content
    const prevId = chain.tabs[chain.active];
    const prevWin = this.windows.get(prevId);
    if (prevWin) prevWin.content.classList.add('tab-hidden');

    chain.active = index;
    const newId = chain.tabs[index];
    const newWin = this.windows.get(newId);
    if (newWin) newWin.content.classList.remove('tab-hidden');

    // Update tab bar active class
    const tabs = hostWin.titleBar.querySelectorAll('.tab-item');
    tabs.forEach((t, i) => t.classList.toggle('active', i === index));

    // Update activeWindowId to the visible tab
    this.activeWindowId = newId;

    // Fire onResize after content is visible (terminal fit needs non-zero dims)
    requestAnimationFrame(() => {
      if (newWin && newWin.onResize) newWin.onResize();
    });
    this._notify();
  }

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
        // Detach from chain — window gets its own element back
        detached = true;
        this._detachFromChain(chain, winId);
        // Position the detached window centered on cursor
        const win = this.windows.get(winId);
        if (!win) { mouseDown = false; return; }
        const w = parseInt(win.element.style.width) || 700;
        win.element.style.left = (e.clientX - w / 2) + 'px';
        win.element.style.top = (e.clientY - 15) + 'px';
        win.element.classList.add('dragging');
        if (this.grid) this.gridOverlay.classList.add('dragging');
      }
      if (detached) {
        // Follow cursor like a normal window drag
        const win = this.windows.get(winId);
        if (!win) return;
        const w = parseInt(win.element.style.width) || 700;
        win.element.style.left = (e.clientX - w / 2) + 'px';
        win.element.style.top = (e.clientY - 15) + 'px';
        // Show snap indicators
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
      // Apply snap if applicable
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
  }

  // Internal: detach a window from its chain without firing onClose
  _detachFromChain(chain, winId) {
    const idx = chain.tabs.indexOf(winId);
    if (idx < 0) return;
    const win = this.windows.get(winId);
    if (!win) return;
    const hostWin = this.windows.get(chain.tabs[0]);
    const isHost = idx === 0;

    if (isHost && chain.tabs.length > 1) {
      // Host is being removed — promote next tab to host
      const newHostId = chain.tabs[1];
      const newHost = this.windows.get(newHostId);
      if (!newHost) return;

      // Move all guest content divs from old host to new host element
      for (let i = 1; i < chain.tabs.length; i++) {
        const gw = this.windows.get(chain.tabs[i]);
        if (gw && gw.id !== winId) {
          hostWin.element.removeChild(gw.content);
          newHost.element.appendChild(gw.content);
        }
      }
      // Also move old host's own content back to itself (it's leaving)
      // win.content is still a child of win.element (host), so no move needed for it

      // Show the new host element at current host geometry
      newHost.element.style.left = hostWin.element.style.left;
      newHost.element.style.top = hostWin.element.style.top;
      newHost.element.style.width = hostWin.element.style.width;
      newHost.element.style.height = hostWin.element.style.height;
      newHost.element.style.zIndex = hostWin.element.style.zIndex;
      newHost.element.style.display = '';
      newHost.gridBounds = hostWin.gridBounds ? { ...hostWin.gridBounds } : null;
      newHost.isMaximized = hostWin.isMaximized;
      newHost.prevBounds = hostWin.prevBounds;

      // Put the departing host content back into its own element's content slot
      // (it's the first child after titlebar, so it's already there)

      // Remove the departing window from chain
      chain.tabs.splice(idx, 1);
      // Fix active index
      if (chain.active >= chain.tabs.length) chain.active = chain.tabs.length - 1;
      if (chain.active < 0) chain.active = 0;
    } else {
      // Guest is being removed (or last tab)
      // Move content back to own element
      if (hostWin && hostWin.element.contains(win.content)) {
        hostWin.element.removeChild(win.content);
        win.element.appendChild(win.content);
      }
      chain.tabs.splice(idx, 1);
      if (chain.active >= chain.tabs.length) chain.active = chain.tabs.length - 1;
      if (chain.active < 0) chain.active = 0;
    }

    // Show the detached window at current group geometry
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
    // Restore standalone title bar
    const standaloneIcon = win.titleBar.querySelector(':scope > .window-type-icon');
    if (standaloneIcon) standaloneIcon.style.display = '';
    win.titleSpan.style.display = '';
    const existingTabBar = win.titleBar.querySelector('.tab-bar-tabs');
    if (existingTabBar) existingTabBar.remove();

    if (chain.tabs.length <= 1) {
      this._ungroupLast(chain);
    } else {
      // Re-render tab bar on the current host
      const currentHost = this.windows.get(chain.tabs[0]);
      if (currentHost) {
        // Make sure active content is shown
        const activeWin = this.windows.get(chain.tabs[chain.active]);
        if (activeWin) activeWin.content.classList.remove('tab-hidden');
        this._renderTabBar(chain);
      }
    }

    // Fire onResize for detached window
    requestAnimationFrame(() => { if (win.onResize) win.onResize(); });
    this._notify();
  }

  removeFromTabChain(chain, winId) {
    const win = this.windows.get(winId);
    if (!win) return;

    this._detachFromChain(chain, winId);

    // Now close the actual window (fire onClose, remove element)
    if (win.onClose) win.onClose();
    win.element.remove();
    this.windows.delete(winId);
    this._notify(); this._scheduleOverlapUpdate();
  }

  _ungroupLast(chain) {
    if (chain.tabs.length !== 1) return;
    const lastId = chain.tabs[0];
    const lastWin = this.windows.get(lastId);
    if (!lastWin) return;

    lastWin._tabChain = null;
    lastWin.content.classList.remove('tab-hidden');

    // Restore normal title bar
    const standaloneIcon = lastWin.titleBar.querySelector(':scope > .window-type-icon');
    if (standaloneIcon) standaloneIcon.style.display = '';
    lastWin.titleSpan.style.display = '';
    const tabBar = lastWin.titleBar.querySelector('.tab-bar-tabs');
    if (tabBar) tabBar.remove();

    lastWin.element.style.display = '';
    requestAnimationFrame(() => { if (lastWin.onResize) lastWin.onResize(); });
  }

  // Rebuild a tab chain from saved state (used by layout restore)
  restoreTabChain(tabIds, activeIndex) {
    if (!tabIds || tabIds.length < 2) return;
    const hostWin = this.windows.get(tabIds[0]);
    if (!hostWin) return;

    // Create chain
    const chain = { tabs: [], active: activeIndex || 0 };
    chain.tabs.push(hostWin.id);
    hostWin._tabChain = chain;

    for (let i = 1; i < tabIds.length; i++) {
      const guestWin = this.windows.get(tabIds[i]);
      if (!guestWin) continue;
      chain.tabs.push(guestWin.id);
      guestWin._tabChain = chain;

      // Move guest content into host, hidden
      guestWin.content.classList.add('tab-hidden');
      hostWin.element.appendChild(guestWin.content);
      guestWin.element.style.display = 'none';

      // Copy host bounds
      guestWin.gridBounds = hostWin.gridBounds ? { ...hostWin.gridBounds } : null;
    }

    // Show active content
    const activeWin = this.windows.get(chain.tabs[chain.active]);
    if (activeWin) activeWin.content.classList.remove('tab-hidden');

    // Hide non-active host content if host is not active
    if (chain.active !== 0) {
      hostWin.content.classList.add('tab-hidden');
    }

    this._renderTabBar(chain);
  }

  _notify() { if (this.onWindowsChanged) this.onWindowsChanged(); }
}

export { WindowManager };
