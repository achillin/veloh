// vel'OH! (Luxembourg) official GBFS v3 feed — keyless, CORS-enabled, ~1 min refresh.
// Licence: JCDecaux Open Licence — https://developer.jcdecaux.com/files/Open-Licence-en.pdf
const BASE = 'https://api.cyclocity.fr/contracts/luxembourg/gbfs/v3'

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.json()
}

export function fetchStationInformation() {
  return getJson(`${BASE}/station_information.json`)
}

export function fetchStationStatus() {
  return getJson(`${BASE}/station_status.json`)
}

function displayName(gbfsName) {
  // GBFS v3 names are localized arrays; vel'OH names look like "#00042-PLACE DE PARIS"
  const raw = Array.isArray(gbfsName) ? gbfsName[0]?.text ?? '' : String(gbfsName ?? '')
  return raw.replace(/^#\d+\s*-\s*/, '')
}

export function mergeStations(info, status) {
  const statusById = new Map(status.data.stations.map((s) => [s.station_id, s]))
  return info.data.stations
    .map((i) => {
      const s = statusById.get(i.station_id)
      if (!s) return null
      return {
        id: i.station_id,
        name: displayName(i.name),
        address: i.address ?? '',
        lat: i.lat,
        lon: i.lon,
        capacity: i.capacity ?? 0,
        bikes: s.num_vehicles_available ?? 0,
        docks: s.num_docks_available ?? 0,
        disabled: s.num_vehicles_disabled ?? 0,
        renting: !!s.is_renting,
        returning: !!s.is_returning,
        installed: !!s.is_installed,
        lastReported: s.last_reported ? new Date(s.last_reported) : null,
      }
    })
    .filter((s) => s && s.installed)
}

export async function fetchStations() {
  const [info, status] = await Promise.all([fetchStationInformation(), fetchStationStatus()])
  return mergeStations(info, status)
}
