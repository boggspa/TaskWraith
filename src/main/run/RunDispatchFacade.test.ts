// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  authorizeMainOwnedScheduledOccurrenceDispatch,
  createRunDispatchFacade,
  type RunDispatchFacadeDeps
} from './RunDispatchFacade'
import type { AgentRunPayload } from './AgentRunTypes'
import {
  ScheduledOccurrenceOwnerRegistry,
  type ScheduledOccurrenceOwner
} from '../ScheduledOccurrenceOwnerRegistry'
import { HistoryClearAdmissionGate } from '../HistoryClearAdmissionGate'
import { RegenerableHistoryByteStore } from '../services/RegenerableHistoryByteStore'

// The 3 pure helpers direct-import in the facade → vi.mock them (M3-1b precedent).
vi.mock('../ProviderRunPause', () => ({
  resolveProviderDispatch: vi.fn((_settings: unknown, provider: string) => ({ provider })),
  applyReroutePlanToPayload: vi.fn((payload: unknown) => payload)
}))
vi.mock('../WorkflowBudgetGuard', () => ({
  hasAnyBudget: vi.fn(() => false)
}))

import { resolveProviderDispatch, applyReroutePlanToPayload } from '../ProviderRunPause'
import { hasAnyBudget } from '../WorkflowBudgetGuard'

/**
 * M3-2b wrapper-net for the relocated dispatch orchestrator. RunCoordinator.test
 * covers `.dispatch()`; this test fences the ORCHESTRATION LAYER above it — the
 * ORDERED SIDE-EFFECT SEQUENCE + the conditional guards, because the real risk in
 * relocating a side-effect orchestrator is reordering or dropping a guard.
 */

// Build a deps bundle whose every method appends its name to a shared order log,
// so the test can assert the exact side-effect ordering.
function makeDeps(order: string[]): RunDispatchFacadeDeps {
  return {
    applyFailoverReroutePosture: vi.fn(() => {
      order.push('applyFailoverReroutePosture')
    }),
    repairKnownStaleGeminiMcpBridgeConfigs: vi.fn(async () => {
      order.push('repair')
    }),
    expandPdfImagePathsForPayload: vi.fn(async () => {
      order.push('expandPdf')
    }),
    captureFailoverSnapshot: vi.fn(() => {
      order.push('captureFailoverSnapshot')
      return { snap: true } as never
    }),
    scheduledOccurrenceOwners: new ScheduledOccurrenceOwnerRegistry(),
    workflowBudgetRegistry: {
      register: vi.fn(() => {
        order.push('workflowBudgetRegistry.register')
      })
    } as never,
    failoverSnapshotByRun: {
      set: vi.fn(() => {
        order.push('failoverSnapshotByRun.set')
      })
    } as never,
    runCoordinator: {
      dispatch: vi.fn(async () => {
        order.push('runCoordinator.dispatch')
        return { dispatched: true, appRunId: 'run-1' }
      })
    } as never,
    reserveDispatch: vi.fn(() => Object.freeze({ id: 'dispatch-reservation' })),
    releaseDispatchReservation: vi.fn(),
    getSettings: vi.fn(() => {
      order.push('getSettings')
      return { workflowBudgetKillEnabled: true, autoFailoverEnabled: true } as never
    }),
    getScheduledTasks: vi.fn(() => {
      order.push('getScheduledTasks')
      return [{ id: 'task-1', workflowId: 'wf-1' }] as never
    }),
    getWorkflowDefinitions: vi.fn(() => {
      order.push('getWorkflowDefinitions')
      return [{ id: 'wf-1', limits: { timeoutSeconds: 1, maxTokens: 2, maxCostUsd: 3 } }] as never
    }),
    wasDurableScheduledRunIdObserved: vi.fn(() => false)
  }
}

const senderEvent = { sender: {} } as never
function payload(overrides: Partial<AgentRunPayload> = {}): AgentRunPayload {
  return {
    provider: 'codex',
    scope: 'workspace',
    workspace: '/repo',
    prompt: 'go',
    appRunId: 'run-1',
    appChatId: 'chat-1',
    ...overrides
  } as AgentRunPayload
}

function scheduledPayload(
  overrides: Partial<AgentRunPayload> & { scheduledTaskId?: string } = {}
): AgentRunPayload {
  return {
    ...payload(),
    scheduledTaskId: 'task-1',
    ...overrides
  } as AgentRunPayload
}

function registerScheduledOwner(
  deps: RunDispatchFacadeDeps,
  overrides: Partial<ScheduledOccurrenceOwner> = {}
): ScheduledOccurrenceOwner {
  return deps.scheduledOccurrenceOwners.register({
    taskId: 'task-1',
    ownerRunId: 'run-1',
    provider: 'codex',
    chatId: 'chat-1',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    rootOwner: 'solo',
    ...overrides
  })
}

function registerLoopChildOwner(deps: RunDispatchFacadeDeps): ScheduledOccurrenceOwner {
  const owner = registerScheduledOwner(deps, {
    ownerRunId: 'loop-root-run',
    rootOwner: 'loop-root'
  })
  deps.scheduledOccurrenceOwners.bindLoopChildRun(
    'loop-child-run',
    owner.ownerRunId,
    'claude'
  )
  return owner
}

function registerEnsembleRoundOwner(deps: RunDispatchFacadeDeps): ScheduledOccurrenceOwner {
  const owner = registerScheduledOwner(deps, {
    ownerRunId: 'ensemble-root-run',
    rootOwner: 'ensemble-root'
  })
  deps.scheduledOccurrenceOwners.bindEnsembleRound('round-1', owner.ownerRunId)
  deps.scheduledOccurrenceOwners.bindEnsembleChildRun(
    'ensemble-seat-run',
    'round-1',
    'claude'
  )
  return owner
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveProviderDispatch).mockImplementation(
    (_settings, provider) => ({ provider }) as never
  )
  vi.mocked(applyReroutePlanToPayload).mockImplementation((p: unknown) => p as never)
  vi.mocked(hasAnyBudget).mockReturnValue(false)
})

describe('createRunDispatchFacade — ordered side-effect sequence (faked deps)', () => {
  it('forwards the adapter-invocation observer through the facade reservation', async () => {
    const deps = makeDeps([])
    const observer = { onAdapterInvoked: vi.fn() }

    await createRunDispatchFacade(deps)(payload(), senderEvent, observer)

    expect(deps.runCoordinator.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ appRunId: 'run-1' }),
      senderEvent,
      expect.objectContaining({ id: 'dispatch-reservation' }),
      observer
    )
  })

  it('runs the ordinary reroute and failover-snapshot sequence in order', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(resolveProviderDispatch).mockReturnValue({
      provider: 'claude',
      reroute: { from: 'codex', to: 'claude', reason: 'provider-paused' }
    } as never)
    vi.mocked(applyReroutePlanToPayload).mockImplementation(
      (p: unknown) => ({ ...(p as object), provider: 'claude', failoverHopCount: 1 }) as never
    )

    const result = await createRunDispatchFacade(deps)(payload(), senderEvent)

    expect(result).toEqual({ dispatched: true, appRunId: 'run-1' })
    expect(order).toEqual([
      'getScheduledTasks', // ordinary run-id replay fence
      'getSettings', // resolveProviderDispatch arg (pure helper is mocked, not logged)
      'applyFailoverReroutePosture', // reroute + failoverHopCount guard
      'repair',
      'expandPdf',
      'runCoordinator.dispatch',
      'getSettings', // autoFailover check
      'captureFailoverSnapshot',
      'failoverSnapshotByRun.set'
    ])
    expect(vi.mocked(deps.failoverSnapshotByRun.set)).toHaveBeenCalledWith('run-1', { snap: true })
    expect(deps.scheduledOccurrenceOwners.hasOrdinaryChatDispatchReservation('chat-1')).toBe(
      false
    )
  })

  it.each(['config repair', 'PDF expansion'] as const)(
    'rejects a pre-clear payload when chat truncation completes during paused %s',
    async (pausedStage) => {
      const deps = makeDeps([])
      const gate = new HistoryClearAdmissionGate()
      const authority = {
        appChatId: 'chat-1',
        workspaceId: 'workspace-1',
        persistenceRevision: 7
      }
      let resume!: () => void
      const paused = new Promise<void>((resolve) => {
        resume = resolve
      })
      const reservation = gate.reserveDispatch(authority)
      vi.mocked(deps.reserveDispatch).mockReturnValue(reservation)
      vi.mocked(deps.releaseDispatchReservation).mockImplementation((received) => {
        gate.releaseDispatch(received as typeof reservation)
      })
      if (pausedStage === 'config repair') {
        vi.mocked(deps.repairKnownStaleGeminiMcpBridgeConfigs).mockReturnValue(paused)
      } else {
        vi.mocked(deps.expandPdfImagePathsForPayload).mockReturnValue(paused)
      }
      vi.mocked(deps.runCoordinator.dispatch).mockImplementation(
        async (_payload, _event, received) => {
          if (!gate.authorizeDispatch(received as typeof reservation, authority)) {
            throw new Error('Dispatch chat authority changed before adapter launch.')
          }
          return { dispatched: true, appRunId: 'run-1' }
        }
      )

      const dispatch = createRunDispatchFacade(deps)(payload(), senderEvent)
      const pausedMock =
        pausedStage === 'config repair'
          ? vi.mocked(deps.repairKnownStaleGeminiMcpBridgeConfigs)
          : vi.mocked(deps.expandPdfImagePathsForPayload)
      for (let flush = 0; flush < 5 && pausedMock.mock.calls.length === 0; flush++) {
        await Promise.resolve()
      }
      expect(pausedMock).toHaveBeenCalledOnce()
      expect(vi.mocked(deps.reserveDispatch).mock.invocationCallOrder[0]).toBeLessThan(
        pausedMock.mock.invocationCallOrder[0]
      )
      gate.beginChat('chat-1')
      gate.endChat('chat-1')
      resume()

      await expect(dispatch).rejects.toThrow('authority changed before adapter launch')
      expect(deps.runCoordinator.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ appChatId: 'chat-1' }),
        senderEvent,
        reservation
      )
      expect(deps.releaseDispatchReservation).toHaveBeenCalledWith(reservation)
    }
  )

  it('rejects an ordinary run while the chat has a scheduled owner', async () => {
    const deps = makeDeps([])
    registerScheduledOwner(deps)

    await expect(createRunDispatchFacade(deps)(payload({ appRunId: 'ordinary-run' }), senderEvent))
      .rejects.toThrow('already has a live dispatch owner')
    expect(deps.repairKnownStaleGeminiMcpBridgeConfigs).not.toHaveBeenCalled()
    expect(deps.runCoordinator.dispatch).not.toHaveBeenCalled()
  })

  it('releases an ordinary chat reservation when dispatch throws', async () => {
    const deps = makeDeps([])
    vi.mocked(deps.runCoordinator.dispatch).mockRejectedValueOnce(
      new Error('Injected adapter failure.')
    )

    await expect(createRunDispatchFacade(deps)(payload(), senderEvent)).rejects.toThrow(
      'Injected adapter failure.'
    )
    expect(deps.scheduledOccurrenceOwners.hasOrdinaryChatDispatchReservation('chat-1')).toBe(
      false
    )
  })

  // Ensemble fan-out launches its lanes concurrently into ONE chat, and the
  // default Claude SDK path holds runCoordinator.dispatch open for its whole
  // turn — overlapping ordinary dispatches on a chat are legitimate. Only a
  // scheduled claim must stay excluded while any of them is mid-flight.
  it('dispatches concurrent ordinary runs into one chat (fan-out lanes)', async () => {
    const deps = makeDeps([])
    const gates: Array<() => void> = []
    vi.mocked(deps.runCoordinator.dispatch).mockImplementation(
      (dispatchPayload: AgentRunPayload) =>
        new Promise<{ dispatched: boolean; appRunId: string }>((resolve) => {
          gates.push(() =>
            resolve({ dispatched: true, appRunId: dispatchPayload.appRunId ?? '' })
          )
        })
    )

    const facade = createRunDispatchFacade(deps)
    const first = facade(payload({ appRunId: 'lane-run-1' }), senderEvent)
    const second = facade(payload({ appRunId: 'lane-run-2' }), senderEvent)
    for (let flush = 0; flush < 50 && gates.length < 2; flush++) await Promise.resolve()
    expect(gates).toHaveLength(2)

    expect(deps.scheduledOccurrenceOwners.hasOrdinaryChatDispatchReservation('chat-1')).toBe(
      true
    )
    expect(() => registerScheduledOwner(deps)).toThrow('already has a live dispatch owner')

    for (const open of gates) open()
    await expect(first).resolves.toEqual({ dispatched: true, appRunId: 'lane-run-1' })
    await expect(second).resolves.toEqual({ dispatched: true, appRunId: 'lane-run-2' })
    expect(deps.scheduledOccurrenceOwners.hasOrdinaryChatDispatchReservation('chat-1')).toBe(
      false
    )
  })

  it('accepts an exact live scheduled owner and registers only its budget before dispatch', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    registerScheduledOwner(deps)
    vi.mocked(hasAnyBudget).mockReturnValue(true)

    const result = await createRunDispatchFacade(deps)(
      authorizeMainOwnedScheduledOccurrenceDispatch(scheduledPayload()),
      senderEvent
    )

    expect(result).toEqual({ dispatched: true, appRunId: 'run-1' })
    expect(order).toEqual([
      'getSettings',
      'repair',
      'expandPdf',
      'getSettings',
      'getScheduledTasks',
      'getWorkflowDefinitions',
      'workflowBudgetRegistry.register',
      'runCoordinator.dispatch'
    ])
    expect(deps.workflowBudgetRegistry.register).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        scheduledTaskId: 'task-1',
        provider: 'codex'
      })
    )
    expect(deps.failoverSnapshotByRun.set).not.toHaveBeenCalled()
  })

  it('dispatches a bound loop child without treating it as replay or failover input', async () => {
    const deps = makeDeps([])
    registerLoopChildOwner(deps)
    vi.mocked(hasAnyBudget).mockReturnValue(true)

    const result = await createRunDispatchFacade(deps)(
      authorizeMainOwnedScheduledOccurrenceDispatch(payload({
        appRunId: 'loop-child-run',
        provider: 'claude',
        workspace: '/real/repo'
      })),
      senderEvent
    )

    expect(result.dispatched).toBe(true)
    expect(deps.workflowBudgetRegistry.register).not.toHaveBeenCalled()
    expect(deps.captureFailoverSnapshot).not.toHaveBeenCalled()
    expect(deps.failoverSnapshotByRun.set).not.toHaveBeenCalled()
  })

  it('dispatches a bound ensemble participant without capturing failover state', async () => {
    const deps = makeDeps([])
    registerEnsembleRoundOwner(deps)
    vi.mocked(hasAnyBudget).mockReturnValue(true)

    const result = await createRunDispatchFacade(deps)(
      authorizeMainOwnedScheduledOccurrenceDispatch(payload({
        appRunId: 'ensemble-seat-run',
        provider: 'claude',
        workspace: '/real/repo',
        ensembleRun: {
          roundId: 'round-1',
          participantId: 'seat-1',
          provider: 'claude',
          role: 'Reviewer',
          order: 1
        }
      })),
      senderEvent
    )

    expect(result.dispatched).toBe(true)
    expect(deps.workflowBudgetRegistry.register).not.toHaveBeenCalled()
    expect(deps.captureFailoverSnapshot).not.toHaveBeenCalled()
    expect(deps.failoverSnapshotByRun.set).not.toHaveBeenCalled()
  })

  it('rejects a bound scheduled child under a substituted provider', async () => {
    const deps = makeDeps([])
    registerLoopChildOwner(deps)

    await expect(
      createRunDispatchFacade(deps)(
        authorizeMainOwnedScheduledOccurrenceDispatch(
          payload({ appRunId: 'loop-child-run', provider: 'codex' })
        ),
        senderEvent
      )
    ).rejects.toThrow('requires one-shot MAIN authorization')
    expect(deps.runCoordinator.dispatch).not.toHaveBeenCalled()
  })

  it('skips applyFailoverReroutePosture when there is no reroute (guard preserved)', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    // default mocks: reroute=false
    await createRunDispatchFacade(deps)(payload(), senderEvent)

    expect(order).not.toContain('applyFailoverReroutePosture')
    expect(vi.mocked(deps.runCoordinator.dispatch)).toHaveBeenCalledOnce() // dispatch still runs
  })

  it('skips the failover snapshot for a /compact dispatch (guard preserved)', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    await createRunDispatchFacade(deps)(payload({ prompt: '/compact' }), senderEvent)

    expect(order).toContain('runCoordinator.dispatch')
    expect(order).not.toContain('captureFailoverSnapshot')
    expect(order).not.toContain('failoverSnapshotByRun.set')
  })

  it('skips workflowBudgetRegistry.register when there is no budget (guard preserved)', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    registerScheduledOwner(deps)
    vi.mocked(hasAnyBudget).mockReturnValue(false)

    await createRunDispatchFacade(deps)(
      authorizeMainOwnedScheduledOccurrenceDispatch(scheduledPayload()),
      senderEvent
    )

    expect(order).not.toContain('workflowBudgetRegistry.register')
    expect(vi.mocked(deps.runCoordinator.dispatch)).toHaveBeenCalledOnce()
  })

  it('does not abort dispatch when best-effort config repair rejects', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    deps.repairKnownStaleGeminiMcpBridgeConfigs = vi.fn(async () => {
      throw new Error('repair boom')
    })

    const result = await createRunDispatchFacade(deps)(payload(), senderEvent)

    expect(result).toEqual({ dispatched: true, appRunId: 'run-1' })
    expect(vi.mocked(deps.runCoordinator.dispatch)).toHaveBeenCalledOnce()
  })

  it('fails closed before provider launch when PDF preparation is revoked', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    deps.expandPdfImagePathsForPayload = vi.fn(async () => {
      throw new Error(
        'PDF attachment preparation was interrupted by history deletion; retry the dispatch.'
      )
    })

    await expect(createRunDispatchFacade(deps)(payload(), senderEvent)).rejects.toThrow(
      'interrupted by history deletion'
    )

    expect(deps.runCoordinator.dispatch).not.toHaveBeenCalled()
    expect(deps.captureFailoverSnapshot).not.toHaveBeenCalled()
    expect(deps.releaseDispatchReservation).toHaveBeenCalledOnce()
    expect(deps.scheduledOccurrenceOwners.hasOrdinaryChatDispatchReservation('chat-1')).toBe(
      false
    )
  })

  it('rejects rather than stripping a PDF when an unrelated clear revokes its derived generation', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'taskwraith-pdf-revocation-'))
    const mediaRoot = join(storeRoot, 'media')
    const pdfRoot = join(storeRoot, 'pdf')
    mkdirSync(mediaRoot)
    mkdirSync(pdfRoot)
    const store = new RegenerableHistoryByteStore({
      roots: { media: mediaRoot, pdf: pdfRoot },
      journalPath: join(storeRoot, 'derived-purge.json')
    })

    try {
      await store.initializeStrict()
      const deps = makeDeps([])
      let expansionStarted!: () => void
      let resumeExpansion!: () => void
      const started = new Promise<void>((resolve) => {
        expansionStarted = resolve
      })
      const resume = new Promise<void>((resolve) => {
        resumeExpansion = resolve
      })
      let expansionPayload: AgentRunPayload | undefined
      deps.expandPdfImagePathsForPayload = vi.fn(async (candidate) => {
        expansionPayload = candidate
        const reservation = store.begin('pdf')
        expansionStarted()
        try {
          await resume
          if (!store.isCurrent(reservation)) {
            throw new Error(
              'PDF attachment preparation was interrupted by history deletion; retry the dispatch.'
            )
          }
          candidate.imagePaths = []
        } finally {
          expect(store.end(reservation)).toBe(true)
        }
      })

      const dispatch = createRunDispatchFacade(deps)(
        payload({ imagePaths: ['/repo/report.pdf'] }),
        senderEvent
      )
      const rejected = expect(dispatch).rejects.toThrow('interrupted by history deletion')
      await started

      // This operation represents a scoped clear for a different chat. The
      // regenerable byte store is intentionally global, so it revokes the PDF
      // generation synchronously before its strict purge joins the render.
      const hold = store.beginHistoryMutation('unrelated-chat-history-clear')
      const purge = store.purgeStrict(hold)
      resumeExpansion()

      await rejected
      await purge
      expect(store.endHistoryMutation(hold)).toBe(true)
      expect(expansionPayload?.imagePaths).toEqual(['/repo/report.pdf'])
      expect(deps.runCoordinator.dispatch).not.toHaveBeenCalled()
      expect(deps.releaseDispatchReservation).toHaveBeenCalledOnce()
    } finally {
      rmSync(storeRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('does not dispatch a partial multi-PDF expansion', async () => {
    const deps = makeDeps([])
    deps.expandPdfImagePathsForPayload = vi.fn(async (candidate) => {
      expect(candidate.imagePaths).toEqual(['/repo/first.pdf', '/repo/second.pdf'])
      throw new Error(
        'One or more PDF attachments could not be rendered into verified page images; the run was not dispatched with any PDF silently omitted.'
      )
    })

    await expect(
      createRunDispatchFacade(deps)(
        payload({ imagePaths: ['/repo/first.pdf', '/repo/second.pdf'] }),
        senderEvent
      )
    ).rejects.toThrow('One or more PDF attachments could not be rendered')

    expect(deps.runCoordinator.dispatch).not.toHaveBeenCalled()
    expect(deps.releaseDispatchReservation).toHaveBeenCalledOnce()
  })

  it('reconstructs a current main-owned pause reroute and strips an unproven claim', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(resolveProviderDispatch).mockImplementation((_settings, provider) =>
      provider === 'codex'
        ? ({
            provider: 'claude',
            reroute: {
              from: 'codex',
              to: 'claude',
              reason: 'provider-paused',
              savedAsDefault: true
            },
            reroutePlan: {}
          } as never)
        : ({ provider } as never)
    )
    vi.mocked(applyReroutePlanToPayload).mockImplementation((p, resolution) =>
      resolution.reroute
        ? ({ ...p, provider: resolution.provider, providerReroute: resolution.reroute } as never)
        : (p as never)
    )

    await createRunDispatchFacade(deps)(
      payload({
        provider: 'claude',
        providerReroute: {
          from: 'codex',
          to: 'claude',
          reason: 'provider-paused',
          savedAsDefault: true
        }
      }),
      senderEvent
    )
    expect(vi.mocked(deps.runCoordinator.dispatch)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: 'claude',
        providerReroute: expect.objectContaining({ from: 'codex', to: 'claude' })
      }),
      senderEvent,
      expect.any(Object)
    )

    await createRunDispatchFacade(deps)(
      payload({
        provider: 'claude',
        providerReroute: {
          from: 'kimi',
          to: 'claude',
          reason: 'provider-paused'
        }
      }),
      senderEvent
    )
    expect(vi.mocked(deps.runCoordinator.dispatch)).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ providerReroute: expect.anything() }),
      senderEvent,
      expect.any(Object)
    )
  })

  it('preserves the exact target-bound signed posture for a validated composer reroute', async () => {
    const deps = makeDeps([])
    const targetPermissions = { presetId: 'default' } as never
    vi.mocked(resolveProviderDispatch).mockImplementation((_settings, provider) =>
      provider === 'codex'
        ? ({
            provider: 'claude',
            reroute: {
              from: 'codex',
              to: 'claude',
              reason: 'provider-paused',
              savedAsDefault: true
            },
            reroutePlan: {}
          } as never)
        : ({ provider } as never)
    )
    vi.mocked(applyReroutePlanToPayload).mockImplementation((p, resolution) =>
      resolution.reroute
        ? ({
            ...p,
            provider: resolution.provider,
            providerReroute: resolution.reroute,
            effectivePermissions: undefined,
            effectivePermissionsSignature: undefined
          } as never)
        : (p as never)
    )

    await createRunDispatchFacade(deps)(
      payload({
        provider: 'claude',
        providerReroute: {
          from: 'codex',
          to: 'claude',
          reason: 'provider-paused',
          savedAsDefault: true
        },
        approvalMode: 'default',
        effectivePermissions: targetPermissions,
        effectivePermissionsSignature: 'main-target-signature'
      }),
      senderEvent
    )

    expect(vi.mocked(deps.runCoordinator.dispatch)).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude',
        effectivePermissions: targetPermissions,
        effectivePermissionsSignature: 'main-target-signature'
      }),
      senderEvent,
      expect.any(Object)
    )
    expect(deps.applyFailoverReroutePosture).not.toHaveBeenCalled()
  })

  it('reconstructs a user-failover claim only when the live resolver proves it exactly', async () => {
    const deps = makeDeps([])
    vi.mocked(resolveProviderDispatch).mockImplementation((_settings, provider) =>
      provider === 'codex'
        ? ({
            provider: 'claude',
            reroute: { from: 'codex', to: 'claude', reason: 'user-failover' },
            reroutePlan: {}
          } as never)
        : ({ provider } as never)
    )
    vi.mocked(applyReroutePlanToPayload).mockImplementation((p, resolution) =>
      resolution.reroute
        ? ({ ...p, provider: resolution.provider, providerReroute: resolution.reroute } as never)
        : (p as never)
    )
    await createRunDispatchFacade(deps)(
      payload({
        provider: 'claude',
        providerReroute: { from: 'codex', to: 'claude', reason: 'user-failover' }
      }),
      senderEvent
    )
    expect(vi.mocked(deps.runCoordinator.dispatch)).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude',
        providerReroute: { from: 'codex', to: 'claude', reason: 'user-failover' }
      }),
      senderEvent,
      expect.any(Object)
    )
  })

  it('does not capture a failover snapshot when dispatch is rejected', async () => {
    const deps = makeDeps([])
    vi.mocked(deps.runCoordinator.dispatch).mockResolvedValueOnce({
      dispatched: false,
      appRunId: 'run-1'
    })

    await createRunDispatchFacade(deps)(payload(), senderEvent)

    expect(deps.captureFailoverSnapshot).not.toHaveBeenCalled()
    expect(deps.failoverSnapshotByRun.set).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'missing owner',
      register: false,
      overrides: {}
    },
    {
      label: 'mismatched task',
      register: true,
      overrides: { scheduledTaskId: 'task-other' }
    },
    {
      label: 'mismatched run',
      register: true,
      overrides: { appRunId: 'run-other' }
    },
    {
      label: 'mismatched provider',
      register: true,
      overrides: { provider: 'claude' as const }
    },
    {
      label: 'mismatched chat',
      register: true,
      overrides: { appChatId: 'chat-other' }
    },
    {
      label: 'global scope',
      register: true,
      overrides: { scope: 'global' as const, workspace: undefined }
    },
    {
      label: 'mismatched workspace',
      register: true,
      overrides: { workspace: '/repo-other' }
    }
  ])(
    'rejects a scheduled payload with $label before repair or adapter dispatch',
    async ({ register, overrides }) => {
      const order: string[] = []
      const deps = makeDeps(order)
      if (register) registerScheduledOwner(deps)

      await expect(
        createRunDispatchFacade(deps)(scheduledPayload(overrides), senderEvent)
      ).rejects.toThrow('Scheduled occurrence dispatch does not match its live solo owner.')

      expect(deps.repairKnownStaleGeminiMcpBridgeConfigs).not.toHaveBeenCalled()
      expect(deps.expandPdfImagePathsForPayload).not.toHaveBeenCalled()
      expect(deps.runCoordinator.dispatch).not.toHaveBeenCalled()
      expect(order).toEqual([])
    }
  )

  it('rejects ordinary replay of either a live or previously persisted scheduled run id', async () => {
    const liveDeps = makeDeps([])
    registerScheduledOwner(liveDeps)

    await expect(createRunDispatchFacade(liveDeps)(payload(), senderEvent)).rejects.toThrow(
      'Ordinary dispatch cannot reuse a scheduled occurrence run id.'
    )
    expect(liveDeps.repairKnownStaleGeminiMcpBridgeConfigs).not.toHaveBeenCalled()
    expect(liveDeps.runCoordinator.dispatch).not.toHaveBeenCalled()

    const persistedDeps = makeDeps([])
    persistedDeps.getScheduledTasks = vi.fn(
      () => [{ id: 'task-observed', runId: 'run-1' }] as never
    )

    await expect(createRunDispatchFacade(persistedDeps)(payload(), senderEvent)).rejects.toThrow(
      'Ordinary dispatch cannot reuse a scheduled occurrence run id.'
    )
    expect(persistedDeps.repairKnownStaleGeminiMcpBridgeConfigs).not.toHaveBeenCalled()
    expect(persistedDeps.runCoordinator.dispatch).not.toHaveBeenCalled()

    const historicalDeps = makeDeps([])
    historicalDeps.wasDurableScheduledRunIdObserved = vi.fn(() => true)
    await expect(createRunDispatchFacade(historicalDeps)(payload(), senderEvent)).rejects.toThrow(
      'Ordinary dispatch cannot reuse a scheduled occurrence run id.'
    )
    expect(historicalDeps.runCoordinator.dispatch).not.toHaveBeenCalled()
  })

  it('rejects provider-pause rerouting for a scheduled owner before repair or dispatch', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    registerScheduledOwner(deps)
    vi.mocked(resolveProviderDispatch).mockReturnValue({
      provider: 'claude',
      reroute: {
        from: 'codex',
        to: 'claude',
        reason: 'provider-paused'
      }
    } as never)

    await expect(
      createRunDispatchFacade(deps)(
        authorizeMainOwnedScheduledOccurrenceDispatch(scheduledPayload()),
        senderEvent
      )
    ).rejects.toThrow('Scheduled occurrence dispatch cannot be rerouted to another provider.')

    expect(deps.repairKnownStaleGeminiMcpBridgeConfigs).not.toHaveBeenCalled()
    expect(deps.expandPdfImagePathsForPayload).not.toHaveBeenCalled()
    expect(deps.runCoordinator.dispatch).not.toHaveBeenCalled()
    expect(order).toEqual(['getSettings'])
  })

  it('rejects provider-pause rerouting for a bound loop child', async () => {
    const deps = makeDeps([])
    registerLoopChildOwner(deps)
    vi.mocked(resolveProviderDispatch).mockReturnValue({
      provider: 'codex',
      reroute: { from: 'claude', to: 'codex', reason: 'provider-paused' }
    } as never)

    await expect(
      createRunDispatchFacade(deps)(
        authorizeMainOwnedScheduledOccurrenceDispatch(
          payload({ appRunId: 'loop-child-run', provider: 'claude' })
        ),
        senderEvent
      )
    ).rejects.toThrow('Scheduled occurrence dispatch cannot be rerouted to another provider.')
    expect(deps.runCoordinator.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a renderer-shaped payload that copies a live scheduled child identity', async () => {
    const deps = makeDeps([])
    registerLoopChildOwner(deps)

    await expect(
      createRunDispatchFacade(deps)(
        payload({ appRunId: 'loop-child-run', provider: 'claude' }),
        senderEvent
      )
    ).rejects.toThrow('requires one-shot MAIN authorization')
    expect(deps.runCoordinator.dispatch).not.toHaveBeenCalled()
  })

  it('rejects an exact live solo occurrence without one-shot MAIN authorization', async () => {
    const deps = makeDeps([])
    registerScheduledOwner(deps)

    await expect(
      createRunDispatchFacade(deps)(scheduledPayload(), senderEvent)
    ).rejects.toThrow('requires one-shot MAIN authorization')
    expect(deps.runCoordinator.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a copied scheduled ensemble child when its round identity is omitted', async () => {
    const deps = makeDeps([])
    registerEnsembleRoundOwner(deps)

    await expect(
      createRunDispatchFacade(deps)(
        payload({ appRunId: 'ensemble-seat-run', provider: 'claude' }),
        senderEvent
      )
    ).rejects.toThrow('does not match its live round')
    expect(deps.runCoordinator.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a copied scheduled ensemble child with a substituted round identity', async () => {
    const deps = makeDeps([])
    registerEnsembleRoundOwner(deps)

    await expect(
      createRunDispatchFacade(deps)(
        payload({
          appRunId: 'ensemble-seat-run',
          provider: 'claude',
          ensembleRun: {
            roundId: 'round-forged',
            participantId: 'seat-1',
            provider: 'claude',
            role: 'Reviewer',
            order: 1
          }
        }),
        senderEvent
      )
    ).rejects.toThrow('does not match its live round')
    expect(deps.runCoordinator.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a scheduled run whose owner settles during asynchronous preparation', async () => {
    const deps = makeDeps([])
    const owner = registerScheduledOwner(deps)
    deps.repairKnownStaleGeminiMcpBridgeConfigs = vi.fn(async () => {
      expect(deps.scheduledOccurrenceOwners.release(owner)).toBe(true)
    })

    await expect(
      createRunDispatchFacade(deps)(
        authorizeMainOwnedScheduledOccurrenceDispatch(scheduledPayload()),
        senderEvent
      )
    ).rejects.toThrow('ownership ended before provider dispatch')
    expect(deps.runCoordinator.dispatch).not.toHaveBeenCalled()
    expect(deps.workflowBudgetRegistry.register).not.toHaveBeenCalled()
  })

  it('never captures an auto-failover snapshot for an accepted scheduled run', async () => {
    const deps = makeDeps([])
    registerScheduledOwner(deps)

    const result = await createRunDispatchFacade(deps)(
      authorizeMainOwnedScheduledOccurrenceDispatch(scheduledPayload()),
      senderEvent
    )

    expect(result.dispatched).toBe(true)
    expect(deps.captureFailoverSnapshot).not.toHaveBeenCalled()
    expect(deps.failoverSnapshotByRun.set).not.toHaveBeenCalled()
  })
})
