/**
 * The observer side of the commit gate (Independent Threads M4, slice 13a).
 *
 * Every capture that reads the record-derived state holds the gate's observer
 * mode, so it never sees a committed record whose publication has not
 * committed: legacy windows, controls across both their captures, snapshots
 * and the reconciler (§1.6). Transactions hold committer mode.
 *
 * The fence is re-entrant by live lease. The gate prefers writers, so an
 * observer that re-entered the gate while already holding it would wait
 * behind a queued committer that waits for it: a self-deadlock. A nested
 * fence whose enclosing lease is still held therefore runs directly. The
 * enclosing lease travels in an AsyncLocalStorage store, which also reaches
 * continuations that outlive their window (a provider stream started inside
 * a legacy window), so a store whose lease is already released enters anew.
 *
 * A closed gate (shutdown) runs the operation unfenced: committers are
 * refused too, and shutdown drains the transactions in flight first.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import type { HostCommitGate, HostCommitGateLease } from './HostCommitGate'

export type HostCommitFence = <T>(label: string, operation: () => Promise<T>) => Promise<T>

export function createHostCommitFence(gate: HostCommitGate): HostCommitFence {
  const enclosing = new AsyncLocalStorage<HostCommitGateLease>()
  return async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
    const held = enclosing.getStore()
    if (held && !held.released) return operation()
    const entered = await gate.enter('observer', { label })
    if (!entered.ok) return operation()
    const lease = entered.lease
    try {
      return await enclosing.run(lease, operation)
    } finally {
      lease.release()
    }
  }
}
