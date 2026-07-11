// Open-Meteo forecast for Luxembourg City — keyless, CORS-enabled.
const URL =
  'https://api.open-meteo.com/v1/forecast?latitude=49.61&longitude=6.13' +
  '&current=temperature_2m,precipitation,weather_code' +
  '&hourly=temperature_2m,precipitation,precipitation_probability,weather_code' +
  '&timezone=Europe%2FLuxembourg&forecast_days=3'

// WMO weather codes → icon + label
const WMO = [
  [[0], '☀️', 'Clear'],
  [[1, 2], '🌤️', 'Partly cloudy'],
  [[3], '☁️', 'Overcast'],
  [[45, 48], '🌫️', 'Fog'],
  [[51, 53, 55, 56, 57], '🌦️', 'Drizzle'],
  [[61, 63, 65, 66, 67, 80, 81, 82], '🌧️', 'Rain'],
  [[71, 73, 75, 77, 85, 86], '🌨️', 'Snow'],
  [[95, 96, 99], '⛈️', 'Thunderstorm'],
]

export function describeWmo(code) {
  for (const [codes, icon, label] of WMO) {
    if (codes.includes(code)) return { icon, label }
  }
  return { icon: '☁️', label: '—' }
}

export async function fetchWeather() {
  const res = await fetch(URL)
  if (!res.ok) throw new Error(`Open-Meteo → HTTP ${res.status}`)
  const j = await res.json()
  const hourly = j.hourly.time.map((t, i) => ({
    time: new Date(t),
    temp: j.hourly.temperature_2m[i],
    precip: j.hourly.precipitation[i],
    precipProb: j.hourly.precipitation_probability?.[i] ?? null,
    code: j.hourly.weather_code[i],
  }))
  return {
    current: {
      temp: j.current.temperature_2m,
      precip: j.current.precipitation,
      code: j.current.weather_code,
    },
    hourly,
  }
}

/** Hourly forecast entry closest to the given date, or null if outside the horizon. */
export function forecastAt(weather, date) {
  if (!weather) return null
  const t = date.getTime()
  let best = null
  let bestDiff = Infinity
  for (const h of weather.hourly) {
    const diff = Math.abs(h.time.getTime() - t)
    if (diff < bestDiff) {
      bestDiff = diff
      best = h
    }
  }
  return bestDiff <= 45 * 60 * 1000 ? best : null
}
