/**
 * Collab rows — the PURE label/HTML builder for codex multi-agent chatter
 * (B-7473, the owner's "根本没区分出这是subagent消息").
 *
 * Deliberately dependency-free (no DOM, no requires — PURE tier, CJS pulled
 * into the bundle like src/ssh-key-format.js): the escaper, the translator and
 * the icon set are INJECTED, so the whole surface is unit-testable in node AND
 * the XSS rule is *verifiable* — a test passes a marker escaper and proves
 * every model-controlled string (agent path, nickname, message type, target,
 * detail) leaves through it.
 *
 * A ROW describes ONE inter-agent event as the normalizer saw it:
 *   { dir: 'in' | 'out' | 'spawn' | 'wait' | 'activity',
 *     agentPath, agentName, nickname?, msgType?, encrypted?, target?,
 *     cellId?, threadId?, kind?, detail? }
 * A message carries `collab = { …rows[0], rows: [row, …] }`; consecutive
 * one-line rows COALESCE into one message (see CodexMessageManager).
 * An inbound PLAINTEXT payload is a REPORT instead (collab.report = true): it
 * renders as an attributed markdown card, never a one-liner.
 *
 * NEVER put an `encrypted_content` blob into a row: the payload upstream
 * withheld is not ours to show, and a 3KB base64 string in a one-line row is
 * exactly how the "no encrypted blob in any rendered string" invariant fails.
 */

// Default translator: the ENGLISH key with {param} substitution — the server
// side (normalizer text that lands in tool_result output, search previews,
// fold summaries) has no per-device language, the client passes the real t().
const T = (s, params) => (params ? String(s).replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? params[k] : m)) : s);

/** Last path segment of an agent path ('/root/water_research' → 'water_research'). */
function agentName(agentPath) {
  const s = String(agentPath || '').trim();
  if (!s) return '';
  const parts = s.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/**
 * A row's label split around the clickable NAME: { pre, name, post }.
 * ONE source for the plain-text label and the HTML row, so the text a search
 * hit shows and the text on screen can never drift apart.
 */
function collabRowParts(row, t = T) {
  const r = row || {};
  const name = r.agentName || agentName(r.agentPath || r.target) || '';
  if (r.dir === 'spawn') return { pre: `${t('spawn')} `, name: name || t('agent'), post: '' };
  // owner (2026-09-06, "这个等待是在等待啥?"): the bare 'wait' row read as a
  // mystery — say WHAT is awaited (the root blocks for its sub-agents' replies)
  // and for how long (yield_time_ms from the call's own arguments)
  if (r.dir === 'wait') {
    const secs = r.yieldMs > 0 ? ` · ≤${Math.max(1, Math.round(r.yieldMs / 1000))}s` : '';
    return { pre: t('waiting for sub-agent replies'), name: '', post: (r.cellId ? ` · ${t('cell')} ${r.cellId}` : '') + secs };
  }
  if (r.dir === 'activity') return { pre: '', name: name || t('agent'), post: r.kind ? ` ${r.kind}` : '' };
  const type = r.msgType || (r.dir === 'out' ? 'message' : 'MESSAGE');
  return { pre: '', name: name || t('agent'), post: ` · ${type}` };
}

/** Row → plain-text label (no glyphs, no HTML). */
function collabRowLabel(row, t = T) {
  const p = collabRowParts(row, t);
  return `${p.pre}${p.name}${p.post}`;
}

/** Coalesced summary text: "3 messages · water_research (FINAL_ANSWER), …". */
function collabSummaryText(collab, t = T) {
  const rows = rowsOf(collab);
  if (!rows.length) return '';
  if (rows.length === 1) return collabRowLabel(rows[0], t);
  const named = [];
  for (const r of rows) {
    const name = r.agentName || agentName(r.agentPath || r.target);
    if (!name) continue;
    const type = r.dir === 'activity' ? r.kind : r.msgType;
    const label = type ? `${name} (${type})` : name;
    if (!named.includes(label)) named.push(label);
  }
  const shown = named.slice(0, 3).join(', ') + (named.length > 3 ? '…' : '');
  const allSameDir = rows.every((r) => r.dir === rows[0].dir);
  const head = (allSameDir && (rows[0].dir === 'in' || rows[0].dir === 'out'))
    ? t('{n} messages', { n: rows.length })
    : t('{n} sub-agent events', { n: rows.length });
  return shown ? `${head} · ${shown}` : head;
}

// A message's rows. An EXPLICIT `rows` array is authoritative (empty = render
// nothing); a bare row object without one is treated as a single row.
function rowsOf(collab) {
  if (!collab) return [];
  return Array.isArray(collab.rows) ? collab.rows : [collab];
}

/**
 * Attribution header for an inbound PLAINTEXT report ("usecases_v4 ·
 * FINAL_ANSWER") — the whole point of B-7473: a sub-agent's report must never
 * read as the root agent's own reply.
 */
function collabReportHeadText(collab, t = T) {
  const r = rowsOf(collab)[0] || {};
  const name = r.agentName || agentName(r.agentPath) || t('sub-agent');
  return r.msgType ? `${name} · ${r.msgType}` : name;
}

/** Hover title: the envelope as codex wrote it + the honest encryption note. */
function collabRowTitle(row, t = T) {
  const r = row || {};
  const bits = [];
  if (r.agentPath) bits.push(`${t('Sender')}: ${r.agentPath}`);
  if (r.target && r.target !== r.agentPath) bits.push(`${t('Target')}: ${r.target}`);
  if (r.msgType) bits.push(`${t('Message type')}: ${r.msgType}`);
  if (r.nickname) bits.push(`${t('Nickname')}: ${r.nickname}`);
  if (r.kind) bits.push(`${t('Activity')}: ${r.kind}`);
  if (r.threadId) bits.push(`${t('Thread')}: ${r.threadId}`);
  if (r.detail) bits.push(String(r.detail).slice(0, 300));
  if (r.encrypted) bits.push(t('payload encrypted upstream'));
  return bits.join('\n');
}

/**
 * Clickable agent NAME: data-agent-path + data-thread-id. In 0.153.4 the child
 * thread id is known directly from SubAgentActivity.agent_thread_id, so the
 * click-through needs NO server lookup there; without it the client falls back
 * to GET /api/subagents.
 */
function collabNameHtml(row, { esc, cls = 'chat-collab-name', name = null } = {}) {
  const r = row || {};
  const label = name != null ? name : (r.agentName || agentName(r.agentPath || r.target));
  if (!label) return '';
  const attrs = `${r.agentPath ? ` data-agent-path="${esc(r.agentPath)}"` : ''}${r.threadId ? ` data-thread-id="${esc(r.threadId)}"` : ''}`;
  return `<span class="${cls}" role="link" tabindex="0"${attrs}>${esc(label)}</span>`;
}

/**
 * One compact row: SVG direction icon + clickable name + the rest of the
 * label. §17: the direction is an ICON, never an emoji/glyph.
 */
function collabRowHtml(row, { esc, t = T, icons = {} } = {}) {
  const r = row || {};
  const p = collabRowParts(r, t);
  const icon = icons[r.dir] || icons.activity || '';
  const nameHtml = p.name ? collabNameHtml(r, { esc, name: p.name }) : '';
  const lock = r.encrypted ? `<span class="chat-collab-enc" title="${esc(t('payload encrypted upstream'))}">${icons.lock || ''}</span>` : '';
  return `<span class="chat-collab-row" title="${esc(collabRowTitle(r, t))}"><span class="chat-collab-icon" aria-hidden="true">${icon}</span>${esc(p.pre)}${nameHtml}${esc(p.post)}${lock}</span>`;
}

/** The whole one-line message: a single row, or the coalesced summary + names. */
function collabRowsHtml(collab, { esc, t = T, icons = {} } = {}) {
  const rows = rowsOf(collab);
  if (!rows.length) return '';
  if (rows.length === 1) return collabRowHtml(rows[0], { esc, t, icons });
  const head = collabSummaryText({ rows }, t);
  const icon = icons[rows[0].dir] || icons.activity || '';
  const names = [];
  const seen = new Set();
  for (const r of rows) {
    const key = `${r.agentPath || r.target || ''}|${r.threadId || ''}`;
    if (key === '|' || seen.has(key)) continue;
    seen.add(key);
    const h = collabNameHtml(r, { esc });
    if (h) names.push(h);
  }
  const titles = rows.map((r) => collabRowTitle(r, t)).filter(Boolean).join('\n──\n');
  return `<span class="chat-collab-row chat-collab-multi" title="${esc(titles)}"><span class="chat-collab-icon" aria-hidden="true">${icon}</span>${esc(head)}${names.length ? ` <span class="chat-collab-names">${names.join(', ')}</span>` : ''}</span>`;
}

module.exports = {
  agentName,
  rowsOf,
  collabRowParts,
  collabRowLabel,
  collabSummaryText,
  collabReportHeadText,
  collabRowTitle,
  collabNameHtml,
  collabRowHtml,
  collabRowsHtml,
};
