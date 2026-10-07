/**
 * Reconciles mutations made by legacy in-process authorities into Host's sole
 * ordered delta journal.
 *
 * Host commands already publish observed before/after effects. During the
 * app-only migration, AppStore, RunManager, schedules and other main-owned
 * services can still change without entering through a Host command. This
 * service captures the bounded Host projection once per interval, advances
 * its private baseline through any deltas already journalled by Host commands,
 * diffs only the remaining external changes, and publishes those effects.
 *
 * It owns no domain state and creates no second cursor. A client can therefore
 * catch up from one journal regardless of whether a mutation originated on
 * Desktop, TUI, paired iOS or a legacy main-process path.
 */

import {
  decodeHostSnapshot,
  type HostCursorPosition,
  type HostDeltasSinceResult,
  type HostSnapshot
} from '../shared/hostProtocol'
import { applyHostSnapshotDeltas } from '../shared/hostSnapshotApply'
import type { HostDomainDeltaPublishResult, HostDomainEffectDto } from './HostDomainDeltaPublisher'
import { diffDecodedHostSnapshots } from './HostSnapshotDomainEffectDiff'
import type { HostProjectionOperationRunner } from './HostProjectionSerialQueue'

export const HOST_PROJECTION_RECONCILE_INTERVAL_MS = 1_000
const MAX_STABILIZE_ATTEMPTS = 3
/**
 * Passes an incomplete capture may be refused before the reconciler proceeds
 * with it anyway. A baseline waits longest: at boot the run window has not
 * loaded, and every row it later loads would otherwise be republished to
 * clients that already hold it. Inside the loop the wait is short, because a
 * refused pass also holds back every other family's changes.
 */
export const HOST_PROJECTION_BASELINE_INCOMPLETE_LIMIT = 30
export const HOST_PROJECTION_TICK_INCOMPLETE_LIMIT = 3

export interface HostProjectionReconcilerOptions {
  readonly runProjectionOperation?: HostProjectionOperationRunner
  readonly captureSnapshot: () => unknown | Promise<unknown>
  readonly fetchDeltas: (
    position: HostCursorPosition
  ) => HostDeltasSinceResult | Promise<HostDeltasSinceResult>
  readonly publishEffects: (
    effects: readonly HostDomainEffectDto[]
  ) => HostDomainDeltaPublishResult | Promise<HostDomainDeltaPublishResult>
  readonly intervalMs?: number
  readonly schedule?: (callback: () => void, delayMs: number) => unknown
  readonly cancelScheduled?: (handle: unknown) => void
  readonly log?: (line: string) => void
  /**
   * Effects another publisher owns (M4 slice 13f2: the public window index,
   * once it publishes). They are never reconciled: the capture can run ahead
   * of the journal the baseline follows, and republishing it could put a
   * stale row over a newer one.
   */
  readonly owns?: (effect: HostDomainEffectDto) => boolean
  /**
   * Whether a capture taken now shows every family whole: false while the
   * Host's run window has not loaded (or its last read was torn or skipped a
   * chat the mirror had not listed). Such a capture is not a baseline and not
   * a diffable pass, for a bounded number of passes; past the bound the
   * reconciler proceeds as before, so a window that never completes cannot
   * stall publication. Absent means always complete.
   */
  readonly captureComplete?: () => boolean
}

export type HostProjectionReconcileResult =
  | { readonly kind: 'initialized'; readonly position: HostCursorPosition }
  | { readonly kind: 'unchanged'; readonly position: HostCursorPosition }
  | {
      readonly kind: 'published'
      readonly position: HostCursorPosition
      readonly count: number
    }
  | {
      readonly kind: 'partial'
      readonly position: HostCursorPosition
      readonly publishedCount: number
    }
  | {
      readonly kind: 'rebased'
      readonly position: HostCursorPosition
      readonly reason: 'generation_changed' | 'journal_gap' | 'journal_apply_failed'
    }
  | {
      readonly kind: 'unavailable'
      readonly reason:
        | 'capture_failed'
        | 'capture_incomplete'
        | 'delta_read_failed'
        | 'journal_raced'
        | 'diff_failed'
        | 'publish_failed'
    }
  | { readonly kind: 'stopped' }

type ReadyComparison = {
  readonly kind: 'ready'
  readonly baseline: HostSnapshot
  readonly current: HostSnapshot
}

type Captured = { readonly snapshot: HostSnapshot; readonly complete: boolean }

type AdvanceResult =
  | ReadyComparison
  | Extract<HostProjectionReconcileResult, { kind: 'rebased' | 'unavailable' }>

function positionOf(snapshot: HostSnapshot): HostCursorPosition {
  return { generation: snapshot.generation, cursor: snapshot.cursor }
}

function samePosition(left: HostSnapshot, right: HostSnapshot): boolean {
  return left.generation === right.generation && left.cursor === right.cursor
}

/**
 * Metadata minted from the journal must not become a synthetic domain change.
 * Align it before using the strict before/after diff. Health freshness is also
 * transport provenance: applying a delta demotes a cache even when Host health
 * itself did not change.
 */
function comparableBaseline(baseline: HostSnapshot, current: HostSnapshot): HostSnapshot {
  // Only these metadata records change. Diffing and delta application both
  // decode their inputs without mutating them, so copying every catalogue row
  // through JSON here adds allocation and GC work to every reconciliation.
  const comparable = { ...baseline }
  comparable.protocolVersion = current.protocolVersion
  comparable.projectionVersion = current.projectionVersion
  comparable.generation = current.generation
  comparable.cursor = current.cursor
  comparable.generatedAt = current.generatedAt
  comparable.freshness = current.freshness
  comparable.health = {
    ...comparable.health,
    freshness: current.health.freshness
  }
  comparable.recovery = {
    ...comparable.recovery,
    ...(current.recovery.lastGeneration === undefined
      ? {}
      : { lastGeneration: current.recovery.lastGeneration }),
    ...(current.recovery.lastCursor === undefined
      ? {}
      : { lastCursor: current.recovery.lastCursor })
  }
  if (current.recovery.lastGeneration === undefined) delete comparable.recovery.lastGeneration
  if (current.recovery.lastCursor === undefined) delete comparable.recovery.lastCursor
  return comparable
}

function decodedSnapshot(raw: unknown): HostSnapshot | null {
  const decoded = decodeHostSnapshot(raw)
  return decoded.ok ? decoded.value : null
}

function publishedEnvelopes(result: HostDomainDeltaPublishResult) {
  if (result.kind !== 'published' && result.kind !== 'partial') return []
  return result.results.flatMap((entry) =>
    entry.kind === 'appended' || entry.kind === 'duplicate' ? [entry.record.envelope] : []
  )
}

export class HostProjectionReconciler {
  private readonly runProjectionOperation: HostProjectionOperationRunner
  private readonly captureSnapshot: HostProjectionReconcilerOptions['captureSnapshot']
  private readonly fetchDeltas: HostProjectionReconcilerOptions['fetchDeltas']
  private readonly publishEffects: HostProjectionReconcilerOptions['publishEffects']
  private readonly intervalMs: number
  private readonly schedule: (callback: () => void, delayMs: number) => unknown
  private readonly cancelScheduled: (handle: unknown) => void
  private readonly log?: (line: string) => void
  private readonly owns?: (effect: HostDomainEffectDto) => boolean
  private readonly captureComplete?: () => boolean
  private baseline: HostSnapshot | null = null
  /** Consecutive incomplete captures refused since the last complete one. */
  private incompleteCaptures = 0
  private scheduled: unknown = null
  private running = false
  private inFlight: Promise<HostProjectionReconcileResult> | null = null

  constructor(options: HostProjectionReconcilerOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('HostProjectionReconciler requires options')
    }
    if (typeof options.captureSnapshot !== 'function') {
      throw new Error('HostProjectionReconciler requires captureSnapshot')
    }
    if (typeof options.fetchDeltas !== 'function') {
      throw new Error('HostProjectionReconciler requires fetchDeltas')
    }
    if (typeof options.publishEffects !== 'function') {
      throw new Error('HostProjectionReconciler requires publishEffects')
    }
    this.captureSnapshot = options.captureSnapshot
    this.runProjectionOperation = options.runProjectionOperation ?? ((operation) => operation())
    this.fetchDeltas = options.fetchDeltas
    this.publishEffects = options.publishEffects
    if (options.owns) this.owns = options.owns
    if (options.captureComplete) this.captureComplete = options.captureComplete
    this.intervalMs =
      Number.isFinite(options.intervalMs) && Number(options.intervalMs) > 0
        ? Math.floor(Number(options.intervalMs))
        : HOST_PROJECTION_RECONCILE_INTERVAL_MS
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.cancelScheduled =
      options.cancelScheduled ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.log = options.log
  }

  get isRunning(): boolean {
    return this.running
  }

  /**
   * Capture the first coherent baseline, then begin one serialized loop. An
   * incomplete first capture leaves the baseline to the loop, which adopts the
   * first complete one (or, past the bound, the latest).
   */
  async start(): Promise<void> {
    if (this.running) return
    this.incompleteCaptures = 0
    const baseline = await this.captureValidSnapshot()
    if (!baseline) {
      throw new Error('host_projection_reconcile_baseline_unavailable')
    }
    this.baseline = this.admit(baseline, HOST_PROJECTION_BASELINE_INCOMPLETE_LIMIT)
      ? baseline.snapshot
      : null
    this.running = true
    this.scheduleNext()
  }

  /**
   * Stop the app-owned timer and drain an active pass. A later start always
   * captures a fresh baseline. Draining is load-bearing during Host shutdown:
   * no reconciliation append may race the final durable flush.
   */
  async stop(): Promise<void> {
    this.running = false
    if (this.scheduled !== null) {
      this.cancelScheduled(this.scheduled)
      this.scheduled = null
    }
    const active = this.inFlight
    if (active) await active.catch(() => undefined)
    this.baseline = null
  }

  /** Run one reconciliation now; concurrent callers share the same pass. */
  reconcileNow(): Promise<HostProjectionReconcileResult> {
    if (!this.running) return Promise.resolve({ kind: 'stopped' })
    if (this.inFlight) return this.inFlight
    const run = this.runProjectionOperation(() => this.performReconcile()).finally(() => {
      if (this.inFlight === run) this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private scheduleNext(): void {
    if (!this.running || this.scheduled !== null) return
    this.scheduled = this.schedule(() => {
      this.scheduled = null
      void this.reconcileNow().finally(() => this.scheduleNext())
    }, this.intervalMs)
  }

  /**
   * Completeness is read on both sides of the capture and both must hold, so
   * a window that was still loading when the capture began, or unloaded while
   * it was taken, never passes for a loaded one.
   */
  private async captureValidSnapshot(): Promise<Captured | null> {
    try {
      const before = this.captureComplete?.() ?? true
      const snapshot = decodedSnapshot(await this.captureSnapshot())
      if (!snapshot) return null
      return { snapshot, complete: before && (this.captureComplete?.() ?? true) }
    } catch {
      return null
    }
  }

  /** Whether to use a capture now; refusing an incomplete one counts toward `limit`. */
  private admit(captured: Captured, limit: number): boolean {
    if (captured.complete) {
      this.incompleteCaptures = 0
      return true
    }
    if (this.incompleteCaptures >= limit) return true
    this.incompleteCaptures += 1
    return false
  }

  private async performReconcile(): Promise<HostProjectionReconcileResult> {
    const captured = await this.captureValidSnapshot()
    if (!captured) return this.unavailable('capture_failed')
    if (!this.baseline) {
      if (!this.admit(captured, HOST_PROJECTION_BASELINE_INCOMPLETE_LIMIT)) {
        return this.unavailable('capture_incomplete')
      }
      this.baseline = captured.snapshot
      return { kind: 'initialized', position: positionOf(captured.snapshot) }
    }
    if (!this.admit(captured, HOST_PROJECTION_TICK_INCOMPLETE_LIMIT)) {
      return this.unavailable('capture_incomplete')
    }
    const current = captured.snapshot

    const advanced = await this.advanceBaseline(current)
    if (advanced.kind !== 'ready') return advanced
    this.baseline = advanced.baseline

    const before = comparableBaseline(advanced.baseline, advanced.current)
    // Both are decoded already: the capture when it was taken, the baseline
    // likewise or by the delta apply that advanced it.
    const diff = diffDecodedHostSnapshots(before, advanced.current)
    if (diff.kind !== 'effects') return this.unavailable('diff_failed')
    const owns = this.owns
    const effects = owns ? diff.effects.filter((effect) => !owns(effect)) : diff.effects
    if (effects.length === 0) {
      this.baseline = advanced.current
      return { kind: 'unchanged', position: positionOf(advanced.current) }
    }

    let published: HostDomainDeltaPublishResult
    try {
      published = await this.publishEffects(effects)
    } catch {
      return this.unavailable('publish_failed')
    }

    const envelopes = publishedEnvelopes(published)
    if (envelopes.length > 0) {
      const applied = applyHostSnapshotDeltas(before, envelopes)
      if (applied.outcome === 'applied' || applied.outcome === 'unchanged') {
        this.baseline = applied.snapshot
      }
    }

    if (published.kind === 'published') {
      return { kind: 'published', position: published.position, count: published.count }
    }
    if (published.kind === 'partial') {
      return {
        kind: 'partial',
        position: published.position,
        publishedCount: published.publishedCount
      }
    }
    return this.unavailable('publish_failed')
  }

  private async advanceBaseline(currentInput: HostSnapshot): Promise<AdvanceResult> {
    const baseline = this.baseline as HostSnapshot
    let current = currentInput

    if (
      baseline.protocolVersion !== current.protocolVersion ||
      baseline.projectionVersion !== current.projectionVersion ||
      baseline.generation !== current.generation
    ) {
      this.baseline = current
      return {
        kind: 'rebased',
        position: positionOf(current),
        reason: 'generation_changed'
      }
    }
    if (samePosition(baseline, current)) {
      return { kind: 'ready', baseline, current }
    }
    if (baseline.cursor > current.cursor) {
      this.baseline = current
      return {
        kind: 'rebased',
        position: positionOf(current),
        reason: 'generation_changed'
      }
    }

    for (let attempt = 0; attempt < MAX_STABILIZE_ATTEMPTS; attempt += 1) {
      let result: HostDeltasSinceResult
      try {
        result = await this.fetchDeltas(positionOf(baseline))
      } catch {
        return this.unavailable('delta_read_failed')
      }
      if (result.kind === 'full_resnapshot_required') {
        this.baseline = current
        return { kind: 'rebased', position: positionOf(current), reason: 'journal_gap' }
      }
      if (result.generation !== current.generation || result.toCursor !== current.cursor) {
        const recaptured = await this.captureValidSnapshot()
        if (!recaptured) return this.unavailable('capture_failed')
        if (!this.admit(recaptured, HOST_PROJECTION_TICK_INCOMPLETE_LIMIT)) {
          return this.unavailable('capture_incomplete')
        }
        current = recaptured.snapshot
        if (baseline.generation !== current.generation) {
          this.baseline = current
          return {
            kind: 'rebased',
            position: positionOf(current),
            reason: 'generation_changed'
          }
        }
        continue
      }

      const applied = applyHostSnapshotDeltas(baseline, result.deltas)
      if (
        (applied.outcome === 'applied' || applied.outcome === 'unchanged') &&
        applied.generation === current.generation &&
        applied.cursor === current.cursor
      ) {
        return { kind: 'ready', baseline: applied.snapshot, current }
      }
      this.baseline = current
      return {
        kind: 'rebased',
        position: positionOf(current),
        reason: 'journal_apply_failed'
      }
    }

    return this.unavailable('journal_raced')
  }

  private unavailable(
    reason: Extract<HostProjectionReconcileResult, { kind: 'unavailable' }>['reason']
  ): Extract<HostProjectionReconcileResult, { kind: 'unavailable' }> {
    this.log?.(`[host-reconciler] ${reason}`)
    return { kind: 'unavailable', reason }
  }
}
