import { describe, it, expect } from 'vitest'
import { fetchRecentHistory, historyAt } from '../src/lib/history.js'

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

describe('fetchRecentHistory', () => {
  it('asks for the local file once, then goes straight to the repo copy', async () => {
    const calls = []
    const remote = { snapshots: [{ t: '2026-07-13T10:00:00Z', s: { 1: [5, 10] } }] }
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return String(url).includes('raw.githubusercontent.com')
        ? { ok: true, status: 200, headers: new Map(), json: async () => remote }
        : { ok: false, status: 404, headers: new Map() }
    }
    try {
      const first = await fetchRecentHistory()
      const second = await fetchRecentHistory()
      expect(first).toHaveLength(1)
      expect(second[0].s['1'][0]).toBe(5)
      expect(calls.filter((u) => !u.includes('raw.githubusercontent.com'))).toHaveLength(1)
      expect(calls.filter((u) => u.includes('raw.githubusercontent.com'))).toHaveLength(2)
    } finally {
      delete globalThis.fetch
    }
  })
})
