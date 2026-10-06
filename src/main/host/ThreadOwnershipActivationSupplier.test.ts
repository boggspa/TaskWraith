import { describe, expect, it, vi } from 'vitest'

import {
  ReservationInvalid,
  type ThreadOwnershipReservation
} from '../../host-shared/thread-log/ThreadOwnership'
import {
  PerChatSaveIntentQueue,
  persistIdempotencyKeyFor,
  type ChatSaveIntent
} from '../../shared/chatSaveIntentQueue'
import type { ThreadOwnershipActivationResult } from '../services/ThreadOwnershipActivationCoordinator'
import type { ChatRecord } from '../store/types'
import {
  ThreadOwnershipClaimFactsSource,
  ThreadOwnershipClaimNotGranted,
  createThreadOwnershipActivationSupply,
  createThreadOwnershipActivationTrigger,
  ownedJournalHolds,
  type OwnedThreadJournal
} from './ThreadOwnershipActivationSupplier'
import type { ThreadOwnershipNetworkGrant } from './ThreadOwnershipClient'
import type { ThreadOwnershipReceiptEvidence } from './ThreadOwnershipReceiptEvidence'

const CHAT = 'chat-1'
const WRITER = { writerId: 'writer-1', pid: 4242 }
const SHA = 'c'.repeat(64)

function intent(revision: number, chatId = CHAT): ChatSaveIntent {
  const commandId = `cmd-${chatId}-${revision}`
  return {
    chatId,
    record: {
      appChatId: chatId,
      persistenceRevision: revision,
      messages: []
    } as never as ChatRecord,
    authoredAt: revision,
    commandId,
    idempotencyKey: persistIdempotencyKeyFor(commandId)
  }
}

const exact = (revision: number, chatId = CHAT): ThreadOwnershipReceiptEvidence => ({
  kind: 'exact',
  threadId: chatId,
  commandId: `host-${revision}`,
  revision,
  sha256: SHA
})

function grantFor(threadId = CHAT, base = 3): ThreadOwnershipNetworkGrant {
  return Object.freeze({
    threadId,
    epoch: Object.freeze({ host: 'h'.repeat(64), grant: 9 }),
    facts: Object.freeze({ baseRevision: base, headRevision: base, lineageToken: {} })
  })
}

function journalAt(revision: number | null): OwnedThreadJournal & {
  barrier: ReturnType<typeof vi.fn>
} {
  return {
    barrier: vi.fn(async () => undefined),
    head: async () =>
      revision === null ? { kind: 'none' } : { kind: 'head', revision, savedAt: null }
  }
}

describe('ThreadOwnershipClaimFactsSource', () => {
  function source() {
    const queue = new PerChatSaveIntentQueue()
    const evidence = new Map<string, ThreadOwnershipReceiptEvidence>()
    const facts = new ThreadOwnershipClaimFactsSource({
      queue,
      confirmed: { get: (commandId) => evidence.get(commandId) ?? null }
    })
    return { queue, evidence, facts }
  }

  it('offers no facts for a frozen head the Host has not confirmed exactly', () => {
    const { queue, evidence, facts } = source()
    queue.enqueue(intent(3))
    queue.freezeHead(CHAT, 3)
    expect(facts.read(CHAT)).toBeNull()
    evidence.set(intent(3).commandId, {
      kind: 'reanchor',
      threadId: CHAT,
      commandId: 'x',
      revision: 3
    })
    expect(facts.read(CHAT)).toBeNull()
    evidence.set(intent(3).commandId, exact(2))
    expect(facts.read(CHAT)).toBeNull()
  })

  it('claims base = head = the confirmed frozen head, then keeps the lineage as the head moves on', () => {
    const { queue, evidence, facts } = source()
    queue.enqueue(intent(3))
    queue.freezeHead(CHAT, 3)
    evidence.set(intent(3).commandId, exact(3))
    const claimed = facts.read(CHAT)!
    expect(claimed).toMatchObject({ baseRevision: 3, headRevision: 3 })

    queue.unfreeze(CHAT)
    queue.enqueue(intent(5))
    const later = facts.read(CHAT)!
    expect(later.lineageToken).toBe(claimed.lineageToken)
    expect(later).toMatchObject({ baseRevision: 3, headRevision: 5 })
  })

  it('starts a new lineage at a different head, and none once forgotten', () => {
    const { queue, evidence, facts } = source()
    queue.enqueue(intent(3))
    queue.freezeHead(CHAT, 3)
    evidence.set(intent(3).commandId, exact(3))
    const first = facts.read(CHAT)!.lineageToken
    queue.unfreeze(CHAT)
    queue.enqueue(intent(4))
    queue.freezeHead(CHAT, 4)
    evidence.set(intent(4).commandId, exact(4))
    expect(facts.read(CHAT)!.lineageToken).not.toBe(first)
    queue.unfreeze(CHAT)
    facts.forget(CHAT)
    expect(facts.read(CHAT)).toBeNull()
  })
})

describe('createThreadOwnershipActivationSupply', () => {
  function supplyWith(
    overrides: {
      connected?: boolean
      outcome?: Awaited<
        ReturnType<
          Parameters<typeof createThreadOwnershipActivationSupply>[0]['client']['requestClaim']
        >
      >
      journal?: OwnedThreadJournal
      erasing?: (chatId: string) => boolean
    } = {}
  ) {
    const grant = grantFor()
    let current = true
    const client = {
      requestClaim: vi.fn(
        async () => overrides.outcome ?? { kind: 'network_grant' as const, grant }
      ),
      release: vi.fn(async () => ({ kind: 'released' as const })),
      isCurrent: vi.fn(() => current)
    }
    const facts = { forget: vi.fn() }
    const supply = createThreadOwnershipActivationSupply({
      client,
      connection: { ensureConnected: async () => overrides.connected ?? true },
      facts,
      writer: WRITER,
      journal: overrides.journal ?? journalAt(9),
      ...(overrides.erasing ? { erasing: overrides.erasing } : {})
    })
    return { supply, client, facts, grant, lose: () => (current = false) }
  }

  it('refuses to claim without a connection, and never asks the Host', async () => {
    const { supply, client } = supplyWith({ connected: false })
    await expect(supply.registry.claim(CHAT)).rejects.toBeInstanceOf(ThreadOwnershipClaimNotGranted)
    expect(client.requestClaim).not.toHaveBeenCalled()
  })

  it('turns a refusal into a failed claim carrying the reason', async () => {
    const { supply } = supplyWith({
      outcome: { kind: 'refused', reason: 'host_run_active', revision: null }
    })
    await expect(supply.registry.claim(CHAT)).rejects.toThrow(/refused\/host_run_active/)
  })

  it('mints a reservation valid only while that exact grant is current', async () => {
    const { supply, grant, lose } = supplyWith()
    const reservation = await supply.registry.claim(CHAT)
    expect(reservation).toMatchObject({ threadId: CHAT, epoch: grant.epoch })
    expect(() => reservation.revalidate()).not.toThrow()
    expect(reservation.erasing()).toBe(false)
    lose()
    expect(() => reservation.revalidate()).toThrow(ReservationInvalid)
  })

  it('reads an unreadable erasure fence as erasing', async () => {
    const { supply } = supplyWith({
      erasing: () => {
        throw new Error('fence unreadable')
      }
    })
    const reservation = await supply.registry.claim(CHAT)
    expect(reservation.erasing()).toBe(true)
  })

  it('records the grant base in the mark, and refuses a reservation it did not mint', async () => {
    const { supply } = supplyWith()
    const reservation = await supply.registry.claim(CHAT)
    expect(supply.mark.writer).toEqual(WRITER)
    expect(supply.mark.grantedAtRevision(CHAT, reservation)).toBe(3)
    expect(() => supply.mark.grantedAtRevision('other', reservation)).toThrow(ReservationInvalid)
    const copy: ThreadOwnershipReservation = { ...reservation }
    expect(() => supply.mark.grantedAtRevision(CHAT, copy)).toThrow(ReservationInvalid)
  })

  it('releases on the same client, ends the lineage, and voids the reservation', async () => {
    const { supply, client, facts, grant } = supplyWith()
    const reservation = await supply.registry.claim(CHAT)
    await supply.registry.release!(reservation)
    expect(client.release).toHaveBeenCalledWith(grant, null)
    expect(facts.forget).toHaveBeenCalledWith(CHAT)
    expect(() => reservation.revalidate()).toThrow(ReservationInvalid)
    // A second release, or one for a stranger, does nothing.
    await supply.registry.release!(reservation)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('treats a stale release as done and a refused one as a fault', async () => {
    const stale = supplyWith()
    stale.client.release.mockResolvedValueOnce({ kind: 'stale' } as never)
    await expect(
      stale.supply.registry.release!(await stale.supply.registry.claim(CHAT))
    ).resolves.toBeUndefined()
    const refused = supplyWith()
    refused.client.release.mockResolvedValueOnce({ kind: 'refused' } as never)
    await expect(
      refused.supply.registry.release!(await refused.supply.registry.claim(CHAT))
    ).rejects.toThrow(/refused/)
  })

  it('confirms an owned append by the journal barrier and a head at or above the save', async () => {
    const journal = journalAt(5)
    const { supply } = supplyWith({ journal })
    const reservation = await supply.registry.claim(CHAT)
    await expect(supply.ownedAppend(intent(5), reservation)).resolves.toEqual({
      kind: 'reanchor',
      threadId: CHAT,
      commandId: intent(5).commandId,
      revision: 5
    })
    expect(journal.barrier).toHaveBeenCalledWith(CHAT)
  })

  it('fails an owned append the journal does not hold, or whose grant left', async () => {
    const behind = supplyWith({ journal: journalAt(4) })
    const reservation = await behind.supply.registry.claim(CHAT)
    await expect(behind.supply.ownedAppend(intent(5), reservation)).rejects.toThrow(/does not hold/)

    const empty = supplyWith({ journal: journalAt(null) })
    await expect(
      empty.supply.ownedAppend(intent(1), await empty.supply.registry.claim(CHAT))
    ).rejects.toThrow(/does not hold/)

    const lost = supplyWith()
    const held = await lost.supply.registry.claim(CHAT)
    lost.lose()
    await expect(lost.supply.ownedAppend(intent(1), held)).rejects.toBeInstanceOf(
      ReservationInvalid
    )
  })

  it('fails when the barrier itself fails', async () => {
    const journal = journalAt(9)
    journal.barrier.mockRejectedValueOnce(new Error('fsync failed'))
    await expect(ownedJournalHolds(journal, CHAT, 1)).rejects.toThrow(/fsync failed/)
  })
})

describe('createThreadOwnershipActivationTrigger', () => {
  function trigger(results: ThreadOwnershipActivationResult[] = []) {
    const queue = new PerChatSaveIntentQueue()
    let active = false
    const activate = vi.fn(async () => {
      const next = results.shift() ?? { kind: 'activated' as const, drained: 0, receiptFaults: 0 }
      if (next.kind === 'activated') active = true
      return next
    })
    const onOutcome = vi.fn()
    const fire = createThreadOwnershipActivationTrigger({
      queue,
      activation: { activate, isActive: () => active },
      onOutcome
    })
    return { queue, activate, onOutcome, fire }
  }

  it('activates once for an exact receipt of the admitted head', async () => {
    const { queue, activate, onOutcome, fire } = trigger()
    queue.enqueue(intent(3))
    fire.confirmed(CHAT, exact(3))
    fire.confirmed(CHAT, exact(3))
    await fire.idle()
    expect(activate).toHaveBeenCalledTimes(1)
    expect(onOutcome).toHaveBeenCalledWith(CHAT, expect.objectContaining({ kind: 'activated' }))
    // Active now: further receipts ask nothing.
    queue.enqueue(intent(4))
    fire.confirmed(CHAT, exact(4))
    await fire.idle()
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('ignores receipts that are not exact, belong to another chat, or are not the head', async () => {
    const { queue, activate, fire } = trigger()
    queue.enqueue(intent(3))
    fire.confirmed(CHAT, { kind: 'reanchor', threadId: CHAT, commandId: 'x', revision: 3 })
    fire.confirmed(CHAT, exact(3, 'other'))
    fire.confirmed(CHAT, exact(2))
    fire.confirmed('nobody', exact(3, 'nobody'))
    await fire.idle()
    expect(activate).not.toHaveBeenCalled()
  })

  it('hands a clean rollback’s intents back in order and asks again only for a newer head', async () => {
    const older = intent(3)
    const newer = intent(4)
    const { queue, activate, fire } = trigger([
      {
        kind: 'failed',
        reason: 'reservation_invalid',
        pending: [older, newer],
        faults: [],
        ownershipRetained: false
      }
    ])
    // The sink settled the confirmed head; the rollback reset the queue and
    // handed back what it held then.
    queue.enqueue(intent(3))
    queue.settle(CHAT, intent(3).commandId)
    fire.confirmed(CHAT, exact(3))
    await fire.idle()
    const [held] = queue.peek(CHAT)
    expect(held.commandId).toBe(newer.commandId)
    expect(held.supersedes?.map((handle) => handle.commandId)).toEqual([older.commandId])

    fire.confirmed(CHAT, exact(3))
    await fire.idle()
    expect(activate).toHaveBeenCalledTimes(1)
    queue.enqueue(intent(5))
    fire.confirmed(CHAT, exact(5))
    await fire.idle()
    expect(activate).toHaveBeenCalledTimes(2)
  })

  it('leaves a retained ownership’s requeue to the coordinator', async () => {
    const { queue, fire } = trigger([
      {
        kind: 'failed',
        reason: 'drain_failed',
        pending: [intent(3)],
        faults: [],
        ownershipRetained: true
      }
    ])
    queue.enqueue(intent(3))
    queue.settle(CHAT, intent(3).commandId)
    fire.confirmed(CHAT, exact(3))
    await fire.idle()
    expect(queue.peek(CHAT)).toEqual([])
  })

  it('asks again for the same head once forgotten', async () => {
    const { queue, activate, fire } = trigger([
      {
        kind: 'failed',
        reason: 'publication_not_confirmed',
        pending: [],
        faults: [],
        ownershipRetained: false
      }
    ])
    queue.enqueue(intent(3))
    fire.confirmed(CHAT, exact(3))
    await fire.idle()
    fire.forget(CHAT)
    fire.confirmed(CHAT, exact(3))
    await fire.idle()
    expect(activate).toHaveBeenCalledTimes(2)
  })

  it('retries one chat after a takeover even for a head already refused, and returns the outcome', async () => {
    const refused: ThreadOwnershipActivationResult = {
      kind: 'failed',
      reason: 'reservation_invalid',
      pending: [],
      faults: [],
      ownershipRetained: false
    }
    const { queue, activate, onOutcome, fire } = trigger([refused])
    queue.enqueue(intent(3))
    fire.confirmed(CHAT, exact(3))
    await fire.idle()
    expect(activate).toHaveBeenCalledTimes(1)

    await expect(fire.retry(CHAT)).resolves.toEqual({
      kind: 'activated',
      drained: 0,
      receiptFaults: 0
    })
    expect(activate).toHaveBeenCalledTimes(2)
    expect(onOutcome).toHaveBeenLastCalledWith(CHAT, expect.objectContaining({ kind: 'activated' }))
    // Active now, and a chat with nothing admitted is never asked.
    await expect(fire.retry(CHAT)).resolves.toBeNull()
    await expect(fire.retry('nobody')).resolves.toBeNull()
    expect(activate).toHaveBeenCalledTimes(2)
  })
})
