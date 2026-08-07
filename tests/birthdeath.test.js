import { describe, it, expect } from 'vitest'
import { predictDistribution, probAtLeast } from '../src/lib/predictor.js'

const now = new Date(2026, 6, 8, 10, 0, 0) // Wednesday 10:00
const hoursAhead = (h) => new Date(now.getTime() + h * 3.6e6)

// same (λ, μ) in every bucket so multi-hour paths are covered
const flowsEverywhere = (lam, mu) => ({
  global: {},
  stations: {},
  flows: {
    global: Object.fromEntries(
      ['wd', 'sat', 'sun'].flatMap((d) =>
        Array.from({ length: 24 }, (_, h) => [`${d}-${h}`, [lam, mu, 10000]])
      )
    ),
    stations: {},
  },
})

const station = { id: '1', capacity: 10, bikes: 5 }
const ev = (p) => p.reduce((s, v, i) => s + v * i, 0)

describe('predictDistribution', () => {
  it('conserves probability mass and stays non-negative', () => {
    const p = predictDistribution(station, hoursAhead(3), { now, profiles: flowsEverywhere(2, 3) })
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    expect(p.every((v) => v >= -1e-12)).toBe(true)
    expect(p).toHaveLength(11)
  })

  it('drifts down under rentals only and builds mass at the empty wall', () => {
    const p = predictDistribution(station, hoursAhead(2), { now, profiles: flowsEverywhere(0, 3) })
    expect(ev(p)).toBeLessThan(5)
    expect(p[0]).toBeGreaterThan(0.1) // can go empty…
    expect(probAtLeast(p, 6)).toBeLessThan(1e-9) // …but never gain bikes
  })

  it('saturates at capacity under returns only', () => {
    const p = predictDistribution(station, hoursAhead(12), { now, profiles: flowsEverywhere(3, 0) })
    expect(probAtLeast(p, 10)).toBeGreaterThan(0.9)
    expect(ev(p)).toBeLessThanOrEqual(10 + 1e-9)
  })

  it('keeps the mean put when flows balance', () => {
    const p = predictDistribution(station, hoursAhead(1), { now, profiles: flowsEverywhere(2, 2) })
    expect(ev(p)).toBeCloseTo(5, 1)
  })

  it('returns null without flow data or for past targets', () => {
    expect(predictDistribution(station, hoursAhead(2), { now, profiles: { global: {} } })).toBeNull()
    expect(predictDistribution(station, hoursAhead(-1), { now, profiles: flowsEverywhere(1, 1) })).toBeNull()
  })

  it('probAtLeast is monotone in k', () => {
    const p = predictDistribution(station, hoursAhead(4), { now, profiles: flowsEverywhere(2, 3) })
    expect(probAtLeast(p, 1)).toBeGreaterThanOrEqual(probAtLeast(p, 3))
    expect(probAtLeast(p, 0)).toBeCloseTo(1, 6)
  })
})
