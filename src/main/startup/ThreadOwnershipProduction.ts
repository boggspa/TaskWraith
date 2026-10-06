/**
 * The production suppliers behind desktop ownership activation.
 *
 * `installThreadOwnership` builds the coordinator from seams; this composes
 * the seams a running app gives it: a dedicated desktop-class Host connection
 * for claims, the negotiation client fed from confirmed receipts, the writer
 * identity the catalogue already knows this process by, and the journal the
 * store writes. Nothing here connects until the first claim, and nothing is
 * built at all unless this process honours thread log authority.
 */
import { app } from 'electron'
import { join } from 'path'
import type { ThreadAuthorityWriter } from '../../host-shared/thread-log/ThreadAuthorityFile'
import type { HostProjectionClient } from '../../host-client/HostProjectionClient'
import type { PerChatSaveIntentQueue } from '../../shared/chatSaveIntentQueue'
import { currentEnsembleRuntimeInstanceId } from '../EnsembleRuntimeIdentity'
import {
  DesktopThreadOwnerConnection,
  createDesktopThreadOwnerClient,
  type DesktopThreadOwnerTransport
} from '../host/DesktopThreadOwnerConnection'
import {
  ThreadOwnershipClaimFactsSource,
  createThreadOwnershipActivationSupply,
  ownedJournalHolds,
  ownedThreadJournal,
  type OwnedThreadJournal
} from '../host/ThreadOwnershipActivationSupplier'
import { ThreadOwnershipClient } from '../host/ThreadOwnershipClient'
import type { ThreadOwnershipReceiptEvidence } from '../host/ThreadOwnershipReceiptEvidence'
import type { ThreadOwnershipActivationSeams } from './installThreadOwnership'

export type ThreadOwnerTransport = DesktopThreadOwnerTransport &
  Pick<HostProjectionClient, 'requestThreadOwner'>

export interface ThreadOwnershipProductionOptions {
  /** Pays everything a chat's journal owes (the store's owned-journal barrier). */
  journalBarrier(chatId: string): Promise<void>
  /** Defaults to Electron's userData. */
  readonly userDataPath?: string
  /** Defaults to a fresh desktop-class connection of its own. */
  readonly transport?: ThreadOwnerTransport
  /** Defaults to the runtime identity this process registers with the catalogue. */
  readonly writer?: ThreadAuthorityWriter
  /** Defaults to the profile's `chat-journal-v2` read as the Host reads it. */
  readonly journal?: OwnedThreadJournal
  erasing?(chatId: string): boolean
  readonly log?: (line: string) => void
}

export interface ThreadOwnershipProduction {
  readonly seams: ThreadOwnershipActivationSeams
  readonly client: ThreadOwnershipClient
  readonly facts: ThreadOwnershipClaimFactsSource
  readonly connection: DesktopThreadOwnerConnection
  /** Whether the owned journal durably holds a save; settles owned saves. */
  confirmOwnedSave(chatId: string, revision: number): Promise<boolean>
  dispose(): void
}

export function composeThreadOwnershipProduction(
  options: ThreadOwnershipProductionOptions,
  queue: Pick<PerChatSaveIntentQueue, 'frozenHead' | 'admittedHead'>,
  confirmed: { get(commandId: string): ThreadOwnershipReceiptEvidence | null }
): ThreadOwnershipProduction {
  const userDataPath = options.userDataPath ?? app.getPath('userData')
  const writer = options.writer ?? {
    writerId: currentEnsembleRuntimeInstanceId(),
    pid: process.pid
  }
  const transport =
    options.transport ??
    createDesktopThreadOwnerClient({ userDataPath, appVersion: app.getVersion() })
  const journal =
    options.journal ??
    ownedThreadJournal({
      directory: join(userDataPath, 'chat-journal-v2'),
      barrier: (chatId) => options.journalBarrier(chatId)
    })
  const facts = new ThreadOwnershipClaimFactsSource({ queue, confirmed })
  const client = new ThreadOwnershipClient({
    enabled: true,
    writerId: writer.writerId,
    transport,
    readClaimFacts: (threadId) => facts.read(threadId)
  })
  const connection = new DesktopThreadOwnerConnection(transport, client, options.log)
  const supply = createThreadOwnershipActivationSupply({
    client,
    connection,
    facts,
    writer,
    journal,
    ...(options.erasing ? { erasing: options.erasing } : {})
  })
  return {
    seams: {
      registry: supply.registry,
      ownedAppend: supply.ownedAppend,
      mark: supply.mark,
      profilePath: userDataPath,
      ...(options.erasing ? { erasing: options.erasing } : {})
    },
    client,
    facts,
    connection,
    confirmOwnedSave: (chatId, revision) => ownedJournalHolds(journal, chatId, revision),
    dispose: () => connection.close()
  }
}
