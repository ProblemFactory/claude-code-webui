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
    const rendered = await FileViewer.renderInto(container, filePath, fileName);
    if (!rendered) {
      // No dedicated viewer — open in code editor
      app.openEditor(filePath, fileName, opts);
      app.wm.closeWindow(winInfo.id);
    }
  }

  /**
   * Render a file into a container element. Used by both the file viewer window
   * and the file explorer preview panel. Returns true if rendered, false if
   * no dedicated viewer exists for this file type.
   */
  static async renderInto(container, filePath, fileName) {
    const ext = (fileName || filePath.split('/').pop()).split('.').pop().toLowerCase();
    const viewerType = getViewerType(ext);
    const rawUrl = `/api/file/raw?path=${encodeURIComponent(filePath)}`;

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
        FileViewer._renderCsv(container, filePath, ext);
      } else if (viewerType === 'xlsx') {
        const res = await fetch(`/api/file/excel?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        // Sheet tabs + table viewer
        const viewer = document.createElement('div'); viewer.style.cssText = 'display:flex;flex-direction:column;height:100%';
        const tableWrap = document.createElement('div'); tableWrap.style.cssText = 'flex:1;overflow:auto';
        const renderSheet = (sheet) => {
          tableWrap.innerHTML = '';
          const table = document.createElement('table'); table.className = 'file-viewer-table';
          const tbody = document.createElement('tbody');
          (sheet.data || []).slice(0, 5000).forEach((row, ri) => {
            const tr = document.createElement('tr');
            (row || []).forEach(c => { const td = document.createElement(ri === 0 ? 'th' : 'td'); td.textContent = c ?? ''; tr.appendChild(td); });
            tbody.appendChild(tr);
          });
          table.appendChild(tbody); tableWrap.appendChild(table);
        };
        if (data.sheets.length > 1) {
          const tabs = document.createElement('div');
          tabs.style.cssText = 'display:flex;gap:0;border-top:1px solid var(--border);background:var(--bg-titlebar);flex-shrink:0;overflow-x:auto';
          data.sheets.forEach((sheet, i) => {
            const tab = document.createElement('div');
            tab.textContent = sheet.name;
            tab.style.cssText = 'padding:4px 12px;font-size:11px;cursor:pointer;border-right:1px solid var(--border);white-space:nowrap;color:var(--text-secondary)';
            tab.onclick = () => {
              tabs.querySelectorAll('div').forEach(t => { t.style.background = ''; t.style.color = 'var(--text-secondary)'; });
              tab.style.background = 'var(--bg-window)'; tab.style.color = 'var(--text)';
              renderSheet(sheet);
            };
            if (i === 0) { tab.style.background = 'var(--bg-window)'; tab.style.color = 'var(--text)'; }
            tabs.appendChild(tab);
          });
          viewer.append(tableWrap, tabs);
        } else {
          viewer.appendChild(tableWrap);
        }
        renderSheet(data.sheets[0]);
        container.appendChild(viewer);
      } else if (viewerType === 'docx') {
        const res = await fetch(rawUrl);
        const blob = await res.blob();
        const wrapper = document.createElement('div'); wrapper.className = 'docx-preview';
        container.appendChild(wrapper);
        await renderDocx(blob, wrapper, wrapper, { inWrapper: true, ignoreWidth: false, ignoreHeight: false, renderHeaders: true, renderFooters: true, renderFootnotes: true });
      } else if (viewerType === 'pptx') {
        FileViewer._renderPptx(container, filePath, rawUrl);
      } else {
        return false; // no dedicated viewer
      }
      return true;
    } catch (err) {
      container.innerHTML = `<div class="empty-hint" style="color:var(--red);padding:20px">Error: ${err.message}</div>`;
      return true; // error shown, don't fall through to editor
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
  // ── PPTX viewer: thumbnail sidebar + main slide + responsive ──
  static async _renderPptx(container, filePath, rawUrl) {
    const res = await fetch(rawUrl);
    const buf = await res.arrayBuffer();

    const viewer = document.createElement('div');
    viewer.style.cssText = 'display:flex;height:100%;overflow:hidden;background:var(--bg-workspace);user-select:text';

    const sidebar = document.createElement('div');
    sidebar.style.cssText = 'width:180px;min-width:120px;max-width:400px;flex-shrink:0;overflow-y:auto;border-right:1px solid var(--border);background:var(--bg-sidebar);padding:8px';

    // Sidebar resize handle
    const sidebarHandle = document.createElement('div');
    sidebarHandle.style.cssText = 'width:4px;flex-shrink:0;cursor:col-resize;background:transparent;transition:background 0.15s';
    sidebarHandle.onmouseenter = () => { sidebarHandle.style.background = 'var(--accent-dim)'; };
    sidebarHandle.onmouseleave = () => { sidebarHandle.style.background = ''; };
    sidebarHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX, startW = sidebar.offsetWidth;
      const onMove = (ev) => { sidebar.style.width = Math.max(120, Math.min(400, startW + ev.clientX - startX)) + 'px'; if (viewer._resizeThumbs) viewer._resizeThumbs(); };
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); sidebarHandle.style.background = ''; };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    const main = document.createElement('div');
    main.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;padding:16px;min-width:0';

    const slideContainer = document.createElement('div');
    slideContainer.style.cssText = 'position:relative';
    main.appendChild(slideContainer);

    viewer.append(sidebar, sidebarHandle, main);
    container.appendChild(viewer);

    // Load once for main view — this previewer is reused for slide switching
    const mainPreviewer = initPptx(slideContainer, { width: 800, height: 450, mode: 'slide' });
    await mainPreviewer.preview(buf);
    const count = mainPreviewer.slideCount;

    let activeIdx = 0;
    const thumbEls = [];

    // Render main slide — switching slides reuses previewer, resize recreates it
    let currentPreviewer = mainPreviewer;
    let lastW = 0, lastH = 0;

    const renderMain = (idx, forceResize = false) => {
      activeIdx = idx;
      const rect = main.getBoundingClientRect();
      const w = Math.max(300, rect.width - 40);
      const h = Math.max(170, rect.height - 40);
      const aspect = 16 / 9;
      let slideW, slideH;
      if (w / h > aspect) { slideH = h; slideW = h * aspect; }
      else { slideW = w; slideH = w / aspect; }
      slideW = Math.round(slideW); slideH = Math.round(slideH);

      if (forceResize || Math.abs(slideW - lastW) > 5 || Math.abs(slideH - lastH) > 5) {
        // Size changed — need to recreate previewer with new dimensions
        lastW = slideW; lastH = slideH;
        slideContainer.innerHTML = '';
        currentPreviewer = initPptx(slideContainer, { width: slideW, height: slideH, mode: 'slide' });
        // Re-load from already-fetched buffer (re-parses but no network request)
        currentPreviewer.load(buf).then(() => currentPreviewer.renderSingleSlide(idx));
      } else {
        // Same size — just switch slide
        currentPreviewer.removeCurrentSlide();
        currentPreviewer.renderSingleSlide(idx);
      }

      thumbEls.forEach((t, i) => {
        t.style.borderColor = i === idx ? 'var(--accent)' : 'var(--border)';
        t.style.opacity = i === idx ? '1' : '0.7';
      });
    };

    // Build thumbnails: render at high resolution, CSS scale to fit sidebar
    const THUMB_RENDER_W = 800;
    const THUMB_RENDER_H = 450;
    const thumbHidden = document.createElement('div');
    thumbHidden.style.cssText = 'position:absolute;left:-9999px;top:0';
    document.body.appendChild(thumbHidden);
    const thumbPreviewer = initPptx(thumbHidden, { width: THUMB_RENDER_W, height: THUMB_RENDER_H, mode: 'list' });
    await thumbPreviewer.preview(buf);

    // Extract rendered slides from list container
    const thumbWrapper = thumbHidden.querySelector('div') || thumbHidden;
    const thumbSource = [...thumbWrapper.children];

    const thumbContents = []; // store references for resize
    for (let i = 0; i < count; i++) {
      const thumb = document.createElement('div');
      thumb.style.cssText = 'margin-bottom:6px;cursor:pointer;border:2px solid var(--border);border-radius:4px;overflow:hidden;opacity:0.7;transition:all 0.15s;position:relative';

      const label = document.createElement('div');
      label.style.cssText = 'position:absolute;top:2px;left:4px;font-size:9px;z-index:1;background:rgba(0,0,0,0.5);padding:0 3px;border-radius:2px;color:#fff';
      label.textContent = i + 1;

      const thumbContent = document.createElement('div');
      thumbContent.style.cssText = 'overflow:hidden;pointer-events:none;position:relative';
      if (thumbSource[i]) {
        const clone = thumbSource[i].cloneNode(true);
        clone.style.transformOrigin = 'top left';
        clone.style.width = THUMB_RENDER_W + 'px';
        clone.style.height = THUMB_RENDER_H + 'px';
        clone.style.position = 'absolute';
        clone.style.top = '0'; clone.style.left = '0';
        thumbContent.appendChild(clone);
      }
      thumbContents.push(thumbContent);

      thumb.append(label, thumbContent);
      thumb.onclick = () => { renderMain(i); thumb.scrollIntoView({ block: 'nearest' }); };
      thumb.onmouseenter = () => { if (activeIdx !== i) thumb.style.opacity = '0.9'; };
      thumb.onmouseleave = () => { if (activeIdx !== i) thumb.style.opacity = '0.7'; };
      thumbEls.push(thumb);
      sidebar.appendChild(thumb);
    }
    thumbHidden.remove();

    // Scale thumbnails to fit sidebar width — called on init and sidebar resize
    const resizeThumbs = () => {
      const displayW = sidebar.clientWidth - 16;
      const scale = displayW / THUMB_RENDER_W;
      const displayH = Math.round(THUMB_RENDER_H * scale);
      for (const tc of thumbContents) {
        tc.style.width = displayW + 'px';
        tc.style.height = displayH + 'px';
        const clone = tc.firstChild;
        if (clone) clone.style.transform = `scale(${scale})`;
      }
    };
    resizeThumbs();
    viewer._resizeThumbs = resizeThumbs;

    // Initial render at correct size
    renderMain(0, true);

    // Keyboard navigation
    const onKey = (e) => {
      if (!container.closest('.window-active')) return;
      if (e.target.closest('textarea, input, [contenteditable]')) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); if (activeIdx < count - 1) renderMain(activeIdx + 1); thumbEls[activeIdx]?.scrollIntoView({ block: 'nearest' }); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); if (activeIdx > 0) renderMain(activeIdx - 1); thumbEls[activeIdx]?.scrollIntoView({ block: 'nearest' }); }
    };
    document.addEventListener('keydown', onKey);

    // Responsive resize
    let resizeTimer = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => renderMain(activeIdx, true), 200);
    });
    ro.observe(main);
  }

  static _mediaBtn(text) {
    const b = document.createElement('button');
    b.className = 'file-tool-btn media-btn';
    b.textContent = text;
    return b;
  }

  // ── CSV/TSV viewer with virtual scroll (streaming from server) ──
  static async _renderCsv(container, filePath, ext) {
    const sep = ext === 'tsv' ? '\t' : ',';
    const ROW_HEIGHT = 24;
    const PAGE_SIZE = 200;
    const cache = new Map(); // offset → rows array
    let header = null, total = 0;

    // Fetch a page of rows
    const fetchPage = async (offset) => {
      if (cache.has(offset)) return;
      const res = await fetch(`/api/file/csv?path=${encodeURIComponent(filePath)}&offset=${offset}&limit=${PAGE_SIZE}&sep=${encodeURIComponent(sep)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!header && data.header) header = data.header;
      if (data.total) total = Math.max(total, data.total);
      cache.set(offset, data.rows);
    };

    // Initial fetch
    await fetchPage(0);
    if (!header) { container.innerHTML = '<div class="empty-hint">Empty file</div>'; return; }

    // Build viewer
    const viewer = document.createElement('div');
    viewer.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden';

    // Status bar
    const status = document.createElement('div');
    status.style.cssText = 'padding:2px 8px;font-size:10px;color:var(--text-dim);border-bottom:1px solid var(--border);flex-shrink:0';
    status.textContent = `${total.toLocaleString()} rows × ${header.length} columns`;

    // Header
    const thead = document.createElement('div');
    thead.style.cssText = 'display:flex;border-bottom:1px solid var(--border);background:var(--bg-titlebar);flex-shrink:0';
    // Row number header
    const rnH = document.createElement('div');
    rnH.style.cssText = 'width:50px;padding:3px 6px;font-size:10px;font-weight:600;color:var(--text-dim);flex-shrink:0;text-align:right;border-right:1px solid var(--border)';
    rnH.textContent = '#';
    thead.appendChild(rnH);
    for (const col of header) {
      const th = document.createElement('div');
      th.style.cssText = 'flex:1;min-width:80px;padding:3px 6px;font-size:10px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-right:1px solid var(--border)';
      th.textContent = col;
      th.title = col;
      thead.appendChild(th);
    }

    // Virtual scroll area
    const scrollArea = document.createElement('div');
    scrollArea.style.cssText = 'flex:1;overflow:auto;position:relative';
    const spacer = document.createElement('div');
    spacer.style.height = ((total - 1) * ROW_HEIGHT) + 'px';
    spacer.style.position = 'relative';
    scrollArea.appendChild(spacer);

    const renderRows = () => {
      const scrollTop = scrollArea.scrollTop;
      const viewH = scrollArea.clientHeight;
      const startRow = Math.floor(scrollTop / ROW_HEIGHT);
      const visibleCount = Math.ceil(viewH / ROW_HEIGHT) + 2;

      // Determine which page(s) we need
      const pageStart = Math.floor(startRow / PAGE_SIZE) * PAGE_SIZE;
      if (!cache.has(pageStart)) fetchPage(pageStart).then(renderRows);
      if (!cache.has(pageStart + PAGE_SIZE) && startRow + visibleCount > pageStart + PAGE_SIZE) {
        fetchPage(pageStart + PAGE_SIZE).then(renderRows);
      }

      // Clear and render visible rows
      spacer.querySelectorAll('.csv-row').forEach(r => r.remove());
      for (let i = 0; i < visibleCount; i++) {
        const rowIdx = startRow + i;
        if (rowIdx >= total - 1) break;
        const page = Math.floor(rowIdx / PAGE_SIZE) * PAGE_SIZE;
        const rows = cache.get(page);
        if (!rows) continue;
        const row = rows[rowIdx - page];
        if (!row) continue;

        const rowEl = document.createElement('div');
        rowEl.className = 'csv-row';
        rowEl.style.cssText = `position:absolute;top:${rowIdx * ROW_HEIGHT}px;left:0;right:0;height:${ROW_HEIGHT}px;display:flex;align-items:center;font-size:11px;border-bottom:1px solid var(--border)`;
        if (rowIdx % 2) rowEl.style.background = 'rgba(128,128,128,0.03)';

        // Row number
        const rn = document.createElement('div');
        rn.style.cssText = 'width:50px;padding:0 6px;font-size:9px;color:var(--text-dim);flex-shrink:0;text-align:right;border-right:1px solid var(--border)';
        rn.textContent = rowIdx + 1;
        rowEl.appendChild(rn);

        for (const cell of row) {
          const td = document.createElement('div');
          td.style.cssText = 'flex:1;min-width:80px;padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-right:1px solid var(--border);color:var(--text)';
          td.textContent = cell;
          td.title = cell;
          rowEl.appendChild(td);
        }
        spacer.appendChild(rowEl);
      }
    };

    scrollArea.addEventListener('scroll', renderRows);
    viewer.append(status, thead, scrollArea);
    container.appendChild(viewer);
    requestAnimationFrame(renderRows);
  }
}

export { FileViewer };
