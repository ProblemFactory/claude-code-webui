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
