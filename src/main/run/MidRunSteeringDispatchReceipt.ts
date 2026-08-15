import type { RunAdapterInvocationReceipt, RunDispatchObserver } from './AgentRunTypes'

export interface MidRunSteeringDispatchReceipt {
  observer: RunDispatchObserver
  /**
   * Compatibility path for dispatch facades that return an accepted receipt
   * without invoking their observer. Production records at adapter invocation;
   * callers invoke this only after an accepted dispatch result.
   */
  markAcceptedFallback: () => void
}

/**
 * Compose the orchestrator's lifecycle observer with the exact steering
 * delivery receipt.
 *
 * `RunCoordinator` invokes the observer after provider preflight succeeds and
 * immediately after `adapter.run` begins, before awaiting the long-lived
 * adapter operation. That is the first authoritative proof that the prompt
 * reached the provider boundary. Waiting for the dispatch promise to settle
 * creates a race with fan-out lane settlement and can leave an already-seen
 * interjection looking pending at the round drain.
 */
export function createMidRunSteeringDispatchReceipt(input: {
  upstreamObserver?: RunDispatchObserver
  markDelivered: () => void
}): MidRunSteeringDispatchReceipt {
  let marked = false
  const markOnce = (): void => {
    if (marked) return
    marked = true
    input.markDelivered()
  }

  return Object.freeze({
    observer: Object.freeze({
      onAdapterInvoked: (receipt: RunAdapterInvocationReceipt): void => {
        try {
          input.upstreamObserver?.onAdapterInvoked?.(receipt)
        } finally {
          // One observer must not suppress the other. RunCoordinator treats
          // observer callbacks as observational and catches any thrown error.
          markOnce()
        }
      }
    }),
    markAcceptedFallback: markOnce
  })
}
