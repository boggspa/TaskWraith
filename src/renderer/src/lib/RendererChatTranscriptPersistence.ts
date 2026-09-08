import { computeChatSubRevisions } from '../../../shared/chatUpdateTransport'
import type { ChatRecord } from '../../../main/store/types'
import { rebaseTailTranscript, hasOnlyTranscriptChanges } from './advanceRendererRecord'
import {
  RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
  buildTailChatTranscriptOps,
  chatPersistenceRevision,
  type RendererChatTranscriptMutationRequest,
  type RendererChatTranscriptMutationResult
} from '../../../shared/rendererChatTranscriptMutation'

interface PendingTranscriptSave {
  base: ChatRecord
  target: ChatRecord
}

interface ChatPersistenceState {
  generation: number
  pending?: PendingTranscriptSave
  inFlight?: Promise<void>
  flushAfterFlight: boolean
}

export interface RendererChatTranscriptPersistenceDeps {
  mutate: (
    request: RendererChatTranscriptMutationRequest
  ) => Promise<RendererChatTranscriptMutationResult>
  loadCanonical: (chatId: string) => Promise<ChatRecord | null>
  onAccepted: (
    chatId: string,
    baseRevision: number,
    optimisticTarget: ChatRecord,
    result: Extract<RendererChatTranscriptMutationResult, { accepted: true }>,
    beforeTarget: ChatRecord,
    acceptedTarget: ChatRecord
  ) => void
  onRecovered: (
    chatId: string,
    optimisticTarget: ChatRecord,
    rebasedTarget: ChatRecord,
    canonical: ChatRecord
  ) => void
  onUnrecoverable: (chatId: string, canonical: ChatRecord | null) => void
}

/**
 * Serializes the renderer's tail-owned stream saves without retaining cloned
 * transcript snapshots. Immutable ChatRecord references are enough: each wire
 * request contains only the final append/update/delete operations since the
 * accepted base, and its ACK contains no chat record in the healthy path.
 */
export class RendererChatTranscriptPersistence {
  private readonly states = new Map<string, ChatPersistenceState>()

  constructor(private readonly deps: RendererChatTranscriptPersistenceDeps) {}

  queue(base: ChatRecord, target: ChatRecord): boolean {
    if (base.appChatId !== target.appChatId || !hasOnlyTranscriptChanges(base, target)) return false
    const immediateOps = buildTailChatTranscriptOps(base.messages, target.messages)
    if (!immediateOps || immediateOps.length === 0) return false

    const state = this.stateFor(base.appChatId)
    if (state.pending) {
      if (state.pending.target !== base) return false
      state.pending.target = target
      return true
    }
    if (state.inFlight) {
      const inFlightTarget = (
        state as ChatPersistenceState & {
          inFlightTarget?: ChatRecord
        }
      ).inFlightTarget
      if (inFlightTarget !== base) return false
    }
    state.pending = { base, target }
    return true
  }

  /** Explicit history reset: old ACKs/conflicts may finish, but may never replay work. */
  cancel(chatId: string): void {
    const state = this.states.get(chatId)
    if (!state) return
    state.generation += 1
    this.discardPending(chatId)
  }

  cancelAll(): void {
    for (const id of this.states.keys()) this.cancel(id)
  }

  discardPending(chatId: string): void {
    const state = this.states.get(chatId)
    if (!state) return
    state.pending = undefined
    state.flushAfterFlight = false
    this.deleteIfIdle(chatId, state)
  }

  async flush(chatId: string): Promise<void> {
    const state = this.states.get(chatId)
    if (!state) return
    if (state.inFlight) {
      state.flushAfterFlight = true
      await state.inFlight
      return
    }
    const pending = state.pending
    if (!pending) {
      this.deleteIfIdle(chatId, state)
      return
    }

    const transcriptOps = buildTailChatTranscriptOps(pending.base.messages, pending.target.messages)
    if (!transcriptOps || transcriptOps.length === 0) {
      state.pending = undefined
      this.deps.onUnrecoverable(chatId, null)
      this.deleteIfIdle(chatId, state)
      return
    }

    state.pending = undefined
    ;(state as ChatPersistenceState & { inFlightTarget?: ChatRecord }).inFlightTarget =
      pending.target
    const request: RendererChatTranscriptMutationRequest = {
      version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
      chatId,
      baseRevision: chatPersistenceRevision(pending.base),
      transcriptOps
    }
    const operation = this.perform(state, pending, request)
    state.inFlight = operation
    await operation
  }

  async whenIdle(chatId: string): Promise<void> {
    const state = this.states.get(chatId)
    if (!state) return
    if (state.pending) await this.flush(chatId)
    if (state.inFlight) await state.inFlight
  }

  private async perform(
    state: ChatPersistenceState,
    pending: PendingTranscriptSave,
    request: RendererChatTranscriptMutationRequest
  ): Promise<void> {
    const generation = state.generation
    const valid = (): boolean => state.generation === generation
    try {
      let result: RendererChatTranscriptMutationResult
      try {
        result = await this.deps.mutate(request)
      } catch {
        if (!valid()) return
        const canonical = await this.deps.loadCanonical(request.chatId).catch(() => null)
        result = {
          version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
          accepted: false,
          chatId: request.chatId,
          revision: chatPersistenceRevision(canonical),
          reason: 'revision-conflict',
          canonical
        }
      }

      if (!valid()) return
      const acceptedTarget: ChatRecord | null = result.accepted
        ? {
            ...pending.target,
            persistenceRevision: result.revision,
            updatedAt: result.updatedAt
          }
        : null
      const hashMatches =
        !result.accepted ||
        !result.recordHash ||
        computeChatSubRevisions(acceptedTarget!).recordHash === result.recordHash
      if (
        result.accepted &&
        acceptedTarget &&
        hashMatches &&
        result.messageCount === pending.target.messages.length
      ) {
        const queued = state.pending
        if (queued?.base === pending.target) {
          const previousQueuedTarget = queued.target
          queued.base = acceptedTarget
          queued.target = {
            ...previousQueuedTarget,
            persistenceRevision: result.revision,
            updatedAt: result.updatedAt
          }
          this.deps.onAccepted(
            request.chatId,
            request.baseRevision,
            queued.target,
            result,
            previousQueuedTarget,
            acceptedTarget
          )
        } else {
          this.deps.onAccepted(
            request.chatId,
            request.baseRevision,
            acceptedTarget,
            result,
            pending.target,
            acceptedTarget
          )
        }
      } else {
        const canonical = result.accepted
          ? await this.deps.loadCanonical(request.chatId).catch(() => null)
          : result.canonical
        if (!valid()) return
        const queued = state.pending
        const optimisticTarget = queued?.base === pending.target ? queued.target : pending.target
        state.pending = undefined
        const recovered = canonical
          ? rebaseTailTranscript(pending.base, optimisticTarget, canonical)
          : null
        if (canonical && recovered) {
          this.deps.onRecovered(request.chatId, optimisticTarget, recovered.target, canonical)
          if (recovered.ops.length > 0) {
            state.pending = { base: canonical, target: recovered.target }
            state.flushAfterFlight = true
          }
        } else {
          this.deps.onUnrecoverable(request.chatId, canonical)
        }
      }
    } finally {
      state.inFlight = undefined
      delete (state as ChatPersistenceState & { inFlightTarget?: ChatRecord }).inFlightTarget
      const shouldFlush = state.flushAfterFlight && Boolean(state.pending)
      state.flushAfterFlight = false
      if (shouldFlush) {
        await this.flush(request.chatId)
      } else {
        this.deleteIfIdle(request.chatId, state)
      }
    }
  }

  private stateFor(chatId: string): ChatPersistenceState {
    const existing = this.states.get(chatId)
    if (existing) return existing
    const created: ChatPersistenceState = { generation: 0, flushAfterFlight: false }
    this.states.set(chatId, created)
    return created
  }

  private deleteIfIdle(chatId: string, state: ChatPersistenceState): void {
    if (!state.pending && !state.inFlight) this.states.delete(chatId)
  }
}
