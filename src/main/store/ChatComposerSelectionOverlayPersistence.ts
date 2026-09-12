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
import { plainDataEqual } from '../../shared/chatUpdateTransport'
import {
  queueProviderChange,
  readPendingProviderChange,
  type PendingProviderChange
} from '../../shared/providerChangeQueue'
import { writeJsonAtomically } from './ThreadWorktreeBindingPersistence'
import type { ChatRecord, ChatWorkflowMode } from './types'

const OVERLAY_SCHEMA_VERSION = 1
const OVERLAY_DIRECTORY_NAME = 'chat-composer-selections'

/** `chats/` belongs to the Host: HostProfileDomainStore.listThreads() treats
 *  every entry as a chat record and throws on anything else, so an overlay
 *  directory inside it stops the external Host from starting at all and the
 *  app silently falls back to the in-process Host. The overlay therefore lives
 *  BESIDE chats/, never within it. Exported so the boot repair that relocates
 *  the legacy `chats/.composer-selections` directory resolves the same path. */
export function composerSelectionOverlayDirectory(chatsDir: string): string {
  return path.join(path.dirname(chatsDir), OVERLAY_DIRECTORY_NAME)
}

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
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision ?? 0) <= (candidate.baseRevision ?? 0) ||
    typeof candidate.updatedAt !== 'number' ||
    !Number.isFinite(candidate.updatedAt)
  ) {
    return null
  }
  return {
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    chatId,
    baseRevision: candidate.baseRevision!,
    revision: candidate.revision!,
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
 * Whether the canonical record already carries everything the overlay would
 * fold in. This — never the record's revision — is the consumption signal: the
 * desktop canonical save that folds a selection lands carrying exactly this
 * content, while Host-native writers advance the revision without it.
 */
function overlayAlreadyFoldedInto(
  chat: ChatRecord,
  overlay: StoredComposerSelectionOverlay
): boolean {
  const metadata = chat.providerMetadata ?? {}
  const pending = overlay.pendingProviderChange
  if (pending) {
    const queued = readPendingProviderChange(chat)
    if (!queued) {
      // No queue entry: consumed only when a checkpoint already EXECUTED the
      // queued switch — target provider plus the full provider-scoped
      // metadata. Turn-end finalize (applyPendingProviderChangeOnFinalize)
      // drops the queue entry when it applies the switch, and the immediate
      // patch keys hold the pre-switch values that execution replaced, so
      // consulting them here resurrected a settled switch — and reverted the
      // provider metadata back — on every canonical read afterwards.
      if (chat.provider !== pending.provider) return false
      const appliedMetadata = pending.providerMetadata ?? {}
      for (const key of Object.keys(appliedMetadata)) {
        if (!plainDataEqual(metadata[key], appliedMetadata[key])) return false
      }
      return true
    }
    // Folded into a checkpoint but not yet executed: the queue entry must
    // still match exactly.
    if (queued.provider !== pending.provider) return false
    if (!plainDataEqual(queued.providerMetadata ?? null, pending.providerMetadata ?? null)) {
      return false
    }
  }
  for (const key of Object.keys(overlay.providerMetadataPatch)) {
    if (!plainDataEqual(metadata[key], overlay.providerMetadataPatch[key])) return false
  }
  if (overlay.workflowMode && chat.workflowMode !== overlay.workflowMode) return false
  return true
}

/**
 * Durable, transcript-free composer-selection overlays.
 *
 * Interactive picker changes cannot route a multi-megabyte ChatRecord through
 * saveChat without blocking main. Each overlay is a tiny adjacent file stamped
 * with the base revision it was written against (its own `revision` — the first
 * point past that base — is bookkeeping only; writers store base+1, but parse
 * accepts any later point so the stride is not load-bearing). Consumption is a
 * CONTENT fact: `apply` folds the overlay in until a canonical checkpoint
 * already carries the selection. The desktop canonical save is one such
 * checkpoint, but since the Host-independent-threads cutover Host-native
 * writers (HostProfileDomainStore.appendTranscript, toggleEnsembleSeat,
 * archiveThread) advance the same file revision without ever reading the
 * overlay — so a revision at or past base+1 is NOT proof of consumption, and
 * an unconsumed overlay keeps applying until its content actually lands.
 * Latest-intent-wins holds at the file level: a later explicit pick overwrites
 * the overlay file itself, so folding an unconsumed overlay can never override
 * a newer selection.
 *
 * REVISION TRANSPARENCY (2026-08-30 wedge): the overlay's base/revision pair is
 * supersede bookkeeping ONLY. It must never be stamped onto the record's
 * `persistenceRevision`: that counter is the Host's compare-and-swap chain and
 * only advances on writes the Host itself accepted. Stamping base+1 here left
 * every later `thread.record.persist` asking the Host to CAS against a revision
 * it had never written, so each save failed `thread_record_revision_conflict`
 * and the conflict recovery — which reads through `apply` — re-derived the same
 * unsatisfiable revision forever (measured on the live release profile: 842
 * conflicts in three days, one thread failing 95/95 persists). The overlay
 * changes record CONTENT at the record's own revision; the canonical save that
 * folds the selection in is what advances the chain past the overlay.
 */
export class ChatComposerSelectionOverlayStore {
  private readonly overlays = new Map<string, StoredComposerSelectionOverlay | null>()
  private readonly overlayDir: string

  constructor(chatsDir: string) {
    this.overlayDir = composerSelectionOverlayDirectory(chatsDir)
  }

  apply(chat: ChatRecord): ChatRecord {
    const overlay = this.read(chat.appChatId)
    if (!overlay) return chat
    const revision = persistenceRevision(chat)
    // A record BELOW the overlay's base is a stale or reverted read: the pick
    // was made against a newer canonical state, so folding it in here would
    // resurrect intent the record has since moved away from.
    if (revision < overlay.baseRevision) return chat
    // A record AT or PAST the base carries the overlay's intent only when its
    // content says so. Landing at base+1 used to prove the desktop canonical
    // save folded the overlay in; since the Host cutover, Host-native writers
    // advance the revision without folding, so an unconsumed overlay must
    // still apply however far the record has moved past its base.
    if (overlayAlreadyFoldedInto(chat, overlay)) return chat
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
    // Revision transparency: the record keeps its own `persistenceRevision`
    // (>= overlay.baseRevision here). Stamping overlay.revision would invent a
    // revision the Host never wrote and wedge every later CAS persist.
    return {
      ...patched,
      ...(overlay.workflowMode ? { workflowMode: overlay.workflowMode } : {}),
      // Folding into a record that advanced past the base must not regress its
      // timestamp to the overlay's older pick time.
      updatedAt: Math.max(patched.updatedAt, overlay.updatedAt)
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
    // Warm the memo before the rollback bookkeeping below reads it, so a failed
    // write restores an on-disk overlay instead of dropping the memo entry.
    this.read(chat.appChatId)
    // The record's CURRENT revision is always the base. `apply()` now folds an
    // overlay in whenever the record sits at or past `baseRevision` and does
    // not yet carry the selection, so a second pick anchored at the current
    // revision can never read as "already folded in". Anchoring at the FIRST
    // overlay's base instead produced `revision === currentRevision`, which
    // the old revision-based `apply()` read as consumed — every selection made
    // after an ordinary save had folded the previous one in was written to
    // disk and could never be read back. It hid for so long because the loss
    // only surfaces on restart or reload, not on the pick itself.
    const baseRevision = currentRevision
    const revision = baseRevision + 1
    const updatedAt = next.updatedAt
    const overlay = materializeOverlay(next, baseRevision, revision)
    const hadPreviousOverlay = this.overlays.has(chat.appChatId)
    const previousOverlay = this.overlays.get(chat.appChatId)
    // Publish in memory before the first async filesystem yield. A concurrent
    // ordinary saveChat then reads the overlayed CONTENT at the record's own
    // revision, so the checkpoint it enqueues carries the selection and a CAS
    // expectation the Host can actually satisfy (base, not base+1).
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
        updatedAt
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
