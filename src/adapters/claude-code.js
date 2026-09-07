/**
 * ClaudeCodeAdapter — BackendAdapter implementation for Claude Code CLI.
 *
 * Manages sessions via dtach for persistence. Chat mode uses chat-wrapper.js
 * (stream-json), terminal mode uses pty-wrapper.js (raw PTY).
 *
 * This adapter encapsulates all Claude-Code-specific knowledge:
 * - CLI flags (--output-format, --input-format, --verbose, --permission-prompt-tool)
 * - JSONL file locations (~/.claude/projects/<projDir>/<sessionId>.jsonl)
 * - Lock file format for session discovery
 * - control_request/control_response protocol for permissions
 * - stream-json message format
 */

const { BackendAdapter } = require('./base');
const path = require('path');
const fs = require('fs');
const os = require('os');

class ClaudeCodeAdapter extends BackendAdapter {
  /**
   * @param {object} config - { claudeCmd, nodeCmd, dtachCmd, envCmd, editorCmd,
   *                            ptyWrapper, chatWrapper, buffersDir, port }
   */
  constructor(config) {
    super();
    this.config = config;
  }


  /**
   * Create a Claude Code session.
   * Spawns dtach with the appropriate wrapper (chat or terminal).
   *
   * Note: actual PTY spawning is handled by the server's existing code.
   * This adapter provides the command line arguments and session config.
   */
  buildSessionArgs(options) {
    const { cwd, model, permissionMode, resumeId, sessionName, effort, outputStyle, extraArgs = [], mode = 'chat', tuiRenderer, disableModelFallback, neutralizeKeyHelper } = options;
    const args = [];

    if (resumeId) {
      args.push('--resume', resumeId);
    }
    if (sessionName && this.config.supportsName) args.push('--name', sessionName);
    if (model) args.push('--model', model);
    if (permissionMode) args.push('--permission-mode', permissionMode);
    // "ultracode" is NOT an effortLevel value — it's a separate boolean
    // settings key = xhigh effort + standing dynamic-workflow orchestration
    // (from disassembly: --effort ultracode parses to plain xhigh WITHOUT the
    // mode). Enable the mode at spawn via --settings (a documented setter for
    // the ultracode key); otherwise pass --effort verbatim.
    if (effort === 'ultracode') {
      args.push('--effort', 'xhigh', '--settings', JSON.stringify({ ultracode: true }));
    } else if (effort) {
      args.push('--effort', effort);
    }
    if (extraArgs.length) args.push(...extraArgs);
    // Disable model fallback (2.228.0, user request "stop instead of becoming
    // opus"): switchModelsOnFlag=false is the CLI's OWN settings key ("When
    // off, your session will pause instead") — it stops the server-lane
    // `fallbacks` request param (no more {type:'fallback'} reroutes) and, in
    // our dialog-less stream-json shape, the client-lane refusal retry too
    // (refusals surface as system/model_refusal_no_fallback and the turn
    // ends). Merged into ONE --settings flag (repeated flags are undefined
    // behavior; the statusline injection in ws-handler merges the same way).
    // The env var additionally covers SUBAGENTS, which ignore the settings
    // key (verified in the 2.1.220 disassembly: x2c requires isMainThread).
    const env = {};
    const mergeSettings = (patch) => {
      let settingsObj = {};
      const si = args.indexOf('--settings');
      if (si >= 0 && args[si + 1]) { try { settingsObj = JSON.parse(args[si + 1]) || {}; } catch {} }
      Object.assign(settingsObj, patch);
      const sjson = JSON.stringify(settingsObj);
      if (si >= 0) args[si + 1] = sjson; else args.push('--settings', sjson);
    };
    // Output style (2.368.0): the CLI's built-in styles (Concise / Explanatory
    // / Learning / Proactive) are a SETTINGS key, and a stream-json session is
    // never offered `/output-style` (verified against a real init record), so
    // spawn is the only door — which is why the UI says "next resume".
    if (outputStyle && outputStyle !== 'default') mergeSettings({ outputStyle });
    if (disableModelFallback) {
      mergeSettings({ switchModelsOnFlag: false });
      env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK = '1';
    }
    // AUTHORITATIVE TURN STATE (design-harness-features §2.5/§3.5, owner
    // decision 8(c)): 2.1.257 emits `system/session_state_changed`
    // {idle|running|requires_action} — its own describe calls 'idle' the
    // "authoritative turn-over signal" — ONLY when this env var is set
    // (`if (a.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS) mu({type:"system",
    // subtype:"session_state_changed", state:e})`, verified in the binary).
    // Without it the consumer branch is dead code and `_isStreaming` keeps
    // being INFERRED from result/compact_boundary — the fuzzy area both
    // 2.339.2 (stuck thinking) and 2.369.16 (attach storm) landed in.
    // It is the ONE spawn default this batch changes: pure observability, no
    // behaviour change in the CLI, so nothing about the turn itself differs.
    // Set on the spawn env, never on AGENT_ENV_KEEP — agentEnv() is a DROP
    // table (ws-handler.js: everything not dropped is passed through), so an
    // allowlist edit would be both wrong and unnecessary.
    // CHAT ONLY. The consumer is the stream-json parse; a terminal session has
    // no such reader, and we have not proven what the TUI's own yield sink does
    // with an extra record — turning a record ON for a surface that cannot use
    // it is exactly the kind of unverified spawn change this batch is not for.
    if (mode === 'chat') env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
    // Per-session apiKeyHelper neutralization (2.236.0, userN's "can't
    // switch to my subscription" on a keyHelper machine): a configured
    // apiKeyHelper in the merged settings UNCONDITIONALLY overrides claude.ai
    // OAuth (2.191.0 disassembly), so an explicit SUBSCRIPTION pick silently
    // billed via the helper key. VERIFIED live (2026-07-31 controlled A/B):
    // an inline --settings apiKeyHelper:"" overrides the file's helper —
    // apiKeySource flips from 'apiKeyHelper' to 'none' (subscription OAuth)
    // and the turn succeeds. Harmless no-op on machines without a helper, so
    // it is applied for EVERY explicit subscription pick. (null is NOT usable
    // — the CLI's field-level schema .catch DROPS it.)
    if (neutralizeKeyHelper) mergeSettings({ apiKeyHelper: '' });
    // Background-job owner notifications ride the CLI's cross-session
    // messaging inbox (2.344.0). Our sessions run bypassPermissions, whose
    // inbound default HOLDS a message from a sender that can't attest a
    // permission class (VibeSpace's jobs engine can't — it isn't a session),
    // so the notification would sit in a dialog nobody sees. The CLI's own
    // documented unattended-accept knob is crossSessionInbound:"accept" in
    // --settings (docs/en/cross-session-messaging §Non-interactive sessions);
    // repo/managed settings can still tighten it — we never override a hold.
    if (options.acceptPeerMessages) mergeSettings({ crossSessionInbound: 'accept' });
    // EXPERIMENTAL VibeSpace channel (2.344.0, CLI research preview): register
    // our channel MCP server for THIS spawn only (--mcp-config — never the
    // user's config files) and opt it in per-session. Custom channels aren't
    // on the preview's Anthropic-curated allowlist, so the development flag is
    // the only opt-in; org channelsEnabled policy still applies. Default OFF.
    if (options.vibespaceChannel && options.vibespaceChannel.script) {
      const vc = options.vibespaceChannel;
      args.push('--mcp-config', JSON.stringify({ mcpServers: { vibespace: { command: process.execPath, args: [vc.script], env: { VIBESPACE_CHANNEL_SOCK: vc.sock } } } }));
      args.push('--dangerously-load-development-channels', 'server:vibespace');
    }

    // TUI renderer for terminal-mode sessions (CLI ≥2.1.x): "fullscreen" is the
    // flicker-free alternate-screen renderer with virtualized scrollback (same
    // as /tui fullscreen), "classic" forces the main-screen renderer. Unset =
    // whatever preference the CLI has saved. Chat mode has no TUI — skip.
    if (mode !== 'chat') {
      if (tuiRenderer === 'fullscreen') env.CLAUDE_CODE_NO_FLICKER = '1';
      else if (tuiRenderer === 'classic') env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1';
    }

    return {
      cmd: this.config.claudeCmd,
      args,
      env,
      wrapper: mode === 'chat' ? this.config.chatWrapper : this.config.ptyWrapper,
      cwd: cwd || os.homedir(),
      mode,
    };
  }

  // ── Protocol formatting (called by ws-handler) ──

  formatChatInput(text, msgId) {
    let stdinPayload, userMsg;
    let parsed = null;
    try { parsed = JSON.parse(text); if (!(parsed.type === 'user' && parsed.message)) parsed = null; } catch {}
    if (parsed) {
      stdinPayload = text;
      userMsg = { ...parsed, msgId, timestamp: new Date().toISOString() };
    } else {
      // POISON GUARD (2.360.0, the 79928a2b 38MB incident): a huge
      // unparseable blob that LOOKS like a frame is a shredded image paste —
      // wrapping it as text would poison the transcript (context overflow
      // kills every later API call AND the tail-window history view). Refuse
      // loudly; the ws handler surfaces this to the user as an error toast.
      if (text.length > 512 * 1024 && /^\s*\{"type"\s*:\s*"user"/.test(text)) {
        throw new Error(`image message corrupted in transit (${Math.round(text.length / 1024)}KB fragment) — refused to protect the conversation; try again or send fewer/smaller images`);
      }
      stdinPayload = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
      userMsg = { type: 'user', message: { role: 'user', content: text }, msgId, timestamp: new Date().toISOString() };
    }
    userMsg._fromWebui = true;
    return { stdinPayload, userMsg };
  }

  formatInterrupt() {
    return JSON.stringify(ClaudeCodeAdapter.buildInterruptRequest());
  }

  postInterrupt(session, sessionId) {
    // Delayed SIGINT fallback: if Claude is still streaming 2s after the
    // control_request, send SIGINT as last resort. In recent Claude Code
    // versions SIGINT exits the whole process (killing the session), so we
    // avoid it unless the protocol-level interrupt actually failed.
    // Historical context: bugs #17466, #3455 — may be fixed now.
    // REMOTE sessions: _childPid is the LOCAL transport (ssh keeper pipe /
    // agentd-attach bridge), NOT claude — SIGINT would kill the pipe and
    // read as a session drop while remote claude keeps running (audit
    // 2.192.0). The protocol interrupt still reaches claude via stdin.
    if (session.host) return;
    if (!session._childPid) return;
    if (session._interruptTimer) clearTimeout(session._interruptTimer);
    session._interruptTimer = setTimeout(() => {
      session._interruptTimer = null;
      // Check if the control_request interrupt worked by reading wrapper meta
      try {
        const metaPath = path.join(this.config.buffersDir, sessionId + '.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (!meta.streaming) return; // Interrupt worked — no need for SIGINT
      } catch {}
      // Still streaming after 2s → force SIGINT
      try { process.kill(session._childPid, 'SIGINT'); } catch {}
    }, 2000);
  }

  formatPermissionResponse(data) {
    return JSON.stringify(ClaudeCodeAdapter.buildPermissionResponse(data.requestId, data.approved, data.toolInput, data.permissionUpdates));
  }

  formatSetPermissionMode(mode) {
    return JSON.stringify(ClaudeCodeAdapter.buildSetPermissionMode(mode));
  }

  // Tracked variant (2.195.0): the CLI ANSWERS set_permission_mode with a real
  // success/error control_response (verified on 2.1.215 — bypassPermissions is
  // REFUSED unless the session was launched bypass-capable). The caller records
  // the request_id so the stdout parser can surface the verdict instead of the
  // old fire-and-forget silence.
  buildTrackedSetPermissionMode(mode) {
    const req = ClaudeCodeAdapter.buildSetPermissionMode(mode);
    return { line: JSON.stringify(req), requestId: req.request_id };
  }

  // ── Static helpers (kept for backward compat) ──

  static buildPermissionResponse(requestId, approved, toolInput, permissionUpdates) {
    const allowResponse = { behavior: 'allow', updatedInput: toolInput || {} };
    if (permissionUpdates?.length) allowResponse.permission_updates = permissionUpdates;
    return {
      type: 'control_response',
      response: approved
        ? { subtype: 'success', request_id: requestId, response: allowResponse }
        : { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: 'User denied this action' } },
    };
  }

  static buildInterruptRequest() {
    return {
      type: 'control_request',
      request_id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      request: { subtype: 'interrupt' },
    };
  }

  static buildSetPermissionMode(mode) {
    return {
      type: 'control_request',
      request_id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      request: { subtype: 'set_permission_mode', mode },
    };
  }

  // Mid-session model switch (stream-json control protocol, CLI >=2.1.x).
  // The CLI echoes "<local-command-stdout>Set model to X (resolved-full-id)"
  // as a user record — that echo is the authoritative confirmation (the
  // control_response says success even for bogus model names).
  formatSetModel(model) {
    return JSON.stringify(ClaudeCodeAdapter.buildSetModel(model));
  }

  static buildSetModel(model) {
    return {
      type: 'control_request',
      request_id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      request: { subtype: 'set_model', model },
    };
  }

  // Mid-session effort switch. There is NO set_effort subtype and /effort is
  // blocked in stream-json — but apply_flag_settings is the CLI's OWN mechanism
  // (its /effort command sends exactly this). Verified by disassembly: the CLI
  // sends BOTH keys together — `{ effortLevel, ultracode }`. "ultracode" is a
  // SEPARATE boolean (xhigh effort + standing dynamic-workflow orchestration),
  // NOT an effortLevel value, so picking it maps to effortLevel:'xhigh' +
  // ultracode:true; any real level sets ultracode:false (turning the mode off);
  // reset (empty) → effortLevel:null + ultracode:false. Response is
  // success-blind and nothing echoes back — the commanded value is all we have
  // to display. (ultracode is gated CLI-side on an xhigh-capable model +
  // dynamic workflows enabled — a no-op otherwise.)
  // Mid-session fallback-policy flip ("动态对对话进行调整"): rides the SAME
  // apply_flag_settings channel as effortLevel — the CLI merges schema-valid
  // keys into its inline flag-settings layer and re-reads them next turn.
  // Re-enable sends the literal `true`, NEVER null: null DELETES the key from
  // the inline layer, and whether a spawn-time --settings false would then
  // resurface depends on undocumented source precedence — an explicit value
  // wins in any layering.
  formatSetFallbackPolicy(disabled) {
    return JSON.stringify({
      type: 'control_request',
      request_id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      request: { subtype: 'apply_flag_settings', settings: { switchModelsOnFlag: !disabled } },
    });
  }

  formatSetEffort(effort) {
    const ultracode = effort === 'ultracode';
    const settings = ultracode
      ? { effortLevel: 'xhigh', ultracode: true }
      : { effortLevel: effort || null, ultracode: false };
    return JSON.stringify({
      type: 'control_request',
      request_id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      request: { subtype: 'apply_flag_settings', settings },
    });
  }

  // QUEUE OPS: the CLI queues stdin messages ITSELF and publishes no queue
  // state — there is nothing to enumerate, remove or steer (inputModes
  // {queue:true, steer:false, queueOps:false}). Refuse WITH THE REASON rather
  // than invent a control_request the CLI would ignore (accept-and-ignore is
  // the 2.361.4 failure).
  formatQueueOp() {
    throw new Error('Claude Code owns its own input queue: a message sent mid-turn runs after it, but the CLI reports no queue and takes no queue commands');
  }

  // B-7edc: ask the CLI ITSELF for usage over the control channel (subtype
  // 'get_usage', verified present in the 2.1.222 control-request dispatch).
  // Its reply carries the FULL rate_limits object incl. `model_scoped` (the
  // Fable/opus/sonnet weekly buckets the statusline payload does NOT have) and
  // `extra_usage`. ToS posture is strictly better than our raw ⟳: the request
  // is made BY the CLI as a first-party client, we never touch the API with a
  // subscription token. Still HUMAN-TRIGGERED + throttled — the CLI's own
  // handler does a real usage fetch (Cbn→Tbn→BRe), which can 429.
  static buildGetUsage() {
    return {
      type: 'control_request',
      request_id: 'vsu-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      request: { subtype: 'get_usage' },
    };
  }
  formatGetUsage() {
    return JSON.stringify(ClaudeCodeAdapter.buildGetUsage());
  }

  // Parse the `get_usage` control-response's rate_limits into our usage-cache
  // shape (same fields _parseUsage(GET /api/oauth/usage) produces). The
  // control payload's rate_limits is the CLI's OWN merged object:
  //   { five_hour, seven_day, seven_day_opus, seven_day_sonnet, extra_usage,
  //     limits, model_scoped:[{display_name, utilization, resets_at}] }
  // where each window is { used_percentage|utilization, resets_at }. We map
  // model_scoped → scopedWeekly (the shape the quota popup already renders).
  static parseGetUsageResponse(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const rl = payload.rate_limits;
    if (!rl || typeof rl !== 'object') return null;
    const toWin = (w) => {
      if (!w) return { utilization: 0, resetsAt: 0, status: 'allowed' };
      // control payload uses used_percentage (0-100) OR utilization — the LIVE
      // envelope (verified 2026-08-09 on a real session) carries utilization as
      // 0-100 integers, so normalize anything >1 down to the 0-1 shape
      let pct = typeof w.used_percentage === 'number' ? w.used_percentage / 100
        : (typeof w.utilization === 'number' ? w.utilization : 0);
      if (pct > 1) pct = pct / 100;
      const resetsAt = typeof w.resets_at === 'number' ? w.resets_at
        : (w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) || 0 : 0);
      return { utilization: pct, resetsAt, status: pct >= 1 ? 'limited' : 'allowed' };
    };
    const fiveHour = toWin(rl.five_hour);
    const sevenDay = toWin(rl.seven_day);
    const scopedWeekly = [];
    for (const s of (Array.isArray(rl.model_scoped) ? rl.model_scoped : [])) {
      if (!s?.display_name) continue;
      const resetsAt = typeof s.resets_at === 'number' ? s.resets_at
        : (s.resets_at ? Math.floor(Date.parse(s.resets_at) / 1000) || 0 : 0);
      scopedWeekly.push({
        name: s.display_name,
        utilization: typeof s.utilization === 'number' ? (s.utilization > 1 ? s.utilization / 100 : s.utilization) : 0,
        resetsAt,
        severity: s.severity || 'normal',
      });
    }
    // NAMED scoped buckets (seven_day_opus/seven_day_sonnet + internal
    // codename buckets) are MERGED, never used as a mere fallback.
    // 2.305.0 (inc-msof8i22, user report "没有自动切换还有opus用量的账号"): this
    // was `if (!scopedWeekly.length)`, so an account whose model_scoped array
    // held ONE entry (Fable) never had its `seven_day_opus` field read — the
    // Opus cap was INVISIBLE to every consumer, including the pool's
    // exhaustion test. The pool therefore saw 5h/7d/Fable all healthy and
    // stayed on an account whose Opus was spent, which is exactly the switch
    // the feature exists to make. An array entry wins over a named field of
    // the same bucket (dedupe by name).
    {
      const have = new Set(scopedWeekly.map((x) => String(x.name).toLowerCase()));
      const SKIP = new Set(['five_hour', 'seven_day', 'extra_usage', 'seven_day_oauth_apps']);
      for (const [k, v] of Object.entries(rl)) {
        if (SKIP.has(k) || !v || typeof v !== 'object') continue;
        if (typeof v.utilization !== 'number' && typeof v.used_percentage !== 'number') continue;
        if (!v.resets_at) continue;
        const w = toWin(v);
        const name = k.replace(/^seven_day_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        if (have.has(name.toLowerCase())) continue; // array entry wins
        have.add(name.toLowerCase());
        scopedWeekly.push({ name, utilization: w.utilization, resetsAt: w.resetsAt, severity: w.utilization >= 1 ? 'exceeded' : 'normal' });
      }
    }
    return {
      fiveHour, sevenDay, scopedWeekly,
      overallStatus: (fiveHour.status === 'limited' || sevenDay.status === 'limited') ? 'limited' : 'allowed',
      fetchedAt: Date.now(), source: 'control',
      scopedFetchedAt: scopedWeekly.length ? Date.now() : undefined,
    };
  }

  // Chat-mode PASSIVE limit signal (2.260.0, ToS-clean by construction): the
  // CLI prints "You've reached your … limit" INTO the stream when a bucket
  // hits zero — the freshest possible exhaustion signal, zero API calls
  // (auto-firing get_usage was REJECTED as an automated quota-check pattern).
  // Returns {kind:'fiveHour'|'sevenDay'|'scoped', name?} or null.
  /** The banner's own "resets 12:40pm (America/Los_Angeles)" → epoch ms of
   *  the NEXT such wall time in that zone (2.368.34 — the armer used to guess
   *  now+5h while the precise time sat in the text). Returns 0 when absent/
   *  unparseable; minute precision. */
  static parseBannerResetMs(text, nowMs = Date.now()) {
    const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([\w/_+-]+)\)/i.exec(String(text || ''));
    if (!m) return 0;
    let h = parseInt(m[1], 10) % 12;
    if (/pm/i.test(m[3])) h += 12;
    const min = parseInt(m[2] || '0', 10);
    const tz = m[4];
    try {
      // tz offset at a given instant (locale-string round-trip; minute precision)
      const offAt = (at) => new Date(new Date(at).toLocaleString('en-US', { timeZone: tz })).getTime() - new Date(new Date(at).toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
      for (let d = 0; d <= 1; d++) {
        const dayAt = nowMs + d * 86400000;
        const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(dayAt));
        const cand = Date.parse(`${ymd}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00Z`) - offAt(dayAt);
        if (cand > nowMs) return cand;
      }
    } catch { }
    return 0;
  }

  static parseLimitBanner(text) {
    // BOTH wordings are live: "You've reached your …" (chat banner) AND
    // "You've hit your session limit · resets 3am" (subagent/workflow failure
    // strings — real 2026-08-09 incident: the reach-only regex was blind to
    // it and the pool switch waited for exhaustion). Non-anchored: the phrase
    // can sit inside a task-notification/failure blob.
    const m = /You've (?:reached|hit) your (.{0,40}?) ?limit/i.exec(String(text || ''));
    if (!m) return null;
    const what = m[1] || '';
    if (/5[- ]?hour|session/i.test(what)) return { kind: 'fiveHour' };
    const model = /\b(Fable|Opus|Sonnet|Haiku)\b/i.exec(what);
    // A model name in the banner ⇒ the model-scoped weekly bucket, with or
    // without the word "weekly" — the live wording is just "You've reached
    // your Fable 5 limit" (real 2026-08-09 incident #2: the week-word
    // requirement mis-marked it as 5h, which self-heals in ≤5h while the
    // scoped bucket is actually dead for up to a week).
    if (model) return { kind: 'scoped', name: model[1][0].toUpperCase() + model[1].slice(1).toLowerCase() };
    if (/week|7[- ]?day/i.test(what)) return { kind: 'sevenDay' };
    // unknown wording → treat as the SHORTEST-recovery bucket (self-heals in
    // ≤5h via the reset-passed rule; a re-attempt re-banners and re-marks)
    return { kind: 'fiveHour' };
  }
}

module.exports = { ClaudeCodeAdapter };
