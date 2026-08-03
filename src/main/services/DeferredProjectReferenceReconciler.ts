import type {
  ProjectReferenceHistoryMutationHold,
  ProjectReferenceLegacyArtifactRef
} from './ProjectReferenceArtifactStore'

export interface DeferredProjectReferenceReconcilerDeps {
  needsLegacyReconciliation: () => boolean
  beginStartupReconciliation: () => ProjectReferenceHistoryMutationHold
  loadOwnership: () => Promise<readonly ProjectReferenceLegacyArtifactRef[]>
  reconcile: (references: readonly ProjectReferenceLegacyArtifactRef[]) => void
  endCaptureHold: (hold: ProjectReferenceHistoryMutationHold) => boolean
  onFailure: (error: unknown) => void
  settleMs?: number
}

/**
 * Holds new Project-reference captures closed while legacy ownership is rebuilt
 * after the first window paints. The hold is deliberately retained when the
 * rebuild fails so a partial or stale ledger can never admit new snapshots.
 */
export class DeferredProjectReferenceReconciler {
  private startPromise: Promise<void> | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null

  private constructor(
    private readonly deps: DeferredProjectReferenceReconcilerDeps,
    private readonly captureHold: ProjectReferenceHistoryMutationHold
  ) {}

  static prepare(
    deps: DeferredProjectReferenceReconcilerDeps
  ): DeferredProjectReferenceReconciler | null {
    if (!deps.needsLegacyReconciliation()) return null
    return new DeferredProjectReferenceReconciler(deps, deps.beginStartupReconciliation())
  }

  scheduleAfterFirstPaint(): void {
    if (this.startPromise || this.settleTimer) return
    this.settleTimer = setTimeout(
      () => {
        this.settleTimer = null
        void this.start().catch(this.deps.onFailure)
      },
      Math.max(0, this.deps.settleMs ?? 15_000)
    )
    this.settleTimer.unref?.()
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    this.startPromise = (async () => {
      const references = await this.deps.loadOwnership()
      this.deps.reconcile(references)
      if (!this.deps.endCaptureHold(this.captureHold)) {
        throw new Error('Project-reference startup capture hold was lost before release.')
      }
    })()
    return this.startPromise
  }
}
