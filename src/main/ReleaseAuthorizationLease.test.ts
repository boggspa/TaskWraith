import { describe, expect, it } from 'vitest'
import {
  RELEASE_LEASE_DEFAULT_MINUTES,
  RELEASE_LEASE_MAX_MINUTES,
  ReleaseAuthorizationLeaseRegistry
} from './ReleaseAuthorizationLease'
import { releaseCommandBlockReason } from './ReleaseCommandPolicy'

function registryAt(startMs: number) {
  let nowMs = startMs
  let seq = 0
  const registry = new ReleaseAuthorizationLeaseRegistry({
    now: () => nowMs,
    idFactory: () => `lease-${++seq}`
  })
  return {
    registry,
    advanceMinutes: (minutes: number) => {
      nowMs += minutes * 60_000
    }
  }
}

const START = Date.parse('2026-08-18T12:00:00.000Z')

describe('ReleaseAuthorizationLeaseRegistry', () => {
  it('does not treat former release-class commands as classified', () => {
    const { registry } = registryAt(START)
    const command = 'git push --force origin refs/tags/v1.9.6'

    expect(releaseCommandBlockReason(command)).toBeNull()
    expect(
      registry.approvalFor({
        command,
        source: 'approvedMcpShell'
      })
    ).toBeNull()

    registry.grant({ minutes: 60, note: 'AFK release run' })
    expect(
      registry.approvalFor({
        command,
        source: 'approvedMcpShell'
      })
    ).toBeNull()
    expect(releaseCommandBlockReason(command)).toBeNull()
  })

  it('still answers a caller-named class after a grant', () => {
    const { registry } = registryAt(START)
    registry.grant({ minutes: 30 })
    for (const source of [
      'approvedMcpShell',
      'approvedMcpTask',
      'approvedBackgroundProcess',
      'approvedHostCommand'
    ] as const) {
      const approval = registry.approvalForClass('git push', { source })
      expect(approval?.approval.approvalSource).toBe(source)
      expect(approval?.approval.allowReleaseCommand).toBe(true)
    }
  })

  it('ignores ordinary commands so they never consume a lease', () => {
    const { registry } = registryAt(START)
    registry.grant({ minutes: 30 })
    expect(
      registry.approvalFor({ command: 'npm run build', source: 'approvedMcpShell' })
    ).toBeNull()
    expect(registry.approvalFor({ command: 'git status', source: 'approvedMcpShell' })).toBeNull()
  })

  it('honours a command-class scope and refuses classes outside it', () => {
    const { registry } = registryAt(START)
    registry.grant({ minutes: 30, commandClasses: ['git push'] })
    expect(registry.approvalForClass('git push', { source: 'approvedMcpShell' })).not.toBeNull()
    expect(registry.approvalForClass('npm publish', { source: 'approvedMcpShell' })).toBeNull()
    expect(registry.approvalForClass('gh release', { source: 'approvedMcpShell' })).toBeNull()
  })

  it('honours a workspace scope', () => {
    const { registry } = registryAt(START)
    registry.grant({ minutes: 30, workspacePath: '/Users/dev/AGBench' })
    expect(
      registry.approvalForClass('git push', {
        source: 'approvedMcpShell',
        workspacePath: '/Users/dev/AGBench'
      })
    ).not.toBeNull()
    expect(
      registry.approvalForClass('git push', {
        source: 'approvedMcpShell',
        workspacePath: '/Users/dev/other-repo'
      })
    ).toBeNull()
    expect(registry.approvalForClass('git push', { source: 'approvedMcpShell' })).toBeNull()
  })

  it('expires, and stops approving the moment it does', () => {
    const { registry, advanceMinutes } = registryAt(START)
    registry.grant({ minutes: 15 })
    advanceMinutes(14)
    expect(registry.approvalForClass('git push', { source: 'approvedMcpShell' })).not.toBeNull()
    advanceMinutes(2)
    expect(registry.approvalForClass('git push', { source: 'approvedMcpShell' })).toBeNull()
    expect(registry.active()).toHaveLength(0)
  })

  it('clamps the grant to the ceiling and defaults a missing duration', () => {
    const { registry } = registryAt(START)
    const clamped = registry.grant({ minutes: RELEASE_LEASE_MAX_MINUTES * 10 })
    expect(Date.parse(clamped.expiresAt) - START).toBe(RELEASE_LEASE_MAX_MINUTES * 60_000)

    const defaulted = registry.grant({})
    expect(Date.parse(defaulted.expiresAt) - START).toBe(RELEASE_LEASE_DEFAULT_MINUTES * 60_000)

    const negative = registry.grant({ minutes: -5 })
    expect(Date.parse(negative.expiresAt) - START).toBe(RELEASE_LEASE_DEFAULT_MINUTES * 60_000)
  })

  it('approves a caller-named class', () => {
    const { registry } = registryAt(START)
    registry.grant({ minutes: 30, commandClasses: ['package script release:mac'] })
    expect(
      registry.approvalForClass('package script release:mac', { source: 'approvedMcpTask' })
        ?.approval.approvalSource
    ).toBe('approvedMcpTask')
    expect(
      registry.approvalForClass('package script deploy:prod', { source: 'approvedMcpTask' })
    ).toBeNull()
    expect(registry.approvalForClass('', { source: 'approvedMcpTask' })).toBeNull()
  })

  it('lets an all-scope lease cover a class it could never have enumerated', () => {
    const { registry } = registryAt(START)
    registry.grant({ minutes: 30 })
    expect(
      registry.approvalForClass('package script notarize:mac', { source: 'approvedMcpTask' })
    ).not.toBeNull()
  })

  it('revokes a single lease by id and every lease without one', () => {
    const { registry } = registryAt(START)
    const first = registry.grant({ minutes: 30 })
    registry.grant({ minutes: 30 })
    expect(registry.revoke(first.id)).toBe(1)
    expect(registry.active()).toHaveLength(1)
    expect(registry.revoke()).toBe(1)
    expect(registry.approvalForClass('git push', { source: 'approvedMcpShell' })).toBeNull()
  })
})
