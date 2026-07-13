// Rain-radar ("RegenRadar") integrations — all keyless:
// - DWD Niederschlagsradar (RV composite): 1 km / 5-min radar measurements
//   PLUS a +2 h radar nowcast, served as a WMS with a TIME dimension from
//   maps.dwd.de (CORS *). Covers lat 45.7–56.2, lon 1.5–18.7 — all of
//   Luxembourg and its surroundings.
// - Buienradar: radar-extrapolated 5-min point nowcast for the city, ~2 h.

const DWD_WMS =
  'https://maps.dwd.de/geoserver/dwd/wms?service=WMS&version=1.3.0&request=GetMap' +
  '&layers=dwd%3ANiederschlagsradar&crs=EPSG%3A3857&format=image%2Fpng&transparent=true' +
  '&width=512&height=512'

const STEP_MS = 5 * 60_000
const PUBLISH_LAG_MS = 5 * 60_000 // newest frame is ~one step behind wall clock

/** Radar frames from 2 h back to 2 h ahead, in 5-minute steps. No network
 *  needed — the DWD WMS serves any timestamp in that window via TIME=. */
export function dwdRadarFrames(now = new Date()) {
  const latest = Math.floor((now.getTime() - PUBLISH_LAG_MS) / STEP_MS) * STEP_MS
  const frames = []
  for (let t = latest - 2 * 3600_000; t <= latest + 2 * 3600_000; t += STEP_MS) {
    frames.push({
      time: new Date(t),
      nowcast: t > now.getTime(),
      template: `${DWD_WMS}&bbox={bbox-epsg-3857}&time=${new Date(t).toISOString()}`,
    })
  }
  return frames
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const R_MERC = 6378137

/** Fetches one 512px DWD radar image of the ~400 km box around (lat, lon)
 *  and reports precipitation coverage plus the nearest rain's distance and
 *  compass direction. Tells the UI whether a transparent overlay means
 *  "dry here" (and where the action is) or "broken". */
export async function analyzeRadar({ lat = 49.61, lon = 6.13 } = {}) {
  const x = (lon * Math.PI * R_MERC) / 180
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R_MERC
  const half = 200_000 // metres
  const url = `${DWD_WMS}&bbox=${x - half},${y - half},${x + half},${y + half}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`dwd radar → HTTP ${res.status}`)
  const bmp = await createImageBitmap(await res.blob())
  const canvas = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, 0, 0)
  const a = ctx.getImageData(0, 0, bmp.width, bmp.height).data
  const kmPerPx = (2 * half) / bmp.width / 1000
  const c = bmp.width / 2
  let wet = 0
  let bestD2 = Infinity
  let bestDx = 0
  let bestDy = 0
  for (let i = 3; i < a.length; i += 4) {
    if (a[i] === 0) continue
    wet++
    const p = (i - 3) / 4
    const dx = (p % bmp.width) - c
    const dy = Math.floor(p / bmp.width) - c
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) {
      bestD2 = d2
      bestDx = dx
      bestDy = dy
    }
  }
  if (!wet) return { coverage: 0, nearest: null }
  const km = Math.sqrt(bestD2) * kmPerPx
  const deg = (Math.atan2(bestDx, -bestDy) * 180) / Math.PI // north-up bearing
  const dir = COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
  return { coverage: wet / (a.length / 4), nearest: { km, dir } }
}

/** Parses Buienradar "raintext" ("value|HH:MM" lines, value 0–255 log scale)
 *  into [{time, mmh}]. Exported separately for testability. */
export function parseRaintext(text, now = new Date()) {
  const points = []
  for (const line of text.trim().split('\n')) {
    const m = line.trim().match(/^(\d{1,3})\|(\d{1,2}):(\d{2})$/)
    if (!m) continue
    const t = new Date(now)
    t.setHours(Number(m[2]), Number(m[3]), 0, 0)
    if (t.getTime() < now.getTime() - 30 * 60_000) t.setDate(t.getDate() + 1) // series wraps midnight
    const v = Number(m[1])
    points.push({ time: t, mmh: v > 0 ? +Math.pow(10, (v - 109) / 32).toFixed(2) : 0 })
  }
  return points
}

export async function fetchRainNowcast(lat = 49.61, lon = 6.13) {
  const res = await fetch(
    `https://gpsgadget.buienradar.nl/data/raintext?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`
  )
  if (!res.ok) throw new Error(`buienradar → HTTP ${res.status}`)
  const points = parseRaintext(await res.text())
  if (!points.length) throw new Error('no nowcast data')
  return points
}

const RAIN_MMH = 0.1 // drizzle threshold

/** → { raining, until?, startsAt?, maxMmh } or null */
export function summarizeNowcast(points) {
  if (!points?.length) return null
  const maxMmh = Math.max(...points.map((p) => p.mmh))
  if (points[0].mmh >= RAIN_MMH) {
    const stop = points.find((p) => p.mmh < RAIN_MMH)
    return { raining: true, until: stop?.time ?? null, maxMmh }
  }
  const start = points.find((p) => p.mmh >= RAIN_MMH)
  return { raining: false, startsAt: start?.time ?? null, maxMmh }
}
