import { escHtml, copyText, fetchJson, showToast, createModalShell } from './utils.js';
import { t } from './i18n.js';
import { UI_ICONS } from './icons.js';
import { permissionRulesCaps, getBackendMeta } from './agent-meta.js';
import { renderRuleTree, ruleTreeSummary } from '../permission-rules.js'; // PURE, shared with the server (CJS pulled into the bundle, like search-card.js)

/**
 * THE READ-ONLY "Permission rules" VIEW (owner ruling 10 — 只读).
 *
 * One tree per harness answering ONE question: *where does this rule come
 * from*. Every layer prints its own source (the harness's own name for it) and
 * its FILE when it has one, with a copy-path action. There is no edit control
 * anywhere in this file and there is no write route behind it.
 *
 * Which harness can answer, and at which scope, comes from the caps row
 * (`permissionRulesCaps`) — never from a backend id. A harness that cannot
 * answer says why (typed reason from the server), never an empty tree.
 *
 * ≤768px: the tree is a plain vertical stack (the layer head wraps, the path
 * button becomes full-width) — see .perm-rules in public/style.css. The modal
 * used by Manage Agents is createModalShell, which is already mobile-sized.
 */

const COPY_ICON = UI_ICONS.clipboard || '';

/** Wire the "copy path" buttons inside a rendered tree. The paths come from
 *  the server record and are ESCAPED into `data-copy` by the PURE renderer;
 *  reading them back through the dataset is the only way they re-enter JS. */
function bindCopyPaths(root) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.perm-layer-path[data-copy]');
    if (!btn) return;
    const p = btn.dataset.copy || '';
    if (!p) return;
    copyText(p);
    const prev = btn.getAttribute('title');
    btn.setAttribute('title', t('Copied!'));
    setTimeout(() => { try { btn.setAttribute('title', prev || t('Copy path')); } catch { } }, 900);
    showToast(t('Path copied'), { duration: 1200 });
  });
}

/**
 * Fetch one record. NEVER throws (fetchJson does not), and a transport failure
 * is turned into the SAME typed shape the server produces, so the renderer has
 * exactly one input shape and the honest-empty-state rule holds on every path.
 */
export async function fetchPermissionRules({ backend, scope = 'session', sessionId = '', cwd = '', accountId = '', host = '' } = {}) {
  const q = new URLSearchParams({ backend: backend || 'claude', scope });
  if (sessionId) q.set('sessionId', sessionId);
  if (cwd) q.set('cwd', cwd);
  if (accountId) q.set('accountId', accountId);
  if (host) q.set('host', host);
  const r = await fetchJson(`/api/permission-rules?${q.toString()}`);
  if (!r || r.error) {
    return { backend: backend || 'claude', scope, cwd: cwd || null, host: host || null, ok: false, reason: 'read-failed', detail: r?.error || t('the server did not answer'), layers: [], truncated: false };
  }
  return r;
}

/**
 * Render a record into `el`. Returns the record so a caller can show a
 * summary line beside a collapsed section.
 */
export function renderInto(el, record) {
  el.classList.add('perm-rules');
  el.innerHTML = renderRuleTree(record, { esc: escHtml, t, icons: { copy: COPY_ICON } });
  if (!el._permCopyBound) { bindCopyPaths(el); el._permCopyBound = true; }
  return record;
}

/** The one-line summary a collapsed row shows. */
export function summaryLine(record) { return ruleTreeSummary(record, { t }); }

/**
 * Load + render, with an honest in-flight state. HUMAN-TRIGGERED by every
 * caller (a click) — nothing here polls, and the codex instance rung spawns a
 * bounded app-server child, so an automatic refresh would be a process per
 * repaint.
 */
export async function loadInto(el, query) {
  el.classList.add('perm-rules');
  el.innerHTML = `<div class="perm-rules-empty">${escHtml(t('Reading…'))}</div>`;
  const rec = await fetchPermissionRules(query);
  if (!el.isConnected) return rec;
  return renderInto(el, rec);
}

/**
 * The instance-scope modal (Manage Agents). `backend` decides the rung; the
 * caps row decides whether the caller offered it at all.
 */
export function openPermissionRulesDialog({ backend, accountId = '', accountName = '', cwd = '' } = {}) {
  const label = getBackendMeta(backend)?.label || backend;
  const { body } = createModalShell({
    id: 'perm-rules-dialog',
    title: accountName ? t('Permission rules — {name}', { name: accountName }) : t('Permission rules — {backend}', { backend: label }),
    minWidth: '520px', escapeToClose: true,
  });
  const note = document.createElement('div');
  note.className = 'agents-note';
  note.textContent = t('Read-only. VibeSpace never changes an agent’s permission rules — edit them where they live.');
  const tree = document.createElement('div');
  body.append(note, tree);
  loadInto(tree, { backend, scope: 'instance', accountId, cwd });
  return body;
}

/**
 * ruling 6 — run ONE registered LOCAL ORACLE and show its output.
 * The button is the ONLY trigger. The modal shows typed JSON when the CLI
 * offers a JSON flag, monospace text otherwise (and always both streams: a
 * `codex login status` answers on stderr, and a silent stderr is where a real
 * failure hides).
 */
export async function runLocalOracle({ id, label, accountId = '', accountName = '' } = {}) {
  const { body } = createModalShell({
    id: 'local-oracle-dialog',
    title: accountName ? `${label} — ${accountName}` : label,
    minWidth: '520px', escapeToClose: true,
  });
  const note = document.createElement('div');
  note.className = 'agents-note';
  note.textContent = t('Runs a local, read-only CLI command on this machine. It makes no network requests (measured) and runs only when you click.');
  const out = document.createElement('div');
  out.className = 'oracle-output';
  out.innerHTML = `<div class="perm-rules-empty">${escHtml(t('Running…'))}</div>`;
  body.append(note, out);
  const r = await fetchJson(`/api/local-oracle/${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId }),
  });
  if (!out.isConnected) return r;
  if (!r || r.error || r.ok === false) {
    const why = r?.detail || r?.error || t('the command could not be run');
    out.innerHTML = `<div class="perm-rules-empty">${escHtml(why)}</div>`;
    return r;
  }
  const parts = [];
  parts.push(`<div class="oracle-cmd">${escHtml(`${r.backend} ${(r.argv || []).join(' ')}`)}${r.exitCode === 0 ? '' : ` <span class="ob-warn">${escHtml(t('exit {code}', { code: r.exitCode }))}</span>`}</div>`);
  if (r.json) {
    parts.push(`<pre class="oracle-body oracle-json">${escHtml(JSON.stringify(r.json, null, 2))}</pre>`);
  } else {
    if (r.jsonError) parts.push(`<div class="oracle-note">${escHtml(t('The CLI offers a JSON flag but this output did not parse ({why}) — showing it verbatim.', { why: r.jsonError }))}</div>`);
    const text = [r.stdout || '', r.stderr || ''].filter((x) => x.trim()).join('\n');
    parts.push(`<pre class="oracle-body">${escHtml(text || t('(no output)'))}</pre>`);
  }
  // A JSON oracle that ALSO said something on stderr must show it — a
  // clean-looking JSON body next to a swallowed warning is how a half-failure
  // reads as a success.
  if (r.json && (r.stderr || '').trim()) parts.push(`<div class="oracle-note">${escHtml(t('stderr:'))}</div><pre class="oracle-body">${escHtml(r.stderr)}</pre>`);
  if (r.truncated) parts.push(`<div class="oracle-note">${escHtml(t('Output was capped — this is the beginning of it.'))}</div>`);
  out.innerHTML = parts.join('');
  return r;
}

/** Does this backend have a rule surface at the given scope? (chrome gate) */
export function hasRuleSurface(backend, scope = 'session') {
  const c = permissionRulesCaps(backend);
  return !!c.source && (scope === 'instance' ? !!c.instance : !!c.session);
}
