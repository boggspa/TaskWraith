import { describe, expect, it } from 'vitest'
import { buildRendererDiagnosticClientSample } from './rendererDiagnosticSample'

describe('buildRendererDiagnosticClientSample', () => {
  it('captures V8 heap, current chat cardinality, and a counter snapshot', () => {
    const counters = {
      received: 9,
      snapshots: 2,
      patches: 7,
      applyFailures: 1,
      acksSent: 8
    }
    const sample = buildRendererDiagnosticClientSample({
      performance: {
        memory: {
          usedJSHeapSize: 101.9,
          totalJSHeapSize: 202.1,
          jsHeapSizeLimit: 303
        }
      },
      activeChatId: 'chat-1',
      activeChatMessageCount: 11_574,
      chatUpdates: counters
    })

    expect(sample).toEqual({
      activeChatId: 'chat-1',
      activeChatMessageCount: 11_574,
      v8HeapUsedBytes: 101,
      v8HeapTotalBytes: 202,
      v8HeapLimitBytes: 303,
      chatUpdates: counters
    })
    expect(sample.chatUpdates).not.toBe(counters)
  })

  it('works where performance.memory is unavailable', () => {
    expect(
      buildRendererDiagnosticClientSample({
        performance: {},
        activeChatId: null,
        chatUpdates: {
          received: 0,
          snapshots: 0,
          patches: 0,
          applyFailures: 0,
          acksSent: 0
        }
      })
    ).toEqual({
      activeChatMessageCount: 0,
      chatUpdates: {
        received: 0,
        snapshots: 0,
        patches: 0,
        applyFailures: 0,
        acksSent: 0
      }
    })
  })
})
