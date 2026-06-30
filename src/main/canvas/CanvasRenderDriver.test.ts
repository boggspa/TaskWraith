import { describe, it, expect, vi } from 'vitest'
import { CanvasRenderDriver } from './CanvasRenderDriver'
import { MAX_CANVAS_HTML_CHARS } from './canvasTypes'

/** A 1x1 PNG so readPngDimensions returns honest dims (it reads the IHDR). */
function pngOf(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(8) // IHDR length(4) + "IHDR"(4) — content unread by readPngDimensions
  ihdr.write('IHDR', 4)
  const dims = Buffer.alloc(8)
  dims.writeUInt32BE(width, 0)
  dims.writeUInt32BE(height, 4)
  return Buffer.concat([sig, ihdr, dims])
}

describe('CanvasRenderDriver', () => {
  it('renders once on open and serves the cached frame on screenshot', async () => {
    const render = vi.fn(async (_html: string, w: number, h: number) => pngOf(w, h))
    const driver = new CanvasRenderDriver('s1', { render, now: () => 'T' })

    const handle = await driver.open({ driver: 'html', html: '<h1>hi</h1>', viewport: { width: 640, height: 480 } })
    expect(handle.url).toMatch(/^html:\/\/[0-9a-f]{8}$/)
    expect(handle.viewport).toEqual({ width: 640, height: 480 })
    expect(render).toHaveBeenCalledTimes(1)

    const frame = await driver.screenshot()
    expect(frame.mimeType).toBe('image/png')
    expect(frame.width).toBe(640)
    expect(frame.height).toBe(480)
    expect(frame.data).toBe(pngOf(640, 480).toString('base64'))
    // Static markup → no re-rasterize on a plain re-screenshot.
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('re-renders at the new size after resize', async () => {
    const render = vi.fn(async (_html: string, w: number, h: number) => pngOf(w, h))
    const driver = new CanvasRenderDriver('s1', { render })
    await driver.open({ driver: 'html', html: '<p>x</p>', viewport: { width: 400, height: 300 } })
    expect(render).toHaveBeenCalledTimes(1)

    const applied = await driver.resize({ width: 800, height: 600 })
    expect(applied).toEqual({ width: 800, height: 600 })
    expect(render).toHaveBeenCalledTimes(1) // resize is lazy — no render yet

    const frame = await driver.screenshot()
    expect(frame.width).toBe(800)
    expect(render).toHaveBeenCalledTimes(2)
    expect(render).toHaveBeenLastCalledWith('<p>x</p>', 800, 600)
  })

  it('rejects empty and oversized html at open (defence-in-depth)', async () => {
    const render = vi.fn(async () => pngOf(1, 1))
    const driver = new CanvasRenderDriver('s1', { render })
    await expect(driver.open({ driver: 'html', html: '   ' })).rejects.toThrow()
    await expect(
      driver.open({ driver: 'html', html: 'x'.repeat(MAX_CANVAS_HTML_CHARS + 1) })
    ).rejects.toThrow()
    expect(render).not.toHaveBeenCalled()
  })

  it('throws a clear error for the DOM/interactive verbs', async () => {
    const driver = new CanvasRenderDriver('s1', { render: async () => pngOf(1, 1) })
    await driver.open({ driver: 'html', html: '<b>y</b>' })
    await expect(driver.snapshot()).rejects.toThrow(/not available for the html driver/)
    await expect(driver.evaluate({ script: '1' })).rejects.toThrow(/not available for the html driver/)
    await expect(driver.act({ kind: 'click', ref: 'e1' })).rejects.toThrow()
    await expect(driver.network()).rejects.toThrow()
    await expect(driver.console()).rejects.toThrow()
    await expect(driver.inspect()).rejects.toThrow()
    await expect(driver.annotate([])).rejects.toThrow()
    await expect(driver.reload()).rejects.toThrow()
  })
})
