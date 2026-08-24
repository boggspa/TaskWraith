import {
  LegacyStoreWriterGateClosedError,
  legacyStoreWriterGate,
  type LegacyStoreWriterAdmission,
  type LegacyStoreWriterAdmissionLease,
  type LegacyStoreWriterGate
} from './LegacyStoreWriterGate'

export interface LegacyStoreDeferredSettlement {
  /** Call synchronously before returning a Promise-backed write from the coalescer callback. */
  markAsyncContinuation(): void
  /** Called exactly once by SaveCoalescer for write, supersede, discard, or failure. */
  coalescerSettled(): void
  /** Called by the utility-write Promise after its ACK continuation has fully settled. */
  asyncSettled(): void
  /** Release when scheduling itself failed before SaveCoalescer took ownership. */
  abort(): void
}

export interface LegacyStoreWriteAdmissionScope {
  /** Transfer this admission to one deferred coalescer/utility-write lifecycle. */
  handoffDeferredSettlement(): LegacyStoreDeferredSettlement
}

/** Hand one write callback plus exact settlement into a coalescer without a leak on schedule failure. */
export function scheduleLegacyStoreDeferredWrite(
  scope: LegacyStoreWriteAdmissionScope,
  schedule: (write: () => void, onSettled: () => void) => void,
  write: (settlement: LegacyStoreDeferredSettlement) => void
): void {
  const settlement = scope.handoffDeferredSettlement()
  try {
    schedule(
      () => write(settlement),
      () => settlement.coalescerSettled()
    )
  } catch (error) {
    settlement.abort()
    throw error
  }
}

function acquire(
  gate: LegacyStoreWriterGate,
  input: LegacyStoreWriterAdmission
): LegacyStoreWriterAdmissionLease {
  const lease = gate.retainActiveAdmission() ?? gate.admit(input)
  if (!lease) throw new LegacyStoreWriterGateClosedError()
  return lease
}

/**
 * Run one Host-owned legacy write under a drain-aware admission.
 *
 * Synchronous/Promise work settles automatically. A coalesced write transfers
 * settlement explicitly so drain cannot finish while a timer or utility ACK
 * can still publish bytes.
 */
export function runLegacyStoreWriteAdmission<T>(
  input: LegacyStoreWriterAdmission,
  work: (scope: LegacyStoreWriteAdmissionScope) => T,
  gate: LegacyStoreWriterGate = legacyStoreWriterGate
): T {
  const lease = acquire(gate, input)
  let deferredCreated = false
  const scope: LegacyStoreWriteAdmissionScope = {
    handoffDeferredSettlement: () => {
      if (deferredCreated) throw new LegacyStoreWriterGateClosedError()
      const deferredLease = gate.retainActiveAdmission()
      if (!deferredLease) throw new LegacyStoreWriterGateClosedError()
      deferredCreated = true
      let asyncContinuation = false
      let released = false
      const release = (): void => {
        if (released) return
        released = deferredLease.release()
      }
      return {
        markAsyncContinuation: () => {
          if (released) throw new LegacyStoreWriterGateClosedError()
          asyncContinuation = true
        },
        coalescerSettled: () => {
          if (!asyncContinuation) release()
        },
        asyncSettled: release,
        abort: release
      }
    }
  }
  let promiseOwned = false
  try {
    const value = lease.run(() => work(scope))
    if (value && typeof (value as unknown as PromiseLike<unknown>).then === 'function') {
      promiseOwned = true
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
    return value
  } finally {
    if (!promiseOwned) lease.release()
  }
}
