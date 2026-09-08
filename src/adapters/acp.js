/**
 * AcpAdapter — the GENERIC Agent Client Protocol v1 backend adapter (S8 of
 * docs/design-harness-plugins.md §2.3). One class serves every ACP agent
 * (`opencode acp` first); the per-agent facts (command, args, env, harness id)
 * arrive through the harness descriptor's adapterConfig mapping.
 *
 * Chat mode runs the agent under data/bin/acp-wrapper.js inside dtach — the
 * wrapper owns the JSON-RPC stdio and journals 'acp-events' records.
 * Terminal mode runs the agent's own TUI (`opencode`), same dtach/pty path
 * as every other backend.
 *
 * Program-use billing law: the agent runs ITS OWN interactive login/provider
 * channel — this adapter never carries a vendor secret in argv or env.
 */

const os = require('os');
const { BackendAdapter } = require('./base');

class AcpAdapter extends BackendAdapter {
  constructor(config = {}) {
    super();
    this.config = config;
  }

  /** Is the agent binary resolvable on this machine (spawn would work)? */
  get installed() { return !!this.config.command; }

  buildSessionArgs(options = {}) {
    const { cwd, model, permissionMode, resumeId, extraArgs = [], mode = 'chat', sessionName = '', initialPrompt = '' } = options;
    const command = this.config.command || this.config.commandName || this.config.harnessId || 'acp-agent';
    const baseEnv = { ...(this.config.env || {}) };
    if (mode === 'chat') {
      return {
        cmd: command,
        args: [...(this.config.acpArgs || ['acp']), ...extraArgs],
        wrapper: this.config.chatWrapper,
        cwd: cwd || os.homedir(),
        mode,
        env: {
          ...baseEnv,
          ACP_WEBUI_BACKEND: this.config.harnessId || 'acp',
          ACP_WEBUI_CWD: cwd || os.homedir(),
          ACP_WEBUI_MODEL: model || '',
          ACP_WEBUI_MODE: permissionMode || '',
          ACP_WEBUI_RESUME_ID: resumeId || '',
          ACP_WEBUI_SESSION_NAME: sessionName || '',
        },
      };
    }
    // Terminal: the agent's own TUI. Resume = the harness's terminal resume
    // flag when it declares one (opencode: `--session <id>`); model = `--model`.
    const args = [...(this.config.terminalArgs || [])];
    if (model && this.config.terminalModelFlag) args.push(this.config.terminalModelFlag, model);
    if (resumeId && this.config.terminalResumeFlag) args.push(this.config.terminalResumeFlag, resumeId);
    if (extraArgs.length) args.push(...extraArgs);
    if (initialPrompt) args.push(initialPrompt);
    return { cmd: command, args, wrapper: this.config.ptyWrapper, cwd: cwd || os.homedir(), mode, env: baseEnv };
  }

  // ── Protocol formatting (called by ws-handler) ──
  formatChatInput(text, msgId) {
    const stdinPayload = JSON.stringify({ type: 'chat-input', text, msgId });
    return { stdinPayload, userMsg: AcpAdapter._buildUserPreview(text, msgId) };
  }
  formatInterrupt() { return JSON.stringify({ type: 'interrupt' }); }
  postInterrupt() {} // session/cancel is the protocol's own path — no SIGINT fallback
  formatPermissionResponse(data) {
    return JSON.stringify({
      type: 'permission-response',
      requestId: data.requestId,
      approved: !!data.approved,
      optionId: data.optionId || null,
      alwaysAllow: Array.isArray(data.permissionUpdates) && data.permissionUpdates.length > 0,
      abort: !!data.abort,
    });
  }
  formatSetPermissionMode(mode) { return JSON.stringify({ type: 'set-mode', mode }); }
  formatSetModel(model) { return JSON.stringify({ type: 'set-model', model }); }
  formatSetEffort(effort) { return JSON.stringify({ type: 'set-effort', effort }); }
  // QUEUE OPS: ACP v1 has no queue verb, so the WRAPPER's promptQueue is the
  // queue — a plain local array, which is why remove/reorder/edit are real
  // here. Two things it can NOT do, each refused with the reason rather than
  // formatted into a frame the wrapper would answer with "unknown stdin verb":
  //   steer/steer-all — a running session/prompt cannot be interrupted with
  //     new input (no such method in the protocol);
  //   run-now/run-all — that queue only ever HAS entries while a prompt is
  //     running (an idle wrapper dispatches immediately), so "run it now"
  //     could only ever answer 'busy'. The caps row declares both false; this
  //     is the second line of defense.
  formatQueueOp({ op, id, afterId, text } = {}) {
    if (op === 'steer' || op === 'steer-all') throw new Error('ACP v1 has no steer: a running prompt cannot be interrupted with new input — the message runs after this turn, or you can remove it');
    if (op === 'run-now' || op === 'run-all') throw new Error('ACP v1 runs one prompt at a time: a queued message only exists while a prompt is running, so it cannot be started early — it runs as soon as this one ends');
    if (op !== 'remove' && op !== 'reorder' && op !== 'edit') throw new Error(`unknown queue op "${op}"`);
    if (!id) throw new Error(`queue op "${op}" needs an item id`);
    if (op === 'reorder') {
      if (afterId === undefined) throw new Error('queue op "reorder" needs an anchor (afterId, or null for the front of the queue)');
      const anchor = afterId === null ? null : String(afterId);
      if (anchor === id) throw new Error('queue op "reorder" cannot anchor an item to itself');
      return JSON.stringify({ type: 'queue-op', op, id, afterId: anchor });
    }
    if (op === 'edit') {
      if (typeof text !== 'string' || !text.trim()) throw new Error('queue op "edit" needs the new message text');
      return JSON.stringify({ type: 'queue-op', op, id, text });
    }
    return JSON.stringify({ type: 'queue-op', op: 'remove', id });
  }

  // READ-ONLY permission-rule read (owner ruling 10). ACP v1 has no
  // config-read method, and the wrapper says exactly that back
  // ('unsupported-by-protocol') plus the one permission fact the protocol DOES
  // carry: the session's live mode. The frame is still sent rather than
  // suppressed here, because a REFUSAL FROM THE AGENT is a different (and more
  // useful) statement than a refusal from us guessing on its behalf — and the
  // OpenCode rules themselves come from the serve's v1 /config, server-side.
  formatReadPermissionRules({ requestId = '' } = {}) {
    return JSON.stringify({ type: 'read-permission-rules', requestId: String(requestId || '') });
  }

  /** Preview user record (acp-events `user` shape) so the bubble renders
   *  before the wrapper's own record lands; the two dedup on msgId. */
  static _buildUserPreview(rawText, msgId) {
    let text = typeof rawText === 'string' ? rawText : '';
    const content = [];
    try {
      const parsed = JSON.parse(text);
      if (parsed?.type === 'user' && parsed.message) {
        text = '';
        for (const block of parsed.message.content || []) {
          if (block.type === 'text' && block.text) text = block.text;
          if (block.type === 'image' && block.source?.data) content.push({ type: 'image', mediaType: block.source.media_type || 'image/png', data: block.source.data });
        }
      }
    } catch {}
    if (text) content.push({ type: 'text', text });
    if (!content.length) return null;
    return { ts: new Date().toISOString(), type: 'acp', kind: 'user', msgId: msgId || '', content, peer: null, _fromWebui: true };
  }
}

module.exports = { AcpAdapter };
