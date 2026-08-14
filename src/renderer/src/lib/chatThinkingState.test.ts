import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { chatHasInFlightThinkingWork, deriveFocusedTranscriptIsThinking } from './chatThinkingState'

const baseChat = (patch: Partial<ChatRecord> = {}): ChatRecord =>
  ({
    appChatId: 'chat-1',
    provider: 'codex',
    messages: [],
    ...patch
  }) as ChatRecord

describe('chatHasInFlightThinkingWork', () => {
  it('returns true when the chat id is in runningChatIds', () => {
    expect(
      chatHasInFlightThinkingWork({
        chat: baseChat(),
        runningChatIds: new Set(['chat-1'])
      })
    ).toBe(true)
  })

  it('returns true for an ensemble chat with a running activeRound', () => {
    expect(
      chatHasInFlightThinkingWork({
        chat: baseChat({
          chatKind: 'ensemble',
          ensemble: {
            enabled: true,
            maxParticipants: 6,
            participants: [],
            activeRound: {
              roundId: 'round-1',
              status: 'running',
              prompt: 'go',
              startedAt: '2026-06-09T00:00:00.000Z',
              activeParticipantId: 'p1',
              participants: [
                {
                  participantId: 'p1',
                  provider: 'codex',
                  role: 'Worker',
                  order: 0,
                  status: 'running'
                }
              ]
            },
            updatedAt: '2026-06-09T00:00:00.000Z'
          }
        }),
        runningChatIds: new Set()
      })
    ).toBe(true)
  })

  it('returns false when the ensemble round has finished', () => {
    expect(
      chatHasInFlightThinkingWork({
        chat: baseChat({
          chatKind: 'ensemble',
          ensemble: {
            enabled: true,
            maxParticipants: 6,
            participants: [],
            activeRound: {
              roundId: 'round-1',
              status: 'completed',
              prompt: 'go',
              startedAt: '2026-06-09T00:00:00.000Z',
              endedAt: '2026-06-09T00:01:00.000Z',
              participants: []
            },
            updatedAt: '2026-06-09T00:01:00.000Z'
          }
        }),
        runningChatIds: new Set()
      })
    ).toBe(false)
  })

  it('returns false for a stale running ensemble round with no live participants', () => {
    expect(
      chatHasInFlightThinkingWork({
        chat: baseChat({
          chatKind: 'ensemble',
          ensemble: {
            enabled: true,
            maxParticipants: 6,
            participants: [],
            activeRound: {
              roundId: 'round-1',
              status: 'running',
              prompt: 'go',
              startedAt: '2026-06-09T00:00:00.000Z',
              participants: [
                {
                  participantId: 'p1',
                  provider: 'codex',
                  role: 'Worker',
                  order: 0,
                  status: 'answered',
                  endedAt: '2026-06-09T00:01:00.000Z'
                }
              ]
            },
            updatedAt: '2026-06-09T00:01:00.000Z'
          }
        }),
        runningChatIds: new Set()
      })
    ).toBe(false)
  })
})

describe('deriveFocusedTranscriptIsThinking', () => {
  const terminalSolo = () =>
    baseChat({
      runs: [
        {
          runId: 'run-1',
          startedAt: '2026-06-09T00:00:00.000Z',
          endedAt: '2026-06-09T00:01:00.000Z',
          status: 'failed'
        }
      ]
    })

  it('suppresses a sticky renderer flag after a solo run is terminal', () => {
    expect(
      deriveFocusedTranscriptIsThinking({ rendererIsThinking: true, chat: terminalSolo() })
    ).toBe(false)
  })

  it('keeps genuinely newer queue work visible over an older terminal run', () => {
    expect(
      deriveFocusedTranscriptIsThinking({
        rendererIsThinking: true,
        chat: terminalSolo(),
        runQueueJobs: [
          {
            chatId: 'chat-1',
            runId: 'run-2',
            status: 'queued',
            createdAt: '2026-06-09T00:02:00.000Z'
          }
        ]
      })
    ).toBe(true)
  })

  it('does not revive Working from the terminal run own stale queue row', () => {
    expect(
      deriveFocusedTranscriptIsThinking({
        rendererIsThinking: true,
        chat: terminalSolo(),
        runQueueJobs: [
          {
            chatId: 'chat-1',
            runId: 'run-1',
            status: 'starting',
            createdAt: '2026-06-09T00:00:30.000Z'
          }
        ]
      })
    ).toBe(false)
  })

  it('does not revive Working from an older queue row with a different run id', () => {
    expect(
      deriveFocusedTranscriptIsThinking({
        rendererIsThinking: true,
        chat: terminalSolo(),
        runQueueJobs: [
          {
            chatId: 'chat-1',
            runId: 'run-older-followup',
            status: 'queued',
            createdAt: '2026-06-09T00:00:30.000Z'
          }
        ]
      })
    ).toBe(false)
  })

  it('keeps a live ensemble round visible over an older terminal run', () => {
    const chat = baseChat({
      chatKind: 'ensemble',
      runs: terminalSolo().runs,
      ensemble: {
        enabled: true,
        maxParticipants: 6,
        participants: [],
        activeRound: {
          roundId: 'round-2',
          status: 'running',
          prompt: 'go again',
          startedAt: '2026-06-09T00:02:00.000Z',
          activeParticipantId: 'p1',
          participants: [
            {
              participantId: 'p1',
              provider: 'codex',
              role: 'Worker',
              order: 0,
              status: 'running'
            }
          ]
        },
        updatedAt: '2026-06-09T00:02:00.000Z'
      }
    })
    expect(chatHasInFlightThinkingWork({ chat, runningChatIds: new Set() })).toBe(true)
    expect(deriveFocusedTranscriptIsThinking({ rendererIsThinking: true, chat })).toBe(true)
  })

  it('keeps Working visible while an ensemble round is between turns', () => {
    const chat = baseChat({
      chatKind: 'ensemble',
      ensemble: {
        enabled: true,
        maxParticipants: 6,
        participants: [],
        activeRound: {
          roundId: 'round-2',
          status: 'running',
          prompt: 'continue',
          startedAt: '2026-06-09T00:02:00.000Z',
          turnTransition: {
            phase: 'settling-provider',
            runtimeInstanceId: 'runtime-1',
            sourceParticipantId: 'p1',
            sourceRunId: 'run-1',
            startedAt: '2026-06-09T00:02:10.000Z'
          },
          participants: [
            {
              participantId: 'p1',
              provider: 'codex',
              role: 'Worker',
              order: 0,
              status: 'answered'
            }
          ]
        },
        updatedAt: '2026-06-09T00:02:10.000Z'
      }
    })

    expect(chatHasInFlightThinkingWork({ chat, runningChatIds: new Set() })).toBe(true)
    expect(deriveFocusedTranscriptIsThinking({ rendererIsThinking: true, chat })).toBe(true)
  })

  it('suppresses an ensemble with no live round or queue evidence', () => {
    const chat = baseChat({
      chatKind: 'ensemble',
      ensemble: {
        enabled: true,
        maxParticipants: 6,
        participants: [],
        activeRound: {
          roundId: 'round-1',
          status: 'completed',
          prompt: 'done',
          startedAt: '2026-06-09T00:00:00.000Z',
          endedAt: '2026-06-09T00:01:00.000Z',
          participants: []
        },
        updatedAt: '2026-06-09T00:01:00.000Z'
      }
    })
    expect(deriveFocusedTranscriptIsThinking({ rendererIsThinking: true, chat })).toBe(false)
  })

  it('preserves the renderer false gate while response text streams', () => {
    expect(
      deriveFocusedTranscriptIsThinking({
        rendererIsThinking: false,
        chat: baseChat(),
        runQueueJobs: [{ chatId: 'chat-1', runId: 'run-2', status: 'active' }]
      })
    ).toBe(false)
  })

  it('keeps a nonterminal solo renderer flag visible', () => {
    expect(deriveFocusedTranscriptIsThinking({ rendererIsThinking: true, chat: baseChat() })).toBe(
      true
    )
  })
})
