import type { HostRecoveryProjection } from '../../shared/hostProtocol'
import type { HostRuntimeRecoverySummary } from '../../host-runtime/HostRuntimeBootstrap'

export interface HostRecoveryProjectionInput {
  summary: HostRuntimeRecoverySummary
  /** Optional externally observed checkpoint timestamp in milliseconds. */
  lastCheckpointAt?: number
}

function mapReopenStatus(
  state: HostRuntimeRecoverySummary['delta']['recoveryState']
): HostRecoveryProjection['reopenStatus'] {
  switch (state) {
    case 'clean':
      return 'clean'
    case 'recovered-truncated-tail':
    case 'recovered-corrupt-interior':
      return 'recovered'
    case 'degraded-checkpoint':
      return 'degraded'
    default:
      return 'unknown'
  }
}

/**
 * Convert internal store recovery facts to the single bounded wire vocabulary.
 *
 * Position is copied from the supplied HostDeltaStore-derived summary; this
 * mapper never maintains or reconstructs generation/cursor state.
 */
export function projectHostRecovery(input: HostRecoveryProjectionInput): HostRecoveryProjection {
  const { summary } = input
  const projection: HostRecoveryProjection = {
    lastGeneration: summary.position.generation,
    lastCursor: summary.position.cursor,
    reopenStatus: mapReopenStatus(summary.delta.recoveryState)
  }
  const checkpointAt = input.lastCheckpointAt
  if (checkpointAt !== undefined && Number.isFinite(checkpointAt) && checkpointAt >= 0) {
    projection.lastCheckpointAt = checkpointAt
  }

  if (summary.receipts.indeterminate > 0) {
    const count = Math.max(0, Math.floor(summary.receipts.indeterminate))
    projection.detail = 'indeterminate_receipts=' + count
  }

  return projection
}
