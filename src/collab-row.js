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
 *
 * LIVE PROGRESS READOUT (2026-09-07, the owner's "这种互聊如果连续发生是不是应该
 * 界面里展示下连续数量, 这样我好知道对话没卡住"): dozens of encrypted one-line
 * rows over minutes, with no assistant text between them, are indistinguishable
 * from a wedged turn. Every number the UI shows is DERIVED from the rows the
 * normalizer already stamped — `collabTrafficStats` counts, `collabHeadText`
 * composes, `collabRunPart` is the run-summary segment and
 * `subAgentStreamLabel` the spinner line. Nothing here keeps state, nothing
 * here is stored server-side, and the only difference between the LIVE and the
 * FROZEN form is the last segment: a ticking relative age while the turn runs,
 * the absolute span of the traffic once it stops.
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

// ── LIVE PROGRESS (2026-09-07) ────────────────────────────────────────────
// All of it derived from the rows; none of it stored.

/**
 * Traffic facts of a coalesced card / a run's rows: how many events, how many
 * distinct agents, and the first/last RECORD timestamps (`row.ts`, stamped by
 * the normalizer from the rollout/app-server record when it has one).
 * Rows without a usable ts simply do not contribute to the span — a missing
 * clock must never invent one.
 */
function collabTrafficStats(collab) {
  const rows = rowsOf(collab);
  let firstTs = null, lastTs = null;
  const agents = new Set();
  let allSameDir = rows.length > 0;
  for (const r of rows) {
    const p = r.agentPath || r.target || '';
    if (p) agents.add(p);
    const ts = Number(r.ts);
    if (Number.isFinite(ts) && ts > 0) {
      if (firstTs == null || ts < firstTs) firstTs = ts;
      if (lastTs == null || ts > lastTs) lastTs = ts;
    }
    if (r.dir !== rows[0].dir) allSameDir = false;
  }
  return {
    count: rows.length,
    agents: agents.size,
    firstTs,
    lastTs,
    // "messages" only when every row really is mail; a mixed set (spawn, wait,
    // lifecycle) says "sub-agent events" — the 2.369.x honesty rule
    messagesOnly: allSameDir && (rows[0]?.dir === 'in' || rows[0]?.dir === 'out'),
  };
}

/**
 * Relative age of the last event: 1s granularity under a minute, then whole
 * minutes. The owner's question is "is it still moving", not "how many
 * milliseconds" — a seconds counter that ticks is the whole signal.
 */
function collabAgeText(ms, t = T) {
  const secs = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (secs < 60) return t('{n}s', { n: secs });
  return t('{n}m', { n: Math.floor(secs / 60) });
}

/** Absolute span of a finished burst: "4 min 12 s" (or "12 s" under a minute). */
function collabSpanText(ms, t = T) {
  const secs = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(secs / 60), s = secs % 60;
  return m ? t('{m} min {s} s', { m, s }) : t('{s} s', { s });
}

/** ["47 messages", "3 agents"] — singular forms are real keys, not "1 messages". */
function collabCountParts(stats, t = T) {
  const parts = [];
  const n = stats?.count || 0;
  if (stats?.messagesOnly) parts.push(n === 1 ? t('{n} message', { n }) : t('{n} messages', { n }));
  else parts.push(t('{n} sub-agent events', { n }));
  const a = stats?.agents || 0;
  if (a) parts.push(a === 1 ? t('{n} agent', { n: a }) : t('{n} agents', { n: a }));
  return parts;
}

/**
 * The card's head line.
 *   live   → "Sub-agent traffic · 47 messages · 3 agents · last 4s ago"
 *   frozen → "Sub-agent traffic · 47 messages · 3 agents · over 4 min 12 s"
 * The frozen span needs two DIFFERENT timestamps (one event has no span), and
 * the live age needs a last timestamp — either absent, the segment is dropped
 * rather than faked.
 */
function collabHeadText(stats, { now = Date.now(), live = false, t = T } = {}) {
  const parts = [t('Sub-agent traffic'), ...collabCountParts(stats, t)];
  if (live) {
    if (stats?.lastTs) parts.push(t('last {age} ago', { age: collabAgeText(now - stats.lastTs, t) }));
  } else if (stats?.firstTs != null && stats?.lastTs != null && stats.lastTs > stats.firstTs) {
    parts.push(t('over {span}', { span: collabSpanText(stats.lastTs - stats.firstTs, t) }));
  }
  return parts.join(' · ');
}

/**
 * The run-summary segment ("3 sub-agents · 47 messages" + the live age), placed
 * in the label by the ONE composer in chat-run-summary.js so the floating run
 * bar and the run footer read exactly what the header reads.
 */
function collabRunPart(stats, { now = Date.now(), live = false, t = T } = {}) {
  if (!stats || !stats.count) return '';
  const parts = [];
  const a = stats.agents || 0;
  if (a) parts.push(a === 1 ? t('{n} sub-agent', { n: a }) : t('{n} sub-agents', { n: a }));
  parts.push(...collabCountParts(stats, t).slice(0, 1));
  if (live && stats.lastTs) parts.push(t('last {age} ago', { age: collabAgeText(now - stats.lastTs, t) }));
  return parts.join(' · ');
}

/**
 * The streaming status line while the newest typed record is collab traffic:
 * "Sub-agents working — 47 messages, last 4s ago". It says the turn is ALIVE,
 * which the generic "thinking…" cannot.
 */
function subAgentStreamLabel(stats, { now = Date.now(), t = T } = {}) {
  const msgs = collabCountParts(stats, t)[0];
  if (!stats?.lastTs) return t('Sub-agents working — {msgs}', { msgs });
  return t('Sub-agents working — {msgs}, last {age} ago', { msgs, age: collabAgeText(now - stats.lastTs, t) });
}

/** The distinct "name (TYPE)" labels of a coalesced card, in row order. */
function collabNamedLabels(rows) {
  const named = [];
  for (const r of rows) {
    const name = r.agentName || agentName(r.agentPath || r.target);
    if (!name) continue;
    const type = r.dir === 'activity' ? r.kind : r.msgType;
    const label = type ? `${name} (${type})` : name;
    if (!named.includes(label)) named.push(label);
  }
  return named;
}

/**
 * Coalesced summary text — the PLAIN-TEXT twin of what the card renders
 * (it lands in the message's tool_result output, so search previews, fold
 * summaries and the minimap read the same words as the screen). Always the
 * FROZEN form: a stored string cannot tick, and the only live-only segment is
 * the relative age.
 */
function collabSummaryText(collab, t = T) {
  const rows = rowsOf(collab);
  if (!rows.length) return '';
  if (rows.length === 1) return collabRowLabel(rows[0], t);
  const named = collabNamedLabels(rows);
  const shown = named.slice(0, 3).join(', ') + (named.length > 3 ? '…' : '');
  const head = collabHeadText(collabTrafficStats({ rows }), { live: false, t });
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

/**
 * Hover title: the envelope as codex wrote it + the honest encryption note +
 * WHEN, and where the clock came from. `tsKind 'record'` = the rollout /
 * app-server record carried its own timestamp; anything else = the moment
 * VibeSpace saw the line. Saying which is the point: a burst replayed from a
 * rebuild would otherwise look like it happened just now.
 */
function collabRowTitle(row, t = T) {
  const r = row || {};
  const bits = [];
  if (Number(r.ts) > 0) {
    let clock = '';
    try { clock = new Date(Number(r.ts)).toLocaleTimeString(); } catch { clock = String(r.ts); }
    bits.push(`${t('Time')}: ${clock} (${r.tsKind === 'record' ? t('record timestamp') : t('arrival time')})`);
  }
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

/**
 * The whole one-line message: a single row, or the coalesced HEAD + names.
 *
 * The head text lives in its OWN `.chat-collab-head` element so the view's one
 * ticker can rewrite it (relative age) without re-rendering the card — the age
 * is the only thing that changes between rows, and re-rendering a card the user
 * may have expanded is exactly the churn the fold machinery hates.
 */
function collabRowsHtml(collab, { esc, t = T, icons = {}, live = false, now = Date.now() } = {}) {
  const rows = rowsOf(collab);
  if (!rows.length) return '';
  // A LONE row keeps its full label (agent · TYPE): the head is a summary, and
  // summarising one event would lose information for no gain. The owner's ask
  // is about CONTINUOUS chatter, which is the coalesced shape by construction.
  if (rows.length === 1) return collabRowHtml(rows[0], { esc, t, icons });
  const stats = collabTrafficStats({ rows });
  const head = collabHeadText(stats, { live, now, t });
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
  const labels = collabNamedLabels(rows);
  const titles = [labels.join(', '), ...rows.map((r) => collabRowTitle(r, t))].filter(Boolean).join('\n──\n');
  return `<span class="chat-collab-row chat-collab-multi" title="${esc(titles)}"><span class="chat-collab-icon" aria-hidden="true">${icon}</span>`
    + `<span class="chat-collab-head">${esc(head)}</span>`
    + `${names.length ? ` <span class="chat-collab-names">${names.join(', ')}</span>` : ''}</span>`;
}

module.exports = {
  agentName,
  rowsOf,
  collabRowParts,
  collabRowLabel,
  collabSummaryText,
  collabNamedLabels,
  collabReportHeadText,
  collabRowTitle,
  collabNameHtml,
  collabRowHtml,
  collabRowsHtml,
  // live progress readout (2026-09-07)
  collabTrafficStats,
  collabAgeText,
  collabSpanText,
  collabCountParts,
  collabHeadText,
  collabRunPart,
  subAgentStreamLabel,
};
