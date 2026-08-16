import type { ChatMessage, ChatRecord, ChatRun, ToolActivity } from './types'
import { buildChatTranscriptOps, type ChatTranscriptOp } from '../../shared/chatUpdateTransport'

export const CHAT_RECORD_MUTATION_FORMAT = 'taskwraith-chat-mutation' as const
export const CHAT_RECORD_MUTATION_VERSION = 1 as const

export type ChatRecordMutationOperation =
  | {
      type: 'record_patch'
      set: Record<string, unknown>
      clear: string[]
    }
  | {
      type: 'messages_splice'
      index: number
      deleteCount: number
      messages: ChatMessage[]
    }
  | {
      type: 'message_content_append'
      messageId: string
      content: string
    }
  | {
      type: 'message_patch'
      messageId: string
      set: Record<string, unknown>
      clear: string[]
    }
  | {
      type: 'tool_activities_presence'
      messageId: string
      present: boolean
    }
  | {
      type: 'tool_activities_splice'
      messageId: string
      index: number
      deleteCount: number
      activities: ToolActivity[]
    }
  | {
      type: 'tool_activity_put'
      messageId: string
      activityId: string
      activity: ToolActivity
    }
  | {
      type: 'runs_splice'
      index: number
      deleteCount: number
      runs: ChatRun[]
    }
  | {
      type: 'run_put'
      runId: string
      run: ChatRun
    }

export interface ChatRecordMutationBatch {
  format: typeof CHAT_RECORD_MUTATION_FORMAT
  version: typeof CHAT_RECORD_MUTATION_VERSION
  chatId: string
  baseRevision: number
  revision: number
  savedAt: string
  operations: ChatRecordMutationOperation[]
}

/** One producer derivation yields both the durable mutation and renderer operations. */
export interface DerivedChatRecordMutation {
  batch: ChatRecordMutationBatch
  /** null means the edit needs a recovery snapshot on the renderer wire. */
  transcriptOps: ChatTranscriptOp[] | null
  changedMessageCount: number
}

interface ArrayStructureDelta<T> {
  splice: { index: number; deleteCount: number; items: T[] } | null
  stablePairs: Array<{ before: T; after: T }>
}

interface ObjectPatch {
  set: Record<string, unknown>
  clear: string[]
}

const TOP_LEVEL_EXCLUDES = new Set(['appChatId', 'messages', 'runs', 'persistenceRevision'])
const MESSAGE_FIELD_EXCLUDES = new Set(['id', 'content', 'toolActivities'])

function persistenceRevision(record: Pick<ChatRecord, 'persistenceRevision'>): number {
  const revision = record.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? revision! : 0
}

function jsonClone<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === undefined || right === undefined) return false
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function objectPatch(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  excluded: ReadonlySet<string>
): ObjectPatch {
  const set: Record<string, unknown> = {}
  const clear: string[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])

  for (const key of keys) {
    if (excluded.has(key)) continue
    const afterHasKey = Object.prototype.hasOwnProperty.call(after, key) && after[key] !== undefined
    if (!afterHasKey) {
      if (Object.prototype.hasOwnProperty.call(before, key) && before[key] !== undefined) {
        clear.push(key)
      }
      continue
    }
    if (!jsonEqual(before[key], after[key])) set[key] = jsonClone(after[key])
  }

  return { set, clear }
}

function hasPatch(patch: ObjectPatch): boolean {
  return patch.clear.length > 0 || Object.keys(patch.set).length > 0
}

function hasUniqueIds<T>(items: readonly T[], idOf: (item: T) => string): boolean {
  const ids = new Set<string>()
  for (const item of items) {
    const id = idOf(item)
    if (!id || ids.has(id)) return false
    ids.add(id)
  }
  return true
}

function deriveArrayStructure<T>(
  before: readonly T[],
  after: readonly T[],
  idOf: (item: T) => string
): ArrayStructureDelta<T> {
  if (!hasUniqueIds(before, idOf) || !hasUniqueIds(after, idOf)) {
    return {
      splice: {
        index: 0,
        deleteCount: before.length,
        items: after.map((item) => jsonClone(item))
      },
      stablePairs: []
    }
  }

  let prefix = 0
  while (
    prefix < before.length &&
    prefix < after.length &&
    idOf(before[prefix]) === idOf(after[prefix])
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    idOf(before[before.length - 1 - suffix]) === idOf(after[after.length - 1 - suffix])
  ) {
    suffix += 1
  }

  const stablePairs: Array<{ before: T; after: T }> = []
  for (let index = 0; index < prefix; index += 1) {
    stablePairs.push({ before: before[index], after: after[index] })
  }
  for (let offset = suffix; offset > 0; offset -= 1) {
    stablePairs.push({
      before: before[before.length - offset],
      after: after[after.length - offset]
    })
  }

  const deleteCount = before.length - prefix - suffix
  const inserted = after.slice(prefix, after.length - suffix)
  const splice =
    deleteCount === 0 && inserted.length === 0
      ? null
      : {
          index: prefix,
          deleteCount,
          items: inserted.map((item) => jsonClone(item))
        }

  return { splice, stablePairs }
}

function deriveToolOperations(
  before: ChatMessage,
  after: ChatMessage,
  operations: ChatRecordMutationOperation[]
): void {
  const beforePresent = Object.prototype.hasOwnProperty.call(before, 'toolActivities')
  const afterPresent = Object.prototype.hasOwnProperty.call(after, 'toolActivities')
  if (beforePresent !== afterPresent) {
    operations.push({
      type: 'tool_activities_presence',
      messageId: after.id,
      present: afterPresent
    })
  }
  if (!afterPresent) return

  const beforeActivities = before.toolActivities ?? []
  const afterActivities = after.toolActivities ?? []
  const structure = deriveArrayStructure(
    beforeActivities,
    afterActivities,
    (activity) => activity.id
  )
  if (structure.splice) {
    operations.push({
      type: 'tool_activities_splice',
      messageId: after.id,
      index: structure.splice.index,
      deleteCount: structure.splice.deleteCount,
      activities: structure.splice.items
    })
  }
  for (const pair of structure.stablePairs) {
    if (jsonEqual(pair.before, pair.after)) continue
    operations.push({
      type: 'tool_activity_put',
      messageId: after.id,
      activityId: pair.after.id,
      activity: jsonClone(pair.after)
    })
  }
}

function deriveMessageOperations(
  before: ChatMessage,
  after: ChatMessage,
  operations: ChatRecordMutationOperation[]
): boolean {
  const operationCount = operations.length
  const patch = objectPatch(
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
    MESSAGE_FIELD_EXCLUDES
  )
  if (before.content !== after.content) {
    if (after.content.startsWith(before.content)) {
      operations.push({
        type: 'message_content_append',
        messageId: after.id,
        content: after.content.slice(before.content.length)
      })
    } else {
      patch.set.content = after.content
    }
  }
  if (hasPatch(patch)) {
    operations.push({ type: 'message_patch', messageId: after.id, ...patch })
  }
  deriveToolOperations(before, after, operations)
  return operations.length !== operationCount
}

export function deriveChatRecordMutationWithProjection(
  before: ChatRecord,
  after: ChatRecord,
  options: { savedAt?: string } = {}
): DerivedChatRecordMutation {
  if (!before.appChatId || before.appChatId !== after.appChatId) {
    throw new Error('Chat mutation requires one stable appChatId')
  }
  const baseRevision = persistenceRevision(before)
  const revision = persistenceRevision(after)
  if (revision <= baseRevision) {
    throw new Error(
      `Chat mutation revision must advance: ${baseRevision} -> ${revision} for ${after.appChatId}`
    )
  }

  const operations: ChatRecordMutationOperation[] = []
  const recordPatch = objectPatch(
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
    TOP_LEVEL_EXCLUDES
  )
  if (hasPatch(recordPatch)) operations.push({ type: 'record_patch', ...recordPatch })

  const messageStructure = deriveArrayStructure(
    before.messages,
    after.messages,
    (message) => message.id
  )
  const transcriptOps = buildChatTranscriptOps(before.messages, after.messages)
  const changedMessageCount =
    transcriptOps?.reduce((count, operation) => {
      if (operation.op === 'append') return count + operation.messages.length
      return count + 1
    }, 0) ??
    (messageStructure.splice
      ? messageStructure.splice.deleteCount + messageStructure.splice.items.length
      : after.messages.length)
  if (messageStructure.splice) {
    const { index, deleteCount, items } = messageStructure.splice
    operations.push({
      type: 'messages_splice',
      index,
      deleteCount,
      messages: items
    })
  }
  for (const pair of messageStructure.stablePairs) {
    deriveMessageOperations(pair.before, pair.after, operations)
  }

  const runStructure = deriveArrayStructure(before.runs, after.runs, (run) => run.runId)
  if (runStructure.splice) {
    operations.push({
      type: 'runs_splice',
      index: runStructure.splice.index,
      deleteCount: runStructure.splice.deleteCount,
      runs: runStructure.splice.items
    })
  }
  for (const pair of runStructure.stablePairs) {
    if (jsonEqual(pair.before, pair.after)) continue
    operations.push({
      type: 'run_put',
      runId: pair.after.runId,
      run: jsonClone(pair.after)
    })
  }

  return {
    batch: {
      format: CHAT_RECORD_MUTATION_FORMAT,
      version: CHAT_RECORD_MUTATION_VERSION,
      chatId: after.appChatId,
      baseRevision,
      revision,
      savedAt: options.savedAt ?? new Date().toISOString(),
      operations
    },
    transcriptOps,
    changedMessageCount
  }
}

export function deriveChatRecordMutation(
  before: ChatRecord,
  after: ChatRecord,
  options: { savedAt?: string } = {}
): ChatRecordMutationBatch {
  return deriveChatRecordMutationWithProjection(before, after, options).batch
}

function assertSpliceBounds(
  length: number,
  index: number,
  deleteCount: number,
  label: string
): void {
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(deleteCount) ||
    index < 0 ||
    deleteCount < 0 ||
    index > length ||
    index + deleteCount > length
  ) {
    throw new Error(`${label} splice is out of bounds`)
  }
}

function findMessage(record: ChatRecord, messageId: string): ChatMessage {
  const message = record.messages.find((candidate) => candidate.id === messageId)
  if (!message) throw new Error(`Chat mutation message ${messageId} is missing`)
  return message
}

function applyPatch(target: Record<string, unknown>, patch: ObjectPatch): void {
  for (const [key, value] of Object.entries(patch.set)) target[key] = jsonClone(value)
  for (const key of patch.clear) delete target[key]
}

export function applyChatRecordMutation(
  source: ChatRecord,
  batch: ChatRecordMutationBatch
): ChatRecord {
  if (
    batch.format !== CHAT_RECORD_MUTATION_FORMAT ||
    batch.version !== CHAT_RECORD_MUTATION_VERSION
  ) {
    throw new Error('Unsupported chat mutation format')
  }
  if (source.appChatId !== batch.chatId) {
    throw new Error(`Chat mutation target mismatch: ${source.appChatId} != ${batch.chatId}`)
  }
  const sourceRevision = persistenceRevision(source)
  if (sourceRevision !== batch.baseRevision || batch.revision <= batch.baseRevision) {
    throw new Error(
      `Chat mutation revision mismatch for ${batch.chatId}: ` +
        `record ${sourceRevision}, batch ${batch.baseRevision} -> ${batch.revision}`
    )
  }

  const record = jsonClone(source)
  for (const operation of batch.operations) {
    switch (operation.type) {
      case 'record_patch': {
        for (const protectedKey of TOP_LEVEL_EXCLUDES) {
          if (
            Object.prototype.hasOwnProperty.call(operation.set, protectedKey) ||
            operation.clear.includes(protectedKey)
          ) {
            throw new Error(`Chat mutation cannot patch protected field ${protectedKey}`)
          }
        }
        applyPatch(record as unknown as Record<string, unknown>, operation)
        break
      }
      case 'messages_splice':
        assertSpliceBounds(
          record.messages.length,
          operation.index,
          operation.deleteCount,
          'messages'
        )
        record.messages.splice(
          operation.index,
          operation.deleteCount,
          ...operation.messages.map((message) => jsonClone(message))
        )
        break
      case 'message_content_append': {
        const message = findMessage(record, operation.messageId)
        message.content += operation.content
        break
      }
      case 'message_patch': {
        const message = findMessage(record, operation.messageId)
        if (
          Object.prototype.hasOwnProperty.call(operation.set, 'id') ||
          Object.prototype.hasOwnProperty.call(operation.set, 'toolActivities') ||
          operation.clear.includes('id') ||
          operation.clear.includes('toolActivities')
        ) {
          throw new Error('Message patch cannot replace identity or toolActivities')
        }
        applyPatch(message as unknown as Record<string, unknown>, operation)
        break
      }
      case 'tool_activities_presence': {
        const message = findMessage(record, operation.messageId)
        if (operation.present) {
          if (!Array.isArray(message.toolActivities)) message.toolActivities = []
        } else {
          delete message.toolActivities
        }
        break
      }
      case 'tool_activities_splice': {
        const message = findMessage(record, operation.messageId)
        const activities = message.toolActivities ?? []
        assertSpliceBounds(
          activities.length,
          operation.index,
          operation.deleteCount,
          'toolActivities'
        )
        activities.splice(
          operation.index,
          operation.deleteCount,
          ...operation.activities.map((activity) => jsonClone(activity))
        )
        message.toolActivities = activities
        break
      }
      case 'tool_activity_put': {
        const message = findMessage(record, operation.messageId)
        const activities = message.toolActivities ?? []
        const index = activities.findIndex((activity) => activity.id === operation.activityId)
        if (index < 0) throw new Error(`Tool activity ${operation.activityId} is missing`)
        activities[index] = jsonClone(operation.activity)
        message.toolActivities = activities
        break
      }
      case 'runs_splice':
        assertSpliceBounds(record.runs.length, operation.index, operation.deleteCount, 'runs')
        record.runs.splice(
          operation.index,
          operation.deleteCount,
          ...operation.runs.map((run) => jsonClone(run))
        )
        break
      case 'run_put': {
        const index = record.runs.findIndex((run) => run.runId === operation.runId)
        if (index < 0) throw new Error(`Chat run ${operation.runId} is missing`)
        record.runs[index] = jsonClone(operation.run)
        break
      }
    }
  }

  record.persistenceRevision = batch.revision
  return record
}

export function estimateChatRecordMutationBytes(batch: ChatRecordMutationBatch): number {
  return Buffer.byteLength(JSON.stringify(batch), 'utf8')
}
