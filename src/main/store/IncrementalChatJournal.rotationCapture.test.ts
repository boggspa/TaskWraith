import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { IncrementalChatJournalDescriptorCache } from './IncrementalChatJournalDescriptorCache'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import { deriveChatRecordMutation } from './ChatRecordMutation'
import { checkpointFileReference } from './CheckpointPreparationProtocol'
import { prepareCheckpoint } from './CheckpointPreparationCore'
import type { ChatRecord } from './types'

describe('real rotation custody and immutable R preparation', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true]
  ])(
    'adopts sealed custody with barrier failure=%s and unlink failure=%s',
    async (failFirstBarrier, failFirstUnlink) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-adopt-'))
      const pending: Array<() => void> = []
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
        fsyncSync: fs.fsyncSync,
        close: fs.closeSync
      })
      const cache = new IncrementalChatJournalDescriptorCache(flusher)
      const originalUnlink = fs.unlinkSync.bind(fs)
      let unlinkFailed = false
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
        if (
          failFirstUnlink &&
          !unlinkFailed &&
          fs.existsSync(file) &&
          String(file).endsWith('.sealed.mutations.jsonl')
        ) {
          unlinkFailed = true
          throw Object.assign(new Error('Injected sealed unlink failure'), { code: 'EACCES' })
        }
        originalUnlink(file)
      })
      syncBuiltinESMExports()
      const originalDirectoryBarrier = cache.awaitDirectoryMutation.bind(cache)
      let firstBarrier = true
      cache.awaitDirectoryMutation = async (directory) => {
        if (failFirstBarrier && firstBarrier) {
          firstBarrier = false
          throw new Error('Injected directory durability failure')
        }
        await originalDirectoryBarrier(directory)
      }
      const journal = createIncrementalChatJournal(root, {
        descriptorCache: cache,
        descriptorDrainSync: () => flusher.drainSync(),
        rotationEnabled: true,
        checkpointPreparation: {
          start(source) {
            const outputPath = path.join(root, 'adoption.tmp')
            fs.writeFileSync(outputPath, '')
            const output = checkpointFileReference(outputPath)
            const prepared = prepareCheckpoint({ ...source, output, maxOutputBytes: 1024 * 1024 })
            return {
              output,
              result: Promise.resolve(prepared),
              cancel() {
                /* synchronous fake has exited */
              },
              release() {
                /* no retained fake credit */
              }
            }
          }
        }
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
        if (!journal.checkpointDeferred || !journal.awaitDeferredDurability)
          throw new Error('Missing seams')
        const adoption = journal.checkpointDeferred('chat')
        // Attach rejection handling before the injected failure's microtask.
        const observed = adoption.then(
          (result) => ({ result }),
          (error: Error) => ({ error })
        )
        await Promise.resolve()
        const third = { ...second, title: 'three', persistenceRevision: 3 }
        journal.append(deriveChatRecordMutation(second, third), { durability: 'deferred' })
        expect(fs.existsSync(path.join(root, 'chat.sealed.mutations.jsonl'))).toBe(true)
        while (pending.length) pending.shift()!()
        const outcome = await observed
        if (failFirstBarrier || failFirstUnlink) {
          expect(outcome).toMatchObject({
            error: {
              message: failFirstBarrier
                ? 'Injected directory durability failure'
                : 'Injected sealed unlink failure'
            }
          })
          expect(fs.existsSync(path.join(root, 'chat.sealed.mutations.jsonl'))).toBe(true)
          const retry = journal.checkpointDeferred('chat')
          await Promise.resolve()
          while (pending.length) pending.shift()!()
          expect(await retry).toBe('checkpointed')
        } else expect(outcome).toEqual({ result: 'checkpointed' })
        expect(fs.existsSync(path.join(root, 'chat.sealed.mutations.jsonl'))).toBe(false)
        expect(fs.existsSync(path.join(root, 'chat.mutations.jsonl'))).toBe(true)
        expect(journal.replay('chat').revision).toBe(3)
      } finally {
        unlinkSpy.mockRestore()
        syncBuiltinESMExports()
        cache.retireSync()
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )
  it('bounds outstanding sealed history with counted synchronous checkpoints', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-bound-'))
    const flusher = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: () => ({
        joinSync() {
          /* strict-only test never starts an async flight */
        }
      }),
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
