/**
 * The run queue's file under barrier durability: changes go to the list in
 * memory at once, and coalesced whole-file writes follow them off the event
 * loop. The last part runs a write over a model of a power loss.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunQueueFile, type RunQueueFileOptions } from './RunQueueFile'
import type {
  ThreadDurabilityPort,
  ThreadDurabilitySyncOptions,
  ThreadDurabilitySyncOutcome
} from './ThreadDurabilityDebt'
import type { RunQueueJob } from './types'
import { countSyncs, watchCrashDisk, type SyncCount } from './unsyncedWriteCrashDisk.testutil'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'owner-run-queue-file-'

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

function job(runId: string, status: RunQueueJob['status'] = 'queued'): RunQueueJob {
  return {
    id: runId,
    runId,
    provider: 'codex',
    workspacePath: '/workspace',
    source: 'manual',
    status,
    priority: 0,
    attempt: 1,
    createdAt: '2026-10-05T12:00:00.000Z',
    updatedAt: '2026-10-05T12:00:00.000Z'
  } as RunQueueJob
}

interface Call {
  name: string
  options: ThreadDurabilitySyncOptions | undefined
  settle(): void
  fail(): void
}

function heldPort(root: string): ThreadDurabilityPort & { calls: Call[] } {
  const calls: Call[] = []
  const ask = (kind: string, target: string, options?: ThreadDurabilitySyncOptions) =>
    new Promise<ThreadDurabilitySyncOutcome>((resolve, reject) => {
      const relative = path.relative(root, target) || '.'
      calls.push({
        name: `${kind}:${relative.replace(/\.\d+\.[0-9a-f-]+\.tmp$/, '.TEMP')}`,
        options,
        settle: () => resolve('synced'),
        fail: () => reject(Object.assign(new Error('EIO'), { code: 'EIO' }))
      })
    })
  return {
    calls,
    syncFile: (target, options) => ask('file', target, options),
    syncDirectory: (target, options) => ask('directory', target, options)
  }
}

function manualTimers() {
  const timers = new Map<number, () => void>()
  let next = 1
  return {
    setTimer: (callback: () => void) => {
      const id = next++
      timers.set(id, callback)
      return id
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number)
    },
    fireAll() {
      const due = [...timers.values()]
      timers.clear()
      for (const callback of due) callback()
    }
  }
}

/**
 * Lets every step that is ready run: promises, and the file calls on the
 * thread pool, which a turn of the loop alone does not wait for.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2))
}

/** Answers every sync the port is asked for, as it comes, until `done` says so. */
async function answerAll(port: { calls: Call[] }, done: () => boolean): Promise<void> {
  let answered = 0
  for (let turn = 0; turn < 50 && !done(); turn += 1) {
    await settle()
    for (const call of port.calls.slice(answered)) call.settle()
    answered = port.calls.length
  }
}

describe('the run queue file under barrier durability', () => {
  let folders: string[]
  let syncs: SyncCount | null

  beforeEach(() => {
    folders = []
    syncs = null
  })

  afterEach(() => {
    syncs?.dispose()
    for (const folder of folders) removeTemporaryDirectory(folder)
  })

  function setUp(overrides: Partial<RunQueueFileOptions> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    folders.push(root)
    const filePath = path.join(root, 'run-queue.json')
    const inline: RunQueueJob[][] = []
    const options: RunQueueFileOptions = {
      filePath,
      port: heldPort(root),
      read: () =>
        fs.existsSync(filePath)
          ? (JSON.parse(fs.readFileSync(filePath, 'utf8')) as RunQueueJob[])
          : [],
      writeSync: (jobs) => {
        inline.push(jobs)
        fs.writeFileSync(filePath, JSON.stringify(jobs, null, 2))
      },
      warn: () => {},
      ...overrides
    }
    const file = new RunQueueFile(options)
    const onDisk = (): RunQueueJob[] => JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const names = (): string[] => fs.readdirSync(root).sort()
    return { root, filePath, file, options, inline, onDisk, names }
  }

  it('takes a change at once with no sync on the calling thread, and writes it after: temp, its sync, the rename, the folder', async () => {
    const { file, options, onDisk, names, filePath } = setUp()
    const port = options.port as ReturnType<typeof heldPort>
    fs.writeFileSync(filePath, JSON.stringify([job('old')], null, 2))
    syncs = countSyncs()

    const version = file.replace([job('new')])

    expect(file.read().map((entry) => entry.runId)).toEqual(['new'])
    expect(syncs.issued).toEqual([])
    let written = false
    void file.awaitWritten(version).then(() => {
      written = true
    })
    await settle()
    expect(port.calls.map((call) => call.name)).toEqual(['file:run-queue.json.TEMP'])
    expect(port.calls[0].options).toBeUndefined()
    // Synced before it takes the file's name.
    expect(onDisk().map((entry) => entry.runId)).toEqual(['old'])
    port.calls[0].settle()
    await settle()
    expect(onDisk().map((entry) => entry.runId)).toEqual(['new'])
    expect(port.calls.map((call) => call.name)).toEqual(['file:run-queue.json.TEMP', 'directory:.'])
    expect(written).toBe(false)
    port.calls[1].settle()
    await settle()
    expect(written).toBe(true)

    expect(syncs.issued).toEqual([])
    expect(names()).toEqual(['run-queue.json'])
    // As the store writes it without barrier durability.
    expect(fs.readFileSync(filePath, 'utf8')).toBe(JSON.stringify([job('new')], null, 2))
    expect(file.snapshot()).toMatchObject({
      changes: 1,
      writes: 1,
      coalesced: 0,
      syncs: { files: 1, directories: 1 },
      writing: false,
      unwrittenChanges: 0
    })
  })

  it('takes a burst of a thousand transitions in at most a handful of writes, the last holding the latest list', async () => {
    const { file, options, onDisk } = setUp()
    const port = options.port as ReturnType<typeof heldPort>

    let last = 0
    for (let index = 0; index < 1_000; index += 1) {
      last = file.replace([job('run', index % 2 === 0 ? 'starting' : 'active'), job(`r${index}`)])
    }
    let written = false
    void file.awaitWritten(last).then(() => {
      written = true
    })
    await answerAll(port, () => written)

    expect(written).toBe(true)
    expect(file.snapshot().writes).toBeLessThanOrEqual(3)
    expect(file.snapshot().changes).toBe(1_000)
    expect(file.snapshot().coalesced).toBe(1_000 - file.snapshot().writes)
    expect(onDisk().map((entry) => entry.runId)).toEqual(['run', 'r999'])
  })

  it('asks the port for urgent syncs while a person waits on a change', async () => {
    const { file, options } = setUp()
    const port = options.port as ReturnType<typeof heldPort>

    const version = file.replace([job('queued-by-a-person')])
    void file.awaitWritten(version, { urgent: true })
    await settle()
    port.calls[0].settle()
    await settle()

    expect(port.calls.map((call) => call.options)).toEqual([{ urgent: true }, { urgent: true }])
  })

  it('renames nothing over a file written on the calling thread while it ran, and leaves no temp', async () => {
    const { file, options, inline, onDisk, names } = setUp()
    const port = options.port as ReturnType<typeof heldPort>

    file.replace([job('a')])
    await settle()
    expect(port.calls).toHaveLength(1)
    file.replace([job('b')])
    file.writeNowSync()
    expect(inline.map((jobs) => jobs.map((entry) => entry.runId))).toEqual([['b']])
    port.calls[0].settle()
    await settle()

    expect(onDisk().map((entry) => entry.runId)).toEqual(['b'])
    expect(names()).toEqual(['run-queue.json'])
    expect(file.snapshot()).toMatchObject({ superseded: 1, inlineWrites: 1, unwrittenChanges: 0 })
    // Nothing newer to write: no write starts after it.
    await settle()
    expect(port.calls).toHaveLength(1)
  })

  it('renames nothing when the file is written on the calling thread before its temp exists', async () => {
    const { file, options, inline, onDisk, names } = setUp()
    const port = options.port as ReturnType<typeof heldPort>

    file.replace([job('a')])
    // The write has started: it waits on the folder, and has no temp yet.
    await Promise.resolve()
    await Promise.resolve()
    file.replace([job('b')])
    file.writeNowSync()
    expect(inline.map((jobs) => jobs.map((entry) => entry.runId))).toEqual([['b']])
    await settle()
    // It went on to write and sync its temp, holding the older list.
    expect(port.calls.map((call) => call.name)).toEqual(['file:run-queue.json.TEMP'])
    port.calls[0].settle()
    await settle()

    expect(onDisk().map((entry) => entry.runId)).toEqual(['b'])
    expect(names()).toEqual(['run-queue.json'])
    expect(file.snapshot()).toMatchObject({ superseded: 1, writes: 0, unwrittenChanges: 0 })
  })

  it('takes back the list a rewrite on the calling thread left', async () => {
    const { file, filePath } = setUp()
    file.replace([job('a'), job('b')])
    file.writeNowSync()
    fs.writeFileSync(filePath, JSON.stringify([job('b')]))

    file.reload()

    expect(file.read().map((entry) => entry.runId)).toEqual(['b'])
    expect(file.writtenVersion).toBe(file.version)
  })

  it('tries a failed write again after a backoff, with the list as it is then', async () => {
    const timers = manualTimers()
    const { file, options, onDisk, names } = setUp(timers)
    const port = options.port as ReturnType<typeof heldPort>

    const first = file.replace([job('a')])
    await settle()
    port.calls[0].fail()
    await settle()
    expect(file.snapshot()).toMatchObject({ failed: 1, writes: 0 })
    expect(names()).toEqual([])
    const second = file.replace([job('a'), job('b')])
    await settle()
    expect(port.calls).toHaveLength(1)

    timers.fireAll()
    let written = false
    void file.awaitWritten(second).then(() => {
      written = true
    })
    await answerAll(port, () => written)

    expect(second).toBeGreaterThan(first)
    expect(onDisk().map((entry) => entry.runId)).toEqual(['a', 'b'])
    expect(file.snapshot()).toMatchObject({ failed: 1, writes: 1 })
  })

  it('at quit, waits within the budget for the latest list, and writes every later change on the calling thread', async () => {
    const { file, options, inline } = setUp()
    const port = options.port as ReturnType<typeof heldPort>

    file.replace([job('a')])
    const quitting = file.close(1_000)
    await answerAll(port, () => file.writtenVersion === file.version)
    await expect(quitting).resolves.toEqual({ unwritten: false })

    file.replace([job('a'), job('b')])
    expect(inline.map((jobs) => jobs.map((entry) => entry.runId))).toEqual([['a', 'b']])
    expect(file.writtenVersion).toBe(file.version)
  })

  it('at quit, counts the latest list unwritten when the disk does not answer within the budget', async () => {
    const timers = manualTimers()
    const { file } = setUp(timers)

    file.replace([job('a')])
    const quitting = file.close(500)
    await settle()
    timers.fireAll()

    await expect(quitting).resolves.toEqual({ unwritten: true })
    expect(file.snapshot().quitUnwritten).toBe(1)
  })

  it('hands out copies and keeps copies of what it is given', () => {
    const { file } = setUp()
    const given = job('a')
    file.replace([given])
    given.status = 'failed'

    const kept = file.read()[0]
    expect(kept.status).toBe('queued')
    const copied = file.copyOf(kept)
    copied.status = 'cancelled'
    expect(file.read()[0].status).toBe('queued')
    expect(file.copies(file.read())[0]).not.toBe(file.read()[0])
  })

  it('puts the changes made in one turn in one write', async () => {
    const { file, options, onDisk } = setUp()
    const port = options.port as ReturnType<typeof heldPort>

    file.replace([job('a')])
    file.replace([job('a'), job('b')])
    file.replace([job('b')])
    await settle()
    expect(port.calls.map((call) => call.name)).toEqual(['file:run-queue.json.TEMP'])
    await answerAll(port, () => file.writtenVersion === file.version)

    expect(onDisk().map((entry) => entry.runId)).toEqual(['b'])
    expect(file.snapshot()).toMatchObject({ changes: 3, writes: 1, coalesced: 2 })
  })

  it('starts no write for changes a write on the calling thread holds already', async () => {
    const { file, options } = setUp()
    const port = options.port as ReturnType<typeof heldPort>

    file.replace([job('a')])
    file.writeNowSync()
    await settle()

    expect(port.calls).toHaveLength(0)
    expect(file.snapshot()).toMatchObject({ writes: 0, inlineWrites: 1, unwrittenChanges: 0 })
  })

  it('counts a write superseded while it ran as superseded when its sync then fails, and tries nothing again', async () => {
    const timers = manualTimers()
    const warnings: string[] = []
    const { file, options, names } = setUp({
      ...timers,
      warn: (message) => warnings.push(message)
    })
    const port = options.port as ReturnType<typeof heldPort>

    file.replace([job('a')])
    await settle()
    file.replace([job('b')])
    file.writeNowSync()
    port.calls[0].fail()
    await settle()
    timers.fireAll()
    await settle()

    expect(file.snapshot()).toMatchObject({ superseded: 1, failed: 0, unwrittenChanges: 0 })
    expect(warnings).toEqual([])
    expect(port.calls).toHaveLength(1)
    expect(names()).toEqual(['run-queue.json'])
  })

  it('once disposed, renames nothing from a write that was running, starts none, and writes a later change on the calling thread', async () => {
    const { file, options, inline, names } = setUp()
    const port = options.port as ReturnType<typeof heldPort>

    file.replace([job('a')])
    await settle()
    file.dispose()
    port.calls[0].settle()
    await settle()

    expect(names()).toEqual([])
    expect(port.calls).toHaveLength(1)
    file.replace([job('b')])
    expect(inline.map((jobs) => jobs.map((entry) => entry.runId))).toEqual([['b']])
    await settle()
    expect(port.calls).toHaveLength(1)
  })

  describe.skipIf(process.platform === 'win32')('over a POSIX power loss', () => {
    async function writeCutAt(answered: number) {
      const { root, filePath, options } = setUp()
      fs.writeFileSync(filePath, JSON.stringify([job('old')], null, 2))
      let disk: ReturnType<typeof watchCrashDisk> | null = null
      let calls = 0
      const port: ThreadDurabilityPort = {
        syncFile: (target, sync) =>
          ++calls > answered ? new Promise(() => {}) : disk!.port.syncFile(target, sync),
        syncDirectory: (target, sync) =>
          ++calls > answered ? new Promise(() => {}) : disk!.port.syncDirectory(target, sync)
      }
      const file = new RunQueueFile({ ...options, port })
      disk = watchCrashDisk(root)
      try {
        file.replace([job('new', 'active')])
        // Below zero: the power fails in the turn of the change, before the write starts.
        if (answered >= 0) await settle()
        expect(disk.issued, `cut at ${answered}`).toEqual([])
        disk.powerLoss()
      } finally {
        disk.dispose()
      }
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RunQueueJob[]
    }

    it('leaves the old list or the new, whole, wherever the power fails in a write', async () => {
      // Answered: before the write starts, none (the temp written, not synced),
      // its sync (renamed, the folder not synced), and both (the write finished).
      const lists: string[][] = []
      for (let answered = -1; answered <= 2; answered += 1) {
        lists.push((await writeCutAt(answered)).map((entry) => `${entry.runId}:${entry.status}`))
      }
      expect(lists).toEqual([['old:queued'], ['old:queued'], ['old:queued'], ['new:active']])
    })
  })
})
