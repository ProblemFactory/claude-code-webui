/**
 * SyncStore — unified versioned state sync with diff broadcast.
 *
 * Each store tracks ops with monotonic versions. On reconnect, clients request
 * ops since their last version to avoid full-state reload.
 * Future multi-user ready via optional namespace prefix on keys.
 */

const fs = require('fs');
const path = require('path');

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

class SyncStore {
  /**
   * @param {string} name - Store name (e.g. 'drafts', 'settings')
   * @param {string} filePath - Path to backing JSON file
   * @param {object} wss - WebSocketServer instance for broadcasting
   * @param {object} [opts]
   * @param {number} [opts.saveDelay=2000] - Debounce delay for disk persistence
   * @param {number} [opts.maxOps=500] - Max ops in ring buffer
   */
  constructor(name, filePath, wss, { saveDelay = 2000, maxOps = 500 } = {}) {
    this.name = name;
    this.filePath = filePath;
    this.wss = wss;
    this.saveDelay = saveDelay;
    this.maxOps = maxOps;
    this.version = 0;
    this.ops = []; // ring buffer: [{version, op:'set'|'delete', key, value?}]
    this.data = {};
    this._saveTimer = null;
    this._load();
  }

  _load() {
    ensureDir(path.dirname(this.filePath));
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      this.data = raw.data || {};
      this.version = raw.version || 0;
    } catch { this.data = {}; this.version = 0; }
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try { fs.writeFileSync(this.filePath, JSON.stringify({ version: this.version, data: this.data }, null, 2)); } catch {}
    }, this.saveDelay);
  }

  _pushOp(op) {
    this.ops.push(op);
    if (this.ops.length > this.maxOps) this.ops = this.ops.slice(-this.maxOps);
  }

  set(key, value, senderWs) {
    this.version++;
    this.data[key] = value;
    const op = { version: this.version, op: 'set', key, value };
    this._pushOp(op);
    this._scheduleSave();
    this._broadcast(op, senderWs);
  }

  delete(key, senderWs) {
    if (!(key in this.data)) return;
    this.version++;
    delete this.data[key];
    const op = { version: this.version, op: 'delete', key };
    this._pushOp(op);
    this._scheduleSave();
    this._broadcast(op, senderWs);
  }

  get(key) { return this.data[key]; }
  getAll() { return this.data; }
  getSnapshot() { return { version: this.version, data: { ...this.data } }; }

  getOpsSince(sinceVersion) {
    if (sinceVersion >= this.version) return { ops: [], version: this.version };
    const idx = this.ops.findIndex(o => o.version > sinceVersion);
    if (idx >= 0 && this.ops[idx].version === sinceVersion + 1) {
      return { ops: this.ops.slice(idx), version: this.version };
    }
    return { full: this.data, version: this.version };
  }

  _broadcast(op, senderWs) {
    const msg = JSON.stringify({ type: 'state-sync', store: this.name, ...op });
    this.wss.clients.forEach(client => {
      if (client !== senderWs && client.readyState === 1) { try { client.send(msg); } catch {} }
    });
  }
}

module.exports = { SyncStore };
