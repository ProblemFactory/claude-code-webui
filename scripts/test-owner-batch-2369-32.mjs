#!/usr/bin/env node
// Owner batch 2.369.32 (six reports): codex resume keeps the LAST-run model,
// the wrapper pins a chosen model, sub-agent threads hidden by default, the
// codex ⟳ refreshes codex, auto-resume's continue prompt is labelled, a 0%
// bucket says "not started". Functional where the code is a module; pins for
// the client + wrapper text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 300) : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

// ── codex model continuity: lastCodexTurnModel reads the rollout tail ──
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ob32-'));
process.env.HOME = home; process.env.CODEX_HOME = path.join(home, '.codex');
const dir = path.join(home, '.codex', 'sessions', '2026', '09', '05'); fs.mkdirSync(dir, { recursive: true });
const TID = '01a072a3-0d70-78c3-9a90-a69a61e14465';
const rec = (o) => JSON.stringify(o) + '\n';
fs.writeFileSync(path.join(dir, `rollout-2026-09-05T10-34-43-${TID}.jsonl`), [
  rec({ timestamp: '2026-09-05T17:34:43.568Z', type: 'session_meta', payload: { id: TID, cwd: '/w', originator: 'claude-code-webui', model_provider: 'openai' } }),
  rec({ timestamp: '2026-09-05T17:49:40.476Z', type: 'turn_context', payload: { cwd: '/w', model: 'gpt-5.6-sol' } }),
  rec({ timestamp: '2026-09-05T18:10:00.000Z', type: 'turn_context', payload: { cwd: '/w', model: 'gpt-5.6-sol' } }),
  rec({ timestamp: '2026-09-05T19:50:26.447Z', type: 'turn_context', payload: { cwd: '/w', model: 'gpt-6-astra' } }),
  rec({ timestamp: '2026-09-05T19:51:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok "model":"gpt-5.6-sol" mentioned in prose' }] } }),
].join(''));
const CX = require(path.join(REPO, 'src/adapters/codex.js'));
ok(CX.lastCodexTurnModel(TID) === 'gpt-6-astra', 'lastCodexTurnModel = the LAST turn_context model (prose mentions of other models are ignored)');
ok(CX.lastCodexTurnModel('00000000-0000-4000-8000-000000000000') === null, 'unknown thread → null (resume falls back to the default)');
const wc = read('src/ws-create.js');
ok(/if \(!sessionSpec\.env\.CODEX_WEBUI_MODEL\) \{ try \{ const lm = lastCodexTurnModel\(data\.resumeId\); if \(lm\) sessionSpec\.env\.CODEX_WEBUI_MODEL = lm; \} catch \{ \} \}/.test(wc) && /findCodexSessionJsonlPath, lastCodexTurnModel/.test(wc), 'ws-create: a codex resume without an explicit model carries the last-run model (client choice still wins when sent)');
const w = read('data/bin/codex-chat-wrapper.js');
ok(/meta\.model = meta\.modelPinned \? \(meta\.model \|\| resp\?\.model \|\| thread\.model \|\| ''\) : \(resp\?\.model \|\| thread\.model \|\| meta\.model\);/.test(w) && /meta\.modelPinned = !!msg\.model;/.test(w) && /modelPinned: !!model,/.test(w), 'wrapper: a chosen model is pinned — thread/resume or thread/name/set responses never revert it to the thread START model');

// ── auto-resume continue prompt labelled (claude + codex normalizers) ──
const { MessageManager } = require(path.join(REPO, 'src/message-manager.js'));
const mm = new MessageManager('s1'); const ops = []; mm.onOp((o) => ops.push(o));
mm.processLive({ type: 'user', _fromWebui: true, originKind: 'auto-resume', message: { role: 'user', content: [{ type: 'text', text: 'You can continue now. Continue the task you were working on when the usage limit was reached; do not repeat work that is already complete.' }] } });
const um = mm.messages.find((m) => m.role === 'user');
ok(um && um.originKind === 'auto-resume' && um.typed !== true, 'claude normalizer: the server-tagged continue record carries originKind auto-resume (not "typed")');
mm.processLive({ type: 'user', _fromWebui: true, message: { role: 'user', content: [{ type: 'text', text: 'real prompt' }] } });
ok(mm.messages.filter((m) => m.role === 'user')[1].typed === true && !mm.messages.filter((m) => m.role === 'user')[1].originKind, 'negative control: a typed prompt stays typed');
const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
const cm = new CodexMessageManager('c1');
cm.processLive({ timestamp: new Date().toISOString(), type: 'response_item', _fromWebui: true, payload: { type: 'message', role: 'user', webui_msg_id: '1-auto', webui_origin: 'auto-resume', content: [{ type: 'input_text', text: 'You can continue now.' }] } });
ok(cm.messages.find((m) => m.role === 'user')?.originKind === 'auto-resume', 'codex normalizer: webui_origin auto-resume → originKind auto-resume');
ok(/userMsg\.originKind = 'auto-resume'; if \(userMsg\.payload\) userMsg\.payload\.webui_origin = 'auto-resume';/.test(read('server.js')), 'server.js sendToSession tags the continue record for BOTH harness shapes');
const cr = read('src/lib/chat-renderers.js');
ok(/if \(msg\.originKind === 'auto-resume'\) \{[\s\S]{0,600}chat-msg-auto-resume[\s\S]{0,400}VibeSpace auto-resume — sent automatically after the usage limit cleared/.test(cr), 'chat-renderers renders the auto-resume prompt as a labelled VibeSpace card');
ok(['src/lib/i18n-zh.js', 'src/lib/i18n-ja.js'].every((f) => read(f).includes('"VibeSpace auto-resume — sent automatically after the usage limit cleared":') && read(f).includes('"not started":')), 'zh/ja carry the new strings');

// ── sidebar: primary-only default ──
const sb = read('src/lib/sidebar.js');
ok(/this\._agentKindFilter = storedKind == null \? 'primary' : \(storedKind === 'all' \? '' : storedKind\);/.test(sb) && /localStorage\.setItem\('agentKindFilter', 'all'\)/.test(sb), 'sidebar: no stored choice ⇒ PRIMARY only; ALL persists explicitly');

// ── usage popup: codex ⟳ dispatch + not-started reset ──
const um2 = read('src/lib/usage-meter.js');
const iCodex = um2.indexOf("e.target.closest('.usage-refresh-codex-btn')"), iGeneric = um2.indexOf("e.target.closest('.usage-refresh-btn')");
ok(iCodex > 0 && iGeneric > 0 && iCodex < iGeneric, 'usage-meter: the codex ⟳ (both classes) is dispatched BEFORE the generic claude ⟳');
ok(/const fmtReset = \(ts, util(?:, est)?\) => \{/.test(um2) && (um2.match(/fmtReset\([^)]*utilization[^)]*\)/g) || []).length === 5 && /t\('not started'\)/.test(um2), "usage-meter: every reset cell passes utilization; 0% with no reset time renders 'not started' (tooltip explains)");

// ── 2.369.33: the 'search' fold kind + weekly reset projection ──
{
  const ss = read('src/lib/settings-schema.js');
  ok(/default: \['thinking', 'bash', 'read', 'memory', 'mcp', 'skill', 'agent', 'search', 'image'\]/.test(ss) && /value: 'search', label: t\('Web searches \/ fetches/.test(ss) && /value: 'image', label: t\('Image views/.test(ss), "settings: 'search' and 'image' are fold kinds, ON by default");
  const cv = read('src/lib/chat-view.js');
  // 2.369.37: the classifier + summary composer moved to the PURE module
  // src/lib/chat-run-summary.js (owner caught "1 次 MCP" over a ToolSearch —
  // it is a 'lookup' now: folds under the MCP toggle, labelled honestly)
  const RS = await import(path.join(REPO, 'src/lib/chat-run-summary.js'));
  const tk = (name, input = {}, extra = {}) => RS.messageKind({ role: 'assistant', content: [{ type: 'tool_use', toolName: name, input, ...extra }] }, { toolCard: true });
  const tt = (k, p) => k.replace(/\{(\w+)\}/g, (m, x) => String(p?.[x] ?? m));
  ok(tk('WebSearch') === 'search' && tk('WebFetch') === 'search' && tk('Grep') === 'read' && tk('Glob') === 'read' && tk('LS') === 'read' && tk('ToolSearch') === 'lookup' && RS.foldToggleFor('lookup') === 'mcp'
    && tk('Read', { file_path: '/x/y.png' }, { images: [{ mediaType: 'image/png', bytes: 9 }] }) === 'image'
    && tk('Read', { file_path: '/x/y.png' }) === 'read' && tk('Read', { file_path: '/x/logo.svg' }) === 'read' // EVIDENCE, not the extension (image-card review round 2, 2026-09-06)
    && RS.runSummaryParts(RS.countKinds(['search', 'search', 'image', 'read']), new Set(), tt).join(' · ') === '1 file reads · 2 web searches · 1 image reads'
    && /messageKind\(el\._rawMsg, \{ toolCard: el\.classList\.contains\('chat-msg-tool-result'\), isMemoryPath \}\)/.test(cv) && /'mcp', 'agent', 'search', 'image'\]\)/.test(cv), 'chat-view: WebSearch/WebFetch→search, Grep/Glob/LS→read, ToolSearch→lookup (folds under mcp, labelled apart); summary counts searches; default set includes search');
  const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
  const cm2 = new CodexMessageManager('c2');
  cm2.processLive({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call', call_id: 'ws1', name: 'web_search', arguments: '{"query":"rv solar"}' } });
  const card = cm2.messages.find((m) => m.role === 'tool');
  ok(card && card.collapseKind === 'search', "codex normalizer stamps collapseKind 'search' on web_search cards", card?.collapseKind);
  cm2.processLive({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call', call_id: 'vi1', name: 'view_image', arguments: '{"path":"/tmp/x.png"}' } });
  ok(cm2.messages.filter((m) => m.role === 'tool').some((m) => m.collapseKind === 'image'), "codex view_image cards fold as 'image'");
  const { collapseKindOf } = require(path.join(REPO, 'src/acp-message-manager.js'));
  ok(collapseKindOf('search') === 'search' && collapseKindOf('read') === 'read', "ACP tool kind 'search' folds as search");
  const { projectReset, WEEK_SEC } = require(path.join(REPO, 'src/harnesses/claude-quota.js'));
  const anchor = 1788973200; // an observed weekly reset
  ok(projectReset(anchor, WEEK_SEC, anchor - 100) === anchor, 'projectReset: a future reset is returned as-is');
  ok(projectReset(anchor, WEEK_SEC, anchor + 1) === anchor + WEEK_SEC && projectReset(anchor, WEEK_SEC, anchor + 3 * WEEK_SEC + 5) === anchor + 4 * WEEK_SEC, 'projectReset: the first 7-day multiple strictly in the future');
  ok(projectReset(0, WEEK_SEC, 1) === null && projectReset(anchor, 0, anchor + 1) === null, 'projectReset: no anchor / no period → null');
  const ur = read('src/usage-routes.js');
  ok(/merged\.sevenDay = \{ \.\.\.merged\.sevenDay, resetsAt: p, resetsAtEstimated: true \}/.test(ur) && /before \? projectReset\(before\.resetsAt, WEEK_SEC, nowSec\) : null/.test(ur) && !/fiveHour[^\n]*projectReset/.test(ur), 'usage-routes projects sevenDay + scopedWeekly from the previous cache (never the 5-hour bucket)');
  ok(/const fmtReset = \(ts, util, est\) => \{/.test(um2) && /return estMark \+ \(left > 45/.test(um2) && /rl\.sevenDay\?\.resetsAtEstimated\)/.test(um2) && /sc\.resetsAtEstimated\)/.test(um2), 'usage popup marks projected resets with ≈ (weekly + scoped weekly cells)');
}

// ── 2.369.35: binary image results never enter a card (the frozen-page incident) ──
{
  const { MessageManager: MM2, splitToolResultContent } = require(path.join(REPO, 'src/message-manager.js'));
  const m2 = new MM2('img'); const big = 'A'.repeat(800000);
  m2.processLive({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/tmp/shot.png' } }] } });
  m2.processLive({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }] }] } });
  const card = m2.messages.find((m) => m.role === 'tool'); const b = card?.content?.[0];
  ok(b && b.type === 'tool_result' && b.output.length < 200 && /\[image image\/png · 586 KB\]/.test(b.output) && b.images?.[0]?.mediaType === 'image/png' && b.images[0].bytes === 600000 && JSON.stringify(card).length < 2000, `a Read-of-PNG tool result carries {mediaType, bytes} metadata, never the base64 (card ${JSON.stringify(card).length} bytes)`, b?.output?.slice(0, 80));
  ok(splitToolResultContent([{ type: 'text', text: 'hi' }]).text === '[{"type":"text","text":"hi"}]' && splitToolResultContent('plain').text === 'plain' && splitToolResultContent([{ type: 'text', text: 'a' }, { type: 'image', source: { media_type: 'image/jpeg', data: 'xx' } }]).images.length === 1, 'text/array results keep their exact previous shape; mixed results lift only the images');
  const cr2 = read('src/lib/chat-renderers.js');
  // 2.369.48 seam (the pin follows the CODE, not the other way round): the
  // lifted blocks feed ONE exported imageMediaHtml() whose thumbnail URL comes
  // from imageRawUrl() (= the file viewer's /api/file/raw, host-qualified);
  // the generic card splices ${mediaHtml}; no drawable path = a size chip.
  // "never a data: URL from the card" is pinned BEHAVIOURALLY in
  // test-image-cards ① (renders a card from image blocks, greps for base64) —
  // a source-wide `!/data:/` assert is wrong here, renderUserMsg's inline
  // ACP/claude attachments legitimately build one.
  ok(/const images = Array\.isArray\(block\.images\) \? block\.images : \[\];/.test(cr2) && /export function imageRawUrl\(fp, host\) \{\s*return `\/api\/file\/raw\?path=\$\{encodeURIComponent\(fp\)\}/.test(cr2) && /imageMediaHtml\(\{ path: isImagePath\(fp\) \? fp : '', host: mediaHost, mediaType: im\.mediaType, bytes: im\.bytes \}\)/.test(cr2) && /chat-tool-image-chip/.test(cr2) && /<\/span>\$\{mediaHtml\}<details class="chat-diff"><summary class="chat-diff-summary">\$\{t\('Input'\)\}/.test(cr2) && !/imagesHtml/.test(cr2) && /\.chat-tool-images/.test(read('public/chat.css')), 'the tool card renders image results from the FILE (imageMediaHtml over imageRawUrl = the file viewer URL) or a size chip — never a base64 blob built by the card');
}

fs.rmSync(home, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
