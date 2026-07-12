# vel'OH Pulse

Live map + availability forecast for [vel'OH!](https://myveloh.lu/), Luxembourg's e-bike sharing
system (operated by JCDecaux). Vue 3 · Vite · MapLibre GL.

![stack](https://img.shields.io/badge/Vue-3-42b883) ![stack](https://img.shields.io/badge/Vite-7-9575ff) ![stack](https://img.shields.io/badge/MapLibre-GL-4da3ff)

## What it does

- **Live map** — every station as a ring marker (fill = share of docks with a bike available),
  refreshed every 60 s from the official GBFS v3 feed.
- **Time scrubber** — drag up to +48 h into the future; markers recolor to the model's estimate.
  Luxembourg public holidays and the Open-Meteo weather forecast are shown for the selected hour.
- **Station panel** — bikes / docks / out-of-service counts and a 24 h prediction sparkline.
- **Search** — find stations by name/address, or geocode any Luxembourg address (Nominatim);
  results fly the map there.
- **Walking guidance** — with location access granted (or `?at=lat,lon` in the URL to simulate a
  position), the map always shows the fastest walking route to the nearest station that has
  bikes, with ETA and distance; clicking the chip opens that station. Falls back to a beeline
  estimate if the router is unreachable.

## Data sources (all keyless & open)

| Source | Used for | Licence |
|---|---|---|
| `api.cyclocity.fr/contracts/luxembourg/gbfs/v3` | station info + live status (1 min refresh) | [JCDecaux Open Licence](https://developer.jcdecaux.com/files/Open-Licence-en.pdf) |
| [Open-Meteo](https://open-meteo.com/) | current weather + 3-day hourly forecast | CC BY 4.0 |
| [Nominatim](https://nominatim.org/) | address search (geocoding) | ODbL / fair use |
| [FOSSGIS OSRM](https://routing.openstreetmap.de/) | walking routes to the nearest station | ODbL / fair use |
| [aviationweather.gov](https://aviationweather.gov/) | measured METAR observations (collector) | public domain |
| Computed locally | Luxembourg public holidays | — |

No scraping of the VDL map is needed — the city links to this official feed from
[data.public.lu](https://data.public.lu/en/datasets/mobilite-veloh/).

**Optional:** a free API key from [developer.jcdecaux.com](https://developer.jcdecaux.com) (set
`JCDECAUX_API_KEY`) lets the collector also record telemetry-link state, admin open/closed status
and main-vs-overflow stand splits from the official VLS v3 API.

**What is *not* publicly available:** per-bike data — bike IDs, battery levels, user ratings.
It exists only behind the vel'OH app's private API (`api.cyclocity.fr/contracts/luxembourg/bikes`
answers `403 role.not.allowed`), and this project does not attempt to bypass that. The community
proxy `api.tfl.lu`, which used to expose dock-level occupancy, appears to be offline (2026).

## How prediction works

Nobody publishes vel'OH *history*, so the model trains on data **you collect yourself**:

1. **Collect** — `npm run collect` appends one compact snapshot to `data/snapshots-YYYY-MM.ndjson`
   capturing **every field the public feeds expose**: per station `[bikes, free docks,
   disabled bikes, disabled docks, open-flags, telemetry age]`, plus rich weather (temperature,
   feels-like, humidity, precipitation, rain, snow, cloud cover, wind, gusts, WMO code).
   Run it on a schedule (see below); `npm run collect:loop` polls every 5 min in the foreground,
   and `--burst N --every S` takes N spaced snapshots then exits (used by the CI workflow).
2. **Train** — `npm run train` aggregates the snapshots into `public/model/profiles.json`:
   mean availability per **station × day-type × hour** (day-type = weekday / Saturday /
   Sunday-or-holiday, in Luxembourg local time) plus a global profile and a wet-vs-dry rain delta.
3. **Predict** — the app blends, per station:
   - the **live level**, decaying over ~6 h (persistence),
   - the **learned profile**, shrunk toward the global profile where data is sparse,
   - the **rain adjustment** when the forecast says wet.

   Until you've collected data the app runs in *learning mode* (clearly badged): persistence +
   system-wide prior only. A week of snapshots already gives useful day-shape estimates; a few
   months capture seasons properly. Every estimate is labeled with its confidence
   (`live` / `short-term` / `learned` / `prior`).

## Quickstart

```sh
npm install
npm run dev        # app on http://localhost:5173
npm run collect    # one training snapshot
npm run train      # rebuild public/model/profiles.json from collected data
```

## Scheduling collection

**Locally (WSL)** — run [`collector/install-autostart.sh`](collector/install-autostart.sh) once:
it starts [`collector/run-local.sh`](collector/run-local.sh) (`collect.mjs --loop 60 --tag local`,
single-instance via `flock`) and drops a tiny generated launcher into the Windows Startup folder
so the collector revives at every logon — WSL can't boot itself when Windows starts, so that one
generated artifact is unavoidable; all maintained logic is bash.
Local snapshots go to `data/snapshots-YYYY-MM-local.ndjson` — a different file than CI writes,
so pulls never conflict, and the trainer de-duplicates overlapping minutes anyway.
Uninstall with `collector/install-autostart.sh --remove`.

**GitHub Actions** (free on public repos, runs even when your PC is off) — already included as
[`.github/workflows/collect.yml`](.github/workflows/collect.yml). GitHub's cron floor is
**5 minutes** and scheduled starts are best-effort (often a few minutes late, occasionally
skipped), so true per-minute cron is impossible. The workflow works around it: it starts every
15 minutes and takes **14 snapshots 60 s apart inside one run** — effectively 1-minute resolution
with small gaps between bursts. [`train.yml`](.github/workflows/train.yml) retrains the model
nightly from the accumulated data.

To activate: push this repo to GitHub (public repo recommended — Actions minutes are free and
unlimited there) and both workflows start on their own. For gap-free 1-minute data, run
`npm run collect:loop -- 60` on any always-on machine (home server, Raspberry Pi, small VPS)
instead.

> Sizing note: 1-minute sampling writes roughly 100–200 MB of NDJSON per month (it compresses
> ~10× with gzip). 5-minute sampling is statistically plenty for day-profile models — stations
> don't change that fast — so don't feel obliged to go per-minute.

## Roadmap

- [x] Retrain automatically (nightly `train` workflow)
- [ ] Per-station rain/temperature coefficients once ≥1 month of data exists
- [ ] Gradient-boosted model (e.g. LightGBM) as an offline evaluation baseline vs. the profile model
- [ ] PWA build for phone home-screen use
- [ ] "Will there be a dock free at my destination?" routing view

## Notes

- The GBFS feed and Open-Meteo both send permissive CORS headers, so the app is fully static —
  deployable to any static host (GitHub Pages, Netlify, …).
- vel'OH is an all-electric fleet, so `vehicle_types_available` is always `electrical`.
