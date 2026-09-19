import { isAcceptedEnsembleSteerResult } from './composerDraftSubmission'

/**
 * What `window.api.runEnsembleRound` actually resolves with.
 *
 * `EnsembleOrchestrator.startRound` is STATUS-RETURNING, not throwing: it
 * declares `{ status: 'started' | 'queued' | 'steered' | 'ignored' | 'busy' }`.
 * The IPC handler additionally optional-chains the orchestrator
 * (`getEnsembleOrchestrator()?.startRound(...)`), so a missing orchestrator
 * resolves the whole call to `undefined` AND skips the handler's own
 * durability barrier. Every one of those is a REFUSAL that arrives as a
 * fulfilled promise.
 */
export interface EnsembleRoundDispatchReceipt {
  status?: string
  roundId?: string
  /**
   * Why main refused, when main knows. Main often does know -- the round was
   * not owned, it rolled over, the append dep was unwired -- but the receipt
   * had no channel for it, so every refusal rendered as the same generic
   * sentence and the orchestrator's own `No active Ensemble round` named the
   * wrong cause for a round the user could watch running.
   *
   * Must be a CLOSED set of code-authored literals: no provider text, no
   * paths, no transcript content, nothing interpolated from a record. Free
   * text crossing a process boundary is exactly what the fixed-by-code
   * messages in `threadCatalogueRequestError` exist to prevent.
   */
  error?: string
}

export interface EnsembleRoundDispatchRefusal {
  /** The refusing status, or `no-receipt` when the call resolved nothing. */
  reason: string
  /** Operator-facing text; safe to log on a surface that must not throw. */
  message: string
}

const REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  ignored: 'Ensemble did not start a round for this prompt.',
  busy: 'Ensemble is still finishing another round.',
  'no-receipt': 'Ensemble dispatch returned no receipt; the orchestrator was unavailable.'
}

/**
 * Classify a dispatch receipt, returning `null` for an accepted send.
 *
 * The sibling steer path already gates on `isAcceptedEnsembleSteerResult`
 * before treating a submission as consumed. The normal send path did not, so a
 * refused round cleared the composer, lit the thinking indicator and reported
 * success. Sharing the same predicate keeps the two paths from drifting again.
 */
export function ensembleRoundDispatchRefusal(
  receipt: EnsembleRoundDispatchReceipt | null | undefined
): EnsembleRoundDispatchRefusal | null {
  if (isAcceptedEnsembleSteerResult(receipt)) return null
  const status = typeof receipt?.status === 'string' ? receipt.status.trim() : ''
  const reason = status || 'no-receipt'
  const detail = typeof receipt?.error === 'string' ? receipt.error.trim() : ''
  return {
    reason,
    message: detail || REFUSAL_MESSAGES[reason] || `Ensemble refused the round (${reason}).`
  }
}
