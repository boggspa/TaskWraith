import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  projectWorkspaceLockMarkers,
  sanitizeRuntimeMarkerInstanceId,
  workspaceLockRuntimeMarkerFilename
} from './WorkspaceLockMarkerProjection'
import type { WorkspaceLockLease } from './WorkspaceLockTypes'

function lease(overrides: Partial<WorkspaceLockLease> = {}): WorkspaceLockLease {
  return {
    leaseId: 'lease-1',
    acquiredTransitionId: 'transition-1',
    authorityInstanceId: 'desktop/one',
    authorityGeneration: 1,
    owner: {
      lockOwnerId: 'owner-lane-1',
      runId: 'run-1',
      laneId: 'lane-1',
      chatId: 'chat-1',
      displayName: 'Builder',
      chatTitle: 'Fix workspace accounting',
      provider: 'codex',
      participantId: 'writer-1',
      pid: 4102,
      processBirthIdentity: 'private-birth-receipt'
    },
    claim: {
      workspaceIdentity: '/repos/project',
      worktreeCanonicalPath: '/repos/project-worktrees/feature',
      worktreeIdentity: '/repos/project-worktrees/feature',
      worktreeObjectIdentity: 'dev:1:ino:1',
      targetCanonicalPath: '/repos/project-worktrees/feature/src/app.ts',
      comparisonTargetPath: '/repos/project-worktrees/feature/src/app.ts',
      physicalTargetIdentity: '/repos/project-worktrees/feature/src/app.ts',
      displayWorkspacePath: '/repos/project',
      displayWorktreePath: '/repos/project-worktrees/feature',
      relativeTargetPath: 'src/app.ts',
      kind: 'file',
      mode: 'write'
    },
    acquiredAt: '2026-07-29T15:00:00.000Z',
    status: 'held',
    statusChangedAt: '2026-07-29T15:00:00.000Z',
    ...overrides
  }
}

const options = {
  projectedAt: '2026-07-29T15:05:00.000Z',
  expiresAt: '2026-07-29T16:05:00.000Z'
}

describe('WorkspaceLockMarkerProjection', () => {
  it('groups active leases by effective worktree, exact lock owner, and authority instance', () => {
    const markers = projectWorkspaceLockMarkers(
      [
        lease({ leaseId: 'later' }),
        lease({
          leaseId: 'same-run-other-lane',
          owner: { ...lease().owner, lockOwnerId: 'owner-lane-2' }
        }),
        lease({
          leaseId: 'other-run',
          owner: { ...lease().owner, lockOwnerId: 'owner-run-2', runId: 'run-2' }
        }),
        lease({ leaseId: 'other-instance', authorityInstanceId: 'desktop-two' }),
        lease({
          leaseId: 'other-worktree',
          claim: {
            ...lease().claim,
            worktreeCanonicalPath: '/repos/project-worktrees/other',
            worktreeIdentity: '/repos/project-worktrees/other'
          }
        })
      ],
      options
    )

    expect(markers).toHaveLength(5)
    expect(
      markers.map((marker) => [
        marker.root,
        marker.authorityInstanceId,
        marker.lockOwnerId,
        marker.ownerRunId
      ])
    ).toEqual([
      ['/repos/project-worktrees/feature', 'desktop-two', 'owner-lane-1', 'run-1'],
      ['/repos/project-worktrees/feature', 'desktop/one', 'owner-lane-1', 'run-1'],
      ['/repos/project-worktrees/feature', 'desktop/one', 'owner-lane-2', 'run-1'],
      ['/repos/project-worktrees/feature', 'desktop/one', 'owner-run-2', 'run-2'],
      ['/repos/project-worktrees/other', 'desktop/one', 'owner-lane-1', 'run-1']
    ])
    expect(markers[1].filename).toBe(
      `.WORK-IN-PROGRESS-taskwraith-runtime-desktop-one-${createHash('sha256')
        .update('desktop/one')
        .digest('hex')}-${createHash('sha256').update('owner-lane-1').digest('hex')}.md`
    )
    expect(markers[1].content).toContain('lockOwnerId: "owner-lane-1"')
    expect(markers[1].content).toContain('authorityInstanceId: "desktop/one"')
    expect(markers[1].content).toContain('runId: "run-1"')
    expect(markers[1].content).toContain('taskId: "chat-1"')
    expect(markers[1].content).toContain('chatId: "chat-1"')
    expect(markers[1].content).toContain('task: "Fix workspace accounting"')
    expect(markers[1].content).toContain('chatTitle: "Fix workspace accounting"')
    expect(markers[1].content).toContain('participantId: "writer-1"')
    expect(markers[1].content).toContain('laneId: "lane-1"')
    expect(markers[1].content).toContain('lifecycle: "run"')
  })

  it('projects workspace, tree, file, and hunk scope with hunk files duplicated into paths', () => {
    const markers = projectWorkspaceLockMarkers(
      [
        lease({
          leaseId: 'workspace',
          claim: {
            ...lease().claim,
            kind: 'workspace',
            relativeTargetPath: undefined,
            physicalTargetIdentity: '/repos/project-worktrees/feature'
          }
        }),
        lease({
          leaseId: 'tree',
          claim: { ...lease().claim, kind: 'tree', relativeTargetPath: 'src' }
        }),
        lease({
          leaseId: 'hunk',
          claim: {
            ...lease().claim,
            kind: 'hunk',
            relativeTargetPath: 'src/app.ts',
            hunk: { baseline: 'base-1', startLine: 7, endLine: 11 }
          }
        })
      ],
      options
    )

    expect(markers).toHaveLength(1)
    expect(markers[0].content).toContain('workspaceWide: true')
    expect(markers[0].content).toContain('trees:\n  - "src"')
    expect(markers[0].content).toContain('paths:\n  - "src/app.ts"')
    expect(markers[0].content).toContain(
      `treeDigests:\n  - "${createHash('sha256').update('src').digest('hex')}"`
    )
    expect(markers[0].content).toContain(
      `pathDigests:\n  - "${createHash('sha256').update('src/app.ts').digest('hex')}"`
    )
    expect(markers[0].content).toContain(
      'hunks:\n  - path: "src/app.ts"\n    baseline: "base-1"\n    startLine: 7\n    endLine: 11'
    )
  })

  it('uses JSON-safe YAML scalars and never writes raw process-birth identity', () => {
    const secret = 'private-birth-receipt\nwith a newline'
    const markers = projectWorkspaceLockMarkers(
      [
        lease({
          owner: {
            ...lease().owner,
            displayName: 'Build "owner"\nline',
            processBirthIdentity: secret
          },
          claim: { ...lease().claim, relativeTargetPath: 'src/quote"\nfile.ts' }
        })
      ],
      options
    )
    const content = markers[0].content

    expect(content).toContain('owner: "Build \\"owner\\"\\nline"')
    expect(content).toContain('  - "src/quote\\"\\nfile.ts"')
    expect(content).toContain(
      `birthReceiptHash: "${createHash('sha256').update(secret).digest('hex')}"`
    )
    expect(content).not.toContain(secret)
    expect(content).not.toContain('private-birth-receipt')
    expect(JSON.stringify(markers)).not.toContain(secret)
    expect(JSON.stringify(markers)).not.toContain('private-birth-receipt')
  })

  it('preserves newline, Unicode, and trailing-space path bytes in human paths and digests', () => {
    const tree = 'src/λ\nsubdir '
    const path = 'src/λ\nfile.ts '
    const marker = projectWorkspaceLockMarkers(
      [
        lease({
          leaseId: 'tree',
          claim: { ...lease().claim, kind: 'tree', relativeTargetPath: tree }
        }),
        lease({
          leaseId: 'file',
          claim: { ...lease().claim, kind: 'file', relativeTargetPath: path }
        })
      ],
      options
    )[0]

    expect(marker.content).toContain(`  - ${JSON.stringify(tree)}`)
    expect(marker.content).toContain(`  - ${JSON.stringify(path)}`)
    expect(marker.content).toContain(
      `  - "${createHash('sha256').update(Buffer.from(tree, 'utf8')).digest('hex')}"`
    )
    expect(marker.content).toContain(
      `  - "${createHash('sha256').update(Buffer.from(path, 'utf8')).digest('hex')}"`
    )
  })

  it('excludes recovered leases and keeps active orphan and recovery-blocked leases', () => {
    const markers = projectWorkspaceLockMarkers(
      [
        lease({ leaseId: 'recovered', status: 'recovered' }),
        lease({ leaseId: 'orphan', status: 'orphan_live' }),
        lease({ leaseId: 'blocked', status: 'recovery_blocked' })
      ],
      options
    )

    expect(markers).toHaveLength(1)
    expect(markers[0].leaseIds).toEqual(['blocked', 'orphan'])
    expect(markers[0].content).not.toContain('recovered')
    expect(markers[0].content).toContain('authorityBlocking: true')
    expect(markers[0].content).toContain('statuses:\n  - "orphan_live"\n  - "recovery_blocked"')
  })

  it('bounds readable filename prefixes while hashing exact instance and owner identities', () => {
    expect(sanitizeRuntimeMarkerInstanceId(' /desktop one/// ')).toBe('desktop-one')
    const aliased = workspaceLockRuntimeMarkerFilename('a/b', 'owner-1')
    const dashed = workspaceLockRuntimeMarkerFilename('a-b', 'owner-1')
    const otherOwner = workspaceLockRuntimeMarkerFilename('a/b', 'owner-2')
    const long = workspaceLockRuntimeMarkerFilename(`instance-${'x'.repeat(1_000)}`, 'owner-1')

    expect(aliased).not.toBe(dashed)
    expect(aliased).not.toBe(otherOwner)
    expect(aliased).toMatch(
      /^\.WORK-IN-PROGRESS-taskwraith-runtime-a-b-[a-f0-9]{64}-[a-f0-9]{64}\.md$/
    )
    expect(long.length).toBeLessThanOrEqual(255)
  })

  it('rejects noncanonical relative targets and a non-forward expiry', () => {
    const rootTree = projectWorkspaceLockMarkers(
      [
        lease({
          claim: {
            ...lease().claim,
            kind: 'tree',
            relativeTargetPath: '.',
            comparisonTargetPath: lease().claim.worktreeIdentity,
            physicalTargetIdentity: lease().claim.worktreeIdentity
          }
        })
      ],
      options
    )[0]
    expect(rootTree.content).toContain('trees:\n  - "."')
    expect(rootTree.content).toContain(
      `treeDigests:\n  - "${createHash('sha256').update('.').digest('hex')}"`
    )

    expect(() =>
      projectWorkspaceLockMarkers(
        [lease({ claim: { ...lease().claim, relativeTargetPath: '../escape.ts' } })],
        options
      )
    ).toThrow(/canonical relative path/i)
    expect(() =>
      projectWorkspaceLockMarkers(
        [lease({ claim: { ...lease().claim, relativeTargetPath: '.' } })],
        options
      )
    ).toThrow(/canonical relative path/i)
    expect(() =>
      projectWorkspaceLockMarkers([lease()], {
        projectedAt: options.projectedAt,
        expiresAt: options.projectedAt
      })
    ).toThrow(/later than projectedAt/i)
  })
})
