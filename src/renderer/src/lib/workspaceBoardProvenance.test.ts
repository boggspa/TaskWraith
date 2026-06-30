import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceBoardProvenance } from './workspaceBoardProvenance'

describe('workspaceBoardProvenance', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-30T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('applies default actor, timestamp, and trust', () => {
    expect(createWorkspaceBoardProvenance('manual')).toEqual({
      actor: 'user',
      sourceKind: 'manual',
      at: '2026-06-30T12:00:00.000Z',
      trust: 'user-confirmed',
      sourceId: undefined,
      sourceTitle: undefined,
      provider: undefined,
      runId: undefined,
      note: undefined
    })
  })

  it('passes through optional provenance fields', () => {
    expect(
      createWorkspaceBoardProvenance('capture', {
        sourceId: 'chat-1',
        sourceTitle: 'Thread title',
        provider: 'codex',
        runId: 'run-42',
        note: 'Captured from transcript'
      })
    ).toEqual({
      actor: 'user',
      sourceKind: 'capture',
      at: '2026-06-30T12:00:00.000Z',
      trust: 'user-confirmed',
      sourceId: 'chat-1',
      sourceTitle: 'Thread title',
      provider: 'codex',
      runId: 'run-42',
      note: 'Captured from transcript'
    })
  })

  it('allows overriding actor, timestamp, and trust', () => {
    expect(
      createWorkspaceBoardProvenance('thread', {
        actor: 'agent',
        at: '2026-01-01T00:00:00.000Z',
        trust: 'agent-proposed',
        sourceId: 'thread-9'
      })
    ).toEqual({
      actor: 'agent',
      sourceKind: 'thread',
      at: '2026-01-01T00:00:00.000Z',
      trust: 'agent-proposed',
      sourceId: 'thread-9',
      sourceTitle: undefined,
      provider: undefined,
      runId: undefined,
      note: undefined
    })
  })
})