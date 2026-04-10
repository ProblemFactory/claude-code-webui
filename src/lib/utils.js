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

// Unified draft persistence — saves transient input state to sessionStorage
// Key format: draft:{type}:{id}  (type = chat|explorer|dialog, id = sessionId or path)
const DRAFT_PREFIX = 'cwui-draft:';

export function saveDraft(type, id, value) {
  const key = DRAFT_PREFIX + type + ':' + id;
  if (value == null || value === '') {
    sessionStorage.removeItem(key);
  } else {
    sessionStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

export function loadDraft(type, id) {
  return sessionStorage.getItem(DRAFT_PREFIX + type + ':' + id) || '';
}

export function clearDraft(type, id) {
  sessionStorage.removeItem(DRAFT_PREFIX + type + ':' + id);
}
