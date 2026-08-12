// Quick sanity check of the rolling history window.
import { readFile } from 'node:fs/promises'
const file = process.argv[2] ?? 'public/recent.json'
const j = JSON.parse(await readFile(file, 'utf8'))
const first = j.snapshots[0]?.t
const hours = ((Date.parse(j.updated) - Date.parse(first)) / 3.6e6).toFixed(1)
console.log(`${file}: ${j.snapshots.length} pont | ${first} → ${j.updated} | ${hours} óra`)
