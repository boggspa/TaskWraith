/**
 * Host-wide provider-run admission. Caps concurrent `composer.send` work so
 * the Node Host cannot spawn an unbounded number of provider children.
 *
 * Occupancy is the number of admitted starts that have not yet released, not
 * catalog availability or permission posture. Saturation refuses the command
 * with an explicit retryable error; it never hides a provider or drops a prompt.
 */

export const HOST_NODE_MAX_CONCURRENT_RUNS = 16
export const HOST_NODE_MAX_QUEUED_STARTS = 8

export type HostNodeRunAdmissionRejectCode =
  | 'host_saturated'
  | 'host_shutting_down'
  | 'run_start_cancelled'
  | 'thread_busy'

export interface HostNodeRunAdmissionLease {
  readonly commandId: string
  readonly threadId: string
  release(): void
}

export type HostNodeRunAdmissionResult =
  | { readonly kind: 'admitted'; readonly lease: HostNodeRunAdmissionLease }
  | {
      readonly kind: 'rejected'
      readonly errorCode: HostNodeRunAdmissionRejectCode
      readonly errorMessage: string
    }

export interface HostNodeRunAdmission {
  acquire(input: {
    readonly commandId: string
    readonly threadId: string
  }): Promise<HostNodeRunAdmissionResult>
  hasThread(threadId: string): boolean
  inflightCount(): number
  queuedCount(): number
  cancelQueued(input: { readonly threadId: string; readonly commandId?: string }): number
  beginShutdown(): void
}

interface Waiter {
  readonly commandId: string
  readonly threadId: string
  readonly resolve: (result: HostNodeRunAdmissionResult) => void
}

function saturatedMessage(maxConcurrentRuns: number, maxQueuedStarts: number): string {
  return (
    `Host is at concurrent run capacity (${maxConcurrentRuns}` +
    (maxQueuedStarts > 0 ? `, queue ${maxQueuedStarts}` : '') +
    '). Wait for a run to finish or cancel one; providers remain available.'
  )
}

export function createHostNodeRunAdmission(
  options: {
    readonly maxConcurrentRuns?: number
    readonly maxQueuedStarts?: number
  } = {}
): HostNodeRunAdmission {
  const maxConcurrentRuns = options.maxConcurrentRuns ?? HOST_NODE_MAX_CONCURRENT_RUNS
  const maxQueuedStarts = options.maxQueuedStarts ?? HOST_NODE_MAX_QUEUED_STARTS
  if (
    !Number.isSafeInteger(maxConcurrentRuns) ||
    maxConcurrentRuns < 1 ||
    !Number.isSafeInteger(maxQueuedStarts) ||
    maxQueuedStarts < 0
  ) {
    throw new Error('Host run admission bounds must be safe non-negative integers')
  }

  const inflight = new Map<string, string>()
  const waiters: Waiter[] = []
  let shuttingDown = false

  const hasThread = (threadId: string): boolean => {
    for (const owned of inflight.values()) if (owned === threadId) return true
    return waiters.some((waiter) => waiter.threadId === threadId)
  }

  const releaseCommand = (commandId: string): void => {
    if (!inflight.delete(commandId)) return
    flushWaiters()
  }

  const leaseFor = (commandId: string, threadId: string): HostNodeRunAdmissionLease => {
    let released = false
    return {
      commandId,
      threadId,
      release() {
        if (released) return
        released = true
        releaseCommand(commandId)
      }
    }
  }

  const admitNow = (commandId: string, threadId: string): HostNodeRunAdmissionResult => {
    inflight.set(commandId, threadId)
    return { kind: 'admitted', lease: leaseFor(commandId, threadId) }
  }

  const flushWaiters = (): void => {
    while (!shuttingDown && inflight.size < maxConcurrentRuns && waiters.length > 0) {
      const waiter = waiters.shift()
      if (!waiter) return
      waiter.resolve(admitNow(waiter.commandId, waiter.threadId))
    }
  }

  return {
    async acquire(input) {
      if (shuttingDown) {
        return {
          kind: 'rejected',
          errorCode: 'host_shutting_down',
          errorMessage: 'Host is shutting down; the run was not started.'
        }
      }
      if (hasThread(input.threadId)) {
        return {
          kind: 'rejected',
          errorCode: 'thread_busy',
          errorMessage:
            'This thread already has an active or queued run. Wait for it to finish or cancel it.'
        }
      }
      if (inflight.size < maxConcurrentRuns) return admitNow(input.commandId, input.threadId)
      if (waiters.length >= maxQueuedStarts) {
        return {
          kind: 'rejected',
          errorCode: 'host_saturated',
          errorMessage: saturatedMessage(maxConcurrentRuns, maxQueuedStarts)
        }
      }
      return await new Promise<HostNodeRunAdmissionResult>((resolve) => {
        waiters.push({
          commandId: input.commandId,
          threadId: input.threadId,
          resolve
        })
      })
    },
    hasThread,
    inflightCount: () => inflight.size,
    queuedCount: () => waiters.length,
    cancelQueued(input) {
      let cancelled = 0
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index]
        if (waiter.threadId !== input.threadId) continue
        if (input.commandId && waiter.commandId !== input.commandId) continue
        waiters.splice(index, 1)
        waiter.resolve({
          kind: 'rejected',
          errorCode: 'run_start_cancelled',
          errorMessage: 'Queued run was cancelled before it started.'
        })
        cancelled += 1
      }
      return cancelled
    },
    beginShutdown() {
      shuttingDown = true
      const pending = waiters.splice(0, waiters.length)
      for (const waiter of pending) {
        waiter.resolve({
          kind: 'rejected',
          errorCode: 'host_shutting_down',
          errorMessage: 'Host is shutting down; the queued run was not started.'
        })
      }
    }
  }
}
