import { describe, it, expect } from 'vitest'
import { predict, predictSeries, globalMeanFraction } from '../src/lib/predictor.js'

const now = new Date(2026, 6, 8, 10, 0, 0) // Wednesday 10:00 local
const station = { id: '1', capacity: 20, bikes: 10 }
const baseCtx = { now, profiles: null, globalLiveMean: 0.2 }

const hoursAhead = (h) => new Date(now.getTime() + h * 3.6e6)

describe('predict', () => {
  it('returns the live value at offset 0', () => {
    const p = predict(station, now, baseCtx)
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

  it('applies the rain delta when the forecast is wet', () => {
    const profiles = { global: { 'wd-10': [0.4, 100] }, stations: {}, rain: { delta: -0.1 } }
    const dry = predict(station, hoursAhead(24), { ...baseCtx, profiles, forecast: { precip: 0 } })
    const wet = predict(station, hoursAhead(24), { ...baseCtx, profiles, forecast: { precip: 1 } })
    expect(dry.frac).toBeCloseTo(0.4, 5)
    expect(wet.frac).toBeCloseTo(0.3, 5)
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
