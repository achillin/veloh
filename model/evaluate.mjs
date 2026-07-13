#!/usr/bin/env node
// Backtests the predictor against reality: trains on everything except the
// most recent 24 h of snapshots, then "predicts" that held-out day and
// compares with what actually happened.
//
// For each test moment T and horizon h, the model gets exactly what the app
// would have had at T−h (the live snapshot then + the trained profiles) and
// must predict the bikes at T. Reported per horizon:
//   - model MAE (bikes) — the app's blended predictor
//   - persistence MAE   — baseline: "it stays what it was at T−h"
// The model earns its keep by beating persistence at longer horizons.
//
// Runs nightly in CI after train; writes public/model/eval.json.
// Usage: node model/evaluate.mjs

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSnapshotLines, loadCapacities, buildProfiles } from './train.mjs'
import { predict } from '../src/lib/predictor.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'model', 'eval.json')

const HORIZONS_H = [1, 3, 6, 24]
const TEST_WINDOW_MS = 24 * 3600_000
const SAMPLE_STEP_MS = 30 * 60_000 // evaluate every 30 min of the test day
const LOOKUP_TOL_MS = 7.5 * 60_000

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

async function main() {
  const capacities = await loadCapacities()
  const lines = await loadSnapshotLines()
  if (lines.length < 10) {
    console.error('Not enough snapshots to evaluate.')
    return
  }

  const lastMs = Date.parse(lines.at(-1).t)
  const cutoffMs = lastMs - TEST_WINDOW_MS
  const trainLines = lines.filter((l) => Date.parse(l.t) < cutoffMs)
  const testLines = lines.filter((l) => Date.parse(l.t) >= cutoffMs)

  const report = {
    generatedAt: new Date().toISOString(),
    trainSnapshots: trainLines.length,
    testSnapshots: testLines.length,
    testWindow: { from: new Date(cutoffMs).toISOString(), to: lines.at(-1).t },
    horizons: {},
  }

  if (!trainLines.length || testLines.length < 5) {
    report.note = 'test window not yet covered — need more than one day of data'
    await mkdir(dirname(OUT), { recursive: true })
    await writeFile(OUT, JSON.stringify(report, null, 1))
    console.log(report.note)
    return
  }

  const profiles = buildProfiles(trainLines, capacities)

  for (const h of HORIZONS_H) {
    const hMs = h * 3600_000
    let absModel = 0
    let absPersist = 0
    let n = 0
    for (let t = cutoffMs; t <= lastMs; t += SAMPLE_STEP_MS) {
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
        const p = predict({ id, capacity: cap, bikes: live }, targetDate, {
          now: baseDate,
          profiles,
          globalLiveMean,
        })
        absModel += Math.abs(p.bikes - actual)
        absPersist += Math.abs(live - actual)
        n++
      }
    }
    report.horizons[`${h}h`] = n
      ? {
          n,
          modelMae: +(absModel / n).toFixed(3),
          persistenceMae: +(absPersist / n).toFixed(3),
        }
      : { n: 0 }
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(report, null, 1))

  console.log(
    `evaluated on ${report.testSnapshots} held-out snapshots ` +
      `(${report.testWindow.from} → ${report.testWindow.to}), trained on ${report.trainSnapshots}`
  )
  console.log('horizon  n        model MAE  persistence MAE')
  for (const [h, r] of Object.entries(report.horizons)) {
    console.log(
      `${h.padEnd(8)} ${String(r.n).padEnd(8)} ${String(r.modelMae ?? '—').padEnd(10)} ${r.persistenceMae ?? '—'}`
    )
  }
  console.log(`→ ${OUT}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
