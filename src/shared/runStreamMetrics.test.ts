import { describe, expect, it } from 'vitest'
import {
  createRunStreamMetrics,
  recordRunFlushMetric,
  recordRunItemMetric,
  runStreamMetricRates
} from './runStreamMetrics'
import type { RunItemEvent } from './runItemEvents'

const event = (overrides: Partial<RunItemEvent>): RunItemEvent =>
  ({
    protocolVersion: 1,
    kind: 'item/delta',
    chatId: 'chat-1',
    runId: 'run-1',
    provider: 'codex',
    itemId: 'item-1',
    itemKind: 'assistant_message',
    channel: 'assistant',
    delta: 'hello',
    sequence: 1,
    createdAt: '2026-06-29T00:00:00.000Z',
    ...overrides
  }) as RunItemEvent

describe('runStreamMetrics', () => {
  it('counts item deltas, chars, flushes, and rates', () => {
    let metrics = createRunStreamMetrics('run-1', 0)
    metrics = recordRunItemMetric(metrics, event({ sequence: 1, delta: 'hello' }), 500)
    metrics = recordRunItemMetric(metrics, event({ sequence: 2, delta: ' world' }), 1000)
    metrics = recordRunFlushMetric(metrics, 'run-1', 11, 1000, [5, 6])

    expect(metrics.itemEvents).toBe(2)
    expect(metrics.itemDeltas).toBe(2)
    expect(metrics.itemDeltaChars).toBe(11)
    expect(metrics.flushes).toBe(1)
    expect(metrics.maxCharsPerFlush).toBe(11)
    expect(metrics.itemFlushes).toBe(2)
    expect(metrics.maxCharsPerItemFlush).toBe(6)
    expect(runStreamMetricRates(metrics)).toMatchObject({
      eventsPerSecond: 2,
      deltasPerSecond: 2,
      charsPerSecond: 11,
      flushesPerSecond: 1,
      averageCharsPerFlush: 11,
      averageItemsPerFlush: 2,
      averageCharsPerItemFlush: 5.5
    })
  })

  it('detects sequence gaps and duplicates', () => {
    let metrics = createRunStreamMetrics('run-1', 0)
    metrics = recordRunItemMetric(metrics, event({ sequence: 1 }), 0)
    metrics = recordRunItemMetric(metrics, event({ sequence: 4 }), 1)
    metrics = recordRunItemMetric(metrics, event({ sequence: 4 }), 2)

    expect(metrics.sequenceGaps).toBe(1)
    expect(metrics.maxSequenceGap).toBe(3)
    expect(metrics.duplicateSequences).toBe(1)
    expect(metrics.lastSequence).toBe(4)
  })
})
