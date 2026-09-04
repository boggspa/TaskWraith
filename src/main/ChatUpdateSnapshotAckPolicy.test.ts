import { describe, expect, it } from 'vitest'
import type { ChatRecord } from './store/types'
import type { ChatUpdateDelivery } from '../shared/chatUpdateTransport'
import {
  SNAPSHOT_ACK_MAX_TIMEOUT_MS,
  SNAPSHOT_ACK_MIN_TIMEOUT_MS,
  SNAPSHOT_RETRY_INITIAL_DELAY_MS,
  SNAPSHOT_RETRY_MAX_DELAY_MS,
  estimateChatUpdateSnapshotBytes,
  resolveChatUpdateAckTimeoutMs,
  resolveSnapshotRetryDelayMs
} from './ChatUpdateSnapshotAckPolicy'

function snapshot(content: string): ChatUpdateDelivery {
  const chat = {
    appChatId: 'chat-1',
    title: 'Large chat',
    provider: 'codex',
    archived: false,
    messages: [
      {
        id: 'message-1',
        role: 'assistant',
        content,
        timestamp: '2026-09-04T00:00:00.000Z'
      }
    ],
    runs: [],
    createdAt: 1,
    updatedAt: 1
  } as ChatRecord
  return {
    protocolVersion: 2,
    kind: 'snapshot',
    deliveryId: 'delivery-1',
    chatId: chat.appChatId,
    revision: 1,
    chat
  }
}

describe('ChatUpdateSnapshotAckPolicy', () => {
  it('keeps the configured timeout exactly for ordinary patches', () => {
    expect(
      resolveChatUpdateAckTimeoutMs({
        kind: 'patch',
        configuredTimeoutMs: 5_000,
        snapshotBytes: 512 * 1024 * 1024
      })
    ).toBe(5_000)
  })

  it('gives snapshots a byte-scaled deadline without shortening explicit configuration', () => {
    const small = resolveChatUpdateAckTimeoutMs({
      kind: 'snapshot',
      configuredTimeoutMs: 5_000,
      snapshotBytes: 0
    })
    const large = resolveChatUpdateAckTimeoutMs({
      kind: 'snapshot',
      configuredTimeoutMs: 5_000,
      snapshotBytes: 64 * 1024 * 1024
    })

    expect(small).toBe(SNAPSHOT_ACK_MIN_TIMEOUT_MS)
    expect(large).toBeGreaterThan(small)
    expect(large).toBeLessThanOrEqual(SNAPSHOT_ACK_MAX_TIMEOUT_MS)
    expect(
      resolveChatUpdateAckTimeoutMs({
        kind: 'snapshot',
        configuredTimeoutMs: SNAPSHOT_ACK_MAX_TIMEOUT_MS + 1,
        snapshotBytes: 0
      })
    ).toBe(SNAPSHOT_ACK_MAX_TIMEOUT_MS + 1)
  })

  it('preserves zero as the coordinator escape hatch that disables ACK timers', () => {
    expect(
      resolveChatUpdateAckTimeoutMs({
        kind: 'snapshot',
        configuredTimeoutMs: 0,
        snapshotBytes: 64 * 1024 * 1024
      })
    ).toBe(0)
  })

  it('walks full snapshot metadata for the byte estimate and skips patches', () => {
    const small = snapshot('x')
    const large = snapshot('x'.repeat(10_000))
    expect(estimateChatUpdateSnapshotBytes(large)).toBeGreaterThan(
      estimateChatUpdateSnapshotBytes(small) + 10_000
    )
    expect(
      estimateChatUpdateSnapshotBytes({
        protocolVersion: 2,
        kind: 'patch',
        deliveryId: 'patch-1',
        chatId: 'chat-1',
        baseRevision: 1,
        revision: 2,
        recordMask: [],
        recordDelta: {}
      })
    ).toBe(0)
  })

  it('backs snapshot retries off exponentially and caps the cadence', () => {
    expect(resolveSnapshotRetryDelayMs({ consecutiveTimeouts: 1, ackTimeoutMs: 0 })).toBe(
      SNAPSHOT_RETRY_INITIAL_DELAY_MS
    )
    expect(resolveSnapshotRetryDelayMs({ consecutiveTimeouts: 2, ackTimeoutMs: 0 })).toBe(
      SNAPSHOT_RETRY_INITIAL_DELAY_MS * 2
    )
    expect(resolveSnapshotRetryDelayMs({ consecutiveTimeouts: 30, ackTimeoutMs: 0 })).toBe(
      SNAPSHOT_RETRY_MAX_DELAY_MS
    )
    expect(
      resolveSnapshotRetryDelayMs({
        consecutiveTimeouts: 1,
        ackTimeoutMs: SNAPSHOT_RETRY_MAX_DELAY_MS * 2
      })
    ).toBe(SNAPSHOT_RETRY_MAX_DELAY_MS)
  })
})
