import * as fs from 'fs'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { persistChatGitWorkflowPatch, readChatGitWorkflow } from './ChatGitWorkflowPersistence'
import type { ChatRecord } from './types'

const testRoot = path.join('/tmp', `taskwraith-git-workflow-persist-${process.pid}`)

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

async function writeStored(chatsDir: string, chat: ChatRecord): Promise<void> {
  await fs.promises.mkdir(chatsDir, { recursive: true })
  await fs.promises.writeFile(path.join(chatsDir, `${chat.appChatId}.json`), JSON.stringify(chat))
}

describe('persistChatGitWorkflowPatch', () => {
  it('atomically persists only the marker, stamping updatedAt in main', async () => {
    const chatId = 'thread-1'
    const chatsDir = path.join(testRoot, 'chats')
    await writeStored(chatsDir, { ...storedChat(chatId), title: 'Keep this title' })

    const saved = await persistChatGitWorkflowPatch({
      chatsDir,
      chatId,
      gitWorkflow: { state: 'open', prNumber: 42, prUrl: 'https://github.com/o/r/pull/42' }
    })

    expect(saved.title).toBe('Keep this title')
    expect(saved.persistenceRevision).toBe(4)
    expect(saved.gitWorkflow).toMatchObject({
      state: 'open',
      prNumber: 42,
      prUrl: 'https://github.com/o/r/pull/42'
    })
    expect(saved.gitWorkflow?.updatedAt).toBeGreaterThan(0)
    const onDisk = JSON.parse(
      await fs.promises.readFile(path.join(chatsDir, `${chatId}.json`), 'utf-8')
    ) as ChatRecord
    expect(onDisk).toMatchObject(saved)
    expect((await fs.promises.readdir(chatsDir)).filter((entry) => entry.endsWith('.tmp'))).toEqual(
      []
    )
    await expect(readChatGitWorkflow({ chatsDir, chatId })).resolves.toEqual(saved.gitWorkflow)
  })

  it('clearing deletes the field but preserves the other main-owned patches', async () => {
    const chatId = 'thread-2'
    const chatsDir = path.join(testRoot, 'chats')
    const watchedPr = {
      chatId,
      workspacePath: '/repo',
      owner: 'boggspa',
      repo: 'TaskWraith',
      prNumber: 42
    }
    await writeStored(chatsDir, {
      ...storedChat(chatId),
      watchedPr,
      gitWorkflow: { state: 'merged', prNumber: 42, updatedAt: 7 }
    })

    const cleared = await persistChatGitWorkflowPatch({ chatsDir, chatId, gitWorkflow: null })

    expect(cleared.gitWorkflow).toBeUndefined()
    expect(cleared.watchedPr).toEqual(watchedPr)
    const onDisk = JSON.parse(
      await fs.promises.readFile(path.join(chatsDir, `${chatId}.json`), 'utf-8')
    ) as ChatRecord
    expect(onDisk.gitWorkflow).toBeUndefined()
    expect(onDisk.watchedPr).toEqual(watchedPr)
    await expect(readChatGitWorkflow({ chatsDir, chatId })).resolves.toBeUndefined()
  })

  it('does not create a marker for a missing chat', async () => {
    await expect(
      persistChatGitWorkflowPatch({
        chatsDir: path.join(testRoot, 'chats'),
        chatId: 'missing-thread',
        gitWorkflow: { state: 'pushed' }
      })
    ).rejects.toThrow('no longer available')
  })

  it('rejects an invalid state', async () => {
    const chatId = 'thread-3'
    const chatsDir = path.join(testRoot, 'chats')
    await writeStored(chatsDir, storedChat(chatId))

    await expect(
      persistChatGitWorkflowPatch({
        chatsDir,
        chatId,
        gitWorkflow: { state: 'bogus' } as unknown as { state: 'pushed' }
      })
    ).rejects.toThrow('incomplete')
  })

  it('treats a malformed legacy marker as absent', async () => {
    const chatId = 'legacy-thread'
    const chatsDir = path.join(testRoot, 'chats')
    await writeStored(chatsDir, {
      ...storedChat(chatId),
      gitWorkflow: { state: 'open' } as ChatRecord['gitWorkflow']
    })

    await expect(readChatGitWorkflow({ chatsDir, chatId })).resolves.toBeUndefined()
  })
})
