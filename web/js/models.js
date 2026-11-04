// Procedural low-poly train models (generic shapes, not replicas of any real unit).
// Units are metres. Each model faces +X, is centred on the origin, sits on z = 0 (z up).
// Every model has four parts so all trains of a kind render as 4 instanced draw calls:
//   body   painted shell             glass  windows, underframe, bogies (dark)
//   accent livery stripe + roof light (per-instance colour)
//   lights head/tail lights (vertex colours)

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const W = 2.9;      // body width
const H = 3.95;     // roof height
const FLOOR = 0.6;  // bottom of the body shell

function bezier(out, p0, p1, p2, p3, n = 10) {
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
}

// End profiles as [distance back from the end face, height], bottom → top.
const END = {
  hs: { cut: 13, pts() { const o = [[13, FLOOR]]; bezier(o, [13, FLOOR], [4, FLOOR], [0, FLOOR + 0.15], [0, FLOOR + 0.85]); bezier(o, [0, FLOOR + 0.85], [0.8, 2.3], [6, H], [13, H], 14); return o; } },
  mid: { cut: 7, pts() { const o = [[7, FLOOR]]; bezier(o, [7, FLOOR], [2, FLOOR], [0, FLOOR + 0.2], [0, FLOOR + 1.0]); bezier(o, [0, FLOOR + 1.0], [0.6, 2.6], [3.2, H], [7, H], 12); return o; } },
  emu: { cut: 2.4, pts() { const o = [[1.2, FLOOR]]; bezier(o, [1.2, FLOOR], [0.2, FLOOR], [0, FLOOR + 0.2], [0, FLOOR + 1.0], 5); o.push([0.35, H - 1.3]); bezier(o, [0.35, H - 1.3], [0.6, H - 0.2], [1.3, H], [2.4, H], 6); return o; } },
  flat: { cut: 0.6, pts() { const o = [[0.4, FLOOR]]; bezier(o, [0.4, FLOOR], [0, FLOOR], [0, FLOOR], [0, FLOOR + 0.4], 3); o.push([0, H - 0.45]); bezier(o, [0, H - 0.45], [0, H], [0, H], [0.45, H], 3); return o; } },
};

function carBody(len, front, rear) {
  const f = END[front].pts().map(([dx, y]) => [len - dx, y]);          // front, bottom → top
  const r = END[rear].pts().map(([dx, y]) => [dx, y]).reverse();       // rear, top → bottom
  const shape = new THREE.Shape([...f, ...r].map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: W, bevelEnabled: true, bevelThickness: 0.16, bevelSize: 0.16, bevelSegments: 2, curveSegments: 4 });
  g.rotateX(Math.PI / 2);         // shape Y (height) -> world Z, extrusion -> -Y
  g.translate(0, W / 2, 0);       // centre across the width
  return g;
}

const box = (sx, sy, sz, x, y, z) => new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z);

function colored(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[3 * i] = c.r; arr[3 * i + 1] = c.g; arr[3 * i + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** cars: [length, frontProfile, rearProfile][] listed rear → front. */
function buildTrain(cars, gap = 0.7) {
  const body = [], glass = [], accent = [], lights = [];
  let x = 0;
  cars.forEach(([len, front, rear], i) => {
    const b = carBody(len, front, rear).translate(x, 0, 0);
    body.push(b);
    const fc = END[front].cut, rc = END[rear].cut;
    // window band
    glass.push(box(len - fc - rc - 0.8, W + 0.4, 0.78, x + rc + 0.4 + (len - fc - rc - 0.8) / 2, 0, 2.72));
    // windscreen for cab ends
    if (front === 'hs' || front === 'mid') {
      const ws = box(front === 'hs' ? 5.2 : 3.4, W * 0.72, 0.1, 0, 0, 0);
      ws.rotateY(front === 'hs' ? 0.36 : 0.5).translate(x + len - (front === 'hs' ? 7.6 : 3.6), 0, front === 'hs' ? 3.05 : 2.95);
      glass.push(ws);
    } else if (front === 'emu') glass.push(box(0.3, W * 0.8, 1.05, x + len - 0.12, 0, H - 1.05));
    if (rear === 'hs' || rear === 'mid') {
      const ws = box(rear === 'hs' ? 5.2 : 3.4, W * 0.72, 0.1, 0, 0, 0);
      ws.rotateY(-(rear === 'hs' ? 0.36 : 0.5)).translate(x + (rear === 'hs' ? 7.6 : 3.6), 0, rear === 'hs' ? 3.05 : 2.95);
      glass.push(ws);
    } else if (rear === 'emu') glass.push(box(0.3, W * 0.8, 1.05, x + 0.12, 0, H - 1.05));
    // underframe & bogies
    glass.push(box(len - 1.6, W - 0.7, 0.5, x + len / 2, 0, 0.42));
    glass.push(box(3.0, W - 0.3, 0.62, x + 3.2, 0, 0.36), box(3.0, W - 0.3, 0.62, x + len - 3.2, 0, 0.36));
    // livery stripe along the whole car + roof light strip
    accent.push(box(len - 0.5, W + 0.44, 0.26, x + len / 2, 0, 1.3));
    accent.push(box(Math.max(2, len - fc - rc - 1.5), 0.34, 0.08, x + rc + 0.75 + Math.max(2, len - fc - rc - 1.5) / 2, 0, H + 0.2));
    // head / tail lights on the outer ends
    if (i === cars.length - 1) for (const y of [-0.85, 0.85]) lights.push(colored(box(0.14, 0.5, 0.2, x + len + 0.06, y, FLOOR + 0.55), 0xf4fbff));
    if (i === 0) for (const y of [-0.85, 0.85]) lights.push(colored(box(0.14, 0.5, 0.2, x - 0.06, y, FLOOR + 0.55), 0xff2440));
    x += len + gap;
  });
  const length = x - gap;
  const flat = (list) => mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)));
  const parts = { body: flat(body), glass: flat(glass), accent: flat(accent), lights: flat(lights) };
  for (const g of Object.values(parts)) { g.translate(-length / 2, 0, 0); g.computeBoundingSphere(); }
  return { length, width: W, parts };
}

export function buildTrainModels() {
  const mid = (n, len) => Array.from({ length: n }, () => [len, 'flat', 'flat']);
  return {
    // high speed: long noses both ends (AVE, AVLO, Avant, Euromed)
    hs: buildTrain([[26, 'flat', 'hs'], ...mid(5, 25), [26, 'hs', 'flat']]),
    // long distance: medium noses (Alvia, Intercity)
    ld: buildTrain([[22, 'flat', 'mid'], ...mid(4, 20), [22, 'mid', 'flat']]),
    // regional EMU
    md: buildTrain([[26, 'flat', 'emu'], [25, 'flat', 'flat'], [26, 'emu', 'flat']]),
    // commuter EMU
    cer: buildTrain([[25, 'flat', 'emu'], ...mid(2, 24), [25, 'emu', 'flat']]),
  };
}
