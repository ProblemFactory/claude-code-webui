'use strict';
// PURE resume-continuity ladder (B-6b6d, owner ruling 2026-09-07 on the known
// residue of 2.369.62 "THE EFFORT A TURN RAN AT").
//
// THE RULE: **a conversation's OWN value wins on resume / fork / restart; the
// instance default (`<prefix>.defaultModel` / `.defaultEffort`) is a NEW-session
// default.** An explicit per-session pick (the card ⚙, Session Properties, the
// New Session dialog's own pickers) still beats both.
//
// Why this exists as a module instead of two `||` chains at the spawn: before
// it, the CLIENT filled the instance default into every create — including
// resumes that carried no pick — so ws-create's continuity fallback
// (`lastCodexTurnEffort`, the whole point of B-21e4 item 4) could never fire,
// and a conversation the owner had set to `ultra` resumed at `xhigh`, with the
// wrapper then synthesizing a `turn_context` that stated the wrong value on
// every message of the session.
//
// TWO FACTS DECIDE, AND THEY ARE ASKED SEPARATELY:
//   `resume`     — is this create a continuation at all (a resumeId rides it:
//                  resume, fork, restart-in-place)?
//   `hasSource`  — can THIS harness recover the knob from the conversation
//                  itself? It is NOT declared twice: the caller derives it from
//                  the harness descriptor's `store.lastTurn<Knob>` hook, so a
//                  harness either ships the reader or it does not
//                  (src/harnesses/*.js). codex has both (its rollout writes a
//                  `turn_context` per turn); claude has the MODEL only (its
//                  transcript names the model that SERVED each assistant
//                  message, and nothing anywhere records the effort a claude
//                  turn ran at — the CLI never reports it back).
//
// THE ASYMMETRY THAT FALLS OUT OF `hasSource`, stated because it looks like an
// omission: on a knob with NO conversation source, a resume sends NOTHING
// rather than the instance default. Falling back there would mean "the instance
// default applies to every resume", which is the defect itself wearing a
// fallback's clothes. With a source that came up EMPTY (a thread resumed before
// its first turn) the instance default is honest — and the caller logs it.
//
// '' IS A STATED CHOICE, undefined IS SILENCE — AND THE DIFFERENCE ONLY
// SURVIVES ON A NEW SESSION (r2 review). The New Session dialog's first option
// IS `''` ("Auto (model default)" / "Default", src/lib/app.js) and it always
// sends a defined string, so collapsing `''` into "no pick" made an explicit
// Auto resolve to the instance default — the user picked "let the agent
// decide" and got `codex.defaultEffort`. On a NEW session `''` therefore wins
// as `{value:'', origin:'chosen'}`, and the client sends the resolved value
// VERBATIM there so the empty string survives the wire.
// On a CONTINUATION the distinction is not available and must not be faked: the
// create message carries `model: sessionModel || undefined` on that path, so an
// explicit Auto and an absent field are the same bytes by the time the server
// sees them — and the per-session config store has always written '' for "no
// override" (session-card.js). A pick of Auto on a resumed conversation
// therefore restores the conversation's own value; the only way to command
// "auto" for real is to change it inside the session.

/** The vocabulary BOTH tiers speak (the client labels these strings in
 *  src/lib/agent-meta.js; nothing else may invent one). */
const SPAWN_ORIGINS = Object.freeze(['chosen', 'conversation', 'instance', 'harness']);

/**
 * Decide ONE spawn knob (model or effort) for ONE create.
 * @param {object} a
 * @param {string} [a.explicit]         the value the client sent for THIS session (undefined/null = silence;
 *                                      '' = a STATED "Auto (model default)", honoured on a NEW session only)
 * @param {string} [a.conversation]     the value read out of the conversation's own records ('' = none recorded)
 * @param {string} [a.instanceDefault]  `<prefix>.default<Knob>` ('' = the setting is unset)
 * @param {boolean} [a.resume]          this create continues an existing conversation (resume/fork/restart)
 * @param {boolean} [a.hasSource]       this harness can read the knob back off the conversation
 * @returns {{value: string, origin: 'chosen'|'conversation'|'instance'|'harness'}}
 *          `value` '' = send nothing (the agent's own config decides).
 */
function resumeSpawnPick({ explicit, conversation, instanceDefault, resume, hasSource } = {}) {
  const s = (v) => (v === undefined || v === null ? '' : String(v).trim());
  const e = s(explicit), c = s(conversation), d = s(instanceDefault);
  if (e) return { value: e, origin: 'chosen' };
  // A STATED empty ("Auto (model default)") is a choice, not silence — but only
  // where the wire can still tell the two apart, i.e. on a NEW session.
  const statedAuto = explicit !== undefined && explicit !== null && e === '';
  if (!resume && statedAuto) return { value: '', origin: 'chosen' };
  if (!resume) return d ? { value: d, origin: 'instance' } : { value: '', origin: 'harness' };
  if (c) return { value: c, origin: 'conversation' };
  // A resume on a knob this harness cannot read back: the instance default is
  // NOT a fallback here (see the asymmetry note above) — say nothing.
  if (!hasSource) return { value: '', origin: 'harness' };
  return d ? { value: d, origin: 'instance' } : { value: '', origin: 'harness' };
}

/**
 * THE WIRE CANNOT TELL A PICK FROM A CLIENT-RESOLVED DEFAULT — SO THE CLIENT
 * SAYS WHICH IT IS (B-6b6d round 3, adversarial verifier).
 *
 * On a NEW session the CLIENT runs the ladder first (`session-lifecycle.js`
 * needs the resolved value for its own status chip, and it owns two facts the
 * server does not: the legacy `session.defaultEffort` key, honoured only while
 * `<prefix>.defaultEffort` is UNMODIFIED, and `settings.isModified` itself).
 * It then sends the resolved value VERBATIM so a stated "Auto (model default)"
 * survives as `''`. Both are right — but they leave the server looking at a
 * bare string it can only read as an explicit pick, so `_modelOrigin` /
 * `_effortOrigin` were ALWAYS 'chosen' for a new session, 'instance' was
 * unreachable there, and Session Properties labelled `<prefix>.defaultModel`
 * "your choice for this session" on every create path that shows no picker at
 * all (openShellTerminal, the toolbar, setup-flows, manage-agents).
 *
 * The fix is not to guess: the client already computed the origin and threw it
 * away, so it now sends it as `spawnOriginHint` and this function reconciles.
 * It may only DOWNGRADE a 'chosen' to a fact the user did not state, never
 * upgrade or re-point anything — the value itself is untouched, and the only
 * party that could lie here is the same client that made the pick it would be
 * lying about. An absent/older client sends no hint and keeps master's answer.
 *
 * @param {string} origin  what the server's own ladder decided for this knob
 * @param {*} hint         the client's `spawnOriginHint.<knob>` (untrusted)
 */
function applyOriginHint(origin, hint) {
  // Only a 'chosen' can be a client-resolved default wearing a pick's clothes:
  // every other rung was decided by the SERVER from facts the client never had
  // (the conversation's own records, serverSetting) and no hint may touch it.
  if (origin !== 'chosen') return origin;
  // …and the hint is only believed when it says "the user did NOT state this".
  // 'chosen'/'conversation' would add nothing (the first agrees, the second is
  // a fact only the server can hold), so they are ignored rather than trusted.
  return (hint === 'instance' || hint === 'harness') ? hint : origin;
}

/** One line for the spawn log — a resume that quietly took the instance default
 *  because the conversation recorded nothing must be READABLE afterwards (the
 *  "no silent failures" rule applied to a decision rather than an error). */
function continuityLogLine(backend, resumeId, picks) {
  const bits = Object.entries(picks || {})
    .map(([knob, p]) => `${knob}=${p && p.value ? p.value : '∅'}(${(p && p.origin) || '?'})`)
    .join(' ');
  return `[session] resume continuity ${backend} ${String(resumeId || '').slice(0, 8)}: ${bits}`;
}

module.exports = { resumeSpawnPick, applyOriginHint, continuityLogLine, SPAWN_ORIGINS };
