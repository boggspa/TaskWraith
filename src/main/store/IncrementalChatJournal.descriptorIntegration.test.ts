import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { IncrementalChatJournalDescriptorCache } from './IncrementalChatJournalDescriptorCache'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import { deriveChatRecordMutation } from './ChatRecordMutation'
import type { ChatRecord } from './types'

describe('journal descriptor integration', () => {
  it('routes D1 to the cached barrier, strict appends to sync, and retires before erasure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-i2-'))
    const pending: Array<() => void> = []
    const flusher = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (fd, done) => {
        const finish = () => {
          fs.fsyncSync(fd)
          done()
        }
        pending.push(finish)
        return {
          joinSync: () => {
            pending.splice(pending.indexOf(finish), 1)
            finish()
          }
        }
      },
      fsyncSync: fs.fsyncSync,
      close: fs.closeSync
    })
    const cache = new IncrementalChatJournalDescriptorCache(flusher)
    const journal = createIncrementalChatJournal(root, { descriptorCache: cache })
    const first: ChatRecord = {
      appChatId: 'chat',
      title: 'chat',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      persistenceRevision: 1,
      messages: [],
      runs: []
    }
    try {
      journal.initialize('chat', first)
      const second = { ...first, title: 'second', persistenceRevision: 2 }
      journal.append(deriveChatRecordMutation(first, second), { durability: 'deferred' })
      let durable = false
      const barrier = journal.awaitDeferredDurability('chat').then(() => {
        durable = true
      })
      await Promise.resolve()
      expect(durable).toBe(false)
      while (pending.length) pending.shift()!()
      await barrier
      const third = { ...second, title: 'third', persistenceRevision: 3 }
      journal.append(deriveChatRecordMutation(second, third))
      expect(journal.replay('chat').record?.title).toBe('third')
      journal.delete('chat')
      expect(journal.replay('chat').record).toBeNull()
      journal.purge('chat')
      journal.clear()
    } finally {
      await cache.retire()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
