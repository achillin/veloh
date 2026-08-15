// Luxembourg event calendar for the demand model and the UI.
// public/events.json holds the curated calendar: recurring majors
// (Schueberfouer, Christmas markets, …) and one-offs, each with a venue
// position, date span, daily active hours and an effect radius.
// The trainer learns per-venue availability deltas from snapshots taken
// while an event was active; the predictor applies them to future targets.

import { haversineM } from './routing.js'

export async function loadEvents() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}events.json`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return []
    const j = await res.json()
    return Array.isArray(j?.events) ? j.events : []
  } catch {
    return []
  }
}

// Event windows are defined in Luxembourg local time — evaluate them there
// regardless of where this code runs (browser vs UTC CI).
const luxFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Luxembourg',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function luxParts(date) {
  const p = Object.fromEntries(luxFmt.formatToParts(date).map((x) => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, h: (Number(p.hour) % 24) + Number(p.minute) / 60 }
}

/** Events active at `date`. `hours: [start, end]` is the daily window in
 *  Luxembourg time; end > 24 runs past midnight (e.g. [12, 25] = noon–1 am). */
export function activeEventsAt(events, date) {
  if (!events?.length) return []
  const { day, h } = luxParts(date)
  return events.filter((ev) => {
    if (!ev.from || !ev.to) return false
    const [start, end] = ev.hours ?? [0, 24]
    if (end <= 24) {
      return day >= ev.from && day <= ev.to && h >= start && h < end
    }
    // window wraps past midnight: the small hours belong to the previous day's session
    if (day >= ev.from && day <= ev.to && h >= start) return true
    const prevDay = luxParts(new Date(date.getTime() - 24 * 3.6e6)).day
    return prevDay >= ev.from && prevDay <= ev.to && h < end - 24
  })
}

const DEFAULT_RADIUS_M = 600

/** Of the active events, the ones whose effect radius covers the station. */
export function eventsNear(active, station) {
  if (!active?.length || station?.lat == null) return []
  return active.filter(
    (ev) => haversineM(station, ev) <= (ev.radiusM ?? DEFAULT_RADIUS_M)
  )
}
