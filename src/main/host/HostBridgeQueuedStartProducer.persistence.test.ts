import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { createHostProjectionSerialQueue } from '../../host-runtime/HostProjectionSerialQueue'
import { MainSourceProbe } from '../mainSourceProbe.testutil'
import type { IncrementalChatJournalOptions } from '../store/IncrementalChatJournal'
import type { ChatRecord } from '../store/types'
import { createHostBridgeQueuedStartAdapter } from './HostBridgeQueuedStartAdapter'
import {
  createHostBridgeQueuedStartProducer,
  verifyHostBridgeQueuedStartRecord,
  type HostBridgeQueuedStartIdentity
} from './HostBridgeQueuedStartProducer'
import type { HostThreadRecordPersistPort } from './HostThreadRecordPersistCommand'

// This file proves a queued start waiting on the journal's own fsync and the
// catalogue hold: the path the store takes with barrier durability off.
// Barrier durability is on by default and the store reads its switch once, at
// load, so it is pinned off here with the exact token `0` before anything
// imports the store. A queued start's barrier under the switch is proven in
// store/ThreadBarrierDurability.integration.test.ts.
vi.hoisted(() => {
  vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '0')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

const journalFsyncs = vi.hoisted(
  () => [] as { fd: number; done: (error?: NodeJS.ErrnoException | null) => void }[]
)

// Keep the real journal's writes, replay, and durability waiters. Its existing
// scheduler seam lets the tests acknowledge actual fsyncs at a controlled edge.
vi.mock('../store/IncrementalChatJournal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/IncrementalChatJournal')>()
  return {
    ...actual,
    createIncrementalChatJournal: (
      directory: string,
      options: IncrementalChatJournalOptions = {}
    ) =>
      actual.createIncrementalChatJournal(directory, {
        ...options,
        scheduleFsync: (fd, done) => {
          journalFsyncs.push({ fd, done })
        }
      })
  }
})

const COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const ACTION_ID = `host:command:${COMMAND_ID}` as const
const profiles: string[] = []
const cleanups: (() => Promise<void>)[] = []

function finishJournalFsyncs(): void {
  for (let entry = journalFsyncs.shift(); entry; entry = journalFsyncs.shift()) {
    fsyncSync(entry.fd)
    entry.done(null)
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  finishJournalFsyncs()
  vi.restoreAllMocks()
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

async function importStore(historyEnabled = true) {
  const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-queued-start-persistence-'))
  profiles.push(profilePath)
  vi.resetModules()
  const { configureHostStoreRuntime, resetHostStoreRuntimeForTests } =
    await import('../../host-runtime/HostStoreRuntime')
  resetHostStoreRuntimeForTests()
  configureHostStoreRuntime({
    profilePath,
    secureStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`node:${plain}`, 'utf8'),
      decryptString: (encrypted) => encrypted.toString('utf8').replace(/^node:/, '')
    }
  })
  const { AppStore } = await import('../store/index')
  AppStore.updateSettings({ storeLocalChatHistory: historyEnabled })
  const { legacyStoreWriterGate } = await import('../store/LegacyStoreWriterGate')
  expect(legacyStoreWriterGate.beginDrain()).toBe(true)
  expect(
    legacyStoreWriterGate.markHostOwned({
      hostId: 'test-host',
      generation: 1,
      cutoverId: 'test-cutover'
    })
  ).toBe(true)
  const persistPort = {
    persist: vi.fn<HostThreadRecordPersistPort['persist']>(),
    enqueue: vi.fn<HostThreadRecordPersistPort['enqueue']>(),
    drain: vi.fn<HostThreadRecordPersistPort['drain']>(async () => {
      throw new Error('Dispatch proof must not recursively drain Host compatibility writes')
    }),
    drainAll: vi.fn<HostThreadRecordPersistPort['drainAll']>(async () => {
      throw new Error('Dispatch proof must not recursively drain all Host writes')
    }),
    pending: vi.fn(() => 0)
  } satisfies HostThreadRecordPersistPort
  AppStore.setHostThreadRecordPersistPortForTests(persistPort)
  const { threadCatalogueWriteGate } = await import('../store/ThreadCatalogueWriteGate')
  const dispatchBarrier = vi.spyOn(AppStore, 'awaitChatRecordDispatchDurable')
  const fullPersistBarrier = vi.spyOn(AppStore, 'awaitChatRecordPersisted')
  return {
    AppStore,
    profilePath,
    persistPort,
    threadCatalogueWriteGate,
    dispatchBarrier,
    fullPersistBarrier
  }
}

function seedEmptyChat(profilePath: string, threadId: string): void {
  const chat: ChatRecord = {
    appChatId: threadId,
    provider: 'codex',
    title: 'Queued start persistence',
    scope: 'global',
    chatKind: 'single',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: 1,
    archived: false,
    messages: [],
    runs: []
  }
  const chatsDir = join(profilePath, 'chats')
  mkdirSync(chatsDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(chatsDir, `${threadId}.json`), JSON.stringify(chat), { mode: 0o600 })
}

function savePromptAndStart(
  store: Awaited<ReturnType<typeof importStore>>,
  identity: HostBridgeQueuedStartIdentity
): ChatRecord {
  seedEmptyChat(store.profilePath, identity.threadId)
  const before = store.AppStore.getChat(identity.threadId)
  if (!before) throw new Error('Expected the seeded AppStore chat')
  expect(before.messages).toEqual([])
  expect(before.runs).toEqual([])
  return store.AppStore.saveChat({
    ...before,
    messages: [
      {
        id: identity.promptMessageId,
        role: 'user',
        content: 'Save this prompt before acknowledging the start.',
        timestamp: '2026-09-24T00:00:00.000Z',
        runId: identity.runId
      }
    ],
    runs: [
      {
        runId: identity.runId,
        provider: identity.provider,
        promptMessageId: identity.promptMessageId,
        startedAt: '2026-09-24T00:00:00.000Z',
        status: 'running'
      }
    ]
  })
}

function bindProducer(store: Awaited<ReturnType<typeof importStore>>) {
  const producer = createHostBridgeQueuedStartProducer({
    persistenceEnabled: () => store.AppStore.getSettings().storeLocalChatHistory,
    // As the app wires it.
    awaitPromptAndStartDurable: (identity) =>
      store.AppStore.awaitChatRecordStartDurable(identity.threadId),
    verifyPromptAndStart: (identity) =>
      verifyHostBridgeQueuedStartRecord(store.AppStore.getChat(identity.threadId), identity)
  })
  const adapter = createHostBridgeQueuedStartAdapter({
    runProjectionOperation: createHostProjectionSerialQueue()
  })
  const prepared = vi.spyOn(adapter, 'prepared')
  const settled = vi.spyOn(adapter, 'settled')
  const abort = vi.fn<(commandId: string) => void>()
  producer.onAdapter(adapter, abort)
  cleanups.push(async () => {
    producer.beginShutdown()
    await producer.drain()
    await adapter.drain()
  })
  return { producer, adapter, prepared, settled, abort }
}

function register(
  adapter: ReturnType<typeof createHostBridgeQueuedStartAdapter>,
  identity: HostBridgeQueuedStartIdentity
): void {
  adapter.register({
    hostCommandActionId: identity.hostCommandActionId,
    threadId: identity.threadId,
    authority: {
      actorId: 'actor-a',
      clientId: 'client-a',
      clientClass: 'desktop',
      commandFingerprint: 'fingerprint-a'
    }
  })
}

describe('HostBridgeQueuedStartProducer with real AppStore persistence', () => {
  it.each([
    { mode: 'direct run ID', queueId: undefined, firstRelease: 'catalogue' },
    { mode: 'supplied queue ID', queueId: 'reserved-queue-run', firstRelease: 'journal' }
  ] as const)(
    'waits for both real journal fsync and catalogue hold with $mode',
    async ({ queueId, firstRelease }) => {
      const store = await importStore()
      const identity: HostBridgeQueuedStartIdentity = {
        hostCommandActionId: ACTION_ID,
        threadId: 'queued-start-thread',
        runId: queueId ?? 'direct-run',
        promptMessageId: 'new-user-prompt',
        provider: 'codex'
      }
      const saved = savePromptAndStart(store, identity)
      expect(
        verifyHostBridgeQueuedStartRecord(store.AppStore.getChat(identity.threadId), identity)
      ).toBe(true)
      // User rows and run transitions fsync synchronously (D2). Stage a later
      // metadata mutation (D1) so the real dispatch barrier has work to await.
      expect(journalFsyncs).toHaveLength(0)
      store.AppStore.saveChat({ ...saved, title: 'Metadata staged after the prompt and start' })
      expect(journalFsyncs).toHaveLength(1)
      expect(store.persistPort.enqueue).not.toHaveBeenCalled()

      const h = bindProducer(store)
      register(h.adapter, identity)
      if (queueId) {
        await h.adapter.queued({
          kind: 'queued',
          hostCommandActionId: ACTION_ID,
          threadId: identity.threadId,
          queueId,
          reservedRunId: queueId
        })
      }
      const releaseCatalogue = store.threadCatalogueWriteGate.hold(identity.threadId)
      if (!releaseCatalogue) throw new Error('Expected to hold the chat catalogue')
      cleanups.push(async () => releaseCatalogue())
      const observation = h.producer.observeDispatch(identity)
      if (!observation) throw new Error('Expected a registered Host dispatch observation')
      observation.observer.onAdapterInvoked?.({ provider: 'codex', appRunId: identity.runId })
      await nextTurn()
      expect(store.dispatchBarrier).toHaveBeenCalledWith(identity.threadId)
      expect(h.prepared).not.toHaveBeenCalled()

      if (firstRelease === 'catalogue') releaseCatalogue()
      else finishJournalFsyncs()
      await nextTurn()
      expect(h.prepared).not.toHaveBeenCalled()
      expect(h.abort).not.toHaveBeenCalled()
      if (firstRelease === 'catalogue') {
        expect(journalFsyncs).toHaveLength(1)
        finishJournalFsyncs()
      } else {
        expect(store.threadCatalogueWriteGate.isHeld(identity.threadId)).toBe(true)
        releaseCatalogue()
      }
      await h.producer.drain()

      expect(h.prepared).toHaveBeenCalledExactlyOnceWith({
        kind: 'prepared',
        hostCommandActionId: ACTION_ID,
        threadId: identity.threadId,
        durablePromptAndStartPersisted: true,
        start: { kind: 'solo', runId: identity.runId },
        effectRefs: [
          { family: 'thread', entityId: identity.threadId },
          { family: 'run', entityId: identity.runId }
        ]
      })
      expect(h.adapter.get(ACTION_ID)).toMatchObject({
        phase: 'prepared',
        prepared: { start: { kind: 'solo', runId: identity.runId } },
        ...(queueId ? { queued: { queueId, reservedRunId: queueId } } : {})
      })
      expect(h.abort).not.toHaveBeenCalled()
      expect(h.settled).not.toHaveBeenCalled()
      expect(store.fullPersistBarrier).not.toHaveBeenCalled()
      expect(store.persistPort.drain).not.toHaveBeenCalled()
      expect(store.persistPort.drainAll).not.toHaveBeenCalled()
      expect(store.persistPort.enqueue).not.toHaveBeenCalled()

      const { createIncrementalChatJournal } = await import('../store/IncrementalChatJournal')
      const reopened = createIncrementalChatJournal(join(store.profilePath, 'chat-journal-v2'), {
        canWrite: () => false,
        canRepairOnRead: () => false
      }).replay(identity.threadId)
      expect(verifyHostBridgeQueuedStartRecord(reopened.record, identity)).toBe(true)
      expect(reopened.record?.runs?.[0].status).toBe('running')
      expect(reopened.record?.title).toBe('Metadata staged after the prompt and start')
    }
  )

  it.each(['acknowledged', 'host_unavailable', 'revision_conflict'] as const)(
    'keeps a journal failure unproven until its fallback Host write is %s',
    async (outcome) => {
      const store = await importStore()
      const identity: HostBridgeQueuedStartIdentity = {
        hostCommandActionId: ACTION_ID,
        threadId: 'fallback-thread',
        runId: 'fallback-run',
        promptMessageId: 'fallback-prompt',
        provider: 'codex'
      }
      // A real filesystem error forces the save onto its only remaining
      // durability path. Do not replace AppStore's journal or fallback barrier.
      mkdirSync(
        join(store.profilePath, 'chat-journal-v2', `${identity.threadId}.mutations.jsonl`),
        { recursive: true }
      )
      let finish!: (error?: Error) => void
      const acknowledgement = new Promise<void>((resolve, reject) => {
        finish = (error) => (error ? reject(error) : resolve())
      })
      store.persistPort.drain.mockImplementation(() => acknowledgement)
      cleanups.push(async () => finish())
      vi.spyOn(console, 'error').mockImplementation(() => {})
      savePromptAndStart(store, identity)
      expect(store.persistPort.enqueue).toHaveBeenCalledOnce()
      const [pending] = store.persistPort.enqueue.mock.calls[0]
      expect(verifyHostBridgeQueuedStartRecord(pending.record, identity)).toBe(true)
      expect(
        verifyHostBridgeQueuedStartRecord(store.AppStore.getChat(identity.threadId), identity)
      ).toBe(true)

      const h = bindProducer(store)
      register(h.adapter, identity)
      const observation = h.producer.observeDispatch(identity)
      if (!observation) throw new Error('Expected a registered Host dispatch observation')
      observation.observer.onAdapterInvoked?.({ provider: 'codex', appRunId: identity.runId })
      await nextTurn()
      expect(store.persistPort.drain).toHaveBeenCalledExactlyOnceWith(identity.threadId)
      expect(h.prepared).not.toHaveBeenCalled()
      expect(h.abort).not.toHaveBeenCalled()
      const chatPath = join(store.profilePath, 'chats', `${identity.threadId}.json`)
      expect(
        verifyHostBridgeQueuedStartRecord(JSON.parse(readFileSync(chatPath, 'utf8')), identity)
      ).toBe(false)

      if (outcome === 'acknowledged') {
        // The Host test port acknowledges only after its exact pending record
        // has landed on disk; the producer still consumes the real Store barrier.
        writeFileSync(chatPath, JSON.stringify(pending.record))
        const fd = openSync(chatPath, 'r+')
        try {
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        finish()
      } else {
        const { HostThreadRecordPersistError } = await import('./HostThreadRecordPersistCommand')
        finish(new HostThreadRecordPersistError(outcome, 'Fallback write did not land'))
      }
      await h.producer.drain()

      if (outcome === 'acknowledged') {
        expect(h.prepared).toHaveBeenCalledOnce()
        expect(h.adapter.get(ACTION_ID)?.prepared?.start).toEqual({
          kind: 'solo',
          runId: identity.runId
        })
        expect(h.abort).not.toHaveBeenCalled()
      } else {
        expect(h.prepared).not.toHaveBeenCalled()
        expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
      }
      expect(h.settled).not.toHaveBeenCalled()
      expect(store.fullPersistBarrier).not.toHaveBeenCalled()
      expect(store.persistPort.drain).toHaveBeenCalledOnce()
      expect(store.persistPort.drainAll).not.toHaveBeenCalled()
    }
  )

  it('requests indeterminate abort when local history is off despite save returning the new rows', async () => {
    const store = await importStore(false)
    const identity: HostBridgeQueuedStartIdentity = {
      hostCommandActionId: ACTION_ID,
      threadId: 'history-off-thread',
      runId: 'history-off-run',
      promptMessageId: 'history-off-prompt',
      provider: 'codex'
    }
    const returned = savePromptAndStart(store, identity)
    expect(verifyHostBridgeQueuedStartRecord(returned, identity)).toBe(true)
    expect(store.AppStore.getSettings().storeLocalChatHistory).toBe(false)
    expect(
      verifyHostBridgeQueuedStartRecord(store.AppStore.getChat(identity.threadId), identity)
    ).toBe(false)
    const h = bindProducer(store)
    register(h.adapter, identity)
    const observation = h.producer.observeDispatch(identity)
    if (!observation) throw new Error('Expected a registered Host dispatch observation')
    observation.observer.onAdapterInvoked?.({ provider: 'codex', appRunId: identity.runId })
    await h.producer.drain()

    expect(h.abort).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(h.prepared).not.toHaveBeenCalled()
    expect(h.settled).not.toHaveBeenCalled()
    expect(store.dispatchBarrier).not.toHaveBeenCalled()
    expect(store.fullPersistBarrier).not.toHaveBeenCalled()
    expect(store.persistPort.enqueue).not.toHaveBeenCalled()
    expect(store.persistPort.drain).not.toHaveBeenCalled()
    expect(store.persistPort.drainAll).not.toHaveBeenCalled()
    expect(journalFsyncs).toHaveLength(0)
  })
})

describe('the producer as the app wires it', () => {
  const probe = new MainSourceProbe('index.ts', new URL('../index.ts', import.meta.url))

  it('claims a queued start durable only after the store has waited for its run row', () => {
    const [binding] = probe.callsTo(probe.source, 'createHostBridgeQueuedStartProducerBinding')
    expect(probe.propText(binding, 0, 'awaitPromptAndStartDurable')).toContain(
      'AppStore.awaitChatRecordStartDurable(threadId)'
    )
  })
})
