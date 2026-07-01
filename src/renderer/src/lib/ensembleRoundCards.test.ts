import { describe, expect, it } from 'vitest'
import {
  buildEnsembleRoundCardRows,
  ensembleRoundHeaderId,
  isEnsembleRoundHeaderMessage,
  readEnsembleRoundHeader
} from './ensembleRoundCards'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'

function message(
  id: string,
  overrides: Partial<ChatMessage> & {
    roundId?: string
    ensembleProvider?: string
    ensembleRole?: string
  } = {}
): ChatMessage {
  const { roundId, ensembleProvider, ensembleRole, ...rest } = overrides
  const metadata: Record<string, unknown> = { ...(rest.metadata as object) }
  if (roundId) metadata.ensembleRoundId = roundId
  if (ensembleProvider) metadata.ensembleProvider = ensembleProvider
  if (ensembleRole) metadata.ensembleRole = ensembleRole
  return {
    id,
    role: 'assistant',
    content: `body-${id}`,
    timestamp: '2026-05-27T12:00:00.000Z',
    ...rest,
    ...(Object.keys(metadata).length ? { metadata } : {})
  } as ChatMessage
}

function userPrompt(id: string, roundId: string, content = `prompt-${id}`): ChatMessage {
  return {
    id,
    role: 'user',
    content,
    timestamp: '2026-05-27T12:00:00.000Z',
    metadata: { kind: 'ensembleRoundPrompt', ensembleRoundId: roundId }
  } as ChatMessage
}

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'c1',
    title: 'Chat',
    provider: 'codex',
    chatKind: 'ensemble',
    messages: [],
    runs: [],
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
    ...overrides
  } as ChatRecord
}

const NO_OVERRIDES = new Map<string, boolean>()

describe('buildEnsembleRoundCardRows', () => {
  it('returns the same array reference for non-ensemble chats', () => {
    const display = [message('a'), message('b')]
    const result = buildEnsembleRoundCardRows({
      chat: chat({ chatKind: 'single' }),
      displayMessages: display,
      collapseOlderRounds: true,
      manualRoundExpansion: NO_OVERRIDES
    })
    expect(result).toBe(display)
  })

  it('returns the same array reference when the feature is disabled', () => {
    const display = [userPrompt('u1', 'r1'), message('a', { roundId: 'r1' })]
    const result = buildEnsembleRoundCardRows({
      chat: chat(),
      displayMessages: display,
      collapseOlderRounds: false,
      manualRoundExpansion: NO_OVERRIDES
    })
    expect(result).toBe(display)
  })

  it('keeps the active round flat with no header, collapses older rounds', () => {
    const display = [
      userPrompt('u1', 'r1'),
      message('a1', { roundId: 'r1', ensembleProvider: 'codex', ensembleRole: 'Planner' }),
      userPrompt('u2', 'r2'),
      message('a2', { roundId: 'r2', ensembleProvider: 'claude', ensembleRole: 'Worker' })
    ]
    const result = buildEnsembleRoundCardRows({
      chat: chat({
        ensemble: {
          enabled: true,
          maxParticipants: 4,
          participants: [],
          activeRound: {
            roundId: 'r2',
            status: 'running',
            prompt: '',
            startedAt: '',
            activeParticipantId: 'p1',
            participants: [
              {
                participantId: 'p1',
                provider: 'claude',
                role: 'Worker',
                order: 0,
                status: 'running'
              }
            ]
          } as never
        } as never
      }),
      displayMessages: display,
      collapseOlderRounds: true,
      manualRoundExpansion: NO_OVERRIDES
    })
    // r1 collapsed → just a header. r2 active → flat (prompt + body, no header).
    expect(result.map((m) => m.id)).toEqual([ensembleRoundHeaderId('r1'), 'u2', 'a2'])
    const header = result[0]
    expect(isEnsembleRoundHeaderMessage(header)).toBe(true)
    const data = readEnsembleRoundHeader(header)
    expect(data?.expanded).toBe(false)
    expect(data?.roundIndex).toBe(1)
    expect(data?.roundCount).toBe(2)
    expect(data?.providers).toEqual(['codex'])
    expect(data?.roles).toEqual(['Planner'])
    expect(data?.bodyMessageCount).toBe(1)
    expect(data?.promptPreview).toBe('prompt-u1')
  })

  it('expands the most-recent round by default when idle (no active round)', () => {
    const display = [
      userPrompt('u1', 'r1'),
      message('a1', { roundId: 'r1' }),
      userPrompt('u2', 'r2'),
      message('a2', { roundId: 'r2' })
    ]
    const result = buildEnsembleRoundCardRows({
      chat: chat({
        ensemble: {
          enabled: true,
          maxParticipants: 4,
          participants: []
        } as never
      }),
      displayMessages: display,
      collapseOlderRounds: true,
      manualRoundExpansion: NO_OVERRIDES
    })
    // r1 collapsed (header only); r2 latest → header + body expanded.
    expect(result.map((m) => m.id)).toEqual([
      ensembleRoundHeaderId('r1'),
      ensembleRoundHeaderId('r2'),
      'u2',
      'a2'
    ])
    expect(readEnsembleRoundHeader(result[0])?.expanded).toBe(false)
    expect(readEnsembleRoundHeader(result[1])?.expanded).toBe(true)
  })

  it('honours a manual expand override on an otherwise-collapsed round', () => {
    const display = [
      userPrompt('u1', 'r1'),
      message('a1', { roundId: 'r1' }),
      userPrompt('u2', 'r2'),
      message('a2', { roundId: 'r2' })
    ]
    const result = buildEnsembleRoundCardRows({
      chat: chat({
        ensemble: {
          enabled: true,
          maxParticipants: 4,
          participants: [],
          activeRound: {
            roundId: 'r2',
            status: 'running',
            prompt: '',
            startedAt: '',
            activeParticipantId: 'p1',
            participants: [
              {
                participantId: 'p1',
                provider: 'claude',
                role: 'Worker',
                order: 0,
                status: 'running'
              }
            ]
          } as never
        } as never
      }),
      displayMessages: display,
      collapseOlderRounds: true,
      manualRoundExpansion: new Map([['r1', true]])
    })
    expect(result.map((m) => m.id)).toEqual([ensembleRoundHeaderId('r1'), 'u1', 'a1', 'u2', 'a2'])
    expect(readEnsembleRoundHeader(result[0])?.expanded).toBe(true)
  })

  it('keeps the latest round flat when live run evidence exists but activeRound is stale', () => {
    const display = [
      userPrompt('u1', 'r1'),
      message('a1', { roundId: 'r1' }),
      userPrompt('u2', 'r2'),
      message('a2', { roundId: 'r2' })
    ]
    const result = buildEnsembleRoundCardRows({
      chat: chat({
        ensemble: {
          enabled: true,
          maxParticipants: 4,
          participants: [],
          activeRound: {
            roundId: 'r1',
            status: 'completed',
            prompt: '',
            startedAt: '',
            endedAt: ''
          } as never
        } as never
      }),
      displayMessages: display,
      collapseOlderRounds: true,
      manualRoundExpansion: NO_OVERRIDES,
      hasLiveRunEvidence: true
    })
    expect(result.map((m) => m.id)).toEqual([ensembleRoundHeaderId('r1'), 'u2', 'a2'])
    expect(readEnsembleRoundHeader(result[0])?.expanded).toBe(false)
  })

  it('honours a manual collapse override on the latest idle round', () => {
    const display = [userPrompt('u1', 'r1'), message('a1', { roundId: 'r1' })]
    const result = buildEnsembleRoundCardRows({
      chat: chat({
        ensemble: { enabled: true, maxParticipants: 4, participants: [] } as never
      }),
      displayMessages: display,
      collapseOlderRounds: true,
      manualRoundExpansion: new Map([['r1', false]])
    })
    expect(result.map((m) => m.id)).toEqual([ensembleRoundHeaderId('r1')])
    expect(readEnsembleRoundHeader(result[0])?.expanded).toBe(false)
  })

  it('passes through chats with no round-tagged messages', () => {
    const display = [message('s1', { role: 'system' }), message('s2', { role: 'system' })]
    const result = buildEnsembleRoundCardRows({
      chat: chat(),
      displayMessages: display,
      collapseOlderRounds: true,
      manualRoundExpansion: NO_OVERRIDES
    })
    expect(result).toBe(display)
  })

  it('keeps non-round messages inline alongside round headers', () => {
    const display = [
      message('preface', { role: 'system' }),
      userPrompt('u1', 'r1'),
      message('a1', { roundId: 'r1' })
    ]
    const result = buildEnsembleRoundCardRows({
      chat: chat({
        ensemble: { enabled: true, maxParticipants: 4, participants: [] } as never
      }),
      displayMessages: display,
      collapseOlderRounds: true,
      manualRoundExpansion: NO_OVERRIDES
    })
    // preface stays inline; r1 is the latest idle round → expanded.
    expect(result.map((m) => m.id)).toEqual(['preface', ensembleRoundHeaderId('r1'), 'u1', 'a1'])
  })
})
