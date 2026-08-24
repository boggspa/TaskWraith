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
import { diffHostSnapshotDomainEffects } from './HostSnapshotDomainEffectDiff'

export const HOST_PROJECTION_RECONCILE_INTERVAL_MS = 1_000
const MAX_STABILIZE_ATTEMPTS = 3

export interface HostProjectionReconcilerOptions {
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

type AdvanceResult =
  | ReadyComparison
  | Extract<HostProjectionReconcileResult, { kind: 'rebased' | 'unavailable' }>

function positionOf(snapshot: HostSnapshot): HostCursorPosition {
  return { generation: snapshot.generation, cursor: snapshot.cursor }
}

function samePosition(left: HostSnapshot, right: HostSnapshot): boolean {
  return left.generation === right.generation && left.cursor === right.cursor
}

function cloneSnapshot(snapshot: HostSnapshot): HostSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as HostSnapshot
}

/**
 * Metadata minted from the journal must not become a synthetic domain change.
 * Align it before using the strict before/after diff. Health freshness is also
 * transport provenance: applying a delta demotes a cache even when Host health
 * itself did not change.
 */
function comparableBaseline(baseline: HostSnapshot, current: HostSnapshot): HostSnapshot {
  const comparable = cloneSnapshot(baseline)
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
  private readonly captureSnapshot: HostProjectionReconcilerOptions['captureSnapshot']
  private readonly fetchDeltas: HostProjectionReconcilerOptions['fetchDeltas']
  private readonly publishEffects: HostProjectionReconcilerOptions['publishEffects']
  private readonly intervalMs: number
  private readonly schedule: (callback: () => void, delayMs: number) => unknown
  private readonly cancelScheduled: (handle: unknown) => void
  private readonly log?: (line: string) => void
  private baseline: HostSnapshot | null = null
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
    this.fetchDeltas = options.fetchDeltas
    this.publishEffects = options.publishEffects
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

  /** Capture the first coherent baseline, then begin one serialized loop. */
  async start(): Promise<void> {
    if (this.running) return
    const baseline = await this.captureValidSnapshot()
    if (!baseline) {
      throw new Error('host_projection_reconcile_baseline_unavailable')
    }
    this.baseline = baseline
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
    const run = this.performReconcile().finally(() => {
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

  private async captureValidSnapshot(): Promise<HostSnapshot | null> {
    try {
      return decodedSnapshot(await this.captureSnapshot())
    } catch {
      return null
    }
  }

  private async performReconcile(): Promise<HostProjectionReconcileResult> {
    const current = await this.captureValidSnapshot()
    if (!current) return this.unavailable('capture_failed')
    if (!this.baseline) {
      this.baseline = current
      return { kind: 'initialized', position: positionOf(current) }
    }

    const advanced = await this.advanceBaseline(current)
    if (advanced.kind !== 'ready') return advanced
    this.baseline = advanced.baseline

    const before = comparableBaseline(advanced.baseline, advanced.current)
    const diff = diffHostSnapshotDomainEffects(before, advanced.current)
    if (diff.kind !== 'effects') return this.unavailable('diff_failed')
    if (diff.effects.length === 0) {
      this.baseline = advanced.current
      return { kind: 'unchanged', position: positionOf(advanced.current) }
    }

    let published: HostDomainDeltaPublishResult
    try {
      published = await this.publishEffects(diff.effects)
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
        current = recaptured
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
