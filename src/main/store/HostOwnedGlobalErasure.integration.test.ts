/**
 * Host-owned global clear, driven through the real store.
 *
 * A global clear removes the journal directory outright. With the journal
 * flusher attached the store keeps a descriptor open on every chat's segment
 * and on the directories it created them in, so the directory may only be
 * removed after those descriptors are retired: a surviving one keeps the
 * unlinked transcript alive and writable, and holds its slot in the journal's
 * descriptor cache for the rest of the process.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  chatRecord,
  disposeHostOwnedStores,
  importHostOwnedStore,
  recordingAdapter
} from './hostOwnedErasure.testutil'

afterEach(disposeHostOwnedStores)

describe('Host-owned global clear of the journal', () => {
  it('retires every cached journal descriptor before it removes the journal directory', async () => {
    let journalDirectory = ''
    const adapter = recordingAdapter(() => journalDirectory)
    const store = await importHostOwnedStore(
      [chatRecord('chat-first', 2), chatRecord('chat-second', 2)],
      adapter
    )
    journalDirectory = store.journalDirectory
    const { AppStore } = store
    const registeredJournalFiles = (): number =>
      AppStore.getMainDurabilitySnapshot().telemetry.poolOwners!.journal.activeFiles
    const streamInto = (chatId: string): void => {
      const current = AppStore.getChat(chatId)!
      AppStore.saveChat({
        ...current,
        runs: [{ runId: `${chatId}-run`, startedAt: '2026-10-04T00:00:00.000Z', status: 'running' }]
      })
    }
    expect(AppStore.getMainDurabilitySnapshot().journal).toMatchObject({
      attached: true,
      mode: 'worker'
    })
    streamInto('chat-first')
    streamInto('chat-second')
    // One open descriptor per chat segment, and one on the directory that
    // holds them: the precondition this test needs.
    const segments = ['chat-first.mutations.jsonl', 'chat-second.mutations.jsonl']
    expect(readdirSync(journalDirectory)).toEqual(expect.arrayContaining(segments))
    const segmentInodes = segments.map((name) => statSync(join(journalDirectory, name)).ino).sort()
    const directoryInode = statSync(journalDirectory).ino
    expect(registeredJournalFiles()).toBe(2)
    expect(adapter.closed).toEqual([])

    await AppStore.clearChatsViaHost()

    expect(existsSync(journalDirectory)).toBe(false)
    expect(registeredJournalFiles()).toBe(0)
    const closedSegments = adapter.closed.filter((entry) => !entry.directory)
    expect(closedSegments.map((entry) => entry.ino).sort()).toEqual(segmentInodes)
    // Closed while the segments still had their names: retire first, remove second.
    for (const entry of closedSegments) {
      expect(entry.journalFilesAtClose).toEqual(expect.arrayContaining(segments))
    }
    // The directory's own descriptor goes too (none is kept on Windows). Left
    // open, the next segment created in a new directory of the same name would
    // count a sync of this removed one as covering its name.
    const closedDirectory = adapter.closed.filter(
      (entry) => entry.directory && entry.ino === directoryInode
    )
    expect(closedDirectory).toHaveLength(process.platform === 'win32' ? 0 : 1)
    for (const entry of closedDirectory) {
      expect(entry.journalFilesAtClose).toEqual(expect.arrayContaining(segments))
    }
  })

  it('journals a chat made after the clear in the new directory, through descriptors of its own', async () => {
    let journalDirectory = ''
    const adapter = recordingAdapter(() => journalDirectory)
    const store = await importHostOwnedStore([chatRecord('chat-cleared', 2)], adapter)
    journalDirectory = store.journalDirectory
    const { AppStore } = store
    const registeredJournalFiles = (): number =>
      AppStore.getMainDurabilitySnapshot().telemetry.poolOwners!.journal.activeFiles
    const streamInto = (chatId: string): void => {
      const current = AppStore.getChat(chatId)!
      AppStore.saveChat({
        ...current,
        runs: [{ runId: `${chatId}-run`, startedAt: '2026-10-04T00:00:00.000Z', status: 'running' }]
      })
    }
    streamInto('chat-cleared')
    expect(registeredJournalFiles()).toBe(1)

    await AppStore.clearChatsViaHost()
    AppStore.saveChat(chatRecord('chat-later', 0))
    await AppStore.awaitChatRecordPersisted('chat-later')
    adapter.synced.length = 0
    streamInto('chat-later')

    expect(readdirSync(journalDirectory)).toContain('chat-later.mutations.jsonl')
    // Only the new chat's segment is open: the cleared one gave its slot back.
    expect(registeredJournalFiles()).toBe(1)
    const laterSegmentInode = statSync(join(journalDirectory, 'chat-later.mutations.jsonl')).ino
    expect(adapter.synced.map((entry) => entry.ino)).toContain(laterSegmentInode)
    // The new segment's name was made durable in the directory that holds it,
    // not in the removed one a kept descriptor would still point at. Windows
    // syncs no directory.
    expect(adapter.synced.some((entry) => entry.journalDirectory)).toBe(
      process.platform !== 'win32'
    )
  })
})
