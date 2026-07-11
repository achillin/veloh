<script setup>
import { computed, onMounted, onBeforeUnmount, ref, shallowRef } from 'vue'
import MapView from './components/MapView.vue'
import TopBar from './components/TopBar.vue'
import TimeScrubber from './components/TimeScrubber.vue'
import StationPanel from './components/StationPanel.vue'
import SearchBox from './components/SearchBox.vue'
import { fetchStations } from './lib/gbfs.js'
import { fetchWeather, forecastAt } from './lib/weather.js'
import { loadProfiles, predict, predictSeries, globalMeanFraction } from './lib/predictor.js'

const stations = shallowRef([])
const profiles = shallowRef(null)
const weather = shallowRef(null)
const updatedAt = ref(null)
const now = ref(new Date())
const offsetHours = ref(0)
const selectedId = ref(null)
const error = ref('')
const flyTarget = ref(null)

function onGoto(t) {
  if (t.stationId) {
    selectedId.value = t.stationId
    flyTarget.value = { lon: t.lon, lat: t.lat, zoom: 15.5, ts: Date.now() }
  } else {
    flyTarget.value = { lon: t.lon, lat: t.lat, zoom: 16, pin: true, label: t.label, ts: Date.now() }
  }
}

let statusTimer = null
let weatherTimer = null

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

onMounted(async () => {
  refreshWeather()
  loadProfiles().then((p) => (profiles.value = p))
  await refreshStations()
  statusTimer = setInterval(refreshStations, 60_000)
  weatherTimer = setInterval(refreshWeather, 30 * 60_000)
})

onBeforeUnmount(() => {
  clearInterval(statusTimer)
  clearInterval(weatherTimer)
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
      @select="selectedId = $event"
    />
    <SearchBox :stations="stations" @goto="onGoto" />
    <TopBar
      :stations="stations"
      :weather="weather"
      :profiles="profiles"
      :updated-at="updatedAt"
      :error="error"
    />
    <StationPanel
      v-if="selectedStation && selectedDisplay"
      :station="selectedStation"
      :display="selectedDisplay"
      :series="selectedSeries"
      :offset-hours="offsetHours"
      @close="selectedId = null"
    />
    <TimeScrubber v-model:offset-hours="offsetHours" :now="now" :weather="weather" />
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  height: 100%;
}
</style>
