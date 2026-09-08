# Account hardening: one identity, one write path, one spend ceiling

**Status**: DESIGN — owner decisions pending (§6). No code has been written against this document.
**Motivation**: five money-relevant incidents shipped fixes on top of each other in three days
(2026-09-05 → 2026-09-08), the fifth arriving **94 seconds after the fully-fixed build booted**.
**Companions**: docs/design-wall-machine.md (the turn-granular wall state machine this builds on),
docs/design-three-tier.md (the tier rules every change below is routed by), CLAUDE.md's
Pool/billing routing row (the auto-loaded law whose reasoning this document replaces).

Members are anonymised **A–G** throughout; this repository is public and carries no account ids,
org identifiers or addresses. Every figure below was re-measured on this instance while writing
this document unless marked *(audit)*.

---

## 1. The money-loss catalogue

### 1.1 The five incidents

| # | What happened | Measured cost / blast radius |
|---|---|---|
| I1 | Auto-resume fired **130 billed "continue" turns** into a rate-limit wall (a sibling session, 32). Rejections were attributed to the OTel-observed *spawn* org, so the pool "switched" to the member it was already on and fired again. | ~150 junk cards in one conversation; 1164 same-target re-points on 09-07, **983 of them in one hour** *(audit)* |
| I2 | Quota **readings** were keyed by the spawn org too, so every value a session produced after a hot switch was filed under the account it started on. | **464 foreign anchors** on this instance (§1.2), poisoning the learned burn rates |
| I3 | A login session expires on an **absolute deadline the CLI cannot extend**; nobody was told, and the pool kept choosing dead logins. | Turns failing on a member a 30-second re-login would have fixed |
| I4 | Re-logged-in accounts did not clear their filed warnings. | Red chips + urgent inbox items about accounts that were already healthy |
| I5 | `inc-mts8a8mr-ulmm`: after a re-point, in-flight responses (old token) were filed on the **new** slot ⇒ a 13% account displayed 93% ⇒ **two false fleet switches in 100 seconds**. | 4,446,523 excess cache-write tokens in 8 min ≈ **$89 API-equivalent** *(audit)*; one 950k-token conversation re-wrote its cache 4× in 6.5 min |

Alongside them, the EDF strategy drove one member from **60% → 95% of its weekly window in
12.4 hours** *(audit)* — not a defect, but the policy operating with no floor in exactly the band
where its inputs are least trustworthy.

### 1.2 The contamination, re-measured

Each claude subscription's weekly window is a fixed weekly cadence, so `sevenDay.resetsAt mod
604800` is a per-account **phase fingerprint**, stable to ±60s (the API reports the boundary as
either `:00` or `:00−60s`). Clustering every anchor stream on this instance by that phase:

| stream | windowed anchors | phase clusters | foreign |
|---|---|---|---|
| member A | 1359 | 5 | **274 (20.2%)** |
| member B | 1157 | 5 | **183 (15.8%)** |
| member C | 976 | 3 | 5 |
| member D | 944 | 2 | 1 |
| member E | 333 | 2 | 1 |
| members F, G (small streams) | 25 | 1 each | 0 |
| **claude total** | **4799** | — | **464** |
| codex | 1532 | **53** | n/a — see below |

Three facts this table carries, all load-bearing for §4:

1. **The signal is clean.** Four of the six real streams show 0–5 outliers; the two the pool
   actually rotates between show 20.2% and 15.8%. This is a guard that fires on real damage, not
   on noise.
2. **The foreign values are other members'.** 30 of 41 contiguous foreign runs match, to the
   second, a `resetsAt` present in the true owner's own stream within ±1h *(audit)*. The longest
   run is **15.3 hours / 71 consecutive readings** — this is not a mid-turn race, it is a
   sustained mis-binding.
3. **It is claude-only.** Codex's window is `now + window_minutes` (rolling), giving **53
   clusters** — there is no fingerprint to check. Any design that leans on this check alone
   protects one backend and silently protects none of the others.

### 1.3 The repair that repaired nothing

`data/migrations.json` records `2026-09-reattribute-readings-by-slot` applied at
2026-09-08T05:05:45Z. Its entire output:

```
data/archive/readings-foreign-anchors.ndjson:     1 row
data/archive/readings-foreign-usage-cache.ndjson: 1 row
data/archive/readings-foreign-rates.ndjson:       1 row
```

Against the 464 above, and against its own pre-ship dry run on a copy of these stores (3 caches /
248 anchors / 44 attribution rows). The cause is structural: its only accepted proof is a **wiped
credential file's mtime**, and the I3/I4 fix had just told the owner to re-log those members in,
overwriting it. It then dropped `rates.json` so the estimator re-learned **from the still-poisoned
set**, fired a success notice, and marked itself applied forever (`run-at-most-once`).

### 1.4 Money that leaks with no incident attached

| Leak | Evidence | Status |
|---|---|---|
| **Overage is captured and discarded.** `cache.overage` is written (`src/rate-limit-capture.js:131`) and read by **nobody**; claude's `spend {used,limit,pct}` and codex's `spendControlReached` (`src/harnesses/codex-quota.js:75`) likewise have zero consumers. `accountRemaining()` sees only `utilization`, so an account past its allowance and billing pay-per-use ranks as the member with the **most** remaining. | grep: 0 readers | unaddressed |
| **Seven producers can start a billed turn with no per-occurrence owner action**; only auto-resume consults quota, and `src/server/conversation-deliver.js` consults nothing at all — not quota, not login, not the pool's blocked state. | *(audit)* census | unbounded |
| **The Stop bookkeeping nudge** forces an extra frontier-model turn per stop. | 526 forced turns / 311M cache-read tokens across 7 conversations in 3 days *(audit)*; its only rate limiter is `s._lastStopNudge` — **0 occurrences in `src/session-schema.js`**, so it is not persisted and resets on every release restart | unbounded |
| **The money gate fails open twice**: `usage-pool-engine.js:1331` `catch { return true; }` and again in the wiring at `server.js:1491`. | verified | unaddressed |
| **The dwell belt is exempted by an estimate.** Both belts skip when `d.fromRemaining < POOL_HARD_PCT`, and `fromRemaining` arrives through `estOverlayCache`. In I5's second cascade the raw cache returned `hold` at 6%; only the overlay's last point produced `4.97%`, which both tripped exhaustion **and** released the brake that exists to contain bad switches. | verified at `:1920`, `:1985` | unaddressed |
| **Provenance reaches one panel of four.** `src/lib/usage-source.js` is imported by `src/lib/usage-meter.js` only. Manage Agents — where the owner picks a switch target and decides which login to fix — renders the same donuts with no source, no corroboration, no stale-login warning. | grep: 1 importer | unaddressed |
| **A producer we ship has no name.** `src/usage-routes.js:611,625` writes `source: 'on-demand-remote'`, absent from `usage-source.js`'s table ⇒ every manually-refreshed remote row renders *"Unrecognised reading source — reported verbatim"* about our own writer. | verified | unaddressed |

---

## 2. Root-cause thesis

> **The system MUTATES the binding between a running CLI process and a credential directory, then
> spends money on INFERENCES about what that binding currently is.**

`repointPoolSymlink` (`src/account-material.js`) renames a symlink and bumps the target credential
file's mtime so the CLI re-reads it *on a schedule we do not control*. The fact "which account is
this conversation billing" is therefore unobservable, and four rival derivations grew for it:

| derivation | evidence | lifetime |
|---|---|---|
| `accounts.poolCurrentFor` | readlink | **per call** |
| `observedMemberFor` (OTel) | the org the CLI cached at **spawn** | per record |
| `readingSlotFor` / `rejectionSlotFor` | readlink, **pinned to the turn** | per turn |
| `data/bin/vibespace-usage` | readlink + a `.slot-<sid>` payload fingerprint | one-request lag |

Each of the five fixes taught **one pair** of these to agree. The pairs nobody re-derived kept
diverging — which is exactly why five fixes produced a sixth incident. And one derivation was
never fixed at all:

> **`resolveUsageKey` (`usage-pool-engine.js:489`) resolves COST per RECORD.**
> Its three `noteLive` producers (`claude-stream-json.js:633`, `session-brain.js:95`,
> `usage-pool-engine.js:1647`) each call `kickPoolEval()` on the **next line** — so the producer
> that files record *N* is the thing that moves the link before record *N+1*. That ring feeds
> `_liveDelta` → `_costFn` → `learnRates` → `_persistRates`, i.e. a turn spanning a re-point
> poisons **persisted** `rates.json` for the member that did not spend it.

So within one turn today, a session files its *utilization* on the pinned member and its *dollars*
on whatever the link says at that instant. Readings were pinned for exactly this reason; cost was
not, and nobody noticed there was a third thing to fix.

**The fix is not a sixth pin.** It is to make the answer a durable OBJECT that cannot change under
a running turn — and, because an object can still be wrong (a device sealed-order, a hand edit, a
skewed producer), to give every reading a way to REFUTE its own attribution, and every unattended
turn one ceiling it cannot spend past.

---

## 3. Principles (each is an enforceable invariant)

Every principle names the test that makes it red. A principle with no test is a comment.

| # | Invariant | Enforced by |
|---|---|---|
| **P1** | **One question, one function, one lifetime.** `identityOf(session, at)` is the only thing in the tree that answers session→account — for readings, rejections, cost, fire targets, the ledger and the UI badge alike. | `test-architecture` **derivation census**: any `poolCurrentFor` / pool-link `readlinkSync` / money-path `organization.id` read outside `src/leases.js` + `src/accounts.js` fails the BUILD. File set derived from `git ls-files`, walked set PRINTED. |
| **P2** | **The answer is a RECORD, not a syscall.** A lease is written once with its `from`, so every late question is a lookup, never an inference. | `test-lease-identity`: `identityOf(s, t)` for a past `t` equals the lease that was open at `t`, across a restart. |
| **P3** | **Identity is per PROCESS, not per moment.** A lease opens at spawn and moves only at a **turn boundary**. | `test-turn-boundary-switch`: a re-point attempted mid-turn is queued, not applied; negative control = today's path, which must reproduce I5. |
| **P4** | **One write path.** `src/usage-cache-write.js` is the only way a usage-cache odometer may move. | `test-usage-write-path`: **grep-derived** writer census (over-inclusive by design), prints its set, fails on any bypass. Dead allowlist entries also fail. |
| **P5** | **Every payload must be able to refute its own attribution — and a harness must DECLARE whether it can.** A weekly phase that contradicts a live one is disputed. Codex has no fingerprint and must say so. | `backend-caps` row `quotaWindowFingerprint: 'weekly-phase' \| null` + `test-harness-contract`: no harness may claim a fingerprint the wire does not produce. |
| **P6** | **Ignorance is never a claim.** No prior window = TOFU; unreadable credential file = UNKNOWN. Neither blocks. Only a *contradiction* disputes. | `test-credential-state`: a stat-succeeds-read-fails file must NOT hard-exclude a member; negative control = today's fold, which excludes it and memoizes the exclusion on an mtime that then never changes. |
| **P7** | **An ESTIMATE may never authorize an irreversible act.** It may narrow a choice; it may not trip exhaustion alone, exempt the dwell belt, or open a spend gate. | `test-pool-cascade`: replay I5's timeline; an overlay-derived `fromRemaining` must not bypass the 180s belt. |
| **P8** | **Money gates fail CLOSED, at every layer, and the refusal reaches the user.** | `test-auto-resume-loop`: throw inside the gate ⇒ **zero** fires; negative control = the pre-fix `catch { return true; }` at *both* sites — one alone stays green today. |
| **P9** | **One ceiling, on the IDENTITY.** Every unattended billed turn passes one authorizer with a persisted per-identity budget. | `test-spend-paths`: grep-derived census of everything that can cause an unattended turn; an unwired site is red. |
| **P10** | **Evidence must not be destroyed by our own mechanism.** Nothing may rewrite a credential file's mtime as a side effect; identity keys are MINTED, never scraped from mutable content. | `test-account-pool`: after a lease move the target's credential mtime is unchanged; `test-usage-anchors`: an account's stream key survives a cache write that drops `orgUuid`. |
| **P11** | **A repair whose evidence can improve must not be run-at-most-once.** | `test-migrations`: the readings repair is content-keyed and idempotent across two runs with new rows in between. |
| **P12** | **Fixtures must be able to express the failure.** Every member in a money fixture gets a DISTINCT weekly window, and no assertion may pin a particular attribution ANSWER — only the SHAPE. Every negative control is a **patched copy of the real module** with an assertion that the patch was applied. | `test-readings-attribution`, `test-pool-auto`: today `R5`/`R7` are module constants shared by every member *and* every synthetic reading (`:88`), and `acct()` hard-wires `scopedWeekly.resetsAt === sevenDay.resetsAt` (`:29`) — the defect is literally unrepresentable. |

---

## 4. Target architecture

### 4.1 The one identity model

```
┌─ LEASE (data/leases.jsonl, append-only, day-sharded archive) ───────────────┐
│ { leaseId, sessionKey:'sess-<n>-<ms>', conversationId:<uuid|null>,          │
│   poolId, memberId, credDir, credFingerprint, from, to|null, why }          │
└────────────────────────────────────────────────────────────────────────────┘
        ▲ ONE writer: accounts.js (openLease / moveLease / closeLease)
        │   — the only caller of account-material.repointPoolSymlink
        │   — the device's sealed-orders reflex reports through accounts.noteDeviceLease
        │
        ▼ ONE reader: identityOf(session, at) → {accountId, leaseId, credFingerprint, confidence}
   readings · rejections · COST · fire target · ledger attribution · UI badge
```

The lease is a **promotion of `src/slot-transitions.js`**, not a new invention: that file is 161
lines, already append-only, already single-writer, and already carries the day-sharded rotation
that fixed the same-millisecond overwrite bug. Two upgrades make it authoritative:

- it carries **both id namespaces** (webui `sess-<n>-<ms>` **and** the claude conversation UUID),
  which **deletes** `reading-repair`'s `_sessionKeyMap` filename join rather than maintaining it —
  that join exists only because the two stores are keyed in different namespaces;
- it carries `credFingerprint` (a digest of the token **material**, computed in
  `src/account-material.js`, DEVICE tier, so the daemon bundle carries one implementation). This
  kills the mtime-as-evidence class: `repointPoolSymlink` bumps the target's mtime on **every**
  re-point, and three consumers read that mtime as history (`login-state`'s `since`,
  `reading-repair`'s death markers, `login-expiry-watch`'s `writtenAt`). The engine already
  learned this lesson once for `credsTokenSig` and never converted the others.

The symlink stops being state. It becomes the **materialization** of the current lease, read only
by the boot reconciler and by `moveLease`'s own read-before-write.

### 4.2 The one write path

```
producers ──── envelope {leaseId, payload, producedAt, source} ────┐
  rate_limit_event · limit-banner · wall · control/get_usage       │
  on-demand panel · on-demand-remote · codex rate_limits/rollout   │
  statusline (data/bin/vibespace-usage) · remote harvest           │
                                                                   ▼
                                        src/usage-cache-write.js  writeReading()
                                          ├─ identity  ← lease (never a readlink)
                                          ├─ evidence  ← phase falsifier (caps-gated)
                                          └─ verdict:
                                             proven   → write + stamp {source, evidence, windowId}
                                             unproven → write + stamp evidence:'unproven'
                                             disputed → DO NOT MOVE the odometer;
                                                        append to data/usage-quarantine.ndjson
                                                        with both identities + reason;
                                                        raise a dispute (notice + inbox + broadcast)
```

A producer **declares** its lease id; it never names an account. That is the property that makes
the eighth producer structurally incapable of re-creating the bug.

The **phase falsifier** is defence in depth, not the foundation, and it is declared per harness:

- `backend-caps.quotaWindowFingerprint`: `'weekly-phase'` for claude, **`null` for codex**
  (measured: 53 clusters — its window is rolling), `null` for opencode / shell / `NO_CAPS`.
- It **proves foreign, never proves native**: two members merged into one org share a phase — and
  then they also share a quota, so the misattribution is harmless for the values.
- Closed reason set: `own-window` · `window-rolled` · `no-prior (TOFU)` · `no-window` ·
  `live-window-replaced` · `foreign-phase` · `scoped-window-split` · `sibling-window(<member>)`.
  Only the last three plus `live-window-replaced` are DISPUTES.
- The tolerance is **the same 120s constant `src/usage-estimator.js:132` already uses**, imported,
  not re-declared — two rules for one physical fact is how twins are born.

### 4.3 What is REMOVED

| Removed | Why |
|---|---|
| `resolveUsageKey`, `sessionBillingMember`, `validateBillingSlot`, `wallSlotFor`, `wallKeyFor`, `rejectionSlotFor`, `readingSlotFor`, `fireIdentityFor`'s resolution | Seven answers to one question, two lifetimes. `identityOf` replaces all of them. |
| `session._turnReadingSlot`, the `key`/`slot` fields of `_turnWallSigs` (+ their schema rows) | The pins exist only because the link can move mid-turn. With §4.4 the lease **is** the pin — and a durable one; the in-memory pins die with the process. |
| The identity-group **sibling write fan-out** (`rate-limit-capture.js:155-163`) | It applies a bucket to every sibling file *without* its `fetchedAt`, which is why `__global__.json` is a live chimera of three accounts under a 6-hour-stale stamp — and `poolReadCache` then lets the group's "freshest" file decide a pool member's quota. A group becomes a **read-time view**; a view cannot rot. |
| The statusline `.slot-<session_id>` fingerprint sidecar + its one-request-lag logic | It exists only because the link moves. It also has **zero production coverage here** (`VIBESPACE_ACCOUNT_LINK` is injected only for local claude *terminal* sessions; every pooled session on this instance is chat, and no `.slot-*` file has ever been created). |
| The `utimesSync` bump in `repointPoolSymlink` | Nothing re-reads mid-turn any more, and it is the mechanism that destroyed the repair's evidence. **Must not land before §4.4**, or hot switching stops working while still being attempted. |
| `slotAt`'s time-join oracle, `_sessionKeyMap`, `ownLinkUnknown` | Superseded by a lease carrying both ids. |
| The OTel **money path** (`observedMemberFor`, `corroborateReading`, the `usageIdentityAccountIds` expansion inside `demoteWalledAccount`, the `corroborated` label plumbing) | `organization.id` names the **spawn** identity; it has been measured wrong and refuted twice, and the "token stale ≥25 min" forensic that justified it was performed *through the channel it was validating*. It fires ~150×/hour here and is consumed by one tooltip. |
| The single-client cold-restart loop (`usage-pool-engine.js:2018`, `for (...) { …; break; }`) | Replaced by a server-side executor (§4.4b). |

### 4.4 What is ADDED

**(a) Turn-boundary lease moves.** A lease may open or move only when the session has no turn in
flight — the boundary each stdout consumer already declares (`noteTurnEnd`). A switch decided
mid-turn is RECORDED as pending and applied at the boundary. A **hard escape** (dead login, or a
hard-exhausted current member) still moves immediately and records why.

> **Rejected: mint-once binding + respawn.** It reaches the same guarantee, but requires killing
> and respawning the conversation to change accounts — a full context re-send priced at ~$19 for
> one large session on this instance, ×9 concurrent conversations, on every switch. A turn
> boundary closes the in-flight window *just as structurally* (nothing is in flight at a boundary)
> while preserving the capability six subscriptions were bought for. Deleting mid-conversation
> switching is a product decision, not a hardening. → §6 D1.

**(b) A server-side rebind executor** (`src/server/rebind.js`). The four re-point call sites emit
`rebindRequest{sessionId, from, to, reason, at}`; the executor applies it at the boundary and
broadcasts to **all** clients. This is not optional: codex is `hotSwitch:'impossible'`, so every
codex account change is a cold restart, and today that restart is delivered to at most one
connected browser while the notice says *"restarting its conversations"* unconditionally.

**(c) The spend authorizer** (`src/spend-authorizer.js`, PURE + `data/spend-budget.json`):

```
authorizeUnattendedSpend({reason, sessionId, identity, quotaView, credentialState,
                          budgetState, overage, now}) → {ok, why, retryAfter, notice}
```

Refuses when: identity unknown/unproven · credential state not `serves:'yes'` · quota unknown ·
**overage in use** (real dollars) without explicit opt-in · the rolling per-identity or
per-instance budget is spent. Counters persist across restarts. All seven producers call it —
auto-resume, the Stop nudge, Background-Work notifications, agent messages, the goal loop, the CI
probes, codex reset-credit — and their existing local floors stay as UX niceties.

**(d) Ledger ↔ OTel aggregate reconciliation** (`src/server/usage-reconcile.js`). Every 5 min,
join `otel-truth.ndjson` against the ledger's totals **on the ledger's own rid key**, per identity,
reporting the delta *and the coverage*. Zero vendor calls — the CLI pushes these to our own
loopback receiver.

> **Rejected: deleting the OTel receiver.** The 2026-09-07 refutation was about **routing one
> reading**; it does not invalidate an aggregate cross-check. This is the only measurement that
> still works on a harness with **no window fingerprint** — i.e. on codex — and it is the only
> thing that would surface the contradiction the audit found (97.9% of the month's ledger booked
> to two members while three others' own `/usage` panels read 0.99 / 0.95 / 0.55).

**(e) A re-runnable, content-keyed repair.** The evidence rung becomes the lease ledger + the
falsifier; `deathMarkers` (the wiped-mtime rung) is deleted. It **marks and quarantines, never
deletes**, runs on the ledger tick, and REPORTS what it repaired versus what it could not date —
so "repaired 2 of 464" can never again be mistaken for success. Schema migrations keep
run-at-most-once; only evidence-based repairs change.

**(f) Two build-time censuses** (P1, P4) plus a **fixed session-schema detector**: widen
`/(session|sess)\._x\s*=/` to any identifier, and register the 8 fields it currently misses —
including `s._lastStopNudge`, the sole rate limiter on the largest measured automatic spender.

**(g) Provenance where the decision is made.** Wire `src/lib/usage-source.js` into
`src/lib/manage-agents.js` and `usage-window.js`; add `evidenceNote` / `disputeText`; name
`on-demand-remote`; replace the enumerated source assertion with a **census** (every string
literal assigned to a `source` field must appear in the table).

### 4.5 How a new producer / consumer is prevented by construction

| Failure mode | Structural block |
|---|---|
| A new producer names an account itself | It has no way to. It declares a `leaseId`; `writeReading` resolves. |
| A new producer writes the cache directly | `test-usage-write-path` (grep-derived) fails the build. |
| A new consumer re-derives session→account | `test-architecture` derivation census fails the build. |
| A new backend inherits a guard it does not have | `quotaWindowFingerprint` must be DECLARED; `NO_CAPS` says `null`, so the falsifier is off and the boundary rule + reconciler carry it. |
| A new unattended-spend path forgets the ceiling | `test-spend-paths` (grep-derived) fails the build. |
| A shipped tool predating the change sends no lease | `confidence:'unknown'` ⇒ quarantine + telemetry, **never a guess**. Capability-gated off the wrapper sidecar caps, exactly as frame-file was. |
| A fixture makes the defect unrepresentable | P12: distinct windows per member; negative controls are patched copies of the real module with an applied-assertion. |

---

## 5. Phased plan

Five phases. Each is independently shippable and reversible; **nothing destroys a store**.

### P0 — MEASURE (dark; no behaviour change)

Shadow the phase falsifier at every write (telemeter, stamp, change nothing) · shadow
`slot-vs-lease` divergence at all five resolvers, split by caller so the **unpinned cost**
resolver is measured separately · shadow the lease record beside the symlink · the two censuses ·
the schema detector · the fixture fixes (P12) · name `on-demand-remote`.

**Gate:** one soak week. Four numbers before anything may refuse: divergence by resolver, disputes
by producer, rebinds per pool per hour, and — the empirical answer to the standing contradiction
in this codebase (the mtime-re-read rationale vs the 2.361.0 forensics of a process billing its
spawn org for 35 minutes across four switches) — **whether a re-point reaches a running CLI at
all**. If it does not, §6 D1 answers itself.

### P1 — ONE WRITE PATH

`src/usage-cache-write.js` + the four writers rewired · falsifier ENFORCING (quarantine) ·
`quotaWindowFingerprint` caps row · delete the sibling fan-out · mint stable identity ids and
re-key anchor streams.

**Gate:** `test-usage-write-path` green with its printed census covering all known writers; no
regressions in `test-rate-limit-capture` / `test-usage-anchors`; quarantine rate inside the P0
envelope.

### P2 — ONE IDENTITY

`src/leases.js` (promoting `slot-transitions.js`) · `credFingerprint` · `identityOf` delegating to
the old bodies **behind a flag** with the divergence counter still running · turn-pin cost · then
the deletion commit for the seven resolvers and the two pins.

**Gate:** divergence counter identically **0** over a soak; `test-architecture` derivation census
allowlist down to `src/leases.js` + `src/accounts.js` — that emptiness *is* the completeness proof.

### P3 — THE BOUNDARY

Turn-boundary-only lease moves (hard escapes exempt) · `src/server/rebind.js` server-side executor
· belt exemption requires a MEASURED reading · both money gates fail closed · NEAR_MS becomes a
lease-open precondition instead of an unreachable float tiebreak.

**Gate:** `test-turn-boundary-switch` + `test-pool-cascade` green with pre-fix negative controls
reproducing I5; a switch delivered with **zero** websocket clients connected.

### P4 — BOUNDED SPEND & HONEST SURFACES

The spend authorizer + budget + overage gating + EDF reserve floor + rebind budget ·
`usage-reconcile` · the re-runnable repair · provenance in Manage Agents · promote the ungated
money suites (`test-creds-symlink-swap` — rewritten to call the real primitive —
`test-sealed-orders`, `test-workflow-usage-tailer`, `test-remote-attribution`, `test-usage-link`).

**Gate:** `test-spend-paths` green; the repair's report reconciles against the P0 census.

### 5.1 The tests that would have caught each incident

| # | Test | Negative control (must reproduce the incident) |
|---|---|---|
| **I1** | `test-lease-identity` §fire: a rejection arrives, the pool decides a switch; assert the link does not move before the boundary, the fire target and the rejecting identity are **one object**, and the breaker quarantines the member that actually refused. Plus: a `result:is_error` turn must NOT clear the breaker. | A patched copy restoring the fresh `wallKeyFor` resolution ⇒ ≥10 unbounded fires, wrong member quarantined. *(The shipped suite instead **asserted** the loop, verbatim.)* |
| **I2** | `test-reading-fingerprint`: every fixture member gets a **different** phase (impossible today, `:88`); drive the real producers across a switch; assert every anchor's phase matches its filed account. Plus a corpus leg over a copy of `data/usage-anchors` asserting **zero** foreign. | The pre-choke-point writer ⇒ N foreign anchors. |
| **I3** | `test-credential-state`: (a) a source census asserting exactly **one** exported credential-state reader; (b) a member with both tokens expired but `parseAuth().loggedIn` true can never be a lease-open target; (c) a stat-succeeds-read-fails file is UNKNOWN, not dead. | Today's fold, which hard-excludes it and memoizes the exclusion on an mtime that then never changes. |
| **I4** | `test-login-warnings` §retract, **fingerprint-keyed**: rotate the token material, assert every open claim about the old fingerprint is retracted; assert it survives a restart; assert a same-fingerprint rewrite retracts nothing; assert two same-named accounts do not share one inbox item id. | The pre-fix three-clause `reloggedIn` heuristic, which cannot fire when the new credential lands with no readable deadline. |
| **I5** | `test-turn-boundary-switch`: **re-point first, then** deliver the turn's first reading — the ordering the existing §3 does not cover, because it delivers a reading first and the lazy pin is already set. Plus `test-pool-cascade` replaying I5's exact timeline and asserting **at most one** switch. | Today's mid-turn re-point ⇒ the 13%→93% jump; the pre-fix engine ⇒ all four switches in 4m40s. |
| **all** | The three grep-derived censuses (derivations, cache writers, spend paths) + P12's anti-pinning rule. | Three gate suites pinned the refuted routing with **source regexes** for 14–19 days, so the correct fix could not land without editing the tests. Pin the SHAPE, never the ANSWER. |

---

## 6. Owner decisions

**D1 — Mid-turn switching.** (a) keep as-is; (b) **turn-boundary moves, hard escapes exempt**;
(c) mint-once + respawn.
→ **Recommend (b).** It closes the in-flight class structurally at a fraction of (c)'s cost and
keeps the capability. Cost: a voluntary escape waits up to one turn. P0 measures whether (a) ever
worked; if it did not, (b) is strictly a gain.

**D2 — EDF above 90%.** Should EDF stop draining the soonest-deadline member at a reserve floor?
Today the only stop is the 8% settle bar, `test-pool-auto:85-88` **pins** an 88%-consumed member
as a valid target, and the measured behaviour is 60%→95% in 12.4h.
→ **Recommend a floor (suggest 15% weekly)** for VOLUNTARY switches only; escapes ignore it. This
changes a deliberately pinned, user-requested invariant, so it is yours.

**D3 — Overage / pay-per-use.** (a) surface only; (b) **surface + refuse all unattended spend
while `overage.inUse`**; (c) (b) + the pool avoids an overage-enabled member; (d) a dollar cap.
→ **Recommend (b) now, (c) after one week of data.** With overage on, utilization stays under 1
while every token is billed, so the EDF ranking actively *prefers* the account spending money. The
numbers already exist and have zero consumers.

**D4 — Subscription credentials on remote hosts.** `accounts.shipSubscriptionToRemote` is
default-off, but a `claude setup-token` **oat** rides the env channel to ssh and dial hosts with
the ship gate explicitly not firing. (a) keep; (b) **bring oat under the same gate and the same
authorizer, keep default-off**; (c) block entirely.
→ **Recommend (b).** The ban-postmortem risk is a subscription-derived token on a datacenter IP;
the oat reaches the same IPs without passing the gate built for that risk. The loss there is not a
turn, it is the subscription.

**D5 — Disputed-member policy.** (a) keep as a candidate on its last PROVEN reading; (b) **not a
switch TARGET and no unattended spend, but it keeps serving its own conversation**; (c) fully
ineligible.
→ **Recommend (b).** (a) lets a genuinely burning account keep being chosen; (c) can freeze the
pool. Quarantine clears on the next self-naming panel read.

**D6 — Unattended spend budget.** Proposal to react to: **12 turns/hour and 60/day per identity,
200/day per instance**, notice at 80%, owner-typed turns never counted.

**D7 — Implicit pool membership.** This instance's only pool is `members:null` and is the default
account, so every newly logged-in subscription instantly becomes a target for every live
conversation — while `_healPoolsAfterRemoval` refuses to widen an explicit list *because widening
is dangerous*.
→ **Recommend: convert to an explicit list at migration (today's members grandfathered) +
`autoEnrol:false`.** Never silently empty a pool on upgrade.

**D8 — The Stop nudge.** (a) leave; (b) **persist its cooldown and put it under the authorizer**;
(c) opt-in per task group.
→ **Recommend (b)**, and add an exit condition: a session with no status record at all is
currently nudged forever.

**D9 — Re-repair authority.** May the new content-keyed repair MARK (never delete) the ~464
foreign anchors the one-shot could not see, which are still training `rates.json`?
→ **Recommend yes** — marking is reversible and the alternative is permanent poisoning.

**D10 — Sealed orders.** The device reflex is argued structurally dead (argv-substring match
against chat-only pipe metas; the link env is terminal-only) and its suite is outside the gate.
(a) fix it so it can fire; (b) **re-scope to "the device may REFUSE to keep spending"**;
(c) delete and stop shipping every member's credential paths on each 30s tick.
→ **Recommend (b)**, since a device re-pointing credentials is incompatible with the boundary rule
either way. Requires sign-off: it was never exercised in either direction.

**D11 — The OTel receiver.** Its money path goes regardless. (a) **keep as the aggregate
reconciler (§4.4d)**; (b) keep as a debug store; (c) delete.
→ **Recommend (a).** It is the only cross-check that works where the fingerprint does not.

**D12 — Codex pools.** No fingerprint (53 clusters), `hotSwitch:'impossible'` (always cold), and
today the restart needs an open browser. (a) **keep, protected by the boundary rule + the
server-side executor + reconciliation**; (b) declare unsupported until (a) ships.
→ **Recommend (a)**, sequenced so P3 lands before any codex pool is created.

---

## 7. What stays as-is, and why

| Kept | Reason |
|---|---|
| **§ban-safety, byte for byte.** | Every mechanism here computes from bytes we already hold: the phase is in a payload we receive passively, the reconciliation is our own loopback stash, the lease is our own file. `scripts/test-vendor-whitelist.mjs` must remain **unchanged** — if a change to it is needed, this design is wrong. |
| **auto-cli `claude -p /usage` as the trust anchor.** | It is the one producer where the cache key and `CLAUDE_SECURESTORAGE_CONFIG_DIR` are ONE decision, so it is the only self-naming reading and the only thing that can clear a dispute. Its burn-aware wandering cadence is unchanged. *(Caveat: two mid-August `on-demand` anchors carry a foreign phase, so the bootstrap rule needs an explicit tie-break rather than blind trust.)* |
| **EDF as the ranking policy.** | Quota is perishable; draining the soonest-expiring window first is the owner's deliberate choice. Only its DEPTH (D2) and the trustworthiness of its inputs are in scope. |
| **The 180s dwell belt and the settle bar.** | Correct anti-oscillation. Only the *exemption* changes: it must be earned by a measured reading (P7). |
| **The loop breaker's local floors** (`FIRE_QUARANTINE_MS`, the 30s peer-pair floor, identical-text dedup, quiet-success). | Good UX rate-limiting. They stop being the *money* bound; the authorizer becomes that. |
| **`login-expiry` + `login-state` merged, but both vocabularies preserved on the record.** | The merge is required (P6) so "disputed" and "unusable" share one language; no caller may lose information. |
| **Plan C per-session links.** | The granularity is right — an opus conversation and a fable conversation *should* be able to bill different members. What changes is *when* a link may move, not that it exists. The measured herd behaviour (nine sessions moving at the same millisecond) is a symptom of shared inputs, not of plan C. |
| **`repointPoolSymlink`'s lstat guard + atomic rename.** | Correct. Only the `utimesSync` side effect goes, and only after §4.4. |
| **Remote / oat / codex spawn-time binding.** | Remote sessions tar credentials at spawn; oat rides env; codex canonicalizes `CODEX_HOME` at startup. All three are **already** immutable-per-process — this design makes local claude stop being the exception, rather than making it the special case everyone else has to be checked against. |
| **Schema migrations run-at-most-once.** | Only *evidence-based repairs* become re-runnable (P11). Reshaping a store twice is a different hazard. |
