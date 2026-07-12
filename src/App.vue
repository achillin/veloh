<script setup>
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import MapView from './components/MapView.vue'
import TopBar from './components/TopBar.vue'
import TimeScrubber from './components/TimeScrubber.vue'
import StationPanel from './components/StationPanel.vue'
import SearchBox from './components/SearchBox.vue'
import { fetchStations } from './lib/gbfs.js'
import { fetchWeather, forecastAt } from './lib/weather.js'
import { loadProfiles, predict, predictSeries, globalMeanFraction } from './lib/predictor.js'
import { walkingRoute, nearestWithBikes, haversineM } from './lib/routing.js'
import { fetchRainNowcast, summarizeNowcast, fetchRadarTiles } from './lib/radar.js'

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
const radarTiles = ref(null)

function onGoto(t) {
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
  try {
    radarTiles.value = await fetchRadarTiles()
  } catch {
    radarTiles.value = null
  }
}

watch(radarOn, (on) => {
  clearInterval(radarTimer)
  if (on) {
    refreshRadar()
    radarTimer = setInterval(refreshRadar, 5 * 60_000)
  } else {
    radarTiles.value = null
  }
})

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
  if (geoWatchId != null) navigator.geolocation.clearWatch(geoWatchId)
})

const predictionCtx = computed(() => ({
  now: now.value,
  profiles: profiles.value,
  globalLiveMean: globalMeanFraction(stations.value),
}))

const target = computed(() => new Date(now.value.getTime() + offsetHours.value * 3.6e6))

// What the map shows: live values at offset 0, model output otherwise.
const displayStations = computed(() => {
  const ctx = predictionCtx.value
  const fc = offsetHours.value > 0 ? forecastAt(weather.value, target.value) : null
  return stations.value.map((s) => {
    const p = predict(s, target.value, { ...ctx, forecast: fc })
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

// ---- selected station panel ----

const selectedStation = computed(() => stations.value.find((s) => s.id === selectedId.value) ?? null)

const selectedDisplay = computed(() => {
  if (!selectedStation.value) return null
  const fc = offsetHours.value > 0 ? forecastAt(weather.value, target.value) : null
  return predict(selectedStation.value, target.value, { ...predictionCtx.value, forecast: fc })
})

const selectedSeries = computed(() => {
  if (!selectedStation.value) return []
  return predictSeries(selectedStation.value, 24, predictionCtx.value, (t) =>
    forecastAt(weather.value, t)
  )
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
      :radar="radarTiles"
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
      :offset-hours="offsetHours"
      :target="target"
      :error="error"
      @toggle-radar="radarOn = !radarOn"
    >
      <SearchBox :stations="stations" @goto="onGoto" />
    </TopBar>
    <StationPanel
      v-if="selectedStation && selectedDisplay"
      :station="selectedStation"
      :display="selectedDisplay"
      :series="selectedSeries"
      :offset-hours="offsetHours"
      @close="selectedId = null"
    />
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

/* On narrower windows the right-anchored scrubber would reach the route
   chip — stack the chip above it instead. */
@media (max-width: 1120px) {
  .route-chip {
    bottom: 142px;
  }
}
</style>
