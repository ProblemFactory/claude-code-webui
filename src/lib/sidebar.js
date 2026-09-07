import { Resizer } from './resizer.js';
import { agoText, escHtml, createPopover, hostStateChip, sessionMatchesFilter, showContextMenu } from './utils.js';
import { t as tr } from './i18n.js';
import { BACKEND_META, createAgentKindIcon, createBackendIcon, getAgentKindMeta, getBackendMeta, getSessionKey } from './agent-meta.js';
import { installSidebarState } from './sidebar-state.js';
import { installSidebarRender } from './sidebar-render.js';
import { installSidebarRenderMobile } from './sidebar-render-mobile.js';
import { installSidebarMounts } from './sidebar-mounts.js';
import { installSidebarRail } from './sidebar-rail.js';
import { installSidebarWorkbench } from './sidebar-workbench.js';
import { installSidebarTasks } from './sidebar-tasks.js';

// Consecutive failed /api/sessions polls before the sidebar admits the list is
// frozen. 3 × 5s ≈ 15s — long enough that one blip stays invisible, short
// enough that a real outage never renders a silently stale list.
const SESSION_POLL_STALE_AFTER = 3;

/**
 * THE per-session LIVE FACTS the `active-sessions` payload publishes under the
 * names every client surface reads them by — carried through `_merge()` as ONE
 * list instead of one hand-copied line each.
 *
 * WHY A LIST AND NOT MORE LINES (round-3 verifier, BLOCKER). `_merge()` does
 * not spread the live row: it REBUILDS it (the webui half is renamed into
 * webuiId/webuiName/webuiMode, `cwd` becomes the composed display/grouping
 * key, `status` is derived), so a fact that is not named here is DROPPED — and
 * `/api/sessions` discovery does not carry any of these, so the `...s` spread
 * cannot supply them either. That is the whitelist-drift class this project
 * has now been bitten by six times (2.368.4 named it at the fifth), and three
 * facts were dead RIGHT HERE when this list was written:
 *   · `worktree`/`worktreePath` (owner ruling 9) — the card badge never drew,
 *     Session Properties said "not isolated in this run" about a session the
 *     server had just reported isolated WITH a path, and the fork's
 *     `worktreePick({saved, live: sessionInfo.worktree})` always got
 *     `live: undefined` — so a fork of an isolated conversation ran in the
 *     user's real working tree;
 *   · `outputStyle` (2.369.58) — Session Properties' response-style row read
 *     `s.outputStyle` and never saw a live value, so a session running a style
 *     reported the harness default;
 *   · `remoteState` (2.219.1) — the "host unreachable" chip could not draw, so
 *     a session whose machine was gone still read as conversable.
 * Adding a key to the server payload and NOT to this list fails the drift
 * guard in scripts/test-worktree-userchan-ui.mjs, which re-derives the payload's
 * own key set from server.js.
 */
const LIVE_SESSION_FACTS = Object.freeze([
  'remoteState',
  'accountId', 'accountName', 'accountTail', 'auth',
  'todo',
  // …and the SPAWN knobs with the origin each one came from (B-6b6d). They
  // reached this merge as four hand-copied lines in the same release that
  // discovered `outputStyle` had never been copied at all — which is the whole
  // argument for the list: Session Properties reports these as FACTS and must
  // never re-derive them from the saved pick.
  'outputStyle', 'spawnModel', 'effort', 'modelOrigin', 'effortOrigin',
  'worktree', 'worktreePath',
]);
/** Carry the live facts verbatim; an absent live row states nothing (null). */
const liveSessionFacts = (src) => {
  const out = {};
  for (const k of LIVE_SESSION_FACTS) out[k] = src ? (src[k] ?? null) : null;
  return out;
};

class Sidebar {
  constructor(app) {
    this.app = app; this.el = document.getElementById('sidebar');
    this.listEl = document.getElementById('all-sessions-list');
    this.isOpen = false;
    this._resizePreviewEl = null;

    // Resizable sidebar width — handle inside sidebar (position:fixed can't use sibling)
    this._resizer = new Resizer(this.el, 'horizontal', {
      min: 200, max: 500, initial: parseInt(localStorage.getItem('sidebarWidth')) || 260,
      storageKey: 'sidebarWidth', inside: true, liveResize: false,
      invert: () => this.app.settings?.get('sidebar.position') === 'right',
      onResizeStart: (w) => {
        this._setSidebarResizing(true);
        this._showSidebarResizePreview(w);
      },
      onResize: (w) => this._showSidebarResizePreview(w),
      onResizeEnd: (w) => {
        this._hideSidebarResizePreview();
        this._applySidebarLayoutWidth(w);
        this._fitVisibleSessions();
        requestAnimationFrame(() => this._setSidebarResizing(false));
      },
    });
    this._allSessions = [];
    this._webuiSessions = [];

    // Load from localStorage as initial cache/fallback
    this._starredIds = new Set(JSON.parse(localStorage.getItem('starredSessions') || '[]'));
    this._archivedIds = new Set(JSON.parse(localStorage.getItem('archivedSessions') || '[]'));
    this._archivedFolders = new Set(JSON.parse(localStorage.getItem('archivedFolders') || '[]')); // folder keys — sessions under these default to archived (incl. future ones)
    this._customNames = JSON.parse(localStorage.getItem('sessionCustomNames') || '{}');
    this._sessionModes = JSON.parse(localStorage.getItem('sessionModes') || '{}'); // { sessionId: 'terminal'|'chat' }
    this._sessionConfigs = JSON.parse(localStorage.getItem('sessionConfigs') || '{}'); // { sessionKey: {model, effort, permission} }
    this._sessionGroups = JSON.parse(localStorage.getItem('sessionGroups') || '{}'); // { groupName: [sessionId, ...] }
    this._groupFolders = JSON.parse(localStorage.getItem('groupFolders') || '{}'); // { groupName: [folderPath, ...] }

    this._sortMode = localStorage.getItem('sessionSort') || 'recent';
    this._backendFilter = new Set(JSON.parse(localStorage.getItem('backendFilter') || '[]'));
    this._hostFilter = new Set(JSON.parse(localStorage.getItem('hostFilter') || '[]')); // empty = all; 'local' or host ids
    // Default = PRIMARY only (owner report 2.369.32: codex sub-agent threads
    // flooded the list). '' = ALL, chosen explicitly (persisted as 'all').
    const storedKind = localStorage.getItem('agentKindFilter');
    this._agentKindFilter = storedKind == null ? 'primary' : (storedKind === 'all' ? '' : storedKind);
    this._collapsedFolders = new Set(JSON.parse(localStorage.getItem('collapsedFolders') || '[]'));
    this._expandedFolders = new Set(JSON.parse(localStorage.getItem('expandedFolders') || '[]'));
    this._expandedCardId = null; // only one card expanded at a time

    // Tab state: 'folders' | 'tasks' | 'mounts'
    this._activeTab = 'folders';
    // Mobile mode from centralized app.isMobile
    this._mobileMode = app.isMobile;

    // Fetch server state (source of truth)
    this._fetchUserState();
    // Task store (tasks ⊃ groups — the board data, from /api/tasks)
    this._initTasks();

    // Card-level settings are read at CARD BUILD time — without a re-render
    // kick, changing them only took effect on the next digest change (users
    // read that as "needs a page refresh"). _render() preserves scroll.
    for (const k of ['sessionCard.clickBehavior', 'sessionCard.findMode', 'sessionCard.clickToCopy',
      'sessionCard.visibleFields', 'sessionCard.detailTruncation']) {
      app.settings?.on(k, () => this._render());
    }

    // Mounts/machines WS handlers (incl. the machine-ports-new toast) must be
    // live from PAGE LOAD — gated behind the Remote tab's first render, a user
    // who never opened that tab NEVER saw a new-port notification (real report)
    setTimeout(() => { try { this._initMountsSync?.(); } catch {} }, 0);
    // vscode-style activity rail (sidebar.activityRail, default ON)
    setTimeout(() => { try { this._railInit?.(); } catch {} }, 0);

    // Listen for user-state-updated WebSocket messages from other clients
    app.ws.onGlobal((msg) => {
      if (msg.type === 'user-state-updated' && msg.state) {
        this._applyServerState(msg.state);
        this._render();
        this.app.updateTaskbar();
      }
    });

    document.getElementById('sidebar-toggle').onclick = () => this.toggle();
    document.getElementById('sidebar-close').onclick = () => this.toggle(false);
    // 150ms debounce: every keystroke re-ran the full folder-grouping render
    // over ~5k sessions (audit round-2)
    document.getElementById('session-filter').oninput = () => {
      clearTimeout(this._filterTimer);
      this._filterTimer = setTimeout(() => this._render(), 150);
    };

    // Build tab bar
    this._buildTabBar();

    // Sort toggle
    const sortBtn = document.getElementById('sort-toggle');
    this._updateSortBtn(sortBtn);
    sortBtn.onclick = () => {
      if (this._activeTab === 'tasks') {
        // Task View sort menu (urgency/status/recent/name) — same control
        // position as the Folders sort, per-context contents.
        const r = sortBtn.getBoundingClientRect();
        const SORTS = { urgency: tr('Urgency + status'), status: tr('Status'), recent: tr('Recent'), name: tr('Name') };
        showContextMenu(r.left, r.bottom + 2, Object.entries(SORTS).map(([k, label]) => ({
          label: (this._taskViewSortMode === k ? '✓ ' : '  ') + label,
          action: () => {
            this._taskViewSortMode = k;
            try { localStorage.setItem('vibespace.taskViewSort', k); } catch {}
            this._updateSortBtn(sortBtn);
            this._render();
          },
        })));
        return;
      }
      this._sortMode = this._sortMode === 'recent' ? 'folder' : 'recent';
      localStorage.setItem('sessionSort', this._sortMode);
      this._updateSortBtn(sortBtn);
      this._render();
    };

    // Status filter dropdown (multi-select: live, running, stopped, archived)
    const defaultFilter = this.app.settings?.get('sidebar.defaultStatusFilter') ?? ['live', 'tmux', 'external', 'stopped'];
    this._statusFilter = new Set(defaultFilter);
    this._activeView = null; // null = ALL (show all selected filters), or a specific status string
    const filterBtn = document.getElementById('live-filter');
    filterBtn.onclick = (e) => {
      e.stopPropagation();
      const own = document.querySelector('.status-filter-menu:not(.backend-filter-menu)');
      if (own) { own.remove(); return; }
      this._showStatusFilterMenu(filterBtn);
    };
    const backendFilterBtn = document.getElementById('backend-filter');
    backendFilterBtn.onclick = (e) => {
      e.stopPropagation();
      if (document.querySelector('.backend-filter-menu')) { document.querySelector('.backend-filter-menu').remove(); return; }
      this._showBackendFilterMenu(backendFilterBtn);
    };
    this._updateBackendFilterBtn(backendFilterBtn);
    // Manage mode: batch-terminate via a ✕ on every running card's collapsed row
    const manageBtn = document.getElementById('manage-toggle');
    if (manageBtn) {
      manageBtn.onclick = (e) => {
        e.stopPropagation();
        this._manageMode = !this._manageMode;
        this._manageMarks = new Map(); // fresh selection each time
        manageBtn.classList.toggle('active', this._manageMode);
        this.el.classList.toggle('manage-mode', this._manageMode);
        this._render();
      };
    }
    // Apply defaultStatusFilter once after async settings load (setting may differ from schema default)
    const _applyDefaultFilter = (val) => {
      this._statusFilter = new Set(val);
      this._activeView = null;
      this._updateFilterBtn(filterBtn);
      this._updateBackendFilterBtn(backendFilterBtn);
      this._renderQuickTabs(); // quick-tab row must reflect the async-loaded filter too
      this._render();
      this.app.settings?.off('sidebar.defaultStatusFilter', _applyDefaultFilter);
    };
    this.app.settings?.on('sidebar.defaultStatusFilter', _applyDefaultFilter);
    // Default tab + Task-Groups default sub-view (one-shot after async settings
    // load, same pattern as defaultStatusFilter; a manual click wins).
    const _applyDefaultTab = (val) => {
      this.app.settings?.off('sidebar.defaultTab', _applyDefaultTab);
      if (!this._tabTouched && val && ['folders', 'tasks', 'mounts'].includes(val) && val !== this._activeTab) {
        this._activeTab = val;
        this._updateTabs();
        this._render();
        // Rail chrome must follow (real report: content landed on the default
        // tab while the rail highlight + header title stayed on the
        // localStorage-restored pre-refresh panel — the rail restores first,
        // this async one-shot then switched content only)
        this._railSync?.();
        this._railApplyTitle?.();
      }
    };
    this.app.settings?.on('sidebar.defaultTab', _applyDefaultTab);
    const _applyDefaultView = (val) => {
      this.app.settings?.off('sidebar.defaultBoardView', _applyDefaultView);
      if (!this._boardViewTouched && (val === 'groups' || val === 'tasks') && val !== this._boardView) {
        this._boardView = val;
        if (this._activeTab === 'tasks') this._render();
      }
    };
    this.app.settings?.on('sidebar.defaultBoardView', _applyDefaultView);
    this._updateTabs(); // apply per-tab chrome for the initial tab
    this._renderQuickTabs();
    this._renderAgentKindQuickTabs();
    // Re-render quick tabs after settings finish loading (async)
    this.app.settings?.on('sidebar.enableStatusQuickTabs', () => this._renderQuickTabs());

    this._sessionDigest = '';
    app.ws.onGlobal((msg) => {
      if (msg.type === 'active-sessions') { this._webuiSessions = msg.sessions; this._mergeAndRender(); }
    });
    this._poll();
  }

  // State methods (star/archive/rename/groups/migration) installed by sidebar-state.js mixin

  // ── Tab Bar ──

  _buildTabBar() {
    const section = this.listEl.parentElement;
    const tabBar = document.createElement('div');
    tabBar.className = 'sidebar-tabs';
    const foldersTab = document.createElement('button');
    foldersTab.className = 'sidebar-tab active';
    foldersTab.textContent = tr('Folders');
    foldersTab.dataset.tab = 'folders';
    foldersTab.onclick = () => { this._tabTouched = true; this._activeTab = 'folders'; this._updateTabs(); this._render(); };
    const tasksTab = document.createElement('button');
    tasksTab.className = 'sidebar-tab';
    tasksTab.textContent = tr('Task Groups');
    tasksTab.dataset.tab = 'tasks';
    tasksTab.onclick = () => { this._tabTouched = true; this._activeTab = 'tasks'; this._updateTabs(); this._render(); };
    const mountsTab = document.createElement('button');
    mountsTab.className = 'sidebar-tab';
    mountsTab.textContent = tr('Remote');
    mountsTab.dataset.tab = 'mounts';
    mountsTab.onclick = () => { this._tabTouched = true; this._activeTab = 'mounts'; this._updateTabs(); this._render(); };
    tabBar.append(foldersTab, tasksTab, mountsTab);
    section.insertBefore(tabBar, section.firstChild);
  }

  _updateTabs() {
    const tabs = this.el.querySelectorAll('.sidebar-tab');
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === this._activeTab));
    // Per-tab chrome: ONE filter/sort story per tab. Folders keeps the full
    // global set; Task Groups keeps just the text filter + manage mode (its
    // views carry their own sort/filter toolbar); Remote needs none of it.
    const t = ['ports', 'agents', 'plugins'].includes(this._activeTab) ? 'mounts' : this._activeTab;
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    show('session-filter', t !== 'mounts');
    // The unified filter menu (status/backend/machine/kind) applies on BOTH
    // session tabs — its backend/host/kind dimensions filter the Tasks tab too
    // (hiding it while they silently kept filtering was a 2.47.0 bug); its
    // Status section self-hides on the tasks tab (see _showBackendFilterMenu).
    show('backend-filter', t !== 'mounts');
    // Sort: Folders = recent/folder cycle; Tasks tab shows it only in the flat
    // Tasks view (the Groups board has a fixed attention order). Same button,
    // per-context behavior — no separate toolbar row inside the view.
    show('sort-toggle', t === 'folders' || (t === 'tasks' && this._boardView === 'tasks')); // Tasks flat view has its sort on ALL form factors now
    this._updateSortBtn(document.getElementById('sort-toggle'));
    show('manage-toggle', t !== 'mounts');
    show('status-quick-tabs', t === 'folders');
    show('agent-kind-quick-tabs', t !== 'mounts'); // agentKind filter applies on tasks too
  }

  // ── Highlight / Sort / Filter ──

  highlightSession(sessionId) {
    this.listEl.querySelectorAll('.session-item-card').forEach(c => c.classList.remove('highlighted', 'highlight-flash'));
    // Only a focus CHANGE may expand folders / scroll the card into view.
    // This runs repeatedly (every focus notify + broadcast re-render) and the
    // old unconditional scrollIntoView dragged the list back to the focused
    // card while the user browsed OTHER cards — the "sidebar keeps jumping
    // back" mystery (user-diagnosed). While the pointer is inside the sidebar
    // the user owns the scroll — never yank it.
    const isNew = this._lastHighlightId !== sessionId;
    this._lastHighlightId = sessionId;
    if (!sessionId) return;
    const userBrowsing = !!this.el?.matches?.(':hover');
    const mayScroll = isNew && !userBrowsing;

    // The target card may be inside a COLLAPSED folder/group (CSS-hidden) or a
    // LAZY folder whose cards haven't rendered yet — in both cases a plain
    // scroll finds nothing or a hidden node. First locate the containing
    // folder-group via its stored lazy item list (present even before render),
    // expand it (persisting so it stays open), and force-render its cards.
    for (const group of mayScroll ? this.listEl.querySelectorAll('.folder-group') : []) {
      const sessionsDiv = group.querySelector('.folder-sessions');
      const items = sessionsDiv?._lazyItems;
      if (!items || !items.some(s => s.sessionId === sessionId)) continue;
      if (group.classList.contains('collapsed')) {
        group.classList.remove('collapsed');
        const key = group._collapseKey;
        if (key) {
          this._collapsedFolders.delete(key);
          // Counts as explicit expansion — a huge auto-collapsed folder must
          // not re-collapse on the next render right after we jumped into it
          this._expandedFolders.add(key);
          localStorage.setItem('collapsedFolders', JSON.stringify([...this._collapsedFolders]));
          localStorage.setItem('expandedFolders', JSON.stringify([...this._expandedFolders]));
        }
      }
      if (sessionsDiv.dataset.lazy && sessionsDiv.dataset.lazy !== 'rendered') {
        sessionsDiv.innerHTML = '';
        sessionsDiv.style.minHeight = '';
        for (const s of items) sessionsDiv.appendChild(this._buildSessionCard(s));
        sessionsDiv.dataset.lazy = 'rendered';
      }
      break;
    }

    for (const card of this.listEl.querySelectorAll('.session-item-card')) {
      if (card._sessionId === sessionId) {
        card.classList.add('highlighted');
        if (isNew) requestAnimationFrame(() => card.classList.add('highlight-flash'));
        if (mayScroll) {
          if (card.scrollIntoViewIfNeeded) card.scrollIntoViewIfNeeded(false);
          else card.scrollIntoView({ block: 'nearest' });
        }
        break;
      }
    }
  }

  _updateSortBtn(btn) {
    if (!btn) return;
    // Context-aware: on the Task Groups tab (Tasks view) the button owns the
    // Task View sort menu; on Folders it cycles recent/folder grouping.
    if (this._activeTab === 'tasks') {
      btn.innerHTML = '<svg style="width:11px;height:11px;vertical-align:-1px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v10M5 13l-2.5-2.5M5 13l2.5-2.5M11 13V3M11 3L8.5 5.5M11 3l2.5 2.5"/></svg>';
      btn.title = tr('Sort by: {mode}', { mode: ({ urgency: tr('Urgency + status'), status: tr('Status'), recent: tr('Recent'), name: tr('Name') })[this._taskViewSortMode] || tr('Urgency + status') });
      return;
    }
    btn.innerHTML = this._sortMode === 'recent' ? '<svg style="width:11px;height:11px;vertical-align:-1px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 1.5"/></svg>' : '<svg style="width:11px;height:11px;vertical-align:-1px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h4l2 2h6v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"/></svg>';
    btn.title = tr('Sort by: {mode}', { mode: this._sortMode === 'recent' ? tr('Recent') : tr('Folder') });
  }

  _showStatusFilterMenu(anchor) {
    const menu = createPopover(anchor, 'status-filter-menu');

    const items = [
      { id: 'live', label: tr('Live'), color: 'var(--green)' },
      { id: 'tmux', label: tr('Tmux'), color: 'var(--blue)' },
      { id: 'external', label: tr('External'), color: 'var(--yellow)' },
      { id: 'stopped', label: tr('Stopped'), color: 'var(--text-dim)' },
      { id: 'archived', label: tr('Archived'), color: 'var(--text-dim)' },
    ];
    for (const item of items) {
      const row = document.createElement('label'); row.className = 'status-filter-item';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = this._statusFilter.has(item.id);
      const dot = document.createElement('span'); dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${item.color};flex-shrink:0`;
      const lbl = document.createElement('span'); lbl.textContent = item.label;
      cb.onchange = () => {
        if (cb.checked) this._statusFilter.add(item.id); else this._statusFilter.delete(item.id);
        this._activeView = null; // reset to ALL when filter changes
        this._updateFilterBtn(anchor);
        this._renderQuickTabs();
        this._render();
      };
      row.append(cb, dot, lbl);
      menu.appendChild(row);
    }
  }

  _getAvailableBackends() {
    const ids = new Set(this._backendFilter.size ? [...this._backendFilter] : ['claude']);
    for (const s of [...(this._systemSessions || []), ...(this._webuiSessions || [])]) {
      if (s.backend) ids.add(s.backend);
    }
    return [...ids];
  }

  _showBackendFilterMenu(anchor) {
    // Unified filter (2026-07 redesign): one popover with Status / Backend /
    // Location / Agent-kind sections replaces three rows of controls.
    // Own class — sharing .status-filter-menu made the two filter buttons'
    // open/close toggles fight each other (status click closed the backend
    // menu; backend's own toggle check never matched)
    const menu = createPopover(anchor, 'backend-filter-menu status-filter-menu');
    // On the Task Groups tab (flat Tasks view) the first section is the session
    // STATE filter (working/needs-input/…/done) — it lives HERE so all
    // narrowing controls share one menu instead of a second toolbar row.
    if (this._activeTab === 'tasks' && this._boardView === 'tasks') {
      const head = document.createElement('div');
      head.className = 'status-filter-sec';
      head.style.borderTop = 'none';
      head.textContent = tr('State');
      menu.appendChild(head);
      const cur = new Set(this._taskViewStatusFilter || []);
      const apply = () => {
        const arr = [...cur];
        this._taskViewStatusFilter = arr.length ? arr : null;
        try { localStorage.setItem('vibespace.taskViewFilter', JSON.stringify(this._taskViewStatusFilter)); } catch {}
        this._render();
      };
      for (const st of ['working', 'needs-input', 'blocked', 'review', 'done']) {
        const row = document.createElement('label'); row.className = 'status-filter-item';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = cur.has(st);
        cb.onchange = () => { cb.checked ? cur.add(st) : cur.delete(st); apply(); };
        const lbl = document.createElement('span'); lbl.textContent = st;
        row.append(cb, lbl);
        menu.appendChild(row);
      }
      const hint = document.createElement('div');
      hint.className = 'status-filter-hint';
      hint.textContent = tr('none checked = show all states');
      menu.appendChild(hint);
    }
    // The connection-Status section is FOLDERS-ONLY: the Task Groups tab
    // deliberately bypasses the status filter (a group's members are often
    // stopped — 2.41.0), and Task View has its own state filter (above). Showing
    // dead checkboxes there would misrepresent what's being filtered.
    if (this._activeTab !== 'tasks') {
      const head = document.createElement('div');
      head.className = 'status-filter-sec';
      head.style.borderTop = 'none';
      head.textContent = tr('Status');
      menu.appendChild(head);
      for (const [id, label] of [['live', tr('Live')], ['tmux', tr('Tmux')], ['external', tr('External')], ['stopped', tr('Stopped')], ['archived', tr('Archived')]]) {
        const row = document.createElement('label'); row.className = 'status-filter-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this._statusFilter.has(id);
        cb.onchange = () => {
          if (cb.checked) this._statusFilter.add(id); else this._statusFilter.delete(id);
          localStorage.setItem('statusFilter', JSON.stringify([...this._statusFilter]));
          this._activeView = null;
          this._render();
        };
        const lbl = document.createElement('span'); lbl.textContent = label;
        row.append(cb, lbl);
        menu.appendChild(row);
      }
    }
    {
      const bhead = document.createElement('div');
      bhead.className = 'status-filter-sec';
      if (this._activeTab === 'tasks' && this._boardView !== 'tasks') bhead.style.borderTop = 'none';
      bhead.textContent = tr('Backend');
      menu.appendChild(bhead);
    }
    const backends = this._getAvailableBackends();
    for (const id of backends) {
      const meta = getBackendMeta(id);
      const row = document.createElement('label'); row.className = 'status-filter-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this._backendFilter.size === 0 || this._backendFilter.has(id);
      const dot = createBackendIcon(id, { className: 'sidebar-backend-filter-icon', title: meta.label });
      const lbl = document.createElement('span'); lbl.textContent = meta.label;
      cb.onchange = () => {
        const next = this._backendFilter.size === 0 ? new Set(backends) : new Set(this._backendFilter);
        if (cb.checked) next.add(id); else next.delete(id);
        this._backendFilter = next.size === backends.length ? new Set() : next;
        localStorage.setItem('backendFilter', JSON.stringify([...this._backendFilter]));
        this._activeView = null;
        this._updateBackendFilterBtn(anchor);
        this._render();
      };
      row.append(cb, dot, lbl);
      menu.appendChild(row);
    }

    // ── Location section (local / each remote host) ──
    const hosts = new Map([['local', tr('Local')]]);
    for (const s of this._allSessions || []) if (s.host) hosts.set(s.host, s.hostName || s.host);
    for (const h of this._hostsData?.hosts || []) hosts.set(h.id, h.name);
    if (hosts.size > 1) {
      const head = document.createElement('div');
      head.className = 'status-filter-sec';
      head.textContent = tr('Location');
      menu.appendChild(head);
      const all = [...hosts.keys()];
      for (const [hid, label] of hosts) {
        const row = document.createElement('label'); row.className = 'status-filter-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this._hostFilter.size === 0 || this._hostFilter.has(hid);
        const lbl = document.createElement('span'); lbl.textContent = label;
        cb.onchange = () => {
          const next = this._hostFilter.size === 0 ? new Set(all) : new Set(this._hostFilter);
          if (cb.checked) next.add(hid); else next.delete(hid);
          this._hostFilter = next.size === all.length ? new Set() : next;
          localStorage.setItem('hostFilter', JSON.stringify([...this._hostFilter]));
          this._activeView = null;
          this._render();
        };
        row.append(cb, lbl);
        menu.appendChild(row);
      }
    }
  }

  _updateFilterBtn(btn) {
    // Default state: 4 non-archived filters on, archived off
    const isDefault = this._statusFilter.size === 4 && !this._statusFilter.has('archived');
    btn.style.color = isDefault ? '' : 'var(--accent-hover)';
    btn.title = isDefault ? tr('Filter by status') : tr('Showing: {list}', { list: [...this._statusFilter].join(', ') });
  }

  _updateBackendFilterBtn(btn) {
    const isDefault = this._backendFilter.size === 0;
    btn.style.color = isDefault ? '' : 'var(--accent-hover)';
    btn.title = isDefault ? tr('Filter by agent backend') : tr('Agents: {list}', { list: [...this._backendFilter].join(', ') });
    const iconIds = isDefault ? this._getAvailableBackends().slice(0, 2) : [...this._backendFilter].slice(0, 2);
    btn.replaceChildren();
    const stack = document.createElement('span');
    stack.className = 'backend-filter-icon-stack';
    if (!iconIds.length) {
      stack.textContent = '◎';
    } else {
      for (const id of iconIds) stack.appendChild(createBackendIcon(id, { className: 'backend-filter-btn-icon' }));
    }
    btn.appendChild(stack);
  }

  _renderQuickTabs() {
    const enabled = this.app.settings?.get('sidebar.enableStatusQuickTabs') ?? false;
    const container = document.getElementById('status-quick-tabs');
    if (!container) return;
    container.innerHTML = '';
    const filters = [...this._statusFilter];
    // Only show tabs if enabled and more than 1 filter is selected
    if (!enabled || filters.length <= 1) return;

    const labelMap = { live: tr('LIVE'), tmux: tr('TMUX'), external: tr('EXT'), stopped: tr('STOP'), archived: tr('ARCH') };
    const colorMap = { live: 'var(--green)', tmux: 'var(--blue)', external: 'var(--yellow)', stopped: 'var(--text-dim)', archived: 'var(--text-dim)' };

    // ALL button
    const allBtn = document.createElement('button'); allBtn.className = 'status-quick-tab';
    if (this._activeView === null) allBtn.classList.add('active');
    allBtn.textContent = tr('ALL');
    allBtn.onclick = () => { this._activeView = null; this._renderQuickTabs(); this._render(); };
    container.appendChild(allBtn);

    for (const f of filters) {
      const btn = document.createElement('button'); btn.className = 'status-quick-tab';
      if (this._activeView === f) btn.classList.add('active');
      btn.textContent = labelMap[f] || f.toUpperCase();
      btn.style.setProperty('--tab-color', colorMap[f] || 'var(--text-dim)');
      btn.onclick = () => { this._activeView = f; this._renderQuickTabs(); this._render(); };
      container.appendChild(btn);
    }
  }

  _getAvailableAgentKinds() {
    const kinds = new Set();
    for (const session of this._allSessions || []) {
      kinds.add(session.agentKind || 'primary');
    }
    return [...kinds];
  }

  _renderAgentKindQuickTabs() {
    const container = document.getElementById('agent-kind-quick-tabs');
    if (!container) return;
    container.innerHTML = '';
    const kinds = this._getAvailableAgentKinds();
    if (kinds.length <= 1 && !kinds.includes('subagent') && !kinds.includes('review')) return;

    const allBtn = document.createElement('button'); allBtn.className = 'status-quick-tab';
    if (!this._agentKindFilter) allBtn.classList.add('active');
    allBtn.textContent = tr('ALL');
    allBtn.title = tr('Show all agent types');
    allBtn.onclick = () => {
      this._agentKindFilter = '';
      localStorage.setItem('agentKindFilter', 'all'); // explicit ALL survives reloads (the default is primary-only)
      this._renderAgentKindQuickTabs();
      this._render();
    };
    container.appendChild(allBtn);

    for (const kind of kinds.sort()) {
      const meta = getAgentKindMeta(kind);
      const btn = document.createElement('button'); btn.className = 'status-quick-tab';
      if (this._agentKindFilter === kind) btn.classList.add('active');
      btn.title = meta.label;
      btn.appendChild(createAgentKindIcon(kind, { className: 'agent-kind-quick-tab-icon', title: meta.label }));
      btn.style.setProperty('--tab-color', meta.color);
      btn.onclick = () => {
        this._agentKindFilter = kind;
        localStorage.setItem('agentKindFilter', kind);
        this._renderAgentKindQuickTabs();
        this._render();
      };
      container.appendChild(btn);
    }
  }

  _toggleCollapse(el, key) {
    el.classList.toggle('collapsed');
    if (el.classList.contains('collapsed')) {
      this._collapsedFolders.add(key);
      this._expandedFolders.delete(key);
    } else {
      this._collapsedFolders.delete(key);
      // Remember explicit expansion so huge folders don't re-auto-collapse
      this._expandedFolders.add(key);
    }
    localStorage.setItem('collapsedFolders', JSON.stringify([...this._collapsedFolders]));
    localStorage.setItem('expandedFolders', JSON.stringify([...this._expandedFolders]));
  }

  _applySidebarLayoutWidth(width = this.el.offsetWidth) {
    const right = this.app.settings?.get('sidebar.position') === 'right';
    // collapsed-with-rail keeps a 44px strip on screen (sidebar.railPersistent)
    const w = this.isOpen ? `${width}px` : (this.el.classList.contains('rail-collapsed') ? '44px' : '0');
    const mw = document.getElementById('main-wrapper');
    mw.style.marginLeft = right ? '0' : w;
    mw.style.marginRight = right ? w : '0';
    // Published for fixed-position chrome that must respect the sidebar too —
    // the auto-hide taskbar + its hotzone are out of the flex flow and would
    // otherwise span the full viewport underneath the sidebar.
    const root = document.documentElement.style;
    root.setProperty('--sidebar-inset-left', right ? '0px' : w);
    root.setProperty('--sidebar-inset-right', right ? w : '0px');
  }

  _setSidebarResizing(active) {
    document.getElementById('main-wrapper').classList.toggle('sidebar-resizing', !!active);
  }

  _ensureSidebarResizePreview() {
    if (this._resizePreviewEl) return this._resizePreviewEl;
    const el = document.createElement('div');
    el.className = 'sidebar-resize-preview';
    document.body.appendChild(el);
    this._resizePreviewEl = el;
    return el;
  }

  _showSidebarResizePreview(width) {
    const el = this._ensureSidebarResizePreview();
    const right = this.app.settings?.get('sidebar.position') === 'right';
    const x = right ? window.innerWidth - Math.max(0, width) : Math.max(0, width) - 1;
    el.style.transform = `translate3d(${x}px, 0, 0)`;
    el.classList.add('visible');
  }

  _hideSidebarResizePreview() {
    if (!this._resizePreviewEl) return;
    this._resizePreviewEl.classList.remove('visible');
  }

  _fitVisibleSessions() {
    for (const [, session] of this.app.sessions) {
      if (!session.fit || !session.winInfo) continue;
      if (session.winInfo.isMinimized || session.winInfo._hiddenByDesktop) continue;
      session.fit();
    }
  }

  toggle(force) {
    this.isOpen = force !== undefined ? force : !this.isOpen;
    this.el.classList.toggle('open', this.isOpen);
    const wrapper = document.getElementById('main-wrapper');
    wrapper.classList.toggle('sidebar-open', this.isOpen);
    this._railApplyCollapsed?.(); // rail strip may persist through a collapse
    this._applySidebarLayoutWidth(this.el.offsetWidth);
    setTimeout(() => this._fitVisibleSessions(), 250);
  }

  async _poll() {
    // Hidden tab: skip the fetch + merge entirely (each poll costs a server
    // discovery scan and, with thousands of sessions, a client-side merge +
    // digest). A visibilitychange listener reschedules an immediate catch-up
    // poll — single timer chain, so the two paths can never double-poll.
    if (!this._visListener) {
      this._visListener = () => {
        if (!document.hidden) { clearTimeout(this._pollTimer); this._pollTimer = setTimeout(() => this._poll(), 100); }
      };
      document.addEventListener('visibilitychange', this._visListener);
    }
    if (!document.hidden) {
      // Fetch and render are SEPARATE try/catches: a throw out of the render
      // would skip the reschedule below (poll chain dead for the page's
      // lifetime) and, folded into one catch, would also be miscounted as a
      // server failure and freeze-mark a list that actually arrived fine.
      let sessions = null, pollErr = '';
      try {
        const res = await fetch('/api/sessions');
        const data = await res.json().catch(() => null);
        // NEVER replace the list with [] on a failure (campaign finding): a
        // transient 500 from the discovery sweep (a project dir deleted
        // mid-readdir, any throw under NFS lag) parses as {error} → the old
        // `data.sessions || []` wiped the ENTIRE discovered list from the
        // sidebar for ≥5s and flip-flopped back on the next good poll
        // (empty↔full flicker under sustained lag). Keep the last good
        // snapshot and MARK it stale instead.
        if (!res.ok || !data || data.error || !Array.isArray(data.sessions)) {
          pollErr = data?.error || `${res.status} ${res.statusText || 'session list unavailable'}`;
        } else sessions = data.sessions;
      } catch (e) { pollErr = e?.message || 'server unreachable'; }
      try {
        if (sessions) {
          const wasStale = (this._pollFails || 0) >= SESSION_POLL_STALE_AFTER;
          this._systemSessions = sessions;
          this._lastPollOkAt = Date.now();
          this._pollFails = 0; this._pollError = '';
          this._mergeAndRender();
          if (wasStale) this._render(); // drop the staleness row now that data is fresh
        } else {
          this._pollFails = (this._pollFails || 0) + 1;
          this._pollError = pollErr;
          // Announce once at the threshold (a single blip stays invisible),
          // then periodically so the "as of" age keeps ticking.
          if (this._pollFails === SESSION_POLL_STALE_AFTER
            || (this._pollFails > SESSION_POLL_STALE_AFTER && this._pollFails % 12 === 0)) this._render();
        }
      } catch {}
    }
    clearTimeout(this._pollTimer);
    this._pollTimer = setTimeout(() => this._poll(), document.hidden ? 30000 : 5000);
  }

  _merge() {
    const system = this._systemSessions || [];
    const webui = this._webuiSessions || [];
    const matchedWebuiIds = new Set();

    // One Map instead of an Array.find per system session — this was
    // O(system × webui) on every 5s poll / active-sessions broadcast
    // (5000-entry lists on this deployment; audit round-3). First-wins on
    // duplicate keys preserves Array.find semantics.
    const webuiByKey = new Map();
    for (const ws of webui) {
      const k = (ws.backend || 'claude') + ':' + (ws.backendSessionId || ws.claudeSessionId || ws.id);
      if (!webuiByKey.has(k)) webuiByKey.set(k, ws);
    }
    const unified = system.map(s => {
      const wm = webuiByKey.get((s.backend || 'claude') + ':' + (s.backendSessionId || s.sessionId));
      if (wm) matchedWebuiIds.add(wm.id);
      // Only upgrade to 'live' for dtach-managed sessions (not tmux/external — those keep their status)
      const status = (wm && s.status !== 'tmux' && s.status !== 'external') ? 'live' : s.status;
      return {
        ...s,
        sessionKey: s.sessionKey || wm?.sessionKey || getSessionKey(s),
        status,
        sourceKind: s.sourceKind || wm?.sourceKind || null,
        agentKind: s.agentKind || wm?.agentKind || 'primary',
        agentRole: s.agentRole || wm?.agentRole || '',
        agentNickname: s.agentNickname || wm?.agentNickname || '',
        parentThreadId: s.parentThreadId || wm?.parentThreadId || null,
        host: wm?.host || null,
        hostName: wm?.hostName || null,
        webuiId: wm?.id || null,
        webuiName: wm?.name || null,
        webuiMode: wm ? (wm.mode || 'terminal') : null,
        // Every remaining live fact, by the server's own name (see
        // LIVE_SESSION_FACTS): billing identity, the agent's TodoWrite pill,
        // the transport chip, the response style and the worktree badge/path.
        ...liveSessionFacts(wm),
      };
    });

    for (const ws of webui) {
      if (!matchedWebuiIds.has(ws.id)) {
        const backend = ws.backend || 'claude';
        const backendSessionId = ws.backendSessionId || ws.claudeSessionId || ws.id;
        unified.unshift({
          backend,
          backendSessionId,
          sessionKey: ws.sessionKey || `${backend}:${backendSessionId}`,
          claudeSessionId: ws.claudeSessionId || null,
          sessionId: backendSessionId,
          // remote sessions group under a host-prefixed folder in the list.
          // ⚠ this composed "host: /path" string is a DISPLAY/grouping KEY
          // (archivedFolders + folder groups key on it — do not change) and
          // MUST NOT reach any spawn: session-lifecycle strips it via
          // stripCwdHostLabel at createSession/attachSession/viewSession, and
          // ws-handler strips server-side (already-persisted openSpecs).
          cwd: ws.hostName ? `${ws.hostName}: ${ws.cwd}` : ws.cwd,
          host: ws.host || null,
          hostName: ws.hostName || null,
          startedAt: ws.createdAt,
          status: 'live',
          sourceKind: ws.sourceKind || null,
          agentKind: ws.agentKind || 'primary',
          agentRole: ws.agentRole || '',
          agentNickname: ws.agentNickname || '',
          parentThreadId: ws.parentThreadId || null,
          webuiId: ws.id,
          webuiName: ws.name,
          name: ws.name || '',
          webuiMode: ws.mode || 'terminal',
          ...liveSessionFacts(ws), // the SAME list as the matched branch above
        });
      }
    }

    this._allSessions = unified;
  }

  _mergeAndRender() {
    this._merge();
    // Sessions created "in" a task get bound once their backend id appears
    this._processPendingTaskBinds?.();
    // Task ⚠ badges depend on the session list (folder auto-include + blocked
    // key resolution) — re-evaluate; signature-guarded, so usually a no-op
    this.refreshTaskAttention?.();
    if (this._migrateUserStateKeys(this._allSessions)) {
      // Never push migration results before the initial server fetch has been
      // applied — doing so POSTs the stale localStorage cache as full state,
      // wiping changes made from other devices (server is last-write-wins).
      // Migration re-runs after the fetch, so deferring loses nothing.
      if (this._userStateFetched) this._pushUserState();
    }
    // NOTE: startedAt is deliberately NOT in the digest. For active sessions it
    // is the JSONL/rollout mtime, which bumps on every write — including it made
    // the list fully re-render on every 5s poll while a session was producing
    // output, yanking scroll/expanded-card state out from under the user. The
    // digest now only changes when the visible content does (which sessions,
    // their status/name/identity). Recency re-sorting is picked up on the next
    // real change instead of churning continuously.
    // The digest is also ORDER-INSENSITIVE (.sort()): discovery orders by
    // transcript mtime, so with several busy sessions the ARRAY ORDER reshuffles
    // on nearly every poll with zero content change — measured live: 5058
    // entries, 0 changed, order-only diff, full re-render every ~5-10s
    // (flickering the Remote tab and expanded cards; two user reports).
    // Identity sync runs on EVERY merge, NOT behind the digest gate: it feeds
    // window title-bar badges/titleMeta/openSpec identity, all internally
    // no-op-guarded. Behind the gate, a freshly loaded page whose windows
    // restore AFTER the first merge never got billing badges — the 2.72.0
    // order-insensitive digest made changes so rare it never re-fired
    // (real report: 订阅徽章消失 on reload).
    this.app.syncSessionIdentity?.(this._allSessions);
    const digest = JSON.stringify(this._allSessions.map(s => `${this._getSessionStateKey(s)}:${s.status}:${s.name || ''}:${s.webuiName || ''}:${s.webuiId || ''}:${s.agentKind || 'primary'}:${s.agentRole || ''}:${s.agentNickname || ''}`).sort());
    if (digest === this._sessionDigest) return;
    this._sessionDigest = digest;
    this._updateBackendFilterBtn(document.getElementById('backend-filter'));
    this._renderAgentKindQuickTabs();
    // Preserve scroll position across the auto-refresh re-render so browsing a
    // session lower in the list isn't interrupted by a jump to the top.
    const hosts = [this.listEl, this.listEl?.closest('.sidebar-section')].filter(Boolean);
    const saved = hosts.map((el) => el.scrollTop);
    this._render();
    hosts.forEach((el, i) => {
      if (!saved[i]) return;
      el.scrollTop = saved[i];
      requestAnimationFrame(() => { el.scrollTop = saved[i]; });
    });
  }

  // EVERY render preserves the list scroll (2.106.1, real report: "sidebar 不断
  // 被刷新, scroll 位置被破坏"): broadcast-triggered re-renders (tasks-updated /
  // session-status-updated / user-state-updated — agents' vibespace-task and
  // vibespace-status calls fire these constantly) reset the scroll to top;
  // only the 5s-poll digest path used to preserve it. A view change (tab /
  // board sub-view / mobile drill-down) resets deliberately — different content.
  /** "Stopped OpenCode conversations are hidden — turn the service on."
   *  ONE row per harness that declares a control plugin (BACKEND_META
   *  .servicePlugin), gated on the state the server broadcasts. Chrome gates
   *  on the DECLARATION, never on a backend id. */
  _renderServiceHintRows(sessions) {
    for (const meta of Object.values(BACKEND_META)) {
      const svc = meta.servicePlugin ? meta.service : null;
      if (!svc || !svc.installed || svc.enabled || svc.running) continue;
      const met = svc.prompted || (sessions || []).some((x) => (x.backend || 'claude') === meta.id);
      if (!met) continue;                      // never nag someone who has not used this harness here
      const row = document.createElement('div');
      row.className = 'empty-hint sidebar-service-hint';
      const label = document.createElement('span');
      label.textContent = tr('Stopped {name} conversations are hidden — its background service is off.', { name: meta.label || meta.id }) + ' ';
      row.append(label);
      // Ops forced it off (VIBESPACE_OPENCODE_SERVE=0): this row still EXPLAINS
      // the incomplete list — silently short lists read as a bug — but carries
      // no button, because nothing the user can click here would work. (It is
      // also the only in-product word about it now that a deliberately-off
      // service no longer counts as a broken store, i.e. no error toast.)
      if (svc.envForced !== false) {
        const enable = document.createElement('button');
        enable.className = 'mounts-btn sidebar-service-enable';
        enable.textContent = tr('Enable…');
        enable.onclick = () => { this.app.enableHarnessService?.(meta.id); };
        row.append(enable);
      }
      this.listEl.appendChild(row);
    }
  }

  _render() {
    // The ACTUAL scrolling element moved over time (.sidebar-section
    // classically; #all-sessions-list itself in the current layout — measured
    // 391/7106 vs the section's 443/443). Anchoring the preserve on one
    // element ROTS SILENTLY when CSS evolves (the 2.228.3 recurrence: every
    // scrollTop read returned 0, so "preserved" scroll was a no-op and any
    // re-render — e.g. clicking a card's expand arrow — landed at the top).
    // Preserve BOTH candidates; restoring a non-scroller is a harmless no-op.
    const hosts = [this.listEl, this.listEl?.closest('.sidebar-section')].filter(Boolean);
    const view = `${this._activeTab}:${this._boardView || ''}:${JSON.stringify(this._mobileDrilldown || null)}`;
    const keeps = this._lastRenderView === view ? hosts.map((el) => el.scrollTop) : hosts.map(() => 0);
    // Remember every lazy folder's CURRENT height so the rebuild can reserve
    // it (see _observeFolder) — without this the post-rebuild scrollHeight
    // collapses and the scrollTop restore below clamps to the top.
    const heights = new Map();
    this.listEl?.querySelectorAll('.folder-sessions').forEach((d) => {
      if (d._lazyKey && d.offsetHeight) heights.set(d._lazyKey, d.offsetHeight);
    });
    this._lazyHeights = heights;
    this._renderInner();
    this._lastRenderView = view;
    hosts.forEach((el, i) => {
      const keep = keeps[i];
      if (!keep) return;
      el.scrollTop = keep;
      requestAnimationFrame(() => { if (Math.abs(el.scrollTop - keep) > 2) el.scrollTop = keep; });
    });
  }

  _renderInner() {
    const f = (document.getElementById('session-filter')?.value || '').toLowerCase();
    let sessions = this._allSessions;

    // Text filter
    if (f) sessions = sessions.filter(s => sessionMatchesFilter(s, f)); // ONE matcher, shared with the remote zones

    // Backend / agent filter
    if (this._backendFilter.size > 0) {
      sessions = sessions.filter(s => this._backendFilter.has(s.backend || 'claude'));
    }
    if (this._hostFilter.size > 0) {
      sessions = sessions.filter(s => this._hostFilter.has(s.host || 'local'));
    }
    if (this._agentKindFilter) {
      sessions = sessions.filter(s => (s.agentKind || 'primary') === this._agentKindFilter);
    }

    // Archive filter: hide archived sessions unless 'archived' filter is on
    const showArchived = this._statusFilter.has('archived');
    if (this._activeTab === 'tasks') {
      // Tasks tab organizes Task-Group membership — a group's sessions are often
      // stopped, so it must NOT be narrowed by the live/stopped status filter or
      // the quick-view tabs (that hid tagged sessions). Only hide archived unless
      // the archived filter is on. Task View has its OWN status filter (per-view).
      if (!showArchived) sessions = sessions.filter(s => !this.isArchived(s));
    } else {
      if (showArchived) {
        // When archived filter is on, show only archived (plus any other enabled statuses for non-archived)
        sessions = sessions.filter(s => {
          if (this.isArchived(s)) return true;
          return this._statusFilter.has(s.status);
        });
      } else {
        // Hide archived sessions, then apply status filter
        sessions = sessions.filter(s => !this.isArchived(s));
        // Status filter (apply only when not all 4 non-archived statuses are selected)
        const nonArchivedFilters = new Set([...this._statusFilter]);
        nonArchivedFilters.delete('archived');
        if (nonArchivedFilters.size < 4) {
          sessions = sessions.filter(s => nonArchivedFilters.has(s.status));
        }
      }
      // Quick tab view: narrow down to a single status
      if (this._activeView) {
        sessions = sessions.filter(s => s.status === this._activeView);
      }
    }

    // Rail panel tabs dispatch BEFORE the innerHTML wipe (2.195.0, real
    // report): _renderRailPanel's renders-once guard checks for the live
    // panel element — wiping first defeated it on EVERY digest change (a
    // session appearing/exiting, user-state broadcasts…), so the Agents
    // panel rebuilt with a fresh closure and its Machine selection reset to
    // local mid-use (userN: "login on host → dialog jumps machines"). The
    // panel wipes listEl itself when it genuinely rebuilds (tab change).
    if (this._activeTab === 'ports' || this._activeTab === 'agents' || this._activeTab === 'plugins' || this._activeTab === 'jobs' || this._activeTab === 'system') { this._renderRailPanel?.(); return; }

    this.listEl.innerHTML = '';

    // Remote tab renders machines + storage — it doesn't depend on the session
    // list AT ALL. Dispatch before the new-session card and the no-sessions
    // early-return: with ZERO sessions (fresh managed instance) that return
    // fired first and the Remote tab showed the Folders empty state instead
    // of the mounts panel (real report: "remote 功能直接坏了").
    if (this._activeTab === 'mounts') { this._renderMounts(); return; }

    // Frozen-list disclosure: _poll KEEPS the last good snapshot when the
    // discovery sweep fails, so without this row the sidebar would render an
    // out-of-date list that looks exactly like a live one (静默失败零容忍).
    if ((this._pollFails || 0) >= SESSION_POLL_STALE_AFTER) {
      const row = document.createElement('div');
      row.className = 'empty-hint sidebar-poll-stale';
      const label = document.createElement('span');
      label.textContent = tr('Session list may be out of date — the server is not responding.') + ' ';
      row.append(label, hostStateChip('error', {
        text: this._lastPollOkAt ? tr('as of {ago}', { ago: agoText(this._lastPollOkAt) }) : tr('unreachable'),
        title: this._pollError || '',
      }));
      this.listEl.appendChild(row);
    }

    // "New Session" card at the top — NOT on the Tasks tab (it has its own
    // "+ New Task Group" card; a bare New Session there is meaningless).
    if (this._activeTab !== 'tasks') {
      const newCard = document.createElement('div'); newCard.className = 'session-item-card new-session-card';
      newCard.innerHTML = `<div class="session-card-name" style="color:var(--accent-hover)">${tr('+ New Session')}</div>`;
      newCard.onclick = () => this.app.showNewSessionDialog();
      this.listEl.appendChild(newCard);
    }

    // Tasks tab renders its board (groups + view toggle) even with zero sessions.
    // A SEARCH with zero LOCAL matches must still reach the workbench (2.125.1,
    // real report: searching a remote session's id showed "No sessions" — this
    // early-return fired before the workbench's cross-host Remote-matches
    // section ever rendered; the 2.124.0 cutoff fix was unreachable).
    // Same class with REMOTE HOSTS configured (2.186.8, real report: fresh
    // instance + a remote machine full of sessions = "No sessions" and NO host
    // switcher anywhere — the workbench's Recent/History switchers are the
    // only path to them). _ensureHostsData re-renders once /api/hosts loads,
    // so the very first paint may still early-return and then self-heal.
    const searchActive = !!(document.getElementById('session-filter')?.value || '').trim();
    this._ensureHostsData?.();
    const hasHosts = !!this._hostsData?.hosts?.length;
    if (!sessions.length && this._activeTab !== 'tasks' && !searchActive && !hasHosts) { this.listEl.insertAdjacentHTML('beforeend', `<div class="empty-hint">${tr('No sessions')}</div>`); return; }

    if (this._mobileMode) {
      // Restore drill-down state if we were inside a folder/group
      if (this._mobileDrilldown) {
        const dd = this._mobileDrilldown;
        if (dd.type === 'folder') {
          const items = sessions.filter(s => (s.cwd || '/unknown') === dd.key);
          if (items.length) { this._renderMobileFolderDetail(dd.key, dd.label, items, sessions); return; }
        } else if (dd.type === 'group') {
          // dd.key is a task id (or '__ungrouped__' for untagged)
          const sessionById = new Map();
          for (const s of sessions) { sessionById.set(this._getSessionStateKey(s), s); sessionById.set(s.sessionId, s); }
          if (dd.key === '__ungrouped__') {
            const assignedIds = new Set();
            for (const t of this._tasks || []) this._getTaskSessionKeys(t, sessions).forEach(id => assignedIds.add(id));
            // Live/tmux only — matches _renderMobileTaskList (the unfiltered
            // tasks-tab list holds thousands of stopped sessions; rendering
            // them all in the drill-down would freeze the phone).
            const untagged = sessions.filter(s => (s.status === 'live' || s.status === 'tmux')
              && !assignedIds.has(this._getSessionStateKey(s)) && !assignedIds.has(s.sessionId));
            if (untagged.length) { this._renderMobileTaskDetail(tr('Untagged'), untagged, sessions); return; }
          } else {
            const task = this._taskById(dd.key);
            if (task) {
              const ids = this._getTaskSessionKeys(task, sessions);
              const taskSessions = [...ids].map(id => sessionById.get(id)).filter(Boolean);
              if (taskSessions.length) { this._renderMobileTaskDetail(task.title, taskSessions, sessions); return; }
            }
          }
        }
        this._mobileDrilldown = null; // fallback to list if drill-down target gone
      }
      if (this._activeTab === 'mounts') { if (!this.listEl.querySelector('.mounts-panel')) this._renderMounts(); }
      else if (this._activeTab === 'tasks') this._renderMobileTaskBoard(sessions);
      // Sessions tab uses the same three-zone workbench as desktop — it's a
      // plain vertical card list (no hover-only affordances), so it's more
      // touch-friendly than the old two-level folder drill-down.
      else this._renderWorkbench(sessions);
    } else {
      if (this._activeTab === 'mounts') { if (!this.listEl.querySelector('.mounts-panel')) this._renderMounts(); }
      else if (this._activeTab === 'tasks') this._renderTaskBoard(sessions);
      else this._renderWorkbench(sessions);
    }
  }

  // Rendering methods (_renderGrouped, _buildSessionCard) installed by sidebar-render.js; task board by sidebar-tasks.js
  // installed by sidebar-render.js mixin

}

installSidebarState(Sidebar);
installSidebarRender(Sidebar);
installSidebarRenderMobile(Sidebar);
installSidebarMounts(Sidebar);
installSidebarRail(Sidebar);
installSidebarWorkbench(Sidebar);
installSidebarTasks(Sidebar);
export { Sidebar };
