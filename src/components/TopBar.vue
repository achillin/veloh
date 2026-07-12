<script setup>
import { computed } from 'vue'
import { describeWmo, forecastAt } from '../lib/weather.js'

const props = defineProps({
  stations: { type: Array, required: true }, // live station objects
  weather: { type: Object, default: null },
  profiles: { type: Object, default: null },
  updatedAt: { type: Date, default: null },
  nowcast: { type: Object, default: null }, // radar rain summary (~2 h)
  radarOn: { type: Boolean, default: false },
  radarNote: { type: String, default: null }, // frame time + coverage hint
  offsetHours: { type: Number, default: 0 }, // scrubbed time offset
  target: { type: Date, default: null }, // scrubbed target time
  error: { type: String, default: '' },
})

defineEmits(['toggle-radar'])

const hhmm = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

const rain = computed(() => {
  const n = props.nowcast
  if (!n) return null
  if (n.raining) {
    return { cls: 'wet', text: `☔ raining${n.until ? ` until ~${hhmm(n.until)}` : ''}` }
  }
  if (n.startsAt) return { cls: 'soon', text: `☔ rain ~${hhmm(n.startsAt)}` }
  return { cls: 'dry', text: '☂ dry next 2 h' }
})

const bikesNow = computed(() => props.stations.reduce((a, s) => a + s.bikes, 0))
const emptyCount = computed(() => props.stations.filter((s) => s.renting && s.bikes === 0).length)
const fullCount = computed(() => props.stations.filter((s) => s.returning && s.docks === 0).length)

// Follows the time scrubber: current conditions at "now", the hourly value
// for the scrubbed time otherwise (the hourly series covers today's past
// hours too, so radar-history scrubbing keeps a sensible temperature).
const wx = computed(() => {
  if (!props.weather) return null
  if (props.offsetHours !== 0 && props.target) {
    const f = forecastAt(props.weather, props.target)
    if (f) {
      const { icon, label } = describeWmo(f.code)
      return { icon, label, temp: Math.round(f.temp), forecast: props.offsetHours > 0 }
    }
  }
  const { icon, label } = describeWmo(props.weather.current.code)
  return { icon, label, temp: Math.round(props.weather.current.temp), forecast: false }
})

const modelLabel = computed(() =>
  props.profiles
    ? `Model · ${Number(props.profiles.snapshots ?? 0).toLocaleString('en')} snapshots`
    : 'Learning mode — collecting data'
)

const updatedLabel = computed(() => {
  if (!props.updatedAt) return '…'
  return props.updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
})
</script>

<template>
  <header class="topbar glass">
    <div class="brand">
      <div class="logo">
        <svg viewBox="0 0 100 100" width="26" height="26">
          <circle cx="50" cy="50" r="42" fill="none" stroke="var(--accent)" stroke-width="12" stroke-dasharray="180 84" stroke-linecap="round" transform="rotate(-90 50 50)" />
          <circle cx="50" cy="50" r="14" fill="var(--accent)" />
        </svg>
      </div>
      <div>
        <h1>vel'OH <span>pulse</span></h1>
        <p>Luxembourg · live availability &amp; forecast</p>
      </div>
    </div>

    <slot />

    <div class="chips">
      <button class="chip radar-btn" :class="{ on: radarOn }" title="Rain radar overlay (RainViewer)" @click="$emit('toggle-radar')">☔ Radar</button>
      <span class="chip radar-note" v-if="radarNote">{{ radarNote }}</span>
      <span class="chip"><span class="dot" style="background: var(--accent)"></span><b>{{ bikesNow }}</b>&nbsp;bikes now</span>
      <span class="chip"><b>{{ stations.length }}</b>&nbsp;stations</span>
      <span class="chip" v-if="emptyCount"><span class="dot" style="background: var(--danger)"></span><b>{{ emptyCount }}</b>&nbsp;empty</span>
      <span class="chip" v-if="fullCount"><span class="dot" style="background: var(--warn)"></span><b>{{ fullCount }}</b>&nbsp;full</span>
      <span class="chip" v-if="wx" :class="{ fc: wx.forecast }">{{ wx.icon }}&nbsp;<b>{{ wx.temp }}°C</b>&nbsp;{{ wx.label }}<template v-if="wx.forecast">&nbsp;· forecast</template></span>
      <span class="chip rain" v-if="rain" :class="rain.cls" title="Radar nowcast (Buienradar)">{{ rain.text }}</span>
      <span class="chip model" :class="{ trained: !!profiles }">{{ modelLabel }}</span>
      <span class="chip">⟳ {{ updatedLabel }}</span>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
  </header>
</template>

<style scoped>
.topbar {
  position: absolute;
  top: 16px;
  left: 16px;
  right: 16px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 12px 18px;
  flex-wrap: wrap;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 12px;
  background: rgba(46, 230, 166, 0.1);
  border: 1px solid rgba(46, 230, 166, 0.25);
}

h1 {
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.2px;
}

h1 span {
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.brand p {
  font-size: 11.5px;
  color: var(--text-dim);
  margin-top: 1px;
}

.chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-left: auto;
  align-items: center;
}

.chip.model {
  border-color: rgba(255, 176, 32, 0.35);
  color: var(--warn);
}

.chip.model.trained {
  border-color: rgba(46, 230, 166, 0.35);
  color: var(--accent);
}

.chip.rain.wet {
  color: var(--accent-2);
  border-color: rgba(77, 163, 255, 0.45);
}

.chip.rain.soon {
  color: var(--warn);
  border-color: rgba(255, 176, 32, 0.35);
}

.chip.fc {
  color: var(--warn);
  border-color: rgba(255, 176, 32, 0.35);
}

.chip.radar-btn {
  cursor: pointer;
  font: 500 12px var(--font);
}

.chip.radar-btn:hover {
  color: var(--text);
}

.chip.radar-btn.on {
  color: var(--accent-2);
  border-color: rgba(77, 163, 255, 0.45);
}

.chip.radar-note {
  color: var(--accent-2);
  border-color: rgba(77, 163, 255, 0.25);
}

.err {
  flex-basis: 100%;
  color: var(--danger);
  font-size: 12.5px;
}
</style>
