import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json as jsonLang } from '@codemirror/lang-json';
import { markdown as mdLang } from '@codemirror/lang-markdown';
import { html as htmlLang } from '@codemirror/lang-html';
import { css as cssLang } from '@codemirror/lang-css';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorState, Compartment, EditorSelection } from '@codemirror/state';
import { keymap } from '@codemirror/view';
let _mermaid = null; // lazy-loaded from CDN
import { indentWithTab } from '@codemirror/commands';
import { marked } from 'marked';
import * as prettier from 'prettier/standalone';
import prettierBabel from 'prettier/plugins/babel';
import prettierEstree from 'prettier/plugins/estree';
import prettierHtml from 'prettier/plugins/html';
import prettierCss from 'prettier/plugins/postcss';
import prettierMarkdown from 'prettier/plugins/markdown';
import prettierTypescript from 'prettier/plugins/typescript';
import prettierYaml from 'prettier/plugins/yaml';
import prettierGraphql from 'prettier/plugins/graphql';

const PRETTIER_PLUGINS = [prettierBabel, prettierEstree, prettierHtml, prettierCss, prettierMarkdown, prettierTypescript, prettierYaml, prettierGraphql];

// Map language id → prettier parser name (null = not supported client-side)
const PRETTIER_PARSERS = {
  javascript: 'babel', json: 'json', html: 'html', css: 'css',
  markdown: 'markdown', plain: null, python: null, auto: null,
};

// Languages that can be formatted server-side via CLI tools (ruff/black, shfmt, gofmt, rustfmt)
const SERVER_FORMATTERS = { python: 'python', shell: 'shell', go: 'go', rust: 'rust' };
// File extensions that map to server-side formatter languages
const EXT_TO_SERVER_FMT = { py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', go: 'go', rs: 'rust' };

// Map file extension → prettier parser (for extensions not covered by language id)
const EXT_TO_PARSER = {
  ts: 'typescript', tsx: 'typescript', jsx: 'babel',
  scss: 'scss', less: 'less', yaml: 'yaml', yml: 'yaml',
  graphql: 'graphql', gql: 'graphql', vue: 'vue', svelte: 'html',
};

const LANGUAGES = [
  { id: 'auto', label: 'Auto' },
  { id: 'javascript', label: 'JavaScript', ext: ['js','jsx','ts','tsx','mjs','cjs'] },
  { id: 'python', label: 'Python', ext: ['py'] },
  { id: 'json', label: 'JSON', ext: ['json'] },
  { id: 'markdown', label: 'Markdown', ext: ['md'] },
  { id: 'html', label: 'HTML', ext: ['html','htm','vue','svelte'] },
  { id: 'css', label: 'CSS', ext: ['css','scss','less'] },
  { id: 'plain', label: 'Plain Text', ext: ['txt','log'] },
];

// Light theme for CodeMirror (used when editor theme is 'light')
const editorLightTheme = EditorView.theme({
  '&': { backgroundColor: '#ffffff', color: '#1e293b' },
  '.cm-content': { caretColor: '#6366f1' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#6366f1' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#d7d4f0' },
  '.cm-panels': { backgroundColor: '#f5f5fa', color: '#1e293b' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid #e0e0e8' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid #e0e0e8' },
  '.cm-searchMatch': { backgroundColor: '#fde68a', outline: '1px solid #fbbf24' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#bbf7d0' },
  '.cm-activeLine': { backgroundColor: '#f1f5f9' },
  '.cm-selectionMatch': { backgroundColor: '#c8e6c9' },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: '#e0e7ff' },
  '.cm-gutters': { backgroundColor: '#f8fafc', color: '#94a3b8', borderRight: '1px solid #e2e8f0' },
  '.cm-activeLineGutter': { backgroundColor: '#e2e8f0' },
  '.cm-foldPlaceholder': { backgroundColor: 'transparent', border: 'none', color: '#6366f1' },
  '.cm-tooltip': { border: '1px solid #e2e8f0', backgroundColor: '#f5f5fa' },
  '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'transparent', borderBottomColor: 'transparent' },
  '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: '#f5f5fa', borderBottomColor: '#f5f5fa' },
  '.cm-tooltip-autocomplete': { '& > ul > li[aria-selected]': { backgroundColor: '#d7d4f0', color: '#1e293b' } },
}, { dark: false });

// Editor settings persistence
function loadEditorSettings() {
  try {
    const raw = localStorage.getItem('editorSettings');
    if (raw) return JSON.parse(raw);
  } catch {}
  return { wordWrap: false, fontSize: 14 };
}

function saveEditorSettings(settings) {
  localStorage.setItem('editorSettings', JSON.stringify(settings));
}

function getLangExtension(langId) {
  const map = { javascript: javascript(), python: python(), json: jsonLang(), markdown: mdLang(), html: htmlLang(), css: cssLang() };
  return map[langId] ? [map[langId]] : [];
}

function detectLang(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  for (const lang of LANGUAGES) {
    if (lang.ext?.includes(ext)) return lang.id;
  }
  return 'plain';
}

class CodeEditor {
  constructor(winInfo, filePath, fileName, app, opts = {}) {
    this.winInfo = winInfo; this.filePath = filePath; this.app = app;
    this.onSaveAndClose = opts.onSaveAndClose || null;
    this._gotoLine = opts.line || null;
    this._isReadOnly = opts._tempFile || false;
    this.modified = false;
    this._settings = loadEditorSettings();

    const container = document.createElement('div'); container.className = 'editor-container';

    // Editor toolbar — left: save indicator, right: controls
    const toolbar = document.createElement('div'); toolbar.className = 'editor-toolbar';

    const toolbarLeft = document.createElement('div'); toolbarLeft.className = 'editor-toolbar-left';
    this.saveIndicator = document.createElement('span'); this.saveIndicator.className = 'save-indicator';
    toolbarLeft.append(this.saveIndicator);

    const toolbarRight = document.createElement('div'); toolbarRight.className = 'editor-toolbar-right';

    // Language selector
    this.langSelect = document.createElement('select');
    this.langSelect.className = 'toolbar-select';
    for (const lang of LANGUAGES) {
      const opt = document.createElement('option'); opt.value = lang.id; opt.textContent = lang.label;
      this.langSelect.appendChild(opt);
    }
    this.langSelect.onchange = () => this._changeLang(this.langSelect.value);

    // Preview toggle (markdown/html)
    this._btnPreview = this._btn('Preview');
    this._btnPreview.style.display = 'none';
    this._previewing = false;
    this._previewType = null;
    this._btnPreview.onclick = () => {
      this._previewing = !this._previewing;
      this._btnPreview.textContent = this._previewing ? 'Edit' : 'Preview';
      this._btnPreview.classList.toggle('active', this._previewing);
      if (this._previewing) {
        this.editorBody.style.display = 'none';
        const src = this.editorView?.state.doc.toString() || '';
        if (this._previewType === 'html') {
          if (!this._previewIframe) {
            this._previewIframe = document.createElement('iframe');
            this._previewIframe.sandbox = 'allow-scripts';
            this._previewIframe.style.cssText = 'width:100%;height:100%;border:none';
            this._previewBody.appendChild(this._previewIframe);
          }
          this._previewIframe.srcdoc = src;
        } else {
          this._previewBody.innerHTML = marked.parse(src);
          // Render mermaid diagrams: convert <code class="language-mermaid"> to mermaid divs
          this._previewBody.querySelectorAll('code.language-mermaid').forEach(code => {
            const pre = code.parentElement;
            const div = document.createElement('div');
            div.className = 'mermaid';
            div.textContent = code.textContent;
            pre.replaceWith(div);
          });
          const mermaidNodes = this._previewBody.querySelectorAll('.mermaid');
          if (mermaidNodes.length) {
            (async () => {
              if (!_mermaid) {
                // Load mermaid from CDN to avoid 3MB bundle increase
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
                await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; document.head.appendChild(script); });
                _mermaid = window.mermaid;
              }
              const isDark = !(document.documentElement.dataset.theme?.includes('light') || document.documentElement.dataset.theme === 'solarized');
              _mermaid.initialize({ startOnLoad: false, theme: isDark ? 'dark' : 'default' });
              _mermaid.run({ nodes: mermaidNodes }).catch(() => {});
            })();
          }
        }
        this._previewBody.style.display = 'block';
      } else {
        this._previewBody.style.display = 'none';
        this.editorBody.style.display = '';
      }
    };

    const sep = () => { const s = document.createElement('span'); s.className = 'editor-toolbar-sep'; return s; };

    // Word wrap toggle
    const btnWrap = this._btn('\u21A9'); btnWrap.title = 'Toggle word wrap';
    if (this._settings.wordWrap) btnWrap.classList.add('active');
    btnWrap.onclick = () => {
      this._settings.wordWrap = !this._settings.wordWrap;
      btnWrap.classList.toggle('active', this._settings.wordWrap);
      this._applyWrap();
      saveEditorSettings(this._settings);
    };

    // Format button
    const btnFormat = this._btn('\u2261'); btnFormat.title = 'Format document (Shift+Alt+F)';
    btnFormat.onclick = () => this.format();

    // Font size
    const sizeDown = this._btn('\u2212'); sizeDown.title = 'Decrease font size';
    this.fontSizeDisplay = document.createElement('span');
    this.fontSizeDisplay.className = 'editor-font-size-display';
    this.fontSizeDisplay.textContent = this._settings.fontSize;
    const sizeUp = this._btn('+'); sizeUp.title = 'Increase font size';
    sizeDown.onclick = () => this._changeFontSize(-1);
    sizeUp.onclick = () => this._changeFontSize(1);

    // Save + download
    const btnSave = this._btn('\u{1F4BE}'); btnSave.title = 'Save (Ctrl+S)';
    btnSave.onclick = () => this.save();
    if (this._isReadOnly) btnSave.style.display = 'none';
    const btnDownload = this._btn('\u21E9'); btnDownload.title = 'Download';
    btnDownload.onclick = () => window.open(`/api/download?path=${encodeURIComponent(filePath)}`);

    if (this._isReadOnly) btnFormat.style.display = 'none';
    toolbarRight.append(this.langSelect, this._btnPreview, sep(), btnWrap, btnFormat, sizeDown, this.fontSizeDisplay, sizeUp, sep(), btnSave, btnDownload);
    toolbar.append(toolbarLeft, toolbarRight);

    this.editorBody = document.createElement('div'); this.editorBody.className = 'editor-body';
    this._previewBody = document.createElement('div'); this._previewBody.className = 'markdown-preview editor-body'; this._previewBody.style.display = 'none'; this._previewBody.style.overflow = 'auto'; this._previewBody.style.padding = '12px 16px';
    container.append(toolbar, this.editorBody, this._previewBody);
    winInfo.content.appendChild(container);

    this._langCompartment = new Compartment();
    this._wrapCompartment = new Compartment();
    this._themeCompartment = new Compartment();
    this._fontSizeCompartment = new Compartment();
    this.editorView = null;
    this._loadFile(opts.content);

    // Follow global theme changes
    this._themeObserver = new MutationObserver(() => this._applyTheme());
    this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  _btn(text) {
    const b = document.createElement('button'); b.className = 'file-tool-btn'; b.textContent = text;
    b.style.width = 'auto'; b.style.padding = '2px 8px'; b.style.fontSize = '11px'; return b;
  }

  _getThemeExtension() {
    // Follow global app theme — light theme uses light editor, all others use dark
    const globalTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    return globalTheme === 'light' ? editorLightTheme : oneDark;
  }

  _getWrapExtension() {
    return this._settings.wordWrap ? EditorView.lineWrapping : [];
  }

  _getFontSizeExtension() {
    return EditorView.theme({ '.cm-content, .cm-gutters': { fontSize: this._settings.fontSize + 'px' } });
  }

  _applyWrap() {
    if (!this.editorView) return;
    this.editorView.dispatch({ effects: this._wrapCompartment.reconfigure(this._getWrapExtension()) });
  }

  _applyTheme() {
    if (!this.editorView) return;
    this.editorView.dispatch({ effects: this._themeCompartment.reconfigure(this._getThemeExtension()) });
  }

  _applyFontSize() {
    if (!this.editorView) return;
    this.editorView.dispatch({ effects: this._fontSizeCompartment.reconfigure(this._getFontSizeExtension()) });
    this.fontSizeDisplay.textContent = this._settings.fontSize + 'px';
  }

  _changeFontSize(delta) {
    const newSize = Math.max(8, Math.min(32, this._settings.fontSize + delta));
    if (newSize === this._settings.fontSize) return;
    this._settings.fontSize = newSize;
    this._applyFontSize();
    saveEditorSettings(this._settings);
  }

  async _loadFile(initialContent) {
    let content = initialContent;
    if (content === undefined) {
      try {
        const res = await fetch(`/api/file/content?path=${encodeURIComponent(this.filePath)}`);
        const data = await res.json();
        if (data.error) {
          this.editorBody.innerHTML = `<div class="empty-hint" style="color:var(--red);padding:20px">${data.error}</div>`;
          return;
        }
        content = data.content || '';
      } catch (err) {
        this.editorBody.innerHTML = `<div class="empty-hint" style="color:var(--red);padding:20px">Failed to load file: ${err.message}</div>`;
        return;
      }
    }

    const detectedLang = detectLang(this.filePath);
    this.langSelect.value = detectedLang === 'plain' ? 'auto' : detectedLang;

    const self = this;
    this.editorView = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          this._themeCompartment.of(this._getThemeExtension()),
          this._wrapCompartment.of(this._getWrapExtension()),
          this._fontSizeCompartment.of(this._getFontSizeExtension()),
          this._langCompartment.of(getLangExtension(detectedLang)),
          keymap.of([
            indentWithTab,
            { key: 'Mod-s', run: () => { self.save(); return true; } },
            { key: 'Shift-Alt-f', run: () => { self.format(); return true; } },
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) { self.modified = true; self.saveIndicator.textContent = '● Modified'; self.saveIndicator.style.color = 'var(--yellow)'; }
          }),
          ...(this._isReadOnly ? [EditorState.readOnly.of(true)] : []),
        ],
      }),
      parent: this.editorBody,
    });

    this._updatePreviewSupport(detectedLang);

    // Jump to line if requested
    if (this._gotoLine && this.editorView) {
      const line = Math.min(this._gotoLine, this.editorView.state.doc.lines);
      const lineInfo = this.editorView.state.doc.line(line);
      this.editorView.dispatch({
        selection: EditorSelection.cursor(lineInfo.from),
        effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
      });
    }

    this.winInfo.onClose = () => {
      if (this._themeObserver) this._themeObserver.disconnect();
      if (this.onSaveAndClose) { this.save().then(() => this.onSaveAndClose()); }
    };
  }

  _changeLang(langId) {
    if (!this.editorView) return;
    const actualId = langId === 'auto' ? detectLang(this.filePath) : langId;
    this.editorView.dispatch({ effects: this._langCompartment.reconfigure(getLangExtension(actualId)) });
    this._updatePreviewSupport(actualId);
  }

  /** Show/hide Preview button based on current language. Single source of truth. */
  _updatePreviewSupport(langId) {
    const hasPreview = langId === 'markdown' || langId === 'html';
    this._btnPreview.style.display = hasPreview ? '' : 'none';
    this._previewType = hasPreview ? langId : null;
    if (!hasPreview && this._previewing) {
      this._previewing = false;
      this._btnPreview.textContent = 'Preview';
      this._btnPreview.classList.remove('active');
      this._previewBody.style.display = 'none';
      this.editorBody.style.display = '';
    }
  }

  async save() {
    const content = this.editorView.state.doc.toString();
    try {
      await fetch('/api/file/write', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:this.filePath,content}) });
      this.modified = false; this.saveIndicator.textContent = '✓ Saved'; this.saveIndicator.style.color = 'var(--green)';
      setTimeout(() => { if (!this.modified) this.saveIndicator.textContent = ''; }, 2000);
    } catch (err) { this.saveIndicator.textContent = '✕ Error'; this.saveIndicator.style.color = 'var(--red)'; }
  }

  async format() {
    if (!this.editorView || this._isReadOnly) return;
    const currentLang = this.langSelect.value === 'auto' ? detectLang(this.filePath) : this.langSelect.value;
    const ext = this.filePath.split('.').pop().toLowerCase();
    const parser = PRETTIER_PARSERS[currentLang] ?? EXT_TO_PARSER[ext] ?? null;
    const serverLang = SERVER_FORMATTERS[currentLang] ?? EXT_TO_SERVER_FMT[ext] ?? null;

    if (!parser && !serverLang) {
      this._formatStatus('No formatter for this language', 'var(--text-dim)', 2000);
      return;
    }

    const source = this.editorView.state.doc.toString();
    this._formatStatus('Formatting...', 'var(--text-dim)');

    try {
      let formatted;
      if (parser) {
        // Client-side: Prettier
        formatted = await prettier.format(source, {
          parser, plugins: PRETTIER_PLUGINS,
          singleQuote: true, trailingComma: 'all', printWidth: 100,
        });
      } else {
        // Server-side: CLI formatter (ruff/black, shfmt, gofmt, rustfmt)
        const res = await fetch('/api/format', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: source, language: serverLang, filePath: this.filePath }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        formatted = data.formatted;
      }
      if (formatted && formatted !== source) {
        const cursor = this.editorView.state.selection.main.head;
        const ratio = source.length > 0 ? cursor / source.length : 0;
        const newCursor = Math.min(Math.round(ratio * formatted.length), formatted.length);
        this.editorView.dispatch({
          changes: { from: 0, to: source.length, insert: formatted },
          selection: EditorSelection.cursor(newCursor),
        });
      }
      this._formatStatus('\u2713 Formatted', 'var(--green)', 2000);
    } catch (err) {
      this._formatStatus(`Format error: ${err.message?.split('\n')[0]?.substring(0, 80) || 'unknown'}`, 'var(--red)', 4000);
    }
  }

  _formatStatus(text, color, clearAfter) {
    this.saveIndicator.textContent = text;
    this.saveIndicator.style.color = color;
    if (clearAfter) setTimeout(() => { if (this.saveIndicator.textContent === text) this.saveIndicator.textContent = ''; }, clearAfter);
  }
}

export { CodeEditor, detectLang, getLangExtension, loadEditorSettings, saveEditorSettings, editorLightTheme };
