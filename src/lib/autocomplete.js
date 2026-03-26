export function setupDirAutocomplete(input, dropdown, { onNavigate } = {}) {
  let timer = null, abortCtrl = null, activeIdx = -1, items = [];

  const hide = () => { dropdown.classList.add('hidden'); dropdown.innerHTML = ''; items = []; activeIdx = -1; };

  const show = (suggestions) => {
    dropdown.innerHTML = ''; items = suggestions; activeIdx = -1;
    if (!suggestions.length) { hide(); return; }
    dropdown.classList.remove('hidden');
    for (let i = 0; i < suggestions.length; i++) {
      const el = document.createElement('div'); el.className = 'autocomplete-item';
      el.textContent = suggestions[i];
      el.onmousedown = (e) => { e.preventDefault(); input.value = suggestions[i] + '/'; hide(); if (onNavigate) onNavigate(input.value); else fetchAC(input.value); };
      dropdown.appendChild(el);
    }
  };

  const highlight = (idx) => {
    dropdown.querySelectorAll('.autocomplete-item').forEach((el, i) => el.classList.toggle('active', i === idx));
    activeIdx = idx;
  };

  const fetchAC = (val) => {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    fetch(`/api/dir-complete?path=${encodeURIComponent(val)}`, { signal: abortCtrl.signal })
      .then(r => r.json()).then(d => show(d.suggestions || [])).catch(() => {});
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    if (!input.value) { hide(); return; }
    timer = setTimeout(() => fetchAC(input.value), 150);
  });

  input.addEventListener('keydown', (e) => {
    if (dropdown.classList.contains('hidden') || !items.length) {
      if (e.key === 'Tab' && input.value) { e.preventDefault(); fetchAC(input.value); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(activeIdx + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(activeIdx - 1, 0)); }
    else if (e.key === 'Tab' || e.key === 'Enter') {
      if (activeIdx >= 0) { e.preventDefault(); input.value = items[activeIdx] + '/'; hide(); if (onNavigate) onNavigate(input.value); else fetchAC(input.value); }
      else if (e.key === 'Tab' && items.length === 1) { e.preventDefault(); input.value = items[0] + '/'; hide(); if (onNavigate) onNavigate(input.value); else fetchAC(input.value); }
    } else if (e.key === 'Escape') { hide(); }
  });

  input.addEventListener('blur', () => setTimeout(hide, 200));

  return { hide };
}
