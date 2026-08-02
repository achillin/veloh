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
const PERSISTENCE_HOURS = 2.5 // legacy e-folding time, used only without learned decay
const PERSISTENCE_HORIZON_H = 6 // legacy blend horizon
const LEARNED_HORIZON_H = 12 // blend horizon when decay was measured from data
const DECAY_SHRINK_K = 300 // pseudo-pairs pulling a bucket's rho toward the global one
const RAIN_FULL_TRUST_H = 24 // precipitation forecasts carry full weight up to here…
const RAIN_ZERO_TRUST_H = 48 // …then fade linearly to nothing (day-2 skill is marginal)

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
  base = Math.min(Math.max(base + rainAdjustment(profiles, forecast, dtH), 0), 1)

  let frac = base
  const horizon = profiles?.decay ? LEARNED_HORIZON_H : PERSISTENCE_HORIZON_H
  if (dtH < horizon) {
    let w
    const rho0 = bucketRho(profiles, now)
    if (rho0 != null) {
      // the anomaly decays through every hour it traverses — multiply the
      // per-bucket survival rates along the path (night hours barely decay,
      // rush hours decay fast; measured, not assumed)
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
