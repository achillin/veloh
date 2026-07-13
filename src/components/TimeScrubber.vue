<script setup>
import { computed } from 'vue'
import { holidayName } from '../lib/holidays.js'
import { describeWmo, forecastAt } from '../lib/weather.js'

const props = defineProps({
  offsetHours: { type: Number, required: true },
  now: { type: Date, required: true },
  weather: { type: Object, default: null },
  radarPoints: { type: Array, default: null }, // 5-min radar rain nowcast (~2 h)
  historyAvailable: { type: Boolean, default: null }, // measured station data at the scrubbed past time?
})
const emit = defineEmits(['update:offsetHours'])

// -2 h of radar history … +48 h of forecast, in 10-minute steps
const MIN = -2
const MAX = 48
const STEP = 1 / 6

const target = computed(() => new Date(props.now.getTime() + props.offsetHours * 3.6e6))
const holiday = computed(() => holidayName(target.value))

const label = computed(() => {
  if (props.offsetHours === 0) return 'Live · now'
  return target.value.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
})

// Within radar range (~2 h) the rain call comes from the radar nowcast,
// which beats the hourly model; beyond that, the model forecast decides.
const radarRain = computed(() => {
  if (!props.radarPoints?.length || props.offsetHours <= 0) return null
  const t = target.value.getTime()
  const windowPts = props.radarPoints.filter((p) => Math.abs(p.time.getTime() - t) <= 30 * 60_000)
  if (!windowPts.length) return null
  return windowPts.some((p) => p.mmh >= 0.1)
})

const wx = computed(() => {
  if (props.offsetHours === 0) return null
  const f = forecastAt(props.weather, target.value)
  if (!f) return null
  const { icon } = describeWmo(f.code)
  const byRadar = radarRain.value !== null
  const rain = byRadar ? radarRain.value : f.precip >= 0.2 || (f.precipProb ?? 0) >= 60
  return { icon, temp: Math.round(f.temp), rain, byRadar }
})

function onInput(e) {
  // snap to clean 10-minute steps despite float step accumulation
  emit('update:offsetHours', Math.round(Number(e.target.value) * 6) / 6)
}

// Absolute clock times on the axis (short weekday once it's another day)
const ticks = computed(() =>
  [-2, 0, 12, 24, 36, 48].map((h) => {
    if (h === 0) return { h, label: 'now' }
    const d = new Date(props.now.getTime() + h * 3.6e6)
    const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    const label =
      d.getDate() === props.now.getDate()
        ? hm
        : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`
    return { h, label }
  })
)
const tickLeft = (h) => `${(((h - MIN) / (MAX - MIN)) * 100).toFixed(2)}%`
</script>

<template>
  <div class="scrubber glass">
    <div class="row">
      <span class="when" :class="{ live: offsetHours === 0 }">
        <span v-if="offsetHours === 0" class="live-dot"></span>{{ label }}
      </span>
      <span v-if="holiday" class="chip holiday">🎉 {{ holiday }}</span>
      <span v-if="wx" class="chip" :title="wx.byRadar ? 'Rain call from radar nowcast' : 'Rain call from model forecast'">{{ wx.icon }} <b>{{ wx.temp }}°C</b><template v-if="wx.rain">&nbsp;· rain{{ wx.byRadar ? ' (radar)' : ' likely' }}</template></span>
      <span v-if="offsetHours > 0" class="chip fc">forecast</span>
      <span v-if="offsetHours < 0" class="chip hist">{{ historyAvailable ? 'history' : 'history · no station data' }}</span>
    </div>
    <input
      type="range"
      :min="MIN"
      :max="MAX"
      :step="STEP"
      :value="offsetHours"
      @input="onInput"
      aria-label="Time"
    />
    <div class="ticks">
      <span
        v-for="(t, i) in ticks"
        :key="t.h"
        :style="{ left: tickLeft(t.h) }"
        :class="{ first: i === 0, last: i === ticks.length - 1, now: t.h === 0 }"
      >{{ t.label }}</span>
    </div>
  </div>
</template>

<style scoped>
.scrubber {
  position: absolute;
  right: 16px;
  bottom: 18px;
  z-index: 10;
  width: min(560px, calc(100% - 32px));
  padding: 14px 20px 10px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  min-height: 26px;
  flex-wrap: wrap;
}

.when {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 15px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.when.live {
  color: var(--accent);
}

.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: blink 1.4s ease-in-out infinite;
}

@keyframes blink {
  50% {
    opacity: 0.25;
  }
}

.chip.holiday {
  border-color: rgba(77, 163, 255, 0.4);
  color: var(--accent-2);
}

.chip.fc {
  color: var(--warn);
  border-color: rgba(255, 176, 32, 0.35);
}

.chip.hist {
  color: var(--accent-2);
  border-color: rgba(77, 163, 255, 0.35);
}

input[type='range'] {
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  height: 6px;
  border-radius: 3px;
  background: linear-gradient(90deg, rgba(77, 163, 255, 0.7) 0%, var(--accent) 4%, var(--accent-2) 100%);
  outline: none;
  cursor: pointer;
}

input[type='range']::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid var(--accent);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
}

input[type='range']::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid var(--accent);
}

.ticks {
  position: relative;
  height: 15px;
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--text-dim);
}

.ticks span {
  position: absolute;
  transform: translateX(-50%);
  white-space: nowrap;
}

.ticks span.first {
  transform: none;
}

.ticks span.last {
  transform: translateX(-100%);
}

.ticks span.now {
  color: var(--accent);
  font-weight: 600;
}
</style>
