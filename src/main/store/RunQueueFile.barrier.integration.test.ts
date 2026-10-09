/**
 * The run queue through the real store. With barrier durability its list in
 * memory is what the store reads and changes: a change syncs nothing on the
 * calling thread, the file follows a write behind through the layer's port,
 * a person's change waits, bounded, for the write that holds it, history
 * deletion and quit write the file where they run, and startup recovers from
 * a file a few transitions behind. With the switch off, every change writes
 * and syncs the file where it is made, as before, and the store answers and
 * writes exactly what it does with the switch on.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunQueueJobInput } from '../RunQueue'
import type { DurableMomentGateOptions } from '../run/DurableMomentGate'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type {
  ThreadDurabilityPort,
  ThreadDurabilitySyncOptions,
  ThreadDurabilitySyncOutcome
} from './ThreadDurabilityDebt'
import type { RunQueueJob } from './types'
import {
  chatRecord,
  disposeHostOwnedStores,
  importHostOwnedStore as openHostOwnedStore
} from './hostOwnedErasure.testutil'
import { watchCrashDisk, type CrashDisk } from './unsyncedWriteCrashDisk.testutil'

const layers = vi.hoisted(() => ({
  fixture: { port: null as ThreadDurabilityPort | null },
  get port(): ThreadDurabilityPort | null {
    return this.fixture.port
  },
  set port(port: ThreadDurabilityPort | null) {
    this.fixture.port = port
  },
  gateClock: null as Pick<DurableMomentGateOptions, 'now' | 'setTimer' | 'clearTimer'> | null
}))

vi.mock('../run/DurableMomentGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../run/DurableMomentGate')>()
  return {
    ...actual,
    DurableMomentGate: class extends actual.DurableMomentGate {
      constructor(options: DurableMomentGateOptions) {
        super({ ...options, ...layers.gateClock })
      }
    }
  }
})

vi.mock('./ThreadBarrierDurability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ThreadBarrierDurability')>()
  return {
    ...actual,
    createThreadBarrierDurability: (
      options: import('./ThreadBarrierDurability').ThreadBarrierDurabilityOptions = {}
    ) => {
      // A write from a disposed store must never consult a later test's port.
      const fixture = layers.fixture
      return actual.createThreadBarrierDurability({
        ...options,
        port: {
          syncFile: (target, sync) => fixture.port!.syncFile(target, sync),
          syncDirectory: (target, sync) => fixture.port!.syncDirectory(target, sync)
        }
      })
    }
  }
})

const disks: CrashDisk[] = []
const stores: Store[] = []
const abandonSyncs: Array<() => void> = []

afterEach(async () => {
  try {
    const stopped = Promise.all(stores.map((store) => store.shutdownMainDurability()))
    layers.port = {
      syncFile: async () => 'missing',
      syncDirectory: async () => 'missing'
    }
    while (abandonSyncs.length > 0) abandonSyncs.pop()!()
    await stopped
    // dispose() prevents publication but does not join file work already in
    // flight. Join it before removing profiles or restoring the disk spies.
    await vi.waitFor(
      () => {
        for (const store of stores) {
          expect(store.getThreadBarrierDurabilityPerf().runQueue?.writing ?? false).toBe(false)
        }
      },
      { timeout: 2_000, interval: 10 }
    )
  } finally {
    stores.length = 0
    while (disks.length > 0) disks.pop()!.dispose()
    layers.fixture = { port: null }
    layers.gateClock = null
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await disposeHostOwnedStores()
  }
})

type Store = Awaited<ReturnType<typeof openHostOwnedStore>>['AppStore']

async function importHostOwnedStore(...args: Parameters<typeof openHostOwnedStore>) {
  const fixture = await openHostOwnedStore(...args)
  stores.push(fixture.AppStore)
  return fixture
}

function job(
  name: string,
  chatId = 'chat-a',
  status: RunQueueJob['status'] = 'queued'
): RunQueueJobInput {
  return {
    id: `queue-${name}`,
    runId: `run-${name}`,
    provider: 'codex',
    workspaceId: 'workspace-a',
    workspacePath: '/repo/workspace-a',
    chatId,
    source: 'manual',
    status,
    priority: 0,
    attempt: 1
  }
}

/** A name the test can expect: the profile's folder, and a write's temp file whatever its suffix. */
function named(target: string, profilePath: string): string {
  if (target === profilePath) return 'profile'
  return path.basename(target).replace(/^run-queue\.json\..+\.tmp$/, 'run-queue.json.tmp')
}

/** The disk's port, listing each sync it pays with its class. */
function listing(disk: CrashDisk, profilePath: string, paid: string[]): ThreadDurabilityPort {
  const note = (kind: string, target: string, sync?: ThreadDurabilitySyncOptions): void => {
    const level = sync?.urgent ? 'urgent' : sync?.background ? 'background' : 'normal'
    paid.push(`${kind}:${named(target, profilePath)}:${level}`)
  }
  return {
    syncFile: (target, sync) => {
      note('file', target, sync)
      return disk.port.syncFile(target, sync)
    },
    syncDirectory: (target, sync) => {
      note('directory', target, sync)
      return disk.port.syncDirectory(target, sync)
    }
  }
}

interface HeldSync {
  name: string
  level: string
  /** Pays the sync on the disk, then answers it. */
  answer(): Promise<void>
}

/** The disk's port, holding every sync until the test answers it. */
function holding(
  disk: CrashDisk,
  profilePath: string
): { port: ThreadDurabilityPort; calls: HeldSync[] } {
  const calls: HeldSync[] = []
  const ask = (
    kind: 'file' | 'directory',
    target: string,
    sync?: ThreadDurabilitySyncOptions
  ): Promise<ThreadDurabilitySyncOutcome> =>
    new Promise<ThreadDurabilitySyncOutcome>((resolve, reject) => {
      abandonSyncs.push(() => resolve('missing'))
      calls.push({
        name: `${kind}:${named(target, profilePath)}`,
        level: sync?.urgent ? 'urgent' : sync?.background ? 'background' : 'normal',
        answer: async () => {
          try {
            resolve(
              await (kind === 'file' ? disk.port.syncFile(target) : disk.port.syncDirectory(target))
            )
          } catch (error) {
            reject(error)
          }
        }
      })
    })
  return {
    calls,
    port: {
      syncFile: (target, sync) => ask('file', target, sync),
      syncDirectory: (target, sync) => ask('directory', target, sync)
    }
  }
}

async function waitForSync(held: ReturnType<typeof holding>, index: number): Promise<void> {
  await vi.waitFor(() => expect(held.calls.length).toBeGreaterThan(index), {
    timeout: 2_000,
    interval: 5
  })
}

async function answerSync(held: ReturnType<typeof holding>, index: number): Promise<void> {
  await waitForSync(held, index)
  await held.calls[index].answer()
}

async function waitForWrite(store: Store): Promise<void> {
  await vi.waitFor(
    () => {
      const queue = store.getThreadBarrierDurabilityPerf().runQueue
      expect(queue).toMatchObject({ writing: false, unwrittenChanges: 0 })
      expect(queue?.writes).toBeGreaterThan(0)
    },
    { timeout: 2_000, interval: 10 }
  )
}

/** Allow pending work a turn for negative assertions; this does not prove a write finished. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2))
}

/** Syncs the run queue issued on the calling thread: its files, and the profile's folder. */
const queueSyncs = (issued: string[]): string[] =>
  issued
    .filter((entry) => entry.includes('run-queue') || entry === 'directory:.')
    .map((entry) => entry.replace(/run-queue\.json\..+\.tmp$/, 'run-queue.json.tmp'))

function queueFile(profilePath: string): RunQueueJob[] | null {
  const filePath = path.join(profilePath, 'run-queue.json')
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RunQueueJob[]
}

const statuses = (jobs: RunQueueJob[] | null): string[][] =>
  (jobs ?? []).map((entry) => [entry.runId, entry.status])

const temps = (profilePath: string): string[] =>
  fs.readdirSync(profilePath).filter((name) => name.startsWith('run-queue.json.'))

async function barrierStore(
  seeds: Parameters<typeof importHostOwnedStore>[0] = [],
  gateOpen = true
) {
  vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
  const { AppStore, profilePath } = await importHostOwnedStore(seeds, undefined, { gateOpen })
  const disk = watchCrashDisk(profilePath)
  disks.push(disk)
  const { afterRunQueueUserChange } = await import('../run/RunQueueUserWait')
  return { AppStore, profilePath, disk, afterRunQueueUserChange }
}

/** Real dispatch boundary, without starting a provider process. */
async function dispatcher(beforeAdapter?: () => Promise<void>) {
  const { RunCoordinator } = await import('../services/RunCoordinator')
  const start = vi.fn(async () => {})
  const coordinator = new RunCoordinator({
    normalizePayload: (payload) => payload as AgentRunPayload,
    routeWithRunId: (_provider, route) => ({ ...route, appRunId: route?.appRunId }),
    applyRuntimeProfileToPayload: (payload) => payload,
    ensureProviderRunPreflight: async () => true,
    authorizeBeforeAdapterRun: beforeAdapter,
    getAdapter: () => ({ run: start }) as never,
    sendError: vi.fn(),
    sendExit: vi.fn()
  })
  return {
    start,
    dispatch: (signal?: AbortSignal) =>
      coordinator.dispatch(
        {
          provider: 'codex',
          appRunId: 'run-a',
          appChatId: 'chat-a',
          prompt: 'Run once',
          providerSetupAbortSignal: signal
        } as AgentRunPayload,
        { sender: { id: 1 } }
      )
  }
}

// Power-cut reconstruction uses the POSIX model; sync accounting runs everywhere.
const test = it.skipIf(process.platform === 'win32')

describe('the run queue through the store, under barrier durability', () => {
  it('syncs nothing on the calling thread, reads every change back at once, and writes the file through the port', async () => {
    const { AppStore, profilePath, disk } = await barrierStore()
    const paid: string[] = []
    layers.port = listing(disk, profilePath, paid)

    AppStore.saveRunQueueJob(job('a'))
    AppStore.updateRunQueueJob('run-a', { status: 'starting' })
    AppStore.updateRunQueueJob('run-a', { status: 'active' })
    AppStore.saveRunQueueJob(job('b'))
    AppStore.deleteRunQueueJob('run-b')

    expect(queueSyncs(disk.issued)).toEqual([])
    expect(statuses(AppStore.getRunQueueJobs())).toEqual([['run-a', 'active']])
    expect(AppStore.getRunQueueJob('run-a')?.status).toBe('active')
    await waitForWrite(AppStore)

    expect(queueSyncs(disk.issued)).toEqual([])
    expect(paid).toEqual(['file:run-queue.json.tmp:normal', 'directory:profile:normal'])
    expect(queueFile(profilePath)).toEqual(AppStore.getRunQueueJobs({ includeTerminal: true }))
    expect(temps(profilePath)).toEqual([])
    expect(AppStore.getThreadBarrierDurabilityPerf().runQueue).toMatchObject({
      changes: 5,
      writes: 1,
      coalesced: 4,
      syncs: { files: 1, directories: 1 },
      unwrittenChanges: 0
    })
    // This first case also imports the real store and its workers from cold.
  }, 30_000)

  it('starts a provider only after the lease generation is written, at normal class', async () => {
    // The test holds real filesystem syncs by hand. Scheduling delays must
    // not spend the gate's clock before those deliberately held syncs return.
    const gateTimers: Array<{ ms: number; cleared: boolean }> = []
    layers.gateClock = {
      now: () => 0,
      setTimer: (_callback, ms) => {
        const timer = { ms, cleared: false }
        gateTimers.push(timer)
        return timer
      },
      clearTimer: (handle) => {
        ;(handle as { cleared: boolean }).cleared = true
      }
    }
    const { AppStore, profilePath, disk } = await barrierStore()
    layers.port = disk.port
    AppStore.saveRunQueueJob(job('a'))
    await waitForWrite(AppStore)
    const held = holding(disk, profilePath)
    layers.port = held.port
    AppStore.updateRunQueueJob('run-a', { status: 'starting' })
    const provider = await dispatcher()
    await waitForSync(held, 0)
    expect(held.calls.map((call) => call.level)).toEqual(['normal'])
    // Even a change made before dispatch must not extend the exact lease wait.
    AppStore.saveRunQueueJob(job('b'))
    const dispatched = provider.dispatch()
    await settle()
    expect(provider.start).not.toHaveBeenCalled()
    await answerSync(held, 0)
    await waitForSync(held, 1)
    expect(provider.start).not.toHaveBeenCalled()
    expect(held.calls[1].level).toBe('normal')
    await answerSync(held, 1)
    expect((await dispatched).dispatched).toBe(true)
    expect(provider.start).toHaveBeenCalledOnce()
    expect(AppStore.getThreadBarrierDurabilityPerf().runQueue?.startWaits).toMatchObject({
      waits: 1,
      overdue: 0
    })
    expect(AppStore.getThreadBarrierDurabilityPerf().runQueue?.unwrittenChanges).toBe(1)
    expect(gateTimers).toEqual([{ ms: 1_000, cleared: true }])
  })

  test('after a power cut after the lease write and before start, recovers failed without redispatch', async () => {
    const { AppStore, profilePath, disk } = await barrierStore()
    layers.port = disk.port
    AppStore.saveRunQueueJob(job('a'))
    await waitForWrite(AppStore)
    const held = holding(disk, profilePath)
    layers.port = held.port
    AppStore.updateRunQueueJob('run-a', { status: 'starting' })
    let continueAdmission!: () => void
    const pausedAdmission = new Promise<void>((resolve) => {
      continueAdmission = resolve
    })
    const admitted = vi.fn(() => pausedAdmission)
    const provider = await dispatcher(admitted)
    const abort = new AbortController()
    const dispatched = provider.dispatch(abort.signal)
    await waitForSync(held, 0)
    expect(admitted).not.toHaveBeenCalled()
    await answerSync(held, 0)
    await answerSync(held, 1)
    await vi.waitFor(() => expect(admitted).toHaveBeenCalledOnce())
    expect(provider.start).not.toHaveBeenCalled()

    abort.abort()
    continueAdmission()
    expect((await dispatched).dispatched).toBe(false)
    await AppStore.shutdownMainDurability()
    disk.powerLoss()
    layers.port = disk.port
    const restarted = await importHostOwnedStore([], undefined, { profilePath, gateOpen: true })
    const records = restarted.AppStore.recoverRunQueueAfterStartup()
    expect(records).toMatchObject([{ runId: 'run-a', action: 'marked_failed' }])
    expect(restarted.AppStore.getRunQueueJobs({ statuses: ['queued'] })).toEqual([])
    expect(restarted.AppStore.getRunQueueJob('run-a')).toMatchObject({
      status: 'failed',
      recoveryReason: 'marked_failed_on_startup'
    })
    expect(provider.start).not.toHaveBeenCalled()
  })

  test('a power cut before the lease write leaves a queued job that starts once after restart', async () => {
    const { AppStore, profilePath, disk } = await barrierStore()
    layers.port = disk.port
    AppStore.saveRunQueueJob(job('a'))
    await waitForWrite(AppStore)
    const held = holding(disk, profilePath)
    layers.port = held.port
    AppStore.updateRunQueueJob('run-a', { status: 'starting' })
    const provider = await dispatcher()
    const abort = new AbortController()
    const abandoned = provider.dispatch(abort.signal)
    await waitForSync(held, 0)
    expect(provider.start).not.toHaveBeenCalled()
    abort.abort()
    await AppStore.shutdownMainDurability()
    disk.powerLoss()
    layers.port = disk.port
    const restarted = await importHostOwnedStore([], undefined, { profilePath, gateOpen: true })
    expect(restarted.AppStore.recoverRunQueueAfterStartup()).toEqual([])
    expect(restarted.AppStore.getRunQueueJob('run-a')?.status).toBe('queued')
    restarted.AppStore.updateRunQueueJob('run-a', { status: 'starting' })
    const resumed = await dispatcher()
    await resumed.dispatch()
    expect(resumed.start).toHaveBeenCalledOnce()
    expect((await abandoned).dispatched).toBe(false)
    expect(provider.start).not.toHaveBeenCalled()
  })

  it('starts at the one-second bound when the lease write is held and counts overdue', async () => {
    const { AppStore, profilePath, disk } = await barrierStore()
    layers.port = holding(disk, profilePath).port
    AppStore.saveRunQueueJob(job('a'))
    AppStore.updateRunQueueJob('run-a', { status: 'starting' })
    const provider = await dispatcher()
    const began = Date.now()
    const dispatched = provider.dispatch()
    await settle()
    expect(provider.start).not.toHaveBeenCalled()
    expect((await dispatched).dispatched).toBe(true)
    expect(Date.now() - began).toBeGreaterThanOrEqual(900)
    expect(provider.start).toHaveBeenCalledOnce()
    expect(queueFile(profilePath)).toBeNull()
    expect(AppStore.getThreadBarrierDurabilityPerf().runQueue?.startWaits).toMatchObject({
      waits: 1,
      overdue: 1
    })
  })

  it('does not start a provider cancelled while its lease write waits', async () => {
    const { AppStore, profilePath, disk } = await barrierStore()
    const held = holding(disk, profilePath)
    layers.port = held.port
    AppStore.saveRunQueueJob(job('a'))
    AppStore.updateRunQueueJob('run-a', { status: 'starting' })
    const provider = await dispatcher()
    const abort = new AbortController()
    const dispatched = provider.dispatch(abort.signal)
    await settle()
    expect(provider.start).not.toHaveBeenCalled()
    abort.abort()
    AppStore.updateRunQueueJob('run-a', { status: 'cancelled' })
    await answerSync(held, 0)
    await settle()
    await answerSync(held, 1)
    expect((await dispatched).dispatched).toBe(false)
    expect(provider.start).not.toHaveBeenCalled()
  })

  it('hands out copies: a caller that changes what it read changes nothing kept', async () => {
    const { AppStore, profilePath, disk } = await barrierStore()
    layers.port = listing(disk, profilePath, [])
    AppStore.saveRunQueueJob(job('a'))

    const read = AppStore.getRunQueueJob('run-a')!
    read.status = 'completed'
    AppStore.getRunQueueJobs()[0].priority = 99
    AppStore.recoverInterruptedRunQueueJobs()[0].chatId = 'chat-z'

    expect(AppStore.getRunQueueJob('run-a')).toMatchObject({
      status: 'queued',
      priority: 0,
      chatId: 'chat-a'
    })
  })

  it('makes a handful of writes for a burst of 1,000 transitions, the last holding the latest list', async () => {
    const { AppStore, profilePath, disk } = await barrierStore()
    layers.port = listing(disk, profilePath, [])
    // A loaded runner can spend longer opening the temp file than the old
    // fixed settle pause. Keep that scheduling case in the burst regression.
    const open = fs.promises.open
    vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return open(...args)
    })
    AppStore.saveRunQueueJob(job('a'))

    for (let index = 0; index < 1_000; index += 1) {
      AppStore.updateRunQueueJob('run-a', { statusReason: `step ${index}` })
    }
    await waitForWrite(AppStore)

    const counted = AppStore.getThreadBarrierDurabilityPerf().runQueue!
    expect(counted.changes).toBe(1_001)
    expect(counted.writes).toBeLessThanOrEqual(3)
    expect(counted.coalesced).toBe(1_001 - counted.writes)
    expect(queueSyncs(disk.issued)).toEqual([])
    expect(queueFile(profilePath)?.[0].statusReason).toBe('step 999')
  })

  it("replies to a person's change once a finished write holds it, asking the port for urgent syncs", async () => {
    const { AppStore, profilePath, disk, afterRunQueueUserChange } = await barrierStore()
    const held = holding(disk, profilePath)
    layers.port = held.port

    AppStore.saveRunQueueJob(job('a'))
    let replied: string | null = null
    const reply = Promise.resolve(afterRunQueueUserChange('queued')).then((value) => {
      replied = value
    })
    await waitForSync(held, 0)
    expect(held.calls.map((call) => `${call.name}:${call.level}`)).toEqual([
      'file:run-queue.json.tmp:urgent'
    ])
    expect(replied).toBeNull()

    await answerSync(held, 0)
    await waitForSync(held, 1)
    expect(held.calls.map((call) => `${call.name}:${call.level}`)).toEqual([
      'file:run-queue.json.tmp:urgent',
      'directory:profile:urgent'
    ])
    expect(replied).toBeNull()

    await answerSync(held, 1)
    await reply
    expect(replied).toBe('queued')
    expect(statuses(queueFile(profilePath))).toEqual([['run-a', 'queued']])
    expect(AppStore.getThreadBarrierDurabilityPerf().runQueue?.userWaits).toMatchObject({
      waits: 1,
      overdue: 0
    })

    // Written already: nothing to wait for, and the reply is the value itself.
    expect(afterRunQueueUserChange('again')).toBe('again')
  })

  it("lets a person's change reply at the bound when its write has not finished, counted overdue", async () => {
    const { AppStore, profilePath, disk, afterRunQueueUserChange } = await barrierStore()
    const held = holding(disk, profilePath)
    layers.port = held.port

    AppStore.saveRunQueueJob(job('a'))
    const started = Date.now()
    await afterRunQueueUserChange('queued')

    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(AppStore.getThreadBarrierDurabilityPerf().runQueue?.userWaits).toMatchObject({
      waits: 1,
      overdue: 1
    })
    expect(queueFile(profilePath)).toBeNull()
  })

  it('history deletion writes the file where it runs, and a write already running renames nothing over it', async () => {
    const { AppStore, profilePath, disk } = await barrierStore(
      [chatRecord('chat-a', 1), chatRecord('chat-b', 1)],
      false
    )
    const held = holding(disk, profilePath)
    layers.port = held.port
    AppStore.saveRunQueueJob(job('a', 'chat-a'))
    AppStore.saveRunQueueJob(job('b', 'chat-b'))
    await waitForSync(held, 0)
    expect(held.calls.map((call) => call.name)).toEqual(['file:run-queue.json.tmp'])
    // The scope takes the queued run from the list, its write still running,
    // and writes nothing to find it.
    expect(
      AppStore.previewHistoryDeletionScope({ kind: 'chat', rootChatId: 'chat-a' }).runIds
    ).toContain('run-a')
    expect(queueSyncs(disk.issued)).toEqual([])

    await AppStore.deleteChatViaHost('chat-a')

    expect(statuses(queueFile(profilePath))).toEqual([['run-b', 'queued']])
    expect(statuses(AppStore.getRunQueueJobs())).toEqual([['run-b', 'queued']])
    expect(temps(profilePath)).toEqual([])

    await answerSync(held, 0)
    await vi.waitFor(() =>
      expect(AppStore.getThreadBarrierDurabilityPerf().runQueue?.writing).toBe(false)
    )
    expect(statuses(queueFile(profilePath))).toEqual([['run-b', 'queued']])
    expect(temps(profilePath)).toEqual([])
    expect(AppStore.getThreadBarrierDurabilityPerf().runQueue).toMatchObject({
      superseded: 1,
      unwrittenChanges: 0
    })

    await AppStore.clearChatsViaHost()
    expect(queueFile(profilePath)).toBeNull()
    expect(AppStore.getRunQueueJobs({ includeTerminal: true })).toEqual([])
  })

  it('at quit, writes the latest list within the budget, and every change after it where it is made', async () => {
    const { AppStore, profilePath, disk } = await barrierStore()
    layers.port = listing(disk, profilePath, [])
    AppStore.saveRunQueueJob(job('a'))
    AppStore.updateRunQueueJob('run-a', { status: 'starting' })

    await AppStore.flushAllChatSaves({ hostDrainTimeoutMs: 1_000 })
    expect(statuses(queueFile(profilePath))).toEqual([['run-a', 'starting']])
    expect(queueSyncs(disk.issued)).toEqual([])

    AppStore.updateRunQueueJob('run-a', { status: 'active' })
    expect(statuses(queueFile(profilePath))).toEqual([['run-a', 'active']])
    // The file's own sync; its folder's is queued off the thread, as without the switch.
    expect(queueSyncs(disk.issued).filter((entry) => entry.startsWith('file:'))).toEqual([
      'file:run-queue.json.tmp'
    ])
    expect(AppStore.getThreadBarrierDurabilityPerf().runQueue).toMatchObject({
      inlineWrites: 1,
      quitUnwritten: 0,
      unwrittenChanges: 0
    })
  })

  it('at quit, reports the latest list unwritten when its write outlasts the budget', async () => {
    const { AppStore, profilePath, disk } = await barrierStore()
    layers.port = holding(disk, profilePath).port
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    AppStore.saveRunQueueJob(job('a'))

    await AppStore.flushAllChatSaves({ hostDrainTimeoutMs: 50 })

    expect(queueFile(profilePath)).toBeNull()
    expect(AppStore.getThreadBarrierDurabilityPerf().runQueue).toMatchObject({ quitUnwritten: 1 })
    expect(warn.mock.calls.flat().join(' ')).toContain('not written within the quit budget')
  })

  it('once the store shuts its durability down, writes a change where it is made', async () => {
    const { AppStore, profilePath, disk } = await barrierStore()
    layers.port = listing(disk, profilePath, [])
    await AppStore.shutdownMainDurability()

    AppStore.saveRunQueueJob(job('a'))

    expect(statuses(queueFile(profilePath))).toEqual([['run-a', 'queued']])
    expect(AppStore.getThreadBarrierDurabilityPerf().runQueue).toMatchObject({
      inlineWrites: 1,
      writes: 0
    })
  })

  test('after a power cut, startup recovers from a file a few transitions behind', async () => {
    const { AppStore, profilePath, disk } = await barrierStore()
    layers.port = listing(disk, profilePath, [])
    AppStore.saveRunQueueJob(job('a'))
    AppStore.updateRunQueueJob('run-a', { status: 'starting' })
    AppStore.updateRunQueueJob('run-a', { status: 'active' })
    AppStore.saveRunQueueJob(job('b'))
    // Establish a fully synced baseline before cutting off later writes.
    await waitForWrite(AppStore)
    expect(statuses(queueFile(profilePath))).toEqual([
      ['run-a', 'active'],
      ['run-b', 'queued']
    ])

    // Automatic transitions whose write never finishes: a run ends, another starts.
    const held = holding(disk, profilePath)
    layers.port = held.port
    AppStore.updateRunQueueJob('run-a', { status: 'completed' })
    AppStore.updateRunQueueJob('run-b', { status: 'starting' })
    AppStore.updateRunQueueJob('run-b', { status: 'active' })
    await waitForSync(held, 0)
    disk.powerLoss()
    expect(statuses(queueFile(profilePath))).toEqual([
      ['run-a', 'active'],
      ['run-b', 'queued']
    ])
    expect(temps(profilePath)).toEqual([])

    layers.port = listing(disk, profilePath, [])
    const restarted = await importHostOwnedStore([], undefined, { profilePath, gateOpen: true })
    const records = restarted.AppStore.recoverRunQueueAfterStartup()
    restarted.AppStore.recoverInterruptedRunQueueJobs()

    // The run that ended is recovered as one the cut interrupted; the one that
    // had started is queued again, to run again.
    expect(records.map((record) => record.runId)).toEqual(['run-a'])
    const recovered = restarted.AppStore.getRunQueueJobs({ includeTerminal: true })
    expect(statuses(recovered)).toEqual([
      ['run-b', 'queued'],
      ['run-a', 'failed']
    ])
    // Startup recovery writes asynchronously. Observe the durable outcome;
    // a fixed 20 ms pause can end before the filesystem work on a loaded host.
    await vi.waitFor(() => expect(queueFile(profilePath)).toEqual(recovered), {
      timeout: 2_000,
      interval: 10
    })
  })
})

describe('the run queue through the store, with the switch off', () => {
  it('syncs every change where it is made, waits for nothing, and reports no run queue counters', async () => {
    // On by default: off needs the exact token `0`.
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '0')
    const { AppStore, profilePath } = await importHostOwnedStore([], undefined, { gateOpen: true })
    const disk = watchCrashDisk(profilePath)
    disks.push(disk)
    const { afterRunQueueUserChange } = await import('../run/RunQueueUserWait')

    AppStore.saveRunQueueJob(job('a'))

    expect(queueSyncs(disk.issued).filter((entry) => entry.startsWith('file:'))).toHaveLength(1)
    expect(statuses(queueFile(profilePath))).toEqual([['run-a', 'queued']])
    expect(afterRunQueueUserChange('queued')).toBe('queued')
    expect(AppStore.getThreadBarrierDurabilityPerf().runQueue).toBeNull()
  })

  /** Every answer the store gives along one sequence of changes, and the file it leaves. */
  async function transcript(switchOn: boolean): Promise<{ answers: unknown[]; file: string }> {
    vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', switchOn ? '1' : '0')
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-05T12:00:00.000Z') })
    const { AppStore, profilePath } = await importHostOwnedStore([], undefined, { gateOpen: true })
    const disk = watchCrashDisk(profilePath)
    disks.push(disk)
    layers.port = disk.port
    const answers: unknown[] = []
    const step = (value: unknown): void => {
      answers.push(JSON.parse(JSON.stringify(value ?? null)))
    }
    const sequence: Array<(store: Store) => unknown> = [
      (store) => store.saveRunQueueJob(job('a')),
      (store) => store.saveRunQueueJob({ ...job('b', 'chat-b'), priority: 2 }),
      (store) => store.saveRunQueueJob(job('c')),
      (store) => store.updateRunQueueJob('run-a', { status: 'starting' }),
      (store) => store.updateRunQueueJob('queue-a', { status: 'active', processPid: 0 }),
      (store) => store.updateRunQueueJob('run-b', { status: 'cancelled' }),
      (store) => store.updateRunQueueJob('run-missing', { status: 'active' }),
      (store) => store.deleteRunQueueJob('run-c'),
      (store) => store.getRunQueueJobs(),
      (store) => store.getRunQueueJobs({ includeTerminal: true }),
      (store) => store.getRunQueueJobs({ chatId: 'chat-b', includeTerminal: true }),
      (store) => store.getRunQueueJob('queue-b'),
      (store) => store.getRunQueueJob('run-missing'),
      (store) => store.recoverInterruptedRunQueueJobs(),
      (store) => store.recoverRunQueueAfterStartup(),
      (store) => store.getRunQueueJobs({ includeTerminal: true })
    ]
    for (const change of sequence) step(change(AppStore))
    await AppStore.flushAllChatSaves({ hostDrainTimeoutMs: 1_000 })
    const file = fs.readFileSync(path.join(profilePath, 'run-queue.json'), 'utf8')
    vi.useRealTimers()
    vi.unstubAllEnvs()
    return { answers, file }
  }

  it('answers and writes exactly what it does with the switch on', async () => {
    const off = await transcript(false)
    const on = await transcript(true)

    expect(on.answers).toEqual(off.answers)
    expect(on.file).toBe(off.file)
    expect(off.answers).toHaveLength(16)
  })
})
