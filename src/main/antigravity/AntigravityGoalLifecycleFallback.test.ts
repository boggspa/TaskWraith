import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX,
  ANTIGRAVITY_GOAL_SET_FALLBACK_PREFIX,
  buildAntigravityGoalCompletionFallbackInstruction,
  buildAntigravityGoalSetFallbackInstruction,
  parseAntigravityGoalCompletionFallback,
  parseAntigravityGoalSetFallback
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

  it('builds a host-bound goal-set instruction without model-transcribed identities', () => {
    const instruction = buildAntigravityGoalSetFallbackInstruction()

    expect(instruction).toContain('official agy has no TaskWraith MCP bridge')
    expect(instruction).toContain(ANTIGRAVITY_GOAL_SET_FALLBACK_PREFIX)
    expect(instruction).toContain('"objective"')
    expect(instruction).not.toContain('goalId')
    expect(instruction).not.toContain('roundId')
  })

  it('parses one exact standalone set signal and bounds its objective', () => {
    const objective = 'ship '.repeat(600)
    const signal = parseAntigravityGoalSetFallback(
      `Plan above.\n${ANTIGRAVITY_GOAL_SET_FALLBACK_PREFIX}${JSON.stringify({ objective })}`
    )

    expect(signal?.objective.length).toBe(2000)
  })

  it('does not read a set signal out of the completion line or vice versa', () => {
    const setLine = `${ANTIGRAVITY_GOAL_SET_FALLBACK_PREFIX}${JSON.stringify({
      objective: 'Ship the camera viewport.'
    })}`
    const completeLine = `${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}${JSON.stringify({
      summary: 'Verified.'
    })}`

    expect(parseAntigravityGoalCompletionFallback(setLine)).toBeNull()
    expect(parseAntigravityGoalSetFallback(completeLine)).toBeNull()
    expect(parseAntigravityGoalSetFallback(setLine)?.objective).toBe('Ship the camera viewport.')
  })

  it.each([
    'Setting the goal now.',
    `${ANTIGRAVITY_GOAL_SET_FALLBACK_PREFIX}{not-json}`,
    `${ANTIGRAVITY_GOAL_SET_FALLBACK_PREFIX}${JSON.stringify({ objective: '' })}`,
    `${ANTIGRAVITY_GOAL_SET_FALLBACK_PREFIX}${JSON.stringify({
      goalId: 'model-transcribed-identity-is-not-accepted',
      objective: 'Ship it'
    })}`,
    [
      `${ANTIGRAVITY_GOAL_SET_FALLBACK_PREFIX}${JSON.stringify({ objective: 'first' })}`,
      `${ANTIGRAVITY_GOAL_SET_FALLBACK_PREFIX}${JSON.stringify({ objective: 'second' })}`
    ].join('\n')
  ])('rejects ambiguous or malformed set text', (content) => {
    expect(parseAntigravityGoalSetFallback(content)).toBeNull()
  })
})
