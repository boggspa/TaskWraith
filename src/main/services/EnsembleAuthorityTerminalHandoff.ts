import { classifyProviderQuotaWall } from '../ProviderQuotaWallClassifier'
import type { EnsembleParticipantStatus, ProviderId } from '../store/types'

export interface RetainedAuthorityTerminalHandoffSignal {
  kind: 'provider_failure' | 'quota_wall'
  reason: string
}

/**
 * Detect the narrow terminal conditions that must not be force-requeued while
 * an authority-owned fan-out is still settling. A freshly changed execution
 * configuration always gets one turn first: the failed/quota evidence belongs
 * to the old provider/model snapshot, not to the user's queued replacement.
 */
export function retainedAuthorityTerminalHandoffSignal(input: {
  provider: ProviderId
  status: EnsembleParticipantStatus
  content?: string
  replacementSeatReady?: boolean
}): RetainedAuthorityTerminalHandoffSignal | null {
  if (input.replacementSeatReady) return null
  if (classifyProviderQuotaWall(input.provider, input.content).hit) {
    return {
      kind: 'quota_wall',
      reason: 'hit a provider quota or rate-limit wall'
    }
  }
  switch (input.status) {
    case 'failed':
      return { kind: 'provider_failure', reason: 'ended with a failed provider turn' }
    case 'unreachable':
      return { kind: 'provider_failure', reason: 'became unreachable' }
    case 'cancelled':
      return { kind: 'provider_failure', reason: 'ended with a cancelled provider turn' }
    default:
      return null
  }
}
