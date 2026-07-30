import { describe, expect, it } from 'vitest'
import { attributeToolChurn, normaliseChurnPath } from './ToolChurnAttribution'
import { diffWorkspaceChurn } from './WorkspaceChurn'
import type { WorkspaceChurnSample } from './WorkspaceChurn'
import { isMeasuredDiffSummary, mergeToolDiffSummary } from '../shared/toolDiffSummaryMerge'

const sample = (
  tracked: WorkspaceChurnSample['tracked'] = {},
  untracked: WorkspaceChurnSample['untracked'] = {}
): WorkspaceChurnSample => ({ tracked, untracked })

const deltaBetween = (
  before: WorkspaceChurnSample,
  after: WorkspaceChurnSample
): ReturnType<typeof diffWorkspaceChurn> => diffWorkspaceChurn(before, after)

describe('normaliseChurnPath', () => {
  it('reduces the forms a tool parameter arrives in to the numstat form', () => {
    expect(normaliseChurnPath('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(normaliseChurnPath('./src/a.ts')).toBe('src/a.ts')
    expect(normaliseChurnPath('src\\a.ts')).toBe('src/a.ts')
    expect(normaliseChurnPath('/repo/src/a.ts', '/repo/')).toBe('src/a.ts')
    expect(normaliseChurnPath('  src/a.ts  ')).toBe('src/a.ts')
  })

  it('leaves a path outside the workspace prefix alone', () => {
    expect(normaliseChurnPath('/elsewhere/b.ts', '/repo')).toBe('elsewhere/b.ts')
  })
})

describe('attributeToolChurn', () => {
  it('measures one call as the DELTA, not as churn since HEAD', () => {
    // The file was already 40/5 dirty before this call — that is the normal
    // case, and attributing it would report the same number on every edit.
    const before = sample({ 'src/a.ts': { additions: 40, deletions: 5 } })
    const after = sample({ 'src/a.ts': { additions: 43, deletions: 6 } })

    const summary = attributeToolChurn({
      delta: deltaBetween(before, after),
      touchedPaths: ['src/a.ts'],
      exclusive: true
    })

    expect(summary).toMatchObject({
      additions: 3,
      deletions: 1,
      source: 'git_numstat',
      confidence: 'exact'
    })
    expect(isMeasuredDiffSummary(summary)).toBe(true)
  })

  it('outranks the over-counting estimate it exists to correct', () => {
    // `string_replace` counts the whole replaced block: a one-line fix inside a
    // forty-line block reports +40/-40. The measured +1/-1 is SMALLER, which is
    // exactly why larger-wins used to reject it.
    const estimate = {
      additions: 40,
      deletions: 40,
      source: 'string_replace' as const,
      confidence: 'estimated' as const
    }
    const measured = attributeToolChurn({
      delta: deltaBetween(
        sample({ 'src/a.ts': { additions: 0, deletions: 0 } }),
        sample({ 'src/a.ts': { additions: 1, deletions: 1 } })
      ),
      touchedPaths: ['src/a.ts'],
      exclusive: true
    })
    expect(measured).toBeDefined()

    expect(mergeToolDiffSummary(estimate, measured!)).toMatchObject({
      additions: 1,
      deletions: 1,
      source: 'git_numstat'
    })
  })

  it('attributes only the touched path when a peer changed another file', () => {
    const before = sample({})
    const after = sample({
      'src/mine.ts': { additions: 4, deletions: 0 },
      'src/theirs.ts': { additions: 900, deletions: 900 }
    })

    const summary = attributeToolChurn({
      delta: deltaBetween(before, after),
      touchedPaths: ['src/mine.ts'],
      exclusive: true
    })

    expect(summary?.additions).toBe(4)
    expect(summary?.files?.map((file) => file.path)).toEqual(['src/mine.ts'])
  })

  it('degrades to estimated when the interval was not exclusive', () => {
    // Another write overlapped the two samples, so the delta cannot be pinned
    // to this call. Still worth reporting — but it must not outrank anything.
    const summary = attributeToolChurn({
      delta: deltaBetween(sample({}), sample({ 'src/a.ts': { additions: 7, deletions: 2 } })),
      touchedPaths: ['src/a.ts'],
      exclusive: false
    })

    expect(summary).toMatchObject({ additions: 7, confidence: 'estimated' })
    expect(isMeasuredDiffSummary(summary)).toBe(false)
    // And the merge keeps the larger estimate rather than treating it as truth.
    const estimate = {
      additions: 40,
      deletions: 40,
      source: 'string_replace' as const,
      confidence: 'estimated' as const
    }
    expect(mergeToolDiffSummary(estimate, summary!)?.additions).toBe(40)
  })

  it('declines rather than claiming an exact zero for an unmatched path', () => {
    // A delta lists only paths that CHANGED, so absence cannot distinguish
    // "unchanged" from "invisible to git" (ignored / outside the repo). An exact
    // +0/-0 would be a measured-looking lie that outranks a correct estimate.
    const summary = attributeToolChurn({
      delta: deltaBetween(sample({}), sample({ 'src/other.ts': { additions: 3, deletions: 0 } })),
      touchedPaths: ['build/ignored.ts'],
      exclusive: true
    })

    expect(summary).toBeUndefined()
  })

  it('declines when the tool named no path, rather than claiming the whole tree', () => {
    // A shell command changed something. Attributing the tree-wide delta would
    // report a concurrent seat's work as this call's.
    const summary = attributeToolChurn({
      delta: deltaBetween(sample({}), sample({ 'src/a.ts': { additions: 5, deletions: 5 } })),
      touchedPaths: [],
      exclusive: true
    })

    expect(summary).toBeUndefined()
  })

  it('counts a newly created untracked file as additions', () => {
    const summary = attributeToolChurn({
      delta: deltaBetween(sample({}, {}), sample({}, { 'src/new.ts': { additions: 12, deletions: 0 } })),
      touchedPaths: ['src/new.ts'],
      exclusive: true
    })

    expect(summary).toMatchObject({ additions: 12, deletions: 0, confidence: 'exact' })
    expect(summary?.files?.[0]).toMatchObject({ path: 'src/new.ts', status: 'created' })
  })

  it('names a binary file without inventing line counts', () => {
    const summary = attributeToolChurn({
      delta: deltaBetween(sample({}), sample({ 'assets/logo.png': { additions: 0, deletions: 0, binary: true } })),
      touchedPaths: ['assets/logo.png'],
      exclusive: true
    })

    // No counts at all, and NOT exact — `+0/-0` would read as "measured no change".
    expect(summary?.additions).toBeUndefined()
    expect(summary?.files?.[0]).toMatchObject({ path: 'assets/logo.png' })
    expect(isMeasuredDiffSummary(summary)).toBe(false)
  })

  it('matches an absolute tool parameter against the repo-relative entry', () => {
    const summary = attributeToolChurn({
      delta: deltaBetween(sample({}), sample({ 'src/a.ts': { additions: 2, deletions: 1 } })),
      touchedPaths: ['/repo/src/a.ts'],
      workspacePath: '/repo',
      exclusive: true
    })

    expect(summary).toMatchObject({ additions: 2, deletions: 1, confidence: 'exact' })
  })

  it('does not report a path whose churn only SHRANK', () => {
    // A revert lands in `decreasedPaths`, never in `entries`, so there is no
    // measured summary to attach — the call did not add measurable churn.
    const summary = attributeToolChurn({
      delta: deltaBetween(
        sample({ 'src/a.ts': { additions: 40, deletions: 5 } }),
        sample({ 'src/a.ts': { additions: 2, deletions: 1 } })
      ),
      touchedPaths: ['src/a.ts'],
      exclusive: true
    })

    expect(summary).toBeUndefined()
  })
})
