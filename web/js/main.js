import { buildStyle, EMPTY, LEVEL_COLORS } from './mapstyle.js';
import { Store } from './store.js';
import { TrainsLayer } from './trains3d.js';
import { CameraRig } from './camera.js';
import { UI, accentOf, trainName, fmtDist, isStopped, trendText } from './ui.js';
import { PhoneUI, PHONE_QUERY } from './phone.js';
import { offset } from '/shared/geo.mjs';

const maplibregl = window.maplibregl;
const store = new Store();
const phoneScreen = window.matchMedia(PHONE_QUERY);
const COMPUTER_LIMITS = { minZoom: 4.5, maxBounds: [[-14.5, 33.0], [9.5, 46.8]] };

const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(),
  center: [-3.6, 40.2],
  zoom: window.innerWidth < 700 ? 4.9 : 5.75,
  ...COMPUTER_LIMITS,
  maxZoom: 19.5,
  maxPitch: 85,
  attributionControl: false,
  canvasContextAttributes: { antialias: true },
  fadeDuration: 120,
  ...(phoneScreen.matches ? { pixelRatio: Math.min(window.devicePixelRatio, 2) } : {}), // sharp enough, and easier on the battery
});
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: [
    'Origen de los datos: <a href="https://data.renfe.com" target="_blank">Renfe Operadora</a> (CC BY 4.0)',
    'Track © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
  ],
}), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

// Author links: in the top bar, in the fullest form that fits the free space between the chips on either
// side ("Built by" + handles, then handles, then icons only), at the bar's centre when that spot is free,
// otherwise centred in the free space (hidden if even the icons don't fit). Phones have no room there, so
// they move to the bottom of the map, where they never cover the map's data credits: they slide left along
// the bottom edge if there is room, otherwise they sit just above the credits.
const credit = document.querySelector('.credit');
const topbar = document.querySelector('.topbar');
const attrib = document.querySelector('.maplibregl-ctrl-attrib');
const phone = window.matchMedia('(max-width: 860px)');
function placeCredit() {
  if (!credit || !attrib || phoneScreen.matches) return; // on phones the links are in the About tab
  credit.style.left = '';
  credit.style.bottom = '';
  credit.style.visibility = '';
  if (!phone.matches) {
    if (credit.parentElement !== topbar) topbar.append(credit);
    const bar = topbar.getBoundingClientRect();
    const ends = [...topbar.querySelectorAll('.brand, #feeds .feed')].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().right);
    const from = Math.max(...ends) - bar.left + 24;
    const to = topbar.querySelector('.tb-right').getBoundingClientRect().left - bar.left - 24;
    for (const form of ['full', 'no-by', 'icons']) {
      credit.classList.toggle('no-by', form !== 'full');
      credit.classList.toggle('icons', form === 'icons');
      const w = credit.offsetWidth, mid = bar.width / 2;
      if (to - from < w) continue;
      const centre = mid - w / 2 >= from && mid + w / 2 <= to ? mid : (from + to) / 2;
      credit.style.left = `${Math.round(centre)}px`;
      return;
    }
    credit.style.visibility = 'hidden';
    return;
  }
  credit.classList.remove('no-by', 'icons');
  if (credit.parentElement !== document.body) document.body.append(credit);
  const r = credit.getBoundingClientRect(), q = attrib.getBoundingClientRect();
  const clear = !q.width || r.right <= q.left - 12 || r.left >= q.right || r.bottom <= q.top || r.top >= q.bottom;
  if (clear) return;
  const L = document.querySelector('#left')?.getBoundingClientRect();
  const minLeft = Math.max(10, (L && L.right > 0 ? L.right : 0) + 14);
  const left = q.left - 12 - r.width;
  if (left >= minLeft) credit.style.left = `${Math.round(left + r.width / 2)}px`; // centred on "left" (translateX(-50%))
  else credit.style.bottom = `${Math.round(window.innerHeight - q.top + 8)}px`;
}
phone.addEventListener('change', placeCredit);
window.addEventListener('resize', placeCredit);
{
  const ro = new ResizeObserver(placeCredit);
  for (const e of [attrib, topbar, document.querySelector('#feeds'), document.querySelector('.tb-left'), document.querySelector('.tb-right')]) if (e) ro.observe(e);
}
placeCredit();

const layer = new TrainsLayer(store);
const rig = new CameraRig(map, store, layer);
const ui = new UI({ map, store, rig, layer, onFocusConflict: focusConflict });
const phoneUI = new PhoneUI({ map, store, rig, layer, ui, computer: COMPUTER_LIMITS, onDisable: placeCredit });
window.__radar = { map, store, rig, layer, phoneUI }; // handy for debugging in the console

map.on('load', () => {
  map.addLayer(layer, 'station');
  store.connect();
});
map.on('styleimagemissing', (e) => { if (e.id === 'rr-signal' && !map.hasImage('rr-signal')) map.addImage('rr-signal', signalIcon(), { pixelRatio: 2 }); });

/** A small railway signal showing red (drawn once; used above stopped trains in a warning). */
function signalIcon() {
  const W = 36, H = 64, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
  g.fillStyle = '#8ea3ba'; g.fillRect(16, 44, 4, 16);              // post
  g.fillRect(10, 58, 16, 3);                                       // base
  rr(5, 2, 26, 44, 9); g.fillStyle = '#0a1422'; g.fill();          // head
  g.lineWidth = 2; g.strokeStyle = '#d5e2f0'; g.stroke();
  g.fillStyle = '#26303d'; g.beginPath(); g.arc(18, 33, 6, 0, 7); g.fill();   // unlit lamp
  g.shadowColor = '#ff2d4a'; g.shadowBlur = 10;                    // red aspect
  g.fillStyle = '#ff2d4a'; g.beginPath(); g.arc(18, 15, 8, 0, 7); g.fill();
  g.shadowBlur = 0; g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.arc(15.5, 12.5, 2.4, 0, 7); g.fill();
  return g.getImageData(0, 0, W, H);
}

// ---------- per-frame camera ----------
(function loop() { rig.update(); requestAnimationFrame(loop); })();

// ---------- picking ----------
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}
function pick(point, tol = 14) {
  let best = null, bestD = tol;
  for (const t of store.trains.values()) {
    if (!t.disp || !store.isVisible(t)) continue;
    const half = layer.visualLength(t) / 2;
    const a = map.project(offset(t.disp.lon, t.disp.lat, t.disp.bearing, half));
    const b = map.project(offset(t.disp.lon, t.disp.lat, t.disp.bearing + 180, half));
    const d = segDist(point, a, b);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

map.on('click', (e) => {
  if (rig.lastDragMoved) { rig.lastDragMoved = false; return; }
  const t = pick(e.point, phoneUI.active ? 26 : 14); // a finger needs more room than a mouse
  if (t) {
    const was = store.selectedId;
    store.select(t.id);
    if (rig.mode === 'free' && was !== t.id) rig.setMode('top');
  } else if (rig.mode === 'free') store.select(null);
  phoneUI.mapTapped(t);
});

let hoverPending = false;
map.on('mousemove', (e) => {
  if (hoverPending) return;
  hoverPending = true;
  requestAnimationFrame(() => {
    hoverPending = false;
    const t = pick(e.point, 12);
    map.getCanvas().style.cursor = t ? 'pointer' : '';
    ui.tooltip(t && t.id !== store.selectedId ? t : null, e.point);
  });
});
map.on('mouseout', () => ui.tooltip(null));

// ---------- overlays: predicted paths, conflict links, focused-warning labels, stop signals ----------
const fc = (features) => ({ type: 'FeatureCollection', features });
const line = (coordinates, properties) => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates } });
const point = (coordinates, properties) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates } });
const kmh = (v) => (v == null ? '—' : Math.round(v * 3.6));

/** The train's predicted path from where it is drawn now, up to maxM metres ahead. */
function pathAhead(t, maxM = Infinity) {
  const d = t.d, coords = [[t.disp.lon, t.disp.lat]];
  for (let i = 0; i < t.cum.length; i++) {
    if (t.cum[i] <= t.disp.s) continue;
    if (t.cum[i] - t.disp.s > maxM) break;
    coords.push([d.path[2 * i], d.path[2 * i + 1]]);
  }
  return coords;
}

function updateOverlays() {
  if (!map.getSource('selpath')) return;
  const f = store.focus;
  const live = (id) => { const t = store.trains.get(id); return t?.disp && t.cum ? t : null; };

  // predicted path: both trains of the focused warning, otherwise the selected train
  const paths = [];
  const ids = f ? [f.a, f.b] : store.selectedId ? [store.selectedId] : [];
  for (const id of ids) {
    const t = live(id);
    if (!t) continue;
    const c = pathAhead(t, f ? (f.gap || 0) + 1000 : Infinity);
    if (c.length > 1) paths.push(line(c, { color: accentOf(t.d) }));
  }
  map.getSource('selpath').setData(fc(paths));

  // links between the two trains of each listed warning (only the focused one while focused)
  const list = f ? [f] : store.visibleConflicts();
  const links = [];
  for (const c of list) {
    const a = live(c.a)?.disp, b = live(c.b)?.disp;
    const pa = a ? [a.lon, a.lat] : c.aPos, pb = b ? [b.lon, b.lat] : c.bPos;
    links.push(line([pa, pb], { level: c.level }));
    if (c.point && c.level !== 'info' && !f) links.push(point(c.point, { level: c.level }));
  }
  map.getSource('conflicts').setData(fc(links));

  // stop signal above every stopped train that a listed warning involves
  const signals = new Map();
  for (const c of list) {
    if (c.level === 'info') continue;
    for (const id of [c.a, c.b]) {
      const t = live(id);
      if (!t || signals.has(id) || !store.isVisible(t) || !isStopped(t.d)) continue;
      signals.set(id, point([t.disp.lon, t.disp.lat], { t: t.d.speed == null ? 'assumed stopped' : 'stopped' }));
    }
  }
  map.getSource('signals').setData(fc([...signals.values()]));

  // focused warning: name + speed above each train, separation between them
  const labels = [];
  if (f) {
    const A = live(f.a), B = live(f.b);
    for (const t of [A, B]) {
      if (!t) continue;
      const stopped = isStopped(t.d);
      labels.push(point([t.disp.lon, t.disp.lat], {
        k: 'train', c: accentOf(t.d), o: stopped && signals.has(t.id) ? [0, -4.6] : [0, -1.5],
        t: `${trainName(t.d)}\n${stopped ? (t.d.speed == null ? 'speed unknown' : 'stopped') : kmh(t.d.speed) + ' km/h'}`,
      }));
    }
  }
  map.getSource('focus').setData(fc(labels));
  updateGapTag(f, f && live(f.a), f && live(f.b));
}

// Separation between the two trains of the focused warning: a tag beside the track, joined to the middle
// of the gap by a short leader line. It is HTML so the trend arrow can animate; only changed text is
// rewritten, so the animation runs on undisturbed.
let gapTag = null;
function updateGapTag(f, A, B) {
  if (!f || !A || !B) {
    if (gapTag) { gapTag.marker.remove(); cancelAnimationFrame(gapTag.raf); gapTag = null; }
    return;
  }
  const mid = [(A.disp.lon + B.disp.lon) / 2, (A.disp.lat + B.disp.lat) / 2];
  if (!gapTag) gapTag = createGapTag(mid);
  const g = gapTag;
  g.marker.setLngLat(mid);
  const c = LEVEL_COLORS[f.level];
  if (c !== g.c) { g.el.style.setProperty('--c', c); g.c = c; }
  const l1 = !store.focusLive ? 'resolved'
    : f.type === 'converging' ? `paths cross in ${f.ttb} s`
    : `${f.type === 'following' && f.req && f.gap < f.req ? 'Close · ' : ''}${fmtDist(f.gap)} apart${f.req ? ` <small>(margin ${fmtDist(f.req)})</small>` : ''}`;
  const cl = f.closing ?? 0;
  const k2 = !store.focusLive || f.type === 'converging' ? '' : `${cl > 0.3 ? 1 : cl < -0.3 ? -1 : 0}:${Math.round(Math.abs(cl) * 3.6)}`;
  let changed = false;
  if (l1 !== g.k1) { g.l1.innerHTML = l1; g.k1 = l1; changed = true; }
  if (k2 !== g.k2) { g.l2.innerHTML = k2 ? trendText(f.closing) : ''; g.k2 = k2; changed = true; }
  if (changed || !g.w) { g.w = g.tag.offsetWidth; g.h = g.tag.offsetHeight; }
  placeGapTag(g, A, B, mid);
}

function createGapTag(mid) {
  const el = document.createElement('div');
  el.className = 'gap-callout';
  el.innerHTML = '<svg class="gc-lead"><line/></svg><i class="gc-dot"></i><div class="gap-tag"><div class="gt-1"></div><div class="gt-2"></div></div>';
  const tag = el.querySelector('.gap-tag');
  const g = { el, tag, line: el.querySelector('line'), l1: tag.firstChild, l2: tag.lastChild, k1: null, k2: null, c: null,
    w: 0, h: 0, cur: null, target: null, choice: null, raf: 0,
    marker: new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(mid).addTo(map) };
  // glide towards the chosen spot (about 0.3 s, whatever the frame rate), so the tag never jumps
  let last = performance.now();
  const step = (now) => {
    const k = 1 - Math.exp(-Math.min(0.5, (now - last) / 1000) / 0.1);
    last = now;
    if (g.target) {
      g.cur = g.cur ? { x: g.cur.x + (g.target.x - g.cur.x) * k, y: g.cur.y + (g.target.y - g.cur.y) * k } : { ...g.target };
      drawGapTag(g);
    }
    g.raf = requestAnimationFrame(step);
  };
  g.raf = requestAnimationFrame(step);
  return g;
}

function drawGapTag(g) {
  const { x, y } = g.cur, w = g.w, h = g.h;
  g.tag.style.transform = `translate(${(x - w / 2).toFixed(1)}px, ${(y - h / 2).toFixed(1)}px)`;
  // leader: from just outside the dot to where the line towards the tag's centre meets its border
  const t = Math.min(w / 2 / Math.max(Math.abs(x), 1e-6), h / 2 / Math.max(Math.abs(y), 1e-6));
  const bx = x * (1 - t), by = y * (1 - t), d = Math.hypot(bx, by);
  const r0 = 7;
  const show = t < 1 && d > r0 + 4;
  g.line.style.display = show ? '' : 'none';
  if (show) {
    g.line.setAttribute('x1', (bx / d * r0).toFixed(1)); g.line.setAttribute('y1', (by / d * r0).toFixed(1));
    g.line.setAttribute('x2', bx.toFixed(1)); g.line.setAttribute('y2', by.toFixed(1));
  }
}

// Picks the spot that covers the least: a few positions on either side of the line between the two trains
// (and straight above or below it), at increasing distances, each scored by what it would hide: the two
// trains and the line between them, their name labels, other trains, rails, and the side panels.
const RAIL_LAYERS = ['rail', 'rail-siding', 'selpath'];
function placeGapTag(g, A, B, mid) {
  const pm = map.project(mid);
  const pa = map.project([A.disp.lon, A.disp.lat]), pb = map.project([B.disp.lon, B.disp.lat]);
  let dx = pb.x - pa.x, dy = pb.y - pa.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
  let nx = -dy, ny = dx;
  if (ny < 0) { nx = -nx; ny = -ny; }                      // n+ points down the screen

  // what to keep clear, relative to the midpoint
  const seg = [];
  const n = Math.min(60, Math.ceil((len + 60) / 12));
  for (let i = 0; i <= n; i++) {
    const s = -30 + ((len + 60) * i) / n;
    seg.push([pa.x + dx * s - pm.x, pa.y + dy * s - pm.y]);
  }
  const labelBoxes = [pa, pb].map((p) => [p.x - 78 - pm.x, p.y - 104 - pm.y, p.x + 78 - pm.x, p.y - 4 - pm.y]);
  const others = [];
  for (const t of store.trains.values()) {
    if (!t.disp || t === A || t === B || !store.isVisible(t)) continue;
    const p = map.project([t.disp.lon, t.disp.lat]);
    const ox = p.x - pm.x, oy = p.y - pm.y;
    if (Math.abs(ox) < 500 && Math.abs(oy) < 400) others.push([ox, oy]);
  }
  const host = map.getContainer().getBoundingClientRect();
  const blocks = ['.topbar', '#left', '#train-panel', '.ph-dock'].map((s) => document.querySelector(s))
    .filter((e) => e && !e.hidden && e.offsetParent !== null)
    .map((e) => { const r = e.getBoundingClientRect(); return [r.left - host.left - pm.x, r.top - host.top - pm.y, r.right - host.left - pm.x, r.bottom - host.top - pm.y]; });
  const view = [-pm.x + 8, -pm.y + 8, host.width - pm.x - 8, host.height - pm.y - 8];

  const w = g.w, h = g.h;
  const inBox = (p, bx) => p[0] > bx[0] && p[0] < bx[2] && p[1] > bx[1] && p[1] < bx[3];
  const overlaps = (p, q) => p[0] < q[2] && p[2] > q[0] && p[1] < q[3] && p[3] > q[1];
  const dirs = [['n+', nx, ny], ['n-', -nx, -ny], ['down', 0, 1], ['up', 0, -1]];
  let best = null;
  for (const [name, ux, uy] of dirs) {
    const base = 30 + Math.abs(ux) * w / 2 + Math.abs(uy) * h / 2;
    for (const extra of [0, 45, 100]) {
      const cx = ux * (base + extra), cy = uy * (base + extra);
      const box = [cx - w / 2 - 6, cy - h / 2 - 6, cx + w / 2 + 6, cy + h / 2 + 6];
      let score = extra / 30 + (uy < -0.5 ? 1 : 0);
      for (const p of seg) if (inBox(p, box)) score += 4;
      for (const lb of labelBoxes) if (overlaps(box, lb)) score += 6;
      for (const p of others) if (inBox(p, box)) score += 3;
      for (const bl of blocks) if (overlaps(box, bl)) score += 40;
      if (box[0] < view[0] || box[1] < view[1] || box[2] > view[2] || box[3] > view[3]) score += 40;
      if (best && score >= best.score + 2) continue;         // rails are the costly check: skip hopeless spots
      const rails = map.queryRenderedFeatures([[pm.x + box[0], pm.y + box[1]], [pm.x + box[2], pm.y + box[3]]], { layers: RAIL_LAYERS });
      score += 2 * Math.min(rails.length, 6);
      const key = name + extra;
      if (key === g.choice) score -= 1.5;                    // keep the current spot unless another is clearly better
      if (!best || score < best.score) best = { score, key, x: cx, y: cy };
    }
  }
  g.choice = best.key;
  g.target = { x: best.x, y: best.y };
}
setInterval(updateOverlays, 250);

function focusConflict(c) {
  rig.setMode('free');
  store.setFocus(c);
  store.select(c.a);
  const a = store.trains.get(c.a)?.disp, b = store.trains.get(c.b)?.disp;
  const pa = a ? [a.lon, a.lat] : c.aPos, pb = b ? [b.lon, b.lat] : c.bPos;
  map.fitBounds([[Math.min(pa[0], pb[0]), Math.min(pa[1], pb[1])], [Math.max(pa[0], pb[0]), Math.max(pa[1], pb[1])]],
    { padding: phoneUI.active ? phoneUI.fitPadding() : { top: 140, bottom: 140, left: 380, right: 400 }, maxZoom: 15.5, duration: 1400, pitch: 45 });
}
