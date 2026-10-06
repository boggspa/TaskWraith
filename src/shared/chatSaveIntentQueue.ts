/**
 * Per-chat save-intent queue for thread ownership activation.
 *
 * A save is authored before it is stored. This queue records that authorship
 * first, so ownership activation can freeze the admitted head, confirm its
 * exact Host publication, and replay whatever is still unconfirmed once the
 * thread is owned. It is state only: it writes no file, starts no timer, and
 * never mutates a record. Pure helpers shared by main and the renderer live in
 * src/shared; the renderer path re-exports this module.
 *
 * Coalescing keeps the newest record per chat, but never forgets a command
 * handle: an ambiguous write is rechecked by its exact command, so a superseded
 * intent's handle rides along on the intent that replaced it.
 */
import type { ChatRecord } from '../main/store/types'
import type { ThreadOwnershipReceiptEvidence } from '../main/host/ThreadOwnershipReceiptEvidence'
import { chatPersistenceRevision } from './rendererChatTranscriptMutation'

/** The same shape HostThreadRecordPersistClient gives a persist command. */
export function persistIdempotencyKeyFor(commandId: string): string {
  return `thread:record-persist:${commandId}`
}

/** Handles of intents folded into a newer one, oldest first. */
export interface ChatSaveIntentHandle {
  readonly commandId: string
  readonly idempotencyKey: string
}

export interface ChatSaveIntent {
  readonly chatId: string
  /** The authored record. */
  readonly record: ChatRecord
  /** Milliseconds since the epoch when the intent was queued. */
  readonly authoredAt: number
  /** Exact command handle, kept across restarts and ambiguous-write rechecks. */
  readonly commandId: string
  readonly idempotencyKey: string
  /** Earlier intents this one superseded; their handles stay recheckable. */
  readonly supersedes?: readonly ChatSaveIntentHandle[]
}

export interface ChatSaveIntentHead {
  readonly revision: number
  readonly commandId: string
}

/**
 * What AppStore.saveChat needs from ownership activation. Absent, the store
 * behaves exactly as it did before ownership existed.
 */
export interface ChatSaveOwnershipPort {
  /** A fresh exact handle for a save about to be authored. */
  mintHandle(): ChatSaveIntentHandle
  /** Receipt evidence the desktop holds for the chat, oldest first. */
  receiptsFor(chatId: string): readonly ThreadOwnershipReceiptEvidence[]
  /** Evidence a stored record carried; merged into the desktop store. */
  hydrateReceipts(chatId: string, receipts: readonly ThreadOwnershipReceiptEvidence[]): void
  /**
   * Ownership is active: the owned journal's own barrier confirms saves, not a
   * Host receipt.
   */
  isActive(chatId: string): boolean
}

/** Bound on retained superseded handles per chat; the oldest go first. */
export const MAX_SUPERSEDED_INTENT_HANDLES = 4096

interface ChatSlot {
  pending: ChatSaveIntent | null
  /** Newest intent ever admitted, whether still pending or since settled. */
  admitted: ChatSaveIntentHead | null
  frozen: ChatSaveIntentHead | null
  publication: { intentCommandId: string; hostCommandId: string; revision: number } | null
}

export class PerChatSaveIntentQueue {
  private readonly slots = new Map<string, ChatSlot>()
  private droppedHandles = 0

  /** Queue an intent. A pending earlier intent is folded into this one. */
  enqueue(intent: ChatSaveIntent): void {
    if (!intent.chatId) throw new Error('Save intent needs a chat id')
    if (intent.record.appChatId !== intent.chatId) {
      throw new Error('Save intent record does not belong to its chat')
    }
    if (!intent.commandId || !intent.idempotencyKey) {
      throw new Error('Save intent needs an exact command handle')
    }
    const slot = this.slot(intent.chatId)
    const carried: ChatSaveIntentHandle[] = []
    const earlier = slot.pending
    if (earlier) {
      carried.push(...(earlier.supersedes ?? []))
      carried.push({ commandId: earlier.commandId, idempotencyKey: earlier.idempotencyKey })
    }
    carried.push(...(intent.supersedes ?? []))
    const supersedes = this.bound(carried)
    slot.pending = Object.freeze({
      ...intent,
      ...(supersedes.length > 0 ? { supersedes } : {})
    })
    slot.admitted = {
      revision: chatPersistenceRevision(intent.record),
      commandId: intent.commandId
    }
  }

  /**
   * Put a drained, uncommitted intent back. It is older than anything queued
   * since, so it folds beneath a pending intent instead of replacing it.
   */
  requeue(intent: ChatSaveIntent): void {
    if (intent.record.appChatId !== intent.chatId) {
      throw new Error('Save intent record does not belong to its chat')
    }
    const slot = this.slot(intent.chatId)
    const later = slot.pending
    if (!later) {
      slot.pending = Object.freeze({ ...intent })
      return
    }
    const supersedes = this.bound([
      ...(intent.supersedes ?? []),
      { commandId: intent.commandId, idempotencyKey: intent.idempotencyKey },
      ...(later.supersedes ?? [])
    ])
    slot.pending = Object.freeze({ ...later, supersedes })
  }

  /** The newest intent admitted for the chat, even after it settled. */
  admittedHead(chatId: string): ChatSaveIntentHead | null {
    return this.slots.get(chatId)?.admitted ?? null
  }

  /**
   * Update the admitted head's revision to the value a save actually
   * persisted. The intent is admitted BEFORE the save runs, when the
   * `record.persistenceRevision` is still the pre-save value; the save then
   * advances the revision by one. Activation looks up the receipt by
   * commandId and matches the receipt's revision against the admitted head
   * — without this pin, every save that advances the revision can never
   * confirm, because the receipt lives at `previous + 1` and the head still
   * reads `previous`. A newer intent that took over the slot is left alone.
   */
  pinAdmittedRevision(
    chatId: string,
    commandId: string,
    revision: number,
    record?: ChatRecord
  ): boolean {
    const slot = this.slots.get(chatId)
    if (!slot?.admitted) return false
    if (slot.admitted.commandId !== commandId) return false
    if (!Number.isSafeInteger(revision) || revision < 0) return false
    if (record && (record.appChatId !== chatId || chatPersistenceRevision(record) !== revision))
      return false
    slot.admitted = { revision, commandId }
    if (record && slot.pending?.commandId === commandId) {
      slot.pending = Object.freeze({ ...slot.pending, record })
    }
    return true
  }

  /**
   * Pin the admitted head and pause flushes until `unfreeze`. The revision must
   * be the admitted head's: freezing anything else would confirm a record the
   * user did not author last.
   */
  freezeHead(chatId: string, headRevision: number): void {
    if (!Number.isSafeInteger(headRevision) || headRevision < 0) {
      throw new Error('Head revision must be a non-negative integer')
    }
    const slot = this.slots.get(chatId)
    if (!slot?.admitted) throw new Error('No admitted head to freeze')
    if (slot.frozen) {
      if (slot.frozen.revision === headRevision) return
      throw new Error('Chat already frozen at a different head')
    }
    if (slot.admitted.revision !== headRevision) {
      throw new Error('Head revision is not the admitted head')
    }
    slot.frozen = slot.admitted
  }

  /** The caller signals ownership: flushes resume. */
  unfreeze(chatId: string): void {
    const slot = this.slots.get(chatId)
    if (slot) slot.frozen = null
  }

  isFrozen(chatId: string): boolean {
    return this.slots.get(chatId)?.frozen != null
  }

  frozenHead(chatId: string): ChatSaveIntentHead | null {
    return this.slots.get(chatId)?.frozen ?? null
  }

  /** Take the pending intents. Nothing flushes while the chat is frozen. */
  drain(chatId: string): ChatSaveIntent[] {
    const slot = this.slots.get(chatId)
    if (!slot?.pending || slot.frozen) return []
    const taken = slot.pending
    slot.pending = null
    return [taken]
  }

  peek(chatId: string): readonly ChatSaveIntent[] {
    const pending = this.slots.get(chatId)?.pending
    return pending ? [pending] : []
  }

  /**
   * Host storage confirmed everything through this record revision. Pending
   * intents authored at or before it are done.
   */
  settleThrough(chatId: string, revision: number): boolean {
    const slot = this.slots.get(chatId)
    const pending = slot?.pending
    if (!slot || !pending) return false
    if (chatPersistenceRevision(pending.record) > revision) return false
    slot.pending = null
    return true
  }

  /** Where a handle points: the admitted head or the pending intent only. */
  locate(commandId: string): { chatId: string; revision: number } | null {
    for (const [chatId, slot] of this.slots) {
      if (slot.admitted?.commandId === commandId) {
        return { chatId, revision: slot.admitted.revision }
      }
      if (slot.pending?.commandId === commandId) {
        return { chatId, revision: chatPersistenceRevision(slot.pending.record) }
      }
    }
    return null
  }

  /** Join a submitted Host command to the exact admitted save, never just its revision. */
  confirmPublication(
    chatId: string,
    intentCommandId: string,
    hostCommandId: string,
    revision: number
  ): boolean {
    const slot = this.slots.get(chatId)
    if (
      !slot?.admitted ||
      !hostCommandId ||
      slot.admitted.commandId !== intentCommandId ||
      slot.admitted.revision !== revision
    )
      return false
    slot.publication = { intentCommandId, hostCommandId, revision }
    return true
  }

  publicationFor(intentCommandId: string): { hostCommandId: string; revision: number } | null {
    for (const slot of this.slots.values()) {
      if (slot.publication?.intentCommandId === intentCommandId) return slot.publication
    }
    return null
  }

  /**
   * Host storage confirmed this command. A pending intent it covers is done; a
   * newer pending intent only sheds the confirmed handle.
   */
  settle(chatId: string, commandId: string): boolean {
    const slot = this.slots.get(chatId)
    const pending = slot?.pending
    if (!slot || !pending) return false
    if (pending.commandId === commandId) {
      slot.pending = null
      return true
    }
    const remaining = (pending.supersedes ?? []).filter((handle) => handle.commandId !== commandId)
    if (remaining.length === (pending.supersedes ?? []).length) return false
    slot.pending = Object.freeze({ ...pending, supersedes: remaining })
    return true
  }

  /** Drop pending intents and the freeze; used when activation fails. */
  reset(chatId: string): void {
    const slot = this.slots.get(chatId)
    if (!slot) return
    slot.pending = null
    slot.frozen = null
    slot.publication = null
  }

  /** The chat is gone: forget everything, including its admitted head. */
  forget(chatId: string): boolean {
    return this.slots.delete(chatId)
  }

  forgetAll(): void {
    this.slots.clear()
  }

  stats(): { chats: number; pending: number; frozen: number; droppedHandles: number } {
    let pending = 0
    let frozen = 0
    for (const slot of this.slots.values()) {
      if (slot.pending) pending += 1
      if (slot.frozen) frozen += 1
    }
    return { chats: this.slots.size, pending, frozen, droppedHandles: this.droppedHandles }
  }

  private slot(chatId: string): ChatSlot {
    let slot = this.slots.get(chatId)
    if (!slot) {
      slot = { pending: null, admitted: null, frozen: null, publication: null }
      this.slots.set(chatId, slot)
    }
    return slot
  }

  private bound(handles: ChatSaveIntentHandle[]): readonly ChatSaveIntentHandle[] {
    const overflow = handles.length - MAX_SUPERSEDED_INTENT_HANDLES
    if (overflow <= 0) return handles
    this.droppedHandles += overflow
    return handles.slice(overflow)
  }
}
