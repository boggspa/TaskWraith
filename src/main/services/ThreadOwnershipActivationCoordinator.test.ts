import { describe, expect, it, vi } from 'vitest'
import {
  HostThreadPublicationGuard,
  type HostThreadPublicationRegistry
} from '../../host-runtime/HostThreadPublicationGuard'
import type { ThreadOwnershipReservation } from '../../host-shared/thread-log/ThreadOwnership'
import {
  PerChatSaveIntentQueue,
  persistIdempotencyKeyFor,
  type ChatSaveIntent
} from '../../shared/chatSaveIntentQueue'
import {
  HostOwnershipReceiptEvidenceStore,
  type ReceiptEvidencePersistence,
  type ThreadOwnershipReceiptEvidence
} from '../host/HostOwnershipReceiptEvidenceStore'
import type { ChatRecord } from '../store/types'
import {
  createChatSaveOwnershipWiring,
  createHeadReceiptLookup,
  ThreadOwnershipActivationCoordinator,
  type ThreadOwnershipActivationOptions
} from './ThreadOwnershipActivationCoordinator'

const SHA = 'b'.repeat(64)
const CHAT = 'chat-1'

function intent(revision: number, chatId = CHAT): ChatSaveIntent {
  const commandId = `cmd-${revision}`
  return {
    chatId,
    record: {
      appChatId: chatId,
      title: 't',
      persistenceRevision: revision,
      messages: []
    } as never as ChatRecord,
    authoredAt: revision,
    commandId,
    idempotencyKey: persistIdempotencyKeyFor(commandId)
  }
}

const exact = (revision: number, chatId = CHAT, commandId = `host-${revision}`) =>
  ({ kind: 'exact', threadId: chatId, commandId, revision, sha256: SHA }) as const

function reservationFor(chatId: string, overrides: Partial<ThreadOwnershipReservation> = {}) {
  return {
    threadId: chatId,
    epoch: { host: 'host-1', grant: 1 },
    revalidate: vi.fn(),
    erasing: () => false,
    ...overrides
  } satisfies ThreadOwnershipReservation
}

interface Harness {
  readonly calls: string[]
  readonly queue: PerChatSaveIntentQueue
  readonly options: ThreadOwnershipActivationOptions
  readonly coordinator: ThreadOwnershipActivationCoordinator
  readonly reservation: ThreadOwnershipReservation
  /** What the Host receipt lookup answers, by intent handle. */
  readonly receipts: Map<string, ThreadOwnershipReceiptEvidence>
  readonly spies: {
    remove: ReturnType<typeof vi.fn>
    enable: ReturnType<typeof vi.fn>
    disable: ReturnType<typeof vi.fn>
    release: ReturnType<typeof vi.fn>
    record: ReturnType<typeof vi.fn>
    markWriter: ReturnType<typeof vi.fn>
    claim: ReturnType<typeof vi.fn>
    ownedAppend: ReturnType<typeof vi.fn>
  }
}

function harness(
  overrides: Partial<ThreadOwnershipActivationOptions> = {},
  setup: {
    queue?: PerChatSaveIntentQueue
    registry?: HostThreadPublicationRegistry | null
    confirm?: boolean
  } = {}
): Harness {
  const calls: string[] = []
  const queue = setup.queue ?? new PerChatSaveIntentQueue()
  const reservation = reservationFor(CHAT)
  const receipts = new Map<string, ThreadOwnershipReceiptEvidence>()
  if (setup.confirm !== false) receipts.set('cmd-3', exact(3))

  const spies = {
    remove: vi.fn(async () => {
      calls.push('remove-mark')
      return true
    }),
    enable: vi.fn(() => void calls.push('enable')),
    disable: vi.fn(() => void calls.push('disable')),
    release: vi.fn(async () => void calls.push('release')),
    record: vi.fn(async () => void calls.push('record')),
    markWriter: vi.fn(async () => void calls.push('mark')),
    claim: vi.fn(async () => {
      calls.push('claim')
      return reservation
    }),
    ownedAppend: vi.fn(async (item: ChatSaveIntent) => {
      calls.push(`append:${item.commandId}`)
      return {
        kind: 'exact',
        threadId: item.chatId,
        commandId: item.commandId,
        revision: item.record.persistenceRevision ?? 0,
        sha256: SHA
      } as ThreadOwnershipReceiptEvidence
    })
  }

  const options: ThreadOwnershipActivationOptions = {
    queue,
    registry: { claim: spies.claim, release: spies.release },
    publicationGuard: new HostThreadPublicationGuard(setup.registry ?? null),
    bindingFor: () => ({ owner: null, isCurrent: () => true }),
    authorityFile: { remove: spies.remove },
    markWriter: spies.markWriter,
    receiptStore: { record: spies.record },
    authoritySwitch: { enable: spies.enable, disable: spies.disable },
    commandHandleStore: {
      get(commandId) {
        calls.push('confirm')
        return receipts.get(commandId) ?? null
      }
    },
    ownedAppend: spies.ownedAppend,
    ...overrides
  }
  return {
    calls,
    queue,
    options,
    coordinator: new ThreadOwnershipActivationCoordinator(options),
    reservation,
    receipts,
    spies
  }
}

function seeded(overrides: Partial<ThreadOwnershipActivationOptions> = {}, setup = {}): Harness {
  const h = harness(overrides, setup)
  h.queue.enqueue(intent(3))
  return h
}

describe('ThreadOwnershipActivationCoordinator', () => {
  it('activates in order: freeze, confirm, claim, mark, switch, drain, record', async () => {
    const h = seeded()
    let frozenWhileConfirming = false
    const get = h.options.commandHandleStore.get
    ;(h.options.commandHandleStore as { get: typeof get }).get = (id) => {
      frozenWhileConfirming = h.queue.isFrozen(CHAT)
      return get(id)
    }
    const coordinator = new ThreadOwnershipActivationCoordinator(h.options)

    const result = await coordinator.activate(CHAT)

    expect(result).toEqual({ kind: 'activated', drained: 1, receiptFaults: 0 })
    expect(frozenWhileConfirming).toBe(true)
    expect(h.calls).toEqual(['confirm', 'claim', 'mark', 'enable', 'append:cmd-3', 'record'])
    expect(h.queue.isFrozen(CHAT)).toBe(false)
    expect(h.queue.peek(CHAT)).toEqual([])
    expect(coordinator.isActive(CHAT)).toBe(true)
    expect(h.spies.markWriter).toHaveBeenCalledWith(CHAT, h.reservation)
    expect(h.spies.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'exact', commandId: 'cmd-3', revision: 3 }),
      { chatId: CHAT, commandId: 'cmd-3' }
    )
    expect(h.reservation.revalidate).toHaveBeenCalled()
    expect(h.spies.remove).not.toHaveBeenCalled()
    expect(h.spies.disable).not.toHaveBeenCalled()
  })

  it('replays an intent that arrived while the head was frozen, keeping its handles', async () => {
    const h = seeded()
    const get = h.options.commandHandleStore.get
    ;(h.options.commandHandleStore as { get: typeof get }).get = (id) => {
      if (!h.queue.peek(CHAT).some((item) => item.commandId === 'cmd-4')) h.queue.enqueue(intent(4))
      return get(id)
    }
    const coordinator = new ThreadOwnershipActivationCoordinator(h.options)

    const result = await coordinator.activate(CHAT)

    expect(result).toMatchObject({ kind: 'activated', drained: 1 })
    const appended = h.spies.ownedAppend.mock.calls[0][0] as ChatSaveIntent
    expect(appended.commandId).toBe('cmd-4')
    expect(appended.supersedes?.map((handle) => handle.commandId)).toEqual(['cmd-3'])
  })

  it('already active: activate replays the queue on the same reservation', async () => {
    const h = seeded()
    await h.coordinator.activate(CHAT)
    h.queue.enqueue(intent(5))
    const again = await h.coordinator.activate(CHAT)
    expect(again).toMatchObject({ kind: 'activated', drained: 1 })
    expect(h.spies.claim).toHaveBeenCalledTimes(1)
    expect(h.spies.markWriter).toHaveBeenCalledTimes(1)
    expect(h.spies.ownedAppend.mock.calls[1][1]).toBe(h.reservation)
  })

  it('shares one attempt between concurrent callers', async () => {
    const h = seeded()
    const [a, b] = await Promise.all([h.coordinator.activate(CHAT), h.coordinator.activate(CHAT)])
    expect(a).toBe(b)
    expect(h.spies.claim).toHaveBeenCalledTimes(1)
  })

  describe('rollback', () => {
    it('mark_write_failed: removes the mark, never enables the switch, returns the intents', async () => {
      const h = seeded({
        markWriter: vi.fn(async () => {
          throw new Error('disk')
        })
      })
      const coordinator = new ThreadOwnershipActivationCoordinator(h.options)

      const result = await coordinator.activate(CHAT)

      expect(result).toMatchObject({ kind: 'failed', reason: 'mark_write_failed', faults: [] })
      if (result.kind !== 'failed') throw new Error('unreachable')
      expect(result.pending.map((item) => item.commandId)).toEqual(['cmd-3'])
      expect(result.ownershipRetained).toBe(false)
      expect(h.spies.remove).toHaveBeenCalledWith(CHAT)
      expect(h.spies.enable).not.toHaveBeenCalled()
      expect(h.spies.disable).not.toHaveBeenCalled()
      expect(h.spies.release).toHaveBeenCalledWith(h.reservation)
      expect(h.spies.ownedAppend).not.toHaveBeenCalled()
      expect(h.queue.peek(CHAT)).toEqual([])
      expect(h.queue.isFrozen(CHAT)).toBe(false)
      expect(coordinator.isActive(CHAT)).toBe(false)
    })

    it('switch_failed: removes the mark, switches off, returns the intents', async () => {
      const enable = vi.fn(() => {
        throw new Error('switch')
      })
      const h = seeded({ authoritySwitch: { enable, disable: vi.fn() } })
      const coordinator = new ThreadOwnershipActivationCoordinator(h.options)

      const result = await coordinator.activate(CHAT)

      expect(result).toMatchObject({ kind: 'failed', reason: 'switch_failed' })
      if (result.kind !== 'failed') throw new Error('unreachable')
      expect(result.pending.map((item) => item.commandId)).toEqual(['cmd-3'])
      expect(h.spies.remove).toHaveBeenCalledWith(CHAT)
      expect(h.options.authoritySwitch.disable).toHaveBeenCalledTimes(1)
      expect(h.spies.ownedAppend).not.toHaveBeenCalled()
      expect(coordinator.isActive(CHAT)).toBe(false)
    })

    it('drain_failed: removes the mark, switches off, returns the intents', async () => {
      const h = seeded()
      // The rejected append never reaches the logging implementation.
      h.spies.ownedAppend.mockRejectedValueOnce(new Error('journal'))

      const result = await h.coordinator.activate(CHAT)

      expect(result).toMatchObject({
        kind: 'failed',
        reason: 'drain_failed',
        ownershipRetained: false
      })
      if (result.kind !== 'failed') throw new Error('unreachable')
      expect(result.pending.map((item) => item.commandId)).toEqual(['cmd-3'])
      expect(h.calls).toEqual([
        'confirm',
        'claim',
        'mark',
        'enable',
        'remove-mark',
        'disable',
        'release'
      ])
      expect(h.queue.peek(CHAT)).toEqual([])
      expect(h.coordinator.isActive(CHAT)).toBe(false)
    })

    it('rejects owned-append evidence for another command', async () => {
      const h = seeded()
      h.spies.ownedAppend.mockResolvedValueOnce(exact(3, CHAT, 'someone-else'))
      const result = await h.coordinator.activate(CHAT)
      expect(result).toMatchObject({ kind: 'failed', reason: 'drain_failed' })
      expect(h.spies.record).not.toHaveBeenCalled()
    })

    it('keeps the mark and switch once an owned append has committed, and resumes later', async () => {
      class TwoAtATime extends PerChatSaveIntentQueue {
        override drain(chatId: string): ChatSaveIntent[] {
          const taken = super.drain(chatId)
          return taken.length > 0 ? [taken[0], intent(9, chatId)] : taken
        }
      }
      const h = seeded({}, { queue: new TwoAtATime() })
      h.spies.ownedAppend
        .mockImplementationOnce(h.spies.ownedAppend.getMockImplementation() as never)
        .mockRejectedValueOnce(new Error('second append'))

      const failed = await h.coordinator.activate(CHAT)

      expect(failed).toMatchObject({
        kind: 'failed',
        reason: 'drain_failed',
        ownershipRetained: true
      })
      if (failed.kind !== 'failed') throw new Error('unreachable')
      expect(failed.pending.map((item) => item.commandId)).toEqual(['cmd-9'])
      expect(h.spies.remove).not.toHaveBeenCalled()
      expect(h.spies.disable).not.toHaveBeenCalled()
      expect(h.spies.release).not.toHaveBeenCalled()
      expect(h.coordinator.isActive(CHAT)).toBe(true)
      expect(h.queue.peek(CHAT).map((item) => item.commandId)).toEqual(['cmd-9'])

      const resumed = await h.coordinator.activate(CHAT)
      expect(resumed).toMatchObject({ kind: 'activated' })
      expect(h.spies.claim).toHaveBeenCalledTimes(1)
      expect(h.queue.peek(CHAT)).toEqual([])
    })

    it('does not switch the shared authority off while another chat holds it', async () => {
      const h = seeded({
        markWriter: vi.fn(async (chatId: string) => {
          if (chatId === 'chat-2') throw new Error('disk')
        })
      })
      const coordinator = new ThreadOwnershipActivationCoordinator(h.options)
      h.receipts.set('cmd-4', exact(4, 'chat-2'))
      h.queue.enqueue(intent(4, 'chat-2'))
      h.spies.claim.mockImplementation(async (threadId: string) => reservationFor(threadId))

      expect(await coordinator.activate(CHAT)).toMatchObject({ kind: 'activated' })
      expect(await coordinator.activate('chat-2')).toMatchObject({
        kind: 'failed',
        reason: 'mark_write_failed'
      })
      expect(h.spies.disable).not.toHaveBeenCalled()
      expect(coordinator.isActive(CHAT)).toBe(true)
    })

    it('reports a cleanup step that itself failed', async () => {
      const h = seeded({
        markWriter: vi.fn(async () => {
          throw new Error('disk')
        })
      })
      h.spies.remove.mockRejectedValueOnce(new Error('unlink'))
      const result = await new ThreadOwnershipActivationCoordinator(h.options).activate(CHAT)
      expect(result).toMatchObject({ kind: 'failed', faults: ['mark_remove_failed'] })
    })
  })

  describe('publication must be confirmed before anything is claimed', () => {
    const untouched = (h: Harness) => {
      expect(h.spies.claim).not.toHaveBeenCalled()
      expect(h.spies.markWriter).not.toHaveBeenCalled()
      expect(h.spies.enable).not.toHaveBeenCalled()
      expect(h.spies.remove).not.toHaveBeenCalled()
    }

    it('no receipt held yet', async () => {
      const h = seeded({}, { confirm: false })
      const result = await h.coordinator.activate(CHAT)
      expect(result).toMatchObject({ kind: 'failed', reason: 'publication_not_confirmed' })
      if (result.kind !== 'failed') throw new Error('unreachable')
      expect(result.pending.map((item) => item.commandId)).toEqual(['cmd-3'])
      untouched(h)
      expect(h.queue.isFrozen(CHAT)).toBe(false)
    })

    it('a re-anchored copy is not the head', async () => {
      const h = seeded()
      h.receipts.set('cmd-3', {
        kind: 'reanchor',
        threadId: CHAT,
        commandId: 'host-3',
        revision: 3
      })
      expect(await h.coordinator.activate(CHAT)).toMatchObject({
        reason: 'publication_not_confirmed'
      })
      untouched(h)
    })

    it('an exact receipt for another revision or another thread is not the head', async () => {
      const h = seeded()
      h.receipts.set('cmd-3', exact(2))
      expect(await h.coordinator.activate(CHAT)).toMatchObject({
        reason: 'publication_not_confirmed'
      })
      h.queue.enqueue(intent(3))
      h.receipts.set('cmd-3', exact(3, 'chat-other'))
      expect(await h.coordinator.activate(CHAT)).toMatchObject({
        reason: 'publication_not_confirmed'
      })
      untouched(h)
    })

    it('the Host publication guard refuses', async () => {
      const h = seeded(
        {},
        {
          registry: {
            publishFullCopy: async () => ({ kind: 'refused', errorCode: 'thread_busy_in_desktop' })
          }
        }
      )
      expect(await h.coordinator.activate(CHAT)).toMatchObject({
        reason: 'publication_not_confirmed'
      })
      expect(h.calls).not.toContain('confirm')
      untouched(h)
    })

    it('nothing has ever been admitted for the chat', async () => {
      const h = harness()
      expect(await h.coordinator.activate(CHAT)).toMatchObject({
        kind: 'failed',
        reason: 'publication_not_confirmed',
        pending: []
      })
      untouched(h)
    })

    it('the binding cannot be read', async () => {
      const h = seeded({
        bindingFor: () => {
          throw new Error('no connection')
        }
      })
      expect(
        await new ThreadOwnershipActivationCoordinator(h.options).activate(CHAT)
      ).toMatchObject({
        reason: 'publication_not_confirmed'
      })
      untouched(h)
    })
  })

  describe('the claim must come back valid', () => {
    it('a claim that rejects', async () => {
      const h = seeded()
      h.spies.claim.mockRejectedValueOnce(new Error('refused'))
      expect(await h.coordinator.activate(CHAT)).toMatchObject({ reason: 'reservation_invalid' })
      expect(h.spies.markWriter).not.toHaveBeenCalled()
      expect(h.spies.remove).not.toHaveBeenCalled()
    })

    it('a reservation for another thread', async () => {
      const h = seeded()
      h.spies.claim.mockResolvedValueOnce(reservationFor('chat-other'))
      expect(await h.coordinator.activate(CHAT)).toMatchObject({ reason: 'reservation_invalid' })
      expect(h.spies.markWriter).not.toHaveBeenCalled()
      expect(h.spies.release).toHaveBeenCalledTimes(1)
    })

    it('a reservation that no longer revalidates, or is being erased', async () => {
      const stale = seeded()
      stale.spies.claim.mockResolvedValueOnce(
        reservationFor(CHAT, {
          revalidate: () => {
            throw new Error('mark moved')
          }
        })
      )
      expect(await stale.coordinator.activate(CHAT)).toMatchObject({
        reason: 'reservation_invalid'
      })

      const erasing = seeded()
      erasing.spies.claim.mockResolvedValueOnce(reservationFor(CHAT, { erasing: () => true }))
      expect(await erasing.coordinator.activate(CHAT)).toMatchObject({
        reason: 'reservation_invalid'
      })
      expect(erasing.spies.markWriter).not.toHaveBeenCalled()
    })
  })

  it('a receipt that cannot be recorded does not undo a committed append', async () => {
    const h = seeded()
    h.spies.record.mockRejectedValueOnce(new Error('disk'))
    expect(await h.coordinator.activate(CHAT)).toEqual({
      kind: 'activated',
      drained: 1,
      receiptFaults: 1
    })
    expect(h.spies.remove).not.toHaveBeenCalled()
  })
})

function memoryPersistence(): ReceiptEvidencePersistence {
  let text: string | null = null
  return {
    read: async () => text,
    write: async (next) => {
      text = next
    }
  }
}

describe('production glue', () => {
  it('requires the explicit submitted handle even when another receipt has the same revision', async () => {
    const queue = new PerChatSaveIntentQueue()
    const store = new HostOwnershipReceiptEvidenceStore(memoryPersistence())
    await store.load()
    const lookup = createHeadReceiptLookup({ queue, receiptStore: store })
    queue.enqueue(intent(3))
    expect(lookup.get('cmd-3')).toBeNull()
    await store.record(exact(2, CHAT, 'host-2'))
    await store.record({ kind: 'reanchor', threadId: CHAT, commandId: 'host-3r', revision: 3 })
    expect(lookup.get('cmd-3')).toBeNull()
    await store.record(exact(3, CHAT, 'host-3'))
    expect(lookup.get('cmd-3')).toBeNull()
    expect(queue.confirmPublication(CHAT, 'cmd-3', 'host-3', 3)).toBe(true)
    expect(lookup.get('cmd-3')).toEqual(exact(3, CHAT, 'host-3'))
    expect(lookup.get('unknown')).toBeNull()
  })

  it('a committed Host receipt is recorded, then settles the intents it covers', async () => {
    const queue = new PerChatSaveIntentQueue()
    const store = new HostOwnershipReceiptEvidenceStore(memoryPersistence())
    await store.load()
    const wiring = createChatSaveOwnershipWiring({
      queue,
      receiptStore: store,
      coordinator: { isActive: () => false },
      mintId: () => 'minted-1'
    })
    expect(wiring.port.mintHandle()).toEqual({
      commandId: 'minted-1',
      idempotencyKey: 'thread:record-persist:minted-1'
    })
    queue.enqueue(intent(3))
    queue.enqueue(intent(4))

    await wiring.persistedEvidenceSink({ chatId: CHAT, ownershipIntentId: 'cmd-3' }, exact(3))
    await vi.waitFor(() => expect(store.listLoaded(CHAT)).toHaveLength(1))
    // Authored at revision 4: still pending, revision 3 does not cover it.
    expect(queue.peek(CHAT)).toHaveLength(1)
    expect(wiring.port.receiptsFor(CHAT)).toEqual([exact(3)])

    // A matching revision without the authored intent identity settles nothing.
    await wiring.persistedEvidenceSink({ chatId: CHAT }, exact(4))
    expect(queue.peek(CHAT)).toHaveLength(1)
    await wiring.persistedEvidenceSink({ chatId: CHAT, ownershipIntentId: 'cmd-4' }, exact(4))
    await vi.waitFor(() => expect(queue.peek(CHAT)).toEqual([]))
  })

  it('an unavailable receipt is recorded but settles nothing', async () => {
    const queue = new PerChatSaveIntentQueue()
    const store = new HostOwnershipReceiptEvidenceStore(memoryPersistence())
    await store.load()
    const wiring = createChatSaveOwnershipWiring({
      queue,
      receiptStore: store,
      coordinator: { isActive: () => false }
    })
    queue.enqueue(intent(3))
    wiring.persistedEvidenceSink(
      { chatId: CHAT },
      { kind: 'unavailable', reason: 'legacy_receipt' }
    )
    await vi.waitFor(() => expect(store.listLoaded(CHAT)).toHaveLength(1))
    expect(queue.peek(CHAT)).toHaveLength(1)
  })
})
