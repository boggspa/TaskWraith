import { describe, expect, it } from 'vitest'
import {
  AgyFinalResponseLiveness,
  isAgyCompletedFinalResponseCandidate
} from './AntigravityFinalResponseLiveness'
import type { AgyTranscriptStep } from './AntigravityToolProjection'

function step(overrides: Partial<AgyTranscriptStep> = {}): AgyTranscriptStep {
  return {
    step_index: 7,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-08-16T10:33:32Z',
    content: 'Completed final report.',
    ...overrides
  }
}

function line(value: AgyTranscriptStep): string {
  return JSON.stringify(value)
}

describe('AntiGravity final-response liveness', () => {
  it('accepts only a done model planner response with content and no tool calls', () => {
    expect(isAgyCompletedFinalResponseCandidate(step())).toBe(true)
    expect(isAgyCompletedFinalResponseCandidate(step({ source: 'SYSTEM' }))).toBe(false)
    expect(isAgyCompletedFinalResponseCandidate(step({ status: 'RUNNING' }))).toBe(false)
    expect(isAgyCompletedFinalResponseCandidate(step({ content: '  ' }))).toBe(false)
    expect(
      isAgyCompletedFinalResponseCandidate(
        step({ tool_calls: [{ name: 'run_command', args: { CommandLine: 'pwd' } }] })
      )
    ).toBe(false)
  })

  it('warns once after grace while leaving final content out of the warning', () => {
    let now = 1_000
    const liveness = new AgyFinalResponseLiveness(30_000, () => now)
    liveness.observeTranscriptLines([line(step())])

    now = 30_999
    expect(liveness.takeWarning()).toBeNull()
    now = 31_000
    const warning = liveness.takeWarning()
    expect(warning).toMatchObject({
      title: 'AntiGravity final response is awaiting native exit',
      message: expect.stringContaining('has not exited after 30 seconds')
    })
    expect(JSON.stringify(warning)).not.toContain('Completed final report')
    expect(liveness.takeWarning()).toBeNull()
  })

  it('disarms on a later transcript step or native close', () => {
    let now = 0
    const liveness = new AgyFinalResponseLiveness(10, () => now)
    liveness.observeTranscriptLines([line(step())])
    liveness.observeTranscriptLines([
      line(step()),
      line(step({ step_index: 8, source: 'SYSTEM', type: 'CHECKPOINT', content: '' }))
    ])
    now = 20
    expect(liveness.takeWarning()).toBeNull()

    liveness.observeTranscriptLines([line(step({ step_index: 9 }))])
    liveness.close()
    now = 40
    expect(liveness.takeWarning()).toBeNull()
  })
})
