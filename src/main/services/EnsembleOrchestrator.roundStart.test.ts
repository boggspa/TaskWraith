import { describe, expect, it, vi } from 'vitest'
import type { AgentRunPayload, RunDispatchObserver } from '../run/AgentRunTypes'
import { createWorkSpanRecorder } from '../perf/WorkSpanRecorder'
import type { AppSettings, ChatRecord, EnsembleParticipant, ProviderId } from '../store/types'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import type { EnsembleOrchestratorDeps } from './EnsembleOrchestratorTypes'

function participant(
  id: string,
  provider: ProviderId,
  order: number,
  role = id
): EnsembleParticipant {
  return {
    id,
    provider,
    enabled: true,
    role,
    instructions: `${role}.`,
    order,
    model: `${provider}-model`,
    permissionPresetId: 'workspace_write',
    stageRole: 'worker'
  }
}

function chat(id: string, participants: EnsembleParticipant[]): ChatRecord {
  return {
    appChatId: id,
    chatKind: 'ensemble',
    scope: 'global',
    provider: participants[0]?.provider || 'codex',
    title: id,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: participants.length,
      maxContinuationHops: 0,
      fanoutPolicy: 'off',
      participants
    }
  } as ChatRecord
}

function settings(): AppSettings {
  return {
    storeLocalChatHistory: true,
    storeRawEvents: false,
    ensembleModeEnabled: true,
    chatContextTurns: 8
  } as AppSettings
}

function harness(
  initialChats: ChatRecord[],
  options: {
    invokeAdapterImmediately?: boolean
    spans?: EnsembleOrchestratorDeps['spans']
  } = {}
): {
  orchestrator: EnsembleOrchestrator
  dispatched: AgentRunPayload[]
  invokeAdapter: (index: number) => void
  settle: (runId: string) => void
} {
  const chats = new Map(initialChats.map((entry) => [entry.appChatId, entry]))
  const dispatched: AgentRunPayload[] = []
  const observers: Array<RunDispatchObserver | undefined> = []
  const settlements = new Map<string, (result: { dispatched: boolean; appRunId: string }) => void>()
  let sequence = 0
  const invokeAdapterImmediately = options.invokeAdapterImmediately !== false
  const orchestrator = new EnsembleOrchestrator({
    getChat: (chatId) => chats.get(chatId) || null,
    saveChat: (next) => chats.set(next.appChatId, next),
    getSettings: settings,
    ...(options.spans ? { spans: options.spans } : {}),
    dispatch: (payload, _event, observer) => {
      dispatched.push(payload)
      observers.push(observer)
      if (invokeAdapterImmediately) {
        observer?.onAdapterInvoked?.({
          provider: payload.provider,
          appRunId: payload.appRunId || '',
          ...(payload.workspace ? { effectiveWorkspacePath: payload.workspace } : {})
        })
      }
      return new Promise((resolve) => {
        settlements.set(payload.appRunId || '', resolve)
      })
    },
    cancelRun: async () => true,
    createRunId: (provider) => `${provider}-round-start-${++sequence}`,
    now: () => sequence * 10,
    nowIso: () => `2026-09-10T19:00:${String(sequence).padStart(2, '0')}.000Z`
  })
  return {
    orchestrator,
    dispatched,
    invokeAdapter: (index) => {
      const payload = dispatched[index]
      observers[index]?.onAdapterInvoked?.({
        provider: payload.provider,
        appRunId: payload.appRunId || ''
      })
    },
    settle: (runId) => {
      const resolve = settlements.get(runId)
      if (!resolve) throw new Error(`No live dispatch settlement for ${runId}.`)
      settlements.delete(runId)
      resolve({ dispatched: true, appRunId: runId })
    }
  }
}

describe('EnsembleOrchestrator round_start spans', () => {
  it('emits one round_start at first adapter invocation, not at dispatch enqueue', async () => {
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 16 })
    const testHarness = harness([chat('ensemble-chat', [participant('codex', 'codex', 1)])], {
      invokeAdapterImmediately: false,
      spans: recorder
    })
    testHarness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Go.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(1))
    expect(recorder.snapshot().spans).toEqual([])

    testHarness.invokeAdapter(0)
    const snapshot = recorder.snapshot()
    expect(snapshot.spans).toHaveLength(1)
    expect(snapshot.spans[0]).toMatchObject({
      chatId: 'ensemble-chat',
      runId: testHarness.dispatched[0]!.appRunId,
      participantId: 'codex',
      kind: 'round_start',
      process: 'main'
    })
    expect(snapshot.spans[0]!.durationMs).toBeGreaterThanOrEqual(0)
    expect(snapshot.byKind.round_start?.count).toBe(1)

    testHarness.invokeAdapter(0)
    expect(recorder.snapshot().spans).toHaveLength(1)
    testHarness.settle(testHarness.dispatched[0]!.appRunId || '')
    await testHarness.orchestrator.cancelRound('ensemble-chat', 'cleanup')
  })

  it('emits no span when no recorder is attached', async () => {
    const testHarness = harness([chat('ensemble-chat', [participant('codex', 'codex', 1)])])
    testHarness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Go.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(1))
    testHarness.settle(testHarness.dispatched[0]!.appRunId || '')
    await testHarness.orchestrator.cancelRound('ensemble-chat', 'cleanup')
  })

  it('contains a throwing recorder so dispatch still proceeds', async () => {
    const throwing = {
      record: () => {
        throw new Error('recorder must not break ensemble dispatch')
      }
    }
    const testHarness = harness([chat('ensemble-chat', [participant('codex', 'codex', 1)])], {
      spans: throwing
    })
    testHarness.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Go.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(1))
    testHarness.settle(testHarness.dispatched[0]!.appRunId || '')
    await testHarness.orchestrator.cancelRound('ensemble-chat', 'cleanup')
  })
})
