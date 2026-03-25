import { formatSize } from './utils.js';

const BYTES_PER_ROW = 16;
const CHUNK_SIZE = 65536; // 64KB chunks

class HexViewer {
  constructor(winInfo, filePath, fileInfo) {
    this.filePath = filePath;
    this.fileSize = fileInfo.size;
    this.loadedBytes = 0;
    this.data = new Uint8Array(0);

    const container = document.createElement('div'); container.className = 'hex-viewer';

    // Toolbar
    const toolbar = document.createElement('div'); toolbar.className = 'hex-toolbar';
    toolbar.innerHTML = `
      <span class="file-path">${filePath}</span>
      <span class="hex-info">${formatSize(fileInfo.size)}</span>
    `;
    const jumpInput = document.createElement('input');
    jumpInput.className = 'toolbar-select'; jumpInput.placeholder = 'Jump to offset (hex)';
    jumpInput.style.cssText = 'width:140px;font-size:10px;font-family:monospace';
    jumpInput.onkeydown = (e) => { if (e.key === 'Enter') this._jumpTo(jumpInput.value); };
    const loadMoreBtn = document.createElement('button'); loadMoreBtn.className = 'file-tool-btn';
    loadMoreBtn.style.cssText = 'width:auto;padding:2px 8px;font-size:11px'; loadMoreBtn.textContent = 'Load more';
    loadMoreBtn.onclick = () => this._loadChunk();
    toolbar.append(jumpInput, loadMoreBtn);

    // Content
    this.contentEl = document.createElement('div'); this.contentEl.className = 'hex-content';
    this.statusEl = document.createElement('div'); this.statusEl.className = 'hex-status';

    container.append(toolbar, this.contentEl, this.statusEl);
    winInfo.content.appendChild(container);

    this._loadChunk();
  }

  async _loadChunk() {
    try {
      const res = await fetch(`/api/file/binary?path=${encodeURIComponent(this.filePath)}&offset=${this.loadedBytes}&length=${CHUNK_SIZE}`);
      if (!res.ok) throw new Error('Failed to load');
      const buf = await res.arrayBuffer();
      const newData = new Uint8Array(buf);
      if (newData.length === 0) { this.statusEl.textContent = 'End of file'; return; }

      // Append to existing data
      const combined = new Uint8Array(this.data.length + newData.length);
      combined.set(this.data);
      combined.set(newData, this.data.length);
      this.data = combined;
      this.loadedBytes += newData.length;

      this._render();
      this.statusEl.textContent = `Loaded ${formatSize(this.loadedBytes)} / ${formatSize(this.fileSize)}`;
    } catch (err) {
      this.statusEl.textContent = 'Error: ' + err.message;
    }
  }

  _render() {
    const frag = document.createDocumentFragment();
    const totalRows = Math.ceil(this.data.length / BYTES_PER_ROW);

    // Clear and rebuild (for large files, only render visible rows would be better, but this works for <256KB)
    this.contentEl.innerHTML = '';

    for (let row = 0; row < totalRows; row++) {
      const offset = row * BYTES_PER_ROW;
      const rowEl = document.createElement('div'); rowEl.className = 'hex-row';

      // Offset column
      const offsetEl = document.createElement('span'); offsetEl.className = 'hex-offset';
      offsetEl.textContent = offset.toString(16).padStart(8, '0');

      // Hex bytes column
      const bytesEl = document.createElement('span'); bytesEl.className = 'hex-bytes';
      let hexStr = '';
      for (let i = 0; i < BYTES_PER_ROW; i++) {
        const idx = offset + i;
        if (idx < this.data.length) {
          const byte = this.data[idx];
          hexStr += (byte === 0 ? '<span class="hex-null">00</span>' : byte.toString(16).padStart(2, '0'));
        } else {
          hexStr += '  ';
        }
        hexStr += i === 7 ? '  ' : ' ';
      }
      bytesEl.innerHTML = hexStr;

      // ASCII column
      const asciiEl = document.createElement('span'); asciiEl.className = 'hex-ascii';
      let asciiStr = '';
      for (let i = 0; i < BYTES_PER_ROW; i++) {
        const idx = offset + i;
        if (idx < this.data.length) {
          const byte = this.data[idx];
          asciiStr += (byte >= 32 && byte < 127) ? String.fromCharCode(byte) : '.';
        }
      }
      asciiEl.textContent = asciiStr;

      rowEl.append(offsetEl, bytesEl, asciiEl);
      frag.appendChild(rowEl);
    }
    this.contentEl.appendChild(frag);
  }

  _jumpTo(hexOffset) {
    const offset = parseInt(hexOffset, 16);
    if (isNaN(offset)) return;
    const row = Math.floor(offset / BYTES_PER_ROW);
    const rowEl = this.contentEl.children[row];
    if (rowEl) rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else if (offset > this.loadedBytes) {
      // Need to load more data first
      this.loadedBytes = Math.max(0, offset - CHUNK_SIZE);
      this.data = new Uint8Array(0);
      this.contentEl.innerHTML = '';
      this._loadChunk();
    }
  }

}

export { HexViewer };
