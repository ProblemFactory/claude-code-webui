/**
 * ChatSearch — extracted search functionality for ChatView.
 * Handles search bar DOM, server-side search, highlight layer, and navigation.
 */
class ChatSearch {
  /**
   * @param {HTMLElement} messageList - the .chat-message-list element to search within
   * @param {Object} callbacks
   * @param {() => {claudeId: string, cwd: string}} callbacks.getSessionIds
   * @param {() => string} callbacks.getSessionId - returns the webui session ID
   * @param {(idx: number) => Promise<void>} callbacks.jumpToIndex
   * @param {() => {windowStart: number, windowEnd: number}} callbacks.getWindowBounds
   */
  constructor(messageList, { getSessionIds, getSessionId, jumpToIndex, getWindowBounds }) {
    this._messageList = messageList;
    this._getSessionIds = getSessionIds;
    this._getSessionId = getSessionId;
    this._jumpToIndex = jumpToIndex;
    this._getWindowBounds = getWindowBounds;

    // Search state
    this._searchQuery = '';
    this._highlightQuery = '';
    this._highlightRanges = [];
    this._serverSearchResults = [];
    this._searchResultIdx = -1;
    this._searchTimer = null;

    // Build search bar DOM
    this._bar = document.createElement('div');
    this._bar.className = 'chat-search-bar hidden';

    this._input = document.createElement('input');
    this._input.className = 'chat-search-input';
    this._input.placeholder = 'Search messages...';
    this._input.type = 'text';

    this._searchStatus = document.createElement('span');
    this._searchStatus.className = 'chat-search-status';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'chat-search-nav';
    prevBtn.textContent = '\u25B2';
    prevBtn.title = 'Previous';
    prevBtn.onclick = () => this._searchNav(-1);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'chat-search-nav';
    nextBtn.textContent = '\u25BC';
    nextBtn.title = 'Next';
    nextBtn.onclick = () => this._searchNav(1);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'chat-search-close';
    closeBtn.textContent = '\u2715';
    closeBtn.onclick = () => { this._bar.classList.add('hidden'); this._input.value = ''; this._clearSearch(); };

    this._bar.append(this._input, this._searchStatus, prevBtn, nextBtn, closeBtn);

    this._input.addEventListener('input', () => this._doSearch(this._input.value));
    this._input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._searchNav(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { closeBtn.click(); }
    });
  }

  /** The search bar DOM element for ChatView to insert */
  get element() { return this._bar; }

  /** Whether there is an active highlight query */
  get hasHighlight() { return !!this._highlightQuery; }

  /** Show the search bar and focus the input */
  open() {
    this._bar.classList.remove('hidden');
    this._input.focus();
    this._input.select();
  }

  // ── Search dispatch ──

  _doSearch(query) {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this._executeSearch(query), 250);
  }

  async _executeSearch(query) {
    this._clearSearch();
    const q = query.trim().toLowerCase();
    if (!q) { this._searchStatus.textContent = ''; return; }

    this._searchStatus.textContent = 'Searching...';
    this._searchQuery = q;
    this._highlightQuery = q;
    this.applyHighlightLayer(); // highlight current view immediately

    // Server-side search — find claudeSessionId for this webui session
    let { claudeId, cwd } = this._getSessionIds();
    // Fallback: check active sessions API directly
    if (!claudeId) {
      try {
        const r = await fetch('/api/active');
        const d = await r.json();
        const sessions = d.sessions || d;
        const sessionId = this._getSessionId();
        const s = Array.isArray(sessions) ? sessions.find(s => s.id === sessionId) : null;
        if (s) { claudeId = s.claudeSessionId; cwd = s.cwd || ''; }
      } catch {}
    }

    if (claudeId) {
      try {
        const res = await fetch(`/api/session-messages?claudeSessionId=${encodeURIComponent(claudeId)}&cwd=${encodeURIComponent(cwd)}&search=${encodeURIComponent(q)}`);
        const data = await res.json();
        this._serverSearchResults = data.matches || [];
      } catch {
        this._serverSearchResults = [];
      }
    } else {
      this._serverSearchResults = [];
    }

    if (!this._serverSearchResults.length) {
      this._searchStatus.textContent = 'No results';
      return;
    }

    this._searchResultIdx = 0;
    this._searchStatus.textContent = `1/${this._serverSearchResults.length}`;
    this._jumpToSearchResult(0);
  }

  async _jumpToSearchResult(idx) {
    const results = this._serverSearchResults;
    if (!results || idx < 0 || idx >= results.length) return;

    const msgIndex = results[idx].index;
    const { windowStart, windowEnd } = this._getWindowBounds();

    // Jump window if target is outside
    if (msgIndex < windowStart || msgIndex >= windowEnd) {
      await this._jumpToIndex(msgIndex);
    }

    // Expand collapsed content in target, then refresh highlight layer
    const { windowStart: newStart } = this._getWindowBounds();
    const relIdx = msgIndex - newStart;
    const allMsgs = this._messageList.querySelectorAll('.chat-msg');
    if (relIdx >= 0 && relIdx < allMsgs.length) {
      const targetEl = allMsgs[relIdx];
      targetEl.style.contentVisibility = 'visible';
      for (const d of targetEl.querySelectorAll('details:not([open])')) d.open = true;
    }

    // Refresh highlight layer and scroll to first match in target
    this.applyHighlightLayer();
    const targetEl = allMsgs[relIdx];
    if (this._highlightRanges?.length > 0 && targetEl) {
      const matchIdx = this._highlightRanges.findIndex(r => targetEl.contains(r.startContainer));
      if (matchIdx >= 0) {
        this._setCurrentHighlight(matchIdx);
        // Scroll the range into view
        const rect = this._highlightRanges[matchIdx].getBoundingClientRect();
        const listRect = this._messageList.getBoundingClientRect();
        this._messageList.scrollTop += rect.top - listRect.top - listRect.height / 2;
        return;
      }
    }
    // Fallback: just scroll to the message
    if (targetEl) targetEl.scrollIntoView({ block: 'center' });
  }

  // ── Highlight Layer: non-destructive search highlighting ──

  /** Apply highlight layer to current DOM content based on _highlightQuery */
  applyHighlightLayer() {
    if (!CSS.highlights) return; // fallback: no highlight API
    CSS.highlights.delete('chat-search');
    CSS.highlights.delete('chat-search-current');
    if (!this._highlightQuery) return;

    const q = this._highlightQuery;
    const ranges = [];
    const walker = document.createTreeWalker(this._messageList, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent.toLowerCase();
      let idx = 0;
      while ((idx = text.indexOf(q, idx)) !== -1) {
        const range = new Range();
        range.setStart(node, idx);
        range.setEnd(node, idx + q.length);
        ranges.push(range);
        idx += q.length;
      }
    }
    if (ranges.length > 0) {
      CSS.highlights.set('chat-search', new Highlight(...ranges));
    }
    this._highlightRanges = ranges;
  }

  /** Highlight a specific range as "current" (for search navigation) */
  _setCurrentHighlight(rangeIdx) {
    if (!CSS.highlights || !this._highlightRanges) return;
    CSS.highlights.delete('chat-search-current');
    if (rangeIdx >= 0 && rangeIdx < this._highlightRanges.length) {
      CSS.highlights.set('chat-search-current', new Highlight(this._highlightRanges[rangeIdx]));
    }
  }

  _clearHighlightLayer() {
    this._highlightQuery = '';
    this._highlightRanges = [];
    if (CSS.highlights) {
      CSS.highlights.delete('chat-search');
      CSS.highlights.delete('chat-search-current');
    }
  }

  _searchNav(dir) {
    const results = this._serverSearchResults;
    if (!results || !results.length) return;
    this._searchResultIdx = (this._searchResultIdx + dir + results.length) % results.length;
    this._searchStatus.textContent = `${this._searchResultIdx + 1}/${results.length}`;
    this._jumpToSearchResult(this._searchResultIdx);
  }

  _clearSearch() {
    this._clearHighlightLayer();
    this._serverSearchResults = [];
    this._searchResultIdx = -1;
    this._searchQuery = '';
    if (this._searchStatus) this._searchStatus.textContent = '';
  }

  /** Clean up timers */
  dispose() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._clearHighlightLayer();
  }
}

export { ChatSearch };
