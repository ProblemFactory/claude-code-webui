import { SETTINGS_SCHEMA } from './settings-schema.js';

/**
 * SettingsManager — centralized settings with server persistence and live change events.
 *
 * Only non-default values are stored (sparse). get() falls back to schema defaults.
 * Changes are debounce-saved to server and broadcast to other clients via WebSocket.
 */
class SettingsManager {
  constructor() {
    this._values = {};       // sparse: only overrides
    this._listeners = {};    // path → Set<callback>
    this._saveTimer = null;
    this._loaded = false;
  }

  /** Load settings from server, fall back to localStorage. Returns a promise. */
  async load() {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        this._values = await res.json();
      } else {
        this._loadFromLocalStorage();
      }
    } catch {
      this._loadFromLocalStorage();
    }
    this._loaded = true;
  }

  _loadFromLocalStorage() {
    try {
      const stored = localStorage.getItem('webui-settings');
      if (stored) this._values = JSON.parse(stored);
    } catch {}
  }

  /** Get a setting value. Returns the stored override or the schema default. */
  get(path) {
    if (path in this._values) return this._values[path];
    const schema = SETTINGS_SCHEMA[path];
    if (schema) return schema.default;
    return undefined;
  }

  /** Set a setting value. Pass undefined to reset to default. */
  set(path, value) {
    const schema = SETTINGS_SCHEMA[path];
    if (!schema) return;

    const old = this.get(path);

    // If value equals default, remove the override (sparse storage)
    if (value === undefined || JSON.stringify(value) === JSON.stringify(schema.default)) {
      delete this._values[path];
    } else {
      this._values[path] = value;
    }

    const now = this.get(path);
    if (JSON.stringify(old) !== JSON.stringify(now)) {
      this._notify(path, now, old);
    }
    this._scheduleSave();
  }

  /** Reset a single setting to its default. */
  reset(path) {
    this.set(path, undefined);
  }

  /** Reset all settings to defaults. */
  resetAll() {
    const oldValues = { ...this._values };
    this._values = {};
    // Notify all previously overridden settings
    for (const path of Object.keys(oldValues)) {
      const schema = SETTINGS_SCHEMA[path];
      if (schema) this._notify(path, schema.default, oldValues[path]);
    }
    this._scheduleSave();
  }

  /** Check if a setting has been modified from its default. */
  isModified(path) {
    return path in this._values;
  }

  /** Subscribe to changes on a specific setting path. */
  on(path, callback) {
    if (!this._listeners[path]) this._listeners[path] = new Set();
    this._listeners[path].add(callback);
  }

  /** Unsubscribe from changes. */
  off(path, callback) {
    if (this._listeners[path]) this._listeners[path].delete(callback);
  }

  /** Apply state from server (WebSocket broadcast). */
  applyRemote(data) {
    const old = { ...this._values };
    this._values = data;
    // localStorage backup
    try { localStorage.setItem('webui-settings', JSON.stringify(this._values)); } catch {}
    // Notify changed paths
    const allPaths = new Set([...Object.keys(old), ...Object.keys(data)]);
    for (const path of allPaths) {
      const oldVal = path in old ? old[path] : SETTINGS_SCHEMA[path]?.default;
      const newVal = this.get(path);
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        this._notify(path, newVal, oldVal);
      }
    }
  }

  /** Get all non-default values (for persistence). */
  toJSON() {
    return { ...this._values };
  }

  /** Export all settings as merged (defaults + overrides) for display. */
  getAll() {
    const result = {};
    for (const [path, schema] of Object.entries(SETTINGS_SCHEMA)) {
      result[path] = this.get(path);
    }
    return result;
  }

  _notify(path, newVal, oldVal) {
    const listeners = this._listeners[path];
    if (listeners) {
      for (const cb of listeners) {
        try { cb(newVal, oldVal); } catch (e) { console.error(`Settings listener error [${path}]:`, e); }
      }
    }
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 500);
  }

  async _save() {
    const data = this.toJSON();
    // Always write to localStorage as backup
    try { localStorage.setItem('webui-settings', JSON.stringify(data)); } catch {}
    // Write to server
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch {}
  }
}

export { SettingsManager };
