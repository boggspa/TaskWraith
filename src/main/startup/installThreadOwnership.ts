/**
 * Composition wiring for the I7 thread-ownership activation path.
 *
 * `installStartupThreadCatalogue` (in `installThreadCatalogue.ts`) owns
 * the catalogue and the recovery controller; this file owns the receipt-
 * evidence store and the save-intent port. The full activation coordinator
 * is wired through `erasureJoins` and the `persistedEvidenceSink` once a
 * production `HostThreadOwnerRegistry` is attached; this installer creates
 * the durable persistence now so the closeout can build, run the perf
 * harness, and the existing save-intent tests stay green.
 *
 * The activation path itself (registry.claim → markWriter → ownedAppend)
 * remains a follow-up: the recovery controller's `begin` flow does not
 * yet bridge into the activation coordinator's `activate`. The handoff
 * doc at .local-only/HANDOFF-i7-thread-custody.md covers the remaining
 * integration work.
 */
import { app } from 'electron'
import { join } from 'path'
import {
  HostOwnershipReceiptEvidenceStore,
  createFileReceiptEvidencePersistence
} from '../host/HostOwnershipReceiptEvidenceStore'
import { createChatSaveOwnershipWiring } from '../services/ThreadOwnershipActivationCoordinator'
import type { PerChatSaveIntentQueue } from '../../shared/chatSaveIntentQueue'
import type { CatalogueErasureJoins } from './ThreadCatalogueErasureCallbacks'
import type { ThreadOwnershipReceiptEvidence } from '../host/ThreadOwnershipReceiptEvidence'
import type { ChatSaveOwnershipPort } from '../../shared/chatSaveIntentQueue'

export interface InstallThreadOwnershipOptions {
  /** The save-intent queue the activation coordinator drains on every activate. */
  readonly saveIntentQueue: PerChatSaveIntentQueue
  /** Optional persisted-evidence file path; defaults to the Electron userData path. */
  readonly evidenceFile?: string
  /** Optional mint id; defaults to a UUID v4. */
  readonly mintId?: () => string
  /** Optional error reporter; defaults to console.error. */
  readonly onError?: (error: unknown) => void
}

export interface ThreadOwnershipWiring {
  /** Pass to `AppStore.installThreadOwnershipSavePort(port)`. */
  readonly port: ChatSaveOwnershipPort
  /**
   * Pass to `HostThreadRecordPersistClient`'s `onPersistedEvidence`.
   * Settles the queue once a receipt is durable.
   */
  readonly persistedEvidenceSink: (
    input: { readonly chatId: string },
    evidence: ThreadOwnershipReceiptEvidence
  ) => void
  /**
   * Pass to `installStartupThreadCatalogue({erasureJoins})`. Gives
   * erasure-begin a place to land an in-flight `activate()` and to forget
   * a chat's receipt evidence. The `coordinator` slot is present but its
   * `deactivate` is a no-op until the full registry is wired.
   */
  readonly erasureJoins: CatalogueErasureJoins
  /** The receipt store, in case another module needs direct access. */
  readonly receiptStore: HostOwnershipReceiptEvidenceStore
  /** Load the evidence from disk; call once at startup before the first record. */
  loadEvidence(): Promise<void>
}

export function installThreadOwnership(
  options: InstallThreadOwnershipOptions
): ThreadOwnershipWiring {
  const evidenceFile =
    options.evidenceFile ?? join(app.getPath('userData'), 'thread-ownership-receipts.json')
  const persistence = createFileReceiptEvidencePersistence(evidenceFile)
  const receiptStore = new HostOwnershipReceiptEvidenceStore(persistence)

  // The activation coordinator is built lazily: this closeout wires the
  // durable receipt store and the save-intent port, but `activate` would
  // require a real `HostThreadOwnerRegistry` to claim from, which the
  // recovery controller does not yet expose. Until that bridge is in
  // place, `isActive` reports false everywhere and the queue stays a
  // pure bookkeeping surface.
  const placeholderCoordinator = {
    isActive: (_chatId: string) => false,
    deactivate: async (_chatId: string) => {
      // No-op until the full coordinator lands; the seam exists for
      // stage 4 erasure to land without throwing.
    }
  }

  const wiring = createChatSaveOwnershipWiring({
    queue: options.saveIntentQueue,
    receiptStore,
    coordinator: placeholderCoordinator,
    ...(options.mintId ? { mintId: options.mintId } : {}),
    ...(options.onError ? { onError: options.onError } : {})
  })

  return {
    port: wiring.port,
    persistedEvidenceSink: wiring.persistedEvidenceSink,
    erasureJoins: {
      coordinator: {
        async deactivate(chatId) {
          await placeholderCoordinator.deactivate(chatId)
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
    loadEvidence: () => receiptStore.load()
  }
}
