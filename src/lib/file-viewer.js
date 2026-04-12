import { marked } from 'marked';
import { HexViewer } from './hex-viewer.js';
import { CodeEditor } from './code-editor.js';
import { formatSize } from './utils.js';

const IMAGE_EXTS = ['png','jpg','jpeg','gif','webp','svg','bmp','ico'];
const VIDEO_EXTS = ['mp4','webm','mov','avi'];
const AUDIO_EXTS = ['mp3','wav','ogg','flac','aac','m4a'];

class FileViewer {
  static async open(app, filePath, fileName, opts = {}) {
    const ext = fileName.split('.').pop().toLowerCase();

    // Check file info first (size, binary detection)
    let fileInfo = { size: 0, isBinary: false };
    try {
      const res = await fetch(`/api/file/info?path=${encodeURIComponent(filePath)}`);
      fileInfo = await res.json();
    } catch {}

    const openSpec = { action: 'openFile', path: filePath, name: fileName };

    // Force hex mode
    if (opts.hex) {
      const winInfo = app.wm.createWindow({ title: `Hex: ${fileName}`, type: 'hex-viewer', syncId: opts.syncId, openSpec });
      winInfo._filePath = filePath; winInfo._fileName = fileName;
      new HexViewer(winInfo, filePath, fileInfo);
      return;
    }

    // Media types bypass binary detection — they ARE binary but have dedicated viewers
    const isMedia = IMAGE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext) || AUDIO_EXTS.includes(ext) || ext === 'pdf';

    // Binary file (non-media) → hex viewer
    if (fileInfo.isBinary && !isMedia) {
      const winInfo = app.wm.createWindow({ title: `Hex: ${fileName}`, type: 'hex-viewer', syncId: opts.syncId, openSpec });
      winInfo._filePath = filePath; winInfo._fileName = fileName;
      new HexViewer(winInfo, filePath, fileInfo);
      return;
    }

    // Large file warning (only for text files opened in editor)
    if (!isMedia && fileInfo.size > 1024 * 1024) {
      if (!confirm(`This file is ${formatSize(fileInfo.size)}. Opening may slow down the UI. Continue?`)) return;
    }

    const winInfo = app.wm.createWindow({ title: fileName, type: 'viewer', syncId: opts.syncId, openSpec });
    winInfo._filePath = filePath; winInfo._fileName = fileName;
    const container = document.createElement('div'); container.className = 'file-viewer';
    winInfo.content.appendChild(container);
    winInfo.onClose = () => {};

    try {
      if (IMAGE_EXTS.includes(ext)) {
        FileViewer._renderImage(container, filePath);
      } else if (VIDEO_EXTS.includes(ext)) {
        FileViewer._renderVideo(container, filePath);
      } else if (AUDIO_EXTS.includes(ext)) {
        FileViewer._renderAudio(container, filePath, fileName);
      } else if (ext === 'pdf') {
        FileViewer._renderPdf(container, filePath);
      } else if (ext === 'html' || ext === 'htm') {
        FileViewer._renderHtml(container, filePath, app, fileName, winInfo);
      } else if (['csv','tsv'].includes(ext)) {
        const res = await fetch(`/api/file/content?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();
        const sep = ext === 'tsv' ? '\t' : ',';
        const rows = data.content.split('\n').filter(r=>r.trim()).map(r=>r.split(sep));
        const table = document.createElement('table'); table.className = 'file-viewer-table';
        if (rows.length > 0) {
          const thead = document.createElement('thead'); const hr = document.createElement('tr');
          rows[0].forEach(c => { const th = document.createElement('th'); th.textContent = c.trim(); hr.appendChild(th); });
          thead.appendChild(hr); table.appendChild(thead);
          const tbody = document.createElement('tbody');
          rows.slice(1, 1000).forEach(row => { const tr = document.createElement('tr'); row.forEach(c => { const td = document.createElement('td'); td.textContent = c.trim(); tr.appendChild(td); }); tbody.appendChild(tr); });
          table.appendChild(tbody);
        }
        container.appendChild(table);
      } else if (['xlsx','xls'].includes(ext)) {
        const res = await fetch(`/api/file/excel?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        for (const sheet of data.sheets) {
          const h = document.createElement('h3'); h.textContent = sheet.name; h.style.cssText = 'padding:8px 12px;color:var(--accent-hover);font-size:13px;';
          container.appendChild(h);
          const table = document.createElement('table'); table.className = 'file-viewer-table';
          const tbody = document.createElement('tbody');
          sheet.data.slice(0, 1000).forEach((row, ri) => {
            const tr = document.createElement('tr');
            (row || []).forEach(c => { const td = document.createElement(ri===0?'th':'td'); td.textContent = c ?? ''; tr.appendChild(td); });
            tbody.appendChild(tr);
          });
          table.appendChild(tbody); container.appendChild(table);
        }
      } else if (['docx','doc'].includes(ext)) {
        const res = await fetch(`/api/file/docx?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const div = document.createElement('div'); div.className = 'docx-preview'; div.innerHTML = data.html;
        container.appendChild(div);
      } else {
        // Default: open in code editor
        app.openEditor(filePath, fileName, opts);
        app.wm.closeWindow(winInfo.id);
      }
    } catch (err) {
      container.innerHTML = `<div class="empty-hint" style="color:var(--red);padding:20px">Error: ${err.message}</div>`;
    }
  }

  // ── Image viewer with zoom controls ──
  static _renderImage(container, filePath) {
    const mediaViewer = document.createElement('div');
    mediaViewer.className = 'media-viewer';

    // Toolbar with zoom controls
    const toolbar = document.createElement('div');
    toolbar.className = 'media-toolbar';

    let zoom = 100;
    const zoomLabel = document.createElement('span');
    zoomLabel.className = 'media-zoom-label';
    zoomLabel.textContent = '100%';

    const btnFit = FileViewer._mediaBtn('Fit');
    const btnZoomOut = FileViewer._mediaBtn('-');
    const btnZoomIn = FileViewer._mediaBtn('+');
    const btnActual = FileViewer._mediaBtn('1:1');

    const imgWrap = document.createElement('div');
    imgWrap.className = 'media-content';

    const img = document.createElement('img');
    img.src = `/api/file/raw?path=${encodeURIComponent(filePath)}`;
    img.className = 'media-image';
    img.draggable = false;

    const applyZoom = () => {
      zoomLabel.textContent = zoom + '%';
      img.style.transform = `scale(${zoom / 100})`;
      img.style.transformOrigin = 'center center';
    };

    btnZoomIn.onclick = () => { zoom = Math.min(500, zoom + 25); applyZoom(); };
    btnZoomOut.onclick = () => { zoom = Math.max(10, zoom - 25); applyZoom(); };
    btnActual.onclick = () => { zoom = 100; img.style.maxWidth = 'none'; img.style.maxHeight = 'none'; applyZoom(); };
    btnFit.onclick = () => { zoom = 100; img.style.maxWidth = '100%'; img.style.maxHeight = '100%'; applyZoom(); };

    // Mouse wheel zoom
    imgWrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 25 : -25;
      zoom = Math.max(10, Math.min(500, zoom + delta));
      applyZoom();
    }, { passive: false });

    // Drag to pan
    let panX = 0, panY = 0, dragging = false, startX, startY;
    imgWrap.style.overflow = 'hidden';
    const applyPan = () => { img.style.translate = `${panX}px ${panY}px`; };
    imgWrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true; startX = e.clientX - panX; startY = e.clientY - panY;
      imgWrap.style.cursor = 'grabbing';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panX = e.clientX - startX; panY = e.clientY - startY;
      applyPan();
    });
    document.addEventListener('mouseup', () => { dragging = false; imgWrap.style.cursor = 'grab'; });
    imgWrap.style.cursor = 'grab';

    // Reset pan on fit
    const origFit = btnFit.onclick;
    btnFit.onclick = () => { panX = 0; panY = 0; applyPan(); origFit(); };

    toolbar.append(btnFit, btnZoomOut, zoomLabel, btnZoomIn, btnActual);
    imgWrap.appendChild(img);
    mediaViewer.append(toolbar, imgWrap);
    container.appendChild(mediaViewer);
  }

  // ── Video viewer with native controls ──
  static _renderVideo(container, filePath) {
    const mediaViewer = document.createElement('div');
    mediaViewer.className = 'media-viewer';

    const videoWrap = document.createElement('div');
    videoWrap.className = 'media-content';

    const video = document.createElement('video');
    video.src = `/api/file/raw?path=${encodeURIComponent(filePath)}`;
    video.controls = true;
    video.className = 'media-video';
    video.preload = 'metadata';

    videoWrap.appendChild(video);
    mediaViewer.appendChild(videoWrap);
    container.appendChild(mediaViewer);
  }

  // ── Audio viewer with native controls ──
  static _renderAudio(container, filePath, fileName) {
    const mediaViewer = document.createElement('div');
    mediaViewer.className = 'media-viewer media-viewer-audio';

    const label = document.createElement('div');
    label.className = 'media-audio-label';
    label.textContent = fileName;

    const audio = document.createElement('audio');
    audio.src = `/api/file/raw?path=${encodeURIComponent(filePath)}`;
    audio.controls = true;
    audio.className = 'media-audio';
    audio.preload = 'metadata';

    mediaViewer.append(label, audio);
    container.appendChild(mediaViewer);
  }

  // ── PDF viewer via iframe/embed ──
  static _renderPdf(container, filePath) {
    const mediaViewer = document.createElement('div');
    mediaViewer.className = 'media-viewer';

    const embed = document.createElement('iframe');
    embed.src = `/api/file/raw?path=${encodeURIComponent(filePath)}`;
    embed.className = 'media-pdf';

    mediaViewer.appendChild(embed);
    container.appendChild(mediaViewer);
  }

  // ── HTML viewer with Preview / Code toggle ──
  static _renderHtml(container, filePath, app, fileName, winInfo) {
    const htmlViewer = document.createElement('div');
    htmlViewer.className = 'html-viewer';

    // Toolbar with mode toggle
    const toolbar = document.createElement('div');
    toolbar.className = 'media-toolbar';

    const btnPreview = FileViewer._mediaBtn('Preview');
    const btnCode = FileViewer._mediaBtn('Code');
    btnPreview.classList.add('active');

    const contentArea = document.createElement('div');
    contentArea.className = 'html-viewer-content';

    // Preview mode: iframe
    const iframe = document.createElement('iframe');
    iframe.className = 'html-preview';
    iframe.sandbox = 'allow-scripts allow-same-origin';
    iframe.src = `/api/file/raw?path=${encodeURIComponent(filePath)}`;
    contentArea.appendChild(iframe);

    let codeEditorContainer = null;
    let codeEditorInstance = null;

    const showPreview = () => {
      btnPreview.classList.add('active');
      btnCode.classList.remove('active');
      iframe.style.display = '';
      if (codeEditorContainer) codeEditorContainer.style.display = 'none';
    };

    const showCode = () => {
      btnCode.classList.add('active');
      btnPreview.classList.remove('active');
      iframe.style.display = 'none';
      if (!codeEditorContainer) {
        // Create code editor on first switch
        codeEditorContainer = document.createElement('div');
        codeEditorContainer.className = 'html-code-container';
        contentArea.appendChild(codeEditorContainer);

        // Create a mini winInfo-like object for CodeEditor
        const fakeWinInfo = { content: codeEditorContainer, onClose: null };
        codeEditorInstance = new CodeEditor(fakeWinInfo, filePath, fileName, app);
      }
      codeEditorContainer.style.display = '';
    };

    btnPreview.onclick = showPreview;
    btnCode.onclick = showCode;

    toolbar.append(btnPreview, btnCode);
    htmlViewer.append(toolbar, contentArea);
    container.appendChild(htmlViewer);
  }

  // ── Helper: create a styled button for media toolbars ──
  static _mediaBtn(text) {
    const b = document.createElement('button');
    b.className = 'file-tool-btn media-btn';
    b.textContent = text;
    return b;
  }
}

export { FileViewer };
