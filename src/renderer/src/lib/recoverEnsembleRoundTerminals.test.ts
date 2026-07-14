import { describe, expect, it } from 'vitest'

import { applyRecoveryRecordsToEnsembleRounds } from './recoverEnsembleRoundTerminals'
import type { ChatRecord, RunRecoveryRecord } from '../../../main/store/types'

function makeChat(overrides: Partial<ChatRecord> & Pick<ChatRecord, 'appChatId'>): ChatRecord {
  return {
    title: 'Test chat',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

function makeRecord(
  overrides: Partial<RunRecoveryRecord> & Pick<RunRecoveryRecord, 'runId' | 'chatId'>
): RunRecoveryRecord {
  return {
    schemaVersion: 1,
    id: `${overrides.runId}-record`,
    jobId: overrides.runId,
    provider: 'codex',
    previousStatus: 'active',
    recoveredStatus: 'failed',
    action: 'marked_failed',
    reason: 'Run was active when TaskWraith last exited.',
    recoveredAt: '2026-06-30T12:00:00.000Z',
    resumeAvailable: false,
    resumeHint: '',
    jobSnapshot: {},
    ...overrides
  }
}

function ensembleChat(
  patch: Partial<NonNullable<ChatRecord['ensemble']>['activeRound']> = {}
): ChatRecord {
  return makeChat({
    appChatId: 'chat-1',
    chatKind: 'ensemble',
    provider: 'codex',
    ensemble: {
      enabled: true,
      maxParticipants: 2,
      participants: [],
      activeRound: {
        roundId: 'round-1',
        status: 'running',
        prompt: 'Coordinate',
        startedAt: '2026-06-30T11:55:00.000Z',
        activeParticipantId: 'p1',
        queuedPrompt: 'next prompt',
        queuedPrompts: ['next prompt'],
        queuedPromptEntries: [
          {
            persistenceVersion: 1,
            id: 'queued-next',
            prompt: 'next prompt',
            dmTargetParticipantId: 'p1',
            fanoutPolicy: 'off',
            imageAttachments: []
          }
        ],
        participants: [
          {
            participantId: 'p1',
            provider: 'codex',
            role: 'Builder',
            order: 0,
            status: 'running',
            runId: 'run-1'
          }
        ],
        ...patch
      }
    }
  })
}

describe('applyRecoveryRecordsToEnsembleRounds', () => {
  it('returns the original chats untouched when there are no recovery records', () => {
    const chats = [ensembleChat()]
    expect(applyRecoveryRecordsToEnsembleRounds([], chats)).toBe(chats)
  })

  it('returns the original chats untouched when no terminal records match the active round', () => {
    const chats = [ensembleChat()]
    const records = [
      makeRecord({
        runId: 'run-1',
        chatId: 'chat-1',
        recoveredStatus: 'queued',
        action: 'requeued_stale_steer_promoting'
      })
    ]
    expect(applyRecoveryRecordsToEnsembleRounds(records, chats)).toBe(chats)
  })

  it('closes an orphaned running round without clearing durable queued work', () => {
    const chats = [ensembleChat()]
    const records = [
      makeRecord({
        runId: 'run-1',
        chatId: 'chat-1',
        recoveredAt: '2026-06-30T12:01:00.000Z'
      })
    ]

    const result = applyRecoveryRecordsToEnsembleRounds(records, chats)
    const round = result[0].ensemble?.activeRound

    expect(result[0]).not.toBe(chats[0])
    expect(round).toMatchObject({
      roundId: 'round-1',
      status: 'failed',
      endedAt: '2026-06-30T12:01:00.000Z',
      activeParticipantId: undefined,
      queuedPrompt: 'next prompt',
      queuedPrompts: ['next prompt'],
      queuedPromptEntries: [
        expect.objectContaining({
          id: 'queued-next',
          dmTargetParticipantId: 'p1',
          fanoutPolicy: 'off'
        })
      ],
      pendingWakeupIds: [],
      sleepingParticipantIds: []
    })
    expect(round?.participants[0]).toMatchObject({
      participantId: 'p1',
      status: 'failed',
      endedAt: '2026-06-30T12:01:00.000Z',
      reason: 'Run was active when TaskWraith last exited.'
    })
  })

  it('keeps the round running when another participant still has live dispatch evidence', () => {
    const chats = [
      ensembleChat({
        activeParticipantId: 'p2',
        participants: [
          {
            participantId: 'p1',
            provider: 'codex',
            role: 'Builder',
            order: 0,
            status: 'running',
            runId: 'run-1'
          },
          {
            participantId: 'p2',
            provider: 'claude',
            role: 'Reviewer',
            order: 1,
            status: 'running',
            runId: 'run-2'
          }
        ]
      })
    ]
    const records = [makeRecord({ runId: 'run-1', chatId: 'chat-1' })]

    const result = applyRecoveryRecordsToEnsembleRounds(records, chats)
    const round = result[0].ensemble?.activeRound

    expect(round?.status).toBe('running')
    expect(round?.activeParticipantId).toBe('p2')
    expect(round?.queuedPrompts).toEqual(['next prompt'])
    expect(round?.participants.map((participant) => participant.status)).toEqual([
      'failed',
      'running'
    ])
  })

  it('closes an already-terminal participant snapshot whose round status stayed running', () => {
    const chats = [
      ensembleChat({
        activeParticipantId: undefined,
        participants: [
          {
            participantId: 'p1',
            provider: 'codex',
            role: 'Builder',
            order: 0,
            status: 'answered',
            runId: 'run-1',
            endedAt: '2026-06-30T11:59:00.000Z'
          }
        ]
      })
    ]

    const result = applyRecoveryRecordsToEnsembleRounds(
      [makeRecord({ runId: 'run-1', chatId: 'chat-1' })],
      chats
    )

    expect(result[0].ensemble?.activeRound?.status).toBe('failed')
    expect(result[0].ensemble?.activeRound?.queuedPrompts).toEqual(['next prompt'])
    expect(result[0].ensemble?.activeRound?.queuedPromptEntries?.[0]?.id).toBe('queued-next')
  })

  it('updates matching concurrent lanes before closing a recovered round', () => {
    const chats = [
      ensembleChat({
        activeParticipantId: undefined,
        participants: [
          {
            participantId: 'p1',
            provider: 'codex',
            role: 'Builder',
            order: 0,
            status: 'answered',
            runId: 'run-1'
          }
        ],
        lanes: {
          lane1: {
            laneId: 'lane1',
            participantId: 'p1',
            provider: 'codex',
            status: 'running',
            intent: 'write',
            runId: 'run-1',
            startedAt: '2026-06-30T11:55:00.000Z'
          }
        }
      })
    ]

    const result = applyRecoveryRecordsToEnsembleRounds(
      [makeRecord({ runId: 'run-1', chatId: 'chat-1' })],
      chats
    )
    const round = result[0].ensemble?.activeRound

    expect(round?.status).toBe('failed')
    expect(round?.lanes?.lane1).toMatchObject({
      status: 'failed',
      endedAt: '2026-06-30T12:00:00.000Z'
    })
  })
})
