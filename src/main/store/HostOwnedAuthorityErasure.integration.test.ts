/**
 * Host-owned erasure and a thread's authority file, driven through the real
 * store.
 *
 * The authority file says that the thread's log, above the revision it names,
 * is its owner's unpublished work. It must go when the log goes: a mark left
 * behind would vouch for whatever log the thread is given next, and for a
 * deleted thread it is a trace of the thread on disk.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ThreadAuthorityFiles,
  threadAuthorityDirectory,
  threadAuthorityFilePath,
  type ThreadAuthorityRecord
} from '../../host-shared/thread-log/ThreadAuthorityFile'
import {
  chatRecord,
  disposeHostOwnedStores,
  importHostOwnedStore
} from './hostOwnedErasure.testutil'

afterEach(disposeHostOwnedStores)

function authority(threadId: string): ThreadAuthorityRecord {
  return {
    threadId,
    writer: { writerId: 'writer-a', pid: process.pid },
    epoch: { host: 'host-1', grant: 1 },
    grantedAtRevision: 2,
    grantedAt: 1_780_000_000_000
  }
}

function authorityNames(profilePath: string, threadId: string): string[] {
  return readdirSync(threadAuthorityDirectory(profilePath))
    .filter((name) => name.startsWith(`${threadId}.`))
    .sort()
}

describe("Host-owned erasure of a thread's authority file", () => {
  it.each(['delete', 'truncate'] as const)(
    'removes the file of the thread on a %s, and leaves its neighbour its own',
    async (kind) => {
      const { AppStore, profilePath } = await importHostOwnedStore([
        chatRecord('chat-erased', 2),
        chatRecord('chat-kept', 2)
      ])
      const files = new ThreadAuthorityFiles(profilePath)
      await files.write(authority('chat-erased'))
      await files.write(authority('chat-kept'))
      // What a write that crashed before its rename leaves beside the file.
      writeFileSync(`${threadAuthorityFilePath(profilePath, 'chat-erased')}.tmp`, 'half a file')
      expect(authorityNames(profilePath, 'chat-erased')).toEqual([
        'chat-erased.json',
        'chat-erased.json.tmp'
      ])

      if (kind === 'delete') await AppStore.deleteChatViaHost('chat-erased')
      else await AppStore.truncateChatHistoryViaHost('chat-erased')

      expect(authorityNames(profilePath, 'chat-erased')).toEqual([])
      expect(await files.read('chat-erased')).toEqual({ kind: 'none' })
      expect(await files.read('chat-kept')).toEqual({
        kind: 'held',
        record: authority('chat-kept')
      })
      expect(AppStore.getPendingHistoryDeletion()).toBeNull()
    }
  )

  it('removes the files of the threads of a cleared workspace only', async () => {
    const { AppStore, profilePath } = await importHostOwnedStore([
      chatRecord('chat-inside', 2, { scope: 'workspace', workspaceId: 'workspace-cleared' }),
      chatRecord('chat-outside', 2, { scope: 'workspace', workspaceId: 'workspace-kept' }),
      chatRecord('chat-global', 2)
    ])
    const files = new ThreadAuthorityFiles(profilePath)
    for (const threadId of ['chat-inside', 'chat-outside', 'chat-global']) {
      await files.write(authority(threadId))
    }

    await AppStore.clearChatsViaHost('workspace-cleared')

    expect((await files.list()).map((entry) => entry.threadId)).toEqual([
      'chat-global',
      'chat-outside'
    ])
    expect(AppStore.getChat('chat-inside')).toBeNull()
    expect(AppStore.getChat('chat-outside')).not.toBeNull()
  })

  it('removes the whole authority directory on a global clear', async () => {
    const { AppStore, profilePath } = await importHostOwnedStore([
      chatRecord('chat-first', 2),
      chatRecord('chat-second', 2)
    ])
    const files = new ThreadAuthorityFiles(profilePath)
    await files.write(authority('chat-first'))
    await files.write(authority('chat-second'))
    // A file whose thread the store no longer lists goes too.
    await files.write(authority('chat-unlisted'))
    expect((await files.list()).map((entry) => entry.threadId)).toEqual([
      'chat-first',
      'chat-second',
      'chat-unlisted'
    ])

    await AppStore.clearChatsViaHost()

    expect(existsSync(threadAuthorityDirectory(profilePath))).toBe(false)
    expect(await files.list()).toEqual([])
    expect(AppStore.getPendingHistoryDeletion()).toBeNull()
  })

  it('erases a thread that never had an authority file as before', async () => {
    const { AppStore, profilePath } = await importHostOwnedStore([chatRecord('chat-erased', 2)])
    expect(existsSync(threadAuthorityDirectory(profilePath))).toBe(false)

    await AppStore.deleteChatViaHost('chat-erased')
    await AppStore.clearChatsViaHost()

    expect(AppStore.getChat('chat-erased')).toBeNull()
    expect(existsSync(threadAuthorityDirectory(profilePath))).toBe(false)
  })
})
