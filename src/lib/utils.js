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

// Unified draft persistence — server-persisted, multi-client sync via WebSocket
// Key format: {type}:{id}  (type = chat|explorer|dialog, id = sessionId or path)
// Uses DraftManager for WS communication; standalone functions for quick access with local cache fallback

let _draftWs = null;
let _draftCache = {};

export function initDrafts(wsManager, initialDrafts) {
  _draftWs = wsManager;
  _draftCache = initialDrafts || {};
  // Listen for drafts from other clients
  wsManager.onGlobal((msg) => {
    if (msg.type === 'draft-updated') {
      if (msg.value) _draftCache[msg.key] = msg.value;
      else delete _draftCache[msg.key];
      // Dispatch custom event so components can react
      window.dispatchEvent(new CustomEvent('draft-sync', { detail: { key: msg.key, value: msg.value || '' } }));
    }
  });
}

export function saveDraft(type, id, value) {
  const key = type + ':' + id;
  if (value == null || value === '') { delete _draftCache[key]; }
  else { _draftCache[key] = value; }
  if (_draftWs) _draftWs.send({ type: 'draft-update', key, value: value || '' });
}

export function loadDraft(type, id) {
  return _draftCache[type + ':' + id] || '';
}

export function clearDraft(type, id) {
  saveDraft(type, id, '');
}
