import { describe, expect, it, vi } from 'vitest'
import { HostThreadPublicationGuard } from '../../host-runtime/HostThreadPublicationGuard'
import type { ThreadOwnershipReservation } from '../../host-shared/thread-log/ThreadOwnership'
import {
  PerChatSaveIntentQueue,
  persistIdempotencyKeyFor,
  type ChatSaveIntent
} from '../../shared/chatSaveIntentQueue'
import type { ThreadOwnershipReceiptEvidence } from '../host/HostOwnershipReceiptEvidenceStore'
import type { ChatRecord } from '../store/types'
import {
  ThreadOwnershipActivationCoordinator,
  type ThreadOwnershipActivationOptions
} from './ThreadOwnershipActivationCoordinator'

const SHA = 'c'.repeat(64)
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

/**
 * `settled` models a head the Host already confirmed and settled, so activation
 * replays nothing and the chat has no owned rows. Unsettled, the replay appends
 * the head and the chat then has an owned row.
 */
function harness(
  overrides: Partial<ThreadOwnershipActivationOptions> = {},
  setup: { settled?: boolean; claimGate?: Promise<void> } = {}
) {
  const calls: string[] = []
  const queue = new PerChatSaveIntentQueue()
  const reservation = {
    threadId: CHAT,
    epoch: { host: 'host-1', grant: 1 },
    revalidate: vi.fn(),
    erasing: () => false
  } satisfies ThreadOwnershipReservation
  const receipts = new Map<string, ThreadOwnershipReceiptEvidence>([
    ['cmd-3', { kind: 'exact', threadId: CHAT, commandId: 'host-3', revision: 3, sha256: SHA }]
  ])
  const spies = {
    remove: vi.fn(async () => {
      calls.push('remove-mark')
      return true
    }),
    enable: vi.fn(() => void calls.push('enable')),
    disable: vi.fn(() => void calls.push('disable')),
    release: vi.fn(async () => void calls.push('release')),
    markWriter: vi.fn(async () => void calls.push('mark')),
    claim: vi.fn(async () => {
      calls.push('claim')
      if (setup.claimGate) await setup.claimGate
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
    publicationGuard: new HostThreadPublicationGuard(null),
    bindingFor: () => ({ owner: null, isCurrent: () => true }),
    authorityFile: { remove: spies.remove },
    markWriter: spies.markWriter,
    receiptStore: { record: vi.fn(async () => undefined) },
    authoritySwitch: { enable: spies.enable, disable: spies.disable },
    commandHandleStore: { get: (commandId) => receipts.get(commandId) ?? null },
    ownedAppend: spies.ownedAppend,
    ...overrides
  }
  queue.enqueue(intent(3))
  if (setup.settled) queue.settle(CHAT, 'cmd-3')
  return {
    calls,
    queue,
    options,
    spies,
    reservation,
    coordinator: new ThreadOwnershipActivationCoordinator(options)
  }
}

/** Let queued promise callbacks run without waiting on a timer. */
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

describe('ThreadOwnershipActivationCoordinator.deactivate', () => {
  it('releases an active chat with no owned rows: mark removed, queue dropped, switch given back', async () => {
    const h = harness({}, { settled: true })
    const result = await h.coordinator.activate(CHAT)
    expect(result).toEqual({ kind: 'activated', drained: 0, receiptFaults: 0 })
    h.queue.enqueue(intent(4))
    h.calls.length = 0

    await h.coordinator.deactivate(CHAT)

    expect(h.coordinator.isActive(CHAT)).toBe(false)
    // The mark goes before the release: one still on disk names a live writer.
    expect(h.calls).toEqual(['remove-mark', 'release', 'disable'])
    expect(h.spies.release).toHaveBeenCalledWith(h.reservation)
    expect(h.queue.peek(CHAT)).toEqual([])
  })

  it('deactivating a chat that is not active does nothing', async () => {
    const h = harness({}, { settled: true })

    await expect(h.coordinator.deactivate(CHAT)).resolves.toBeUndefined()
    await expect(h.coordinator.deactivate('other-chat')).resolves.toBeUndefined()

    expect(h.calls).toEqual([])
    expect(h.spies.disable).not.toHaveBeenCalled()
  })

  it('is idempotent: a second deactivate finds nothing to do', async () => {
    const h = harness({}, { settled: true })
    await h.coordinator.activate(CHAT)
    await h.coordinator.deactivate(CHAT)
    h.calls.length = 0

    await h.coordinator.deactivate(CHAT)

    expect(h.calls).toEqual([])
  })

  it('invalidates an activation before joining the pending claim', async () => {
    let open: () => void = () => undefined
    const claimGate = new Promise<void>((resolve) => (open = resolve))
    const h = harness({}, { settled: true, claimGate })
    const activation = h.coordinator.activate(CHAT)
    await flush()
    expect(h.calls).toEqual(['claim'])

    let finished = false
    const deactivation = h.coordinator.deactivate(CHAT).then(() => (finished = true))
    await flush()
    expect(finished).toBe(false)

    open()
    await Promise.all([activation, deactivation])

    expect(await activation).toMatchObject({ kind: 'failed', reason: 'reservation_invalid' })
    expect(h.coordinator.isActive(CHAT)).toBe(false)
    expect(h.calls).toEqual(['claim', 'release'])
  })

  it('keeps the mark when the port reports owned rows', async () => {
    const h = harness({ hasOwnedRows: () => true }, { settled: true })
    await h.coordinator.activate(CHAT)
    h.calls.length = 0

    await h.coordinator.deactivate(CHAT)

    expect(h.calls).toEqual(['release', 'disable'])
    expect(h.spies.remove).not.toHaveBeenCalled()
    expect(h.coordinator.isActive(CHAT)).toBe(false)
  })

  it('keeps the mark for rows this process appended', async () => {
    const h = harness()
    expect(await h.coordinator.activate(CHAT)).toMatchObject({ kind: 'activated', drained: 1 })
    h.calls.length = 0

    await h.coordinator.deactivate(CHAT)

    expect(h.spies.remove).not.toHaveBeenCalled()
    expect(h.calls).toEqual(['release', 'disable'])
  })

  it('treats an unreadable owned-row answer as owned rows, and reports the fault', async () => {
    const h = harness(
      {
        hasOwnedRows: () => {
          throw new Error('unreadable')
        }
      },
      { settled: true }
    )
    await h.coordinator.activate(CHAT)

    await expect(h.coordinator.deactivate(CHAT)).rejects.toThrow(/owned_rows_unknown/)

    expect(h.spies.remove).not.toHaveBeenCalled()
  })

  it('a failed mark removal throws, and a retry finishes the removal', async () => {
    const h = harness({}, { settled: true })
    await h.coordinator.activate(CHAT)
    h.spies.remove.mockRejectedValueOnce(new Error('disk'))

    await expect(h.coordinator.deactivate(CHAT)).rejects.toThrow(/mark_remove_failed/)
    expect(h.coordinator.isActive(CHAT)).toBe(false)
    expect(h.spies.remove).toHaveBeenCalledTimes(1)

    await h.coordinator.deactivate(CHAT)

    expect(h.spies.remove).toHaveBeenCalledTimes(2)
    await h.coordinator.deactivate(CHAT)
    expect(h.spies.remove).toHaveBeenCalledTimes(2)
  })

  it('gives up on an activation that never settles instead of hanging the erasure', async () => {
    const claimGate = new Promise<void>(() => undefined)
    const h = harness({ erasureFenceTimeoutMs: 10 }, { settled: true, claimGate })
    void h.coordinator.activate(CHAT)
    await flush()

    await expect(h.coordinator.deactivate(CHAT)).rejects.toThrow(/did not settle/)
  })

  it('a claim completing after an erasure join times out cannot write a mark or activate', async () => {
    let open!: () => void
    const claimGate = new Promise<void>((resolve) => {
      open = resolve
    })
    const h = harness({ erasureFenceTimeoutMs: 10 }, { settled: true, claimGate })
    const activation = h.coordinator.activate(CHAT)
    await flush()
    await expect(h.coordinator.deactivate(CHAT)).rejects.toThrow(/did not settle/)
    open()
    expect(await activation).toMatchObject({ kind: 'failed', reason: 'reservation_invalid' })
    expect(h.spies.markWriter).not.toHaveBeenCalled()
    expect(h.spies.ownedAppend).not.toHaveBeenCalled()
    expect(h.coordinator.isActive(CHAT)).toBe(false)
    expect(h.spies.release).toHaveBeenCalledWith(h.reservation)
    expect(await h.coordinator.activate(CHAT)).toMatchObject({
      kind: 'failed',
      reason: 'reservation_invalid'
    })
  })

  describe('erasing() polls', () => {
    it('an activation stops before the mark when the fence rises after the claim', async () => {
      let erasing = false
      const h = harness({ erasing: () => erasing }, { settled: true })
      h.spies.claim.mockImplementation(async () => {
        h.calls.push('claim')
        erasing = true
        return h.reservation
      })

      const result = await h.coordinator.activate(CHAT)

      expect(result).toMatchObject({ kind: 'failed', reason: 'reservation_invalid' })
      expect(h.spies.markWriter).not.toHaveBeenCalled()
      expect(h.spies.release).toHaveBeenCalledWith(h.reservation)
      expect(h.spies.enable).not.toHaveBeenCalled()
      expect(h.coordinator.isActive(CHAT)).toBe(false)
    })

    it('an activation unwinds the mark it wrote when the fence rises during the write', async () => {
      let erasing = false
      const h = harness({ erasing: () => erasing }, { settled: true })
      h.spies.markWriter.mockImplementation(async () => {
        h.calls.push('mark')
        erasing = true
      })

      const result = await h.coordinator.activate(CHAT)

      expect(result).toMatchObject({ kind: 'failed', reason: 'reservation_invalid' })
      expect(h.spies.remove).toHaveBeenCalledTimes(1)
      expect(h.spies.enable).not.toHaveBeenCalled()
      expect(h.spies.ownedAppend).not.toHaveBeenCalled()
    })

    it("the reservation's own erasing flag stops the activation too", async () => {
      const h = harness({}, { settled: true })
      h.spies.markWriter.mockImplementation(async () => {
        h.calls.push('mark')
        ;(h.reservation as { erasing: () => boolean }).erasing = () => true
      })

      expect(await h.coordinator.activate(CHAT)).toMatchObject({
        kind: 'failed',
        reason: 'reservation_invalid'
      })
      expect(h.spies.ownedAppend).not.toHaveBeenCalled()
    })

    it('a replay stops before the append and leaves the intent queued', async () => {
      let erasing = false
      const h = harness({ erasing: () => erasing }, { settled: true })
      await h.coordinator.activate(CHAT)
      h.queue.enqueue(intent(4))
      erasing = true

      const result = await h.coordinator.activate(CHAT)

      expect(result).toMatchObject({
        kind: 'failed',
        reason: 'reservation_invalid',
        ownershipRetained: true
      })
      expect(h.spies.ownedAppend).not.toHaveBeenCalled()
      expect(h.queue.peek(CHAT)).toHaveLength(1)
    })

    it('a throwing fence reads as erasing', async () => {
      const h = harness(
        {
          erasing: () => {
            throw new Error('unreadable fence')
          }
        },
        { settled: true }
      )

      expect(await h.coordinator.activate(CHAT)).toMatchObject({
        kind: 'failed',
        reason: 'reservation_invalid'
      })
      expect(h.spies.ownedAppend).not.toHaveBeenCalled()
    })
  })
})
