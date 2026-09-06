import { t } from './i18n.js';
import { metric } from './telemetry-client.js';

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
  constructor(messageList, { getSessionIds, getSessionId, jumpToIndex, getWindowBounds, getGapActive, jumpToFileMatch, onNav }) {
    this._messageList = messageList;
    this._getSessionIds = getSessionIds;
    this._getSessionId = getSessionId;
    this._jumpToIndex = jumpToIndex;
    this._getWindowBounds = getWindowBounds;
    this._getGapActive = getGapActive || (() => false);
    this._jumpToFileMatch = jumpToFileMatch || null;
    // A reveal SCROLLS the list from outside its own event listeners — the
    // owner needs to know a reader positioned the view (desktop-resume re-tail).
    this._onNav = onNav || null;
    this._fullFileMode = false;
    this._truncated = false;

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
    this._input.placeholder = t('Search messages...');
    this._input.type = 'text';

    this._searchStatus = document.createElement('span');
    this._searchStatus.className = 'chat-search-status';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'chat-search-nav';
    prevBtn.textContent = '\u25B2';
    prevBtn.title = t('Previous');
    prevBtn.onclick = () => this._searchNav(-1);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'chat-search-nav';
    nextBtn.textContent = '\u25BC';
    nextBtn.title = t('Next');
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

    // Request token: a slow earlier search resolving after a newer one must
    // not overwrite the newer results / jump the view to stale matches
    const token = (this._searchToken = (this._searchToken || 0) + 1);
    const stale = () => this._searchToken !== token;

    this._searchStatus.textContent = t('Searching...');
    this._searchQuery = q;
    this._highlightQuery = q;
    this.applyHighlightLayer(); // highlight current view immediately

    // Server-side search — find backend session ID for this webui session
    let { backend, backendSessionId, cwd, claudeId, host } = this._getSessionIds();
    // Fallback: check active sessions API directly
    if (!backendSessionId) {
      try {
        const r = await fetch('/api/active');
        const d = await r.json();
        const sessions = d.sessions || d;
        const sessionId = this._getSessionId();
        const s = Array.isArray(sessions) ? sessions.find(s => s.id === sessionId) : null;
        if (s) {
          backend = s.backend || 'claude';
          backendSessionId = s.backendSessionId || s.claudeSessionId;
          claudeId = s.claudeSessionId || null;
          cwd = s.cwd || '';
          host = s.host || null;
        }
      } catch {}
    }

    this._fullFileMode = false;
    this._truncated = false;
    this._searching = false;
    if (!backendSessionId) { if (!stale()) this._searchStatus.textContent = t('No results'); return; }

    // Huge session: stream-search the ENTIRE file server-side. Results arrive
    // progressively (less-style) so the count updates live ("N… searching") and
    // the first match is jumped to as soon as it's found. Otherwise a single
    // request against the loaded window.
    if (this._getGapActive() && this._jumpToFileMatch) {
      this._fullFileMode = true;
      await this._streamFullFileSearch(backend, backendSessionId, cwd, q, token, stale, host);
      return;
    }

    let matches = [];
    try {
      const res = await fetch(`/api/session-messages?backend=${encodeURIComponent(backend || 'claude')}&backendSessionId=${encodeURIComponent(backendSessionId)}&cwd=${encodeURIComponent(cwd)}&search=${encodeURIComponent(q)}${host ? `&host=${encodeURIComponent(host)}` : ''}`);
      const data = await res.json();
      matches = data.matches || [];
    } catch {}
    if (stale()) return; // a newer search superseded this one
    this._serverSearchResults = matches;
    if (!this._serverSearchResults.length) { this._searchStatus.textContent = t('No results'); return; }
    this._searchResultIdx = 0;
    this._updateSearchStatus();
    this._jumpToSearchResult(0);
  }

  // Read the NDJSON match stream: jump to the first hit immediately, then keep
  // updating the live count until the server signals `done`.
  async _streamFullFileSearch(backend, backendSessionId, cwd, q, token, stale, host) {
    const _t0 = performance.now();
    this._searchAbort?.abort();
    const ac = (this._searchAbort = new AbortController());
    this._searching = true;
    this._serverSearchResults = [];
    this._searchResultIdx = -1;
    this._updateSearchStatus();
    let jumped = false;
    try {
      // &host= is MANDATORY for a remote session (2.272.1): without it the
      // server searched the LOCAL projects dir — on a remote conversation the
      // streaming search silently returned nothing (the last of the five
      // gap-endpoint callers to be threaded; the other four were fixed in the
      // same release).
      const url = `/api/session-history-gap?backend=${encodeURIComponent(backend || 'claude')}&backendSessionId=${encodeURIComponent(backendSessionId)}&cwd=${encodeURIComponent(cwd)}&search=${encodeURIComponent(q)}&stream=1${host ? `&host=${encodeURIComponent(host)}` : ''}`;
      const res = await fetch(url, { signal: ac.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (stale()) { ac.abort(); return; }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const ln of lines) {
          if (!ln) continue;
          let obj; try { obj = JSON.parse(ln); } catch { continue; }
          if (obj.done) { this._searching = false; this._truncated = !!obj.truncated; continue; }
          if (typeof obj.line !== 'number') continue; // gap-info preamble line
          this._serverSearchResults.push(obj);
          if (!jumped) { jumped = true; this._searchResultIdx = 0; this._jumpToSearchResult(0); }
          this._updateSearchStatus();
        }
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
    } finally {
      this._searching = false;
    }
    if (stale()) return;
    metric('chat-search-ms', performance.now() - _t0);
    if (!this._serverSearchResults.length) this._searchStatus.textContent = t('No results');
    else this._updateSearchStatus();
  }

  _updateSearchStatus() {
    const n = this._serverSearchResults.length;
    const idx = this._searchResultIdx >= 0 ? this._searchResultIdx + 1 : 0;
    if (this._searching) {
      // less-style: keep counting while the scan is still running
      this._searchStatus.textContent = n ? t('{idx}/{n}… searching', { idx, n }) : t('Searching…');
    } else {
      this._searchStatus.textContent = `${idx}/${n}${this._truncated ? '+' : ''}`;
    }
  }

  /** Expand collapsed content inside an element so highlights can paint */
  _expandEl(el) {
    if (!el) return;
    el.style.contentVisibility = 'visible';
    for (const d of el.querySelectorAll('details:not([open])')) d.open = true;
  }

  /** Highlight + scroll to the first match inside `el` (fallback: center el) */
  _revealInEl(el) {
    this.applyHighlightLayer();
    if (el && this._highlightRanges?.length > 0) {
      const matchIdx = this._highlightRanges.findIndex(r => el.contains(r.startContainer));
      if (matchIdx >= 0) {
        this._setCurrentHighlight(matchIdx);
        this._scrollToRange(this._highlightRanges[matchIdx]);
        return;
      }
    }
    if (el) el.scrollIntoView({ block: 'center' });
  }

  /**
   * Full-file jumps land in the right WINDOW but the anchor element may be a
   * message or two off the actual match (server's bounded-index normalization
   * drifts a few positions from the paginated one). So instead of searching
   * only inside the anchor, pick the highlight range physically NEAREST the
   * anchor and scroll to it — the real match is loaded and highlighted, just
   * not necessarily in `el`.
   */
  _revealNearest(el) {
    this.applyHighlightLayer();
    const ranges = this._highlightRanges;
    if (!ranges || !ranges.length) { if (el) el.scrollIntoView({ block: 'center' }); return; }
    // Prefer a match INSIDE the anchor message — that's where the server located
    // the hit (a visible copy of the query in a neighbouring message must not
    // win). Fall back to the physically nearest MEASURABLE one (ranges inside
    // collapsed cards report useless rects).
    let best = el ? ranges.findIndex(r => el.contains(r.startContainer)) : -1;
    if (best < 0) {
      const listRect = this._messageList.getBoundingClientRect();
      let anchorY = listRect.top + listRect.height / 2;
      if (el) { const r = el.getBoundingClientRect(); anchorY = r.top + r.height / 2; }
      let bestD = Infinity;
      for (let i = 0; i < ranges.length; i++) {
        const rr = ranges[i].getBoundingClientRect();
        if (!rr.width && !rr.height) continue; // hidden (collapsed card) — unmeasurable
        const d = Math.abs((rr.top + rr.height / 2) - anchorY);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) best = 0;
    }
    this._setCurrentHighlight(best);
    this._scrollToRange(this._highlightRanges[best]);
  }

  /**
   * Bring a highlight range fully into view and flash it. Hard-won details:
   * (1) most tool cards are COLLAPSED <details> — the match's ancestor chain
   *     must be expanded first or nothing is visible;
   * (2) expanding a card fires its deferred re-highlight, which REPLACES the
   *     card's DOM and detaches our Range — every settle step re-acquires a
   *     live range (same message element) when that happens;
   * (3) a match can be scrolled off INSIDE a card both vertically (max-height)
   *     and horizontally (nowrap long lines) — nested containers scroll on
   *     both axes;
   * (4) content-visibility keeps recomputing heights ~1s after a slab loads —
   *     centering re-runs on rAF + timers.
   */
  _scrollToRange(range) {
    if (!range) return;
    this._lastRevealAt = Date.now();
    this._onNav?.();
    this._lastRevealRun = () => this._scrollToRange(range); // replayed after c-v restore
    const list = this._messageList;
    let node = range.startContainer;
    node = node.nodeType === 1 ? node : node.parentElement;
    const msgEl = node?.closest?.('.chat-msg') || null;
    let cur = range;
    this._expandRangeAncestors(cur);
    // Re-acquire a live range after the card interior was re-rendered (deferred
    // rehighlight on expand). The message element itself is stable.
    const reacquire = () => {
      if (cur.startContainer.isConnected) return true;
      this.applyHighlightLayer();
      const ranges = this._highlightRanges || [];
      const idx = msgEl ? ranges.findIndex(r => msgEl.contains(r.startContainer)) : -1;
      if (idx < 0) return false;
      cur = ranges[idx];
      this._setCurrentHighlight(idx);
      this._expandRangeAncestors(cur);
      return true;
    };
    const settle = () => {
      if (!reacquire()) return;
      this._scrollNestedIntoView(cur);
      const lr = list.getBoundingClientRect();
      const rc = cur.getBoundingClientRect();
      if (rc.width || rc.height) list.scrollTop += rc.top - lr.top - lr.height / 2;
    };
    let n = 0;
    const step = () => { settle(); if (++n < 12) requestAnimationFrame(step); };
    step();
    for (const d of [180, 400, 750]) setTimeout(settle, d);
    this._flashRange(() => cur);
  }

  /** Open every collapsed <details> above the range and force the message
   *  renderable — without this a match inside a collapsed tool card stays
   *  invisible no matter how much we scroll. */
  _expandRangeAncestors(range) {
    let el = range.startContainer;
    el = el.nodeType === 1 ? el : el.parentElement;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.tagName === 'DETAILS' && !n.open) n.open = true;
      if (n.classList?.contains('chat-msg')) n.style.contentVisibility = 'visible';
    }
  }

  /** Scroll every nested overflow:auto/scroll ancestor so `range` is visible
   *  within it — BOTH axes: vertically (max-height cards) and horizontally
   *  (nowrap code lines extend far past the card's right edge). The outer
   *  message list is handled separately. */
  _scrollNestedIntoView(range) {
    const probe = range.getBoundingClientRect();
    if (!probe.width && !probe.height) return; // still hidden — nothing to measure
    let el = range.startContainer;
    el = el.nodeType === 1 ? el : el.parentElement;
    for (; el && el !== this._messageList && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const canV = el.scrollHeight > el.clientHeight + 4 && (cs.overflowY === 'auto' || cs.overflowY === 'scroll');
      const canH = el.scrollWidth > el.clientWidth + 4 && (cs.overflowX === 'auto' || cs.overflowX === 'scroll');
      if (!canV && !canH) continue;
      const er = el.getBoundingClientRect();
      if (canV) {
        const rc = range.getBoundingClientRect();
        el.scrollTop += (rc.top - er.top) - (el.clientHeight - rc.height) / 2;
      }
      if (canH) {
        const rc = range.getBoundingClientRect();
        // only when actually outside the horizontal viewport (don't jiggle wrapped text)
        if (rc.left < er.left + 4 || rc.right > er.left + el.clientWidth - 4) {
          el.scrollLeft += (rc.left - er.left) - (el.clientWidth - rc.width) / 2;
        }
      }
    }
  }

  /** Pulse an overlay on the current match so the eye lands on it immediately,
   *  even when it's buried in a long card. Takes a GETTER because the range can
   *  be re-acquired mid-flight (card re-render); tracks it for ~1.2s so it
   *  stays glued while the view settles. Hidden while the match is clipped by
   *  the list OR by any inner scroll container. */
  _flashRange(getRange) {
    if (this._flashEl) { this._flashEl.remove(); this._flashEl = null; }
    const flash = document.createElement('div');
    flash.className = 'chat-search-flash';
    // Parent inside the chat window (absolute coords relative to the positioned
    // ancestor) — a body-level fixed overlay would draw OVER other windows
    // stacked on top of this one.
    const host = this._messageList.offsetParent || document.body;
    host.appendChild(flash);
    this._flashEl = flash;
    const list = this._messageList;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const tick = () => {
      if (flash !== this._flashEl) return;               // superseded by a newer flash
      const range = typeof getRange === 'function' ? getRange() : getRange;
      let visible = false, rc = null;
      if (range && range.startContainer.isConnected) {
        rc = range.getBoundingClientRect();
        const lr = list.getBoundingClientRect();
        visible = (rc.width || rc.height) && rc.bottom > lr.top && rc.top < lr.bottom;
        if (visible) {
          // also hidden if clipped inside a nested scroll container
          let el = range.startContainer;
          el = el.nodeType === 1 ? el : el.parentElement;
          for (; el && el !== list && el !== document.body; el = el.parentElement) {
            const cs = getComputedStyle(el);
            if (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowX === 'auto' || cs.overflowX === 'scroll') {
              const er = el.getBoundingClientRect();
              if (rc.bottom < er.top || rc.top > er.bottom || rc.right < er.left || rc.left > er.right) { visible = false; break; }
            }
          }
        }
      }
      flash.style.display = visible ? 'block' : 'none';
      if (visible) {
        const hr = host.getBoundingClientRect();
        flash.style.left = (rc.left - hr.left + host.scrollLeft - 5) + 'px';
        flash.style.top = (rc.top - hr.top + host.scrollTop - 3) + 'px';
        flash.style.width = (rc.width + 10) + 'px';
        flash.style.height = (rc.height + 6) + 'px';
      }
      const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      if (elapsed < 1200) requestAnimationFrame(tick);
      else { flash.remove(); if (this._flashEl === flash) this._flashEl = null; }
    };
    tick();
  }

  async _jumpToSearchResult(idx) {
    const results = this._serverSearchResults;
    if (!results || idx < 0 || idx >= results.length) return;

    // Full-file mode (huge sessions): matches carry {line, ts} instead of a
    // window index — delegate the seek/scroll to ChatView, then reveal the
    // nearest highlight (the anchor may be a couple messages off the match).
    if (this._fullFileMode) {
      const el = await this._jumpToFileMatch(results[idx]);
      // Expand the anchor and its neighbours so a match in an adjacent
      // (collapsed) tool card can still be highlighted + scrolled to.
      this._expandEl(el);
      if (el) {
        let sib = el.previousElementSibling, n = 0;
        while (sib && n < 3) { this._expandEl(sib); sib = sib.previousElementSibling; n++; }
        sib = el.nextElementSibling; n = 0;
        while (sib && n < 3) { this._expandEl(sib); sib = sib.nextElementSibling; n++; }
      }
      this._revealNearest(el);
      return;
    }

    const msgIndex = results[idx].index;
    const { windowStart, windowEnd } = this._getWindowBounds();

    // Jump window if target is outside
    if (msgIndex < windowStart || msgIndex >= windowEnd) {
      await this._jumpToIndex(msgIndex);
    }

    // Expand collapsed content in target, then refresh highlight layer.
    // Gap-loaded messages (.chat-gap-msg) are IN the DOM but NOT in the
    // window index space — including them here shifted relIdx onto the wrong
    // element whenever the user had loaded part of the elided middle.
    const { windowStart: newStart } = this._getWindowBounds();
    const relIdx = msgIndex - newStart;
    const allMsgs = this._messageList.querySelectorAll('.chat-msg:not(.chat-gap-msg)');
    const targetEl = (relIdx >= 0 && relIdx < allMsgs.length) ? allMsgs[relIdx] : null;
    this._expandEl(targetEl);
    this._revealInEl(targetEl);
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
    // Re-assert the "current" highlight. applyHighlightLayer is re-run by
    // scroll-driven paths (_extendBottom, _reportVisibleTsRange, jumpToIndex)
    // AFTER a jump set the current match — without this the current highlight
    // silently vanishes whenever a jump happens to land near a load boundary.
    if (this._currentAnchor) {
      const { node, offset } = this._currentAnchor;
      const match = ranges.find(r => r.startContainer === node && r.startOffset === offset);
      if (match) CSS.highlights.set('chat-search-current', new Highlight(match));
    }
  }

  /** Highlight a specific range as "current" (for search navigation) */
  _setCurrentHighlight(rangeIdx) {
    if (!CSS.highlights || !this._highlightRanges) return;
    CSS.highlights.delete('chat-search-current');
    if (rangeIdx >= 0 && rangeIdx < this._highlightRanges.length) {
      const range = this._highlightRanges[rangeIdx];
      CSS.highlights.set('chat-search-current', new Highlight(range));
      // Anchor to the underlying DOM node+offset so applyHighlightLayer can
      // recover the current highlight after it rebuilds the range list.
      this._currentAnchor = { node: range.startContainer, offset: range.startOffset };
    }
  }

  _clearHighlightLayer() {
    this._highlightQuery = '';
    this._highlightRanges = [];
    this._currentAnchor = null;
    if (CSS.highlights) {
      CSS.highlights.delete('chat-search');
      CSS.highlights.delete('chat-search-current');
    }
  }

  _searchNav(dir) {
    const results = this._serverSearchResults;
    if (!results || !results.length) return;
    this._searchResultIdx = (this._searchResultIdx + dir + results.length) % results.length;
    this._updateSearchStatus();
    this._jumpToSearchResult(this._searchResultIdx);
  }

  _clearSearch() {
    // Cancel a pending debounced search too — else pressing Escape within 250ms
    // of typing runs the search with the bar hidden, jumping the view and leaving
    // highlights that re-paint on every scroll with no UI to clear them.
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    this._searchAbort?.abort();          // stop any in-flight streaming search
    this._searching = false;
    if (this._flashEl) { this._flashEl.remove(); this._flashEl = null; }
    this._clearHighlightLayer();
    this._serverSearchResults = [];
    this._searchResultIdx = -1;
    this._searchQuery = '';
    if (this._searchStatus) this._searchStatus.textContent = '';
  }

  /** Clean up timers */
  dispose() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchAbort?.abort();
    if (this._flashEl) { this._flashEl.remove(); this._flashEl = null; }
    this._clearHighlightLayer();
  }
}

export { ChatSearch };
