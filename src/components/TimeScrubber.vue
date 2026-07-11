<script setup>
import { computed } from 'vue'
import { holidayName } from '../lib/holidays.js'
import { describeWmo, forecastAt } from '../lib/weather.js'

const props = defineProps({
  offsetHours: { type: Number, required: true },
  now: { type: Date, required: true },
  weather: { type: Object, default: null },
})
const emit = defineEmits(['update:offsetHours'])

const HORIZON = 48

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

const wx = computed(() => {
  if (props.offsetHours === 0) return null
  const f = forecastAt(props.weather, target.value)
  if (!f) return null
  const { icon } = describeWmo(f.code)
  const rain = f.precip >= 0.2 || (f.precipProb ?? 0) >= 60
  return { icon, temp: Math.round(f.temp), rain }
})

function onInput(e) {
  emit('update:offsetHours', Number(e.target.value))
}

const ticks = [0, 12, 24, 36, 48]
function tickLabel(h) {
  if (h === 0) return 'now'
  return `+${h}h`
}
</script>

<template>
  <div class="scrubber glass">
    <div class="row">
      <span class="when" :class="{ live: offsetHours === 0 }">
        <span v-if="offsetHours === 0" class="live-dot"></span>{{ label }}
      </span>
      <span v-if="holiday" class="chip holiday">🎉 {{ holiday }}</span>
      <span v-if="wx" class="chip">{{ wx.icon }} <b>{{ wx.temp }}°C</b><template v-if="wx.rain">&nbsp;· rain likely</template></span>
      <span v-if="offsetHours > 0" class="chip fc">forecast</span>
    </div>
    <input
      type="range"
      min="0"
      :max="HORIZON"
      step="1"
      :value="offsetHours"
      @input="onInput"
      aria-label="Forecast time"
    />
    <div class="ticks">
      <span v-for="t in ticks" :key="t">{{ tickLabel(t) }}</span>
    </div>
  </div>
</template>

<style scoped>
.scrubber {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
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

input[type='range'] {
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  height: 6px;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
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
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--text-dim);
}
</style>
