import { describe, expect, it, vi } from 'vitest'
import { CurrentChatAuthorityIndex } from './CurrentChatAuthorityMetadata'
import fs from 'node:fs'
import type { ChatRecord } from './types'

vi.mock('electron', () => ({
  app: { getPath: () => `/tmp/taskwraith-current-authority-${process.pid}` }
}))

describe('current chat authority metadata', () => {
  it('keeps accepted Host rebase metadata current while catalogue publication is delayed', async () => {
    const { AppStore } = await import('../store')
    const chatId = '22222222-2222-4222-8222-222222222222'
    const record = {
      appChatId: chatId,
      scope: 'workspace',
      chatKind: 'single',
      provider: 'codex',
      title: 'Host shadow',
      workspaceId: 'workspace-a',
      workspacePath: '/repo',
      persistenceRevision: 3,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      messages: [],
      runs: []
    } as ChatRecord
    const owner = AppStore as unknown as {
      adoptHostPersistRecovery(
        id: string,
        base: ChatRecord,
        next: ChatRecord,
        expected: number
      ): unknown
    }
    owner.adoptHostPersistRecovery(chatId, record, record, 2)
    const fullRead = vi.spyOn(AppStore, 'getChat')
    try {
      for (let revision = 4; revision < 20; revision += 1) {
        const next = { ...record, persistenceRevision: revision }
        owner.adoptHostPersistRecovery(chatId, record, next, revision - 1)
        expect(AppStore.getCurrentChatAuthorityMetadata(chatId)?.persistenceRevision).toBe(revision)
      }
      owner.adoptHostPersistRecovery(chatId, record, { ...record, workspaceId: 'workspace-b' }, 2)
      expect(AppStore.getCurrentChatAuthorityMetadata(chatId)?.workspaceId).toBe('workspace-b')
      expect(fullRead).not.toHaveBeenCalled()
    } finally {
      fullRead.mockRestore()
    }
  })

  it('serves streamed Store metadata without full chat reads and invalidates changed disk state', async () => {
    const { AppStore } = await import('../store')
    const chatId = '11111111-1111-4111-8111-111111111111'
    AppStore.saveChat({
      appChatId: chatId,
      scope: 'workspace',
      chatKind: 'single',
      provider: 'codex',
      title: 'Authority metadata',
      workspaceId: 'workspace-a',
      workspacePath: '/repo',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      messages: [],
      runs: []
    } as ChatRecord)
    await AppStore.flushAllChatSaves()
    const fullRead = vi.spyOn(fs, 'readFileSync')
    try {
      for (let line = 0; line < 100; line += 1) {
        expect(AppStore.getCurrentChatAuthorityMetadata(chatId)?.workspaceId).toBe('workspace-a')
      }
      expect(
        fullRead.mock.calls.filter(([file]) => String(file).endsWith(`/chats/${chatId}.json`))
      ).toHaveLength(0)
      const chatPath = AppStore.getChatRecordPath(chatId)!
      const stat = fs.statSync(chatPath)
      const original = fs.readFileSync(chatPath, 'utf8')
      const replacement = original.replace('workspace-a', 'workspace-b')
      expect(Buffer.byteLength(replacement)).toBe(stat.size)
      fs.writeFileSync(`${chatPath}.replacement`, replacement)
      fs.utimesSync(`${chatPath}.replacement`, stat.atime, stat.mtime)
      fs.renameSync(`${chatPath}.replacement`, chatPath)
      // @portability-ok: the replacement existed beside the original before the
      // rename-over, so the two inodes can never be equal on any filesystem.
      expect(fs.statSync(chatPath).ino).not.toBe(stat.ino)
      expect(AppStore.getCurrentChatAuthorityMetadata(chatId)?.workspaceId).toBe('workspace-b')
    } finally {
      fullRead.mockRestore()
    }
  })

  it('reflects owner metadata through transcript growth without reading history', () => {
    let revision = 1
    let workspaceId = 'workspace-a'
    let deleted = false
    const history = vi.fn(() => {
      throw new Error('Full history read forbidden')
    })
    const index = new CurrentChatAuthorityIndex<{
      appChatId: string
      workspaceId: string
      persistenceRevision: number
    }>(() => 'owned-source')
    let record = { appChatId: 'chat', workspaceId, persistenceRevision: revision }
    const ports = {
      deleted: () => deleted,
      cached: () => record,
      invalidateClean: () => {},
      reconcile: history
    }
    for (let line = 0; line < 100; line += 1) {
      revision += 1
      record = { appChatId: 'chat', workspaceId, persistenceRevision: revision }
      index.remember('chat', record)
      expect(index.read('chat', ports)?.persistenceRevision).toBe(revision)
    }
    workspaceId = 'workspace-b'
    record = { ...record, workspaceId }
    index.remember('chat', record)
    expect(index.read('chat', ports)?.workspaceId).toBe('workspace-b')
    deleted = true
    expect(index.read('chat', ports)).toBeNull()
    expect(history).not.toHaveBeenCalled()
  })

  it('invalidates stale clean records before canonical reconciliation', () => {
    let current = 'old-source'
    const index = new CurrentChatAuthorityIndex<{ workspaceId: string }>(() => current)
    let cached: { workspaceId: string } | undefined = { workspaceId: 'old' }
    index.remember('chat', cached)
    current = 'new-source'
    const ports = {
      deleted: () => false,
      cached: () => cached,
      invalidateClean: () => {
        cached = undefined
      },
      reconcile: () => {
        expect(cached).toBeUndefined()
        return { workspaceId: 'new' }
      }
    }
    expect(index.read('chat', ports)?.workspaceId).toBe('new')
  })
})
