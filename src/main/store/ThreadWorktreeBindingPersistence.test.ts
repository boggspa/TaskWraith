import * as fs from 'fs'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { persistThreadWorktreeBindingPatch } from './ThreadWorktreeBindingPersistence'
import type { ChatRecord } from './types'

const testRoot = path.join('/tmp', `taskwraith-worktree-binding-persist-${process.pid}`)

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

describe('persistThreadWorktreeBindingPatch', () => {
  it('atomically persists only the binding and leaves no temporary record behind', async () => {
    const chatId = 'thread-1'
    const chatsDir = path.join(testRoot, 'chats')
    await fs.promises.mkdir(chatsDir, { recursive: true })
    await fs.promises.writeFile(
      path.join(chatsDir, `${chatId}.json`),
      JSON.stringify({ ...storedChat(chatId), title: 'Keep this title' })
    )
    const saved = await persistThreadWorktreeBindingPatch({
      chatsDir,
      chatId,
      binding: {
        schemaVersion: 1,
        baseWorkspacePath: '/repo/',
        effectiveWorkspacePath: '/repo/.taskwraith/worktrees/thread-1/',
        branch: 'taskwraith/thread-thread-1'
      }
    })

    expect(saved.title).toBe('Keep this title')
    expect(saved.persistenceRevision).toBe(4)
    expect(saved.threadWorktreeBinding).toEqual({
      schemaVersion: 1,
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: '/repo/.taskwraith/worktrees/thread-1',
      branch: 'taskwraith/thread-thread-1'
    })
    const onDisk = JSON.parse(
      await fs.promises.readFile(path.join(chatsDir, `${chatId}.json`), 'utf-8')
    ) as ChatRecord
    expect(onDisk).toMatchObject(saved)
    expect((await fs.promises.readdir(chatsDir)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('does not create a binding for a missing chat', async () => {
    await expect(
      persistThreadWorktreeBindingPatch({
        chatsDir: path.join(testRoot, 'chats'),
        chatId: 'missing-thread',
        binding: {
          schemaVersion: 1,
          baseWorkspacePath: '/repo',
          effectiveWorkspacePath: '/repo/.taskwraith/worktrees/missing-thread',
          branch: 'taskwraith/thread-missing-thread'
        }
      })
    ).rejects.toThrow('no longer available')
  })
})
