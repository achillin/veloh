#!/usr/bin/env node
// Experiment "rebalance-ev": add the expected operator-rebalancing effect
// (truck refills / removals) to the point forecast.
//
// The predictor blends the live count with the learned profile; neither part
// anticipates the refill that is likely in the next hour. Here we learn, from
// the training snapshots only:
//   * table[station][bucket] = [pUp, pDown]  — exactly what train.mjs stores
//     in profiles.rebalance (fraction of observed days with a ≥5-bike jump
//     within 5 minutes in that dayType-hour bucket), but WITHOUT the ≥0.15
//     reporting threshold so every bucket has a probability;
//   * per-station refill / removal sizes (mean and median of the distinct
//     jump episodes, shrunk toward the global size with K=5 pseudo-episodes);
//   * a level-conditional boost: P(refill within 1 h | live level) divided by
//     the unconditional P(refill within 1 h), per live-level class, so an
//     empty station gets a larger refill probability in the first hour(s).
// predictVariant = clip(round(predict().frac × cap + EV), 0, cap), where EV
// accumulates over every hour between origin and target
//   cover_i × (pUp_i × sizeUp − pDown_i × sizeDown) × scale_i
// with scale ∈ {raw: 1, surv: anomaly survival from that hour to the target,
// w: the predictor's total live weight}. A "med" mode instead adds the full
// size only when the cumulative P(≥1 visit over the horizon) exceeds 0.5
// (MAE rewards the median, not the mean).
//
// Standalone: nothing in the repo is modified. Two honest windows, each
// trained on snapshots strictly before the window.
// Usage: node model/experiments/rebalance-ev.mjs

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSnapshotLines, loadCapacities, buildProfiles, loadEventCalendar, bucketKey } from '../train.mjs'
import { predict } from '../../src/lib/predictor.js'

// predictor.js keys buckets by Date#getHours(); train.mjs by Europe/Luxembourg.
process.env.TZ = 'Europe/Luxembourg'
if (new Date(Date.UTC(2026, 8, 17, 10)).getHours() !== 12) throw new Error('process TZ is not Europe/Luxembourg')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_DIR = join(ROOT, 'model', 'experiments', 'out')
const OUT = join(OUT_DIR, 'rebalance-ev.json')

const HORIZONS_H = [1, 3, 6, 24]
const LOOKUP_TOL_MS = 7.5 * 60_000
const JUMP = 4 // analyze.mjs: |Δbikes| over the horizon ≥ this → "jump" sample
const REBAL_JUMP = 5 // train.mjs: |Δbikes| within 5 min ≥ this → rebalancing visit
const DECAY_SHRINK_K = 300 // predictor.js
const LEARNED_HORIZON_H = 12 // predictor.js
const SIZE_SHRINK_K = 5 // pseudo-episodes pulling a station's jump size toward the global one
const COND_H = 1 // the level-conditional boost is learned at this horizon
const MIN_COND_N = 300 // level classes with fewer samples keep boost = 1

const WINDOWS = [
  { name: 'day-2026-09-17', from: '2026-09-17', to: '2026-09-17', stepMin: 15 },
  { name: 'week-2026-09-11..17', from: '2026-09-11', to: '2026-09-17', stepMin: 30 },
]

const CONFIGS = []
for (const cond of [false, true])
  for (const size of ['mean', 'median'])
    for (const scale of ['raw', 'surv', 'w'])
      CONFIGS.push({ name: `${cond ? 'cond' : 'uncond'}-${size}-${scale}`, table: 'full', cond, size, scale, mode: 'ev' })
CONFIGS.push({ name: 'uncond-mean-surv-med', table: 'full', cond: false, size: 'mean', scale: 'surv', mode: 'med' })
CONFIGS.push({ name: 'cond-mean-surv-med', table: 'full', cond: true, size: 'mean', scale: 'surv', mode: 'med' })
CONFIGS.push({ name: 'shipped-uncond-mean-raw', table: 'shipped', cond: false, size: 'mean', scale: 'raw', mode: 'ev' })

// ---- helpers copied from analyze.mjs ----
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
function makeLineAt(lines) {
  const byMinute = new Map(lines.map((l) => [l.t.slice(0, 16), l]))
  return (ms) => {
    for (const off of [0, 1, -1, 2, -2]) {
      const c = byMinute.get(new Date(ms + off * 60_000).toISOString().slice(0, 16))
      if (c) return c
    }
    return null
  }
}
/** number of sorted values v with a < v <= b */
function countIn(sorted, a, b) {
  if (!sorted?.length) return 0
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= a) lo = mid + 1
    else hi = mid
  }
  const start = lo
  hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= b) lo = mid + 1
    else hi = mid
  }
  return lo - start
}

class Acc {
  constructor() {
    this.n = 0
    this.abs = 0
    this.bias = 0
    this.absP = 0
    this.changed = 0
  }
  add(err, errP, changed = false) {
    this.n++
    this.abs += Math.abs(err)
    this.bias += err
    this.absP += Math.abs(errP)
    if (changed) this.changed++
  }
  out() {
    const n = this.n || 1
    return {
      n: this.n,
      mae: +(this.abs / n).toFixed(3),
      persistMae: +(this.absP / n).toFixed(3),
      bias: +(this.bias / n).toFixed(3),
      changedShare: +(this.changed / n).toFixed(3),
    }
  }
}
const REPORT_LEVELS = ['0', '1-2', '3-5', '6+']
const reportLevelOf = (b) => (b === 0 ? '0' : b <= 2 ? '1-2' : b <= 5 ? '3-5' : '6+')
const LEVELS = ['0', '1-2', '3-5', '6-9', '10-14', '15+']
const levelOf = (b) => (b === 0 ? '0' : b <= 2 ? '1-2' : b <= 5 ? '3-5' : b <= 9 ? '6-9' : b <= 14 ? '10-14' : '15+')
const newGroup = () => ({
  all: new Acc(),
  byLevel: Object.fromEntries(REPORT_LEVELS.map((l) => [l, new Acc()])),
  jump: new Acc(),
  calm: new Acc(),
})
const groupOut = (g) => ({
  ...g.all.out(),
  byLevel: Object.fromEntries(REPORT_LEVELS.map((l) => [l, g.byLevel[l].out()])),
  jump: g.jump.out(),
  calm: g.calm.out(),
})

// ---- learning from training snapshots ----

/** Mirrors train.mjs's rebalancing statistics without the ≥0.15 threshold:
 *  table[id][bucket] = [pUp, pDown] = fraction of observed days (per bucket)
 *  with at least one ≥5-bike 5-minute jump up / down at that station. */
function learnRebalanceTable(lines) {
  const lineAt = makeLineAt(lines)
  const acc = new Map()
  const obsDays = new Map()
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
      let byKey = acc.get(id)
      if (!byKey) acc.set(id, (byKey = new Map()))
      let e = byKey.get(key)
      if (!e) byKey.set(key, (e = { up: new Set(), down: new Set() }))
      ;(d > 0 ? e.up : e.down).add(day)
    }
  }
  const table = {}
  let cells = 0
  for (const [id, byKey] of acc) {
    for (const [key, e] of byKey) {
      const n = obsDays.get(key)?.size ?? 0
      if (!n) continue
      ;(table[id] ??= {})[key] = [e.up.size / n, e.down.size / n]
      cells++
    }
  }
  return { table, cells, obsDays: Object.fromEntries([...obsDays].map(([k, s]) => [k, s.size])) }
}

/** Distinct rebalancing visits: maximal runs of consecutive snapshots whose
 *  5-minute delta is ≥5 in the same direction. size = largest 5-min delta in
 *  the run, t ≈ when the jump completed. */
function detectEpisodes(lines) {
  const lineAt = makeLineAt(lines)
  const open = new Map() // id → {sign, max, lastT}
  const out = new Map() // id → {up: [{t,size}], down: [...], upT: [], downT: []}
  const close = (id, st) => {
    let e = out.get(id)
    if (!e) out.set(id, (e = { up: [], down: [] }))
    ;(st.sign > 0 ? e.up : e.down).push({ t: st.lastT + 60_000, size: st.max })
  }
  for (const line of lines) {
    const t0 = Date.parse(line.t)
    const next = lineAt(t0 + 5 * 60_000)
    for (const [id, rec0] of Object.entries(line.s)) {
      const st = open.get(id)
      const rec = next?.s[id]
      const d = rec ? rec[0] - rec0[0] : 0
      if (st && (t0 - st.lastT > 3 * 60_000 || Math.abs(d) < REBAL_JUMP || Math.sign(d) !== st.sign)) {
        close(id, st)
        open.delete(id)
      }
      if (!rec || Math.abs(d) < REBAL_JUMP) continue
      const cur = open.get(id)
      if (cur) {
        cur.max = Math.max(cur.max, Math.abs(d))
        cur.lastT = t0
      } else open.set(id, { sign: Math.sign(d), max: Math.abs(d), lastT: t0 })
    }
  }
  for (const [id, st] of open) close(id, st)
  for (const e of out.values()) {
    e.up.sort((a, b) => a.t - b.t)
    e.down.sort((a, b) => a.t - b.t)
    e.upT = e.up.map((x) => x.t)
    e.downT = e.down.map((x) => x.t)
  }
  return out
}

function learnSizes(episodes, capacities) {
  const median = (a) => {
    if (!a.length) return 0
    const s = [...a].sort((x, y) => x - y)
    const m = s.length >> 1
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)
  const gUp = []
  const gDown = []
  for (const e of episodes.values()) {
    gUp.push(...e.up.map((x) => x.size))
    gDown.push(...e.down.map((x) => x.size))
  }
  const global = { upMean: mean(gUp), upMed: median(gUp), downMean: mean(gDown), downMed: median(gDown), nUp: gUp.length, nDown: gDown.length }
  const shrink = (v, n, g) => (n * v + SIZE_SHRINK_K * g) / (n + SIZE_SHRINK_K)
  const stations = {}
  for (const id of Object.keys(capacities)) {
    const e = episodes.get(id) ?? { up: [], down: [] }
    const u = e.up.map((x) => x.size)
    const d = e.down.map((x) => x.size)
    stations[id] = {
      upMean: shrink(mean(u), u.length, global.upMean),
      upMed: shrink(median(u), u.length, global.upMed),
      downMean: shrink(mean(d), d.length, global.downMean),
      downMed: shrink(median(d), d.length, global.downMed),
      nUp: u.length,
      nDown: d.length,
    }
  }
  return { global, stations }
}

/** P(visit within h | live level) from training snapshots sampled every
 *  15 min; the boost = P(up within COND_H | level) / P(up within COND_H). */
function learnConditional(trainLines, episodes) {
  const firstMs = Date.parse(trainLines[0].t)
  const lastMs = Date.parse(trainLines.at(-1).t)
  const init = () => Object.fromEntries(HORIZONS_H.map((h) => [h, { n: 0, up: 0, down: 0 }]))
  const stats = Object.fromEntries([...LEVELS, 'all', 'low(<=2)'].map((k) => [k, init()]))
  for (let t = firstMs; t <= lastMs; t += 15 * 60_000) {
    const line = nearestLine(trainLines, t, 2 * 60_000)
    if (!line) continue
    const tl = Date.parse(line.t)
    for (const [id, [bikes]] of Object.entries(line.s)) {
      const e = episodes.get(id)
      const keys = [levelOf(bikes), 'all']
      if (bikes <= 2) keys.push('low(<=2)')
      for (const h of HORIZONS_H) {
        const end = tl + h * 3600_000
        if (end > lastMs) continue
        const up = e ? countIn(e.upT, tl, end) > 0 : false
        const down = e ? countIn(e.downT, tl, end) > 0 : false
        for (const k of keys) {
          const s = stats[k][h]
          s.n++
          if (up) s.up++
          if (down) s.down++
        }
      }
    }
  }
  const probs = {}
  for (const [k, byH] of Object.entries(stats)) {
    probs[k] = {}
    for (const h of HORIZONS_H) {
      const s = byH[h]
      probs[k][`${h}h`] = { n: s.n, pUp: s.n ? +(s.up / s.n).toFixed(4) : null, pDown: s.n ? +(s.down / s.n).toFixed(4) : null }
    }
  }
  const all = stats.all[COND_H]
  const pAllUp = all.up / all.n
  const pAllDown = all.down / all.n
  const boostUp = {}
  const boostDown = {}
  for (const lv of LEVELS) {
    const s = stats[lv][COND_H]
    boostUp[lv] = s.n >= MIN_COND_N && pAllUp > 0 ? +(s.up / s.n / pAllUp).toFixed(3) : 1
    boostDown[lv] = s.n >= MIN_COND_N && pAllDown > 0 ? +(s.down / s.n / pAllDown).toFixed(3) : 1
  }
  return { probs, boostUp, boostDown }
}

// ---- predictor internals replicated (bucketRho is not exported) ----
function bucketRho(profiles, ms) {
  const d = profiles?.decay
  if (!d?.global) return null
  const g = d.global[0]
  const s = d.byKey?.[bucketKey(ms)]
  const rho = s ? (s[1] * s[0] + DECAY_SHRINK_K * g) / (s[1] + DECAY_SHRINK_K) : g
  return Math.min(Math.max(rho, 0.01), 0.995)
}
/** Per-hour path from origin to target: bucket keys, hour coverage, anomaly
 *  survival S0[i] (origin → start of hour i), S[i] (middle of hour i →
 *  target) and the predictor's total live weight wTotal. */
function hourPath(profiles, baseMs, dtH) {
  const n = Math.min(24, Math.ceil(dtH - 1e-9))
  const keys = []
  const cover = []
  const rho = []
  let remaining = dtH
  for (let i = 0; i < n; i++) {
    const ms = baseMs + i * 3600_000
    keys.push(bucketKey(ms))
    cover.push(Math.min(1, remaining))
    rho.push(bucketRho(profiles, ms) ?? 1)
    remaining -= 1
  }
  const S0 = new Array(n)
  const S = new Array(n)
  let acc = 1
  for (let i = 0; i < n; i++) {
    S0[i] = acc
    acc *= Math.pow(rho[i], cover[i])
  }
  const wTotal = dtH < LEARNED_HORIZON_H ? acc : 0
  acc = 1
  for (let i = n - 1; i >= 0; i--) {
    S[i] = acc * Math.pow(rho[i], cover[i] / 2)
    acc *= Math.pow(rho[i], cover[i])
  }
  return { n, keys, cover, S0, S, wTotal }
}

/** Expected rebalancing effect (bikes) for one config. */
function expectedEffect(cfg, path, tbl, sz, L, cond) {
  if (!tbl) return 0
  const su = cfg.size === 'mean' ? sz.upMean : sz.upMed
  const sd = cfg.size === 'mean' ? sz.downMean : sz.downMed
  let ev = 0
  let pNoUp = 1
  let pNoDown = 1
  let upS = 0
  let upP = 0
  let downS = 0
  let downP = 0
  for (let i = 0; i < path.n; i++) {
    const cell = tbl[path.keys[i]]
    if (!cell) continue
    let pu = cell[0]
    let pd = cell[1]
    if (cfg.cond) {
      const s0 = path.S0[i]
      pu = Math.min(1, pu * (1 + (cond.boostUp[L] - 1) * s0))
      pd = Math.min(1, pd * (1 + (cond.boostDown[L] - 1) * s0))
    }
    const c = path.cover[i]
    const scale = cfg.scale === 'raw' ? 1 : cfg.scale === 'surv' ? path.S[i] : path.wTotal
    if (cfg.mode === 'ev') {
      ev += c * (pu * su - pd * sd) * scale
    } else {
      pNoUp *= 1 - pu * c
      pNoDown *= 1 - pd * c
      upS += pu * c * scale
      upP += pu * c
      downS += pd * c * scale
      downP += pd * c
    }
  }
  if (cfg.mode === 'med') {
    const PU = 1 - pNoUp
    const PD = 1 - pNoDown
    if (PU > 0.5 && PU >= PD) ev = su * (upP ? upS / upP : 0)
    else if (PD > 0.5 && PD > PU) ev = -sd * (downP ? downS / downP : 0)
  }
  return ev
}

/** Is rebalancing predictable by hour? Jumps in the test window vs the
 *  learned per-bucket probabilities. */
function jumpPredictability(testLines, table, shipped, capacities, win) {
  const eps = detectEpisodes(testLines)
  const startMs = luxMidnightMs(win.from)
  const endMs = luxMidnightMs(win.to) + 24 * 3600_000
  const thresholds = [0.15, 0.2, 0.3, 0.5]
  const dirs = { up: { total: 0, above: Object.fromEntries(thresholds.map((t) => [t, 0])), inShipped: 0, sizes: [] }, down: { total: 0, above: Object.fromEntries(thresholds.map((t) => [t, 0])), inShipped: 0, sizes: [] } }
  for (const [id, e] of eps) {
    for (const dir of ['up', 'down']) {
      for (const ev of e[dir]) {
        if (ev.t < startMs || ev.t >= endMs) continue
        const key = bucketKey(ev.t)
        const p = table[id]?.[key]?.[dir === 'up' ? 0 : 1] ?? 0
        const D = dirs[dir]
        D.total++
        for (const th of thresholds) if (p >= th) D.above[th]++
        if (shipped?.[id]?.[key]) D.inShipped++
        D.sizes.push(ev.size)
      }
    }
  }
  // station-hour base rates: how often does an up/down jump happen in a
  // station-hour whose learned p is ≥0.2 vs below
  const sh = { up: { high: { n: 0, hit: 0 }, low: { n: 0, hit: 0 } }, down: { high: { n: 0, hit: 0 }, low: { n: 0, hit: 0 } } }
  const days = []
  for (let d = startMs; d < endMs; d += 24 * 3600_000) days.push(new Date(d).toISOString().slice(0, 10))
  const ids = Object.keys(capacities)
  for (let ms = startMs; ms < endMs; ms += 3600_000) {
    const key = bucketKey(ms)
    for (const id of ids) {
      const cell = table[id]?.[key]
      const e = eps.get(id)
      for (const dir of ['up', 'down']) {
        const p = cell?.[dir === 'up' ? 0 : 1] ?? 0
        const g = sh[dir][p >= 0.2 ? 'high' : 'low']
        g.n++
        if (e && countIn(dir === 'up' ? e.upT : e.downT, ms - 1, ms + 3600_000 - 1) > 0) g.hit++
      }
    }
  }
  const fmt = (D) => ({
    jumps: D.total,
    meanSize: D.total ? +(D.sizes.reduce((s, v) => s + v, 0) / D.total).toFixed(2) : null,
    shareInBucketsWithP: Object.fromEntries(thresholds.map((t) => [`>=${t}`, D.total ? +(D.above[t] / D.total).toFixed(3) : null])),
    shareInShippedProfileBuckets: D.total ? +(D.inShipped / D.total).toFixed(3) : null,
  })
  const rates = (dir) => ({
    stationHoursWithP20: sh[dir].high.n,
    shareOfStationHoursWithP20: +(sh[dir].high.n / (sh[dir].high.n + sh[dir].low.n)).toFixed(3),
    pJumpGivenP20: sh[dir].high.n ? +(sh[dir].high.hit / sh[dir].high.n).toFixed(3) : null,
    pJumpGivenBelow: sh[dir].low.n ? +(sh[dir].low.hit / sh[dir].low.n).toFixed(3) : null,
  })
  return { days: days.length, up: { ...fmt(dirs.up), ...rates('up') }, down: { ...fmt(dirs.down), ...rates('down') } }
}

async function main() {
  const t0 = Date.now()
  const capacities = await loadCapacities()
  const lines = await loadSnapshotLines()
  const events = await loadEventCalendar()
  console.error(`loaded ${lines.length} snapshots in ${((Date.now() - t0) / 1000).toFixed(0)} s (${lines[0].t} → ${lines.at(-1).t})`)

  const report = { experiment: 'rebalance-ev', generatedAt: new Date().toISOString(), configs: CONFIGS, windows: [] }

  for (const win of WINDOWS) {
    const tw = Date.now()
    const startMs = luxMidnightMs(win.from)
    const endMs = luxMidnightMs(win.to) + 24 * 3600_000
    const stepMs = win.stepMin * 60_000
    const trainLines = lines.filter((l) => Date.parse(l.t) < startMs)
    const testLines = lines.filter((l) => {
      const t = Date.parse(l.t)
      return t >= startMs && t < endMs
    })
    console.error(`\n== window ${win.name}: ${testLines.length} test snapshots, ${trainLines.length} training (last ${trainLines.at(-1)?.t})`)
    if (testLines.length < 10) throw new Error('window not covered')
    const profiles = buildProfiles(trainLines, capacities, events)
    const { table, cells, obsDays } = learnRebalanceTable(trainLines)
    const episodes = detectEpisodes(trainLines)
    const sizes = learnSizes(episodes, capacities)
    const cond = learnConditional(trainLines, episodes)
    const shippedCells = Object.values(profiles.rebalance ?? {}).reduce((s, o) => s + Object.keys(o).length, 0)
    console.error(
      `   rebalance table: ${cells} station-bucket cells with ≥1 jump (shipped profile keeps ${shippedCells}); ` +
        `episodes up ${sizes.global.nUp} (mean ${sizes.global.upMean.toFixed(2)}, median ${sizes.global.upMed}), ` +
        `down ${sizes.global.nDown} (mean ${sizes.global.downMean.toFixed(2)}, median ${sizes.global.downMed}); learned in ${((Date.now() - tw) / 1000).toFixed(0)} s`
    )
    console.error(`   boost up by level: ${JSON.stringify(cond.boostUp)}  boost down: ${JSON.stringify(cond.boostDown)}`)
    console.error(`   P(refill within h | live<=2) vs all: ` + HORIZONS_H.map((h) => `${h}h ${cond.probs['low(<=2)'][`${h}h`].pUp} vs ${cond.probs.all[`${h}h`].pUp}`).join(' | '))

    const jp = jumpPredictability(testLines, table, profiles.rebalance, capacities, win)
    console.error(`   test-window jumps: up ${jp.up.jumps} (share in buckets with pUp>=0.2: ${jp.up.shareInBucketsWithP['>=0.2']}, P(jump|p>=0.2)=${jp.up.pJumpGivenP20} vs ${jp.up.pJumpGivenBelow}), down ${jp.down.jumps} (share pDown>=0.2: ${jp.down.shareInBucketsWithP['>=0.2']}, P(jump|p>=0.2)=${jp.down.pJumpGivenP20} vs ${jp.down.pJumpGivenBelow})`)

    const wres = {
      ...win,
      trainSnapshots: trainLines.length,
      testSnapshots: testLines.length,
      learned: {
        tableCells: cells,
        shippedCells,
        observedDaysPerBucket: obsDays,
        sizes: { global: sizes.global, shrinkK: SIZE_SHRINK_K },
        conditional: cond,
      },
      jumpPredictability: jp,
      horizons: {},
    }

    // visits (5-min ≥5 jumps) around the test window, to attribute the
    // horizon "jump" samples (|Δ| ≥ 4 between origin and target) to trucks
    const testEps = detectEpisodes(
      lines.filter((l) => {
        const t = Date.parse(l.t)
        return t >= startMs - 25 * 3600_000 && t < endMs
      })
    )

    for (const h of HORIZONS_H) {
      const hMs = h * 3600_000
      const base = newGroup()
      const per = new Map(CONFIGS.map((c) => [c.name, newGroup()]))
      const attr = { jumpN: 0, jumpWithVisit: 0, absTotal: 0, absJumpWithVisit: 0, absJumpNoVisit: 0 }
      for (let t = startMs; t < endMs; t += stepMs) {
        const actualLine = nearestLine(testLines, t)
        const baseLine = nearestLine(lines, t - hMs)
        if (!actualLine || !baseLine) continue
        const targetDate = new Date(Date.parse(actualLine.t))
        const baseDate = new Date(Date.parse(baseLine.t))
        const dtH = (targetDate.getTime() - baseDate.getTime()) / 3.6e6
        const path = hourPath(profiles, baseDate.getTime(), dtH)
        const globalLiveMean = liveGlobalMean(baseLine, capacities)
        for (const [id, [actual]] of Object.entries(actualLine.s)) {
          const cap = capacities[id]?.capacity
          const b = baseLine.s[id]
          if (!cap || !b) continue
          const live = b[0]
          const st = { id, capacity: cap, bikes: live, lat: capacities[id].lat, lon: capacities[id].lon }
          const p = predict(st, targetDate, { now: baseDate, profiles, globalLiveMean, events })
          const err = p.bikes - actual
          const errP = live - actual
          const lv = reportLevelOf(live)
          const isJump = Math.abs(actual - live) >= JUMP
          base.all.add(err, errP)
          base.byLevel[lv].add(err, errP)
          ;(isJump ? base.jump : base.calm).add(err, errP)
          attr.absTotal += Math.abs(err)
          if (isJump) {
            attr.jumpN++
            const e = testEps.get(id)
            const bMs = baseDate.getTime()
            const tMs = targetDate.getTime()
            const visit = !!e && countIn(e.upT, bMs, tMs) + countIn(e.downT, bMs, tMs) > 0
            if (visit) {
              attr.jumpWithVisit++
              attr.absJumpWithVisit += Math.abs(err)
            } else attr.absJumpNoVisit += Math.abs(err)
          }
          const L = levelOf(live)
          const sz = sizes.stations[id]
          for (const cfg of CONFIGS) {
            const tbl = cfg.table === 'full' ? table[id] : profiles.rebalance?.[id]
            const ev = expectedEffect(cfg, path, tbl, sz, L, cond)
            const bikesV = Math.max(0, Math.min(cap, Math.round(p.frac * cap + ev)))
            const e = bikesV - actual
            const g = per.get(cfg.name)
            const changed = bikesV !== p.bikes
            g.all.add(e, errP, changed)
            g.byLevel[lv].add(e, errP, changed)
            ;(isJump ? g.jump : g.calm).add(e, errP, changed)
          }
        }
      }
      wres.horizons[`${h}h`] = {
        baseline: groupOut(base),
        jumpAttribution: {
          jumpSamples: attr.jumpN,
          shareWithTruckVisit: attr.jumpN ? +(attr.jumpWithVisit / attr.jumpN).toFixed(3) : null,
          absErrorShareJumpsWithVisit: attr.absTotal ? +(attr.absJumpWithVisit / attr.absTotal).toFixed(3) : null,
          absErrorShareJumpsWithoutVisit: attr.absTotal ? +(attr.absJumpNoVisit / attr.absTotal).toFixed(3) : null,
        },
        configs: Object.fromEntries([...per].map(([name, g]) => [name, groupOut(g)])),
      }
      console.error(
        `   ${h}h: ${attr.jumpN} jump samples, ${((100 * attr.jumpWithVisit) / Math.max(1, attr.jumpN)).toFixed(0)} % contain a detected truck visit; ` +
          `abs-error share: jumps-with-visit ${((100 * attr.absJumpWithVisit) / attr.absTotal).toFixed(0)} %, jumps-without-visit ${((100 * attr.absJumpNoVisit) / attr.absTotal).toFixed(0)} %`
      )
    }
    report.windows.push(wres)
    console.error(`   evaluated in ${((Date.now() - tw) / 1000).toFixed(0)} s`)
  }

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT, JSON.stringify(report, null, 1))

  // ---- console summary ----
  const f = (v) => (v == null ? '—' : String(v))
  for (const w of report.windows) {
    console.log(`\n==== ${w.name} (step ${w.stepMin} min; train ${w.trainSnapshots}, test ${w.testSnapshots})`)
    for (const h of HORIZONS_H) {
      const H = w.horizons[`${h}h`]
      const b = H.baseline
      console.log(`\n-- ${h}h  n=${b.n}  baseline MAE ${b.mae}  persist ${b.persistMae}  bias ${b.bias}  | MAE@0 ${b.byLevel['0'].mae} (n=${b.byLevel['0'].n}) MAE@1-2 ${b.byLevel['1-2'].mae} (n=${b.byLevel['1-2'].n}) | jump MAE ${b.jump.mae} (n=${b.jump.n}) calm ${b.calm.mae}`)
      console.log('   config                     MAE     ΔMAE    bias    MAE@0   bias@0  MAE@1-2 bias@1-2 jumpMAE calmMAE changed')
      for (const cfg of CONFIGS) {
        const r = H.configs[cfg.name]
        const d = +(r.mae - b.mae).toFixed(3)
        console.log(
          `   ${cfg.name.padEnd(26)} ${f(r.mae).padEnd(7)} ${(d > 0 ? '+' : '') + f(d).padEnd(7)} ${f(r.bias).padEnd(7)} ${f(r.byLevel['0'].mae).padEnd(7)} ${f(r.byLevel['0'].bias).padEnd(7)} ${f(r.byLevel['1-2'].mae).padEnd(7)} ${f(r.byLevel['1-2'].bias).padEnd(8)} ${f(r.jump.mae).padEnd(7)} ${f(r.calm.mae).padEnd(7)} ${f(r.changedShare)}`
        )
      }
    }
  }
  console.log(`\n→ ${OUT}  (${((Date.now() - t0) / 1000).toFixed(0)} s total)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
