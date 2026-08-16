import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord, ChatRun } from '../main/store/types'
import {
  collectTranscriptExportRounds,
  isTranscriptExportScope,
  scopeChatForTranscriptExport
} from './transcriptExportScope'

function message(
  id: string,
  timestamp: string,
  metadata: ChatMessage['metadata'],
  content = id
): ChatMessage {
  return { id, role: 'system', content, timestamp, metadata }
}

function chat(): ChatRecord {
  const runs: ChatRun[] = [
    {
      runId: 'run-1',
      startedAt: '2026-08-16T10:00:01.000Z',
      endedAt: '2026-08-16T10:00:04.000Z',
      status: 'completed',
      ensembleRoundId: 'round-1',
      ensembleParticipantId: 'worker',
      ensembleRole: 'Worker',
      provider: 'codex'
    },
    {
      runId: 'run-2',
      startedAt: '2026-08-16T10:01:01.000Z',
      status: 'running',
      ensembleRoundId: 'round-2',
      ensembleParticipantId: 'reviewer',
      ensembleRole: 'Reviewer',
      provider: 'claude'
    }
  ]
  return {
    appChatId: 'chat-1',
    title: 'Mission',
    chatKind: 'ensemble',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [
      message(
        'prompt-1',
        '2026-08-16T10:00:00.000Z',
        { kind: 'ensembleRoundPrompt', ensembleRoundId: 'round-1' },
        'First mission'
      ),
      message('yield-1', '2026-08-16T10:00:03.000Z', {
        kind: 'ensembleParticipantStatus',
        ensembleRoundId: 'round-1',
        ensembleParticipantId: 'worker',
        ensembleRole: 'Worker',
        ensembleProvider: 'codex',
        ensembleStatus: 'yielded'
      }),
      message('steer-1', '2026-08-16T10:00:03.500Z', { kind: 'midRunSteering' }),
      message('close-1', '2026-08-16T10:00:05.000Z', {
        kind: 'taskWraithCloseout',
        closeoutRoundId: 'round-1',
        closeoutStatus: 'completed',
        closeoutDurationMs: 5_000
      }),
      message(
        'prompt-2',
        '2026-08-16T10:01:00.000Z',
        { kind: 'ensembleRoundPrompt', ensembleRoundId: 'round-2' },
        'Second mission'
      ),
      message('reply-2', '2026-08-16T10:01:02.000Z', {
        kind: 'ensembleParticipant',
        ensembleRoundId: 'round-2',
        ensembleParticipantId: 'reviewer',
        ensembleRole: 'Reviewer',
        ensembleProvider: 'claude'
      })
    ],
    runs,
    ensemble: {
      enabled: true,
      maxParticipants: 2,
      participants: [],
      activeRound: {
        roundId: 'round-2',
        status: 'running',
        prompt: 'Second mission',
        startedAt: '2026-08-16T10:01:00.000Z',
        continuationHops: 7,
        participants: [
          {
            participantId: 'reviewer',
            provider: 'claude',
            role: 'Reviewer',
            order: 0,
            status: 'running'
          }
        ]
      }
    }
  }
}

describe('collectTranscriptExportRounds', () => {
  it('joins prompt, close-out, run, hop, and participant evidence chronologically', () => {
    const rounds = collectTranscriptExportRounds(chat())

    expect(rounds).toHaveLength(2)
    expect(rounds[0]).toMatchObject({
      roundId: 'round-1',
      ordinal: 1,
      prompt: 'First mission',
      status: 'completed',
      hops: 1,
      participantCount: 1,
      endedAt: '2026-08-16T10:00:05.000Z'
    })
    expect(rounds[0].participantLabels).toEqual(['Worker · codex'])
    expect(rounds[1]).toMatchObject({
      roundId: 'round-2',
      ordinal: 2,
      prompt: 'Second mission',
      status: 'running',
      hops: 7,
      participantCount: 1
    })
  })
})

describe('scopeChatForTranscriptExport', () => {
  it('keeps explicit round rows plus untagged rows inside the round boundary', () => {
    const scoped = scopeChatForTranscriptExport(chat(), { kind: 'round', roundId: 'round-1' })

    expect(scoped?.chat.messages.map((candidate) => candidate.id)).toEqual([
      'prompt-1',
      'yield-1',
      'steer-1',
      'close-1'
    ])
    expect(scoped?.chat.runs.map((run) => run.runId)).toEqual(['run-1'])
    expect(scoped?.chat.ensemble?.activeRound).toBeUndefined()
  })

  it('returns the canonical chat for entire-task scope and rejects missing rounds', () => {
    const source = chat()
    expect(scopeChatForTranscriptExport(source, { kind: 'entire-task' })?.chat).toBe(source)
    expect(scopeChatForTranscriptExport(source, { kind: 'round', roundId: 'missing' })).toBeNull()
  })
})

describe('isTranscriptExportScope', () => {
  it('accepts only the two closed scope shapes', () => {
    expect(isTranscriptExportScope({ kind: 'entire-task' })).toBe(true)
    expect(isTranscriptExportScope({ kind: 'round', roundId: 'round-2' })).toBe(true)
    expect(isTranscriptExportScope({ kind: 'round', roundId: ' round-2 ' })).toBe(false)
    expect(isTranscriptExportScope({ kind: 'round' })).toBe(false)
    expect(isTranscriptExportScope({ kind: 'entire-task', roundId: 'round-2' })).toBe(false)
  })
})
