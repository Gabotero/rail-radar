// MapLibre custom 3D layer that draws every train with Three.js (instanced: ~20 draw calls total).
//
// Precision: positions are expressed in metres relative to the current map centre, and the
// centre's mercator offset is folded into the projection matrix each frame, so models don't
// jitter at street-level zoom.

import * as THREE from 'three';
import { buildTrainModels } from './models.js';
import { CAT_COLORS, LEVEL_HEX } from './theme.js';

const KINDS = ['hs', 'ld', 'md', 'cer'];
const PARTS = ['body', 'glass', 'accent', 'lights'];
const MAX = 1500;
const MIN_PX = 28;          // a train is never drawn shorter than this on screen
const FOCUS_MIN_PX = 54;    // ...and the two trains of a focused warning never shorter than this
const D2R = Math.PI / 180;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
// Real trains are ~60x longer than wide, so at map scale they'd be hairlines. Below zoom ~16.5 the
// width is exaggerated to a minimum on-screen size; close up the true proportions come back.
const minWidthPx = (zoom) => 8 * clamp01((16.5 - zoom) / 4.5);
const focusWidthPx = (zoom) => 11 * clamp01((17.5 - zoom) / 4.5);
const WHITE = new THREE.Color(0xe9eef5);

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class TrainsLayer {
  constructor(store) {
    this.id = 'trains3d';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.store = store;
    this.models = buildTrainModels();
    this.scaleOf = new Map(); // id -> current visual scale (used for picking)
  }

  onAdd(map, gl) {
    this.map = map;
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x0b1220, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(-0.35, -0.75, 1);
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x7fe3ff, 1.1);
    rim.position.set(0.7, 0.6, 0.35);
    this.scene.add(rim);

    const mats = {
      body: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.45, roughness: 0.38, emissive: 0x141c28 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x0a1420, metalness: 0.85, roughness: 0.2, emissive: 0x050d18 }),
      accent: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      lights: new THREE.MeshBasicMaterial({ vertexColors: true }),
    };
    this.meshes = {};
    for (const k of KINDS) {
      this.meshes[k] = {};
      for (const part of PARTS) {
        const m = new THREE.InstancedMesh(this.models[k].parts[part], mats[part], MAX);
        m.count = 0;
        m.frustumCulled = false;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (part === 'accent' || part === 'body') {
          m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
          m.instanceColor.setUsage(THREE.DynamicDrawUsage);
        }
        this.scene.add(m);
        this.meshes[k][part] = m;
      }
    }

    const glowMat = new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.glow = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMat, MAX);
    this.glow.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = -1;
    this.scene.add(this.glow);

    const ringMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.rings = new THREE.InstancedMesh(new THREE.RingGeometry(0.465, 0.5, 72), ringMat, 256);
    this.rings.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(256 * 3), 3);
    this.rings.frustumCulled = false;
    this.scene.add(this.rings);

    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this._z = new THREE.Vector3(0, 0, 1);
    this._accent = new THREE.Color();
  }

  render(gl, args) {
    const map = this.map;
    const store = this.store;
    store.updateDisplay();

    const MC = window.maplibregl.MercatorCoordinate;
    const center = map.getCenter();
    const origin = MC.fromLngLat(center, 0);
    const mpu = origin.meterInMercatorCoordinateUnits();
    const zoom = map.getZoom();
    const cosO = Math.cos(center.lat * D2R);
    this.camera.projectionMatrix
      .fromArray(args.defaultProjectionData.mainMatrix)
      .multiply(this._m.makeTranslation(origin.x, origin.y, 0))
      .multiply(new THREE.Matrix4().makeScale(mpu, -mpu, mpu));

    const counts = { hs: 0, ld: 0, md: 0, cer: 0 };
    let g = 0, r = 0;
    const t = performance.now() / 1000;
    const glowK = zoom < 12 ? 1 : Math.max(0.15, 1 - (zoom - 12) / 4);
    const flagged = store.conflictLevelByTrain;
    const focus = store.focus;
    const wPx = minWidthPx(zoom), fwPx = focusWidthPx(zoom);

    for (const tr of store.trains.values()) {
      if (!tr.disp || !store.isVisible(tr)) continue;
      const d = tr.d;
      const kind = KINDS.includes(d.cat) ? d.cat : 'ld';
      const model = this.models[kind];
      const p = tr.disp;
      const m = MC.fromLngLat([p.lon, p.lat], 0);
      const x = (m.x - origin.x) / mpu;
      const y = -(m.y - origin.y) / mpu;
      const cosL = Math.cos(p.lat * D2R);
      const latF = cosO / cosL;
      const mpp = (40075016.686 * cosL) / (512 * 2 ** zoom);
      const focused = !!focus && (focus.a === tr.id || focus.b === tr.id);
      const dim = !!focus && !focused;
      const s = Math.max(1, ((focused ? FOCUS_MIN_PX : MIN_PX) * mpp) / model.length);   // along the train
      const sw = Math.max(s, ((focused ? fwPx : wPx) * mpp) / model.width);              // across it
      this.scaleOf.set(tr.id, s);

      this._q.setFromAxisAngle(this._z, (90 - p.bearing) * D2R);
      this._p.set(x, y, 0);
      // height grows with the width, so the cross-section keeps a train's shape (taller than wide)
      // and trains stand up clearly above the flat rails in tilted views
      this._s.set(s * latF, sw * latF, sw * latF);
      this._m.compose(this._p, this._q, this._s);

      const i = counts[kind]++;
      const set = this.meshes[kind];
      for (const part of PARTS) set[part].setMatrixAt(i, this._m);

      const accent = this._accent.set(d.cat === 'cer' && d.color ? d.color : CAT_COLORS[kind]);
      const fade = p.stale ? 0.25 : dim ? 0.3 : 1;
      this._c.copy(accent).multiplyScalar(fade);
      set.accent.setColorAt(i, this._c);
      // bright body: stands out against every rail colour (the category colour is in the stripe and glow)
      if (p.stale) this._c.set(0x4a5566);
      else this._c.copy(WHITE).lerp(accent, 0.12);
      if (dim) this._c.multiplyScalar(0.3);
      set.body.setColorAt(i, this._c);

      const lvl = flagged.get(tr.id);
      // Glow: a soft streak in the category colour along the train, wider than the body so it
      // shows around it. Fades when close. Watch/warning trains glow in the level colour instead.
      if (g < MAX) {
        const gl = (model.length * s + 14 * mpp) * 1.35 * latF;
        const gw = (model.width * sw * 3.2 + 12 * mpp) * latF;
        this._p.set(x, y, 0.15);
        this._s.set(gl, gw, 1);
        this._m.compose(this._p, this._q, this._s);
        this.glow.setMatrixAt(g, this._m);
        if (lvl && !focus) this._c.setHex(LEVEL_HEX[lvl]).multiplyScalar(0.5 * glowK + 0.08);
        else this._c.copy(accent).multiplyScalar((p.stale ? 0.1 : dim ? 0.05 : 0.55) * glowK + (focused ? 0.2 : 0));
        this.glow.setColorAt(g++, this._c);
      }
      // focused trains: an extra large pulsing halo in the warning's colour (no rings on top of them)
      if (focused && g < MAX) {
        const gd = MIN_PX * 2.6 * mpp * latF;
        this._p.set(x, y, 0.1);
        this._s.set(gd, gd, 1);
        this._m.compose(this._p, this._q.identity(), this._s);
        this.glow.setMatrixAt(g, this._m);
        this._c.setHex(LEVEL_HEX[focus.level] ?? 0xffffff).multiplyScalar(0.45 + 0.2 * Math.sin(t * 4));
        this.glow.setColorAt(g++, this._c);
      }

      // rings (no focused warning only): warning / critical trains, and the selected train when zoomed out
      if (focus) continue;
      const selected = store.selectedId === tr.id && s > 1.3;
      const ringLvl = lvl === 'critical' || lvl === 'warning' ? lvl : null;
      if ((selected || ringLvl) && r < 256) {
        const base = Math.max(model.length * s, model.width * sw * 4) * latF * 0.95;
        const pulse = 1 + 0.08 * Math.sin(t * (ringLvl === 'critical' ? 9 : 4) + i);
        this._p.set(x, y, 0.4);
        this._s.set(base * pulse, base * pulse, 1);
        this._m.compose(this._p, this._q.identity(), this._s);
        this.rings.setMatrixAt(r, this._m);
        this._c.setHex(ringLvl ? LEVEL_HEX[ringLvl] : 0xb0c8e0).multiplyScalar(0.7);
        this.rings.setColorAt(r++, this._c);
      }
    }

    for (const k of KINDS) for (const part of PARTS) {
      const mesh = this.meshes[k][part];
      mesh.count = counts[k];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.glow.count = g;
    this.glow.instanceMatrix.needsUpdate = true;
    this.glow.instanceColor.needsUpdate = true;
    this.rings.count = r;
    this.rings.instanceMatrix.needsUpdate = true;
    this.rings.instanceColor.needsUpdate = true;

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    map.triggerRepaint();
  }

  /** Visual length in metres of a train right now (for picking & camera distance). */
  visualLength(tr) {
    const kind = KINDS.includes(tr.d.cat) ? tr.d.cat : 'ld';
    return this.models[kind].length * (this.scaleOf.get(tr.id) || 1);
  }
  modelLength(cat) { return this.models[KINDS.includes(cat) ? cat : 'ld'].length; }
}
