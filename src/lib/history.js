// Recent station history for scrubbing into the past. The collector
// maintains public/recent.json — a rolling ~2¼ h window of per-minute
// snapshots: { updated, snapshots: [{ t, s: { id: [bikes, docks] } }] }.
// Deployments without a collector simply lack the file; the app then falls
// back to live values.

export async function fetchRecentHistory() {
  try {
    const res = await fetch('/recent.json', { headers: { Accept: 'application/json' } })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null
    const j = await res.json()
    if (!Array.isArray(j?.snapshots)) return null
    return j.snapshots.map((snap) => ({ t: new Date(snap.t), s: snap.s }))
  } catch {
    return null
  }
}

/** Snapshot nearest to `target`, or null when none is close enough. */
export function historyAt(history, target, toleranceMs = 10 * 60_000) {
  if (!history?.length) return null
  const t = target.getTime()
  let best = null
  let bestD = Infinity
  for (const snap of history) {
    const d = Math.abs(snap.t.getTime() - t)
    if (d < bestD) {
      bestD = d
      best = snap
    }
  }
  return bestD <= toleranceMs ? best : null
}
