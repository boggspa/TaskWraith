import { AGENTIC_SERVICE_LABELS } from './AgenticServiceMessages'
import { providerLabel } from './ProviderAdapters'
import type { AgenticServiceId, EnsembleRunIdentity, PermissionPresetId } from './store/types'

export interface EnsembleApprovalContextValue {
  label: string
  bodyPrefix: string
  preview: Record<string, unknown>
}

/**
 * Descriptive context for a pending Ensemble approval. The requesting run's
 * signed effective preset travels with the attribution because host-owned
 * auxiliary, unattended, preview-risk, or background clamps can differ from
 * live roster configuration. Ordinary reader-intent fan-out preserves the
 * configured seat tier.
 */
export function ensembleApprovalContext(
  identity: EnsembleRunIdentity | undefined,
  service: AgenticServiceId,
  workspacePath: string | undefined,
  effectivePermissionPresetId?: PermissionPresetId
): EnsembleApprovalContextValue | undefined {
  if (!identity) return undefined
  const provider = providerLabel(identity.provider)
  const role = identity.role || 'Participant'
  const label = `${provider} / ${role}`
  const lines = [
    `Ensemble participant: ${label}`,
    `Provider: ${provider}`,
    `Role: ${role}`,
    identity.stageRole ? `Stage: ${identity.stageRole}` : undefined,
    identity.laneId ? `Lane: ${identity.laneId}` : undefined,
    `Service: ${AGENTIC_SERVICE_LABELS[service]}`,
    workspacePath ? `Workspace: ${workspacePath}` : undefined
  ].filter(Boolean)
  return {
    label,
    bodyPrefix: lines.join('\n'),
    preview: {
      roundId: identity.roundId,
      participantId: identity.participantId,
      ...(identity.laneId ? { laneId: identity.laneId } : {}),
      provider: identity.provider,
      role,
      ...(identity.stageRole ? { stageRole: identity.stageRole } : {}),
      order: identity.order,
      service,
      workspacePath,
      ...(effectivePermissionPresetId ? { effectivePermissionPresetId } : {})
    }
  }
}
