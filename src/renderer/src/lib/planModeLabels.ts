export const READ_ONLY_RECON_LABEL = 'Ask'
export const PLAN_LABEL = 'Plan'
export const DEFAULT_APPROVAL_LABEL = 'Accept Edits'
export const WORKSPACE_WRITE_LABEL = 'Full WS Access'
export const TRUSTED_SESSION_LABEL = 'Full Access'

/**
 * Permission preset options offered by the composer's permission picker — used
 * for BOTH the solo composer and every ensemble participant. These values are
 * real PermissionPresetIds, not provider approval-mode aliases, so
 * `workspace_write` and `full_access` survive a round-trip to the signed run
 * posture instead of collapsing into the same `auto_edit` value.
 *
 * Single source of truth on purpose: the solo and ensemble lists used to be
 * duplicated inline and drifted, silently dropping the elevated presets from
 * the ensemble picker. Keep both pickers reading from here so it can't recur.
 */
export function composerPermissionOptions(): Array<{ value: string; label: string }> {
  return [
    { value: 'plan', label: PLAN_LABEL },
    { value: 'read_only', label: READ_ONLY_RECON_LABEL },
    { value: 'default', label: DEFAULT_APPROVAL_LABEL },
    { value: 'workspace_write', label: WORKSPACE_WRITE_LABEL },
    { value: 'full_access', label: TRUSTED_SESSION_LABEL }
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
