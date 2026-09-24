import { describe, expect, it } from 'vitest'
import {
  createWorkLockProjectionSnapshot,
  projectWorkLock,
  scopeWorkLockProjectionSnapshot,
  workLockProjectionIsActive,
  workLockProjectionQueryKey,
  workLockProjectionUpdateIsStale,
  type WorkLockProjectionSource
} from './workLockProjection'

function source(overrides: Partial<WorkLockProjectionSource> = {}): WorkLockProjectionSource {
  return {
    lockId: 'lock-1',
    status: 'held',
    owner: {
      displayName: 'Builder',
      provider: 'codex',
      chatId: 'chat-1',
      chatTitle: 'Ship 1.9.2',
      laneId: 'lane-1',
      ownerPid: 4102,
      processBirthIdentity: 'secret-birth-receipt'
    },
    workspace: {
      basePath: '/repo',
      effectivePath: '/worktrees/builder',
      isWorktree: true,
      worktreeName: 'builder',
      branch: 'codex/lock-ui',
      internalJournalPath: '/private/lock-journal'
    },
    target: {
      kind: 'hunk',
      path: 'src/app.ts',
      startLine: 17,
      endLine: 29,
      baseline: 'abc123',
      internalAnchor: 'secret-anchor'
    },
    acquiredAt: '2026-07-29T15:00:00.000Z',
    statusChangedAt: '2026-07-29T15:00:00.000Z',
    ownerPid: 4102,
    processBirthIdentity: 'secret-birth-receipt',
    ...overrides
  }
}

describe('workLockProjection', () => {
  it('produces schema version 2 and copies only the declared holder fields', () => {
    const projected = projectWorkLock(
      source({
        holder: {
          instanceScope: 'other',
          liveness: 'lapsed',
          heartbeatAgeMs: 123_456.7,
          generation: 41,
          ownerPid: 4102,
          processBirthIdentity: 'secret-birth-receipt',
          heartbeatPath: '/private/holders/x.json'
        } as WorkLockProjectionSource['holder']
      })
    )

    expect(projected.schemaVersion).toBe(2)
    expect(projected.holder).toEqual({
      instanceScope: 'other',
      liveness: 'lapsed',
      heartbeatAgeMs: 123_457,
      generation: 41
    })
    expect(JSON.stringify(projected.holder)).not.toContain('4102')
    expect(JSON.stringify(projected.holder)).not.toContain('birth-receipt')
    expect(JSON.stringify(projected.holder)).not.toContain('heartbeatPath')
    expect(projectWorkLock(source()).holder).toBeUndefined()
    expect(
      createWorkLockProjectionSnapshot({
        generation: 1,
        sampledAt: '2026-09-23T10:00:00.000Z',
        locks: [source()]
      }).schemaVersion
    ).toBe(2)
  })

  it('never invents a liveness it does not know and clamps a malformed holder block', () => {
    const projected = projectWorkLock(
      source({
        holder: {
          instanceScope: 'elsewhere',
          liveness: 'thriving',
          heartbeatAgeMs: -5,
          generation: 1.5
        } as unknown as WorkLockProjectionSource['holder']
      })
    )
    expect(projected.holder).toEqual({
      instanceScope: 'other',
      liveness: 'unknown',
      heartbeatAgeMs: 0,
      generation: 0
    })
  })

  it('still accepts a v1 public lock as input without re-converting its coordinates', () => {
    const v1 = {
      ...projectWorkLock(source()),
      schemaVersion: 1 as const
    }
    expect(v1.target).toMatchObject({ kind: 'hunk', startLine: 18, endLine: 29 })
    const reprojected = projectWorkLock(v1)
    expect(reprojected.target).toEqual(v1.target)
    expect(reprojected.schemaVersion).toBe(2)
    expect(reprojected.holder).toBeUndefined()
  })

  it('copies the complete UI identity while dropping process recovery identity', () => {
    const projected = projectWorkLock(source())

    expect(projected).toMatchObject({
      status: 'held',
      owner: {
        displayName: 'Builder',
        provider: 'codex',
        chatId: 'chat-1',
        chatTitle: 'Ship 1.9.2',
        laneId: 'lane-1'
      },
      workspace: {
        basePath: '/repo',
        effectivePath: '/worktrees/builder',
        isWorktree: true,
        worktreeName: 'builder'
      },
      target: {
        kind: 'hunk',
        path: 'src/app.ts',
        startLine: 18,
        endLine: 29
      }
    })
    expect(JSON.stringify(projected)).not.toContain('4102')
    expect(JSON.stringify(projected)).not.toContain('birth-receipt')
    expect(JSON.stringify(projected)).not.toContain('internalJournalPath')
    expect(JSON.stringify(projected)).not.toContain('internalAnchor')
  })

  it('sorts snapshots deterministically and preserves all recovery statuses', () => {
    const snapshot = createWorkLockProjectionSnapshot({
      generation: 7,
      sampledAt: '2026-07-29T15:05:00.000Z',
      locks: [
        source({
          lockId: 'lock-z',
          status: 'recovered',
          acquiredAt: '2026-07-29T15:02:00.000Z',
          recoveredAt: '2026-07-29T15:04:00.000Z'
        }),
        source({ lockId: 'lock-a', status: 'orphan_live' }),
        source({ lockId: 'lock-b', status: 'recovery_blocked' })
      ]
    })

    expect(snapshot.generation).toBe(7)
    expect(snapshot.locks.map((lock) => lock.lockId)).toEqual(['lock-a', 'lock-b', 'lock-z'])
    expect(snapshot.locks.map((lock) => lock.status)).toEqual([
      'orphan_live',
      'recovery_blocked',
      'recovered'
    ])
    expect(workLockProjectionIsActive('held')).toBe(true)
    expect(workLockProjectionIsActive('orphan_live')).toBe(true)
    expect(workLockProjectionIsActive('recovery_blocked')).toBe(true)
    expect(workLockProjectionIsActive('recovered')).toBe(false)
  })

  it('projects tree claims and converts core hunk coordinates for display', () => {
    const tree = projectWorkLock(
      source({
        target: {
          kind: 'tree',
          path: 'src/features'
        }
      })
    )
    const insertion = projectWorkLock(
      source({
        target: {
          kind: 'hunk',
          path: 'src/app.ts',
          startLine: 7,
          endLine: 7,
          baseline: 'revision-a'
        }
      })
    )

    expect(tree.target).toEqual({ kind: 'tree', path: 'src/features' })
    expect(insertion.target).toEqual({
      kind: 'hunk',
      path: 'src/app.ts',
      startLine: 8,
      endLine: 8,
      baseRevision: 'revision-a',
      isInsertion: true
    })
  })

  it('scopes a base checkout to its related worktrees without including other workspaces', () => {
    const snapshot = createWorkLockProjectionSnapshot({
      generation: 2,
      sampledAt: '2026-07-29T15:05:00.000Z',
      locks: [
        source({
          lockId: 'base',
          workspace: { basePath: '/repo', effectivePath: '/repo', isWorktree: false }
        }),
        source({ lockId: 'linked' }),
        source({
          lockId: 'other',
          workspace: { basePath: '/other', effectivePath: '/other', isWorktree: false }
        })
      ]
    })

    expect(
      scopeWorkLockProjectionSnapshot(snapshot, { workspacePath: '/repo/' }).locks
    ).toHaveLength(2)
    expect(
      scopeWorkLockProjectionSnapshot(snapshot, { workspacePath: '/worktrees/builder' }).locks.map(
        (lock) => lock.lockId
      )
    ).toEqual(['linked'])
  })

  it('uses chat id as authority provenance in query identity', () => {
    expect(workLockProjectionQueryKey({ workspacePath: '/repo/', chatId: 'chat-1' })).toBe(
      '/repo\u0000chat-1'
    )
    expect(workLockProjectionQueryKey({ workspacePath: '/repo', chatId: 'chat-2' })).not.toBe(
      workLockProjectionQueryKey({ workspacePath: '/repo', chatId: 'chat-1' })
    )
  })

  it('never aliases a valid trailing-space workspace to a different checkout', () => {
    const snapshot = createWorkLockProjectionSnapshot({
      generation: 3,
      sampledAt: '2026-07-29T15:05:00.000Z',
      locks: [
        source({
          lockId: 'ordinary',
          workspace: { basePath: '/repo', effectivePath: '/repo', isWorktree: false }
        }),
        source({
          lockId: 'trailing-space',
          workspace: { basePath: '/repo ', effectivePath: '/repo ', isWorktree: false }
        })
      ]
    })

    expect(
      scopeWorkLockProjectionSnapshot(snapshot, { workspacePath: '/repo' }).locks.map(
        (lock) => lock.lockId
      )
    ).toEqual(['ordinary'])
    expect(
      scopeWorkLockProjectionSnapshot(snapshot, { workspacePath: '/repo /' }).locks.map(
        (lock) => lock.lockId
      )
    ).toEqual(['trailing-space'])
    expect(workLockProjectionQueryKey({ workspacePath: '/repo ' })).not.toBe(
      workLockProjectionQueryKey({ workspacePath: '/repo' })
    )
  })

  it('delivers same-generation contention notices while rejecting older snapshots', () => {
    expect(workLockProjectionUpdateIsStale(7, 7)).toBe(false)
    expect(workLockProjectionUpdateIsStale(7, 8)).toBe(false)
    expect(workLockProjectionUpdateIsStale(7, 6)).toBe(true)
  })
})
