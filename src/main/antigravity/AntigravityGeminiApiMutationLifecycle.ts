export interface AntigravityGeminiApiMutationLifecycleDeps {
  /** Starts the replacement configured-provider discovery generation. */
  readonly startDiscovery: () => void
  /** Withdraws the paired-device catalog while that generation is pending. */
  readonly broadcastPendingCatalog: () => void
}

/**
 * Composition-root wiring for successful Gemini API key mutations.
 *
 * Discovery must start first: its generation owns the eventual replacement
 * snapshot, while the following broadcast immediately withdraws stale rows
 * from paired devices. This module contains no provider behavior; it only
 * makes that production ordering explicit and testable.
 */
export function createAntigravityGeminiApiMutationSuccessHandler(
  deps: AntigravityGeminiApiMutationLifecycleDeps
): () => void {
  return () => {
    deps.startDiscovery()
    deps.broadcastPendingCatalog()
  }
}
