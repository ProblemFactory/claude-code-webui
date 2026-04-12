/**
 * External editor — Ctrl+G split-pane CodeMirror integration.
 * Opens an editor pane below a terminal window for editing files
 * invoked by Claude Code's EDITOR mechanism.
 */

import { CodeEditor, detectLang, getLangExtension, loadEditorSettings, saveEditorSettings, editorLightTheme } from './code-editor.js';
import { Resizer } from './resizer.js';
import { EditorView, basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';

/**
 * Open an external editor split-pane in a terminal window.
 * @param {object} app - App instance (for wm, sessions, _hideWelcome)
 * @param {string} filePath - Path to edit
 * @param {string} signalPath - Signal file for editor completion
 * @param {string} sessionId - WebUI session ID that triggered the editor
 */
export function openExternalEditor(app, filePath, signalPath, sessionId) {
  // Find the terminal window that triggered this — match by webui session ID
  let targetWinInfo = null;
  if (sessionId) {
    for (const [winId, win] of app.wm.windows) {
      const term = app.sessions.get(winId);
      if (term && term.sessionId === sessionId) { targetWinInfo = win; break; }
    }
  }
  // Fallback: active window, then any terminal
  if (!targetWinInfo) {
    for (const [winId, win] of app.wm.windows) {
      if (win.type === 'terminal' && winId === app.wm.activeWindowId) { targetWinInfo = win; break; }
    }
  }
  if (!targetWinInfo) {
    for (const [, win] of app.wm.windows) { if (win.type === 'terminal') { targetWinInfo = win; break; } }
  }

  if (!targetWinInfo) {
    // No terminal window — open standalone editor
    app._hideWelcome();
    const winInfo = app.wm.createWindow({ title: `Editor: ${filePath.split('/').pop()}`, type: 'editor' });
    new CodeEditor(winInfo, filePath, filePath.split('/').pop(), app, {
      onSaveAndClose: async () => {
        try { await fetch('/api/editor/signal', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ signalPath, filePath }) }); } catch {}
      },
    });
    return;
  }

  // Split the terminal window: add an editor pane below the terminal
  const contentEl = targetWinInfo.content;
  const termContainer = contentEl.querySelector('.terminal-container');
  if (!termContainer) return;

  // Create split layout
  contentEl.style.display = 'flex';
  contentEl.style.flexDirection = 'column';
  termContainer.style.flex = '1';
  termContainer.style.minHeight = '100px';

  // Store editor state on winInfo for layout save/restore
  targetWinInfo._editorState = { filePath, signalPath };

  // Create the editor pane
  const editorPane = document.createElement('div');
  editorPane.className = 'editor-container';
  editorPane.style.flex = '1';
  editorPane.style.borderTop = '2px solid var(--accent)';
  editorPane.style.minHeight = '150px';

  // Editor toolbar with settings
  const toolbar = document.createElement('div');
  toolbar.className = 'editor-toolbar';
  toolbar.innerHTML = `<span class="file-path">${filePath}</span>`;

  const edSettings = loadEditorSettings();
  const mkBtn = (text) => { const b = document.createElement('button'); b.className = 'editor-setting-btn'; b.textContent = text; return b; };

  // Wrap toggle
  const btnWrap = mkBtn(edSettings.wordWrap ? 'Wrap: On' : 'Wrap: Off');
  // Font size
  const btnFontDown = mkBtn('A-');
  const fontDisplay = document.createElement('span'); fontDisplay.className = 'editor-font-size-display'; fontDisplay.textContent = edSettings.fontSize;
  const btnFontUp = mkBtn('A+');
  // Theme toggle
  const btnTheme = mkBtn(edSettings.theme === 'dark' ? 'Dark' : 'Light');

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-create';
  saveBtn.style.cssText = 'padding:3px 12px;font-size:11px;';
  saveBtn.textContent = 'Save & Close';

  const sep = document.createElement('span'); sep.className = 'editor-toolbar-sep';
  toolbar.append(sep, btnWrap, btnFontDown, fontDisplay, btnFontUp, btnTheme, saveBtn);

  const editorBody = document.createElement('div');
  editorBody.className = 'editor-body';
  editorPane.append(toolbar, editorBody);
  contentEl.appendChild(editorPane);

  // Draggable divider between terminal and editor (vertical resize)
  targetWinInfo._splitResizer?.destroy();
  const splitResizer = new Resizer(termContainer, 'vertical', {
    min: 80, max: 1000,
    onResize: () => { if (termSession) termSession.fit(); },
  });
  targetWinInfo._splitResizer = splitResizer;

  // Resize terminal to fit the new split
  const termSession = [...app.sessions.values()].find(s => {
    return s.winInfo === targetWinInfo;
  }) || [...app.sessions.values()][0];
  if (termSession) setTimeout(() => termSession.fit(), 100);

  // Load file and create CodeMirror editor
  fetch(`/api/file/content?path=${encodeURIComponent(filePath)}`)
    .then(r => r.json())
    .then(data => {
      const content = data.content || '';
      const langExtensions = getLangExtension(detectLang(filePath));
      const edSettings = loadEditorSettings();

      const themeComp = new Compartment();
      const wrapComp = new Compartment();
      const fontSizeComp = new Compartment();

      const editorView = new EditorView({
        state: EditorState.create({
          doc: content,
          extensions: [
            basicSetup,
            themeComp.of(edSettings.theme === 'dark' ? oneDark : editorLightTheme),
            wrapComp.of(edSettings.wordWrap ? EditorView.lineWrapping : []),
            fontSizeComp.of(EditorView.theme({ '.cm-content, .cm-gutters': { fontSize: edSettings.fontSize + 'px' } })),
            ...langExtensions,
            Prec.highest(keymap.of([
              { key: 'Mod-s', run: () => { doSave(); return true; } },
              { key: 'Mod-g', run: () => { doSave(); return true; } },
            ])),
            keymap.of([indentWithTab]),
          ],
        }),
        parent: editorBody,
      });
      setTimeout(() => editorView.focus(), 50);

      // Wire up editor settings buttons
      btnWrap.onclick = () => {
        edSettings.wordWrap = !edSettings.wordWrap;
        btnWrap.textContent = edSettings.wordWrap ? 'Wrap: On' : 'Wrap: Off';
        editorView.dispatch({ effects: wrapComp.reconfigure(edSettings.wordWrap ? EditorView.lineWrapping : []) });
        saveEditorSettings(edSettings);
      };
      btnFontDown.onclick = () => {
        edSettings.fontSize = Math.max(8, edSettings.fontSize - 1);
        fontDisplay.textContent = edSettings.fontSize;
        editorView.dispatch({ effects: fontSizeComp.reconfigure(EditorView.theme({ '.cm-content, .cm-gutters': { fontSize: edSettings.fontSize + 'px' } })) });
        saveEditorSettings(edSettings);
      };
      btnFontUp.onclick = () => {
        edSettings.fontSize = Math.min(32, edSettings.fontSize + 1);
        fontDisplay.textContent = edSettings.fontSize;
        editorView.dispatch({ effects: fontSizeComp.reconfigure(EditorView.theme({ '.cm-content, .cm-gutters': { fontSize: edSettings.fontSize + 'px' } })) });
        saveEditorSettings(edSettings);
      };
      btnTheme.onclick = () => {
        edSettings.theme = edSettings.theme === 'dark' ? 'light' : 'dark';
        btnTheme.textContent = edSettings.theme === 'dark' ? 'Dark' : 'Light';
        editorView.dispatch({ effects: themeComp.reconfigure(edSettings.theme === 'dark' ? oneDark : editorLightTheme) });
        saveEditorSettings(edSettings);
      };

      const doSave = async () => {
        const newContent = editorView.state.doc.toString();
        try {
          await fetch('/api/file/write', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: filePath, content: newContent }) });
          await fetch('/api/editor/signal', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ signalPath, filePath }) });
        } catch {}
        // Remove editor pane + resizer, restore terminal to full height
        targetWinInfo._editorState = null;
        targetWinInfo._editorDoSave = null;
        editorView.destroy();
        splitResizer.destroy();
        editorPane.remove();
        contentEl.style.display = '';
        contentEl.style.flexDirection = '';
        termContainer.style.flex = '';
        termContainer.style.minHeight = '';
        termContainer.style.height = '';
        termContainer.style.flexBasis = '';
        if (termSession) {
          setTimeout(() => {
            termSession.fit();
            termSession.terminal.scrollToBottom();
            termSession.terminal.focus();
          }, 150);
        }
      };

      saveBtn.onclick = doSave;
      targetWinInfo._editorDoSave = doSave;
    });
}

/**
 * Close an external editor split-pane by signal path.
 * @param {object} app - App instance
 * @param {string} signalPath - Signal file identifying which editor to close
 */
export function closeExternalEditor(app, signalPath) {
  for (const [, win] of app.wm.windows) {
    if (win._editorState?.signalPath === signalPath) {
      const editorPane = win.content.querySelector('.editor-container');
      const termContainer = win.content.querySelector('.terminal-container');
      if (editorPane) {
        editorPane.remove();
        win._editorState = null;
        if (win._splitResizer) { win._splitResizer.destroy(); win._splitResizer = null; }
        if (termContainer) {
          win.content.style.display = '';
          win.content.style.flexDirection = '';
          termContainer.style.flex = '';
          termContainer.style.minHeight = '';
          termContainer.style.height = '';
          termContainer.style.flexBasis = '';
        }
        const termSession = [...app.sessions.values()].find(s => s.winInfo === win);
        if (termSession) {
          setTimeout(() => { termSession.fit(); termSession.terminal.scrollToBottom(); }, 150);
        }
      }
      break;
    }
  }
}
