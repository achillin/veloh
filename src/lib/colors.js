// Availability fraction → color, interpolated across red → amber → green.
const STOPS = [
  [0.0, [255, 77, 94]], // #ff4d5e — empty
  [0.3, [255, 176, 32]], // #ffb020 — low
  [0.6, [46, 230, 166]], // #2ee6a6 — healthy
  [1.0, [46, 230, 166]],
]

export function fracColor(frac) {
  const f = Math.min(Math.max(frac, 0), 1)
  for (let i = 1; i < STOPS.length; i++) {
    const [f1, c1] = STOPS[i]
    if (f <= f1) {
      const [f0, c0] = STOPS[i - 1]
      const t = f1 === f0 ? 0 : (f - f0) / (f1 - f0)
      const rgb = c0.map((v, k) => Math.round(v + t * (c1[k] - v)))
      return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
    }
  }
  return 'rgb(46,230,166)'
}
