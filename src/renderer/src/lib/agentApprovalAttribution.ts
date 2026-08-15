import type { PermissionPresetId } from '../../../main/store/types'

export interface AgentApprovalEnsembleAttribution {
  participantId: string
  role: string
  stageRole?: string
  laneId?: string
  order?: number
  effectivePermissionPresetId?: PermissionPresetId
}

const PERMISSION_PRESET_IDS: ReadonlySet<string> = new Set([
  'read_only',
  'plan',
  'default',
  'workspace_write',
  'full_access',
  'custom'
])

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
/**
 * Both approval authorities bake the requesting seat into the title so the
 * ledger row and paired-device summary stay self-describing ("K3Review: …"
 * from the main authority, "Pi / K3Review: …" from the service gate). The
 * modal renders the seat as an @Role chip, so on screen that baked prefix is
 * pure repetition — strip it for display only, and only on an exact match
 * against the VALIDATED attribution (never a fuzzy prefix, so agent-authored
 * titles cannot lose leading text they happen to share with a role name).
 */
export function agentApprovalDisplayTitle(
  title: string,
  attribution: AgentApprovalEnsembleAttribution | null,
  providerLabel?: string
): string {
  if (!attribution) return title
  const prefixes = [
    `${attribution.role}: `,
    ...(providerLabel ? [`${providerLabel} / ${attribution.role}: `] : [])
  ]
  for (const prefix of prefixes) {
    if (title.startsWith(prefix) && title.length > prefix.length) {
      return title.slice(prefix.length)
    }
  }
  return title
}

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
  const effectivePermissionPresetId = boundedString(fields.effectivePermissionPresetId, 40)
  return {
    participantId,
    role,
    ...(boundedString(fields.stageRole, 80)
      ? { stageRole: boundedString(fields.stageRole, 80) }
      : {}),
    ...(boundedString(fields.laneId, 120) ? { laneId: boundedString(fields.laneId, 120) } : {}),
    ...(typeof order === 'number' && Number.isInteger(order) && order > 0 && order <= 1000
      ? { order }
      : {}),
    ...(effectivePermissionPresetId && PERMISSION_PRESET_IDS.has(effectivePermissionPresetId)
      ? { effectivePermissionPresetId: effectivePermissionPresetId as PermissionPresetId }
      : {})
  }
}
