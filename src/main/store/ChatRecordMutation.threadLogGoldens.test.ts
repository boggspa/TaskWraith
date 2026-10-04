/**
 * The apply and batch-validation code moved to `src/host-shared/thread-log` so
 * the Host can read a thread's log. The names this directory exports must keep
 * giving the answers recorded before the move, for every operation type and
 * every refusal.
 */
import { describe, expect, it } from 'vitest'
import {
  captureThreadLogGoldens,
  loadThreadLogGoldens,
  THREAD_LOG_APPLY_CASES,
  THREAD_LOG_OPERATION_TYPE_NAMES,
  THREAD_LOG_VALIDATION_CASES
} from '../../host-shared/thread-log/threadLogGoldenCases.testutil'
import {
  applyChatRecordMutation,
  applyChatRecordMutations,
  CHAT_RECORD_MUTATION_FORMAT,
  CHAT_RECORD_MUTATION_OPERATION_TYPES,
  CHAT_RECORD_MUTATION_VERSION
} from './ChatRecordMutation'
import { validMutationBatch } from './IncrementalChatJournal'

describe('store exports of apply and batch validation against the recorded answers', () => {
  const recorded = loadThreadLogGoldens()
  const answers = captureThreadLogGoldens({
    applyOne: applyChatRecordMutation,
    applyMany: applyChatRecordMutations,
    validBatch: validMutationBatch
  })

  it('answers exactly the recorded cases', () => {
    expect(Object.keys(answers.apply)).toEqual(Object.keys(recorded.apply))
    expect(Object.keys(answers.validation)).toEqual(Object.keys(recorded.validation))
  })

  it.each(THREAD_LOG_APPLY_CASES.map((testCase) => testCase.name))('apply: %s', (name) => {
    expect(answers.apply[name]).toEqual(recorded.apply[name])
  })

  it.each(THREAD_LOG_VALIDATION_CASES.map((testCase) => testCase.name))(
    'validation: %s',
    (name) => {
      expect(answers.validation[name]).toBe(recorded.validation[name])
    }
  )

  it('keeps the format constants and the vocabulary it always exported', () => {
    expect(CHAT_RECORD_MUTATION_FORMAT).toBe('taskwraith-chat-mutation')
    expect(CHAT_RECORD_MUTATION_VERSION).toBe(1)
    expect(Object.keys(CHAT_RECORD_MUTATION_OPERATION_TYPES)).toEqual([
      ...THREAD_LOG_OPERATION_TYPE_NAMES
    ])
    expect(Object.values(CHAT_RECORD_MUTATION_OPERATION_TYPES)).toEqual(
      THREAD_LOG_OPERATION_TYPE_NAMES.map(() => true)
    )
  })
})
