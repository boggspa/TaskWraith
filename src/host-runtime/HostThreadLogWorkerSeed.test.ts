/**
 * The Host's seeds loaded in a worker thread. The worker runs the entry the
 * Host build compiles, bundled here as the Host build would compile it; the
 * log is the app's real journal.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { deriveChatRecordMutation } from '../main/store/ChatRecordMutation'
import { createIncrementalChatJournal } from '../main/store/IncrementalChatJournal'
import type { ChatRecord } from '../main/store/types'
import { HostThreadLogFollower, type HostThreadLogWindowSeed } from './HostThreadLogFollower'
import {
  HostThreadLogWorkerSeed,
  createHostThreadLogWorkerSeed,
  hostThreadLogSeedWorkerEntryPath
} from './HostThreadLogWorkerSeed'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'host-log-worker-seed-'

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

const CHAT = 'chat-1'
const AT = '2026-10-05T00:00:00.000Z'
const BOUNDS = { windowMessages: 3, windowRuns: 2, maxViewBytes: 64 * 1024 }

/** The thread as the app writes it: `count` messages after its first record. */
function writeThread(directory: string, count: number): ChatRecord {
  const journal = createIncrementalChatJournal(directory, {
    noteDurabilityDebt: () => {},
    syncDirectory: () => Promise.resolve(),
    canRepairOnRead: () => false,
    repairTornTailBeforeAppend: true
  })
  let record: ChatRecord = {
    appChatId: CHAT,
    title: 'Thread',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    persistenceRevision: 1,
    messages: [],
    runs: []
  }
  journal.initialize(CHAT, record)
  for (let index = 0; index < count; index += 1) {
    const revision = (record.persistenceRevision ?? 0) + 1
    const next: ChatRecord = {
      ...record,
      updatedAt: revision,
      persistenceRevision: revision,
      messages: [
        ...record.messages,
        { id: `m${revision}`, role: 'user', content: `${revision}`, timestamp: AT }
      ]
    }
    journal.append(deriveChatRecordMutation(record, next, { savedAt: AT }))
    record = next
  }
  return record
}

describe('seeds loaded in a worker', () => {
  let root: string
  let entryPath: string
  let directory: string
  const ports: HostThreadLogWorkerSeed[] = []

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    entryPath = path.join(root, 'seed-worker.cjs')
    buildSync({
      entryPoints: [path.join(__dirname, 'HostThreadLogSeedWorkerEntry.ts')],
      outfile: entryPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
  })

  afterAll(() => removeTemporaryDirectory(root))

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  })

  afterEach(async () => {
    for (const port of ports.splice(0)) await port.close()
    removeTemporaryDirectory(directory)
  })

  const open = (
    options: Partial<ConstructorParameters<typeof HostThreadLogWorkerSeed>[0]> = {}
  ): HostThreadLogWorkerSeed => {
    const port = new HostThreadLogWorkerSeed({ directory, entryPath, ...options })
    ports.push(port)
    return port
  }

  it("seeds a follower with its window, and an older page's load with the whole record", async () => {
    const record = writeThread(directory, 8)
    const port = open()
    const follower = new HostThreadLogFollower({
      chatId: CHAT,
      directory,
      seedPort: port,
      ...BOUNDS
    })
    try {
      expect(await follower.poll()).toMatchObject({ status: 'following', revision: 9 })
      const view = follower.view()!
      expect(view.messageCount).toBe(8)
      expect(view.messages).toEqual(record.messages.slice(-3))
      // It read on from where the worker stopped: no line twice.
      expect(follower.stats()).toMatchObject({ bytesRead: 0, duplicatesPassed: 0 })
    } finally {
      follower.close()
    }
    expect(await port.seed({ chatId: CHAT, reason: 'requested' })).toEqual(record)
    const stats = port.stats()
    expect(stats).toMatchObject({
      asked: 2,
      windows: 1,
      records: 1,
      absent: 0,
      failures: 0,
      workerStarts: 1,
      workerExits: 0,
      pending: 0
    })
    expect(stats.seedMs.count).toBe(2)
    expect(stats.worker.checkpoints).toBe(2)
    expect(stats.worker.batches).toBe(16)
    expect(stats.checkpointBytes.last).toBe(
      fs.statSync(path.join(directory, `${CHAT}.checkpoint.json`)).size
    )
  })

  it('answers no record for a thread without a log, and fails a load the worker refuses', async () => {
    const port = open()
    expect(await port.seed({ chatId: CHAT, reason: 'cold' })).toBeNull()
    await expect(port.seed({ chatId: '../chat', reason: 'cold' })).rejects.toThrow('unsafe chat id')
    expect(port.stats()).toMatchObject({ asked: 2, absent: 1, failures: 1, workerStarts: 1 })
  })

  it('fails what was asked of a worker that ended, and starts another for the next seed', async () => {
    const record = writeThread(directory, 3)
    const workers: Worker[] = []
    const port = open({
      createWorker: (file, options) => {
        const worker = new Worker(file, options)
        workers.push(worker)
        return worker
      }
    })
    const asked = port.seed({ chatId: CHAT, reason: 'cold' })
    await workers[0].terminate()
    await expect(asked).rejects.toThrow('Thread log seed worker ended')
    expect(await port.seed({ chatId: CHAT, reason: 'requested' })).toEqual(record)
    expect(workers).toHaveLength(2)
    expect(port.stats()).toMatchObject({ failures: 1, workerStarts: 2, workerExits: 1, pending: 0 })
  })

  it('ends its worker when closed, failing what is pending and refusing what comes after', async () => {
    writeThread(directory, 3)
    const workers: Worker[] = []
    const port = open({
      createWorker: (file, options) => {
        const worker = new Worker(file, options)
        workers.push(worker)
        return worker
      }
    })
    const asked = port.seed({ chatId: CHAT, reason: 'cold' })
    const answer = asked.then(
      () => 'answered',
      (error: Error) => error.message
    )
    const exited = new Promise((resolve) => workers[0].once('exit', resolve))
    await port.close()
    await exited
    expect(await answer).toBe('Thread log seed worker is closed')
    await expect(port.seed({ chatId: CHAT, reason: 'cold' })).rejects.toThrow('closed')
    expect(workers).toHaveLength(1)
  })

  it('caps the heap its worker may use', async () => {
    const options: Array<{ resourceLimits?: { maxOldGenerationSizeMb?: number } }> = []
    const port = open({
      maxHeapMb: 512,
      createWorker: (file, workerOptions) => {
        options.push(workerOptions)
        return new Worker(file, workerOptions)
      }
    })
    expect(await port.seed({ chatId: CHAT, reason: 'cold' })).toBeNull()
    expect(options).toEqual([{ resourceLimits: { maxOldGenerationSizeMb: 512 } }])
  })

  it('is made only where its compiled entry is, as in the Host build', async () => {
    expect(
      createHostThreadLogWorkerSeed({ directory, entryPath: path.join(root, 'none.cjs') })
    ).toBeNull()
    const port = createHostThreadLogWorkerSeed({ directory, entryPath })
    expect(port).toBeInstanceOf(HostThreadLogWorkerSeed)
    if (port) ports.push(port)
    expect(path.basename(hostThreadLogSeedWorkerEntryPath())).toBe(
      'HostThreadLogSeedWorkerEntry.js'
    )
    expect(path.dirname(hostThreadLogSeedWorkerEntryPath())).toBe(__dirname)
  })

  it('hands back windows that a structured copy keeps whole', async () => {
    writeThread(directory, 5)
    const port = open()
    const seed = (await port.seed({
      chatId: CHAT,
      reason: 'cold',
      window: { messages: 2, runs: 2, maxViewBytes: 64 * 1024 }
    })) as HostThreadLogWindowSeed
    expect(seed.kind).toBe('window')
    expect(seed.messages.map((each) => each.id)).toEqual(['m5', 'm6'])
    expect(typeof seed.readFrom[0]?.dev).toBe('bigint')
  })
})
