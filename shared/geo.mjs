// Small geodesy helpers. Distances use a local equirectangular approximation,
// which is accurate to well under 0.1 % over the few tens of km we care about.

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
const KY = 110574; // metres per degree of latitude (approx.)

export const kx = (lat) => 111320 * Math.cos(lat * D2R);

export function dist(lon1, lat1, lon2, lat2) {
  const k = kx((lat1 + lat2) / 2);
  const dx = (lon2 - lon1) * k, dy = (lat2 - lat1) * KY;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Bearing in degrees, 0 = north, clockwise. */
export function bearing(lon1, lat1, lon2, lat2) {
  const k = kx((lat1 + lat2) / 2);
  const b = Math.atan2((lon2 - lon1) * k, (lat2 - lat1) * KY) * R2D;
  return (b + 360) % 360;
}

/** Smallest absolute difference between two bearings, 0..180. */
export function angleDiff(a, b) {
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return d;
}

export function offset(lon, lat, bearingDeg, meters) {
  const b = bearingDeg * D2R;
  return [lon + (Math.sin(b) * meters) / kx(lat), lat + (Math.cos(b) * meters) / KY];
}

/** Cumulative distances for a flat [lon,lat,lon,lat,…] path. */
export function cumulative(flat) {
  const n = flat.length / 2;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + dist(flat[2 * i - 2], flat[2 * i - 1], flat[2 * i], flat[2 * i + 1]);
  }
  return cum;
}

/** Point at distance s along a flat path. Returns [lon, lat, bearing]. Clamps to the ends. */
export function along(flat, cum, s) {
  const n = cum.length;
  if (n === 1) return [flat[0], flat[1], 0];
  if (s <= 0) return [flat[0], flat[1], bearing(flat[0], flat[1], flat[2], flat[3])];
  if (s >= cum[n - 1]) {
    const i = n - 2;
    return [flat[2 * n - 2], flat[2 * n - 1], bearing(flat[2 * i], flat[2 * i + 1], flat[2 * i + 2], flat[2 * i + 3])];
  }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1e-9;
  const t = (s - cum[lo]) / seg;
  const x1 = flat[2 * lo], y1 = flat[2 * lo + 1], x2 = flat[2 * hi], y2 = flat[2 * hi + 1];
  return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, bearing(x1, y1, x2, y2)];
}

/**
 * Projects a point onto a flat path, only considering the part beyond `fromS`.
 * Returns { s, lateral, bearing } of the closest point, or null.
 */
export function project(flat, cum, lon, lat, fromS = 0) {
  const n = cum.length;
  const k = kx(lat);
  let best = null;
  for (let i = 0; i < n - 1; i++) {
    if (cum[i + 1] < fromS) continue;
    const ax = (flat[2 * i] - lon) * k, ay = (flat[2 * i + 1] - lat) * KY;
    const bx = (flat[2 * i + 2] - lon) * k, by = (flat[2 * i + 3] - lat) * KY;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = -(ax * dx + ay * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, py = ay + dy * t;
    const d = Math.sqrt(px * px + py * py);
    const s = cum[i] + (cum[i + 1] - cum[i]) * t;
    if (s < fromS) continue;
    if (!best || d < best.lateral) {
      best = { s, lateral: d, bearing: (Math.atan2(dx, dy) * R2D + 360) % 360 };
    }
  }
  return best;
}

/** Douglas–Peucker on a flat path, tolerance in metres. */
export function simplifyFlat(flat, tol) {
  const n = flat.length / 2;
  if (n <= 2) return flat.slice();
  const k = kx(flat[1]);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = flat[2 * a] * k, ay = flat[2 * a + 1] * KY;
    const bx = flat[2 * b] * k, by = flat[2 * b + 1] * KY;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
    let best = -1, bestD = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = flat[2 * i] * k, py = flat[2 * i + 1] * KY;
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(flat[2 * i], flat[2 * i + 1]);
  return out;
}
