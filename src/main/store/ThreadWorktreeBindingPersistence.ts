import * as fs from 'fs'
import * as path from 'path'
import { chatPathForId, isSafeChatId } from '../ChatPath'
import type { ThreadWorktreeBinding } from '../run/ThreadWorktreeBinding'
import type { ChatRecord } from './types'

export interface PersistThreadWorktreeBindingPatchInput {
  chatsDir: string
  chatId: string
  binding: ThreadWorktreeBinding
  admitMutation?: (chat: ChatRecord) => Promise<void>
}

export interface ReadThreadWorktreeBindingInput {
  chatsDir: string
  chatId: string
}

/**
 * Writes the small, main-owned worktree identity patch without using the
 * legacy synchronous whole-record writer. The caller is responsible for
 * process-local serialization and cache invalidation.
 */
export async function persistThreadWorktreeBindingPatch(
  input: PersistThreadWorktreeBindingPatchInput
): Promise<ChatRecord> {
  if (!isSafeChatId(input.chatId)) {
    throw new Error('An isolated worktree can only be bound to a saved chat.')
  }

  const chatPath = chatPathForId(input.chatsDir, input.chatId)
  const stored = await readStoredChat(chatPath, input.chatId)
  await input.admitMutation?.(stored)

  const next: ChatRecord = {
    ...stored,
    threadWorktreeBinding: normalizeBinding(input.binding),
    updatedAt: Date.now(),
    persistenceRevision: persistenceRevision(stored) + 1
  }
  await writeJsonAtomically(chatPath, next)
  return next
}

/** Returns a valid durable binding, treating malformed legacy data as absent
 * so the allocator can re-check or recreate the isolated worktree safely. */
export async function readThreadWorktreeBinding(
  input: ReadThreadWorktreeBindingInput
): Promise<ThreadWorktreeBinding | undefined> {
  if (!isSafeChatId(input.chatId)) return undefined
  const stored = await readStoredChat(chatPathForId(input.chatsDir, input.chatId), input.chatId)
  if (!stored.threadWorktreeBinding) return undefined
  try {
    return normalizeBinding(stored.threadWorktreeBinding)
  } catch {
    return undefined
  }
}

async function readStoredChat(chatPath: string, chatId: string): Promise<ChatRecord> {
  let raw: string
  try {
    raw = await fs.promises.readFile(chatPath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new Error(`The chat ${chatId} is no longer available.`)
    }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new Error(`The saved chat ${chatId} could not be read safely.`)
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { appChatId?: unknown }).appChatId !== chatId
  ) {
    throw new Error(`The saved chat ${chatId} could not be read safely.`)
  }
  return parsed as ChatRecord
}

function normalizeBinding(binding: unknown): ThreadWorktreeBinding {
  const record =
    binding && typeof binding === 'object' && !Array.isArray(binding)
      ? (binding as Partial<ThreadWorktreeBinding>)
      : null
  const baseWorkspacePath =
    typeof record?.baseWorkspacePath === 'string'
      ? record.baseWorkspacePath.trim().replace(/\/+$/, '')
      : ''
  const effectiveWorkspacePath =
    typeof record?.effectiveWorkspacePath === 'string'
      ? record.effectiveWorkspacePath.trim().replace(/\/+$/, '')
      : ''
  const branch = typeof record?.branch === 'string' ? record.branch.trim() : ''
  if (
    record?.schemaVersion !== 1 ||
    !baseWorkspacePath ||
    !effectiveWorkspacePath ||
    !branch
  ) {
    throw new Error('The isolated worktree binding is incomplete. Retry the run to prepare it again.')
  }
  return { schemaVersion: 1, baseWorkspacePath, effectiveWorkspacePath, branch }
}

function persistenceRevision(chat: Pick<ChatRecord, 'persistenceRevision'>): number {
  const revision = chat.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? (revision as number) : 0
}

async function writeJsonAtomically(filePath: string, data: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  let handle: fs.promises.FileHandle | null = null
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    handle = await fs.promises.open(tempPath, 'w', 0o600)
    await handle.writeFile(JSON.stringify(data, null, 2), 'utf-8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.promises.rename(tempPath, filePath)
    try {
      await fs.promises.chmod(filePath, 0o600)
    } catch {
      // Best effort on filesystems that do not support POSIX modes.
    }
    try {
      const directory = await fs.promises.open(path.dirname(filePath), 'r')
      await directory.sync()
      await directory.close()
    } catch {
      // Directory fsync is best effort on some filesystems.
    }
  } catch (error) {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // Preserve the original write failure.
      }
    }
    try {
      await fs.promises.rm(tempPath, { force: true })
    } catch {
      // A stale temp file is safer than masking the original failure.
    }
    throw error
  }
}
