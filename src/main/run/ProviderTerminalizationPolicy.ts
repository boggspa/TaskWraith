export interface ProviderTerminalizationOwnership {
  /** Execution-graph attempts already require a two-sided terminal join. */
  graphOwnedAttempt: boolean
  /** A provider-owned close/projection operation will perform terminalization. */
  exactTransportOperationTracked: boolean
}

/**
 * Cancellation is an intent, not transport-close evidence. Keep the
 * RunManager session active whenever another lifecycle authority still owns
 * the terminal projection so destructive-history discovery can continue to
 * target and join the exact run.
 */
export function shouldDeferEagerProviderTerminalization(
  ownership: ProviderTerminalizationOwnership
): boolean {
  return ownership.graphOwnedAttempt || ownership.exactTransportOperationTracked
}
