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
  sheet:    _s('<path d="M4 1h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M10 1v4h4"/><rect x="5" y="8" width="6" height="5" rx="0.6"/><path d="M5 10.5h6M8 8v5"/>'),
  slides:   _s('<path d="M4 1h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M10 1v4h4"/><rect x="5" y="8" width="6" height="5" rx="0.6"/><path d="M6.5 10h3M6.5 11.5h2"/>'),
  data:     _s('<path d="M3 1h10a1 1 0 011 1v12a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M2 5h12M2 9h12M6 1v14"/>'),
  web:      _s('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12"/>'),
  code:     _s('<path d="M5 4L1 8l4 4M11 4l4 4-4 4"/>'),
  config:   _s('<path d="M4 1h8l2 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V3a2 2 0 012-2z"/><path d="M5 6h6M5 9h4M5 12h5"/>'),
  text:     _s('<path d="M4 1h8a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M5 5h6M5 8h6M5 11h3"/>'),
  markdown: _s('<rect x="1" y="3" width="14" height="10" rx="1.5"/><path d="M4 10V6l2 2.5L8 6v4M11 6v4M13 8l-2 2-2-2"/>'),
  shell:    _s('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 7l2 2-2 2M8.5 11h3"/>'),
  archive:  _s('<path d="M3 5h10v8.5a1 1 0 01-1 1H4a1 1 0 01-1-1V5z"/><path d="M2 2h12v3H2z"/><path d="M8 7v1M8 9.5v1M8 12v1"/>'),
  folder:   _s('<path d="M2 4h4l2 2h6v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"/>'),
  folderOpen: _s('<path d="M2 4h4l2 2h6v1H6L3.5 14H2V4z"/><path d="M6 7h9l-2.5 7H3.5z"/>'),
  mail:     _s('<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M2 4.2l6 4.8 6-4.8"/>'),
  unknown:  _s('<path d="M4 1h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M10 1v4h4"/>'),
  python:   `<svg style="width:1em;height:1em;vertical-align:-0.125em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M14.25.18l.9.2.73.26.59.3.45.32.34.34.25.34.16.33.1.3.04.26.02.2-.01.13V8.5l-.05.63-.13.55-.21.46-.26.38-.3.31-.33.25-.35.19-.35.14-.33.1-.3.07-.26.04-.21.02H8.77l-.69.05-.59.14-.5.22-.41.27-.33.32-.27.35-.2.36-.15.37-.1.35-.07.32-.04.27-.02.21v3.06H3.17l-.21-.03-.28-.07-.32-.12-.35-.18-.36-.26-.36-.36-.35-.46-.32-.59-.28-.73-.21-.88-.14-1.05-.05-1.23.06-1.22.16-1.04.24-.87.32-.71.36-.57.4-.44.42-.33.42-.24.4-.16.36-.1.32-.05.24-.01h.16l.06.01h8.16v-.83H6.18l-.01-2.75-.02-.37.05-.34.11-.31.17-.28.25-.26.31-.23.38-.2.44-.18.51-.15.58-.12.64-.1.71-.06.77-.04.84-.02 1.27.05zm-6.3 1.98l-.23.33-.08.41.08.41.23.34.33.22.41.09.41-.09.33-.22.23-.34.08-.41-.08-.41-.23-.33-.33-.22-.41-.09-.41.09zm13.09 3.95l.28.06.32.12.35.18.36.27.36.35.35.47.32.59.28.73.21.88.14 1.04.05 1.23-.06 1.23-.16 1.04-.24.86-.32.71-.36.57-.4.45-.42.33-.42.24-.4.16-.36.09-.32.05-.24.02-.16-.01h-8.22v.82h5.84l.01 2.76.02.36-.05.34-.11.31-.17.29-.25.25-.31.24-.38.2-.44.17-.51.15-.58.13-.64.09-.71.07-.77.04-.84.01-1.27-.04-1.07-.14-.9-.2-.73-.25-.59-.3-.45-.33-.34-.34-.25-.34-.16-.33-.1-.3-.04-.25-.02-.2.01-.13v-5.34l.05-.64.13-.54.21-.46.26-.38.3-.32.33-.24.35-.2.35-.14.33-.1.3-.06.26-.04.21-.02.13-.01h5.84l.69-.05.59-.14.5-.21.41-.28.33-.32.27-.35.2-.36.15-.36.1-.35.07-.32.04-.28.02-.21V6.07h2.09l.14.01zm-6.47 14.25l-.23.33-.08.41.08.41.23.33.33.23.41.08.41-.08.33-.23.23-.33.08-.41-.08-.41-.23-.33-.33-.23-.41-.08-.41.08z"/></svg>`,
  style:    _s('<circle cx="8" cy="8" r="6"/><path d="M8 2a3 3 0 00-3 3c0 2 3 3 3 5a3 3 0 003-3c0-2-3-3-3-5z" fill="currentColor" stroke="none"/>'),
};

// ── UI icons (used across chat, session cards, toolbar, etc.) ──
export const UI_ICONS = {
  alert: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v3.6" stroke-linecap="round"/><circle cx="8" cy="11" r="0.9" fill="currentColor" stroke="none"/></svg>`,
  // Tool cards
  // Classic open-end wrench (Lucide 'wrench' scaled to 16) — the old path
  // (diagonal shaft + angular head) read as an eyedropper/color picker.
  wrench:    _s('<path d="M9.8 4.2a.67.67 0 000 .93l1.07 1.07a.67.67 0 00.93 0l2.51-2.51a4 4 0 01-5.29 5.29l-4.61 4.61a1.41 1.41 0 01-2-2l4.61-4.61a4 4 0 015.29-5.29L9.8 4.2z"/>'),
  terminal:  _s('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 7l2 2-2 2M8.5 11h3"/>'),
  robot:     _s('<rect x="3" y="4" width="10" height="9" rx="2"/><circle cx="6" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r="1" fill="currentColor" stroke="none"/><path d="M8 1v3M4 7h8"/><path d="M1 8v3M15 8v3"/>'),
  workflow:  _s('<circle cx="3" cy="8" r="2"/><circle cx="13" cy="3.5" r="1.8"/><circle cx="13" cy="8" r="1.8"/><circle cx="13" cy="12.5" r="1.8"/><path d="M5 8h2M11.2 3.5H8a1 1 0 00-1 1v6a1 1 0 001 1h3.2M7 8h4"/>'),
  lock:      _s('<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 016 0v2"/>'),
  unlock:    _s('<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 015.8-1"/>'),
  clipboard: _s('<path d="M5 2h6a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1V5"/><path d="M6 1h4v2H6z"/>'),
  refresh:   _s('<path d="M2 8a6 6 0 0111-3M14 8a6 6 0 01-11 3"/><path d="M13 2v3h-3M3 14v-3h3"/>'),
  upload:    _s('<path d="M8 11V1M4 4l4-4 4 4"/><path d="M2 13h12"/>'),
  import:    _s('<path d="M8 1v9M4 7l4 4 4-4"/><path d="M2 13h12"/>'),
  book:      _s('<path d="M2 2h5a3 3 0 013 3v9a2 2 0 00-2-2H2zM14 2H9a3 3 0 00-3 3v9a2 2 0 012-2h6z"/>'),
  memo:      _s('<path d="M4 1h8a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M6 5h4M6 8h4M6 11h2"/>'),
  tasks:     _s('<path d="M4 4l8 0M4 8l8 0M4 12l8 0"/><circle cx="2" cy="4" r="0.8" fill="currentColor" stroke="none"/><circle cx="2" cy="8" r="0.8" fill="currentColor" stroke="none"/><circle cx="2" cy="12" r="0.8" fill="currentColor" stroke="none"/>'),
  // Goal indicator + status icons (replace 🎯 ▶ ⏸ ⛔ ✓ ⏳ 🪙 emoji)
  goal:      _s('<circle cx="8" cy="8" r="6.5"/><circle cx="8" cy="8" r="3.5"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/>'),
  design:    _s('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 6.5h11M6.5 6.5v7"/>'),
  clock:     _s('<circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/>'),
  hourglass: _s('<path d="M4 2h8M4 14h8M5.5 2v2.2c0 1.3 2.5 2.5 2.5 3.8s-2.5 2.5-2.5 3.8V14M10.5 2v2.2c0 1.3-2.5 2.5-2.5 3.8s2.5 2.5 2.5 3.8V14"/>'),
  // clock + play: "continues by itself at the reset" — deliberately NOT the
  // hourglass, which sits next door on the style chip meaning "pending pick"
  autoContinue: _s('<circle cx="8" cy="8" r="6.5"/><path d="M6.6 5.5l4 2.5-4 2.5z" fill="currentColor" stroke="none"/>'),
  play:      _s('<path d="M5 3.5l7 4.5-7 4.5z"/>', { fill: true }),
  pause:     _s('<rect x="4.5" y="3" width="2.4" height="10" rx="0.6"/><rect x="9.1" y="3" width="2.4" height="10" rx="0.6"/>', { fill: true }),
  block:     _s('<circle cx="8" cy="8" r="6"/><path d="M3.8 3.8l8.4 8.4"/>'),
  check:     _s('<path d="M3 8.5l3.5 3.5L13 4.5"/>'),
  coin:      _s('<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.5"/>'),
  circle:    _s('<circle cx="8" cy="8" r="6"/>'),
  bolt:      _s('<path d="M9 1.2L3.8 9.2H7l-0.9 5.6L12.4 6.6H8.6z"/>', { fill: true }),
  // GitHub "repo-forked" octicon — used for fork-from-message in chat
  // Run-fold chrome (2.369.37): floating run bar + bottom collapse line
  chevronUp:   _s('<path d="M3.5 10l4.5-4.5 4.5 4.5"/>'),
  chevronDown: _s('<path d="M3.5 6l4.5 4.5L12.5 6"/>'),
  arrowUpToLine: _s('<path d="M3 2.5h10"/><path d="M8 13.5V5.5M4.5 9L8 5.5 11.5 9"/>'),
  forkBranch: _s('<path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"/>', { fill: true }),
};
