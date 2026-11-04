// Rail Radar · España — local server.
//   • polls Renfe's official GTFS-RT feeds directly (no third-party aggregators)
//   • tracks trains, estimates speed/heading, traces their path along OSM track
//   • runs the conflict engine every second
//   • pushes everything to browsers over Server-Sent Events (/api/stream)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Rail } from './rail.mjs';
import { Gtfs } from './gtfs.mjs';
import { FeedPoller } from './feeds.mjs';
import { Tracker } from './tracker.mjs';
import { ConflictEngine, RULES } from './conflicts.mjs';
import * as clock from './clock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

const GRAPH = path.join(ROOT, 'data', 'rail-graph.json');
if (!fs.existsSync(GRAPH)) {
  console.error('Rail network missing. Run:  npm run build:rail');
  process.exit(1);
}

console.log('[rail] loading network…');
const rail = new Rail(GRAPH);
console.log(`[rail] ${rail.ways.length} ways, ${rail.junctions.size} junction nodes`);
const gtfs = new Gtfs();
await gtfs.load(path.join(ROOT, 'data', 'gtfs'));
const stationsJson = JSON.stringify(gtfs.stationsGeoJSON());

const tracker = new Tracker(rail, gtfs);
const engine = new ConflictEngine(tracker, rail);
const poller = new FeedPoller();

// ---------- SSE ----------
const clients = new Set();
function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  const payload = JSON.stringify(data);
  for (const res of clients) send(res, event, payload);
}

poller.on('message', (m) => {
  tracker.ingest(m);
  if (m.feed.kind === 'vp') {
    const now = clock.now();
    broadcast('trains', { net: m.feed.net, serverTime: now, publishedAt: m.publishedAt, trains: tracker.list(m.feed.net, now) });
  }
});
tracker.on('trains', () => {});

let lastConflicts = [];
const statusPayload = (now) => ({ serverTime: now, clockSkewMs: clock.skewMs(), feeds: poller.status(), trains: tracker.trains.size, engine: engine.stats });
setInterval(() => {
  const now = clock.now();
  lastConflicts = engine.compute(now);
  broadcast('conflicts', { serverTime: now, conflicts: lastConflicts, stats: engine.stats });
  broadcast('status', statusPayload(now));
}, 1000);

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.geojson': 'application/geo+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json', '.ico': 'image/x-icon',
};
const MOUNTS = [
  ['/vendor/maplibre/', path.join(ROOT, 'node_modules', 'maplibre-gl', 'dist')],
  ['/vendor/three/', path.join(ROOT, 'node_modules', 'three')],
  ['/shared/', path.join(ROOT, 'shared')],
  ['/', path.join(ROOT, 'web')],
];
const gzCache = new Map();

function serveStatic(req, res, urlPath) {
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    let rel = decodeURIComponent(urlPath.slice(prefix.length)) || 'index.html';
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir)) break;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const ext = path.extname(file);
    const stat = fs.statSync(file);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': prefix === '/' ? 'no-cache' : 'max-age=86400' };
    const wantsGz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && stat.size > 50_000 && ext !== '.png';
    if (wantsGz) {
      const k = file + stat.mtimeMs;
      let gz = gzCache.get(k);
      if (!gz) { gz = zlib.gzipSync(fs.readFileSync(file), { level: 6 }); gzCache.set(k, gz); }
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      return res.end(gz);
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

function json(req, res, body) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && buf.length > 20_000) {
    const gz = zlib.gzipSync(buf);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
    return res.end(gz);
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(buf);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const now = clock.now();
    send(res, 'hello', { serverTime: now, rules: RULES });
    for (const net of ['ld', 'cer']) send(res, 'trains', { net, serverTime: now, trains: tracker.list(net, now) });
    send(res, 'conflicts', { serverTime: now, conflicts: lastConflicts, stats: engine.stats });
    send(res, 'status', statusPayload(now));
    clients.add(res);
    const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }
  if (p === '/api/stations') return json(req, res, stationsJson);
  if (p === '/api/snapshot') { const now = clock.now(); return json(req, res, { serverTime: now, trains: tracker.list(null, now), conflicts: lastConflicts, feeds: poller.status() }); }
  if (p === '/api/status') return json(req, res, statusPayload(clock.now()));
  serveStatic(req, res, p);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Rail Radar · España  →  http://${HOST}:${PORT}\n`);
  poller.start();
});
