export type BridgeRunTranscriptFlush = (runId: string) => void
export type BridgeRunTranscriptFlushFailureReporter = (runId: string, error: unknown) => void

/**
 * Keeps a live transcript projection failure from becoming a provider
 * failure. The terminal flush has its own direct-seal fallback; live output
 * should remain retryable and must not escape through the provider callback.
 */
export function tryFlushBridgeRunTranscript(
  runId: string,
  flush: BridgeRunTranscriptFlush,
  reportFailure: BridgeRunTranscriptFlushFailureReporter = (failedRunId, error) => {
    console.error(`[bridge-run] live transcript flush failed for runId=${failedRunId}:`, error)
  }
): boolean {
  try {
    flush(runId)
    return true
  } catch (error) {
    reportFailure(runId, error)
    return false
  }
}
