#!/usr/bin/env node
// One-off analysis for the "does churn vary by time of day?" question:
// per weekday-hour, the mean absolute 1-hour change in bikes per station,
// plus the lag-1h anomaly autocorrelation (how fast the live level decays
// toward the seasonal mean — the right value for the predictor's blend).

import { loadSnapshotLines, loadCapacities, bucketKey, buildProfiles } from './train.mjs'

const lines = await loadSnapshotLines()
const capacities = await loadCapacities()
const profiles = buildProfiles(lines, capacities)
const byMinute = new Map(lines.map((l) => [l.t.slice(0, 16), l]))

const at = (ms) => {
  for (const off of [0, 1, -1, 2, -2]) {
    const line = byMinute.get(new Date(ms + off * 60_000).toISOString().slice(0, 16))
    if (line) return line
  }
  return null
}

const hourStats = new Map() // 'wd-H' → {sumAbs, n}
let num = 0
let den = 0

for (const line of lines) {
  const t0 = Date.parse(line.t)
  const next = at(t0 + 3600_000)
  if (!next) continue
  const key0 = bucketKey(line.t)
  for (const [id, [b0]] of Object.entries(line.s)) {
    const cap = capacities[id]?.capacity
    const rec = next.s[id]
    if (!cap || !rec) continue
    const b1 = rec[0]
    const st = hourStats.get(key0) ?? { sumAbs: 0, n: 0 }
    st.sumAbs += Math.abs(b1 - b0)
    st.n++
    hourStats.set(key0, st)
    // anomaly autocorrelation vs the trained seasonal mean
    const m0 = (profiles.stations[id]?.[key0] ?? profiles.global[key0])?.[0]
    const key1 = bucketKey(next.t)
    const m1 = (profiles.stations[id]?.[key1] ?? profiles.global[key1])?.[0]
    if (m0 == null || m1 == null) continue
    const a0 = b0 / cap - m0
    const a1 = b1 / cap - m1
    num += a0 * a1
    den += a0 * a0
  }
}

console.log('mean |Δbikes| over 1 h per station, weekdays (hour → change):')
for (let h = 0; h < 24; h++) {
  const st = hourStats.get(`wd-${h}`)
  if (!st?.n) continue
  const v = st.sumAbs / st.n
  console.log(`  ${String(h).padStart(2, '0')}:00  ${v.toFixed(2)}  ${'█'.repeat(Math.round(v * 12))}`)
}
const rho = num / den
console.log(`\nlag-1h anomaly autocorrelation ρ = ${rho.toFixed(3)}`)
console.log(`implied decay timescale τ = ${(-1 / Math.log(rho)).toFixed(2)} h (predictor currently assumes 2.5 h)`)
