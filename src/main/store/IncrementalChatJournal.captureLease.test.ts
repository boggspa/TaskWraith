import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { IncrementalChatJournalDescriptorCache } from './IncrementalChatJournalDescriptorCache'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import { deriveChatRecordMutation } from './ChatRecordMutation'
import type { ChatRecord } from './types'

describe('journal source lease custody', () => {
  it('pins R across append growth and rotation before child open, then survives erasure until release', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-lease-'))
    const flusher = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: () => ({
        joinSync() {
          /* strict-only fixture */
        }
      }),
      fsyncSync: fs.fsyncSync,
      close: fs.closeSync
    })
    const cache = new IncrementalChatJournalDescriptorCache(flusher)
    const journal = createIncrementalChatJournal(root, {
      descriptorCache: cache,
      descriptorDrainSync: () => flusher.drainSync(),
      rotationEnabled: true
    })
    const first: ChatRecord = {
      appChatId: 'chat',
      title: 'one',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: [],
      persistenceRevision: 1
    }
    let lease: ReturnType<NonNullable<typeof journal.captureSource>> = null
    try {
      journal.initialize('chat', first)
      const second = { ...first, title: 'two', persistenceRevision: 2 }
      journal.append(deriveChatRecordMutation(first, second))
      if (!journal.captureSource || !journal.rotateForPreparation)
        throw new Error('Capture seams missing')
      expect(journal.captureSource('chat', 1)).toBeNull()
      lease = journal.captureSource('chat', 2)
      if (!lease?.active) throw new Error('Active capture missing')
      const prefix = Buffer.alloc(lease.active.prefixBytes)
      fs.readSync(lease.active.fd, prefix, 0, prefix.length, 0)
      const third = { ...second, title: 'three', persistenceRevision: 3 }
      journal.append(deriveChatRecordMutation(second, third))
      expect(lease.revision).toBe(2)
      expect(lease.isCurrent()).toBe(true)
      journal.rotateForPreparation('chat')
      expect(lease.isCurrent()).toBe(true)
      const afterRotation = Buffer.alloc(prefix.length)
      fs.readSync(lease.active.fd, afterRotation, 0, afterRotation.length, 0)
      expect(afterRotation).toEqual(prefix)
      journal.delete('chat')
      expect(lease.isCurrent()).toBe(false)
      // Cache erasure closes writer custody only. The pinned read descriptor
      // remains usable for a child inheritance/duplication handoff until release.
      expect(fs.fstatSync(lease.active.fd).isFile()).toBe(true)
      lease.release()
      lease.cancel()
      expect(() => fs.fstatSync(lease!.active!.fd)).toThrow()
    } finally {
      lease?.release()
      cache.retireSync()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a replacement inode even when the path and byte length match', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-replaced-'))
    const journal = createIncrementalChatJournal(root)
    const first: ChatRecord = {
      appChatId: 'chat',
      title: 'one',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: [],
      persistenceRevision: 1
    }
    try {
      journal.initialize('chat', first)
      if (!journal.captureSource) throw new Error('Capture seam missing')
      const lease = journal.captureSource('chat', 1)!
      const checkpoint = path.join(root, 'chat.checkpoint.json')
      const bytes = fs.readFileSync(checkpoint)
      fs.renameSync(checkpoint, `${checkpoint}.old`)
      fs.writeFileSync(checkpoint, bytes)
      expect(lease.isCurrent()).toBe(false)
      expect(fs.fstatSync(lease.checkpoint.fd).isFile()).toBe(true)
      lease.cancel()
      lease.release()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
