/**
 * The batch format of a thread's log: one line, one batch of operations that
 * takes the record from `baseRevision` to `revision`. Shared so the Host can
 * read a log it does not own; `src/main/store` re-exports these under the
 * names its callers already use.
 */

export const THREAD_LOG_BATCH_FORMAT = 'taskwraith-chat-mutation' as const
export const THREAD_LOG_BATCH_VERSION = 1 as const

/**
 * The least a transcript row, a tool activity and a run must carry for an
 * operation to address them. The full record types live in the main process,
 * which this directory cannot import; they are checked against these there.
 */
export interface ThreadLogToolActivity {
  id: string
}

export interface ThreadLogMessage {
  id: string
  content: string
  toolActivities?: ThreadLogToolActivity[]
}

export interface ThreadLogRun {
  runId: string
}

export type ThreadLogOperation<
  Message extends ThreadLogMessage = ThreadLogMessage,
  Run extends ThreadLogRun = ThreadLogRun,
  Activity extends ThreadLogToolActivity = ThreadLogToolActivity
> =
  | {
      type: 'record_patch'
      set: Record<string, unknown>
      clear: string[]
    }
  | {
      type: 'messages_splice'
      index: number
      deleteCount: number
      messages: Message[]
    }
  | {
      type: 'message_content_append'
      messageId: string
      content: string
    }
  | {
      type: 'message_put'
      messageId: string
      message: Message
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
      activities: Activity[]
    }
  | {
      type: 'tool_activity_put'
      messageId: string
      activityId: string
      activity: Activity
    }
  | {
      type: 'runs_splice'
      index: number
      deleteCount: number
      runs: Run[]
    }
  | {
      type: 'run_put'
      runId: string
      run: Run
    }
  | {
      type: 'ensemble_patch'
      set: Record<string, unknown>
      clear: string[]
    }
  | {
      type: 'ensemble_participant_patch'
      participantId: string
      set: Record<string, unknown>
      clear: string[]
    }

/** Exhaustive journal vocabulary; adding an operation must update its admission too. */
export const THREAD_LOG_OPERATION_TYPES = {
  record_patch: true,
  messages_splice: true,
  message_content_append: true,
  message_put: true,
  message_patch: true,
  tool_activities_presence: true,
  tool_activities_splice: true,
  tool_activity_put: true,
  runs_splice: true,
  run_put: true,
  ensemble_patch: true,
  ensemble_participant_patch: true
} satisfies Record<ThreadLogOperation['type'], true>

export interface ThreadLogBatch<Operation = ThreadLogOperation> {
  format: typeof THREAD_LOG_BATCH_FORMAT
  version: typeof THREAD_LOG_BATCH_VERSION
  chatId: string
  baseRevision: number
  revision: number
  savedAt: string
  operations: Operation[]
}

const OPERATION_TYPES = new Set(Object.keys(THREAD_LOG_OPERATION_TYPES))

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * Whether a parsed log line is a batch of this format for this thread. Only
 * the header and each operation's `type` are checked; an operation's payload
 * is checked when it is applied.
 */
export function isThreadLogBatch(value: unknown, chatId: string): value is ThreadLogBatch {
  if (!value || typeof value !== 'object') return false
  const batch = value as Partial<ThreadLogBatch>
  return (
    batch.format === THREAD_LOG_BATCH_FORMAT &&
    batch.version === THREAD_LOG_BATCH_VERSION &&
    batch.chatId === chatId &&
    nonNegativeInteger(batch.baseRevision) &&
    nonNegativeInteger(batch.revision) &&
    batch.revision > batch.baseRevision &&
    typeof batch.savedAt === 'string' &&
    Array.isArray(batch.operations) &&
    batch.operations.every(
      (operation) =>
        !!operation && typeof operation === 'object' && OPERATION_TYPES.has(operation.type)
    )
  )
}
