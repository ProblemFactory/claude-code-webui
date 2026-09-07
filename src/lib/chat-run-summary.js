// Run-fold classification + summary composition — PURE (no DOM, no imports).
// ChatView._updateRuns feeds it per-card raw messages and renders the label;
// scripts/test-fold-ux.mjs pins it in node. Extracted 2.369.37 after the
// owner caught "9 条 Bash · 1 次 MCP" over a run whose only non-Bash card was a
// ToolSearch — the classifier had lumped tool-schema lookups into 'mcp' and
// the summary then CLAIMED an MCP call that never happened. Labels must be
// honest per kind; which kinds FOLD stays a separate question (see
// foldToggleFor).

// Every kind the classifier can return. The summary ORDER below must list
// each one — an unlisted kind used to count `undefined++` = NaN and vanish
// from the label (2.369.34); countKinds() now zero-fills from this list and
// the test asserts SUMMARY_ORDER covers it.
export const RUN_KINDS = ['thinking', 'bash', 'read', 'search', 'image', 'write', 'memory', 'mcp', 'lookup', 'agent', 'report', 'skill'];

// Counts the CALLER supplies that are not card kinds — they are never
// produced by messageKind() and never zero-filled, so an unset one simply
// renders nothing (no `undefined++`, so no NaN). They still get their line
// from the ONE SUMMARY_ORDER below so ordering never forks.
//   subAgentIn = inbound codex collab rows in the run (B-7473): "5 agent ops"
//   said nothing about a sub-agent having reported back.
export const SUMMARY_EXTRAS = ['subAgentIn'];

// Label order (kind → i18n key). 'skill' has no count line by design (a
// "Launching skill" card is pure harness noise) — it still folds.
// 'report' = a codex sub-agent's written answer (B-7473): it is CONTENT, so
// the kind ships UNCHECKED in chat.collapseKinds; the line only appears for a
// user who ticked it.
const SUMMARY_ORDER = [
  ['thinking', '{n} thinking'],
  ['bash', '{n} Bash'],
  ['read', '{n} file reads'],
  ['search', '{n} web searches'],
  ['image', '{n} image reads'],
  ['write', '{n} writes'],
  ['memory', '{n} memory'],
  ['mcp', '{n} MCP'],
  ['lookup', '{n} tool lookups'],
  ['subAgentIn', '{n} sub-agent messages'],
  ['agent', '{n} agent ops'],
  ['report', '{n} sub-agent reports'],
  ['skill', null],
];

// MCP tool ids (mcp__<server>__<tool>) split into their parts — the raw
// triple-underscore identifier as a card header was the reported eyesore.
export function mcpParts(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ''));
  return m ? { server: m[1], tool: m[2] } : null;
}

/**
 * Semantic kind of one card. `toolCard` = the element is a tool-result card
 * (role assistant + tool_use block); non-tool cards can only be 'thinking'.
 * SEMANTIC HINT FIRST (Track B, design-backend-parity.md §5): the normalizer
 * stamps `collapseKind` — codex cards (exec, Agent Wait, send_message…) never
 * matched the claude tool-name map and so NOTHING codex folded (owner
 * report). The name map stays as the fallback for claude + pre-hint records.
 * @param {object} m raw normalized message
 * @param {{toolCard:boolean, isMemoryPath:(fp:string)=>boolean}} opts
 * @returns {string|null} a RUN_KINDS member, or null (= NOT foldable AND
 *   breaks the surrounding run — every new tool name needs a kind)
 */
export function messageKind(m, { toolCard, isMemoryPath = () => false }) {
  if (toolCard) {
    const b0 = m?.content?.[0];
    const fp = b0?.input?.file_path || '';
    const ck = m?.collapseKind;
    if (ck) {
      if ((ck === 'read' || ck === 'write') && isMemoryPath(fp)) return 'memory';
      return ck;
    }
    const tn = m?.content?.[0]?.toolName;
    if (tn === 'Bash') return 'bash';
    // Skill launches (2.227.9, user report "技能卡片无法参与折叠") — a
    // "Launching skill: x" card is pure harness noise, same class as a Bash
    // line; it fell through to null and so BROKE the surrounding run.
    if (tn === 'Skill') return 'skill';
    if (tn === 'Agent' || tn === 'Task') return 'agent'; // claude sub-agent cards join the collab kind
    // web research is its OWN kind (2.369.33, owner report: 42 WebSearch cards
    // in one session, none folded — and each null BROKE the surrounding run)
    if (tn === 'WebSearch' || tn === 'WebFetch') return 'search';
    // EVIDENCE, NEVER THE EXTENSION (image-card review round 2, 2026-09-06): a Read is an image view
    // only when its RESULT carried lifted image blocks. claude hands back
    // numbered TEXT for the text-source image formats — measured, 12/12 real
    // `Read *.svg` tool_results in the fleet corpus are plain strings starting
    // "1\t<svg …" — so an extension rule counted those as "image reads" in the
    // summary AND (since the image kind is exempt from folding) let a plain
    // text card escape its run. codex/ACP never reach this line: their
    // normalizers stamp `collapseKind` above.
    if (tn === 'Read' && b0?.images?.length > 0) return 'image'; // image views fold as their own kind (2.369.34)
    if (tn === 'Grep' || tn === 'Glob' || tn === 'LS') return 'read';   // file-system searches = reads
    // Tool-schema lookups are NOT MCP calls (owner, 2.369.37): they fold with
    // their neighbours under the MCP toggle (foldToggleFor) but count as
    // their own line — "1 tool lookups", never "1 MCP".
    if (tn === 'ToolSearch') return 'lookup';
    if (mcpParts(tn)) return 'mcp'; // any MCP server's tool (2.215.3)
    if (tn === 'Read' || tn === 'Write' || tn === 'Edit' || tn === 'Patch') {
      // agent-memory file ops are their OWN kind (2.213.1, user ask:
      // each is a distinct user concern) — housekeeping vs project work
      if (isMemoryPath(fp)) return 'memory';
      return tn === 'Read' ? 'read' : 'write';
    }
    return null;
  }
  if (m?.role === 'assistant' && Array.isArray(m.content) && m.content.length
      && m.content.every((b) => b.type === 'thinking')) return 'thinking';
  return null;
}

/**
 * Which chat.collapseKinds toggle governs a kind. 'lookup' rides the 'mcp'
 * toggle: no new checkbox (users who customised their list keep folding
 * exactly what they fold today), only the LABEL changed.
 */
export function foldToggleFor(kind) {
  return kind === 'lookup' ? 'mcp' : kind;
}

/** Zero-filled per-kind counter over a list of kinds (null/undefined skipped). */
export function countKinds(kinds) {
  const byKind = {};
  for (const k of RUN_KINDS) byKind[k] = 0;
  for (const k of kinds) if (k) byKind[k] = (byKind[k] || 0) + 1;
  return byKind;
}

/**
 * The per-kind count parts of a fold summary, e.g. ["9 Bash", "1 tool lookups"].
 * Only non-zero kinds render. A single-server MCP run names the server —
 * "8 MCP (chrome-devtools)"; the suffix covers ONLY real mcp__server__tool
 * calls (lookups never contribute a server).
 * @param {Record<string,number>} byKind
 * @param {Iterable<string>} mcpServers distinct servers among the run's mcp cards
 * @param {(key:string, params?:object)=>string} t i18n
 */
export function runSummaryParts(byKind, mcpServers, t) {
  const parts = [];
  const servers = [...(mcpServers || [])];
  for (const [kind, key] of SUMMARY_ORDER) {
    if (!key || !byKind?.[kind]) continue;
    let s = t(key, { n: byKind[kind] });
    if (kind === 'mcp' && servers.length === 1) s += ` (${servers[0]})`;
    parts.push(s);
  }
  return parts;
}

/**
 * Full header label: kind parts · sub-agent traffic · touched files · errors · running.
 * `collabPart` is a PRE-COMPOSED segment (src/collab-row.js `collabRunPart` —
 * "3 sub-agents · 47 messages · last 4s ago"): its WORDS belong to the collab
 * module, its POSITION belongs to this one composer, so the header, the
 * floating run bar and the run footer can never read different orders. This
 * module stays import-free by taking the string, not the module.
 * @param {{byKind:object, mcpServers?:Iterable<string>, files?:string[], nErr?:number, running?:boolean, collabPart?:string}} run
 *   files = display names in render order (writes already prefixed '✎ '), deduped by the caller
 */
export function runSummaryLabel({ byKind, mcpServers, files = [], nErr = 0, running = false, collabPart = '' }, t) {
  const kindParts = runSummaryParts(byKind, mcpServers, t);
  if (collabPart) kindParts.push(collabPart);
  let label = kindParts.join(' · ');
  // touched files (user ask: don't lose the paths), capped at 4 + "+N"
  if (files.length) {
    const shown = files.slice(0, 4);
    label += ' — ' + shown.join(', ') + (files.length > 4 ? `, +${files.length - 4}` : '');
  }
  // failed members surface as a count (an error must not vanish into a
  // silent fold — grep-exit-1 class errors are common and folding them is
  // fine, but the header says they exist)
  if (nErr) label += ` · ${nErr} ✗`;
  // live state on the fold: a running member shows through the header
  if (running) label += ' · ' + t('running…');
  return label;
}

export { SUMMARY_ORDER };
