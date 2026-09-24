import { describe, expect, it } from 'vitest'
import type { RendererDiagnosticClientSample } from '../shared/rendererDiagnostics'
import { captureBlinkCacheUsage, withBlinkCacheUsage } from './rendererDiagnosticResourceUsage'

/** Electron `webFrame.getResourceUsage()` shape: `{ count, size, liveSize }`. */
function electronReading(): Record<string, { count: number; size: number; liveSize: number }> {
  return {
    images: { count: 42, size: 12_582_912, liveSize: 8_388_608 },
    scripts: { count: 17, size: 4_194_304, liveSize: 4_194_304 },
    cssStyleSheets: { count: 9, size: 262_144, liveSize: 131_072 },
    xslStyleSheets: { count: 0, size: 0, liveSize: 0 },
    fonts: { count: 5, size: 1_048_576, liveSize: 524_288 },
    other: { count: 3, size: 65_536, liveSize: 65_536 }
  }
}

function clientSample(): RendererDiagnosticClientSample {
  return {
    activeChatId: 'chat-1',
    activeChatMessageCount: 11,
    v8HeapUsedBytes: 101,
    chatUpdates: { received: 1, snapshots: 0, patches: 1, applyFailures: 0, acksSent: 1 }
  }
}

describe('captureBlinkCacheUsage', () => {
  it('maps all six Electron cache categories onto the wire shape', () => {
    expect(captureBlinkCacheUsage(() => electronReading())).toEqual({
      images: { count: 42, sizeBytes: 12_582_912, decodedSizeBytes: 8_388_608 },
      scripts: { count: 17, sizeBytes: 4_194_304, decodedSizeBytes: 4_194_304 },
      cssStyleSheets: { count: 9, sizeBytes: 262_144, decodedSizeBytes: 131_072 },
      xslStyleSheets: { count: 0, sizeBytes: 0, decodedSizeBytes: 0 },
      fonts: { count: 5, sizeBytes: 1_048_576, decodedSizeBytes: 524_288 },
      other: { count: 3, sizeBytes: 65_536, decodedSizeBytes: 65_536 }
    })
  })

  it('returns undefined when the reader throws or is unavailable', () => {
    expect(
      captureBlinkCacheUsage(() => {
        throw new Error('webFrame gone')
      })
    ).toBeUndefined()
    for (const reading of [undefined, null, 'nope', 42, ['images']]) {
      expect(captureBlinkCacheUsage(() => reading)).toBeUndefined()
    }
    expect(captureBlinkCacheUsage(() => ({}))).toBeUndefined()
  })

  it('uses the real webFrame reader by default and degrades to undefined without it', () => {
    // Under node there is no Electron webFrame; the default reader must not throw.
    expect(captureBlinkCacheUsage()).toBeUndefined()
  })

  it('keeps valid categories and fields while dropping malformed siblings', () => {
    expect(
      captureBlinkCacheUsage(() => ({
        images: { count: 2, size: 2048, liveSize: 1024 },
        scripts: 'junk',
        cssStyleSheets: { count: -1, size: Number.NaN, liveSize: Number.POSITIVE_INFINITY },
        fonts: { count: 1.9, size: -5, liveSize: 64.8 },
        mysteryCategory: { count: 9, size: 9, liveSize: 9 }
      }))
    ).toEqual({
      images: { count: 2, sizeBytes: 2048, decodedSizeBytes: 1024 },
      fonts: { count: 1, decodedSizeBytes: 64 }
    })
  })

  it('bounds runaway values instead of persisting them', () => {
    expect(
      captureBlinkCacheUsage(() => ({ images: { count: 1e30, size: 1e30, liveSize: 1e30 } }))
    ).toEqual({
      images: {
        count: 1_000_000_000,
        sizeBytes: 16 * 1024 * 1024 * 1024 * 1024,
        decodedSizeBytes: 16 * 1024 * 1024 * 1024 * 1024
      }
    })
  })
})

describe('withBlinkCacheUsage', () => {
  it('attaches a fresh reading without mutating the input sample', () => {
    const input = clientSample()
    const enriched = withBlinkCacheUsage(input, () => electronReading())

    expect(enriched).not.toBe(input)
    expect(input.blinkCacheUsage).toBeUndefined()
    expect(enriched.activeChatId).toBe('chat-1')
    expect(enriched.v8HeapUsedBytes).toBe(101)
    expect(enriched.chatUpdates).toEqual(input.chatUpdates)
    expect(enriched.blinkCacheUsage?.images).toEqual({
      count: 42,
      sizeBytes: 12_582_912,
      decodedSizeBytes: 8_388_608
    })
    expect(Object.keys(enriched.blinkCacheUsage ?? {})).toEqual([
      'images',
      'scripts',
      'cssStyleSheets',
      'xslStyleSheets',
      'fonts',
      'other'
    ])
  })

  it('passes the sample through untouched when no reading is available', () => {
    const input = clientSample()
    expect(
      withBlinkCacheUsage(input, () => {
        throw new Error('gone')
      })
    ).toBe(input)
    expect(withBlinkCacheUsage(input, () => undefined)).toBe(input)
  })
})
