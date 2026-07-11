// Availability predictor.
//
// Sources, blended by what is available:
//   1. Live snapshot (GBFS) — exact "now", decays over ~6 h (persistence).
//   2. Learned profiles (public/model/profiles.json, built by model/train.mjs
//      from collected snapshots) — mean availability fraction per
//      station × dayType × hour, shrunk toward the system-wide profile.
//   3. Prior — system-wide live mean when nothing has been learned yet.
//
// Fractions are bikes / capacity, clamped to [0, 1].

import { dayType } from './holidays.js'

const SHRINK_K = 8 // pseudo-observations pulling a station toward the global profile
const PERSISTENCE_HOURS = 2.5 // e-folding time of the live-snapshot weight
const PERSISTENCE_HORIZON_H = 6

export async function loadProfiles() {
  try {
    const res = await fetch('/model/profiles.json', { headers: { Accept: 'application/json' } })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null
    const j = await res.json()
    return j && j.stations ? j : null
  } catch {
    return null
  }
}

function profileKey(date) {
  return `${dayType(date)}-${date.getHours()}`
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

function rainAdjustment(profiles, forecast) {
  if (!profiles?.rain || !forecast) return 0
  const wet = (forecast.precip ?? 0) >= 0.2 || (forecast.precipProb ?? 0) >= 60
  return wet ? profiles.rain.delta : 0
}

/**
 * Predict one station's availability at `target`.
 * @returns {{ frac: number, bikes: number, kind: 'live'|'blend'|'learned'|'prior' }}
 */
export function predict(station, target, { now, profiles, globalLiveMean, forecast }) {
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
  base = Math.min(Math.max(base + rainAdjustment(profiles, forecast), 0), 1)

  let frac = base
  if (dtH < PERSISTENCE_HORIZON_H) {
    const w = Math.exp(-dtH / PERSISTENCE_HOURS)
    frac = w * liveFrac + (1 - w) * base
    if (w > 0.35) kind = 'blend'
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
