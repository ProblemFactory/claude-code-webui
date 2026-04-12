/**
 * ChatMinimap — semantic scrollbar showing conversation structure.
 * User message markers (blue), compact markers (red), drag-to-jump with floating label.
 */

export class ChatMinimap {
  /**
   * @param {HTMLElement} container - parent container for positioning
   * @param {HTMLElement} messageList - the message list element to sync with
   * @param {function(number):void} jumpToIndex - callback to jump to a message index
   */
  constructor(container, messageList, jumpToIndex) {
    this._container = container;
    this._messageList = messageList;
    this._jumpToIndex = jumpToIndex;
    this._total = 0;
    this._windowStart = 0;
    this._windowEnd = 0;
    this._turnMap = [];

    // Create DOM elements
    this._minimap = document.createElement('div');
    this._minimap.className = 'chat-minimap hidden';
    container.appendChild(this._minimap);

    this._thumb = document.createElement('div');
    this._thumb.className = 'chat-minimap-thumb';
    this._minimap.appendChild(this._thumb);

    this._label = document.createElement('div');
    this._label.className = 'chat-minimap-label hidden';
    container.appendChild(this._label);

    // Sync bounds on message list resize
    this._ro = new ResizeObserver(() => this.syncBounds());
    this._ro.observe(messageList);

    this._setupDrag();
  }

  /** Update total message count and window position */
  setViewport(windowStart, windowEnd, total) {
    this._windowStart = windowStart;
    this._windowEnd = windowEnd;
    this._total = total;
    this.updateThumb();
  }

  /** Render turn map markers */
  render(turnMap) {
    if (!turnMap?.length || turnMap.length < 3) {
      this._minimap.classList.add('hidden');
      return;
    }
    this._turnMap = turnMap;
    this._minimap.classList.remove('hidden');
    this._messageList.classList.add('chat-minimap-active');
    this.syncBounds();

    // Remove old markers (keep thumb)
    for (const el of [...this._minimap.children]) {
      if (el !== this._thumb) el.remove();
    }

    const total = this._total || turnMap[turnMap.length - 1].startIdx + 1;
    for (const turn of turnMap) {
      if (turn.role !== 'user') continue;
      const top = (turn.startIdx / total) * 100;
      const marker = document.createElement('div');
      marker.className = 'chat-minimap-marker';
      marker.style.top = top + '%';
      if (turn.isCompact) {
        marker.classList.add('chat-minimap-compact');
      } else {
        marker.classList.add('chat-minimap-user-mark');
      }
      this._minimap.appendChild(marker);
    }
  }

  /** Sync minimap position/height to match message list within the container */
  syncBounds() {
    if (!this._minimap || !this._messageList) return;
    const listRect = this._messageList.getBoundingClientRect();
    const containerRect = this._container.getBoundingClientRect();
    this._minimap.style.top = (listRect.top - containerRect.top) + 'px';
    this._minimap.style.height = listRect.height + 'px';
  }

  updateThumb() {
    if (!this._thumb || !this._total || this._minimap.classList.contains('hidden')) return;
    const top = (this._windowStart / this._total) * 100;
    const height = Math.max(5, ((this._windowEnd - this._windowStart) / this._total) * 100);
    this._thumb.style.top = top + '%';
    this._thumb.style.height = height + '%';
  }

  _setupDrag() {
    let dragging = false;
    let jumpTimer = null;
    let pendingJumpIdx = null;

    const getIdxAtY = (e) => {
      const rect = this._minimap.getBoundingClientRect();
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      return Math.floor(y * (this._total || 1));
    };

    const getTurnAtIdx = (idx) => {
      if (!this._turnMap.length) return null;
      let best = this._turnMap[0];
      for (const t of this._turnMap) {
        if (t.startIdx <= idx) best = t;
        else break;
      }
      return best;
    };

    const updateLabel = (e, turn) => {
      if (!turn || !this._label) return;
      const containerRect = this._container.getBoundingClientRect();
      const d = new Date(turn.ts);
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      const date = isToday ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ';
      const time = date + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const preview = turn.preview || '';
      this._label.textContent = preview ? `${time} · ${preview}` : time;
      this._label.classList.remove('hidden');
      this._label.style.top = (e.clientY - containerRect.top) + 'px';
    };

    const scheduleJump = (idx) => {
      pendingJumpIdx = idx;
      if (!jumpTimer) {
        jumpTimer = setTimeout(() => {
          jumpTimer = null;
          if (pendingJumpIdx != null) this._jumpToIndex(pendingJumpIdx);
          pendingJumpIdx = null;
        }, 100);
      }
    };

    const onMove = (e) => {
      const idx = getIdxAtY(e);
      const turn = getTurnAtIdx(idx);
      updateLabel(e, turn);
      if (dragging) scheduleJump(idx);
    };

    this._minimap.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      const idx = getIdxAtY(e);
      this._jumpToIndex(idx);
      const turn = getTurnAtIdx(idx);
      updateLabel(e, turn);
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', () => {
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        this._label.classList.add('hidden');
        if (jumpTimer) { clearTimeout(jumpTimer); jumpTimer = null; }
      }, { once: true });
    });

    this._minimap.addEventListener('mousemove', (e) => {
      if (dragging) return;
      const idx = getIdxAtY(e);
      const turn = getTurnAtIdx(idx);
      updateLabel(e, turn);
    });

    this._minimap.addEventListener('mouseleave', () => {
      if (!dragging) this._label.classList.add('hidden');
    });
  }

  dispose() {
    if (this._ro) this._ro.disconnect();
    if (this._minimap) this._minimap.remove();
    if (this._label) this._label.remove();
  }
}
