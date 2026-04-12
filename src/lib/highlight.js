/**
 * Syntax highlighting utilities — hljs registration, language detection,
 * code block rendering with line numbers.
 */

import hljs from 'highlight.js/lib/core';
import hljsJavascript from 'highlight.js/lib/languages/javascript';
import hljsTypescript from 'highlight.js/lib/languages/typescript';
import hljsPython from 'highlight.js/lib/languages/python';
import hljsJson from 'highlight.js/lib/languages/json';
import hljsYaml from 'highlight.js/lib/languages/yaml';
import hljsXml from 'highlight.js/lib/languages/xml';
import hljsCss from 'highlight.js/lib/languages/css';
import hljsBash from 'highlight.js/lib/languages/bash';
import hljsC from 'highlight.js/lib/languages/c';
import hljsCpp from 'highlight.js/lib/languages/cpp';
import hljsGo from 'highlight.js/lib/languages/go';
import hljsRust from 'highlight.js/lib/languages/rust';
import hljsJava from 'highlight.js/lib/languages/java';
import hljsSql from 'highlight.js/lib/languages/sql';
import hljsMarkdown from 'highlight.js/lib/languages/markdown';
import hljsDiff from 'highlight.js/lib/languages/diff';
import hljsDockerfile from 'highlight.js/lib/languages/dockerfile';
import hljsIni from 'highlight.js/lib/languages/ini';
import hljsRuby from 'highlight.js/lib/languages/ruby';
import hljsPhp from 'highlight.js/lib/languages/php';
import hljsSwift from 'highlight.js/lib/languages/swift';
import hljsKotlin from 'highlight.js/lib/languages/kotlin';
import hljsScala from 'highlight.js/lib/languages/scala';
import hljsCsharp from 'highlight.js/lib/languages/csharp';
import hljsLua from 'highlight.js/lib/languages/lua';
import hljsR from 'highlight.js/lib/languages/r';
import hljsPerl from 'highlight.js/lib/languages/perl';
import hljsScss from 'highlight.js/lib/languages/scss';
import hljsGraphql from 'highlight.js/lib/languages/graphql';
import hljsNginx from 'highlight.js/lib/languages/nginx';
import hljsProtobuf from 'highlight.js/lib/languages/protobuf';
import { escHtml } from './utils.js';

hljs.registerLanguage('javascript', hljsJavascript);
hljs.registerLanguage('typescript', hljsTypescript);
hljs.registerLanguage('python', hljsPython);
hljs.registerLanguage('json', hljsJson);
hljs.registerLanguage('yaml', hljsYaml);
hljs.registerLanguage('xml', hljsXml);
hljs.registerLanguage('css', hljsCss);
hljs.registerLanguage('bash', hljsBash);
hljs.registerLanguage('c', hljsC);
hljs.registerLanguage('cpp', hljsCpp);
hljs.registerLanguage('go', hljsGo);
hljs.registerLanguage('rust', hljsRust);
hljs.registerLanguage('java', hljsJava);
hljs.registerLanguage('sql', hljsSql);
hljs.registerLanguage('markdown', hljsMarkdown);
hljs.registerLanguage('diff', hljsDiff);
hljs.registerLanguage('dockerfile', hljsDockerfile);
hljs.registerLanguage('ini', hljsIni);
hljs.registerLanguage('ruby', hljsRuby);
hljs.registerLanguage('php', hljsPhp);
hljs.registerLanguage('swift', hljsSwift);
hljs.registerLanguage('kotlin', hljsKotlin);
hljs.registerLanguage('scala', hljsScala);
hljs.registerLanguage('csharp', hljsCsharp);
hljs.registerLanguage('lua', hljsLua);
hljs.registerLanguage('r', hljsR);
hljs.registerLanguage('perl', hljsPerl);
hljs.registerLanguage('scss', hljsScss);
hljs.registerLanguage('graphql', hljsGraphql);
hljs.registerLanguage('nginx', hljsNginx);
hljs.registerLanguage('protobuf', hljsProtobuf);

// Map file extensions to highlight.js language identifiers
const EXT_TO_LANG = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', pyw: 'python',
  rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', swift: 'swift', m: 'objectivec',
  php: 'php', pl: 'perl', pm: 'perl',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  sql: 'sql', r: 'r', lua: 'lua', scala: 'scala', groovy: 'groovy',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', tex: 'latex',
  dockerfile: 'dockerfile', makefile: 'makefile',
  graphql: 'graphql', proto: 'protobuf', thrift: 'thrift',
  diff: 'diff', patch: 'diff',
  nginx: 'nginx', conf: 'nginx',
};

export function detectHljsLang(filePath) {
  if (!filePath) return '';
  const name = filePath.split('/').pop().toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return EXT_TO_LANG[ext] || '';
}

/** Get list of all registered hljs language names (for language picker) */
export function getHljsLanguages() {
  return hljs.listLanguages();
}

/**
 * Render code with line numbers + syntax highlighting.
 * Returns HTML string for a .chat-code-block element.
 */
export function renderCodeBlock(code, filePath) {
  const lang = detectHljsLang(filePath);
  const skipHighlight = code.length > 10000;
  let highlighted;
  try {
    highlighted = (!skipHighlight && lang) ? hljs.highlight(code, { language: lang }).value : escHtml(code);
  } catch {
    highlighted = escHtml(code);
  }
  const lines = highlighted.split('\n');
  const gutterW = String(lines.length).length;
  let body = '';
  for (let i = 0; i < lines.length; i++) {
    body += `<div class="chat-code-line"><span class="chat-code-ln" style="width:${gutterW + 1}ch">${i + 1}</span><span class="chat-code-text">${lines[i] || ' '}</span></div>`;
  }
  const langLabel = lang || 'plain';
  const deferred = skipHighlight ? ' data-highlight-deferred="1"' : '';
  return `<div class="chat-code-block" data-lang="${escHtml(langLabel)}" data-filepath="${escHtml(filePath)}"${deferred}>${body}</div>`;
}

/**
 * Apply syntax highlighting to an already-rendered .chat-code-block DOM element.
 */
export function rehighlightCodeBlock(blockEl, langId) {
  const code = Array.from(blockEl.querySelectorAll('.chat-code-text')).map(s => s.textContent).join('\n');
  let highlighted;
  try {
    highlighted = langId && langId !== 'plain' ? hljs.highlight(code, { language: langId }).value : escHtml(code);
  } catch {
    highlighted = escHtml(code);
  }
  const lines = highlighted.split('\n');
  const lineEls = blockEl.querySelectorAll('.chat-code-text');
  for (let i = 0; i < lineEls.length && i < lines.length; i++) {
    lineEls[i].innerHTML = lines[i] || ' ';
  }
  blockEl.dataset.lang = langId || 'plain';
}

// Strip ANSI escape sequences (colors, cursor, etc.)
export function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}
