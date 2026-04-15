/**
 * Centralized SVG icon library — all inline SVG icons in one place.
 * Uses currentColor for theme adaptation. All icons are 16x16 viewBox.
 */

const _s = (d, opts = {}) => {
  const fill = opts.fill ? 'currentColor' : 'none';
  const stroke = opts.fill ? 'none' : 'currentColor';
  const sw = opts.sw || 1.5;
  return `<svg style="width:1em;height:1em;vertical-align:-0.125em" viewBox="0 0 16 16" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
};

// ── File type icons (used in file-types.js, file-explorer.js) ──
export const FILE_ICONS = {
  image:    _s('<rect x="2" y="2" width="12" height="12" rx="1.5"/><circle cx="5.5" cy="5.5" r="1.5" fill="currentColor" stroke="none"/><path d="M2 11l3-3 2 2 3-3 4 4"/>'),
  video:    _s('<rect x="1" y="3" width="10" height="10" rx="1.5"/><path d="M11 6l4-2v8l-4-2"/>'),
  audio:    _s('<path d="M6 3v10M6 3l6-1v10l-6 1"/><circle cx="3.5" cy="12" r="2.5" fill="currentColor" stroke="none"/><circle cx="9.5" cy="11" r="2.5" fill="currentColor" stroke="none"/>'),
  pdf:      _s('<path d="M4 1h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M10 1v4h4"/><text x="8" y="11.5" text-anchor="middle" font-size="5" font-weight="700" fill="currentColor" stroke="none" font-family="sans-serif">PDF</text>'),
  word:     _s('<path d="M4 1h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M10 1v4h4"/><path d="M5 8l1.5 5 1.5-3.5L9.5 13 11 8"/>'),
  sheet:    _s('<path d="M3 1h10a1 1 0 011 1v12a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M2 5h12M2 9h12M6 1v14M10 1v14"/>'),
  slides:   _s('<rect x="1" y="2" width="14" height="11" rx="1.5"/><path d="M8 13v2M5 15h6"/><circle cx="8" cy="7.5" r="2"/>'),
  data:     _s('<path d="M3 1h10a1 1 0 011 1v12a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M2 5h12M2 9h12M6 1v14"/>'),
  web:      _s('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12"/>'),
  code:     _s('<path d="M5 4L1 8l4 4M11 4l4 4-4 4"/>'),
  config:   _s('<path d="M4 1h8l2 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V3a2 2 0 012-2z"/><path d="M5 6h6M5 9h4M5 12h5"/>'),
  text:     _s('<path d="M4 1h8a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M5 5h6M5 8h6M5 11h3"/>'),
  markdown: _s('<rect x="1" y="3" width="14" height="10" rx="1.5"/><path d="M4 10V6l2 2.5L8 6v4M11 6v4M13 8l-2 2-2-2"/>'),
  shell:    _s('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 7l2 2-2 2M8.5 11h3"/>'),
  folder:   _s('<path d="M2 4h4l2 2h6v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"/>'),
  folderOpen: _s('<path d="M2 4h4l2 2h6v1H6L3.5 14H2V4z"/><path d="M6 7h9l-2.5 7H3.5z"/>'),
  unknown:  _s('<path d="M4 1h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M10 1v4h4"/>'),
  python:   _s('<path d="M5.5 1H10a1 1 0 011 1v3.5a1 1 0 01-1 1H6a1 1 0 00-1 1V11a1 1 0 001 1h4.5M10.5 15H6a1 1 0 01-1-1v-3.5a1 1 0 011-1h4a1 1 0 001-1V5a1 1 0 00-1-1H5.5"/><circle cx="7" cy="3" r="0.5" fill="currentColor" stroke="none"/><circle cx="9" cy="13" r="0.5" fill="currentColor" stroke="none"/>'),
  style:    _s('<circle cx="8" cy="8" r="6"/><path d="M8 2a3 3 0 00-3 3c0 2 3 3 3 5a3 3 0 003-3c0-2-3-3-3-5z" fill="currentColor" stroke="none"/>'),
};

// ── UI icons (used across chat, session cards, toolbar, etc.) ──
export const UI_ICONS = {
  // Tool cards
  wrench:    _s('<path d="M10.5 1.5L14 5l-1.5 1.5L9 3M4 7l-2.5 2.5a1.4 1.4 0 002 2L6 9M7 4l5 5"/>'),
  robot:     _s('<rect x="3" y="4" width="10" height="9" rx="2"/><circle cx="6" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r="1" fill="currentColor" stroke="none"/><path d="M8 1v3M4 7h8"/><path d="M1 8v3M15 8v3"/>'),
  lock:      _s('<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 016 0v2"/>'),
  clipboard: _s('<path d="M5 2h6a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1V5"/><path d="M6 1h4v2H6z"/>'),
  bell:      _s('<path d="M8 1.5a4.5 4.5 0 00-4.5 4.5c0 2.5-1.5 4-1.5 4h12s-1.5-1.5-1.5-4A4.5 4.5 0 008 1.5zM6.5 14a1.5 1.5 0 003 0"/>'),
  refresh:   _s('<path d="M2 8a6 6 0 0111-3M14 8a6 6 0 01-11 3"/><path d="M13 2v3h-3M3 14v-3h3"/>'),
  save:      _s('<path d="M3 1h8l3 3v9a2 2 0 01-2 2H3a2 2 0 01-2-2V3a2 2 0 012-2z"/><path d="M5 1v4h5V1M4 9h8"/>'),
  download:  _s('<path d="M8 1v10M4 8l4 4 4-4"/><path d="M2 13h12"/>'),
  upload:    _s('<path d="M8 11V1M4 4l4-4 4 4"/><path d="M2 13h12"/>'),
  book:      _s('<path d="M2 2h5a3 3 0 013 3v9a2 2 0 00-2-2H2zM14 2H9a3 3 0 00-3 3v9a2 2 0 012-2h6z"/>'),
  memo:      _s('<path d="M4 1h8a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M6 5h4M6 8h4M6 11h2"/>'),
  link:      _s('<path d="M7 9l2-2M6 12l-1.5 1.5a2 2 0 01-3-3L4 8M10 4l1.5-1.5a2 2 0 013 3L12 8"/>'),
  tasks:     _s('<path d="M4 4l8 0M4 8l8 0M4 12l8 0"/><circle cx="2" cy="4" r="0.8" fill="currentColor" stroke="none"/><circle cx="2" cy="8" r="0.8" fill="currentColor" stroke="none"/><circle cx="2" cy="12" r="0.8" fill="currentColor" stroke="none"/>'),
};
