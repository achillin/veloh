import { describe, it, expect } from 'vitest'
import { predict, predictDistribution, predictSeries, globalMeanFraction } from '../src/lib/predictor.js'

// Wednesday 10:00 in Luxembourg (CEST) — a fixed instant, because profile
// buckets are Luxembourg hours whatever zone the tests run in (CI is UTC)
const now = new Date('2026-07-08T08:00:00Z')
const station = { id: '1', capacity: 20, bikes: 10 }
const baseCtx = { now, profiles: null, globalLiveMean: 0.2 }

const hoursAhead = (h) => new Date(now.getTime() + h * 3.6e6)

describe('predict', () => {
  it('returns the live value at offset 0', () => {
    const p = predict(station, now, baseCtx)
    expect(p).toEqual({ frac: 0.5, bikes: 10, kind: 'live' })
  })

  it('treats past targets as live (radar-history scrubbing)', () => {
    const p = predict(station, hoursAhead(-1.5), baseCtx)
    expect(p).toEqual({ frac: 0.5, bikes: 10, kind: 'live' })
  })

  it('clamps live fraction when bikes exceed capacity', () => {
    const p = predict({ id: '1', capacity: 10, bikes: 15 }, now, baseCtx)
    expect(p.frac).toBe(1)
  })

  it('falls back to the global live mean far in the future without a model', () => {
    const p = predict(station, hoursAhead(48), baseCtx)
    expect(p.frac).toBeCloseTo(0.2, 5)
    expect(p.bikes).toBe(4)
    expect(p.kind).toBe('prior')
  })

  it('blends live level with the base within the persistence horizon', () => {
    const p = predict(station, hoursAhead(1), baseCtx)
    const w = Math.exp(-1 / 2.5)
    expect(p.frac).toBeCloseTo(w * 0.5 + (1 - w) * 0.2, 5)
    expect(p.kind).toBe('blend')
  })

  it('uses learned station profiles shrunk toward the global profile', () => {
    // Thursday 10:00 → key 'wd-10'
    const profiles = {
      global: { 'wd-10': [0.2, 100] },
      stations: { 1: { 'wd-10': [0.8, 92] } },
    }
    const p = predict(station, hoursAhead(24), { ...baseCtx, profiles })
    expect(p.frac).toBeCloseTo((92 * 0.8 + 8 * 0.2) / 100, 5)
    expect(p.kind).toBe('learned') // n = 92 ≥ 20
  })

  it('treats sparse station buckets as prior-quality', () => {
    const profiles = {
      global: { 'wd-10': [0.3, 500] },
      stations: { 1: { 'wd-10': [0.9, 3] } },
    }
    const p = predict(station, hoursAhead(24), { ...baseCtx, profiles })
    expect(p.kind).toBe('prior')
  })

  it('uses the learned per-bucket decay when the model provides one', () => {
    const profiles = {
      global: { 'wd-11': [0.2, 100] },
      stations: {},
      decay: { global: [0.8, 100000], byKey: {} },
    }
    const p = predict(station, hoursAhead(1), { ...baseCtx, profiles })
    // survival w = 0.8 over one hour → 0.8·live + 0.2·base
    expect(p.frac).toBeCloseTo(0.8 * 0.5 + 0.2 * 0.2, 5)
    expect(p.kind).toBe('blend')
  })

  it('shrinks a sparse bucket rho toward the global one', () => {
    const profiles = {
      global: { 'wd-11': [0.2, 100] },
      stations: {},
      // bucket says 0.99 but only from 100 pairs; global 0.5 from many
      decay: { global: [0.5, 100000], byKey: { 'wd-10': [0.99, 100] } },
    }
    const p = predict(station, hoursAhead(1), { ...baseCtx, profiles })
    const rho = (100 * 0.99 + 300 * 0.5) / 400
    expect(p.frac).toBeCloseTo(rho * 0.5 + (1 - rho) * 0.2, 5)
  })

  it('tapers the rain delta between 24 h and 48 h ahead', () => {
    const profiles = { global: { 'wd-16': [0.4, 100] }, stations: {}, rain: { delta: -0.1 } }
    // +30 h: trust = (48-30)/24 = 0.75 → delta scaled to -0.075
    const p30 = predict(station, hoursAhead(30), { ...baseCtx, profiles, forecast: { precip: 5 } })
    expect(p30.frac).toBeCloseTo(0.4 - 0.075, 5)
  })

  it('ignores the rain delta entirely from 48 h ahead', () => {
    const profiles = { global: { 'sat-10': [0.4, 100] }, stations: {}, rain: { delta: -0.1 } }
    // Wednesday 10:00 + 72 h = Saturday 10:00
    const p = predict(station, hoursAhead(72), { ...baseCtx, profiles, forecast: { precip: 5 } })
    expect(p.frac).toBeCloseTo(0.4, 5)
  })

  it('applies the rain delta when the forecast is wet', () => {
    const profiles = { global: { 'wd-10': [0.4, 100] }, stations: {}, rain: { delta: -0.1 } }
    const dry = predict(station, hoursAhead(24), { ...baseCtx, profiles, forecast: { precip: 0 } })
    const wet = predict(station, hoursAhead(24), { ...baseCtx, profiles, forecast: { precip: 1 } })
    expect(dry.frac).toBeCloseTo(0.4, 5)
    expect(wet.frac).toBeCloseTo(0.3, 5)
  })
})

// the same profile fraction (0.2) in every bucket, so only the weight varies
const flatProfile = Object.fromEntries(
  ['wd', 'sat', 'sun'].flatMap((d) => Array.from({ length: 24 }, (_, h) => [`${d}-${h}`, [0.2, 100]]))
)
const blend = {
  horizons: [1, 2, 3, 4, 6, 9, 12, 18, 24],
  global: { 1: 0.9, 2: 0.8, 3: 0.7, 4: 0.6, 6: 0.4, 9: 0.2, 12: 0.1, 18: 0.1, 24: 0.3 },
  // row of the forecast ORIGIN bucket (now = Wednesday 10:00)
  byKey: { 'wd-10': { 1: 0.8, 2: 0.6, 3: 0.5, 4: 0.4, 6: 0.3, 9: 0.2, 12: 0.1, 18: 0, 24: 0.2 } },
}
const mix = (w, base = 0.2) => w * 0.5 + (1 - w) * base // live fraction is 10/20

describe('predict with a learned blend table', () => {
  const profiles = {
    global: flatProfile,
    stations: {},
    decay: { global: [0.5, 100000], byKey: {} }, // must be ignored once a table exists
    blend,
  }
  const at = (h, ctx = {}) => predict(station, new Date((ctx.now ?? now).getTime() + h * 3.6e6), { ...baseCtx, profiles, ...ctx })

  it('takes the weight of the origin bucket at a fitted horizon', () => {
    const p = at(1)
    expect(p.frac).toBeCloseTo(mix(0.8), 5)
    expect(p.kind).toBe('blend')
  })

  it('interpolates linearly between horizons, from an implicit (0 h, 1) knot', () => {
    expect(at(0.5).frac).toBeCloseTo(mix(0.9), 5) // halfway 1 → 0.8
    expect(at(5).frac).toBeCloseTo(mix(0.35), 5) // halfway 0.4 → 0.3
    expect(at(21).frac).toBeCloseTo(mix(0.1), 5) // halfway 0 → 0.2
  })

  it('falls back to the global row for an origin bucket without one', () => {
    const later = new Date(now.getTime() + 3.6e6) // 11:00 → no 'wd-11' row
    expect(at(1, { now: later }).frac).toBeCloseTo(mix(0.9), 5)
    expect(at(5, { now: later }).frac).toBeCloseTo(mix(0.5), 5)
  })

  it('fades the weight out over 6 h past the last fitted horizon instead of holding it', () => {
    expect(at(24).frac).toBeCloseTo(mix(0.2), 5)
    expect(at(27).frac).toBeCloseTo(mix(0.1), 5)
    expect(at(30).frac).toBeCloseTo(0.2, 5)
    expect(at(36).frac).toBeCloseTo(0.2, 5)
    expect(at(60).frac).toBeCloseTo(0.2, 5)
  })

  it('follows a table fitted out to 48 h all the way', () => {
    const long = {
      horizons: [...blend.horizons, 30, 36, 42, 48],
      global: { ...blend.global, 30: 0.1, 36: 0.05, 42: 0.05, 48: 0.15 },
      byKey: {},
    }
    const p = (h) => predict(station, hoursAhead(h), { ...baseCtx, profiles: { ...profiles, blend: long } })
    expect(p(36).frac).toBeCloseTo(mix(0.05), 5)
    expect(p(45).frac).toBeCloseTo(mix(0.1), 5) // halfway 0.05 → 0.15
    expect(p(48).frac).toBeCloseTo(0.2, 5) // the blend horizon: pure profile from here
  })

  it('ignores a malformed table and keeps the rho path', () => {
    const broken = { ...profiles, blend: { global: { 1: 0.9 } } } // no horizons
    expect(predict(station, hoursAhead(2), { ...baseCtx, profiles: broken }).frac).toBeCloseTo(mix(0.5 ** 2), 5)
  })

  it('labels next-day forecasts by their profile even when the table weight bumps up', () => {
    const bumpy = { ...blend, byKey: { 'wd-10': { ...blend.byKey['wd-10'], 24: 0.45 } } }
    const p = predict(station, hoursAhead(24), { ...baseCtx, profiles: { ...profiles, blend: bumpy } })
    expect(p.frac).toBeCloseTo(mix(0.45), 5)
    expect(p.kind).toBe('prior')
  })

  it('reports blend only while the live weight is substantial', () => {
    expect(at(4).kind).toBe('blend') // w = 0.4
    expect(at(9).kind).toBe('prior') // w = 0.2; only the global profile knows this bucket
  })

  it('keeps the rho path-product for profiles without a table', () => {
    const old = { ...profiles, blend: undefined }
    const p2 = predict(station, hoursAhead(2), { ...baseCtx, profiles: old })
    expect(p2.frac).toBeCloseTo(mix(0.5 ** 2), 5)
    // …including its 12 h blend horizon
    const p13 = predict(station, hoursAhead(13), { ...baseCtx, profiles: old })
    expect(p13.frac).toBeCloseTo(0.2, 5)
    expect(at(13).frac).toBeGreaterThan(0.2)
  })
})

describe('predict with a recent per-station bias', () => {
  const profiles = {
    global: { 'wd-10': [0.4, 100], 'wd-11': [0.05, 100] },
    stations: {},
    bias: { 1: { 'wd-10': -0.1, 'wd-11': -0.1 } },
  }

  it('adds the station × bucket cell to the profile base', () => {
    const p = predict(station, hoursAhead(24), { ...baseCtx, profiles })
    expect(p.frac).toBeCloseTo(0.3, 5)
    expect(p.bikes).toBe(6)
  })

  it('leaves other stations alone', () => {
    const p = predict({ ...station, id: '2' }, hoursAhead(24), { ...baseCtx, profiles })
    expect(p.frac).toBeCloseTo(0.4, 5)
  })

  it('clamps the corrected base to [0, 1]', () => {
    const p = predict(station, hoursAhead(25), { ...baseCtx, profiles })
    expect(p.frac).toBe(0)
  })

  it('shifts the base before the live blend', () => {
    const p = predict(station, hoursAhead(24), { ...baseCtx, profiles: { ...profiles, blend } })
    expect(p.frac).toBeCloseTo(mix(0.2, 0.3), 5)
  })
})

describe('predict hybrid point forecast', () => {
  const median = (p) => {
    let cum = 0
    return p.findIndex((v) => (cum += v) >= 0.5)
  }
  // rentals only, 3 bikes/h in every bucket
  const flows = {
    global: Object.fromEntries(Object.keys(flatProfile).map((k) => [k, [0, 3, 10000]])),
    stations: {},
  }
  const profiles = { global: flatProfile, stations: {}, blend, flows }

  it('averages the blend with the birth–death median up to 6 h', () => {
    const target = hoursAhead(2)
    const med = median(predictDistribution(station, target, { now, profiles }))
    expect(med).toBe(4) // 10 bikes − median of Poisson(6) rentals
    const p = predict(station, target, { ...baseCtx, profiles })
    // blend alone: w = 0.6 → 0.38 · 20 = 7.6 bikes; with the median (7.6 + 4) / 2 = 5.8
    expect(p.bikes).toBe(6)
    expect(p.frac).toBeCloseTo(5.8 / 20, 10) // the curve keeps the unrounded value
    expect(Object.keys(p).sort()).toEqual(['bikes', 'frac', 'kind'])
  })

  it('reads the same median from its cached forward pass as a fresh evolution gives', () => {
    // asked out of order on purpose: the pass is extended on demand, never rewound
    for (const h of [3, 0.5, 6, 1, 4.5]) {
      const target = hoursAhead(h)
      const med = median(predictDistribution(station, target, { now, profiles }))
      const blendOnly = predict(station, target, { ...baseCtx, profiles: { ...profiles, flows: null } })
      const p = predict(station, target, { ...baseCtx, profiles })
      expect(p.frac).toBeCloseTo((blendOnly.frac * 20 + med) / 2 / 20, 10)
    }
  })

  it('keeps separate passes for different live counts and origins', () => {
    const fuller = { ...station, bikes: 18 }
    const a = predict(fuller, hoursAhead(1), { ...baseCtx, profiles })
    const b = predict(station, hoursAhead(1), { ...baseCtx, profiles })
    expect(a.bikes).toBeGreaterThan(b.bikes)
  })

  it('stays put when the flow model expects no movement', () => {
    const still = { ...profiles, flows: { global: {}, stations: {} } }
    const p = predict(station, hoursAhead(2), { ...baseCtx, profiles: still })
    expect(p.bikes).toBe(9) // (7.6 + 10) / 2 = 8.8
    expect(p.frac).toBeCloseTo(0.44, 10)
  })

  it('applies in full at 6 h, then tapers the median share out by ~9 h', () => {
    const p6 = predict(station, hoursAhead(6), { ...baseCtx, profiles })
    expect(p6.bikes).toBe(3) // blend 0.29 · 20 = 5.8, median 0
    // 7 h: share 0.5 · (9.25 − 7) / 3 = 0.375 of a median of 0
    const p7 = predict(station, hoursAhead(7), { ...baseCtx, profiles })
    expect(p7.frac).toBeCloseTo(0.625 * mix(0.3 - 0.1 / 3), 5)
    expect(p7.bikes).toBe(Math.round(p7.frac * 20))
    const p10 = predict(station, hoursAhead(10), { ...baseCtx, profiles })
    expect(p10.frac).toBeCloseTo(mix(0.2 - 0.1 / 3), 5) // the blend alone
  })

  it('needs flow data', () => {
    const p = predict(station, hoursAhead(2), { ...baseCtx, profiles: { ...profiles, flows: null } })
    expect(p.frac).toBeCloseTo(mix(0.6), 5)
    expect(p.bikes).toBe(8)
  })

  it('also applies on top of the rho fallback', () => {
    const old = { global: flatProfile, stations: {}, decay: { global: [0.5, 100000], byKey: {} }, flows }
    const p = predict(station, hoursAhead(2), { ...baseCtx, profiles: old })
    // blend alone: w = 0.25 → 0.275 · 20 = 5.5 bikes; (5.5 + 4) / 2 = 4.75
    expect(p.bikes).toBe(5)
  })
})

describe('predictSeries', () => {
  it('produces hours+1 points starting live', () => {
    const s = predictSeries(station, 24, baseCtx, () => null)
    expect(s).toHaveLength(25)
    expect(s[0].kind).toBe('live')
    expect(s.at(-1).t.getTime()).toBe(hoursAhead(24).getTime())
  })
})

describe('globalMeanFraction', () => {
  it('averages bike fractions, ignoring zero-capacity stations', () => {
    const v = globalMeanFraction([
      { capacity: 10, bikes: 5 },
      { capacity: 20, bikes: 20 },
      { capacity: 0, bikes: 3 },
    ])
    expect(v).toBeCloseTo(0.75, 5)
  })

  it('defaults to 0.5 with no usable stations', () => {
    expect(globalMeanFraction([])).toBe(0.5)
  })
})
