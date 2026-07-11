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

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = join(ROOT, 'data')
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

function bucketKey(isoTime) {
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

// ---- aggregation ----
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

async function main() {
  const capacities = JSON.parse(await readFile(join(DATA_DIR, 'stations.json'), 'utf8')).stations

  const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.ndjson')).sort()
  if (!files.length) {
    console.error('No data/*.ndjson snapshot files found. Run `npm run collect` first.')
    process.exit(1)
  }

  const stations = new Map() // id → Map(key → MeanAcc)
  const global = new Map() // key → MeanAcc
  const wet = new MeanAcc()
  const dry = new MeanAcc()
  const seenMinutes = new Set() // local + CI collectors may cover the same minutes
  let snapshots = 0
  let firstT = null
  let lastT = null

  // Wet detection across snapshot format versions: v3 lines carry a measured
  // METAR observation (wx = present-weather codes, null when dry); v1/v2 fall
  // back to the Open-Meteo precipitation estimate.
  const isWetLine = (line) => {
    if (line.metar) return /RA|DZ|SN|SG|PL|GR|GS|UP|TS/.test(line.metar.wx ?? '')
    return (line.wx?.precip ?? line.om?.precip ?? 0) >= 0.2
  }

  for (const file of files) {
    const text = await readFile(join(DATA_DIR, file), 'utf8')
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue
      let line
      try {
        line = JSON.parse(raw)
      } catch {
        continue // tolerate a torn write from an interrupted collector
      }
      const minute = line.t.slice(0, 16)
      if (seenMinutes.has(minute)) continue
      seenMinutes.add(minute)
      snapshots++
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
  }

  const out = {
    generatedAt: new Date().toISOString(),
    snapshots,
    range: { from: firstT, to: lastT },
    // wet-weather availability delta vs dry, applied globally by the predictor
    rain: wet.n >= 50 && dry.n >= 50 ? { delta: +(wet.mean - dry.mean).toFixed(4), wetN: wet.n, dryN: dry.n } : null,
    global: Object.fromEntries([...global].map(([k, a]) => [k, [+a.mean.toFixed(4), a.n]])),
    stations: Object.fromEntries(
      [...stations].map(([id, byKey]) => [
        id,
        Object.fromEntries([...byKey].map(([k, a]) => [k, [+a.mean.toFixed(4), a.n]])),
      ])
    ),
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(out))
  console.log(
    `trained on ${snapshots} snapshots (${firstT} → ${lastT})\n` +
      `stations: ${stations.size}, buckets: ${global.size}, rain model: ${out.rain ? 'yes' : 'not enough data yet'}\n` +
      `→ ${OUT}`
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
