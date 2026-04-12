/**
 * Persistence API routes — layouts, bookmarks, custom themes, user state,
 * settings, session groups. All are file-backed JSON stores with WS broadcast.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const router = express.Router();

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

/** Setup persistence routes. Requires { dataDir, wss, WS_OPEN, getSyncStore } context. */
function setup({ dataDir, wss, WS_OPEN, getSyncStore }) {
  const broadcast = (msg) => {
    const json = JSON.stringify(msg);
    wss.clients.forEach(client => {
      if (client.readyState === WS_OPEN) { try { client.send(json); } catch {} }
    });
  };

  // ── Layout/Preset Persistence (cached in memory) ──
  const LAYOUTS_FILE = path.join(dataDir, 'layouts.json');
  let _layoutsCache = null;

  function readLayouts() {
    if (_layoutsCache) return _layoutsCache;
    ensureDir(dataDir);
    try { _layoutsCache = JSON.parse(fs.readFileSync(LAYOUTS_FILE, 'utf-8')); }
    catch { _layoutsCache = { current: null, autoSave: null, saved: {}, customGrids: [] }; }
    return _layoutsCache;
  }

  function writeLayouts(data) {
    ensureDir(dataDir);
    _layoutsCache = data;
    fs.writeFileSync(LAYOUTS_FILE, JSON.stringify(data, null, 2));
  }

  router.get('/api/layouts', (req, res) => res.json(readLayouts()));

  router.post('/api/layouts/:name', (req, res) => {
    const data = readLayouts();
    data.saved[req.params.name] = { ...req.body, updatedAt: Date.now() };
    writeLayouts(data);
    res.json({ success: true });
  });

  router.delete('/api/layouts/:name', (req, res) => {
    const data = readLayouts();
    delete data.saved[req.params.name];
    if (data.current === req.params.name) data.current = null;
    writeLayouts(data);
    res.json({ success: true });
  });

  router.post('/api/layouts-active', (req, res) => {
    const data = readLayouts();
    data.current = req.body.name || null;
    writeLayouts(data);
    res.json({ success: true });
  });

  router.post('/api/custom-grids', (req, res) => {
    const { rows, cols } = req.body;
    if (!rows || !cols) return res.status(400).json({ error: 'rows and cols required' });
    const data = readLayouts();
    if (!data.customGrids) data.customGrids = [];
    if (!data.customGrids.some(g => g.rows === rows && g.cols === cols)) {
      data.customGrids.push({ rows, cols });
      writeLayouts(data);
    }
    res.json({ success: true, customGrids: data.customGrids });
  });

  router.delete('/api/custom-grids', (req, res) => {
    const { rows, cols } = req.body;
    const data = readLayouts();
    if (!data.customGrids) data.customGrids = [];
    data.customGrids = data.customGrids.filter(g => !(g.rows === rows && g.cols === cols));
    writeLayouts(data);
    res.json({ success: true, customGrids: data.customGrids });
  });

  router.post('/api/layouts-autosave', (req, res) => {
    const data = readLayouts();
    const deviceType = req.body.deviceType || 'desktop';
    if (deviceType === 'mobile') {
      data.autoSaveMobile = { ...req.body, updatedAt: Date.now() };
    } else {
      data.autoSave = { ...req.body, updatedAt: Date.now() };
    }
    writeLayouts(data);
    res.json({ success: true });
  });

  // Expose for server.js to use directly
  router.readLayouts = readLayouts;
  router.writeLayouts = writeLayouts;

  // ── Bookmarks ──
  const BOOKMARKS_FILE = path.join(dataDir, 'bookmarks.json');
  function readBookmarks() {
    ensureDir(dataDir);
    try { return JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf-8')); }
    catch {
      const home = os.homedir();
      return [
        { label: 'Home', path: home },
        { label: 'Desktop', path: path.join(home, 'Desktop') },
        { label: 'Downloads', path: path.join(home, 'Downloads') },
        { label: 'Documents', path: path.join(home, 'Documents') },
      ];
    }
  }
  function writeBookmarks(data) {
    ensureDir(dataDir);
    fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(data, null, 2));
  }

  router.get('/api/bookmarks', (req, res) => res.json(readBookmarks()));

  router.post('/api/bookmarks', (req, res) => {
    const bookmarks = req.body;
    if (!Array.isArray(bookmarks)) return res.status(400).json({ error: 'Expected array' });
    writeBookmarks(bookmarks);
    broadcast({ type: 'bookmarks-updated', bookmarks });
    res.json({ success: true });
  });

  // ── Custom Themes ──
  const CUSTOM_THEMES_FILE = path.join(dataDir, 'custom-themes.json');
  let _customThemesCache = null;

  function readCustomThemes() {
    if (_customThemesCache) return _customThemesCache;
    try { _customThemesCache = JSON.parse(fs.readFileSync(CUSTOM_THEMES_FILE, 'utf-8')); }
    catch { _customThemesCache = {}; }
    return _customThemesCache;
  }

  function writeCustomThemes(data) {
    _customThemesCache = data;
    fs.writeFileSync(CUSTOM_THEMES_FILE, JSON.stringify(data, null, 2));
    broadcast({ type: 'custom-themes-updated', themes: data });
  }

  router.get('/api/custom-themes', (req, res) => res.json(readCustomThemes()));

  router.post('/api/custom-themes', (req, res) => {
    const { name, css, terminal } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
    if (!css || typeof css !== 'object') return res.status(400).json({ error: 'css object required' });
    if (name.length > 50) return res.status(400).json({ error: 'Name too long (max 50)' });
    if (!/^[a-zA-Z0-9 _-]+$/.test(name)) return res.status(400).json({ error: 'Name must be alphanumeric' });
    const builtIn = ['dark', 'light', 'dracula', 'nord', 'solarized', 'monokai'];
    if (builtIn.includes(name.toLowerCase())) return res.status(400).json({ error: 'Cannot overwrite built-in theme' });
    if (JSON.stringify(req.body).length > 100000) return res.status(413).json({ error: 'Theme data too large' });
    const data = readCustomThemes();
    data[name] = { css, terminal: terminal || {} };
    writeCustomThemes(data);
    res.json({ success: true });
  });

  router.delete('/api/custom-themes/:name', (req, res) => {
    const data = readCustomThemes();
    if (!data[req.params.name]) return res.status(404).json({ error: 'Theme not found' });
    delete data[req.params.name];
    writeCustomThemes(data);
    res.json({ success: true });
  });

  // ── Sync Store snapshots ──
  router.get('/api/sync/:store', (req, res) => {
    const store = getSyncStore(req.params.store);
    if (!store) return res.status(404).json({ error: 'Unknown store' });
    res.json(store.getSnapshot());
  });

  // ── User State ──
  const USER_STATE_FILE = path.join(dataDir, 'user-state.json');
  let _userStateCache = null;
  const USER_STATE_DEFAULT = { starredSessions: [], archivedSessions: [], customNames: {}, sessionGroups: {} };

  function readUserState() {
    if (_userStateCache) return _userStateCache;
    ensureDir(dataDir);
    try { _userStateCache = JSON.parse(fs.readFileSync(USER_STATE_FILE, 'utf-8')); }
    catch { _userStateCache = { ...USER_STATE_DEFAULT }; }
    return _userStateCache;
  }

  function writeUserState(data) {
    ensureDir(dataDir);
    _userStateCache = data;
    fs.writeFileSync(USER_STATE_FILE, JSON.stringify(data, null, 2));
    broadcast({ type: 'user-state-updated', state: data });
  }

  router.get('/api/user-state', (req, res) => res.json(readUserState()));

  router.post('/api/user-state', (req, res) => {
    const data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Expected object' });
    writeUserState(data);
    res.json({ success: true });
  });

  // ── Settings ──
  const SETTINGS_FILE = path.join(dataDir, 'settings.json');
  let _settingsCache = null;

  function readSettings() {
    if (_settingsCache) return _settingsCache;
    ensureDir(dataDir);
    try { _settingsCache = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')); }
    catch { _settingsCache = {}; }
    return _settingsCache;
  }

  function writeSettings(data) {
    ensureDir(dataDir);
    _settingsCache = data;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
    broadcast({ type: 'settings-updated', settings: data });
  }

  router.get('/api/settings', (req, res) => res.json(readSettings()));

  router.post('/api/settings', (req, res) => {
    const data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Expected object' });
    writeSettings(data);
    res.json({ success: true });
  });

  router.patch('/api/settings', (req, res) => {
    const current = readSettings();
    const patch = req.body;
    if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'Expected object' });
    const merged = { ...current, ...patch };
    for (const [k, v] of Object.entries(merged)) { if (v === null) delete merged[k]; }
    writeSettings(merged);
    res.json({ success: true });
  });

  // ── Session Groups ──
  router.get('/api/session-groups', (req, res) => {
    const state = readUserState();
    res.json(state.sessionGroups || {});
  });

  router.post('/api/session-groups', (req, res) => {
    const groups = req.body;
    if (!groups || typeof groups !== 'object') return res.status(400).json({ error: 'Expected object' });
    const state = readUserState();
    state.sessionGroups = groups;
    writeUserState(state);
    res.json({ success: true });
  });

  router.post('/api/session-groups/create', (req, res) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    const state = readUserState();
    if (!state.sessionGroups) state.sessionGroups = {};
    const groupId = 'group-' + crypto.randomUUID();
    state.sessionGroups[groupId] = { name, sessionIds: [] };
    writeUserState(state);
    res.json({ success: true, groupId, group: state.sessionGroups[groupId] });
  });

  router.post('/api/session-groups/delete', (req, res) => {
    const { groupId } = req.body;
    if (!groupId) return res.status(400).json({ error: 'groupId is required' });
    const state = readUserState();
    if (!state.sessionGroups || !state.sessionGroups[groupId]) return res.status(404).json({ error: 'Group not found' });
    delete state.sessionGroups[groupId];
    writeUserState(state);
    res.json({ success: true });
  });

  router.post('/api/session-groups/rename', (req, res) => {
    const { groupId, name } = req.body;
    if (!groupId || !name) return res.status(400).json({ error: 'groupId and name are required' });
    const state = readUserState();
    if (!state.sessionGroups || !state.sessionGroups[groupId]) return res.status(404).json({ error: 'Group not found' });
    state.sessionGroups[groupId].name = name;
    writeUserState(state);
    res.json({ success: true });
  });

  router.post('/api/session-groups/assign', (req, res) => {
    const { groupId, sessionId } = req.body;
    if (!groupId || !sessionId) return res.status(400).json({ error: 'groupId and sessionId are required' });
    const state = readUserState();
    if (!state.sessionGroups || !state.sessionGroups[groupId]) return res.status(404).json({ error: 'Group not found' });
    const group = state.sessionGroups[groupId];
    if (!group.sessionIds.includes(sessionId)) {
      group.sessionIds.push(sessionId);
      writeUserState(state);
    }
    res.json({ success: true });
  });

  router.post('/api/session-groups/unassign', (req, res) => {
    const { groupId, sessionId } = req.body;
    if (!groupId || !sessionId) return res.status(400).json({ error: 'groupId and sessionId are required' });
    const state = readUserState();
    if (!state.sessionGroups || !state.sessionGroups[groupId]) return res.status(404).json({ error: 'Group not found' });
    const group = state.sessionGroups[groupId];
    group.sessionIds = group.sessionIds.filter(id => id !== sessionId);
    writeUserState(state);
    res.json({ success: true });
  });

  return router;
}

module.exports = { router, setup };
