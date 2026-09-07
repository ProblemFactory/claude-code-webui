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
  // queue — it can be listed and an entry removed, but a running session/prompt
  // cannot be steered (no such method in the protocol). The caps row
  // (inputModes.steer=false) already stops ws-handler; refusing here WITH THE
  // REASON is the second line of defense — never format a frame the wrapper
  // would answer with "unknown stdin verb".
  formatQueueOp({ op, id } = {}) {
    if (op === 'steer' || op === 'steer-all') throw new Error('ACP v1 has no steer: a running prompt cannot be interrupted with new input — the message runs after this turn, or you can remove it');
    if (op !== 'remove') throw new Error(`unknown queue op "${op}"`);
    if (!id) throw new Error('queue op "remove" needs an item id');
    return JSON.stringify({ type: 'queue-op', op: 'remove', id });
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
