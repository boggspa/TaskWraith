import { describe, expect, it } from 'vitest'

import {
  TASKWRAITH_LOCK_OWNER_ENV_KEY,
  withExactWorkspaceLockOwnerEnv,
  WorkspaceLockExecutionIdentityRegistry
} from './WorkspaceLockExecutionIdentity'

describe('WorkspaceLockExecutionIdentityRegistry', () => {
  it('is stable within one logical lane and distinct across sibling lanes', () => {
    const ids = ['owner-a', 'owner-b']
    const registry = new WorkspaceLockExecutionIdentityRegistry({
      createId: () => ids.shift() || 'unexpected'
    })
    const laneA = { kind: 'logical-run' as const, runId: 'run-1', laneId: 'lane-a' }
    const laneB = { kind: 'logical-run' as const, runId: 'run-1', laneId: 'lane-b' }

    expect(registry.getOrCreate(laneA)).toBe('owner-a')
    expect(registry.getOrCreate(laneA)).toBe('owner-a')
    expect(registry.getOrCreate(laneB)).toBe('owner-b')
  })

  it('keeps a persistent provider seat separate from logical run identities', () => {
    const ids = ['seat-owner', 'run-owner']
    const registry = new WorkspaceLockExecutionIdentityRegistry({
      createId: () => ids.shift() || 'unexpected'
    })

    expect(
      registry.getOrCreate({
        kind: 'provider-seat',
        provider: 'grok',
        seatId: 'participant-1'
      })
    ).toBe('seat-owner')
    expect(
      registry.getOrCreate({
        kind: 'logical-run',
        runId: 'run-1',
        participantId: 'participant-1'
      })
    ).toBe('run-owner')
  })

  it('releases every lane identity for a terminal logical run', () => {
    let next = 0
    const registry = new WorkspaceLockExecutionIdentityRegistry({
      createId: () => `owner-${(next += 1)}`
    })
    const laneA = { kind: 'logical-run' as const, runId: 'run-1', laneId: 'lane-a' }
    const laneB = { kind: 'logical-run' as const, runId: 'run-1', laneId: 'lane-b' }
    const other = { kind: 'logical-run' as const, runId: 'run-2' }
    registry.getOrCreate(laneA)
    registry.getOrCreate(laneB)
    registry.getOrCreate(other)

    expect(registry.releaseLogicalRun('run-1')).toBe(2)
    expect(registry.get(laneA)).toBeNull()
    expect(registry.get(laneB)).toBeNull()
    expect(registry.get(other)).toBe('owner-3')
  })

  it('rejects duplicate generated identities instead of aliasing owners', () => {
    const ids = ['duplicate', 'duplicate', 'unique']
    const registry = new WorkspaceLockExecutionIdentityRegistry({
      createId: () => ids.shift() || 'unexpected'
    })

    expect(registry.getOrCreate({ kind: 'logical-run', runId: 'run-1' })).toBe('duplicate')
    expect(registry.getOrCreate({ kind: 'logical-run', runId: 'run-2' })).toBe('unique')
  })
})

describe('withExactWorkspaceLockOwnerEnv', () => {
  it('strips ambient authority unless exact admission supplies a replacement', () => {
    const inherited = {
      PATH: '/usr/bin',
      [TASKWRAITH_LOCK_OWNER_ENV_KEY]: 'ambient-owner',
      taskwraith_lock_owner_id: 'windows-case-alias',
      TaskWraith_Lock_Owner_Id: 'mixed-case-alias'
    }

    expect(withExactWorkspaceLockOwnerEnv(inherited, null)).toEqual({ PATH: '/usr/bin' })
    expect(withExactWorkspaceLockOwnerEnv(inherited, 'exact-owner')).toEqual({
      PATH: '/usr/bin',
      [TASKWRAITH_LOCK_OWNER_ENV_KEY]: 'exact-owner'
    })
    expect(inherited[TASKWRAITH_LOCK_OWNER_ENV_KEY]).toBe('ambient-owner')
    expect(inherited.taskwraith_lock_owner_id).toBe('windows-case-alias')
  })
})
