import { describe, it, expect, vi } from 'vitest'
import { CanvasImageDriver } from './CanvasImageDriver'

/** A minimal PNG whose IHDR carries the given dimensions (readPngDimensions reads it). */
function pngOf(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(8)
  ihdr.write('IHDR', 4)
  const dims = Buffer.alloc(8)
  dims.writeUInt32BE(width, 0)
  dims.writeUInt32BE(height, 4)
  return Buffer.concat([sig, ihdr, dims])
}

const SHA = 'a'.repeat(43) // a base64url-shaped sha256
const ctx = { driver: 'image' as const }

describe('CanvasImageDriver', () => {
  it('loads the jailed asset once on open and serves the cached frame', async () => {
    const load = vi.fn(async () => pngOf(300, 200))
    const driver = new CanvasImageDriver('s1', { load, now: () => 'T' })

    const handle = await driver.open({ ...ctx, mediaSha256: SHA, mediaMimeType: 'image/png' })
    expect(load).toHaveBeenCalledWith(SHA, 'image/png')
    expect(handle.url).toBe(`image://${SHA}`)
    expect(handle.viewport).toEqual({ width: 300, height: 200 })

    const frame = await driver.screenshot()
    expect(frame.mimeType).toBe('image/png')
    expect(frame.width).toBe(300)
    expect(frame.height).toBe(200)
    expect(frame.data).toBe(pngOf(300, 200).toString('base64'))
    // The bytes are resolved once; re-screenshot does not re-read the asset.
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('rejects a bad hash or non-image mime before touching the asset store', async () => {
    const load = vi.fn(async () => pngOf(1, 1))
    const driver = new CanvasImageDriver('s1', { load })
    await expect(driver.open({ ...ctx, mediaSha256: '../etc', mediaMimeType: 'image/png' })).rejects.toThrow()
    await expect(driver.open({ ...ctx, mediaSha256: SHA, mediaMimeType: 'video/mp4' })).rejects.toThrow()
    expect(load).not.toHaveBeenCalled()
  })

  it('surfaces a loader failure (missing / undecodable asset)', async () => {
    const load = vi.fn(async () => {
      throw new Error('Image attachment unavailable (missing).')
    })
    const driver = new CanvasImageDriver('s1', { load })
    await expect(driver.open({ ...ctx, mediaSha256: SHA, mediaMimeType: 'image/png' })).rejects.toThrow(/unavailable/)
  })

  it('throws a clear error for resize and the DOM/interactive verbs', async () => {
    const driver = new CanvasImageDriver('s1', { load: async () => pngOf(1, 1) })
    await driver.open({ ...ctx, mediaSha256: SHA, mediaMimeType: 'image/png' })
    await expect(driver.resize({ width: 100, height: 100 })).rejects.toThrow(/not available for the image driver/)
    await expect(driver.snapshot()).rejects.toThrow()
    await expect(driver.evaluate({ script: '1' })).rejects.toThrow()
    await expect(driver.act({ kind: 'click', ref: 'e1' })).rejects.toThrow()
  })
})
