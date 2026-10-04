/**
 * `src/host-shared/thread-log` cannot import the record types, so it reads a
 * thread through small structural types of its own. These assertions are
 * checked by the type checker (`typecheck:node` compiles this file), which is
 * what keeps the two from drifting: the store's types must stay usable as the
 * shared ones, and the names the store exports must stay the types they were.
 */
import { describe, expectTypeOf, it } from 'vitest'
import type { ThreadLogRecord } from '../../host-shared/thread-log/ThreadLogApply'
import type {
  ThreadLogBatch,
  ThreadLogMessage,
  ThreadLogOperation,
  ThreadLogRun,
  ThreadLogToolActivity
} from '../../host-shared/thread-log/ThreadLogBatch'
import {
  CHAT_RECORD_MUTATION_FORMAT,
  CHAT_RECORD_MUTATION_OPERATION_TYPES,
  CHAT_RECORD_MUTATION_VERSION,
  type applyChatRecordMutation,
  type applyChatRecordMutations,
  type ChatRecordMutationBatch,
  type ChatRecordMutationOperation
} from './ChatRecordMutation'
import type { validMutationBatch } from './IncrementalChatJournal'
import type { ChatMessage, ChatRecord, ChatRun, EnsembleConfig, ToolActivity } from './types'

/** The operation union exactly as this directory declared it before the move. */
type OperationBeforeMove =
  | { type: 'record_patch'; set: Record<string, unknown>; clear: string[] }
  | { type: 'messages_splice'; index: number; deleteCount: number; messages: ChatMessage[] }
  | { type: 'message_content_append'; messageId: string; content: string }
  | { type: 'message_put'; messageId: string; message: ChatMessage }
  | { type: 'message_patch'; messageId: string; set: Record<string, unknown>; clear: string[] }
  | { type: 'tool_activities_presence'; messageId: string; present: boolean }
  | {
      type: 'tool_activities_splice'
      messageId: string
      index: number
      deleteCount: number
      activities: ToolActivity[]
    }
  | { type: 'tool_activity_put'; messageId: string; activityId: string; activity: ToolActivity }
  | { type: 'runs_splice'; index: number; deleteCount: number; runs: ChatRun[] }
  | { type: 'run_put'; runId: string; run: ChatRun }
  | { type: 'ensemble_patch'; set: Record<string, unknown>; clear: string[] }
  | {
      type: 'ensemble_participant_patch'
      participantId: string
      set: Record<string, unknown>
      clear: string[]
    }

interface BatchBeforeMove {
  format: 'taskwraith-chat-mutation'
  version: 1
  chatId: string
  baseRevision: number
  revision: number
  savedAt: string
  operations: OperationBeforeMove[]
}

describe('thread-log types against the store record types', () => {
  it('exports the operation, batch and function types the store declared before the move', () => {
    expectTypeOf<ChatRecordMutationOperation>().toEqualTypeOf<OperationBeforeMove>()
    expectTypeOf<ChatRecordMutationBatch>().toEqualTypeOf<BatchBeforeMove>()
    expectTypeOf(CHAT_RECORD_MUTATION_FORMAT).toEqualTypeOf<'taskwraith-chat-mutation'>()
    expectTypeOf(CHAT_RECORD_MUTATION_VERSION).toEqualTypeOf<1>()
    expectTypeOf(CHAT_RECORD_MUTATION_OPERATION_TYPES).toEqualTypeOf<
      Record<OperationBeforeMove['type'], true>
    >()
    expectTypeOf<typeof applyChatRecordMutation>().toEqualTypeOf<
      (source: ChatRecord, batch: BatchBeforeMove) => ChatRecord
    >()
    expectTypeOf<typeof applyChatRecordMutations>().toEqualTypeOf<
      (source: ChatRecord, batches: readonly BatchBeforeMove[]) => ChatRecord
    >()
    expectTypeOf<typeof validMutationBatch>().toEqualTypeOf<
      (value: unknown, chatId: string) => value is BatchBeforeMove
    >()
  })

  it('keeps every store type usable as the structural type the log code reads', () => {
    expectTypeOf<ChatRecord>().toExtend<ThreadLogRecord>()
    expectTypeOf<ChatMessage>().toExtend<ThreadLogMessage>()
    expectTypeOf<ChatRun>().toExtend<ThreadLogRun>()
    expectTypeOf<ToolActivity>().toExtend<ThreadLogToolActivity>()
    expectTypeOf<EnsembleConfig>().toExtend<NonNullable<ThreadLogRecord['ensemble']>>()
    expectTypeOf<ChatRecordMutationBatch>().toExtend<ThreadLogBatch>()
    expectTypeOf<ChatRecordMutationOperation>().toExtend<ThreadLogOperation>()
  })

  it('declares the fields the log code writes with the types the store gives them', () => {
    // The apply code assigns to these, so a narrower store type would be violated silently.
    expectTypeOf<Pick<ThreadLogRecord, 'appChatId' | 'persistenceRevision'>>().toEqualTypeOf<
      Pick<ChatRecord, 'appChatId' | 'persistenceRevision'>
    >()
    expectTypeOf<Pick<ThreadLogMessage, 'id' | 'content'>>().toEqualTypeOf<
      Pick<ChatMessage, 'id' | 'content'>
    >()
    expectTypeOf<Pick<ThreadLogRun, 'runId'>>().toEqualTypeOf<Pick<ChatRun, 'runId'>>()
    expectTypeOf<Pick<ThreadLogToolActivity, 'id'>>().toEqualTypeOf<Pick<ToolActivity, 'id'>>()
    expectTypeOf<ThreadLogOperation['type']>().toEqualTypeOf<ChatRecordMutationOperation['type']>()
  })
})
