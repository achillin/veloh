#!/usr/bin/env node
// Experiment "median-point": use the birth–death distribution
// (predictDistribution) as the POINT forecast instead of the linear
// live/profile blend in predict().
//
// Hypothesis: MAE is minimised by the median of the predictive distribution,
// and the λ/μ birth–death model with reflecting walls at 0 and capacity
// already encodes saturation that the linear blend ignores, so its median
// (or mean) may beat the blend — especially near empty/full.
//
// Configs (all evaluated per horizon 1/3/6/24 h):
//   baseline          unmodified predict()
//   a_median_h6       distribution median for h ≤ 6, predict() beyond
//   b_mean_h6         distribution mean (rounded) for h ≤ 6, predict() beyond
//   c_hybrid_median   round((blend·cap + median) / 2), all horizons
//   c_hybrid_w0_25    round(0.25·blend·cap + 0.75·median)  (weight scan, bonus)
//   c_hybrid_w0_75    round(0.75·blend·cap + 0.25·median)  (weight scan, bonus)
//   d_median_all      distribution median at every horizon incl. 24 h
//   d2_mean_all       distribution mean at every horizon (bonus)
//   e_median_scaled   median of the μ×1.15 / λ×0.85 distribution (bonus, ties
//                     to the calibration variant below)
//   f_hybrid_mean     round((blend·cap + mean) / 2), all horizons (bonus)
//
// Calibration of P(≥1) at 1 h / 6 h: Brier + 10-bin reliability for the
// unmodified flows and for scaled flows (μ×1.15, λ×0.85 as requested, plus
// two extra scalings to show the direction of the effect).
//
// Honest evaluation, same protocol as model/analyze.mjs: profiles are built
// only from snapshots strictly before the window; the model sees only the
// live snapshot at T−h. Two windows: day 2026-09-17 @15 min, week
// 2026-09-11..17 @30 min (trained on data before 2026-09-11). Snapshot lines
// are loaded once and reused for both windows and every config.
//
// Usage: node model/experiments/median-point.mjs [--quick]   (--quick: day window only)
// Output: model/experiments/out/median-point.json

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSnapshotLines, loadCapacities, buildProfiles, loadEventCalendar } from '../train.mjs'
import { predict, predictDistribution, probAtLeast } from '../../src/lib/predictor.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out', 'median-point.json')
const HORIZONS_H = [1, 3, 6, 12, 24] // 12 h is extra: locates the crossover between the ≤6 h gain and the 24 h loss
const LOOKUP_TOL_MS = 7.5 * 60_000
const JUMP = 4
const QUICK = process.argv.includes('--quick')

const WINDOWS = [
  { name: 'day-2026-09-17', from: '2026-09-17', to: '2026-09-17', stepMin: 15 },
  { name: 'week-2026-09-11..17', from: '2026-09-11', to: '2026-09-17', stepMin: 30 },
]

// λ/μ scalings for the calibration check: [lamFactor, muFactor]
const FLOW_SCALINGS = {
  unmodified: [1, 1],
  'lam0.85_mu1.15': [0.85, 1.15],
  'lam0.7_mu1.3': [0.7, 1.3],
  'lam1.0_mu1.15': [1, 1.15],
}
const POINT_SCALED = 'lam0.85_mu1.15' // which scaled distribution feeds config e

// ---------------------------------------------------------------- helpers
const luxParts = (d) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Luxembourg', hour: '2-digit', hour12: false, minute: '2-digit' })
      .formatToParts(d)
      .map((p) => [p.type, Number(p.value)])
  )
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
    if (Date.parse(sorted[mid].t) < timeMs) lo = mid + 1
    else hi = mid
  }
  let best = null
  let bestD = Infinity
  for (const i of [lo - 1, lo, lo + 1]) {
    const line = sorted[i]
    if (!line) continue
    const d = Math.abs(Date.parse(line.t) - timeMs)
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

/** Copy of profiles with every λ/μ (global and per station) scaled. */
function scaleFlows(profiles, lamF, muF) {
  const f = profiles.flows
  if (!f) return profiles
  const sc = (o) => Object.fromEntries(Object.entries(o).map(([k, [l, m, n]]) => [k, [l * lamF, m * muF, n]]))
  return {
    ...profiles,
    flows: {
      global: sc(f.global),
      stations: Object.fromEntries(Object.entries(f.stations ?? {}).map(([id, o]) => [id, sc(o)])),
    },
  }
}

/** median (smallest i with CDF ≥ 0.5) and mean of a probability vector */
function distStats(p) {
  let cum = 0
  let median = -1
  let mean = 0
  for (let i = 0; i < p.length; i++) {
    mean += i * p[i]
    if (median < 0) {
      cum += p[i]
      if (cum >= 0.5) median = i
    }
  }
  if (median < 0) median = p.length - 1
  return { median, mean }
}

class Acc {
  constructor() {
    this.n = 0
    this.abs = 0
    this.bias = 0
    this.absB = 0
    this.biasB = 0
    this.absP = 0
  }
  add(err, errBase, errP) {
    this.n++
    this.abs += Math.abs(err)
    this.bias += err
    this.absB += Math.abs(errBase)
    this.biasB += errBase
    this.absP += Math.abs(errP)
  }
  out() {
    const n = this.n || 1
    return {
      n: this.n,
      baselineMae: +(this.absB / n).toFixed(3),
      variantMae: +(this.abs / n).toFixed(3),
      persistenceMae: +(this.absP / n).toFixed(3),
      variantBias: +(this.bias / n).toFixed(3),
      baselineBias: +(this.biasB / n).toFixed(3),
    }
  }
}
const acc = (map, key) => map.get(key) ?? (map.set(key, new Acc()), map.get(key))

class Reliab {
  constructor() {
    this.bins = Array.from({ length: 10 }, () => ({ sumP: 0, sumY: 0, n: 0 }))
    this.brier = 0
    this.n = 0
    this.y = 0
    this.sumP = 0
  }
  add(p1, y) {
    const b = this.bins[Math.min(9, Math.floor(p1 * 10))]
    b.sumP += p1
    b.sumY += y
    b.n++
    this.brier += (p1 - y) ** 2
    this.y += y
    this.sumP += p1
    this.n++
  }
  out() {
    const n = this.n || 1
    const base = this.y / n
    return {
      n: this.n,
      brier: +(this.brier / n).toFixed(4),
      brierBaseRate: +(base * (1 - base)).toFixed(4),
      meanPredicted: +(this.sumP / n).toFixed(3),
      observedRate: +base.toFixed(3),
      reliability: this.bins.map((b, i) => ({
        bin: `${i * 10}-${i * 10 + 10}%`,
        n: b.n,
        predicted: b.n ? +(b.sumP / b.n).toFixed(3) : null,
        observed: b.n ? +(b.sumY / b.n).toFixed(3) : null,
      })),
    }
  }
}

// point-forecast configs: ctx = {h, blend (predict() result), cap, live, med, mean, medS}
const CONFIGS = {
  baseline: (c) => c.blend.bikes,
  a_median_h6: (c) => (c.h <= 6 ? c.med : c.blend.bikes),
  b_mean_h6: (c) => (c.h <= 6 ? Math.round(c.mean) : c.blend.bikes),
  c_hybrid_median: (c) => Math.round((c.blend.frac * c.cap + c.med) / 2),
  // weight scan for the hybrid (share of the blend): 0.25 / 0.75 around the 0.5 of config c
  c_hybrid_w0_25: (c) => Math.round(0.25 * c.blend.frac * c.cap + 0.75 * c.med),
  c_hybrid_w0_75: (c) => Math.round(0.75 * c.blend.frac * c.cap + 0.25 * c.med),
  d_median_all: (c) => c.med,
  d2_mean_all: (c) => Math.round(c.mean),
  e_median_scaled: (c) => c.medS,
  f_hybrid_mean: (c) => Math.round((c.blend.frac * c.cap + c.mean) / 2),
}

// ---------------------------------------------------------------- one window
function runWindow(win, lines, capacities, events) {
  const t0 = Date.now()
  const startMs = luxMidnightMs(win.from)
  const endMs = luxMidnightMs(win.to) + 24 * 3600_000
  const stepMs = win.stepMin * 60_000
  const trainLines = lines.filter((l) => Date.parse(l.t) < startMs)
  const testLines = lines.filter((l) => {
    const t = Date.parse(l.t)
    return t >= startMs && t < endMs
  })
  console.error(`\n[${win.name}] ${testLines.length} test snapshots, ${trainLines.length} train snapshots (last ${trainLines.at(-1)?.t})`)
  if (testLines.length < 10) throw new Error('window not covered by snapshots')
  const profiles = buildProfiles(trainLines, capacities, events)
  const scaledProfiles = Object.fromEntries(
    Object.entries(FLOW_SCALINGS)
      .filter(([k]) => k !== 'unmodified')
      .map(([k, [lf, mf]]) => [k, scaleFlows(profiles, lf, mf)])
  )
  console.error(`  profiles built in ${((Date.now() - t0) / 1000).toFixed(1)} s; flows: ${profiles.flows ? 'yes' : 'NO'}, decay: ${profiles.decay ? 'yes' : 'NO'}`)

  const stats = new Map() // `${config}|${h}|${subset}` → Acc
  const reliab = new Map() // `${variant}|${h}` → Reliab
  const distTime = new Map() // h → {ms, calls}
  let noDist = 0

  for (const h of HORIZONS_H) {
    const hMs = h * 3600_000
    const th = { ms: 0, calls: 0 }
    distTime.set(h, th)
    for (let t = startMs; t < endMs; t += stepMs) {
      const actualLine = nearestLine(testLines, t)
      const baseLine = nearestLine(lines, t - hMs)
      if (!actualLine || !baseLine) continue
      const targetDate = new Date(Date.parse(actualLine.t))
      const baseDate = new Date(Date.parse(baseLine.t))
      const globalLiveMean = liveGlobalMean(baseLine, capacities)
      for (const [id, [actual]] of Object.entries(actualLine.s)) {
        const cap = capacities[id]?.capacity
        const base = baseLine.s[id]
        if (!cap || !base) continue
        const live = base[0]
        const st = { id, capacity: cap, bikes: live, lat: capacities[id].lat, lon: capacities[id].lon }
        const blend = predict(st, targetDate, { now: baseDate, profiles, globalLiveMean, events })
        const dst = { id, capacity: cap, bikes: live }
        const tA = Date.now()
        const dist = predictDistribution(dst, targetDate, { now: baseDate, profiles })
        th.ms += Date.now() - tA
        th.calls++
        if (!dist) {
          noDist++
          continue
        }
        const { median: med, mean } = distStats(dist)
        const distS = predictDistribution(dst, targetDate, { now: baseDate, profiles: scaledProfiles[POINT_SCALED] })
        const { median: medS } = distStats(distS)
        const ctx = { h, blend, cap, live, med, mean, medS }
        const errBase = blend.bikes - actual
        const errP = live - actual
        const level = live === 0 ? '0' : live <= 2 ? '1-2' : live <= 5 ? '3-5' : '6+'
        const jump = Math.abs(actual - live) >= JUMP ? 'jump' : 'calm'
        const nearEdge = live === 0 || live >= cap - 1 ? 'edge' : 'mid' // empty or (near-)full at T−h
        for (const [name, fn] of Object.entries(CONFIGS)) {
          const pred = Math.max(0, Math.min(cap, fn(ctx)))
          const err = pred - actual
          acc(stats, `${name}|${h}|all`).add(err, errBase, errP)
          acc(stats, `${name}|${h}|lv${level}`).add(err, errBase, errP)
          acc(stats, `${name}|${h}|${jump}`).add(err, errBase, errP)
          acc(stats, `${name}|${h}|${nearEdge}`).add(err, errBase, errP)
        }
        if (h === 1 || h === 6) {
          const y = actual >= 1 ? 1 : 0
          accReliab(reliab, `unmodified|${h}`).add(probAtLeast(dist, 1), y)
          for (const [k, prof] of Object.entries(scaledProfiles)) {
            const d = k === POINT_SCALED ? distS : predictDistribution(dst, targetDate, { now: baseDate, profiles: prof })
            accReliab(reliab, `${k}|${h}`).add(probAtLeast(d, 1), y)
          }
        }
      }
    }
    const a = stats.get(`baseline|${h}|all`)?.out()
    console.error(
      `  h=${h}: n=${a?.n} baseMAE=${a?.baselineMae} persist=${a?.persistenceMae} | dist ${(th.ms / Math.max(1, th.calls)).toFixed(2)} ms/call (${th.calls} calls) | elapsed ${((Date.now() - t0) / 1000).toFixed(0)} s`
    )
  }

  // ---- assemble
  const configs = {}
  for (const name of Object.keys(CONFIGS)) {
    configs[name] = {}
    for (const h of HORIZONS_H) {
      const all = stats.get(`${name}|${h}|all`)?.out()
      if (!all) continue
      configs[name][`${h}h`] = {
        ...all,
        levels: Object.fromEntries(['0', '1-2', '3-5', '6+'].map((lv) => [lv, stats.get(`${name}|${h}|lv${lv}`)?.out() ?? null])),
        calm: stats.get(`${name}|${h}|calm`)?.out() ?? null,
        jump: stats.get(`${name}|${h}|jump`)?.out() ?? null,
        edge: stats.get(`${name}|${h}|edge`)?.out() ?? null,
        mid: stats.get(`${name}|${h}|mid`)?.out() ?? null,
      }
    }
  }
  const calibration = {}
  for (const [k, r] of reliab) {
    const [variant, h] = k.split('|')
    ;(calibration[variant] ??= {})[`${h}h`] = r.out()
  }
  return {
    from: win.from,
    to: win.to,
    stepMin: win.stepMin,
    trainSnapshots: trainLines.length,
    trainLast: trainLines.at(-1)?.t,
    testSnapshots: testLines.length,
    samplesWithoutDistribution: noDist,
    distributionMsPerCall: Object.fromEntries([...distTime].map(([h, t]) => [`${h}h`, +(t.ms / Math.max(1, t.calls)).toFixed(3)])),
    elapsedS: +((Date.now() - t0) / 1000).toFixed(1),
    configs,
    calibration,
  }
}
function accReliab(map, key) {
  return map.get(key) ?? (map.set(key, new Reliab()), map.get(key))
}

// ---------------------------------------------------------------- main
async function main() {
  const tLoad = Date.now()
  const capacities = await loadCapacities()
  const lines = await loadSnapshotLines()
  const events = await loadEventCalendar()
  console.error(`loaded ${lines.length} snapshot lines (${lines[0]?.t} → ${lines.at(-1)?.t}) in ${((Date.now() - tLoad) / 1000).toFixed(1)} s`)

  const report = { experiment: 'median-point', generatedAt: new Date().toISOString(), flowScalings: FLOW_SCALINGS, windows: {} }
  for (const win of QUICK ? WINDOWS.slice(0, 1) : WINDOWS) {
    report.windows[win.name] = runWindow(win, lines, capacities, events)
  }
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(report, null, 1))

  // ---- console summary
  const f = (v) => (v == null ? '—' : String(v))
  for (const [wname, w] of Object.entries(report.windows)) {
    console.log(`\n==== ${wname}  (step ${w.stepMin} min; ${w.testSnapshots} test / ${w.trainSnapshots} train snapshots, train last ${w.trainLast}; ${w.elapsedS} s)`)
    console.log(`     distribution cost ms/call: ${JSON.stringify(w.distributionMsPerCall)}; samples without distribution: ${w.samplesWithoutDistribution}`)
    console.log('config            h    n       baseMAE  varMAE   persist  bias(var/base)  lv0 base/var (n)      lv1-2 base/var (n)    calm var/base  jump var/base  edge var/base')
    for (const [name, byH] of Object.entries(w.configs)) {
      for (const [h, r] of Object.entries(byH)) {
        const l0 = r.levels['0']
        const l12 = r.levels['1-2']
        console.log(
          `${name.padEnd(17)} ${h.padEnd(4)} ${String(r.n).padEnd(7)} ${f(r.baselineMae).padEnd(8)} ${f(r.variantMae).padEnd(8)} ${f(r.persistenceMae).padEnd(8)} ${(f(r.variantBias) + '/' + f(r.baselineBias)).padEnd(15)} ${(f(l0?.baselineMae) + '/' + f(l0?.variantMae) + ' (' + (l0?.n ?? 0) + ')').padEnd(21)} ${(f(l12?.baselineMae) + '/' + f(l12?.variantMae) + ' (' + (l12?.n ?? 0) + ')').padEnd(21)} ${(f(r.calm?.variantMae) + '/' + f(r.calm?.baselineMae)).padEnd(14)} ${(f(r.jump?.variantMae) + '/' + f(r.jump?.baselineMae)).padEnd(14)} ${f(r.edge?.variantMae)}/${f(r.edge?.baselineMae)}`
        )
      }
    }
    console.log('\n  calibration of P(>=1):')
    for (const [variant, byH] of Object.entries(w.calibration)) {
      for (const [h, r] of Object.entries(byH)) {
        console.log(
          `  ${variant.padEnd(16)} ${h}: n=${r.n} Brier ${r.brier} (base-rate ${r.brierBaseRate}) meanPred ${r.meanPredicted} obs ${r.observedRate} | ` +
            r.reliability.filter((b) => b.n).map((b) => `${b.bin}: ${b.predicted}→${b.observed} (${b.n})`).join(' | ')
        )
      }
    }
  }
  console.log(`\n→ ${OUT}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
