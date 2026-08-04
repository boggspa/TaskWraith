export interface AgentApprovalEnsembleAttribution {
  participantId: string
  role: string
  stageRole?: string
  laneId?: string
  order?: number
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && Array.from(trimmed).length <= maxLength ? trimmed : undefined
}

/**
 * Approval metadata is descriptive only. Require a complete, bounded Ensemble
 * identity before showing it, so a solo approval never gains a misleading
 * participant label from a partial or legacy preview.
 */
export function agentApprovalEnsembleAttribution(
  preview: unknown
): AgentApprovalEnsembleAttribution | null {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null
  const candidate = (preview as Record<string, unknown>).ensembleParticipant
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const fields = candidate as Record<string, unknown>
  const participantId = boundedString(fields.participantId, 160)
  const role = boundedString(fields.role, 80)
  if (!participantId || !role) return null
  const order = fields.order
  return {
    participantId,
    role,
    ...(boundedString(fields.stageRole, 80)
      ? { stageRole: boundedString(fields.stageRole, 80) }
      : {}),
    ...(boundedString(fields.laneId, 120) ? { laneId: boundedString(fields.laneId, 120) } : {}),
    ...(typeof order === 'number' && Number.isInteger(order) && order > 0 && order <= 1000
      ? { order }
      : {})
  }
}
