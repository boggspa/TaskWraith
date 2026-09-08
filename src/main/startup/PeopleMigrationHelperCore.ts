import { assertNoPeopleMigrationDeletion } from './PeopleMigrationHelperLease'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { isSafeChatId } from '../../shared/ChatPath'
import { ThreadCatalogueDiskReader } from '../store/ThreadCatalogueDiskReader'
import {
  HUMAN_COLLABORATOR_COMMENT_KIND,
  EXTERNAL_SEAT_TURN_KIND
} from '../collaboration/HumanCollaboratorMessages'
import {
  HumanCollaborationIdentityStore,
  type HumanCollaborationSafeStorage
} from '../collaboration/HumanCollaborationIdentityStore'
import { PeopleToChannelMigrationFinalizationProductionRunner } from '../collaboration/PeopleToChannelMigrationFinalizationProductionRunner'
import type { PeopleToChannelInventoryChat } from '../collaboration/PeopleToChannelMigrationInventory'
import type {
  PeopleMigrationHelperRequest,
  PeopleMigrationResult
} from './PeopleMigrationHelperProtocol'

/** Entire runner, including legacy native-crypto recovery, belongs to the helper. */
export function runPeopleMigrationHelper(
  request: PeopleMigrationHelperRequest,
  safeStorage: HumanCollaborationSafeStorage,
  assertOwner: () => void
): PeopleMigrationResult {
  const assert = (): void => {
    assertOwner()
    assertNoPeopleMigrationDeletion(request.profilePath, request.deletionScope)
  }
  assert()
  const reader = new ThreadCatalogueDiskReader(request)
  const identity = new HumanCollaborationIdentityStore(
    join(request.profilePath, 'human-collaboration-identity.json'),
    safeStorage
  )
  const listChats = (): PeopleToChannelInventoryChat[] => {
    assert()
    let names: string[]
    try {
      names = fs.readdirSync(join(request.profilePath, 'chats'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []
      else throw error
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter(isSafeChatId)
      .sort()
      .flatMap((chatId) => {
        assert()
        const decoded = reader.read(chatId)
        if (!decoded) return []
        if (!decoded.sourceComplete) throw new Error('Migration source history is incomplete')
        const chat = decoded.chat
        return [
          {
            appChatId: chat.appChatId,
            title: chat.title,
            scope: chat.scope,
            chatKind: chat.chatKind,
            parentChatId: chat.parentChatId,
            parentChatRelation: chat.parentChatRelation,
            ...(chat.sideChatContext ? { sideChatContext: chat.sideChatContext } : {}),
            messages: (chat.messages ?? []).filter(
              (message) =>
                message.metadata?.kind === HUMAN_COLLABORATOR_COMMENT_KIND ||
                message.metadata?.kind === EXTERNAL_SEAT_TURN_KIND
            )
          }
        ]
      })
  }
  const runner = new PeopleToChannelMigrationFinalizationProductionRunner({
    userDataPath: request.profilePath,
    safeStorage,
    loadIdentity: () => {
      assert()
      return identity.load()
    },
    hostDisplayName: request.appName,
    listChats,
    beforeDurablePublish: assert,
    afterStage: assert
  })
  const { legacyWriteGate: _gate, ...result } = runner.runToCompletion()
  assert()
  return result
}
