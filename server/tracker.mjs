// Turns raw GPS fixes into tracked trains: snapped to the track, with speed and heading
// estimated from consecutive fixes (Renfe's feeds carry neither), and a traced path ahead
// along the rails that is used both for animation and for conflict prediction.

import { EventEmitter } from 'node:events';
import { dist, bearing, angleDiff, cumulative, along, simplifyFlat, offset } from '../shared/geo.mjs';

export const CFG = {
  MAX_SNAP_M: 80,          // GPS fix further than this from any track = not snapped
  PATH_HORIZON_S: 240,     // how far ahead (in time at current speed) the path is traced
  MAX_DEAD_RECKON_S: 90,   // never extrapolate a fix further than this
  STALE_S: 180,            // fix older than this = stale
  // Max plausible speed per category (m/s). Samples above 1.25x this are GPS jumps / fallbacks.
  CAT_MAX_MS: { hs: 85, ld: 70, md: 45, cer: 39 },
  MIN_SAMPLE_DT_S: 5,      // ignore speed samples from fixes closer than this in time
  STILL_DECAY_S: 45,       // position unchanged this long while "in transit" -> treat as stopped
  GONE_S: 60,              // vehicle absent from its feed this long -> removed
  DUP_M: 2000,             // same vehicle number in both feeds within this distance = one train
  CONSIST_M: 30,           // two trip numbers reporting the same GPS position = coupled units of one train
  MOTION_M: 40,            // min displacement between fixes to trust the motion bearing (GPS jitter)
  MOTION_MAX_AGE_S: 900,   // last motion bearing stays valid this long (same trip only)
};

const STATUS = { 0: 'INCOMING_AT', 1: 'STOPPED_AT', 2: 'IN_TRANSIT_TO' };
// Median; with two samples the mean (taking the larger one would let a single GPS jump through).
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length === 2 ? (s[0] + s[1]) / 2 : s[s.length >> 1]; };
const toNum = (x) => (x == null ? 0 : typeof x === 'number' ? x : typeof x.toNumber === 'function' ? x.toNumber() : Number(x));
const r5 = (v) => Math.round(v * 1e5) / 1e5;

export class Tracker extends EventEmitter {
  constructor(rail, gtfs) {
    super();
    this.rail = rail;
    this.gtfs = gtfs;
    this.trains = new Map();
    this.delays = new Map(); // tripId -> { delay, at }
  }

  ingest({ feed, msg, publishedAt, receivedAt }) {
    if (feed.kind === 'vp') this._positions(feed.net, msg, publishedAt, receivedAt);
    else this._tripUpdates(msg, publishedAt);
  }

  _tripUpdates(msg, publishedAt) {
    for (const e of msg.entity) {
      const tu = e.tripUpdate;
      if (!tu?.trip?.tripId) continue;
      let delay = tu.delay != null ? toNum(tu.delay) : null;
      const stu = tu.stopTimeUpdate?.[0];
      if (delay == null && stu) delay = toNum(stu.arrival?.delay ?? stu.departure?.delay);
      const rel = tu.trip.scheduleRelationship; // 3 = CANCELED
      this.delays.set(tu.trip.tripId, { delay, canceled: rel === 3, at: publishedAt });
    }
  }

  _positions(net, msg, publishedAt, receivedAt) {
    const seen = new Set();
    for (const e of msg.entity) {
      const v = e.vehicle;
      if (!v?.position) continue;
      const lat = v.position.latitude, lon = v.position.longitude;
      if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) continue;
      const vid = v.vehicle?.id || e.id;
      const id = `${net}:${vid}`;
      seen.add(id);

      // Fix time: Cercanías vehicles carry their own GPS timestamp; AV/LD/MD do not,
      // so we use the file's publish time (an upper bound on the fix time).
      const vts = toNum(v.timestamp) * 1000;
      const fixT = vts && Math.abs(vts - receivedAt) < 10 * 60e3 ? Math.min(vts, receivedAt) : publishedAt;

      let tr = this.trains.get(id);
      if (!tr) {
        tr = { id, net, vid, fixes: [], speed: null, heading: null, lastMoveAt: fixT };
        this.trains.set(id, tr);
      }
      const label = v.vehicle?.label || '';
      tr.tripId = v.trip?.tripId || tr.tripId;
      tr.label = label;
      tr.platform = (label.match(/PLATF\.\(([^)]+)\)/) || [])[1] || null;
      tr.status = STATUS[v.currentStatus] || 'IN_TRANSIT_TO';
      tr.stopId = v.stopId || null;
      tr.seenAt = publishedAt;
      tr.receivedAt = receivedAt;
      if (!tr.info || tr.info._trip !== tr.tripId) tr.info = { ...this.gtfs.info(net, tr.tripId, label), _trip: tr.tripId };

      const last = tr.fixes[tr.fixes.length - 1];
      const moved = last ? dist(last.lon, last.lat, lon, lat) : Infinity;
      if (last && (moved < 2 || fixT <= last.t)) {
        // No new GPS fix in this publish. If it has been still for a while, it is stopped.
        if (publishedAt - tr.lastMoveAt > CFG.STILL_DECAY_S * 1000 || tr.status === 'STOPPED_AT') {
          if (tr.speed) { tr.speed = 0; tr.samples = [0]; this._buildPath(tr); }
        }
        continue;
      }

      // Speed: median of the last 3 fix-to-fix samples, capped per category. A single GPS jump
      // (or a position that falls back to station coordinates) can't produce a 200 km/h Cercanías.
      let motionBearing = null;
      if (last) {
        const dt = (fixT - last.t) / 1000;
        const catCap = CFG.CAT_MAX_MS[tr.info?.cat] || 88;
        // Track speed limit from OSM (when tagged, and the fix is clearly on that track) clamps the
        // value; jump rejection keeps using the category limit, so a mis-snap can't freeze the speed.
        const ts = tr.snap?.maxspeed > 0 && tr.snap.dist < 15 ? tr.snap.maxspeed / 3.6 : 0;
        const cap = ts ? Math.min(catCap, ts * 1.15 + 2) : catCap;
        if (dt >= CFG.MIN_SAMPLE_DT_S) {
          const vi = moved / dt;
          if (vi <= catCap * 1.25) {
            tr.samples = [...(tr.samples || []), Math.min(vi, cap)].slice(-3);
            tr.speed = median(tr.samples);
          } else {
            tr.jumps = (tr.jumps || 0) + 1;
          }
        }
        if (moved > CFG.MOTION_M && dt < 180) motionBearing = bearing(last.lon, last.lat, lon, lat);
      }
      if (tr.status === 'STOPPED_AT' && moved < 150) { tr.speed = 0; tr.samples = [0]; }
      if (moved >= 2) tr.lastMoveAt = fixT;
      const st = this.gtfs.stop(tr.stopId);
      tr.posSrc = st && dist(st.lon, st.lat, lon, lat) < 3 ? 'station' : 'gps';
      if (tr.speed > 0.5 || motionBearing != null) tr.movedOnTrip = tr.tripId;

      tr.fixes.push({ t: fixT, lon, lat });
      if (tr.fixes.length > 12) tr.fixes.shift();
      if (motionBearing != null) { tr.motionBearing = motionBearing; tr.motionAt = fixT; tr.motionTrip = tr.tripId; }
      this._locate(tr, lon, lat, fixT, motionBearing);
    }

    // Drop vehicles that have left this feed.
    for (const [id, tr] of this.trains) {
      if (tr.net === net && !seen.has(id) && publishedAt - tr.seenAt > CFG.GONE_S * 1000) this.trains.delete(id);
    }
    this._markDuplicates();
    this._markConsists();
    this.emit('trains', net);
  }

  /** Some trains are published in both feeds (e.g. Sevilla C3 / Regional Exprés 18779): keep the fresher one. */
  _markDuplicates() {
    const byVid = new Map();
    for (const tr of this.trains.values()) {
      tr.dup = false;
      if (!tr.fix) continue;
      (byVid.get(tr.vid) || byVid.set(tr.vid, []).get(tr.vid)).push(tr);
    }
    for (const group of byVid.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => b.fix.t - a.fix.t);
      for (const tr of group.slice(1)) {
        if (dist(tr.fix.lon, tr.fix.lat, group[0].fix.lon, group[0].fix.lat) < CFG.DUP_M) tr.dup = true;
      }
    }
  }

  /**
   * Direction of travel, best source first:
   *  1. motion between the last two fixes
   *  2. stopped (AV/LD/MD): direction of the next stop in the timetable
   *  3. last observed motion on this trip (recent)
   *  4. bearing to the "next stop" from the feed, only when it is far away: the feed's stop/status
   *     lags the GPS, so near a station it often still names the stop the train has just passed
   */
  _referenceBearing(tr, lon, lat, motionBearing, fixT) {
    if (motionBearing != null) return motionBearing;
    if (tr.status === 'STOPPED_AT' && tr.net === 'ld') {
      const nx = this.gtfs.stop(this.gtfs.nextStopAfter(tr.tripId, tr.stopId));
      if (nx && dist(lon, lat, nx.lon, nx.lat) > 300) return bearing(lon, lat, nx.lon, nx.lat);
    }
    if (tr.motionBearing != null && tr.motionTrip === tr.tripId && fixT - tr.motionAt < CFG.MOTION_MAX_AGE_S * 1000) return tr.motionBearing;
    if (tr.status !== 'STOPPED_AT') {
      const target = this.gtfs.stop(tr.stopId);
      if (target && dist(lon, lat, target.lon, target.lat) > 1500) return bearing(lon, lat, target.lon, target.lat);
    }
    return tr.heading;
  }

  /**
   * Placeholders: trains that are not running yet (or have no GPS) are published at a station's
   * coordinates, and every such train at that station gets exactly the same point (12 trains on
   * one point at L'Hospitalet). An exact shared point is therefore a placeholder unless one of
   * the trains is moving (then it is a coupled consist, handled below).
   * Coupled units: Renfe publishes each unit of a multiple-unit train under its own trip number
   * (e.g. R11 + RG1 joined at Girona, MD + Avant to Santiago) with the same GPS position.
   * They are grouped as one consist: same speed and direction, never a conflict with each other.
   */
  _markConsists() {
    const list = [];
    for (const tr of this.trains.values()) {
      tr.consist = null;
      if (tr.posSrc === 'placeholder') tr.posSrc = 'gps'; // re-evaluated below
      if (tr.fix && !tr.dup && tr.posSrc !== 'station') list.push(tr);
    }
    list.sort((a, b) => a.fix.rawLat - b.fix.rawLat);
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
    for (const t of list) parent.set(t, t);
    const dLat = CFG.CONSIST_M / 111000;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length && list[j].fix.rawLat - a.fix.rawLat < dLat; j++) {
        const b = list[j];
        if (Math.abs(a.fix.t - b.fix.t) > 10e3) continue;
        if (dist(a.fix.rawLon, a.fix.rawLat, b.fix.rawLon, b.fix.rawLat) > CFG.CONSIST_M) continue;
        parent.set(find(b), find(a));
      }
    }
    const groups = new Map();
    for (const t of list) { const r = find(t); (groups.get(r) || groups.set(r, []).get(r)).push(t); }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const moving = g.some((t) => t.movedOnTrip === t.tripId);
      if (g.length > 3 || !moving) { for (const t of g) t.posSrc = 'placeholder'; continue; }
      // The member with an observed motion bearing (then the most history) sets speed and direction.
      g.sort((a, b) => (b.motionBearing != null) - (a.motionBearing != null) || b.fixes.length - a.fixes.length);
      const lead = g[0];
      const key = g.map((t) => t.id).sort()[0];
      for (const t of g) {
        t.consist = key;
        if (t === lead) continue;
        t.speed = lead.speed; t.samples = lead.samples ? [...lead.samples] : t.samples;
        if (t.snap && lead.heading != null && angleDiff(t.heading, lead.heading) > 90) {
          t.dir = -t.dir; t.heading = (t.heading + 180) % 360;
        }
        this._buildPath(t);
      }
    }
  }

  _locate(tr, lon, lat, fixT, motionBearing) {
    const snap = this.rail.snap(lon, lat, CFG.MAX_SNAP_M);
    const ref = this._referenceBearing(tr, lon, lat, motionBearing, fixT);
    tr.snap = snap;
    if (snap) {
      const fwd = snap.bearing, back = (snap.bearing + 180) % 360;
      const dir = ref == null || angleDiff(fwd, ref) <= angleDiff(back, ref) ? 1 : -1;
      tr.dir = dir;
      tr.heading = dir > 0 ? fwd : back;
      tr.fix = { t: fixT, lon: snap.lon, lat: snap.lat, rawLon: lon, rawLat: lat, off: snap.dist };
      tr.tracks = this.rail.trackCount(snap.lon, snap.lat, tr.heading);
    } else {
      tr.heading = ref ?? tr.heading ?? 0;
      tr.fix = { t: fixT, lon, lat, rawLon: lon, rawLat: lat, off: null };
      tr.tracks = null;
    }
    this._buildPath(tr);
  }

  _buildPath(tr) {
    if (!tr.fix) return;
    const v = tr.speed || 0;
    const len = Math.min(25000, Math.max(1000, v * CFG.PATH_HORIZON_S + 1000));
    let flat;
    if (tr.snap) flat = this.rail.trace(tr.snap, tr.dir, len);
    else flat = [tr.fix.lon, tr.fix.lat, ...offset(tr.fix.lon, tr.fix.lat, tr.heading, len)];
    if (flat.length < 4) flat = [tr.fix.lon, tr.fix.lat, ...offset(tr.fix.lon, tr.fix.lat, tr.heading, 50)];
    tr.path = simplifyFlat(flat, 2);
    tr.cum = cumulative(tr.path); // must index the simplified path
  }

  /** Dead-reckoned ("now-cast") state of a train at time T (ms). */
  nowcast(tr, T) {
    const age = (T - tr.fix.t) / 1000;
    const dt = Math.max(0, Math.min(CFG.MAX_DEAD_RECKON_S, age));
    const s = (tr.speed || 0) * dt;
    const [lon, lat, brg] = along(tr.path, tr.cum, s);
    return { lon, lat, bearing: (tr.speed || 0) > 0.5 ? brg : tr.heading, s, age, stale: age > CFG.STALE_S };
  }

  serialize(tr, now) {
    const d = this.delays.get(tr.tripId);
    const i = tr.info || {};
    return {
      id: tr.id, net: tr.net, cat: i.cat, product: i.product, num: i.num, line: i.line, color: i.color,
      from: i.from, to: i.to, trip: tr.tripId,
      status: tr.status, stop: this.gtfs.stopName(tr.stopId), platform: tr.platform,
      lon: r5(tr.fix.lon), lat: r5(tr.fix.lat), rawLon: r5(tr.fix.rawLon), rawLat: r5(tr.fix.rawLat),
      off: tr.fix.off == null ? null : Math.round(tr.fix.off),
      snapped: !!tr.snap, cls: tr.snap?.cls || null, maxspeed: tr.snap?.maxspeed || null, tracks: tr.tracks,
      heading: Math.round(tr.heading ?? 0), speed: tr.speed == null ? null : Math.round(tr.speed * 10) / 10,
      t: tr.fix.t, seen: tr.seenAt, age: Math.round((now - tr.fix.t) / 1000),
      dup: !!tr.dup, src: tr.posSrc || 'gps', consist: tr.consist || null,
      delay: d?.delay ?? null, canceled: !!d?.canceled,
      path: tr.path.map(r5),
    };
  }

  list(net, now) {
    const out = [];
    for (const tr of this.trains.values()) if ((!net || tr.net === net) && tr.fix) out.push(this.serialize(tr, now));
    return out;
  }
}
