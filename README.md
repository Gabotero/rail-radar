# Rail Radar · España

Live 3D map of Spanish trains built only from **original sources**, with a prototype
trajectory-conflict (proximity) warning engine.

This project was inspired by the 2026 rail accidents in Spain: the
[Adamuz rail disaster](https://en.wikipedia.org/wiki/2026_Adamuz_rail_disaster) (18 January) and the
[Toledo train collision](https://en.wikipedia.org/wiki/2026_Toledo_train_collision) (28 October).

**Live:** https://trainspain.duckdns.org

https://github.com/user-attachments/assets/9eab518b-2059-4c31-b0e2-a3c213de5144

*Recorded on the live site. Use fullscreen to read the labels.*

- **Positions:** Renfe Operadora's own GTFS-Realtime feeds (`gtfsrt.renfe.com`, CC BY 4.0):
  - `vehicle_positions_LD.pb`: AVE / AVLO / Avant / Alvia / MD GPS, republished every ~15 s
  - `vehicle_positions.pb`: Cercanías / Rodalies GPS, every ~20 s
  - `trip_updates_LD.pb`, `trip_updates.pb`: delays
- **Names, products, line colours:** Renfe static GTFS (data.renfe.com)
- **Track geometry:** OpenStreetMap (ODbL), via Overpass, prebuilt by `npm run build:rail`
- **Basemap:** OpenFreeMap vector tiles (OpenMapTiles schema)

No third-party aggregators are used. Ouigo and Iryo publish no real-time positions, so they are not shown.

## How it works

```
Renfe GTFS-RT ──(conditional GET every 2 s)──▶ feeds.mjs ──▶ tracker.mjs ──▶ conflicts.mjs (1 Hz)
                                                  │              │                 │
                                     clock.mjs (skew from        │ snap to OSM track, speed &
                                     HTTP Date header)           │ heading from consecutive fixes,
                                                                 │ trace path ahead along rails
                                                                 ▼
                                                    index.mjs ──SSE /api/stream──▶ browser
                                                                         (MapLibre + Three.js)
```

- **Freshness:** Renfe republishes the files every 15–20 s. The server polls every 2 s with `If-None-Match`
  / `If-Modified-Since`, so a new file is picked up within about 2 s and unchanged polls cost a bodiless 304.
  Publish time is taken from `Last-Modified`, because the AV/LD feed's own header timestamp is one hour off.
- **Speed and heading:** neither feed provides them. Speed is the median of the last 3 fix-to-fix speeds,
  capped per category (GPS jumps rejected). Heading is the tangent of the snapped OSM track, oriented
  by motion, or by the next stop when stationary.
- **Animation and now-casting:** each train is dead-reckoned along its traced track path from its last fix
  (at most 90 s), and new fixes are blended in smoothly.
- **Conflict engine** (`server/conflicts.mjs`), evaluated on now-cast positions every second:
  - *following*: train ahead on the same track and gauge. Alert when the gap is, or within 180 s will be,
    below braking distance (0.7 m/s²) + 200 m.
  - *opposing*: on the same track, heading towards each other, and no second track (double track or passing
    loop) between them.
  - *converging*: paths cross at an angle within the horizon.
  - *opposing* and *converging* pairs stay at the lowest level (watch): public data cannot show which track a
    train is on, so neither can be confirmed.
  - Confidence is downgraded for old fixes, station-coordinate positions, unsnapped trains and multi-track
    sections. Duplicates and coupled units are suppressed.

> Public data is 15–60 s old, ~10 m accurate and carries no signalling state. This is a monitoring and
> research prototype, **not a safety system**.

## Run

Node ≥ 20.

```bash
npm install
npm start              # http://127.0.0.1:5173   (HOST / PORT env vars to change)
```

The prebuilt rail network is included in this repository. Static GTFS is downloaded on start and cached for
12 h in `data/gtfs/`.

Controls: click a train → **Top** (follow from above) / **Chase** (third person). In chase view, wheel = distance,
drag = orbit / height. Keys: `1` free, `2` top, `3` chase, `Esc` release, `/` search.

## Deploy (live at https://trainspain.duckdns.org)

The app runs in `~/railradar` on the server as the Docker container `railradar`, listening on
`127.0.0.1:8610` only. nginx publishes it through `/etc/nginx/sites-available/zz-trainspain.conf`, with
HTTPS from certbot.

- First install: `docker compose up -d --build`, then `sudo bash deploy/setup-nginx.sh` once. That script
  adds only that site file (tested with `nginx -t` before reload), turns off buffering for the live stream,
  gzips it, and gets the certificate.
- Update: on the PC run `bash deploy/package.sh`, copy `deploy/railradar.tgz` to the server, unpack it over
  `~/railradar`, then `docker compose up -d --build`. No sudo needed.
- Logs and state: `docker logs -f railradar`, `curl -s 127.0.0.1:8610/api/status`.
- Refresh the OSM rail network (sidings, new lines): `npm run build:rail -- --refresh` on the PC, then update.

## Credits and licence

- **Train data:** [Renfe Operadora](https://data.renfe.com), CC BY 4.0.
- **Rail network** (`data/rail-graph.json`, `web/data/rail.geojson`): derived from OpenStreetMap,
  © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
  [Open Database License](https://opendatacommons.org/licenses/odbl/) (ODbL).
- **Basemap:** [OpenFreeMap](https://openfreemap.org), © OpenMapTiles, data © OpenStreetMap contributors.
