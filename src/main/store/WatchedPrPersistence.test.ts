import * as fs from 'fs'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { persistWatchedPrPatch, readWatchedPr } from './WatchedPrPersistence'
import type { ChatRecord } from './types'

const testRoot = path.join('/tmp', `taskwraith-watched-pr-persist-${process.pid}`)

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function storedChat(chatId: string): ChatRecord {
  return {
    appChatId: chatId,
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: 'Thread',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: 3,
    archived: false,
    messages: [],
    runs: []
  }
}

function watchFor(chatId: string) {
  return {
    chatId,
    workspacePath: '/repo/',
    owner: 'boggspa',
    repo: 'TaskWraith',
    prNumber: 42
  }
}

async function writeStored(chatsDir: string, chat: ChatRecord): Promise<void> {
  await fs.promises.mkdir(chatsDir, { recursive: true })
  await fs.promises.writeFile(
    path.join(chatsDir, `${chat.appChatId}.json`),
    JSON.stringify(chat)
  )
}

describe('persistWatchedPrPatch', () => {
  it('atomically persists only the watch opt-in and leaves no temporary record behind', async () => {
    const chatId = 'thread-1'
    const chatsDir = path.join(testRoot, 'chats')
    await writeStored(chatsDir, { ...storedChat(chatId), title: 'Keep this title' })

    const saved = await persistWatchedPrPatch({
      chatsDir,
      chatId,
      watchedPr: watchFor(chatId)
    })

    expect(saved.title).toBe('Keep this title')
    expect(saved.persistenceRevision).toBe(4)
    expect(saved.watchedPr).toEqual({
      chatId,
      workspacePath: '/repo',
      owner: 'boggspa',
      repo: 'TaskWraith',
      prNumber: 42
    })
    const onDisk = JSON.parse(
      await fs.promises.readFile(path.join(chatsDir, `${chatId}.json`), 'utf-8')
    ) as ChatRecord
    expect(onDisk).toMatchObject(saved)
    expect((await fs.promises.readdir(chatsDir)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
    await expect(readWatchedPr({ chatsDir, chatId })).resolves.toEqual(saved.watchedPr)
  })

  it('clearing the watch deletes the field but preserves the thread worktree binding', async () => {
    const chatId = 'thread-2'
    const chatsDir = path.join(testRoot, 'chats')
    const binding = {
      schemaVersion: 1 as const,
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: '/repo/.taskwraith/worktrees/thread-2',
      branch: 'taskwraith/thread-thread-2'
    }
    await writeStored(chatsDir, {
      ...storedChat(chatId),
      threadWorktreeBinding: binding,
      watchedPr: watchFor(chatId)
    })

    const cleared = await persistWatchedPrPatch({ chatsDir, chatId, watchedPr: null })

    expect(cleared.watchedPr).toBeUndefined()
    expect(cleared.threadWorktreeBinding).toEqual(binding)
    const onDisk = JSON.parse(
      await fs.promises.readFile(path.join(chatsDir, `${chatId}.json`), 'utf-8')
    ) as ChatRecord
    expect(onDisk.watchedPr).toBeUndefined()
    expect(onDisk.threadWorktreeBinding).toEqual(binding)
    await expect(readWatchedPr({ chatsDir, chatId })).resolves.toBeUndefined()
  })

  it('setting the watch on a bound chat keeps both main-owned fields', async () => {
    const chatId = 'thread-3'
    const chatsDir = path.join(testRoot, 'chats')
    const binding = {
      schemaVersion: 1 as const,
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: '/repo/.taskwraith/worktrees/thread-3',
      branch: 'taskwraith/thread-thread-3'
    }
    await writeStored(chatsDir, { ...storedChat(chatId), threadWorktreeBinding: binding })

    const saved = await persistWatchedPrPatch({ chatsDir, chatId, watchedPr: watchFor(chatId) })

    expect(saved.threadWorktreeBinding).toEqual(binding)
    expect(saved.watchedPr?.prNumber).toBe(42)
  })

  it('does not create a watch for a missing chat', async () => {
    await expect(
      persistWatchedPrPatch({
        chatsDir: path.join(testRoot, 'chats'),
        chatId: 'missing-thread',
        watchedPr: watchFor('missing-thread')
      })
    ).rejects.toThrow('no longer available')
  })

  it('rejects a descriptor that names a different chat', async () => {
    const chatId = 'thread-4'
    const chatsDir = path.join(testRoot, 'chats')
    await writeStored(chatsDir, storedChat(chatId))

    await expect(
      persistWatchedPrPatch({ chatsDir, chatId, watchedPr: watchFor('other-thread') })
    ).rejects.toThrow('incomplete')
  })

  it('treats a malformed legacy watch as absent so the poll cycle skips the chat', async () => {
    const chatId = 'legacy-thread'
    const chatsDir = path.join(testRoot, 'chats')
    await writeStored(chatsDir, {
      ...storedChat(chatId),
      watchedPr: { chatId, workspacePath: '/repo' } as ChatRecord['watchedPr']
    })

    await expect(readWatchedPr({ chatsDir, chatId })).resolves.toBeUndefined()
  })
})
