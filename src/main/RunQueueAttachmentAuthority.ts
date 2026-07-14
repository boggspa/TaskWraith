import type { PersistedAttachmentRef } from './store/types'
import type { TranscriptMediaAssetStore } from './services/TranscriptMediaAssetStore'

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
  store: TranscriptMediaAssetStore
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
