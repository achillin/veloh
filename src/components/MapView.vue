<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import maplibregl from 'maplibre-gl'
import { fracColor } from '../lib/colors.js'
import { installRadarProtocol } from '../lib/radarTiles.js'

installRadarProtocol(maplibregl) // "radar://" composite tiles (idempotent)

const props = defineProps({
  stations: { type: Array, required: true }, // display objects: {id, lat, lon, name, frac, bikes, closed, predicted}
  selectedId: { type: String, default: null },
  flyTo: { type: Object, default: null }, // {lon, lat, zoom, pin?, label?, ts}
  userPos: { type: Object, default: null }, // {lat, lon}
  route: { type: Object, default: null }, // { geometry: GeoJSON LineString }
  startPos: { type: Object, default: null }, // custom route origin {lat, lon, label?}
  radarFrames: { type: Array, default: () => [] }, // [{tpl}] composite radar:// tile templates per frame
  radarIdx: { type: Number, default: 0 }, // which frame is visible (−1 = none)
  events: { type: Array, default: () => [] }, // events active at the displayed time
  trip: { type: Object, default: null }, // planned multi-stop trip {geometry, stops, dest}
})
// radar-shown: tpl now drawn (null = none); radar-progress: {loaded, total} frames ready for this view
const emit = defineEmits(['select', 'setstart', 'radar-shown', 'radar-progress'])

const container = ref(null)
let map = null
let triedFallback = false
let placeMarker = null // pin dropped on a searched address
let userMarker = null // the user's position
let startMarker = null // custom route origin
const markers = new Map() // id → { marker, el }

const ROUTE_SRC = 'walk-route'
const EMPTY_FC = { type: 'FeatureCollection', features: [] }
let lastRouteGeo = EMPTY_FC

const TRIP_SRC = 'trip-route'
let lastTripGeo = EMPTY_FC

// (Re-)adds the route sources + layers; called on load and after any
// setStyle (a style swap drops all custom sources).
function ensureRouteLayers() {
  if (!map) return
  if (!map.getSource(ROUTE_SRC)) {
    map.addSource(ROUTE_SRC, { type: 'geojson', data: lastRouteGeo })
    map.addLayer({
      id: 'walk-route-casing',
      type: 'line',
      source: ROUTE_SRC,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0b0e14', 'line-width': 8, 'line-opacity': 0.55 },
    })
    map.addLayer({
      id: 'walk-route-line',
      type: 'line',
      source: ROUTE_SRC,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#4da3ff', 'line-width': 4, 'line-opacity': 0.9 },
    })
  }
  if (!map.getSource(TRIP_SRC)) {
    map.addSource(TRIP_SRC, { type: 'geojson', data: lastTripGeo })
    map.addLayer({
      id: 'trip-route-casing',
      type: 'line',
      source: TRIP_SRC,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0b0e14', 'line-width': 9, 'line-opacity': 0.55 },
    })
    map.addLayer({
      id: 'trip-route-line',
      type: 'line',
      source: TRIP_SRC,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#2ee6a6', 'line-width': 4.5, 'line-opacity': 0.92 },
    })
  }
}

// Radar frames are composite "radar://" tiles (lib/radarTiles.js): one raster
// source + layer per frame, keyed by its tile template. Every frame of the
// loop gets its layer up front — all visible, all but one fully transparent —
// so the whole loop preloads and stepping only flips raster-opacity (no
// source teardown). A frame is switched to only once its tiles are in, so
// the picture never blanks out, and the parent reads the loaded/total
// progress to start the loop only when it can run seamlessly.
// NB: not gated on isStyleLoaded() — that flag flaps during tile loads.
const radarPool = new Map() // tpl → { srcId, layerId, visibleSince }
let radarSeq = 0
let radarRenders = 0 // completed map renders
let radarShown = null // tpl currently drawn
let radarPending = null // tpl we want drawn as soon as its tiles are loaded
let radarLoaded = -1 // last reported progress
let radarTotal = -1
let styleReady = false // set on first (and every) style load

const RADAR_OPACITY = 0.65
// DWD is a 1 km product: tiles deeper than this are just magnified (z8 ≈
// 200 m/px), which keeps a city view to one or two slow WMS requests per frame.
const RADAR_SOURCE_MAXZOOM = 8

function resetRadarPool() {
  for (const tpl of [...radarPool.keys()]) dropRadarLayer(tpl) // no-ops after a style swap
  radarShown = null
  radarPending = null
  radarLoaded = -1
  emit('radar-shown', null)
}
if (import.meta.env.DEV) {
  window.__radar = {
    pool: radarPool,
    state: () => ({ shown: radarShown, pending: radarPending, renders: radarRenders, loaded: radarLoaded, total: radarTotal }),
  }
}

function dropRadarLayer(tpl) {
  const e = radarPool.get(tpl)
  if (!e) return
  if (map.getLayer(e.layerId)) map.removeLayer(e.layerId)
  if (map.getSource(e.srcId)) map.removeSource(e.srcId)
  radarPool.delete(tpl)
  if (radarShown === tpl) radarShown = null
  if (radarPending === tpl) radarPending = null
}

// MapLibre's isSourceLoaded() is vacuously true for a source no visible layer
// uses, and only meaningful once a render has run with the layer visible —
// that is when its tiles for the current view get requested.
function radarReady(e) {
  return radarRenders > e.visibleSince && map.isSourceLoaded(e.srcId)
}

// loaded/total frames for the current view — the parent gates playback on it
function reportRadarProgress() {
  const frames = props.radarFrames
  let loaded = 0
  for (const f of frames) {
    const e = radarPool.get(f.tpl)
    if (e && radarReady(e)) loaded++
  }
  if (loaded === radarLoaded && frames.length === radarTotal) return
  radarLoaded = loaded
  radarTotal = frames.length
  emit('radar-progress', { loaded, total: frames.length })
}

function ensureRadarLayer(tpl) {
  let entry = radarPool.get(tpl)
  if (entry) return entry
  const srcId = `rain-radar-${radarSeq++}`
  map.addSource(srcId, {
    type: 'raster',
    tiles: [tpl],
    tileSize: 512,
    maxzoom: RADAR_SOURCE_MAXZOOM,
    attribution:
      'Radar © <a href="https://www.dwd.de/" target="_blank">DWD</a> · <a href="https://www.rainviewer.com/" target="_blank">RainViewer</a>',
  })
  map.addLayer(
    {
      id: `${srcId}-l`,
      type: 'raster',
      source: srcId,
      layout: { visibility: 'visible' },
      paint: {
        'raster-opacity': 0,
        'raster-opacity-transition': { duration: 0, delay: 0 }, // flip, don't cross-fade
        'raster-fade-duration': 0,
      },
    },
    map.getLayer('walk-route-casing') ? 'walk-route-casing' : undefined
  )
  entry = { srcId, layerId: `${srcId}-l`, visibleSince: radarRenders }
  radarPool.set(tpl, entry)
  return entry
}

function applyRadarIdx() {
  if (!map || !styleReady) return
  try {
    const frames = props.radarFrames
    const n = frames.length
    const idx = props.radarIdx
    const want = idx >= 0 && idx < n ? frames[idx].tpl : null
    // every frame gets its layer now, starting at the playhead so the tile
    // request queue serves what is needed first
    const start = idx >= 0 ? idx : 0
    for (let k = 0; k < n; k++) ensureRadarLayer(frames[(start + k) % n].tpl)
    let show = radarShown
    if (!want) show = null
    else if (want !== radarShown) {
      // hold the current picture until the next one has its tiles
      if (radarReady(radarPool.get(want)) || !radarShown || !radarPool.has(radarShown)) show = want
    }
    radarPending = want && want !== show ? want : null
    radarPool.forEach((e, tpl) => {
      map.setPaintProperty(e.layerId, 'raster-opacity', tpl === show ? RADAR_OPACITY : 0)
    })
    if (show !== radarShown) emit('radar-shown', show)
    radarShown = show
    // frames that left the list go — except the one on screen, which is held
    // until its replacement has tiles (a refresh renames every nowcast frame)
    const listed = new Set(frames.map((f) => f.tpl))
    for (const tpl of [...radarPool.keys()]) if (!listed.has(tpl) && tpl !== show) dropRadarLayer(tpl)
    reportRadarProgress()
  } catch {
    map.once('idle', applyRadarIdx) // style mid-swap — retry when settled
  }
}

const STYLE_PRIMARY = 'https://tiles.openfreemap.org/styles/dark'
const STYLE_FALLBACK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

function makeMarkerEl(stn) {
  const el = document.createElement('div')
  el.className = 'stn'
  el.innerHTML =
    '<div class="stn-inner"><div class="stn-ring"></div><div class="stn-core"><span></span></div></div>'
  el.addEventListener('click', (e) => {
    e.stopPropagation()
    emit('select', stn.id)
  })
  return el
}

function updateMarkerEl(el, stn, selected) {
  el.style.setProperty('--frac', String(Math.min(Math.max(stn.frac, 0), 1)))
  el.style.setProperty('--col', fracColor(stn.frac))
  el.querySelector('.stn-core span').textContent = stn.bikes
  el.title = `${stn.name} — ${stn.bikes} bikes`
  el.classList.toggle('is-pred', !!stn.predicted)
  el.classList.toggle('is-closed', !!stn.closed)
  el.classList.toggle('is-selected', selected)
  el.classList.toggle('is-stop', !!tripStopIds().has(stn.id))
}

function tripStopIds() {
  return new Set((props.trip?.stops ?? []).map((s) => s.id))
}

function syncMarkers() {
  if (!map) return
  const seen = new Set()
  for (const stn of props.stations) {
    seen.add(stn.id)
    let entry = markers.get(stn.id)
    if (!entry) {
      const el = makeMarkerEl(stn)
      const marker = new maplibregl.Marker({ element: el }).setLngLat([stn.lon, stn.lat]).addTo(map)
      entry = { marker, el }
      markers.set(stn.id, entry)
    }
    updateMarkerEl(entry.el, stn, stn.id === props.selectedId)
  }
  for (const [id, entry] of markers) {
    if (!seen.has(id)) {
      entry.marker.remove()
      markers.delete(id)
    }
  }
}

function fitToStations() {
  if (!map || !props.stations.length) return
  const bounds = new maplibregl.LngLatBounds()
  for (const s of props.stations) bounds.extend([s.lon, s.lat])
  map.fitBounds(bounds, { padding: { top: 90, bottom: 176, left: 60, right: 60 }, maxZoom: 13.5 })
}

let didFit = false

onMounted(() => {
  map = new maplibregl.Map({
    container: container.value,
    style: STYLE_PRIMARY,
    center: [6.13, 49.61],
    zoom: 12.2,
    pitch: 35,
    attributionControl: { compact: true },
    // dozens of pooled radar sources each keep an out-of-view tile cache —
    // two viewports' worth is plenty (default 5)
    maxTileCacheZoomLevels: 2,
  })
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
  if (import.meta.env.DEV) window.__map = map // debugging aid, dev builds only

  map.on('error', (e) => {
    // If the primary vector style is unreachable, fall back to Carto dark matter.
    if (!triedFallback && /style|source|tile/i.test(String(e?.error?.message ?? ''))) {
      triedFallback = true
      map.setStyle(STYLE_FALLBACK)
    }
  })

  map.on('click', () => emit('select', null))
  // 'style.load' fires for the first style too, ahead of 'load' — binding
  // 'load' as well would reset the radar pool a second time and orphan any
  // layers added in between (e.g. radar switched on during a slow first paint).
  map.on('style.load', () => {
    styleReady = true
    ensureRouteLayers()
    resetRadarPool() // a style swap dropped the layers with it
    applyRadarIdx()
  })
  // Every tile arrival repaints; once the frame we are waiting for has its
  // tiles (after at least one render with its layer visible), switch to it.
  map.on('render', () => {
    radarRenders++
    const e = radarPending && radarPool.get(radarPending)
    if (e && radarReady(e)) applyRadarIdx()
    else if (radarPool.size) reportRadarProgress()
  })

  // right-click (long-press on touch) sets a custom route origin
  map.on('contextmenu', (e) => {
    e.preventDefault()
    emit('setstart', { lat: e.lngLat.lat, lon: e.lngLat.lng })
  })

  const applyScale = () => {
    const z = map.getZoom()
    const scale = Math.min(Math.max((z - 9.5) / 3.5, 0.5), 1.1)
    container.value?.style.setProperty('--mscale', scale.toFixed(3))
  }
  map.on('zoom', applyScale)
  applyScale()

  syncMarkers()
})

onBeforeUnmount(() => {
  markers.forEach((m) => m.marker.remove())
  markers.clear()
  eventMarkers.forEach((m) => m.remove())
  eventMarkers.clear()
  tripDestMarker?.remove()
  placeMarker?.remove()
  userMarker?.remove()
  startMarker?.remove()
  map?.remove()
})

watch(() => props.radarFrames, applyRadarIdx)
watch(() => props.radarIdx, applyRadarIdx)

// 🎪 pins for events active at the displayed time
const eventMarkers = new Map() // event id → Marker
watch(
  () => props.events,
  (evs) => {
    if (!map) return
    const seen = new Set()
    for (const ev of evs) {
      seen.add(ev.id)
      if (!eventMarkers.has(ev.id)) {
        const el = document.createElement('div')
        el.className = 'event-pin'
        el.textContent = '🎪'
        el.title = ev.name
        eventMarkers.set(
          ev.id,
          new maplibregl.Marker({ element: el, anchor: 'bottom' })
            .setLngLat([ev.lon, ev.lat])
            .addTo(map)
        )
      }
    }
    for (const [id, m] of eventMarkers) {
      if (!seen.has(id)) {
        m.remove()
        eventMarkers.delete(id)
      }
    }
  },
  { immediate: true }
)

watch(
  () => props.startPos,
  (p) => {
    if (!map) return
    if (!p) {
      startMarker?.remove()
      startMarker = null
      return
    }
    if (!startMarker) {
      const el = document.createElement('div')
      el.className = 'start-pin'
      startMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([p.lon, p.lat])
        .addTo(map)
    } else {
      startMarker.setLngLat([p.lon, p.lat])
    }
    startMarker.getElement().title = p.label ?? 'Route start'
  },
  { immediate: true }
)

watch(
  () => props.userPos,
  (p) => {
    if (!map) return
    if (!p) {
      userMarker?.remove()
      userMarker = null
      return
    }
    if (!userMarker) {
      const el = document.createElement('div')
      el.className = 'user-dot'
      el.title = 'You are here'
      userMarker = new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map)
    } else {
      userMarker.setLngLat([p.lon, p.lat])
    }
  },
  { immediate: true }
)

watch(
  () => props.route,
  (r) => {
    lastRouteGeo = r?.geometry
      ? { type: 'Feature', properties: {}, geometry: r.geometry }
      : EMPTY_FC
    map?.getSource(ROUTE_SRC)?.setData(lastRouteGeo)
  }
)

let tripDestMarker = null
watch(
  () => props.trip,
  (t) => {
    lastTripGeo = t?.geometry
      ? { type: 'Feature', properties: {}, geometry: t.geometry }
      : EMPTY_FC
    map?.getSource(TRIP_SRC)?.setData(lastTripGeo)
    tripDestMarker?.remove()
    tripDestMarker = null
    if (t?.dest && map) {
      const el = document.createElement('div')
      el.className = 'place-pin'
      el.title = t.dest.label ?? 'Destination'
      tripDestMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([t.dest.lon, t.dest.lat])
        .addTo(map)
    }
    syncMarkers() // refresh swap-stop highlights
  }
)

watch(
  () => props.flyTo,
  (t) => {
    if (!t || !map) return
    didFit = true // an explicit fly supersedes the initial fit-to-stations
    placeMarker?.remove()
    placeMarker = null
    if (t.pin) {
      const el = document.createElement('div')
      el.className = 'place-pin'
      el.title = t.label ?? ''
      placeMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([t.lon, t.lat])
        .addTo(map)
    }
    map.flyTo({
      center: [t.lon, t.lat],
      zoom: t.zoom ?? 15,
      essential: true,
      // instant jumps (startup auto-focus) also work in background tabs,
      // where rAF-driven animations don't tick
      ...(t.instant ? { duration: 0 } : {}),
    })
  }
)

watch(
  () => [props.stations, props.selectedId],
  () => {
    syncMarkers()
    if (!didFit && props.stations.length) {
      didFit = true
      fitToStations()
    }
  },
  { deep: false }
)
</script>

<template>
  <div ref="container" class="map-root"></div>
</template>

<style scoped>
.map-root {
  position: absolute;
  inset: 0;
}
</style>
