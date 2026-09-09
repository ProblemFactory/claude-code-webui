// WHERE A QUOTA READING CAME FROM — PURE (no DOM, no imports; `t` is injected
// so the same rules can be pinned in node).
//
// 2026-09-07. Every panel used to say only "Updated 3min ago", which was the
// one sentence the readings-by-slot incident could not survive: a member whose
// login had been WIPED five days earlier showed a freshly-updated panel,
// because a hot-switched session's readings kept being filed under the account
// it was SPAWNED on. The number was real, it just belonged to somebody else.
// So a panel now says WHO produced its latest reading, and a member that
// cannot produce readings at all says so with the age of its last real one.
//
// The `source` values are the ones the writers stamp (rate-limit-capture,
// markLimitBanner, refreshViaCliPanel, data/bin/vibespace-usage, the two codex
// snapshot writers, the wall demotion). An UNKNOWN value is named verbatim
// rather than bucketed — a new producer must be visible, not silently labelled
// "session".
//
// A PRODUCER THAT EXISTS MUST HAVE A NAME (2026-09-07 r3, reproduced): the
// codex writers stamped nothing, so every codex panel said "via unknown — No
// producer recorded this reading" about the only codex producer there is. The
// verbatim-unknown rule is for a producer we have not MET; using it on one we
// ship is the honesty feature lying. The stamp belongs at the write, where the
// channel is known — never inferred here from the shape of the snapshot.

/** @returns {{key:string, label:string, tip:string}} */
export function readingSource(source, { corroborated = undefined, t = (s) => s } = {}) {
  const s = String(source || '') || null;
  switch (s) {
    case 'on-demand':
      return { key: 'panel', label: t('own /usage panel'), tip: t("Read by running Claude's own /usage for this account's credentials — the account names itself.") };
    case 'control':
      return { key: 'control', label: t('own session'), tip: t("A live session on this account's credentials answered a usage request.") };
    case 'passive':
      return { key: 'session', label: t('own session'), tip: t("The status line of a terminal session running on this account's credential slot.") };
    case 'remote-statusline':
      return { key: 'remote', label: t('session on another machine'), tip: t('Harvested from a remote host that ran this account.') };
    case 'rate-limit-event':
      return { key: 'session', label: t('own session'), tip: t("A live session on this account's credential slot reported its own quota.") };
    // The two CODEX producers (2026-09-07 r3). They existed all along and were
    // rendered "via unknown" because nothing stamped them: `normalizeCodexRateLimit`
    // is a pure payload mapper, so the channel has to be named at the write.
    case 'codex-rate-limits':
      return { key: 'session', label: t('own session'), tip: t("A live Codex session on this account's credential slot pushed its own rate limits.") };
    case 'codex-rollout':
      return { key: 'transcript', label: t('session transcript'), tip: t('Read from a recent Codex session transcript on this machine — as fresh as that session\'s last turn, not as of now.') };
    case 'limit-banner':
      return { key: 'banner', label: t('own session (limit hit)'), tip: t("A session on this account's credential slot was refused by the limit.") };
    case 'wall':
      return { key: 'wall', label: t('marked spent'), tip: t('Not a reading: this account refused a turn, so the bucket was marked spent until its reset.') };
    case null:
      return { key: 'unknown', label: t('unknown'), tip: t('No producer recorded this reading.') };
    default:
      // a NEW writer must show up, never be absorbed into "own session"
      return { key: 'other', label: s, tip: t('Unrecognised reading source — reported verbatim.') };
  }
}

/** The corroboration suffix, when we have an opinion. NEVER decides anything —
 *  the reading is keyed by the credential slot; this only reports whether the
 *  OTel observation (the identity the CLI cached at SPAWN) agreed. */
export function corroborationNote(corroborated, { t = (s) => s } = {}) {
  if (corroborated === true) return t('corroborated');
  if (corroborated === false) return t('not corroborated');
  return null;
}

/** A member whose credentials are gone/expired cannot produce readings, so its
 *  panel must date the last REAL one instead of implying it is current.
 *  @param login {state, since} from /api/usage `logins`
 *  @returns null when the login is live (nothing to say) */
export function staleSince(login, fetchedAt, { t = (s) => s, now = Date.now() } = {}) {
  if (!login || login.state === 'live' || login.usable) return null;
  const what = login.state === 'wiped' ? t('signed out')
    : login.state === 'expired' ? t('login expired')
      : login.state === 'missing' ? t('no credentials')
        : t('credentials unreadable');
  // `since` is when the login died; `fetchedAt` is the newest reading on file.
  // A reading NEWER than the death is, by construction, not this account's —
  // say so rather than dating it (that is the whole incident in one line).
  const suspect = !!(login.since && fetchedAt && fetchedAt > login.since);
  return { what, since: login.since || null, suspect, fetchedAt: fetchedAt || null };
}

/** Absolute day+time for a "stale since" stamp — a relative "5 days ago" is
 *  the wrong unit for something that will never move again. */
export function stampText(ts, { locale = undefined } = {}) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return new Date(ts).toISOString(); }
}

// ── PAID OVERAGE (docs/design-account-hardening.md §1.4 + D3) ────────────────
// `cache.overage` has been captured from the CLI's own rate_limit_event since
// 2.289.0 and was read by NOBODY: the panels showed a donut under 100% while
// every token on that account was billed pay-per-use, and `accountRemaining()`
// therefore ranked it as the member with the MOST headroom. The verdict itself
// is the PURE `overageState` in src/spend-authorizer.js — the same function the
// spend authorizer and the pool's voluntary-target rule ask, so a panel can
// never disagree with the gate. This only picks the words.
// Returns null when there is nothing to say ('no' AND 'unknown' — ignorance is
// not a claim), so a caller can `if (chip)`.
export function overageChip(state, { t = (s) => s } = {}) {
  if (!state || state.inUse !== 'yes') return null;
  const money = state.spend
    ? ` — $${state.spend.used.toFixed(2)}${state.spend.limit ? ` / $${state.spend.limit.toFixed(2)}` : ''}`
    : '';
  return {
    label: t('paid overage in use') + money,
    tip: t('Automatic turns are refused on this account while it bills paid overage (Settings → Spending).'),
  };
}

// ── SPEND CONTROL (the §1.4 row's THIRD field, r4) ──────────────────────────
// codex's `spend_control_reached` was captured and read by NOBODY, exactly as
// `cache.overage` had been — and it is worse to miss on a panel, because the
// donuts stay friendly: nothing marks a window spent, so the account ranks as
// the one with the most headroom while every request it serves is REJECTED.
// The verdict is the PURE `spendControlState`, the same one the authorizer
// asks, so the chip and the gate cannot disagree. Returns null when there is
// nothing to say ('no' AND 'unknown').
export function spendControlChip(state, { t = (s) => s } = {}) {
  if (!state || state.reached !== 'yes') return null;
  return {
    label: t('spend control reached'),
    tip: t('This account has reached its spend control, so its requests are rejected — automatic turns on it are refused.'),
  };
}

// ── LIMITS, NOT BUCKETS (B-9213 / B-8b12) ───────────────────────────────────
// An account can hold SEVERAL limits at once — measured on this instance, one
// codex conversation pushed three (`codex`, `GPT-5.3-Codex-Spark`, `premium`),
// and the panel used to show whichever spoke last. It can also hold a window
// that has NOT STARTED, whose "reset time" is `now + duration` on every read;
// printing that as a precise instant is how a banked reset looked consumed.
//
// The rules live in `src/quota-model.js` (PURE, bundled). These two helpers are
// the CLIENT's share of them: the panels ask what a bucket may SAY, they do not
// re-derive what it IS.

/** Has this window not started yet? Reads the stamp the ONE write path puts on
 *  every projected bucket — never a re-derivation from the numbers, because the
 *  client has no idea WHEN the vendor answered. */
export function windowNotStarted(b) { return !!(b && typeof b === 'object' && b.state === 'empty'); }

/** What a not-yet-started window prints where a reset time would go. A window
 *  the vendor has not opened has no deadline to show, and saying "resets in
 *  4h 59m" about it is a number that will still say "4h 59m" tomorrow. */
export function windowNote(b, { t = (s) => s } = {}) {
  return windowNotStarted(b) ? t('starts on first use') : null;
}

/** The panel row for every limit an account holds, served-model first.
 *  `set` is a typed LimitSet (src/quota-model.js — `limitsOfCache` lifts a
 *  stored snapshot into one). Each row carries its OWN producer and age,
 *  because three limits on one account are three separate readings and
 *  "Updated 3min ago" on the panel header describes only the newest. */
export function limitRows(model, set, { modelName = null, family = null, t = (s) => s } = {}) {
  if (!model || !set) return [];
  return model.orderLimits(set, { model: modelName, family }).map((l) => ({
    limitId: l.limitId,
    label: model.limitLabel(l),
    scope: l.scope,
    state: model.limitState(l),
    source: l.source || null,
    sourceLabel: l.source ? readingSource(l.source, { t }).label : null,
    fetchedAt: l.fetchedAt || null,
    windows: model.windowsOf(l).map((w) => ({
      kind: w.kind, usedPct: w.usedPct, resetsAt: w.resetsAt, state: w.state,
      note: w.state === 'empty' ? t('starts on first use') : null,
    })),
  }));
}
