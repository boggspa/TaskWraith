import type { EffectiveRunPermissions } from '../store/types'

/**
 * Whether the active participant entered this run already authorised to use
 * Mesh Canvas. This intentionally reads the signed *run* posture rather than
 * PermissionService's cross-run session-grant cache: a provider session may
 * retain a profile receipt for catalogue compatibility, but it never owns this
 * authority.
 */
export function meshCanvasParticipantHasPregrantedAuthority(
  effectivePermissions: EffectiveRunPermissions | null | undefined
): boolean {
  const policy = effectivePermissions?.agenticServices.meshCanvas
  if (policy === 'allow') return true
  return (
    policy === 'workspace' &&
    effectivePermissions?.workspaceGrantServiceIds.includes('meshCanvas') === true
  )
}
