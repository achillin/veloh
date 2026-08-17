import { describe, it, expect } from 'vitest'
import { haversineM, nearestWithBikes, routePointAtTime } from '../src/lib/routing.js'

describe('routePointAtTime', () => {
  // straight north line, ~2 km, "ridden" in 600 s
  const geometry = {
    type: 'LineString',
    coordinates: [
      [6.13, 49.6],
      [6.13, 49.609],
      [6.13, 49.618],
    ],
  }

  it('interpolates linearly along the line by time fraction', () => {
    const mid = routePointAtTime(geometry, 600, 300)
    expect(mid.lat).toBeCloseTo(49.609, 3)
    expect(mid.lon).toBeCloseTo(6.13, 6)
  })

  it('clamps to the endpoints', () => {
    expect(routePointAtTime(geometry, 600, 0).lat).toBeCloseTo(49.6, 6)
    expect(routePointAtTime(geometry, 600, 9999).lat).toBeCloseTo(49.618, 6)
  })

  it('handles degenerate input', () => {
    expect(routePointAtTime(null, 600, 100)).toBeNull()
    expect(routePointAtTime(geometry, 0, 100)).toBeNull()
  })
})

describe('haversineM', () => {
  it('measures ~1 km for 0.009° of latitude', () => {
    const d = haversineM({ lat: 49.6, lon: 6.13 }, { lat: 49.609, lon: 6.13 })
    expect(d).toBeGreaterThan(980)
    expect(d).toBeLessThan(1020)
  })

  it('is zero for identical points', () => {
    expect(haversineM({ lat: 49.6, lon: 6.13 }, { lat: 49.6, lon: 6.13 })).toBe(0)
  })
})

describe('nearestWithBikes', () => {
  const pos = { lat: 49.6, lon: 6.13 }
  const mk = (id, dLat, extra = {}) => ({
    id,
    lat: 49.6 + dLat,
    lon: 6.13,
    bikes: 5,
    closed: false,
    ...extra,
  })

  it('picks the closest open station with at least one bike', () => {
    const res = nearestWithBikes([mk('far', 0.02), mk('near', 0.005), mk('mid', 0.01)], pos)
    expect(res.station.id).toBe('near')
    expect(res.distanceM).toBeGreaterThan(500)
    expect(res.distanceM).toBeLessThan(600)
  })

  it('skips empty and closed stations', () => {
    const res = nearestWithBikes(
      [mk('empty', 0.001, { bikes: 0 }), mk('closed', 0.002, { closed: true }), mk('ok', 0.01)],
      pos
    )
    expect(res.station.id).toBe('ok')
  })

  it('returns null when nothing qualifies', () => {
    expect(nearestWithBikes([mk('empty', 0.001, { bikes: 0 })], pos)).toBeNull()
    expect(nearestWithBikes([], pos)).toBeNull()
  })
})
