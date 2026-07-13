<script setup>
import { computed } from 'vue'
import { fracColor } from '../lib/colors.js'

const props = defineProps({
  station: { type: Object, required: true }, // live station
  display: { type: Object, required: true }, // {frac, bikes, kind} at scrub time
  series: { type: Array, required: true }, // [{t, frac, bikes, kind}] hourly, 24h
  offsetHours: { type: Number, required: true },
})
const emit = defineEmits(['close'])

const KIND_LABEL = {
  live: 'live',
  history: 'measured (history)',
  blend: 'short-term estimate',
  learned: 'learned pattern',
  prior: 'estimate (prior — improves with data)',
}

const color = computed(() => fracColor(props.display.frac))
const kindLabel = computed(() => KIND_LABEL[props.display.kind] ?? props.display.kind)

const lastReported = computed(() => {
  const d = props.station.lastReported
  if (!d) return '—'
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  return `${Math.round(mins / 60)} h ago`
})

// Sparkline geometry (SVG 260×64)
const W = 260
const H = 64
const PAD = 4

const path = computed(() => {
  const pts = props.series
  if (pts.length < 2) return { line: '', area: '' }
  const step = (W - 2 * PAD) / (pts.length - 1)
  const y = (f) => H - PAD - f * (H - 2 * PAD)
  let line = ''
  pts.forEach((p, i) => {
    line += `${i === 0 ? 'M' : 'L'}${(PAD + i * step).toFixed(1)},${y(p.frac).toFixed(1)}`
  })
  const area = `${line}L${(PAD + (pts.length - 1) * step).toFixed(1)},${H - PAD}L${PAD},${H - PAD}Z`
  return { line, area }
})

const dot = computed(() => {
  const pts = props.series
  // series is hourly — snap the (possibly fractional/negative) offset
  const idx = Math.min(Math.max(Math.round(props.offsetHours), 0), pts.length - 1)
  if (!pts.length) return null
  const step = (W - 2 * PAD) / (pts.length - 1)
  const p = pts[idx]
  return { x: PAD + idx * step, y: H - PAD - p.frac * (H - 2 * PAD) }
})
</script>

<template>
  <aside class="panel glass">
    <button class="close" @click="emit('close')" aria-label="Close">✕</button>

    <h2>{{ station.name }}</h2>
    <p class="addr">{{ station.address }}</p>

    <div class="big">
      <span class="count" :style="{ color }">{{ display.bikes }}</span>
      <div class="big-meta">
        <span class="ebike">⚡ e-bikes</span>
        <span class="kind" :class="display.kind">{{ kindLabel }}</span>
      </div>
    </div>

    <div class="facts">
      <div class="fact"><b>{{ station.docks }}</b><span>free docks</span></div>
      <div class="fact"><b>{{ station.capacity }}</b><span>capacity</span></div>
      <div class="fact"><b>{{ station.disabled }}</b><span>out of service</span></div>
    </div>

    <div class="spark">
      <div class="spark-head">
        <span>Next 24 h</span>
        <span class="dim">availability</span>
      </div>
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none">
        <defs>
          <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35" />
            <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
          </linearGradient>
        </defs>
        <path :d="path.area" fill="url(#sparkfill)" />
        <path :d="path.line" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" />
        <circle v-if="dot" :cx="dot.x" :cy="dot.y" r="4" fill="#fff" stroke="var(--accent)" stroke-width="2.5" />
      </svg>
      <div class="spark-ticks"><span>now</span><span>+12h</span><span>+24h</span></div>
    </div>

    <div class="foot">
      <span v-if="!station.renting" class="chip closed">not renting</span>
      <span v-if="!station.returning" class="chip closed">not accepting returns</span>
      <a
        class="chip veloh-link"
        href="https://myveloh.lu/fr/mapping"
        target="_blank"
        rel="noopener"
        title="Official vel'OH! map — opens the app on phones where it's installed"
      >vel'OH! app ↗</a>
      <span class="dim">updated {{ lastReported }}</span>
    </div>
  </aside>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 96px;
  right: 16px;
  z-index: 11;
  width: 312px;
  padding: 20px;
  max-height: calc(100% - 220px);
  overflow-y: auto;
}

.close {
  position: absolute;
  top: 12px;
  right: 12px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid var(--border);
  color: var(--text-dim);
  width: 28px;
  height: 28px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
}

.close:hover {
  color: var(--text);
}

h2 {
  font-family: var(--font-display);
  font-size: 17px;
  padding-right: 28px;
  line-height: 1.25;
}

.addr {
  font-size: 11.5px;
  color: var(--text-dim);
  margin: 4px 0 14px;
  line-height: 1.4;
}

.big {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 14px;
}

.count {
  font-family: var(--font-display);
  font-size: 52px;
  font-weight: 700;
  line-height: 1;
  transition: color 0.3s ease;
}

.big-meta {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.ebike {
  font-size: 12.5px;
  color: var(--text);
  font-weight: 600;
}

.kind {
  font-size: 11px;
  color: var(--text-dim);
}

.kind.live {
  color: var(--accent);
}

.kind.prior {
  color: var(--warn);
}

.facts {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 16px;
}

.fact {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 6px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.fact b {
  font-family: var(--font-display);
  font-size: 17px;
}

.fact span {
  font-size: 10px;
  color: var(--text-dim);
}

.spark svg {
  width: 100%;
  height: 64px;
  display: block;
}

.spark-head {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  font-weight: 600;
  margin-bottom: 4px;
}

.spark-ticks {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-dim);
  margin-top: 3px;
}

.dim {
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 400;
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.chip.closed {
  color: var(--danger);
  border-color: rgba(255, 77, 94, 0.4);
}

.chip.veloh-link {
  color: var(--accent);
  border-color: rgba(46, 230, 166, 0.35);
  text-decoration: none;
  cursor: pointer;
}

.chip.veloh-link:hover {
  background: rgba(46, 230, 166, 0.1);
}
</style>
