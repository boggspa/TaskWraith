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

    expect(html).toContain('git-status-ahead')
    expect(html).toContain('<span class="sr-only">3 ahead</span>')
    expect(html).toContain('digit-odometer')
    expect(html).not.toContain('synced')
  })

  it('renders both ahead and behind counts through digit odometers', () => {
    const html = renderToStaticMarkup(<GitSyncChip snapshot={snapshot({ ahead: 3, behind: 2 })} />)

    expect(html).toContain('git-status-ahead')
    expect(html).toContain('git-status-behind')
    expect(html).toContain('<span class="sr-only">3 ahead</span>')
    expect(html).toContain('<span class="sr-only">2 behind</span>')
  })

  it('renders a green synced chip once the branch matches upstream', () => {
    const html = renderToStaticMarkup(<GitSyncChip snapshot={snapshot()} />)

    expect(html).toContain('git-status-synced')
    expect(html).toContain('synced')
    expect(html).toContain('Branch matches origin/feature/demo')
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
