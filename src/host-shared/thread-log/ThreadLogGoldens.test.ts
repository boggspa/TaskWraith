import { describe, expect, it } from 'vitest'
import { applyThreadLogBatch, applyThreadLogBatches } from './ThreadLogApply'
import { isThreadLogBatch, THREAD_LOG_OPERATION_TYPES } from './ThreadLogBatch'
import {
  captureThreadLogGoldens,
  loadThreadLogGoldens,
  operationTypeCounts,
  THREAD_LOG_APPLY_CASES,
  THREAD_LOG_OPERATION_TYPE_NAMES,
  THREAD_LOG_VALIDATION_CASES
} from './threadLogGoldenCases.testutil'

describe('thread-log apply and batch validation against the recorded answers', () => {
  const recorded = loadThreadLogGoldens()
  const answers = captureThreadLogGoldens({
    applyOne: applyThreadLogBatch,
    applyMany: applyThreadLogBatches,
    validBatch: isThreadLogBatch
  })

  it('answers exactly the recorded cases', () => {
    expect(Object.keys(answers.apply)).toEqual(Object.keys(recorded.apply))
    expect(Object.keys(answers.validation)).toEqual(Object.keys(recorded.validation))
    expect(THREAD_LOG_APPLY_CASES.length).toBeGreaterThan(80)
    expect(THREAD_LOG_VALIDATION_CASES.length).toBeGreaterThan(50)
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

  it('covers the whole vocabulary, alone and in the seeded chains', () => {
    expect(Object.keys(THREAD_LOG_OPERATION_TYPES)).toEqual([...THREAD_LOG_OPERATION_TYPE_NAMES])
    const single = THREAD_LOG_APPLY_CASES.filter(
      (testCase) => testCase.entry === 'one' && 'returned' in recorded.apply[testCase.name]
    ).flatMap((testCase) => Object.keys(operationTypeCounts(testCase)))
    expect([...new Set(single)].sort()).toEqual([...THREAD_LOG_OPERATION_TYPE_NAMES].sort())
    const seeded = THREAD_LOG_APPLY_CASES.filter((testCase) => testCase.name.startsWith('seeded'))
    expect(seeded).toHaveLength(2)
    for (const chain of seeded) {
      // A chain that stopped at a refused operation would prove nothing about the rest.
      expect(recorded.apply[chain.name]).toHaveProperty('returned')
      const counts = operationTypeCounts(chain)
      for (const type of THREAD_LOG_OPERATION_TYPE_NAMES) expect(counts[type]).toBeGreaterThan(3)
    }
  })

  it('never changed the record or the batches it was given', () => {
    const changed = Object.entries(answers.apply)
      .filter(([, outcome]) => !outcome.inputsUnchanged)
      .map(([name]) => name)
    expect(changed).toEqual([])
  })
})
