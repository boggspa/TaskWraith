import { describe, expect, it } from 'vitest'
import {
  buildEphemeralFleetRoleFrame,
  normalizeFleetLifecycle,
  parseFleetWaveRole,
  resolveEphemeralFleetIsolation,
  resolveEphemeralFleetIsolationForWave,
  shouldArchiveEphemeralFleetChild
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
})
