// Builds the Spanish rail network from OpenStreetMap (via Overpass).
//
// Outputs:
//   data/rail-graph.json   full-resolution ways with OSM node ids (server: snapping, path tracing, track counts)
//   web/data/rail.geojson  simplified lines for display (client)
//
// Run:  npm run build:rail        (re-downloads only if data/osm-rail-raw.json is missing or --refresh)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'osm-rail-raw.json');
const GRAPH = path.join(ROOT, 'data', 'rail-graph.json');
const DISPLAY = path.join(ROOT, 'web', 'data', 'rail.geojson');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Mainline + narrow gauge + sidings (passing loops and station tracks are often tagged
// service=siding, and the conflict engine needs them to tell single from double track).
// No yards / spurs / crossovers, no industrial / tourist lines.
const QUERY = `
[out:json][timeout:600];
area["ISO3166-1"="ES"][admin_level=2]->.es;
(
  way(area.es)["railway"~"^(rail|narrow_gauge)$"]["service"!~"^(yard|spur|crossover)$"]["usage"!~"^(industrial|military|tourism|test)$"];
);
out body geom qt;
`;

async function download() {
  for (const url of ENDPOINTS) {
    try {
      console.log(`Querying ${url} …`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'spain-rail-radar-prototype/0.1' },
        body: 'data=' + encodeURIComponent(QUERY),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      JSON.parse(text); // validate
      fs.mkdirSync(path.dirname(RAW), { recursive: true });
      fs.writeFileSync(RAW, text);
      console.log(`Saved ${(text.length / 1e6).toFixed(1)} MB`);
      return;
    } catch (e) {
      console.warn(`  failed: ${e.message}`);
    }
  }
  throw new Error('All Overpass endpoints failed');
}

function classify(tags) {
  const gauge = tags.gauge || '';
  const maxspeed = parseInt(tags.maxspeed, 10) || 0;
  if (tags.railway === 'narrow_gauge' || gauge === '1000' || gauge === '914') return 'narrow';
  if (tags.highspeed === 'yes' || maxspeed >= 220) return 'hs';
  if (tags.usage === 'main') return 'main';
  return 'branch';
}

// Douglas–Peucker on [lon,lat] in a local metric approximation.
function simplify(coords, tolMeters) {
  if (coords.length <= 2) return coords;
  const lat0 = coords[0][1] * Math.PI / 180;
  const kx = 111320 * Math.cos(lat0), ky = 110540;
  const pts = coords.map(([x, y]) => [x * kx, y * ky]);
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  const tol2 = tolMeters * tolMeters;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
    let best = -1, bestD = tol2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return coords.filter((_, i) => keep[i]);
}

const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

async function main() {
  if (!fs.existsSync(RAW) || process.argv.includes('--refresh')) await download();
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const ways = raw.elements.filter((e) => e.type === 'way' && e.geometry && e.geometry.length >= 2);
  console.log(`${ways.length} ways`);

  const graphWays = [];
  const features = [];
  let nPts = 0;
  for (const w of ways) {
    const t = w.tags || {};
    const cls = classify(t);
    const tracks = parseInt(t.tracks, 10) || 0;
    const svc = t.service === 'siding' ? 1 : 0;
    const coords = w.geometry.map((g) => [g.lon, g.lat]);
    nPts += coords.length;
    graphWays.push({
      id: w.id,
      cls,
      svc,
      gauge: (t.gauge || '').replace(/\s/g, ''),
      tracks,
      maxspeed: parseInt(t.maxspeed, 10) || 0,
      nodes: w.nodes,
      c: coords.flatMap(([x, y]) => [r6(x), r6(y)]),
    });
    features.push({
      type: 'Feature',
      properties: svc ? { c: cls, s: 1 } : { c: cls },
      geometry: { type: 'LineString', coordinates: simplify(coords, 1.5).map(([x, y]) => [r5(x), r5(y)]) },
    });
  }

  fs.mkdirSync(path.dirname(GRAPH), { recursive: true });
  fs.mkdirSync(path.dirname(DISPLAY), { recursive: true });
  fs.writeFileSync(GRAPH, JSON.stringify({ built: new Date().toISOString(), ways: graphWays }));
  fs.writeFileSync(DISPLAY, JSON.stringify({ type: 'FeatureCollection', features }));
  const sz = (p) => (fs.statSync(p).size / 1e6).toFixed(1) + ' MB';
  console.log(`graph: ${graphWays.length} ways, ${nPts} points → ${sz(GRAPH)}`);
  console.log(`display: ${features.length} lines → ${sz(DISPLAY)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
