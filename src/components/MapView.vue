<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import maplibregl from 'maplibre-gl'
import { fracColor } from '../lib/colors.js'

const props = defineProps({
  stations: { type: Array, required: true }, // display objects: {id, lat, lon, name, frac, bikes, closed, predicted}
  selectedId: { type: String, default: null },
  flyTo: { type: Object, default: null }, // {lon, lat, zoom, pin?, label?, ts}
  userPos: { type: Object, default: null }, // {lat, lon}
  route: { type: Object, default: null }, // { geometry: GeoJSON LineString }
  startPos: { type: Object, default: null }, // custom route origin {lat, lon, label?}
  radar: { type: String, default: null }, // rain-radar raster tile URL template
})
const emit = defineEmits(['select', 'setstart'])

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

// (Re-)adds the route source + layers; called on load and after any
// setStyle (a style swap drops all custom sources).
function ensureRouteLayers() {
  if (!map || map.getSource(ROUTE_SRC)) return
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

const RADAR_SRC = 'rain-radar'
let styleReady = false // set on first (and every) style load

// Raster tile URLs can't be swapped in place — drop & re-add the source.
// Also re-applied after a style swap (which wipes custom sources).
// NB: not gated on isStyleLoaded() — that flag flaps during tile loads.
function applyRadar() {
  if (!map || !styleReady) return
  try {
    if (map.getLayer('rain-radar-layer')) map.removeLayer('rain-radar-layer')
    if (map.getSource(RADAR_SRC)) map.removeSource(RADAR_SRC)
    if (!props.radar) return
    map.addSource(RADAR_SRC, {
      type: 'raster',
      tiles: [props.radar],
      tileSize: 512,
      // RainViewer's radar composite serves real data only up to z7 (probed:
      // z8+ returns "Zoom level not supported" images) — overzoom from there
      maxzoom: 7,
      attribution: 'Radar © RainViewer',
    })
    map.addLayer(
      {
        id: 'rain-radar-layer',
        type: 'raster',
        source: RADAR_SRC,
        // no fade-in: the animation swaps frames every ~800 ms and cached
        // tiles should appear instantly instead of blinking
        paint: { 'raster-opacity': 0.6, 'raster-fade-duration': 0 },
      },
      map.getLayer('walk-route-casing') ? 'walk-route-casing' : undefined
    )
  } catch {
    map.once('idle', applyRadar) // style mid-swap — retry when settled
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
  map.fitBounds(bounds, { padding: { top: 90, bottom: 130, left: 60, right: 60 }, maxZoom: 13.5 })
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
  const onStyleReady = () => {
    styleReady = true
    ensureRouteLayers()
    applyRadar()
  }
  map.on('load', onStyleReady)
  map.on('style.load', onStyleReady)

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
  placeMarker?.remove()
  userMarker?.remove()
  startMarker?.remove()
  map?.remove()
})

watch(() => props.radar, applyRadar)

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

watch(
  () => props.flyTo,
  (t) => {
    if (!t || !map) return
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
    map.flyTo({ center: [t.lon, t.lat], zoom: t.zoom ?? 15, essential: true })
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
