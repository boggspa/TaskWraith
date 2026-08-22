import type { ChatMessage, ChatRecord } from '../main/store/types'
import type { ChatTranscriptOp } from './chatUpdateTransport'

export const RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION = 1 as const

export interface RendererChatTranscriptMutationRequest {
  version: typeof RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION
  chatId: string
  baseRevision: number
  transcriptOps: ChatTranscriptOp[]
}

export type RendererChatTranscriptMutationRejectReason =
  | 'invalid-request'
  | 'chat-not-found'
  | 'revision-conflict'
  | 'operation-conflict'
  | 'save-conflict'

export type RendererChatTranscriptMutationResult =
  | {
      version: typeof RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION
      accepted: true
      chatId: string
      revision: number
      updatedAt: number
      messageCount: number
      recordHash?: string
      transcriptHash?: string
    }
  | {
      version: typeof RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION
      accepted: false
      chatId: string
      revision: number
      reason: RendererChatTranscriptMutationRejectReason
      /** Full records cross this boundary only to repair a rejected baseline. */
      canonical: ChatRecord | null
    }

const MAX_TRANSCRIPT_OPS_PER_MUTATION = 1_024
const MAX_APPENDED_MESSAGES_PER_MUTATION = 1_024

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isMessage(value: unknown): value is ChatMessage {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
}

/** Strict decode for the renderer-authored compact mutation boundary. */
export function parseRendererChatTranscriptMutationRequest(
  value: unknown
): RendererChatTranscriptMutationRequest | null {
  if (!isRecord(value)) return null
  if (value.version !== RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION) return null
  if (typeof value.chatId !== 'string' || value.chatId.length === 0) return null
  if (!Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0) {
    return null
  }
  if (
    !Array.isArray(value.transcriptOps) ||
    value.transcriptOps.length === 0 ||
    value.transcriptOps.length > MAX_TRANSCRIPT_OPS_PER_MUTATION
  ) {
    return null
  }

  let appendedMessages = 0
  for (const candidate of value.transcriptOps) {
    if (!isRecord(candidate)) return null
    if (candidate.op === 'append') {
      if (!Array.isArray(candidate.messages) || candidate.messages.length === 0) return null
      if (!candidate.messages.every(isMessage)) return null
      appendedMessages += candidate.messages.length
      if (appendedMessages > MAX_APPENDED_MESSAGES_PER_MUTATION) return null
      continue
    }
    if (candidate.op === 'update') {
      if (
        typeof candidate.id !== 'string' ||
        !candidate.id ||
        !isMessage(candidate.message) ||
        candidate.message.id !== candidate.id
      ) {
        return null
      }
      continue
    }
    if (candidate.op === 'delete') {
      if (typeof candidate.id !== 'string' || !candidate.id) return null
      continue
    }
    return null
  }

  return value as unknown as RendererChatTranscriptMutationRequest
}

/**
 * Constant-history derivation for the explicitly tail-owned streaming lane.
 * Callers must use this only where the reducer contract is append/update/delete
 * at the transcript tail; an unexpected middle edit returns null and falls
 * back to the conflict-safe whole-record path.
 */
export function buildTailChatTranscriptOps(
  previous: readonly ChatMessage[],
  next: readonly ChatMessage[]
): ChatTranscriptOp[] | null {
  if (previous === next) return []

  if (previous.length === next.length) {
    if (previous.length === 0) return []
    const before = previous[previous.length - 1]
    const after = next[next.length - 1]
    if (!before?.id || before.id !== after?.id) return null
    if (previous.length > 1 && previous[previous.length - 2] !== next[next.length - 2]) {
      return null
    }
    return before === after ? [] : [{ op: 'update', id: after.id, message: after }]
  }

  if (next.length > previous.length) {
    if (previous.length > 0 && previous[previous.length - 1] !== next[previous.length - 1]) {
      return null
    }
    const messages = next.slice(previous.length)
    return messages.every((message) => Boolean(message?.id)) ? [{ op: 'append', messages }] : null
  }

  if (next.length < previous.length) {
    if (next.length > 0 && next[next.length - 1] !== previous[next.length - 1]) {
      return null
    }
    const removed = previous.slice(next.length)
    if (removed.some((message) => !message?.id)) return null
    return removed.map((message) => ({ op: 'delete' as const, id: message.id }))
  }

  return null
}

export function chatPersistenceRevision(
  chat: Pick<ChatRecord, 'persistenceRevision'> | null | undefined
): number {
  const revision = chat?.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? (revision as number) : 0
}
