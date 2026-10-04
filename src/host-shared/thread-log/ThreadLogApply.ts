import {
  THREAD_LOG_BATCH_FORMAT,
  THREAD_LOG_BATCH_VERSION,
  type ThreadLogBatch,
  type ThreadLogMessage,
  type ThreadLogRun
} from './ThreadLogBatch'

/**
 * The part of a thread's record the log's operations read and write. A record
 * carries far more; everything else passes through untouched, or is set and
 * cleared by name through the patch operations.
 */
export interface ThreadLogRecord {
  appChatId: string
  persistenceRevision?: number
  messages: ThreadLogMessage[]
  runs: ThreadLogRun[]
  ensemble?: { participants?: Array<{ id: string }> }
}

interface ObjectPatch {
  set: Record<string, unknown>
  clear: string[]
}

/** What a record patch may never set or clear: identity, the transcript, the revision. */
export const THREAD_LOG_PROTECTED_RECORD_FIELDS: ReadonlySet<string> = new Set([
  'appChatId',
  'messages',
  'runs',
  'persistenceRevision'
])

function persistenceRevision(record: Pick<ThreadLogRecord, 'persistenceRevision'>): number {
  const revision = record.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? revision! : 0
}

function jsonClone<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
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

function findMessage(record: ThreadLogRecord, messageId: string): ThreadLogMessage {
  const message = record.messages.find((candidate) => candidate.id === messageId)
  if (!message) throw new Error(`Chat mutation message ${messageId} is missing`)
  return message
}

function applyPatch(target: Record<string, unknown>, patch: ObjectPatch): void {
  for (const [key, value] of Object.entries(patch.set)) target[key] = jsonClone(value)
  for (const key of patch.clear) delete target[key]
}

export function applyThreadLogBatch<Source extends ThreadLogRecord>(
  source: Source,
  batch: ThreadLogBatch
): Source {
  assertBatchSource(source, batch)
  return applyThreadLogBatches(source, [batch])
}

/**
 * Replay a revision chain on one private copy. Cloning the complete transcript
 * for every streamed append makes a journal read grow with history × updates.
 * Only the final record escapes; a rejected operation cannot mutate the caller
 * or expose a partly applied chain. Operation payloads are still copied below.
 */
export function applyThreadLogBatches<Source extends ThreadLogRecord>(
  source: Source,
  batches: readonly ThreadLogBatch[]
): Source {
  const record = jsonClone(source)
  for (const batch of batches) {
    assertBatchSource(record, batch)
    applyBatchInPlace(record, batch)
  }
  return record
}

function assertBatchSource(source: ThreadLogRecord, batch: ThreadLogBatch): void {
  if (batch.format !== THREAD_LOG_BATCH_FORMAT || batch.version !== THREAD_LOG_BATCH_VERSION) {
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
}

/** The record is owned exclusively by applyThreadLogBatches. */
function applyBatchInPlace(record: ThreadLogRecord, batch: ThreadLogBatch): void {
  for (const operation of batch.operations) {
    switch (operation.type) {
      case 'record_patch': {
        for (const protectedKey of THREAD_LOG_PROTECTED_RECORD_FIELDS) {
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
      case 'ensemble_patch': {
        if (!record.ensemble) throw new Error('Chat mutation ensemble is missing')
        if (
          Object.prototype.hasOwnProperty.call(operation.set, 'participants') ||
          operation.clear.includes('participants')
        ) {
          throw new Error('Ensemble patch cannot replace participants')
        }
        applyPatch(record.ensemble as unknown as Record<string, unknown>, operation)
        break
      }
      case 'ensemble_participant_patch': {
        const seats = record.ensemble?.participants
        const index = seats?.findIndex((seat) => seat.id === operation.participantId) ?? -1
        if (!seats || index < 0) {
          throw new Error(`Chat ensemble participant ${operation.participantId} is missing`)
        }
        if (
          Object.prototype.hasOwnProperty.call(operation.set, 'id') ||
          operation.clear.includes('id')
        ) {
          throw new Error('Ensemble participant patch cannot replace identity')
        }
        applyPatch(seats[index] as unknown as Record<string, unknown>, operation)
        break
      }
      default: {
        const unsupported: never = operation
        throw new Error(`Unsupported chat mutation operation: ${String(unsupported)}`)
      }
    }
  }

  record.persistenceRevision = batch.revision
}
