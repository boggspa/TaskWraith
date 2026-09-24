import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_COLD_START_STEER_NOTE,
  ANTIGRAVITY_LONG_TURN_PROGRESS_NOTE,
  withAntigravityColdStartSteer,
  withAntigravityLongTurnProgress
} from './AntigravityLongTurnProgress'

describe('withAntigravityLongTurnProgress', () => {
  it('asks for sparse phase checkpoints without turning them into completion signals', () => {
    const prompt = withAntigravityLongTurnProgress('Implement and verify the bounded change.')

    expect(prompt).toBe(
      `${ANTIGRAVITY_LONG_TURN_PROGRESS_NOTE}\n\nImplement and verify the bounded change.`
    )
    expect(prompt).toContain('phase-based, not per tool or fixed count')
    expect(prompt).toContain('not a final answer, question, yield, handoff, or completion signal')
    expect(prompt).toContain('not private step-by-step reasoning')
  })

  it('is idempotent across already-composed prompts', () => {
    const once = withAntigravityLongTurnProgress('Inspect the workspace.')
    expect(withAntigravityLongTurnProgress(once)).toBe(once)
  })

  it('does not move a provider-native slash command off the wire prefix', () => {
    expect(withAntigravityLongTurnProgress('/compact')).toBe('/compact')
  })
})

describe('withAntigravityColdStartSteer', () => {
  it('prepends the plan-announcement steer to a fresh-project prompt', () => {
    const prompt = withAntigravityColdStartSteer('Set up the migration.')
    expect(prompt).toBe(`${ANTIGRAVITY_COLD_START_STEER_NOTE}\n\nSet up the migration.`)
    expect(prompt).toContain('announce what you plan to do before starting tool calls')
  })

  it('is idempotent and leaves slash dispatch untouched', () => {
    const once = withAntigravityColdStartSteer('Inspect the workspace.')
    expect(withAntigravityColdStartSteer(once)).toBe(once)
    expect(withAntigravityColdStartSteer('/compact')).toBe('/compact')
  })
})
