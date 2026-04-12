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
import { indentWithTab } from '@codemirror/commands';
import { marked } from 'marked';

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
  return { wordWrap: false, fontSize: 14, theme: 'dark' };
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

    // Editor toolbar (top row: file path, lang selector, save, download)
    const toolbar = document.createElement('div'); toolbar.className = 'editor-toolbar';
    const pathSpan = document.createElement('span'); pathSpan.className = 'file-path'; pathSpan.textContent = filePath;
    this.saveIndicator = document.createElement('span'); this.saveIndicator.className = 'save-indicator';

    // Language selector
    this.langSelect = document.createElement('select');
    this.langSelect.className = 'toolbar-select'; this.langSelect.style.fontSize = '10px';
    for (const lang of LANGUAGES) {
      const opt = document.createElement('option'); opt.value = lang.id; opt.textContent = lang.label;
      this.langSelect.appendChild(opt);
    }
    this.langSelect.onchange = () => this._changeLang(this.langSelect.value);

    const btnSave = this._btn('Save'); btnSave.onclick = () => this.save();
    if (this._isReadOnly) btnSave.style.display = 'none';
    const btnDownload = this._btn('Download'); btnDownload.onclick = () => window.open(`/api/download?path=${encodeURIComponent(filePath)}`);

    // Settings buttons (word wrap, font size, theme)
    const sep = document.createElement('span'); sep.className = 'editor-toolbar-sep';

    // Word wrap toggle
    const btnWrap = this._btn(this._settings.wordWrap ? 'Wrap: On' : 'Wrap: Off');
    btnWrap.className = 'file-tool-btn editor-setting-btn';
    if (this._settings.wordWrap) btnWrap.classList.add('active');
    btnWrap.onclick = () => {
      this._settings.wordWrap = !this._settings.wordWrap;
      btnWrap.textContent = this._settings.wordWrap ? 'Wrap: On' : 'Wrap: Off';
      btnWrap.classList.toggle('active', this._settings.wordWrap);
      this._applyWrap();
      saveEditorSettings(this._settings);
    };

    // Font size controls
    const sizeDown = this._btn('A-'); sizeDown.className = 'file-tool-btn editor-setting-btn';
    this.fontSizeDisplay = document.createElement('span');
    this.fontSizeDisplay.className = 'editor-font-size-display';
    this.fontSizeDisplay.textContent = this._settings.fontSize + 'px';
    const sizeUp = this._btn('A+'); sizeUp.className = 'file-tool-btn editor-setting-btn';
    sizeDown.onclick = () => { this._changeFontSize(-1); };
    sizeUp.onclick = () => { this._changeFontSize(1); };

    // Theme toggle
    const btnTheme = this._btn(this._settings.theme === 'dark' ? 'Dark' : 'Light');
    btnTheme.className = 'file-tool-btn editor-setting-btn';
    btnTheme.onclick = () => {
      this._settings.theme = this._settings.theme === 'dark' ? 'light' : 'dark';
      btnTheme.textContent = this._settings.theme === 'dark' ? 'Dark' : 'Light';
      this._applyTheme();
      saveEditorSettings(this._settings);
    };

    // Markdown preview toggle
    this._btnPreview = this._btn('Preview');
    this._btnPreview.className = 'file-tool-btn editor-setting-btn';
    this._btnPreview.style.display = 'none'; // shown for markdown and html
    this._previewing = false;
    this._previewType = null; // 'markdown' or 'html'
    this._btnPreview.onclick = () => {
      this._previewing = !this._previewing;
      this._btnPreview.textContent = this._previewing ? 'Edit' : 'Preview';
      this._btnPreview.classList.toggle('active', this._previewing);
      if (this._previewing) {
        this.editorBody.style.display = 'none';
        const src = this.editorView?.state.doc.toString() || '';
        if (this._previewType === 'html') {
          // HTML preview: render in sandboxed iframe
          if (!this._previewIframe) {
            this._previewIframe = document.createElement('iframe');
            this._previewIframe.className = 'html-preview';
            this._previewIframe.sandbox = 'allow-scripts';
            this._previewIframe.style.cssText = 'width:100%;height:100%;border:none';
            this._previewBody.appendChild(this._previewIframe);
          }
          this._previewIframe.srcdoc = src;
          this._previewBody.style.display = 'block';
        } else {
          this._previewBody.innerHTML = marked.parse(src);
          this._previewBody.style.display = 'block';
        }
      } else {
        this._previewBody.style.display = 'none';
        this.editorBody.style.display = '';
      }
    };

    toolbar.append(pathSpan, this.saveIndicator, this.langSelect, btnSave, btnDownload, sep, btnWrap, sizeDown, this.fontSizeDisplay, sizeUp, btnTheme, this._btnPreview);

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
  }

  _btn(text) {
    const b = document.createElement('button'); b.className = 'file-tool-btn'; b.textContent = text;
    b.style.width = 'auto'; b.style.padding = '2px 8px'; b.style.fontSize = '11px'; return b;
  }

  _getThemeExtension() {
    return this._settings.theme === 'dark' ? oneDark : editorLightTheme;
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
          keymap.of([indentWithTab, { key: 'Mod-s', run: () => { self.save(); return true; } }]),
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
}

export { CodeEditor, detectLang, getLangExtension, loadEditorSettings, saveEditorSettings, editorLightTheme };
