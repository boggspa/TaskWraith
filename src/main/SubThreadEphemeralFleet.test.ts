import { describe, expect, it } from 'vitest'
import {
  buildEphemeralFleetRoleFrame,
  findLiveEphemeralFleetWave,
  normalizeFleetLifecycle,
  selectHungEphemeralFleetWorkers,
  parseFleetWaveRole,
  resolveEphemeralFleetIsolation,
  resolveEphemeralFleetIsolationForWave,
  shouldArchiveEphemeralFleetAfterSettle,
  shouldArchiveEphemeralFleetChild,
  type EphemeralFleetWaveChildView
} from './SubThreadEphemeralFleet'

describe('SubThreadEphemeralFleet', () => {
  it('normalizes lifecycle with durable default', () => {
    expect(normalizeFleetLifecycle('ephemeral')).toBe('ephemeral')
    expect(normalizeFleetLifecycle('durable')).toBe('durable')
    expect(normalizeFleetLifecycle(undefined)).toBe('durable')
    expect(normalizeFleetLifecycle('other')).toBe('durable')
  })

  it('parses fleet roles and rejects Ensemble background / unknown', () => {
    expect(parseFleetWaveRole('scout')).toBe('scout')
    expect(parseFleetWaveRole('worker')).toBe('worker')
    expect(parseFleetWaveRole('reviewer')).toBe('reviewer')
    expect(parseFleetWaveRole('background')).toBeUndefined()
    expect(parseFleetWaveRole('Boss')).toBeUndefined()
  })

  it('maps scout/reviewer→read_only and worker→capped_inherit', () => {
    expect(resolveEphemeralFleetIsolation('scout')).toEqual({ kind: 'read_only' })
    expect(resolveEphemeralFleetIsolation('reviewer')).toEqual({ kind: 'read_only' })
    expect(resolveEphemeralFleetIsolation(undefined)).toEqual({ kind: 'read_only' })
    expect(resolveEphemeralFleetIsolation('worker')).toEqual({ kind: 'capped_inherit' })
  })

  it('wave-aware: sole worker keeps capped_inherit; parallel workers fail closed to read_only', () => {
    expect(
      resolveEphemeralFleetIsolationForWave({
        role: 'worker',
        workerRoles: ['worker']
      })
    ).toEqual({ kind: 'capped_inherit' })
    expect(
      resolveEphemeralFleetIsolationForWave({
        role: 'worker',
        workerRoles: ['scout', 'worker', 'reviewer']
      })
    ).toEqual({ kind: 'capped_inherit' })
    // Two+ role=worker seats share the parent checkout — never capped_inherit.
    expect(
      resolveEphemeralFleetIsolationForWave({
        role: 'worker',
        workerRoles: ['worker', 'worker']
      })
    ).toEqual({ kind: 'read_only' })
    expect(
      resolveEphemeralFleetIsolationForWave({
        role: 'worker',
        workerRoles: ['scout', 'worker', 'worker', 'reviewer']
      })
    ).toEqual({ kind: 'read_only' })
    expect(
      resolveEphemeralFleetIsolationForWave({
        role: 'scout',
        workerRoles: ['worker', 'worker', 'scout']
      })
    ).toEqual({ kind: 'read_only' })
    expect(
      resolveEphemeralFleetIsolationForWave({
        role: undefined,
        workerRoles: ['worker']
      })
    ).toEqual({ kind: 'read_only' })
  })

  it('wave-aware: sole worker with distinct worktree paths → worktree isolation', () => {
    expect(
      resolveEphemeralFleetIsolationForWave({
        role: 'worker',
        workerRoles: ['worker'],
        worktree: {
          baseWorkspacePath: '/repo',
          effectiveWorkspacePath: '/repo-worktrees/fleet-worker-abc'
        }
      })
    ).toEqual({
      kind: 'worktree',
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: '/repo-worktrees/fleet-worker-abc'
    })
    // Scout/reviewer stay read_only even when a worktree payload is present.
    expect(
      resolveEphemeralFleetIsolationForWave({
        role: 'scout',
        workerRoles: ['scout', 'worker'],
        worktree: {
          baseWorkspacePath: '/repo',
          effectiveWorkspacePath: '/repo-worktrees/fleet-worker-abc'
        }
      })
    ).toEqual({ kind: 'read_only' })
    // Parallel workers never get worktree (or capped_inherit) via this helper.
    expect(
      resolveEphemeralFleetIsolationForWave({
        role: 'worker',
        workerRoles: ['worker', 'worker'],
        worktree: {
          baseWorkspacePath: '/repo',
          effectiveWorkspacePath: '/repo-worktrees/fleet-worker-abc'
        }
      })
    ).toEqual({ kind: 'read_only' })
  })

  it('wave-aware: sole worker rejects non-distinct or blank worktree paths → capped_inherit', () => {
    expect(
      resolveEphemeralFleetIsolationForWave({
        role: 'worker',
        workerRoles: ['worker'],
        worktree: {
          baseWorkspacePath: '/repo',
          effectiveWorkspacePath: '/repo'
        }
      })
    ).toEqual({ kind: 'capped_inherit' })
    expect(
      resolveEphemeralFleetIsolationForWave({
        role: 'worker',
        workerRoles: ['worker'],
        worktree: {
          baseWorkspacePath: '/repo/',
          effectiveWorkspacePath: '/repo'
        }
      })
    ).toEqual({ kind: 'capped_inherit' })
    expect(
      resolveEphemeralFleetIsolationForWave({
        role: 'worker',
        workerRoles: ['worker'],
        worktree: {
          baseWorkspacePath: '/repo',
          effectiveWorkspacePath: '   '
        }
      })
    ).toEqual({ kind: 'capped_inherit' })
    expect(
      resolveEphemeralFleetIsolationForWave({
        role: 'worker',
        workerRoles: ['scout', 'worker'],
        worktree: undefined
      })
    ).toEqual({ kind: 'capped_inherit' })
  })

  it('builds short role frames', () => {
    expect(buildEphemeralFleetRoleFrame('scout', 'repro')).toMatch(/scout \(repro\)/)
    expect(buildEphemeralFleetRoleFrame('scout', 'repro').split('.').length).toBeLessThanOrEqual(3)
    expect(buildEphemeralFleetRoleFrame('worker')).toMatch(/worker/)
  })

  it('archives only ephemeral sub-thread children', () => {
    expect(
      shouldArchiveEphemeralFleetChild({
        parentChatId: 'p',
        parentChatRelation: 'subThread',
        delegationContext: {
          createdAt: 1,
          parentProvider: 'codex',
          delegationPrompt: 'x',
          returnResultToParent: true,
          lifecycle: 'ephemeral'
        }
      })
    ).toBe(true)
    expect(
      shouldArchiveEphemeralFleetChild({
        parentChatId: 'p',
        parentChatRelation: 'subThread',
        delegationContext: {
          createdAt: 1,
          parentProvider: 'codex',
          delegationPrompt: 'x',
          returnResultToParent: true,
          lifecycle: 'durable'
        }
      })
    ).toBe(false)
    expect(
      shouldArchiveEphemeralFleetChild({
        parentChatId: 'p',
        parentChatRelation: 'subThread',
        delegationContext: {
          createdAt: 1,
          parentProvider: 'codex',
          delegationPrompt: 'x',
          returnResultToParent: true
        }
      })
    ).toBe(false)
  })

  it('archives after settle only when settle succeeded or was unnecessary', () => {
    expect(shouldArchiveEphemeralFleetAfterSettle(null)).toBe(true)
    expect(shouldArchiveEphemeralFleetAfterSettle({ ok: true })).toBe(true)
    expect(shouldArchiveEphemeralFleetAfterSettle({ ok: false })).toBe(false)
  })

  describe('findLiveEphemeralFleetWave', () => {
    const nowMs = Date.parse('2026-08-12T00:00:00Z')
    const future = '2026-08-12T00:05:00Z'
    const past = '2026-08-11T23:55:00Z'

    const child = (
      overrides: Partial<{
        archived: boolean
        lifecycle: 'ephemeral' | 'durable'
        groupId: string | undefined
        deadlineAt: string | undefined
        resultReturnedAt: number
        dispatchError: { at: number; message: string }
      }> = {}
    ): EphemeralFleetWaveChildView => ({
      ...(overrides.archived !== undefined ? { archived: overrides.archived } : {}),
      delegationContext: {
        lifecycle: overrides.lifecycle ?? 'ephemeral',
        ...(overrides.resultReturnedAt !== undefined
          ? { resultReturnedAt: overrides.resultReturnedAt }
          : {}),
        ...(overrides.dispatchError !== undefined
          ? { dispatchError: overrides.dispatchError }
          : {}),
        ...('groupId' in overrides || 'deadlineAt' in overrides
          ? {
              joinPolicy: {
                ...(overrides.groupId !== undefined ? { groupId: overrides.groupId } : {}),
                ...(overrides.deadlineAt !== undefined
                  ? { deadlineAt: overrides.deadlineAt }
                  : {})
              }
            }
          : { joinPolicy: { groupId: 'wave-p-1', deadlineAt: future } })
      }
    })

    it('returns null for no children, durable-only children, or group-less children', () => {
      expect(findLiveEphemeralFleetWave({ children: [], nowMs })).toBeNull()
      expect(
        findLiveEphemeralFleetWave({
          children: [child({ lifecycle: 'durable', groupId: 'wave-p-1', deadlineAt: future })],
          nowMs
        })
      ).toBeNull()
      expect(
        findLiveEphemeralFleetWave({
          children: [child({ groupId: undefined, deadlineAt: future })],
          nowMs
        })
      ).toBeNull()
    })

    it('reports a live wave with settled/total counts while a deadline is ahead', () => {
      const live = findLiveEphemeralFleetWave({
        children: [
          child({ resultReturnedAt: nowMs - 1_000 }),
          child({ archived: true }),
          child({})
        ],
        nowMs
      })
      expect(live).toEqual({ waveId: 'wave-p-1', total: 3, settled: 2 })
    })

    it('counts returned-but-unarchived and dispatch-failed children as settled', () => {
      // resultReturnedAt without archived = worktree settle failure — settled.
      // dispatchError = the child will never return — settled, or the wave
      // would hold the parent shut forever.
      expect(
        findLiveEphemeralFleetWave({
          children: [
            child({ resultReturnedAt: nowMs - 1 }),
            child({ dispatchError: { at: nowMs - 1, message: 'boom' } })
          ],
          nowMs
        })
      ).toBeNull()
    })

    it('treats past, missing, or unparseable deadlines as expired (fail open)', () => {
      expect(
        findLiveEphemeralFleetWave({ children: [child({ deadlineAt: past })], nowMs })
      ).toBeNull()
      expect(
        findLiveEphemeralFleetWave({
          children: [child({ groupId: 'wave-p-1', deadlineAt: undefined })],
          nowMs
        })
      ).toBeNull()
      expect(
        findLiveEphemeralFleetWave({
          children: [child({ deadlineAt: 'not-a-date' })],
          nowMs
        })
      ).toBeNull()
    })

    it('selects only non-terminal, unsettled EPHEMERAL workers for deadline fail', () => {
      const hung = selectHungEphemeralFleetWorkers([
        { subThreadId: 'a', terminal: { at: 'x', outcome: 'done' }, child: child({}) },
        { subThreadId: 'b', child: child({ lifecycle: 'durable' }) },
        { subThreadId: 'c', child: child({ resultReturnedAt: nowMs - 1 }) },
        { subThreadId: 'd', child: child({}) },
        { subThreadId: 'd', child: child({}) },
        { subThreadId: 'e', child: null }
      ])
      expect(hung).toEqual(['d'])
    })

    it('skips fully settled waves and returns the still-live one', () => {
      const live = findLiveEphemeralFleetWave({
        children: [
          child({ groupId: 'wave-p-old', deadlineAt: future, resultReturnedAt: nowMs - 5_000 }),
          child({ groupId: 'wave-p-old', deadlineAt: future, archived: true }),
          child({ groupId: 'wave-p-new', deadlineAt: future })
        ],
        nowMs
      })
      expect(live).toEqual({ waveId: 'wave-p-new', total: 1, settled: 0 })
    })
  })
})
