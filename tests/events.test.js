import { describe, it, expect } from 'vitest'
import { activeEventsAt, eventsNear } from '../src/lib/events.js'

// Luxembourg is UTC+2 in August — test dates are given in UTC.
const cal = [
  {
    id: 'sf-2026',
    name: 'Schueberfouer',
    venue: 'Glacis',
    lat: 49.6183,
    lon: 6.1247,
    from: '2026-08-21',
    to: '2026-09-09',
    hours: [12, 25], // noon to 1 am
    radiusM: 700,
  },
  {
    id: 'md-2026',
    name: 'Daytime market',
    venue: 'Knuedler',
    lat: 49.6106,
    lon: 6.1319,
    from: '2026-08-22',
    to: '2026-08-22',
    hours: [8, 18],
  },
]

describe('activeEventsAt', () => {
  it('is active inside the daily window (Luxembourg local time)', () => {
    // Aug 22, 13:00 local = 11:00 UTC
    const names = activeEventsAt(cal, new Date('2026-08-22T11:00:00Z')).map((e) => e.id)
    expect(names).toContain('sf-2026')
    expect(names).toContain('md-2026')
  })

  it('is inactive before the daily opening', () => {
    // Aug 22, 09:00 local — fair opens at noon
    const names = activeEventsAt(cal, new Date('2026-08-22T07:00:00Z')).map((e) => e.id)
    expect(names).not.toContain('sf-2026')
    expect(names).toContain('md-2026')
  })

  it('stays active past midnight when the window wraps', () => {
    // Aug 23, 00:30 local (= Aug 22 22:30 UTC) — still the Aug 22 session
    const names = activeEventsAt(cal, new Date('2026-08-22T22:30:00Z')).map((e) => e.id)
    expect(names).toContain('sf-2026')
    expect(names).not.toContain('md-2026')
  })

  it('is inactive outside the date span', () => {
    expect(activeEventsAt(cal, new Date('2026-08-20T13:00:00Z'))).toHaveLength(0)
    // the wrap must not leak past the closing day's session
    expect(activeEventsAt(cal, new Date('2026-09-10T12:00:00Z')).map((e) => e.id)).not.toContain('sf-2026')
  })
})

describe('eventsNear', () => {
  const active = activeEventsAt(cal, new Date('2026-08-22T11:00:00Z'))

  it('matches stations inside the effect radius', () => {
    const glacisStation = { lat: 49.618, lon: 6.125 }
    expect(eventsNear(active, glacisStation).map((e) => e.id)).toContain('sf-2026')
  })

  it('ignores stations beyond the radius', () => {
    const gare = { lat: 49.6005, lon: 6.1333 } // ~2 km from the Glacis
    expect(eventsNear(active, gare).map((e) => e.id)).not.toContain('sf-2026')
  })

  it('handles missing coordinates gracefully', () => {
    expect(eventsNear(active, {})).toHaveLength(0)
    expect(eventsNear([], { lat: 49.6, lon: 6.1 })).toHaveLength(0)
  })
})
