import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json as jsonLang } from '@codemirror/lang-json';
import { markdown as mdLang } from '@codemirror/lang-markdown';
import { html as htmlLang } from '@codemirror/lang-html';
import { css as cssLang } from '@codemirror/lang-css';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';

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
    this.modified = false;

    const container = document.createElement('div'); container.className = 'editor-container';

    // Editor toolbar
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
    const btnDownload = this._btn('Download'); btnDownload.onclick = () => window.open(`/api/download?path=${encodeURIComponent(filePath)}`);
    toolbar.append(pathSpan, this.saveIndicator, this.langSelect, btnSave, btnDownload);

    this.editorBody = document.createElement('div'); this.editorBody.className = 'editor-body';
    container.append(toolbar, this.editorBody);
    winInfo.content.appendChild(container);

    this._langCompartment = new Compartment();
    this.editorView = null;
    this._loadFile(opts.content);
  }

  _btn(text) {
    const b = document.createElement('button'); b.className = 'file-tool-btn'; b.textContent = text;
    b.style.width = 'auto'; b.style.padding = '2px 8px'; b.style.fontSize = '11px'; return b;
  }

  async _loadFile(initialContent) {
    let content = initialContent;
    if (content === undefined) {
      try {
        const res = await fetch(`/api/file/content?path=${encodeURIComponent(this.filePath)}`);
        const data = await res.json(); content = data.content || '';
      } catch { content = ''; }
    }

    const detectedLang = detectLang(this.filePath);
    this.langSelect.value = detectedLang === 'plain' ? 'auto' : detectedLang;

    const self = this;
    this.editorView = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          oneDark,
          this._langCompartment.of(getLangExtension(detectedLang)),
          keymap.of([{ key: 'Mod-s', run: () => { self.save(); return true; } }]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) { self.modified = true; self.saveIndicator.textContent = '● Modified'; self.saveIndicator.style.color = 'var(--yellow)'; }
          }),
        ],
      }),
      parent: this.editorBody,
    });

    this.winInfo.onClose = () => {
      if (this.onSaveAndClose) { this.save().then(() => this.onSaveAndClose()); }
    };
  }

  _changeLang(langId) {
    if (!this.editorView) return;
    const actualId = langId === 'auto' ? detectLang(this.filePath) : langId;
    this.editorView.dispatch({ effects: this._langCompartment.reconfigure(getLangExtension(actualId)) });
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

export { CodeEditor, detectLang, getLangExtension };
