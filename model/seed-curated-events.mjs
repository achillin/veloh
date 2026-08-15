#!/usr/bin/env node
// One-off: converts the research agent's verified calendar (JSON array with
// name/venue/lat/lon/from/to/daily_hours/crowd_scale) into public/events.json
// curated entries. Usage: node model/seed-curated-events.mjs <agent-output.json>

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(ROOT, 'public', 'events.json')

const raw = JSON.parse(await readFile(process.argv[2], 'utf8'))
const result = raw.result ?? raw
const list = JSON.parse(result.calendar.details)

const RADIUS = { major: 800, medium: 600, small: 400 }

const slug = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)

const events = list.map((ev) => {
  const m = String(ev.daily_hours ?? '').match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/)
  let hours = [0, 24]
  if (m) {
    const start = Number(m[1]) + Number(m[2]) / 60
    let end = Number(m[3]) + Number(m[4]) / 60
    if (end <= start) end += 24
    hours = [Math.floor(start), Math.ceil(end)]
  }
  const name = ev.name
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*20\d\d(-\d\d)?\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    id: `${slug(name)}-${ev.from}`,
    name,
    venue: ev.venue.split(',')[0].trim(),
    lat: ev.lat,
    lon: ev.lon,
    from: ev.from,
    to: ev.to,
    hours,
    radiusM: RADIUS[ev.crowd_scale] ?? 500,
    scale: ev.crowd_scale,
    ...(ev.date_status !== 'confirmed' ? { estimated: true } : {}),
    source: ev.source,
  }
})

await writeFile(FILE, JSON.stringify({ updated: new Date().toISOString(), events }, null, 1))
console.log(`curated events written: ${events.length}`)
for (const ev of events) console.log(` - ${ev.name} (${ev.from}→${ev.to}, ${ev.hours[0]}–${ev.hours[1]}h, ${ev.scale})`)
