class WsManager {
  constructor() {
    this.ws = null; this.handlers = new Map(); this.globalHandlers = []; this.pending = [];
    this.connect();
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws.onopen = () => { for (const m of this.pending) this.ws.send(m); this.pending = []; };
    this.ws.onmessage = (e) => {
      let d; try { d = JSON.parse(e.data); } catch { return; }
      if (d.sessionId) (this.handlers.get(d.sessionId) || []).forEach(h => h(d));
      this.globalHandlers.forEach(h => h(d));
    };
    this.ws.onclose = () => setTimeout(() => this.connect(), 2000);
    this.ws.onerror = () => {};
  }
  send(d) { const m = JSON.stringify(d); this.ws?.readyState === 1 ? this.ws.send(m) : this.pending.push(m); }
  on(sid, h) { if (!this.handlers.has(sid)) this.handlers.set(sid, []); this.handlers.get(sid).push(h); }
  off(sid) { this.handlers.delete(sid); }
  onGlobal(h) { this.globalHandlers.push(h); }
  offGlobal(h) { const i = this.globalHandlers.indexOf(h); if (i >= 0) this.globalHandlers.splice(i, 1); }
}

export { WsManager };
