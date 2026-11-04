// Pollers for Renfe's official GTFS-Realtime feeds (gtfsrt.renfe.com, CC BY 4.0).
//
// Renfe republishes the vehicle-position files every ~15 s (AV/LD/MD) and ~20 s (Cercanías).
// We poll much faster than that with conditional requests (If-None-Match / If-Modified-Since):
// an unchanged file costs a 304 with no body, and a new file is picked up within POLL_MS of
// being published instead of up to a whole publish interval later.

import { EventEmitter } from 'node:events';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import * as clock from './clock.mjs';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

export const FEEDS = [
  { id: 'ld_vp', net: 'ld', kind: 'vp', label: 'AV · LD · MD positions', url: 'https://gtfsrt.renfe.com/vehicle_positions_LD.pb', pollMs: 2000 },
  { id: 'cer_vp', net: 'cer', kind: 'vp', label: 'Cercanías positions', url: 'https://gtfsrt.renfe.com/vehicle_positions.pb', pollMs: 2000 },
  { id: 'ld_tu', net: 'ld', kind: 'tu', label: 'AV · LD · MD delays', url: 'https://gtfsrt.renfe.com/trip_updates_LD.pb', pollMs: 5000 },
  { id: 'cer_tu', net: 'cer', kind: 'tu', label: 'Cercanías delays', url: 'https://gtfsrt.renfe.com/trip_updates.pb', pollMs: 5000 },
];

export class FeedPoller extends EventEmitter {
  constructor(feeds = FEEDS) {
    super();
    this.state = new Map(feeds.map((f) => [f.id, {
      ...f, etag: null, lastModified: null, publishedAt: null, receivedAt: null,
      lastPollAt: null, polls: 0, changes: 0, notModified: 0, errors: 0, lastError: null,
      intervals: [], entities: 0, bytes: 0, headerTs: null,
    }]));
  }

  start() {
    for (const s of this.state.values()) this._loop(s);
  }

  async _loop(s) {
    const t0 = Date.now();
    try { await this._poll(s); }
    catch (e) { s.errors++; s.lastError = e.message; }
    const wait = Math.max(250, s.pollMs - (Date.now() - t0));
    setTimeout(() => this._loop(s), wait);
  }

  async _poll(s) {
    const headers = { 'User-Agent': 'spain-rail-radar-prototype/0.1', 'Cache-Control': 'no-cache' };
    if (s.etag) headers['If-None-Match'] = s.etag;
    if (s.lastModified) headers['If-Modified-Since'] = s.lastModified;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let res;
    const sentAt = Date.now();
    try { res = await fetch(s.url, { headers, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    clock.observe(res.headers.get('date'), sentAt, Date.now());
    s.polls++;
    s.lastPollAt = clock.now();
    if (res.status === 304) { s.notModified++; return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const etag = res.headers.get('etag');
    const lm = res.headers.get('last-modified');
    if (etag && etag === s.etag) { s.notModified++; return; } // server ignored conditional headers
    const msg = FeedMessage.decode(buf);
    const receivedAt = clock.now();
    // Publish time = HTTP Last-Modified. The AV/LD position feed's own header timestamp is
    // consistently one hour behind (timezone bug upstream), so it is only kept for display.
    const publishedAt = lm ? Date.parse(lm) : receivedAt;
    if (s.publishedAt) {
      s.intervals.push((publishedAt - s.publishedAt) / 1000);
      if (s.intervals.length > 20) s.intervals.shift();
    }
    s.etag = etag; s.lastModified = lm;
    s.publishedAt = publishedAt; s.receivedAt = receivedAt;
    s.changes++; s.lastError = null;
    s.entities = msg.entity.length; s.bytes = buf.length;
    s.headerTs = Number(msg.header?.timestamp || 0) * 1000 || null;
    this.emit('message', { feed: s, msg, publishedAt, receivedAt });
  }

  status() {
    const now = clock.now();
    return [...this.state.values()].map((s) => {
      const iv = s.intervals.filter((x) => x > 0);
      return {
        id: s.id, label: s.label, kind: s.kind, net: s.net,
        pollMs: s.pollMs,
        publishedAgo: s.publishedAt ? (now - s.publishedAt) / 1000 : null,
        pickupDelay: s.publishedAt && s.receivedAt ? (s.receivedAt - s.publishedAt) / 1000 : null,
        cadence: iv.length ? iv.reduce((a, b) => a + b, 0) / iv.length : null,
        headerSkew: s.headerTs && s.publishedAt ? (s.headerTs - s.publishedAt) / 1000 : null,
        entities: s.entities, bytes: s.bytes, polls: s.polls, changes: s.changes,
        notModified: s.notModified, errors: s.errors, lastError: s.lastError,
      };
    });
  }
}
