const WMTS_CAPABILITIES_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml'
const X_LINK_NAMESPACE = 'http://www.w3.org/1999/xlink'
const CADENCE_TOLERANCE_DAYS: Record<string, number> = {
  daily: 1,
  '8-day': 4,
  '16-day': 8,
  monthly: 15,
}
const MAX_FETCH_ATTEMPTS = 3
const FETCH_TIMEOUT_MS = 45_000
export const WORLD_WIDTH = 1440
export const WORLD_HEIGHT = 720
export const SAMPLE_LATITUDES = [75, 50, 25, 0, -25, -50, -75]

export type SoundRole =
  | 'sst'
  | 'rain'
  | 'ice'
  | 'land'
  | 'ocean-life'
  | 'water-vapor'
  | 'cloud'
  | 'night-lights'

export interface LayerSpec {
  id: string
  role: SoundRole
  color: string
  defaultVolume: number
  temporalLabel: string
}

export const LAYER_SPECS: LayerSpec[] = [
  {
    id: 'GHRSST_L4_MUR_Sea_Surface_Temperature',
    role: 'sst',
    color: '#b4e5ff',
    defaultVolume: 0.65,
    temporalLabel: 'Daily',
  },
  {
    id: 'IMERG_Precipitation_Rate',
    role: 'rain',
    color: '#82d4b1',
    defaultVolume: 0.5,
    temporalLabel: 'Daily',
  },
  {
    id: 'sea-ice',
    role: 'ice',
    color: '#d5adff',
    defaultVolume: 0.42,
    temporalLabel: 'Daily',
  },
  {
    id: 'ndvi',
    role: 'land',
    color: '#e6c879',
    defaultVolume: 0.42,
    temporalLabel: 'Vegetation index composite',
  },
  {
    id: 'OCI_PACE_Chlorophyll_a',
    role: 'ocean-life',
    color: '#55c9bb',
    defaultVolume: 0.3,
    temporalLabel: 'Daily',
  },
  {
    id: 'MODIS_Terra_Water_Vapor_5km_Day',
    role: 'water-vapor',
    color: '#9eadeb',
    defaultVolume: 0.26,
    temporalLabel: 'Daily',
  },
  {
    id: 'MODIS_Terra_Cloud_Optical_Thickness',
    role: 'cloud',
    color: '#b5cbd6',
    defaultVolume: 0.26,
    temporalLabel: 'Daily',
  },
  {
    id: 'VIIRS_SNPP_DayNightBand_At_Sensor_Radiance',
    role: 'night-lights',
    color: '#f1d27b',
    defaultVolume: 0.24,
    temporalLabel: 'Daily',
  },
]

export interface ColorBin {
  rgb: [number, number, number]
  value: number
  min: number
  max: number
  nodata: boolean
  transparent: boolean
}

export interface LayerDefinition extends LayerSpec {
  logicalId: string
  name: string
  units: string
  date: string
  requestedDate: string
  usedDate: string
  sensorLabel?: string
  productLabel?: string
  archive?: boolean
  latestFallback?: boolean
  cadence: string
  available: boolean
  unavailableReason?: string
  binWidth: number
  tileTemplate: string
  tileMatrixSet: string
  tileMatrix: string
  matrixWidth: number
  matrixHeight: number
  tileWidth: number
  tileHeight: number
  colormapUrl: string
  palette: ColorBin[]
  colorLookup: ReadonlyMap<number, ColorBin>
  legendGradient: string
  minValue: number
  maxValue: number
}

export interface ProfilePoint {
  latitude: number
  value: number | null
  color: string
}

export interface ColumnReading {
  longitude: number
  x: number
  points: ProfilePoint[]
}

export interface PixelCheck {
  width: number
  height: number
  validPixels: number
  distinctColors: number
  transparentPixels: number
}

export interface LayerRaster {
  canvas: HTMLCanvasElement
  imageData: ImageData
  check: PixelCheck
}

export interface LoadedLayer extends LayerDefinition {
  raster: LayerRaster
}

export interface GibsService {
  wmts: Document
}

export interface PublishedDate {
  requestedDate: string
  usedDate: string
  productId: string
  sensorLabel: string
  productLabel: string
  archive: boolean
  latestFallback?: boolean
  available: boolean
  cadence: string
  reason?: string
}

const rasterCache = new Map<string, Promise<LayerRaster>>()

export async function loadGibsService(): Promise<GibsService> {
  const wmts = await fetchXml(WMTS_CAPABILITIES_URL, 'GIBS EPSG:4326 WMTS capabilities')
  return { wmts }
}

function resolveFromCapabilities(
  service: GibsService,
  spec: LayerSpec,
  requestedDate: string,
  comparisonMode: boolean,
): PublishedDate {
  if (spec.id === 'sea-ice') {
    if (requestedDate > '2025-09-01') {
      const archiveDate = matchingArchiveDate(service, 'AMSRU2_Sea_Ice_Concentration_12km', requestedDate)
      return archiveDate
        ? makePublished(requestedDate, archiveDate, 'AMSRU2_Sea_Ice_Concentration_12km', 'AMSR2', 'AMSR2 sea ice', true, 'daily')
        : makeUnavailable(requestedDate, 'AMSRU2_Sea_Ice_Concentration_12km', 'AMSR2', 'AMSR2 sea-ice archive', 'No same-calendar-day archive exists.')
    }
    const amsr2 = chooseCapabilityDate(service, 'AMSRU2_Sea_Ice_Concentration_12km', requestedDate, CADENCE_TOLERANCE_DAYS.daily)
    if (amsr2) return makePublished(requestedDate, amsr2, 'AMSRU2_Sea_Ice_Concentration_12km', 'AMSR2', 'AMSR2 sea ice', false, 'daily')
    const amsre = chooseCapabilityDate(service, 'AMSRUE_Sea_Ice_Concentration_12km', requestedDate, CADENCE_TOLERANCE_DAYS.daily)
    if (amsre) return makePublished(requestedDate, amsre, 'AMSRUE_Sea_Ice_Concentration_12km', 'AMSR-E', 'AMSR-E sea ice', true, 'daily')
    return makeUnavailable(requestedDate, 'AMSRU2_Sea_Ice_Concentration_12km', 'AMSR-E / AMSR2', 'Sea ice', 'Outside the advertised product dates or in the AMSR-E/AMSR2 gap.')
  }

  if (spec.id === 'ndvi') {
    if (!comparisonMode && isRecent(requestedDate, latestCapabilityDate(service, 'VIIRS_NOAA21_NDVI_8Day'), 30)) {
      const viirsId = 'VIIRS_NOAA21_NDVI_8Day'
      const viirsDate = chooseCapabilityDate(service, viirsId, requestedDate, CADENCE_TOLERANCE_DAYS['8-day'])
      const latestViirsDate = viirsDate ?? latestCapabilityDateOnOrBefore(service, viirsId, requestedDate)
      if (latestViirsDate) {
        return makePublished(
          requestedDate,
          latestViirsDate,
          viirsId,
          'VIIRS NOAA-21',
          'VIIRS NOAA-21 rolling 8-day NDVI',
          false,
          '8-day',
          !viirsDate,
        )
      }
    }
    const terraId = 'MODIS_Terra_L3_NDVI_16Day'
    const terraDate = chooseCapabilityDate(service, terraId, requestedDate, CADENCE_TOLERANCE_DAYS['16-day'])
    const latestTerraDate = terraDate ?? latestCapabilityDateOnOrBefore(service, terraId, requestedDate)
    return latestTerraDate
      ? makePublished(
          requestedDate,
          latestTerraDate,
          terraId,
          'MODIS Terra',
          'MODIS Terra 16-day NDVI',
          false,
          '16-day',
          !terraDate,
        )
      : makeUnavailable(requestedDate, 'MODIS_Terra_L3_NDVI_16Day', 'MODIS Terra', 'MODIS Terra 16-day NDVI', 'No composite within the 16-day tolerance.', '16-day')
  }

  const productDetails: Record<string, { sensor: string; label: string }> = {
    OCI_PACE_Chlorophyll_a: { sensor: 'PACE OCI', label: 'PACE chlorophyll-a' },
    MODIS_Terra_Water_Vapor_5km_Day: { sensor: 'MODIS Terra', label: 'MODIS daytime water vapor' },
    MODIS_Terra_Cloud_Optical_Thickness: { sensor: 'MODIS Terra', label: 'MODIS cloud optical thickness' },
    VIIRS_SNPP_DayNightBand_At_Sensor_Radiance: {
      sensor: 'VIIRS Suomi-NPP',
      label: 'VIIRS day/night-band at-sensor radiance',
    },
  }
  const details = productDetails[spec.id]
  if (spec.role === 'night-lights') {
    const dates = capabilityDates(service, spec.id)
    const latestPriorDate = dates.filter((date) => date <= requestedDate).at(-1)
    if (!latestPriorDate || dayDifference(requestedDate, latestPriorDate) > 5) {
      return makeUnavailable(
        requestedDate,
        spec.id,
        details?.sensor ?? spec.id,
        details?.label ?? spec.id,
        'No observation within 5 days before the requested date.',
      )
    }
    return makePublished(
      requestedDate,
      latestPriorDate,
      spec.id,
      details?.sensor ?? spec.id,
      details?.label ?? spec.id,
      false,
      'daily',
      latestPriorDate !== requestedDate,
    )
  }
  const date = chooseCapabilityDate(service, spec.id, requestedDate, CADENCE_TOLERANCE_DAYS.daily)
  return date
    ? makePublished(
        requestedDate,
        date,
        spec.id,
        details?.sensor ?? spec.id,
        details?.label ?? spec.id,
        false,
        'daily',
      )
    : makeUnavailable(
        requestedDate,
        spec.id,
        details?.sensor ?? spec.id,
        details?.label ?? spec.id,
        'No daily observation within ±1 day.',
      )
}

function makePublished(
  requestedDate: string,
  usedDate: string,
  productId: string,
  sensorLabel: string,
  productLabel: string,
  archive: boolean,
  cadence: string,
  latestFallback = false,
): PublishedDate {
  return {
    requestedDate,
    usedDate,
    productId,
    sensorLabel,
    productLabel,
    archive,
    latestFallback,
    available: true,
    cadence,
  }
}

function makeUnavailable(
  requestedDate: string,
  productId: string,
  sensorLabel: string,
  productLabel: string,
  reason: string,
  cadence = 'daily',
): PublishedDate {
  return {
    requestedDate,
    usedDate: 'Not available',
    productId,
    sensorLabel,
    productLabel,
    archive: false,
    available: false,
    cadence,
    reason,
  }
}

function findWmtsLayer(service: GibsService, id: string): Element | undefined {
  return Array.from(service.wmts.getElementsByTagNameNS('*', 'Layer')).find(
    (candidate) => directChildText(candidate, 'Identifier') === id,
  )
}

interface WmtsTileGrid {
  template: string
  matrixSet: string
  matrix: string
  matrixWidth: number
  matrixHeight: number
  tileWidth: number
  tileHeight: number
}

function findWmtsTileGrid(service: GibsService, layer: Element, id: string): WmtsTileGrid {
  const resources = Array.from(layer.getElementsByTagNameNS('*', 'ResourceURL')).filter(
    (candidate) =>
      candidate.getAttribute('resourceType') === 'tile' &&
      candidate.getAttribute('format')?.toLowerCase() === 'image/png' &&
      candidate.hasAttribute('template'),
  )
  const resource =
    resources.find((candidate) => candidate.getAttribute('template')?.includes('{Time}')) ?? resources[0]
  const template = resource?.getAttribute('template')
  if (!template) throw new Error(`${id} has no PNG tile URL in GIBS WMTS capabilities.`)

  const matrixSetLinks = Array.from(layer.getElementsByTagNameNS('*', 'TileMatrixSetLink'))
  const candidates: Array<WmtsTileGrid & { pixels: number; coversRaster: boolean }> = []
  for (const link of matrixSetLinks) {
    const matrixSetId = directChildText(link, 'TileMatrixSet')
    if (!matrixSetId) continue
    const matrixSet = Array.from(service.wmts.getElementsByTagNameNS('*', 'TileMatrixSet')).find(
      (candidate) => directChildText(candidate, 'Identifier') === matrixSetId,
    )
    if (!matrixSet) continue
    for (const matrix of Array.from(matrixSet.getElementsByTagNameNS('*', 'TileMatrix'))) {
      const matrixWidth = Number(directChildText(matrix, 'MatrixWidth'))
      const matrixHeight = Number(directChildText(matrix, 'MatrixHeight'))
      const tileWidth = Number(directChildText(matrix, 'TileWidth'))
      const tileHeight = Number(directChildText(matrix, 'TileHeight'))
      if (![matrixWidth, matrixHeight, tileWidth, tileHeight].every(Number.isFinite)) continue
      candidates.push({
        template,
        matrixSet: matrixSetId,
        matrix: directChildText(matrix, 'Identifier') ?? '',
        matrixWidth,
        matrixHeight,
        tileWidth,
        tileHeight,
        pixels: matrixWidth * matrixHeight * tileWidth * tileHeight,
        coversRaster: matrixWidth * tileWidth >= WORLD_WIDTH && matrixHeight * tileHeight >= WORLD_HEIGHT,
      })
    }
  }
  const suitable = candidates.filter((candidate) => candidate.coversRaster).sort((a, b) => a.pixels - b.pixels)
  const selected = suitable[0] ?? candidates.sort((a, b) => b.pixels - a.pixels)[0]
  if (!selected) throw new Error(`${id} has no EPSG:4326 tile matrix in GIBS WMTS capabilities.`)
  return selected
}

function capabilityDates(service: GibsService, id: string): string[] {
  const layer = findWmtsLayer(service, id)
  if (!layer) return []
  const dimension = Array.from(layer.getElementsByTagNameNS('*', 'Dimension')).find(
    (item) => directChildText(item, 'Identifier') === 'Time',
  )
  if (!dimension) return []
  const dates = new Set<string>()
  for (const item of Array.from(dimension.getElementsByTagNameNS('*', 'Value'))) {
    const value = item.textContent?.trim() ?? ''
    const range = value.match(/^(\d{4}-\d{2}-\d{2})(?:T[^/]+)?\/(\d{4}-\d{2}-\d{2})(?:T[^/]+)?\/P(\d+)(D|M)$/)
    if (range) {
      const [, first, last, count, unit] = range
      const step = Number(count)
      let cursor = new Date(`${first}T00:00:00Z`)
      const end = new Date(`${last}T00:00:00Z`)
      while (cursor <= end) {
        dates.add(cursor.toISOString().slice(0, 10))
        if (unit === 'D') cursor.setUTCDate(cursor.getUTCDate() + step)
        else cursor.setUTCMonth(cursor.getUTCMonth() + step)
      }
    } else {
      const exact = value.match(/^(\d{4}-\d{2}-\d{2})/)
      if (exact) dates.add(exact[1])
    }
  }
  return Array.from(dates).sort()
}

function latestCapabilityDate(service: GibsService, id: string): string {
  return capabilityDates(service, id).at(-1) ?? ''
}

function latestCapabilityDateOnOrBefore(service: GibsService, id: string, requested: string): string | undefined {
  return capabilityDates(service, id).filter((date) => date <= requested).at(-1)
}

function dayDifference(later: string, earlier: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000)
}

export function getLatestCompleteDate(service: GibsService): string {
  return latestCapabilityDate(service, 'GHRSST_L4_MUR_Sea_Surface_Temperature')
}

function chooseCapabilityDate(service: GibsService, id: string, requested: string, tolerance: number): string | undefined {
  const dates = capabilityDates(service, id)
  if (dates.length === 0 || requested < dates[0] || requested > dates[dates.length - 1]) return undefined
  const requestedTime = Date.parse(`${requested}T00:00:00Z`)
  let selected: string | undefined
  let selectedDistance = Number.POSITIVE_INFINITY
  for (const date of dates) {
    const distance = Math.abs(Date.parse(`${date}T00:00:00Z`) - requestedTime) / 86_400_000
    if (distance < selectedDistance || (distance === selectedDistance && date < (selected ?? date))) {
      selected = date
      selectedDistance = distance
    }
  }
  return selectedDistance <= tolerance ? selected : undefined
}

function matchingArchiveDate(service: GibsService, id: string, requested: string): string | undefined {
  const monthDay = requested.slice(5)
  return capabilityDates(service, id)
    .filter((date) => date.slice(5) === monthDay && date < requested)
    .at(-1)
}

function isRecent(requested: string, latest: string, days: number): boolean {
  if (!latest || requested > latest) return false
  const delta = (Date.parse(`${latest}T00:00:00Z`) - Date.parse(`${requested}T00:00:00Z`)) / 86_400_000
  return delta >= 0 && delta <= days
}

export async function loadLayerDefinition(
  service: GibsService,
  spec: LayerSpec,
  requestedDate: string,
  comparisonMode = false,
): Promise<LayerDefinition> {
  const resolved = resolveFromCapabilities(service, spec, requestedDate, comparisonMode)
  const wmtsLayer = Array.from(service.wmts.getElementsByTagNameNS('*', 'Layer')).find(
    (candidate) => directChildText(candidate, 'Identifier') === resolved.productId,
  )
  if (!wmtsLayer) throw new Error(`GIBS WMTS capabilities do not advertise ${resolved.productId}.`)
  const tileGrid = findWmtsTileGrid(service, wmtsLayer, resolved.productId)
  const date = resolved.available ? resolved.usedDate : requestedDate

  const metadata = Array.from(wmtsLayer.getElementsByTagNameNS('*', 'Metadata'))
    .map((node) => ({
      role: node.getAttributeNS(X_LINK_NAMESPACE, 'role') ?? '',
      href: node.getAttributeNS(X_LINK_NAMESPACE, 'href') ?? '',
    }))
    .filter(({ role, href }) => role.includes('colormap') && href.startsWith('https://'))
    .sort((left, right) => compareColormapVersions(right.role, left.role))[0]
  if (!metadata) throw new Error(`${resolved.productId} has no colormap link in its GIBS metadata.`)

  const colormap = await fetchXml(metadata.href, `${resolved.productId} colormap`)
  const maps = Array.from(colormap.getElementsByTagNameNS('*', 'ColorMap'))
  const dataMap = maps
    .filter((candidate) => candidate.getElementsByTagNameNS('*', 'ColorMapEntry').length > 0)
    .sort(
      (left, right) =>
        Number(right.hasAttribute('units')) - Number(left.hasAttribute('units')) ||
        right.getElementsByTagNameNS('*', 'ColorMapEntry').length -
          left.getElementsByTagNameNS('*', 'ColorMapEntry').length,
    )[0]
  if (!dataMap) throw new Error(`${resolved.productId} colormap has no ColorMap.`)
  const unitText = dataMap.getAttribute('units')?.trim() ?? ''
  const units = unitText || 'unitless (colormap values)'
  const rawEntries = Array.from(dataMap.getElementsByTagNameNS('*', 'ColorMapEntry'))
  const finiteRanges = rawEntries
    .map((entry) => parseRange(entry.getAttribute('value') ?? entry.getAttribute('sourceValue') ?? ''))
    .filter((range): range is [number, number] => range !== null)
  if (finiteRanges.length === 0) throw new Error(`${resolved.productId} colormap has no numeric measurement values.`)
  const widths = finiteRanges.map(([min, max]) => Math.abs(max - min)).filter((width) => width > 0)
  if (widths.length === 0) {
    const values = Array.from(new Set(finiteRanges.map(([min]) => min))).sort((left, right) => left - right)
    const smallestStep = values.slice(1).map((value, index) => value - values[index]).find((step) => step > 0)
    if (smallestStep === undefined) throw new Error(`${resolved.productId} colormap has no measurable value bins.`)
    widths.push(smallestStep)
  }
  const nominalBinWidth = Math.max(...widths)

  const palette = rawEntries
    .map((entry) => {
      const range = parseRange(entry.getAttribute('value') ?? entry.getAttribute('sourceValue') ?? '')
      const rgb = (entry.getAttribute('rgb') ?? '').split(',').map(Number)
      if (!range || rgb.length !== 3 || !rgb.every(Number.isFinite)) return null
      const nodata = entry.getAttribute('nodata') === 'true'
      const transparent = entry.getAttribute('transparent') === 'true' || nodata
      const [min, max] = normalizeRange(range, nominalBinWidth)
      return {
        rgb: rgb as [number, number, number],
        value: (min + max) / 2,
        min,
        max,
        nodata,
        transparent,
      }
    })
    .filter((entry): entry is ColorBin => entry !== null && !entry.transparent && !entry.nodata)
  if (palette.length === 0) throw new Error(`${resolved.productId} colormap has no valid data colors.`)
  const colorLookup = new Map<number, ColorBin>()
  for (const bin of palette) colorLookup.set(rgbKey(...bin.rgb), bin)

  const minValue = Math.min(...palette.map((entry) => entry.min))
  const maxValue = Math.max(...palette.map((entry) => entry.max))
  const legendGradient = palette
    .map((entry, index) => `rgb(${entry.rgb.join(',')}) ${(index / (palette.length - 1)) * 100}%`)
    .join(', ')
  return {
    ...spec,
    id: resolved.productId,
    logicalId: spec.id,
    name: directChildText(wmtsLayer, 'Title') ?? resolved.productId,
    units,
    date,
    requestedDate,
    usedDate: resolved.usedDate,
    sensorLabel: resolved.sensorLabel,
    productLabel: resolved.productLabel,
    archive: resolved.archive,
    latestFallback: resolved.latestFallback,
    cadence: resolved.cadence,
    available: resolved.available,
    unavailableReason: resolved.reason,
    binWidth: nominalBinWidth,
    tileTemplate: tileGrid.template,
    tileMatrixSet: tileGrid.matrixSet,
    tileMatrix: tileGrid.matrix,
    matrixWidth: tileGrid.matrixWidth,
    matrixHeight: tileGrid.matrixHeight,
    tileWidth: tileGrid.tileWidth,
    tileHeight: tileGrid.tileHeight,
    colormapUrl: metadata.href,
    palette,
    colorLookup,
    legendGradient: `linear-gradient(90deg, ${legendGradient})`,
    minValue,
    maxValue,
  }
}

export async function loadLayerRaster(definition: LayerDefinition): Promise<LayerRaster> {
  const cacheKey = `${definition.id}:${definition.date}`
  let cached = rasterCache.get(cacheKey)
  if (!cached) {
    cached = fetchLayerRaster(definition)
    rasterCache.set(cacheKey, cached)
    cached.catch(() => rasterCache.delete(cacheKey))
  }
  return cached
}

export async function loadLayer(
  service: GibsService,
  spec: LayerSpec,
  requestedDate: string,
  comparisonMode = false,
): Promise<LoadedLayer> {
  const definition = await loadLayerDefinition(service, spec, requestedDate, comparisonMode)
  if (!definition.available) {
    const canvas = document.createElement('canvas')
    canvas.width = WORLD_WIDTH
    canvas.height = WORLD_HEIGHT
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('This browser could not create a 2D canvas context.')
    const imageData = context.createImageData(WORLD_WIDTH, WORLD_HEIGHT)
    return {
      ...definition,
      raster: {
        canvas,
        imageData,
        check: {
          width: WORLD_WIDTH,
          height: WORLD_HEIGHT,
          validPixels: 0,
          distinctColors: 0,
          transparentPixels: WORLD_WIDTH * WORLD_HEIGHT,
        },
      },
    }
  }
  const raster = await loadLayerRaster(definition)
  return { ...definition, raster }
}

export function sampleLayerColumn(
  imageData: ImageData,
  definition: LayerDefinition,
  column: number,
  smoothingRadius = 0,
): ColumnReading {
  const x = Math.min(WORLD_WIDTH - 1, Math.max(0, Math.round(column)))
  const points = SAMPLE_LATITUDES.map((latitude) => {
    const y = latitudeToPixel(latitude)
    const bins: ColorBin[] = []
    const radius = Math.max(0, Math.floor(smoothingRadius))
    for (let dy = -Math.min(2, radius); dy <= Math.min(2, radius); dy += 1) {
      const sampleY = Math.min(imageData.height - 1, Math.max(0, y + dy))
      for (let dx = -radius; dx <= radius; dx += 1) {
        const sampleX = Math.min(imageData.width - 1, Math.max(0, x + dx))
        const offset = (sampleY * imageData.width + sampleX) * 4
        if (imageData.data[offset + 3] <= 12) continue
        const bin = resolveColor(
          definition.palette,
          definition.colorLookup,
          imageData.data[offset],
          imageData.data[offset + 1],
          imageData.data[offset + 2],
        )
        if (bin) bins.push(bin)
      }
    }
    if (bins.length === 0 || (radius > 0 && bins.length < 3)) {
      return { latitude, value: null, color: 'transparent' }
    }
    const value = bins.reduce((total, bin) => total + bin.value, 0) / bins.length
    const colorBin = bins[Math.floor(bins.length / 2)]
    return { latitude, value, color: `rgb(${colorBin.rgb.join(',')})` }
  })
  return { longitude: (x / (WORLD_WIDTH - 1)) * 360 - 180, x, points }
}

export function longitudeToPixel(longitude: number): number {
  return Math.min(
    WORLD_WIDTH - 1,
    Math.max(0, Math.round(((longitude + 180) / 360) * (WORLD_WIDTH - 1))),
  )
}

export function latitudeToPixel(latitude: number): number {
  return Math.min(
    WORLD_HEIGHT - 1,
    Math.max(0, Math.round(((90 - latitude) / 180) * (WORLD_HEIGHT - 1))),
  )
}

async function fetchLayerRaster(definition: LayerDefinition): Promise<LayerRaster> {
  const tileTasks: Array<Promise<{ row: number; column: number; bitmap?: ImageBitmap }>> = []
  for (let row = 0; row < definition.matrixHeight; row += 1) {
    for (let column = 0; column < definition.matrixWidth; column += 1) {
      tileTasks.push(fetchWmtsTile(definition, row, column))
    }
  }
  const settledTiles = await Promise.allSettled(tileTasks)
  const rejectedTile = settledTiles.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (rejectedTile) {
    for (const result of settledTiles) {
      if (result.status === 'fulfilled') result.value.bitmap?.close()
    }
    throw rejectedTile.reason
  }
  const tiles = settledTiles.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  const mosaic = document.createElement('canvas')
  mosaic.width = definition.matrixWidth * definition.tileWidth
  mosaic.height = definition.matrixHeight * definition.tileHeight
  const mosaicContext = mosaic.getContext('2d', { willReadFrequently: true })
  if (!mosaicContext) {
    for (const tile of tiles) tile.bitmap?.close()
    throw new Error('This browser could not create a 2D canvas context.')
  }
  mosaicContext.imageSmoothingEnabled = false
  for (const { row, column, bitmap } of tiles) {
    if (bitmap) {
      mosaicContext.drawImage(bitmap, column * definition.tileWidth, row * definition.tileHeight)
      bitmap.close()
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = WORLD_WIDTH
  canvas.height = WORLD_HEIGHT
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('This browser could not create a 2D canvas context.')
  context.imageSmoothingEnabled = false
  const worldTileWidth = definition.matrixWidth * definition.tileWidth
  const worldTileHeight = Math.ceil(worldTileWidth / 2)
  context.drawImage(mosaic, 0, 0, worldTileWidth, worldTileHeight, 0, 0, WORLD_WIDTH, WORLD_HEIGHT)
  const imageData = context.getImageData(0, 0, WORLD_WIDTH, WORLD_HEIGHT)
  const check = verifyPixels(imageData, definition)
  if (check.validPixels < 1_000 || check.distinctColors < 10) {
    throw new Error(
      `Only ${check.validPixels} valid pixels in ${check.distinctColors} colors; this date is effectively empty.`,
    )
  }
  return { canvas, imageData, check }
}

async function fetchWmtsTile(
  definition: LayerDefinition,
  row: number,
  column: number,
): Promise<{ row: number; column: number; bitmap?: ImageBitmap }> {
  const replacements: Record<string, string> = {
    Time: definition.date,
    TileMatrixSet: definition.tileMatrixSet,
    TileMatrix: definition.tileMatrix,
    TileRow: String(row),
    TileCol: String(column),
  }
  const tileUrl = definition.tileTemplate.replace(/\{([^}]+)\}/g, (placeholder, key: string) => {
    const value = replacements[key]
    if (value === undefined) throw new Error(`Unsupported GIBS WMTS tile placeholder: ${placeholder}`)
    return encodeURIComponent(value)
  })
  const response = await fetchWithRetry(tileUrl, { mode: 'cors', credentials: 'omit' }, `${definition.id} tile ${row}/${column}`)
  if (response.status === 404) return { row, column }
  if (!response.ok) throw new Error(`GIBS returned HTTP ${response.status} for ${definition.date} tile ${row}/${column}.`)
  if (!response.headers.get('content-type')?.toLowerCase().includes('image/png')) {
    throw new Error(`GIBS returned a non-PNG tile for ${definition.date} (${row}/${column}).`)
  }
  const bitmap = await createImageBitmap(await response.blob())
  if (bitmap.width !== definition.tileWidth || bitmap.height !== definition.tileHeight) {
    const { width, height } = bitmap
    bitmap.close()
    throw new Error(
      `GIBS returned a ${width}×${height} tile; expected ${definition.tileWidth}×${definition.tileHeight}.`,
    )
  }
  return { row, column, bitmap }
}

function verifyPixels(imageData: ImageData, definition: LayerDefinition): PixelCheck {
  let validPixels = 0
  let transparentPixels = 0
  const colors = new Set<string>()
  for (let offset = 0; offset < imageData.data.length; offset += 4) {
    const [red, green, blue, alpha] = imageData.data.subarray(offset, offset + 4)
    if (alpha <= 12) {
      transparentPixels += 1
      continue
    }
    if (!definition.colorLookup.has(rgbKey(red, green, blue))) continue
    validPixels += 1
    colors.add(`${red},${green},${blue}`)
  }
  return {
    width: imageData.width,
    height: imageData.height,
    validPixels,
    distinctColors: colors.size,
    transparentPixels,
  }
}

function resolveColor(
  palette: ColorBin[],
  lookup: ReadonlyMap<number, ColorBin>,
  red: number,
  green: number,
  blue: number,
): ColorBin | undefined {
  const exact = lookup.get(rgbKey(red, green, blue))
  if (exact) return exact
  let closest: ColorBin | undefined
  let closestDistance = Number.POSITIVE_INFINITY
  for (const bin of palette) {
    const distance =
      (bin.rgb[0] - red) ** 2 + (bin.rgb[1] - green) ** 2 + (bin.rgb[2] - blue) ** 2
    if (distance < closestDistance) {
      closest = bin
      closestDistance = distance
      if (distance === 0) break
    }
  }
  return closestDistance <= 36 ? closest : undefined
}

async function fetchXml(url: string, label: string): Promise<Document> {
  const response = await fetchWithRetry(url, { mode: 'cors', credentials: 'omit' }, label)
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`)
  const xml = new DOMParser().parseFromString(await response.text(), 'application/xml')
  if (xml.querySelector('parsererror')) throw new Error(`${label} was not valid XML.`)
  return xml
}

async function fetchWithRetry(url: string | URL, init: RequestInit, label: string): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      if (response.ok || (response.status < 500 && response.status !== 429)) return response
      lastError = new Error(`HTTP ${response.status}`)
      if (attempt === MAX_FETCH_ATTEMPTS) {
        throw new Error(`${label}: NASA GIBS returned HTTP ${response.status} after ${attempt} attempts.`)
      }
    } catch (error) {
      lastError = error
      if (attempt === MAX_FETCH_ATTEMPTS) {
        const detail =
          error instanceof DOMException && error.name === 'AbortError'
            ? 'request timed out'
            : error instanceof Error && error.message !== 'Failed to fetch'
              ? error.message
              : 'network connection or browser CORS policy blocked the request'
        throw new Error(
          `${label}: could not reach NASA GIBS after ${attempt} attempts (${detail}). Check your connection and access to gibs.earthdata.nasa.gov, then retry.`,
        )
      }
    } finally {
      window.clearTimeout(timeout)
    }
    await new Promise((resolve) => window.setTimeout(resolve, 400 * 2 ** (attempt - 1)))
  }
  throw lastError instanceof Error ? lastError : new Error(`${label}: request failed.`)
}

function directChildText(parent: Element, localName: string): string | null {
  return Array.from(parent.children)
    .find((child) => child.localName === localName)
    ?.textContent?.trim() ?? null
}

function parseRange(value: string): [number, number] | null {
  if (!value.trim()) return null
  const range = value.match(/^\[\s*(-?INF|-?\d+(?:\.\d+)?)\s*,\s*(-?INF|-?\d+(?:\.\d+)?)\s*\)$/i)
  if (range) {
    const lower = range[1].toUpperCase() === '-INF' ? Number.NaN : Number(range[1])
    const upper = range[2].toUpperCase() === 'INF' ? Number.NaN : Number(range[2])
    return [lower, upper]
  }
  const number = Number(value)
  return Number.isFinite(number) ? [number, number] : null
}

function normalizeRange(range: [number, number], binWidth: number): [number, number] {
  const [lower, upper] = range
  if (!Number.isFinite(lower) && Number.isFinite(upper)) return [upper - binWidth, upper]
  if (Number.isFinite(lower) && !Number.isFinite(upper)) return [lower, lower + binWidth]
  if (!Number.isFinite(lower) && !Number.isFinite(upper)) return [0, binWidth]
  if (lower === upper) return [lower - binWidth / 2, upper + binWidth / 2]
  return [lower, upper]
}

function compareColormapVersions(left: string, right: string): number {
  const version = (role: string) => role.match(/colormap\/(\d+(?:\.\d+)?)/)?.[1] ?? '0'
  const [leftMajor, leftMinor] = version(left).split('.').map(Number)
  const [rightMajor, rightMinor] = version(right).split('.').map(Number)
  return leftMajor - rightMajor || leftMinor - rightMinor
}

function rgbKey(red: number, green: number, blue: number): number {
  return (red << 16) | (green << 8) | blue
}
