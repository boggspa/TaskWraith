import { describe, expect, it } from 'vitest'
import {
  deriveComposerSuggestion,
  type ComposerSuggestionContext,
  type ComposerSuggestionLane
} from './composerSuggestion'

function ctx(overrides: Partial<ComposerSuggestionContext> = {}): ComposerSuggestionContext {
  return {
    draft: '',
    busy: false,
    hasPriorTurn: true,
    consideredModel: null,
    selectedModelKey: 'claude:claude-sonnet-5',
    failedLanes: [],
    uncommittedFileCount: 0,
    branch: 'master',
    dismissedIds: new Set<string>(),
    ...overrides
  }
}

const OPUS = { label: 'Opus 5', key: 'claude:claude-opus-5' }

const lane = (
  id: string,
  label: string,
  kind: 'failed' | 'unreachable' = 'failed',
  provider = 'codex'
): ComposerSuggestionLane => ({ id, label, provider, kind })

describe('deriveComposerSuggestion — suppression', () => {
  it('suggests nothing once the user has typed', () => {
    expect(deriveComposerSuggestion(ctx({ consideredModel: OPUS, draft: 'fix the' }))).toBeNull()
  })

  it('treats a whitespace-only draft as empty', () => {
    const suggestion = deriveComposerSuggestion(ctx({ consideredModel: OPUS, draft: '   \n ' }))
    expect(suggestion?.trigger).toBe('picker-dismissed')
  })

  it('suggests nothing mid-run', () => {
    expect(deriveComposerSuggestion(ctx({ consideredModel: OPUS, busy: true }))).toBeNull()
  })

  it('suggests nothing before the first settled turn', () => {
    // Nothing to retry, rerun, or commit against yet.
    expect(
      deriveComposerSuggestion(
        ctx({
          hasPriorTurn: false,
          consideredModel: OPUS,
          failedLanes: [lane('lane-2', 'Lane 2')],
          uncommittedFileCount: 4
        })
      )
    ).toBeNull()
  })
})

describe('deriveComposerSuggestion — picker dismissal', () => {
  it('offers a retry on the model the user considered and backed out of', () => {
    const suggestion = deriveComposerSuggestion(ctx({ consideredModel: OPUS }))
    expect(suggestion).toEqual({
      id: 'picker-dismissed:claude:claude-opus-5',
      trigger: 'picker-dismissed',
      text: 'Retry that last turn on Opus 5'
    })
  })

  it('stays quiet when the considered model is the one already active', () => {
    expect(
      deriveComposerSuggestion(
        ctx({ consideredModel: OPUS, selectedModelKey: 'claude:claude-opus-5' })
      )
    ).toBeNull()
  })

  it('outranks ambient git and lane state', () => {
    // The picker gesture happened seconds ago; the other two have
    // likely been true all session.
    const suggestion = deriveComposerSuggestion(
      ctx({
        consideredModel: OPUS,
        failedLanes: [lane('lane-2', 'Lane 2')],
        uncommittedFileCount: 9
      })
    )
    expect(suggestion?.trigger).toBe('picker-dismissed')
  })
})

describe('deriveComposerSuggestion — failed lanes', () => {
  it('names the single failed lane', () => {
    const suggestion = deriveComposerSuggestion(ctx({ failedLanes: [lane('lane-2', 'Lane 2')] }))
    expect(suggestion).toEqual({
      id: 'lane-failed:lane-2',
      trigger: 'lane-failed',
      text: 'Rerun Lane 2'
    })
  })

  it('asks why rather than picking one arbitrarily when several failed', () => {
    const suggestion = deriveComposerSuggestion(
      ctx({
        failedLanes: [lane('lane-1', 'Lane 1'), lane('lane-3', 'Lane 3')]
      })
    )
    expect(suggestion?.text).toBe('Why did 2 seats fail?')
    expect(suggestion?.id).toBe('lane-failed:multi:lane-1,lane-3')
  })

  it('outranks uncommitted changes', () => {
    const suggestion = deriveComposerSuggestion(
      ctx({ failedLanes: [lane('lane-2', 'Lane 2')], uncommittedFileCount: 12 })
    )
    expect(suggestion?.trigger).toBe('lane-failed')
  })

  it('never suggests a rerun for an unreachable seat', () => {
    // `unreachable` means pre-flight never got to the provider, so a
    // rerun fails again for the same reason. Point at the provider.
    const suggestion = deriveComposerSuggestion(
      ctx({ failedLanes: [lane('p-1', 'Specialist', 'unreachable', 'kimi')] })
    )
    expect(suggestion).toEqual({
      id: 'lane-unreachable:p-1',
      trigger: 'lane-failed',
      text: 'Specialist was never reached — is kimi running?'
    })
  })

  it('prefers an errored seat over an unreachable one', () => {
    const suggestion = deriveComposerSuggestion(
      ctx({
        failedLanes: [
          lane('p-1', 'Specialist', 'unreachable', 'kimi'),
          lane('p-2', 'Captain', 'failed', 'codex')
        ]
      })
    )
    expect(suggestion?.text).toBe('Rerun Captain')
  })

  it('groups several unreachable seats without offering a rerun', () => {
    const suggestion = deriveComposerSuggestion(
      ctx({
        failedLanes: [
          lane('p-1', 'Specialist', 'unreachable', 'kimi'),
          lane('p-2', 'Captain', 'unreachable', 'codex')
        ]
      })
    )
    expect(suggestion?.text).toBe('Why were 2 seats unreachable?')
  })
})

describe('deriveComposerSuggestion — uncommitted changes', () => {
  it('offers a commit naming the branch', () => {
    const suggestion = deriveComposerSuggestion(ctx({ uncommittedFileCount: 3 }))
    expect(suggestion).toEqual({
      id: 'uncommitted-changes:master:3',
      trigger: 'uncommitted-changes',
      text: 'Commit the working changes on master'
    })
  })

  it('drops the branch clause when detached', () => {
    const suggestion = deriveComposerSuggestion(ctx({ uncommittedFileCount: 3, branch: null }))
    expect(suggestion?.text).toBe('Commit the working changes')
    expect(suggestion?.id).toBe('uncommitted-changes:detached:3')
  })

  it('stays quiet on a clean tree', () => {
    expect(deriveComposerSuggestion(ctx({ uncommittedFileCount: 0 }))).toBeNull()
  })
})

describe('deriveComposerSuggestion — dismissal memory', () => {
  it('skips a dismissed suggestion and falls through to the next candidate', () => {
    const suggestion = deriveComposerSuggestion(
      ctx({
        consideredModel: OPUS,
        uncommittedFileCount: 2,
        dismissedIds: new Set(['picker-dismissed:claude:claude-opus-5'])
      })
    )
    expect(suggestion?.trigger).toBe('uncommitted-changes')
  })

  it('returns null when every candidate is dismissed', () => {
    expect(
      deriveComposerSuggestion(
        ctx({
          consideredModel: OPUS,
          uncommittedFileCount: 2,
          dismissedIds: new Set([
            'picker-dismissed:claude:claude-opus-5',
            'uncommitted-changes:master:2'
          ])
        })
      )
    ).toBeNull()
  })

  it('re-offers a commit suggestion once the changed-file count moves', () => {
    // The id carries the count, so editing more files is a materially
    // different suggestion rather than the one they waved away.
    const suggestion = deriveComposerSuggestion(
      ctx({
        uncommittedFileCount: 5,
        dismissedIds: new Set(['uncommitted-changes:master:2'])
      })
    )
    expect(suggestion?.id).toBe('uncommitted-changes:master:5')
  })
})
