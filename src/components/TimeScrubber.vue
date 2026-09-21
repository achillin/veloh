<script setup>
import { computed, nextTick, ref, watch } from 'vue'
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
// that at 10-min resolution, so the control is layered, coarse to fine:
// pick a DAY, slide the time WITHIN that day (24 h overview), then fine-tune
// on the ruler below it — a ±90 min close-up of wherever the overview
// points, 10 minutes per tick. A date-time picker covers exact jumps.
const MIN_H = -24
const MAX_H = 14 * 24
const STEP_MS = 10 * 60_000

const target = computed(() => new Date(props.now.getTime() + props.offsetHours * 3.6e6))
const holiday = computed(() => holidayName(target.value))

const dtInput = ref(null)

// Selectable moments sit on the clock's 10-minute grid (18:00, 18:10 …), not
// on multiples of 10 min counted from "now"; landing within half a step of
// now means live.
function snapOffset(h) {
  if (Math.abs(h) < 1 / 12) return 0
  const nowMs = props.now.getTime()
  const snapped = Math.round((nowMs + h * 3.6e6) / STEP_MS) * STEP_MS
  return Math.min(MAX_H, Math.max(MIN_H, (snapped - nowMs) / 3.6e6))
}

function setOffset(h) {
  emit('update:offsetHours', snapOffset(h))
}

const setTargetMs = (ms) => setOffset((ms - props.now.getTime()) / 3.6e6)

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

// the ruler walks through midnight — keep the chip of the day it lands on in view
const daysEl = ref(null)
watch(dayIndex, async () => {
  await nextTick()
  daysEl.value?.querySelector('.day.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
})

// ---- 24 h overview slider ----
const LAST_SLOT = 24 - 1 / 6 // 23:50 — "24:00" is the next day's 00:00 and would flip the day mid-drag

function onSlider(e) {
  setOffset(offsetFor(dayIndex.value, Math.min(Number(e.target.value), LAST_SLOT)))
}

function nudge(min) {
  setOffset(props.offsetHours + min / 60)
}

// ---- fine ruler ----
// Continuous time, so it runs straight through midnight into the next day.
// Drag it like a tape, click a tick, use the wheel or the arrow keys.
const RULER_SPAN_MIN = 180
const SPAN_MS = RULER_SPAN_MIN * 60_000
const ruler = ref(null)
const dragCentreMs = ref(null) // unsnapped centre while dragging, so the tape follows the pointer smoothly
let drag = null
let wheelAcc = 0

const minMs = computed(() => props.now.getTime() + MIN_H * 3.6e6)
const maxMs = computed(() => props.now.getTime() + MAX_H * 3.6e6)
const rulerCentreMs = computed(() => dragCentreMs.value ?? target.value.getTime())
const pad2 = (n) => String(n).padStart(2, '0')

const rulerTicks = computed(() => {
  const c = rulerCentreMs.value
  const out = []
  for (let ms = Math.ceil((c - SPAN_MS / 2) / STEP_MS) * STEP_MS; ms <= c + SPAN_MS / 2; ms += STEP_MS) {
    const d = new Date(ms)
    const m = d.getMinutes()
    const major = m === 0
    const midnight = major && d.getHours() === 0
    out.push({
      ms,
      x: 50 + ((ms - c) / SPAN_MS) * 100,
      // the wide weekday label at midnight needs the room of its two half-hour neighbours
      label: midnight
        ? `${d.toLocaleDateString('en-GB', { weekday: 'short' })} 00:00`
        : major || (m === 30 && d.getHours() !== 23 && d.getHours() !== 0)
          ? `${pad2(d.getHours())}:${pad2(m)}`
          : '',
      cls: { major, mid: m === 30, midnight, off: ms < minMs.value || ms > maxMs.value },
    })
  }
  return out
})

// where "now" sits on the tape, when it is in view
const rulerNowX = computed(() => {
  const x = 50 + ((props.now.getTime() - rulerCentreMs.value) / SPAN_MS) * 100
  return x >= 0 && x <= 100 ? x : null
})

// the stretch of the 24 h overview the ruler is magnifying
const bandStyle = computed(() => {
  const a = Math.max(0, (timeOfDay.value - RULER_SPAN_MIN / 120) / 24)
  const b = Math.min(1, (timeOfDay.value + RULER_SPAN_MIN / 120) / 24)
  // the range thumb's centre travels between 10 px and width − 10 px
  return { left: `calc(10px + (100% - 20px) * ${a})`, width: `calc((100% - 20px) * ${b - a})` }
})

function onRulerDown(e) {
  if (e.button != null && e.button !== 0) return
  if (drag) return // a second finger must not hijack the running drag
  e.currentTarget.setPointerCapture?.(e.pointerId)
  drag = { id: e.pointerId, x: e.clientX, startMs: target.value.getTime(), width: e.currentTarget.clientWidth || 1, moved: false }
}

// cancel / lost capture: end the drag WITHOUT the click-to-jump
function endRulerDrag() {
  drag = null
  dragCentreMs.value = null
}

function onRulerMove(e) {
  if (!drag || e.pointerId !== drag.id) return
  // the button came up somewhere we never saw the pointerup (Alt+Tab, context menu)
  if (e.pointerType === 'mouse' && !(e.buttons & 1)) return endRulerDrag()
  const dx = e.clientX - drag.x
  if (!drag.moved && Math.abs(dx) < 4) return
  drag.moved = true
  const ms = Math.min(maxMs.value, Math.max(minMs.value, drag.startMs - (dx / drag.width) * SPAN_MS))
  dragCentreMs.value = ms
  setTargetMs(ms)
}

function onRulerUp(e) {
  if (!drag || e.pointerId !== drag.id) return
  if (!drag.moved) {
    // a plain click: go to the tick under the pointer
    const rect = e.currentTarget.getBoundingClientRect()
    setTargetMs(target.value.getTime() + ((e.clientX - rect.left) / (rect.width || 1) - 0.5) * SPAN_MS)
  }
  endRulerDrag()
}

function onRulerWheel(e) {
  // read deltaMode before the deltas: Firefox then reports a mouse notch in line mode
  const notchMode = e.deltaMode !== 0
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
  if (!d) return
  // a mouse-wheel notch (line/page mode, or ~100 px in Chrome/Edge) is exactly one step
  if (notchMode || Math.abs(d) >= 50) {
    wheelAcc = 0
    nudge(Math.sign(d) * 10)
    return
  }
  // trackpads send many small pixel deltas — accumulate; drop the remainder on reversal
  if (Math.sign(d) !== Math.sign(wheelAcc)) wheelAcc = 0
  wheelAcc += d
  const steps = Math.trunc(wheelAcc / 40)
  if (!steps) return
  wheelAcc -= steps * 40
  nudge(steps * 10)
}

function onRulerKey(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return // leave browser shortcuts (Alt+← = Back) alone
  const by = { ArrowRight: 10, ArrowUp: 10, ArrowLeft: -10, ArrowDown: -10, PageUp: 60, PageDown: -60 }[e.key]
  if (by) {
    e.preventDefault()
    nudge(by)
  } else if (e.key === 'Home') {
    e.preventDefault()
    setOffset(0)
  }
}

// ---- exact date-time jump ----
const dtValue = computed(() => {
  const t = target.value
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}T${pad2(t.getHours())}:${pad2(t.getMinutes())}`
})

function onDatetime(e) {
  const t = Date.parse(e.target.value)
  if (Number.isFinite(t)) setTargetMs(t)
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

    <div ref="daysEl" class="days">
      <button
        v-for="d in days"
        :key="d.d"
        class="day"
        :class="{ on: d.d === dayIndex }"
        @click="pickDay(d.d)"
      >{{ d.label }}</button>
    </div>

    <div class="slider-wrap">
      <div class="band" :style="bandStyle" title="The stretch magnified on the ruler below"></div>
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

    <div class="ruler-row">
      <button class="btn nudge" title="10 minutes back" @click="nudge(-10)">−10m</button>
      <div
        ref="ruler"
        class="ruler"
        tabindex="0"
        role="slider"
        aria-label="Fine time adjustment, 10-minute steps"
        :aria-valuemin="MIN_H * 60"
        :aria-valuemax="MAX_H * 60"
        :aria-valuenow="Math.round(offsetHours * 60)"
        :aria-valuetext="label"
        title="Drag, scroll or use ← → for 10-minute steps"
        @pointerdown="onRulerDown"
        @pointermove="onRulerMove"
        @pointerup="onRulerUp"
        @pointercancel="endRulerDrag"
        @lostpointercapture="endRulerDrag"
        @wheel.prevent="onRulerWheel"
        @keydown="onRulerKey"
      >
        <span v-for="t in rulerTicks" :key="t.ms" class="tick" :class="t.cls" :style="{ left: `${t.x}%` }">
          <i></i><b v-if="t.label">{{ t.label }}</b>
        </span>
        <span v-if="rulerNowX != null" class="nowmark" :style="{ left: `${rulerNowX}%` }" title="now"></span>
        <span class="needle"></span>
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
  padding: 12px 16px 10px;
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

.slider-wrap {
  position: relative;
  padding-top: 5px;
}

/* the part of the day the ruler below is zoomed into */
.band {
  position: absolute;
  top: 1px;
  height: 18px;
  border-radius: 5px;
  background: rgba(46, 230, 166, 0.14);
  border: 1px solid rgba(46, 230, 166, 0.35);
  pointer-events: none;
}

input[type='range'] {
  position: relative;
  display: block;
  width: 100%;
  margin: 2px 0;
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
  margin-top: 8px;
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

.ruler-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.btn.nudge {
  flex-shrink: 0;
  font-size: 11px;
  padding: 4px 7px;
  color: var(--text-dim);
}

.ruler {
  position: relative;
  flex: 1;
  height: 38px;
  overflow: hidden;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.035);
  cursor: grab;
  /* nothing on the page scrolls, so keep every touch: with pan-y the browser
     claims slightly diagonal drags and cancels the pointer */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  outline: none;
}

.ruler:active {
  cursor: grabbing;
}

.ruler:focus-visible {
  border-color: rgba(46, 230, 166, 0.55);
}

.tick {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  pointer-events: none;
}

.tick i {
  position: absolute;
  left: -0.5px;
  top: 0;
  width: 1px;
  height: 7px;
  background: rgba(255, 255, 255, 0.28);
}

.tick.mid i {
  height: 11px;
}

.tick.major i {
  height: 15px;
  background: rgba(255, 255, 255, 0.6);
}

.tick.midnight i {
  height: 100%;
  background: var(--accent-2);
  opacity: 0.55;
}

.tick b {
  position: absolute;
  bottom: 3px;
  transform: translateX(-50%);
  font: 500 10px var(--font);
  color: var(--text-dim);
  white-space: nowrap;
}

.tick.major b {
  color: var(--text);
}

.tick.midnight b {
  color: var(--accent-2);
}

.tick.off {
  opacity: 0.25;
}

.nowmark {
  position: absolute;
  top: 2px;
  width: 7px;
  height: 7px;
  margin-left: -3.5px;
  border-radius: 50%;
  background: var(--accent);
  pointer-events: none;
}

.needle {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: var(--accent);
  box-shadow: 0 0 8px rgba(46, 230, 166, 0.6);
  pointer-events: none;
}
</style>
