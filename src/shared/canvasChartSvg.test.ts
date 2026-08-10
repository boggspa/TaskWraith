import { describe, expect, it } from 'vitest'
import { CANVAS_CHART_SCHEMA_VERSION, type CanvasChartDocument } from './canvasChart'
import { CANVAS_CHART_SERIES_COLORS, chartDocumentToSvg } from './canvasChartSvg'

function doc(overrides: Partial<CanvasChartDocument> = {}): CanvasChartDocument {
  return {
    schemaVersion: CANVAS_CHART_SCHEMA_VERSION,
    title: 'Latency p95',
    kind: 'line',
    series: [
      {
        id: 'p95',
        label: 'p95 ms',
        points: [
          { x: 0, y: 10 },
          { x: 1, y: 40 },
          { x: 2, y: 25 }
        ]
      }
    ],
    xLabel: 'minute',
    yLabel: 'ms',
    ...overrides
  }
}

describe('chartDocumentToSvg', () => {
  it('returns a self-contained SVG string with the requested viewport', () => {
    const svg = chartDocumentToSvg(doc(), { width: 480, height: 240 })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('width="480"')
    expect(svg).toContain('height="240"')
    expect(svg).toContain('viewBox="0 0 480 240"')
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
  })

  it('escapes the title and renders it as visible text', () => {
    const svg = chartDocumentToSvg(doc({ title: 'A <B> & "C"' }))
    expect(svg).toContain('A &lt;B&gt; &amp; &quot;C&quot;')
    expect(svg).not.toContain('A <B> & "C"')
  })

  it('draws line charts as stroked paths using the provider series palette', () => {
    const svg = chartDocumentToSvg(doc({ kind: 'line' }))
    expect(svg).toMatch(/<path\b[^>]*\bd="/)
    expect(svg).toContain(`stroke="${CANVAS_CHART_SERIES_COLORS[0]}"`)
    expect(svg).not.toMatch(/<rect\b[^>]*class="[^"]*bar/)
  })

  it('draws bar charts as filled rects coloured by series', () => {
    const svg = chartDocumentToSvg(
      doc({
        kind: 'bar',
        series: [
          {
            id: 'cpu',
            label: 'CPU',
            points: [
              { x: 'a', y: 10 },
              { x: 'b', y: 30 },
              { x: 'c', y: 20 }
            ]
          }
        ]
      })
    )
    const rects = svg.match(/<rect\b[^>]*>/g) ?? []
    // Plot bars (axis chrome may add other rects — require several fills).
    expect(rects.length).toBeGreaterThanOrEqual(3)
    expect(svg).toContain(`fill="${CANVAS_CHART_SERIES_COLORS[0]}"`)
  })

  it('assigns distinct palette colours across multiple series', () => {
    const svg = chartDocumentToSvg(
      doc({
        kind: 'line',
        series: [
          {
            id: 'a',
            label: 'A',
            points: [
              { x: 0, y: 1 },
              { x: 1, y: 2 }
            ]
          },
          {
            id: 'b',
            label: 'B',
            points: [
              { x: 0, y: 3 },
              { x: 1, y: 1 }
            ]
          }
        ]
      })
    )
    expect(svg).toContain(`stroke="${CANVAS_CHART_SERIES_COLORS[0]}"`)
    expect(svg).toContain(`stroke="${CANVAS_CHART_SERIES_COLORS[1]}"`)
    expect(svg).toContain('A')
    expect(svg).toContain('B')
  })

  it('includes axis labels when provided', () => {
    const svg = chartDocumentToSvg(doc({ xLabel: 't', yLabel: 'latency' }))
    expect(svg).toContain('>t<')
    expect(svg).toContain('>latency<')
  })

  it('renders area and scatter without throwing (v1 may share line/bar geometry)', () => {
    const area = chartDocumentToSvg(doc({ kind: 'area' }))
    const scatter = chartDocumentToSvg(doc({ kind: 'scatter' }))
    expect(area.startsWith('<svg')).toBe(true)
    expect(scatter.startsWith('<svg')).toBe(true)
    // Area should paint a filled region; scatter should paint markers.
    expect(area).toMatch(/<path\b/)
    expect(scatter).toMatch(/<(circle|path)\b/)
  })

  it('defaults width/height when opts are omitted', () => {
    const svg = chartDocumentToSvg(doc())
    expect(svg).toMatch(/width="\d+"/)
    expect(svg).toMatch(/height="\d+"/)
  })
})
