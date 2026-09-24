import { describe, expect, it } from 'vitest'
import type { ChatListItem, ChatRecord, EnsembleConfig } from '../../../main/store/types'
import { projectRendererChatList, projectRendererChatListItem } from './rendererChatListProjection'

const LIST_PROJECTION_FLAG = '__chatListProjection'

function fullChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    provider: 'codex',
    title: 'Renderer residency',
    scope: 'workspace',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 10,
    archived: false,
    messages: [
      { id: 'message-1', role: 'user', content: 'Investigate', timestamp: '2026-01-01' },
      { id: 'message-2', role: 'assistant', content: 'Working', timestamp: '2026-01-01' }
    ],
    runs: [
      { runId: 'run-1', provider: 'codex', startedAt: '2026-01-01', status: 'success' },
      {
        runId: 'run-2',
        provider: 'claude',
        startedAt: '2026-01-02',
        requestedModel: 'claude-opus',
        status: 'running',
        runDiff: {
          runId: 'run-2',
          preSnapshot: { capturedAt: '2026-01-02', isGitRepo: true },
          createdFiles: [],
          modifiedFiles: [],
          deletedFiles: [],
          preExistingFiles: []
        }
      }
    ],
    persistenceRevision: 7,
    ...overrides
  }
}

function fullEnsemble(status: 'running' | 'completed' = 'running'): EnsembleConfig {
  return {
    enabled: true,
    maxParticipants: 20,
    participants: [
      {
        id: 'seat-1',
        provider: 'claude',
        enabled: true,
        role: 'Worker',
        instructions: 'A large private seat brief that must not enter the list.',
        order: 0
      }
    ],
    activeRound: {
      roundId: 'round-1',
      status,
      prompt: 'A large round prompt',
      startedAt: '2026-01-02',
      ...(status === 'completed' ? { endedAt: '2026-01-03' } : {}),
      participants: [
        {
          participantId: 'seat-1',
          provider: 'claude',
          role: 'Worker',
          order: 0,
          status: status === 'running' ? 'running' : 'answered'
        }
      ]
    },
    roundSummaries: {
      'round-0': {
        roundId: 'round-0',
        participantId: 'seat-1',
        provider: 'claude',
        summary: 'Historical summary',
        capturedAt: '2026-01-01'
      }
    },
    blackboard: [
      {
        id: 'blackboard-1',
        chatId: 'chat-1',
        roundId: 'round-1',
        participantId: 'seat-1',
        key: 'finding',
        value: 'Heavy shared context',
        category: 'fact',
        scope: 'chat',
        createdAt: '2026-01-02'
      }
    ],
    blackboardTombstones: [],
    wakeups: {},
    sessionActivityLedger: [
      {
        id: 'activity-1',
        timestamp: '2026-01-02',
        changedBy: 'system',
        scope: 'round'
      }
    ]
  }
}

function priorSummary(overrides: Partial<ChatListItem> = {}): ChatListItem {
  const ensemble = fullEnsemble('running') as EnsembleConfig & Record<string, unknown>
  delete ensemble.roundSummaries
  delete ensemble.blackboard
  delete ensemble.blackboardTombstones
  delete ensemble.wakeups
  delete ensemble.sessionActivityLedger
  ensemble.participants = ensemble.participants.map((participant) => ({
    ...participant,
    instructions: ''
  }))
  ensemble[LIST_PROJECTION_FLAG] = true
  return {
    ...fullChat({ messages: [], runs: [], ensemble }),
    summaryOnly: true,
    messageCount: 8,
    runCount: 4,
    lastRun: {
      runId: 'run-2',
      provider: 'claude',
      startedAt: '2026-01-02',
      requestedModel: 'claude-opus',
      status: 'starting'
    },
    runsSummary: [
      {
        runId: 'run-1',
        provider: 'codex',
        startedAt: '2026-01-01',
        diffFileCount: 2
      }
    ],
    searchText: 'renderer residency retained search text',
    searchPreview: 'retained search preview',
    sourceChatMtimeMs: 123,
    sourceChatSize: 456,
    ...overrides
  }
}

describe('projectRendererChatListItem', () => {
  it('keeps list-only metadata while updating counts and lean live status', () => {
    const sessionMemory = {
      modelId: 'llama3',
      updatedAt: 1,
      workingMemory: 'do-not-retain',
      toolTurnCount: 1
    }
    const canonical = fullChat({
      chatKind: 'ensemble',
      ensemble: fullEnsemble('completed'),
      ollamaSessionMemory: sessionMemory,
      ollamaSessionMemories: { llama3: sessionMemory }
    })
    const before = structuredClone(canonical)
    const previous = priorSummary()

    const projected = projectRendererChatListItem(canonical, previous)

    expect(projected).not.toBe(previous)
    expect(projected.summaryOnly).toBe(true)
    expect(projected.messages).toEqual([])
    expect(projected.runs).toEqual([])
    expect(projected.messageCount).toBe(2)
    expect(projected.runCount).toBe(2)
    expect(projected.lastRun).toMatchObject({
      runId: 'run-2',
      requestedModel: 'claude-opus',
      status: 'running'
    })
    expect(projected.lastRun).not.toHaveProperty('runDiff')
    expect(projected.runsSummary).toBe(previous.runsSummary)
    expect(projected.searchText).toBe(previous.searchText)
    expect(projected.searchPreview).toBe(previous.searchPreview)
    expect(projected.sourceChatMtimeMs).toBe(123)
    expect(projected.sourceChatSize).toBe(456)
    expect(projected.ensemble?.activeRound?.status).toBe('completed')
    expect(projected.ensemble?.participants[0]?.instructions).toBe('')
    expect(projected.ensemble?.roundSummaries).toBeUndefined()
    expect(projected.ensemble?.blackboard).toBeUndefined()
    expect(projected.ensemble?.sessionActivityLedger).toBeUndefined()
    expect((projected.ensemble as unknown as Record<string, unknown>)[LIST_PROJECTION_FLAG]).toBe(
      true
    )
    expect(projected).not.toHaveProperty('ollamaSessionMemory')
    expect(projected).not.toHaveProperty('ollamaSessionMemories')
    expect(canonical).toEqual(before)
  })

  it('returns the prior object for token-only and volatile-revision churn', () => {
    const first = projectRendererChatListItem(fullChat())
    const canonical = fullChat({
      updatedAt: 99,
      persistenceRevision: 8,
      messages: [
        { id: 'message-1', role: 'user', content: 'Investigate', timestamp: '2026-01-01' },
        {
          id: 'message-2',
          role: 'assistant',
          content: 'Working with many more streamed tokens',
          timestamp: '2026-01-01'
        }
      ]
    })

    expect(projectRendererChatListItem(canonical, first)).toBe(first)
  })

  it('publishes a fresh projection when a message count or run status changes', () => {
    const previous = projectRendererChatListItem(fullChat())
    const withMessage = fullChat({
      updatedAt: 11,
      persistenceRevision: 8,
      messages: [
        ...fullChat().messages,
        { id: 'message-3', role: 'tool', content: 'Done', timestamp: '2026-01-02' }
      ]
    })
    const countProjection = projectRendererChatListItem(withMessage, previous)

    expect(countProjection).not.toBe(previous)
    expect(countProjection.messageCount).toBe(3)
    expect(countProjection.updatedAt).toBe(11)
    expect(countProjection.persistenceRevision).toBe(8)

    const completed = fullChat({
      updatedAt: 12,
      persistenceRevision: 9,
      runs: [
        fullChat().runs[0],
        { ...fullChat().runs[1], status: 'success', endedAt: '2026-01-03' }
      ]
    })
    const statusProjection = projectRendererChatListItem(completed, countProjection)

    expect(statusProjection).not.toBe(countProjection)
    expect(statusProjection.lastRun).toMatchObject({
      runId: 'run-2',
      status: 'success',
      endedAt: '2026-01-03'
    })
    expect(statusProjection.runsSummary).toBe(countProjection.runsSummary)
  })

  it('reuses an unchanged lean ensemble object when another list field changes', () => {
    const canonical = fullChat({ chatKind: 'ensemble', ensemble: fullEnsemble('running') })
    const previous = projectRendererChatListItem(canonical)
    const renamed = projectRendererChatListItem(
      { ...canonical, title: 'Renamed', updatedAt: 20 },
      previous
    )

    expect(renamed).not.toBe(previous)
    expect(renamed.title).toBe('Renamed')
    expect(renamed.ensemble).toBe(previous.ensemble)
  })

  it('does not inherit list metadata from a different chat', () => {
    const unrelated = priorSummary({
      appChatId: 'other-chat',
      searchText: 'must not cross chat boundaries'
    })

    const projected = projectRendererChatListItem(fullChat(), unrelated)

    expect(projected).not.toBe(unrelated)
    expect(projected.appChatId).toBe('chat-1')
    expect(projected.searchText).toBeUndefined()
    expect(projected.runsSummary).toBeUndefined()
  })

  it('treats an incoming summary as complete authority for cleared optional fields', () => {
    const previous = priorSummary()
    const {
      searchPreview: _searchPreview,
      runsSummary: _runsSummary,
      lastRun: _lastRun,
      ensemble: _ensemble,
      sourceChatMtimeMs: _sourceChatMtimeMs,
      sourceChatSize: _sourceChatSize,
      ...withoutClearedFields
    } = previous
    const incoming = {
      ...withoutClearedFields,
      messages: [],
      runs: [],
      summaryOnly: true,
      messageCount: 0,
      runCount: 0,
      runsSummary: [],
      searchText: 'fresh authoritative search'
    } as ChatListItem

    const projected = projectRendererChatListItem(incoming, previous)

    expect(projected).not.toBe(previous)
    expect(projected.messageCount).toBe(0)
    expect(projected.runCount).toBe(0)
    expect(projected.searchText).toBe('fresh authoritative search')
    expect(projected.searchPreview).toBeUndefined()
    expect(projected.runsSummary).toEqual([])
    expect(projected.lastRun).toBeUndefined()
    expect(projected.ensemble).toBeUndefined()
    expect(projected.sourceChatMtimeMs).toBeUndefined()
    expect(projected.sourceChatSize).toBeUndefined()
  })

  it('keeps prior list metadata when projecting a full-chrome paged shell', () => {
    const previous = priorSummary()
    const shell = {
      ...fullChat({ messages: [], runs: [], title: 'Paged shell chrome' }),
      summaryOnly: true,
      transcriptPaged: true,
      messageCount: 42,
      runCount: 7,
      lastRun: {
        runId: 'run-7',
        provider: 'codex',
        startedAt: '2026-01-07',
        status: 'running'
      }
    } as ChatListItem & { transcriptPaged: true }

    const projected = projectRendererChatListItem(shell, previous)

    expect(projected.title).toBe('Paged shell chrome')
    expect(projected.messageCount).toBe(42)
    expect(projected.runCount).toBe(7)
    expect(projected.lastRun?.runId).toBe('run-7')
    expect(projected.searchText).toBe(previous.searchText)
    expect(projected.searchPreview).toBe(previous.searchPreview)
    expect(projected.runsSummary).toBe(previous.runsSummary)
    expect(projected.sourceChatMtimeMs).toBe(previous.sourceChatMtimeMs)
    expect(projected.sourceChatSize).toBe(previous.sourceChatSize)
    expect(projected).not.toHaveProperty('transcriptPaged')
  })

  it('keeps prior list metadata for a renderer LRU demotion', () => {
    const previous = priorSummary()
    const demoted = {
      ...fullChat({ messages: [], runs: [], title: 'Demoted chrome' }),
      summaryOnly: true,
      messageCount: 12,
      runCount: 5,
      lastRun: {
        runId: 'run-5',
        provider: 'claude',
        startedAt: '2026-01-05',
        status: 'success'
      }
    } as ChatListItem

    const projected = projectRendererChatListItem(demoted, previous)

    expect(projected.messageCount).toBe(12)
    expect(projected.runCount).toBe(5)
    expect(projected.lastRun?.runId).toBe('run-5')
    expect(projected.searchText).toBe(previous.searchText)
    expect(projected.searchPreview).toBe(previous.searchPreview)
    expect(projected.runsSummary).toBe(previous.runsSummary)
    expect(projected.sourceChatMtimeMs).toBe(previous.sourceChatMtimeMs)
    expect(projected.sourceChatSize).toBe(previous.sourceChatSize)
  })

  it('ignores changes confined to run detail and dropped ensemble blobs', () => {
    const canonical = fullChat({
      chatKind: 'ensemble',
      ensemble: fullEnsemble('running')
    })
    const previous = projectRendererChatListItem(canonical)
    const ensemble = structuredClone(canonical.ensemble!)
    ensemble.participants[0].instructions = 'A completely different private brief.'
    ensemble.blackboard![0].value = 'Different heavy shared context'
    ensemble.roundSummaries!['round-0'].summary = 'Different historical summary'
    const runs = structuredClone(canonical.runs)
    runs[1].stats = { rawToolBytes: 99_000_000 }
    runs[1].runDiff!.changeSetId = 'detail-only-change'

    const detailOnly = {
      ...canonical,
      updatedAt: 99,
      persistenceRevision: 8,
      ensemble,
      runs
    }

    expect(projectRendererChatListItem(detailOnly, previous)).toBe(previous)
  })
})

describe('projectRendererChatList', () => {
  it('keeps the entire list identity when every projected row is unchanged', () => {
    const first = projectRendererChatList([fullChat(), fullChat({ appChatId: 'chat-2' })])
    const streamed = [
      fullChat({
        updatedAt: 11,
        messages: [{ ...fullChat().messages[0], content: 'Longer' }, fullChat().messages[1]]
      }),
      fullChat({ appChatId: 'chat-2', updatedAt: 12 })
    ]

    expect(projectRendererChatList(streamed, first)).toBe(first)
  })

  it('returns a new ordered list while reusing unchanged rows on reorder and removal', () => {
    const first = projectRendererChatList([fullChat(), fullChat({ appChatId: 'chat-2' })])

    const reordered = projectRendererChatList(
      [fullChat({ appChatId: 'chat-2' }), fullChat()],
      first
    )
    expect(reordered).not.toBe(first)
    expect(reordered.map((chat) => chat.appChatId)).toEqual(['chat-2', 'chat-1'])
    expect(reordered[0]).toBe(first[1])
    expect(reordered[1]).toBe(first[0])

    const removed = projectRendererChatList([fullChat({ appChatId: 'chat-2' })], reordered)
    expect(removed).not.toBe(reordered)
    expect(removed).toEqual([reordered[0]])
  })
})
