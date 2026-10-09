/**
 * After a power cut. The Host goes down with the machine, so its follower
 * starts cold on whatever the disk kept; then the app starts again, mends what
 * it finds and writes on. The cut is tried after every step of a thread's life
 * under the barrier, with the worst a power cut can do: only what a sync made
 * safe is kept. That loses the lines after the last barrier, and brings a
 * compaction's sealed segment, unlinked with no barrier since, back beside the
 * checkpoint that holds its lines. At each cut the follower must end on the
 * app's record and be nothing else after any batch.
 */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { deriveChatRecordMutation } from '../main/store/ChatRecordMutation'
import { prepareCheckpoint } from '../main/store/CheckpointPreparationCore'
import {
  checkpointFileReference,
  type CheckpointPreparationJob,
  type CheckpointPreparationPort,
  type CheckpointPreparationRequest,
  type CheckpointPreparationSource,
  type PreparedCheckpoint
} from '../main/store/CheckpointPreparationProtocol'
import {
  createIncrementalChatJournal,
  type IncrementalChatJournal
} from '../main/store/IncrementalChatJournal'
import {
  createThreadDurabilityDebt,
  type ThreadDurabilityDebt
} from '../main/store/ThreadDurabilityDebt'
import type { ChatRecord } from '../main/store/types'
import { watchCrashDisk, type CrashDisk } from '../main/store/unsyncedWriteCrashDisk.testutil'
import {
  HOST_THREAD_LOG_SEED_REASONS,
  HostThreadLogFollower,
  type HostThreadLogRecord,
  type HostThreadLogView
} from './HostThreadLogFollower'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'host-log-power-cut-'

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

function first(): ChatRecord {
  return {
    appChatId: CHAT,
    title: 'Thread',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    persistenceRevision: 1,
    messages: [],
    runs: []
  }
}

/** One message more, of a steady size so that lines are alike. */
function grown(record: ChatRecord): ChatRecord {
  const revision = (record.persistenceRevision ?? 0) + 1
  return {
    ...record,
    updatedAt: revision,
    persistenceRevision: revision,
    messages: [
      ...record.messages,
      { id: `m${revision}`, role: 'user', content: `${revision} `.padEnd(200, '.'), timestamp: AT }
    ]
  }
}

const LINE = Buffer.byteLength(
  `${JSON.stringify(deriveChatRecordMutation(first(), grown(first()), { savedAt: AT }))}\n`
)

/** The checkpoint worker, run on this thread when the step says, and the directory syncs it waits on. */
class Compactor implements CheckpointPreparationPort {
  private readonly jobs: Array<{
    request: CheckpointPreparationRequest
    ready: (value: PreparedCheckpoint) => void
    fail: (error: Error) => void
  }> = []
  private readonly syncs: Array<() => void> = []

  constructor(
    private readonly directory: string,
    private readonly sync: (directory: string) => Promise<unknown>
  ) {}

  get pendingSyncs(): number {
    return this.syncs.length
  }

  start(source: CheckpointPreparationSource): CheckpointPreparationJob | null {
    const outputPath = path.join(
      this.directory,
      `.${source.chatId}.checkpoint-prepared-${process.pid}-${randomUUID()}.tmp`
    )
    fs.writeFileSync(outputPath, '', { flag: 'wx', mode: 0o600 })
    const output = checkpointFileReference(outputPath)
    let ready!: (value: PreparedCheckpoint) => void
    let fail!: (error: Error) => void
    const result = new Promise<PreparedCheckpoint>((resolve, reject) => {
      ready = resolve
      fail = reject
    })
    const release = (): void => fs.rmSync(outputPath, { force: true })
    this.jobs.push({ request: { ...source, output, maxOutputBytes: 8 * 1024 * 1024 }, ready, fail })
    return { output, result, cancel: release, release }
  }

  fold(): void {
    const job = this.jobs.shift()
    if (!job) throw new Error('no compaction is waiting for the worker')
    try {
      job.ready(prepareCheckpoint(job.request))
    } catch (error) {
      job.fail(error as Error)
    }
  }

  /** Held until released: then the directory's names are made safe. */
  readonly syncDirectory = (directory: string): Promise<void> =>
    new Promise<void>((resolve, reject) =>
      this.syncs.push(() => {
        this.sync(directory).then(() => resolve(), reject)
      })
    )

  releaseSync(): void {
    const release = this.syncs.shift()
    if (!release) throw new Error('no directory sync is waiting')
    release()
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  // Compaction joins asynchronous filesystem work; a CPU spin count does
  // not give that work a consistent time budget on different runners.
  await vi.waitFor(() => expect(condition(), what).toBe(true), { timeout: 5_000, interval: 5 })
}

/** The app before the cut. */
interface Life {
  readonly journal: IncrementalChatJournal
  readonly compactor: Compactor
  readonly debt: ThreadDurabilityDebt
  record: ChatRecord
}

function append(life: Life): void {
  const next = grown(life.record)
  life.journal.append(deriveChatRecordMutation(life.record, next, { savedAt: AT }))
  life.record = next
}

/** A thread's life under the barrier: lines, a rotation, a compaction, barriers between. */
const STEPS: ReadonlyArray<{ readonly name: string; readonly run: (life: Life) => unknown }> = [
  { name: 'append', run: append },
  { name: 'append', run: append },
  { name: 'barrier', run: (life) => life.debt.barrier(CHAT) },
  { name: 'append past the trigger, which seals', run: append },
  { name: 'append to the next segment', run: append },
  {
    name: 'the worker folds, and the checkpoint is adopted',
    run: async (life) => {
      life.compactor.fold()
      await until(() => life.compactor.pendingSyncs > 0, 'the adoption waits on its sync')
    }
  },
  { name: 'barrier', run: (life) => life.debt.barrier(CHAT) },
  {
    name: 'the sync settles, and the sealed segment is unlinked',
    run: async (life) => {
      life.compactor.releaseSync()
      await until(() => life.journal.stats().compactionsAdopted > 0, 'the compaction is done')
    }
  },
  { name: 'append', run: append },
  { name: 'barrier', run: (life) => life.debt.barrier(CHAT) },
  { name: 'append', run: append }
]

function difference(view: HostThreadLogView, record: ChatRecord): string | null {
  const { messages, runs, ...shell } = record
  if (view.revision !== record.persistenceRevision) return `revision ${view.revision}`
  if (!isDeepStrictEqual(view.shell, shell)) return 'record without its transcript'
  if (view.messageCount !== messages.length) return 'message count'
  const newest = messages.slice(messages.length - view.messages.length)
  if (!isDeepStrictEqual(view.messages, newest)) return 'messages'
  if (view.runCount !== runs.length) return 'run count'
  return null
}

function appLoad(directory: string): ChatRecord | null {
  return createIncrementalChatJournal(directory, {
    noteDurabilityDebt: () => {},
    canWrite: () => false
  }).replay(CHAT).record
}

describe.skipIf(process.platform === 'win32')('a follower started after a power cut', () => {
  let root: string | null = null
  let disk: CrashDisk | null = null

  afterEach(() => {
    disk?.dispose()
    disk = null
    vi.restoreAllMocks()
    if (root) removeTemporaryDirectory(root)
    root = null
  })

  for (let cut = 0; cut <= STEPS.length; cut += 1) {
    const after = cut === 0 ? 'the first checkpoint' : `step ${cut} (${STEPS[cut - 1].name})`
    it(`ends on the record of the app that started again, cut after ${after}`, async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
      disk = watchCrashDisk(root)
      const debt = createThreadDurabilityDebt({ port: disk.port })
      const compactor = new Compactor(root, disk.port.syncDirectory)
      const options = {
        checkpointPreparation: compactor,
        syncDirectory: compactor.syncDirectory,
        maxJournalBytes: Math.floor(LINE * 2.5),
        canRepairOnRead: () => false,
        repairTornTailBeforeAppend: true
      }
      const life: Life = {
        journal: createIncrementalChatJournal(root, { ...options, noteDurabilityDebt: debt.note }),
        compactor,
        debt,
        record: first()
      }
      life.journal.initialize(CHAT, life.record)
      await debt.barrier(CHAT)
      for (const step of STEPS.slice(0, cut)) await step.run(life)
      disk.powerLoss()

      // The Host comes back first, on what the disk kept.
      const kept = appLoad(root)
      expect(kept).not.toBeNull()
      const records = new Map<number, ChatRecord>([[kept!.persistenceRevision!, kept!]])
      const failures: string[] = []
      const follower = new HostThreadLogFollower({
        chatId: CHAT,
        directory: root,
        windowMessages: 4,
        seedPort: { seed: async () => appLoad(root!) as unknown as HostThreadLogRecord | null },
        observer: {
          seeded: (record) => {
            const revision = (record as unknown as ChatRecord).persistenceRevision ?? 0
            if (!isDeepStrictEqual(record, records.get(revision))) {
              failures.push(`seeded at ${revision} with a record the app did not have`)
            }
          },
          applied: () => {
            const view = follower.view()!
            const record = records.get(view.revision)
            const wrong = record ? difference(view, record) : 'a revision the app did not have'
            if (wrong) failures.push(`at ${view.revision}: ${wrong}`)
          }
        }
      })
      try {
        await follower.poll()
        // The app starts again, mends what it finds, and writes on.
        const restarted: Life = {
          journal: createIncrementalChatJournal(root, {
            ...options,
            checkpointPreparation: new Compactor(root, disk.port.syncDirectory),
            noteDurabilityDebt: () => {}
          }),
          compactor,
          debt,
          record: first()
        }
        const replayed = restarted.journal.replay(CHAT).record
        expect(replayed).toEqual(kept)
        restarted.record = replayed!
        await follower.poll()
        for (let more = 0; more < 4; more += 1) {
          append(restarted)
          records.set(restarted.record.persistenceRevision!, restarted.record)
          await follower.poll()
        }
        const result = await follower.poll()
        expect(result).toMatchObject({
          status: 'following',
          caughtUp: true,
          stoppedAt: null,
          revision: restarted.record.persistenceRevision
        })
        expect(difference(follower.view()!, restarted.record)).toBeNull()
        expect(failures).toEqual([])
        const stats = follower.stats()
        for (const reason of HOST_THREAD_LOG_SEED_REASONS) {
          expect(stats.seeds[reason], reason).toBe(reason === 'cold' ? 1 : 0)
        }
      } finally {
        follower.close()
      }
    })
  }
})
