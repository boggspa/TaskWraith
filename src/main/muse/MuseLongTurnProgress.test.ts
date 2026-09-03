import { describe, expect, it } from 'vitest'
import {
  MUSE_LONG_TURN_PROGRESS_NOTE,
  MUSE_OPENING_STEER_NOTE,
  composeMuseLaunchPrompt,
  withMuseOpeningSteer,
  withMuseProgressSteer
} from './MuseLongTurnProgress'

describe('withMuseProgressSteer', () => {
  it('asks for sparse phase checkpoints without turning them into completion signals', () => {
    const prompt = withMuseProgressSteer('Implement and verify the bounded change.')

    expect(prompt).toBe(
      `${MUSE_LONG_TURN_PROGRESS_NOTE}\n\nImplement and verify the bounded change.`
    )
    expect(prompt).toContain('phase-based, not per tool or fixed count')
    expect(prompt).toContain('not a final answer, question, yield, handoff, or completion signal')
    expect(prompt).toContain('not private step-by-step reasoning')
  })

  it('is idempotent across already-composed prompts', () => {
    const once = withMuseProgressSteer('Inspect the workspace.')
    expect(withMuseProgressSteer(once)).toBe(once)
  })

  it('does not move a provider-native slash command off the wire prefix', () => {
    expect(withMuseProgressSteer('/compact')).toBe('/compact')
  })
})

describe('withMuseOpeningSteer', () => {
  it('prepends the plan-announcement steer to a fresh-exec prompt', () => {
    const prompt = withMuseOpeningSteer('Set up the migration.')
    expect(prompt).toBe(`${MUSE_OPENING_STEER_NOTE}\n\nSet up the migration.`)
    expect(prompt).toContain('announce what you plan to do before starting tool calls')
  })

  it('is idempotent and leaves slash dispatch untouched', () => {
    const once = withMuseOpeningSteer('Inspect the workspace.')
    expect(withMuseOpeningSteer(once)).toBe(once)
    expect(withMuseOpeningSteer('/compact')).toBe('/compact')
  })
})

describe('composeMuseLaunchPrompt', () => {
  it('applies opening then standing progress guidance on every isolated exec', () => {
    expect(composeMuseLaunchPrompt('Review the failing test.')).toBe(
      withMuseOpeningSteer(withMuseProgressSteer('Review the failing test.'))
    )
  })

  it('is idempotent and leaves slash dispatch untouched', () => {
    const once = composeMuseLaunchPrompt('Continue.')
    expect(composeMuseLaunchPrompt(once)).toBe(once)
    expect(composeMuseLaunchPrompt('/compact')).toBe('/compact')
  })
})
