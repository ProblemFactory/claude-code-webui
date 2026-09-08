'use strict';
// PURE rewind semantics (docs/design-harness-features.md §2.10 + §3.2 —
// "even if we offer no ACTION, consuming the event is the minimum").
//
// Two harnesses tell us, today, on the live stream, that part of the
// conversation has been RETRACTED — and both were dropped on the floor:
//
//   claude   `{type:'tombstone', message:<the retracted Message>, uuid,
//             session_id}` — 2.1.257's own describe: "Emitted when a
//             previously-yielded message is superseded or removed from the
//             transcript (e.g., streaming→non-streaming fallback removes a
//             partial orphan). Consumers that render or persist the stream
//             should remove the referenced message." We do BOTH (render and
//             persist), so a retracted half-message lived in the transcript
//             forever.
//   codex    `{type:'event_msg', payload:{type:'thread_rolled_back',
//             num_turns:N}}` — ThreadRolledBackEvent, one field, dumped from
//             the 0.153.4 binary's serde tables; `thread/rollback`'s own
//             param doc: "The number of turns to drop from the END of the
//             thread." A rollback done from the codex TUI left ghost turns on
//             screen in VibeSpace. The SAME payload shape appears live and in
//             the rollout (both go through _processEvent), so ONE handler
//             covers both — §6's union-survey rule.
//
// The two land on ONE normalized op (`meta` / subtype 'rewound'), so the view
// has a single thing to implement:
//     { harness, toMessageId, numTurns, ids, kind, ts }
// `toMessageId` names the claude message that was retracted, `numTurns` the
// codex turn count; exactly one is non-null and BOTH are always present as
// keys (a null is a statement, an absent key is a gap — 2.369.62's law).
//
// WHY MARK, NEVER SPLICE. Removing entries from the normalizer's array would
// shift every index under `slice(offset, limit)` and change `total` under a
// client that is mid-pagination — the exact machinery three separate paging
// incidents came out of (2.301.0 → 2.369.x). Marking is index-stable: the
// message stays where it is, wears `rewound: <kind>`, renders per that kind and
// drops out of `turnMap()` (the minimap must not point at a ghost turn). The
// truth is visible on the live stream AND on a reload of the transcript,
// because the marking happens inside the normalizer, in record order.
//
// PURE: imports nothing, touches no I/O — the harness normalizers call it and
// scripts/test-codex-history + test-stdout-registry exercise it directly.

/** Ids of the messages a claude `tombstone` retracts.
 *  The record's `message` is the CLI's internal Message ("wire shape pending a
 *  dedicated schema"), so we match on the two identities our normalizer
 *  actually carries: the record uuid it was minted from, and — when the
 *  retracted message is an API assistant message — the `message.id` that
 *  MessageManager.recordKey turns into the `m:<id>` id segment.
 *  Unknown/absent identity ⇒ [] (a tombstone for something we never rendered
 *  is not an error; it is a record about a message that never reached us). */
function rewoundByRecord(messages, { uuid = null, messageId = null } = {}) {
  const ids = [];
  if (!Array.isArray(messages) || (!uuid && !messageId)) return ids;
  for (const m of messages) {
    if (!m || m.rewound) continue;
    if (uuid && m.uuid && m.uuid === uuid) { ids.push(m.id); continue; }
    if (messageId && typeof m.id === 'string'
      && (m.id.endsWith(':m:' + messageId) || m.id.includes(':m:' + messageId + '.'))) ids.push(m.id);
  }
  return ids;
}

/** Ids of the messages a codex `thread_rolled_back {num_turns:N}` drops.
 *  A codex TURN starts at a user prompt, so the cut point is the Nth-from-last
 *  USER message and everything after it goes. (Our `turnIndex` counter is NOT
 *  the unit here: it also advances on task_started and on compaction, so one
 *  codex turn can span two of them — measured on the owner's two real rollouts
 *  that contain this record: 24 user records under 30 turnIndex groups.)
 *  Already-rewound messages are skipped, so two rollbacks in a row each drop
 *  N *live* turns instead of double-counting the first one's.
 *  Fewer than N user messages left ⇒ everything goes, and `turnsFound` says
 *  how many were actually there (the caller reports the honest number). */
function rewoundByTurns(messages, numTurns) {
  const n = Math.max(1, Math.floor(Number(numTurns) || 0) || 1);
  const out = { ids: [], cutIndex: -1, turnsFound: 0 };
  if (!Array.isArray(messages) || !messages.length) return out;
  let cut = 0;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.rewound) continue;
    if (m.role === 'user') {
      seen++;
      cut = i;
      if (seen === n) break;
    }
  }
  out.turnsFound = seen;
  if (!seen) return out;               // nothing user-authored to roll back to
  out.cutIndex = cut;
  for (let i = cut; i < messages.length; i++) {
    const m = messages[i];
    if (m && !m.rewound) out.ids.push(m.id);
  }
  return out;
}

// The mark is the REASON, not a bare boolean — the two harnesses retract for
// different reasons and the view owes them different treatment:
//   'superseded' — claude tombstone: a partial orphan the CLI REPLACED, and
//                  its own instruction is "remove the referenced message". The
//                  canonical copy is right there; a struck-through duplicate
//                  beside it would be noise, so the view HIDES it.
//   'rollback'   — codex thread_rolled_back: turns the user (or the agent)
//                  deliberately took back. Hiding them would silently rewrite
//                  what someone remembers reading, so the view STRIKES them
//                  and keeps them in place.
const REWOUND_KINDS = ['superseded', 'rollback'];

/** Stamp the mark on the named messages. Returns the ids that CHANGED (an id
 *  already marked, or unknown, is not re-reported — the op must describe what
 *  actually happened). */
function applyRewound(messages, ids, kind = 'rollback') {
  const want = new Set(ids || []);
  const done = [];
  if (!Array.isArray(messages) || !want.size) return done;
  const k = REWOUND_KINDS.includes(kind) ? kind : 'rollback';
  for (const m of messages) {
    if (!m || !want.has(m.id) || m.rewound) continue;
    m.rewound = k;
    done.push(m.id);
  }
  return done;
}

/** THE normalized op both harnesses emit (one shape for the view). */
function rewoundOp({ harness, toMessageId = null, numTurns = null, ids = [], kind = 'rollback', ts = 0 }) {
  return {
    op: 'meta',
    subtype: 'rewound',
    data: {
      harness: String(harness || ''),
      toMessageId: toMessageId || null,
      numTurns: Number.isFinite(numTurns) ? numTurns : null,
      ids: ids.slice(),
      kind: REWOUND_KINDS.includes(kind) ? kind : 'rollback',
      ts: ts || Date.now(),
    },
  };
}

module.exports = { rewoundByRecord, rewoundByTurns, applyRewound, rewoundOp, REWOUND_KINDS };
