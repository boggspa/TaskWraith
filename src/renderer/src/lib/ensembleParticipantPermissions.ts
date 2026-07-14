import type { ChatRecord } from '../../../main/store/types'
import { isEnsembleActiveRoundDispatchLive } from './chatBusyState'
import { clonePermissionOverrides } from './ensembleRosterPresets'
import { withSessionActivityLedger } from './sessionActivityLedger'

export const APPLY_PERMISSIONS_TO_ALL_ACTIVE_ROUND_MESSAGE =
  'Finish the current Ensemble round before applying permissions to the full roster.'

/** Apply one participant's permission posture to the full roster atomically. */
export function applyParticipantPermissionsToEnsemble(
  source: ChatRecord,
  participantId: string
): ChatRecord {
  const ensemble = source.ensemble
  const selected = ensemble?.participants.find((participant) => participant.id === participantId)
  if (!ensemble || !selected) return source
  if (isEnsembleActiveRoundDispatchLive(ensemble.activeRound)) return source

  const patched: ChatRecord = {
    ...source,
    ensemble: {
      ...ensemble,
      participants: ensemble.participants.map((participant) => ({
        ...participant,
        permissionPresetId: selected.permissionPresetId,
        permissionOverrides: clonePermissionOverrides(selected.permissionOverrides)
      })),
      updatedAt: new Date().toISOString()
    },
    updatedAt: Date.now()
  }
  return withSessionActivityLedger(source, patched)
}
