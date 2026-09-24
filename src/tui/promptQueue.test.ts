import { describe, expect, it } from 'vitest'
import { createEmptyHostSnapshot, type HostSnapshot } from '../shared/hostProtocol'
import { liveThreadWorkIds, nextDispatchableDraft } from './promptQueue'
import type { TuiQueuedDraft } from './state'

function snapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  const base = createEmptyHostSnapshot({ generation: 1, cursor: 1, freshness: 'live' })
  return {
    ...base,
    threads: [
      {
        id: 'a',
        workspaceId: 'ws',
        title: 'A',
        chatKind: 'single',
        archived: false,
        pinned: false,
        updatedAt: 1,
        messageCount: 0
      },
      {
        id: 'b',
        workspaceId: 'ws',
        title: 'B',
        chatKind: 'single',
        archived: false,
        pinned: false,
        updatedAt: 1,
        messageCount: 0
      }
    ],
    ...overrides
  }
}

function draft(id: string, threadId: string, enqueuedAt: number): TuiQueuedDraft {
  return { id, threadId, text: id, enqueuedAt, phase: 'queued' }
}

describe('TUI prompt queue', () => {
  it('waits for exact live work and never treats a stale projection as idle', () => {
    const live = snapshot({
      runs: [{ runId: 'run-a', threadId: 'a', providerId: 'codex', providerOutcome: 'running' }]
    })
    expect(liveThreadWorkIds(live, 'a')).toEqual(['run-a'])
    expect(nextDispatchableDraft({ queuedDrafts: [draft('one', 'a', 1)] }, live)).toBeUndefined()
    expect(
      nextDispatchableDraft(
        { queuedDrafts: [draft('one', 'a', 1)] },
        { ...live, freshness: 'stale' }
      )
    ).toBeUndefined()
    const uncertainRound = snapshot({
      rounds: [
        {
          roundId: 'round-unknown',
          threadId: 'a',
          status: 'unknown',
          participantIds: [],
          providerRunIds: []
        }
      ]
    })
    expect(liveThreadWorkIds(uncertainRound, 'a')).toEqual(['round-unknown'])
    expect(
      nextDispatchableDraft({ queuedDrafts: [draft('one', 'a', 1)] }, uncertainRound)
    ).toBeUndefined()
  })

  it('preserves FIFO per thread without letting a busy thread block an idle one', () => {
    const host = snapshot({
      runs: [{ runId: 'run-a', threadId: 'a', providerId: 'codex', providerOutcome: 'running' }]
    })
    const drafts = [draft('a-1', 'a', 1), draft('a-2', 'a', 2), draft('b-1', 'b', 3)]
    expect(nextDispatchableDraft({ queuedDrafts: drafts }, host)?.id).toBe('b-1')
    expect(nextDispatchableDraft({ queuedDrafts: drafts }, snapshot())?.id).toBe('a-1')
  })

  it('honours dispatch and accepted-run barriers without exposing a later same-thread row', () => {
    const drafts = [draft('a-1', 'a', 1), draft('a-2', 'a', 2), draft('b-1', 'b', 3)]
    expect(nextDispatchableDraft({ queuedDrafts: drafts }, snapshot(), new Set(['a-1']))?.id).toBe(
      'b-1'
    )
    expect(
      nextDispatchableDraft({ queuedDrafts: drafts }, snapshot(), new Set(), new Set(['a']))?.id
    ).toBe('b-1')
    expect(
      nextDispatchableDraft(
        {
          queuedDrafts: [
            { ...draft('blocked', 'a', 0), phase: 'blocked', error: 'denied' },
            draft('later', 'a', 1)
          ]
        },
        snapshot()
      )
    ).toBeUndefined()
  })
})
