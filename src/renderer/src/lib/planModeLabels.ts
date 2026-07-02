export const READ_ONLY_RECON_LABEL = 'Read-Only/Recon'
export const PLAN_LABEL = 'Plan'
export const DEFAULT_APPROVAL_LABEL = 'Default Approval'
export const FULL_WORKSPACE_ACCESS_LABEL = 'Full Workspace Access'

/**
 * Permission preset options offered by the composer's permission picker — used
 * for BOTH the solo composer and every ensemble participant. Full Workspace
 * Access (`auto_edit`) is a USER-ONLY elevation (agents can't self-elevate to
 * it), so it is safe — and intended — to offer in the ensemble picker too.
 *
 * Single source of truth on purpose: the solo and ensemble lists used to be
 * duplicated inline and drifted, silently dropping Full Workspace Access from
 * the ensemble picker. Keep both pickers reading from here so it can't recur.
 */
export function composerPermissionOptions(): Array<{ value: string; label: string }> {
  return [
    { value: 'plan', label: PLAN_LABEL },
    { value: 'read_only', label: READ_ONLY_RECON_LABEL },
    { value: 'default', label: DEFAULT_APPROVAL_LABEL },
    { value: 'auto_edit', label: FULL_WORKSPACE_ACCESS_LABEL }
  ]
}

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
    return input.permissionPresetId === 'plan' ? PLAN_LABEL : READ_ONLY_RECON_LABEL
  }
  return input === 'plan' ? PLAN_LABEL : READ_ONLY_RECON_LABEL
}
