import { describe, expect, it } from 'vitest'
import {
  RENDERER_DIAGNOSTIC_SAMPLE_INTERVAL_MS,
  sanitizeBlinkCacheUsage,
  sanitizeRendererDiagnosticClientSample,
  sanitizeRendererErrorBoundaryReport
} from './rendererDiagnostics'

describe('renderer diagnostics wire shape', () => {
  it('keeps only bounded numeric telemetry and a bounded active chat id', () => {
    const sample = sanitizeRendererDiagnosticClientSample({
      activeChatId: `  ${'chat'.repeat(80)}  `,
      activeChatMessageCount: 42.9,
      v8HeapUsedBytes: 1234.8,
      v8HeapTotalBytes: -1,
      v8HeapLimitBytes: Number.POSITIVE_INFINITY,
      domNodeCount: 98765.4,
      chatUpdates: {
        received: 8,
        snapshots: 2,
        patches: 6,
        applyFailures: -4,
        acksSent: Number.NaN
      }
    })

    expect(sample.activeChatId).toHaveLength(200)
    expect(sample.activeChatMessageCount).toBe(42)
    expect(sample.v8HeapUsedBytes).toBe(1234)
    expect(sample.v8HeapTotalBytes).toBeUndefined()
    expect(sample.v8HeapLimitBytes).toBeUndefined()
    expect(sample.domNodeCount).toBe(98765)
    expect(
      sanitizeRendererDiagnosticClientSample({ domNodeCount: -3 }).domNodeCount
    ).toBeUndefined()
    expect(
      sanitizeRendererDiagnosticClientSample({ domNodeCount: Number.NaN }).domNodeCount
    ).toBeUndefined()
    expect(sample.chatUpdates).toEqual({
      received: 8,
      snapshots: 2,
      patches: 6,
      applyFailures: 0,
      acksSent: 0
    })
  })

  it('reduces malformed payloads to a safe empty sample', () => {
    expect(sanitizeRendererDiagnosticClientSample(['not', 'an', 'object'])).toEqual({
      activeChatMessageCount: 0,
      chatUpdates: {
        received: 0,
        snapshots: 0,
        patches: 0,
        applyFailures: 0,
        acksSent: 0
      }
    })
    expect(RENDERER_DIAGNOSTIC_SAMPLE_INTERVAL_MS).toBe(15_000)
  })

  it('bounds renderer error-boundary text before persistence', () => {
    const report = sanitizeRendererErrorBoundaryReport({
      name: ` ${'N'.repeat(300)} `,
      message: 'M'.repeat(4_000),
      stack: 'S'.repeat(8_000),
      componentStack: 'C'.repeat(8_000)
    })

    expect(report.name).toHaveLength(160)
    expect(report.message).toHaveLength(2_048)
    expect(report.stack).toHaveLength(4_096)
    expect(report.componentStack).toHaveLength(4_096)
    expect(sanitizeRendererErrorBoundaryReport(null).message).toContain('unknown error')
  })
})

describe('blink cache usage sanitizer', () => {
  it('keeps a valid reading with bounded fields', () => {
    expect(
      sanitizeBlinkCacheUsage({
        images: { count: 42.9, sizeBytes: 1024.8, decodedSizeBytes: 512 },
        scripts: { count: 0, sizeBytes: 0, decodedSizeBytes: 0 }
      })
    ).toEqual({
      images: { count: 42, sizeBytes: 1024, decodedSizeBytes: 512 },
      scripts: { count: 0, sizeBytes: 0, decodedSizeBytes: 0 }
    })
    // Decoded bytes are not a live subset of cached bytes: no ordering enforced.
    expect(
      sanitizeBlinkCacheUsage({ images: { count: 1, sizeBytes: 100, decodedSizeBytes: 5000 } })
    ).toEqual({ images: { count: 1, sizeBytes: 100, decodedSizeBytes: 5000 } })
    expect(
      sanitizeBlinkCacheUsage({ images: { count: 1e30, sizeBytes: 1e30, decodedSizeBytes: 1e30 } })
    ).toEqual({
      images: {
        count: 1_000_000_000,
        sizeBytes: 16 * 1024 * 1024 * 1024 * 1024,
        decodedSizeBytes: 16 * 1024 * 1024 * 1024 * 1024
      }
    })
  })

  it('drops malformed categories and fields but keeps valid siblings', () => {
    expect(
      sanitizeBlinkCacheUsage({
        images: { count: 2, sizeBytes: 2048, decodedSizeBytes: 1024 },
        scripts: 'junk',
        cssStyleSheets: { count: -1, sizeBytes: Number.NaN },
        fonts: { count: 1, sizeBytes: -5, decodedSizeBytes: 64 },
        decodedAudio: { count: 9, sizeBytes: 9, decodedSizeBytes: 9 }
      })
    ).toEqual({
      images: { count: 2, sizeBytes: 2048, decodedSizeBytes: 1024 },
      fonts: { count: 1, decodedSizeBytes: 64 }
    })
  })

  it('treats absent or fully invalid readings as unavailable, never zero', () => {
    for (const reading of [undefined, null, 'junk', 42, [], {}, { images: 'junk' }]) {
      expect(sanitizeBlinkCacheUsage(reading)).toBeUndefined()
    }
    const backcompat = sanitizeRendererDiagnosticClientSample({
      activeChatMessageCount: 3,
      chatUpdates: { received: 1, snapshots: 0, patches: 1, applyFailures: 0, acksSent: 1 }
    })
    expect('blinkCacheUsage' in backcompat).toBe(false)
  })

  it('carries a sanitized reading through the client sample', () => {
    const sample = sanitizeRendererDiagnosticClientSample({
      activeChatMessageCount: 3,
      blinkCacheUsage: {
        images: { count: 2, sizeBytes: 2048, decodedSizeBytes: 1024 },
        scripts: { count: -4, sizeBytes: 128, decodedSizeBytes: 64 }
      },
      chatUpdates: { received: 1, snapshots: 0, patches: 1, applyFailures: 0, acksSent: 1 }
    })
    expect(sample.blinkCacheUsage).toEqual({
      images: { count: 2, sizeBytes: 2048, decodedSizeBytes: 1024 },
      scripts: { sizeBytes: 128, decodedSizeBytes: 64 }
    })
  })
})
