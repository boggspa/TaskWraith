import type { EnsembleConfig, EnsembleRoundState } from '../store/types'

type RoundWallMsLedger = EnsembleConfig['roundWallMsById']

/**
 * Records one terminal round's exact wall duration without mutating the
 * existing ledger. Invalid boundaries leave persisted history untouched; the
 * projection layer can still use its explicit legacy run-interval fallback.
 */
export function recordEnsembleRoundWallMs(
  ledger: RoundWallMsLedger,
  round: Pick<EnsembleRoundState, 'roundId' | 'startedAt' | 'endedAt'>
): RoundWallMsLedger {
  const id = typeof round.roundId === 'string' ? round.roundId.trim() : ''
  const startedAt = Date.parse(round.startedAt || '')
  const endedAt = Date.parse(round.endedAt || '')
  if (!id || !Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return ledger
  }

  const wallMs = Math.floor(endedAt - startedAt)
  if (!Number.isSafeInteger(wallMs)) return ledger
  const currentLedger =
    ledger && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger : undefined
  if (currentLedger?.[id] === wallMs) return ledger
  return { ...(currentLedger || {}), [id]: wallMs }
}
