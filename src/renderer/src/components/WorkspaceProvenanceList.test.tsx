import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  WorkProvenanceActor,
  WorkProvenanceAttributionPath,
  WorkProvenanceContributor,
  WorkProvenanceItem,
  WorkProvenanceSnapshot
} from '../../../shared/workProvenance'
import {
  activeWorkspaceProvenanceContributorCount,
  buildWorkspaceProvenanceRows,
  WorkspaceProvenanceList
} from './WorkspaceProvenanceList'

function contributor(
  actor: WorkProvenanceActor,
  relationship: 'current' | 'predecessor' = 'current'
): WorkProvenanceContributor {
  return {
    actor,
    confidence: 'ambiguous',
    confidenceReason: 'Multiple contributors overlap these bytes.',
    evidence: [
      {
        originEventId: `${relationship}-origin`,
        source: 'marker-observation',
        recordedAt: '2026-08-03T20:00:00.000Z',
        operation: null,
        claim: null,
        authority: null,
        relationship
      }
    ]
  }
}

function item(
  id: string,
  path: string,
  contributors: WorkProvenanceContributor[]
): WorkProvenanceItem {
  return {
    workItemId: id,
    repositoryId: 'a'.repeat(64),
    worktreeId: 'b'.repeat(64),
    path,
    lifecycle: 'unresolved',
    confidence: 'ambiguous',
    confidenceReason: 'Multiple contributors overlap these bytes.',
    liveness: 'live',
    currentDirty: true,
    currentStatus: ' M',
    renamedFrom: null,
    currentFingerprint: null,
    currentContributors: contributors,
    contributors,
    recovery: null,
    resolutions: [],
    lineageOriginEventIds: [],
    lineageResolutions: [],
    correlatedCommits: [],
    firstObservedAt: '2026-08-03T20:00:00.000Z',
    lastObservedAt: '2026-08-03T20:00:00.000Z'
  }
}

function path(
  workItemId: string | null,
  name: string,
  additions: number | null,
  deletions: number | null
): WorkProvenanceAttributionPath {
  return {
    path: name,
    status: workItemId ? ' M' : '??',
    renamedFrom: null,
    additions,
    deletions,
    binary: false,
    untracked: workItemId === null,
    workItemId,
    confidence: workItemId ? 'ambiguous' : 'unknown',
    contributorCount: workItemId ? 2 : 0
  }
}

function snapshot(): WorkProvenanceSnapshot {
  const lane = contributor({ taskId: 'task-1', chatTitle: 'Workspace stats provenance' })
  const predecessor = contributor(
    { taskId: 'task-old', displayName: 'Earlier contributor' },
    'predecessor'
  )
  const first = path('work-1', 'src/main/a.ts', 12, 3)
  const second = path('work-2', 'src/main/b.ts', 8, 1)
  const unknown = path(null, 'new-file.ts', null, null)
  return {
    available: true,
    stale: false,
    projectionVersion: 1,
    classifierVersion: 1,
    eventSchemaVersion: 1,
    cursor: 'c'.repeat(64),
    generatedAt: '2026-08-03T20:00:00.000Z',
    repository: null,
    gitGeneration: null,
    attribution: {
      root: {
        files: 3,
        trackedFiles: 2,
        untrackedFiles: 1,
        binaryFiles: 0,
        additions: 20,
        deletions: 4
      },
      unique: {
        files: 0,
        trackedFiles: 0,
        untrackedFiles: 0,
        binaryFiles: 0,
        additions: 0,
        deletions: 0,
        paths: []
      },
      sharedAmbiguous: {
        files: 2,
        trackedFiles: 2,
        untrackedFiles: 0,
        binaryFiles: 0,
        additions: 20,
        deletions: 4,
        paths: [first, second]
      },
      unclaimedUnknown: {
        files: 1,
        trackedFiles: 0,
        untrackedFiles: 1,
        binaryFiles: 0,
        additions: 0,
        deletions: 0,
        paths: [unknown]
      },
      invariant: { files: true, additions: true, deletions: true, satisfied: true }
    },
    window: { limit: 200, totalItems: 2, returnedItems: 2, truncated: false },
    workItems: [
      item('work-1', first.path, [lane, predecessor]),
      item('work-2', second.path, [lane, predecessor])
    ]
  }
}

describe('WorkspaceProvenanceList', () => {
  it('groups paths by the same durable task/reference and sums disjoint totals once', () => {
    const rows = buildWorkspaceProvenanceRows(snapshot())

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'shared', additions: 20, deletions: 4 })
    expect(rows[0].paths.map((entry) => entry.path)).toEqual(['src/main/a.ts', 'src/main/b.ts'])
    expect(rows[1].kind).toBe('unknown')
  })

  it('deduplicates active current contributors and excludes predecessor-only identities', () => {
    expect(activeWorkspaceProvenanceContributorCount(snapshot())).toBe(1)
  })

  it('renders liveness, confidence, diff, paths, contributors, and evidence details', () => {
    const html = renderToStaticMarkup(<WorkspaceProvenanceList snapshot={snapshot()} />)

    expect(html).toContain('Workspace stats provenance')
    expect(html).toContain('ambiguous')
    expect(html).toContain('src/main/a.ts')
    expect(html).toContain('Contributors and local IDs')
    expect(html).toContain('Evidence and confidence')
    expect(html).toContain('Unclaimed dirty paths')
  })
})
