export interface ChatApprovalModeSources {
  metadataApprovalMode?: string
  settingsSnapshotApprovalMode?: string
  fallbackApprovalMode?: string
}

/**
 * Resolve a chat's permission posture without consulting renderer-global
 * composer state. Every visible pane must remain deterministic while another
 * pane changes its approval mode.
 */
export function resolveChatApprovalMode(sources: ChatApprovalModeSources): string {
  return (
    sources.metadataApprovalMode ??
    sources.settingsSnapshotApprovalMode ??
    sources.fallbackApprovalMode ??
    'default'
  )
}

export interface StaleTrustedSessionDemotionInput {
  rememberedPresetId?: unknown
  trustedSessionEnabled: boolean
}

export interface StaleTrustedSessionDemotionPatch {
  approvalMode: 'auto_edit'
  workflowMode: 'normal'
  permissionPresetId: 'workspace_write'
}

/**
 * Full Access grants live only in main-process memory, but the remembered
 * composer selection (`permissionPresetId: 'full_access'`) persists across
 * relaunches. Without reconciliation the picker keeps claiming Full Access
 * while ComposerService silently downgrades the composed posture to
 * workspace_write — the run is safe, but the UI lies about the active
 * authority. Returns the same demotion patch the explicit "stop Full
 * Access" picker action applies, or null when the selection is already
 * truthful (not full_access, or the grant is live).
 */
export function staleTrustedSessionDemotionPatch(
  input: StaleTrustedSessionDemotionInput
): StaleTrustedSessionDemotionPatch | null {
  if (input.rememberedPresetId !== 'full_access' || input.trustedSessionEnabled) return null
  return {
    approvalMode: 'auto_edit',
    workflowMode: 'normal',
    permissionPresetId: 'workspace_write'
  }
}
