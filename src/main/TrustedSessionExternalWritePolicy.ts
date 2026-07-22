import { isFullShellAccessGranted } from './EffectiveRunPermissions'
import type { EnsembleRunIdentity, EffectiveRunPermissions, ProviderId } from './store/types'
import type { TrustedSessionScope } from './TrustedSessionGrants'

/**
 * Trusted Session is a live, task-scoped host-authority grant. An external
 * write is therefore automatic only for the matching active chat/lane—not for
 * global runs, unrelated providers, or a merely write-capable posture.
 */
export function canAutoApproveTrustedSessionExternalWrite(input: {
  provider: ProviderId
  chatId?: string
  workspacePath?: string
  runtimeProfileId?: string
  ensembleRun?: EnsembleRunIdentity
  effectivePermissions?: EffectiveRunPermissions
  externalPathAccess?: 'read' | 'write'
  isTrustedSessionGranted: (scope: TrustedSessionScope) => boolean
}): boolean {
  if (
    input.externalPathAccess !== 'write' ||
    !input.chatId ||
    !input.workspacePath ||
    !isFullShellAccessGranted(input.effectivePermissions) ||
    input.effectivePermissions?.agenticServices.fileChanges !== 'allow'
  ) {
    return false
  }

  return input.isTrustedSessionGranted({
    chatId: input.chatId,
    provider: input.provider,
    workspacePath: input.workspacePath,
    ensembleParticipantId: input.ensembleRun?.participantId,
    ensembleLaneId: input.ensembleRun?.laneId,
    runtimeProfileId: input.runtimeProfileId
  })
}
