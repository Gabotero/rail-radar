// HUD: feed status, filters, warnings list, selected-train panel, camera controls, tooltip.

import { CAT_COLORS, CAT_LABELS, LEVEL_LABEL } from './theme.js';

const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const WARN_CHIPS = {
  following: ['Closing', 'A train closing on the one ahead on the same line'],
  opposing: ['Opposing', 'Trains heading towards each other where the map shows one track'],
  converging: ['Converging', 'Paths that cross at a junction'],
  passing: ['Crossings', 'Normal crossings where there is a second track (info only)'],
};
const SHORT_TYPE = { following: 'Same line', opposing: 'Opposing', converging: 'Converging', passing: 'Crossing' };
// The engine's notes, in words a viewer understands.
function plainNote(n) {
  return n
    .replace(/^data (\d+) s old$/, 'positions are $1 s old')
    .replace(/^(\d+) parallel tracks: may be on a different track$/, '$1 tracks side by side here: may be on different tracks')
    .replace(/^position = station coordinates, not GPS$/, 'one position is just the station, not GPS')
    .replace(/^not snapped to track$/, 'one train is off the mapped track')
    .replace(/^(.+): speed not yet measured \(single fix\), assumed stopped$/, '$1: speed not measured yet, assumed stopped')
    .replace(/^separation below braking distance but opening$/, 'close, but already pulling apart')
    .replace(/^approaching an occupied station$/, 'approaching a station where the other train is stopped')
    .replace(/^paths cross: junction or grade-separated crossing$/, 'may be a junction, or a bridge where the lines do not meet')
    // already said by the headline
    .replace(/^(single track between trains|second track available: normal crossing)$/, '');
}
/**
 * Gap trend arrow: three stacked chevrons with a light running up them (gap increasing, green) or down
 * them (gap decreasing, red). The faster the gap changes, the faster the light runs. Each chevron's
 * phase comes from the clock, so redrawing (the list is redrawn every second) never restarts it.
 * closing: m/s, > 0 = the gap is shrinking.
 */
export function trendArrow(closing) {
  const up = closing < 0;
  const kmh = Math.abs(closing) * 3.6;
  const dur = Math.max(0.45, Math.min(1.6, 1.6 - kmh / 120));
  const now = performance.now() / 1000;
  const paths = [];
  for (let row = 0; row < 3; row++) {          // rows top to bottom
    const order = up ? 2 - row : row;           // which chevron lights first: bottom if up, top if down
    const phase = (((now - (order * dur) / 3) % dur) + dur) % dur;
    const y = 1 + row * 5;
    const d = up ? `M1.5 ${y + 4}L6 ${y}L10.5 ${y + 4}` : `M1.5 ${y}L6 ${y + 4}L10.5 ${y}`;
    paths.push(`<path d="${d}" style="animation-delay:${(-phase).toFixed(3)}s"/>`);
  }
  return `<svg class="trend ${up ? 'up' : 'dn'}" viewBox="0 0 12 16" aria-hidden="true" style="--dur:${dur.toFixed(2)}s">${paths.join('')}</svg>`;
}
/** "gap decreasing @ 58 km/h" with its arrow, or "gap steady". */
export function trendText(closing) {
  const k = Math.round(Math.abs(closing ?? 0) * 3.6);
  if ((closing ?? 0) > 0.3) return `<span class="tr dn">${trendArrow(closing)}gap decreasing @ ${k} km/h</span>`;
  if ((closing ?? 0) < -0.3) return `<span class="tr up">${trendArrow(closing)}gap increasing @ ${k} km/h</span>`;
  return '<span class="tr steady">gap steady</span>';
}
export const isStopped = (d) => !!d && (d.speed ?? 0) < 0.5;
export const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);
const fmtAge = (s) => (s == null ? '—' : s < 0 ? 'now' : s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);
const STATUS_TXT = { IN_TRANSIT_TO: 'En route to', INCOMING_AT: 'Arriving at', STOPPED_AT: 'Stopped at' };
const CLS_TXT = { hs: 'High-speed line', main: 'Main line', branch: 'Branch line', narrow: 'Narrow gauge' };

export function trainName(d) {
  if (!d) return '';
  return d.cat === 'cer' ? `${d.line || 'C'} · ${d.num}` : `${d.product} ${d.num}`;
}
export const accentOf = (d) => (d.cat === 'cer' && d.color ? d.color : CAT_COLORS[d.cat] || CAT_COLORS.ld);

export class UI {
  constructor({ map, store, rig, layer, onFocusConflict }) {
    Object.assign(this, { map, store, rig, layer, onFocusConflict });
    this._filters();
    this._warnTypes();
    const how = $('#how-trend');
    if (how) how.innerHTML = `<span class="tr up">${trendArrow(-4)}gap increasing</span><span class="tr dn">${trendArrow(25)}gap decreasing</span>`;
    this._search();
    this._trainPanel();
    this._keys();
    store.addEventListener('status', () => this._feeds());
    store.addEventListener('conflicts', () => this._conflicts());
    store.addEventListener('filters', () => this._conflicts());
    store.addEventListener('focus', () => this._conflicts());
    const list = $('#conflicts');
    list.addEventListener('pointerdown', () => { this._listHeld = true; });
    const release = () => { if (this._listHeld) this.holdList(false); };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release); // a touch that turns into a scroll ends this way
    list.addEventListener('click', (e) => {
      const b = e.target.closest('.conflict');
      if (!b) return;
      if (store.focus?.key === b.dataset.key) { store.setFocus(null); return; }
      const c = store.conflicts.find((x) => x.key === b.dataset.key);
      if (c) this.onFocusConflict?.(c);
    });
    store.addEventListener('trains', () => this._counts());
    store.addEventListener('connection', () => this._feeds());
    store.addEventListener('select', () => this._onSelect());
    rig.addEventListener('mode', () => this._camButtons());
    setInterval(() => { this._clock(); this._updateTrainPanel(); }, 250);
    $('#menu-btn').addEventListener('click', () => document.body.classList.toggle('show-left'));
  }

  /** Stops redrawing the warnings list while it is being touched or scrolled; catches up on release. */
  holdList(on) {
    this._listHeld = on;
    if (!on && this._listDirty) { this._listDirty = false; setTimeout(() => this._conflicts(), 0); }
  }

  // ---------- top bar ----------
  _clock() {
    const t = new Date(this.store.serverNow());
    $('#clock').textContent = t.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour12: false });
  }

  _feeds() {
    const st = this.store.status;
    const box = $('#feeds');
    if (!this.store.connected && !st) { box.innerHTML = '<span class="feed bad"><i></i>Connecting…</span>'; return; }
    if (!st) return;
    const vp = st.feeds.filter((f) => f.kind === 'vp');
    const tu = st.feeds.filter((f) => f.kind === 'tu');
    const health = (f) => (f.publishedAgo == null ? 'bad' : f.publishedAgo < (f.cadence || 20) * 2 + 8 ? 'ok' : f.publishedAgo < 180 ? 'warn' : 'bad');
    box.innerHTML = vp.map((f) => `
      <span class="feed ${this.store.connected ? health(f) : 'bad'}" title="${esc(f.label)} — Renfe GTFS-RT
published every ~${f.cadence ? f.cadence.toFixed(0) : '?'} s · polled every ${f.pollMs / 1000} s (conditional GET)
picked up ${f.pickupDelay != null ? f.pickupDelay.toFixed(1) : '?'} s after publication · ${f.notModified}/${f.polls} polls unchanged · ${f.errors} errors">
        <i></i><b>${f.net === 'ld' ? 'AV·LD·MD' : 'CERCANÍAS'}</b>
        <span class="mono">${f.entities}</span>
        <span class="dim mono">${fmtAge(f.publishedAgo)}</span>
      </span>`).join('') +
      `<span class="feed sub ${tu.every((f) => health(f) === 'ok') ? 'ok' : 'warn'}" title="Delays: Renfe trip updates (AV/LD/MD + Cercanías)"><i></i>delays</span>` +
      (Math.abs(st.clockSkewMs) > 1500 ? `<span class="feed sub warn" title="Host clock differs from Renfe's by ${(st.clockSkewMs / 1000).toFixed(1)} s — corrected">clock ${(st.clockSkewMs / 1000).toFixed(0)} s</span>` : '');
  }

  // ---------- filters ----------
  _filters() {
    const el = $('#filters');
    el.innerHTML = Object.entries(CAT_LABELS).map(([k, [name, sub]]) => `
      <label class="filter" style="--c:${CAT_COLORS[k]}">
        <span class="swatch"></span>
        <span class="ft"><b>${name}</b><small>${sub}</small></span>
        <span class="count mono" data-count="${k}">0</span>
        <input type="checkbox" data-cat="${k}" checked><span class="switch"></span>
      </label>`).join('');
    el.addEventListener('change', (e) => {
      const k = e.target.dataset.cat;
      if (k) this.store.setFilter(k, e.target.checked);
    });
  }

  _counts() {
    const c = this.store.counts();
    for (const [k, n] of Object.entries(c)) { const e = document.querySelector(`[data-count="${k}"]`); if (e) e.textContent = n; }
    $('#total').textContent = Object.values(c).reduce((a, b) => a + b, 0);
  }

  _search() {
    const input = $('#search');
    input.addEventListener('input', () => this.store.setQuery(input.value.trim().toLowerCase()));
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const hit = [...this.store.trains.values()].find((t) => this.store.isVisible(t));
      if (hit) { this.store.select(hit.id); this.rig.setMode('top'); input.blur(); }
    });
  }

  // ---------- warnings ----------
  _warnTypes() {
    const el = $('#warn-types');
    el.innerHTML = Object.entries(WARN_CHIPS).map(([k, [label, title]]) =>
      `<button class="chip" data-type="${k}" title="${title}" aria-pressed="${this.store.warnTypes[k]}">${label}<span class="n" data-n="${k}"></span></button>`).join('');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      this.store.setWarnType(b.dataset.type, on);
    });
  }

  _conflicts() {
    if (this._listHeld) { this._listDirty = true; return; }
    const store = this.store;
    const list = store.visibleConflicts();
    const n = { critical: 0, warning: 0, watch: 0 };
    for (const c of list) if (n[c.level] != null) n[c.level]++;
    // per-type counts on the chips, and how many the network / search filters hide
    const byType = {};
    let hidden = 0;
    for (const c of store.conflicts) {
      byType[c.type] = (byType[c.type] || 0) + 1;
      if (store.warnTypes[c.type] && !store.conflictVisible(c)) hidden++;
    }
    for (const k of Object.keys(WARN_CHIPS)) { const e = document.querySelector(`[data-n="${k}"]`); if (e) e.textContent = byType[k] || ''; }
    $('#warn-hidden').textContent = hidden ? `${hidden} hidden by network filter` : '';
    // the focused warning stays at the top while it is shown on the map, even once resolved
    const f = store.focus;
    if (f) {
      const i = list.findIndex((c) => c.key === f.key);
      if (i >= 0) list.unshift(...list.splice(i, 1));
      else list.unshift({ ...f, resolved: true });
    }
    $('#alert-summary').innerHTML = ['critical', 'warning', 'watch'].map((l) => `<span class="lvl ${l} ${n[l] ? '' : 'zero'}"><i></i>${n[l]}</span>`).join('');
    const engine = this.store.engine;
    $('#engine').textContent = engine ? `${engine.trains} trains · ${engine.pairs} pairs · ${engine.ms} ms` : '';
    const el = $('#conflicts');
    if (!list.length) {
      el.innerHTML = `<div class="empty">${store.conflicts.length ? 'No notices for the selected networks and types.' : 'No proximity notices right now.'}</div>`;
      return;
    }
    el.innerHTML = list.slice(0, 60).map((c) => this._card(c, f)).join('');
  }

  /** One warning, in plain words: who, how far apart vs how far they need, and how fast it is changing. */
  _card(c, f) {
    const A = this.store.trains.get(c.a)?.d, B = this.store.trains.get(c.b)?.d;
    const na = `<b>${esc(trainName(A) || c.a)}</b>`, nb = `<b>${esc(trainName(B) || c.b)}</b>`;
    const st = (d) => (isStopped(d) && c.level !== 'info' ? ' <span class="c-stop">■ stopped</span>' : '');
    const closing = c.closing ?? 0;
    let head;
    if (c.type === 'following') head = closing > 0.3 ? `${na} is catching up with ${nb}${st(B)}` : `${na} is close behind ${nb}${st(B)}`;
    else if (c.type === 'opposing') head = `${na}${st(A)} and ${nb}${st(B)} are heading towards each other where the map shows one track`;
    else if (c.type === 'converging') head = `${na} and ${nb} are heading for the same junction`;
    else head = `${na} and ${nb} will pass each other on double track`;

    // gap vs margin, as a bar: the fill is the gap, the tick is the margin
    let gauge = '';
    if ((c.type === 'following' || c.type === 'opposing') && c.req) {
      const max = Math.max(c.gap, c.req) * 1.15;
      const short = c.gap < c.req;
      gauge = `
        <span class="c-gauge ${short ? 'short' : ''}"><i class="fill" style="width:${(100 * c.gap / max).toFixed(1)}%"></i><i class="safe" style="left:${(100 * c.req / max).toFixed(1)}%"></i></span>
        <span class="c-scale"><span><b>${fmtDist(c.gap)}</b> apart</span><span>margin <b>${fmtDist(c.req)}</b></span></span>`;
    }

    const facts = [];
    if (c.type === 'following' || c.type === 'opposing' || c.type === 'passing') facts.push(trendText(closing));
    if (c.resolved) facts.push('no longer reported');
    else if (c.type === 'passing') facts.push(`they pass in ${c.ttb} s`);
    else if (c.type === 'converging') facts.push(`both within ${c.req} m of each other in ${c.ttb} s`);
    else if (c.level === 'critical') facts.push('<span class="hot">inside the estimated braking distance</span>');
    else if (c.ttb <= 0) facts.push(c.type === 'following' ? '<span class="hot">closer than the margin now</span>' : 'closer than the margin now');
    else facts.push(`closer than the margin in <b>${c.ttb} s</b> at current speeds`);

    const when = c.resolved ? 'resolved' : c.ttb <= 0 && c.level !== 'info' ? 'now' : `in ${c.ttb} s`;
    const focused = !!f && c.key === f.key;
    const notes = (c.notes || []).map(plainNote).filter(Boolean);
    return `<button class="conflict ${c.level} ${c.fading ? 'fading' : ''} ${focused ? 'focused' : ''} ${c.resolved ? 'resolved' : ''}" data-key="${esc(c.key)}" title="${focused ? 'Shown on the map. Click again to clear' : 'Show these two trains on the map'}">
        <span class="bar"></span>
        <span class="c-top"><b>${LEVEL_LABEL[c.level]}</b><span class="c-type">${SHORT_TYPE[c.type]}${c.confidence === 'low' ? '<span class="c-conf" title="Old or approximate data: treat with care">uncertain</span>' : ''}</span><span class="c-when mono">${when}</span></span>
        <span class="c-head">${head}</span>${gauge}
        <span class="c-facts">${facts.join(' · ')}</span>
        ${notes.length ? `<span class="c-notes">${notes.map(esc).join(' · ')}</span>` : ''}
      </button>`;
  }

  // ---------- selected train ----------
  _trainPanel() {
    const p = $('#train-panel');
    p.querySelector('.close').addEventListener('click', () => { this.store.select(null); this.rig.setMode('free'); });
    p.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => this.rig.setMode(b.dataset.cam)));
    $('#heading-up').addEventListener('change', (e) => { this.rig.headingUp = e.target.checked; });
  }

  _onSelect() {
    const t = this.store.trains.get(this.store.selectedId);
    const p = $('#train-panel');
    p.hidden = !t;
    document.body.classList.toggle('has-selection', !!t);
    if (!t) { this.rig.setMode('free'); return; }
    this._updateTrainPanel(true);
    this._camButtons();
  }

  _camButtons() {
    document.querySelectorAll('[data-cam]').forEach((b) => b.classList.toggle('on', b.dataset.cam === this.rig.mode));
    $('#cam-hint').textContent = (window.matchMedia('(pointer: coarse)').matches ? {
      free: 'Pan & pinch freely · tap a train to select it',
      top: 'Following from above · pinch to zoom · drag to release',
      chase: 'Chase view · pinch = distance · drag = orbit / height',
    } : {
      free: 'Pan & zoom freely · click a train to select it',
      top: 'Following from above · wheel to zoom · drag to release',
      chase: 'Chase view · wheel = distance · drag = orbit / height',
    })[this.rig.mode];
    document.body.dataset.cam = this.rig.mode;
  }

  _updateTrainPanel(full = false) {
    const t = this.store.trains.get(this.store.selectedId);
    if (!t) return;
    const d = t.d, p = $('#train-panel');
    const acc = accentOf(d);
    p.style.setProperty('--c', acc);
    if (full || p.dataset.id !== d.id || p.dataset.trip !== d.trip) {
      p.dataset.id = d.id; p.dataset.trip = d.trip;
      $('.tp-product', p).textContent = d.cat === 'cer' ? 'CERCANÍAS' : String(d.product).toUpperCase();
      $('.tp-num', p).textContent = d.num || d.id;
      const chip = $('.tp-line', p);
      chip.hidden = !d.line; chip.textContent = d.line || '';
      $('.tp-from', p).textContent = d.from || '—';
      $('.tp-to', p).textContent = d.to || '—';
    }
    const now = this.store.serverNow();
    const age = (now - d.t) / 1000;
    const kmh = d.speed == null ? null : Math.round(d.speed * 3.6);
    $('#tp-kmh').textContent = kmh == null ? '—' : kmh;
    $('#tp-speed-note').textContent = d.speed == null ? 'estimating from next GPS fix…' : 'estimated from consecutive GPS fixes';
    const limit = d.maxspeed || null;
    const bar = $('#tp-speedbar');
    bar.style.setProperty('--v', kmh && limit ? Math.min(1, kmh / limit) : kmh ? Math.min(1, kmh / 320) : 0);
    $('#tp-limit').textContent = limit ? `track limit ${limit}` : '';
    const brg = Math.round(t.disp?.bearing ?? d.heading);
    $('#tp-heading').innerHTML = `<span class="needle" style="transform:rotate(${brg}deg)">▲</span> ${String(brg).padStart(3, '0')}° ${COMPASS[Math.round(brg / 45) % 8]}`;
    $('#tp-status').textContent = d.stop ? `${STATUS_TXT[d.status] || ''} ${d.stop}${d.platform ? ` · platform ${d.platform}` : ''}` : (STATUS_TXT[d.status] || '—');
    const delay = d.delay;
    const dEl = $('#tp-delay');
    dEl.textContent = d.canceled ? 'cancelled' : delay == null ? '—' : Math.abs(delay) < 60 ? 'on time' : `${delay > 0 ? '+' : '−'}${Math.round(Math.abs(delay) / 60)} min`;
    dEl.className = d.canceled || delay > 300 ? 'bad' : delay > 60 ? 'warn' : 'ok';
    $('#tp-track').textContent = d.snapped ? `${CLS_TXT[d.cls] || 'Track'} · ${d.tracks || 1} track${(d.tracks || 1) > 1 ? 's' : ''}` : 'not matched to OSM track';
    const ageEl = $('#tp-age');
    ageEl.textContent = `${fmtAge(age)} ago`;
    ageEl.className = age > 90 ? 'bad' : age > 45 ? 'warn' : 'ok';
    $('#tp-pos').textContent = d.src === 'placeholder' ? 'placeholder at station (not running / no GPS)'
      : d.src === 'station' ? 'station coordinates (no GPS)'
      : (d.snapped ? `GPS · ${d.off} m from track` : 'GPS (raw)') + (d.consist ? ' · coupled consist' : '');
    $('#tp-dr').textContent = d.speed && age > 0 ? `+${fmtDist(Math.min(age, 90) * d.speed)} dead-reckoned` : 'at last fix';

    const mine = this.store.conflicts.filter((c) => (c.a === d.id || c.b === d.id) && c.level !== 'info');
    $('#tp-warn').innerHTML = mine.length ? mine.map((c) => {
      const other = this.store.trains.get(c.a === d.id ? c.b : c.a)?.d;
      const o = esc(trainName(other));
      const gaining = (c.closing ?? 0) > 0.3;
      const what = c.type === 'following' ? (c.a === d.id ? (gaining ? `Catching up with ${o}` : `Close behind ${o}`) : (gaining ? `${o} is catching up from behind` : `${o} is close behind`))
        : c.type === 'opposing' ? `Heading towards ${o} where the map shows one track` : `Path meets ${o}'s at a junction`;
      const dist = c.type === 'converging' ? '' : ` · ${fmtDist(c.gap)} apart (margin: ${fmtDist(c.req)})`;
      return `<div class="tp-w ${c.level}"><b>${LEVEL_LABEL[c.level]}</b> ${what}${dist} · ${c.ttb <= 0 ? 'now' : `in ${c.ttb} s`}</div>`;
    }).join('') : '';
  }

  // ---------- tooltip ----------
  tooltip(t, point) {
    const el = $('#tooltip');
    if (!t) { el.hidden = true; return; }
    const d = t.d;
    el.hidden = false;
    el.style.setProperty('--c', accentOf(d));
    el.style.transform = `translate(${point.x + 14}px, ${point.y + 14}px)`;
    el.innerHTML = `<b>${esc(trainName(d))}</b><span class="mono">${d.speed == null ? '—' : Math.round(d.speed * 3.6)} km/h</span><small>${esc(d.to ? '→ ' + d.to : '')}</small>`;
  }

  _keys() {
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') { if (e.key === 'Escape') e.target.blur(); return; }
      if (e.key === 'Escape') {
        if (this.rig.mode !== 'free') this.rig.setMode('free');
        else if (this.store.focus) this.store.setFocus(null);
        else this.store.select(null);
      }
      if (e.key === '1') this.rig.setMode('free');
      if (e.key === '2') this.rig.setMode('top');
      if (e.key === '3') this.rig.setMode('chase');
      if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
    });
  }
}
