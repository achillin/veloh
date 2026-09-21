#!/usr/bin/env node
// Experiment "decay-calibrated" — is the live-vs-profile blend weight
// miscalibrated?
//
// Hypothesis: the lag-1h anomaly survival rate rho (profiles.decay) is
// dragged down by rebalancing jumps, so predict()'s path-product pulls too
// hard toward the profile at short horizons (1 h model 1.006 vs persistence
// 0.963, night hours worst) and has vanished by 24 h although ~45 % live
// weight would still help there.
//
// Configs (same honest harness as model/analyze.mjs: profiles trained
// strictly before the window, live state from T−h only):
//   baseline              unmodified predict()
//   profile-only          w ≡ 0 (reference; must equal baseline at 24 h)
//   decay-excl4 / -excl3  (a) profiles.decay recomputed like train.mjs but
//                         skipping lag-1h pairs with |Δbikes| ≥ 4 (resp. ≥ 3)
//                         instead of ≥ 8; standard predict() on top
//   calib-global          (b) w(h) fitted on the training window by MAE over
//                         a 60-min origin subsample, knots
//                         h ∈ {1,2,3,4,6,9,12,18,24}, linear in between
//   calib-bucket[-K300]   (c) w(h, dayType-hour of the forecast origin),
//                         each bucket's loss curve shrunk toward the global
//                         curve with K pseudo-samples (default 1000)
//   *-heldout             same fits, but on the last HOLDOUT_DAYS of the
//                         training window using profiles built before those
//                         days — removes the in-sample profile advantage
//                         that biases w(live) low in the plain fits
//
// Usage: node model/experiments/decay-calibrated.mjs
// Writes model/experiments/out/decay-calibrated.json

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSnapshotLines, loadCapacities, buildProfiles, loadEventCalendar, bucketKey } from '../train.mjs'
import { predict } from '../../src/lib/predictor.js'
import { dayType } from '../../src/lib/holidays.js'
import { activeEventsAt, eventsNear } from '../../src/lib/events.js'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out')
const OUT = join(OUT_DIR, 'decay-calibrated.json')

const HORIZONS_H = [1, 3, 6, 24]
const FIT_H = [1, 2, 3, 4, 6, 9, 12, 18, 24]
const LOOKUP_TOL_MS = 7.5 * 60_000
const FIT_STEP_MS = 60 * 60_000
const W_STEPS = 21 // w grid 0, 0.05, …, 1
const JUMP = 4 // |Δbikes| over the horizon at/above this ≈ rebalancing
const SHRINK_K = 8 // as predictor.js
const EVENT_DELTA_CAP = 0.35 // as predictor.js
const EVENT_MIN_N = 300 // as predictor.js
const HOLDOUT_DAYS = 14
const BUCKET_K = 1000
const BUCKET_K_ALT = 300
const DECAY_THRESHOLDS = [8, 4, 3] // 8 = train.mjs as-is (verification)
const NIGHT_HOURS = new Set([0, 1, 2, 3, 4, 5, 6])

const WINDOWS = [
  { name: 'day 2026-09-17 @15min', from: '2026-09-17', to: '2026-09-17', stepMin: 15 },
  { name: 'week 2026-09-11..17 @30min', from: '2026-09-11', to: '2026-09-17', stepMin: 30 },
]

// ---- time helpers (copied from analyze.mjs) ----
const luxFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Luxembourg',
  hour: '2-digit',
  hour12: false,
  minute: '2-digit',
})
const luxParts = (d) => Object.fromEntries(luxFmt.formatToParts(d).map((p) => [p.type, Number(p.value)]))
function luxMidnightMs(day) {
  const guess = Date.parse(`${day}T00:00:00Z`)
  for (const off of [2, 1, 0]) {
    const t = guess - off * 3600_000
    const p = luxParts(new Date(t))
    if (p.hour % 24 === 0 && p.minute === 0) return t
  }
  return guess
}

// ---- sorted snapshot index ----
function indexLines(lines) {
  return { lines, ts: Float64Array.from(lines, (l) => Date.parse(l.t)) }
}
function nearest(idx, timeMs, tolMs = LOOKUP_TOL_MS) {
  const { lines, ts } = idx
  if (!ts.length) return null
  let lo = 0
  let hi = ts.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ts[mid] < timeMs) lo = mid + 1
    else hi = mid
  }
  let best = null
  let bestD = Infinity
  for (const i of [lo - 1, lo, lo + 1]) {
    if (i < 0 || i >= ts.length) continue
    const d = Math.abs(ts[i] - timeMs)
    if (d < bestD) {
      bestD = d
      best = lines[i]
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

// ---- profile lookups re-implemented exactly as predictor.js ----
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

function eventAdjustment(profiles, station, active) {
  if (!active?.length) return 0
  const near = eventsNear(active, station)
  let delta = 0
  for (const ev of near) {
    const eff = profiles?.eventEffects?.[ev.venue]
    if (eff && eff[1] >= EVENT_MIN_N) delta += eff[0]
  }
  return Math.max(-EVENT_DELTA_CAP, Math.min(EVENT_DELTA_CAP, delta))
}

/** predict()'s `base` (profile + event shift, clamped), no rain (the harness
 *  passes no forecast, exactly like analyze.mjs). */
function baseFraction(profiles, station, key, active, fallback) {
  const learned = learnedFraction(profiles, station.id, key)
  const base = learned ? learned.frac : fallback
  if (base == null) return null
  return Math.min(Math.max(base + eventAdjustment(profiles, station, active), 0), 1)
}

/** Blend with an externally supplied weight function wOf(dtH, originDate). */
function predictVariant(station, target, ctx, wOf) {
  const { now, profiles, globalLiveMean, active } = ctx
  const cap = Math.max(station.capacity, 1)
  const liveFrac = Math.min(station.bikes / cap, 1)
  const dtH = (target.getTime() - now.getTime()) / 3.6e6
  if (dtH <= 0.01) return { frac: liveFrac, bikes: station.bikes }
  const base = baseFraction(profiles, station, profileKey(target), active, globalLiveMean)
  const w = wOf(dtH, now)
  const frac = w * liveFrac + (1 - w) * base
  return { frac, bikes: Math.round(frac * cap) }
}

// ---- (a) decay recomputation, train.mjs lines 178-224 + 358-369 with a
//      configurable jump threshold; all thresholds in one pass ----
function recomputeDecays(lines, capacities, thresholds) {
  // full-precision bucket means, as in train.mjs's first pass
  const stations = new Map()
  const global = new Map()
  for (const line of lines) {
    const key = bucketKey(line.t)
    for (const [id, [bikes]] of Object.entries(line.s)) {
      const cap = capacities[id]?.capacity
      if (!cap) continue
      const frac = Math.min(bikes / cap, 1)
      let byKey = stations.get(id)
      if (!byKey) stations.set(id, (byKey = new Map()))
      let a = byKey.get(key)
      if (!a) byKey.set(key, (a = { sum: 0, n: 0 }))
      a.sum += frac
      a.n++
      let g = global.get(key)
      if (!g) global.set(key, (g = { sum: 0, n: 0 }))
      g.sum += frac
      g.n++
    }
  }
  const meanFor = (id, key) => {
    const s = stations.get(id)?.get(key)
    if (s?.n) return s.sum / s.n
    const g = global.get(key)
    return g?.n ? g.sum / g.n : null
  }
  const byMinute = new Map(lines.map((l) => [l.t.slice(0, 16), l]))
  const lineAt = (ms) => {
    for (const off of [0, 1, -1, 2, -2]) {
      const c = byMinute.get(new Date(ms + off * 60_000).toISOString().slice(0, 16))
      if (c) return c
    }
    return null
  }
  const per = new Map(thresholds.map((th) => [th, { byKey: new Map(), num: 0, den: 0, n: 0, skipped: 0 }]))
  for (const line of lines) {
    const next = lineAt(Date.parse(line.t) + 3600_000)
    if (!next) continue
    const key0 = bucketKey(line.t)
    const key1 = bucketKey(next.t)
    for (const [id, [b0]] of Object.entries(line.s)) {
      const cap = capacities[id]?.capacity
      const rec = next.s[id]
      if (!cap || !rec) continue
      const jump = Math.abs(rec[0] - b0)
      const m0 = meanFor(id, key0)
      const m1 = meanFor(id, key1)
      if (m0 == null || m1 == null) continue
      const a0 = Math.min(b0 / cap, 1) - m0
      const a1 = Math.min(rec[0] / cap, 1) - m1
      for (const th of thresholds) {
        const p = per.get(th)
        if (jump >= th) {
          p.skipped++
          continue
        }
        let acc = p.byKey.get(key0)
        if (!acc) p.byKey.set(key0, (acc = { num: 0, den: 0, n: 0 }))
        acc.num += a0 * a1
        acc.den += a0 * a0
        acc.n++
        p.num += a0 * a1
        p.den += a0 * a0
        p.n++
      }
    }
  }
  const clampRho = (r) => +Math.min(Math.max(r, 0.01), 0.995).toFixed(4)
  const out = {}
  for (const th of thresholds) {
    const p = per.get(th)
    out[th] = {
      decay:
        p.den > 0 && p.n >= 500
          ? {
              global: [clampRho(p.num / p.den), p.n],
              byKey: Object.fromEntries(
                [...p.byKey].filter(([, a]) => a.den > 0 && a.n >= 50).map(([k, a]) => [k, [clampRho(a.num / a.den), a.n]])
              ),
            }
          : null,
      pairsUsed: p.n,
      pairsSkipped: p.skipped,
    }
  }
  return out
}

// ---- (b)/(c) blend-weight fit ----
function fitWeights(fitIdx, profiles, capacities, stationObjs, events, label) {
  const gAbs = new Map(FIT_H.map((h) => [h, new Float64Array(W_STEPS)]))
  const gN = new Map(FIT_H.map((h) => [h, 0]))
  const bAbs = new Map() // `${h}|${originKey}` → Float64Array(W_STEPS)
  const bN = new Map()
  const { ts } = fitIdx
  const t0 = Math.ceil(ts[0] / FIT_STEP_MS) * FIT_STEP_MS
  const tEnd = ts[ts.length - 1]
  let origins = 0
  for (let t = t0; t <= tEnd; t += FIT_STEP_MS) {
    const origin = nearest(fitIdx, t)
    if (!origin) continue
    origins++
    const originMs = Date.parse(origin.t)
    const oKey = profileKey(new Date(originMs))
    const globalLiveMean = liveGlobalMean(origin, capacities)
    for (const h of FIT_H) {
      const target = nearest(fitIdx, originMs + h * 3.6e6)
      if (!target) continue
      const targetDate = new Date(Date.parse(target.t))
      const tKey = profileKey(targetDate)
      const active = events.length ? activeEventsAt(events, targetDate) : []
      const ga = gAbs.get(h)
      const bk = `${h}|${oKey}`
      let ba = bAbs.get(bk)
      if (!ba) {
        bAbs.set(bk, (ba = new Float64Array(W_STEPS)))
        bN.set(bk, 0)
      }
      let cnt = 0
      for (const [id, [actual]] of Object.entries(target.s)) {
        const st = stationObjs[id]
        const rec = origin.s[id]
        if (!st || !rec) continue
        const cap = st.capacity
        const liveFrac = Math.min(rec[0] / cap, 1)
        const base = baseFraction(profiles, st, tKey, active, globalLiveMean)
        if (base == null) continue
        for (let i = 0; i < W_STEPS; i++) {
          const w = i / (W_STEPS - 1)
          const e = Math.abs(Math.round((w * liveFrac + (1 - w) * base) * cap) - actual)
          ga[i] += e
          ba[i] += e
        }
        cnt++
      }
      gN.set(h, gN.get(h) + cnt)
      bN.set(bk, bN.get(bk) + cnt)
    }
  }
  const argmin = (arr) => {
    let bi = 0
    for (let i = 1; i < arr.length; i++) if (arr[i] < arr[bi]) bi = i
    return bi
  }
  const global = {}
  const globalCurves = {}
  for (const h of FIT_H) {
    const a = gAbs.get(h)
    const n = gN.get(h) || 1
    global[h] = argmin(a) / (W_STEPS - 1)
    globalCurves[h] = [...a].map((v) => +(v / n).toFixed(3))
  }
  const bucketTable = (K) => {
    const bucket = {}
    for (const [bk, ba] of bAbs) {
      const [hs, key] = bk.split('|')
      const h = Number(hs)
      const ga = gAbs.get(h)
      const gn = gN.get(h) || 1
      const shr = new Float64Array(W_STEPS)
      for (let i = 0; i < W_STEPS; i++) shr[i] = ba[i] + (K * ga[i]) / gn
      ;(bucket[key] ??= {})[h] = argmin(shr) / (W_STEPS - 1)
    }
    for (const tbl of Object.values(bucket)) for (const h of FIT_H) if (tbl[h] == null) tbl[h] = global[h]
    return bucket
  }
  const bucketN = {}
  for (const [bk, n] of bN) {
    const [hs, key] = bk.split('|')
    ;(bucketN[key] ??= {})[hs] = n
  }
  return { label, origins, n: Object.fromEntries(gN), global, globalCurves, bucketTable, bucketN }
}

/** Linear interpolation of a {h: w} table on FIT_H knots, with an implicit
 *  (0, 1) knot; held constant beyond the last knot. */
function interpW(table, dtH) {
  if (dtH <= 0) return 1
  let h0 = 0
  let w0 = 1
  for (const h of FIT_H) {
    const w1 = table[h]
    if (dtH <= h) return w0 + ((w1 - w0) * (dtH - h0)) / (h - h0)
    h0 = h
    w0 = w1
  }
  return w0
}

// ---- evaluation ----
class Acc {
  constructor() {
    this.n = 0
    this.abs = 0
    this.bias = 0
    this.w1 = 0
    this.calmAbs = 0
    this.calmN = 0
    this.jumpAbs = 0
    this.jumpN = 0
    this.nightAbs = 0
    this.nightN = 0
    this.dayAbs = 0
    this.dayN = 0
    this.hourAbs = new Float64Array(24)
    this.hourN = new Int32Array(24)
  }
  add(err, jump, hour) {
    const a = Math.abs(err)
    this.n++
    this.abs += a
    this.bias += err
    if (a <= 1) this.w1++
    if (jump) {
      this.jumpAbs += a
      this.jumpN++
    } else {
      this.calmAbs += a
      this.calmN++
    }
    if (NIGHT_HOURS.has(hour)) {
      this.nightAbs += a
      this.nightN++
    } else {
      this.dayAbs += a
      this.dayN++
    }
    this.hourAbs[hour] += a
    this.hourN[hour]++
  }
  out() {
    const r = (s, n, d = 3) => (n ? +(s / n).toFixed(d) : null)
    return {
      n: this.n,
      mae: r(this.abs, this.n),
      bias: r(this.bias, this.n),
      within1: r(this.w1, this.n),
      calmMae: r(this.calmAbs, this.calmN),
      jumpMae: r(this.jumpAbs, this.jumpN),
      jumpShare: r(this.jumpN, this.n),
      nightMae: r(this.nightAbs, this.nightN),
      dayMae: r(this.dayAbs, this.dayN),
      byHour: [...this.hourAbs].map((s, i) => r(s, this.hourN[i])),
    }
  }
}

function evaluateWindow(win, allIdx, capacities, stationObjs, events, configs) {
  const startMs = luxMidnightMs(win.from)
  const endMs = luxMidnightMs(win.to) + 24 * 3600_000
  const stepMs = win.stepMin * 60_000
  const testIdx = indexLines(allIdx.lines.filter((l) => Date.parse(l.t) >= startMs && Date.parse(l.t) < endMs))
  const acc = new Map() // `${config}|${h}` → Acc
  const get = (k) => acc.get(k) ?? (acc.set(k, new Acc()), acc.get(k))
  for (const h of HORIZONS_H) {
    const hMs = h * 3600_000
    for (let t = startMs; t < endMs; t += stepMs) {
      const actualLine = nearest(testIdx, t)
      const baseLine = nearest(allIdx, t - hMs)
      if (!actualLine || !baseLine) continue
      const targetDate = new Date(Date.parse(actualLine.t))
      const baseDate = new Date(Date.parse(baseLine.t))
      const hour = luxParts(targetDate).hour % 24
      const globalLiveMean = liveGlobalMean(baseLine, capacities)
      const active = events.length ? activeEventsAt(events, targetDate) : []
      const ctx = { now: baseDate, globalLiveMean, events, active }
      for (const [id, [actual]] of Object.entries(actualLine.s)) {
        const st0 = stationObjs[id]
        const base = baseLine.s[id]
        if (!st0 || !base) continue
        const st = { ...st0, bikes: base[0] }
        const jump = Math.abs(actual - base[0]) >= JUMP
        get(`persistence|${h}`).add(base[0] - actual, jump, hour)
        for (const c of configs) get(`${c.name}|${h}`).add(c.fn(st, targetDate, ctx) - actual, jump, hour)
      }
    }
  }
  const results = {}
  for (const c of [{ name: 'persistence' }, ...configs]) {
    results[c.name] = {}
    for (const h of HORIZONS_H) results[c.name][`${h}h`] = get(`${c.name}|${h}`).out()
  }
  return { testSnapshots: testIdx.lines.length, results }
}

const meanRho = (decay, keys) => {
  const v = keys.map((k) => decay?.byKey?.[k]?.[0]).filter((x) => x != null)
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) : null
}

async function main() {
  const T0 = Date.now()
  const capacities = await loadCapacities()
  const events = await loadEventCalendar()
  const lines = await loadSnapshotLines()
  const allIdx = indexLines(lines)
  console.error(`loaded ${lines.length} snapshots (${lines[0]?.t} → ${lines.at(-1)?.t}) in ${((Date.now() - T0) / 1000).toFixed(1)} s`)
  const stationObjs = Object.fromEntries(
    Object.entries(capacities)
      .filter(([, c]) => c?.capacity)
      .map(([id, c]) => [id, { id, capacity: c.capacity, lat: c.lat, lon: c.lon }])
  )

  const report = {
    generatedAt: new Date().toISOString(),
    params: { HORIZONS_H, FIT_H, W_STEPS, JUMP, SHRINK_K, HOLDOUT_DAYS, BUCKET_K, BUCKET_K_ALT, DECAY_THRESHOLDS, fitStepMin: FIT_STEP_MS / 60_000 },
    snapshots: lines.length,
    windows: [],
  }

  for (const win of WINDOWS) {
    const tw = Date.now()
    const startMs = luxMidnightMs(win.from)
    const trainLines = lines.filter((l) => Date.parse(l.t) < startMs)
    const trainIdx = indexLines(trainLines)
    console.error(`\n== ${win.name}: training on ${trainLines.length} snapshots (last ${trainLines.at(-1)?.t})`)
    const profiles = buildProfiles(trainLines, capacities, events)
    console.error(`   profiles built (${((Date.now() - tw) / 1000).toFixed(1)} s); baseline rho global ${profiles.decay?.global?.[0]}`)

    // (a) decay variants
    const decays = recomputeDecays(trainLines, capacities, DECAY_THRESHOLDS)
    let verifyMaxDiff = Math.abs((decays[8].decay?.global?.[0] ?? NaN) - (profiles.decay?.global?.[0] ?? NaN))
    for (const [k, [rho]] of Object.entries(profiles.decay?.byKey ?? {})) {
      const r = decays[8].decay?.byKey?.[k]?.[0]
      if (r == null) verifyMaxDiff = Infinity
      else verifyMaxDiff = Math.max(verifyMaxDiff, Math.abs(r - rho))
    }
    const nightKeys = [...NIGHT_HOURS].map((h) => `wd-${h}`)
    const dayKeys = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].map((h) => `wd-${h}`)
    const decayStats = {
      verifyMaxDiffVsTrain: +verifyMaxDiff.toFixed(5),
      baselineGlobal: profiles.decay?.global,
      byThreshold: Object.fromEntries(
        DECAY_THRESHOLDS.map((th) => [
          `excl${th}`,
          {
            global: decays[th].decay?.global,
            pairsUsed: decays[th].pairsUsed,
            pairsSkipped: decays[th].pairsSkipped,
            wdNightMeanRho: meanRho(decays[th].decay, nightKeys),
            wdDayMeanRho: meanRho(decays[th].decay, dayKeys),
          },
        ])
      ),
      byKey: Object.fromEntries(
        Object.keys(decays[8].decay?.byKey ?? {})
          .sort()
          .map((k) => [k, Object.fromEntries(DECAY_THRESHOLDS.map((th) => [`excl${th}`, decays[th].decay?.byKey?.[k]?.[0] ?? null]))])
      ),
    }
    console.error(
      `   decay recompute: verify max|Δrho| vs train.mjs = ${decayStats.verifyMaxDiffVsTrain}; global rho excl8 ${decays[8].decay?.global?.[0]} excl4 ${decays[4].decay?.global?.[0]} excl3 ${decays[3].decay?.global?.[0]} (${((Date.now() - tw) / 1000).toFixed(1)} s)`
    )

    // (b)/(c) fits: in-sample on the whole training window …
    const fitIn = fitWeights(trainIdx, profiles, capacities, stationObjs, events, 'in-sample')
    console.error(`   in-sample fit: ${fitIn.origins} origins; w(h) = ${JSON.stringify(fitIn.global)} (${((Date.now() - tw) / 1000).toFixed(1)} s)`)
    // … and held-out: profiles from before the last HOLDOUT_DAYS, fit on those days
    const cutMs = startMs - HOLDOUT_DAYS * 86400_000
    const earlyLines = trainLines.filter((l) => Date.parse(l.t) < cutMs)
    const lateIdx = indexLines(trainLines.filter((l) => Date.parse(l.t) >= cutMs))
    const profilesEarly = buildProfiles(earlyLines, capacities, events)
    const fitHold = fitWeights(lateIdx, profilesEarly, capacities, stationObjs, events, 'held-out')
    console.error(`   held-out fit (profiles < ${new Date(cutMs).toISOString()}, ${earlyLines.length} snaps; fit on ${lateIdx.lines.length}): ${fitHold.origins} origins; w(h) = ${JSON.stringify(fitHold.global)} (${((Date.now() - tw) / 1000).toFixed(1)} s)`)

    const bucketIn = fitIn.bucketTable(BUCKET_K)
    const bucketInAlt = fitIn.bucketTable(BUCKET_K_ALT)
    const bucketHold = fitHold.bucketTable(BUCKET_K)

    const std = (prof) => (st, target, ctx) =>
      predict(st, target, { now: ctx.now, profiles: prof, globalLiveMean: ctx.globalLiveMean, events, activeEvents: ctx.active }).bikes
    const variant = (wOf) => (st, target, ctx) => predictVariant(st, target, { ...ctx, profiles }, wOf).bikes
    const wGlobal = (fit) => (dtH) => interpW(fit.global, dtH)
    const wBucket = (fit, table) => (dtH, now) => interpW(table[profileKey(now)] ?? fit.global, dtH)
    const configs = [
      { name: 'baseline', fn: std(profiles) },
      { name: 'profile-only', fn: variant(() => 0) },
      { name: 'decay-excl4', fn: std({ ...profiles, decay: decays[4].decay }) },
      { name: 'decay-excl3', fn: std({ ...profiles, decay: decays[3].decay }) },
      { name: 'calib-global', fn: variant(wGlobal(fitIn)) },
      { name: 'calib-global-heldout', fn: variant(wGlobal(fitHold)) },
      { name: 'calib-bucket', fn: variant(wBucket(fitIn, bucketIn)) },
      { name: 'calib-bucket-K300', fn: variant(wBucket(fitIn, bucketInAlt)) },
      { name: 'calib-bucket-heldout', fn: variant(wBucket(fitHold, bucketHold)) },
    ]
    const ev = evaluateWindow(win, allIdx, capacities, stationObjs, events, configs)
    console.error(`   evaluated ${ev.testSnapshots} test snapshots (${((Date.now() - tw) / 1000).toFixed(1)} s)`)

    // summarise the bucket tables: night vs day mean w per h
    const bucketSummary = (table) => {
      const o = {}
      for (const [lab, keys] of [['wdNight', nightKeys], ['wdDay', dayKeys]]) {
        o[lab] = {}
        for (const h of FIT_H) {
          const v = keys.map((k) => table[k]?.[h]).filter((x) => x != null)
          o[lab][h] = v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null
        }
      }
      return o
    }
    report.windows.push({
      ...win,
      trainSnapshots: trainLines.length,
      trainLast: trainLines.at(-1)?.t,
      testSnapshots: ev.testSnapshots,
      decay: decayStats,
      fits: {
        inSample: { origins: fitIn.origins, n: fitIn.n, global: fitIn.global, globalCurves: fitIn.globalCurves, bucketSummaryK1000: bucketSummary(bucketIn), bucketSummaryK300: bucketSummary(bucketInAlt), bucket: bucketIn },
        heldOut: { profilesBefore: new Date(cutMs).toISOString(), earlySnapshots: earlyLines.length, fitSnapshots: lateIdx.lines.length, origins: fitHold.origins, n: fitHold.n, global: fitHold.global, globalCurves: fitHold.globalCurves, bucketSummaryK1000: bucketSummary(bucketHold), bucket: bucketHold },
      },
      results: ev.results,
      elapsedS: +((Date.now() - tw) / 1000).toFixed(1),
    })
  }
  report.elapsedS = +((Date.now() - T0) / 1000).toFixed(1)
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT, JSON.stringify(report, null, 1))

  // ---- console summary ----
  const f = (v, w = 7) => String(v == null ? '—' : v).padEnd(w)
  for (const w of report.windows) {
    console.log(`\n== ${w.name}  (test ${w.testSnapshots} snaps, train ${w.trainSnapshots})`)
    console.log(`   rho global: excl8 ${w.decay.byThreshold.excl8.global?.[0]}  excl4 ${w.decay.byThreshold.excl4.global?.[0]}  excl3 ${w.decay.byThreshold.excl3.global?.[0]};  wd-night mean rho ${w.decay.byThreshold.excl8.wdNightMeanRho}/${w.decay.byThreshold.excl4.wdNightMeanRho}/${w.decay.byThreshold.excl3.wdNightMeanRho}, wd-day ${w.decay.byThreshold.excl8.wdDayMeanRho}/${w.decay.byThreshold.excl4.wdDayMeanRho}/${w.decay.byThreshold.excl3.wdDayMeanRho}`)
    console.log(`   w(h) in-sample: ${FIT_H.map((h) => `${h}h ${w.fits.inSample.global[h]}`).join(' ')}`)
    console.log(`   w(h) held-out : ${FIT_H.map((h) => `${h}h ${w.fits.heldOut.global[h]}`).join(' ')}`)
    console.log(`   bucket w in-sample K1000 night/day: ${FIT_H.map((h) => `${h}h ${w.fits.inSample.bucketSummaryK1000.wdNight[h]}/${w.fits.inSample.bucketSummaryK1000.wdDay[h]}`).join(' ')}`)
    console.log(`   ${f('config', 22)} ${f('h', 4)} ${f('n')} ${f('MAE')} ${f('persist')} ${f('bias')} ${f('±1')} ${f('calm')} ${f('jump')} ${f('night')} ${f('day')}`)
    for (const h of HORIZONS_H) {
      const p = w.results.persistence[`${h}h`]
      for (const [name, r] of Object.entries(w.results)) {
        if (name === 'persistence') continue
        const x = r[`${h}h`]
        console.log(`   ${f(name, 22)} ${f(h + 'h', 4)} ${f(x.n)} ${f(x.mae)} ${f(p.mae)} ${f(x.bias)} ${f(x.within1)} ${f(x.calmMae)} ${f(x.jumpMae)} ${f(x.nightMae)} ${f(x.dayMae)}`)
      }
    }
  }
  console.log(`\n→ ${OUT}  (${report.elapsedS} s total)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
