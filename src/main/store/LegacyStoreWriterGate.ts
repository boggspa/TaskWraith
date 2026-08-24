/**
 * Desktop legacy-store writer admission gate.
 *
 * This module deliberately imports no AppStore/index/Host implementation. A
 * later cutover coordinator may ask it to drain and mark Host ownership; until
 * then the exported compatibility singleton starts open.
 */

export type LegacyStoreWriterGateState = 'open' | 'draining' | 'host-owned' | 'closed'

export interface LegacyStoreWriterAdmission {
  readonly operation: string
  readonly pathFamily: string
}

export interface LegacyStoreWriterGateSnapshot {
  readonly state: LegacyStoreWriterGateState
  readonly inFlight: number
  readonly hostOwned: boolean
  readonly ownership?: Readonly<{ hostId: string; generation: number; cutoverId: string }>
}

export interface LegacyStoreWriterAdmissionLease {
  /** Exact-once opaque release; double/foreign calls never decrement again. */
  release(): boolean
}

const MAX_METADATA = 200

function canonical(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_METADATA &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- writer metadata rejects terminal controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

export class LegacyStoreWriterGate {
  private stateValue: LegacyStoreWriterGateState = 'open'
  private inFlightValue = 0
  private readonly active = new Set<object>()
  private readonly drainedWaiters = new Set<() => void>()
  private ownershipValue?: Readonly<{ hostId: string; generation: number; cutoverId: string }>

  admit(input: LegacyStoreWriterAdmission): LegacyStoreWriterAdmissionLease | null {
    if (!input || !canonical(input.operation) || !canonical(input.pathFamily)) return null
    if (this.stateValue !== 'open') return null
    const token = Object.freeze({})
    this.active.add(token)
    this.inFlightValue += 1
    let released = false
    return {
      release: () => {
        if (released || !this.active.delete(token)) return false
        released = true
        this.inFlightValue -= 1
        this.notifyDrained()
        return true
      }
    }
  }

  beginDrain(): boolean {
    if (this.stateValue !== 'open') return false
    this.stateValue = 'draining'
    this.notifyDrained()
    return true
  }

  awaitDrained(): Promise<void> {
    if (this.inFlightValue === 0) return Promise.resolve()
    return new Promise((resolve) => this.drainedWaiters.add(resolve))
  }

  markHostOwned(input: { hostId: string; generation: number; cutoverId: string }): boolean {
    if (
      this.stateValue !== 'draining' ||
      this.inFlightValue !== 0 ||
      !input ||
      !canonical(input.hostId) ||
      !canonical(input.cutoverId) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 0
    ) {
      return false
    }
    this.ownershipValue = Object.freeze({
      hostId: input.hostId,
      generation: input.generation,
      cutoverId: input.cutoverId
    })
    this.stateValue = 'host-owned'
    return true
  }

  rollbackDrain(): boolean {
    if (this.stateValue !== 'draining' || this.inFlightValue !== 0) return false
    this.stateValue = 'open'
    return true
  }

  close(): boolean {
    if (this.stateValue === 'closed') return false
    this.stateValue = 'closed'
    this.notifyDrained()
    return true
  }

  snapshot(): LegacyStoreWriterGateSnapshot {
    return {
      state: this.stateValue,
      inFlight: this.inFlightValue,
      hostOwned: this.ownershipValue !== undefined,
      ...(this.ownershipValue ? { ownership: this.ownershipValue } : {})
    }
  }

  private notifyDrained(): void {
    if (this.inFlightValue !== 0) return
    for (const resolve of this.drainedWaiters) resolve()
    this.drainedWaiters.clear()
  }
}

export function createLegacyStoreWriterGate(): LegacyStoreWriterGate {
  return new LegacyStoreWriterGate()
}

/** Compatibility singleton: legacy Desktop writers stay admitted until a cutover coordinator drains it. */
export const legacyStoreWriterGate = createLegacyStoreWriterGate()
