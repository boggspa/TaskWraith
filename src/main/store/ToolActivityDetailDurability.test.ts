import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import { MainDurabilityDirectoryLeases } from './MainDurabilityDirectoryLeases'
import {
  ToolActivityDetailDurability,
  flushToolDetailDependencies
} from './ToolActivityDetailDurability'
import { ToolActivityDetailBatchWriter } from './ToolActivityDetailLedger'
import { prepareChatForPersistence } from './ChatPersistencePreparation'
import type { ChatRecord } from './types'

describe('detail durability side channel', () => {
  it('retires exact run custody before unlink, preserves siblings and permits saves after global clear', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detail-erasure-'))
    const flusher = new MainDurabilityFlusher({
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
    const registry = new MainDurabilityDirectoryLeases(flusher)
    const owner = new ToolActivityDetailDurability({ flusher, directoryLeases: registry })
    const a = path.join(root, 'run-1', 'details')
    const b = path.join(root, 'run-1-extra', 'details')
    try {
      owner.append(a, Buffer.from('old'), 0)
      owner.append(b, Buffer.from('sibling'), 0)
      owner.retireForErasureSync([path.dirname(a)])
      fs.rmSync(path.dirname(a), { recursive: true })
      owner.append(a, Buffer.from('new'), 0).flushSync()
      owner.append(b, Buffer.from('+'), 7).flushSync()
      expect(fs.readFileSync(a, 'utf8')).toBe('new')
      expect(fs.readFileSync(b, 'utf8')).toBe('sibling+')
      owner.retireForErasureSync()
      fs.rmSync(path.dirname(a), { recursive: true })
      fs.rmSync(path.dirname(b), { recursive: true })
      owner.append(a, Buffer.from('after-clear'), 0).flushSync()
      expect(fs.readFileSync(a, 'utf8')).toBe('after-clear')
      await owner.retire()
      await registry.retire()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('attempts later dependency debt after early synchronous failures and preserves every error', () => {
    const first = new Error('first debt')
    const second = new Error('second debt')
    const attempted: number[] = []
    const tokens = [first, second, null].map((failure, index) => ({
      awaitDurable: async () => {},
      journalDependencies: () => [],
      flushSync: () => {
        attempted.push(index)
        if (failure) throw failure
      }
    }))
    try {
      flushToolDetailDependencies(tokens)
      throw new Error('expected aggregate')
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([first, second])
    }
    expect(attempted).toEqual([0, 1, 2])
  })
  it.each(['acquire', 'note', 'partial', 'register'] as const)(
    'retains directory debt and visible byte debt after %s failure for drain retry',
    async (failure) => {
      if (process.platform === 'win32') return
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detail-retry-'))
      const synced: number[] = []
      const flusher = new MainDurabilityFlusher({
        now: () => 0,
        setTimer: () => 0,
        clearTimer: () => {},
        fsync: (fd, done) => ({
          joinSync: () => {
            fs.fsyncSync(fd)
            synced.push(fd)
            done()
          }
        }),
        fsyncSync: (fd) => {
          fs.fsyncSync(fd)
          synced.push(fd)
        },
        close: fs.closeSync
      })
      const registry = new MainDurabilityDirectoryLeases(flusher)
      let fault = true
      const owner = new ToolActivityDetailDurability({
        flusher,
        directoryLeases: {
          acquire: (directory) => {
            if (failure === 'acquire' && fault) {
              fault = false
              throw new Error('acquire failed')
            }
            const lease = registry.acquire(directory)
            return {
              ...lease,
              noteMutation: () => {
                if (failure === 'note' && fault) {
                  fault = false
                  throw new Error('note failed')
                }
                return lease.noteMutation()
              }
            }
          }
        }
      })
      const file = path.join(root, 'detail')
      const registration =
        failure === 'register'
          ? vi.spyOn(flusher, 'open').mockImplementationOnce(() => {
              throw new Error('registration failed')
            })
          : undefined
      const originalWrite = fs.writeFileSync
      const write =
        failure === 'partial'
          ? vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((target, data) => {
              originalWrite(target, (data as Buffer).subarray(0, 3))
              throw new Error('partial write failed')
            })
          : undefined
      try {
        expect(() => owner.append(file, Buffer.from('visible'), 0)).toThrow('failed')
        if (failure === 'note' || failure === 'partial') {
          expect(fs.readFileSync(file, 'utf8')).toBe(failure === 'partial' ? 'vis' : 'visible')
          expect(flusher.snapshot().dirtyFiles).toBeGreaterThan(0)
        } else owner.append(file, Buffer.from('visible'), 0)
        owner.drainSync()
        expect(synced.length).toBeGreaterThanOrEqual(2)
        await owner.retire()
        await registry.retire()
      } finally {
        registration?.mockRestore()
        write?.mockRestore()
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )
  it('remembers cold ancestor debt when first sync fails even though mkdir already succeeded', async () => {
    if (process.platform === 'win32') return
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detail-ancestor-'))
    const events: string[] = []
    let refuse = true
    const flusher = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (fd, done) => ({
        joinSync: () => {
          events.push('join')
          fs.fsyncSync(fd)
          done()
        }
      }),
      fsyncSync: (fd) => {
        events.push('sync')
        if (refuse) {
          refuse = false
          throw new Error('ancestor failed')
        }
        fs.fsyncSync(fd)
      },
      close: fs.closeSync
    })
    const registry = new MainDurabilityDirectoryLeases(flusher)
    const owner = new ToolActivityDetailDurability({ flusher, directoryLeases: registry })
    const file = path.join(root, 'new', 'nested', 'detail')
    const unrelatedPath = path.join(root, 'unrelated')
    fs.writeFileSync(unrelatedPath, 'prompt debt')
    const unrelatedFd = fs.openSync(unrelatedPath, 'r+')
    const unrelatedStat = fs.fstatSync(unrelatedFd)
    const unrelated = flusher.open(unrelatedStat.dev, unrelatedStat.ino, unrelatedFd)
    flusher.noteWrite(unrelated, unrelatedStat.size, 'prompt')
    try {
      expect(() => owner.append(file, Buffer.from('x'), 0)).toThrow('ancestor failed')
      expect(fs.existsSync(path.dirname(file))).toBe(true)
      owner.append(file, Buffer.from('x'), 0)
      expect(events[0]).toBe('join')
      expect(flusher.counters.asyncFsyncs + flusher.counters.syncFsyncs).toBeGreaterThanOrEqual(3)
      owner.drainSync()
      await owner.retire()
      await flusher.forget([unrelated])
      await registry.retire()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it.each(['none', 'batch', 'binding'] as const)(
    'flushes accumulated real batch debt through callback failure (%s)',
    async (callbackFailure) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detail-preparation-'))
      const order: string[] = []
      const flusher = new MainDurabilityFlusher({
        now: () => 0,
        setTimer: () => 0,
        clearTimer: () => {},
        fsync: (fd, done) => ({
          joinSync: () => {
            fs.fsyncSync(fd)
            order.push('sync')
            done()
          }
        }),
        fsyncSync: (fd) => {
          fs.fsyncSync(fd)
          order.push('sync')
        },
        close: (fd) => fs.closeSync(fd)
      })
      const directories = new MainDurabilityDirectoryLeases(flusher)
      const owner = new ToolActivityDetailDurability({ flusher, directoryLeases: directories })
      const chat: ChatRecord = {
        appChatId: 'chat',
        scope: 'global',
        provider: 'codex',
        title: 'details',
        archived: false,
        createdAt: 1,
        updatedAt: 2,
        persistenceRevision: 1,
        runs: [{ runId: 'run', status: 'running', startedAt: '2026-10-02T00:00:00.000Z' }],
        messages: [
          {
            id: 'message',
            role: 'tool',
            content: '',
            timestamp: '2026-10-02T00:00:00.000Z',
            runId: 'run',
            toolActivities: [
              {
                id: 'tool',
                toolName: 'shell',
                displayName: 'Shell',
                category: 'shell',
                status: 'success',
                endedAt: '2026-10-02T00:00:01.000Z',
                rawResultEvent: { output: 'x'.repeat(70_000) }
              }
            ]
          }
        ]
      }
      let sideChannel: readonly import('./ToolActivityDetailDurability').ToolDetailDependency[] = []
      try {
        const result = prepareChatForPersistence({
          chat,
          previous: null,
          authoredTranscriptEligible: false,
          createDetailBatch: () =>
            new ToolActivityDetailBatchWriter(root, {
              owner,
              onDependency: (token) => {
                sideChannel = [token]
                if (callbackFailure === 'batch') throw new Error('batch callback failed')
              }
            }),
          readArchivedDetail: () => null,
          maxTerminalRunsPerPass: 25,
          onDetailDependencies: (tokens) => {
            sideChannel = tokens
            order.push('bind')
            if (callbackFailure === 'binding') throw new Error('binding callback failed')
          },
          persistDetailCheckpoint: (checkpoint) => {
            expect(order).toContain('sync')
            expect(Object.keys(checkpoint).sort()).toEqual([
              'activityCount',
              'byteLength',
              'offset',
              'relativePath',
              'runId',
              'sha256'
            ])
            order.push('receipt')
          }
        })
        expect(result.externalizationFailed).toBe(callbackFailure !== 'none')
        expect(sideChannel).toHaveLength(1)
        expect(order).toContain('sync')
        if (callbackFailure === 'none') {
          expect(order.indexOf('bind')).toBeLessThan(order.indexOf('receipt'))
          expect(order.at(-1)).toBe('receipt')
        } else {
          expect(order).not.toContain('receipt')
          expect(result.chat.messages[0].toolActivities?.[0].rawResultEvent).toBeDefined()
          expect(flusher.snapshot().dirtyFiles).toBe(0)
        }
        expect(JSON.stringify(result)).not.toContain('flushSync')
        const journalPath = path.join(root, 'journal.jsonl')
        fs.writeFileSync(journalPath, 'journal line\n')
        const journalFd = fs.openSync(journalPath, 'r+')
        const journalStat = fs.fstatSync(journalFd)
        const journalFile = flusher.open(journalStat.dev, journalStat.ino, journalFd)
        flusher.noteWrite(journalFile, journalStat.size, 'sync', {
          after: sideChannel.flatMap((token) => [...token.journalDependencies()])
        })
        await Promise.all(sideChannel.map((token) => token.awaitDurable()))
        await flusher.forget([journalFile])
        await owner.retire()
        await directories.retire()
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )
  it('writes readable bytes synchronously and flushes name/file dependencies before strict acknowledgement', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detail-durability-'))
    const events: string[] = []
    const flusher = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (fd, done) => ({
        joinSync: () => {
          fs.fsyncSync(fd)
          events.push('sync')
          done()
        }
      }),
      fsyncSync: (fd) => {
        fs.fsyncSync(fd)
        events.push('sync')
      },
      close: (fd) => {
        fs.closeSync(fd)
        events.push('close')
      }
    })
    const directories = new MainDurabilityDirectoryLeases(flusher)
    const owner = new ToolActivityDetailDurability({ flusher, directoryLeases: directories })
    try {
      const file = path.join(root, 'detail.jsonl')
      const token = owner.append(file, Buffer.from('{"detail":true}\n'), 0)
      expect(fs.readFileSync(file, 'utf8')).toContain('detail')
      expect(events).toEqual([])
      token.flushSync()
      events.push('strict-receipt')
      expect(events.filter((event) => event === 'sync')).toHaveLength(
        process.platform === 'win32' ? 1 : 2
      )
      expect(events.at(-1)).toBe('strict-receipt')
      await token.awaitDurable()
      owner.fence()
      expect(() => owner.append(file, Buffer.from('x'), 16)).toThrow('fenced')
      await owner.retire()
      await directories.retire()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
