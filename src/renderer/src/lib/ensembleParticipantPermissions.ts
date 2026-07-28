import type { ChatRecord } from '../../../main/store/types'
import { clonePermissionOverrides } from './ensembleRosterPresets'
import { withSessionActivityLedger } from './sessionActivityLedger'

export interface EnsembleParticipantPermissionPatch {
  permissionPresetId: NonNullable<
    ChatRecord['ensemble']
  >['participants'][number]['permissionPresetId']
  permissionOverrides: NonNullable<
    ChatRecord['ensemble']
  >['participants'][number]['permissionOverrides']
}

export function resolveParticipantPermissionPatch(
  source: ChatRecord,
  participantId: string
): EnsembleParticipantPermissionPatch | null {
  const selected = source.ensemble?.participants.find(
    (participant) => participant.id === participantId
  )
  if (!selected) return null
  return {
    permissionPresetId: selected.permissionPresetId,
    permissionOverrides: clonePermissionOverrides(selected.permissionOverrides)
  }
}

export function cloneParticipantPermissionPatch(
  patch: EnsembleParticipantPermissionPatch
): EnsembleParticipantPermissionPatch {
  return {
    permissionPresetId: patch.permissionPresetId,
    permissionOverrides: clonePermissionOverrides(patch.permissionOverrides)
  }
}

/** Apply one participant's permission posture to the full roster atomically. */
export function applyParticipantPermissionsToEnsemble(
  source: ChatRecord,
  participantId: string
): ChatRecord {
  const ensemble = source.ensemble
  const permissionPatch = resolveParticipantPermissionPatch(source, participantId)
  if (!ensemble || !permissionPatch) return source

  const patched: ChatRecord = {
    ...source,
    ensemble: {
      ...ensemble,
      participants: ensemble.participants.map((participant) => ({
        ...participant,
        ...cloneParticipantPermissionPatch(permissionPatch)
      })),
      updatedAt: new Date().toISOString()
    },
    updatedAt: Date.now()
  }
  return withSessionActivityLedger(source, patched)
}
