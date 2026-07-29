import { describe, expect, it } from 'vitest'
import {
  createWorkLockProjectionSnapshot,
  type WorkLockProjectionSource
} from '../../../shared/workLockProjection'
import {
  buildWorkLockDisplayRows,
  countActiveWorkLocks,
  formatWorkLockAge,
  formatWorkLockTarget,
  workLockStatusPresentation
} from './workLockProjection'

function lock(overrides: Partial<WorkLockProjectionSource> = {}): WorkLockProjectionSource {
  return {
    lockId: 'lock-1',
    status: 'held',
    owner: {
      displayName: 'Builder',
      provider: 'codex',
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
      startLine: 17,
      endLine: 29
    },
    acquiredAt: '2026-07-29T15:00:00.000Z',
    statusChangedAt: '2026-07-29T15:00:00.000Z',
    ...overrides
  }
}

describe('renderer work lock projection', () => {
  it('uses calm, distinct copy for active and recovery states', () => {
    expect(workLockStatusPresentation('held').label).toBe('Active edit')
    expect(workLockStatusPresentation('orphan_live').label).toBe('Owner still active')
    expect(workLockStatusPresentation('recovery_blocked')).toMatchObject({
      label: 'Recovery paused',
      tone: 'attention'
    })
    expect(workLockStatusPresentation('recovered')).toMatchObject({
      label: 'Recovered safely',
      tone: 'recovered'
    })
  })

  it('formats file and hunk targets plus stable ages', () => {
    const projected = createWorkLockProjectionSnapshot({
      generation: 1,
      sampledAt: '2026-07-29T15:05:00.000Z',
      locks: [lock()]
    }).locks[0]

    expect(formatWorkLockTarget(projected)).toBe('src/app.ts · lines 18–29')
    expect(formatWorkLockAge(projected.acquiredAt, Date.parse('2026-07-29T16:03:00.000Z'))).toBe(
      '1h 3m'
    )
  })

  it('formats tree locks and zero-width hunk insertions', () => {
    const snapshot = createWorkLockProjectionSnapshot({
      generation: 1,
      sampledAt: '2026-07-29T15:05:00.000Z',
      locks: [
        lock({ lockId: 'tree', target: { kind: 'tree', path: 'src/features/' } }),
        lock({
          lockId: 'insert',
          target: { kind: 'hunk', path: 'src/app.ts', startLine: 7, endLine: 7 }
        })
      ]
    })

    expect(formatWorkLockTarget(snapshot.locks[0])).toBe('src/app.ts · insert at line 8')
    expect(formatWorkLockTarget(snapshot.locks[1])).toBe('src/features/**')
  })

  it('prioritizes active locks and the current effective worktree', () => {
    const snapshot = createWorkLockProjectionSnapshot({
      generation: 3,
      sampledAt: '2026-07-29T15:05:00.000Z',
      locks: [
        lock({ lockId: 'recovered', status: 'recovered' }),
        lock({
          lockId: 'base',
          workspace: { basePath: '/repo', effectivePath: '/repo', isWorktree: false }
        }),
        lock({ lockId: 'current' })
      ]
    })
    const rows = buildWorkLockDisplayRows({
      snapshot,
      effectiveWorkspacePath: '/worktrees/builder',
      nowMs: Date.parse('2026-07-29T15:10:00.000Z')
    })

    expect(rows.map((row) => row.lock.lockId)).toEqual(['current', 'base', 'recovered'])
    expect(rows[0]).toMatchObject({
      workspaceLabel: 'builder',
      baseWorkspaceLabel: 'repo',
      isCurrentCheckout: true,
      ageLabel: '10m'
    })
    expect(countActiveWorkLocks(snapshot)).toBe(2)
  })

  it('does not mark a trailing-space checkout as the current ordinary checkout', () => {
    const snapshot = createWorkLockProjectionSnapshot({
      generation: 4,
      sampledAt: '2026-07-29T15:05:00.000Z',
      locks: [
        lock({
          workspace: {
            basePath: '/repo ',
            effectivePath: '/repo ',
            isWorktree: false
          }
        })
      ]
    })

    expect(
      buildWorkLockDisplayRows({
        snapshot,
        effectiveWorkspacePath: '/repo',
        nowMs: Date.parse('2026-07-29T15:10:00.000Z')
      })[0].isCurrentCheckout
    ).toBe(false)
  })
})
