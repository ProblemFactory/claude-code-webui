# machine-global fixture shapes (2026-09-07 round 2)

The negative controls for `machineGlobalFixtures` (scripts/ci.mjs), used by
scripts/test-ci-gate.mjs §6.

They live in files rather than inside the suite for a reason the suite found on
its first run: §6 scans **every fast-tier suite's source** for these shapes, and
test-ci-gate is itself a fast-tier suite — so a verbatim `const PORT = 3991`
control inside it made the suite report *itself* as an offender. A control has
to be readable as data, not as a claim.

- `flagged.js.txt` — the shapes that caused the incident: the pre-fix
  test-attach-ack (a fixed port it binds, a fixed /tmp path it checks a worktree
  out into and force-removes) and a literal bound to a name that is later
  listened on. Every one of these MUST be detected.
- `clean.js.txt` — the shapes that replaced them, plus the two that must never
  be flagged: a `/tmp` string that is only a fixture VALUE, and a lowercase
  `port:` config field (nothing binds it). None of these may be detected.
