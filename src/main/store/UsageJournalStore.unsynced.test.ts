/**
 * The usage log under barrier durability: appends write without a sync and a
 * background round pays them through the port, compaction keeps its order
 * with its syncs off the event loop, and history deletion still syncs itself.
 * The last part runs it over a model of a power loss.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ThreadDurabilityPort,
  ThreadDurabilitySyncOptions,
  ThreadDurabilitySyncOutcome
} from './ThreadDurabilityDebt'
import type { UsageRecord } from './types'
import { UsageJournalStore, type UsageJournalStoreOptions } from './UsageJournalStore'
import { USAGE_ROTATION_RETENTION_MS } from './usageRotation'
import { countSyncs, watchCrashDisk, type SyncCount } from './unsyncedWriteCrashDisk.testutil'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'owner-usage-unsynced-'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  const made = temporary + path.sep + TEMPORARY_PREFIX
  if (
    directory === temporary ||
    !directory.startsWith(made) ||
    directory.length <= made.length ||
    path.dirname(directory) !== temporary
  )
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  fs.rmSync(directory, { recursive: true, force: true })
}

const NOW = Date.parse('2026-10-05T12:00:00.000Z')
const OLD = NOW - USAGE_ROTATION_RETENTION_MS - 60_000

function usageRecord(
  id: string,
  timestamp = NOW,
  overrides: Partial<UsageRecord> = {}
): UsageRecord {
  return {
    id,
    timestamp,
    workspaceId: 'workspace',
    chatId: 'chat',
    runId: `run-${id}`,
    usageKind: 'run',
    model: 'model',
    provider: 'claude',
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    durationMs: 10,
    ...overrides
  } as UsageRecord
}

interface PortCall {
  kind: 'file' | 'directory'
  name: string
  options: ThreadDurabilitySyncOptions | undefined
  settle(outcome?: ThreadDurabilitySyncOutcome): void
}

/** A port that answers each sync only when the test says so. */
function heldPort(root: string): ThreadDurabilityPort & { calls: PortCall[] } {
  const calls: PortCall[] = []
  const ask = (kind: PortCall['kind'], target: string, options?: ThreadDurabilitySyncOptions) =>
    new Promise<ThreadDurabilitySyncOutcome>((resolve) => {
      calls.push({
        kind,
        name: path.relative(root, target) || '.',
        options,
        settle: (outcome = 'synced') => resolve(outcome)
      })
    })
  return {
    calls,
    syncFile: (target, options) => ask('file', target, options),
    syncDirectory: (target, options) => ask('directory', target, options)
  }
}

const named = (calls: PortCall[]): string[] => calls.map((call) => `${call.kind}:${call.name}`)

/** A clock and timers the test moves by hand. */
function manualTime(start = NOW) {
  let now = start
  const timers = new Map<number, { at: number; callback: () => void }>()
  let next = 1
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      const id = next++
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number)
    },
    advance(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
      }
    }
  }
}

/** Lets every step that is ready run: promises, then a turn of the event loop. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

const ids = (records: UsageRecord[]): string[] => records.map((record) => record.id).sort()

// Power-cut reconstruction uses the POSIX model; sync accounting runs everywhere.
const test = it.skipIf(process.platform === 'win32')

describe('the usage log under barrier durability', () => {
  let folders: string[]
  let stores: UsageJournalStore[]
  let syncs: SyncCount | null

  beforeEach(() => {
    folders = []
    stores = []
    syncs = null
  })

  afterEach(() => {
    for (const store of stores) store.dispose()
    syncs?.dispose()
    for (const folder of folders) removeTemporaryDirectory(folder)
  })

  type Paths = Pick<UsageJournalStoreOptions, 'checkpointPath' | 'journalPath' | 'archivePath'>

  /** A folder of its own for the usage log, removed after the test. */
  function folder(): { root: string; paths: Paths } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    folders.push(root)
    return {
      root,
      paths: {
        checkpointPath: path.join(root, 'usage.json'),
        journalPath: path.join(root, 'usage-journal.jsonl'),
        archivePath: path.join(root, 'usage-archive.jsonl')
      }
    }
  }

  function createStore(
    paths: Paths,
    overrides: Partial<UsageJournalStoreOptions> = {}
  ): UsageJournalStore {
    const store = new UsageJournalStore({
      ...paths,
      compactAfterRecords: 1_000,
      compactionDelayMs: 60_000,
      now: () => NOW,
      logger: { error: vi.fn(), warn: vi.fn() },
      ...overrides
    })
    stores.push(store)
    return store
  }

  describe('appends', () => {
    it('make no sync on the calling thread, and a round pays them at the background class, at most once a second', async () => {
      const { root, paths } = folder()
      const port = heldPort(root)
      const time = manualTime()
      const store = createStore(paths, { unsynced: { port, rounds: time } })
      syncs = countSyncs()

      for (let index = 1; index <= 5; index += 1) store.append(usageRecord(`r${index}`))

      // The round starts once the appends are done, and pays all of them.
      expect(syncs.issued).toEqual([])
      expect(port.calls).toHaveLength(0)
      await settle()
      expect(named(port.calls)).toEqual(['file:usage-journal.jsonl'])
      port.calls[0].settle()
      await settle()
      // Files first, then the folder the journal was made in.
      expect(named(port.calls)).toEqual(['file:usage-journal.jsonl', 'directory:.'])
      port.calls[1].settle()
      await settle()
      expect(port.calls).toHaveLength(2)

      // An append within the second waits for its end.
      store.append(usageRecord('r6'))
      await settle()
      time.advance(999)
      await settle()
      expect(port.calls).toHaveLength(2)
      time.advance(1)
      await settle()
      expect(named(port.calls)).toEqual([
        'file:usage-journal.jsonl',
        'directory:.',
        'file:usage-journal.jsonl'
      ])
      expect(port.calls.every((call) => call.options?.background === true)).toBe(true)
      expect(syncs.issued).toEqual([])
      expect(ids(store.getRecords())).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'])
      expect(store.unsyncedSnapshot()).toMatchObject({
        appends: 6,
        spills: 0,
        background: { rounds: 2, syncs: { files: 2, directories: 1 } }
      })
    })

    it('spill without a sync while the journal is locked, and owe the spill and its folder', async () => {
      const { root, paths } = folder()
      const port = heldPort(root)
      const store = createStore(paths, { unsynced: { port, rounds: manualTime() } })
      // Another instance's lock, taken just now by the store's clock.
      const lockPath = `${paths.journalPath}.lock`
      fs.writeFileSync(lockPath, JSON.stringify({ token: 'other', pid: 1 }))
      fs.utimesSync(lockPath, new Date(NOW), new Date(NOW))
      syncs = countSyncs()

      store.append(usageRecord('r1'))

      expect(syncs.issued).toEqual([])
      const spill = fs.readdirSync(root).find((name) => name.includes('.spill-'))
      expect(spill).toBeDefined()
      await settle()
      expect(named(port.calls)).toEqual([`file:${spill}`])
      port.calls[0].settle()
      await settle()
      expect(named(port.calls)).toEqual([`file:${spill}`, 'directory:.'])
      expect(ids(store.getRecords())).toEqual(['r1'])
      expect(store.unsyncedSnapshot()).toMatchObject({ appends: 1, spills: 1 })
    })

    it('remove a lock a crash left, and owe its folder rather than sync it', async () => {
      const { root, paths } = folder()
      const port = heldPort(root)
      const store = createStore(paths, { unsynced: { port, rounds: manualTime() } })
      const lockPath = `${paths.journalPath}.lock`
      fs.writeFileSync(lockPath, JSON.stringify({ token: 'dead', pid: 1 }))
      const stale = new Date(NOW - 11 * 60 * 1000)
      fs.utimesSync(lockPath, stale, stale)
      syncs = countSyncs()

      store.append(usageRecord('r1'))

      expect(syncs.issued).toEqual([])
      expect(fs.readdirSync(root).filter((name) => name.includes('.spill-'))).toEqual([])
      expect(ids(store.getRecords())).toEqual(['r1'])
      await settle()
      // The lock's removal, the journal and its folder, in one round.
      expect(named(port.calls)).toEqual(['file:usage-journal.jsonl'])
      port.calls[0].settle()
      await settle()
      expect(named(port.calls)).toEqual(['file:usage-journal.jsonl', 'directory:.'])
    })

    it('at quit, pay what is owed within the budget, and sync every append where it is made after it', async () => {
      const { root, paths } = folder()
      const port = heldPort(root)
      const store = createStore(paths, { unsynced: { port, rounds: manualTime() } })
      store.append(usageRecord('r1'))
      await settle()
      store.append(usageRecord('r2'))
      expect(port.calls).toHaveLength(1)

      const quitting = store.settleAtQuit(500)
      port.calls[0].settle()
      await settle()
      port.calls[1].settle()
      await settle()
      // Quit's round pays the second append at the normal class.
      expect(named(port.calls)).toEqual([
        'file:usage-journal.jsonl',
        'directory:.',
        'file:usage-journal.jsonl'
      ])
      expect(port.calls[2].options?.background).toBeUndefined()
      port.calls[2].settle()
      await settle()
      expect(named(port.calls).at(-1)).toBe('directory:.')
      port.calls[3].settle()
      await quitting
      expect(store.unsyncedSnapshot()?.background).toMatchObject({ quitRounds: 1, quitUnpaid: 0 })

      syncs = countSyncs()
      store.append(usageRecord('r3'))
      expect(syncs.issued).toEqual(['fsyncSync', 'fsyncSync'])
      expect(port.calls).toHaveLength(4)
    })

    it('at quit, count the log unpaid when the disk does not answer within the budget', async () => {
      const { root, paths } = folder()
      const port = heldPort(root)
      const time = manualTime()
      const store = createStore(paths, { unsynced: { port, rounds: time } })
      store.append(usageRecord('r1'))

      const quitting = store.settleAtQuit(500)
      time.advance(500)
      await quitting

      expect(store.unsyncedSnapshot()?.background).toMatchObject({ quitUnpaid: 1 })
    })
  })

  describe('compaction', () => {
    it('keeps its order with every sync off the calling thread, and renames or removes nothing before its bytes are synced', async () => {
      const { root, paths } = folder()
      const port = heldPort(root)
      const store = createStore(paths, { unsynced: { port, rounds: manualTime() } })
      fs.writeFileSync(paths.checkpointPath, JSON.stringify([usageRecord('old', OLD)]))
      store.append(usageRecord('r1'))
      await settle()
      port.calls[0].settle()
      await settle()
      port.calls[1].settle()
      await settle()
      const before = port.calls.length
      syncs = countSyncs()

      // The compaction that syncs where it writes is refused in this mode.
      expect(() => store.compact(NOW)).toThrow(/off the event loop/)
      const compacting = store.compactInBackground(NOW)
      const next = async (expected: RegExp): Promise<PortCall> => {
        await settle()
        const call = port.calls[port.calls.length - 1]
        expect(`${call.kind}:${call.name}`).toMatch(expected)
        return call
      }
      const checkpointed = (): string[] =>
        ids(JSON.parse(fs.readFileSync(paths.checkpointPath, 'utf8')))
      const claimed = (): boolean => fs.readdirSync(root).some((name) => name.includes('.claimed-'))
      // The live journal's bytes are synced before a rename claims it.
      let call = await next(/^file:usage-journal\.jsonl$/)
      expect(fs.existsSync(paths.journalPath)).toBe(true)
      call.settle()
      ;(await next(/^file:usage-archive\.jsonl$/)).settle()
      ;(await next(/^directory:\.$/)).settle()
      // The new checkpoint is synced before it replaces the old one.
      call = await next(/^file:usage\.json\.\d+\.[0-9a-f-]+\.tmp$/)
      expect(checkpointed()).toEqual(['old'])
      call.settle()
      // Its name is made durable before the inputs are removed.
      call = await next(/^directory:\.$/)
      expect(checkpointed()).toEqual(['r1'])
      expect(claimed()).toBe(true)
      call.settle()
      call = await next(/^directory:\.$/)
      expect(claimed()).toBe(false)
      call.settle()
      await expect(compacting).resolves.toBe(true)

      expect(port.calls.length - before).toBe(6)
      expect(syncs.issued).toEqual([])
      expect(fs.readdirSync(root).sort()).toEqual(['usage-archive.jsonl', 'usage.json'])
      expect(store.unsyncedSnapshot()?.compactions).toEqual({
        started: 1,
        completed: 1,
        stopped: 0,
        failed: 0
      })
    })

    it('runs off the event loop when its thresholds schedule it', async () => {
      const { root, paths } = folder()
      const port = heldPort(root)
      const store = createStore(paths, {
        unsynced: { port, rounds: manualTime() },
        compactAfterRecords: 2,
        compactionDelayMs: 0
      })
      syncs = countSyncs()

      store.append(usageRecord('r1'))
      store.append(usageRecord('r2'))
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(store.unsyncedSnapshot()?.compactions.started).toBe(1)
      // The background round's journal sync, then the compaction's sync of its input.
      expect(named(port.calls)).toEqual(['file:usage-journal.jsonl', 'file:usage-journal.jsonl'])
      expect(syncs.issued).toEqual([])
      for (const call of port.calls) call.settle()
    })

    it('compacts next what an append spilled while it held the lock', async () => {
      const { root, paths } = folder()
      const port = heldPort(root)
      const store = createStore(paths, {
        unsynced: { port, rounds: manualTime() },
        compactionDelayMs: 0
      })
      store.append(usageRecord('r1'))
      await settle()
      for (const call of port.calls) call.settle()
      await settle()

      const compacting = store.compactInBackground(NOW)
      store.append(usageRecord('r2'))
      expect(store.unsyncedSnapshot()?.spills).toBe(1)
      let answered = 0
      while (store.unsyncedSnapshot()!.compactions.completed < 2 && answered < 40) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        for (const call of port.calls.slice(answered)) call.settle()
        answered = port.calls.length
      }
      await expect(compacting).resolves.toBe(true)

      expect(store.unsyncedSnapshot()?.compactions).toMatchObject({ started: 2, completed: 2 })
      expect(fs.readdirSync(root).filter((name) => name.includes('.spill-'))).toEqual([])
      expect(ids(JSON.parse(fs.readFileSync(paths.checkpointPath, 'utf8')))).toEqual(['r1', 'r2'])
    })

    it('is stopped by a history purge in this process, which takes the journal lock over and syncs itself', async () => {
      const { root, paths } = folder()
      const port = heldPort(root)
      const store = createStore(paths, { unsynced: { port, rounds: manualTime() } })
      store.append(usageRecord('mine', NOW, { chatId: 'erased', runId: 'run-erased' }))
      store.append(usageRecord('sibling'))
      await settle()
      for (const call of port.calls) call.settle()
      await settle()

      const compacting = store.compactInBackground(NOW)
      await settle()
      // Held at the sync of its inputs, with the journal lock taken.
      expect(named(port.calls).at(-1)).toBe('file:usage-journal.jsonl')
      expect(fs.existsSync(`${paths.journalPath}.lock`)).toBe(true)
      syncs = countSyncs()
      const hold = store.beginHistoryMutation({
        operationId: 'erase-chat',
        kind: 'chat',
        chatIds: ['erased'],
        runIds: []
      })
      const report = store.purgeHistoryStrict(hold)
      expect(report.removedRecords).toBe(1)
      expect(syncs.issued.length).toBeGreaterThan(0)
      expect(store.endHistoryMutation(hold)).toBe(true)

      for (const call of port.calls) call.settle()
      await expect(compacting).resolves.toBe(false)
      expect(ids(store.getRecords())).toEqual(['sibling'])
      expect(store.unsyncedSnapshot()?.compactions).toMatchObject({ started: 1, stopped: 1 })
      expect(fs.existsSync(`${paths.journalPath}.lock`)).toBe(false)
    })
  })

  describe('over a power loss', () => {
    test('loses only the records appended after the last round, and a torn last line reads as the records before it', async () => {
      const { root, paths } = folder()
      const time = manualTime()
      let disk: ReturnType<typeof watchCrashDisk> | null = null
      const port: ThreadDurabilityPort = {
        syncFile: (target, options) => disk!.port.syncFile(target, options),
        syncDirectory: (target, options) => disk!.port.syncDirectory(target, options)
      }
      const store = createStore(paths, { unsynced: { port, rounds: time } })
      disk = watchCrashDisk(root)
      try {
        store.append(usageRecord('r1'))
        await settle()
        store.append(usageRecord('r2'))
        store.append(usageRecord('r3'))
        time.advance(1_000)
        await settle()
        store.append(usageRecord('r4'))
        store.append(usageRecord('r5'))

        expect(disk.issued).toEqual([])
        disk.powerLoss()
      } finally {
        disk.dispose()
      }
      store.dispose()
      expect(ids(createStore(paths).getRecords())).toEqual(['r1', 'r2', 'r3'])

      // The disk wrote part of the next append by itself.
      fs.appendFileSync(paths.journalPath, `\n${JSON.stringify(usageRecord('r4')).slice(0, 25)}`)
      expect(ids(createStore(paths).getRecords())).toEqual(['r1', 'r2', 'r3'])
    })

    /**
     * Inputs of every kind, all on the disk before the compaction: an old
     * record the checkpoint holds, which goes to the archive, the live journal
     * with a malformed line, which is quarantined, and a spill.
     */
    function prepared(paths: Paths): string[] {
      fs.writeFileSync(paths.checkpointPath, JSON.stringify([usageRecord('old', OLD)]))
      fs.writeFileSync(
        paths.journalPath,
        `\n${JSON.stringify(usageRecord('j1'))}\n{"torn":\n${JSON.stringify(usageRecord('j2'))}`
      )
      fs.writeFileSync(
        `${paths.journalPath}.spill-1-00000000-0000-4000-8000-000000000000`,
        `${JSON.stringify(usageRecord('s1'))}\n`
      )
      return ['j1', 'j2', 'old', 's1']
    }

    function archived(paths: Paths): string[] {
      if (!fs.existsSync(paths.archivePath)) return []
      return fs
        .readFileSync(paths.archivePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => (JSON.parse(line) as UsageRecord).id)
    }

    /**
     * A compaction whose port answers its first `answered` syncs and none
     * after: the process stops there, and then the power fails.
     */
    async function compactionCutAt(answered: number): Promise<{ paths: Paths; all: string[] }> {
      const { root, paths } = folder()
      const all = prepared(paths)
      let disk: ReturnType<typeof watchCrashDisk> | null = null
      let calls = 0
      const port: ThreadDurabilityPort = {
        syncFile: (target, options) =>
          ++calls > answered ? new Promise(() => {}) : disk!.port.syncFile(target, options),
        syncDirectory: (target, options) =>
          ++calls > answered ? new Promise(() => {}) : disk!.port.syncDirectory(target, options)
      }
      const store = createStore(paths, { unsynced: { port, rounds: manualTime() } })
      disk = watchCrashDisk(root)
      try {
        void store.compactInBackground(NOW)
        await settle()
        expect(disk.issued, `cut at ${answered}`).toEqual([])
        disk.powerLoss()
      } finally {
        disk.dispose()
      }
      store.dispose()
      return { paths, all }
    }

    test('loses no record when the power fails at any step of a compaction', async () => {
      // A whole compaction of these inputs: the sync of each input, the
      // quarantined copy and its name, the archive and its name, the new
      // checkpoint and its name, the inputs' removal.
      const whole = 9
      for (let answered = 0; answered <= whole; answered += 1) {
        const { paths, all } = await compactionCutAt(answered)

        // The next process starts after the lock the cut compaction left has
        // gone stale, as it would after a power cut.
        const reader = createStore(paths, { now: () => Date.now() + 11 * 60 * 1000 })
        const visible = ids(reader.getRecords())
        expect([...new Set([...visible, ...archived(paths)])].sort(), `cut at ${answered}`).toEqual(
          all
        )
        // What it left, the next compaction finishes without losing anything.
        expect(reader.compact(NOW), `cut at ${answered}`).toBe(true)
        expect(ids(reader.getRecords()), `cut at ${answered}`).toEqual(['j1', 'j2', 's1'])
        expect(archived(paths), `cut at ${answered}`).toEqual(['old'])
      }
    })

    it('a whole compaction of those inputs asks for those nine syncs in order, through the port alone', async () => {
      const { root, paths } = folder()
      prepared(paths)
      const port = heldPort(root)
      const store = createStore(paths, { unsynced: { port, rounds: manualTime() } })
      syncs = countSyncs()
      let done = false
      const compacting = store.compactInBackground(NOW).finally(() => {
        done = true
      })
      let answered = 0
      while (!done && answered < 20) {
        await settle()
        for (const call of port.calls.slice(answered)) call.settle()
        answered = port.calls.length
      }
      await expect(compacting).resolves.toBe(true)
      await settle()

      const steps = named(port.calls)
      expect(steps.slice(0, 9)).toEqual([
        'file:usage-journal.jsonl',
        'file:usage-journal.jsonl.spill-1-00000000-0000-4000-8000-000000000000',
        expect.stringMatching(
          /^file:usage-journal\.jsonl\.quarantine-[0-9a-f]{64}\.jsonl\.\d+\.[0-9a-f-]+\.tmp$/
        ),
        'directory:.',
        'file:usage-archive.jsonl',
        'directory:.',
        expect.stringMatching(/^file:usage\.json\.\d+\.[0-9a-f-]+\.tmp$/),
        'directory:.',
        'directory:.'
      ])
      // Then the background round for the folder the journal lock left changed.
      expect(steps.slice(9)).toEqual(['directory:.'])
      expect(port.calls.slice(0, 9).every((call) => call.options?.background === true)).toBe(true)
      expect(syncs.issued).toEqual([])
      expect(store.unsyncedSnapshot()?.compactions).toMatchObject({ started: 1, completed: 1 })
    })
  })
})
