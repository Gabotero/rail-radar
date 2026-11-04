// Renfe static GTFS (official, data.renfe.com): used only for names, products, line colours,
// origin/destination and stop order. Positions never come from here.

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const SOURCES = {
  ld: 'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip',
  cer: 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip',
};
const MAX_AGE_MS = 12 * 3600 * 1000;

const PRODUCT_CAT = {
  'AVE': 'hs', 'AVE INT': 'hs', 'AVLO': 'hs', 'EUROMED': 'hs', 'AVANT': 'hs', 'AVANT EXP': 'hs',
  'ALVIA': 'ld', 'INTERCITY': 'ld', 'TRENCELTA': 'ld',
  'MD': 'md', 'REGIONAL': 'md', 'REG.EXP.': 'md', 'PROXIMDAD': 'md',
};

function decode(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch { return new TextDecoder('latin1').decode(buf); }
}

function* rows(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) return;
  const text = decode(entry.getData());
  let header = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const cells = line.includes('"') ? parseQuoted(line) : line.split(',');
    const vals = cells.map((c) => c.trim());
    if (!header) { header = vals; continue; }
    const o = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = vals[i] ?? '';
    yield o;
  }
}

function parseQuoted(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function ensure(dir, key) {
  const file = path.join(dir, `${key}.zip`);
  const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < MAX_AGE_MS;
  if (!fresh) {
    try {
      console.log(`[gtfs] downloading ${key} timetable…`);
      const res = await fetch(SOURCES[key]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      if (!fs.existsSync(file)) throw e;
      console.warn(`[gtfs] ${key} download failed (${e.message}); using cached copy`);
    }
  }
  return new AdmZip(file);
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-/(.'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

export class Gtfs {
  constructor() {
    this.stops = new Map(); // stopId -> { name, lat, lon, k }
    this.ldTrips = new Map(); // tripId -> { product, num, stops: [stopId…] }
    this.cerTrips = new Map(); // tripId -> routeId
    this.cerRoutes = new Map(); // routeId -> { line, color, from, to }
  }

  async load(dir) {
    const t0 = Date.now();
    const ld = await ensure(dir, 'ld');
    const routes = new Map();
    for (const r of rows(ld, 'routes.txt')) routes.set(r.route_id, r.route_short_name);
    for (const s of rows(ld, 'stops.txt')) this.stops.set(s.stop_id, { name: s.stop_name, lat: +s.stop_lat, lon: +s.stop_lon, k: 'ld' });
    for (const t of rows(ld, 'trips.txt')) {
      this.ldTrips.set(t.trip_id, { product: routes.get(t.route_id) || '', num: t.trip_short_name, stops: [] });
    }
    const seq = new Map();
    for (const st of rows(ld, 'stop_times.txt')) {
      let arr = seq.get(st.trip_id);
      if (!arr) seq.set(st.trip_id, (arr = []));
      arr.push([+st.stop_sequence, st.stop_id]);
    }
    for (const [tid, arr] of seq) {
      const trip = this.ldTrips.get(tid);
      if (trip) trip.stops = arr.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    }

    const cer = await ensure(dir, 'cer');
    for (const r of rows(cer, 'routes.txt')) {
      const parts = r.route_long_name.split(/\s+-\s*/);
      this.cerRoutes.set(r.route_id, {
        line: r.route_short_name,
        color: r.route_color ? '#' + r.route_color : null,
        from: parts[0] || '', to: parts.slice(1).join('-') || '',
      });
    }
    for (const t of rows(cer, 'trips.txt')) this.cerTrips.set(t.trip_id, t.route_id);
    for (const s of rows(cer, 'stops.txt')) {
      const prev = this.stops.get(s.stop_id);
      this.stops.set(s.stop_id, { name: prev?.name || s.stop_name, lat: +s.stop_lat, lon: +s.stop_lon, k: prev ? 'both' : 'cer' });
    }
    console.log(`[gtfs] ${this.stops.size} stops, ${this.ldTrips.size} LD trips, ${this.cerTrips.size} Cercanías trips (${Date.now() - t0} ms)`);
  }

  stopName(id) { return id ? this.stops.get(id)?.name || null : null; }
  stop(id) { return id ? this.stops.get(id) || null : null; }

  /** Descriptive info for a live vehicle. */
  info(net, tripId, label) {
    if (net === 'ld') {
      const t = this.ldTrips.get(tripId);
      const product = (t?.product || 'TREN').toUpperCase();
      const first = t?.stops[0], last = t?.stops[t.stops.length - 1];
      return {
        cat: PRODUCT_CAT[product] || 'ld',
        product: t?.product || (tripId?.startsWith('SPECIAL') ? 'Especial' : 'Tren'),
        num: t?.num || label || '',
        line: null, color: null,
        from: first ? titleCase(this.stopName(first) || '') : null,
        to: last ? titleCase(this.stopName(last) || '') : null,
      };
    }
    const r = this.cerRoutes.get(this.cerTrips.get(tripId));
    const [lineFromLabel, numFromLabel] = (label || '').split('-');
    return {
      cat: 'cer',
      product: 'Cercanías',
      num: numFromLabel || '',
      line: r?.line || lineFromLabel || '',
      color: r?.color || null,
      from: r?.from ? titleCase(r.from) : null,
      to: r?.to ? titleCase(r.to) : null,
    };
  }

  /** For long-distance trips: the stop after `stopId` (gives travel direction while stopped). */
  nextStopAfter(tripId, stopId) {
    const t = this.ldTrips.get(tripId);
    if (!t) return null;
    const i = t.stops.indexOf(stopId);
    return i >= 0 && i < t.stops.length - 1 ? t.stops[i + 1] : null;
  }

  stationsGeoJSON() {
    const features = [];
    for (const [id, s] of this.stops) {
      if (!isFinite(s.lat) || !isFinite(s.lon)) continue;
      features.push({ type: 'Feature', properties: { id, n: titleCase(s.name), k: s.k }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } });
    }
    return { type: 'FeatureCollection', features };
  }
}
