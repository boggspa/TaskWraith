import { describe, expect, it } from 'vitest'
import {
  activeEnsembleRoundForComposer,
  isChatBusyForDispatch,
  isEnsembleActiveRoundDispatchLive,
  shouldQueueRunBeforeDispatch
} from './chatBusyState'
import type { ChatRecord } from '../../../main/store/types'

type EnsembleRound = NonNullable<NonNullable<ChatRecord['ensemble']>['activeRound']>

describe('isChatBusyForDispatch', () => {
  it('reports busy when the chat has an active run context', () => {
    expect(
      isChatBusyForDispatch({
        chatId: 'chat-1',
        activeRuns: [{ chatId: 'chat-1' }],
        runQueueJobs: []
      })
    ).toBe(true)
  })

  it('reports busy when another active queue job targets the chat', () => {
    expect(
      isChatBusyForDispatch({
        chatId: 'chat-1',
        activeRuns: [],
        runQueueJobs: [{ runId: 'run-2', chatId: 'chat-1', status: 'starting' }]
      })
    ).toBe(true)
  })

  it('ignores the current run queue job while dispatching a leased steer replacement', () => {
    expect(
      isChatBusyForDispatch({
        chatId: 'chat-1',
        activeRuns: [],
        runQueueJobs: [{ runId: 'run-1', chatId: 'chat-1', status: 'starting' }],
        ignoreQueueRunId: 'run-1'
      })
    ).toBe(false)
  })

  it('does not ignore a different active queue job for the same chat', () => {
    expect(
      isChatBusyForDispatch({
        chatId: 'chat-1',
        activeRuns: [],
        runQueueJobs: [
          { runId: 'run-1', chatId: 'chat-1', status: 'starting' },
          { runId: 'run-2', chatId: 'chat-1', status: 'active' }
        ],
        ignoreQueueRunId: 'run-1'
      })
    ).toBe(true)
  })
})

describe('shouldQueueRunBeforeDispatch', () => {
  it('pre-queues busy solo chats through the desktop run queue', () => {
    expect(shouldQueueRunBeforeDispatch({ chatKind: 'single', busy: true })).toBe(true)
  })

  it('lets busy ensemble chats reach the ensemble orchestrator queue', () => {
    expect(shouldQueueRunBeforeDispatch({ chatKind: 'ensemble', busy: true })).toBe(false)
  })

  it('does not queue idle chats before dispatch', () => {
    expect(shouldQueueRunBeforeDispatch({ chatKind: 'single', busy: false })).toBe(false)
  })
})

describe('isEnsembleActiveRoundDispatchLive', () => {
  const round = (patch: Partial<EnsembleRound> = {}): EnsembleRound =>
    ({
      roundId: 'round-1',
      status: 'running',
      prompt: 'go',
      startedAt: '2026-06-30T00:00:00.000Z',
      participants: [
        {
          participantId: 'p1',
          provider: 'codex',
          role: 'Worker',
          order: 0,
          status: 'running'
        }
      ],
      ...patch
    }) as EnsembleRound

  it('is live for an active participant, pending participant, wakeup, or concurrent lane', () => {
    expect(isEnsembleActiveRoundDispatchLive(round({ activeParticipantId: 'p1' }))).toBe(true)
    expect(
      isEnsembleActiveRoundDispatchLive(
        round({ participants: [{ ...round().participants[0], status: 'idle' }] })
      )
    ).toBe(true)
    expect(
      isEnsembleActiveRoundDispatchLive(
        round({
          participants: [{ ...round().participants[0], status: 'answered' }],
          pendingWakeupIds: ['wakeup-1']
        })
      )
    ).toBe(true)
    expect(
      isEnsembleActiveRoundDispatchLive(
        round({
          participants: [{ ...round().participants[0], status: 'answered' }],
          lanes: {
            lane1: {
              laneId: 'lane1',
              participantId: 'p1',
              provider: 'codex',
              status: 'awaiting-approval',
              intent: 'write',
              startedAt: '2026-06-30T00:00:00.000Z'
            }
          }
        })
      )
    ).toBe(true)
  })

  it('is not live for a stale running snapshot whose participants are terminal', () => {
    expect(
      isEnsembleActiveRoundDispatchLive(
        round({
          activeParticipantId: 'p1',
          participants: [
            { ...round().participants[0], status: 'answered', endedAt: '2026-06-30T00:01:00.000Z' },
            {
              participantId: 'p2',
              provider: 'claude',
              role: 'Reviewer',
              order: 1,
              status: 'skipped',
              endedAt: '2026-06-30T00:01:00.000Z'
            }
          ]
        })
      )
    ).toBe(false)
  })

  it('does not treat queued prompts alone as live after every participant ended', () => {
    expect(
      isEnsembleActiveRoundDispatchLive(
        round({
          activeParticipantId: undefined,
          queuedPrompt: 'next',
          queuedPrompts: ['next'],
          participants: [{ ...round().participants[0], status: 'answered' }]
        })
      )
    ).toBe(false)
  })

  it('keeps terminal round mode and hop state out of idle composer controls', () => {
    const live = round({
      orchestrationMode: 'continuous',
      continuationHops: 1,
      maxContinuationHops: 24
    })
    expect(activeEnsembleRoundForComposer(live)).toBe(live)

    expect(
      activeEnsembleRoundForComposer({
        ...live,
        status: 'cancelled',
        endedAt: '2026-06-30T00:01:00.000Z'
      })
    ).toBeUndefined()
    expect(
      activeEnsembleRoundForComposer({
        ...live,
        activeParticipantId: undefined,
        participants: [{ ...live.participants[0], status: 'answered' }]
      })
    ).toBeUndefined()
  })
})
