// Follow camera: "top" (overhead, follows the train) and "chase" (third person behind the train).
// In follow modes MapLibre's own gestures are disabled and replaced: wheel = distance,
// drag = orbit around the train (chase) — or release back to free mode (top).

import { offset } from '/shared/geo.mjs';

const lerp = (a, b, k) => a + (b - a) * k;
const lerpAngle = (a, b, k) => { const d = ((b - a + 540) % 360) - 180; return (a + d * k + 360) % 360; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class CameraRig extends EventTarget {
  constructor(map, store, layer) {
    super();
    this.map = map;
    this.store = store;
    this.layer = layer;
    this.mode = 'free';
    this.topZoom = 14.5;
    this.headingUp = false;
    this.dist = 260;     // chase: metres behind the train centre
    this.alt = 75;       // chase: camera altitude (m)
    this.yaw = 0;        // chase: orbit offset (deg)
    this.smoothBearing = null;
    this.last = performance.now();
    this.enteredAt = 0;
    this._bind();
  }

  setMode(mode) {
    if (mode !== 'free' && !this.store.selectedId) mode = 'free';
    if (mode === this.mode) return;
    this.mode = mode;
    this.enteredAt = performance.now();
    this.smoothBearing = null;
    if (mode === 'chase') {
      const t = this.store.trains.get(this.store.selectedId);
      const L = t ? this.layer.modelLength(t.d.cat) : 150;
      this.dist = L / 2 + 75; this.alt = 32; this.yaw = 0;
    }
    if (mode === 'top') this.topZoom = Math.max(13.5, Math.min(16, this.map.getZoom() + 4));
    const h = this.map;
    const handlers = [h.dragPan, h.dragRotate, h.scrollZoom, h.touchZoomRotate, h.doubleClickZoom, h.keyboard, h.touchPitch];
    for (const x of handlers) mode === 'free' ? x.enable() : x.disable();
    this.dispatchEvent(new Event('mode'));
  }

  update() {
    const now = performance.now();
    const dt = Math.min(1, (now - this.last) / 1000); // real frame time: no lag when frames are slow
    this.last = now;
    if (this.mode === 'free') return;
    const t = this.store.updateOne(this.store.selectedId); // same position the frame will draw
    if (!t || !t.disp) { this.setMode('free'); return; }
    const p = t.disp;
    this.smoothBearing = this.smoothBearing == null ? p.bearing : lerpAngle(this.smoothBearing, p.bearing, 1 - Math.exp(-dt / 0.5));

    let target;
    if (this.mode === 'top') {
      target = { center: [p.lon, p.lat], zoom: this.topZoom, bearing: this.headingUp ? this.smoothBearing : this.map.getBearing(), pitch: 0 };
      if (!this.headingUp && performance.now() - this.enteredAt < 1500) target.bearing = 0;
    } else {
      const b = this.smoothBearing + this.yaw;
      const cam = offset(p.lon, p.lat, b + 180, this.dist);
      const look = offset(p.lon, p.lat, b, Math.min(600, 30 + this.dist * 0.25));
      target = this.map.calculateCameraOptionsFromTo(cam, this.alt, look, 0);
      target.pitch = clamp(target.pitch, 0, 84);
    }
    this._approach(target, dt);
  }

  _approach(target, dt) {
    const m = this.map;
    const entering = performance.now() - this.enteredAt < 1600;
    const k = 1 - Math.exp(-dt / (entering ? 0.32 : 0.05));
    const c = m.getCenter();
    const tc = Array.isArray(target.center) ? { lng: target.center[0], lat: target.center[1] } : target.center;
    m.jumpTo({
      center: [lerp(c.lng, tc.lng, k), lerp(c.lat, tc.lat, k)],
      zoom: lerp(m.getZoom(), target.zoom, k),
      bearing: lerpAngle(m.getBearing(), target.bearing, k),
      pitch: lerp(m.getPitch(), target.pitch, k),
    });
  }

  _bind() {
    const el = this.map.getCanvasContainer();
    el.addEventListener('wheel', (e) => {
      if (this.mode === 'free') return;
      e.preventDefault();
      const f = Math.exp(e.deltaY * 0.0012);
      if (this.mode === 'chase') { this.dist = clamp(this.dist * f, 25, 8000); this.alt = clamp(this.alt * f, 4, 4000); }
      else this.topZoom = clamp(this.topZoom - e.deltaY * 0.0025, 7, 19.5);
    }, { passive: false });

    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (this.mode === 'free') return;
      drag = { x: e.clientX, y: e.clientY, moved: false };
    });
    window.addEventListener('pointermove', (e) => {
      if (!drag || this.mode === 'free') return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      drag.x = e.clientX; drag.y = e.clientY;
      if (this.mode === 'chase') {
        this.yaw = (this.yaw - dx * 0.3 + 360) % 360;
        this.alt = clamp(this.alt * Math.exp(dy * 0.006), 4, 4000);
      } else if (drag.moved) {
        this.setMode('free');
        drag = null;
      }
    });
    window.addEventListener('pointerup', () => { if (drag) this.lastDragMoved = drag.moved; drag = null; });
  }
}
