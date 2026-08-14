import { randomUUID } from 'crypto'
import type { EnsembleRoundState } from './store/types'

const runtimeInstanceId = randomUUID()

/** Stable only for this main-process lifetime. */
export function currentEnsembleRuntimeInstanceId(): string {
  return runtimeInstanceId
}

/**
 * A turn transition describes live in-memory orchestration and therefore
 * cannot be inherited by a replacement main process. Normalization runs on
 * every persisted read, so an app restart drops the foreign projection without
 * relying on a timeout that could either lie early or mask a real crash.
 */
export function discardForeignEnsembleTurnTransition(
  round: EnsembleRoundState
): EnsembleRoundState {
  if (!round.turnTransition || round.turnTransition.runtimeInstanceId === runtimeInstanceId) {
    return round
  }
  const next = { ...round }
  delete next.turnTransition
  return next
}
