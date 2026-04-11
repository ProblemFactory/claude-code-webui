/**
 * ChatRenderer — shared rendering utilities for chat messages.
 *
 * Extracted from ChatView so both v1 and v2 can use the same rendering logic.
 * Contains: markdown, code blocks, diffs, linkification, wrap toggles, etc.
 */
import { marked } from 'marked';
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

// Register highlight.js languages
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

// Extension → highlight.js language map
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

function detectHljsLang(filePath) {
  if (!filePath) return '';
  const name = filePath.split('/').pop().toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return EXT_TO_LANG[ext] || '';
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// ── Rendering functions ──

function renderMarkdown(text) {
  try {
    let html = marked.parse(text || '');
    return linkify(html);
  } catch {
    return escHtml(text || '');
  }
}

function cleanPath(p) { return p.replace(/[`'".,;:!?)}\]]+$/, ''); }

function clickablePath(fp) {
  if (!fp) return '';
  return `<span class="chat-link chat-link-path" data-path="${escHtml(fp)}" title="Click to copy, Ctrl+Click to open">${escHtml(fp)}</span>`;
}

// HTML-aware linkification (for markdown output)
function linkify(html) {
  return html.replace(/(<a[\s>][\s\S]*?<\/a>)|(<code[\s>][\s\S]*?<\/code>)|(<[^>]*>)|([^<]+)/gi, (match, anchor, code, tag, text) => {
    if (anchor) return match;
    if (code) {
      return code.replace(/^(<code[^>]*>)([\s\S]*?)(<\/code>)$/i, (_, open, inner, close) => {
        let r = inner.replace(/(https?:\/\/[^\s<>"')\]]+)/g, (raw) => {
          const url = cleanPath(raw);
          const after = raw.slice(url.length);
          return `<span class="chat-link" data-href="${escHtml(url)}" title="Click to copy, Ctrl+Click to open">${escHtml(url)}</span>${escHtml(after)}`;
        });
        r = r.replace(/(<[^>]*>)|([^<]+)/g, (m2, t2, txt) => {
          if (t2 || !txt) return m2;
          return txt.replace(/(?<![="'\w/])((?:~|\.\.?)?\/[^\0<>?\s!`&*()'":;\\][^\0<>?\s!`&*()'"\\:;]*(?:\/[^\0<>?\s!`&*()'"\\:;]+)+(?::\d+(?::\d+)?)?)/g, (raw) => {
            const fp = cleanPath(raw);
            const after = raw.slice(fp.length);
            if (fp.length < 4) return raw;
            return `<span class="chat-link chat-link-path" data-path="${escHtml(fp)}" title="Click to copy, Ctrl+Click to open">${escHtml(fp)}</span>${escHtml(after)}`;
          });
        });
        return open + r + close;
      });
    }
    if (tag) return tag;
    if (!text) return match;
    let result = text.replace(/(https?:\/\/[^\s<>"')\]]+)/g, (raw) => {
      const url = cleanPath(raw);
      const after = raw.slice(url.length);
      return `<span class="chat-link" data-href="${escHtml(url)}" title="Click to copy, Ctrl+Click to open">${escHtml(url)}</span>${escHtml(after)}`;
    });
    result = result.replace(/(?<![="'\w/])((?:~|\.\.?)?\/[^\0<>?\s!`&*()'":;\\][^\0<>?\s!`&*()'"\\:;]*(?:\/[^\0<>?\s!`&*()'"\\:;]+)+(?::\d+(?::\d+)?)?)/g, (raw) => {
      const fp = cleanPath(raw);
      const after = raw.slice(fp.length);
      if (fp.length < 4) return raw;
      return `<span class="chat-link chat-link-path" data-path="${escHtml(fp)}" title="Click to copy, Ctrl+Click to open">${escHtml(fp)}</span>${escHtml(after)}`;
    });
    return result;
  });
}

// Plain-text linkification (for tool output)
function linkifyText(text) {
  let html = escHtml(text);
  html = html.replace(/(https?:\/\/[^\s<>&]+)/g, (raw) => {
    const url = cleanPath(raw);
    const after = raw.slice(url.length);
    return `<span class="chat-link" data-href="${url}" title="Click to copy, Ctrl+Click to open">${url}</span>${after}`;
  });
  html = html.replace(/(<[^>]*>)|([^<]+)/g, (match, tag, text2) => {
    if (tag) return tag;
    if (!text2) return match;
    return text2.replace(/(?<![="'\w/])((?:~|\.\.?)?\/[^\0<>?\s!`&*()'":;\\][^\0<>?\s!`&*()'"\\:;]*(?:\/[^\0<>?\s!`&*()'"\\:;]+)+(?::\d+(?::\d+)?)?)/g, (raw) => {
      const fp = cleanPath(raw);
      const after = raw.slice(fp.length);
      if (fp.length < 4) return raw;
      return `<span class="chat-link chat-link-path" data-path="${fp}" title="Click to copy, Ctrl+Click to open">${fp}</span>${after}`;
    });
  });
  return html;
}

// Syntax-highlighted code block with line numbers
function renderCodeBlock(code, filePath) {
  const lang = detectHljsLang(filePath);
  let highlighted;
  try {
    highlighted = lang ? hljs.highlight(code, { language: lang }).value : escHtml(code);
  } catch { highlighted = escHtml(code); }
  const lines = highlighted.split('\n');
  const gutterW = String(lines.length).length;
  let body = '';
  for (let i = 0; i < lines.length; i++) {
    body += `<div class="chat-code-line"><span class="chat-code-ln" style="width:${gutterW + 1}ch">${i + 1}</span><span class="chat-code-text">${lines[i] || ' '}</span></div>`;
  }
  const langLabel = lang || 'plain';
  return `<div class="chat-code-block" data-lang="${escHtml(langLabel)}" data-filepath="${escHtml(filePath)}">${body}</div>`;
}

// Edit diff view
function renderEditDiff(oldStr, newStr, filePath) {
  const oldLines = (oldStr || '').split('\n');
  const newLines = (newStr || '').split('\n');
  const diffLines = [];
  let oi = 0, ni = 0;
  while (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
    diffLines.push({ type: 'ctx', text: oldLines[oi] }); oi++; ni++;
  }
  let suffixCtx = [];
  let oe = oldLines.length - 1, ne = newLines.length - 1;
  while (oe >= oi && ne >= ni && oldLines[oe] === newLines[ne]) {
    suffixCtx.unshift({ type: 'ctx', text: oldLines[oe] }); oe--; ne--;
  }
  while (oi <= oe) { diffLines.push({ type: 'del', text: oldLines[oi] }); oi++; }
  while (ni <= ne) { diffLines.push({ type: 'add', text: newLines[ni] }); ni++; }
  for (const s of suffixCtx) diffLines.push(s);

  const addCount = diffLines.filter(l => l.type === 'add').length;
  const delCount = diffLines.filter(l => l.type === 'del').length;
  const summary = `\u2713 Added ${addCount} lines, removed ${delCount} lines`;

  let body = '';
  for (const line of diffLines) {
    const cls = line.type === 'add' ? 'chat-diff-add' : line.type === 'del' ? 'chat-diff-del' : 'chat-diff-ctx';
    const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
    body += `<div class="${cls}"><span class="chat-diff-prefix">${prefix}</span><span class="chat-diff-text">${escHtml(line.text)}</span></div>`;
  }

  return `<div class="chat-tool-use"><span class="chat-tool-label">\u{1F4DD} Update ${clickablePath(filePath)}</span><details class="chat-diff"><summary class="chat-diff-summary">${summary}</summary><div class="chat-diff-body">${body}</div></details></div>`;
}

// ── NormalizedMessage → HTML rendering ──

/**
 * Render a single NormalizedMessage to an HTML string.
 * Returns the inner HTML for the message element.
 */
function renderNormalizedMessage(msg) {
  switch (msg.role) {
    case 'user': return renderUserMessage(msg);
    case 'assistant': return renderAssistantMessage(msg);
    case 'tool': return renderToolMessage(msg);
    case 'system': return renderSystemMessage(msg);
    default: return `<pre>${escHtml(JSON.stringify(msg, null, 2))}</pre>`;
  }
}

function renderUserMessage(msg) {
  const parts = msg.content.map(b => {
    if (b.type === 'text') return `<div class="chat-text">${renderMarkdown(b.text)}</div>`;
    if (b.type === 'image') return `<img class="chat-img" src="data:${b.mediaType};base64,${b.data}" alt="image">`;
    return '';
  }).join('');
  return `<div class="chat-bubble chat-bubble-user">${parts}</div>`;
}

function renderAssistantMessage(msg) {
  const parts = msg.content.map(b => {
    if (b.type === 'text') return `<div class="chat-text">${renderMarkdown(stripAnsi(b.text))}</div>`;
    if (b.type === 'thinking') return `<details class="chat-thinking"><summary>Thinking...</summary><pre>${escHtml(stripAnsi(b.text))}</pre></details>`;
    return '';
  }).join('');
  return `<div class="chat-bubble chat-bubble-assistant">${parts}</div>`;
}

function renderToolMessage(msg) {
  const block = msg.content[0];
  if (!block) return '';

  if (block.type === 'tool_call') {
    // Pending tool call (no result yet)
    const isAgent = block.toolName === 'Agent';
    const icon = isAgent ? '\uD83E\uDD16' : '\uD83D\uDD27';
    const label = isAgent && block.input?.description
      ? `${icon} Agent: ${escHtml(block.input.description)}`
      : `${icon} ${escHtml(block.toolName)}`;
    const inputStr = stripAnsi(typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2));
    let html = `<div class="chat-tool-use"><span class="chat-tool-label">${label}</span>`;
    html += `<details class="chat-diff"><summary class="chat-diff-summary">Input</summary><pre>${linkifyText(inputStr)}</pre></details>`;
    html += `<div class="chat-tool-output-pending"><span class="chat-spinner"></span> running...</div>`;
    html += `</div>`;
    return html;
  }

  if (block.type === 'tool_result') {
    const fp = block.input?.file_path || '';
    const resultText = stripAnsi(block.output || '');
    const isError = block.status === 'error';

    // Edit tool: show diff
    if (!isError && block.toolName === 'Edit' && block.input?.old_string != null) {
      return renderEditDiff(block.input.old_string, block.input.new_string, fp);
    }
    // Write tool: show code block
    if (!isError && block.toolName === 'Write') {
      const content = block.input?.content || '';
      const lineCount = content.split('\n').length;
      const byteCount = new Blob([content]).size;
      const sizeStr = byteCount > 1024 ? (byteCount / 1024).toFixed(1) + ' KB' : byteCount + ' B';
      const codeBlock = renderCodeBlock(content, fp);
      return `<div class="chat-tool-use"><span class="chat-tool-label">\u{1F4DD} Write ${clickablePath(fp)}</span><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${lineCount} lines, ${sizeStr}</summary>${codeBlock}</details></div>`;
    }
    // Read tool: show code block
    if (!isError && block.toolName === 'Read') {
      const lineCount = resultText.split('\n').length;
      const codeBlock = renderCodeBlock(resultText, fp);
      return `<div class="chat-tool-use"><span class="chat-tool-label">\u{1F4D6} Read ${clickablePath(fp)}</span><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${lineCount} lines</summary>${codeBlock}</details></div>`;
    }
    // Error
    if (isError) {
      const inputStr = stripAnsi(typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2));
      return `<div class="chat-tool-use"><span class="chat-tool-label">\uD83D\uDD27 ${escHtml(block.toolName)} ${clickablePath(fp)}</span><details class="chat-diff"><summary class="chat-diff-summary">Input</summary><pre>${linkifyText(inputStr)}</pre></details><details class="chat-diff" open><summary class="chat-diff-summary chat-tool-error-label">\u2717 Error</summary><pre class="chat-tool-error-text">${linkifyText(resultText)}</pre></details></div>`;
    }
    // Agent tool
    if (block.toolName === 'Agent') {
      const desc = block.input?.description || '';
      const firstLine = resultText.split('\n')[0].substring(0, 120) || '(empty)';
      const inputStr = stripAnsi(typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2));
      return `<div class="chat-tool-use"><span class="chat-tool-label">\uD83E\uDD16 Agent: ${escHtml(desc)}</span><details class="chat-diff"><summary class="chat-diff-summary">Input</summary><pre>${linkifyText(inputStr)}</pre></details><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${escHtml(firstLine)}</summary><pre>${linkifyText(resultText)}</pre></details></div>`;
    }
    // Generic tool
    const inputStr = stripAnsi(typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2));
    const firstLine = resultText.split('\n')[0].substring(0, 120) || '(empty)';
    return `<div class="chat-tool-use"><span class="chat-tool-label">\uD83D\uDD27 ${escHtml(block.toolName)}</span><details class="chat-diff"><summary class="chat-diff-summary">Input</summary><pre>${linkifyText(inputStr)}</pre></details><details class="chat-diff"><summary class="chat-diff-summary">\u2713 ${escHtml(firstLine)}</summary><pre>${linkifyText(resultText)}</pre></details></div>`;
  }

  return `<pre>${escHtml(JSON.stringify(block, null, 2))}</pre>`;
}

function renderSystemMessage(msg) {
  const text = msg.content[0]?.text || '';
  if (msg.status === 'error' || msg.status === 'interrupted') {
    const label = msg.status === 'interrupted' ? 'Interrupted' : 'Error';
    return `<div class="chat-result-error"><strong>${label}</strong>: ${escHtml(text)}</div>`;
  }
  return `<div class="chat-system-msg">${escHtml(text)}</div>`;
}

// ── Permission rendering ──

function renderPermission(permission) {
  if (!permission) return '';
  if (permission.resolved) {
    const icon = permission.resolved === 'denied' ? '\u2717' : '\u2713';
    const label = permission.resolved === 'denied' ? 'Denied' : 'Allowed';
    return `<div class="chat-perm-resolved chat-perm-${permission.resolved}">${icon} ${label}</div>`;
  }
  return `<div class="chat-perm-pending" data-request-id="${escHtml(permission.requestId)}">
    <div class="chat-perm-label">Permission required: ${escHtml(permission.toolName)}</div>
    <button class="chat-perm-btn chat-perm-allow" data-action="allow">Allow</button>
    <button class="chat-perm-btn chat-perm-always" data-action="always">Always Allow</button>
    <button class="chat-perm-btn chat-perm-deny" data-action="deny">Deny</button>
  </div>`;
}

export {
  renderMarkdown, renderCodeBlock, renderEditDiff, renderNormalizedMessage, renderPermission,
  linkify, linkifyText, clickablePath, stripAnsi, cleanPath, detectHljsLang, hljs,
};
