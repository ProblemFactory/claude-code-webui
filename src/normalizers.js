const { HARNESSES } = require('./harnesses');
const { MessageManager } = require('./message-manager');

// REGISTRY, not a ternary (P4, design-backend-parity.md §4): the old
// `backend === 'codex' ? Codex : Claude` shape silently handed every FUTURE
// backend the claude normalizer — the gemini-as-claude fallthrough class. An
// unregistered backend fails LOUDLY at session start, where the gap is
// obvious, instead of mis-parsing an entire conversation. Since S1 the rows
// come from the harness descriptors (src/harnesses/<id>.js Normalizer).
const NORMALIZERS = Object.fromEntries(Object.values(HARNESSES).map((h) => [h.id, h.Normalizer
  || MessageManager])); // terminal-only harnesses (shell) get the inert claude shape — they have no chat mode

// opts (optional, harness-neutral): { threadId } — the READER's conversation
// id for the transcript it opened. The codex normalizer keys its per-message
// ledger meta by it (`cx:<thread>:<cumulative>`); a merged codex read carries
// fork-ancestry / parent-provenance session_metas that must never re-point
// that key, and a gap slab carries no session_meta at all. Normalizers that
// have no use for it ignore the extra argument.
function createMessageManager(backend, sessionId, opts) {
  const Ctor = NORMALIZERS[backend || 'claude'];
  if (!Ctor) throw new Error(`no message normalizer registered for backend "${backend}" — add it to src/normalizers.js NORMALIZERS`);
  return new Ctor(sessionId, opts);
}

/**
 * THE live-feed gate (2.369.16). Every live record reaches the session's
 * normalizer through here — never processLive() directly — so a rebuild in
 * progress can hold records back (session._rebuildQueue) and replay them in
 * order once the history is converted. Without the gate, a record arriving
 * mid-rebuild landed BEFORE the rest of the history.
 */
function feedLive(session, msg) {
  if (!session?._normalizer) return;
  if (session._rebuildQueue) { session._rebuildQueue.push({ kind: 'live', msg }); return; }
  session._normalizer.processLive(msg);
}

/** Peer cards (Background Work notify, vibespace-msg, auto-resume notices)
 *  are the OTHER writer into a session normalizer — same gate (review-caught:
 *  a card injected mid-rebuild landed in the middle of old history). */
function feedPeerCard(session, card) {
  if (!session?._normalizer?.injectPeerCard) return false;
  if (session._rebuildQueue) { session._rebuildQueue.push({ kind: 'peer', card }); return true; }
  session._normalizer.injectPeerCard(card);
  return true;
}

function drainQueue(session, mm) {
  // Records that arrive DURING the drain queue behind (the queue stays armed
  // until it is empty) — no interleaving window.
  while (session._rebuildQueue?.length) {
    const e = session._rebuildQueue.shift();
    try {
      if (e.kind === 'peer') mm.injectPeerCard?.(e.card);
      else mm.processLive(e.msg);
    } catch (err) { console.error('[normalizer] queued record skipped after rebuild:', err.message); }
  }
}

// FIFO: rebuilds run ONE AT A TIME. Fair round-robin slicing of N concurrent
// rebuilds makes every session's 'attached' land near the total time (19
// windows × 10-56MB = minutes for ALL of them, past the client's re-attach
// ladder); serialized, the first windows open in seconds while the loop
// stays responsive throughout (acks, kills, other sessions' traffic).
let rebuildChain = Promise.resolve();

/**
 * Single-flight, time-sliced first-attach rebuild. Swaps in a fresh
 * normalizer (carrying every op subscriber), converts `records` in slices
 * that yield to the event loop, then replays the records that arrived
 * meanwhile. Concurrent attaches await the same promise instead of
 * rebuilding twice. `_historyLoaded` is set AFTER success (2.89.2 rule).
 */
function rebuildHistory(session, sessionId, records, { budgetMs, onProgress } = {}) {
  if (session._rebuildPromise) return session._rebuildPromise;
  const opHandlers = [...(session._normalizer?.listeners || [])];
  const mm = createMessageManager(session.backend || 'claude', sessionId, { threadId: session.backendSessionId || session.claudeSessionId || null }); // pin the rendered conversation's id (codex ledger key; null before a fresh thread is adopted)
  for (const h of opHandlers) mm.onOp(h);
  session._normalizer = mm;
  session._normEpoch = Date.now();
  session._rebuildQueue = [];
  session._rebuildProgress = { done: 0, total: records?.length || 0 };
  const run = async () => {
    try {
      await mm.convertHistoryAsync(records, { ...(budgetMs ? { budgetMs } : {}), onSlice: (done) => { session._rebuildProgress = { done, total: records?.length || 0 }; try { onProgress?.(session._rebuildProgress); } catch { } } });
      drainQueue(session, mm);
      session._historyLoaded = true;
    } finally {
      // Even a FAILED rebuild must not lose the records held meanwhile
      // (review-caught): drain into whatever normalizer we have.
      try { drainQueue(session, mm); } catch { }
      session._rebuildQueue = null;
      session._rebuildPromise = null;
      session._rebuildProgress = null;
    }
  };
  const turn = rebuildChain.then(run, run);
  rebuildChain = turn.catch(() => {});
  session._rebuildPromise = turn;
  return turn;
}

module.exports = { createMessageManager, NORMALIZERS, feedLive, feedPeerCard, rebuildHistory };
