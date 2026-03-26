import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { marked } from 'marked';
import { Resizer } from './resizer.js';

class MarkdownViewer {
  constructor(winInfo, filePath, app) {
    this.winInfo = winInfo;
    this.filePath = filePath;
    this.app = app;
    this.mode = 'preview'; // 'preview' | 'edit' | 'split'
    this.content = '';
    this.editorView = null;
    this._resizer = null;
    this._previewUpdateTimer = null;

    const container = document.createElement('div'); container.className = 'md-container';

    // Toolbar with mode buttons
    const toolbar = document.createElement('div'); toolbar.className = 'md-toolbar';
    const pathSpan = document.createElement('span'); pathSpan.className = 'file-path'; pathSpan.textContent = filePath;
    this.saveIndicator = document.createElement('span'); this.saveIndicator.className = 'save-indicator';

    this.modeButtons = {};
    const modes = [['preview', 'Preview'], ['edit', 'Edit'], ['split', 'Split']];
    const modeGroup = document.createElement('div'); modeGroup.className = 'md-mode-group';
    for (const [id, label] of modes) {
      const btn = document.createElement('button');
      btn.className = 'md-mode-btn'; btn.textContent = label; btn.dataset.mode = id;
      btn.onclick = () => this.setMode(id);
      modeGroup.appendChild(btn);
      this.modeButtons[id] = btn;
    }

    const btnSave = document.createElement('button'); btnSave.className = 'file-tool-btn';
    btnSave.style.cssText = 'width:auto;padding:2px 8px;font-size:11px'; btnSave.textContent = 'Save';
    btnSave.onclick = () => this.save();

    this._wordWrap = localStorage.getItem('mdWordWrap') !== 'false';
    this._wrapCompartment = new Compartment();
    const btnWrap = document.createElement('button'); btnWrap.className = 'file-tool-btn';
    btnWrap.style.cssText = 'width:auto;padding:2px 8px;font-size:10px';
    btnWrap.textContent = this._wordWrap ? 'Wrap: On' : 'Wrap: Off';
    btnWrap.onclick = () => {
      this._wordWrap = !this._wordWrap;
      localStorage.setItem('mdWordWrap', this._wordWrap);
      btnWrap.textContent = this._wordWrap ? 'Wrap: On' : 'Wrap: Off';
      if (this.editorView) {
        this.editorView.dispatch({ effects: this._wrapCompartment.reconfigure(this._wordWrap ? EditorView.lineWrapping : []) });
      }
    };

    toolbar.append(pathSpan, this.saveIndicator, modeGroup, btnWrap, btnSave);

    // Content area
    this.contentArea = document.createElement('div'); this.contentArea.className = 'md-content';

    // Preview pane
    this.previewEl = document.createElement('div'); this.previewEl.className = 'markdown-preview';

    // Editor pane
    this.editorEl = document.createElement('div'); this.editorEl.className = 'md-editor-pane';

    container.append(toolbar, this.contentArea);
    winInfo.content.appendChild(container);

    this._loadFile();
  }

  async _loadFile() {
    try {
      const res = await fetch(`/api/file/content?path=${encodeURIComponent(this.filePath)}`);
      const data = await res.json();
      this.content = data.content || '';
    } catch { this.content = ''; }
    this.setMode(this.mode);
  }

  setMode(mode) {
    this.mode = mode;
    for (const [id, btn] of Object.entries(this.modeButtons)) {
      btn.classList.toggle('active', id === mode);
    }

    // Clean up previous state
    if (this._resizer) { this._resizer.destroy(); this._resizer = null; }
    this.contentArea.innerHTML = '';
    this.contentArea.className = 'md-content md-mode-' + mode;

    if (mode === 'preview') {
      this.previewEl.innerHTML = marked.parse(this.content);
      this.contentArea.appendChild(this.previewEl);
    } else if (mode === 'edit') {
      this._syncContentFromEditor();
      this._createEditor(this.contentArea);
    } else if (mode === 'split') {
      this._syncContentFromEditor();

      const editorPane = document.createElement('div'); editorPane.className = 'md-split-editor';
      const previewPane = document.createElement('div'); previewPane.className = 'md-split-preview';

      this.contentArea.appendChild(editorPane);
      this.contentArea.appendChild(previewPane);

      this._createEditor(editorPane);
      this.previewEl.innerHTML = marked.parse(this.content);
      previewPane.appendChild(this.previewEl);

      // Resizer between editor and preview
      this._resizer = new Resizer(editorPane, 'horizontal', { min: 200, max: 1200, initial: Math.floor(this.contentArea.offsetWidth / 2) });

      // Sync scroll (approximate: ratio-based)
      if (this.editorView) {
        const editorScroller = editorPane.querySelector('.cm-scroller');
        if (editorScroller) {
          editorScroller.addEventListener('scroll', () => {
            const ratio = editorScroller.scrollTop / (editorScroller.scrollHeight - editorScroller.clientHeight || 1);
            this.previewEl.scrollTop = ratio * (this.previewEl.scrollHeight - this.previewEl.clientHeight);
          });
        }
      }
    }
  }

  _syncContentFromEditor() {
    if (this.editorView) {
      this.content = this.editorView.state.doc.toString();
      this.editorView.destroy();
      this.editorView = null;
    }
  }

  _createEditor(parent) {
    const self = this;
    this.editorView = new EditorView({
      state: EditorState.create({
        doc: this.content,
        extensions: [
          basicSetup, oneDark, markdown(),
          self._wrapCompartment.of(self._wordWrap ? EditorView.lineWrapping : []),
          keymap.of([{ key: 'Mod-s', run: () => { self.save(); return true; } }]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              self.saveIndicator.textContent = '● Modified'; self.saveIndicator.style.color = 'var(--yellow)';
              // Debounced preview update for split mode
              if (self.mode === 'split') {
                clearTimeout(self._previewUpdateTimer);
                self._previewUpdateTimer = setTimeout(() => {
                  self.previewEl.innerHTML = marked.parse(self.editorView.state.doc.toString());
                }, 300);
              }
            }
          }),
        ],
      }),
      parent,
    });
  }

  async save() {
    this._syncContentFromEditor();
    try {
      await fetch('/api/file/write', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: this.filePath, content: this.content }) });
      this.saveIndicator.textContent = '✓ Saved'; this.saveIndicator.style.color = 'var(--green)';
      setTimeout(() => { this.saveIndicator.textContent = ''; }, 2000);
    } catch { this.saveIndicator.textContent = '✕ Error'; this.saveIndicator.style.color = 'var(--red)'; }
    // Restore editor state after sync
    if (this.mode === 'edit' || this.mode === 'split') {
      this.setMode(this.mode);
    }
  }
}

export { MarkdownViewer };
