import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { IncrementalChatJournalDescriptorCache } from './IncrementalChatJournalDescriptorCache'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import { deriveChatRecordMutation } from './ChatRecordMutation'
import { checkpointFileReference } from './CheckpointPreparationProtocol'
import { prepareCheckpoint } from './CheckpointPreparationCore'
import type { ChatRecord } from './types'

describe('real rotation custody and immutable R preparation', () => {
  it('bounds outstanding sealed history with counted synchronous checkpoints', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-bound-'))
    const flusher = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: () => ({ joinSync() {} }),
      fsyncSync: fs.fsyncSync,
      close: fs.closeSync
    })
    const cache = new IncrementalChatJournalDescriptorCache(flusher)
    const journal = createIncrementalChatJournal(root, {
      descriptorCache: cache,
      descriptorDrainSync: () => flusher.drainSync(),
      rotationEnabled: true,
      maxJournalEntries: 1
    })
    let record: ChatRecord = {
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
      journal.initialize('chat', record)
      for (let revision = 2; revision <= 6; revision++) {
        const next = { ...record, title: String(revision), persistenceRevision: revision }
        journal.append(deriveChatRecordMutation(record, next))
        record = next
        const active = path.join(root, 'chat.mutations.jsonl')
        expect(
          !fs.existsSync(active) ||
            fs.readFileSync(active, 'utf8').split('\n').filter(Boolean).length <= 1
        ).toBe(true)
      }
      expect(journal.stats()).toMatchObject({ forcedSynchronousCheckpoints: 2 })
      expect(journal.replay('chat').revision).toBe(6)
    } finally {
      cache.retireSync()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('rotates cold D1 without sync flush, keeps sealed barriers, and prepares R despite later appends', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-capture-'))
    const pending: Array<() => void> = []
    let syncs = 0
    const flusher = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync(fd, done) {
        const finish = () => {
          fs.fsyncSync(fd)
          done()
        }
        pending.push(finish)
        return {
          joinSync() {
            pending.splice(pending.indexOf(finish), 1)
            finish()
          }
        }
      },
      fsyncSync(fd) {
        syncs++
        fs.fsyncSync(fd)
      },
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
    try {
      journal.initialize('chat', first)
      const second = { ...first, title: 'two', persistenceRevision: 2 }
      journal.append(deriveChatRecordMutation(first, second), { durability: 'deferred' })
      let settled = false
      if (!journal.awaitDeferredDurability || !journal.rotateForPreparation)
        throw new Error('Missing seams')
      const barrier = journal.awaitDeferredDurability('chat').then(() => {
        settled = true
      })
      const before = syncs
      const source = journal.rotateForPreparation('chat')!
      expect(source.revision).toBe(2)
      expect(syncs).toBe(before)
      const third = { ...second, title: 'three', persistenceRevision: 3 }
      journal.append(deriveChatRecordMutation(second, third), { durability: 'deferred' })
      await Promise.resolve()
      expect(settled).toBe(false)
      const outputPath = path.join(root, 'prepared.tmp')
      fs.writeFileSync(outputPath, '')
      const prepared = prepareCheckpoint({
        ...source,
        output: checkpointFileReference(outputPath),
        maxOutputBytes: 1024 * 1024
      })
      expect(prepared.revision).toBe(2)
      expect(JSON.parse(fs.readFileSync(outputPath, 'utf8')).record.title).toBe('two')
      expect(journal.replay('chat').record?.title).toBe('three')
      const fourth = { ...third, title: 'four', persistenceRevision: 4 }
      journal.append(deriveChatRecordMutation(third, fourth))
      await barrier
      expect(settled).toBe(true)
      expect(journal.rotateForPreparation('chat')).toBeNull()
    } finally {
      cache.retireSync()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
