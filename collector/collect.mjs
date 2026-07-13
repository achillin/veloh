#!/usr/bin/env node
// Snapshot collector for the vel'OH GBFS feed — captures every field the
// public feeds expose.
//
// Appends one compact NDJSON line per snapshot to
// data/snapshots-YYYY-MM[-tag].ndjson:
//
//   {"t":"2026-07-11T19:40:00Z","v":3,
//    "metar":{"t":"...","temp":27,"dewp":10,"wdir":40,"wspd":9,"wgst":null,
//             "visib":"6+","altim":1018,"cover":"CAVOK","wx":null,"raw":"METAR ELLX ..."},
//    "om":{"temp":29.6,"feels":27.1,"rh":26,"precip":0,"rain":0,"snow":0,
//          "cloud":0,"wind":13.7,"gust":29.5,"code":0},
//    "s":{"1":[vehAvail,dockAvail,vehDisabled,dockDisabled,flags,ageSec],...},
//    "jd":{"1":[connected,open,mainBikes,mainStands,ovfBikes,ovfStands],...}}  // only with JCDECAUX_API_KEY
//
//   metar = MEASURED weather: the latest METAR observation from Luxembourg
//           Findel airport (ELLX, ~6 km from the city, published half-hourly).
//   om    = Open-Meteo model analysis ("current") — kept as a secondary signal.
//   flags = installed*4 + renting*2 + returning*1 (7 = fully open)
//   ageSec = seconds between the snapshot and the station's last_reported
//
// Per-bike data (IDs, battery %, user ratings) exists only behind JCDecaux's
// private app API (403 role.not.allowed) and is NOT collected.
//
// Usage:
//   node collector/collect.mjs                        # one snapshot
//   node collector/collect.mjs --loop 60              # every 60 s, forever
//   node collector/collect.mjs --burst 14 --every 60  # 14 snapshots then exit
//   node collector/collect.mjs --loop 60 --tag local  # write to ...-local.ndjson
//
// --tag keeps concurrently collected datasets in separate files (e.g. 'local'
// on your PC vs untagged in CI) so a git pull never conflicts; the trainer
// reads all files and de-duplicates overlapping minutes.
//
// Optional: set JCDECAUX_API_KEY (free key from https://developer.jcdecaux.com)
// to also record connected/overflow-stand details from the official VLS v3 API.

import { mkdir, appendFile, writeFile, access, readFile, readdir, stat, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = join(ROOT, 'data')
const RECENT_FILE = join(ROOT, 'public', 'recent.json')
const RECENT_WINDOW_MS = 135 * 60_000 // the app scrubs 2 h back; keep a margin
const GBFS = 'https://api.cyclocity.fr/contracts/luxembourg/gbfs/v3'
const METAR = 'https://aviationweather.gov/api/data/metar?ids=ELLX&format=json'
const OPEN_METEO =
  'https://api.open-meteo.com/v1/forecast?latitude=49.61&longitude=6.13' +
  '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,rain,snowfall,cloud_cover,wind_speed_10m,wind_gusts_10m,weather_code' +
  '&timezone=UTC'
const JCD_KEY = process.env.JCDECAUX_API_KEY
const JCD = JCD_KEY
  ? `https://api.jcdecaux.com/vls/v3/stations?contract=luxembourg&apiKey=${JCD_KEY}`
  : null

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url.split('?')[0]} → HTTP ${res.status}`)
  return res.json()
}

// ---- public/recent.json: rolling window the app uses for history scrubbing ----

async function readTailLines(file, maxBytes = 4 * 1024 * 1024) {
  const { size } = await stat(file)
  const start = Math.max(0, size - maxBytes)
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    const text = buf.toString('utf8')
    // drop the first (possibly torn) line when we started mid-file
    return start > 0 ? text.slice(text.indexOf('\n') + 1).split('\n') : text.split('\n')
  } finally {
    await fh.close()
  }
}

// Rebuilds the window from the tails of the NDJSON files (first run, or
// after the collector was down) so history scrubbing works immediately.
async function backfillRecent(nowMs) {
  const cutoff = nowMs - RECENT_WINDOW_MS
  const byMinute = new Map()
  const files = (await readdir(DATA_DIR).catch(() => [])).filter((f) => f.endsWith('.ndjson'))
  for (const f of files) {
    for (const raw of await readTailLines(join(DATA_DIR, f)).catch(() => [])) {
      if (!raw.trim()) continue
      try {
        const line = JSON.parse(raw)
        if (Date.parse(line.t) < cutoff) continue
        const minute = line.t.slice(0, 16)
        if (byMinute.has(minute)) continue
        const s = {}
        for (const [id, arr] of Object.entries(line.s)) s[id] = [arr[0], arr[1]]
        byMinute.set(minute, { t: line.t, s })
      } catch {
        /* torn line */
      }
    }
  }
  return [...byMinute.values()].sort((a, b) => (a.t < b.t ? -1 : 1))
}

async function updateRecent(line, nowMs) {
  let snapshots
  try {
    snapshots = JSON.parse(await readFile(RECENT_FILE, 'utf8')).snapshots ?? []
  } catch {
    snapshots = await backfillRecent(nowMs)
  }
  const cutoff = nowMs - RECENT_WINDOW_MS
  snapshots = snapshots.filter((snap) => Date.parse(snap.t) >= cutoff)
  const s = {}
  for (const [id, arr] of Object.entries(line.s)) s[id] = [arr[0], arr[1]]
  snapshots.push({ t: line.t, s })
  await mkdir(dirname(RECENT_FILE), { recursive: true })
  await writeFile(RECENT_FILE, JSON.stringify({ updated: line.t, snapshots }))
}

async function ensureStationInfo() {
  const file = join(DATA_DIR, 'stations.json')
  try {
    await access(file)
    return
  } catch {
    /* not cached yet */
  }
  const info = await getJson(`${GBFS}/station_information.json`)
  const stations = {}
  for (const s of info.data.stations) {
    stations[s.station_id] = {
      name: Array.isArray(s.name) ? s.name[0]?.text : s.name,
      address: s.address ?? '',
      lat: s.lat,
      lon: s.lon,
      capacity: s.capacity ?? 0,
    }
  }
  await writeFile(file, JSON.stringify({ fetchedAt: new Date().toISOString(), stations }, null, 1))
  console.log(`cached station info → ${file}`)
}

function packMetar(list) {
  const m = Array.isArray(list) ? list[0] : null
  if (!m) return null
  return {
    t: m.reportTime ?? null,
    temp: m.temp ?? null,
    dewp: m.dewp ?? null,
    wdir: m.wdir ?? null,
    wspd: m.wspd ?? null, // knots
    wgst: m.wgst ?? null,
    visib: m.visib ?? null,
    altim: m.altim ?? null,
    cover: m.cover ?? null,
    wx: m.wxString ?? null, // present weather codes, e.g. "-RA" — null when dry
    raw: m.rawOb ?? null,
  }
}

function packOpenMeteo(raw) {
  if (!raw?.current) return null
  const c = raw.current
  return {
    temp: c.temperature_2m,
    feels: c.apparent_temperature,
    rh: c.relative_humidity_2m,
    precip: c.precipitation,
    rain: c.rain,
    snow: c.snowfall,
    cloud: c.cloud_cover,
    wind: c.wind_speed_10m,
    gust: c.wind_gusts_10m,
    code: c.weather_code,
  }
}

function packJcdecaux(stations) {
  // Fields GBFS doesn't carry: telemetry link state, admin status, main vs
  // overflow stand split. Untested until a key is configured — guarded by
  // try/catch in snapshot().
  const out = {}
  for (const st of stations) {
    out[String(st.number)] = [
      st.connected ? 1 : 0,
      st.status === 'OPEN' ? 1 : 0,
      st.mainStands?.availabilities?.bikes ?? -1,
      st.mainStands?.availabilities?.stands ?? -1,
      st.overflowStands?.availabilities?.bikes ?? -1,
      st.overflowStands?.availabilities?.stands ?? -1,
    ]
  }
  return out
}

let lastMetar = null // half-hourly cadence — reuse between minutely snapshots on fetch failure

async function snapshot(tag) {
  const nowMs = Date.now()
  const [status, metarRaw, omRaw, jcd] = await Promise.all([
    getJson(`${GBFS}/station_status.json`),
    getJson(METAR).catch(() => null), // extras must never fail the snapshot
    getJson(OPEN_METEO).catch(() => null),
    JCD ? getJson(JCD).catch((e) => (console.error(`jcdecaux: ${e.message}`), null)) : null,
  ])

  const s = {}
  for (const st of status.data.stations) {
    const flags = (st.is_installed ? 4 : 0) + (st.is_renting ? 2 : 0) + (st.is_returning ? 1 : 0)
    const age = st.last_reported
      ? Math.max(0, Math.round((nowMs - new Date(st.last_reported).getTime()) / 1000))
      : -1
    s[st.station_id] = [
      st.num_vehicles_available ?? 0,
      st.num_docks_available ?? 0,
      st.num_vehicles_disabled ?? 0,
      st.num_docks_disabled ?? 0,
      flags,
      age,
    ]
  }

  const metar = packMetar(metarRaw) ?? lastMetar
  if (metar) lastMetar = metar

  const line = {
    t: new Date(nowMs).toISOString(),
    v: 3,
    metar,
    om: packOpenMeteo(omRaw),
    s,
  }
  if (jcd) {
    try {
      line.jd = packJcdecaux(jcd)
    } catch (e) {
      console.error(`jcdecaux pack: ${e.message}`)
    }
  }

  const month = line.t.slice(0, 7)
  const file = join(DATA_DIR, `snapshots-${month}${tag ? `-${tag}` : ''}.ndjson`)
  await appendFile(file, JSON.stringify(line) + '\n')
  await updateRecent(line, nowMs).catch((e) => console.error(`recent.json: ${e.message}`))
  console.log(`${line.t}  ${Object.keys(s).length} stations${line.jd ? ' +jcd' : ''} → ${file}`)
}

function argNum(flag, fallback) {
  const i = process.argv.indexOf(flag)
  return i === -1 ? fallback : Number(process.argv[i + 1] ?? fallback)
}

function argStr(flag) {
  const i = process.argv.indexOf(flag)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true })
  await ensureStationInfo()

  const tag = argStr('--tag')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  if (process.argv.includes('--loop')) {
    const interval = Math.max(30, argNum('--loop', 300)) * 1000
    console.log(`looping every ${interval / 1000}s${tag ? ` (tag: ${tag})` : ''} — Ctrl+C to stop`)
    for (;;) {
      try {
        await snapshot(tag)
      } catch (e) {
        console.error(`snapshot failed: ${e.message}`)
      }
      await sleep(interval)
    }
  }

  const burst = Math.max(1, argNum('--burst', 1))
  const every = Math.max(10, argNum('--every', 60)) * 1000
  for (let i = 0; i < burst; i++) {
    if (i > 0) await sleep(every)
    try {
      await snapshot(tag)
    } catch (e) {
      console.error(`snapshot failed: ${e.message}`)
      process.exitCode = 1
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
