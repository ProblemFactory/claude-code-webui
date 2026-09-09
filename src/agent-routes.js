/**
 * Agent-facing routes — extracted verbatim from server.js (2.92.0 split).
 * Everything the vibespace-* CLI tools and the harness hooks talk to:
 * user-todo (vibespace-ask), session-status (vibespace-status), the context
 * injection endpoints (task-context / prompt-context, incl. the user preamble
 * + per-turn extras), the stop-check nudge arbiter, and the vibespace-task
 * progress endpoints. Injection ORDER + SIZE are load-bearing — read the
 * CLAUDE.md notes on renderContext/persisted-output before touching payloads.
 */
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function setupAgentRoutes({ app, activeSessions, tasks, sessionStatus, SessionStatusManager, userTodos, sessionStatusKey, serverSetting, spendGuard = null, integrationEnabled, scheduleCtxSync, remoteCtxBaseFor, readUserState, getJobs, deliver, getPublishedPages = () => null, getDesignKit = () => null }) {
app.post('/api/agent/user-todo', (req, res) => {
  const hit = agentSession(req, res);
  if (!hit) return;
  if (!toolOn('Ask')) return toolDisabled(res, 'vibespace-ask');
  const [s, id] = hit;
  const key = sessionStatusKey(s, id);
  if (!key.startsWith('webui:')) userTodos.rekey(`webui:${id}`, key); // migrate early items once the real id exists
  const { add, list, resolve } = req.body || {};
  try {
    if (list) return res.json({ success: true, sessionKey: key, items: userTodos.forSession([key, `webui:${id}`]) });
    if (resolve) return res.json({ success: true, item: userTodos.resolveByAgent(key, resolve) });
    if (add && add.text) {
      const item = userTodos.add(key, { text: add.text, detail: add.detail, urgency: add.urgency, by: 'agent', sessionName: s.name || null });
      return res.json({ success: true, item });
    }
    res.status(400).json({ error: 'pass {add:{text,...}} | {list:true} | {resolve:"id or text"}' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/session-status', (req, res) => res.json({ statuses: sessionStatus.snapshot() }));
// User set/override/clear from the UI (cookie-authed like every route)
app.post('/api/session-status', (req, res) => {
  const { sessionKey, state, urgency, reason, clear } = req.body || {};
  if (!sessionKey || typeof sessionKey !== 'string') return res.status(400).json({ error: 'sessionKey required' });
  try {
    const rec = clear ? sessionStatus.clear(sessionKey, 'user') : sessionStatus.setByUser(sessionKey, { state, urgency, reason });
    res.json({ success: true, status: rec });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Agent endpoint — authenticated ONLY by the per-session token spawned into
// the agent's env (VIBESPACE_SESSION_TOKEN); exempt from cookie auth in
// auth.middleware. The token scopes writes to the agent's own session.
app.post('/api/agent/session-status', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.body?.token;
  if (!token || !token.startsWith('vsst_')) return res.status(401).json({ error: 'missing session token' });
  let found = null, foundId = null;
  for (const [id, s] of activeSessions) { if (s.agentToken === token) { found = s; foundId = id; break; } }
  if (!found) return res.status(401).json({ error: 'unknown session token' });
  if (!toolOn('Status')) return toolDisabled(res, 'vibespace-status');
  const key = sessionStatusKey(found, foundId);
  // migrate an early webui:<id> record once the real backend id exists
  if (!key.startsWith('webui:')) sessionStatus.rekey(`webui:${foundId}`, key);
  const { state, urgency, reason, detail, clear, show } = req.body || {};
  // Waiting states are USELESS on the board without a reason the user can act
  // on — reject them (the error text teaches the fix at the point of use).
  // Grace: a follow-up tweak (e.g. bumping --urgency) on a record that already
  // carries a reason for the SAME state passes without re-sending it.
  const WAITING = new Set(['blocked', 'needs-input', 'review']);
  if (!show && !clear && WAITING.has(state) && (!String(reason || '').trim() || !String(detail || '').trim())) {
    const existing = sessionStatus.get(key);
    const existingComplete = existing && existing.state === state
      && String(existing.reason || '').trim() && String(existing.detail || '').trim();
    if (!existingComplete) {
      return res.status(400).json({ error: `"${state}" needs BOTH a one-line --reason (what you're waiting on) AND --detail (full context: options, what you tried, your recommendation) — e.g. vibespace-status ${state} --reason "waiting for the API key" --detail "Deploy needs OPENAI_API_KEY; .env and 1Password checked, not there. Recommend the user paste it in chat." [--urgency high]. Then say it in chat and mirror it with vibespace-ask.` });
    }
  }
  try {
    const rec = show ? sessionStatus.get(key)
      : clear ? sessionStatus.clear(key, 'agent')
      : sessionStatus.setByAgent(key, { state, urgency, reason, detail });
    res.json({ success: true, sessionKey: key, status: rec });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Status-change history for the expanded card's timeline. Accepts a comma
// list of keys (backend:id + webui:<serverId> placeholder) — first hit wins.
app.get('/api/session-status/history', (req, res) => {
  const keys = String(req.query.sessionKey || '').split(',').filter(Boolean);
  for (const k of keys) {
    const h = sessionStatus.history(k);
    if (h.length) return res.json({ history: h });
  }
  res.json({ history: [] });
});
// Resolve the calling agent's session from its per-session bearer token.
// Returns [session, id] or replies 401/403 and returns null.
function agentSession(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.body?.token;
  if (!token || !token.startsWith('vsst_')) { res.status(401).json({ error: 'missing session token' }); return null; }
  for (const [id, s] of activeSessions) {
    if (s.agentToken === token) return [s, id];
  }
  res.status(401).json({ error: 'unknown session token' });
  return null;
}
// Resolve which Task Group a vibespace-task call targets. Belonging is LIVE-
// derived (groupsForSession — explicit tag / auto-include folder / spawned-into
// group), so a UI bind takes effect with no respawn. Isolation is ENFORCED: an
// explicit --group must be one this session belongs to. 0 groups → 403; >1
// without --group → 400 (agent must disambiguate). Returns a group id or null
// (and has already replied).
function resolveAgentGroup(hit, req, res) {
  const [s, id] = hit;
  const key = sessionStatusKey(s, id);
  const groups = tasks.groupsForSession({ sessionKey: key, cwd: s.cwd, initialGroupId: s._initialGroupId });
  const want = String(req.query?.group || req.body?.group || '').trim();
  if (want) {
    const g = groups.find((x) => x.id === want);
    if (g) return g.id;
    // A designated Group MANAGER may target ANY group by explicit --group
    // (2.152.0, user directive: manager scope = ALL groups, not belonging) —
    // so a manager can log progress / park backlog / read `show` anywhere.
    if (isManagerSession(key)) {
      try { tasks.get(want); return want; }
      catch { res.status(404).json({ error: `no Task Group ${want} (run \`vibespace-task group-list\`)` }); return null; }
    }
    res.status(403).json({ error: `this session does not belong to Task Group ${want}` });
    return null;
  }
  if (!groups.length) {
    res.status(403).json({ error: 'this session is not in any Task Group' + (isManagerSession(key) ? ' — as a Group manager, target one explicitly: --group <id> (see `vibespace-task group-list`)' : '') });
    return null;
  }
  if (groups.length === 1) return groups[0].id;
  res.status(400).json({ error: `this session belongs to ${groups.length} Task Groups — pass --group <id> (one of: ${groups.map((g) => g.id).join(', ')})` });
  return null;
}
// A designated GROUP MANAGER (2.132.0 double gate: global setting + the
// per-session Session-Properties toggle stored in user-state). Shared by the
// group-admin route, resolveAgentGroup's explicit-group bypass, and context
// injection (which teaches the manager its powers). Both reads are cached
// (serverSetting / persistence readUserState), so per-prompt calls are cheap.
// A webui:<id> key (backend id not yet adopted) is never a manager — the
// toggle is stored under the backend:backendSessionId form.
function isManagerSession(key) {
  if (!serverSetting('agents.allowGroupManagement')) return false;
  if (!key || key.startsWith('webui:')) return false;
  const us = (readUserState && readUserState()) || {};
  return ((us.sessionConfigs || {})[key] || {}).groupManager === true;
}
// Taught ONCE to a designated manager session (2.152.0, user directive: the
// manager must LEARN its powers in context — before this, nothing ever told
// the agent it was a manager). Discovery-layer style: trigger + copy-ready
// invocation per verb; details live in the CLI's own no-args usage.
const MANAGER_INTRO = [
  '<vibespace-group-manager>',
  'The user designated THIS session a Task Group MANAGER: you may organize ALL Task Groups on this VibeSpace — not just the ones this session belongs to. Every admin op is audited into that group\'s activity log under your session key.',
  'See every group (id, title, archived, session count) — always check before creating, to avoid duplicates:',
  '```',
  'vibespace-task group-list',
  '```',
  'Create or reconfigure a group:',
  '```',
  'vibespace-task group-create --title "..." [--objective "..."] [--context-dir ~/path] [--folder ~/path]',
  'vibespace-task group-update <id> [--title "..."] [--objective "..."] [--context-dir ~/path] [--archived true|false]',
  '```',
  'Bind / unbind a session (omitting --session means THIS session):',
  '```',
  'vibespace-task group-bind <id> [--session <backend:sessionId>]',
  'vibespace-task group-unbind <id> [--session <backend:sessionId>]',
  '```',
  'The regular verbs (show / progress / backlog-* …) also accept ANY group via `--group <id>` for you — belonging is not required.',
  'Limits: contextDir/folders must live under the user-allowlisted roots (setting agents.groupManagementRoots); there is NO group delete — destructive ops stay with the user.',
  '</vibespace-group-manager>',
].join('\n');

// Baseline tools intro for ANY VibeSpace-managed session (even without a task):
// teaches the agent to report its own status. Task-bound sessions get the full
// task context instead (which already includes both tools' usage).
// User-configured extra instructions injected at the TOP of hook deliveries
// (Manage Agents → Agent instructions). Delivered like group content: once per
// session, re-delivered when the text changes (seen-hash gate) — never per turn.
function customPreamble() {
  try {
    const v = String(serverSetting('agents.injectPreamble') || '').trim();
    return v ? v.slice(0, 4000) : '';
  } catch { return ''; }
}
// Per-surface extras (2.88.0): short user text prepended INSIDE the other two
// injection surfaces. Kept separate from the preamble — the per-turn one costs
// tokens EVERY prompt, so it gets its own (small) budget and its own field.
function customExtra(key, cap) {
  try {
    const v = String(serverSetting(key) || '').trim();
    return v ? v.slice(0, cap) : '';
  } catch { return ''; }
}
function preambleBlock(text) {
  return `<vibespace-user-instructions>\nThe VibeSpace user configured these standing instructions for every agent session — follow them alongside your other guidance:\n\n${text}\n</vibespace-user-instructions>`;
}
// Prepend the preamble to an outgoing delivery when unseen/changed; returns the
// (possibly unchanged) parts array. sessionObj carries the seen-hash.
function withPreamble(sessionObj, parts) {
  const text = customPreamble();
  if (!text) return parts;
  const hash = require('crypto').createHash('sha1').update(text).digest('hex').slice(0, 12);
  if (sessionObj._preambleSeen === hash) return parts;
  // Deliver with (or without) other content — the preamble alone still counts.
  sessionObj._preambleSeen = hash;
  return [preambleBlock(text), ...parts];
}

// Built per delivery since 2.211.0 — the per-feature Integration toggles are
// liveApply, and teaching a DISABLED tool (whose endpoint refuses) would
// train agents into dead ends. All-on output is byte-identical to the old
// static SESSION_TOOLS_INTRO. Returns '' when nothing session-level is
// enabled (status+ask both off) — the abs-path/exit advice alone isn't worth
// a delivery.
function sessionToolsIntro(T) {
  if (!T.status && !T.ask) return '';
  const L = ['<vibespace-session-tools>'];
  if (T.status) {
    L.push(
      'This session is running inside VibeSpace. Report your OWN status so the user can see it on their session board — use the `vibespace-status` command (already on your PATH):',
      '  vibespace-status <working|needs-input|blocked|review|done> [--urgency low|normal|high|urgent] [--reason "why"]',
      '  vibespace-status show   (or run it with no arguments) — prints usage + your current status',
      'Keep it honest and current: `working` while making progress; `blocked` or `needs-input` (with a higher urgency) the moment you are stuck or waiting on the user; `review` when you want them to look; `done` when this piece of work is finished.');
  } else {
    L.push('This session is running inside VibeSpace.');
  }
  if (T.ask) {
    L.push(
      'Whenever you ask the user ANYTHING — a question in chat, or ending a turn waiting on their decision/input/review — ALSO file it on their global inbox with `vibespace-ask`. They are often NOT watching this window; the inbox is how they find waiting questions across all sessions:',
      '  vibespace-ask "question or decision needed" [--detail "context + your recommendation"] [--urgency low|normal|high|urgent]',
      '  vibespace-ask list  /  vibespace-ask resolve <id|text>',
      'The MOMENT the user answers (in chat or anywhere), resolve the item YOURSELF with `vibespace-ask resolve` — never leave answered items for them to tick. Not for your own working steps — those belong in your normal todo list.',
      'The inbox item is a NOTIFICATION MIRROR, not the message itself: everything you file (the question, options, your recommendation) must ALSO appear IN FULL in your chat reply — never say something only in the inbox (the user reads and copies from chat; inbox rows are hard to read at length).');
  }
  if (T.jobs) {
    L.push(
      'Background work that must OUTLIVE this conversation (a dev server, a monitor, a batch job, a schedule) — never nohup/systemd/harness-cron. Register it with `vibespace-job` and get it back later BY POLLING, even from a future session:',
      '  vibespace-job run "python3 collect.py" --name collect-x --context "goal: 500 prompts; output: /data/x.jsonl; resume: rerun with --resume"',
      '  vibespace-job poll <id>    (echoes your --context brief with the result — write one that explains everything to your future amnesiac self)',
      'Flags pick the kind: --keep-up = keep-alive service · --every 30m / --cron "41 9 * * *" / --at "2026-09-05 06:00" = schedule. Your conversation is auto-messaged when a job finishes/fails/asks (create output says so); inside a job, `vibespace-job announce "found X"` notifies NOW (watch jobs: exit code ≠ newsworthiness); `subscribe <id> [--filter regex]` = get another visible job\'s messages; `list --mine|--subscribed` and `show <id>` re-inspect everything you registered. Turn-scoped waits stay in background Bash/Monitor; /goal covers in-session continuation; dated obligations go to --at, not the group backlog. FULL manual anytime: `vibespace-job docs`; every tool: `vibespace-docs [status|ask|task|jobs]`.');
  }
  L.push(
    'Other agent sessions may be working alongside you. `vibespace-msg list` shows the ones you can reach (your Task Group by default); `vibespace-msg send <name|id> "text"` delivers into their conversation — an idle receiver pays a billed turn, so message purposefully (what you need + whether you expect a reply). Replies arrive here as peer-message cards. Manual: vibespace-docs msg.');
  L.push(
    'Designs, mockups, posters: `vibespace-page kit` prepares the design-canvas kit on this machine and prints its base directory — read that directory\'s SKILL.md and follow it; it ends in `vibespace-page publish <file.html> --title "…"`, which hosts the page on this VibeSpace and prints a share link (private by default, `--public` for anyone with the link). Any self-contained HTML you produce can be shared the same way. Manual: vibespace-docs pages.');
  L.push(
    'When your reply references files you created or discuss (audio, images, reports, code, HTML…), write their ABSOLUTE paths — the chat UI turns absolute paths into clickable links that open in the right viewer (audio plays, images preview, HTML renders). Bare filenames or project-relative paths may not resolve.',
    'If a request needs a DIFFERENT machine\'s network position (a region, an internal/VPN network, a fixed source IP), you can borrow a paired machine\'s network for that ONE command with `vibespace-exit` (default: go direct — only reach for an exit deliberately):',
    '  vibespace-exit list                     machines the user enabled as exits',
    '  eval "$(vibespace-exit use <machine>)"; curl https://ifconfig.me   (borrow its egress via SOCKS for proxy-aware TCP tools)',
    '  vibespace-exit run <machine> -- <cmd>   run the command ON that machine (universal: ICMP/UDP/proxy-unaware tools/its own DNS)',
    '  (SOCKS can\'t carry ping/UDP and needs a proxy-aware tool — when `use` won\'t work, `run` will. Nothing is available until the user enables a machine as an exit.)');
  if (T.task) L.push('(If this session is later linked to a VibeSpace task, you will also get `vibespace-task` for task-level progress/plan/status — you have no task right now, so it is not active yet.)');
  L.push('</vibespace-session-tools>');
  return L.join('\n');
}

// SessionStart hook payload (context injection): rendered task state + context
// folder file index + the rules. Fires + injects for Claude (terminal + chat).
// SCOPED to the session's OWN context task — the ?taskId= query is ignored so a
// token can never read another task's context. Records the task version the
// session has now "seen" so UserPromptSubmit only RE-injects on later changes.
app.get('/api/agent/task-context', (req, res) => {
  const hit = agentSession(req, res);
  if (!hit) return;
  // Integration master switch: empty delivery — covers sessions spawned BEFORE
  // the switch flipped off (their hook is still armed and keeps calling).
  if (!integrationOnMaster()) return res.json({ success: true, context: '' });
  try {
    const [s, id] = hit;
    const key = sessionStatusKey(s, id);
    const groups = tasks.groupsForSession({ sessionKey: key, cwd: s.cwd, initialGroupId: s._initialGroupId });
    // agents.contextInjection off (2.211.0) ⇒ no group content is injected at
    // all (falls through to the baseline tools intro) — the per-group
    // injectContext toggle stays the finer-grained instrument.
    const injectGroups = ctxInjectionOn() ? groups.filter((g) => g.injectContext !== false) : []; // P6: per-group context toggle
    let context = '';
    if (injectGroups.length) {
      // Remote sessions read the auto-synced copy — translate file paths
      context = tasks.renderMultiContext(injectGroups.map((g) => g.id), { ctxBaseFor: remoteCtxBaseFor(s), sessionKey: key, tools: enabledTools() });
      // Only Claude injects the SessionStart output; codex runs the command but
      // ignores it, so don't mark groups "seen" for codex (that would starve its
      // UserPromptSubmit delivery).
      if (context && honoursSessionStart(s)) {
        s._groupSeenAt = s._groupSeenAt || {};
        s._ctxSig = s._ctxSig || {};
        s._groupSnap = s._groupSnap || {};
        for (const g of injectGroups) {
          s._groupSeenAt[g.id] = g.contentUpdatedAt || g.updatedAt;
          if (g.contextDir) s._ctxSig[g.id] = tasks.contextDirSignature(g.contextDir);
          // Snapshot what was just delivered — later updates diff against it
          // instead of re-injecting the whole group (2.113.0).
          s._groupSnap[g.id] = tasks.snapshotForDiff(g.id);
        }
      }
    } else if (honoursSessionStart(s) && !s._toolsIntroSeen) {
      // No INJECTABLE group (none at all, or every belonged group has
      // injectContext off): still teach vibespace-status once — the baseline
      // intro carries no group content, and an agent that never learns the
      // tool can't self-report.
      // In no group: still teach the agent to report its status (baseline), once.
      // codex ignores SessionStart output, so it gets this via prompt-context.
      context = sessionToolsIntro(enabledTools());
      if (context) s._toolsIntroSeen = true;
    }
    // Designated Group MANAGER: teach the admin verbs ONCE — whichever route
    // delivers first wins (s._mgrIntroSeen shared with prompt-context).
    if (honoursSessionStart(s) && !s._mgrIntroSeen && isManagerSession(key)) {
      context = context ? context + '\n\n' + MANAGER_INTRO : MANAGER_INTRO;
      s._mgrIntroSeen = true;
    }
    if (honoursSessionStart(s)) { // a harness that ignores SessionStart output must not burn the seen-gate
      const withPre = withPreamble(s, context ? [context] : []);
      context = withPre.length ? withPre.join('\n\n') : context;
    }
    // Background jobs digest (2.342.x, design-background-work §6.3b): rides the
    // SessionStart payload — new sessions AND resumes both fire this route, so
    // a resumed amnesiac rediscovers its background work here. View-filtered,
    // 600B budget, yields to everything else under the 9600B cap; zero jobs =
    // zero bytes (an empty section is never injected).
    try {
      const jm = getJobs && getJobs();
      if (jm && jm.ready) {
        const caller = jobsCaller(s, id);
        // Offline notification stash FIRST (2.344.0): completions that could
        // not be delivered while this conversation was closed inject here at
        // resume, newest guaranteed, then the stash clears (drain-at-render,
        // same accepted-lost stance as _jobsEventsSeenTs).
        const drained = jm.drainNotifs(caller.conversationId);
        // drained job notifications enter the agent's context invisibly —
        // render the same card the live lane shows (2.363.0)
        try { if (deliver) for (const e of drained) deliver.emitPeerCard(caller.conversationId, { fromName: 'Background Work · ' + (e.jobName || e.jobId), text: e.text }); } catch { }
        // >2 entries: also spill the untruncated history to a file the agent
        // can Read — the injected block elides its middle under budget
        const spillPath = drained.length > 2 ? jm.spillNotifs(caller.conversationId, drained) : null;
        const missed = jobModel.renderNotifStash(drained, { spillPath });
        if (missed) context = context ? context + '\n\n' + missed : missed;
        const dig = jm.digestFor(caller, Buffer.byteLength(context || '', 'utf-8'));
        if (dig) context = context ? context + '\n\n' + dig : dig;
      }
    } catch { }
    // msg-stash drain — INDEPENDENT of the jobs engine (review-caught: it sat
    // inside the jm.ready gate, so a jobs init failure silently held promised
    // messages forever; messaging has its own failure domain)
    try {
      if (deliver) {
        const caller2 = jobsCaller(s, id);
        const drained = deliver.drainStash(caller2.conversationId);
        // stash drain enters the AGENT's context invisibly — emit the same
        // card the live lanes render so the user sees what arrived (2.363.0)
        for (const e of drained) deliver.emitPeerCard(caller2.conversationId, { fromName: e.fromName || null, text: e.text });
        const pm = renderMsgStash(drained);
        if (pm) context = context ? context + '\n\n' + pm : pm;
      }
    } catch { }
    res.json({ success: true, context });
  } catch (e) { res.status(404).json({ error: e.message }); }
});
// UserPromptSubmit hook payload — delivered through the harness's own prompt
// hook, NEVER by rewriting the user's message. Three things ride here:
//  1. Group context on the FIRST prompt when SessionStart didn't deliver it
//     (codex — it fires UserPromptSubmit but not SessionStart in app-server).
//  2. A per-group REFRESH whenever a Task Group this session belongs to changed
//     since the session last saw it — so any change (objective/plan/progress,
//     from the UI or another session's vibespace-task, or a new bind adding a
//     group) reaches the agent on its next turn. Gated per group on
//     updatedAt > _groupSeenAt[id] → no per-turn noise when nothing changed.
//  3. Any pending status-override notice (consumed once).
app.get('/api/agent/prompt-context', (req, res) => {
  const hit = agentSession(req, res);
  if (!hit) return;
  // Integration master switch (see task-context): no reminders, no group
  // context, no override notices — the turn reaches the CLI untouched.
  // Pending status-override notices are consumed AND DROPPED here: deferring
  // them would inject a stale days-old "your status was overridden" reminder
  // whenever the switch is re-enabled.
  if (!integrationOnMaster()) {
    try {
      const [s0, id0] = hit;
      for (const k of [sessionStatusKey(s0, id0), `webui:${id0}`]) sessionStatus.consumeNotice(k);
    } catch {}
    return res.json({ success: true, context: '' });
  }
  try {
    const [s, id] = hit;
    const key = sessionStatusKey(s, id);
    const parts = [];
    // Recreated-cwd safety notice (B-7812, user-mandated defense): a resume
    // whose working directory was DELETED got it recreated EMPTY on explicit
    // user confirm — the agent must not continue on the false premise that
    // its files still exist. One-shot; meta keeps the flag until delivered,
    // so a restart before the first prompt re-arms it (duplicate on that rare
    // edge is the SAFE direction).
    if (s._cwdRecreated) {
      s._cwdRecreated = false;
      parts.push(`<vibespace-cwd-notice>\nYour working directory (${s.cwd || ''}) did NOT exist when this session was resumed — the user chose to recreate it as an EMPTY directory. Files from earlier in this conversation are GONE from disk. Re-verify every assumption about existing files/state before acting, and tell the user what is missing if it affects the task.\n</vibespace-cwd-notice>`);
    }
    const toolFlags = enabledTools();
    const groups = tasks.groupsForSession({ sessionKey: key, cwd: s.cwd, initialGroupId: s._initialGroupId });
    // agents.contextInjection off ⇒ no group payloads/diffs (see task-context)
    const injectGroups = ctxInjectionOn() ? groups.filter((g) => g.injectContext !== false) : []; // P6: per-group context toggle
    if (injectGroups.length) {
      s._groupSeenAt = s._groupSeenAt || {};
      s._ctxSig = s._ctxSig || {};
      s._groupSnap = s._groupSnap || {};
      const multi = injectGroups.length > 1;
      const ctxBaseFor = remoteCtxBaseFor(s); // remote → translated file paths
      const firstGroups = [];   // never-delivered groups → full context below
      const changedDiffs = [];  // updated groups delivering as a DELTA
      const updatedFulls = [];  // updated groups needing a FULL re-delivery
      for (const g of injectGroups) {
        const seenAt = s._groupSeenAt[g.id];
        // User-written contextDir files don't bump updatedAt — a signature diff
        // (path/size/mtime of the indexed files) is how we notice them.
        const sig = g.contextDir ? tasks.contextDirSignature(g.contextDir) : '';
        const hadSig = s._ctxSig[g.id] !== undefined;
        const ctxChanged = hadSig && s._ctxSig[g.id] !== sig;
        // Gate on CONTENT changes only (title/objective/activity/
        // contextDir) — cosmetic edits (color, toggles, binds) bump updatedAt
        // but must not re-inject the whole group to every member.
        const contentAt = g.contentUpdatedAt || g.updatedAt;
        const metaChanged = contentAt > (seenAt || 0);
        if (seenAt === undefined) { firstGroups.push(g); continue; }
        if (metaChanged || ctxChanged) {
          // UPDATE, not first delivery — deliver only the DIFF vs the snapshot
          // from the last delivery (2.113.0, user request: the full re-inject
          // was several KB of repetition per change). No snapshot (older
          // session object / toggle off) or a STRUCTURAL change (contextDir)
          // → the old full "was UPDATED" payload.
          // Markers/snapshot advance at RENDER, not receipt — a delivery the
          // harness drops (hook 3s timeout) stays lost until the agent reads
          // `show --full`/TASK.md or the server restarts (ACCEPTED: same class
          // as the pre-existing seen-bump loss window; every diff carries the
          // full-state pointer as its self-heal, which the old full payloads
          // did not need but also did not have).
          const snap = s._groupSnap[g.id];
          const ctxBase = ctxBaseFor ? ctxBaseFor(g.id) : null;
          const changes = (injectDiffsEnabled() && snap)
            ? tasks.diffChanges(g.id, snap, { gid: multi ? `--group ${g.id} ` : '', ctxBase, oldSig: s._ctxSig[g.id] || '', newSig: sig, sessionKey: key })
            : null;
          if (changes) {
            // empty lines = a no-op edit (nothing the injection renders
            // changed) — say nothing, just advance the markers below.
            if (changes.lines.length) changedDiffs.push({ g, changes, ctxBase });
          } else {
            updatedFulls.push(g);
          }
          s._groupSeenAt[g.id] = contentAt;
          s._ctxSig[g.id] = sig;
          s._groupSnap[g.id] = tasks.snapshotForDiff(g.id);
        } else if (!hadSig && g.contextDir) {
          // Meta already seen (e.g. claude's SessionStart set _groupSeenAt) but
          // no contextDir baseline recorded yet — set it now WITHOUT re-injecting.
          s._ctxSig[g.id] = sig;
        }
        // Seen but no snapshot yet (session predates 2.113.0 in memory): leave
        // _groupSnap unset — the next change falls back to full delivery once,
        // which records the snapshot.
      }
      // ── Assemble the delivery: [manifest?] + ONE diff block + full blocks ──
      // N changed groups collapse into ONE combined <vibespace-task-update>
      // whose header ENUMERATES every changed group (user directive: stacked
      // per-group blocks + the ~2KB persisted-preview truncation could hide
      // the very fact that a second group changed).
      const diffBlock = !changedDiffs.length ? null
        : changedDiffs.length === 1
          ? tasks.renderDiffBlock(changedDiffs[0].g.id, changedDiffs[0].changes, { multi, ctxBase: changedDiffs[0].ctxBase })
          : tasks.renderContextDiffMulti(changedDiffs.map((x) => ({ id: x.g.id, changes: x.changes })));
      const fullBlocks = [];
      for (const g of updatedFulls) {
        const ctx = tasks.renderContext(g.id, { multi, ctxBase: ctxBaseFor ? ctxBaseFor(g.id) : null, sessionKey: key, tools: toolFlags });
        if (ctx) fullBlocks.push(`The Task Group below was UPDATED since you last saw it — this is the current state (supersedes any earlier copy).\n\n${ctx}`);
      }
      let newFullGroups = [];
      if (firstGroups.length) {
        // First delivery. ALL of the membership new (the codex first-prompt
        // path) → ONE layered multi-context (same format SessionStart uses)
        // instead of N full payloads each repeating the ~2.3KB tools section.
        // renderMultiContext states ABSOLUTE membership ("belongs to N Task
        // Groups"), so it is only used when it covers the WHOLE membership —
        // a subset call told a 3-group session it belongs to 2 (review-caught);
        // a partial set (group bound mid-session) renders per-group with the
        // count-free multi phrasing instead.
        const allNew = firstGroups.length === injectGroups.length;
        const fulls = (firstGroups.length > 1 && allNew)
          ? [tasks.renderMultiContext(firstGroups.map((g) => g.id), { ctxBaseFor, sessionKey: key, tools: toolFlags })].filter(Boolean)
          : firstGroups.map((g) => tasks.renderContext(g.id, { multi, ctxBase: ctxBaseFor ? ctxBaseFor(g.id) : null, sessionKey: key, tools: toolFlags })).filter(Boolean);
        if (fulls.length) {
          fullBlocks.push(...fulls);
          newFullGroups = firstGroups;
          for (const g of firstGroups) {
            s._groupSeenAt[g.id] = g.contentUpdatedAt || g.updatedAt;
            s._ctxSig[g.id] = g.contextDir ? tasks.contextDirSignature(g.contextDir) : '';
            s._groupSnap[g.id] = tasks.snapshotForDiff(g.id);
          }
        }
      }
      const blocks = [...(diffBlock ? [diffBlock] : []), ...fullBlocks];
      if (blocks.length > 1) {
        // MULTI-BLOCK delivery: Claude truncates an oversized persisted payload
        // to a ~2KB HEAD preview, so a plain one-after-the-other order can
        // erase every block after the first ENTIRELY (user directive). Head
        // MANIFEST names EVERY block + the rescue path (always inside any
        // preview); the small diff block goes first, big fulls last.
        const name = (g) => `"${g.title}" (${g.id})`;
        const kinds = [];
        if (diffBlock) kinds.push(`update diffs for: ${changedDiffs.map((x) => name(x.g)).join(', ')}`);
        if (updatedFulls.length) kinds.push(`FULL re-delivery of changed group(s): ${updatedFulls.map(name).join(', ')}`);
        if (newFullGroups.length) kinds.push(`the FULL context for group(s) NEW to this session: ${newFullGroups.map(name).join(', ')}`);
        parts.push(`<vibespace-delivery-note>This delivery contains, in order: ${kinds.join('; ')}. ${tasks._persistRescueLine()}</vibespace-delivery-note>`);
      }
      parts.push(...blocks);
    } else if (!s._toolsIntroSeen) {
      // No injectable group → baseline tools intro once (see task-context note).
      // In no group: deliver the baseline tools intro on the FIRST prompt (covers
      // codex — its app-server runs the hook but ignores SessionStart output).
      const intro = sessionToolsIntro(toolFlags);
      if (intro) { parts.push(intro); s._toolsIntroSeen = true; }
    }
    // Designated Group MANAGER: teach the admin verbs once (this route is
    // codex's ONLY delivery path; claude usually gets it via task-context).
    if (!s._mgrIntroSeen && isManagerSession(key)) {
      parts.push(MANAGER_INTRO);
      s._mgrIntroSeen = true;
    }
    // Background jobs: NEW events since this session's last delivery (view-
    // filtered at render time; ≤600B; zero events = zero bytes).
    try {
      const jm = getJobs && getJobs();
      if (jm && jm.ready) {
        const caller = jobsCaller(s, id);
        // stashed offline notifications (a resume that skipped SessionStart —
        // codex — or entries stashed since it): drain here too
        const drained = jm.drainNotifs(caller.conversationId);
        // drained job notifications enter the agent's context invisibly —
        // render the same card the live lane shows (2.363.0)
        try { if (deliver) for (const e of drained) deliver.emitPeerCard(caller.conversationId, { fromName: 'Background Work · ' + (e.jobName || e.jobId), text: e.text }); } catch { }
        const spillPath = drained.length > 2 ? jm.spillNotifs(caller.conversationId, drained) : null;
        const missed = jobModel.renderNotifStash(drained, { spillPath });
        if (missed) parts.push(missed);
        const u = jm.updatesFor(caller, s._jobsEventsSeenTs || 0);
        if (u.text) parts.push(u.text);
        s._jobsEventsSeenTs = u.lastTs; // marker advances at render (accepted-lost on drop)
      }
    } catch { }
    // msg-stash drain — INDEPENDENT of the jobs engine (see task-context note)
    try {
      if (deliver) {
        const caller2 = jobsCaller(s, id);
        const drained = deliver.drainStash(caller2.conversationId);
        // stash drain enters the AGENT's context invisibly — emit the same
        // card the live lanes render so the user sees what arrived (2.363.0)
        for (const e of drained) deliver.emitPeerCard(caller2.conversationId, { fromName: e.fromName || null, text: e.text });
        const pm = renderMsgStash(drained);
        if (pm) parts.push(pm);
      }
    } catch { }
    // Oversize belt (2.113.0): full contexts + the mixed-delivery manifest
    // embed the persisted-output rescue line, lone diff blocks don't (each is
    // small) — but several parts can still cross Claude's ~10KB hook persist
    // threshold TOGETHER. If nothing in the payload teaches the rescue,
    // prepend it so a 2KB head preview always names the recovery path.
    if (parts.length && !parts.some((p) => p.includes('persisted-output')) && Buffer.byteLength(parts.join('\n\n'), 'utf-8') > 8000) {
      parts.unshift(tasks._persistRescueLine());
    }
    for (const k of [key, `webui:${id}`]) { // record may still be under webui:<id>
      const notice = sessionStatus.consumeNotice(k);
      if (notice) { parts.push(SessionStatusManager.renderNotice(notice)); break; }
    }
    // Remote session about to receive a fresh/updated context → make sure the
    // synced copy refreshes promptly too (busy-guard makes over-calling cheap).
    if (s.host && parts.length) scheduleCtxSync(s, id);
    // Per-turn micro-reminder (2.78.0, user request): when nothing bigger is
    // being delivered this prompt, a ~250-byte nudge keeps the tools present
    // in the agent's working context (the full rules injected at session start
    // scroll far behind on long sessions and usage decays). Gated by the
    // agents.perTurnToolReminder setting (default on).
    // User preamble rides on top of whatever this prompt delivers (or alone,
    // when newly set/changed) — codex's only delivery path is this route.
    const outParts = withPreamble(s, parts);
    const extra = customExtra('agents.perTurnExtra', 500);
    // "Per turn" means per turn: on prompts that already carry a bigger
    // delivery the extra still rides at the very top as its own block.
    if (outParts.length && extra) outParts.unshift(`<vibespace-reminder>${extra}</vibespace-reminder>`);
    if (!outParts.length) {
      const multi = injectGroups.length > 1;
      const mgrClause = isManagerSession(key) ? ' · you are a Group MANAGER: `vibespace-task group-list` + group-create/-update/-bind organize ALL groups (any verb takes --group <id>)' : '';
      // Per-feature toggles: the reminder lists only ENABLED tools (2.211.0).
      const segs = [];
      if (toolFlags.status) segs.push('vibespace-status <state> — keep your board state honest');
      if (toolFlags.ask) segs.push('vibespace-ask "q" — MIRROR every chat question onto their inbox (the FULL content still goes in your chat reply — the inbox is only the notification), and resolve <id|text> the moment they answer');
      if (toolFlags.task) segs.push(`vibespace-task ${multi ? '--group <id> ' : ''}progress "summary" — log finished work`);
      if (toolFlags.jobs) segs.push('vibespace-job run "cmd" --name x --context "brief" — background work that must OUTLIVE this conversation (auto-notifies you on completion; poll/show/subscribe/announce; full manual: vibespace-job docs)');
      segs.push('vibespace-docs [status|ask|task|jobs|msg|pages] — the full manual for any of these tools');
      const std = perTurnReminderEnabled() && segs.length
        ? `Tools on PATH: ${segs.join(' · ')}${mgrClause}. Run any with no args for usage.`
        : '';
      // User extra rides at the TOP of the reminder block (per-hook custom,
      // 2.88.0); it delivers even with the standard reminder toggled off.
      const body = [extra, std].filter(Boolean).join('\n');
      if (body) outParts.push(`<vibespace-reminder>${body}</vibespace-reminder>`);
    }
    // ── Stay INLINE (verified 2026-07-13 by binary search) ──
    // Claude Code wraps a hook's additionalContext into a <persisted-output>
    // 2KB-preview + on-disk file at EXACTLY 10240 bytes = 10 KiB (10000 inline,
    // 10240 wrapped). Beyond that the agent must Read a file to see the full
    // context — exactly the 2.68.0 "never learned the tools" failure. Cap with
    // margin so the critical HEAD (tools/identity/objective — ordered
    // first) is always in-context; only the TAIL (oldest activity-log lines) is
    // dropped, and it's recoverable via `vibespace-task show --full`.
    let ctx = outParts.join('\n\n');
    const INLINE_CAP = 9600; // bytes; margin under the 10240 wrap threshold
    if (Buffer.byteLength(ctx, 'utf-8') > INLINE_CAP) {
      const ptr = `\n\n…[context trimmed to stay inline — run \`vibespace-task${injectGroups.length > 1 ? ' --group <id>' : ''} show --full\` for the rest]`;
      const room = INLINE_CAP - Buffer.byteLength(ptr, 'utf-8');
      let head = Buffer.from(ctx, 'utf-8').subarray(0, room).toString('utf-8');
      const nl = head.lastIndexOf('\n'); // clean cut at a line boundary (also avoids a split multibyte char)
      if (nl > room * 0.5) head = head.slice(0, nl);
      ctx = head + ptr;
    }
    res.json({ success: true, context: ctx });
  } catch (e) { res.json({ success: true, context: '' }); }
});
// Sessions we have already announced the nudge exit condition for — one
// journal line per session per boot (the refusal itself repeats every stop).
const _nudgeExitSaid = new Set();
// Stop-time bookkeeping nudge (2.79.0): fired by the Stop hook (claude) and
// the codex wrapper's turn/completed. Returns block+reason ONLY when the
// session's board state is stale (no status update in 10 min) AND we haven't
// nudged in 30 min — one bounded bookkeeping mini-turn, not a per-stop tax.
app.get('/api/agent/stop-check', (req, res) => {
  const hit = agentSession(req, res);
  if (!hit) return;
  try {
    if (!integrationOnMaster() || !stopNudgeEnabled()) return res.json({ block: false });
    // The arbiter is keyed on STATUS staleness — with vibespace-status
    // disabled (2.211.0) there is nothing to keep fresh, so never nudge.
    const T = enabledTools();
    if (!T.status) return res.json({ block: false });
    const [s, id] = hit;
    const now = Date.now();
    // Both thresholds user-configurable (2.89.0) — clamped to sane bounds so a
    // typo can't accidentally disable the nudge (use the on/off toggle for
    // that). An EXPLICIT 0 (2.210.0, user request) means every-stop mode:
    // 0 staleness = the board is always considered stale, 0 cooldown = no
    // per-session rate limit. Note stop_hook_active still guards the loop —
    // the nudge's own follow-up mini-turn is never re-nudged, so even 0/0 is
    // one extra mini-turn per user turn, not an infinite chain.
    const clamp0 = (v, lo, hi, dflt) => (Number.isFinite(v) ? (v <= 0 ? 0 : Math.min(hi, Math.max(lo, v))) : dflt);
    const staleMin = clamp0(Number(serverSetting('agents.stopNudgeStaleMinutes')), 1, 240, 10);
    const cooldownMin = clamp0(Number(serverSetting('agents.stopNudgeCooldownMinutes')), 2, 720, 30);
    const key = sessionStatusKey(s, id);
    // THE COOLDOWN IS PERSISTED (D8, design §1.4). `s._lastStopNudge` lives on
    // the live session object, so every release restart handed the largest
    // measured automatic spender a fresh cooldown — and this instance restarts
    // several times a day. The spend guard keeps the same fact on disk, keyed
    // by the SESSION-STATUS key (the id that survives a re-attach); the field
    // stays as the in-memory mirror (src/session-schema.js names this file's
    // store as its home). Whichever is newer wins: a store that is not wired
    // (a harness building these routes alone) degrades to the old behaviour.
    const nudgeRec = (() => { try { return spendGuard?.nudgeRec?.(key) || null; } catch { return null; } })();
    const lastNudgeAt = Math.max(Number(s._lastStopNudge) || 0, Number(nudgeRec?.at) || 0);
    if (cooldownMin > 0 && lastNudgeAt && now - lastNudgeAt < cooldownMin * 60 * 1000) return res.json({ block: false });
    const rec = sessionStatus.get(key) || sessionStatus.get(`webui:${id}`);
    const sawStatus = !!(rec && rec.at);
    if (staleMin > 0 && sawStatus && now - rec.at < staleMin * 60 * 1000) return res.json({ block: false });
    // EXIT CONDITION (D8): a session that has NEVER reported a status is being
    // asked to do bookkeeping it does not do — a Task-Group-less session, an
    // agent that ignores the tool, a wrapper whose CLI has no such command.
    // Nudging it forever buys a billed mini-turn per stop and nothing else, so
    // after N unanswered nudges we stop asking. Any status report at all
    // resets the counter (that is what "answered" means).
    const maxUnanswered = clamp0(Number(serverSetting('agents.stopNudgeMaxUnanswered')), 1, 100, 3);
    if (!sawStatus && maxUnanswered > 0 && (nudgeRec?.n || 0) >= maxUnanswered) {
      if (!_nudgeExitSaid.has(key)) {
        _nudgeExitSaid.add(key);
        if (_nudgeExitSaid.size > 500) _nudgeExitSaid.clear();
        console.log(`[stop-nudge] ${key}: ${nudgeRec.n} nudges with no status report — this session is not asked again (agents.stopNudgeMaxUnanswered)`);
      }
      return res.json({ block: false });
    }
    // THE SPEND CEILING (design §4.4c / P9): this returns block+reason, and the
    // CLI answers it with a REAL turn on the session's credential slot —
    // measured on this instance's own transcripts, 603 of them in two months
    // (21 on one conversation inside one hour, 93 on the busiest day).
    // Refusing is silent to the AGENT on purpose (the hook contract has no way
    // to say "later"), but never silent to the USER: the guard journals it and
    // files one "For you" item per identity per reason.
    // `auth` is declared OUT here (r4) because the charge below is charged to
    // the slot THIS verdict resolved — see the comment there.
    let auth = null;
    if (spendGuard) {
      try { auth = spendGuard.authorize({ reason: 'stop-nudge', session: s, sessionId: id, sessionName: s.name || null }); }
      catch (e) { console.warn('[stop-nudge] spend authorizer threw — not nudging (fail closed):', e.message); return res.json({ block: false }); }
      if (auth && auth.ok === false) return res.json({ block: false });
    }
    s._lastStopNudge = now;
    try { spendGuard?.noteNudge?.(key, { at: now, sawStatus }); } catch { }
    // CHARGE WHAT YOU AUTHORIZED (r4): the charge hands back the slot the
    // verdict resolved, never a session for the guard to resolve a SECOND time.
    // Nothing awaits between the two lines here, so this is not today's defect
    // — it is the same RULE, stated at every pair, because "no await in
    // between" is a property of this arrangement of the code and not of the
    // question being asked once.
    try { spendGuard?.note?.({ reason: 'stop-nudge', session: s, identity: auth && auth.identity }); } catch { }
    // Per-hook custom text (2.88.0): user extra rides at the top of the nudge.
    const extra = customExtra('agents.stopNudgeExtra', 500);
    // Steps list only ENABLED tools (2.211.0) — status is guaranteed on here.
    const steps = ['set your CURRENT state — vibespace-status <working|needs-input|blocked|review|done> --reason "one line" (done if this piece of work is finished; needs-input/review if you are waiting on the user)'];
    if (T.ask) steps.push('if you asked the user anything this turn or are waiting on them, MIRROR it — vibespace-ask "question" (the full content must already be in your chat reply; the inbox only notifies) — and vibespace-ask resolve anything they already answered');
    if (T.task) steps.push('if you completed meaningful work, log it — vibespace-task progress "summary"');
    res.json({
      block: true,
      reason: (extra ? extra + '\n' : '') + 'VibeSpace bookkeeping before you stop (your board state is stale): ' + steps.map((t, i) => `(${i + 1}) ${t}`).join('; ') + '. Then stop again.',
    });
  } catch { res.json({ block: false }); }
});
// Integration master switch (agents.vibespaceIntegration, 2.190.0): OFF gates
// every model-visible CONTENT response — the three deliveries (task-context /
// prompt-context / stop-check) AND the GET /api/agent/task read (it returns
// the same steering substance: objective/backlog/activity) — so even sessions
// spawned while it was ON go pristine mid-flight. WRITE endpoints
// (status/ask/progress/backlog) stay live: an old session's reports keep
// landing on the board, they just stop being taught/injected/read back.
// The canonical predicate lives in server.js (threaded via deps); the inline
// fallback only serves harnesses that construct these routes without it.
function integrationOnMaster() {
  try {
    if (integrationEnabled) return !!integrationEnabled();
    return serverSetting('agents.vibespaceIntegration') !== false;
  } catch { return true; }
}
function stopNudgeEnabled() {
  try { return serverSetting('agents.stopBookkeepingNudge') !== false; } catch { return true; }
}
// Per-feature Integration toggles (2.211.0, user request: e.g. keep shared-
// context injection but withhold ask/progress). All default ON; consulted
// only while the master switch is ON. OFF ⇒ the feature is neither TAUGHT
// (intro/context/reminders omit it) nor SERVED (its write endpoints refuse
// with skip-and-continue guidance).
function toolOn(name) { // 'Status' | 'Ask' | 'Task'
  try { return serverSetting('agents.tool' + name) !== false; } catch { return true; }
}
function enabledTools() { return { status: toolOn('Status'), ask: toolOn('Ask'), task: toolOn('Task'), jobs: toolOn('Jobs') }; }
function ctxInjectionOn() {
  try { return serverSetting('agents.contextInjection') !== false; } catch { return true; }
}
function toolDisabled(res, cmd) {
  res.status(403).json({ error: `${cmd} is disabled in this VibeSpace's settings (Integration section) — skip this reporting step and continue with your work; do not retry.` });
}
function perTurnReminderEnabled() {
  try { return serverSetting('agents.perTurnToolReminder') !== false; } catch { return true; }
}
function injectDiffsEnabled() {
  try { return serverSetting('agents.contextUpdateDiffs') !== false; } catch { return true; }
}
// ── vibespace-task agent endpoints (P3): validated task-level writes,
// SCOPED to the session's own context task (VIBESPACE_TASK_ID at spawn) —
// an agent cannot touch arbitrary tasks. All writes flow through TaskManager,
// so TASK.md regenerates and tasks-updated broadcasts automatically. ──
app.get('/api/agent/task', (req, res) => {
  const hit = agentSession(req, res);
  if (!hit) return;
  // Master switch: this READ returns the same steering substance the delivery
  // endpoints inject (objective/backlog/activity) — `vibespace-task show` from
  // a pre-toggle session must not bypass the pristine state through it.
  if (!integrationOnMaster()) return res.status(403).json({ error: 'VibeSpace integration is disabled (master switch)' });
  const gid = resolveAgentGroup(hit, req, res);
  if (!gid) return;
  try {
    const t = tasks.get(gid);
    // backlog: OPEN items only — that's what the CLI numbers for backlog-done
    // (the resolve route indexes the same open-items list)
    res.json({ success: true, task: { id: t.id, title: t.title, archived: !!t.archived, objective: t.objective, backlog: (t.backlog || []).filter((b) => b.status === 'open'), progress: (t.progress || []).slice(-10), contextDir: t.contextDir } });
  } catch (e) { res.status(404).json({ error: e.message }); }
});
app.post('/api/agent/task-progress', (req, res) => {
  const hit = agentSession(req, res);
  if (!hit) return;
  if (!toolOn('Task')) return toolDisabled(res, 'vibespace-task progress');
  const gid = resolveAgentGroup(hit, req, res);
  if (!gid) return;
  try {
    const t = tasks.addProgress(gid, { note: req.body?.note, detail: req.body?.detail, session: sessionStatusKey(hit[0], hit[1]) });
    res.json({ success: true, progress: t.progress.slice(-3) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// (Removed /api/agent/task-status — a Task Group has no status. A session
// reports its own state via /api/agent/session-status (vibespace-status).)
// (Removed /api/agent/task-plan — the group-level checklist was cut in
// 2.121.0. Old vibespace-task copies — e.g. on remote hosts — may still call
// it; answer 410 with guidance instead of a confusing 404.)
app.post('/api/agent/task-plan', (req, res) => {
  const hit = agentSession(req, res);
  if (!hit) return;
  res.status(410).json({ error: 'the Task Group checklist was removed — keep working steps in your own session todo list; log finished work with `vibespace-task progress "summary"`; park NON-immediate items (deferred decisions / future work) with `vibespace-task backlog-add "item"`' });
});
// Backlog (2.122.0; claim model 2.123.0): the group's parking lot for
// NON-immediate items — deferred user decisions, "later" work.
// add (auto-claims for the caller) / done / drop / claim / unclaim / show.
// Refs resolve by stable item id (B-xxxx — the user can copy one to ANY
// member agent), by 1-based index into the OPEN-items list (what
// `show`/`backlog` display), or by unique text substring.
app.post('/api/agent/task-backlog', (req, res) => {
  const hit = agentSession(req, res);
  if (!hit) return;
  if (!toolOn('Task')) return toolDisabled(res, 'vibespace-task backlog');
  const gid = resolveAgentGroup(hit, req, res);
  if (!gid) return;
  try {
    const t = tasks.get(gid);
    const backlog = (t.backlog || []).map((b) => ({ ...b, claimedBy: [...(b.claimedBy || [])] }));
    const { add, detail, done, drop, claim, unclaim, show, edit, text: newText } = req.body || {};
    const key = sessionStatusKey(hit[0], hit[1]);
    const findIdx = (ref, { openOnly = true } = {}) => {
      const pool = backlog.map((b, i) => [b, i]).filter(([b]) => !openOnly || b.status === 'open');
      if (typeof ref === 'string' && /^B-[0-9a-f]{4,8}$/i.test(ref.trim())) {
        const hitById = backlog.findIndex((b) => (b.id || '').toLowerCase() === ref.trim().toLowerCase());
        if (hitById >= 0) return hitById;
        return { err: `no backlog item with id ${ref.trim()}` };
      }
      const n = Number(ref);
      if (Number.isInteger(n) && n >= 1 && n <= pool.length) return pool[n - 1][1];
      const matches = pool.filter(([b]) => b.text.includes(String(ref)));
      if (matches.length === 1) return matches[0][1];
      return { err: matches.length ? 'ambiguous item — use its id or number from `vibespace-task backlog`' : 'no matching backlog item' };
    };
    if (typeof show === 'string' || typeof show === 'number') {
      const r = findIdx(show, { openOnly: false });
      if (typeof r !== 'number') return res.status(404).json({ error: r.err });
      return res.json({ success: true, item: backlog[r] }); // read-only — no update
    }
    let actedIdx = -1;      // claim/unclaim → echo the item + co-claimants back
    let alreadyMine = false; // idempotent re-claim
    if (typeof add === 'string' && add.trim()) {
      // parking auto-CLAIMS for the caller (user directive) — the parker is
      // the natural owner until it hands the item back
      backlog.push({ text: add.trim(), status: 'open', claimedBy: [key], ...(typeof detail === 'string' && detail.trim() ? { detail: detail.trim() } : {}), addedBy: key, addedAt: Date.now() });
    } else if (edit !== undefined) {
      // EDIT an existing item's text and/or detail in place (2.130.0) — the
      // id stays, so refs elsewhere survive and the diff surfaces as
      // "reworded" (id-matched), NOT a drop+new-id churn. At least one of
      // text/detail must be provided; empty text is rejected (an item needs a
      // one-line summary), empty detail ('' / '-') CLEARS the detail.
      const r = findIdx(edit, { openOnly: false });
      if (typeof r !== 'number') return res.status(400).json({ error: r.err });
      const hasText = typeof newText === 'string';
      const hasDetail = typeof detail === 'string';
      if (!hasText && !hasDetail) return res.status(400).json({ error: 'edit needs --text and/or --detail' });
      if (hasText) {
        if (!newText.trim()) return res.status(400).json({ error: 'item text cannot be empty' });
        backlog[r].text = newText.trim();
      }
      if (hasDetail) {
        const d = detail.trim();
        if (d === '' || d === '-') delete backlog[r].detail; else backlog[r].detail = d;
      }
      actedIdx = r;
    } else if (claim !== undefined || unclaim !== undefined) {
      const r = findIdx(claim !== undefined ? claim : unclaim);
      if (typeof r !== 'number') return res.status(400).json({ error: r.err });
      const b = backlog[r];
      if (claim !== undefined) {
        if (b.claimedBy.includes(key)) alreadyMine = true;
        else b.claimedBy.push(key);
      } else b.claimedBy = b.claimedBy.filter((k) => k !== key);
      actedIdx = r;
    } else if (done !== undefined || drop !== undefined) {
      const r = findIdx(done !== undefined ? done : drop);
      if (typeof r !== 'number') return res.status(400).json({ error: r.err });
      backlog[r].status = done !== undefined ? 'done' : 'dropped';
      backlog[r].resolvedBy = key;
      backlog[r].resolvedAt = Date.now();
    } else {
      return res.status(400).json({ error: 'need add, done, drop, claim, unclaim, or show' });
    }
    const updated = tasks.update(gid, { backlog });
    // claim ack carries the CO-CLAIMANTS (user directive: claiming must warn
    // when other sessions already hold the item, so agents coordinate)
    const acted = actedIdx >= 0 ? updated.backlog[actedIdx] : null;
    res.json({
      success: true,
      backlog: updated.backlog.filter((b) => b.status === 'open'),
      ...(acted ? { item: acted, others: (acted.claimedBy || []).filter((k) => k !== key), alreadyMine } : {}),
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Task Group ADMIN for designated MANAGER sessions (2.132.0, issue #21 —
// userW's majordomo/Jarvis flow: group create/update/bind is a routine
// agent-driven operation there). DOUBLE-GATED, both off by default:
//   1. setting agents.allowGroupManagement (user opt-in, Settings)
//   2. THIS session designated "Group manager" by the user (Session
//      Properties toggle → sessionConfigs[key].groupManager, user-state)
// Verbs mirror the UI's organize/present config ops — NO orchestration, no
// spawn, no delete (destructive stays user-only). contextDir/folders paths
// are restricted to allowlisted roots; every op is AUDITED into the group's
// activity log attributed to the calling session (visible on the board).
app.post('/api/agent/group-admin', (req, res) => {
  const hit = agentSession(req, res);
  if (!hit) return;
  const [s, id] = hit;
  const key = sessionStatusKey(s, id);
  try {
    if (!serverSetting('agents.allowGroupManagement')) {
      return res.status(403).json({ error: 'agent group management is disabled — the user can enable it (Settings → Integration → "Allow agents to manage Task Groups"), then designate this session as a Group manager in its Session Properties' });
    }
    if (!isManagerSession(key)) {
      return res.status(403).json({ error: 'this session is not a designated Group manager — ask the user to enable the "Group manager" toggle in this session\'s Properties (session key: ' + key + ')' });
    }
    // Path allowlist: contextDir/folders must resolve under a configured root
    // (an agent must not be able to point injection at arbitrary paths).
    const roots = String(serverSetting('agents.groupManagementRoots') || '~').split(',')
      .map((r) => r.trim()).filter(Boolean)
      .map((r) => path.resolve(r.replace(/^~(?=$|\/)/, os.homedir())));
    const checkPath = (p, what) => {
      const abs = path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()));
      if (!roots.some((r) => abs === r || abs.startsWith(r.endsWith('/') ? r : r + '/'))) {
        throw new Error(`${what} must be under: ${roots.join(', ')} (setting agents.groupManagementRoots)`);
      }
      return abs;
    };
    const sanitizeFolders = (arr) => (Array.isArray(arr) ? arr : []).map((f) => ({
      path: checkPath(typeof f === 'string' ? f : f && f.path, 'folder'),
      recursive: typeof f === 'object' && f ? f.recursive !== false : true,
    }));
    const audit = (gid, note) => { try { tasks.addProgress(gid, { note, session: key }); } catch { } };
    const brief = (t) => ({ id: t.id, title: t.title, archived: !!t.archived, contextDir: t.contextDir || null, sessions: (t.sessions || []).length });
    const { create, update, bind, unbind, list } = req.body || {};
    if (list) return res.json({ success: true, groups: tasks.list().map(brief) });
    if (create && typeof create === 'object') {
      if (!create.title || !String(create.title).trim()) throw new Error('title required');
      const t = tasks.create({
        title: String(create.title),
        kind: 'task',
        objective: create.objective !== undefined ? String(create.objective) : undefined,
        contextDir: create.contextDir ? checkPath(create.contextDir, 'contextDir') : undefined,
        folders: create.folders !== undefined ? sanitizeFolders(create.folders) : undefined,
        color: create.color ? String(create.color) : undefined,
      });
      audit(t.id, '[group-admin] group created by manager agent');
      return res.json({ success: true, group: brief(tasks.get(t.id)) });
    }
    if (update && update.id) {
      const patch = {};
      if (update.title !== undefined) patch.title = String(update.title);
      if (update.objective !== undefined) patch.objective = String(update.objective);
      if (update.color !== undefined) patch.color = String(update.color);
      if (update.archived !== undefined) patch.archived = !!update.archived;
      if (update.contextDir !== undefined) patch.contextDir = update.contextDir ? checkPath(update.contextDir, 'contextDir') : null;
      if (update.folders !== undefined) patch.folders = sanitizeFolders(update.folders);
      if (!Object.keys(patch).length) throw new Error('nothing to update — send title/objective/contextDir/folders/color/archived');
      tasks.update(update.id, patch);
      audit(update.id, `[group-admin] ${Object.keys(patch).join('+')} updated by manager agent`);
      return res.json({ success: true, group: brief(tasks.get(update.id)) });
    }
    if (bind && bind.id) {
      const sk = String(bind.sessionKey || key);
      tasks.bind(bind.id, sk);
      audit(bind.id, `[group-admin] session ${sk} bound by manager agent`);
      return res.json({ success: true, group: brief(tasks.get(bind.id)) });
    }
    if (unbind && unbind.id) {
      const sk = String(unbind.sessionKey || key);
      tasks.unbind(unbind.id, sk);
      audit(unbind.id, `[group-admin] session ${sk} unbound by manager agent`);
      return res.json({ success: true, group: brief(tasks.get(unbind.id)) });
    }
    return res.status(400).json({ error: 'need create, update, bind, unbind, or list' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Hook install management (Manage Agents dialog — auto-registers at boot,
// this surfaces status + one-click repair/remove for non-engineers) ──

// ── Background Work (2.342.0): agent-facing job endpoints ──────────────────
// Auth: vsst_ session token (full caller) OR jbt_ job token (job-scoped: the
// process may act on ITSELF only). Uniform not-found on invisible ids — no
// existence oracle.
function jobsCaller(s, id) {
  const key = sessionStatusKey(s, id);
  return {
    conversationId: key.startsWith('webui:') ? null : key.slice(key.indexOf(':') + 1),
    sessionId: id, sessionCreatedAt: s.createdAt || 0,
    groups: new Set(tasks.groupsForSession({ sessionKey: key, cwd: s.cwd, initialGroupId: s._initialGroupId }).map((g) => g.id)),
  };
}
function jobAuth(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.body?.token;
  const jm = getJobs && getJobs();
  if (!jm) { res.status(503).json({ error: 'jobs engine not available' }); return null; }
  if (!jm.ready) { res.status(503).json({ error: jm.initError ? `jobs engine down: ${jm.initError}` : 'jobs engine starting — retry shortly' }); return null; }
  if (token && token.startsWith('jbt_')) {
    const job = jm.jobByToken(token);
    if (!job) { res.status(401).json({ error: 'unknown job token' }); return null; }
    return { jm, selfJob: job, caller: null };
  }
  const hit = agentSession(req, res);
  if (!hit) return null;
  if (!toolOn('Jobs')) { res.status(403).json({ error: 'the vibespace-job tool is disabled in Settings → Integration' }); return null; }
  return { jm, caller: jobsCaller(hit[0], hit[1]), session: hit[0], sessionId: hit[1] };
}
const jobModel = require('./job-model.js');
const { has: hasHarness, get: getHarness } = require('./harnesses');
/** S6: does this session's harness honour SessionStart hook output? (claude
 *  yes; codex runs the hook but ignores it — its teaching rides the wrapper's
 *  prompt-context path, so the seen-gates must not advance here.) Unknown
 *  harness ⇒ false (never silently treated as claude). */
const honoursSessionStart = (s) => { const b = s?.backend || 'claude'; return hasHarness(b) && !!getHarness(b).inject?.sessionStartHonoured; };
const NOT_VISIBLE = (ref) => `no job "${ref}" visible to this session — vibespace-job list`;
function findVisible(jm, caller, ref) {
  const all = [...jm.jobs.values()];
  const vis = caller ? jobModel.visibleJobs(all, caller) : [];
  return vis.find((j) => j.id === ref) || vis.find((j) => j.name === ref) || null;
}
// FULL manuals for every agent CLI, read on demand (owner design: budgeted
// teaching carries one pointer line; docs are served from THIS server's
// checkout so they always match the running version). Reading docs never
// depends on subsystem readiness or tool toggles — a manual is harmless.
// ── Agent-to-agent messaging — Communication Channels v1 (2.362.0, owner-
// designed ACL; docs/agent/msg-manual.md). Endpoints are conversations; the
// ACL (src/msg-acl.js, PURE) scopes by Task Group: same group = mutual reach,
// group externalVisibility / per-session msgReachability open a scope up
// (widening only). Delivery rides the shared ladder (conversation-deliver:
// local inbox → owning machine's daemon → stash-for-injection). This is a
// COORDINATION boundary, not a security one (same-OS-user agents could always
// reach the raw CLI sockets); it exists so groups stay quiet by default.
const msgAcl = require('./msg-acl.js');
// stash → injection block (drain-at-render; same accepted-lost stance as the
// jobs stash). Budgeted: 6 entries × 400 chars — the injection channel has a
// hard 10KiB wrap upstream.
function renderMsgStash(entries) {
  if (!entries || !entries.length) return '';
  const rows = entries.slice(-6).map((e) => `- [${new Date(e.ts).toISOString().slice(5, 16)}Z] from "${e.fromName || e.source || 'unknown'}": ${String(e.text || '').slice(0, 400)}`);
  const elided = entries.length > 6 ? `\n(${entries.length - 6} older message(s) elided)` : '';
  return `### Messages that arrived while this conversation was unreachable\n${rows.join('\n')}${elided}\n(reply with vibespace-msg send "<name>" "..." if a response is expected)`;
}
const _msgRate = new Map(); // senderCid|targetCid → {ts, text}
function _msgEndpoints(exceptId) {
  const out = [];
  for (const [tid, t] of activeSessions) {
    if (tid === exceptId) continue;
    const cid = t.claudeSessionId || t.backendSessionId;
    if (!cid) continue;
    const groups = (tasks.groupsForSession({ sessionKey: sessionStatusKey(t, tid), cwd: t.cwd, initialGroupId: t._initialGroupId }) || []).map((g) => g.id);
    out.push({ id: tid, t, cid, groups, reachability: t._msgReachability || null });
  }
  return out;
}
const _groupExtVis = (gid) => { try { return (tasks.get(gid) || {}).externalVisibility || 'none'; } catch { return 'none'; } };
const _myGroupIds = (s, id) => (tasks.groupsForSession({ sessionKey: sessionStatusKey(s, id), cwd: s.cwd, initialGroupId: s._initialGroupId }) || []).map((g) => g.id);
app.get('/api/agent/msg/peers', (req, res) => {
  const hit = agentSession(req, res);
  if (!hit) return;
  if (!integrationOnMaster()) return res.json({ peers: [] });
  const [s, id] = hit;
  const myGroups = _myGroupIds(s, id);
  const peers = [];
  for (const ep of _msgEndpoints(id)) {
    const lv = msgAcl.levelFor(ep, myGroups, _groupExtVis);
    if (!msgAcl.canSee(lv)) continue;
    const st = sessionStatus.get(sessionStatusKey(ep.t, ep.id)) || sessionStatus.get(`webui:${ep.id}`) || {};
    peers.push({
      name: ep.t.name || null, conversationId: ep.cid, level: lv,
      groups: ep.groups, state: st.state || null, stateReason: st.reason || null,
      machine: ep.t.host || null, mode: ep.t.mode || null,
    });
  }
  res.json({ peers });
});
app.post('/api/agent/msg/send', async (req, res) => {
  const hit = agentSession(req, res);
  if (!hit) return;
  if (!integrationOnMaster()) return res.status(403).json({ error: 'VibeSpace integration is off' });
  const [s, id] = hit;
  const to = String(req.body?.to || '').trim();
  const text = String(req.body?.text || '');
  if (!to || !text.trim()) return res.status(400).json({ error: 'need {to, text}' });
  if (Buffer.byteLength(text, 'utf-8') > 16 * 1024) return res.status(400).json({ error: 'message too large (16KB cap) — write a file and send its path instead' });
  const myCid = s.claudeSessionId || s.backendSessionId || null;
  const myGroups = _myGroupIds(s, id);
  // resolve name-or-cid among MESSAGEABLE endpoints only — an unknown or
  // merely-invisible target gets ONE uniform error (no existence oracle)
  const matches = _msgEndpoints(id).filter((ep) => ep.cid === to || (ep.t.name && ep.t.name === to));
  const reachable = matches.filter((ep) => msgAcl.canMessage(msgAcl.levelFor(ep, myGroups, _groupExtVis)));
  if (!reachable.length) return res.status(404).json({ error: 'no messageable session by that name/id (not found, not visible to you, or visible-only) — vibespace-msg list shows your reach' });
  if (reachable.length > 1) return res.status(400).json({ error: `ambiguous name — ${reachable.length} sessions match; use the conversation id from vibespace-msg list` });
  const target = reachable[0];
  if (target.cid === myCid) return res.status(400).json({ error: 'that is this session' });
  // flood floor: 30s per pair + identical text 10min (a delivered message
  // opens a BILLED turn on an idle receiver — never let two agents ping-pong)
  const rk = (myCid || id) + '|' + target.cid;
  const rate = _msgRate.get(rk) || {};
  if (rate.text === text && rate.ts && Date.now() - rate.ts < 600000) return res.status(429).json({ error: 'identical message within 10min — not resent' });
  if (rate.ts && Date.now() - rate.ts < 30000) return res.status(429).json({ error: 'rate floor: one message per target per 30s' });
  _msgRate.set(rk, { ts: Date.now(), text });
  if (_msgRate.size > 500) { const cut = Date.now() - 600000; for (const [k, v] of _msgRate) if (v.ts < cut) _msgRate.delete(k); }
  const fromName = s.name || 'unnamed session';
  const framed = `Message from session "${fromName}" (via vibespace-msg; reply: vibespace-msg send "${fromName}" "..."):\n${text}`;
  const r = deliver ? await deliver.deliverToConversation(target.cid, framed, { fromName, cardText: text, spendReason: 'peer-message' }) : { ok: false, reason: 'delivery not wired' };
  if (r.ok) return res.json({ delivered: true, lane: r.lane, peerName: r.peerName || target.t.name || null, machine: r.hostId || null });
  deliver?.stashFor(target.cid, { source: 'agent', fromName, text });
  res.json({ delivered: false, stashed: true, reason: r.reason || 'unreachable', note: 'queued — injected into that session on its next turn' });
});

const AGENT_DOC_TOPICS = { index: 'index-manual.md', jobs: 'background-work-manual.md', task: 'task-manual.md', status: 'status-manual.md', ask: 'ask-manual.md', msg: 'msg-manual.md', pages: 'pages-manual.md' };
const serveAgentDoc = (req, res, topic) => {
  // jbt_ (in-job) tokens may read docs too — a watch job's script legitimately
  // wants the manual; job tokens never pass agentSession, so check them first
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (bearer.startsWith('jbt_')) {
    const jm = getJobs && getJobs();
    if (!jm || !jm.jobByToken || !jm.jobByToken(bearer)) return res.status(401).json({ error: 'unknown job token' });
  } else {
    const hit = agentSession(req, res); if (!hit) return;
  }
  const file = AGENT_DOC_TOPICS[topic];
  if (!file) return res.status(404).json({ error: `no manual "${topic}" — topics: ${Object.keys(AGENT_DOC_TOPICS).join(' / ')}` });
  try { res.json({ success: true, text: require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'agent', file), 'utf-8') }); }
  catch (e) { res.status(500).json({ error: 'manual unavailable: ' + e.message }); }
};
app.get('/api/agent/docs/:topic', (req, res) => serveAgentDoc(req, res, req.params.topic));
app.get('/api/agent/jobs-docs', (req, res) => serveAgentDoc(req, res, 'jobs')); // 2.350.0 alias

// ── Published pages + design kit (2.366.0): the "publish to VibeSpace" half
//    of the design-canvas flow — any self-contained HTML qualifies. Auth:
//    vsst_ (session) or jbt_ (job). Content rides the request body (the
//    source file may live on a remote host), upsert identity = host:path. ──
const pageAuth = (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token.startsWith('jbt_')) {
    const jm = getJobs && getJobs();
    const job = jm && jm.ready ? jm.jobByToken(token) : null;
    if (!job) { res.status(401).json({ error: 'unknown job token' }); return null; }
    return { sessionId: null, conversationId: (job.owner && job.owner.conversation && job.owner.conversation.id) || null, hostId: job.hostId || null, jobId: job.id }; // the job's OWNER conversation (jobs.js shape) — review-caught
  }
  const hit = agentSession(req, res);
  if (!hit) return null;
  return { session: hit[0], sessionId: hit[1], conversationId: hit[0].claudeSessionId || null, hostId: hit[0].host || null };
};
const express = require('express');
app.post('/api/agent/pages/publish', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  const a = pageAuth(req, res); if (!a) return;
  const publishedPages = getPublishedPages(); // lazy: created later in server.js than this wiring (TDZ otherwise — caught by the design-flow E2E)
  if (!publishedPages) return res.status(503).json({ error: 'published pages not available on this server' });
  const q = req.query || {};
  const srcPath = String(q.path || '');
  const srcKey = `${a.hostId || 'local'}:${srcPath || ('session:' + (a.sessionId || ('job-' + (a.jobId || 'unknown'))))}`;
  // visibility: only an EXPLICIT public=0|1 changes it — a republish without
  // the flag keeps what the user set in the popover (review-caught)
  const makePublic = (q.public === undefined || q.public === '') ? undefined : (q.public === '1' || q.public === 'true');
  // NO req: an agent has no browser, so the share URL must not borrow this
  // request's Host (a CLI on the hub sends Host: 127.0.0.1 / the box's own
  // hostname — both resolve nowhere else; 2.366.0 shipped exactly that link
  // to the owner). publicUrl or the relative path, and the CLI says so.
  const r = publishedPages.publishContent({ html: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), name: String(q.title || q.name || ''), srcKey, makePublic, sessionId: a.sessionId, conversationId: a.conversationId });
  if (r.error) return res.status(400).json(r);
  res.json(r); // no origin: an agent has no browser, and the server must not guess one (2.366.1)
});
app.get('/api/agent/pages', (req, res) => {
  const a = pageAuth(req, res); if (!a) return;
  const publishedPages = getPublishedPages();
  if (!a.sessionId && !a.conversationId) return res.json({ pages: [] }); // a caller with no scope sees nothing (no all-pages oracle — review-caught)
  res.json({ pages: publishedPages ? publishedPages.list({ sessionId: a.sessionId || undefined, conversationId: a.conversationId || undefined }) : [] });
});
app.get('/api/agent/design-kit', async (req, res) => {
  const a = pageAuth(req, res); if (!a) return;
  const designKit = getDesignKit();
  if (!designKit) return res.json({ ok: false, error: 'design kit not available on this server' });
  const k = await designKit.ensure();
  res.json({ ok: !!k.ok, version: k.version || null, source: k.source || null, dir: k.dir || null, files: k.files || {}, error: k.error || null });
});
app.get('/api/agent/design-kit/file/:name', (req, res) => {
  const a = pageAuth(req, res); if (!a) return;
  const designKit = getDesignKit();
  const fp = designKit && designKit.fileFor(String(req.params.name));
  if (!fp) return res.status(404).json({ error: 'no such kit file (or the kit is not ready — vibespace-page kit says why)' });
  res.type(fp.endsWith('.mjs') ? 'text/javascript' : fp.endsWith('.md') ? 'text/markdown' : 'text/html');
  res.sendFile(fp);
});
app.post('/api/agent/jobs', (req, res) => {
  const a = jobAuth(req, res); if (!a) return;
  if (a.selfJob) return res.status(403).json({ error: 'a job token cannot create jobs' });
  const b = req.body || {};
  const spec = {
    kind: b.kind, name: b.name, note: b.note, cmd: b.cmd, envFrom: b.envFrom,
    restart: b.restart, health: b.health, ports: b.ports, publish: b.publish,
    singleInstance: b.singleInstance, timeoutMs: b.timeoutMs, untilOutput: b.untilOutput,
    stdinOpen: b.stdinOpen, notifyUser: b.notifyUser, schedule: b.schedule,
    catchUp: b.catchUp, action: b.action, context: b.context, access: b.access,
    stopWithOwner: b.stopWithOwner, notify: b.notify,
    owner: {
      conversation: a.caller.conversationId ? { id: a.caller.conversationId } : null,
      sessionId: a.sessionId, sessionCreatedAt: a.session.createdAt || 0,
      createdBy: 'agent', groupsSnapshot: [...a.caller.groups],
    },
  };
  if (!spec.cmd && b.action && b.action.type === 'spawn-task') { /* notify-cron / cron shapes carry cmd inside action */ }
  else if (!spec.cmd && b.action && b.action.type === 'notify') { /* pure notify cron */ }
  else if (!spec.cmd) return res.status(400).json({ error: 'cmd required' });
  const r = a.jm.create(spec, a.caller);
  if (r.error) return res.status(400).json({ error: r.error });
  // Tell the creating agent up front whether ITS conversation will hear back
  // (owner request 2.344.0): honest three-state — live message / stash-at-
  // resume / off, with the deciding layer named.
  let notify = null;
  try { notify = a.jm.notifyPreview(a.jm.jobs.get(r.job.id)); } catch { }
  res.json({ success: true, job: r.job, renamed: r.renamed, notify });
});
app.get('/api/agent/jobs', (req, res) => {
  const a = jobAuth(req, res); if (!a) return;
  let list = a.selfJob ? [a.selfJob] : jobModel.visibleJobs([...a.jm.jobs.values()], a.caller);
  // ?mine=1 → owned by this conversation · ?subscribed=1 → this conversation subscribed
  if (!a.selfJob && req.query.mine) list = list.filter((j) => jobModel.isOwner(j, a.caller));
  if (!a.selfJob && req.query.subscribed) list = list.filter((j) => (j.subscribers || []).some((s) => s.conversationId === a.caller.conversationId));
  res.json({
    success: true,
    jobs: list.map((j) => ({
      ...a.jm.snapshot(j),
      mine: a.selfJob ? true : jobModel.isOwner(j, a.caller),
      mySubscription: a.selfJob ? null : (j.subscribers || []).find((s) => s.conversationId === a.caller.conversationId) || null,
    })),
  });
});
app.get('/api/agent/jobs/:ref', async (req, res) => {
  const a = jobAuth(req, res); if (!a) return;
  const ref = req.params.ref;
  const job = a.selfJob ? (a.selfJob.id === ref || a.selfJob.name === ref || !ref ? a.selfJob : null) : findVisible(a.jm, a.caller, ref);
  if (!job) {
    // 2.343.4: boot-collapse tombstone — redirect ONLY when the caller could see
    // the survivor anyway (no-existence-oracle: an invisible family stays a plain 404)
    const kept = !a.selfJob && a.jm._collapsed && a.jm._collapsed.get(ref);
    if (kept && findVisible(a.jm, a.caller, kept)) return res.status(404).json({ error: `run record ${ref} was consolidated into ${kept} (cron runs now share one record) — vibespace-job poll ${kept}` });
    return res.status(404).json({ error: NOT_VISIBLE(ref) });
  }
  const wait = Math.min(Number(req.query.wait) || 0, 600) * 1000;
  if (wait && !jobModel.isTerminal(job) && !(req.query.answers && (job.interaction.answers || []).length)) {
    await a.jm.waitFor(req.query.answers ? a.jm.ansWaiters : a.jm.waiters, job.id, wait);
  }
  res.json({
    success: true,
    job: {
      ...a.jm.snapshot(job, { tail: Math.min(Number(req.query.tail) || 0, 400) }),
      mine: a.selfJob ? true : jobModel.isOwner(job, a.caller),
      mySubscription: a.selfJob ? null : (job.subscribers || []).find((s) => s.conversationId === a.caller.conversationId) || null,
    },
  });
});
app.post('/api/agent/jobs/:ref/:act', (req, res) => {
  const a = jobAuth(req, res); if (!a) return;
  const { ref, act } = req.params;
  const job = a.selfJob ? (a.selfJob.id === ref || a.selfJob.name === ref ? a.selfJob : null) : findVisible(a.jm, a.caller, ref);
  if (!job) return res.status(404).json({ error: NOT_VISIBLE(ref) });
  const selfActs = ['progress', 'ask', 'announce'];
  if (a.selfJob && !selfActs.includes(act)) return res.status(403).json({ error: 'a job token may only report progress, ask, or announce' });
  const needsControl = ['stop', 'start', 'rm', 'announce']; // announce puts text in front of the owner+subscribers — view alone doesn't grant that
  if (!a.selfJob && needsControl.includes(act) && !jobModel.canControl(job, a.caller)) return res.status(404).json({ error: NOT_VISIBLE(ref) });
  if (!a.selfJob && (act === 'access' || act === 'notify')) {
    if (!jobModel.canEdit(job, a.caller)) return res.status(404).json({ error: NOT_VISIBLE(ref) });
    if (act === 'access' && job.access && job.access.lockedBy === 'user') return res.status(403).json({ error: "the user pinned this job's access — ask in chat instead of changing it" });
  }
  try {
    let r;
    if (act === 'stop') r = a.jm.stop(job, { force: !!req.body?.force });
    else if (act === 'start') r = a.jm.start(job);
    else if (act === 'rm') r = a.jm.rm(job, { stop: !!req.body?.stop, orphan: !!req.body?.orphan });
    else if (act === 'progress') r = a.jm.progress(job, req.body?.text || '');
    else if (act === 'ask') r = a.jm.ask(job, req.body?.panel);
    else if (act === 'access') {
      for (const k of ['view', 'control']) if (req.body?.[k] && ['session', 'group', 'all'].includes(req.body[k])) job.access[k] = req.body[k];
      a.jm._touch(job); a.jm._save(); r = { ok: true };
      return res.json({ success: true, access: job.access });
    }
    else if (act === 'subscribe') r = a.jm.subscribe(job, a.caller, { filter: req.body?.filter });   // canView already proven by findVisible
    else if (act === 'unsubscribe') r = a.jm.unsubscribe(job, a.caller);
    else if (act === 'announce') r = a.jm.announce(job, req.body?.text); // in-job (jbt_) or any viewer — the watch-job "found something" verb
    else if (act === 'notify') {
      // owner-only post-create override (2.344.2 — field report: changing
      // notify used to require rm + recreate)
      const v = req.body?.value;
      if (!['on', 'off', 'inherit'].includes(v)) return res.status(400).json({ error: 'value must be on|off|inherit' });
      job.notify = v === 'inherit' ? undefined : v;
      a.jm._touch(job); a.jm._save();
      return res.json({ success: true, notify: job.notify || 'inherit', preview: (() => { try { return a.jm.notifyPreview(job); } catch { return null; } })() });
    }
    else return res.status(400).json({ error: `unknown action "${act}"` });
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ success: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
}

module.exports = { setupAgentRoutes };
