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
