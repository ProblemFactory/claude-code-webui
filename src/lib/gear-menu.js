// ⚙ GEAR MENU (the `.gs-menu` block of the global-settings popover) — the
// account / admin / maintenance / help rows under the quick appearance
// controls. Split out of app.js with the Plugin Ph1 registry-ization: the
// rows are 'gear' MENU CONTRIBUTIONS (contributions.js) and buildGearMenu()
// renders them in registry order, which reproduces the former hand-built
// row list BYTE FOR BYTE (scripts/test-contributions.mjs diffs the registry
// output against a verbatim copy of the pre-registry builder over the
// {isMobile, _repoDir, _authEnabled, plugin windows} matrix). Mobile and
// desktop share this ONE menu (mobile-nav's gear calls _showGlobalSettings).
//
// Item shape beyond showContextMenu's: `icon` (inline SVG string — ours or a
// plugin's, always SVG), `danger` (red row), and `decorate(el, ctx)` for rows
// that need more than [icon][label]→onClick — the Language row (sub-menu at
// the click point, popover stays open) and the Update row (two-line label +
// async version fetch). ctx = { app, pop }.
//
// Groups (user feedback "布局逻辑怪怪的" — grouped by nature): 0_prefs = UI &
// preferences (customize / language — the quick appearance controls + All
// settings sit right above) · 1_admin = admin & monitoring · 2_maint =
// maintenance (backup / password / update) · 2p_plugins = plugin-contributed
// windows (Ph2, dynamic) · 3_help = help & session. Separators are explicit
// items at each group's head (contributions.js on why); the doubled
// separator between an EMPTY plugin block and 3_help collapses.
// A plugin adds a row with registerMenuItem({ menu:'gear', group, order,
// label, icon, command | run }) (plugin-client host API).
import { registerMenuItem, menuItems } from './contributions.js';
import { escHtml, fetchJson, showContextMenu } from './utils.js';
import { t, getLangPref, setLang } from './i18n.js';
import { PLUGIN_ICON } from './plugin-client.js';

export const GEAR_ICONS = {
  key: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="11" r="3"/><path d="M7.5 8.5L13 3M11 5l2 2M9 7l1.5 1.5"/></svg>',
  puzzle: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h4v2.5a1.5 1.5 0 103 0V7h2v7H3V7h2V4.5a1.5 1.5 0 103 0z"/></svg>',
  brush: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 2.5c-2.5.5-5.5 3-7 5l2 2c2-1.5 4.5-4.5 5-7z"/><path d="M6.5 7.5c-1.5.3-2.5 1.5-2.5 3.5-1 .5-1.5.5-2.5.5 1 1.5 2.5 2 4 2s2.8-1.3 3-3"/></svg>',
  tour: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.5v3.5M8 5v.5"/></svg>',
  out: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2H3v12h3M10 11l3-3-3-3M13 8H6"/></svg>',
  exp: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10V2M5 5l3-3 3 3M3 10v3h10v-3"/></svg>',
  imp: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M5 7l3 3 3-3M3 10v3h10v-3"/></svg>',
  lock: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></svg>',
  chart: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13h12"/><rect x="3" y="8" width="2.4" height="4"/><rect x="6.8" y="5" width="2.4" height="7"/><rect x="10.6" y="2.5" width="2.4" height="9.5"/></svg>',
  pulse: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8h3l1.5-4 3 8L10.5 8h4"/></svg>',
  globe: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c-1.8 1.8-2.7 4-2.7 6.5S6.2 12.7 8 14.5c1.8-1.8 2.7-4 2.7-6.5S9.8 3.3 8 1.5z"/></svg>',
};

// ── 'gear' menu contributions (extracted + replayed by the gate suite: keep
//    the block self-contained — only the names it closes over: registerMenuItem,
//    t, getLangPref, setLang, showContextMenu, fetchJson, GEAR_ICONS, PLUGIN_ICON) ──
export function registerGearMenu() {
  const M = 'gear';
  const I = GEAR_ICONS;
  registerMenuItem({ menu: M, group: '0_prefs', order: 10, when: (c) => !c.app.isMobile, icon: I.brush, label: () => t('Customize UI…'), run: (c) => c.app._customize.enter() });
  // Language is PER-DEVICE (localStorage, not a synced setting) — names shown
  // in their own language, never translated. Switching reloads the page.
  registerMenuItem({
    menu: M, group: '0_prefs', order: 20, icon: I.globe,
    label: () => {
      const pref = getLangPref();
      const cur = { auto: t('Auto (system)'), en: 'English', zh: '中文', ja: '日本語' }[pref] || pref;
      return `${t('Language')}: ${cur}`;
    },
    run: () => {},
    // the row opens a sub-menu at the click point and keeps the popover open
    // (the plain row onclick would pop.remove() first)
    decorate: (el) => {
      const pref = getLangPref();
      el.onclick = (e) => {
        const choices = [['auto', t('Auto (system)')], ['en', 'English'], ['zh', '中文'], ['ja', '日本語']];
        showContextMenu(e.clientX, e.clientY, choices.map(([code, label]) => ({
          label: (pref === code ? '✓ ' : '  ') + label,
          action: () => setLang(code), // showContextMenu items use .action, not .onClick
        })));
      };
    },
  });
  registerMenuItem({ menu: M, group: '1_admin', order: 0, separator: true });
  registerMenuItem({ menu: M, group: '1_admin', order: 10, icon: I.key, label: () => t('Manage agents…'), run: (c) => c.app._showAgentsDialog() });
  registerMenuItem({ menu: M, group: '1_admin', order: 20, icon: I.puzzle, label: () => t('Plugins…'), run: (c) => c.app.openPluginsDialog() });
  registerMenuItem({ menu: M, group: '1_admin', order: 30, icon: I.chart, label: () => t('Usage…'), run: (c) => c.app.openUsage() });
  registerMenuItem({ menu: M, group: '1_admin', order: 40, icon: I.chart, label: () => t('Background Work…'), run: (c) => c.app.openJobs() });
  registerMenuItem({ menu: M, group: '1_admin', order: 50, icon: I.pulse, label: () => t('Diagnostics report…'), run: (c) => c.app._openDiagnostics() });
  registerMenuItem({ menu: M, group: '1_admin', order: 60, icon: I.alert || I.pulse, label: () => t('Report a problem…'), run: (c) => c.app.captureIncident?.() });
  registerMenuItem({ menu: M, group: '1_admin', order: 70, icon: I.exp || I.pulse, label: () => t('Restore a previous layout…'), run: (c) => c.app._showLayoutHistory() });
  registerMenuItem({ menu: M, group: '2_maint', order: 0, separator: true });
  registerMenuItem({ menu: M, group: '2_maint', order: 10, icon: I.exp, label: () => t('Backup & migrate…'), run: (c) => c.app._showTransferDialog() });
  registerMenuItem({ menu: M, group: '2_maint', order: 20, icon: I.lock, label: (c) => (c.app._authEnabled ? t('Change password…') : t('Set password…')), run: (c) => c.app._showPasswordDialog() });
  // Self-update: runs scripts/update.sh visibly in a shell terminal (same
  // pattern as Manage Agents' CLI updates). The dtach terminal survives the
  // service restart at the end, so the log stays readable throughout.
  // The item also shows the running version and — when the canonical repo
  // has a newer one — "vX → vY" highlighted (user request). Clicking Update
  // opens the changelog-confirm dialog first (user directive) — the actual
  // update runs only after the user confirms.
  registerMenuItem({
    menu: M, group: '2_maint', order: 30, when: (c) => !!c.app._repoDir, icon: I.key, label: () => t('Update VibeSpace…'),
    run: (c) => { c.app._showUpdateConfirmDialog(); },
    decorate: (upd, c) => {
      // Two-line button (user request): label on top, "vCURRENT → vLATEST"
      // below. Restructure item()'s [icon][label] into [icon][column].
      const labelSpan = upd.children[1];
      const col = document.createElement('div');
      col.className = 'gs-item-col';
      upd.appendChild(col);
      col.appendChild(labelSpan);
      const vspan = document.createElement('span');
      vspan.className = 'gs-ver';
      col.appendChild(vspan);
      fetchJson('/api/version?fresh=1').then((v) => {
        if (!v?.version || !vspan.isConnected) return;
        const newer = v.latest && c.app._versionNewer(v.latest, v.version);
        vspan.textContent = newer ? `v${v.version} → v${v.latest}` : `v${v.version}`;
        if (newer) vspan.classList.add('gs-ver-new');
        vspan.title = newer ? t('Update available') : (v.latest ? t('Up to date') : '');
      }).catch(() => {});
    },
  });
  // Plugin-contributed windows (Ph2): one row per enabled iframe window,
  // spliced in dynamically — an empty list leaves no rule behind
  registerMenuItem({ menu: M, group: '2p_plugins', order: 0, separator: true });
  registerMenuItem({
    menu: M, group: '2p_plugins', order: 10, id: 'gear/plugin-windows',
    expand: (c) => (c.app.pluginClient?.contributedWindows?.() || []).map((w) => ({ label: w.title, icon: PLUGIN_ICON, action: () => c.app.pluginClient.open(w.pluginId, w.windowId) })),
  });
  registerMenuItem({ menu: M, group: '3_help', order: 0, separator: true });
  registerMenuItem({ menu: M, group: '3_help', order: 10, icon: I.tour, label: () => t('Welcome tour'), run: (c) => c.app._showOnboarding(true) });
  registerMenuItem({
    menu: M, group: '3_help', order: 20, when: (c) => !!c.app._authEnabled, icon: I.out, danger: true, label: () => t('Sign out'),
    run: async () => {
      try { await fetch('/api/logout', { method: 'POST' }); } catch {}
      location.href = '/login';
    },
  });
}
registerGearMenu();
// end registerGearMenu (scripts/test-contributions.mjs extracts the block above)

/** Render the `.gs-menu` block for the global-settings popover `pop`. */
export function buildGearMenu(app, pop) {
  const menu = document.createElement('div');
  menu.className = 'gs-menu';
  // compact menu rows (matches context-menu look)
  const item = (svg, label, onClick, danger = false) => {
    const el = document.createElement('div');
    el.className = 'gs-menu-item' + (danger ? ' danger' : '');
    el.innerHTML = `<span class="gs-menu-icon">${svg}</span><span>${escHtml(label)}</span>`;
    el.onclick = () => { pop.remove(); onClick(); };
    return el;
  };
  const sep = () => { const s = document.createElement('div'); s.className = 'gs-menu-sep'; return s; };
  const ctx = { app, pop };
  for (const it of menuItems('gear', ctx)) {
    if (it.separator) { menu.append(sep()); continue; }
    const el = item(it.icon || GEAR_ICONS.pulse, it.label, it.action || (() => {}), !!it.danger);
    if (typeof it.decorate === 'function') it.decorate(el, ctx);
    menu.append(el);
  }
  return menu;
}
