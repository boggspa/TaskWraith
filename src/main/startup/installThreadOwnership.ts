/**
 * Composition wiring for the I7 thread-ownership activation path.
 *
 * `installStartupThreadCatalogue` (in `installThreadCatalogue.ts`) owns
 * the catalogue and the recovery controller; this file owns the receipt-
 * evidence store and the save-intent port, and decides which coordinator
 * stands behind them.
 *
 * Without activation seams, or while thread log authority is not honoured by
 * this process, a placeholder stands in: `isActive` is false everywhere and
 * `deactivate` does nothing. With both, the real
 * `ThreadOwnershipActivationCoordinator` is built from the seams plus the
 * pieces this file owns (queue, receipt store, head-receipt lookup, authority
 * files). The seams are the parts only a live Host connection can supply: the
 * claim, the publication binding, the owned-journal append and the grant
 * revision the mark records. None has a default that would invent one, so an
 * incomplete wiring fails closed (the activation rolls back and hands the
 * queued saves back) rather than writing a mark or a receipt nobody earned.
 * Production transport and journal suppliers are composed by
 * `ThreadOwnershipProduction` when `production` is passed and no explicit
 * seams are. With a real coordinator, a durably recorded exact receipt for a
 * chat's admitted head asks for activation once per head.
 */
import { app } from 'electron'
import { join } from 'path'
import { HostThreadPublicationGuard } from '../../host-runtime/HostThreadPublicationGuard'
import {
  ThreadAuthorityFiles,
  type ThreadAuthorityWriter
} from '../../host-shared/thread-log/ThreadAuthorityFile'
import type { ThreadOwnershipReservation } from '../../host-shared/thread-log/ThreadOwnership'
import {
  HostOwnershipReceiptEvidenceStore,
  createFileReceiptEvidencePersistence
} from '../host/HostOwnershipReceiptEvidenceStore'
import {
  ThreadOwnershipActivationCoordinator,
  createChatSaveOwnershipWiring,
  createHeadReceiptLookup,
  type ThreadOwnershipActivationOptions
} from '../services/ThreadOwnershipActivationCoordinator'
import { resolveThreadDurabilitySwitches } from '../store/ThreadBarrierDurabilitySwitch'
import type { PerChatSaveIntentQueue } from '../../shared/chatSaveIntentQueue'
import type { CatalogueErasureJoins } from './ThreadCatalogueErasureCallbacks'
import type { ThreadOwnershipReceiptEvidence } from '../host/ThreadOwnershipReceiptEvidence'
import type { ChatSaveOwnershipPort } from '../../shared/chatSaveIntentQueue'
import {
  createThreadOwnershipActivationTrigger,
  ownedReceipts,
  type ThreadOwnershipActivationTrigger
} from '../host/ThreadOwnershipActivationSupplier'
import {
  composeThreadOwnershipProduction,
  type ThreadOwnershipProduction,
  type ThreadOwnershipProductionOptions
} from './ThreadOwnershipProduction'

/**
 * Who the authority mark names, and the Host revision it was granted at. The
 * revision matters: the log above `grantedAtRevision` is read as the owner's
 * unpublished work, so a guess too low makes the Host fold rows it already
 * holds. It comes from the grant's confirmed facts, never a default.
 */
export interface ThreadOwnershipMarkIdentity {
  /** Must be the writer id the claim was made under: the Host judges liveness by it. */
  readonly writer: ThreadAuthorityWriter
  grantedAtRevision(chatId: string, reservation: ThreadOwnershipReservation): number
}

/** Writes the authority mark for a grant. A write the files reject rolls the activation back. */
export function createAuthorityMarkWriter(options: {
  readonly files: Pick<ThreadAuthorityFiles, 'write'>
  readonly identity: ThreadOwnershipMarkIdentity
  readonly now?: () => number
}): ThreadOwnershipActivationOptions['markWriter'] {
  const now = options.now ?? Date.now
  return async (chatId, reservation) => {
    await options.files.write({
      threadId: chatId,
      writer: options.identity.writer,
      epoch: reservation.epoch,
      grantedAtRevision: options.identity.grantedAtRevision(chatId, reservation),
      grantedAt: now()
    })
  }
}

/** What only a live Host connection can supply to the coordinator. */
export interface ThreadOwnershipActivationSeams {
  /** Claims on the same authenticated connection the Host granted on. */
  readonly registry: ThreadOwnershipActivationOptions['registry']
  /**
   * One owned-journal append, confirmed by the owned journal's barrier. There
   * is deliberately no default: a stand-in that resolved with `exact` evidence
   * would settle the queued saves as durable without any journal holding them.
   */
  readonly ownedAppend: ThreadOwnershipActivationOptions['ownedAppend']
  /** Defaults to an inert guard (no registry), which only commits the read. */
  readonly publicationGuard?: ThreadOwnershipActivationOptions['publicationGuard']
  /** Defaults to an unowned, never-current binding; supply one with a registry-backed guard. */
  readonly bindingFor?: ThreadOwnershipActivationOptions['bindingFor']
  /** Either this or `mark` is required. */
  readonly markWriter?: ThreadOwnershipActivationOptions['markWriter']
  readonly mark?: ThreadOwnershipMarkIdentity
  /** Defaults to the profile's `ThreadAuthorityFiles`. */
  readonly authorityFiles?: Pick<ThreadAuthorityFiles, 'write' | 'remove'>
  /** Profile root for the default authority files; defaults to Electron's userData. */
  readonly profilePath?: string
  /**
   * Defaults to a no-op pair. This process resolved the authority switch once
   * at startup and keeps that answer for its life; flipping the environment
   * variable here would make later readers disagree with the Host.
   */
  readonly authoritySwitch?: ThreadOwnershipActivationOptions['authoritySwitch']
  readonly erasing?: ThreadOwnershipActivationOptions['erasing']
  readonly hasOwnedRows?: ThreadOwnershipActivationOptions['hasOwnedRows']
  readonly erasureFenceTimeoutMs?: number
}

export interface InstallThreadOwnershipOptions {
  /** The save-intent queue the activation coordinator drains on every activate. */
  readonly saveIntentQueue: PerChatSaveIntentQueue
  /** Optional persisted-evidence file path; defaults to the Electron userData path. */
  readonly evidenceFile?: string
  /** Optional mint id; defaults to a UUID v4. */
  readonly mintId?: () => string
  /** Optional error reporter; defaults to console.error. */
  readonly onError?: (error: unknown) => void
  /** Builds the real coordinator when present and log authority is honoured. */
  readonly activation?: ThreadOwnershipActivationSeams
  /**
   * Composes the production seams (dedicated Host connection, negotiation
   * client, owned journal) when log authority is honoured and no explicit
   * `activation` seams were passed.
   */
  readonly production?: ThreadOwnershipProductionOptions
  /**
   * Whether this process honours thread log authority. Defaults to the
   * resolved switch, which also requires barrier durability: the app ignores
   * authority without it and must never claim a thread.
   */
  readonly logAuthority?: boolean
}

export interface ThreadOwnershipWiring {
  /** Pass to `AppStore.installThreadOwnershipSavePort(port)`. */
  readonly port: ChatSaveOwnershipPort
  /**
   * Pass to `HostThreadRecordPersistClient`'s `onPersistedEvidence`.
   * Settles the queue once a receipt is durable.
   */
  readonly persistedEvidenceSink: (
    input: { readonly chatId: string; readonly ownershipIntentId?: string },
    evidence: ThreadOwnershipReceiptEvidence
  ) => Promise<void>
  /**
   * Pass to `installStartupThreadCatalogue({erasureJoins})`. Gives
   * erasure-begin a place to land an in-flight `activate()` and to forget
   * a chat's receipt evidence. The `coordinator` slot is present but its
   * `deactivate` is a no-op until the full registry is wired.
   */
  readonly erasureJoins: CatalogueErasureJoins
  /** The receipt store, in case another module needs direct access. */
  readonly receiptStore: HostOwnershipReceiptEvidenceStore
  /** What `port.isActive` and erasure consult: the real coordinator, or the placeholder. */
  readonly coordinator: Pick<ThreadOwnershipActivationCoordinator, 'isActive' | 'deactivate'>
  /** The real coordinator; null while activation is not wired. */
  readonly activation: ThreadOwnershipActivationCoordinator | null
  /** Asks for activation on confirmed heads; null while activation is not wired. */
  readonly trigger: ThreadOwnershipActivationTrigger | null
  /** The composed production suppliers; null unless `production` was used. */
  readonly production: ThreadOwnershipProduction | null
  /** Load the evidence from disk; call once at startup before the first record. */
  loadEvidence(): Promise<void>
  /** Close the ownership connection; grants on it end with it. */
  dispose(): void
}

export function installThreadOwnership(
  options: InstallThreadOwnershipOptions
): ThreadOwnershipWiring {
  const evidenceFile =
    options.evidenceFile ?? join(app.getPath('userData'), 'thread-ownership-receipts.json')
  const persistence = createFileReceiptEvidencePersistence(evidenceFile)
  const receiptStore = new HostOwnershipReceiptEvidenceStore(persistence)

  // Without seams, or while this process does not honour log authority,
  // `isActive` reports false everywhere and the queue stays a pure
  // bookkeeping surface.
  const placeholderCoordinator = {
    isActive: (_chatId: string) => false,
    deactivate: async (_chatId: string) => {
      // No-op until the full coordinator lands; the seam exists for
      // stage 4 erasure to land without throwing.
    }
  }
  const logAuthority =
    options.logAuthority ?? resolveThreadDurabilitySwitches(process.env, () => {}).logAuthority
  const headLookup = createHeadReceiptLookup({ queue: options.saveIntentQueue, receiptStore })
  const production =
    logAuthority && !options.activation && options.production
      ? composeThreadOwnershipProduction(options.production, options.saveIntentQueue, headLookup)
      : null
  const seams = options.activation ?? production?.seams
  const activation =
    logAuthority && seams ? buildActivationCoordinator(options, seams, headLookup) : null
  const coordinator = activation ?? placeholderCoordinator
  const onError =
    options.onError ?? ((error: unknown) => console.error('[ownership] activation failed', error))
  const trigger = activation
    ? createThreadOwnershipActivationTrigger({
        queue: options.saveIntentQueue,
        activation,
        onOutcome: (chatId, result) => {
          // A clean rollback released any grant; the lineage it began ends too.
          if (result.kind === 'failed' && !result.ownershipRetained)
            production?.facts.forget(chatId)
        },
        onRetry: (chatId) => production?.client.forgetRefusal(chatId),
        onError
      })
    : null

  const wiring = createChatSaveOwnershipWiring({
    queue: options.saveIntentQueue,
    receiptStore,
    coordinator,
    ...(trigger
      ? { onPublicationConfirmed: (chatId, evidence) => trigger.confirmed(chatId, evidence) }
      : {}),
    ...(production && activation
      ? {
          // The journal's word counts only while the grant still holds: a save
          // confirmed after the grant lapsed waits for Host storage instead.
          confirmOwnedSave: async (chatId: string, revision: number) => {
            const held = await production.confirmOwnedSave(chatId, revision)
            if (!held || !activation.isActive(chatId)) return false
            activation.noteOwnedCommit(chatId)
            return true
          }
        }
      : {}),
    ...(options.mintId ? { mintId: options.mintId } : {}),
    ...(options.onError ? { onError: options.onError } : {})
  })

  return {
    port: wiring.port,
    persistedEvidenceSink: wiring.persistedEvidenceSink,
    erasureJoins: {
      coordinator: {
        async deactivate(chatId) {
          trigger?.forget(chatId)
          await coordinator.deactivate(chatId)
          production?.facts.forget(chatId)
        }
      },
      followers: {
        forget(chatId) {
          // No-op until stage 3 wires a follower list; the seam exists so
          // erasure-begin does not throw on absent joins.
          void chatId
        },
        close() {
          // No-op until a global follower is composed.
        }
      },
      receiptStore: {
        async forgetChat(chatId) {
          await receiptStore.forgetChat(chatId)
        },
        async forgetAll() {
          await receiptStore.forgetAll()
        }
      }
    },
    receiptStore,
    coordinator,
    activation,
    trigger,
    production,
    loadEvidence: () => receiptStore.load(),
    dispose: () => production?.dispose()
  }
}

/**
 * Stands in for the shared authority switch. This process resolved it once at
 * startup and keeps that answer for its life; the activation path must not
 * flip the environment variable under later readers or the Host.
 */
const INERT_AUTHORITY_SWITCH = {
  enable: () => undefined,
  disable: () => undefined
}

function buildActivationCoordinator(
  options: InstallThreadOwnershipOptions,
  seams: ThreadOwnershipActivationSeams,
  headLookup: ThreadOwnershipActivationOptions['commandHandleStore']
): ThreadOwnershipActivationCoordinator {
  const authorityFiles =
    seams.authorityFiles ?? new ThreadAuthorityFiles(seams.profilePath ?? app.getPath('userData'))
  const markWriter =
    seams.markWriter ??
    (seams.mark ? createAuthorityMarkWriter({ files: authorityFiles, identity: seams.mark }) : null)
  if (!markWriter) {
    throw new Error('Thread ownership activation needs a markWriter or a mark identity')
  }
  return new ThreadOwnershipActivationCoordinator({
    queue: options.saveIntentQueue,
    registry: seams.registry,
    publicationGuard: seams.publicationGuard ?? new HostThreadPublicationGuard(null),
    bindingFor: seams.bindingFor ?? (() => ({ owner: null, isCurrent: () => false })),
    authorityFile: { remove: (chatId) => authorityFiles.remove(chatId) },
    markWriter,
    // Owned-journal confirmations are not Host receipts: kept apart, they can
    // never stand in for proof that a head reached Host storage.
    receiptStore: ownedReceipts,
    authoritySwitch: seams.authoritySwitch ?? INERT_AUTHORITY_SWITCH,
    commandHandleStore: headLookup,
    ownedAppend: seams.ownedAppend,
    ...(seams.erasing ? { erasing: seams.erasing } : {}),
    ...(seams.hasOwnedRows ? { hasOwnedRows: seams.hasOwnedRows } : {}),
    ...(seams.erasureFenceTimeoutMs !== undefined
      ? { erasureFenceTimeoutMs: seams.erasureFenceTimeoutMs }
      : {})
  })
}
