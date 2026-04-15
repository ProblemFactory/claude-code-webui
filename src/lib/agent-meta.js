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
  },
};

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
  scope.querySelectorAll('.backend-icon[data-backend], .mode-backend-logo[data-backend]').forEach((el) => applyBackendIconContrast(el));
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
