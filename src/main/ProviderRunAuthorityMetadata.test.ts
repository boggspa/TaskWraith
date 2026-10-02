import { describe, expect, it, vi } from 'vitest'
import { readProviderRunAuthorityMetadata } from './ProviderRunAuthorityMetadata'

describe('current provider authority metadata', () => {
  it.each([undefined, null, '', '   '])(
    'checks the effective fallback workspace for %s',
    (workspaceId) => {
      const deletionBlocks = vi.fn((_chatId, workspace) => workspace === 'blocked')
      const port = {
        readCurrent: () => ({ appChatId: 'chat', workspaceId, persistenceRevision: 1 }),
        deletionBlocks,
        workspaceForPath: () => ' blocked '
      }
      expect(readProviderRunAuthorityMetadata(port, 'chat')).toBeNull()
      expect(deletionBlocks).toHaveBeenCalledWith('chat', 'blocked')
      port.workspaceForPath = () => ' allowed '
      expect(readProviderRunAuthorityMetadata(port, 'chat')?.workspaceId).toBe('allowed')
      expect(deletionBlocks).toHaveBeenLastCalledWith('chat', 'allowed')
    }
  )

  it('uses normalized current workspace for both the check and return', () => {
    const deletionBlocks = vi.fn(() => false)
    const workspaceForPath = vi.fn(() => 'fallback')
    expect(
      readProviderRunAuthorityMetadata(
        {
          readCurrent: () => ({
            appChatId: 'chat',
            workspaceId: ' current ',
            persistenceRevision: 1
          }),
          deletionBlocks,
          workspaceForPath
        },
        'chat'
      )?.workspaceId
    ).toBe('current')
    expect(deletionBlocks).toHaveBeenCalledWith('chat', 'current')
    expect(workspaceForPath).not.toHaveBeenCalled()
  })
  it('reads current bounded metadata on every streamed line without history parsing', () => {
    let revision = 1
    const fullHistoryRead = vi.fn(() => {
      throw new Error('history must not be read')
    })
    const readCurrent = vi.fn(() => ({
      appChatId: 'chat',
      workspaceId: 'workspace',
      persistenceRevision: revision
    }))
    const port = {
      readCurrent,
      deletionBlocks: () => false,
      workspaceForPath: () => null,
      fullHistoryRead
    }
    for (; revision <= 1000; revision++) {
      expect(readProviderRunAuthorityMetadata(port, 'chat')?.persistenceRevision).toBe(revision)
    }
    expect(readCurrent).toHaveBeenCalledTimes(1000)
    expect(fullHistoryRead).not.toHaveBeenCalled()
  })

  it('does not retain metadata across workspace change or erasure', () => {
    let current: { appChatId: string; workspaceId: string; persistenceRevision: number } | null = {
      appChatId: 'chat',
      workspaceId: 'first',
      persistenceRevision: 1
    }
    let erased = false
    const port = {
      readCurrent: () => current,
      deletionBlocks: () => erased,
      workspaceForPath: () => null
    }
    expect(readProviderRunAuthorityMetadata(port, 'chat')?.workspaceId).toBe('first')
    current = { appChatId: 'chat', workspaceId: 'second', persistenceRevision: 2 }
    expect(readProviderRunAuthorityMetadata(port, 'chat')).toEqual(current)
    erased = true
    expect(readProviderRunAuthorityMetadata(port, 'chat')).toBeNull()
    erased = false
    current = null
    expect(readProviderRunAuthorityMetadata(port, 'chat')).toBeNull()
  })

  it('refuses invalid revisions or mismatched canonical identity without fallback', () => {
    for (const current of [
      null,
      { appChatId: 'other', workspaceId: null, persistenceRevision: 1 },
      { appChatId: 'chat', workspaceId: null, persistenceRevision: -1 },
      { appChatId: 'chat', workspaceId: null, persistenceRevision: NaN }
    ]) {
      expect(
        readProviderRunAuthorityMetadata(
          {
            readCurrent: () => current,
            deletionBlocks: () => false,
            workspaceForPath: () => 'fallback'
          },
          'chat'
        )
      ).toBeNull()
    }
  })
})
