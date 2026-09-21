#!/usr/bin/env node
// Experiment "recency": profile drift.
//
// Hypothesis: profiles averaged over Jul 11 → now (summer holidays,
// Schueberfouer) no longer fit mid-September, which would explain the
// model's negative bias (it under-predicts bikes) and some persistent
// station-level biases. Three families of fixes are evaluated:
//   (a) hard window — station/global means from only the last N days
//       (N ∈ {14, 21, 28, 42}); decay/flows/events kept from the full
//       history, plus two "full rebuild" variants where everything
//       (decay, flows, event effects too) comes from the last N days;
//   (b) exponential time-weighting of the means with half-life
//       {7, 14, 28} days (decay/flows from the full history);
//   (c) full-history profiles + per-station additive bias correction from
//       the last 7 days' mean residual (actual − profile) per dayType-hour
//       bucket, shrunk with k = 8 pseudo-observations (as specified), plus
//       a day-count shrinkage variant, a half-strength variant and a
//       per-station constant (all buckets pooled) variant.
//
// Everything is out-of-sample: each window trains on snapshots strictly
// before it and predicts with only what the app would have had at T−h.
// The unmodified predict() on unmodified profiles is the baseline; the
// variants either feed predict() a modified profiles object ((a), (b)) or
// go through predictVariant(), a verbatim copy of predict() with the bias
// term added to the profile fraction before blending ((c)).
//
// Usage (inside WSL): node model/experiments/recency.mjs
// Writes model/experiments/out/recency.json

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSnapshotLines, loadCapacities, buildProfiles, loadEventCalendar, bucketKey } from '../train.mjs'
import { predict } from '../../src/lib/predictor.js'
import { dayType } from '../../src/lib/holidays.js'
import { activeEventsAt, eventsNear } from '../../src/lib/events.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out', 'recency.json')
const HORIZONS_H = [1, 3, 6, 24]
const LOOKUP_TOL_MS = 7.5 * 60_000
const DAY_MS = 86400_000
const WINDOWS = [
  { name: 'day 2026-09-17 @15min', from: '2026-09-17', to: '2026-09-17', stepMin: 15 },
  { name: 'week 2026-09-11..17 @30min', from: '2026-09-11', to: '2026-09-17', stepMin: 30 },
]

// ---------------------------------------------------------------- time utils
const luxFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Luxembourg',
  hour: '2-digit',
  hour12: false,
  minute: '2-digit',
})
const luxParts = (d) => Object.fromEntries(luxFmt.formatToParts(d).map((p) => [p.type, Number(p.value)]))
/** ms of local midnight for a YYYY-MM-DD in Luxembourg (DST-aware). */
function luxMidnightMs(day) {
  const guess = Date.parse(`${day}T00:00:00Z`)
  for (const off of [2, 1, 0]) {
    const t = guess - off * 3600_000
    const p = luxParts(new Date(t))
    if (p.hour % 24 === 0 && p.minute === 0) return t
  }
  return guess
}

function nearestLine(sorted, timeMs, tolMs = LOOKUP_TOL_MS) {
  let lo = 0
  let hi = sorted.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid].ms < timeMs) lo = mid + 1
    else hi = mid
  }
  let best = null
  let bestD = Infinity
  for (const i of [lo - 1, lo, lo + 1]) {
    const line = sorted[i]
    if (!line) continue
    const d = Math.abs(line.ms - timeMs)
    if (d < bestD) {
      bestD = d
      best = line
    }
  }
  return bestD <= tolMs ? best : null
}

function liveGlobalMean(line, capacities) {
  let sum = 0
  let n = 0
  for (const [id, [bikes]] of Object.entries(line.s)) {
    const cap = capacities[id]?.capacity
    if (!cap) continue
    sum += Math.min(bikes / cap, 1)
    n++
  }
  return n ? sum / n : 0.5
}

// ------------------------------------------- predictor internals (verbatim)
// Copied from src/lib/predictor.js so that predictVariant() is the standard
// predict() plus one additive bias term on the profile fraction. The
// "check:predictVariant(no bias)" config asserts the copy is faithful.
const SHRINK_K = 8
const PERSISTENCE_HOURS = 2.5
const PERSISTENCE_HORIZON_H = 6
const LEARNED_HORIZON_H = 12
const DECAY_SHRINK_K = 300
const EVENT_DELTA_CAP = 0.35
const EVENT_MIN_N = 300

const profileKey = (date) => `${dayType(date)}-${date.getHours()}`

function learnedFraction(profiles, stationId, key) {
  const g = profiles?.global?.[key]
  const s = profiles?.stations?.[stationId]?.[key]
  if (!g && !s) return null
  const gMean = g ? g[0] : s[0]
  if (!s) return { frac: gMean, n: 0 }
  const [sMean, n] = s
  return { frac: (n * sMean + SHRINK_K * gMean) / (n + SHRINK_K), n }
}

function eventAdjustment(profiles, station, target, ctx) {
  const active = ctx.activeEvents ?? (ctx.events?.length ? activeEventsAt(ctx.events, target) : null)
  if (!active?.length) return 0
  const near = eventsNear(active, station)
  let delta = 0
  for (const ev of near) {
    const eff = profiles?.eventEffects?.[ev.venue]
    if (eff && eff[1] >= EVENT_MIN_N) delta += eff[0]
  }
  return Math.max(-EVENT_DELTA_CAP, Math.min(EVENT_DELTA_CAP, delta))
}

function bucketRho(profiles, date) {
  const d = profiles?.decay
  if (!d?.global) return null
  const g = d.global[0]
  const s = d.byKey?.[profileKey(date)]
  const rho = s ? (s[1] * s[0] + DECAY_SHRINK_K * g) / (s[1] + DECAY_SHRINK_K) : g
  return Math.min(Math.max(rho, 0.01), 0.995)
}

/** predict() with an additive per-station×bucket bias on the profile
 *  fraction (ctx.biasFn(stationId, key) → Δfrac), applied before blending.
 *  No forecast is ever passed in this harness, so the rain term is 0. */
function predictVariant(station, target, ctx) {
  const { now, profiles, globalLiveMean, biasFn } = ctx
  const cap = Math.max(station.capacity, 1)
  const liveFrac = Math.min(station.bikes / cap, 1)
  const dtH = (target.getTime() - now.getTime()) / 3.6e6
  if (dtH <= 0.01) return { frac: liveFrac, bikes: station.bikes }
  const key = profileKey(target)
  const learned = learnedFraction(profiles, station.id, key)
  let base = learned ? learned.frac : globalLiveMean
  base += eventAdjustment(profiles, station, target, ctx)
  if (biasFn) base += biasFn(station.id, key)
  base = Math.min(Math.max(base, 0), 1)
  let frac = base
  const horizon = profiles?.decay ? LEARNED_HORIZON_H : PERSISTENCE_HORIZON_H
  if (dtH < horizon) {
    let w
    const rho0 = bucketRho(profiles, now)
    if (rho0 != null) {
      w = 1
      let remaining = dtH
      for (let i = 0; remaining > 0 && i < 24; i++) {
        const r = bucketRho(profiles, new Date(now.getTime() + i * 3.6e6)) ?? rho0
        w *= Math.pow(r, Math.min(1, remaining))
        remaining -= 1
      }
    } else {
      w = Math.exp(-dtH / PERSISTENCE_HOURS)
    }
    frac = w * liveFrac + (1 - w) * base
  }
  return { frac, bikes: Math.round(frac * cap) }
}

// ------------------------------------------------ fast (weighted) profiles
const KEYS = []
for (const dt of ['wd', 'sat', 'sun']) for (let h = 0; h < 24; h++) KEYS.push(`${dt}-${h}`)
const KEY_IDX = new Map(KEYS.map((k, i) => [k, i]))

/** Per line: ms, bucket index, station indices + availability fractions —
 *  so every re-weighting of the means is a single typed-array pass. */
function precompute(lines, stationIds, capacities) {
  const ST_IDX = new Map(stationIds.map((id, i) => [id, i]))
  return lines.map((line) => {
    const idx = []
    const fr = []
    for (const [id, [bikes]] of Object.entries(line.s)) {
      const cap = capacities[id]?.capacity
      if (!cap) continue
      idx.push(ST_IDX.get(id))
      fr.push(Math.min(bikes / cap, 1))
    }
    return {
      ms: line.ms,
      day: line.t.slice(0, 10),
      keyIdx: KEY_IDX.get(bucketKey(line.t)),
      idx: Uint16Array.from(idx),
      frac: Float32Array.from(fr),
    }
  })
}

/** Weighted station × bucket and global means in the profiles.json shape.
 *  With weightFn ≡ 1 this reproduces buildProfiles' global/stations. */
function weightedMeans(pre, stationIds, weightFn) {
  const nS = stationIds.length
  const nK = KEYS.length
  const sum = new Float64Array(nS * nK)
  const wsum = new Float64Array(nS * nK)
  const gsum = new Float64Array(nK)
  const gw = new Float64Array(nK)
  for (const p of pre) {
    const w = weightFn(p.ms)
    if (!(w > 0)) continue
    const k = p.keyIdx
    for (let i = 0; i < p.idx.length; i++) {
      const o = p.idx[i] * nK + k
      const v = w * p.frac[i]
      sum[o] += v
      wsum[o] += w
      gsum[k] += v
      gw[k] += w
    }
  }
  const global = {}
  for (let k = 0; k < nK; k++) if (gw[k] > 0) global[KEYS[k]] = [+(gsum[k] / gw[k]).toFixed(4), Math.round(gw[k])]
  const stations = {}
  for (let s = 0; s < nS; s++) {
    const byKey = {}
    let any = false
    for (let k = 0; k < nK; k++) {
      const o = s * nK + k
      if (wsum[o] > 0) {
        byKey[KEYS[k]] = [+(sum[o] / wsum[o]).toFixed(4), Math.round(wsum[o])]
        any = true
      }
    }
    if (any) stations[stationIds[s]] = byKey
  }
  return { global, stations }
}

/** Residual statistics (actual − profile-only prediction) per station ×
 *  bucket over the given lines, against `profiles` (incl. its event
 *  effects, so an active event's shift is not absorbed into the bias). */
function residualStats(pre, stationIds, capacities, profiles, events) {
  const nS = stationIds.length
  const nK = KEYS.length
  const sum = new Float64Array(nS * nK)
  const n = new Float64Array(nS * nK)
  const days = Array.from({ length: nS * nK }, () => null)
  const stSum = new Float64Array(nS)
  const stN = new Float64Array(nS)
  const stObj = stationIds.map((id) => ({ id, capacity: capacities[id].capacity, lat: capacities[id].lat, lon: capacities[id].lon }))
  const base = new Float64Array(nS * nK).fill(NaN)
  for (let s = 0; s < nS; s++)
    for (let k = 0; k < nK; k++) {
      const l = learnedFraction(profiles, stationIds[s], KEYS[k])
      if (l) base[s * nK + k] = l.frac
    }
  for (const p of pre) {
    const date = new Date(p.ms)
    const active = events.length ? activeEventsAt(events, date) : []
    const k = p.keyIdx
    for (let i = 0; i < p.idx.length; i++) {
      const s = p.idx[i]
      const o = s * nK + k
      let b = base[o]
      if (Number.isNaN(b)) continue
      if (active.length) b += eventAdjustment(profiles, stObj[s], date, { activeEvents: active })
      b = Math.min(Math.max(b, 0), 1)
      const r = p.frac[i] - b
      sum[o] += r
      n[o]++
      ;(days[o] ??= new Set()).add(p.day)
      stSum[s] += r
      stN[s]++
    }
  }
  return { sum, n, days, stSum, stN, nK, ST_IDX: new Map(stationIds.map((id, i) => [id, i])) }
}

/** biasFn factories on top of residualStats. */
function biasFns(rs, capacities) {
  const { sum, n, days, stSum, stN, nK, ST_IDX } = rs
  const bucket = (s, k) => {
    const o = s * nK + k
    return n[o] ? sum[o] / n[o] : 0
  }
  const make = (fn) => {
    const cache = new Map()
    for (const [id, s] of ST_IDX) {
      const arr = new Float64Array(nK)
      for (let k = 0; k < nK; k++) arr[k] = fn(s, k)
      cache.set(id, arr)
    }
    // mean |correction| in bikes over station×bucket cells with data — a
    // size gauge for the console summary
    let a = 0
    let c = 0
    for (const [id, arr] of cache)
      for (let k = 0; k < nK; k++)
        if (n[ST_IDX.get(id) * nK + k]) {
          a += Math.abs(arr[k]) * capacities[id].capacity
          c++
        }
    const biasFn = (id, key) => {
      const arr = cache.get(id)
      const k = KEY_IDX.get(key)
      return arr && k != null ? arr[k] : 0
    }
    biasFn.meanAbsBikes = c ? +(a / c).toFixed(3) : 0
    return biasFn
  }
  return {
    // as specified: shrink with k = 8 pseudo-observations (minute snapshots)
    bucketK8: make((s, k) => sum[s * nK + k] / (n[s * nK + k] + 8)),
    // half strength
    bucketK8Half: make((s, k) => 0.5 * (sum[s * nK + k] / (n[s * nK + k] + 8))),
    // shrink on the number of distinct days in the bucket (k = 3 days) —
    // minute snapshots within an hour are ~one observation, not 60
    bucketDays3: make((s, k) => {
      const d = days[s * nK + k]?.size ?? 0
      return d ? bucket(s, k) * (d / (d + 3)) : 0
    }),
    // per-station constant (all buckets pooled)
    stationConst: make((s) => (stN[s] ? stSum[s] / (stN[s] + 8) : 0)),
  }
}

// ------------------------------------------------------------ accumulators
class Acc {
  constructor() {
    this.n = 0
    this.abs = 0
    this.sq = 0
    this.bias = 0
    this.absP = 0
    this.absQ = 0
    this.biasQ = 0
  }
  add(err, errP, errQ) {
    this.n++
    this.abs += Math.abs(err)
    this.sq += err * err
    this.bias += err
    this.absP += Math.abs(errP)
    this.absQ += Math.abs(errQ)
    this.biasQ += errQ
  }
  out() {
    const n = this.n || 1
    return {
      n: this.n,
      mae: +(this.abs / n).toFixed(3),
      rmse: +Math.sqrt(this.sq / n).toFixed(3),
      bias: +(this.bias / n).toFixed(3),
      persistMae: +(this.absP / n).toFixed(3),
      profileOnlyMae: +(this.absQ / n).toFixed(3),
      profileOnlyBias: +(this.biasQ / n).toFixed(3),
    }
  }
}

// --------------------------------------------------------------- main loop
function evaluateWindow(win, lines, pre, capacities, stationIds, events) {
  const t0 = Date.now()
  const T0 = luxMidnightMs(win.from)
  const T1 = luxMidnightMs(win.to) + DAY_MS
  const stepMs = win.stepMin * 60_000
  const trainLines = lines.filter((l) => l.ms < T0)
  const testLines = lines.filter((l) => l.ms >= T0 && l.ms < T1)
  const preTrain = pre.filter((p) => p.ms < T0)
  console.error(`\n### ${win.name}: ${testLines.length} test snapshots, ${trainLines.length} training (last ${trainLines.at(-1)?.t})`)
  if (testLines.length < 10) throw new Error('window not covered by snapshots')

  const baseline = buildProfiles(trainLines, capacities, events)
  console.error(`baseline profiles built in ${((Date.now() - t0) / 1000).toFixed(1)} s (decay global rho ${baseline.decay?.global?.[0]}, venues ${Object.keys(baseline.eventEffects ?? {}).length})`)
  const withMeans = (m, extra = {}) => ({ ...baseline, ...extra, global: m.global, stations: m.stations })
  const daysOfTrain = (T0 - preTrain[0].ms) / DAY_MS

  const configs = []
  configs.push({ name: 'baseline', family: 'baseline', profiles: baseline, note: `full history (${daysOfTrain.toFixed(0)} d), unmodified predict()` })
  configs.push({ name: 'check:rebuild-means(w=1)', family: 'check', check: true, profiles: withMeans(weightedMeans(preTrain, stationIds, () => 1)), note: 'must equal baseline' })
  configs.push({ name: 'check:predictVariant(no bias)', family: 'check', check: true, profiles: baseline, biasFn: () => 0, note: 'must equal baseline' })
  for (const N of [14, 21, 28, 42]) {
    const cut = T0 - N * DAY_MS
    configs.push({ name: `a:last${N}d-means`, family: 'a', profiles: withMeans(weightedMeans(preTrain, stationIds, (ms) => (ms >= cut ? 1 : 0))), note: `station/global means from the last ${N} d only; decay/flows/events from full history` })
  }
  for (const N of [14, 28]) {
    const cut = T0 - N * DAY_MS
    const sub = trainLines.filter((l) => l.ms >= cut)
    const prof = buildProfiles(sub, capacities, events)
    configs.push({ name: `a:last${N}d-full-rebuild`, family: 'a', profiles: prof, note: `everything (means, decay rho=${prof.decay?.global?.[0]}, flows, events) from the last ${N} d (${sub.length} snapshots)` })
  }
  for (const hl of [7, 14, 28]) {
    configs.push({ name: `b:halflife${hl}d`, family: 'b', profiles: withMeans(weightedMeans(preTrain, stationIds, (ms) => Math.pow(2, -(T0 - ms) / (hl * DAY_MS)))), note: `means exponentially weighted, half-life ${hl} d (reference = window start); decay/flows/events from full history` })
  }
  const rs = residualStats(preTrain.filter((p) => p.ms >= T0 - 7 * DAY_MS), stationIds, capacities, baseline, events)
  const bf = biasFns(rs, capacities)
  configs.push({ name: 'c:bias7d-bucket-k8', family: 'c', profiles: baseline, biasFn: bf.bucketK8, note: `per station×bucket mean residual over last 7 d, shrink k=8 minute-obs (as specified); mean |corr| ${bf.bucketK8.meanAbsBikes} bikes` })
  configs.push({ name: 'c:bias7d-bucket-k8-half', family: 'c', profiles: baseline, biasFn: bf.bucketK8Half, note: `same, applied at half strength; mean |corr| ${bf.bucketK8Half.meanAbsBikes} bikes` })
  configs.push({ name: 'c:bias7d-bucket-days-k3', family: 'c', profiles: baseline, biasFn: bf.bucketDays3, note: `same residuals, shrink on distinct days d/(d+3); mean |corr| ${bf.bucketDays3.meanAbsBikes} bikes` })
  configs.push({ name: 'c:bias7d-station-const', family: 'c', profiles: baseline, biasFn: bf.stationConst, note: `one constant per station (all buckets pooled, last 7 d); mean |corr| ${bf.stationConst.meanAbsBikes} bikes` })
  // combo: best-guess recency means + bias correction is NOT included on
  // purpose — (c) is defined against the full-history profile.

  const acc = new Map() // `${cfg}|${h}` → Acc
  const stAcc = new Map() // `${cfg}|${h}|${id}` → Acc
  const get = (map, key) => map.get(key) ?? (map.set(key, new Acc()), map.get(key))

  for (const h of HORIZONS_H) {
    const hMs = h * 3600_000
    for (let t = T0; t < T1; t += stepMs) {
      const actualLine = nearestLine(testLines, t)
      const baseLine = nearestLine(lines, t - hMs)
      if (!actualLine || !baseLine) continue
      const targetDate = new Date(actualLine.ms)
      const baseDate = new Date(baseLine.ms)
      const farBase = new Date(targetDate.getTime() - 13 * 3600_000) // beyond the 12 h blend horizon → pure profile
      const globalLiveMean = liveGlobalMean(baseLine, capacities)
      const activeEvents = events.length ? activeEventsAt(events, targetDate) : []
      for (const [id, [actual]] of Object.entries(actualLine.s)) {
        const cap = capacities[id]?.capacity
        const base = baseLine.s[id]
        if (!cap || !base) continue
        const live = base[0]
        const st = { id, capacity: cap, bikes: live, lat: capacities[id].lat, lon: capacities[id].lon }
        const errP = live - actual
        for (const cfg of configs) {
          const ctx = { now: baseDate, profiles: cfg.profiles, globalLiveMean, events, activeEvents, biasFn: cfg.biasFn }
          const fn = cfg.biasFn ? predictVariant : predict
          const p = fn(st, targetDate, ctx)
          const q = fn(st, targetDate, { ...ctx, now: farBase })
          const err = p.bikes - actual
          get(acc, `${cfg.name}|${h}`).add(err, errP, q.bikes - actual)
          get(stAcc, `${cfg.name}|${h}|${id}`).add(err, errP, q.bikes - actual)
        }
      }
    }
    console.error(`  h=${h} done (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
  }

  // ---- assemble ----
  const names = (id) => capacities[id]?.name ?? id
  const out = { ...win, trainSnapshots: trainLines.length, testSnapshots: testLines.length, trainLast: trainLines.at(-1)?.t, trainDays: +daysOfTrain.toFixed(1), configs: {} }
  const baseRes = {}
  for (const h of HORIZONS_H) baseRes[h] = acc.get(`baseline|${h}`).out()
  for (const cfg of configs) {
    const horizons = {}
    for (const h of HORIZONS_H) {
      const r = acc.get(`${cfg.name}|${h}`).out()
      const b = baseRes[h]
      horizons[`${h}h`] = {
        n: r.n,
        baselineMae: b.mae,
        variantMae: r.mae,
        deltaMae: +(r.mae - b.mae).toFixed(3),
        persistenceMae: r.persistMae,
        variantBias: r.bias,
        baselineBias: b.bias,
        variantRmse: r.rmse,
        baselineRmse: b.rmse,
        profileOnlyMae: r.profileOnlyMae,
        baselineProfileOnlyMae: b.profileOnlyMae,
        profileOnlyBias: r.profileOnlyBias,
        baselineProfileOnlyBias: b.profileOnlyBias,
      }
    }
    // per-station at 6 h: where did the variant move the bias?
    const stations6h = []
    for (const id of stationIds) {
      const a = stAcc.get(`${cfg.name}|6|${id}`)
      const b = stAcc.get(`baseline|6|${id}`)
      if (!a || !b) continue
      const ao = a.out()
      const bo = b.out()
      stations6h.push({ id, name: names(id), cap: capacities[id].capacity, n: ao.n, mae: ao.mae, bias: ao.bias, baselineMae: bo.mae, baselineBias: bo.bias })
    }
    stations6h.sort((x, y) => Math.abs(y.baselineBias) - Math.abs(x.baselineBias))
    out.configs[cfg.name] = { family: cfg.family, check: !!cfg.check, note: cfg.note, horizons, stations6h: stations6h.slice(0, 15) }
  }
  console.error(`window done in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  return out
}

async function main() {
  const t0 = Date.now()
  const capacities = await loadCapacities()
  const events = await loadEventCalendar()
  const lines = await loadSnapshotLines()
  for (const l of lines) l.ms = Date.parse(l.t)
  const stationIds = Object.keys(capacities).filter((id) => capacities[id]?.capacity > 0)
  console.error(`loaded ${lines.length} snapshots (${lines[0]?.t} → ${lines.at(-1)?.t}), ${stationIds.length} stations, ${events.length} events in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  const pre = precompute(lines, stationIds, capacities)
  console.error(`precomputed in ${((Date.now() - t0) / 1000).toFixed(1)} s`)

  const report = { experiment: 'recency', generatedAt: new Date().toISOString(), snapshots: lines.length, windows: [] }
  for (const win of WINDOWS) report.windows.push(evaluateWindow(win, lines, pre, capacities, stationIds, events))

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(report, null, 1))

  // ---- console summary ----
  const f = (v, w = 7) => String(v ?? '—').padEnd(w)
  const sg = (v) => (v > 0 ? '+' : '') + v
  for (const w of report.windows) {
    console.log(`\n== ${w.name}  (test ${w.testSnapshots} snapshots, trained on ${w.trainSnapshots} = ${w.trainDays} d, last ${w.trainLast})`)
    console.log('config                          h    n      base    variant Δ        persist bias(v) bias(b) profMAE(v/b)   profBias(v/b)')
    for (const [name, c] of Object.entries(w.configs)) {
      for (const [h, r] of Object.entries(c.horizons)) {
        console.log(
          `${(h === '1h' ? name : '').padEnd(31)} ${f(h, 4)} ${f(r.n, 6)} ${f(r.baselineMae)} ${f(r.variantMae)} ${f(sg(r.deltaMae), 8)} ${f(r.persistenceMae)} ${f(sg(r.variantBias))} ${f(sg(r.baselineBias))} ${f(`${r.profileOnlyMae}/${r.baselineProfileOnlyMae}`, 14)} ${sg(r.profileOnlyBias)}/${sg(r.baselineProfileOnlyBias)}`
        )
      }
      if (c.note) console.log(`   ↳ ${c.note}`)
    }
  }
  console.log(`\n→ ${OUT}`)
  const checks = []
  for (const w of report.windows)
    for (const [name, c] of Object.entries(w.configs))
      if (c.check)
        for (const [h, r] of Object.entries(c.horizons)) if (r.variantMae !== r.baselineMae || r.variantBias !== r.baselineBias) checks.push(`${w.name} ${name} ${h}: variant ${r.variantMae}/${r.variantBias} vs baseline ${r.baselineMae}/${r.baselineBias}`)
  console.log(checks.length ? `CHECKS FAILED:\n  ${checks.join('\n  ')}` : 'checks passed: re-implemented means and predictVariant reproduce baseline exactly')
  console.log(`total ${((Date.now() - t0) / 1000).toFixed(0)} s`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
