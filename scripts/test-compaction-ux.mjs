#!/usr/bin/env node
// Compaction UX (2.365.0, the userN "Prompt is too long" → "Compaction
// canceled." incident): ① the normalizer CLASSIFIES a prompt_too_long result
// error so the client can act on it (behavioral, real MessageManager);
// ② wiring pins — the /compact turn is labeled kind=compacting server-side,
// the attach meta carries it, the client guards Stop with a two-step confirm
// during it, and the error renders as a guidance card with a Compact-now
// button that sends through the live input.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

// ── 1. normalizer classification (behavioral) ──
{
  const { MessageManager, classifyResultError } = require(REPO + '/src/message-manager.js');
  const fresh = () => { const mm = new MessageManager('t1'); const ops = []; mm.onOp((op) => ops.push(op)); return { mm, ops }; };
  const result = (text, extra = {}) => ({ type: 'result', subtype: 'error', is_error: true, result: text, session_id: 'c1', total_cost_usd: 1, ...extra });
  let { mm, ops } = fresh();
  mm.processLive(result('Prompt is too long'));
  let sys = ops.filter((o) => o.op === 'create' && o.message.role === 'system').map((o) => o.message);
  ok(sys.length === 1 && sys[0].status === 'error' && sys[0].errorKind === 'prompt-too-long', 'CLI "Prompt is too long" result → system error tagged errorKind=prompt-too-long', JSON.stringify(sys[0]));
  ok(/Error: Prompt is too long/.test(sys[0].content[0].text), 'the visible text is unchanged (card decorates, never rewrites)');
  ({ mm, ops } = fresh());
  mm.processLive(result('Input is too long for requested model'));
  sys = ops.filter((o) => o.op === 'create' && o.message.role === 'system').map((o) => o.message);
  ok(sys[0]?.errorKind === 'prompt-too-long', 'the API\'s other phrasing ("Input is too long for requested model") classifies the same');
  // NEGATIVE CONTROLS: other errors must not grow a Compact-now button
  ({ mm, ops } = fresh());
  mm.processLive(result('API Error: 500 Internal server error'));
  mm.processLive(result('Max turns reached', { subtype: 'error_max_turns' }));
  mm.processLive({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: 'c1' });
  sys = ops.filter((o) => o.op === 'create' && o.message.role === 'system').map((o) => o.message);
  ok(sys.length === 3 && sys.every((m) => !m.errorKind), 'API 500 / max-turns / interrupted carry NO errorKind (negative control)');
  ok(classifyResultError(null) === null && classifyResultError('') === null, 'empty result text classifies as nothing');
  // a SUCCESS result never produces the tag (the regex is only consulted on error)
  ({ mm, ops } = fresh());
  mm.processLive({ type: 'result', subtype: 'success', is_error: false, result: 'the prompt is too long to fit on one slide, so I split it', session_id: 'c1' });
  ok(!ops.some((o) => o.op === 'create' && o.message.errorKind), 'a successful reply MENTIONING the phrase is not an error card');
}

// ── 2. wiring pins (the unstaged-wiring class) ──
{
  const ws = read('src/ws-handler.js');
  ok(/\^\\\/compact\\b/.test(ws) && ws.includes("_streamingKind = 'compacting'") && ws.includes("kind: 'compacting'"), 'ws-handler labels a /compact send kind=compacting and broadcasts it');
  ok(ws.includes('streamingKind: isStreaming ? (session._streamingKind || null) : null'), 'attach meta carries streamingKind (reconnect mid-compaction keeps the guard)');
  // S5: the parse pipelines live in src/server/stdout/<protocol>.js
  const so = ['claude-stream-json', 'codex-events', 'acp-events'].map((m) => read(`src/server/stdout/${m}.js`)).join('\n');
  ok(so.includes('session._streamingKind = null;'), 'turn end resets the kind with the label');
  ok((so.match(/kind: session\._streamingKind \|\| null/g) || []).length >= 2, 'every streaming-label broadcast carries the kind (API-retry relabels do not drop the guard)');
  ok(read('src/session-schema.js').includes('_streamingKind:'), '_streamingKind registered in the session schema');
  const ci = read('src/lib/chat-input.js');
  ok(ci.includes("kind === 'compacting'") && ci.includes('btn.dataset.armed') && ci.includes("t('Cancel compaction?')"), 'chat-input: Stop is a two-step confirm while compacting');
  ok(ci.includes('sendText(text, { carriesUserText = false } = {})') && /\^\\\/compact\\b/.test(ci), 'chat-input: programmatic sendText + immediate compacting label on a /compact send');
  const cv = read('src/lib/chat-view.js');
  // (2026-09-07) the three call sites now go through _onServerStreamLabel — the
  // ONE place that remembers the server's label so the live sub-agent counter
  // can yield back to it; the KIND must still ride every one of them.
  ok(cv.includes('this._onServerStreamLabel(msg.label, msg.kind || null)') && cv.includes('meta?.streamingKind || null') && cv.includes('msg.streamingKind || null')
    && /_onServerStreamLabel\(label, kind\) \{[\s\S]{0,420}this\._showTyping\(label, kind \|\| null\);/.test(cv),
  'chat-view passes the kind through live label, attach meta and chat-status paths (all via the ONE _onServerStreamLabel)');
  // Compact now is PRODUCT-authored text: it owns neither the pending-send slot
  // nor the draft store, so it passes `carriesUserText: false` explicitly (the
  // design request, whose payload is the user's own brief, passes true —
  // round-8; pinned end-to-end in test-queue-steer).
  ok(cv.includes("onSendText: (txt) => this._chatInput?.sendText(txt, { carriesUserText: false })"), 'chat-view hands renderers a null-safe onSendText with the ACTION semantics');
  const cr = read('src/lib/chat-renderers.js');
  ok(cr.includes("msg.errorKind === 'prompt-too-long'") && cr.includes('appendContextFullCard') && cr.includes("this._onSendText('/compact')"), 'renderer: prompt-too-long → guidance card whose Compact-now sends /compact');
  ok(cr.includes('else btn.remove();'), 'view-only windows get the explanation without a dead button');
  const css = read('public/chat.css');
  ok(css.includes('.chat-interrupt-armed') && css.includes('.chat-ctx-compact-btn'), 'styles present (theme vars only)');
  ok(!/#[0-9a-fA-F]{3,6}\b/.test(css.slice(css.indexOf('.chat-interrupt-armed'), css.indexOf('.chat-ctx-compact-btn:disabled'))), 'no literal colors in the new rules');
  for (const f of ['src/lib/i18n-zh.js', 'src/lib/i18n-ja.js']) {
    const d = read(f);
    ok(d.includes("'Compact now'") && d.includes("'Cancel compaction?'") && d.includes('Click again to cancel the running compaction'), `${path.basename(f)} carries the new keys`);
  }
}
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
