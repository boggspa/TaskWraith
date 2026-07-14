import type {
  ExternalPathGrant,
  PersistedAttachmentRef,
  PersistedOrLegacyAttachmentRef
} from './store/types'
import type { TranscriptMediaAssetStore } from './services/TranscriptMediaAssetStore'
import { snapshotRasterOrPdfAttachment } from './services/TranscriptMediaService'
import { MAX_DURABLE_ATTACHMENT_REFS } from './ScheduledAttachmentDurability'

type RunQueueAttachmentStore = Pick<
  TranscriptMediaAssetStore,
  'grantMany' | 'owns' | 'resolvePersistedAttachment' | 'writeContentAddressed'
>

export type OwnedPersistedRunQueueAttachmentResult =
  | { ok: true; attachment: PersistedAttachmentRef }
  | { ok: false; reason: 'invalid_reference' | 'not_owner' }

/**
 * A renderer may replay a durable content-addressed reference, but possession
 * of its hash/path is not ownership. Queue staging may reuse the bytes only
 * when the exact canonical chat already owns the asset; it must never mint a
 * new ownership grant from renderer-supplied metadata.
 */
export function resolveOwnedPersistedRunQueueAttachment(input: {
  store: Pick<TranscriptMediaAssetStore, 'owns' | 'resolvePersistedAttachment'>
  attachment: PersistedAttachmentRef
  appChatId?: string
}): OwnedPersistedRunQueueAttachmentResult {
  const existing = input.store.resolvePersistedAttachment(input.attachment)
  if (!existing.ok) return { ok: false, reason: 'invalid_reference' }
  const appChatId = input.appChatId?.trim()
  if (
    !appChatId ||
    !input.store.owns({
      sha256: existing.attachment.sha256,
      mimeType: existing.attachment.mimeType,
      appChatId
    })
  ) {
    return { ok: false, reason: 'not_owner' }
  }
  return existing
}

export interface MainOwnedRunQueueAttachmentStageInput {
  chatId?: string
  workspacePath?: string
  externalPathGrants: ExternalPathGrant[]
  authorizedFilePaths?: string[]
  attachments: PersistedOrLegacyAttachmentRef[]
}

export type MainOwnedRunQueueAttachmentStageResult =
  | { ok: true; attachments: PersistedAttachmentRef[] }
  | { ok: false; reason: string }

export interface MainOwnedRunQueueAttachmentStageDeps {
  getAssetStore: () => RunQueueAttachmentStore
  getAuthorizedFilePaths?: () => readonly string[]
}

/**
 * Snapshot fresh queue attachments first, then establish any chat ownership in
 * one durable ledger replacement before returning a locator-bearing ref set.
 * Replayed v1 refs remain owns-only and can never mint authority from metadata.
 */
export function createMainOwnedRunQueueAttachmentStager(
  deps: MainOwnedRunQueueAttachmentStageDeps
): (input: MainOwnedRunQueueAttachmentStageInput) => MainOwnedRunQueueAttachmentStageResult {
  return (input) => {
    if (input.attachments.length > MAX_DURABLE_ATTACHMENT_REFS) {
      return { ok: false, reason: 'Attachment snapshot failed.' }
    }
    const attachments: PersistedAttachmentRef[] = []
    const pendingOwnership: Array<{ sha256: string; mimeType: string; appChatId: string }> = []
    try {
      const store = deps.getAssetStore()
      for (const attachment of input.attachments) {
        if ('persistenceVersion' in attachment && attachment.persistenceVersion === 1) {
          const existing = resolveOwnedPersistedRunQueueAttachment({
            store,
            attachment,
            appChatId: input.chatId
          })
          if (!existing.ok) return { ok: false, reason: 'Attachment snapshot failed.' }
          attachments.push({
            ...existing.attachment,
            ...(attachment.id ? { id: attachment.id } : {}),
            ...(attachment.name ? { name: attachment.name } : {})
          })
          continue
        }
        const snapshot = snapshotRasterOrPdfAttachment({
          candidatePath: attachment.path,
          workspacePath: input.workspacePath,
          externalPathGrants: input.externalPathGrants,
          authorizedFilePaths:
            input.authorizedFilePaths ?? [...(deps.getAuthorizedFilePaths?.() || [])]
        })
        if (!snapshot.ok) return { ok: false, reason: 'Attachment snapshot failed.' }
        const persisted = store.writeContentAddressed({
          buffer: snapshot.buffer,
          mimeType: snapshot.mimeType
        })
        if (!persisted.ok) return { ok: false, reason: 'Attachment snapshot failed.' }
        attachments.push({
          persistenceVersion: 1,
          ...(attachment.id ? { id: attachment.id } : {}),
          path: persisted.path,
          ...(attachment.name ? { name: attachment.name } : {}),
          sha256: persisted.sha256,
          mimeType: persisted.mimeType,
          byteLength: persisted.byteLength
        })
        if (input.chatId) {
          pendingOwnership.push({
            sha256: persisted.sha256,
            mimeType: persisted.mimeType,
            appChatId: input.chatId
          })
        }
      }
      if (pendingOwnership.length > 0) {
        const granted = store.grantMany(pendingOwnership)
        if (!granted.ok) return { ok: false, reason: 'Attachment snapshot failed.' }
      }
      return { ok: true, attachments }
    } catch {
      return { ok: false, reason: 'Attachment snapshot failed.' }
    }
  }
}
