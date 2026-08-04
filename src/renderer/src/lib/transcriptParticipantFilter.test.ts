import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord, EnsembleParticipant, ToolActivity } from '../../../main/store/types'
import {
  TRANSCRIPT_SYSTEM_FILTER_KEY,
  buildTranscriptParticipantFilterItems,
  filterTranscriptMessagesByParticipantKeys,
  transcriptParticipantFilterKey
} from './transcriptParticipantFilter'

function participant(overrides: Partial<EnsembleParticipant>): EnsembleParticipant {
  return {
    id: 'participant-codex',
    provider: 'codex',
    enabled: true,
    role: 'Builder',
    instructions: '',
    order: 1,
    ...overrides
  }
}

function ensembleChat(participants: EnsembleParticipant[]): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    title: 'Ensemble',
    chatKind: 'ensemble',
    provider: 'codex',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: participants.length,
      bossmanParticipantId: 'boss',
      captainParticipantIds: ['captain', 'captain-2', 'captain-3'],
      secondInCommandParticipantId: 'captain',
      participants
    }
  } as ChatRecord
}

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: id,
    timestamp: '2026-07-04T12:00:00.000Z',
    ...overrides
  }
}

function toolActivity(participantId: string): ToolActivity {
  return {
    id: `activity-${participantId}`,
    toolName: 'read_file',
    displayName: 'Read file',
    category: 'read',
    status: 'success',
    metadata: { ensembleParticipantId: participantId }
  }
}

describe('transcript participant filters', () => {
  it('builds ordered participant filter items with pooled and authority metadata', () => {
    const items = buildTranscriptParticipantFilterItems(
      ensembleChat([
        participant({ id: 'boss', provider: 'codex', role: 'Boss', order: 3 }),
        participant({
          id: 'pooled',
          provider: 'kimi',
          role: 'Scout',
          order: 1,
          pooledAgentId: 'pooled-agent-scout'
        }),
        participant({ id: 'captain', provider: 'claude', role: 'Captain', order: 2 }),
        participant({ id: 'captain-2', provider: 'grok', role: 'Captain 2', order: 4 }),
        participant({ id: 'captain-3', provider: 'cursor', role: 'Captain 3', order: 5 })
      ])
    )

    expect(items.map((item) => item.key)).toEqual([
      transcriptParticipantFilterKey('pooled'),
      transcriptParticipantFilterKey('captain'),
      transcriptParticipantFilterKey('boss'),
      transcriptParticipantFilterKey('captain-2'),
      transcriptParticipantFilterKey('captain-3'),
      TRANSCRIPT_SYSTEM_FILTER_KEY
    ])
    expect(items.map((item) => item.ordinal)).toEqual([1, 2, 3, 4, 5, undefined])
    expect(items[0]).toMatchObject({ participantId: 'pooled', pooledAgent: true })
    expect(items[1]).toMatchObject({ participantId: 'captain', isCaptain: true })
    expect(items[2]).toMatchObject({ participantId: 'boss', isBossman: true })
    expect(items[3]).toMatchObject({ participantId: 'captain-2', isCaptain: true })
    expect(items[4]).toMatchObject({ participantId: 'captain-3', isCaptain: true })
    expect(items[5]).toMatchObject({ kind: 'system', title: 'System messages' })
  })

  it('filters messages additively by participant keys and the system key', () => {
    const messages = [
      message('user', { role: 'user', content: 'prompt' }),
      message('participant-a', { metadata: { ensembleParticipantId: 'a' } }),
      message('participant-b', { metadata: { ensembleParticipantId: 'b' } }),
      message('participant-a-tools', {
        role: 'tool',
        content: '',
        toolActivities: [toolActivity('a')]
      }),
      message('system', { role: 'system', content: 'status' })
    ]

    const noFilter = filterTranscriptMessagesByParticipantKeys(messages, new Set())
    expect(noFilter).toBe(messages)

    expect(
      filterTranscriptMessagesByParticipantKeys(messages, new Set([transcriptParticipantFilterKey('a')])).map(
        (entry) => entry.id
      )
    ).toEqual(['participant-a', 'participant-a-tools'])

    expect(
      filterTranscriptMessagesByParticipantKeys(messages, new Set([TRANSCRIPT_SYSTEM_FILTER_KEY])).map(
        (entry) => entry.id
      )
    ).toEqual(['user', 'system'])

    expect(
      filterTranscriptMessagesByParticipantKeys(
        messages,
        new Set([TRANSCRIPT_SYSTEM_FILTER_KEY, transcriptParticipantFilterKey('b')])
      ).map((entry) => entry.id)
    ).toEqual(['user', 'participant-b', 'system'])
  })
})
