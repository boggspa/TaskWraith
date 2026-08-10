import { describe, expect, it } from 'vitest'
import { CANVAS_CHART_SCHEMA_VERSION } from '../../../shared/canvasChart'
import { CANVAS_CHART_SERIES_COLORS, chartDocumentToSvg } from './canvasChartSvg'

describe('renderer canvasChartSvg re-export', () => {
  it('exposes the shared builder and palette for transcript/dock consumers', () => {
    expect(CANVAS_CHART_SERIES_COLORS[0]).toBe('#705AFF')
    const svg = chartDocumentToSvg({
      schemaVersion: CANVAS_CHART_SCHEMA_VERSION,
      title: 'Dock chart',
      kind: 'bar',
      series: [{ id: 's', label: 'S', points: [{ x: 'a', y: 4 }] }]
    })
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('Dock chart')
  })
})
