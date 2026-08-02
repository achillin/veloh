#!/usr/bin/env node
// Probes station OUTAGES in the collected snapshots (data/*.ndjson):
//
//   1. CLOSED episodes    — contiguous runs where flags != 7 (station not
//      fully open: not installed / not renting / not returning).
//   2. SILENT episodes    — runs where ageSec (seconds since the station
//      last reported telemetry) keeps growing across snapshots and exceeds
//      2 h. ageSec is feed-measured, so silence duration survives collector
//      gaps; a reset (age drops below prev + elapsed) marks the station
//      reporting again.
//   3. Correlation between the two.
//
// Episode duration conventions:
//   closed  : recovered  → firstClosedT .. firstOpenT (tight at 1-min cadence)
//             censored   → firstClosedT .. lastClosedT (collector gap > 30 min
//                          or end of data; true duration unknown)
//   silent  : max ageSec reached in the growth segment (includes silence that
//             began before our observation window).
//
// Usage: node model/outage-probe.mjs

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadSnapshotLines, DATA_DIR } from './train.mjs'

const GAP_MS = 30 * 60 * 1000 // collector gap that breaks a closed episode
const SILENT_SEC = 2 * 3600 // ageSec threshold for "telemetry-silent"
const RESET_SLACK_SEC = 120 // tolerance when detecting an age reset
const CHRONIC_FRAC = 0.5 // silent in >50% of snapshots ⇒ chronically stale

// ---------- small stats helpers ----------
const q = (sorted, p) => {
  if (!sorted.length) return NaN
  const i = (sorted.length - 1) * p
  const lo = Math.floor(i)
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo)
}
const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  return { n: s.length, median: q(s, 0.5), p90: q(s, 0.9), max: s[s.length - 1] ?? NaN }
}
const fmtMin = (m) =>
  !isFinite(m) ? 'n/a' : m < 90 ? `${m.toFixed(0)} min` : m < 48 * 60 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} d`
const pct = (x) => `${(100 * x).toFixed(1)}%`

// ---------- load ----------
const lines = await loadSnapshotLines()
let names = {}
try {
  names = JSON.parse(await readFile(join(DATA_DIR, 'stations.json'), 'utf8')).stations
} catch {}
const nameOf = (id) => names[id]?.name?.replace(/^#\d+-/, '') ?? `station ${id}`

// Normalize: per snapshot, per station → { flags, age|null }
const snaps = lines.map((l) => {
  const t = Date.parse(l.t)
  const st = new Map()
  for (const [id, a] of Object.entries(l.s ?? {})) {
    if (a.length >= 6) st.set(id, { flags: a[4], age: a[5] >= 0 ? a[5] : null })
    else st.set(id, { flags: 7, age: null }) // v1 line: assume open, age unknown
  }
  return { t, st }
})

// Coverage / collector gaps
let gapCount = 0
let gapMs = 0
for (let i = 1; i < snaps.length; i++) {
  const d = snaps[i].t - snaps[i - 1].t
  if (d > GAP_MS) {
    gapCount++
    gapMs += d
  }
}
const spanMs = snaps[snaps.length - 1].t - snaps[0].t
console.log('=== coverage ===')
console.log(`snapshots: ${snaps.length}  span: ${new Date(snaps[0].t).toISOString()} .. ${new Date(snaps[snaps.length - 1].t).toISOString()} (${(spanMs / 86400000).toFixed(1)} d)`)
console.log(`collector gaps >30 min: ${gapCount}, totalling ${(gapMs / 3600000).toFixed(1)} h — observed time ≈ ${((spanMs - gapMs) / 86400000).toFixed(1)} d`)

// ---------- 1. CLOSED episodes ----------
const closedEp = [] // {id, startT, lastT, endT, endReason, flagsSeen, snaps}
const curClosed = new Map() // id → episode under construction
const lastSeen = new Map() // id → last snapshot time the station appeared
const flagHist = new Map() // flags value → closed station-snapshot count
let closedSnaps = 0
let totalSnaps = 0

for (const { t, st } of snaps) {
  for (const [id, v] of st) {
    totalSnaps++
    const cur = curClosed.get(id)
    const prevT = lastSeen.get(id)
    if (cur && prevT != null && t - prevT > GAP_MS) {
      cur.endT = cur.lastT
      cur.endReason = 'gap'
      closedEp.push(cur)
      curClosed.delete(id)
    }
    if (v.flags !== 7) {
      closedSnaps++
      flagHist.set(v.flags, (flagHist.get(v.flags) ?? 0) + 1)
      const c = curClosed.get(id)
      if (c) {
        c.lastT = t
        c.snaps++
        c.flagsSeen.add(v.flags)
      } else {
        curClosed.set(id, { id, startT: t, lastT: t, snaps: 1, flagsSeen: new Set([v.flags]) })
      }
    } else {
      const c = curClosed.get(id)
      if (c) {
        c.endT = t
        c.endReason = 'recovered'
        closedEp.push(c)
        curClosed.delete(id)
      }
    }
    lastSeen.set(id, t)
  }
}
for (const c of curClosed.values()) {
  c.endT = c.lastT
  c.endReason = 'ongoing'
  closedEp.push(c)
}

const durMin = (e) => (e.endT - e.startT) / 60000
const recovered = closedEp.filter((e) => e.endReason === 'recovered')
const censored = closedEp.filter((e) => e.endReason !== 'recovered')
const rs = stats(recovered.map(durMin))
const closedStations = new Set(closedEp.map((e) => e.id))

console.log('\n=== 1. CLOSED episodes (flags != 7) ===')
console.log(`station-snapshots closed: ${closedSnaps}/${totalSnaps} (${pct(closedSnaps / totalSnaps)})`)
console.log(`episodes: ${closedEp.length} across ${closedStations.size} stations (${recovered.length} recovered, ${censored.length} censored by gap/data-end)`)
console.log(`flags values while closed: ${[...flagHist.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f}=${n}`).join('  ')}`)
if (rs.n) console.log(`recovered durations: median ${fmtMin(rs.median)}  p90 ${fmtMin(rs.p90)}  max ${fmtMin(rs.max)}`)
console.log('worst closed episodes:')
for (const e of [...closedEp].sort((a, b) => durMin(b) - durMin(a)).slice(0, 10)) {
  console.log(
    `  #${e.id.padStart(3)} ${nameOf(e.id).padEnd(28).slice(0, 28)} ${new Date(e.startT).toISOString().slice(0, 16)}  ${fmtMin(durMin(e)).padStart(8)}  flags={${[...e.flagsSeen].join(',')}}  ${e.endReason}`,
  )
}

// ---------- 2. SILENT episodes (ageSec growth > 2 h) ----------
// Per station: growth segments delimited by resets. maxAge is the silence
// duration; a segment whose maxAge exceeds SILENT_SEC is a silent episode.
const perStation = new Map() // id → {prevT, prevAge, seg, episodes[], silentSnaps, ageSnaps, resets, firstT, lastT}
const resetsByMinute = new Map() // ISO minute → simultaneous reset count

for (const { t, st } of snaps) {
  for (const [id, v] of st) {
    if (v.age == null) continue
    let p = perStation.get(id)
    if (!p) {
      p = { episodes: [], silentSnaps: 0, ageSnaps: 0, resets: 0, firstT: t, seg: null, prevT: null, prevAge: null }
      perStation.set(id, p)
    }
    p.ageSnaps++
    if (v.age > SILENT_SEC) p.silentSnaps++
    if (p.prevT != null) {
      const elapsed = (t - p.prevT) / 1000
      const reset = v.age < p.prevAge + elapsed - RESET_SLACK_SEC
      if (reset) {
        p.resets++
        const m = new Date(t).toISOString().slice(0, 16)
        resetsByMinute.set(m, (resetsByMinute.get(m) ?? 0) + 1)
        if (p.seg && p.seg.maxAge > SILENT_SEC) p.episodes.push({ ...p.seg, endT: t, endReason: 'reset' })
        p.seg = null
      }
    }
    if (!p.seg) p.seg = { id, startT: t, startAge: v.age, maxAge: v.age }
    else p.seg.maxAge = Math.max(p.seg.maxAge, v.age)
    p.prevT = t
    p.prevAge = v.age
    p.lastT = t
  }
}
const silentEp = []
for (const p of perStation.values()) {
  if (p.seg && p.seg.maxAge > SILENT_SEC) p.episodes.push({ ...p.seg, endT: p.lastT, endReason: 'ongoing' })
  silentEp.push(...p.episodes)
}

const chronic = [...perStation.entries()].filter(([, p]) => p.silentSnaps / p.ageSnaps > CHRONIC_FRAC)
const regular = [...perStation.entries()].filter(([, p]) => p.silentSnaps / p.ageSnaps <= CHRONIC_FRAC)
const silentStations = new Set(silentEp.map((e) => e.id))
const silentDurMin = silentEp.map((e) => e.maxAge / 60)
const ss = stats(silentDurMin)
const chronicIds = new Set(chronic.map(([id]) => id))
const ssRegular = stats(silentEp.filter((e) => !chronicIds.has(e.id)).map((e) => e.maxAge / 60))

console.log('\n=== 2. TELEMETRY-SILENT episodes (ageSec > 2 h, growing) ===')
console.log(`stations with ageSec data: ${perStation.size}`)
console.log(`chronically stale (silent in >${pct(CHRONIC_FRAC)} of snapshots): ${chronic.length} stations;  reporting regularly: ${regular.length}`)
console.log(`silent episodes: ${silentEp.length} across ${silentStations.size} stations (${silentEp.filter((e) => e.endReason === 'ongoing').length} ongoing at data end)`)
if (ss.n) console.log(`silence durations (all): median ${fmtMin(ss.median)}  p90 ${fmtMin(ss.p90)}  max ${fmtMin(ss.max)}`)
if (ssRegular.n)
  console.log(`silence durations (non-chronic stations only, n=${ssRegular.n}): median ${fmtMin(ssRegular.median)}  p90 ${fmtMin(ssRegular.p90)}  max ${fmtMin(ssRegular.max)}`)
console.log('worst silent episodes:')
for (const e of [...silentEp].sort((a, b) => b.maxAge - a.maxAge).slice(0, 10)) {
  console.log(
    `  #${e.id.padStart(3)} ${nameOf(e.id).padEnd(28).slice(0, 28)} ended ${new Date(e.endT).toISOString().slice(0, 16)}  ${fmtMin(e.maxAge / 60).padStart(8)}  ${e.endReason}${chronicIds.has(e.id) ? '  (chronic)' : ''}`,
  )
}

// Feed-level staleness: is silence station-specific or feed-wide?
let feedWideSnaps = 0
let v3Snaps = 0
for (const { st } of snaps) {
  let silent = 0
  let withAge = 0
  for (const v of st.values()) {
    if (v.age == null) continue
    withAge++
    if (v.age > SILENT_SEC) silent++
  }
  if (withAge > 0) {
    v3Snaps++
    if (silent / withAge > 0.5) feedWideSnaps++
  }
}
console.log(`feed-wide staleness: >50% of stations silent in ${feedWideSnaps}/${v3Snaps} v3 snapshots (${pct(feedWideSnaps / Math.max(1, v3Snaps))})`)
const topResets = [...resetsByMinute.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
console.log(`largest simultaneous reset waves (stations reporting in the same minute): ${topResets.map(([m, n]) => `${m}→${n}`).join('  ')}`)

// Refinement: the feed refreshes last_reported for (nearly) all stations in a
// single daily wave, so age > 2 h is mostly a feed artifact. A station that
// MISSED at least one daily wave (age > 26 h) is genuinely off the air.
const DEAD_SEC = 26 * 3600
const deadEp = silentEp.filter((e) => e.maxAge > DEAD_SEC)
const deadStations = new Set(deadEp.map((e) => e.id))
const ds = stats(deadEp.map((e) => e.maxAge / 60))
console.log(`\ngenuinely dead (missed >=1 daily refresh, age > 26 h): ${deadEp.length} episodes across ${deadStations.size} stations`)
if (ds.n) console.log(`  durations: median ${fmtMin(ds.median)}  p90 ${fmtMin(ds.p90)}  max ${fmtMin(ds.max)}`)

// ---------- 3. correlation closed × silent ----------
let a = 0, b = 0, c = 0, d = 0 // closed&silent, closed&fresh, open&silent, open&fresh
const perStFrac = new Map() // id → {closed, silent, n}
for (const { st } of snaps) {
  for (const [id, v] of st) {
    if (v.age == null) continue
    const closed = v.flags !== 7
    const silent = v.age > SILENT_SEC
    if (closed && silent) a++
    else if (closed) b++
    else if (silent) c++
    else d++
    let f = perStFrac.get(id)
    if (!f) perStFrac.set(id, (f = { closed: 0, silent: 0, n: 0 }))
    f.n++
    if (closed) f.closed++
    if (silent) f.silent++
  }
}
const phi = (a * d - b * c) / Math.sqrt((a + b) * (c + d) * (a + c) * (b + d))
const or = (a * d) / (b * c)
console.log('\n=== 3. correlation: closed × silent (station-snapshots with ageSec) ===')
console.log(`closed&silent=${a}  closed&fresh=${b}  open&silent=${c}  open&fresh=${d}`)
console.log(`P(silent|closed)=${pct(a / Math.max(1, a + b))}  P(silent|open)=${pct(c / Math.max(1, c + d))}  phi=${phi.toFixed(3)}  odds-ratio=${isFinite(or) ? or.toFixed(2) : 'inf'}`)

// station-level Pearson between closed-fraction and silent-fraction
const rows = [...perStFrac.values()].filter((f) => f.n >= 100).map((f) => [f.closed / f.n, f.silent / f.n])
if (rows.length > 2) {
  const mx = rows.reduce((s, r) => s + r[0], 0) / rows.length
  const my = rows.reduce((s, r) => s + r[1], 0) / rows.length
  let sxy = 0, sxx = 0, syy = 0
  for (const [x, y] of rows) {
    sxy += (x - mx) * (y - my)
    sxx += (x - mx) ** 2
    syy += (y - my) ** 2
  }
  console.log(`station-level Pearson r (closed-frac vs silent-frac, ${rows.length} stations): ${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}`)
}

// ---------- 4. verdict inputs ----------
console.log('\n=== 4. repair-time measurability ===')
console.log(`closed episodes with a measured end (recovered): ${recovered.length}/${closedEp.length} (${pct(recovered.length / Math.max(1, closedEp.length))})`)
console.log(`silent episodes ending in an observed reset: ${silentEp.filter((e) => e.endReason === 'reset').length}/${silentEp.length}`)
const blips = recovered.filter((e) => durMin(e) <= 5).length
console.log(`closed "blips" (≤5 min, likely transient flag flaps): ${blips}/${recovered.length} of recovered episodes`)
const real = recovered.filter((e) => durMin(e) > 5)
const rrs = stats(real.map(durMin))
if (rrs.n)
  console.log(`recovered episodes >5 min (n=${rrs.n}, ${new Set(real.map((e) => e.id)).size} stations): median ${fmtMin(rrs.median)}  p90 ${fmtMin(rrs.p90)}  max ${fmtMin(rrs.max)}`)
