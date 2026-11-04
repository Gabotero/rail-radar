// Rail network: spatial index, snapping, track counting and path tracing over OSM ways.

import fs from 'node:fs';
import { kx, bearing, angleDiff, dist } from '../shared/geo.mjs';

const KY = 110574;
const CELL = 0.01; // degrees (~1 km)
const PACK = 100000; // segment ref = wayIndex * PACK + vertexIndex

export class Rail {
  constructor(file) {
    const { ways } = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.ways = ways.map((w) => ({
      id: w.id, cls: w.cls, svc: w.svc || 0, gauge: w.gauge || '', tracks: w.tracks, maxspeed: w.maxspeed,
      nodes: w.nodes, xy: Float64Array.from(w.c),
    }));
    this.grid = new Map();
    const nodeCount = new Map();
    this.ways.forEach((w, wi) => {
      const n = w.xy.length / 2;
      for (let k = 0; k < n; k++) nodeCount.set(w.nodes[k], (nodeCount.get(w.nodes[k]) || 0) + 1);
      for (let k = 0; k < n - 1; k++) {
        const x1 = w.xy[2 * k], y1 = w.xy[2 * k + 1], x2 = w.xy[2 * k + 2], y2 = w.xy[2 * k + 3];
        const cx0 = Math.floor(Math.min(x1, x2) / CELL), cx1 = Math.floor(Math.max(x1, x2) / CELL);
        const cy0 = Math.floor(Math.min(y1, y2) / CELL), cy1 = Math.floor(Math.max(y1, y2) / CELL);
        for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
          const key = cx * 100000 + cy;
          let arr = this.grid.get(key);
          if (!arr) this.grid.set(key, (arr = []));
          arr.push(wi * PACK + k);
        }
      }
    });
    // Junctions: OSM nodes shared by more than one way (or used twice).
    this.junctions = new Map();
    this.ways.forEach((w, wi) => {
      w.nodes.forEach((id, k) => {
        if (nodeCount.get(id) > 1) {
          let arr = this.junctions.get(id);
          if (!arr) this.junctions.set(id, (arr = []));
          arr.push([wi, k]);
        }
      });
    });
  }

  *segmentsNear(lon, lat, radiusM) {
    const rx = radiusM / kx(lat), ry = radiusM / KY;
    const cx0 = Math.floor((lon - rx) / CELL), cx1 = Math.floor((lon + rx) / CELL);
    const cy0 = Math.floor((lat - ry) / CELL), cy1 = Math.floor((lat + ry) / CELL);
    const seen = new Set();
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const arr = this.grid.get(cx * 100000 + cy);
      if (!arr) continue;
      for (const ref of arr) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        yield ref;
      }
    }
  }

  /** Distance & projection of point onto segment ref. */
  _proj(ref, lon, lat) {
    const wi = Math.floor(ref / PACK), k = ref % PACK;
    const w = this.ways[wi];
    const k0 = kx(lat);
    const ax = (w.xy[2 * k] - lon) * k0, ay = (w.xy[2 * k + 1] - lat) * KY;
    const bx = (w.xy[2 * k + 2] - lon) * k0, by = (w.xy[2 * k + 3] - lat) * KY;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
    let t = -(ax * dx + ay * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, py = ay + dy * t;
    return {
      wi, k, t,
      dist: Math.sqrt(px * px + py * py),
      // signed lateral offset (positive = point is left of the segment direction)
      side: (dx * -ay - dy * -ax) / Math.sqrt(len2),
      bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360,
      lon: lon + px / k0, lat: lat + py / KY,
    };
  }

  /** Nearest track within maxDist metres. */
  snap(lon, lat, maxDist = 80) {
    let best = null;
    for (const ref of this.segmentsNear(lon, lat, maxDist)) {
      const p = this._proj(ref, lon, lat);
      if (p.dist <= maxDist && (!best || p.dist < best.dist)) best = p;
    }
    if (!best) return null;
    const w = this.ways[best.wi];
    return { ...best, cls: w.cls, gauge: w.gauge, tracksTag: w.tracks, maxspeed: w.maxspeed };
  }

  /**
   * Number of parallel tracks at a location: clusters the lateral offsets of all
   * nearby parallel segments (tracks are >= ~3.5 m apart), so a single track split
   * into several OSM ways is not double counted. Also honours the `tracks=*` tag.
   */
  trackCount(lon, lat, bearingDeg, radius = 16) {
    const offs = [];
    let tag = 0;
    for (const ref of this.segmentsNear(lon, lat, radius)) {
      const p = this._proj(ref, lon, lat);
      if (p.dist > radius) continue;
      const d = angleDiff(p.bearing, bearingDeg);
      if (d > 25 && d < 155) continue; // not parallel
      const signed = d <= 90 ? p.side : -p.side; // normalise to the query direction
      offs.push(signed);
      tag = Math.max(tag, this.ways[p.wi].tracks || 0);
    }
    offs.sort((a, b) => a - b);
    let clusters = 0, last = -Infinity;
    for (const o of offs) { if (o - last > 2.0) clusters++; last = o; }
    return Math.max(clusters, tag, offs.length ? 1 : 0);
  }

  _xy(wi, k) { const w = this.ways[wi]; return [w.xy[2 * k], w.xy[2 * k + 1]]; }

  /**
   * Follows the track from a snapped point in direction dir (+1 = along the OSM way, -1 = against),
   * taking the straightest continuation at every junction. Returns a flat [lon,lat,…] path.
   */
  trace(snap, dir, maxLen) {
    const out = [snap.lon, snap.lat];
    let wi = snap.wi;
    let idx = dir > 0 ? snap.k + 1 : snap.k;
    let cur = [snap.lon, snap.lat];
    let heading = dir > 0 ? snap.bearing : (snap.bearing + 180) % 360;
    let len = 0;
    const visited = new Set();
    for (let guard = 0; guard < 4000; guard++) {
      const p = this._xy(wi, idx);
      const step = dist(cur[0], cur[1], p[0], p[1]);
      if (step > 0.01) {
        heading = bearing(cur[0], cur[1], p[0], p[1]);
        out.push(p[0], p[1]);
        len += step;
      }
      if (len >= maxLen) break;
      cur = p;
      const key = wi * PACK + idx;
      if (visited.has(key)) break;
      visited.add(key);

      // candidate continuations
      const cands = [];
      const w = this.ways[wi];
      const n = w.xy.length / 2;
      if (idx + dir >= 0 && idx + dir < n) cands.push([wi, idx + dir, dir, true]);
      const j = this.junctions.get(w.nodes[idx]);
      if (j) for (const [w2, k2] of j) {
        if (w2 === wi && k2 === idx) continue;
        const n2 = this.ways[w2].xy.length / 2;
        if (k2 + 1 < n2) cands.push([w2, k2 + 1, +1, false]);
        if (k2 - 1 >= 0) cands.push([w2, k2 - 1, -1, false]);
      }
      let best = null, bestTurn = 1e9;
      for (const c of cands) {
        const q = this._xy(c[0], c[1]);
        const turn = angleDiff(heading, bearing(p[0], p[1], q[0], q[1]));
        // slight preference for staying on the same way, and for main track over sidings
        const score = turn - (c[3] ? 3 : 0) + (!c[3] && this.ways[c[0]].svc && !w.svc ? 4 : 0);
        if (score < bestTurn) { bestTurn = score; best = c; }
      }
      if (!best || bestTurn > 50) break; // dead end or only reversals
      [wi, idx, dir] = best;
    }
    return out;
  }
}
