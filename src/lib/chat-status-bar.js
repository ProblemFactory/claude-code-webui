import { escHtml, showInputDialog, uiScale, showToast, fetchJson, copyText, absUrl } from './utils.js';
import { UI_ICONS } from './icons.js';
import { BACKEND_META, getBackendMeta, backendFeatureCaps, effortDisplay, effortLabel, noteModelCatalog, responseStyleLabel, responseStyleCaps, styleAppliesLive } from './agent-meta.js';
import { t } from './i18n.js';

/**
 * ChatStatusBar — status bar for chat mode sessions.
 * Shows model, permission mode, background tasks, context usage, cache ratio, cost.
 */
export class ChatStatusBar {
  /**
   * @param {object} ws - WsManager instance
   * @param {string} sessionId - session identifier
   * @param {object} opts
   * @param {string} [opts.backend] - backend identifier
   * @param {function} opts.getToolMsg - (toolCallId) => msg, looks up tool message for popup details
   * @param {function} opts.openSubagentViewer - ({ parentToolUseId, description }) => void
   * @param {function} opts.openInTempEditor - (text) => void
   * @param {function} [opts.startReview] - ({ target, delivery }) => void
   */
  constructor(ws, sessionId, { backend = 'claude', allowReview = false, getToolMsg, openSubagentViewer, openInTempEditor, startReview, onConfigChange, onOpenWorkflow, getWorkflowIds, onDesignRequest = null, onRestartSession = null }) {
    this._ws = ws;
    this._onDesignRequest = onDesignRequest; // 2.366.0 design chip (null = view-only window: no chip)
    this._outputStyle = '';        // CLI output style (Concise/…) — what the LIVE session is running with
    // Does the RUNNING WRAPPER serve the live style verb? undefined = not told
    // yet (the 'created' payload cannot know), false = it refused / its sidecar
    // says no. Harness caps alone are not enough — see styleAppliesLive.
    this._responseStyleLive = undefined;
    this._autoResume = null;       // {enabled, explicit, globalDefault, armed, resetsAt} from the server
    this._pages = []; // pages published from this session (server truth via /api/pages + page-published)
    this._sessionId = sessionId;
    this._backend = backend;
    this._onConfigChange = onConfigChange || null;
    this._onRestartSession = onRestartSession || null;
    this._servedModel = null; // actual serving model (per-turn) — fallback detection
    this._allowReview = allowReview;
    this._reviewEnabled = !allowReview;
    this._getToolMsg = getToolMsg;
    this._openSubagentViewer = openSubagentViewer;
    this._openInTempEditor = openInTempEditor;
    this._startReview = startReview || (() => {});
    this._onOpenWorkflow = onOpenWorkflow || null;
    this._getWorkflowIds = getWorkflowIds || (() => ({}));

    // Status state
    this._statusModel = '';
    this._statusLastInputTokens = 0;
    this._statusLastCacheRead = 0;
    this._statusCost = 0;
    this._statusContextWindow = 0;
    this._statusPermMode = '';
    this._statusEffort = '';      // applies from the NEXT turn (what the chip shows)
    this._statusEffortLive = '';  // what the running / last turn actually ran at
    // seeded per backend (BACKEND_META.permissionModes) so an early click never
    // offers claude modes on a codex chat; the live list overrides on status
    this._permissionModes = BACKEND_META[backend]?.permissionModes ? [...BACKEND_META[backend].permissionModes] : null;
    this._activeTasks = null;
    this._goal = null;
    this._goalElapsed = 0;
    this._goalStatus = null;

    // Container reference (set via popupContainer setter for dropdown positioning)
    this._popupContainer = null;

    // Build DOM
    this._element = document.createElement('div');
    this._element.className = 'chat-status-bar';

    // Click handlers
    this._element.addEventListener('click', (e) => {
      this._onClick(e);
    });
  }

  /** The .chat-status-bar element */
  dispose() {
    this._disposed = true;
    if (this._wfTimer) { clearTimeout(this._wfTimer); this._wfTimer = null; }
  }

  get element() { return this._element; }



  /** Available permission modes */
  get permissionModes() { return this._permissionModes; }


  /** Set the container for popup positioning (the .chat-view element) */
  set popupContainer(el) { this._popupContainer = el; }

  /** Remote transport state (2.125.0): the ssh pipe to the host-side keeper
      is reconnecting — the REMOTE session itself is fine, nothing is lost.
      Amber chip while reconnecting; cleared the moment bytes flow again. */
  setRemoteState(rs) {
    const key = rs && rs.state === 'reconnecting' ? `r${rs.attempts || 0}` : (rs && rs.state === 'unprotected' ? 'u' : '');
    if (key === this._remoteKey) return;
    this._remoteKey = key;
    this._remoteState = key ? rs : null;
    this.render();
  }

  /** Billing identity chip (mobile — windows have no title bar there, so the
      title-bar badge's click-to-switch has no home; this is its stand-in). */
  setBilling(auth, onSwitch) {
    if (onSwitch) this._onBillingSwitch = onSwitch;
    const key = auth ? `${auth.source}:${auth.name || ''}` : '';
    if (key === this._billingKey) return;
    this._billingKey = key;
    this._billing = auth;
    this.render();
  }

  // ── Public API ──

  applyStatus(status) {
    if (!status) return;
    if (status.model) this._statusModel = status.model; // as reported — no stripping, no guessing
    if (status.contextWindow) this._statusContextWindow = status.contextWindow;
    if (status.lastUsage) {
      const u = status.lastUsage;
      this._statusLastInputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      this._statusLastCacheRead = u.cache_read_input_tokens || 0;
    }
    if (status.total_cost_usd) this._statusCost = status.total_cost_usd;
    if (status.permissionMode) this._statusPermMode = status.permissionMode;
    if (status.permissionModes) this._permissionModes = status.permissionModes;
    // TWO effort facts (2.369.61): the chip shows what applies GOING FORWARD
    // (`effortNext` — which is also what the optimistic click below sets), the
    // tooltip names the running turn's own value when it differs. A store that
    // only knows one of them (claude: the last COMMANDED value) still sets both.
    if (status.effort) this._statusEffortLive = status.effort;
    if (status.effortNext !== undefined && status.effortNext !== null) this._statusEffort = status.effortNext || '';
    else if (status.effort) this._statusEffort = status.effort;
    if (status.modelLocked != null) this._modelLocked = !!status.modelLocked;
    // 'in' not truthy: the server always sends lockedModel (null after an
    // unlock) — a truthy guard left other clients showing the stale target
    if ('lockedModel' in status) this._lockedModel = status.lockedModel || null;
    if (status.sandbox) this._statusSandbox = status.sandbox;
    if (status.totalUsage) this._statusTotalUsage = status.totalUsage;
    this.render();
  }

  updateUsage(usageData) {
    const u = usageData;
    this._statusLastInputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    this._statusLastCacheRead = u.cache_read_input_tokens || 0;
    if (u.totals) this._statusTotalUsage = u.totals; // Codex: cumulative session usage
    // Codex live sessions learn the window from token_count events — without
    // this a freshly-created session showed "123k/?" until the next re-attach
    // (2.368.15, owner: "context length为啥无法获取到").
    if (u.contextWindow) this._statusContextWindow = u.contextWindow;
    this.render();
  }

  /** LIVE effort update (2.369.61) — the normalizer's `meta/effort` op, fired
   *  by every carrier of the two facts (a turn's own turn_context, the
   *  wrapper's status record, codex's thread_settings_applied). Without this
   *  the chip only moved on the clicking client's optimistic write, and a
   *  `/effort` typed into the chat (or another attached client's pick) needed
   *  a re-attach to show. `live` null = this record says nothing about the
   *  running turn; leave what we knew. */
  setEffort(live, next) {
    if (live) this._statusEffortLive = String(live);
    if (next !== undefined) this._statusEffort = next ? String(next) : (live ? String(live) : '');
    this.render();
  }

  updateTask(taskInfo, toolCallId, content) {
    if (!this._activeTasks) this._activeTasks = new Map();
    if (taskInfo.status !== 'running') {
      // keep a short visible history (2.233.0, real report: 20 accumulated
      // rows with no way to tell what finished) — the popup shows a dim
      // "recently finished" tail with the outcome; the chip counts RUNNING
      const prev = this._activeTasks.get(toolCallId);
      if (prev) {
        if (!this._doneTasks) this._doneTasks = [];
        this._doneTasks.unshift({ ...prev, status: taskInfo.status, finishedAt: Date.now() });
        if (this._doneTasks.length > 12) this._doneTasks.length = 12;
      }
      this._activeTasks.delete(toolCallId);
    } else {
      const block = content?.[0];
      const task = { ...taskInfo };
      if (block?.type === 'tool_call') {
        task.toolName = block.toolName;
        task.command = block.input?.command || '';
      }
      this._activeTasks.set(toolCallId, task);
    }
    this.render();
  }

  // ── Running dynamic-workflow chips (2.81.0, user request: 状态栏可快速查看
  // 正在执行的工作流). Tracked from Workflow tool results ("Run ID: wf_…");
  // a light poll against /api/workflow keeps agent counts fresh and drops the
  // chip the moment the run leaves 'running'. Click → the workflow detail
  // window (live view). Poll only runs while chips exist.
  trackWorkflow(runId, name) {
    if (!runId) return;
    if (!this._workflows) this._workflows = new Map();
    if (this._workflows.has(runId)) return;
    this._workflows.set(runId, { runId, name: name || runId, agents: 0, done: 0, probed: false });
    this.render();
    this._pollWorkflows();
  }

  _pollWorkflows() {
    if (this._wfTimer || !this._workflows?.size) return;
    const tick = async () => {
      this._wfTimer = null;
      if (this._disposed || !this._workflows?.size) return;
      const ids = this._getWorkflowIds() || {};
      for (const [runId, wf] of [...this._workflows]) {
        try {
          const r = await fetch(`/api/workflow?runId=${encodeURIComponent(runId)}&claudeSessionId=${encodeURIComponent(ids.claudeId || '')}&cwd=${encodeURIComponent(ids.cwd || '')}${ids.host ? `&host=${encodeURIComponent(ids.host)}` : ''}`);
          if (r.status === 404) { this._workflows.delete(runId); continue; }
          const d = await r.json().catch(() => null);
          if (!d || (d.status && d.status !== 'running')) { this._workflows.delete(runId); continue; }
          wf.agents = d.agentCount || 0;
          wf.done = d.doneCount || 0;
          if (d.workflowName) wf.name = d.workflowName;
          wf.probed = true;
        } catch { /* transient — keep the chip */ }
      }
      this.render();
      if (this._workflows.size) this._wfTimer = setTimeout(tick, 8000);
    };
    this._wfTimer = setTimeout(tick, 1200);
  }

  setTasks(tasks) {
    const next = new Map();
    for (const [toolCallId, taskInfo] of Object.entries(tasks || {})) {
      if (taskInfo?.status === 'running') next.set(toolCallId, { ...taskInfo });
    }
    this._activeTasks = next.size ? next : null;
    this.render();
  }

  addCost(cost, modelUsage) {
    if (cost) { this._statusCost += cost; }
    if (modelUsage) {
      const info = Object.values(modelUsage)[0];
      if (info?.contextWindow) this._statusContextWindow = info.contextWindow;
      if (!this._statusModel) this._statusModel = Object.keys(modelUsage)[0] || '';
    }
    this.render();
  }

  setModel(model) {
    this._statusModel = model;
    this.render();
  }

  // Actual serving model from the latest assistant turn — when it diverges
  // from the commanded/reported one, the harness auto-fell-back (e.g. fable
  // overloaded → opus). Alias-tolerant compare ('fable' vs 'claude-fable-5').
  setServedModel(model) {
    if (this._servedModel === model) return;
    this._servedModel = model;
    this.render();
  }

  _modelMismatch() {
    if (!this._servedModel || !this._statusModel) return false;
    const core = (v) => String(v || '').replace(/\[1m\]$/, '').trim().replace(/^claude-/, '');
    const a = core(this._servedModel), b = core(this._statusModel);
    return !(a === b || a.startsWith(b) || b.startsWith(a));
  }

  setPermMode(mode) {
    this._statusPermMode = mode;
    // any authoritative set (ack, init sideEffect, attach) resolves the
    // in-flight optimistic pick — a stale prev otherwise corrupted a later
    // revert (review-confirmed multi-pick/multi-client scenarios)
    this._permModePrev = undefined;
    this.render();
  }

  /** Undo the optimistic dropdown pick after a refused set_permission_mode. */
  revertPermMode() {
    if (this._permModePrev !== undefined) {
      this._statusPermMode = this._permModePrev;
      this._permModePrev = undefined;
      this.render();
    }
  }

  setGoal(goal, elapsedMs) {
    if (goal) {
      this._goal = goal;
      if (elapsedMs) this._goalElapsed = elapsedMs;
    } else {
      this._goal = null;
      this._goalElapsed = 0;
      this._goalStatus = null;
    }
    this.render();
  }

  setGoalStatus(status) {
    this._goalStatus = status;
    this.render();
  }

  /** Pages published from this session (status-bar design chip + popover). */
  setPages(pages) { this._pages = Array.isArray(pages) ? pages.slice() : []; this.render(); this._refillDesignList(); }
  /** page-published broadcast: publish / republish / visibility change /
   *  removal (page.removed) — the chip AND an open popover list follow. */
  notePagePublished(page) {
    if (!page || !page.id) return;
    const i = this._pages.findIndex((p) => p.id === page.id);
    if (page.removed) { if (i >= 0) this._pages.splice(i, 1); }
    else if (i >= 0) this._pages[i] = page; else this._pages.push(page);
    this.render();
    this._refillDesignList();
  }
  _refillDesignList() {
    const list = this._designListEl;
    if (!list || !list.isConnected) return;
    list.replaceChildren();
    for (const p of this._pages.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) list.appendChild(this._designPageRow(p));
    list.classList.toggle('hidden', !this._pages.length);
  }

  /** What the live session was SPAWNED with (attach payload) + the pending-wait state. */
  setOutputStyle(v) { this._outputStyle = v || ''; this.render(); }
  /** A pick that has not taken effect yet (spawn-only key): shown on the chip
   *  so the choice is VISIBLY saved — 2.368.0 dropped it silently and the
   *  inert chip was the only symptom the owner had. */
  setOutputStylePending(v) { this._outputStylePending = v === undefined ? undefined : (v || ''); this.render(); }
  /** The RUNNING wrapper's own advert (attach payload) or the server's refusal
   *  — the second half of "can this session be re-styled live". */
  setResponseStyleLive(v) { this._responseStyleLive = (v === undefined || v === null) ? undefined : !!v; this.render(); }
  setAutoResume(st) { this._autoResume = st || null; this.render(); }

  setReviewEnabled(enabled) {
    this._reviewEnabled = !!enabled;
    this.render();
  }

  render() {
    const fmtK = (n) => n >= 1000000 ? (n / 1000000).toFixed(1) + 'm' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
    // Semantic tier colors — theme vars (CSS vars work in inline styles), never
    // hardcoded hexes; "orange" is the midpoint between the red and yellow tiers.
    const tierRed = 'var(--red, #e55)';
    const tierYellow = 'var(--yellow, #e5c07b)';
    const tierOrange = `color-mix(in srgb, ${tierRed} 50%, ${tierYellow})`;
    const tierGreen = 'var(--green, #3fb950)';
    const parts = [];

    // Model + effort badges — separate clickable segments, both ALWAYS
    // rendered: when a value hasn't been reported/commanded we say so
    // explicitly ("?") instead of hiding or guessing.
    {
      const known = !!this._statusModel;
      const mismatch = this._modelMismatch();
      const locked = !!this._modelLocked;
      const title = mismatch
        ? t('Auto-fallback: the harness is serving {served} instead of {model} (capacity/overload). Click to re-pick.', { served: this._servedModel, model: this._statusModel })
        : known
          ? t('Model (as last reported by the CLI) — click to change')
          : t('Model not reported by the CLI yet — click to set');
      const lockTip = locked ? ' \u00b7 ' + t('LOCKED — retries {model} after any fallback', { model: this._lockedModel || this._statusModel || '?' }) : '';
      const label = locked
        ? UI_ICONS.lock + (mismatch ? `\u26a0 ${escHtml(this._servedModel)}` : escHtml(this._statusModel || '?'))
        : (mismatch ? `\u26a0 ${escHtml(this._servedModel)}` : (known ? escHtml(this._statusModel) : t('model: ?')));
      parts.push(`<span class="chat-status-model chat-status-clickable${known ? '' : ' chat-status-dim'}${mismatch ? ' chat-status-model-fallback' : ''}${locked ? ' chat-status-model-locked' : ''}" title="${escHtml(title)}${escHtml(lockTip)}">${label}</span>`);
      const eKnown = !!this._statusEffort;
      // The DELEGATION mode reads as a downgrade unless the tooltip names the
      // level the model really reasons at (2.369.61 — codex 'ultra' runs the
      // model at the catalog's multi_agent_reasoning_effort, and every other
      // readout honestly says that level). The chip keeps the picked word.
      const eShown = effortDisplay(this._backend, this._statusEffort, { model: this._servedModel || this._statusModel });
      const eLive = this._statusEffortLive && this._statusEffortLive !== this._statusEffort
        ? effortDisplay(this._backend, this._statusEffortLive, { model: this._servedModel || this._statusModel })
        : '';
      const eTitle = eKnown
        ? (this._backend === 'codex'
          ? t('Reasoning effort (as reported per turn) — click to change (applies from the next turn)')
          : t('Reasoning effort (as last commanded — the CLI does not report it back) — click to change'))
        : t('Reasoning effort not set/reported — click to change');
      // Two lines, never one blended sentence: what the chip's value MEANS,
      // then what is actually in effect. The wording must be true whether or
      // not a turn is running (this bar has no streaming flag): a pick applies
      // from the NEXT turn, so the previous value stays in effect until one
      // starts — that is the same sentence in both states.
      const eFull = (eShown && eShown !== this._statusEffort ? eShown + ' · ' : '') + eTitle
        + (eLive ? '\n' + t('{effort} is still in effect until the next turn starts', { effort: eLive }) : '');
      parts.push(`<span class="chat-status-effort chat-status-clickable${eKnown ? '' : ' chat-status-dim'}" title="${escHtml(eFull)}">${eKnown ? escHtml(this._statusEffort) : t('effort: ?')}</span>`);
    }

    // Goal indicator — always rendered so there's a discoverable entry point
    // for SETTING a goal, not just viewing one (dim \u{1F3AF} when no goal active)
    if (this._goal) {
      const elapsed = this._fmtElapsed(this._goalElapsed || 0);
      // Codex sends lowercase active/paused/blocked/complete — normalize case
      const status = (this._goalStatus || '').toLowerCase();
      // Codex statuses beyond the basic four: usageLimited (rate limit hit —
      // resumes only via explicit reactivation), budgetLimited (token budget)
      const statusIcon = status === 'active' ? UI_ICONS.play : status === 'paused' ? UI_ICONS.pause : status === 'blocked' ? UI_ICONS.block : status === 'complete' ? UI_ICONS.check
        : status === 'usagelimited' ? UI_ICONS.hourglass : status === 'budgetlimited' ? UI_ICONS.coin : '';
      const statusHint = status === 'usagelimited' ? t(' — paused by usage limit, click → Continue Goal to resume')
        : status === 'budgetlimited' ? t(' — token budget exhausted, click → Continue Goal to resume') : '';
      const shortGoal = this._goal.length > 30 ? this._goal.substring(0, 30) + '…' : this._goal;
      parts.push(`<span class="chat-status-goal chat-status-clickable" title="${escHtml(this._goal + statusHint)}">${UI_ICONS.goal}${statusIcon ? ' ' + statusIcon : ''} <span class="chat-goal-timer">${elapsed}</span> ${escHtml(shortGoal)}</span>`);
    } else {
      parts.push(`<span class="chat-status-goal chat-status-goal-empty chat-status-clickable" title="${escHtml(t('Set a goal \u2014 the agent keeps working until the condition is met'))}">${UI_ICONS.goal}</span>`);
    }

    // Response style (2.368.0 outputStyle, generalized 2.369.58): the chip is
    // drawn for any harness whose caps row lists style VALUES, and the tooltip
    // tells the truth about WHEN a change lands — `live` harnesses (codex
    // personality via thread/settings/update) apply from the next turn, the
    // spawn-only ones (claude --settings outputStyle) need a restart. Never a
    // backend id.
    const feats = backendFeatureCaps(this._backend);
    const rsCaps = responseStyleCaps(this._backend);
    if (rsCaps.values.length) {
      const os = this._outputStyle;
      const pend = this._outputStylePending;
      // A pick that has not landed is PENDING for every harness — including a
      // live-capable one whose running wrapper refused the verb (r2 review: the
      // saved pick was then invisible AND unappliable).
      const liveNow = styleAppliesLive(rsCaps, this._responseStyleLive);
      const hasPend = pend !== undefined && (pend || '') !== (os || '');
      const label = hasPend ? escHtml(pend || t('agent default')) + ' ' + UI_ICONS.hourglass : escHtml(os || t('style: default'));
      const tip = hasPend
        ? (liveNow
          ? t('Response style \u201c{v}\u201d is saved for this conversation \u2014 the agent is still on {cur}; pick it again to apply it now', { v: pend || t('agent default'), cur: os || t('agent default') })
          : t('Response style \u201c{v}\u201d is saved and applies on the next resume (now running: {cur})', { v: pend || t('agent default'), cur: os || t('agent default') }))
        : rsCaps.live
          ? (os ? t('Response style: {v} \u2014 click to change it right now (applies from the next turn)', { v: os })
               : t('Response style: whatever this agent\u2019s own config says \u2014 click to pick one (applies from the next turn)'))
          : (os ? t('Response style: {v} \u2014 set at spawn; a change applies on the next resume', { v: os })
               : t('Response style: the agent default \u2014 click to pick (applies on the next resume)'));
      parts.push(`<span class="chat-status-style chat-status-clickable${(os || hasPend) ? '' : ' chat-status-dim'}" title="${escHtml(tip)}">${label}</span>`);
    }

    // Auto-continue after a usage limit (2.368.0): only ever shown for claude
    // chat; it turns loud (amber, with the time) once a wait is actually armed.
    if (feats.autoResume && this._autoResume) {
      const a = this._autoResume;
      const when = a.armed && a.resetsAt ? new Date(a.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const title = a.armed
        ? t('Usage limit hit — this session will continue by itself at {t}. Click to cancel.', { t: when })
        : (a.enabled ? t('Auto-continue is ON: if the quota runs out with no account to switch to, this session waits for the reset and continues. Click to turn off.')
          : t('Auto-continue is OFF: a usage limit leaves this session waiting for you. Click to turn on.'));
      // ON must LOOK on (owner: "几乎没有视觉反馈"): accent + a label, not a
      // one-shade opacity change. Icon is clock+play — the hourglass belongs
      // to the style chip next door (pending pick) and two adjacent
      // hourglasses meaning different things read as one broken widget.
      const arState = a.armed ? ' chat-status-autoresume-armed' : (a.enabled ? ' chat-status-autoresume-on' : ' chat-status-dim');
      const arLabel = a.armed ? ' ' + escHtml(when) : (a.enabled ? ' ' + escHtml(t('auto')) : '');
      parts.push(`<span class="chat-status-autoresume chat-status-clickable${arState}" title="${escHtml(title)}">${UI_ICONS.autoContinue}${arLabel}</span>`);
    }

    // Design canvas entry (2.366.0): rendered like the goal chip — the
    // discoverable way to ask for a design drafted by the agent and HOSTED
    // by this VibeSpace; the count = pages published from this session
    if (this._onDesignRequest) {
      const n = this._pages.length;
      const dTitle = n ? t('{n} page(s) published from this session — click to view or request a design', { n }) : t('Request a design canvas — drafted by the agent, hosted by this VibeSpace, shareable by link');
      parts.push(`<span class="chat-status-design chat-status-clickable${n ? '' : ' chat-status-design-empty'}" title="${escHtml(dTitle)}">${UI_ICONS.design}${n ? ` ${n}` : ''}</span>`);
    }

    // Remote reconnect chip — amber, only while the ssh pipe is down
    if (this._remoteState && this._remoteState.state === 'unprotected') {
      // B-0845: session predates the keeper (2.124.0) — claude hangs bare off
      // the ssh pipe; one network wobble kills it. Rebuild = terminate+resume.
      parts.push(`<span class="chat-status-remote" title="${escHtml(t('This session was created before disconnect protection existed — a network drop can kill it. Terminate and Resume the session to rebuild it protected.'))}">⚠ ${escHtml(t('no disconnect protection'))}</span>`);
    } else if (this._remoteState) {
      const n = this._remoteState.attempts || 0;
      // Name the concrete failure (2.228.1): "reconnecting (9)…" alone is
      // undiagnosable — the wrapper now forwards the transport child's last
      // stderr line (e.g. "connect to host X port 22: Connection timed out"),
      // which tells host-address problems apart from transient drops.
      const err = this._remoteState.lastError;
      const tip = t('The connection to the remote host dropped — reconnecting. The session keeps running on the host; nothing is lost.')
        + (err ? `\n${t('Last error:')} ${err}` : '');
      parts.push(`<span class="chat-status-remote" title="${escHtml(tip)}">⟳ ${escHtml(t('host reconnecting'))}${n > 1 ? ` (${n})` : ''}…</span>`);
    }

    // Billing identity chip — only rendered when fed (app gates it to mobile)
    if (this._billing) {
      const a = this._billing;
      const isApi = a.source === 'api-key' || a.source === 'api-console' || a.source === 'api-other';
      const isPooled = a.source === 'pooled';
      // remote session: its CLI login is the HOST's — name the machine.
      // codex bills the ChatGPT login, not the claude CLI's (2.368.16).
      const glogin = this._backend === 'codex' ? t('ChatGPT login') : t('CLI login');
      const label = a.source === 'unknown' ? '?'
        : isPooled ? '⣿ ' + (a.name || t('Pool')) + (a.poolTarget ? ' → ' + a.poolTarget : '')
        : (a.name || (isApi ? (a.source === 'api-console' ? 'Console' : 'API')
          : (a.hostName ? glogin + ' @ ' + a.hostName : glogin)));
      const tip = (isPooled ? t('Pooled account') + (a.poolTarget ? ' · ' + t('currently billing {name}', { name: a.poolTarget }) : ' · ' + t('no target'))
          : isApi ? t('API billing (pay per use)') : (a.hostName && !a.name ? t('"{name}"’s own CLI login', { name: a.hostName }) : t('Subscription account')))
        + (a.hostName && (a.name || isApi) ? ' · ' + t('on "{name}"', { name: a.hostName }) : '')
        + (a.guessed ? ' · ' + t('estimated from the login state at spawn') : '')
        + ' · ' + t('Click to switch billing');
      parts.push(`<span class="chat-status-billing chat-status-clickable${isApi ? ' api' : ''}${isPooled ? ' pooled' : ''}" title="${escHtml(tip)}">${escHtml(label)}</span>`);
    }

    // Permission mode (always show, click to change; Codex sandbox policy in tooltip)
    const permLabel = this._statusPermMode || 'default';
    const permTitle = this._statusSandbox ? t('Click to change permission mode \u00B7 sandbox: {sandbox}', { sandbox: this._statusSandbox }) : t('Click to change permission mode');
    parts.push(`<span class="chat-status-perm chat-status-clickable" title="${escHtml(permTitle)}">${UI_ICONS.lock} ${escHtml(permLabel)}</span>`);

    // Background tasks
    if (this._activeTasks?.size > 0) {
      const count = this._activeTasks.size;
      const tasks = [...this._activeTasks.values()];
      const label = count === 1 ? tasks[0].description : t('{count} tasks', { count });
      parts.push(`<span class="chat-status-tasks chat-status-clickable" title="${escHtml(tasks.map(t => t.description).join(', '))}">${UI_ICONS.refresh} ${escHtml(label)}</span>`);
    }

    // Running dynamic workflows — one chip; MULTIPLE collapse into a count
    // chip with a dropdown, like the tasks chip (owner: 多个workflow在运行
    // 也应该像tasks那样收起来).
    if (this._workflows?.size) {
      const wfs = [...this._workflows.values()];
      if (wfs.length === 1) {
        const wf = wfs[0];
        const prog = wf.probed && wf.agents ? ` ${wf.done}/${wf.agents}` : '';
        parts.push(`<span class="chat-status-wf chat-status-clickable" data-wf-run="${escHtml(wf.runId)}" data-wf-name="${escHtml(wf.name)}" title="${escHtml(t('Workflow running — click for the live view'))}">⛭ ${escHtml(String(wf.name).slice(0, 24))}${prog}</span>`);
      } else {
        const agents = wfs.reduce((n, w) => n + (w.agents || 0), 0);
        const done = wfs.reduce((n, w) => n + (w.done || 0), 0);
        parts.push(`<span class="chat-status-wf chat-status-wf-multi chat-status-clickable" title="${escHtml(wfs.map((w) => w.name).join(', '))}">⛭ ${escHtml(t('{count} workflows', { count: wfs.length }))}${agents ? ` ${done}/${agents}` : ''}</span>`);
      }
    }

    if (feats.review && this._allowReview) {
      const reviewClass = this._reviewEnabled ? 'chat-status-clickable' : 'chat-status-dim';
      const reviewTitle = this._reviewEnabled
        ? t('Start Codex review')
        : t('Review becomes available after the first completed assistant turn');
      parts.push(`<span class="chat-status-review ${reviewClass}" title="${escHtml(reviewTitle)}">\u2713 ${escHtml(t('Review'))}</span>`);
    }

    // Context: used tokens without a fake percentage when the window is unknown
    if (!this._statusContextWindow && this._statusLastInputTokens) {
      const usedK = fmtK(this._statusLastInputTokens);
      parts.push(`<span class="chat-status-ctx chat-status-dim" title="${escHtml(t('Context used last turn: {used} tokens. The context window size was not reported by the CLI, so no percentage is shown.', { used: usedK }))}">${escHtml(usedK)}/?</span>`);
    }
    // Context % with pie chart
    if (this._statusContextWindow && this._statusLastInputTokens) {
      const pct = Math.min(100, Math.round((this._statusLastInputTokens / this._statusContextWindow) * 100));
      const color = pct > 95 ? tierRed : pct > 85 ? tierOrange : pct > 70 ? tierYellow : tierGreen;
      const deg = Math.round(pct * 3.6);
      const usedK = fmtK(this._statusLastInputTokens);
      const totalK = fmtK(this._statusContextWindow);
      let ctxTitle = t('Context: {used} of {total} tokens', { used: usedK, total: totalK });
      if (this._statusTotalUsage) {
        const u = this._statusTotalUsage;
        ctxTitle += ' \u00B7 ' + t('session total: {total} (in {inp}, cached {cached}, out {out}{reasoning})', {
          total: fmtK(u.total_tokens || 0), inp: fmtK(u.input_tokens || 0), cached: fmtK(u.cached_input_tokens || 0),
          out: fmtK(u.output_tokens || 0), reasoning: u.reasoning_output_tokens ? t(', reasoning {n}', { n: fmtK(u.reasoning_output_tokens) }) : '',
        });
      }
      parts.push(`<span class="chat-status-ctx" title="${escHtml(ctxTitle)}"><span class="chat-status-ctx-pie" style="background:conic-gradient(${color} ${deg}deg, var(--bg-input) ${deg}deg)"></span> <span style="color:${color}">${pct}%</span><span class="chat-status-dim">[${usedK}/${totalK}]</span></span>`);
    }

    // Cache ratio
    if (this._statusLastCacheRead != null && this._statusLastInputTokens) {
      const cacheTotal = this._statusLastInputTokens;
      const cachePct = cacheTotal > 0 ? Math.round((this._statusLastCacheRead / cacheTotal) * 100) : 0;
      const cacheColor = cachePct >= 80 ? tierGreen : cachePct >= 50 ? tierYellow : tierOrange;
      const cacheTip = t('Prompt cache hit rate (last turn): {pct}% of input tokens were read from cache ({read} of {total}). Higher = cheaper + faster.', { pct: cachePct, read: fmtK(this._statusLastCacheRead), total: fmtK(cacheTotal) });
      parts.push(`<span style="color:${cacheColor}" title="${escHtml(cacheTip)}">${UI_ICONS.bolt}${cachePct}%</span><span class="chat-status-dim" title="${escHtml(cacheTip)}">[${fmtK(this._statusLastCacheRead)}]</span>`);
    }

    // Cost with color tiers
    if (this._statusCost > 0) {
      const costColor = this._statusCost > 5 ? tierRed : this._statusCost > 1 ? tierOrange : tierGreen;
      parts.push(`<span style="color:${costColor}">$${this._statusCost.toFixed(2)}</span>`);
    }

    this._element.innerHTML = parts.join(' ');
  }

  // ── Private ──

  /** Design popover (2.366.0): kit status · brief · public toggle · Create,
   *  then the pages published from this session (Open / Copy link / visibility).
   *  DOM built with textContent — page names are agent-chosen strings. */
  _renderDesignPopover(dropdown) {
    dropdown.style.minWidth = '300px';
    dropdown.style.maxWidth = '440px';
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:4px';
    const kitLine = document.createElement('div');
    kitLine.className = 'chat-design-kit';
    kitLine.textContent = t('Checking the design kit…');
    const ta = document.createElement('textarea');
    ta.className = 'chat-design-brief';
    ta.rows = 3;
    ta.placeholder = t('What should be designed? (a landing page, a poster, a settings screen…)');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
    const pubLabel = document.createElement('label');
    pubLabel.className = 'chat-design-public';
    const pubCb = document.createElement('input');
    pubCb.type = 'checkbox';
    pubLabel.append(pubCb, document.createTextNode(' ' + t('Public link (anyone with the link)')));
    const go = document.createElement('button');
    go.className = 'btn-create chat-design-go';
    go.textContent = t('Create design');
    go.onclick = () => {
      const brief = ta.value.trim();
      if (!brief) { ta.focus(); return; }
      dropdown.remove();
      this._onDesignRequest(brief, { public: pubCb.checked });
    };
    row.append(pubLabel, go);
    box.append(kitLine, ta, row);
    const list = document.createElement('div');
    list.className = 'chat-design-pages' + (this._pages.length ? '' : ' hidden');
    this._designListEl = list; // refilled in place on page-published while the popover is open
    box.appendChild(list);
    dropdown.appendChild(box);
    this._refillDesignList(); // AFTER the append: _refillDesignList bails on a
    // detached node (that guard exists for broadcasts arriving with no popover
    // open), so filling first left the chip saying "1" over an empty popover
    // — owner-caught. Guards must not sit on the path that has to run.
    // Kit status: a failed build shows its reason AND a Retry (the server also
    // retries stale failures on view); Create stays disabled until the kit is
    // ready so the user never sends a request known to fail.
    const paintKit = (k) => {
      if (!kitLine.isConnected) return;
      kitLine.replaceChildren();
      if (!k || (k.error && !k.version && k.ok === undefined)) { kitLine.textContent = t('Design kit: status unavailable'); return; }
      kitLine.append(document.createTextNode(k.ok ? t('Design kit ready (CLI {v})', { v: k.version }) : t('Design kit not ready: {err}', { err: k.error || '?' })));
      kitLine.classList.toggle('chat-design-kit-bad', !k.ok);
      go.disabled = !k.ok;
      go.title = k.ok ? '' : t('The design kit is not ready — fix the reason above or retry');
      if (!k.ok) {
        const retry = document.createElement('button');
        retry.className = 'btn-cancel chat-design-retry';
        retry.textContent = t('Retry');
        retry.onclick = () => { retry.disabled = true; kitLine.append(document.createTextNode(' …')); fetchJson('/api/design-kit/status?refresh=1').then(paintKit); };
        kitLine.append(document.createTextNode(' '), retry);
      }
    };
    go.disabled = true;
    fetchJson('/api/design-kit/status').then(paintKit);
    setTimeout(() => ta.focus(), 0);
  }

  _designPageRow(p) {
    const row = document.createElement('div');
    row.className = 'chat-design-page';
    const abs = (p) => absUrl(p.url || p.path); // the server's absolute URL wins; else the instance URL, else this browser's origin
    const name = document.createElement('span');
    name.className = 'chat-design-page-name';
    name.textContent = p.name || p.id;
    name.title = abs(p);
    const open = document.createElement('button');
    open.className = 'btn-cancel';
    open.textContent = t('Open');
    open.onclick = () => window.open(abs(p), '_blank', 'noopener');
    const copy = document.createElement('button');
    copy.className = 'btn-cancel';
    copy.textContent = t('Copy link');
    copy.onclick = () => { copyText(abs(p)); showToast(t('Link copied')); };
    const vis = document.createElement('button');
    vis.className = 'btn-cancel';
    const paint = () => {
      vis.textContent = p.public ? t('Public') : t('Private');
      vis.title = p.public ? t('Anyone with the link can view — click to make private') : t('Viewers must be logged in — click to make public');
    };
    paint();
    vis.onclick = async () => {
      const r = await fetchJson('/api/pages/' + encodeURIComponent(p.id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public: !p.public }) });
      if (!r || r.error) { showToast(t('Update failed: {err}', { err: (r && r.error) || 'network' }), { type: 'error' }); return; }
      if (r.page) { p.public = !!r.page.public; paint(); this.notePagePublished(r.page); }
    };
    row.append(name, open, copy, vis);
    return row;
  }

  _fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h${String(m % 60).padStart(2, '0')}m`;
  }

  _onClick(e) {
    const wfChip = e.target.closest('.chat-status-wf');
    if (wfChip && this._onOpenWorkflow && wfChip.dataset.wfRun) {
      this._onOpenWorkflow(wfChip.dataset.wfRun, wfChip.dataset.wfName);
      return;
    }
    const bChip = e.target.closest('.chat-status-billing');
    if (bChip && this._onBillingSwitch) {
      e.stopPropagation();
      this._onBillingSwitch(bChip);
      return;
    }
    const container = this._popupContainer || this._element.parentElement;
    const showDropdown = (anchor) => {
      const existing = container.querySelector('.chat-status-dropdown');
      if (existing) { existing.remove(); return null; }
      // The bottom/left math is relative to the container — which is only what
      // position:absolute resolves against if the container is itself
      // positioned. A static container silently re-anchors the dropdown to
      // some ancestor and it lands off-screen (invisible "dead" click).
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      const dropdown = document.createElement('div');
      dropdown.className = 'chat-status-dropdown';
      dropdown.dataset.popover = '1'; // app-wide Escape-dismiss protocol (app.js removes [data-popover])
      const rect = anchor.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      dropdown.style.position = 'absolute';
      dropdown.style.bottom = ((containerRect.bottom - rect.top + 4) / uiScale()) + 'px';
      dropdown.style.left = ((rect.left - containerRect.left) / uiScale()) + 'px';
      container.appendChild(dropdown);
      const close = (ev) => {
        if (!dropdown.contains(ev.target) && ev.target !== anchor) {
          dropdown.remove();
          document.removeEventListener('mousedown', close);
        }
      };
      setTimeout(() => document.addEventListener('mousedown', close), 0);
      return dropdown;
    };

    // Collapsed multi-workflow chip → dropdown, one row per run
    const wfMulti = e.target.closest('.chat-status-wf-multi');
    if (wfMulti && this._workflows?.size) {
      e.stopPropagation();
      const dropdown = showDropdown(wfMulti);
      if (!dropdown) return;
      for (const wf of this._workflows.values()) {
        const item = document.createElement('div');
        item.className = 'chat-status-dropdown-item chat-task-detail';
        const prog = wf.probed && wf.agents ? ` <span class="chat-status-dim">${wf.done}/${wf.agents}</span>` : '';
        item.innerHTML = `<div class="chat-task-title">⛭ ${escHtml(String(wf.name).slice(0, 48))}${prog}</div>`;
        item.onclick = (ev) => { ev.stopPropagation(); dropdown.remove(); this._onOpenWorkflow?.(wf.runId, wf.name); };
        dropdown.appendChild(item);
      }
      return;
    }
    // Background tasks click -> popup
    const taskEl = e.target.closest('.chat-status-tasks');
    if (taskEl && this._activeTasks?.size) {
      e.stopPropagation();
      const dropdown = showDropdown(taskEl);
      if (!dropdown) return;
      for (const [toolUseId, task] of this._activeTasks) {
        const item = document.createElement('div');
        item.className = 'chat-status-dropdown-item chat-task-detail';
        const icon = task.type === 'agent' ? UI_ICONS.robot : UI_ICONS.tasks;
        let detail = `<div class="chat-task-title">${icon} ${escHtml(task.description)}</div>`;
        if (task.lastTool) detail += `<div class="chat-status-dim">${escHtml(t('Running: {tool}', { tool: task.lastTool }))}</div>`;
        item.innerHTML = detail;
        item.onclick = (ev) => {
          ev.stopPropagation(); dropdown.remove();
          if (task.type === 'agent') {
            this._openSubagentViewer({
              parentToolUseId: toolUseId,
              threadId: task.receiverThreadIds?.[0] || '',
              description: task.description,
              agentRole: task.agentRole || '',
              agentNickname: task.agentNickname || '',
            });
          } else {
            // Open command input + output in editor
            const toolMsg = this._getToolMsg(toolUseId);
            const block = toolMsg?.content?.[0];
            const input = block?.input || {};
            const toolName = task.toolName || block?.toolName || 'Bash';
            const command = task.command || input.command || JSON.stringify(input, null, 2);
            const output = task.resultText || block?.output || '';
            let text = `[${toolName}] ${task.description}\n\n--- ${t('Command')} ---\n${command}\n`;
            if (output) text += `\n--- ${t('Output')} ---\n${output}\n`;
            this._openInTempEditor(text);
          }
        };
        dropdown.appendChild(item);
      }
      // Recently finished tail (2.233.0): outcome at a glance — the check/
      // cross prefix is the completion state the popup previously never showed
      if (this._doneTasks?.length) {
        const hdr = document.createElement('div');
        hdr.className = 'chat-status-dim chat-task-done-hdr';
        hdr.textContent = t('Recently finished');
        dropdown.appendChild(hdr);
        for (const dt of this._doneTasks.slice(0, 8)) {
          const row = document.createElement('div');
          row.className = 'chat-status-dropdown-item chat-task-detail chat-task-done';
          const ok = dt.status === 'completed';
          row.innerHTML = `<div class="chat-task-title">${ok ? '<span class="tdone-ok">✓</span>' : '<span class="tdone-bad">✗</span>'} ${escHtml(dt.description || '')}</div>`;
          row.title = ok ? t('completed') : escHtml(String(dt.status));
          dropdown.appendChild(row);
        }
      }
      return;
    }

    // Design chip → brief + public toggle + this session's published pages
    const designEl = e.target.closest('.chat-status-design');
    if (designEl && this._onDesignRequest) {
      e.stopPropagation();
      const dropdown = showDropdown(designEl);
      if (!dropdown) return;
      this._renderDesignPopover(dropdown);
      return;
    }

    // Goal click -> popup with full text + controls
    const goalEl = e.target.closest('.chat-status-goal');
    if (goalEl && this._goal) {
      e.stopPropagation();
      const dropdown = showDropdown(goalEl);
      if (!dropdown) return;
      dropdown.style.minWidth = '240px';
      dropdown.style.maxWidth = '400px';
      const content = document.createElement('div');
      content.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:4px';
      const text = document.createElement('div');
      text.style.cssText = 'font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--text)';
      text.textContent = this._goal;
      const elapsed = document.createElement('div');
      elapsed.style.cssText = 'font-size:11px;color:var(--text-dim)';
      const statusLabel = this._goalStatus ? ` · ${this._goalStatus}` : '';
      elapsed.textContent = t('Pursued for {time}', { time: this._fmtElapsed(this._goalElapsed || 0) }) + statusLabel;
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px';
      const isActive = (this._goalStatus || '').toLowerCase() === 'active';
      if (!isActive) {
        const continueBtn = document.createElement('button');
        continueBtn.className = 'chat-perm-btn chat-perm-allow';
        continueBtn.textContent = t('Continue Goal');
        continueBtn.onclick = () => {
          dropdown.remove();
          this._ws.send({ type: 'set-goal', sessionId: this._sessionId, goal: this._goal });
        };
        actions.append(continueBtn);
      }
      const clearBtn = document.createElement('button');
      clearBtn.className = 'chat-perm-btn chat-perm-deny';
      clearBtn.textContent = t('Clear');
      clearBtn.onclick = () => { dropdown.remove(); this._ws.send({ type: 'set-goal', sessionId: this._sessionId, goal: null }); };
      actions.append(clearBtn);
      content.append(text, elapsed, actions);
      dropdown.appendChild(content);
      return;
    }

    // No active goal → set-a-goal popup (the only entry point besides typing /goal)
    if (goalEl && !this._goal) {
      e.stopPropagation();
      const dropdown = showDropdown(goalEl);
      if (!dropdown) return;
      dropdown.style.minWidth = '280px';
      dropdown.style.maxWidth = '420px';
      const content = document.createElement('div');
      content.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:4px';
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:11px;color:var(--text-dim)';
      hint.textContent = t('The agent keeps working until this condition is met:');
      const input = document.createElement('textarea');
      input.className = 'filter-input chat-ask-custom'; // filter-input themes it like .chat-input (bg-input/border/radius/focus-accent)
      input.rows = 2;
      input.placeholder = t('e.g. all tests in tests/ pass');
      input.style.cssText = 'resize:vertical;font-size:12px;width:100%;margin:0';
      const submit = () => {
        const goal = input.value.trim();
        if (!goal) return;
        dropdown.remove();
        this._ws.send({ type: 'set-goal', sessionId: this._sessionId, goal });
      };
      input.onkeydown = (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submit(); } ev.stopPropagation(); };
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;align-items:center';
      const setBtn = document.createElement('button');
      setBtn.className = 'chat-perm-btn chat-perm-allow';
      setBtn.textContent = t('Set Goal');
      setBtn.onclick = submit;
      actions.append(setBtn);
      const resumeLink = document.createElement('button');
      resumeLink.className = 'chat-perm-btn';
      resumeLink.textContent = t('Resume previous');
      resumeLink.title = t('Re-activate the last cleared/completed goal');
      resumeLink.onclick = () => { dropdown.remove(); this._ws.send({ type: 'set-goal', sessionId: this._sessionId, action: 'resume' }); };
      actions.append(resumeLink);
      content.append(hint, input, actions);
      dropdown.appendChild(content);
      setTimeout(() => input.focus(), 0);
      return;
    }

    const reviewEl = e.target.closest('.chat-status-review');
    if (reviewEl && backendFeatureCaps(this._backend).review && this._allowReview && this._reviewEnabled) {
      e.stopPropagation();
      const dropdown = showDropdown(reviewEl);
      if (!dropdown) return;
      const reviewOptions = [
        { label: t('Working tree'), target: { type: 'uncommittedChanges' }, delivery: 'inline' },
        { label: t('Working tree (detached)'), target: { type: 'uncommittedChanges' }, delivery: 'detached' },
        { label: t('Base branch…'), kind: 'baseBranch', delivery: 'inline' },
        { label: t('Base branch… (detached)'), kind: 'baseBranch', delivery: 'detached' },
        { label: t('Commit…'), kind: 'commit', delivery: 'inline' },
        { label: t('Commit… (detached)'), kind: 'commit', delivery: 'detached' },
        { label: t('Custom…'), kind: 'custom', delivery: 'inline' },
        { label: t('Custom… (detached)'), kind: 'custom', delivery: 'detached' },
      ];
      for (const option of reviewOptions) {
        const item = document.createElement('div');
        item.className = 'chat-status-dropdown-item';
        item.textContent = option.label;
        item.onclick = async (ev) => {
          ev.stopPropagation();
          dropdown.remove();
          let target = option.target || null;
          if (option.kind === 'baseBranch') {
            const branch = await showInputDialog({ title: t('Review vs Branch'), label: t('Base branch to review against'), value: 'main', confirmText: t('Review') });
            if (!branch) return;
            target = { type: 'baseBranch', branch: branch.trim() };
          } else if (option.kind === 'commit') {
            const sha = await showInputDialog({ title: t('Review Commit'), label: t('Commit SHA to review'), confirmText: t('Review') });
            if (!sha) return;
            target = { type: 'commit', sha: sha.trim() };
          } else if (option.kind === 'custom') {
            const instructions = await showInputDialog({ title: t('Custom review'), label: t('Review instructions'), confirmText: t('Review'), multiline: true });
            if (!instructions) return;
            target = { type: 'custom', instructions: instructions.trim() };
          }
          if (!target) return;
          this._startReview({ target, delivery: option.delivery || 'inline' });
        };
        dropdown.appendChild(item);
      }
      return;
    }

    // Effort click -> dropdown (mid-session reasoning-effort switch)
    const arEl = e.target.closest('.chat-status-autoresume');
    if (arEl) {
      e.stopPropagation();
      const on = !(this._autoResume && (this._autoResume.armed || this._autoResume.enabled));
      this._ws.send({ type: 'auto-resume', sessionId: this._sessionId, enabled: on });
      this._onConfigChange?.({ autoResume: on });   // survives the next resume
      showToast(on ? t('Auto-continue on: this session will resume itself when the limit resets')
        : t('Auto-continue off'));
      return;
    }

    const styleEl = e.target.closest('.chat-status-style');
    if (styleEl) {
      e.stopPropagation();
      const dropdown = showDropdown(styleEl);
      if (!dropdown) return;
      // The rows ARE the harness's own vocabulary (backend-caps mirror) — the
      // menu never carries a hardcoded list, so a harness that adds a value
      // gets it here for free. The empty row is "no choice": the key is not
      // sent at all and the agent's own config decides.
      const caps = responseStyleCaps(this._backend);
      const STYLES = [{ v: '', label: t('agent default') }, ...caps.values.map((v) => ({ v, label: responseStyleLabel(this._backend, v) }))];
      // rebuildable so a pick can surface the restart row IN PLACE (owner UX
      // 2.369.8: "切换了style还没重启, 在菜单里给个重启按钮")
      const renderStyleRows = () => {
        dropdown.innerHTML = '';
        const pending = this._outputStylePending;
        // The restart row exists whenever THIS SESSION cannot take the change
        // live — the harness caps row AND the running wrapper's advert, never a
        // backend id (2.369.58: gating on caps alone left every codex session
        // that predates the live switch with a refusal, no restart row, and an
        // invisible saved pick).
        if (!styleAppliesLive(caps, this._responseStyleLive) && this._onRestartSession && pending !== undefined && (pending || '') !== (this._outputStyle || '')) {
          const go = document.createElement('div');
          go.className = 'chat-status-dropdown-item chat-status-restart-row';
          go.textContent = '\u27F3 ' + t('Restart now to apply (Terminate + Resume)');
          go.onclick = (ev) => { ev.stopPropagation(); dropdown.remove(); this._onRestartSession(); };
          dropdown.appendChild(go);
        }
        for (const s of STYLES) {
          const item = document.createElement('div');
          item.className = 'chat-status-dropdown-item' + ((s.v || '') === (this._outputStyle || '') ? ' active' : '');
          item.textContent = s.label;
          item.onclick = (ev) => {
            ev.stopPropagation();
            this._onConfigChange?.({ outputStyle: s.v || null });   // survives the next resume either way
            if (styleAppliesLive(caps, this._responseStyleLive)) {
              // LIVE: ASK the running agent. Nothing is claimed yet — the chip
              // wears the pending pick and the SUCCESS TOAST fires on the
              // server's `response-style-updated` echo (chat-view), because the
              // switch can still be refused ('style-wrapper-old') and the old cut
              // toasted success right on top of that refusal (r2 review).
              this._ws?.send({ type: 'set-response-style', sessionId: this._sessionId, style: s.v || '' });
              this._outputStylePending = s.v || '';
            } else {
              this._outputStylePending = s.v || '';                 // the chip shows the saved-but-not-yet-live pick
              showToast(s.v ? t('Response style \u201c{v}\u201d applies on the next resume', { v: s.v }) : t('Response style cleared \u2014 applies on the next resume'));
            }
            renderStyleRows();                                      // keep the menu open — the restart row just appeared
            this.render();
          };
          dropdown.appendChild(item);
        }
        const note = document.createElement('div');
        note.className = 'chat-status-dropdown-note';
        note.textContent = styleAppliesLive(caps, this._responseStyleLive)
          ? t('This agent applies a style change to the running session, from its next turn.')
          : caps.live
            ? t('This session\u2019s agent started before live style switching \u2014 restart it to apply a change.')
            : t('A running session cannot change style \u2014 the CLI only reads it at startup.');
        dropdown.appendChild(note);
      };
      renderStyleRows();
      return;
    }

    const effortEl = e.target.closest('.chat-status-effort');
    if (effortEl) {
      e.stopPropagation();
      const dropdown = showDropdown(effortEl);
      if (!dropdown) return;
      const pickE = (effort, label) => {
        this._ws.send({ type: 'set-effort', sessionId: this._sessionId, effort });
        // Mid-session picks persist as this session's per-session config, so
        // the NEXT resume starts with the same effort (user-requested).
        this._onConfigChange?.({ effort: effort || null });
        // Optimistic — claude never reports effort back (apply_flag_settings is
        // success-blind); codex confirms via turn_context on the next turn.
        this._statusEffort = effort || '';
        this.render();
      };
      const addItems = (levels) => {
        for (const lv of levels) {
          const item = document.createElement('div');
          item.className = 'chat-status-dropdown-item' + ((lv.value || '') === (this._statusEffort || '') ? ' active' : '');
          item.textContent = lv.label;
          item.onclick = (ev) => { ev.stopPropagation(); dropdown.remove(); pickE(lv.value); };
          dropdown.appendChild(item);
        }
      };
      if (this._backend === 'codex') {
        // Effort levels are MODEL-SPECIFIC since GPT-5.6 (sol/terra go up to
        // ultra, luna to max, older models stop at xhigh) — prefer the current
        // model's reported levels from the models cache, fall back to the union
        // of all models, then to the classic ladder if the fetch fails.
        const codexLadder = (levels) => [{ value: '', label: t('Auto (model default)') },
          ...levels.map(v => ({ value: v, label: effortLabel(this._backend, v) }))]; // 'ultra' carries its delegation hint when the served model reports it
        const loading = document.createElement('div');
        loading.className = 'chat-status-dropdown-item chat-status-dim';
        loading.textContent = t('Loading…');
        dropdown.appendChild(loading);
        fetch('/api/available-models').then(r => r.json()).then(data => {
          if (!dropdown.isConnected) return;
          loading.remove();
          const models = (data?.codex || []).filter(m => m.id);
          noteModelCatalog('codex', models); // per-model multiAgentEffort for the effort tooltip (2.369.61)
          const rank = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
          const cur = models.find(m => m.id === this._statusModel);
          let levels = (cur?.efforts?.length ? cur.efforts : [...new Set(models.flatMap(m => m.efforts || []))])
            .sort((a, b) => (rank.indexOf(a) + 1 || 99) - (rank.indexOf(b) + 1 || 99));
          if (!levels.length) levels = ['minimal', 'low', 'medium', 'high', 'xhigh'];
          addItems(codexLadder(levels));
        }).catch(() => {
          if (!dropdown.isConnected) return;
          loading.remove();
          addItems(codexLadder(['minimal', 'low', 'medium', 'high', 'xhigh']));
        });
      } else {
        // Async population: show a Loading row immediately (a bare empty box
        // reads as a dead click), and NEVER vanish on fetch failure — the
        // effort enum is stable, so fall back to the hardcoded ladder.
        const claudeLadder = (levels) => [{ value: '', label: t('Default (reset)') }, ...levels, { value: 'ultracode', label: t('ultracode (xhigh + workflows)') }];
        const loading = document.createElement('div');
        loading.className = 'chat-status-dropdown-item chat-status-dim';
        loading.textContent = t('Loading…');
        dropdown.appendChild(loading);
        fetch('/api/session-options').then(r => r.json()).then(data => {
          if (!dropdown.isConnected) return;
          loading.remove();
          const levels = (data?.effortLevels || ['low', 'medium', 'high', 'xhigh', 'max']).map(v => ({ value: v, label: v }));
          // "ultracode" isn't an effortLevel — it's a separate mode (xhigh +
          // dynamic-workflow orchestration). The CLI's own /effort UI appends it
          // to the ladder; mirror that. The adapter wires it via the ultracode
          // settings key, not effortLevel. (Gated CLI-side on an xhigh-capable
          // model + dynamic workflows — a no-op if unsupported.)
          addItems(claudeLadder(levels));
        }).catch(() => {
          if (!dropdown.isConnected) return;
          loading.remove();
          addItems(claudeLadder(['low', 'medium', 'high', 'xhigh', 'max'].map(v => ({ value: v, label: v }))));
        });
      }
      return;
    }

    // Model click -> dropdown (mid-session model switch)
    const modelEl = e.target.closest('.chat-status-model');
    if (modelEl) {
      e.stopPropagation();
      const dropdown = showDropdown(modelEl);
      if (!dropdown) return;
      const backend = this._backend || 'claude'; // the real id — META/model lists are per backend since P4
      const pick = (model) => {
        this._ws.send({ type: 'set-model', sessionId: this._sessionId, model });
        // changing the model while LOCKED re-targets the lock (A4 sub-item:
        // the tooltip kept naming the old target while the server retried the
        // new one) — the server's retarget branch does the same with data.model
        if (this._modelLocked) this._lockedModel = model;
        this._onConfigChange?.({ model, ...(this._modelLocked ? { lockModel: model } : {}) });
        // optimistic; the CLI's own confirmation (set_model echo / codex
        // turn_context) overwrites this with the RESOLVED id
        this._statusModel = model;
        this.render();
      };
      const addModelItems = (models) => {
        for (const m of models) {
          const item = document.createElement('div');
          item.className = 'chat-status-dropdown-item' + (m.id === this._statusModel ? ' active' : '');
          item.textContent = m.label || m.id;
          item.onclick = (ev) => { ev.stopPropagation(); dropdown.remove(); pick(m.id); };
          dropdown.appendChild(item);
        }
        const custom = document.createElement('div');
        custom.className = 'chat-status-dropdown-item';
        custom.textContent = t('Custom\u2026');
        custom.onclick = async (ev) => {
          ev.stopPropagation(); dropdown.remove();
          const v = await showInputDialog({ title: t('Set model'), label: t('Model ID or alias'), confirmText: t('Set') });
          if (v && v.trim()) pick(v.trim());
        };
        dropdown.appendChild(custom);
      };
      // #6 model LOCK v2: record a TARGET model — the server re-pins it at
      // every turn end where the served model drifted, so a safety-reroute
      // completes its turn on the fallback but every subsequent turn retries
      // the original (the user's '总是变成opus 4.8' fix). Claude only — codex
      // has no fallback mechanism (a toggle would falsely imply protection).
      if (this._backend !== 'codex') {
        const lockItem = document.createElement('div');
        lockItem.className = 'chat-status-dropdown-item' + (this._modelLocked ? ' active' : '');
        lockItem.classList.add('chat-status-dropdown-lock');
        lockItem.innerHTML = (this._modelLocked ? UI_ICONS.unlock : UI_ICONS.lock) + '<span>' + escHtml(this._modelLocked ? t('Unlock model') : t('Lock to this model (auto-retry after fallback)')) + '</span>';
        lockItem.onclick = (ev) => {
          ev.stopPropagation(); dropdown.remove();
          const nowLock = !this._modelLocked;
          if (nowLock && !this._statusModel) { showToast(t('Model not reported yet — send a message first, then lock'), { type: 'error' }); return; }
          this._modelLocked = nowLock;
          this._lockedModel = nowLock ? (this._statusModel || null) : null;
          // v2: the lock records a TARGET model — the server re-pins it after
          // any fallback at turn end. No set-model is issued at lock time.
          this._ws.send({ type: 'set-model', sessionId: this._sessionId, lock: nowLock, lockModel: nowLock ? (this._statusModel || undefined) : undefined });
          // Persist the target as the session's model config too, so a resume
          // spawns on it and the lock re-arms with the right target.
          this._onConfigChange?.({ modelLock: nowLock, lockModel: nowLock ? this._statusModel : undefined, ...(nowLock && this._statusModel ? { model: this._statusModel } : {}) });
          this.render();
        };
        dropdown.appendChild(lockItem);
        const sep = document.createElement('div'); sep.className = 'chat-status-dropdown-sep'; dropdown.appendChild(sep);
      }
      // Loading row while the model list fetches; on failure fall back to the
      // CLI alias ladder (+ Custom\u2026) instead of silently vanishing.
      const loading = document.createElement('div');
      loading.className = 'chat-status-dropdown-item chat-status-dim';
      loading.textContent = t('Loading\u2026');
      dropdown.appendChild(loading);
      fetch('/api/available-models').then(r => r.json()).then(data => {
        if (!dropdown.isConnected) return;
        loading.remove();
        addModelItems((data?.[backend] || []).filter(m => m.id));
      }).catch(() => {
        if (!dropdown.isConnected) return;
        loading.remove();
        // per-backend offline fallback — a codex session must never list claude models
        addModelItems((getBackendMeta(backend)?.fallbackModels || []).map(id => ({ id })));
      });
      return;
    }

    // Permission mode click -> dropdown
    const el = e.target.closest('.chat-status-perm');
    if (!el) return;
    e.stopPropagation();
    const modes = this._permissionModes || ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'];
    const dropdown = showDropdown(el);
    if (!dropdown) return;
    for (const mode of modes) {
      const item = document.createElement('div');
      item.className = 'chat-status-dropdown-item' + (mode === this._statusPermMode ? ' active' : '');
      item.textContent = mode;
      item.onclick = (ev) => {
        ev.stopPropagation();
        dropdown.remove();
        // Optimistic badge; the pre-switch value is kept so the server's
        // permission-mode-ack can revert cleanly when the CLI refuses
        // (bypassPermissions on a non-bypass-capable launch — 2.195.0).
        // Only the FIRST of rapid re-picks captures prev — a second pick
        // before the ack must not make "revert" restore the refused mode
        // (review-confirmed). prev!==undefined ⇔ a pick is in flight; it also
        // marks THIS client as the initiator for the broadcast ack.
        if (this._permModePrev === undefined) this._permModePrev = this._statusPermMode;
        this._ws.send({ type: 'set-permission-mode', sessionId: this._sessionId, mode });
        this._statusPermMode = mode;
        this.render();
      };
      dropdown.appendChild(item);
    }
  }
}
