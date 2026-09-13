// Browser side of the radar overlay: a MapLibre custom protocol ("radar://")
// that fetches the raw DWD and RainViewer tiles for a frame, recolours both
// into the RegenRadar palette and composites them — DWD wherever it measured,
// RainViewer filling the rest. The pure parts live in radarColors.js.
import { DWD_WMS } from './radar.js'
import {
  DWD_BBOX_3857,
  RADAR_PROTOCOL,
  bboxIntersects,
  compositeTile,
  parseTileUrl,
  rvParent,
} from './radarColors.js'

const SIZE = 512
const STALE_RV_ALPHA = 0.45 // RainViewer has no nowcast: past its last frame it stays, dimmed
const RV_CACHE_MAX = 96 // decoded RainViewer tiles (shared by every deeper tile they cover)
const GRID_MASK_URL = `${import.meta.env.BASE_URL}radar/dwd-grid.png`
// Zoomed out, DWD's 1 km detail is invisible and its WMS is slow (0.5–3 s
// per render, HTTP/1.1, no caching) — RainViewer's CDN tiles carry those
// frames alone, except for nowcast frames, which only DWD has.
const DWD_MIN_ZOOM = 8
// Continental views hold a dozen tiles per frame × dozens of frames on the
// GPU; a quarter-size bitmap is plenty at ≥ 3 km per screen pixel.
const LOW_ZOOM_SIZE = 256
const LOW_ZOOM_MAX = 6
const FETCH_TIMEOUT_MS = 20_000 // the DWD WMS occasionally stalls for a minute
const DEGRADED_TTL_S = 60 // retry window for a tile whose DWD/RainViewer fetch failed

let installed = false
export function installRadarProtocol(maplibregl) {
  if (installed) return
  installed = true
  maplibregl.addProtocol(RADAR_PROTOCOL, loadTile)
}

async function loadTile({ url }, abortController) {
  const signal = abortController?.signal
  const p = parseTileUrl(url)
  const size = p.z <= LOW_ZOOM_MAX ? LOW_ZOOM_SIZE : SIZE
  const wantDwd =
    !!p.dwdTime && bboxIntersects(p.bbox, DWD_BBOX_3857) && (p.z >= DWD_MIN_ZOOM || p.stale || !p.rvUrl)
  const dwdUrl = `${DWD_WMS.replace('width=512&height=512', `width=${size}&height=${size}`)}&bbox=${p.bbox.join(',')}&time=${p.dwdTime}`
  const [dwdImg, rvTile, mask] = await Promise.all([
    wantDwd ? fetchDwd(dwdUrl, signal) : null,
    p.rvUrl ? fetchRvTile(p) : null,
    wantDwd ? gridMask() : null,
  ])
  // A tile that lost one of its sources (WMS stall, 5xx, timeout) is served
  // anyway, but with a short expiry so MapLibre re-requests it instead of
  // keeping the degraded picture for the frame's whole life.
  const degraded = (wantDwd && !dwdImg) || (!!p.rvUrl && !rvTile)
  const cacheControl = degraded ? `max-age=${DEGRADED_TTL_S}` : undefined
  if (signal?.aborted || (!dwdImg && !rvTile)) return { data: blankBitmap(), cacheControl }
  const dwd = dwdImg ? pixelsOf(dwdImg, null, size) : null
  const rv = rvTile ? pixelsOf(rvTile.bitmap, rvTile.crop, size) : null
  const out = compositeTile({
    dwd,
    rv,
    inGrid: dwd ? gridTester(mask, p.bbox, size) : null,
    rvAlpha: p.stale ? STALE_RV_ALPHA : 1,
    size,
  })
  const canvas = new OffscreenCanvas(size, size)
  canvas.getContext('2d').putImageData(new ImageData(out, size, size), 0, 0)
  return { data: soften(canvas, size), cacheControl }
}

// Both sources are blocky 1 km / ~400 m cells; a light blur gives the soft
// blobs the RegenRadar look has. Skipped where 2D-canvas filters are missing.
function soften(canvas, size) {
  const c = new OffscreenCanvas(size, size)
  const ctx = c.getContext('2d')
  if (!('filter' in ctx)) return canvas.transferToImageBitmap()
  ctx.filter = 'blur(1px)'
  ctx.drawImage(canvas, 0, 0)
  return c.transferToImageBitmap()
}

// A failed or non-image response (DWD answers out-of-range TIMEs with an XML
// ServiceException) is simply "no data" — never an error, which would trip
// the map's style-fallback handler.
// The DWD GeoServer renders every request on demand and slows to several
// seconds each when hit with the browser's six parallel connections — a
// narrower pipe finishes the same work sooner and times out far less.
const DWD_MAX_INFLIGHT = 3
let dwdInflight = 0
const dwdWaiters = []
function acquireDwd() {
  if (dwdInflight < DWD_MAX_INFLIGHT) {
    dwdInflight++
    return Promise.resolve()
  }
  return new Promise((resolve) => dwdWaiters.push(resolve))
}
function releaseDwd() {
  const next = dwdWaiters.shift()
  if (next) next() // hand the slot straight over
  else dwdInflight--
}
async function fetchDwd(url, signal) {
  await acquireDwd()
  if (signal?.aborted) {
    releaseDwd()
    return null
  }
  try {
    return await fetchImage(url, signal)
  } finally {
    releaseDwd()
  }
}

function withTimeout(signal) {
  if (typeof AbortSignal.timeout !== 'function' || typeof AbortSignal.any !== 'function') return signal
  const t = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, t]) : t
}

async function fetchImage(url, signal) {
  try {
    const res = await fetch(url, { signal: withTimeout(signal) })
    if (!res.ok || !(res.headers.get('content-type') || '').startsWith('image/')) return null
    return await createImageBitmap(await res.blob())
  } catch {
    return null
  }
}

const rvCache = new Map() // tile url → Promise<ImageBitmap|null> (insertion order = LRU)
async function fetchRvTile(p) {
  const crop = rvParent(p.z, p.x, p.y, SIZE)
  const url = `${p.rvUrl}/${SIZE}/${crop.z}/${crop.x}/${crop.y}/2/0_1.png` // unsmoothed, snow flagged
  let pending = rvCache.get(url)
  if (pending) rvCache.delete(url)
  else pending = fetchImage(url) // shared, so not tied to one tile's abort signal
  rvCache.set(url, pending)
  while (rvCache.size > RV_CACHE_MAX) rvCache.delete(rvCache.keys().next().value)
  const bitmap = await pending
  if (!bitmap) {
    rvCache.delete(url) // let a later tile retry
    return null
  }
  return { bitmap, crop }
}

let scratch = null
function pixelsOf(bitmap, crop, size) {
  scratch ??= new OffscreenCanvas(SIZE, SIZE)
  const ctx = scratch.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = false // keep palette colours exact when scaling
  ctx.clearRect(0, 0, size, size)
  if (crop) ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, size, size)
  else ctx.drawImage(bitmap, 0, 0, size, size)
  return ctx.getImageData(0, 0, size, size).data
}

function blankBitmap() {
  return new OffscreenCanvas(1, 1).transferToImageBitmap()
}

// ---------- DWD grid mask ----------
// The DWD composite is a rotated rectangle inside its lon/lat envelope. A
// transparent DWD pixel means "dry" on the grid but "nothing here" off it, so
// the pre-rendered mask (GeoServer's raw "raster" style: opaque on-grid)
// decides which. Eroded by one cell so the seam errs towards RainViewer.
let maskPromise = null
async function gridMask() {
  maskPromise ??= loadMask().catch(() => null)
  const mask = await maskPromise
  if (!mask) maskPromise = null // failed → let a later tile retry (cf. rvCache)
  return mask
}

async function loadMask() {
  const res = await fetch(GRID_MASK_URL)
  if (!res.ok) return null
  const bmp = await createImageBitmap(await res.blob())
  const { width: w, height: h } = bmp
  const c = new OffscreenCanvas(w, h)
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, 0, 0)
  const a = ctx.getImageData(0, 0, w, h).data
  const raw = new Uint8Array(w * h)
  for (let i = 0; i < raw.length; i++) raw[i] = a[i * 4 + 3] > 0 ? 1 : 0
  const inside = new Uint8Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      inside[i] =
        raw[i] &&
        raw[i - 1] &&
        raw[i + 1] &&
        raw[i - w] &&
        raw[i + w] &&
        raw[i - w - 1] &&
        raw[i - w + 1] &&
        raw[i + w - 1] &&
        raw[i + w + 1]
          ? 1
          : 0
    }
  }
  return { w, h, inside }
}

/** → (pixelIndex) → is this tile pixel on the DWD grid? Falls back to the
 *  envelope when the mask is unavailable. */
function gridTester(mask, bbox, size) {
  const [minx, miny, maxx, maxy] = bbox
  const [ex0, ey0, ex1, ey1] = DWD_BBOX_3857
  const col = new Int32Array(size) // tile column → mask column (−1 = off the envelope)
  const row = new Int32Array(size)
  const mw = mask?.w ?? 1
  const mh = mask?.h ?? 1
  for (let k = 0; k < size; k++) {
    const mx = minx + ((k + 0.5) / size) * (maxx - minx)
    col[k] = mx < ex0 || mx > ex1 ? -1 : Math.min(mw - 1, Math.floor(((mx - ex0) / (ex1 - ex0)) * mw))
    const my = maxy - ((k + 0.5) / size) * (maxy - miny)
    row[k] = my < ey0 || my > ey1 ? -1 : Math.min(mh - 1, Math.floor(((ey1 - my) / (ey1 - ey0)) * mh))
  }
  return (i) => {
    const x = i % size
    const c = col[x]
    const r = row[(i - x) / size]
    if (c < 0 || r < 0) return false
    return mask ? mask.inside[r * mask.w + c] === 1 : true
  }
}
