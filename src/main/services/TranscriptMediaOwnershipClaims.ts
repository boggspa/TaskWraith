import type { ChatRecord, TranscriptMediaRef } from '../store/types'

export interface TranscriptMediaOwnershipLookup {
  owns(input: { sha256: string; mimeType: string; appChatId: string }): boolean
}

function isStoreBackedRef(ref: TranscriptMediaRef): boolean {
  return (
    ref.source === 'generated' ||
    ref.source === 'tool_result' ||
    ref.source === 'upload'
  )
}

function redactUnownedAssetClaim(ref: TranscriptMediaRef): TranscriptMediaRef {
  const {
    sha256: _sha256,
    assetId: _assetId,
    path: _path,
    ...presentation
  } = ref
  return {
    ...presentation,
    status: 'denied'
  }
}

/**
 * Treat transcript metadata as presentation data, never as an ownership grant.
 *
 * Renderer saves contain full chat snapshots and may therefore carry arbitrary
 * `mediaRefs`. A store-backed ref remains usable only when the main-owned
 * ownership ledger already binds its exact content address to this exact chat.
 * Unknown claims retain harmless presentation metadata (thumbnail/caption) but
 * lose every store locator, so persisting and restarting cannot turn knowledge
 * of another chat's hash into access to that asset.
 */
export function sanitizeTranscriptMediaOwnershipClaims(
  chat: ChatRecord,
  ownership: TranscriptMediaOwnershipLookup
): ChatRecord {
  if (!Array.isArray(chat.messages) || chat.messages.length === 0) return chat

  let changed = false
  const messages = chat.messages.map((message) => {
    const refs = Array.isArray(message.metadata?.mediaRefs)
      ? (message.metadata.mediaRefs as TranscriptMediaRef[])
      : null
    if (!refs || refs.length === 0) return message

    let refsChanged = false
    const nextRefs = refs.map((ref) => {
      if (!isStoreBackedRef(ref)) return ref
      const owned =
        typeof ref.sha256 === 'string' &&
        ref.sha256.length > 0 &&
        typeof ref.mimeType === 'string' &&
        ref.mimeType.length > 0 &&
        ownership.owns({
          sha256: ref.sha256,
          mimeType: ref.mimeType,
          appChatId: chat.appChatId
        })
      if (owned) return ref
      if (!ref.sha256 && !ref.assetId && !ref.path && ref.status === 'denied') return ref
      refsChanged = true
      return redactUnownedAssetClaim(ref)
    })
    if (!refsChanged) return message
    changed = true
    return {
      ...message,
      metadata: {
        ...(message.metadata || {}),
        mediaRefs: nextRefs
      }
    }
  })

  return changed ? { ...chat, messages } : chat
}
