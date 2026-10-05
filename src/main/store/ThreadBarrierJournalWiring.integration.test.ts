/**
 * What the real store hands its journal for checkpoints under each switch: the
 * pool a compaction folds in, the port that makes an adopted checkpoint's
 * rename durable, and what a save's catalogue head waits for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IncrementalChatJournalOptions } from './IncrementalChatJournal'
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
  /** Replaces the journal's own deferred wait while set. */
  deferredWait: null as (() => Promise<void>) | null,
  deferredWaits: 0,
  /** How often the store's idle timer swept the journal. */
  idleSweeps: 0
}))

vi.mock('./CheckpointPreparationWorker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./CheckpointPreparationWorker')>()
  class RecordedWorker extends actual.CheckpointPreparationWorker {
    constructor(...args: ConstructorParameters<typeof actual.CheckpointPreparationWorker>) {
      super(...args)
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

afterEach(async () => {
  vi.useRealTimers()
  await disposeHostOwnedStores()
  vi.unstubAllEnvs()
  built.workers.length = 0
  built.connectors.length = 0
  built.journals.length = 0
  built.deferredWait = null
  built.deferredWaits = 0
  built.idleSweeps = 0
})

const BARRIER = 'TASKWRAITH_THREAD_BARRIER_DURABILITY'
const WORKER = 'TASKWRAITH_CHECKPOINT_WORKER'
const PUBLICATION = 'TASKWRAITH_CHECKPOINT_PUBLICATION'

async function storeWith(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
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

describe("the store's idle sweep, at quit", () => {
  /** A store whose legacy gate is open, so that its idle timer sweeps the journal. */
  async function sweeping(env: Record<string, string>) {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
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
