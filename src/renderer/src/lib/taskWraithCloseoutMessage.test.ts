import { describe, expect, it } from 'vitest'
import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  EnsembleRoundState
} from '../../../main/store/types'
import { TASKWRAITH_CLOSEOUT_KIND } from '../../../shared/taskWraithCloseout'
import {
  buildTaskWraithRoundCloseoutMessage,
  buildTaskWraithRunCloseoutMessage,
  upsertTaskWraithCloseoutMessage
} from './taskWraithCloseoutMessage'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Chat',
    provider: 'codex',
    scope: 'workspace',
    messages: [],
    runs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  } as ChatRecord
}

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  metadata?: ChatMessage['metadata']
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: '2026-07-07T12:00:00.000Z',
    ...(metadata ? { metadata } : {})
  }
}

describe('taskWraithCloseoutMessage', () => {
  it('builds a low-trust system run closeout with deterministic provenance', () => {
    const run: ChatRun = {
      runId: 'run-1',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:39.000Z',
      status: 'success',
      stats: { input_tokens: 1000, output_tokens: 2000 }
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [{ ...message('a1', 'assistant', 'Implemented the feature.'), runId: 'run-1' }],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:00:39.000Z',
      exitCode: 0,
      fileSummaries: [
        {
          path: 'src/App.tsx',
          status: 'modified',
          previewKind: 'text_preview',
          additions: 9,
          deletions: 2
        }
      ]
    })

    expect(closeout.role).toBe('system')
    expect(closeout.metadata?.kind).toBe(TASKWRAITH_CLOSEOUT_KIND)
    expect(closeout.metadata?.closeoutSource).toBe('deterministicFallback')
    expect(closeout.content).toContain('Worked for 39s')
    expect(closeout.content).toContain('Implemented the feature.')
    expect(closeout.content).toContain('1 file (+9 -2).')
    expect(closeout.content).toContain('3k total')
  })

  it('inserts an ensemble closeout after its round body without stamping ensembleRoundId', () => {
    const round: EnsembleRoundState = {
      roundId: 'round-1',
      status: 'completed',
      prompt: 'Do it',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:01:00.000Z',
      participants: [
        { participantId: 'p1', provider: 'codex', role: 'Builder', order: 1, status: 'answered' }
      ]
    }
    const closeout = buildTaskWraithRoundCloseoutMessage({
      chat: chat({
        chatKind: 'ensemble',
        ensemble: { activeRound: round } as ChatRecord['ensemble']
      }),
      round,
      completedAt: round.endedAt!
    })
    const messages = [
      message('u1', 'user', 'Do it', { ensembleRoundId: 'round-1' }),
      message('a1', 'assistant', 'Done', { ensembleRoundId: 'round-1' }),
      message('u2', 'user', 'Next', { ensembleRoundId: 'round-2' })
    ]

    const updated = upsertTaskWraithCloseoutMessage(messages, closeout, {
      closeoutRoundId: 'round-1'
    })

    expect(updated.map((item) => item.id)).toEqual(['u1', 'a1', closeout.id, 'u2'])
    expect(closeout.metadata?.closeoutRoundId).toBe('round-1')
    expect(closeout.metadata?.ensembleRoundId).toBeUndefined()
  })
})
