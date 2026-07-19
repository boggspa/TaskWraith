import { isKimiAcpProductionPosture } from '../../shared/kimiAcpPosture'
import type { EnsembleParticipant, ProviderId } from '../store/types'

export type HostSeatCompactionProvider = 'kimi' | 'grok'

export interface PendingSeatOverflowEvidence {
  provider: HostSeatCompactionProvider
  model: string
  linkedProviderSessionId: string | null
}

export type PersistedSeatRuntimeState = Pick<
  EnsembleParticipant,
  | 'linkedProviderSessionId'
  | 'contextCompactionSummary'
  | 'promptShellVersion'
  | 'promptDynamicStateVersion'
  | 'taskWraithMcpProfileReceipt'
  | 'kimiAcpNativeSession'
  | 'kimiAcpPostureVersion'
>

export function isHostSeatCompactionProvider(
  provider: ProviderId
): provider is HostSeatCompactionProvider {
  return provider === 'kimi' || provider === 'grok'
}

export function isProductionKimiAcpSeat(
  participant: Pick<
    EnsembleParticipant,
    'provider' | 'kimiAcpNativeSession' | 'kimiAcpPostureVersion'
  >
): boolean {
  return (
    participant.provider === 'kimi' &&
    participant.kimiAcpNativeSession === true &&
    isKimiAcpProductionPosture(participant.kimiAcpPostureVersion)
  )
}

export function persistedSeatRuntimeState(
  participant: EnsembleParticipant
): PersistedSeatRuntimeState {
  return {
    linkedProviderSessionId: participant.linkedProviderSessionId,
    contextCompactionSummary: participant.contextCompactionSummary,
    promptShellVersion: participant.promptShellVersion,
    promptDynamicStateVersion: participant.promptDynamicStateVersion,
    taskWraithMcpProfileReceipt: participant.taskWraithMcpProfileReceipt,
    kimiAcpNativeSession: participant.kimiAcpNativeSession,
    kimiAcpPostureVersion: participant.kimiAcpPostureVersion
  }
}

export function seatOverflowEvidenceKey(chatId: string, participantId: string): string {
  return `${chatId}:${participantId}`
}
