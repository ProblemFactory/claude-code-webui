/**
 * MessageStore — client-side normalized message store.
 *
 * Holds the canonical message list (NormalizedMessages), processes
 * create/edit/delete ops from the server, and notifies the view layer.
 *
 * The view layer (ChatViewV2) subscribes via .on('create'|'edit'|'delete'|'meta', handler).
 * It never modifies messages directly — all mutations come from server ops.
 */
class MessageStore {
  constructor() {
    this._messages = [];              // ordered list
    this._index = new Map();          // id → message
    this._posIndex = new Map();       // id → position in _messages array
    this._listeners = new Map();      // event → [handler]
    this._total = 0;                  // server-reported total (for pagination)
    this._windowStart = 0;            // offset of first loaded message in server's full list
  }

  /** Initialize from attach response (batch load) */
  init(messages, total) {
    this._messages = [];
    this._index.clear();
    this._posIndex.clear();
    this._total = total || messages.length;
    this._windowStart = this._total - messages.length;
    for (const msg of messages) {
      this._messages.push(msg);
      this._index.set(msg.id, msg);
      this._posIndex.set(msg.id, this._messages.length - 1);
    }
    this._emit('batch', { messages: this._messages, total: this._total });
  }

  /** Prepend older messages (from pagination scroll-up) */
  prepend(messages, newStart) {
    const old = this._messages;
    this._messages = [...messages, ...old];
    // Rebuild position index
    this._posIndex.clear();
    for (let i = 0; i < this._messages.length; i++) {
      const m = this._messages[i];
      this._index.set(m.id, m);
      this._posIndex.set(m.id, i);
    }
    this._windowStart = newStart;
    this._emit('prepend', { messages, count: messages.length });
  }

  /** Process a server op */
  applyOp(op) {
    switch (op.op) {
      case 'create': {
        const msg = op.message;
        this._messages.push(msg);
        this._index.set(msg.id, msg);
        this._posIndex.set(msg.id, this._messages.length - 1);
        this._total++;
        this._emit('create', msg);
        break;
      }
      case 'edit': {
        const existing = this._index.get(op.id);
        if (!existing) return;
        // Merge fields into existing message
        Object.assign(existing, op.fields);
        this._emit('edit', { id: op.id, fields: op.fields, message: existing });
        break;
      }
      case 'delete': {
        const idx = this._posIndex.get(op.id);
        if (idx === undefined) return;
        this._messages.splice(idx, 1);
        this._index.delete(op.id);
        // Rebuild position index after splice
        this._posIndex.clear();
        for (let i = 0; i < this._messages.length; i++) {
          this._posIndex.set(this._messages[i].id, i);
        }
        this._total--;
        this._emit('delete', { id: op.id, index: idx });
        break;
      }
      case 'meta': {
        this._emit('meta', op);
        break;
      }
    }
  }

  // ── Accessors ──

  get messages() { return this._messages; }
  get total() { return this._total; }
  get windowStart() { return this._windowStart; }
  get windowEnd() { return this._windowStart + this._messages.length; }
  get length() { return this._messages.length; }

  get(id) { return this._index.get(id); }
  at(index) { return this._messages[index]; }
  last() { return this._messages[this._messages.length - 1]; }

  /** Can we load more (scroll up)? */
  get hasMore() { return this._windowStart > 0; }

  // ── Events ──

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(handler);
  }

  off(event, handler) {
    const arr = this._listeners.get(event);
    if (arr) { const i = arr.indexOf(handler); if (i >= 0) arr.splice(i, 1); }
  }

  _emit(event, data) {
    const arr = this._listeners.get(event);
    if (arr) for (const h of arr) h(data);
  }
}

export { MessageStore };
