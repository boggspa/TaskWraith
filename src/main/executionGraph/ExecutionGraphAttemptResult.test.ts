import { describe, expect, it } from 'vitest'
import {
  MAX_EXECUTION_GRAPH_RESULT_BYTES,
  MAX_EXECUTION_GRAPH_RESULT_ERROR_BYTES,
  MAX_EXECUTION_GRAPH_RESULT_OUTPUT_BYTES,
  MAX_EXECUTION_GRAPH_RESULT_REFERENCE_BYTES,
  MAX_EXECUTION_GRAPH_RESULT_REFS,
  MAX_EXECUTION_GRAPH_RESULT_TEXT_BYTES,
  boundExecutionGraphAttemptError,
  buildExecutionGraphAttemptTerminalReceipt,
  formatExecutionGraphPredecessorResults,
  mergeExecutionGraphProviderTerminalCandidate,
  resolveExecutionGraphTerminalBarrier,
  validateExecutionGraphAttemptResult,
  type ExecutionGraphAttemptResultBinding
} from './ExecutionGraphAttemptResult'

const binding: ExecutionGraphAttemptResultBinding = {
  schemaVersion: 1,
  executionId: 'execution-one',
  activationId: 'activation-one',
  attemptId: 'attempt-one',
  providerRunRef: 'run-one',
  workspaceId: 'workspace-one',
  rootChatId: 'chat-one',
  provider: 'codex'
}

function receipt(content = 'Implemented the requested change.') {
  return buildExecutionGraphAttemptTerminalReceipt({
    binding,
    status: 'completed',
    committedAt: '2026-07-18T12:00:00.000Z',
    prompt: 'Perform the step.',
    content,
    evidenceRefs: ['assistant-one', 'tool-one', 'assistant-one']
  })
}

describe('ExecutionGraphAttemptResult', () => {
  it('builds a bounded structured result and opens only on exact terminal evidence', () => {
    const committed = receipt()
    expect(committed.result).toMatchObject({
      schemaVersion: 1,
      output: {
        schemaVersion: 1,
        kind: 'assistant_text',
        text: 'Implemented the requested change.'
      },
      trust: 'untrusted_agent_output',
      evidenceRefs: ['assistant-one', 'tool-one'],
      providerRunRef: 'run-one',
      threadRef: 'chat-one'
    })
    expect(
      resolveExecutionGraphTerminalBarrier({
        expectedBinding: binding,
        providerStatus: 'completed',
        receipt: committed
      })
    ).toMatchObject({ ok: true, status: 'completed', result: committed.result })
  })

  it('rejects missing, mutated, mismatched, and oversized receipts', () => {
    expect(
      resolveExecutionGraphTerminalBarrier({
        expectedBinding: binding,
        providerStatus: 'completed'
      })
    ).toMatchObject({ ok: false })

    const committed = receipt()
    expect(
      resolveExecutionGraphTerminalBarrier({
        expectedBinding: binding,
        providerStatus: 'failed',
        receipt: committed
      })
    ).toMatchObject({ ok: false })
    expect(
      resolveExecutionGraphTerminalBarrier({
        expectedBinding: { ...binding, attemptId: 'attempt-other' },
        providerStatus: 'completed',
        receipt: committed
      })
    ).toMatchObject({ ok: false })
    expect(
      resolveExecutionGraphTerminalBarrier({
        expectedBinding: binding,
        providerStatus: 'completed',
        receipt: { ...committed, contentDigest: '0'.repeat(64) }
      })
    ).toMatchObject({ ok: false })

    const oversized = receipt('x'.repeat(MAX_EXECUTION_GRAPH_RESULT_TEXT_BYTES + 1))
    expect(oversized.result).toBeUndefined()
    expect(
      resolveExecutionGraphTerminalBarrier({
        expectedBinding: binding,
        providerStatus: 'completed',
        receipt: oversized
      })
    ).toMatchObject({ ok: false })

    const empty = receipt('   ')
    expect(empty.result).toBeUndefined()
    expect(empty.error).toMatch(/without assistant text/)
    expect(
      resolveExecutionGraphTerminalBarrier({
        expectedBinding: binding,
        providerStatus: 'completed',
        receipt: empty
      })
    ).toMatchObject({ ok: false })
  })

  it('preserves the first provider terminal signal and flags later disagreement', () => {
    const failed = mergeExecutionGraphProviderTerminalCandidate(
      { conflict: false },
      'failed'
    )
    expect(failed).toEqual({ candidate: 'failed', conflict: false })
    expect(mergeExecutionGraphProviderTerminalCandidate(failed, 'failed')).toBe(failed)
    expect(mergeExecutionGraphProviderTerminalCandidate(failed, 'completed')).toEqual({
      candidate: 'failed',
      conflict: true
    })
  })

  it('enforces exact result schemas and independent output and total byte limits', () => {
    const committed = receipt()
    expect(
      validateExecutionGraphAttemptResult(committed.result, {
        attemptId: binding.attemptId,
        providerRunRef: binding.providerRunRef,
        threadRef: binding.rootChatId
      })
    ).toEqual({ ok: true })

    expect(
      validateExecutionGraphAttemptResult({ ...committed.result, schemaVersion: 2 })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/schema/) })
    expect(
      validateExecutionGraphAttemptResult({ ...committed.result, unexpected: true })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/schema/) })
    expect(
      validateExecutionGraphAttemptResult({
        ...committed.result,
        output: 'x'.repeat(MAX_EXECUTION_GRAPH_RESULT_OUTPUT_BYTES + 1)
      })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/output/) })

    const individuallyBoundedButOversized = {
      ...committed.result,
      output: 'x'.repeat(MAX_EXECUTION_GRAPH_RESULT_OUTPUT_BYTES - 2),
      evidenceRefs: Array.from(
        { length: MAX_EXECUTION_GRAPH_RESULT_REFS },
        (_, index) => `${index}-${'e'.repeat(MAX_EXECUTION_GRAPH_RESULT_REFERENCE_BYTES - 4)}`
      )
    }
    expect(Buffer.byteLength(JSON.stringify(individuallyBoundedButOversized))).toBeGreaterThan(
      MAX_EXECUTION_GRAPH_RESULT_BYTES
    )
    expect(validateExecutionGraphAttemptResult(individuallyBoundedButOversized)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/total storage limit/)
    })
  })

  it('bounds evidence, provider/thread references, errors, and artifact provenance', () => {
    const boundedEmojiError = boundExecutionGraphAttemptError('🔥'.repeat(2_000))
    expect(boundedEmojiError).toBeTruthy()
    expect(Buffer.byteLength(boundedEmojiError!, 'utf8')).toBeLessThanOrEqual(
      MAX_EXECUTION_GRAPH_RESULT_ERROR_BYTES
    )
    expect(() =>
      buildExecutionGraphAttemptTerminalReceipt({
        binding,
        status: 'completed',
        committedAt: '2026-07-18T12:00:00.000Z',
        prompt: 'Perform the step.',
        content: 'done',
        evidenceRefs: Array.from(
          { length: MAX_EXECUTION_GRAPH_RESULT_REFS + 1 },
          (_, index) => `message-${index}`
        )
      })
    ).toThrow(/too many evidence/)
    expect(() =>
      buildExecutionGraphAttemptTerminalReceipt({
        binding: {
          ...binding,
          providerRunRef: '🔥'.repeat(Math.ceil(MAX_EXECUTION_GRAPH_RESULT_REFERENCE_BYTES / 4) + 1)
        },
        status: 'completed',
        committedAt: '2026-07-18T12:00:00.000Z',
        prompt: 'Perform the step.',
        content: 'done',
        evidenceRefs: []
      })
    ).toThrow(/Provider run id is invalid/)
    expect(() =>
      buildExecutionGraphAttemptTerminalReceipt({
        binding,
        status: 'failed',
        committedAt: '2026-07-18T12:00:00.000Z',
        prompt: 'Perform the step.',
        content: '',
        evidenceRefs: [],
        error: '🔥'.repeat(Math.ceil(MAX_EXECUTION_GRAPH_RESULT_ERROR_BYTES / 4) + 1)
      })
    ).toThrow(/Execution result error is invalid/)

    const committed = receipt()
    expect(
      validateExecutionGraphAttemptResult(
        {
          ...committed.result,
          artifactRefs: [
            {
              schemaVersion: 1,
              id: 'artifact-one',
              kind: 'report',
              createdByAttemptId: 'another-attempt',
              trust: 'untrusted_agent_output'
            }
          ]
        },
        { attemptId: binding.attemptId }
      )
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/artifact/) })
    expect(
      validateExecutionGraphAttemptResult(
        { ...committed.result, providerRunRef: 'another-run' },
        { providerRunRef: binding.providerRunRef }
      )
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/provenance/) })
  })

  it('delivers predecessor results as an explicit untrusted data envelope', () => {
    const committed = receipt()
    const prompt = formatExecutionGraphPredecessorResults('Run the next verification.', [
      {
        stepId: 'step-one',
        attemptId: 'attempt-one',
        providerRunRef: 'run-one',
        threadRef: 'chat-one',
        result: committed.result!
      }
    ])
    expect(prompt).toContain('UNTRUSTED DATA')
    expect(prompt).toContain('"stepId":"step-one"')
    expect(prompt).toContain('Implemented the requested change.')
    expect(prompt).toContain('Current Stack step request:\nRun the next verification.')
    expect(() =>
      formatExecutionGraphPredecessorResults('Run the next verification.', [
        {
          stepId: 'step-one',
          attemptId: 'attempt-other',
          providerRunRef: 'run-one',
          threadRef: 'chat-one',
          result: {
            ...committed.result!,
            artifactRefs: [
              {
                schemaVersion: 1,
                id: 'artifact-one',
                kind: 'report',
                createdByAttemptId: 'attempt-one',
                trust: 'untrusted_agent_output'
              }
            ]
          }
        }
      ])
    ).toThrow(/artifact/)
    expect(() =>
      formatExecutionGraphPredecessorResults('Run the next verification.', [
        {
          stepId: 'step-one',
          attemptId: 'attempt-one',
          providerRunRef: 'run-other',
          threadRef: 'chat-one',
          result: committed.result!
        }
      ])
    ).toThrow(/provenance/)
    expect(() =>
      formatExecutionGraphPredecessorResults('Run the next verification.', [
        {
          stepId: 'step-one',
          attemptId: 'attempt-one',
          providerRunRef: 'run-one',
          threadRef: 'chat-one',
          result: { ...committed.result!, trust: 'system' }
        }
      ])
    ).toThrow(/explicitly untrusted/)
  })
})
