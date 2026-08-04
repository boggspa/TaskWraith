import type { EffectiveRunPermissions } from '../store/types'

/**
 * Whether the active participant's signed run posture permits Mesh Canvas to
 * be exposed as a direct tool surface. Exposure is not authority: `ask` and an
 * ungranted `workspace` policy deliberately return true so Accept Edits can
 * request a human decision, while every invocation still passes through the
 * ordinary meshCanvas service gate. Only an effective `deny` (or missing run
 * posture) keeps the surface out of the participant's birth catalogue.
 */
export function meshCanvasParticipantCanRequestAccess(
  effectivePermissions: EffectiveRunPermissions | null | undefined
): boolean {
  const policy = effectivePermissions?.agenticServices.meshCanvas
  return policy === 'ask' || policy === 'workspace' || policy === 'allow'
}
