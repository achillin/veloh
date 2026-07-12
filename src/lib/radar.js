// Rain-radar ("RegenRadar") integrations — both keyless:
// - Buienradar: radar-extrapolated 5-min precipitation nowcast, ~2 h ahead.
//   Covers Benelux incl. Luxembourg (nearest radar: Wideumont, ~40 km).
// - RainViewer: composite radar imagery as map tiles.

export async function fetchRainNowcast(lat = 49.61, lon = 6.13) {
  const res = await fetch(
    `https://gpsgadget.buienradar.nl/data/raintext?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`
  )
  if (!res.ok) throw new Error(`buienradar → HTTP ${res.status}`)
  const text = await res.text()
  const now = new Date()
  const points = []
  for (const line of text.trim().split('\n')) {
    const m = line.trim().match(/^(\d{1,3})\|(\d{1,2}):(\d{2})$/)
    if (!m) continue
    const t = new Date(now)
    t.setHours(Number(m[2]), Number(m[3]), 0, 0)
    if (t.getTime() < now.getTime() - 30 * 60_000) t.setDate(t.getDate() + 1) // series wraps midnight
    const v = Number(m[1]) // 0–255, log scale
    points.push({ time: t, mmh: v > 0 ? +Math.pow(10, (v - 109) / 32).toFixed(2) : 0 })
  }
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

/** Latest composite radar frame as a raster tile URL template, or throws. */
export async function fetchRadarTiles() {
  const res = await fetch('https://api.rainviewer.com/public/weather-maps.json')
  if (!res.ok) throw new Error(`rainviewer → HTTP ${res.status}`)
  const j = await res.json()
  const frame = j?.radar?.past?.at(-1)
  if (!frame) throw new Error('no radar frames')
  // color scheme 2 (universal blue), smoothed, snow shown
  return `${j.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`
}
