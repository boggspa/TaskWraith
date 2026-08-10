import { describe, expect, it } from 'vitest'
import {
  CANVAS_CHART_KINDS,
  CANVAS_CHART_MAX_JSON_BYTES,
  CANVAS_CHART_MAX_POINTS_PER_SERIES,
  CANVAS_CHART_MAX_SERIES,
  CANVAS_CHART_MAX_TITLE_CHARS,
  CANVAS_CHART_SCHEMA_VERSION,
  parseCanvasChartFence,
  validateCanvasChart,
  type CanvasChartDocument
} from './canvasChart'

function validChart(overrides: Partial<CanvasChartDocument> = {}): CanvasChartDocument {
  return {
    schemaVersion: CANVAS_CHART_SCHEMA_VERSION,
    title: 'Latency p95',
    kind: 'line',
    series: [
      {
        id: 'p95',
        label: 'p95 ms',
        points: [
          { x: '10:00', y: 42 },
          { x: '10:01', y: 47 }
        ]
      }
    ],
    xLabel: 'time',
    yLabel: 'ms',
    ...overrides
  }
}

describe('canvasChart caps + kinds', () => {
  it('exports the dual-surface schema constants', () => {
    expect(CANVAS_CHART_SCHEMA_VERSION).toBe(1)
    expect(CANVAS_CHART_KINDS).toEqual(['line', 'bar', 'area', 'scatter'])
    expect(CANVAS_CHART_MAX_SERIES).toBe(8)
    expect(CANVAS_CHART_MAX_POINTS_PER_SERIES).toBe(2000)
    expect(CANVAS_CHART_MAX_TITLE_CHARS).toBe(120)
    expect(CANVAS_CHART_MAX_JSON_BYTES).toBe(256 * 1024)
  })
})

describe('validateCanvasChart', () => {
  it('accepts a well-formed chart document and returns a normalized copy', () => {
    const raw = validChart()
    const result = validateCanvasChart(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document).toEqual(raw)
    // Caller mutation must not alias into the validated document.
    raw.series[0]!.points[0]!.y = 999
    expect(result.document.series[0]!.points[0]!.y).toBe(42)
  })

  it('accepts every declared chart kind and numeric x values', () => {
    for (const kind of CANVAS_CHART_KINDS) {
      const result = validateCanvasChart(
        validChart({
          kind,
          series: [
            {
              id: 's',
              label: 'S',
              points: [
                { x: 1, y: 2.5 },
                { x: 2, y: -1 }
              ]
            }
          ]
        })
      )
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.document.kind).toBe(kind)
    }
  })

  it('accepts omitted optional axis labels', () => {
    const result = validateCanvasChart({
      schemaVersion: 1,
      title: 'CPU',
      kind: 'bar',
      series: [{ id: 'cpu', label: 'CPU %', points: [{ x: 'a', y: 10 }] }]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.xLabel).toBeUndefined()
    expect(result.document.yLabel).toBeUndefined()
  })

  it('rejects non-objects and wrong schema versions without throwing', () => {
    expect(validateCanvasChart(null)).toEqual({ ok: false, reason: expect.any(String) })
    expect(validateCanvasChart(undefined).ok).toBe(false)
    expect(validateCanvasChart('{"schemaVersion":1}').ok).toBe(false)
    expect(validateCanvasChart(validChart({ schemaVersion: 2 as 1 })).ok).toBe(false)
    expect(validateCanvasChart({ ...validChart(), schemaVersion: 0 }).ok).toBe(false)
  })

  it('rejects unsupported kinds and empty / overlong titles', () => {
    expect(validateCanvasChart(validChart({ kind: 'pie' as 'line' })).ok).toBe(false)
    expect(validateCanvasChart(validChart({ title: '' })).ok).toBe(false)
    expect(validateCanvasChart(validChart({ title: '   ' })).ok).toBe(false)
    expect(
      validateCanvasChart(validChart({ title: 'x'.repeat(CANVAS_CHART_MAX_TITLE_CHARS + 1) })).ok
    ).toBe(false)
    expect(
      validateCanvasChart(validChart({ title: 'x'.repeat(CANVAS_CHART_MAX_TITLE_CHARS) })).ok
    ).toBe(true)
  })

  it('rejects empty series, too many series, and duplicate series ids', () => {
    expect(validateCanvasChart(validChart({ series: [] })).ok).toBe(false)
    const many = Array.from({ length: CANVAS_CHART_MAX_SERIES + 1 }, (_, i) => ({
      id: `s${i}`,
      label: `Series ${i}`,
      points: [{ x: 0, y: i }]
    }))
    expect(validateCanvasChart(validChart({ series: many })).ok).toBe(false)
    expect(
      validateCanvasChart(
        validChart({
          series: [
            { id: 'dup', label: 'A', points: [{ x: 0, y: 1 }] },
            { id: 'dup', label: 'B', points: [{ x: 0, y: 2 }] }
          ]
        })
      ).ok
    ).toBe(false)
  })

  it('rejects malformed series ids/labels and point shapes', () => {
    expect(
      validateCanvasChart(
        validChart({
          series: [{ id: '', label: 'A', points: [{ x: 0, y: 1 }] }]
        })
      ).ok
    ).toBe(false)
    expect(
      validateCanvasChart(
        validChart({
          series: [{ id: 'a', label: '  ', points: [{ x: 0, y: 1 }] }]
        })
      ).ok
    ).toBe(false)
    expect(
      validateCanvasChart(
        validChart({
          series: [{ id: 'a', label: 'A', points: [] }]
        })
      ).ok
    ).toBe(false)
    expect(
      validateCanvasChart(
        validChart({
          series: [{ id: 'a', label: 'A', points: [{ x: true as unknown as number, y: 1 }] }]
        })
      ).ok
    ).toBe(false)
    expect(
      validateCanvasChart(
        validChart({
          series: [{ id: 'a', label: 'A', points: [{ x: 0, y: Number.NaN }] }]
        })
      ).ok
    ).toBe(false)
    expect(
      validateCanvasChart(
        validChart({
          series: [{ id: 'a', label: 'A', points: [{ x: 0, y: Number.POSITIVE_INFINITY }] }]
        })
      ).ok
    ).toBe(false)
  })

  it('rejects more than the per-series point cap', () => {
    const points = Array.from({ length: CANVAS_CHART_MAX_POINTS_PER_SERIES + 1 }, (_, i) => ({
      x: i,
      y: i
    }))
    expect(
      validateCanvasChart(
        validChart({
          series: [{ id: 'big', label: 'Big', points }]
        })
      ).ok
    ).toBe(false)
    const atCap = points.slice(0, CANVAS_CHART_MAX_POINTS_PER_SERIES)
    expect(
      validateCanvasChart(
        validChart({
          series: [{ id: 'big', label: 'Big', points: atCap }]
        })
      ).ok
    ).toBe(true)
  })

  it('rejects payloads whose JSON encoding exceeds the byte cap', () => {
    // Keep series/point counts legal; inflate string x values until stringify > 256KiB.
    const points = Array.from({ length: 500 }, (_, i) => ({
      x: `${i}:${'pad'.repeat(200)}`,
      y: i
    }))
    const series = Array.from({ length: CANVAS_CHART_MAX_SERIES }, (_, i) => ({
      id: `s${i}`,
      label: `Series ${i}`,
      points
    }))
    const huge = validChart({ title: 'Huge', series })
    expect(Buffer.byteLength(JSON.stringify(huge), 'utf8')).toBeGreaterThan(
      CANVAS_CHART_MAX_JSON_BYTES
    )
    const result = validateCanvasChart(huge)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.toLowerCase()).toMatch(/256|json|byte|size|large/)
  })

  it('rejects non-string optional axis labels', () => {
    expect(validateCanvasChart({ ...validChart(), xLabel: 1 }).ok).toBe(false)
    expect(validateCanvasChart({ ...validChart(), yLabel: null }).ok).toBe(false)
  })

  it('strips unknown top-level keys from the accepted document', () => {
    const result = validateCanvasChart({ ...validChart(), unexpected: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect('unexpected' in result.document).toBe(false)
  })
})

describe('parseCanvasChartFence', () => {
  it('parses the JSON body of a ```chart fence', () => {
    const body = JSON.stringify(validChart({ title: 'From fence', kind: 'area' }))
    const result = parseCanvasChartFence(body)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.title).toBe('From fence')
    expect(result.document.kind).toBe('area')
  })

  it('trims surrounding whitespace before parsing', () => {
    const body = `\n  ${JSON.stringify(validChart())}  \n`
    expect(parseCanvasChartFence(body).ok).toBe(true)
  })

  it('rejects invalid JSON and non-object JSON roots', () => {
    expect(parseCanvasChartFence('').ok).toBe(false)
    expect(parseCanvasChartFence('{').ok).toBe(false)
    expect(parseCanvasChartFence('[]').ok).toBe(false)
    expect(parseCanvasChartFence('"string"').ok).toBe(false)
    expect(parseCanvasChartFence('null').ok).toBe(false)
  })

  it('rejects fence bodies that exceed the JSON byte cap before parsing', () => {
    const oversized = `{"schemaVersion":1,"title":"t","kind":"line","series":[],"pad":"${'x'.repeat(CANVAS_CHART_MAX_JSON_BYTES)}}`
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(CANVAS_CHART_MAX_JSON_BYTES)
    const result = parseCanvasChartFence(oversized)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.toLowerCase()).toMatch(/256|json|byte|size|large/)
  })

  it('applies the same document validation after a successful JSON parse', () => {
    const result = parseCanvasChartFence(
      JSON.stringify({ schemaVersion: 1, title: 'x', kind: 'line', series: [] })
    )
    expect(result.ok).toBe(false)
  })
})
