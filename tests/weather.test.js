import { describe, it, expect } from 'vitest'
import { describeWmo, forecastAt } from '../src/lib/weather.js'

describe('describeWmo', () => {
  it('maps WMO codes to icon + label', () => {
    expect(describeWmo(0)).toEqual({ icon: '☀️', label: 'Clear' })
    expect(describeWmo(3)).toEqual({ icon: '☁️', label: 'Overcast' })
    expect(describeWmo(61).label).toBe('Rain')
    expect(describeWmo(75).label).toBe('Snow')
    expect(describeWmo(95).label).toBe('Thunderstorm')
  })

  it('falls back gracefully on unknown codes', () => {
    expect(describeWmo(42).label).toBe('—')
  })
})

describe('forecastAt', () => {
  const T = (h, m = 0) => new Date(2026, 6, 12, h, m)
  const weather = {
    hourly: [
      { time: T(10), temp: 20 },
      { time: T(11), temp: 22 },
    ],
  }

  it('returns the closest hourly entry', () => {
    expect(forecastAt(weather, T(10, 20)).temp).toBe(20)
    expect(forecastAt(weather, T(10, 40)).temp).toBe(22)
  })

  it('returns null outside the 45-minute window', () => {
    expect(forecastAt(weather, T(13))).toBeNull()
    expect(forecastAt(null, T(10))).toBeNull()
  })
})
