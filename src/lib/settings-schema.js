/**
 * Settings Schema — single source of truth for all configurable options.
 *
 * Each key is a dotted path (e.g. 'toolbar.showLayoutPresets').
 * Only non-default values are persisted (sparse storage).
 */

const SETTINGS_SCHEMA = {
  // ── Toolbar & Layout ──
  'toolbar.showLayoutPresets': {
    type: 'boolean', default: true, label: 'Show layout presets',
    description: 'Show layout preset buttons (freeform, maximize, 2-col, etc.) in the toolbar',
    category: 'Toolbar & Layout', liveApply: true,
  },
  'toolbar.showCustomGridButton': {
    type: 'boolean', default: true, label: 'Show custom grid button',
    description: 'Show the + button for adding custom grid layouts',
    category: 'Toolbar & Layout', liveApply: true,
  },
  'toolbar.showCommandMode': {
    type: 'boolean', default: true, label: 'Enable command mode',
    description: 'Enable Ctrl+\\ command mode for keyboard-driven window management',
    category: 'Toolbar & Layout', liveApply: true,
  },
  'layout.enableDragSnap': {
    type: 'boolean', default: true, label: 'Snap on drag',
    description: 'Snap windows to grid cells or screen edges when dragging',
    category: 'Toolbar & Layout', liveApply: true,
  },
  'layout.enableShiftDragSelection': {
    type: 'boolean', default: true, label: 'Shift-drag cell selection',
    description: 'Hold Shift while dragging title bar to select a range of grid cells',
    category: 'Toolbar & Layout', liveApply: true,
  },

  // ── Window ──
  'window.enableSnapAnimation': {
    type: 'boolean', default: true, label: 'Snap animation',
    description: 'Animate window snap transitions (disable for instant positioning)',
    category: 'Window', liveApply: true,
  },
  'window.enableBounceOnFocus': {
    type: 'boolean', default: false, label: 'Bounce on remote focus',
    description: 'Briefly scale-bounce windows when focused from sidebar or taskbar',
    category: 'Window', liveApply: true,
  },
  'window.showRefitButton': {
    type: 'boolean', default: false, label: 'Show refit button',
    description: 'Show ↻ button in window title bar to force terminal re-fit',
    category: 'Window', liveApply: true,
  },
  'window.showOverlapIndicator': {
    type: 'boolean', default: true, label: 'Overlap indicator',
    description: 'Show overlap icon on title bar when windows stack',
    category: 'Window', liveApply: true,
  },

  // ── Terminal ──
  'terminal.minimumContrastRatio': {
    type: 'number', default: 1, min: 1, max: 21, step: 0.5,
    label: 'Minimum contrast ratio',
    description: 'Auto-adjust text colors to meet this contrast ratio (4.5 = WCAG AA). Set to 1 to disable.',
    category: 'Terminal', liveApply: false,
  },
  'terminal.preserveCustomTitle': {
    type: 'boolean', default: false, label: 'Preserve custom session title',
    description: 'Prevent Claude\'s OSC title updates from overwriting user-set session names',
    category: 'Terminal', liveApply: true,
  },
  'terminal.suppressWaitingOnRestore': {
    type: 'boolean', default: false, label: 'Suppress blink on restore',
    description: 'Don\'t trigger waiting-blink when replaying terminal buffer on page refresh',
    category: 'Terminal', liveApply: true,
  },
  'terminal.preserveScrollOnFit': {
    type: 'boolean', default: false, label: 'Preserve scroll on resize',
    description: 'Keep viewport scroll position anchored when terminal is resized',
    category: 'Terminal', liveApply: true,
  },
  'terminal.waitingBlinkBehavior': {
    type: 'enum', default: 'onlyUnfocused',
    options: [
      { value: 'always', label: 'Always' },
      { value: 'onlyUnfocused', label: 'Only when window not focused' },
      { value: 'never', label: 'Never' },
    ],
    label: 'Waiting blink behavior',
    description: 'When to show the orange blink on idle terminals',
    category: 'Terminal', liveApply: true,
  },

  // ── Sidebar ──
  'sidebar.defaultStatusFilter': {
    type: 'multiSelect', default: ['live', 'tmux', 'external', 'stopped'],
    options: [
      { value: 'live', label: 'Live' },
      { value: 'tmux', label: 'Tmux' },
      { value: 'external', label: 'External' },
      { value: 'stopped', label: 'Stopped' },
      { value: 'archived', label: 'Archived' },
    ],
    label: 'Default status filter',
    description: 'Which session statuses to show by default',
    category: 'Sidebar', liveApply: false,
  },
  'sidebar.enableAutoGrouping': {
    type: 'boolean', default: false, label: 'Auto domain grouping',
    description: 'Automatically group sessions by workspace path or name prefix',
    category: 'Sidebar', liveApply: false,
  },
  'sidebar.enableStarredDrawer': {
    type: 'boolean', default: false, label: 'Starred drawer',
    description: 'Show starred sessions in a separate collapsible group at the top',
    category: 'Sidebar', liveApply: false,
  },
  'sidebar.enableStatusQuickTabs': {
    type: 'boolean', default: false, label: 'Status quick tabs',
    description: 'Show quick-filter tabs (ALL/LIVE/STOP/...) below the search bar',
    category: 'Sidebar', liveApply: false,
  },
  'sidebar.showNewSessionCard': {
    type: 'boolean', default: true, label: 'Show "+ New Session" card',
    description: 'Show a card at the top of the session list to create new sessions',
    category: 'Sidebar', liveApply: false,
  },

  // ── File Explorer ──
  'fileExplorer.defaultSort': {
    type: 'enum', default: 'name',
    options: [
      { value: 'name', label: 'Name' },
      { value: 'size', label: 'Size' },
      { value: 'modified', label: 'Modified' },
    ],
    label: 'Default sort',
    description: 'Default column to sort files by',
    category: 'File Explorer', liveApply: false,
  },
  'fileExplorer.defaultSortAsc': {
    type: 'boolean', default: true, label: 'Sort ascending',
    description: 'Default sort direction (on = ascending, off = descending)',
    category: 'File Explorer', liveApply: false,
  },
  'fileExplorer.flatTimeSort': {
    type: 'boolean', default: false, label: 'Flat time sort',
    description: 'When sorting by modified time, mix files and folders instead of grouping dirs first',
    category: 'File Explorer', liveApply: false,
  },

  // ── Hotkeys ──
  'hotkeys.layoutBindings': {
    type: 'json', default: [],
    label: 'Layout hotkey bindings',
    description: 'Custom hotkey bindings for window positioning. Array of {key, modifier, layout, cell}',
    category: 'Hotkeys', liveApply: false,
  },

  // ── Themes ──
  'themes.colorOverrides': {
    type: 'json', default: {},
    label: 'Theme color overrides',
    description: 'Override terminal colors per theme. Object keyed by theme name with partial terminal theme values.',
    category: 'Themes', liveApply: false,
  },
};

// Ordered category list for UI rendering
const SETTINGS_CATEGORIES = [
  'Toolbar & Layout',
  'Window',
  'Terminal',
  'Sidebar',
  'File Explorer',
  'Hotkeys',
  'Themes',
];

export { SETTINGS_SCHEMA, SETTINGS_CATEGORIES };
