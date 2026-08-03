import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ProjectReferenceHistoryMutationHold,
  ProjectReferenceLegacyArtifactRef
} from './ProjectReferenceArtifactStore'
import { DeferredProjectReferenceReconciler } from './DeferredProjectReferenceReconciler'

const hold = Object.freeze({
  id: 'startup-hold',
  kind: 'global'
}) as ProjectReferenceHistoryMutationHold
const references: ProjectReferenceLegacyArtifactRef[] = [
  {
    sha256: 'a'.repeat(64),
    path: '/tmp/a.snapshot',
    sizeBytes: 1,
    appChatId: 'chat-a',
    runId: 'run-a'
  }
]

function fixture(
  overrides: Partial<Parameters<typeof DeferredProjectReferenceReconciler.prepare>[0]> = {}
) {
  const deps = {
    needsLegacyReconciliation: vi.fn(() => true),
    beginStartupReconciliation: vi.fn(() => hold),
    loadOwnership: vi.fn(async () => references),
    reconcile: vi.fn(),
    endCaptureHold: vi.fn(() => true),
    onFailure: vi.fn(),
    settleMs: 25,
    ...overrides
  }
  return { deps, reconciler: DeferredProjectReferenceReconciler.prepare(deps) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DeferredProjectReferenceReconciler', () => {
  it('does nothing when the artifact store has no legacy ownership to rebuild', () => {
    const { deps, reconciler } = fixture({ needsLegacyReconciliation: () => false })

    expect(reconciler).toBeNull()
    expect(deps.beginStartupReconciliation).not.toHaveBeenCalled()
  })

  it('acquires a capture hold synchronously and starts only after first-paint settling', async () => {
    vi.useFakeTimers()
    const { deps, reconciler } = fixture()

    expect(reconciler).not.toBeNull()
    expect(deps.beginStartupReconciliation).toHaveBeenCalledOnce()
    expect(deps.loadOwnership).not.toHaveBeenCalled()

    reconciler?.scheduleAfterFirstPaint()
    await vi.advanceTimersByTimeAsync(24)
    expect(deps.loadOwnership).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(deps.loadOwnership).toHaveBeenCalledOnce()
    expect(deps.reconcile).toHaveBeenCalledWith(references)
    expect(deps.endCaptureHold).toHaveBeenCalledWith(hold)
  })

  it('gives the first frame fifteen seconds to settle by default', async () => {
    vi.useFakeTimers()
    const { deps, reconciler } = fixture({ settleMs: undefined })

    reconciler?.scheduleAfterFirstPaint()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(deps.loadOwnership).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(deps.loadOwnership).toHaveBeenCalledOnce()
  })

  it('runs at most once when first-paint scheduling and a direct start race', async () => {
    vi.useFakeTimers()
    const { deps, reconciler } = fixture()

    reconciler?.scheduleAfterFirstPaint()
    await reconciler?.start()
    await vi.runAllTimersAsync()

    expect(deps.loadOwnership).toHaveBeenCalledOnce()
    expect(deps.reconcile).toHaveBeenCalledOnce()
    expect(deps.endCaptureHold).toHaveBeenCalledOnce()
  })

  it('retains the capture hold and reports a scheduled reconciliation failure', async () => {
    vi.useFakeTimers()
    const failure = new Error('ledger unavailable')
    const { deps, reconciler } = fixture({
      loadOwnership: vi.fn(async () => {
        throw failure
      })
    })

    reconciler?.scheduleAfterFirstPaint()
    await vi.runAllTimersAsync()

    expect(deps.reconcile).not.toHaveBeenCalled()
    expect(deps.endCaptureHold).not.toHaveBeenCalled()
    expect(deps.onFailure).toHaveBeenCalledWith(failure)
  })
})
