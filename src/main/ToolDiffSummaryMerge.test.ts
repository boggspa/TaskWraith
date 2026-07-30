import { describe, expect, it } from 'vitest'
import { isMeasuredDiffSummary, mergeToolDiffSummary } from './ToolDiffSummaryMerge'
import type { ToolDiffSummary } from './store/types'

function summary(overrides: Partial<ToolDiffSummary> = {}): ToolDiffSummary {
  return {
    additions: 0,
    deletions: 0,
    source: 'unknown',
    confidence: 'unknown',
    ...overrides
  }
}

const measured = (additions: number, deletions: number): ToolDiffSummary =>
  summary({ additions, deletions, source: 'git_numstat', confidence: 'exact' })

describe('isMeasuredDiffSummary', () => {
  it('requires BOTH a measured source and exact confidence', () => {
    expect(isMeasuredDiffSummary(measured(1, 1))).toBe(true)
    // A degraded sample (capped, partially attributed) forfeits its precedence.
    expect(isMeasuredDiffSummary(summary({ source: 'git_numstat', confidence: 'estimated' }))).toBe(
      false
    )
    // An estimating source never qualifies, even claiming exactness.
    expect(isMeasuredDiffSummary(summary({ source: 'codex_changes', confidence: 'exact' }))).toBe(
      false
    )
    expect(isMeasuredDiffSummary(undefined)).toBe(false)
  })
})

describe('mergeToolDiffSummary — the inversion being fixed', () => {
  it('lets a SMALLER measured summary beat an inflated string_replace estimate', () => {
    // The motivating case: a one-character fix inside a 40-line replaced block.
    // `string_replace` reports the whole block; git reports the truth. Under the
    // old larger-wins rule the truthful +1/-1 was rejected for being smaller.
    const inflated = summary({
      additions: 40,
      deletions: 40,
      source: 'string_replace',
      confidence: 'estimated'
    })
    expect(mergeToolDiffSummary(inflated, measured(1, 1))).toMatchObject({
      additions: 1,
      deletions: 1,
      source: 'git_numstat',
      confidence: 'exact'
    })
  })

  it('lets a smaller measured summary beat an inflated content estimate', () => {
    // `content` counts every written line as an addition with zero deletions.
    const inflated = summary({
      additions: 500,
      deletions: 0,
      source: 'content',
      confidence: 'estimated'
    })
    expect(mergeToolDiffSummary(inflated, measured(3, 2))).toMatchObject({
      additions: 3,
      deletions: 2,
      source: 'git_numstat'
    })
  })

  it('never lets a later estimate displace measured truth, however large', () => {
    const existing = measured(2, 1)
    const hugeEstimate = summary({
      additions: 9999,
      deletions: 9999,
      source: 'patch_preview',
      confidence: 'estimated'
    })
    expect(mergeToolDiffSummary(existing, hugeEstimate)).toBe(existing)
  })

  it('keeps the first measurement when a second measurement arrives', () => {
    const existing = measured(5, 5)
    expect(mergeToolDiffSummary(existing, measured(6, 6))).toBe(existing)
  })
})

describe('mergeToolDiffSummary — PINS the pre-existing behaviour', () => {
  it('takes the observation when there is nothing yet', () => {
    const incoming = summary({ additions: 4, source: 'patch_preview' })
    expect(mergeToolDiffSummary(undefined, incoming)).toBe(incoming)
  })

  it('merges same-source stats so a streamed patch preview can still grow', () => {
    const existing = summary({ additions: 2, deletions: 0, source: 'patch_preview' })
    const grown = summary({ additions: 9, deletions: 3, source: 'patch_preview' })
    expect(mergeToolDiffSummary(existing, grown)).toMatchObject({ additions: 9, deletions: 3 })
  })

  it('merges same-source stats even when they SHRANK', () => {
    // Pre-existing semantics: same-source is an unconditional merge, with no
    // magnitude test. Pinned so the refactor cannot quietly tighten it.
    const existing = summary({ additions: 9, deletions: 9, source: 'result_diff' })
    const smaller = summary({ additions: 1, deletions: 1, source: 'result_diff' })
    expect(mergeToolDiffSummary(existing, smaller)).toMatchObject({ additions: 1, deletions: 1 })
  })

  it('applies larger-wins across differing estimating sources', () => {
    const existing = summary({ additions: 5, deletions: 5, source: 'string_replace' })
    const bigger = summary({ additions: 6, deletions: 0, source: 'result_diff' })
    expect(mergeToolDiffSummary(existing, bigger)).toMatchObject({
      additions: 6,
      source: 'result_diff'
    })
  })

  it('rejects a smaller differing estimating source, as before', () => {
    const existing = summary({ additions: 10, deletions: 10, source: 'codex_changes' })
    const smaller = summary({ additions: 1, deletions: 1, source: 'result_diff' })
    expect(mergeToolDiffSummary(existing, smaller)).toBe(existing)
  })

  it('treats a single larger axis as larger-wins, matching the original OR', () => {
    const existing = summary({ additions: 10, deletions: 0, source: 'codex_changes' })
    // additions smaller, deletions larger — the original condition ORs the two.
    const mixed = summary({ additions: 2, deletions: 4, source: 'result_diff' })
    expect(mergeToolDiffSummary(existing, mixed)).toMatchObject({ deletions: 4 })
  })

  it('preserves fields the incoming summary omits', () => {
    const existing = summary({
      additions: 1,
      deletions: 1,
      source: 'patch_preview',
      files: [{ path: 'src/a.ts', additions: 1, deletions: 1 }]
    } as Partial<ToolDiffSummary>)
    const merged = mergeToolDiffSummary(existing, measured(2, 0))
    // Spread semantics: `files` survives because the measured summary carries none.
    expect(merged.files).toEqual([{ path: 'src/a.ts', additions: 1, deletions: 1 }])
    expect(merged.source).toBe('git_numstat')
  })

  it('does not mutate either argument', () => {
    const existing = summary({ additions: 1, deletions: 1, source: 'string_replace' })
    const incoming = measured(9, 9)
    const existingCopy = { ...existing }
    const incomingCopy = { ...incoming }
    mergeToolDiffSummary(existing, incoming)
    expect(existing).toEqual(existingCopy)
    expect(incoming).toEqual(incomingCopy)
  })
})
