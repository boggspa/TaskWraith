import { AsyncLocalStorage } from 'node:async_hooks'

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
  /** Run nested sync/async callbacks under this exact live admission. */
  run<T>(fn: () => T): T
}

export class LegacyStoreWriterGateClosedError extends Error {
  constructor() {
    super('Legacy store writer admission is closed.')
    this.name = 'LegacyStoreWriterGateClosedError'
  }
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
  private readonly active = new Map<object, number>()
  private readonly drainedWaiters = new Set<() => void>()
  private ownershipValue?: Readonly<{ hostId: string; generation: number; cutoverId: string }>
  private readonly context = new AsyncLocalStorage<readonly object[]>()

  admit(input: LegacyStoreWriterAdmission): LegacyStoreWriterAdmissionLease | null {
    if (!input || !canonical(input.operation) || !canonical(input.pathFamily)) return null
    if (this.stateValue !== 'open') return null
    const token = Object.freeze({})
    this.active.set(token, 1)
    this.inFlightValue += 1
    return this.lease(token)
  }

  /** Retain the current admission for deferred work that settles after its caller returns. */
  retainActiveAdmission(): LegacyStoreWriterAdmissionLease | null {
    const context = this.context.getStore() ?? []
    for (let index = context.length - 1; index >= 0; index -= 1) {
      const token = context[index]
      const references = this.active.get(token)
      if (references === undefined) continue
      this.active.set(token, references + 1)
      return this.lease(token)
    }
    return null
  }

  private lease(token: object): LegacyStoreWriterAdmissionLease {
    let released = false
    return {
      release: () => {
        const references = this.active.get(token)
        if (released || references === undefined) return false
        released = true
        if (references === 1) {
          this.active.delete(token)
          this.inFlightValue -= 1
          this.notifyDrained()
        } else {
          this.active.set(token, references - 1)
        }
        return true
      },
      run: <T>(fn: () => T): T => {
        if (released || !this.active.has(token) || typeof fn !== 'function') {
          throw new LegacyStoreWriterGateClosedError()
        }
        return this.context.run([...(this.context.getStore() ?? []), token], fn)
      }
    }
  }

  /** Acquire, run, and settle one admission around sync or Promise work. */
  runAdmitted<T>(input: LegacyStoreWriterAdmission, fn: () => T): T {
    // Nested/deferred callbacks of an already-admitted writer retain that
    // admission through drain. They must not attempt a second admission.
    if (this.hasActiveAdmissionContext()) {
      if (typeof fn !== 'function') throw new LegacyStoreWriterGateClosedError()
      return fn()
    }
    const lease = this.admit(input)
    if (!lease) throw new LegacyStoreWriterGateClosedError()
    if (typeof fn !== 'function') {
      lease.release()
      throw new LegacyStoreWriterGateClosedError()
    }
    try {
      const value = lease.run(fn)
      if (value && typeof (value as unknown as PromiseLike<unknown>).then === 'function') {
        return Promise.resolve(value).then(
          (result) => {
            lease.release()
            return result
          },
          (error) => {
            lease.release()
            throw error
          }
        ) as unknown as T
      }
      lease.release()
      return value
    } catch (error) {
      lease.release()
      throw error
    }
  }

  /** True only inside a still-live admission issued by this exact gate. */
  hasActiveAdmissionContext(): boolean {
    return (this.context.getStore() ?? []).some((token) => this.active.has(token))
  }

  /** Dynamic filesystem authority for lower stores: open globally, or one already-admitted drain. */
  allowsCurrentWrite(): boolean {
    return this.stateValue === 'open' || this.hasActiveAdmissionContext()
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
