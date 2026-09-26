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
import { activeEventsAt, eventsNear } from '../src/lib/events.js'

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

/** The curated calendar plus every echo.lu instance ever fetched (the app's
 *  events.json only carries the next two weeks; the archive in data/ keeps
 *  the past ones so their effects can be learned). */
export async function loadEventCalendar() {
  const read = async (file) => {
    try {
      const j = JSON.parse(await readFile(file, 'utf8'))
      return Array.isArray(j?.events) ? j.events : []
    } catch {
      return []
    }
  }
  const byId = new Map()
  for (const ev of await read(join(ROOT, 'data', 'events-archive.json'))) byId.set(ev.id, ev)
  for (const ev of await read(join(ROOT, 'public', 'events.json'))) byId.set(ev.id, ev) // current wins
  return [...byId.values()]
}

/** Aggregates snapshot lines into the profiles structure the app's
 *  predictor consumes. */
export function buildProfiles(lines, capacities, events = []) {
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
  // ---- flow rates for the birth–death model ----
  // Per station × bucket: bikes returned (λ, "births") and taken (μ,
  // "deaths") per hour, estimated from minute-to-minute deltas. At 1-minute
  // resolution net change ≈ gross flow (simultaneous opposite events within
  // one minute are rare); jumps of ≥4/min are operator rebalancing, skipped.
  const flowAcc = new Map() // id → Map(key → {up, down, n})
  const flowGlobal = new Map() // key → {up, down, n}
  for (const line of lines) {
    const t0 = Date.parse(line.t)
    const next = lineAt(t0 + 60_000)
    if (!next) continue
    const gapMin = (Date.parse(next.t) - t0) / 60_000
    if (gapMin < 0.75 || gapMin > 1.5) continue // only clean 1-minute pairs
    const key = bucketKey(line.t)
    for (const [id, [b0]] of Object.entries(line.s)) {
      const rec = next.s[id]
      if (!rec) continue
      const d = rec[0] - b0
      if (Math.abs(d) >= 4) continue // rebalancing, not customer flow
      let byKey = flowAcc.get(id)
      if (!byKey) flowAcc.set(id, (byKey = new Map()))
      let f = byKey.get(key)
      if (!f) byKey.set(key, (f = { up: 0, down: 0, n: 0 }))
      let g = flowGlobal.get(key)
      if (!g) flowGlobal.set(key, (g = { up: 0, down: 0, n: 0 }))
      if (d > 0) {
        f.up += d
        g.up += d
      } else if (d < 0) {
        f.down -= d
        g.down -= d
      }
      f.n++
      g.n++
    }
  }
  const perHour = (sum, n) => +((sum / n) * 60).toFixed(3)
  const flows =
    [...flowGlobal.values()].reduce((s, g) => s + g.n, 0) >= 10000
      ? {
          global: Object.fromEntries(
            [...flowGlobal]
              .filter(([, g]) => g.n >= 60)
              .map(([k, g]) => [k, [perHour(g.up, g.n), perHour(g.down, g.n), g.n]])
          ),
          stations: Object.fromEntries(
            [...flowAcc].map(([id, byKey]) => [
              id,
              Object.fromEntries(
                [...byKey]
                  .filter(([, f]) => f.n >= 60)
                  .map(([k, f]) => [k, [perHour(f.up, f.n), perHour(f.down, f.n), f.n]])
              ),
            ])
          ),
        }
      : null

  // ---- event effects ----
  // For snapshots taken while a calendar event was active: how far did the
  // nearby stations sit from their normal bucket mean? Pooled per venue so
  // recurring editions (Schueberfouer 2026, 2027, …) share one estimate.
  const eventAcc = new Map() // venue → {sum, n}
  if (events.length) {
    for (const line of lines) {
      const active = activeEventsAt(events, new Date(line.t))
      if (!active.length) continue
      const key = bucketKey(line.t)
      for (const [id, [bikes]] of Object.entries(line.s)) {
        const cap = capacities[id]?.capacity
        const st = capacities[id]
        if (!cap || st?.lat == null) continue
        const near = eventsNear(active, st)
        if (!near.length) continue
        const m = meanFor(id, key)
        if (m == null) continue
        const dev = Math.min(bikes / cap, 1) - m
        for (const ev of near) {
          let acc = eventAcc.get(ev.venue)
          if (!acc) eventAcc.set(ev.venue, (acc = { sum: 0, n: 0 }))
          acc.sum += dev
          acc.n++
        }
      }
    }
  }
  const eventEffects = Object.fromEntries(
    [...eventAcc]
      .filter(([, a]) => a.n >= 300)
      .map(([venue, a]) => [venue, [+(a.sum / a.n).toFixed(4), a.n]])
  )

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

  // ---- the predictor's profile base, mirrored ----
  // Shrunk station fraction plus the learned event shift, computed from the
  // emitted (rounded) numbers exactly like src/lib/predictor.js does, so the
  // two fits below are calibrated against what the app will really use.
  const SHRINK_K = 8 // as predictor.js
  const EVENT_DELTA_CAP = 0.35 // as predictor.js
  const round4 = (v) => +v.toFixed(4)
  const shrunk = new Map() // id → Map(key → shrunk fraction)
  for (const [id, byKey] of stations) {
    const m = new Map()
    for (const [key, s] of byKey) {
      m.set(key, (s.n * round4(s.mean) + SHRINK_K * round4(global.get(key).mean)) / (s.n + SHRINK_K))
    }
    shrunk.set(id, m)
  }
  const baseFrac = (id, key, active) => {
    const f = shrunk.get(id)?.get(key)
    if (f == null) return null
    let delta = 0
    for (const ev of eventsNear(active, capacities[id])) delta += eventEffects[ev.venue]?.[0] ?? 0
    delta = Math.max(-EVENT_DELTA_CAP, Math.min(EVENT_DELTA_CAP, delta))
    return Math.min(Math.max(f + delta, 0), 1)
  }

  // ---- calibrated live/profile blend weights ----
  // MAE-optimal weight of the live count per forecast horizon and per ORIGIN
  // bucket, fitted on these very snapshots: one origin per hour, all
  // stations, w on a 0.05 grid. Each bucket's loss curve is shrunk toward the
  // global one with BLEND_K pseudo-samples before taking the argmin. The
  // learned curve is not geometric (which is what the rho path-product
  // assumes): ~1 at 1 h, a floor around 12–18 h and a rise again at 24 h,
  // where station-level offsets recur with the daily cycle.
  const BLEND_H = [1, 2, 3, 4, 6, 9, 12, 18, 24, 30, 36, 42, 48]
  const BLEND_K = 1000
  const BLEND_MIN_N = 500 // per horizon, else the predictor keeps the rho path
  const BLEND_TOL_MS = 7.5 * 60_000
  const W_STEPS = 21
  const timeline = lines.map((l) => ({ ms: Date.parse(l.t), line: l })).sort((a, b) => a.ms - b.ms)
  const nearest = (ms) => {
    let lo = 0
    let hi = timeline.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (timeline[mid].ms < ms) lo = mid + 1
      else hi = mid
    }
    let best = null
    for (const c of [timeline[lo - 1], timeline[lo]]) {
      if (c && (!best || Math.abs(c.ms - ms) < Math.abs(best.ms - ms))) best = c
    }
    return best && Math.abs(best.ms - ms) <= BLEND_TOL_MS ? best : null
  }
  const lossG = new Map(BLEND_H.map((h) => [h, { abs: new Float64Array(W_STEPS), n: 0 }]))
  const lossB = new Map() // `${h}|${originKey}` → {abs, n}
  const firstMs = timeline[0]?.ms ?? 0
  const lastMs = timeline.at(-1)?.ms ?? 0
  for (let t = Math.ceil(firstMs / 3600_000) * 3600_000; t <= lastMs; t += 3600_000) {
    const origin = nearest(t)
    if (!origin) continue
    const key0 = bucketKey(origin.line.t)
    for (const h of BLEND_H) {
      const target = nearest(origin.ms + h * 3600_000)
      if (!target) continue
      const key1 = bucketKey(target.line.t)
      const active = events.length ? activeEventsAt(events, new Date(target.ms)) : []
      const g = lossG.get(h)
      let b = lossB.get(`${h}|${key0}`)
      if (!b) lossB.set(`${h}|${key0}`, (b = { abs: new Float64Array(W_STEPS), n: 0 }))
      for (const [id, [actual]] of Object.entries(target.line.s)) {
        const cap = capacities[id]?.capacity
        const rec = origin.line.s[id]
        if (!cap || !rec) continue
        const base = baseFrac(id, key1, active)
        if (base == null) continue
        const live = Math.min(rec[0] / cap, 1)
        for (let i = 0; i < W_STEPS; i++) {
          const w = i / (W_STEPS - 1)
          const e = Math.abs(Math.round((w * live + (1 - w) * base) * cap) - actual)
          g.abs[i] += e
          b.abs[i] += e
        }
        g.n++
        b.n++
      }
    }
  }
  const bestW = (abs) => +(abs.indexOf(Math.min(...abs)) / (W_STEPS - 1)).toFixed(2)
  let blend = null
  if (BLEND_H.every((h) => lossG.get(h).n >= BLEND_MIN_N)) {
    blend = { horizons: BLEND_H, global: {}, byKey: {} }
    for (const h of BLEND_H) blend.global[h] = bestW(lossG.get(h).abs)
    for (const [k, b] of lossB) {
      const [hs, key] = k.split('|')
      const g = lossG.get(Number(hs))
      ;(blend.byKey[key] ??= {})[hs] = bestW(b.abs.map((v, i) => v + (BLEND_K * g.abs[i]) / g.n))
    }
    for (const row of Object.values(blend.byKey)) {
      for (const h of BLEND_H) row[h] ??= blend.global[h]
    }
  }

  // ---- recent per-station bias ----
  // Mean residual (actual − profile base) of the last BIAS_DAYS per
  // station × bucket, shrunk on the number of distinct days d/(d + BIAS_K) —
  // the minute snapshots within an hour are ~one observation, not 60. A cheap
  // adapter for regime changes (holidays ending, la rentrée) that the
  // full-history means lag behind. Near-zero cells are dropped to keep the
  // file small.
  const BIAS_DAYS = 7
  const BIAS_K = 3
  const BIAS_MIN = 0.005
  const biasAcc = new Map() // id → Map(key → {sum, n, days:Set})
  for (const { ms, line } of timeline) {
    if (ms < lastMs - BIAS_DAYS * 86400_000) continue
    const key = bucketKey(line.t)
    const day = line.t.slice(0, 10)
    const active = events.length ? activeEventsAt(events, new Date(ms)) : []
    for (const [id, [bikes]] of Object.entries(line.s)) {
      const cap = capacities[id]?.capacity
      if (!cap) continue
      const base = baseFrac(id, key, active)
      if (base == null) continue
      let byKey = biasAcc.get(id)
      if (!byKey) biasAcc.set(id, (byKey = new Map()))
      let a = byKey.get(key)
      if (!a) byKey.set(key, (a = { sum: 0, n: 0, days: new Set() }))
      a.sum += Math.min(bikes / cap, 1) - base
      a.n++
      a.days.add(day)
    }
  }
  const bias = {}
  for (const [id, byKey] of biasAcc) {
    for (const [key, a] of byKey) {
      const v = (a.sum / a.n) * (a.days.size / (a.days.size + BIAS_K))
      if (Math.abs(v) >= BIAS_MIN) (bias[id] ??= {})[key] = round4(v)
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
    blend,
    bias: Object.keys(bias).length ? bias : null,
    flows,
    eventEffects: Object.keys(eventEffects).length ? eventEffects : null,
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
  const events = await loadEventCalendar()
  const out = buildProfiles(lines, capacities, events)
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(out))
  console.log(
    `trained on ${out.snapshots} snapshots (${out.range.from} → ${out.range.to})\n` +
      `stations: ${Object.keys(out.stations).length}, buckets: ${Object.keys(out.global).length}, ` +
      `rain model: ${out.rain ? 'yes' : 'not enough data yet'}, ` +
      `event venues learned: ${Object.keys(out.eventEffects ?? {}).length}\n` +
      `blend w(h): ${out.blend ? Object.entries(out.blend.global).map(([h, w]) => `${h}h ${w}`).join(' ') : 'not enough data yet'}, ` +
      `bias cells: ${Object.values(out.bias ?? {}).reduce((n, byKey) => n + Object.keys(byKey).length, 0)}\n→ ${OUT}`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
