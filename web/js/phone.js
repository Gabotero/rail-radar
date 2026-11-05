// Phone layout: the map fills the screen, with tabs along the bottom and the panels as sheets you can drag.
// All of this runs only on phone-sized screens; on a computer this module does nothing. The existing panels
// are reused (ui.js keeps filling them), so phones and computers always show the same data.

import { accentOf, trainName, esc } from './ui.js';

// Same query as the <link> for phone.css in index.html. A phone is told apart by its screen, not its window,
// so a narrow window on a computer keeps the computer layout. Small tablets held upright also count.
export const PHONE_QUERY = '(max-device-width: 500px), (max-device-height: 500px), (pointer: coarse) and (max-width: 860px)';

const SPAIN = [[-9.6, 35.9], [3.5, 43.9]];
const WIDE_BOUNDS = [[-22, 18], [18, 58]]; // the computer limits are too tight to show all of Spain on a tall screen
const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };
const REPAINT_MS = 33;                     // about 30 frames a second: trains move slowly, and it saves battery
const $ = (s, root = document) => root.querySelector(s);
const landscape = window.matchMedia('(orientation: landscape)');

const ICONS = {
  notices: '<path d="M12 3.5 21 12l-9 8.5L3 12z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 8.5v4.2M12 15.4v.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  network: '<path d="M12 4 3.5 8.5 12 13l8.5-4.5zM3.5 12.5 12 17l8.5-4.5M3.5 16 12 20.5 20.5 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  about: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 11v5.2M12 7.8v.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

/** A panel that rests at named heights. It moves by transform only, so dragging never re-lays out the page. */
class Sheet {
  constructor(el, stops, onChange, onTap) {
    Object.assign(this, { el, stops, onChange, onTap });
    this.state = 'closed';
    el.dataset.state = 'closed';
  }

  set(state) {
    const was = this.state;
    this.state = state;
    this.el.dataset.state = state;
    this.place();
    if (state !== was) this.onChange?.(state);
  }

  place() {
    const { el } = this;
    if (landscape.matches || this.state === 'closed') {
      el.style.transform = '';
      el.style.removeProperty('--ph-hidden');
      return;
    }
    const y = Math.max(0, el.offsetHeight - this.stops()[this.state]);
    el.style.transform = `translate3d(0, ${y}px, 0)`;
    el.style.setProperty('--ph-hidden', `${y}px`);
  }

  grab(target, signal) {
    target.addEventListener('pointerdown', (e) => {
      if (landscape.matches || e.target.closest('button, a, input, summary')) return;
      const { el } = this;
      const H = el.offsetHeight, startY = e.clientY;
      const y0 = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
      let y = y0, moved = false, lastY = startY, lastT = e.timeStamp, v = 0;
      target.setPointerCapture?.(e.pointerId);
      const move = (ev) => {
        const dy = ev.clientY - startY;
        if (!moved && Math.abs(dy) < 5) return;
        if (!moved) { moved = true; el.classList.add('ph-drag'); }
        y = Math.max(0, Math.min(H, y0 + dy));
        el.style.transform = `translate3d(0, ${y}px, 0)`;
        const dt = ev.timeStamp - lastT;
        if (dt > 0) v = 0.7 * ((ev.clientY - lastY) / dt) + 0.3 * v;
        lastY = ev.clientY; lastT = ev.timeStamp;
      };
      const up = (ev) => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        el.classList.remove('ph-drag');
        if (!moved) { if (ev.type === 'pointerup') this.onTap?.(); return; }
        this._settle(H - y, ev.timeStamp - lastT > 90 ? 0 : v);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    }, { signal });
  }

  /** Picks where to rest: the next height in the direction of a flick, otherwise the nearest one. */
  _settle(visible, v) {
    const stops = [['closed', 0], ...Object.entries(this.stops()).sort((a, b) => a[1] - b[1])];
    let pick;
    if (v < -0.45) pick = stops.find(([, h]) => h > visible + 1) ?? stops.at(-1);
    else if (v > 0.45) pick = [...stops].reverse().find(([, h]) => h < visible - 1) ?? stops[0];
    else pick = stops.reduce((a, b) => (Math.abs(b[1] - visible) < Math.abs(a[1] - visible) ? b : a));
    this.set(pick[0]);
    if (pick[0] === this.state) this.place();
  }
}

export class PhoneUI {
  constructor(deps) {
    Object.assign(this, deps);
    this.active = false;
    this.mq = window.matchMedia(PHONE_QUERY);
    this.mq.addEventListener('change', () => (this.mq.matches ? this._enable() : this._disable()));
    if (this.mq.matches) this._enable();
  }

  // ---------- what main.js asks for ----------

  /** A tap on the map: on a train (t), or on empty map. */
  mapTapped(t) {
    if (!this.active) return;
    if (!t) { this.sheet.set('closed'); if (this.trainSheet.state === 'full') this.trainSheet.set('peek'); return; }
    if (this.store.focus) {             // the notice stays on the map, and the tapped train's details open
      document.body.classList.remove('ph-hide-train');
      this.trainSheet.set('peek');
      this._padding();
    }
  }

  /** Room around the two trains of a notice: the part of the map not covered by the top bar or the sheet. */
  fitPadding() {
    this.map.setPadding(NO_PADDING);
    const top = $('.topbar').offsetHeight;
    if (landscape.matches) return { top: top + 44, bottom: 24, left: this.left.offsetWidth + 34, right: 34 };
    return { top: top + 56, bottom: $('.ph-dock').offsetHeight + this.sheet.stops().focus + 30, left: 36, right: 36 };
  }

  // ---------- set-up ----------

  _enable() {
    if (this.active) return;
    this.active = true;
    const { map, store, rig, layer } = this;
    const ac = this.ac = new AbortController();
    const on = (target, type, fn, opts) => target.addEventListener(type, fn, { signal: ac.signal, ...opts });
    this.made = [];
    this.moved = [];
    const left = this.left = $('#left');
    const train = this.train = $('#train-panel');
    const [network, notices] = left.querySelectorAll('section');
    this.noticesSection = notices;
    network.classList.add('ph-network');

    // tabs along the bottom
    const dock = this._make('nav', 'ph-dock', document.body);
    dock.setAttribute('aria-label', 'Panels');
    dock.innerHTML = [['notices', 'Notices'], ['network', 'Network'], ['about', 'About']].map(([k, label]) =>
      `<button class="ph-tab" data-tab="${k}" aria-expanded="false"><span class="ph-ic">${icon(k)}<i class="${k === 'notices' ? 'ph-badge' : 'ph-dot'}" hidden></i></span>${label}</button>`).join('');
    on(dock, 'click', (e) => { const b = e.target.closest('.ph-tab'); if (b) this._tapTab(b.dataset.tab); });
    this.badge = $('.ph-badge', dock);
    this.dot = $('.ph-dot', dock);

    // panel contents that live elsewhere on a computer
    this._move($('#alert-summary'), $('.sec-head', notices));
    this._move($('#feeds'), network);
    const about = this._make('section', 'ph-about', left);
    about.innerHTML = `
      <h3>About</h3>
      <p>A live 3D map of Spanish trains, built from Renfe's public GPS feeds and OpenStreetMap track data. Iryo and Ouigo publish no live positions, so they are not shown.</p>
      <div class="ph-slot-foot"></div>
      <div class="ph-slot-credit"></div>
      <h3>On a phone</h3>
      <ul>
        <li><b>Tap a train</b> to follow it from above, or from behind in Chase.</li>
        <li><b>Tap a notice</b> to see those two trains on the map.</li>
        <li><b>Pinch</b> to zoom. Drag up with two fingers to tilt, and twist to turn.</li>
      </ul>
      <h3>Data</h3>
      <ul>
        <li>Trains: <a href="https://data.renfe.com" target="_blank" rel="noopener">Renfe Operadora</a>, CC BY 4.0</li>
        <li>Track: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors, ODbL</li>
        <li>Basemap: <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>, © OpenMapTiles</li>
      </ul>`;
    this._move($('.foot'), $('.ph-slot-foot', about));
    this._move($('.credit'), $('.ph-slot-credit', about));

    // search shows its results as a list: on a phone the map is behind the keyboard
    const search = $('#search');
    search.setAttribute('enterkeyhint', 'search');
    this.results = this._make('div', 'ph-results', network);
    on(search, 'input', () => this._renderResults());
    on(search, 'focus', () => this.sheet.set('full'));
    on(this.results, 'click', (e) => {
      const b = e.target.closest('.ph-hit');
      if (!b) return;
      search.blur();
      store.select(b.dataset.id);
      rig.setMode('top');
    });

    // the sheets
    const handle = this._make('div', 'ph-handle', left, left.firstChild);
    handle.innerHTML = '<i></i><button class="ph-close" aria-label="Back to the list"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>';
    on($('.ph-close', handle), 'click', () => store.setFocus(null));
    this.handle = handle;
    this.sheet = new Sheet(left, () => this._sheetStops(), (s) => this._sheetChanged(s), () => {
      this.sheet.set(this.sheet.state === 'half' ? 'full' : 'half');
    });
    this.sheet.grab(handle, ac.signal);
    this.sheet.grab($('.sec-head', notices), ac.signal);

    const trainHandle = this._make('div', 'ph-handle', train, train.firstChild);
    trainHandle.innerHTML = '<i></i>';
    this.trainSheet = new Sheet(train, () => this._trainStops(), (s) => { if (s === 'closed' && store.selectedId) store.select(null); }, () => {
      this.trainSheet.set(this.trainSheet.state === 'peek' ? 'full' : 'peek');
    });
    for (const el of [trainHandle, $('.tp-head', train), $('.tp-route', train)]) {
      el.classList.add('ph-grab');
      this.trainSheet.grab(el, ac.signal);
    }
    this.trainObserver = new ResizeObserver(() => { if (!train.hidden && this.trainSheet.state !== 'closed') this.trainSheet.place(); });
    this.trainObserver.observe(train);

    // the list is redrawn every second: wait while it is moving, so a scroll is never interrupted
    on(notices, 'scroll', () => {
      this.ui.holdList(true);
      clearTimeout(this.scrollT);
      this.scrollT = setTimeout(() => this.ui.holdList(false), 250);
    }, { passive: true });

    // connection light in the top bar
    this.live = this._make('i', 'ph-live', $('.tb-right'), $('#clock'));
    this.live.title = 'Live data';
    this.liveTimer = setInterval(() => this._live(), 2000);
    on(store, 'connection', () => this._live());

    // the map: all of Spain on the screen, smaller trains while zoomed out, fewer frames, no zoom buttons
    map.setMinZoom(3.6);
    map.setMaxBounds(WIDE_BOUNDS);
    map.jumpTo(this._overview());
    layer.sizeK = (zoom) => 0.45 + 0.55 * Math.max(0, Math.min(1, (zoom - 5.5) / 5));
    layer.repaintMs = REPAINT_MS;
    this.home = {
      onAdd: () => {
        const c = document.createElement('div');
        c.className = 'maplibregl-ctrl maplibregl-ctrl-group ph-home';
        c.innerHTML = '<button type="button" aria-label="Show all of Spain" title="Show all of Spain"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
        c.firstChild.addEventListener('click', () => map.flyTo({ ...this._overview(), padding: NO_PADDING, duration: 1300 }));
        this.homeEl = c;
        return c;
      },
      onRemove: () => this.homeEl.remove(),
    };
    map.addControl(this.home, 'bottom-right');
    map.on('moveend', this._onMoveEnd = () => this._viewChanged());
    // the data credits start open, then fold into the (i) button. The About tab lists them too.
    this.attribTimer = setTimeout(() => {
      const a = $('.maplibregl-ctrl-attrib');
      a?.classList.remove('maplibregl-compact-show');
      a?.removeAttribute('open');
    }, 6000);

    // keeping in step with the app
    on(store, 'select', () => this._onSelect());
    on(store, 'focus', () => this._onFocus());
    on(store, 'conflicts', () => this._onConflicts());
    on(store, 'filters', () => this._onFilters());
    on(rig, 'mode', () => this._padding());
    on(window, 'resize', () => this._relayout());
    on(landscape, 'change', () => this._relayout());
    on(window, 'popstate', () => this._onBack());

    this._onSelect();
    this._onFilters();
    this._live();
  }

  _disable() {
    if (!this.active) return;
    this.active = false;
    const { map, layer } = this;
    this.ac.abort();
    this.trainObserver.disconnect();
    clearInterval(this.liveTimer);
    clearTimeout(this.scrollT);
    clearTimeout(this.attribTimer);
    this.ui.holdList(false);
    map.off('moveend', this._onMoveEnd);
    map.removeControl(this.home);
    map.setMinZoom(this.computer.minZoom);
    map.setMaxBounds(this.computer.maxBounds);
    map.setPadding(NO_PADDING);
    layer.sizeK = null;
    layer.repaintMs = 0;
    for (const [node, parent, next] of this.moved.reverse()) parent.insertBefore(node, next);
    for (const node of this.made) node.remove();
    for (const el of [this.left, this.train]) {
      el.style.transform = '';
      el.style.removeProperty('--ph-hidden');
      delete el.dataset.state;
      delete el.dataset.tab;
    }
    document.querySelectorAll('.ph-grab, .ph-network').forEach((e) => e.classList.remove('ph-grab', 'ph-network'));
    document.body.classList.remove('ph-hide-train', 'ph-tilted', 'ph-away');
    if (this.backHeld) { this.backHeld = false; this.ignorePop = true; history.back(); }
    this.onDisable?.();
  }

  _make(tag, className, parent, before = null) {
    const el = document.createElement(tag);
    el.className = className;
    parent.insertBefore(el, before);
    this.made.push(el);
    return el;
  }

  _move(node, parent) {
    this.moved.push([node, node.parentElement, node.nextSibling]);
    parent.append(node);
  }

  // ---------- sheets ----------

  _sheetStops() {
    const H = this.left.offsetHeight;
    const stops = { half: Math.round(Math.min(H, Math.max(300, H * 0.6))), full: H };
    if (this.store.focus && this.left.dataset.tab === 'notices') stops.focus = this._focusHeight();
    return stops;
  }

  _focusHeight() {
    const card = $('.conflict.focused', this.left);
    return this.handle.offsetHeight + (card ? card.offsetHeight : 170) + 12;
  }

  _trainStops() {
    const el = this.train;
    const end = $('.seg', el).getBoundingClientRect().bottom - el.getBoundingClientRect().top;
    const safe = parseFloat(getComputedStyle($('.ph-dock')).paddingBottom) || 0;
    return { peek: Math.round(end + 14 + safe), full: el.offsetHeight };
  }

  _tapTab(tab) {
    const { sheet, left } = this;
    if (left.dataset.tab === tab && sheet.state !== 'closed' && sheet.state !== 'focus') { sheet.set('closed'); return; }
    left.dataset.tab = tab;
    sheet.set('half');
    this._sheetChanged(sheet.state);
  }

  _sheetChanged(state) {
    for (const b of document.querySelectorAll('.ph-tab')) b.setAttribute('aria-expanded', String(state !== 'closed' && b.dataset.tab === this.left.dataset.tab));
    if (state === 'closed') $('#search').blur();
    this._syncBack();
  }

  _relayout() {
    this.sheet.place();
    if (!this.train.hidden) this.trainSheet.place();
    this._padding();
    this._viewChanged();
  }

  // ---------- following the app's state ----------

  _onSelect() {
    const { store, trainSheet } = this;
    const selected = !!store.selectedId && store.trains.has(store.selectedId);
    if (!selected) {
      if (trainSheet.state !== 'closed') trainSheet.set('closed');
    } else if (!store.focus) {
      this.sheet.set('closed');
      if (store.query) {                 // filtering is for finding the train: bring the others back
        $('#search').value = '';
        store.setQuery('');
        this._renderResults();
      }
      trainSheet.set('peek');
    }
    this._padding();
    this._syncBack();
  }

  _onFocus() {
    const { store, sheet, left } = this;
    if (store.focus) {
      document.body.classList.add('ph-hide-train');
      left.dataset.tab = 'notices';
      this.noticesSection.scrollTop = 0;
      sheet.set('focus');
      this._sheetChanged('focus');
      return;
    }
    document.body.classList.remove('ph-hide-train');
    if (sheet.state === 'focus') {       // back to the list of notices
      store.select(null);
      sheet.set('half');
    }
  }

  _onConflicts() {
    const list = this.store.visibleConflicts().filter((c) => c.level !== 'info');
    const top = ['critical', 'warning', 'watch'].find((l) => list.some((c) => c.level === l));
    this.badge.hidden = !list.length;
    this.badge.textContent = list.length > 99 ? '99+' : list.length;
    if (top) this.badge.dataset.level = top;
    if (this.sheet.state === 'focus') this.sheet.place(); // the notice's text, and so its height, can change
  }

  _onFilters() {
    const { store } = this;
    this.dot.hidden = !store.query && Object.values(store.filters).every(Boolean);
    this._onConflicts();
  }

  _live() {
    const fresh = this.store.connected && performance.now() - this.store.lastMsgAt < 12000;
    this.live.classList.toggle('ok', fresh);
  }

  _renderResults() {
    const { store } = this;
    if (!store.query) { this.results.innerHTML = ''; return; }
    const hits = [...store.trains.values()].filter((t) => !t.d.dup && store.isVisible(t));
    this.results.innerHTML = hits.length ? hits.slice(0, 30).map((t) => {
      const d = t.d;
      const route = [d.from, d.to].filter(Boolean).join(' → ');
      return `<button class="ph-hit" data-id="${esc(t.id)}" style="--c:${esc(accentOf(d))}"><i></i><span><b>${esc(trainName(d))}</b><small>${esc(route || 'Route not known')}</small></span><em class="mono">${d.speed == null ? '—' : Math.round(d.speed * 3.6)} km/h</em></button>`;
    }).join('') : '<div class="empty">No trains match.</div>';
  }

  // ---------- the map ----------

  _overview() {
    const top = $('.topbar').offsetHeight, dock = landscape.matches ? 0 : ($('.ph-dock')?.offsetHeight ?? 58);
    const cam = this.map.cameraForBounds(SPAIN, { padding: { top: top + 14, bottom: dock + 14, left: 8, right: 8 } });
    return { ...cam, bearing: 0, pitch: 0 };
  }

  /** Keeps a followed train in the part of the map that the sheet leaves free. */
  _padding() {
    const { map, train, rig } = this;
    const shown = !train.hidden && !document.body.classList.contains('ph-hide-train');
    let pad = NO_PADDING;
    if (shown && landscape.matches) pad = { ...NO_PADDING, top: $('.topbar').offsetHeight, right: train.offsetWidth + 16 };
    else if (shown) pad = { ...NO_PADDING, top: $('.topbar').offsetHeight, bottom: this.trainSheet.stops().peek };
    const cur = map.getPadding();
    if (Object.keys(pad).every((k) => Math.round(cur[k]) === Math.round(pad[k]))) return;
    if (rig.mode === 'free') map.easeTo({ padding: pad, duration: 300 });
    else map.setPadding(pad);
  }

  _viewChanged() {
    const { map } = this;
    const home = this._overview();
    const tilted = Math.abs(map.getBearing()) > 1 || map.getPitch() > 1;
    const c = map.project(home.center), w = map.getContainer().clientWidth, h = map.getContainer().clientHeight;
    const away = tilted || map.getZoom() > home.zoom + 0.25 || Math.hypot(c.x - w / 2, c.y - h / 2) > 50;
    document.body.classList.toggle('ph-tilted', tilted);
    document.body.classList.toggle('ph-away', away);
  }

  // ---------- the phone's Back button closes what is open, instead of leaving the page ----------

  _syncBack() {
    const open = this.sheet.state !== 'closed' || !!this.store.selectedId;
    if (open && !this.backHeld) {
      history.pushState({ railRadarLayer: true }, '');
      this.backHeld = true;
    } else if (!open && this.backHeld) {
      this.backHeld = false;
      this.ignorePop = true;
      history.back();
    }
  }

  _onBack() {
    if (this.ignorePop) { this.ignorePop = false; return; }
    if (!this.backHeld) return;
    this.backHeld = false;
    if (this.store.selectedId) this.store.select(null);
    else this.sheet.set('closed');
    this._syncBack();
  }
}
