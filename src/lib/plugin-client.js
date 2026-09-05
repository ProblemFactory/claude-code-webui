// PLUGIN CLIENT (Plugin Ph2 minimal 2.369.24; Ph4 trusted modules +
// contributed settings/themes 2.369.30 — docs/plugins.md, design §3).
// Fetches the server's validated manifests and, for every ENABLED plugin:
//   • iframe tier: `contributes.windows[]` → registered WINDOW TYPES (Ph1
//     registry); the window is a sandboxed iframe (opaque origin — the same
//     posture as published pages; never allow-same-origin) served from
//     /plugins/<id>/<entry>, plus the postMessage bridge (api version 1):
//       iframe → host : { vsp:'ready' }                          host → { vsp:'init', pluginId, windowId, api:1, dark }
//       iframe → host : { vsp:'storage', op:'get'|'set'|'del', k, v }   host → { vsp:'storage', k, v|null }   (localStorage, namespaced vsp_<id>_)
//       iframe → host : { vsp:'notify', text }                   host shows a toast (text only — never HTML)
//       iframe → host : { vsp:'close' }                          host closes the window
//   • module tier (TRUSTED, owner consent recorded server-side): the entry is
//     `import()`ed SAME-ORIGIN and `activate(api)` is called with the HOST API
//     below; `deactivate()` (if exported) + an AbortController run on disable.
//     A module that throws at import/activate never breaks boot: toast +
//     `errors` entry the Plugins panel shows. The server serves the entry only
//     while the registry says trusted, so an untrusted manifest cannot reach here.
//   • contributes.settings → registerPluginSettings (Settings window category
//     "Plugin: <label>", keys plugin.<id>.<key>); contributes.themes → fetched
//     JSON → ThemeManager.registerPluginTheme('plugin-<id>-<themeId>').
//     Both are torn down on disable / uninstall.
// Multi-client: `plugins-manifests-updated` re-applies (new kinds register,
// disabled ones tear down).
//
// HOST API handed to a trusted module's activate(api) — keep it SMALL and
// document every addition here (docs/plugins.md mirrors this list):
//   api.id / api.version / api.manifest / api.signal (aborts on deactivate)
//   api.registerWindowType({ id, label, icon?, render(winInfo) })  → window type `plugin:<id>:<wid>`
//   api.openWindow(wid)                                          → opens one of its own types
//   api.showToast(text, { type? })    api.createModalShell(opts)  api.t(str, params)
//   api.fetch(path, opts)             → ONLY /api/plugins/<id>/x/* (its own server process)
//   api.settings.get(key) / .set(key, value) / .path(key) / .onChange(fn)   (plugin.<id>.<key>)
//   api.storage.get/set/del(k)         (localStorage, vsp_<id>_ namespace — shared with its iframes)
//   api.on('theme-changed' | 'plugins-manifests-updated' | 'ws', fn)        → unsubscribe()
//   api.registerCommand({ id: slug, title, run(ctx), when?(ctx), icon? })   → command id `plugin:<id>:<slug>` (Ph1 registry)
//   api.registerMenuItem({ menu: 'session-card'|'window'|'gear'|…, command | label+run, group?, order?, when?(ctx), … })
//                                      → item id `plugin:<id>:…`; `command` = own slug or a full id ('session.properties')
//   api.registerKeybinding({ key: 'ctrl+shift+k', command, when?(ctx) })   → last registered wins; never inside .xterm
//   api.runCommand(id, ctx)            → run any registered command (own slug or full id)
//   Every Ph1 contribution is bound to api.signal — it leaves with the plugin (disable / uninstall / reload).
//   api.app                            → the App mediator (it IS trusted code; the same access as VibeSpace itself)
import { registerWindowType, svgIcon16 } from './window-types.js';
import { registerCommand, registerMenuItem, registerKeybinding, runCommand } from './contributions.js';
import { fetchJson, showToast, createModalShell } from './utils.js';
import { registerPluginSettings, unregisterPluginSettings, pluginSettingPath } from './settings-schema.js';
import { t } from './i18n.js';

export const PLUGIN_ICON = svgIcon16('<path d="M6 2h4v2.5a1.5 1.5 0 0 0 3 0V2h1v4h-2.5a1.5 1.5 0 0 0 0 3H14v5H9v-2.5a1.5 1.5 0 0 0-3 0V14H2V9h2.5a1.5 1.5 0 0 0 0-3H2V2h4z"/>');
const IFRAME_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';
export const pluginThemeKey = (pluginId, themeId) => `plugin-${pluginId}-${themeId}`;

export class PluginClient {
  constructor(app) {
    this.app = app;
    this.manifests = [];
    this._registered = new Set();
    this._modules = new Map();   // pluginId → { mod, ctl, version }
    this._settings = new Set();  // pluginIds with registered settings
    this._themes = new Map();    // pluginId → Set<themeKey>
    this.errors = new Map();     // pluginId → last client-side load error (panel shows it)
    this._applying = null;
    app.ws?.onGlobal?.((m) => { if (m?.type === 'plugins-manifests-updated') this.apply(m.plugins); });
    this.refresh();
  }

  async refresh() {
    const r = await fetchJson('/api/plugins/manifests');
    if (!r || r.error) return;
    await this.apply(r.plugins || []);
  }

  /** Idempotent: registers what is enabled, tears down what is not. Serialized so
   *  a burst of broadcasts cannot interleave activate/deactivate of one plugin. */
  apply(list) {
    this.manifests = Array.isArray(list) ? list : [];
    const run = async () => {
      for (const w of this.contributedWindows()) this._register(w);
      const live = new Set();
      for (const m of this.manifests) {
        if (!m?.enabled || !m.valid) continue;
        live.add(m.id);
        this._applySettings(m);
        await this._applyThemes(m);
        await this._applyModule(m);
      }
      for (const id of [...this._settings]) if (!live.has(id)) this._dropSettings(id);
      for (const id of [...this._themes.keys()]) if (!live.has(id)) this._dropThemes(id);
      for (const id of [...this._modules.keys()]) if (!live.has(id)) await this._deactivate(id);
    };
    this._applying = (this._applying || Promise.resolve()).then(run, run).catch((e) => console.error('[plugins] apply failed:', e));
    return this._applying;
  }

  /** Every window an ENABLED iframe-tier plugin contributes. */
  contributedWindows() {
    const out = [];
    for (const m of this.manifests) {
      if (!m?.enabled || !m.valid || m.client !== 'iframe') continue;
      for (const w of m.contributes?.windows || []) out.push({ pluginId: m.id, windowId: w.id, title: w.title, entry: w.entry, icon: m.icon || null, type: `plugin:${m.id}:${w.id}`, action: `openPlugin:${m.id}:${w.id}` });
    }
    return out;
  }

  _register(w) {
    if (this._registered.has(w.type)) return;
    this._registered.add(w.type);
    registerWindowType({
      type: w.type, label: w.title, icon: PLUGIN_ICON, persist: true,
      action: w.action,
      replay: (app, spec, { syncId } = {}) => this.open(spec.pluginId || w.pluginId, spec.windowId || w.windowId, { syncId }),
    });
  }

  // ── contributed settings ──
  _applySettings(m) {
    const items = m.contributes?.settings || [];
    if (!items.length) { this._dropSettings(m.id); return; }
    registerPluginSettings(m.id, m.label || m.id, items);
    this._settings.add(m.id);
  }
  _dropSettings(id) { if (this._settings.delete(id)) unregisterPluginSettings(id); }

  // ── contributed themes ──
  async _applyThemes(m) {
    const tm = this.app.themeManager;
    const want = (m.contributes?.themes || []).filter((th) => th.ok !== false);
    const have = this._themes.get(m.id) || new Set();
    const next = new Set();
    for (const th of want) {
      const key = pluginThemeKey(m.id, th.id);
      next.add(key);
      if (have.has(key) && this._themeVersion?.get(key) === m.version) continue;
      try {
        const r = await fetch(`/plugins/${encodeURIComponent(m.id)}/${th.file}`, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json();
        tm?.registerPluginTheme?.(key, `${th.label} (plugin)`, json.css || {}, json.terminal || null);
        (this._themeVersion ||= new Map()).set(key, m.version);
      } catch (e) { console.warn(`[plugins] theme ${key}: ${e.message}`); }
    }
    for (const key of have) if (!next.has(key)) tm?.unregisterPluginTheme?.(key);
    if (next.size) this._themes.set(m.id, next); else this._themes.delete(m.id);
    if (next.size || have.size) this.app._refreshThemeDropdown?.();
  }
  _dropThemes(id) {
    const keys = this._themes.get(id);
    if (!keys) return;
    for (const key of keys) this.app.themeManager?.unregisterPluginTheme?.(key);
    this._themes.delete(id);
    this.app._refreshThemeDropdown?.();
  }

  // ── trusted client modules ──
  async _applyModule(m) {
    if (m.client !== 'module') return;
    const cur = this._modules.get(m.id);
    if (!m.trusted) { if (cur) await this._deactivate(m.id); return; } // the server serves the entry only while trusted — mirror it here
    if (cur && cur.version === m.version) return;
    if (cur) await this._deactivate(m.id);
    const ctl = new AbortController();
    const url = `/plugins/${encodeURIComponent(m.id)}/${m.clientEntry || 'client.js'}?v=${encodeURIComponent(m.version || '0')}`;
    try {
      const mod = await import(/* @vite-ignore */ url);
      const api = this._hostApi(m, ctl);
      if (typeof mod.activate === 'function') await mod.activate(api);
      this._modules.set(m.id, { mod, ctl, version: m.version, api });
      this.errors.delete(m.id);
    } catch (e) {
      ctl.abort();
      const msg = String(e?.message || e).slice(0, 300);
      this.errors.set(m.id, msg);
      console.error(`[plugins] ${m.id}: client module failed:`, e);
      showToast(t('Plugin {id} failed to load: {error}', { id: m.id, error: msg }), { type: 'error' });
    }
  }
  async _deactivate(id) {
    const cur = this._modules.get(id);
    if (!cur) return;
    this._modules.delete(id);
    try { if (typeof cur.mod?.deactivate === 'function') await cur.mod.deactivate(); } catch (e) { console.warn(`[plugins] ${id}: deactivate threw:`, e); }
    cur.ctl.abort();
  }
  _hostApi(m, ctl) {
    const app = this.app, id = m.id;
    const storagePrefix = `vsp_${id}_`;
    const settingsChanged = new Set();
    // a bare slug names the plugin's OWN command; a full id (has '.' or ':' —
    // 'session.properties', 'plugin:other.id:x') is used as given
    const pluginCommandId = (c) => {
      if (typeof c !== 'string' || !c) throw new Error('command id required');
      return /[.:]/.test(c) ? c : `plugin:${id}:${c}`;
    };
    let pluginItemSeq = 0;
    const api = {
      id, version: m.version, manifest: m, signal: ctl.signal, app,
      t,
      showToast: (text, opts) => showToast(String(text ?? '').slice(0, 300), opts),
      createModalShell: (opts) => createModalShell({ ...opts, id: `plugin-${id}-${opts?.id || 'dialog'}` }),
      registerWindowType: ({ id: wid, label, icon, render, persist = true } = {}) => {
        if (typeof wid !== 'string' || !/^[a-z0-9-]+$/.test(wid) || typeof render !== 'function') throw new Error('api.registerWindowType expects { id: slug, label, render(winInfo) }');
        const type = `plugin:${id}:${wid}`, action = `openPlugin:${id}:${wid}`;
        if (!this._registered.has(type)) {
          this._registered.add(type);
          registerWindowType({ type, label: String(label || wid), icon: icon || PLUGIN_ICON, persist, action, replay: (a, spec, { syncId } = {}) => api.openWindow(wid, { syncId }) });
        }
        (this._moduleWindows ||= new Map()).set(type, { render, label: String(label || wid) });
        return type;
      },
      openWindow: (wid, { syncId } = {}) => {
        const type = `plugin:${id}:${wid}`;
        const def = this._moduleWindows?.get(type);
        if (!def) { showToast(t('Plugin window not available: {id}', { id: `${id}/${wid}` }), { type: 'error' }); return null; }
        app._hideWelcome?.();
        const winInfo = app.wm.createWindow({ title: def.label, type, syncId, openSpec: { action: `openPlugin:${id}:${wid}`, pluginId: id, windowId: wid } });
        try { def.render(winInfo); } catch (e) { showToast(t('Plugin {id} failed to load: {error}', { id, error: String(e?.message || e).slice(0, 200) }), { type: 'error' }); }
        return winInfo;
      },
      fetch: (p, opts) => {
        const rel = String(p || '');
        if (!rel.startsWith('/')) throw new Error('api.fetch: path must start with /');
        return fetch(`/api/plugins/${encodeURIComponent(id)}/x${rel}`, opts);
      },
      // ── Ph1 contribution registries (contributions.js), scoped to this
      //    plugin: ids are namespaced `plugin:<id>:<slug>`, every registration
      //    rides ctl.signal so it is removed on deactivate ──
      registerCommand: ({ id: slug, title, run, when, icon } = {}) => {
        if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) throw new Error('api.registerCommand expects { id: slug ([a-z0-9-]), title, run(ctx) }');
        return registerCommand({ id: `plugin:${id}:${slug}`, title, run, when, icon, signal: ctl.signal });
      },
      registerMenuItem: (spec = {}) => {
        if (!spec || typeof spec !== 'object') throw new Error('api.registerMenuItem expects a spec object');
        const command = spec.command === undefined ? undefined : pluginCommandId(spec.command);
        const itemId = `plugin:${id}:${spec.id || spec.command || 'item-' + (++pluginItemSeq)}`;
        return registerMenuItem({ ...spec, command, id: itemId, signal: ctl.signal });
      },
      registerKeybinding: ({ key, command, when, inTerminal } = {}) => registerKeybinding({ key, command: pluginCommandId(command), when, inTerminal, signal: ctl.signal }),
      runCommand: (cid, ctx) => runCommand(pluginCommandId(cid), ctx),
      settings: {
        path: (key) => pluginSettingPath(id, key),
        get: (key) => app.settings?.get(pluginSettingPath(id, key)),
        set: (key, value) => app.settings?.set(pluginSettingPath(id, key), value),
        // SettingsManager listens PER PATH (settings.js on(path, cb)) — subscribe every declared key
        onChange: (fn) => {
          const subs = (m.contributes?.settings || []).map((s) => { const p = pluginSettingPath(id, s.key); const h = (v) => fn(s.key, v); app.settings?.on?.(p, h); return () => app.settings?.off?.(p, h); });
          const off = () => { for (const u of subs) u(); };
          settingsChanged.add(off); ctl.signal.addEventListener('abort', off);
          return off;
        },
      },
      storage: {
        get: (k) => { try { return localStorage.getItem(storagePrefix + String(k)); } catch { return null; } },
        set: (k, v) => { try { localStorage.setItem(storagePrefix + String(k), String(v ?? '')); } catch { } },
        del: (k) => { try { localStorage.removeItem(storagePrefix + String(k)); } catch { } },
      },
      on: (event, fn) => {
        if (event === 'theme-changed') {
          const mo = new MutationObserver(() => fn(document.documentElement.getAttribute('data-theme')));
          mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
          ctl.signal.addEventListener('abort', () => mo.disconnect());
          return () => mo.disconnect();
        }
        if (event === 'plugins-manifests-updated' || event === 'ws') {
          const h = (msg) => { if (ctl.signal.aborted) return; if (event === 'ws' || msg?.type === 'plugins-manifests-updated') fn(msg); };
          const off = app.ws?.onGlobal?.(h);
          const un = () => { try { if (typeof off === 'function') off(); else app.ws?.offGlobal?.(h); } catch { } };
          ctl.signal.addEventListener('abort', un);
          return un;
        }
        throw new Error(`api.on: unknown event "${event}" (theme-changed | plugins-manifests-updated | ws)`);
      },
    };
    return api;
  }

  open(pluginId, windowId, { syncId } = {}) {
    const type = `plugin:${pluginId}:${windowId}`;
    const modDef = this._moduleWindows?.get(type);
    if (modDef) return this._modules.get(pluginId)?.api?.openWindow(windowId, { syncId }) || null;
    const w = this.contributedWindows().find((x) => x.pluginId === pluginId && x.windowId === windowId);
    if (!w) { showToast(t('Plugin window not available: {id}', { id: `${pluginId}/${windowId}` }), { type: 'error' }); return null; }
    const app = this.app;
    app._hideWelcome?.();
    const openSpec = { action: w.action, pluginId, windowId };
    const winInfo = app.wm.createWindow({ title: w.title, type: w.type, syncId, openSpec });
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', IFRAME_SANDBOX);
    iframe.setAttribute('title', w.title);
    iframe.style.cssText = 'flex:1;border:none;width:100%;height:100%;background:var(--bg)';
    iframe.src = `/plugins/${encodeURIComponent(pluginId)}/${w.entry}`;
    const prefix = `vsp_${pluginId}_`;
    const onMessage = (e) => {
      if (e.source !== iframe.contentWindow || !e.data || typeof e.data !== 'object') return;
      const d = e.data;
      const reply = (msg) => { try { iframe.contentWindow.postMessage(msg, '*'); } catch { } }; // opaque origin ⇒ '*' is the only addressable target; payloads carry nothing sensitive
      if (d.vsp === 'ready') reply({ vsp: 'init', pluginId, windowId, api: 1, dark: !/light/i.test(document.documentElement.getAttribute('data-theme') || '') });
      else if (d.vsp === 'storage') {
        const k = prefix + String(d.k || '');
        try {
          if (d.op === 'set') localStorage.setItem(k, String(d.v ?? ''));
          else if (d.op === 'del') localStorage.removeItem(k);
          reply({ vsp: 'storage', k: String(d.k || ''), v: localStorage.getItem(k) });
        } catch { reply({ vsp: 'storage', k: String(d.k || ''), v: null }); }
      } else if (d.vsp === 'notify') showToast(String(d.text || '').slice(0, 300), { type: ['error', 'warn', 'success'].includes(d.kind) ? d.kind : 'info' });
      else if (d.vsp === 'close') app.wm?.closeWindow?.(winInfo.id);
    };
    window.addEventListener('message', onMessage, winInfo._listenerCtl?.signal ? { signal: winInfo._listenerCtl.signal } : undefined);
    if (!winInfo._listenerCtl) { const prevClose = winInfo.onClose; winInfo.onClose = () => { window.removeEventListener('message', onMessage); prevClose?.(); }; }
    (winInfo.content || winInfo.body || winInfo.el?.querySelector('.window-content'))?.append(iframe);
    return winInfo;
  }
}

export function installPluginClient(app) {
  app.pluginClient = new PluginClient(app);
  return app.pluginClient;
}
