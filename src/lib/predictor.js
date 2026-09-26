// Availability predictor.
//
// Sources, blended by what is available:
//   1. Live snapshot (GBFS) — exact "now"; its weight follows the learned
//      blend table (calibrated per horizon × origin bucket, out to 48 h).
//   2. Learned profiles (public/model/profiles.json, built by model/train.mjs
//      from collected snapshots) — mean availability fraction per
//      station × dayType × hour, shrunk toward the system-wide profile, plus
//      the station's mean residual of the last week (profiles.bias).
//   3. Prior — system-wide live mean when nothing has been learned yet.
//   4. Up to 6 h ahead, the median of the birth–death distribution (below)
//      is averaged into the point forecast, tapering out by ~9 h.
//
// Fractions are bikes / capacity, clamped to [0, 1].

import { dayType, luxParts } from './holidays.js'
import { activeEventsAt, eventsNear } from './events.js'

const SHRINK_K = 8 // pseudo-observations pulling a station toward the global profile
const PERSISTENCE_HOURS = 2.5 // legacy e-folding time, used only without learned decay
const PERSISTENCE_HORIZON_H = 6 // legacy blend horizon
const LEARNED_HORIZON_H = 12 // blend horizon when decay was measured from data
const DECAY_SHRINK_K = 300 // pseudo-pairs pulling a bucket's rho toward the global one
const BLEND_HORIZON_H = 48 // the blend table is fitted this far; pure profile beyond
const BLEND_TAIL_H = 6 // a table that stops earlier fades out over this long
// up to a nominal 6 h the point forecast averages in the flow-model median
// (the slack keeps a "+6 h" target inside despite minute-level timestamp
// jitter); its share then tapers to nothing by HYBRID_END_H
const HYBRID_FULL_H = 6.25
const HYBRID_END_H = 9.25
const RAIN_FULL_TRUST_H = 24 // precipitation forecasts carry full weight up to here…
const RAIN_ZERO_TRUST_H = 48 // …then fade linearly to nothing (day-2 skill is marginal)

export async function loadProfiles() {
  try {
    // relative to the deploy base so GitHub Pages subpaths work too
    const res = await fetch(`${import.meta.env.BASE_URL}model/profiles.json`, { headers: { Accept: 'application/json' } })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null
    const j = await res.json()
    return j && j.stations ? j : null
  } catch {
    return null
  }
}

/** Profile bucket of an instant: dayType-hour in Luxembourg time (the
 *  zone the profiles were learned in, whatever zone the runtime is in). */
export function profileKey(date) {
  return `${dayType(date)}-${luxParts(date).hour}`
}

function learnedFraction(profiles, stationId, key) {
  const g = profiles?.global?.[key] // [meanFrac, count]
  const s = profiles?.stations?.[stationId]?.[key]
  if (!g && !s) return null
  const gMean = g ? g[0] : s[0]
  if (!s) return { frac: gMean, n: 0 }
  const [sMean, n] = s
  return { frac: (n * sMean + SHRINK_K * gMean) / (n + SHRINK_K), n }
}

function rainAdjustment(profiles, forecast, dtH) {
  if (!profiles?.rain || !forecast) return 0
  const wet = (forecast.precip ?? 0) >= 0.2 || (forecast.precipProb ?? 0) >= 60
  if (!wet) return 0
  const trust =
    dtH <= RAIN_FULL_TRUST_H
      ? 1
      : Math.max(0, (RAIN_ZERO_TRUST_H - dtH) / (RAIN_ZERO_TRUST_H - RAIN_FULL_TRUST_H))
  return profiles.rain.delta * trust
}

const EVENT_DELTA_CAP = 0.35 // events can't swing a forecast past ±35% of capacity
const EVENT_MIN_N = 300 // learned venue deltas need this many station-minutes
// …and count in proportion to their evidence: a venue seen for one evening
// (a few hundred station-minutes) is mostly noise, a whole Schueberfouer is not
const EVENT_SHRINK_N = 3000

/** Learned shift of one venue, shrunk toward zero by how much was observed. */
export function venueDelta(eff) {
  if (!eff || eff[1] < EVENT_MIN_N) return 0
  return (eff[0] * eff[1]) / (eff[1] + EVENT_SHRINK_N)
}

/** Availability shift from learned per-venue event effects, for events
 *  active at the target time within radius of the station. */
function eventAdjustment(profiles, station, target, ctx) {
  const active =
    ctx.activeEvents ?? (ctx.events?.length ? activeEventsAt(ctx.events, target) : null)
  if (!active?.length) return 0
  const near = eventsNear(active, station)
  let delta = 0
  for (const ev of near) delta += venueDelta(profiles?.eventEffects?.[ev.venue])
  return Math.max(-EVENT_DELTA_CAP, Math.min(EVENT_DELTA_CAP, delta))
}

/** Learned lag-1h anomaly survival rate for the bucket containing `date`,
 *  shrunk toward the global rate; null when the model has no decay data. */
function bucketRho(profiles, date) {
  const d = profiles?.decay
  if (!d?.global) return null
  const g = d.global[0]
  const s = d.byKey?.[profileKey(date)]
  const rho = s ? (s[1] * s[0] + DECAY_SHRINK_K * g) / (s[1] + DECAY_SHRINK_K) : g
  return Math.min(Math.max(rho, 0.01), 0.995)
}

/** Calibrated live weight from the learned blend table (MAE-optimal per
 *  horizon, fitted by model/train.mjs up to 48 h): the row of the ORIGIN
 *  bucket, or the global row, linear between the fitted horizons with an
 *  implicit (0 h, 1) knot. Nothing is assumed past the last fitted horizon —
 *  the weight there just fades out (the 24 h bump is a same-hour-next-day
 *  recurrence; holding it further measurably hurt the 30–42 h forecasts). */
function tableWeight(blend, now, dtH) {
  const row = blend.byKey?.[profileKey(now)] ?? blend.global
  let h0 = 0
  let w0 = 1
  for (const h of blend.horizons) {
    const w1 = row[h] ?? blend.global[h]
    if (w1 == null) continue
    if (dtH <= h) return w0 + ((w1 - w0) * (dtH - h0)) / (h - h0)
    h0 = h
    w0 = w1
  }
  return w0 * Math.max(0, 1 - (dtH - h0) / BLEND_TAIL_H)
}

/** Median of a distribution vector: the smallest count with CDF ≥ 0.5. */
function distMedian(p) {
  let cum = 0
  for (let i = 0; i < p.length; i++) {
    cum += p[i]
    if (cum >= 0.5) return i
  }
  return p.length - 1
}

/**
 * Predict one station's availability at `target`.
 * @returns {{ frac: number, bikes: number, kind: 'live'|'blend'|'learned'|'prior' }}
 */
export function predict(station, target, ctx) {
  const { now, profiles, globalLiveMean, forecast } = ctx
  const cap = Math.max(station.capacity, 1)
  const liveFrac = Math.min(station.bikes / cap, 1)
  const dtH = (target.getTime() - now.getTime()) / 3.6e6

  if (dtH <= 0.01) return { frac: liveFrac, bikes: station.bikes, kind: 'live' }

  const key = profileKey(target)
  const learned = learnedFraction(profiles, station.id, key)
  let base
  let kind
  if (learned) {
    base = learned.frac
    kind = learned.n >= 20 ? 'learned' : 'prior'
  } else {
    base = globalLiveMean
    kind = 'prior'
  }
  base = Math.min(
    Math.max(
      base +
        rainAdjustment(profiles, forecast, dtH) +
        eventAdjustment(profiles, station, target, ctx) +
        // recent residual of this station × bucket (last week vs the long profile)
        (profiles?.bias?.[station.id]?.[key] ?? 0),
      0
    ),
    1
  )

  let frac = base
  // anything but a well-formed table falls back to the rho path below
  const b = profiles?.blend
  const blend = b?.global && Array.isArray(b.horizons) && b.horizons.length ? b : null
  const horizon = blend ? BLEND_HORIZON_H : profiles?.decay ? LEARNED_HORIZON_H : PERSISTENCE_HORIZON_H
  if (dtH < horizon) {
    let w
    const rho0 = blend ? null : bucketRho(profiles, now)
    if (blend) {
      w = tableWeight(blend, now, dtH)
    } else if (rho0 != null) {
      // profiles without a blend table: the anomaly decays through every
      // hour it traverses — multiply the per-bucket survival rates along the
      // path (night hours barely decay, rush hours decay fast; measured, not
      // assumed)
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
    // "short-term estimate" is a near-range label: the table's next-day bump
    // can lift w past the threshold again a day out
    if (w > 0.35 && dtH <= LEARNED_HORIZON_H) kind = 'blend'
  }

  // short range: MAE is minimised by a median, and the birth–death model
  // knows the walls at 0 and capacity that the linear blend ignores — average
  // the two point forecasts (50/50 backtested best up to 6 h). The median's
  // share then tapers off instead of stopping dead, so scrubbing across the
  // boundary does not jump the count (and it backtests better at 7–9 h).
  const share =
    dtH <= HYBRID_FULL_H
      ? 0.5
      : dtH < HYBRID_END_H
        ? (0.5 * (HYBRID_END_H - dtH)) / (HYBRID_END_H - HYBRID_FULL_H)
        : 0
  const med = share > 0 ? flowMedianAt(station, dtH, now, profiles) : null
  if (med != null) {
    frac = ((1 - share) * frac * cap + share * med) / cap
    if (kind === 'learned') kind = 'blend' // half of it is seeded by the live count
  }

  return { frac, bikes: Math.round(frac * cap), kind }
}

/** Hourly prediction series for the panel sparkline. */
export function predictSeries(station, hours, ctx, forecastAtFn) {
  const out = []
  for (let h = 0; h <= hours; h++) {
    const t = new Date(ctx.now.getTime() + h * 3.6e6)
    const forecast = forecastAtFn ? forecastAtFn(t) : null
    out.push({ t, ...predict(station, t, { ...ctx, forecast }) })
  }
  return out
}

// ---- birth–death distribution ----
// Evolves the full probability distribution over bike counts from the live
// state to `target`, using learned per-bucket return (λ) and rental (μ)
// rates. Transitions are ±1 with reflecting walls at 0 and capacity, so
// impossible jumps and saturation are handled by construction. Rates are
// per-hour; the evolution steps in 5-minute slices (sub-divided further if
// a slice's total event probability gets close to 1).

const FLOW_SHRINK_N = 120 // pseudo minute-pairs pulling a station toward the global rate

function bucketFlows(profiles, station, date) {
  const f = profiles?.flows
  if (!f?.global) return null
  const key = profileKey(date)
  const g = f.global[key]
  const s = f.stations?.[station.id]?.[key]
  if (!g && !s) return null
  const gl = g ?? [0, 0, 0]
  if (!s) return { lam: gl[0], mu: gl[1] }
  const [sl, sm, n] = s
  return {
    lam: (n * sl + FLOW_SHRINK_N * gl[0]) / (n + FLOW_SHRINK_N),
    mu: (n * sm + FLOW_SHRINK_N * gl[1]) / (n + FLOW_SHRINK_N),
  }
}

const SLICE_H = 1 / 12 // 5 minutes

/** Advances `state` = { p, next } (two buffers that swap roles) by `dt` hours
 *  at the given rates. */
function evolveSlice(state, flows, dt, cap) {
  // sub-divide so per-substep event probabilities stay well below 1
  const sub = Math.max(1, Math.ceil((flows.lam + flows.mu) * dt / 0.25))
  const a = (flows.lam * dt) / sub
  const d = (flows.mu * dt) / sub
  for (let s = 0; s < sub; s++) {
    const { p, next } = state
    next.fill(0)
    for (let i = 0; i <= cap; i++) {
      const pi = p[i]
      if (!pi) continue
      const up = i < cap ? a : 0 // full station: returns bounce away
      const down = i > 0 ? d : 0 // empty station: nothing to rent
      next[i] += pi * (1 - up - down)
      if (up) next[i + 1] += pi * up
      if (down) next[i - 1] += pi * down
    }
    state.p = next
    state.next = p
  }
}

function startState(station, cap) {
  const p = new Float64Array(cap + 1)
  p[Math.min(station.bikes, cap)] = 1
  return { p, next: new Float64Array(cap + 1) }
}

/** Probability vector p[i] = P(i bikes at `target`), or null without flow
 *  data. Only meaningful for future targets. */
export function predictDistribution(station, target, { now, profiles }) {
  if (!profiles?.flows) return null
  const cap = Math.max(station.capacity, 1)
  const totalH = (target.getTime() - now.getTime()) / 3.6e6
  if (totalH <= 0 || totalH > 49) return null
  const state = startState(station, cap)
  for (let elapsed = 0; elapsed < totalH; elapsed += SLICE_H) {
    const dt = Math.min(SLICE_H, totalH - elapsed)
    const flows = bucketFlows(profiles, station, new Date(now.getTime() + elapsed * 3.6e6))
    if (flows) evolveSlice(state, flows, dt, cap)
  }
  return Array.from(state.p)
}

// predict() wants the distribution's median for every station at every scrub
// step inside the hybrid range. Consecutive targets share the whole prefix of
// the evolution, so each (station, live count, origin) keeps one forward pass
// that is extended on demand, with the median remembered per 5-minute slice.
const medianTracks = new WeakMap() // profiles → Map(key → { p, next, medians })
const TRACKS_MAX = 2000

/** Median bike count of the birth–death model `dtH` hours after `now` (to
 *  the nearest 5-minute slice), or null without flow data. */
function flowMedianAt(station, dtH, now, profiles) {
  if (!profiles?.flows) return null
  const cap = Math.max(station.capacity, 1)
  let tracks = medianTracks.get(profiles)
  if (!tracks) medianTracks.set(profiles, (tracks = new Map()))
  const key = `${station.id}|${station.bikes}|${cap}|${now.getTime()}`
  let tr = tracks.get(key)
  if (!tr) {
    if (tracks.size >= TRACKS_MAX) tracks.clear() // origins move on every minute; old ones never come back
    tr = { ...startState(station, cap), medians: [Math.min(station.bikes, cap)] }
    tracks.set(key, tr)
  }
  const idx = Math.max(1, Math.round(dtH / SLICE_H))
  while (tr.medians.length <= idx) {
    const elapsed = (tr.medians.length - 1) * SLICE_H
    const flows = bucketFlows(profiles, station, new Date(now.getTime() + elapsed * 3.6e6))
    if (flows) evolveSlice(tr, flows, SLICE_H, cap)
    tr.medians.push(distMedian(tr.p))
  }
  return tr.medians[idx]
}

/** P(at least k bikes) from a distribution vector. */
export function probAtLeast(p, k) {
  let s = 0
  for (let i = k; i < p.length; i++) s += p[i]
  return Math.min(1, Math.max(0, s))
}

export function globalMeanFraction(stations) {
  if (!stations.length) return 0.5
  let sum = 0
  let n = 0
  for (const s of stations) {
    if (s.capacity > 0) {
      sum += Math.min(s.bikes / s.capacity, 1)
      n++
    }
  }
  return n ? sum / n : 0.5
}
