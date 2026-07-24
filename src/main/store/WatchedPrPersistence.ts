import { chatPathForId, isSafeChatId } from '../ChatPath'
import type { WatchedPrDescriptor } from '../../shared/watchedPrNotify'
import type { ChatRecord } from './types'
import { readStoredChat, writeJsonAtomically } from './ThreadWorktreeBindingPersistence'

export interface PersistWatchedPrPatchInput {
  chatsDir: string
  chatId: string
  /** The opt-in to persist, or null to stop watching. Clearing deletes the
   * field entirely: an absent watchedPr means the chat is not watched. */
  watchedPr: WatchedPrDescriptor | null
  admitMutation?: (chat: ChatRecord) => Promise<void>
}

export interface ReadWatchedPrInput {
  chatsDir: string
  chatId: string
}

/**
 * Writes the small, main-owned watched-PR opt-in patch without using the
 * legacy synchronous whole-record writer. The caller is responsible for
 * process-local serialization and cache invalidation.
 */
export async function persistWatchedPrPatch(
  input: PersistWatchedPrPatchInput
): Promise<ChatRecord> {
  if (!isSafeChatId(input.chatId)) {
    throw new Error('A pull request can only be watched from a saved chat.')
  }

  const chatPath = chatPathForId(input.chatsDir, input.chatId)
  const stored = await readStoredChat(chatPath, input.chatId)
  await input.admitMutation?.(stored)

  const next: ChatRecord = {
    ...stored,
    updatedAt: Date.now(),
    persistenceRevision: persistenceRevision(stored) + 1
  }
  if (input.watchedPr === null) {
    delete next.watchedPr
  } else {
    next.watchedPr = normalizeWatchedPr(input.watchedPr, input.chatId)
  }
  await writeJsonAtomically(chatPath, next)
  return next
}

/** Returns the durable watched-PR opt-in, treating malformed legacy data as
 * absent so the poll cycle simply skips the chat instead of failing. */
export async function readWatchedPr(
  input: ReadWatchedPrInput
): Promise<WatchedPrDescriptor | undefined> {
  if (!isSafeChatId(input.chatId)) return undefined
  const stored = await readStoredChat(chatPathForId(input.chatsDir, input.chatId), input.chatId)
  if (!stored.watchedPr) return undefined
  try {
    return normalizeWatchedPr(stored.watchedPr, input.chatId)
  } catch {
    return undefined
  }
}

function normalizeWatchedPr(descriptor: unknown, chatId: string): WatchedPrDescriptor {
  const record =
    descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)
      ? (descriptor as Partial<WatchedPrDescriptor>)
      : null
  const workspacePath =
    typeof record?.workspacePath === 'string'
      ? record.workspacePath.trim().replace(/\/+$/, '')
      : ''
  const owner = typeof record?.owner === 'string' ? record.owner.trim() : ''
  const repo = typeof record?.repo === 'string' ? record.repo.trim() : ''
  const prNumber = record?.prNumber
  if (
    record?.chatId !== chatId ||
    !workspacePath ||
    !owner ||
    owner.includes('/') ||
    !repo ||
    repo.includes('/') ||
    typeof prNumber !== 'number' ||
    !Number.isSafeInteger(prNumber) ||
    prNumber <= 0
  ) {
    throw new Error('The watched PR description is incomplete. Toggle the watch off and on again.')
  }
  return { chatId, workspacePath, owner, repo, prNumber }
}

function persistenceRevision(chat: Pick<ChatRecord, 'persistenceRevision'>): number {
  const revision = chat.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? (revision as number) : 0
}
