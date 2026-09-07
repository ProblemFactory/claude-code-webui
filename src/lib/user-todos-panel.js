// Global user TODO inbox ("For you") — the merged view of every session's
// agent-filed items that need the USER (decisions, missing input, reviews).
// Taskbar button with an open-count badge; the popover groups items by owning
// session (each session's own list is just its group here) and jumps to that
// session to handle them. Items arrive via `vibespace-ask` (agent CLI) and are
// resolved/dismissed here (or by the agent once the user answers in chat).
import { t } from './i18n.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { anchorFixedPopup, copyText, createModalShell, escHtml, fetchJson, getToastHistory, showToast } from './utils.js';

const URG_RANK = { low: 0, normal: 1, high: 2, urgent: 3 };

export function installUserTodos(app) {
  const btn = document.getElementById('taskbar-user-todos');
  const popup = document.getElementById('user-todos-popup');
  if (!btn || !popup) return;
  let todos = { open: [], resolved: [] };
  let knownIds = null; // null until the first load — no toast storm at boot
  let tab = 'inbox'; // 'inbox' (default) | 'history' — resets to inbox on open

  // Match items to sidebar sessions with the sidebar's OWN canonical key
  // derivation (same one the status chips use) — an ad-hoc reimplementation
  // here would drift from it. webui:<serverId> covers items filed before the
  // backend id existed.
  const sessionFor = (key) => (app.sidebar?._allSessions || []).find((s) => {
    if (s.webuiId && `webui:${s.webuiId}` === key) return true;
    try { return app.sidebar._getSessionStateKey(s) === key; }
    catch { return `${s.backend || 'claude'}:${s.sessionId}` === key; }
  });
  const displayName = (s) => {
    try { return app.sidebar?.getCustomName?.(s) || s.name; } catch { return s.name; }
  };
  const nameFor = (key, items) => {
    const s = sessionFor(key);
    return (s && displayName(s)) || items.find((i) => i.sessionName)?.sessionName
      || (key.includes(':') ? key.split(':')[1].slice(0, 8) : key);
  };
  const jump = (key, item) => {
    // a job-borne item opens its ANSWER surface directly regardless of which
    // group it sits in (2.357.0: items are attributed to the OWNER session
    // now, so the key is usually a real session — the actionable thing is
    // still the job's form, which focusJobsPanel lands on in the sidebar)
    if (item?.jobId) { popup.classList.add('hidden'); app.openJobInteract?.(item.jobId); return; }
    if (key === 'jobs') { popup.classList.add('hidden'); app.openJobs?.(); return; }
    // Account-level items (login-session expiry, 2026-09-07) belong to the
    // INSTANCE, not a session — the actionable surface is Manage Agents, the
    // same shape the 'jobs' bucket uses. Without this branch the click fell
    // through to "Session not found in the list yet", i.e. a dead end on an
    // item whose whole point is that the user must act.
    if (key === 'accounts') { popup.classList.add('hidden'); app._showAgentsDialog?.(); return; }
    const s = sessionFor(key);
    if (!s) { showToast(t('Session not found in the list yet — try from the sidebar'), { type: 'error' }); return; }
    popup.classList.add('hidden');
    if (s.webuiId) {
      // goToWindow only works when a window is OPEN for it — a live session
      // whose window was closed needs a re-attach instead of a silent no-op.
      const hasWindow = [...app.sessions.values()].some((term) => term.sessionId === s.webuiId);
      if (hasWindow) app.goToWindow(s.webuiId);
      else app.attachSession(s.webuiId, s.webuiName || displayName(s), s.cwd, { mode: s.webuiMode });
    } else if (s.status === 'tmux') app.attachTmuxSession(s.tmuxTarget, displayName(s), s.cwd);
    else if (s.status === 'stopped') app.resumeSession(s.sessionId, s.cwd, displayName(s), { backend: s.backend, hostId: s.hostId || s.host || undefined });
    else showToast(t('This session is running outside VibeSpace'), { type: 'error' });
  };
  const setStatus = async (id, status) => {
    // fetchJson never throws (returns null / the parsed {error} body) — check
    // the success flag or the failure is a silent no-op.
    const r = await fetchJson(`/api/user-todos/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    if (!r || !r.success) showToast(t('Could not update the item') + (r?.error ? `: ${r.error}` : ''), { type: 'error' });
  };

  // Dedicated item viewer (user request: the popup rows are hard to read and
  // can't be selected/copied) — markdown-rendered, selectable, with Copy.
  const openViewer = (i) => {
    const { body } = createModalShell({ id: 'ut-viewer', title: nameFor(i.sessionKey, [i]), bodyClass: 'ut-viewer-body', minWidth: 'min(560px, 92vw)', escapeToClose: true });
    const raw = i.text + (i.detail ? '\n\n' + i.detail : '');
    const md = document.createElement('div');
    md.className = 'ut-viewer-md';
    md.innerHTML = DOMPurify.sanitize(marked.parse(raw));
    const meta = document.createElement('div');
    meta.className = 'ut-meta';
    meta.textContent = `${i.urgency || 'normal'} · ${agoText(i.createdAt)}${i.resolvedAt ? ` · ${i.status}` : ''}`;
    const actionsRow = document.createElement('div');
    actionsRow.className = 'dialog-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'mounts-btn';
    copyBtn.textContent = t('Copy');
    copyBtn.onclick = () => { copyText(raw); showToast(t('Copied')); };
    actionsRow.append(copyBtn);
    body.append(md, meta, actionsRow);
  };

  const agoText = (ts) => {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return t('just now');
    if (m < 60) return t('{m}min ago', { m });
    const h = Math.round(m / 60);
    return h < 24 ? t('{h}h ago', { h }) : new Date(ts).toLocaleDateString();
  };

  const renderBtn = () => {
    const n = todos.open.length;
    const worst = todos.open.reduce((w, i) => Math.max(w, URG_RANK[i.urgency || 'normal'] || 1), 0);
    btn.classList.toggle('ut-has-items', n > 0);
    btn.dataset.urgency = n ? (Object.keys(URG_RANK).find((k) => URG_RANK[k] === worst) || 'normal') : '';
    // SEGMENTED badge (owner request): one pill per urgency tier so the
    // high-priority count is readable at a glance — urgent (red) · high
    // (yellow) · rest (accent). Zero tiers don't render; one tier looks
    // exactly like the old single badge.
    const cu = todos.open.filter((i) => i.urgency === 'urgent').length;
    const ch = todos.open.filter((i) => i.urgency === 'high').length;
    const cn = n - cu - ch;
    const segs = [cu ? `<span class="ut-count ut-seg-urgent">${cu}</span>` : '',
                  ch ? `<span class="ut-count ut-seg-high">${ch}</span>` : '',
                  cn ? `<span class="ut-count ut-seg-norm">${cn}</span>` : ''].join('');
    btn.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9.5h3l1 1.8h4l1-1.8h3"/><path d="M3.5 3.5h9l1.5 6v3.5a1 1 0 01-1 1H3a1 1 0 01-1-1V9.5z"/></svg>${segs}`;
    btn.title = n
      ? [cu ? t('{n} urgent', { n: cu }) : '', ch ? t('{n} high', { n: ch }) : '', cn ? t('{n} normal', { n: cn }) : '']
          .filter(Boolean).join(' · ') + ' — ' + t('waiting on you')
      : t('Nothing waiting on you');
  };

  const renderPanel = () => {
    if (popup.classList.contains('hidden')) return;
    // Two pages (user request): the real inbox (default) and the recent
    // notification-popup history — messages only, newest first.
    const tabsHtml = `<div class="ut-tabs">
      <button class="ut-tab${tab === 'inbox' ? ' on' : ''}" data-tab="inbox">${t('Inbox')}</button>
      <button class="ut-tab${tab === 'history' ? ' on' : ''}" data-tab="history">${t('Notifications')}</button>
    </div>`;
    if (tab === 'history') {
      const h = getToastHistory();
      popup.innerHTML = tabsHtml + (h.length
        ? h.map((e) => `<div class="ut-hist-item${e.type === 'error' ? ' ut-hist-err' : ''}">
            <div class="ut-hist-msg">${escHtml(e.m)}</div>
            <div class="ut-meta">${agoText(e.ts)}</div>
          </div>`).join('')
        : `<div class="empty-hint">${t('No notifications yet.')}</div>`);
      return;
    }
    const groups = new Map();
    for (const i of todos.open) (groups.get(i.sessionKey) || groups.set(i.sessionKey, []).get(i.sessionKey)).push(i);
    const gs = [...groups.entries()].sort((a, b) => {
      // Background Work is its OWN section, always after session groups
      // (owner report: it read as a weird phantom session mixed in)
      if ((a[0] === 'jobs') !== (b[0] === 'jobs')) return a[0] === 'jobs' ? 1 : -1;
      const w = (items) => Math.max(...items.map((i) => URG_RANK[i.urgency || 'normal'] || 1));
      return (w(b[1]) - w(a[1])) || (Math.max(...b[1].map(i => i.createdAt)) - Math.max(...a[1].map(i => i.createdAt)));
    });
    // Detail rides behind a collapsed expander (open items ship up to 2000
    // chars of agent context — inline it would swamp the list).
    const detailHtml = (i) => (i.detail ? `<details class="ut-detail-exp"><summary>${escHtml(t('detail'))}</summary><div class="ut-detail">${escHtml(i.detail)}</div></details>` : '');
    const itemHtml = (i) => `
      <div class="ut-item" data-id="${escHtml(i.id)}">
        <span class="ut-dot" data-urgency="${escHtml(i.urgency || 'normal')}" title="${escHtml(i.urgency || 'normal')}"></span>
        <div class="ut-body">
          <div class="ut-text">${escHtml(i.text)}</div>
          ${detailHtml(i)}
          <div class="ut-meta">${agoText(i.createdAt)}</div>
        </div>
        <span class="ut-actions">
          <button class="ut-act ut-view" title="${t('Open in viewer (copyable, rendered)')}">⤢</button>
          <button class="ut-act ut-done" title="${t('Handled — mark done')}">✓</button>
          <button class="ut-act ut-dismiss" title="${t('Dismiss (not going to act on this)')}">✕</button>
        </span>
      </div>`;
    const resolvedHtml = todos.resolved.length ? `
      <div class="ut-resolved-head">${t('Recently resolved')}</div>
      ${todos.resolved.slice(0, 6).map((i) => `
        <div class="ut-item ut-item-resolved" data-id="${escHtml(i.id)}">
          <span class="ut-dot" data-urgency=""></span>
          <div class="ut-body"><div class="ut-text">${escHtml(i.text)}</div>
          ${detailHtml(i)}
          <div class="ut-meta"><span class="ut-sess" title="${t('Go to this session')}">${escHtml(nameFor(i.sessionKey, [i]))}</span> · ${i.status === 'dismissed' ? t('dismissed') : t('done')}${i.resolvedBy === 'agent' ? ' · ' + t('by the agent') : ''} · ${agoText(i.resolvedAt || i.createdAt)}</div></div>
          <span class="ut-actions"><button class="ut-act ut-view" title="${t('Open in viewer (copyable, rendered)')}">⤢</button><button class="ut-act ut-reopen" title="${t('Reopen')}">↺</button></span>
        </div>`).join('')}` : '';
    popup.innerHTML = tabsHtml + `
      <div class="usage-section-title">${t('For you')}<span class="ut-head-sub">${todos.open.length ? t('{n} open', { n: todos.open.length }) : t('all clear')}</span></div>
      ${gs.length ? gs.map(([key, items]) => key === 'jobs' ? `
        <div class="ut-group ut-group-jobs">
          <div class="ut-group-head ut-group-head-jobs"><svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4.5" width="12" height="8" rx="1.5"/><path d="M5.5 4.5v-1a1 1 0 011-1h3a1 1 0 011 1v1"/></svg>${t('Background Work')}<span class="ut-group-n">${items.length}</span></div>
          ${items.map(itemHtml).join('')}
        </div>` : `
        <div class="ut-group">
          <button class="ut-group-head" data-key="${escHtml(key)}" title="${t('Go to this session')}">${escHtml(nameFor(key, items))}<span class="ut-group-n">${items.length}</span><span class="ut-group-go">→</span></button>
          ${items.map(itemHtml).join('')}
        </div>`).join('')
      : `<div class="empty-hint">${t('Nothing needs you right now. Agents file items here with vibespace-ask when they need a decision or input.')}</div>`}
      ${resolvedHtml}`;
  };

  btn.onclick = () => {
    popup.classList.toggle('hidden');
    tab = 'inbox'; // default page on every open (user spec)
    renderPanel();
    // Anchor to the button's CURRENT position — customize mode can move it to
    // any bar, so the old fixed bottom-right CSS pointed nowhere.
    if (!popup.classList.contains('hidden')) anchorFixedPopup(popup, btn);
  };
  document.addEventListener('mousedown', (e) => {
    if (!popup.contains(e.target) && !btn.contains(e.target)) popup.classList.add('hidden');
  });
  popup.addEventListener('click', (e) => {
    const tb = e.target.closest('.ut-tab');
    if (tb) { tab = tb.dataset.tab; renderPanel(); return; }
    const head = e.target.closest('.ut-group-head');
    if (head) { jump(head.dataset.key); return; }
    // A click on the detail expander is a toggle, not a jump — without this
    // guard opening the detail would bubble into the row's jump-and-close.
    if (e.target.closest('.ut-detail-exp')) return;
    const item = e.target.closest('.ut-item');
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.closest('.ut-view')) {
      const rec = todos.open.find((i) => i.id === id) || todos.resolved.find((i) => i.id === id);
      if (rec) openViewer(rec);
      return;
    }
    if (e.target.closest('.ut-done')) setStatus(id, 'done');
    else if (e.target.closest('.ut-dismiss')) setStatus(id, 'dismissed');
    else if (e.target.closest('.ut-reopen')) setStatus(id, 'open');
    else {
      // a real text SELECTION inside the row must not jump-and-close
      if (String(window.getSelection?.() || '')) return;
      const rec = todos.open.find((i) => i.id === id) || todos.resolved.find((i) => i.id === id);
      if (rec) jump(rec.sessionKey, rec);
    }
  });

  const apply = (next) => {
    const prevKnown = knownIds;
    todos = next || { open: [], resolved: [] };
    // Toast genuinely NEW items — click one to jump. Known ids include the
    // resolved tail, so a user reopening an item doesn't get toasted for their
    // own action. The knownIds closure survives reconnects, so a resync after
    // an offline gap toasts exactly the items that arrived meanwhile (the
    // toast stack self-caps at 4).
    if (prevKnown) {
      for (const i of todos.open) {
        if (prevKnown.has(i.id)) continue;
        const el = showToast(`${t('For you')} · ${nameFor(i.sessionKey, [i])}: ${i.text}`);
        if (el) { el.style.cursor = 'pointer'; el.onclick = () => jump(i.sessionKey, i); }
        btn.classList.remove('ut-blink'); void btn.offsetWidth; btn.classList.add('ut-blink');
      }
    }
    knownIds = new Set([...todos.open, ...todos.resolved].map((i) => i.id));
    renderBtn(); renderPanel();
  };

  let liveSeen = false; // a broadcast beat the initial fetch — don't clobber it with the older snapshot
  app.ws.onGlobal((msg) => { if (msg.type === 'user-todos-updated' && msg.todos) { liveSeen = true; apply(msg.todos); } });
  // Resync on reconnect — items filed while offline would otherwise stay
  // invisible until the next unrelated change re-broadcasts.
  app.ws.onStateChange?.((connected) => {
    if (connected) fetchJson('/api/user-todos').then((d) => { if (d?.todos) apply(d.todos); });
  });
  fetchJson('/api/user-todos').then((d) => { if (d?.todos && !liveSeen) apply(d.todos); });
  // A toast fired while the history page is open → live-refresh it
  window.addEventListener('vs-toast', () => { if (tab === 'history' && !popup.classList.contains('hidden')) renderPanel(); });
  renderBtn();
}
