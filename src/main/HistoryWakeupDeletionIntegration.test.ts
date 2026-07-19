import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SoloChatWakeupService } from './SoloChatWakeupService'
import { WakeupTimerService } from './WakeupTimerService'
import type { AgentRunPayload } from './run/AgentRunTypes'
import { EnsembleOrchestrator } from './services/EnsembleOrchestrator'
import { AppStore } from './store'
import type {
  ChatRecord,
  EnsembleWakeupRecord,
  ProviderId,
  SoloChatWakeupRecord
} from './store/types'

const userDataPath = vi.hoisted(
  () => `/tmp/taskwraith-history-wakeup-integration-${process.pid}`
)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath,
    getVersion: () => 'test'
  }
}))

const NOW_MS = Date.parse('2026-07-19T09:00:00.000Z')

function saveSoloChat(
  appChatId: string,
  workspaceId: string,
  parentChatId?: string
): ChatRecord {
  const chat: ChatRecord = {
    appChatId,
    chatKind: 'single',
    scope: 'workspace',
    provider: 'codex',
    title: appChatId,
    workspaceId,
    workspacePath: `/repo/${workspaceId}`,
    ...(parentChatId ? { parentChatId } : {}),
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
    archived: false,
    messages: [],
    runs: []
  }
  AppStore.saveChat(chat)
  return chat
}

function saveEnsembleChat(
  appChatId: string,
  workspaceId: string,
  wakeups?: Record<string, EnsembleWakeupRecord>
): ChatRecord {
  const chat: ChatRecord = {
    appChatId,
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: appChatId,
    workspaceId,
    workspacePath: `/repo/${workspaceId}`,
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 1,
      participants: [
        {
          id: 'reviewer',
          provider: 'claude',
          enabled: true,
          role: 'Reviewer',
          instructions: 'Review the request.',
          order: 1,
          model: 'claude-model',
          permissionPresetId: 'read_only'
        }
      ],
      ...(wakeups ? { wakeups } : {})
    }
  }
  AppStore.saveChat(chat)
  return chat
}

function createSoloRuntime(options: {
  dispatchRun?: (
    payload: AgentRunPayload
  ) => Promise<{ dispatched: boolean; appRunId: string }>
} = {}): {
  service: SoloChatWakeupService
  timer: WakeupTimerService
  dispatched: AgentRunPayload[]
  lastFire: () => Promise<boolean> | null
} {
  const dispatched: AgentRunPayload[] = []
  let lastFire: Promise<boolean> | null = null
  let service!: SoloChatWakeupService
  const timer = new WakeupTimerService({
    now: () => Date.now(),
    onFire: (wakeupId) => {
      lastFire = service.handleWakeupFired(wakeupId)
    }
  })
  service = new SoloChatWakeupService({
    getChat: (chatId) => AppStore.getChat(chatId),
    saveChat: (chat) => AppStore.saveChat(chat),
    listChats: () => AppStore.getChats(),
    dispatchRun: async (payload) => {
      dispatched.push(payload)
      return options.dispatchRun
        ? options.dispatchRun(payload)
        : { dispatched: true, appRunId: payload.appRunId || 'solo-resume-run' }
    },
    scheduleWakeupTimer: (wakeup) => timer.schedule(wakeup),
    cancelWakeupTimer: (wakeupId) => {
      timer.cancel(wakeupId)
    },
    createRunId: () => 'solo-resume-run',
    now: () => Date.now(),
    nowIso: () => new Date(Date.now()).toISOString()
  })
  return { service, timer, dispatched, lastFire: () => lastFire }
}

function scheduleSolo(
  service: SoloChatWakeupService,
  chatId: string,
  delayMs = 60_000
): SoloChatWakeupRecord {
  const result = service.scheduleWakeup(chatId, 'codex', `source-${chatId}`, { delayMs })
  expect(result.ok).toBe(true)
  return result.wakeup!
}

function createEnsembleRuntime(timer: WakeupTimerService): {
  orchestrator: EnsembleOrchestrator
  dispatched: AgentRunPayload[]
  terminateRunForHistory: ReturnType<typeof vi.fn>
} {
  let counter = 0
  const dispatched: AgentRunPayload[] = []
  const terminateRunForHistory = vi.fn(async () => true)
  const orchestrator = new EnsembleOrchestrator({
    getChat: (chatId) => AppStore.getChat(chatId),
    saveChat: (chat) => AppStore.saveChat(chat),
    getSettings: () => AppStore.getSettings(),
    dispatch: async (payload) => {
      dispatched.push(payload)
      return { dispatched: true, appRunId: payload.appRunId || '' }
    },
    cancelRun: async () => true,
    terminateRunForHistory,
    createRunId: (provider: ProviderId) => `${provider}-integration-${++counter}`,
    now: () => Date.now(),
    nowIso: () => new Date(Date.now()).toISOString(),
    scheduleWakeupTimer: (wakeup) => timer.schedule(wakeup),
    cancelWakeupTimer: (wakeupId) => {
      timer.cancel(wakeupId)
    }
  })
  return { orchestrator, dispatched, terminateRunForHistory }
}

describe('history deletion wakeup lifecycle — durable integration', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW_MS })
    fs.rmSync(userDataPath, { recursive: true, force: true })
    AppStore.resetTransientDeletionGuardsForTests()
  })

  afterEach(() => {
    AppStore.resetTransientDeletionGuardsForTests()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('deletes a parent and descendants only after cancelling their live solo timers', async () => {
    saveSoloChat('parent', 'workspace-a')
    saveSoloChat('child', 'workspace-a', 'parent')
    saveSoloChat('sibling', 'workspace-a')
    const runtime = createSoloRuntime()
    const parentWakeup = scheduleSolo(runtime.service, 'parent')
    const childWakeup = scheduleSolo(runtime.service, 'child')
    const siblingWakeup = scheduleSolo(runtime.service, 'sibling')

    const prepared = AppStore.prepareHistoryDeletion({ kind: 'chat', rootChatId: 'parent' })
    expect(prepared.chatIds.sort()).toEqual(['child', 'parent'])
    const hold = runtime.service.beginHistoryClear({ kind: 'chat', chatIds: prepared.chatIds })
    await hold.completion

    expect(runtime.timer.has(parentWakeup.wakeupId)).toBe(false)
    expect(runtime.timer.has(childWakeup.wakeupId)).toBe(false)
    expect(runtime.timer.has(siblingWakeup.wakeupId)).toBe(true)
    AppStore.commitPreparedHistoryDeletion(prepared.operationId)
    expect(runtime.service.endHistoryClear(hold)).toBe(true)

    await vi.advanceTimersByTimeAsync(60_000)
    await runtime.lastFire()
    expect(AppStore.getChat('parent')).toBeNull()
    expect(AppStore.getChat('child')).toBeNull()
    expect(AppStore.getChat('sibling')?.soloWakeups?.[siblingWakeup.wakeupId]?.status).toBe(
      'fired'
    )
    expect(runtime.dispatched.map((payload) => payload.appChatId)).toEqual(['sibling'])
  })

  it('clears one workspace while preserving a sibling workspace solo timer', async () => {
    saveSoloChat('workspace-a-1', 'workspace-a')
    saveSoloChat('workspace-a-2', 'workspace-a')
    saveSoloChat('workspace-b-1', 'workspace-b')
    const runtime = createSoloRuntime()
    const wakeA1 = scheduleSolo(runtime.service, 'workspace-a-1')
    const wakeA2 = scheduleSolo(runtime.service, 'workspace-a-2')
    const wakeB = scheduleSolo(runtime.service, 'workspace-b-1')

    const prepared = AppStore.prepareHistoryDeletion({
      kind: 'workspace',
      workspaceId: 'workspace-a'
    })
    const hold = runtime.service.beginHistoryClear({
      kind: 'workspace',
      workspaceId: 'workspace-a',
      chatIds: prepared.chatIds
    })
    await hold.completion

    expect(runtime.timer.has(wakeA1.wakeupId)).toBe(false)
    expect(runtime.timer.has(wakeA2.wakeupId)).toBe(false)
    expect(runtime.timer.has(wakeB.wakeupId)).toBe(true)
    AppStore.commitPreparedHistoryDeletion(prepared.operationId)
    expect(runtime.service.endHistoryClear(hold)).toBe(true)

    await vi.advanceTimersByTimeAsync(60_000)
    await runtime.lastFire()
    expect(AppStore.getChat('workspace-a-1')).toBeNull()
    expect(AppStore.getChat('workspace-a-2')).toBeNull()
    expect(AppStore.getChat('workspace-b-1')?.soloWakeups?.[wakeB.wakeupId]?.status).toBe(
      'fired'
    )
    expect(runtime.dispatched.map((payload) => payload.appChatId)).toEqual(['workspace-b-1'])
  })

  it('globally clears every live solo timer without a late dispatch', async () => {
    saveSoloChat('global-a', 'workspace-a')
    saveSoloChat('global-b', 'workspace-b')
    const runtime = createSoloRuntime()
    const wakeA = scheduleSolo(runtime.service, 'global-a')
    const wakeB = scheduleSolo(runtime.service, 'global-b')

    const prepared = AppStore.prepareHistoryDeletion({ kind: 'global' })
    const hold = runtime.service.beginHistoryClear({ kind: 'global' })
    await hold.completion
    expect(runtime.timer.has(wakeA.wakeupId)).toBe(false)
    expect(runtime.timer.has(wakeB.wakeupId)).toBe(false)

    AppStore.commitPreparedHistoryDeletion(prepared.operationId)
    expect(runtime.service.endHistoryClear(hold)).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runtime.dispatched).toEqual([])
    expect(AppStore.getChats()).toEqual([])
  })

  it('joins a solo timer already firing at prepare and makes no forbidden failure write', async () => {
    saveSoloChat('in-flight', 'workspace-a')
    let rejectDispatch!: (error: Error) => void
    const dispatch = new Promise<{ dispatched: boolean; appRunId: string }>((_resolve, reject) => {
      rejectDispatch = reject
    })
    const runtime = createSoloRuntime({ dispatchRun: () => dispatch })
    const wakeup = scheduleSolo(runtime.service, 'in-flight', 10)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await vi.advanceTimersByTimeAsync(10)
    await vi.waitFor(() => expect(runtime.dispatched).toHaveLength(1))
    expect(runtime.lastFire()).not.toBeNull()
    const prepared = AppStore.prepareHistoryDeletion({
      kind: 'truncate',
      rootChatId: 'in-flight'
    })
    const hold = runtime.service.beginHistoryClear({
      kind: 'chat',
      chatIds: prepared.chatIds
    })
    let joined = false
    void hold.completion.then(() => {
      joined = true
    })
    await Promise.resolve()
    expect(joined).toBe(false)

    rejectDispatch(new Error('dispatch revoked by history deletion'))
    await expect(runtime.lastFire()).resolves.toBe(true)
    await expect(hold.completion).resolves.toBeUndefined()
    expect(joined).toBe(true)

    AppStore.commitPreparedHistoryDeletion(prepared.operationId)
    expect(runtime.service.endHistoryClear(hold)).toBe(true)
    expect(AppStore.getChat('in-flight')?.soloWakeups).toBeUndefined()
    expect(runtime.timer.has(wakeup.wakeupId)).toBe(false)
  })

  it('cancels a live Ensemble round under the real prepared-write guard without persistence', async () => {
    saveEnsembleChat('ensemble-live', 'workspace-a')
    const timer = new WakeupTimerService({ now: () => Date.now(), onFire: () => {} })
    const runtime = createEnsembleRuntime(timer)
    const started = runtime.orchestrator.startRound({
      chatId: 'ensemble-live',
      prompt: 'This round must be quiesced without a post-prepare save.',
      event: { sender: {} as Electron.WebContents }
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(runtime.dispatched).toHaveLength(1))
    const roundId = AppStore.getChat('ensemble-live')!.ensemble!.activeRound!.roundId

    const prepared = AppStore.prepareHistoryDeletion({
      kind: 'truncate',
      rootChatId: 'ensemble-live'
    })
    const save = vi.spyOn(AppStore, 'saveChat')
    await expect(
      runtime.orchestrator.cancelRoundForHistory(
        'ensemble-live',
        'chat history cleared',
        roundId
      )
    ).resolves.toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(runtime.terminateRunForHistory).toHaveBeenCalledWith(
      'claude',
      runtime.dispatched[0].appRunId
    )

    AppStore.commitPreparedHistoryDeletion(prepared.operationId)
    expect(AppStore.getChat('ensemble-live')?.ensemble?.activeRound).toBeUndefined()
    expect(AppStore.getChat('ensemble-live')?.messages).toEqual([])
  })

  it('cancels persisted-only Ensemble timers for one workspace and preserves siblings', async () => {
    const targetWakeup: EnsembleWakeupRecord = {
      wakeupId: 'ensemble-target-wakeup',
      chatId: 'ensemble-target',
      roundId: 'old-target-round',
      participantId: 'reviewer',
      provider: 'claude',
      runId: 'old-target-run',
      scheduledAt: new Date(NOW_MS).toISOString(),
      wakeAt: new Date(NOW_MS + 60_000).toISOString(),
      status: 'pending'
    }
    const siblingWakeup: EnsembleWakeupRecord = {
      ...targetWakeup,
      wakeupId: 'ensemble-sibling-wakeup',
      chatId: 'ensemble-sibling',
      roundId: 'old-sibling-round',
      runId: 'old-sibling-run'
    }
    saveEnsembleChat('ensemble-target', 'workspace-a', {
      [targetWakeup.wakeupId]: targetWakeup
    })
    saveEnsembleChat('ensemble-sibling', 'workspace-b', {
      [siblingWakeup.wakeupId]: siblingWakeup
    })
    const fired: string[] = []
    const timer = new WakeupTimerService({
      now: () => Date.now(),
      onFire: (wakeupId) => fired.push(wakeupId)
    })
    timer.schedule(targetWakeup)
    timer.schedule(siblingWakeup)
    const runtime = createEnsembleRuntime(timer)

    const prepared = AppStore.prepareHistoryDeletion({
      kind: 'workspace',
      workspaceId: 'workspace-a'
    })
    const save = vi.spyOn(AppStore, 'saveChat')
    for (const chatId of prepared.chatIds) {
      await expect(runtime.orchestrator.cancelRoundForHistory(chatId)).resolves.toBe(true)
    }
    expect(save).not.toHaveBeenCalled()
    expect(timer.has(targetWakeup.wakeupId)).toBe(false)
    expect(timer.has(siblingWakeup.wakeupId)).toBe(true)

    AppStore.commitPreparedHistoryDeletion(prepared.operationId)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fired).toEqual([siblingWakeup.wakeupId])
    expect(AppStore.getChat('ensemble-target')).toBeNull()
    expect(AppStore.getChat('ensemble-sibling')).not.toBeNull()
  })
})
