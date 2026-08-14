import { describe, expect, it } from 'vitest'
import {
  RENDERER_DIAGNOSTIC_SAMPLE_INTERVAL_MS,
  sanitizeRendererDiagnosticClientSample
} from './rendererDiagnostics'

describe('renderer diagnostics wire shape', () => {
  it('keeps only bounded numeric telemetry and a bounded active chat id', () => {
    const sample = sanitizeRendererDiagnosticClientSample({
      activeChatId: `  ${'chat'.repeat(80)}  `,
      activeChatMessageCount: 42.9,
      v8HeapUsedBytes: 1234.8,
      v8HeapTotalBytes: -1,
      v8HeapLimitBytes: Number.POSITIVE_INFINITY,
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
})
