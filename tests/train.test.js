import { describe, it, expect } from 'vitest'
import { buildProfiles } from '../model/train.mjs'

const capacities = {
  A: { capacity: 10, lat: 49.61, lon: 6.13 },
  B: { capacity: 20, lat: 49.6, lon: 6.12 },
}

// hourly snapshots from Monday 2026-06-01; station A sits at 2 bikes for two
// weeks, then at 8 for the last one (a regime change); B never moves
function snapshots(days) {
  const t0 = Date.parse('2026-06-01T00:00:30Z')
  return Array.from({ length: days * 24 }, (_, i) => ({
    t: new Date(t0 + i * 3600_000).toISOString(),
    s: { A: [i < 14 * 24 ? 2 : 8, 0], B: [10, 10] },
  }))
}

describe('buildProfiles', () => {
  const out = buildProfiles(snapshots(21), capacities)

  it('emits a blend table with every horizon in every origin bucket', () => {
    expect(out.blend.horizons).toEqual([1, 2, 3, 4, 6, 9, 12, 18, 24, 30, 36, 42, 48])
    // a level that simply persists is best predicted by the live count
    expect(out.blend.global[1]).toBeGreaterThanOrEqual(0.8)
    expect(out.blend.global[24]).toBeGreaterThanOrEqual(0.8)
    for (const row of Object.values(out.blend.byKey)) {
      expect(Object.keys(row).map(Number)).toEqual(out.blend.horizons)
      for (const w of Object.values(row)) expect(w >= 0 && w <= 1).toBe(true)
    }
  })

  it('learns the last week’s residual per station × bucket, shrunk by days', () => {
    // wd-12: 10 weekdays at 0.2 + 5 at 0.8 → mean 0.4, global 0.45,
    // shrunk (15·0.4 + 8·0.45) / 23; residual of the 5 recent days × 5/(5+3)
    const shrunk = (15 * 0.4 + 8 * 0.45) / 23
    expect(out.bias.A['wd-12']).toBeCloseTo((0.8 - shrunk) * (5 / 8), 4)
  })

  it('keeps decay and skips the blend table when there is too little data', () => {
    expect(out.decay).not.toBeNull()
    expect(buildProfiles(snapshots(2), capacities).blend).toBeNull()
  })
})
