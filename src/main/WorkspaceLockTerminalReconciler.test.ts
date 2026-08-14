import { describe, expect, it, vi } from 'vitest'

import { WorkspaceLockTerminalReconciler } from './WorkspaceLockTerminalReconciler'
import type { WorkspaceLockRunLifecycleViolation } from './WorkspaceLockRunLifecycle'

function unresolved(
  runId = 'kimi-old-run',
  operationId = 'kimi-old-run:759'
): WorkspaceLockRunLifecycleViolation {
  return {
    kind: 'unresolved-operation',
    runId,
    operationId,
    startedAt: 100,
    observedAt: 200
  }
}

describe('WorkspaceLockTerminalReconciler', () => {
  it('unblocks a replacement seat only after command-tree death and zero durable leases', async () => {
    let blockedReason: string | null = null
    let finishCancellation!: () => void
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve
    })
    let hostRunLive = true
    const lifecycle = {
      terminal: vi.fn(),
      snapshot: vi.fn(() => ({
        runId: 'kimi-old-run',
        terminalRequested: true,
        releaseState: 'idle' as const,
        operations: [
          {
            operationId: 'kimi-old-run:759',
            startedAt: 100,
            unresolved: true
          }
        ]
      })),
      reconcileUnresolvedOperation: vi.fn(() => true)
    }
    const runtime = {
      reconcileUnresolvedRunOperation: vi.fn(() => ({
        ok: true as const,
        runId: 'kimi-old-run',
        clearedReason: blockedReason || ''
      }))
    }
    const reconciler = new WorkspaceLockTerminalReconciler({
      lifecycle,
      hostCommands: {
        beginRunCancellation: vi.fn(() => ({
          scope: { kind: 'run' as const, appRunId: 'kimi-old-run' },
          operationIds: ['brokered-command'],
          completion: cancellation,
          processTreeStopped: cancellation.then(() => true)
        })),
        hasRun: () => hostRunLive
      },
      getRuntime: () => runtime,
      getBlockedReason: () => blockedReason,
      clearBlockedReason: (expected) => {
        if (blockedReason !== expected) return false
        blockedReason = null
        return true
      }
    })

    reconciler.terminal('kimi-old-run')
    blockedReason =
      'Workspace-lock mutation admission is fail-closed: Workspace-lock operation kimi-old-run:759 did not settle before its terminal deadline.'
    reconciler.handleViolation(unresolved(), blockedReason)

    const replacementSeatCanMutate = (): boolean => blockedReason === null
    expect(replacementSeatCanMutate()).toBe(false)
    expect(lifecycle.terminal).toHaveBeenCalledWith('kimi-old-run')

    hostRunLive = false
    finishCancellation()
    await vi.waitFor(() => expect(replacementSeatCanMutate()).toBe(true))
    expect(lifecycle.reconcileUnresolvedOperation).toHaveBeenCalledWith(
      'kimi-old-run',
      'kimi-old-run:759'
    )
    expect(runtime.reconcileUnresolvedRunOperation).toHaveBeenCalledWith({
      runId: 'kimi-old-run',
      expectedUnhealthyReason:
        'Workspace-lock mutation admission is fail-closed: Workspace-lock operation kimi-old-run:759 did not settle before its terminal deadline.',
      processTreeStopped: true
    })
  })

  it('retains the admission wall when durable authority still has a lease', async () => {
    let blockedReason = 'Workspace-lock mutation admission is fail-closed: unresolved'
    const reconciler = new WorkspaceLockTerminalReconciler({
      lifecycle: {
        terminal: vi.fn(),
        snapshot: vi.fn(() => ({
          runId: 'kimi-old-run',
          terminalRequested: true,
          releaseState: 'idle' as const,
          operations: [{ operationId: 'kimi-old-run:759', startedAt: 100, unresolved: true }]
        })),
        reconcileUnresolvedOperation: vi.fn(() => true)
      },
      hostCommands: {
        beginRunCancellation: vi.fn(() => ({
          scope: { kind: 'run' as const, appRunId: 'kimi-old-run' },
          operationIds: [],
          completion: Promise.resolve(),
          processTreeStopped: Promise.resolve(false)
        })),
        hasRun: () => false
      },
      getRuntime: () => ({
        reconcileUnresolvedRunOperation: vi.fn(() => ({
          ok: false as const,
          reason: 'active_leases' as const,
          activeLeaseCount: 1
        }))
      }),
      getBlockedReason: () => blockedReason,
      clearBlockedReason: () => {
        blockedReason = ''
        return true
      }
    })

    reconciler.terminal('kimi-old-run')
    reconciler.handleViolation(unresolved(), blockedReason)
    await Promise.resolve()
    await Promise.resolve()

    expect(blockedReason).toBe('Workspace-lock mutation admission is fail-closed: unresolved')
  })

  it('does not reinterpret a non-command lifecycle violation as process-tree death', async () => {
    let blockedReason = 'Workspace-lock mutation admission is fail-closed: provider unresolved'
    const runtimeReconcile = vi.fn()
    const lifecycleReconcile = vi.fn()
    const reconciler = new WorkspaceLockTerminalReconciler({
      lifecycle: {
        terminal: vi.fn(),
        snapshot: vi.fn(() => ({
          runId: 'kimi-old-run',
          terminalRequested: true,
          releaseState: 'idle' as const,
          operations: [{ operationId: 'kimi-old-run:759', startedAt: 100, unresolved: true }]
        })),
        reconcileUnresolvedOperation: lifecycleReconcile
      },
      hostCommands: {
        beginRunCancellation: vi.fn(() => ({
          scope: { kind: 'run' as const, appRunId: 'kimi-old-run' },
          operationIds: [],
          completion: Promise.resolve(),
          processTreeStopped: Promise.resolve(false)
        })),
        hasRun: () => false
      },
      getRuntime: () => ({ reconcileUnresolvedRunOperation: runtimeReconcile }),
      getBlockedReason: () => blockedReason,
      clearBlockedReason: () => {
        blockedReason = ''
        return true
      }
    })

    reconciler.terminal('kimi-old-run')
    reconciler.handleViolation(unresolved(), blockedReason)
    await Promise.resolve()
    await Promise.resolve()

    expect(runtimeReconcile).not.toHaveBeenCalled()
    expect(lifecycleReconcile).not.toHaveBeenCalled()
    expect(blockedReason).toContain('provider unresolved')
  })

  it('retains the wall while a sibling lifecycle operation is still active', async () => {
    const blockedReason = 'Workspace-lock mutation admission is fail-closed: unresolved'
    const runtimeReconcile = vi.fn()
    const reconciler = new WorkspaceLockTerminalReconciler({
      lifecycle: {
        terminal: vi.fn(),
        snapshot: vi.fn(() => ({
          runId: 'kimi-old-run',
          terminalRequested: true,
          releaseState: 'idle' as const,
          operations: [
            { operationId: 'kimi-old-run:759', startedAt: 100, unresolved: true },
            { operationId: 'kimi-old-run:760', startedAt: 101, unresolved: false }
          ]
        })),
        reconcileUnresolvedOperation: vi.fn()
      },
      hostCommands: {
        beginRunCancellation: vi.fn(() => ({
          scope: { kind: 'run' as const, appRunId: 'kimi-old-run' },
          operationIds: ['brokered-command'],
          completion: Promise.resolve(),
          processTreeStopped: Promise.resolve(true)
        })),
        hasRun: () => false
      },
      getRuntime: () => ({ reconcileUnresolvedRunOperation: runtimeReconcile }),
      getBlockedReason: () => blockedReason,
      clearBlockedReason: vi.fn(() => true)
    })

    reconciler.terminal('kimi-old-run')
    reconciler.handleViolation(unresolved(), blockedReason)
    await Promise.resolve()
    await Promise.resolve()

    expect(runtimeReconcile).not.toHaveBeenCalled()
  })
})
