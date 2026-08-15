#!/usr/bin/env node
// Refreshes the auto-collected part of public/events.json from echo.lu —
// Luxembourg's central event platform (vdl.lu and luxembourg-city.com are
// consumers of the same data). Uses the public Algolia search index the
// echo.lu frontend queries (search-only key, CORS *). Curated entries
// (no `auto` flag) are always preserved; auto entries are replaced.
//
// Only short happenings (≤ 12 h per instance) become demand events —
// month-long exhibitions would otherwise mark museum stations "event
// active" permanently. Runs nightly before training. Fails soft: any
// error leaves the existing calendar untouched.
//
// Usage: node model/update-events.mjs

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(ROOT, 'public', 'events.json')

const ALGOLIA_URL = 'https://PY7G9MVXE2-dsn.algolia.net/1/indexes/prod_experiences.compact/query'
const ALGOLIA_HEADERS = {
  'content-type': 'application/json',
  'x-algolia-application-id': 'PY7G9MVXE2',
  // public search-only key shipped in echo.lu's own frontend bundle
  'x-algolia-api-key': '55301c0ef2e535ae29e6b6d697f4882d',
}

const LOOKAHEAD_DAYS = 14
const MAX_INSTANCE_H = 12
const MINOR_RADIUS_M = 400

const luxFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Luxembourg',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function luxDayHour(ms) {
  const p = Object.fromEntries(luxFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, h: (Number(p.hour) % 24) + Number(p.minute) / 60 }
}

async function fetchEchoInstances() {
  const now = Date.now()
  const until = now + LOOKAHEAD_DAYS * 86400_000
  const res = await fetch(ALGOLIA_URL, {
    method: 'POST',
    headers: ALGOLIA_HEADERS,
    body: JSON.stringify({
      params:
        'hitsPerPage=1000&' +
        encodeURI(`facetFilters=[["communes:luxembourg"]]`) +
        `&numericFilters=${encodeURIComponent(`["from_timestamp<${until}","to_timestamp>=${now}"]`)}`,
    }),
  })
  if (!res.ok) throw new Error(`algolia → HTTP ${res.status}`)
  const j = await res.json()
  return j.hits ?? []
}

function toEvent(hit) {
  const geo = Array.isArray(hit._geoloc) ? hit._geoloc[0] : hit._geoloc
  if (!geo?.lat || !geo?.lng) return null
  const spanH = (hit.to_timestamp - hit.from_timestamp) / 3.6e6
  if (!(spanH > 0) || spanH > MAX_INSTANCE_H) return null
  const start = luxDayHour(hit.from_timestamp)
  const end = luxDayHour(hit.to_timestamp)
  const raw = hit.rawExperience ?? {}
  const name = raw.title?.en ?? raw.title?.fr ?? raw.title?.de ?? 'Event'
  const venue = hit.rawVenues?.[0]?.title ?? name
  let endH = end.h
  if (end.day !== start.day) endH += 24
  if (endH <= start.h) endH = start.h + 1
  return {
    id: `echo-${hit.objectID}`,
    name: String(name).slice(0, 60),
    venue: String(venue).slice(0, 60),
    lat: geo.lat,
    lon: geo.lng,
    from: start.day,
    to: start.day,
    hours: [Math.floor(start.h), Math.ceil(endH)],
    radiusM: MINOR_RADIUS_M,
    scale: 'minor',
    auto: true,
  }
}

async function main() {
  let existing = { events: [] }
  try {
    existing = JSON.parse(await readFile(FILE, 'utf8'))
  } catch {
    /* first run */
  }
  const curated = (existing.events ?? []).filter((ev) => !ev.auto)
  let fresh = []
  try {
    fresh = (await fetchEchoInstances()).map(toEvent).filter(Boolean)
  } catch (e) {
    console.error(`echo.lu fetch failed (${e.message}) — keeping existing calendar`)
    return
  }
  const events = [...curated, ...fresh].sort((a, b) => (a.from < b.from ? -1 : 1))
  await writeFile(FILE, JSON.stringify({ updated: new Date().toISOString(), events }, null, 1))
  console.log(`events.json: ${curated.length} curated + ${fresh.length} echo.lu instances (next ${LOOKAHEAD_DAYS} days)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
