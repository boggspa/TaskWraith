export const READ_ONLY_RECON_LABEL = 'Read-only (recon)'
export const PLAN_LABEL = 'Plan'

export function resolvePlanModeLabel(presetId: string | null | undefined): string {
  return presetId === 'read_only' ? PLAN_LABEL : READ_ONLY_RECON_LABEL
}
