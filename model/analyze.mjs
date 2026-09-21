#!/usr/bin/env node
// Forecast post-mortem for a day (or a range of days): how far off was the
// predictor, where, and why. Like evaluate.mjs it trains on everything before
// the window (honest, out-of-sample) and lets the model see only what the
// app would have had at T−h. On top of the headline MAE it breaks the error
// down by horizon, hour of day, station, live level, empty/full states, and
// "jumps" (rebalancing-sized changes nothing could have foreseen), scans the
// live-vs-profile blend weight for the MAE-optimal value, and checks the
// calibration of P(≥1 bike).
//
// Usage: node model/analyze.mjs --from 2026-09-17 [--to 2026-09-17] [--step 15] [--horizons 1,3,6,24] [--out file.json]
//   dates are Europe/Luxembourg calendar days; the window is [from 00:00, to 24:00)

import { writeFile } from 'node:fs/promises'
import { loadSnapshotLines, loadCapacities, buildProfiles, loadEventCalendar } from './train.mjs'
import { predict, predictDistribution, probAtLeast } from '../src/lib/predictor.js'

const LOOKUP_TOL_MS = 7.5 * 60_000
const JUMP = 4 // |Δbikes| within the horizon at/above this ≈ a rebalancing visit

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split(/\s+--/)
    .filter(Boolean)
    .map((s) => {
      const [k, v] = s.replace(/^--/, '').split(/[= ]/)
      return [k, v ?? true]
    })
)
const luxParts = (d) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Luxembourg',
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
    })
      .formatToParts(d)
      .map((p) => [p.type, Number(p.value)])
  )
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

// --horizons 1,3,6,24 (hours); P(>=1) calibration is reported for 1 h and 6 h when present
const HORIZONS_H = args.horizons ? String(args.horizons).split(",").map(Number).filter((h) => h > 0) : [1, 3, 6, 24]

const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
const FROM = args.from ?? yesterday
const TO = args.to ?? FROM
const STEP_MS = Number(args.step ?? 15) * 60_000
const OUT = args.out ?? null

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

class Acc {
  constructor() {
    this.n = 0
    this.abs = 0
    this.sq = 0
    this.bias = 0
    this.absP = 0
    this.w1 = 0
    this.w2 = 0
  }
  add(err, errP) {
    this.n++
    this.abs += Math.abs(err)
    this.sq += err * err
    this.bias += err
    this.absP += Math.abs(errP)
    if (Math.abs(err) <= 1) this.w1++
    if (Math.abs(err) <= 2) this.w2++
  }
  out() {
    const n = this.n || 1
    return {
      n: this.n,
      mae: +(this.abs / n).toFixed(3),
      persistMae: +(this.absP / n).toFixed(3),
      bias: +(this.bias / n).toFixed(3),
      rmse: +Math.sqrt(this.sq / n).toFixed(3),
      within1: +(this.w1 / n).toFixed(3),
      within2: +(this.w2 / n).toFixed(3),
    }
  }
}
const acc = (map, key) => map.get(key) ?? (map.set(key, new Acc()), map.get(key))

async function main() {
  const capacities = await loadCapacities()
  const lines = await loadSnapshotLines()
  const events = await loadEventCalendar()
  const startMs = luxMidnightMs(FROM)
  const endMs = luxMidnightMs(TO) + 24 * 3600_000
  const trainLines = lines.filter((l) => Date.parse(l.t) < startMs)
  const testLines = lines.filter((l) => {
    const t = Date.parse(l.t)
    return t >= startMs && t < endMs
  })
  console.error(
    `window ${FROM} → ${TO}: ${testLines.length} test snapshots, ${trainLines.length} training snapshots (last ${trainLines.at(-1)?.t})`
  )
  if (testLines.length < 10) throw new Error('window not covered by snapshots')
  const profiles = buildProfiles(trainLines, capacities, events)

  const perHorizon = new Map() // h → Acc
  const perHour = new Map() // `${h}|${hour}` → Acc
  const perStation = new Map() // `${h}|${id}` → Acc
  const perLevel = new Map() // `${h}|${level}` → Acc
  const perJump = new Map() // `${h}|jump|calm` → Acc
  const profileOnly = new Map() // h → Acc (no live blend at all)
  const blendScan = new Map() // h → Float64Array of abs error sums per w
  const W_STEPS = 21
  const emptyStats = new Map() // h → {actualEmpty, predictedEmptyish, hit, falseAlarm, fullActual, fullHit}
  const reliab = new Map() // h → bins[10] {sumP, sumY, n}, brier, n
  const covered = new Set()

  for (const h of HORIZONS_H) {
    const hMs = h * 3600_000
    const scan = new Float64Array(W_STEPS)
    let scanN = 0
    const es = { actualEmpty: 0, hit: 0, predEmpty: 0, falseAlarm: 0, actualFull: 0, fullHit: 0 }
    const rb = { bins: Array.from({ length: 10 }, () => ({ sumP: 0, sumY: 0, n: 0 })), brier: 0, n: 0, y: 0 }
    for (let t = startMs; t < endMs; t += STEP_MS) {
      const actualLine = nearestLine(testLines, t)
      const baseLine = nearestLine(lines, t - hMs)
      if (!actualLine || !baseLine) continue
      covered.add(actualLine.t.slice(0, 13))
      const targetDate = new Date(Date.parse(actualLine.t))
      const baseDate = new Date(Date.parse(baseLine.t))
      const hour = luxParts(targetDate).hour % 24
      const globalLiveMean = liveGlobalMean(baseLine, capacities)
      const farBase = new Date(targetDate.getTime() - 49 * 3600_000) // beyond the 48 h blend horizon → pure profile
      for (const [id, [actual]] of Object.entries(actualLine.s)) {
        const cap = capacities[id]?.capacity
        const base = baseLine.s[id]
        if (!cap || !base) continue
        const live = base[0]
        const st = { id, capacity: cap, bikes: live, lat: capacities[id].lat, lon: capacities[id].lon }
        const p = predict(st, targetDate, { now: baseDate, profiles, globalLiveMean, events })
        const q = predict(st, targetDate, { now: farBase, profiles, globalLiveMean, events })
        const err = p.bikes - actual
        const errP = live - actual
        acc(perHorizon, h).add(err, errP)
        acc(perHour, `${h}|${hour}`).add(err, errP)
        acc(perStation, `${h}|${id}`).add(err, errP)
        const level = live === 0 ? '0' : live <= 2 ? '1-2' : live <= 5 ? '3-5' : '6+'
        acc(perLevel, `${h}|${level}`).add(err, errP)
        acc(perJump, `${h}|${Math.abs(actual - live) >= JUMP ? 'jump' : 'calm'}`).add(err, errP)
        acc(profileOnly, h).add(q.bikes - actual, errP)
        // blend-weight scan on fractions (what w would have minimised MAE?)
        const liveFrac = Math.min(live / cap, 1)
        for (let i = 0; i < W_STEPS; i++) {
          const w = i / (W_STEPS - 1)
          scan[i] += Math.abs(Math.round((w * liveFrac + (1 - w) * q.frac) * cap) - actual)
        }
        scanN++
        if (actual === 0) {
          es.actualEmpty++
          if (p.bikes <= 1) es.hit++
        }
        if (p.bikes <= 1) {
          es.predEmpty++
          if (actual >= 3) es.falseAlarm++
        }
        if (actual >= cap) {
          es.actualFull++
          if (p.bikes >= cap - 1) es.fullHit++
        }
        if (h === 1 || h === 6) {
          const dist = predictDistribution({ id, capacity: cap, bikes: live }, targetDate, { now: baseDate, profiles })
          if (dist) {
            const p1 = probAtLeast(dist, 1)
            const y = actual >= 1 ? 1 : 0
            const b = rb.bins[Math.min(9, Math.floor(p1 * 10))]
            b.sumP += p1
            b.sumY += y
            b.n++
            rb.brier += (p1 - y) ** 2
            rb.y += y
            rb.n++
          }
        }
      }
    }
    blendScan.set(h, { scan: [...scan].map((v) => +(v / Math.max(1, scanN)).toFixed(3)), n: scanN })
    emptyStats.set(h, es)
    if (h === 1 || h === 6) reliab.set(h, rb)
  }

  const names = (id) => capacities[id]?.name ?? id
  const report = {
    window: { from: FROM, to: TO, testSnapshots: testLines.length, trainSnapshots: trainLines.length, hoursCovered: covered.size },
    horizons: {},
  }
  for (const h of HORIZONS_H) {
    const key = `${h}h`
    const scan = blendScan.get(h)
    const bestI = scan.scan.indexOf(Math.min(...scan.scan))
    const es = emptyStats.get(h)
    const byHour = []
    for (let hr = 0; hr < 24; hr++) {
      const a = perHour.get(`${h}|${hr}`)
      if (a) byHour.push({ hour: hr, ...a.out() })
    }
    const stations = [...perStation]
      .filter(([k]) => k.startsWith(`${h}|`))
      .map(([k, a]) => ({ id: k.split('|')[1], name: names(k.split('|')[1]), cap: capacities[k.split('|')[1]]?.capacity, ...a.out() }))
      .sort((a, b) => b.mae - a.mae)
    const levels = {}
    for (const lv of ['0', '1-2', '3-5', '6+']) levels[lv] = perLevel.get(`${h}|${lv}`)?.out() ?? null
    const jump = perJump.get(`${h}|jump`)?.out() ?? null
    const calm = perJump.get(`${h}|calm`)?.out() ?? null
    const all = perHorizon.get(h).out()
    report.horizons[key] = {
      ...all,
      profileOnlyMae: profileOnly.get(h).out().mae,
      blendScan: { bestW: +(bestI / (W_STEPS - 1)).toFixed(2), bestMae: scan.scan[bestI], curve: scan.scan },
      jumps: jump && calm ? { share: +(jump.n / (jump.n + calm.n)).toFixed(3), jumpMae: jump.mae, calmMae: calm.mae, calmPersistMae: calm.persistMae, absErrorShare: +((jump.mae * jump.n) / (jump.mae * jump.n + calm.mae * calm.n)).toFixed(3) } : null,
      levels,
      empty: {
        actualEmpty: es.actualEmpty,
        recall: es.actualEmpty ? +(es.hit / es.actualEmpty).toFixed(3) : null,
        predictedEmptyish: es.predEmpty,
        falseAlarmRate: es.predEmpty ? +(es.falseAlarm / es.predEmpty).toFixed(3) : null,
        actualFull: es.actualFull,
        fullRecall: es.actualFull ? +(es.fullHit / es.actualFull).toFixed(3) : null,
      },
      byHour,
      worstStations: stations.slice(0, 12),
      bestStations: stations.slice(-5).reverse(),
    }
    const rb = reliab.get(h)
    if (rb?.n) {
      report.horizons[key].probability = {
        n: rb.n,
        brier: +(rb.brier / rb.n).toFixed(4),
        brierBaseRate: +((rb.y / rb.n) * (1 - rb.y / rb.n)).toFixed(4),
        reliability: rb.bins.map((b, i) => ({ bin: `${i * 10}-${i * 10 + 10}%`, n: b.n, predicted: b.n ? +(b.sumP / b.n).toFixed(3) : null, observed: b.n ? +(b.sumY / b.n).toFixed(3) : null })),
      }
    }
  }

  if (OUT) await writeFile(OUT, JSON.stringify(report, null, 1))

  // ---- console summary ----
  const f = (v) => (v == null ? '—' : String(v))
  console.log(`\n== ${FROM} → ${TO}  (${report.window.testSnapshots} snapshots, ${report.window.hoursCovered} h covered; trained on ${report.window.trainSnapshots})`)
  console.log('horizon   n      MAE    persist  profile  bias    RMSE   ±1     ±2     bestW  MAE@bestW  jumpShare  jumpErrShare  calmMAE/persist')
  for (const [k, r] of Object.entries(report.horizons)) {
    console.log(
      `${k.padEnd(9)} ${String(r.n).padEnd(6)} ${f(r.mae).padEnd(6)} ${f(r.persistMae).padEnd(8)} ${f(r.profileOnlyMae).padEnd(8)} ${f(r.bias).padEnd(7)} ${f(r.rmse).padEnd(6)} ${f(r.within1).padEnd(6)} ${f(r.within2).padEnd(6)} ${f(r.blendScan.bestW).padEnd(6)} ${f(r.blendScan.bestMae).padEnd(10)} ${f(r.jumps?.share).padEnd(10)} ${f(r.jumps?.absErrorShare).padEnd(13)} ${f(r.jumps?.calmMae)}/${f(r.jumps?.calmPersistMae)}`
    )
  }
  for (const [k, r] of Object.entries(report.horizons)) {
    console.log(`\n-- ${k}: empty actual=${r.empty.actualEmpty} recall(pred≤1)=${f(r.empty.recall)}  predicted≤1=${r.empty.predictedEmptyish} falseAlarm(actual≥3)=${f(r.empty.falseAlarmRate)}  full actual=${r.empty.actualFull} recall=${f(r.empty.fullRecall)}`)
    console.log(`   by live level: ` + Object.entries(r.levels).map(([lv, a]) => `${lv}: MAE ${f(a?.mae)} bias ${f(a?.bias)} (n=${a?.n ?? 0})`).join(' | '))
    if (k === '1h' || k === '6h') {
      console.log(`   by hour (MAE model/persist, bias): ` + r.byHour.map((b) => `${b.hour}h ${b.mae}/${b.persistMae} ${b.bias > 0 ? '+' : ''}${b.bias}`).join('  '))
      console.log(`   worst stations: ` + r.worstStations.slice(0, 8).map((s) => `${s.name} (cap ${s.cap}) MAE ${s.mae} bias ${s.bias}`).join(' | '))
    }
    if (r.probability) {
      console.log(`   P(≥1) Brier ${r.probability.brier} vs base-rate ${r.probability.brierBaseRate}; reliability: ` + r.probability.reliability.filter((b) => b.n).map((b) => `${b.bin}: pred ${b.predicted} obs ${b.observed} (n=${b.n})`).join(' | '))
    }
  }
  if (OUT) console.log(`\n→ ${OUT}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
