import { describe, expect, it } from 'vitest'
import type { GitPrSummary, GitRepositorySnapshot } from '../../../main/services/GitService'
import type { ChatGitWorkflowInput } from '../../../shared/chatGitWorkflow'
import {
  buildSidebarGitIndicators,
  decodeSidebarGitIndicators,
  encodeSidebarGitIndicators,
  MAX_SIDEBAR_GIT_INDICATORS,
  sidebarGitIndicatorLabel,
  sidebarGitIndicatorTone,
  type SidebarGitIndicator
} from './sidebarGitIndicators'

function snapshot(patch: Partial<GitRepositorySnapshot> = {}): GitRepositorySnapshot {
  return {
    requestedPath: '/repo',
    repoRoot: '/repo',
    branch: 'tw-tui',
    detached: false,
    upstream: 'origin/tw-tui',
    ahead: 0,
    behind: 0,
    files: [],
    counts: { changed: 0, staged: 0, unstaged: 0, untracked: 0 },
    clean: true,
    mergeState: null,
    conflicts: 0,
    lineStats: { additions: 0, deletions: 0 },
    ...patch
  } as GitRepositorySnapshot
}

function pr(patch: Partial<GitPrSummary> = {}): GitPrSummary {
  return { number: 12, url: 'https://github.com/o/r/pull/12', state: 'OPEN', ...patch }
}

const kinds = (list: readonly SidebarGitIndicator[]): string[] => list.map((i) => i.kind)

describe('buildSidebarGitIndicators', () => {
  it('shows the pushed tick when every local commit is on the upstream', () => {
    expect(kinds(buildSidebarGitIndicators({ snapshot: snapshot() }))).toEqual(['pushed'])
  })

  // Explicit product rule: a detached checkout has no branch identity to grade.
  it('renders nothing at all on a detached HEAD, whatever else is true', () => {
    expect(
      buildSidebarGitIndicators({
        snapshot: snapshot({ detached: true, ahead: 4 }),
        pr: pr({ state: 'MERGED' }),
        workflow: { state: 'merged', prNumber: 9 }
      })
    ).toEqual([])
  })

  it('falls back to the ahead count when work is active and nothing else applies', () => {
    const out = buildSidebarGitIndicators({ snapshot: snapshot({ ahead: 3 }) })
    expect(out).toEqual([{ kind: 'ahead', count: 3 }])
  })

  it('yields the ahead count to any pull-request indicator', () => {
    const out = buildSidebarGitIndicators({ snapshot: snapshot({ ahead: 3 }), pr: pr() })
    expect(kinds(out)).toEqual(['pr-open'])
  })

  it('reports no strip for an unpublished branch with nothing to say', () => {
    expect(buildSidebarGitIndicators({ snapshot: snapshot({ upstream: undefined }) })).toEqual([])
  })

  describe('pull-request lifecycle', () => {
    const kindFor = (patch: Partial<GitPrSummary>): string =>
      kinds(buildSidebarGitIndicators({ snapshot: snapshot(), pr: pr(patch) }))[1]

    it('is open while merely open', () => {
      expect(kindFor({ mergeStateStatus: 'BLOCKED' })).toBe('pr-open')
    })

    it('is ready once mergeable with a clean rollup', () => {
      expect(kindFor({ mergeStateStatus: 'CLEAN' })).toBe('pr-ready')
    })

    // Accepted for merge but NOT landed — the orange state.
    it('is queued when auto-merge is armed, outranking ready', () => {
      expect(kindFor({ mergeStateStatus: 'CLEAN', autoMergeEnabled: true })).toBe('pr-queued')
    })

    it('is merged only once GitHub reports MERGED', () => {
      expect(kindFor({ state: 'MERGED', autoMergeEnabled: true })).toBe('pr-merged')
    })

    it('is closed when closed without merging', () => {
      expect(kindFor({ state: 'CLOSED' })).toBe('pr-closed')
    })

    it('treats a draft as open rather than ready', () => {
      expect(kindFor({ isDraft: true, mergeStateStatus: 'CLEAN' })).toBe('pr-open')
    })
  })

  // The "multiple PRs" case: the thread's own shipped PR is a separate source
  // from whatever PR the branch currently points at.
  it('shows the thread marker beside a different live PR', () => {
    const out = buildSidebarGitIndicators({
      snapshot: snapshot(),
      pr: pr({ number: 14, state: 'OPEN' }),
      workflow: { state: 'merged', prNumber: 10 }
    })
    expect(kinds(out)).toEqual(['pushed', 'pr-open', 'pr-merged'])
    expect(out[2]).toMatchObject({ prNumber: 10, ownThread: true })
  })

  it('collapses the marker into the live PR when they are the same PR', () => {
    const out = buildSidebarGitIndicators({
      snapshot: snapshot(),
      pr: pr({ number: 10, state: 'MERGED' }),
      workflow: { state: 'merged', prNumber: 10 }
    })
    expect(kinds(out)).toEqual(['pushed', 'pr-merged'])
    expect(out[1].ownThread).toBeUndefined()
  })

  it('keeps both when the same PR reached different states', () => {
    const out = buildSidebarGitIndicators({
      snapshot: snapshot(),
      pr: pr({ number: 10, state: 'OPEN' }),
      workflow: { state: 'closed', prNumber: 10 }
    })
    expect(kinds(out)).toEqual(['pushed', 'pr-open', 'pr-closed'])
  })

  // Non-terminal markers would just duplicate the live PR, and the marker is
  // not refreshed while the thread is unfocused.
  it('ignores non-terminal thread markers', () => {
    for (const state of ['pushed', 'draft', 'open', 'failed'] as const) {
      const workflow: ChatGitWorkflowInput = { state, prNumber: 10 }
      expect(kinds(buildSidebarGitIndicators({ snapshot: snapshot(), workflow }))).toEqual([
        'pushed'
      ])
    }
  })

  it('caps a mega-busy thread at three icons', () => {
    const out = buildSidebarGitIndicators({
      snapshot: snapshot(),
      pr: pr({ number: 14, state: 'OPEN' }),
      workflow: { state: 'closed', prNumber: 10 }
    })
    expect(out.length).toBeLessThanOrEqual(MAX_SIDEBAR_GIT_INDICATORS)
  })
})

describe('sidebar git indicator tones', () => {
  // The maintainer's stated vocabulary, and GitHub's: green is never "merged".
  it('paints merged purple and open green, not the other way round', () => {
    expect(sidebarGitIndicatorTone('pr-merged')).toBe('merged')
    expect(sidebarGitIndicatorTone('pr-open')).toBe('open')
    expect(sidebarGitIndicatorTone('pr-ready')).toBe('open')
    expect(sidebarGitIndicatorTone('pr-queued')).toBe('queued')
    expect(sidebarGitIndicatorTone('pr-closed')).toBe('closed')
    expect(sidebarGitIndicatorTone('pushed')).toBe('synced')
  })

  it('says a queued PR has not landed yet', () => {
    expect(sidebarGitIndicatorLabel({ kind: 'pr-queued', prNumber: 12 })).toBe(
      'PR #12 is queued to merge — accepted, waiting on checks or its turn'
    )
  })

  it('attributes a thread-owned marker', () => {
    expect(sidebarGitIndicatorLabel({ kind: 'pr-merged', prNumber: 10, ownThread: true })).toBe(
      "this thread's PR #10 merged"
    )
  })
})

describe('encode/decode', () => {
  it('round-trips every field the strip renders', () => {
    const list: SidebarGitIndicator[] = [
      { kind: 'pushed' },
      { kind: 'pr-open', prNumber: 14 },
      { kind: 'pr-merged', prNumber: 10, ownThread: true }
    ]
    expect(encodeSidebarGitIndicators(list)).toBe('pushed:|pr-open:14|pr-merged:10:own')
    expect(decodeSidebarGitIndicators(encodeSidebarGitIndicators(list))).toEqual(list)
  })

  it('round-trips the ahead count', () => {
    const list: SidebarGitIndicator[] = [{ kind: 'ahead', count: 7 }]
    expect(decodeSidebarGitIndicators(encodeSidebarGitIndicators(list))).toEqual(list)
  })

  it('is empty-safe in both directions', () => {
    expect(encodeSidebarGitIndicators([])).toBe('')
    expect(decodeSidebarGitIndicators('')).toEqual([])
    expect(decodeSidebarGitIndicators(null)).toEqual([])
    expect(decodeSidebarGitIndicators(undefined)).toEqual([])
  })

  it('drops unknown kinds and re-applies the cap', () => {
    expect(decodeSidebarGitIndicators('pushed:|bogus:1|pr-open:14')).toEqual([
      { kind: 'pushed' },
      { kind: 'pr-open', prNumber: 14 }
    ])
    expect(decodeSidebarGitIndicators('pushed:|pr-open:1|pr-merged:2|pr-closed:3')).toHaveLength(
      MAX_SIDEBAR_GIT_INDICATORS
    )
  })
})
