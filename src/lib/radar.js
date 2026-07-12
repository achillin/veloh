// Rain-radar ("RegenRadar") integrations — both keyless:
// - Buienradar: radar-extrapolated 5-min precipitation nowcast, ~2 h ahead.
//   Covers Benelux incl. Luxembourg (nearest radar: Wideumont, ~40 km).
// - RainViewer: composite radar imagery as map tiles.

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

/** Latest composite radar frame: tile URL template + frame time. */
export async function fetchRadarTiles() {
  const res = await fetch('https://api.rainviewer.com/public/weather-maps.json')
  if (!res.ok) throw new Error(`rainviewer → HTTP ${res.status}`)
  const j = await res.json()
  const frame = j?.radar?.past?.at(-1)
  if (!frame) throw new Error('no radar frames')
  return {
    // 512px tiles, color scheme 2 (universal blue), smoothed, snow shown.
    // Real data exists only up to z7 — the map overzooms beyond (see MapView).
    template: `${j.host}${frame.path}/512/{z}/{x}/{y}/2/1_1.png`,
    time: new Date(frame.time * 1000),
  }
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

/** Scans the 2×2 block of z6 radar tiles centred on (lat, lon) — roughly
 *  an 800 km box — and reports precipitation coverage plus the distance and
 *  compass direction of the nearest rain. Tells the UI whether a transparent
 *  overlay means "dry here" (and where the action is) or "broken". */
export async function analyzeRadar(template, { z = 6, lat = 49.61, lon = 6.13 } = {}) {
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  const cx = ((lon + 180) / 360) * n * 512 // centre, in world pixels
  const cy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n * 512
  const kmPerPx = (40075 * Math.cos(rad)) / (n * 512) // local Mercator scale

  const tx0 = Math.floor(cx / 512 - 0.5)
  const ty0 = Math.floor(cy / 512 - 0.5)

  let wet = 0
  let total = 0
  let bestD2 = Infinity
  let bestDx = 0
  let bestDy = 0

  for (const tx of [tx0, tx0 + 1]) {
    for (const ty of [ty0, ty0 + 1]) {
      const url = template
        .replace('{z}', String(z))
        .replace('{x}', String(tx))
        .replace('{y}', String(ty))
      const res = await fetch(url)
      if (!res.ok) continue
      const bmp = await createImageBitmap(await res.blob())
      const canvas = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(bmp, 0, 0)
      const a = ctx.getImageData(0, 0, bmp.width, bmp.height).data
      total += a.length / 4
      for (let i = 3; i < a.length; i += 4) {
        if (a[i] === 0) continue
        wet++
        const p = (i - 3) / 4
        const dx = tx * 512 + (p % bmp.width) - cx
        const dy = ty * 512 + Math.floor(p / bmp.width) - cy
        const d2 = dx * dx + dy * dy
        if (d2 < bestD2) {
          bestD2 = d2
          bestDx = dx
          bestDy = dy
        }
      }
    }
  }

  if (!total) throw new Error('no radar tiles readable')
  if (!wet) return { coverage: 0, nearest: null }
  const km = Math.sqrt(bestD2) * kmPerPx
  const deg = (Math.atan2(bestDx, -bestDy) * 180) / Math.PI // north-up bearing
  const dir = COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
  return { coverage: wet / total, nearest: { km, dir } }
}
