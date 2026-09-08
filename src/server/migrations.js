'use strict';
// LOCAL MIGRATION REGISTRY (2.328.0, plan B step 1): the instance's one-shot
// data migrations, run at boot BEFORE restoreSessions through the SHARED
// runner (src/migration-runner.js — the daemon runs its own registry through
// the same runner device-side). Ledger: data/migrations.json. Add new
// migrations APPEND-ONLY with a dated id; never edit a shipped one (instances
// that already ran it will not re-run — ship a follow-up instead). Pattern:
// archive, then strip — never destroy.
const fs = require('fs');
const path = require('path');
const { runMigrations } = require('../migration-runner.js');

function create({ rootDir, serverNotice }) {
  const dataDir = path.join(rootDir, 'data');
  const archiveDir = path.join(dataDir, 'archive');

  const MIGRATIONS = [
    {
      id: '2026-08-collapse-kinds-agent-default',
      note: "chat.collapseKinds saved before the 'agent' kind existed (2.368.19) cannot distinguish 'user unchecked it' from 'the option predates the save' — codex collab cards (Agent Wait, send_message…) broke every fold on instances with ANY saved selection (owner report). Add the default-on kind once; unticking it afterwards sticks.",
      run() {
        const f = path.join(dataDir, 'settings.json');
        let doc; try { doc = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return; }
        const v = doc['chat.collapseKinds'];
        if (!Array.isArray(v) || v.includes('agent')) return;
        v.push('agent');
        fs.writeFileSync(f + '.tmp', JSON.stringify(doc, null, 2));
        fs.renameSync(f + '.tmp', f);
      },
    },
    {
      id: '2026-09-reattribute-readings-by-slot',
      note: 'quota readings were keyed by the OTel-observed org = the identity the CLI cached at SPAWN, so after any pool hot switch a session\'s readings were filed under the account it started on. Re-attributes or archives (never silently keeps) the provably-foreign entries in usage-cache / usage-anchors / attribution.ndjson, and drops the learned rates so the estimator re-learns from the cleaned anchors.',
      run() {
        const { repairReadings, findJournal } = require('../reading-repair.js');
        const { SlotTransitions } = require('../slot-transitions.js');
        // The members whose credential files can date their own death. Read
        // straight off disk: this runs BEFORE restoreSessions and must not
        // depend on a booted AccountManager (a migration that needs the app
        // running is a migration that cannot repair a broken app).
        const subsDir = path.join(dataDir, 'subs');
        const members = [];
        let names = [];
        try { names = fs.readdirSync(subsDir); } catch { return; }
        // A member's credential DIR is only half its login (2026-09-07 r2): an
        // account with a wiped dir and a valid LONG-LIVED TOKEN still spawns
        // (`oatOnly`) and still produces readings under its own key, so
        // enumerating members from disk alone dated a live account's "death"
        // from the wipe and archived everything it wrote afterwards. Read the
        // roster for `oatMintedAt` — presence + timestamp only, the encrypted
        // token is never touched (and this migration still runs before any
        // AccountManager exists).
        const oatMinted = (() => {
          const out = {};
          try {
            const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf-8'));
            for (const a of (st?.accounts || [])) if (a && a.id && a.oatEnc && a.oatMintedAt) out[a.id] = Number(a.oatMintedAt) || 0;
          } catch { }
          return out;
        })();
        for (const d of names) {
          if (!/^sub-[\w-]+$/.test(d)) continue;                  // pools are symlinks, con-* are login scratch
          try { if (fs.lstatSync(path.join(subsDir, d)).isSymbolicLink()) continue; } catch { continue; }
          members.push({ id: d, backend: 'claude', credsPath: path.join(subsDir, d, '.credentials.json'), oatMintedAt: oatMinted[d] || null });
        }
        const transitions = new SlotTransitions({ dataDir });
        let journalText = null;
        const jf = findJournal(dataDir);
        if (jf) { try { journalText = fs.readFileSync(jf, 'utf-8'); } catch { } }
        const rep = repairReadings({ dataDir, members, transitions, id: '2026-09-reattribute-readings-by-slot', journalText });
        const touched = (rep.caches?.foreign || 0) + (rep.anchors?.dropped || 0) + (rep.attribution?.foreign || 0);
        // Say what happened even when it is nothing — a repair nobody can see
        // ran is a repair nobody can verify ran.
        console.log('[migrate] readings-by-slot:', JSON.stringify({
          members: rep.markers.length, journal: rep.journal,
          caches: rep.caches, anchors: rep.anchors, attribution: rep.attribution,
        }));
        if (touched) {
          try {
            serverNotice?.('readings-repaired', `Quota bookkeeping repaired: ${touched} reading(s) that belonged to another account were archived to data/archive/ (a pool hot switch had filed them under the account each session started on). Panels and the usage estimator re-derive from the cleaned data.`, { level: 'info' });
          } catch { }
        }
      },
    },
    {
      id: '2026-09-refile-readings-by-window-v2',
      note: "the readings-by-slot repair could only act where a member's own credential file DATED its death — one member on this instance — so every reading mis-filed BETWEEN TWO LOGGED-IN accounts survived it (its own header calls that the silent half). A weekly reset is an account fingerprint, so those entries can be proven foreign and re-filed by their window: re-attributes or archives-with-a-reason the anchors whose weekly phase is not their stream's, rescues a cache snapshot carrying another account's window, drops the learned rates, and SEEDS each account's own window so the live window guard is armed on this boot instead of on the next panel refresh. Since r4 it moves PER BUCKET — an anchor is a snapshot of a usage-cache FILE and that file has two writers, so a mis-keyed reading leaves a record that is itself a MIX (another account's 7d on top of this stream's own model-scoped bucket); measured on a copy of this instance, 444 of the 476 re-files were that shape, and moving them whole wrote another member's Fable bucket into the target's cache, which is what accountRemaining / weeklyDeadline / bucketRems read. Since r6 it also judges the machine login's SECOND snapshot, data/usage-cache.json — the boot seed of _rateLimitCache, which is not in the usage-cache directory the repair walks and, because a rebuild rewinds fetchedAt, is guaranteed to win ingestPassiveUsage's newest-wins merge for both the machine-login row and the named subscription of the same quota.",
      run() {
        const { repairByWindow } = require('../reading-repair.js');
        // Candidates to RECEIVE a re-filed reading are the CURRENT roster: a
        // removed subscription cannot hold readings, and on this instance a
        // removed account shares a live one's weekly phase — counting it would
        // make every genuinely re-filable entry ambiguous. Read straight off
        // disk (this runs before any AccountManager exists).
        let roster = null, accounts = null;
        try {
          const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf-8'));
          // The RECORDS as well as the ids (r5): resolving a usage-cache FILE
          // to its identity is `usageIdentityGroups`' job, and that reads the
          // record's backend (a ChatGPT and an Anthropic login sharing an email
          // must never merge), its type (a pool holds no quota of its own) and
          // its declared email. Handing over only ids would make this
          // migration's map a second, weaker spelling of the engine's.
          accounts = (st?.accounts || []).filter((a) => a && a.id);
          roster = accounts.filter((a) => a.type === 'subscription').map((a) => a.id);
        } catch { }
        const rep = repairByWindow({ dataDir, roster, accounts, id: '2026-09-refile-readings-by-window-v2' });
        const a = rep.anchors, c = rep.caches;
        console.log('[migrate] readings-by-window:', JSON.stringify({
          identities: rep.identities.length, receivers: rep.identities.filter((x) => x.canReceive).length,
          anchors: a, caches: c,
          // the machine login's SECOND snapshot (data/usage-cache.json, the
          // boot seed of _rateLimitCache) — not in the usage-cache directory,
          // and newer than anything the repair rebuilds there, so a foreign
          // window left in it wins the newest-wins merge for BOTH panel rows
          globalFile: rep.globalFile, globalFileWhy: rep.globalFileWhy,
        }));
        // A dropped BUCKET is its own repaired thing: 443 of this instance's 444
        // partial moves carry no whole-record action at all, so counting only
        // records would report "nothing happened" about the half of the repair
        // that touches the model caps the pool decides on.
        const touched = (a?.refiled || 0) + (a?.archived || 0) + (a?.stripped || 0) + (c?.foreign || 0) + (c?.scopedStripped || 0) + (rep.globalFile === 'archived' ? 1 : 0);
        if (touched) {
          try {
            serverNotice?.('readings-window-repaired', `Quota bookkeeping repaired: ${touched} reading(s) whose usage window belongs to a different account were re-filed, split or archived to data/archive/ (a pool switch had filed them on the account a session was pointed at, not the one whose credentials answered). Panels and the usage estimator re-derive from the cleaned data.`, { level: 'info' });
          } catch { }
        }
      },
    },
    {
      id: '2026-08-archive-dormant-task-plans',
      note: 'dormant checklist plan arrays (feature removed 2.121.0) → data/archive/',
      run() {
        const f = path.join(dataDir, 'task-groups.json');
        let doc; try { doc = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return; } // no store yet = nothing to do
        const tasks = doc.tasks || {};
        const archived = {};
        for (const [id, t] of Object.entries(tasks)) {
          if (t && Array.isArray(t.plan) && t.plan.length) { archived[id] = t.plan; delete t.plan; }
          else if (t && 'plan' in t) delete t.plan;
        }
        if (!Object.keys(archived).length) return;
        fs.mkdirSync(archiveDir, { recursive: true });
        const out = path.join(archiveDir, 'task-plans-legacy.json');
        let prev = {}; try { prev = JSON.parse(fs.readFileSync(out, 'utf-8')); } catch { }
        fs.writeFileSync(out + '.tmp', JSON.stringify({ ...prev, ...archived }, null, 2));
        fs.renameSync(out + '.tmp', out);
        fs.writeFileSync(f + '.tmp', JSON.stringify(doc, null, 2));
        fs.renameSync(f + '.tmp', f);
      },
    },
  ];

  function runLocalMigrations() {
    const results = runMigrations({ ledgerPath: path.join(dataDir, 'migrations.json'), migrations: MIGRATIONS });
    for (const r of results) {
      if (r.status === 'failed') {
        try { serverNotice?.('migration-failed:' + r.id, `Data migration ${r.id} failed (${r.error}) — will retry on next restart.`, { level: 'warn' }); } catch { }
      }
    }
    return results;
  }

  return { runLocalMigrations, MIGRATIONS };
}

module.exports = { create };
