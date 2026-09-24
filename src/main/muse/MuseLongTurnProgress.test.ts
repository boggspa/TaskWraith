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
  it('keeps progress from replacing tool execution in a fresh-exec prompt', () => {
    const prompt = withMuseOpeningSteer('Set up the migration.')
    expect(prompt).toBe(`${MUSE_OPENING_STEER_NOTE}\n\nSet up the migration.`)
    expect(prompt).toContain('carry out the requested work in this turn')
    expect(prompt).toContain(
      'give one brief introduction and issue the first tool call in that same response'
    )
    expect(prompt).toContain('Do not stop after announcing a plan')
    expect(prompt).toContain('Verify file changes with tools before reporting completion')
  })

  it('is idempotent and leaves slash dispatch untouched', () => {
    const once = withMuseOpeningSteer('Inspect the workspace.')
    expect(withMuseOpeningSteer(once)).toBe(once)
    expect(withMuseOpeningSteer('/compact')).toBe('/compact')
  })
})

describe('composeMuseLaunchPrompt', () => {
  // Vestigial branch: the pre-turn introduction pass that was its only
  // producer is gone, so no caller reaches this today. Pinned so the branch
  // cannot be silently hollowed out while the parameter is still threaded
  // through `MuseMspRun`; both retire together.
  it('continues from a Muse-authored introduction without asking for another announcement', () => {
    const prompt = composeMuseLaunchPrompt('Verify the totals.', 'I will read both files.')
    expect(prompt).toContain('your introduction has already been shown')
    expect(prompt).toContain('Carry out the requested work now with tools')
    expect(prompt).toContain('I will read both files.')
    expect(prompt).toContain('Verify the totals.')
    expect(prompt).not.toContain('give one brief introduction')
    expect(composeMuseLaunchPrompt('/compact', 'Opening')).toBe('/compact')
  })

  it('applies opening then standing progress guidance on every isolated exec', () => {
    expect(composeMuseLaunchPrompt('Review the failing test.')).toBe(
      withMuseOpeningSteer(withMuseProgressSteer('Review the failing test.'))
    )
  })

  it('asks for the opening on every shape a caller can now produce', () => {
    // With the pre-turn introduction pass removed, the second argument is
    // never supplied, so the no-introduction path — the one that carries
    // MUSE_OPENING_STEER_NOTE — is the only path a real turn takes.
    for (const introduction of [undefined, null, '']) {
      const prompt = composeMuseLaunchPrompt('Review the failing test.', introduction)
      expect(prompt).toContain(MUSE_OPENING_STEER_NOTE)
      expect(prompt).toContain(MUSE_LONG_TURN_PROGRESS_NOTE)
      expect(prompt).not.toContain('your introduction has already been shown')
    }
  })

  it('is idempotent and leaves slash dispatch untouched', () => {
    const once = composeMuseLaunchPrompt('Continue.')
    expect(composeMuseLaunchPrompt(once)).toBe(once)
    expect(composeMuseLaunchPrompt('/compact')).toBe('/compact')
  })
})
