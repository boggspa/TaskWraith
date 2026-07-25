import { describe, expect, it } from 'vitest'
import {
  chatGitWorkflowDiffers,
  chatGitWorkflowGroup,
  chatGitWorkflowInputFromObservation,
  chatGitWorkflowLabel,
  deriveChatGitWorkflowState,
  normalizeChatGitWorkflow
} from './chatGitWorkflow'

describe('deriveChatGitWorkflowState', () => {
  it('maps PR lifecycle states with merged/closed terminal over CI', () => {
    expect(
      deriveChatGitWorkflowState({ pr: { number: 7, state: 'MERGED' }, ciStatus: 'failed' })
    ).toBe('merged')
    expect(
      deriveChatGitWorkflowState({ pr: { number: 7, state: 'CLOSED' }, ciStatus: 'failed' })
    ).toBe('closed')
  })

  it('surfaces a failing CI head above draft/open', () => {
    expect(
      deriveChatGitWorkflowState({
        pr: { number: 7, state: 'OPEN', isDraft: true },
        ciStatus: 'failed'
      })
    ).toBe('failed')
    expect(
      deriveChatGitWorkflowState({ pr: { number: 7, state: 'OPEN' }, ciStatus: 'failed' })
    ).toBe('failed')
  })

  it('distinguishes draft from open', () => {
    expect(deriveChatGitWorkflowState({ pr: { number: 7, state: 'OPEN', isDraft: true } })).toBe(
      'draft'
    )
    expect(deriveChatGitWorkflowState({ pr: { number: 7, state: 'OPEN' } })).toBe('open')
  })

  it('reads a fully synced upstream with no PR as pushed, and nothing otherwise', () => {
    expect(deriveChatGitWorkflowState({ pushedClean: true })).toBe('pushed')
    expect(deriveChatGitWorkflowState({})).toBeNull()
    // A PR-shaped object without a real number is not a PR.
    expect(deriveChatGitWorkflowState({ pr: { state: 'OPEN' }, pushedClean: true })).toBe('pushed')
  })
})

describe('chatGitWorkflowGroup', () => {
  it('files states under the sidebar subheaders', () => {
    expect(chatGitWorkflowGroup('pushed')).toBe('pushed')
    expect(chatGitWorkflowGroup('draft')).toBe('pr')
    expect(chatGitWorkflowGroup('open')).toBe('pr')
    expect(chatGitWorkflowGroup('failed')).toBe('pr')
    expect(chatGitWorkflowGroup('merged')).toBe('merged')
    expect(chatGitWorkflowGroup('closed')).toBe('closed')
  })
})

describe('chatGitWorkflowInputFromObservation', () => {
  it('carries the PR number and a github-only url', () => {
    expect(
      chatGitWorkflowInputFromObservation('open', {
        number: 12,
        url: 'https://github.com/o/r/pull/12'
      })
    ).toEqual({ state: 'open', prNumber: 12, prUrl: 'https://github.com/o/r/pull/12' })
    expect(
      chatGitWorkflowInputFromObservation('open', { number: 12, url: 'https://evil.example/x' })
    ).toEqual({ state: 'open', prNumber: 12 })
  })

  it('keeps pushed markers PR-free and passes null through', () => {
    expect(
      chatGitWorkflowInputFromObservation('pushed', { number: 12, url: 'https://github.com/o/r' })
    ).toEqual({ state: 'pushed' })
    expect(chatGitWorkflowInputFromObservation(null, { number: 12 })).toBeNull()
  })
})

describe('chatGitWorkflowDiffers', () => {
  it('detects state, number and url changes; absent persisted always differs', () => {
    expect(chatGitWorkflowDiffers(undefined, { state: 'open' })).toBe(true)
    expect(
      chatGitWorkflowDiffers({ state: 'open', prNumber: 1 }, { state: 'open', prNumber: 1 })
    ).toBe(false)
    expect(
      chatGitWorkflowDiffers({ state: 'open', prNumber: 1 }, { state: 'merged', prNumber: 1 })
    ).toBe(true)
    expect(
      chatGitWorkflowDiffers({ state: 'open', prNumber: 1 }, { state: 'open', prNumber: 2 })
    ).toBe(true)
  })
})

describe('chatGitWorkflowLabel', () => {
  it('builds compact human labels', () => {
    expect(chatGitWorkflowLabel({ state: 'merged', prNumber: 9 })).toBe('PR #9 merged')
    expect(chatGitWorkflowLabel({ state: 'pushed' })).toBe('Pushed')
    expect(chatGitWorkflowLabel({ state: 'failed' })).toBe('PR — CI failed')
  })
})

describe('normalizeChatGitWorkflow', () => {
  it('round-trips a valid snapshot and drops out-of-contract extras', () => {
    expect(
      normalizeChatGitWorkflow({
        state: 'merged',
        prNumber: 3,
        prUrl: 'https://github.com/o/r/pull/3',
        updatedAt: 1721900000000
      })
    ).toEqual({
      state: 'merged',
      prNumber: 3,
      prUrl: 'https://github.com/o/r/pull/3',
      updatedAt: 1721900000000
    })
    expect(
      normalizeChatGitWorkflow({ state: 'pushed', updatedAt: 5, prUrl: 'https://evil.example/x' })
    ).toEqual({ state: 'pushed', updatedAt: 5 })
  })

  it('throws on malformed snapshots (treated as absent by readers)', () => {
    expect(() => normalizeChatGitWorkflow(null)).toThrow('incomplete')
    expect(() => normalizeChatGitWorkflow({ state: 'nope', updatedAt: 5 })).toThrow('incomplete')
    expect(() => normalizeChatGitWorkflow({ state: 'open' })).toThrow('incomplete')
  })
})
