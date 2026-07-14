import type {
  ChatRecord,
  ChatMessage,
  TranscriptMediaRef,
  TranscriptMediaSource
} from '../store/types'
import type { TranscriptMediaAssetStore } from './TranscriptMediaAssetStore'
import {
  createToolResultMediaRefs,
  type CreateToolResultMediaRefsOptions
} from './TranscriptMediaService'

export type TranscriptMediaOwnershipBatchStore = Pick<
  TranscriptMediaAssetStore,
  'grantMany' | 'owns' | 'write'
>

export type CreateOwnedToolResultMediaRefsOptions = Omit<
  CreateToolResultMediaRefsOptions,
  'assetWriter'
> & {
  /** Main-owned canonical chat id; never accept this from renderer-authored metadata. */
  appChatId?: string
  store: TranscriptMediaOwnershipBatchStore
}

export interface TransferTranscriptMediaRefsBatchOptions {
  sourceAppChatId: string
  targetAppChatId: string
  refs: readonly TranscriptMediaRef[]
  store: TranscriptMediaOwnershipBatchStore
  /** Main-owned relation check. It is invoked at most once for the whole batch. */
  verifyTransfer: (sourceAppChatId: string, targetAppChatId: string) => boolean
}

export interface TransferTranscriptMediaMessagesBatchOptions
  extends Omit<TransferTranscriptMediaRefsBatchOptions, 'refs'> {
  messages: readonly ChatMessage[]
}

export interface VerifyEmulatedForkMediaTransferOptions {
  canonicalSource: ChatRecord
  canonicalTargetShell: ChatRecord
  targetForkDraft: ChatRecord
  canonicalizeWorkspacePath: (workspacePath: string) => string
}

const STORE_BACKED_SOURCES = new Set<TranscriptMediaSource>([
  'generated',
  'tool_result',
  'upload'
])

function ownershipAssetKey(sha256: string, mimeType: string): string {
  return `${sha256}\u0000${mimeType.toLowerCase()}`
}

function redactStoreLocators(ref: TranscriptMediaRef): TranscriptMediaRef {
  const { sha256: _sha256, assetId: _assetId, path: _path, ...presentation } = ref
  return {
    ...presentation,
    status: 'denied'
  }
}

function needsOwnershipTransfer(ref: TranscriptMediaRef): boolean {
  if (!STORE_BACKED_SOURCES.has(ref.source)) return false
  if (ref.sha256 || ref.assetId || ref.path) return true
  return ref.status === undefined || ref.status === 'available'
}

/** Pure authority check for the empty-shell -> prepared-fork transition. */
export function isVerifiedEmulatedForkMediaTransfer(
  options: VerifyEmulatedForkMediaTransferOptions
): boolean {
  const { canonicalSource, canonicalTargetShell, targetForkDraft } = options
  if (
    canonicalSource.archived ||
    canonicalTargetShell.archived ||
    targetForkDraft.archived ||
    canonicalTargetShell.messages.length !== 0 ||
    targetForkDraft.messages.length !== 0 ||
    canonicalTargetShell.appChatId !== targetForkDraft.appChatId ||
    canonicalTargetShell.parentChatId !== canonicalSource.appChatId ||
    canonicalTargetShell.parentChatRelation !== 'sideChat' ||
    targetForkDraft.parentChatId !== canonicalSource.appChatId ||
    targetForkDraft.parentChatRelation !== 'sideChat' ||
    targetForkDraft.forkContext?.kind !== 'emulated' ||
    targetForkDraft.forkContext.sourceChatId !== canonicalSource.appChatId ||
    canonicalSource.scope !== canonicalTargetShell.scope ||
    canonicalSource.scope !== targetForkDraft.scope
  ) {
    return false
  }
  if (canonicalSource.scope === 'global') return true
  if (
    !canonicalSource.workspaceId ||
    canonicalSource.workspaceId !== canonicalTargetShell.workspaceId ||
    canonicalSource.workspaceId !== targetForkDraft.workspaceId ||
    !canonicalSource.workspacePath ||
    !canonicalTargetShell.workspacePath ||
    !targetForkDraft.workspacePath
  ) {
    return false
  }
  try {
    const sourceWorkspacePath = options.canonicalizeWorkspacePath(
      canonicalSource.workspacePath
    )
    return (
      options.canonicalizeWorkspacePath(canonicalTargetShell.workspacePath) ===
        sourceWorkspacePath &&
      options.canonicalizeWorkspacePath(targetForkDraft.workspacePath) === sourceWorkspacePath
    )
  } catch {
    return false
  }
}

/**
 * Build tool/provider image refs while keeping the content write separate from
 * ownership. Only assets whose unowned write succeeded enter one atomic grant;
 * no store locator is returned unless that grant also succeeded.
 */
export function createOwnedToolResultMediaRefs(
  options: CreateOwnedToolResultMediaRefsOptions
): TranscriptMediaRef[] {
  const { appChatId, store, ...refOptions } = options
  const canonicalChatId = appChatId?.trim()
  const successfullyWrittenAssets = new Set<string>()
  const failedAssetWrites = new Set<string>()
  const refs = createToolResultMediaRefs({
    ...refOptions,
    assetWriter: ({ sha256, buffer, mimeType }) => {
      if (!canonicalChatId) return
      const key = ownershipAssetKey(sha256, mimeType)
      try {
        const written = store.write({ sha256, buffer, mimeType })
        if (written.ok && !failedAssetWrites.has(key)) {
          successfullyWrittenAssets.add(key)
          return
        }
      } catch {
        // A throwing content write poisons every duplicate ref for this asset.
      }
      failedAssetWrites.add(key)
      successfullyWrittenAssets.delete(key)
    }
  })

  const grantsByAsset = new Map<
    string,
    { sha256: string; mimeType: string; appChatId: string }
  >()
  for (const ref of refs) {
    if (!canonicalChatId) continue
    if (!ref.sha256 || !ref.mimeType) continue
    const key = ownershipAssetKey(ref.sha256, ref.mimeType)
    if (!successfullyWrittenAssets.has(key) || grantsByAsset.has(key)) continue
    grantsByAsset.set(key, {
      sha256: ref.sha256,
      mimeType: ref.mimeType,
      appChatId: canonicalChatId
    })
  }

  let batchGranted = false
  if (grantsByAsset.size > 0) {
    try {
      batchGranted = store.grantMany([...grantsByAsset.values()]).ok
    } catch {
      // Ownership is the authority boundary. A throwing store fails closed.
    }
  }

  return refs.map((ref) => {
    if (!ref.sha256 || !ref.mimeType) return ref
    const written = successfullyWrittenAssets.has(ownershipAssetKey(ref.sha256, ref.mimeType))
    return written && batchGranted ? ref : redactStoreLocators(ref)
  })
}

/**
 * Transfer a flat ref set through one independently trusted relationship check
 * and one atomic target grant. Source ownership is required per unique asset.
 * Presentation-only error refs and non-store workspace refs are preserved.
 */
export function transferTranscriptMediaRefsBatch(
  options: TransferTranscriptMediaRefsBatchOptions
): TranscriptMediaRef[] {
  const { sourceAppChatId, targetAppChatId, refs, store, verifyTransfer } = options
  const candidateIndexes: number[] = []
  for (let index = 0; index < refs.length; index += 1) {
    if (needsOwnershipTransfer(refs[index])) candidateIndexes.push(index)
  }
  if (candidateIndexes.length === 0) return [...refs]

  let relationVerified = false
  try {
    relationVerified = verifyTransfer(sourceAppChatId, targetAppChatId)
  } catch {
    // A relation verifier is an authority boundary. Exceptions fail closed.
  }
  if (!relationVerified) {
    const candidates = new Set(candidateIndexes)
    return refs.map((ref, index) =>
      candidates.has(index) ? redactStoreLocators(ref) : ref
    )
  }

  const sourceOwnershipByAsset = new Map<string, boolean>()
  const grantableIndexes = new Set<number>()
  const grantsByAsset = new Map<
    string,
    { sha256: string; mimeType: string; appChatId: string }
  >()
  for (const index of candidateIndexes) {
    const ref = refs[index]
    if (!ref.sha256 || !ref.mimeType) continue
    const key = ownershipAssetKey(ref.sha256, ref.mimeType)
    let sourceOwns = sourceOwnershipByAsset.get(key)
    if (sourceOwns === undefined) {
      try {
        sourceOwns = store.owns({
          sha256: ref.sha256,
          mimeType: ref.mimeType,
          appChatId: sourceAppChatId
        })
      } catch {
        sourceOwns = false
      }
      sourceOwnershipByAsset.set(key, sourceOwns)
    }
    if (!sourceOwns) continue
    grantableIndexes.add(index)
    if (!grantsByAsset.has(key)) {
      grantsByAsset.set(key, {
        sha256: ref.sha256,
        mimeType: ref.mimeType,
        appChatId: targetAppChatId
      })
    }
  }

  let batchGranted = false
  if (grantsByAsset.size > 0) {
    try {
      batchGranted = store.grantMany([...grantsByAsset.values()]).ok
    } catch {
      // Keep every target locator redacted if the atomic grant cannot be proven.
    }
  }

  const candidates = new Set(candidateIndexes)
  return refs.map((ref, index) => {
    if (!candidates.has(index)) return ref
    return batchGranted && grantableIndexes.has(index) ? ref : redactStoreLocators(ref)
  })
}

/**
 * Flatten every message's media refs through one transfer batch, then rebuild
 * fresh message/metadata objects without mutating the canonical source chat.
 */
export function transferTranscriptMediaMessagesBatch(
  options: TransferTranscriptMediaMessagesBatchOptions
): ChatMessage[] {
  const spans = new Map<number, { start: number; length: number }>()
  const refs: TranscriptMediaRef[] = []
  for (let index = 0; index < options.messages.length; index += 1) {
    const messageRefs = Array.isArray(options.messages[index].metadata?.mediaRefs)
      ? (options.messages[index].metadata?.mediaRefs as TranscriptMediaRef[])
      : []
    if (messageRefs.length === 0) continue
    spans.set(index, { start: refs.length, length: messageRefs.length })
    refs.push(...messageRefs)
  }
  const transferred = transferTranscriptMediaRefsBatch({
    sourceAppChatId: options.sourceAppChatId,
    targetAppChatId: options.targetAppChatId,
    refs,
    store: options.store,
    verifyTransfer: options.verifyTransfer
  })
  return options.messages.map((message, index) => {
    const span = spans.get(index)
    if (!span) return { ...message }
    return {
      ...message,
      metadata: {
        ...(message.metadata || {}),
        mediaRefs: transferred.slice(span.start, span.start + span.length)
      }
    }
  })
}
