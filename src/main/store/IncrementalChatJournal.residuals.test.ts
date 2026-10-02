import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { deriveChatRecordMutation } from './ChatRecordMutation'
import type { ChatRecord } from './types'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import { IncrementalChatJournalDescriptorCache } from './IncrementalChatJournalDescriptorCache'

describe('actual journal residual sites', () => {
  it('counts a failed immediate fsync attempt without diagnostic errors masking the disk failure or retry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-residual-fsync-'))
    const diskFailure = new Error('actual immediate fsync failed')
    let fail = false
    const events: string[] = []
    const pool = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (fd, done) => ({
        joinSync: () => {
          fs.fsyncSync(fd)
          done()
        }
      }),
      fsyncSync: (fd) => {
        if (fail) throw diskFailure
        fs.fsyncSync(fd)
      },
      close: fs.closeSync
    })
    const cache = new IncrementalChatJournalDescriptorCache(pool)
    const journal = createIncrementalChatJournal(root, {
      descriptorCache: cache,
      descriptorDrainSync: () => pool.drainSync(),
      residualObserver: (counter) => {
        events.push(counter)
        throw new Error('diagnostic failure')
      }
    })
    const first: ChatRecord = {
      appChatId: 'chat',
      title: 'one',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      persistenceRevision: 1,
      messages: [],
      runs: []
    }
    const second = { ...first, title: 'two', persistenceRevision: 2 }
    try {
      journal.initialize('chat', first)
      fail = true
      expect(() =>
        journal.append(deriveChatRecordMutation(first, second), { durability: 'immediate' })
      ).toThrow(diskFailure)
      expect(events).toEqual(['d2d3Durability'])
      expect(pool.counters.errors).toBe(1)
      fail = false
      journal.append(deriveChatRecordMutation(first, second), { durability: 'immediate' })
      expect(events).toEqual(['d2d3Durability', 'd2d3Durability'])
      expect(journal.replay('chat').record).toEqual(second)
    } finally {
      fail = false
      cache.retireSync()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('counts the real sealed-segment bound fallback before its synchronous checkpoint', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-residual-bound-'))
    const events: string[] = []
    const pool = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (fd, done) => ({
        joinSync: () => {
          fs.fsyncSync(fd)
          done()
        }
      }),
      fsyncSync: fs.fsyncSync,
      close: fs.closeSync
    })
    const cache = new IncrementalChatJournalDescriptorCache(pool)
    const journal = createIncrementalChatJournal(root, {
      descriptorCache: cache,
      descriptorDrainSync: () => pool.drainSync(),
      rotationEnabled: true,
      maxJournalEntries: 1,
      residualObserver: (counter) => {
        events.push(counter)
        throw new Error('diagnostics failed')
      }
    })
    const first: ChatRecord = {
      appChatId: 'chat',
      title: 'one',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      persistenceRevision: 1,
      messages: [],
      runs: []
    }
    const second = { ...first, title: 'two', persistenceRevision: 2 }
    const third = { ...second, title: 'three', persistenceRevision: 3 }
    try {
      journal.initialize('chat', first)
      journal.append(deriveChatRecordMutation(first, second), { durability: 'immediate' })
      journal.append(deriveChatRecordMutation(second, third), { durability: 'immediate' })
      expect(events.filter((event) => event === 'forcedSynchronousCheckpoints')).toHaveLength(1)
      expect(journal.replay('chat').record).toEqual(third)
    } finally {
      cache.retireSync()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('counts immediate barriers and actual refused preparation while observation failures preserve replay', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-residual-'))
    const events: string[] = []
    const journal = createIncrementalChatJournal(root, {
      checkpointPreparation: { start: () => null },
      residualObserver: (counter) => {
        events.push(counter)
        throw new Error('diagnostics failed')
      }
    })
    const first: ChatRecord = {
      appChatId: 'chat',
      title: 'one',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      persistenceRevision: 1,
      messages: [],
      runs: []
    }
    const second = { ...first, title: 'two', persistenceRevision: 2 }
    try {
      journal.initialize('chat', first)
      journal.append(deriveChatRecordMutation(first, second), { durability: 'immediate' })
      expect(events).toEqual(['d2d3Durability'])
      if (!journal.checkpointDeferred) throw new Error('Real journal preparation API unavailable')
      expect(await journal.checkpointDeferred('chat')).toBe('unavailable')
      expect(events).toEqual(['d2d3Durability', 'preparationRefusals'])
      expect(journal.replay('chat').record).toEqual(second)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('does not emit preparation refusal merely because the worker integration is off', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-residual-off-'))
    const events: string[] = []
    const journal = createIncrementalChatJournal(root, {
      residualObserver: (counter) => events.push(counter)
    })
    try {
      if (!journal.checkpointDeferred) throw new Error('Real journal preparation API unavailable')
      expect(await journal.checkpointDeferred('chat')).toBe('unchanged')
      expect(events).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
