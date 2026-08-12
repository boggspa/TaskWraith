export const MIN_CONTINUATION_HOPS = 1
export const MAX_CONTINUATION_HOPS = 1200
export const DEFAULT_CONTINUATION_HOPS = 6

interface ContinuationHopsEnsembleSnapshot {
  maxContinuationHops?: number
  activeRound?: {
    maxContinuationHops?: number
  } | null
}

export interface ContinuationHopsChangeRequest {
  chatId: string
  maxContinuationHops: number
  previousMaxContinuationHops: number
}

function normalizeLimit(value: number): number | null {
  if (!Number.isFinite(value)) return null
  return Math.max(MIN_CONTINUATION_HOPS, Math.min(MAX_CONTINUATION_HOPS, Math.round(value)))
}

/**
 * Captures the displayed old limit before the renderer's optimistic chat save.
 * Main receives both sides so it can still write an accurate transcript event
 * when saveChat wins the race and canonical state already contains the new
 * value by the time the config IPC arrives.
 */
export function buildContinuationHopsChangeRequest(
  chatId: string,
  ensemble: ContinuationHopsEnsembleSnapshot,
  requestedMax: number
): ContinuationHopsChangeRequest | null {
  const maxContinuationHops = normalizeLimit(requestedMax)
  if (maxContinuationHops === null) return null

  const chatLimit =
    typeof ensemble.maxContinuationHops === 'number'
      ? normalizeLimit(ensemble.maxContinuationHops)
      : null
  const roundLimit =
    typeof ensemble.activeRound?.maxContinuationHops === 'number'
      ? normalizeLimit(ensemble.activeRound.maxContinuationHops)
      : null
  const previousMaxContinuationHops = chatLimit ?? roundLimit ?? DEFAULT_CONTINUATION_HOPS
  if (previousMaxContinuationHops === maxContinuationHops) return null

  return {
    chatId,
    maxContinuationHops,
    previousMaxContinuationHops
  }
}
