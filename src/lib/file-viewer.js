import { marked } from 'marked';
import { HexViewer } from './hex-viewer.js';
import { CodeEditor } from './code-editor.js';
import { formatSize } from './utils.js';
import { hasDedicatedViewer, getViewerType } from './file-types.js';
import { renderAsync as renderDocx } from 'docx-preview';
import { init as initPptx } from 'pptx-preview';

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

    // Binary file without a dedicated viewer → hex viewer
    if (fileInfo.isBinary && !hasDedicatedViewer(ext)) {
      const winInfo = app.wm.createWindow({ title: `Hex: ${fileName}`, type: 'hex-viewer', syncId: opts.syncId, openSpec });
      winInfo._filePath = filePath; winInfo._fileName = fileName;
      new HexViewer(winInfo, filePath, fileInfo);
      return;
    }

    const viewerType = getViewerType(ext);

    // Large file warning (only for text files opened in editor)
    if (!hasDedicatedViewer(ext) && fileInfo.size > 1024 * 1024) {
      if (!confirm(`This file is ${formatSize(fileInfo.size)}. Opening may slow down the UI. Continue?`)) return;
    }

    // HTML: open in CodeEditor with preview toggle (same as markdown)
    if (viewerType === 'html-editor') {
      const winInfo = app.wm.createWindow({ title: fileName, type: 'editor', syncId: opts.syncId, openSpec });
      winInfo._filePath = filePath; winInfo._fileName = fileName;
      new CodeEditor(winInfo, filePath, fileName, app);
      return;
    }

    const winInfo = app.wm.createWindow({ title: fileName, type: 'viewer', syncId: opts.syncId, openSpec });
    winInfo._filePath = filePath; winInfo._fileName = fileName;
    const container = document.createElement('div'); container.className = 'file-viewer';
    winInfo.content.appendChild(container);
    winInfo.onClose = () => {};
    try {
      if (viewerType === 'image') {
        FileViewer._renderImage(container, filePath);
      } else if (viewerType === 'video') {
        FileViewer._renderVideo(container, filePath);
      } else if (viewerType === 'audio') {
        FileViewer._renderAudio(container, filePath, fileName);
      } else if (viewerType === 'pdf') {
        FileViewer._renderPdf(container, filePath);
      } else if (viewerType === 'csv') {
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
      } else if (viewerType === 'xlsx') {
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
      } else if (viewerType === 'docx') {
        // Client-side DOCX rendering via docx-preview (visual fidelity)
        const res = await fetch(`/api/file/raw?path=${encodeURIComponent(filePath)}`);
        const blob = await res.blob();
        const wrapper = document.createElement('div'); wrapper.className = 'docx-preview';
        container.appendChild(wrapper);
        await renderDocx(blob, wrapper, wrapper, {
          inWrapper: true, ignoreWidth: false, ignoreHeight: false,
          renderHeaders: true, renderFooters: true, renderFootnotes: true,
        });
      } else if (viewerType === 'pptx') {
        // Client-side PPTX rendering via pptx-preview
        const wrapper = document.createElement('div'); wrapper.className = 'pptx-preview';
        wrapper.style.cssText = 'width:100%;height:100%;overflow:auto;background:var(--bg-workspace)';
        container.appendChild(wrapper);
        const rect = container.getBoundingClientRect();
        const previewer = initPptx(wrapper, { width: Math.max(640, rect.width - 40), height: Math.max(360, (rect.width - 40) * 9 / 16), mode: 'list' });
        const res = await fetch(`/api/file/raw?path=${encodeURIComponent(filePath)}`);
        const buf = await res.arrayBuffer();
        previewer.preview(buf);
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
