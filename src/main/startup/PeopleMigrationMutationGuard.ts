import {
  changesLegacyPeopleDonors,
  transcriptOpsChangeLegacyPeopleDonors
} from '../../shared/legacyPeopleDonors'
import { pendingPeopleDonorMutation } from '../../host-shared/thread-catalogue/PeopleDonorMutationGate'
import type { ChatRecord } from '../store/types'
import type { ChatTranscriptOp } from '../../shared/chatUpdateTransport'

export function createPeopleMigrationMutationGuard(
  profilePath: string,
  getChat: (id: string) => ChatRecord | null
) {
  return {
    beforeChatInventoryWrite: () => pendingPeopleDonorMutation(profilePath),
    beforeSaveChat(next: ChatRecord): Promise<void> | undefined {
      const pending = pendingPeopleDonorMutation(profilePath)
      if (!pending || (next as ChatRecord & { summaryOnly?: boolean }).summaryOnly) return undefined
      return changesLegacyPeopleDonors(getChat(next.appChatId), next) ? pending : undefined
    },
    beforeTranscriptOps(
      chatId: string,
      ops: readonly ChatTranscriptOp[]
    ): Promise<void> | undefined {
      const pending = pendingPeopleDonorMutation(profilePath)
      if (!pending) return undefined
      const previous = getChat(chatId)
      return previous && transcriptOpsChangeLegacyPeopleDonors(previous, ops) ? pending : undefined
    }
  }
}
