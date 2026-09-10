#!/usr/bin/env node
// test-path-linkify — where a file path ENDS in chat prose (src/path-linkify.js,
// the ONE definition the chat renderer uses). Owner screenshot 2026-09-10: a
// Chinese parenthetical after a path (`…/designs/（浏览器`) was swallowed into the
// link. CJK FILENAMES must keep linking; only punctuation terminates a path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { pathRe, cleanPath, CJK_PUNCT } = require(path.join(ROOT, 'src/path-linkify.js'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (${JSON.stringify(a)})`);
const links = (re, text) => { const out = []; text.replace(re, (raw) => { out.push(cleanPath(raw)); return raw; }); return out; };

console.log('① the shipped rule');
eq(links(pathRe(), '中文版在 /home/u/w/SharedContext/designs/（浏览器 1783 行、通讯 1657 行）'), ['/home/u/w/SharedContext/designs/'],
  'a fullwidth "（" ends the path (the owner screenshot)');
eq(links(pathRe(), '看 /home/u/文档/报告.md，然后 /tmp/x/y.txt。再看 /var/log/app.log：没有'), ['/home/u/文档/报告.md', '/tmp/x/y.txt', '/var/log/app.log'],
  'CJK filenames still link; fullwidth comma / period / colon end the path');
eq(links(pathRe(), '“/etc/hosts”和「/usr/bin/env」以及【/opt/x/y】…'), ['/etc/hosts', '/usr/bin/env', '/opt/x/y'],
  'curly quotes, corner brackets and lenticular brackets end it');
eq(links(pathRe(), 'see /a/b/c.js:12:3) and (/a/b/d.md).'), ['/a/b/c.js:12:3', '/a/b/d.md'],
  'ASCII behaviour unchanged: :line:col kept, trailing ) and . stripped');
// The raw rule DOES match the path part of a URL and a /p/<id> page path; the
// renderer prevents that by ORDER (URLs and page paths are linkified first and
// wrapped in tags the path pass skips) — pinned below in ③, not asserted here.
eq(cleanPath('https://x.y/z）。'), 'https://x.y/z', 'cleanPath strips CJK trailing punctuation from URLs too');
eq(cleanPath('/home/u/项目'), '/home/u/项目', 'cleanPath never strips a CJK LETTER');
ok(/\\u3000-\\u303F/.test(CJK_PUNCT) && /\\uFF01-\\uFF0F/.test(CJK_PUNCT), 'the class covers CJK symbols + fullwidth ASCII punctuation, and skips fullwidth digits/letters (FF10-FF19, FF21-FF3A, FF41-FF5A)');
ok(!/\\uFF10|\\uFF21|\\uFF41/.test(CJK_PUNCT), '…the fullwidth digit/letter ranges are NOT in the class (a filename spelled with them stays linkable)');
eq(links(pathRe(), '/home/u/ＡＢＣ１２.txt。'), ['/home/u/ＡＢＣ１２.txt'], 'a fullwidth-letter filename still links');

console.log('② NEGATIVE CONTROL: the pre-fix rule (chat-renderers.js as shipped before 2.369.89)');
const PRE_FIX = /(?<![="'\w/])((?:~|\.\.?)?\/[^\0<>?\s!`&*()'":;\\][^\0<>?\s!`&*()'"\\:;]*(?:\/[^\0<>?\s!`&*()'"\\:;]+)+(?::\d+(?::\d+)?)?)/g;
const preClean = (p) => p.replace(/[`'".,;:!?)}\]]+$/, '');
const pre = []; '中文版在 /home/u/w/SharedContext/designs/（浏览器 1783 行'.replace(PRE_FIX, (raw) => { pre.push(preClean(raw)); return raw; });
eq(pre, ['/home/u/w/SharedContext/designs/（浏览器'], 'the retired rule swallows the "（" and the word after it — the defect reproduces');

console.log('③ WIRING PIN: the renderer uses the shared definition and carries no local copy');
const cr = fs.readFileSync(path.join(ROOT, 'src/lib/chat-renderers.js'), 'utf8');
ok(/from '\.\.\/path-linkify\.js'/.test(cr), 'chat-renderers imports src/path-linkify.js');
ok(/const pathRe = sharedPathRe\(\)/.test(cr) && /cleanPath\(p\) \{ return sharedCleanPath\(p\); \}/.test(cr), 'both the path regex and cleanPath delegate to it');
ok(!/\[\^\\0<>\?\\s!`&\*\(\)'":;\\\\\]/.test(cr), 'no inline copy of the old character class survives in the renderer');
ok(/linkifyPathsTagSafe\(this\.linkifyPagePaths\(this\.linkifyUrls\(text\)\)/.test(cr), 'ORDER pin: URLs and /p/<id> pages are linkified BEFORE paths, so the path rule never sees them (it would match their path part)');

console.log(fail ? `\n${fail} FAILED (${pass} passed)` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
