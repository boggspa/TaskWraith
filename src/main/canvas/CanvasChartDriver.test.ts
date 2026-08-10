import { describe, it, expect, vi } from 'vitest'
import { CanvasChartDriver } from './CanvasChartDriver'
import type { CanvasChartDocument } from './canvasTypes'
import { MAX_CANVAS_CHART_SERIES } from './canvasTypes'

/** A PNG whose IHDR carries the given dimensions (readPngDimensions reads it). */
function pngOf(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(8)
  ihdr.write('IHDR', 4)
  const dims = Buffer.alloc(8)
  dims.writeUInt32BE(width, 0)
  dims.writeUInt32BE(height, 4)
  return Buffer.concat([sig, ihdr, dims])
}

const SAMPLE: CanvasChartDocument = {
  schemaVersion: 1,
  title: 'p50 latency',
  kind: 'line',
  series: [
    {
      id: 'p50',
      label: 'p50',
      points: [
        { x: 0, y: 10 },
        { x: 1, y: 14 },
        { x: 2, y: 11 }
      ]
    }
  ],
  yLabel: 'ms'
}

describe('CanvasChartDriver', () => {
  it('renders shared SVG once on open and serves the cached frame on screenshot', async () => {
    const render = vi.fn(async (_html: string, w: number, h: number) => pngOf(w, h))
    const driver = new CanvasChartDriver('s1', { render, now: () => 'T' })

    const handle = await driver.open({
      driver: 'chart',
      chartDocument: SAMPLE,
      viewport: { width: 640, height: 480 }
    })
    expect(handle.url).toMatch(/^chart:\/\/[0-9a-f]{8}$/)
    expect(handle.title).toBe('p50 latency')
    expect(handle.viewport).toEqual({ width: 640, height: 480 })
    expect(render).toHaveBeenCalledTimes(1)
    const svg = String(render.mock.calls[0]?.[0])
    expect(svg).toContain('<svg')
    expect(svg).toContain('p50 latency')
    expect(svg).not.toContain('<script')

    const frame = await driver.screenshot()
    expect(frame.mimeType).toBe('image/png')
    expect(frame.width).toBe(640)
    expect(frame.height).toBe(480)
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('re-renders at the new size after resize', async () => {
    const render = vi.fn(async (_html: string, w: number, h: number) => pngOf(w, h))
    const driver = new CanvasChartDriver('s1', { render })
    await driver.open({
      driver: 'chart',
      chartDocument: SAMPLE,
      viewport: { width: 400, height: 300 }
    })
    expect(render).toHaveBeenCalledTimes(1)

    const applied = await driver.resize({ width: 800, height: 600 })
    expect(applied).toEqual({ width: 800, height: 600 })
    expect(render).toHaveBeenCalledTimes(1)

    const frame = await driver.screenshot()
    expect(frame.width).toBe(800)
    expect(render).toHaveBeenCalledTimes(2)
  })

  it('rejects missing/invalid chart documents before rasterize', async () => {
    const render = vi.fn(async () => pngOf(1, 1))
    const driver = new CanvasChartDriver('s1', { render })
    await expect(driver.open({ driver: 'chart' })).rejects.toThrow(/chartDocument/i)
    await expect(
      driver.open({
        driver: 'chart',
        chartDocument: {
          schemaVersion: 1,
          title: 'x',
          kind: 'line',
          series: Array.from({ length: MAX_CANVAS_CHART_SERIES + 1 }, (_, i) => ({
            id: `s${i}`,
            label: `S${i}`,
            points: [{ x: 0, y: 1 }]
          }))
        }
      })
    ).rejects.toThrow(/Too many series/)
    expect(render).not.toHaveBeenCalled()
  })

  it('throws a clear error for the DOM/interactive verbs', async () => {
    const driver = new CanvasChartDriver('s1', { render: async () => pngOf(1, 1) })
    await driver.open({ driver: 'chart', chartDocument: SAMPLE })
    await expect(driver.snapshot()).rejects.toThrow(/not available for the chart driver/)
    await expect(driver.evaluate({ script: '1' })).rejects.toThrow(
      /not available for the chart driver/
    )
    await expect(driver.act({ kind: 'click', ref: 'e1' })).rejects.toThrow()
    await expect(driver.reload()).rejects.toThrow()
  })
})
