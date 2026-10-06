import { describe, expect, it, vi } from 'vitest'
import { HostThreadPublicationGuard } from '../../host-runtime/HostThreadPublicationGuard'
import {
  ReservationInvalid,
  type ThreadOwnershipReservation
} from '../../host-shared/thread-log/ThreadOwnership'
import {
  PerChatSaveIntentQueue,
  persistIdempotencyKeyFor,
  type ChatSaveIntent
} from '../../shared/chatSaveIntentQueue'
import type { ThreadOwnershipReceiptEvidence } from '../host/HostOwnershipReceiptEvidenceStore'
import type { ChatRecord } from '../store/types'
import { ThreadOwnershipActivationCoordinator } from './ThreadOwnershipActivationCoordinator'

const SHA = 'c'.repeat(64)
const CHAT = 'chat-1'

function intent(revision: number): ChatSaveIntent {
  const commandId = `cmd-${revision}`
  return {
    chatId: CHAT,
    record: {
      appChatId: CHAT,
      title: 't',
      persistenceRevision: revision,
      messages: []
    } as never as ChatRecord,
    authoredAt: revision,
    commandId,
    idempotencyKey: persistIdempotencyKeyFor(commandId)
  }
}

const exact = (revision: number): ThreadOwnershipReceiptEvidence => ({
  kind: 'exact',
  threadId: CHAT,
  commandId: `host-${revision}`,
  revision,
  sha256: SHA
})

/** A coordinator whose claims mint a fresh reservation each time, any of which can lapse. */
function harness() {
  const queue = new PerChatSaveIntentQueue()
  const receipts = new Map<string, ThreadOwnershipReceiptEvidence>()
  const minted: Array<ThreadOwnershipReservation & { lapse(): void }> = []
  const spies = {
    claim: vi.fn(async () => {
      let lapsed = false
      const reservation = {
        threadId: CHAT,
        epoch: { host: 'host-1', grant: minted.length + 1 },
        revalidate: () => {
          if (lapsed) throw new ReservationInvalid('mark_moved')
        },
        erasing: () => false,
        lapse: () => {
          lapsed = true
        }
      }
      minted.push(reservation)
      return reservation
    }),
    release: vi.fn(async () => undefined),
    remove: vi.fn(async () => true),
    markWriter: vi.fn(async () => undefined),
    disable: vi.fn()
  }
  const coordinator = new ThreadOwnershipActivationCoordinator({
    queue,
    registry: { claim: spies.claim, release: spies.release },
    publicationGuard: new HostThreadPublicationGuard(null),
    bindingFor: () => ({ owner: null, isCurrent: () => true }),
    authorityFile: { remove: spies.remove },
    markWriter: spies.markWriter,
    receiptStore: { record: async () => undefined },
    authoritySwitch: { enable: () => undefined, disable: spies.disable },
    commandHandleStore: { get: (commandId) => receipts.get(commandId) ?? null },
    ownedAppend: async (item) => ({
      kind: 'reanchor',
      threadId: item.chatId,
      commandId: item.commandId,
      revision: item.record.persistenceRevision ?? 0
    })
  })
  /** A save the Host confirmed exactly and the sink settled. */
  const confirmedSave = (revision: number) => {
    queue.enqueue(intent(revision))
    receipts.set(`cmd-${revision}`, exact(revision))
    queue.settle(CHAT, `cmd-${revision}`)
  }
  return { queue, coordinator, spies, minted, confirmedSave }
}

describe('ThreadOwnershipActivationCoordinator lapse', () => {
  it('stops counting a revoked grant as ownership, releases it and keeps the mark', async () => {
    const h = harness()
    h.confirmedSave(3)
    expect(await h.coordinator.activate(CHAT)).toMatchObject({ kind: 'activated' })
    expect(h.coordinator.isActive(CHAT)).toBe(true)

    h.minted[0].lapse()
    expect(h.coordinator.isActive(CHAT)).toBe(false)
    await Promise.resolve()
    expect(h.spies.release).toHaveBeenCalledWith(h.minted[0])
    expect(h.spies.disable).toHaveBeenCalledTimes(1)
    // Owned rows may sit above the Host's copy: the mark is not this path's to remove.
    expect(h.spies.remove).not.toHaveBeenCalled()
    // Asking again does not lapse twice.
    expect(h.coordinator.isActive(CHAT)).toBe(false)
    expect(h.spies.release).toHaveBeenCalledTimes(1)
  })

  it('activates afresh after a lapse, under a new claim for a newer confirmed head', async () => {
    const h = harness()
    h.confirmedSave(3)
    await h.coordinator.activate(CHAT)
    h.minted[0].lapse()
    h.confirmedSave(4)

    expect(await h.coordinator.activate(CHAT)).toMatchObject({ kind: 'activated' })
    expect(h.spies.claim).toHaveBeenCalledTimes(2)
    expect(h.coordinator.isActive(CHAT)).toBe(true)
    expect(h.spies.markWriter).toHaveBeenLastCalledWith(CHAT, h.minted[1])
  })

  it('keeps the mark over saves the owned journal confirmed outside replay', async () => {
    const h = harness()
    h.confirmedSave(3)
    await h.coordinator.activate(CHAT)
    h.coordinator.noteOwnedCommit(CHAT)

    await h.coordinator.deactivate(CHAT)
    expect(h.spies.remove).not.toHaveBeenCalled()
    expect(h.spies.release).toHaveBeenCalledTimes(1)
  })

  it('forgets owned rows once a newer head is confirmed in Host storage', async () => {
    const h = harness()
    h.confirmedSave(3)
    await h.coordinator.activate(CHAT)
    h.coordinator.noteOwnedCommit(CHAT)
    h.minted[0].lapse()
    h.confirmedSave(5)
    await h.coordinator.activate(CHAT)

    await h.coordinator.deactivate(CHAT)
    expect(h.spies.remove).toHaveBeenCalledWith(CHAT)
  })

  it('ignores an owned commit noted while the chat is not active', async () => {
    const h = harness()
    h.coordinator.noteOwnedCommit(CHAT)
    h.confirmedSave(3)
    await h.coordinator.activate(CHAT)
    await h.coordinator.deactivate(CHAT)
    expect(h.spies.remove).toHaveBeenCalledWith(CHAT)
  })
})
