import type { ChatRecord } from '../../../main/store/types'
import { isMultiviewEnsembleParticipantSelectionValid } from './multiviewEnsembleComposer'
import { SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY } from './sideChatLifecycle'

/**
 * Apply a selection inside updateChatById's canonical updater. Returning the
 * source for an unchanged selection avoids another render and whole-record
 * save when a nested roster picker selects its already-selected seat.
 *
 * Do not decide this from the record at click time: hydration can still hold
 * an earlier A -> B selection, so a later A must enter that queue too. The
 * caller also retains its explicit round override and local selection before
 * crossing the existing updateChatById ordering boundary.
 */
export function applyEnsembleParticipantSelection(
  source: ChatRecord,
  participantId: string,
  now: () => number = Date.now
): ChatRecord {
  if (!isMultiviewEnsembleParticipantSelectionValid(source, participantId)) return source
  if (source.providerMetadata?.[SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY] === participantId) {
    return source
  }
  return {
    ...source,
    providerMetadata: {
      ...(source.providerMetadata || {}),
      [SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]: participantId
    },
    updatedAt: now()
  }
}
