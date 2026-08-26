import * as fs from 'fs'
import * as path from 'path'
import { isSafeChatId } from '../ChatPath'
import {
  applyChatComposerSelectionPatch,
  CHAT_COMPOSER_SELECTION_METADATA_KEYS,
  parseChatComposerSelectionPatchRequest,
  sanitizeChatComposerSelectionPatch,
  type ChatComposerSelectionPatch,
  type ChatComposerSelectionPatchRequest
} from '../../shared/chatComposerSelectionPatch'
import {
  queueProviderChange,
  readPendingProviderChange,
  type PendingProviderChange
} from '../../shared/providerChangeQueue'
import { writeJsonAtomically } from './ThreadWorktreeBindingPersistence'
import type { ChatRecord, ChatWorkflowMode } from './types'

const OVERLAY_SCHEMA_VERSION = 1
const OVERLAY_DIRECTORY_NAME = '.composer-selections'

interface StoredComposerSelectionOverlay {
  schemaVersion: typeof OVERLAY_SCHEMA_VERSION
  chatId: string
  baseRevision: number
  revision: number
  updatedAt: number
  providerMetadataPatch: ChatComposerSelectionPatch
  workflowMode?: ChatWorkflowMode
  pendingProviderChange?: PendingProviderChange
}

export interface PersistChatComposerSelectionOverlayResult {
  chat: ChatRecord
  changed: boolean
}

function persistenceRevision(chat: Pick<ChatRecord, 'persistenceRevision'>): number {
  const revision = chat.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? (revision as number) : 0
}

function parseStoredOverlay(value: unknown, chatId: string): StoredComposerSelectionOverlay | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<StoredComposerSelectionOverlay>
  const providerMetadataPatch = selectionMetadataPatch(candidate.providerMetadataPatch)
  const pendingProviderChange = parseStoredPendingProviderChange(
    candidate.pendingProviderChange,
    chatId
  )
  const workflowMode =
    candidate.workflowMode === 'normal' || candidate.workflowMode === 'plan'
      ? candidate.workflowMode
      : undefined
  if (
    candidate.schemaVersion !== OVERLAY_SCHEMA_VERSION ||
    candidate.chatId !== chatId ||
    (Object.keys(providerMetadataPatch).length === 0 && !pendingProviderChange && !workflowMode) ||
    !Number.isSafeInteger(candidate.baseRevision) ||
    (candidate.baseRevision ?? -1) < 0 ||
    candidate.revision !== (candidate.baseRevision ?? 0) + 1 ||
    typeof candidate.updatedAt !== 'number' ||
    !Number.isFinite(candidate.updatedAt)
  ) {
    return null
  }
  return {
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    chatId,
    baseRevision: candidate.baseRevision!,
    revision: candidate.revision,
    updatedAt: candidate.updatedAt,
    providerMetadataPatch,
    ...(workflowMode ? { workflowMode } : {}),
    ...(pendingProviderChange ? { pendingProviderChange } : {})
  }
}

function selectionMetadataPatch(value: unknown): ChatComposerSelectionPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  const patch: ChatComposerSelectionPatch = {}
  for (const key of CHAT_COMPOSER_SELECTION_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    const sanitized = sanitizeChatComposerSelectionPatch({ [key]: source[key] })
    if (sanitized) Object.assign(patch, sanitized)
  }
  return patch
}

function parseStoredPendingProviderChange(
  value: unknown,
  chatId: string
): PendingProviderChange | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Partial<PendingProviderChange>
  const request = parseChatComposerSelectionPatchRequest({
    chatId,
    provider: candidate.provider,
    deferProviderScoped: true,
    queuedAt: candidate.queuedAt,
    patch: candidate.providerMetadata
  })
  if (!request) return undefined
  return {
    provider: request.provider,
    providerMetadata: request.patch,
    ...(request.queuedAt ? { queuedAt: request.queuedAt } : {})
  }
}

function materializeOverlay(
  chat: ChatRecord,
  baseRevision: number,
  revision: number
): StoredComposerSelectionOverlay {
  const pendingProviderChange = readPendingProviderChange(chat) || undefined
  return {
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    chatId: chat.appChatId,
    baseRevision,
    revision,
    updatedAt: chat.updatedAt,
    providerMetadataPatch: selectionMetadataPatch(chat.providerMetadata),
    ...(chat.workflowMode ? { workflowMode: chat.workflowMode } : {}),
    ...(pendingProviderChange ? { pendingProviderChange } : {})
  }
}

/**
 * Durable, transcript-free composer-selection overlays.
 *
 * Interactive picker changes cannot route a multi-megabyte ChatRecord through
 * saveChat without blocking main. Each overlay is a tiny adjacent file whose
 * revision is exactly base+1. The next ordinary canonical chat checkpoint
 * advances beyond that revision and therefore supersedes the overlay without a
 * migration or read-time ambiguity.
 */
export class ChatComposerSelectionOverlayStore {
  private readonly overlays = new Map<string, StoredComposerSelectionOverlay | null>()
  private readonly overlayDir: string

  constructor(chatsDir: string) {
    this.overlayDir = path.join(chatsDir, OVERLAY_DIRECTORY_NAME)
  }

  apply(chat: ChatRecord): ChatRecord {
    const overlay = this.read(chat.appChatId)
    if (!overlay) return chat
    const revision = persistenceRevision(chat)
    if (revision === overlay.revision) return chat
    if (revision !== overlay.baseRevision) return chat
    let patched: ChatRecord = {
      ...chat,
      providerMetadata: {
        ...(chat.providerMetadata || {}),
        ...overlay.providerMetadataPatch
      }
    }
    if (overlay.pendingProviderChange) {
      patched = queueProviderChange(patched, overlay.pendingProviderChange)
    }
    return {
      ...patched,
      ...(overlay.workflowMode ? { workflowMode: overlay.workflowMode } : {}),
      updatedAt: overlay.updatedAt,
      persistenceRevision: overlay.revision
    }
  }

  async persist(
    chat: ChatRecord,
    request: ChatComposerSelectionPatchRequest,
    now: () => number = Date.now
  ): Promise<PersistChatComposerSelectionOverlayResult> {
    if (!isSafeChatId(chat.appChatId) || request.chatId !== chat.appChatId) {
      throw new Error('A composer selection can only be recorded on its saved chat.')
    }
    const next = applyChatComposerSelectionPatch(chat, request, now)
    if (next === chat) return { chat, changed: false }

    const currentRevision = persistenceRevision(chat)
    const existing = this.read(chat.appChatId)
    const extendsOverlay = Boolean(existing && existing.revision === currentRevision)
    const baseRevision = extendsOverlay ? existing!.baseRevision : currentRevision
    const revision = baseRevision + 1
    const updatedAt = next.updatedAt
    const overlay = materializeOverlay(next, baseRevision, revision)
    const hadPreviousOverlay = this.overlays.has(chat.appChatId)
    const previousOverlay = this.overlays.get(chat.appChatId)
    // Publish in memory before the first async filesystem yield. A concurrent
    // ordinary saveChat then reads the overlayed revision and checkpoints the
    // selection instead of racing a stale base record against this sidecar.
    this.overlays.set(chat.appChatId, overlay)
    try {
      await writeJsonAtomically(this.overlayPath(chat.appChatId), overlay)
    } catch (error) {
      if (hadPreviousOverlay) this.overlays.set(chat.appChatId, previousOverlay ?? null)
      else this.overlays.delete(chat.appChatId)
      throw error
    }
    return {
      changed: true,
      chat: {
        ...next,
        updatedAt,
        persistenceRevision: revision
      }
    }
  }

  delete(chatId: string): void {
    if (!isSafeChatId(chatId)) return
    fs.rmSync(this.overlayPath(chatId), { force: true })
    this.overlays.delete(chatId)
  }

  clearCache(): void {
    this.overlays.clear()
  }

  private read(chatId: string): StoredComposerSelectionOverlay | null {
    if (this.overlays.has(chatId)) return this.overlays.get(chatId) ?? null
    if (!isSafeChatId(chatId)) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.overlayPath(chatId), 'utf8')) as unknown
    } catch {
      this.overlays.set(chatId, null)
      return null
    }
    const overlay = parseStoredOverlay(parsed, chatId)
    this.overlays.set(chatId, overlay)
    return overlay
  }

  private overlayPath(chatId: string): string {
    return path.join(this.overlayDir, `${chatId}.json`)
  }
}
