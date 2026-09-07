import { t } from './i18n.js';

export const BACKEND_META = {
  claude: {
    id: 'claude',
    label: 'Claude',
    shortLabel: 'CLAUDE',
    badgeClass: 'badge-backend-claude',
    color: 'var(--accent-hover)',
    icon: '✦',
    iconSrc: '/brand/claude.svg',
    iconClass: 'backend-icon-claude',
    brandColor: '#D97757',
    // The CLI's auto-memory dirs (~/.claude/projects/<proj>/memory/ and
    // ~/.claude/memory/) — file ops here classify as the 'memory' collapse
    // kind and label memory/<name> in fold summaries. A NEW backend with a
    // memory dir adds ONE memoryPathRe and everything downstream picks it up
    // (agentMemoryPathRes unions across backends deliberately: the PATH
    // identifies memory content regardless of which session touches it).
    memoryPathRe: /\/\.claude\/(?:projects\/[^/]+\/)?memory\//,
    // Offline fallback for the model dropdown when /api/available-models is
    // unreachable — per-backend so a codex/gemini session never lists claude
    // models (Track B, design-backend-parity.md §5).
    fallbackModels: ['fable', 'opus', 'sonnet', 'haiku'],
    // FEATURE capabilities (P4 client descriptor): chrome gates on THESE, not
    // on backend ids — a new backend declares its features here once.
    // inputModes MIRRORS the server's backend-caps row (test-harness-contract
    // deep-equals them): what a message sent DURING a turn can do here.
    // responseStyle MIRRORS the server's backend-caps row too (values + live);
    // the chip is drawn when `values` is non-empty and the "Restart now to
    // apply" row appears only when `live` is false.
    caps: { fork: true, effort: true, review: false, autoResume: true, accounts: true, inputModes: { queue: true, steer: false, queueOps: false }, responseStyle: { live: false, closed: false, values: ['Concise', 'Explanatory', 'Learning', 'Proactive'] } },
    // One-line hint per response-style VALUE (same contract as effortHints:
    // English key, t() at render — the VALUE itself is protocol and is never
    // translated).
    responseStyleHints: {
      Concise: 'lead with results, skip preamble',
      Explanatory: 'explain choices and patterns',
      Learning: 'teach while doing',
      Proactive: 'act first, minimize interruptions',
    },
    settingsPrefix: 'claude', // settings-schema key family (<prefix>.defaultModel/.defaultEffort/…)
    // Offline seed for the permission-mode dropdown before the first status
    // (the live list comes from the session's chatStatus.permissionModes).
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'],
  },
  shell: {
    id: 'shell',
    label: 'Terminal',
    shortLabel: 'SHELL',
    badgeClass: 'badge-backend-shell',
    color: 'var(--green)',
    icon: '>_',
    iconSrc: null,
    iconClass: 'backend-icon-shell',
    brandColor: '#3fb950',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    shortLabel: 'CODEX',
    badgeClass: 'badge-backend-codex',
    color: 'var(--blue)',
    icon: '⬢',
    iconSrc: '/brand/codex.svg',
    iconClass: 'backend-icon-codex',
    brandColor: '#000000',
    // Codex Memories (0.144.0, config-gated `[memories]` in config.toml,
    // developers.openai.com/codex/memories): background jobs distill rollouts
    // (memories_1.sqlite stage1 → global consolidation) into FILES under
    // $CODEX_HOME/memories/ — MEMORY.md, memory_summary.md, raw_memories.md,
    // rollout_summaries/ (paths verified in the 0.144.0 binary). Sessions can
    // also touch them via dedicated tools or plain file ops — either way the
    // path marks the content as memory.
    memoryPathRe: /\/\.codex\/memories\//,
    // gpt-6-astra first: in the 0.153.4 catalog (default effort medium here);
    // 0.153.4 makes it the CLI default when config.toml has no `model`, so the
    // dropdown must be able to name what the CLI would pick anyway.
    fallbackModels: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
    // autoResume: true since 2.368.20 — codex exhaustion arms the same module.
    // fork: the thread-fork RPC exists but is unwired (flips when wired).
    // fork: true since 2.369.21 — thread/fork is wired end to end (wrapper
    // CODEX_WEBUI_FORK → thread/fork; server _forkRequested per caps).
    caps: { fork: true, effort: true, review: true, autoResume: true, quotaRefresh: 'session-rpc', accounts: true, inputModes: { queue: true, steer: true, queueOps: true }, responseStyle: { live: true, closed: true, values: ['none', 'friendly', 'pragmatic'] } },
    // codex Personality values (0.153.4 schema): protocol strings, hinted here.
    responseStyleHints: {
      none: 'no persona — the model\u2019s plain voice',
      friendly: 'warmer, more conversational',
      pragmatic: 'terse and task-focused',
    },
    settingsPrefix: 'codex',
    permissionModes: ['default', 'read-only', 'safe-yolo', 'yolo'],
    // Effort rows that deserve a one-line hint (B-21e4 item 3): 'ultra' is
    // codex 0.153's multi-agent delegation level — the model spawns sub-agent
    // threads, which burn extra usage. Offered only when the served model's
    // catalog entry reports it (supported_reasoning_levels); English key,
    // t() at render (effortLabel below).
    effortHints: { ultra: 'delegates to sub-agents (multi-agent), extra usage' },
    // The effort value that is NOT a reasoning level but a delegation MODE
    // (2.369.62): under codex 'ultra' the model still reasons at the served
    // model's catalog `multi_agent_reasoning_effort` (gpt-6-astra: xhigh), so
    // a user who picked ultra and reads "xhigh" in the metadata popup is
    // seeing a TRUE fact stated as if it were their own pick. Surfaces gate on
    // THIS row, never on a backend id (2.369.58 law).
    multiAgentEffort: 'ultra',
  },
  // OpenCode over ACP v1 (S8, design-harness-plugins §2.3). No accounts
  // roster (the agent holds its own provider login), no effort/fork/review
  // chrome; the model list comes from the AGENT's session config options
  // (modelsFromAgent) — the offline fallback is deliberately empty because a
  // guessed model id would be rejected by the agent anyway. "Permission
  // modes" = the agent's session modes (build/plan on opencode).
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    shortLabel: 'OPENCODE',
    badgeClass: 'badge-backend-opencode',
    color: 'var(--green)',
    icon: '>',
    iconSrc: '/brand/opencode.svg',
    iconClass: 'backend-icon-opencode',
    brandColor: '#4ade80',
    fallbackModels: [],
    modelsFromAgent: true,
    caps: { fork: false, effort: false, review: false, autoResume: false, accounts: false, inputModes: { queue: true, steer: false, queueOps: true }, responseStyle: { live: false, closed: true, values: [] } },
    settingsPrefix: 'opencode',
    permissionModes: ['build', 'plan'],
    // The STORE (stopped conversations: list/open/resume/fork) runs behind a
    // built-in plugin that is OFF by default (2026-09-07 owner decision) —
    // the id is the mirror of the harness descriptor's store.servicePlugin,
    // and `service` is filled from /api/home + the plugins-updated /
    // harness-store-updated pushes. Chrome gates on THIS, never on the id.
    servicePlugin: 'opencode-serve',
    service: null,
  },
};

/** Settings key family for a backend (S7): `<prefix>.defaultModel` etc. An
 *  unknown backend reads its OWN id family (never claude's — the old
 *  `=== 'codex' ? … : 'claude'` collapse fed a third backend claude's
 *  defaults). */
/** Picker label for an effort level: the plain value (capitalized for the
 *  New-Session / settings pickers, lowercase for the status-bar rows) plus the
 *  harness's META `effortHints` one-liner when the level has one (codex
 *  'ultra' → "… — delegates to sub-agents (multi-agent), extra usage"). */
export function effortLabel(backend, value, { capitalize = false } = {}) {
  const v = String(value || '');
  const base = capitalize ? v.charAt(0).toUpperCase() + v.slice(1) : v;
  const hint = BACKEND_META[backend]?.effortHints?.[v];
  return hint ? `${base} — ${t(hint)}` : base;
}

// ── MODEL CATALOG (2.369.62) ──
// The per-model facts /api/available-models carries that are NOT pickable
// options — today only `multiAgentEffort` (the catalog's own
// multi_agent_reasoning_effort). Kept HERE rather than in app.js because the
// consumers are chat surfaces and agent-meta may not import app.js (app.js
// imports this module). Every fetcher of /api/available-models feeds it; an
// unknown backend/model simply answers ''.
const MODEL_CATALOG = new Map(); // `${backend}:${modelId}` → { multiAgentEffort }

/** Record what the server's model catalog says about a backend's models. */
export function noteModelCatalog(backend, models) {
  if (!backend || !Array.isArray(models)) return;
  for (const m of models) {
    if (!m || !m.id) continue;
    MODEL_CATALOG.set(`${backend}:${m.id}`, { multiAgentEffort: m.multiAgentEffort || '' });
  }
}

/** The reasoning level a DELEGATING effort actually runs the model at, per the
 *  catalog. '' when the model is unknown or the catalog names none — callers
 *  must then say nothing rather than guess (the level is per-model and moves
 *  with every codex release; hardcoding it is how a label goes quietly stale). */
export function multiAgentReasoningFor(backend, model) {
  if (!backend || !model) return '';
  return MODEL_CATALOG.get(`${backend}:${model}`)?.multiAgentEffort || '';
}

/** How an effort VALUE is shown to a human (metadata popup, status-bar
 *  tooltip). Almost always the value itself — the exception is a harness whose
 *  META names a `multiAgentEffort`: codex's 'ultra' is a delegation mode, and
 *  the reasoning level the model actually runs at is a DIFFERENT string from
 *  the catalog. Saying just "xhigh" there (what the ledger and turn_context
 *  legitimately record for such a turn) reads as "your ultra was ignored";
 *  saying just "ultra" hides why every other readout says xhigh. So we say
 *  both, and only when the catalog knows the level. PURE. */
export function effortDisplay(backend, value, { model = '' } = {}) {
  const v = String(value || '');
  if (!v || BACKEND_META[backend]?.multiAgentEffort !== v) return v;
  const level = multiAgentReasoningFor(backend, model);
  return level ? t('{effort} (multi-agent · reasoning {level})', { effort: v, level }) : v;
}

/** Picker label for a response-style VALUE: the harness's own protocol string
 *  plus its META `responseStyleHints` one-liner ("Concise \u2014 lead with results\u2026").
 *  The empty string is the UNSET row and is labelled by the caller. */
export function responseStyleLabel(backend, value) {
  const v = String(value || '');
  const hint = BACKEND_META[backend]?.responseStyleHints?.[v];
  return hint ? `${v} \u2014 ${t(hint)}` : v;
}

/** The harness's response-style capability row ({live, values}) — mirrors the
 *  server's backend-caps entry; unknown backend = the no-knob row. */
export function responseStyleCaps(backend) {
  return backendFeatureCaps(backend).responseStyle || NO_FEATURE_CAPS.responseStyle;
}

/** PURE (DOM-free, suite-tested): can a style change land on THIS session
 *  without a restart? TWO independent facts — and forgetting the second one is
 *  a shipped class of bug (2.361.1 / 2.364.1, and here in r2 review):
 *    ① the HARNESS caps row says the protocol supports it at all;
 *    ② the RUNNING WRAPPER's own advert says this process serves the verb —
 *       a codex session spawned before the live-switch release does not, and
 *       the server refuses it (`code:'style-wrapper-old'`, which is what
 *       flips this flag; `style-not-live` is the transient/other refusal).
 *  `wrapperLive === undefined` = "not told yet" (the creator payload cannot
 *  know: the sidecar is not written at spawn time) ⇒ TRY it; a refusal flips
 *  the flag to false and the restart row appears in the same menu. */
export function styleAppliesLive(caps, wrapperLive) {
  return !!(caps && caps.live) && wrapperLive !== false;
}

/** PURE (DOM-free, suite-tested): what the COMPOSER may do while a turn is
 *  running, from ONE `inputModes` row. The caller passes the caps it has
 *  already intersected with the RUNNING wrapper's advert (chat-view's
 *  `_queueCaps()` — the very object the queue strip's Steer buttons read), so
 *  the chord, the hint and the strip can never disagree about this session.
 *    steerSegment / allowSteerChord — Alt+Enter injects into the running turn
 *      (`steer`). A chord that would silently degrade to a plain send is worse
 *      than no chord, so the two are the SAME fact.
 *    queueSegment — say that Enter queues. Gated on `queueOps`, not on `queue`:
 *      claude's CLI really does hold a mid-turn message, but it publishes no
 *      queue and takes no operation on it, so there is no strip, no live chip
 *      and nothing to act on — a line announcing "it is queued" with nothing on
 *      screen to show it is a promise we cannot keep (the 2.361.4
 *      accept-and-ignore lesson, in text form).
 *    showHint — draw the line at all. `false` ⇒ no hint AND no chord (claude,
 *      shell, and any unknown backend).
 *  WHERE the two surfaces appear is CSS's business, not this predicate's: the
 *  hint is the desktop face and the bolt button beside Send is the ≤768px one
 *  (chat.css, same shape as `.chat-attach-btn`). */
export function composerSendModes(caps) {
  const queue = !!(caps && caps.queue);
  const steer = !!(caps && caps.steer);
  const queueOps = !!(caps && caps.queueOps);
  const queueSegment = queue && queueOps;
  return { queueSegment, steerSegment: steer, allowSteerChord: steer, showHint: queueSegment || steer };
}

/** PURE: WHICH FACT is the response style a panel is showing? `live` = what the
 *  running session was started/updated with (server truth, '' = no key was ever
 *  sent), `picked` = the pick saved for this conversation (undefined = never
 *  picked here). Keying only on "does a pick exist" called the value the user's
 *  choice while the panel's own pending note said the pick had not landed yet
 *  (r2 review) — the two must agree, so they read the same comparison. */
export function responseStyleOrigin(live, picked) {
  const l = live || '';
  const p = picked === undefined ? undefined : (picked || '');
  if (l) {
    if (p === undefined) return 'instance';  // no pick here ⇒ the spawn read the instance default
    if (p === l) return 'chosen';
    return 'spawn';                          // a DIFFERENT pick is saved; the live value dates from the spawn
  }
  return p ? 'saved' : 'harness';
}

export function settingsPrefixFor(backend) {
  const b = backend || 'claude';
  return BACKEND_META[b]?.settingsPrefix ?? b;
}

/** Feature caps for a backend (all-false for unknown/shell — chrome shows nothing it can't do). */
const NO_FEATURE_CAPS = Object.freeze({ fork: false, effort: false, review: false, autoResume: false, responseStyle: Object.freeze({ live: false, closed: true, values: Object.freeze([]) }) });
export function backendFeatureCaps(backend) {
  return BACKEND_META[backend]?.caps || NO_FEATURE_CAPS;
}

/** Every backend's agent-memory path pattern (see BACKEND_META.claude). */
export function agentMemoryPathRes() {
  return Object.values(BACKEND_META).map((m) => m.memoryPathRe).filter(Boolean);
}

export function getBackendMeta(backend) {
  return BACKEND_META[backend] || {
    id: backend || 'unknown',
    label: backend || 'Unknown',
    shortLabel: (backend || 'UNKNOWN').toUpperCase(),
    badgeClass: 'badge-backend-generic',
    color: 'var(--text-dim)',
    icon: '•',
    iconSrc: '',
    iconClass: 'backend-icon-generic',
    brandColor: '',
  };
}

const MIN_ICON_CONTRAST = 4.2;

function parseCssColor(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  const hex = value.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const raw = hex[1];
    if (raw.length === 3 || raw.length === 4) {
      const [r, g, b] = raw.slice(0, 3).split('').map((ch) => parseInt(ch + ch, 16));
      return { r, g, b, a: raw.length === 4 ? parseInt(raw[3] + raw[3], 16) / 255 : 1 };
    }
    if (raw.length === 6 || raw.length === 8) {
      return {
        r: parseInt(raw.slice(0, 2), 16),
        g: parseInt(raw.slice(2, 4), 16),
        b: parseInt(raw.slice(4, 6), 16),
        a: raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1,
      };
    }
  }

  const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgb) return null;
  const parts = rgb[1].split(',').map((part) => parseFloat(part.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  return {
    r: Math.max(0, Math.min(255, parts[0])),
    g: Math.max(0, Math.min(255, parts[1])),
    b: Math.max(0, Math.min(255, parts[2])),
    a: Number.isFinite(parts[3]) ? Math.max(0, Math.min(1, parts[3])) : 1,
  };
}

function mixColors(base, target, amount) {
  const t = Math.max(0, Math.min(1, amount));
  return {
    r: Math.round((base.r * (1 - t)) + (target.r * t)),
    g: Math.round((base.g * (1 - t)) + (target.g * t)),
    b: Math.round((base.b * (1 - t)) + (target.b * t)),
    a: 1,
  };
}

function compositeColors(fg, bg) {
  const fgAlpha = Number.isFinite(fg?.a) ? Math.max(0, Math.min(1, fg.a)) : 1;
  const bgAlpha = Number.isFinite(bg?.a) ? Math.max(0, Math.min(1, bg.a)) : 1;
  const outAlpha = fgAlpha + (bgAlpha * (1 - fgAlpha));
  if (outAlpha <= 0.001) return { r: 255, g: 255, b: 255, a: 0 };
  return {
    r: Math.round(((fg.r * fgAlpha) + (bg.r * bgAlpha * (1 - fgAlpha))) / outAlpha),
    g: Math.round(((fg.g * fgAlpha) + (bg.g * bgAlpha * (1 - fgAlpha))) / outAlpha),
    b: Math.round(((fg.b * fgAlpha) + (bg.b * bgAlpha * (1 - fgAlpha))) / outAlpha),
    a: outAlpha,
  };
}

function relativeLuminance({ r, g, b }) {
  const toLinear = (channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [r, g, b].map(toLinear);
  return (0.2126 * lr) + (0.7152 * lg) + (0.0722 * lb);
}

function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToCss({ r, g, b }) {
  return `rgb(${r}, ${g}, ${b})`;
}

function findEffectiveBackgroundColor(el) {
  const layers = [];
  let node = el;
  while (node && node !== document.documentElement) {
    const bg = parseCssColor(getComputedStyle(node).backgroundColor);
    if (bg && bg.a > 0.02) {
      layers.push(bg);
      if (bg.a >= 0.999) break;
    }
    node = node.parentElement;
  }

  const rootStyles = getComputedStyle(document.documentElement);
  const bodyStyles = document.body ? getComputedStyle(document.body) : null;
  const rootBg = parseCssColor(rootStyles.getPropertyValue('--bg-root'))
    || parseCssColor(rootStyles.backgroundColor)
    || parseCssColor(bodyStyles?.backgroundColor || '');

  let composite = rootBg
    ? { r: rootBg.r, g: rootBg.g, b: rootBg.b, a: 1 }
    : { r: 255, g: 255, b: 255, a: 1 };

  for (let i = layers.length - 1; i >= 0; i -= 1) {
    composite = compositeColors(layers[i], composite);
  }

  return { r: composite.r, g: composite.g, b: composite.b, a: 1 };
}

function computeAdaptiveBrandColor(meta, el) {
  const original = parseCssColor(meta.brandColor);
  if (!original) return '';
  const bg = findEffectiveBackgroundColor(el.parentElement || el);
  if (contrastRatio(original, bg) >= MIN_ICON_CONTRAST) return meta.brandColor;

  const styles = getComputedStyle(el);
  const textColor = parseCssColor(styles.getPropertyValue('--text')) || parseCssColor(styles.color) || original;
  if (contrastRatio(textColor, bg) >= MIN_ICON_CONTRAST && meta.brandColor === '#000000') {
    return rgbToCss(textColor);
  }
  let best = original;
  for (let step = 0.12; step <= 1.001; step += 0.08) {
    const candidate = mixColors(original, textColor, step);
    best = candidate;
    if (contrastRatio(candidate, bg) >= MIN_ICON_CONTRAST) break;
  }
  return rgbToCss(best);
}

function applyBackendIconContrast(el, meta = getBackendMeta(el?.dataset?.backend)) {
  if (!el || !meta || !meta.iconSrc || !meta.brandColor) return;
  const color = computeAdaptiveBrandColor(meta, el) || meta.brandColor;
  el.style.setProperty('--backend-icon-color', color);
}

let refreshTimer = null;

export function refreshBackendIcons(root = document) {
  const scope = root?.querySelectorAll ? root : document;
  scope.querySelectorAll('.backend-icon[data-backend]').forEach((el) => applyBackendIconContrast(el));
}

function scheduleBackendIconRefresh(target) {
  let attempts = 0;
  const run = () => {
    if (!target) return;
    if (target.isConnected) {
      applyBackendIconContrast(target);
      return;
    }
    if (attempts >= 6) return;
    attempts += 1;
    requestAnimationFrame(run);
  };
  requestAnimationFrame(run);
}

if (typeof window !== 'undefined') {
  window.addEventListener('theme-colors-changed', () => {
    if (refreshTimer) cancelAnimationFrame(refreshTimer);
    refreshTimer = requestAnimationFrame(() => refreshBackendIcons(document));
  });

  const observeBackendIcons = () => {
    if (!document.body || window.__backendIconObserverInstalled) return;
    window.__backendIconObserverInstalled = true;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches?.('.backend-icon[data-backend]')) {
            scheduleBackendIconRefresh(node);
          }
          node.querySelectorAll?.('.backend-icon[data-backend]').forEach((el) => scheduleBackendIconRefresh(el));
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeBackendIcons, { once: true });
  } else {
    observeBackendIcons();
  }
}

export const AGENT_KIND_META = {
  primary: {
    id: 'primary',
    label: 'Primary',
    shortLabel: 'MAIN',
    icon: '●',
    iconClass: 'agent-kind-icon-primary',
    color: 'var(--text-dim)',
  },
  subagent: {
    id: 'subagent',
    label: 'Subagent',
    shortLabel: 'SUB',
    icon: '↳',
    iconClass: 'agent-kind-icon-subagent',
    color: 'var(--yellow)',
  },
  review: {
    id: 'review',
    label: 'Review',
    shortLabel: 'REV',
    icon: '✓',
    iconClass: 'agent-kind-icon-review',
    color: 'var(--blue)',
  },
};

export function getAgentKindMeta(kind) {
  return AGENT_KIND_META[kind] || {
    id: kind || 'unknown',
    label: kind || 'Unknown',
    shortLabel: (kind || 'UNK').slice(0, 4).toUpperCase(),
    icon: '•',
    iconClass: 'agent-kind-icon-generic',
    color: 'var(--text-dim)',
  };
}

export function pickAgentIdentity(source = {}) {
  return {
    backend: source.backend || 'claude',
    backendSessionId: source.backendSessionId || source.sessionId || null,
    sessionKey: source.sessionKey || getSessionKey(source),
    agentKind: source.agentKind || 'primary',
    agentRole: source.agentRole || '',
    agentNickname: source.agentNickname || '',
    sourceKind: source.sourceKind || '',
    parentThreadId: source.parentThreadId || null,
  };
}

export function getBackendSessionId(source = {}) {
  if (source.backendSessionId || source.sessionId || source.claudeSessionId) {
    return source.backendSessionId || source.sessionId || source.claudeSessionId || null;
  }
  if (typeof source.sessionKey === 'string' && source.sessionKey.includes(':')) {
    return source.sessionKey.split(':').slice(1).join(':') || null;
  }
  return null;
}

export function getSessionKey(source = {}) {
  if (typeof source.sessionKey === 'string' && source.sessionKey) return source.sessionKey;
  const backend = source.backend || 'claude';
  const backendSessionId = getBackendSessionId(source);
  return backendSessionId ? `${backend}:${backendSessionId}` : '';
}

export function createBackendIcon(backend, { title, className = '' } = {}) {
  const meta = getBackendMeta(backend);
  const el = document.createElement('span');
  el.className = `backend-icon ${meta.iconClass} ${className}`.trim();
  el.dataset.backend = meta.id;
  el.title = title || meta.label;
  el.setAttribute('aria-label', title || meta.label);
  if (meta.iconSrc) {
    const mark = document.createElement('span');
    mark.className = 'backend-icon-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.style.setProperty('--backend-icon-mask', `url("${meta.iconSrc}")`);
    el.appendChild(mark);
    el.style.setProperty('--backend-icon-color', meta.brandColor || '');
    scheduleBackendIconRefresh(el);
  } else {
    el.textContent = meta.icon;
  }
  return el;
}

export function createBackendIconHtml(backend, opts = {}) {
  return createBackendIcon(backend, opts).outerHTML;
}

export function createAgentKindIcon(kind, { title, className = '' } = {}) {
  const meta = getAgentKindMeta(kind);
  const el = document.createElement('span');
  el.className = `agent-kind-icon ${meta.iconClass || ''} ${className}`.trim();
  el.textContent = meta.icon;
  el.title = title || meta.label;
  el.setAttribute('aria-label', title || meta.label);
  return el;
}

/**
 * Create a backend icon with a small mode badge in the corner.
 * Backend logo at normal size, mode indicated by a tiny corner dot.
 */
export function createModeBackendIcon(backend, mode, { title, className = '' } = {}) {
  const icon = createBackendIcon(backend, { title: title || `${getBackendMeta(backend).label} ${mode === 'chat' ? 'Chat' : 'Terminal'}`, className });
  icon.classList.add('mode-backend-icon');
  const badge = document.createElement('span');
  badge.className = 'mode-badge';
  if (mode === 'chat') {
    badge.innerHTML = `<svg viewBox="0 0 10 10" fill="none" stroke="var(--text)" stroke-width="1.2" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M1 1.8a1.2 1.2 0 0 1 1.2-1.2h5.6A1.2 1.2 0 0 1 9 1.8v4.4a1.2 1.2 0 0 1-1.2 1.2H4.2L1 9.5V1.8Z" fill="var(--bg-sidebar, var(--bg-root))"/></svg>`;
  } else {
    badge.innerHTML = `<svg viewBox="0 0 10 10" fill="none" stroke="var(--text)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M1 2.5l3 2.5-3 2.5"/><path d="M5.5 8h3.5"/></svg>`;
  }
  icon.appendChild(badge);
  return icon;
}

export function getAgentRoleLabel(role) {
  if (!role) return null;
  return String(role).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
}

export function getAgentRoleShortLabel(role) {
  const label = getAgentRoleLabel(role);
  if (!label) return null;
  const normalized = label.toLowerCase();
  const predefined = {
    default: 'DEF',
    explorer: 'EXP',
    worker: 'WRK',
    reviewer: 'REV',
    planner: 'PLN',
    assistant: 'AST',
  };
  if (predefined[normalized]) return predefined[normalized];
  const compact = label
    .split(/\s+/)
    .map(part => part[0] || '')
    .join('')
    .slice(0, 3)
    .toUpperCase();
  return compact || label.slice(0, 3).toUpperCase();
}
