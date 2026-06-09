/**
 * Persistence API routes — layouts, bookmarks, custom themes, user state,
 * settings. All are file-backed JSON stores with WS broadcast.
 * (Session groups live inside user-state; the old /api/session-groups CRUD
 * routes were removed — they were unreachable and used a conflicting data
 * shape that normalizeUserState would have flattened to [].)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { listCodexThreads } = require('../codex-session-store');

const router = express.Router();

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

// Atomic JSON write: tmp + rename. layouts.json/user-state.json are rewritten
// constantly; a crash mid-writeFileSync truncates the file, the next read's
// catch silently resets to defaults, and the next autosave makes the loss
// permanent. rename() is atomic on POSIX so readers see old-or-new, never torn.
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Setup persistence routes. Requires { dataDir, wss, WS_OPEN, getSyncStore, activeSessions } context. */
function setup({ dataDir, wss, WS_OPEN, getSyncStore, activeSessions }) {
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
    writeJsonAtomic(LAYOUTS_FILE, data);
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
    writeJsonAtomic(BOOKMARKS_FILE, data);
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
    ensureDir(dataDir);
    _customThemesCache = data;
    writeJsonAtomic(CUSTOM_THEMES_FILE, data);
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
  const USER_STATE_DEFAULT = {
    stateVersion: 2,
    starredSessions: [],
    archivedSessions: [],
    customNames: {},
    sessionModes: {},
    sessionConfigs: {},
    sessionGroups: {},
    groupFolders: {},
  };

  const CLAUDE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function buildKnownSessionKeyMap() {
    const map = new Map();
    const add = (legacyId, sessionKey) => {
      if (!legacyId || !sessionKey) return;
      if (!map.has(legacyId)) map.set(legacyId, sessionKey);
    };

    for (const [id, session] of activeSessions || []) {
      const backend = session.backend || 'claude';
      const backendSessionId = session.backendSessionId || session.claudeSessionId || null;
      const sessionKey = backendSessionId ? `${backend}:${backendSessionId}` : '';
      const webuiSessionId = id || null;
      add(session.backendSessionId, sessionKey);
      add(session.claudeSessionId, sessionKey);
      add(webuiSessionId, sessionKey);
      add(webuiSessionId ? `${backend}:${webuiSessionId}` : '', sessionKey);
    }

    for (const session of listCodexThreads({ activeSessions })) {
      add(session.sessionId, session.sessionKey || `codex:${session.backendSessionId || session.sessionId}`);
      add(session.backendSessionId, session.sessionKey || `codex:${session.backendSessionId || session.sessionId}`);
    }

    return map;
  }

  function migrateLegacySessionRef(rawKey, knownSessionKeys) {
    const key = String(rawKey || '');
    if (!key) return '';
    if (knownSessionKeys?.has(key)) return knownSessionKeys.get(key);
    if (key.includes(':')) return key;
    if (CLAUDE_UUID_RE.test(key)) return `claude:${key}`;
    return key;
  }

  function migrateStateArray(items, knownSessionKeys) {
    const next = [];
    const seen = new Set();
    for (const raw of Array.isArray(items) ? items : []) {
      const mapped = migrateLegacySessionRef(raw, knownSessionKeys);
      if (!mapped || seen.has(mapped)) continue;
      seen.add(mapped);
      next.push(mapped);
    }
    return next;
  }

  function migrateStateMap(map, knownSessionKeys) {
    const next = {};
    for (const [rawKey, value] of Object.entries(map || {})) {
      const mapped = migrateLegacySessionRef(rawKey, knownSessionKeys);
      if (!mapped || Object.hasOwn(next, mapped)) continue;
      next[mapped] = value;
    }
    return next;
  }

  function normalizeUserState(data) {
    const source = data && typeof data === 'object' ? data : {};
    const knownSessionKeys = buildKnownSessionKeyMap();
    const sessionGroups = {};
    for (const [groupName, sessionRefs] of Object.entries(source.sessionGroups && typeof source.sessionGroups === 'object' ? source.sessionGroups : {})) {
      sessionGroups[groupName] = migrateStateArray(sessionRefs, knownSessionKeys);
    }
    return {
      stateVersion: 2,
      starredSessions: migrateStateArray(source.starredSessions, knownSessionKeys),
      archivedSessions: migrateStateArray(source.archivedSessions, knownSessionKeys),
      customNames: migrateStateMap(source.customNames && typeof source.customNames === 'object' ? source.customNames : {}, knownSessionKeys),
      sessionModes: migrateStateMap(source.sessionModes && typeof source.sessionModes === 'object' ? source.sessionModes : {}, knownSessionKeys),
      sessionConfigs: migrateStateMap(source.sessionConfigs && typeof source.sessionConfigs === 'object' ? source.sessionConfigs : {}, knownSessionKeys),
      sessionGroups,
      groupFolders: source.groupFolders && typeof source.groupFolders === 'object' ? source.groupFolders : {},
    };
  }

  function readUserState() {
    if (_userStateCache) return _userStateCache;
    ensureDir(dataDir);
    try {
      const rawText = fs.readFileSync(USER_STATE_FILE, 'utf-8');
      const parsed = JSON.parse(rawText);
      _userStateCache = normalizeUserState(parsed);
      const normalizedText = JSON.stringify(_userStateCache, null, 2);
      if (normalizedText !== rawText.trim()) {
        writeJsonAtomic(USER_STATE_FILE, _userStateCache);
      }
    }
    catch { _userStateCache = { ...USER_STATE_DEFAULT }; }
    return _userStateCache;
  }

  function writeUserState(data) {
    ensureDir(dataDir);
    _userStateCache = normalizeUserState(data);
    writeJsonAtomic(USER_STATE_FILE, _userStateCache);
    broadcast({ type: 'user-state-updated', state: _userStateCache });
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
    writeJsonAtomic(SETTINGS_FILE, data);
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

  return router;
}

module.exports = { router, setup };
