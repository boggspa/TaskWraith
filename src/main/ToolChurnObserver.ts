/**
 * Drives `attributeToolChurn` against a live workspace: decides WHEN to sample,
 * keeps the cost down, and reports honestly when a measurement cannot be
 * attributed.
 *
 * THE COST PROBLEM. A naive per-call measurement samples twice — before and
 * after — which is two `git` subprocess pairs per write. This keeps a ROLLING
 * baseline instead: the sample taken when write N settles becomes the baseline
 * for write N+1, so the steady-state cost is ONE sample per settled write. The
 * first write in a workspace has nothing to subtract from, so a baseline is
 * primed at dispatch (fire-and-forget) rather than losing that call.
 *
 * THE ORDERING PROBLEM. Measurements are async while the ingestion paths that
 * consume them are synchronous, so two settles on the same workspace could
 * interleave and corrupt the rolling baseline — the second delta would subtract
 * a sample the first had already advanced past. Every measurement for a given
 * workspace is therefore serialised on a per-workspace promise chain.
 *
 * THE ATTRIBUTION PROBLEM. If a second write was in flight at any point across a
 * measurement window, the delta contains work this call did not do. That is not
 * suppressed — it is reported with `exclusive: false`, which
 * `attributeToolChurn` turns into `estimated`, which `isMeasuredDiffSummary`
 * then refuses to treat as truth. The number still reaches the odometer; it
 * just stops outranking.
 */
import { attributeToolChurn } from './ToolChurnAttribution'
import type { ToolDiffSummary } from './store/types'
import { diffWorkspaceChurn } from './WorkspaceChurn'
import type { WorkspaceChurnSample } from './WorkspaceChurn'

export interface ToolChurnObserverDeps {
  /** Injected so the observer is unit-testable without a git fixture. */
  sample: (workspace: string) => Promise<WorkspaceChurnSample | null>
}

interface WorkspaceObservationState {
  /** Most recent sample — the baseline the next settled write subtracts from. */
  baseline?: WorkspaceChurnSample
  /** Writes dispatched but not yet settled. */
  inFlight: number
  /**
   * Set the moment a second write overlaps, and held until the workspace goes
   * quiet. Sticky on purpose: a measurement window that CLOSES while a peer
   * write is still open is just as unattributable as one that opens that way,
   * and clearing eagerly would let the tail of an overlap read as exclusive.
   */
  contended: boolean
  /** Serialises measurements so the rolling baseline advances in order. */
  chain: Promise<unknown>
}

export interface MeasureSettledWriteInput {
  workspacePath: string
  /** Paths the settled tool named. No paths ⇒ no attribution (see attribution). */
  touchedPaths: readonly string[]
}

export class ToolChurnObserver {
  private readonly deps: ToolChurnObserverDeps
  private readonly states = new Map<string, WorkspaceObservationState>()

  constructor(deps: ToolChurnObserverDeps) {
    this.deps = deps
  }

  private stateFor(workspacePath: string): WorkspaceObservationState {
    const existing = this.states.get(workspacePath)
    if (existing) return existing
    const created: WorkspaceObservationState = {
      inFlight: 0,
      contended: false,
      chain: Promise.resolve()
    }
    this.states.set(workspacePath, created)
    return created
  }

  /**
   * A write tool was dispatched. Primes a baseline when the workspace has none,
   * so the FIRST write of a session is measurable rather than silently skipped.
   *
   * Deliberately does not await: dispatch must not wait on git. If the sample
   * has not landed by the time this call settles, the measurement declines
   * rather than subtracting from a baseline taken too late — which would
   * under-report the very call it is measuring.
   */
  noteWriteDispatched(workspacePath: string): void {
    if (!workspacePath) return
    const state = this.stateFor(workspacePath)
    state.inFlight += 1
    if (state.inFlight > 1) state.contended = true
    if (state.baseline) return
    state.chain = state.chain
      .then(async () => {
        if (state.baseline) return
        const primed = await this.deps.sample(workspacePath)
        if (primed && !state.baseline) state.baseline = primed
      })
      .catch(() => undefined)
  }

  /**
   * A write tool settled. Samples, subtracts the rolling baseline, attributes
   * the delta to `touchedPaths`, and advances the baseline.
   *
   * Returns undefined whenever the measurement cannot be trusted — no baseline
   * (the priming sample lost the race, or the workspace is not a repository), a
   * declined sample, or an attribution that found nothing it could honestly
   * claim. The estimate already on the activity then stands, which is the
   * correct outcome rather than a fallback.
   */
  async measureSettledWrite(
    input: MeasureSettledWriteInput
  ): Promise<ToolDiffSummary | undefined> {
    const workspacePath = input.workspacePath
    if (!workspacePath) return undefined
    const state = this.stateFor(workspacePath)
    const exclusive = !state.contended
    state.inFlight = Math.max(0, state.inFlight - 1)

    const run = state.chain.then(async () => {
      const baseline = state.baseline
      // No baseline means there is nothing to subtract. Sample anyway so the
      // NEXT write is measurable, but decline this one rather than treating
      // `diff HEAD` as if it were this call's work.
      const current = await this.deps.sample(workspacePath)
      if (current) state.baseline = current
      if (state.inFlight === 0) state.contended = false
      if (!baseline || !current) return undefined
      return attributeToolChurn({
        delta: diffWorkspaceChurn(baseline, current),
        touchedPaths: input.touchedPaths,
        workspacePath,
        exclusive
      })
    })

    // Keep the chain alive for ordering, but never let a rejection poison it.
    state.chain = run.catch(() => undefined)
    try {
      return await run
    } catch {
      return undefined
    }
  }

  /** Drop a workspace's rolling state (run finished, workspace closed). */
  forget(workspacePath: string): void {
    this.states.delete(workspacePath)
  }
}
