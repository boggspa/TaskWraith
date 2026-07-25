import { chatPathForId, isSafeChatId } from '../ChatPath'
import {
  normalizeChatGitWorkflow,
  type ChatGitWorkflowInput,
  type ChatGitWorkflowSnapshot
} from '../../shared/chatGitWorkflow'
import type { ChatRecord } from './types'
import { readStoredChat, writeJsonAtomically } from './ThreadWorktreeBindingPersistence'

export interface PersistChatGitWorkflowPatchInput {
  chatsDir: string
  chatId: string
  /** The workflow marker to persist, or null to clear it. Clearing deletes the
   * field entirely: an absent gitWorkflow means the thread never graduated to
   * the sidebar's Git section (or was explicitly removed from it). */
  gitWorkflow: ChatGitWorkflowInput | null
  admitMutation?: (chat: ChatRecord) => Promise<void>
}

export interface ReadChatGitWorkflowInput {
  chatsDir: string
  chatId: string
}

/**
 * Writes the small, main-owned git-workflow marker patch without using the
 * legacy synchronous whole-record writer. The caller is responsible for
 * process-local serialization and cache invalidation. updatedAt is stamped
 * here so reporter clocks never enter the record.
 */
export async function persistChatGitWorkflowPatch(
  input: PersistChatGitWorkflowPatchInput
): Promise<ChatRecord> {
  if (!isSafeChatId(input.chatId)) {
    throw new Error('A git workflow can only be recorded on a saved chat.')
  }

  const chatPath = chatPathForId(input.chatsDir, input.chatId)
  const stored = await readStoredChat(chatPath, input.chatId)
  await input.admitMutation?.(stored)

  const next: ChatRecord = {
    ...stored,
    updatedAt: Date.now(),
    persistenceRevision: persistenceRevision(stored) + 1
  }
  if (input.gitWorkflow === null) {
    delete next.gitWorkflow
  } else {
    next.gitWorkflow = normalizeChatGitWorkflow({
      ...input.gitWorkflow,
      updatedAt: Date.now()
    })
  }
  await writeJsonAtomically(chatPath, next)
  return next
}

/** Returns the durable workflow marker, treating malformed legacy data as
 * absent so consumers simply skip the chat instead of failing. */
export async function readChatGitWorkflow(
  input: ReadChatGitWorkflowInput
): Promise<ChatGitWorkflowSnapshot | undefined> {
  if (!isSafeChatId(input.chatId)) return undefined
  const stored = await readStoredChat(chatPathForId(input.chatsDir, input.chatId), input.chatId)
  if (!stored.gitWorkflow) return undefined
  try {
    return normalizeChatGitWorkflow(stored.gitWorkflow)
  } catch {
    return undefined
  }
}

function persistenceRevision(chat: Pick<ChatRecord, 'persistenceRevision'>): number {
  const revision = chat.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? (revision as number) : 0
}
