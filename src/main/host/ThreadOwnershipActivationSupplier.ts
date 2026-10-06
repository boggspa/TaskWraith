/**
 * Production suppliers for desktop ownership activation.
 *
 * The activation coordinator takes every collaborator through its constructor
 * and decides nothing about transports or files. This module builds the parts
 * only a live Host connection and this process's journal can give it:
 *
 * - The claim. `ThreadOwnershipClient` negotiates it on the one persistent
 *   desktop connection, and the grant becomes a reservation that stays valid
 *   only while that exact grant is current on that socket for the same
 *   lineage. Releasing it drops the lineage, so a later claim starts afresh.
 * - The facts a claim is asked against. Base and head are both the frozen
 *   head, and only once the exact Host publication of that head is confirmed
 *   by the command that carried it. Without that there are no facts, and no
 *   claim is sent.
 * - Who the authority mark names, and the revision it records: the grant's
 *   confirmed base, never a default.
 * - The owned append. A save is journaled when it is authored, before
 *   activation can see it, so the append is the journal's own barrier for the
 *   chat followed by a read of the log head with the reader the Host uses. A
 *   head below the save's revision is a failed append: the coordinator hands
 *   the intent back.
 * - The trigger. A confirmed exact publication of a chat's admitted head asks
 *   for activation once per head. A refused activation hands its intents back
 *   to the queue, where they stay pending until Host storage confirms them.
 *
 * Owned-journal confirmations are not Host receipts, so `ownedReceipts` drops
 * them: recorded beside Host receipts, they could later be read as proof of a
 * Host publication.
 */
import { readThreadLogHead, type ThreadLogHead } from '../../host-runtime/HostThreadLogHead'
import type { ThreadAuthorityWriter } from '../../host-shared/thread-log/ThreadAuthorityFile'
import {
  ReservationInvalid,
  type ThreadOwnershipReservation
} from '../../host-shared/thread-log/ThreadOwnership'
import type { ChatSaveIntent, PerChatSaveIntentQueue } from '../../shared/chatSaveIntentQueue'
import { chatPersistenceRevision } from '../../shared/rendererChatTranscriptMutation'
import type {
  ThreadOwnershipActivationCoordinator,
  ThreadOwnershipActivationOptions,
  ThreadOwnershipActivationResult
} from '../services/ThreadOwnershipActivationCoordinator'
import type { ThreadOwnershipReceiptEvidence } from './ThreadOwnershipReceiptEvidence'
import type {
  ThreadOwnershipClaimFacts,
  ThreadOwnershipClaimOutcome,
  ThreadOwnershipClient,
  ThreadOwnershipNetworkGrant
} from './ThreadOwnershipClient'

/** The journal this process owns, as ownership needs it. */
export interface OwnedThreadJournal {
  /** Pays everything the chat's journal owes; resolves once it is durable. */
  barrier(chatId: string): Promise<void>
  /** The log head as the Host reads it. */
  head(chatId: string): Promise<ThreadLogHead>
}

export function ownedThreadJournal(input: {
  readonly directory: string
  barrier(chatId: string): Promise<void>
}): OwnedThreadJournal {
  return {
    barrier: (chatId) => input.barrier(chatId),
    head: (chatId) => readThreadLogHead(input.directory, chatId)
  }
}

/**
 * Whether the owned journal durably holds a save at `revision`: its barrier is
 * paid, then the head is read back as the Host would read it. A head below the
 * revision means the journal did not take the save.
 */
export async function ownedJournalHolds(
  journal: OwnedThreadJournal,
  chatId: string,
  revision: number
): Promise<boolean> {
  await journal.barrier(chatId)
  const head = await journal.head(chatId)
  return head.kind === 'head' && head.revision >= revision
}

/** A claim the Host did not grant, or could not be asked for. */
export class ThreadOwnershipClaimNotGranted extends Error {
  constructor(readonly outcome: Exclude<ThreadOwnershipClaimOutcome, { kind: 'network_grant' }>) {
    super(`Thread ownership claim not granted: ${describeOutcome(outcome)}`)
    this.name = 'ThreadOwnershipClaimNotGranted'
  }
}

function describeOutcome(outcome: Exclude<ThreadOwnershipClaimOutcome, { kind: 'network_grant' }>) {
  return 'reason' in outcome ? `${outcome.kind}/${outcome.reason}` : outcome.kind
}

export interface ThreadOwnershipClaimFactsSourceOptions {
  readonly queue: Pick<PerChatSaveIntentQueue, 'frozenHead' | 'admittedHead'>
  /** Exact Host evidence for an authored save's command handle (`createHeadReceiptLookup`). */
  readonly confirmed: { get(commandId: string): ThreadOwnershipReceiptEvidence | null }
}

/**
 * `readClaimFacts` for `ThreadOwnershipClient`, plus the lineage bookkeeping
 * the grant's currency is judged by. A lineage begins at a confirmed frozen
 * head and lasts until it is forgotten; while it lasts, the facts keep its
 * token, so the grant taken on them stays current as the chat's head moves on.
 */
export class ThreadOwnershipClaimFactsSource {
  private readonly lineages = new Map<string, { readonly token: object; readonly base: number }>()

  constructor(private readonly options: ThreadOwnershipClaimFactsSourceOptions) {}

  read(threadId: string): ThreadOwnershipClaimFacts | null {
    const { queue, confirmed } = this.options
    const frozen = queue.frozenHead(threadId)
    if (frozen) {
      const evidence = confirmed.get(frozen.commandId)
      if (
        evidence?.kind !== 'exact' ||
        evidence.threadId !== threadId ||
        evidence.revision !== frozen.revision
      )
        return null
      let lineage = this.lineages.get(threadId)
      if (!lineage || lineage.base !== frozen.revision) {
        lineage = Object.freeze({ token: {}, base: frozen.revision })
        this.lineages.set(threadId, lineage)
      }
      return { baseRevision: lineage.base, headRevision: lineage.base, lineageToken: lineage.token }
    }
    const lineage = this.lineages.get(threadId)
    if (!lineage) return null
    const admitted = queue.admittedHead(threadId)?.revision ?? lineage.base
    return {
      baseRevision: lineage.base,
      headRevision: Math.max(lineage.base, admitted),
      lineageToken: lineage.token
    }
  }

  /** The chat's lineage ended: released, rolled back or erased. */
  forget(threadId: string): void {
    this.lineages.delete(threadId)
  }
}

export interface ThreadOwnershipActivationSupplyOptions {
  readonly client: Pick<ThreadOwnershipClient, 'requestClaim' | 'release' | 'isCurrent'>
  readonly connection: { ensureConnected(): Promise<boolean> }
  readonly facts: Pick<ThreadOwnershipClaimFactsSource, 'forget'>
  /** Must carry the writer id the client claims under: the Host judges liveness by it. */
  readonly writer: ThreadAuthorityWriter
  readonly journal: OwnedThreadJournal
  /** The catalogue's erasure fence for the chat; a throw reads as erasing. */
  erasing?(chatId: string): boolean
}

export interface ThreadOwnershipActivationSupply {
  readonly registry: ThreadOwnershipActivationOptions['registry']
  readonly ownedAppend: ThreadOwnershipActivationOptions['ownedAppend']
  readonly mark: {
    readonly writer: ThreadAuthorityWriter
    grantedAtRevision(chatId: string, reservation: ThreadOwnershipReservation): number
  }
}

export function createThreadOwnershipActivationSupply(
  options: ThreadOwnershipActivationSupplyOptions
): ThreadOwnershipActivationSupply {
  const { client, connection, facts, journal } = options
  // Only reservations minted here carry a grant; a copy or a stranger has none.
  const grants = new WeakMap<ThreadOwnershipReservation, ThreadOwnershipNetworkGrant>()

  const grantOf = (reservation: ThreadOwnershipReservation): ThreadOwnershipNetworkGrant => {
    const grant = grants.get(reservation)
    if (!grant) throw new ReservationInvalid('not_minted')
    return grant
  }

  return {
    registry: {
      async claim(threadId) {
        if (!(await connection.ensureConnected())) {
          throw new ThreadOwnershipClaimNotGranted({
            kind: 'not_requested',
            reason: 'disconnected'
          })
        }
        const outcome = await client.requestClaim(threadId)
        if (outcome.kind !== 'network_grant') throw new ThreadOwnershipClaimNotGranted(outcome)
        const grant = outcome.grant
        const reservation: ThreadOwnershipReservation = Object.freeze({
          threadId,
          epoch: grant.epoch,
          revalidate: () => {
            // The grant left this socket, or the lineage it was taken on ended.
            if (grants.get(reservation) !== grant || !client.isCurrent(grant)) {
              throw new ReservationInvalid('mark_moved')
            }
          },
          erasing: () => {
            try {
              return options.erasing?.(threadId) === true
            } catch {
              return true
            }
          }
        })
        grants.set(reservation, grant)
        return reservation
      },
      async release(reservation) {
        const grant = grants.get(reservation)
        if (!grant) return
        grants.delete(reservation)
        facts.forget(reservation.threadId)
        // The coordinator removes the mark before it releases. A stale answer
        // means the socket that held the grant is gone, and the Host revoked
        // the grant as it closed.
        const outcome = await client.release(grant, null)
        if (outcome.kind === 'failed' || outcome.kind === 'refused') {
          throw new Error(`Thread ownership release ${outcome.kind}`)
        }
      }
    },
    async ownedAppend(intent: ChatSaveIntent, reservation) {
      reservation.revalidate()
      const revision = chatPersistenceRevision(intent.record)
      const held = await ownedJournalHolds(journal, intent.chatId, revision)
      reservation.revalidate()
      if (!held) {
        throw new Error('The owned journal does not hold the save')
      }
      // No Host stored this: the revision is confirmed by the owned journal
      // alone, which is what `reanchor` evidence carries (no byte identity).
      return Object.freeze({
        kind: 'reanchor' as const,
        threadId: intent.chatId,
        commandId: intent.commandId,
        revision
      })
    },
    mark: {
      writer: Object.freeze({ ...options.writer }),
      grantedAtRevision(chatId, reservation) {
        const grant = grantOf(reservation)
        if (grant.threadId !== chatId) throw new ReservationInvalid('not_minted')
        return grant.facts.baseRevision
      }
    }
  }
}

/** Owned-journal confirmations are not Host receipts and are never stored as one. */
export const ownedReceipts: ThreadOwnershipActivationOptions['receiptStore'] = {
  record: async () => undefined
}

export interface ThreadOwnershipActivationTriggerOptions {
  readonly queue: Pick<PerChatSaveIntentQueue, 'admittedHead' | 'requeue'>
  readonly activation: Pick<ThreadOwnershipActivationCoordinator, 'activate' | 'isActive'>
  readonly onOutcome?: (chatId: string, result: ThreadOwnershipActivationResult) => void
  readonly onError?: (error: unknown) => void
}

export interface ThreadOwnershipActivationTrigger {
  /** A Host receipt was durably recorded for a chat's authored save. */
  confirmed(chatId: string, evidence: ThreadOwnershipReceiptEvidence): void
  /** Settles once every activation this trigger started has finished. */
  idle(): Promise<void>
  /**
   * Ask again for one chat after the user explicitly took its recovery hold
   * over. The coordinator still requires the exact confirmed head; this only
   * lifts the once-per-head refusal memory for that chat.
   */
  retry(chatId: string): Promise<ThreadOwnershipActivationResult | null>
  forget(chatId: string): void
}

/**
 * Asks for activation when the exact admitted head of a chat is confirmed in
 * Host storage, once per head: a refusal is not retried until a newer head is
 * confirmed, so a thread the Host will not grant is not asked again on every
 * receipt.
 */
export function createThreadOwnershipActivationTrigger(
  options: ThreadOwnershipActivationTriggerOptions
): ThreadOwnershipActivationTrigger {
  const attempted = new Map<string, string>()
  const running = new Set<Promise<void>>()
  const onError =
    options.onError ?? ((error) => console.error('[ownership-activation] failed', error))
  const start = (chatId: string): Promise<ThreadOwnershipActivationResult | null> => {
    const result = options.activation.activate(chatId).then((outcome) => {
      // A clean rollback reset the queue and handed every intent back.
      // They are saves no Host has confirmed yet: they stay pending.
      if (outcome.kind === 'failed' && !outcome.ownershipRetained) {
        for (const intent of outcome.pending.slice().reverse()) options.queue.requeue(intent)
      }
      options.onOutcome?.(chatId, outcome)
      return outcome
    })
    const attempt = result
      .then(
        () => undefined,
        (error) => onError(error)
      )
      .finally(() => running.delete(attempt))
    running.add(attempt)
    return result.catch(() => null)
  }
  return {
    confirmed(chatId, evidence) {
      if (evidence.kind !== 'exact' || evidence.threadId !== chatId) return
      if (options.activation.isActive(chatId)) return
      const head = options.queue.admittedHead(chatId)
      if (!head || head.revision !== evidence.revision) return
      if (attempted.get(chatId) === head.commandId) return
      attempted.set(chatId, head.commandId)
      void start(chatId)
    },
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running])
    },
    async retry(chatId) {
      if (options.activation.isActive(chatId)) return null
      const head = options.queue.admittedHead(chatId)
      if (!head) return null
      attempted.set(chatId, head.commandId)
      return start(chatId)
    },
    forget(chatId) {
      attempted.delete(chatId)
    }
  }
}
