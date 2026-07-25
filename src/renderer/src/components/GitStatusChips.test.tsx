import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GitPrSummary, GitRepositorySnapshot } from '../../../main/services/GitService'
import { GitPrLifecycleChip, GitSyncChip } from './GitStatusChips'

function snapshot(overrides: Partial<GitRepositorySnapshot> = {}): GitRepositorySnapshot {
  return {
    requestedPath: '/repo',
    repoRoot: '/repo',
    branch: 'feature/demo',
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    detached: false,
    upstream: 'origin/feature/demo',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:example/repo.git',
    ahead: 0,
    behind: 0,
    files: [],
    counts: { changed: 0, staged: 0, unstaged: 0, untracked: 0 },
    clean: true,
    mergeState: null,
    conflicts: 0,
    lineStats: { additions: 0, deletions: 0 },
    ...overrides
  }
}

describe('GitSyncChip', () => {
  it('renders N/A when a branch has no upstream', () => {
    const html = renderToStaticMarkup(<GitSyncChip snapshot={snapshot({ upstream: undefined })} />)

    expect(html).toContain('git-status-unpublished')
    expect(html).toContain('N/A')
    expect(html).toContain('No upstream')
  })

  it('preserves numeric ahead counts instead of replacing them with PR state', () => {
    const html = renderToStaticMarkup(<GitSyncChip snapshot={snapshot({ ahead: 3 })} />)

    expect(html).toContain('git-sync-ahead')
    expect(html).toContain('git-status-ahead')
    expect(html).toContain('<span class="sr-only">3 ahead</span>')
    expect(html).toContain('digit-odometer')
    expect(html).not.toContain('git-status-drift-glyph')
    expect(html).not.toContain('synced')
  })

  it('renders an amber branch-drift glyph and traceable count when behind upstream', () => {
    const html = renderToStaticMarkup(<GitSyncChip snapshot={snapshot({ behind: 2 })} />)

    expect(html).toContain('git-sync-behind')
    expect(html).toContain('data-sync-state="behind"')
    expect(html).toContain('git-status-behind')
    expect(html).toContain('git-status-drift-glyph')
    expect(html).toContain('<span class="sr-only">2 behind</span>')
    expect(html).toContain('2 commits behind local tracking ref origin/feature/demo')
    expect(html).toContain('fetch to refresh remote state')
    expect(html).not.toContain('git-status-diverged')
  })

  it('renders both counts plus a red semantic state when histories diverge', () => {
    const html = renderToStaticMarkup(<GitSyncChip snapshot={snapshot({ ahead: 3, behind: 2 })} />)

    expect(html).toContain('git-sync-diverged')
    expect(html).toContain('data-sync-state="diverged"')
    expect(html).toContain('git-status-ahead')
    expect(html).toContain('git-status-behind git-status-diverged')
    expect(html).toContain('git-status-drift-glyph')
    expect(html).toContain('<span class="sr-only">3 ahead</span>')
    expect(html).toContain('<span class="sr-only">2 behind</span>')
    expect(html).toContain('Diverged from local tracking ref origin/feature/demo')
    expect(html).toContain('3 commits local-only')
    expect(html).toContain('2 commits upstream-only')
  })

  it('renders NOTHING once the branch matches upstream — the green tick moved to the timecode-bar satellite as "Pushed"', () => {
    const html = renderToStaticMarkup(<GitSyncChip snapshot={snapshot()} />)

    expect(html).toBe('')
  })
})

describe('GitPrLifecycleChip', () => {
  it('renders a merged PR with the merge glyph and green tone class', () => {
    const pr: GitPrSummary = {
      number: 42,
      state: 'MERGED',
      baseRefName: 'master',
      url: 'https://github.com/example/repo/pull/42'
    }
    const html = renderToStaticMarkup(<GitPrLifecycleChip pr={pr} snapshot={snapshot()} />)

    expect(html).toContain('git-pr-merged')
    expect(html).toContain('#42 merged')
    expect(html).toContain('role="button"')
  })

  it('marks a PR as stale when its head differs from local HEAD', () => {
    const pr: GitPrSummary = {
      number: 7,
      state: 'OPEN',
      headRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    }
    const html = renderToStaticMarkup(<GitPrLifecycleChip pr={pr} snapshot={snapshot()} />)

    expect(html).toContain('git-pr-stale')
    expect(html).toContain('#7 stale')
    expect(html).toContain('head differs from local HEAD')
  })

  it('marks a closed unmerged PR as rejected/closed red state', () => {
    const pr: GitPrSummary = { number: 9, state: 'CLOSED' }
    const html = renderToStaticMarkup(<GitPrLifecycleChip pr={pr} snapshot={snapshot()} />)

    expect(html).toContain('git-pr-closed')
    expect(html).toContain('#9 closed')
    expect(html).toContain('closed without merge')
  })
})
