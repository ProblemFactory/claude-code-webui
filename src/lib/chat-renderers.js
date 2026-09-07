/**
 * ChatRenderers — extracted rendering methods from ChatView.
 * Handles all message rendering, linkification, wrap toggles,
 * and open-in-editor functionality for the chat interface.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { escHtml, copyText, showContextMenu, showToast, absUrl } from './utils.js';
import { track } from './telemetry-client.js';
import { renderCodeBlock, rehighlightCodeBlock, stripAnsi, getHljsLanguages } from './highlight.js';
import { UI_ICONS } from './icons.js';
import { agentMemoryPathRes } from './agent-meta.js';
import { createBackendIconHtml, getBackendMeta } from './agent-meta.js';
import { t } from './i18n.js';
import { searchQueryOf } from '../search-card.js'; // shared with the server (CJS pulled into the bundle, like task-color-seq.js)
import { mcpParts } from './chat-run-summary.js';
// PURE builder (CJS pulled into the bundle, like ssh-key-format.js) — the
// codex multi-agent collab rows (B-7473). Escaper/translator/icons are
// injected so the whole surface is unit-testable outside a browser.
import { collabRowsHtml, collabReportHeadText, collabRowTitle } from '../collab-row.js';

// Agent-memory files get their own card treatment (user ask: a memory write
// is a different concern than a project write — render "记忆更新 <name>"
// instead of a Write card with a long dotfile path). Full path stays on the
// link's data-path (copy/Ctrl+click unchanged).
const MEMORY_RES = agentMemoryPathRes();
function memoryBase(fp) {
  return fp && MEMORY_RES.some((re) => re.test(fp)) ? fp.split('/').pop() : null;
}

// MCP tool ids (mcp__<server>__<tool>) split into their parts — ONE
// implementation, shared with the run-fold classifier (chat-run-summary.js,
// pure; re-exported here for the existing importers).
export { mcpParts };

// Escaped HTML for a tool-card header: curated display name, or for MCP
// tools the SHORT tool name (underscores → spaces) + a dim server chip.
// The raw identifier always rides the card's title tooltip.
export function toolHeaderHtml(name) {
  const mcp = mcpParts(name);
  if (mcp) return `${escHtml(mcp.tool.replace(/_/g, ' '))} <span class="chat-tool-chip" title="MCP server">${escHtml(mcp.server)}</span>`;
  return escHtml(toolDisplayName(name));
}

// Search-kind cards carry their query/url IN THE TITLE (2.369.43, owner ask:
// "see what was searched without expanding"): claude WebSearch/WebFetch by
// tool name, codex web_search/web_fetch + ACP search tools by the normalizer's
// `collapseKind` hint. The text is MODEL/WEB-controlled and syncs to every
// client — escHtml on both the chip and its title attribute (XSS law); the
// chip is truncated, the tooltip carries the full string. '' when nothing to
// show (a pending codex card is an empty stub until item/completed).
const SEARCH_TITLE_MAX = 90;
export function searchQueryChipHtml(block, msg) {
  const tn = block?.toolName;
  if (!(msg?.collapseKind === 'search' || tn === 'WebSearch' || tn === 'WebFetch')) return '';
  const q = searchQueryOf(block?.input);
  if (!q) return '';
  const short = q.length > SEARCH_TITLE_MAX ? q.slice(0, SEARCH_TITLE_MAX - 1) + '…' : q;
  return ` <span class="chat-tool-query" title="${escHtml(q)}">${escHtml(short)}</span>`;
}

// Curated localized display names for harness built-in tools (fallback: raw
// name — MCP/unknown tools keep their identifier as plain text; the typing
// label and other TEXT contexts get "tool · server" for MCP). See also
// toolHeaderHtml for the HTML card headers.
export function toolDisplayName(name) {
  const M = {
    TaskCreate: t('Create task'), TaskUpdate: t('Update task'), TaskList: t('List tasks'),
    TaskGet: t('View task'), TaskStop: t('Stop task'), TaskOutput: t('Task output'),
    TodoWrite: t('Update todos'), WebSearch: t('Web search'), WebFetch: t('Fetch page'),
    Glob: t('Find files'), Grep: t('Search text'), LS: t('List directory'),
    NotebookEdit: t('Edit notebook'), AskUserQuestion: t('Ask user'),
    EnterPlanMode: t('Enter plan mode'), ExitPlanMode: t('Exit plan mode'),
    KillShell: t('Kill shell'), BashOutput: t('Shell output'),
    SendMessage: t('Send message'), Skill: t('Skill'),
    web_search: t('Web search'), web_fetch: t('Fetch page'), // codex raw names (2.369.43) — same labels as claude's
  };
  if (M[name]) return M[name];
  const mcp = mcpParts(name);
  if (mcp) return `${mcp.tool.replace(/_/g, ' ')} · ${mcp.server}`;
  return name;
}


// Shell-command tools get a terminal icon instead of the generic wrench
// (covers Claude Bash/BashOutput/KillShell and Codex exec_command/write_stdin
// which normalize to Bash/Terminal).
const SHELL_TOOL_NAMES = new Set(['Bash', 'BashOutput', 'KillShell', 'Terminal']);
// Direction icons for codex collab rows (see collab-row.js — SVG, never glyphs)
export const COLLAB_ICONS = {
  in: UI_ICONS.agentIn,
  out: UI_ICONS.agentOut,
  spawn: UI_ICONS.agentSpawn,
  wait: UI_ICONS.hourglass,
  activity: UI_ICONS.agentDot,
  lock: UI_ICONS.lock,
};
const toolCardIcon = (name) => (name === 'Agent' ? UI_ICONS.robot : SHELL_TOOL_NAMES.has(name) ? UI_ICONS.terminal : UI_ICONS.wrench);
// Model chip on Agent cards — shows the DECLARED model (tool input) at render;
// _onSubagentMessage upgrades it to the model actually observed serving.
const agentModelChip = (model) => (model ? `<span class="chat-agent-model">${escHtml(model)}</span>` : '');

// ── Image media cards (2.369.48, owner: "view image 能不能也多媒体化") ──
// Every image a tool looked at renders as ONE media block: an expandable
// <details> (open by default — the owner wants to SEE it) whose body is the
// image itself, click-to-zoom through the standard .chat-img overlay. The
// bytes never ride the message (2.369.35 law): a file on disk is drawn from
// /api/file/raw (host-qualified for remote sessions — the SAME url the file
// viewer uses, so ?host= dispatches to the machine that owns the file); an
// inline data: URL is only accepted for the small images a harness hands us
// directly (ACP/claude user attachments). `loading="lazy"` + the fold's
// display:none means a collapsed run never fetches its thumbnails.
// IMAGE_EXT_RE answers ONE question — can the browser DECODE this file as an
// <img>? — and so decides thumbnail-vs-chip only. Whether a Read's result IS
// an image is decided by the lifted image blocks (`block.images`), never by
// the extension: claude returns numbered TEXT for a text-source image format
// — MEASURED for .svg (real fleet transcripts, cli 2.1.85: every one of the
// 10 local `Read *.svg` tool_results is a plain string starting "1\t<svg …",
// 4 of them in one session; .ico is the same class, unmeasured here) — while
// a tiff/heic Read returns image blocks the browser cannot draw.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
export function isImagePath(fp) { return !!fp && IMAGE_EXT_RE.test(String(fp)); }
export function imageRawUrl(fp, host) {
  return `/api/file/raw?path=${encodeURIComponent(fp)}${host ? `&host=${encodeURIComponent(host)}` : ''}`;
}
const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
/**
 * @param {object} o
 * @param {string} [o.path]      absolute file path (drawn from disk via /api/file/raw)
 * @param {string} [o.host]      hostId for remote sessions (null/'' = this machine)
 * @param {string} [o.mediaType] e.g. image/png (summary chip)
 * @param {number} [o.bytes]     decoded size (summary chip)
 * @param {string} [o.dataUrl]   inline data: URL (harness-supplied small image)
 * @param {string} [o.name]      summary label (default: basename of path)
 * @param {boolean} [o.open]     expanded by default (true)
 * @returns {string} HTML — a <details class="chat-media"> block, or a size chip when there is nothing drawable
 */
export function imageMediaHtml({ path = '', host = null, mediaType = '', bytes = 0, dataUrl = null, name = '', open = true } = {}) {
  const label = name || (path ? String(path).split('/').pop() : '') || t('Image');
  const meta = [mediaType, bytes > 0 ? fmtBytes(bytes) : ''].filter(Boolean).join(' · ');
  const src = dataUrl || (path ? imageRawUrl(path, host) : '');
  if (!src) return `<span class="chat-tool-image-chip">${escHtml(meta || t('Image'))}</span>`;
  const metaHtml = meta ? ` <span class="chat-media-meta">${escHtml(meta)}</span>` : '';
  // the "missing" line is display:none until the <img> fires error (ChatView's
  // capture-phase listener flags .chat-media-broken — no inline handlers)
  return `<details class="chat-diff chat-media"${open ? ' open' : ''}><summary class="chat-diff-summary">${UI_ICONS.image} ${escHtml(label)}${metaHtml}</summary><div class="chat-media-body"><img class="chat-img chat-tool-img" loading="lazy" src="${escHtml(src)}" alt="${escHtml(label)}"><span class="chat-media-missing">${escHtml(t('Image not available on this machine'))}</span></div></details>`;
}

function normalizeUserInputAnswers(rawAnswers) {
  if (!rawAnswers || typeof rawAnswers !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(rawAnswers)) {
    if (Array.isArray(value)) {
      result[key] = value.map((entry) => String(entry));
    } else if (value && typeof value === 'object' && Array.isArray(value.answers)) {
      result[key] = value.answers.map((entry) => String(entry));
    }
  }
  return result;
}

function normalizePatchChangeType(rawType) {
  const normalized = String(
    typeof rawType === 'string'
      ? rawType
      : rawType?.type || rawType?.kind || '',
  ).toLowerCase();
  if (normalized === 'create' || normalized === 'insert') return 'add';
  if (normalized === 'remove') return 'delete';
  if (normalized === 'rename') return 'move';
  return normalized || 'update';
}

function normalizePatchChanges(rawChanges) {
  const changes = [];
  const pushChange = (fallbackPath, raw) => {
    const entry = raw && typeof raw === 'object' ? raw : {};
    const filePath = entry.path || entry.file_path || entry.filePath || fallbackPath || '';
    const changeType = normalizePatchChangeType(entry.type || entry.kind);
    const movePath = entry.move_path || entry.movePath || entry.new_path || entry.newPath || '';
    const unifiedDiff = entry.unified_diff || entry.unifiedDiff || '';
    const diff = entry.diff || '';
    const content = entry.content || '';
    if (!filePath && !movePath && !unifiedDiff && !diff && !content) return;
    changes.push({ filePath, changeType, movePath, unifiedDiff, diff, content });
  };

  if (Array.isArray(rawChanges)) {
    for (const entry of rawChanges) pushChange('', entry);
    return changes;
  }
  if (rawChanges && typeof rawChanges === 'object') {
    for (const [filePath, entry] of Object.entries(rawChanges)) pushChange(filePath, entry);
  }
  return changes;
}

function parseUnifiedDiffLines(text) {
  const diffLines = [];
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.startsWith('@@') && (line.startsWith('---') || line.startsWith('+++'))) continue;
    if (line.startsWith('@@')) {
      diffLines.push({ type: 'ctx', prefix: '@@', text: line });
    } else if (line.startsWith('+')) {
      diffLines.push({ type: 'add', prefix: '+', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      diffLines.push({ type: 'del', prefix: '-', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      diffLines.push({ type: 'ctx', prefix: ' ', text: line.slice(1) });
    } else if (line.startsWith('\\')) {
      diffLines.push({ type: 'ctx', prefix: '\\', text: line });
    } else {
      diffLines.push({ type: 'ctx', prefix: ' ', text: line });
    }
  }
  return diffLines;
}

class ChatRenderers {
  /**
   * @param {Object} opts
   * @param {Object} opts.ws - WebSocket manager (for permission responses)
   * @param {string} opts.sessionId - Current session ID
   * @param {Object} opts.app - App controller (for opening files/editors)
   * @param {boolean} opts.compact - Compact mode flag
   * @param {HTMLElement} opts.messageList - Message list DOM element
   * @param {Function} [opts.onPermissionResolve] - Called when a permission is resolved (allow/deny)
   */
  constructor({ ws, sessionId, app, backend = 'claude', compact, messageList, onPermissionResolve, onFork, getSessionCtx, onSendText, onQueueChipClick, getQueueCaps }) {
    this._onSendText = onSendText || null; // in-chat action buttons send through the live input (null = view-only)
    this._onQueueChipClick = onQueueChipClick || null; // clicking a 'queued' chip steers that message (live windows only)
    this._getQueueCaps = getQueueCaps || null; // the VIEW's queue capability (harness row ∧ running wrapper); absent = view-only ⇒ inert chip
    this.ws = ws;
    this.sessionId = sessionId;
    this.app = app;
    this.backend = backend;
    this._compact = compact;
    this._messageList = messageList;
    this._onPermissionResolve = onPermissionResolve || (() => {});
    this._onFork = onFork || null;
    this._getSessionCtx = getSessionCtx || null;
    this.setupLinkHandler();
  }

  // Session identity (cwd + host) for link resolution. The live-list lookup
  // only matches LIVE webui sessions — a view-only window's sessionId is
  // `view-…` and a terminated window's webuiId is gone, so links there lost
  // their host/cwd and probed the LOCAL machine (audit 2.192.0). ChatView's
  // _getSessionIds already solves this (openSpec fallback) — prefer it.
  _sessionCtx() {
    try {
      const ids = this._getSessionCtx?.();
      if (ids && (ids.cwd || ids.host)) return { cwd: ids.cwd || '', host: ids.host || null };
    } catch {}
    const sess = (this.app?.sidebar?._allSessions || []).find(s => s.webuiId === this.sessionId);
    return { cwd: sess?.cwd || '', host: sess?.host || null };
  }

  // ── Message renderers ──

  /**
   * Localized display name for a tool-card header. Curated map for the
   * harness's built-in tools (user report: TaskCreate/TaskUpdate headers
   * read as unlocalized chrome); unknown/MCP tools fall back to the raw
   * name. Bash/Agent/Workflow stay as-is (proper-noun-like, with dedicated
   * surfaces). The raw name rides the card's title tooltip when it differs.
   */
  toolDisplayName(name) { return toolDisplayName(name); }


  /**
   * Shared compact/bubble wrapper for user, assistant, and tool messages.
   * role: 'user' | 'assistant' | 'tool'. Tool messages have no bubble in non-compact mode.
   */
  wrapMsg(el, role, label, html) {
    if (this._compact) {
      el.innerHTML = `<div class="chat-compact-msg"><span class="chat-role chat-role-${role}">${label}</span><div class="chat-compact-content">${html}</div></div>`;
    } else if (role === 'tool') {
      el.innerHTML = html;
    } else {
      el.innerHTML = `<div class="chat-bubble chat-bubble-${role}">${html}</div>`;
    }
  }

  renderUserMsg(msg) {
    const content = msg.content;
    if (!content?.length) return null;

    // CLI-injected page images (a Read on a PDF ships the extracted pages
    // into model context as image-only synthetic user records — the
    // normalizer coalesces the per-page burst into one flagged message).
    // One compact collapsible card; the pages render on expand.
    if (msg.imageAttachment) {
      const imgs = content.filter(b => b.type === 'image');
      const el = document.createElement('div');
      el.className = 'chat-msg chat-msg-system chat-system-notification chat-attach-pages';
      el._rawMsg = msg;
      const inner = imgs.map(b => `<img class="chat-img" src="data:${escHtml(b.mediaType || 'image/png')};base64,${escHtml(b.data)}" alt="page" loading="lazy">`).join('');
      el.innerHTML = `<details class="chat-hook-details"><summary class="chat-hook-summary">${UI_ICONS.memo} ${escHtml(t('Attached pages ({n})', { n: imgs.length }))}</summary><div class="chat-attach-pages-body">${inner}</div></details>`;
      return el;
    }

    // Detect system notifications: command tags, meta directives, reminders
    const rawText = content.map(b => b.text || '').join('');
    // Provenance beats text-shape: a HUMAN-submitted prompt (msg.typed, from
    // the CLI's promptSource marker) is never a notification even if the user
    // pasted hook text verbatim; a CLI-synthesized record (msg.synthetic)
    // always is. The text regexes remain the fallback for old records that
    // predate these flags.
    const isNotification = msg.originKind === 'task-notification' || (!msg.typed && (msg.synthetic
      || /^<(command-name|local-command|task-notification|system-reminder|vibespace-task-context|vibespace-reminder)/.test(rawText.trim())
      || /^A session-scoped Stop hook is now active/.test(rawText.trim())
      || /^Stop hook feedback:/.test(rawText.trim())));
    if (msg.originKind === 'auto-resume') {
      // VibeSpace's auto-resume continue prompt (server-sent after a usage-limit
      // wall): a user-role record the CLI needs, but the OWNER never typed it —
      // label it so the transcript does not read as "I said continue" (2.369.32)
      const el = document.createElement('div');
      el.className = 'chat-msg chat-msg-user chat-msg-auto-resume';
      el._rawMsg = msg;
      el.innerHTML = `<div class="chat-peer-head">${UI_ICONS.refresh || ''} ${escHtml(t('VibeSpace auto-resume — sent automatically after the usage limit cleared'))}</div><div class="chat-msg-content chat-peer-core">${escHtml(rawText)}</div>`;
      return el;
    }
    if (msg.originKind === 'peer-message') {
      // Cross-session peer message (2.349.0, owner report: an announce woke
      // the agent but the chat showed NOTHING — "都不知道agent到底收到了什么").
      // Distinct card: labeled, sender-attributed, core text prominent (the
      // harness wrapper line + trailing guidance paragraph are trimmed).
      return this._renderPeerMsg(msg, rawText);
    }
    if (isNotification) {
      return this._renderNotificationMsg(rawText);
    }

    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-user';
    el._rawMsg = msg;
    const parts = content.map(b => {
      if (b.type === 'text') return `<div class="chat-text">${this.renderMarkdown(b.text)}</div>`;
      // harness-supplied inline image (ACP/claude user attachment): same media
      // wrapper + zoom as the tool cards; the data: URL stays (small, no path on disk)
      if (b.type === 'image') return imageMediaHtml({ dataUrl: `data:${b.mediaType || 'image/png'};base64,${b.data}`, mediaType: b.mediaType || 'image/png', name: t('Image') });
      return '';
    }).join('');

    const textHtml = rawText.length > 500
      ? `<details class="chat-long-msg"><summary><span>${escHtml(rawText.substring(0, 120))}... ${t('({n} chars)', { n: rawText.length })}</span></summary>${parts}</details>`
      : parts;

    this.wrapMsg(el, 'user', t('You'), textHtml);
    ChatRenderers.applyQueueChip(el, msg, this._canSteerQueue() ? this._onQueueChipClick : null);
    return el;
  }

  /** Can THIS SESSION inject a queued message into the running turn? ONE
   *  definition, owned by the view (backend-caps `inputModes.steer` projected
   *  through META **and** the running wrapper's own queue advert) — a renderer
   *  built without it (view-only history) renders the chip inert, which is
   *  exactly right: a dead session steers nothing. */
  _canSteerQueue() { return !!this._getQueueCaps?.()?.steer; }

  /** THE QUEUE CHIP on a user bubble — 'queued' (waiting behind the running
   *  turn, clickable to steer where the harness allows it), 'steered' (injected
   *  into the running turn) or 'removed'. Idempotent: called on first render
   *  AND on the queueState edit op, so the chip never doubles.
   *  STATIC + injected click handler: the DOM-free render test drives it
   *  without a ChatRenderers instance, and the chip text is the ONE place the
   *  three states are worded. */
  static applyQueueChip(el, msg, onSteer) {
    if (!el) return null;
    const prev = el.querySelector(':scope > .chat-queue-chip');
    if (prev) prev.remove();
    const state = msg?.queueState;
    if (state !== 'queued' && state !== 'steered' && state !== 'removed') return null;
    const chip = document.createElement('button');
    chip.className = `chat-queue-chip chat-queue-chip-${state}`;
    chip.type = 'button';
    chip.dataset.queueState = state;
    const icon = state === 'queued' ? UI_ICONS.clock : state === 'steered' ? UI_ICONS.bolt : UI_ICONS.close;
    const label = state === 'queued' ? t('Queued') : state === 'steered' ? t('Steered') : t('Removed');
    chip.innerHTML = `${icon}<span>${escHtml(label)}</span>`;
    chip.title = state === 'queued'
      ? t('Waiting behind the running turn — steering it injects it now, at the agent’s next reply')
      : state === 'steered' ? t('Injected into the running turn')
        : t('Removed from the queue — it will not run');
    if (state === 'queued' && typeof onSteer === 'function') {
      chip.onclick = (e) => { e.stopPropagation(); onSteer(msg); };
    } else {
      chip.disabled = true;
    }
    el.appendChild(chip);
    return chip;
  }

  // Resolve a peer session NAME to the sidebar's live session record. Names
  // are mutable and non-unique — a miss is EXPECTED (renamed/killed sender);
  // log it and tell the user instead of failing silently (owner ask).
  _resolvePeerSession(name) {
    if (!name) return null;
    const all = this.app?.sidebar?._allSessions || [];
    const hits = all.filter((x) => (x.webuiName || x.name) === name || this.app?.sidebar?.getCustomName?.(x) === name);
    return hits.length === 1 ? hits[0] : (hits[0] || null);
  }
  _jumpToPeer(name) {
    // 'Background Work · <job>' senders are JOBS, not sessions (owner report:
    // the name rendered as a link but clicking failed the session lookup) —
    // open the Background Work panel instead of a doomed name resolution
    if (/^Background Work · /.test(String(name || ''))) { this.app.openJobs?.(); return; }
    const s = this._resolvePeerSession(name);
    if (!s) {
      track('peer-jump-unresolved', { name: String(name || '').slice(0, 40) });
      showToast(t('Session “{name}” not found — it may have been renamed or closed', { name }));
      return;
    }
    if (s.webuiId) this.app.attachSession(s.webuiId, s.webuiName || name, s.cwd, { mode: s.webuiMode, backend: s.backend || 'claude', backendSessionId: s.backendSessionId || s.sessionId });
    else showToast(t('Session “{name}” is not open right now', { name }));
  }
  _renderPeerMsg(msg, rawText) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-system chat-peer-message';
    el._rawMsg = msg;
    // core = message body without the harness's wrapper line and trailing
    // conduct paragraph (both are boilerplate around EVERY peer delivery)
    let core = String(rawText || '');
    core = core.replace(/^Another Claude session sent a message:\s*\n/, '');
    const cut = core.indexOf('\nThis came from another Claude session');
    if (cut > 0) core = core.slice(0, cut);
    // server-posted frames (vibespace-msg / Background Work) carry their own
    // boilerplate — the sender is already in the card head, the trailing
    // conduct sentence is agent-facing noise (2.363.0)
    core = core.replace(/^Message from session "[^"]+" \(via vibespace-msg[^)]*\):\s*\n?/, '');
    core = core.replace(/\s*This is a notification, not a user instruction[\s\S]*$/, '');
    const nameHtml = msg.peerFrom
      ? t('Message from “{name}”', { name: `<span class="chat-peer-name" role="link" tabindex="0">${escHtml(msg.peerFrom)}</span>` })
      : escHtml(t('Message from another session'));
    el.innerHTML = `<div class="chat-peer-head"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>${nameHtml}</div><div class="chat-text">${this.renderMarkdown(core.trim())}</div>`;
    if (msg.peerFrom) {
      const nameEl = el.querySelector('.chat-peer-name');
      if (nameEl) nameEl.onclick = (e) => { e.stopPropagation(); this._jumpToPeer(msg.peerFrom); };
      el.querySelector('.chat-peer-head').oncontextmenu = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (/^Background Work · /.test(String(msg.peerFrom || ''))) {
          showContextMenu(e, [
            { label: t('Open Background Work'), action: () => this.app.openJobs?.() },
            { label: t('Copy sender name'), action: () => copyText(msg.peerFrom) },
          ]);
          return;
        }
        const s = this._resolvePeerSession(msg.peerFrom);
        showContextMenu(e, [
          { label: t('Open session'), action: () => this._jumpToPeer(msg.peerFrom) },
          ...(s ? [{ label: t('Session properties'), action: () => this.app.openSessionProps(s.webuiId || s) }] : []),
          { label: t('Copy sender name'), action: () => copyText(msg.peerFrom) },
        ]);
        if (!s) track('peer-menu-unresolved', { name: String(msg.peerFrom || '').slice(0, 40) });
      };
    }
    return el;
  }

  _renderNotificationMsg(rawText) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-system chat-system-notification';
    el._rawMsg = { role: 'system' };

    // Extract readable label from tagged content
    let label = '', detail = '';
    const cmdMatch = rawText.match(/<command-name>\/?(\w+)<\/command-name>/);
    const argsMatch = rawText.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const stdoutMatch = rawText.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
    const hookMatch = rawText.match(/^A session-scoped Stop hook is now active with condition: "([\s\S]*?)"/);
    const hookFeedback = rawText.match(/^Stop hook feedback:\s*\[[\s\S]*?\]:\s*([\s\S]*)/);

    // Background-task wakeup (2.229.2): the harness re-invokes the agent with
    // a <task-notification> block when a background task/workflow completes —
    // previously invisible (see the normalizer's origin.kind note), now a
    // first-class dim card naming the task + status, full payload expandable.
    const taskNotif = rawText.match(/<task-notification>[\s\S]*?<\/task-notification>/);
    let labelIcon = ''; // SVG prefix rendered outside escHtml (label text is escaped)
    if (taskNotif) {
      const tag = (name) => { const m = rawText.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : ''; };
      const status = tag('status') || 'completed';
      const summary = tag('summary') || tag('task-id') || t('background task');
      label = t('Woken by background task ({status}): {summary}', { status, summary: summary.substring(0, 110) });
      detail = rawText.trim();
      const el2 = document.createElement('div');
      el2.className = 'chat-msg chat-msg-system chat-system-notification chat-task-wakeup';
      el2._rawMsg = { role: 'system' };
      el2.innerHTML = `<details><summary><span class="chat-system-text">${UI_ICONS.clock}${escHtml(label)}</span></summary><pre class="chat-pre">${escHtml(detail)}</pre></details>`;
      return el2;
    }
    if (cmdMatch) {
      label = `/${cmdMatch[1]}`;
      if (argsMatch) detail = argsMatch[1].trim();
    } else if (stdoutMatch) {
      // TUI echoes carry raw ANSI (e.g. "Set model to [1mopus[22m") — strip
      const so = stripAnsi(stdoutMatch[1]).trim();
      label = so.substring(0, 80);
      if (so.length > 80) { label += '…'; detail = so; }
    } else if (hookMatch) {
      labelIcon = UI_ICONS.goal;
      label = t('Goal: {text}', { text: `${hookMatch[1].substring(0, 60)}${hookMatch[1].length > 60 ? '...' : ''}` });
    } else if (hookFeedback) {
      labelIcon = UI_ICONS.goal;
      label = t('Goal check: not met');
      detail = hookFeedback[1].trim();
    } else if (/^Stop hook feedback:/.test(rawText.trim())) {
      // Generic (non-goal) Stop hook block reason — e.g. the VibeSpace
      // bookkeeping nudge. Full text behind the expander, never cut off.
      // It IS a hook card (the chat.showHookCards description promises
      // "stop reminders" are covered) — the class was missing, so the
      // toggle never hid it (real report). Goal-check cards stay visible
      // (goal progress is signal, not hook noise).
      el.classList.add('chat-msg-hook');
      label = t('Stop hook feedback');
      detail = rawText.trim().replace(/^Stop hook feedback:\s*/, '');
    } else {
      // Fallback for any tagged notification: a long payload must stay
      // reachable — 80-char label + the FULL text behind the expander
      // (this used to hard-truncate at 80 with no way to read the rest).
      const stripped = rawText.replace(/<[^>]+>/g, '').trim();
      label = stripped.substring(0, 80) || t('notification');
      if (stripped.length > 80) { label += '…'; detail = stripped; }
    }

    const labelHtml = (labelIcon ? labelIcon + ' ' : '') + escHtml(label);
    if (detail) {
      el.innerHTML = `<details class="chat-hook-details"><summary class="chat-hook-summary">${labelHtml}</summary><pre class="chat-hook-output">${escHtml(detail)}</pre></details>`;
    } else {
      el.innerHTML = `<span class="chat-system-text">${labelHtml}</span>`;
    }
    return el;
  }

  renderAssistantMsg(msg) {
    const block = msg.content?.[0];
    if (!block) return null;
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-assistant';
    el._rawMsg = msg;
    let html;
    if (block.type === 'thinking') {
      const thinkTxt = stripAnsi(block.text || '');
      // Empty thinking (redacted / zero-length — real transcripts carry
      // thousands) renders a useless "Thinking" stub. Tagged so
      // chat.hideEmptyThinking (default on) hides it via a body class, and so
      // _updateRuns treats it as transparent for run-collapse adjacency.
      if (!thinkTxt.trim()) el.classList.add('chat-empty-thinking');
      html = `<details class="chat-thinking"${msg.status === 'streaming' ? ' open' : ''}><summary>${t('Thinking')}</summary><pre>${escHtml(thinkTxt)}</pre></details>`;
    } else if (block.type === 'text') {
      html = `<div class="chat-text">${this.renderMarkdown(stripAnsi(block.text || ''))}</div>`;
    } else {
      return null;
    }
    this.wrapMsg(el, 'assistant', createBackendIconHtml(this.backend, {
      title: getBackendMeta(this.backend).label,
      className: 'chat-role-backend-icon',
    }), html);
    return el;
  }

  /**
   * Codex multi-agent chatter (B-7473, the owner's "根本没区分出这是subagent
   * 消息"): a sub-agent's PLAINTEXT report gets an attributed card (markdown
   * body, sanitized exactly like assistant text, tinted strip + "name ·
   * FINAL_ANSWER" header); everything else — encrypted inbound, outbound
   * messages, spawns, waits, lifecycle — is a compact one-line row. The agent
   * NAME is clickable (data-agent-path / data-thread-id → chat-view opens the
   * child's rollout read-only). Every model-controlled string goes through
   * escHtml inside collab-row.js.
   */
  _renderCollabMsg(msg) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-assistant chat-msg-tool-result chat-msg-collab';
    el._rawMsg = msg;
    if (msg.toolCallId) el.dataset.toolId = msg.toolCallId;
    const collab = msg.collab || {};
    if (collab.report) {
      el.classList.add('chat-agent-report');
      const body = msg.content?.[0]?.output || '';
      // head = "water_research · FINAL_ANSWER" (the ONE attribution string,
      // shared with the plain-text surfaces) + the envelope as the tooltip
      const head = collabReportHeadText(collab, t);
      const nameAttrs = `${collab.agentPath ? ` data-agent-path="${escHtml(collab.agentPath)}"` : ''}${collab.threadId ? ` data-thread-id="${escHtml(collab.threadId)}"` : ''}`;
      el.innerHTML = `<div class="chat-agent-report-head" title="${escHtml(`${head}\n${collabRowTitle(collab, t)}`)}">`
        + `${COLLAB_ICONS.in}<span class="chat-collab-name" role="link" tabindex="0"${nameAttrs}>${escHtml(collab.agentName || collab.agentPath || t('sub-agent'))}</span>`
        + `${collab.msgType ? `<span class="chat-collab-type">${escHtml(collab.msgType)}</span>` : ''}`
        + `<span class="chat-agent-report-tag">${escHtml(t('sub-agent report'))}</span></div>`
        + `<div class="chat-text chat-agent-report-body">${this.renderMarkdown(stripAnsi(body))}</div>`;
      return el;
    }
    el.innerHTML = `<div class="chat-collab-line">${collabRowsHtml(collab, { esc: escHtml, t, icons: COLLAB_ICONS })}</div>`;
    return el;
  }

  renderToolMsg(msg) {
    if (msg.collab) return this._renderCollabMsg(msg);
    const block = msg.content?.[0];
    if (!block) return null;
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-assistant chat-msg-tool-result';
    el._rawMsg = msg;
    if (msg.toolCallId) el.dataset.toolId = msg.toolCallId;
    let html;

    if (block.type === 'tool_call') {
      // Tool call — pending (spinner) or interrupted (error, no result ever came)
      const isAgent = block.toolName === 'Agent';
      const icon = toolCardIcon(block.toolName);
      const fp = block.input?.file_path || '';
      const isFileOp = ['Edit', 'Write', 'Read'].includes(block.toolName);
      const isPending = msg.status === 'pending';
      if (isPending && isFileOp) {
        // localized VERB, matching the completed cards (Edit completes as
        // t('Update'), Write as t('Write') — a raw English toolName next to
        // them read as unlocalized; real report)
        const mb = memoryBase(fp);
        const verb = mb
          ? (block.toolName === 'Read' ? t('Memory read') : t('Memory update'))
          : block.toolName === 'Edit' ? t('Update') : block.toolName === 'Write' ? t('Write') : t('Read');
        const label = `${UI_ICONS.hourglass} ${escHtml(verb)} ${this.clickablePath(fp, mb)}`;
        html = `<div class="chat-tool-pending"><span class="chat-tool-label">${label}</span><span class="chat-spinner"></span></div>`;
      } else {
        const desc = isAgent && block.input?.description ? `${icon} Agent: ${escHtml(block.input.description)}${agentModelChip(block.input?.model)}` : `${icon} ${toolHeaderHtml(block.toolName)}${searchQueryChipHtml(block, msg)}`;
        const inputStr = stripAnsi(typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2));
        const statusHtml = isPending
          ? `<div class="chat-tool-output-pending"><span class="chat-spinner"></span> ${t('running...')}</div>`
          : `<details class="chat-diff" open><summary class="chat-diff-summary chat-tool-error-label">\u2717 ${t('Interrupted')}</summary></details>`;
        html = `<div class="chat-tool-use"><span class="chat-tool-label">${desc}</span><details class="chat-diff"><summary class="chat-diff-summary">${t('Input')}</summary><pre>${this.linkifyText(inputStr)}</pre></details>${statusHtml}</div>`;
      }
    } else if (block.type === 'tool_result') {
      // Completed tool call — show full result
      html = this.renderToolResult(block, msg);
    } else {
      html = `<pre>${escHtml(JSON.stringify(block, null, 2))}</pre>`;
    }

    const toolLabel = msg.toolStatus === 'error' ? '\u2717' : msg.status === 'pending' ? UI_ICONS.hourglass : '\u2713';
    this.wrapMsg(el, 'tool', toolLabel, html);

    // Permission overlay — only for pending or denied (resolved+complete = no overlay needed)
    if (msg.permission && !(msg.permission.resolved === 'allowed' && msg.status === 'complete')) {
      this.renderPermissionOverlay(el, msg);
    }

    return el;
  }

  /**
   * Render a completed tool result (Edit diff, Write/Read code block, Agent, generic)
   */
  renderToolResult(block, msg) {
    const fp = block.input?.file_path || '';
    let resultText = stripAnsi(block.output || '');
    // image tool results (2.369.35): the normalizer keeps only {mediaType,
    // bytes} — the media card draws the FILE from disk (host-qualified for
    // remote sessions), never a base64 blob in the DOM; an image with no path
    // on disk (an MCP screenshot tool's inline result) stays a size chip
    const images = Array.isArray(block.images) ? block.images : [];
    const mediaHost = this._sessionCtx().host || null;
    const mediaHtml = images.length
      ? `<div class="chat-tool-images">${images.map((im) => imageMediaHtml({ path: isImagePath(fp) ? fp : '', host: mediaHost, mediaType: im.mediaType, bytes: im.bytes })).join('')}</div>`
      : '';
    // Parse JSON content arrays (e.g. Agent tool returns [{"type":"text","text":"..."}])
    if (resultText.startsWith('[{')) {
      try {
        const parsed = JSON.parse(resultText);
        if (Array.isArray(parsed)) resultText = parsed.map(b => b.text || '').filter(Boolean).join('\n');
      } catch {}
    }
    const inputStr = stripAnsi(typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2));

    if (block.status === 'error') {
      return `<div class="chat-tool-use"><span class="chat-tool-label" title="${escHtml(block.toolName)}">${toolCardIcon(block.toolName)} ${toolHeaderHtml(block.toolName)}${searchQueryChipHtml(block, msg)} ${this.clickablePath(fp)}</span><details class="chat-diff"><summary class="chat-diff-summary">${t('Input')}</summary><pre>${this.linkifyText(inputStr)}</pre></details><details class="chat-diff" open><summary class="chat-diff-summary chat-tool-error-label">\u2717 ${t('Error')}</summary><pre class="chat-tool-error-text">${this.linkifyText(resultText)}</pre></details></div>`;
    }
    if (block.toolName === 'Patch') {
      const patchHtml = this.renderPatchDiff(block);
      if (patchHtml) return patchHtml;
    }
    if (block.toolName === 'Edit' && block.input?.old_string != null) {
      return this.renderEditDiff({ input: block.input });
    }
    if (block.toolName === 'Write') {
      const content = block.input?.content || '';
      const lineCount = content.split('\n').length;
      const byteCount = new Blob([content]).size;
      const sizeStr = byteCount > 1024 ? (byteCount / 1024).toFixed(1) + ' KB' : byteCount + ' B';
      const codeBlock = this.renderCodeBlock(content, fp);
      const mbW = memoryBase(fp);
      return `<div class="chat-tool-use"><span class="chat-tool-label">${UI_ICONS.memo} ${mbW ? t('Memory update') : t('Write')} ${this.clickablePath(fp, mbW)}</span><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${t('{n} lines, {size}', { n: lineCount, size: sizeStr })}</summary>${codeBlock}</details></div>`;
    }
    // An image the agent LOOKED AT (claude Read of a png/jpg — the exact case
    // 2.369.35 lifted the bytes out of, whose card then showed only the
    // "[image …]" marker because this branch returned before the generic
    // thumbnail splice; codex view_image {path}) → the media card. For a Read
    // the LIFTED BLOCKS decide, never the extension: a .svg/.ico Read returns
    // numbered TEXT (a by-extension branch dropped that source silently).
    const viewsImage = block.toolName === 'Read' ? images.length > 0
      : String(block.toolName || '').toLowerCase() === 'view_image';
    if (viewsImage) {
      const imgPath = fp || block.input?.path || '';
      const im = images[0] || {};
      const verb = block.toolName === 'Read' ? t('Read') : t('View image');
      // a format the browser cannot decode (tiff/heic) gets the type/size chip,
      // never an <img> that can only break
      return `<div class="chat-tool-use"><span class="chat-tool-label">${UI_ICONS.image} ${escHtml(verb)} ${this.clickablePath(imgPath)}</span>${imageMediaHtml({ path: isImagePath(imgPath) ? imgPath : '', host: mediaHost, mediaType: im.mediaType || '', bytes: im.bytes || 0 })}</div>`;
    }
    if (block.toolName === 'Read') {
      const lineCount = resultText.split('\n').length;
      const codeBlock = this.renderCodeBlock(resultText, fp);
      const mbR = memoryBase(fp);
      // a TEXT result for a browser-drawable image type (svg/ico source) keeps
      // its code block and ALSO shows the rendered file below it
      const thumb = isImagePath(fp) ? imageMediaHtml({ path: fp, host: mediaHost }) : '';
      return `<div class="chat-tool-use"><span class="chat-tool-label">${UI_ICONS.book} ${mbR ? t('Memory read') : t('Read')} ${this.clickablePath(fp, mbR)}</span><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${t('{n} lines', { n: lineCount })}</summary>${codeBlock}</details>${thumb}</div>`;
    }
    if (block.toolName === 'Agent') {
      const desc = block.input?.description || '';
      // Background agents: the tool_result is only the launch ack — the real
      // outcome lives in taskInfo (synthesized from the ack + closed by the
      // <task-notification> wakeup, 2.368.30). Show the lifecycle honestly.
      const ti = msg?.taskInfo;
      const tiChip = ti?.status === 'running' ? ` <span class="chat-task-status-chip">⟳ ${t('running')}</span>`
        : (ti && ti.status && ti.status !== 'completed' ? ` <span class="chat-task-status-chip err">${escHtml(ti.status)}</span>` : '');
      const firstLine = (ti?.summary ? String(ti.summary).slice(0, 160) : '') || resultText.split('\n')[0].substring(0, 120) || t('(empty)');
      const reviewThreadId = msg?.taskInfo?.receiverThreadIds?.[0] || '';
      const agentId = msg?.taskInfo?.id || (resultText.match(/agentId:\s*([a-z0-9]+)/)?.[1]) || '';
      const dataAttrs = reviewThreadId
        ? ` data-thread-id="${escHtml(reviewThreadId)}"`
        : agentId
          ? ` data-agent-id="${escHtml(agentId)}"`
          : block.toolCallId
            ? ` data-parent-tool-id="${escHtml(block.toolCallId)}"`
            : '';
      const viewBtn = dataAttrs
        ? ` <button class="chat-agent-view-btn"${dataAttrs} data-desc="${escHtml(desc)}">${t('View Log')}</button>`
        : '';
      return `<div class="chat-tool-use"><span class="chat-tool-label">${UI_ICONS.robot} Agent: ${escHtml(desc)}${agentModelChip(block.input?.model)}${tiChip}${viewBtn}</span><details class="chat-diff"><summary class="chat-diff-summary">${t('Input')}</summary><pre>${this.linkifyText(inputStr)}</pre></details><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${escHtml(firstLine)}</summary><pre>${this.linkifyText(resultText)}</pre></details></div>`;
    }
    if (block.toolName === 'Workflow') {
      // Dynamic workflow (ultracode). The tool_result is the launch ack, which
      // carries the run id ("Run ID: wf_..."); resume passes it as input.
      const runId = (block.input && block.input.resumeFromRunId)
        || (resultText.match(/Run ID:\s*(wf_[\w-]+)/)?.[1])
        || (resultText.match(/"runId":\s*"(wf_[\w-]+)"/)?.[1]) || '';
      const wfName = resultText.match(/Summary:\s*(.+)/)?.[1]?.trim().substring(0, 120) || '';
      const tiW = msg?.taskInfo;
      const wfChipHtml = tiW?.status === 'running' ? ` <span class="chat-task-status-chip">⟳ ${t('running')}</span>`
        : (tiW && tiW.status && tiW.status !== 'completed' ? ` <span class="chat-task-status-chip err">${escHtml(tiW.status)}</span>` : '');
      const viewBtn = runId
        ? ` <button class="chat-workflow-view-btn" data-wf-run="${escHtml(runId)}" data-wf-name="${escHtml(wfName)}">${t('View Workflow')}</button>`
        : '';
      const firstLineW = (tiW?.summary ? String(tiW.summary).slice(0, 160) : '') || resultText.split('\n')[0].substring(0, 120) || t('(empty)');
      return `<div class="chat-tool-use"><span class="chat-tool-label">${UI_ICONS.workflow || UI_ICONS.robot} Workflow${wfName ? ': ' + escHtml(wfName) : ''}${wfChipHtml}${viewBtn}</span><details class="chat-diff"><summary class="chat-diff-summary">${t('Script')}</summary><pre>${this.linkifyText(inputStr)}</pre></details><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${escHtml(firstLineW)}</summary><pre>${this.linkifyText(resultText)}</pre></details></div>`;
    }
    // Generic tool
    const firstLine = resultText.split('\n')[0].substring(0, 120) || t('(empty)');
    return `<div class="chat-tool-use"><span class="chat-tool-label" title="${escHtml(block.toolName)}">${toolCardIcon(block.toolName)} ${toolHeaderHtml(block.toolName)}${searchQueryChipHtml(block, msg)}</span>${mediaHtml}<details class="chat-diff"><summary class="chat-diff-summary">${t('Input')}</summary><pre>${this.linkifyText(inputStr)}</pre></details><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${escHtml(firstLine)}</summary><pre>${this.linkifyText(resultText)}</pre></details></div>`;
  }

  /**
   * Render a system message. Returns { el, sideEffect } where sideEffect contains
   * metadata extracted from system.init messages, so ChatView can apply them.
   * Returns null if the message should not be rendered (e.g. system.init).
   */
  renderSystemMsg(msg) {
    const text = msg.content?.[0]?.text || '';
    // Model auto-fallback notice: the server bakes an English sentence (it
    // can't know the per-device language), so localize it here from the
    // structured from/to that ride the block.
    // Safety-classifier fallback (2.227.4) — distinct from the capacity/
    // overload fallback below: the model's own safeguards flagged the message
    // and the harness RETRIED it elsewhere. Shows the CLI's own explanation
    // behind an expander so the badge change is never unexplained again.
    if (msg.noticeKind === 'model-refusal-fallback' && msg.content?.[0]?.fallbackTo) {
      const b = msg.content[0];
      const el = document.createElement('div');
      el.className = 'chat-msg chat-msg-system chat-system-notification';
      const head = t('⚠ Safety-classifier fallback: {from} → {to} — this message tripped {from}\'s safeguards, so it was retried on {to}. Your model setting is unchanged; later messages go back to {from}.', { from: b.fallbackFrom || '?', to: b.fallbackTo || '?' });
      const cat = b.refusalCategory ? ` (${b.refusalCategory})` : '';
      el.innerHTML = `<span class="chat-system-text">${escHtml(head + cat)}</span>`;
      if (b.cliText) {
        const det = document.createElement('details');
        det.innerHTML = `<summary>${escHtml(t('Details from the CLI'))}</summary><pre class="chat-pre">${escHtml(b.cliText)}</pre>`;
        el.appendChild(det);
      }
      return { el, sideEffect: null };
    }
    if (msg.noticeKind === 'model-refusal-no-fallback' && msg.content?.[0]) {
      const b = msg.content[0];
      const el = document.createElement('div');
      el.className = 'chat-msg chat-msg-system chat-system-notification';
      const head = t('⚠ Safeguards stopped this turn: {model} flagged the message and model fallback is disabled, so it was NOT retried on another model. Rephrase and resend to continue on {model}.', { model: b.fallbackFrom || '?' });
      const cat = b.refusalCategory ? ` (${b.refusalCategory})` : '';
      el.innerHTML = `<span class="chat-system-text">${escHtml(head + cat)}</span>`;
      if (b.cliText) {
        const det = document.createElement('details');
        det.innerHTML = `<summary>${escHtml(t('Details from the CLI'))}</summary><pre class="chat-pre">${escHtml(b.cliText)}</pre>`;
        el.appendChild(det);
      }
      return { el, sideEffect: null };
    }
    if (msg.noticeKind === 'model-fallback' && msg.content?.[0]?.fallbackTo) {
      const b = msg.content[0];
      const el = document.createElement('div');
      el.className = 'chat-msg chat-msg-system chat-system-notification';
      el.innerHTML = `<span class="chat-system-text">${escHtml(t('⚠ Model auto-fallback: {from} → {to} (the harness switched models, e.g. capacity/overload; /model or the badge menu sets it back)', { from: b.fallbackFrom || '?', to: b.fallbackTo || '?' }))}</span>`;
      return { el, sideEffect: null };
    }
    // system.init — extract metadata, don't render
    if (msg.content?.[0]?.initData) {
      const d = msg.content[0].initData;
      const sideEffect = {};
      if (d.model) sideEffect.model = d.model.replace(/\[.*$/, '');
      if (d.permissionMode) sideEffect.permMode = d.permissionMode;
      if (d.slashCommands) sideEffect.slashCommands = d.slashCommands.map(c => c.startsWith('/') ? c : '/' + c);
      return { el: null, sideEffect };
    }
    // Hook events — compact collapsible
    if (msg.content?.[0]?.hookData) {
      const h = msg.content[0].hookData;
      const el = document.createElement('div');
      el.className = 'chat-msg chat-msg-system chat-system-notification chat-msg-hook';
      // Full hook output, NEVER truncated — collapsed <details> + the CSS
      // scroll cap handle size. The <pre> starts pre-wrapped (hook payloads
      // are prose-ish) and the STANDARD addWrapToggles toolbar (Wrap/Copy)
      // picks it up like any other pre; an editor button opens the full text.
      const output = h.output ? escHtml(h.output) : '';
      el.innerHTML = `<details class="chat-hook-details"><summary class="chat-hook-summary">${escHtml(text)}${h.output ? `<button class="chat-wrap-toggle chat-hook-edit" title="${t('Open in editor')}">${t('Editor')}</button>` : ''}</summary>${output ? `<pre class="chat-hook-output chat-pre-wrapped">${output}</pre>` : ''}</details>`;
      const editBtn = el.querySelector('.chat-hook-edit');
      if (editBtn) editBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.openInTempEditor(h.output); };
      return { el, sideEffect: null };
    }
    // Error / interrupted
    if (msg.status === 'error' || msg.status === 'interrupted') {
      if (msg.errorKind === 'prompt-too-long') return { el: this.appendContextFullCard(text), sideEffect: null };
      return { el: this.appendSystem(text), sideEffect: null };
    }
    // Other system messages (hook summary, etc.)
    if (text) {
      const el = document.createElement('div');
      el.className = 'chat-msg chat-msg-system chat-system-notification' + (/^([✓✗] Hook:|\d+ hooks ran)/.test(text) ? ' chat-msg-hook' : '');
      el.innerHTML = `<span class="chat-system-text">${escHtml(text)}</span>`;
      return { el, sideEffect: null };
    }
    return null;
  }

  renderPermissionOverlay(el, msg) {
    if (!msg.permission) return;
    // Remove existing permission overlay
    const existing = el.querySelector('.chat-permission-inline');
    if (existing) existing.remove();

    const section = document.createElement('div');
    section.className = 'chat-permission-inline';
    section.dataset.requestId = msg.permission.requestId;

    if (msg.permission.kind === 'user_input' && !msg.permission.resolved) {
      const questions = msg.permission.questions || [];
      section.innerHTML = '';
      const prompt = document.createElement('div');
      prompt.className = 'chat-permission-prompt chat-ask-form';

      const selections = new Map();
      const origInput = msg.permission.input || {};
      let currentPage = 0;

      // Build pages \u2014 one per question
      const pages = [];
      for (const q of questions) {
        const page = document.createElement('div');
        page.className = 'chat-ask-page';
        const qHeader = document.createElement('div');
        qHeader.className = 'chat-ask-header';
        if (q.header) { const chip = document.createElement('span'); chip.className = 'chat-ask-chip'; chip.textContent = q.header; qHeader.appendChild(chip); }
        const qTextEl = document.createElement('span'); qTextEl.textContent = q.question; qHeader.appendChild(qTextEl);
        page.appendChild(qHeader);

        const optionsWrap = document.createElement('div');
        optionsWrap.className = 'chat-ask-options';
        if (Array.isArray(q.options) && q.options.length) {
          for (const option of q.options) {
            const btn = document.createElement('button');
            btn.className = 'chat-ask-option';
            btn.innerHTML = `<strong>${escHtml(option.label)}</strong>${option.description ? `<span class="chat-ask-desc">${escHtml(option.description)}</span>` : ''}`;
            btn.onclick = () => {
              if (q.multiSelect) {
                btn.classList.toggle('selected');
                const selected = [...optionsWrap.querySelectorAll('.chat-ask-option.selected')].map(b => b.querySelector('strong').textContent);
                // Deselecting everything = unanswered — an empty-string entry
                // kept Submit enabled and sent "" as the answer
                if (selected.length) selections.set(q.question, selected.join(', '));
                else selections.delete(q.question);
                page._customInput.value = '';
              } else {
                optionsWrap.querySelectorAll('.chat-ask-option').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                selections.set(q.question, option.label);
                page._customInput.value = '';
              }
              updateSubmitState();
            };
            optionsWrap.appendChild(btn);
          }
        }
        page.appendChild(optionsWrap);

        const customInput = document.createElement('input');
        customInput.className = 'filter-input chat-ask-custom';
        customInput.placeholder = t('Or type a custom answer...');
        customInput.oninput = () => {
          const val = customInput.value.trim();
          if (val) {
            selections.set(q.question, val);
            optionsWrap.querySelectorAll('.chat-ask-option').forEach(b => b.classList.remove('selected'));
          } else {
            selections.delete(q.question);
          }
          updateSubmitState();
        };
        page._customInput = customInput;
        page.appendChild(customInput);
        pages.push(page);
      }

      // Container for pages (only show one at a time)
      const pageContainer = document.createElement('div');
      pageContainer.className = 'chat-ask-page-container';
      pages.forEach(p => pageContainer.appendChild(p));
      prompt.appendChild(pageContainer);

      // Navigation + progress
      const nav = document.createElement('div');
      nav.className = 'chat-ask-nav';
      const prevBtn = document.createElement('button');
      prevBtn.className = 'chat-perm-btn chat-ask-nav-btn';
      prevBtn.textContent = '\u2190';
      prevBtn.onclick = () => { if (currentPage > 0) { currentPage--; showPage(); } };
      const nextBtn = document.createElement('button');
      nextBtn.className = 'chat-perm-btn chat-ask-nav-btn';
      nextBtn.textContent = '\u2192';
      nextBtn.onclick = () => { if (currentPage < pages.length - 1) { currentPage++; showPage(); } };
      const pageIndicator = document.createElement('span');
      pageIndicator.className = 'chat-ask-page-indicator';

      const submitBtn = document.createElement('button');
      submitBtn.className = 'chat-perm-btn chat-perm-allow chat-ask-submit';
      submitBtn.textContent = t('Submit');
      submitBtn.disabled = true;
      submitBtn.onclick = () => {
        const answers = {};
        for (const [qText, val] of selections) answers[qText] = val;
        this.ws.send({
          type: 'permission-response', sessionId: this.sessionId,
          requestId: msg.permission.requestId, approved: true,
          toolInput: { ...origInput, answers },
        });
        msg.permission.resolved = 'allowed';
        msg.permission.selectedAnswers = answers;
        this.renderPermissionOverlay(el, msg);
        this._onPermissionResolve('allowed');
      };
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'chat-perm-btn chat-perm-deny';
      cancelBtn.textContent = t('Cancel');
      cancelBtn.onclick = () => {
        this.ws.send({
          type: 'permission-response', sessionId: this.sessionId,
          requestId: msg.permission.requestId, approved: false,
        });
        msg.permission.resolved = 'denied';
        this.renderPermissionOverlay(el, msg);
      };

      if (questions.length > 1) nav.append(prevBtn, pageIndicator, nextBtn);
      nav.append(submitBtn, cancelBtn);
      prompt.appendChild(nav);

      const showPage = () => {
        pages.forEach((p, i) => p.style.display = i === currentPage ? '' : 'none');
        pageIndicator.textContent = `${currentPage + 1} / ${pages.length}`;
        prevBtn.disabled = currentPage === 0;
        nextBtn.disabled = currentPage === pages.length - 1;
        // Mark answered pages in indicator
        const dots = questions.map((q, i) => selections.has(q.question) ? '\u25cf' : (i === currentPage ? '\u25cb' : '\u25cb'));
        pageIndicator.title = dots.join(' ');
      };
      const updateSubmitState = () => {
        submitBtn.disabled = selections.size < questions.length;
        showPage();
      };
      showPage();
      section.appendChild(prompt);
    } else if (msg.permission.kind === 'user_input' && msg.permission.resolved) {
      section.innerHTML = '';
      const prompt = document.createElement('div');
      prompt.className = 'chat-permission-prompt';
      const resolved = document.createElement('div');
      resolved.className = `chat-permission-resolved ${msg.permission.resolved === 'denied' ? 'chat-permission-denied' : 'chat-permission-allowed'}`;
      resolved.textContent = msg.permission.resolved === 'denied' ? '\u2717 ' + t('Cancelled') : '\u2713 ' + t('Answered');
      prompt.appendChild(resolved);

      if (msg.permission.resolved !== 'denied' && msg.permission.selectedAnswers) {
        for (const [qText, answer] of Object.entries(msg.permission.selectedAnswers)) {
          const row = document.createElement('div');
          row.className = 'chat-permission-question';
          row.innerHTML = `<span class="chat-status-dim">${escHtml(qText)}</span> → <strong>${escHtml(answer)}</strong>`;
          prompt.appendChild(row);
        }
      }

      section.appendChild(prompt);
    } else if (msg.permission.resolved) {
      const icon = msg.permission.resolved === 'denied' ? '\u2717' : '\u2713';
      const label = msg.permission.resolved === 'denied' ? t('Denied') : t('Allowed');
      const cls = msg.permission.resolved === 'denied' ? 'chat-permission-denied' : 'chat-permission-allowed';
      section.innerHTML = `<details class="chat-diff"><summary class="chat-diff-summary"><span class="chat-permission-resolved ${cls}">${icon} ${label}</span></summary></details>`;
    } else if (Array.isArray(msg.permission.options) && msg.permission.options.length) {
      // Harness-neutral ORDERED options (ACP request_permission: the agent
      // names them; kinds allow_once/allow_always/reject_once/reject_always
      // pick the button style). The reply carries the chosen optionId.
      const cls = (k) => /^allow_always/.test(k || '') ? 'chat-perm-always' : /^allow/.test(k || '') ? 'chat-perm-allow' : 'chat-perm-deny';
      section.innerHTML = `<div class="chat-permission-prompt"><span class="chat-permission-label">${UI_ICONS.lock} ${t('Permission: {tool}', { tool: escHtml(msg.permission.toolName) })}</span><div class="chat-permission-actions">${msg.permission.options.map((o) => `<button class="chat-perm-btn ${cls(o.kind)}" data-option-id="${escHtml(String(o.optionId))}">${escHtml(o.name || String(o.optionId))}</button>`).join('')}</div></div>`;
      for (const btn of section.querySelectorAll('.chat-perm-btn')) btn.addEventListener('click', () => {
        const o = msg.permission.options.find((x) => String(x.optionId) === btn.dataset.optionId) || null;
        const approved = !!o && /^allow/.test(o.kind || '');
        this.ws.send({ type: 'permission-response', sessionId: this.sessionId, requestId: msg.permission.requestId, approved, optionId: o?.optionId || null, toolInput: msg.permission.input, permissionUpdates: approved && /always/.test(o.kind || '') ? [{ kind: o.kind }] : undefined });
        msg.permission.resolved = approved ? 'allowed' : 'denied';
        msg.permission.selectedOptionId = o?.optionId || null;
        this.renderPermissionOverlay(el, msg);
        if (approved) this._onPermissionResolve('allowed');
      });
    } else {
      section.innerHTML = `<div class="chat-permission-prompt"><span class="chat-permission-label">${UI_ICONS.lock} ${t('Permission: {tool}', { tool: escHtml(msg.permission.toolName) })}</span><div class="chat-permission-actions"><button class="chat-perm-btn chat-perm-allow">${t('Allow')}</button>${msg.permission.suggestions?.length ? `<button class="chat-perm-btn chat-perm-always">${t('Always Allow')}</button>` : ''}<button class="chat-perm-btn chat-perm-deny">${t('Deny')}</button></div></div>`;
      section.querySelector('.chat-perm-allow')?.addEventListener('click', () => {
        this.ws.send({ type: 'permission-response', sessionId: this.sessionId, requestId: msg.permission.requestId, approved: true, toolInput: msg.permission.input });
        msg.permission.resolved = 'allowed';
        this.renderPermissionOverlay(el, msg);
        this._onPermissionResolve('allowed');
      });
      section.querySelector('.chat-perm-always')?.addEventListener('click', () => {
        this.ws.send({ type: 'permission-response', sessionId: this.sessionId, requestId: msg.permission.requestId, approved: true, toolInput: msg.permission.input, permissionUpdates: msg.permission.suggestions });
        msg.permission.resolved = 'allowed';
        this.renderPermissionOverlay(el, msg);
        this._onPermissionResolve('allowed');
      });
      section.querySelector('.chat-perm-deny')?.addEventListener('click', () => {
        this.ws.send({ type: 'permission-response', sessionId: this.sessionId, requestId: msg.permission.requestId, approved: false });
        msg.permission.resolved = 'denied';
        this.renderPermissionOverlay(el, msg);
      });
    }

    const toolUse = el.querySelector('.chat-tool-use') || el.querySelector('.chat-tool-pending');
    if (toolUse) {
      const outputPending = toolUse.querySelector('.chat-tool-output-pending');
      if (outputPending) outputPending.before(section);
      else toolUse.appendChild(section);
    }
  }

  renderEditDiff(block) {
    const filePath = block.input.file_path || '';
    const oldStr = block.input.old_string || '';
    const newStr = block.input.new_string || '';
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');

    // Simple line-by-line diff with prefix and suffix context matching
    const diffLines = [];
    let oi = 0, ni = 0;
    // Match prefix context
    while (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      diffLines.push({ type: 'ctx', text: oldLines[oi], ol: oi + 1, nl: ni + 1 }); oi++; ni++;
    }
    // Match suffix context from the end
    let suffixCtx = [];
    let oe = oldLines.length - 1, ne = newLines.length - 1;
    while (oe >= oi && ne >= ni && oldLines[oe] === newLines[ne]) {
      suffixCtx.unshift({ type: 'ctx', text: oldLines[oe] }); oe--; ne--;
    }
    // Remaining old = del, remaining new = add
    while (oi <= oe) { diffLines.push({ type: 'del', text: oldLines[oi], ol: oi + 1 }); oi++; }
    while (ni <= ne) { diffLines.push({ type: 'add', text: newLines[ni], nl: ni + 1 }); ni++; }
    // Append suffix context with correct line numbers
    for (const s of suffixCtx) { s.ol = oi + 1; s.nl = ni + 1; diffLines.push(s); oi++; ni++; }

    const addCount = diffLines.filter(l => l.type === 'add').length;
    const delCount = diffLines.filter(l => l.type === 'del').length;
    const summary = `\u2713 ${t('Added {a} lines, removed {d} lines', { a: addCount, d: delCount })}`;

    let body = '';
    for (const line of diffLines) {
      const cls = line.type === 'add' ? 'chat-diff-add' : line.type === 'del' ? 'chat-diff-del' : 'chat-diff-ctx';
      const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      body += `<div class="${cls}"><span class="chat-diff-prefix">${prefix}</span><span class="chat-diff-text">${escHtml(line.text)}</span></div>`;
    }

    const mbE = memoryBase(filePath);
    return `<div class="chat-tool-use"><span class="chat-tool-label">${UI_ICONS.memo} ${mbE ? t('Memory update') : t('Update')} ${this.clickablePath(filePath, mbE)}</span><details class="chat-diff"><summary class="chat-diff-summary">${summary}</summary><div class="chat-diff-body">${body}</div></details></div>`;
  }

  renderPatchDiff(block) {
    const changes = normalizePatchChanges(block.input?.changes);
    if (!changes.length) return '';

    return changes.map((change) => {
      const fromPath = change.filePath || '';
      const filePath = fromPath || change.movePath || '';
      const rawDiff = change.unifiedDiff || change.diff || '';
      const hasUnifiedMarkers = rawDiff.includes('@@') || rawDiff.startsWith('---') || rawDiff.startsWith('+++');
      const diffLines = hasUnifiedMarkers
        ? parseUnifiedDiffLines(rawDiff)
        : (rawDiff || change.content)
          ? String(rawDiff || change.content)
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map((line) => ({
              type: change.changeType === 'delete' ? 'del' : 'add',
              prefix: change.changeType === 'delete' ? '-' : '+',
              text: line,
            }))
          : [];
      const addCount = diffLines.filter((line) => line.type === 'add').length;
      const delCount = diffLines.filter((line) => line.type === 'del').length;
      const mbP = memoryBase(filePath);
      const action = (mbP && (change.changeType === 'add' || change.changeType === 'update'))
        ? t('Memory update')
        : change.changeType === 'add'
          ? t('Write')
          : change.changeType === 'delete'
            ? t('Delete')
            : change.changeType === 'move'
              ? t('Move')
              : t('Update');
      const pathLabel = change.movePath && fromPath
        ? `${this.clickablePath(fromPath)} \u2192 ${this.clickablePath(change.movePath)}`
        : this.clickablePath(filePath, mbP);
      const summary = change.changeType === 'move' && !addCount && !delCount
        ? `\u2713 ${t('Moved to {path}', { path: escHtml(change.movePath || filePath) })}`
        : change.changeType === 'delete' && !addCount && !delCount
          ? `\u2713 ${t('Removed file')}`
          : `\u2713 ${t('Added {a} lines, removed {d} lines', { a: addCount, d: delCount })}`;
      const body = diffLines.map((line) => {
        const cls = line.type === 'add' ? 'chat-diff-add' : line.type === 'del' ? 'chat-diff-del' : 'chat-diff-ctx';
        return `<div class="${cls}"><span class="chat-diff-prefix">${escHtml(line.prefix)}</span><span class="chat-diff-text">${escHtml(line.text)}</span></div>`;
      }).join('');
      return `<div class="chat-tool-use"><span class="chat-tool-label">${UI_ICONS.memo} ${action} ${pathLabel}</span><details class="chat-diff"><summary class="chat-diff-summary">${summary}</summary><div class="chat-diff-body">${body}</div></details></div>`;
    }).join('');
  }

  renderMarkdown(text) {
    try {
      // marked passes raw HTML through — sanitize before injecting into the
      // DOM (message content is model/tool-controlled and may echo hostile
      // markup from files or web pages). Sanitize BEFORE linkify so our own
      // chat-link spans aren't subject to filtering.
      let html = DOMPurify.sanitize(marked.parse(text || ''));
      html = this._wrapTables(html);
      return this.linkify(html);
    } catch {
      return escHtml(text || '');
    }
  }

  /** Wrap each <table> in a horizontally-scrollable container so wide tables
   *  scroll instead of overflowing (critical on mobile — no scroll otherwise). */
  _wrapTables(html) {
    if (html.indexOf('<table') === -1) return html;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    for (const table of tpl.content.querySelectorAll('table')) {
      if (table.parentElement?.classList.contains('chat-table-wrap')) continue;
      const wrap = document.createElement('div');
      wrap.className = 'chat-table-wrap';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    }
    return tpl.innerHTML;
  }

  appendSystem(text) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-system';
    el.innerHTML = `<div class="chat-system">${escHtml(text)}</div>`;
    this._messageList.appendChild(el); this.addWrapToggles(el); this.addOpenInEditorBtn(el);
    return el;
  }

  /** "Prompt is too long" guidance card (2.365.0): the context window is full
   *  and EVERY later send fails the same way until the conversation is
   *  compacted — say so and offer the action. View-only windows (no live
   *  input) get the explanation without the button. */
  appendContextFullCard(text) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-system';
    el.innerHTML = `<div class="chat-system chat-ctx-full">`
      + `<div class="chat-ctx-full-title">${escHtml(text)}</div>`
      + `<div class="chat-ctx-full-help">${escHtml(t('The conversation no longer fits the model’s context window — every new message will fail the same way until it is compacted.'))}</div>`
      + `<div class="chat-ctx-full-actions"><button class="chat-ctx-compact-btn">${escHtml(t('Compact now'))}</button>`
      + `<span class="chat-ctx-full-hint">${escHtml(t('Compacting a large conversation takes 1–2 minutes — do not press Stop. If it answers “Conversation too long”, rewind a few messages in terminal mode (Esc Esc) and compact again.'))}</span></div>`
      + `</div>`;
    const btn = el.querySelector('.chat-ctx-compact-btn');
    if (this._onSendText) btn.onclick = () => { btn.disabled = true; this._onSendText('/compact'); };
    else btn.remove();
    this._messageList.appendChild(el);
    return el;
  }

  // ── Code block helpers (delegated to highlight.js) ──

  renderCodeBlock(code, filePath) { return renderCodeBlock(code, filePath); }
  rehighlightCodeBlock(blockEl, langId) { rehighlightCodeBlock(blockEl, langId); }

  // ── Linkification helpers ──

  /** Make a file path clickable (click=copy, ctrl+click=open) */
  clickablePath(fp, label = null) {
    return `<span class="chat-link chat-link-path" data-path="${escHtml(fp)}" title="${t('Click to copy, Ctrl+Click to open')}">${escHtml(label || fp)}</span>`;
  }

  /** Strip trailing punctuation from matched paths/URLs */
  cleanPath(p) { return p.replace(/[`'".,;:!?)}\]]+$/, ''); }

  /**
   * Linkify URLs in a text segment. Input is ALWAYS already HTML-escaped in both
   * call paths (marked output for markdown; escHtml'd plain text for linkifyText),
   * so `&` appears as `&amp;`. We match `&amp;` as part of the URL and never
   * re-escape: the old esc=true branch re-ran escHtml on the matched URL and
   * produced `&amp;amp;`, corrupting copied multi-param URLs (e.g. OAuth links —
   * every `&` came back as `&amp;`). (issue #16)
   */
  linkifyUrls(text) {
    const re = /(https?:\/\/(?:[^\s<>"')\]&]|&amp;)+)/g;
    return text.replace(re, (raw) => {
      const url = this.cleanPath(raw);
      const after = raw.slice(url.length);
      return `<span class="chat-link" data-href="${url}" title="${t('Click to copy, Ctrl+Click to open')}">${url}</span>${after}`;
    });
  }

  /**
   * Linkify file paths in HTML that may contain tags (from prior URL linkification).
   * Splits by tags to avoid matching inside <span> attributes. esc controls escHtml on output.
   */
  linkifyPathsTagSafe(html, esc) {
    const e = esc ? escHtml : s => s;
    const pathRe = /(?<![="'\w/])((?:~|\.\.?)?\/[^\0<>?\s!`&*()'":;\\][^\0<>?\s!`&*()'"\\:;]*(?:\/[^\0<>?\s!`&*()'"\\:;]+)+(?::\d+(?::\d+)?)?)/g;
    return html.replace(/(<[^>]*>)|([^<]+)/g, (m, tag, txt) => {
      if (tag || !txt) return m;
      return txt.replace(pathRe, (raw) => {
        const fp = this.cleanPath(raw);
        const after = raw.slice(fp.length);
        if (fp.length < 4) return raw;
        return `<span class="chat-link chat-link-path" data-path="${e(fp)}" title="${t('Click to copy, Ctrl+Click to open')}">${e(fp)}</span>${e(after)}`;
      });
    });
  }

  /**
   * `/p/<id>` — a page published on THIS instance — becomes a real link
   * against the origin the viewer is actually using (2.366.1). The server
   * cannot know that address (reverse proxy, tunnel, a different hostname),
   * so agents are told to write the PATH and the browser resolves it; a
   * server-side guess produced a link that only resolved on the server
   * itself (owner: "你怎么知道我用啥地址能访问你？"). Runs BEFORE the file-path
   * linkifier, which would otherwise claim it as a filesystem path.
   */
  linkifyPagePaths(text) {
    return text.replace(/(?<![="'\w/])(\/p\/pg[a-z0-9]{10})(\/raw)?\b/g, (m, p) =>
      `<span class="chat-link" data-href="${absUrl(p)}" title="${t('Click to copy, Ctrl+Click to open')}">${p}</span>`);
  }

  /** Combined URL + path linkification on a text segment. */
  linkifySegment(text, esc) {
    return this.linkifyPathsTagSafe(this.linkifyPagePaths(this.linkifyUrls(text)), esc);
  }

  /**
   * Auto-detect URLs and file paths in rendered HTML, make them interactive.
   * Click = copy, Ctrl+Click = open.
   */
  linkify(html) {
    return html.replace(/(<a[\s>][\s\S]*?<\/a>)|(<code[\s>][\s\S]*?<\/code>)|(<[^>]*>)|([^<]+)/gi, (match, anchor, code, tag, text) => {
      if (anchor) return match; // preserve <a>...</a> untouched
      if (code) {
        // Linkify paths/URLs inside <code> blocks while preserving the <code> wrapper
        return code.replace(/^(<code[^>]*>)([\s\S]*?)(<\/code>)$/i, (_, open, inner, close) => {
          const linked = this.linkifySegment(inner, true);
          if (linked === inner) {
            // No absolute match — but a code span that IS a relative path or
            // bare filename (`B2BTasks/x/final/`, `SCRIPTS.md`, `generate.py`)
            // is how agents actually reference files (real transcripts, where
            // none of it linkified). Make it clickable and resolve against the
            // session cwd at CLICK time (existence-probed, no render-time IO).
            const txt = inner.trim().replace(/&amp;/g, '&');
            const looksRel = /^[\w@%+=.\-][^\s<>"'`|]*$/.test(txt) && txt.length >= 3 && txt.length <= 200
              && (txt.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(txt))
              // digits/dots/slashes only = versions, IPs, CIDR ranges (10.0.0.0/8);
              // digit-dot stem = IP-ish tokens like 192.0.2.10 — never file refs
              && !/^[\d./]+$/.test(txt) && !/^[\d.]+$/.test(txt.replace(/\.[A-Za-z0-9]+$/, ''))
              && !txt.endsWith('.') && !txt.includes('//');
            if (looksRel) {
              return open + `<span class="chat-link chat-link-path chat-link-rel" data-rel="${escHtml(txt)}" title="${t('Click to copy, Ctrl+Click to locate & open')}">${inner}</span>` + close;
            }
          }
          return open + linked + close;
        });
      }
      if (tag) return tag;
      if (!text) return match;
      return this.linkifySegment(text, true);
    });
  }

  /** Linkify plain text (for tool output, user messages that don't go through markdown) */
  linkifyText(text) {
    return this.linkifySegment(escHtml(text), false);
  }

  // Resolve a clicked link into {url, fp, rel}. A local filesystem path — our
  // data-path OR a markdown `<a href="/home/…">` — is classified as fp so it
  // opens in the file viewer and never window.open()s (which would resolve it
  // to http://<host>/home/…). Shared by the click + contextmenu handlers.
  _linkTargets(link) {
    const rel = link.dataset.rel;
    let fp = link.dataset.path;
    let url = link.dataset.href || link.getAttribute('href');
    if (!fp && !rel && url && /^(\/[^/]|~\/)/.test(url) && !/^(https?|ftp|blob|data|about|mailto):/i.test(url)) {
      fp = url; url = null;
    }
    return { url, fp, rel };
  }

  /** Set up delegated click handler on message list for links/paths */
  setupLinkHandler() {
    const isTouch = this.app?.isTouch || this.app?.isMobile;
    this._messageList.addEventListener('click', (e) => {
      // Handle both our .chat-link spans and markdown-generated <a> tags
      const link = e.target.closest('.chat-link') || e.target.closest('a[href]');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      const { url, fp, rel } = this._linkTargets(link);
      const open = () => rel ? this._openRelTarget(link, rel) : this._openLinkTarget(link, url, fp);
      const copy = () => copyText(fp || rel || url).then(() => this.flashLink(link, t('Copied!')));
      if (isTouch) {
        // No Ctrl/hover on touch — tap shows both actions (copy used to be impossible)
        showContextMenu(e.clientX, e.clientY, [
          { label: (fp || rel) ? t('Open') : t('Open link'), action: open },
          { label: (fp || rel) ? t('Copy path') : t('Copy URL'), action: copy },
        ]);
      } else if (e.ctrlKey || e.metaKey) {
        open();
      } else {
        copy();
      }
    });
    // Right-click / long-press on a link: same Open/Copy menu (desktop native
    // menu has no useful actions for .chat-link spans)
    this._messageList.addEventListener('contextmenu', (e) => {
      const link = e.target.closest('.chat-link') || e.target.closest('a[href]');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      const { url, fp, rel } = this._linkTargets(link);
      showContextMenu(e.clientX, e.clientY, [
        { label: (fp || rel) ? t('Open') : t('Open link'), action: () => rel ? this._openRelTarget(link, rel) : this._openLinkTarget(link, url, fp) },
        { label: (fp || rel) ? t('Copy path') : t('Copy URL'), action: () => copyText(fp || rel || url).then(() => this.flashLink(link, t('Copied!'))) },
      ]);
    });
  }

  /** Resolve a RELATIVE path / bare filename against the session cwd and open
   * it. Agents reference files relative to ambiguous roots (real case: cwd
   * .../B2BTasks with the reply saying `B2BTasks/x/final/`), so we probe, in
   * order: cwd/rel → overlap-merge (rel's first segment matches a trailing cwd
   * segment) → cwd-parent/rel; first existing wins. Host-aware for remote
   * sessions. Probing happens only on an explicit open click. */
  async _openRelTarget(link, rel) {
    const { cwd, host } = this._sessionCtx();
    const norm = rel.replace(/\/+$/, '');
    const cands = [];
    if (rel.startsWith('~/')) cands.push(rel);
    else if (cwd) {
      cands.push(cwd + '/' + norm);
      const cwdSegs = cwd.split('/'), relSegs = norm.split('/');
      const at = cwdSegs.lastIndexOf(relSegs[0]);
      if (at >= 0) cands.push([...cwdSegs.slice(0, at), ...relSegs].join('/'));
      cands.push(cwdSegs.slice(0, -1).join('/') + '/' + norm);
    }
    const seen = new Set();
    for (const c of cands) {
      if (!c || seen.has(c)) continue;
      seen.add(c);
      try {
        const r = await fetch(`/api/file/info?path=${encodeURIComponent(c)}${host ? '&host=' + encodeURIComponent(host) : ''}`);
        const info = await r.json();
        if (info && !info.error) {
          // open on the SESSION's host — a remote session's files live on the
          // remote machine; opening the bare path opened a nonexistent LOCAL
          // path (real report: remote-chat file links did nothing)
          if (info.isDirectory) this.app.openFileExplorer(c, { host });
          else this.app.openFile(c, c.split('/').pop(), { host });
          return;
        }
      } catch {}
    }
    // Last resort: bounded server-side search under the cwd — the reply may
    // reference a file that lives deeper (real case: `SCRIPTS.md` actually at
    // cwd/default_voice_examples/SCRIPTS.md). One hit opens; several offer a
    // picker; prefer hits whose tail matches the full relative reference.
    if (cwd && !host) {
      try {
        const base = norm.split('/').pop();
        const type = rel.endsWith('/') ? 'd' : 'f';
        const r = await fetch(`/api/file/locate?name=${encodeURIComponent(base)}&root=${encodeURIComponent(cwd)}&type=${type}`);
        const { hits = [] } = await r.json();
        const exact = hits.filter(h => h.endsWith('/' + norm));
        const use = exact.length ? exact : hits;
        const openHit = (h) => type === 'd' ? this.app.openFileExplorer(h, { host }) : this.app.openFile(h, h.split('/').pop(), { host });
        if (use.length === 1) { openHit(use[0]); return; }
        if (use.length > 1) {
          const rect = link.getBoundingClientRect();
          showContextMenu(rect.left, rect.bottom + 4, use.map(h => ({ label: h, action: () => openHit(h) })));
          return;
        }
      } catch {}
    }
    this.flashLink(link, t('Not found near the session folder'));
  }

  /** Open a chat link target: file path (with optional :line suffix) in viewer/explorer, URL in new tab */
  _openLinkTarget(link, url, fp) {
    // A local filesystem path is NEVER an http target. Markdown links to local
    // files — `[doc](/home/x/y.md)` → `<a href="/home/x/y.md">` — arrive here as
    // `url` (from href), and window.open('/home/…') makes the browser resolve it
    // to http://<host>/home/… (real report: a path opened as an http url).
    // Reclassify absolute/home paths as fp so they open in the file viewer.
    if (!fp && url && /^(\/[^/]|~\/)/.test(url) && !/^(https?|ftp|blob|data|about|mailto):/i.test(url)) {
      fp = url; url = null;
    }
    if (fp) {
      // Parse optional :line, :line:col, or :line-line suffix
      const lineMatch = fp.match(/^(.+?):(\d+)(?:[:\-]\d+)?$/);
      const cleanPath = lineMatch ? lineMatch[1] : fp;
      const lineNum = lineMatch ? parseInt(lineMatch[2], 10) : undefined;
      // Host-aware: a remote session's absolute-path links (and markdown links
      // to local files) must resolve + open on the SESSION's host, not this
      // instance (real report: right-click → Open did nothing in remote chats).
      const { host } = this._sessionCtx();
      fetch(`/api/file/info?path=${encodeURIComponent(cleanPath)}${host ? '&host=' + encodeURIComponent(host) : ''}`)
        .then(r => r.json())
        .then(info => {
          if (info.error) {
            this.flashLink(link, t('Not found'));
          } else if (info.isDirectory) {
            this.app.openFileExplorer(cleanPath, { host });
          } else {
            this.app.openFile(cleanPath, cleanPath.split('/').pop(), { line: lineNum, host });
          }
        })
        .catch(() => this.flashLink(link, t('Error')));
    } else if (url) {
      window.open(url, '_blank');
    }
  }

  flashLink(link, msg) {
    // Show tooltip near the link instead of replacing text
    const tip = document.createElement('span');
    tip.className = 'chat-link-tooltip';
    tip.textContent = msg;
    link.style.position = 'relative';
    link.appendChild(tip);
    setTimeout(() => tip.remove(), 1200);
  }

  // ── Wrap toggles and open-in-editor ──

  openInTempEditor(text) {
    const tmpName = `chat-block-${Date.now()}.txt`;
    const tmpPath = `/tmp/claude-webui/${tmpName}`;
    fetch('/api/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/tmp/claude-webui' }) }).catch(() => {});
    fetch('/api/file/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: tmpPath, content: text }) })
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(() => {
        this.app.openEditor(tmpPath, tmpName, {
          _tempFile: true,
          _onCloseDelete: () => fetch(`/api/file?path=${encodeURIComponent(tmpPath)}`, { method: 'DELETE' }).catch(() => {}),
        });
      })
      .catch(() => {});
  }

  addOpenInEditorBtn(el) {
    if (!el._rawMsg) return;
    const msg = el._rawMsg;
    // Skip tool messages (they have their own open-in-editor buttons)
    if (msg.role === 'tool') return;
    // Skip assistant messages with no text content
    if (msg.role === 'assistant' && !msg.content?.some(b => b.type === 'text' && b.text?.trim())) return;
    const btn = document.createElement('button');
    btn.className = 'chat-open-editor-btn';
    btn.innerHTML = UI_ICONS.clipboard;
    btn.title = t('Open in editor');
    btn.onclick = (e) => {
      e.stopPropagation();
      const text = this.extractMsgText(msg);
      if (!text.trim()) return;
      this.openInTempEditor(text);
    };
    el.style.position = 'relative';
    el.appendChild(btn);
    this.addForkBtn(el, msg);
  }

  // "Fork from here" — branches a NEW session containing the conversation up to
  // and including this assistant message (claude --resume-session-at <uuid>
  // --fork-session). Claude-only (the flag is claude-specific), assistant
  // messages only (that's the truncation boundary the CLI accepts), and never
  // in subagent viewers. Sits next to the open-in-editor button.
  addForkBtn(el, msg) {
    if (!this._onFork) return;
    if (this.backend !== 'claude') return;
    if (msg.role !== 'assistant' || !msg.uuid) return;
    if (typeof this.sessionId === 'string' && this.sessionId.startsWith('sub-')) return;
    const btn = document.createElement('button');
    btn.className = 'chat-open-editor-btn chat-fork-btn';
    btn.innerHTML = UI_ICONS.forkBranch;
    btn.title = t('Fork from here — branch a new session up to this message');
    btn.onclick = (e) => { e.stopPropagation(); this._onFork(msg.uuid, msg); };
    el.appendChild(btn);
  }

  extractMsgText(msg) {
    const c = msg.content;
    if (!Array.isArray(c)) return JSON.stringify(msg, null, 2);
    return c.map(b => {
      if (b.type === 'text' || b.type === 'thinking' || b.type === 'system_info') return b.text || '';
      if (b.type === 'tool_call') return `[Tool: ${b.toolName}]\n${JSON.stringify(b.input, null, 2)}`;
      if (b.type === 'tool_result') return `[${b.toolName}] ${b.status}\n${b.output || ''}`;
      return '';
    }).filter(Boolean).join('\n\n');
  }

  /** Add wrap toggle button to all <pre> blocks inside an element */
  addWrapToggles(el) {
    // Memoized — this ran (registry + sort) for every message create/edit
    if (!ChatRenderers._LANGS) ChatRenderers._LANGS = ['plain', ...getHljsLanguages().sort()];
    const LANGS = ChatRenderers._LANGS;

    for (const block of el.querySelectorAll('pre, .chat-diff-body, .chat-code-block')) {
      if (block.parentNode?.classList?.contains('chat-pre-wrap')) continue;
      const wrapper = document.createElement('div');
      wrapper.className = 'chat-pre-wrap';
      block.parentNode.insertBefore(wrapper, block);
      wrapper.appendChild(block);

      const toolbar = document.createElement('div');
      toolbar.className = 'chat-code-toolbar';

      // Deferred highlight: large code blocks skip hljs on render, highlight on first expand
      if (block.classList.contains('chat-code-block') && block.dataset.highlightDeferred) {
        const details = block.closest('details');
        if (details) {
          const highlightOnce = () => {
            if (!block.dataset.highlightDeferred) return;
            delete block.dataset.highlightDeferred;
            this.rehighlightCodeBlock(block, block.dataset.lang);
            details.removeEventListener('toggle', highlightOnce);
          };
          details.addEventListener('toggle', highlightOnce);
        }
      }

      // Language picker for code blocks — searchable dropdown
      if (block.classList.contains('chat-code-block')) {
        const langPicker = document.createElement('div');
        langPicker.className = 'chat-lang-picker';
        const langBtn = document.createElement('button');
        langBtn.className = 'chat-lang-btn';
        langBtn.textContent = block.dataset.lang || 'plain';
        langBtn.title = t('Change syntax highlighting');
        langBtn.onclick = (e) => {
          e.stopPropagation();
          if (langPicker.querySelector('.chat-lang-dropdown')) { langPicker.querySelector('.chat-lang-dropdown').remove(); return; }
          const dd = document.createElement('div');
          dd.className = 'chat-lang-dropdown';
          dd.dataset.popover = '1'; // app-wide Escape-dismiss protocol (app.js removes [data-popover])
          const input = document.createElement('input');
          input.className = 'chat-lang-search';
          input.placeholder = t('Filter...');
          dd.appendChild(input);
          const list = document.createElement('div');
          list.className = 'chat-lang-list';
          dd.appendChild(list);
          const render = (filter) => {
            list.innerHTML = '';
            const f = (filter || '').toLowerCase();
            for (const l of LANGS) {
              if (f && !l.includes(f)) continue;
              const item = document.createElement('div');
              item.className = 'chat-lang-item' + (l === (block.dataset.lang || 'plain') ? ' active' : '');
              item.textContent = l;
              item.onclick = (ev) => {
                ev.stopPropagation();
                this.rehighlightCodeBlock(block, l);
                langBtn.textContent = l;
                dd.remove();
                closeFn();
              };
              list.appendChild(item);
            }
          };
          render('');
          input.oninput = () => render(input.value);
          input.onkeydown = (ev) => { if (ev.key === 'Escape') { dd.remove(); closeFn(); } };
          langPicker.appendChild(dd);
          setTimeout(() => input.focus(), 0);
          const closeFn = () => document.removeEventListener('mousedown', closeHandler);
          const closeHandler = (ev) => { if (!dd.contains(ev.target) && ev.target !== langBtn) { dd.remove(); closeFn(); } };
          setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);
        };
        langPicker.appendChild(langBtn);
        toolbar.appendChild(langPicker);
      }

      // Copy button — extracts code text without line-number gutters / diff
      // prefixes. Especially valuable on touch devices where text selection
      // inside scrollable code blocks is impractical.
      // Agent replied with an ```html block → one-click render in the embedded
      // browser (blob URL, sandboxed by the iframe; transient — not persisted).
      if (block.classList.contains('chat-code-block') && (block.dataset.lang === 'html' || block.dataset.lang === 'xml')) {
        const prevBtn = document.createElement('button');
        prevBtn.className = 'chat-wrap-toggle';
        prevBtn.textContent = t('Preview');
        prevBtn.title = t('Render this HTML in the embedded browser');
        prevBtn.onclick = (e) => {
          e.stopPropagation();
          const code = [...block.querySelectorAll('.chat-code-text')].map(x => x.textContent).join('\n');
          this.app?.openBrowser?.(URL.createObjectURL(new Blob([code], { type: 'text/html' })));
        };
        toolbar.appendChild(prevBtn);
      }
      const copyBtn = document.createElement('button');
      copyBtn.className = 'chat-wrap-toggle';
      copyBtn.textContent = t('Copy');
      copyBtn.title = t('Copy to clipboard');
      copyBtn.onclick = (e) => {
        e.stopPropagation();
        let text;
        if (block.classList.contains('chat-diff-body')) {
          // Keep +/- prefixes — without them added/removed lines are indistinguishable
          text = Array.from(block.children).map(row =>
            (row.querySelector('.chat-diff-prefix')?.textContent || '') +
            (row.querySelector('.chat-diff-text')?.textContent || '')
          ).join('\n');
        } else {
          const lineEls = block.querySelectorAll('.chat-code-text');
          text = lineEls.length
            ? Array.from(lineEls).map(s => s.textContent).join('\n')
            : block.textContent.replace(/\n$/, '');
        }
        copyText(text).then(() => {
          copyBtn.textContent = t('Copied');
          setTimeout(() => { copyBtn.textContent = t('Copy'); }, 1200);
        });
      };
      toolbar.appendChild(copyBtn);

      const btn = document.createElement('button');
      btn.className = 'chat-wrap-toggle';
      btn.textContent = t('Wrap');
      btn.title = t('Toggle word wrap');
      btn.onclick = (e) => {
        e.stopPropagation();
        const on = block.classList.toggle('chat-pre-wrapped');
        btn.textContent = on ? t('No Wrap') : t('Wrap');
      };
      toolbar.appendChild(btn);
      wrapper.appendChild(toolbar);
    }
  }

}

export { ChatRenderers };
