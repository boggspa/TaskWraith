import { describe, expect, it, vi } from 'vitest'
import { reconcileStaleChatRuns } from '../ChatRunReconciler'
import type { AgentRunPayload, RunDispatchObserver } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant, ProviderId } from '../store/types'
import {
  EnsembleHostAdmissionScheduler,
  type EnsembleHostAdmissionSchedulerOptions
} from './EnsembleHostAdmissionScheduler'
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

function chat(
  id: string,
  participants: EnsembleParticipant[],
  options: { fanoutPolicy?: 'off' | 'read_only'; bossId?: string } = {}
): ChatRecord {
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
      fanoutPolicy: options.fanoutPolicy ?? 'off',
      ...(options.bossId ? { bossmanParticipantId: options.bossId } : {}),
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

function controlledScheduler(options: EnsembleHostAdmissionSchedulerOptions = {}): {
  scheduler: EnsembleHostAdmissionScheduler
  runOne: () => void
  scheduledCount: () => number
} {
  const scheduled: Array<() => void> = []
  return {
    scheduler: new EnsembleHostAdmissionScheduler({
      ...options,
      maxQueued: 256,
      schedule: (task) => scheduled.push(task)
    }),
    runOne: () => {
      const task = scheduled.shift()
      if (!task) throw new Error('No host-admission drain was scheduled.')
      task()
    },
    scheduledCount: () => scheduled.length
  }
}

function harness(
  initialChats: ChatRecord[],
  admission: ReturnType<typeof controlledScheduler>,
  overrides: Partial<EnsembleOrchestratorDeps> = {}
): {
  orchestrator: EnsembleOrchestrator
  chats: Map<string, ChatRecord>
  dispatched: AgentRunPayload[]
  preparedRunIds: string[]
  settle: (runId: string) => void
} {
  const chats = new Map(initialChats.map((entry) => [entry.appChatId, entry]))
  const dispatched: AgentRunPayload[] = []
  const preparedRunIds: string[] = []
  const settlements = new Map<string, (result: { dispatched: boolean; appRunId: string }) => void>()
  let sequence = 0
  const orchestrator = new EnsembleOrchestrator({
    getChat: (chatId) => chats.get(chatId) || null,
    saveChat: (next) => chats.set(next.appChatId, next),
    getSettings: settings,
    hostAdmissionScheduler: admission.scheduler,
    issueRunScopedExternalGrants: ({ appRunId }) => {
      preparedRunIds.push(appRunId)
      return []
    },
    dispatch: (
      payload: AgentRunPayload,
      _event: { sender: Electron.WebContents },
      observer?: RunDispatchObserver
    ) => {
      dispatched.push(payload)
      observer?.onAdapterInvoked?.({
        provider: payload.provider,
        appRunId: payload.appRunId || '',
        ...(payload.workspace ? { effectiveWorkspacePath: payload.workspace } : {})
      })
      return new Promise((resolve) => {
        settlements.set(payload.appRunId || '', resolve)
      })
    },
    cancelRun: async () => true,
    createRunId: (provider) => `${provider}-host-admission-${++sequence}`,
    now: () => sequence,
    nowIso: () => `2026-09-04T18:00:${String(sequence).padStart(2, '0')}.000Z`,
    ...overrides
  })
  return {
    orchestrator,
    chats,
    dispatched,
    preparedRunIds,
    settle: (runId) => {
      const resolve = settlements.get(runId)
      if (!resolve) throw new Error(`No live dispatch settlement for ${runId}.`)
      settlements.delete(runId)
      resolve({ dispatched: true, appRunId: runId })
    }
  }
}

function finish(
  testHarness: ReturnType<typeof harness>,
  payload: AgentRunPayload,
  status: 'success' | 'error' = 'success'
): void {
  testHarness.orchestrator.handleProviderOutput(
    payload.provider,
    { appRunId: payload.appRunId, appChatId: payload.appChatId },
    { type: 'result', status }
  )
}

describe('EnsembleOrchestrator host-wide admission', () => {
  it.each([8, 30])(
    'fills %i host slots fairly across three 20-seat chats with held dispatches',
    async (capacity) => {
      const admission = controlledScheduler(
        capacity === 30 ? {} : { maxActive: 8, maxForeground: 6 }
      )
      const chats = ['fair-a', 'fair-b', 'fair-c'].map((chatId) =>
        chat(
          chatId,
          [
            participant(`${chatId}-boss`, 'codex', 1, `${chatId} Boss`),
            ...Array.from({ length: 20 }, (_, index) =>
              participant(
                `${chatId}-worker-${index}`,
                index % 2 === 0 ? 'claude' : 'grok',
                index + 2,
                `${chatId} Worker ${index}`
              )
            )
          ],
          { bossId: `${chatId}-boss`, fanoutPolicy: 'read_only' }
        )
      )
      const testHarness = harness(chats, admission)

      for (const chatId of ['fair-a', 'fair-b', 'fair-c']) {
        testHarness.orchestrator.startRound({
          chatId,
          prompt: `Run ${chatId}.`,
          event: { sender: {} as Electron.WebContents }
        })
      }
      await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(3))

      const fanouts = testHarness.dispatched.map((root) => {
        const targetChat = chats.find((entry) => entry.appChatId === root.appChatId)!
        return testHarness.orchestrator.fanoutForRun(root.appRunId, {
          targets: targetChat.ensemble!.participants.slice(1).map((entry) => entry.role),
          prompt: 'Hold every worker dispatch for the fairness check.'
        })
      })
      await Promise.all(fanouts)
      while (admission.scheduledCount() > 0) admission.runOne()
      await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(capacity))

      const lanePayloads = testHarness.dispatched.filter((payload) => payload.ensembleRun?.laneId)
      expect(testHarness.dispatched).toHaveLength(capacity)
      expect(new Set(lanePayloads.map((payload) => payload.appChatId))).toEqual(
        new Set(['fair-a', 'fair-b', 'fair-c'])
      )
      expect(testHarness.orchestrator.getHostAdmissionSnapshot().occupancy).toMatchObject({
        active: capacity,
        queued: 63 - capacity
      })
      expect(
        testHarness.orchestrator.getHostAdmissionSnapshot().metrics.peakActive
      ).toBeLessThanOrEqual(capacity)
      if (capacity === 30) {
        expect(testHarness.orchestrator.getHostAdmissionSnapshot().byChat).toEqual(
          ['fair-a', 'fair-b', 'fair-c'].map((chatId) => ({ chatId, active: 10, queued: 11 }))
        )
        expect(testHarness.preparedRunIds).toHaveLength(30)
        for (const targetChat of testHarness.chats.values()) {
          expect(
            targetChat.messages.some((message) =>
              /host queue ·|provider dispatch started/.test(message.content)
            )
          ).toBe(false)
        }
        // Queued runs have no provider process yet. Exact Ensemble ownership
        // must protect them through repeated sweeps, however long they wait.
        const waitingChats = [...testHarness.chats.values()]
        const isOwned = (runId: string): boolean =>
          testHarness.orchestrator.getParticipantIdForRun(runId) !== null
        for (const minute of [2, 4, 10]) {
          const nowIso = `2026-09-04T18:${String(minute).padStart(2, '0')}:00.000Z`
          const retained = reconcileStaleChatRuns(waitingChats, isOwned, nowIso, {
            minAgeMs: 30_000
          })
          expect(retained.settlements).toEqual([])
          expect(retained.chats).toEqual([])
        }
        // The same persisted rows are real orphans after a restart loses all
        // in-memory ownership; queue status alone must not make them immortal.
        const orphaned = reconcileStaleChatRuns(
          waitingChats,
          () => false,
          '2026-09-04T18:10:00.000Z',
          { minAgeMs: 30_000 }
        )
        expect(orphaned.settlements).toHaveLength(63)
      }

      await Promise.all(
        ['fair-a', 'fair-b', 'fair-c'].map((chatId) =>
          testHarness.orchestrator.cancelRound(chatId, 'fairness test cleanup')
        )
      )
      for (const payload of testHarness.dispatched) testHarness.settle(payload.appRunId || '')
      await admission.scheduler.whenIdle()
    }
  )

  it('settles every seeded lane when fan-out preparation fails after admission', async () => {
    const admission = controlledScheduler({ maxActive: 2, maxForeground: 1 })
    const scouts = [
      {
        ...participant('scout-a', 'codex', 1, 'Scout A'),
        permissionPresetId: 'read_only' as const,
        stageRole: 'scout' as const
      },
      {
        ...participant('scout-b', 'claude', 2, 'Scout B'),
        permissionPresetId: 'read_only' as const,
        stageRole: 'scout' as const
      }
    ]
    const testHarness = harness(
      [chat('shared-prep-failure', scouts, { fanoutPolicy: 'read_only' })],
      admission,
      {
        resolveInstructionContext: () => {
          throw new Error('injected shared preparation failure')
        }
      }
    )

    testHarness.orchestrator.startRound({
      chatId: 'shared-prep-failure',
      prompt: 'Run both scouts.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => {
      const runs = testHarness.chats.get('shared-prep-failure')?.runs || []
      expect(runs).toHaveLength(2)
      expect(runs.every((run) => run.status === 'failed')).toBe(true)
    })

    expect(testHarness.dispatched).toHaveLength(0)
    expect(testHarness.chats.get('shared-prep-failure')?.runs).toHaveLength(2)
    expect(
      testHarness.chats.get('shared-prep-failure')?.runs.every((run) => run.status === 'failed')
    ).toBe(true)
    expect(testHarness.chats.get('shared-prep-failure')?.ensemble?.activeRound?.status).not.toBe(
      'running'
    )
    expect(admission.scheduler.snapshot().occupancy).toMatchObject({ active: 0, queued: 0 })
    await admission.scheduler.whenIdle()
  })

  it('queues foreground runs across chats before prompt materialization and releases only on dispatch settlement', async () => {
    const admission = controlledScheduler({ maxActive: 1, maxForeground: 1 })
    const testHarness = harness(
      [
        chat('chat-a', [participant('a', 'codex', 1)]),
        chat('chat-b', [participant('b', 'claude', 1)]),
        chat('chat-c', [participant('c', 'grok', 1)])
      ],
      admission
    )

    for (const chatId of ['chat-a', 'chat-b', 'chat-c']) {
      expect(
        testHarness.orchestrator.startRound({
          chatId,
          prompt: `Run ${chatId}.`,
          event: { sender: {} as Electron.WebContents }
        }).status
      ).toBe('started')
    }

    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(1))
    expect(testHarness.preparedRunIds).toHaveLength(1)
    expect(testHarness.dispatched[0].appChatId).toBe('chat-a')
    expect(testHarness.orchestrator.getHostAdmissionSnapshot().occupancy).toMatchObject({
      active: 1,
      queued: 2,
      activeForeground: 1
    })
    expect(testHarness.chats.get('chat-a')?.runs.at(-1)?.status).toBe('running')
    expect(testHarness.chats.get('chat-b')?.runs.at(-1)?.status).toBe('queued')
    expect(testHarness.chats.get('chat-c')?.runs.at(-1)?.status).toBe('queued')

    const first = testHarness.dispatched[0]
    finish(testHarness, first)
    // Logical provider completion alone must not free the slot while the exact
    // dispatch promise still owns adapter teardown.
    await Promise.resolve()
    expect(testHarness.orchestrator.getHostAdmissionSnapshot().occupancy).toMatchObject({
      active: 1,
      queued: 2
    })
    expect(testHarness.preparedRunIds).toHaveLength(1)

    testHarness.settle(first.appRunId || '')
    await vi.waitFor(() => expect(admission.scheduledCount()).toBe(1))
    admission.runOne()
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(2))
    expect(testHarness.dispatched[1].appChatId).toBe('chat-b')
    expect(testHarness.preparedRunIds).toHaveLength(2)

    const second = testHarness.dispatched[1]
    finish(testHarness, second)
    testHarness.settle(second.appRunId || '')
    await vi.waitFor(() => expect(admission.scheduledCount()).toBe(1))
    admission.runOne()
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(3))
    expect(testHarness.dispatched[2].appChatId).toBe('chat-c')

    const third = testHarness.dispatched[2]
    finish(testHarness, third)
    testHarness.settle(third.appRunId || '')
    await admission.scheduler.whenIdle()
    expect(testHarness.orchestrator.getHostAdmissionSnapshot().metrics).toMatchObject({
      admitted: 3,
      released: 3,
      peakActive: 1,
      peakQueued: 2
    })
  })

  it('history-cancels a queued round and reuses the capacity for a fresh admission', async () => {
    const admission = controlledScheduler({ maxActive: 1, maxForeground: 1 })
    const testHarness = harness(
      [
        chat('history-holder', [participant('holder', 'codex', 1)]),
        chat('history-queued', [participant('queued', 'claude', 1)])
      ],
      admission
    )
    testHarness.orchestrator.startRound({
      chatId: 'history-holder',
      prompt: 'Hold the only slot.',
      event: { sender: {} as Electron.WebContents }
    })
    testHarness.orchestrator.startRound({
      chatId: 'history-queued',
      prompt: 'Queue for history cancellation.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(1))
    expect(testHarness.orchestrator.getHostAdmissionSnapshot().occupancy).toMatchObject({
      active: 1,
      queued: 1
    })

    await expect(
      testHarness.orchestrator.cancelRoundForHistory('history-queued', 'history delete regression')
    ).resolves.toBe(true)
    expect(testHarness.orchestrator.getHostAdmissionSnapshot().occupancy).toMatchObject({
      active: 1,
      queued: 0
    })

    const fresh = chat('history-fresh', [participant('fresh', 'grok', 1)])
    testHarness.chats.set(fresh.appChatId, fresh)
    testHarness.orchestrator.startRound({
      chatId: 'history-fresh',
      prompt: 'Use the recovered queue position.',
      event: { sender: {} as Electron.WebContents }
    })
    const holder = testHarness.dispatched[0]
    finish(testHarness, holder)
    testHarness.settle(holder.appRunId || '')
    await vi.waitFor(() => expect(admission.scheduledCount()).toBe(1))
    admission.runOne()
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(2))
    expect(testHarness.dispatched[1].appChatId).toBe('history-fresh')

    const freshPayload = testHarness.dispatched[1]
    finish(testHarness, freshPayload)
    testHarness.settle(freshPayload.appRunId || '')
    await admission.scheduler.whenIdle()
  })

  it('returns fan-out lane ids while excess lanes remain pending and cancels a queued lane without dispatch', async () => {
    const admission = controlledScheduler({ maxActive: 2, maxForeground: 1 })
    const ensemble = chat(
      'fanout-chat',
      [
        participant('boss', 'codex', 1, 'Lead'),
        participant('reviewer', 'claude', 2, 'Reviewer'),
        participant('researcher', 'grok', 3, 'Researcher')
      ],
      { fanoutPolicy: 'read_only', bossId: 'boss' }
    )
    const testHarness = harness([ensemble], admission)
    testHarness.orchestrator.startRound({
      chatId: 'fanout-chat',
      prompt: 'Lead delegates both checks.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(1))
    const boss = testHarness.dispatched[0]

    const fanout = await Promise.race([
      testHarness.orchestrator.fanoutForRun(boss.appRunId, {
        targets: ['Reviewer', 'Researcher'],
        prompt: 'Check independently.'
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('fan-out waited for host capacity')), 1_000)
      )
    ])

    expect(fanout).toMatchObject({
      ok: true,
      status: 'queued',
      hostAdmission: { admitted: 1, queued: 1, active: 2, capacity: 2, waiting: 1 }
    })
    expect(fanout.laneIds).toHaveLength(2)
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(2))
    await vi.waitFor(() =>
      expect(
        Object.values(
          testHarness.chats.get('fanout-chat')?.ensemble?.activeRound?.lanes || {}
        ).some((lane) => lane.status === 'running')
      ).toBe(true)
    )

    const round = testHarness.chats.get('fanout-chat')?.ensemble?.activeRound
    const lanes = Object.values(round?.lanes || {})
    const queuedLane = lanes.find((lane) => lane.status === 'pending')
    const runningLane = lanes.find((lane) => lane.status === 'running')
    expect(queuedLane).toBeDefined()
    expect(runningLane).toBeDefined()
    expect(
      testHarness.chats.get('fanout-chat')?.runs.find((run) => run.runId === queuedLane?.runId)
        ?.status
    ).toBe('queued')

    expect(
      await testHarness.orchestrator.skipFanoutLane('fanout-chat', queuedLane?.laneId || '')
    ).toBe(true)
    expect(testHarness.dispatched.some((payload) => payload.appRunId === queuedLane?.runId)).toBe(
      false
    )

    const lanePayload = testHarness.dispatched.find(
      (payload) => payload.appRunId === runningLane?.runId
    )
    if (!lanePayload) throw new Error('Expected one admitted fan-out payload.')
    finish(testHarness, lanePayload)
    testHarness.settle(lanePayload.appRunId || '')
    await testHarness.orchestrator.cancelRound('fanout-chat', 'test cleanup')
    testHarness.settle(boss.appRunId || '')
    await admission.scheduler.whenIdle()
    expect(testHarness.orchestrator.getHostAdmissionSnapshot().occupancy).toMatchObject({
      active: 0,
      queued: 0
    })
  })

  it('re-reads a seat permission revocation after admitted compaction', async () => {
    const admission = controlledScheduler({ maxActive: 2, maxForeground: 1 })
    let resolveCompaction!: () => void
    const compaction = new Promise<void>((resolve) => {
      resolveCompaction = resolve
    })
    let compactionStarted = false
    const ensemble = chat(
      'revocation-chat',
      [
        participant('revocation-boss', 'codex', 1, 'Lead'),
        participant('revoked-seat', 'claude', 2, 'Revoked Seat')
      ],
      { fanoutPolicy: 'read_only', bossId: 'revocation-boss' }
    )
    const testHarness = harness([ensemble], admission, {
      awaitPendingSeatCompaction: (_chatId, participantId) => {
        if (participantId !== 'revoked-seat') return undefined
        compactionStarted = true
        return compaction
      }
    })
    testHarness.orchestrator.startRound({
      chatId: 'revocation-chat',
      prompt: 'Delegate after compaction.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(1))
    const boss = testHarness.dispatched[0]
    const fanout = testHarness.orchestrator.fanoutForRun(boss.appRunId, {
      targets: ['Revoked Seat'],
      prompt: 'Inspect the workspace.'
    })
    await vi.waitFor(() => expect(compactionStarted).toBe(true))

    const current = testHarness.chats.get('revocation-chat')!
    testHarness.chats.set('revocation-chat', {
      ...current,
      ensemble: {
        ...current.ensemble!,
        participants: current.ensemble!.participants.map((entry) =>
          entry.id === 'revoked-seat' ? { ...entry, permissionPresetId: 'read_only' } : entry
        )
      }
    })
    resolveCompaction()
    await expect(fanout).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(2))
    const revokedPayload = testHarness.dispatched[1]
    expect(revokedPayload.effectivePermissions).toMatchObject({ readOnly: true })

    finish(testHarness, revokedPayload)
    testHarness.settle(revokedPayload.appRunId || '')
    await testHarness.orchestrator.cancelRound('revocation-chat', 'revocation test cleanup')
    testHarness.settle(boss.appRunId || '')
    await admission.scheduler.whenIdle()
  })

  it('recovers a hung dispatch slot only after exact cancellation proves no live transport', async () => {
    const admission = controlledScheduler({ maxActive: 1, maxForeground: 1 })
    const testHarness = harness(
      [
        chat('hung-chat', [participant('hung', 'codex', 1)]),
        chat('next-chat', [participant('next', 'claude', 1)])
      ],
      admission,
      { hasLiveRunTransport: () => false }
    )
    testHarness.orchestrator.startRound({
      chatId: 'hung-chat',
      prompt: 'Hang before facade settlement.',
      event: { sender: {} as Electron.WebContents }
    })
    testHarness.orchestrator.startRound({
      chatId: 'next-chat',
      prompt: 'Wait behind the hung run.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(1))

    await testHarness.orchestrator.cancelRound('hung-chat', 'cancel hung dispatch')
    await vi.waitFor(() => expect(admission.scheduledCount()).toBe(1))
    admission.runOne()
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(2))
    expect(testHarness.dispatched[1].appChatId).toBe('next-chat')

    const next = testHarness.dispatched[1]
    finish(testHarness, next)
    testHarness.settle(next.appRunId || '')
    await admission.scheduler.whenIdle()
  })

  it('retains a cancelled dispatch slot while RunManager still reports a live transport', async () => {
    const admission = controlledScheduler({ maxActive: 1, maxForeground: 1 })
    const testHarness = harness(
      [
        chat('live-chat', [participant('live', 'codex', 1)]),
        chat('blocked-chat', [participant('blocked', 'claude', 1)])
      ],
      admission,
      { hasLiveRunTransport: () => true }
    )
    testHarness.orchestrator.startRound({
      chatId: 'live-chat',
      prompt: 'Keep transport live.',
      event: { sender: {} as Electron.WebContents }
    })
    testHarness.orchestrator.startRound({
      chatId: 'blocked-chat',
      prompt: 'Stay queued.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(1))
    const live = testHarness.dispatched[0]

    await testHarness.orchestrator.cancelRound('live-chat', 'transport remains attached')
    expect(testHarness.orchestrator.getHostAdmissionSnapshot().occupancy).toMatchObject({
      active: 1,
      queued: 1
    })
    expect(admission.scheduledCount()).toBe(0)

    testHarness.settle(live.appRunId || '')
    await vi.waitFor(() => expect(admission.scheduledCount()).toBe(1))
    admission.runOne()
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(2))
    const blocked = testHarness.dispatched[1]
    finish(testHarness, blocked)
    testHarness.settle(blocked.appRunId || '')
    await admission.scheduler.whenIdle()
  })

  it('recovers after a bounded exact-cancel timeout when registries prove no transport', async () => {
    const admission = controlledScheduler({ maxActive: 1, maxForeground: 1 })
    const testHarness = harness(
      [
        chat('cancel-hangs', [participant('hung-cancel', 'codex', 1)]),
        chat('after-cancel-hang', [participant('after', 'claude', 1)])
      ],
      admission,
      {
        cancelRun: () => new Promise<boolean>(() => undefined),
        hasLiveRunTransport: () => false,
        exactCancellationProofTimeoutMs: 5
      }
    )
    testHarness.orchestrator.startRound({
      chatId: 'cancel-hangs',
      prompt: 'Cancellation facade will hang.',
      event: { sender: {} as Electron.WebContents }
    })
    testHarness.orchestrator.startRound({
      chatId: 'after-cancel-hang',
      prompt: 'Wait for proof-based recovery.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(1))

    await testHarness.orchestrator.cancelRound('cancel-hangs', 'bounded cancellation proof')
    await vi.waitFor(() => expect(admission.scheduledCount()).toBe(1))
    admission.runOne()
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(2))
    const next = testHarness.dispatched[1]
    finish(testHarness, next)
    testHarness.settle(next.appRunId || '')
    await admission.scheduler.whenIdle()
  })

  it('shutdown cancels queued work and joins an exact live dispatch before returning', async () => {
    const admission = controlledScheduler({ maxActive: 1, maxForeground: 1 })
    const testHarness = harness(
      [
        chat('shutdown-live', [participant('live', 'codex', 1)]),
        chat('shutdown-queued', [participant('queued', 'claude', 1)])
      ],
      admission,
      { hasLiveRunTransport: () => true }
    )
    testHarness.orchestrator.startRound({
      chatId: 'shutdown-live',
      prompt: 'Hold shutdown.',
      event: { sender: {} as Electron.WebContents }
    })
    testHarness.orchestrator.startRound({
      chatId: 'shutdown-queued',
      prompt: 'Cancel before dispatch.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(testHarness.dispatched).toHaveLength(1))
    const live = testHarness.dispatched[0]
    let shutdownSettled = false
    const shutdown = testHarness.orchestrator.shutdownHostAdmission().then((result) => {
      shutdownSettled = true
      return result
    })

    await vi.waitFor(() =>
      expect(testHarness.orchestrator.getHostAdmissionSnapshot().occupancy).toMatchObject({
        active: 1,
        queued: 0,
        shuttingDown: true
      })
    )
    expect(shutdownSettled).toBe(false)
    expect(testHarness.dispatched).toHaveLength(1)

    testHarness.settle(live.appRunId || '')
    await expect(shutdown).resolves.toMatchObject({
      cancelledQueued: 1,
      occupancy: { shuttingDown: true }
    })
    expect(shutdownSettled).toBe(true)
    expect(testHarness.orchestrator.getHostAdmissionSnapshot().occupancy).toMatchObject({
      active: 0,
      queued: 0
    })
  })
})
