import { describe, it, expect } from 'vitest'
import { dwdRadarFrames } from '../src/lib/radar.js'

describe('dwdRadarFrames', () => {
  const now = new Date('2026-07-13T17:43:12Z')
  const frames = dwdRadarFrames(now)

  it('spans -2h…+2h around the latest published frame in 5-min steps', () => {
    expect(frames).toHaveLength(49)
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].time.getTime() - frames[i - 1].time.getTime()).toBe(5 * 60_000)
    }
  })

  it('snaps to the 5-minute grid with one step of publish lag', () => {
    // 17:43 → latest published 17:35 → newest measured index 24
    expect(frames[24].time.toISOString()).toBe('2026-07-13T17:35:00.000Z')
    expect(frames[0].time.toISOString()).toBe('2026-07-13T15:35:00.000Z')
    expect(frames.at(-1).time.toISOString()).toBe('2026-07-13T19:35:00.000Z')
  })

  it('flags frames after "now" as nowcast', () => {
    expect(frames[25].nowcast).toBe(false) // 17:40 ≤ now (17:43)
    expect(frames[26].nowcast).toBe(true) // 17:45 > now
    expect(frames.at(-1).nowcast).toBe(true)
  })

  it('builds WMS GetMap templates with the frame time', () => {
    const t = frames[0].template
    expect(t).toContain('maps.dwd.de/geoserver/dwd/wms')
    expect(t).toContain('{bbox-epsg-3857}')
    expect(t).toContain('time=2026-07-13T15:35:00.000Z')
  })
})
