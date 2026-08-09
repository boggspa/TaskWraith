import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import type { GitWorkspaceStats } from '../../../main/services/GitWorkspaceStats'
import type { WorkLockProjectionSnapshot } from '../../../shared/workLockProjection'
import {
  unavailableWorkProvenanceSnapshot,
  type WorkProvenanceSnapshot
} from '../../../shared/workProvenance'
import { WorkspaceStatsPanel } from './WorkspaceStatsPopover'
import { buildWorkspaceStatsContext, type WorkspaceStatsContext } from './workspaceStatsContext'

const snapshot: GitRepositorySnapshot = {
  requestedPath: '/repo',
  repoRoot: '/repo',
  branch: 'main',
  commit: 'f92cf96',
  detached: false,
  ahead: 0,
  behind: 0,
  files: [],
  counts: { changed: 13, staged: 12, unstaged: 1, untracked: 26 },
  clean: false,
  mergeState: null,
  conflicts: 0,
  lineStats: { additions: 429, deletions: 16 }
}

const stats: GitWorkspaceStats = {
  repoRoot: '/repo',
  observedAt: '2026-08-03T19:00:00.000Z',
  coherent: true,
  totalCommits: 1,
  localBranchCount: 12,
  attachedWorktreeCount: 1,
  trackedLines: 1_223_743,
  activeDays: 1,
  historySpanDays: 49,
  commitsPerActiveDay: 1,
  historyTruncated: false,
  latestCommit: {
    hash: 'f92cf96',
    authoredOn: '2026-06-16',
    subject: 'Initial commit'
  },
  commitsSinceLatestTag: null
}

const context: WorkspaceStatsContext = {
  chatId: 'chat-1',
  baseWorkspacePath: '/repo',
  workspacePath: '/repo',
  label: 'Test 1',
  snapshot
}

const emptyProvenance: WorkProvenanceSnapshot = {
  ...unavailableWorkProvenanceSnapshot('fixture'),
  available: true,
  reason: undefined
}

function renderPanel(
  lockSnapshot: WorkLockProjectionSnapshot | null,
  provenanceSnapshot: WorkProvenanceSnapshot | null = emptyProvenance,
  provenanceError: string | null = null
): string {
  return renderToStaticMarkup(
    <WorkspaceStatsPanel
      context={context}
      stats={stats}
      statsLoading={false}
      statsError={null}
      provenanceSnapshot={provenanceSnapshot}
      provenanceLoading={false}
      provenanceError={provenanceError}
      onRefreshProvenance={vi.fn()}
      lockSnapshot={lockSnapshot}
      locksLoading={false}
      id="workspace-stats"
      labelledBy="workspace-stats-trigger"
      onClose={vi.fn()}
    />
  )
}

describe('WorkspaceStatsPopover', () => {
  it('uses gold ahead and blue behind semantics for a no-upstream local history', () => {
    const html = renderPanel({
      schemaVersion: 1,
      generation: 1,
      sampledAt: '2026-08-03T19:00:00.000Z',
      locks: []
    })

    expect(html).toContain('workspace-stats-ahead')
    expect(html).toContain('workspace-stats-behind')
    expect(html).toContain('1 commit ahead')
    expect(html).toContain('0 commits behind')
    expect(html).toContain('No upstream · all history local')
    expect(html).toContain('13 changed paths · 26 untracked')
    expect(html).toContain('12 staged · 1 unstaged')
    expect(html).toContain('12 local branches · 1 worktree')
    expect(html).toContain('1,223,743')
    expect(html).toContain('1 of 49')
    expect(html).toContain('No current work evidence')
    expect(html).toContain('aria-label="Refresh work evidence"')
    expect(html).toContain('title="Run one bounded local provenance scan"')
    expect(html).toContain('No active TaskWraith work locks')
    expect(html).toContain('Neither is inferred authorship')
  })

  it('groups several locks from the same worker lane into one compact row', () => {
    const lockSnapshot: WorkLockProjectionSnapshot = {
      schemaVersion: 1,
      generation: 2,
      sampledAt: '2026-08-03T19:00:00.000Z',
      locks: [
        {
          schemaVersion: 1,
          lockId: 'lock-1',
          status: 'held',
          owner: {
            displayName: 'Codex Worker',
            provider: 'codex',
            chatId: 'worker-chat',
            chatTitle: 'Tighten repository stats',
            laneId: 'lane-1'
          },
          workspace: {
            basePath: '/repo',
            effectivePath: '/repo',
            isWorktree: false
          },
          target: { kind: 'file', path: 'src/a.ts' },
          acquiredAt: '2026-08-03T18:55:00.000Z',
          statusChangedAt: '2026-08-03T18:55:00.000Z'
        },
        {
          schemaVersion: 1,
          lockId: 'lock-2',
          status: 'held',
          owner: {
            displayName: 'Codex Worker',
            provider: 'codex',
            chatId: 'worker-chat',
            chatTitle: 'Tighten repository stats',
            laneId: 'lane-1'
          },
          workspace: {
            basePath: '/repo',
            effectivePath: '/repo',
            isWorktree: false
          },
          target: { kind: 'file', path: 'src/b.ts' },
          acquiredAt: '2026-08-03T18:56:00.000Z',
          statusChangedAt: '2026-08-03T18:56:00.000Z'
        }
      ]
    }

    const html = renderPanel(lockSnapshot)

    expect(html.match(/Tighten repository stats/g)).toHaveLength(1)
    expect(html).toContain('2 locks')
    expect(html).toContain('1 worker lane')
    expect(html).toContain('src/a.ts, src/b.ts')
    expect(html).not.toContain('No active TaskWraith work locks')
  })

  it('reports unavailable evidence rather than turning a failed observation into zero', () => {
    const html = renderPanel(null, unavailableWorkProvenanceSnapshot('Projection unavailable.'))

    expect(html).toContain('Edit authority unavailable')
    expect(html).toContain('Work evidence unavailable')
    expect(html).toContain('Projection unavailable.')
    expect(html).not.toContain('0 active locks')
  })

  it('keeps prior evidence visibly stale when an explicit refresh fails', () => {
    const error = 'Git repository root could not be resolved for this registered workspace.'
    const html = renderPanel(
      {
        schemaVersion: 1,
        generation: 1,
        sampledAt: '2026-08-03T19:00:00.000Z',
        locks: []
      },
      emptyProvenance,
      error
    )

    expect(html).toContain('workspace-stats-provenance-summary is-stale')
    expect(html).toContain('Refresh failed · showing previous evidence')
    expect(html).toContain('Work evidence refresh failed')
    expect(html).toContain(error)
    expect(html).toContain('No current work evidence')
  })

  it('binds to a selected effective worktree and hides the action for global chats', () => {
    expect(
      buildWorkspaceStatsContext({
        chatId: 'chat-1',
        baseWorkspacePath: '/repo',
        worktreeSelection: {
          baseWorkspacePath: '/repo',
          effectiveWorkspacePath: '/repo-worktrees/feature',
          branch: 'feature',
          label: 'feature',
          source: 'composer'
        },
        snapshot: {
          ...snapshot,
          requestedPath: '/repo-worktrees/feature',
          repoRoot: '/repo-worktrees/feature',
          branch: 'feature'
        }
      })
    ).toMatchObject({
      baseWorkspacePath: '/repo',
      workspacePath: '/repo-worktrees/feature',
      label: 'feature'
    })
    expect(
      buildWorkspaceStatsContext({
        chatId: 'global-chat',
        baseWorkspacePath: '/repo',
        isGlobalChat: true
      })
    ).toBeUndefined()
  })
})
