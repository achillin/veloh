#!/usr/bin/env node
// Builds public/model/profiles.json from collected snapshots (data/*.ndjson).
//
// The "model" is deliberately transparent: per station, the mean availability
// fraction (bikes / capacity) for each dayType × hour bucket in Luxembourg
// local time, where dayType ∈ {wd, sat, sun} and public holidays count as
// Sundays. A global profile plus a rain adjustment (mean wet-minus-dry
// availability delta) round it out. The app's predictor shrinks sparse
// station buckets toward the global profile, so a few days of data already
// produce usable estimates that keep improving as snapshots accumulate.
//
// Usage: node model/train.mjs
// Also imported by model/evaluate.mjs (buildProfiles, loadSnapshotLines).

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = join(ROOT, 'data')
const OUT = join(ROOT, 'public', 'model', 'profiles.json')
const TZ = 'Europe/Luxembourg'

// ---- Luxembourg holidays (same rules as src/lib/holidays.js) ----
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return { month, day }
}

const holidayCache = new Map()
function isHoliday(year, month, day) {
  if (!holidayCache.has(year)) {
    const set = new Set(['1-1', '5-1', '5-9', '6-23', '8-15', '11-1', '12-25', '12-26'])
    const e = easterSunday(year)
    const base = new Date(Date.UTC(year, e.month - 1, e.day))
    for (const off of [1, 39, 50]) {
      const d = new Date(base)
      d.setUTCDate(d.getUTCDate() + off)
      set.add(`${d.getUTCMonth() + 1}-${d.getUTCDate()}`)
    }
    holidayCache.set(year, set)
  }
  return holidayCache.get(year).has(`${month}-${day}`)
}

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  hour12: false,
  weekday: 'short',
})

export function bucketKey(isoTime) {
  const parts = Object.fromEntries(fmt.formatToParts(new Date(isoTime)).map((p) => [p.type, p.value]))
  const hour = Number(parts.hour) % 24
  let dt
  if (isHoliday(Number(parts.year), Number(parts.month), Number(parts.day)) || parts.weekday === 'Sun') {
    dt = 'sun'
  } else if (parts.weekday === 'Sat') {
    dt = 'sat'
  } else {
    dt = 'wd'
  }
  return `${dt}-${hour}`
}

// Wet detection across snapshot format versions: v3 lines carry a measured
// METAR observation (wx = present-weather codes, null when dry); v1/v2 fall
// back to the Open-Meteo precipitation estimate.
export function isWetLine(line) {
  if (line.metar) return /RA|DZ|SN|SG|PL|GR|GS|UP|TS/.test(line.metar.wx ?? '')
  return (line.wx?.precip ?? line.om?.precip ?? 0) >= 0.2
}

class MeanAcc {
  constructor() {
    this.sum = 0
    this.n = 0
  }
  add(v) {
    this.sum += v
    this.n++
  }
  get mean() {
    return this.n ? this.sum / this.n : 0
  }
}

/** All snapshot lines from data/*.ndjson, de-duplicated per minute
 *  (local + CI collectors overlap) and sorted by time. */
export async function loadSnapshotLines(dataDir = DATA_DIR) {
  // closed periods are gzipped to stay under GitHub's 100 MB file limit
  const files = (await readdir(dataDir))
    .filter((f) => f.endsWith('.ndjson') || f.endsWith('.ndjson.gz'))
    .sort()
  const byMinute = new Map()
  for (const file of files) {
    const raw = await readFile(join(dataDir, file))
    const text = file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue
      let line
      try {
        line = JSON.parse(raw)
      } catch {
        continue // tolerate a torn write from an interrupted collector
      }
      const minute = line.t.slice(0, 16)
      if (!byMinute.has(minute)) byMinute.set(minute, line)
    }
  }
  return [...byMinute.values()].sort((a, b) => (a.t < b.t ? -1 : 1))
}

export async function loadCapacities(dataDir = DATA_DIR) {
  return JSON.parse(await readFile(join(dataDir, 'stations.json'), 'utf8')).stations
}

/** Aggregates snapshot lines into the profiles structure the app's
 *  predictor consumes. */
export function buildProfiles(lines, capacities) {
  const stations = new Map() // id → Map(key → MeanAcc)
  const global = new Map() // key → MeanAcc
  const wet = new MeanAcc()
  const dry = new MeanAcc()
  let firstT = null
  let lastT = null

  for (const line of lines) {
    if (!firstT || line.t < firstT) firstT = line.t
    if (!lastT || line.t > lastT) lastT = line.t
    const key = bucketKey(line.t)
    const isWet = isWetLine(line)

    let fracSum = 0
    let fracN = 0
    for (const [id, [bikes]] of Object.entries(line.s)) {
      const cap = capacities[id]?.capacity
      if (!cap) continue
      const frac = Math.min(bikes / cap, 1)
      fracSum += frac
      fracN++

      let byKey = stations.get(id)
      if (!byKey) stations.set(id, (byKey = new Map()))
      let acc = byKey.get(key)
      if (!acc) byKey.set(key, (acc = new MeanAcc()))
      acc.add(frac)

      let gacc = global.get(key)
      if (!gacc) global.set(key, (gacc = new MeanAcc()))
      gacc.add(frac)
    }

    if (fracN) (isWet ? wet : dry).add(fracSum / fracN)
  }

  // ---- second pass: learned persistence ----
  // Lag-1h autocorrelation of the availability anomaly per bucket: how much
  // of "this station is unusually empty/full right now" survives an hour.
  // The predictor turns this into the live-vs-profile blending weight.
  const byMinute = new Map(lines.map((l) => [l.t.slice(0, 16), l]))
  const lineAt = (ms) => {
    for (const off of [0, 1, -1, 2, -2]) {
      const c = byMinute.get(new Date(ms + off * 60_000).toISOString().slice(0, 16))
      if (c) return c
    }
    return null
  }
  const meanFor = (id, key) => {
    const s = stations.get(id)?.get(key)
    if (s?.n) return s.mean
    const g = global.get(key)
    return g?.n ? g.mean : null
  }
  const decayAcc = new Map() // key → {num, den, n}
  let dNum = 0
  let dDen = 0
  let dN = 0
  for (const line of lines) {
    const next = lineAt(Date.parse(line.t) + 3600_000)
    if (!next) continue
    const key0 = bucketKey(line.t)
    const key1 = bucketKey(next.t)
    for (const [id, [b0]] of Object.entries(line.s)) {
      const cap = capacities[id]?.capacity
      const rec = next.s[id]
      if (!cap || !rec) continue
      if (Math.abs(rec[0] - b0) >= 8) continue // operator rebalancing, not organic flow
      const m0 = meanFor(id, key0)
      const m1 = meanFor(id, key1)
      if (m0 == null || m1 == null) continue
      const a0 = Math.min(b0 / cap, 1) - m0
      const a1 = Math.min(rec[0] / cap, 1) - m1
      let acc = decayAcc.get(key0)
      if (!acc) decayAcc.set(key0, (acc = { num: 0, den: 0, n: 0 }))
      acc.num += a0 * a1
      acc.den += a0 * a0
      acc.n++
      dNum += a0 * a1
      dDen += a0 * a0
      dN++
    }
  }
  // ---- rebalancing statistics ----
  // How often does the operator's truck touch a station in a given hour
  // bucket: a jump of ≥5 bikes within 5 minutes counts as an event; we
  // report the fraction of observed days with such an event. The app shows
  // "refills common around this hour" chips from this.
  const REBAL_JUMP = 5
  const rebalAcc = new Map() // id → Map(key → {up:Set(days), down:Set(days)})
  const obsDays = new Map() // key → Set(days observed)
  for (const line of lines) {
    const next = lineAt(Date.parse(line.t) + 5 * 60_000)
    if (!next) continue
    const key = bucketKey(line.t)
    const day = line.t.slice(0, 10)
    let od = obsDays.get(key)
    if (!od) obsDays.set(key, (od = new Set()))
    od.add(day)
    for (const [id, [b0]] of Object.entries(line.s)) {
      const rec = next.s[id]
      if (!rec) continue
      const d = rec[0] - b0
      if (Math.abs(d) < REBAL_JUMP) continue
      let byKey = rebalAcc.get(id)
      if (!byKey) rebalAcc.set(id, (byKey = new Map()))
      let e = byKey.get(key)
      if (!e) byKey.set(key, (e = { up: new Set(), down: new Set() }))
      ;(d > 0 ? e.up : e.down).add(day)
    }
  }
  const rebalance = {}
  for (const [id, byKey] of rebalAcc) {
    for (const [key, e] of byKey) {
      const n = obsDays.get(key)?.size ?? 0
      if (!n) continue
      const pUp = e.up.size / n
      const pDown = e.down.size / n
      if (Math.max(pUp, pDown) >= 0.15) {
        ;(rebalance[id] ??= {})[key] = [+pUp.toFixed(2), +pDown.toFixed(2)]
      }
    }
  }

  const clampRho = (r) => +Math.min(Math.max(r, 0.01), 0.995).toFixed(4)
  const decay =
    dDen > 0 && dN >= 500
      ? {
          global: [clampRho(dNum / dDen), dN],
          byKey: Object.fromEntries(
            [...decayAcc]
              .filter(([, a]) => a.den > 0 && a.n >= 50)
              .map(([k, a]) => [k, [clampRho(a.num / a.den), a.n]])
          ),
        }
      : null

  return {
    generatedAt: new Date().toISOString(),
    snapshots: lines.length,
    range: { from: firstT, to: lastT },
    // wet-weather availability delta vs dry, applied globally by the predictor
    rain:
      wet.n >= 50 && dry.n >= 50
        ? { delta: +(wet.mean - dry.mean).toFixed(4), wetN: wet.n, dryN: dry.n }
        : null,
    decay,
    rebalance: Object.keys(rebalance).length ? rebalance : null,
    global: Object.fromEntries([...global].map(([k, a]) => [k, [+a.mean.toFixed(4), a.n]])),
    stations: Object.fromEntries(
      [...stations].map(([id, byKey]) => [
        id,
        Object.fromEntries([...byKey].map(([k, a]) => [k, [+a.mean.toFixed(4), a.n]])),
      ])
    ),
  }
}

async function main() {
  const capacities = await loadCapacities()
  const lines = await loadSnapshotLines()
  if (!lines.length) {
    console.error('No data/*.ndjson snapshot files found. Run `npm run collect` first.')
    process.exit(1)
  }
  const out = buildProfiles(lines, capacities)
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(out))
  console.log(
    `trained on ${out.snapshots} snapshots (${out.range.from} → ${out.range.to})\n` +
      `stations: ${Object.keys(out.stations).length}, buckets: ${Object.keys(out.global).length}, ` +
      `rain model: ${out.rain ? 'yes' : 'not enough data yet'}\n→ ${OUT}`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
