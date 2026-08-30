/**
 * Pure SVG builder for CanvasChartDocument.
 *
 * Single source of truth for transcript fences, Canvas Dock tabs, and main-process
 * screenshot rasterization. No React, no chart libraries — raw SVG strings only.
 *
 * Visual language mirrors TokenUsageChart / UsageHeatmap provider swatches
 * (`HEATMAP_PROVIDER_COLOR_HEX` / `--provider-*-color`).
 */

import type { CanvasChartDocument, CanvasChartKind, CanvasChartPoint } from './canvasChart'

/** Default viewport — fits a height-capped transcript block (~280px) and dock pane. */
export const CANVAS_CHART_SVG_DEFAULT_WIDTH = 480
export const CANVAS_CHART_SVG_DEFAULT_HEIGHT = 260

/**
 * Series palette — same hexes as renderer `HEATMAP_PROVIDER_COLOR_HEX` in
 * provider dominance order (codex → …). Kept as literals here so main can
 * import this module without pulling renderer code.
 */
export const CANVAS_CHART_SERIES_COLORS = [
  '#705AFF', // codex
  '#B16105', // claude
  '#346EEC', // gemini
  '#0073E6', // kimi
  '#757575', // grok
  '#8C7508', // cursor
  '#976C52', // ollama
  '#308713' // antigravity
] as const

const TEXT_PRIMARY = 'rgba(255, 255, 255, 0.92)'
const TEXT_SECONDARY = 'rgba(255, 255, 255, 0.55)'
const PANEL_BG = 'rgba(28, 28, 32, 0.92)'
const PANEL_BORDER = 'rgba(255, 255, 255, 0.10)'
const GRID_STROKE = 'rgba(255, 255, 255, 0.08)'
const AXIS_STROKE = 'rgba(255, 255, 255, 0.22)'

export interface ChartDocumentToSvgOptions {
  width?: number
  height?: number
}

interface PlotPoint {
  xLabel: string
  xNumeric: number
  y: number
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function clampSize(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(120, Math.min(2400, Math.round(value)))
}

function seriesColor(index: number): string {
  return CANVAS_CHART_SERIES_COLORS[index % CANVAS_CHART_SERIES_COLORS.length]!
}

function pointToPlot(point: CanvasChartPoint, index: number): PlotPoint {
  if (typeof point.x === 'number' && Number.isFinite(point.x)) {
    return { xLabel: String(point.x), xNumeric: point.x, y: point.y }
  }
  return { xLabel: String(point.x), xNumeric: index, y: point.y }
}

function niceMax(maxY: number): number {
  if (!(maxY > 0)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(maxY))
  const normalized = maxY / magnitude
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return nice * magnitude
}

function collectDomain(doc: CanvasChartDocument): {
  minX: number
  maxX: number
  minY: number
  maxY: number
  categorical: boolean
  categories: string[]
} {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = 0
  let maxY = Number.NEGATIVE_INFINITY
  let categorical = false
  const categorySet: string[] = []
  const seen = new Set<string>()

  for (const series of doc.series) {
    series.points.forEach((point, index) => {
      const plot = pointToPlot(point, index)
      if (typeof point.x === 'string') categorical = true
      if (!seen.has(plot.xLabel)) {
        seen.add(plot.xLabel)
        categorySet.push(plot.xLabel)
      }
      minX = Math.min(minX, plot.xNumeric)
      maxX = Math.max(maxX, plot.xNumeric)
      minY = Math.min(minY, plot.y)
      maxY = Math.max(maxY, plot.y)
    })
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    minX = 0
    maxX = 1
  }
  if (minX === maxX) {
    maxX = minX + 1
  }
  if (!Number.isFinite(maxY) || maxY <= 0) {
    maxY = 1
  }
  if (minY > 0) minY = 0
  maxY = niceMax(maxY)
  if (minY < 0) {
    // Symmetric-ish floor for negative values (scatter/line may dip below 0).
    const floor = -niceMax(Math.abs(minY))
    minY = floor
  }

  return { minX, maxX, minY, maxY, categorical, categories: categorySet }
}

function scaleX(value: number, minX: number, maxX: number, left: number, plotW: number): number {
  const t = (value - minX) / (maxX - minX)
  return left + t * plotW
}

function scaleY(value: number, minY: number, maxY: number, top: number, plotH: number): number {
  const t = (value - minY) / (maxY - minY)
  return top + plotH - t * plotH
}

function renderGrid(
  left: number,
  top: number,
  plotW: number,
  plotH: number,
  minY: number,
  maxY: number
): string {
  const lines: string[] = []
  const ticks = 4
  for (let i = 0; i <= ticks; i++) {
    const yVal = minY + ((maxY - minY) * i) / ticks
    const y = scaleY(yVal, minY, maxY, top, plotH)
    lines.push(
      `<line x1="${left.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(left + plotW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${GRID_STROKE}" stroke-width="1"/>`
    )
    const label = Number.isInteger(yVal) ? String(yVal) : yVal.toFixed(1)
    lines.push(
      `<text x="${(left - 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="${TEXT_SECONDARY}" font-size="10" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXml(label)}</text>`
    )
  }
  return lines.join('')
}

function renderLineOrArea(
  doc: CanvasChartDocument,
  kind: 'line' | 'area',
  left: number,
  top: number,
  plotW: number,
  plotH: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number
): string {
  const parts: string[] = []
  doc.series.forEach((series, seriesIndex) => {
    const color = seriesColor(seriesIndex)
    const coords = series.points.map((point, index) => {
      const plot = pointToPlot(point, index)
      return {
        x: scaleX(plot.xNumeric, minX, maxX, left, plotW),
        y: scaleY(plot.y, minY, maxY, top, plotH)
      }
    })
    if (coords.length === 0) return
    const lineD = coords
      .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(2)} ${c.y.toFixed(2)}`)
      .join(' ')
    if (kind === 'area') {
      const baseline = scaleY(Math.max(0, minY), minY, maxY, top, plotH)
      const first = coords[0]!
      const last = coords[coords.length - 1]!
      const areaD = `${lineD} L${last.x.toFixed(2)} ${baseline.toFixed(2)} L${first.x.toFixed(2)} ${baseline.toFixed(2)} Z`
      parts.push(`<path d="${areaD}" fill="${color}" fill-opacity="0.28" stroke="none"/>`)
    }
    parts.push(
      `<path d="${lineD}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    )
  })
  return parts.join('')
}

function renderBars(
  doc: CanvasChartDocument,
  left: number,
  top: number,
  plotW: number,
  plotH: number,
  minY: number,
  maxY: number,
  categories: string[]
): string {
  const parts: string[] = []
  const catCount = Math.max(1, categories.length)
  const seriesCount = Math.max(1, doc.series.length)
  const groupW = plotW / catCount
  const innerGap = groupW * 0.18
  const usable = groupW - innerGap
  const barW = Math.max(2, usable / seriesCount - 1)
  const zeroY = scaleY(0, minY, maxY, top, plotH)

  const categoryIndex = new Map(categories.map((c, i) => [c, i]))

  doc.series.forEach((series, seriesIndex) => {
    const color = seriesColor(seriesIndex)
    for (const point of series.points) {
      const label = String(point.x)
      const idx =
        categoryIndex.get(label) ?? (typeof point.x === 'number' ? Math.round(point.x) : 0)
      const groupX = left + idx * groupW + innerGap / 2
      const x = groupX + seriesIndex * (barW + 1)
      const y = scaleY(point.y, minY, maxY, top, plotH)
      const height = Math.max(1.5, Math.abs(zeroY - y))
      const topY = point.y >= 0 ? y : zeroY
      parts.push(
        `<rect x="${x.toFixed(2)}" y="${topY.toFixed(2)}" width="${barW.toFixed(2)}" height="${height.toFixed(2)}" fill="${color}" rx="1.5" ry="1.5"/>`
      )
    }
  })

  // Category tick labels (sparse when many).
  const labelEvery = Math.max(1, Math.ceil(categories.length / 8))
  categories.forEach((category, index) => {
    if (index % labelEvery !== 0 && index !== categories.length - 1) return
    const x = left + index * groupW + groupW / 2
    parts.push(
      `<text x="${x.toFixed(1)}" y="${(top + plotH + 14).toFixed(1)}" text-anchor="middle" fill="${TEXT_SECONDARY}" font-size="10" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXml(category)}</text>`
    )
  })

  return parts.join('')
}

function renderScatter(
  doc: CanvasChartDocument,
  left: number,
  top: number,
  plotW: number,
  plotH: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number
): string {
  const parts: string[] = []
  doc.series.forEach((series, seriesIndex) => {
    const color = seriesColor(seriesIndex)
    series.points.forEach((point, index) => {
      const plot = pointToPlot(point, index)
      const x = scaleX(plot.xNumeric, minX, maxX, left, plotW)
      const y = scaleY(plot.y, minY, maxY, top, plotH)
      parts.push(
        `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.2" fill="${color}" fill-opacity="0.92"/>`
      )
    })
  })
  return parts.join('')
}

function renderLegend(doc: CanvasChartDocument, left: number, top: number, width: number): string {
  if (doc.series.length <= 1) {
    // Still show the single series label when present.
    if (doc.series.length === 1) {
      const color = seriesColor(0)
      const label = escapeXml(doc.series[0]!.label)
      return `<g class="canvas-chart-legend"><rect x="${left}" y="${top}" width="8" height="8" rx="1.5" fill="${color}"/><text x="${left + 12}" y="${top + 8}" fill="${TEXT_SECONDARY}" font-size="11" font-family="ui-sans-serif, system-ui, sans-serif">${label}</text></g>`
    }
    return ''
  }
  const parts: string[] = ['<g class="canvas-chart-legend">']
  let x = left
  const y = top
  for (let i = 0; i < doc.series.length; i++) {
    const series = doc.series[i]!
    const color = seriesColor(i)
    const label = escapeXml(series.label)
    const approx = Math.min(120, 14 + series.label.length * 6.2)
    if (x + approx > left + width) break
    parts.push(`<rect x="${x}" y="${y}" width="8" height="8" rx="1.5" fill="${color}"/>`)
    parts.push(
      `<text x="${x + 12}" y="${y + 8}" fill="${TEXT_SECONDARY}" font-size="11" font-family="ui-sans-serif, system-ui, sans-serif">${label}</text>`
    )
    x += approx
  }
  parts.push('</g>')
  return parts.join('')
}

function resolveKind(kind: CanvasChartKind): 'line' | 'bar' | 'area' | 'scatter' {
  // v1: line + bar are first-class; area gets a filled line; scatter gets dots.
  // Unknown future kinds would fall back to bar (not reachable via CanvasChartKind).
  return kind
}

/**
 * Build a standalone SVG document string for `doc`.
 * Safe for renderer `dangerouslySetInnerHTML` and main-process HTML→PNG.
 */
export function chartDocumentToSvg(
  doc: CanvasChartDocument,
  opts?: ChartDocumentToSvgOptions
): string {
  const width = clampSize(opts?.width, CANVAS_CHART_SVG_DEFAULT_WIDTH)
  const height = clampSize(opts?.height, CANVAS_CHART_SVG_DEFAULT_HEIGHT)
  const padL = 44
  const padR = 16
  const padT = 36
  const padB = doc.xLabel ? 36 : 28
  const legendH = 18
  const left = padL
  const top = padT + legendH
  const plotW = Math.max(40, width - padL - padR)
  const plotH = Math.max(40, height - top - padB)
  const domain = collectDomain(doc)
  const kind = resolveKind(doc.kind)

  const title = escapeXml(doc.title)
  const grid = renderGrid(left, top, plotW, plotH, domain.minY, domain.maxY)
  const axis = [
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotH}" stroke="${AXIS_STROKE}" stroke-width="1"/>`,
    `<line x1="${left}" y1="${top + plotH}" x2="${left + plotW}" y2="${top + plotH}" stroke="${AXIS_STROKE}" stroke-width="1"/>`
  ].join('')

  let plot = ''
  if (kind === 'bar') {
    plot = renderBars(doc, left, top, plotW, plotH, domain.minY, domain.maxY, domain.categories)
  } else if (kind === 'scatter') {
    plot = renderScatter(
      doc,
      left,
      top,
      plotW,
      plotH,
      domain.minX,
      domain.maxX,
      domain.minY,
      domain.maxY
    )
  } else {
    // line | area
    plot = renderLineOrArea(
      doc,
      kind,
      left,
      top,
      plotW,
      plotH,
      domain.minX,
      domain.maxX,
      domain.minY,
      domain.maxY
    )
  }

  const legend = renderLegend(doc, left, padT - 2, plotW)
  const xLabel = doc.xLabel
    ? `<text x="${(left + plotW / 2).toFixed(1)}" y="${(height - 8).toFixed(1)}" text-anchor="middle" fill="${TEXT_SECONDARY}" font-size="11" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXml(doc.xLabel)}</text>`
    : ''
  const yLabel = doc.yLabel
    ? `<text x="14" y="${(top + plotH / 2).toFixed(1)}" text-anchor="middle" fill="${TEXT_SECONDARY}" font-size="11" font-family="ui-sans-serif, system-ui, sans-serif" transform="rotate(-90 14 ${(top + plotH / 2).toFixed(1)})">${escapeXml(doc.yLabel)}</text>`
    : ''

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" rx="8" ry="8" fill="${PANEL_BG}" stroke="${PANEL_BORDER}" stroke-width="1"/>`,
    `<text x="${left}" y="22" fill="${TEXT_PRIMARY}" font-size="13" font-weight="650" font-family="ui-sans-serif, system-ui, sans-serif">${title}</text>`,
    legend,
    `<g class="canvas-chart-plot" data-kind="${kind}">`,
    grid,
    axis,
    plot,
    `</g>`,
    xLabel,
    yLabel,
    `</svg>`
  ].join('')
}
