import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createMainDurabilityRuntime } from './MainDurabilityRuntime'
import { IncrementalChatJournalDescriptorCache } from './IncrementalChatJournalDescriptorCache'

it('shares one pool across cold ledger/journal creation, barriers, retirement, recreation and shutdown', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-pooled-consumers-'))
  const profile = path.join(root, 'profile')
  fs.mkdirSync(profile)
  const entry = path.join(root, 'worker.js')
  fs.writeFileSync(entry, '')
  const pending: (() => void)[] = []
  let active = 0
  let peak = 0
  let joins = 0
  let disposed = false
  let journal!: IncrementalChatJournalDescriptorCache
  let fenced = false
  const runtime = createMainDurabilityRuntime({
    runEventsDir: path.join(profile, 'run-events'),
    runArtifactsDir: path.join(profile, 'artifacts'),
    workerEntryPath: entry,
    env: { TASKWRAITH_RUN_EVENT_FLUSHER: '1', TASKWRAITH_JOURNAL_FLUSHER: '1' },
    createAdapter: () => ({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (fd, done) => {
        active++
        peak = Math.max(peak, active)
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          fs.fsyncSync(fd)
          active--
          done()
        }
        pending.push(finish)
        return {
          joinSync: () => {
            joins++
            finish()
          }
        }
      },
      fsyncSync: (fd) => {
        expect(active).toBe(0)
        fs.fsyncSync(fd)
      },
      close: (fd) => fs.closeSync(fd),
      dispose: async () => {
        expect(active).toBe(0)
        disposed = true
      }
    })
  })
  const flush = () => {
    while (pending.length) pending.shift()!()
  }
  const event = (runId: string) => ({
    runId,
    kind: 'tool' as const,
    phase: 'artifact' as const,
    source: 'main' as const
  })
  const journalPath = (id: string) => path.join(profile, 'journals', `${id}.jsonl`)
  try {
    expect(
      runtime.attachJournal((ports) => {
        journal = new IncrementalChatJournalDescriptorCache(ports.flusher, {
          directoryLeases:
            ports.directoryLeases as import('./MainDurabilityDirectoryLeases').MainDurabilityDirectoryLeases
        })
        return {
          fence: () => {
            fenced = true
          },
          drainSync: () => ports.flusher.drainSync(),
          retire: () => journal.retire()
        }
      })
    ).toBe(true)
    runtime.writer.append(event('a'))
    journal.append('a', journalPath('a'), '{"revision":1}\n', 'deferred')
    expect(fs.readFileSync(journalPath('a'), 'utf8')).toContain('revision')
    const ledgerBarrier = runtime.writer.awaitDurable('a')
    const journalBarrier = journal.awaitDurable('a')
    flush()
    await Promise.all([ledgerBarrier, journalBarrier])
    journal.append('a', journalPath('a'), '{"revision":2}\n', 'deferred')
    const inflight = journal.awaitDurable('a')
    runtime.writer.append(event('a'), { durability: 'strict' })
    expect(joins).toBeGreaterThan(0)
    await inflight
    const retired = runtime.writer.retire(['a'])
    journal.append('b', journalPath('b'), '{"revision":1}\n', 'immediate')
    await retired
    await Promise.all([runtime.writer.retire(), journal.retire()])
    fs.rmSync(path.join(profile, 'run-events'), { recursive: true })
    fs.rmSync(path.join(profile, 'journals'), { recursive: true })
    const recreated = runtime.writer.append(event('new'), { durability: 'strict' })
    expect(recreated.sequence).toBe(1)
    journal.append('new', journalPath('new'), '{"revision":1}\n', 'deferred')
    await runtime.shutdown()
    expect(fenced).toBe(true)
    expect(disposed).toBe(true)
    expect(runtime.snapshot().closed).toBe(true)
    expect(peak).toBe(1)
    expect(() => runtime.writer.append(event('after'))).toThrow('shutting down')
  } finally {
    flush()
    await runtime.shutdown()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
