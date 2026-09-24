/**
 * Host-persist lineage reconciliation — regression tests for the
 * 'Host independent threads' persistence cluster:
 *
 *  (a) `saveChatThroughHost` skipped the admitted path's stale-revision
 *      transcript merge, so a writer holding an older whole record persisted a
 *      regressed row set stamped revision+1 (the live truncation hole). The
 *      merge is ported 1:1 — and it must NOT be a naive union, or intentionally
 *      wiped lane cards would revive.
 *  (b) `readChatRecordCached` adopted the on-disk Host file over the optimistic
 *      shadow on revision alone; a Host-lineage record missing transcript rows
 *      re-anchored the cache to the regression.
 *  (c) `releaseHostPersistShadow` re-anchored the shadow DOWNWARD without
 *      reseeding renderer targets, which then dropped every broadcast as stale.
 *  (d) `recoverHostPersistConflict`'s last-resort fallback discarded Host-native
 *      transcript rows when the three-way rebase could not be computed.
 *  (e) A deferred >=4MB compatibility checkpoint was DROPPED when the write
 *      gate was held at fire time; it now re-arms within a bound.
 *  (f) `persistChatComposerSelection` parked on the write gate with no
 *      rejection behind a minutes-long recovery hold while the renderer's
 *      write-claim lease is 15 s — the picker selection silently reverted.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HostThreadRecordPersistInput,
  HostThreadRecordPersistPort
} from '../host/HostThreadRecordPersistCommand'
import { buildThreadMessageTranscriptProjection } from '../ThreadMessageTranscriptProjection'
import { THREAD_MESSAGE_SCHEMA_VERSION, type ThreadMessageEvent } from '../../shared/threadMessage'
import {
  DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
  DeferredHostMaterialization
} from './hostChatCompatibilityDeferral'
import {
  ThreadCatalogueBusyError,
  ThreadCatalogueWriteGate
} from '../../host-shared/thread-catalogue/ThreadCatalogueWriteGate'
import type { ChatComposerSelectionPatchRequest } from '../../shared/chatComposerSelectionPatch'
import type { ChatMessage, ChatRecord } from './types'

const profiles: string[] = []

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

interface WiredStore {
  AppStore: typeof import('./index').AppStore
  profilePath: string
  enqueued: HostThreadRecordPersistInput[]
  persistPort: HostThreadRecordPersistPort & {
    enqueue: ReturnType<typeof vi.fn>
    drain: ReturnType<typeof vi.fn>
    drainAll: ReturnType<typeof vi.fn>
  }
  threadCatalogueWriteGate: import('../../host-shared/thread-catalogue/ThreadCatalogueWriteGate').ThreadCatalogueWriteGate
  HostThreadRecordPersistError: typeof import('../host/HostThreadRecordPersistCommand').HostThreadRecordPersistError
}

/**
 * Store wired to a fake Host persist port with the legacy writer gate
 * Host-owned (so saves route through `saveChatThroughHost`). Everything the
 * store touches by module singleton is imported AFTER `vi.resetModules` so the
 * test and the store share one module registry (gate instance, error class for
 * `instanceof`).
 */
async function importStoreWithHostOwnedGate(): Promise<WiredStore> {
  const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-host-lineage-reconcile-'))
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
  const { AppStore } = await import('./index')
  const { legacyStoreWriterGate } = await import('./LegacyStoreWriterGate')
  if (!legacyStoreWriterGate.beginDrain()) throw new Error('test gate did not begin draining')
  const owned = legacyStoreWriterGate.markHostOwned({
    hostId: 'test-host',
    generation: 1,
    cutoverId: 'test-cutover'
  })
  if (!owned) throw new Error('test gate did not become host-owned')
  const enqueued: HostThreadRecordPersistInput[] = []
  const persistPort: WiredStore['persistPort'] = {
    persist: vi.fn(),
    enqueue: vi.fn((input: HostThreadRecordPersistInput) => {
      enqueued.push(input)
    }),
    drain: vi.fn(async () => {}),
    drainAll: vi.fn(async () => {}),
    pending: vi.fn(() => 0)
  }
  AppStore.setHostThreadRecordPersistPortForTests(persistPort)
  const { threadCatalogueWriteGate } =
    await import('../../host-shared/thread-catalogue/ThreadCatalogueWriteGate')
  const { HostThreadRecordPersistError } = await import('../host/HostThreadRecordPersistCommand')
  return {
    AppStore,
    profilePath,
    enqueued,
    persistPort,
    threadCatalogueWriteGate,
    HostThreadRecordPersistError
  }
}

function message(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, timestamp: '2026-09-01T00:00:00.000Z' }
}

/** A main-appended peer thread-message row: the ONLY shape the stale-revision merge re-adds. */
function threadMessageProjection(id: string): ChatMessage {
  const event: ThreadMessageEvent = {
    id,
    schemaVersion: THREAD_MESSAGE_SCHEMA_VERSION,
    fromChatId: 'peer-chat',
    fromChatTitle: 'Peer',
    toChatId: 'target-chat',
    origin: 'agent',
    body: `peer note ${id}`,
    requestedDelivery: 'queue',
    createdAt: Date.parse('2026-09-01T00:00:05.000Z'),
    trust: 'untrusted-thread-message'
  }
  return buildThreadMessageTranscriptProjection(event)
}

/** A fan-out lane card: a tool row that is NOT a thread-message projection. */
function laneCard(id: string): ChatMessage {
  return {
    id,
    role: 'tool',
    content: 'lane result',
    timestamp: '2026-09-01T00:00:06.000Z',
    metadata: { kind: 'ensemble_lane_result', laneId: 'lane-1' }
  }
}

function durableChat(chatId: string, revision: number, messages: ChatMessage[]): ChatRecord {
  return {
    appChatId: chatId,
    provider: 'codex',
    title: 'Lineage chat',
    scope: 'global',
    chatKind: 'single',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: revision,
    archived: false,
    messages,
    runs: []
  }
}

function seedDurableChat(profilePath: string, chat: ChatRecord): void {
  const chatsDir = join(profilePath, 'chats')
  mkdirSync(chatsDir, { recursive: true, mode: 0o700 })
  const chatPath = join(chatsDir, `${chat.appChatId}.json`)
  writeFileSync(chatPath, JSON.stringify(chat))
  chmodSync(chatPath, 0o600)
}

function overwriteHostRecord(profilePath: string, chat: ChatRecord): void {
  seedDurableChat(profilePath, chat)
}

describe('(a) stale-revision whole-record saves through the Host path', () => {
  it('merges main-appended thread-message projections into a revision-stale save without reviving wiped lane cards', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-stale-merge'
    const projection = threadMessageProjection('tm-1')
    const wipedLaneCard = laneCard('lane-card-1')
    // The durable record advanced to rev 4 carrying BOTH a peer projection and
    // a lane card the stale writer never saw; the lane card was then
    // deliberately wiped by the stale writer's own older copy... it simply
    // never had either row.
    seedDurableChat(
      profilePath,
      durableChat(chatId, 4, [
        message('m1', 'user', 'First'),
        message('m2', 'assistant', 'Second'),
        projection,
        wipedLaneCard
      ])
    )

    // A writer holding a rev-3 whole record (renderer debounce fallback,
    // orchestrator flush tail composed from a pre-mutation getChat).
    const stale = durableChat(chatId, 3, [
      message('m1', 'user', 'First'),
      message('m2', 'assistant', 'Second')
    ])
    const saved = AppStore.saveChat(stale)

    // The projection is preserved; the non-projection lane card is NOT revived.
    expect(saved.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', projection.id])
    expect(saved.persistenceRevision).toBe(5)
    expect(enqueued).toHaveLength(1)
    expect((enqueued[0].record as ChatRecord).messages.map((entry) => entry.id)).toEqual([
      'm1',
      'm2',
      projection.id
    ])
  })

  it('keeps a current-revision save authoritative, including projection deletion', async () => {
    const { AppStore, profilePath } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-current-wipe'
    const projection = threadMessageProjection('tm-2')
    seedDurableChat(
      profilePath,
      durableChat(chatId, 4, [
        message('m1', 'user', 'First'),
        message('m2', 'assistant', 'Second'),
        projection
      ])
    )

    // Same revision as the durable record: a deliberate wipe, not staleness.
    const current = durableChat(chatId, 4, [
      message('m1', 'user', 'First'),
      message('m2', 'assistant', 'Second')
    ])
    const saved = AppStore.saveChat(current)

    expect(saved.messages.map((entry) => entry.id)).toEqual(['m1', 'm2'])
    expect(saved.persistenceRevision).toBe(5)
  })
})

describe('(b) shadow reconcile against the Host file', () => {
  it('does not re-anchor the optimistic shadow to a Host record missing transcript rows', async () => {
    const { AppStore, profilePath } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-shadow-coverage'
    seedDurableChat(
      profilePath,
      durableChat(chatId, 3, [message('m1', 'user', 'First'), message('m2', 'assistant', 'Second')])
    )
    const saved = AppStore.saveChat(
      durableChat(chatId, 3, [
        message('m1', 'user', 'First'),
        message('m2', 'assistant', 'Second'),
        message('m3', 'assistant', 'New row')
      ])
    )
    expect(saved.persistenceRevision).toBe(4)

    // The Host lands a regressed lineage: revision AHEAD of the shadow but
    // missing the row the shadow carries (the stale-save hole, Host-side).
    overwriteHostRecord(
      profilePath,
      durableChat(chatId, 5, [message('m1', 'user', 'First'), message('m2', 'assistant', 'Second')])
    )

    const read = AppStore.getChat(chatId)
    expect(read?.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('still heals the shadow once the Host record covers the shadow transcript', async () => {
    const { AppStore, profilePath } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-shadow-heals'
    seedDurableChat(
      profilePath,
      durableChat(chatId, 3, [message('m1', 'user', 'First'), message('m2', 'assistant', 'Second')])
    )
    AppStore.saveChat(
      durableChat(chatId, 3, [
        message('m1', 'user', 'First'),
        message('m2', 'assistant', 'Second'),
        message('m3', 'assistant', 'New row')
      ])
    )

    // A healthy Host lineage: ahead on revision AND carrying every shadow row,
    // plus its own Host-native append (solo run lifecycle, catalogue refresh).
    overwriteHostRecord(
      profilePath,
      durableChat(chatId, 5, [
        message('m1', 'user', 'First'),
        message('m2', 'assistant', 'Second'),
        message('m3', 'assistant', 'New row'),
        message('m4-host', 'assistant', 'Host-native row')
      ])
    )

    const read = AppStore.getChat(chatId)
    expect(read?.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3', 'm4-host'])
    expect(read?.persistenceRevision).toBe(5)
  })
})

describe('(c) releaseHostPersistShadow', () => {
  it('reseeds renderer targets with the re-anchored revision after an unresolved conflict', async () => {
    const { AppStore, profilePath, persistPort, HostThreadRecordPersistError } =
      await importStoreWithHostOwnedGate()
    const chatId = 'chat-shadow-release'
    seedDurableChat(
      profilePath,
      durableChat(chatId, 3, [message('m1', 'user', 'First'), message('m2', 'assistant', 'Second')])
    )
    const saved = AppStore.saveChat({
      ...durableChat(chatId, 3, [
        message('m1', 'user', 'First'),
        message('m2', 'assistant', 'Second')
      ]),
      title: 'Renamed'
    })
    expect(saved.persistenceRevision).toBe(4)

    // Every Host drain conflicts; the barrier exhausts its rebase retries and
    // re-anchors the shadow down to the Host's revision.
    persistPort.drain.mockImplementation(() =>
      Promise.reject(new HostThreadRecordPersistError('revision_conflict', 'cas mismatch'))
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reseeds: ChatRecord[] = []
    AppStore.setHostPersistConflictRecoveryListener((chat) => reseeds.push(chat))
    try {
      await AppStore.awaitChatRecordPersisted(chatId)
    } finally {
      AppStore.setHostPersistConflictRecoveryListener(null)
      errorSpy.mockRestore()
    }

    // Each recovery attempt reseeds the rebased rev-4 record; the final
    // release must reseed AGAIN with the re-anchored rev-3 record, or renderer
    // targets keep the optimistic watermark and silently drop every later
    // broadcast as stale (the freeze-then-jump transcript).
    expect(reseeds.length).toBeGreaterThan(0)
    expect(reseeds[reseeds.length - 1].persistenceRevision).toBe(3)
    expect(AppStore.getChat(chatId)?.persistenceRevision).toBe(3)
  })
})

describe('(d) recoverHostPersistConflict last-resort fallback', () => {
  function conflictError(
    HostThreadRecordPersistError: WiredStore['HostThreadRecordPersistError']
  ): InstanceType<WiredStore['HostThreadRecordPersistError']> {
    return new HostThreadRecordPersistError('revision_conflict', 'cas mismatch')
  }

  it('unions Host-native transcript rows into the forced fallback instead of discarding them', async () => {
    const { AppStore, profilePath, HostThreadRecordPersistError } =
      await importStoreWithHostOwnedGate()
    const chatId = 'chat-fallback-union'
    seedDurableChat(
      profilePath,
      durableChat(chatId, 3, [message('m1', 'user', 'First'), message('m2', 'assistant', 'Second')])
    )
    // Desktop intent: append msg-x (rev 4). Establishes the rebase lineage.
    const desired = AppStore.saveChat(
      durableChat(chatId, 3, [
        message('m1', 'user', 'First'),
        message('m2', 'assistant', 'Second'),
        message('msg-x', 'assistant', 'Desktop row')
      ])
    )
    expect(desired.persistenceRevision).toBe(4)

    // The Host lineage advanced independently: it appended a DIFFERENT row
    // under the same id (forces the rebase to throw 'added independently') and
    // a Host-native row the Desktop base never saw.
    overwriteHostRecord(
      profilePath,
      durableChat(chatId, 5, [
        message('m1', 'user', 'First'),
        message('m2', 'assistant', 'Second'),
        message('msg-x', 'assistant', 'Host twin'),
        message('msg-host', 'assistant', 'Host-native row')
      ])
    )

    const recovered = AppStore.recoverHostPersistConflict(
      { chatId, record: desired, expectedRevision: 3 },
      conflictError(HostThreadRecordPersistError)
    )
    expect(recovered).not.toBeNull()
    const record = recovered!.record as ChatRecord
    expect(record.persistenceRevision).toBe(6)
    // Desktop's msg-x wins the id collision; the Host-native row survives.
    expect(record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'msg-x', 'msg-host'])
    expect(record.messages.find((entry) => entry.id === 'msg-x')?.content).toBe('Desktop row')
  })

  it('keeps Desktop tombstones in the fallback — wiped rows are not revived', async () => {
    const { AppStore, profilePath, HostThreadRecordPersistError } =
      await importStoreWithHostOwnedGate()
    const chatId = 'chat-fallback-tombstone'
    seedDurableChat(
      profilePath,
      durableChat(chatId, 3, [message('m1', 'user', 'First'), message('m2', 'assistant', 'Second')])
    )
    // Desktop intent: wipe m2 AND append msg-x (rev 4).
    const desired = AppStore.saveChat(
      durableChat(chatId, 3, [
        message('m1', 'user', 'First'),
        message('msg-x', 'assistant', 'Desktop row')
      ])
    )
    expect(desired.persistenceRevision).toBe(4)

    overwriteHostRecord(
      profilePath,
      durableChat(chatId, 5, [
        message('m1', 'user', 'First'),
        message('m2', 'assistant', 'Second'),
        message('msg-x', 'assistant', 'Host twin'),
        message('msg-host', 'assistant', 'Host-native row')
      ])
    )

    const recovered = AppStore.recoverHostPersistConflict(
      { chatId, record: desired, expectedRevision: 3 },
      conflictError(HostThreadRecordPersistError)
    )
    expect(recovered).not.toBeNull()
    const record = recovered!.record as ChatRecord
    // m2 stays wiped (Desktop tombstone) even though the Host lineage carries
    // it; the Host-native row still survives.
    expect(record.messages.map((entry) => entry.id)).toEqual(['m1', 'msg-x', 'msg-host'])
  })
})

describe('(e) DeferredHostMaterialization re-arm', () => {
  interface FakeTimer {
    callback: () => void
    delayMs: number
    cleared: boolean
  }

  function rearmHarness(options: { maxRetries?: number } = {}) {
    const timers: FakeTimer[] = []
    const state = { blocked: true }
    let materializeCalls = 0
    const deferral = new DeferredHostMaterialization({
      materialize: () => {
        materializeCalls += 1
        return !state.blocked
      },
      isDeleted: () => false,
      retryWhen: () => state.blocked,
      delayMs: 7,
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      setTimer: (callback, delayMs) => {
        const timer: FakeTimer = { callback, delayMs, cleared: false }
        timers.push(timer)
        return timer as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: (timer) => {
        ;(timer as unknown as FakeTimer).cleared = true
      }
    })
    const schedule = (): boolean =>
      deferral.schedule('chat-a', {
        existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
        flushReason: 'terminal',
        durabilityFallback: false
      })
    return {
      deferral,
      timers,
      state,
      schedule,
      materializeCalls: () => materializeCalls
    }
  }

  it('re-arms a fired checkpoint while the retry predicate holds, then lands it', () => {
    const { deferral, timers, state, schedule, materializeCalls } = rearmHarness()
    expect(schedule()).toBe(true)
    expect(timers).toHaveLength(1)

    // The gate is held at fire time: re-arm, do not drop.
    timers[0].callback()
    expect(materializeCalls()).toBe(1)
    expect(deferral.pendingChatIds).toEqual(['chat-a'])
    expect(timers).toHaveLength(2)

    // The hold clears before the next fire: the checkpoint lands.
    state.blocked = false
    timers[1].callback()
    expect(materializeCalls()).toBe(2)
    expect(deferral.pendingChatIds).toEqual([])
    expect(timers).toHaveLength(2)
  })

  it('stops re-arming at the retry bound', () => {
    const { deferral, timers, schedule, materializeCalls } = rearmHarness({ maxRetries: 2 })
    expect(schedule()).toBe(true)
    timers[0].callback() // attempt 0 blocked -> re-arm 1
    timers[1].callback() // attempt 1 blocked -> re-arm 2
    expect(deferral.pendingChatIds).toEqual(['chat-a'])
    timers[2].callback() // attempt 2 blocked -> bound reached, drop
    expect(materializeCalls()).toBe(3)
    expect(deferral.pendingChatIds).toEqual([])
    expect(timers).toHaveLength(3)
  })

  it('drops a false return when no retry predicate is wired, exactly as before', () => {
    const timers: FakeTimer[] = []
    let materializeCalls = 0
    const deferral = new DeferredHostMaterialization({
      materialize: () => {
        materializeCalls += 1
        return false
      },
      isDeleted: () => false,
      delayMs: 7,
      setTimer: (callback, delayMs) => {
        const timer: FakeTimer = { callback, delayMs, cleared: false }
        timers.push(timer)
        return timer as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {}
    })
    deferral.schedule('chat-a', {
      existingBytes: DEFERRED_HOST_MATERIALIZE_MIN_BYTES,
      flushReason: 'terminal',
      durabilityFallback: false
    })
    timers[0].callback()
    expect(materializeCalls).toBe(1)
    expect(deferral.pendingChatIds).toEqual([])
    expect(timers).toHaveLength(1)
  })
})

describe('(f) ThreadCatalogueWriteGate.admitBounded', () => {
  it('runs work immediately when the gate is free', async () => {
    const gate = new ThreadCatalogueWriteGate()
    await expect(gate.admitBounded('chat-free', 50, async () => 'done')).resolves.toBe('done')
  })

  it('waits out a hold released inside the budget', async () => {
    vi.useFakeTimers()
    try {
      const gate = new ThreadCatalogueWriteGate()
      const release = gate.hold('chat-held')
      if (!release) throw new Error('gate was not held')
      const admitted = gate.admitBounded('chat-held', 1_000, async () => 'done')
      await vi.advanceTimersByTimeAsync(500)
      release()
      await expect(admitted).resolves.toBe('done')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects with ThreadCatalogueBusyError when the hold outlasts the budget', async () => {
    vi.useFakeTimers()
    try {
      const gate = new ThreadCatalogueWriteGate()
      const release = gate.hold('chat-stuck')
      if (!release) throw new Error('gate was not held')
      const admitted = gate.admitBounded('chat-stuck', 100, async () => 'done')
      const expectation = expect(admitted).rejects.toBeInstanceOf(ThreadCatalogueBusyError)
      await vi.advanceTimersByTimeAsync(150)
      await expectation
      release()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds only the hold wait, never the admitted work', async () => {
    vi.useFakeTimers()
    try {
      const gate = new ThreadCatalogueWriteGate()
      const admitted = gate.admitBounded('chat-slow-work', 50, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 200))
        return 'done'
      })
      await vi.advanceTimersByTimeAsync(500)
      await expect(admitted).resolves.toBe('done')
    } finally {
      vi.useRealTimers()
    }
  })

  it('persistChatComposerSelection fails visibly inside the renderer claim window when the gate is held', async () => {
    const { AppStore, threadCatalogueWriteGate } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-picker-gated'
    const release = threadCatalogueWriteGate.hold(chatId)
    if (!release) throw new Error('gate was not held')
    vi.useFakeTimers()
    try {
      const request: ChatComposerSelectionPatchRequest = {
        chatId,
        patch: { selectedModelType: 'default' },
        provider: 'codex',
        deferProviderScoped: false
      }
      const attempt = AppStore.persistChatComposerSelection(request)
      // The store runs in the post-reset module registry, so its
      // ThreadCatalogueBusyError is a different class object than the static
      // import above — assert the contract (name + message), not instanceof.
      const settled = attempt.then(
        () => {
          throw new Error('expected the gated persist to reject')
        },
        (error: unknown) => error as Error
      )
      // The renderer claim lease is 15 s; the main-side budget is 10 s.
      await vi.advanceTimersByTimeAsync(10_100)
      const error = await settled
      expect(error.name).toBe('ThreadCatalogueBusyError')
      expect(error.message).toMatch(/history update in progress/)
    } finally {
      release()
      vi.useRealTimers()
    }
  })
})
