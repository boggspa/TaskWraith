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
      type: 'message_put'
      messageId: string
      message: ChatMessage
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

export type ChatTranscriptMutationOperation = Extract<
  ChatRecordMutationOperation,
  {
    type:
      | 'messages_splice'
      | 'message_content_append'
      | 'message_put'
      | 'message_patch'
      | 'tool_activities_presence'
      | 'tool_activities_splice'
      | 'tool_activity_put'
  }
>

export interface AuthoredChatTranscriptMutation {
  operations: ChatTranscriptMutationOperation[]
  transcriptOps: ChatTranscriptOp[] | null
  changedMessageCount: number
}

export interface DeriveChatRecordMutationOptions {
  savedAt?: string
  authoredTranscript?: AuthoredChatTranscriptMutation
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
const MESSAGE_REBASE_EXCLUDES = new Set(['id'])
const RUN_REBASE_EXCLUDES = new Set(['runId'])

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
  options: DeriveChatRecordMutationOptions = {}
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

  let transcriptOps: ChatTranscriptOp[] | null
  let changedMessageCount: number
  if (options.authoredTranscript) {
    if (
      !Number.isSafeInteger(options.authoredTranscript.changedMessageCount) ||
      options.authoredTranscript.changedMessageCount < 0
    ) {
      throw new Error('Authored transcript mutation has an invalid change count')
    }
    operations.push(
      ...options.authoredTranscript.operations.map((operation) => jsonClone(operation))
    )
    transcriptOps = jsonClone(options.authoredTranscript.transcriptOps)
    changedMessageCount = options.authoredTranscript.changedMessageCount
  } else {
    const messageStructure = deriveArrayStructure(
      before.messages,
      after.messages,
      (message) => message.id
    )
    transcriptOps = buildChatTranscriptOps(before.messages, after.messages)
    changedMessageCount =
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
  options: DeriveChatRecordMutationOptions = {}
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

function recordsById<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  label: string
): Map<string, T> {
  const records = new Map<string, T>()
  for (const item of items) {
    const id = idOf(item)
    if (!id || records.has(id)) throw new Error(`Chat rebase ${label} identities are ambiguous`)
    records.set(id, item)
  }
  return records
}

function rebaseObjectFields<T extends object>(
  base: T,
  desired: T,
  source: T,
  excluded: ReadonlySet<string>,
  depth = 0
): T {
  if (depth > 64) throw new Error('Chat rebase object depth exceeds its bound')
  const baseRecord = base as unknown as Record<string, unknown>
  const desiredRecord = desired as unknown as Record<string, unknown>
  const sourceRecord = source as unknown as Record<string, unknown>
  const rebased: Record<string, unknown> = { ...sourceRecord }
  const keys = new Set([...Object.keys(baseRecord), ...Object.keys(desiredRecord)])
  for (const key of keys) {
    if (excluded.has(key)) continue
    const baseHas =
      Object.prototype.hasOwnProperty.call(baseRecord, key) && baseRecord[key] !== undefined
    const desiredHas =
      Object.prototype.hasOwnProperty.call(desiredRecord, key) && desiredRecord[key] !== undefined
    if (!desiredHas) {
      if (baseHas) delete rebased[key]
      continue
    }
    if (baseHas && jsonEqual(baseRecord[key], desiredRecord[key])) continue
    const baseValue = baseRecord[key]
    const desiredValue = desiredRecord[key]
    const sourceValue = sourceRecord[key]
    rebased[key] =
      isPlainJsonObject(baseValue) &&
      isPlainJsonObject(desiredValue) &&
      isPlainJsonObject(sourceValue)
        ? rebaseObjectFields(baseValue, desiredValue, sourceValue, new Set(), depth + 1)
        : jsonClone(desiredValue)
  }
  return rebased as unknown as T
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function rebaseIdentityArray<T extends object>(input: {
  base: readonly T[]
  desired: readonly T[]
  source: readonly T[]
  idOf: (item: T) => string
  identityField: string
  label: string
}): T[] {
  const baseById = recordsById(input.base, input.idOf, input.label)
  const desiredById = recordsById(input.desired, input.idOf, input.label)
  recordsById(input.source, input.idOf, input.label)
  const removedByDesktop = new Set([...baseById.keys()].filter((id) => !desiredById.has(id)))
  const result = input.source
    .filter((item) => !removedByDesktop.has(input.idOf(item)))
    .map((item) => jsonClone(item))
  const resultIndexById = new Map(result.map((item, index) => [input.idOf(item), index]))

  for (let desiredIndex = 0; desiredIndex < input.desired.length; desiredIndex += 1) {
    const desiredItem = input.desired[desiredIndex]
    const id = input.idOf(desiredItem)
    const baseItem = baseById.get(id)
    const sourceIndex = resultIndexById.get(id) ?? -1
    if (baseItem) {
      if (sourceIndex < 0) {
        if (!jsonEqual(baseItem, desiredItem)) {
          throw new Error(`Chat rebase ${input.label} ${id} changed after Host removal`)
        }
        continue
      }
      if (!jsonEqual(baseItem, desiredItem)) {
        result[sourceIndex] = rebaseObjectFields(
          baseItem,
          desiredItem,
          result[sourceIndex],
          input.identityField === 'id' ? MESSAGE_REBASE_EXCLUDES : RUN_REBASE_EXCLUDES
        )
      }
      continue
    }

    if (sourceIndex >= 0) {
      if (!jsonEqual(result[sourceIndex], desiredItem)) {
        throw new Error(`Chat rebase ${input.label} ${id} was added independently`)
      }
      continue
    }

    let targetIndex = result.length
    for (let index = desiredIndex + 1; index < input.desired.length; index += 1) {
      const anchor = resultIndexById.get(input.idOf(input.desired[index]))
      if (anchor !== undefined) {
        targetIndex = anchor
        break
      }
    }
    result.splice(targetIndex, 0, jsonClone(desiredItem))
    for (let index = targetIndex; index < result.length; index += 1) {
      resultIndexById.set(input.idOf(result[index]), index)
    }
  }
  return result
}

/**
 * Three-way rebase for a Desktop full-record intent after the Host advanced
 * the same chat. Fields untouched by Desktop remain Host-authored; explicit
 * Desktop changes are replayed. Message/run additions from either side are
 * retained by stable identity, while ambiguous identity collisions fail
 * closed instead of overwriting transcript history.
 */
export function rebaseChatRecordUpdate(
  base: ChatRecord,
  desired: ChatRecord,
  source: ChatRecord
): ChatRecord {
  if (
    !base.appChatId ||
    base.appChatId !== desired.appChatId ||
    base.appChatId !== source.appChatId
  ) {
    throw new Error('Chat rebase requires one stable appChatId')
  }
  const baseRevision = persistenceRevision(base)
  const desiredRevision = persistenceRevision(desired)
  const sourceRevision = persistenceRevision(source)
  if (desiredRevision <= baseRevision || sourceRevision < baseRevision) {
    throw new Error(
      `Chat rebase revision mismatch for ${base.appChatId}: ` +
        `base ${baseRevision}, desired ${desiredRevision}, source ${sourceRevision}`
    )
  }
  if (sourceRevision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Chat rebase source revision is exhausted')
  }

  const record = rebaseObjectFields(base, desired, source, TOP_LEVEL_EXCLUDES)
  record.messages = rebaseIdentityArray({
    base: base.messages,
    desired: desired.messages,
    source: source.messages,
    idOf: (message) => message.id,
    identityField: 'id',
    label: 'message'
  })
  record.runs = rebaseIdentityArray({
    base: base.runs,
    desired: desired.runs,
    source: source.runs,
    idOf: (run) => run.runId,
    identityField: 'runId',
    label: 'run'
  })
  record.persistenceRevision = sourceRevision + 1
  return record
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
      case 'message_put': {
        const index = record.messages.findIndex((candidate) => candidate.id === operation.messageId)
        if (index < 0 || operation.message.id !== operation.messageId) {
          throw new Error(`Chat mutation message ${operation.messageId} is missing`)
        }
        record.messages[index] = jsonClone(operation.message)
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
