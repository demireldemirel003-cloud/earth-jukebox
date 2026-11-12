import './style.css'
import {
  getLatestCompleteDate,
  LAYER_SPECS,
  loadGibsService,
  loadLayer,
  longitudeToPixel,
  sampleLayerColumn,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from './gibs'
import type { ColumnReading, LayerDefinition, LayerSpec, LoadedLayer } from './gibs'
import { describeSound, EarthSonifier, formatReading } from './sonifier'

const COLUMN_COUNT = 240
const LONGITUDE_TICKS = [-180, -120, -60, 0, 60, 120, 180]
const SCENES: Record<string, { title: string; layers: string[] }> = {
  ocean: { title: 'Ocean', layers: [LAYER_SPECS[0].id, LAYER_SPECS[1].id] },
  land: { title: 'Land & Life', layers: ['ndvi'] },
  poles: { title: 'Sky/Poles', layers: ['sea-ice', LAYER_SPECS[1].id] },
  oceanLife: { title: 'Ocean Life', layers: ['OCI_PACE_Chlorophyll_a', LAYER_SPECS[0].id] },
  humans: { title: 'Humans', layers: ['VIIRS_SNPP_DayNightBand_At_Sensor_Radiance'] },
  air: {
    title: 'Air & Clouds',
    layers: ['MODIS_Terra_Water_Vapor_5km_Day', 'MODIS_Terra_Cloud_Optical_Thickness'],
  },
  everything: { title: 'Everything', layers: LAYER_SPECS.map((spec) => spec.id) },
}
type LoadState = 'loading' | 'ready' | 'error'
type Side = 'A' | 'B'
type PlaybackMode = 'sequential' | 'ab'

interface LayerState {
  spec: LayerSpec
  status: LoadState
  assetA?: LoadedLayer
  assetB?: LoadedLayer
  error?: string
  enabled: boolean
  muted: boolean
  solo: boolean
  volume: number
}

const query = new URLSearchParams(location.search)
const queryDateA = query.get('a') ?? query.get('date') ?? ''
const queryDateB = query.get('b') ?? ''
let selectedDate = queryDateA
let comparisonDate = queryDateB
let comparisonMode = query.get('compare') === '1'
let playbackMode: PlaybackMode = query.get('mode') === 'ab' ? 'ab' : 'sequential'
let activeSide: Side = query.get('side') === 'B' ? 'B' : 'A'
const requestedScene = query.get('scene')
let currentScene = requestedScene && SCENES[requestedScene] ? requestedScene : 'ocean'
const hasLayerParameter = query.has('layers')
const requestedLayers = new Set((query.get('layers') ?? '').split(',').filter(Boolean))
const initialScene = SCENES[currentScene]
let focusId = LAYER_SPECS[0].id
let columnIndex = 0
let isPlaying = false
let isScrubbing = false
let timer: number | undefined
let meterTimer: number | undefined
let loadEpoch = 0
let gibsService: Awaited<ReturnType<typeof loadGibsService>> | undefined

const states = new Map<string, LayerState>(
  LAYER_SPECS.map((spec) => [
    spec.id,
    {
      spec,
      status: 'loading',
      enabled: hasLayerParameter ? requestedLayers.has(spec.id) : initialScene.layers.includes(spec.id),
      muted: false,
      solo: false,
      volume: spec.defaultVolume,
    },
  ]),
)

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <main class="page-shell">
    <header class="topbar"><a class="brand" href="#"><span class="brand-mark">◉</span><span>EARTH<span class="brand-light"> JUKEBOX</span></span></a><span class="edition"><span class="live-dot"></span> A LIVE PLANETARY INSTRUMENT</span></header>
    <section class="intro"><div class="intro-title-row"><h1>The Earth <em>has a sound.</em></h1><p class="latest-day"><span>NASA EARTH OBSERVATIONS</span><strong id="latest-complete-day">Latest complete day: loading</strong></p></div><div class="metadata"><span class="metadata-dot"></span><span>GIBS WMS · EPSG:4326 · FIXED 1440×720 RASTER</span></div></section>
    <nav class="scene-tabs" aria-label="Sound scenes">${Object.entries(SCENES).map(([id, scene]) => `<button type="button" class="scene-button${id === currentScene ? ' is-active' : ''}" data-scene="${id}">${scene.title}</button>`).join('')}</nav>
    <div class="datebar">
      <label for="date-picker" class="date-picker-label">REQUESTED DAY</label><input id="date-picker" type="date" aria-label="Requested calendar date" />
      <label class="compare-toggle"><input id="compare-enabled" type="checkbox" /><span>THEN VS NOW</span></label>
      <label for="compare-date" class="date-picker-label">YEAR B</label><input id="compare-date" type="date" aria-label="Comparison calendar date" />
      <button type="button" class="mini-control" id="compare-mode">MODE: SEQUENTIAL</button><button type="button" class="mini-control" id="switch-side">A / B</button><button type="button" class="mini-control compare-button" id="history-button">THIS DAY IN HISTORY · COMPARE</button><button type="button" class="mini-control" id="copy-link">COPY LINK</button>
    </div>
    <div id="playing-year" class="playing-year" hidden></div>
    <section class="studio" aria-label="Earth Jukebox player">
      <div class="map-column">
        <div class="focus-heading"><div><span class="eyebrow">FOCUS LAYER</span><h2 id="focus-name">Loading NASA layers…</h2></div><span id="focus-date" class="focus-date">—</span></div>
        <div class="map-frame" id="world-stage"><canvas id="world-canvas" width="${WORLD_WIDTH}" height="${WORLD_HEIGHT}" aria-label="Fixed global equirectangular NASA raster"></canvas><svg class="scan-overlay" viewBox="0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}" preserveAspectRatio="none" aria-hidden="true"><line id="scan-line" x1="0" y1="0" x2="0" y2="${WORLD_HEIGHT}"></line><circle id="scan-mark" cx="0" cy="${WORLD_HEIGHT / 2}" r="5"></circle><rect id="longitude-label-top-bg" x="-43" y="9" width="86" height="23" rx="3"></rect><text id="longitude-label-top" x="0" y="24">0°</text><rect id="longitude-label-bottom-bg" x="-43" y="${WORLD_HEIGHT - 32}" width="86" height="23" rx="3"></rect><text id="longitude-label-bottom" x="0" y="${WORLD_HEIGHT - 17}">0°</text></svg><div id="stage-message" class="stage-message"><span class="stage-spinner"></span> Reading GIBS capabilities…</div></div>
        <div id="longitude-axis" class="longitude-axis"></div><div class="map-caption"><span>WEST <b>→</b> EAST · DRAG OR TAP TO SCRUB</span><span id="pixel-status" class="pixel-status is-pending" role="status" aria-live="polite"><span class="status-indicator"></span> Loading layers…</span></div>
        <section class="profile-section"><div class="section-heading"><div><span class="eyebrow">CURRENT COLUMN</span><h2>What you hear</h2></div><span class="column-number"><span id="column-number">001</span> / ${COLUMN_COUNT}</span></div><div class="chart-caption"><span>LATITUDE</span><span>NORTH ↑ · NORMALIZED COLOR SCALE</span></div><svg id="profile-chart" class="profile-chart" viewBox="0 0 360 174" preserveAspectRatio="none" role="img"></svg><div id="reading-list" class="reading-list" aria-live="polite"><p class="empty-reading">Layer readings will appear here.</p></div><p id="difference-summary" class="difference-summary" aria-live="polite"></p></section>
        <section class="focus-legend"><div><span id="legend-title">COLOR SCALE</span><span id="legend-units">—</span></div><div id="color-legend" class="color-legend"></div><div class="legend-ticks"><span id="legend-min">—</span><span id="legend-mid">—</span><span id="legend-max">—</span></div><p id="science-note">Readings are colormap-bin midpoint estimates, not source precision.</p></section>
        <div class="transport"><button id="play-button" class="play-button" type="button" disabled><span id="play-icon">▶</span><span id="play-label">LOADING DATA</span></button><div class="transport-divider"></div><label class="speed-control" for="speed-slider"><span class="speed-label">SPEED</span><input id="speed-slider" type="range" min="0.5" max="2" step="0.1" value="1" /><output id="speed-value">1.0×</output></label><div class="mix-meter"><span>MIX PEAK</span><output id="peak-meter">— dBFS</output></div></div><div class="progress-track"><div id="progress-fill"></div></div>
      </div>
      <aside class="sound-panel">
        <section class="layers-section"><div class="section-heading"><div><span class="eyebrow">INSTRUMENTS</span><h2>Layer mix</h2></div><span id="loading-summary">0 / ${LAYER_SPECS.length} ready</span></div><div id="layer-list" class="layer-list"></div><div id="layer-errors" class="layer-errors" aria-live="polite"></div></section>
        <section class="how-to-listen"><h3>How to listen</h3><p>The scan moves west to east, left to right in stereo. Nearby pixels blend into legato tones; latitude sets the pentatonic pitch while smoothed values gently shift it with hysteresis. Ocean is wide and calm, Humans bright, and Sky/Poles cool and spacious.</p></section><div class="audio-notice"><span>↗</span><span id="audio-notice-text">Press play to enable sound in your browser.</span></div>
      </aside>
    </section>
    <footer class="page-footer"><span>NASA GIBS · CAPABILITIES-DRIVEN PRODUCT DATES</span><span>RASTERS CACHED BY PRODUCT + DATE · SHARED SCAN</span></footer>
  </main>`

const q = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
const datePicker = q<HTMLInputElement>('#date-picker')
const compareDatePicker = q<HTMLInputElement>('#compare-date')
const compareEnabled = q<HTMLInputElement>('#compare-enabled')
const compareModeButton = q<HTMLButtonElement>('#compare-mode')
const switchSideButton = q<HTMLButtonElement>('#switch-side')
const historyButton = q<HTMLButtonElement>('#history-button')
const copyLinkButton = q<HTMLButtonElement>('#copy-link')
const playButton = q<HTMLButtonElement>('#play-button')
const playIcon = q<HTMLSpanElement>('#play-icon')
const playLabel = q<HTMLSpanElement>('#play-label')
const speedSlider = q<HTMLInputElement>('#speed-slider')
const speedValue = q<HTMLOutputElement>('#speed-value')
const progressFill = q<HTMLDivElement>('#progress-fill')
const columnNumber = q<HTMLSpanElement>('#column-number')
const profileChart = q<SVGSVGElement>('#profile-chart')
const readingList = q<HTMLDivElement>('#reading-list')
const differenceSummary = q<HTMLParagraphElement>('#difference-summary')
const layerList = q<HTMLDivElement>('#layer-list')
const loadingSummary = q<HTMLSpanElement>('#loading-summary')
const layerErrors = q<HTMLDivElement>('#layer-errors')
const pixelStatus = q<HTMLSpanElement>('#pixel-status')
const stage = q<HTMLDivElement>('#world-stage')
const worldCanvas = q<HTMLCanvasElement>('#world-canvas')
const stageMessage = q<HTMLDivElement>('#stage-message')
const scanLine = q<SVGLineElement>('#scan-line')
const scanMark = q<SVGCircleElement>('#scan-mark')
const longitudeLabelTop = q<SVGTextElement>('#longitude-label-top')
const longitudeLabelTopBg = q<SVGRectElement>('#longitude-label-top-bg')
const longitudeLabelBottom = q<SVGTextElement>('#longitude-label-bottom')
const longitudeLabelBottomBg = q<SVGRectElement>('#longitude-label-bottom-bg')
const longitudeAxis = q<HTMLDivElement>('#longitude-axis')
const peakMeter = q<HTMLOutputElement>('#peak-meter')
const playingYear = q<HTMLDivElement>('#playing-year')
const sonifier = new EarthSonifier()

function safeText(value: string): string {
  const span = document.createElement('span')
  span.textContent = value
  return span.innerHTML
}

function selectedAsset(state: LayerState, side: Side = activeSide): LoadedLayer | undefined {
  return side === 'B' && comparisonMode ? state.assetB : state.assetA
}

function dateLabel(asset: LoadedLayer | undefined, requested: string): string {
  if (!asset) return `requested ${requested} · loading`
  const daysOld = Math.max(
    0,
    Math.round((Date.parse(`${requested}T00:00:00Z`) - Date.parse(`${asset.usedDate}T00:00:00Z`)) / 86_400_000),
  )
  const using = !asset.available
    ? 'Not available'
    : asset.latestFallback
      ? `latest available ${asset.usedDate} · ${daysOld} days old`
      : `using ${asset.archive ? 'archive ' : ''}${asset.usedDate}`
  const sensor = asset.sensorLabel ? ` · ${asset.sensorLabel}` : ''
  const product = asset.productLabel && asset.productLabel !== asset.sensorLabel ? ` · ${asset.productLabel}` : ''
  return `${asset.archive && asset.available ? '<b>Archive</b> · ' : ''}requested ${safeText(requested)} · ${using}${sensor}${product} · ${safeText(asset.cadence)}`
}

function formatLegendValue(value: number): string {
  return String(Number(value.toPrecision(3)))
}

function setPixelStatus(kind: 'is-pending' | 'is-ready' | 'is-error', text: string): void {
  pixelStatus.className = `pixel-status ${kind}`
  pixelStatus.innerHTML = `<span class="status-indicator"></span> ${safeText(text)}`
}

function getReadyStates(): LayerState[] {
  return Array.from(states.values()).filter((state) => state.status === 'ready' && selectedAsset(state)?.available)
}

function getActiveStates(): LayerState[] {
  const enabled = getReadyStates().filter((state) => state.enabled && !state.muted)
  const solo = enabled.filter((state) => state.solo)
  return solo.length ? solo : enabled
}

function formatLatitude(latitude: number): string {
  return latitude === 0 ? '0°' : `${Math.abs(latitude)}°${latitude < 0 ? 'S' : 'N'}`
}

function formatLongitude(longitude: number): string {
  return Math.abs(longitude) < 0.5 ? '0°' : `${Math.abs(longitude).toFixed(0)}°${longitude < 0 ? 'W' : 'E'}`
}

function updateUrl(): void {
  const params = new URLSearchParams()
  params.set('a', selectedDate)
  if (comparisonMode) {
    params.set('b', comparisonDate)
    params.set('compare', '1')
    params.set('mode', playbackMode)
    params.set('side', activeSide)
  }
  params.set('scene', currentScene)
  params.set('layers', Array.from(states.values()).filter((state) => state.enabled).map((state) => state.spec.id).join(','))
  history.replaceState(null, '', `${location.pathname}?${params}`)
}

function buildLongitudeAxis(): void {
  longitudeAxis.innerHTML = LONGITUDE_TICKS.map((longitude) => {
    const left = ((longitude + 180) / 360) * 100
    return `<span class="longitude-tick" style="left:${left}%"><i></i><b>${formatLongitude(longitude)}</b></span>`
  }).join('')
}

function updateLayerControls(): void {
  const allStates = Array.from(states.values())
  layerList.innerHTML = allStates.map((state) => {
    const asset = selectedAsset(state, 'A') ?? state.assetA
    const title = asset?.name ?? state.spec.id
    const requested = selectedDate
    const labelA = dateLabel(asset, requested)
    const label = comparisonMode
      ? `A: ${labelA}<br>B: ${dateLabel(state.assetB, comparisonDate)}`
      : labelA
    const available = asset?.available === true
    const ready = state.status === 'ready'
    const pixels = available ? asset.raster.check.validPixels : 0
    const coverage = (pixels / (WORLD_WIDTH * WORLD_HEIGHT) * 100).toFixed(1)
    const expanded = layerList.querySelector<HTMLElement>(`[data-layer-id="${CSS.escape(state.spec.id)}"]`)?.classList.contains('is-expanded') ?? false
    return `<article class="layer-card ${state.status} ${state.spec.id === focusId ? 'is-focused' : ''} ${available ? '' : 'is-unavailable'} ${expanded ? 'is-expanded' : ''}" data-layer-id="${safeText(state.spec.id)}" data-valid-pixels="${pixels}" style="--layer-color:${state.spec.color}">
      <div class="layer-card-top">
        <label class="layer-toggle"><input class="layer-enabled" aria-label="Enable ${safeText(title)}" type="checkbox" ${state.enabled ? 'checked' : ''} ${!ready ? 'disabled' : ''}/><span></span></label>
        <button class="layer-thumbnail" type="button" data-action="focus" aria-label="Focus ${safeText(title)}" ${!available ? 'disabled' : ''}><canvas data-layer-canvas="${safeText(state.spec.id)}" width="96" height="48"></canvas></button>
        <button class="focus-select" type="button" data-action="focus" ${!available ? 'disabled' : ''} aria-pressed="${state.spec.id === focusId}" title="${safeText(label.replace(/<[^>]*>/g, ''))}"><span class="layer-name">${safeText(title)}</span><span class="layer-date">${label}</span></button>
        <input class="layer-volume" aria-label="${safeText(title)} volume" type="range" min="0" max="1" step="0.01" value="${state.volume}" ${!available ? 'disabled' : ''}/>
        <span class="load-state ${state.status}" role="img" aria-label="${state.status === 'error' ? 'Layer failed to load' : !ready ? 'Layer loading' : available ? 'Layer ready' : 'No data'}" title="${state.status === 'error' ? 'Error' : !ready ? 'Loading' : available ? 'Ready' : 'No data'}"></span>
        <button class="layer-details-toggle" data-action="details" aria-expanded="${expanded}" type="button" aria-label="${expanded ? 'Hide' : 'Show'} ${safeText(title)} details">${expanded ? '−' : '+'}</button>
      </div>
      <div class="layer-details" ${expanded ? '' : 'hidden'}>
        <div class="layer-legend"><span>${available ? safeText(formatLegendValue(asset.minValue)) : '—'}</span><div class="layer-swatch" style="background:${asset?.legendGradient ?? 'linear-gradient(90deg,#28322c,#596458)'}"></div><span>${available ? `${safeText(formatLegendValue(asset.maxValue))} ${safeText(asset.units)}` : '—'}</span></div>
        <div class="layer-card-bottom"><button class="mini-control ${state.muted ? 'is-on' : ''}" data-action="mute" type="button" ${!available ? 'disabled' : ''}>${state.muted ? 'MUTED' : 'MUTE'}</button><button class="mini-control ${state.solo ? 'is-on' : ''}" data-action="solo" type="button" ${!available ? 'disabled' : ''}>${state.solo ? 'SOLO ON' : 'SOLO'}</button><span class="layer-volume-value">${Math.round(state.volume * 100)}% volume</span></div>
        <div class="layer-science">${safeText(label.replace(/<[^>]*>/g, ''))} · ${available ? `${pixels.toLocaleString()} valid canvas pixels · ${coverage}% coverage · ${safeText(asset.units)} midpoint estimate` : safeText(asset?.unavailableReason ?? state.error ?? 'Loading capabilities…')}</div>
      </div></article>`
  }).join('')
  for (const state of allStates) {
    const asset = selectedAsset(state, 'A')
    const canvas = layerList.querySelector<HTMLCanvasElement>(`[data-layer-canvas="${CSS.escape(state.spec.id)}"]`)
    const context = canvas?.getContext('2d')
    if (context && canvas && asset?.available) {
      context.imageSmoothingEnabled = false
      context.drawImage(asset.raster.canvas, 0, 0, canvas.width, canvas.height)
    }
  }
  loadingSummary.textContent = `${allStates.filter((state) => state.status === 'ready').length} / ${states.size} ready`
  const groupedErrors = new Map<string, string[]>()
  for (const state of allStates.filter((item) => item.status === 'error')) {
    const message = state.error ?? 'Layer load failed.'
    groupedErrors.set(message, [...(groupedErrors.get(message) ?? []), state.spec.id])
  }
  layerErrors.innerHTML = Array.from(groupedErrors, ([message, ids]) =>
    `<p><strong>${safeText(ids.join(', '))}</strong>: ${safeText(message)}</p>`,
  ).join('')
  playButton.disabled = getActiveStates().length === 0
}

function setFocus(id: string): void {
  const state = states.get(id)
  const asset = state ? selectedAsset(state) : undefined
  if (!state || !asset?.available) return
  focusId = id
  q<HTMLElement>('#focus-name').textContent = asset.name
  const requested = activeSide === 'B' ? comparisonDate : selectedDate
  q<HTMLElement>('#focus-date').innerHTML = `${dateLabel(asset, requested)} · ${safeText(asset.units)}`
  q<HTMLElement>('#legend-title').textContent = asset.name.toUpperCase()
  q<HTMLElement>('#legend-units').textContent = asset.units
  q<HTMLElement>('#color-legend').style.background = asset.legendGradient
  q<HTMLElement>('#legend-min').textContent = formatLegendValue(asset.minValue)
  q<HTMLElement>('#legend-mid').textContent = formatLegendValue((asset.minValue + asset.maxValue) / 2)
  q<HTMLElement>('#legend-max').textContent = formatLegendValue(asset.maxValue)
  q<HTMLElement>('#science-note').textContent = `${asset.productLabel}: ${asset.units}. Values are colormap-bin midpoint estimates (bin width ≈ ${formatLegendValue(asset.binWidth)}).`
  const context = worldCanvas.getContext('2d')
  if (context) {
    context.imageSmoothingEnabled = false
    context.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT)
    context.drawImage(asset.raster.canvas, 0, 0)
  }
  stageMessage.hidden = true
  setPixelStatus('is-ready', `${asset.usedDate} · ${asset.raster.check.validPixels.toLocaleString()} valid pixels · ${(asset.raster.check.validPixels / (WORLD_WIDTH * WORLD_HEIGHT) * 100).toFixed(1)}% coverage`)
  updateLayerControls()
  drawScanPosition(columnIndex, false)
}

function roleOctave(role: LayerSpec['role']): number {
  if (role === 'ice' || role === 'night-lights') return 12
  if (role === 'land') return -7
  if (role === 'rain') return 5
  if (role === 'ocean-life') return -5
  if (role === 'water-vapor') return 5
  return 0
}

function audioScene(sceneId = currentScene): 'ocean' | 'humans' | 'poles' | 'land' | 'air' {
  if (sceneId === 'poles') return 'poles'
  if (sceneId === 'humans') return 'humans'
  if (sceneId === 'land') return 'land'
  if (sceneId === 'air') return 'air'
  return 'ocean'
}

interface LayerColumn {
  state: LayerState
  asset: LoadedLayer
  reading: ColumnReading
  side: Side
}

function currentReadings(column: number): LayerColumn[] {
  const x = Math.round((column / (COLUMN_COUNT - 1)) * (WORLD_WIDTH - 1))
  return getActiveStates().flatMap((state) => {
    const asset = selectedAsset(state)
    return asset?.available
      ? [{ state, asset, reading: sampleLayerColumn(asset.raster.imageData, asset, x, 4), side: activeSide }]
      : []
  })
}

function drawScanPosition(column: number, playSound: boolean): void {
  columnIndex = Math.max(0, Math.min(COLUMN_COUNT - 1, Math.round(column)))
  const dataX = Math.round((columnIndex / (COLUMN_COUNT - 1)) * (WORLD_WIDTH - 1))
  const longitude = (dataX / (WORLD_WIDTH - 1)) * 360 - 180
  const svgX = (dataX / (WORLD_WIDTH - 1)) * WORLD_WIDTH
  const label = formatLongitude(longitude)
  scanLine.setAttribute('x1', String(svgX)); scanLine.setAttribute('x2', String(svgX))
  scanMark.setAttribute('cx', String(svgX)); longitudeLabelTop.setAttribute('x', String(svgX))
  longitudeLabelBottom.setAttribute('x', String(svgX)); longitudeLabelTopBg.setAttribute('x', String(svgX - 43))
  longitudeLabelBottomBg.setAttribute('x', String(svgX - 43))
  longitudeLabelTop.textContent = label; longitudeLabelBottom.textContent = label
  columnNumber.textContent = String(columnIndex + 1).padStart(3, '0')
  progressFill.style.width = `${((columnIndex + 1) / COLUMN_COUNT) * 100}%`
  const readings = currentReadings(columnIndex)
  renderColumn(readings)
  if (playSound) {
    sonifier.playColumn(
      readings.map(({ state, asset, reading }) => ({
        role: state.spec.role,
        volume: state.volume,
        reading,
        longitude: reading.longitude,
        minValue: asset.minValue,
        maxValue: asset.maxValue,
      })),
    )
  }
}

function renderColumn(readings: LayerColumn[]): void {
  readingList.innerHTML = readings.map(({ state, asset, reading }) => `<section class="reading-layer" style="--layer-color:${state.spec.color}"><div class="reading-layer-title"><i></i><b>${safeText(asset.name)}</b><small>${asset.usedDate} · ${safeText(asset.sensorLabel ?? '')}</small></div>${reading.points.map((point) => {
    if (point.value === null) return `<div class="reading-value"><span>${formatLatitude(point.latitude)}</span><span class="no-reading-label">No reading (land/ice)</span></div>`
    const normalized = Math.max(0, Math.min(1, (point.value - asset.minValue) / (asset.maxValue - asset.minValue || 1)))
    const pitchStep = sonifier.getPitchStep(state.spec.role, point.latitude, normalized)
    const note = describeSound(point.latitude, roleOctave(state.spec.role), pitchStep, audioScene()).note
    return `<div class="reading-value"><span>${formatLatitude(point.latitude)} · ≈ ${safeText(formatReading(point, asset.units))}</span><span class="reading-note">${note}</span></div>`
  }).join('')}</section>`).join('') || '<p class="empty-reading">No active instrument has a reading in this column.</p>'
  const profileData: LayerColumn[] = [...readings]
  if (comparisonMode) {
    for (const state of Array.from(states.values()).filter((item) => item.enabled && !item.muted)) {
      if (Array.from(states.values()).some((item) => item.enabled && !item.muted && item.solo) && !state.solo) continue
      const asset = selectedAsset(state, activeSide === 'A' ? 'B' : 'A')
      if (!asset?.available) continue
      const x = Math.round((columnIndex / (COLUMN_COUNT - 1)) * (WORLD_WIDTH - 1))
      profileData.push({ state, asset, reading: sampleLayerColumn(asset.raster.imageData, asset, x), side: activeSide === 'A' ? 'B' : 'A' })
    }
  }
  drawProfile(profileData)
  renderDifferences()
}

function drawProfile(readings: LayerColumn[]): void {
  const width = 360, height = 174, margin = { left: 32, right: 9, top: 10, bottom: 25 }
  const plotWidth = width - margin.left - margin.right, plotHeight = height - margin.top - margin.bottom
  const xFor = (latitude: number) => margin.left + ((latitude + 90) / 180) * plotWidth
  const yFor = (value: number, asset: LayerDefinition) => margin.top + (1 - Math.max(0, Math.min(1, (value - asset.minValue) / (asset.maxValue - asset.minValue || 1)))) * plotHeight
  const parts: string[] = []
  for (const tick of [0, .25, .5, .75, 1]) {
    const y = margin.top + (1 - tick) * plotHeight
    parts.push(`<line class="chart-grid" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}"/>`)
  }
  for (const latitude of [-60, -30, 0, 30, 60]) {
    const x = xFor(latitude)
    parts.push(`<line class="chart-grid chart-grid-vertical" x1="${x}" y1="${margin.top}" x2="${x}" y2="${height - margin.bottom}"/><text class="chart-tick chart-x-tick" x="${x}" y="${height - 8}">${formatLatitude(latitude)}</text>`)
  }
  parts.push(`<line class="chart-axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}"/><line class="chart-axis" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"/>`)
  for (const { state, asset, reading, side } of readings) {
    let segment: string[] = []
    const paths: string[] = []
    for (const point of reading.points) {
      if (point.value === null) { if (segment.length) paths.push(segment.join(' ')); segment = []; continue }
      segment.push(`${segment.length ? 'L' : 'M'}${xFor(point.latitude)},${yFor(point.value, asset)}`)
    }
    if (segment.length) paths.push(segment.join(' '))
    parts.push(paths.map((path) => `<path class="profile-line ${side === 'B' ? 'profile-year-b' : ''}" stroke="${state.spec.color}" d="${path}"/>`).join(''))
    for (const point of reading.points) if (point.value !== null) parts.push(`<circle class="profile-point" fill="${state.spec.color}" cx="${xFor(point.latitude)}" cy="${yFor(point.value, asset)}" r="3"><title>${safeText(asset.name)} · ${formatLatitude(point.latitude)} · ${formatReading(point, asset.units)} · year ${side}</title></circle>`)
  }
  profileChart.innerHTML = parts.join('')
}

function renderDifferences(): void {
  if (!comparisonMode) { differenceSummary.textContent = ''; return }
  const messages: string[] = []
  const x = Math.round((columnIndex / (COLUMN_COUNT - 1)) * (WORLD_WIDTH - 1))
  for (const state of getActiveStates()) {
    const a = state.assetA, b = state.assetB
    if (!a?.available || !b?.available) {
      messages.push(`${state.spec.id}: Not available for one selected year.`)
      continue
    }
    if (a.id !== b.id || a.sensorLabel !== b.sensorLabel) {
      messages.push(`${state.spec.id}: Different sensors, difference not comparable.`)
      continue
    }
    const first = sampleLayerColumn(a.raster.imageData, a, x)
    const second = sampleLayerColumn(b.raster.imageData, b, x)
    const common = first.points.map((point, index) => ({ point, other: second.points[index] })).find(({ point, other }) => point.value !== null && other.value !== null)
    if (!common || common.point.value === null || common.other.value === null) {
      messages.push(`${state.spec.id}: no paired reading at this scan column.`)
      continue
    }
    const difference = common.point.value - common.other.value
    if (Math.abs(difference) <= Math.max(a.binWidth, b.binWidth)) {
      messages.push(`${formatLatitude(common.point.latitude)}: no reliable difference at this resolution.`)
    } else {
      const warmer = difference > 0
      messages.push(`${formatLatitude(common.point.latitude)}: ${Math.abs(difference).toFixed(1)} ${a.units} ${warmer ? 'higher than' : 'lower than'} ${comparisonDate.slice(0, 4)}.`)
    }
  }
  differenceSummary.textContent = messages.join(' · ')
}

function setPlaying(playing: boolean): void {
  isPlaying = playing
  if (!playing) sonifier.release()
  playButton.classList.toggle('is-playing', playing)
  playButton.setAttribute('aria-label', playing ? 'Pause Earth reading' : 'Play Earth reading')
  playIcon.textContent = playing ? 'Ⅱ' : '▶'
  playLabel.textContent = playing ? 'PAUSE READING' : 'PLAY READING'
  if (timer !== undefined) clearInterval(timer)
  if (meterTimer !== undefined) clearInterval(meterTimer)
  timer = playing ? window.setInterval(readNextColumn, Math.max(50, 150 / Number(speedSlider.value))) : undefined
  meterTimer = playing ? window.setInterval(() => {
    const peak = sonifier.getPeak()
    peakMeter.value = `${peak > 0 ? (20 * Math.log10(peak)).toFixed(1) : '−∞'} dBFS`
    peakMeter.classList.toggle('is-hot', peak >= .9)
  }, 100) : undefined
}

function readNextColumn(): void {
  if (columnIndex < COLUMN_COUNT - 1) { drawScanPosition(columnIndex + 1, true); return }
  if (comparisonMode && playbackMode === 'sequential' && activeSide === 'A') {
    activeSide = 'B'
    columnIndex = 0
    showPlayingYear()
    updateUrl()
    const next = states.get(focusId)
    if (next && selectedAsset(next)?.available) setFocus(focusId)
    drawScanPosition(0, true)
    return
  }
  drawScanPosition(COLUMN_COUNT - 1, true)
  setPlaying(false)
}

function showPlayingYear(): void {
  if (!comparisonMode) { playingYear.hidden = true; return }
  const year = (activeSide === 'A' ? selectedDate : comparisonDate).slice(0, 4)
  playingYear.textContent = `NOW PLAYING · ${activeSide} · ${year}`
  playingYear.hidden = false
}

function seekFromPointer(event: PointerEvent, playSound: boolean): void {
  const bounds = stage.getBoundingClientRect()
  const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
  const pixel = longitudeToPixel(fraction * 360 - 180)
  drawScanPosition(Math.round((pixel / (WORLD_WIDTH - 1)) * (COLUMN_COUNT - 1)), playSound)
}

function resetLoadingStates(): void {
  for (const state of states.values()) {
    state.status = 'loading'; state.assetA = undefined; state.assetB = undefined; state.error = undefined
  }
  stageMessage.hidden = false
  stageMessage.innerHTML = '<span class="stage-spinner"></span> Loading NASA GIBS data…'
  updateLayerControls()
}

async function loadAllLayers(): Promise<void> {
  const epoch = ++loadEpoch
  setPlaying(false)
  resetLoadingStates()
  setPixelStatus('is-pending', 'Loading selected dates in parallel…')
  try {
    gibsService ??= await loadGibsService()
    if (epoch !== loadEpoch) return
    if (!selectedDate) {
      selectedDate = getLatestCompleteDate(gibsService)
      datePicker.value = selectedDate
    }
    q<HTMLElement>('#latest-complete-day').textContent = `Latest complete day: ${getLatestCompleteDate(gibsService)}`
    if (!comparisonDate) comparisonDate = shiftYear(selectedDate, -10)
    compareDatePicker.value = comparisonDate
    const pending = Array.from(states.values())
    let nextIndex = 0
    const worker = async () => {
      while (nextIndex < pending.length) {
        const state = pending[nextIndex]
        nextIndex += 1
        try {
          state.assetA = await loadLayer(gibsService!, state.spec, selectedDate, comparisonMode)
          if (comparisonMode) state.assetB = await loadLayer(gibsService!, state.spec, comparisonDate, true)
          state.status = 'ready'
        } catch (error) {
          state.status = 'error'
          state.error = error instanceof Error ? error.message : 'Unknown GIBS error.'
        }
        if (epoch !== loadEpoch) return
        updateLayerControls()
        const focused = states.get(focusId)
        if (focused && selectedAsset(focused)?.available) setFocus(focusId)
        else {
          const next = getReadyStates()[0]
          if (next) setFocus(next.spec.id)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, pending.length) }, () => worker()))
    if (epoch === loadEpoch && getReadyStates().length === 0) {
      setPixelStatus('is-error', 'No raster data available for the selected dates.')
      stageMessage.hidden = false
      stageMessage.innerHTML = '<span>No layer image is available for this date.</span><button type="button" class="retry-button" data-action="retry">Retry loading</button>'
    }
  } catch (error) {
    if (epoch !== loadEpoch) return
    const message = error instanceof Error ? error.message : 'GIBS capabilities could not be loaded.'
    for (const state of states.values()) { state.status = 'error'; state.error = message }
    updateLayerControls()
    setPixelStatus('is-error', message)
    stageMessage.hidden = false
    stageMessage.innerHTML = `<span>${safeText(message)}</span><button type="button" class="retry-button" data-action="retry">Retry loading</button>`
  }
  updateUrl()
}

function shiftYear(date: string, years: number): string {
  if (!date) return ''
  const [year, month, day] = date.split('-').map(Number)
  const target = new Date(Date.UTC(year + years, month - 1, day))
  if (target.getUTCMonth() !== month - 1) target.setUTCDate(0)
  return target.toISOString().slice(0, 10)
}

function applyScene(sceneId: string): void {
  if (!SCENES[sceneId]) return
  currentScene = sceneId
  sonifier.setScene(audioScene(sceneId))
  for (const state of states.values()) { state.enabled = SCENES[sceneId].layers.includes(state.spec.id); state.muted = false; state.solo = false }
  document.querySelectorAll<HTMLButtonElement>('.scene-button').forEach((button) => button.classList.toggle('is-active', button.dataset.scene === sceneId))
  if (!getActiveStates().some((state) => state.spec.id === focusId)) {
    const next = getActiveStates()[0] ?? getReadyStates().find((state) => SCENES[sceneId].layers.includes(state.spec.id))
    if (next) setFocus(next.spec.id)
  }
  updateLayerControls(); drawScanPosition(columnIndex, false); updateUrl()
}

function updateComparisonControls(): void {
  comparisonMode = compareEnabled.checked
  compareDatePicker.disabled = !comparisonMode
  compareModeButton.disabled = !comparisonMode
  switchSideButton.disabled = !comparisonMode
  compareModeButton.textContent = `MODE: ${playbackMode === 'sequential' ? 'SEQUENTIAL' : 'A / B'}`
  showPlayingYear()
}

document.querySelectorAll<HTMLButtonElement>('.scene-button').forEach((button) => button.addEventListener('click', () => applyScene(button.dataset.scene ?? 'ocean')))
layerList.addEventListener('change', (event) => {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  const card = target.closest<HTMLElement>('[data-layer-id]')
  const state = card ? states.get(card.dataset.layerId ?? '') : undefined
  if (!state) return
  if (target.classList.contains('layer-enabled')) state.enabled = target.checked
  if (target.classList.contains('layer-volume')) state.volume = Number(target.value)
  updateLayerControls(); drawScanPosition(columnIndex, false); updateUrl()
})
layerList.addEventListener('input', (event) => {
  const target = event.target
  if (!(target instanceof HTMLInputElement) || !target.classList.contains('layer-volume')) return
  const state = states.get(target.closest<HTMLElement>('[data-layer-id]')?.dataset.layerId ?? '')
  if (!state) return
  state.volume = Number(target.value)
  const label = target.closest('.layer-card')?.querySelector<HTMLElement>('.layer-volume-value')
  if (label) label.textContent = `${Math.round(state.volume * 100)}% volume`
})
layerList.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const button = target.closest<HTMLButtonElement>('button[data-action]')
  const state = states.get(target.closest<HTMLElement>('[data-layer-id]')?.dataset.layerId ?? '')
  if (!button || !state) return
  if (button.dataset.action === 'details') {
    const card = button.closest<HTMLElement>('.layer-card')
    const expanded = card?.classList.toggle('is-expanded') ?? false
    const details = card?.querySelector<HTMLElement>('.layer-details')
    if (details) details.hidden = !expanded
    button.setAttribute('aria-expanded', String(expanded))
    button.setAttribute('aria-label', `${expanded ? 'Hide' : 'Show'} ${state.spec.id} details`)
    button.textContent = expanded ? '−' : '+'
    return
  }
  if (button.dataset.action === 'focus') setFocus(state.spec.id)
  if (button.dataset.action === 'mute') state.muted = !state.muted
  if (button.dataset.action === 'solo') { state.solo = !state.solo; if (state.solo) { state.enabled = true; state.muted = false } }
  updateLayerControls(); drawScanPosition(columnIndex, false); updateUrl()
})
stage.addEventListener('pointerdown', (event) => {
  if ((event.target as Element).closest('button[data-action="retry"]')) return
  if (!getReadyStates().length) return
  if (isPlaying) setPlaying(false)
  isScrubbing = true
  if (event.isTrusted) stage.setPointerCapture(event.pointerId)
  seekFromPointer(event, true)
})
stage.addEventListener('pointermove', (event) => { if (isScrubbing) seekFromPointer(event, true) })
function finishScrubbing(event: PointerEvent): void {
  if (!isScrubbing) return
  seekFromPointer(event, true); isScrubbing = false
  if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId)
}
stage.addEventListener('pointerup', finishScrubbing)
stage.addEventListener('pointercancel', finishScrubbing)
stage.addEventListener('click', (event) => {
  const target = event.target
  if (target instanceof Element && target.closest('button[data-action="retry"]')) {
    void loadAllLayers()
  }
})
playButton.addEventListener('click', async () => {
  if (isPlaying) { setPlaying(false); return }
  if (!getActiveStates().length) { q<HTMLElement>('#audio-notice-text').textContent = 'Enable an available layer before playing.'; return }
  try {
    await sonifier.unlock()
    q<HTMLElement>('#audio-notice-text').textContent = 'Audio enabled · compressor/limiter active.'
    if (columnIndex >= COLUMN_COUNT - 1) columnIndex = 0
    activeSide = 'A'; updateUrl(); showPlayingYear(); setPlaying(true)
  } catch (error) { q<HTMLElement>('#audio-notice-text').textContent = error instanceof Error ? error.message : 'Audio could not start.' }
})
speedSlider.addEventListener('input', () => { speedValue.value = `${Number(speedSlider.value).toFixed(1)}×`; if (isPlaying) setPlaying(true) })
datePicker.addEventListener('change', () => { selectedDate = datePicker.value; comparisonDate = shiftYear(selectedDate, -10); compareDatePicker.value = comparisonDate; activeSide = 'A'; void loadAllLayers() })
compareDatePicker.addEventListener('change', () => { comparisonDate = compareDatePicker.value; activeSide = 'A'; void loadAllLayers() })
compareEnabled.addEventListener('change', () => { updateComparisonControls(); activeSide = 'A'; void loadAllLayers() })
compareModeButton.addEventListener('click', () => { playbackMode = playbackMode === 'sequential' ? 'ab' : 'sequential'; updateComparisonControls(); updateUrl() })
switchSideButton.addEventListener('click', () => {
  if (!comparisonMode) return
  activeSide = activeSide === 'A' ? 'B' : 'A'
  showPlayingYear(); updateUrl()
  const state = states.get(focusId)
  if (state && selectedAsset(state)?.available) setFocus(focusId)
  drawScanPosition(columnIndex, false)
})
historyButton.addEventListener('click', () => {
  if (!gibsService) return
  selectedDate = getLatestCompleteDate(gibsService)
  datePicker.value = selectedDate
  comparisonDate = shiftYear(selectedDate, -10)
  compareDatePicker.value = comparisonDate
  compareEnabled.checked = true
  updateComparisonControls()
  activeSide = 'A'
  void loadAllLayers()
})
copyLinkButton.addEventListener('click', async () => {
  updateUrl()
  try {
    await navigator.clipboard.writeText(location.href)
    copyLinkButton.textContent = 'LINK COPIED'
    window.setTimeout(() => { copyLinkButton.textContent = 'COPY LINK' }, 1400)
  } catch {
    q<HTMLElement>('#audio-notice-text').textContent = 'Copy failed: select and copy the page URL from the address bar.'
  }
})
window.addEventListener('resize', () => {
  const asset = selectedAsset(states.get(focusId)!)
  const context = worldCanvas.getContext('2d')
  if (context && asset?.available) { context.imageSmoothingEnabled = false; context.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT); context.drawImage(asset.raster.canvas, 0, 0) }
})

datePicker.value = selectedDate
compareDatePicker.value = comparisonDate
compareEnabled.checked = comparisonMode
updateComparisonControls()
sonifier.setScene(audioScene())
buildLongitudeAxis()
updateLayerControls()
void loadAllLayers()
