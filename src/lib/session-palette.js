// Ctrl+K session palette — fuzzy switcher over every known session.
// Live sessions rank first; Enter focuses (live) or resumes (stopped);
// typing an absolute/~ path offers "new session here". Works everywhere
// except inside terminals (.xterm owns its keys).
import { escHtml } from './utils.js';
import { registerCommand, runCommand } from './contributions.js';

function subseq(t, s) {
  let qi = 0;
  for (let ci = 0; ci < s.length && qi < t.length; ci++) if (s[ci] === t[qi]) qi++;
  return qi === t.length;
}

// Match quality for one session. TOKENISED on whitespace with AND semantics —
// the whole-query-as-one-literal version could never match a CamelCase or
// hyphenated name (userW: typing "best ever" can never substring-hit
// "BestEver-ToB-signing"), so every multi-word query fell through to a
// subsequence over the ENTIRE haystack — cwd + three UUIDs — where the shared
// path prefix supplies almost any letter sequence. Result: every session tied
// at the same low score, the +live bonus then sorted all live sessions above
// every stopped one, and the 12-row cap cut the list before the stopped
// session he wanted could appear.
// So: each token must hit something; NAME hits outrank path/id hits; the fuzzy
// fallback is confined to the NAME (matching fuzzily against a UUID is noise).
function score(q, label, hay) {
  label = label.toLowerCase();
  hay = hay.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 1;
  let total = 0;
  for (const t of tokens) {
    const li = label.indexOf(t);
    if (li >= 0) { total += 1000 - Math.min(li, 200); continue; } // name hit, earlier = better
    const hi = hay.indexOf(t);
    if (hi >= 0) { total += 300; continue; }                      // path / host / id hit
    if (subseq(t, label)) { total += 100; continue; }             // fuzzy, NAME only
    return -1;                                                     // token matched nothing → reject
  }
  return total / tokens.length;
}

export function installSessionPalette(app) {
  let overlay = null;

  const close = () => { overlay?.remove(); overlay = null; };

  const activate = (s) => {
    close();
    const name = app.sidebar.getCustomName(s) || s.name || s.webuiName || '';
    if (s.webuiId) {
      app.attachSession(s.webuiId, s.webuiName || name, s.cwd, { mode: s.webuiMode, backend: s.backend || 'claude', backendSessionId: s.backendSessionId || s.sessionId });
    } else if (s.status === 'stopped' || s.status === 'external' || s.status === 'tmux') {
      // hostId is REQUIRED for remote sessions or resume runs locally against a
      // non-existent id (remote sessions reach the palette via _wbRemoteHosts now)
      app.resumeSession(s.sessionId, s.cwd, name, { backend: s.backend || 'claude', backendSessionId: s.backendSessionId || s.sessionId, hostId: s.host || undefined, keeperSid: s.keeperSid || undefined });
    }
  };

  const open = () => {
    if (overlay) { close(); return; }
    overlay = document.createElement('div');
    overlay.className = 'palette-overlay';
    overlay.innerHTML = `<div class="palette">
      <input class="palette-input" placeholder="Jump to a session… (type a /path for a new one)" autocomplete="off">
      <div class="palette-list"></div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    const input = overlay.querySelector('.palette-input');
    const listEl = overlay.querySelector('.palette-list');
    let items = [];
    let sel = 0;

    const render = () => {
      listEl.innerHTML = '';
      items.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'palette-item' + (i === sel ? ' active' : '');
        if (it.newSession) {
          row.innerHTML = `<span class="palette-name">New session in <b>${escHtml(it.cwd)}</b></span>`;
        } else {
          const s = it.s;
          const live = s.status === 'live' || s.status === 'tmux' || s.status === 'external';
          row.innerHTML = `
            <span class="palette-dot ${live ? 'on' : ''}"></span>
            <span class="palette-name">${escHtml(it.label)}</span>
            ${s.hostName ? `<span class="session-host-badge">${escHtml(s.hostName)}</span>` : ''}
            <span class="palette-path">${escHtml(s.cwd || '')}</span>`;
        }
        row.onclick = () => it.newSession ? (close(), app.showNewSessionDialog({ cwd: it.cwd })) : activate(it.s);
        row.onmousemove = () => { if (sel !== i) { sel = i; render(); } };
        listEl.appendChild(row);
      });
    };

    const refresh = () => {
      const q = input.value.trim().toLowerCase();
      const local = app.sidebar?._allSessions || [];
      if (q.startsWith('/') || q.startsWith('~')) {
        items = [{ newSession: true, cwd: input.value.trim() }];
        sel = 0; render(); return;
      }
      // Include REMOTE-discovered sessions (Ctrl+K used to search only _allSessions
      // = local + live-remote, never remote STOPPED sessions — real report). Pull
      // whatever's already discovered per host, deduped against live ids.
      const liveIds = new Set();
      for (const s of local) if (s.status === 'live') { const id = s.backendSessionId || s.claudeSessionId; if (id) liveIds.add(id); }
      const remote = [];
      const rmap = app.sidebar?._wbRemoteHosts;
      if (rmap) for (const [hostId, st] of rmap) for (const s of (st?.sessions || [])) {
        if (liveIds.has(s.sessionId)) continue;
        remote.push({ ...s, host: s.host || hostId, backendSessionId: s.sessionId, status: s.keeperSid ? 'stopped' : (s.status === 'remote-running' ? 'external' : 'stopped') });
      }
      const all = remote.length ? local.concat(remote) : local;
      const scored = [];
      for (const s of all) {
        const label = app.sidebar.getCustomName(s) || s.name || s.webuiName || (s.cwd || '').split('/').pop() || s.sessionId?.slice(0, 8) || '';
        const hay = `${label} ${s.cwd || ''} ${s.hostName || ''} ${s.backend || ''} ${s.sessionId || ''} ${s.backendSessionId || ''} ${s.claudeSessionId || ''}`;
        const sc = q ? score(q, label, hay) : 1;
        if (sc < 0) continue;
        const live = s.status === 'live' || s.status === 'tmux' || s.status === 'external';
        // Match quality DOMINATES; live is a tiebreak among equally-good
        // matches, never a reason to bury a better-named stopped session
        // (that inversion is what hid userW's session behind 12 live ones).
        // With no query, live-first ordering is preserved.
        scored.push({ s, label, sc: sc * 1000 + (live ? 500 : 0) + (s.startedAt || 0) / 1e13 });
      }
      scored.sort((a, b) => b.sc - a.sc);
      items = scored.slice(0, 12);
      sel = 0; render();
    };

    input.oninput = refresh;
    input.onkeydown = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const it = items[sel];
        if (!it) return;
        if (it.newSession) { close(); app.showNewSessionDialog({ cwd: it.cwd }); }
        else activate(it.s);
      }
    };
    refresh();
    setTimeout(() => input.focus(), 0);
    // Kick a one-time discovery of every configured host so remote sessions
    // become searchable even for hosts not opened in the sidebar yet; re-refresh
    // a few times as the ssh scans land (each _loadRemoteHost is cached/deduped).
    try {
      const sb = app.sidebar;
      sb?._ensureHostsData?.(); // populate the host list if the workbench hasn't yet
      let n = 0; const iv = setInterval(() => {
        if (!overlay || ++n > 8) return clearInterval(iv);
        const hosts = sb?._hostsData?.hosts || [];
        if (hosts.length && sb._loadRemoteHost) for (const h of hosts) { try { sb._loadRemoteHost(h.id); } catch {} }
        refresh();
      }, 900);
    } catch {}
  };

  // COMMAND 'session.palette' (contributions registry, Plugin Ph1) — a plugin
  // row or binding can open the palette. The chord itself stays dispatched
  // HERE, not via registerKeybinding: this check is modifier-LENIENT
  // ((ctrl|meta)+k regardless of shift/alt, capture phase) while the
  // registry matcher is strict (VS Code semantics, bubble phase), so migrating
  // it would silently drop Ctrl+Shift+K / Ctrl+Alt+K and reorder listeners —
  // the key dispatch is left byte-identical and only the action is
  // registry-routed.
  registerCommand({ id: 'session.palette', title: 'Jump to a session…', run: () => open() });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !e.target.closest?.('.xterm')) {
      e.preventDefault();
      runCommand('session.palette', { app });
    }
  }, true);
}
