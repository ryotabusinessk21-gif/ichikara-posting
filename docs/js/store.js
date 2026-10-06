// 共有データの同期。操作は先に手元に反映して送信待ちに入れ、まとめて送る。電波がなければためておく。
import { reduce } from './plan.js';

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 容量・プライベートモード */ } },
};

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export class Store {
  constructor(gasUrl, { onChange, onStatus } = {}) {
    this.url = gasUrl;
    this.onChange = onChange || (() => {});
    this.onStatus = onStatus || (() => {});
    this.server = LS.get('srv_events', []);
    this.rev = LS.get('srv_rev', 0);
    this.queue = LS.get('pq', []);
    this.state = reduce([...this.server, ...this.queue]);
    this.busy = false;
    this.timer = null;
    this.lastOk = null;
    this.error = null;
  }

  get key() { return LS.get('k', ''); }
  set key(v) { LS.set('k', v); }
  get me() { return LS.get('me', ''); }
  set me(v) { LS.set('me', v); }

  recompute() {
    this.state = reduce([...this.server, ...this.queue]);
    this.onChange(this.state);
  }

  /** 操作を追加（すぐ手元に反映） */
  push(type, target, value = '', data = '', person = null) {
    const e = { eid: uuid(), cts: Date.now(), person: person || this.me || 'A', type, target: String(target), value: String(value),
      data: typeof data === 'string' ? data : JSON.stringify(data) };
    this.queue.push(e);
    LS.set('pq', this.queue);
    this.recompute();
    this.scheduleFlush();
    return e;
  }

  pushMany(list) {
    for (const [type, target, value, data] of list) {
      this.queue.push({ eid: uuid(), cts: Date.now(), person: this.me || 'A', type, target: String(target),
        value: String(value ?? ''), data: data == null ? '' : (typeof data === 'string' ? data : JSON.stringify(data)) });
    }
    LS.set('pq', this.queue);
    this.recompute();
    this.scheduleFlush();
  }

  scheduleFlush(ms = 800) {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), ms);
  }

  status() {
    this.onStatus({ pending: this.queue.length, error: this.error, lastOk: this.lastOk, offline: !navigator.onLine });
  }

  async get(since) {
    const q = `${this.url}?k=${encodeURIComponent(this.key)}&since=${since}`;
    try {
      const r = await fetch(q, { method: 'GET' });
      return await r.json();
    } catch {
      return await jsonp(q); // 失敗したら JSONP で取り直す
    }
  }

  async pull() {
    if (!this.url || !this.key) return;
    const j = await this.get(this.rev);
    if (!j.ok) { this.error = j.error || 'error'; this.status(); return j; }
    if (j.events.length) {
      this.server.push(...j.events);
      const seen = new Set(this.server.map((e) => e.eid));
      this.queue = this.queue.filter((e) => !seen.has(e.eid)); // 送信済みで反映されたものは送信待ちから外す
      LS.set('pq', this.queue);
    }
    this.rev = j.rev;
    LS.set('srv_events', this.server);
    LS.set('srv_rev', this.rev);
    this.error = null;
    this.lastOk = new Date();
    this.recompute();
    this.status();
    return j;
  }

  async flush() {
    if (this.busy || !this.queue.length || !this.url || !this.key) { this.status(); return; }
    this.busy = true;
    const batch = this.queue.slice(0, 200);
    try {
      const r = await fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ k: this.key, events: batch }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'error');
      this.error = null;
      this.busy = false;
      await this.pull(); // 自分の送信分も server 側の列として取り込む
      if (this.queue.length) this.scheduleFlush(300);
    } catch (err) {
      this.busy = false;
      this.error = navigator.onLine ? String(err.message || err) : 'offline';
      this.status();
      this.scheduleFlush(15000);
    }
  }

  start(intervalMs = 20000) {
    const tick = () => { if (document.visibilityState === 'visible') { this.pull().catch(() => {}); this.flush(); } };
    clearInterval(this.timer);
    this.timer = setInterval(tick, intervalMs);
    addEventListener('online', tick);
    document.addEventListener('visibilitychange', tick);
    return this.pull();
  }
}

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = '__jp' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 15000);
    function cleanup() { clearTimeout(t); delete window[cb]; s.remove(); }
    window[cb] = (data) => { cleanup(); resolve(data); };
    s.onerror = () => { cleanup(); reject(new Error('jsonp')); };
    s.src = `${url}&callback=${cb}`;
    document.head.appendChild(s);
  });
}
