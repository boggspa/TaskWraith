// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRunDispatchFacade, type RunDispatchFacadeDeps } from './RunDispatchFacade'
import type { AgentRunPayload } from './AgentRunTypes'

// The 3 pure helpers direct-import in the facade → vi.mock them (M3-1b precedent).
vi.mock('../ProviderRunPause', () => ({
  resolveProviderDispatch: vi.fn(() => ({ reroute: false })),
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
    scheduledTaskIdBySoloRun: {
      set: vi.fn(() => {
        order.push('scheduledTaskIdBySoloRun.set')
      })
    } as never,
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
    })
  }
}

const senderEvent = { sender: {} } as never
function payload(overrides: Partial<AgentRunPayload> = {}): AgentRunPayload {
  return { provider: 'codex', workspace: '/repo', prompt: 'go', appRunId: 'run-1', ...overrides } as AgentRunPayload
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveProviderDispatch).mockReturnValue({ reroute: false } as never)
  vi.mocked(applyReroutePlanToPayload).mockImplementation((p: unknown) => p as never)
  vi.mocked(hasAnyBudget).mockReturnValue(false)
})

describe('createRunDispatchFacade — ordered side-effect sequence (faked deps)', () => {
  it('runs the full ordered side-effect sequence with every guard satisfied', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    vi.mocked(resolveProviderDispatch).mockReturnValue({ reroute: true } as never)
    vi.mocked(applyReroutePlanToPayload).mockImplementation(
      (p: unknown) => ({ ...(p as object), failoverHopCount: 1, scheduledTaskId: 'task-1', appRunId: 'run-1' }) as never
    )
    vi.mocked(hasAnyBudget).mockReturnValue(true)

    const result = await createRunDispatchFacade(deps)(payload(), senderEvent)

    expect(result).toEqual({ dispatched: true, appRunId: 'run-1' })
    expect(order).toEqual([
      'getSettings', // resolveProviderDispatch arg (pure helper is mocked, not logged)
      'applyFailoverReroutePosture', // reroute + failoverHopCount guard
      'repair',
      'expandPdf',
      'scheduledTaskIdBySoloRun.set', // budget-bookkeeping guard
      'getSettings', // budgetSettings
      'getScheduledTasks',
      'getWorkflowDefinitions',
      'workflowBudgetRegistry.register', // hasAnyBudget guard
      'runCoordinator.dispatch',
      'getSettings', // autoFailover check
      'captureFailoverSnapshot', // step 8: snapshot BEFORE the set
      'failoverSnapshotByRun.set'
    ])
    // Step-8 invariant: the captured snapshot is threaded into the set, keyed by appRunId.
    expect(vi.mocked(deps.failoverSnapshotByRun.set)).toHaveBeenCalledWith('run-1', { snap: true })
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
    vi.mocked(applyReroutePlanToPayload).mockImplementation(
      (p: unknown) => ({ ...(p as object), scheduledTaskId: 'task-1', appRunId: 'run-1' }) as never
    )
    vi.mocked(hasAnyBudget).mockReturnValue(false)

    await createRunDispatchFacade(deps)(payload(), senderEvent)

    expect(order).toContain('scheduledTaskIdBySoloRun.set') // bookkeeping still happens
    expect(order).not.toContain('workflowBudgetRegistry.register') // but no budget register
  })

  it('does not abort dispatch when the graceful-fail steps reject', async () => {
    const order: string[] = []
    const deps = makeDeps(order)
    deps.repairKnownStaleGeminiMcpBridgeConfigs = vi.fn(async () => {
      throw new Error('repair boom')
    })
    deps.expandPdfImagePathsForPayload = vi.fn(async () => {
      throw new Error('pdf boom')
    })

    const result = await createRunDispatchFacade(deps)(payload(), senderEvent)

    expect(result).toEqual({ dispatched: true, appRunId: 'run-1' })
    expect(vi.mocked(deps.runCoordinator.dispatch)).toHaveBeenCalledOnce()
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
      senderEvent
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
      senderEvent
    )
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
      senderEvent
    )
  })
})
