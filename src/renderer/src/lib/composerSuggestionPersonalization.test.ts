import { describe, expect, it } from 'vitest'
import type { ComposerSuggestionCandidate } from './composerSuggestion'
import {
  emptyComposerSuggestionPersonalizationProfile,
  personalizeComposerSuggestionText,
  selectPersonalizedComposerSuggestion,
  updateComposerSuggestionFeedback,
  updateComposerSuggestionStyle
} from './composerSuggestionPersonalization'

function candidate(
  id: string,
  trigger: ComposerSuggestionCandidate['suggestion']['trigger'],
  baselineScore: number,
  hard = false,
  text = id
): ComposerSuggestionCandidate {
  return { suggestion: { id, trigger, text }, baselineScore, hard }
}

describe('composer suggestion personalization', () => {
  it('never lets a learned preference outrank a hard recovery candidate', () => {
    let profile = emptyComposerSuggestionPersonalizationProfile()
    for (let index = 0; index < 8; index += 1) {
      profile = updateComposerSuggestionFeedback(profile, 'task-continuation', 'accepted')
    }

    const selected = selectPersonalizedComposerSuggestion(
      [
        candidate('failure', 'lane-failed', 360, true),
        candidate('continue', 'task-continuation', 260)
      ],
      profile,
      'continue'
    )

    expect(selected?.candidate.suggestion.id).toBe('failure')
    expect(selected?.source).toBe('deterministic')
  })

  it('learns from explicit accept/dismiss feedback within the current thread', () => {
    let profile = emptyComposerSuggestionPersonalizationProfile()
    for (let index = 0; index < 6; index += 1) {
      profile = updateComposerSuggestionFeedback(profile, 'uncommitted-changes', 'accepted')
    }
    for (let index = 0; index < 4; index += 1) {
      profile = updateComposerSuggestionFeedback(profile, 'task-continuation', 'dismissed')
    }

    const selected = selectPersonalizedComposerSuggestion(
      [
        candidate('continue', 'task-continuation', 190),
        candidate('commit', 'uncommitted-changes', 180)
      ],
      profile
    )

    expect(selected?.candidate.suggestion.id).toBe('commit')
    expect(selected?.source).toBe('local-preference')
  })

  it('treats a Foundation Models result as a bounded preference, not authority', () => {
    const selected = selectPersonalizedComposerSuggestion(
      [
        candidate('continue', 'task-continuation', 220),
        candidate('commit', 'uncommitted-changes', 210)
      ],
      emptyComposerSuggestionPersonalizationProfile(),
      'commit'
    )

    expect(selected?.candidate.suggestion.id).toBe('commit')
    expect(selected?.source).toBe('foundation-model-proposal')
  })

  it('stores only aggregate style signals and can phrase continuation as a question', () => {
    let profile = emptyComposerSuggestionPersonalizationProfile()
    for (let index = 0; index < 5; index += 1) {
      profile = updateComposerSuggestionStyle(profile, 'Can we continue with the test coverage?')
    }

    const text = personalizeComposerSuggestionText(
      candidate(
        'continue',
        'task-continuation',
        220,
        false,
        'Continue with: Add retry-path coverage'
      ),
      profile
    )

    expect(text).toBe('Can we continue with add retry-path coverage?')
    expect(profile.style).toMatchObject({ sentPrompts: 5, questionPrompts: 5 })
    expect(JSON.stringify(profile)).not.toContain('test coverage')
  })

  it('records that an accepted suggestion was edited without retaining either text', () => {
    const profile = updateComposerSuggestionStyle(
      emptyComposerSuggestionPersonalizationProfile(),
      'Commit the working changes after tests.',
      'Commit the working changes'
    )

    expect(profile.style).toMatchObject({
      acceptedSuggestionSends: 1,
      editedAcceptedSuggestionSends: 1
    })
  })
})
