// Dark "instrument" basemap built on OpenFreeMap vector tiles (OpenMapTiles schema).
// Places and orientation only: no POIs, no peaks, no road names. The rail network is our own
// OSM extract so it is visible at every zoom and matches the track the trains are snapped to.

const OFM = 'https://tiles.openfreemap.org';
export const EMPTY = { type: 'FeatureCollection', features: [] };

export const RAIL_COLORS = { hs: '#1fb8d8', main: '#6272f0', branch: '#4553a8', narrow: '#d89a3a' };
export const LEVEL_COLORS = { critical: '#ff3b5c', warning: '#ff9a2e', watch: '#ffd84a', info: '#4f9dff' };

const NAME = ['coalesce', ['get', 'name'], ['get', 'name:latin']];
const z = (...stops) => ['interpolate', ['linear'], ['zoom'], ...stops];
const ze = (...stops) => ['interpolate', ['exponential', 1.6], ['zoom'], ...stops];

export function buildStyle() {
  return {
    version: 8,
    name: 'rail-radar',
    glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      omt: { type: 'vector', url: `${OFM}/planet` },
      rail: { type: 'geojson', data: '/data/rail.geojson', tolerance: 0.25, buffer: 64 },
      stations: { type: 'geojson', data: '/api/stations' },
      selpath: { type: 'geojson', data: EMPTY },
      conflicts: { type: 'geojson', data: EMPTY },
      focus: { type: 'geojson', data: EMPTY },
      signals: { type: 'geojson', data: EMPTY },
    },
    sky: {
      'sky-color': '#02060d',
      'horizon-color': '#0c2a44',
      'fog-color': '#02060d',
      'sky-horizon-blend': 0.55,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.35,
      'atmosphere-blend': 0,
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#03070e' } },
      {
        id: 'urban', type: 'fill', source: 'omt', 'source-layer': 'landuse', minzoom: 8,
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'neighbourhood', 'commercial', 'industrial', 'retail']]],
        paint: { 'fill-color': '#0a1424', 'fill-opacity': z(8, 0.5, 12, 0.9) },
      },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#05182a' } },
      {
        id: 'water-edge', type: 'line', source: 'omt', 'source-layer': 'water', minzoom: 4,
        paint: { 'line-color': '#0d3352', 'line-width': z(4, 0.4, 10, 1), 'line-opacity': 0.7 },
      },
      {
        id: 'river', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 7,
        filter: ['in', ['get', 'class'], ['literal', ['river', 'canal']]],
        paint: { 'line-color': '#0b2b47', 'line-width': z(7, 0.4, 14, 2) },
      },
      {
        id: 'admin-ccaa', type: 'line', source: 'omt', 'source-layer': 'boundary', minzoom: 5,
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': '#1b3150', 'line-width': z(5, 0.5, 10, 1.1), 'line-dasharray': [3, 2] },
      },
      {
        id: 'admin-country', type: 'line', source: 'omt', 'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': '#2f6b93', 'line-width': z(3, 0.8, 10, 2), 'line-opacity': 0.8 },
      },
      {
        id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12,
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#101c2e', 'line-width': ze(12, 0.5, 18, 8) },
      },
      {
        id: 'road-mid', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 8,
        filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#15233a', 'line-width': ze(8, 0.4, 18, 12) },
      },
      {
        id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 5,
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#1a2a44', 'line-width': ze(5, 0.4, 18, 16), 'line-opacity': z(5, 0.6, 9, 1) },
      },

      // ---- rail network ----
      {
        id: 'rail-glow', type: 'line', source: 'rail', filter: ['!', ['has', 's']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'c'], 'hs', RAIL_COLORS.hs, 'main', RAIL_COLORS.main, 'narrow', RAIL_COLORS.narrow, RAIL_COLORS.branch],
          'line-width': z(4, 2.5, 9, 6, 14, 12, 18, 26),
          'line-blur': z(4, 2, 14, 8),
          'line-opacity': z(4, 0.22, 12, 0.14, 17, 0.08),
        },
      },
      {
        id: 'rail-siding', type: 'line', source: 'rail', minzoom: 11, filter: ['has', 's'],
        paint: {
          'line-color': ['match', ['get', 'c'], 'hs', RAIL_COLORS.hs, 'narrow', RAIL_COLORS.narrow, RAIL_COLORS.branch],
          'line-width': z(11, 0.4, 16, 1.6, 19, 4), 'line-opacity': 0.55,
        },
      },
      {
        id: 'rail', type: 'line', source: 'rail', filter: ['!', ['has', 's']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'c'], 'hs', RAIL_COLORS.hs, 'main', RAIL_COLORS.main, 'narrow', RAIL_COLORS.narrow, RAIL_COLORS.branch],
          'line-width': z(
            4, ['match', ['get', 'c'], 'hs', 0.9, 'main', 0.7, 0.45],
            9, ['match', ['get', 'c'], 'hs', 1.6, 'main', 1.3, 0.9],
            14, ['match', ['get', 'c'], 'hs', 2.4, 'main', 2.0, 1.6],
            18, ['match', ['get', 'c'], 'hs', 6, 'main', 5, 4]),
          'line-opacity': 0.95,
        },
      },
      {
        id: 'buildings', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 14,
        paint: {
          'fill-extrusion-color': '#0d1829',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': z(14, 0, 15, 0.85),
        },
      },

      // ---- overlays ----
      {
        id: 'selpath-glow', type: 'line', source: 'selpath',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': z(5, 6, 16, 18), 'line-blur': 6, 'line-opacity': 0.35 },
      },
      {
        id: 'selpath', type: 'line', source: 'selpath',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': z(5, 1.6, 16, 4), 'line-dasharray': [2, 1.5], 'line-opacity': 0.95 },
      },
      {
        id: 'conflict-line', type: 'line', source: 'conflicts', filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': ['match', ['get', 'level'], 'critical', LEVEL_COLORS.critical, 'warning', LEVEL_COLORS.warning, 'watch', LEVEL_COLORS.watch, LEVEL_COLORS.info],
          'line-width': z(5, 1, 14, 2), 'line-dasharray': [1.5, 2],
          'line-opacity': ['match', ['get', 'level'], 'info', 0.35, 0.7],
        },
      },
      {
        id: 'conflict-point', type: 'circle', source: 'conflicts', filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': z(5, 2.5, 14, 5),
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-width': 1.2,
          'circle-stroke-opacity': 0.8,
          'circle-stroke-color': ['match', ['get', 'level'], 'critical', LEVEL_COLORS.critical, 'warning', LEVEL_COLORS.warning, 'watch', LEVEL_COLORS.watch, LEVEL_COLORS.info],
        },
      },

      // ---- stations & places ----
      {
        id: 'station', type: 'circle', source: 'stations', minzoom: 8.5,
        paint: {
          'circle-radius': z(8.5, 1.4, 12, 3, 16, 5),
          'circle-color': '#06101d',
          'circle-stroke-color': '#8ec5ee',
          'circle-stroke-width': z(8.5, 0.6, 14, 1.4),
          'circle-opacity': z(8.5, 0, 9.5, 1), 'circle-stroke-opacity': z(8.5, 0, 9.5, 0.9),
        },
      },
      {
        id: 'sea-label', type: 'symbol', source: 'omt', 'source-layer': 'water_name', maxzoom: 9,
        filter: ['in', ['get', 'class'], ['literal', ['ocean', 'sea']]],
        layout: { 'text-field': NAME, 'text-font': ['Noto Sans Italic'], 'text-size': 12, 'text-letter-spacing': 0.25, 'text-max-width': 6 },
        paint: { 'text-color': '#1f5378' },
      },
      {
        id: 'place-minor', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', ['suburb', 'neighbourhood', 'hamlet', 'quarter']]],
        layout: { 'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-size': z(11, 10, 16, 12), 'text-max-width': 8 },
        paint: { 'text-color': '#5f7a96', 'text-halo-color': '#03070e', 'text-halo-width': 1.2 },
      },
      {
        id: 'place-village', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 10,
        filter: ['==', ['get', 'class'], 'village'],
        layout: { 'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-size': z(10, 10, 15, 13), 'text-max-width': 8 },
        paint: { 'text-color': '#7f98b3', 'text-halo-color': '#03070e', 'text-halo-width': 1.2 },
      },
      {
        id: 'station-label', type: 'symbol', source: 'stations', minzoom: 11.5,
        layout: {
          'text-field': ['get', 'n'], 'text-font': ['Noto Sans Regular'], 'text-size': z(11.5, 10, 16, 12.5),
          'text-offset': [0, 1], 'text-anchor': 'top', 'text-max-width': 9, 'text-optional': true,
        },
        paint: { 'text-color': '#9fd2f5', 'text-halo-color': '#03070e', 'text-halo-width': 1.4 },
      },
      {
        id: 'place-town', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 7,
        filter: ['==', ['get', 'class'], 'town'],
        layout: { 'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-size': z(7, 10.5, 12, 14), 'text-max-width': 8 },
        paint: { 'text-color': '#a7bfd8', 'text-halo-color': '#03070e', 'text-halo-width': 1.4 },
      },
      {
        id: 'place-city', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 4,
        filter: ['==', ['get', 'class'], 'city'],
        layout: {
          'text-field': NAME, 'text-font': ['Noto Sans Bold'], 'text-transform': 'uppercase',
          'text-size': z(4, 10, 8, 13.5, 12, 17), 'text-letter-spacing': 0.14, 'text-max-width': 8,
        },
        paint: { 'text-color': '#e3f1ff', 'text-halo-color': '#03070e', 'text-halo-width': 1.6, 'text-halo-blur': 0.5 },
      },
      {
        id: 'place-country', type: 'symbol', source: 'omt', 'source-layer': 'place', maxzoom: 6.5,
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': NAME, 'text-font': ['Noto Sans Bold'], 'text-transform': 'uppercase',
          'text-size': 13, 'text-letter-spacing': 0.5,
        },
        paint: { 'text-color': '#33597a', 'text-halo-color': '#03070e', 'text-halo-width': 1 },
      },

      // ---- stop signal above a stopped train that another train is closing on ----
      {
        id: 'signal', type: 'symbol', source: 'signals',
        layout: {
          'icon-image': 'rr-signal', 'icon-anchor': 'bottom', 'icon-offset': [0, -6],
          'icon-size': z(5, 0.75, 12, 0.9, 16, 1), 'icon-allow-overlap': true, 'icon-ignore-placement': true,
          'text-field': ['get', 't'], 'text-font': ['Noto Sans Bold'], 'text-size': 10, 'text-transform': 'uppercase',
          'text-letter-spacing': 0.08, 'text-anchor': 'left', 'text-offset': [1.1, -1.9],
          'text-allow-overlap': true, 'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#ff6a7c', 'text-halo-color': '#03070e', 'text-halo-width': 2,
          'text-opacity': z(6.5, 0, 8, 1),
        },
      },
      // ---- focused warning: name + speed above each train, separation in the middle ----
      {
        id: 'focus-gap', type: 'symbol', source: 'focus', filter: ['==', ['get', 'k'], 'gap'], // unused: see the gap tag in main.js
        layout: {
          'text-field': ['get', 't'], 'text-font': ['Noto Sans Bold'], 'text-size': 11.5, 'text-letter-spacing': 0.04,
          // below the midpoint (the train names sit above the trains), one line per fact
          'text-anchor': 'top', 'text-offset': [0, 0.9], 'text-max-width': 30, 'text-line-height': 1.3,
          'text-allow-overlap': true, 'text-ignore-placement': true,
        },
        paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#03070e', 'text-halo-width': 2.2 },
      },
      {
        id: 'focus-label', type: 'symbol', source: 'focus', filter: ['==', ['get', 'k'], 'train'],
        layout: {
          'text-field': ['get', 't'], 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-line-height': 1.25,
          'text-anchor': 'bottom', 'text-offset': ['get', 'o'], 'text-allow-overlap': true, 'text-ignore-placement': true,
        },
        paint: { 'text-color': ['get', 'c'], 'text-halo-color': '#03070e', 'text-halo-width': 2.4 },
      },
    ],
  };
}
