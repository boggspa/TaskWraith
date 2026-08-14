import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX,
  buildAntigravityGoalCompletionFallbackInstruction,
  parseAntigravityGoalCompletionFallback
} from './AntigravityGoalLifecycleFallback'

describe('AntiGravity goal lifecycle fallback', () => {
  it('builds an identity-bound completion instruction', () => {
    const instruction = buildAntigravityGoalCompletionFallbackInstruction({
      goalId: 'goal-1',
      roundId: 'round-2'
    })

    expect(instruction).toContain('official agy has no TaskWraith MCP bridge')
    expect(instruction).toContain(
      `${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}{"goalId":"goal-1","roundId":"round-2"`
    )
  })

  it('parses one exact standalone signal and bounds its summary', () => {
    const summary = 'done '.repeat(200)
    const signal = parseAntigravityGoalCompletionFallback(
      `Evidence above.\n${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}${JSON.stringify({
        goalId: 'goal-1',
        roundId: 'round-2',
        summary
      })}`
    )

    expect(signal).toMatchObject({ goalId: 'goal-1', roundId: 'round-2' })
    expect(signal?.summary.length).toBe(500)
  })

  it.each([
    'The goal is complete.',
    `${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}{not-json}`,
    `${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}${JSON.stringify({
      goalId: 'goal-1',
      roundId: 'round-2',
      summary: ''
    })}`,
    [
      `${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}${JSON.stringify({
        goalId: 'goal-1',
        roundId: 'round-2',
        summary: 'first'
      })}`,
      `${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}${JSON.stringify({
        goalId: 'goal-1',
        roundId: 'round-2',
        summary: 'second'
      })}`
    ].join('\n')
  ])('rejects ambiguous or malformed completion text', (content) => {
    expect(parseAntigravityGoalCompletionFallback(content)).toBeNull()
  })
})
