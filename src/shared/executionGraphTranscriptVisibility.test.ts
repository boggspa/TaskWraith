import { describe, expect, it } from 'vitest'
import { isExecutionGraphInternalTranscriptMessage } from './executionGraphTranscriptVisibility'

describe('execution graph transcript visibility', () => {
  it.each(['executionGraphAttempt', 'executionGraphAttemptOutput'])(
    'keeps %s behind the execution surface',
    (kind) => {
      expect(isExecutionGraphInternalTranscriptMessage({ metadata: { kind } })).toBe(true)
    }
  )

  it('does not hide the delivered result card or ordinary conversation', () => {
    expect(
      isExecutionGraphInternalTranscriptMessage({ metadata: { kind: 'executionResult' } })
    ).toBe(false)
    expect(isExecutionGraphInternalTranscriptMessage({})).toBe(false)
  })
})
