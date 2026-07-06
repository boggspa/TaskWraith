import { describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_BROADCAST_METHODS,
  BridgeBroadcaster,
  chatRecordToSummary,
  workspaceRecordToSummary,
  type BridgeBroadcasterAppStore
} from './BridgeBroadcaster'
import { buildRemoteProjectionEnvelope, buildRemoteTaskCard } from './RemoteTaskProjection'
import { RemoteWorkspaceAllowlist } from './RemoteWorkspaceAllowlist'
import type { ChatRecord, WorkspaceRecord } from './store/types'

/** Build a stub AppStore that returns the supplied fixtures. The
 * broadcaster only calls `getWorkspaces`, `getChats`, `getChat` — no
 * mutators — so a frozen-in-time snapshot is sufficient. */
function makeFakeStore(
  workspaces: WorkspaceRecord[],
  chats: ChatRecord[]
): BridgeBroadcasterAppStore {
  return {
    getWorkspaces: () => workspaces,
    getChats: (workspaceId?: string) =>
      workspaceId ? chats.filter((c) => c.workspaceId === workspaceId) : chats,
    getChat: (chatId: string) => chats.find((c) => c.appChatId === chatId) ?? null
  }
}

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  const now = Date.UTC(2026, 4, 15, 12, 0, 0)
  return {
    id: 'workspace-1',
    path: '/tmp/projects/alpha',
    displayName: 'alpha',
    createdAt: now,
    lastOpenedAt: now,
    pinned: false,
    ...overrides
  }
}

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  const now = Date.UTC(2026, 4, 15, 12, 0, 0)
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    provider: 'gemini',
    title: 'Plan refactor',
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/projects/alpha',
    createdAt: now,
    updatedAt: now,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

function makeAllowlist(workspaceIds: string[]): RemoteWorkspaceAllowlist {
  const allowlist = new RemoteWorkspaceAllowlist({ now: () => 1000 })
  for (const workspaceId of workspaceIds) {
    allowlist.upsert({
      workspaceId,
      path: `/tmp/projects/${workspaceId}`,
      mode: 'read-write',
      allowedProviders: ['gemini', 'codex', 'claude', 'kimi'],
      allowedApprovalModes: ['default', 'plan']
    })
  }
  return allowlist
}

describe('workspaceRecordToSummary', () => {
  it('produces a summary with chat + running chat counts', () => {
    const ws = makeWorkspace()
    const chats: ChatRecord[] = [
      makeChat({ appChatId: 'chat-a' }),
      makeChat({
        appChatId: 'chat-b',
        runs: [
          {
            runId: 'run-b1',
            startedAt: '2026-05-15T12:00:00.000Z',
            status: 'running'
          }
        ]
      }),
      // Chat in a DIFFERENT workspace must not be counted.
      makeChat({ appChatId: 'chat-other', workspaceId: 'workspace-zzz' })
    ]
    const summary = workspaceRecordToSummary(ws, chats)
    expect(summary).toEqual({
      workspaceId: 'workspace-1',
      displayName: 'alpha',
      path: '/tmp/projects/alpha',
      chatCount: 2,
      runningChatCount: 1,
      pinned: false,
      lastActivityAt: new Date(ws.lastOpenedAt).toISOString()
    })
  })

  it('falls back to path when displayName is empty', () => {
    const ws = makeWorkspace({ displayName: '' })
    const summary = workspaceRecordToSummary(ws, [])
    expect(summary.displayName).toBe(ws.path)
  })

  it('omits lastActivityAt when lastOpenedAt is non-positive', () => {
    const ws = makeWorkspace({ lastOpenedAt: 0 })
    const summary = workspaceRecordToSummary(ws, [])
    expect(summary.lastActivityAt).toBeUndefined()
  })

  it('produces zero counts when no chats belong to the workspace', () => {
    const summary = workspaceRecordToSummary(makeWorkspace(), [])
    expect(summary.chatCount).toBe(0)
    expect(summary.runningChatCount).toBe(0)
  })
})

describe('chatRecordToSummary', () => {
  it('produces a summary for an idle chat', () => {
    const chat = makeChat({ provider: 'claude' })
    const summary = chatRecordToSummary(chat)
    expect(summary).toEqual({
      chatId: 'chat-1',
      title: 'Plan refactor',
      workspaceId: 'workspace-1',
      provider: 'claude',
      chatKind: 'single',
      status: 'idle',
      pinned: false,
      lastMessageAt: new Date(chat.updatedAt).toISOString()
    })
  })

  it('reports ensemble chatKind when the record is an Ensemble chat', () => {
    const chat = makeChat({ chatKind: 'ensemble' })
    expect(chatRecordToSummary(chat).chatKind).toBe('ensemble')
  })

  it('keeps ensemble chatKind for canonical provider claude (not provider=ensemble)', () => {
    const chat = makeChat({ chatKind: 'ensemble', provider: 'claude' })
    const summary = chatRecordToSummary(chat)
    expect(summary.chatKind).toBe('ensemble')
    expect(summary.provider).toBe('claude')
  })

  it('infers ensemble chatKind from legacy ensemble config when chatKind is missing', () => {
    const chat = makeChat({
      chatKind: undefined,
      provider: 'claude',
      ensemble: {
        enabled: true,
        maxParticipants: 2,
        participants: [
          { id: 'p1', provider: 'claude', role: 'Planner', order: 0, enabled: true, instructions: '' }
        ]
      }
    })
    expect(chatRecordToSummary(chat).chatKind).toBe('ensemble')
  })

  it('defaults missing chatKind to single when no ensemble config exists', () => {
    const chat = makeChat({ chatKind: undefined })
    expect(chatRecordToSummary(chat).chatKind).toBe('single')
  })

  it('reports running status when the latest run is still running', () => {
    const chat = makeChat({
      runs: [
        { runId: 'r1', startedAt: '2026-05-15T11:00:00Z', status: 'success' },
        { runId: 'r2', startedAt: '2026-05-15T12:00:00Z', status: 'running' }
      ]
    })
    expect(chatRecordToSummary(chat).status).toBe('running')
  })

  it('does not pin running when only an older orphan run is still marked running', () => {
    const chat = makeChat({
      runs: [
        { runId: 'stale', startedAt: '2026-05-10T11:00:00Z', status: 'running' },
        { runId: 'latest', startedAt: '2026-05-15T12:00:00Z', status: 'success' }
      ]
    })
    const summary = chatRecordToSummary(chat)
    const card = buildRemoteTaskCard(chat)
    expect(summary.status).toBe('success')
    expect(card.status).toBe('success')
  })

  it('keeps ensemble thread-list status running while the round is live', () => {
    const chat = makeChat({
      chatKind: 'ensemble',
      provider: 'claude',
      runs: [
        { runId: 'p1-run', startedAt: '2026-05-30T12:00:00.000Z', status: 'success' }
      ],
      ensemble: {
        enabled: true,
        maxParticipants: 2,
        participants: [],
        activeRound: {
          roundId: 'round-1',
          status: 'running',
          prompt: 'Coordinate',
          startedAt: '2026-05-30T12:00:00.000Z',
          activeParticipantId: 'p2',
          participants: [
            {
              participantId: 'p1',
              provider: 'codex',
              role: 'Implementer',
              order: 1,
              status: 'answered',
              runId: 'p1-run'
            },
            {
              participantId: 'p2',
              provider: 'claude',
              role: 'Reviewer',
              order: 2,
              status: 'idle'
            }
          ]
        }
      }
    })
    const summary = chatRecordToSummary(chat)
    const card = buildRemoteTaskCard(chat)
    expect(summary.chatKind).toBe('ensemble')
    expect(summary.status).toBe('running')
    expect(card.status).toBe('running')
  })

  it('reports success for a stale inactive ensemble round instead of orphan running', () => {
    const chat = makeChat({
      chatKind: 'ensemble',
      runs: [{ runId: 'run-1', startedAt: '2026-05-30T12:00:00.000Z', status: 'success' }],
      ensemble: {
        enabled: true,
        maxParticipants: 2,
        participants: [],
        activeRound: {
          roundId: 'round-1',
          status: 'running',
          prompt: 'Coordinate',
          startedAt: '2026-05-30T12:00:00.000Z',
          activeParticipantId: 'p1',
          participants: [
            {
              participantId: 'p1',
              provider: 'codex',
              role: 'Implementer',
              order: 1,
              status: 'answered',
              runId: 'run-1',
              endedAt: '2026-05-30T12:00:00.000Z'
            }
          ]
        }
      }
    })
    const summary = chatRecordToSummary(chat)
    const card = buildRemoteTaskCard(chat)
    expect(summary.status).toBe('success')
    expect(card.status).toBe('success')
  })

  it('includes the latest running run id and stable start time', () => {
    const chat = makeChat({
      runs: [
        { runId: 'older', startedAt: '2026-05-15T11:00:00Z', status: 'running' },
        { runId: 'newer', startedAt: '2026-05-15T12:00:00Z', status: 'running' }
      ]
    })
    expect(chatRecordToSummary(chat)).toMatchObject({
      runId: 'newer',
      runStartedAt: '2026-05-15T12:00:00.000Z'
    })
  })

  it('forwards parent and pinned metadata for sub-thread rendering', () => {
    const chat = makeChat({
      parentChatId: 'parent-1',
      pinned: true
    })
    expect(chatRecordToSummary(chat)).toMatchObject({
      parentChatId: 'parent-1',
      pinned: true
    })
  })

  it('collapses success_with_warnings to success', () => {
    const chat = makeChat({
      runs: [{ runId: 'r1', startedAt: '2026-05-15T12:00:00Z', status: 'success_with_warnings' }]
    })
    expect(chatRecordToSummary(chat).status).toBe('success')
  })

  it('collapses cancelled to failed', () => {
    const chat = makeChat({
      runs: [{ runId: 'r1', startedAt: '2026-05-15T12:00:00Z', status: 'cancelled' }]
    })
    expect(chatRecordToSummary(chat).status).toBe('failed')
  })

  it('picks the most recently started run when there are multiple completed runs', () => {
    const chat = makeChat({
      runs: [
        { runId: 'r1', startedAt: '2026-05-15T11:00:00Z', status: 'failed' },
        { runId: 'r2', startedAt: '2026-05-15T12:00:00Z', status: 'success' }
      ]
    })
    expect(chatRecordToSummary(chat).status).toBe('success')
  })

  it('returns workspaceId=null for global chats', () => {
    const chat = makeChat({ scope: 'global', workspaceId: undefined, workspacePath: undefined })
    const summary = chatRecordToSummary(chat)
    expect(summary.workspaceId).toBeNull()
  })

  it('returns workspaceId=null when workspaceId is an empty string', () => {
    const chat = makeChat({ workspaceId: '' })
    const summary = chatRecordToSummary(chat)
    expect(summary.workspaceId).toBeNull()
  })

  it('falls back to gemini when provider is missing on legacy records', () => {
    const chat = makeChat({ provider: undefined })
    const summary = chatRecordToSummary(chat)
    expect(summary.provider).toBe('gemini')
  })

  it('substitutes a placeholder title when the chat has none', () => {
    const chat = makeChat({ title: '' })
    expect(chatRecordToSummary(chat).title).toBe('Untitled chat')
  })

  it('bounds summary titles without storing UI ellipses', () => {
    const summary = chatRecordToSummary(makeChat({ title: `Plan ${'rename '.repeat(40)}` }))
    expect(summary.title).toHaveLength(160)
    expect(summary.title.endsWith('...')).toBe(false)
  })

  it('preserves each provider id verbatim', () => {
    for (const provider of ['gemini', 'codex', 'claude', 'kimi'] as const) {
      const summary = chatRecordToSummary(makeChat({ provider }))
      expect(summary.provider).toBe(provider)
    }
  })
})

describe('BridgeBroadcaster', () => {
  it('broadcastWorkspaceList calls daemon.notify exactly once with the right shape', () => {
    const notify = vi.fn()
    const store = makeFakeStore(
      [
        makeWorkspace({ id: 'ws-1' }),
        makeWorkspace({ id: 'ws-2', path: '/tmp/b', displayName: 'b' })
      ],
      [makeChat({ workspaceId: 'ws-1' })]
    )
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      now: () => 1000
    })
    broadcaster.broadcastWorkspaceList()
    expect(notify).toHaveBeenCalledTimes(1)
    const [method, params] = notify.mock.calls[0]
    expect(method).toBe(BRIDGE_BROADCAST_METHODS.workspaceList)
    expect((params as { workspaces: unknown[] }).workspaces).toHaveLength(2)
    expect(
      (params as { workspaces: Array<{ workspaceId: string; chatCount: number }> }).workspaces[0]
    ).toMatchObject({
      workspaceId: 'ws-1',
      chatCount: 1
    })
  })

  it('broadcastThreadList emits the bridge.broadcastThreadList method with all chats', () => {
    const notify = vi.fn()
    const store = makeFakeStore(
      [makeWorkspace()],
      [
        makeChat({ appChatId: 'chat-a' }),
        makeChat({ appChatId: 'chat-b', scope: 'global', workspaceId: undefined })
      ]
    )
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      now: () => 1000
    })
    broadcaster.broadcastThreadList()
    expect(notify).toHaveBeenCalledTimes(1)
    const [method, params] = notify.mock.calls[0]
    expect(method).toBe(BRIDGE_BROADCAST_METHODS.threadList)
    const threads = (params as { threads: Array<{ chatId: string; workspaceId: string | null }> })
      .threads
    expect(threads).toHaveLength(2)
    expect(threads[1].workspaceId).toBeNull()
  })

  it('broadcastWorkspaceUpdated emits a single workspace summary', () => {
    const notify = vi.fn()
    const ws = makeWorkspace({ id: 'ws-update' })
    const store = makeFakeStore([ws], [makeChat({ workspaceId: 'ws-update' })])
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      now: () => 1000
    })
    broadcaster.broadcastWorkspaceUpdated('ws-update')
    expect(notify).toHaveBeenCalledTimes(1)
    const [method, params] = notify.mock.calls[0]
    expect(method).toBe(BRIDGE_BROADCAST_METHODS.workspaceUpdated)
    expect((params as { workspace: { workspaceId: string } }).workspace.workspaceId).toBe(
      'ws-update'
    )
  })

  it('broadcastProviderModels ships the caller-assembled catalog (throttled)', () => {
    const notify = vi.fn()
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: makeFakeStore([], []),
      now: () => 1000
    })
    const message = {
      providers: [
        {
          provider: 'claude',
          models: [{ id: 'claude-fable-5', label: 'Claude Fable 5', isDefault: true }]
        }
      ]
    }
    broadcaster.broadcastProviderModels(message)
    broadcaster.broadcastProviderModels(message) // throttled — same tick
    expect(notify).toHaveBeenCalledTimes(1)
    const [method, params] = notify.mock.calls[0]
    expect(method).toBe(BRIDGE_BROADCAST_METHODS.providerModels)
    expect(params).toEqual(message)
  })

  it('broadcastFirstLaunchState ships the caller-assembled redacted state', () => {
    const notify = vi.fn()
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: makeFakeStore([], []),
      now: () => 1000
    })
    const message = {
      state: {
        schemaVersion: 1,
        generatedAt: '2026-06-21T18:02:00.000Z',
        providerCards: [],
        notifications: []
      }
    }
    broadcaster.broadcastFirstLaunchState(message)
    expect(notify).toHaveBeenCalledTimes(1)
    const [method, params] = notify.mock.calls[0]
    expect(method).toBe(BRIDGE_BROADCAST_METHODS.firstLaunchState)
    expect(params).toEqual(message)
  })

  it('canonicalChatWorkspaceId rescues legacy display-name chat ids in lists + counts', () => {
    const notify = vi.fn()
    // One chat keyed by uuid, one by the legacy display-name convention.
    const store = makeFakeStore(
      [makeWorkspace({ id: 'uuid-3', displayName: 'Test 3', path: '/Users/x/Test 3' })],
      [
        makeChat({ appChatId: 'chat-uuid', workspaceId: 'uuid-3' }),
        makeChat({ appChatId: 'chat-legacy', workspaceId: 'Test 3' })
      ]
    )
    const canonical = (id: string | null | undefined): string | null =>
      id === 'Test 3' || id === 'uuid-3' ? 'uuid-3' : null
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      allowlist: makeAllowlist(['uuid-3']),
      canonicalChatWorkspaceId: canonical,
      now: () => 1000
    })
    broadcaster.broadcastWorkspaceList()
    const workspaces = (
      notify.mock.calls[0][1] as { workspaces: Array<{ workspaceId: string; chatCount: number }> }
    ).workspaces
    expect(workspaces[0]).toMatchObject({ workspaceId: 'uuid-3', chatCount: 2 })

    broadcaster.resetThrottle()
    notify.mockClear()
    broadcaster.broadcastThreadList()
    const threads = (
      notify.mock.calls[0][1] as { threads: Array<{ chatId: string; workspaceId: string | null }> }
    ).threads
    expect(threads).toHaveLength(2)
    expect(threads.map((t) => t.workspaceId)).toEqual(['uuid-3', 'uuid-3'])

    // Without the canonicalizer the legacy chat vanishes — the regression shape.
    const bare = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      allowlist: makeAllowlist(['uuid-3']),
      now: () => 1000
    })
    notify.mockClear()
    bare.broadcastWorkspaceList()
    const bareWorkspaces = (
      notify.mock.calls[0][1] as { workspaces: Array<{ chatCount: number }> }
    ).workspaces
    expect(bareWorkspaces[0].chatCount).toBe(1)
  })

  it('broadcastWorkspaceUpdated silently no-ops when the workspace is missing', () => {
    const notify = vi.fn()
    const log = vi.fn()
    const store = makeFakeStore([], [])
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      now: () => 1000,
      log
    })
    broadcaster.broadcastWorkspaceUpdated('does-not-exist')
    expect(notify).not.toHaveBeenCalled()
    expect(log.mock.calls.map((c) => c[0] as string).join('\n')).toContain('not found')
  })

  it('broadcastThreadUpdated silently no-ops when the chat is missing', () => {
    const notify = vi.fn()
    const store = makeFakeStore([], [])
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      now: () => 1000
    })
    broadcaster.broadcastThreadUpdated('chat-not-here')
    expect(notify).not.toHaveBeenCalled()
  })

  it('broadcastThreadUpdated emits a single thread summary', () => {
    const notify = vi.fn()
    const chat = makeChat({ appChatId: 'chat-x' })
    const store = makeFakeStore([makeWorkspace()], [chat])
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      now: () => 1000
    })
    broadcaster.broadcastThreadUpdated('chat-x')
    expect(notify).toHaveBeenCalledTimes(1)
    const [method, params] = notify.mock.calls[0]
    expect(method).toBe(BRIDGE_BROADCAST_METHODS.threadUpdated)
    expect((params as { thread: { chatId: string } }).thread.chatId).toBe('chat-x')
  })

  it('throttles two rapid same-method calls into one emit', () => {
    const notify = vi.fn()
    const store = makeFakeStore([makeWorkspace()], [])
    let nowMs = 1000
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      now: () => nowMs,
      throttleMs: 1000
    })
    broadcaster.broadcastWorkspaceList()
    nowMs += 100 // Within throttle window.
    broadcaster.broadcastWorkspaceList()
    expect(notify).toHaveBeenCalledTimes(1)
    nowMs += 901 // Now strictly outside the window.
    broadcaster.broadcastWorkspaceList()
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('throttles per-id for update broadcasts (different chats slip through, same chat does not)', () => {
    const notify = vi.fn()
    const store = makeFakeStore(
      [makeWorkspace()],
      [makeChat({ appChatId: 'chat-1' }), makeChat({ appChatId: 'chat-2' })]
    )
    const nowMs = 1000
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      now: () => nowMs,
      throttleMs: 1000
    })
    broadcaster.broadcastThreadUpdated('chat-1')
    broadcaster.broadcastThreadUpdated('chat-1') // Throttled — same id.
    broadcaster.broadcastThreadUpdated('chat-2') // Allowed — different id.
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('emits empty arrays when AppStore has no workspaces or chats', () => {
    const notify = vi.fn()
    const store = makeFakeStore([], [])
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      now: () => 1000
    })
    broadcaster.broadcastWorkspaceList()
    broadcaster.broadcastThreadList()
    expect(notify).toHaveBeenNthCalledWith(1, BRIDGE_BROADCAST_METHODS.workspaceList, {
      workspaces: []
    })
    expect(notify).toHaveBeenNthCalledWith(2, BRIDGE_BROADCAST_METHODS.threadList, { threads: [] })
  })

  it('broadcastSnapshot fires both list broadcasts', () => {
    const notify = vi.fn()
    const store = makeFakeStore([makeWorkspace()], [makeChat()])
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      now: () => 1000
    })
    broadcaster.broadcastSnapshot()
    const methods = notify.mock.calls.map((call) => call[0])
    expect(methods).toEqual([
      BRIDGE_BROADCAST_METHODS.workspaceList,
      BRIDGE_BROADCAST_METHODS.threadList
    ])
  })

  it('broadcastRemoteProjection emits a single projection envelope', () => {
    const notify = vi.fn()
    const store = makeFakeStore([makeWorkspace()], [makeChat()])
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      now: () => 1000
    })
    const envelope = buildRemoteProjectionEnvelope({
      kind: 'questionCard',
      payload: { promptId: 'q1' },
      generatedAt: '2026-05-30T12:00:00.000Z',
      envelopeId: 'env-q1'
    })

    broadcaster.broadcastRemoteProjection(envelope)

    expect(notify).toHaveBeenCalledWith(BRIDGE_BROADCAST_METHODS.remoteProjection, { envelope })
  })

  it('skips a single remote projection envelope over the byte budget', () => {
    const notify = vi.fn()
    const store = makeFakeStore([makeWorkspace()], [makeChat()])
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      remoteProjectionEnvelopeMaxBytes: 1,
      now: () => 1000
    })
    const envelope = buildRemoteProjectionEnvelope({
      kind: 'questionCard',
      payload: { promptId: 'q1' },
      generatedAt: '2026-05-30T12:00:00.000Z',
      envelopeId: 'env-q1'
    })

    expect(broadcaster.broadcastRemoteProjection(envelope)).toBe(false)

    expect(notify).not.toHaveBeenCalled()
  })

  it('broadcastSnapshot includes remote projection snapshots when a source is configured', () => {
    const notify = vi.fn()
    const store = makeFakeStore([makeWorkspace()], [makeChat()])
    const envelope = buildRemoteProjectionEnvelope({
      kind: 'taskFeedSnapshot',
      payload: { tasks: [] },
      generatedAt: '2026-05-30T12:00:00.000Z',
      envelopeId: 'env-feed'
    })
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      projectionSource: {
        listRemoteProjectionEnvelopes: () => [envelope]
      },
      now: () => 1000
    })

    broadcaster.broadcastSnapshot()

    expect(notify.mock.calls.map((call) => call[0])).toEqual([
      BRIDGE_BROADCAST_METHODS.workspaceList,
      BRIDGE_BROADCAST_METHODS.threadList,
      BRIDGE_BROADCAST_METHODS.remoteProjectionSnapshot
    ])
    expect(notify).toHaveBeenLastCalledWith(BRIDGE_BROADCAST_METHODS.remoteProjectionSnapshot, {
      projections: [envelope]
    })
  })

  it('fans out oversized remote projection snapshots as single envelopes', () => {
    const notify = vi.fn()
    const store = makeFakeStore([makeWorkspace()], [makeChat()])
    const first = buildRemoteProjectionEnvelope({
      kind: 'questionCard',
      payload: { promptId: 'q1' },
      generatedAt: '2026-05-30T12:00:00.000Z',
      envelopeId: 'env-q1'
    })
    const second = buildRemoteProjectionEnvelope({
      kind: 'approvalCard',
      payload: { requestId: 'a1' },
      generatedAt: '2026-05-30T12:00:01.000Z',
      envelopeId: 'env-a1'
    })
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      projectionSource: {
        listRemoteProjectionEnvelopes: () => [first, second]
      },
      remoteProjectionSnapshotMaxBytes: 1,
      now: () => 1000
    })

    broadcaster.broadcastSnapshot()

    expect(notify.mock.calls.map((call) => call[0])).toEqual([
      BRIDGE_BROADCAST_METHODS.workspaceList,
      BRIDGE_BROADCAST_METHODS.threadList,
      BRIDGE_BROADCAST_METHODS.remoteProjection,
      BRIDGE_BROADCAST_METHODS.remoteProjection
    ])
    expect(notify).toHaveBeenNthCalledWith(3, BRIDGE_BROADCAST_METHODS.remoteProjection, {
      envelope: first
    })
    expect(notify).toHaveBeenNthCalledWith(4, BRIDGE_BROADCAST_METHODS.remoteProjection, {
      envelope: second
    })
  })

  it('filters workspace and thread lists through the remote allowlist', () => {
    const notify = vi.fn()
    const store = makeFakeStore(
      [
        makeWorkspace({ id: 'ws-visible' }),
        makeWorkspace({ id: 'ws-hidden', path: '/tmp/projects/hidden' })
      ],
      [
        makeChat({ appChatId: 'chat-visible', workspaceId: 'ws-visible' }),
        makeChat({ appChatId: 'chat-hidden', workspaceId: 'ws-hidden' }),
        makeChat({ appChatId: 'chat-global', scope: 'global', workspaceId: undefined })
      ]
    )
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      allowlist: makeAllowlist(['ws-visible']),
      now: () => 1000
    })

    broadcaster.broadcastWorkspaceList()
    broadcaster.broadcastThreadList()

    expect(notify).toHaveBeenNthCalledWith(1, BRIDGE_BROADCAST_METHODS.workspaceList, {
      workspaces: [
        expect.objectContaining({
          workspaceId: 'ws-visible'
        })
      ]
    })
    // T71 — scope-global chats pass through (read-only, workspaceId null)
    // once at least one real workspace is allowlisted; chats in
    // NON-allowlisted workspaces stay hidden.
    expect(notify).toHaveBeenNthCalledWith(2, BRIDGE_BROADCAST_METHODS.threadList, {
      threads: [
        expect.objectContaining({
          chatId: 'chat-visible',
          workspaceId: 'ws-visible'
        }),
        expect.objectContaining({
          chatId: 'chat-global',
          workspaceId: null
        })
      ]
    })
  })

  it('keeps global chats hidden while the allowlist is empty (blank slate)', () => {
    const notify = vi.fn()
    const store = makeFakeStore(
      [],
      [makeChat({ appChatId: 'chat-global', scope: 'global', workspaceId: undefined })]
    )
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      allowlist: makeAllowlist([]),
      now: () => 1000
    })

    broadcaster.broadcastThreadList()
    expect(notify).toHaveBeenCalledWith(BRIDGE_BROADCAST_METHODS.threadList, { threads: [] })
  })

  it('skips single update broadcasts for disallowed workspaces and chats', () => {
    const notify = vi.fn()
    const store = makeFakeStore(
      [makeWorkspace({ id: 'ws-hidden' })],
      [makeChat({ appChatId: 'chat-hidden', workspaceId: 'ws-hidden' })]
    )
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      allowlist: makeAllowlist(['ws-visible']),
      now: () => 1000
    })

    broadcaster.broadcastWorkspaceUpdated('ws-hidden')
    broadcaster.broadcastThreadUpdated('chat-hidden')

    expect(notify).not.toHaveBeenCalled()
  })

  it('swallows notify errors and clears the throttle so the next attempt can retry', () => {
    const notify = vi.fn(() => {
      throw new Error('daemon stdin closed')
    })
    const log = vi.fn()
    const store = makeFakeStore([makeWorkspace()], [])
    let nowMs = 1000
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      log,
      now: () => nowMs,
      throttleMs: 1000
    })
    expect(() => broadcaster.broadcastWorkspaceList()).not.toThrow()
    expect(log.mock.calls.map((c) => c[0] as string).join('\n')).toContain('notify failed')
    // Throttle was rolled back, so an immediate retry should attempt again.
    nowMs += 1
    broadcaster.broadcastWorkspaceList()
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('resetThrottle allows immediate re-emit', () => {
    const notify = vi.fn()
    const store = makeFakeStore([makeWorkspace()], [])
    const nowMs = 1000
    const broadcaster = new BridgeBroadcaster({
      daemon: { notify },
      appStore: store,
      now: () => nowMs,
      throttleMs: 5000
    })
    broadcaster.broadcastWorkspaceList()
    broadcaster.broadcastWorkspaceList()
    expect(notify).toHaveBeenCalledTimes(1)
    broadcaster.resetThrottle()
    broadcaster.broadcastWorkspaceList()
    expect(notify).toHaveBeenCalledTimes(2)
  })
})
