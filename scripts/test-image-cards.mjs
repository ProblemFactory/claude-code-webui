#!/usr/bin/env node
// Image media cards (2.369.48, owner ask: "view image 能不能也多媒体化：可以展开
// 直接看到图像内容，点开可以放大"). Every image a tool LOOKED AT renders as one
// expandable media block (open by default, thumbnail in the body, click-to-zoom
// through the standard .chat-img overlay), drawn from disk via /api/file/raw —
// host-qualified for remote sessions — never from bytes in the message
// (the 2.369.35 law). Pins, against the REAL renderer module in node:
//   ① claude Read of an image → media card (2.369.35 lifted the bytes but the
//      Read branch returned BEFORE the generic thumbnail splice, and the splice
//      itself carried a stray '' that broke the URL — the card never showed)
//   ② remote session → &host=<hostId> on the raw URL; local → no host param
//   ③ non-image cards are byte-for-byte what they were (Read of a .md, Grep)
//   ④ codex view_image {path} → the same card; the normalizer makes ONE card per
//      call_id across the wrapper stub / rollout twin / event_msg
//      view_image_tool_call (formerly SKIPPED) and lifts input_image output
//      blocks to {mediaType, bytes}
//   ⑤ XSS: a path carrying "><img onerror> never reaches the DOM unescaped
//   ⑥ ACP/claude inline image blocks keep their data: URL inside the same wrapper
//   ⑦ wiring: capture-phase error delegate (broken thumbnails), fold hides the
//      card's DOM (lazy thumbnails never fetch), i18n, ci registration
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n + (e ? ' — ' + (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 500) : '')); } };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

// The renderer's module graph reaches the build-generated (gitignored)
// build-version.js through telemetry-client; the gate builds first, a bare
// run of this suite gets a stand-in so the import resolves.
const bv = path.join(REPO, 'src/lib/build-version.js');
if (!fs.existsSync(bv)) fs.writeFileSync(bv, "// GENERATED at build (gitignored) — stand-in written by test-image-cards\nexport const BUILD_VERSION = 'test';\n");
const R = await import(pathToFileURL(path.join(REPO, 'src/lib/chat-renderers.js')).href);
const mk = (host = null) => new R.ChatRenderers({ ws: null, sessionId: 's1', app: null, messageList: { addEventListener() {} }, getSessionCtx: () => ({ cwd: '/w', host }) });
const block = (o) => ({ type: 'tool_result', status: 'ok', ...o });
const readImg = (fp, extra = {}) => block({ toolName: 'Read', input: { file_path: fp }, output: '[{"type":"text","text":"[image image/png · 12 KB]"}]', images: [{ mediaType: 'image/png', bytes: 12345 }], ...extra });

// ── ① claude Read of an image → media card ──
{
  const html = mk().renderToolResult(readImg('/w/shots/a b.png'), {});
  ok('Read(image) renders an OPEN media block (owner: 展开直接看到)', /<details class="chat-diff chat-media" open>/.test(html), html);
  ok('…thumbnail is the FILE from disk via /api/file/raw, lazy, in the standard zoom class', /<img class="chat-img chat-tool-img" loading="lazy" src="\/api\/file\/raw\?path=%2Fw%2Fshots%2Fa%20b\.png"/.test(html), html);
  ok("…no stray quotes in the URL (the 2.369.35 `''` typo)", !/\.png''/.test(html) && !/raw\?path=[^"]*'/.test(html), html);
  ok('…summary carries an SVG icon + basename + type/size chip (never emoji)', /<summary class="chat-diff-summary"><svg[\s\S]*?<\/svg> a b\.png <span class="chat-media-meta">image\/png · 12 KB<\/span><\/summary>/.test(html), html);
  ok('…the honest fallback line is present (shown by the error delegate, no inline JS)', /<span class="chat-media-missing">Image not available on this machine<\/span>/.test(html) && !/onerror=/.test(html), html);
  ok('…no base64 anywhere in the card', !/base64/.test(html));
  // THE LIFTED BLOCKS DECIDE, NEVER THE EXTENSION. Real fleet shape (claude
  // cli 2.1.85; every one of the 10 `Read *.svg` tool_results in the local
  // corpus, 4 of them in one session): the result comes back as a PLAIN
  // numbered STRING ("1\t<svg xmlns=…"), NOT image blocks — classifying it as
  // an image by extension dropped the source entirely (silent loss).
  const svgSource = '1\t<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 92 36" width="92" height="36">\n2\t  <path d="M6.44 25.0V24.8"/>\n3\t</svg>';
  const svg = mk().renderToolResult(block({ toolName: 'Read', input: { file_path: '/tmp/logo.svg' }, output: svgSource }), {});
  ok('a Read of an .svg whose result is TEXT keeps the code-block card — the SOURCE is never dropped', /✓ 3 lines/.test(svg) && /data-lang="xml" data-filepath="\/tmp\/logo\.svg"/.test(svg) && /hljs-name">svg<\/span>/.test(svg) && /viewBox/.test(svg) && /M6\.44 25\.0V24\.8/.test(svg) && !/View image/.test(svg), svg);
  ok('…and the drawable file is ALSO shown, as a thumbnail appended BELOW the code block', /chat-media/.test(svg) && /path=%2Ftmp%2Flogo\.svg/.test(svg) && svg.indexOf('chat-media') > svg.indexOf('✓ 3 lines'), svg);
  const textJpg = mk().renderToolResult(block({ toolName: 'Read', input: { file_path: '/w/x.jpg' }, output: 'ok' }), {});
  ok('same for any image extension with a text result (an .jpg Read that returned text is a text card, not a media card)', /✓ 1 lines/.test(textJpg) && /chat-media/.test(textJpg) && !/View image/.test(textJpg), textJpg);
}

// ── ② remote sessions: the raw URL names the host ──
{
  const remote = mk('box-1').renderToolResult(readImg('/srv/shot.png'), {});
  ok('remote session → &host=<hostId> rides the raw URL (routes/files.js rfs dispatch)', /src="\/api\/file\/raw\?path=%2Fsrv%2Fshot\.png&amp;host=box-1"/.test(remote), remote);
  const local = mk(null).renderToolResult(readImg('/srv/shot.png'), {});
  ok('local session → no host param', /src="\/api\/file\/raw\?path=%2Fsrv%2Fshot\.png"/.test(local) && !/host=/.test(local), local);
  const odd = mk('h/1&2').renderToolResult(readImg('/srv/shot.png'), {});
  ok('hostId is URL-encoded', /host=h%2F1%262"/.test(odd), odd);
}

// ── ③ non-image cards unchanged ──
{
  const r = mk();
  const md = r.renderToolResult(block({ toolName: 'Read', input: { file_path: '/w/README.md' }, output: '# hi\nline2' }), {});
  ok('Read of a text file is the code-block card (no media block)', !/chat-media/.test(md) && /✓ 2 lines/.test(md) && /chat-link-path/.test(md), md);
  const grep = r.renderToolResult(block({ toolName: 'Grep', input: { pattern: 'x' }, output: 'a\nb' }), {});
  ok('a generic tool without images has no media/thumbnail markup at all', !/chat-media|chat-tool-images|chat-tool-img/.test(grep) && /<summary class="chat-diff-summary">Input<\/summary>/.test(grep), grep);
  const mcpShot = r.renderToolResult(block({ toolName: 'mcp__chrome__screenshot', input: { full: true }, output: '[image image/jpeg · 88 KB]', images: [{ mediaType: 'image/jpeg', bytes: 90000 }] }), {});
  ok('an image with NO path on disk (MCP screenshot) stays a size chip — nothing drawable, no <img>', /<span class="chat-tool-image-chip">image\/jpeg · 88 KB<\/span>/.test(mcpShot) && !/<img/.test(mcpShot), mcpShot);
  const genericFile = r.renderToolResult(block({ toolName: 'mcp__fs__read', input: { file_path: '/w/pic.webp' }, output: '[image image/webp · 5 KB]', images: [{ mediaType: 'image/webp', bytes: 5000 }] }), {});
  ok('a generic tool whose input names an image file draws it (media block inside .chat-tool-images)', /<div class="chat-tool-images"><details class="chat-diff chat-media" open>/.test(genericFile) && /path=%2Fw%2Fpic\.webp/.test(genericFile), genericFile);
  const tiff = r.renderToolResult(block({ toolName: 'Read', input: { file_path: '/w/scan.tiff' }, output: 'binary' }), {});
  ok('a non-browser-renderable extension (tiff) is not promised as a thumbnail', !/chat-media/.test(tiff), tiff);
  // …and when the harness DID lift image blocks for a format the browser
  // cannot decode, the card is honest: the chip/size line, never an <img>
  // that can only break
  const tiffImg = r.renderToolResult(block({ toolName: 'Read', input: { file_path: '/w/scan.tiff' }, output: '[image image/tiff · 2.0 MB]', images: [{ mediaType: 'image/tiff', bytes: 2097152 }] }), {});
  ok('a tiff/heic Read WITH lifted image blocks is an image card with the type/size chip and NO <img> (unrenderable ≠ broken thumbnail)', /Read/.test(tiffImg) && /<span class="chat-tool-image-chip">image\/tiff · 2\.0 MB<\/span>/.test(tiffImg) && !/<img/.test(tiffImg) && !/chat-media-missing/.test(tiffImg), tiffImg);
  const heic = r.renderToolResult(block({ toolName: 'Read', input: { file_path: '/w/IMG.HEIC' }, output: '[image image/heic · 3.0 MB]', images: [{ mediaType: 'image/heic', bytes: 3145728 }] }), {});
  ok('…same for .heic', /<span class="chat-tool-image-chip">image\/heic · 3\.0 MB<\/span>/.test(heic) && !/<img/.test(heic), heic);
}

// ── ④ codex view_image ──
{
  const html = mk('h2').renderToolResult(block({ toolName: 'view_image', input: { path: '/tmp/shot.png', detail: 'original' }, output: 'viewed /tmp/shot.png' }), {});
  ok('codex view_image {path} → the same media card (View image label, host-qualified URL)', /View image/.test(html) && /chat-media/.test(html) && /path=%2Ftmp%2Fshot\.png&amp;host=h2/.test(html), html);
  const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
  ok('view_image_tool_call left the SKIPPED set (it is routed now)', !CodexMessageManager.SKIPPED_EVENT_TYPES.has('view_image_tool_call'));
  const b64 = Buffer.alloc(6000).toString('base64');
  // wrapper stub twin (buffer) + codex's own rollout twin + the engine event + the
  // rollout's input_image output — the merge keeps all of them (different
  // fingerprints); the normalizer must still make ONE card
  const mm = new CodexMessageManager('cx');
  const msgs = mm.convertHistory([
    { type: 'response_item', payload: { type: 'function_call', name: 'view_image', arguments: JSON.stringify({ path: '/tmp/shot.png' }), call_id: 'call_1' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'viewed /tmp/shot.png', is_error: false } },
    { type: 'response_item', payload: { type: 'function_call', name: 'view_image', arguments: JSON.stringify({ path: '/tmp/shot.png', detail: 'original' }), call_id: 'call_1', id: 'fc_1' } },
    { type: 'event_msg', payload: { type: 'view_image_tool_call', call_id: 'call_1', path: '/tmp/shot.png' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_image', image_url: 'data:image/png;base64,' + b64 }] } },
  ]);
  const cards = msgs.filter((m) => m.role === 'tool');
  ok('ONE card per call_id across stub twin + rollout twin + event (dedupe by call_id)', cards.length === 1, cards.map((m) => m.toolCallId + ':' + m.status));
  const c = cards[0]?.content?.[0] || {};
  ok('…complete, image fold kind, input merged from the twins, path kept', cards[0]?.status === 'complete' && cards[0]?.collapseKind === 'image' && c.input?.path === '/tmp/shot.png' && c.input?.detail === 'original', c.input);
  ok('…the rollout input_image output is LIFTED to {mediaType, bytes}; no base64 in the card', Array.isArray(c.images) && c.images[0]?.mediaType === 'image/png' && c.images[0]?.bytes === 6000 && !/base64|AAAA/.test(JSON.stringify(cards[0])) && /\[image image\/png · 6 KB\]/.test(c.output), c);
  const html2 = mk().renderToolResult(c, cards[0]);
  ok('…and renders as the media card with the lifted size chip', /chat-media/.test(html2) && /image\/png · 6 KB/.test(html2), html2);
  const only = new CodexMessageManager('cx2').convertHistory([{ type: 'event_msg', payload: { type: 'view_image_tool_call', call_id: 'call_9', path: '/tmp/only.png' } }]).filter((m) => m.role === 'tool');
  ok('an event_msg WITHOUT the function_call pair still yields one complete view_image card (history without the wrapper stub)', only.length === 1 && only[0].status === 'complete' && only[0].collapseKind === 'image' && only[0].content[0].input.path === '/tmp/only.png', only);
  // live order (event first, pair later) also converges on one card
  const mm3 = new CodexMessageManager('cx3');
  const ops = [];
  mm3.onOp((op) => ops.push(op));
  mm3.processLive({ type: 'event_msg', payload: { type: 'view_image_tool_call', call_id: 'call_L', path: '/tmp/live.png' } });
  mm3.processLive({ type: 'response_item', payload: { type: 'function_call', name: 'view_image', arguments: JSON.stringify({ path: '/tmp/live.png', detail: 'original' }), call_id: 'call_L' } });
  mm3.processLive({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_L', output: 'viewed' } });
  ok('live: event → call → output converges on one card (create once, edits after)', ops.filter((o) => o.op === 'create').length === 1 && mm3.messages.filter((m) => m.role === 'tool').length === 1 && mm3.messages.find((m) => m.role === 'tool')?.content[0].input.detail === 'original', ops.map((o) => o.op));
  // the wrapper's record contract (shared with test-codex-p2-wrapper's stub) is untouched
  const wrapper = read('data/bin/codex-chat-wrapper.js');
  ok("wrapper still records an imageView item as function_call view_image {path} + a 'viewed <path>' output", /type === 'imageView'[\s\S]{0,500}name: 'view_image', arguments: JSON\.stringify\(\{ path: p \}\)[\s\S]{0,300}output: `viewed \$\{p \|\| 'image'\}`/.test(wrapper));
}

// ── ⑤ XSS ──
{
  const evil = '/tmp/x"><img src=x onerror=alert(1)>.png';
  const html = mk('h"><s>').renderToolResult(block({ toolName: 'Read', input: { file_path: evil }, output: 'x', images: [{ mediaType: 'image/png"><b>', bytes: 1 }] }), {});
  ok('a hostile path never lands in the DOM unescaped (attribute + text + URL param)', !/"><img src=x/.test(html) && !/<img src=x/.test(html) && !/<b>/.test(html) && !/<s>/.test(html), html);
  ok('…the raw URL carries it percent-encoded and the attribute value escaped', /path=%2Ftmp%2Fx%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert\(1\)%3E\.png&amp;host=h%22%3E%3Cs%3E"/.test(html) && /alt="x&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;\.png"/.test(html), html);
  const ev2 = mk().renderToolResult(block({ toolName: 'view_image', input: { path: evil }, output: 'viewed' }), {});
  ok('…same for the codex card', !/"><img src=x/.test(ev2) && /path=%2Ftmp%2Fx%22%3E/.test(ev2), ev2);
}

// ── ⑥ inline image blocks (ACP/claude user attachments) keep the data: URL inside the wrapper ──
{
  const html = R.imageMediaHtml({ dataUrl: 'data:image/png;base64,AAAA', mediaType: 'image/png', name: 'Image' });
  ok('imageMediaHtml(dataUrl) → media block with the data: URL thumbnail + zoom class', /<details class="chat-diff chat-media" open><summary class="chat-diff-summary"><svg[\s\S]*?<\/svg> Image <span class="chat-media-meta">image\/png<\/span><\/summary><div class="chat-media-body"><img class="chat-img chat-tool-img" loading="lazy" src="data:image\/png;base64,AAAA" alt="Image">/.test(html), html);
  const cr = read('src/lib/chat-renderers.js');
  ok('renderUserMsg routes image blocks (ACP + claude user attachments) through imageMediaHtml', /if \(b\.type === 'image'\) return imageMediaHtml\(\{ dataUrl: `data:\$\{b\.mediaType \|\| 'image\/png'\};base64,\$\{b\.data\}`/.test(cr));
  ok('no drawable source → size chip, never an empty <img>', /^<span class="chat-tool-image-chip">image\/gif · 2 KB<\/span>$/.test(R.imageMediaHtml({ mediaType: 'image/gif', bytes: 2048 })));
  ok('isImagePath covers the browser-renderable set only', R.isImagePath('/a/b.PNG') && R.isImagePath('x.avif') && !R.isImagePath('/a/b.tiff') && !R.isImagePath('/a/b.md') && !R.isImagePath(''));
}

// ── ⑦ wiring pins ──
{
  const cv = read('src/lib/chat-view.js');
  ok("chat-view flags a broken thumbnail through a CAPTURE-phase 'error' delegate on the list (no inline handlers)", /this\._messageList\.addEventListener\('error', \(e\) => \{[\s\S]{0,400}classList\.add\('chat-media-broken'\)[\s\S]{0,100}\}, true\);/.test(cv));
  ok('chat-view zooms any .chat-img through showImageOverlay (media thumbnails inherit the zoom)', (cv.match(/classList\.contains\('chat-img'\)\) \{\s*showImageOverlay\(e\.target\.src\)/g) || []).length >= 2);
  // THE CLASSIFIER LIVES IN THE PURE MODULE and answers by EVIDENCE, never by
  // extension: a claude `Read *.svg` comes back as numbered TEXT (12/12 real
  // fleet reads), and an extension rule both mis-counted it as an "image read"
  // and — since image members are fold-exempt — let a plain text card escape
  // its run (image-card review round 2, 2026-09-06).
  const RS = await import(pathToFileURL(path.join(REPO, 'src/lib/chat-run-summary.js')).href);
  const kindOf = (toolName, input, extra = {}) => RS.messageKind({ role: 'assistant', content: [{ type: 'tool_use', toolName, input, ...extra }] }, { toolCard: true });
  ok("a Read whose RESULT carried image blocks is 'image' — whatever the extension", kindOf('Read', { file_path: '/w/no-extension' }, { images: [{ mediaType: 'image/png', bytes: 1 }] }) === 'image'
    && kindOf('Read', { file_path: '/w/x.tiff' }, { images: [{ mediaType: 'image/tiff', bytes: 1 }] }) === 'image');
  ok("…and a Read whose result is TEXT is an ordinary file read, .png/.svg extension or not", kindOf('Read', { file_path: '/w/logo.svg' }) === 'read' && kindOf('Read', { file_path: '/w/shot.png' }) === 'read');
  ok('…codex/ACP keep deciding by their stamped collapseKind', RS.messageKind({ collapseKind: 'image', content: [{ type: 'tool_result', toolName: 'view_image', input: { path: '/w/a.png' } }] }, { toolCard: true }) === 'image');
  // …and the fold must not HIDE the image: 'image' is on by default and a lone
  // tool card auto-collapses, so every media card shipped folded into
  // "1 image read" (display:none ⇒ the lazy thumbnail never even fetched).
  // THE MEMBER IS EXEMPT, NOT THE RUN (image-card review round 2, 2026-09-06): in real sessions the media
  // card sits BETWEEN foldable cards (Bash → Read(png) → Bash), so a run-level
  // bail-out left it hidden in ~99% of real occurrences. Image members stay in
  // the run (rail, first/last, sticky, summary count) but never join the
  // collapsed set; a run with nothing else to fold gets no header at all.
  ok('image members are collected as run.inline inside flush(), and an all-image run builds no header', /const inline = new Set\(members\.filter\(\(el\) => memberKind\(el\) === 'image'\)\);\s*\n\s*if \(inline\.size === members\.length\) \{ run = \[\]; runKind = null; return; \}/.test(cv), cv.slice(cv.indexOf('const inline = new Set'), cv.indexOf('const inline = new Set') + 240));
  ok('…decided INSIDE flush(), before the members.length threshold (a mixed run still folds)', cv.indexOf('const inline = new Set') > cv.indexOf('const hasTool = members.some') && cv.indexOf('const inline = new Set') < cv.indexOf('if (members.length >= (hasTool ? 1 : 2))'));
  ok('…the run record carries `inline` and _setRunOpen never collapses those members', /const rec = \{ header, members, inline, footer: null, label, open: false, mkLabel, collabStats, _collabWasLive: collabLive \};/.test(cv)
    && /el\.classList\.toggle\('chat-run-collapsed', !run\.open && !run\.inline\?\.has\(el\)\);/.test(cv));
  ok('…while rail / first / last stay member-wide (ONE members list — the image is a member, just never collapsed)', /el\.classList\.toggle\('chat-run-member', run\.open\);\s*\n\s*el\.classList\.toggle\('chat-run-first', run\.open && i === 0\);\s*\n\s*el\.classList\.toggle\('chat-run-last', run\.open && i === n - 1\);/.test(cv)
    && /for \(const el of run\.members\) \{ if \(sticky\) this\._runStickyOpen\.add\(el\); else this\._runStickyOpen\.delete\(el\); \}/.test(cv));
  const css = read('public/chat.css');
  ok('a collapsed fold hides the whole card (display:none → lazy thumbnails never fetch)', /\.chat-msg\.chat-run-collapsed,\s*\.chat-compact \.chat-msg\.chat-run-collapsed \{ display: none; \}/.test(css));
  ok('media CSS: ~360×260 thumbnail, theme vars + --radius-sm, broken-state swap', /\.chat-tool-img \{[^}]*max-width: min\(360px, 100%\);[^}]*max-height: 260px;[^}]*border-radius: var\(--radius-sm\)/.test(css) && /\.chat-media\.chat-media-broken \.chat-tool-img \{ display: none; \}/.test(css) && /\.chat-media\.chat-media-broken \.chat-media-missing \{ display: inline; \}/.test(css) && !/\.chat-media[^{]*\{[^}]*#[0-9a-f]{3,6}/i.test(css));
  const zh = read('src/lib/i18n-zh.js'), ja = read('src/lib/i18n-ja.js');
  for (const k of ['"View image"', '"Image"', '"Image not available on this machine"']) ok(`i18n zh+ja carry ${k}`, zh.includes(k + ':') && ja.includes(k + ':'));
  ok('ci.mjs registers this suite', /'test-image-cards'/.test(read('scripts/ci.mjs')));
  const kb = read('docs/kb-features.md');
  ok('kb-features documents the media card', /media card|media block/.test(kb) && /2\.369\.48/.test(kb));
}

// ── ⑧ codex 0.153.4: `item_completed {item:{type:'ImageView'}}` IS the image view ──
// CORPUS FACT (82 local rollouts under ~/.codex/sessions, re-measured
// 2026-09-06): the 25 rollouts whose session_meta says cli_version 0.153.4
// carry 48 image views and every single one is an event_msg/item_completed
// ImageView item — ZERO `function_call view_image`, ZERO
// `view_image_tool_call`. Those two shapes appear only in the OLDER rollouts
// here (0.125.0/0.128.0/0.130.0: 98 calls + 15 events) and in the wrapper's
// LIVE stream. Until 2.369.48 both item_started and item_completed sat in
// SKIPPED_EVENT_TYPES, so a 0.153.4 conversation reopened from its rollout
// showed NO image cards at all.
// The 14 records below are cut VERBATIM from the 0.153.4 root rollout
// rollout-2026-09-05T13-26-05-01a0733f-… (its whole ImageView set at the time
// of the measurement); only the home prefix is anonymised.
const IMAGEVIEW_0153_JSONL = `
{"timestamp":"2026-09-05T20:55:42.622Z","ordinal":322,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a0733f-f028-7462-9769-be3e761a4f19","turn_id":"01a07340-04bc-7482-97fb-28ed6ed5a438","item":{"type":"ImageView","id":"exec-50c9dda7-3e61-4222-8498-e7222d29c523","path":"file:///home/u/w/proj/screenshots/studio.png"},"started_at_ms":1788641742622,"completed_at_ms":1788641742622}}
{"timestamp":"2026-09-05T20:55:42.628Z","ordinal":323,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a0733f-f028-7462-9769-be3e761a4f19","turn_id":"01a07340-04bc-7482-97fb-28ed6ed5a438","item":{"type":"ImageView","id":"exec-414888cb-8fa3-4da1-b028-33b915641e9b","path":"file:///home/u/w/proj/screenshots/mobile-studio.png"},"started_at_ms":1788641742628,"completed_at_ms":1788641742628}}
{"timestamp":"2026-09-05T20:58:58.429Z","ordinal":389,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a0733f-f028-7462-9769-be3e761a4f19","turn_id":"01a07340-04bc-7482-97fb-28ed6ed5a438","item":{"type":"ImageView","id":"exec-58cbe8a8-4752-4570-97b8-202a455e3a84","path":"file:///home/u/w/proj/screenshots/hero.png"},"started_at_ms":1788641938429,"completed_at_ms":1788641938429}}
{"timestamp":"2026-09-05T20:58:58.442Z","ordinal":390,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a0733f-f028-7462-9769-be3e761a4f19","turn_id":"01a07340-04bc-7482-97fb-28ed6ed5a438","item":{"type":"ImageView","id":"exec-61fe3918-eadd-4811-ac56-24be3e033aa0","path":"file:///home/u/w/proj/screenshots/floorplan.png"},"started_at_ms":1788641938442,"completed_at_ms":1788641938442}}
{"timestamp":"2026-09-05T21:22:55.492Z","ordinal":628,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a0733f-f028-7462-9769-be3e761a4f19","turn_id":"01a07367-0e0d-7f62-b0d8-fbfa86a1b204","item":{"type":"ImageView","id":"exec-5131e7c0-df74-4a2d-9e70-48b37b9f229a","path":"file:///home/u/w/proj/screenshots/v2-entry.png"},"started_at_ms":1788643375492,"completed_at_ms":1788643375492}}
{"timestamp":"2026-09-05T21:22:55.534Z","ordinal":629,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a0733f-f028-7462-9769-be3e761a4f19","turn_id":"01a07367-0e0d-7f62-b0d8-fbfa86a1b204","item":{"type":"ImageView","id":"exec-d22f82f1-f877-435d-bef9-07b325946b84","path":"file:///home/u/w/proj/screenshots/v2-sitting.png"},"started_at_ms":1788643375534,"completed_at_ms":1788643375534}}
{"timestamp":"2026-09-05T21:30:01.943Z","ordinal":760,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a0733f-f028-7462-9769-be3e761a4f19","turn_id":"01a07367-0e0d-7f62-b0d8-fbfa86a1b204","item":{"type":"ImageView","id":"exec-352600a0-ff99-4fca-97e9-374faa7a43c7","path":"file:///home/u/w/proj/screenshots/v2-mobile.png"},"started_at_ms":1788643801942,"completed_at_ms":1788643801943}}
{"timestamp":"2026-09-05T21:30:01.949Z","ordinal":761,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a0733f-f028-7462-9769-be3e761a4f19","turn_id":"01a07367-0e0d-7f62-b0d8-fbfa86a1b204","item":{"type":"ImageView","id":"exec-b985fb1f-eada-44c8-83da-4df619a7eeb4","path":"file:///home/u/w/proj/screenshots/v2-mobile-panel.png"},"started_at_ms":1788643801949,"completed_at_ms":1788643801949}}
{"timestamp":"2026-09-05T21:30:01.964Z","ordinal":762,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a0733f-f028-7462-9769-be3e761a4f19","turn_id":"01a07367-0e0d-7f62-b0d8-fbfa86a1b204","item":{"type":"ImageView","id":"exec-e3fad068-f02c-4175-af1e-0558d256ad90","path":"file:///home/u/w/proj/screenshots/v2-bath.png"},"started_at_ms":1788643801964,"completed_at_ms":1788643801964}}
{"timestamp":"2026-09-05T21:38:47.427Z","ordinal":865,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a0733f-f028-7462-9769-be3e761a4f19","turn_id":"01a07367-0e0d-7f62-b0d8-fbfa86a1b204","item":{"type":"ImageView","id":"exec-10e077b2-f3b6-42d5-b76e-7d6133aee6b8","path":"file:///home/u/w/proj/screenshots/v2-touch-mobile.png"},"started_at_ms":1788644327427,"completed_at_ms":1788644327427}}
{"timestamp":"2026-09-05T21:38:47.435Z","ordinal":866,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a0733f-f028-7462-9769-be3e761a4f19","turn_id":"01a07367-0e0d-7f62-b0d8-fbfa86a1b204","item":{"type":"ImageView","id":"exec-c98faf85-d820-4a41-afc0-807615edab57","path":"file:///home/u/w/proj/screenshots/v2-touch-controls.png"},"started_at_ms":1788644327435,"completed_at_ms":1788644327435}}
{"timestamp":"2026-09-05T22:24:21.388Z","ordinal":1317,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a0733f-f028-7462-9769-be3e761a4f19","turn_id":"01a07384-c656-71e3-b2c8-9d40c6ec95e3","item":{"type":"ImageView","id":"exec-e7b58295-a075-45e3-8af2-daf5f6ea7cb9","path":"file:///home/u/w/proj/screenshots/v3-installation.png"},"started_at_ms":1788647061388,"completed_at_ms":1788647061388}}
{"timestamp":"2026-09-05T22:24:21.397Z","ordinal":1318,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a0733f-f028-7462-9769-be3e761a4f19","turn_id":"01a07384-c656-71e3-b2c8-9d40c6ec95e3","item":{"type":"ImageView","id":"exec-e21c2839-c64c-4576-994e-c7a3da1e255f","path":"file:///home/u/w/proj/screenshots/v3-mobile-lab.png"},"started_at_ms":1788647061397,"completed_at_ms":1788647061397}}
{"timestamp":"2026-09-05T22:24:21.403Z","ordinal":1319,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a0733f-f028-7462-9769-be3e761a4f19","turn_id":"01a07384-c656-71e3-b2c8-9d40c6ec95e3","item":{"type":"ImageView","id":"exec-4fabc188-7c32-4f79-83e3-583598e9d26c","path":"file:///home/u/w/proj/screenshots/v3-mobile-body.png"},"started_at_ms":1788647061403,"completed_at_ms":1788647061403}}
`.trim().split('\n').map((l) => JSON.parse(l));

{
  const { CodexMessageManager } = require(path.join(REPO, 'src/codex-message-manager.js'));
  // COUNT CHECK on the real file's cut: 14 ImageView items → 14 image cards
  const cards = new CodexMessageManager('cx0153').convertHistory(IMAGEVIEW_0153_JSONL).filter((m) => m.role === 'tool');
  ok('0.153.4 rollout: 14 ImageView item_completed records → 14 image cards (this file rendered ZERO before 2.369.48)', cards.length === 14, cards.length);
  ok('…every card is COMPLETE — none left pending/streaming', cards.length === 14 && cards.every((m) => m.status === 'complete'), cards.map((m) => m.status).join(','));
  ok('…each folds under the image kind and is keyed by its own exec- item id', cards.every((m) => m.collapseKind === 'image') && new Set(cards.map((m) => m.toolCallId)).size === 14 && cards.every((m) => /^exec-[0-9a-f-]+$/.test(m.toolCallId)), cards.map((m) => m.toolCallId).slice(0, 2));
  const paths = cards.map((m) => m.content[0].input.path);
  ok('…the file:// URL is decoded to the plain path /api/file/raw wants', paths.every((p) => p.startsWith('/home/u/w/proj/screenshots/')) && !paths.some((p) => /file:\/\//.test(p)) && paths[0] === '/home/u/w/proj/screenshots/studio.png' && paths[13] === '/home/u/w/proj/screenshots/v3-mobile-body.png', paths[0]);
  const rendered = cards.map((m) => mk().renderToolResult(m.content[0], m));
  ok('…and all 14 render as media cards with a real thumbnail URL', rendered.filter((h) => /<img class="chat-img chat-tool-img"/.test(h) && /path=%2Fhome%2Fu%2Fw%2Fproj%2Fscreenshots%2F/.test(h)).length === 14, rendered[0]);
  const enc = new CodexMessageManager('cxEnc').convertHistory([{ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'ImageView', id: 'exec-enc', path: 'file:///home/u/w/proj/a%20b/%E5%9B%BE.png' } } }]).filter((m) => m.role === 'tool');
  ok('a percent-encoded file:// path is decoded ONCE (the raw URL re-encodes it, never doubly)', enc[0]?.content[0].input.path === '/home/u/w/proj/a b/图.png' && /path=%2Fhome%2Fu%2Fw%2Fproj%2Fa%20b%2F%E5%9B%BE\.png/.test(mk().renderToolResult(enc[0].content[0], enc[0])), enc[0]?.content[0].input.path);
  // a PLAIN path (what the live RPC hands the wrapper) is never touched — a
  // filename with a literal % would be corrupted by an unconditional decode
  const plain = new CodexMessageManager('cxPlain').convertHistory([{ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'ImageView', id: 'exec-plain', path: '/w/100%-scale.png' } } }]).filter((m) => m.role === 'tool');
  ok('a plain (non-file://) path passes through untouched — a literal % is not decoded', plain[0]?.content[0].input.path === '/w/100%-scale.png', plain[0]?.content[0].input.path);

  // LIVE + ROLLOUT CONVERGE ON ONE CARD: the wrapper's live stub records
  // `function_call view_image {path}` with call_id = the SAME exec-… item id
  // (verified in a real live buffer: call_id exec-a0e11416-… is the id of the
  // ImageView item the rollout wrote for that same view), and the live RPC
  // hands it a PLAIN path while the rollout persists the file:// URL.
  const merged = new CodexMessageManager('cxMerge').convertHistory([
    { type: 'response_item', payload: { type: 'function_call', name: 'view_image', arguments: JSON.stringify({ path: '/home/u/w/proj/renders/draft-entry.jpg' }), call_id: 'exec-a0e11416-83cd-405c-9fba-09876dbaae8f' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'exec-a0e11416-83cd-405c-9fba-09876dbaae8f', output: 'viewed /home/u/w/proj/renders/draft-entry.jpg', is_error: false } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: 't', turn_id: 'u', item: { type: 'ImageView', id: 'exec-a0e11416-83cd-405c-9fba-09876dbaae8f', path: 'file:///home/u/w/proj/renders/draft-entry.jpg' } } },
  ]).filter((m) => m.role === 'tool');
  ok('wrapper live stub + rollout ImageView (same exec- id, plain vs file:// path) = ONE complete card', merged.length === 1 && merged[0].status === 'complete' && merged[0].content[0].input.path === '/home/u/w/proj/renders/draft-entry.jpg', merged.map((m) => m.toolCallId + ':' + m.content[0].input.path));
  // a live stub whose OUTPUT never arrived (the wrapper died mid-view) is still
  // COMPLETED by the rollout's ImageView record — round-3 verifier A/B: master
  // completed it, the first rebase left it 'pending' forever
  const pend = new CodexMessageManager('cxPend').convertHistory([
    { type: 'response_item', payload: { type: 'function_call', name: 'view_image', arguments: JSON.stringify({ path: '/home/u/w/proj/renders/late.png' }), call_id: 'exec-pend-1' } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: 't', turn_id: 'u', item: { type: 'ImageView', id: 'exec-pend-1', path: 'file:///home/u/w/proj/renders/late.png' } } },
  ]).filter((m) => m.role === 'tool');
  ok('a known-but-PENDING view_image call (no function_call_output) is completed by the rollout ImageView record — one complete card, never pending forever', pend.length === 1 && pend[0].status === 'complete' && pend[0].content[0].type === 'tool_result' && /viewed .*late\.png/.test(pend[0].content[0].output), pend.map((m) => ({ s: m.status, t: m.content[0].type, o: m.content[0].output })));
  // an ImageView item_started (not in the corpus, but harmless if it appears)
  // must not add a second card nor leave a pending one behind
  const st = new CodexMessageManager('cxStart').convertHistory([
    { type: 'event_msg', payload: { type: 'item_started', item: { type: 'ImageView', id: 'exec-s1', path: 'file:///w/a.png' } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'ImageView', id: 'exec-s1', path: 'file:///w/a.png' } } },
  ]).filter((m) => m.role === 'tool');
  ok('an ImageView item_started + item_completed pair is still ONE complete card', st.length === 1 && st[0].status === 'complete', st.map((m) => m.status));

  // NEGATIVE CONTROL: every OTHER item type stays skipped exactly as before —
  // no cards, no `codex-unknown-record` telemetry. Shapes cut from the same
  // rollout (human-authored text replaced — only the shape matters here).
  const prevEvent = global.__vsEvent;
  const seenEv = [];
  global.__vsEvent = (n, d) => seenEv.push(n + '/' + d);
  const noneMsgs = new CodexMessageManager('cxOther').convertHistory([
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'th', turn_id: 'tu', item: { type: 'Reasoning', id: 'rs_0f70caa71c94cdcc016a9c7b15dd1087d0a867cd8e68931709', summary_text: [], raw_content: [] }, started_at_ms: 1788640021881, completed_at_ms: 1788640032584 } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'th', turn_id: 'tu', item: { type: 'UserMessage', id: '01a07384-c7bd-7803-8165-9becb8b12a3c', client_id: '1788642582283-pvnt1d', content: [{ type: 'text', text: '…', text_elements: [] }] }, started_at_ms: 1788644476861, completed_at_ms: 1788644476861 } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'th', turn_id: 'tu', item: { type: 'AgentMessage', id: 'msg_0f70caa71c94cdcc016a9c7aef9c4887d087009d07f2120212', content: [{ type: 'Text', text: '…' }], phase: 'commentary' }, started_at_ms: 1788639983635, completed_at_ms: 1788639987328 } },
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'th', turn_id: 'tu', item: { type: 'CommandExecution', id: 'exec-9b5911e2-85ef-4eb8-853d-da3f92417940', process_id: '8847', command: ['/usr/bin/zsh', '-lc', 'ls -lh'], cwd: 'file:///home/u/w/proj', status: 'failed', exit_code: 2 }, started_at_ms: 1788716114037, completed_at_ms: 1788716114037 } },
    { type: 'event_msg', payload: { type: 'item_started', item: { type: 'CommandExecution', id: 'exec-9b5911e2-85ef-4eb8-853d-da3f92417940' } } },
  ]);
  global.__vsEvent = prevEvent;
  // (Extension web.search / image_gen and SubAgentActivity completed are the
  // OTHER routed carriers of the same allowlist — they DO render, by design,
  // and test-codex-history owns them; they have no place in a no-card control.)
  ok('other item types (Reasoning/UserMessage/AgentMessage/CommandExecution, started+completed) stay SKIPPED — no cards (SubAgentActivity renders collab activity rows since B-7473 and is owned by test-codex-subagents)', noneMsgs.length === 0, noneMsgs.map((m) => m.role));
  ok('…and none of them is reported as an unknown record', !seenEv.some((e) => /codex-unknown-record/.test(e)), seenEv);
  const cmm = read('src/codex-message-manager.js');
  // ONE ROUTER: item_completed goes through _processItemCompleted (the explicit
  // item.type ALLOWLIST, ITEM_COMPLETED_SKIPPED_TYPES + telemetry for anything
  // unknown) BEFORE the generic skip set — ImageView is one of its routed
  // carriers, not a second dispatcher (image-card review round 2 integration).
  ok('item_completed has exactly ONE router and it runs BEFORE the skip set', (cmm.match(/if \(type === 'item_completed'\) return this\._processItemCompleted\(event, emit\);/g) || []).length === 1
    && (cmm.match(/_processItemCompleted\(event, emit\) \{/g) || []).length === 1
    && !/_processItemEvent/.test(cmm)
    && cmm.indexOf("this._processItemCompleted(event, emit)") < cmm.indexOf('if (SKIPPED_EVENT_TYPES.has(type)) return;'), 'router shape');
  ok("…and its ImageView case routes into the SHARED image-view card path (no second card builder)", /if \(type === 'ImageView'\) \{[\s\S]{0,600}this\._processViewImageEvent\(\{ call_id: it\.id \|\| this\._nextId\(\), path: it\.path \}, emit\);/.test(cmm));
  // ONE DECODER: fileUrlToPath is defined once and applied ONLY inside the card
  // paths every carrier of an image funnels through — _processViewImageEvent
  // (viewed) and, since 2.369.58, _processImageGenEvent (generated). Never an
  // inline `replace(/^file:\/\//)` at a call site: that is how a second,
  // subtly-different decoder gets born.
  ok('fileUrlToPath is declared ONCE and called only from the image CARD PATHS', (cmm.match(/function fileUrlToPath\(/g) || []).length === 1
    && (cmm.match(/fileUrlToPath\(/g) || []).length === 3
    && /_processViewImageEvent\(event, emit\) \{[\s\S]{0,300}const path = fileUrlToPath\(/.test(cmm)
    && /_processImageGenEvent\(event, emit\) \{[\s\S]{0,300}const path = fileUrlToPath\(/.test(cmm)
    && !/replace\(\/\^file:\\\/\\\/\//.test(cmm), 'decoder sites: ' + (cmm.match(/fileUrlToPath\(/g) || []).length);
  ok('item_started/item_completed stay in SKIPPED_EVENT_TYPES (the router runs first, the set is the fallback)', CodexMessageManager.SKIPPED_EVENT_TYPES.has('item_completed') && CodexMessageManager.SKIPPED_EVENT_TYPES.has('item_started'));
  ok('view_image_tool_call is routed out of the skip set and shares that same path', !CodexMessageManager.SKIPPED_EVENT_TYPES.has('view_image_tool_call') && /if \(type === 'view_image_tool_call'\) return this\._processViewImageEvent\(event, emit\);/.test(cmm));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
