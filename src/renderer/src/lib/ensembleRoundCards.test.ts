import { describe, expect, it } from 'vitest'
import {
  buildEnsembleRoundCardRows,
  buildEnsembleRoundCardRowsWithRanges,
  buildRoundTranscriptCopyText,
  captureSessionRoundExpansionForChat,
  ensembleRoundHeaderId,
  getSessionRoundExpansionSnapshot,
  hydrateSessionRoundExpansionForChat,
  isEnsembleRoundHeaderMessage,
  readEnsembleRoundHeader,
  roundExpansionForChat,
  setSessionRoundExpanded,
  subscribeSessionRoundExpansion,
  updateRoundExpansionForChat
} from './ensembleRoundCards'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { TASKWRAITH_CLOSEOUT_KIND } from '../../../shared/taskWraithCloseout'
import {
  isEnsembleFanoutViewportHeaderMessage,
  readEnsembleFanoutViewportHeader
} from './ensembleFanoutViewportGroups'

function message(
  id: string,
  overrides: Partial<ChatMessage> & {
    roundId?: string
    ensembleParticipantId?: string
    ensembleProvider?: string
    ensembleRole?: string
    ensembleModel?: string
  } = {}
): ChatMessage {
  const { roundId, ensembleParticipantId, ensembleProvider, ensembleRole, ensembleModel, ...rest } =
    overrides
  const metadata: Record<string, unknown> = { ...(rest.metadata as object) }
  if (roundId) metadata.ensembleRoundId = roundId
  if (ensembleParticipantId) metadata.ensembleParticipantId = ensembleParticipantId
  if (ensembleProvider) metadata.ensembleProvider = ensembleProvider
  if (ensembleRole) metadata.ensembleRole = ensembleRole
  if (ensembleModel) metadata.ensembleModel = ensembleModel
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

function closeout(id: string, roundId: string): ChatMessage {
  return {
    id,
    role: 'system',
    content: 'Worked for 1m',
    timestamp: '2026-05-27T12:01:00.000Z',
    metadata: {
      kind: TASKWRAITH_CLOSEOUT_KIND,
      closeoutScope: 'ensembleRound',
      closeoutRoundId: roundId
    }
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
    expect(data?.attributions).toEqual([
      {
        participantId: null,
        provider: 'codex',
        role: 'Planner',
        model: null
      }
    ])
    expect(data?.bodyMessageCount).toBe(1)
    expect(data?.promptPreview).toBe('prompt-u1')
  })

  it('keeps same-seat Pi speakers distinct by participant and model', () => {
    const display = [
      userPrompt('u1', 'r1'),
      message('pi-deepseek', {
        roundId: 'r1',
        ensembleParticipantId: 'pi-deepseek',
        ensembleProvider: 'pi',
        ensembleRole: 'Scout',
        ensembleModel: 'deepseek/deepseek-v4-pro'
      }),
      message('pi-mistral', {
        roundId: 'r1',
        ensembleParticipantId: 'pi-mistral',
        ensembleProvider: 'pi',
        ensembleRole: 'Reviewer',
        ensembleModel: 'mistral/devstral-2512'
      })
    ]
    const result = buildEnsembleRoundCardRows({
      chat: chat({
        ensemble: { enabled: true, maxParticipants: 4, participants: [] } as never
      }),
      displayMessages: display,
      collapseOlderRounds: true,
      manualRoundExpansion: new Map([['r1', false]])
    })

    expect(readEnsembleRoundHeader(result[0])?.attributions).toEqual([
      {
        participantId: 'pi-deepseek',
        provider: 'pi',
        role: 'Scout',
        model: 'deepseek/deepseek-v4-pro'
      },
      {
        participantId: 'pi-mistral',
        provider: 'pi',
        role: 'Reviewer',
        model: 'mistral/devstral-2512'
      }
    ])
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

  it('collapses the most-recent idle round once its closeout row exists', () => {
    const display = [
      userPrompt('u1', 'r1'),
      message('a1', { roundId: 'r1' }),
      closeout('closeout-r1', 'r1')
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

    expect(result.map((m) => m.id)).toEqual([ensembleRoundHeaderId('r1'), 'closeout-r1'])
    expect(readEnsembleRoundHeader(result[0])?.expanded).toBe(false)
  })

  it('retains completed-round fan-out lanes behind their own expandable viewport row', () => {
    const roundId = 'r-fanout'
    const fanoutLane = message('fanout-lane', {
      roundId,
      runId: 'run-fanout-lane',
      ensembleParticipantId: 'scout-1',
      ensembleProvider: 'codex',
      ensembleRole: 'Scout',
      ensembleModel: 'gpt-5.6-sol',
      metadata: {
        kind: 'ensembleParticipant',
        ensembleLaneId: 'lane-r-fanout-scout-1',
        ensembleLaneIntent: 'read',
        ensembleStageRole: 'scout'
      }
    })
    const display = [
      userPrompt('u-fanout', roundId),
      message('fanout-dispatch', {
        roundId,
        role: 'system',
        content: 'Scout fan-out · 1 read-only participants dispatched concurrently.',
        metadata: { kind: 'ensembleRoundStatus' }
      }),
      fanoutLane,
      closeout('closeout-fanout', roundId)
    ]
    const roundChat = chat({
      ensemble: { enabled: true, maxParticipants: 4, participants: [] } as never
    })

    const collapsed = buildEnsembleRoundCardRows({
      chat: roundChat,
      displayMessages: display,
      collapseOlderRounds: true,
      manualRoundExpansion: NO_OVERRIDES
    })
    expect(collapsed).toHaveLength(3)
    expect(collapsed[0].id).toBe(ensembleRoundHeaderId(roundId))
    expect(isEnsembleFanoutViewportHeaderMessage(collapsed[1])).toBe(true)
    expect(readEnsembleFanoutViewportHeader(collapsed[1])).toMatchObject({
      roundId,
      stage: 'scout',
      expanded: false,
      laneMessageIds: ['fanout-lane']
    })
    expect(collapsed[2].id).toBe('closeout-fanout')
    expect(collapsed.some((entry) => entry.id === fanoutLane.id)).toBe(false)

    const viewportId = collapsed[1].id
    const restored = buildEnsembleRoundCardRows({
      chat: roundChat,
      displayMessages: display,
      collapseOlderRounds: true,
      manualRoundExpansion: NO_OVERRIDES,
      expandedFanoutViewportIds: new Set([viewportId])
    })
    expect(restored.map((entry) => entry.id)).toEqual([
      ensembleRoundHeaderId(roundId),
      viewportId,
      fanoutLane.id,
      'closeout-fanout'
    ])
    expect(readEnsembleFanoutViewportHeader(restored[1])?.expanded).toBe(true)
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

  it('reports source ranges for collapsed headers and expanded body rows', () => {
    const display = [
      userPrompt('u1', 'r1'),
      message('a1', { roundId: 'r1' }),
      userPrompt('u2', 'r2'),
      message('a2', { roundId: 'r2' })
    ]
    const result = buildEnsembleRoundCardRowsWithRanges({
      chat: chat({
        ensemble: { enabled: true, maxParticipants: 4, participants: [] } as never
      }),
      displayMessages: display,
      collapseOlderRounds: true,
      manualRoundExpansion: NO_OVERRIDES
    })

    expect(result.map((entry) => [entry.message.id, entry.startIndex, entry.endIndex])).toEqual([
      [ensembleRoundHeaderId('r1'), 0, 2],
      [ensembleRoundHeaderId('r2'), 2, 4],
      ['u2', 2, 3],
      ['a2', 3, 4]
    ])
  })
})

describe('per-chat round expansion memory', () => {
  it('restores chat A overrides after visiting chat B without leaking between chats', () => {
    let cache = updateRoundExpansionForChat(new Map(), 'chat-a', 'round-1', true)
    cache = updateRoundExpansionForChat(cache, 'chat-b', 'round-9', false)

    expect(roundExpansionForChat(cache, 'chat-a')).toEqual(new Map([['round-1', true]]))
    expect(roundExpansionForChat(cache, 'chat-b')).toEqual(new Map([['round-9', false]]))
    expect(roundExpansionForChat(cache, 'chat-c')).toEqual(new Map())
  })

  it('updates one round immutably while preserving the other chat buckets', () => {
    const initial = new Map<string, Map<string, boolean>>([
      ['chat-a', new Map([['round-1', true]])],
      ['chat-b', new Map([['round-2', false]])]
    ])
    const next = updateRoundExpansionForChat(initial, 'chat-a', 'round-3', true)

    expect(next).not.toBe(initial)
    expect(next.get('chat-a')).toEqual(
      new Map([
        ['round-1', true],
        ['round-3', true]
      ])
    )
    expect(next.get('chat-b')).toEqual(new Map([['round-2', false]]))
    expect(initial.get('chat-a')).toEqual(new Map([['round-1', true]]))
  })

  it('keeps session disclosure state outside remounting transcript trees', () => {
    const chatA = 'remount-chat-a'
    const chatB = 'remount-chat-b'
    let notifications = 0
    const unsubscribe = subscribeSessionRoundExpansion(() => {
      notifications += 1
    })

    setSessionRoundExpanded(chatA, 'round-10', true)
    setSessionRoundExpanded(chatB, 'round-2', false)
    unsubscribe()

    const remountedSnapshot = getSessionRoundExpansionSnapshot()
    expect(roundExpansionForChat(remountedSnapshot, chatA)).toEqual(new Map([['round-10', true]]))
    expect(roundExpansionForChat(remountedSnapshot, chatB)).toEqual(new Map([['round-2', false]]))
    expect(notifications).toBe(2)
  })

  it('atomically replaces one chat disclosure bucket for a renderer handoff', () => {
    const targetChat = 'popout-transfer-target'
    const otherChat = 'popout-transfer-other'
    setSessionRoundExpanded(targetChat, 'stale-round', true)
    setSessionRoundExpanded(otherChat, 'other-round', false)
    let notifications = 0
    const unsubscribe = subscribeSessionRoundExpansion(() => {
      notifications += 1
    })

    expect(
      hydrateSessionRoundExpansionForChat(targetChat, [
        { roundId: 'round-1', expanded: true },
        { roundId: 'round-2', expanded: false }
      ])
    ).toBe(true)
    expect(notifications).toBe(1)
    expect(captureSessionRoundExpansionForChat(targetChat)).toEqual([
      { roundId: 'round-1', expanded: true },
      { roundId: 'round-2', expanded: false }
    ])
    expect(captureSessionRoundExpansionForChat(otherChat)).toEqual([
      { roundId: 'other-round', expanded: false }
    ])

    expect(hydrateSessionRoundExpansionForChat(targetChat, [])).toBe(true)
    expect(notifications).toBe(2)
    expect(captureSessionRoundExpansionForChat(targetChat)).toEqual([])
    expect(hydrateSessionRoundExpansionForChat(targetChat, [])).toBe(false)
    expect(notifications).toBe(2)
    unsubscribe()
  })
})

describe('buildRoundTranscriptCopyText', () => {
  it('joins non-empty round bodies and skips the synthetic Round N header', () => {
    const roundId = 'r1'
    const prompt = userPrompt('u1', roundId, 'Do the thing')
    const replyA = message('a1', {
      roundId,
      role: 'assistant',
      content: 'First reply',
      ensembleProvider: 'codex',
      ensembleRole: 'Worker'
    })
    const replyB = message('a2', {
      roundId,
      role: 'assistant',
      content: 'Second reply',
      ensembleProvider: 'claude',
      ensembleRole: 'Reviewer'
    })
    const empty = message('a3', { roundId, role: 'assistant', content: '' })
    const otherRound = message('a4', {
      roundId: 'r2',
      role: 'assistant',
      content: 'Other round'
    })
    const header = {
      id: ensembleRoundHeaderId(roundId),
      role: 'system' as const,
      content: '',
      timestamp: '2026-05-27T12:00:00.000Z',
      metadata: {
        kind: 'ensembleRoundHeader',
        ensembleRoundId: roundId,
        ensembleRoundHeader: {
          roundId,
          roundIndex: 1,
          roundCount: 2,
          expanded: false,
          providers: ['codex', 'claude'],
          roles: ['Worker', 'Reviewer'],
          attributions: [],
          bodyMessageCount: 2,
          summary: null,
          promptPreview: 'Do the thing'
        }
      }
    } as ChatMessage

    expect(
      buildRoundTranscriptCopyText([header, prompt, replyA, empty, replyB, otherRound], roundId)
    ).toBe('Do the thing\n\nFirst reply\n\nSecond reply')
  })

  it('returns an empty string when the round has no copyable bodies', () => {
    expect(buildRoundTranscriptCopyText([], 'missing')).toBe('')
    expect(
      buildRoundTranscriptCopyText(
        [message('a1', { roundId: 'r1', content: '' })],
        'r1'
      )
    ).toBe('')
  })
})
