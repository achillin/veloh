// Pure helpers behind the client-side radar recolouring (no DOM, testable).
//
// Two raw sources feed one composite tile per frame:
//  - DWD Niederschlagsradar WMS: 1 km / 5-min, +2 h nowcast, but only over a
//    polar-stereographic grid around Germany. Its palette is fixed server-side
//    (dynamic SLDs are refused), and outside radar range it paints a grey
//    "Keine Daten" area.
//  - RainViewer: worldwide, 10-min steps, past 2 h only, "Universal Blue"
//    palette (the only scheme still served).
// Both get mapped back to an intensity class and re-drawn in the WetterOnline
// "RegenRadar" palette, RainViewer filling wherever DWD has no data.

// RegenRadar rain bar, light → heavy (hail). Exact values from the app build.
export const RAIN_PALETTE = ['#AAFFFF', '#53D2FF', '#33ADFF', '#2294F3', '#177EDC', '#0D6EC7', '#903290', '#C72BC7', '#FF00FF']
// RegenRadar snow bar, little → much.
export const SNOW_PALETTE = ['#FFC2FF', '#FD8EE3', '#F969BF', '#EF4CAC', '#EA39A1', '#EA39A1']

// WetterOnline publishes no mm/h thresholds; these split the DWD legend
// classes so ordinary rain (0.2–5 mm/h) spans the light blues and the purple
// end is reserved for downpours / hail.
export const RAIN_STEPS_MMH = [0.2, 1, 2, 5, 10, 30, 75, 150]
export const SNOW_STEPS_MMH = [0.2, 1, 2, 5, 10]
export const MIN_MMH = 0.1 // DWD's own drawing threshold

// Pixel classes shared by the classifiers and the compositor.
export const DRY = 0 // measured, no precipitation → leave the map visible
export const NODATA = 1 // no measurement here → fall back to the other source
export const UNKNOWN = 2 // blend / artefact colour (DWD's grid-edge rim) → decided by neighbours
export const RAIN0 = 10 // RAIN0 + rain class index
export const SNOW0 = 20 // SNOW0 + snow class index

export function rainClass(mmh) {
  if (!(mmh >= MIN_MMH)) return -1
  let i = 0
  while (i < RAIN_STEPS_MMH.length && mmh >= RAIN_STEPS_MMH[i]) i++
  return i
}

export function snowClass(mmh) {
  if (!(mmh >= MIN_MMH)) return -1
  let i = 0
  while (i < SNOW_STEPS_MMH.length && mmh >= SNOW_STEPS_MMH[i]) i++
  return i
}

// Marshall–Palmer Z = 200 R^1.6 (mm⁶/m³ ↔ mm/h)
export function dbzToMmh(dbz) {
  return Math.pow(Math.pow(10, dbz / 10) / 200, 1 / 1.6)
}

const hexRgb = (h) => {
  const v = parseInt(h.replace('#', ''), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}
const RAIN_RGB = RAIN_PALETTE.map(hexRgb)
const SNOW_RGB = SNOW_PALETTE.map(hexRgb)

// ---------- DWD ----------

// GetLegendGraphic colormap (intervals): colour → lower bound of its mm/h class.
export const DWD_LEGEND = [
  ['33FFFF', 0.1],
  ['1ACC9A', 0.2],
  ['019934', 0.4],
  ['4DB31B', 1],
  ['99CC01', 2],
  ['CCE601', 3],
  ['FFFF01', 5],
  ['FFC401', 7.5],
  ['FF8901', 10],
  ['FF4501', 15],
  ['FE0000', 30],
  ['E5004C', 45],
  ['CC0098', 75],
  ['6600CB', 100],
  ['0000FE', 150],
]
const DWD_RGB = DWD_LEGEND.map(([h, mmh]) => [...hexRgb(h), mmh])
const DWD_NODATA_GREY = 0x7d // "#7D7D7D" at 30 % opacity (rendered as 7e7e7e/4d)
const DWD_MATCH_D2 = 24 * 24 // colour distance² accepted as a legend colour

// Worldwide-mercator envelope of the DWD grid (from GetCapabilities).
export const DWD_BBOX_3857 = [163152.408, 5730101.504, 2083209.885, 7600452.974]

export function bboxIntersects(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

const dwdCache = new Map()

/** DWD legend colour → pixel class (see DRY/NODATA/UNKNOWN/RAIN0). */
export function classifyDwd(r, g, b, a) {
  if (a === 0) return DRY
  const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0
  let c = dwdCache.get(key)
  if (c !== undefined) return c
  if (
    a < 128 &&
    Math.abs(r - DWD_NODATA_GREY) <= 3 &&
    Math.abs(g - DWD_NODATA_GREY) <= 3 &&
    Math.abs(b - DWD_NODATA_GREY) <= 3
  ) {
    c = NODATA
  } else if (a >= 250) {
    let best = Infinity
    let mmh = 0
    for (const [lr, lg, lb, m] of DWD_RGB) {
      const d2 = (r - lr) ** 2 + (g - lg) ** 2 + (b - lb) ** 2
      if (d2 < best) {
        best = d2
        mmh = m
      }
    }
    c = best <= DWD_MATCH_D2 ? RAIN0 + rainClass(mmh) : UNKNOWN
  } else {
    c = UNKNOWN
  }
  dwdCache.set(key, c)
  return c
}

// ---------- RainViewer ----------

// "Universal Blue" tables, dBZ −32…95, run-length packed ("hex*n").
const UB_RAIN =
  '00000000*22,63615914,66635a19,69665c1e,6c685d24,6f6b5f29,726e612e,75706234,78736439,7c75653e,7f786744,827b6949,857d6a4e,88806c54,8b826d59,8e856f5e,92887164,9e93756e,aa9e7978,b6a97e82,c2b4828c,cec08796,d2c48ba0,d6c88faa,dacc93b4,ded097be,88ddeeff,6cd1ebff,51c5e8ff,36bae5ff,1baee2ff,00a3e0ff,009ad5ff,0091caff,0088bfff,007fb4ff,0077aaff,0070a3ff,00699cff,006295ff,005b8eff,005588ff,005180ff,004e78ff,004a70ff,004768ff,ffee00ff,ffe000ff,ffd200ff,ffc500ff,ffb700ff,ffaa00ff,ff9f00ff,ff9500ff,ff8b00ff,ff8100ff,ff4400ff,f23600ff,e62800ff,d91b00ff,cd0d00ff,c10000ff,a80000ff,8f0000ff,760000ff,5d0000ff,ffaaffff,ff9fffff,ff95ffff,ff8bffff,ff81ffff,ff77ffff,ff6cffff,ff62ffff,ff58ffff,ff4effff,ffffffff*10,00ff00ff*21'
const UB_SNOW =
  '00000000*22,cfffff00,ceffff0c,cdffff19,ccffff26,cbffff33,cbffff3f,caffff4c,c9ffff59,c8ffff66,c7ffff72,c7ffff7f,c6ffff8c,c5ffff99,c4ffffa5,c3ffffb2,c3ffffbf,c2ffffcc,c1ffffd8,c0ffffe5,bffffff2,bfffffff,b8f8ffff,b2f2ffff,abebffff,a5e5ffff,9fdfffff,98d8ffff,92d2ffff,8bcbffff,85c5ffff,7fbfffff,78b8ffff,72b2ffff,6babffff,65a5ffff,5f9fffff,5b9bffff,5898ffff,5595ffff,5292ffff,4f8fffff,4b8bffff,4888ffff,4585ffff,4282ffff,3f7fffff,3b7bffff,3878ffff,3575ffff,3272ffff,2f6fffff,2b6bffff,2868ffff,2565ffff,2262ffff,1f5fffff,1b5bffff,1858ffff,1555ffff,1252ffff,0f4fffff,0c4bffff,0948ffff,0645ffff,0242ffff,003fffff,003bffff,0038ffff,0035ffff,0032ffff,002fffff,002bffff,0028ffff,0025ffff,0022ffff,001fffff,001bffff,0018ffff,0015ffff,0012ffff,000fffff,000cffff,0009ffff,0006ffff,0002ffff,0000ffff*21'

function unpack(s) {
  const out = []
  for (const tok of s.split(',')) {
    const [hex, n] = tok.split('*')
    for (let i = 0; i < (n ? Number(n) : 1); i++) out.push(parseInt(hex, 16) >>> 0)
  }
  return out
}

const RV_MIN_DBZ = 10 // RainViewer draws −10…14 dBZ as a faint noise band; ≈0.15 mm/h
// packed RGBA → { dbz, snow }; the two columns share no opaque colours.
const rvTable = new Map()
const rvEntries = [] // [packed, dbz, snow] for nearest-colour fallback
for (const [table, snow] of [
  [unpack(UB_RAIN), false],
  [unpack(UB_SNOW), true],
]) {
  table.forEach((packed, i) => {
    if (packed === 0) return
    const dbz = i - 32
    if (!rvTable.has(packed)) rvTable.set(packed, { dbz, snow })
    rvEntries.push([packed, dbz, snow])
  })
}
const RV_MATCH_D2 = 40 * 40
const rvCache = new Map()

function rvClassOf(dbz, snow) {
  if (dbz < RV_MIN_DBZ) return DRY
  const mmh = dbzToMmh(dbz)
  return snow ? SNOW0 + snowClass(mmh) : RAIN0 + rainClass(mmh)
}

/** RainViewer Universal-Blue colour → pixel class (DRY / RAIN0+i / SNOW0+i). */
export function classifyRv(r, g, b, a) {
  if (a === 0) return DRY
  const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0
  const hit = rvTable.get(key)
  if (hit) return rvClassOf(hit.dbz, hit.snow)
  let c = rvCache.get(key)
  if (c !== undefined) return c
  let best = Infinity
  let bestDbz = -32
  let bestSnow = false
  for (const [p, dbz, snow] of rvEntries) {
    const d2 =
      (r - (p >>> 24)) ** 2 + (g - ((p >>> 16) & 255)) ** 2 + (b - ((p >>> 8) & 255)) ** 2 + (a - (p & 255)) ** 2
    if (d2 < best) {
      best = d2
      bestDbz = dbz
      bestSnow = snow
    }
  }
  c = best <= RV_MATCH_D2 ? rvClassOf(bestDbz, bestSnow) : DRY
  rvCache.set(key, c)
  return c
}

// ---------- tile addressing ----------

export const RADAR_PROTOCOL = 'radar'
export const RV_MAX_ZOOM = 7 // RainViewer serves real tiles up to z7 only

/** Tile-URL template for one frame; MapLibre fills the {…} placeholders. */
export function compositeTemplate({ dwdTime = '', rvUrl = '', stale = false }) {
  return `${RADAR_PROTOCOL}://1|{z}|{x}|{y}|{bbox-epsg-3857}|${dwdTime}|${rvUrl}|${stale ? 1 : 0}`
}

export function parseTileUrl(url) {
  const body = url.slice(url.indexOf('://') + 3)
  const [v, z, x, y, bbox, dwdTime, rvUrl, stale] = body.split('|')
  if (v !== '1') throw new Error(`radar tile url v${v}`)
  return {
    z: Number(z),
    x: Number(x),
    y: Number(y),
    bbox: bbox.split(',').map(Number),
    dwdTime: dwdTime || null,
    rvUrl: rvUrl || null,
    stale: stale === '1',
  }
}

/** The RainViewer tile to fetch for (z, x, y) and the crop of it (in its own
 *  pixels, `size` px tiles) that covers the requested tile — RainViewer stops
 *  at z7, so deeper tiles are cut out of their z7 ancestor. */
export function rvParent(z, x, y, size = 512, maxZoom = RV_MAX_ZOOM) {
  if (z <= maxZoom) return { z, x, y, sx: 0, sy: 0, sw: size, sh: size }
  const d = z - maxZoom
  const f = 2 ** d
  const px = Math.floor(x / f)
  const py = Math.floor(y / f)
  const sw = size / f
  return { z: maxZoom, x: px, y: py, sx: (x - px * f) * sw, sy: (y - py * f) * sw, sw, sh: sw }
}

// ---------- compositing ----------

/**
 * Builds one RGBA tile from the raw DWD and RainViewer pixels.
 *  dwd / rv:  RGBA Uint8ClampedArray (size² px) or null
 *  inGrid:    (i) → true when pixel i lies on the DWD grid (null = all of them)
 *  rvAlpha:   0…1 multiplier for the RainViewer fill (dimmed when stale)
 */
export function compositeTile({ dwd, rv, inGrid = null, rvAlpha = 1, size = 512 }) {
  const n = size * size
  const codes = new Uint8Array(n)
  let unknowns = 0
  if (dwd) {
    for (let i = 0; i < n; i++) {
      if (inGrid && !inGrid(i)) {
        codes[i] = NODATA
        continue
      }
      const o = i * 4
      const c = classifyDwd(dwd[o], dwd[o + 1], dwd[o + 2], dwd[o + 3])
      codes[i] = c
      if (c === UNKNOWN) unknowns++
    }
  } else {
    codes.fill(NODATA)
  }
  // The rim between DWD's measured area and its no-data zone renders as
  // off-legend blends: treat those as no-data (RainViewer shows through) when
  // no-data is nearby, otherwise as an ordinary cell edge (dry).
  if (unknowns) {
    const R = 2
    const src = codes.slice() // judge neighbours on the classifier's output, not on this pass's own writes
    for (let i = 0; i < n; i++) {
      if (src[i] !== UNKNOWN) continue
      const x = i % size
      const y = (i - x) / size
      let near = false
      for (let dy = -R; dy <= R && !near; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= size) continue
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= size) continue
          if (src[yy * size + xx] === NODATA) {
            near = true
            break
          }
        }
      }
      codes[i] = near ? NODATA : DRY
    }
  }
  const out = new Uint8ClampedArray(n * 4)
  const fillA = Math.round(255 * rvAlpha)
  for (let i = 0; i < n; i++) {
    let c = codes[i]
    let a = 255
    if (c === NODATA) {
      if (!rv) continue
      const o = i * 4
      c = classifyRv(rv[o], rv[o + 1], rv[o + 2], rv[o + 3])
      a = fillA
    }
    if (c < RAIN0) continue
    const rgb = c >= SNOW0 ? SNOW_RGB[c - SNOW0] : RAIN_RGB[c - RAIN0]
    if (!rgb) continue
    const o = i * 4
    out[o] = rgb[0]
    out[o + 1] = rgb[1]
    out[o + 2] = rgb[2]
    out[o + 3] = a
  }
  return out
}
