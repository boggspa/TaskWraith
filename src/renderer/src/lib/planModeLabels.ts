export const READ_ONLY_RECON_LABEL = 'Read-Only/Recon'
export const PLAN_LABEL = 'Plan'

export interface PlanModeLabelInput {
  workflowMode?: string | null
  permissionPresetId?: string | null
}

export function resolvePlanModeLabel(
  input: PlanModeLabelInput | string | null | undefined
): string {
  if (typeof input === 'object' && input !== null) {
    if (input.workflowMode === 'plan') return PLAN_LABEL
    if (input.workflowMode === 'normal') return READ_ONLY_RECON_LABEL
    return input.permissionPresetId === 'read_only' || input.permissionPresetId === 'plan'
      ? PLAN_LABEL
      : READ_ONLY_RECON_LABEL
  }
  return input === 'read_only' || input === 'plan' ? PLAN_LABEL : READ_ONLY_RECON_LABEL
}
