<script setup>
import { computed, ref } from 'vue'
import { holidayName } from '../lib/holidays.js'
import { describeWmo, forecastAt } from '../lib/weather.js'

const props = defineProps({
  offsetHours: { type: Number, required: true },
  now: { type: Date, required: true },
  weather: { type: Object, default: null },
  radarPoints: { type: Array, default: null }, // 5-min radar rain nowcast (~2 h)
  historyAvailable: { type: Boolean, default: null }, // measured station data at the scrubbed past time?
  eventNames: { type: Array, default: () => [] }, // events active at the displayed time
})
const emit = defineEmits(['update:offsetHours'])

// 24 h of measured history … 14 days of forecast. One slider can't carry
// that at 10-min resolution, so the control is two-stage: pick a DAY, then
// slide the time WITHIN that day (plus ±10 min nudges and a full
// date-time picker for exact jumps).
const MIN_H = -24
const MAX_H = 14 * 24

const target = computed(() => new Date(props.now.getTime() + props.offsetHours * 3.6e6))
const holiday = computed(() => holidayName(target.value))

const dtInput = ref(null)

function clampOffset(h) {
  return Math.min(MAX_H, Math.max(MIN_H, Math.round(h * 6) / 6))
}

function setOffset(h) {
  emit('update:offsetHours', clampOffset(h))
}

// ---- day strip ----
const startOfToday = computed(() => {
  const d = new Date(props.now)
  d.setHours(0, 0, 0, 0)
  return d
})

const dayIndex = computed(() => {
  const t = new Date(target.value)
  t.setHours(0, 0, 0, 0)
  return Math.round((t.getTime() - startOfToday.value.getTime()) / 86400_000)
})

const timeOfDay = computed(
  () => target.value.getHours() + target.value.getMinutes() / 60
)

const days = computed(() =>
  Array.from({ length: 16 }, (_, i) => i - 1).map((d) => {
    const date = new Date(startOfToday.value)
    date.setDate(date.getDate() + d)
    const label =
      d === -1
        ? 'Yesterday'
        : d === 0
          ? 'Today'
          : date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })
    return { d, label }
  })
)

function offsetFor(dayIdx, hourOfDay) {
  const date = new Date(startOfToday.value)
  date.setDate(date.getDate() + dayIdx)
  date.setHours(0, Math.round(hourOfDay * 60), 0, 0)
  return (date.getTime() - props.now.getTime()) / 3.6e6
}

function pickDay(d) {
  setOffset(d === 0 && Math.abs(offsetFor(0, timeOfDay.value)) < 0.01 ? 0 : offsetFor(d, timeOfDay.value))
}

function onSlider(e) {
  setOffset(offsetFor(dayIndex.value, Number(e.target.value)))
}

function nudge(min) {
  setOffset(props.offsetHours + min / 60)
}

// ---- exact date-time jump ----
const dtValue = computed(() => {
  const t = target.value
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}`
})

function onDatetime(e) {
  const t = Date.parse(e.target.value)
  if (Number.isFinite(t)) setOffset((t - props.now.getTime()) / 3.6e6)
}

// ---- labels & chips ----
const label = computed(() => {
  if (props.offsetHours === 0) {
    return `Live · ${props.now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
  }
  return target.value.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
})

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

const shownEvents = computed(() => props.eventNames.slice(0, 2))
const moreEvents = computed(() => Math.max(0, props.eventNames.length - 2))

const hourTicks = [0, 6, 12, 18, 24]
</script>

<template>
  <div class="scrubber glass">
    <div class="row">
      <span class="when" :class="{ live: offsetHours === 0 }">
        <span v-if="offsetHours === 0" class="live-dot"></span>{{ label }}
      </span>
      <span v-if="holiday" class="chip holiday">🎉 {{ holiday }}</span>
      <span v-for="ev in shownEvents" :key="ev" class="chip event">🎪 {{ ev }}</span>
      <span v-if="moreEvents" class="chip event">+{{ moreEvents }} more</span>
      <span v-if="wx" class="chip" :title="wx.byRadar ? 'Rain call from radar nowcast' : 'Rain call from model forecast'">{{ wx.icon }} <b>{{ wx.temp }}°C</b><template v-if="wx.rain">&nbsp;· rain{{ wx.byRadar ? ' (radar)' : ' likely' }}</template></span>
      <span v-if="offsetHours > 0" class="chip fc">forecast</span>
      <span v-if="offsetHours < 0" class="chip hist">{{ historyAvailable ? 'history' : 'history · no station data' }}</span>
      <span class="spacer"></span>
      <button v-if="offsetHours !== 0" class="btn now" @click="setOffset(0)">Now</button>
      <label class="btn cal" title="Jump to an exact date & time">
        📅
        <input
          ref="dtInput"
          type="datetime-local"
          :value="dtValue"
          @change="onDatetime"
        />
      </label>
    </div>

    <div class="days">
      <button
        v-for="d in days"
        :key="d.d"
        class="day"
        :class="{ on: d.d === dayIndex }"
        @click="pickDay(d.d)"
      >{{ d.label }}</button>
    </div>

    <div class="slider-row">
      <button class="btn nudge" title="10 minutes back" @click="nudge(-10)">−10m</button>
      <div class="slider-wrap">
        <input
          type="range"
          :min="0"
          :max="24"
          :step="1 / 6"
          :value="timeOfDay"
          @input="onSlider"
          aria-label="Time of day"
        />
        <div class="ticks">
          <span
            v-for="h in hourTicks"
            :key="h"
            :style="{ left: `${(h / 24) * 100}%` }"
            :class="{ first: h === 0, last: h === 24 }"
          >{{ String(h % 24).padStart(2, '0') }}:00</span>
        </div>
      </div>
      <button class="btn nudge" title="10 minutes forward" @click="nudge(10)">+10m</button>
    </div>
  </div>
</template>

<style scoped>
.scrubber {
  position: absolute;
  right: 16px;
  bottom: 18px;
  z-index: 10;
  width: min(600px, calc(100% - 32px));
  padding: 12px 16px 8px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  min-height: 26px;
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.when {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 14.5px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
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

.chip.event {
  color: #ffb0e6;
  border-color: rgba(255, 176, 230, 0.4);
}

.chip.fc {
  color: var(--warn);
  border-color: rgba(255, 176, 32, 0.35);
}

.chip.hist {
  color: var(--accent-2);
  border-color: rgba(77, 163, 255, 0.35);
}

.btn {
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
  border-radius: 9px;
  cursor: pointer;
  font: 600 12px var(--font);
  padding: 5px 10px;
}

.btn:hover {
  border-color: rgba(46, 230, 166, 0.4);
}

.btn.now {
  color: var(--accent);
}

.btn.cal {
  position: relative;
  overflow: hidden;
}

.btn.cal input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.days {
  display: flex;
  gap: 5px;
  overflow-x: auto;
  padding-bottom: 6px;
  scrollbar-width: thin;
}

.day {
  flex-shrink: 0;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-dim);
  border-radius: 8px;
  padding: 4px 9px;
  font: 500 11.5px var(--font);
  cursor: pointer;
}

.day.on {
  color: var(--accent);
  border-color: rgba(46, 230, 166, 0.45);
  background: rgba(46, 230, 166, 0.08);
}

.slider-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.btn.nudge {
  flex-shrink: 0;
  font-size: 11px;
  padding: 4px 7px;
  margin-top: 2px;
  color: var(--text-dim);
}

.slider-wrap {
  flex: 1;
}

input[type='range'] {
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  height: 6px;
  border-radius: 3px;
  background: linear-gradient(90deg, rgba(77, 163, 255, 0.5), var(--accent-2));
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
  height: 14px;
  margin-top: 4px;
  font-size: 10px;
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
</style>
