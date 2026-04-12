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
    description: 'Show the entire layout presets bar (built-in presets, custom grids, and + add button)',
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
  'window.closeBehavior': {
    type: 'enum', default: 'terminate',
    options: [
      { value: 'terminate', label: 'Terminate session' },
      { value: 'detach', label: 'Detach (keep alive)' },
    ],
    label: 'Window close behavior',
    description: 'What happens when closing a terminal window: terminate the session, or detach and keep it running',
    category: 'Window', liveApply: true,
  },
  'window.activeHighlightIntensity': {
    type: 'enum', default: 'normal',
    options: [
      { value: 'subtle', label: 'Subtle' },
      { value: 'normal', label: 'Normal' },
      { value: 'strong', label: 'Strong' },
    ],
    label: 'Active window highlight',
    description: 'How prominently the focused window is highlighted (subtle = shadow only, normal = accent border, strong = border + glow)',
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

  // ── Chat ──
  'chat.compactMode': {
    type: 'boolean', default: true, label: 'Compact mode',
    description: 'Dense document-style layout instead of chat bubbles. Closer to TUI information density.',
    category: 'Chat', liveApply: true,
  },
  'chat.roleIndicator': {
    type: 'enum', default: 'border',
    options: [
      { value: 'border', label: 'Color border' },
      { value: 'background', label: 'Background tint' },
      { value: 'icon', label: 'Icon' },
      { value: 'label', label: 'Text label (You/Claude)' },
    ],
    label: 'Role indicator style',
    description: 'How to visually distinguish user vs assistant messages in compact mode.',
    category: 'Chat', liveApply: true,
  },

  // ── Session ──
  'session.defaultMode': {
    type: 'enum', default: 'chat',
    options: [
      { value: 'terminal', label: 'Terminal' },
      { value: 'chat', label: 'Chat' },
    ],
    label: 'Default session mode',
    description: 'Default mode for new sessions and single-click resume from sidebar',
    category: 'Session', liveApply: true,
  },
  'session.defaultEffort': {
    type: 'enum', default: '',
    options: [
      { value: '', label: 'Auto (model default)' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max (Opus 4.6 only)' },
    ],
    label: 'Default effort level',
    description: 'Effort level for new sessions (--effort flag). Auto uses the model default.',
    category: 'Session', liveApply: true,
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
  'sidebar.enableStatusQuickTabs': {
    type: 'boolean', default: false, label: 'Status quick tabs',
    description: 'Show quick-filter tabs (ALL/LIVE/STOP/...) below the search bar',
    category: 'Sidebar', liveApply: false,
  },

  // ── Session Card ──
  'sessionCard.clickBehavior': {
    type: 'enum', default: 'focus',
    options: [
      { value: 'focus', label: 'Focus window' },
      { value: 'expand', label: 'Expand card' },
      { value: 'flash', label: 'Flash window' },
    ],
    label: 'Card click behavior',
    description: 'What happens when clicking a session card: focus/open the window, expand card details, or flash/bounce the window',
    category: 'Session Card', liveApply: false,
  },
  'sessionCard.clickToCopy': {
    type: 'boolean', default: false, label: 'Click detail values to copy',
    description: 'Click on ID, Path, Time, or Groups values to copy them to clipboard',
    category: 'Session Card', liveApply: false,
  },
  'sessionCard.visibleFields': {
    type: 'multiSelect', default: ['id', 'cwd', 'started', 'status', 'groups'],
    options: [
      { value: 'id', label: 'Session ID' },
      { value: 'cwd', label: 'Working Directory' },
      { value: 'started', label: 'Started Time' },
      { value: 'status', label: 'Status' },
      { value: 'groups', label: 'Groups' },
    ],
    label: 'Visible detail fields',
    description: 'Choose which fields to show in the expanded session card',
    category: 'Session Card', liveApply: false,
  },
  'sessionCard.detailTruncation': {
    type: 'enum', default: 'left',
    options: [
      { value: 'left', label: 'Truncate left (show end)' },
      { value: 'right', label: 'Truncate right (show start)' },
    ],
    label: 'Detail value truncation',
    description: 'When text overflows, truncate from the left (shows filename) or right (shows path start)',
    category: 'Session Card', liveApply: false,
  },
};

// Ordered category list for UI rendering
const SETTINGS_CATEGORIES = [
  'Toolbar & Layout',
  'Window',
  'Terminal',
  'Chat',
  'Session',
  'Sidebar',
  'Session Card',
];

export { SETTINGS_SCHEMA, SETTINGS_CATEGORIES };
