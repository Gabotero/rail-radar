// Trajectory conflict engine (prototype).
//
// Every second, each fresh train is dead-reckoned to "now" along its traced track path,
// then nearby pairs are classified:
//
//   following   B is ahead of A on A's track, same direction. Conflict when the gap is
//               (or will be, at current speeds) smaller than A's braking distance + margin.
//   opposing    A and B are on the same track heading towards each other. Only a conflict
//               if there is no second track (passing loop / double track) between them —
//               otherwise it is a normal crossing ("passing", info only).
//   converging  Paths cross at an angle (junctions, flat crossings) and both trains are
//               predicted within CONVERGE_M of each other within the horizon.
//
// Public data is 15–60 s old, has no speed field, ~10 m GPS error and no signalling state,
// so this is a monitoring aid, not a safety system.

import { dist, angleDiff, project, along } from '../shared/geo.mjs';

export const RULES = {
  HORIZON_S: 180,     // look-ahead
  STEP_S: 2,          // sampling step for converging paths
  BRAKE_MS2: 0.7,     // service-brake deceleration used for braking distance
  MARGIN_M: 200,      // safety margin added to braking distance
  WARN_S: 60,         // predicted breach within this -> warning (else watch)
  CORRIDOR_M: 12,     // max lateral offset (snapped positions) to count as "on the same track corridor":
                      // keeps adjacent tracks (~4 m) but separates parallel lines (HSL beside conventional)
  COUPLED_M: 60,      // same direction, same speed, closer than this = coupled units / renumbered unit
  CONVERGE_M: 50,
  MIN_MOVING_MS: 1,
  HOLD_S: 6,          // keep a conflict alive this long after it stops being detected
  MAX_DATA_AGE_S: 90, // ignore trains whose last fix is older than this
  LOW_CONF_AGE_S: 45, // above this, a warning can be at most "watch"
};

// Levels:
//   critical  the follower (or both opposing trains) could not stop within the current gap
//             even braking now, and the gap is closing
//   warning   separation is, or within WARN_S will be, below braking distance + margin
//   watch     same, but further out in the horizon — or low-confidence data
//   info      normal crossing on double track / passing loop
const LEVEL_RANK = { critical: 0, warning: 1, watch: 2, info: 3 };
const DOWNGRADE = { critical: 'warning', warning: 'watch', watch: 'watch', info: 'info' };
const brake = (v) => (v * v) / (2 * RULES.BRAKE_MS2);
function gaugeCompatible(g1, g2) {
  if (!g1 || !g2) return true; // unknown: assume it could be the same track
  const a = g1.split(';');
  return g2.split(';').some((g) => a.includes(g));
}
function severity(gap, brakingDist, ttb, closing) {
  if (gap < brakingDist && closing > 1) return 'critical';
  return ttb <= RULES.WARN_S ? 'warning' : 'watch';
}

export class ConflictEngine {
  constructor(tracker, rail) {
    this.tracker = tracker;
    this.rail = rail;
    this.active = new Map();
    this.stats = { trains: 0, pairs: 0, ms: 0 };
  }

  compute(now = Date.now()) {
    const t0 = performance.now();
    const states = [];
    for (const tr of this.tracker.trains.values()) {
      if (!tr.fix || !tr.path || tr.cum.length < 2 || tr.dup) continue;
      if (tr.posSrc === 'placeholder') continue; // not a real position
      const nc = this.tracker.nowcast(tr, now);
      if (nc.age > RULES.MAX_DATA_AGE_S) continue;
      states.push({ tr, ...nc, v: tr.speed || 0, reach: tr.cum[tr.cum.length - 1] });
    }

    // Spatial hash (~11 km cells) for neighbour search.
    const CELL = 0.1;
    const grid = new Map();
    for (const s of states) {
      const key = `${Math.floor(s.lon / CELL)},${Math.floor(s.lat / CELL)}`;
      (grid.get(key) || grid.set(key, []).get(key)).push(s);
    }

    let pairs = 0;
    const found = new Map();
    for (const a of states) {
      const cx = Math.floor(a.lon / CELL), cy = Math.floor(a.lat / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(`${cx + dx},${cy + dy}`);
        if (!cell) continue;
        for (const b of cell) {
          if (b.tr.id <= a.tr.id) continue;
          if (a.v < RULES.MIN_MOVING_MS && b.v < RULES.MIN_MOVING_MS) continue;
          const d0 = dist(a.lon, a.lat, b.lon, b.lat);
          if (d0 > Math.max(a.reach, b.reach) + RULES.CORRIDOR_M) continue;
          pairs++;
          if (a.tr.vid === b.tr.vid) continue;
          if (a.tr.consist && a.tr.consist === b.tr.consist) continue; // coupled units of one train
          const c = this._pair(a, b, d0);
          if (!c) continue;
          // Confidence: old fixes or positions that are just the station's coordinates.
          if (c.dataAge > RULES.LOW_CONF_AGE_S) { c.level = DOWNGRADE[DOWNGRADE[c.level]]; c.notes.push(`data ${c.dataAge} s old`); }
          if (a.tr.posSrc === 'station' || b.tr.posSrc === 'station') { c.level = DOWNGRADE[c.level]; c.notes.push('position = station coordinates, not GPS'); }
          if (!a.tr.snap || !b.tr.snap) { c.level = DOWNGRADE[c.level]; c.notes.push('not snapped to track'); }
          for (const s of [a, b]) if (s.tr.speed == null) c.notes.push(`${s.tr.info?.num || s.tr.vid}: speed not yet measured (single fix), assumed stopped`);
          c.confidence = c.notes.some((n) => /old|station|snapped|not yet measured/.test(n)) ? 'low' : 'normal';
          const prev = found.get(c.key);
          if (!prev || LEVEL_RANK[c.level] < LEVEL_RANK[prev.level]) found.set(c.key, c);
        }
      }
    }

    // Hysteresis so warnings don't flicker between updates.
    for (const [key, c] of found) {
      const prev = this.active.get(key);
      c.firstSeen = prev?.firstSeen ?? now;
      c.lastSeen = now;
      this.active.set(key, c);
    }
    for (const [key, c] of this.active) {
      if (!found.has(key)) {
        if (now - c.lastSeen > RULES.HOLD_S * 1000) this.active.delete(key);
        else c.fading = true;
      }
    }
    this.stats = { trains: states.length, pairs, ms: Math.round((performance.now() - t0) * 10) / 10 };
    return this.list();
  }

  list() {
    return [...this.active.values()].sort((x, y) => LEVEL_RANK[x.level] - LEVEL_RANK[y.level] || x.ttb - y.ttb);
  }

  /** Is `other` on `self`'s path ahead? */
  _ahead(self, other) {
    const p = project(self.tr.path, self.tr.cum, other.lon, other.lat, self.s);
    if (!p || p.lateral > RULES.CORRIDOR_M) return null;
    const gap = p.s - self.s;
    if (gap <= 0) return null;
    return { gap, rel: angleDiff(other.bearing, p.bearing), s: p.s };
  }

  _pair(a, b, d0) {
    // Different gauges can't share a track (Iberian 1668 / standard 1435 / metre 1000).
    if (!gaugeCompatible(a.tr.snap?.gauge, b.tr.snap?.gauge)) return null;
    // Coupled units, or one unit published under two trip numbers.
    if (d0 < RULES.COUPLED_M && Math.abs(a.v - b.v) < 3 && angleDiff(a.bearing, b.bearing) < 30) return null;

    const ab = this._ahead(a, b); // b ahead of a on a's track
    const ba = this._ahead(b, a);

    // Following: same direction on the same track.
    const fol = ab && ab.rel < 45 ? { f: a, l: b, gap: ab.gap } : ba && ba.rel < 45 ? { f: b, l: a, gap: ba.gap } : null;
    if (fol) return this._following(fol.f, fol.l, fol.gap);

    // Opposing: heading towards each other on the same track.
    const opp = ab && ab.rel > 135 ? { x: a, y: b, gap: ab.gap } : ba && ba.rel > 135 ? { x: b, y: a, gap: ba.gap } : null;
    if (opp) return this._opposing(opp.x, opp.y, opp.gap);

    if (!ab && !ba) return this._converging(a, b, d0);
    return null;
  }

  _base(type, a, b, extra) {
    // Keyed by consist, so a coupled train (two trip numbers) is reported once.
    const ka = a.tr.consist || a.tr.id, kb = b.tr.consist || b.tr.id;
    return {
      key: ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`, type, a: a.tr.id, b: b.tr.id,
      aPos: [a.lon, a.lat], bPos: [b.lon, b.lat],
      dataAge: Math.round(Math.max(a.age, b.age)),
      ...extra,
    };
  }

  _following(f, l, gap) {
    // Different platforms at the same station: not a conflict.
    if (l.tr.status === 'STOPPED_AT' && f.tr.stopId && f.tr.stopId === l.tr.stopId &&
        f.tr.platform && l.tr.platform && f.tr.platform !== l.tr.platform) return null;
    const bd = brake(f.v);
    const req = bd + RULES.MARGIN_M;
    const closing = f.v - l.v;
    let ttb;
    if (gap < req) ttb = 0;
    else if (closing > 0.3) ttb = (gap - req) / closing;
    else return null;
    if (ttb > RULES.HORIZON_S) return null;
    let level = severity(gap, bd, ttb, closing);
    const notes = [];
    if (gap < req && closing <= 0) { level = 'watch'; notes.push('separation below braking distance but opening'); }
    const tracks = this.rail.trackCount(l.lon, l.lat, l.bearing);
    if (tracks >= 3) { level = DOWNGRADE[level]; notes.push(`${tracks} parallel tracks: may be on a different track`); }
    if (l.tr.status === 'STOPPED_AT' && f.tr.stopId === l.tr.stopId) notes.push('approaching an occupied station');
    return this._base('following', f, l, {
      level, ttb: Math.round(ttb), gap: Math.round(gap), req: Math.round(req),
      closing: Math.round(closing * 10) / 10, tracks, notes,
      point: [l.lon, l.lat],
    });
  }

  _opposing(x, y, gap) {
    const closing = x.v + y.v;
    if (closing < 0.3) return null;
    const meet = gap / closing;
    if (meet > RULES.HORIZON_S + 60) return null;
    // Look for a second track anywhere between the two trains (double track or passing loop).
    let maxTracks = 1;
    const step = Math.max(150, gap / 60);
    for (let s = 0; s <= gap; s += step) {
      const [lon, lat, brg] = along(x.tr.path, x.tr.cum, x.s + s);
      maxTracks = Math.max(maxTracks, this.rail.trackCount(lon, lat, brg));
      if (maxTracks >= 2) break;
    }
    const mp = along(x.tr.path, x.tr.cum, x.s + gap * (x.v / closing));
    if (maxTracks >= 2) {
      if (meet > RULES.HORIZON_S) return null;
      return this._base('passing', x, y, {
        level: 'info', ttb: Math.round(meet), gap: Math.round(gap), req: 0, closing: Math.round(closing * 10) / 10,
        tracks: maxTracks, notes: ['second track available: normal crossing'], point: [mp[0], mp[1]],
      });
    }
    const bd = brake(x.v) + brake(y.v);
    const req = bd + RULES.MARGIN_M;
    const ttb = Math.max(0, (gap - req) / closing);
    if (ttb > RULES.HORIZON_S) return null;
    return this._base('opposing', x, y, {
      level: severity(gap, bd, ttb, closing), ttb: Math.round(ttb), gap: Math.round(gap), req: Math.round(req),
      closing: Math.round(closing * 10) / 10, tracks: 1, notes: ['single track between trains'], point: [mp[0], mp[1]],
    });
  }

  _converging(a, b, d0) {
    if (a.v < 3 || b.v < 3 || d0 < RULES.CONVERGE_M) return null;
    for (let t = RULES.STEP_S; t <= RULES.HORIZON_S; t += RULES.STEP_S) {
      const pa = along(a.tr.path, a.tr.cum, a.s + a.v * t);
      const pb = along(b.tr.path, b.tr.cum, b.s + b.v * t);
      if (dist(pa[0], pa[1], pb[0], pb[1]) < RULES.CONVERGE_M) {
        const ang = angleDiff(pa[2], pb[2]);
        if (ang < 15 || ang > 165) return null; // side by side on parallel tracks
        return this._base('converging', a, b, {
          level: t <= 30 ? 'warning' : 'watch', ttb: t, gap: Math.round(d0), req: RULES.CONVERGE_M,
          closing: null, tracks: null, notes: ['paths cross: junction or grade-separated crossing'],
          point: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2],
        });
      }
    }
    return null;
  }
}
