export function formatSize(b) { if(b<1024) return b+' B'; if(b<1048576) return (b/1024).toFixed(1)+' KB'; return (b/1048576).toFixed(1)+' MB'; }
export function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

export function attachPopoverClose(popover, ...excludeEls) {
  setTimeout(() => {
    const close = (e) => {
      if (popover.contains(e.target)) return;
      for (const el of excludeEls) { if (el?.contains(e.target)) return; }
      popover.remove();
      document.removeEventListener('mousedown', close);
    };
    document.addEventListener('mousedown', close);
  }, 0);
}

/**
 * Create a positioned popover, removing any existing one with the same class.
 * Returns the popover element for caller to populate.
 * @param {HTMLElement} anchor - element to position below
 * @param {string} className - CSS class (also used to remove duplicates)
 * @param {object} [opts] - { parent, position: 'below'|'cursor', x, y }
 */
export function createPopover(anchor, className, opts = {}) {
  document.querySelectorAll('.' + className.split(' ')[0]).forEach(p => p.remove());
  const pop = document.createElement('div');
  pop.className = className;
  pop.style.position = 'fixed';
  pop.style.zIndex = '99999';
  // Initial placement (off-screen to measure)
  pop.style.visibility = 'hidden';
  if (opts.position === 'cursor') {
    pop.style.left = (opts.x || 0) + 'px';
    pop.style.top = (opts.y || 0) + 'px';
  } else {
    const rect = anchor.getBoundingClientRect();
    pop.style.left = rect.left + 'px';
    pop.style.top = (rect.bottom + 2) + 'px';
  }
  (opts.parent || document.body).appendChild(pop);
  // Clamp to viewport after render so content is measured
  requestAnimationFrame(() => {
    const pr = pop.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    if (pr.right > vw) pop.style.left = Math.max(0, vw - pr.width - 4) + 'px';
    if (pr.bottom > vh) pop.style.top = Math.max(0, vh - pr.height - 4) + 'px';
    if (pr.left < 0) pop.style.left = '4px';
    if (pr.top < 0) pop.style.top = '4px';
    pop.style.visibility = '';
  });
  attachPopoverClose(pop, anchor);
  return pop;
}

/**
 * Show a context menu at cursor position.
 * @param {number} x
 * @param {number} y
 * @param {Array<{label: string, action: function, style?: string}>} items
 * @param {string} [className='context-menu']
 */
export function showContextMenu(x, y, items, className = 'context-menu') {
  // Remove existing menus of same class
  document.querySelectorAll('.' + className.split(' ')[0]).forEach(p => p.remove());
  const pop = document.createElement('div');
  pop.className = className;
  pop.style.position = 'fixed';
  pop.style.zIndex = '99999';
  pop.style.visibility = 'hidden';
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  document.body.appendChild(pop);
  attachPopoverClose(pop); // no anchor exclusion — any outside click closes
  for (const item of items) {
    if (item.separator) { const sep = document.createElement('div'); sep.className = className + '-separator'; pop.appendChild(sep); continue; }
    const el = document.createElement('div');
    el.className = className + '-item' + (item.disabled ? ' disabled' : '');
    if (item.style) el.style.cssText = item.style;
    if (item.children?.length) {
      // Submenu item: hover to expand
      el.textContent = item.label + ' \u25B8';
      el.style.position = 'relative';
      const sub = document.createElement('div');
      sub.className = className;
      sub.style.cssText = 'position:absolute;left:100%;top:-4px;display:none;z-index:99999';
      for (const child of item.children) {
        const ce = document.createElement('div');
        ce.className = className + '-item';
        ce.textContent = child.label;
        if (child.style) ce.style.cssText = child.style;
        ce.onclick = (e) => { e.stopPropagation(); pop.remove(); child.action(); };
        sub.appendChild(ce);
      }
      el.appendChild(sub);
      el.addEventListener('mouseenter', () => { sub.style.display = ''; });
      el.addEventListener('mouseleave', () => { sub.style.display = 'none'; });
    } else {
      el.textContent = item.label;
      if (item.disabled) { el.style.opacity = '0.4'; el.style.cursor = 'default'; }
      else el.onclick = () => { pop.remove(); item.action(); };
    }
    pop.appendChild(el);
  }
  // Keep menu on screen
  const mr = pop.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  if (mr.right > vw) pop.style.left = Math.max(0, vw - mr.width - 4) + 'px';
  if (mr.bottom > vh) pop.style.top = Math.max(0, vh - mr.height - 4) + 'px';
  if (mr.left < 0) pop.style.left = '4px';
  if (mr.top < 0) pop.style.top = '4px';
  pop.style.visibility = '';
  return pop;
}

/** Fetch JSON with silent error handling. Returns null on failure. */
export async function fetchJson(url, opts) {
  try {
    const res = await fetch(url, opts);
    return await res.json();
  } catch { return null; }
}

/** Clipboard copy with execCommand fallback for non-HTTPS */
export function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => _fallbackCopy(text));
  }
  _fallbackCopy(text);
  return Promise.resolve();
}
function _fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

// ── StateSync: unified versioned state sync with diff broadcast ──
// Each store tracks a version. On reconnect, requests missed ops from server.
// Components listen via events: stateSync.on('drafts', 'chat:sess-1', handler)
class StateSync {
  constructor(wsManager) {
    this.ws = wsManager;
    this.stores = {};    // name → { version, data, listeners }
    this._globalHandler = (msg) => {
      if (msg.type === 'state-sync') this._applyOp(msg.store, msg);
      else if (msg.type === 'state-snapshot') this._applySnapshot(msg.store, msg.data, msg.version);
    };
    wsManager.onGlobal(this._globalHandler);
    // On reconnect, request missed ops for all stores
    this._stateHandler = (connected) => {
      if (!connected) return;
      const versions = {};
      for (const [name, s] of Object.entries(this.stores)) versions[name] = s.version;
      if (Object.keys(versions).length) this.ws.send({ type: 'state-resync', versions });
    };
    wsManager.onStateChange(this._stateHandler);
  }

  // Load initial snapshot from server
  async init(storeName) {
    if (this.stores[storeName]) return;
    this.stores[storeName] = { version: 0, data: {}, listeners: new Map() };
    try {
      const res = await fetch(`/api/sync/${storeName}`);
      const snap = await res.json();
      this.stores[storeName].data = snap.data || {};
      this.stores[storeName].version = snap.version || 0;
    } catch {}
  }

  get(storeName, key) { return this.stores[storeName]?.data[key]; }
  getAll(storeName) { return this.stores[storeName]?.data || {}; }

  set(storeName, key, value) {
    const s = this.stores[storeName];
    if (!s) return;
    if (value == null || value === '') {
      delete s.data[key];
      this.ws.send({ type: 'state-set', store: storeName, key, value: '' });
    } else {
      s.data[key] = value;
      this.ws.send({ type: 'state-set', store: storeName, key, value });
    }
  }

  // Listen for changes to a specific key (or '*' for all keys in a store)
  on(storeName, key, handler) {
    const s = this.stores[storeName];
    if (!s) return;
    if (!s.listeners.has(key)) s.listeners.set(key, []);
    s.listeners.get(key).push(handler);
  }

  off(storeName, key, handler) {
    const arr = this.stores[storeName]?.listeners.get(key);
    if (arr) { const i = arr.indexOf(handler); if (i >= 0) arr.splice(i, 1); }
  }

  _applyOp(storeName, op) {
    const s = this.stores[storeName];
    if (!s) return;
    if (op.op === 'set') s.data[op.key] = op.value;
    else if (op.op === 'delete') delete s.data[op.key];
    if (op.version) s.version = op.version;
    this._notify(s, op.key, op.op === 'delete' ? '' : op.value);
  }

  _applySnapshot(storeName, data, version) {
    const s = this.stores[storeName];
    if (!s) return;
    const oldKeys = new Set(Object.keys(s.data));
    s.data = data || {};
    s.version = version || 0;
    // Notify for all changed keys
    for (const key of new Set([...oldKeys, ...Object.keys(s.data)])) {
      const oldVal = oldKeys.has(key) ? undefined : '';
      const newVal = s.data[key] || '';
      this._notify(s, key, newVal);
    }
  }

  _notify(s, key, value) {
    const specific = s.listeners.get(key);
    const wildcard = s.listeners.get('*');
    if (specific) for (const h of specific) h(value, key);
    if (wildcard) for (const h of wildcard) h(value, key);
  }
}

let _stateSync = null;

export function getStateSync() { return _stateSync; }

export async function initStateSync(wsManager) {
  _stateSync = new StateSync(wsManager);
  await _stateSync.init('drafts');
  await _stateSync.init('uploads');
  return _stateSync;
}

// Convenience wrappers for drafts (most common use case)
export function saveDraft(type, id, value) {
  _stateSync?.set('drafts', type + ':' + id, value);
}

export function loadDraft(type, id) {
  return _stateSync?.get('drafts', type + ':' + id) || '';
}

export function clearDraft(type, id) {
  saveDraft(type, id, '');
}
