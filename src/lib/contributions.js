// COMMANDS + MENUS (with `when`) + KEYBINDINGS REGISTRY (Plugin Ph1,
// docs/design-harness-plugins.md §3.2 `commands[]` + `menus[] {where, when,
// group}` + `keybindings[]`; the second client contribution-point registry
// after window-types.js and built to the same rules).
//
// Before this module every context menu was an ad-hoc array literal built by
// its caller (19 showContextMenu callers), the ⚙ gear menu was an inline row
// builder in app.js, and every global shortcut was a raw document keydown
// switch. Nothing could contribute an entry without editing the owner's
// literal, and an unknown verb had no failure mode at all. Now:
//   • registerCommand({ id, title, run(ctx), when?(ctx) })  — the verbs
//   • registerMenuItem({ menu, command | label+run, group?, order?, when?… })
//                                                            — where a verb shows
//   • menuItems(menu, ctx)                                   — showContextMenu-shaped
//     items ({label, action, disabled, style, title, labelHtml, children,
//     separator} + renderer hints), evaluated VS Code style: `when` filters
//     (the item's AND the command's), items sort by group ('navigation'
//     first, then lexicographic — name them '1_open', '2_state'…), then
//     `order`, then registration sequence.
//   • registerKeybinding({ key:'ctrl+shift+k', command, when? }) +
//     installKeybindings(document, { signal }) — ONE document-level dispatcher
//     bound to an AbortSignal (the app lifetime)
//   • runCommand(id, ctx)                                    — dispatch
//
// SEPARATORS ARE EXPLICIT CONTRIBUTIONS ({ separator:true, group, order,
// when }) — a deliberate departure from VS Code's automatic between-group
// rule, which cannot reproduce the hand-built menus byte for byte (the window
// menu joins Minimize and Close with NO rule whenever the session block
// between them is absent). Leading / trailing / doubled separators collapse
// at build time, so a contribution can never leave a dangling rule.
//
// Core dogfoods it: the session-card, window (title-bar / taskbar / window
// list) and gear menus are registrations in their owning modules
// (session-card.js, taskbar.js, gear-menu.js) rendered through menuItems()
// with a byte-identical result to the former literals —
// scripts/test-contributions.mjs proves it against verbatim copies of the
// pre-registry builders over a state matrix. Command mode and the Ctrl+K
// palette register their actions as commands; their key DISPATCH stays where
// it was (see those files for why — modifier-lenient checks and capture-
// listener order are load-bearing).
//
// DOM-FREE AT IMPORT (node-importable — the gate suite imports it directly):
// the only import is telemetry-client (itself DOM-free at import), and every
// function takes its EventTarget / context as an argument. Registrations are
// LOUD: duplicate ids and malformed records THROW at registration (module
// load — every gate sees it); runCommand of an unknown id THROWS; an unknown
// command named by a menu item or a keybinding warns once + emits telemetry
// and is skipped (a stale contribution must not take the whole menu down).
// Every register* returns a dispose() and accepts an optional `signal`
// (AbortSignal) that disposes it — a plugin's contributions leave with it.
import { track } from './telemetry-client.js';

const COMMANDS = new Map();   // id → { id, title, run, when, icon }
const MENUS = new Map();      // menu → [ item records, registration order ]
const MENU_IDS = new Map();   // item id → menu (duplicate detection + unregister)
const KEYBINDINGS = [];       // { id, spec, key: parsed, command, when, inTerminal }
let seq = 0;
const warned = new Set();

const isFn = (f) => typeof f === 'function';
const nonEmptyString = (s) => typeof s === 'string' && s.length > 0;
const val = (v, ctx, ...rest) => (isFn(v) ? v(ctx, ...rest) : v);
const warnOnce = (key, msg) => {
  if (warned.has(key)) return;
  warned.add(key);
  try { console.warn('[contributions] ' + msg); } catch { }
};
const onSignal = (signal, dispose) => {
  if (!signal) return;
  if (typeof signal.addEventListener !== 'function') throw new Error('contributions: `signal` must be an AbortSignal');
  if (signal.aborted) { dispose(); return; }
  signal.addEventListener('abort', dispose, { once: true });
};

// ── commands ──

/**
 * Register a command (a verb with an id).
 *   id     — unique; core uses 'session.restart' / 'activeWindow.close' style,
 *            plugins get 'plugin:<pluginId>:<slug>' (plugin-client prefixes it)
 *   title  — English display string OR (ctx) → string for state-dependent
 *            labels (Star / Unstar). Wrap in t()/tr() at the call site as usual
 *            when the title is rendered in chrome — the registry never
 *            translates. Defaults to the id. A command that no menu shows may
 *            keep a plain English title (manifest metadata, like window-types'
 *            `label`) and wrap it at render time.
 *   run    — (ctx) → any. ctx is whatever the surface passed: menus pass their
 *            subject ({ app, s, … }), the keybinding dispatcher passes
 *            { …getCtx(), event }.
 *   when   — optional (ctx) → boolean: false hides the command from every menu
 *            and makes its keybindings inert (VS Code `enablement`). NOT
 *            consulted by runCommand (VS Code semantics: `when` gates surfaces,
 *            executeCommand still runs).
 *   icon   — optional SVG string (the gear renderer shows it; context menus ignore it)
 *   signal — optional AbortSignal; aborting unregisters the command
 * Returns dispose(). Throws on a duplicate id or a malformed record.
 */
export function registerCommand({ id, title, run, when, icon, signal } = {}) {
  if (!nonEmptyString(id)) throw new Error('registerCommand: `id` (non-empty string) is required');
  if (COMMANDS.has(id)) throw new Error(`registerCommand: duplicate command '${id}'`);
  if (!isFn(run)) throw new Error(`registerCommand ${id}: \`run\` must be a function`);
  if (title !== undefined && !nonEmptyString(title) && !isFn(title)) throw new Error(`registerCommand ${id}: \`title\` must be a string or a function`);
  if (when !== undefined && when !== null && !isFn(when)) throw new Error(`registerCommand ${id}: \`when\` must be a function`);
  if (icon !== undefined && typeof icon !== 'string') throw new Error(`registerCommand ${id}: \`icon\` must be an SVG string`);
  const rec = { id, title: title === undefined ? id : title, run, when: when || null, icon: icon || '', seq: ++seq };
  COMMANDS.set(id, rec);
  const dispose = () => { if (COMMANDS.get(id) === rec) COMMANDS.delete(id); };
  onSignal(signal, dispose);
  return dispose;
}

export function unregisterCommand(id) { return COMMANDS.delete(id); }
export function hasCommand(id) { return COMMANDS.has(id); }
/** Read-only view of a command record ({ id, title, when, icon }) or null. */
export function getCommand(id) {
  const c = COMMANDS.get(id);
  return c ? { id: c.id, title: c.title, when: c.when, icon: c.icon } : null;
}
export function listCommands() { return [...COMMANDS.keys()]; }

/** The command's title for a ctx (string), or '' when unknown. */
export function commandTitle(id, ctx = {}) {
  const cmd = COMMANDS.get(id);
  if (!cmd) return '';
  return isFn(cmd.title) ? String(cmd.title(ctx) ?? '') : cmd.title;
}

/**
 * Run a command by id. An UNKNOWN id is LOUD: telemetry 'command-unknown' +
 * a thrown Error naming what IS registered (the caller is code — a typo'd
 * id must fail at the call, never vanish). Errors thrown by `run` propagate.
 * `when` is not consulted here (see registerCommand).
 */
export function runCommand(id, ctx = {}) {
  const cmd = COMMANDS.get(id);
  if (!cmd) {
    const what = String(id ?? '(missing)').slice(0, 80);
    try { track('event', 'command-unknown', what); } catch { }
    throw new Error(`runCommand: unknown command '${what}' — registered: ${listCommands().join(', ')}`);
  }
  return cmd.run(ctx);
}

// ── menus ──

/**
 * Register a menu item. Menu ids are free strings; core uses
 * 'session-card' (sidebar card right-click; ctx = { app, state, settings, s,
 * card, event, displayName, customName, originalName, onRename, agentOpts }),
 * 'window' (title-bar / taskbar / window-list right-click; ctx = { app, id,
 * win, s (session or null), switchSubmenu, closeLabel }) and 'gear' (⚙ popover
 * rows; ctx = { app, pop }).
 *   menu       — required
 *   command    — command id (resolved LAZILY at menuItems() time — module load
 *                order between owners is not a contract). Alternatively an
 *                inline `run(ctx)` for a one-off row that is not a reusable
 *                verb (needs `label` then).
 *   id         — unique item id; default `${menu}/${command}` (give an
 *                explicit id when one command appears twice in a menu), or
 *                `${menu}#<n>` for command-less items
 *   group      — sort group ('navigation' first, then lexicographic); missing = ''
 *   order      — number within the group (missing = 0; registration order breaks ties)
 *   when       — (ctx) → boolean; false hides the item. A THROWING when() hides
 *                the item and warns once (never crashes the menu).
 *   label      — string | (ctx, commandTitle) → string; default = the command's title
 *   labelHtml  — (ctx) → string, OPT-IN rich label (caller escHtml()s everything)
 *   disabled   — boolean | (ctx) → boolean
 *   style      — string | (ctx) → string  (inline CSS, showContextMenu `style`)
 *   tooltip    — string | (ctx) → string  (showContextMenu `title`)
 *   children   — array | (ctx) → array of showContextMenu child items (a
 *                submenu). An EMPTY result drops the item — VS Code hides empty
 *                submenus, and core's "Task Groups" / "Move to Desktop" only
 *                exist when they have members.
 *   expand     — (ctx) → array of ready-made items spliced INLINE at this
 *                position (a dynamic list such as the plugin windows in the
 *                gear menu); each keeps the registration's group/order
 *   separator  — true: an explicit separator (sorted like any item; leading /
 *                trailing / doubled separators collapse at build time)
 *   kind       — free tag carried onto the produced item (the window menu's
 *                onAction(kind) hook reads it)
 *   icon / danger / keepOpen / decorate — renderer hints carried through
 *                verbatim (the gear renderer reads them; context menus ignore
 *                them). decorate(el, ctx): post-build hook on the rendered row.
 *   signal     — optional AbortSignal; aborting unregisters the item
 * Returns dispose(). Throws on a duplicate item id or a malformed record.
 */
export function registerMenuItem(spec = {}) {
  const { menu, command, run, group, order, when, label, labelHtml, disabled, style, tooltip, children, expand, separator, kind, icon, danger, keepOpen, decorate, signal } = spec;
  if (!nonEmptyString(menu)) throw new Error('registerMenuItem: `menu` (non-empty string) is required');
  const n = ++seq;
  const id = spec.id !== undefined ? spec.id : (command ? `${menu}/${command}` : `${menu}#${n}`);
  if (!nonEmptyString(id)) throw new Error(`registerMenuItem ${menu}: \`id\` must be a non-empty string`);
  if (MENU_IDS.has(id)) throw new Error(`registerMenuItem: duplicate menu item '${id}' (menu '${MENU_IDS.get(id)}') — give the second one an explicit \`id\``);
  if (command !== undefined && !nonEmptyString(command)) throw new Error(`registerMenuItem ${id}: \`command\` must be a command id string`);
  if (run !== undefined && !isFn(run)) throw new Error(`registerMenuItem ${id}: \`run\` must be a function`);
  if (command && run) throw new Error(`registerMenuItem ${id}: use \`command\` OR an inline \`run\`, not both`);
  if (!command && !run && !separator && children === undefined && !isFn(expand)) throw new Error(`registerMenuItem ${id}: needs a \`command\`, \`run\`, \`children\`, \`expand\` or \`separator:true\``);
  if (!command && !separator && !isFn(expand) && label === undefined) throw new Error(`registerMenuItem ${id}: an item without \`command\` needs a \`label\``);
  if (separator && (command || run || children !== undefined || expand)) throw new Error(`registerMenuItem ${id}: a separator carries no command/run/children/expand`);
  if (group !== undefined && typeof group !== 'string') throw new Error(`registerMenuItem ${id}: \`group\` must be a string`);
  if (order !== undefined && !Number.isFinite(order)) throw new Error(`registerMenuItem ${id}: \`order\` must be a finite number`);
  for (const [k, v] of Object.entries({ when, expand, decorate })) if (v !== undefined && v !== null && !isFn(v)) throw new Error(`registerMenuItem ${id}: \`${k}\` must be a function`);
  for (const [k, v] of Object.entries({ label, style, tooltip })) if (v !== undefined && typeof v !== 'string' && !isFn(v)) throw new Error(`registerMenuItem ${id}: \`${k}\` must be a string or a function`);
  if (labelHtml !== undefined && !isFn(labelHtml)) throw new Error(`registerMenuItem ${id}: \`labelHtml\` must be a function (escHtml every interpolated string)`);
  if (children !== undefined && !Array.isArray(children) && !isFn(children)) throw new Error(`registerMenuItem ${id}: \`children\` must be an array or a function`);
  if (icon !== undefined && typeof icon !== 'string') throw new Error(`registerMenuItem ${id}: \`icon\` must be an SVG string`);
  const rec = { id, menu, command: command || null, run: run || null, group: group || '', order: Number.isFinite(order) ? order : 0, when: when || null, seq: n,
    label, labelHtml, disabled, style, tooltip, children, expand: expand || null, separator: !!separator, kind, icon, danger: !!danger, keepOpen: !!keepOpen, decorate: decorate || null };
  if (!MENUS.has(menu)) MENUS.set(menu, []);
  MENUS.get(menu).push(rec);
  MENU_IDS.set(id, menu);
  const dispose = () => unregisterMenuItem(id);
  onSignal(signal, dispose);
  return dispose;
}

export function unregisterMenuItem(id) {
  const menu = MENU_IDS.get(id);
  if (!menu) return false;
  const list = MENUS.get(menu) || [];
  const i = list.findIndex((r) => r.id === id);
  if (i >= 0) list.splice(i, 1);
  MENU_IDS.delete(id);
  return true;
}
export function listMenus() { return [...MENUS.keys()]; }
export function listMenuItems(menu) { return (MENUS.get(menu) || []).map((r) => r.id); }

const groupRank = (g) => (g === 'navigation' ? 0 : 1);
const cmpItems = (a, b) => {
  const ra = groupRank(a.group), rb = groupRank(b.group);
  if (ra !== rb) return ra - rb;
  if (a.group !== b.group) return a.group < b.group ? -1 : 1;
  if (a.order !== b.order) return a.order - b.order;
  return a.seq - b.seq;
};
const safeWhen = (fn, ctx, key, what) => {
  try { return !!fn(ctx); } catch (e) { warnOnce(key, `${what} when() threw: ${e?.message || e} — hidden`); return false; }
};

/**
 * Build the items of a menu for a ctx — the array showContextMenu takes,
 * plus the renderer hints (icon, danger, keepOpen, decorate, kind, command,
 * id). `action()` runs the command (or the inline run) with ctx. Unknown
 * menu → []. An item naming an unknown command → warn once + telemetry
 * 'menu-unknown-command', item skipped.
 */
export function menuItems(menu, ctx = {}) {
  const regs = MENUS.get(menu) || [];
  const rows = [];
  for (const reg of regs) {
    if (reg.when && !safeWhen(reg.when, ctx, `when:${reg.id}`, `menu '${menu}' item '${reg.id}'`)) continue;
    rows.push(reg);
  }
  rows.sort(cmpItems);
  const out = [];
  const pushItem = (it) => { out.push(it); };
  const pushSep = () => { if (out.length && !out[out.length - 1].separator) out.push({ separator: true }); };
  for (const reg of rows) {
    if (reg.separator) { pushSep(); continue; }
    if (reg.expand) {
      let list = [];
      try { list = reg.expand(ctx); } catch (e) { warnOnce(`expand:${reg.id}`, `menu '${menu}' item '${reg.id}' expand() threw: ${e?.message || e} — skipped`); }
      for (const x of Array.isArray(list) ? list : []) if (x) pushItem(x);
      continue;
    }
    let cmd = null;
    if (reg.command) {
      cmd = COMMANDS.get(reg.command);
      if (!cmd) {
        warnOnce(`menucmd:${menu}:${reg.command}`, `menu '${menu}' item '${reg.id}' names unknown command '${reg.command}' — skipped; registered: ${listCommands().join(', ')}`);
        try { track('event', 'menu-unknown-command', `${menu}:${reg.command}`.slice(0, 120)); } catch { }
        continue;
      }
      if (cmd.when && !safeWhen(cmd.when, ctx, `when:${cmd.id}`, `command '${cmd.id}'`)) continue;
    }
    const title = cmd ? (isFn(cmd.title) ? String(cmd.title(ctx) ?? '') : cmd.title) : '';
    const item = { id: reg.id, label: reg.label !== undefined ? String(val(reg.label, ctx, title) ?? '') : title };
    if (reg.command) { item.command = reg.command; item.action = () => runCommand(reg.command, ctx); }
    else if (reg.run) item.action = () => reg.run(ctx);
    if (reg.children !== undefined) {
      const kids = val(reg.children, ctx);
      if (!Array.isArray(kids) || !kids.length) continue; // an empty submenu is not shown
      item.children = kids;
    }
    if (reg.labelHtml !== undefined) item.labelHtml = String(reg.labelHtml(ctx) ?? '');
    if (val(reg.disabled, ctx)) item.disabled = true;
    const style = val(reg.style, ctx);
    if (style) item.style = String(style);
    const tip = val(reg.tooltip, ctx);
    if (tip) item.title = String(tip);
    if (reg.kind !== undefined) item.kind = reg.kind;
    const icon = reg.icon !== undefined ? reg.icon : (cmd?.icon || undefined);
    if (icon !== undefined) item.icon = icon;
    if (reg.danger) item.danger = true;
    if (reg.keepOpen) item.keepOpen = true;
    if (reg.decorate) item.decorate = reg.decorate;
    pushItem(item);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

// ── keybindings ──
const KEY_ALIASES = { esc: 'escape', space: ' ', spacebar: ' ', left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown', return: 'enter', del: 'delete', plus: '+' };
const MOD_NAMES = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta', win: 'meta', mod: 'mod' };

/**
 * Parse 'ctrl+shift+k' → { ctrl, alt, shift, meta, mod, key }. Modifiers:
 * ctrl/alt/shift/meta (+ aliases control/option/cmd/command/super/win) and
 * `mod` = ctrl OR meta (the platform primary, the `(e.ctrlKey || e.metaKey)`
 * convention every core shortcut already uses). The key is compared against
 * event.key lowercased ('k', 'escape', 'arrowleft', 'tab', '\\', 'f5'…);
 * aliases esc/space/left/right/up/down/return/del/plus accepted; 'ctrl++'
 * is the plus key. Throws on an empty, modifier-only or unknown-modifier spec.
 */
export function parseKey(spec) {
  if (!nonEmptyString(spec) || !spec.trim()) throw new Error('parseKey: key spec must be a non-empty string');
  const raw = spec.trim().toLowerCase();
  // '++' at the end (or a bare '+') is the plus KEY ('ctrl++', 'shift++');
  // a single trailing '+' ('ctrl+') is malformed and falls through to the
  // "a key is required" check below
  let parts;
  if (raw === '+') parts = ['plus'];
  else if (raw.endsWith('++')) parts = raw.slice(0, -2).split('+').concat('plus');
  else parts = raw.split('+');
  const out = { ctrl: false, alt: false, shift: false, meta: false, mod: false, key: '' };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (i < parts.length - 1) {
      const m = MOD_NAMES[p];
      if (!m) throw new Error(`parseKey '${spec}': unknown modifier '${p}'`);
      out[m] = true;
    } else {
      if (!p || MOD_NAMES[p]) throw new Error(`parseKey '${spec}': a key (not only modifiers) is required`);
      out.key = KEY_ALIASES[p] || p;
    }
  }
  return out;
}

/** VS Code-EXACT modifier matching: listed modifiers must be down, unlisted
 *  ones up. `mod` is satisfied by ctrl OR meta (the other member of the pair
 *  is then not required to be up). */
export function keyMatches(parsed, e) {
  if (!e || typeof e.key !== 'string') return false;
  if (e.key.toLowerCase() !== parsed.key) return false;
  if (!!e.altKey !== parsed.alt || !!e.shiftKey !== parsed.shift) return false;
  if (parsed.mod) return !!(e.ctrlKey || e.metaKey);
  return !!e.ctrlKey === parsed.ctrl && !!e.metaKey === parsed.meta;
}

/**
 * Bind a key to a command. `when(ctx)` (ctx = the dispatcher ctx + `event`)
 * can refine (e.g. "not while a dialog is open"); the command's own `when`
 * applies too. Later registrations take precedence over earlier ones for the
 * same key (plugins / user bindings override core, VS Code style).
 * `inTerminal:true` opts the binding into keydowns whose target sits inside
 * `.xterm` (terminals own their keys by default — the rule every core
 * shortcut follows). Returns dispose(). Throws on a malformed spec or a
 * duplicate key→command pair.
 */
export function registerKeybinding({ key, command, when, inTerminal = false, signal } = {}) {
  const parsed = parseKey(key);
  if (!nonEmptyString(command)) throw new Error(`registerKeybinding '${key}': \`command\` (command id) is required`);
  if (when !== undefined && when !== null && !isFn(when)) throw new Error(`registerKeybinding '${key}': \`when\` must be a function`);
  const spec = key.trim().toLowerCase();
  // an exact re-registration (same chord → same command, same inTerminal
  // scope, neither gated by a `when`) is a bug; the same pair under DIFFERENT
  // when-clauses / scopes is legal (VS Code: one chord, several conditional bindings)
  if (!when && KEYBINDINGS.some((b) => b.spec === spec && b.command === command && !b.when && b.inTerminal === !!inTerminal)) throw new Error(`registerKeybinding: duplicate binding '${key}' → '${command}'`);
  const rec = { id: 'kb-' + (++seq), spec, key: parsed, command, when: when || null, inTerminal: !!inTerminal };
  KEYBINDINGS.push(rec);
  const dispose = () => unregisterKeybinding(rec.id);
  onSignal(signal, dispose);
  return dispose;
}
export function unregisterKeybinding(id) {
  const i = KEYBINDINGS.findIndex((b) => b.id === id);
  if (i < 0) return false;
  KEYBINDINGS.splice(i, 1);
  return true;
}
export function listKeybindings() { return KEYBINDINGS.map((b) => ({ id: b.id, key: b.spec, command: b.command })); }

/** The binding a keydown event resolves to (last registered wins), or null.
 *  IME composition keystrokes never match; keys typed into a terminal only
 *  match `inTerminal` bindings; a binding whose command is unknown warns
 *  once + telemetry and is skipped. */
export function resolveKeybinding(e, ctx = {}) {
  if (!e || e.isComposing || e.keyCode === 229) return null;
  let inTerm = false;
  try { inTerm = !!e.target?.closest?.('.xterm'); } catch { }
  for (let i = KEYBINDINGS.length - 1; i >= 0; i--) {
    const b = KEYBINDINGS[i];
    if (!keyMatches(b.key, e)) continue;
    if (inTerm && !b.inTerminal) continue;
    const cmd = COMMANDS.get(b.command);
    if (!cmd) {
      warnOnce(`kb:${b.spec}:${b.command}`, `keybinding '${b.spec}' names unknown command '${b.command}' — skipped; registered: ${listCommands().join(', ')}`);
      try { track('event', 'keybinding-unknown-command', `${b.spec}:${b.command}`.slice(0, 120)); } catch { }
      continue;
    }
    const kctx = { ...ctx, event: e };
    if (b.when && !safeWhen(b.when, kctx, `kbwhen:${b.id}`, `keybinding '${b.spec}'`)) continue;
    if (cmd.when && !safeWhen(cmd.when, kctx, `when:${cmd.id}`, `command '${cmd.id}'`)) continue;
    return b;
  }
  return null;
}

/**
 * THE document-level keybinding dispatcher: one keydown listener on `target`
 * (document), bound to `signal` (the app-lifetime AbortController — a test
 * or a teardown can abort it). Bubble phase by default: an element's own
 * shortcut (editor Ctrl+S, chat Ctrl+F, the palette / command-mode capture
 * listeners) keeps first dibs and a registered binding only fires when
 * nothing consumed the key (defaultPrevented). On a match: preventDefault +
 * stopPropagation, then runCommand(command, { …getCtx(), event }); a throwing
 * command is logged + telemetered ('command-failed'), never propagated into
 * the event loop. Returns an uninstall function.
 */
export function installKeybindings(target, { signal, getCtx, capture = false } = {}) {
  if (!target || !isFn(target.addEventListener)) throw new Error('installKeybindings: target must be an EventTarget');
  if (getCtx !== undefined && !isFn(getCtx)) throw new Error('installKeybindings: `getCtx` must be a function');
  const onKey = (e) => {
    if (e.defaultPrevented) return;
    let ctx = {};
    try { ctx = (getCtx && getCtx(e)) || {}; } catch { ctx = {}; }
    const b = resolveKeybinding(e, ctx);
    if (!b) return;
    e.preventDefault?.();
    e.stopPropagation?.();
    try { runCommand(b.command, { ...ctx, event: e }); } catch (err) {
      try { console.error(`[contributions] keybinding '${b.spec}' → '${b.command}' failed`, err); } catch { }
      try { track('event', 'command-failed', `${b.command}: ${String(err?.message || err).slice(0, 120)}`); } catch { }
    }
  };
  target.addEventListener('keydown', onKey, signal ? { capture, signal } : { capture });
  return () => target.removeEventListener('keydown', onKey, { capture });
}
