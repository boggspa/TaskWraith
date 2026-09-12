import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatRecord, ProviderId, RunQueueJob } from '../../../main/store/types'
import type { HostSnapshot } from '../../../shared/hostProtocol'
import { HostProjectionStore } from '../lib/host/HostProjectionStore'
import type { HostProjectionState } from '../lib/host/HostProjectionStore'
import type { HostProjectedSnapshot } from '../lib/host/hostSnapshotProjection'
import { HostProjectionProvider } from './HostProjectionProvider'
import {
  ActiveRunsSection,
  deriveHostProjectionActiveRunEntries,
  deriveVisibleActiveRunEntries
} from './ActiveRunsSection'

function chat(provider: ProviderId, overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    provider,
    title: 'General',
    messages: [],
    runs: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as ChatRecord
}

function job(overrides: Partial<RunQueueJob> = {}): RunQueueJob {
  return {
    id: 'job-1',
    runId: 'run-1',
    provider: 'gemini',
    source: 'manual',
    status: 'active',
    priority: 0,
    attempt: 1,
    createdAt: '2026-09-12T03:00:00.000Z',
    updatedAt: '2026-09-12T03:00:00.000Z',
    ...overrides
  } as RunQueueJob
}

function projection(overrides: Partial<HostProjectedSnapshot> = {}): HostProjectedSnapshot {
  return {
    generation: 3,
    cursor: 42,
    generatedAt: '2026-09-12T03:20:00.000Z',
    freshness: 'live',
    health: { hostStatus: 'ok', supervised: true },
    workspaces: [],
    threads: [],
    runs: [],
    missions: [],
    rounds: [],
    participants: [],
    providers: [],
    questions: [],
    approvals: [],
    usage: { availability: 'unavailable' },
    warningCodes: [],
    counts: { runs: 0, missions: 0, rounds: 0, questions: 0, approvals: 0, warnings: 0 },
    ...overrides
  }
}

function liveState(projectionValue: HostProjectedSnapshot): HostProjectionState {
  return { status: 'live', projection: projectionValue }
}

function runningRound(overrides: Partial<HostProjectedSnapshot['rounds'][number]> = {}) {
  return {
    roundId: 'round-1',
    threadId: 'ensemble-chat',
    status: 'running' as const,
    startedAt: Date.parse('2026-09-12T03:20:23.000Z'),
    waves: [],
    participantIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
    providerRunIds: ['run-1'],
    ...overrides
  }
}

function runningRun(overrides: Partial<HostProjectedSnapshot['runs'][number]> = {}) {
  return {
    runId: 'run-1',
    threadId: 'ensemble-chat',
    providerId: 'claude',
    providerOutcome: 'running' as const,
    startedAt: Date.parse('2026-09-12T03:20:24.000Z'),
    ...overrides
  }
}

describe('deriveHostProjectionActiveRunEntries', () => {
  it('surfaces a live Host-owned round as one entry at thread granularity', () => {
    const ensemble = chat('claude', {
      appChatId: 'ensemble-chat',
      chatKind: 'ensemble',
      title: 'Release review'
    })
    const entries = deriveHostProjectionActiveRunEntries({
      hostProjection: liveState(projection({ rounds: [runningRound()] })),
      chats: [ensemble]
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.chat.appChatId).toBe('ensemble-chat')
    expect(entries[0]?.isHostProjection).toBe(true)
    expect(entries[0]?.hostRoundId).toBe('round-1')
    expect(entries[0]?.job.status).toBe('active')
    expect(entries[0]?.job.chatId).toBe('ensemble-chat')
  })

  it('keeps six participant runs of one round on a single row', () => {
    const ensemble = chat('claude', {
      appChatId: 'ensemble-chat',
      chatKind: 'ensemble',
      title: 'Release review'
    })
    const runs = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5', 'run-6'].map((runId) =>
      runningRun({ runId })
    )
    const entries = deriveHostProjectionActiveRunEntries({
      hostProjection: liveState(projection({ rounds: [runningRound()], runs })),
      chats: [ensemble]
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.hostRoundId).toBe('round-1')
  })

  it('surfaces a solo Host-dispatched run without a round as activity', () => {
    const solo = chat('codex', { appChatId: 'solo-chat', title: 'Solo task' })
    const entries = deriveHostProjectionActiveRunEntries({
      hostProjection: liveState(
        projection({ runs: [runningRun({ threadId: 'solo-chat', providerId: 'codex' })] })
      ),
      chats: [solo]
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.chat.appChatId).toBe('solo-chat')
    // No round backs this entry — there is no ensemble cancel to offer.
    expect(entries[0]?.hostRoundId).toBeUndefined()
  })

  it('ignores terminal rounds and runs', () => {
    const ensemble = chat('claude', { appChatId: 'ensemble-chat', chatKind: 'ensemble' })
    const entries = deriveHostProjectionActiveRunEntries({
      hostProjection: liveState(
        projection({
          rounds: [runningRound({ status: 'completed' }), runningRound({ status: 'cancelled' })],
          runs: [
            runningRun({ providerOutcome: 'completed' }),
            runningRun({ runId: 'run-2', providerOutcome: 'failed' })
          ]
        })
      ),
      chats: [ensemble]
    })

    expect(entries).toEqual([])
  })

  it('never paints a retained cache as live: unavailable and idle yield nothing', () => {
    const ensemble = chat('claude', { appChatId: 'ensemble-chat', chatKind: 'ensemble' })
    const retained = projection({ rounds: [runningRound()] })
    const unavailable: HostProjectionState = {
      status: 'unavailable',
      unavailableReason: 'host socket refused',
      projection: { ...retained, freshness: 'cached' }
    }

    expect(
      deriveHostProjectionActiveRunEntries({ hostProjection: unavailable, chats: [ensemble] })
    ).toEqual([])
    expect(
      deriveHostProjectionActiveRunEntries({
        hostProjection: { status: 'idle' },
        chats: [ensemble]
      })
    ).toEqual([])
    expect(
      deriveHostProjectionActiveRunEntries({ hostProjection: null, chats: [ensemble] })
    ).toEqual([])
  })

  it('treats a retained projection during loading as still-current', () => {
    const ensemble = chat('claude', {
      appChatId: 'ensemble-chat',
      chatKind: 'ensemble',
      title: 'Release review'
    })
    const entries = deriveHostProjectionActiveRunEntries({
      hostProjection: { status: 'loading', projection: projection({ rounds: [runningRound()] }) },
      chats: [ensemble]
    })

    expect(entries).toHaveLength(1)
  })

  it('projects a fan-out side chat run onto the parent thread', () => {
    const parent = chat('claude', {
      appChatId: 'ensemble-chat',
      chatKind: 'ensemble',
      title: 'Release review'
    })
    const lane = chat('claude', {
      appChatId: 'lane-chat',
      parentChatId: 'ensemble-chat',
      parentChatRelation: 'sideChat',
      sideChatContext: { mode: 'fanOut', createdAt: 0 }
    })
    const entries = deriveHostProjectionActiveRunEntries({
      hostProjection: liveState(projection({ runs: [runningRun({ threadId: 'lane-chat' })] })),
      chats: [parent, lane]
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.chat.appChatId).toBe('ensemble-chat')
  })

  it('skips threads the renderer does not hold rather than fabricating a chat', () => {
    const entries = deriveHostProjectionActiveRunEntries({
      hostProjection: liveState(projection({ rounds: [runningRound({ threadId: 'ghost' })] })),
      chats: []
    })

    expect(entries).toEqual([])
  })

  it('applies the same surface partitioning as queue-backed entries', () => {
    const workspaceChat = chat('claude', {
      appChatId: 'ensemble-chat',
      chatKind: 'ensemble',
      scope: 'workspace',
      workspaceId: 'ws-1'
    })
    const state = liveState(projection({ rounds: [runningRound()] }))

    expect(
      deriveHostProjectionActiveRunEntries({
        hostProjection: state,
        chats: [workspaceChat],
        surface: 'chat'
      })
    ).toEqual([])
    expect(
      deriveHostProjectionActiveRunEntries({
        hostProjection: state,
        chats: [workspaceChat],
        surface: 'code'
      })
    ).toHaveLength(1)
  })
})

describe('deriveVisibleActiveRunEntries · host projection merge', () => {
  it('merges queue-backed and Host-owned entries on different threads', () => {
    const queueChat = chat('gemini', { appChatId: 'queue-chat', title: 'Queue run' })
    const ensemble = chat('claude', {
      appChatId: 'ensemble-chat',
      chatKind: 'ensemble',
      title: 'Release review'
    })
    const entries = deriveVisibleActiveRunEntries({
      jobs: [job({ chatId: 'queue-chat' })],
      chats: [queueChat, ensemble],
      hostProjection: liveState(projection({ rounds: [runningRound()] }))
    })

    expect(entries.map((entry) => entry.chat.appChatId).sort()).toEqual([
      'ensemble-chat',
      'queue-chat'
    ])
  })

  it('never double-lists a thread covered by both a queue job and a Host round', () => {
    const ensemble = chat('claude', {
      appChatId: 'ensemble-chat',
      chatKind: 'ensemble',
      title: 'Release review'
    })
    const entries = deriveVisibleActiveRunEntries({
      jobs: [job({ chatId: 'ensemble-chat', status: 'active' })],
      chats: [ensemble],
      hostProjection: liveState(projection({ rounds: [runningRound()] }))
    })

    expect(entries).toHaveLength(1)
  })
})

function hostSnapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    protocolVersion: 1,
    projectionVersion: 1,
    generatedAt: '2026-09-12T03:20:30.000Z',
    generation: 3,
    cursor: 42,
    freshness: 'live',
    health: { hostStatus: 'ok', connectionPhase: 'live', supervised: true, freshness: 'live' },
    workspaces: [],
    threads: [],
    runs: [],
    missions: [],
    rounds: [],
    participants: [],
    providers: [],
    questions: [],
    approvals: [],
    schedules: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings: [],
    recovery: {},
    ...overrides
  } as unknown as HostSnapshot
}

async function renderSection(store: HostProjectionStore, chats: ChatRecord[]): Promise<string> {
  await store.refresh()
  return renderToStaticMarkup(
    <HostProjectionProvider store={store}>
      <ActiveRunsSection chats={chats} currentChat={null} onSelectChat={() => undefined} />
    </HostProjectionProvider>
  )
}

describe('ActiveRunsSection · Host-owned round rendering', () => {
  it('lists a live Host-owned round with a stop affordance instead of the empty state', async () => {
    const ensemble = chat('claude', {
      appChatId: 'ensemble-chat',
      chatKind: 'ensemble',
      title: 'Release review'
    })
    const store = new HostProjectionStore({
      fetchSnapshot: async () =>
        hostSnapshot({
          rounds: [
            {
              roundId: 'round-1',
              threadId: 'ensemble-chat',
              status: 'running',
              startedAt: Date.parse('2026-09-12T03:20:23.000Z'),
              participantIds: ['p1', 'p2'],
              providerRunIds: ['run-1']
            }
          ]
        })
    })

    const markup = await renderSection(store, [ensemble])

    expect(markup).toContain('Release review')
    expect(markup).toContain('sidebar-active-run-stop-action')
    expect(markup).toContain('Stop round')
    expect(markup).not.toContain('No active runs')
  })

  it('offers no killswitch for a round-less solo run entry', async () => {
    const solo = chat('codex', { appChatId: 'solo-chat', title: 'Solo task' })
    const store = new HostProjectionStore({
      fetchSnapshot: async () =>
        hostSnapshot({
          runs: [
            {
              runId: 'run-1',
              threadId: 'solo-chat',
              providerId: 'codex',
              providerOutcome: 'running',
              startedAt: Date.parse('2026-09-12T03:20:24.000Z')
            }
          ]
        })
    })

    const markup = await renderSection(store, [solo])

    expect(markup).toContain('Solo task')
    expect(markup).not.toContain('sidebar-active-run-stop-action')
    expect(markup).not.toContain('No active runs')
  })

  it('keeps the quiet empty state when no provider is mounted', () => {
    const markup = renderToStaticMarkup(
      <ActiveRunsSection chats={[]} currentChat={null} onSelectChat={() => undefined} />
    )

    expect(markup).toContain('No active runs')
    expect(markup).not.toContain('sidebar-active-run-stop-action')
  })
})
