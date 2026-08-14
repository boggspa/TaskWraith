import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX,
  buildAntigravityGoalCompletionFallbackInstruction,
  parseAntigravityGoalCompletionFallback
} from './AntigravityGoalLifecycleFallback'

describe('AntiGravity goal lifecycle fallback', () => {
  it('builds a host-bound completion instruction without model-transcribed identities', () => {
    const instruction = buildAntigravityGoalCompletionFallbackInstruction()

    expect(instruction).toContain('official agy has no TaskWraith MCP bridge')
    expect(instruction).toContain(
      `${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}{"summary":"Verified the active goal is complete."}`
    )
    expect(instruction).not.toContain('goalId')
    expect(instruction).not.toContain('roundId')
  })

  it('parses one exact standalone signal and bounds its summary', () => {
    const summary = 'done '.repeat(200)
    const signal = parseAntigravityGoalCompletionFallback(
      `Evidence above.\n${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}${JSON.stringify({
        summary
      })}`
    )

    expect(signal?.summary.length).toBe(500)
  })

  it.each([
    'The goal is complete.',
    `${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}{not-json}`,
    `${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}${JSON.stringify({
      summary: ''
    })}`,
    `${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}${JSON.stringify({
      goalId: 'model-transcribed-identity-is-not-accepted',
      summary: 'done'
    })}`,
    [
      `${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}${JSON.stringify({
        summary: 'first'
      })}`,
      `${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}${JSON.stringify({
        summary: 'second'
      })}`
    ].join('\n')
  ])('rejects ambiguous or malformed completion text', (content) => {
    expect(parseAntigravityGoalCompletionFallback(content)).toBeNull()
  })
})
