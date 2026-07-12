<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue'

const props = defineProps({
  stations: { type: Array, required: true },
})
const emit = defineEmits(['goto'])

const q = ref('')
const open = ref(false)
const activeIdx = ref(0)
const places = ref([]) // Nominatim results
const root = ref(null)

const strip = (s) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')

const stationMatches = computed(() => {
  const needle = strip(q.value.trim())
  if (needle.length < 2) return []
  const scored = []
  for (const s of props.stations) {
    const name = strip(s.name)
    const addr = strip(s.address)
    const inName = name.indexOf(needle)
    const inAddr = addr.indexOf(needle)
    if (inName === -1 && inAddr === -1) continue
    scored.push([inName === -1 ? 100 + inAddr : inName, s])
  }
  scored.sort((a, b) => a[0] - b[0])
  return scored.slice(0, 6).map(([, s]) => s)
})

// Geocode free-form addresses via Nominatim (OSM), limited to Luxembourg.
let debounceTimer = null
let inflight = null
watch(q, (val) => {
  clearTimeout(debounceTimer)
  inflight?.abort()
  if (strip(val.trim()).length < 4) {
    places.value = []
    return
  }
  debounceTimer = setTimeout(async () => {
    inflight = new AbortController()
    try {
      const url =
        'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=4&countrycodes=lu&q=' +
        encodeURIComponent(val.trim())
      const res = await fetch(url, { signal: inflight.signal })
      if (!res.ok) return
      const j = await res.json()
      places.value = j.map((p) => ({
        label: p.display_name,
        lat: Number(p.lat),
        lon: Number(p.lon),
      }))
    } catch {
      /* aborted or offline — station search still works */
    }
  }, 450)
})

const results = computed(() => [
  ...stationMatches.value.map((s) => ({ type: 'station', station: s })),
  ...places.value.map((p) => ({ type: 'place', ...p })),
])

watch(results, () => (activeIdx.value = 0))

function select(r) {
  if (!r) return
  if (r.type === 'station') {
    emit('goto', { stationId: r.station.id, lon: r.station.lon, lat: r.station.lat })
  } else {
    emit('goto', { lon: r.lon, lat: r.lat, label: r.label })
  }
  open.value = false
}

function onKey(e) {
  if (!open.value || !results.value.length) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIdx.value = (activeIdx.value + 1) % results.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIdx.value = (activeIdx.value - 1 + results.value.length) % results.value.length
  } else if (e.key === 'Enter') {
    select(results.value[activeIdx.value])
  } else if (e.key === 'Escape') {
    open.value = false
  }
}

function onDocClick(e) {
  if (root.value && !root.value.contains(e.target)) open.value = false
}
document.addEventListener('click', onDocClick)
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div ref="root" class="search glass">
    <span class="icon">⌕</span>
    <input
      v-model="q"
      type="search"
      placeholder="Search station or address…"
      spellcheck="false"
      @focus="open = true"
      @input="open = true"
      @keydown="onKey"
    />
    <ul v-if="open && results.length" class="results">
      <li
        v-for="(r, i) in results"
        :key="r.type === 'station' ? `s${r.station.id}` : `p${i}`"
        :class="{ active: i === activeIdx }"
        @mouseenter="activeIdx = i"
        @mousedown.prevent="select(r)"
      >
        <template v-if="r.type === 'station'">
          <span class="tag stn-tag">station</span>
          <span class="label">{{ r.station.name }}</span>
          <span class="meta">{{ r.station.bikes }} 🚲</span>
        </template>
        <template v-else>
          <span class="tag place-tag">address</span>
          <span class="label">{{ r.label }}</span>
        </template>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* lives inside the TopBar flex row — no overlay positioning */
.search {
  position: relative;
  flex: 1 1 240px;
  min-width: 200px;
  max-width: 360px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  border-radius: 12px;
}

.icon {
  color: var(--text-dim);
  font-size: 18px;
  transform: rotate(-45deg);
}

input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font: 500 13px var(--font);
  padding: 9px 8px;
}

input::placeholder {
  color: var(--text-dim);
}

input::-webkit-search-cancel-button {
  filter: invert(0.7);
}

.results {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 30;
  width: max(100%, 300px);
  list-style: none;
  background: var(--panel-solid);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5);
}

.results li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  font-size: 12.5px;
  cursor: pointer;
}

.results li.active {
  background: rgba(46, 230, 166, 0.1);
}

.tag {
  flex-shrink: 0;
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 2px 6px;
  border-radius: 5px;
}

.stn-tag {
  color: var(--accent);
  background: rgba(46, 230, 166, 0.12);
}

.place-tag {
  color: var(--accent-2);
  background: rgba(77, 163, 255, 0.12);
}

.label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  flex-shrink: 0;
  color: var(--text-dim);
  font-size: 11.5px;
}
</style>
