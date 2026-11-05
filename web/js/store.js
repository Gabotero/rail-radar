// Live state from the server stream + per-frame dead reckoning along each train's track path.

import { cumulative, along, dist } from '/shared/geo.mjs';

const MAX_DR_S = 90;    // same as the server: never extrapolate a fix further than this
const STALE_S = 180;
const SMOOTH_MS = 900;  // how long a correction takes to blend in when a new fix arrives

export class Store extends EventTarget {
  constructor() {
    super();
    this.trains = new Map();
    this.conflicts = [];
    this.conflictLevelByTrain = new Map();
    this.feeds = [];
    this.status = null;
    this.offset = 0;
    this.offsetSet = false;
    this.connected = false;
    this.filters = { hs: true, ld: true, md: true, cer: true };
    // Which kinds of warning are listed (crossings on double track are off by default).
    this.warnTypes = { following: true, opposing: true, converging: true, passing: false };
    this.query = '';
    this.focus = null;     // the warning the user clicked: its two trains are highlighted
    this.focusLive = false; // false once the engine no longer reports it
    this.selectedId = null;
    this.lastMsgAt = 0;
  }

  connect() {
    if (!this._resume) {
      // a phone drops the stream while the page is in the background: pick it up again on return
      this._resume = () => {
        if (document.visibilityState === 'visible' && this.es && (this.es.readyState === EventSource.CLOSED || performance.now() - this.lastMsgAt > 15000)) this.connect();
      };
      document.addEventListener('visibilitychange', this._resume);
    }
    this.es?.close();
    const es = this.es = new EventSource('/api/stream');
    const on = (name, fn) => es.addEventListener(name, (e) => { this.lastMsgAt = performance.now(); fn(JSON.parse(e.data)); });
    es.onopen = () => { this.connected = true; this.emit('connection'); };
    es.onerror = () => { this.connected = false; this.emit('connection'); };
    on('hello', (m) => { this.rules = m.rules; this._clock(m.serverTime); });
    on('trains', (m) => this._onTrains(m));
    on('conflicts', (m) => {
      this._clock(m.serverTime);
      this.conflicts = m.conflicts;
      this.engine = m.stats;
      this._indexConflicts();
      this.emit('conflicts');
    });
    on('status', (m) => { this._clock(m.serverTime); this.status = m; this.emit('status'); });
  }

  emit(name) { this.dispatchEvent(new Event(name)); }

  _clock(serverTime) {
    const o = serverTime - Date.now();
    this.offset = this.offsetSet ? this.offset * 0.8 + o * 0.2 : o;
    this.offsetSet = true;
  }

  serverNow() { return Date.now() + this.offset; }

  _onTrains({ net, serverTime, trains }) {
    this._clock(serverTime);
    const now = this.serverNow();
    const pnow = performance.now();
    const ids = new Set();
    for (const d of trains) {
      ids.add(d.id);
      let t = this.trains.get(d.id);
      if (!t) { t = { id: d.id }; this.trains.set(d.id, t); }
      const prev = t.disp;
      t.d = d;
      t.cum = cumulative(d.path);
      if (prev) {
        const est = this.estimate(t, now);
        const gap = dist(prev.lon, prev.lat, est.lon, est.lat);
        if (gap > 0.5 && gap < 3000) {
          t.corr = { dlon: prev.lon - est.lon, dlat: prev.lat - est.lat, dbrg: ((prev.bearing - est.bearing + 540) % 360) - 180, t0: pnow };
        }
      }
    }
    for (const [id, t] of this.trains) if (t.d.net === net && !ids.has(id)) this.trains.delete(id);
    if (this.selectedId && !this.trains.has(this.selectedId)) this.select(null);
    this.emit('trains');
  }

  /** Dead-reckoned position: last fix + speed × elapsed time, along the traced track path. */
  estimate(t, now) {
    const d = t.d;
    const age = (now - d.t) / 1000;
    const dt = Math.max(0, Math.min(MAX_DR_S, age));
    const v = d.speed || 0;
    const [lon, lat, brg] = along(d.path, t.cum, v * dt);
    return { lon, lat, bearing: v > 0.5 ? brg : d.heading, age, stale: age > STALE_S || d.src === 'placeholder', s: v * dt };
  }

  updateDisplay() {
    const now = this.serverNow();
    const pnow = performance.now();
    for (const t of this.trains.values()) this._updateOne(t, now, pnow);
  }

  /** Bring one train's display position to "now" (the follow camera uses it before the frame is drawn). */
  updateOne(id) {
    const t = this.trains.get(id);
    if (t) this._updateOne(t, this.serverNow(), performance.now());
    return t;
  }

  _updateOne(t, now, pnow) {
    const e = this.estimate(t, now);
    if (t.corr) {
      const k = Math.exp(-(pnow - t.corr.t0) / (SMOOTH_MS / 3));
      if (k < 0.01) t.corr = null;
      else { e.lon += t.corr.dlon * k; e.lat += t.corr.dlat * k; e.bearing = (e.bearing + t.corr.dbrg * k + 360) % 360; }
    }
    t.disp = e;
  }

  isVisible(t) {
    if (this.isFocused(t.id)) return true; // the two trains of the focused warning are always shown
    const d = t.d;
    if (d.dup || !this.filters[d.cat]) return false;
    return this._matches(d);
  }

  _matches(d) {
    if (!this.query) return true;
    const q = this.query;
    return [d.num, d.line, d.product, d.from, d.to].some((s) => s && String(s).toLowerCase().includes(q));
  }

  // ---------- warnings: filters and focus ----------
  /** A warning is listed when its kind is switched on and at least one of its trains passes the network filters / search. */
  conflictVisible(c) {
    if (this.focus && c.key === this.focus.key) return true;
    if (!this.warnTypes[c.type]) return false;
    const ok = (id) => { const d = this.trains.get(id)?.d; return !!d && this.filters[d.cat] && this._matches(d); };
    return ok(c.a) || ok(c.b);
  }

  visibleConflicts() { return this.conflicts.filter((c) => this.conflictVisible(c)); }

  _indexConflicts() {
    const by = new Map();
    const rank = { critical: 0, warning: 1, watch: 2, info: 3 };
    for (const c of this.conflicts) {
      if (c.level === 'info' || !this.conflictVisible(c)) continue;
      for (const id of [c.a, c.b]) if (!by.has(id) || rank[c.level] < rank[by.get(id)]) by.set(id, c.level);
    }
    this.conflictLevelByTrain = by;
    if (this.focus) {
      const live = this.conflicts.find((c) => c.key === this.focus.key);
      this.focusLive = !!live;
      if (live) this.focus = live;
    }
  }

  setFilter(cat, on) { this.filters[cat] = on; this._indexConflicts(); this.emit('filters'); }
  setWarnType(type, on) { this.warnTypes[type] = on; this._indexConflicts(); this.emit('filters'); }
  setQuery(q) { this.query = q; this._indexConflicts(); this.emit('filters'); }

  setFocus(c) {
    this.focus = c || null;
    this.focusLive = !!c;
    this._indexConflicts();
    this.emit('focus');
  }

  isFocused(id) { return !!this.focus && (this.focus.a === id || this.focus.b === id); }

  select(id) {
    if (this.focus && !this.isFocused(id)) this.setFocus(null);
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit('select');
  }

  counts() {
    const c = { hs: 0, ld: 0, md: 0, cer: 0 };
    for (const t of this.trains.values()) if (!t.d.dup && c[t.d.cat] != null) c[t.d.cat]++;
    return c;
  }
}
