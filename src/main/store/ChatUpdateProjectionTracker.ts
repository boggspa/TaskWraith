import {
  computeChatSubRevisions,
  estimateChatMessageBytes,
  estimateChatRecordBytes,
  type ChatUpdateProducerDelta,
  type ChatUpdateProducerState,
  type ChatUpdateRecord
} from '../../shared/chatUpdateTransport'
import type { DerivedChatRecordMutation } from './ChatRecordMutation'
import type { ChatRecord } from './types'

interface TrackedProjection {
  state: ChatUpdateProducerState
  messageIds: string[]
  messageBytesById: Map<string, number>
  runCount: number
  hasEnsemble: boolean
  lastTouched: number
}

export interface ChatUpdateProjectionObservation {
  state: ChatUpdateProducerState
  /** null asks the delivery coordinator for a one-shot recovery snapshot. */
  delta: ChatUpdateProducerDelta | null
}

export interface ChatUpdateProjectionTrackerOptions {
  maxTrackedChats?: number
  now?: () => number
}

function persistenceRevision(chat: Pick<ChatRecord, 'persistenceRevision'>): number {
  const revision = chat.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? revision! : 0
}

function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function rollHash(previous: string, label: string, value: unknown): string {
  return fnv1aHex(`${previous}\u0000${label}\u0000${JSON.stringify(value)}`)
}

function hashNumber(previous: number, label: string, value: unknown): number {
  return Number.parseInt(rollHash(previous.toString(16), label, value), 16)
}

function cloneState(state: ChatUpdateProducerState): ChatUpdateProducerState {
  return { ...state }
}

function recordDeltaFromMutation(
  after: ChatRecord,
  derived: DerivedChatRecordMutation
): Pick<ChatUpdateProducerDelta, 'recordMask' | 'recordDelta' | 'recordCleared'> {
  const recordMask: string[] = []
  const touched = new Set<string>()
  const recordDelta: Record<string, unknown> = {}
  const recordCleared = new Set<string>()
  const touch = (key: string): void => {
    if (touched.has(key)) return
    touched.add(key)
    recordMask.push(key)
  }

  for (const operation of derived.batch.operations) {
    if (operation.type === 'record_patch') {
      for (const [key, value] of Object.entries(operation.set)) {
        touch(key)
        recordDelta[key] = value
        recordCleared.delete(key)
      }
      for (const key of operation.clear) {
        touch(key)
        delete recordDelta[key]
        recordCleared.add(key)
      }
      continue
    }
    if (operation.type === 'runs_splice' || operation.type === 'run_put') {
      touch('runs')
      recordDelta.runs = after.runs
      recordCleared.delete('runs')
    }
  }

  touch('persistenceRevision')
  recordDelta.persistenceRevision = after.persistenceRevision
  return {
    recordMask,
    recordDelta: recordDelta as Partial<ChatUpdateRecord>,
    ...(recordCleared.size > 0 ? { recordCleared: [...recordCleared] } : {})
  }
}

/**
 * Keeps only the small mutable index needed to advance transport fingerprints
 * and retained-byte meters from durable mutation operations. A full transcript
 * is walked once when a chat first enters (or recovers into) the tracker; every
 * ordinary save after that is O(changed operations).
 */
export class ChatUpdateProjectionTracker {
  private readonly projections = new Map<string, TrackedProjection>()
  private readonly maxTrackedChats: number
  private readonly now: () => number

  constructor(options: ChatUpdateProjectionTrackerOptions = {}) {
    this.maxTrackedChats = Math.max(2, options.maxTrackedChats ?? 48)
    this.now = options.now ?? Date.now
  }

  seed(chat: ChatRecord): ChatUpdateProducerState {
    const sub = computeChatSubRevisions(chat)
    const messageIds: string[] = []
    const messageBytesById = new Map<string, number>()
    for (const message of chat.messages) {
      if (!message.id || messageBytesById.has(message.id)) {
        throw new Error(`Chat update projection requires unique message ids for ${chat.appChatId}`)
      }
      messageIds.push(message.id)
      messageBytesById.set(message.id, estimateChatMessageBytes(message))
    }
    const state: ChatUpdateProducerState = {
      chatId: chat.appChatId,
      persistenceRevision: persistenceRevision(chat),
      retainedBytes: estimateChatRecordBytes(chat),
      ...sub
    }
    this.projections.set(chat.appChatId, {
      state,
      messageIds,
      messageBytesById,
      runCount: chat.runs.length,
      hasEnsemble: chat.ensemble != null,
      lastTouched: this.now()
    })
    this.prune()
    return cloneState(state)
  }

  observe(
    before: ChatRecord,
    after: ChatRecord,
    derived: DerivedChatRecordMutation
  ): ChatUpdateProjectionObservation {
    if (
      before.appChatId !== after.appChatId ||
      before.appChatId !== derived.batch.chatId ||
      persistenceRevision(before) !== derived.batch.baseRevision ||
      persistenceRevision(after) !== derived.batch.revision
    ) {
      return { state: this.seed(after), delta: null }
    }
    let tracked = this.projections.get(after.appChatId)
    if (!tracked || tracked.state.persistenceRevision !== derived.batch.baseRevision) {
      this.seed(before)
      tracked = this.projections.get(after.appChatId)
    }
    if (!tracked) throw new Error(`Chat update projection seed failed for ${after.appChatId}`)

    try {
      const priorState = tracked.state
      this.applyMutation(tracked, derived)
      if (
        tracked.messageIds.length !== after.messages.length ||
        tracked.runCount !== after.runs.length ||
        derived.batch.revision !== persistenceRevision(after)
      ) {
        throw new Error('Producer mutation shape does not match the saved chat')
      }

      const recordOperations = derived.batch.operations.filter(
        (operation) =>
          operation.type === 'record_patch' ||
          operation.type === 'runs_splice' ||
          operation.type === 'run_put'
      )
      const runOperations = derived.batch.operations.filter(
        (operation) => operation.type === 'runs_splice' || operation.type === 'run_put'
      )
      const ensembleOperations = derived.batch.operations.filter(
        (operation) =>
          operation.type === 'record_patch' &&
          (Object.prototype.hasOwnProperty.call(operation.set, 'ensemble') ||
            operation.clear.includes('ensemble'))
      )
      const state: ChatUpdateProducerState = {
        chatId: after.appChatId,
        persistenceRevision: derived.batch.revision,
        retainedBytes: tracked.state.retainedBytes,
        recordHash: rollHash(priorState.recordHash, 'record', {
          revision: derived.batch.revision,
          operations: recordOperations
        }),
        runsRevision:
          runOperations.length > 0
            ? hashNumber(priorState.runsRevision, 'runs', runOperations)
            : priorState.runsRevision,
        ensembleRevision:
          ensembleOperations.length > 0
            ? hashNumber(priorState.ensembleRevision, 'ensemble', ensembleOperations)
            : priorState.ensembleRevision
      }
      tracked.state = state
      tracked.lastTouched = this.now()
      const record = recordDeltaFromMutation(after, derived)
      const delta: ChatUpdateProducerDelta = {
        ...state,
        basePersistenceRevision: derived.batch.baseRevision,
        ...record,
        transcriptOps: derived.transcriptOps,
        changedMessageCount: derived.changedMessageCount
      }
      return { state: cloneState(state), delta }
    } catch {
      // A malformed, skipped, or out-of-band producer operation cannot be
      // patched safely. Re-baseline once from canonical state and let the wire
      // send a snapshot instead of attempting a best-effort reconstruction.
      return { state: this.seed(after), delta: null }
    }
  }

  drop(chatId: string): void {
    this.projections.delete(chatId)
  }

  clear(): void {
    this.projections.clear()
  }

  private applyMutation(tracked: TrackedProjection, derived: DerivedChatRecordMutation): void {
    for (const operation of derived.batch.operations) {
      switch (operation.type) {
        case 'messages_splice': {
          if (
            operation.index < 0 ||
            operation.deleteCount < 0 ||
            operation.index + operation.deleteCount > tracked.messageIds.length
          ) {
            throw new Error('Tracked message splice is out of bounds')
          }
          const removedIds = tracked.messageIds.splice(
            operation.index,
            operation.deleteCount,
            ...operation.messages.map((message) => message.id)
          )
          for (const id of removedIds) {
            tracked.state.retainedBytes -= tracked.messageBytesById.get(id) ?? 0
            tracked.messageBytesById.delete(id)
          }
          for (const message of operation.messages) {
            const bytes = estimateChatMessageBytes(message)
            tracked.messageBytesById.set(message.id, bytes)
            tracked.state.retainedBytes += bytes
          }
          break
        }
        case 'message_content_append': {
          if (!tracked.messageBytesById.has(operation.messageId)) {
            throw new Error(`Tracked message ${operation.messageId} is missing`)
          }
          tracked.messageBytesById.set(
            operation.messageId,
            tracked.messageBytesById.get(operation.messageId)! + operation.content.length
          )
          tracked.state.retainedBytes += operation.content.length
          break
        }
        case 'message_patch': {
          if (!Object.prototype.hasOwnProperty.call(operation.set, 'content')) break
          const previousBytes = tracked.messageBytesById.get(operation.messageId)
          if (previousBytes === undefined) {
            throw new Error(`Tracked message ${operation.messageId} is missing`)
          }
          const content = operation.set.content
          const nextBytes = 64 + (typeof content === 'string' ? content.length : 128)
          tracked.messageBytesById.set(operation.messageId, nextBytes)
          tracked.state.retainedBytes += nextBytes - previousBytes
          break
        }
        case 'runs_splice':
          tracked.state.retainedBytes += (operation.runs.length - operation.deleteCount) * 48
          tracked.runCount += operation.runs.length - operation.deleteCount
          break
        case 'record_patch': {
          const ensembleWasPresent = tracked.hasEnsemble
          if (operation.clear.includes('ensemble')) tracked.hasEnsemble = false
          if (Object.prototype.hasOwnProperty.call(operation.set, 'ensemble')) {
            tracked.hasEnsemble = operation.set.ensemble != null
          }
          if (ensembleWasPresent !== tracked.hasEnsemble) {
            tracked.state.retainedBytes += tracked.hasEnsemble ? 512 : -512
          }
          break
        }
        default:
          break
      }
    }
  }

  private prune(): void {
    if (this.projections.size <= this.maxTrackedChats) return
    const oldest = [...this.projections.entries()].sort(
      (left, right) => left[1].lastTouched - right[1].lastTouched
    )
    while (this.projections.size > this.maxTrackedChats) {
      const entry = oldest.shift()
      if (!entry) break
      this.projections.delete(entry[0])
    }
  }
}
