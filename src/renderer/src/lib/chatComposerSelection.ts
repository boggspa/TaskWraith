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
