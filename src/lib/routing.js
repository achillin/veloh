// Walking and cycling routes via the FOSSGIS OSRM instance — keyless,
// CORS-enabled, fair-use. https://routing.openstreetmap.de/about.html
const OSRM = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving'
const OSRM_BIKE = 'https://routing.openstreetmap.de/routed-bike/route/v1/driving'

/** Cycling route through all given points (2+). Returns the overall
 *  geometry plus per-leg durations/distances between consecutive points. */
export async function bikeRoute(points, signal) {
  const path = points.map((p) => `${p.lon},${p.lat}`).join(';')
  const res = await fetch(`${OSRM_BIKE}/${path}?overview=full&geometries=geojson&steps=false&alternatives=false`, { signal })
  if (!res.ok) throw new Error(`bike routing → HTTP ${res.status}`)
  const j = await res.json()
  const r = j.routes?.[0]
  if (!r) throw new Error('no route found')
  return {
    geometry: r.geometry,
    durationSec: r.duration,
    distanceM: r.distance,
    legs: (r.legs ?? []).map((l) => ({ durationSec: l.duration, distanceM: l.distance })),
  }
}

/** Point on a route line at time `tSec`, assuming speed proportional to
 *  distance along the geometry. Used to place bike-swap stops. */
export function routePointAtTime(geometry, durationSec, tSec) {
  const coords = geometry?.coordinates
  if (!coords?.length || durationSec <= 0) return null
  const targetFrac = Math.min(1, Math.max(0, tSec / durationSec))
  let total = 0
  const cum = [0]
  for (let i = 1; i < coords.length; i++) {
    total += haversineM(
      { lat: coords[i - 1][1], lon: coords[i - 1][0] },
      { lat: coords[i][1], lon: coords[i][0] }
    )
    cum.push(total)
  }
  if (!total) return { lat: coords[0][1], lon: coords[0][0] }
  const targetDist = targetFrac * total
  for (let i = 1; i < cum.length; i++) {
    if (cum[i] >= targetDist) {
      const f = (targetDist - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1])
      return {
        lat: coords[i - 1][1] + f * (coords[i][1] - coords[i - 1][1]),
        lon: coords[i - 1][0] + f * (coords[i][0] - coords[i - 1][0]),
      }
    }
  }
  return { lat: coords.at(-1)[1], lon: coords.at(-1)[0] }
}

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
