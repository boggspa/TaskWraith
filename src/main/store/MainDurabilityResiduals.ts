export const RESIDUAL_COUNTERS = [
  'acknowledgedRevisionGapReanchors',
  'unacknowledgedRevisionGapReanchors',
  'conflictRecoveryReanchors',
  'forcedSynchronousCheckpoints',
  'preparationRefusals',
  'baselineVerifies',
  'fallbackMaterializations',
  'conflictRebasedMaterializations',
  'oversizeMaterializations',
  'bytesOverCap',
  'strictRunEventFsyncs',
  'd2d3Durability',
  'conflictRecoveryReads',
  'shadowReconcileParses',
  'promptWorkerDisables',
  'promptWorkerTimeouts',
  'orphanReclaims'
] as const
export type ResidualCounter = (typeof RESIDUAL_COUNTERS)[number]
export type ResidualObserver = (counter: ResidualCounter) => void

/** Diagnostics may lose evidence but never change the operation's outcome. */
export function observeResidual(
  observer: ResidualObserver | undefined,
  counter: ResidualCounter
): void {
  try {
    observer?.(counter)
  } catch {
    /* Observability is additive. */
  }
}

export interface ResidualBaseline {
  identity: string
  label: string
  at: number
  sequence: number
  counters: Record<ResidualCounter, number | null>
}

/** No payloads, paths or chat IDs. Enrollment means a real operation hook exists. */
export class MainDurabilityResiduals {
  private readonly counts = new Map<ResidualCounter, number>()
  private sequence = 0
  private lastAt = 0
  private readonly issued = new WeakMap<ResidualBaseline, true>()
  private invalid = false
  private validateState(): void {
    if (
      this.invalid ||
      !Number.isSafeInteger(this.sequence) ||
      this.sequence < 0 ||
      [...this.counts.values()].some((count) => !Number.isSafeInteger(count) || count < 0)
    ) {
      this.invalid = true
      throw new Error('Residual source invalid; evidence unqualified')
    }
  }
  constructor(
    private readonly identity: string,
    private readonly now: () => number = () => performance.now()
  ) {
    if (!identity) throw new Error('Residual telemetry requires process identity')
  }
  enroll(counters: readonly ResidualCounter[]): ResidualObserver {
    const membership = new Set(counters)
    if ([...membership].some((counter) => !RESIDUAL_COUNTERS.includes(counter)))
      throw new Error('Unknown residual counter')
    this.validateState()
    for (const counter of membership) {
      if (!this.counts.has(counter)) this.counts.set(counter, 0)
    }
    return (counter) => {
      if (!membership.has(counter)) throw new Error('Residual source not enrolled')
      this.validateState()
      if (
        this.sequence === Number.MAX_SAFE_INTEGER ||
        this.counts.get(counter) === Number.MAX_SAFE_INTEGER
      ) {
        this.invalid = true
        throw new Error('Residual source overflow; evidence unqualified')
      }
      this.counts.set(counter, this.counts.get(counter)! + 1)
      this.sequence++
    }
  }
  snapshot(label: string): ResidualBaseline {
    this.validateState()
    const at = this.now()
    if (!label || !Number.isFinite(at) || at < 0 || at < this.lastAt)
      throw new Error('Invalid residual window clock/label')
    this.lastAt = at
    const snapshot: ResidualBaseline = Object.freeze({
      identity: this.identity,
      label,
      at,
      sequence: this.sequence,
      counters: Object.freeze(
        Object.fromEntries(
          RESIDUAL_COUNTERS.map((counter) => [counter, this.counts.get(counter) ?? null])
        )
      ) as ResidualBaseline['counters']
    })
    this.issued.set(snapshot, true)
    return snapshot
  }
  delta(
    baseline: ResidualBaseline,
    label: string
  ): {
    complete: boolean
    missing: ResidualCounter[]
    counters: ResidualBaseline['counters']
    from: number
    to: number
  } {
    if (!this.issued.has(baseline))
      throw new Error('Residual baseline was not issued by this collector')
    const current = this.snapshot(label)
    if (
      baseline.identity !== current.identity ||
      baseline.label !== label ||
      !Number.isFinite(baseline.at) ||
      baseline.at < 0 ||
      baseline.at > current.at ||
      !Number.isSafeInteger(baseline.sequence) ||
      baseline.sequence < 0 ||
      baseline.sequence > current.sequence
    )
      throw new Error('Residual baseline identity/window mismatch')
    const missing: ResidualCounter[] = []
    const counters = Object.fromEntries(
      RESIDUAL_COUNTERS.map((counter) => {
        const before = baseline.counters[counter]
        const after = current.counters[counter]
        if (before === null || after === null) {
          missing.push(counter)
          return [counter, null]
        }
        if (
          !Number.isSafeInteger(before) ||
          before < 0 ||
          !Number.isSafeInteger(after) ||
          after < 0 ||
          before > after
        )
          throw new Error('Residual counter regressed')
        return [counter, after - before]
      })
    ) as ResidualBaseline['counters']
    return { complete: missing.length === 0, missing, counters, from: baseline.at, to: current.at }
  }
}
