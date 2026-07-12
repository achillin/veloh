// Walking routes via the FOSSGIS OSRM instance (foot profile) — keyless,
// CORS-enabled, fair-use. https://routing.openstreetmap.de/about.html
const OSRM = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving'

export async function walkingRoute(from, to, signal) {
  const url =
    `${OSRM}/${from.lon},${from.lat};${to.lon},${to.lat}` +
    '?overview=full&geometries=geojson&steps=false&alternatives=false'
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`routing → HTTP ${res.status}`)
  const j = await res.json()
  const r = j.routes?.[0]
  if (!r) throw new Error('no route found')
  return { geometry: r.geometry, durationSec: r.duration, distanceM: r.distance }
}

export function haversineM(a, b) {
  const R = 6371000
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

/** Nearest open station that has at least one bike (by beeline — a good
 *  proxy for walking distance at station spacing). */
export function nearestWithBikes(stations, pos) {
  let best = null
  let bestD = Infinity
  for (const s of stations) {
    if (s.closed || s.bikes < 1) continue
    const d = haversineM(pos, s)
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return best ? { station: best, distanceM: bestD } : null
}
