/**
 * What the real store hands its journal for checkpoints under each switch: the
 * pool a compaction folds in, the port that makes an adopted checkpoint's
 * rename durable, and what a save's catalogue head waits for.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  IncrementalChatJournal,
  IncrementalChatJournalOptions
} from './IncrementalChatJournal'
import {
  chatRecord,
  disposeHostOwnedStores,
  importHostOwnedStore
} from './hostOwnedErasure.testutil'

/** What the store built, in the order it built it. */
const built = vi.hoisted(() => ({
  workers: [] as object[],
  connectors: [] as object[],
  journals: [] as IncrementalChatJournalOptions[],
  journalObjects: [] as IncrementalChatJournal[],
  /** Replaces the journal's own deferred wait while set. */
  deferredWait: null as (() => Promise<void>) | null,
  deferredWaits: 0,
  /** How often the store's idle timer swept the journal, and the segmented store. */
  idleSweeps: 0,
  segmentedSweeps: 0
}))

vi.mock('./CheckpointPreparationWorker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./CheckpointPreparationWorker')>()
  const { prepareCheckpoint } = await import('./CheckpointPreparationCore')
  type Request = import('./CheckpointPreparationProtocol').CheckpointPreparationRequest
  type Reply = import('./CheckpointPreparationProtocol').CheckpointPreparationReply
  /** A fold on this thread, as the child would make it: the built entry is not here under test. */
  class FoldHere {
    private reply: ((reply: Reply) => void) | null = null
    private exit: (() => void) | null = null
    private exited = false
    post(request: Request): void {
      setImmediate(() => {
        if (this.exited) return
        let reply: Reply
        try {
          reply = { ok: true, prepared: prepareCheckpoint(request) }
        } catch (error) {
          reply = { ok: false, error: String(error) }
        }
        this.reply?.(reply)
      })
    }
    onMessage(listener: (reply: Reply) => void): void {
      this.reply = listener
    }
    onExit(listener: () => void): void {
      this.exit = listener
    }
    onError(): void {
      // This stand-in worker never fails, so it keeps no error listener.
    }
    kill(): void {
      if (this.exited) return
      this.exited = true
      this.exit?.()
    }
  }
  class RecordedWorker extends actual.CheckpointPreparationWorker {
    constructor(options: ConstructorParameters<typeof actual.CheckpointPreparationWorker>[0] = {}) {
      super({ spawn: () => new FoldHere(), ...options })
      built.workers.push(this)
    }
  }
  return { ...actual, CheckpointPreparationWorker: RecordedWorker }
})

vi.mock('./JournalHostReferenceConnector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./JournalHostReferenceConnector')>()
  class RecordedConnector extends actual.JournalHostReferenceConnector {
    constructor(...args: ConstructorParameters<typeof actual.JournalHostReferenceConnector>) {
      super(...args)
      built.connectors.push(this)
    }
  }
  return { ...actual, JournalHostReferenceConnector: RecordedConnector }
})

vi.mock('./IncrementalChatJournal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./IncrementalChatJournal')>()
  return {
    ...actual,
    createIncrementalChatJournal: (
      directory: string,
      options: IncrementalChatJournalOptions = {}
    ) => {
      built.journals.push(options)
      const journal = actual.createIncrementalChatJournal(directory, options)
      built.journalObjects.push(journal)
      const own = journal.awaitDeferredDurability!
      journal.awaitDeferredDurability = (chatId) => {
        built.deferredWaits += 1
        return built.deferredWait ? built.deferredWait() : own(chatId)
      }
      const sweep = journal.checkpointIdle
      journal.checkpointIdle = (nowMs) => {
        built.idleSweeps += 1
        return sweep(nowMs)
      }
      const sweepDeferred = journal.checkpointIdleDeferred!
      journal.checkpointIdleDeferred = (nowMs) => {
        built.idleSweeps += 1
        return sweepDeferred(nowMs)
      }
      return journal
    }
  }
})

vi.mock('./SegmentedChatStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./SegmentedChatStore')>()
  return {
    ...actual,
    createSegmentedChatStore: (...args: Parameters<typeof actual.createSegmentedChatStore>) => {
      const store = actual.createSegmentedChatStore(...args)
      const sweep = store.checkpointIdle
      store.checkpointIdle = (nowMs) => {
        built.segmentedSweeps += 1
        return sweep(nowMs)
      }
      return store
    }
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await disposeHostOwnedStores()
  vi.unstubAllEnvs()
  built.workers.length = 0
  built.connectors.length = 0
  built.journals.length = 0
  built.journalObjects.length = 0
  built.deferredWait = null
  built.deferredWaits = 0
  built.idleSweeps = 0
  built.segmentedSweeps = 0
})

const BARRIER = 'TASKWRAITH_THREAD_BARRIER_DURABILITY'
const WORKER = 'TASKWRAITH_CHECKPOINT_WORKER'
const PUBLICATION = 'TASKWRAITH_CHECKPOINT_PUBLICATION'

/**
 * Barrier durability is on by default, and only the exact token `0` turns it
 * off: a case that does not name it here means it off.
 */
function withBarrierOff(env: Record<string, string>): Record<string, string> {
  return { [BARRIER]: '0', ...env }
}

async function storeWith(env: Record<string, string>) {
  for (const [name, value] of Object.entries(withBarrierOff(env))) vi.stubEnv(name, value)
  const store = await importHostOwnedStore([])
  expect(built.journals).toHaveLength(1)
  return { ...store, journal: built.journals[0] }
}

describe("the journal's checkpoint pool, as the store builds it", () => {
  it.each([
    ['barrier durability', { [BARRIER]: '1' }],
    ['barrier durability, with the worker switch on too', { [BARRIER]: '1', [WORKER]: '1' }]
  ])(
    'with %s: one worker, handed to the journal whole, and no host reference connector',
    async (_name, env) => {
      const { journal } = await storeWith(env)

      expect(built.workers).toHaveLength(1)
      // The pool itself: start, and the admits and onCapacity its queue needs.
      expect(journal.checkpointPreparation).toBe(built.workers[0])
      expect(built.connectors).toEqual([])
    }
  )

  it('with barrier durability on by default: one worker, handed to the journal whole', async () => {
    vi.stubEnv(BARRIER, undefined)
    await importHostOwnedStore([])

    expect(built.journals).toHaveLength(1)
    expect(built.workers).toHaveLength(1)
    expect(built.journals[0].checkpointPreparation).toBe(built.workers[0])
    expect(built.connectors).toEqual([])
  })

  it.each([
    ['the worker switch alone', { [WORKER]: '1' }],
    [
      'barrier durability ignored for checkpoint publication',
      { [BARRIER]: '1', [PUBLICATION]: '1', [WORKER]: '1' }
    ]
  ])(
    'with %s: the worker and its connector, and the journal starts folds through the connector',
    async (_name, env) => {
      const { journal } = await storeWith(env)

      expect(built.workers).toHaveLength(1)
      expect(built.connectors).toHaveLength(1)
      expect(Object.keys(journal.checkpointPreparation!)).toEqual(['start'])
      expect(journal.syncDirectory).toBeUndefined()
    }
  )

  it('with neither: no worker, and no connector', async () => {
    const { journal } = await storeWith({})

    expect(built.workers).toEqual([])
    expect(built.connectors).toEqual([])
    expect(journal.checkpointPreparation).toBeUndefined()
    expect(journal.syncDirectory).toBeUndefined()
  })

  it("makes an adopted checkpoint's rename durable through the barrier's port, its limit and counters", async () => {
    const { AppStore, journal, profilePath } = await storeWith({ [BARRIER]: '1' })
    const started = AppStore.getThreadBarrierDurabilityPerf().port!.started

    await expect(journal.syncDirectory!(profilePath)).resolves.toBe('synced')
    expect(AppStore.getThreadBarrierDurabilityPerf().port!.started).toBe(started + 1)
  })
})

describe("a save's catalogue head", () => {
  it('settles without the journal under barrier durability: nothing in the store waits on its deferred syncs', async () => {
    built.deferredWait = () => new Promise<void>(() => {})
    const { AppStore } = await storeWith({ [BARRIER]: '1' })
    const changed: string[] = []
    AppStore.installThreadCataloguePublisher('test-writer', (chatId) => changed.push(chatId))

    AppStore.saveChat(chatRecord('chat-head', 0))
    const created = AppStore.getChat('chat-head')!
    AppStore.saveChat({ ...created, title: 'Renamed' })

    await vi.waitFor(() => expect(changed).toEqual(['chat-head', 'chat-head']), { timeout: 2_000 })
    await AppStore.awaitChatRecordDispatchDurable('chat-head')
    expect(built.deferredWaits).toBe(0)
    await AppStore.disposeThreadCataloguePublisher()
  })

  it("settles after the journal's own deferred syncs with barrier durability off, as before", async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    built.deferredWait = () => held
    const { AppStore } = await storeWith({})
    const changed: string[] = []
    AppStore.installThreadCataloguePublisher('test-writer', (chatId) => changed.push(chatId))

    AppStore.saveChat(chatRecord('chat-head', 0))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(changed).toEqual([])
    expect(built.deferredWaits).toBeGreaterThan(0)

    release()
    await vi.waitFor(() => expect(changed).toEqual(['chat-head']), { timeout: 2_000 })
    await AppStore.disposeThreadCataloguePublisher()
  })
})

describe("a dispatch's wait for the journal", () => {
  it("waits for the journal's own deferred syncs with barrier durability off, as before", async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    built.deferredWait = () => held
    const { AppStore } = await storeWith({})
    AppStore.saveChat(chatRecord('chat-dispatch', 0))
    const waits = built.deferredWaits

    let done = false
    const waiting = AppStore.awaitChatRecordDispatchDurable('chat-dispatch').then(
      () => (done = true)
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(done).toBe(false)
    expect(built.deferredWaits).toBe(waits + 1)

    release()
    await waiting
  })
})

describe("the store's idle sweep, at quit", () => {
  /** A store whose legacy gate is open, so that its idle timer sweeps the journal. */
  async function sweeping(env: Record<string, string>) {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    for (const [name, value] of Object.entries(withBarrierOff(env))) vi.stubEnv(name, value)
    const { AppStore } = await importHostOwnedStore([], undefined, { gateOpen: true })
    vi.advanceTimersByTime(5_000)
    expect(built.idleSweeps).toBe(1)
    await AppStore.flushAllChatSaves({ hostDrainTimeoutMs: 1_000 })
    vi.advanceTimersByTime(15_000)
    return built.idleSweeps
  }

  it('stops under barrier durability, so that no fold in its pool starts at quit', async () => {
    expect(await sweeping({ [BARRIER]: '1' })).toBe(1)
  })

  it('stops with the worker switch alone, as before', async () => {
    expect(await sweeping({ [WORKER]: '1' })).toBe(1)
  })

  it('goes on with neither, as before', async () => {
    expect(await sweeping({})).toBe(4)
  })
})

describe("the journal's idle sweep, with the Host owning the store", () => {
  const MiB = 1024 * 1024

  /**
   * A store the Host owns, holding a thread whose lines meet the fold rule (1
   * MiB, and half its checkpoint), which then stays quiet for 20 s of the
   * store's idle timer. Its run is still going, so that no save of it is
   * checkpointed at once as a run's end would be.
   */
  async function quietThread(env: Record<string, string>) {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true })
    const { AppStore, profilePath } = await storeWith(env)
    const journal = built.journalObjects[0]
    AppStore.saveChat(chatRecord('chat-quiet', 0))
    const created = AppStore.getChat('chat-quiet')!
    AppStore.saveChat({
      ...created,
      messages: [
        ...created.messages,
        {
          id: 'reply-1',
          role: 'assistant',
          content: 'x'.repeat(MiB + 64 * 1024),
          timestamp: '2026-10-05T00:00:00.000Z'
        }
      ],
      runs: [
        {
          runId: 'run-quiet',
          startedAt: '2026-10-05T00:00:00.000Z',
          status: 'running',
          provider: 'codex'
        }
      ]
    })
    const lines = join(profilePath, 'chat-journal-v2', 'chat-quiet.mutations.jsonl')
    const written = statSync(lines).size
    expect(written).toBeGreaterThan(MiB)

    vi.advanceTimersByTime(20_000)
    return { journal, lines, written }
  }

  it('folds a quiet thread that meets the fold rule under barrier durability', async () => {
    const { journal, lines } = await quietThread({ [BARRIER]: '1' })

    await vi.waitFor(() => expect(journal.stats().compactionsAdopted).toBe(1), {
      timeout: 3_000
    })
    expect(built.idleSweeps).toBeGreaterThan(0)
    // The segmented store keeps to where the legacy store may write.
    expect(built.segmentedSweeps).toBe(0)
    expect(journal.stats().idleCompactionsRequested).toBe(1)
    expect(statSync(lines, { throwIfNoEntry: false })?.size ?? 0).toBeLessThan(MiB)
  }, 15_000)

  it('does nothing with barrier durability off, as before', async () => {
    const { journal, lines, written } = await quietThread({})

    await new Promise((resolve) => setImmediate(resolve))
    expect(built.idleSweeps).toBe(0)
    expect(built.segmentedSweeps).toBe(0)
    expect(journal.stats().compactionsStarted).toBe(0)
    expect(statSync(lines).size).toBe(written)
  })

  it('leaves the journal alone under barrier durability where it cannot write, as while the gate drains', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.stubEnv(BARRIER, '1')
    await importHostOwnedStore([], undefined, { gateOpen: true })
    const { legacyStoreWriterGate } = await import('./LegacyStoreWriterGate')
    expect(legacyStoreWriterGate.beginDrain()).toBe(true)

    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()
    expect(built.idleSweeps).toBe(0)
  })
})

describe("the barrier's own idle barrier, with the Host owning the store", () => {
  it("pays a quiet thread's debt on the timer the layer arms for itself", async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    const { AppStore } = await storeWith({ [BARRIER]: '1' })
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const threads = () => AppStore.getThreadBarrierDurabilityPerf().threads

    // An empty new thread takes no ticket: what its first save owes waits for
    // the idle barrier.
    AppStore.saveChat(chatRecord('chat-idle', 0, { messages: [] }))
    expect(threads()).toMatchObject({ owing: 1, idleBarriers: 0 })
    const idle = timers.mock.calls.filter(([, ms]) => (ms ?? 0) > 14_000 && (ms ?? 0) <= 15_000)
    expect(idle).toHaveLength(1)

    vi.advanceTimersByTime(15_000)
    idle[0][0]()

    await vi.waitFor(() => expect(threads()).toMatchObject({ owing: 0, idleBarriers: 1 }))
  })
})
