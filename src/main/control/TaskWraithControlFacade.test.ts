import fs from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStore } from '../store'
import type { ChatRecord, WorkspaceRecord } from '../store/types'
import { setRemoteEnsemblePresetsFromRaw } from '../remote/EnsembleRosterPresetsCache'
import { createTaskWraithControlFacade } from './TaskWraithControlFacade'
import {
  projectTaskWraithControlThread,
  projectTaskWraithControlThreadFacts,
  type TaskWraithControlInventoryRow
} from './TaskWraithControlProjector'
import type {
  TaskWraithControlThreadProjectionRequest,
  TaskWraithControlThreadProjectionResult
} from '../../shared/taskWraithControlProjection'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-control-facade-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

describe('TaskWraithControlFacade mutation routing', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
    setRemoteEnsemblePresetsFromRaw([])
  })

  it('uses the solo composer executor for a canonical solo chat', async () => {
    const workspace = AppStore.addOrUpdateWorkspace('/repo', {
      id: 'workspace-1',
      displayName: 'Repo'
    })
    const chat: ChatRecord = {
      ...AppStore.createChat(workspace.id, workspace.path),
      provider: 'claude',
      title: 'Solo'
    }
    AppStore.saveChat(chat)
    const executeComposerPrompt = vi.fn(async () => ({
      executed: true,
      message: 'solo dispatched'
    }))
    const executeEnsembleSteer = vi.fn()
    const facade = createTaskWraithControlFacade({
      executeComposerPrompt,
      executeCancelRun: vi.fn(),
      executeEnsembleSteer,
      executeEnsembleCancelRound: vi.fn(),
      executeEnsembleRosterUpdate: vi.fn(),
      now: () => 10_000
    })

    await expect(facade.sendPrompt(chat.appChatId, '  hello  ')).resolves.toEqual({
      dispatched: true,
      message: 'solo dispatched'
    })
    expect(executeComposerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'composerPrompt',
        workspaceId: workspace.id,
        threadId: chat.appChatId,
        provider: 'claude',
        text: 'hello'
      })
    )
    expect(executeEnsembleSteer).not.toHaveBeenCalled()
  })

  it('starts or steers an ensemble through the orchestrator action, never the solo path', async () => {
    const workspace = AppStore.addOrUpdateWorkspace('/ensemble-repo', {
      id: 'workspace-ensemble',
      displayName: 'Ensemble Repo'
    })
    const created = AppStore.createEnsembleChat({
      workspaceId: workspace.id,
      workspacePath: workspace.path
    })
    const first = created.ensemble!.participants[0]!
    const chat: ChatRecord = {
      ...created,
      ensemble: {
        ...created.ensemble!,
        activeRosterPresetId: 'build-review',
        activeRound: {
          roundId: 'round-1',
          status: 'running',
          prompt: 'before',
          startedAt: new Date(0).toISOString(),
          activeParticipantId: first.id,
          participants: created.ensemble!.participants.map((participant, index) => ({
            participantId: participant.id,
            provider: participant.provider,
            role: participant.role,
            order: participant.order,
            status: index === 0 ? 'running' : 'idle'
          }))
        }
      }
    }
    setRemoteEnsemblePresetsFromRaw([
      {
        id: 'build-review',
        name: 'Build + Review',
        participants: []
      }
    ])
    AppStore.saveChat(chat)
    const executeComposerPrompt = vi.fn()
    const executeEnsembleSteer = vi.fn(async () => ({
      executed: true,
      message: 'ensemble steered'
    }))
    const executeEnsembleCancelRound = vi.fn(async () => ({
      executed: true,
      message: 'ensemble cancelled'
    }))
    const facade = createTaskWraithControlFacade({
      executeComposerPrompt,
      executeCancelRun: vi.fn(),
      executeEnsembleSteer,
      executeEnsembleCancelRound,
      executeEnsembleRosterUpdate: vi.fn(),
      now: () => 20_000
    })

    expect((await facade.selectThread(chat.appChatId, 80)).thread.ensemble?.preset).toBe(
      'Build + Review'
    )
    await expect(facade.sendPrompt(chat.appChatId, 'direct @Lead')).resolves.toEqual({
      dispatched: true,
      message: 'ensemble steered'
    })
    expect(executeEnsembleSteer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ensembleSteer',
        workspaceId: workspace.id,
        threadId: chat.appChatId,
        roundId: 'round-1',
        text: 'direct @Lead'
      })
    )
    expect(executeComposerPrompt).not.toHaveBeenCalled()

    await expect(facade.cancelRun(chat.appChatId)).resolves.toEqual({
      cancelled: true,
      message: 'ensemble cancelled'
    })
    expect(executeEnsembleCancelRound).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ensembleCancelRound',
        threadId: chat.appChatId,
        roundId: 'round-1'
      })
    )
  })

  it('projects curated model offers and only dispatches a selection it offered', async () => {
    const workspace = AppStore.addOrUpdateWorkspace('/offers-repo', {
      id: 'workspace-offers',
      displayName: 'Offers Repo'
    })
    const chat: ChatRecord = {
      ...AppStore.createChat(workspace.id, workspace.path),
      provider: 'claude',
      title: 'Offers',
      requestedModel: 'claude-opus-5',
      providerMetadata: { claudeReasoningEffort: 'high' }
    }
    AppStore.saveChat(chat)
    const executeComposerPrompt = vi.fn(async () => ({
      executed: true,
      message: 'solo dispatched'
    }))
    const facade = createTaskWraithControlFacade({
      executeComposerPrompt,
      executeCancelRun: vi.fn(),
      executeEnsembleSteer: vi.fn(),
      executeEnsembleCancelRound: vi.fn(),
      executeEnsembleRosterUpdate: vi.fn(),
      now: () => 30_000
    })

    const offers = facade.threadOffers(chat.appChatId)
    expect(offers.locked).toBeUndefined()
    expect(offers.source).toBe('curated')
    expect(offers.currentModel).toBe('claude-opus-5')
    expect(offers.currentReasoningEffort).toBe('high')
    const current = offers.models.find((model) => model.current)
    expect(current?.id).toBe('claude-opus-5')
    const alternative = offers.models.find((model) => !model.current && !model.disabled)
    expect(alternative).toBeDefined()
    const effort = alternative!.reasoningEfforts.find((candidate) => !candidate.disabled)
    expect(effort).toBeDefined()

    await expect(
      facade.sendPrompt(chat.appChatId, 'tuned send', {
        model: alternative!.id,
        reasoningEffort: effort!.id
      })
    ).resolves.toEqual({ dispatched: true, message: 'solo dispatched' })
    const action = (
      executeComposerPrompt.mock.calls.at(-1) as unknown[] | undefined
    )?.[0] as Record<string, unknown>
    expect(action.model).toBe(alternative!.id)
    // Claude rides its dedicated effort field on the wire (iOS parity).
    expect(action.claudeReasoningEffort).toBe(effort!.id)
    expect(action.reasoningEffort).toBeUndefined()

    await expect(
      facade.sendPrompt(chat.appChatId, 'bad send', { model: 'gpt-5.6-sol' })
    ).rejects.toThrow('That model is not offered for this thread.')
    await expect(
      facade.sendPrompt(chat.appChatId, 'bad effort', {
        model: alternative!.id,
        reasoningEffort: 'not-a-real-effort'
      })
    ).rejects.toThrow('That reasoning effort is not offered for the selected model.')
  })

  it('keeps an off-catalogue current model selectable and locks non-switchable threads', async () => {
    const workspace = AppStore.addOrUpdateWorkspace('/locked-repo', {
      id: 'workspace-locked',
      displayName: 'Locked Repo'
    })
    const offCatalogue: ChatRecord = {
      ...AppStore.createChat(workspace.id, workspace.path),
      provider: 'claude',
      title: 'Custom model',
      requestedModel: 'claude-experimental-nightly'
    }
    AppStore.saveChat(offCatalogue)
    const ollamaChat: ChatRecord = {
      ...AppStore.createChat(workspace.id, workspace.path),
      provider: 'ollama',
      title: 'Local models'
    }
    AppStore.saveChat(ollamaChat)
    const facade = createTaskWraithControlFacade({
      executeComposerPrompt: vi.fn(),
      executeCancelRun: vi.fn(),
      executeEnsembleSteer: vi.fn(),
      executeEnsembleCancelRound: vi.fn(),
      executeEnsembleRosterUpdate: vi.fn(),
      now: () => 40_000
    })

    const offCatalogueOffers = facade.threadOffers(offCatalogue.appChatId)
    expect(offCatalogueOffers.models[0]).toMatchObject({
      id: 'claude-experimental-nightly',
      current: true
    })

    const lockedOffers = facade.threadOffers(ollamaChat.appChatId)
    expect(lockedOffers.locked).toContain('Ollama')
    expect(lockedOffers.models).toHaveLength(0)
  })

  it('flips exactly one seat through the canonical roster action and honours the floor', async () => {
    const workspace = AppStore.addOrUpdateWorkspace('/seats-repo', {
      id: 'workspace-seats',
      displayName: 'Seats Repo'
    })
    const created = AppStore.createEnsembleChat({
      workspaceId: workspace.id,
      workspacePath: workspace.path
    })
    AppStore.saveChat(created)
    const participants = created.ensemble!.participants
    expect(participants.length).toBeGreaterThanOrEqual(2)
    const [first, second] = participants
    const executeEnsembleRosterUpdate = vi.fn(async () => ({
      executed: true,
      message: 'Roster updated'
    }))
    const facade = createTaskWraithControlFacade({
      executeComposerPrompt: vi.fn(),
      executeCancelRun: vi.fn(),
      executeEnsembleSteer: vi.fn(),
      executeEnsembleCancelRound: vi.fn(),
      executeEnsembleRosterUpdate,
      now: () => 50_000
    })

    // Ensemble threads never expose the model picker.
    expect(facade.threadOffers(created.appChatId).locked).toContain('Ensemble')
    await expect(
      facade.sendPrompt(created.appChatId, 'steer', { model: 'claude-opus-5' })
    ).rejects.toThrow('Model switching from the terminal is solo-thread only.')

    await expect(facade.toggleEnsembleSeat(created.appChatId, second!.id, false)).resolves.toEqual({
      updated: true,
      message: 'Roster updated'
    })
    const action = (
      executeEnsembleRosterUpdate.mock.calls.at(-1) as unknown[] | undefined
    )?.[0] as {
      kind: string
      participants: Array<{ id?: string; provider: string; enabled?: boolean }>
    }
    expect(action.kind).toBe('ensembleRosterUpdate')
    // The FULL canonical roster rides along in speaking order — an omitted
    // entry would delete that seat — with only the target flag flipped.
    expect(action.participants).toEqual(
      [...participants]
        .sort((left, right) => left.order - right.order)
        .map((participant) => ({
          id: participant.id,
          provider: participant.provider,
          enabled: participant.id === second!.id ? false : participant.enabled
        }))
    )

    await expect(facade.toggleEnsembleSeat(created.appChatId, second!.id, true)).resolves.toEqual({
      updated: false,
      message: 'Seat is already enabled.'
    })
    await expect(facade.toggleEnsembleSeat(created.appChatId, 'ghost-seat', true)).rejects.toThrow(
      'That seat no longer exists.'
    )

    const lastEnabled: ChatRecord = {
      ...created,
      ensemble: {
        ...created.ensemble!,
        participants: participants.map((participant, index) => ({
          ...participant,
          enabled: index === 0
        }))
      }
    }
    AppStore.saveChat(lastEnabled)
    await expect(facade.toggleEnsembleSeat(created.appChatId, first!.id, false)).rejects.toThrow(
      'At least one participant must stay enabled.'
    )
    // Disabled seats stay in the projection so the seat lens can re-enable them.
    const summary = (await facade.selectThread(created.appChatId, 10)).thread.ensemble
    expect(summary?.participants.some((participant) => !participant.enabled)).toBe(true)
  })
})

describe('TaskWraithControlFacade catalogue projections', () => {
  const NOW = Date.UTC(2026, 4, 22, 12, 0, 0)
  const iso = (ms: number): string => new Date(ms).toISOString()
  const workspace: WorkspaceRecord = {
    id: 'ws-1',
    path: '/tmp/ws-1',
    displayName: 'One',
    createdAt: NOW,
    lastOpenedAt: NOW,
    pinned: false
  }
  const record = (overrides: Partial<ChatRecord>): ChatRecord =>
    ({
      appChatId: 'chat',
      scope: 'workspace',
      provider: 'codex',
      title: 'Chat',
      workspaceId: 'ws-1',
      workspacePath: '/tmp/ws-1',
      createdAt: NOW - 1000,
      updatedAt: NOW,
      archived: false,
      messages: [],
      runs: [],
      persistenceRevision: 3,
      ...overrides
    }) as ChatRecord
  /** A catalogue row the way the decoder will attach the list facts. */
  const row = (chat: ChatRecord): TaskWraithControlInventoryRow => ({
    ...chat,
    summaryOnly: true,
    messageCount: chat.messages.length,
    runCount: chat.runs.length,
    messages: [],
    runs: [],
    catalogueControl: projectTaskWraithControlThreadFacts(chat)
  })
  const makeStore = (rows: () => TaskWraithControlInventoryRow[], chats: ChatRecord[] = []) => ({
    getChatList: vi.fn(() => rows()),
    getChat: vi.fn((chatId: string) => chats.find((chat) => chat.appChatId === chatId) ?? null),
    getWorkspaces: () => [workspace]
  })
  const executors = () => ({
    executeComposerPrompt: vi.fn(),
    executeCancelRun: vi.fn(),
    executeEnsembleSteer: vi.fn(),
    executeEnsembleCancelRound: vi.fn(),
    executeEnsembleRosterUpdate: vi.fn()
  })
  const messages = [
    { id: 'm1', role: 'user', content: 'hello', timestamp: iso(NOW - 120_000) },
    { id: 'm2', role: 'assistant', content: 'hi there', timestamp: iso(NOW - 90_000), runId: 'r1' },
    { id: 'm3', role: 'user', content: 'more', timestamp: iso(NOW - 60_000) }
  ] as ChatRecord['messages']
  const running = record({
    appChatId: 'live',
    messages,
    runs: [
      {
        runId: 'r1',
        provider: 'codex',
        startedAt: iso(NOW - 60_000),
        status: 'running',
        stats: { total_tokens: 42 }
      }
    ] as ChatRecord['runs']
  })
  const projectionOf =
    (chat: ChatRecord) =>
    async (
      request: TaskWraithControlThreadProjectionRequest
    ): Promise<TaskWraithControlThreadProjectionResult> => ({
      kind: 'projection',
      projection: projectTaskWraithControlThread(chat, request, 'fixed')
    })

  it('builds the snapshot from chat-list rows and never opens a record', () => {
    const rows = [row(running), row(record({ appChatId: 'quiet' }))]
    const store = makeStore(() => rows, [running])
    const facade = createTaskWraithControlFacade({ ...executors(), now: () => NOW, store })
    const snapshot = facade.snapshot()
    expect(store.getChatList).toHaveBeenCalledTimes(1)
    expect(store.getChat).not.toHaveBeenCalled()
    expect(
      snapshot.threads.map((thread) => [
        thread.id,
        thread.status,
        thread.wallTimeMs,
        thread.tokenEstimate,
        thread.messageCount
      ])
    ).toEqual([
      ['live', 'working', 60_000, 42, 3],
      ['quiet', 'idle', undefined, undefined, 0]
    ])
    expect(snapshot.workspaces).toEqual([
      { id: 'ws-1', name: 'One', path: '/tmp/ws-1', pinned: false, updatedAt: NOW }
    ])
  })

  it('degrades a row without catalogue facts to what the row carries', () => {
    const bare = {
      ...record({ appChatId: 'bare' }),
      summaryOnly: true,
      messageCount: 5,
      runCount: 1,
      lastRun: { runId: 'r', provider: 'claude', startedAt: iso(NOW - 30_000), status: 'running' },
      cataloguePresentation: {
        status: 'running',
        runId: 'r',
        startedAt: iso(NOW - 30_000),
        runningRunCount: 1
      }
    } as unknown as TaskWraithControlInventoryRow
    const facade = createTaskWraithControlFacade({
      ...executors(),
      now: () => NOW,
      store: makeStore(() => [bare])
    })
    const [thread] = facade.snapshot().threads
    expect(thread).toMatchObject({
      id: 'bare',
      status: 'working',
      messageCount: 5,
      wallTimeMs: 30_000
    })
    expect(thread.provider.runtimeProvider).toBe('claude')
    expect(thread.tokenEstimate).toBeUndefined()
  })

  it('serves the selected thread from one projection per revision and limit', async () => {
    let rows = [row(running)]
    const provider = vi.fn(projectionOf(running))
    const facade = createTaskWraithControlFacade({
      ...executors(),
      now: () => NOW,
      store: makeStore(() => rows),
      getThreadProjection: provider
    })
    facade.snapshot()
    const first = await facade.selectThread('live', 10)
    const second = await facade.selectThread('live', 10)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(provider).toHaveBeenCalledWith({ threadId: 'live', limit: 10 })
    expect(second.rows).toEqual(first.rows)
    expect(first.rows.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3'])
    expect(first.thread).toMatchObject({ status: 'working', wallTimeMs: 60_000, tokenEstimate: 42 })
    expect(first.context.workspaces).toEqual([
      { id: 'ws-1', name: 'One', path: '/tmp/ws-1', access: 'write', primary: true }
    ])

    // A different page size is a different pane: asked afresh, nothing offered.
    await facade.selectThread('live', 2)
    expect(provider).toHaveBeenLastCalledWith({ threadId: 'live', limit: 2 })

    // The row's revision moves: ask again, offering the revision held.
    rows = [row({ ...running, persistenceRevision: 4 })]
    facade.snapshot()
    await facade.selectThread('live', 2)
    expect(provider).toHaveBeenLastCalledWith({ threadId: 'live', limit: 2, knownRevision: 3 })
    expect(provider).toHaveBeenCalledTimes(3)
  })

  it('keeps the held pane on `unchanged`, and re-asks when it holds nothing', async () => {
    let rows = [row(running)]
    const answers: TaskWraithControlThreadProjectionResult[] = [
      {
        kind: 'projection',
        projection: projectTaskWraithControlThread(running, { limit: 10 }, 'fixed')
      },
      { kind: 'unchanged', revision: 3 }
    ]
    const provider = vi.fn(
      async () => answers.shift() ?? ({ kind: 'unchanged', revision: 3 } as const)
    )
    const facade = createTaskWraithControlFacade({
      ...executors(),
      now: () => NOW,
      store: makeStore(() => rows),
      getThreadProjection: provider
    })
    facade.snapshot()
    const held = await facade.selectThread('live', 10)
    rows = [row({ ...running, persistenceRevision: 4 })]
    facade.snapshot()
    const again = await facade.selectThread('live', 10)
    expect(provider).toHaveBeenCalledTimes(2)
    expect(again.rows).toEqual(held.rows)
    // Settled: the next poll at the same revision costs nothing.
    await facade.selectThread('live', 10)
    expect(provider).toHaveBeenCalledTimes(2)

    const empty = createTaskWraithControlFacade({
      ...executors(),
      now: () => NOW,
      store: makeStore(() => rows),
      getThreadProjection: vi.fn(async () => ({ kind: 'unchanged', revision: 4 }) as const)
    })
    await expect(empty.selectThread('live', 10)).rejects.toThrow('Thread not found.')
  })

  it('applies the clock at read time on a cached pane', async () => {
    let now = NOW
    const provider = vi.fn(projectionOf(running))
    const facade = createTaskWraithControlFacade({
      ...executors(),
      now: () => now,
      store: makeStore(() => [row(running)]),
      getThreadProjection: provider
    })
    facade.snapshot()
    expect((await facade.selectThread('live', 10)).thread.wallTimeMs).toBe(60_000)
    now = NOW + 5_000
    const later = await facade.selectThread('live', 10)
    expect(later.thread.wallTimeMs).toBe(65_000)
    expect(later.context.wallTimeMs).toBe(65_000)
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('drops a thread the worker no longer knows and forgets its pane', async () => {
    const answers: TaskWraithControlThreadProjectionResult[] = [
      {
        kind: 'projection',
        projection: projectTaskWraithControlThread(running, { limit: 10 }, 'fixed')
      },
      { kind: 'missing' },
      {
        kind: 'projection',
        projection: projectTaskWraithControlThread(running, { limit: 10 }, 'fixed')
      }
    ]
    const provider = vi.fn(async () => answers.shift() ?? ({ kind: 'missing' } as const))
    let rows = [row(running)]
    const facade = createTaskWraithControlFacade({
      ...executors(),
      now: () => NOW,
      store: makeStore(() => rows),
      getThreadProjection: provider
    })
    facade.snapshot()
    await facade.selectThread('live', 10)
    rows = [row({ ...running, persistenceRevision: 4 })]
    facade.snapshot()
    await expect(facade.selectThread('live', 10)).rejects.toThrow('Thread not found.')
    // Nothing is held any more: the next select asks without an offer.
    await facade.selectThread('live', 10)
    expect(provider).toHaveBeenLastCalledWith({ threadId: 'live', limit: 10 })
  })

  it('falls back to an in-process projection of the selected record', async () => {
    let rows = [row(running)]
    const store = makeStore(() => rows, [running])
    const facade = createTaskWraithControlFacade({ ...executors(), now: () => NOW, store })
    facade.snapshot()
    const pane = await facade.selectThread('live', 10)
    await facade.selectThread('live', 10)
    expect(store.getChat).toHaveBeenCalledTimes(1)
    expect(pane.rows.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3'])
    rows = [row({ ...running, persistenceRevision: 4 })]
    facade.snapshot()
    // The record itself is still at revision 3, so the in-process provider answers unchanged.
    const same = await facade.selectThread('live', 10)
    expect(store.getChat).toHaveBeenCalledTimes(2)
    expect(same.rows).toEqual(pane.rows)
    await expect(facade.selectThread('gone', 10)).rejects.toThrow('Thread not found.')
  })
})
