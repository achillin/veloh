import { describe, it, expect } from 'vitest'
import { historyAt } from '../src/lib/history.js'

describe('historyAt', () => {
  const at = (min) => new Date(2026, 6, 13, 12, min)
  const history = [
    { t: at(0), s: { 1: [5, 10] } },
    { t: at(10), s: { 1: [6, 9] } },
    { t: at(20), s: { 1: [7, 8] } },
  ]

  it('returns the snapshot nearest to the target', () => {
    expect(historyAt(history, at(11)).s['1'][0]).toBe(6)
    expect(historyAt(history, at(16)).s['1'][0]).toBe(7)
  })

  it('rejects targets outside the tolerance', () => {
    expect(historyAt(history, at(45))).toBeNull()
    expect(historyAt(history, at(31), 10 * 60_000)).toBeNull()
  })

  it('handles missing history', () => {
    expect(historyAt(null, at(0))).toBeNull()
    expect(historyAt([], at(0))).toBeNull()
  })
})
