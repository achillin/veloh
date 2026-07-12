import { describe, it, expect } from 'vitest'
import { parseRaintext, summarizeNowcast } from '../src/lib/radar.js'

const now = new Date(2026, 6, 12, 16, 40, 0)

describe('parseRaintext', () => {
  it('parses value|HH:MM lines into times and mm/h', () => {
    const pts = parseRaintext('000|16:45\n128|16:50\n', now)
    expect(pts).toHaveLength(2)
    expect(pts[0].mmh).toBe(0)
    expect(pts[0].time.getHours()).toBe(16)
    expect(pts[0].time.getMinutes()).toBe(45)
    // Buienradar scale: mm/h = 10^((value − 109) / 32)
    expect(pts[1].mmh).toBeCloseTo(Math.pow(10, (128 - 109) / 32), 2)
  })

  it('rolls times past midnight over to the next day', () => {
    const late = new Date(2026, 6, 12, 23, 50, 0)
    const pts = parseRaintext('050|23:55\n060|00:05', late)
    expect(pts[0].time.getDate()).toBe(12)
    expect(pts[1].time.getDate()).toBe(13)
    expect(pts[1].time.getTime()).toBeGreaterThan(pts[0].time.getTime())
  })

  it('skips malformed lines', () => {
    expect(parseRaintext('garbage\n77|xx:yy\n000|17:00', now)).toHaveLength(1)
  })
})

describe('summarizeNowcast', () => {
  const at = (min, mmh) => ({ time: new Date(now.getTime() + min * 60_000), mmh })

  it('reports ongoing rain and when it stops', () => {
    const s = summarizeNowcast([at(0, 1.2), at(5, 0.8), at(10, 0)])
    expect(s.raining).toBe(true)
    expect(s.until).toEqual(at(10, 0).time)
    expect(s.maxMmh).toBe(1.2)
  })

  it('reports upcoming rain start', () => {
    const s = summarizeNowcast([at(0, 0), at(5, 0), at(10, 2.5)])
    expect(s.raining).toBe(false)
    expect(s.startsAt).toEqual(at(10, 2.5).time)
  })

  it('reports a dry window', () => {
    const s = summarizeNowcast([at(0, 0), at(5, 0)])
    expect(s.raining).toBe(false)
    expect(s.startsAt).toBeNull()
    expect(s.maxMmh).toBe(0)
  })

  it('handles empty input', () => {
    expect(summarizeNowcast([])).toBeNull()
    expect(summarizeNowcast(null)).toBeNull()
  })
})
