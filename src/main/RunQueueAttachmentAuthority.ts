import { createHash } from 'crypto'
import type {
  DirectoryAttachmentRef,
  ExternalPathGrant,
  PersistedAttachmentRef,
  RunQueueJob,
  RunQueueImageAttachmentSnapshot
} from './store/types'
import {
  isPersistedAttachmentRef,
  type TranscriptMediaAssetStore
} from './services/TranscriptMediaAssetStore'
import { snapshotRasterOrPdfAttachment } from './services/TranscriptMediaService'
import { MAX_DURABLE_ATTACHMENT_REFS } from './ScheduledAttachmentDurability'
import { isDirectoryComposerAttachment } from '../shared/composerAttachment'

type RunQueueAttachmentStore = Pick<
  TranscriptMediaAssetStore,
  'owns' | 'resolvePersistedAttachment' | 'writeContentAddressed' | 'writeOwnedMany'
>

export type OwnedPersistedRunQueueAttachmentResult =
  | { ok: true; attachment: PersistedAttachmentRef }
  | { ok: false; reason: 'invalid_reference' | 'not_owner' }

export interface MainOwnedQueuedComposerAttachments {
  imageAttachments: PersistedAttachmentRef[]
}

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

/**
 * Recover the exact chat-owned snapshots for a queued renderer dispatch.
 *
 * A queued file attachment stops being renderer-owned when RunQueueService
 * copies it into transcript-media. The later renderer may be a different
 * window (or a replacement renderer after restart), so requiring its ephemeral
 * picker receipt for that main-owned path is both impossible and incorrect.
 * Only a leased, previously-enqueued job with exact chat/provider/run identity
 * may cross this seam, and every ref is re-resolved through the chat ownership
 * ledger before it is returned. Directory references stay renderer-authorized
 * because their live contents cannot be snapshotted.
 */
export function resolveMainOwnedQueuedComposerAttachments(input: {
  store: Pick<TranscriptMediaAssetStore, 'owns' | 'resolvePersistedAttachment'>
  job: RunQueueJob | null | undefined
  appRunId: string
  appChatId: string
  provider?: string
}): MainOwnedQueuedComposerAttachments | null {
  const job = input.job
  if (
    !job ||
    job.runId !== input.appRunId ||
    job.chatId !== input.appChatId ||
    job.status !== 'starting' ||
    !job.enqueuedAt ||
    !job.request ||
    (input.provider && job.provider !== input.provider)
  ) {
    return null
  }

  const imageAttachments: PersistedAttachmentRef[] = []
  for (const attachment of job.request.imageAttachments) {
    if (isDirectoryComposerAttachment(attachment)) return null
    if (!isPersistedAttachmentRef(attachment)) return null
    const resolved = resolveOwnedPersistedRunQueueAttachment({
      store: input.store,
      attachment,
      appChatId: input.appChatId
    })
    if (!resolved.ok) return null
    imageAttachments.push({
      ...resolved.attachment,
      ...(attachment.id ? { id: attachment.id } : {}),
      ...(attachment.name ? { name: attachment.name } : {})
    })
  }
  return { imageAttachments }
}

export interface MainOwnedRunQueueAttachmentStageInput {
  chatId?: string
  workspacePath?: string
  externalPathGrants: ExternalPathGrant[]
  authorizedFilePaths?: string[]
  attachments: RunQueueImageAttachmentSnapshot[]
}

export type MainOwnedRunQueueAttachmentStageResult =
  | { ok: true; attachments: RunQueueImageAttachmentSnapshot[] }
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
    const slots: Array<
      | { kind: 'persisted'; attachment: PersistedAttachmentRef }
      | { kind: 'directory'; attachment: DirectoryAttachmentRef }
      | { kind: 'pending'; index: number; id?: string; name?: string }
    > = []
    const pendingWrites: Array<{
      sha256: string
      mimeType: string
      buffer: Buffer
      appChatId: string
    }> = []
    try {
      const store = deps.getAssetStore()
      const authorizedPaths = new Set(
        input.authorizedFilePaths ?? [...(deps.getAuthorizedFilePaths?.() || [])]
      )
      for (const attachment of input.attachments) {
        if (isDirectoryComposerAttachment(attachment)) {
          if (!authorizedPaths.has(attachment.path)) {
            return { ok: false, reason: 'Attachment snapshot failed.' }
          }
          slots.push({
            kind: 'directory',
            attachment: {
              kind: 'directory',
              ...(attachment.id ? { id: attachment.id } : {}),
              path: attachment.path,
              ...(attachment.name ? { name: attachment.name } : {})
            }
          })
          continue
        }
        if ('persistenceVersion' in attachment && attachment.persistenceVersion === 1) {
          const existing = resolveOwnedPersistedRunQueueAttachment({
            store,
            attachment,
            appChatId: input.chatId
          })
          if (!existing.ok) return { ok: false, reason: 'Attachment snapshot failed.' }
          slots.push({
            kind: 'persisted',
            attachment: {
              ...existing.attachment,
              ...(attachment.id ? { id: attachment.id } : {}),
              ...(attachment.name ? { name: attachment.name } : {})
            }
          })
          continue
        }
        const snapshot = snapshotRasterOrPdfAttachment({
          candidatePath: attachment.path,
          workspacePath: input.workspacePath,
          externalPathGrants: input.externalPathGrants,
          authorizedFilePaths: [...authorizedPaths]
        })
        if (!snapshot.ok) return { ok: false, reason: 'Attachment snapshot failed.' }
        if (!input.chatId) {
          const persisted = store.writeContentAddressed({
            buffer: snapshot.buffer,
            mimeType: snapshot.mimeType
          })
          if (!persisted.ok) return { ok: false, reason: 'Attachment snapshot failed.' }
          slots.push({
            kind: 'persisted',
            attachment: {
              persistenceVersion: 1,
              ...(attachment.id ? { id: attachment.id } : {}),
              path: persisted.path,
              ...(attachment.name ? { name: attachment.name } : {}),
              sha256: persisted.sha256,
              mimeType: persisted.mimeType,
              byteLength: persisted.byteLength
            }
          })
          continue
        }
        const pendingIndex = pendingWrites.length
        pendingWrites.push({
          sha256: createHash('sha256').update(snapshot.buffer).digest('base64url'),
          mimeType: snapshot.mimeType,
          buffer: snapshot.buffer,
          appChatId: input.chatId
        })
        slots.push({
          kind: 'pending',
          index: pendingIndex,
          ...(attachment.id ? { id: attachment.id } : {}),
          ...(attachment.name ? { name: attachment.name } : {})
        })
      }
      const written =
        pendingWrites.length > 0
          ? store.writeOwnedMany(pendingWrites)
          : { ok: true as const, assets: [] }
      if (!written.ok) return { ok: false, reason: 'Attachment snapshot failed.' }
      return {
        ok: true,
        attachments: slots.map((slot) => {
          if (slot.kind === 'persisted' || slot.kind === 'directory') return slot.attachment
          const asset = written.assets[slot.index]
          return {
            persistenceVersion: 1,
            ...(slot.id ? { id: slot.id } : {}),
            path: asset.path,
            ...(slot.name ? { name: slot.name } : {}),
            sha256: asset.sha256,
            mimeType: asset.mimeType,
            byteLength: asset.byteLength
          }
        })
      }
    } catch {
      return { ok: false, reason: 'Attachment snapshot failed.' }
    }
  }
}
