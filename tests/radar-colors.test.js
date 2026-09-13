import { describe, it, expect } from 'vitest'
import {
  DRY,
  NODATA,
  UNKNOWN,
  RAIN0,
  SNOW0,
  RAIN_PALETTE,
  SNOW_PALETTE,
  DWD_BBOX_3857,
  bboxIntersects,
  classifyDwd,
  classifyRv,
  compositeTemplate,
  compositeTile,
  dbzToMmh,
  parseTileUrl,
  rainClass,
  rvParent,
  snowClass,
} from '../src/lib/radarColors.js'

const rgb = (hex) => {
  const v = parseInt(hex.replace('#', ''), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

describe('intensity classes', () => {
  it('maps mm/h onto the 9-step rain bar', () => {
    expect(rainClass(0.05)).toBe(-1) // below DWD's drawing threshold
    expect(rainClass(0.1)).toBe(0)
    expect(rainClass(0.19)).toBe(0)
    expect(rainClass(0.2)).toBe(1)
    expect(rainClass(1)).toBe(2)
    expect(rainClass(4.9)).toBe(3)
    expect(rainClass(5)).toBe(4)
    expect(rainClass(12)).toBe(5)
    expect(rainClass(30)).toBe(6)
    expect(rainClass(80)).toBe(7)
    expect(rainClass(150)).toBe(8)
    expect(rainClass(999)).toBe(RAIN_PALETTE.length - 1)
  })

  it('maps mm/h onto the 6-step snow bar', () => {
    expect(snowClass(0.01)).toBe(-1)
    expect(snowClass(0.15)).toBe(0)
    expect(snowClass(3)).toBe(3)
    expect(snowClass(50)).toBe(SNOW_PALETTE.length - 1)
  })

  it('converts reflectivity with Marshall–Palmer', () => {
    expect(dbzToMmh(23)).toBeCloseTo(1, 1) // 1 mm/h ↔ 23 dBZ
    expect(dbzToMmh(39)).toBeCloseTo(10, 0)
  })
})

describe('classifyDwd', () => {
  it('reads the legend colours as rain classes', () => {
    expect(classifyDwd(...rgb('#33FFFF'), 255)).toBe(RAIN0 + 0) // [0.1–0.2)
    expect(classifyDwd(...rgb('#4DB31B'), 255)).toBe(RAIN0 + 2) // [1–2)
    expect(classifyDwd(...rgb('#FF4501'), 255)).toBe(RAIN0 + 5) // [15–30)
    expect(classifyDwd(...rgb('#0000FE'), 255)).toBe(RAIN0 + 8) // ≥150
  })

  it('tolerates the rounding GeoServer/canvas apply', () => {
    expect(classifyDwd(0x34, 0xfe, 0xfe, 255)).toBe(RAIN0 + 0)
  })

  it('separates dry, no-data and rim artefacts', () => {
    expect(classifyDwd(255, 255, 255, 0)).toBe(DRY)
    expect(classifyDwd(0x7e, 0x7e, 0x7e, 0x4d)).toBe(NODATA)
    expect(classifyDwd(0x7d, 0x7d, 0x7d, 0x4c)).toBe(NODATA)
    expect(classifyDwd(0xfb, 0x00, 0xff, 0xd1)).toBe(UNKNOWN) // magenta grid-edge rim
    expect(classifyDwd(0x46, 0xa4, 0xae, 255)).toBe(UNKNOWN) // blend, off-legend
  })
})

describe('classifyRv', () => {
  it('inverts the Universal Blue table into intensity classes', () => {
    expect(classifyRv(0, 0, 0, 0)).toBe(DRY)
    expect(classifyRv(0x63, 0x61, 0x59, 0x14)).toBe(DRY) // −10 dBZ noise band
    expect(classifyRv(0x88, 0xdd, 0xee, 0xff)).toBe(RAIN0 + 1) // 15 dBZ ≈ 0.3 mm/h
    expect(classifyRv(0x00, 0x88, 0xbf, 0xff)).toBe(RAIN0 + 1) // 23 dBZ ≈ 0.998 mm/h, just under 1
    expect(classifyRv(0x00, 0x7f, 0xb4, 0xff)).toBe(RAIN0 + 2) // 24 dBZ ≈ 1.15 mm/h
    expect(classifyRv(0xff, 0xaa, 0x00, 0xff)).toBe(RAIN0 + 5) // 40 dBZ ≈ 11 mm/h
    expect(classifyRv(0xff, 0x44, 0x00, 0xff)).toBe(RAIN0 + 5) // 45 dBZ ≈ 24 mm/h
    expect(classifyRv(0xc1, 0x00, 0x00, 0xff)).toBe(RAIN0 + 6) // 50 dBZ ≈ 49 mm/h
  })

  it('keeps snow on the snow bar', () => {
    expect(classifyRv(0x9f, 0xdf, 0xff, 0xff)).toBe(SNOW0 + 1) // snow 15 dBZ
    expect(classifyRv(0x3f, 0x7f, 0xff, 0xff)).toBe(SNOW0 + 4) // snow 35 dBZ ≈ 5.6 mm/h
  })

  it('snaps near misses to the closest table colour', () => {
    expect(classifyRv(0x00, 0x80, 0xb3, 0xff)).toBe(RAIN0 + 2) // ≈ #007fb4 (24 dBZ)
  })
})

describe('tile addressing', () => {
  it('round-trips the composite template through MapLibre-style substitution', () => {
    const tpl = compositeTemplate({
      dwdTime: '2026-09-13T10:00:00.000Z',
      rvUrl: 'https://tilecache.rainviewer.com/v2/radar/abc',
      stale: true,
    })
    expect(tpl.startsWith('radar://')).toBe(true)
    const url = tpl
      .replace('{z}', '9')
      .replace('{x}', '264')
      .replace('{y}', '175')
      .replace('{bbox-epsg-3857}', '626172.13,6261721.36,704443.65,6339992.87')
    expect(parseTileUrl(url)).toEqual({
      z: 9,
      x: 264,
      y: 175,
      bbox: [626172.13, 6261721.36, 704443.65, 6339992.87],
      dwdTime: '2026-09-13T10:00:00.000Z',
      rvUrl: 'https://tilecache.rainviewer.com/v2/radar/abc',
      stale: true,
    })
  })

  it('treats empty fields as absent', () => {
    const p = parseTileUrl('radar://1|3|4|2|0,0,1,1|||0')
    expect(p.dwdTime).toBeNull()
    expect(p.rvUrl).toBeNull()
    expect(p.stale).toBe(false)
  })

  it('cuts deeper tiles out of their z7 RainViewer ancestor', () => {
    expect(rvParent(5, 16, 10)).toEqual({ z: 5, x: 16, y: 10, sx: 0, sy: 0, sw: 512, sh: 512 })
    // z9 (264,175) → z7 ancestor (66,43), quadrant column 0, row 3 of a 4×4 split
    expect(rvParent(9, 264, 175)).toEqual({ z: 7, x: 66, y: 43, sx: 0, sy: 384, sw: 128, sh: 128 })
  })

  it('knows which tiles touch the DWD envelope', () => {
    expect(bboxIntersects([600000, 6200000, 700000, 6300000], DWD_BBOX_3857)).toBe(true)
    expect(bboxIntersects([-500000, 6200000, -400000, 6300000], DWD_BBOX_3857)).toBe(false) // Atlantic
  })
})

describe('compositeTile', () => {
  const N = 6
  const px = (arr, i) => Array.from(arr.slice(i * 4, i * 4 + 4))
  const make = (fill) => {
    const a = new Uint8ClampedArray(N * N * 4)
    for (let i = 0; i < N * N; i++) fill(a, i)
    return a
  }
  const set = (a, i, [r, g, b, al]) => {
    a[i * 4] = r
    a[i * 4 + 1] = g
    a[i * 4 + 2] = b
    a[i * 4 + 3] = al
  }
  const dwdRain = [...rgb('#4DB31B'), 255] // 1–2 mm/h → rain class 2
  const dwdGrey = [0x7e, 0x7e, 0x7e, 0x4d]
  const rvRain = [0xff, 0xaa, 0x00, 0xff] // 40 dBZ → class 5
  const clear = [0, 0, 0, 0]

  it('draws DWD rain in the palette and leaves dry cells transparent', () => {
    const dwd = make((a, i) => set(a, i, i === 0 ? dwdRain : clear))
    const out = compositeTile({ dwd, rv: null, size: N })
    expect(px(out, 0)).toEqual([...rgb(RAIN_PALETTE[2]), 255])
    expect(px(out, 1)).toEqual([0, 0, 0, 0])
  })

  it('lets RainViewer through where DWD has no data, dimmed when stale', () => {
    const dwd = make((a, i) => set(a, i, i < N ? dwdGrey : clear)) // first row: no data
    const rv = make((a, i) => set(a, i, rvRain))
    const out = compositeTile({ dwd, rv, size: N })
    expect(px(out, 0)).toEqual([...rgb(RAIN_PALETTE[5]), 255])
    expect(px(out, N)).toEqual([0, 0, 0, 0]) // dry on the DWD grid hides RainViewer
    const stale = compositeTile({ dwd, rv, rvAlpha: 0.45, size: N })
    expect(px(stale, 0)[3]).toBe(Math.round(255 * 0.45))
  })

  it('uses the grid mask: off-grid transparent DWD pixels are no-data', () => {
    const dwd = make((a, i) => set(a, i, clear))
    const rv = make((a, i) => set(a, i, rvRain))
    const out = compositeTile({ dwd, rv, inGrid: (i) => i >= N, size: N })
    expect(px(out, 0)[3]).toBe(255) // off grid → RainViewer
    expect(px(out, N)[3]).toBe(0) // on grid, dry
  })

  it('resolves rim artefacts by their neighbourhood', () => {
    const rim = [0xfb, 0x00, 0xff, 0xd1]
    const dwd = make((a, i) => set(a, i, clear))
    set(dwd, 0, dwdGrey) // no-data corner
    set(dwd, 1, rim) // rim next to it → treated as no-data → RainViewer
    set(dwd, N * N - 1, rim) // isolated blend far away → dry
    const rv = make((a, i) => set(a, i, rvRain))
    const out = compositeTile({ dwd, rv, size: N })
    expect(px(out, 1)[3]).toBe(255)
    expect(px(out, N * N - 1)[3]).toBe(0)
  })

  it('resolves rim runs the same way whichever side the no-data lies', () => {
    const rim = [0xfb, 0x00, 0xff, 0xd1]
    const rv = make((a, i) => set(a, i, rvRain))
    const west = make((a, i) => set(a, i, clear))
    set(west, 0, dwdGrey)
    for (let x = 1; x <= 4; x++) set(west, x, rim)
    const east = make((a, i) => set(a, i, clear))
    set(east, N - 1, dwdGrey)
    for (let x = N - 5; x <= N - 2; x++) set(east, x, rim)
    const alphaW = [1, 2, 3, 4].map((x) => px(compositeTile({ dwd: west, rv, size: N }), x)[3])
    const alphaE = [N - 2, N - 3, N - 4, N - 5].map((x) => px(compositeTile({ dwd: east, rv, size: N }), x)[3])
    expect(alphaW).toEqual([255, 255, 0, 0]) // within 2 px of no-data → RainViewer, beyond → dry
    expect(alphaE).toEqual(alphaW)
  })

  it('falls back to RainViewer entirely without a DWD image', () => {
    const rv = make((a, i) => set(a, i, i === 2 ? rvRain : clear))
    const out = compositeTile({ dwd: null, rv, size: N })
    expect(px(out, 2)).toEqual([...rgb(RAIN_PALETTE[5]), 255])
    expect(px(out, 3)[3]).toBe(0)
  })
})
