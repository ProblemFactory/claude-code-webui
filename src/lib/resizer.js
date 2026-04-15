/**
 * Reusable drag-to-resize handle.
 *
 * @param {HTMLElement} target   The element whose size changes
 * @param {'horizontal'|'vertical'} dir  horizontal = width, vertical = height
 * @param {object} opts  { min, max, initial, storageKey, onResize, inside }
 *   inside: if true, handle is appended inside target (for position:fixed elements like sidebar)
 *           if false (default), handle is inserted as a sibling after target
 */
class Resizer {
  constructor(target, dir, opts = {}) {
    this.target = target;
    this.dir = dir;
    this.min = opts.min || 100;
    this.max = opts.max || 2000;
    this.liveResize = opts.liveResize !== false;
    this.onResize = opts.onResize || null;
    this.onResizeStart = opts.onResizeStart || null;
    this.onResizeEnd = opts.onResizeEnd || null;
    this.storageKey = opts.storageKey || null;
    this._inside = !!opts.inside;

    this.handle = document.createElement('div');
    this.handle.className = dir === 'horizontal' ? 'resizer-h' : 'resizer-v';

    if (opts.inside) {
      // Place handle inside target, positioned on its edge
      this.handle.style.position = 'absolute';
      if (dir === 'horizontal') {
        this.handle.style.right = '0'; this.handle.style.top = '0'; this.handle.style.bottom = '0';
        this.handle.style.width = '4px'; this.handle.style.zIndex = '10';
      } else {
        this.handle.style.left = '0'; this.handle.style.right = '0'; this.handle.style.bottom = '0';
        this.handle.style.height = '4px'; this.handle.style.zIndex = '10';
      }
      // Don't override existing position (e.g. position:fixed on sidebar)
      if (!target.style.position && getComputedStyle(target).position === 'static') {
        target.style.position = 'relative';
      }
      target.appendChild(this.handle);
    } else {
      target.parentNode.insertBefore(this.handle, target.nextSibling);
    }

    // Restore saved size
    const saved = this.storageKey ? parseInt(localStorage.getItem(this.storageKey)) : null;
    if (saved && saved >= this.min && saved <= this.max) {
      this._setSize(saved);
    } else if (opts.initial) {
      this._setSize(opts.initial);
    }

    // Drag logic
    this.handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const startPos = dir === 'horizontal' ? e.clientX : e.clientY;
      const startSize = dir === 'horizontal' ? target.offsetWidth : target.offsetHeight;
      let currentSize = startSize;

      this.handle.classList.add('active');
      document.body.style.cursor = dir === 'horizontal' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      if (this.onResizeStart) this.onResizeStart(startSize);

      const onMove = (e) => {
        const delta = (dir === 'horizontal' ? e.clientX : e.clientY) - startPos;
        const newSize = Math.max(this.min, Math.min(this.max, startSize + delta));
        currentSize = newSize;
        if (this.liveResize) this._setSize(newSize);
        if (this.onResize) this.onResize(newSize);
      };

      const onUp = () => {
        this.handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const finalSize = currentSize;
        if (!this.liveResize) this._setSize(finalSize);
        if (this.storageKey) localStorage.setItem(this.storageKey, finalSize);
        if (this.onResize) this.onResize(finalSize);
        if (this.onResizeEnd) this.onResizeEnd(finalSize);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  _setSize(px) {
    if (this.dir === 'horizontal') {
      this.target.style.width = px + 'px';
      if (!this._inside) { this.target.style.flexBasis = px + 'px'; this.target.style.flexShrink = '0'; this.target.style.flexGrow = '0'; }
    } else {
      this.target.style.height = px + 'px';
      if (!this._inside) { this.target.style.flexBasis = px + 'px'; this.target.style.flexShrink = '0'; this.target.style.flexGrow = '0'; }
    }
  }

  destroy() {
    this.handle.remove();
  }
}

export { Resizer };
