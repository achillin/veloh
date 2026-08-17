<script setup>
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import MapView from './components/MapView.vue'
import TopBar from './components/TopBar.vue'
import TimeScrubber from './components/TimeScrubber.vue'
import StationPanel from './components/StationPanel.vue'
import SearchBox from './components/SearchBox.vue'
import { fetchStations } from './lib/gbfs.js'
import { dayType } from './lib/holidays.js'
import { fetchWeather, forecastAt } from './lib/weather.js'
import {
  loadProfiles,
  predict,
  predictSeries,
  globalMeanFraction,
  predictDistribution,
  probAtLeast,
} from './lib/predictor.js'
import {
  walkingRoute,
  nearestWithBikes,
  haversineM,
  bikeRoute,
  routePointAtTime,
} from './lib/routing.js'

let autoFocused = false // one-shot: zoom to the user & open the closest station on startup
import {
  fetchRainNowcast,
  summarizeNowcast,
  dwdRadarFrames,
  fetchGlobalRadarFrames,
  analyzeRadar,
} from './lib/radar.js'
import { describeWmo } from './lib/weather.js'
import { fetchRecentHistory, historyAt } from './lib/history.js'
import { loadEvents, activeEventsAt, eventsNear } from './lib/events.js'

const stations = shallowRef([])
const profiles = shallowRef(null)
const weather = shallowRef(null)
const updatedAt = ref(null)
const now = ref(new Date())
const offsetHours = ref(0)
const selectedId = ref(null)
const error = ref('')
const flyTarget = ref(null)
const userPos = ref(null) // {lat, lon} from geolocation (or ?at= override)
const customStart = ref(null) // {lat, lon, label} — user-chosen route origin
const walkRoute = shallowRef(null) // {geometry, durationSec, distanceM, station, approx}
const nowcast = shallowRef(null) // radar rain summary for the next ~2 h
const nowcastPoints = shallowRef(null) // raw 5-min radar precipitation series
const radarOn = ref(false)
const radarFrames = shallowRef([]) // ~2 h of radar + 30 min nowcast, 10-min steps
const radarIdx = ref(0) // animation position
const radarInfo = shallowRef(null) // { coverage, nearest: { km, dir } | null } around the city
const recentHistory = shallowRef(null) // rolling 24 h of measured snapshots (collector-fed)
const eventsCal = shallowRef([]) // curated Luxembourg event calendar

const target = computed(() => new Date(now.value.getTime() + offsetHours.value * 3.6e6))

function onGoto(t) {
  if (plannerArmed.value) {
    plannerArmed.value = false
    planTrip({ lat: t.lat, lon: t.lon, label: t.label?.split(',')[0] ?? t.name ?? 'Destination' })
    return
  }
  if (t.stationId) {
    selectedId.value = t.stationId
    flyTarget.value = { lon: t.lon, lat: t.lat, zoom: 15.5, ts: Date.now() }
  } else {
    // searched address becomes the route origin
    customStart.value = { lat: t.lat, lon: t.lon, label: t.label?.split(',')[0] ?? 'Search result' }
    flyTarget.value = { lon: t.lon, lat: t.lat, zoom: 16, ts: Date.now() }
  }
}

function onSetStart(p) {
  customStart.value = { ...p, label: 'Pinned start' }
}

let statusTimer = null
let weatherTimer = null
let nowcastTimer = null
let radarTimer = null
let radarAnimTimer = null
let geoWatchId = null

async function refreshStations() {
  try {
    stations.value = await fetchStations()
    updatedAt.value = new Date()
    now.value = new Date()
    error.value = ''
  } catch (e) {
    error.value = `Live feed unavailable: ${e.message}`
  }
  fetchRecentHistory().then((h) => (recentHistory.value = h))
}

async function refreshWeather() {
  try {
    weather.value = await fetchWeather()
  } catch {
    weather.value = null // weather is optional context; the app works without it
  }
}

async function refreshNowcast() {
  try {
    const points = await fetchRainNowcast()
    nowcastPoints.value = points
    nowcast.value = summarizeNowcast(points)
  } catch {
    nowcastPoints.value = null
    nowcast.value = null
  }
}

async function refreshRadar() {
  // DWD frames are generated locally (WMS TIME dimension); each gets paired
  // with the nearest RainViewer frame for the zoomed-out worldwide layer.
  const frames = dwdRadarFrames()
  let globalFrames = []
  try {
    globalFrames = await fetchGlobalRadarFrames()
  } catch {
    /* zoomed-out layer simply stays off */
  }
  for (const f of frames) {
    let best = null
    let bestD = Infinity
    for (const g of globalFrames) {
      const d = Math.abs(g.time.getTime() - f.time.getTime())
      if (d < bestD) {
        bestD = d
        best = g
      }
    }
    f.global = bestD <= 6 * 60_000 ? best.template : null
  }
  radarFrames.value = frames
  if (radarIdx.value >= frames.length) radarIdx.value = 0
  analyzeRadar()
    .then((info) => (radarInfo.value = info))
    .catch(() => (radarInfo.value = null))
}

const radarFrame = computed(() => radarFrames.value[radarIdx.value] ?? null)
const radarTemplates = computed(() =>
  radarFrames.value.map((f) => ({ dwd: f.template, global: f.global ?? null }))
)

// Makes a rain-free (fully transparent) radar overlay legible as "working,
// just dry" — and points at the nearest rain so you know where to look.
const radarNote = computed(() => {
  if (!radarOn.value || !radarFrames.value.length) return null
  const f = radarFrame.value
  if (!f) {
    const first = radarFrames.value[0]
    const last = radarFrames.value.at(-1)
    const fmt = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    if (target.value.getTime() < first.time.getTime()) {
      return `🕒 radar history starts ${fmt(first.time)} — none this far back`
    }
    return `🕒 radar ends ${fmt(last.time)} — model forecast beyond`
  }
  const t = f.time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const when = f.nowcast ? `${t} +forecast` : t
  const info = radarInfo.value
  if (!info) return `🕒 ${when}`
  if (!info.nearest) return `🕒 ${when} · no rain within ~400 km`
  if (info.nearest.km < 15) return `🕒 ${when} · rain overhead`
  return `🕒 ${when} · nearest rain ~${Math.round(info.nearest.km)} km ${info.nearest.dir} — zoom out`
})

function stepRadar() {
  const n = radarFrames.value.length
  if (n) radarIdx.value = ((radarIdx.value < 0 ? -1 : radarIdx.value) + 1) % n
}

// Live view (offset 0): auto-play the past-2h → +30min loop.
// Scrubbed: show the frame nearest the target time; beyond the radar
// horizon hide the overlay (radarIdx -1 → all layers transparent).
function syncRadarPlayback() {
  clearInterval(radarAnimTimer)
  radarAnimTimer = null
  if (!radarOn.value || !radarFrames.value.length) return
  if (offsetHours.value === 0) {
    if (radarIdx.value < 0) radarIdx.value = 0
    radarAnimTimer = setInterval(stepRadar, 800)
    return
  }
  const t = target.value.getTime()
  let best = -1
  let bestD = Infinity
  radarFrames.value.forEach((f, i) => {
    const d = Math.abs(f.time.getTime() - t)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  radarIdx.value = bestD <= 20 * 60_000 ? best : -1
}

watch(radarOn, (on) => {
  clearInterval(radarTimer)
  if (on) {
    refreshRadar()
    radarTimer = setInterval(refreshRadar, 5 * 60_000)
  } else {
    radarFrames.value = []
    radarIdx.value = 0
  }
  syncRadarPlayback()
})

watch([() => target.value.getTime(), radarFrames], syncRadarPlayback)

function initGeolocation() {
  // ?at=lat,lon simulates a position (testing, or "if I were there")
  const at = new URLSearchParams(location.search).get('at')
  if (at) {
    const [lat, lon] = at.split(',').map(Number)
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      userPos.value = { lat, lon }
      return
    }
  }
  if ('geolocation' in navigator) {
    geoWatchId = navigator.geolocation.watchPosition(
      (p) => (userPos.value = { lat: p.coords.latitude, lon: p.coords.longitude }),
      () => {}, // denied/unavailable → feature simply stays off
      { enableHighAccuracy: false, maximumAge: 30_000, timeout: 15_000 }
    )
  }
}

onMounted(async () => {
  refreshWeather()
  refreshNowcast()
  loadProfiles().then((p) => (profiles.value = p))
  loadEvents().then((e) => (eventsCal.value = e))
  initGeolocation()
  await refreshStations()
  statusTimer = setInterval(refreshStations, 60_000)
  weatherTimer = setInterval(refreshWeather, 30 * 60_000)
  nowcastTimer = setInterval(refreshNowcast, 5 * 60_000)
})

onBeforeUnmount(() => {
  clearInterval(statusTimer)
  clearInterval(weatherTimer)
  clearInterval(nowcastTimer)
  clearInterval(radarTimer)
  clearInterval(radarAnimTimer)
  if (geoWatchId != null) navigator.geolocation.clearWatch(geoWatchId)
})

// Events active at the displayed moment — drives the model adjustment,
// the map pins and the chips.
const activeEvents = computed(() => activeEventsAt(eventsCal.value, target.value))

const predictionCtx = computed(() => ({
  now: now.value,
  profiles: profiles.value,
  globalLiveMean: globalMeanFraction(stations.value),
  events: eventsCal.value,
}))

// Measured snapshot for the scrubbed past moment, when the collector's
// rolling window has one.
const historySnap = computed(() =>
  offsetHours.value < 0 ? historyAt(recentHistory.value, target.value) : null
)

// What the map shows: live values at offset 0, measured history in the
// past (falling back to live when no data), model output in the future.
const displayStations = computed(() => {
  const ctx = predictionCtx.value
  const fc = offsetHours.value > 0 ? forecastAt(weather.value, target.value) : null
  const snap = historySnap.value
  return stations.value.map((s) => {
    if (offsetHours.value < 0) {
      const rec = snap?.s?.[s.id]
      const bikes = rec ? rec[0] : s.bikes
      return {
        id: s.id,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        frac: Math.min(bikes / Math.max(s.capacity, 1), 1),
        bikes,
        predicted: false,
        closed: !s.renting,
      }
    }
    const p = predict(s, target.value, { ...ctx, forecast: fc, activeEvents: activeEvents.value })
    return {
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      frac: p.frac,
      bikes: p.bikes,
      predicted: offsetHours.value > 0,
      closed: !s.renting,
    }
  })
})

// ---- walking route ----
// Origin: pinned/searched start if set, else the user's position.
// Target: the explicitly selected station, else the nearest one with bikes.

const origin = computed(() => customStart.value ?? userPos.value)

const nearest = computed(() =>
  origin.value ? nearestWithBikes(displayStations.value, origin.value) : null
)

const routeTarget = computed(() => {
  if (selectedId.value) {
    const s = displayStations.value.find((x) => x.id === selectedId.value)
    if (s) return s
  }
  return nearest.value?.station ?? null
})

// When both the position and the stations are first known, jump there and
// open the closest station.
watch([userPos, stations], () => {
  if (autoFocused || !userPos.value || !stations.value.length) return
  autoFocused = true
  const p = userPos.value
  let best = null
  let bestD = Infinity
  for (const s of stations.value) {
    const d = haversineM(p, s)
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  flyTarget.value = { lon: p.lon, lat: p.lat, zoom: 15.2, instant: true, ts: Date.now() }
  if (best) selectedId.value = best.id
})

let routeTimer = null
let routeAbort = null
let lastRouteKey = null

watch([origin, () => routeTarget.value?.id ?? null], () => {
  clearTimeout(routeTimer)
  routeTimer = setTimeout(updateRoute, 350)
})

async function updateRoute() {
  const pos = origin.value
  const dest = routeTarget.value
  if (!pos || !dest) {
    walkRoute.value = null
    lastRouteKey = null
    return
  }
  // ~11 m position grid: don't re-route for GPS jitter
  const key = `${dest.id}:${pos.lat.toFixed(4)},${pos.lon.toFixed(4)}`
  if (key === lastRouteKey && walkRoute.value) return
  routeAbort?.abort()
  routeAbort = new AbortController()
  try {
    const r = await walkingRoute(pos, dest, routeAbort.signal)
    walkRoute.value = { ...r, station: dest, approx: false }
    lastRouteKey = key
  } catch (e) {
    if (e.name === 'AbortError') return
    // Router unreachable → straight-line fallback at ~4.9 km/h
    const d = haversineM(pos, dest)
    walkRoute.value = {
      geometry: {
        type: 'LineString',
        coordinates: [
          [pos.lon, pos.lat],
          [dest.lon, dest.lat],
        ],
      },
      durationSec: d / 1.35,
      distanceM: d,
      station: dest,
      approx: true,
    }
    lastRouteKey = key
  }
}

const routeChip = computed(() => {
  const r = walkRoute.value
  if (!r) return null
  const st = displayStations.value.find((s) => s.id === r.station.id) ?? r.station
  const dist = r.distanceM < 950 ? `${Math.round(r.distanceM)} m` : `${(r.distanceM / 1000).toFixed(1)} km`
  return {
    min: Math.max(1, Math.round(r.durationSec / 60)),
    dist,
    name: st.name,
    bikes: st.bikes,
    approx: r.approx,
    id: st.id,
    lat: st.lat,
    lon: st.lon,
    from: customStart.value?.label ?? null,
    toSelected: selectedId.value === st.id,
  }
})

function focusRouteStation() {
  const c = routeChip.value
  if (!c) return
  selectedId.value = c.id
  flyTarget.value = { lon: c.lon, lat: c.lat, zoom: 15.5, ts: Date.now() }
}

function clearStart() {
  customStart.value = null
}

// ---- multi-stop trip planner ----
// Rides are split so no leg exceeds LEG_MAX riding time (vel'OH's free
// half-hour, with margin): along the direct cycling route, a swap station
// (bikes AND free docks) is inserted near each LEG_MAX boundary.
const LEG_MAX_MIN = 25
const plannerArmed = ref(false)
const trip = shallowRef(null) // {geometry, stops, legs, totalMin, dest}
const tripBusy = ref(false)
const tripError = ref('')

function nearestStationWhere(pos, pred, exclude = new Set()) {
  let best = null
  let bestD = Infinity
  for (const s of stations.value) {
    if (exclude.has(s.id) || !pred(s)) continue
    const d = haversineM(pos, s)
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return best ? { station: best, distanceM: bestD } : null
}

async function planTrip(dest) {
  const from = origin.value
  tripError.value = ''
  if (!from) {
    tripError.value = 'No start position — allow location or right-click the map.'
    return
  }
  tripBusy.value = true
  try {
    const used = new Set()
    const start = nearestStationWhere(from, (s) => s.renting && s.bikes >= 1)
    if (!start) throw new Error('no station with bikes near the start')
    used.add(start.station.id)
    const end = nearestStationWhere(dest, (s) => s.returning && s.docks >= 1, used)
    if (!end) throw new Error('no station with free docks near the destination')
    used.add(end.station.id)

    const direct = await bikeRoute([start.station, end.station])
    const swaps = []
    const legMaxSec = LEG_MAX_MIN * 60
    for (let k = 1; k * legMaxSec < direct.durationSec; k++) {
      const p = routePointAtTime(direct.geometry, direct.durationSec, k * legMaxSec)
      if (!p) continue
      const sw = nearestStationWhere(
        p,
        (s) => s.renting && s.returning && s.bikes >= 1 && s.docks >= 1,
        used
      )
      if (sw && sw.distanceM <= 600) {
        swaps.push(sw.station)
        used.add(sw.station.id)
      }
    }

    const points = [start.station, ...swaps, end.station]
    const full = points.length > 2 ? await bikeRoute(points) : direct

    const walkInMin = haversineM(from, start.station) / 1.35 / 60
    const walkOutMin = haversineM(dest, end.station) / 1.35 / 60
    const legs = [
      { type: 'walk', to: start.station.name, min: Math.max(1, Math.round(walkInMin)) },
    ]
    let cumMin = walkInMin
    const stopInfo = []
    points.forEach((st, i) => {
      if (i > 0) {
        const ride = full.legs[i - 1]?.durationSec / 60 ?? 0
        cumMin += ride
        legs.push({ type: 'ride', to: st.name, min: Math.max(1, Math.round(ride)) })
      }
      const eta = new Date(now.value.getTime() + cumMin * 60_000)
      const p = predict(st, eta, { ...predictionCtx.value })
      stopInfo.push({
        id: st.id,
        name: st.name,
        role: i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'swap',
        etaMin: Math.round(cumMin),
        expBikes: p.bikes,
      })
    })
    cumMin += walkOutMin
    legs.push({ type: 'walk', to: dest.label, min: Math.max(1, Math.round(walkOutMin)) })

    trip.value = {
      geometry: full.geometry,
      stops: stopInfo,
      legs,
      totalMin: Math.round(cumMin),
      dest,
    }
    flyTarget.value = { lon: dest.lon, lat: dest.lat, zoom: 13.2, ts: Date.now() }
  } catch (e) {
    tripError.value = `Trip planning failed: ${e.message}`
    trip.value = null
  } finally {
    tripBusy.value = false
  }
}

function clearTrip() {
  trip.value = null
  tripError.value = ''
}

function locateMe() {
  const p = userPos.value
  if (p) {
    flyTarget.value = { lon: p.lon, lat: p.lat, zoom: 15.5, ts: Date.now() }
    return
  }
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userPos.value = { lat: pos.coords.latitude, lon: pos.coords.longitude }
        flyTarget.value = { lon: pos.coords.longitude, lat: pos.coords.latitude, zoom: 15.5, ts: Date.now() }
      },
      () => {}
    )
  }
}

// Big on-map weather readout that follows the time scrubber.
const mapWeather = computed(() => {
  if (!weather.value) return null
  if (offsetHours.value === 0) {
    const { icon, label } = describeWmo(weather.value.current.code)
    return { icon, label, temp: Math.round(weather.value.current.temp), when: 'now', forecast: false }
  }
  const f = forecastAt(weather.value, target.value)
  if (!f) return null
  const { icon, label } = describeWmo(f.code)
  return {
    icon,
    label,
    temp: Math.round(f.temp),
    when: target.value.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    forecast: offsetHours.value > 0,
  }
})

// ---- selected station panel ----

const selectedStation = computed(() => stations.value.find((s) => s.id === selectedId.value) ?? null)

const selectedDisplay = computed(() => {
  const st = selectedStation.value
  if (!st) return null
  if (offsetHours.value < 0) {
    const rec = historySnap.value?.s?.[st.id]
    if (rec) {
      return { frac: Math.min(rec[0] / Math.max(st.capacity, 1), 1), bikes: rec[0], kind: 'history' }
    }
    return { frac: Math.min(st.bikes / Math.max(st.capacity, 1), 1), bikes: st.bikes, kind: 'live' }
  }
  const fc = offsetHours.value > 0 ? forecastAt(weather.value, target.value) : null
  return predict(st, target.value, {
    ...predictionCtx.value,
    forecast: fc,
    activeEvents: activeEvents.value,
  })
})

const selectedSeries = computed(() => {
  if (!selectedStation.value) return []
  // at least 48 h; grows with the scrub so the dot always stays on the chart
  const hours = Math.min(14 * 24, Math.max(48, Math.ceil(offsetHours.value) + 24))
  return predictSeries(selectedStation.value, hours, predictionCtx.value, (t) =>
    forecastAt(weather.value, t)
  )
})

// Birth–death odds for the scrubbed future moment: full probability
// distribution evolved from the live count via learned flow rates.
// ≥3 as a buffer against broken-but-listed bikes (dead motor, brakes).
const availabilityOdds = computed(() => {
  const st = selectedStation.value
  if (!st || offsetHours.value <= 0) return null
  const dist = predictDistribution(st, target.value, { now: now.value, profiles: profiles.value })
  if (!dist) return null
  return {
    p1: Math.round(probAtLeast(dist, 1) * 100),
    p3: Math.round(probAtLeast(dist, 3) * 100),
  }
})

// Events near the selected station at the displayed time — panel chip.
const stationEvents = computed(() => {
  const st = selectedStation.value
  if (!st) return []
  return eventsNear(activeEvents.value, st).map((ev) => ev.name)
})

// Operator-rebalancing hint for the displayed hour: on what fraction of
// observed days did a truck-sized jump (±5 bikes / 5 min) hit this station?
const rebalanceHint = computed(() => {
  const st = selectedStation.value
  const reb = profiles.value?.rebalance?.[st?.id]
  if (!st || !reb) return null
  const t = target.value
  const e = reb[`${dayType(t)}-${t.getHours()}`]
  if (!e) return null
  const [up, down] = e
  return up >= down ? { dir: 'up', pct: Math.round(up * 100) } : { dir: 'down', pct: Math.round(down * 100) }
})
</script>

<template>
  <div class="shell">
    <MapView
      :stations="displayStations"
      :selected-id="selectedId"
      :fly-to="flyTarget"
      :user-pos="userPos"
      :start-pos="customStart"
      :route="walkRoute"
      :radar-frames="radarTemplates"
      :radar-idx="radarIdx"
      :events="activeEvents"
      :trip="trip"
      @select="selectedId = $event"
      @setstart="onSetStart"
    />
    <TopBar
      :stations="stations"
      :weather="weather"
      :profiles="profiles"
      :updated-at="updatedAt"
      :nowcast="nowcast"
      :radar-on="radarOn"
      :radar-note="radarNote"
      :offset-hours="offsetHours"
      :target="target"
      :error="error"
      @toggle-radar="radarOn = !radarOn"
    >
      <SearchBox
        :stations="stations"
        :planner="plannerArmed"
        @goto="onGoto"
        @toggle-planner="plannerArmed = !plannerArmed"
      />
    </TopBar>
    <div v-if="trip || tripBusy || tripError" class="trip-card glass">
      <div class="trip-head">
        <b>🚴 Trip</b>
        <span v-if="trip" class="total">{{ trip.totalMin }} min</span>
        <button class="tclose" @click="clearTrip">✕</button>
      </div>
      <p v-if="tripBusy" class="tdim">planning…</p>
      <p v-else-if="tripError" class="terr">{{ tripError }}</p>
      <template v-else-if="trip">
        <ol class="trip-legs">
          <li v-for="(l, i) in trip.legs" :key="i">
            <span class="ico">{{ l.type === 'walk' ? '🚶' : '🚴' }}</span>
            <span class="dest">{{ l.to }}</span>
            <span class="min">{{ l.min }}′</span>
          </li>
        </ol>
        <p class="tdim" title="Each riding leg stays under the free half hour; expected bikes are the model's forecast for your arrival time">
          swaps keep rides ≤ {{ 25 }}′ · expected on arrival:
          <template v-for="s in trip.stops" :key="s.id"> {{ s.role === 'swap' ? '🔁' : s.role === 'end' ? '🅿' : '🚲' }}~{{ s.expBikes }}</template>
        </p>
      </template>
    </div>
    <StationPanel
      v-if="selectedStation && selectedDisplay"
      :station="selectedStation"
      :display="selectedDisplay"
      :series="selectedSeries"
      :offset-hours="offsetHours"
      :rebalance="rebalanceHint"
      :odds="availabilityOdds"
      :events="stationEvents"
      @close="selectedId = null"
    />
    <button class="locate glass" title="Jump to my location" @click="locateMe">⌖</button>
    <div v-if="mapWeather" class="wx-badge glass" :class="{ fc: mapWeather.forecast }">
      <span class="ico">{{ mapWeather.icon }}</span>
      <span class="deg">{{ mapWeather.temp }}°</span>
      <span class="sub">{{ mapWeather.label }}<br />{{ mapWeather.forecast ? mapWeather.when + ' · forecast' : mapWeather.when }}</span>
    </div>
    <div v-if="routeChip" class="route-chip glass">
      <button class="route-main" @click="focusRouteStation">
        <span class="walk">🚶</span>
        <span class="eta">{{ routeChip.min }} min</span>
        <span class="sub">
          <template v-if="routeChip.from">from {{ routeChip.from }} · </template>
          {{ routeChip.dist }}{{ routeChip.approx ? ' (beeline)' : '' }} →
          {{ routeChip.name }}<template v-if="!routeChip.toSelected"> (nearest)</template> ·
          {{ routeChip.bikes }} 🚲
        </span>
      </button>
      <button v-if="routeChip.from" class="clear-start" title="Back to my position" @click.stop="clearStart">✕</button>
    </div>
    <TimeScrubber
      v-model:offset-hours="offsetHours"
      :now="now"
      :weather="weather"
      :radar-points="nowcastPoints"
      :history-available="offsetHours < 0 ? !!historySnap : null"
      :event-names="activeEvents.map((e) => e.name)"
    />
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  height: 100%;
}

.route-chip {
  position: absolute;
  left: 16px;
  bottom: 18px;
  z-index: 10;
  display: flex;
  align-items: center;
  max-width: min(460px, calc(100% - 32px));
}

.route-main {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 15px;
  cursor: pointer;
  color: var(--text);
  font-family: var(--font);
  background: none;
  border: none;
  text-align: left;
  min-width: 0;
}

.route-chip:hover {
  border-color: rgba(77, 163, 255, 0.45);
}

.route-chip .walk {
  font-size: 17px;
}

.route-chip .eta {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  color: var(--accent-2);
  white-space: nowrap;
}

.route-chip .sub {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.clear-start {
  flex-shrink: 0;
  margin-right: 10px;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-dim);
  cursor: pointer;
  font-size: 11px;
}

.clear-start:hover {
  color: var(--text);
}

.trip-card {
  position: absolute;
  top: 96px;
  left: 16px;
  z-index: 11;
  width: 292px;
  padding: 14px 16px;
  max-height: 50vh;
  overflow-y: auto;
}

.trip-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  font-family: var(--font-display);
}

.trip-head .total {
  color: var(--accent);
  font-weight: 700;
  margin-left: auto;
}

.tclose {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid var(--border);
  color: var(--text-dim);
  width: 24px;
  height: 24px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 11px;
}

.trip-legs {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 8px;
}

.trip-legs li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}

.trip-legs .dest {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trip-legs .min {
  color: var(--accent-2);
  font-weight: 600;
  font-size: 12px;
}

.tdim {
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.5;
}

.terr {
  color: var(--danger);
  font-size: 12px;
}

@media (max-width: 640px) {
  .trip-card {
    top: 150px;
    left: 10px;
    right: 10px;
    width: auto;
  }
}

.locate {
  position: absolute;
  right: 10px;
  bottom: 252px;
  z-index: 10;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  cursor: pointer;
  color: var(--text);
  font-size: 21px;
  line-height: 1;
}

.locate:hover {
  color: var(--accent);
  border-color: rgba(46, 230, 166, 0.4);
}

.wx-badge {
  position: absolute;
  left: 16px;
  bottom: 76px;
  z-index: 9;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 15px;
}

.wx-badge .ico {
  font-size: 25px;
}

.wx-badge .deg {
  font-family: var(--font-display);
  font-size: 27px;
  font-weight: 700;
}

.wx-badge.fc .deg {
  color: var(--warn);
}

.wx-badge .sub {
  font-size: 10.5px;
  color: var(--text-dim);
  line-height: 1.35;
}

/* On narrower windows the right-anchored scrubber would reach the route
   chip — stack the chip above it instead. */
@media (max-width: 1120px) {
  .route-chip {
    bottom: 142px;
  }

  .wx-badge {
    bottom: 200px;
  }
}
</style>
