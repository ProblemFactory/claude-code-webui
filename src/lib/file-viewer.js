import { marked } from 'marked';
import { MarkdownViewer } from './markdown.js';
import { HexViewer } from './hex-viewer.js';
import { formatSize } from './utils.js';

class FileViewer {
  static async open(app, filePath, fileName, opts = {}) {
    const ext = fileName.split('.').pop().toLowerCase();

    // Check file info first (size, binary detection)
    let fileInfo = { size: 0, isBinary: false };
    try {
      const res = await fetch(`/api/file/info?path=${encodeURIComponent(filePath)}`);
      fileInfo = await res.json();
    } catch {}

    // Force hex mode
    if (opts.hex) {
      const winInfo = app.wm.createWindow({ title: `Hex: ${fileName}`, type: 'hex-viewer' });
      new HexViewer(winInfo, filePath, fileInfo);
      return;
    }

    // Binary file → hex viewer
    if (fileInfo.isBinary) {
      const winInfo = app.wm.createWindow({ title: `Hex: ${fileName}`, type: 'hex-viewer' });
      new HexViewer(winInfo, filePath, fileInfo);
      return;
    }

    // Large file warning
    if (fileInfo.size > 1024 * 1024) {
      if (!confirm(`This file is ${formatSize(fileInfo.size)}. Opening may slow down the UI. Continue?`)) return;
    }

    // Markdown → MarkdownViewer with preview/edit/split modes
    if (ext === 'md') {
      const winInfo = app.wm.createWindow({ title: fileName, type: 'viewer' });
      new MarkdownViewer(winInfo, filePath, app);
      return;
    }

    const winInfo = app.wm.createWindow({ title: fileName, type: 'viewer' });
    const container = document.createElement('div'); container.className = 'file-viewer';
    winInfo.content.appendChild(container);
    winInfo.onClose = () => {};

    try {
      if (['png','jpg','jpeg','gif','webp','svg','bmp','ico'].includes(ext)) {
        const img = document.createElement('img'); img.src = `/api/file/raw?path=${encodeURIComponent(filePath)}`;
        img.style.padding = '8px'; container.appendChild(img);
      } else if (ext === 'pdf') {
        const iframe = document.createElement('iframe'); iframe.src = `/api/file/raw?path=${encodeURIComponent(filePath)}`;
        container.appendChild(iframe);
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
        app.openEditor(filePath, fileName);
        app.wm.closeWindow(winInfo.id);
      }
    } catch (err) {
      container.innerHTML = `<div class="empty-hint" style="color:var(--red);padding:20px">Error: ${err.message}</div>`;
    }
  }
}

export { FileViewer };
