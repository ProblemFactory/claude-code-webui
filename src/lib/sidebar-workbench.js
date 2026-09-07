// Three-zone workbench rendering for the Folders tab (2026-07 redesign).
// The old flat folder grouping drowned ~8 live sessions in thousands of
// stopped ones. Zones:
//   ACTIVE  — every running session, two-line cards (name+badges / dim path)
//             with a per-project colored strip; adjacent by project.
//   RECENT  — stopped sessions with activity in the last 7 days, grouped by
//             project (the realistic resume targets).
//   HISTORY — everything older; collapsed and SEARCH-FIRST (typing in the
//             main filter searches it; expanding renders capped pages).
// Starred sessions float to the top of their zone.
import { t as tr } from './i18n.js'; // sidebar cluster convention
import { agoText, escHtml, hostStateChip, showConfirmDialog, showToast, stripCwdHostLabel, sessionMatchesFilter } from './utils.js';

const RECENT_MS = 7 * 86400e3;
const HISTORY_PAGE = 60;

// Stable project color: hash cwd → hue (used for the ACTIVE strip)
function projectHue(cwd) {
  let h = 0;
  for (const c of cwd || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function abbrevPath(cwd) {
  if (!cwd) return '';
  const p = cwd.replace(/^\/home\/[^/]+/, '~');
  const parts = p.split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
}

// Stable per-host color (inner strip on cards/heads — the outer strip stays
// the project color; absence of an inner strip = this machine).
function hostColor(hostId) {
  return `hsl(${projectHue('host:' + hostId)} 70% 45%)`;
}
function applyHostStrip(el, hostId) {
  if (!hostId) return;
  el.classList.add('wb-host-strip');
  el.style.setProperty('--wb-host-color', hostColor(hostId));
}

export function installSidebarWorkbench(Sidebar) {
  Object.assign(Sidebar.prototype, {

    // ── RECENT host switcher (remote session discovery over ssh) ──

    _buildRecentHead(recentHost, localCount, zoneHead) {
      const st = recentHost ? this._remoteHostState(recentHost) : null;
      // remote count = only the RECENT-window slice (older ones count under History)
      const cutoff = Date.now() - RECENT_MS;
      const count = recentHost
        ? (st?.sessions
          ? st.sessions.filter(s => (s.mtime || 0) >= cutoff || s.status === 'remote-running').length : '…')
        : localCount;
      const h = zoneHead(tr('Recent'), count);
      this._ensureHostsData();
      const hostsList = this._hostsData?.hosts || [];
      if (hostsList.length || recentHost) {
        h.appendChild(this._buildHostSelect(recentHost, (v) => {
          this._wbRecentHost = v;
          localStorage.setItem('wbRecentHost', v);
          this._render();
        }));
        if (recentHost) h.appendChild(this._buildRescanBtn(recentHost, st));
        const chip = this._wbHostHeadChip(st);
        if (chip) h.appendChild(chip);
      }
      return h;
    },

    // ⟳ re-scan, shared by the Recent and History zone heads. IN-FLIGHT STATE
    // IS MANDATORY (campaign finding): with a cached list already on screen a
    // re-scan re-rendered the OLD list unchanged — no spinner, no disable — so
    // on a slow host (12s device deadline + 20s ssh) nothing appeared to
    // happen for tens of seconds and users re-clicked.
    _buildRescanBtn(hostId, st) {
      const rf = document.createElement('button');
      rf.className = 'wb-recent-refresh';
      const busy = !!st?.loading;
      rf.title = busy ? tr('Scanning this host…') : tr('Re-scan sessions on this host');
      rf.disabled = busy;
      rf.style.opacity = busy ? '0.45' : '';
      rf.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2v3h-3"/></svg>';
      rf.onclick = (e) => { e.stopPropagation(); this._loadRemoteHost(hostId, { fresh: true }); };
      return rf;
    },

    // Compact head chip: the zone count alone can't distinguish "scanning" /
    // "serving cache because the host is dead" / "fresh" — a dead host's
    // hours-old scan rendered exactly like a healthy one.
    _wbHostHeadChip(st) {
      if (!st) return null;
      if (st.loading) return hostStateChip('pending', { text: tr('scanning…'), title: tr('Scanning sessions over ssh…') });
      if (st.error) return hostStateChip('error', { text: tr('unreachable'), title: st.error });
      const at = this._wbSnapshotAt(st);
      if (at && Date.now() - at > 120000) return hostStateChip('stale', { age: at, title: tr('One-shot scan — click ⟳ to re-scan this host.') });
      return null;
    },

    // Age of the rendered snapshot: our own fetch time, else the server's
    // last-known marker (hosts.discoverSessions serves {stale, staleAt} when
    // the machine is unreachable).
    _wbSnapshotAt(st) {
      if (!st) return 0;
      const marked = (st.sessions || []).find(s => s.staleAt)?.staleAt || 0;
      return marked || st.fetchedAt || 0;
    },

    // Full-width state row above a remote zone's content. Silence here was the
    // lie: an unreachable host's cached list rendered as live discovery.
    _wbHostStateRow(st, hostLabel) {
      if (!st) return;
      const cached = (st.sessions || []).length;
      let text = '', chip = null;
      const at = this._wbSnapshotAt(st);
      if (st.error && cached) {
        text = tr('Showing cached results — {host} is unreachable.', { host: hostLabel });
        chip = hostStateChip('error', { text: at ? tr('as of {ago}', { ago: agoText(at) }) : tr('unreachable'), title: st.error });
      } else if (st.loading && cached) {
        text = tr('Re-scanning {host}…', { host: hostLabel });
        chip = hostStateChip('pending', { text: tr('scanning…') });
      } else if (cached && (st.sessions || []).some(s => s.stale)) {
        text = tr('Last known scan — {host} was unreachable.', { host: hostLabel });
        chip = hostStateChip('stale', { age: at, title: tr('Session states may have changed since this scan.') });
      } else if (at && Date.now() - at > 120000) {
        text = tr('Remote sessions are scanned once, not polled.');
        chip = hostStateChip('stale', { age: at, title: tr('Click ⟳ to re-scan this host.') });
      } else return;
      const row = document.createElement('div');
      row.className = 'wb-empty wb-host-state-row';
      const label = document.createElement('span');
      label.textContent = text + ' ';
      row.append(label, chip);
      this.listEl.appendChild(row);
    },

    _ensureHostsData() {
      // RETRYABLE (campaign finding): the old version set _hostsDataLoading and
      // never reset it on failure, and stored a non-ok `{error}` body (truthy)
      // as the cache — so ONE boot fetch landing in a server-restart window
      // killed the Recent/History host switchers AND cross-host search for the
      // whole page lifetime, silently and with no retry.
      if (this._hostsDataLoading) return;
      if (Array.isArray(this._hostsData?.hosts)) return;
      if (this._hostsDataFailAt && Date.now() - this._hostsDataFailAt < 5000) return; // backoff: every render calls this
      this._hostsDataLoading = true;
      fetch('/api/hosts').then(r => r.json()).then(d => {
        if (!Array.isArray(d?.hosts)) throw new Error(d?.error || 'bad /api/hosts response');
        this._hostsData = d;
        this._hostsDataFailAt = 0;
        // re-render when hosts are known OR a remote selection is pending —
        // with ZERO remaining hosts the heal above still needs a render pass
        if (d.hosts.length || this._wbRecentHost || this._wbHistoryHost) this._render();
      }).catch(() => { this._hostsDataFailAt = Date.now(); })
        .finally(() => { this._hostsDataLoading = false; });
    },

    // The server PUSHES a host's recomputed session list whenever its
    // discovery goes stale (remote create/terminate/external-kill/device
    // watch). We never re-fetch on that signal: the computation belongs to the
    // machine that owns the facts, and one dirty event must cost one
    // computation no matter how many clients are connected. Without this a
    // terminated remote session stayed "live" in Recent until a manual ⟳ —
    // our per-host list has no TTL by design (a scan is expensive).
    _initRemoteDirtySync() {
      if (this._remoteDirtyInit) return;
      this._remoteDirtyInit = true;
      this.app.ws.onGlobal((msg) => {
        if (msg?.type !== 'remote-sessions' || !msg.hostId) return;
        const id = msg.hostId, map = this._wbRemoteHosts;
        if (!map?.has(id)) return;   // never seen this host — nothing to correct
        const cur = map.get(id);
        if (msg.error) {
          // keep the last good list, labelled — same degrade as a failed pull
          map.set(id, { loading: false, sessions: cur?.sessions || null, error: msg.error, fetchedAt: cur?.fetchedAt || 0, lastFailAt: Date.now() });
        } else {
          map.set(id, { loading: false, sessions: msg.sessions || [], error: null, fetchedAt: msg.at || Date.now(), lastFailAt: 0 });
        }
        if (this._wbRecentHost === id || this._wbHistoryHost === id || (document.getElementById('session-filter')?.value || '').trim()) this._render();
      });
    },

    // Per-host discovery cache — Recent and History can point at DIFFERENT
    // hosts simultaneously; a shared host costs one fetch.
    _loadRemoteHost(hostId, { fresh = false } = {}) {
      this._initRemoteDirtySync();
      const map = this._wbRemoteHosts = this._wbRemoteHosts || new Map();
      const cur = map.get(hostId);
      if (!fresh && cur && (cur.loading || cur.sessions)) return;
      // BACKOFF after a failed scan (campaign finding): the catch branch used
      // to store sessions:null, which the guard above reads as "never loaded",
      // so a failing fetch (server restarting, a proxy 502 whose HTML breaks
      // r.json()) re-fired from EVERY render in a tight loop — and each retry
      // wiped the error, leaving a permanent "Scanning sessions over ssh…" row
      // as the only visible state.
      if (!fresh && cur?.lastFailAt && Date.now() - cur.lastFailAt < 10000) return;
      map.set(hostId, { loading: true, sessions: cur?.sessions || null, error: cur?.error || null, fetchedAt: cur?.fetchedAt || 0, lastFailAt: cur?.lastFailAt || 0 });
      if (fresh) this._render(); // in-flight state (⟳ disabled + "scanning…" chip) must show immediately
      // re-render for the selected zones OR whenever a search is active (so
      // cross-host search matches appear as each host's scan lands)
      const relevant = () => this._wbRecentHost === hostId || this._wbHistoryHost === hostId || !!(document.getElementById('session-filter')?.value || '').trim();
      fetch(`/api/hosts/${hostId}/sessions${fresh ? '?fresh=1' : ''}`)
        .then(async (r) => {
          const d = await r.json().catch(() => null);
          if (!r.ok || !d || d.error) throw new Error(d?.error || `${r.status} ${r.statusText || 'discovery failed'}`);
          return d;
        })
        .then(d => {
          map.set(hostId, { loading: false, sessions: d.sessions || [], error: null, fetchedAt: Date.now(), lastFailAt: 0 });
          if (relevant()) this._render();
        })
        .catch(e => {
          // KEEP the last good list — an unreachable host must degrade to a
          // labelled "cached results" zone, never to an empty one.
          const prev = map.get(hostId);
          map.set(hostId, { loading: false, sessions: prev?.sessions || null, error: e.message, fetchedAt: prev?.fetchedAt || 0, lastFailAt: Date.now() });
          if (relevant()) this._render();
        });
    },

    _remoteHostState(hostId) { return this._wbRemoteHosts?.get(hostId) || null; },

    // Compact host <select> shared by the Recent and History zone heads
    // SELF-HEAL a persisted host selection whose record no longer exists
    // (2.334.1, real fleet report): a removed host left wbRecentHost/
    // wbHistoryHost pointing at a ghost id — the <select> rendered BLANK (a
    // value with no matching option) and the zone bricked on 'host not found'
    // forever, with no affordance hinting the fix. Heal ONLY against a
    // successfully LOADED roster (transient /api/hosts failures must not wipe
    // a valid pick). Returns the healed value.
    _wbValidHost(id, storageKey, memKey) {
      if (!id) return id;
      const hosts = this._hostsData?.hosts;
      if (!Array.isArray(hosts)) return id; // roster not loaded yet — keep
      if (hosts.some(h => h.id === id)) return id;
      this[memKey] = '';
      try { localStorage.setItem(storageKey, ''); } catch { }
      if (!this._wbHealToasted) {
        this._wbHealToasted = true;
        try { showToast(tr('Switched back to Local — the previously selected remote host no longer exists.')); } catch { }
      }
      return '';
    },

    _buildHostSelect(value, onchange) {
      const sel = document.createElement('select');
      sel.className = 'wb-recent-host';
      sel.title = 'Show sessions from this machine or a remote host';
      sel.innerHTML = `<option value="">${tr('Local')}</option>`;
      for (const hh of this._hostsData?.hosts || []) {
        const o = document.createElement('option');
        o.value = hh.id; o.textContent = hh.name;
        sel.appendChild(o);
      }
      sel.value = value;
      sel.onclick = (e) => e.stopPropagation();
      sel.onchange = () => onchange(sel.value);
      return sel;
    },

    _wbEmptyRow(text) {
      const e = document.createElement('div');
      e.className = 'wb-empty';
      e.textContent = text;
      this.listEl.appendChild(e);
    },

    _wbFilterRemote(sessions) {
      // Dedup vs the live list: a remote session that's CURRENTLY a live
      // webui-managed session (resumed/attached here) already shows in the
      // Running list — don't ALSO render its stale discovered card. Remote chat
      // has no remote dtach lock, so discovery reports it 'stopped' while it's
      // live locally → the same session appeared twice (live + stopped). Session
      // ids are UUIDs (collision-free) so matching on id alone is safe.
      const liveIds = new Set();
      for (const x of this._allSessions || []) {
        if (x.status !== 'live') continue;
        const id = x.backendSessionId || x.claudeSessionId; if (id) liveIds.add(id);
      }
      let list = liveIds.size ? sessions.filter(s => !liveIds.has(s.sessionId)) : sessions;
      const f = (document.getElementById('session-filter')?.value || '').toLowerCase().trim();
      if (!f) return list;
      return list.filter(s => this._wbMatchRemote(s, f));
    },

    // ONE matcher for discovered remote sessions, shared with the cross-host
    // search below. The LOCAL filter (_renderInner) also matches backend /
    // agent fields, so e.g. "codex" listed every local codex session and NOT
    // ONE remote codex rollout — the same query silently meant different
    // things per machine.
    _wbMatchRemote(s, f) { return sessionMatchesFilter(s, f); },

    // Cross-host remote search: when the sidebar filter is active, surface
    // matching sessions from EVERY loaded remote host (skipping skipHost, which
    // the switcher already renders). Deduped against live webui sessions.
    _renderRemoteSearchAll(f, skipHost) {
      const hosts = this._hostsData?.hosts || [];
      if (!hosts.length) return;
      const liveIds = new Set();
      for (const x of this._allSessions || []) if (x.status === 'live') { const id = x.backendSessionId || x.claudeSessionId; if (id) liveIds.add(id); }
      let headDone = false;
      const ensureHead = () => {
        if (headDone) return;
        const hd = document.createElement('div'); hd.className = 'wb-zone-head';
        hd.innerHTML = `<span class="wb-zone-title">${escHtml(tr('Remote matches'))}</span>`;
        this.listEl.appendChild(hd); headDone = true;
      };
      // A scan takes up to ~32s per slow host and used to render NOTHING while
      // in flight (and nothing at all for a host whose scan failed — its error
      // only ever showed when that host was selected in a zone switcher), so
      // the user concluded "no remote matches" from a still-running search.
      const stateRow = (state, text, chipText, title) => {
        ensureHead();
        const row = document.createElement('div');
        row.className = 'wb-empty wb-host-state-row';
        const label = document.createElement('span');
        label.textContent = text + ' ';
        row.append(label, hostStateChip(state, { text: chipText, title }));
        this.listEl.appendChild(row);
      };
      for (const h of hosts) {
        if (h.id === skipHost) continue;
        const st = this._remoteHostState(h.id);
        const hname = st?.sessions?.[0]?.hostName || h.name || h.id;
        if (!st || (st.loading && !st.sessions)) { stateRow('pending', tr('Searching {host}…', { host: hname }), tr('scanning…')); continue; }
        if (st.error && !st.sessions?.length) { stateRow('error', tr('Search on {host} failed.', { host: hname }), tr('unreachable'), st.error); continue; }
        if (!st.sessions) continue;
        const matches = st.sessions.filter(s => !liveIds.has(s.sessionId) && this._wbMatchRemote(s, f));
        if (st.error) stateRow('error', tr('Showing cached results — {host} is unreachable.', { host: hname }), tr('unreachable'), st.error);
        if (!matches.length) continue;
        ensureHead();
        const hlabel = hname;
        const color = `hsl(${projectHue('host:' + h.id)} 55% 52%)`;
        for (const s of matches.slice(0, 20)) {
          const card = this._buildRemoteCard(s);
          card.classList.add('wb-proj-card');
          card.style.setProperty('--wb-strip', color);
          card.title = hlabel + ': ' + (s.cwd || s.projDir || '');
          applyHostStrip(card, h.id);
          this.listEl.appendChild(card);
        }
      }
    },

    // Renders the RECENT slice (last 7 days) of a remote host's sessions.
    // (History has its own independent host switcher — see the History zone.)
    _renderRemoteRecent(hostId) {
      this._loadRemoteHost(hostId);
      const st = this._remoteHostState(hostId);
      const empty = (t) => this._wbEmptyRow(t);
      const hostLabelFallback = this._hostsData?.hosts?.find(x => x.id === hostId)?.name || hostId;
      if (!st || (st.loading && !st.sessions)) { empty(tr('Scanning sessions over ssh…')); return; }
      // A failed re-scan with a cached list must SHOW the cached list under an
      // honest banner — bailing to a bare error row threw away sessions the
      // user could still resume.
      if (st.error && !st.sessions?.length) { empty(tr('Discovery failed: {err}', { err: st.error })); return; }
      this._wbHostStateRow(st, hostLabelFallback);
      const all = this._wbFilterRemote(st.sessions || []);
      const cutoff = Date.now() - RECENT_MS;
      // SEARCHING = search EVERYTHING on this host (2.124.0 parity fix): the
      // recency cutoff hid old sessions from an id search, and the cross-host
      // "Remote matches" section deliberately skips the SELECTED host — so an
      // old session here was findable nowhere. _wbFilterRemote already applied
      // the text filter (name/cwd/session id).
      const searching = !!(document.getElementById('session-filter')?.value || '').trim();
      const sessions = searching ? all : all.filter(s => (s.mtime || 0) >= cutoff || s.status === 'remote-running');
      if (!all.length) { empty('No sessions found on ' + hostLabelFallback); return; }
      if (!sessions.length) { empty(tr('Nothing in the last 7 days on {host} — check History below', { host: hostLabelFallback })); return; }
      const byProj = new Map();
      for (const s of sessions) {
        const k = s.cwd || `(${s.projDir || 'unknown'})`;
        if (!byProj.has(k)) byProj.set(k, []);
        byProj.get(k).push(s);
      }
      const hostLabel = st.sessions[0]?.hostName || hostId;
      for (const [cwd, list] of byProj) {
        // color key includes the host so the devbox:/tmp never shares a color with local /tmp
        const color = `hsl(${projectHue(hostLabel + ': ' + cwd)} 55% 52%)`;
        const head = document.createElement('div');
        head.className = 'wb-proj-head';
        head.title = hostLabel + ': ' + cwd;
        head.style.setProperty('--wb-proj-color', color);
        applyHostStrip(head, hostId);
        head.innerHTML = `<span class="wb-proj-dot"></span><span class="wb-proj-name">${escHtml(abbrevPath(cwd))}</span><span class="wb-zone-count">${list.length}</span>`;
        if (!cwd.startsWith('(')) {
          const plus = document.createElement('button');
          plus.className = 'wb-proj-plus';
          plus.textContent = '+';
          plus.title = `New session here on ${hostLabel}`;
          plus.onclick = (e) => { e.stopPropagation(); this.app.showNewSessionDialog({ cwd, hostId }); };
          head.appendChild(plus);
        }
        this.listEl.appendChild(head);
        const key = `remote:${hostId}:${cwd}`;
        const expanded = this._wbProjExpanded?.has(key);
        const shown = expanded ? list : list.slice(0, 5);
        for (const s of shown) {
          const card = this._buildRemoteCard(s);
          card.classList.add('wb-proj-card');
          card.style.setProperty('--wb-strip', color);
          applyHostStrip(card, hostId);
          this.listEl.appendChild(card);
        }
        if (list.length > shown.length) {
          const more = document.createElement('button');
          more.className = 'wb-more';
          more.textContent = `${list.length - shown.length} more…`;
          more.onclick = () => {
            (this._wbProjExpanded = this._wbProjExpanded || new Set()).add(key);
            this._render();
          };
          this.listEl.appendChild(more);
        }
      }
    },

    // Map a discovered remote session to the FULL session-card shape — remote
    // sessions get the same first-class cards as local ones (name from the
    // first user message, star/archive, expand panel, View History, Resume);
    // hostId rides in via the card's agentOpts so resume/view run on the host.
    _remoteToCardSession(s) {
      const folder = (s.cwd || '').split('/').pop();
      return {
        sessionId: s.sessionId,
        backendSessionId: s.sessionId,
        backend: s.backend || 'claude', // codex rollouts ride discovery too (B-10ed)
        name: s.name || folder || s.projDir || s.sessionId.slice(0, 8),
        cwd: s.cwd || '',
        host: s.host,
        hostName: s.hostName,
        // keeper-managed remote claude (B-4058): the remote daemon+claude
        // survived a pod rebuild/local loss — present as resumable; Resume
        // ADOPTS the live process via keeper-attach instead of respawning.
        status: s.keeperSid ? 'stopped' : (s.status === 'remote-running' ? 'external' : 'stopped'),
        keeperSid: s.keeperSid || undefined,
        // pid travels from the host's lock file → Terminate on an EXTERNAL
        // remote card can reach killRemotePid (without it the card's confirm
        // dialog ended in a silent no-op — real report, 2.191.0)
        pid: s.pid || undefined,
        // LAST-KNOWN marker (campaign finding): hosts.discoverSessions serves a
        // previous scan tagged {stale, staleAt} when the machine is
        // unreachable. The whitelist dropped both fields, so an hours-old
        // snapshot — including 'external' cards implying live processes that
        // may have exited long ago — rendered exactly like fresh discovery.
        stale: s.stale || undefined,
        staleAt: s.staleAt || undefined,
        startedAt: s.mtime,
      };
    },

    _buildRemoteCard(s) {
      return this._buildSessionCard(this._remoteToCardSession(s));
    },

    _toggleManageMark(key, kind) {
      const marks = this._manageMarks = this._manageMarks || new Map();
      const cur = marks.get(key) || {};
      cur[kind] = !cur[kind];
      if (!cur.terminate && !cur.archive) marks.delete(key); else marks.set(key, cur);
      this._render();
    },

    _buildManageBar() {
      const marks = this._manageMarks || new Map();
      let nTerm = 0, nArch = 0;
      for (const m of marks.values()) { if (m.terminate) nTerm++; if (m.archive) nArch++; }
      const bar = document.createElement('div');
      bar.className = 'wb-manage-bar';
      const label = document.createElement('div');
      label.className = 'wb-manage-label';
      if (!marks.size) {
        label.innerHTML = `<span class="wb-manage-hint">${tr('Tap cards to mark')}</span>`;
      } else {
        // icon + number chips — compact, fixed footprint (no text wrap)
        const TERM = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
        const ARCH = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M3 4v8a1 1 0 001 1h8a1 1 0 001-1V4"/><path d="M6.5 8h3"/></svg>';
        label.innerHTML = `<span class="wb-mark-chip wb-mark-term" title="${nTerm} to terminate"${nTerm ? '' : ' style="display:none"'}>${TERM}<b>${nTerm}</b></span>`
          + `<span class="wb-mark-chip wb-mark-arch" title="${nArch} to archive"${nArch ? '' : ' style="display:none"'}>${ARCH}<b>${nArch}</b></span>`;
      }
      const actions = document.createElement('div');
      actions.className = 'wb-manage-actions';
      const applyBtn = document.createElement('button');
      applyBtn.className = 'wb-manage-apply';
      applyBtn.textContent = tr('Apply');
      // hidden (not just disabled) when nothing's marked — frees the row so
      // the empty-state hint shows in full
      applyBtn.style.display = marks.size ? '' : 'none';
      applyBtn.onclick = () => this._applyManageMarks();
      const clearBtn = document.createElement('button');
      clearBtn.className = 'wb-manage-clear';
      clearBtn.textContent = marks.size ? 'Clear' : 'Done';
      clearBtn.onclick = () => {
        if (marks.size) { this._manageMarks = new Map(); this._render(); }
        else { this._manageMode = false; this.el.classList.remove('manage-mode'); document.getElementById('manage-toggle')?.classList.remove('active'); this._render(); }
      };
      actions.append(applyBtn, clearBtn);
      bar.append(label, actions);
      return bar;
    },

    async _applyManageMarks() {
      const marks = this._manageMarks || new Map();
      if (!marks.size) return;
      const byKey = new Map();
      for (const s of this._allSessions || []) {
        const k = this._getSessionStateKey(s) || s.sessionId;
        if (marks.has(k) && !byKey.has(k)) byKey.set(k, s);
      }
      // Remote DISCOVERED cards carry the same mark buttons but live in the
      // per-host discovery cache, NOT _allSessions — their marks fell into the
      // `if (!s) continue` hole below while the closing toast still claimed
      // success, so "terminate" on a remote external claude was a silent
      // no-op and the process kept running.
      for (const st of (this._wbRemoteHosts?.values() || [])) {
        for (const rs of st?.sessions || []) {
          const cs = this._remoteToCardSession(rs);
          const k = this._getSessionStateKey(cs) || cs.sessionId;
          if (marks.has(k) && !byKey.has(k)) byKey.set(k, cs);
        }
      }
      const termList = [], archList = [];
      let skipped = 0;
      for (const [k, m] of marks) {
        const s = byKey.get(k);
        if (!s) { skipped++; continue; } // card gone from every list (refreshed away)
        if (m.terminate) {
          // no webuiId AND no pid = nothing to kill; counting it as applied
          // was the same lie as dropping the mark entirely
          if (s.webuiId || s.pid) termList.push(s); else skipped++;
        }
        if (m.archive) archList.push(s);
      }
      const parts = [];
      if (termList.length) parts.push(tr('terminate {n}', { n: termList.length }));
      if (archList.length) parts.push(tr('archive {n}', { n: archList.length }));
      if (!parts.length) {
        showToast(tr('Nothing to apply — {n} marked session(s) could no longer be found', { n: skipped }), { type: 'error' });
        return;
      }
      const ok = await showConfirmDialog({
        title: tr('Apply batch actions'),
        message: tr('About to {what}. Terminating kills the running agent process.', { what: parts.join(' + ') })
          + (skipped ? ' ' + tr('{n} marked session(s) will be skipped — they are no longer in the list.', { n: skipped }) : ''),
        confirmText: tr('Apply'), danger: true,
      });
      if (!ok) return;
      // terminate first (kills), then archive the rest
      for (const s of termList) {
        // s.host is MANDATORY for a remote pid — the host-less local route
        // 400s silently (the exact bug fixed on the card's own Terminate in
        // 2.191.0); killPid surfaces its own failure toast either way.
        if (s.webuiId) this.app.killSession(s.webuiId);
        else if (s.pid) this.app.killPid(s.pid, s.host);
      }
      // archive as a batch — toggle the set directly, single state push + render
      for (const s of archList) {
        const sk = this._getSessionStateKey(s);
        if (!sk) continue;
        if (this._stateSetHas(this._archivedIds, s)) {
          this._archivedIds.delete(sk);
          const legacy = this._getLegacySessionId(s);
          if (legacy) this._archivedIds.delete(legacy);
          this._dissolveFolderArchive(s, sk); // folder rule would re-archive it otherwise
        } else if (this._isFolderArchived(s)) {
          this._dissolveFolderArchive(s, sk); // archived only via folder rule → unarchive
        } else {
          this._archivedIds.add(sk);
        }
      }
      if (archList.length) { this._pushUserState(); this.app.updateTaskbar(); }
      this._manageMarks = new Map();
      showToast(skipped
        ? tr('{what} applied, {n} skipped', { what: parts.join(', '), n: skipped })
        : tr('{what} applied', { what: parts.join(', ') }), skipped ? { type: 'error' } : undefined);
      this._render();
    },

    _renderWorkbench(sessions) {
      this.listEl.innerHTML = '';
      // Manage mode batch bar — both the "you're in batch management" marker
      // and the apply/clear controls. Marks are collected on the cards; this
      // bar commits them all at once so the list never reshuffles mid-select.
      if (this._manageMode) this.listEl.appendChild(this._buildManageBar());
      // A harness whose STOPPED conversations live behind an opt-in background
      // service (opencode → the 'opencode-serve' plugin, OFF by default since
      // 2026-09-07) must SAY that its history is missing — otherwise this list
      // is silently incomplete, which reads exactly like a bug. It belongs
      // HERE, not in _renderInner: the workbench wipes listEl and owns the
      // sessions list on desktop AND mobile. Shown only once the user has met
      // the harness here (a session in the list, or we already offered the
      // service); ⚙ → Plugins stays the other way back.
      this._renderServiceHintRows?.(sessions);
      const now = Date.now();
      const isLive = (s) => s.status === 'live' || s.status === 'tmux' || s.status === 'external' || s.status === 'remote-running';
      const live = sessions.filter(isLive);
      const stopped = sessions.filter(s => !isLive(s));
      const recent = stopped.filter(s => now - (s.startedAt || 0) < RECENT_MS);
      const history = stopped.filter(s => now - (s.startedAt || 0) >= RECENT_MS);

      const byStarThenProject = (a, b) =>
        (this.isStarred(b) - this.isStarred(a))
        || String(a.cwd || '').localeCompare(String(b.cwd || ''))
        || (b.startedAt || 0) - (a.startedAt || 0);
      live.sort(byStarThenProject);
      recent.sort((a, b) => (this.isStarred(b) - this.isStarred(a)) || (b.startedAt || 0) - (a.startedAt || 0));
      history.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

      const zoneHead = (label, count) => {
        const h = document.createElement('div');
        h.className = 'wb-zone-head';
        h.innerHTML = `<span>${label}</span><span class="wb-zone-count">${count}</span>`;
        return h;
      };

      // ── ACTIVE ──
      this.listEl.appendChild(zoneHead(tr('Active'), live.length));
      if (!live.length) {
        const e = document.createElement('div');
        e.className = 'wb-empty';
        e.textContent = tr('No running sessions');
        this.listEl.appendChild(e);
      }
      for (const s of live) {
        const card = this._buildSessionCard(s);
        card.classList.add('wb-active-card');
        // Same per-project color strip as the Recent zone — a running session
        // and its Recent siblings share a color so you can tie them to one
        // project at a glance (the Recent header's colored dot names it).
        card.style.setProperty('--wb-strip', `hsl(${projectHue(s.cwd)} 55% 52%)`);
        applyHostStrip(card, s.host); // inner strip: which MACHINE (mixed zone)
        // second line: dim path — the context that keeps similarly-named
        // sessions distinguishable. The HOST prefix renders as its OWN
        // non-truncating span and the path CSS-left-truncates (real report:
        // abbrevPath over the host-prefixed cwd string ATE the "CW-H200: "
        // prefix on deeper paths — the card looked local — and its baked "…/"
        // never restored when the sidebar was widened again; pure CSS
        // truncation re-evaluates with width).
        const pathEl = document.createElement('div');
        pathEl.className = 'wb-card-path';
        pathEl.title = (s.hostName ? s.hostName + ': ' : '') + (s.cwd || '');
        // normalize BOTH data shapes: matched sessions carry a raw cwd,
        // unmatched webui ones a "Host: /path"-composed one (folder grouping)
        let rawPath = s.cwd || '';
        if (s.hostName && rawPath.startsWith(s.hostName + ': ')) rawPath = rawPath.slice(s.hostName.length + 2);
        if (s.hostName) {
          const hostSpan = document.createElement('span');
          hostSpan.className = 'wb-card-path-host';
          hostSpan.textContent = s.hostName + ':';
          pathEl.appendChild(hostSpan);
        }
        const textSpan = document.createElement('span');
        textSpan.className = 'wb-card-path-text';
        textSpan.textContent = rawPath.replace(/^\/home\/[^/]+/, '~');
        pathEl.appendChild(textSpan);
        const row = card.querySelector('.session-card-row');
        row?.after(pathEl);
        this.listEl.appendChild(card);
      }

      // ── RECENT (last 7 days, grouped by project; host-switchable) ──
      // Selecting a remote host swaps this zone to live ssh discovery of that
      // machine's ~/.claude sessions (lock-first, 15s server cache) — stopped
      // remote sessions become visible and resumable, with zero polling cost
      // while the zone shows Local.
      const recentHost = this._wbValidHost(this._wbRecentHost ?? (this._wbRecentHost = localStorage.getItem('wbRecentHost') || ''), 'wbRecentHost', '_wbRecentHost');
      this.listEl.appendChild(this._buildRecentHead(recentHost, recent.length, zoneHead));
      // With an active search query, sidebar search covers EVERY configured
      // remote host (not just the one selected in the switcher). Loads them on
      // demand and renders cross-host matches (the selected host is skipped —
      // _renderRemoteRecent below already shows it).
      const _wbQ = (document.getElementById('session-filter')?.value || '').toLowerCase().trim();
      if (_wbQ) { this._ensureHostsData?.(); for (const h of (this._hostsData?.hosts || [])) if (h.id !== recentHost) this._loadRemoteHost(h.id); this._renderRemoteSearchAll(_wbQ, recentHost); }
      if (recentHost) {
        this._renderRemoteRecent(recentHost);
      } else {
      const byProj = new Map();
      for (const s of recent) {
        const k = s.cwd || '(unknown)';
        if (!byProj.has(k)) byProj.set(k, []);
        byProj.get(k).push(s);
      }
      for (const [cwd, list] of byProj) {
        // Per-project color, applied at PROJECT level (header + its cards) so
        // the color↔project mapping is unambiguous — a colored dot on the
        // header names the color, the cards share the left strip.
        const hue = projectHue(cwd);
        const color = `hsl(${hue} 55% 52%)`;
        const head = document.createElement('div');
        head.className = 'wb-proj-head';
        head.title = cwd;
        head.style.setProperty('--wb-proj-color', color);
        head.innerHTML = `<span class="wb-proj-dot"></span><span class="wb-proj-name">${escHtml(abbrevPath(cwd))}</span><span class="wb-zone-count">${list.length}</span>`;
        // Archive the WHOLE project in one click — the fast path for folders
        // full of throwaway sessions (observer swarms etc.). Archives the
        // FOLDER itself (archivedFolders), so sessions created here LATER
        // start archived too — per-session-only archiving let new sessions
        // pop back unarchived (the "archive didn't stick" complaint), plus
        // every current session under this cwd (recent + older/history).
        // When the folder is already archived (visible via the Archived
        // filter), the same button unarchives the whole project.
        const archAll = document.createElement('button');
        archAll.className = 'wb-proj-archive';
        const folderArchived = this.isFolderArchived(cwd);
        archAll.innerHTML = folderArchived
          ? '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M3 4v8a1 1 0 001 1h8a1 1 0 001-1V4"/><path d="M8 11V7M6 9l2-2 2 2"/></svg>'
          : '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M3 4v8a1 1 0 001 1h8a1 1 0 001-1V4"/><path d="M6.5 8h3"/></svg>';
        if (folderArchived) {
          archAll.title = 'Unarchive this project (folder + all its sessions)';
          archAll.onclick = (e) => { e.stopPropagation(); this.unarchiveProject(cwd); };
        } else {
          const projAll = (this._allSessions || []).filter(s => (s.cwd || '(unknown)') === cwd && !this.isArchived(s));
          const nAll = projAll.length || list.length;
          archAll.title = `Archive this project (${nAll} session${nAll === 1 ? '' : 's'} + future sessions here)`;
          archAll.onclick = async (e) => {
            e.stopPropagation();
            const targets = (this._allSessions || []).filter(s => (s.cwd || '(unknown)') === cwd && !this.isArchived(s));
            const ok = await showConfirmDialog({ title: 'Archive project', message: `Archive all ${targets.length} session${targets.length === 1 ? '' : 's'} under ${abbrevPath(cwd)}? New sessions in this folder will start archived too (nothing is deleted; find them under the Archived filter).`, confirmText: 'Archive all', danger: false });
            if (ok) this.archiveProject(cwd, targets);
          };
        }
        head.appendChild(archAll);
        // one-click new session in this project (kept from the old folder header)
        const plus = document.createElement('button');
        plus.className = 'wb-proj-plus';
        plus.textContent = '+';
        plus.title = 'New session here';
        plus.onclick = (e) => { e.stopPropagation(); this.app.showNewSessionDialog({ cwd: stripCwdHostLabel(cwd) }); };
        head.appendChild(plus);
        this.listEl.appendChild(head);
        // cap per project — auto-generated session floods (observer swarms)
        // otherwise render thousands of "recent" cards
        const expanded = this._wbProjExpanded?.has(cwd);
        const shown = expanded ? list : list.slice(0, 5);
        for (const s of shown) {
          const card = this._buildSessionCard(s);
          card.classList.add('wb-proj-card');
          card.style.setProperty('--wb-strip', color);
          this.listEl.appendChild(card);
        }
        if (list.length > shown.length) {
          const more = document.createElement('button');
          more.className = 'wb-more';
          more.textContent = `${list.length - shown.length} more…`;
          more.onclick = () => {
            (this._wbProjExpanded = this._wbProjExpanded || new Set()).add(cwd);
            this._render();
          };
          this.listEl.appendChild(more);
        }
      }
      if (!recent.length) {
        const e = document.createElement('div');
        e.className = 'wb-empty';
        e.textContent = tr('Nothing stopped in the last 7 days');
        this.listEl.appendChild(e);
      }
      } // end local RECENT branch

      // ── HISTORY (collapsed, search-first, paged; own host switcher) ──
      const histHost = this._wbValidHost(this._wbHistoryHost ?? (this._wbHistoryHost = localStorage.getItem('wbHistoryHost') || ''), 'wbHistoryHost', '_wbHistoryHost');
      const histState = histHost ? this._remoteHostState(histHost) : null;
      const histLabel = histHost ? (this._hostsData?.hosts?.find(x => x.id === histHost)?.name || histHost) : '';
      if (histHost) this._loadRemoteHost(histHost);
      const cutoffH = Date.now() - RECENT_MS;
      const searchingH = !!(document.getElementById('session-filter')?.value || '').trim();
      const histList = histHost
        // while searching, the RECENT zone shows every match for its selected
        // host (cutoff dropped, 2.124.0) — suppress the duplicate here when the
        // history switcher points at the SAME host
        ? (searchingH && histHost === (this._wbRecentHost || '') ? []
          : this._wbFilterRemote(histState?.sessions || []).filter(s => (s.mtime || 0) < cutoffH && s.status !== 'remote-running'))
        : history;
      const histLoading = histHost && (!histState || (histState.loading && !histState.sessions));
      const hHead = document.createElement('div');
      hHead.className = 'wb-zone-head wb-history-head';
      const filterActive = !!(document.getElementById('session-filter')?.value || '').trim();
      const open = this._wbHistoryOpen || filterActive; // searching implies looking at history
      hHead.innerHTML = `<span class="wb-hist-arrow">${open ? '▾' : '▸'}</span><span>${tr('History')}</span><span class="wb-zone-count">${histLoading ? '…' : histList.length}</span>`;
      hHead.onclick = () => { this._wbHistoryOpen = !this._wbHistoryOpen; this._render(); };
      if ((this._hostsData?.hosts || []).length || histHost) {
        hHead.appendChild(this._buildHostSelect(histHost, (v) => {
          this._wbHistoryHost = v;
          localStorage.setItem('wbHistoryHost', v);
          if (v) this._wbHistoryOpen = true; // picking a host means you want to SEE it
          this._render();
        }));
        if (histHost) {
          hHead.appendChild(this._buildRescanBtn(histHost, histState));
          const chip = this._wbHostHeadChip(histState);
          if (chip) hHead.appendChild(chip);
        }
      }
      this.listEl.appendChild(hHead);
      if (open) {
        if (histHost) this._wbHostStateRow(histState, histLabel); // cached / unreachable / one-shot age
        if (histLoading) {
          this._wbEmptyRow(tr('Scanning sessions over ssh…'));
        } else if (histHost && histState?.error && !histState.sessions?.length) {
          this._wbEmptyRow(tr('Discovery failed: {err}', { err: histState.error }));
        } else if (!histList.length) {
          this._wbEmptyRow(histHost ? `No sessions older than 7 days on ${histLabel}` : 'No older sessions');
        }
        const cap = this._wbHistoryCap || HISTORY_PAGE;
        for (const s of histList.slice(0, cap)) {
          let card;
          if (histHost) {
            card = this._buildRemoteCard(s);
            card.classList.add('wb-proj-card');
            card.style.setProperty('--wb-strip', `hsl(${projectHue(histLabel + ': ' + (s.cwd || s.projDir || ''))} 55% 52%)`);
            applyHostStrip(card, histHost);
          } else {
            card = this._buildSessionCard(s);
          }
          this.listEl.appendChild(card);
        }
        if (histList.length > cap) {
          const more = document.createElement('button');
          more.className = 'wb-more';
          more.textContent = `Show more (${histList.length - cap} left)`;
          more.onclick = () => { this._wbHistoryCap = cap + HISTORY_PAGE * 4; this._render(); };
          this.listEl.appendChild(more);
        }
      } else if (histList.length) {
        const hint = document.createElement('div');
        hint.className = 'wb-empty';
        hint.textContent = tr('Type in the filter box to search, or click to expand');
        this.listEl.appendChild(hint);
      }
    },
  });
}
