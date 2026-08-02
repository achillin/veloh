#!/usr/bin/env node
// Are operator rebalancing events (truck refills/removals) separable from
// organic traffic? Looks at 5-minute per-station changes: organic rentals
// should be small steps, truck operations big fast jumps.

import { loadSnapshotLines } from './train.mjs'

const lines = await loadSnapshotLines()
const byMinute = new Map(lines.map((l) => [l.t.slice(0, 16), l]))
const at = (ms) => {
  for (const off of [0, 1, -1]) {
    const line = byMinute.get(new Date(ms + off * 60_000).toISOString().slice(0, 16))
    if (line) return line
  }
  return null
}

const hist = new Map() // |Δ| → count of 5-min station-changes
const jumpByHour = new Map() // hour → count of |Δ|≥5 events
const examples = []
let totalChanges = 0

for (const line of lines) {
  const next = at(Date.parse(line.t) + 5 * 60_000)
  if (!next) continue
  for (const [id, [b0]] of Object.entries(line.s)) {
    const rec = next.s[id]
    if (!rec) continue
    const d = rec[0] - b0
    if (d === 0) continue
    totalChanges++
    const a = Math.min(Math.abs(d), 15)
    hist.set(a, (hist.get(a) ?? 0) + 1)
    if (Math.abs(d) >= 5) {
      const hour = new Date(Date.parse(line.t)).getUTCHours()
      jumpByHour.set(hour, (jumpByHour.get(hour) ?? 0) + 1)
      if (examples.length < 8 && Math.abs(d) >= 7) {
        examples.push(`${line.t.slice(5, 16)} station ${id}: ${b0} → ${rec[0]} (${d > 0 ? '+' : ''}${d})`)
      }
    }
  }
}

console.log('5-min |Δbikes| distribution (all stations, 20 days):')
for (const [a, n] of [...hist].sort((x, y) => x[0] - y[0])) {
  const pct = ((n / totalChanges) * 100).toFixed(2)
  console.log(`  |Δ|=${String(a).padStart(2)}${a === 15 ? '+' : ' '}  ${String(n).padStart(7)}  ${pct}%`)
}
const big = [...hist].filter(([a]) => a >= 5).reduce((s, [, n]) => s + n, 0)
console.log(`\n|Δ|≥5 in 5 min: ${big} events = ${((big / totalChanges) * 100).toFixed(2)}% of changes`)
console.log('\n|Δ|≥5 events by hour (UTC):')
for (let h = 0; h < 24; h++) {
  const n = jumpByHour.get(h) ?? 0
  console.log(`  ${String(h).padStart(2, '0')}  ${'█'.repeat(Math.round(n / 3))} ${n}`)
}
console.log('\nbiggest examples:')
for (const e of examples) console.log(' ', e)
